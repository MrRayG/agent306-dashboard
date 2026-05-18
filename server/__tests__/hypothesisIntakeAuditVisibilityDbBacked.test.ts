/**
 * Tests pinning DB-aware visibility for the Hypothesis Intake Audit panel
 * and the Autonomy Monitor stages it powers.
 *
 * Production-incident motivation: when `research_lab.json` is renamed to
 * `research_lab.json.bak` after migration, the canonical formal hypothesis
 * store lives in the SQLite `research_lab[id='main']` row. Before this PR
 * the visibility builders read `research_lab.json` directly and returned
 * formalHypotheses=0 + "research_lab.json missing" even though the runtime
 * apply path (and the reset CLI) had no trouble reading 453 records from the
 * DB. Operators saw a zeroed dashboard while the runtime kept working.
 *
 * This file pins the new behaviour:
 *
 *   1. When research_lab.json is missing but the SQLite research_lab row
 *      holds N hypotheses, buildHypothesisIntakeAuditVisibility:
 *        - reports formal `count = N` on the formationSources row
 *        - labels the store as `sqlite:research_lab` (not research_lab.json)
 *        - leaves `dataMissing` false on the formal row
 *        - drops the "research_lab.json missing or unreadable" note
 *        - keeps the read-only guarantee (DB file unchanged on disk)
 *   2. The Autonomy Monitor Research Topic stage reports formal count = N
 *      against the same DB row, and its `summary` mentions SQLite as the
 *      canonical store (with research_lab.json as fallback).
 *   3. The Hygiene Readiness Gate stage receives the same N hypotheses and
 *      computes formalConfirmedOrRejected / formalWithMetric from them.
 *   4. The dry-run reset buckets are computed against the DB-backed rows:
 *      records that were previously archived (status=stale-retired AND
 *      hygieneTag=archived_*) land in `already_archived`, not `archive_stale`.
 *   5. No writes happen — DB file mtime is unchanged after multiple builds.
 *
 * Run: npx tsx --test server/__tests__/hypothesisIntakeAuditVisibilityDbBacked.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase-intake-audit-db-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const LAB = path.join(TMP, "research_lab.json");
const LAB_BAK = path.join(TMP, "research_lab.json.bak");
const MEM = path.join(TMP, "memory_knowledge.json");
const DB = process.env.DB_PATH!;

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_DB           = path.join(REPO_ROOT, "data", "agent306.db");

function fileHash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_REAL_LAB = fileHash(REAL_RESEARCH_LAB);
const PRE_REAL_DB  = fileHash(REAL_DB);

function clearAll(): void {
  for (const p of [LAB, LAB_BAK, MEM]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
}

function seedDb(hyps: Array<Record<string, unknown>>): void {
  const db = new Database(DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_lab (
      id TEXT PRIMARY KEY,
      blob TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const blob = {
    topics: [],
    hypotheses: hyps,
    stats: {},
    lastUpdated: "2026-05-17T00:00:00Z",
  };
  db.prepare("INSERT OR REPLACE INTO research_lab (id, blob) VALUES (?, ?)").run("main", JSON.stringify(blob));
  db.close();
}

function makeHyp(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id:              "h_default",
    claim:           "Citation count for paper X will exceed 1000 by Q4 2026.",
    basis:           "https://example.com/paper",
    metric:          "OpenAlex citation count",
    prediction:      "Citation count will exceed 1000 by Q4 2026.",
    timeframe:       "Q4 2026",
    status:          "forming",
    confidence:      "medium",
    formedAt:        "2026-05-10T00:00:00Z",
    measurementPath: "OpenAlex citation count for paper X",
    ...overrides,
  };
}

const {
  buildHypothesisIntakeAuditVisibility,
} = await import("../hypothesisIntakeAuditVisibility.ts");
const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

describe("hypothesisIntakeAuditVisibility — DB-backed formal store visibility", () => {
  before(() => clearAll());
  after(() => {
    assert.equal(fileHash(REAL_RESEARCH_LAB), PRE_REAL_LAB, "real research_lab.json must not be touched");
    assert.equal(fileHash(REAL_DB),           PRE_REAL_DB,  "real agent306.db must not be touched");
  });
  beforeEach(() => clearAll());

  it("formationSources reports DB-backed count when research_lab.json is missing", () => {
    const hyps = Array.from({ length: 453 }, (_, i) => makeHyp({ id: `db_${i}` }));
    seedDb(hyps);

    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });

    const formal = v.formationSources.find(s => s.key === "formal");
    assert.ok(formal, "expected a `formal` formationSources row");
    assert.equal(formal!.count, 453, "formal count should reflect DB-backed hypotheses");
    assert.equal(formal!.store, "sqlite:research_lab", "formal store should be labelled as the SQLite row");
    assert.equal(formal!.dataMissing, false, "formal store dataMissing must be false when DB row is present");
    assert.match(formal!.label, /SQLite/, "label should mention SQLite");
    assert.match(formal!.codePathHint ?? "", /SQLite/, "codePathHint should reference SQLite");
  });

  it("drops the JSON-missing dataMissingNote when the DB row supplies the formal store", () => {
    seedDb([makeHyp({ id: "db_0" })]);
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });

    const note = v.dataMissingNotes.find(n => n.includes("No formal hypothesis store discovered"));
    assert.equal(note, undefined, "should NOT add a 'No formal hypothesis store discovered' note when the DB row is present");
  });

  it("nextSafeActions surfaces the DB-aware apply advisory", () => {
    seedDb(Array.from({ length: 10 }, (_, i) => makeHyp({ id: `db_${i}` })));
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const action = v.nextSafeActions.find(a => /DB-aware reset apply/i.test(a));
    assert.ok(action, "expected the DB-aware reset apply advisory in nextSafeActions");
    assert.match(action!, /--confirm-source=db/);
  });

  it("dry-run reset buckets route already-archived rows out of archive_stale", () => {
    // 3 already-archived (status=stale-retired + hygieneTag=archived_*) +
    // 2 active well-formed (keep_active) records.
    const hyps = [
      makeHyp({ id: "a1", status: "stale-retired", hygieneTag: "archived_stale" }),
      makeHyp({ id: "a2", status: "stale-retired", hygieneTag: "archived_unsolvable" }),
      makeHyp({ id: "a3", status: "stale-retired", hygieneTag: "archived_irrelevant" }),
      makeHyp({ id: "k1" }),
      makeHyp({ id: "k2" }),
    ];
    seedDb(hyps);
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const bucketCount = (b: string) => v.resetBuckets.find(x => x.bucket === b)?.count ?? -1;
    assert.equal(bucketCount("already_archived"), 3, "already-archived rows must NOT inflate archive_stale");
    assert.equal(bucketCount("archive_stale"),    0);
    assert.equal(bucketCount("keep_active"),      2);
  });

  it("is read-only — DB file mtime/hash unchanged across multiple builds", () => {
    seedDb([makeHyp({ id: "db_0" })]);
    const beforeHash = fileHash(DB);
    const beforeMtime = fs.statSync(DB).mtimeMs;
    for (let i = 0; i < 5; i++) {
      buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    }
    assert.equal(fileHash(DB), beforeHash, "DB file content must not change");
    assert.equal(fs.statSync(DB).mtimeMs, beforeMtime, "DB file mtime must not change");
  });
});

describe("autonomyMonitor — DB-backed Research Topic + Hygiene Gate stages", () => {
  before(() => clearAll());
  after(() => {
    assert.equal(fileHash(REAL_RESEARCH_LAB), PRE_REAL_LAB, "real research_lab.json must not be touched");
    assert.equal(fileHash(REAL_DB),           PRE_REAL_DB,  "real agent306.db must not be touched");
  });
  beforeEach(() => clearAll());

  it("Research Topic stage reports DB-backed formal count and SQLite wording", () => {
    seedDb(Array.from({ length: 453 }, (_, i) => makeHyp({ id: `db_${i}` })));

    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-17T00:00:00Z"));
    const stage = snap.stages.find(s => s.id === "research_topic");
    assert.ok(stage, "research_topic stage missing");
    assert.equal(stage!.counts?.formalHypotheses, 453, "formal count should come from the DB row");
    assert.notEqual(stage!.status, "data_missing", "stage should not be data_missing when DB row is present");
    assert.match(stage!.summary, /SQLite/, "summary should mention SQLite as the canonical store");
    assert.match(stage!.summary, /fallback/i, "summary should mention research_lab.json as fallback");
  });

  it("Hygiene Readiness Gate stage scores DB-backed records", () => {
    const hyps = [
      makeHyp({ id: "g1", metric: "metric1", status: "confirmed" }),
      makeHyp({ id: "g2", metric: "metric2", status: "forming" }),
      makeHyp({ id: "g3", metric: "",        status: "forming" }),
    ];
    seedDb(hyps);

    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-17T00:00:00Z"));
    const gate = snap.stages.find(s => s.id === "hygiene_gate");
    assert.ok(gate, "hygiene_gate stage missing");
    assert.equal(gate!.counts?.formalHypotheses, 3);
    assert.equal(gate!.counts?.formalWithMetric, 2);
    assert.equal(gate!.counts?.formalConfirmedOrRejected, 1);
  });

  it("autonomy monitor build does not mutate the DB file", () => {
    seedDb([makeHyp({ id: "db_0" })]);
    const beforeHash = fileHash(DB);
    const beforeMtime = fs.statSync(DB).mtimeMs;
    buildAutonomyMonitorSnapshot(new Date("2026-05-17T00:00:00Z"));
    buildAutonomyMonitorSnapshot(new Date("2026-05-17T00:01:00Z"));
    assert.equal(fileHash(DB), beforeHash);
    assert.equal(fs.statSync(DB).mtimeMs, beforeMtime);
  });
});
