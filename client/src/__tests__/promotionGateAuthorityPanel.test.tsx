/**
 * Phase 4 visibility — render tests for PromotionGateAuthorityPanel.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test \
 *      client/src/__tests__/promotionGateAuthorityPanel.test.tsx
 *
 * Coverage:
 *   1. Renders the natural-language headline + summary.
 *   2. Reflects flag enable / disable states (default off vs both on).
 *   3. Per-risk-class verdicts: low can be hard-blocked, medium/high never are.
 *   4. The audit reference surfaces the Phase 4-b finding id.
 *   5. The component renders ZERO action controls: no <button>, no <input>,
 *      no <form>, no Approve/Reject/Apply/Promote/Submit labels.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  PromotionGateAuthorityPanel,
  type PromotionGateAuthorityVisibility,
} from "../components/PromotionGateAuthorityPanel";

function mkSnap(opts: { softOn: boolean; hardOn: boolean }): PromotionGateAuthorityVisibility {
  const level = opts.softOn && opts.hardOn
    ? "soft_warning_and_low_risk_hard_block_enabled"
    : opts.hardOn
      ? "low_risk_hard_block_enabled"
      : opts.softOn
        ? "soft_warning_enabled"
        : "advisory_only";
  return {
    schemaVersion: "phase4-visibility.v1",
    label:         "agent306.promotion_gate_authority_visibility",
    authorityLevel: level,
    headline:      `Test headline for ${level}: low-risk recommendations are described in plain English.`,
    summary:       `First paragraph about low-risk policy.\n\nSecond paragraph about medium-risk being unaffected.\n\nThird paragraph about high-risk being unaffected.`,
    flags: {
      phase4aSoftWarning: {
        envVar:        "PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY",
        enabled:       opts.softOn,
        phase:         "phase4-a",
        description:   "Phase 4-a operator-gated soft warning.",
        currentEffect: opts.softOn ? "ENABLED. Advisory text surfaces." : "DEFAULT OFF.",
        changeOnEnable: "Adds advisory text only.",
      },
      phase4bLowRiskBlock: {
        envVar:        "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY",
        enabled:       opts.hardOn,
        phase:         "phase4-b",
        description:   "Phase 4-b low-risk hard block.",
        currentEffect: opts.hardOn ? "ENABLED. Low-risk hard block active." : "DEFAULT OFF.",
        changeOnEnable: "Makes phase3aPrep authoritative for low-risk only.",
      },
    },
    riskClassVerdicts: [
      {
        riskClass:   "low",
        posture:     opts.hardOn
          ? "Low-risk promotion requires fully_prepared phase3aPrep."
          : "Low-risk follows default propose-only posture.",
        hardBlocked: opts.hardOn,
        softWarned:  opts.softOn,
      },
      {
        riskClass:   "medium",
        posture:     "Medium-risk recommendations are unaffected by Phase 4 flags.",
        hardBlocked: false,
        softWarned:  false,
      },
      {
        riskClass:   "high",
        posture:     "High-risk recommendations are unaffected by Phase 4 flags.",
        hardBlocked: false,
        softWarned:  false,
      },
    ],
    boundaryAuditReference: {
      schemaVersion:          "phase2m-b.v1",
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
      singleWriteSiteIntact: "Pin 11 preserved.",
      propogateOnlyChannel:  "Advisory only.",
      phaseScope:            "Medium-risk and high-risk unaffected.",
    },
  };
}

describe("Phase 4 — PromotionGateAuthorityPanel renders natural-language state (default off)", () => {
  const snap = mkSnap({ softOn: false, hardOn: false });
  const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);

  it("renders the panel container with the authority-level data attribute", () => {
    assert.match(html, /data-testid="promotion-gate-authority-panel"/);
    assert.match(html, /data-authority-level="advisory_only"/);
  });

  it("renders the natural-language headline and summary", () => {
    assert.match(html, /data-testid="promotion-gate-authority-headline"/);
    assert.match(html, /Test headline for advisory_only/);
    assert.match(html, /data-testid="promotion-gate-authority-summary"/);
    assert.match(html, /First paragraph about low-risk policy/);
  });

  it("shows both flags as default off", () => {
    assert.match(html, /data-testid="promotion-gate-flag-phase4-a"[^>]*data-enabled="false"/);
    assert.match(html, /data-testid="promotion-gate-flag-phase4-b"[^>]*data-enabled="false"/);
    assert.match(html, /data-testid="promotion-gate-flag-status-phase4-a"[^>]*>default off<\/span>/);
    assert.match(html, /data-testid="promotion-gate-flag-status-phase4-b"[^>]*>default off<\/span>/);
  });

  it("renders all three risk classes with correct hard-block flags off", () => {
    assert.match(html, /data-testid="promotion-gate-risk-low"[^>]*data-hard-blocked="false"/);
    assert.match(html, /data-testid="promotion-gate-risk-medium"[^>]*data-hard-blocked="false"/);
    assert.match(html, /data-testid="promotion-gate-risk-high"[^>]*data-hard-blocked="false"/);
  });

  it("surfaces the Phase 4-b audit finding id for traceability", () => {
    assert.match(html, /data-testid="promotion-gate-audit-finding-id"[^>]*>phase4b_hard_block_flag_wired<\/code>/);
  });
});

describe("Phase 4 — PromotionGateAuthorityPanel renders both-flags-enabled state", () => {
  const snap = mkSnap({ softOn: true, hardOn: true });
  const html = renderToString(<PromotionGateAuthorityPanel p={snap} />);

  it("reflects authority level both-on", () => {
    assert.match(html, /data-authority-level="soft_warning_and_low_risk_hard_block_enabled"/);
  });

  it("marks both flags as enabled in the rendered chips", () => {
    assert.match(html, /data-testid="promotion-gate-flag-phase4-a"[^>]*data-enabled="true"/);
    assert.match(html, /data-testid="promotion-gate-flag-phase4-b"[^>]*data-enabled="true"/);
    assert.match(html, /data-testid="promotion-gate-flag-status-phase4-a"[^>]*>enabled<\/span>/);
    assert.match(html, /data-testid="promotion-gate-flag-status-phase4-b"[^>]*>enabled<\/span>/);
  });

  it("marks low-risk as hard-blocked AND soft-warned, never medium or high", () => {
    assert.match(html, /data-testid="promotion-gate-risk-low"[^>]*data-hard-blocked="true"[^>]*data-soft-warned="true"/);
    assert.match(html, /data-testid="promotion-gate-risk-medium"[^>]*data-hard-blocked="false"[^>]*data-soft-warned="false"/);
    assert.match(html, /data-testid="promotion-gate-risk-high"[^>]*data-hard-blocked="false"[^>]*data-soft-warned="false"/);
    assert.match(html, /data-testid="promotion-gate-risk-low-hardblocked"/);
    assert.match(html, /data-testid="promotion-gate-risk-low-softwarned"/);
  });
});

describe("Phase 4 — PromotionGateAuthorityPanel renders no action controls", () => {
  it("renders ZERO <button>, <input>, <form>, or <textarea> elements", () => {
    const offHtml  = renderToString(<PromotionGateAuthorityPanel p={mkSnap({ softOn: false, hardOn: false })} />);
    const onHtml   = renderToString(<PromotionGateAuthorityPanel p={mkSnap({ softOn: true,  hardOn: true })}  />);
    const bothHtml = renderToString(<PromotionGateAuthorityPanel p={mkSnap({ softOn: true,  hardOn: false })} />);

    for (const html of [offHtml, onHtml, bothHtml]) {
      assert.doesNotMatch(html, /<button/i, "panel rendered a <button>");
      assert.doesNotMatch(html, /<input/i,  "panel rendered an <input>");
      assert.doesNotMatch(html, /<form/i,   "panel rendered a <form>");
      assert.doesNotMatch(html, /<textarea/i, "panel rendered a <textarea>");
      assert.doesNotMatch(html, /<select/i, "panel rendered a <select>");
      // Action-verb labels callers should never see on this panel.
      assert.doesNotMatch(html, />Approve</);
      assert.doesNotMatch(html, />Reject</);
      assert.doesNotMatch(html, />Apply</);
      assert.doesNotMatch(html, />Promote</);
      assert.doesNotMatch(html, />Submit</);
    }
  });

  it("does not render any onClick / onSubmit attribute (SSR serialization check)", () => {
    const html = renderToString(<PromotionGateAuthorityPanel p={mkSnap({ softOn: true, hardOn: true })} />);
    // React strips event handlers from SSR output, but any literal href / action
    // attribute that could trigger navigation would show up here. There should
    // be none — the panel only renders <section>, <header>, <h2>, <p>, <div>,
    // <span>, <code>.
    assert.doesNotMatch(html, / href=/);
    assert.doesNotMatch(html, / action=/);
  });
});
