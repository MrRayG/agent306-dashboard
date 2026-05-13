/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PROMOTION GATE AUTHORITY VISIBILITY (READ-ONLY / NATURAL-LANGUAGE)
 *
 * Read-only projection of the promotion-gate authority surface for the
 * Agent 306 Autonomy Monitor. Renders the current Phase 4 authority state
 * in plain English so an operator can understand at a glance which
 * recommendation classes are advisory, soft-warning, or hard-blocked by
 * the operator-gated phase3aPrep readiness signal.
 *
 * What this module is
 * ───────────────────
 *   - VISIBILITY ONLY. The snapshot is consumed by the autonomy monitor
 *     UI tile and the `/api/autonomy/monitor` JSON endpoint. There is no
 *     control surface, no mutation endpoint, no scheduler hook.
 *   - CONFIG-DERIVED. The natural-language verdicts are computed from
 *     two env flags (`PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY`,
 *     `PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY`) plus
 *     well-known invariants. The snapshot NEVER reads the database, the
 *     ledgers, or any recommendation row.
 *   - NON-AUTHORITATIVE. Reading or rendering this snapshot does NOT
 *     change `canPromote(rec).ok`, does NOT mutate any recommendation
 *     status, and does NOT register, promote, or apply anything. Pin 7
 *     and Pin 11 are preserved by construction — this module never
 *     imports or calls `applyRecommendation`, the promotion gate, or
 *     the recommendation engine.
 *   - LIGHTWEIGHT. Every helper is pure with respect to process state:
 *     no fs I/O on the request path, no DB round-trips, no audit
 *     enumeration of the server tree. The full Phase 2m-b boundary
 *     audit (`auditPromotionBoundary`) is intentionally NOT invoked
 *     per-request — it scans ~200 source files and is more suited to
 *     a manual CLI run (`scripts/auditPromotionBoundary.ts`). This
 *     module surfaces a minimal static reference to that audit so an
 *     operator can see "an audit exists, here is its identity, run it
 *     out-of-band to verify drift" without paying the audit cost on
 *     every dashboard refresh.
 *
 * What this module is NOT
 * ───────────────────────
 *   - Not a new authority signal. The single authoritative authorisation
 *     boundary remains `canPromote(rec).ok`. This module reflects that
 *     boundary's current operator-gated configuration; it never widens
 *     or narrows it.
 *   - Not a Phase 4-c / 4-d extension. The natural-language messages
 *     deliberately call out medium-risk and high-risk classes as
 *     UNAFFECTED by the Phase 4-b low-risk hard block. Future phases
 *     that change that posture must update this module in lock-step.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  readPhase3aPrepReadyRequiredFlag,
  readPhase3aPrepBlockLowRiskFlag,
} from "./eval/promotionGate.js";
import {
  PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION,
  PROMOTION_BOUNDARY_AUDIT_LABEL,
  PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
  PROMOTION_BOUNDARY_AUDIT_METRIC_KEY,
} from "./eval/promotionBoundaryAudit.js";

/** Stable schema identifier for the snapshot payload. Bumped only when
 *  the result shape changes in a backwards-incompatible way. */
export const PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION =
  "phase4-visibility.v1";

/** Stable label embedded so an operator can confirm provenance. */
export const PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL =
  "agent306.promotion_gate_authority_visibility";

/** Coarse authority level. Ordered from least to most restrictive. */
export type PromotionGateAuthorityLevel =
  /** Default. Neither Phase 4 operator flag is on. The gate behaves as
   *  it has historically: golden-set policy for medium/high risk,
   *  propose-only telemetry for low risk. */
  | "advisory_only"
  /** Phase 4-a soft warning is enabled. Advisory text surfaces alongside
   *  attestations when phase3aPrep readiness is not `fully_prepared`,
   *  but `gate.ok` is unaffected — no promotion is blocked by this
   *  warning. */
  | "soft_warning_enabled"
  /** Phase 4-b low-risk hard block is enabled. Low-risk promotions are
   *  authoritatively blocked when phase3aPrep readiness is missing,
   *  parse_error, or not `fully_prepared`. Medium-risk and high-risk
   *  promotions follow their existing golden-set and override policy
   *  — they are NOT affected by this flag. */
  | "low_risk_hard_block_enabled"
  /** Both Phase 4-a and Phase 4-b are enabled simultaneously. Behaves
   *  as the union of the two: low-risk is hard-blocked AND advisory
   *  soft warnings surface on the attestation channel. */
  | "soft_warning_and_low_risk_hard_block_enabled";

/** Per-flag rendered state. */
export interface PromotionGateAuthorityFlag {
  /** Raw env-var name for traceability (secondary display). */
  envVar:        string;
  /** Whether the operator has opted in (`process.env[envVar] === "true"`,
   *  case-insensitive). */
  enabled:       boolean;
  /** Phase identifier ("phase4-a" / "phase4-b") for the operator. */
  phase:         "phase4-a" | "phase4-b";
  /** Natural-language description of what this flag controls today. */
  description:   string;
  /** Natural-language statement of the flag's CURRENT effect (enabled vs
   *  default-off). */
  currentEffect: string;
  /** What changes when this flag flips. Helps the operator reason about
   *  drift. */
  changeOnEnable: string;
}

/** Per-risk-class natural-language verdict. */
export interface PromotionGateRiskClassVerdict {
  riskClass:   "low" | "medium" | "high";
  /** One-sentence English description of the current promotion posture
   *  for this risk class. */
  posture:     string;
  /** Whether Phase 4-b is currently authoritatively blocking promotions
   *  in this class (only ever `true` for low-risk + flag on). */
  hardBlocked: boolean;
  /** Whether Phase 4-a is currently surfacing soft warnings for this
   *  class (only ever `true` for low-risk + flag on). */
  softWarned:  boolean;
}

/** Reference to the deterministic Phase 2m-b audit. Surfaced for
 *  provenance — the audit itself is NOT invoked on the request path. */
export interface PromotionGateAuthorityAuditReference {
  /** Schema/label of the audit module's output. */
  schemaVersion:        string;
  label:                string;
  hypothesisId:         string;
  metricKey:            string;
  /** Helper that produces the audit result on demand. */
  helperEntryPoint:     string;
  /** CLI runner that prints the audit. */
  manualRunnerEntryPoint: string;
  /** Plain-English caveat about WHY we don't run the audit per-request. */
  inRequestPathRationale: string;
  /** The single static finding id Phase 4-b added to the audit. */
  phase4bFindingId:     string;
}

/** Full visibility snapshot. */
export interface PromotionGateAuthorityVisibility {
  schemaVersion: typeof PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION;
  label:         typeof PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL;
  /** Coarse authority level — single-value summary. */
  authorityLevel: PromotionGateAuthorityLevel;
  /** Plain-English headline for the current authority state. */
  headline:       string;
  /** Plain-English summary block (multi-line, intended for tile body). */
  summary:        string;
  /** Per-flag state — secondary display under the natural-language summary. */
  flags: {
    phase4aSoftWarning:  PromotionGateAuthorityFlag;
    phase4bLowRiskBlock: PromotionGateAuthorityFlag;
  };
  /** Per-risk-class natural-language verdicts. */
  riskClassVerdicts: PromotionGateRiskClassVerdict[];
  /** Reference to the boundary audit module. */
  boundaryAuditReference: PromotionGateAuthorityAuditReference;
  /** Static invariants restated so a reviewer can see the contract. */
  invariants: {
    visibilityOnly:        string;
    singleWriteSiteIntact: string;
    propogateOnlyChannel:  string;
    phaseScope:            string;
  };
}

/** Pure helper: derive the coarse authority level from the two flags. */
export function deriveAuthorityLevel(
  softWarningFlagOn: boolean,
  lowRiskHardBlockFlagOn: boolean,
): PromotionGateAuthorityLevel {
  if (softWarningFlagOn && lowRiskHardBlockFlagOn) {
    return "soft_warning_and_low_risk_hard_block_enabled";
  }
  if (lowRiskHardBlockFlagOn) return "low_risk_hard_block_enabled";
  if (softWarningFlagOn) return "soft_warning_enabled";
  return "advisory_only";
}

/** Pure helper: render the headline sentence for an authority level. */
export function renderAuthorityHeadline(level: PromotionGateAuthorityLevel): string {
  switch (level) {
    case "advisory_only":
      return "The promotion gate is in its default advisory-only posture — neither Phase 4 operator flag is enabled.";
    case "soft_warning_enabled":
      return "Phase 4-a soft warnings are enabled — phase3aPrep readiness shortfalls surface as advisory text, but no promotion is blocked by this flag.";
    case "low_risk_hard_block_enabled":
      return "Phase 4-b low-risk hard block is enabled — low-risk recommendations require a fully_prepared phase3aPrep attestation to promote. Medium-risk and high-risk recommendations are not affected by this flag.";
    case "soft_warning_and_low_risk_hard_block_enabled":
      return "Phase 4-a soft warnings AND Phase 4-b low-risk hard block are both enabled — low-risk recommendations require a fully_prepared phase3aPrep attestation to promote, and advisory text surfaces alongside any attestation gap. Medium-risk and high-risk recommendations are not affected by these flags.";
  }
}

/** Pure helper: build the multi-line plain-English summary for the tile. */
export function renderAuthoritySummary(
  level: PromotionGateAuthorityLevel,
  softWarningFlagOn: boolean,
  lowRiskHardBlockFlagOn: boolean,
): string {
  const parts: string[] = [];

  if (lowRiskHardBlockFlagOn) {
    parts.push(
      "Low-risk recommendations are currently blocked when the Phase 3a-prep readiness attestation is missing, fails to parse, or reports a verdict other than 'fully_prepared'. This block routes through the existing canPromote(rec).ok boundary — there is no new write site and no new public-action surface.",
    );
  } else {
    parts.push(
      "Low-risk recommendations follow the historical propose-only posture: golden-set telemetry is logged but a phase3aPrep readiness shortfall does not block promotion.",
    );
  }

  parts.push(
    "Medium-risk recommendations are unaffected by these Phase 4 flags. They continue to follow the existing golden-set policy: any failing case blocks promotion.",
  );
  parts.push(
    "High-risk recommendations are unaffected by these Phase 4 flags. They additionally require the explicit operator override PROMOTION_GATE_ALLOW_HIGH_RISK=true on top of golden-set success.",
  );

  if (softWarningFlagOn) {
    parts.push(
      "Phase 4-a is also enabled: advisory soft-warning text surfaces alongside the existing attestation telemetry whenever a phase3aPrep readiness signal is not 'fully_prepared'. These warnings are advisory only — they do NOT block, reject, mutate status, or widen any public-action surface.",
    );
  } else {
    parts.push(
      "Phase 4-a soft warnings are off: no advisory readiness text is emitted on this channel today.",
    );
  }

  // Authority-level provenance line, last, so the operator can map this
  // back to one of the four canonical states.
  parts.push(
    `Current authority level: ${level.replace(/_/g, " ")}.`,
  );

  return parts.join("\n\n");
}

/** Pure helper: build the per-risk-class verdict array. */
export function renderRiskClassVerdicts(
  softWarningFlagOn: boolean,
  lowRiskHardBlockFlagOn: boolean,
): PromotionGateRiskClassVerdict[] {
  const lowHardBlocked = lowRiskHardBlockFlagOn;
  const lowSoftWarned = softWarningFlagOn;
  return [
    {
      riskClass:   "low",
      posture:     lowHardBlocked
        ? (lowSoftWarned
            ? "Promotion requires a fully_prepared phase3aPrep readiness attestation (Phase 4-b hard block). Soft-warning advisory text also surfaces on attestation gaps (Phase 4-a). Any shortfall is reported as an authoritative failure through canPromote(rec).ok=false."
            : "Promotion requires a fully_prepared phase3aPrep readiness attestation (Phase 4-b hard block). Any shortfall is reported as an authoritative failure through canPromote(rec).ok=false.")
        : (lowSoftWarned
            ? "Default propose-only posture. phase3aPrep readiness shortfalls surface as advisory soft warnings only (Phase 4-a) — they do not block promotion."
            : "Default propose-only posture. Golden-set failures are logged for telemetry but do not block low-risk promotion. No phase3aPrep readiness gate is active."),
      hardBlocked: lowHardBlocked,
      softWarned:  lowSoftWarned,
    },
    {
      riskClass:   "medium",
      posture:     "Unaffected by Phase 4 flags. Promotion is blocked on any failing golden-set case (existing Phase 2 policy). The phase3aPrep readiness flags do not extend to medium-risk.",
      hardBlocked: false,
      softWarned:  false,
    },
    {
      riskClass:   "high",
      posture:     "Unaffected by Phase 4 flags. Promotion is blocked on any failing golden-set case AND additionally requires the explicit operator override PROMOTION_GATE_ALLOW_HIGH_RISK=true. The phase3aPrep readiness flags do not extend to high-risk.",
      hardBlocked: false,
      softWarned:  false,
    },
  ];
}

/** Build the Phase 4-a soft-warning flag block. */
function buildPhase4aFlag(flagOn: boolean): PromotionGateAuthorityFlag {
  return {
    envVar:      PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV,
    enabled:     flagOn,
    phase:       "phase4-a",
    description: "Phase 4-a operator-gated soft warning. When enabled, the promotion gate emits advisory text whenever a phase3aPrep readiness attestation is present but its verdict is not 'fully_prepared' (or it failed to parse).",
    currentEffect: flagOn
      ? "ENABLED. The gate populates softWarnings[] alongside the existing attestation telemetry. gate.ok is unaffected — these warnings do not block, reject, or mutate any recommendation status."
      : "DEFAULT OFF. softWarnings[] is an empty array on every gate call. Output is byte-identical to pre-Phase-4-a behaviour.",
    changeOnEnable: "Flipping this flag to 'true' adds advisory soft-warning strings on top of the existing canPromote() output. It does NOT change gate.ok, does NOT block any promotion, and does NOT widen any public-action surface.",
  };
}

/** Build the Phase 4-b low-risk hard-block flag block. */
function buildPhase4bFlag(flagOn: boolean): PromotionGateAuthorityFlag {
  return {
    envVar:      PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
    enabled:     flagOn,
    phase:       "phase4-b",
    description: "Phase 4-b operator-gated authoritative hard block on LOW-RISK promotions. When enabled, the promotion gate flips ok=false whenever a low-risk recommendation lacks a fully_prepared phase3aPrep readiness attestation.",
    currentEffect: flagOn
      ? "ENABLED. Low-risk recommendations are authoritatively blocked when the phase3aPrep readiness attestation is missing, parse_error, or has a verdict other than 'fully_prepared'. Medium-risk and high-risk recommendations are NOT affected. The block routes through the existing canPromote(rec).ok=false path — there is no new write site."
      : "DEFAULT OFF. The flag is not enabled, so no Phase 4-b block is applied. Low-risk promotion follows the historical propose-only posture.",
    changeOnEnable: "Flipping this flag to 'true' makes the phase3aPrep readiness attestation an authoritative authorisation signal for LOW-RISK recommendations only. Medium-risk and high-risk classes remain unaffected. There is no Phase 4-c or 4-d extension to medium-risk in the current codebase.",
  };
}

/** Build the static boundary-audit reference block. */
function buildBoundaryAuditReference(): PromotionGateAuthorityAuditReference {
  return {
    schemaVersion:        PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION,
    label:                PROMOTION_BOUNDARY_AUDIT_LABEL,
    hypothesisId:         PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
    metricKey:            PROMOTION_BOUNDARY_AUDIT_METRIC_KEY,
    helperEntryPoint:     "server/eval/promotionBoundaryAudit.ts:auditPromotionBoundary",
    manualRunnerEntryPoint: "scripts/auditPromotionBoundary.ts",
    inRequestPathRationale:
      "The deterministic Phase 2m-b boundary audit scans ~200 server source files to verify the single-write-site invariant. Running it on every dashboard refresh would be wasteful and slow; instead the dashboard surfaces only the audit's identity here and operators run the CLI helper out-of-band to verify drift. The audit's findings array, including the 'phase4b_hard_block_flag_wired' check, is produced by that helper — not duplicated here.",
    phase4bFindingId:     "phase4b_hard_block_flag_wired",
  };
}

/**
 * Build the read-only promotion-gate authority visibility snapshot. Pure
 * with respect to process state — the only side effect is reading two
 * env vars via the dedicated helpers in `server/eval/promotionGate.ts`.
 *
 * Optional overrides are provided for tests so flag combinations can be
 * exercised without mutating `process.env`. In production both arguments
 * are omitted and the helpers read the live env.
 */
export function buildPromotionGateAuthorityVisibility(
  overrides: {
    softWarningFlagOn?:    boolean;
    lowRiskHardBlockFlagOn?: boolean;
  } = {},
): PromotionGateAuthorityVisibility {
  const softWarningFlagOn = overrides.softWarningFlagOn ?? readPhase3aPrepReadyRequiredFlag();
  const lowRiskHardBlockFlagOn = overrides.lowRiskHardBlockFlagOn ?? readPhase3aPrepBlockLowRiskFlag();
  const authorityLevel = deriveAuthorityLevel(softWarningFlagOn, lowRiskHardBlockFlagOn);
  return {
    schemaVersion:  PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION,
    label:          PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL,
    authorityLevel,
    headline:       renderAuthorityHeadline(authorityLevel),
    summary:        renderAuthoritySummary(authorityLevel, softWarningFlagOn, lowRiskHardBlockFlagOn),
    flags: {
      phase4aSoftWarning:  buildPhase4aFlag(softWarningFlagOn),
      phase4bLowRiskBlock: buildPhase4bFlag(lowRiskHardBlockFlagOn),
    },
    riskClassVerdicts: renderRiskClassVerdicts(softWarningFlagOn, lowRiskHardBlockFlagOn),
    boundaryAuditReference: buildBoundaryAuditReference(),
    invariants: {
      visibilityOnly:
        "This snapshot is rendered read-only on the Autonomy Monitor. It exposes no control, button, mutation endpoint, scheduler hook, or public-action surface. Reading it cannot promote, apply, reject, or change the status of any recommendation.",
      singleWriteSiteIntact:
        "Pin 11 (single-write-site promotion boundary) is preserved. The only authorisation signal consumed by applyRecommendation is canPromote(rec).ok. This visibility snapshot is non-authoritative — its consumers must not read it into ok.",
      propogateOnlyChannel:
        "The Phase 4-a soft-warning channel is and remains advisory only. Phase 4-b is the first authoritative use of the attestation channel and is opt-in / default-off / low-risk-only. This module describes that state; it does not extend it.",
      phaseScope:
        "No Phase 4-c or 4-d behaviour change is implied. Medium-risk and high-risk recommendation classes are explicitly called out as UNAFFECTED by Phase 4 flags. Any future phase that changes that posture must update this module in lock-step.",
    },
  };
}
