/**
 * Tests for the operator-only Hypothesis Reset Apply path.
 *
 * Invariants pinned by this file:
 *   1. computeApplyPlan refuses if no buckets are selected.
 *   2. computeApplyPlan refuses if a selected bucket is not in
 *      SAFE_APPLY_BUCKETS (e.g. rewrite_positional_debate, needs_operator_review,
 *      keep_active, promote_later_memory_origin).
 *   3. computeApplyPlan returns a non-empty change list when archive_stale
 *      records exist; the change preserves id, sets toStatus='stale-retired',
 *      sets toHygieneTag='archived_stale'.
 *   4. runResetApply with apply=false (default) returns a dry-run summary
 *      and DOES NOT invoke saveLab.
 *   5. runResetApply with apply=true invokes saveLab AND first invokes the
 *      backup writer; refuses if backup throws.
 *   6. runResetApply refuses (`report_stale`) when the on-disk record count
 *      differs from the report.
 *   7. After apply, the total record count is unchanged (archive-not-delete).
 *
 * Run: npx tsx --test server/__tests__/hypothesisResetApply.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hypothesis-reset-apply-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");

function hashFile(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hashFile(REAL_RESEARCH_LAB);

const {
  computeApplyPlan,
  runResetApply,
  SAFE_APPLY_BUCKETS,
  ARCHIVE_TAG_FOR_BUCKET,
} = await import("../hypothesisResetApply.ts");
const {
  buildResetReport,
} = await import("../hypothesisResetReport.ts");

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

function writeLabFile(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "research_lab.json"), JSON.stringify(blob));
}

function clearLabFile(): void {
  const p = path.join(TMP, "research_lab.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

describe("hypothesisResetApply — computeApplyPlan refusals", () => {
  after(() => {
    assert.equal(hashFile(REAL_RESEARCH_LAB), PRE_RESEARCH, "real research_lab.json must not be touched");
  });

  it("refuses when no buckets are selected", () => {
    const rep = buildResetReport({ hypotheses: [] });
    const result = computeApplyPlan(rep, [], { selectedBuckets: [] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "no_buckets_selected");
  });

  for (const unsafe of [
    "rewrite_positional_debate",
    "rewrite_missing_evidence_path",
    "needs_operator_review",
    "keep_active",
  ]) {
    it(`refuses '${unsafe}' as not safe to apply`, () => {
      const rep = buildResetReport({ hypotheses: [] });
      const result = computeApplyPlan(rep, [], { selectedBuckets: [unsafe as any] });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "bucket_not_safe");
    });
  }

  it("hard-refuses 'promote_later_memory_origin' with a dedicated reason", () => {
    const rep = buildResetReport({ hypotheses: [] });
    const result = computeApplyPlan(rep, [], { selectedBuckets: ["promote_later_memory_origin" as any] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "memory_origin_not_appliable");
  });
});

describe("hypothesisResetApply — change list", () => {
  it("plans an archive change with archived_stale tag", () => {
    const stale = makeHyp({ id: "h_stale", status: "stale-retired" });
    const rep = buildResetReport({ hypotheses: [stale] });
    const plan = computeApplyPlan(rep, [stale] as any, { selectedBuckets: ["archive_stale" as any] });
    assert.equal(plan.ok, true);
    if (plan.ok) {
      // The disk row already has stale-retired status but no hygieneTag,
      // so an archive-tag write is required and is NOT a no-op skip.
      assert.equal(plan.plan.changes.length, 1);
      assert.equal(plan.plan.changes[0].id, "h_stale");
      assert.equal(plan.plan.changes[0].toStatus, "stale-retired");
      assert.equal(plan.plan.changes[0].toHygieneTag, "archived_stale");
      assert.equal(plan.plan.changes[0].bucket, "archive_stale");
    }
  });

  it("already-archived rows (status=stale-retired + archived_stale tag) are routed to already_archived and never reach an actionable plan", () => {
    // Post-fix classifier short-circuit: a record carrying both
    // status='stale-retired' AND an archived_* hygieneTag has been archived
    // by a prior reset apply. classifyReset puts it in `already_archived`,
    // so when the operator asks to apply `archive_stale`, the bucket is
    // empty and computeApplyPlan returns `no_records_to_change`. This is
    // stronger than the legacy "skipped as no-op" path because the row
    // never enters the change list at all. See
    // hypothesisResetReportIdempotency.test.ts for the full re-classification
    // pin.
    const already = makeHyp({
      id: "h_done",
      status: "stale-retired",
      hygieneTag: ARCHIVE_TAG_FOR_BUCKET.archive_stale,
    });
    const rep = buildResetReport({ hypotheses: [already] });
    const plan = computeApplyPlan(rep, [already] as any, { selectedBuckets: ["archive_stale" as any] });
    assert.equal(plan.ok, false);
    if (!plan.ok) {
      assert.equal(plan.reason, "no_records_to_change");
    }
    // And the entry must be visible in the report under already_archived.
    const aa = rep.buckets.find(b => b.bucket === "already_archived")!;
    assert.equal(aa.count, 1);
    assert.equal(aa.entries[0].id, "h_done");
    assert.equal(aa.safeToArchiveFromCli, false);
  });

  it("returns no_records_to_change when the bucket is empty", () => {
    const keep = makeHyp({ id: "h_keep" });
    const rep = buildResetReport({ hypotheses: [keep] });
    const plan = computeApplyPlan(rep, [keep] as any, { selectedBuckets: ["archive_stale" as any] });
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.equal(plan.reason, "no_records_to_change");
  });
});

describe("hypothesisResetApply — runResetApply dry-run vs apply", () => {
  before(() => clearLabFile());
  after(() => clearLabFile());

  it("dry-run does NOT invoke saveLab and does NOT write a backup", () => {
    const stale = makeHyp({ id: "h_stale", status: "stale-retired" });
    writeLabFile({ hypotheses: [stale], topics: [], stats: {} });
    const rep = buildResetReport({ now: new Date(), hypotheses: [stale] });
    let saveCalls = 0;
    let backupCalls = 0;
    const result = runResetApply({
      selectedBuckets: ["archive_stale" as any],
      apply: false,
      report: rep,
      diskHyps: [stale] as any,
      saveLab: () => { saveCalls++; },
      writeBackup: () => { backupCalls++; return "/tmp/never-written"; },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "dry_run");
      assert.equal(result.backupPath, null);
      assert.equal(result.countsBefore.total, result.countsAfter.total);
    }
    assert.equal(saveCalls, 0);
    assert.equal(backupCalls, 0);
  });

  it("apply=true invokes writeBackup first, then saveLab; preserves record count", () => {
    const stale = makeHyp({ id: "h_stale", status: "stale-retired" });
    writeLabFile({ hypotheses: [stale], topics: [], stats: {} });
    const rep = buildResetReport({ now: new Date(), hypotheses: [stale] });
    const calls: string[] = [];
    const result = runResetApply({
      selectedBuckets: ["archive_stale" as any],
      apply: true,
      report: rep,
      diskHyps: [stale] as any,
      saveLab: (lab: any) => {
        calls.push("save");
        // The transformed lab must include our archived row.
        const h = lab.hypotheses.find((x: any) => x.id === "h_stale");
        assert.ok(h);
        assert.equal(h.hygieneTag, "archived_stale");
        assert.equal(h.status, "stale-retired");
      },
      writeBackup: () => {
        calls.push("backup");
        return "/tmp/backup.json";
      },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mode, "applied");
      assert.equal(result.countsBefore.total, result.countsAfter.total, "archive-not-delete: total must not change");
    }
    assert.deepEqual(calls, ["backup", "save"]);
  });

  it("refuses if writeBackup throws — saveLab is NOT called", () => {
    const stale = makeHyp({ id: "h_stale", status: "stale-retired" });
    writeLabFile({ hypotheses: [stale], topics: [], stats: {} });
    const rep = buildResetReport({ now: new Date(), hypotheses: [stale] });
    let saveCalls = 0;
    const result = runResetApply({
      selectedBuckets: ["archive_stale" as any],
      apply: true,
      report: rep,
      diskHyps: [stale] as any,
      saveLab: () => { saveCalls++; },
      writeBackup: () => { throw new Error("backup disk full"); },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "backup_failed");
    assert.equal(saveCalls, 0);
  });

  it("refuses (report_stale) when on-disk record count != report", () => {
    const stale1 = makeHyp({ id: "h_stale_a", status: "stale-retired" });
    const stale2 = makeHyp({ id: "h_stale_b", status: "stale-retired" });
    writeLabFile({ hypotheses: [stale1, stale2], topics: [], stats: {} });
    const rep = buildResetReport({ now: new Date(), hypotheses: [stale1] }); // report knows only 1
    const result = runResetApply({
      selectedBuckets: ["archive_stale" as any],
      apply: true,
      report: rep,
      diskHyps: [stale1, stale2] as any,
      saveLab: () => assert.fail("saveLab must not be called"),
      writeBackup: () => assert.fail("writeBackup must not be called"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "report_stale");
  });
});

describe("hypothesisResetApply — SAFE_APPLY_BUCKETS coverage", () => {
  it("SAFE_APPLY_BUCKETS is exactly the three archive_* buckets", () => {
    assert.deepEqual(
      SAFE_APPLY_BUCKETS.slice().sort(),
      ["archive_data_unavailable", "archive_duplicate", "archive_stale"],
    );
  });
});
