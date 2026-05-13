/**
 * Tests for the Phase 4 promotion-gate authority visibility module.
 *
 * Invariants pinned here:
 *   1. Snapshot is fully populated when both flags are off (default).
 *   2. Flag combinations map to the four canonical authorityLevel values.
 *   3. Per-risk-class verdicts call out medium and high as UNAFFECTED.
 *   4. Headline and summary contain plain-English text for the operator.
 *   5. The snapshot exposes the right env-var names and the Phase 4-b
 *      audit finding id for traceability.
 *   6. Reading the snapshot has no side effects (no env mutation, no fs).
 *   7. autonomyMonitor's snapshot wires this in as `promotionGateAuthority`
 *      and does NOT mutate process.env.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPromotionGateAuthorityVisibility,
  deriveAuthorityLevel,
  renderAuthorityHeadline,
  renderAuthoritySummary,
  renderRiskClassVerdicts,
  PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION,
  PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL,
  type PromotionGateAuthorityLevel,
} from "../promotionGateAuthorityVisibility.ts";

const PHASE_4A_ENV = "PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY";
const PHASE_4B_ENV = "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY";

describe("promotionGateAuthorityVisibility — deriveAuthorityLevel", () => {
  it("returns advisory_only when both flags are off", () => {
    assert.equal(deriveAuthorityLevel(false, false), "advisory_only");
  });

  it("returns soft_warning_enabled when only Phase 4-a is on", () => {
    assert.equal(deriveAuthorityLevel(true, false), "soft_warning_enabled");
  });

  it("returns low_risk_hard_block_enabled when only Phase 4-b is on", () => {
    assert.equal(deriveAuthorityLevel(false, true), "low_risk_hard_block_enabled");
  });

  it("returns soft_warning_and_low_risk_hard_block_enabled when both flags are on", () => {
    assert.equal(
      deriveAuthorityLevel(true, true),
      "soft_warning_and_low_risk_hard_block_enabled",
    );
  });
});

describe("promotionGateAuthorityVisibility — renderAuthorityHeadline", () => {
  const levels: PromotionGateAuthorityLevel[] = [
    "advisory_only",
    "soft_warning_enabled",
    "low_risk_hard_block_enabled",
    "soft_warning_and_low_risk_hard_block_enabled",
  ];

  it("returns a non-empty natural-language sentence for every level", () => {
    for (const level of levels) {
      const headline = renderAuthorityHeadline(level);
      assert.equal(typeof headline, "string");
      assert.ok(headline.length > 20, `headline too short for ${level}`);
    }
  });

  it("references the hard block in low-risk levels and not in advisory", () => {
    assert.match(
      renderAuthorityHeadline("advisory_only"),
      /advisory-only/i,
    );
    assert.match(
      renderAuthorityHeadline("low_risk_hard_block_enabled"),
      /hard block/i,
    );
    assert.match(
      renderAuthorityHeadline("soft_warning_and_low_risk_hard_block_enabled"),
      /hard block/i,
    );
  });
});

describe("promotionGateAuthorityVisibility — renderAuthoritySummary", () => {
  it("calls out medium-risk and high-risk as unaffected by Phase 4 flags", () => {
    const summary = renderAuthoritySummary("advisory_only", false, false);
    assert.match(summary, /Medium-risk/);
    assert.match(summary, /High-risk/);
    assert.match(summary, /unaffected/i);
  });

  it("explains the low-risk hard block when Phase 4-b is enabled", () => {
    const summary = renderAuthoritySummary("low_risk_hard_block_enabled", false, true);
    assert.match(summary, /fully_prepared/);
    assert.match(summary, /Low-risk/);
    assert.match(summary, /blocked/i);
  });

  it("does not claim low-risk is blocked when Phase 4-b is off", () => {
    const summary = renderAuthoritySummary("soft_warning_enabled", true, false);
    assert.match(summary, /propose-only/i);
    assert.doesNotMatch(summary, /Low-risk recommendations are currently blocked/);
  });
});

describe("promotionGateAuthorityVisibility — renderRiskClassVerdicts", () => {
  it("emits a verdict for each of low/medium/high in canonical order", () => {
    const v = renderRiskClassVerdicts(false, false);
    assert.equal(v.length, 3);
    assert.equal(v[0].riskClass, "low");
    assert.equal(v[1].riskClass, "medium");
    assert.equal(v[2].riskClass, "high");
  });

  it("only marks low-risk as hardBlocked when Phase 4-b is on", () => {
    const off = renderRiskClassVerdicts(false, false);
    assert.equal(off.find(x => x.riskClass === "low")!.hardBlocked, false);
    const on = renderRiskClassVerdicts(false, true);
    assert.equal(on.find(x => x.riskClass === "low")!.hardBlocked, true);
    assert.equal(on.find(x => x.riskClass === "medium")!.hardBlocked, false);
    assert.equal(on.find(x => x.riskClass === "high")!.hardBlocked, false);
  });

  it("only marks low-risk as softWarned when Phase 4-a is on", () => {
    const on = renderRiskClassVerdicts(true, false);
    assert.equal(on.find(x => x.riskClass === "low")!.softWarned, true);
    assert.equal(on.find(x => x.riskClass === "medium")!.softWarned, false);
    assert.equal(on.find(x => x.riskClass === "high")!.softWarned, false);
  });

  it("describes medium/high risk postures as unaffected by Phase 4 flags", () => {
    const v = renderRiskClassVerdicts(true, true);
    const med = v.find(x => x.riskClass === "medium")!;
    const high = v.find(x => x.riskClass === "high")!;
    assert.match(med.posture, /Unaffected by Phase 4/);
    assert.match(high.posture, /Unaffected by Phase 4/);
    assert.match(high.posture, /PROMOTION_GATE_ALLOW_HIGH_RISK/);
  });
});

describe("promotionGateAuthorityVisibility — buildPromotionGateAuthorityVisibility", () => {
  it("returns a stable schema version + label", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      false,
      lowRiskHardBlockFlagOn: false,
    });
    assert.equal(snap.schemaVersion, PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION);
    assert.equal(snap.label, PROMOTION_GATE_AUTHORITY_VISIBILITY_LABEL);
  });

  it("exposes the canonical env-var names for traceability", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      false,
      lowRiskHardBlockFlagOn: false,
    });
    assert.equal(snap.flags.phase4aSoftWarning.envVar, PHASE_4A_ENV);
    assert.equal(snap.flags.phase4bLowRiskBlock.envVar, PHASE_4B_ENV);
    assert.equal(snap.flags.phase4aSoftWarning.phase, "phase4-a");
    assert.equal(snap.flags.phase4bLowRiskBlock.phase, "phase4-b");
  });

  it("reports both flags as default off in the cold path", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      false,
      lowRiskHardBlockFlagOn: false,
    });
    assert.equal(snap.flags.phase4aSoftWarning.enabled, false);
    assert.equal(snap.flags.phase4bLowRiskBlock.enabled, false);
    assert.equal(snap.authorityLevel, "advisory_only");
  });

  it("reports the right authority level for each flag combination", () => {
    const combos: Array<[boolean, boolean, PromotionGateAuthorityLevel]> = [
      [false, false, "advisory_only"],
      [true,  false, "soft_warning_enabled"],
      [false, true,  "low_risk_hard_block_enabled"],
      [true,  true,  "soft_warning_and_low_risk_hard_block_enabled"],
    ];
    for (const [a, b, expected] of combos) {
      const snap = buildPromotionGateAuthorityVisibility({
        softWarningFlagOn:      a,
        lowRiskHardBlockFlagOn: b,
      });
      assert.equal(snap.authorityLevel, expected, `combo a=${a} b=${b}`);
    }
  });

  it("surfaces the Phase 4-b audit finding id and the manual runner path", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      false,
      lowRiskHardBlockFlagOn: false,
    });
    assert.equal(snap.boundaryAuditReference.phase4bFindingId, "phase4b_hard_block_flag_wired");
    assert.match(
      snap.boundaryAuditReference.manualRunnerEntryPoint,
      /auditPromotionBoundary/,
    );
    assert.match(snap.boundaryAuditReference.helperEntryPoint, /promotionBoundaryAudit/);
  });

  it("emits invariants that restate the visibility-only / Pin 11 contract", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      false,
      lowRiskHardBlockFlagOn: false,
    });
    assert.match(snap.invariants.visibilityOnly, /read-only/i);
    assert.match(snap.invariants.singleWriteSiteIntact, /Pin 11/);
    assert.match(snap.invariants.singleWriteSiteIntact, /canPromote/);
    assert.match(snap.invariants.phaseScope, /Medium-risk and high-risk/);
  });

  it("is pure: calling it does not mutate process.env", () => {
    const beforeA = process.env[PHASE_4A_ENV];
    const beforeB = process.env[PHASE_4B_ENV];
    buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      true,
      lowRiskHardBlockFlagOn: true,
    });
    buildPromotionGateAuthorityVisibility();
    assert.equal(process.env[PHASE_4A_ENV], beforeA);
    assert.equal(process.env[PHASE_4B_ENV], beforeB);
  });

  it("reads from process.env when overrides are omitted", () => {
    const prevA = process.env[PHASE_4A_ENV];
    const prevB = process.env[PHASE_4B_ENV];
    try {
      process.env[PHASE_4A_ENV] = "true";
      process.env[PHASE_4B_ENV] = "true";
      const snap = buildPromotionGateAuthorityVisibility();
      assert.equal(snap.flags.phase4aSoftWarning.enabled, true);
      assert.equal(snap.flags.phase4bLowRiskBlock.enabled, true);
      assert.equal(snap.authorityLevel, "soft_warning_and_low_risk_hard_block_enabled");
    } finally {
      if (prevA === undefined) delete process.env[PHASE_4A_ENV];
      else process.env[PHASE_4A_ENV] = prevA;
      if (prevB === undefined) delete process.env[PHASE_4B_ENV];
      else process.env[PHASE_4B_ENV] = prevB;
    }
  });

  it("treats non-'true' env values as off (case-insensitive 'true' is the only on-value)", () => {
    const prevA = process.env[PHASE_4A_ENV];
    try {
      process.env[PHASE_4A_ENV] = "1";
      assert.equal(
        buildPromotionGateAuthorityVisibility().flags.phase4aSoftWarning.enabled,
        false,
      );
      process.env[PHASE_4A_ENV] = "yes";
      assert.equal(
        buildPromotionGateAuthorityVisibility().flags.phase4aSoftWarning.enabled,
        false,
      );
      process.env[PHASE_4A_ENV] = "TRUE";
      assert.equal(
        buildPromotionGateAuthorityVisibility().flags.phase4aSoftWarning.enabled,
        true,
      );
    } finally {
      if (prevA === undefined) delete process.env[PHASE_4A_ENV];
      else process.env[PHASE_4A_ENV] = prevA;
    }
  });

  it("contains plain-English natural-language summary text in the headline and per-flag blocks", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:      false,
      lowRiskHardBlockFlagOn: true,
    });
    assert.match(snap.headline, /low-risk/i);
    assert.match(snap.summary, /Low-risk/);
    assert.match(snap.summary, /Medium-risk/);
    assert.match(snap.summary, /High-risk/);
    assert.match(snap.flags.phase4bLowRiskBlock.currentEffect, /ENABLED/);
    assert.match(snap.flags.phase4aSoftWarning.currentEffect, /DEFAULT OFF/);
  });
});
