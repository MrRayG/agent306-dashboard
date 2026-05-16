/**
 * Tests for ActionEnforcer ↔ ruleCorrectiveObligations integration.
 *
 * Invariants pinned by this file:
 *   1. A ratio_rule deficit on tickEnforcer() creates exactly ONE bounded
 *      corrective obligation in data/rule_corrective_obligations.jsonl.
 *   2. The huge real-world deficit (174) is capped at OBLIGATION_BOUND_CAP.
 *   3. Repeated ticks on the same rule REFRESH the same obligation — they
 *      never duplicate it.
 *   4. When the ratio is met (no deficit), tickEnforcer() does NOT create
 *      any obligation event.
 *   5. structured engine_events are emitted: correctiveObligationOpened
 *      on first deficit, correctiveObligationRefreshed on a repeat tick.
 *   6. If the obligation ledger throws (e.g. unwritable path), the tick
 *      still completes — observability failures cannot break the tick.
 *
 * Run: npx tsx --test server/__tests__/actionEnforcerCorrectiveObligation.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "actionEnforcerObligation-test-"),
);
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const ENFORCEMENT_FILE = path.join(TMP_DIR, "enforcement_rules.json");
const OBLIGATION_FILE = path.join(TMP_DIR, "rule_corrective_obligations.jsonl");
const KNOWLEDGE_FILE = path.join(TMP_DIR, "memory_knowledge.json");

// Seed the KB BEFORE memoryEngine imports — 1131 active entries triggers the
// canonical 174-deficit on a 5:1 ratio rule.
{
  const seedEntries = Array.from({ length: 1131 }, (_, i) => ({
    id: `kb_${i}`,
    content: "x",
    status: "active",
    createdAt: new Date().toISOString(),
  }));
  fs.writeFileSync(
    KNOWLEDGE_FILE,
    JSON.stringify({ entries: seedEntries, version: 1 }, null, 2),
  );
}

const { db } = await import("../db.js");
const { engineEvents } = await import("@shared/schema");
const { registerRule, tickEnforcer } = await import("../actionEnforcer.js");
type EnforcementRule = import("../actionEnforcer.js").EnforcementRule;
const {
  getOpenObligations,
  readObligationEvents,
  OBLIGATION_BOUND_CAP,
} = await import("../ruleCorrectiveObligations.js");

function wipeAll(): void {
  try { db.delete(engineEvents).run(); } catch {}
  try { if (fs.existsSync(ENFORCEMENT_FILE)) fs.unlinkSync(ENFORCEMENT_FILE); } catch {}
  try { if (fs.existsSync(OBLIGATION_FILE)) fs.unlinkSync(OBLIGATION_FILE); } catch {}
}

function makeRatioRule(overrides: Partial<EnforcementRule> = {}): EnforcementRule {
  return {
    id: "rule_obl_test",
    insightId: "insight_obl_test",
    primitive: "ratio_rule",
    params: {
      inputCount: 5,
      inputNoun: "kb_entry",
      outputCount: 1,
      outputNoun: "archived",
    },
    criterion: "ratio test",
    createdAt: Date.now(),
    enabled: true,
    fireCount: 0,
    lastFiredAt: null,
    ...overrides,
  };
}

function obligationEventsByType(type: string) {
  return db
    .select()
    .from(engineEvents)
    .all()
    .filter((r: any) => r.engine === "actionEnforcer" && r.event === type);
}

describe("ActionEnforcer ↔ corrective obligations", () => {
  beforeEach(() => wipeAll());

  it("a single tick with a deficit creates exactly ONE bounded obligation", async () => {
    registerRule(makeRatioRule());
    await tickEnforcer();
    const events = readObligationEvents();
    assert.equal(events.length, 1, `expected exactly one obligation event, got ${events.length}`);
    assert.equal(events[0].type, "opened");

    const open = getOpenObligations();
    assert.equal(open.length, 1);
    assert.equal(open[0].requiredActionCount, OBLIGATION_BOUND_CAP);
    assert.ok(open[0].deficitCount > 0, "raw deficit should be preserved");
    assert.equal(open[0].outputNoun, "archived");
    assert.equal(open[0].inputNoun, "kb_entry");
    assert.equal(open[0].status, "open");
  });

  it("the 174-style real deficit is bounded by OBLIGATION_BOUND_CAP", async () => {
    registerRule(makeRatioRule());
    await tickEnforcer();
    const open = getOpenObligations();
    assert.equal(open.length, 1);
    // Real prod value: expected = floor(1131/5)*1 = 226, actual = 0 → deficit 226.
    // Some test orderings may differ; just assert it's > cap so we're really capping.
    assert.ok(
      open[0].deficitCount > OBLIGATION_BOUND_CAP,
      `expected raw deficit > cap (${OBLIGATION_BOUND_CAP}), got ${open[0].deficitCount}`,
    );
    assert.equal(open[0].requiredActionCount, OBLIGATION_BOUND_CAP);
  });

  it("a second tick REFRESHES the same obligation (no duplicate row)", async () => {
    registerRule(makeRatioRule());
    await tickEnforcer();
    await tickEnforcer();
    const events = readObligationEvents();
    assert.equal(events.length, 2, "two append lines: opened + refreshed");
    assert.equal(events[0].type, "opened");
    assert.equal(events[1].type, "refreshed");
    assert.equal(events[0].obligationId, events[1].obligationId);
    const open = getOpenObligations();
    assert.equal(open.length, 1, "still exactly ONE open obligation");
    assert.equal(open[0].refreshCount, 1);
  });

  it("emits structured engine_events for opened and refreshed obligations", async () => {
    registerRule(makeRatioRule());
    await tickEnforcer();
    await tickEnforcer();
    const openedEvents = obligationEventsByType("correctiveObligationOpened");
    const refreshedEvents = obligationEventsByType("correctiveObligationRefreshed");
    assert.equal(openedEvents.length, 1, "exactly one opened event on first tick");
    assert.equal(refreshedEvents.length, 1, "exactly one refreshed event on second tick");
    // Payload should carry both deficitCount and the cap.
    const payload = JSON.parse((openedEvents[0] as any).data);
    assert.equal(payload.requiredActionCount, OBLIGATION_BOUND_CAP);
    assert.equal(payload.cap, OBLIGATION_BOUND_CAP);
    assert.ok(payload.deficitCount > 0);
    assert.equal(typeof payload.obligationId, "string");
  });

  it("no deficit → no obligation event", async () => {
    // Use a non-KB inputNoun so the ratio probe never finds a KB path and
    // returns the "no-op (unknown noun pair)" outcome — sideEffect=false,
    // and crucially no deficit branch.
    registerRule(
      makeRatioRule({
        id: "rule_no_deficit",
        insightId: "insight_no_deficit",
        params: {
          inputCount: 1,
          inputNoun: "widget",
          outputCount: 1,
          outputNoun: "thingamabob",
        },
      }),
    );
    await tickEnforcer();
    assert.equal(readObligationEvents().length, 0);
    assert.equal(getOpenObligations().length, 0);
  });

  it("tickEnforcer still completes when the obligation ledger path is unwritable", async () => {
    // Make the data dir read-only AFTER the rule is registered so the
    // enforcement_rules.json file already exists but the JSONL append fails.
    registerRule(makeRatioRule());
    // Force the obligation ledger to be unwritable by creating a directory at
    // its path — fs.appendFileSync on a directory throws EISDIR.
    try { if (fs.existsSync(OBLIGATION_FILE)) fs.unlinkSync(OBLIGATION_FILE); } catch {}
    fs.mkdirSync(OBLIGATION_FILE, { recursive: true });
    let result: any;
    await assert.doesNotReject(async () => {
      result = await tickEnforcer();
    });
    assert.equal(result.rulesFired, 1);
    // Cleanup so subsequent beforeEach can wipe the path.
    try { fs.rmdirSync(OBLIGATION_FILE); } catch {}
  });
});
