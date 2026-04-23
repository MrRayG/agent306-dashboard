/**
 * Tests for the Insight Ledger — spec §2.1 lifecycle.
 *
 * Covers: recordProposedInsights, transitionEntry, expireStaleProposed,
 * failStaleOpen, getLedgerSummary.
 *
 * Run: npx tsx --test server/__tests__/insightLedger.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const LEDGER_FILE = dataPath("insight_ledger.json");

function cleanLedger() {
  try { if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE); } catch {}
}

describe("InsightLedger", () => {
  let recordProposedInsights: typeof import("../insightLedger.js").recordProposedInsights;
  let transitionEntry: typeof import("../insightLedger.js").transitionEntry;
  let expireStaleProposed: typeof import("../insightLedger.js").expireStaleProposed;
  let failStaleOpen: typeof import("../insightLedger.js").failStaleOpen;
  let getLedgerSummary: typeof import("../insightLedger.js").getLedgerSummary;
  let loadLedger: typeof import("../insightLedger.js").loadLedger;
  let saveLedger: typeof import("../insightLedger.js").saveLedger;

  beforeEach(async () => {
    cleanLedger();
    const mod = await import("../insightLedger.js");
    recordProposedInsights = mod.recordProposedInsights;
    transitionEntry = mod.transitionEntry;
    expireStaleProposed = mod.expireStaleProposed;
    failStaleOpen = mod.failStaleOpen;
    getLedgerSummary = mod.getLedgerSummary;
    loadLedger = mod.loadLedger;
    saveLedger = mod.saveLedger;
  });

  afterEach(() => {
    cleanLedger();
  });

  it("recordProposedInsights creates entries only for insights with actionItem", () => {
    const created = recordProposedInsights(7, [
      { id: "i1", insight: "Insight A", actionItem: "Do A" },
      { id: "i2", insight: "Insight B" }, // no action — skipped
      { id: "i3", insight: "Insight C", actionItem: "Do C" },
    ]);
    assert.equal(created.length, 2);
    for (const e of created) {
      assert.equal(e.status, "proposed");
      assert.equal(e.cycleNumber, 7);
      assert.equal(e.retryCount, 0);
      assert.ok(e.id.startsWith("il_"));
    }
    const ledger = loadLedger();
    assert.equal(ledger.lastCycleReflected, 7);
  });

  it("transitionEntry moves through proposed → accepted → in_flight → verified", () => {
    const [entry] = recordProposedInsights(1, [
      { id: "src1", insight: "X", actionItem: "Do X" },
    ]);
    assert.equal(entry.status, "proposed");

    const accepted = transitionEntry(entry.id, "accepted", { ruleId: "rule-1" });
    assert.ok(accepted);
    assert.equal(accepted!.status, "accepted");
    assert.ok(accepted!.acceptedAt, "acceptedAt should be stamped");
    assert.equal(accepted!.ruleId, "rule-1");

    const inFlight = transitionEntry(entry.id, "in_flight");
    assert.equal(inFlight!.status, "in_flight");

    const verified = transitionEntry(entry.id, "verified", {
      evidenceOfChange: ["rule fired 5x"],
    });
    assert.equal(verified!.status, "verified");
    assert.ok(verified!.verifiedAt);
    assert.deepEqual(verified!.evidenceOfChange, ["rule fired 5x"]);
  });

  it("transitionEntry returns null for unknown id", () => {
    const result = transitionEntry("does-not-exist", "accepted");
    assert.equal(result, null);
  });

  it("expireStaleProposed marks old proposed entries expired", () => {
    const [entry] = recordProposedInsights(1, [
      { id: "s1", insight: "stale", actionItem: "act" },
    ]);
    // Rewrite createdAt to 10 days ago
    const ledger = loadLedger();
    ledger.entries[0].createdAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
    saveLedger(ledger);

    const count = expireStaleProposed(3);
    assert.equal(count, 1);
    const after = loadLedger();
    const e = after.entries.find(x => x.id === entry.id)!;
    assert.equal(e.status, "expired");
    assert.ok(e.expiredAt);
    assert.match(e.selfChangeFailureReason ?? "", /3-day TTL/);
  });

  it("expireStaleProposed leaves recent entries alone", () => {
    recordProposedInsights(1, [{ id: "fresh", insight: "i", actionItem: "a" }]);
    const count = expireStaleProposed(3);
    assert.equal(count, 0);
  });

  it("failStaleOpen transitions accepted/in_flight past window to failed", () => {
    const [entry] = recordProposedInsights(1, [
      { id: "open1", insight: "i", actionItem: "a" },
    ]);
    transitionEntry(entry.id, "accepted");

    // Backdate acceptedAt 20 days
    const ledger = loadLedger();
    ledger.entries[0].acceptedAt = Date.now() - 20 * 24 * 60 * 60 * 1000;
    saveLedger(ledger);

    const count = failStaleOpen(14);
    assert.equal(count, 1);
    const after = loadLedger();
    const e = after.entries.find(x => x.id === entry.id)!;
    assert.equal(e.status, "failed");
    assert.ok(e.failedAt);
  });

  it("getLedgerSummary returns counts and self-integrity score", () => {
    const created = recordProposedInsights(2, [
      { id: "s1", insight: "a", actionItem: "x" },
      { id: "s2", insight: "b", actionItem: "y" },
      { id: "s3", insight: "c", actionItem: "z" },
    ]);
    // Accept all, then verify two, fail one
    for (const e of created) transitionEntry(e.id, "accepted");
    transitionEntry(created[0].id, "verified");
    transitionEntry(created[1].id, "verified");
    transitionEntry(created[2].id, "failed");

    const summary = getLedgerSummary();
    assert.equal(summary.verified30d, 2);
    assert.equal(summary.failed30d, 1);
    assert.equal(summary.lastCycleReflected, 2);
    // 2 verified / (2 + 1) = 0.67 → rounded to 0.67
    assert.ok(summary.selfIntegrity >= 0.66 && summary.selfIntegrity <= 0.68);
  });
});
