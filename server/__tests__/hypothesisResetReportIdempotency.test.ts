/**
 * Tests for the post-apply idempotency / re-classification behaviour of the
 * hypothesis reset pipeline.
 *
 * Production incident motivating this file:
 *   An operator ran `--bucket=archive_data_unavailable --apply --confirm-source=db`.
 *   70 records were archived. The follow-up dry-run reported
 *     archive_data_unavailable: 0
 *   (correct) but
 *     archive_stale: was inflated by the same 70 just-archived records.
 *   classifyReset's lifecycle switch caught `status=stale-retired` first and
 *   routed the records back to `archive_stale`, ignoring the archived_*
 *   hygieneTag that the apply path had written. A second `--bucket=archive_stale
 *   --apply` would therefore re-touch already-archived rows.
 *
 * Invariants pinned by this file:
 *   1. A record with status='stale-retired' AND an archived_* hygieneTag is
 *      classified into the non-actionable `already_archived` bucket — never
 *      into any archive_* bucket.
 *   2. The `already_archived` bucket reports `safeToArchiveFromCli=false`.
 *   3. Re-running the report after archive_data_unavailable apply puts the
 *      previously-archived rows in `already_archived` (visible for audit)
 *      and leaves archive_stale at its pre-apply count — NOT inflated by the
 *      apply.
 *   4. `selectApplicableEntries` never surfaces an already_archived entry,
 *      even if the operator requests the bucket by name.
 *   5. `archive_data_unavailable` stays at 0 after the apply (re-classification
 *      does not put them back).
 *   6. A record with status='stale-retired' and NO hygieneTag (legacy /
 *      operator-set lifecycle) still goes to `archive_stale` — the
 *      already_archived gate must only fire when both signals are present.
 *
 * Run: npx tsx --test server/__tests__/hypothesisResetReportIdempotency.test.ts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hypothesis-reset-idempotency-test-"));
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
  classifyReset,
} = await import("../hypothesisIntakeAuditVisibility.ts");

const {
  buildResetReport,
  selectApplicableEntries,
} = await import("../hypothesisResetReport.ts");

const NOW = new Date("2026-05-17T00:00:00Z");

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

describe("hypothesisReset — already_archived classifier short-circuit", () => {
  after(() => {
    assert.equal(hashFile(REAL_RESEARCH_LAB), PRE_RESEARCH, "real research_lab.json must not be touched");
  });

  it("routes status=stale-retired + hygieneTag=archived_unsolvable to already_archived", () => {
    const h = makeHyp({
      id:             "h_post_apply_du",
      status:         "stale-retired",
      hygieneTag:     "archived_unsolvable",
      hygieneReason:  "applied via hypothesisResetApply: archive_data_unavailable",
      hygieneTaggedBy: "operator-cli",
      archivedAt:     NOW.toISOString(),
    });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "already_archived", r.reasons.join(" / "));
  });

  it("routes status=stale-retired + hygieneTag=archived_stale to already_archived", () => {
    const h = makeHyp({
      id:         "h_post_apply_stale",
      status:     "stale-retired",
      hygieneTag: "archived_stale",
      archivedAt: NOW.toISOString(),
    });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "already_archived");
  });

  it("routes status=stale-retired + hygieneTag=archived_irrelevant to already_archived", () => {
    const h = makeHyp({
      id:         "h_post_apply_dup",
      status:     "stale-retired",
      hygieneTag: "archived_irrelevant",
      archivedAt: NOW.toISOString(),
    });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "already_archived");
  });

  it("preserves legacy behaviour: status=stale-retired with NO hygieneTag still goes to archive_stale", () => {
    const h = makeHyp({ id: "h_legacy_stale", status: "stale-retired" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_stale");
  });
});

describe("hypothesisReset — post-apply re-classification (idempotency)", () => {
  it("after an archive_data_unavailable apply, the same records do NOT re-appear as archive_stale on the next dry-run", () => {
    // Build a small population that mirrors the production incident:
    //  - 3 records that WOULD be archive_data_unavailable (status=data-unavailable)
    //  - 2 unrelated active records that classify as archive_stale (status=stale-retired,
    //    no archive hygieneTag — legacy)
    //  - 1 keep_active record
    const preApply = [
      makeHyp({ id: "h_du_1", status: "data-unavailable" }),
      makeHyp({ id: "h_du_2", status: "data-unavailable" }),
      makeHyp({ id: "h_du_3", status: "data-unavailable" }),
      makeHyp({ id: "h_stale_1", status: "stale-retired" }),
      makeHyp({ id: "h_stale_2", status: "stale-retired" }),
      makeHyp({ id: "h_keep", status: "forming" }),
    ];

    const pre = buildResetReport({ now: NOW, hypotheses: preApply as any });
    assert.equal(pre.counts.archive_data_unavailable, 3, "pre-apply: 3 data-unavailable");
    assert.equal(pre.counts.archive_stale, 2, "pre-apply: 2 archive_stale");
    assert.equal(pre.counts.keep_active, 1);
    assert.equal(pre.counts.already_archived, 0, "pre-apply: no already_archived");

    // Simulate what hypothesisResetApply.ts writes for an
    // archive_data_unavailable apply: status='stale-retired',
    // hygieneTag='archived_unsolvable'.
    const postApply = preApply.map(h =>
      h.id.startsWith("h_du_")
        ? {
            ...h,
            status:          "stale-retired",
            hygieneTag:      "archived_unsolvable",
            hygieneReason:   "applied via hypothesisResetApply: archive_data_unavailable",
            hygieneTaggedBy: "operator-cli",
            archivedAt:      NOW.toISOString(),
          }
        : h,
    );

    const post = buildResetReport({ now: NOW, hypotheses: postApply as any });

    // The three just-archived rows should NOT be in archive_stale.
    assert.equal(
      post.counts.archive_stale,
      2,
      "post-apply: archive_stale must remain at the pre-apply unresolved count (2). " +
        "If this is 5, the just-archived records were re-classified as archive_stale.",
    );

    // archive_data_unavailable should be empty.
    assert.equal(post.counts.archive_data_unavailable, 0, "post-apply: archive_data_unavailable must be 0");

    // The three just-archived records should be in `already_archived`, visible
    // for audit but non-actionable.
    assert.equal(post.counts.already_archived, 3, "post-apply: already_archived must hold the 3 just-archived ids");
    const archivedSection = post.buckets.find(b => b.bucket === "already_archived")!;
    const archivedIds = archivedSection.entries.map(e => e.id).sort();
    assert.deepEqual(archivedIds, ["h_du_1", "h_du_2", "h_du_3"]);
    assert.equal(archivedSection.safeToArchiveFromCli, false, "already_archived is NOT safe to archive from CLI");

    // keep_active should be untouched.
    assert.equal(post.counts.keep_active, 1);
  });

  it("selectApplicableEntries never surfaces already_archived entries even if the bucket is requested", () => {
    const r = buildResetReport({
      now: NOW,
      hypotheses: [
        makeHyp({
          id:         "h_aa",
          status:     "stale-retired",
          hygieneTag: "archived_unsolvable",
          archivedAt: NOW.toISOString(),
        }),
      ] as any,
    });
    assert.equal(r.counts.already_archived, 1);
    // Requesting the bucket by name must be filtered out — it is not in
    // SAFE_TO_ARCHIVE_BUCKETS.
    const selected = selectApplicableEntries(r, [
      "already_archived" as any,
      "archive_stale",
    ]);
    assert.equal(selected.length, 0, "already_archived records must never be surfaced as applicable");
  });

  it("the already_archived bucket section reports recommendedAction text and safeToArchiveFromCli=false", () => {
    const r = buildResetReport({
      now: NOW,
      hypotheses: [
        makeHyp({
          id:         "h_aa",
          status:     "stale-retired",
          hygieneTag: "archived_stale",
        }),
      ] as any,
    });
    const section = r.buckets.find(b => b.bucket === "already_archived")!;
    assert.ok(section, "already_archived section must exist");
    assert.equal(section.safeToArchiveFromCli, false);
    assert.match(section.description, /previously archived/i);
    assert.match(section.recommendedAction, /No action/i);
  });
});
