/**
 * Calibration backfill — idempotent walk over research_lab.blob.
 *
 * Pins:
 * - empty lab → no rows written, summary all zero
 * - mixed lab (3 confirmed + 2 rejected + 1 forming + 1 awaiting) →
 *     scanned=5, written=5, skippedAwaiting=1, forming uncounted
 * - re-run same lab → all skippedExisting, written=0
 * - dry-run → no rows persisted, summary still reflects what would write
 *
 * The calibrationCapture flag is irrelevant for backfill — this is an
 * operator tool that always writes when not in dry-run. The test does
 * NOT enable the flag.
 *
 * Run: npx tsx --test server/__tests__/calibrationBackfill.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Set DATA_DIR before any module that touches db.ts/dataPaths.ts is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-backfill-"));
process.env.DATA_DIR = tmpDir;
delete process.env.CALIBRATION_CAPTURE;

const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");
const repoMod = await import("../repositories/researchRepository.js");
const backfillMod = await import("../calibration/backfillOutcomes.js");

const { db } = dbMod;
const { hypothesisOutcomes, researchLab } = schemaMod;
const { writeResearchBlob } = repoMod;
const { runBackfill } = backfillMod;

function wipeOutcomes(): void {
  try { db.delete(hypothesisOutcomes).run(); } catch {}
}

function wipeLab(): void {
  try { db.delete(researchLab).run(); } catch {}
  // Also wipe any JSON/.bak files the repo would read through.
  for (const name of ["research_lab.json", "research_lab.json.bak"]) {
    try { fs.unlinkSync(path.join(tmpDir, name)); } catch {}
  }
}

function seedLab(hypotheses: any[]): void {
  writeResearchBlob({
    topics: [],
    hypotheses,
    lastUpdated: new Date().toISOString(),
    stats: {
      totalResearched: 0,
      totalPublished: 0,
      totalDeclined: 0,
      hypothesesFormed: hypotheses.length,
      hypothesesConfirmed: hypotheses.filter(h => h.status === "confirmed").length,
    },
  });
}

function mkHyp(overrides: Record<string, unknown> = {}): any {
  const id = (overrides.id as string | undefined) ?? `hyp_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    claim: "claim",
    basis: "basis",
    metric: "metric",
    prediction: "prediction",
    timeframe: "30 days",
    status: "confirmed",
    confidence: "medium",
    formedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: "2026-02-01T00:00:00.000Z",
    evaluationResult: { confidence: 0.7 },
    trustScore: 70,
    domain: "ai-news",
    ...overrides,
  };
}

describe("runBackfill — idempotent capture of resolved hypotheses", () => {
  before(() => { wipeOutcomes(); wipeLab(); });
  beforeEach(() => { wipeOutcomes(); wipeLab(); });
  after(() => { wipeOutcomes(); wipeLab(); });

  it("empty lab → all-zero summary", async () => {
    seedLab([]);
    const s = await runBackfill();
    assert.deepEqual(s, {
      scanned: 0, written: 0, skippedExisting: 0, skippedAwaiting: 0, errors: 0,
    });
    assert.equal(db.select().from(hypothesisOutcomes).all().length, 0);
  });

  it("mixed lab counts terminal statuses, awaiting separately, forming not at all", async () => {
    const hyps = [
      mkHyp({ id: "c1", status: "confirmed" }),
      mkHyp({ id: "c2", status: "confirmed" }),
      mkHyp({ id: "c3", status: "confirmed" }),
      mkHyp({ id: "r1", status: "rejected" }),
      mkHyp({ id: "r2", status: "rejected" }),
      mkHyp({ id: "f1", status: "forming", resolvedAt: undefined }),
      mkHyp({ id: "a1", status: "awaiting-deadline" }),
    ];
    seedLab(hyps);

    const s = await runBackfill();
    assert.equal(s.scanned, 5, "5 terminal resolutions counted (forming uncounted, awaiting separately)");
    assert.equal(s.written, 5);
    assert.equal(s.skippedExisting, 0);
    assert.equal(s.skippedAwaiting, 1, "awaiting-deadline counted in its own bucket");
    assert.equal(s.errors, 0);

    const rows = db.select().from(hypothesisOutcomes).all();
    assert.equal(rows.length, 5);
    const ids = rows.map((r: any) => r.hypothesisId).sort();
    assert.deepEqual(ids, ["c1", "c2", "c3", "r1", "r2"]);
  });

  it("re-run on same lab is a no-op via (hypothesisId, resolvedAt) idempotency", async () => {
    const hyps = [
      mkHyp({ id: "c1", status: "confirmed" }),
      mkHyp({ id: "r1", status: "rejected" }),
    ];
    seedLab(hyps);

    const first = await runBackfill();
    assert.equal(first.written, 2);

    const second = await runBackfill();
    assert.equal(second.scanned, 2);
    assert.equal(second.written, 0);
    assert.equal(second.skippedExisting, 2);

    // Total rows should remain 2 (no duplicates).
    assert.equal(db.select().from(hypothesisOutcomes).all().length, 2);
  });

  it("dry-run writes nothing but reports the same scan/skipped counts", async () => {
    const hyps = [
      mkHyp({ id: "c1", status: "confirmed" }),
      mkHyp({ id: "c2", status: "confirmed" }),
      mkHyp({ id: "a1", status: "awaiting-deadline" }),
    ];
    seedLab(hyps);

    const s = await runBackfill({ dryRun: true });
    assert.equal(s.scanned, 2);
    assert.equal(s.written, 0, "dry-run must not insert");
    assert.equal(s.skippedExisting, 0);
    assert.equal(s.skippedAwaiting, 1);
    assert.equal(s.errors, 0);

    assert.equal(db.select().from(hypothesisOutcomes).all().length, 0);
  });

  it("populates outcome row fields per design §3.3 (confirmed → true / 1.0 / auto-resolve)", async () => {
    seedLab([
      mkHyp({
        id: "c1",
        status: "confirmed",
        evaluationResult: { confidence: 0.91 },
        trustScore: 88,
        domain: "regulatory",
        originatingModel: "grok-4-reasoning",
      }),
    ]);
    await runBackfill();
    const rows = db.select().from(hypothesisOutcomes).all() as any[];
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.hypothesisId, "c1");
    assert.equal(r.actualOutcome, true);  // confirmed → true
    assert.equal(r.outcomeWeight, 1.0);
    assert.equal(r.outcomeSource, "auto-resolve");
    assert.equal(r.predictedConfidence, 0.91);
    assert.equal(r.predictedTrustScore, 88);
    assert.equal(r.originatingModel, "grok-4-reasoning");
    assert.equal(r.domain, "regulatory");
    assert.equal(r.resolutionStatus, "confirmed");
  });
});
