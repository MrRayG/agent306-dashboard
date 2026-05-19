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
  PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
  readPhase3aPrepReadyRequiredFlag,
  readPhase3aPrepBlockLowRiskFlag,
  readPhase3aPrepBlockMediumRiskFlag,
  readPhase3aPrepMaxAgeDays,
} from "./eval/promotionGate.js";
import {
  PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION,
  PROMOTION_BOUNDARY_AUDIT_LABEL,
  PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
  PROMOTION_BOUNDARY_AUDIT_METRIC_KEY,
} from "./eval/promotionBoundaryAudit.js";

/** Stable schema identifier for the snapshot payload. Bumped only when
 *  the result shape changes in a backwards-incompatible way.
 *
 *  v2 (PR #406): adds `flags.phase4cFreshnessGate` and
 *  `flags.phase4cMediumRiskBlock` (mirroring the existing 4-a/4-b shape),
 *  extends `authorityLevel` with phase4-c states, and adds new
 *  `phase4-c-freshness` / `phase4-c-medium-block` phase identifiers on
 *  the flag block. The bump is ADDITIVE — every v1 field is preserved
 *  byte-for-byte. Old consumers that read `schemaVersion === "v1"` will
 *  still parse the v2 payload; only consumers that opt into the new
 *  fields need to know about v2. */
export const PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION =
  "phase4-visibility.v2";

/** Stable label embedded so an operator can confirm provenance. */
export const PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL =
  "agent306.promotion_gate_authority_visibility";

/** Coarse authority level. Ordered from least to most restrictive.
 *  v2 adds `phase4c_freshness_active` (PR #401 freshness gate without
 *  medium-risk block) and `phase4c_medium_risk_hard_block_enabled` (PR
 *  #403 medium-risk block, which implies the freshness gate is also
 *  active when MAX_AGE_DAYS is set). The four v1 levels are preserved
 *  unchanged. */
export type PromotionGateAuthorityLevel =
  /** Default. None of the Phase 4 operator flags is on. The gate
   *  behaves as it has historically: golden-set policy for medium/high
   *  risk, propose-only telemetry for low risk. */
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
  | "soft_warning_and_low_risk_hard_block_enabled"
  /** v2 (PR #406): Phase 4-c freshness gate is configured (MAX_AGE_DAYS
   *  > 0) but the Phase 4-c part 2 medium-risk hard block is OFF. The
   *  freshness threshold only takes effect on the tier whose hard-block
   *  flag is also on: if Phase 4-b is on, low-risk attestations older
   *  than MAX_AGE_DAYS are hard-blocked; if Phase 4-b is off, the
   *  freshness env var is read but has no effect today. */
  | "phase4c_freshness_active"
  /** v2 (PR #406): Phase 4-c part 2 medium-risk hard block is enabled.
   *  When this is on, medium-risk recommendations are authoritatively
   *  blocked on attestation readiness AND freshness (using the same
   *  shared MAX_AGE_DAYS env). High-risk recommendations remain
   *  unaffected. This level is reported regardless of whether the
   *  low-risk Phase 4-b flag is also on. */
  | "phase4c_medium_risk_hard_block_enabled";

/** Per-flag rendered state. */
export interface PromotionGateAuthorityFlag {
  /** Raw env-var name for traceability (secondary display). */
  envVar:        string;
  /** Whether the operator has opted in. For boolean flags this mirrors
   *  `process.env[envVar] === "true"` (case-insensitive). For the
   *  numeric Phase 4-c freshness flag, this is true iff the parsed
   *  value is a positive integer; the actual numeric value is surfaced
   *  in `description` and `currentEffect`. */
  enabled:       boolean;
  /** Phase identifier for the operator. v2 (PR #406) adds the two
   *  Phase 4-c phases. */
  phase:         "phase4-a" | "phase4-b" | "phase4-c-freshness" | "phase4-c-medium-block";
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
  /** Per-flag state — secondary display under the natural-language summary.
   *  v2 (PR #406) adds the Phase 4-c freshness gate and the Phase 4-c
   *  part 2 medium-risk hard-block flag blocks. v1 fields preserved
   *  byte-for-byte. */
  flags: {
    phase4aSoftWarning:     PromotionGateAuthorityFlag;
    phase4bLowRiskBlock:    PromotionGateAuthorityFlag;
    phase4cFreshnessGate:   PromotionGateAuthorityFlag;
    phase4cMediumRiskBlock: PromotionGateAuthorityFlag;
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

/** Pure helper: derive the coarse authority level from the four flags.
 *
 *  v2 (PR #406) extends the signature with `phase4cFreshnessOn` (true
 *  iff `PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS` parses to a positive
 *  integer) and `phase4cMediumRiskBlockOn` (true iff
 *  `PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY === "true"`).
 *
 *  Priority order (most restrictive wins):
 *    1. phase4cMediumRiskBlockOn → `phase4c_medium_risk_hard_block_enabled`
 *    2. lowRiskHardBlockFlagOn + softWarningFlagOn → `soft_warning_and_low_risk_hard_block_enabled`
 *    3. lowRiskHardBlockFlagOn → `low_risk_hard_block_enabled`
 *    4. phase4cFreshnessOn → `phase4c_freshness_active`
 *    5. softWarningFlagOn → `soft_warning_enabled`
 *    6. otherwise → `advisory_only`
 *
 *  Defaulting the two new args preserves byte-identical behaviour for
 *  any v1 caller that still passes only two booleans. */
export function deriveAuthorityLevel(
  softWarningFlagOn: boolean,
  lowRiskHardBlockFlagOn: boolean,
  phase4cFreshnessOn:        boolean = false,
  phase4cMediumRiskBlockOn:  boolean = false,
): PromotionGateAuthorityLevel {
  if (phase4cMediumRiskBlockOn) {
    return "phase4c_medium_risk_hard_block_enabled";
  }
  if (softWarningFlagOn && lowRiskHardBlockFlagOn) {
    return "soft_warning_and_low_risk_hard_block_enabled";
  }
  if (lowRiskHardBlockFlagOn) return "low_risk_hard_block_enabled";
  if (phase4cFreshnessOn) return "phase4c_freshness_active";
  if (softWarningFlagOn) return "soft_warning_enabled";
  return "advisory_only";
}

/** Pure helper: render the headline sentence for an authority level. */
export function renderAuthorityHeadline(level: PromotionGateAuthorityLevel): string {
  switch (level) {
    case "advisory_only":
      return "The promotion gate is in its default advisory-only posture — none of the Phase 4 operator flags is enabled.";
    case "soft_warning_enabled":
      return "Phase 4-a soft warnings are enabled — phase3aPrep readiness shortfalls surface as advisory text, but no promotion is blocked by this flag.";
    case "low_risk_hard_block_enabled":
      return "Phase 4-b low-risk hard block is enabled — low-risk recommendations require a fully_prepared phase3aPrep attestation to promote. Medium-risk and high-risk recommendations are not affected by this flag.";
    case "soft_warning_and_low_risk_hard_block_enabled":
      return "Phase 4-a soft warnings AND Phase 4-b low-risk hard block are both enabled — low-risk recommendations require a fully_prepared phase3aPrep attestation to promote, and advisory text surfaces alongside any attestation gap. Medium-risk and high-risk recommendations are not affected by these flags.";
    case "phase4c_freshness_active":
      return "Phase 4-c freshness gate is configured (PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS > 0) — when paired with the Phase 4-b low-risk hard block, low-risk attestations older than the configured window are hard-blocked. The Phase 4-c medium-risk hard block remains off, so medium-risk and high-risk recommendations are not affected by Phase 4-c.";
    case "phase4c_medium_risk_hard_block_enabled":
      return "Phase 4-c part 2 medium-risk hard block is enabled — medium-risk recommendations are authoritatively blocked when their phase3aPrep attestation is missing, parse_error, not fully_prepared, or (when the freshness threshold is set) stale or future-dated. Low-risk gating follows its own Phase 4-b flag; high-risk recommendations remain unaffected.";
  }
}

/** Pure helper: build the multi-line plain-English summary for the tile.
 *  v2 (PR #406) accepts two additional flags. v1 callers passing only
 *  the first three args continue to work — the Phase 4-c narrative
 *  paragraphs render as "freshness gate off / medium-risk block off". */
export function renderAuthoritySummary(
  level: PromotionGateAuthorityLevel,
  softWarningFlagOn: boolean,
  lowRiskHardBlockFlagOn: boolean,
  phase4cFreshnessMaxAgeDays: number | null = null,
  phase4cMediumRiskBlockOn:    boolean      = false,
): string {
  const phase4cFreshnessOn = phase4cFreshnessMaxAgeDays !== null;
  const parts: string[] = [];

  if (lowRiskHardBlockFlagOn) {
    if (phase4cFreshnessOn) {
      parts.push(
        `Low-risk recommendations are currently blocked when the Phase 3a-prep readiness attestation is missing, fails to parse, reports a verdict other than 'fully_prepared', or is older than ${phase4cFreshnessMaxAgeDays} day(s) (Phase 4-c freshness gate). This block routes through the existing canPromote(rec).ok boundary — there is no new write site and no new public-action surface.`,
      );
    } else {
      parts.push(
        "Low-risk recommendations are currently blocked when the Phase 3a-prep readiness attestation is missing, fails to parse, or reports a verdict other than 'fully_prepared'. This block routes through the existing canPromote(rec).ok boundary — there is no new write site and no new public-action surface.",
      );
    }
  } else {
    parts.push(
      "Low-risk recommendations follow the historical propose-only posture: golden-set telemetry is logged but a phase3aPrep readiness shortfall does not block promotion.",
    );
  }

  if (phase4cMediumRiskBlockOn) {
    const freshnessClause = phase4cFreshnessOn
      ? `, or is older than ${phase4cFreshnessMaxAgeDays} day(s)`
      : "";
    parts.push(
      `Medium-risk recommendations are currently blocked when the Phase 3a-prep readiness attestation is missing, fails to parse, reports a verdict other than 'fully_prepared'${freshnessClause}. The block is authoritative — it routes through the existing canPromote(rec).ok boundary, with no new write site. Golden-set policy continues to apply on top: any failing case still blocks promotion.`,
    );
  } else {
    parts.push(
      "Medium-risk recommendations are unaffected by these Phase 4 flags. They continue to follow the existing golden-set policy: any failing case blocks promotion.",
    );
  }
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

  if (phase4cFreshnessOn) {
    parts.push(
      `Phase 4-c freshness threshold is configured at ${phase4cFreshnessMaxAgeDays} day(s) (PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS). This threshold is shared across the low-risk and medium-risk hard-block paths — it only takes effect on a tier whose own hard-block flag is also on.`,
    );
  } else {
    parts.push(
      "Phase 4-c freshness gate is off (PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS unset or non-positive). Attestation age is not consulted by canPromote today.",
    );
  }

  // Authority-level provenance line, last, so the operator can map this
  // back to one of the canonical states.
  parts.push(
    `Current authority level: ${level.replace(/_/g, " ")}.`,
  );

  return parts.join("\n\n");
}

/** Pure helper: build the per-risk-class verdict array.
 *
 *  v2 (PR #406) accepts two additional inputs (`phase4cFreshnessMaxAgeDays`,
 *  `phase4cMediumRiskBlockOn`) so the medium-risk verdict can reflect
 *  the Phase 4-c part 2 hard block. v1 callers passing only two booleans
 *  continue to see medium-risk reported as "Unaffected by Phase 4 flags"
 *  — byte-identical to the v1 default state. High-risk is unconditionally
 *  unaffected. */
export function renderRiskClassVerdicts(
  softWarningFlagOn: boolean,
  lowRiskHardBlockFlagOn: boolean,
  phase4cFreshnessMaxAgeDays: number | null = null,
  phase4cMediumRiskBlockOn:    boolean      = false,
): PromotionGateRiskClassVerdict[] {
  const lowHardBlocked = lowRiskHardBlockFlagOn;
  const lowSoftWarned = softWarningFlagOn;
  const phase4cFreshnessOn = phase4cFreshnessMaxAgeDays !== null;
  const lowFreshnessClause = (lowHardBlocked && phase4cFreshnessOn)
    ? ` Attestation freshness is also enforced — attestations older than ${phase4cFreshnessMaxAgeDays} day(s) (or future-dated) are hard-blocked (Phase 4-c).`
    : "";
  const mediumFreshnessClause = phase4cFreshnessOn
    ? ` Attestation freshness is also enforced — attestations older than ${phase4cFreshnessMaxAgeDays} day(s) (or future-dated) are hard-blocked (Phase 4-c).`
    : "";

  return [
    {
      riskClass:   "low",
      posture:     lowHardBlocked
        ? (lowSoftWarned
            ? `Promotion requires a fully_prepared phase3aPrep readiness attestation (Phase 4-b hard block). Soft-warning advisory text also surfaces on attestation gaps (Phase 4-a). Any shortfall is reported as an authoritative failure through canPromote(rec).ok=false.${lowFreshnessClause}`
            : `Promotion requires a fully_prepared phase3aPrep readiness attestation (Phase 4-b hard block). Any shortfall is reported as an authoritative failure through canPromote(rec).ok=false.${lowFreshnessClause}`)
        : (lowSoftWarned
            ? "Default propose-only posture. phase3aPrep readiness shortfalls surface as advisory soft warnings only (Phase 4-a) — they do not block promotion."
            : "Default propose-only posture. Golden-set failures are logged for telemetry but do not block low-risk promotion. No phase3aPrep readiness gate is active."),
      hardBlocked: lowHardBlocked,
      softWarned:  lowSoftWarned,
    },
    {
      riskClass:   "medium",
      posture:     phase4cMediumRiskBlockOn
        ? `Phase 4-c part 2 hard block is active. Promotion is authoritatively blocked when the phase3aPrep readiness attestation is missing, parse_error, or not fully_prepared.${mediumFreshnessClause} Golden-set policy still applies — any failing case also blocks promotion. The block routes through canPromote(rec).ok=false; there is no new write site.`
        : "Unaffected by Phase 4 flags. Promotion is blocked on any failing golden-set case (existing Phase 2 policy). The phase3aPrep readiness flags do not extend to medium-risk in the current configuration.",
      hardBlocked: phase4cMediumRiskBlockOn,
      softWarned:  false,
    },
    {
      riskClass:   "high",
      posture:     "Unaffected by Phase 4 flags. Promotion is blocked on any failing golden-set case AND additionally requires the explicit operator override PROMOTION_GATE_ALLOW_HIGH_RISK=true. The phase3aPrep readiness flags (Phase 4-b and Phase 4-c) do not extend to high-risk.",
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
      ? "ENABLED. Low-risk recommendations are authoritatively blocked when the phase3aPrep readiness attestation is missing, parse_error, or has a verdict other than 'fully_prepared'. Medium-risk and high-risk recommendations are NOT affected by THIS flag (see the Phase 4-c medium-risk flag below for the medium-risk surface). The block routes through the existing canPromote(rec).ok=false path — there is no new write site."
      : "DEFAULT OFF. The flag is not enabled, so no Phase 4-b block is applied. Low-risk promotion follows the historical propose-only posture.",
    changeOnEnable: "Flipping this flag to 'true' makes the phase3aPrep readiness attestation an authoritative authorisation signal for LOW-RISK recommendations only. The medium-risk surface is governed by the separate phase4-c-medium-block flag (see PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY) and high-risk remains unaffected by any Phase 4 flag today.",
  };
}

/** Build the Phase 4-c freshness gate flag block (PR #401).
 *
 *  Unlike the boolean Phase 4-a/4-b flags this carries a numeric value
 *  (the day count). We model it on the same `PromotionGateAuthorityFlag`
 *  shape — `enabled` is true iff a positive integer was parsed; the
 *  numeric value is surfaced inline in `description` and
 *  `currentEffect` so the dashboard renders without needing a new field
 *  on the shared interface (option (a) per PR #406 spec). */
export function buildPhase4cFreshnessFlag(maxAgeDays: number | null): PromotionGateAuthorityFlag {
  const enabled = maxAgeDays !== null;
  return {
    envVar:      PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
    enabled,
    phase:       "phase4-c-freshness",
    description: "Phase 4-c attestation-freshness threshold. When this env var parses to a positive integer N, the promotion gate hard-blocks a low-risk or medium-risk recommendation (depending on which tier's own hard-block flag is on) whose phase3aPrep attestation is older than N days, or is future-dated. The threshold is SHARED across the low-risk (Phase 4-b) and medium-risk (Phase 4-c part 2) hard-block paths.",
    currentEffect: enabled
      ? `ENABLED at ${maxAgeDays} day(s). Attestation age is enforced on whichever tier has its own hard-block flag enabled — when Phase 4-b is on, low-risk attestations older than ${maxAgeDays} day(s) (or future-dated) are hard-blocked; when the Phase 4-c medium-risk block is on, medium-risk attestations are similarly blocked. The block routes through canPromote(rec).ok=false; there is no new write site, no new public-action surface.`
      : "DEFAULT OFF. Attestation age is not consulted by canPromote. The freshness helpers (isPhase3aAttestationStale / isPhase3aAttestationFutureDated in server/eval/promotionGate.ts) are pure and the env var is read on every gate call but yields null, so the helpers return false.",
    changeOnEnable: "Setting this env var to a positive integer arms the Phase 4-c freshness gate. It does NOT, on its own, block any promotion — the freshness check only fires on a tier whose own hard-block flag (Phase 4-b for low-risk; Phase 4-c medium-risk for medium-risk) is also on. There is no Phase 4-c high-risk extension; that surface is reserved for a future PR.",
  };
}

/** Build the Phase 4-c part 2 medium-risk hard-block flag block (PR #403). */
export function buildPhase4cMediumRiskBlockFlag(flagOn: boolean): PromotionGateAuthorityFlag {
  return {
    envVar:      PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
    enabled:     flagOn,
    phase:       "phase4-c-medium-block",
    description: "Phase 4-c part 2 operator-gated authoritative hard block on MEDIUM-RISK promotions. Mirrors the Phase 4-b low-risk hard block: when enabled, the promotion gate flips ok=false whenever a medium-risk recommendation lacks a fully_prepared phase3aPrep readiness attestation, or its attestation is stale/future-dated against the shared PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS threshold.",
    currentEffect: flagOn
      ? "ENABLED. Medium-risk recommendations are authoritatively blocked when the phase3aPrep readiness attestation is missing, parse_error, not 'fully_prepared', or (when the freshness threshold is set) stale or future-dated. High-risk recommendations are NOT affected. The block routes through canPromote(rec).ok=false; there is no new write site."
      : "DEFAULT OFF. The flag is not enabled, so the existing medium-risk policy applies: golden-set failures block promotion, but a phase3aPrep readiness shortfall does not.",
    changeOnEnable: "Flipping this flag to 'true' makes the phase3aPrep readiness attestation an authoritative authorisation signal for MEDIUM-RISK recommendations. The check reuses the same helpers and threshold env var as Phase 4-c part 1 for low-risk — there is exactly one freshness window across both tiers. High-risk remains unaffected and continues to be governed solely by PROMOTION_GATE_ALLOW_HIGH_RISK.",
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
    softWarningFlagOn?:           boolean;
    lowRiskHardBlockFlagOn?:      boolean;
    phase4cFreshnessMaxAgeDays?:  number | null;
    phase4cMediumRiskBlockOn?:    boolean;
  } = {},
): PromotionGateAuthorityVisibility {
  const softWarningFlagOn = overrides.softWarningFlagOn ?? readPhase3aPrepReadyRequiredFlag();
  const lowRiskHardBlockFlagOn = overrides.lowRiskHardBlockFlagOn ?? readPhase3aPrepBlockLowRiskFlag();
  // v2 (PR #406): the Phase 4-c freshness threshold is an INTEGER env
  // var (days). We treat `enabled` on the flag block as "parsed to a
  // positive integer" and surface the actual number in description /
  // currentEffect. `undefined` from overrides means "fall back to the
  // live env"; `null` from overrides means "explicitly off in this
  // test", which is a distinct intent we must preserve.
  const phase4cFreshnessMaxAgeDays = overrides.phase4cFreshnessMaxAgeDays === undefined
    ? readPhase3aPrepMaxAgeDays()
    : overrides.phase4cFreshnessMaxAgeDays;
  const phase4cMediumRiskBlockOn = overrides.phase4cMediumRiskBlockOn ?? readPhase3aPrepBlockMediumRiskFlag();
  const phase4cFreshnessOn = phase4cFreshnessMaxAgeDays !== null;

  const authorityLevel = deriveAuthorityLevel(
    softWarningFlagOn,
    lowRiskHardBlockFlagOn,
    phase4cFreshnessOn,
    phase4cMediumRiskBlockOn,
  );
  return {
    schemaVersion:  PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION,
    label:          PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL,
    authorityLevel,
    headline:       renderAuthorityHeadline(authorityLevel),
    summary:        renderAuthoritySummary(
      authorityLevel,
      softWarningFlagOn,
      lowRiskHardBlockFlagOn,
      phase4cFreshnessMaxAgeDays,
      phase4cMediumRiskBlockOn,
    ),
    flags: {
      phase4aSoftWarning:     buildPhase4aFlag(softWarningFlagOn),
      phase4bLowRiskBlock:    buildPhase4bFlag(lowRiskHardBlockFlagOn),
      phase4cFreshnessGate:   buildPhase4cFreshnessFlag(phase4cFreshnessMaxAgeDays),
      phase4cMediumRiskBlock: buildPhase4cMediumRiskBlockFlag(phase4cMediumRiskBlockOn),
    },
    riskClassVerdicts: renderRiskClassVerdicts(
      softWarningFlagOn,
      lowRiskHardBlockFlagOn,
      phase4cFreshnessMaxAgeDays,
      phase4cMediumRiskBlockOn,
    ),
    boundaryAuditReference: buildBoundaryAuditReference(),
    invariants: {
      visibilityOnly:
        "This snapshot is rendered read-only on the Autonomy Monitor. It exposes no control, button, mutation endpoint, scheduler hook, or public-action surface. Reading it cannot promote, apply, reject, or change the status of any recommendation.",
      singleWriteSiteIntact:
        "Pin 11 (single-write-site promotion boundary) is preserved. The only authorisation signal consumed by applyRecommendation is canPromote(rec).ok. This visibility snapshot is non-authoritative — its consumers must not read it into ok.",
      propogateOnlyChannel:
        "The Phase 4-a soft-warning channel is and remains advisory only. Phase 4-b and Phase 4-c are authoritative uses of the attestation channel and are opt-in / default-off / per-tier. This module describes that state; it does not extend it.",
      phaseScope:
        "Phase 4-c is implemented for low-risk freshness (PR #401) AND medium-risk hard block (PR #403); their effect depends on the operator-gated env flags surfaced above. Phase 4-d (high-risk authoritative block) is NOT implemented — high-risk recommendations remain explicitly UNAFFECTED by every Phase 4 flag and continue to require the PROMOTION_GATE_ALLOW_HIGH_RISK operator override on top of golden-set success.",
    },
  };
}
