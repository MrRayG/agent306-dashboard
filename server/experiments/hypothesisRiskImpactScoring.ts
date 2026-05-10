/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2g: HYPOTHESIS RISK + IMPACT SCORING
 *
 * Phase 2 already provides a hygiene gate (`canFeedExperiment`) and a candidate
 * selector (`selectFormalHypothesisCandidates`). They answer "is this record
 * structurally complete enough to feed downstream?" — but they do not say
 * *which* of the structurally complete candidates are the safest to act on
 * first, or which ones cannot be acted on at all because of the action they
 * imply.
 *
 * Phase 2g adds that missing layer. Given a candidate (or any record being
 * considered for downstream flow), this module returns a deterministic risk +
 * impact verdict with a rationale and a downstream decision such as
 * `eligible`, `blocked`, or `needs_review`. The verdict is propose-only — it
 * is suggested input for a future selection step. Nothing here registers a
 * sandbox kind, posts publicly, schedules anything, or mutates state.
 *
 * This module is intentionally:
 *   - PURE: no I/O, no persistence, no LLM calls. Inputs are typed, outputs
 *     are typed verdicts. Tests exercise it directly with fixtures.
 *   - DETERMINISTIC: same input → same output. There are no clocks, no random
 *     numbers, no hidden globals. The optional `now` argument exists only so
 *     callers may stamp the verdict; it does not change classification.
 *   - DEFAULT-REFUSE: anything that names a public-action / scheduler /
 *     mutation surface, or is missing the readiness signal Phase 1.5 already
 *     defined, becomes `blocked` or `needs_review`. There is no permissive
 *     fallthrough.
 *   - PROPOSE-ONLY: nothing here calls `registerExperiment`,
 *     `appendDecisionEvent`, `registerLowRiskSandboxKind`, or any other
 *     side-effect helper. The output is *advice* about a candidate; whether
 *     anything happens with that advice is decided elsewhere and still goes
 *     through the GitHub approval boundary.
 *
 * Phase 2g entry shape:
 *   - `scoreHypothesisRiskImpact(input, opts?)` — score one record.
 *   - `scoreHypothesisRiskImpactBatch(inputs, opts?)` — score many.
 *   - `summarizeRiskImpactScores(scores)` — dashboard-friendly aggregate.
 *
 * Out of scope for Phase 2g (deferred):
 *   - Selecting / ranking which eligible candidate runs next.
 *   - Persisting scores. Today the scorer is invoked on demand and not
 *     written to a ledger; if a future PR adds persistence it must remain
 *     append-only and propose-only.
 *   - Auto-apply / promotion. Even an `eligible` verdict only means the
 *     record cleared this gate — downstream still requires explicit operator
 *     approval.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Hypothesis } from "../researchEngine.js";
import {
  canFeedExperiment,
  classifyHypothesis,
  type HygieneAwareHypothesis,
  type HygieneTag,
} from "../hypothesisHygiene.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "moderate" | "high" | "unclassifiable";
export type ImpactLevel = "low" | "moderate" | "high" | "unknown";
export type ReadinessLevel = "ready" | "planned" | "blocked";

/**
 * Stable downstream decision codes. The shape mirrors Phase 2c verdicts so
 * downstream callers can route on a small enum without parsing free text.
 *
 *   - `eligible`     — record is low-risk + read/learn-shaped; safe to flow
 *                      into hygiene/candidate selection. Still subject to the
 *                      existing approval boundary.
 *   - `needs_review` — operator must look at this record before it can flow.
 *                      Used for medium-risk records and ambiguous shapes.
 *   - `blocked`      — record is unsafe to flow from this scorer (public
 *                      action, scheduler, mutation, memory-origin, missing
 *                      readiness, unclassifiable, or otherwise refused).
 */
export type DownstreamDecision = "eligible" | "needs_review" | "blocked";

/**
 * Stable, machine-checkable rationale codes. Tests pin these; UIs render
 * them; callers branch on them. Free-text reasons may change wording without
 * changing a code.
 */
export type RiskImpactReasonCode =
  | "low_risk_sandbox_fixture_shape"
  | "summarization_template_kind"
  | "readiness_complete_metric_present"
  | "readiness_partial"
  | "readiness_blockers_present"
  | "memory_origin_blocked"
  | "public_action_blocked"
  | "scheduler_blocked"
  | "mutation_blocked"
  | "promotion_blocked"
  | "unknown_or_unclassifiable"
  | "missing_required_fields"
  | "hygiene_archived_or_blocked"
  | "hygiene_resolved_archived";

/**
 * The full per-record verdict. Intentionally explicit: the classification is
 * inspectable end-to-end so the dashboard, audit CLI, and tests can describe
 * exactly *why* a record landed where it did.
 */
export interface HypothesisRiskImpactScore {
  /** Stable id we scored. May be `memory:<id>` for memory-origin inputs. */
  refId:        string;
  /** Origin discriminant — formal hypotheses vs memory-origin entries vs
   *  hand-built candidates from a fixture or from a UI. */
  origin:       "research_lab.hypotheses" | "memory_knowledge" | "candidate" | "unknown";
  risk:         RiskLevel;
  impact:       ImpactLevel;
  readiness:    ReadinessLevel;
  /** Confidence in the classification itself (not in the underlying claim).
   *  `low` means "we know we don't know enough to be sure"; `high` means the
   *  fields needed to classify are all present and unambiguous. */
  confidence:   "low" | "moderate" | "high";
  decision:     DownstreamDecision;
  /** Short, human-readable rationale, bullet-style. */
  reasons:      string[];
  /** Stable codes so callers can branch without parsing reasons[]. */
  reasonCodes:  RiskImpactReasonCode[];
  /** Echo of the inputs that materially affected the verdict, for audit. */
  evidence:     string[];
  /** ISO timestamp the verdict was stamped. Optional `now` for tests. */
  scoredAt:     string;
}

/**
 * What we accept as input. Callers can pass a formal hypothesis, a memory
 * entry shape, or a hand-shaped candidate (e.g. a sandbox kind being
 * considered) — the discriminator decides how the scorer reads it.
 */
export interface FormalHypothesisInput {
  origin: "research_lab.hypotheses";
  hypothesis: HygieneAwareHypothesis;
}

export interface MemoryHypothesisInput {
  origin: "memory_knowledge";
  /** Memory entry id (without the `memory:` prefix). */
  id:    string;
  title: string;
  promotedToHypothesisId?: string;
}

/**
 * Hand-shaped candidate. Used by tests and by the autonomy monitor when
 * surfacing the static low-risk sandbox registry as scoring inputs without
 * needing a full hypothesis record.
 */
export interface CandidateInput {
  origin: "candidate";
  id:                  string;
  /** Free-form label — e.g. "summarizationTemplate", "publicXPost". */
  label:               string;
  /** Caller-provided shape hints. Each is optional; the scorer only acts on
   *  hints it recognises and treats unknown shapes as `unknown_or_unclassifiable`. */
  shape?: {
    /** True when the candidate is a static-fixture / sandbox-only exercise. */
    sandboxFixtureOnly?:    boolean;
    /** True when the candidate would post / publish to a public surface. */
    publicAction?:          boolean;
    /** True when the candidate would be driven by a scheduler / cron. */
    schedulerDriven?:       boolean;
    /** True when the candidate would mutate hypotheses / memory / state. */
    mutates?:               boolean;
    /** True when the candidate would auto-promote downstream. */
    autoPromote?:           boolean;
    /** True when the candidate is a known low-risk sandbox kind from the
     *  Phase 2e-b registry. The label distinguishes which kind. */
    lowRiskSandboxKind?:    boolean;
    /** True when the candidate is a learning / read-only exercise. */
    learningRead?:          boolean;
  };
}

export type ScoreInput = FormalHypothesisInput | MemoryHypothesisInput | CandidateInput;

export interface ScoreOptions {
  now?: Date;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isLikelyPublicActionLabel(label: string): boolean {
  const l = label.toLowerCase();
  // Conservative: any label that contains a posting/publishing/public-surface
  // substring is treated as public-action. We do NOT use word boundaries —
  // labels are commonly camelCase (`publishXPost`, `xPost`) and a strict
  // boundary would miss them. False positives here are safe (they trip
  // `needs_review` or `blocked` rather than `eligible`).
  return (
    /(post|publish|tweet|social|twitter|broadcast|announce|publicize|public|outbound|external|livetraffic|production)/.test(l)
  );
}

function isLikelySchedulerLabel(label: string): boolean {
  const l = label.toLowerCase();
  return /(scheduler|schedul|cron|dailycycle|backgroundjob|interval|automat)/.test(l);
}

function isLikelyMutationLabel(label: string): boolean {
  const l = label.toLowerCase();
  return /(apply|mutate|mutation|persist|registerlive|promotelive|rollout|deploylive)/.test(l);
}

function isKnownEnabledLowRiskSandboxKind(label: string): boolean {
  // Phase 2g intentionally hard-codes the single enabled low-risk kind today
  // (summarizationTemplate). Other kinds in the Phase 2e-b registry are
  // disabled and must not get a risk: low here. Kept deliberately narrow.
  return label === "summarizationTemplate";
}

// ── Per-input scoring ────────────────────────────────────────────────────────

function scoreFormalHypothesis(
  input: FormalHypothesisInput,
  scoredAt: string,
): HypothesisRiskImpactScore {
  const hyp = input.hypothesis;
  const refId = isNonEmptyString(hyp?.id) ? hyp.id : "(missing-id)";
  const verdict = canFeedExperiment(hyp);
  const { tag } = classifyHypothesis(hyp);

  // 1. Hard-block hygiene-archived / hygiene-blocked records.
  //    Distinguish resolved-archived (status: confirmed | rejected — i.e.
  //    success state, intentionally retired) from operator-blocked /
  //    irrelevant records, so the dashboard does not surface a confirmed-true
  //    hypothesis as an alarming "blocker".
  if (
    tag === "archived_irrelevant" ||
    tag === "archived_unsolvable" ||
    tag === "archived_stale" ||
    tag === "blocked"
  ) {
    const hypStatus = (hyp as Hypothesis).status;
    const isResolved = hypStatus === "confirmed" || hypStatus === "rejected";
    return {
      refId,
      origin:     "research_lab.hypotheses",
      risk:       "unclassifiable",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "high",
      decision:   "blocked",
      reasons: isResolved
        ? [
            `record is resolved (status='${hypStatus}') and intentionally retired`,
            "resolved records are not eligible for re-scoring — this is success, not a blocker",
          ]
        : [
            `hygiene tag '${tag}' marks this record as out of the active loop`,
            "Phase 2g refuses to score a record the hygiene gate has archived/blocked",
          ],
      reasonCodes: isResolved
        ? ["hygiene_resolved_archived"]
        : ["hygiene_archived_or_blocked"],
      evidence: [
        `hygieneTag: ${tag}`,
        `status: ${String(hypStatus ?? "")}`,
        `canFeedExperiment.ok: ${String(verdict.ok)}`,
      ],
      scoredAt,
    };
  }

  // 2. Hygiene gate refused → not ready.
  if (!verdict.ok) {
    const reasons = verdict.reasons.length > 0 ? verdict.reasons : ["readiness fields incomplete"];
    return {
      refId,
      origin:     "research_lab.hypotheses",
      risk:       "moderate",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "moderate",
      decision:   "blocked",
      reasons,
      reasonCodes: verdict.blockers.length > 0
        ? ["readiness_blockers_present"]
        : ["readiness_partial"],
      evidence: [
        `hygieneTag: ${tag}`,
        `canFeedExperiment.ok: false`,
        ...verdict.blockers.map(b => `blocker: ${b}`),
      ],
      scoredAt,
    };
  }

  // 3. Hygiene-cleared formal hypothesis with a non-empty metric. We are
  //    intentionally conservative on impact: a hypothesis with a measurable
  //    metric is "moderate" impact by default; explicit downstream fields
  //    (e.g. measurementPath) raise confidence but not the impact level.
  const hasMetric = isNonEmptyString(hyp.metric);
  if (!hasMetric) {
    // canFeedExperiment is supposed to enforce metric, but defense-in-depth.
    return {
      refId,
      origin:     "research_lab.hypotheses",
      risk:       "moderate",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "low",
      decision:   "needs_review",
      reasons: ["hygiene gate cleared the record but `metric` is empty — refusing to mark eligible"],
      reasonCodes: ["missing_required_fields"],
      evidence: [`metric: '${String(hyp.metric ?? "")}'`],
      scoredAt,
    };
  }

  return {
    refId,
    origin:     "research_lab.hypotheses",
    risk:       "low",
    impact:     "moderate",
    readiness:  "ready",
    confidence: isNonEmptyString(hyp.measurementPath) ? "high" : "moderate",
    decision:   "eligible",
    reasons: [
      `hygiene tag '${tag}' is in READY_TAGS`,
      `metric '${hyp.metric}' is named`,
      isNonEmptyString(hyp.measurementPath)
        ? `measurementPath '${hyp.measurementPath}' is present`
        : "measurementPath is empty — verdict downgrades confidence (still eligible)",
    ],
    reasonCodes: ["readiness_complete_metric_present"],
    evidence: [
      `hygieneTag: ${tag}`,
      `metric: ${hyp.metric}`,
      `measurementPath: ${String(hyp.measurementPath ?? "")}`,
      `status: ${String((hyp as Hypothesis).status ?? "")}`,
    ],
    scoredAt,
  };
}

function scoreMemoryHypothesis(
  input: MemoryHypothesisInput,
  scoredAt: string,
): HypothesisRiskImpactScore {
  const memId = isNonEmptyString(input?.id) ? input.id : "(missing-id)";
  return {
    refId:      `memory:${memId}`,
    origin:     "memory_knowledge",
    risk:       "unclassifiable",
    impact:     "unknown",
    readiness:  "blocked",
    confidence: "high",
    decision:   "blocked",
    reasons: [
      "memory-origin entries cannot feed Phase 2g; promote to research_lab.hypotheses[] first",
      isNonEmptyString(input.promotedToHypothesisId)
        ? `entry has been promoted to ${input.promotedToHypothesisId} — score the formal record instead`
        : "no promotion target recorded",
    ],
    reasonCodes: ["memory_origin_blocked"],
    evidence: [
      `id: ${memId}`,
      `title: ${String(input.title ?? "")}`,
      `promotedToHypothesisId: ${String(input.promotedToHypothesisId ?? "")}`,
    ],
    scoredAt,
  };
}

function scoreCandidate(
  input: CandidateInput,
  scoredAt: string,
): HypothesisRiskImpactScore {
  const id = isNonEmptyString(input?.id) ? input.id : "(missing-id)";
  const label = isNonEmptyString(input?.label) ? input.label : "";
  const shape = input.shape ?? {};

  const reasons: string[] = [];
  const codes: RiskImpactReasonCode[] = [];

  // Hard refusals first — anything that names a public-action / scheduler /
  // mutation / promotion surface is `blocked` regardless of other shape hints.
  if (shape.publicAction === true || isLikelyPublicActionLabel(label)) {
    reasons.push("candidate names a public-action / posting / publishing surface");
    reasons.push("Phase 2g refuses to mark public-action candidates eligible from a scorer");
    codes.push("public_action_blocked");
    return {
      refId:      id,
      origin:     "candidate",
      risk:       "high",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "high",
      decision:   "blocked",
      reasons,
      reasonCodes: codes,
      evidence: [
        `label: ${label}`,
        `publicAction: ${String(shape.publicAction)}`,
      ],
      scoredAt,
    };
  }

  if (shape.schedulerDriven === true || isLikelySchedulerLabel(label)) {
    return {
      refId:      id,
      origin:     "candidate",
      risk:       "high",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "high",
      decision:   "blocked",
      reasons: [
        "candidate names a scheduler / cron / daily-cycle automation surface",
        "Phase 2g refuses to mark scheduler-driven candidates eligible",
      ],
      reasonCodes: ["scheduler_blocked"],
      evidence: [
        `label: ${label}`,
        `schedulerDriven: ${String(shape.schedulerDriven)}`,
      ],
      scoredAt,
    };
  }

  if (shape.mutates === true || isLikelyMutationLabel(label)) {
    return {
      refId:      id,
      origin:     "candidate",
      risk:       "high",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "high",
      decision:   "blocked",
      reasons: [
        "candidate names a mutation / live-apply / promote-live surface",
        "Phase 2g refuses to mark mutation-shaped candidates eligible from a scorer",
      ],
      reasonCodes: ["mutation_blocked"],
      evidence: [
        `label: ${label}`,
        `mutates: ${String(shape.mutates)}`,
      ],
      scoredAt,
    };
  }

  if (shape.autoPromote === true) {
    return {
      refId:      id,
      origin:     "candidate",
      risk:       "high",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "high",
      decision:   "blocked",
      reasons: [
        "candidate asserts autoPromote: true",
        "Phase 2g refuses to mark auto-promoting candidates eligible — promotion remains approval-gated",
      ],
      reasonCodes: ["promotion_blocked"],
      evidence: [
        `label: ${label}`,
        `autoPromote: true`,
      ],
      scoredAt,
    };
  }

  // Affirmative low-risk path: sandbox fixture-only AND a known enabled
  // low-risk sandbox kind. We require BOTH the shape hint and the label
  // match, so a caller cannot label-spoof a public-action candidate into the
  // low-risk slot.
  if (
    shape.sandboxFixtureOnly === true &&
    shape.lowRiskSandboxKind === true &&
    isKnownEnabledLowRiskSandboxKind(label)
  ) {
    reasons.push("candidate is the enabled summarizationTemplate low-risk sandbox kind");
    reasons.push("static-fixture-only with no public action, no scheduler, no mutation");
    codes.push("low_risk_sandbox_fixture_shape", "summarization_template_kind");
    return {
      refId:      id,
      origin:     "candidate",
      risk:       "low",
      impact:     shape.learningRead === true ? "high" : "moderate",
      readiness:  "ready",
      confidence: "high",
      decision:   "eligible",
      reasons,
      reasonCodes: codes,
      evidence: [
        `label: ${label}`,
        `sandboxFixtureOnly: true`,
        `lowRiskSandboxKind: true`,
        `learningRead: ${String(shape.learningRead === true)}`,
      ],
      scoredAt,
    };
  }

  // Sandbox-fixture but unknown kind, or a learning-read shape without the
  // sandbox marker — needs_review rather than eligible.
  if (shape.sandboxFixtureOnly === true || shape.learningRead === true) {
    return {
      refId:      id,
      origin:     "candidate",
      risk:       "moderate",
      impact:     shape.learningRead === true ? "moderate" : "low",
      readiness:  "planned",
      confidence: "moderate",
      decision:   "needs_review",
      reasons: [
        "candidate is sandbox-fixture / learning-read but not a recognised enabled low-risk kind",
        "operator review required before downstream flow",
      ],
      reasonCodes: ["readiness_partial"],
      evidence: [
        `label: ${label}`,
        `sandboxFixtureOnly: ${String(shape.sandboxFixtureOnly === true)}`,
        `learningRead: ${String(shape.learningRead === true)}`,
        `lowRiskSandboxKind: ${String(shape.lowRiskSandboxKind === true)}`,
      ],
      scoredAt,
    };
  }

  // Default: unknown / unclassifiable. Refuse rather than allow.
  return {
    refId:      id,
    origin:     "candidate",
    risk:       "unclassifiable",
    impact:     "unknown",
    readiness:  "blocked",
    confidence: "low",
    decision:   "blocked",
    reasons: [
      "candidate shape is unknown — no recognised low-risk marker present",
      "Phase 2g default-refuses unclassifiable candidates",
    ],
    reasonCodes: ["unknown_or_unclassifiable"],
    evidence: [
      `label: ${label}`,
      `shape keys: ${Object.keys(shape).join(", ") || "(none)"}`,
    ],
    scoredAt,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pure scorer. See module header for the propose-only invariant.
 *
 * Returns a deterministic verdict — same input always yields the same
 * `risk`, `impact`, `decision`, and `reasonCodes`. Only `scoredAt` varies
 * with the optional `now`.
 */
export function scoreHypothesisRiskImpact(
  input: ScoreInput,
  opts: ScoreOptions = {},
): HypothesisRiskImpactScore {
  const scoredAt = (opts.now ?? new Date()).toISOString();

  if (!input || typeof input !== "object" || typeof (input as { origin?: unknown }).origin !== "string") {
    return {
      refId:      "(invalid-input)",
      origin:     "unknown",
      risk:       "unclassifiable",
      impact:     "unknown",
      readiness:  "blocked",
      confidence: "low",
      decision:   "blocked",
      reasons: [
        "input is missing or has no `origin` discriminator",
        "Phase 2g refuses to score an input whose shape it cannot identify",
      ],
      reasonCodes: ["unknown_or_unclassifiable"],
      evidence: [
        `typeof input: ${typeof input}`,
      ],
      scoredAt,
    };
  }

  switch (input.origin) {
    case "research_lab.hypotheses":
      return scoreFormalHypothesis(input, scoredAt);
    case "memory_knowledge":
      return scoreMemoryHypothesis(input, scoredAt);
    case "candidate":
      return scoreCandidate(input, scoredAt);
    default:
      return {
        refId:      "(unknown-origin)",
        origin:     "unknown",
        risk:       "unclassifiable",
        impact:     "unknown",
        readiness:  "blocked",
        confidence: "low",
        decision:   "blocked",
        reasons: [
          `unknown origin '${String((input as { origin?: unknown }).origin)}' — Phase 2g refuses to score it`,
        ],
        reasonCodes: ["unknown_or_unclassifiable"],
        evidence: [
          `origin: ${String((input as { origin?: unknown }).origin)}`,
        ],
        scoredAt,
      };
  }
}

/** Batch convenience wrapper. */
export function scoreHypothesisRiskImpactBatch(
  inputs: ScoreInput[],
  opts: ScoreOptions = {},
): HypothesisRiskImpactScore[] {
  if (!Array.isArray(inputs)) return [];
  return inputs.map(i => scoreHypothesisRiskImpact(i, opts));
}

// ── Aggregate ────────────────────────────────────────────────────────────────

export interface RiskImpactSummary {
  total:        number;
  byDecision:   Record<DownstreamDecision, number>;
  byRisk:       Record<RiskLevel, number>;
  byImpact:     Record<ImpactLevel, number>;
  byReadiness:  Record<ReadinessLevel, number>;
  /** Counts per stable reason code, summed across all scores. Useful for
   *  "why are records blocked?" panels. */
  byReasonCode: Record<RiskImpactReasonCode, number>;
  /** Convenience: how many are eligible AND classified low-risk. The
   *  Autonomy Monitor surfaces this so the dashboard can highlight the
   *  low-risk/high-learning bucket explicitly. */
  eligibleLowRisk: number;
}

const ALL_DECISIONS: DownstreamDecision[] = ["eligible", "needs_review", "blocked"];
const ALL_RISKS:     RiskLevel[] = ["low", "moderate", "high", "unclassifiable"];
const ALL_IMPACTS:   ImpactLevel[] = ["low", "moderate", "high", "unknown"];
const ALL_READINESS: ReadinessLevel[] = ["ready", "planned", "blocked"];

const ALL_REASON_CODES: RiskImpactReasonCode[] = [
  "low_risk_sandbox_fixture_shape",
  "summarization_template_kind",
  "readiness_complete_metric_present",
  "readiness_partial",
  "readiness_blockers_present",
  "memory_origin_blocked",
  "public_action_blocked",
  "scheduler_blocked",
  "mutation_blocked",
  "promotion_blocked",
  "unknown_or_unclassifiable",
  "missing_required_fields",
  "hygiene_archived_or_blocked",
  "hygiene_resolved_archived",
];

/**
 * Reason codes that represent "this record is intentionally not eligible —
 * not an operator-facing problem". The dashboard uses this set to color
 * neutrally (rather than as a yellow blocker). Source-of-truth here, so the
 * dashboard never has to hard-code which codes are eligible vs alarming.
 *
 *   - eligible/affirmative codes (`low_risk_sandbox_fixture_shape`,
 *     `summarization_template_kind`, `readiness_complete_metric_present`)
 *     are listed here too so the dashboard renders them neutrally as well.
 *   - `hygiene_resolved_archived` is success-state retirement.
 *   - Everything not listed here defaults to "needs operator attention".
 */
export const NEUTRAL_REASON_CODES: readonly RiskImpactReasonCode[] = [
  "low_risk_sandbox_fixture_shape",
  "summarization_template_kind",
  "readiness_complete_metric_present",
  "hygiene_resolved_archived",
];

function emptyRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
}

export function summarizeRiskImpactScores(
  scores: HypothesisRiskImpactScore[],
): RiskImpactSummary {
  const summary: RiskImpactSummary = {
    total:           Array.isArray(scores) ? scores.length : 0,
    byDecision:      emptyRecord(ALL_DECISIONS),
    byRisk:          emptyRecord(ALL_RISKS),
    byImpact:        emptyRecord(ALL_IMPACTS),
    byReadiness:     emptyRecord(ALL_READINESS),
    byReasonCode:    emptyRecord(ALL_REASON_CODES),
    eligibleLowRisk: 0,
  };
  if (!Array.isArray(scores)) return summary;

  for (const s of scores) {
    if (!s || typeof s !== "object") continue;
    if (s.decision in summary.byDecision)   summary.byDecision[s.decision]++;
    if (s.risk in summary.byRisk)           summary.byRisk[s.risk]++;
    if (s.impact in summary.byImpact)       summary.byImpact[s.impact]++;
    if (s.readiness in summary.byReadiness) summary.byReadiness[s.readiness]++;
    for (const code of s.reasonCodes ?? []) {
      if (code in summary.byReasonCode) summary.byReasonCode[code]++;
    }
    if (s.decision === "eligible" && s.risk === "low") summary.eligibleLowRisk++;
  }
  return summary;
}

// ── Re-exports of related types (convenience) ────────────────────────────────

export type { HygieneAwareHypothesis, HygieneTag };
