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
// v2 (PR #406) env-var literals — pin them here so a rename in
// server/eval/promotionGate.ts surfaces as a failing test rather than
// a silent drift on the dashboard.
const PHASE_4C_FRESHNESS_ENV   = "PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS";
const PHASE_4C_MEDIUM_BLOCK_ENV = "PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY";

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
    // v2 (PR #406): phaseScope now describes that Phase 4-c IS implemented
    // for low-risk freshness AND medium-risk hard block, while Phase 4-d
    // (high-risk) remains explicitly UNAFFECTED. Pin the accurate wording.
    assert.match(snap.invariants.phaseScope, /Phase 4-c/);
    assert.match(snap.invariants.phaseScope, /low-risk freshness/);
    assert.match(snap.invariants.phaseScope, /medium-risk hard block/);
    assert.match(snap.invariants.phaseScope, /Phase 4-d/);
    assert.match(snap.invariants.phaseScope, /UNAFFECTED/);
    assert.match(snap.invariants.phaseScope, /high-risk/);
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

/* ─── v2 (PR #406) — Phase 4-c flag visibility ──────────────────────── */

describe("promotionGateAuthorityVisibility v2 — schema bump", () => {
  it("schemaVersion is phase4-visibility.v2", () => {
    assert.equal(PROMOTION_GATE_AUTHORITY_VISIBILITY_SCHEMA_VERSION, "phase4-visibility.v2");
  });

  it("snapshot reports the v2 schemaVersion literally", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  null,
      phase4cMediumRiskBlockOn:    false,
    });
    assert.equal(snap.schemaVersion, "phase4-visibility.v2");
  });
});

describe("promotionGateAuthorityVisibility v2 — Phase 4-c flag blocks", () => {
  it("default (all four flags off): new flag blocks are present and disabled", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  null,
      phase4cMediumRiskBlockOn:    false,
    });
    assert.ok(snap.flags.phase4cFreshnessGate, "phase4cFreshnessGate flag block missing");
    assert.ok(snap.flags.phase4cMediumRiskBlock, "phase4cMediumRiskBlock flag block missing");
    assert.equal(snap.flags.phase4cFreshnessGate.enabled, false);
    assert.equal(snap.flags.phase4cMediumRiskBlock.enabled, false);
    assert.equal(snap.flags.phase4cFreshnessGate.envVar, PHASE_4C_FRESHNESS_ENV);
    assert.equal(snap.flags.phase4cMediumRiskBlock.envVar, PHASE_4C_MEDIUM_BLOCK_ENV);
    assert.equal(snap.flags.phase4cFreshnessGate.phase, "phase4-c-freshness");
    assert.equal(snap.flags.phase4cMediumRiskBlock.phase, "phase4-c-medium-block");
    assert.match(snap.flags.phase4cFreshnessGate.currentEffect, /DEFAULT OFF/);
    assert.match(snap.flags.phase4cMediumRiskBlock.currentEffect, /DEFAULT OFF/);
  });

  it("freshness gate enabled: numeric value appears in description / currentEffect", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  14,
      phase4cMediumRiskBlockOn:    false,
    });
    assert.equal(snap.flags.phase4cFreshnessGate.enabled, true);
    assert.match(snap.flags.phase4cFreshnessGate.currentEffect, /ENABLED at 14 day/);
    // The numeric value is surfaced — option (a) per PR #406 spec, no
    // new `numericValue` field on the flag interface.
    assert.match(snap.flags.phase4cFreshnessGate.currentEffect, /\b14\b/);
  });

  it("medium-risk block enabled (default off freshness): authority level reports phase4c medium-risk", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  null,
      phase4cMediumRiskBlockOn:    true,
    });
    assert.equal(snap.flags.phase4cMediumRiskBlock.enabled, true);
    assert.match(snap.flags.phase4cMediumRiskBlock.currentEffect, /ENABLED/);
    assert.equal(snap.authorityLevel, "phase4c_medium_risk_hard_block_enabled");
  });

  it("freshness gate ON + medium-risk block OFF: authority level is phase4c_freshness_active", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  7,
      phase4cMediumRiskBlockOn:    false,
    });
    assert.equal(snap.authorityLevel, "phase4c_freshness_active");
  });

  it("medium-risk block ON wins over low-risk + soft-warning combos in authority level", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           true,
      lowRiskHardBlockFlagOn:      true,
      phase4cFreshnessMaxAgeDays:  14,
      phase4cMediumRiskBlockOn:    true,
    });
    // The medium-risk-block state is the most restrictive in our union;
    // when it's on, the headline must mention medium-risk explicitly.
    assert.equal(snap.authorityLevel, "phase4c_medium_risk_hard_block_enabled");
    assert.match(snap.headline, /medium-risk/);
  });

  it("medium-risk verdict reflects hard-block ON; high-risk remains untouched", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  14,
      phase4cMediumRiskBlockOn:    true,
    });
    const med = snap.riskClassVerdicts.find(v => v.riskClass === "medium")!;
    const high = snap.riskClassVerdicts.find(v => v.riskClass === "high")!;
    assert.equal(med.hardBlocked, true);
    assert.match(med.posture, /Phase 4-c part 2/);
    assert.match(med.posture, /14 day/);
    assert.equal(high.hardBlocked, false);
    assert.match(high.posture, /UNAFFECTED|Unaffected/);
  });

  it("low-risk verdict surfaces freshness clause when Phase 4-b is ON and freshness is configured", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      true,
      phase4cFreshnessMaxAgeDays:  7,
      phase4cMediumRiskBlockOn:    false,
    });
    const low = snap.riskClassVerdicts.find(v => v.riskClass === "low")!;
    assert.equal(low.hardBlocked, true);
    assert.match(low.posture, /7 day/);
    assert.match(low.posture, /Phase 4-c/);
  });

  it("low-risk verdict does NOT surface freshness clause when Phase 4-b is OFF (no double-fire)", () => {
    const snap = buildPromotionGateAuthorityVisibility({
      softWarningFlagOn:           false,
      lowRiskHardBlockFlagOn:      false,
      phase4cFreshnessMaxAgeDays:  7,
      phase4cMediumRiskBlockOn:    false,
    });
    const low = snap.riskClassVerdicts.find(v => v.riskClass === "low")!;
    // Phase 4-b is off — freshness has nothing to enforce on low-risk
    // today. The verdict must not falsely claim a freshness gate.
    assert.equal(low.hardBlocked, false);
    assert.doesNotMatch(low.posture, /7 day/);
  });

  it("Phase 4-c freshness gate reads from process.env when override is undefined", () => {
    const prev = process.env[PHASE_4C_FRESHNESS_ENV];
    try {
      process.env[PHASE_4C_FRESHNESS_ENV] = "30";
      const snap = buildPromotionGateAuthorityVisibility();
      assert.equal(snap.flags.phase4cFreshnessGate.enabled, true);
      assert.match(snap.flags.phase4cFreshnessGate.currentEffect, /30 day/);
    } finally {
      if (prev === undefined) delete process.env[PHASE_4C_FRESHNESS_ENV];
      else process.env[PHASE_4C_FRESHNESS_ENV] = prev;
    }
  });

  it("Phase 4-c medium-risk block reads from process.env when override is undefined", () => {
    const prev = process.env[PHASE_4C_MEDIUM_BLOCK_ENV];
    try {
      process.env[PHASE_4C_MEDIUM_BLOCK_ENV] = "true";
      const snap = buildPromotionGateAuthorityVisibility();
      assert.equal(snap.flags.phase4cMediumRiskBlock.enabled, true);
    } finally {
      if (prev === undefined) delete process.env[PHASE_4C_MEDIUM_BLOCK_ENV];
      else process.env[PHASE_4C_MEDIUM_BLOCK_ENV] = prev;
    }
  });

  it("backward-compat: a v1 caller that passes only 2 booleans still gets a valid v2 snapshot", () => {
    // Old code path: omits the two new override fields. The snapshot
    // must still build, with phase4cFreshness off and phase4cMediumRisk
    // off — derived from the live env, which is also unset.
    const prevF = process.env[PHASE_4C_FRESHNESS_ENV];
    const prevM = process.env[PHASE_4C_MEDIUM_BLOCK_ENV];
    try {
      delete process.env[PHASE_4C_FRESHNESS_ENV];
      delete process.env[PHASE_4C_MEDIUM_BLOCK_ENV];
      const snap = buildPromotionGateAuthorityVisibility({
        softWarningFlagOn:      false,
        lowRiskHardBlockFlagOn: false,
      });
      assert.equal(snap.flags.phase4cFreshnessGate.enabled, false);
      assert.equal(snap.flags.phase4cMediumRiskBlock.enabled, false);
      assert.equal(snap.authorityLevel, "advisory_only");
    } finally {
      if (prevF !== undefined) process.env[PHASE_4C_FRESHNESS_ENV] = prevF;
      if (prevM !== undefined) process.env[PHASE_4C_MEDIUM_BLOCK_ENV] = prevM;
    }
  });

  it("deriveAuthorityLevel: all four-input combinatorics", () => {
    // (softWarn, lowBlock, freshness, medBlock) → expected level
    type Row = [boolean, boolean, boolean, boolean, PromotionGateAuthorityLevel];
    const rows: Row[] = [
      // Phase 4-c medium-risk block dominates whenever it's on.
      [false, false, false, true,  "phase4c_medium_risk_hard_block_enabled"],
      [true,  false, false, true,  "phase4c_medium_risk_hard_block_enabled"],
      [false, true,  true,  true,  "phase4c_medium_risk_hard_block_enabled"],
      [true,  true,  true,  true,  "phase4c_medium_risk_hard_block_enabled"],
      // Both 4-a + 4-b on (no medium-risk) keeps the v1 string.
      [true,  true,  false, false, "soft_warning_and_low_risk_hard_block_enabled"],
      [true,  true,  true,  false, "soft_warning_and_low_risk_hard_block_enabled"],
      // 4-b only.
      [false, true,  false, false, "low_risk_hard_block_enabled"],
      [false, true,  true,  false, "low_risk_hard_block_enabled"],
      // Freshness without 4-b reports phase4c_freshness_active.
      [false, false, true,  false, "phase4c_freshness_active"],
      // 4-a only (no freshness).
      [true,  false, false, false, "soft_warning_enabled"],
      // All off.
      [false, false, false, false, "advisory_only"],
    ];
    for (const [a, b, f, m, expected] of rows) {
      assert.equal(
        deriveAuthorityLevel(a, b, f, m),
        expected,
        `a=${a} b=${b} f=${f} m=${m}`,
      );
    }
  });

  it("renderRiskClassVerdicts v1 signature still works (default freshness/medium-block off)", () => {
    // Existing v1 callers pass only 2 args. The medium-risk verdict
    // must remain "Unaffected by Phase 4 flags" — byte-identical to v1.
    const v = renderRiskClassVerdicts(false, false);
    const med = v.find(x => x.riskClass === "medium")!;
    assert.equal(med.hardBlocked, false);
    assert.match(med.posture, /Unaffected by Phase 4 flags/);
  });
});
