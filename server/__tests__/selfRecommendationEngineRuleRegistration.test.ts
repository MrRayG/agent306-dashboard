/**
 * PR-C — engine self-recommendation rule registration on apply.
 *
 * When an operator approves an eligible engine-category recommendation that
 * references a source insight and whose proposedChange translates to an
 * existing enforcement primitive, applyRecommendation should register an
 * executable rule via the existing actionTranslator/actionEnforcer path.
 *
 * Invariants under test:
 *   - prompt/style recs never enter the rule registration path
 *   - engine recs whose proposedChange is untranslatable do not produce a
 *     rule; a diagnostic event is emitted; status='applied' transition
 *     still happens (existing apply semantics preserved)
 *   - engine recs with no sourceInsightId do not produce a rule; a
 *     diagnostic event is emitted
 *   - eligible engine recs register EXACTLY ONE executable rule, keyed on
 *     the source insight id
 *   - rule registration is idempotent in the registry sense: re-applying
 *     the same insight via a fresh rec keeps a single live rule (dedupe
 *     by insightId is owned by actionEnforcer.registerRule)
 *
 * Run: npx tsx --test server/__tests__/selfRecommendationEngineRuleRegistration.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB / DATA_DIR isolation. The actionEnforcer persists rules to
// `enforcement_rules.json` under DATA_DIR; scoping to tmpdir keeps this test
// from racing against `data/enforcement_rules.json` shared with other suites.
const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "selfRecRuleReg-test-"),
);
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const { db } = await import("../db.js");
const { selfRecommendations, engineEvents } = await import("@shared/schema");
const { eq, desc } = await import("drizzle-orm");
const {
  proposeRecommendation,
  approveRecommendation,
  applyRecommendation,
} = await import("../selfRecommendationEngine.js");
const {
  getRulesByInsight,
  getAllActiveRules,
} = await import("../actionEnforcer.js");

const ENFORCEMENT_FILE = path.join(TMP_DIR, "enforcement_rules.json");

function wipe() {
  try { db.delete(selfRecommendations).run(); } catch {}
  try { db.delete(engineEvents).run(); } catch {}
  try {
    if (fs.existsSync(ENFORCEMENT_FILE)) fs.unlinkSync(ENFORCEMENT_FILE);
  } catch {}
}

function readRuleRegEvents(recId: string) {
  return db
    .select()
    .from(engineEvents)
    .where(eq(engineEvents.event, "ruleRegistrationOnApply"))
    .orderBy(desc(engineEvents.id))
    .all()
    .filter((row: any) => {
      try {
        const parsed = JSON.parse(row.data);
        return parsed.recommendationId === recId;
      } catch {
        return false;
      }
    });
}

describe("selfRecommendationEngine — PR-C engine-rec rule registration on apply", () => {
  before(wipe);
  beforeEach(wipe);

  it("registers exactly one executable rule when an eligible engine rec is applied", async () => {
    const insightId = "il_test_ratio_1";
    const rec = proposeRecommendation({
      category: "engine",
      risk: "low",
      title: "force synthesis cadence",
      rationale: "knowledge accumulation unsustainable",
      // Verbatim ratio-rule pattern from the canonical KB/synthesis case.
      proposedChange:
        "For every 10 new knowledge entries, force-generate one synthesis",
      sourceInsightId: insightId,
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, true);

    const rules = getRulesByInsight(insightId);
    assert.equal(rules.length, 1, "expected exactly one registered rule");
    assert.equal(rules[0].primitive, "ratio_rule");
    assert.equal(rules[0].enabled, true);
    assert.equal(rules[0].insightId, insightId);

    const events = readRuleRegEvents(rec.id);
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].data);
    assert.equal(payload.registered, true);
    assert.equal(payload.primitive, "ratio_rule");
    assert.equal(payload.sourceInsightId, insightId);
    assert.equal(payload.ruleId, rules[0].id);
  });

  it("registers a gate rule for a 'pre-registration gate' engine rec", async () => {
    const insightId = "il_test_gate_1";
    const rec = proposeRecommendation({
      category: "engine",
      risk: "low",
      title: "pre-registration gate",
      rationale: "hypotheses entering testing without measurement path",
      proposedChange:
        "Require pre-registration before any hypothesis enters testing",
      sourceInsightId: insightId,
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, true);

    const rules = getRulesByInsight(insightId);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].primitive, "gate_rule");
  });

  it("does NOT register a rule for prompt-category recs (eligibility scope)", async () => {
    const rec = proposeRecommendation({
      category: "prompt",
      risk: "low",
      title: "tighten verifier framing",
      rationale: "verifier misclassifies My read framing",
      // Even though this text would translate to artifact_rule, prompt-
      // category recs are out of scope for rule registration on apply.
      proposedChange:
        "Produce one concrete artifact within next cycle",
      sourceInsightId: "il_prompt_should_not_register",
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, true);

    const rules = getRulesByInsight("il_prompt_should_not_register");
    assert.equal(rules.length, 0);
    // No ruleRegistrationOnApply event should have been emitted (helper
    // exits before reaching the diagnostic logger when category !== engine).
    const events = readRuleRegEvents(rec.id);
    assert.equal(events.length, 0);
  });

  it("fails safely (no rule registered, diagnostic event) when proposedChange is untranslatable", async () => {
    const insightId = "il_test_untranslatable";
    const rec = proposeRecommendation({
      category: "engine",
      risk: "low",
      title: "vague aspiration",
      rationale: "broad systemic concern",
      proposedChange: "Think more carefully about how to improve overall",
      sourceInsightId: insightId,
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    // Apply transition is still successful — translation failure does
    // not block status='applied' (existing semantics preserved).
    assert.equal(result.ok, true);

    const rules = getRulesByInsight(insightId);
    assert.equal(rules.length, 0);

    const events = readRuleRegEvents(rec.id);
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].data);
    assert.equal(payload.registered, false);
    assert.equal(payload.reason, "untranslatable");
  });

  it("fails safely when an engine rec has no sourceInsightId", async () => {
    const rec = proposeRecommendation({
      category: "engine",
      risk: "low",
      title: "engine rec without insight link",
      rationale: "operator-drafted engine concern",
      // Even with a translatable phrasing, no insight id means we have
      // nothing to key registerRuleFromInsight on, so we skip.
      proposedChange:
        "For every 10 new knowledge entries, force-generate one synthesis",
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, true);

    const allRules = getAllActiveRules();
    // No rule should have been registered keyed on a missing insight id.
    // (The rule registry may contain unrelated rows from other tests; we
    // assert nothing got created for our test rec specifically by checking
    // the diagnostic event.)
    const events = readRuleRegEvents(rec.id);
    assert.equal(events.length, 1);
    const payload = JSON.parse(events[0].data);
    assert.equal(payload.registered, false);
    assert.equal(payload.reason, "no_source_insight_id");
    // sanity: the all-rules list does not contain a rule with empty insightId
    assert.equal(
      allRules.some((r) => !r.insightId),
      false,
    );
  });

  it("rule-registry dedupe keeps a single live rule per insight when two recs share the same source insight", async () => {
    const insightId = "il_test_dedupe_share";
    const rec1 = proposeRecommendation({
      category: "engine",
      risk: "low",
      title: "ratio rec v1",
      rationale: "first pass",
      proposedChange:
        "For every 10 new knowledge entries, force-generate one synthesis",
      sourceInsightId: insightId,
      dedupeKey: "rec1-key",
    });
    approveRecommendation(rec1.id, "alice");
    await applyRecommendation(rec1.id, "alice");

    // A second engine rec, also keyed on the same insight, also translatable.
    // actionEnforcer.registerRule filters existing rules by insightId before
    // inserting, so the registry collapses to a single live rule.
    const rec2 = proposeRecommendation({
      category: "engine",
      risk: "low",
      title: "ratio rec v2 — sharpened",
      rationale: "follow-up pass",
      proposedChange:
        "For every 10 new knowledge entries, force-generate one synthesis",
      sourceInsightId: insightId,
      dedupeKey: "rec2-key",
    });
    approveRecommendation(rec2.id, "alice");
    await applyRecommendation(rec2.id, "alice");

    const rules = getRulesByInsight(insightId);
    assert.equal(
      rules.length,
      1,
      "expected exactly one live rule for the shared insight id",
    );
  });

  it("does NOT register a rule for architecture-category recs (eligibility scope)", async () => {
    const rec = proposeRecommendation({
      category: "architecture",
      risk: "low",
      title: "refactor X",
      rationale: "architectural drift",
      proposedChange:
        "Implement a strict 14-day TTL on testing hypotheses with no evidence movement",
      sourceInsightId: "il_arch_should_not_register",
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, true);

    const rules = getRulesByInsight("il_arch_should_not_register");
    assert.equal(rules.length, 0);
    const events = readRuleRegEvents(rec.id);
    assert.equal(events.length, 0);
  });
});
