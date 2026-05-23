/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — inspectObligations CLI tests                                  [PR #420]
 *
 * Regression coverage for the work-item collapse fix: ensure the operator
 * inspect CLI groups events by the RECOMPUTED canonical work-item id (the
 * same grouping the runtime projection uses), NOT by the raw stored
 * `ev.obligationId` field. Before #420, the CLI showed N separate rows
 * for what the runtime treats as ONE obligation when legacy pre-#384
 * events (carrying per-rule obligationIds) coexisted with post-#384
 * events for the same (outputNoun, inputNoun) family.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { projectInspected, runMain } from "../inspectObligations.ts";
import { obligationIdForWorkItem } from "../../shared/obligationKeys.ts";

// Helper: write a minimal JSONL ledger to a temp file and return its path.
function writeLedger(events: Record<string, unknown>[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-obl-test-"));
  const file = path.join(dir, "rule_corrective_obligations.jsonl");
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

test("projectInspected — collapses legacy + new events sharing the same noun family", () => {
  // Two events, different stored obligationIds, SAME (outputNoun, inputNoun)
  // family. The runtime projection collapses them to one row keyed by the
  // recomputed work-item id — the CLI must match.
  const legacyId = "oblg_eee611c8070027a8"; // pre-#384 per-rule id
  const newId = obligationIdForWorkItem(
    "ratio_rule",
    "draft_output_artifact",
    "kb_entries_added",
  );

  const events = [
    {
      type: "opened",
      obligationId: legacyId,
      recordedAt: "2026-05-17T12:04:36.645Z",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entries_added",
      ruleId: "rule_legacy_1",
      insightId: "insight_legacy_1",
      deficitCount: 311,
      requiredActionCount: 10,
      expectedCount: 363,
      actualCount: 52,
      inputCount: 1090,
      reason: "legacy opened",
      deadlineNote: "next DailyCycle tick",
      // NOTE: no normalizedKey field — this is the legacy shape.
    },
    {
      type: "refreshed",
      obligationId: newId,
      normalizedKey: "ratio_rule|out:draft_output_artifact|in:kb_entries_added",
      recordedAt: "2026-05-23T11:06:54.704Z",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entries_added",
      ruleId: "rule_new_1",
      insightId: "insight_new_1",
      deficitCount: 308,
      requiredActionCount: 10,
      expectedCount: 364,
      actualCount: 56,
      inputCount: 1092,
      reason: "post-#384 refresh",
      deadlineNote: "next DailyCycle tick",
    },
  ];

  const projection = projectInspected(events as never[], false);
  assert.equal(projection.length, 1, "legacy + new must collapse to ONE row");
  const row = projection[0];
  assert.equal(row.obligationId, newId, "row id is the canonical work-item id");
  assert.equal(row.status, "open");
  assert.equal(row.enforcement, "advisory");
  assert.equal(
    row.refreshCount,
    1,
    "refreshCount counts only `refreshed` events across the collapsed group",
  );
  // Latest event drives counter fields.
  assert.equal(row.deficitCount, 308);
  assert.equal(row.actualCount, 56);
});

test("projectInspected — does NOT collapse different noun families", () => {
  const archivedId = obligationIdForWorkItem("ratio_rule", "archived", "kb_entry");
  const draftId = obligationIdForWorkItem(
    "ratio_rule",
    "draft_output_artifact",
    "kb_entries_added",
  );
  assert.notEqual(archivedId, draftId, "different families must hash differently");

  const events = [
    {
      type: "opened",
      obligationId: archivedId,
      recordedAt: "2026-05-23T10:00:00.000Z",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      ruleId: "r1",
      insightId: "i1",
      deficitCount: 162,
      requiredActionCount: 10,
      expectedCount: 218,
      actualCount: 56,
      inputCount: 1092,
      reason: "archived deficit",
      deadlineNote: "next tick",
    },
    {
      type: "opened",
      obligationId: draftId,
      recordedAt: "2026-05-23T10:00:01.000Z",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entries_added",
      ruleId: "r2",
      insightId: "i2",
      deficitCount: 308,
      requiredActionCount: 10,
      expectedCount: 364,
      actualCount: 56,
      inputCount: 1092,
      reason: "draft deficit",
      deadlineNote: "next tick",
    },
  ];
  const projection = projectInspected(events as never[], false);
  assert.equal(projection.length, 2, "different families must remain separate rows");
});

test("projectInspected — noun-family synonyms fold legacy 'archive'/'archiving' into 'archived'", () => {
  // Verify that two events with synonymous nouns (legacy variants) collapse
  // into the same row — this is the dedupe contract from PR #384.
  const events = [
    {
      type: "opened",
      obligationId: "oblg_synonym_legacy_a",
      recordedAt: "2026-05-17T12:00:00.000Z",
      outputNoun: "archive", // singular, no -d
      inputNoun: "kb_entries",
      ruleId: "r_a",
      insightId: "i_a",
      deficitCount: 100,
      requiredActionCount: 10,
      expectedCount: 200,
      actualCount: 100,
      inputCount: 1000,
      reason: "synonym a",
      deadlineNote: "next tick",
    },
    {
      type: "refreshed",
      obligationId: "oblg_synonym_legacy_b",
      recordedAt: "2026-05-23T12:00:00.000Z",
      outputNoun: "archived", // canonical form
      inputNoun: "kb_entry",
      ruleId: "r_b",
      insightId: "i_b",
      deficitCount: 150,
      requiredActionCount: 10,
      expectedCount: 250,
      actualCount: 100,
      inputCount: 1000,
      reason: "synonym b",
      deadlineNote: "next tick",
    },
  ];
  const projection = projectInspected(events as never[], false);
  assert.equal(projection.length, 1, "synonym variants must collapse");
  assert.equal(projection[0].refreshCount, 1);
});

test("runMain --ids resolves both canonical work-item id AND legacy raw obligationId", () => {
  const legacyId = "oblg_eee611c8070027a8";
  const newId = obligationIdForWorkItem(
    "ratio_rule",
    "draft_output_artifact",
    "kb_entries_added",
  );
  const events = [
    {
      type: "opened",
      obligationId: legacyId,
      recordedAt: "2026-05-17T12:04:36.645Z",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entries_added",
      ruleId: "rule_legacy_1",
      insightId: "insight_legacy_1",
      deficitCount: 311,
      requiredActionCount: 10,
      expectedCount: 363,
      actualCount: 52,
      inputCount: 1090,
      reason: "legacy",
      deadlineNote: "next tick",
    },
    {
      type: "refreshed",
      obligationId: newId,
      normalizedKey: "ratio_rule|out:draft_output_artifact|in:kb_entries_added",
      recordedAt: "2026-05-23T11:06:54.704Z",
      outputNoun: "draft_output_artifact",
      inputNoun: "kb_entries_added",
      ruleId: "rule_new_1",
      insightId: "insight_new_1",
      deficitCount: 308,
      requiredActionCount: 10,
      expectedCount: 364,
      actualCount: 56,
      inputCount: 1092,
      reason: "refresh",
      deadlineNote: "next tick",
    },
  ];
  const ledger = writeLedger(events as never[]);

  // Passing the LEGACY raw id resolves to the collapsed row.
  const r1 = runMain([
    "--ledger=" + ledger,
    "--ids=" + legacyId,
    "--no-source-check",
  ]);
  assert.equal(r1.exitCode, 0, "legacy id must resolve, not 404");
  const p1 = JSON.parse(r1.stdout);
  assert.equal(p1.obligations.length, 1);
  assert.equal(p1.obligations[0].obligationId, newId);
  assert.deepEqual(p1.notFound, []);

  // Passing the CANONICAL id also resolves to the same single row.
  const r2 = runMain([
    "--ledger=" + ledger,
    "--ids=" + newId,
    "--no-source-check",
  ]);
  assert.equal(r2.exitCode, 0);
  const p2 = JSON.parse(r2.stdout);
  assert.equal(p2.obligations.length, 1);
  assert.equal(p2.obligations[0].obligationId, newId);
  assert.deepEqual(p2.notFound, []);

  // A genuinely unknown id still 404s.
  const r3 = runMain([
    "--ledger=" + ledger,
    "--ids=oblg_does_not_exist_at_all",
    "--no-source-check",
  ]);
  assert.equal(r3.exitCode, 3, "unknown id must still exit 3");
});

test("runMain — masterEnvFlagObserved is emitted as a boolean (PR #421)", () => {
  // jq / CI scripts parse this field as a boolean — emitting the raw string
  // "true" broke `jq '.masterEnvFlagObserved == true'` consumers. PR #421
  // coerces to a strict tri-state: undefined → null; "true" → true; else → false.
  const ledger = writeLedger([] as never[]);

  const saved = process.env.OBLIGATION_ESCALATION_ENABLED;
  try {
    delete process.env.OBLIGATION_ESCALATION_ENABLED;
    const rUnset = JSON.parse(runMain(["--ledger=" + ledger, "--no-source-check"]).stdout);
    assert.equal(rUnset.masterEnvFlagObserved, null, "unset → null");

    process.env.OBLIGATION_ESCALATION_ENABLED = "true";
    const rTrue = JSON.parse(runMain(["--ledger=" + ledger, "--no-source-check"]).stdout);
    assert.strictEqual(rTrue.masterEnvFlagObserved, true, "'true' → boolean true");

    process.env.OBLIGATION_ESCALATION_ENABLED = "false";
    const rFalse = JSON.parse(runMain(["--ledger=" + ledger, "--no-source-check"]).stdout);
    assert.strictEqual(rFalse.masterEnvFlagObserved, false, "'false' → boolean false");

    process.env.OBLIGATION_ESCALATION_ENABLED = "1";
    const rOne = JSON.parse(runMain(["--ledger=" + ledger, "--no-source-check"]).stdout);
    assert.strictEqual(rOne.masterEnvFlagObserved, false, "any non-'true' value → boolean false");
  } finally {
    if (saved === undefined) delete process.env.OBLIGATION_ESCALATION_ENABLED;
    else process.env.OBLIGATION_ESCALATION_ENABLED = saved;
  }
});

test("projectInspected — does not include events in payload by default", () => {
  const newId = obligationIdForWorkItem("ratio_rule", "archived", "kb_entry");
  const events = [
    {
      type: "opened",
      obligationId: newId,
      recordedAt: "2026-05-23T10:00:00.000Z",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      ruleId: "r1",
      insightId: "i1",
      deficitCount: 100,
      requiredActionCount: 10,
      expectedCount: 200,
      actualCount: 100,
      inputCount: 1000,
      reason: "x",
      deadlineNote: "next tick",
    },
  ];
  const ledger = writeLedger(events as never[]);
  const r = runMain(["--ledger=" + ledger, "--no-source-check"]);
  assert.equal(r.exitCode, 0);
  const p = JSON.parse(r.stdout);
  assert.equal(p.obligations.length, 1);
  assert.equal(
    p.obligations[0].events,
    undefined,
    "events must NOT leak into payload when --include-events is absent",
  );
});
