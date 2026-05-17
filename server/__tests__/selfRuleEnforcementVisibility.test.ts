/**
 * Tests for the read-only Self-Rule Enforcement visibility builder.
 *
 * Invariants pinned by this file:
 *   1. The empty / zero-rules / zero-events state returns a well-formed
 *      snapshot with `activeRules=0`, empty arrays, and a headline that
 *      explicitly says nothing has registered.
 *   2. When an active executable rule is registered (via the canonical
 *      registerRule path), the snapshot's counts.byPrimitive and latestFirings
 *      reflect it after a tick.
 *   3. When a ratio_rule's lastOutcome is the deficit form
 *      (`deficit_logged:+N_<noun>`), the snapshot surfaces a structured
 *      RatioRuleDeficit entry with the parsed noun, deficit, and a summary
 *      explaining it is diagnostic / observable only.
 *   4. When a ruleRegistrationOnApply engine_events row exists, the snapshot
 *      surfaces it under latestRegistrations with the right shape.
 *   5. The builder is read-only — calling it does NOT mutate
 *      enforcement_rules.json or insert any engine_events row.
 *
 * Run: npx tsx --test server/__tests__/selfRuleEnforcementVisibility.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "selfRuleEnforceVis-test-"),
);
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const ENFORCEMENT_FILE = path.join(TMP_DIR, "enforcement_rules.json");

const { db } = await import("../db.js");
const { engineEvents } = await import("@shared/schema");
const {
  registerRule,
  tickEnforcer,
} = await import("../actionEnforcer.js");
type EnforcementRule = import("../actionEnforcer.js").EnforcementRule;
const { logEvent } = await import("../observability/structuredLog.js");
const {
  buildSelfRuleEnforcementVisibility,
} = await import("../selfRuleEnforcementVisibility.js");

function wipe(): void {
  try { db.delete(engineEvents).run(); } catch {}
  try {
    if (fs.existsSync(ENFORCEMENT_FILE)) fs.unlinkSync(ENFORCEMENT_FILE);
  } catch {}
}

function hashFile(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(p))
    .digest("hex");
}

function makeRule(overrides: Partial<EnforcementRule> = {}): EnforcementRule {
  return {
    id: `rule_${Math.random().toString(36).slice(2, 9)}`,
    insightId: `insight_${Math.random().toString(36).slice(2, 9)}`,
    primitive: "ratio_rule",
    params: {
      inputCount: 1,
      inputNoun: "kb_entry",
      outputCount: 1,
      outputNoun: "archived",
    },
    criterion: "test criterion",
    createdAt: Date.now(),
    enabled: true,
    fireCount: 0,
    lastFiredAt: null,
    ...overrides,
  };
}

/** Force a rule's persisted state by writing it directly to the store file.
 *  Used to inject deterministic lastOutcome / lastFiredAt for snapshot tests
 *  without relying on the live tickEnforcer behaviour for downstream stores. */
function writeStoreDirect(rules: EnforcementRule[]): void {
  fs.writeFileSync(
    ENFORCEMENT_FILE,
    JSON.stringify({ rules, lastUpdated: new Date().toISOString() }, null, 2),
  );
}

describe("buildSelfRuleEnforcementVisibility", () => {
  beforeEach(() => wipe());

  it("returns zero-state when no rules are registered and no events exist", () => {
    const snap = buildSelfRuleEnforcementVisibility(new Date("2026-05-16T12:00:00Z"));
    assert.equal(snap.counts.activeRules, 0);
    assert.deepEqual(snap.counts.byPrimitive, {});
    assert.equal(snap.counts.recentRegistrationEvents, 0);
    assert.equal(snap.counts.recentRegistrationsSucceeded, 0);
    assert.equal(snap.counts.recentRegistrationsRefused, 0);
    assert.deepEqual(snap.latestRegistrations, []);
    assert.deepEqual(snap.latestFirings, []);
    assert.deepEqual(snap.ratioDeficits, []);
    assert.equal(snap.latestTick, null);
    assert.match(
      snap.headline,
      /No executable self-rules are registered/i,
    );
    assert.match(
      snap.enforcementSemanticsNote,
      /visibility-only|observation only/i,
    );
    assert.ok(snap.visibilityLimitations.length > 0);
    assert.equal(snap.generatedAt, "2026-05-16T12:00:00.000Z");
  });

  it("counts active rules by primitive after registerRule", () => {
    // ttl_rule needs a real target param so the hygiene filter does not
    // quarantine it; the default fixture is shaped for ratio_rule and has
    // no target.
    registerRule(makeRule({ primitive: "ratio_rule" }));
    registerRule(makeRule({
      primitive: "ttl_rule",
      params: { days: 14, target: "testing_hypothesis" },
    }));
    registerRule(makeRule({
      primitive: "ttl_rule",
      params: { days: 30, target: "kb_entry" },
    }));
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.counts.activeRules, 3);
    assert.equal(snap.counts.byPrimitive.ratio_rule, 1);
    assert.equal(snap.counts.byPrimitive.ttl_rule, 2);
  });

  it("surfaces a ratio_rule deficit when lastOutcome is deficit_logged form (legacy fallback path)", () => {
    const ruleId = "rule_test_deficit";
    const insightId = "insight_test_deficit";
    const firedAt = Date.parse("2026-05-15T10:00:00Z");
    writeStoreDirect([
      makeRule({
        id: ruleId,
        insightId,
        primitive: "ratio_rule",
        fireCount: 3,
        lastFiredAt: firedAt,
        lastOutcome: "deficit_logged:+174_archived",
        sideEffectCount: 3,
      }),
    ]);
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.ratioDeficits.length, 1);
    const d = snap.ratioDeficits[0];
    assert.equal(d.ruleId, ruleId);
    assert.equal(d.insightId, insightId);
    assert.equal(d.deficit, 174);
    assert.equal(d.outputNoun, "archived");
    assert.equal(d.lastFiredAt, "2026-05-15T10:00:00.000Z");
    assert.equal(d.rawOutcome, "deficit_logged:+174_archived");
    assert.equal(d.fromStructuredEvent, false);
    assert.match(d.summary, /\+174 archived/);
    assert.match(
      d.summary,
      /bounded corrective obligation has been queued|not a hard block/i,
    );
    // Latest firings includes the rule
    assert.equal(snap.latestFirings.length, 1);
    assert.equal(snap.latestFirings[0].ruleId, ruleId);
    assert.equal(snap.latestFirings[0].fireCount, 3);
    assert.equal(snap.latestFirings[0].sideEffectCount, 3);
  });

  it("prefers a structured ratioRuleDeficit event over parsing lastOutcome", () => {
    const ruleId = "rule_struct_deficit";
    const insightId = "insight_struct";
    const firedAt = Date.parse("2026-05-15T10:00:00Z");
    writeStoreDirect([
      makeRule({
        id: ruleId,
        insightId,
        primitive: "ratio_rule",
        fireCount: 4,
        lastFiredAt: firedAt,
        lastOutcome: "deficit_logged:+174_archived",
        sideEffectCount: 4,
      }),
    ]);
    logEvent({
      engine: "actionEnforcer",
      event: "ratioRuleDeficit",
      level: "info",
      data: {
        ruleId,
        insightId,
        sourceInsightId: insightId,
        expectedCount: 226,
        actualCount: 52,
        deficitCount: 174,
        outputNoun: "archived",
        inputCount: 1131,
        inputNoun: "kb_entry",
        tickedAt: firedAt,
      },
    });
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.ratioDeficits.length, 1);
    const d = snap.ratioDeficits[0];
    assert.equal(d.fromStructuredEvent, true);
    assert.equal(d.deficit, 174);
    assert.equal(d.outputNoun, "archived");
    assert.equal(d.expectedCount, 226);
    assert.equal(d.actualCount, 52);
    assert.equal(d.inputCount, 1131);
    assert.equal(d.inputNoun, "kb_entry");
    assert.match(d.summary, /have 52, expected 226 for 1131 kb_entry/);
    assert.match(d.summary, /Rule fired; deficit observed; a bounded corrective obligation has been queued/);
  });

  it("surfaces a structured actionEnforcer.tick event as latestTick", () => {
    logEvent({
      engine: "actionEnforcer",
      event: "tick",
      level: "info",
      data: {
        tickedAt: Date.parse("2026-05-15T11:00:00Z"),
        totalRules: 36,
        rulesChecked: 36,
        firedRules: 36,
        sideEffects: 10,
        byPrimitive: { ratio_rule: 8, ttl_rule: 4, archive_rule: 24 },
      },
    });
    const snap = buildSelfRuleEnforcementVisibility();
    assert.ok(snap.latestTick);
    const t = snap.latestTick!;
    assert.equal(t.totalRules, 36);
    assert.equal(t.rulesChecked, 36);
    assert.equal(t.firedRules, 36);
    assert.equal(t.sideEffects, 10);
    assert.deepEqual(t.byPrimitive, { ratio_rule: 8, ttl_rule: 4, archive_rule: 24 });
    assert.match(t.summary, /fired 36\/36 rules/);
    assert.match(t.summary, /10 side effects/);
    assert.match(t.summary, /ratio_rule=8/);
  });

  it("returns the newest tick event when multiple exist", () => {
    logEvent({
      engine: "actionEnforcer",
      event: "tick",
      level: "info",
      data: { tickedAt: 1, totalRules: 1, rulesChecked: 1, firedRules: 1, sideEffects: 0, byPrimitive: { ttl_rule: 1 } },
    });
    logEvent({
      engine: "actionEnforcer",
      event: "tick",
      level: "info",
      data: { tickedAt: 2, totalRules: 2, rulesChecked: 2, firedRules: 2, sideEffects: 1, byPrimitive: { ratio_rule: 2 } },
    });
    const snap = buildSelfRuleEnforcementVisibility();
    assert.ok(snap.latestTick);
    assert.equal(snap.latestTick!.firedRules, 2);
    assert.equal(snap.latestTick!.totalRules, 2);
    assert.deepEqual(snap.latestTick!.byPrimitive, { ratio_rule: 2 });
  });

  it("does NOT surface a deficit when ratio rule is satisfied", () => {
    writeStoreDirect([
      makeRule({
        primitive: "ratio_rule",
        fireCount: 1,
        lastFiredAt: Date.now(),
        lastOutcome: "ratio met: 12 archived vs 10 expected",
      }),
    ]);
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.ratioDeficits.length, 0);
    // But the rule is still active in the count
    assert.equal(snap.counts.activeRules, 1);
    assert.equal(snap.counts.byPrimitive.ratio_rule, 1);
  });

  it("surfaces ruleRegistrationOnApply events as latestRegistrations", () => {
    logEvent({
      engine: "selfRecommendation",
      event: "ruleRegistrationOnApply",
      level: "info",
      data: {
        recommendationId: "rec_abc",
        sourceInsightId: "insight_xyz",
        registered: true,
        ruleId: "rule_evo_123",
        primitive: "ratio_rule",
      },
    });
    logEvent({
      engine: "selfRecommendation",
      event: "ruleRegistrationOnApply",
      level: "warn",
      data: {
        recommendationId: "rec_refused",
        registered: false,
        reason: "no_source_insight_id",
      },
    });
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.counts.recentRegistrationEvents, 2);
    assert.equal(snap.counts.recentRegistrationsSucceeded, 1);
    assert.equal(snap.counts.recentRegistrationsRefused, 1);
    // Newest first
    const recIds = snap.latestRegistrations.map(r => r.recommendationId);
    assert.deepEqual(recIds, ["rec_refused", "rec_abc"]);

    const okEntry = snap.latestRegistrations.find(r => r.recommendationId === "rec_abc")!;
    assert.equal(okEntry.registered, true);
    assert.equal(okEntry.ruleId, "rule_evo_123");
    assert.equal(okEntry.primitive, "ratio_rule");
    assert.equal(okEntry.sourceInsightId, "insight_xyz");
    assert.match(okEntry.summary, /registered a ratio_rule/);

    const noEntry = snap.latestRegistrations.find(r => r.recommendationId === "rec_refused")!;
    assert.equal(noEntry.registered, false);
    assert.equal(noEntry.reason, "no_source_insight_id");
    assert.match(noEntry.summary, /did NOT register/);
  });

  it("is read-only — calling builder does not mutate enforcement_rules.json or insert engine_events", () => {
    writeStoreDirect([
      makeRule({
        primitive: "ratio_rule",
        fireCount: 1,
        lastFiredAt: Date.now(),
        lastOutcome: "deficit_logged:+5_archived",
      }),
    ]);
    const fileBefore = hashFile(ENFORCEMENT_FILE);
    const rowsBefore = db.select().from(engineEvents).all().length;
    buildSelfRuleEnforcementVisibility();
    buildSelfRuleEnforcementVisibility();
    const fileAfter = hashFile(ENFORCEMENT_FILE);
    const rowsAfter = db.select().from(engineEvents).all().length;
    assert.equal(fileAfter, fileBefore, "enforcement_rules.json must not be mutated");
    assert.equal(rowsAfter, rowsBefore, "no engine_events row may be inserted by the builder");
  });

  it("end-to-end: register a rule, tick it, snapshot shows the firing", async () => {
    registerRule(
      makeRule({
        primitive: "ttl_rule",
        params: { days: 30, target: "unknown_target_to_force_no_op" },
      }),
    );
    await tickEnforcer();
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.counts.activeRules, 1);
    assert.equal(snap.counts.byPrimitive.ttl_rule, 1);
    assert.equal(snap.latestFirings.length, 1);
    assert.equal(snap.latestFirings[0].primitive, "ttl_rule");
    assert.ok(snap.latestFirings[0].fireCount >= 1);
    assert.ok(snap.latestFirings[0].lastFiredAt);
    // ttl_rule with unknown target ends up "no-op (target=...)" — not a deficit
    assert.equal(snap.ratioDeficits.length, 0);
  });
});

describe("buildAutonomyMonitorSnapshot wires selfRuleEnforcement", () => {
  it("includes selfRuleEnforcement on the AutonomyMonitorSnapshot", async () => {
    wipe();
    const { buildAutonomyMonitorSnapshot } = await import("../autonomyMonitor.js");
    const snap = buildAutonomyMonitorSnapshot();
    assert.ok(snap.selfRuleEnforcement, "snapshot must expose selfRuleEnforcement");
    assert.ok(typeof snap.selfRuleEnforcement.headline === "string");
    assert.ok(typeof snap.selfRuleEnforcement.counts === "object");
    assert.ok(Array.isArray(snap.selfRuleEnforcement.latestRegistrations));
    assert.ok(Array.isArray(snap.selfRuleEnforcement.latestFirings));
    assert.ok(Array.isArray(snap.selfRuleEnforcement.ratioDeficits));
    assert.ok(Array.isArray(snap.selfRuleEnforcement.visibilityLimitations));
    // latestTick is part of the new schema — null is acceptable in zero-state.
    assert.ok(
      snap.selfRuleEnforcement.latestTick === null ||
      typeof snap.selfRuleEnforcement.latestTick === "object",
    );
  });
});
