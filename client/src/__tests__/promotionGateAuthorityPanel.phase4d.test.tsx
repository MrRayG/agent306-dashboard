/**
 * PR #408 — client-side regression guard for Phase 4-d visibility on the
 * PromotionGateAuthorityPanel. Mirrors phase4c.test.tsx byte-for-byte
 * in structure: the goal is to keep the dashboard pinned to the
 * production gate code so a future refactor can't silently drop the
 * Phase 4-d card.
 *
 * What it asserts
 * ───────────────
 *   1. The Phase 4-d flag block renders with its canonical env-var
 *      name: PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY.
 *   2. When phase4d is on, the panel renders the new flag card with
 *      data-testid="promotion-gate-flag-phase4-d-high-block" and
 *      data-enabled="true".
 *   3. The high-risk verdict card surfaces hardBlocked=true when the
 *      phase4d flag is on, and hardBlocked=false (default) otherwise.
 *   4. The authority level cascades to
 *      phase4d_high_risk_hard_block_enabled when phase4d is on.
 *   5. The panel still emits ZERO action controls (no <button>, no
 *      <form>, no <input>), preserving Pin 7 / Pin 11.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.test.json --test \
 *     client/src/__tests__/promotionGateAuthorityPanel.phase4d.test.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  PromotionGateAuthorityPanel,
  type PromotionGateAuthorityVisibility,
} from "../components/PromotionGateAuthorityPanel";

const PHASE_4C_FRESHNESS_ENV    = "PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS";
const PHASE_4C_MEDIUM_BLOCK_ENV = "PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY";
const PHASE_4D_HIGH_BLOCK_ENV   = "PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY";

function mkSnap(opts: {
  softOn:           boolean;
  lowBlockOn:       boolean;
  freshnessDays:    number | null;
  mediumBlockOn:    boolean;
  highBlockOn:      boolean;
}): PromotionGateAuthorityVisibility {
  const level = opts.highBlockOn
    ? "phase4d_high_risk_hard_block_enabled"
    : opts.mediumBlockOn
      ? "phase4c_medium_risk_hard_block_enabled"
      : opts.softOn && opts.lowBlockOn
        ? "soft_warning_and_low_risk_hard_block_enabled"
        : opts.lowBlockOn
          ? "low_risk_hard_block_enabled"
          : opts.freshnessDays !== null
            ? "phase4c_freshness_active"
            : opts.softOn
              ? "soft_warning_enabled"
              : "advisory_only";
  return {
    schemaVersion: "phase4-visibility.v3",
    label:         "agent306.promotion_gate_authority_visibility",
    authorityLevel: level,
    headline:      `Headline for ${level}. PROMOTION_GATE_ALLOW_HIGH_RISK stacks on top.`,
    summary:       `Paragraph 1.\n\nParagraph 2.\n\nParagraph 3.`,
    flags: {
      phase4aSoftWarning: {
        envVar:        "PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY",
        enabled:       opts.softOn,
        phase:         "phase4-a",
        description:   "Phase 4-a soft warning.",
        currentEffect: opts.softOn ? "ENABLED." : "DEFAULT OFF.",
        changeOnEnable: "Adds advisory text only.",
      },
      phase4bLowRiskBlock: {
        envVar:        "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY",
        enabled:       opts.lowBlockOn,
        phase:         "phase4-b",
        description:   "Phase 4-b low-risk hard block.",
        currentEffect: opts.lowBlockOn ? "ENABLED." : "DEFAULT OFF.",
        changeOnEnable: "Makes phase3aPrep authoritative for low-risk.",
      },
      phase4cFreshnessGate: {
        envVar:        PHASE_4C_FRESHNESS_ENV,
        enabled:       opts.freshnessDays !== null,
        phase:         "phase4-c-freshness",
        description:   "Phase 4-c attestation-freshness threshold.",
        currentEffect: opts.freshnessDays !== null
          ? `ENABLED at ${opts.freshnessDays} day(s).`
          : "DEFAULT OFF.",
        changeOnEnable: "Arms the freshness gate (shared with medium/high-risk).",
      },
      phase4cMediumRiskBlock: {
        envVar:        PHASE_4C_MEDIUM_BLOCK_ENV,
        enabled:       opts.mediumBlockOn,
        phase:         "phase4-c-medium-block",
        description:   "Phase 4-c part 2 medium-risk hard block.",
        currentEffect: opts.mediumBlockOn ? "ENABLED." : "DEFAULT OFF.",
        changeOnEnable: "Makes phase3aPrep authoritative for medium-risk.",
      },
      phase4dHighRiskBlock: {
        envVar:        PHASE_4D_HIGH_BLOCK_ENV,
        enabled:       opts.highBlockOn,
        phase:         "phase4-d-high-block",
        description:   "Phase 4-d high-risk hard block. Stacks on top of PROMOTION_GATE_ALLOW_HIGH_RISK.",
        currentEffect: opts.highBlockOn
          ? "ENABLED. PROMOTION_GATE_ALLOW_HIGH_RISK=true is still required on top."
          : "DEFAULT OFF.",
        changeOnEnable: "Makes phase3aPrep authoritative for high-risk (in addition to PROMOTION_GATE_ALLOW_HIGH_RISK).",
      },
    },
    riskClassVerdicts: [
      {
        riskClass:   "low",
        posture:     opts.lowBlockOn
          ? `Low-risk requires fully_prepared phase3aPrep${opts.freshnessDays !== null ? `; freshness ${opts.freshnessDays}d` : ""}.`
          : "Low-risk default propose-only.",
        hardBlocked: opts.lowBlockOn,
        softWarned:  opts.softOn,
      },
      {
        riskClass:   "medium",
        posture:     opts.mediumBlockOn
          ? `Phase 4-c part 2 active${opts.freshnessDays !== null ? `; freshness ${opts.freshnessDays}d` : ""}.`
          : "Unaffected by Phase 4 flags.",
        hardBlocked: opts.mediumBlockOn,
        softWarned:  false,
      },
      {
        riskClass:   "high",
        posture:     opts.highBlockOn
          ? `Phase 4-d high-risk hard block active${opts.freshnessDays !== null ? `; freshness ${opts.freshnessDays}d` : ""}. PROMOTION_GATE_ALLOW_HIGH_RISK still required on top — Phase 4-d stacks.`
          : "Unaffected by Phase 4 flags; PROMOTION_GATE_ALLOW_HIGH_RISK required.",
        hardBlocked: opts.highBlockOn,
        softWarned:  false,
      },
    ],
    boundaryAuditReference: {
      schemaVersion:          "phase2m-c.v2",
      label:                  "agent306.promotion_boundary_audit",
      hypothesisId:           "hyp_agent306_safety_gating_single_write_boundary",
      metricKey:              "promotion_boundary_violation_count",
      helperEntryPoint:       "server/eval/promotionBoundaryAudit.ts:auditPromotionBoundary",
      manualRunnerEntryPoint: "scripts/auditPromotionBoundary.ts",
      inRequestPathRationale: "Audit scans many source files; run it out-of-band.",
      phase4bFindingId:       "phase4b_hard_block_flag_wired",
    },
    invariants: {
      visibilityOnly:        "Read-only.",
      singleWriteSiteIntact: "Pin 11 preserved — canPromote(rec).ok is the sole authorisation signal.",
      propogateOnlyChannel:  "Advisory only. Phase 4-b/4-c/4-d are authoritative.",
      phaseScope:            "Phase 4-c implemented (PR #401, PR #403). Phase 4-d implemented (PR #408); stacks on top of PROMOTION_GATE_ALLOW_HIGH_RISK.",
    },
  };
}

describe("PR #408 — PromotionGateAuthorityPanel renders Phase 4-d flag block", () => {
  const snap = mkSnap({
    softOn:        false,
    lowBlockOn:    false,
    freshnessDays: 14,
    mediumBlockOn: false,
    highBlockOn:   true,
  });
  const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);

  it("renders the Phase 4-d env-var name in the markup", () => {
    assert.match(html, new RegExp(PHASE_4D_HIGH_BLOCK_ENV));
  });

  it("renders the phase4-d-high-block flag card with data-testid + data-enabled='true'", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-d-high-block"[^>]*data-enabled="true"/,
    );
    assert.match(
      html,
      /data-testid="promotion-gate-flag-status-phase4-d-high-block"[^>]*>enabled<\/span>/,
    );
  });

  it("renders the high-risk verdict card with data-hard-blocked='true'", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-risk-high"[^>]*data-hard-blocked="true"/,
    );
    assert.match(
      html,
      /data-testid="promotion-gate-risk-high-hardblocked"/,
    );
  });

  it("renders authority level data attribute as phase4d_high_risk_hard_block_enabled", () => {
    assert.match(html, /data-authority-level="phase4d_high_risk_hard_block_enabled"/);
  });

  it("renders ZERO action controls (no <button>, no <input>, no <form>) — Pin 7/Pin 11 preserved", () => {
    assert.doesNotMatch(html, /<button\b/i);
    assert.doesNotMatch(html, /<input\b/i);
    assert.doesNotMatch(html, /<form\b/i);
  });

  it("renders the stacking-with-PROMOTION_GATE_ALLOW_HIGH_RISK clause in the high-risk verdict", () => {
    // The high-risk posture must explain that Phase 4-d does NOT replace
    // the existing PROMOTION_GATE_ALLOW_HIGH_RISK override.
    assert.match(html, /PROMOTION_GATE_ALLOW_HIGH_RISK/);
    assert.match(html, /stacks|STACK/i);
  });
});

describe("PR #408 — Phase 4-d default-off snapshot still renders new flag card", () => {
  const snap = mkSnap({
    softOn:        false,
    lowBlockOn:    false,
    freshnessDays: null,
    mediumBlockOn: false,
    highBlockOn:   false,
  });
  const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);

  it("Phase 4-d flag card renders with data-enabled='false' when the flag is off", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-d-high-block"[^>]*data-enabled="false"/,
    );
  });

  it("env-var name remains in markup even when the flag is off (operator can copy it)", () => {
    assert.match(html, new RegExp(PHASE_4D_HIGH_BLOCK_ENV));
  });

  it("high-risk verdict remains hardBlocked=false when phase4d is off", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-risk-high"[^>]*data-hard-blocked="false"/,
    );
    assert.doesNotMatch(
      html,
      /data-testid="promotion-gate-risk-high-hardblocked"/,
    );
  });

  it("default-off snapshot does NOT cascade to phase4d_high_risk_hard_block_enabled", () => {
    assert.doesNotMatch(html, /data-authority-level="phase4d_high_risk_hard_block_enabled"/);
    assert.match(html, /data-authority-level="advisory_only"/);
  });
});

describe("PR #408 — phase4d ON wins over every other combination", () => {
  it("phase4d=ON overrides medium-block=ON / low-block=ON / soft=ON in the cascade", () => {
    const snap = mkSnap({
      softOn:        true,
      lowBlockOn:    true,
      freshnessDays: 14,
      mediumBlockOn: true,
      highBlockOn:   true,
    });
    const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);
    assert.match(html, /data-authority-level="phase4d_high_risk_hard_block_enabled"/);
    // All five flag cards must still be present.
    assert.match(html, /data-testid="promotion-gate-flag-phase4-a"/);
    assert.match(html, /data-testid="promotion-gate-flag-phase4-b"/);
    assert.match(html, /data-testid="promotion-gate-flag-phase4-c-freshness"/);
    assert.match(html, /data-testid="promotion-gate-flag-phase4-c-medium-block"/);
    assert.match(html, /data-testid="promotion-gate-flag-phase4-d-high-block"/);
  });
});
