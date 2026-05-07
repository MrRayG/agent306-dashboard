/**
 * Tests for research-cycle meta-improvement (PR #286).
 *
 * Spec invariants this file pins:
 *   1. Every cycle appends a lesson to improvementArchive (no silent skips).
 *   2. Anomalous stats produce procedure-change proposals filed via
 *      proposeRecommendation — status='proposed', never auto-applied.
 *   3. Healthy cycles produce zero proposals.
 *   4. Below the minimum cycle size, no proposals fire (avoid noisy signals).
 *   5. Procedure-change proposals are deduped via a stable key so the same
 *      anomaly does not pile up across cycles.
 *   6. The promotion gate / approval invariant is intact — applying a fresh
 *      proposal without prior approve() is refused.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "meta-improve-test-"));
process.env.DATA_DIR = TMP;

const {
  runResearchCycleMetaImprovement,
  deriveProcedureChangeProposals,
  LOW_PASS_RATE_THRESHOLD,
  HIGH_MISSING_PROTOCOL_RATE,
  MIN_CYCLE_SIZE_FOR_PROCEDURE_CHANGE,
} = await import("../researchCycleMetaImprovement.ts");
const { readImprovementArchive } = await import("../improvementArchive.ts");
const { db } = await import("../db.ts");
const { selfRecommendations } = await import("@shared/schema");
const {
  applyRecommendation,
  listRecommendations,
} = await import("../selfRecommendationEngine.ts");

function wipeRecs() {
  try { db.delete(selfRecommendations).run(); } catch {}
}

const goodRecord = {
  candidateRef: "ok",
  verdict: "pursue" as const,
  overall: 8.2,
  hadProtocol: true,
  isDuplicate: false,
  reason: "passes",
  recordedAt: new Date().toISOString(),
};

function recOverridden(r: Partial<typeof goodRecord>) {
  return { ...goodRecord, ...r, recordedAt: new Date().toISOString() };
}

describe("deriveProcedureChangeProposals", () => {
  it("returns no proposals when stats are healthy", () => {
    const stats = {
      total: 10, pursued: 4, reviewed: 4, rejected: 2,
      missingScores: 0, missingProtocol: 1, duplicateOrNear: 1, capExceeded: 0,
      passRate: 0.4, completionRate: 0.8,
    };
    assert.deepEqual(deriveProcedureChangeProposals(stats), []);
  });

  it("flags low pass rate when below floor", () => {
    const stats = {
      total: 10, pursued: 0, reviewed: 5, rejected: 5,
      missingScores: 0, missingProtocol: 0, duplicateOrNear: 0, capExceeded: 0,
      passRate: 0,
      completionRate: 0.5,
    };
    const props = deriveProcedureChangeProposals(stats);
    assert.ok(props.some(p => p.title.includes("pursue rate")));
    assert.ok(LOW_PASS_RATE_THRESHOLD > 0);
  });

  it("flags missing-protocol majority", () => {
    const stats = {
      total: 10, pursued: 1, reviewed: 8, rejected: 1,
      missingScores: 0, missingProtocol: 8, duplicateOrNear: 0, capExceeded: 0,
      passRate: 0.1, completionRate: 0.9,
    };
    const props = deriveProcedureChangeProposals(stats);
    assert.ok(props.some(p => p.title.includes("self-experiment protocol")));
    assert.ok(HIGH_MISSING_PROTOCOL_RATE > 0);
  });

  it("returns no proposals when total < minimum cycle size (avoid noisy signals)", () => {
    const stats = {
      total: 1, pursued: 0, reviewed: 0, rejected: 1,
      missingScores: 1, missingProtocol: 1, duplicateOrNear: 1, capExceeded: 1,
      passRate: 0, completionRate: 0,
    };
    assert.equal(deriveProcedureChangeProposals(stats).length, 0);
    assert.ok(MIN_CYCLE_SIZE_FOR_PROCEDURE_CHANGE >= 2);
  });
});

describe("runResearchCycleMetaImprovement", () => {
  before(wipeRecs);
  beforeEach(wipeRecs);

  it("always appends an archive record for the cycle, even when nothing is anomalous", () => {
    const before = readImprovementArchive().length;
    const records = [
      recOverridden({ verdict: "pursue", reason: "ok" }),
      recOverridden({ verdict: "pursue", reason: "ok" }),
      recOverridden({ verdict: "review", reason: "ok", hadProtocol: false }),
    ];
    const out = runResearchCycleMetaImprovement({
      cycleId: "test-healthy",
      recordsOverride: records,
    })!;
    assert.ok(out, "must return a result");
    const after = readImprovementArchive().length;
    assert.equal(after, before + 1);
    assert.equal(out.recommendations.length, 0);
    assert.match(out.archiveRecord.variantLabel, /test-healthy/);
  });

  it("files a propose-only self-recommendation when stats are anomalous", () => {
    const records: any[] = [];
    // 10 candidates, all sub-threshold rejects → 0% pass rate triggers proposal.
    for (let i = 0; i < 10; i++) {
      records.push(recOverridden({
        verdict: "reject",
        overall: 4,
        hadProtocol: true,
        reason: "below threshold",
      }));
    }
    const out = runResearchCycleMetaImprovement({
      cycleId: "test-bad-pass-rate",
      recordsOverride: records,
    })!;
    assert.ok(out.recommendations.length >= 1);
    for (const rec of out.recommendations) {
      assert.equal(rec.status, "proposed", "every filed rec must start as 'proposed'");
      assert.equal(rec.category, "engine");
      assert.equal(rec.risk, "low");
    }
    // The archive record should reference the proposal.
    assert.equal(out.archiveRecord.proposesChange, true);
  });

  it("dedupes the same procedure-change anomaly across consecutive cycles", () => {
    // First cycle: anomalous → files rec.
    const recs = Array.from({ length: 8 }, () =>
      recOverridden({ verdict: "reject", overall: 3, reason: "low" }));
    const a = runResearchCycleMetaImprovement({
      cycleId: "dup-cycle-A",
      recordsOverride: recs,
    })!;
    assert.ok(a.recommendations.length >= 1);

    // Second cycle: same anomaly. Dedupe key matches → returns the existing rec.
    const b = runResearchCycleMetaImprovement({
      cycleId: "dup-cycle-B",
      recordsOverride: recs,
    })!;
    assert.equal(b.recommendations[0].id, a.recommendations[0].id,
      "same anomaly should collapse via dedupeKey");
  });

  it("propose-only invariant: a freshly proposed rec cannot become 'applied' without approve() (CRITICAL)", async () => {
    const recs = Array.from({ length: 8 }, () =>
      recOverridden({ verdict: "reject", overall: 3, reason: "low" }));
    const out = runResearchCycleMetaImprovement({
      cycleId: "approval-test",
      recordsOverride: recs,
    })!;
    assert.ok(out.recommendations.length >= 1);
    const rec = out.recommendations[0];
    assert.equal(rec.status, "proposed");

    // Apply must refuse — no approve() yet.
    const applyResult = await applyRecommendation(rec.id, "test-operator");
    assert.equal(applyResult.ok, false);
    assert.match(applyResult.reason ?? "", /cannot apply in status 'proposed'/);

    // Listing the rec confirms it is still 'proposed' (the engine made no
    // bypass write).
    const live = listRecommendations({ status: "proposed" }).find(r => r.id === rec.id);
    assert.ok(live, "rec must remain in 'proposed'");
  });

  it("returns null when no cycle is active and no recordsOverride provided", () => {
    const out = runResearchCycleMetaImprovement({});
    assert.equal(out, null);
  });

  it("when fileRecommendations=false, no recs are filed even on anomalous stats", () => {
    const recs = Array.from({ length: 8 }, () =>
      recOverridden({ verdict: "reject", overall: 3, reason: "low" }));
    const before = listRecommendations({}).length;
    const out = runResearchCycleMetaImprovement({
      cycleId: "no-file",
      recordsOverride: recs,
      fileRecommendations: false,
    })!;
    assert.equal(out.recommendations.length, 0);
    assert.equal(listRecommendations({}).length, before);
  });
});
