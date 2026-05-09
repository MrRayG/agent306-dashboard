/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2e: HYPOTHESIS SANDBOXED EXECUTION WIRING
 *
 * Phase 2 / 2b / 2c / 2d gave us a clean, propose-only chain:
 *
 *     research_lab.hypotheses[]
 *        → selectFormalHypothesisCandidates  (Phase 2 / 1.5)
 *        → bindCandidateMetric               (Phase 2b)
 *        → decideExperimentOutcome           (Phase 2c)
 *        → appendDecisionEvent               (Phase 2d, append-only ledger)
 *
 * Nothing in that chain runs an experiment, registers a row in
 * `experiments`, mutates a hypothesis status, or schedules anything. Phase 2e
 * closes the next narrow gap: turning a successful Phase 2b binding into a
 * **sandboxed execution plan** an operator can review (or a future Phase 2e-b
 * helper can act on, when live registration is sandbox-safe).
 *
 * The output of Phase 2e is `SandboxExecutionPlan` (success) or
 * `SandboxExecutionRefusal` (failure). Both shapes carry explicit decision
 * evidence so an operator (or a future Phase 2e-b live-registration helper)
 * can audit the call without re-running it.
 *
 * This module is intentionally:
 *   - PLAN-ONLY: nothing here calls `registerExperiment`, `recordTrialOutcome`,
 *     `runExperiment`, the scheduler, or any other live-side-effect path. The
 *     output is a *plan* — a typed record describing what would be registered
 *     if an operator approved it. The active `registerExperiment` is a direct
 *     DB write that creates a `running` row and invalidates the runtime cache,
 *     so it is NOT obviously sandbox-safe; calling it from this layer is
 *     deferred to Phase 2e-b once a dry-run / sandbox flag exists on the
 *     registration helper itself.
 *   - PROPOSE-ONLY: appending a plan MUST NOT mutate hypothesis status, the
 *     experiment registry, `promotion_events` / `retraction_events`, the
 *     decision-events ledger, memory entries, or any other engine state. The
 *     plan is a record describing what would happen — nothing more. This
 *     mirrors the propose-only invariant in `selfRecommendationEngine.ts`
 *     (see CLAUDE.md self-evolution policy).
 *   - DEFENSE-IN-DEPTH: the function signature accepts only a successful
 *     `MetricBinding`. A `MetricBindingRefusal` cannot reach this module
 *     because TypeScript narrows `MetricBinding | MetricBindingRefusal` on
 *     `ok: true`. Memory-origin records cannot become a binding by Phase 1.5b's
 *     hard-no, so they cannot become a plan either. There is no bypass. The
 *     binding's `candidate.origin` is additionally re-checked at runtime in
 *     case a caller hand-rolls a record around the type system.
 *   - DEFAULT-REFUSE: the controls are all required and explicit. A caller
 *     who omits the feature flag, the operator approval, or the resource cap
 *     gets a structured refusal — there is no "convenient default" path that
 *     could quietly let a live experiment slip out of the sandbox.
 *
 * Phase 2e entry criteria (codified):
 *   1. Input is a successful `MetricBinding` (Phase 2b output) — i.e. the
 *      Phase 2 selector cleared the formal hypothesis and the binder mapped
 *      the metric to a registered key with a known data source.
 *   2. Controls explicitly request sandbox planning:
 *        - `featureFlag === true`           — the operator's deployment-wide
 *                                             gate for Phase 2e is on.
 *        - `operatorApproved === true`      — the per-call human approval is
 *                                             present (no "default-yes" path).
 *        - `maxTrials >= 1` and finite      — a resource cap is mandatory.
 *        - `allowedMetricKey === binding.metricKey`  — the operator has
 *                                             explicitly listed the metric the
 *                                             plan binds to. A binding to a
 *                                             metric the operator did not
 *                                             pre-authorize is refused.
 *        - `allowedExperimentKind === "modelRouter"` — Phase 2e ships with the
 *                                             single experiment kind the
 *                                             registration helper supports.
 *   3. (Optional) `dryRun` flag is honoured: a `dryRun: true` plan still
 *      produces an executionPlanId and an evidence trail, but it carries the
 *      `dryRun: true` discriminant so a downstream Phase 2e-b helper that
 *      *does* call `registerExperiment` knows to skip the side effect. The
 *      plan-only invariant of Phase 2e is independent of this flag — Phase 2e
 *      itself never registers anything either way.
 *
 * Out of scope for Phase 2e (deferred to Phase 2e-b / 2f):
 *   - Calling `registerExperiment` with a sandbox / dry-run mode. The current
 *     `registerExperiment` writes a `running` row and invalidates the runtime
 *     cache — it has no dry-run path. Phase 2e-b adds a sandbox-safe
 *     registration helper (or a sandbox flag on the existing one) that
 *     respects `dryRun` and `maxTrials`, then wires this module to call it.
 *   - Scheduler / daily-cycle automation. Phase 2e produces plans on demand;
 *     a scheduler that walks the decision-events ledger and produces plans
 *     automatically is explicitly out of scope.
 *   - Promotion / retraction events on the hypothesis record.
 *   - Meta-reflection / lessons database (Phase 2f). A summariser that reads
 *     the plans + decision events together is Phase 2f.
 *   - Dashboard surfaces over plans.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { MetricBinding } from "./hypothesisMetricBinding.js";

// ── Refusal codes ────────────────────────────────────────────────────────────
//
// Stable enum so callers can branch on a code rather than parse free text.

export type SandboxExecutionRefusalCode =
  | "feature_flag_off"
  | "operator_not_approved"
  | "missing_resource_cap"
  | "resource_cap_exceeds_limit"
  | "metric_not_allowed"
  | "experiment_kind_not_allowed"
  | "binding_not_ok"
  | "binding_origin_invalid"
  | "binding_missing_metric_key"
  | "invalid_controls";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Hard upper bound on `maxTrials` for any sandbox plan. Phase 2e is the
 * narrowest safe bridge — even an operator with `featureFlag: true` and
 * `operatorApproved: true` should not be able to spin up an experiment with
 * an unbounded trial cap. Phase 2e-b can lift this once the live
 * registration helper grows a sandbox mode.
 */
export const PHASE2E_HARD_MAX_TRIALS = 200;

/**
 * Minimum `maxTrials` we will accept. A plan with `maxTrials < 1` is a
 * misuse — the operator clearly did not mean to authorize any trials.
 */
export const PHASE2E_MIN_TRIALS = 1;

/**
 * The single experiment kind Phase 2e supports today. Mirrors the surface
 * accepted by `registerExperiment` (which is `"modelRouter"`-only as of
 * Phase 0). Adding a kind here is a one-line change PLUS the corresponding
 * support in the live registration helper — keep them in sync.
 */
export const PHASE2E_SUPPORTED_EXPERIMENT_KINDS = ["modelRouter"] as const;
export type SupportedExperimentKind = (typeof PHASE2E_SUPPORTED_EXPERIMENT_KINDS)[number];

// ── Controls ─────────────────────────────────────────────────────────────────

/**
 * Operator-supplied controls. EVERY field is required and explicit — Phase 2e
 * has no "default-yes" path. A caller who wants to plan a sandbox execution
 * has to actively assert each control.
 *
 * Field semantics:
 *   - `featureFlag`: deployment-wide gate. The operator turns this on once,
 *     across the deployment, after deciding Phase 2e is allowed to run.
 *   - `operatorApproved`: per-call human approval. The operator must set
 *     this to `true` for THIS specific plan request — it is not a stored
 *     preference. There is no shortcut for "always approved".
 *   - `dryRun`: when `true`, the resulting plan carries the `dryRun: true`
 *     discriminant and a downstream Phase 2e-b helper MUST skip the live
 *     `registerExperiment` side effect. Phase 2e itself produces a plan in
 *     either case — this flag is a contract for the next layer.
 *   - `maxTrials`: required resource cap. Must be a finite integer in
 *     `[PHASE2E_MIN_TRIALS, PHASE2E_HARD_MAX_TRIALS]`.
 *   - `allowedMetricKey`: must equal the binding's `metricKey`. This is the
 *     operator's explicit acknowledgment that they know which metric the
 *     plan will bind to — a binding to a metric they did not authorize is
 *     refused, even if every other control is set.
 *   - `allowedExperimentKind`: must be one of
 *     `PHASE2E_SUPPORTED_EXPERIMENT_KINDS`.
 *   - `notes`: optional free-text note carried into the plan's evidence
 *     trail for the audit reader.
 */
export interface SandboxExecutionControls {
  featureFlag:           boolean;
  operatorApproved:      boolean;
  dryRun:                boolean;
  maxTrials:             number;
  allowedMetricKey:      string;
  allowedExperimentKind: SupportedExperimentKind | string;
  notes?:                string;
}

// ── Plan + refusal shapes ────────────────────────────────────────────────────

/**
 * Successful sandbox execution plan. This record is intentionally
 * self-describing in logs — every field a downstream Phase 2e-b helper would
 * need to call `registerExperiment` is present, plus an evidence trail.
 *
 * `dryRun` is the discriminant a Phase 2e-b helper checks before calling
 * `registerExperiment`. Phase 2e itself does not look at it for any side
 * effect — it is a contract for the next layer.
 */
export interface SandboxExecutionPlan {
  ok: true;
  /** `plan_<unix-ms>_<6-char-base36>`. Unique per process, sortable by time. */
  executionPlanId: string;
  /** Echoed from the binding for self-describing logs. */
  hypothesisId: string;
  /** From the upstream Phase 2 candidate, threaded through Phase 2b. */
  candidateId: string;
  /** Canonical metric key (Phase 2b output). */
  metricKey: string;
  /** Sandbox classification. Always `"sandbox"` for Phase 2e — Phase 2e-b
   *  may add `"sandbox-live"` for plans that are allowed to call the live
   *  registration helper. Today the only mode is `"sandbox"`. */
  sandboxMode: "sandbox";
  /** `true` when the controls requested a dry-run. A Phase 2e-b helper that
   *  reads this plan MUST skip the live registration side effect when
   *  `dryRun === true`. */
  dryRun: boolean;
  /** Resource caps applied to this plan. */
  resourceCaps: {
    maxTrials: number;
  };
  /** The single supported experiment kind today (modelRouter). Phase 2e-b
   *  may grow this. */
  experimentKind: SupportedExperimentKind;
  /** ISO timestamp the plan was produced. Injected `now` for tests. */
  plannedAt: string;
  /** Reason narrative for the audit panel. */
  reason: string;
  /** Evidence trail — concrete observations contributing to the plan. */
  evidence: string[];
  /** Echo of the binding fields the audit reader cares about. */
  binding: {
    hypothesisId:       string;
    metricKey:          string;
    matchedDataSources: string[];
    candidateOrigin:    MetricBinding["candidate"]["origin"];
    candidateTag:       MetricBinding["candidate"]["tag"];
  };
  /** Echo of the controls so a single plan record is self-describing. */
  controls: {
    featureFlag:           boolean;
    operatorApproved:      boolean;
    dryRun:                boolean;
    maxTrials:             number;
    allowedMetricKey:      string;
    allowedExperimentKind: string;
    notes?:                string;
  };
}

export interface SandboxExecutionRefusal {
  ok: false;
  hypothesisId: string;
  code: SandboxExecutionRefusalCode;
  reason: string;
  evidence: string[];
  /** Echo of the controls so a refusal record is self-describing. Same
   *  shape as on the plan. */
  controls: {
    featureFlag:           boolean;
    operatorApproved:      boolean;
    dryRun:                boolean;
    maxTrials:             number;
    allowedMetricKey:      string;
    allowedExperimentKind: string;
    notes?:                string;
  };
}

// ── ID generation ────────────────────────────────────────────────────────────

let __planIdCounter = 0;

function nextExecutionPlanId(now: Date): string {
  // `plan_<unix-ms>_<6-char-base36>`. Counter ensures uniqueness within a
  // single millisecond; randomness is intentionally avoided so tests remain
  // deterministic when given a fixed `now`.
  __planIdCounter = (__planIdCounter + 1) & 0xfffffff;
  const suffix = __planIdCounter.toString(36).padStart(6, "0").slice(-6);
  return `plan_${now.getTime()}_${suffix}`;
}

// ── Validation ───────────────────────────────────────────────────────────────

function isFiniteInt(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && Number.isInteger(x);
}

// ── Core plan builder ────────────────────────────────────────────────────────

/**
 * Build a sandboxed execution plan from a successful Phase 2b binding plus
 * explicit operator controls. Returns a refusal with structured evidence on
 * any boundary violation.
 *
 * Pre-condition: `binding` MUST be a successful `MetricBinding` from
 * `bindCandidateMetric`. The TypeScript type rejects `MetricBindingRefusal`;
 * the runtime additionally re-checks `binding.candidate.origin` and
 * `binding.metricKey` so a hand-rolled record cannot bypass the gate.
 */
export function planSandboxExecution(
  binding: MetricBinding,
  controls: SandboxExecutionControls,
  now: Date = new Date(),
): SandboxExecutionPlan | SandboxExecutionRefusal {
  const controlsEcho = {
    featureFlag:           controls?.featureFlag === true,
    operatorApproved:      controls?.operatorApproved === true,
    dryRun:                controls?.dryRun === true,
    maxTrials:             typeof controls?.maxTrials === "number" ? controls.maxTrials : NaN,
    allowedMetricKey:      typeof controls?.allowedMetricKey === "string" ? controls.allowedMetricKey : "",
    allowedExperimentKind: typeof controls?.allowedExperimentKind === "string" ? controls.allowedExperimentKind : "",
    notes:                 typeof controls?.notes === "string" ? controls.notes : undefined,
  };

  // The hypothesisId we surface on every refusal. We pull it from the
  // binding when possible (defense in depth: a hand-rolled record might be
  // missing it, in which case we surface "<unknown>").
  const hypothesisId =
    typeof binding?.hypothesisId === "string" && binding.hypothesisId
      ? binding.hypothesisId
      : "<unknown>";

  const refusalBase = {
    ok:           false as const,
    hypothesisId,
    controls:     controlsEcho,
  };

  // 0a. Defense-in-depth runtime guard: even though the TypeScript type
  // requires a successful binding, a caller might force-coerce a refusal or
  // hand-roll a record. Refuse explicitly so the failure is auditable rather
  // than mysterious.
  if (!binding || (binding as { ok?: unknown }).ok !== true) {
    return {
      ...refusalBase,
      code:   "binding_not_ok",
      reason: "binding is not a successful MetricBinding (ok !== true)",
      evidence: [
        `binding.ok: ${(binding as { ok?: unknown })?.ok ?? "<missing>"}`,
        "Phase 2e accepts only Phase 2b successful bindings; a refusal cannot be planned",
      ],
    };
  }

  if (!binding.metricKey || typeof binding.metricKey !== "string") {
    return {
      ...refusalBase,
      code:   "binding_missing_metric_key",
      reason: "binding has no metricKey",
      evidence: [
        `binding.metricKey: ${binding.metricKey ?? "<missing>"}`,
        "Phase 2e requires a Phase 2b-bound metricKey",
      ],
    };
  }

  // 0b. Defense-in-depth: the only legal binding origin is the formal
  // research-lab path. Memory-origin records cannot become a binding by
  // Phase 1.5b's hard-no — but if a caller hand-rolls a record around the
  // type system, refuse loudly here too.
  if (binding.candidate?.origin !== "research_lab.hypotheses") {
    return {
      ...refusalBase,
      code:   "binding_origin_invalid",
      reason:
        `binding.candidate.origin must be "research_lab.hypotheses"; got '${String(binding.candidate?.origin)}'`,
      evidence: [
        `binding.candidate.origin: ${String(binding.candidate?.origin)}`,
        "memory-origin records cannot enter the Phase 2e sandbox path",
      ],
    };
  }

  // 0c. Bare type-shape check on `controls`. The function signature requires
  // an object, but a JavaScript caller (or a JSON-decoded payload) might
  // pass `null` / `undefined` / a non-object.
  if (!controls || typeof controls !== "object") {
    return {
      ...refusalBase,
      code:   "invalid_controls",
      reason: "controls must be a SandboxExecutionControls object",
      evidence: [
        `typeof controls: ${typeof controls}`,
        "Phase 2e refuses by default when controls are missing",
      ],
    };
  }

  // 1. Feature flag must be explicitly on.
  if (controls.featureFlag !== true) {
    return {
      ...refusalBase,
      code:   "feature_flag_off",
      reason: "Phase 2e feature flag is not enabled (controls.featureFlag !== true)",
      evidence: [
        `controls.featureFlag: ${String(controls.featureFlag)}`,
        "Phase 2e is default-refuse; the feature flag must be explicitly true",
      ],
    };
  }

  // 2. Operator approval must be explicitly true.
  if (controls.operatorApproved !== true) {
    return {
      ...refusalBase,
      code:   "operator_not_approved",
      reason:
        "operator has not approved this sandbox execution (controls.operatorApproved !== true)",
      evidence: [
        `controls.operatorApproved: ${String(controls.operatorApproved)}`,
        "Phase 2e requires per-call human approval; there is no stored 'always approved' shortcut",
      ],
    };
  }

  // 3. Resource cap is mandatory and bounded.
  if (!isFiniteInt(controls.maxTrials)) {
    return {
      ...refusalBase,
      code:   "missing_resource_cap",
      reason: "controls.maxTrials must be a finite integer",
      evidence: [
        `controls.maxTrials: ${String(controls.maxTrials)}`,
        `Phase 2e requires an explicit resource cap in [${PHASE2E_MIN_TRIALS}, ${PHASE2E_HARD_MAX_TRIALS}]`,
      ],
    };
  }

  if (controls.maxTrials < PHASE2E_MIN_TRIALS) {
    return {
      ...refusalBase,
      code:   "missing_resource_cap",
      reason:
        `controls.maxTrials (${controls.maxTrials}) is below the minimum (${PHASE2E_MIN_TRIALS}); a non-positive cap is not a sandbox plan`,
      evidence: [
        `controls.maxTrials: ${controls.maxTrials}`,
        `minimum: ${PHASE2E_MIN_TRIALS}`,
      ],
    };
  }

  if (controls.maxTrials > PHASE2E_HARD_MAX_TRIALS) {
    return {
      ...refusalBase,
      code:   "resource_cap_exceeds_limit",
      reason:
        `controls.maxTrials (${controls.maxTrials}) exceeds the Phase 2e hard cap (${PHASE2E_HARD_MAX_TRIALS})`,
      evidence: [
        `controls.maxTrials: ${controls.maxTrials}`,
        `hard cap: ${PHASE2E_HARD_MAX_TRIALS}`,
        "Phase 2e-b may lift this once the live registration helper grows a sandbox mode",
      ],
    };
  }

  // 4. Allowed metric key must match the bound metric key (case-sensitive,
  // exact). This forces the operator to spell out the metric they meant to
  // authorize — a binding to an unexpected metric is refused even when every
  // other control is set.
  if (!controls.allowedMetricKey || typeof controls.allowedMetricKey !== "string") {
    return {
      ...refusalBase,
      code:   "metric_not_allowed",
      reason: "controls.allowedMetricKey is required",
      evidence: [
        `controls.allowedMetricKey: ${String(controls.allowedMetricKey)}`,
        `binding.metricKey: ${binding.metricKey}`,
      ],
    };
  }

  if (controls.allowedMetricKey !== binding.metricKey) {
    return {
      ...refusalBase,
      code:   "metric_not_allowed",
      reason:
        `binding metricKey '${binding.metricKey}' is not the operator-authorized metric '${controls.allowedMetricKey}'`,
      evidence: [
        `controls.allowedMetricKey: ${controls.allowedMetricKey}`,
        `binding.metricKey: ${binding.metricKey}`,
        "Phase 2e refuses when the operator has not pre-authorized the bound metric",
      ],
    };
  }

  // 5. Experiment kind must be in the supported set.
  if (
    !controls.allowedExperimentKind ||
    typeof controls.allowedExperimentKind !== "string" ||
    !PHASE2E_SUPPORTED_EXPERIMENT_KINDS.includes(controls.allowedExperimentKind as SupportedExperimentKind)
  ) {
    return {
      ...refusalBase,
      code:   "experiment_kind_not_allowed",
      reason:
        `controls.allowedExperimentKind '${String(controls.allowedExperimentKind)}' is not in the supported set [${PHASE2E_SUPPORTED_EXPERIMENT_KINDS.join(", ")}]`,
      evidence: [
        `controls.allowedExperimentKind: ${String(controls.allowedExperimentKind)}`,
        `supported: ${PHASE2E_SUPPORTED_EXPERIMENT_KINDS.join(", ")}`,
      ],
    };
  }

  const experimentKind = controls.allowedExperimentKind as SupportedExperimentKind;

  const planId = nextExecutionPlanId(now);
  const candidateId = binding.candidate.hypothesisId;

  return {
    ok:              true,
    executionPlanId: planId,
    hypothesisId:    binding.hypothesisId,
    candidateId,
    metricKey:       binding.metricKey,
    sandboxMode:     "sandbox",
    dryRun:          controls.dryRun === true,
    resourceCaps: {
      maxTrials: controls.maxTrials,
    },
    experimentKind,
    plannedAt:       now.toISOString(),
    reason:
      `Phase 2e sandbox plan for hypothesis '${binding.hypothesisId}' bound to metric '${binding.metricKey}'`,
    evidence: [
      `feature flag: enabled`,
      `operator approval: present`,
      `resource cap (maxTrials): ${controls.maxTrials} (hard cap: ${PHASE2E_HARD_MAX_TRIALS})`,
      `dry run: ${controls.dryRun === true}`,
      `experiment kind: ${experimentKind}`,
      `bound metric: ${binding.metricKey}`,
      `data source(s): ${binding.matchedDataSources.join(", ")}`,
      `candidate origin: ${binding.candidate.origin}`,
      `candidate hygiene tag: ${binding.candidate.tag}`,
      ...(controls.notes ? [`operator notes: ${controls.notes}`] : []),
    ],
    binding: {
      hypothesisId:       binding.hypothesisId,
      metricKey:          binding.metricKey,
      matchedDataSources: [...binding.matchedDataSources],
      candidateOrigin:    binding.candidate.origin,
      candidateTag:       binding.candidate.tag,
    },
    controls: controlsEcho,
  };
}

// ── Convenience: live-registration shim (intentionally NOT wired) ────────────

/**
 * Phase 2e-b placeholder. Today this is a no-op that returns a structured
 * refusal explaining that live registration is deferred to Phase 2e-b.
 *
 * Why this exists at all: the docstring on `planSandboxExecution` promises a
 * "Phase 2e-b helper that calls the live registration helper". This stub
 * makes the propose-only invariant of Phase 2e visible to anyone who imports
 * the module — and keeps the door explicitly closed until the live
 * registration helper grows a dry-run / sandbox path.
 *
 * IMPORTANT: This function MUST NOT call `registerExperiment` or any other
 * live-side-effect helper. If you change that, you are doing Phase 2e-b
 * work — open a new PR, gate it behind its own feature flag, and update the
 * propose-only invariants in CLAUDE.md / docs/SELF_EVOLUTION.md.
 */
export function applySandboxExecutionPlan(
  _plan: SandboxExecutionPlan,
): { ok: false; reason: string; deferredTo: "phase-2e-b" } {
  return {
    ok:         false,
    reason:
      "Phase 2e is plan-only; live registration is deferred to Phase 2e-b once the registration helper supports a sandbox / dry-run mode",
    deferredTo: "phase-2e-b",
  };
}
