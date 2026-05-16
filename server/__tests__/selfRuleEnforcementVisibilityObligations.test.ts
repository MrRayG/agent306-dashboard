/**
 * Visibility tests for the bounded corrective obligation surface.
 *
 * Invariants pinned by this file:
 *   1. The visibility snapshot's `correctiveObligations` is empty when no
 *      obligation has been recorded.
 *   2. When `recordRatioDeficit` writes an obligation, the visibility
 *      snapshot surfaces it under `correctiveObligations` with a
 *      natural-language summary mentioning the cap and "not a hard block".
 *   3. The snapshot's `correctiveObligationCap` mirrors the documented cap.
 *   4. Calling buildSelfRuleEnforcementVisibility() does NOT mutate the
 *      obligation ledger.
 *   5. Repeated deficits update the SAME obligation in the snapshot
 *      (no duplicates).
 *   6. A satisfied obligation is removed from `correctiveObligations`.
 *
 * Run: npx tsx --test server/__tests__/selfRuleEnforcementVisibilityObligations.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "selfRuleVisObl-test-"),
);
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const ENFORCEMENT_FILE = path.join(TMP_DIR, "enforcement_rules.json");
const OBLIGATION_FILE = path.join(TMP_DIR, "rule_corrective_obligations.jsonl");

const { db } = await import("../db.js");
const { engineEvents } = await import("@shared/schema");
const {
  recordRatioDeficit,
  recordRatioSatisfied,
  OBLIGATION_BOUND_CAP,
} = await import("../ruleCorrectiveObligations.js");
const {
  buildSelfRuleEnforcementVisibility,
} = await import("../selfRuleEnforcementVisibility.js");
const { registerRule } = await import("../actionEnforcer.js");

function wipe(): void {
  try { db.delete(engineEvents).run(); } catch {}
  try { if (fs.existsSync(ENFORCEMENT_FILE)) fs.unlinkSync(ENFORCEMENT_FILE); } catch {}
  try { if (fs.existsSync(OBLIGATION_FILE)) fs.unlinkSync(OBLIGATION_FILE); } catch {}
}

function hashFile(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

describe("Self-Rule Enforcement visibility — corrective obligations", () => {
  beforeEach(() => wipe());

  it("zero-state: snapshot exposes correctiveObligations=[] and the cap constant", () => {
    const snap = buildSelfRuleEnforcementVisibility();
    assert.ok(Array.isArray(snap.correctiveObligations));
    assert.equal(snap.correctiveObligations.length, 0);
    assert.equal(snap.correctiveObligationCap, OBLIGATION_BOUND_CAP);
  });

  it("surfaces an open obligation with bounded count and natural-language summary", () => {
    const r = recordRatioDeficit({
      ruleId: "rule_vis_1",
      insightId: "insight_vis_1",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 174,
      expectedCount: 226,
      actualCount: 52,
      inputCount: 1131,
      tickedAt: Date.parse("2026-05-16T12:00:00Z"),
    });
    assert.ok(r.ok);
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.correctiveObligations.length, 1);
    const o = snap.correctiveObligations[0];
    assert.equal(o.status, "open");
    assert.equal(o.requiredActionCount, OBLIGATION_BOUND_CAP);
    assert.equal(o.deficitCount, 174);
    assert.equal(o.cap, OBLIGATION_BOUND_CAP);
    assert.equal(o.outputNoun, "archived");
    assert.equal(o.inputNoun, "kb_entry");
    assert.equal(o.actualCount, 52);
    assert.equal(o.expectedCount, 226);
    assert.equal(o.inputCount, 1131);
    assert.equal(o.refreshCount, 0);
    assert.match(o.summary, /A corrective obligation has been queued/i);
    assert.match(o.summary, new RegExp(`up to ${OBLIGATION_BOUND_CAP} archived`));
    assert.match(o.summary, /NOT a hard block/);
  });

  it("the headline mentions the cap and that obligations are non-blocking", () => {
    // We must also register the rule so the headline goes down the
    // "active rules" branch (not the "no rules" branch).
    registerRule({
      id: "rule_vis_hdr",
      insightId: "insight_vis_hdr",
      primitive: "ratio_rule",
      params: { inputCount: 1, inputNoun: "kb_entry", outputCount: 1, outputNoun: "archived" },
      criterion: "test",
      createdAt: Date.now(),
      enabled: true,
      fireCount: 0,
      lastFiredAt: null,
    });
    recordRatioDeficit({
      ruleId: "rule_vis_hdr",
      insightId: "insight_vis_hdr",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 50,
      expectedCount: 50,
      actualCount: 0,
      inputCount: 50,
      tickedAt: Date.now(),
    });
    const snap = buildSelfRuleEnforcementVisibility();
    assert.match(snap.headline, /corrective obligation/i);
    assert.match(snap.headline, /non-blocking/);
    assert.match(snap.headline, new RegExp(`cap=${OBLIGATION_BOUND_CAP}`));
  });

  it("repeated deficits do not duplicate the obligation in the snapshot", () => {
    for (let i = 0; i < 5; i++) {
      recordRatioDeficit({
        ruleId: "rule_repeat",
        insightId: "insight_repeat",
        outputNoun: "archived",
        inputNoun: "kb_entry",
        deficitCount: 80,
        expectedCount: 80,
        actualCount: 0,
        inputCount: 80,
        tickedAt: Date.now(),
      });
    }
    const snap = buildSelfRuleEnforcementVisibility();
    assert.equal(snap.correctiveObligations.length, 1);
    assert.equal(snap.correctiveObligations[0].refreshCount, 4);
  });

  it("satisfied obligation is removed from correctiveObligations", () => {
    recordRatioDeficit({
      ruleId: "rule_sat",
      insightId: "insight_sat",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 10,
      expectedCount: 10,
      actualCount: 0,
      inputCount: 10,
      tickedAt: Date.now(),
    });
    assert.equal(buildSelfRuleEnforcementVisibility().correctiveObligations.length, 1);
    recordRatioSatisfied({
      ruleId: "rule_sat",
      insightId: "insight_sat",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      expectedCount: 10,
      actualCount: 10,
      inputCount: 10,
      tickedAt: Date.now(),
    });
    assert.equal(buildSelfRuleEnforcementVisibility().correctiveObligations.length, 0);
  });

  it("the snapshot is read-only — calling it does not mutate the obligation ledger", () => {
    recordRatioDeficit({
      ruleId: "rule_readonly",
      insightId: "insight_readonly",
      outputNoun: "archived",
      inputNoun: "kb_entry",
      deficitCount: 12,
      expectedCount: 12,
      actualCount: 0,
      inputCount: 12,
      tickedAt: Date.now(),
    });
    const before = hashFile(OBLIGATION_FILE);
    buildSelfRuleEnforcementVisibility();
    buildSelfRuleEnforcementVisibility();
    const after = hashFile(OBLIGATION_FILE);
    assert.equal(after, before, "obligation ledger must not be mutated by the builder");
  });
});
