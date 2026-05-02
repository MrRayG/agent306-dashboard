/**
 * Tests for server/claimExtractor.ts
 *
 * The extractor is purely deterministic and side-effect-free — it composes
 * structured claims, references, citationMap, and editor comments out of the
 * verifierReport produced by claimVerifier.verifyClaims(). These tests build
 * verifierReport fixtures by hand to keep the suite hermetic.
 *
 * Run: npx tsx --test server/__tests__/claimExtractor.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractClaimsAndComments } from "../claimExtractor.js";
import type { VerifierReport, VerifierReportEntry } from "../claimVerifier.js";

function makeReport(
  severity: VerifierReport["severity"],
  entries: VerifierReportEntry[],
): VerifierReport {
  return {
    severity,
    entries,
    summary: {
      laneAOk: entries.filter(e => e.classification === "LANE_A_OK").length,
      laneAFail: entries.filter(e => e.classification === "LANE_A_FAIL").length,
      laneAUnverifiable: entries.filter(e => e.classification === "LANE_A_UNVERIFIABLE").length,
      laneAPassQuotedCommentary: 0,
      laneAPassCritiqueByAbsence: 0,
      laneBOk: entries.filter(e => e.classification === "LANE_B_OK").length,
      laneBBare: entries.filter(e => e.classification === "LANE_B_BARE").length,
      retractedHits: entries.filter(e => e.classification === "RETRACTED_HIT").length,
      ncitePatternHits: entries.filter(e => e.classification === "NCITE_PATTERN_HIT").length,
    },
    modeExemptions: {
      authorVoice: 0, forwardProjection: 0, sectionHeader: 0, openerHook: 0,
      critiqueByAbsence: 0, preBranchFlagged: 0, postBranchFlagged: 0,
    },
  };
}

describe("claimExtractor.extractClaimsAndComments", () => {
  it("PASS report → no editor comments, manual review not required, manual publish allowed", () => {
    const report = makeReport("PASS", [
      { sentenceIndex: 0, snippet: "OpenAI launched o3 on December 20, 2024.", classification: "LANE_B_OK", reason: "cited", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("OpenAI launched o3.", report, []);
    assert.equal(out.editorComments.length, 0);
    assert.equal(out.manualReviewRequired, false);
    assert.equal(out.manualPublishAllowed, true);
    assert.equal(out.claims.length, 1);
  });

  it("LANE_B_BARE → editor comment with action=add_inline_citation; manualReviewRequired", () => {
    const report = makeReport("HARD_FAIL", [
      {
        sentenceIndex: 2,
        snippet: "GPT-4 has 1.76 trillion parameters in total.",
        classification: "LANE_B_BARE",
        reason: "external numeric claim with no citation",
        suggestedFix: "add inline markdown link to the source",
      },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.editorComments.length, 1);
    assert.equal(out.editorComments[0].action, "add_inline_citation");
    assert.equal(out.editorComments[0].suggestedFix, "add inline markdown link to the source");
    assert.equal(out.manualReviewRequired, true);
    assert.equal(out.manualPublishAllowed, false);
  });

  it("LANE_A_FAIL → action=rewrite_to_source; LANE_A_UNVERIFIABLE → human_review", () => {
    const report = makeReport("HARD_FAIL", [
      { sentenceIndex: 0, snippet: "The paper claims 92.6% accuracy.", classification: "LANE_A_FAIL", reason: "stat not in source", suggestedFix: undefined },
      { sentenceIndex: 1, snippet: "An additional bare claim.", classification: "LANE_A_UNVERIFIABLE", reason: "judge unreachable", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.editorComments.length, 2);
    assert.equal(out.editorComments[0].action, "rewrite_to_source");
    assert.equal(out.editorComments[1].action, "human_review");
  });

  it("RETRACTED_HIT → delete_sentence; NCITE_PATTERN_HIT → split_appositive", () => {
    const report = makeReport("HARD_FAIL", [
      { sentenceIndex: 4, snippet: "X was retracted but cited.", classification: "RETRACTED_HIT", reason: "retracted source", suggestedFix: undefined },
      { sentenceIndex: 5, snippet: "Acme, a research lab funded by Y, said …", classification: "NCITE_PATTERN_HIT", reason: "appositive", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.editorComments.find(c => c.sentenceIndex === 4)?.action, "delete_sentence");
    assert.equal(out.editorComments.find(c => c.sentenceIndex === 5)?.action, "split_appositive");
  });

  it("SOFT_WARN → manualPublishAllowed=true, manualReviewRequired=true", () => {
    const report = makeReport("SOFT_WARN", [
      { sentenceIndex: 0, snippet: "A bare claim 12% of the time.", classification: "LANE_B_BARE", reason: "bare", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.manualReviewRequired, true);
    assert.equal(out.manualPublishAllowed, true);
  });

  it("references + citationMap: deduped URL pool, sentenceIndex maps to ref indexes", () => {
    const report = makeReport("PASS", [
      { sentenceIndex: 0, snippet: "Per [Politico](https://politico.com/a) the bill passed.", classification: "LANE_B_OK", reason: "cited", suggestedFix: undefined },
      { sentenceIndex: 1, snippet: "See also [Politico](https://politico.com/a) on the vote.", classification: "LANE_B_OK", reason: "cited", suggestedFix: undefined },
      { sentenceIndex: 2, snippet: "[Reuters](https://reuters.com/x) reported the same.", classification: "LANE_B_OK", reason: "cited", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("…", report, [
      { url: "https://politico.com/a", publisher: "Politico" },
      { url: "https://reuters.com/x", publisher: "Reuters" },
    ]);
    assert.equal(out.references.length, 2);
    assert.equal(out.references[0].publisher, "Politico");
    // Sentences 0 and 1 share the same Politico URL → both map to ref 0.
    assert.deepEqual(out.citationMap[0], [0]);
    assert.deepEqual(out.citationMap[1], [0]);
    assert.deepEqual(out.citationMap[2], [1]);
  });

  it("uncited Lane A sentence: claim recorded with cited=false, no entry in citationMap", () => {
    const report = makeReport("HARD_FAIL", [
      { sentenceIndex: 7, snippet: "The model achieves 99% accuracy.", classification: "LANE_B_BARE", reason: "bare", suggestedFix: undefined },
    ]);
    const out = extractClaimsAndComments("…", report, []);
    assert.equal(out.claims[0].cited, false);
    assert.equal(out.citationMap[7], undefined);
  });
});
