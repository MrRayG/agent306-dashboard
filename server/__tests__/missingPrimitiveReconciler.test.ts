/**
 * PR #410 — missingPrimitiveReconciler tests.
 *
 * Pins the 6 invariants documented at the top of
 * server/missingPrimitiveReconciler.ts:
 *
 *   1. Recs whose insight now translates to a real primitive → REJECTED.
 *   2. Recs whose insight still returns "none" → UNCHANGED.
 *   3. Recs whose ledger entry no longer exists → UNCHANGED (warn-logged).
 *   4. Non-missing-primitive recs are never touched.
 *   5. Approved/rejected/closed recs are never touched (only `proposed`).
 *   6. The cap is respected (drains earliest N first).
 *
 * Run: npx tsx --test server/__tests__/missingPrimitiveReconciler.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB / DATA_DIR isolation. Same pattern as selfRecommendationDedupe.test.ts.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "missingPrimReconciler-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

// Dynamic imports so env vars above are in place before db.ts / dataPaths.ts evaluate.
const { db } = await import("../db.js");
const { selfRecommendations } = await import("@shared/schema");
const {
  proposeRecommendation,
  approveRecommendation,
  listRecommendations,
  getRecommendation,
} = await import("../selfRecommendationEngine.js");
const { loadLedger, saveLedger } = await import("../insightLedger.js");
const { reconcileMissingPrimitiveRecs } = await import("../missingPrimitiveReconciler.js");

function wipeRecs() {
  try {
    db.delete(selfRecommendations).run();
  } catch {}
}

function wipeLedger() {
  saveLedger({ entries: [], lastCycleReflected: 0, lastUpdated: new Date().toISOString() });
}

function seedLedgerEntry(opts: {
  id: string;
  insight: string;
  proposedAction: string;
}) {
  const ledger = loadLedger();
  ledger.entries.unshift({
    id: opts.id,
    cycleNumber: 1,
    createdAt: Date.now(),
    insight: opts.insight,
    proposedAction: opts.proposedAction,
    sourceId: `evo_${opts.id}`,
    status: "proposed",
    retryCount: 0,
  });
  saveLedger(ledger);
}

// Insight wordings copied verbatim from the live production rec backlog
// triaged in this session — these are real failures the #409 sweep aimed
// to clear. The reconciler must translate them and auto-reject the recs.
const REAL_TRANSLATABLE_INSIGHTS = {
  ttl: {
    id: "il_test_ttl",
    insight:
      "Two awaiting-deadline hypotheses are drifting without interim checkpoints.",
    action:
      "For both awaiting-deadline hypotheses, define 2 specific interim evidence checkpoints with dates and exact search queries. If no new evidence surfaces at the first checkpoint, downgrade to speculative",
  },
  gate: {
    id: "il_test_gate",
    insight:
      "Self-change rules currently observe rather than gate behavior at action time.",
    action:
      "Replace all current monitoring-style self-change rules with maximum 3 IF-THEN behavioral gate rules that trigger AT the moment of action (KB addition, hypothesis creation, research query) rather than after the fact.",
  },
  rewrite: {
    id: "il_test_rewrite",
    insight:
      "Hypotheses framed as positional debates aren't producing falsifiable predictions.",
    action:
      "Reframe all remaining active hypotheses: any that are structured as 'Position A is more accurate than Position B' must be converted to research-gap format ('What evidence would distinguish X from Y?')",
  },
};

describe("missingPrimitiveReconciler — invariants", () => {
  before(() => {
    wipeRecs();
    wipeLedger();
  });
  beforeEach(() => {
    wipeRecs();
    wipeLedger();
  });
  after(() => {
    wipeRecs();
    wipeLedger();
  });

  it("invariant 1: rejects rec whose insight now translates (ttl)", () => {
    const { id, insight, action } = REAL_TRANSLATABLE_INSIGHTS.ttl;
    seedLedgerEntry({ id, insight, proposedAction: action });
    const rec = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: ttl family — action translator could not parse insight",
      rationale: `GoalEngine could not translate insight ${id}.`,
      proposedChange: "Add a `ttl` enforcement primitive (expire items after N days).",
      sourceInsightId: id,
    });

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(result.reconciled, 1, "should reconcile the one ttl rec");
    assert.equal(result.rejectedRecIds.length, 1);
    assert.equal(result.rejectedRecIds[0], rec.id);

    const after = getRecommendation(rec.id)!;
    assert.equal(after.status, "rejected");
    assert.equal(after.approvedBy, "reconciler");
    assert.match(
      after.reviewNote ?? "",
      /reconciler.*translator now resolves.*ttl_rule/,
      "rejection note should name the primitive that now catches it",
    );
  });

  it("invariant 1 (multi-family): rejects ttl + gate + rewrite recs in one pass", () => {
    for (const [famKey, fam] of Object.entries(REAL_TRANSLATABLE_INSIGHTS)) {
      seedLedgerEntry({ id: fam.id, insight: fam.insight, proposedAction: fam.action });
      proposeRecommendation({
        category: "engine",
        title: `missing-primitive: ${famKey} family — action translator could not parse insight`,
        rationale: `GoalEngine could not translate insight ${fam.id}.`,
        proposedChange: "Add a primitive.",
        sourceInsightId: fam.id,
        // Each family gets a unique dedupeKey so all 3 proposals land as
        // distinct rows (otherwise content-fingerprint dedupe collapses them).
        dedupeKey: `multi-family-${famKey}`,
      });
    }

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(result.scanned, 3);
    assert.equal(result.reconciled, 3);
    assert.equal(result.stillUnparseable, 0);
    assert.equal(result.errors, 0);
  });

  it("invariant 2: leaves rec untouched when insight still returns 'none'", () => {
    const id = "il_test_unparseable";
    seedLedgerEntry({
      id,
      insight: "The agent should be wiser somehow about its own knowledge.",
      // Genuinely vague — no current primitive catches this shape.
      proposedAction: "Be more thoughtful and intentional when adding knowledge.",
    });
    const rec = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: other family — action translator could not parse insight",
      rationale: "vague action",
      proposedChange: "classify and sharpen.",
      sourceInsightId: id,
    });

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(result.reconciled, 0);
    assert.equal(result.stillUnparseable, 1);
    assert.equal(getRecommendation(rec.id)!.status, "proposed");
  });

  it("invariant 3: leaves rec untouched when ledger entry is missing (rotated out)", () => {
    // No seedLedgerEntry — simulates LEDGER_CAP rotation.
    const rec = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: artifact family — action translator could not parse insight",
      rationale: "long-stale rec",
      proposedChange: "Add artifact primitive.",
      sourceInsightId: "il_rotated_out_of_ledger",
    });

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(result.missingLedgerEntry, 1);
    assert.equal(result.reconciled, 0);
    assert.equal(getRecommendation(rec.id)!.status, "proposed");
  });

  it("invariant 4: never touches non-missing-primitive recs", () => {
    const { id, insight, action } = REAL_TRANSLATABLE_INSIGHTS.ttl;
    seedLedgerEntry({ id, insight, proposedAction: action });
    const operatorRec = proposeRecommendation({
      category: "engine",
      title: "Operator-drafted improvement plan",
      rationale: "Operator filed this.",
      proposedChange: "Tighten close-gate wiring.",
      sourceInsightId: id, // same insight, but title prefix differs
    });

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(result.scanned, 0, "operator rec must not be scanned");
    assert.equal(result.reconciled, 0);
    assert.equal(getRecommendation(operatorRec.id)!.status, "proposed");
  });

  it("invariant 5: never touches approved/rejected recs (only `proposed`)", () => {
    const { id, insight, action } = REAL_TRANSLATABLE_INSIGHTS.ttl;
    seedLedgerEntry({ id, insight, proposedAction: action });
    const rec = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: ttl family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add ttl.",
      sourceInsightId: id,
    });
    // Operator already approved this one — reconciler should not double-handle it.
    approveRecommendation(rec.id, "operator-test", "I want this");

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(result.scanned, 0);
    assert.equal(result.reconciled, 0);
    assert.equal(getRecommendation(rec.id)!.status, "approved");
  });

  it("invariant 6: respects the cap (drains earliest N first)", async () => {
    // Seed 5 translatable rec/insight pairs, cap at 2 → only 2 reconciled.
    // Stagger createdAt by sleeping a millisecond so list order is stable.
    const families = Object.values(REAL_TRANSLATABLE_INSIGHTS);
    const seeded: Array<{ recId: string; insightId: string }> = [];
    for (let i = 0; i < 5; i++) {
      const fam = families[i % families.length];
      const insightId = `${fam.id}_${i}`;
      seedLedgerEntry({ id: insightId, insight: fam.insight, proposedAction: fam.action });
      const rec = proposeRecommendation({
        category: "engine",
        title: "missing-primitive: ttl family — action translator could not parse insight",
        rationale: `seed #${i}`,
        proposedChange: "Add primitive.",
        sourceInsightId: insightId,
        // Vary the dedupeKey so each rec is distinct.
        dedupeKey: `test-cap-${i}`,
      });
      seeded.push({ recId: rec.id, insightId });
      await new Promise((r) => setTimeout(r, 2));
    }

    const result = reconcileMissingPrimitiveRecs({ maxReconciledPerRun: 2 });

    assert.equal(result.reconciled, 2, "cap of 2 honored");
    // listRecommendations is desc by createdAt → reversed inside the
    // reconciler → oldest two first. Those are seeded[0] and seeded[1].
    const rejected = result.rejectedRecIds.sort();
    const oldestTwo = [seeded[0].recId, seeded[1].recId].sort();
    assert.deepEqual(rejected, oldestTwo, "oldest two recs are reconciled first");

    // The remaining 3 should still be `proposed`.
    for (let i = 2; i < 5; i++) {
      assert.equal(
        getRecommendation(seeded[i].recId)!.status,
        "proposed",
        `seed #${i} should remain proposed under the cap`,
      );
    }
  });

  it("idempotency: a second call after a successful pass is a no-op", () => {
    const { id, insight, action } = REAL_TRANSLATABLE_INSIGHTS.gate;
    seedLedgerEntry({ id, insight, proposedAction: action });
    proposeRecommendation({
      category: "engine",
      title: "missing-primitive: gate family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add gate.",
      sourceInsightId: id,
    });

    const first = reconcileMissingPrimitiveRecs();
    assert.equal(first.reconciled, 1);

    const second = reconcileMissingPrimitiveRecs();
    assert.equal(second.scanned, 0, "no `proposed` missing-primitive recs remain");
    assert.equal(second.reconciled, 0);
  });
});
