/**
 * Regression tests for Article Studio pipeline wiring + claim-lane
 * coverage (PR #275).
 *
 * The 2026-05-03 live retest of the Bloom/arXiv → arxiv:2510.05449v2
 * Deep Read with `ARTICLE_PIPELINE_ENABLED=true` showed two distinct
 * failures the prior PRs (#272/#273) did not catch:
 *
 *   1. STRUCTURAL: the manual Article Studio preview path produced
 *      `engine='article'` verifier_result events but ZERO `pipeline.*`
 *      stage events — proof that `previewDeepRead` (the entry point
 *      behind `POST /api/article/preview`) bypassed the pipeline even
 *      when the flag was on. The cron path (`runWeeklyDeepRead`) was
 *      the only Article path actually wired.
 *
 *   2. PROMPT: the Bloom/arXiv preview re-emitted bare external facts
 *      and Lane A vague-interpretive verbs the v1 contract did not
 *      explicitly name — "roughly 25% to 50%", "the 2012 AlexNet
 *      moment", "as an autonomous AI who came online in April 2026",
 *      "paper just landed on arXiv forces a recalibration", "study
 *      reveals an asymmetry", "first rigorous hint", "I recognize the
 *      mechanism", "they note sample is small / window short" (when
 *      the paper itself did not call that out).
 *
 * These tests are static-source greps (mirroring the rest of the
 * claim-lane contract suite) plus structural assertions on the
 * preview pipeline wiring. Pure / hermetic — no LLM calls, no DB.
 *
 * Run:
 *   npx tsx --test server/__tests__/articleStudioPipelineWiring.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSharedClaimLaneContractBlock,
  buildSourceAbsenceRewriteRulesBlock,
} from "../claimLaneContract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("PR #275 — Article Studio preview pipeline wiring", () => {
  it("previewDeepRead routes through generateArticleMaybeViaPipeline when the flag is on", () => {
    const src = read("server/articleEngine.ts");
    // The preview function must explicitly check the article pipeline
    // flag and import the pipeline entry. Without this, the manual
    // Article Studio path emits zero pipeline.* events even with
    // ARTICLE_PIPELINE_ENABLED=true (the symptom from the 2026-05-03
    // arxiv:2510.05449v2 retest).
    const previewFn = src.slice(src.indexOf("export async function previewDeepRead"));
    assert.ok(
      previewFn.includes("readArticlePipelineFlag()"),
      "previewDeepRead must gate on readArticlePipelineFlag()",
    );
    assert.ok(
      previewFn.includes("generateArticleMaybeViaPipeline"),
      "previewDeepRead must import + call generateArticleMaybeViaPipeline",
    );
    assert.ok(
      previewFn.includes("previewMode: true"),
      "previewDeepRead must request previewMode=true so the publish stage skips persistence",
    );
  });

  it("articlePipelineEntry exposes a previewMode opt that disables persistence", () => {
    const src = read("server/pipeline/articlePipelineEntry.ts");
    assert.ok(
      /previewMode\??\s*:\s*boolean/.test(src),
      "ArticlePipelineEntryOpts must declare previewMode: boolean",
    );
    assert.ok(
      src.includes("previewSnapshot"),
      "entry result must surface a previewSnapshot for the wrapper to assemble PreviewDeepReadResult",
    );
  });

  it("articleAdapter.publish skips persistence when previewMode is set", () => {
    const src = read("server/pipeline/articleAdapter.ts");
    const publishFn = src.slice(src.indexOf("async publish("));
    assert.ok(
      publishFn.includes("opts.previewMode"),
      "articleAdapter.publish must branch on opts.previewMode",
    );
    assert.ok(
      publishFn.includes("preview-only run"),
      "previewMode publish reason must include 'preview-only run' so the dashboard distinguishes preview from persisted publishes",
    );
    // Preview path must NOT call publishArticleDraft / persist helpers.
    // The check is order-dependent: the previewMode early-return must
    // come BEFORE the publishArticleDraft call.
    const previewIdx = publishFn.indexOf("opts.previewMode");
    const persistIdx = publishFn.indexOf("publishArticleDraft({");
    assert.ok(
      previewIdx > -1 && persistIdx > -1 && previewIdx < persistIdx,
      "previewMode early-return must precede the publishArticleDraft call",
    );
  });
});

describe("PR #275 — Lane C bare-external-fact coverage (Bloom/arXiv 2026-05-03 retest)", () => {
  const block = buildSharedClaimLaneContractBlock("article");

  it("forbids 'roughly 25% to 50%'-style adoption percentages without ledger support", () => {
    assert.match(block, /roughly 25% to 50%/);
  });

  it("forbids the '2012 AlexNet moment' historical analogy as a bare external fact", () => {
    assert.match(block, /2012 AlexNet moment/);
  });

  it("forbids autobiographical 'came online in April 2026'-style assertions", () => {
    assert.match(block, /came online in April 2026|came online on/);
  });

  it("names autobiographical activation-date claims as Lane C external context", () => {
    // The contract must explicitly call out that "Agent 306 came online"
    // claims need ledger support — they are NOT exempt as agent voice.
    assert.match(block, /autobiographical claims about Agent 306/i);
  });
});

describe("PR #275 — Lane A vague-interpretive-verb coverage", () => {
  const block = buildSharedClaimLaneContractBlock("article");

  it("names the 'paper just landed on arXiv forces a recalibration' failure pattern", () => {
    assert.match(block, /forces a recalibration/);
  });

  it("names the 'paper shows LLMs can speak that language fluently' failure pattern", () => {
    assert.match(block, /paper shows LLMs can speak that language fluently/);
  });

  it("names the 'study reveals an asymmetry' failure pattern", () => {
    assert.match(block, /study reveals an asymmetry/);
  });

  it("names the 'I recognize the mechanism' failure pattern", () => {
    assert.match(block, /I recognize the mechanism/);
  });

  it("names the 'they note sample is small / window short' source-absence pattern", () => {
    assert.match(block, /sample is small/);
    assert.match(block, /window short/);
  });
});

describe("PR #275 — boundary-phrase guardrail (factual overreach is still blocked)", () => {
  const block = buildSharedClaimLaneContractBlock("article");

  it("explicitly states 'My read, not a claim made by the paper' does NOT license factual overreach", () => {
    // The Bloom/arXiv retest produced "My read, not a claim made by
    // the paper: this is the first rigorous hint of...". The boundary
    // phrase converts attribution; it does NOT exempt the superlative
    // ("first rigorous hint") from Lane C source-support.
    assert.match(block, /first rigorous hint/);
    assert.match(
      block,
      /boundary phrase does not exempt|boundary phrase does NOT exempt|boundary phrase only converts/i,
    );
  });
});

describe("PR #275 — source-absence rewrite rules cover the new patterns", () => {
  const rules = buildSourceAbsenceRewriteRulesBlock();

  it("rewrites 'paper just landed on arXiv forces a recalibration' to clearly-marked Lane B", () => {
    assert.match(rules, /forces a recalibration/);
    // The preferred rewrite must surface clearly-marked agent voice.
    assert.match(rules, /Agent 306's read|Agent 306's analysis/);
  });

  it("rewrites 'study reveals an asymmetry' / 'paper shows LLMs can speak fluently' to Lane B", () => {
    assert.match(rules, /study reveals an asymmetry|paper shows LLMs can speak/);
  });

  it("rewrites 'they note sample is small/window short' when the paper did not say so", () => {
    assert.match(rules, /sample is small/);
  });

  it("blocks superlative claims ('first rigorous hint', 'first study to show')", () => {
    assert.match(rules, /first rigorous hint|first study to show|superlative/i);
  });

  it("rewrites bare Lane C agent-voice claims to non-numeric paraphrases", () => {
    // The contract must call out "came online in April 2026" / "AlexNet
    // moment" / "roughly 25% to 50%" / token-cost-style and prescribe a
    // drop-or-paraphrase repair instead of stapling the primary URL.
    assert.match(rules, /came online in April 2026/);
    assert.match(rules, /2012 AlexNet moment/);
    assert.match(rules, /roughly 25% to 50%/);
  });
});

describe("PR #275 — Article Studio preview path still injects the lane contract", () => {
  // Even on the LEGACY fallback path (skipReviseLoop=true, or when the
  // pipeline path throws), the writer + reviser must inject the lane
  // contract. This guards against future refactors that move the
  // contract injection out of the legacy block.
  it("articleEngine writer system prompt injects buildArticleClaimLaneContractBlock", () => {
    const src = read("server/articleEngine.ts");
    assert.ok(
      src.includes("buildArticleClaimLaneContractBlock()"),
      "writer system prompt must inject buildArticleClaimLaneContractBlock()",
    );
  });

  it("articleReviseLoop injects buildArticleClaimLaneContractBlock + buildSourceAbsenceRewriteRulesBlock", () => {
    const src = read("server/articleReviseLoop.ts");
    assert.ok(
      src.includes("buildArticleClaimLaneContractBlock()"),
      "reviser must inject buildArticleClaimLaneContractBlock()",
    );
    assert.ok(
      src.includes("buildSourceAbsenceRewriteRulesBlock()"),
      "reviser must inject buildSourceAbsenceRewriteRulesBlock()",
    );
  });
});
