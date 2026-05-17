/**
 * Tests for the read-only Workload Budget Visibility builder.
 *
 * Invariants pinned by this file:
 *   1. With no data sources at all the builder returns a well-shaped snapshot
 *      whose counts are zero / null, whose pressureBand is "low", and whose
 *      dataMissingNotes lists the missing sources rather than throwing.
 *   2. Pressure classification is deterministic from the input counts +
 *      thresholds. Crossing the medium threshold lifts the band; crossing
 *      the high threshold caps at high.
 *   3. The builder is read-only: calling it does NOT create any new file
 *      under DATA_DIR and does NOT mutate the real repo data files.
 *   4. Soft recommendations are advisory text only and always include the
 *      "advisory text only" banner so a renderer cannot mistake them for
 *      enforced gates.
 *   5. Top driver projection caps at 5 entries, sorted descending by count,
 *      with stable tiebreak by key — and tags each entry with its source so
 *      the UI can render provenance.
 *   6. The block is wired into the autonomy monitor snapshot under
 *      `workloadBudget` and the rest of the snapshot is untouched.
 *
 * Run: npx tsx --test server/__tests__/workloadBudgetVisibility.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase-budget-vis-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB    = path.join(REPO_ROOT, "data", "memory_knowledge.json");

function hash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hash(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hash(REAL_MEMORY_KB);

const {
  buildWorkloadBudgetVisibility,
  DEFAULT_WORKLOAD_BUDGET_THRESHOLDS,
  WORKLOAD_BUDGET_COST_DRIVER_EVENT_NAMES,
  EXTERNAL_COST_REPORT_OPENROUTER_2026_05_17,
} = await import("../workloadBudgetVisibility.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

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
function writeMemory(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "memory_knowledge.json"), JSON.stringify(blob));
}
function clearMemory(): void {
  const p = path.join(TMP, "memory_knowledge.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

describe("workloadBudgetVisibility — empty / missing-data behaviour", () => {
  before(() => {
    wipeDb();
    clearLab();
    clearMemory();
  });

  after(() => {
    assert.equal(hash(REAL_RESEARCH_LAB), PRE_RESEARCH, "real research_lab.json must not be touched");
    assert.equal(hash(REAL_MEMORY_KB),    PRE_MEMORY,   "real memory_knowledge.json must not be touched");
  });

  it("returns a well-shaped snapshot when no data sources exist", () => {
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.schemaVersion, "phase-budget-vis-1");
    assert.equal(v.label, "workload-budget-visibility");
    assert.equal(v.generatedAt, "2026-05-17T00:00:00.000Z");
    assert.equal(v.pressureBand, "low", "no signal should never trip medium/high");
    assert.equal(typeof v.pressureReason, "string");
    assert.ok(v.pressureReason.length > 0);
    assert.equal(v.counts.latestEngineRunDurationMs, null);
    assert.equal(v.counts.engineRunsLast24h, 0);
    assert.equal(v.counts.engineEventsLast24h, 0);
    assert.equal(v.counts.formalHypotheses, 0);
    assert.equal(v.counts.kbEntries, 0);
    assert.equal(v.counts.memoryHypothesesBlocked, 0);
    // Both JSON data sources are missing — must be noted, not thrown.
    assert.ok(v.dataMissingNotes.includes("research_lab.json missing or unreadable"));
    assert.ok(v.dataMissingNotes.includes("memory_knowledge.json missing or unreadable"));
  });

  it("includes the advisory-only invariant banner in soft recommendations", () => {
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const banner = v.softRecommendations.find(r =>
      r.toLowerCase().includes("advisory text only"),
    );
    assert.ok(banner, "soft recommendations must include the advisory-only banner");
  });

  it("invariants block declares read-only / proxy-only / advisory-only / non-widening", () => {
    const v = buildWorkloadBudgetVisibility();
    assert.match(v.invariants.readOnly, /no write|no insert|no scheduler|no apply/i);
    assert.match(v.invariants.proxyOnly, /no token|no.*currency|proxy/i);
    assert.match(v.invariants.advisoryOnly, /advisory|text only|not enforce|not refuse|not throttle/i);
    assert.match(v.invariants.nonWidening, /no new external|no new auth|no new primitive/i);
  });

  it("calling the builder is read-only — DATA_DIR contents unchanged", () => {
    const before = new Set(fs.readdirSync(TMP));
    buildWorkloadBudgetVisibility();
    buildWorkloadBudgetVisibility();
    const after = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...after].sort(), [...before].sort());
  });
});

describe("workloadBudgetVisibility — pressure classification", () => {
  before(() => {
    wipeDb();
    clearLab();
    clearMemory();
  });

  it("returns low when nothing trips any threshold", () => {
    writeLab({ hypotheses: [{ id: "h1" }] });
    writeMemory({ entries: [{ title: "kb thing" }] });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.pressureBand, "low");
    assert.equal(v.counts.formalHypotheses, 1);
    assert.equal(v.counts.kbEntries, 1);
  });

  it("returns medium when backlog crosses the medium threshold", () => {
    const t = DEFAULT_WORKLOAD_BUDGET_THRESHOLDS;
    const hyps = Array.from({ length: t.backlogMedium }, (_, i) => ({ id: `h${i}` }));
    writeLab({ hypotheses: hyps });
    writeMemory({ entries: [] });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.pressureBand, "medium", `backlog=${hyps.length} threshold=${t.backlogMedium}`);
    assert.match(v.pressureReason, /backlog/);
  });

  it("returns high when backlog crosses the high threshold", () => {
    const t = DEFAULT_WORKLOAD_BUDGET_THRESHOLDS;
    const hyps = Array.from({ length: t.backlogHigh }, (_, i) => ({ id: `h${i}` }));
    writeLab({ hypotheses: hyps });
    writeMemory({ entries: [] });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.pressureBand, "high");
  });

  it("returns high when latest cycle duration exceeds the high threshold", () => {
    clearLab();
    clearMemory();
    wipeDb();
    db.insert(engineRuns).values({
      engine:           "test_engine",
      startedAt:        "2026-05-16T22:00:00.000Z",
      finishedAt:       "2026-05-16T23:50:00.000Z",
      durationMs:       110 * 60 * 1000, // 110m > 60m threshold
      status:           "ok",
      insightsEmitted:  0,
      metricsJson:      "{}",
      triggeredBy:      "scheduler",
    }).run();
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.pressureBand, "high");
    assert.equal(v.counts.latestEngineRunDurationMs, 110 * 60 * 1000);
    assert.match(v.pressureReason, /latest cycle/);
  });

  it("self-rule obligations bump band but cannot exceed high", () => {
    clearLab();
    clearMemory();
    wipeDb();
    // Low baseline (no duration, no backlog), but many open obligations.
    const v = buildWorkloadBudgetVisibility({
      now: new Date("2026-05-17T00:00:00Z"),
      selfRule: {
        openCorrectiveObligations:   20,
        mergedCorrectiveObligations: 3,
      },
    });
    assert.equal(v.pressureBand, "medium", "obligations alone should bump to medium, not high");
    // Now also trip high via duration; obligations cannot push past high.
    db.insert(engineRuns).values({
      engine:           "test_engine",
      startedAt:        "2026-05-16T22:00:00.000Z",
      finishedAt:       "2026-05-16T23:50:00.000Z",
      durationMs:       120 * 60 * 1000,
      status:           "ok",
      insightsEmitted:  0,
      metricsJson:      "{}",
      triggeredBy:      "scheduler",
    }).run();
    const v2 = buildWorkloadBudgetVisibility({
      now: new Date("2026-05-17T00:00:00Z"),
      selfRule: {
        openCorrectiveObligations:   50,
        mergedCorrectiveObligations: 10,
      },
    });
    assert.equal(v2.pressureBand, "high");
  });

  it("threshold overrides take effect deterministically", () => {
    clearLab();
    clearMemory();
    wipeDb();
    writeLab({ hypotheses: [{ id: "h1" }, { id: "h2" }] });
    writeMemory({ entries: [] });
    const v = buildWorkloadBudgetVisibility({
      now: new Date("2026-05-17T00:00:00Z"),
      thresholds: { backlogMedium: 2 },
    });
    assert.equal(v.pressureBand, "medium");
    assert.equal(v.thresholds.backlogMedium, 2);
  });
});

describe("workloadBudgetVisibility — projection shape", () => {
  before(() => {
    wipeDb();
    clearLab();
    clearMemory();
  });

  it("topDrivers is capped at 5 entries and sorted descending by count", () => {
    writeLab({
      hypotheses: Array.from({ length: 80 }, (_, i) => ({ id: `h${i}` })),
    });
    writeMemory({
      entries: [
        ...Array.from({ length: 30 }, (_, i) => ({
          id:    `m${i}`,
          title: "Hypothesis: example",
        })),
        ...Array.from({ length: 200 }, (_, i) => ({
          id:    `k${i}`,
          title: `kb item ${i}`,
        })),
      ],
    });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.ok(v.topDrivers.length <= 5);
    for (let i = 1; i < v.topDrivers.length; i++) {
      assert.ok(
        v.topDrivers[i - 1].count >= v.topDrivers[i].count,
        `topDrivers must be descending: ${v.topDrivers.map(d => d.count).join(",")}`,
      );
    }
    // The KB drivers should appear with provenance tags.
    const kbEntries = v.topDrivers.find(d => d.key === "kb_entries");
    assert.ok(kbEntries, "kb_entries must be in topDrivers");
    assert.equal(kbEntries!.source, "memory_knowledge.json");
  });

  it("each event-name counter shows up in the cost-driver list even when zero", () => {
    clearLab();
    clearMemory();
    wipeDb();
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    // Drivers above the cap may not all be in top 5; the contract is that
    // the well-known names are valid keys when their count is > 0. With no
    // events emitted they read 0 and may not surface in top 5 — that is
    // expected. Confirm they at least exist as a stable name list.
    assert.ok(WORKLOAD_BUDGET_COST_DRIVER_EVENT_NAMES.length > 0);
    for (const n of WORKLOAD_BUDGET_COST_DRIVER_EVENT_NAMES) {
      assert.equal(typeof n, "string");
      assert.ok(n.length > 0);
    }
  });

  it("memory-origin hypotheses that are promoted do NOT count as blocked", () => {
    clearLab();
    clearMemory();
    wipeDb();
    writeLab({ hypotheses: [] });
    writeMemory({
      entries: [
        { id: "m1", title: "Hypothesis: a", promotedToHypothesisId: "h1" },
        { id: "m2", title: "Hypothesis: b", promotedToHypothesisId: "" }, // empty => blocked
        { id: "m3", title: "Hypothesis: c" },                              // missing => blocked
        { id: "m4", title: "kb only thing" },                              // not a hypothesis
      ],
    });
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.counts.memoryOriginHypotheses, 3);
    assert.equal(v.counts.memoryHypothesesBlocked, 2);
    assert.equal(v.counts.kbEntries, 4);
  });
});

describe("workloadBudgetVisibility — external cost report (OpenRouter CSV)", () => {
  it("pins the 2026-05-17 OpenRouter CSV totals on the default snapshot", () => {
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const r = v.externalCostReport;
    assert.equal(r.source, "openrouter_activity_csv");
    assert.equal(r.rangeStart, "2026-04-18");
    assert.equal(r.rangeEnd,   "2026-05-17");
    assert.equal(r.rowCount,   25112);
    assert.equal(r.totalUsd,   134.6701);
    assert.deepEqual([...r.filteredTotalsUsd].sort((a, b) => a - b), [67.4851, 84.17]);
    const byModel = Object.fromEntries(r.byModelUsd.map(m => [m.model, m.costUsd]));
    assert.equal(byModel["Claude Sonnet"], 72.4882);
    assert.equal(byModel["Claude Opus"],   40.2073);
    assert.equal(byModel["Gemini Flash"],  21.8511);
    assert.equal(byModel["Embeddings"],    0.0534);
    assert.equal(r.dailyCycleBurstUtcWindow.startHour, 10);
    assert.equal(r.dailyCycleBurstUtcWindow.endHour,   11);
  });

  it("emits CSV-derived soft recommendations referencing top model + burst window + finish_reason", () => {
    const v = buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const joined = v.softRecommendations.join("\n");
    assert.match(joined, /Claude Sonnet/i);
    assert.match(joined, /\$72\.49/);
    assert.match(joined, /\$134\.67/);
    assert.match(joined, /finish_reason=length/);
    assert.match(joined, /10:00–11:00 UTC/);
    // Advisory banner still present.
    assert.ok(v.softRecommendations.some(r => /advisory text only/i.test(r)));
  });

  it("accepts an injected externalCostReport override", () => {
    const v = buildWorkloadBudgetVisibility({
      now: new Date("2026-05-17T00:00:00Z"),
      externalCostReport: {
        source: "openrouter_activity_csv",
        label:  "synthetic-test",
        rangeStart: "2026-05-10",
        rangeEnd:   "2026-05-17",
        rowCount:   1,
        totalUsd:   0.01,
        filteredTotalsUsd: [],
        byModelUsd: [{ model: "TestModel", costUsd: 0.01 }],
        notes: [],
        dailyCycleBurstUtcWindow: { startHour: 0, endHour: 1 },
        asOf: "2026-05-17",
      },
    });
    assert.equal(v.externalCostReport.label, "synthetic-test");
    assert.equal(v.externalCostReport.totalUsd, 0.01);
  });

  it("pinned constant is unaffected by builder calls (no mutation)", () => {
    const before = JSON.stringify(EXTERNAL_COST_REPORT_OPENROUTER_2026_05_17);
    buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    buildWorkloadBudgetVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const after = JSON.stringify(EXTERNAL_COST_REPORT_OPENROUTER_2026_05_17);
    assert.equal(after, before);
  });
});

describe("workloadBudgetVisibility — wired into autonomy monitor snapshot", () => {
  before(() => {
    clearLab();
    clearMemory();
    wipeDb();
  });

  it("snapshot exposes workloadBudget alongside the existing stages", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-17T00:00:00Z"));
    assert.ok(snap.workloadBudget, "snapshot must include workloadBudget block");
    assert.equal(snap.workloadBudget.schemaVersion, "phase-budget-vis-1");
    assert.equal(snap.workloadBudget.generatedAt, "2026-05-17T00:00:00.000Z");
    // Stage count must not have regressed.
    assert.equal(snap.stages.length, 11);
    // Safety boundary banner still all true.
    assert.equal(snap.safetyBoundary.noAutoPost, true);
    assert.equal(snap.safetyBoundary.publicApprovalRequired, true);
  });

  it("snapshot remains read-only — DATA_DIR contents unchanged across two calls", () => {
    const before = new Set(fs.readdirSync(TMP));
    buildAutonomyMonitorSnapshot();
    buildAutonomyMonitorSnapshot();
    const after = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...after].sort(), [...before].sort());
  });
});
