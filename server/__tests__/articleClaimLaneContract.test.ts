/**
 * Regression tests for the Article claim-lane contract (PR #272).
 *
 * The Bloom/arXiv Deep Read live-test surfaced two failure modes that
 * the persistence layer (#259/#266/#267/#270/#271) cannot fix —
 * persistence stores the right claim_map; the WRITER and REVISER
 * prompts have to obey the lanes:
 *
 *   - Lane B bare facts: Karpathy/Dec 2025, Stanford HAI 54.6%,
 *     2008 ambient display, 2030 projection, token cost drop —
 *     external claims with no inline citation.
 *   - Lane A over-attribution: "This is not a knock on the study",
 *     "The paper does not answer this", "minimum requirement for any
 *     system that wants to earn label coach" — agent analysis
 *     framed as if the source asserted it.
 *
 * The contract block in `articleClaimLaneContract.ts` is the single
 * source of truth. These tests are static-source greps that confirm
 * the block is included in the writer + reviser system prompts and
 * that the canonical failure-pattern language is present so the model
 * has explicit guidance on what NOT to do.
 *
 * Pure / hermetic — no LLM calls, no DB. Run:
 *   npx tsx --test server/__tests__/articleClaimLaneContract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_LANE_CONTRACT_MARKER,
  buildArticleClaimLaneContractBlock,
} from "../articleClaimLaneContract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("Article claim-lane contract block", () => {
  it("includes the stable marker and version", () => {
    const block = buildArticleClaimLaneContractBlock();
    assert.match(block, /ARTICLE_CLAIM_LANE_CONTRACT@v\d+/);
    assert.ok(block.includes(CLAIM_LANE_CONTRACT_MARKER));
  });

  it("describes the analysis lane (citation_requirement=forbidden) explicitly", () => {
    const block = buildArticleClaimLaneContractBlock();
    assert.match(block, /claim_type=analysis/);
    assert.match(block, /citation_requirement=forbidden/);
    // Boundary phrasing the writer is told to use when an analysis
    // sentence sits next to a source-supported sentence.
    assert.match(block, /My analysis, not a claim made by the paper/);
  });

  it("describes the factual_attributed lane (citation_requirement=required)", () => {
    const block = buildArticleClaimLaneContractBlock();
    assert.match(block, /claim_type=factual_attributed/);
    assert.match(block, /citation_requirement=required/);
    // The same-sentence locality rule must travel with the contract
    // so the writer doesn't have to re-derive it from the verifier
    // contract above.
    assert.match(block, /SAME sentence/);
  });

  it("hard-blocks the canonical Bloom/arXiv Lane B failure patterns by name", () => {
    const block = buildArticleClaimLaneContractBlock();
    // These are the EXACT external-fact templates the live Bloom/arXiv
    // article hard-failed on. The contract names them so the writer
    // model has explicit "don't do this" examples to lean on.
    assert.match(block, /Karpathy/);
    assert.match(block, /Stanford HAI/);
    assert.match(block, /2030/);
    assert.match(block, /token cost/i);
  });

  it("forbids inventing external facts not in the APPROVED CLAIM MAP", () => {
    const block = buildArticleClaimLaneContractBlock();
    assert.match(block, /APPROVED CLAIM MAP/);
    assert.match(block, /Do NOT inject external context/);
    // Never invent a citation, never staple primary URL onto an external fact.
    assert.match(block, /Never invent a citation/);
    assert.match(block, /Never staple the primary article URL/);
  });
});

describe("Article writer + reviser prompts include the claim-lane contract", () => {
  it("article writer source imports + injects buildArticleClaimLaneContractBlock", () => {
    const src = read("server/articleEngine.ts");
    assert.ok(
      src.includes('from "./articleClaimLaneContract.js"'),
      "articleEngine.ts must import from articleClaimLaneContract",
    );
    assert.ok(
      src.includes("buildArticleClaimLaneContractBlock()"),
      "articleEngine.ts must call buildArticleClaimLaneContractBlock()",
    );
  });

  it("article reviser source imports + injects buildArticleClaimLaneContractBlock", () => {
    const src = read("server/articleReviseLoop.ts");
    assert.ok(
      src.includes('from "./articleClaimLaneContract.js"'),
      "articleReviseLoop.ts must import from articleClaimLaneContract",
    );
    assert.ok(
      src.includes("buildArticleClaimLaneContractBlock()"),
      "articleReviseLoop.ts must call buildArticleClaimLaneContractBlock()",
    );
  });
});

describe("Article reviser repair contract — explicit Lane A/B rules", () => {
  // The reviser system prompt is built lazily inside an async LLM-calling
  // function; static-source greps are how we assert the prompt carries
  // the rules. Mirrors verifierContractInjection.test.ts.
  const src = read("server/articleReviseLoop.ts");

  it("Lane B repair: prefer remove over softening; never staple primary URL on unsupported fact", () => {
    // The reviser must be told that for LANE_B_BARE the FIRST repair
    // option is "remove the bare external fact entirely" when no
    // supporting URL exists — not "soften" and not "staple primary URL."
    assert.match(src, /REMOVE the bare external fact entirely/);
    assert.match(src, /Karpathy\/Stanford-HAI\/2030\/token-cost-style/);
    assert.match(src, /never staple the primary source's URL/i);
  });

  it("Lane A repair: rewrite as clearly-marked Agent 306 analysis with boundary phrase", () => {
    // Lane A failures must be repaired by EITHER (a) constraining the
    // sentence to what the source says or (b) converting to clearly-
    // marked agent analysis. The boundary phrase is required so the
    // reader can tell which sentences are 306's voice vs. the paper's.
    assert.match(src, /clearly-marked Agent 306 analysis/);
    assert.match(src, /My analysis, not a claim made by the paper/);
  });

  it("Lane A repair: normative requirements that aren't in the source can be marked-analysis", () => {
    // The "minimum requirement for any system that wants to earn label
    // coach" failure pattern is normative-requirement-shaped — the
    // reviser is explicitly told marked-analysis is the right move
    // there when the assertion is genuinely 306's view.
    assert.match(src, /normative requirement/i);
    assert.match(src, /must do Y to earn label/i);
  });
});
