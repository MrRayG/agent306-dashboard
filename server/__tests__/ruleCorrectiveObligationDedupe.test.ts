/**
 * Tests for normalized corrective-obligation dedupe.
 *
 * Production case (pre-#383): three ratio_rule deficits queued three open
 * obligations — two of which were duplicates for the SAME normalized work
 * item (`archived` × `kb_entry`) from two different rule ids. The third
 * was a distinct work item (`draft_output_artifact`) and rightfully stayed
 * separate. This file pins the post-dedupe invariants:
 *
 *   1. Two distinct ratio rules whose deficits describe the same normalized
 *      work item collapse to ONE obligation (mergedFromCount = 2).
 *   2. A distinct work item (different outputNoun family) remains its own
 *      obligation row.
 *   3. The merged obligation retains all contributing ruleIds and
 *      insightIds in `sourceRuleIds` / `sourceInsightIds`.
 *   4. Synonym folding: kb_entry vs kb_entries vs knowledge all normalize
 *      to the same input-noun family and dedupe.
 *   5. `recordRatioSatisfied` from ANY contributing source rule closes the
 *      merged obligation (work-item identity, not rule identity).
 *   6. The exported `normalizeNounFamily` / `obligationIdForWorkItem`
 *      helpers are deterministic across calls and processes.
 *
 * Run: npx tsx --test server/__tests__/ruleCorrectiveObligationDedupe.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ruleCorrectiveObligationDedupe-test-"),
);
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const OBLIGATION_FILE = path.join(TMP_DIR, "rule_corrective_obligations.jsonl");

const {
  recordRatioDeficit,
  recordRatioSatisfied,
  getOpenObligations,
  readObligationEvents,
  normalizeNounFamily,
  normalizedWorkItemKey,
  obligationIdForWorkItem,
  OBLIGATION_BOUND_CAP,
} = await import("../ruleCorrectiveObligations.js");

function wipe(): void {
  try { if (fs.existsSync(OBLIGATION_FILE)) fs.unlinkSync(OBLIGATION_FILE); } catch {}
}

// Production-replay-ish payload from the bug report: same ratio probe
// (52/218 for 1090 kb_entries), same target work item ("archived" × "kb_entry"),
// raw deficit 166, two different ruleIds and insightIds.
const PROD_RULE_A = {
  ruleId: "rule_evo_1778846172013_1ces_mp71w3i2",
  insightId: "insight_evo_a",
  outputNoun: "archived",
  inputNoun: "kb_entry",
  deficitCount: 166,
  expectedCount: 218,
  actualCount: 52,
  inputCount: 1090,
};
const PROD_RULE_B = {
  ruleId: "rule_il_1778846172041_2tlv_mp88zuf2",
  insightId: "insight_il_b",
  outputNoun: "archived",
  inputNoun: "kb_entry",
  deficitCount: 166,
  expectedCount: 218,
  actualCount: 52,
  inputCount: 1090,
};

describe("ruleCorrectiveObligations — normalized dedupe", () => {
  beforeEach(() => wipe());

  it("two ratio rules with the same normalized work item collapse to ONE obligation", () => {
    const tickedAt = Date.now();
    const a = recordRatioDeficit({ ...PROD_RULE_A, tickedAt });
    const b = recordRatioDeficit({ ...PROD_RULE_B, tickedAt: tickedAt + 1 });
    assert.ok(a.ok, "rule A deficit should record");
    assert.ok(b.ok, "rule B deficit should record");
    const open = getOpenObligations();
    assert.equal(open.length, 1, `expected ONE obligation post-dedupe, got ${open.length}`);
    const o = open[0];
    assert.equal(o.outputNoun, "archived");
    assert.equal(o.inputNoun, "kb_entry");
    // Both ruleIds preserved
    assert.equal(o.sourceRuleIds.length, 2, "both ruleIds preserved");
    assert.ok(o.sourceRuleIds.includes(PROD_RULE_A.ruleId));
    assert.ok(o.sourceRuleIds.includes(PROD_RULE_B.ruleId));
    // Both insightIds preserved
    assert.equal(o.sourceInsightIds.length, 2, "both insightIds preserved");
    assert.ok(o.sourceInsightIds.includes(PROD_RULE_A.insightId));
    assert.ok(o.sourceInsightIds.includes(PROD_RULE_B.insightId));
    assert.equal(o.mergedFromCount, 2);
    // Required action still bounded
    assert.equal(o.requiredActionCount, OBLIGATION_BOUND_CAP);
    // First event was opened, second was refreshed (same obligationId)
    const events = readObligationEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "opened");
    assert.equal(events[1].type, "refreshed");
    assert.equal(events[0].obligationId, events[1].obligationId);
    // refreshCount counts the merge as one refresh
    assert.equal(o.refreshCount, 1);
  });

  it("a distinct work item (different outputNoun family) stays a separate obligation", () => {
    const tickedAt = Date.now();
    // Two archive deficits (the pair above) AND a draft_output_artifact deficit.
    recordRatioDeficit({ ...PROD_RULE_A, tickedAt });
    recordRatioDeficit({ ...PROD_RULE_B, tickedAt: tickedAt + 1 });
    const c = recordRatioDeficit({
      ruleId: "rule_artifact_distinct",
      insightId: "insight_artifact_distinct",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entry",
      deficitCount: 311,
      expectedCount: 311,
      actualCount: 0,
      inputCount: 1090,
      tickedAt: tickedAt + 2,
    });
    assert.ok(c.ok);
    const open = getOpenObligations();
    assert.equal(open.length, 2, "archive obligations dedupe, but draft_output_artifact is separate");
    const archive = open.find(o => o.outputNoun === "archived");
    const draft = open.find(o => o.outputNoun === "draft_output_artifact");
    assert.ok(archive, "archive obligation present");
    assert.ok(draft, "draft_output_artifact obligation present");
    assert.equal(archive!.mergedFromCount, 2);
    assert.equal(draft!.mergedFromCount, 1);
    // Distinct normalized keys
    assert.notEqual(archive!.normalizedKey, draft!.normalizedKey);
    assert.notEqual(archive!.obligationId, draft!.obligationId);
  });

  it("synonyms / pluralization fold to the same work item", () => {
    recordRatioDeficit({
      ruleId: "rule_kb_entry",
      insightId: "insight_kb_entry",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 10,
      expectedCount: 10,
      actualCount: 0,
      inputCount: 10,
      tickedAt: Date.now(),
    });
    recordRatioDeficit({
      ruleId: "rule_kb_entries",
      insightId: "insight_kb_entries",
      outputNoun: "archived",
      inputNoun: "kb_entries",
      deficitCount: 10,
      expectedCount: 10,
      actualCount: 0,
      inputCount: 10,
      tickedAt: Date.now() + 1,
    });
    recordRatioDeficit({
      ruleId: "rule_knowledge",
      insightId: "insight_knowledge",
      outputNoun: "archive", // singular spelling
      inputNoun: "knowledge",
      deficitCount: 10,
      expectedCount: 10,
      actualCount: 0,
      inputCount: 10,
      tickedAt: Date.now() + 2,
    });
    const open = getOpenObligations();
    assert.equal(open.length, 1, "all three deficits collapse to one obligation");
    assert.equal(open[0].mergedFromCount, 3);
  });

  it("recordRatioSatisfied closes the merged obligation regardless of which contributing rule satisfies", () => {
    // Open with rule A, refresh-merge with rule B. Now have rule B satisfy.
    recordRatioDeficit({ ...PROD_RULE_A, tickedAt: Date.now() });
    recordRatioDeficit({ ...PROD_RULE_B, tickedAt: Date.now() + 1 });
    assert.equal(getOpenObligations().length, 1);
    const closeRes = recordRatioSatisfied({
      ruleId: PROD_RULE_B.ruleId,
      insightId: PROD_RULE_B.insightId,
      outputNoun: PROD_RULE_B.outputNoun,
      inputNoun: PROD_RULE_B.inputNoun,
      expectedCount: 218,
      actualCount: 218,
      inputCount: 1090,
      tickedAt: Date.now() + 2,
    });
    assert.ok(closeRes.ok, "satisfy from contributing rule B should close");
    assert.equal(getOpenObligations().length, 0, "obligation now closed");
  });

  it("normalizeNounFamily folds explicit synonyms but not unrelated nouns", () => {
    assert.equal(normalizeNounFamily("kb_entry"), "kb_entry");
    assert.equal(normalizeNounFamily("kb_entries"), "kb_entry");
    assert.equal(normalizeNounFamily("knowledge"), "kb_entry");
    assert.equal(normalizeNounFamily("KB_Entry"), "kb_entry");
    assert.equal(normalizeNounFamily("archived"), "archived");
    assert.equal(normalizeNounFamily("archive"), "archived");
    assert.equal(normalizeNounFamily("draft_output_artifact"), "draft_output_artifact");
    assert.equal(normalizeNounFamily("draft"), "draft_output_artifact");
    // Unrelated noun stays distinct (light pluralization only).
    assert.equal(normalizeNounFamily("widget"), "widget");
    assert.equal(normalizeNounFamily("widgets"), "widget");
    assert.notEqual(normalizeNounFamily("archived"), normalizeNounFamily("draft_output_artifact"));
  });

  it("obligationIdForWorkItem is deterministic and stable", () => {
    const id1 = obligationIdForWorkItem("ratio_rule", "archived", "kb_entry");
    const id2 = obligationIdForWorkItem("ratio_rule", "archive", "kb_entries");
    const id3 = obligationIdForWorkItem("ratio_rule", "draft_output_artifact", "kb_entry");
    assert.equal(id1, id2, "synonym spellings yield same obligationId");
    assert.notEqual(id1, id3, "distinct work item → distinct id");
    assert.match(id1, /^oblg_[0-9a-f]{16}$/);
    // Recorded obligation uses same id.
    recordRatioDeficit({
      ruleId: "rule_x",
      insightId: "insight_x",
      outputNoun: "archive",
      inputNoun: "kb_entries",
      deficitCount: 5,
      expectedCount: 5,
      actualCount: 0,
      inputCount: 5,
      tickedAt: Date.now(),
    });
    const open = getOpenObligations();
    assert.equal(open.length, 1);
    assert.equal(open[0].obligationId, id1);
    assert.equal(open[0].normalizedKey, normalizedWorkItemKey("ratio_rule", "archived", "kb_entry"));
  });

  it("the event payload carries normalizedKey for downstream observability", () => {
    const r = recordRatioDeficit({ ...PROD_RULE_A, tickedAt: Date.now() });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(
        r.event.normalizedKey,
        normalizedWorkItemKey("ratio_rule", "archived", "kb_entry"),
      );
    }
  });
});
