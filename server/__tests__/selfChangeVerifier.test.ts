/**
 * Tests for the Self-Change Verifier — spec §2.4.
 *
 * Covers:
 *   - runVerificationPass transitions in_flight → verified when rule fired
 *     enough times AND produced at least one side effect.
 *   - runVerificationPass transitions open → failed when the acceptance
 *     window has elapsed without meeting the bar.
 *   - buildMetaReflectionContext returns non-empty text when there are
 *     recent failed commitments.
 *
 * Run: npx tsx --test server/__tests__/selfChangeVerifier.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const LEDGER_FILE = dataPath("insight_ledger.json");
const RULES_FILE = dataPath("enforcement_rules.json");

function clean() {
  try { if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE); } catch {}
  try { if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE); } catch {}
}

function writeLedger(entries: any[]) {
  fs.writeFileSync(LEDGER_FILE, JSON.stringify({
    entries,
    lastCycleReflected: 0,
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

function writeRules(rules: any[]) {
  fs.writeFileSync(RULES_FILE, JSON.stringify({
    rules,
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

describe("SelfChangeVerifier", () => {
  beforeEach(clean);
  afterEach(clean);

  it("transitions in_flight → verified when fireCount >= 3 AND sideEffectCount >= 1", async () => {
    const now = Date.now();
    writeLedger([
      {
        id: "il_1",
        cycleNumber: 1,
        createdAt: now - 24 * 60 * 60 * 1000,
        insight: "Force a ratio",
        proposedAction: "per 10 kb entries force 1 synthesis",
        sourceId: "src1",
        status: "in_flight",
        acceptedAt: now - 2 * 24 * 60 * 60 * 1000,
        retryCount: 0,
        ruleId: "rule_a",
      },
    ]);
    writeRules([
      {
        id: "rule_a",
        insightId: "il_1",
        primitive: "ratio_rule",
        params: {},
        criterion: "ratio(synthesis/kb_entry) >= 1/10",
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
        enabled: true,
        fireCount: 5,
        lastFiredAt: now - 60_000,
        sideEffectCount: 2,
      },
    ]);

    const { runVerificationPass } = await import("../selfChangeVerifier.js");
    const result = runVerificationPass();
    assert.equal(result.verified, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.stillOpen, 0);

    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const e = ledger.entries.find((x: any) => x.id === "il_1");
    assert.equal(e.status, "verified");
    assert.ok(e.verifiedAt);
  });

  it("transitions open → failed when window elapsed with zero fires", async () => {
    const now = Date.now();
    const longAgo = now - 20 * 24 * 60 * 60 * 1000; // > 14 day window
    writeLedger([
      {
        id: "il_2",
        cycleNumber: 2,
        createdAt: longAgo,
        insight: "TTL on hypotheses",
        proposedAction: "14-day TTL on testing hypotheses",
        sourceId: "src2",
        status: "accepted",
        acceptedAt: longAgo,
        retryCount: 0,
        ruleId: "rule_b",
      },
    ]);
    writeRules([
      {
        id: "rule_b",
        insightId: "il_2",
        primitive: "ttl_rule",
        params: {},
        criterion: "",
        createdAt: longAgo,
        enabled: true,
        fireCount: 0,
        lastFiredAt: null,
        sideEffectCount: 0,
      },
    ]);

    const { runVerificationPass } = await import("../selfChangeVerifier.js");
    const result = runVerificationPass();
    assert.equal(result.failed, 1);

    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const e = ledger.entries.find((x: any) => x.id === "il_2");
    assert.equal(e.status, "failed");
    assert.match(e.selfChangeFailureReason ?? "", /never fired|rule fired/);
  });

  it("keeps commitments open when rule is firing but hasn't met the bar yet", async () => {
    const now = Date.now();
    writeLedger([
      {
        id: "il_3",
        cycleNumber: 3,
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
        insight: "partial",
        proposedAction: "x",
        sourceId: "src3",
        status: "in_flight",
        acceptedAt: now - 2 * 24 * 60 * 60 * 1000,
        retryCount: 0,
        ruleId: "rule_c",
      },
    ]);
    writeRules([
      {
        id: "rule_c",
        insightId: "il_3",
        primitive: "ratio_rule",
        params: {},
        criterion: "",
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
        enabled: true,
        fireCount: 1,        // below threshold
        lastFiredAt: now - 60_000,
        sideEffectCount: 0,  // below threshold
      },
    ]);

    const { runVerificationPass } = await import("../selfChangeVerifier.js");
    const result = runVerificationPass();
    assert.equal(result.verified, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.stillOpen, 1);

    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const e = ledger.entries.find((x: any) => x.id === "il_3");
    assert.equal(e.status, "in_flight", "entry should remain in_flight");
  });

  it("buildMetaReflectionContext returns non-empty text when failed commitments exist", async () => {
    const now = Date.now();
    writeLedger([
      {
        id: "il_f1",
        cycleNumber: 1,
        createdAt: now - 3 * 24 * 60 * 60 * 1000,
        insight: "I will force one synthesis per 10 KB entries",
        proposedAction: "ratio",
        sourceId: "src_f1",
        status: "failed",
        failedAt: now - 60 * 60 * 1000,
        retryCount: 0,
        selfChangeFailureReason: "rule registered but never fired",
      },
    ]);
    writeRules([]);

    const { buildMetaReflectionContext } = await import("../selfChangeVerifier.js");
    const text = buildMetaReflectionContext();
    assert.ok(text.length > 0);
    assert.match(text, /SELF-CHANGE TRACK RECORD/);
    assert.match(text, /Broken/);
    assert.match(text, /synthesis per 10 KB/);
  });

  it("buildMetaReflectionContext handles empty ledger gracefully", async () => {
    writeLedger([]);
    writeRules([]);
    const { buildMetaReflectionContext } = await import("../selfChangeVerifier.js");
    const text = buildMetaReflectionContext();
    assert.match(text, /SELF-CHANGE TRACK RECORD/);
    // No closed items → no "Broken" section
    assert.doesNotMatch(text, /Broken \(/);
  });
});
