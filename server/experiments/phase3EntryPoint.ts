/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2n-b: PHASE 3a ENTRY-POINT CONSTANT (READ-ONLY / DECLARATIVE)
 *
 * One canonical anchor for what crossing the Phase 2 → Phase 3a boundary
 * means. This file is INTENTIONALLY tiny, declarative, and inert: it ships
 * the contract for Phase 3a entry as a frozen TypeScript value so every
 * subsequent Phase 3a / 3b / 3c PR can reference it without re-deriving
 * the gating semantics.
 *
 * This file does NOT:
 *   - Enable, register, schedule, dispatch, or authorise any Phase 3 trial.
 *   - Define any execution path, dry-run, or sandbox handler.
 *   - Set any feature flag, env var, or scheduler hook.
 *   - Import the scheduler, autonomy monitor, applyRecommendation,
 *     promotion gate, hypothesis action gate, or selfRecommendation
 *     engine.
 *   - Touch any file, database, ledger, env var, monitor, or in-memory
 *     map.
 *   - Read the wall clock, the random source, or `process.env`.
 *
 * Crossing the Phase 3a boundary requires, at minimum, every condition
 * pinned below. Any future Phase 3a code that intends to enable
 * execution MUST import this constant and assert against it; the
 * boundary regression tests in Phase 2n-c will pin those imports.
 *
 * Until a Phase 3a PR explicitly wires execution and a human approval
 * checkpoint, this file is a documentation + structural anchor only —
 * importing it confers no authority.
 *
 * Naming: `phase3a.v2` is the current schema version. Any change to the
 * boundary contract (criteria added/removed, kind widened, etc.)
 * REQUIRES bumping this version and updating every dependent
 * assertion. Silent edits are a contract drift and the boundary
 * regression tests in Phase 2n-c will fail loudly.
 *
 * Version history:
 *   - phase3a.v1: initial declarative anchor (Phase 2n-b).
 *   - phase3a.v2: Track A / Phase 3a-prep-b. Adds
 *     `server/experiments/phase3aPrepHarness.ts` (the per-precondition
 *     attestation schema) to `PHASE3_NEVER_AUTHORIZED_BY`. Criteria
 *     list, entry kind, and boundary contract are UNCHANGED — the bump
 *     reflects only a widened negative-space declaration.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { Phase3GateCriterionKey } from "./phase2CloseOutReport.js";

/** Schema version for the Phase 3a entry-point contract. Bump on any
 *  change to the criteria list, the entry kind, or the boundary
 *  contract. */
export const PHASE3_ENTRY_POINT_VERSION = "phase3a.v2" as const;

/** Human-readable label for the entry point. Stable across patch
 *  revisions; only changes when the schema version bumps. */
export const PHASE3_ENTRY_POINT_LABEL =
  "Phase 3a sandbox-only trial candidate entry point (human-approval-gated)" as const;

/** The single sandbox kind that may cross the Phase 3a boundary. Matches
 *  the Phase 2 invariant that `summarizationTemplate` is the only enabled
 *  low-risk sandbox kind. Widening this constant requires a schema
 *  version bump AND a new sandbox registration record. */
export const PHASE3_ENTRY_KIND = "summarizationTemplate" as const;

/** Ordered, frozen list of the seven Phase 3 gating criteria. Must match
 *  `PHASE3_CRITERIA_ORDER` in `phase2CloseOutReport.ts` exactly — the
 *  Phase 2n-c regression tests pin this. Adding a criterion requires a
 *  schema version bump. */
export const PHASE3_ENTRY_PRECONDITIONS: readonly Phase3GateCriterionKey[] =
  Object.freeze([
    "reversibleLowRiskActionOnly",
    "explicitKillSwitchAndResourceLimits",
    "anomalyAndDriftDetectionPlaceholder",
    "rollbackProof",
    "humanApprovalBoundary",
    "metricsClockReadiness",
    "noPublicAction",
  ] as const);

/** Fixed boundary contract. Every flag here is a property of Phase 3a
 *  that future Phase 3 code MUST preserve. Tests in Phase 2n-c will
 *  assert these stay literal `true` / `false`. */
export const PHASE3_BOUNDARY_CONTRACT = Object.freeze({
  /** Phase 3a trials may only use reversible, low-risk actions. */
  reversibleOnly:           true,
  /** Phase 3a trials require an explicit kill switch wired in. */
  killSwitchRequired:       true,
  /** Phase 3a trials require explicit resource limits
   *  (time / tokens / calls). */
  resourceLimitsRequired:   true,
  /** Phase 3a trials require at least a placeholder anomaly + drift
   *  detection signal. */
  anomalyDetectionRequired: true,
  /** Phase 3a trials require a recorded rollback proof artefact a
   *  reviewer can replay. */
  rollbackProofRequired:    true,
  /** Phase 3a trials require human approval at the boundary. No
   *  auto-apply path crosses Phase 3a. */
  humanApprovalRequired:    true,
  /** Phase 3a trials require a Brier / metrics clock to be ready so
   *  outcomes can be scored deterministically. */
  metricsClockRequired:     true,
  /** Phase 3a trials produce no public action — no posting, publishing,
   *  replying, or any other public-surface path. */
  noPublicAction:           true,
  /** Phase 3a trials are NOT scheduler-driven. The scheduler / autonomy
   *  monitor / cron does NOT enqueue Phase 3a runs. */
  schedulerDriven:          false,
  /** Phase 3a trials are NOT auto-apply eligible. */
  autoApplyEligible:        false,
  /** Phase 3a trials are NOT public-action eligible. */
  publicActionEligible:     false,
  /** Phase 3a trials are NOT runtime-action eligible (no live runtime
   *  side effect outside the sandbox). */
  runtimeActionEligible:    false,
  /** Phase 3a trials are sandbox-only — they never run on the live
   *  agent's production-equivalent path. */
  sandboxOnly:              true,
} as const);

/** Artefacts that, by themselves, can NEVER authorise crossing the
 *  Phase 3a boundary. Each entry is a workspace-relative path or
 *  symbol; the Phase 2n-c regression tests will assert that each path
 *  actually exists in the repo so a rename breaks loudly rather than
 *  silently losing meaning.
 *
 *  This list is the explicit negative-space declaration: even when
 *  every artefact below recommends the candidate verdict, Phase 3a
 *  execution remains gated by an out-of-band human approval. */
export const PHASE3_NEVER_AUTHORIZED_BY: readonly string[] = Object.freeze([
  // Phase 2l-c close-out report — observational / read-only.
  "server/experiments/phase2CloseOutReport.ts",
  // Phase 2l-b learning loop report — observational / read-only.
  "server/experiments/learningLoopReport.ts",
  // Phase 2l-d manual learning loop CLI — propose-only / stdout-only.
  "scripts/runManualLearningLoopReport.ts",
  // Phase 2n-a manual close-out CLI — propose-only / stdout-only.
  "scripts/runManualPhase2CloseOutReport.ts",
  // Phase 2m-e manual safety-gating validation CLI — propose-only.
  "scripts/runManualSafetyGatingValidationSummary.ts",
  // Track A / Phase 3a-prep-b — per-precondition attestation harness.
  // Declarative-only / zero-authority. Importing this module records
  // an attestation schema but confers no Phase 3a execution authority.
  "server/experiments/phase3aPrepHarness.ts",
] as const);

/** Set of import paths that MUST NOT appear in any Phase 3a
 *  enablement code. Used by Phase 2n-c boundary regression tests. */
export const PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS: readonly string[] = Object.freeze([
  "../scheduler.js",
  "../autonomyMonitor.js",
  "../applyRecommendation.js",
  "../promotionGate.js",
  "./hypothesisActionGate.js",
  "./selfRecommendationEngine.js",
] as const);

/** Aggregated frozen entry-point object. Every dependent test and
 *  every future Phase 3a PR should import THIS, not the individual
 *  constants, so a schema bump is a single-symbol change. */
export const PHASE3_ENTRY_POINT = Object.freeze({
  version:                     PHASE3_ENTRY_POINT_VERSION,
  label:                       PHASE3_ENTRY_POINT_LABEL,
  kind:                        PHASE3_ENTRY_KIND,
  preconditions:               PHASE3_ENTRY_PRECONDITIONS,
  contract:                    PHASE3_BOUNDARY_CONTRACT,
  neverAuthorizedBy:           PHASE3_NEVER_AUTHORIZED_BY,
  forbiddenEnablementImports:  PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS,
} as const);

/** Stable type alias re-exported so dependent code can spell the
 *  precondition key vocabulary without reaching back into Phase 2l-c
 *  directly. */
export type Phase3EntryPrecondition = Phase3GateCriterionKey;

/** Type of the aggregated entry-point constant. Dependent code that
 *  accepts a Phase 3a entry-point object should accept this type so a
 *  future variant (e.g. `phase3a.v2`) is a type-level breaking
 *  change. */
export type Phase3EntryPoint = typeof PHASE3_ENTRY_POINT;
