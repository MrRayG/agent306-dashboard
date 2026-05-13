/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — TRACK A / PHASE 3a-PREP HARNESS (READ-ONLY / DECLARATIVE)
 *
 * Per-precondition attestation schema for Phase 3a candidate trials. This
 * file is the forward-facing partner of `phase3EntryPoint.ts`:
 *
 *   - `phase3EntryPoint.ts` declares WHAT the Phase 3a boundary IS — the
 *     seven preconditions, the boundary contract, the never-authorising
 *     artefact list.
 *
 *   - `phase3aPrepHarness.ts` (this file) declares HOW a candidate Phase 3a
 *     trial CLAIMS each precondition is met — per-precondition, per-tier
 *     attestations with an `evidenceRef` the reviewer (human or future
 *     verifier module) follows to validate the claim.
 *
 * This file is INTENTIONALLY tiny, declarative, and inert. It ships the
 * schema as a frozen TypeScript value plus a single pure helper that
 * computes a readiness verdict over a caller-shaped candidate.
 *
 * This file does NOT:
 *   - Enable, register, schedule, dispatch, or authorise any Phase 3 trial.
 *   - Define any execution path, dry-run, or sandbox handler.
 *   - Set any feature flag, env var, or scheduler hook.
 *   - Import the scheduler, autonomy monitor, applyRecommendation,
 *     promotion gate, hypothesis action gate, selfRecommendation engine,
 *     or the Phase 3a entry-point module.
 *   - Touch any file, database, ledger, env var, monitor, or in-memory
 *     map.
 *   - Read the wall clock, the random source, or `process.env`.
 *
 * The harness exposes a closed two-tier vocabulary per precondition:
 *
 *   - `priority: "high"`  — required-to-enter Phase 3a. A candidate whose
 *                            high-tier attestation for any of the seven
 *                            preconditions is not literally `"satisfied"`
 *                            CANNOT cross the Phase 3a boundary.
 *
 *   - `priority: "low"`   — required-to-be-fully-prepared. A candidate
 *                            whose high-tier is fully satisfied but whose
 *                            low-tier is incomplete is `"high_tier_ready"`
 *                            but not `"fully_prepared"`.
 *
 * Both tiers ship from the start (per user spec). Adding a tier or a
 * status value REQUIRES a schema version bump.
 *
 * Naming: `phase3aPrep.v1` is this harness's own schema version. It is
 * INDEPENDENT of `phase3EntryPoint.ts`'s entry-point schema version
 * (currently the third revision). The two are version-paired by the
 * Phase 2n-c regression suite (key-order parity) but can evolve
 * independently as long as the key order stays in lock-step.
 *
 * Authority: this file IS in `phase3EntryPoint.ts`'s
 * `PHASE3_NEVER_AUTHORIZED_BY` list (added in Phase 3a-prep-b alongside
 * the entry-point schema bump to the second revision). The list is
 * the explicit negative-space declaration: even with this harness
 * recording a `"fully_prepared"` verdict, Phase 3a execution remains
 * gated by an out-of-band human approval. Importing this module records
 * an attestation schema but confers no Phase 3a execution authority.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Phase3GateCriterionKey } from "./phase2CloseOutReport.js";

/** Schema version for the Phase 3a-prep harness. Bump on any change to
 *  the precondition vocabulary, the priority tiers, the attestation
 *  status set, or the verdict semantics. */
export const PHASE3A_PREP_HARNESS_VERSION = "phase3aPrep.v1" as const;

/** Human-readable label. Stable across patch revisions; only changes
 *  when the schema version bumps. */
export const PHASE3A_PREP_HARNESS_LABEL =
  "Phase 3a candidate trial precondition attestation harness (declarative-only, no authority)" as const;

/** Closed priority vocabulary. `high` is required-to-enter Phase 3a;
 *  `low` is required-to-be-fully-prepared. The vocabulary is closed —
 *  adding a tier requires a schema version bump. */
export type PreconditionPriority = "high" | "low";

/** Ordered, frozen list of the two priority tiers. Order is significant:
 *  `high` is evaluated first for the readiness verdict, `low` second. */
export const PHASE3A_PREP_PRIORITY_TIERS: readonly PreconditionPriority[] =
  Object.freeze(["high", "low"] as const);

/** Closed attestation status vocabulary. Deliberately mirrors the
 *  Phase 2l-c `Phase3GateAttestation` 3-state enum so a candidate's
 *  high-tier attestation can be lifted directly into a close-out report
 *  without translation. Adding a status REQUIRES a schema version bump. */
export type PreconditionAttestationStatus =
  | "unverified"
  | "satisfied"
  | "violated";

/** Re-exported precondition key vocabulary. Dependent code should spell
 *  the keys via this type rather than the close-out report's type
 *  directly. */
export type Phase3aPrepPreconditionKey = Phase3GateCriterionKey;

/** Ordered, frozen list of the seven preconditions in the canonical
 *  order. MUST match `PHASE3_ENTRY_PRECONDITIONS` in
 *  `phase3EntryPoint.ts` exactly. The Phase 2n-c boundary regression
 *  suite pins this parity in `phase3BoundaryRegression.test.ts` Pin 11.
 *
 *  We deliberately re-declare the array here (rather than importing
 *  from `phase3EntryPoint.ts`) so this module does NOT pull in the
 *  Phase 3a entry-point constant — that constant is structurally
 *  isolated from the rest of `server/` by Pin 4 of the boundary
 *  regression suite. Re-declaration is the price of that isolation;
 *  the regression test enforces deep-equality between the two arrays. */
export const PHASE3A_PREP_PRECONDITION_KEYS: readonly Phase3aPrepPreconditionKey[] =
  Object.freeze([
    "reversibleLowRiskActionOnly",
    "explicitKillSwitchAndResourceLimits",
    "anomalyAndDriftDetectionPlaceholder",
    "rollbackProof",
    "humanApprovalBoundary",
    "metricsClockReadiness",
    "noPublicAction",
  ] as const);

/** A single per-precondition / per-tier attestation supplied by a
 *  candidate Phase 3a trial. Every field is caller-supplied; the
 *  harness never opens, fetches, or validates `evidenceRef` — it only
 *  records the claim. Validation is a reviewer (human or a future
 *  verifier module) concern. */
export interface Phase3aPreconditionAttestation {
  /** Which of the seven preconditions this attestation covers. */
  readonly key:          Phase3aPrepPreconditionKey;
  /** Which tier this attestation covers (`high` or `low`). */
  readonly priority:     PreconditionPriority;
  /** The caller's claim about the precondition's state. The harness
   *  never decides this — it only records and propagates it. */
  readonly status:       PreconditionAttestationStatus;
  /** Free-form workspace-relative path or symbol the reviewer follows
   *  to confirm the claim. Examples:
   *    - "data/sandbox_registration_records.jsonl#rollback-proof-12"
   *    - "server/experiments/phase3aHumanApprovalCheckpoint.ts"
   *    - "server/brierMetricsClock.ts#isReady"
   *  An empty string is permitted but flagged by the verdict helper
   *  for any non-`unverified` status. */
  readonly evidenceRef:  string;
  /** Short caller-supplied explanation of the claim. Free-form. */
  readonly rationale:    string;
}

/** A candidate Phase 3a trial's full attestation set: 7 preconditions
 *  × 2 tiers = 14 attestation slots. Both tiers ship from the start
 *  (per user spec); a candidate with any slot missing is `not_ready`.
 *
 *  Shape: a frozen 7-entry map keyed by precondition, each entry
 *  carries a `{ high, low }` pair. Using a map (rather than a flat
 *  array) makes the verdict helper deterministic and lookup-cheap
 *  while keeping JSON serialisation stable. */
export type Phase3aPrepCandidatePreconditions = Readonly<
  Record<
    Phase3aPrepPreconditionKey,
    Readonly<Record<PreconditionPriority, Phase3aPreconditionAttestation>>
  >
>;

/** A candidate Phase 3a trial bundle the harness scores. The candidate
 *  itself is caller-supplied; the harness only reads it. */
export interface Phase3aPrepCandidate {
  /** Stable identifier for the candidate. Free-form caller string. */
  readonly candidateId:   string;
  /** Sandbox kind. MUST equal `PHASE3_ENTRY_KIND` (i.e. the literal
   *  string `"summarizationTemplate"`) for the candidate to be
   *  high-tier ready — the verdict helper checks this and emits a
   *  blocker if it drifts. We re-declare the literal here for the
   *  same isolation reason as the precondition-key array. */
  readonly kind:          "summarizationTemplate";
  /** The 7 × 2 attestation matrix. */
  readonly preconditions: Phase3aPrepCandidatePreconditions;
}

/** Closed verdict vocabulary. Adding a verdict value REQUIRES a schema
 *  version bump. */
export type Phase3aPrepVerdict =
  | "not_ready"
  | "high_tier_ready"
  | "fully_prepared";

/** Output of the readiness helper. Pure projection of the candidate. */
export interface Phase3aPrepReadiness {
  /** True iff every `priority: "high"` attestation has
   *  `status === "satisfied"` AND `evidenceRef` is non-empty AND the
   *  candidate's `kind` equals the Phase 3a entry kind. */
  readonly highTierAllSatisfied:  boolean;
  /** True iff every `priority: "low"`  attestation has
   *  `status === "satisfied"` AND `evidenceRef` is non-empty. */
  readonly lowTierAllSatisfied:   boolean;
  /** Aggregated verdict.  */
  readonly verdict:               Phase3aPrepVerdict;
  /** Ordered, human-readable list of every reason the candidate failed
   *  to be `fully_prepared`. Empty iff `verdict === "fully_prepared"`. */
  readonly blockers:              readonly string[];
}

/** The single literal sandbox kind a Phase 3a candidate may declare.
 *  Mirrors `PHASE3_ENTRY_KIND` in `phase3EntryPoint.ts`. The boundary
 *  regression suite (Pin 11) pins parity. */
const PHASE3A_PREP_REQUIRED_KIND = "summarizationTemplate" as const;

/**
 * Compute a readiness verdict over a candidate Phase 3a trial. Pure
 * function: same input → same output, no side effects, no clock reads,
 * no env reads, no fs / db access.
 *
 * The function NEVER decides whether an `evidenceRef` is real — it
 * only checks that the caller supplied one (non-empty string) when the
 * claim is `"satisfied"` or `"violated"`. Resolving the reference is a
 * reviewer concern.
 */
export function computePhase3aPrepReadiness(
  candidate: Phase3aPrepCandidate,
): Phase3aPrepReadiness {
  const blockers: string[] = [];

  // ── Gate 0: sandbox-kind parity ──────────────────────────────────
  if (candidate.kind !== PHASE3A_PREP_REQUIRED_KIND) {
    blockers.push(
      `candidate.kind '${candidate.kind}' does not match the only Phase 3a-eligible kind '${PHASE3A_PREP_REQUIRED_KIND}'`,
    );
  }

  // ── Gate 1: every precondition has both tiers ────────────────────
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    const entry = candidate.preconditions[key];
    if (!entry) {
      blockers.push(`precondition '${key}' is missing both tiers`);
      continue;
    }
    for (const tier of PHASE3A_PREP_PRIORITY_TIERS) {
      const att = entry[tier];
      if (!att) {
        blockers.push(`precondition '${key}' missing '${tier}'-priority attestation`);
        continue;
      }
      // Defensive key/priority echo check — catches caller shuffling.
      if (att.key !== key) {
        blockers.push(
          `precondition '${key}' '${tier}'-attestation has mismatched key '${att.key}'`,
        );
      }
      if (att.priority !== tier) {
        blockers.push(
          `precondition '${key}' '${tier}'-attestation has mismatched priority '${att.priority}'`,
        );
      }
    }
  }

  // ── Gate 2: high-tier satisfaction (required to enter Phase 3a) ──
  let highTierAllSatisfied = blockers.length === 0;
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    const att = candidate.preconditions[key]?.high;
    if (!att) {
      highTierAllSatisfied = false;
      // already pushed missing-tier blocker above
      continue;
    }
    if (att.status !== "satisfied") {
      highTierAllSatisfied = false;
      blockers.push(
        `high-tier precondition '${key}' is '${att.status}' (must be 'satisfied' to enter Phase 3a)`,
      );
    }
    if (att.status === "satisfied" && att.evidenceRef.length === 0) {
      highTierAllSatisfied = false;
      blockers.push(
        `high-tier precondition '${key}' is 'satisfied' but has empty evidenceRef`,
      );
    }
  }

  // ── Gate 3: low-tier satisfaction (required to be fully prepared) ─
  let lowTierAllSatisfied = true;
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    const att = candidate.preconditions[key]?.low;
    if (!att) {
      lowTierAllSatisfied = false;
      continue;
    }
    if (att.status !== "satisfied") {
      lowTierAllSatisfied = false;
      blockers.push(
        `low-tier precondition '${key}' is '${att.status}' (must be 'satisfied' to be fully prepared)`,
      );
    }
    if (att.status === "satisfied" && att.evidenceRef.length === 0) {
      lowTierAllSatisfied = false;
      blockers.push(
        `low-tier precondition '${key}' is 'satisfied' but has empty evidenceRef`,
      );
    }
  }

  let verdict: Phase3aPrepVerdict;
  if (highTierAllSatisfied && lowTierAllSatisfied) {
    verdict = "fully_prepared";
  } else if (highTierAllSatisfied) {
    verdict = "high_tier_ready";
  } else {
    verdict = "not_ready";
  }

  return Object.freeze({
    highTierAllSatisfied,
    lowTierAllSatisfied,
    verdict,
    blockers: Object.freeze(blockers.slice()),
  });
}

/** Aggregated frozen harness object. Every dependent test and every
 *  future Phase 3a-prep PR should import THIS, not the individual
 *  constants, so a schema bump is a single-symbol change. */
export const PHASE3A_PREP_HARNESS = Object.freeze({
  version:           PHASE3A_PREP_HARNESS_VERSION,
  label:             PHASE3A_PREP_HARNESS_LABEL,
  preconditionKeys:  PHASE3A_PREP_PRECONDITION_KEYS,
  priorityTiers:     PHASE3A_PREP_PRIORITY_TIERS,
  computeReadiness:  computePhase3aPrepReadiness,
} as const);

/** Type of the aggregated harness constant. Dependent code that
 *  accepts a Phase 3a-prep harness should accept this type so a
 *  future variant (e.g. `phase3aPrep.v2`) is a type-level breaking
 *  change. */
export type Phase3aPrepHarness = typeof PHASE3A_PREP_HARNESS;
