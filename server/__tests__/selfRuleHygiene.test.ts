/**
 * Tests for selfRuleHygiene + read-side quarantine integration.
 *
 * Invariants pinned by this file:
 *   1. Malformed legacy archive_rule rows whose target is a parser
 *      fragment / stopword (`or`, `at`, `timer`, `all`, `orphaned`) are
 *      detected by isMalformedRule and flagged with a reason.
 *   2. Valid rules with real entity targets (`testing_hypothesis`,
 *      `kb_entry`, `dream_insight`) and well-formed nouns are NOT
 *      quarantined.
 *   3. ActionEnforcer.tickEnforcer() skips quarantined rules — their
 *      fireCount does not advance, and they are not counted toward
 *      rulesFired / sideEffects. The tick result includes a
 *      rulesQuarantined count.
 *   4. tickEnforcer() still fires valid rules normally (control case).
 *   5. The Self-Rule Enforcement visibility builder surfaces a
 *      quarantinedRules array + counts.quarantinedRules > 0 when
 *      malformed legacy rules are on the registry, and the byPrimitive
 *      counts reflect only the enforceable subset.
 *   6. Quarantine is read-side only — enforcement_rules.json is NOT
 *      mutated by the detector or by the tick filter.
 *
 * Run: npx tsx --test server/__tests__/selfRuleHygiene.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "selfRuleHygiene-test-"),
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
  getAllActiveRules,
  getEnforceableActiveRules,
} = await import("../actionEnforcer.js");
type EnforcementRule = import("../actionEnforcer.js").EnforcementRule;
const {
  isMalformedRule,
  partitionByHygiene,
  summarizeMalformed,
} = await import("../selfRuleHygiene.js");
const {
  buildSelfRuleEnforcementVisibility,
} = await import("../selfRuleEnforcementVisibility.js");

function wipe(): void {
  try { db.delete(engineEvents).run(); } catch {}
  try { if (fs.existsSync(ENFORCEMENT_FILE)) fs.unlinkSync(ENFORCEMENT_FILE); } catch {}
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
    primitive: "ttl_rule",
    params: { days: 30, target: "testing_hypothesis" },
    criterion: "test criterion",
    createdAt: Date.now(),
    enabled: true,
    fireCount: 0,
    lastFiredAt: null,
    ...overrides,
  };
}

function writeStoreDirect(rules: EnforcementRule[]): void {
  fs.writeFileSync(
    ENFORCEMENT_FILE,
    JSON.stringify({ rules, lastUpdated: new Date().toISOString() }, null, 2),
  );
}

describe("isMalformedRule — detector", () => {
  beforeEach(() => wipe());

  it("flags archive_rule with target=or as malformed (production-observed)", () => {
    const r = makeRule({
      primitive: "archive_rule",
      params: { target: "or", criteria: "" },
    });
    const diag = isMalformedRule(r);
    assert.equal(diag.malformed, true);
    assert.match(diag.reasons.join("|"), /archive_rule/);
    assert.match(diag.reasons.join("|"), /too short|stopword/);
  });

  it("flags archive_rule with target=at, timer, all, orphaned", () => {
    for (const bad of ["at", "timer", "all", "orphaned"]) {
      const r = makeRule({
        primitive: "archive_rule",
        params: { target: bad, criteria: "" },
      });
      const diag = isMalformedRule(r);
      assert.equal(diag.malformed, true, `expected target="${bad}" to be malformed`);
      assert.ok(
        diag.reasons.some(x => x.includes(bad)),
        `reason should mention the bad target "${bad}"`,
      );
    }
  });

  it("flags ttl_rule and gate_rule with stopword targets too", () => {
    const ttl = makeRule({
      primitive: "ttl_rule",
      params: { days: 30, target: "all" },
    });
    const gate = makeRule({
      primitive: "gate_rule",
      params: { description: "x", target: "or" },
    });
    assert.equal(isMalformedRule(ttl).malformed, true);
    assert.equal(isMalformedRule(gate).malformed, true);
  });

  it("does NOT flag valid archive_rule targets (testing_hypothesis, kb_entry, dream_insight)", () => {
    for (const good of [
      "testing_hypothesis",
      "kb_entry",
      "dream_insight",
      "knowledge_entry",
      "speculative_dream",
      "kb_question",
    ]) {
      const r = makeRule({
        primitive: "archive_rule",
        params: { target: good, criteria: "" },
      });
      const diag = isMalformedRule(r);
      assert.equal(
        diag.malformed,
        false,
        `expected valid target "${good}" to pass, got reasons=${diag.reasons.join("|")}`,
      );
    }
  });

  it("does NOT flag ratio_rule with valid kb_entry/archived nouns", () => {
    const r = makeRule({
      primitive: "ratio_rule",
      params: {
        inputCount: 1,
        inputNoun: "kb_entry",
        outputCount: 1,
        outputNoun: "archived",
      },
    });
    assert.equal(isMalformedRule(r).malformed, false);
  });

  it("flags ratio_rule whose inputNoun OR outputNoun is a stopword", () => {
    const badInput = makeRule({
      primitive: "ratio_rule",
      params: { inputCount: 1, inputNoun: "or", outputCount: 1, outputNoun: "synthesis" },
    });
    const badOutput = makeRule({
      primitive: "ratio_rule",
      params: { inputCount: 1, inputNoun: "kb_entry", outputCount: 1, outputNoun: "or" },
    });
    assert.equal(isMalformedRule(badInput).malformed, true);
    assert.equal(isMalformedRule(badOutput).malformed, true);
  });

  it("flags target-primitive rule when target is missing entirely", () => {
    const r = makeRule({
      primitive: "archive_rule",
      params: { criteria: "stale" }, // no target
    });
    const diag = isMalformedRule(r);
    assert.equal(diag.malformed, true);
    assert.match(diag.reasons.join(" "), /missing target/);
  });

  it("flags any target shorter than 3 chars even if not a known stopword", () => {
    // Pure short fragment — `xy` is not in the stopword list but is too
    // short to be a real entity descriptor and contains no actionable token.
    const r = makeRule({
      primitive: "archive_rule",
      params: { target: "xy", criteria: "" },
    });
    assert.equal(isMalformedRule(r).malformed, true);
  });

  it("partitionByHygiene splits a mixed registry correctly", () => {
    const rules = [
      makeRule({ id: "ok-1", primitive: "ttl_rule",     params: { days: 14, target: "testing_hypothesis" } }),
      makeRule({ id: "bad-1", primitive: "archive_rule", params: { target: "or",  criteria: "" } }),
      makeRule({ id: "ok-2", primitive: "archive_rule", params: { target: "kb_entry", criteria: "" } }),
      makeRule({ id: "bad-2", primitive: "archive_rule", params: { target: "timer", criteria: "" } }),
    ];
    const { enforceable, quarantined } = partitionByHygiene(rules);
    assert.deepEqual(enforceable.map(r => r.id).sort(), ["ok-1", "ok-2"]);
    assert.deepEqual(quarantined.map(q => q.rule.id).sort(), ["bad-1", "bad-2"]);
  });

  it("summarizeMalformed returns empty for valid rules and a non-empty reason for bad ones", () => {
    const ok = makeRule({ primitive: "archive_rule", params: { target: "kb_entry", criteria: "" } });
    const bad = makeRule({ primitive: "archive_rule", params: { target: "or", criteria: "" } });
    assert.equal(summarizeMalformed(ok), "");
    assert.ok(summarizeMalformed(bad).length > 0);
  });
});

describe("ActionEnforcer.tickEnforcer — quarantined rules are skipped", () => {
  beforeEach(() => wipe());

  it("skips quarantined rules at tick time and counts them in rulesQuarantined", async () => {
    registerRule(
      makeRule({
        id: "valid_rule",
        primitive: "ttl_rule",
        params: { days: 30, target: "testing_hypothesis" },
      }),
    );
    registerRule(
      makeRule({
        id: "quarantine_or",
        primitive: "archive_rule",
        params: { target: "or", criteria: "" },
      }),
    );
    registerRule(
      makeRule({
        id: "quarantine_timer",
        primitive: "archive_rule",
        params: { target: "timer", criteria: "" },
      }),
    );

    const result = await tickEnforcer();
    // Valid rule fires; quarantined rules are skipped entirely.
    assert.equal(result.rulesChecked, 1, "only the valid rule is checked");
    assert.equal(result.rulesFired, 1);
    assert.equal(result.rulesQuarantined, 2, "both malformed rules were quarantined");

    // The fired rule has fireCount incremented; quarantined rules have not.
    const rules = getAllActiveRules();
    const fired = rules.find(r => r.id === "valid_rule")!;
    const quar1 = rules.find(r => r.id === "quarantine_or")!;
    const quar2 = rules.find(r => r.id === "quarantine_timer")!;
    assert.equal(fired.fireCount, 1, "valid rule fireCount advanced");
    assert.equal(quar1.fireCount, 0, "quarantined rule fireCount did not advance");
    assert.equal(quar2.fireCount, 0, "quarantined rule fireCount did not advance");
  });

  it("getEnforceableActiveRules excludes quarantined rules", () => {
    writeStoreDirect([
      makeRule({ id: "ok", primitive: "ttl_rule", params: { days: 30, target: "testing_hypothesis" } }),
      makeRule({ id: "bad", primitive: "archive_rule", params: { target: "or", criteria: "" } }),
    ]);
    const enforceable = getEnforceableActiveRules();
    const ids = enforceable.map(r => r.id).sort();
    assert.deepEqual(ids, ["ok"]);
    // Full active list still contains both — read-side filter only.
    const all = getAllActiveRules();
    assert.equal(all.length, 2);
  });

  it("does NOT mutate enforcement_rules.json by tick when quarantined rules are present", async () => {
    writeStoreDirect([
      makeRule({ id: "bad_or",   primitive: "archive_rule", params: { target: "or",  criteria: "" } }),
      makeRule({ id: "bad_all",  primitive: "archive_rule", params: { target: "all", criteria: "" } }),
    ]);
    const before = JSON.parse(fs.readFileSync(ENFORCEMENT_FILE, "utf8"));
    await tickEnforcer();
    const after = JSON.parse(fs.readFileSync(ENFORCEMENT_FILE, "utf8"));
    // Tick rewrites lastUpdated but rule shape and fireCounts should be unchanged.
    const beforeRules = before.rules.map((r: any) => ({ id: r.id, fireCount: r.fireCount, target: r.params.target }));
    const afterRules  = after.rules.map((r: any) => ({ id: r.id, fireCount: r.fireCount, target: r.params.target }));
    assert.deepEqual(afterRules, beforeRules, "quarantined rule rows preserved verbatim across a tick");
  });
});

describe("buildSelfRuleEnforcementVisibility — quarantine surface", () => {
  beforeEach(() => wipe());

  it("surfaces quarantined rules with reasons and excludes them from byPrimitive", () => {
    writeStoreDirect([
      // 2 enforceable rules
      makeRule({ id: "ttl_ok",   primitive: "ttl_rule",     params: { days: 14, target: "testing_hypothesis" } }),
      makeRule({ id: "ratio_ok", primitive: "ratio_rule",   params: { inputCount: 1, inputNoun: "kb_entry", outputCount: 1, outputNoun: "synthesis" } }),
      // 4 quarantined archive_rule rows (production-observed shapes)
      makeRule({ id: "q_or",       primitive: "archive_rule", params: { target: "or",       criteria: "" } }),
      makeRule({ id: "q_at",       primitive: "archive_rule", params: { target: "at",       criteria: "" } }),
      makeRule({ id: "q_timer",    primitive: "archive_rule", params: { target: "timer",    criteria: "" } }),
      makeRule({ id: "q_all",      primitive: "archive_rule", params: { target: "all",      criteria: "" } }),
      makeRule({ id: "q_orphaned", primitive: "archive_rule", params: { target: "orphaned", criteria: "" } }),
    ]);

    const snap = buildSelfRuleEnforcementVisibility();
    // activeRules counts ALL enabled rows on disk (preserves audit posture).
    assert.equal(snap.counts.activeRules, 7);
    // enforceableRules counts only those passing the hygiene filter.
    assert.equal(snap.counts.enforceableRules, 2);
    assert.equal(snap.counts.quarantinedRules, 5);

    // byPrimitive reflects ENFORCEABLE rules only (no archive_rule entries).
    assert.equal(snap.counts.byPrimitive.ttl_rule, 1);
    assert.equal(snap.counts.byPrimitive.ratio_rule, 1);
    assert.equal(snap.counts.byPrimitive.archive_rule ?? 0, 0, "no enforceable archive_rule remains");

    // quarantinedRules array exposes each malformed row with a reason.
    assert.equal(snap.quarantinedRules.length, 5);
    const targets = snap.quarantinedRules.map(q => q.target).sort();
    assert.deepEqual(targets, ["all", "at", "or", "orphaned", "timer"]);
    for (const q of snap.quarantinedRules) {
      assert.equal(q.primitive, "archive_rule");
      assert.ok(q.reason.length > 0, "every quarantined view has a non-empty reason");
      assert.match(q.summary, /quarantined/);
    }

    // Headline mentions the quarantine state.
    assert.match(snap.headline, /quarantined/);
    // enforcementSemanticsNote documents that the filter is read-only.
    assert.match(snap.enforcementSemanticsNote, /quarantine/i);
  });

  it("zero-state — no rules at all — does not surface a quarantine count", () => {
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.counts.activeRules, 0);
    assert.equal(snap.counts.enforceableRules, 0);
    assert.equal(snap.counts.quarantinedRules, 0);
    assert.deepEqual(snap.quarantinedRules, []);
  });

  it("clean registry (all valid rules) reports zero quarantined and full count enforceable", () => {
    writeStoreDirect([
      makeRule({ id: "v1", primitive: "ttl_rule", params: { days: 14, target: "testing_hypothesis" } }),
      makeRule({ id: "v2", primitive: "ratio_rule", params: { inputCount: 1, inputNoun: "kb_entry", outputCount: 1, outputNoun: "synthesis" } }),
      makeRule({ id: "v3", primitive: "archive_rule", params: { target: "dream_insight", criteria: "speculative" } }),
    ]);
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.counts.activeRules, 3);
    assert.equal(snap.counts.enforceableRules, 3);
    assert.equal(snap.counts.quarantinedRules, 0);
    assert.deepEqual(snap.quarantinedRules, []);
    assert.equal(snap.counts.byPrimitive.ttl_rule, 1);
    assert.equal(snap.counts.byPrimitive.ratio_rule, 1);
    assert.equal(snap.counts.byPrimitive.archive_rule, 1);
  });

  it("builder is read-only — repeated calls do not mutate the store", () => {
    writeStoreDirect([
      makeRule({ id: "bad", primitive: "archive_rule", params: { target: "or", criteria: "" } }),
      makeRule({ id: "ok",  primitive: "ttl_rule",     params: { days: 14, target: "testing_hypothesis" } }),
    ]);
    const before = hashFile(ENFORCEMENT_FILE);
    buildSelfRuleEnforcementVisibility();
    buildSelfRuleEnforcementVisibility();
    const after = hashFile(ENFORCEMENT_FILE);
    assert.equal(after, before, "store must be byte-identical after read-only builds");
  });
});
