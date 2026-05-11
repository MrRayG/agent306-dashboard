/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-c: PHASE 2 CLOSE-OUT READINESS REPORT (READ-ONLY / TEST-ONLY)
 *
 * Phase 2 shipped, in order:
 *
 *   - Phase 2i-a/b/c: sandbox registration evidence channel — fixture
 *     registration, history snapshot, audit export.
 *   - Phase 2j-a/b/c: meta-reflection candidate schema, live generator,
 *     advisory quality scoring.
 *   - Phase 2k-a/b/c: lessons database schema, manual approval records,
 *     read-only hypothesis lesson suggestions.
 *   - Phase 2l-a: deterministic end-to-end learning loop test harness.
 *   - Phase 2l-b: manual / test-only read-only learning loop report wrapper.
 *
 * Phase 2l-c closes Phase 2 with a single deterministic audit/readiness
 * report that:
 *
 *   - Restates every link in the Phase 2 evidence chain at a coarse summary
 *     level, by reusing the Phase 2l-b report wrapper verbatim (which in
 *     turn reuses the Phase 2l-a harness, which in turn reuses every
 *     2i/2j/2k helper). No ledger is parsed here, no scoring is
 *     re-implemented, no projection is re-derived.
 *   - Echoes a caller-injected runtime visibility snapshot at a coarse
 *     summary level so a reviewer sees runtime visibility, build info, and
 *     freshness alongside the evidence chain WITHOUT this module having to
 *     touch the wall clock, the DB, or process.env.
 *   - Lists every sandbox kind's readiness state (from the optional
 *     injected `readiness` snapshot) so a reviewer can confirm at a glance
 *     that `summarizationTemplate` remains the only enabled kind.
 *   - Surfaces an explicit Phase 3 gating checklist of preconditions that
 *     MUST hold before any Phase 3 sandbox-only trial may be considered:
 *     reversible low-risk action only, explicit kill switch & resource
 *     limits, anomaly / drift detection placeholder, rollback proof, human
 *     approval boundary, Brier / metrics clock readiness, and no public
 *     action. The checklist is observational — nothing here authorises a
 *     trial; the report records what's missing.
 *   - Produces a conservative `readinessRecommendation` from a small
 *     vocabulary: `not_ready`, `ready_for_manual_daily_testing`,
 *     `ready_for_sandbox_only_trial_candidate`. The vocabulary is closed,
 *     and the most a green report can ever say is "candidate" — it does
 *     not authorise execution of any Phase 3 behavior.
 *
 * Phase 2l-c is intentionally:
 *
 *   - TEST-ONLY / INTERNAL: there is no UI control, no API endpoint, no
 *     scheduler hook, no app-boot hook, no monitor write-side-effect, no
 *     CLI binary. The module lives under `server/experiments/` and is
 *     imported only by its test file. A future REPL script may import
 *     it but it MUST pin all inputs explicitly.
 *   - READ-ONLY / PURE: no file is opened, no JSONL is parsed, no DB is
 *     touched, no in-memory map is mutated, no env var is set, no
 *     scheduler is signalled. The report calls the existing Phase 2l-b
 *     report builder verbatim — itself read-only / pure — and shapes its
 *     output. Optional runtime visibility / readiness / risk-impact /
 *     hypothesis-context payloads are caller-injected, never built here.
 *   - PROPOSE-ONLY / SUGGESTION-ONLY: every embedded artefact carries its
 *     own propose-only / suggestion-only / advisory-only contract. The
 *     close-out report adds `observationalOnly: true` and `closeOutOnly:
 *     true` to its own invariant block and CANNOT make those false.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical injected harness
 *     inputs, identical injected metadata (run label, operator, source),
 *     identical pinned `now`, and identical injected runtime visibility /
 *     readiness payloads, the report returns a deeply-equal payload every
 *     time. Serialised output is byte-identical. There is no `Date.now`,
 *     no `Math.random`, no UUID, no env read, no wall-clock read.
 *   - CONSERVATIVE READINESS: the readiness vocabulary is closed and the
 *     mapping is one-way:
 *       safety_warning  → not_ready
 *       partial         → not_ready
 *       cold            → not_ready
 *       success         → ready_for_manual_daily_testing
 *       success + every Phase 3 gating criterion explicitly satisfied
 *                       → ready_for_sandbox_only_trial_candidate
 *     The "candidate" verdict requires every Phase 3 gating criterion to
 *     pass — by default none of them pass without an explicit caller
 *     attestation, so the default is `ready_for_manual_daily_testing` for
 *     a clean success and `not_ready` for anything else. Phase 2l-c does
 *     NOT decide whether the attestations are true; it only records them.
 *   - REUSE-FIRST: this module does not re-derive any evidence, does not
 *     re-implement any projection, does not bypass any guard. It calls
 *     `buildLearningLoopReport` verbatim and shapes its output, and it
 *     surfaces caller-injected runtime visibility verbatim.
 *   - NON-WIDENING: the report cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. `summarizationTemplate` remains the only
 *     enabled sandbox kind. Disabled kinds remain disabled — the report
 *     describes their disabled state for human review.
 *   - NO PROMOTION GATE BYPASS: the report never calls
 *     `applyRecommendation`, `canPromote`, the recommendation engine, the
 *     hypothesis creation flow, or any runtime behavior. It is an
 *     observational projection over one report run.
 *
 * Tests pin:
 *   - A seeded happy-path report maps to `readiness:
 *     "ready_for_manual_daily_testing"` with non-zero metrics, zero
 *     blockers, and an explicit Phase 3 gating checklist where every
 *     attestation is `unverified` (the default).
 *   - With every Phase 3 attestation explicitly passed in as `true`, the
 *     readiness rises to `ready_for_sandbox_only_trial_candidate` — the
 *     ceiling. Even one missing / `false` attestation drops it back to
 *     `ready_for_manual_daily_testing`.
 *   - A cold report maps to `readiness: "not_ready"` with cold blockers.
 *   - A partial report maps to `readiness: "not_ready"` with the partial
 *     blockers surfaced verbatim.
 *   - A safety-warning report maps to `readiness: "not_ready"` with the
 *     safety blockers surfaced verbatim — Phase 3 readiness cannot rise
 *     above `not_ready` when any safety invariant is tripped.
 *   - Repeated runs with identical inputs produce deeply-equal /
 *     byte-identical output.
 *   - No writes to ledger / fs / db / env / monitor state. Input objects
 *     are not mutated.
 *   - Every output carries the documented safety invariants and the
 *     verbatim safety disclaimer.
 *   - The report module is NOT imported by `server/index.ts`, by the
 *     autonomy monitor, by `applyRecommendation`, by `canPromote`, by
 *     the scheduler, or by any UI control.
 *   - `summarizationTemplate` remains the only enabled kind in every
 *     output regardless of inputs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildLearningLoopReport,
  serializeLearningLoopReport,
  type LearningLoopReport,
  type LearningLoopReportInputs,
  type LearningLoopReportStatus,
  type LearningLoopReportSignal,
} from "./learningLoopReport.js";

/** Stable schema identifier. Bumped only when the result shape changes in
 *  a backwards-incompatible way. */
export const PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION = "phase2l-c.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const PHASE2_CLOSE_OUT_REPORT_LABEL =
  "agent306.phase2_close_out_readiness_report";

/** Static, verbatim safety disclaimer block. Embedded in every report. */
export const PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER = [
  "This report is a manual / test-only observational close-out summary of",
  "the Phase 2 evidence chain (Phase 2i sandbox registration, Phase 2j",
  "meta-reflection, Phase 2k lessons, Phase 2l learning loop) and Phase 3",
  "readiness posture.",
  "It is read-only and propose-only: it does not apply lessons, does not",
  "promote hypotheses, does not enable sandbox kinds, does not authorise",
  "any Phase 3 sandbox-only trial, does not write to any database /",
  "filesystem / ledger / monitor, and is not wired to any scheduler,",
  "app-boot, UI, or API path.",
  "Every embedded artefact carries its own propose-only / suggestion-only /",
  "advisory-only contract; this report cannot widen those contracts.",
  "The most a clean run can recommend is",
  "ready_for_sandbox_only_trial_candidate — and only when every Phase 3",
  "gating criterion has an explicit caller attestation. The recommendation",
  "is observational; nothing on the Phase 3 path runs as a result of this",
  "report.",
] as const;

/** Closed vocabulary for the report's readiness recommendation. */
export type Phase2CloseOutReadiness =
  | "not_ready"
  | "ready_for_manual_daily_testing"
  | "ready_for_sandbox_only_trial_candidate";

/** Tri-state attestation for each Phase 3 gating criterion. Default is
 *  `unverified` — the report never silently treats a missing attestation
 *  as satisfied. */
export type Phase3GateAttestation = "unverified" | "satisfied" | "violated";

/** The closed set of Phase 3 gating criteria. Each one must have an
 *  explicit `satisfied` attestation from the caller before the report can
 *  recommend `ready_for_sandbox_only_trial_candidate`. The names mirror
 *  the brief and are deliberately stable so tests can assert on them. */
export type Phase3GateCriterionKey =
  | "reversibleLowRiskActionOnly"
  | "explicitKillSwitchAndResourceLimits"
  | "anomalyAndDriftDetectionPlaceholder"
  | "rollbackProof"
  | "humanApprovalBoundary"
  | "metricsClockReadiness"
  | "noPublicAction";

/** Caller-injected attestation for each Phase 3 gating criterion. Any
 *  unspecified key is treated as `unverified`. The report never decides
 *  whether the attestation is true — it only records the caller's claim
 *  and surfaces a blocker when anything is not explicitly `satisfied`. */
export type Phase3GateAttestations =
  Partial<Record<Phase3GateCriterionKey, Phase3GateAttestation>>;

/** Coarse, deterministic runtime visibility summary the caller may inject.
 *  We deliberately do NOT import the live `buildAutonomyRuntimeVisibility`
 *  here — that helper reads the wall clock, env vars, and the DB. The
 *  caller is responsible for shaping the snapshot deterministically (e.g.
 *  by constructing it in a test with pinned values). The report stores a
 *  fixed-shape projection so tests and reviewers can assert on it without
 *  pulling in the entire visibility module. */
export interface Phase2CloseOutRuntimeVisibilitySnapshot {
  /** Mirrors `RuntimeFreshness` from `autonomyRuntimeVisibility.ts`. The
   *  closed vocabulary keeps the close-out report from drifting. */
  freshness:        "running" | "stale" | "blocked" | "unknown";
  freshnessReason:  string;
  /** Caller-provided generatedAt. May be null. The report never reads
   *  the wall clock to fill this in. */
  generatedAt:      string | null;
  /** Optional commit short SHA for human eyeballs. May be null. */
  commitShortSha:   string | null;
  /** Optional environment label (e.g. "production"). May be null. */
  environment:      string | null;
  /** Optional package version string. May be null. */
  packageVersion:   string | null;
  /** Number of new-autonomy decision events in the last 24h. */
  decisionEventsLast24h:       number;
  /** Number of sandbox registration events in the last 24h. */
  sandboxRegistrationsLast24h: number;
}

/** Coarse, deterministic sandbox readiness summary the caller may inject.
 *  Mirrors `LowRiskSandboxReadinessSummary` but with field names a Phase 2
 *  reviewer expects. The caller is responsible for sourcing it from
 *  `buildLowRiskSandboxReadinessSnapshot()` (or pinning it explicitly in
 *  a test). */
export interface Phase2CloseOutSandboxReadinessSummary {
  total:        number;
  enabled:      number;
  ready:        number;
  blocked:      number;
  needsReview:  number;
  disabled:     number;
  /** Stable list of currently-enabled kinds. Phase 2 invariant: this list
   *  contains EXACTLY one entry, `summarizationTemplate`. */
  enabledKinds: readonly string[];
}

/** Coarse, deterministic risk-impact summary the caller may inject.
 *  Mirrors `RiskImpactSummary` at the summary level — the per-record
 *  breakdown stays in the source helper. */
export interface Phase2CloseOutRiskImpactSummary {
  total:           number;
  eligibleLowRisk: number;
  byDecision:      { eligible: number; needs_review: number; blocked: number };
}

/** Inputs to the close-out report wrapper. */
export interface Phase2CloseOutReportInputs {
  /** Forwarded verbatim to `buildLearningLoopReport`. Tests pin them. */
  learningLoopInputs?:    LearningLoopReportInputs;

  /** OPTIONAL injected runtime visibility snapshot. Defaults to `null`. */
  runtimeVisibility?:     Phase2CloseOutRuntimeVisibilitySnapshot;

  /** OPTIONAL injected sandbox readiness summary. Defaults to `null`. */
  sandboxReadiness?:      Phase2CloseOutSandboxReadinessSummary;

  /** OPTIONAL injected risk-impact summary. Defaults to `null`. */
  riskImpact?:            Phase2CloseOutRiskImpactSummary;

  /** OPTIONAL caller attestations for each Phase 3 gating criterion. */
  phase3Attestations?:    Phase3GateAttestations;

  /** OPTIONAL run label echoed onto the report payload. */
  runLabel?:              string;

  /** OPTIONAL operator identifier echoed onto the report payload. */
  operator?:              string;

  /** OPTIONAL source identifier echoed onto the report payload. Defaults
   *  to `"manual"`. */
  source?:                string;
}

/** A single line in the Phase 3 gating checklist. */
export interface Phase3GateCriterion {
  key:           Phase3GateCriterionKey;
  description:   string;
  attestation:   Phase3GateAttestation;
  /** True iff the attestation is `"satisfied"`. */
  satisfied:     boolean;
}

/** Aggregate over the Phase 3 gating checklist. */
export interface Phase3GateChecklistAggregate {
  total:        number;
  satisfied:    number;
  unverified:   number;
  violated:     number;
  /** True iff every criterion's attestation is `"satisfied"`. */
  allSatisfied: boolean;
}

/** Echo of the inputs at a coarse summary level — non-secret,
 *  deterministic, and never the raw evidence body. */
export interface Phase2CloseOutInputsSummary {
  learningLoopHarnessInputsProvided: boolean;
  runtimeVisibilityProvided:         boolean;
  sandboxReadinessProvided:          boolean;
  riskImpactProvided:                boolean;
  phase3AttestationsProvided:        boolean;
  runLabelProvided:                  boolean;
  operatorProvided:                  boolean;
  sourceProvided:                    boolean;
}

/** Short, machine-readable code attached to every blocker / warning so a
 *  test can assert on exact codes without string-matching prose. */
export type Phase2CloseOutSignalCode =
  | "learning_loop_blocker"
  | "learning_loop_warning"
  | "phase3_gate_unverified"
  | "phase3_gate_violated"
  | "runtime_visibility_not_running"
  | "runtime_visibility_missing"
  | "sandbox_readiness_missing"
  | "unexpected_enabled_sandbox_kinds"
  | "risk_impact_missing";

/** A blocker is something a reviewer must resolve before Phase 3 readiness
 *  can rise above `not_ready`. A warning is informational. */
export interface Phase2CloseOutSignal {
  code:    Phase2CloseOutSignalCode;
  message: string;
}

/** The full close-out report payload. */
export interface Phase2CloseOutReport {
  schemaVersion: typeof PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION;
  label:         typeof PHASE2_CLOSE_OUT_REPORT_LABEL;

  /** Caller-injected run label. `null` when none was passed. */
  runLabel:      string | null;
  /** Caller-injected operator identifier. `null` when none was passed. */
  operator:      string | null;
  /** Caller-injected source identifier. Defaults to `"manual"`. */
  source:        string;
  /** Caller-injected ISO timestamp from `harnessInputs.now`. `null` when
   *  no `now` was passed — the report NEVER reads the wall clock. */
  generatedAt:   string | null;

  /** Mirrors the underlying learning-loop report's status verbatim. */
  learningLoopStatus: LearningLoopReportStatus;
  /** Conservative readiness recommendation. Closed vocabulary. */
  readinessRecommendation: Phase2CloseOutReadiness;
  /** Human-readable rationale for the readiness recommendation. */
  readinessRationale: string;

  /** Echo of the inputs at a coarse summary level. */
  inputsSummary: Phase2CloseOutInputsSummary;

  /** Embedded Phase 2l-b learning-loop report. */
  learningLoopReport: LearningLoopReport;

  /** Caller-injected runtime visibility snapshot, or `null`. */
  runtimeVisibility:  Phase2CloseOutRuntimeVisibilitySnapshot | null;

  /** Caller-injected sandbox readiness summary, or `null`. */
  sandboxReadiness:   Phase2CloseOutSandboxReadinessSummary | null;

  /** Caller-injected risk-impact summary, or `null`. */
  riskImpact:         Phase2CloseOutRiskImpactSummary | null;

  /** Static restatement of every safety invariant from each Phase 2
   *  evidence-chain link. Aggregated `allHeld` mirrors the learning-loop
   *  report's `safety.allInvariantsHeld`. */
  safety: {
    reflectionCandidatesProposeOnly: boolean;
    qualityScoreAdvisoryOnly:        boolean;
    proposedLessonsProposeOnly:      boolean;
    approvalRecordsRuntimeInactive:  boolean;
    suggestionsSuggestionOnly:       boolean;
    allHeld:                         boolean;
  };

  /** The Phase 3 gating checklist — one entry per criterion in stable
   *  order. */
  phase3Gating: {
    criteria:  readonly Phase3GateCriterion[];
    aggregate: Phase3GateChecklistAggregate;
  };

  /** Things a reviewer must look at before Phase 3 readiness can rise
   *  above `not_ready`. */
  blockers:  readonly Phase2CloseOutSignal[];
  /** Informational signals. Never block a readiness recommendation by
   *  themselves. */
  warnings:  readonly Phase2CloseOutSignal[];

  /** Verbatim, frozen safety disclaimer block. */
  safetyDisclaimer: readonly string[];

  /** Static restatement of the read-only / propose-only / close-out-only
   *  contract. */
  invariants: {
    readOnly:                  true;
    proposeOnly:               true;
    suggestionOnly:            true;
    nonWidening:               true;
    autoApplyEligible:         false;
    publicAction:              false;
    schedulerDriven:           false;
    mutating:                  false;
    humanReviewRequired:       true;
    runtimeActionEligible:     false;
    publicActionEligible:      false;
    manualReviewedOnly:        true;
    testOnly:                  true;
    observationalOnly:         true;
    /** Close-out-only: this report cannot authorise any Phase 3 trial. */
    closeOutOnly:              true;
    /** Phase 3 is gated — this report never enables Phase 3 behaviour. */
    phase3Gated:               true;
  };
}

const FIXED_INVARIANTS = {
  readOnly:                  true,
  proposeOnly:               true,
  suggestionOnly:            true,
  nonWidening:               true,
  autoApplyEligible:         false,
  publicAction:              false,
  schedulerDriven:           false,
  mutating:                  false,
  humanReviewRequired:       true,
  runtimeActionEligible:     false,
  publicActionEligible:      false,
  manualReviewedOnly:        true,
  testOnly:                  true,
  observationalOnly:         true,
  closeOutOnly:              true,
  phase3Gated:               true,
} as const;

/** Stable order. Used in serialiser output AND in the criteria array. */
const PHASE3_CRITERIA_ORDER: readonly Phase3GateCriterionKey[] = [
  "reversibleLowRiskActionOnly",
  "explicitKillSwitchAndResourceLimits",
  "anomalyAndDriftDetectionPlaceholder",
  "rollbackProof",
  "humanApprovalBoundary",
  "metricsClockReadiness",
  "noPublicAction",
] as const;

/** Short, stable description for each gating criterion. Restated in the
 *  output so a reviewer can read the criterion without consulting the
 *  source. */
const PHASE3_CRITERIA_DESCRIPTIONS: Record<Phase3GateCriterionKey, string> = {
  reversibleLowRiskActionOnly:
    "Any Phase 3 trial must use a reversible, low-risk action only — no irreversible side effects.",
  explicitKillSwitchAndResourceLimits:
    "Any Phase 3 trial must have an explicit kill switch and explicit resource limits (time / tokens / calls).",
  anomalyAndDriftDetectionPlaceholder:
    "Any Phase 3 trial must have at least a placeholder anomaly- and drift-detection signal wired in.",
  rollbackProof:
    "Any Phase 3 trial must have a recorded rollback proof — an artefact a reviewer can replay to confirm rollback works.",
  humanApprovalBoundary:
    "Any Phase 3 trial must keep the human-approval boundary intact — no auto-apply, no scheduler-driven action.",
  metricsClockReadiness:
    "Any Phase 3 trial must have a Brier / metrics clock ready so outcomes can be scored deterministically.",
  noPublicAction:
    "Any Phase 3 trial must produce no public output — no posting, publishing, replying, or any other public-action path.",
} as const;

// ── Internal helpers ────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function buildPhase3Checklist(
  attestations: Phase3GateAttestations | undefined,
): { criteria: Phase3GateCriterion[]; aggregate: Phase3GateChecklistAggregate } {
  const criteria: Phase3GateCriterion[] = [];
  let satisfied = 0;
  let unverified = 0;
  let violated = 0;

  const provided = attestations !== undefined && attestations !== null && typeof attestations === "object";

  for (const key of PHASE3_CRITERIA_ORDER) {
    const raw = provided ? (attestations as Phase3GateAttestations)[key] : undefined;
    let att: Phase3GateAttestation = "unverified";
    if (raw === "satisfied" || raw === "violated" || raw === "unverified") {
      att = raw;
    }
    if (att === "satisfied")       satisfied++;
    else if (att === "violated")   violated++;
    else                           unverified++;

    criteria.push({
      key,
      description: PHASE3_CRITERIA_DESCRIPTIONS[key],
      attestation: att,
      satisfied:   att === "satisfied",
    });
  }

  const total = criteria.length;
  const allSatisfied = satisfied === total && violated === 0 && unverified === 0;

  return {
    criteria,
    aggregate: { total, satisfied, unverified, violated, allSatisfied },
  };
}

function buildSignals(
  learningLoopReport: LearningLoopReport,
  phase3Criteria: readonly Phase3GateCriterion[],
  runtimeVisibility: Phase2CloseOutRuntimeVisibilitySnapshot | null,
  sandboxReadiness: Phase2CloseOutSandboxReadinessSummary | null,
  riskImpact: Phase2CloseOutRiskImpactSummary | null,
): { blockers: Phase2CloseOutSignal[]; warnings: Phase2CloseOutSignal[] } {
  const blockers: Phase2CloseOutSignal[] = [];
  const warnings: Phase2CloseOutSignal[] = [];

  // Learning-loop blockers carry into close-out blockers verbatim, with a
  // wrapping code so a reviewer can see they came from the learning loop.
  for (const b of learningLoopReport.blockers) {
    blockers.push({
      code:    "learning_loop_blocker",
      message: `${b.code}: ${b.message}`,
    });
  }
  // Learning-loop warnings carry into close-out warnings verbatim.
  for (const w of learningLoopReport.warnings) {
    warnings.push({
      code:    "learning_loop_warning",
      message: `${w.code}: ${w.message}`,
    });
  }

  // Phase 3 gating — any unverified criterion is a blocker against
  // recommending the trial candidate verdict. Any violated criterion is
  // always a blocker.
  for (const c of phase3Criteria) {
    if (c.attestation === "violated") {
      blockers.push({
        code:    "phase3_gate_violated",
        message: `${c.key}: explicitly violated`,
      });
    } else if (c.attestation === "unverified") {
      blockers.push({
        code:    "phase3_gate_unverified",
        message: `${c.key}: no caller attestation`,
      });
    }
  }

  // Runtime visibility — when present and not "running", surface a
  // warning so a reviewer knows the dashboard's runtime is stale. When
  // absent, surface a separate, milder warning. Never a blocker — the
  // close-out report is observational and runtime visibility is an input,
  // not a gate.
  if (runtimeVisibility === null) {
    warnings.push({
      code:    "runtime_visibility_missing",
      message: "Runtime visibility snapshot was not injected; reviewer must confirm runtime state out-of-band",
    });
  } else if (runtimeVisibility.freshness !== "running") {
    warnings.push({
      code:    "runtime_visibility_not_running",
      message: `Runtime visibility freshness is ${runtimeVisibility.freshness}; reviewer must investigate`,
    });
  }

  // Sandbox readiness — when missing, warn. When the enabled-kinds list
  // is anything other than exactly `summarizationTemplate`, that is a
  // Phase 2 invariant violation and a hard blocker.
  if (sandboxReadiness === null) {
    warnings.push({
      code:    "sandbox_readiness_missing",
      message: "Sandbox readiness summary was not injected; reviewer must confirm summarizationTemplate is the only enabled kind out-of-band",
    });
  } else {
    const enabled = Array.isArray(sandboxReadiness.enabledKinds)
      ? [...sandboxReadiness.enabledKinds]
      : [];
    const unexpected = enabled.filter(k => k !== "summarizationTemplate");
    if (unexpected.length > 0 || enabled.length !== 1 || enabled[0] !== "summarizationTemplate") {
      blockers.push({
        code:    "unexpected_enabled_sandbox_kinds",
        message: `Phase 2 invariant: enabled kinds must be exactly ["summarizationTemplate"], got [${enabled.join(", ")}]`,
      });
    }
  }

  // Risk-impact summary — missing is a warning only. The close-out
  // report is observational; the underlying scoring helper has its own
  // tests.
  if (riskImpact === null) {
    warnings.push({
      code:    "risk_impact_missing",
      message: "Risk-impact summary was not injected; reviewer must confirm record classification out-of-band",
    });
  }

  return { blockers, warnings };
}

function deriveReadiness(
  learningLoopStatus: LearningLoopReportStatus,
  closeOutBlockers: readonly Phase2CloseOutSignal[],
  phase3AllSatisfied: boolean,
): { readiness: Phase2CloseOutReadiness; rationale: string } {
  // Safety / partial / cold all collapse to not_ready.
  if (learningLoopStatus === "safety_warning") {
    return {
      readiness: "not_ready",
      rationale: "Learning-loop reported a safety_warning — at least one Phase 2 safety invariant tripped",
    };
  }
  if (learningLoopStatus === "partial") {
    return {
      readiness: "not_ready",
      rationale: "Learning-loop reported partial — at least one Phase 2 stage produced unmatched / refused / empty output",
    };
  }
  if (learningLoopStatus === "cold") {
    return {
      readiness: "not_ready",
      rationale: "Learning-loop reported cold — no positive Phase 2 evidence was supplied",
    };
  }

  // success path: any close-out blocker outside the learning loop drops
  // us back to manual-daily-testing at best, or not_ready when sandbox
  // readiness invariant is tripped.
  const hasSandboxInvariantBlocker = closeOutBlockers.some(
    b => b.code === "unexpected_enabled_sandbox_kinds",
  );
  if (hasSandboxInvariantBlocker) {
    return {
      readiness: "not_ready",
      rationale: "Phase 2 invariant tripped: enabled sandbox kinds drifted from summarizationTemplate-only",
    };
  }

  // Phase 3 gating must be fully satisfied (all criteria explicitly
  // attested as `satisfied`) to recommend the trial candidate verdict.
  if (phase3AllSatisfied) {
    return {
      readiness: "ready_for_sandbox_only_trial_candidate",
      rationale: "Learning-loop success and every Phase 3 gating criterion is explicitly attested as satisfied; the report recommends this as a CANDIDATE for sandbox-only trial planning only — execution is still gated by human approval and out-of-band review",
    };
  }

  return {
    readiness: "ready_for_manual_daily_testing",
    rationale: "Learning-loop success but at least one Phase 3 gating criterion is unverified or violated; the report recommends continuing manual daily testing at the Phase 2l-b cadence",
  };
}

function normaliseRuntimeVisibility(
  v: Phase2CloseOutRuntimeVisibilitySnapshot | undefined,
): Phase2CloseOutRuntimeVisibilitySnapshot | null {
  if (v === undefined || v === null || typeof v !== "object") return null;
  // Stable projection — only the documented fields are kept; everything
  // else is dropped. This protects the serialiser's byte order against
  // unknown extra keys.
  const freshness =
    v.freshness === "running" ||
    v.freshness === "stale" ||
    v.freshness === "blocked" ||
    v.freshness === "unknown"
      ? v.freshness
      : "unknown";
  return {
    freshness,
    freshnessReason: typeof v.freshnessReason === "string" ? v.freshnessReason : "",
    generatedAt:     isNonEmptyString(v.generatedAt) ? v.generatedAt : null,
    commitShortSha:  isNonEmptyString(v.commitShortSha) ? v.commitShortSha : null,
    environment:     isNonEmptyString(v.environment) ? v.environment : null,
    packageVersion:  isNonEmptyString(v.packageVersion) ? v.packageVersion : null,
    decisionEventsLast24h:
      typeof v.decisionEventsLast24h === "number" && Number.isFinite(v.decisionEventsLast24h)
        ? v.decisionEventsLast24h
        : 0,
    sandboxRegistrationsLast24h:
      typeof v.sandboxRegistrationsLast24h === "number" && Number.isFinite(v.sandboxRegistrationsLast24h)
        ? v.sandboxRegistrationsLast24h
        : 0,
  };
}

function normaliseSandboxReadiness(
  s: Phase2CloseOutSandboxReadinessSummary | undefined,
): Phase2CloseOutSandboxReadinessSummary | null {
  if (s === undefined || s === null || typeof s !== "object") return null;
  const enabled = Array.isArray(s.enabledKinds)
    ? s.enabledKinds.filter(k => typeof k === "string")
    : [];
  return {
    total:        typeof s.total === "number"        && Number.isFinite(s.total)        ? s.total        : 0,
    enabled:      typeof s.enabled === "number"      && Number.isFinite(s.enabled)      ? s.enabled      : 0,
    ready:        typeof s.ready === "number"        && Number.isFinite(s.ready)        ? s.ready        : 0,
    blocked:      typeof s.blocked === "number"      && Number.isFinite(s.blocked)      ? s.blocked      : 0,
    needsReview:  typeof s.needsReview === "number"  && Number.isFinite(s.needsReview)  ? s.needsReview  : 0,
    disabled:     typeof s.disabled === "number"     && Number.isFinite(s.disabled)     ? s.disabled     : 0,
    enabledKinds: enabled,
  };
}

function normaliseRiskImpact(
  r: Phase2CloseOutRiskImpactSummary | undefined,
): Phase2CloseOutRiskImpactSummary | null {
  if (r === undefined || r === null || typeof r !== "object") return null;
  const bd = r.byDecision && typeof r.byDecision === "object" ? r.byDecision : ({} as Phase2CloseOutRiskImpactSummary["byDecision"]);
  return {
    total:           typeof r.total === "number" && Number.isFinite(r.total) ? r.total : 0,
    eligibleLowRisk: typeof r.eligibleLowRisk === "number" && Number.isFinite(r.eligibleLowRisk) ? r.eligibleLowRisk : 0,
    byDecision: {
      eligible:     typeof bd.eligible === "number"     && Number.isFinite(bd.eligible)     ? bd.eligible     : 0,
      needs_review: typeof bd.needs_review === "number" && Number.isFinite(bd.needs_review) ? bd.needs_review : 0,
      blocked:      typeof bd.blocked === "number"      && Number.isFinite(bd.blocked)      ? bd.blocked      : 0,
    },
  };
}

// ── Public report builder ───────────────────────────────────────────────────

/**
 * Build a deterministic Phase 2 close-out readiness report.
 *
 * Pure: no I/O write, no DB read/write, no env mutation/read, no scheduler
 * signal, no wall-clock read (callers MUST pin `harnessInputs.now` and pass
 * deterministic snapshots for byte-identical output).
 *
 * Programmer-shaped misuse (non-object input) throws a TypeError so a typo
 * fails loudly.
 */
export function buildPhase2CloseOutReport(
  inputs: Phase2CloseOutReportInputs = {},
): Phase2CloseOutReport {
  if (inputs === null || typeof inputs !== "object") {
    throw new TypeError("buildPhase2CloseOutReport: inputs must be an object");
  }

  const learningLoopInputs = inputs.learningLoopInputs ?? {};
  if (learningLoopInputs === null || typeof learningLoopInputs !== "object") {
    throw new TypeError("buildPhase2CloseOutReport: learningLoopInputs must be an object");
  }

  // Compose the underlying Phase 2l-b report. Metadata flows through:
  // close-out's runLabel/operator/source default to the same defaults as
  // the learning loop's wrapper when not provided directly, but we keep
  // the close-out's identity distinct from the learning-loop wrapper for
  // audit clarity.
  const runLabel = isNonEmptyString(inputs.runLabel) ? inputs.runLabel : null;
  const operator = isNonEmptyString(inputs.operator) ? inputs.operator : null;
  const source   = isNonEmptyString(inputs.source)   ? inputs.source   : "manual";

  const learningLoopReport = buildLearningLoopReport({
    runLabel: runLabel ?? undefined,
    operator: operator ?? undefined,
    source:   source,
    harnessInputs: learningLoopInputs.harnessInputs,
  });

  const runtimeVisibility = normaliseRuntimeVisibility(inputs.runtimeVisibility);
  const sandboxReadiness  = normaliseSandboxReadiness(inputs.sandboxReadiness);
  const riskImpact        = normaliseRiskImpact(inputs.riskImpact);

  const { criteria, aggregate } = buildPhase3Checklist(inputs.phase3Attestations);

  const { blockers, warnings } = buildSignals(
    learningLoopReport,
    criteria,
    runtimeVisibility,
    sandboxReadiness,
    riskImpact,
  );

  const { readiness, rationale } = deriveReadiness(
    learningLoopReport.overallStatus,
    blockers,
    aggregate.allSatisfied,
  );

  const inputsSummary: Phase2CloseOutInputsSummary = {
    learningLoopHarnessInputsProvided: learningLoopInputs.harnessInputs !== undefined,
    runtimeVisibilityProvided:         inputs.runtimeVisibility !== undefined,
    sandboxReadinessProvided:          inputs.sandboxReadiness !== undefined,
    riskImpactProvided:                inputs.riskImpact !== undefined,
    phase3AttestationsProvided:        inputs.phase3Attestations !== undefined,
    runLabelProvided:                  isNonEmptyString(inputs.runLabel),
    operatorProvided:                  isNonEmptyString(inputs.operator),
    sourceProvided:                    isNonEmptyString(inputs.source),
  };

  return {
    schemaVersion:           PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION,
    label:                   PHASE2_CLOSE_OUT_REPORT_LABEL,
    runLabel,
    operator,
    source,
    generatedAt:             learningLoopReport.generatedAt,
    learningLoopStatus:      learningLoopReport.overallStatus,
    readinessRecommendation: readiness,
    readinessRationale:      rationale,
    inputsSummary,
    learningLoopReport,
    runtimeVisibility,
    sandboxReadiness,
    riskImpact,
    safety: {
      reflectionCandidatesProposeOnly: learningLoopReport.safety.reflectionCandidatesProposeOnly,
      qualityScoreAdvisoryOnly:        learningLoopReport.safety.qualityScoreAdvisoryOnly,
      proposedLessonsProposeOnly:      learningLoopReport.safety.proposedLessonsProposeOnly,
      approvalRecordsRuntimeInactive:  learningLoopReport.safety.approvalRecordsRuntimeInactive,
      suggestionsSuggestionOnly:       learningLoopReport.safety.suggestionsSuggestionOnly,
      allHeld:                         learningLoopReport.safety.allInvariantsHeld,
    },
    phase3Gating: { criteria, aggregate },
    blockers,
    warnings,
    safetyDisclaimer:        [...PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER],
    invariants:              { ...FIXED_INVARIANTS },
  };
}

/**
 * Stable, deterministic JSON serializer for the close-out report. Walks
 * the payload with a fixed key order so the resulting string is
 * byte-identical across calls with equal inputs. The embedded
 * `learningLoopReport` is serialised via the Phase 2l-b serializer so the
 * close-out report inherits the same byte ordering for that sub-payload.
 */
export function serializePhase2CloseOutReport(
  report: Phase2CloseOutReport,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const learningLoopSummaryJson = serializeLearningLoopReport(report.learningLoopReport);

  const orderedBlockers = report.blockers.map(s => ({ code: s.code, message: s.message }));
  const orderedWarnings = report.warnings.map(s => ({ code: s.code, message: s.message }));

  const orderedCriteria = report.phase3Gating.criteria.map(c => ({
    key:         c.key,
    description: c.description,
    attestation: c.attestation,
    satisfied:   c.satisfied,
  }));

  const ordered = {
    schemaVersion:           report.schemaVersion,
    label:                   report.label,
    runLabel:                report.runLabel,
    operator:                report.operator,
    source:                  report.source,
    generatedAt:             report.generatedAt,
    learningLoopStatus:      report.learningLoopStatus,
    readinessRecommendation: report.readinessRecommendation,
    readinessRationale:      report.readinessRationale,
    inputsSummary: {
      learningLoopHarnessInputsProvided: report.inputsSummary.learningLoopHarnessInputsProvided,
      runtimeVisibilityProvided:         report.inputsSummary.runtimeVisibilityProvided,
      sandboxReadinessProvided:          report.inputsSummary.sandboxReadinessProvided,
      riskImpactProvided:                report.inputsSummary.riskImpactProvided,
      phase3AttestationsProvided:        report.inputsSummary.phase3AttestationsProvided,
      runLabelProvided:                  report.inputsSummary.runLabelProvided,
      operatorProvided:                  report.inputsSummary.operatorProvided,
      sourceProvided:                    report.inputsSummary.sourceProvided,
    },
    runtimeVisibility: report.runtimeVisibility === null ? null : {
      freshness:                    report.runtimeVisibility.freshness,
      freshnessReason:              report.runtimeVisibility.freshnessReason,
      generatedAt:                  report.runtimeVisibility.generatedAt,
      commitShortSha:               report.runtimeVisibility.commitShortSha,
      environment:                  report.runtimeVisibility.environment,
      packageVersion:               report.runtimeVisibility.packageVersion,
      decisionEventsLast24h:        report.runtimeVisibility.decisionEventsLast24h,
      sandboxRegistrationsLast24h:  report.runtimeVisibility.sandboxRegistrationsLast24h,
    },
    sandboxReadiness: report.sandboxReadiness === null ? null : {
      total:        report.sandboxReadiness.total,
      enabled:      report.sandboxReadiness.enabled,
      ready:        report.sandboxReadiness.ready,
      blocked:      report.sandboxReadiness.blocked,
      needsReview:  report.sandboxReadiness.needsReview,
      disabled:     report.sandboxReadiness.disabled,
      enabledKinds: [...report.sandboxReadiness.enabledKinds],
    },
    riskImpact: report.riskImpact === null ? null : {
      total:           report.riskImpact.total,
      eligibleLowRisk: report.riskImpact.eligibleLowRisk,
      byDecision: {
        eligible:     report.riskImpact.byDecision.eligible,
        needs_review: report.riskImpact.byDecision.needs_review,
        blocked:      report.riskImpact.byDecision.blocked,
      },
    },
    safety: {
      reflectionCandidatesProposeOnly: report.safety.reflectionCandidatesProposeOnly,
      qualityScoreAdvisoryOnly:        report.safety.qualityScoreAdvisoryOnly,
      proposedLessonsProposeOnly:      report.safety.proposedLessonsProposeOnly,
      approvalRecordsRuntimeInactive:  report.safety.approvalRecordsRuntimeInactive,
      suggestionsSuggestionOnly:       report.safety.suggestionsSuggestionOnly,
      allHeld:                         report.safety.allHeld,
    },
    phase3Gating: {
      criteria:  orderedCriteria,
      aggregate: {
        total:        report.phase3Gating.aggregate.total,
        satisfied:    report.phase3Gating.aggregate.satisfied,
        unverified:   report.phase3Gating.aggregate.unverified,
        violated:     report.phase3Gating.aggregate.violated,
        allSatisfied: report.phase3Gating.aggregate.allSatisfied,
      },
    },
    blockers:         orderedBlockers,
    warnings:         orderedWarnings,
    safetyDisclaimer: [...report.safetyDisclaimer],
    learningLoopSummary: JSON.parse(learningLoopSummaryJson),
    invariants: {
      readOnly:                  report.invariants.readOnly,
      proposeOnly:               report.invariants.proposeOnly,
      suggestionOnly:            report.invariants.suggestionOnly,
      nonWidening:               report.invariants.nonWidening,
      autoApplyEligible:         report.invariants.autoApplyEligible,
      publicAction:              report.invariants.publicAction,
      schedulerDriven:           report.invariants.schedulerDriven,
      mutating:                  report.invariants.mutating,
      humanReviewRequired:       report.invariants.humanReviewRequired,
      runtimeActionEligible:     report.invariants.runtimeActionEligible,
      publicActionEligible:      report.invariants.publicActionEligible,
      manualReviewedOnly:        report.invariants.manualReviewedOnly,
      testOnly:                  report.invariants.testOnly,
      observationalOnly:         report.invariants.observationalOnly,
      closeOutOnly:              report.invariants.closeOutOnly,
      phase3Gated:               report.invariants.phase3Gated,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}

// Re-export the embedded report's signal type for convenience.
export type { LearningLoopReportSignal as Phase2CloseOutLearningLoopSignal };
