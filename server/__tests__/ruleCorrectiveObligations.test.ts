/**
 * Tests for the bounded corrective obligation ledger and projection.
 *
 * Invariants pinned by this file:
 *   1. A first deficit observation creates exactly ONE `opened` event;
 *      the projection surfaces one open obligation with status=open.
 *   2. The obligation is bounded — a 174-deficit yields requiredActionCount
 *      == OBLIGATION_BOUND_CAP, never the raw 174.
 *   3. Repeated deficit observations for the same normalized work item
 *      (primitive, outputNoun family, inputNoun family) are IDEMPOTENT
 *      and DEDUPE across distinct ruleIds / insightIds: they append
 *      `refreshed` events on the SAME obligationId; the projection still
 *      reports exactly one open obligation. See ruleCorrectiveObligationDedupe
 *      for the multi-source-rule merge invariants.
 *   4. A different outputNoun / inputNoun FAMILY yields a SEPARATE
 *      obligation (no false collapsing across genuinely different work
 *      items). ruleId / insightId no longer differentiate identity.
 *   5. `recordRatioSatisfied` closes the obligation; the projection now
 *      reports status=satisfied (so getOpenObligations returns []).
 *   6. The append-only file format tolerates corrupt lines.
 *   7. Empty / missing ledger → projection returns []; never throws.
 *   8. recordRatioDeficit refuses invalid inputs without writing.
 *
 * Run: npx tsx --test server/__tests__/ruleCorrectiveObligations.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "ruleCorrectiveObligations-test-"),
);
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const LEDGER_FILE = path.join(TMP_DIR, "rule_corrective_obligations.jsonl");

const {
  recordRatioDeficit,
  recordRatioSatisfied,
  getOpenObligations,
  projectObligations,
  readObligationEvents,
  obligationIdFor,
  OBLIGATION_BOUND_CAP,
} = await import("../ruleCorrectiveObligations.js");

function wipe(): void {
  try {
    if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE);
  } catch {}
}

function makeDeficit(overrides: Partial<Parameters<typeof recordRatioDeficit>[0]> = {}) {
  return {
    ruleId: "rule_test_1",
    insightId: "insight_test_1",
    sourceInsightId: "insight_test_1",
    outputNoun: "archived",
    inputNoun: "kb_entry",
    deficitCount: 174,
    expectedCount: 226,
    actualCount: 52,
    inputCount: 1131,
    tickedAt: Date.parse("2026-05-16T12:00:00Z"),
    ...overrides,
  };
}

describe("ruleCorrectiveObligations — bounded, idempotent, propose-only", () => {
  beforeEach(() => wipe());

  it("creates exactly one bounded obligation on first observation", () => {
    const result = recordRatioDeficit(makeDeficit());
    assert.ok(result.ok, `expected ok=true, got ${(result as any).reason}`);
    if (!result.ok) return;
    assert.equal(result.event.type, "opened");
    assert.equal(result.event.requiredActionCount, OBLIGATION_BOUND_CAP);
    assert.equal(result.event.deficitCount, 174);
    assert.equal(result.event.outputNoun, "archived");
    assert.equal(result.event.primitive, "ratio_rule");

    const events = readObligationEvents();
    assert.equal(events.length, 1, "exactly one event line written");
    assert.equal(events[0].type, "opened");

    const open = getOpenObligations();
    assert.equal(open.length, 1);
    assert.equal(open[0].status, "open");
    assert.equal(open[0].requiredActionCount, OBLIGATION_BOUND_CAP);
    assert.equal(open[0].deficitCount, 174);
    assert.equal(open[0].refreshCount, 0);
  });

  it("caps requiredActionCount at OBLIGATION_BOUND_CAP for very large deficits", () => {
    const huge = recordRatioDeficit(makeDeficit({ deficitCount: 999999 }));
    assert.ok(huge.ok);
    if (!huge.ok) return;
    assert.equal(huge.event.requiredActionCount, OBLIGATION_BOUND_CAP);
    // The raw deficit is preserved so the panel can still show the actual number.
    assert.equal(huge.event.deficitCount, 999999);
  });

  it("never exceeds OBLIGATION_BOUND_CAP even for small deficits below the cap", () => {
    const small = recordRatioDeficit(makeDeficit({ deficitCount: 3 }));
    assert.ok(small.ok);
    if (!small.ok) return;
    // When deficit < cap, the obligation asks for the deficit (3), not the cap.
    assert.equal(small.event.requiredActionCount, 3);
    assert.equal(small.event.deficitCount, 3);
  });

  it("is IDEMPOTENT — repeated ticks refresh the same obligation, no duplicates", () => {
    const t1 = recordRatioDeficit(makeDeficit({ deficitCount: 174 }));
    const t2 = recordRatioDeficit(makeDeficit({ deficitCount: 200 }));
    const t3 = recordRatioDeficit(makeDeficit({ deficitCount: 150 }));
    assert.ok(t1.ok && t2.ok && t3.ok);
    if (!t1.ok || !t2.ok || !t3.ok) return;

    assert.equal(t1.event.type, "opened");
    assert.equal(t2.event.type, "refreshed");
    assert.equal(t3.event.type, "refreshed");
    assert.equal(t1.event.obligationId, t2.event.obligationId);
    assert.equal(t2.event.obligationId, t3.event.obligationId);

    const events = readObligationEvents();
    assert.equal(events.length, 3, "three append lines: opened + 2 refreshes");

    const open = getOpenObligations();
    assert.equal(open.length, 1, "still exactly ONE open obligation");
    // Latest values reflect the most recent tick.
    assert.equal(open[0].deficitCount, 150);
    assert.equal(open[0].requiredActionCount, OBLIGATION_BOUND_CAP);
    assert.equal(open[0].refreshCount, 2);
  });

  it("uses a different obligationId only for a different normalized work item (not for different ruleId / insightId)", () => {
    // Different ruleId, same normalized (outputNoun, inputNoun) family →
    // SAME obligation (dedupe). Different insightId, same families → also
    // same obligation. Only a different outputNoun family differentiates.
    const a = recordRatioDeficit(makeDeficit({ ruleId: "rule_A" }));
    const b = recordRatioDeficit(makeDeficit({ ruleId: "rule_B" }));
    const c = recordRatioDeficit(makeDeficit({ outputNoun: "merged_record" }));
    const d = recordRatioDeficit(makeDeficit({ insightId: "insight_other" }));
    for (const r of [a, b, c, d]) assert.ok(r.ok);
    if (!a.ok || !b.ok || !c.ok || !d.ok) return;
    // a, b, d normalize to ("archived" × "kb_entry") — share one id.
    // c normalizes to ("merged_record" × "kb_entry") — distinct id.
    const ids = new Set([
      a.event.obligationId,
      b.event.obligationId,
      c.event.obligationId,
      d.event.obligationId,
    ]);
    assert.equal(ids.size, 2, "normalized identity dedupes ruleId/insightId variation");
    assert.equal(a.event.obligationId, b.event.obligationId);
    assert.equal(a.event.obligationId, d.event.obligationId);
    assert.notEqual(a.event.obligationId, c.event.obligationId);
    assert.equal(getOpenObligations().length, 2);
  });

  it("obligationIdFor (legacy shim) is deterministic and depends only on outputNoun family", () => {
    const id1 = obligationIdFor("rule_X", "archived", "insight_X");
    const id2 = obligationIdFor("rule_X", "archived", "insight_X");
    assert.equal(id1, id2);
    assert.match(id1, /^oblg_[0-9a-f]{16}$/);
    const id3 = obligationIdFor("rule_X", "merged_record", "insight_X");
    assert.notEqual(id1, id3);
    // ruleId / insightId no longer differentiate — legacy callers that
    // varied them still get a stable id for the same outputNoun family.
    const id4 = obligationIdFor("rule_Y", "archived", "insight_Y");
    assert.equal(id1, id4);
  });

  it("recordRatioSatisfied closes the open obligation and projects status=satisfied", () => {
    const d = recordRatioDeficit(makeDeficit({ deficitCount: 50 }));
    assert.ok(d.ok);
    if (!d.ok) return;
    assert.equal(getOpenObligations().length, 1);
    const s = recordRatioSatisfied({
      ruleId: "rule_test_1",
      insightId: "insight_test_1",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      expectedCount: 226,
      actualCount: 226,
      inputCount: 1131,
      tickedAt: Date.now(),
    });
    assert.ok(s.ok);
    if (!s.ok) return;
    assert.equal(s.event.type, "satisfied");
    assert.equal(s.event.requiredActionCount, 0);
    // No open obligation now.
    assert.equal(getOpenObligations().length, 0);
    // But the projection still includes the row, with status=satisfied.
    const projected = projectObligations();
    assert.equal(projected.length, 1);
    assert.equal(projected[0].status, "satisfied");
  });

  it("recordRatioSatisfied no-ops when nothing is open", () => {
    const s = recordRatioSatisfied({
      ruleId: "no_such_rule",
      insightId: "no_such_insight",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      expectedCount: 0,
      actualCount: 0,
      inputCount: 0,
      tickedAt: Date.now(),
    });
    assert.equal(s.ok, false, "should refuse without an open obligation to close");
    assert.equal(getOpenObligations().length, 0);
  });

  it("returns [] from projection when ledger is missing", () => {
    assert.equal(getOpenObligations().length, 0);
    assert.equal(projectObligations().length, 0);
    assert.equal(readObligationEvents().length, 0);
  });

  it("tolerates corrupt JSONL lines without throwing", () => {
    fs.writeFileSync(LEDGER_FILE, "not-json\n{}\n", "utf8");
    assert.doesNotThrow(() => readObligationEvents());
    // After a real append, the projection still works.
    const r = recordRatioDeficit(makeDeficit());
    assert.ok(r.ok);
    assert.equal(getOpenObligations().length, 1);
  });

  it("refuses invalid inputs without writing", () => {
    const before = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
    const r1 = recordRatioDeficit({ ...makeDeficit(), deficitCount: 0 });
    const r2 = recordRatioDeficit({ ...makeDeficit(), deficitCount: -3 });
    const r3 = recordRatioDeficit({ ...makeDeficit(), ruleId: "" });
    const r4 = recordRatioDeficit({ ...makeDeficit(), outputNoun: "" });
    const r5 = recordRatioDeficit({ ...makeDeficit(), inputNoun: "" });
    const r6 = recordRatioDeficit({ ...makeDeficit(), insightId: "" });
    for (const r of [r1, r2, r3, r4, r5, r6]) {
      assert.equal(r.ok, false, "invalid input should be refused");
    }
    const after = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
    assert.equal(after, before, "refusal must not write to the ledger");
  });

  it("produces a natural-language reason mentioning the cap and 'not a hard block'", () => {
    const r = recordRatioDeficit(makeDeficit({ deficitCount: 174 }));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.match(r.event.reason, /archive or merge up to \d+/i);
    assert.match(r.event.reason, /not a hard block/i);
    assert.match(r.event.reason, /KB writes are not gated/i);
  });

  it("preserves the bound cap at the documented constant", () => {
    assert.equal(typeof OBLIGATION_BOUND_CAP, "number");
    assert.ok(OBLIGATION_BOUND_CAP >= 1);
    assert.ok(OBLIGATION_BOUND_CAP <= 20, "cap must remain bounded and reviewable");
  });
});
