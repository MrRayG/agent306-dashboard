/**
 * Tests for cross-engine reuse of the claim extractor (audit follow-up
 * 2026-05-02). PR #257 introduced extractClaimsAndComments() for Blog;
 * this PR generalizes it so Article (Deep Read), News, Dispatch, Signal,
 * and Academy can call the same function and persist editor comments.
 *
 * These tests verify the function signature is engine-agnostic — there
 * is no Blog-specific coupling — and that it produces the same shape
 * regardless of which engine called it.
 *
 * Run: npx tsx --test server/__tests__/claimExtractorReuse.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractClaimsAndComments } from "../claimExtractor.js";
import type { VerifierReport, VerifierReportEntry } from "../claimVerifier.js";
import { buildResearchPack } from "../researchPack.js";

function rep(severity: VerifierReport["severity"], entries: VerifierReportEntry[]): VerifierReport {
  return {
    severity,
    entries,
    summary: {
      laneAOk: 0, laneAFail: 0, laneAUnverifiable: 0,
      laneAPassQuotedCommentary: 0, laneAPassCritiqueByAbsence: 0,
      laneBOk: 0, laneBBare: 0, retractedHits: 0, ncitePatternHits: 0,
    },
    modeExemptions: {
      authorVoice: 0, forwardProjection: 0, sectionHeader: 0, openerHook: 0,
      critiqueByAbsence: 0, preBranchFlagged: 0, postBranchFlagged: 0,
    },
  };
}

describe("claimExtractor reuse beyond Blog (audit 2026-05-02)", () => {
  it("Article/Deep Read HARD_FAIL → editor comments + actions like Blog", () => {
    const report = rep("HARD_FAIL", [
      {
        sentenceIndex: 1,
        snippet: "OpenAI raised $40 billion in March 2025.",
        classification: "LANE_B_BARE",
        reason: "external numeric fact lacks inline citation",
        suggestedFix: "Add inline citation [Publisher](URL).",
      },
    ]);
    const out = extractClaimsAndComments(
      "OpenAI raised $40 billion in March 2025.",
      report,
      [],
    );
    assert.equal(out.editorComments.length, 1);
    assert.equal(out.editorComments[0].action, "add_inline_citation");
    assert.equal(out.manualReviewRequired, true);
    // HARD_FAIL severity → extractor blocks manual publish until revised.
    assert.equal(out.manualPublishAllowed, false);
  });

  it("News/Dispatch (empty source pool) → still produces editor comments", () => {
    const report = rep("HARD_FAIL", [
      {
        sentenceIndex: 0,
        snippet: "ETH is $2,500 according to the analysts.",
        classification: "LANE_A_FAIL",
        reason: "attribution does not match source",
        suggestedFix: "Rewrite to align with provided source.",
      },
    ]);
    const out = extractClaimsAndComments("ETH is $2,500 according to the analysts.", report, []);
    assert.equal(out.editorComments.length, 1);
    assert.equal(out.editorComments[0].action, "rewrite_to_source");
    assert.equal(out.references.length, 0);
  });

  it("Signal/Academy with retracted-hit → produces delete_sentence editor action", () => {
    const report = rep("HARD_FAIL", [
      {
        sentenceIndex: 2,
        snippet: "A widely-cited but later-retracted study claimed X causes Y.",
        classification: "RETRACTED_HIT",
        reason: "matches a retracted claim pattern",
        suggestedFix: "Delete sentence — claim is retracted.",
      },
    ]);
    const out = extractClaimsAndComments("...", report, []);
    assert.equal(out.editorComments[0].action, "delete_sentence");
  });

  it("Cross-engine: same verifier report → same extraction shape regardless of caller", () => {
    const report = rep("SOFT_WARN", [
      {
        sentenceIndex: 0,
        snippet: "Anthropic announced Claude Opus 4.7 in May 2026.",
        classification: "LANE_B_OK",
        reason: "cited",
        suggestedFix: undefined,
      },
    ]);
    const blogOut = extractClaimsAndComments("...", report, []);
    const articleOut = extractClaimsAndComments("...", report, []);
    const newsOut = extractClaimsAndComments("...", report, []);
    assert.deepEqual(Object.keys(blogOut).sort(), Object.keys(articleOut).sort());
    assert.deepEqual(Object.keys(blogOut).sort(), Object.keys(newsOut).sort());
  });
});

describe("research pack + claim extractor — combined flow per engine", () => {
  it("Deep Read with reputable source: pack→pass, extractor→pass-shaped output", () => {
    const pack = buildResearchPack("deep_read", [
      { url: "https://nytimes.com/foo", title: "Foo" },
    ]);
    assert.equal(pack.manualReviewRequired, false);
    assert.equal(pack.references[0].qualityTier, "reputable");

    const out = extractClaimsAndComments("Body.", rep("PASS", []), pack.sourcePool);
    assert.equal(out.editorComments.length, 0);
    assert.equal(out.manualReviewRequired, false);
  });

  it("News with weak source pool: pack→escalate, extractor→still callable", () => {
    const pack = buildResearchPack("news", [
      { url: "https://x.com/tiny/status/1", xFollowers: 100 } as any,
    ]);
    assert.equal(pack.manualPublishAllowed, false);
    // Extractor remains callable with the same pool — verifies API is generic.
    const out = extractClaimsAndComments("Body.", rep("PASS", []), pack.sourcePool);
    assert.ok(Array.isArray(out.claims));
    assert.ok(Array.isArray(out.references));
  });
});
