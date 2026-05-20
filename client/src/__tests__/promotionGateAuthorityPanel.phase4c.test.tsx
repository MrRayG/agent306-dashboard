/**
 * PR #406 — client-side regression guard for Phase 4-c visibility on the
 * PromotionGateAuthorityPanel. This is the CI-level fence that prevents
 * the dashboard from drifting BEHIND the production gate code again
 * (audit finding §7.1 in /home/user/workspace/agent306_codebase_audit.md).
 *
 * What it asserts
 * ───────────────
 *   1. Both Phase 4-c flag blocks render with their canonical env-var
 *      names: PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS and
 *      PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY.
 *   2. When both are on, the panel renders the new flag cards with
 *      data-testid="promotion-gate-flag-phase4-c-freshness" and
 *      data-testid="promotion-gate-flag-phase4-c-medium-block", each
 *      with data-enabled="true".
 *   3. The medium-risk verdict card surfaces hardBlocked=true with the
 *      Phase 4-c part 2 narrative when the medium-risk flag is on.
 *   4. The high-risk verdict card remains hardBlocked=false (PR #406
 *      does not extend Phase 4-c to high-risk).
 *   5. The panel still emits ZERO action controls (no <button>, no
 *      <form>, no <input>), preserving Pin 7 / Pin 11.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.test.json --test \
 *     client/src/__tests__/promotionGateAuthorityPanel.phase4c.test.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  PromotionGateAuthorityPanel,
  type PromotionGateAuthorityVisibility,
} from "../components/PromotionGateAuthorityPanel";

const PHASE_4C_FRESHNESS_ENV   = "PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS";
const PHASE_4C_MEDIUM_BLOCK_ENV = "PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY";

function mkSnap(opts: {
  softOn:           boolean;
  lowBlockOn:       boolean;
  freshnessDays:    number | null;
  mediumBlockOn:    boolean;
}): PromotionGateAuthorityVisibility {
  const level = opts.mediumBlockOn
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
    schemaVersion: "phase4-visibility.v2",
    label:         "agent306.promotion_gate_authority_visibility",
    authorityLevel: level,
    headline:      `Headline for ${level}.`,
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
        changeOnEnable: "Arms the freshness gate (shared with medium-risk).",
      },
      phase4cMediumRiskBlock: {
        envVar:        PHASE_4C_MEDIUM_BLOCK_ENV,
        enabled:       opts.mediumBlockOn,
        phase:         "phase4-c-medium-block",
        description:   "Phase 4-c part 2 medium-risk hard block.",
        currentEffect: opts.mediumBlockOn ? "ENABLED." : "DEFAULT OFF.",
        changeOnEnable: "Makes phase3aPrep authoritative for medium-risk.",
      },
      // v3 (PR #408): the Phase 4-d high-risk hard-block flag block.
      // This Phase 4-c-specific fixture exercises the Phase 4-d off path.
      phase4dHighRiskBlock: {
        envVar:        "PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY",
        enabled:       false,
        phase:         "phase4-d-high-block",
        description:   "Phase 4-d high-risk hard block. Stacks on top of PROMOTION_GATE_ALLOW_HIGH_RISK.",
        currentEffect: "DEFAULT OFF.",
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
        posture:     "Unaffected by every Phase 4 flag; PROMOTION_GATE_ALLOW_HIGH_RISK required.",
        hardBlocked: false,
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
      propogateOnlyChannel:  "Advisory only.",
      phaseScope:            "Phase 4-c implemented for low-risk freshness AND medium-risk hard block. Phase 4-d (high-risk) UNAFFECTED.",
    },
  };
}

describe("PR #406 — PromotionGateAuthorityPanel renders Phase 4-c flag blocks", () => {
  const snap = mkSnap({
    softOn:        false,
    lowBlockOn:    true,
    freshnessDays: 14,
    mediumBlockOn: true,
  });
  const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);

  it("renders both Phase 4-c env-var names in the markup", () => {
    assert.match(html, new RegExp(PHASE_4C_FRESHNESS_ENV));
    assert.match(html, new RegExp(PHASE_4C_MEDIUM_BLOCK_ENV));
  });

  it("renders the freshness flag card with data-testid + data-enabled='true'", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-c-freshness"[^>]*data-enabled="true"/,
    );
    assert.match(
      html,
      /data-testid="promotion-gate-flag-status-phase4-c-freshness"[^>]*>enabled<\/span>/,
    );
  });

  it("renders the medium-risk block flag card with data-testid + data-enabled='true'", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-c-medium-block"[^>]*data-enabled="true"/,
    );
    assert.match(
      html,
      /data-testid="promotion-gate-flag-status-phase4-c-medium-block"[^>]*>enabled<\/span>/,
    );
  });

  it("renders the medium-risk verdict card with data-hard-blocked='true'", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-risk-medium"[^>]*data-hard-blocked="true"/,
    );
    assert.match(
      html,
      /data-testid="promotion-gate-risk-medium-hardblocked"/,
    );
  });

  it("high-risk verdict remains hardBlocked=false (Phase 4-c does NOT extend to high-risk)", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-risk-high"[^>]*data-hard-blocked="false"/,
    );
    assert.doesNotMatch(
      html,
      /data-testid="promotion-gate-risk-high-hardblocked"/,
    );
  });

  it("renders the freshness numeric value in markup (option (a): no new field on the flag interface)", () => {
    // The flag interface stays the same shape as Phase 4-a/4-b — the
    // day count is surfaced via the description / currentEffect strings.
    assert.match(html, /ENABLED at 14 day/);
  });

  it("renders ZERO action controls (no <button>, no <input>, no <form>) — Pin 7/Pin 11 preserved", () => {
    assert.doesNotMatch(html, /<button\b/i);
    assert.doesNotMatch(html, /<input\b/i);
    assert.doesNotMatch(html, /<form\b/i);
  });

  it("renders authority level data attribute as phase4c_medium_risk_hard_block_enabled", () => {
    assert.match(html, /data-authority-level="phase4c_medium_risk_hard_block_enabled"/);
  });
});

describe("PR #406 — Phase 4-c default-off snapshot still renders new flag cards", () => {
  const snap = mkSnap({
    softOn:        false,
    lowBlockOn:    false,
    freshnessDays: null,
    mediumBlockOn: false,
  });
  const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);

  it("Phase 4-c flag cards render with data-enabled='false' when both are off", () => {
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-c-freshness"[^>]*data-enabled="false"/,
    );
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-c-medium-block"[^>]*data-enabled="false"/,
    );
  });

  it("medium-risk verdict still says 'Unaffected' when Phase 4-c medium-risk is off", () => {
    assert.match(html, /Unaffected by Phase 4 flags/);
  });

  it("env-var names remain in markup even when the flags are off (operator can copy them)", () => {
    assert.match(html, new RegExp(PHASE_4C_FRESHNESS_ENV));
    assert.match(html, new RegExp(PHASE_4C_MEDIUM_BLOCK_ENV));
  });
});

describe("PR #406 — phase4c_freshness_active level (freshness on, medium-block off, low-block off)", () => {
  it("authority level cascades to phase4c_freshness_active and renders accordingly", () => {
    const snap = mkSnap({
      softOn:        false,
      lowBlockOn:    false,
      freshnessDays: 7,
      mediumBlockOn: false,
    });
    const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);
    assert.match(html, /data-authority-level="phase4c_freshness_active"/);
    assert.match(
      html,
      /data-testid="promotion-gate-flag-phase4-c-freshness"[^>]*data-enabled="true"/,
    );
  });
});
