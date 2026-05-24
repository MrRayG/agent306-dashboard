/**
 * Smoke test for scripts/weeklyArchivalSprint.ts — the read-only operator
 * CLI that flags the oldest active KB entries with no hypothesis linkage
 * for archival review.
 *
 * Invariants pinned by this file:
 *   1. The script runs against an on-disk SQLite DB opened by the CLI itself
 *      and produces a JSON payload with the documented shape.
 *   2. Oldest unlinked active entries appear first; entries with
 *      `promotedToHypothesisId`, hypothesis-origin titles ("Hypothesis: ..."),
 *      or `tier !== "active"` are excluded.
 *   3. The CLI opens the DB read-only and exposes no write flag — verified
 *      by inspecting the file's source text for INSERT/UPDATE/DELETE keywords
 *      and for the readonly: true open.
 *   4. --pretty switches to human-readable output.
 *
 * Run: npx tsx --test scripts/__tests__/weeklyArchivalSprint.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  buildReport,
  buildLinkedKbIdsFromHypotheses,
  hasHypothesisLinkage,
  isActiveKbEntry,
  parseArgs,
  runCli,
} = await import("../weeklyArchivalSprint.ts");

interface CapturedStream {
  data: string;
  write(s: string): boolean;
}

function makeStream(): CapturedStream {
  return {
    data: "",
    write(s: string): boolean {
      this.data += s;
      return true;
    },
  };
}

function makeFixture(): { dbPath: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-archival-"));
  const dbPath = path.join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memory_knowledge (
      id TEXT PRIMARY KEY,
      blob TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE research_lab (
      id TEXT PRIMARY KEY,
      blob TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);

  const entries = [
    // Oldest, active, no linkage — should appear first.
    { id: "k_old_unlinked_1", title: "Old fact A", category: "research", tier: "active", learnedAt: "2025-01-01T00:00:00.000Z" },
    // Newer, active, no linkage.
    { id: "k_recent_unlinked", title: "Recent fact", category: "research", tier: "active", learnedAt: "2026-01-01T00:00:00.000Z" },
    // Old, but operator-promoted to a hypothesis — must be excluded.
    { id: "k_promoted", title: "Old promoted entry", category: "research", tier: "active", learnedAt: "2024-06-01T00:00:00.000Z", promotedToHypothesisId: "hyp_x" },
    // Old, but hypothesis-origin title — must be excluded.
    { id: "k_hyp_title", title: "Hypothesis: something", category: "research", tier: "active", learnedAt: "2024-07-01T00:00:00.000Z" },
    // Old, but tier=operational — must be excluded (not active).
    { id: "k_operational", title: "Old operational", category: "directive", tier: "operational", learnedAt: "2024-08-01T00:00:00.000Z" },
    // Old, active, BUT linked from a hypothesis blob — must be excluded.
    { id: "k_linked_from_hyp", title: "Old, hypothesis-referenced", category: "research", tier: "active", learnedAt: "2024-09-01T00:00:00.000Z" },
    // Another old unlinked one — second-oldest of the unlinked set.
    { id: "k_old_unlinked_2", title: "Old fact B", category: "ai_signal", tier: "active", learnedAt: "2025-02-01T00:00:00.000Z" },
  ];
  db.prepare("INSERT INTO memory_knowledge (id, blob, updated_at) VALUES (?, ?, ?)").run(
    "main",
    JSON.stringify({ entries }),
    "2026-05-24T00:00:00.000Z",
  );

  const hypotheses = [
    { id: "hyp_a", knowledgeEntryIds: ["k_linked_from_hyp"] },
    { id: "hyp_b", sourceKnowledgeId: "k_some_other_id" },
  ];
  db.prepare("INSERT INTO research_lab (id, blob, updated_at) VALUES (?, ?, ?)").run(
    "main",
    JSON.stringify({ hypotheses }),
    "2026-05-24T00:00:00.000Z",
  );
  db.close();

  return {
    dbPath,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("weeklyArchivalSprint — pure helpers", () => {
  it("buildLinkedKbIdsFromHypotheses collects both array and single-pointer linkage", () => {
    const out = buildLinkedKbIdsFromHypotheses([
      { id: "h1", knowledgeEntryIds: ["k1", "k2"] },
      { id: "h2", sourceKnowledgeId: "k3" },
      { id: "h3" },
    ]);
    assert.equal(out.has("k1"), true);
    assert.equal(out.has("k2"), true);
    assert.equal(out.has("k3"), true);
    assert.equal(out.size, 3);
  });

  it("hasHypothesisLinkage flags promoted entries, linked ids, and hypothesis-origin titles", () => {
    const linked = new Set<string>(["k_linked"]);
    assert.equal(hasHypothesisLinkage({ id: "k1", title: "fact", promotedToHypothesisId: "h" }, linked), true);
    assert.equal(hasHypothesisLinkage({ id: "k_linked", title: "fact" }, linked), true);
    assert.equal(hasHypothesisLinkage({ id: "k2", title: "Hypothesis: foo" }, linked), true);
    assert.equal(hasHypothesisLinkage({ id: "k3", title: "regular kb entry" }, linked), false);
  });

  it("isActiveKbEntry rejects operational tier and archived entries", () => {
    assert.equal(isActiveKbEntry({ id: "a", tier: "active" }), true);
    assert.equal(isActiveKbEntry({ id: "b", tier: "operational" }), false);
    assert.equal(isActiveKbEntry({ id: "c", tier: "active", archivedAt: "2026-05-01" }), false);
  });

  it("buildReport ranks oldest unlinked first and excludes everything that has linkage", () => {
    const entries = [
      { id: "k_old_unlinked_1", title: "Old fact A", tier: "active", learnedAt: "2025-01-01T00:00:00.000Z" },
      { id: "k_recent_unlinked", title: "Recent fact", tier: "active", learnedAt: "2026-01-01T00:00:00.000Z" },
      { id: "k_promoted", title: "Promoted", tier: "active", learnedAt: "2024-06-01T00:00:00.000Z", promotedToHypothesisId: "hyp_x" },
      { id: "k_hyp_title", title: "Hypothesis: foo", tier: "active", learnedAt: "2024-07-01T00:00:00.000Z" },
      { id: "k_operational", title: "Op", tier: "operational", learnedAt: "2024-08-01T00:00:00.000Z" },
      { id: "k_linked_from_hyp", title: "Linked", tier: "active", learnedAt: "2024-09-01T00:00:00.000Z" },
      { id: "k_old_unlinked_2", title: "Old fact B", tier: "active", learnedAt: "2025-02-01T00:00:00.000Z" },
    ];
    const hypotheses = [{ id: "hyp_a", knowledgeEntryIds: ["k_linked_from_hyp"] }];
    const report = buildReport(entries, hypotheses, {
      limit: 10,
      includeResearchLinked: false,
      now: "2026-05-24T00:00:00.000Z",
      dbPath: "/tmp/test.db",
    });
    assert.equal(report.counts.totalActive, 6); // 7 entries minus the operational one
    assert.equal(report.counts.totalUnlinked, 3);
    // Oldest first: 2025-01-01, 2025-02-01, 2026-01-01.
    assert.deepEqual(
      report.candidates.map((c) => c.id),
      ["k_old_unlinked_1", "k_old_unlinked_2", "k_recent_unlinked"],
    );
    assert.equal(report.candidates[0].linkedHypothesisCount, 0);
    // Age in days against pinned now (2026-05-24 minus 2025-01-01 ≈ 508).
    assert.equal(typeof report.candidates[0].ageInDays, "number");
    assert.ok(report.candidates[0].ageInDays! > 400);
  });

  it("buildReport ageInDays is null when --now is not pinned", () => {
    const report = buildReport(
      [{ id: "k1", title: "x", tier: "active", learnedAt: "2025-01-01T00:00:00.000Z" }],
      [],
      { limit: 10, includeResearchLinked: false, now: null, dbPath: "x" },
    );
    assert.equal(report.candidates[0].ageInDays, null);
  });

  it("parseArgs accepts --limit in both = and space forms", () => {
    const a = parseArgs(["--limit=20", "--pretty"]);
    assert.equal(a.ok, true);
    if (a.ok) {
      assert.equal(a.args.limit, 20);
      assert.equal(a.args.pretty, true);
    }
    const b = parseArgs(["--limit", "5"]);
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.args.limit, 5);
  });

  it("parseArgs rejects unknown flags", () => {
    const r = parseArgs(["--bogus"]);
    assert.equal(r.ok, false);
  });
});

describe("weeklyArchivalSprint — CLI end-to-end", () => {
  it("runs against a seeded on-disk DB and returns the expected candidate shape", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runCli({
        argv: ["--db", fx.dbPath, "--now=2026-05-24T00:00:00.000Z", "--limit", "5", "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0, `expected exit 0, got ${code}; stderr=${stderr.data}`);
      const payload = JSON.parse(stdout.data) as {
        generatedAt: string | null;
        dbPath: string;
        candidates: Array<{ id: string; ageInDays: number | null; reason: string }>;
        counts: { totalActive: number; totalUnlinked: number; returned: number };
        notes: string[];
      };
      assert.equal(payload.generatedAt, "2026-05-24T00:00:00.000Z");
      assert.equal(payload.counts.returned, 3);
      assert.equal(payload.candidates[0].id, "k_old_unlinked_1");
      assert.equal(payload.candidates[1].id, "k_old_unlinked_2");
      assert.equal(payload.candidates[2].id, "k_recent_unlinked");
      assert.ok(payload.candidates[0].reason.includes("no hypothesis linkage"));
      assert.ok(stderr.data.includes("with no hypothesis linkage"));
    } finally {
      fx.cleanup();
    }
  });

  it("--pretty produces a human-readable table on stdout", () => {
    const fx = makeFixture();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runCli({
        argv: ["--db", fx.dbPath, "--pretty", "--no-source-check", "--now=2026-05-24T00:00:00.000Z"],
        io: { stdout, stderr },
      });
      assert.equal(code, 0);
      assert.ok(stdout.data.includes("Weekly Archival Sprint"));
      assert.ok(stdout.data.includes("k_old_unlinked_1"));
      assert.ok(stdout.data.includes("ageDays"));
    } finally {
      fx.cleanup();
    }
  });

  it("returns exit code 2 when the KB table is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-archival-empty-"));
    const dbPath = path.join(dir, "empty.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (x TEXT)");
    db.close();
    try {
      const stdout = makeStream();
      const stderr = makeStream();
      const code = runCli({
        argv: ["--db", dbPath, "--no-source-check"],
        io: { stdout, stderr },
      });
      assert.equal(code, 2);
      assert.ok(stderr.data.includes("memory_knowledge"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--help exits 0 and prints usage", () => {
    const stdout = makeStream();
    const stderr = makeStream();
    const code = runCli({
      argv: ["--help"],
      io: { stdout, stderr },
    });
    assert.equal(code, 0);
    assert.ok(stdout.data.includes("Weekly Archival Sprint"));
  });
});

describe("weeklyArchivalSprint — source-text invariants", () => {
  it("the script source does not contain any SQL write keyword", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "weeklyArchivalSprint.ts"), "utf8");
    // Look for the SQL write keywords in their SQL-ish form (inside strings or
    // template literals). We only need to confirm none of these appear in any
    // form that could be a SQL statement.
    const writeKeywords = [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+[A-Za-z_"]/i,
      /\bDELETE\s+FROM\b/i,
      /\bREPLACE\s+INTO\b/i,
      /\bDROP\s+TABLE\b/i,
      /\bCREATE\s+TABLE\b/i,
      /\bALTER\s+TABLE\b/i,
    ];
    for (const re of writeKeywords) {
      assert.equal(re.test(src), false, `source must not contain ${re}`);
    }
  });

  it("the script opens better-sqlite3 with readonly: true", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "weeklyArchivalSprint.ts"), "utf8");
    assert.ok(
      /new\s+Database\([^)]*readonly:\s*true/.test(src),
      "expected `new Database(path, { readonly: true })` in script source",
    );
  });
});
