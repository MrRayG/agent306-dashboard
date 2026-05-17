/**
 * Tests for DB + .bak + .backup.json source observation in the hypothesis
 * source-discovery helper, plus the reset-CLI apply guard that refuses to
 * archive against a DB-discovered formal source.
 *
 * These pin the production-incident behaviour: Research Lab / Agent HQ
 * reports ~451 hypotheses (read from the SQLite DB row), Phase 2 / reset
 * report previously showed formal=0 because discovery only looked at JSON.
 * This file walks through:
 *
 *   1. DB row populated, research_lab.json missing → discovery falls back to
 *      the DB row as the formal-chosen source, formalRecords matches the DB
 *      blob's hypothesis count, and the `db_research_lab` observation is
 *      surfaced under `otherSources`.
 *   2. research_lab.json present (with N records) and DB row present (with M
 *      records, M != N) → discovery keeps research_lab.json as the canonical
 *      formal-chosen source (count = N), BUT surfaces the DB row count under
 *      `otherSources` AND adds an explicit `countReconciliation` block that
 *      lists both counts so the operator can see the mismatch.
 *   3. research_lab.json.bak present with M records, no .json, no DB → bak
 *      count surfaces under `otherSources` with `origin=research_lab_json_bak`.
 *   4. Memory-only (formal everything missing) → existing behaviour preserved:
 *      formalRecords=0, memoryHypothesisCount>0, nextSafeAction mentions the
 *      memory-origin bucket.
 *   5. Legacy/UI source reports 451 (DB row): reset report's notes contain a
 *      count-mismatch line, intake audit's dataMissingNotes contains the
 *      reconciliation line, and the formatted source-diagnostics text
 *      includes the per-source breakdown.
 *   6. runResetApply refuses with `formal_source_not_applyable` when
 *      formal-chosen.role === "db" and the operator passed --apply.
 *   7. The DB probe is read-only: opening discovery against an unpopulated DB
 *      directory does NOT create any files.
 *
 * Run: npx tsx --test server/__tests__/hypothesisSourceDiscoveryDbBakSources.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hypothesis-source-discovery-db-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.USE_DB_STATE = process.env.USE_DB_STATE ?? "true";

const LAB = path.join(TMP, "research_lab.json");
const LAB_BAK = path.join(TMP, "research_lab.json.bak");
const LAB_BACKUP = path.join(TMP, "research_lab.backup.json");
const MEM = path.join(TMP, "memory_knowledge.json");
const DB = process.env.DB_PATH!;

function clearAll(): void {
  for (const p of [LAB, LAB_BAK, LAB_BACKUP, MEM]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
}

function makeHyps(n: number, prefix = "id"): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `${prefix}_${i}`,
      claim: `claim ${i} measured against the held-out dataset`,
      basis: "https://example.com/paper",
      metric: "accuracy",
      measurementPath: "eval_suite.csv",
      status: "forming",
      formedAt: "2026-04-01T00:00:00Z",
    });
  }
  return out;
}

function seedDb(hypCount: number): void {
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
    hypotheses: makeHyps(hypCount, "db"),
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
    lastUpdated: "2026-05-01T00:00:00Z",
  };
  db.prepare("INSERT OR REPLACE INTO research_lab (id, blob) VALUES (?, ?)").run("main", JSON.stringify(blob));
  db.close();
}

function writeMemHyps(n: number): void {
  const entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id: `mem_${i}`,
      title: `Hypothesis: memory claim ${i}`,
      summary: `body ${i}`,
      learnedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    });
  }
  fs.writeFileSync(MEM, JSON.stringify({ entries, totalEntries: entries.length }));
}

const {
  discoverHypothesisSources,
  describeSourceDiagnostics,
  formatSourceDiagnostics,
} = await import("../hypothesisSourceDiscovery.ts");

describe("hypothesisSourceDiscovery — DB row fallback", () => {
  beforeEach(() => clearAll());

  it("uses the DB row as the formal-chosen source when research_lab.json is missing", () => {
    seedDb(451);
    const r = discoverHypothesisSources();
    assert.equal(r.diagnostics.formalRecords, 451);
    assert.equal(r.diagnostics.formalChosen, DB);
    const dbAttempt = r.diagnostics.formalAttempts.find(a => a.role === "db");
    assert.ok(dbAttempt, "db attempt is included in formalAttempts");
    assert.equal(dbAttempt!.exists, true);
    assert.equal(dbAttempt!.readable, true);
    assert.equal(dbAttempt!.records, 451);
    assert.match(r.diagnostics.nextSafeAction, /DB row.*451/);
    assert.match(r.diagnostics.nextSafeAction, /--apply is REFUSED/);
  });

  it("surfaces the DB row under otherSources whether or not it is the formal-chosen", () => {
    seedDb(451);
    const d = describeSourceDiagnostics();
    const dbObs = d.otherSources.find(s => s.origin === "db_research_lab");
    assert.ok(dbObs, "db_research_lab observation always present");
    assert.equal(dbObs!.count, 451);
    assert.equal(dbObs!.available, true);
    assert.match(dbObs!.locator, /research_lab\[id=main\]\.blob\.hypotheses/);
  });

  it("reports `unavailable` when the DB file does not exist", () => {
    const d = describeSourceDiagnostics();
    const dbObs = d.otherSources.find(s => s.origin === "db_research_lab");
    assert.ok(dbObs);
    assert.equal(dbObs!.count, 0);
    assert.equal(dbObs!.available, false);
  });
});

describe("hypothesisSourceDiscovery — JSON + DB mismatch reconciliation", () => {
  beforeEach(() => clearAll());

  it("keeps research_lab.json as the canonical formal-chosen but reports the DB count under otherSources", () => {
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: makeHyps(3, "json") }));
    seedDb(451);
    const d = describeSourceDiagnostics();
    assert.equal(d.formalRecords, 3, "research_lab.json wins as formal-chosen");
    assert.equal(d.formalChosen, LAB);
    const dbObs = d.otherSources.find(s => s.origin === "db_research_lab");
    assert.equal(dbObs?.count, 451);
    const recon = d.countReconciliation.join("\n");
    assert.match(recon, /Counts across known sources/);
    assert.match(recon, /db_research_lab|SQLite/i);
    assert.match(recon, /451/);
    assert.match(recon, /Formal chosen/);
  });
});

describe("hypothesisSourceDiscovery — research_lab.json.bak observation", () => {
  beforeEach(() => clearAll());

  it("surfaces .bak count under otherSources without auto-choosing it as formal", () => {
    fs.writeFileSync(LAB_BAK, JSON.stringify({ hypotheses: makeHyps(120, "bak") }));
    const d = describeSourceDiagnostics();
    const bakObs = d.otherSources.find(s => s.origin === "research_lab_json_bak");
    assert.ok(bakObs);
    assert.equal(bakObs!.count, 120);
    assert.equal(bakObs!.available, true);
    assert.equal(d.formalChosen, null, ".bak is NOT auto-selected as the formal-chosen source");
    assert.match(d.nextSafeAction, /post-migration \.bak fallback/);
  });

  it("surfaces .backup.json count under otherSources", () => {
    fs.writeFileSync(LAB_BACKUP, JSON.stringify({ hypotheses: makeHyps(7, "bkup") }));
    const d = describeSourceDiagnostics();
    const obs = d.otherSources.find(s => s.origin === "research_lab_backup_json");
    assert.ok(obs);
    assert.equal(obs!.count, 7);
  });
});

describe("hypothesisSourceDiscovery — memory-only preserved", () => {
  beforeEach(() => clearAll());

  it("preserves the previous memory-only nextSafeAction when nothing else has records", () => {
    writeMemHyps(32);
    const d = describeSourceDiagnostics();
    assert.equal(d.formalRecords, 0);
    assert.equal(d.memoryHypothesisCount, 32);
    assert.match(d.nextSafeAction, /32 memory-origin/);
  });
});

describe("hypothesisSourceDiscovery — read-only", () => {
  beforeEach(() => clearAll());

  it("does not create the DB file or any JSON file when discovery runs against an empty DATA_DIR", () => {
    const before = fs.readdirSync(TMP).sort();
    describeSourceDiagnostics();
    const after = fs.readdirSync(TMP).sort();
    assert.deepEqual(after, before);
  });
});

describe("hypothesisSourceDiscovery — formatSourceDiagnostics rendering", () => {
  beforeEach(() => clearAll());

  it("renders the DB attempt, the other sources block, and the reconciliation block", () => {
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: makeHyps(3, "json") }));
    seedDb(451);
    const d = describeSourceDiagnostics();
    const text = formatSourceDiagnostics(d).join("\n");
    assert.match(text, /\[db\]/);
    assert.match(text, /Other observed sources/);
    assert.match(text, /Count reconciliation/);
    assert.match(text, /SQLite research_lab row/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset report integration — mismatch surface
// ─────────────────────────────────────────────────────────────────────────────

const { buildResetReport, formatResetReport } = await import("../hypothesisResetReport.ts");

describe("hypothesisResetReport — count-mismatch note", () => {
  beforeEach(() => clearAll());

  it("adds a 'Source count mismatch' note when formal=0 but DB has records", () => {
    // Empty research_lab.json so JSON wins as formal-chosen with 0 records.
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: [] }));
    seedDb(451);
    const rep = buildResetReport({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(rep.meta.formalRecords, 0);
    const join = rep.notes.join("\n");
    assert.match(join, /Source count mismatch/);
    assert.match(join, /451/);
    const text = formatResetReport(rep);
    assert.match(text, /Source count mismatch/);
  });

  it("does NOT add the mismatch note when formal-chosen and DB both report records (parity)", () => {
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: makeHyps(3, "json") }));
    // No DB seeded — only research_lab.json. No "other source" has records.
    const rep = buildResetReport({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(rep.meta.formalRecords, 3);
    const join = rep.notes.join("\n");
    assert.doesNotMatch(join, /Source count mismatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intake-audit visibility integration — reconciliation surface
// ─────────────────────────────────────────────────────────────────────────────

const { buildHypothesisIntakeAuditVisibility } = await import("../hypothesisIntakeAuditVisibility.ts");

describe("hypothesisIntakeAuditVisibility — mismatch surface", () => {
  beforeEach(() => clearAll());

  it("surfaces dataMissingNotes + nextSafeActions when formal=0 but DB reports 451", () => {
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: [] }));
    seedDb(451);
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const notes = v.dataMissingNotes.join("\n");
    assert.match(notes, /Hypothesis-count mismatch/);
    assert.match(notes, /451/);
    const actions = v.nextSafeActions.join("\n");
    assert.match(actions, /Source reconciliation/);
    assert.match(actions, /451/);
  });

  it("does not add the mismatch line when only memory-origin entries are present", () => {
    writeMemHyps(32);
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const notes = v.dataMissingNotes.join("\n");
    assert.doesNotMatch(notes, /Hypothesis-count mismatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Apply guard — DB-discovered formal source is hard-refused
// ─────────────────────────────────────────────────────────────────────────────

const { runResetApply } = await import("../hypothesisResetApply.ts");

describe("hypothesisResetApply — DB-discovered formal source", () => {
  beforeEach(() => clearAll());

  it("refuses --apply with formal_source_not_applyable when formal-chosen.role === 'db'", () => {
    seedDb(5);
    // No research_lab.json on disk — discovery falls back to DB.
    // Discovery must observe the DB as the formal-chosen source.
    const rep = buildResetReport({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(rep.meta.formalRecords, 5);
    const dbChosen = rep.meta.sourceDiagnostics.formalAttempts.find(
      a => a.path === rep.meta.sourceDiagnostics.formalChosen,
    );
    assert.equal(dbChosen?.role, "db");

    // Seed a research_lab.json so the apply path's `research_lab_missing`
    // guard doesn't trip before our new guard does. The JSON must match the
    // disk-records the freshness guard expects — we use the same hyp ids the
    // DB has, so the freshness check passes and our new guard is the one
    // that refuses.
    const sameAsDb = (rep.meta.sourceDiagnostics.formalAttempts.find(a => a.role === "db")
      ? makeHyps(5, "db") : []);
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: sameAsDb }));

    const result = runResetApply({
      report: rep,
      selectedBuckets: ["archive_stale"],
      apply: true,
      now: new Date("2026-05-17T00:00:00Z"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "formal_source_not_applyable");
      assert.match(result.detail, /SQLite DB row/);
      assert.match(result.detail, /follow-up PR/);
    }
  });

  it("allows dry-run against a DB-discovered formal source (read-only)", () => {
    seedDb(5);
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: makeHyps(5, "db") }));
    const rep = buildResetReport({ now: new Date("2026-05-17T00:00:00Z") });
    const result = runResetApply({
      report: rep,
      selectedBuckets: ["archive_stale"],
      apply: false,
      now: new Date("2026-05-17T00:00:00Z"),
    });
    // The dry-run may legitimately return ok: true with 0 changes (the seeded
    // hypotheses do not match the archive_stale bucket criteria); we only
    // pin that the new guard does NOT trip in dry-run mode.
    if (!result.ok) {
      assert.notEqual(result.reason, "formal_source_not_applyable");
    }
  });
});
