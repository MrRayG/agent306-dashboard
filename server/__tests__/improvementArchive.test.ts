/**
 * Tests for the Improvement Archive (PR #285).
 *
 * Spec invariants this file pins:
 *   1. Append-only persistence: each call adds exactly one JSONL line, prior
 *      records are not rewritten.
 *   2. Reader tolerates partial / corrupt lines (append-only safety).
 *   3. archiveAsClaimSet() shape matches what researchFocusRubric expects.
 *   4. Approval-safe contract: proposesChange records expose the field but
 *      this module never auto-applies anything (sanity: no side effects
 *      beyond the JSONL file).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redirect DATA_DIR to a temp dir BEFORE importing improvementArchive so
// dataPaths.ts sees the override.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "imp-archive-test-"));
process.env.DATA_DIR = TMP;

const {
  appendImprovementRecord,
  readImprovementArchive,
  readImprovementArchiveTail,
  archiveAsClaimSet,
} = await import("../improvementArchive.ts");

const ARCHIVE_FILE = path.join(TMP, "improvement_archive.jsonl");

before(() => {
  // Ensure clean slate.
  try { fs.unlinkSync(ARCHIVE_FILE); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe("improvementArchive", () => {
  it("appends a record and reads it back", () => {
    const r = appendImprovementRecord({
      variantLabel: "rubric-v1",
      claim: "Adding a focus rubric improves pursue-quality",
      overall: 8.5,
      verdict: "pursue",
      scores: {
        selfImprovementLeverage:   9,
        selfExperimentFeasibility: 8,
        aiBreakthroughNovelty:     7,
        efficiencyLowWaste:        7,
      },
      lesson: "Cycles where the rubric was active produced fewer below-threshold hypotheses.",
      proposesChange: false,
    });
    assert.match(r.id, /^imp_/);
    const all = readImprovementArchive();
    assert.equal(all.length, 1);
    assert.equal(all[0].variantLabel, "rubric-v1");
    assert.equal(all[0].overall, 8.5);
    assert.equal(all[0].proposesChange, false);
  });

  it("is append-only — earlier records are preserved across appends", () => {
    const before = readImprovementArchive().length;
    appendImprovementRecord({ variantLabel: "rubric-v2", claim: "second variant" });
    appendImprovementRecord({ variantLabel: "rubric-v3", claim: "third variant" });
    const after = readImprovementArchive();
    assert.equal(after.length, before + 2);
    assert.equal(after[after.length - 2].variantLabel, "rubric-v2");
    assert.equal(after[after.length - 1].variantLabel, "rubric-v3");
  });

  it("readImprovementArchiveTail returns most-recent first", () => {
    const tail = readImprovementArchiveTail(2);
    assert.equal(tail.length, 2);
    assert.equal(tail[0].variantLabel, "rubric-v3");
    assert.equal(tail[1].variantLabel, "rubric-v2");
  });

  it("tolerates a corrupt line in the middle of the JSONL file", () => {
    fs.appendFileSync(ARCHIVE_FILE, "this-is-not-json\n");
    appendImprovementRecord({ variantLabel: "rubric-v4", claim: "after corruption" });
    const all = readImprovementArchive();
    assert.ok(all.some(r => r.variantLabel === "rubric-v4"));
    // Original records still present.
    assert.ok(all.some(r => r.variantLabel === "rubric-v1"));
  });

  it("archiveAsClaimSet returns {id, claim} entries usable by checkDuplication", () => {
    const set = archiveAsClaimSet();
    assert.ok(set.length > 0);
    for (const e of set) {
      assert.equal(typeof e.id, "string");
      assert.equal(typeof e.claim, "string");
      assert.ok(e.claim.length > 0);
    }
  });

  it("proposesChange flag is recorded but does NOT trigger any auto-apply (approval-safe)", () => {
    const beforeFiles = fs.readdirSync(TMP).sort();
    const r = appendImprovementRecord({
      variantLabel: "rubric-v5",
      claim: "Proposed: tighten the rubric threshold to 8.0",
      proposesChange: true,
      lesson: "Recent cycles show 7.5 still admits some weak hypotheses; recommend operator-review of threshold change.",
    });
    assert.equal(r.proposesChange, true);
    // No new state files should have appeared (the JSONL is the only side effect).
    const afterFiles = fs.readdirSync(TMP).sort();
    assert.deepEqual(afterFiles, beforeFiles);
    // selfRecommendationId remains undefined unless the caller filed one and passed it in.
    assert.equal(r.selfRecommendationId, undefined);
  });

  it("trims claim/lesson and preserves provided ids", () => {
    const r = appendImprovementRecord({
      variantLabel: "  rubric-v6  ",
      claim: "  some claim with surrounding whitespace ".repeat(20), // long
      lesson: "x".repeat(1000),
      selfRecommendationId: "rec_123",
    });
    assert.equal(r.variantLabel, "rubric-v6");
    assert.ok(r.claim.length <= 200);
    assert.ok((r.lesson?.length ?? 0) <= 500);
    assert.equal(r.selfRecommendationId, "rec_123");
  });
});
