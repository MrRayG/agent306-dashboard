/**
 * Integration test: the Autonomy Monitor snapshot exposes the Phase 4
 * promotion-gate authority visibility block.
 *
 * Invariants pinned:
 *   1. Snapshot always carries `promotionGateAuthority` even with both flags off.
 *   2. The block reflects env flag changes deterministically.
 *   3. The block does NOT inject any new mutation surface — the snapshot
 *      remains read-only (no apply/promote endpoint is added).
 *   4. Pin 11 is preserved: the snapshot does not include a control
 *      surface for promotion mutation.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase4-vis-monitor-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const PHASE_4A_ENV = "PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY";
const PHASE_4B_ENV = "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY";

const { buildAutonomyMonitorSnapshot } = await import("../autonomyMonitor.ts");

describe("autonomyMonitor — promotionGateAuthority block", () => {
  before(() => {
    delete process.env[PHASE_4A_ENV];
    delete process.env[PHASE_4B_ENV];
  });

  it("is present on the snapshot even when both flags are off", () => {
    delete process.env[PHASE_4A_ENV];
    delete process.env[PHASE_4B_ENV];
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-13T12:00:00Z"));
    assert.ok(snap.promotionGateAuthority, "promotionGateAuthority missing");
    assert.equal(snap.promotionGateAuthority.authorityLevel, "advisory_only");
    assert.equal(snap.promotionGateAuthority.flags.phase4aSoftWarning.enabled, false);
    assert.equal(snap.promotionGateAuthority.flags.phase4bLowRiskBlock.enabled, false);
  });

  it("reflects Phase 4-a being enabled", () => {
    process.env[PHASE_4A_ENV] = "true";
    delete process.env[PHASE_4B_ENV];
    try {
      const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-13T12:00:00Z"));
      assert.equal(snap.promotionGateAuthority.authorityLevel, "soft_warning_enabled");
      assert.equal(snap.promotionGateAuthority.flags.phase4aSoftWarning.enabled, true);
      assert.equal(snap.promotionGateAuthority.flags.phase4bLowRiskBlock.enabled, false);
    } finally {
      delete process.env[PHASE_4A_ENV];
    }
  });

  it("reflects Phase 4-b being enabled (low-risk hard block)", () => {
    delete process.env[PHASE_4A_ENV];
    process.env[PHASE_4B_ENV] = "true";
    try {
      const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-13T12:00:00Z"));
      assert.equal(snap.promotionGateAuthority.authorityLevel, "low_risk_hard_block_enabled");
      assert.equal(snap.promotionGateAuthority.flags.phase4bLowRiskBlock.enabled, true);
      const lowRisk = snap.promotionGateAuthority.riskClassVerdicts.find(v => v.riskClass === "low");
      assert.ok(lowRisk);
      assert.equal(lowRisk!.hardBlocked, true);
      const med = snap.promotionGateAuthority.riskClassVerdicts.find(v => v.riskClass === "medium");
      assert.equal(med!.hardBlocked, false);
      const high = snap.promotionGateAuthority.riskClassVerdicts.find(v => v.riskClass === "high");
      assert.equal(high!.hardBlocked, false);
    } finally {
      delete process.env[PHASE_4B_ENV];
    }
  });

  it("reflects both flags enabled", () => {
    process.env[PHASE_4A_ENV] = "true";
    process.env[PHASE_4B_ENV] = "true";
    try {
      const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-13T12:00:00Z"));
      assert.equal(
        snap.promotionGateAuthority.authorityLevel,
        "soft_warning_and_low_risk_hard_block_enabled",
      );
    } finally {
      delete process.env[PHASE_4A_ENV];
      delete process.env[PHASE_4B_ENV];
    }
  });

  it("preserves Pin 7 / Pin 11: the snapshot has no apply/promote/mutation field", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-13T12:00:00Z"));
    // Spot-check: the visibility block's top-level fields are descriptive,
    // not actionable. No "apply", "promote", "mutate", or "submit" keys.
    const json = JSON.stringify(snap.promotionGateAuthority);
    assert.doesNotMatch(json, /"applyEndpoint"/);
    assert.doesNotMatch(json, /"mutationEndpoint"/);
    assert.doesNotMatch(json, /"approveEndpoint"/);
    assert.doesNotMatch(json, /"rejectEndpoint"/);
    // Safety boundary remains intact.
    assert.equal(snap.safetyBoundary.noAutoPromote, true);
    assert.equal(snap.safetyBoundary.publicApprovalRequired, true);
  });

  it("surfaces natural-language headline and summary text on the snapshot", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-13T12:00:00Z"));
    assert.equal(typeof snap.promotionGateAuthority.headline, "string");
    assert.ok(snap.promotionGateAuthority.headline.length > 20);
    assert.equal(typeof snap.promotionGateAuthority.summary, "string");
    assert.ok(snap.promotionGateAuthority.summary.length > 80);
  });
});
