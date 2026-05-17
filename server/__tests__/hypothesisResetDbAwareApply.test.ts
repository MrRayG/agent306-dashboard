/**
 * DB-aware Hypothesis Reset apply path.
 *
 * Invariants pinned here:
 *
 *   1. buildResetReport, when discovery's formal-chosen source is the SQLite
 *      DB row, classifies the DB-backed hypotheses into the usual buckets
 *      (archive_stale etc.) and exposes them with origin='formal'.
 *   2. runResetApply with apply=true against a DB-chosen report REFUSES with
 *      `db_source_confirmation_required` if `confirmDbSource` is omitted.
 *   3. runResetApply with apply=true and confirmDbSource=true against a
 *      safe archive bucket transforms only the targeted records (status →
 *      stale-retired, hygieneTag set, archivedAt populated, claim/metric/
 *      basis preserved). The total record count is unchanged.
 *   4. runResetApply with apply=true and confirmDbSource=true writes a DB
 *      backup BEFORE saveLab; refuses with `backup_failed` if the backup
 *      writer throws (and saveLab is not invoked).
 *   5. runResetApply REFUSES unsafe buckets even with confirmDbSource=true:
 *      rewrite_*, promote_later_memory_origin, needs_operator_review, and
 *      keep_active all hard-refuse.
 *   6. runResetApply REFUSES with `source_changed_between_report_and_apply`
 *      when the report's formal-chosen path/role differs from what live
 *      discovery resolves at apply time.
 *   7. The dry-run path against a DB-chosen report does NOT require
 *      confirmDbSource and does NOT call writeBackup or saveLab.
 *   8. Memory-origin entries surfaced under promote_later_memory_origin are
 *      never sent through the apply path even when buckets are selected.
 *
 * Run: npx tsx --test server/__tests__/hypothesisResetDbAwareApply.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hypothesis-reset-db-apply-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.USE_DB_STATE = process.env.USE_DB_STATE ?? "true";

const LAB_JSON = path.join(TMP, "research_lab.json");
const MEM = path.join(TMP, "memory_knowledge.json");
const DB_PATH = process.env.DB_PATH!;

function clearAll(): void {
  for (const p of [LAB_JSON, MEM]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  // Do NOT unlink the DB file — server/db.ts holds a persistent connection
  // opened at import time; deleting the file leaves that connection pointing
  // at a stale inode and saveResearchLab would write through the cached FD
  // while subsequent reads see whatever ended up on disk. Instead, clear the
  // research_lab table in place via the test's own connection.
  if (fs.existsSync(DB_PATH)) {
    const db = new Database(DB_PATH);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_lab (
          id TEXT PRIMARY KEY,
          blob TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare("DELETE FROM research_lab").run();
    } finally {
      db.close();
    }
  }
  for (const f of fs.readdirSync(TMP)) {
    if (f.startsWith("hypothesis_reset_db_backup_") || f.startsWith("hypothesis_reset_backup_")) {
      try { fs.unlinkSync(path.join(TMP, f)); } catch {}
    }
  }
}

function makeStaleHyp(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    claim: `Stale claim ${id}: citation count will pass 1000 by Q4 2024 (overdue).`,
    basis: "https://example.com/source",
    metric: "OpenAlex citation count",
    prediction: "Citation count will pass 1000 by Q4 2024.",
    timeframe: "Q4 2024",
    measurementPath: "OpenAlex citation count for paper X",
    status: "forming",
    confidence: "medium",
    formedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeUnsolvableHyp(id: string): Record<string, unknown> {
  return {
    id,
    claim: `Unsolvable claim ${id}.`,
    basis: "https://example.com/source",
    metric: "(none)",
    measurementPath: "(no path)",
    status: "data-unavailable",
    hygieneTag: "needs_data",
    formedAt: "2025-01-01T00:00:00Z",
  };
}

function seedDbHyps(hyps: Array<Record<string, unknown>>): void {
  const db = new Database(DB_PATH);
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
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
    lastUpdated: "2026-05-01T00:00:00Z",
  };
  db.prepare("INSERT OR REPLACE INTO research_lab (id, blob) VALUES (?, ?)").run("main", JSON.stringify(blob));
  db.close();
}

function readDbHyps(): Array<Record<string, unknown>> {
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare("SELECT blob FROM research_lab WHERE id=?").get("main") as { blob?: string } | undefined;
  db.close();
  if (!row?.blob) return [];
  const parsed = JSON.parse(row.blob);
  return Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [];
}

const { runResetApply } = await import("../hypothesisResetApply.ts");
const { buildResetReport } = await import("../hypothesisResetReport.ts");

const NOW = new Date("2026-05-17T00:00:00Z");

describe("hypothesisResetReport — classifies DB-backed Research Lab hypotheses", () => {
  beforeEach(() => clearAll());

  it("reports formalRecords > 0, formal-chosen role 'db', and groups records into the right buckets", () => {
    const hyps = [
      makeStaleHyp("db_stale_1"),
      makeStaleHyp("db_stale_2"),
      makeUnsolvableHyp("db_unsolv_1"),
      // A "keep active" hyp — formedAt close to now and full metadata.
      {
        id: "db_keep_1",
        claim: "Active claim measured against the held-out dataset by 2026-08-01.",
        basis: "https://example.com/source",
        metric: "accuracy",
        prediction: "Accuracy improves by 5pp on the held-out set by 2026-08-01.",
        timeframe: "2026-08-01",
        measurementPath: "eval_suite.csv",
        status: "forming",
        formedAt: "2026-05-15T00:00:00Z",
      },
    ];
    seedDbHyps(hyps);

    const rep = buildResetReport({ now: NOW });
    assert.equal(rep.meta.formalRecords, 4);
    const chosen = rep.meta.sourceDiagnostics.formalAttempts.find(
      a => a.path === rep.meta.sourceDiagnostics.formalChosen,
    );
    assert.equal(chosen?.role, "db", "formal-chosen role must be 'db'");

    const staleSection = rep.buckets.find(b => b.bucket === "archive_stale");
    const dataSection  = rep.buckets.find(b => b.bucket === "archive_data_unavailable");
    assert.ok(staleSection && dataSection);
    const staleIds = staleSection!.entries.map(e => e.id);
    assert.ok(staleIds.includes("db_stale_1"), "db_stale_1 should be in archive_stale");
    assert.ok(staleIds.includes("db_stale_2"), "db_stale_2 should be in archive_stale");
    const dataIds = dataSection!.entries.map(e => e.id);
    assert.ok(dataIds.includes("db_unsolv_1"), "db_unsolv_1 should be in archive_data_unavailable");

    for (const section of rep.buckets) {
      for (const e of section.entries) {
        if (e.id.startsWith("db_")) assert.equal(e.origin, "formal", `${e.id} must have origin='formal'`);
      }
    }
  });

  it("surfaces sample IDs and reasons under each bucket for operator review", () => {
    const hyps = [
      makeStaleHyp("db_stale_a"),
      makeStaleHyp("db_stale_b"),
      makeStaleHyp("db_stale_c"),
    ];
    seedDbHyps(hyps);

    const rep = buildResetReport({ now: NOW });
    const stale = rep.buckets.find(b => b.bucket === "archive_stale")!;
    assert.equal(stale.count, 3);
    for (const e of stale.entries) {
      assert.ok(e.reasons.length > 0, "every entry must carry classifier reasons");
      assert.ok(typeof e.claimPreview === "string" && e.claimPreview.length > 0, "claim preview present");
    }
  });
});

describe("hypothesisResetApply — DB-aware apply refuses without confirmDbSource", () => {
  beforeEach(() => clearAll());

  it("refuses with db_source_confirmation_required and does NOT call backup/save", () => {
    seedDbHyps([makeStaleHyp("db_stale_1")]);
    const rep = buildResetReport({ now: NOW });
    let backupCalls = 0;
    let saveCalls = 0;
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: true,
      report: rep,
      now: NOW,
      writeBackup: () => { backupCalls++; return "(never)"; },
      saveLab: () => { saveCalls++; },
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "db_source_confirmation_required");
      assert.match(r.detail, /--confirm-source=db/);
    }
    assert.equal(backupCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe("hypothesisResetApply — DB-aware apply writes through saveResearchLab with confirmDbSource", () => {
  beforeEach(() => clearAll());

  it("transforms only targeted records, preserves total count (archive-not-delete), writes DB backup", () => {
    const hyps = [
      makeStaleHyp("db_stale_1"),
      makeStaleHyp("db_stale_2"),
      makeUnsolvableHyp("db_unsolv_1"),
    ];
    seedDbHyps(hyps);
    const rep = buildResetReport({ now: NOW });

    const calls: string[] = [];
    let backupSnapshot: any = null;
    let savedLab: any = null;
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: true,
      report: rep,
      now: NOW,
      confirmDbSource: true,
      writeBackup: (snapshot) => {
        calls.push("backup");
        backupSnapshot = snapshot;
        return path.join(TMP, "hypothesis_reset_db_backup_test.json");
      },
      saveLab: (lab) => {
        calls.push("save");
        savedLab = lab;
      },
    });

    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.mode, "applied");
      assert.equal(r.sourceRole, "db");
      assert.equal(r.countsBefore.total, r.countsAfter.total, "archive-not-delete: total must not change");
      assert.equal(r.plan.changes.length, 2, "only stale records changed");
      assert.equal(r.plan.countsByBucket.archive_stale, 2);
      assert.ok(r.backupPath && r.backupPath.length > 0, "backup path returned");
    }

    assert.deepEqual(calls, ["backup", "save"], "backup must precede save");
    assert.ok(backupSnapshot, "backup snapshot captured");
    assert.equal(backupSnapshot.sourceRole, "db");
    assert.ok(backupSnapshot.lab && Array.isArray(backupSnapshot.lab.hypotheses));
    assert.equal(backupSnapshot.lab.hypotheses.length, 3, "backup contains full lab");

    const transformed = savedLab.hypotheses;
    const stale1 = transformed.find((h: any) => h.id === "db_stale_1");
    const stale2 = transformed.find((h: any) => h.id === "db_stale_2");
    const unsolv = transformed.find((h: any) => h.id === "db_unsolv_1");
    for (const h of [stale1, stale2]) {
      assert.equal(h.status, "stale-retired");
      assert.equal(h.hygieneTag, "archived_stale");
      assert.match(h.hygieneReason, /applied via hypothesisResetApply: archive_stale/);
      assert.equal(h.archivedAt, NOW.toISOString());
      assert.equal(h.hygieneTaggedBy, "operator-cli");
      assert.match(h.claim, /citation count will pass 1000 by Q4 2024/);
      assert.equal(h.basis, "https://example.com/source");
      assert.equal(h.metric, "OpenAlex citation count");
    }
    // Untargeted record is preserved verbatim apart from existing fields.
    assert.equal(unsolv.status, "data-unavailable");
    assert.equal(unsolv.hygieneTag, "needs_data");
    assert.equal(unsolv.archivedAt, undefined);
  });

  it("refuses with backup_failed if writeBackup throws — saveLab is NOT called", () => {
    seedDbHyps([makeStaleHyp("db_stale_1")]);
    const rep = buildResetReport({ now: NOW });
    let saveCalls = 0;
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: true,
      report: rep,
      now: NOW,
      confirmDbSource: true,
      writeBackup: () => { throw new Error("simulated disk full"); },
      saveLab: () => { saveCalls++; },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "backup_failed");
    assert.equal(saveCalls, 0);
  });

  it("reports before/after counts and changed-ids count in result", () => {
    const hyps = [
      makeStaleHyp("db_stale_1"),
      makeStaleHyp("db_stale_2"),
      makeStaleHyp("db_stale_3"),
    ];
    seedDbHyps(hyps);
    const rep = buildResetReport({ now: NOW });
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: true,
      report: rep,
      now: NOW,
      confirmDbSource: true,
      writeBackup: () => "/tmp/fake_backup.json",
      saveLab: () => {},
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.countsBefore.total, 3);
      assert.equal(r.countsAfter.total, 3);
      assert.equal(r.plan.changes.length, 3);
      assert.match(r.summary, /3 record\(s\) would be archived/);
      assert.match(r.summary, /source=db/);
    }
  });
});

describe("hypothesisResetApply — unsafe buckets refused with confirmDbSource", () => {
  beforeEach(() => clearAll());

  for (const unsafe of [
    "rewrite_positional_debate",
    "rewrite_missing_evidence_path",
    "needs_operator_review",
    "keep_active",
  ]) {
    it(`refuses '${unsafe}' even when confirmDbSource is set`, () => {
      seedDbHyps([makeStaleHyp("db_stale_1")]);
      const rep = buildResetReport({ now: NOW });
      const r = runResetApply({
        selectedBuckets: [unsafe as any],
        apply: true,
        report: rep,
        now: NOW,
        confirmDbSource: true,
        writeBackup: () => "/tmp/never.json",
        saveLab: () => assert.fail("save must not be called"),
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "bucket_not_safe");
    });
  }

  it("hard-refuses 'promote_later_memory_origin' even with confirmDbSource", () => {
    seedDbHyps([makeStaleHyp("db_stale_1")]);
    const rep = buildResetReport({ now: NOW });
    const r = runResetApply({
      selectedBuckets: ["promote_later_memory_origin" as any],
      apply: true,
      report: rep,
      now: NOW,
      confirmDbSource: true,
      writeBackup: () => "/tmp/never.json",
      saveLab: () => assert.fail("save must not be called"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "memory_origin_not_appliable");
  });
});

describe("hypothesisResetApply — source-change detection", () => {
  beforeEach(() => clearAll());

  it("refuses with source_changed_between_report_and_apply when live discovery differs", () => {
    seedDbHyps([makeStaleHyp("db_stale_1")]);
    const rep = buildResetReport({ now: NOW });
    // Pretend live discovery now resolves a JSON file at a different path.
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: true,
      report: rep,
      now: NOW,
      confirmDbSource: true,
      readDbBacked: () => ({
        hypotheses: [makeStaleHyp("db_stale_1") as any],
        exists:     true,
        chosenPath: path.join(TMP, "research_lab.json"),
        chosenRole: "formal",
      }),
      writeBackup: () => "/tmp/never.json",
      saveLab: () => assert.fail("save must not be called"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "source_changed_between_report_and_apply");
  });
});

describe("hypothesisResetApply — dry-run against DB source", () => {
  beforeEach(() => clearAll());

  it("does not require confirmDbSource and does not invoke backup/save", () => {
    seedDbHyps([makeStaleHyp("db_stale_1")]);
    const rep = buildResetReport({ now: NOW });
    let saveCalls = 0;
    let backupCalls = 0;
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: false,
      report: rep,
      now: NOW,
      writeBackup: () => { backupCalls++; return "(never)"; },
      saveLab: () => { saveCalls++; },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.mode, "dry_run");
      assert.equal(r.sourceRole, "db");
      assert.equal(r.backupPath, null);
    }
    assert.equal(backupCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe("hypothesisResetApply — saveResearchLab end-to-end DB write", () => {
  beforeEach(() => clearAll());

  it("persists archived rows to the DB blob (round-trip via saveResearchLab)", () => {
    const hyps = [
      makeStaleHyp("db_stale_1"),
      makeStaleHyp("db_stale_2"),
    ];
    seedDbHyps(hyps);
    const rep = buildResetReport({ now: NOW });
    const r = runResetApply({
      selectedBuckets: ["archive_stale"],
      apply: true,
      report: rep,
      now: NOW,
      confirmDbSource: true,
      // Real backup + real save: no overrides.
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.sourceRole, "db");
    assert.ok(r.backupPath && fs.existsSync(r.backupPath), "backup file written under DATA_DIR");
    assert.ok(path.basename(r.backupPath!).startsWith("hypothesis_reset_db_backup_"));

    const persisted = readDbHyps();
    assert.equal(persisted.length, 2, "DB row still has the same number of records (archive-not-delete)");
    for (const h of persisted) {
      assert.equal((h as any).status, "stale-retired");
      assert.equal((h as any).hygieneTag, "archived_stale");
      assert.equal((h as any).archivedAt, NOW.toISOString());
    }
  });
});
