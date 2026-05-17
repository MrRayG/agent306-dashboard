/**
 * Tests for the read-side projection collapse of LEGACY duplicate-id
 * obligation events.
 *
 * Background: pre-#384 the ledger stored events whose `obligationId` was a
 * per-rule sha1 (ruleId|outputNoun|insightId). When PR #384 switched the
 * dedupe identity to the normalized (primitive, outputNounFamily,
 * inputNounFamily) hash, those legacy events kept their old per-rule
 * obligationId on disk. The projection used to group on
 * `event.obligationId`, so two legacy events that should collapse stayed
 * separate on the dashboard (`The two duplicate archive obligations …
 * different ruleIds`).
 *
 * This test pins that the read-side projection NOW regroups events by the
 * recomputed work-item id, so legacy duplicate-id rows collapse into a
 * single open obligation, contributing all source rule ids / insight ids.
 *
 * The ledger is NOT rewritten — the underlying file still contains the
 * legacy ids; only the projection collapses them.
 *
 * Run: npx tsx --test server/__tests__/ruleCorrectiveObligationLegacyDedupe.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ruleCorrectiveObligationLegacyDedupe-test-"),
);
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const OBLIGATION_FILE = path.join(TMP_DIR, "rule_corrective_obligations.jsonl");

const {
  getOpenObligations,
  projectObligations,
} = await import("../ruleCorrectiveObligations.js");

function wipe(): void {
  try { if (fs.existsSync(OBLIGATION_FILE)) fs.unlinkSync(OBLIGATION_FILE); } catch {}
}

function legacyObligationId(ruleId: string, outputNoun: string, insightId: string): string {
  // Mirrors the pre-#384 hash shape so we can manufacture realistic
  // legacy rows: sha1(ruleId|outputNoun|insightId) → first 16 hex.
  const h = crypto.createHash("sha1").update(`${ruleId}|${outputNoun}|${insightId}`).digest("hex").slice(0, 16);
  return `oblg_${h}`;
}

function appendLegacyEvent(ev: Record<string, unknown>): void {
  fs.appendFileSync(OBLIGATION_FILE, JSON.stringify(ev) + "\n", "utf8");
}

describe("ruleCorrectiveObligations — legacy duplicate-id collapse", () => {
  beforeEach(() => wipe());

  it("collapses two legacy 'archive kb_entry' obligations into one in the projection", () => {
    // Two pre-#384 events: same normalized work item (output='archived',
    // input='kb_entry'), different ruleIds → different legacy obligationIds.
    // The user-reported production case: raw deficit 166, ratio probe 52/218
    // for 1090 kb_entries.
    const ruleA = "rule_evo_legacy_A";
    const ruleB = "rule_evo_legacy_B";
    const insightA = "ins_legacy_A";
    const insightB = "ins_legacy_B";
    const baseTs = "2026-04-10T00:00:00.000Z";

    appendLegacyEvent({
      eventId: "evt_legacy_a",
      type: "opened",
      recordedAt: baseTs,
      obligationId: legacyObligationId(ruleA, "archived", insightA),
      // legacy events MAY lack normalizedKey; either way the projection
      // recomputes the key from outputNoun/inputNoun.
      ruleId: ruleA,
      insightId: insightA,
      sourceInsightId: insightA,
      primitive: "ratio_rule",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 166,
      requiredActionCount: 10,
      expectedCount: 218,
      actualCount: 52,
      inputCount: 1090,
      reason: "legacy event A",
      tickedAt: Date.parse(baseTs),
      deadlineNote: "next DailyCycle tick",
    });

    appendLegacyEvent({
      eventId: "evt_legacy_b",
      type: "opened",
      recordedAt: "2026-04-10T00:30:00.000Z",
      obligationId: legacyObligationId(ruleB, "archived", insightB),
      ruleId: ruleB,
      insightId: insightB,
      sourceInsightId: insightB,
      primitive: "ratio_rule",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 166,
      requiredActionCount: 10,
      expectedCount: 218,
      actualCount: 52,
      inputCount: 1090,
      reason: "legacy event B",
      tickedAt: Date.parse("2026-04-10T00:30:00.000Z"),
      deadlineNote: "next DailyCycle tick",
    });

    const open = getOpenObligations();
    assert.equal(open.length, 1, "two legacy events for the same work item must collapse to one open obligation");
    assert.equal(open[0].sourceRuleIds.length, 2, "both source rules retained");
    assert.ok(open[0].sourceRuleIds.includes("rule_evo_legacy_A"));
    assert.ok(open[0].sourceRuleIds.includes("rule_evo_legacy_B"));
    assert.equal(open[0].mergedFromCount, 2);
    assert.equal(open[0].outputNoun, "archived");
    assert.equal(open[0].inputNoun, "kb_entry");
  });

  it("does NOT collapse genuinely distinct work items (different output family)", () => {
    appendLegacyEvent({
      eventId: "evt_legacy_archive",
      type: "opened",
      recordedAt: "2026-04-10T00:00:00.000Z",
      obligationId: legacyObligationId("rule_x", "archived", "ins_x"),
      ruleId: "rule_x",
      insightId: "ins_x",
      sourceInsightId: "ins_x",
      primitive: "ratio_rule",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 5,
      requiredActionCount: 5,
      expectedCount: 218,
      actualCount: 100,
      inputCount: 1090,
      reason: "archive obligation",
      tickedAt: Date.parse("2026-04-10T00:00:00.000Z"),
      deadlineNote: "next DailyCycle tick",
    });

    appendLegacyEvent({
      eventId: "evt_legacy_draft",
      type: "opened",
      recordedAt: "2026-04-10T00:30:00.000Z",
      obligationId: legacyObligationId("rule_y", "draft_output_artifact", "ins_y"),
      ruleId: "rule_y",
      insightId: "ins_y",
      sourceInsightId: "ins_y",
      primitive: "ratio_rule",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entry",
      deficitCount: 3,
      requiredActionCount: 3,
      expectedCount: 100,
      actualCount: 50,
      inputCount: 1090,
      reason: "draft obligation",
      tickedAt: Date.parse("2026-04-10T00:30:00.000Z"),
      deadlineNote: "next DailyCycle tick",
    });

    const open = getOpenObligations();
    assert.equal(open.length, 2, "distinct work items must remain separate obligations");
  });

  it("preserves the legacy events on disk (read-only collapse)", () => {
    const ruleA = "rule_evo_legacy_A";
    const ruleB = "rule_evo_legacy_B";
    appendLegacyEvent({
      eventId: "evt_legacy_a",
      type: "opened",
      recordedAt: "2026-04-10T00:00:00.000Z",
      obligationId: legacyObligationId(ruleA, "archived", "ins_a"),
      ruleId: ruleA,
      insightId: "ins_a",
      sourceInsightId: "ins_a",
      primitive: "ratio_rule",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 1,
      requiredActionCount: 1,
      expectedCount: 1, actualCount: 0, inputCount: 1,
      reason: "x", tickedAt: 0, deadlineNote: "x",
    });
    const beforeBytes = fs.readFileSync(OBLIGATION_FILE).length;
    projectObligations();
    projectObligations();
    const afterBytes = fs.readFileSync(OBLIGATION_FILE).length;
    assert.equal(beforeBytes, afterBytes, "read-only collapse must not rewrite the ledger");
  });
});
