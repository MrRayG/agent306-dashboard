/**
 * Regression test for the manual publish-after-edit gating logic
 * (audit follow-up 2026-05-02).
 *
 * The user-reported gap: a quarantined blog post had no path forward —
 * the verifier rejected it, no editor comments came back to Agent 306,
 * and there was no way to manually publish once the agent or the operator
 * had revised it. The fix:
 *   1. claimExtractor surfaces editor_comments + manualPublishAllowed.
 *   2. POST /api/blog/posts/:id/publish-after-edit re-runs the verifier
 *      against the current body and either publishes (PASS / SOFT_WARN) or
 *      blocks with editor_comments (HARD_FAIL, no override).
 *
 * This test pins the gating logic by exercising the pieces directly. It
 * does not stand up an Express app — the route handler is mechanical glue
 * around verifyClaims + extractClaimsAndComments + publishPost.
 *
 * Run: npx tsx --test server/__tests__/blogPublishAfterEdit.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-publish-after-edit-"));
process.env.DATA_DIR = tmpDir;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { extractClaimsAndComments } from "../claimExtractor.js";
import type { VerifierReport, VerifierReportEntry } from "../claimVerifier.js";
import {
  createBlogPost,
  updatePost,
  publishPost,
  getPostById,
} from "../blogEngine.js";

function makeReport(
  severity: VerifierReport["severity"],
  entries: VerifierReportEntry[],
): VerifierReport {
  return {
    severity,
    entries,
    summary: {
      laneAOk: 0, laneAFail: 0, laneAUnverifiable: 0,
      laneAPassQuotedCommentary: 0, laneAPassCritiqueByAbsence: 0,
      laneBOk: 0, laneBBare: entries.filter(e => e.classification === "LANE_B_BARE").length,
      retractedHits: 0, ncitePatternHits: 0,
    },
    modeExemptions: {
      authorVoice: 0, forwardProjection: 0, sectionHeader: 0, openerHook: 0,
      critiqueByAbsence: 0, preBranchFlagged: 0, postBranchFlagged: 0,
    },
  };
}

describe("manual publish-after-edit gating", () => {
  it("HARD_FAIL → blocked outcome with editor comments returned", () => {
    const report = makeReport("HARD_FAIL", [
      { sentenceIndex: 1, snippet: "Foo grew by 42% last quarter.", classification: "LANE_B_BARE", reason: "external numeric, no citation", suggestedFix: "add inline link" },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.manualPublishAllowed, false);
    assert.equal(out.manualReviewRequired, true);
    assert.equal(out.editorComments.length, 1);
    assert.equal(out.editorComments[0].action, "add_inline_citation");
  });

  it("SOFT_WARN → manual publish allowed; editor comments still surfaced", () => {
    const report = makeReport("SOFT_WARN", [
      { sentenceIndex: 0, snippet: "A bare 25% claim.", classification: "LANE_B_BARE", reason: "bare", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.manualPublishAllowed, true);
    assert.equal(out.manualReviewRequired, true);
    assert.equal(out.editorComments.length, 1);
  });

  it("PASS → publish allowed, no editor comments", () => {
    const report = makeReport("PASS", []);
    const out = extractClaimsAndComments("Clean body", report, []);
    assert.equal(out.manualPublishAllowed, true);
    assert.equal(out.manualReviewRequired, false);
    assert.equal(out.editorComments.length, 0);
  });

  it("BlogPost persists structured fields after revision (round-trip through updatePost)", () => {
    const report = makeReport("HARD_FAIL", [
      { sentenceIndex: 0, snippet: "Stat without a source 99%.", classification: "LANE_B_BARE", reason: "bare", suggestedFix: undefined },
    ]);
    const extraction = extractClaimsAndComments("Body.", report, []);

    const post = createBlogPost({
      title: "Round Trip",
      content: "Body.",
      source: "standalone",
      verifierReport: report,
      claims: extraction.claims,
      references: extraction.references,
      citationMap: extraction.citationMap,
      editorComments: extraction.editorComments,
      manualReviewRequired: extraction.manualReviewRequired,
      manualPublishAllowed: extraction.manualPublishAllowed,
      status: "quarantined",
    });
    assert.equal(post.editorComments?.length, 1);
    assert.equal(post.manualPublishAllowed, false);
    assert.equal(post.status, "quarantined");

    // Simulate the agent revising and re-running the verifier — verdict
    // becomes PASS.
    const cleanReport = makeReport("PASS", []);
    const cleanExtraction = extractClaimsAndComments("Cleaned body.", cleanReport, []);
    const updated = updatePost(post.id, {
      content: "Cleaned body.",
      verifierReport: cleanReport,
      claims: cleanExtraction.claims,
      references: cleanExtraction.references,
      citationMap: cleanExtraction.citationMap,
      editorComments: cleanExtraction.editorComments,
      manualReviewRequired: cleanExtraction.manualReviewRequired,
      manualPublishAllowed: cleanExtraction.manualPublishAllowed,
    });
    assert.ok(updated);
    assert.equal(updated!.editorComments?.length, 0);
    assert.equal(updated!.manualPublishAllowed, true);

    // Manual publish goes through.
    const published = publishPost(post.id);
    assert.ok(published);
    assert.equal(published!.status, "published");

    // Persistence holds across reloads.
    const reloaded = getPostById(post.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.status, "published");
    assert.equal(reloaded!.manualPublishAllowed, true);
  });
});
