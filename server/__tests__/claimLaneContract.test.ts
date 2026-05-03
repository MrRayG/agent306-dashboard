/**
 * Tests for the shared cross-engine claim-lane contract (PR #273).
 *
 * The Bloom/arXiv Deep Read live-test surfaced a residual failure mode
 * after PR #272: source-absence commentary like "the paper does not
 * answer whether these mindset shifts persist..." reads as a Lane A
 * claim about the source's omissions but the source itself does not
 * say it omitted that — the verifier flags it as Lane A drift.
 *
 * This PR generalizes the per-engine Article contract into a shared
 * three-lane contract (Lane A / Lane B / Lane C) plus a source-absence
 * commentary rewrite rule and wires it into Article + Blog + Manuscript
 * writer/reviser prompts. These tests are static-source greps (mirroring
 * `verifierContractInjection.test.ts` and `articleClaimLaneContract.test.ts`)
 * that confirm the block is included in each engine's prompt source and
 * that the canonical failure-pattern language is present so the model
 * has explicit guidance.
 *
 * Pure / hermetic — no LLM calls, no DB. Run:
 *   npx tsx --test server/__tests__/claimLaneContract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARED_CLAIM_LANE_CONTRACT_MARKER,
  buildSharedClaimLaneContractBlock,
  buildSourceAbsenceRewriteRulesBlock,
} from "../claimLaneContract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("Shared claim-lane contract — block content", () => {
  it("carries the stable cross-engine marker and version", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /CLAIM_LANE_CONTRACT@v\d+/);
    assert.ok(block.includes(SHARED_CLAIM_LANE_CONTRACT_MARKER));
  });

  it("describes Lane A — source claims (factual_attributed, citation required)", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /LANE A/);
    assert.match(block, /SOURCE CLAIMS/);
    assert.match(block, /claim_type=factual_attributed/);
    assert.match(block, /citation_requirement=required/);
    assert.match(block, /SAME sentence/);
  });

  it("describes Lane B — agent analysis (analysis, citation forbidden)", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /LANE B/);
    assert.match(block, /AGENT ANALYSIS/);
    assert.match(block, /claim_type=analysis/);
    assert.match(block, /citation_requirement=forbidden/);
    assert.match(block, /Agent 306's analysis/);
  });

  it("describes Lane C — external context (factual_external, citation required)", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /LANE C/);
    assert.match(block, /EXTERNAL CONTEXT/);
    assert.match(block, /claim_type=factual_external/);
    // Lane C requires its own ledger source — staple-rejection language
    // names the canonical Bloom/arXiv-style failure patterns.
    assert.match(block, /Karpathy/);
    assert.match(block, /Stanford HAI/);
    assert.match(block, /2030/);
    assert.match(block, /token cost/i);
  });

  it("forbids inventing external facts not in the APPROVED CLAIM MAP", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /APPROVED CLAIM MAP/);
    assert.match(block, /Do NOT inject external context/);
    assert.match(block, /Never invent a citation/);
  });

  it("includes the source-absence commentary rule and preferred rewrites", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /SOURCE-ABSENCE COMMENTARY/);
    // Forbidden phrasings that read as Lane A drift.
    assert.match(block, /the paper does not answer/);
    assert.match(block, /the source does not say/);
    assert.match(block, /the study fails to prove/);
    // Preferred Lane-B/Lane-C rewrites the writer should reach for.
    assert.match(block, /The open question is/);
    assert.match(block, /A future study would need to show/);
    assert.match(block, /Agent 306's analysis is/);
  });

  it("permits source-acknowledged limitations as legitimate Lane A", () => {
    // If the source itself acknowledges the gap (e.g. "future work should
    // examine X") the writer MAY assert it — that is a real Lane A claim.
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /the source explicitly acknowledges its own limitation/i);
  });

  it("renders engine-aware framing (article / blog / manuscript)", () => {
    const a = buildSharedClaimLaneContractBlock("article");
    const b = buildSharedClaimLaneContractBlock("blog");
    const m = buildSharedClaimLaneContractBlock("manuscript");
    assert.match(a, /Article \(Deep Read\)/);
    assert.match(b, /Blog post/);
    assert.match(m, /Research manuscript/);
    // The Article engine specifically uses "primary article URL" so the
    // legacy regression test continues to pass.
    assert.match(a, /Never staple the primary article URL/);
  });

  it("preserves voice — does not flatten the lane rule into a citation policy", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /Agent 306 voice is PRESERVED/);
  });
});

describe("Source-absence rewrite rules block", () => {
  it("maps the canonical forbidden phrasings to preferred Lane-B rewrites", () => {
    const block = buildSourceAbsenceRewriteRulesBlock();
    assert.match(block, /SOURCE-ABSENCE REPAIR RULES/);
    // Bloom/arXiv regression — the residual failure pattern after #272.
    assert.match(block, /the paper does not answer X.*The open question is X/s);
    assert.match(block, /the source does not say Y.*Agent 306's analysis: Y/s);
    assert.match(block, /the study fails to prove Z.*future study/i);
    assert.match(block, /the authors never address W.*unresolved question/i);
  });

  it("permits source-acknowledged limitations as a legitimate Lane A path", () => {
    const block = buildSourceAbsenceRewriteRulesBlock();
    assert.match(block, /source ITSELF acknowledges/);
  });
});

describe("Article writer + reviser prompts include the shared lane contract", () => {
  it("article writer source still injects the Article-specific block (preserves @v1 marker)", () => {
    const src = read("server/articleEngine.ts");
    assert.ok(src.includes("buildArticleClaimLaneContractBlock()"));
  });

  it("article reviser source injects both the Article block and source-absence rules", () => {
    const src = read("server/articleReviseLoop.ts");
    assert.ok(src.includes("buildArticleClaimLaneContractBlock()"));
    assert.ok(
      src.includes("buildSourceAbsenceRewriteRulesBlock()"),
      "articleReviseLoop must call buildSourceAbsenceRewriteRulesBlock() for source-absence repairs",
    );
  });

  it("article-specific block delegates to the shared cross-engine block", () => {
    const src = read("server/articleClaimLaneContract.ts");
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "articleClaimLaneContract.ts must import from the shared module",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("article")'),
      "articleClaimLaneContract.ts must render the shared block with engine='article'",
    );
  });
});

describe("Blog writer + reviser prompts include the shared lane contract", () => {
  it("blog writer imports + injects buildSharedClaimLaneContractBlock", () => {
    const src = read("server/blogEngine.ts");
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "blogEngine.ts must import from claimLaneContract",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("blog")'),
      "blogEngine.ts must call buildSharedClaimLaneContractBlock with engine='blog'",
    );
  });

  it("blog reviser imports + injects shared contract and source-absence rules", () => {
    const src = read("server/blogReviseLoop.ts");
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "blogReviseLoop.ts must import from claimLaneContract",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("blog")'),
      "blogReviseLoop.ts must call buildSharedClaimLaneContractBlock with engine='blog'",
    );
    assert.ok(
      src.includes("buildSourceAbsenceRewriteRulesBlock()"),
      "blogReviseLoop.ts must call buildSourceAbsenceRewriteRulesBlock()",
    );
  });
});

describe("Manuscript writer (research Phase 7) includes the shared lane contract", () => {
  it("researchEngine imports + injects buildSharedClaimLaneContractBlock for manuscript", () => {
    const src = read("server/researchEngine.ts");
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "researchEngine.ts must import from claimLaneContract",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("manuscript")'),
      "researchEngine.ts must call buildSharedClaimLaneContractBlock with engine='manuscript'",
    );
  });
});

describe("Bloom/arXiv regression — source-absence pattern coverage", () => {
  // The remaining failure after #272 was an Article reviser sentence:
  //   "Agent 306's analysis: the paper does not answer whether these
  //    mindset shifts persist after the novelty fades or whether they
  //    eventually translate into larger activity gains at the six-month
  //    mark."
  // The verifier failed it because the source text does not mention
  // 'Agent 306' or 'six-month / persistence analysis'. The rewrite the
  // contract pushes for stays inside Lane B: "The open question is
  // whether these mindset shifts persist..." — no negative attribution.

  it("contract names the Bloom-style 'paper does not answer' failure verbatim", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /the paper does not answer whether X/);
  });

  it("contract pushes 'The open question is...' as the preferred Lane B rewrite", () => {
    const block = buildSharedClaimLaneContractBlock("article");
    assert.match(block, /The open question is/);
  });

  it("source-absence rules map 'paper does not answer X' → 'The open question is X'", () => {
    const rules = buildSourceAbsenceRewriteRulesBlock();
    assert.match(rules, /the paper does not answer X.*The open question is X/s);
  });
});
