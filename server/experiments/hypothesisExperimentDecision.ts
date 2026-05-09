/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2c: HYPOTHESIS EXPERIMENT DECISION RULES
 *
 * Phase 2 produced `HypothesisExperimentCandidate` (a hypothesis the hygiene
 * gate cleared) and Phase 2b produced `MetricBinding` (the candidate's metric
 * matched a registered key with a known data source). Phase 2c turns those
 * artifacts plus an *aggregate outcome* (baseline + treatment counts and mean
 * outcome metrics, optional cost figures, optional guardrail signals) into a
 * deterministic, propose-only **decision** about what should happen next:
 *
 *     "Given the evidence so far, should this experiment be promoted, rejected,
 *      continued, or sent to a human reviewer?"
 *
 * The output is `ExperimentDecision`. The four verdicts are:
 *
 *   - `promote`       — primary metric clearly improved, no guardrail failure,
 *                       cost is acceptable, and the sample size threshold is
 *                       met. The recommendation is "this candidate may be
 *                       promoted by an operator." Phase 2c does NOT promote;
 *                       writing `promotion_events` is Phase 2d work.
 *   - `reject`        — the evidence rules out the candidate: primary metric
 *                       clearly worse, or a hard guardrail failure, or cost
 *                       went up with no quality improvement.
 *   - `continue`      — sample is below the minimum threshold, or the result
 *                       is inconclusive but the evidence is valid (no missing
 *                       fields, no guardrail problem). Keep running.
 *   - `needs_review`  — evidence is ambiguous or partially missing in a way
 *                       a deterministic rule cannot resolve. A human must
 *                       look at it. This is the safe-default verdict.
 *
 * This module is intentionally:
 *   - PURE: no I/O, no DB writes, no LLM calls, no time. Inputs are typed
 *     records the caller has already loaded; outputs are typed verdicts. The
 *     `now` argument is injectable so tests are deterministic.
 *   - PROPOSE-ONLY: nothing here mutates the hypothesis record, the experiment
 *     row, or any aggregate. No `promotion_events` or `retraction_events` are
 *     written. This mirrors the propose-only invariant in the Phase 2 / 2b
 *     modules and `selfRecommendationEngine.ts`.
 *   - DEFENSE-IN-DEPTH: the function signature accepts only an
 *     `ExperimentDecisionInput` whose `binding` field is a successful
 *     `MetricBinding`. A `MetricBindingRefusal` cannot reach this module
 *     because TypeScript narrows `MetricBinding | MetricBindingRefusal` on
 *     `ok: true`. Memory-origin records cannot be a binding by construction,
 *     so they cannot be a decision input either.
 *   - DETERMINISTIC: every rule is a threshold comparison on the inputs. No
 *     statistical complexity (no SPRT/Bayes/CUPED) — Phase 2c starts with
 *     simple, auditable thresholds that an operator can defend on a code
 *     review. Phase 2d may grow this into a proper sequential test once we
 *     have enough trials to calibrate one.
 *
 * Phase 2c rule set (in evaluation order — first match wins):
 *   1. binding refusal           → caller cannot pass one (type-enforced).
 *   2. missing aggregate fields  → `needs_review` (we will not invent data).
 *   3. invalid aggregate         → `needs_review` (e.g. negative counts,
 *                                  non-finite means, treatment.count=0 with
 *                                  baseline.count>0 mid-flight).
 *   4. hard guardrail failure    → `reject` if fatal, else `needs_review`.
 *      ("fatal" is operator-set per guardrail; default is fatal.)
 *   5. sample below minimum      → `continue` (we need more trials).
 *   6. cost up without quality   → `reject` (a degenerate outcome we always
 *                                  refuse, even pre-threshold).
 *   7. primary metric clearly worse        → `reject`.
 *   8. primary metric clearly better       → `promote`.
 *   9. otherwise (valid but inconclusive)  → `continue`.
 *
 * Out of scope for Phase 2c (deferred to Phase 2d):
 *   - Persisting `promotion_events` / `retraction_events`.
 *   - Live scheduler automation that calls `registerExperiment` /
 *     `recordTrialOutcome` / a promotion helper from a Phase 2c decision.
 *   - Statistical sequential tests (SPRT, Bayesian posterior, CUPED-style
 *     variance reduction). Phase 2c is a threshold layer — it does not claim
 *     statistical rigor, and the documentation must say so.
 *   - Dashboard surfaces over the decision report.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { MetricBinding } from "./hypothesisMetricBinding.js";

// ── Verdict + reason taxonomy ────────────────────────────────────────────────

export type ExperimentDecisionVerdict =
  | "promote"
  | "reject"
  | "continue"
  | "needs_review";

/**
 * Stable enum-like reason codes. Callers branch on these; the human-readable
 * `reason` string is for evidence/audit only. New codes are additive.
 */
export type ExperimentDecisionReasonCode =
  // needs_review
  | "missing_aggregate"
  | "invalid_aggregate"
  | "ambiguous_guardrail"
  // continue
  | "insufficient_sample"
  | "inconclusive"
  // reject
  | "guardrail_failure"
  | "primary_metric_worse"
  | "cost_up_without_improvement"
  // promote
  | "primary_metric_better";

// ── Input shape ──────────────────────────────────────────────────────────────

/**
 * Per-arm aggregate. A subset of `ValiditySummary`-style fields, narrowed to
 * what a decision rule needs:
 *
 *   - `count`  — number of graded trials in this arm (probes excluded by the
 *                caller; this module does not re-filter).
 *   - `metric` — mean of the primary outcome metric across this arm. For
 *                `routine_task_json_validity` that is the mean of 1.0/0.0 per
 *                trial, i.e. the json-parse rate. Other metrics may use a
 *                different scale; thresholds compare arm-to-arm so the scale
 *                cancels out.
 *
 * `count` may be 0 (e.g. early in a run before any treatment trials land).
 * `metric` is allowed to be 0 when `count` is ≥ 1; we treat NaN/Infinity as
 * an invalid aggregate.
 */
export interface ArmAggregate {
  count: number;
  /** Mean primary outcome metric across the arm. Same scale as Phase 2b's
   *  registered metric. */
  metric: number;
}

/**
 * Optional per-arm cost summary. When present on both arms, the cost-up-
 * without-improvement rule applies. When absent, the rule is skipped — we
 * never invent cost data.
 */
export interface ArmCost {
  /** Mean (or total — caller's choice, but be consistent across arms)
   *  cost in USD per trial. Negative values are treated as invalid. */
  costUsd: number;
}

/**
 * One operator-defined guardrail check on the experiment. The decision module
 * does not compute guardrails — the caller has already evaluated them and
 * passes the outcome here. `fatal` defaults to true: a failed guardrail is
 * treated as a hard reject unless the operator marks it advisory.
 */
export interface GuardrailOutcome {
  /** Stable identifier for the guardrail. Surfaced in evidence so an audit
   *  reader can locate the source. */
  name: string;
  /** True when the guardrail PASSED. False when it failed. */
  passed: boolean;
  /** When false and `fatal !== false`, the decision is `reject`. When false
   *  and `fatal === false`, the decision is `needs_review` (we never let an
   *  advisory guardrail silently pass through to `promote`). */
  fatal?: boolean;
  /** Optional human-readable detail surfaced in evidence. */
  detail?: string;
}

/**
 * Threshold knobs. These are the operator-tunable constants. Defaults are
 * deliberately conservative — we want Phase 2c to recommend `continue` or
 * `needs_review` more often than `promote` or `reject` until Phase 2d adds
 * statistical rigor.
 */
export interface ExperimentDecisionThresholds {
  /** Minimum total graded trials (baseline + treatment) before a decision
   *  other than `continue` may fire. Default 30. */
  minTotalSamples?: number;
  /** Minimum per-arm count before promote/reject can fire. Default 15. */
  minPerArmSamples?: number;
  /** Absolute improvement on the primary metric (treatment - baseline) at
   *  which we *promote*. Default 0.05 — i.e. 5pp on a [0,1] metric. */
  promoteAbsoluteDelta?: number;
  /** Absolute regression on the primary metric (baseline - treatment) at
   *  which we *reject*. Default 0.05 — i.e. 5pp on a [0,1] metric. */
  rejectAbsoluteDelta?: number;
  /** Minimum absolute metric improvement required to consider a cost
   *  increase "with improvement". Default 0.005 — a 0.5pp improvement is
   *  the floor below which we treat the run as flat for cost purposes. */
  minMetricImprovementForCost?: number;
  /** Maximum acceptable cost increase ratio (treatment / baseline - 1) when
   *  there is no metric improvement. Default 0.10 — 10% cost up without a
   *  measurable quality lift triggers reject. */
  maxFlatCostRatio?: number;
}

const DEFAULT_THRESHOLDS: Required<ExperimentDecisionThresholds> = {
  minTotalSamples:             30,
  minPerArmSamples:            15,
  promoteAbsoluteDelta:        0.05,
  rejectAbsoluteDelta:         0.05,
  minMetricImprovementForCost: 0.005,
  maxFlatCostRatio:            0.10,
};

/**
 * The canonical Phase 2c input. The shape is intentionally narrow: a binding
 * (already successful), per-arm aggregates, and optional cost / guardrail
 * inputs. Callers compose this from `validityAggregates.getValiditySummary()`
 * (or whatever read path they prefer) before calling
 * `decideExperimentOutcome` — the decision module does no I/O.
 *
 * We accept *only* a successful `MetricBinding`. A `MetricBindingRefusal`
 * cannot reach this module by construction; if a caller wants to surface
 * a refusal, they should propagate the Phase 2b output directly.
 */
export interface ExperimentDecisionInput {
  binding: MetricBinding;
  /** Trials for the control arm. */
  baseline: ArmAggregate;
  /** Trials for the treatment arm (the candidate-under-test). */
  treatment: ArmAggregate;
  /** Optional cost figures, keyed by arm. When either side is missing the
   *  cost rule is skipped. */
  baselineCost?: ArmCost;
  treatmentCost?: ArmCost;
  /** Operator-evaluated guardrails, in evaluation order. The first failed
   *  fatal guardrail wins. */
  guardrails?: readonly GuardrailOutcome[];
  /** Threshold overrides. Missing fields fall back to `DEFAULT_THRESHOLDS`. */
  thresholds?: ExperimentDecisionThresholds;
}

// ── Output shape ─────────────────────────────────────────────────────────────

export interface ExperimentDecision {
  hypothesisId: string;
  metricKey:    string;
  verdict:      ExperimentDecisionVerdict;
  reasonCode:   ExperimentDecisionReasonCode;
  /** One-sentence narrative for the evidence panel / audit trail. */
  reason:       string;
  /** Concrete observations that contributed to the decision: the per-arm
   *  counts, the metric delta, the active threshold values, the failing
   *  guardrail (if any). The list is ordered roughly by relevance. */
  evidence:     string[];
  /** ISO timestamp of the decision (from injected `now`). */
  decidedAt:    string;
  /** The thresholds that were actually used (defaults filled in). Useful
   *  so an audit reader does not have to cross-reference the defaults. */
  thresholdsUsed: Required<ExperimentDecisionThresholds>;
  /** Echo of the candidate fields a downstream registration helper needs.
   *  Self-describing in logs without a join. */
  candidate: {
    hypothesisId: string;
    origin:       MetricBinding["candidate"]["origin"];
    tag:          MetricBinding["candidate"]["tag"];
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function validArm(arm: ArmAggregate | undefined): arm is ArmAggregate {
  if (!arm) return false;
  if (!isFiniteNumber(arm.count) || arm.count < 0 || !Number.isInteger(arm.count)) return false;
  if (!isFiniteNumber(arm.metric)) return false;
  // metric is allowed to be any finite number — scale depends on the metric.
  // 0 is meaningful (e.g. "all trials parse-failed"). Negative is allowed
  // (some metrics are signed). NaN/Infinity is not.
  return true;
}

function validCost(cost: ArmCost | undefined): cost is ArmCost {
  if (!cost) return false;
  if (!isFiniteNumber(cost.costUsd)) return false;
  if (cost.costUsd < 0) return false;
  return true;
}

function mergeThresholds(
  override: ExperimentDecisionThresholds | undefined,
): Required<ExperimentDecisionThresholds> {
  return { ...DEFAULT_THRESHOLDS, ...(override ?? {}) };
}

function fmt(n: number): string {
  if (!isFiniteNumber(n)) return String(n);
  // Trim trailing zeros without using exponential notation.
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}

// ── Core decision ────────────────────────────────────────────────────────────

/**
 * The Phase 2c decision rule. Pure, deterministic, propose-only.
 *
 * Evaluation order matches the rule list in the module banner; the first
 * matching rule wins. Adding a rule is a one-place change here plus a new
 * `ExperimentDecisionReasonCode`.
 */
export function decideExperimentOutcome(
  input: ExperimentDecisionInput,
  now: Date = new Date(),
): ExperimentDecision {
  const thresholds = mergeThresholds(input.thresholds);
  const { binding, baseline, treatment } = input;

  const candidateEcho = {
    hypothesisId: binding.candidate.hypothesisId,
    origin:       binding.candidate.origin,
    tag:          binding.candidate.tag,
  };
  const decisionBase = {
    hypothesisId:   binding.hypothesisId,
    metricKey:      binding.metricKey,
    decidedAt:      now.toISOString(),
    thresholdsUsed: thresholds,
    candidate:      candidateEcho,
  };

  // 1. Missing aggregate fields. We do NOT invent values.
  if (!baseline || !treatment) {
    return {
      ...decisionBase,
      verdict:    "needs_review",
      reasonCode: "missing_aggregate",
      reason:
        "decision input is missing baseline or treatment aggregate; cannot evaluate",
      evidence: [
        `baseline present: ${baseline ? "yes" : "no"}`,
        `treatment present: ${treatment ? "yes" : "no"}`,
      ],
    };
  }

  // 2. Invalid aggregate (NaN, negative counts, non-integer counts, etc.).
  if (!validArm(baseline) || !validArm(treatment)) {
    return {
      ...decisionBase,
      verdict:    "needs_review",
      reasonCode: "invalid_aggregate",
      reason:
        "baseline or treatment aggregate has non-finite or negative fields; cannot evaluate deterministically",
      evidence: [
        `baseline: count=${baseline.count}, metric=${baseline.metric}`,
        `treatment: count=${treatment.count}, metric=${treatment.metric}`,
      ],
    };
  }

  // 3. Guardrails — first failed fatal guardrail wins. A failed advisory
  //    guardrail produces `needs_review` rather than silently passing.
  const guardrails = input.guardrails ?? [];
  for (const g of guardrails) {
    if (g.passed) continue;
    const fatal = g.fatal !== false;
    if (fatal) {
      return {
        ...decisionBase,
        verdict:    "reject",
        reasonCode: "guardrail_failure",
        reason:
          `fatal guardrail '${g.name}' failed; rejecting candidate`,
        evidence: [
          `guardrail '${g.name}': failed (fatal)`,
          ...(g.detail ? [`detail: ${g.detail}`] : []),
        ],
      };
    } else {
      return {
        ...decisionBase,
        verdict:    "needs_review",
        reasonCode: "ambiguous_guardrail",
        reason:
          `advisory guardrail '${g.name}' failed; routing to human review`,
        evidence: [
          `guardrail '${g.name}': failed (advisory, fatal=false)`,
          ...(g.detail ? [`detail: ${g.detail}`] : []),
        ],
      };
    }
  }

  // 4. Sample size. We require BOTH per-arm minimums and a total minimum so
  //    a degenerate run (e.g. 30 baseline / 0 treatment) cannot promote.
  const totalSamples = baseline.count + treatment.count;
  const perArmOk =
    baseline.count  >= thresholds.minPerArmSamples &&
    treatment.count >= thresholds.minPerArmSamples;
  const totalOk = totalSamples >= thresholds.minTotalSamples;
  if (!perArmOk || !totalOk) {
    return {
      ...decisionBase,
      verdict:    "continue",
      reasonCode: "insufficient_sample",
      reason:
        `sample size below threshold (baseline=${baseline.count}, treatment=${treatment.count}, min per arm=${thresholds.minPerArmSamples}, min total=${thresholds.minTotalSamples})`,
      evidence: [
        `baseline.count: ${baseline.count}`,
        `treatment.count: ${treatment.count}`,
        `total: ${totalSamples} (need ≥ ${thresholds.minTotalSamples})`,
        `per-arm minimum: ${thresholds.minPerArmSamples}`,
      ],
    };
  }

  // 5. Cost up without quality. Evaluated BEFORE the metric-delta rules so a
  //    "flat metric, big cost increase" outcome reliably rejects rather than
  //    falling through to `inconclusive`. Skipped silently when cost data is
  //    not provided on both arms.
  const delta = treatment.metric - baseline.metric;
  if (validCost(input.baselineCost) && validCost(input.treatmentCost)) {
    const cb = input.baselineCost.costUsd;
    const ct = input.treatmentCost.costUsd;
    // Avoid divide-by-zero on a free baseline. Treat ct>0 with cb=0 as
    // "infinite ratio" → treat as a cost increase if it exceeds the
    // absolute floor.
    const costRatio =
      cb > 0 ? (ct / cb) - 1
      : ct > 0 ? Number.POSITIVE_INFINITY
      : 0;
    if (
      costRatio > thresholds.maxFlatCostRatio &&
      delta < thresholds.minMetricImprovementForCost
    ) {
      return {
        ...decisionBase,
        verdict:    "reject",
        reasonCode: "cost_up_without_improvement",
        reason:
          `cost rose ${fmt(costRatio * 100)}% with metric delta ${fmt(delta)} below the ${fmt(thresholds.minMetricImprovementForCost)} improvement floor; rejecting`,
        evidence: [
          `baseline cost: $${fmt(cb)}`,
          `treatment cost: $${fmt(ct)}`,
          `cost ratio: ${fmt(costRatio)} (max flat: ${fmt(thresholds.maxFlatCostRatio)})`,
          `metric delta: ${fmt(delta)} (improvement floor: ${fmt(thresholds.minMetricImprovementForCost)})`,
        ],
      };
    }
  }

  // 6. Primary metric clearly worse.
  if (delta <= -thresholds.rejectAbsoluteDelta) {
    return {
      ...decisionBase,
      verdict:    "reject",
      reasonCode: "primary_metric_worse",
      reason:
        `treatment metric ${fmt(treatment.metric)} is at least ${fmt(thresholds.rejectAbsoluteDelta)} below baseline ${fmt(baseline.metric)}; rejecting`,
      evidence: [
        `baseline.metric: ${fmt(baseline.metric)}`,
        `treatment.metric: ${fmt(treatment.metric)}`,
        `delta: ${fmt(delta)} (reject threshold: -${fmt(thresholds.rejectAbsoluteDelta)})`,
        `n: baseline=${baseline.count}, treatment=${treatment.count}`,
      ],
    };
  }

  // 7. Primary metric clearly better.
  if (delta >= thresholds.promoteAbsoluteDelta) {
    return {
      ...decisionBase,
      verdict:    "promote",
      reasonCode: "primary_metric_better",
      reason:
        `treatment metric ${fmt(treatment.metric)} is at least ${fmt(thresholds.promoteAbsoluteDelta)} above baseline ${fmt(baseline.metric)} with sample size met; recommending promote`,
      evidence: [
        `baseline.metric: ${fmt(baseline.metric)}`,
        `treatment.metric: ${fmt(treatment.metric)}`,
        `delta: ${fmt(delta)} (promote threshold: +${fmt(thresholds.promoteAbsoluteDelta)})`,
        `n: baseline=${baseline.count}, treatment=${treatment.count}`,
      ],
    };
  }

  // 8. Otherwise: valid evidence, sample met, no guardrail problem, but the
  //    delta is inside the band [−reject, +promote). Keep running.
  return {
    ...decisionBase,
    verdict:    "continue",
    reasonCode: "inconclusive",
    reason:
      `metric delta ${fmt(delta)} is inside the inconclusive band (±${fmt(Math.min(thresholds.promoteAbsoluteDelta, thresholds.rejectAbsoluteDelta))}); continue running`,
    evidence: [
      `baseline.metric: ${fmt(baseline.metric)}`,
      `treatment.metric: ${fmt(treatment.metric)}`,
      `delta: ${fmt(delta)}`,
      `band: [-${fmt(thresholds.rejectAbsoluteDelta)}, +${fmt(thresholds.promoteAbsoluteDelta)}]`,
      `n: baseline=${baseline.count}, treatment=${treatment.count}`,
    ],
  };
}

// ── Bulk helper ──────────────────────────────────────────────────────────────

export interface ExperimentDecisionReport {
  decisions: ExperimentDecision[];
  summary: {
    inputCount: number;
    byVerdict:  Record<ExperimentDecisionVerdict, number>;
  };
  generatedAt: string;
}

const ZERO_VERDICT_COUNTS: Record<ExperimentDecisionVerdict, number> = {
  promote:      0,
  reject:       0,
  continue:     0,
  needs_review: 0,
};

/**
 * Decide a list of inputs in one call. Useful when a future Phase 2d helper
 * wants to render the full backlog state. Empty input is not a failure.
 */
export function decideExperimentOutcomes(
  inputs: readonly ExperimentDecisionInput[],
  now: Date = new Date(),
): ExperimentDecisionReport {
  const decisions: ExperimentDecision[] = [];
  const byVerdict: Record<ExperimentDecisionVerdict, number> = { ...ZERO_VERDICT_COUNTS };
  for (const input of inputs) {
    const d = decideExperimentOutcome(input, now);
    decisions.push(d);
    byVerdict[d.verdict] += 1;
  }
  return {
    decisions,
    summary: {
      inputCount: inputs.length,
      byVerdict,
    },
    generatedAt: now.toISOString(),
  };
}

// ── Public threshold view ────────────────────────────────────────────────────

/** Read-only view of the default thresholds. Exported so dashboards / audit
 *  CLIs can render "what thresholds did Phase 2c use?" without importing the
 *  constant directly. */
export function getDefaultDecisionThresholds(): Required<ExperimentDecisionThresholds> {
  return { ...DEFAULT_THRESHOLDS };
}
