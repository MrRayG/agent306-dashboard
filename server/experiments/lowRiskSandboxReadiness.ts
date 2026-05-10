/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2h-a: LOW-RISK SANDBOX READINESS (visibility/guardrail layer)
 *
 * Phase 2e-b stood up the low-risk sandbox registry: only `summarizationTemplate`
 * is enabled, every other operator-approved kind is registered with
 * `enabled: false` and a stable `disabledReason`. Phase 2h-a is the next narrow
 * step: a *visibility/guardrail* layer. It does not change enablement, does
 * not run anything, does not mutate state, does not register anything. It only
 * derives — purely, from the existing registry — a readiness verdict per kind:
 *
 *     ready          — the kind is enabled today (only `summarizationTemplate`)
 *     blocked        — the kind is disabled with a known prerequisite that has
 *                      a stable disabledReason in the registry
 *     needs_review   — the kind is disabled but the disabledReason is missing
 *                      or unrecognised. Default-refuse: anything unclassifiable
 *                      lands here, never `ready`.
 *     disabled       — explicit operator-disabled state (today: same surface as
 *                      `blocked`, kept distinct so a future "we have a runner
 *                      but the operator chose to leave it off" state is
 *                      separable from "no runner exists yet").
 *
 * Each readiness record exposes:
 *   - `enabled` (mirrors registry, narrowed `true` only for `summarizationTemplate`)
 *   - `readiness` (the verdict above)
 *   - the **static safety controls** every Phase 2e-b registration must satisfy
 *     (dry-run only, static fixtures, no scheduler, no mutation, no public output,
 *      operator approval, max-trials cap, evidence/rollback note). These are
 *     read off Phase 2e-b's invariants and copied verbatim — they are not new
 *     constraints, they are *visibility* of existing constraints.
 *   - `blockedReasons[]` — short, stable, machine-readable strings the
 *     dashboard renders. Disabled kinds enumerate their missing prerequisites.
 *   - `missingPrerequisites[]` — same disabledReason in `prerequisite_*` form,
 *     useful for a dashboard chip / audit consumer that wants the missing-thing
 *     view rather than the prose view.
 *   - `recommendedExpansionOrder` — a small integer (1..N). Lower means the
 *     kind would be considered first in a future expansion PR. The order is
 *     the operator-approved order today: summarizationTemplate (already
 *     enabled), then reasoningTemplate, selfCritiquePrompt,
 *     taskDecompositionPattern, and `memoryRetrievalHeuristic` LAST because
 *     retrieval changes affect context selection and downstream reasoning more
 *     broadly — even a read-only retrieval change has the broadest blast
 *     radius of the four.
 *
 * This module is intentionally:
 *   - PURE: every function is a pure derivation of the existing registry
 *     constants. No I/O, no clock-dependence, no module-state writes.
 *   - PROPOSE-ONLY: this module never imports `registerLowRiskSandboxKind`,
 *     never mutates the registry, never crosses into the apply/execute path.
 *     It only re-exposes already-public registry data plus a verdict label.
 *   - DEFAULT-REFUSE: the readiness verdict for any kind without a recognised
 *     `disabledReason` is `needs_review`, never `ready`. The eligibility check
 *     in `isReadyForRegistration` is identity-equal to the registry's
 *     `enabled === true` check today; readiness visibility never widens
 *     eligibility.
 *   - VISIBILITY-ONLY: nothing here flips a kind from disabled to enabled or
 *     bypasses any Phase 2e-b refusal code. A future enablement PR is a
 *     separate change with its own approval; this PR only makes the existing
 *     state legible.
 *
 * Out of scope for Phase 2h-a (deferred):
 *   - Enabling additional kinds.
 *   - Adding mutation endpoints, controls, forms, or buttons.
 *   - Adding a scheduler or an apply path.
 *   - Persisting readiness verdicts (they are derived per call from the
 *     in-process registry constants).
 *   - Anything that posts publicly or publishes outside the dashboard.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  LOW_RISK_SANDBOX_REGISTRY,
  LOW_RISK_SANDBOX_KINDS,
  type LowRiskSandboxKind,
  type LowRiskSandboxKindEntry,
  type LowRiskSandboxDisabledReason,
  PHASE2EB_GLOBAL_MAX_TRIALS,
  PHASE2EB_MIN_TRIALS,
} from "./lowRiskSandboxRegistry.js";

// ── Verdict + control types ──────────────────────────────────────────────────

/**
 * Readiness verdict per kind. `ready` is granted if and only if the registry's
 * `enabled` flag is `true` (today: `summarizationTemplate` only). Every other
 * kind lands in `blocked` (recognised disabledReason), `needs_review`
 * (unrecognised / missing disabledReason — default-refuse), or `disabled`
 * (explicit operator-off; today none).
 */
export type LowRiskSandboxReadinessStatus =
  | "ready"
  | "blocked"
  | "needs_review"
  | "disabled";

/**
 * Static safety controls a Phase 2e-b registration must explicitly assert.
 * These are echoed read-only here so a dashboard / audit consumer sees the
 * full guardrail surface alongside readiness. Phase 2h-a does not add new
 * controls — it surfaces existing ones.
 */
export interface LowRiskSandboxSafetyControls {
  /** Phase 2e-b is dry-run-ONLY. */
  dryRunOnly:                 boolean;
  /** Phase 2e-b is static-fixture-ONLY. */
  staticFixturesOnly:         boolean;
  /** No live traffic permitted. */
  noLiveTraffic:              boolean;
  /** No scheduler-driven sandbox automation. */
  noScheduler:                boolean;
  /** No mutation of hypotheses, memory, or other persisted state. */
  noMutation:                 boolean;
  /** No public output / publishing / posting. */
  noPublicOutput:             boolean;
  /** Per-call operator approval is required for any registration. */
  operatorApprovalRequired:   boolean;
  /** Max-trials cap per kind (mirrors `LowRiskSandboxKindEntry.maxTrialsCap`). */
  maxTrialsCap:               number;
  /** Global max-trials cap (mirrors `PHASE2EB_GLOBAL_MAX_TRIALS`). */
  globalMaxTrialsCap:         number;
  /** Minimum trials. Mirrors `PHASE2EB_MIN_TRIALS`. */
  minTrials:                  number;
  /**
   * Evidence + rollback requirement: every registration produces a typed
   * record with structured evidence (Phase 2e-b) and lands in the
   * sandbox_registration_records.jsonl ledger when applied via Phase 2e-c.
   * Rollback is implicit because Phase 2h-a does not enable any apply path.
   */
  evidenceRequired:           boolean;
  rollbackImplicit:           boolean;
}

export interface LowRiskSandboxKindReadiness {
  kind:                       LowRiskSandboxKind;
  description:                string;
  rationale:                  string;
  enabled:                    boolean;
  disabledReason?:            LowRiskSandboxDisabledReason;
  readiness:                  LowRiskSandboxReadinessStatus;
  /** Human-readable, stable strings. Empty array for `ready` kinds. */
  blockedReasons:             string[];
  /** Machine-readable `prerequisite_*` codes. Empty array for `ready` kinds. */
  missingPrerequisites:       string[];
  /** 1 = expand first, N = expand last. `summarizationTemplate` is 1 (already
   *  enabled); `memoryRetrievalHeuristic` is intentionally last. */
  recommendedExpansionOrder:  number;
  metricKey:                  string;
  guardrails:                 readonly string[];
  safetyControls:             LowRiskSandboxSafetyControls;
}

export interface LowRiskSandboxReadinessSummary {
  total:               number;
  enabled:             number;
  ready:               number;
  blocked:             number;
  needsReview:         number;
  disabled:            number;
  enabledKinds:        LowRiskSandboxKind[];
  /** Stable ordered list of kinds the future expansion would consider next. */
  expansionOrder:      LowRiskSandboxKind[];
}

export interface LowRiskSandboxReadinessSnapshot {
  kinds:                       LowRiskSandboxKindReadiness[];
  summary:                     LowRiskSandboxReadinessSummary;
  /** Permanent invariant strings the dashboard / API can render. */
  invariants: {
    onlySummarizationTemplateEnabled:    string;
    proposeOnly:                         string;
    defaultRefuse:                       string;
    visibilityDoesNotEnable:             string;
  };
}

// ── Operator-approved expansion order ────────────────────────────────────────
//
// Hand-curated per Phase 2h-a brief:
//   1. summarizationTemplate     — already enabled (anchor).
//   2. reasoningTemplate         — next candidate (operator-approved).
//   3. selfCritiquePrompt        — internal-only persona, narrow surface.
//   4. taskDecompositionPattern  — strategy router; bounded blast radius.
//   5. memoryRetrievalHeuristic  — LAST. Retrieval affects context selection
//                                  and downstream reasoning broadly. Even a
//                                  read-only change is the broadest of the
//                                  four — keep at the back of the queue.

const EXPANSION_ORDER: readonly LowRiskSandboxKind[] = [
  "summarizationTemplate",
  "reasoningTemplate",
  "selfCritiquePrompt",
  "taskDecompositionPattern",
  "memoryRetrievalHeuristic",
] as const;

function expansionRank(kind: LowRiskSandboxKind): number {
  const ix = EXPANSION_ORDER.indexOf(kind);
  // A kind not in EXPANSION_ORDER shouldn't happen — every registry kind is
  // in the list — but if it ever does, sort it to the back rather than 0.
  return ix === -1 ? EXPANSION_ORDER.length + 1 : ix + 1;
}

// ── Disabled-reason → prose / prerequisite mapping ───────────────────────────

/**
 * Stable mapping from `disabledReason` codes to human-readable strings and
 * `prerequisite_*` codes. Unknown / undefined reasons fall through to a
 * `needs_review` verdict (default-refuse) rather than `blocked`.
 */
const REASON_PROSE: Record<LowRiskSandboxDisabledReason, {
  blocked:       string;
  prerequisite:  string;
}> = {
  future_phase_not_wired: {
    blocked:      "no runner exists yet — future phase work required",
    prerequisite: "prerequisite_runner_module",
  },
  requires_internal_persona: {
    blocked:      "depends on an internal critique persona harness that does not exist yet",
    prerequisite: "prerequisite_internal_persona_harness",
  },
  requires_rag_pipeline: {
    blocked:      "depends on a sandbox-safe RAG read pipeline that does not exist yet",
    prerequisite: "prerequisite_sandbox_rag_pipeline",
  },
  requires_strategy_router: {
    blocked:      "depends on a task-decomposition strategy router that does not exist yet",
    prerequisite: "prerequisite_strategy_router",
  },
};

// ── Pure builders ────────────────────────────────────────────────────────────

function buildSafetyControls(entry: LowRiskSandboxKindEntry): LowRiskSandboxSafetyControls {
  return {
    dryRunOnly:                 true,
    staticFixturesOnly:         true,
    noLiveTraffic:              true,
    noScheduler:                true,
    noMutation:                 true,
    noPublicOutput:             true,
    operatorApprovalRequired:   true,
    maxTrialsCap:               entry.maxTrialsCap,
    globalMaxTrialsCap:         PHASE2EB_GLOBAL_MAX_TRIALS,
    minTrials:                  PHASE2EB_MIN_TRIALS,
    evidenceRequired:           true,
    rollbackImplicit:           true,
  };
}

function buildKindReadiness(entry: LowRiskSandboxKindEntry): LowRiskSandboxKindReadiness {
  const safetyControls = buildSafetyControls(entry);

  if (entry.enabled === true) {
    return {
      kind:                      entry.kind,
      description:               entry.description,
      rationale:                 entry.rationale,
      enabled:                   true,
      disabledReason:            entry.disabledReason,
      readiness:                 "ready",
      blockedReasons:            [],
      missingPrerequisites:      [],
      recommendedExpansionOrder: expansionRank(entry.kind),
      metricKey:                 entry.metricKey,
      guardrails:                entry.guardrails,
      safetyControls,
    };
  }

  // Disabled path. Default-refuse: an unrecognised / missing disabledReason
  // becomes `needs_review`, never `blocked` (and certainly never `ready`).
  const reason = entry.disabledReason;
  const recognised = reason !== undefined && reason in REASON_PROSE;

  if (recognised) {
    const r = REASON_PROSE[reason as LowRiskSandboxDisabledReason];
    return {
      kind:                      entry.kind,
      description:               entry.description,
      rationale:                 entry.rationale,
      enabled:                   false,
      disabledReason:            reason,
      readiness:                 "blocked",
      blockedReasons:            [r.blocked],
      missingPrerequisites:      [r.prerequisite],
      recommendedExpansionOrder: expansionRank(entry.kind),
      metricKey:                 entry.metricKey,
      guardrails:                entry.guardrails,
      safetyControls,
    };
  }

  return {
    kind:                      entry.kind,
    description:               entry.description,
    rationale:                 entry.rationale,
    enabled:                   false,
    disabledReason:            reason,
    readiness:                 "needs_review",
    blockedReasons: [
      "disabled with no recognised disabledReason — default-refuse, manual review required",
    ],
    missingPrerequisites:      ["prerequisite_unspecified"],
    recommendedExpansionOrder: expansionRank(entry.kind),
    metricKey:                 entry.metricKey,
    guardrails:                entry.guardrails,
    safetyControls,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pure read-only readiness view across the entire low-risk sandbox registry.
 * Returns one record per kind. Order matches `LOW_RISK_SANDBOX_REGISTRY`.
 */
export function listLowRiskSandboxReadiness(): LowRiskSandboxKindReadiness[] {
  return LOW_RISK_SANDBOX_REGISTRY.map(buildKindReadiness);
}

/**
 * Single-kind readiness lookup. Returns `undefined` if the kind is not in the
 * registry (preserves the registry's `unknown_kind` boundary — readiness
 * visibility does not invent kinds).
 */
export function getLowRiskSandboxReadiness(
  kind: string,
): LowRiskSandboxKindReadiness | undefined {
  const entry = LOW_RISK_SANDBOX_REGISTRY.find(e => e.kind === kind);
  if (!entry) return undefined;
  return buildKindReadiness(entry);
}

/**
 * Whether a kind is registration-eligible TODAY. This is identity-equal to
 * `entry.enabled === true` — readiness visibility deliberately does not widen
 * eligibility. A `ready` verdict is the *only* readiness state that returns
 * `true` here, and it can only be granted to a kind whose registry entry is
 * already `enabled: true`.
 *
 * Tests pin this property: visibility never makes a disabled kind eligible.
 */
export function isReadyForRegistration(kind: string): boolean {
  const r = getLowRiskSandboxReadiness(kind);
  if (!r) return false;
  if (r.readiness !== "ready") return false;
  if (r.enabled !== true) return false;
  // Belt + suspenders: re-check the registry directly so a future refactor of
  // `buildKindReadiness` cannot accidentally widen this gate.
  const entry = LOW_RISK_SANDBOX_REGISTRY.find(e => e.kind === kind);
  return entry?.enabled === true;
}

/** Aggregate counts across the readiness view. */
export function summarizeLowRiskSandboxReadiness(
  records: LowRiskSandboxKindReadiness[] = listLowRiskSandboxReadiness(),
): LowRiskSandboxReadinessSummary {
  const summary: LowRiskSandboxReadinessSummary = {
    total:          records.length,
    enabled:        0,
    ready:          0,
    blocked:        0,
    needsReview:    0,
    disabled:       0,
    enabledKinds:   [],
    expansionOrder: [],
  };

  for (const r of records) {
    if (r.enabled) {
      summary.enabled++;
      summary.enabledKinds.push(r.kind);
    }
    switch (r.readiness) {
      case "ready":        summary.ready++; break;
      case "blocked":      summary.blocked++; break;
      case "needs_review": summary.needsReview++; break;
      case "disabled":     summary.disabled++; break;
    }
  }

  summary.expansionOrder = [...records]
    .sort((a, b) => a.recommendedExpansionOrder - b.recommendedExpansionOrder)
    .map(r => r.kind);

  return summary;
}

/**
 * Whole snapshot — what the autonomy monitor / dashboard renders. Pure;
 * deterministic; safe to call on every page render.
 */
export function buildLowRiskSandboxReadinessSnapshot(): LowRiskSandboxReadinessSnapshot {
  const kinds = listLowRiskSandboxReadiness();
  return {
    kinds,
    summary: summarizeLowRiskSandboxReadiness(kinds),
    invariants: {
      onlySummarizationTemplateEnabled:
        "Only `summarizationTemplate` is enabled today. The other four operator-approved low-risk kinds remain disabled and unregisterable.",
      proposeOnly:
        "Readiness visibility is pure and read-only. It does not register, run, schedule, mutate, or publish anything.",
      defaultRefuse:
        "Any kind without a recognised disabledReason lands at `needs_review`, never `ready`. Readiness never widens eligibility beyond the registry's `enabled` flag.",
      visibilityDoesNotEnable:
        "Marking a kind as `blocked` or `needs_review` is documentation; it does not flip the registry's enablement matrix or open a code path.",
    },
  };
}

// Re-export for convenience.
export { LOW_RISK_SANDBOX_KINDS };
