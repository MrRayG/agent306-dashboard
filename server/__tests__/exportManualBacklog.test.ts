/**
 * exportManualBacklog — read-only Markdown + JSON backlog export.
 *
 * Invariants pinned by this file:
 *   1. With 3 positional-debate + 4 missing-evidence-path + 2 memory-origin
 *      + 5 archived + 1 active hypotheses, the default-bucket export
 *      contains EXACTLY 3 + 4 + 2 = 9 items. Archived and active records
 *      are NOT in the output. Counts in summary.md match.
 *   2. --dry-run writes no files. Bucket counts are printed to stdout.
 *   3. --include-archived adds the `already_archived` bucket; the default
 *      run does not.
 *   4. Determinism: two runs over the same fixture produce byte-identical
 *      backlog.json (no clock fields embedded outside summary.md's
 *      Generated line). Verified via sha256.
 *   5. An item missing a required field for its bucket has the field name
 *      in `missingFields` and the bucket's recommended action is attached.
 *
 * The script must NEVER:
 *   - Open the SQLite DB in write mode.
 *   - Mutate research_lab.json / .bak / memory_knowledge.json.
 *   - Touch any data outside the per-test TMP DATA_DIR.
 *
 * Style matches server/__tests__/migrationFirstRunGuard.test.ts and
 * server/__tests__/hypothesisResetReport.test.ts: node:test +
 * node:assert/strict, top-level await import after DATA_DIR/DB_PATH redirect.
 *
 * Run: npx tsx --test server/__tests__/exportManualBacklog.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "export-manual-backlog-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DB           = path.join(REPO_ROOT, "data", "agent306.db");

function hashFile(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hashFile(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hashFile(REAL_MEMORY);
const PRE_DB       = hashFile(REAL_DB);

const RESEARCH_JSON = path.join(TMP, "research_lab.json");
const MEMORY_JSON   = path.join(TMP, "memory_knowledge.json");

function writeResearchFixture(hyps: any[]): void {
  fs.writeFileSync(RESEARCH_JSON, JSON.stringify({
    topics: [],
    hypotheses: hyps,
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
    lastUpdated: new Date().toISOString(),
  }));
}

function writeMemoryFixture(entries: any[]): void {
  fs.writeFileSync(MEMORY_JSON, JSON.stringify({ entries }));
}

function clearFixtures(): void {
  for (const p of [RESEARCH_JSON, MEMORY_JSON]) {
    try { fs.unlinkSync(p); } catch { /* fine */ }
  }
}

const { runExport, inventoryFields, DEFAULT_BACKLOG_BUCKETS, filenameForBucket } =
  await import("../../scripts/exportManualBacklog.ts");

// ── Synthetic fixture builders ──────────────────────────────────────────────

const NOW = "2026-05-17T00:00:00.000Z";

/** Positional-debate row — classifies into `rewrite_positional_debate`.
 *  All other fields are present so the missing-field inventory is empty
 *  EXCEPT for the operator-facing rewrite. */
function positionalDebateRow(id: string, claim: string): any {
  return {
    id,
    claim,
    basis:           "https://example.com/source",
    metric:          "OpenAlex citation count",
    prediction:      "Position wins.",
    timeframe:       "Q4 2026",
    status:          "forming",
    confidence:      "medium",
    formedAt:        "2026-05-10T00:00:00Z",
    measurementPath: "OpenAlex citation count",
    source:          "research_thread",
  };
}

/** Row with no measurementPath → `rewrite_missing_evidence_path`. */
function missingPathRow(id: string): any {
  return {
    id,
    claim:      `Citation count for paper ${id} will pass 1000 by Q4 2026.`,
    basis:      "https://example.com/source",
    metric:     "OpenAlex citation count",
    prediction: "Citation count exceeds 1000.",
    timeframe:  "Q4 2026",
    status:     "forming",
    confidence: "medium",
    formedAt:   "2026-05-10T00:00:00Z",
    // measurementPath intentionally missing
    source:     "daily_cycle",
  };
}

/** A confirmed/rejected row with an archived hygieneTag → `already_archived`. */
function archivedRow(id: string): any {
  return {
    id,
    claim:      `Already archived ${id}.`,
    basis:      "https://example.com/source",
    metric:     "OpenAlex",
    prediction: "Done.",
    timeframe:  "Q4 2026",
    status:     "stale-retired",
    confidence: "low",
    formedAt:   "2025-12-01T00:00:00Z",
    measurementPath: "OpenAlex",
    hygieneTag: "archived_stale",
    source:     "research_thread",
  };
}

/** A healthy, recent, well-formed active row → `keep_active`. */
function activeRow(id: string): any {
  return {
    id,
    claim:           `Active research-gap ${id} with metric.`,
    basis:           "https://example.com/source",
    metric:          "OpenAlex citation count",
    prediction:      "Citation count exceeds 500 by Q4 2026.",
    timeframe:       "Q4 2026",
    status:          "forming",
    confidence:      "medium",
    formedAt:        NOW,
    measurementPath: "OpenAlex citation count for paper Z",
    source:          "manual",
  };
}

/** A memory-origin Hypothesis-titled entry → `promote_later_memory_origin`. */
function memoryEntry(id: string, title: string): any {
  return {
    id,
    title,
    learnedAt: "2026-05-08T00:00:00Z",
    status:    "active",
  };
}

const SYNTHETIC_HYPS = [
  positionalDebateRow("hyp_pd_001", "Position A is more accurate than Position B on alignment."),
  positionalDebateRow("hyp_pd_002", "Position C is more accurate than Position D on regulation."),
  positionalDebateRow("hyp_pd_003", "Position E is more accurate than Position F on ethics."),
  missingPathRow("hyp_mp_001"),
  missingPathRow("hyp_mp_002"),
  missingPathRow("hyp_mp_003"),
  missingPathRow("hyp_mp_004"),
  archivedRow("hyp_ar_001"),
  archivedRow("hyp_ar_002"),
  archivedRow("hyp_ar_003"),
  archivedRow("hyp_ar_004"),
  archivedRow("hyp_ar_005"),
  activeRow("hyp_active_001"),
];

const SYNTHETIC_MEMORY = [
  memoryEntry("mem_001", "Hypothesis: foo"),
  memoryEntry("mem_002", "Hypothesis: bar"),
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("exportManualBacklog — default bucket selection", () => {
  before(() => clearFixtures());
  beforeEach(() => { clearFixtures(); writeResearchFixture(SYNTHETIC_HYPS); writeMemoryFixture(SYNTHETIC_MEMORY); });
  after(() => { clearFixtures(); });

  it("(1) default buckets: exactly 3 + 4 + 2 = 9 items; archived & active excluded; counts match", () => {
    const outDir = fs.mkdtempSync(path.join(TMP, "out-1-"));
    const r = runExport({ argv: [
      "--data-dir", TMP,
      "--out-dir",  outDir,
      "--now",      NOW,
      "--format",   "both",
    ]});
    assert.equal(r.exitCode, 0, `expected exit 0, got ${r.exitCode}. stdout:\n${r.stdout}`);
    assert.ok(r.payload, "payload must be present on a real run");
    assert.equal(r.payload!.items.length, 9,
      `expected 9 items (3 positional + 4 missing-path + 2 memory), got ${r.payload!.items.length}`);
    assert.equal(r.payload!.counts["rewrite_positional_debate"], 3);
    assert.equal(r.payload!.counts["rewrite_missing_evidence_path"], 4);
    assert.equal(r.payload!.counts["promote_later_memory_origin"], 2);
    // Archived and active ids must be ABSENT.
    const ids = new Set(r.payload!.items.map(i => i.id));
    for (const a of ["hyp_ar_001","hyp_ar_002","hyp_ar_003","hyp_ar_004","hyp_ar_005","hyp_active_001"]) {
      assert.equal(ids.has(a), false, `archived/active id leaked into export: ${a}`);
    }
    // summary.md exists and contains the correct counts.
    const summary = fs.readFileSync(path.join(outDir, "summary.md"), "utf8");
    assert.match(summary, /rewrite_positional_debate.*:\s*3/);
    assert.match(summary, /rewrite_missing_evidence_path.*:\s*4/);
    assert.match(summary, /promote_later_memory_origin.*:\s*2/);
    assert.match(summary, /\*\*Total:\*\*\s*9/);
    // Three per-bucket md files exist.
    for (const b of DEFAULT_BACKLOG_BUCKETS) {
      const fname = filenameForBucket(b);
      assert.ok(fname, `bucket ${b} must have a filename`);
      assert.equal(fs.existsSync(path.join(outDir, fname!)), true,
        `${fname} must exist in ${outDir}`);
    }
    // backlog.json exists and parses.
    const json = JSON.parse(fs.readFileSync(path.join(outDir, "backlog.json"), "utf8"));
    assert.equal(json.schemaVersion, "manual-backlog-export-1");
    assert.equal(json.items.length, 9);
  });

  it("(2) --dry-run writes no files but prints bucket counts", () => {
    const outDir = fs.mkdtempSync(path.join(TMP, "out-2-"));
    const r = runExport({ argv: [
      "--data-dir", TMP,
      "--out-dir",  outDir,
      "--now",      NOW,
      "--dry-run",
    ]});
    assert.equal(r.exitCode, 0);
    assert.equal(r.writtenPaths.length, 0, "dry-run must write zero files");
    // outDir was not created (or, if it was, contains no export files).
    if (fs.existsSync(outDir)) {
      const remaining = fs.readdirSync(outDir);
      assert.equal(remaining.length, 0, `dry-run must leave outDir empty, found: ${remaining.join(",")}`);
    }
    assert.match(r.stdout, /\[dry-run\]/);
    assert.match(r.stdout, /rewrite_positional_debate:\s*3/);
    assert.match(r.stdout, /rewrite_missing_evidence_path:\s*4/);
    assert.match(r.stdout, /promote_later_memory_origin:\s*2/);
    assert.match(r.stdout, /Total items in scope:\s*9/);
  });

  it("(3) --include-archived adds the already_archived bucket; default does not", () => {
    const outDirDefault = fs.mkdtempSync(path.join(TMP, "out-3-default-"));
    const rDefault = runExport({ argv: [
      "--data-dir", TMP, "--out-dir", outDirDefault, "--now", NOW,
    ]});
    assert.equal(rDefault.exitCode, 0);
    assert.equal(rDefault.payload!.includeArchived, false);
    assert.equal(rDefault.payload!.bucketsIncluded.includes("already_archived"), false);
    assert.equal(rDefault.payload!.items.some(i => i.bucket === "already_archived"), false);

    const outDirIncl = fs.mkdtempSync(path.join(TMP, "out-3-incl-"));
    const rIncl = runExport({ argv: [
      "--data-dir", TMP, "--out-dir", outDirIncl, "--now", NOW, "--include-archived",
    ]});
    assert.equal(rIncl.exitCode, 0);
    assert.equal(rIncl.payload!.includeArchived, true);
    assert.equal(rIncl.payload!.bucketsIncluded.includes("already_archived"), true);
    assert.equal(rIncl.payload!.counts["already_archived"], 5,
      `expected 5 archived rows in the inclusive export, got ${rIncl.payload!.counts["already_archived"]}`);
    // 9 backlog + 5 archived = 14
    assert.equal(rIncl.payload!.items.length, 14);
    assert.equal(fs.existsSync(path.join(outDirIncl, "already-archived-audit-only.md")), true);
  });

  it("(4) determinism: two runs produce byte-identical backlog.json", () => {
    const outA = fs.mkdtempSync(path.join(TMP, "out-4a-"));
    const outB = fs.mkdtempSync(path.join(TMP, "out-4b-"));
    const argv = [
      "--data-dir", TMP, "--now", NOW, "--format", "both",
    ];
    runExport({ argv: [...argv, "--out-dir", outA] });
    runExport({ argv: [...argv, "--out-dir", outB] });
    const hashA = crypto.createHash("sha256").update(fs.readFileSync(path.join(outA, "backlog.json"))).digest("hex");
    const hashB = crypto.createHash("sha256").update(fs.readFileSync(path.join(outB, "backlog.json"))).digest("hex");
    assert.equal(hashA, hashB,
      "backlog.json must be byte-identical across runs over the same fixture and pinned --now");
    // summary.md should ALSO be byte-identical when --now is pinned, since
    // that pins the only clock field. Pin this too.
    const summaryHashA = crypto.createHash("sha256").update(fs.readFileSync(path.join(outA, "summary.md"))).digest("hex");
    const summaryHashB = crypto.createHash("sha256").update(fs.readFileSync(path.join(outB, "summary.md"))).digest("hex");
    assert.equal(summaryHashA, summaryHashB,
      "summary.md must be byte-identical when --now is pinned");
  });

  it("(5) items missing a required field appear in missingFields with the bucket's recommended action", () => {
    const outDir = fs.mkdtempSync(path.join(TMP, "out-5-"));
    const r = runExport({ argv: ["--data-dir", TMP, "--out-dir", outDir, "--now", NOW]});
    assert.equal(r.exitCode, 0);
    // The 4 missing-path rows must each have measurementPath in missingFields
    // and the operator-facing "repair evidence path" action.
    const pathItems = r.payload!.items.filter(i => i.bucket === "rewrite_missing_evidence_path");
    assert.equal(pathItems.length, 4);
    for (const it of pathItems) {
      assert.equal(it.missingFields.includes("measurementPath"), true,
        `${it.id} should report measurementPath as missing, got: ${it.missingFields.join(",")}`);
      assert.equal(it.recommendedAction, "repair evidence path");
    }
    // Positional-debate rows have all fields present; missing list is empty
    // but the bucket's recommended action is still the rewrite directive.
    const posItems = r.payload!.items.filter(i => i.bucket === "rewrite_positional_debate");
    assert.equal(posItems.length, 3);
    for (const it of posItems) {
      assert.equal(it.recommendedAction, "rewrite as research-gap framing");
    }
    // Memory-origin rows route to operator promotion.
    const memItems = r.payload!.items.filter(i => i.bucket === "promote_later_memory_origin");
    assert.equal(memItems.length, 2);
    for (const it of memItems) {
      assert.equal(it.recommendedAction, "review for operator promotion");
      assert.equal(it.origin, "memory");
    }
  });
});

describe("exportManualBacklog — CLI parsing + pure helpers", () => {
  it("inventoryFields: empty strings count as missing", () => {
    const inv = inventoryFields(
      { claim: "x", metric: "", basis: "  ", measurementPath: "ok" },
      ["claim", "metric", "basis", "measurementPath"],
    );
    assert.deepEqual(inv.present, ["claim", "measurementPath"]);
    assert.deepEqual(inv.missing, ["metric", "basis"]);
  });
});

describe("exportManualBacklog — isolation contract", () => {
  after(() => {
    assert.equal(hashFile(REAL_RESEARCH_LAB), PRE_RESEARCH,
      "real data/research_lab.json must not be touched");
    assert.equal(hashFile(REAL_MEMORY), PRE_MEMORY,
      "real data/memory_knowledge.json must not be touched");
    assert.equal(hashFile(REAL_DB), PRE_DB,
      "real data/agent306.db must not be touched");
  });

  it("a real export run against TMP DATA_DIR does not touch repo data/", () => {
    writeResearchFixture(SYNTHETIC_HYPS);
    writeMemoryFixture(SYNTHETIC_MEMORY);
    const outDir = fs.mkdtempSync(path.join(TMP, "out-iso-"));
    const r = runExport({ argv: ["--data-dir", TMP, "--out-dir", outDir, "--now", NOW]});
    assert.equal(r.exitCode, 0);
    // The hash check happens in `after`. This `it` is the smoke load.
  });
});
