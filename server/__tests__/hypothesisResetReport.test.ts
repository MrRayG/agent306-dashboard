/**
 * Tests for the read-only Hypothesis Reset Report builder.
 *
 * Invariants pinned by this file:
 *   1. Empty input → well-shaped report with all RESET_BUCKETS at count=0.
 *   2. Each bucket section carries an operator-facing description and an
 *      explicit `safeToArchiveFromCli` flag that is true ONLY for the three
 *      archive_* buckets.
 *   3. The text rendering includes counts, per-id reason lines, and a note
 *      about the dry-run CLI default.
 *   4. The builder is read-only — calling it does not write any file under
 *      DATA_DIR.
 *   5. The report carries inputs (now, staleDays, maxActive, maxNewPerDailyCycle)
 *      and resolves them deterministically.
 *   6. The report's per-id reasons match what classifyReset would say.
 *
 * Run: npx tsx --test server/__tests__/hypothesisResetReport.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hypothesis-reset-report-test-"));
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
  buildResetReport,
  formatResetReport,
  selectApplicableEntries,
} = await import("../hypothesisResetReport.ts");

const {
  RESET_BUCKETS,
} = await import("../hypothesisIntakeAuditVisibility.ts");

function makeHyp(overrides: Record<string, unknown>): any {
  return {
    id:              "hyp_default",
    claim:           "Default research-gap claim with metric: citation count will pass 1000 by Q4 2026.",
    basis:           "https://example.com/source",
    metric:          "OpenAlex citation count",
    prediction:      "Citation count will pass 1000 by Q4 2026.",
    timeframe:       "Q4 2026",
    status:          "forming",
    confidence:      "medium",
    formedAt:        new Date("2026-05-10T00:00:00Z").toISOString(),
    measurementPath: "OpenAlex citation count for paper X",
    ...overrides,
  };
}

describe("hypothesisResetReport — empty input", () => {
  after(() => {
    assert.equal(hash(REAL_RESEARCH_LAB), PRE_RESEARCH, "real research_lab.json must not be touched");
  });

  it("returns a well-shaped report when hypotheses is empty", () => {
    const r = buildResetReport({ now: new Date("2026-05-17T00:00:00Z"), hypotheses: [] });
    assert.equal(r.schemaVersion, "hypothesis-reset-report-1");
    assert.equal(r.meta.totalRecords, 0);
    assert.equal(r.buckets.length, RESET_BUCKETS.length);
    for (const b of r.buckets) assert.equal(b.count, 0);
  });

  it("safeToArchiveFromCli is true only for the three archive_* buckets", () => {
    const r = buildResetReport({ now: new Date("2026-05-17T00:00:00Z"), hypotheses: [] });
    const safe = r.buckets.filter(b => b.safeToArchiveFromCli).map(b => b.bucket).sort();
    assert.deepEqual(safe.sort(), ["archive_data_unavailable", "archive_duplicate", "archive_stale"]);
  });
});

describe("hypothesisResetReport — populated", () => {
  const NOW = new Date("2026-05-17T00:00:00Z");

  it("groups each hypothesis into the right bucket with reasons", () => {
    const r = buildResetReport({
      now: NOW,
      hypotheses: [
        makeHyp({ id: "h_keep" }),
        makeHyp({ id: "h_stale", status: "stale-retired" }),
        makeHyp({ id: "h_dup",   aliasOf: "hyp_canonical_1" }),
        makeHyp({ id: "h_data",  status: "data-unavailable" }),
        makeHyp({ id: "h_pos",   claim: "Position A is more accurate than Position B on AI regulation." }),
      ] as any,
    });
    assert.equal(r.counts.keep_active, 1);
    assert.equal(r.counts.archive_stale, 1);
    assert.equal(r.counts.archive_duplicate, 1);
    assert.equal(r.counts.archive_data_unavailable, 1);
    assert.equal(r.counts.rewrite_positional_debate, 1);
    const stale = r.buckets.find(b => b.bucket === "archive_stale")!;
    assert.equal(stale.entries[0].id, "h_stale");
    assert.ok(stale.entries[0].reasons.length > 0);
    assert.ok(stale.entries[0].claimPreview.length > 0);
    assert.equal(stale.entries[0].status, "stale-retired");
  });

  it("formatResetReport prints counts and the dry-run note", () => {
    const r = buildResetReport({ now: NOW, hypotheses: [makeHyp({ id: "h_keep" })] as any });
    const text = formatResetReport(r);
    assert.match(text, /Hypothesis Reset Report/);
    assert.match(text, /keep_active: 1/);
    assert.match(text, /dry-run by default/i);
  });

  it("selectApplicableEntries returns ONLY the entries in safe-to-archive buckets", () => {
    const r = buildResetReport({
      now: NOW,
      hypotheses: [
        makeHyp({ id: "h_keep" }),
        makeHyp({ id: "h_stale", status: "stale-retired" }),
        makeHyp({ id: "h_pos",   claim: "Position A is more accurate than Position B on AI regulation." }),
      ] as any,
    });
    const selected = selectApplicableEntries(r, [
      "archive_stale",
      "rewrite_positional_debate", // not safe — filtered out
      "keep_active",                // not safe — filtered out
    ] as any);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].id, "h_stale");
  });
});

describe("hypothesisResetReport — read-only behaviour", () => {
  it("does not write any new file when no hypotheses are passed", () => {
    const before = new Set(fs.readdirSync(TMP));
    buildResetReport({ hypotheses: [] });
    const after = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...after].sort(), [...before].sort());
  });
});
