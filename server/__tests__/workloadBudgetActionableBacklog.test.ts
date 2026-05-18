/**
 * Tests for the actionable-formal-hypothesis split in Workload Budget
 * Visibility. Pinned by the production incident reproduced from the
 * 2026-05-18 Autonomy Monitor paste: after PR #391 routed already-archived
 * rows into the audit-only `already_archived` bucket, the Workload Budget
 * panel still counted those 338 records as actionable backlog pressure and
 * recommended "promote or archive 466 records" — asking the operator to
 * re-archive rows that prior reset-apply runs already archived.
 *
 * Invariants:
 *   1. `counts.formalHypotheses` continues to expose the total formal
 *      inventory (matches the SQLite/JSON store row count exactly).
 *   2. `counts.actionableFormalHypotheses` excludes records routed to the
 *      audit-only `already_archived` bucket (status='stale-retired' +
 *      archived_* hygieneTag).
 *   3. `counts.alreadyArchivedFormalHypotheses` reports the excluded subset
 *      so the sum is reconcilable: actionable + alreadyArchived === total.
 *   4. Backlog pressure thresholds (medium / high) and the
 *      `backlog … ≥ …` pressureReason use ACTIONABLE backlog, not the total
 *      inventory.
 *   5. The hypothesis-backlog soft recommendation cites the actionable count
 *      and explicitly notes that the already_archived rows are excluded.
 *   6. The `formal_hypotheses` topDriver count equals
 *      `counts.actionableFormalHypotheses` so the operator-facing top
 *      drivers cannot disagree with the headline.
 *   7. The block remains read-only — calling the builder does not mutate
 *      DATA_DIR contents.
 *
 * Run: npx tsx --test server/__tests__/workloadBudgetActionableBacklog.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase-budget-actionable-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");

function hash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hash(REAL_RESEARCH_LAB);

const {
  buildWorkloadBudgetVisibility,
  DEFAULT_WORKLOAD_BUDGET_THRESHOLDS,
} = await import("../workloadBudgetVisibility.ts");

const { db } = await import("../db.js");
const { engineRuns, engineEvents } = await import("@shared/schema");

function wipeDb(): void {
  try { db.delete(engineRuns).run(); } catch {}
  try { db.delete(engineEvents).run(); } catch {}
}

function writeLab(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "research_lab.json"), JSON.stringify(blob));
}
function clearLab(): void {
  const p = path.join(TMP, "research_lab.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function clearMemory(): void {
  const p = path.join(TMP, "memory_knowledge.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Build the production-shaped backlog: 96 actionable formal + 338 already-archived. */
function productionShapedHypotheses(): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < 96; i++) {
    out.push({
      id:        `actionable_${i}`,
      claim:     `Active research hypothesis ${i}`,
      status:    "forming",
      formedAt:  "2026-05-10T00:00:00Z",
    });
  }
  for (let i = 0; i < 338; i++) {
    out.push({
      id:         `archived_${i}`,
      claim:      `Archived hypothesis ${i}`,
      status:     "stale-retired",
      hygieneTag: i % 3 === 0 ? "archived_stale" : i % 3 === 1 ? "archived_unsolvable" : "archived_irrelevant",
      hygieneTaggedAt: "2026-05-15T00:00:00Z",
    });
  }
  return out;
}

describe("workloadBudgetVisibility — actionable vs already_archived backlog", () => {
  before(() => {
    wipeDb();
    clearLab();
    clearMemory();
  });

  after(() => {
    assert.equal(hash(REAL_RESEARCH_LAB), PRE_RESEARCH, "real research_lab.json must not be touched");
  });

  it("formalHypotheses exposes total inventory; actionable excludes already_archived", () => {
    writeLab({ hypotheses: productionShapedHypotheses() });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    assert.equal(v.counts.formalHypotheses, 434, "total inventory must still match the store row count");
    assert.equal(v.counts.alreadyArchivedFormalHypotheses, 338, "338 stale-retired+archived_* rows must be tracked separately");
    assert.equal(v.counts.actionableFormalHypotheses, 96, "actionable backlog must be total minus already_archived");
    assert.equal(
      v.counts.actionableFormalHypotheses + v.counts.alreadyArchivedFormalHypotheses,
      v.counts.formalHypotheses,
      "split must be reconcilable",
    );
  });

  it("backlog pressure classification uses actionable backlog, not total inventory", () => {
    writeLab({ hypotheses: productionShapedHypotheses() });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    const t = DEFAULT_WORKLOAD_BUDGET_THRESHOLDS;
    // actionable=96 < backlogMedium=100, so the backlog clause must NOT trip.
    // (Other clauses — duration, kb, obligations — also trip nothing here, so
    // the band stays "low".)
    assert.equal(v.pressureBand, "low", `pressure should be low, got ${v.pressureBand} (${v.pressureReason})`);
    assert.ok(
      !/backlog\s+\d+\s+≥/i.test(v.pressureReason) || /backlog\s+96\b/.test(v.pressureReason),
      `pressureReason must not cite a backlog above 96: ${v.pressureReason} (medium=${t.backlogMedium})`,
    );
  });

  it("soft recommendation cites actionable backlog and notes already_archived exclusion", () => {
    // Push actionable above medium threshold so the recommendation surfaces.
    const hyps: unknown[] = [];
    for (let i = 0; i < 120; i++) {
      hyps.push({ id: `a_${i}`, status: "forming", claim: `c${i}`, formedAt: "2026-05-10T00:00:00Z" });
    }
    for (let i = 0; i < 50; i++) {
      hyps.push({
        id: `r_${i}`,
        status: "stale-retired",
        hygieneTag: "archived_stale",
        hygieneTaggedAt: "2026-05-15T00:00:00Z",
      });
    }
    writeLab({ hypotheses: hyps });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    assert.equal(v.counts.actionableFormalHypotheses, 120);
    assert.equal(v.counts.alreadyArchivedFormalHypotheses, 50);
    const rec = v.softRecommendations.find(r => r.startsWith("Hypothesis backlog"));
    assert.ok(rec, `expected a Hypothesis-backlog soft recommendation, got: ${JSON.stringify(v.softRecommendations)}`);
    assert.match(rec!, /actionable formal 120/, `recommendation must cite actionable formal count: ${rec}`);
    assert.match(rec!, /50 already_archived/, `recommendation must note the already_archived exclusion when > 0: ${rec}`);
    assert.match(rec!, /inventory 170/, `recommendation must surface inventory total when archived rows exist: ${rec}`);
  });

  it("formal_hypotheses topDriver count tracks actionable backlog, not total inventory", () => {
    writeLab({ hypotheses: productionShapedHypotheses() });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    const formalDriver = v.topDrivers.find(d => d.key === "formal_hypotheses");
    assert.ok(formalDriver, "formal_hypotheses driver must appear in topDrivers");
    assert.equal(
      formalDriver!.count,
      96,
      "formal_hypotheses driver must report the actionable count so the operator does not see 'archive 434 rows' suggestions",
    );
    // When archived rows are present a parallel inventory driver shows the
    // full count so the operator can still see total scale at a glance.
    const inventoryDriver = v.topDrivers.find(d => d.key === "formal_hypotheses_inventory");
    if (inventoryDriver) {
      assert.equal(inventoryDriver.count, 434);
    }
  });

  it("with no already_archived rows, actionable === total and no inventory driver appears", () => {
    clearLab();
    writeLab({
      hypotheses: [
        { id: "h1", status: "forming", claim: "active" },
        { id: "h2", status: "testing", claim: "active2" },
      ],
    });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    assert.equal(v.counts.formalHypotheses, 2);
    assert.equal(v.counts.actionableFormalHypotheses, 2);
    assert.equal(v.counts.alreadyArchivedFormalHypotheses, 0);
    const inventoryDriver = v.topDrivers.find(d => d.key === "formal_hypotheses_inventory");
    assert.equal(inventoryDriver, undefined, "inventory-duplicate driver must not appear when no archived rows exist");
  });

  it("legacy stale-retired without an archived_* tag does NOT count as already_archived (matches reset classifier)", () => {
    clearLab();
    writeLab({
      hypotheses: [
        // Legacy stale-retired with no hygieneTag — reset classifier routes
        // this to archive_stale (the lifecycle switch wins), NOT
        // already_archived. The Workload Budget split must mirror that —
        // these rows are still actionable until tagged.
        { id: "legacy_stale", status: "stale-retired" },
        { id: "fresh",        status: "forming", claim: "active" },
      ],
    });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    assert.equal(v.counts.formalHypotheses, 2);
    assert.equal(v.counts.alreadyArchivedFormalHypotheses, 0, "legacy stale-retired (no tag) must NOT count as already_archived");
    assert.equal(v.counts.actionableFormalHypotheses, 2);
  });

  it("calling the builder remains read-only — DATA_DIR contents unchanged", () => {
    writeLab({ hypotheses: productionShapedHypotheses() });
    const before = new Set(fs.readdirSync(TMP));
    buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    buildWorkloadBudgetVisibility({ now: new Date("2026-05-18T00:00:00Z") });
    const after = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...after].sort(), [...before].sort());
  });
});
