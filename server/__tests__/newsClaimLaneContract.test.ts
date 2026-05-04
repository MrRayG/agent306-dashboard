/**
 * Regression tests for the News / Dispatch claim-lane contract wiring
 * (2026-05-04, fix/news-claim-lane-contract).
 *
 * 306 News failed to post two days in a row when analytical commentary on
 * the Arbitrum DAO frozen-ETH story tripped the claim verifier as
 * unsupported Lane A drift. The verifier was over-flagging sentences like
 * "If the DAO chooses to recognize these claims, it creates precedent…"
 * because the verb "claims" matched the strict REPORT-mode attribution
 * gate even though the sentence is clearly 306's analysis.
 *
 * The fix wires the shared cross-engine claim-lane contract (PR #273)
 * into the three News / Dispatch entry points (auto-dispatch in
 * server/routes.ts, manual generator in server/newsGenerator.ts, the
 * weekly serialized Dispatch in server/dispatchEngine.ts) and switches
 * the verifier to ANALYSIS mode for these tiers — same posture Article
 * Deep Read already uses (server/articleEngine.ts:1171).
 *
 * Tests are static-source greps that confirm the contract is imported
 * and rendered for engine="news", that ANALYSIS mode is set on every
 * verifyClaims() call in the News path, and that the canonical
 * Bloom/arXiv-style failure-pattern language is carried through to the
 * news engine framing. Pure / hermetic — no LLM calls, no DB.
 *
 * Run: npx tsx --test server/__tests__/newsClaimLaneContract.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SHARED_CLAIM_LANE_CONTRACT_MARKER,
  buildSharedClaimLaneContractBlock,
} from "../claimLaneContract.js";
import { AUTHOR_VOICE_PATTERNS, hasAuthorVoice } from "../artifactMode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("News-engine claim-lane contract block", () => {
  it("renders a 'news' engine framing with the shared marker", () => {
    const block = buildSharedClaimLaneContractBlock("news");
    assert.match(block, /CLAIM_LANE_CONTRACT@v\d+/);
    assert.ok(block.includes(SHARED_CLAIM_LANE_CONTRACT_MARKER));
    // Engine-aware framing — names News / The Dispatch and headline-pack
    // URL so the writer model knows which source set is in scope.
    assert.match(block, /306 News \/ The Dispatch/);
    assert.match(block, /headline-pack URL/);
  });

  it("carries Lane A / Lane B / Lane C definitions", () => {
    const block = buildSharedClaimLaneContractBlock("news");
    assert.match(block, /LANE A/);
    assert.match(block, /LANE B/);
    assert.match(block, /LANE C/);
    assert.match(block, /SOURCE CLAIMS/);
    assert.match(block, /AGENT ANALYSIS/);
    assert.match(block, /EXTERNAL CONTEXT/);
  });

  it("carries the source-absence commentary rule + preferred Lane B rewrites", () => {
    const block = buildSharedClaimLaneContractBlock("news");
    assert.match(block, /SOURCE-ABSENCE COMMENTARY/);
    assert.match(block, /the paper does not answer/);
    assert.match(block, /The open question is/);
    assert.match(block, /Agent 306's analysis/);
  });

  it("preserves Agent 306 voice — restricts attribution, does not flatten voice", () => {
    const block = buildSharedClaimLaneContractBlock("news");
    assert.match(block, /Agent 306 voice is PRESERVED/);
  });
});

describe("News auto-dispatch (server/routes.ts) — contract + ANALYSIS wiring", () => {
  const src = read("server/routes.ts");

  it("imports buildSharedClaimLaneContractBlock from claimLaneContract", () => {
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "routes.ts must import from claimLaneContract.js",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock'),
      "routes.ts must reference buildSharedClaimLaneContractBlock",
    );
  });

  it("renders the shared block with engine='news'", () => {
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("news")'),
      "routes.ts must call buildSharedClaimLaneContractBlock(\"news\") in the auto-dispatch path",
    );
  });

  it("News tier verifyClaims runs in ANALYSIS mode (server/routes.ts auto-dispatch)", () => {
    // Find the verifyClaims call that uses tier:"news" in the auto-dispatch
    // path and confirm artifactMode:"ANALYSIS" travels with it.
    const m = src.match(
      /verifyClaims\(\{[\s\S]*?sourceTitle:\s*`306 NEWS Dispatch[\s\S]*?\}\)/,
    );
    assert.ok(m, "could not locate the 306 NEWS Dispatch verifyClaims block");
    assert.match(m![0], /tier:\s*"news"/);
    assert.match(m![0], /artifactMode:\s*"ANALYSIS"/);
  });
});

describe("News manual generator (server/newsGenerator.ts) — contract + ANALYSIS wiring", () => {
  const src = read("server/newsGenerator.ts");

  it("imports + renders the shared block with engine='news'", () => {
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "newsGenerator.ts must import from claimLaneContract.js",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("news")'),
      "newsGenerator.ts must call buildSharedClaimLaneContractBlock(\"news\")",
    );
  });

  it("verifyClaims uses tier:'news' and artifactMode:'ANALYSIS'", () => {
    const m = src.match(/verifyClaims\(\{[\s\S]*?\}\)/);
    assert.ok(m, "could not locate the verifyClaims block in newsGenerator.ts");
    assert.match(m![0], /tier:\s*"news"/);
    assert.match(m![0], /artifactMode:\s*"ANALYSIS"/);
  });
});

describe("Dispatch engine (server/dispatchEngine.ts) — contract + ANALYSIS wiring", () => {
  const src = read("server/dispatchEngine.ts");

  it("imports + renders the shared block with engine='news'", () => {
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "dispatchEngine.ts must import from claimLaneContract.js",
    );
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("news")'),
      "dispatchEngine.ts must call buildSharedClaimLaneContractBlock(\"news\")",
    );
  });

  it("verifyClaims uses tier:'dispatch' and artifactMode:'ANALYSIS'", () => {
    const m = src.match(/verifyClaims\(\{[\s\S]*?\}\)/);
    assert.ok(m, "could not locate the verifyClaims block in dispatchEngine.ts");
    assert.match(m![0], /tier:\s*"dispatch"/);
    assert.match(m![0], /artifactMode:\s*"ANALYSIS"/);
  });
});

describe("Lane-contract boundary phrases are recognized as ANALYSIS author voice", () => {
  // The contract pushes the writer toward explicit Lane B boundary phrases.
  // For the verifier exemption to actually fire on a writer that obeys the
  // contract, ANALYSIS-mode AUTHOR_VOICE_PATTERNS must include each phrase.
  // This is the prompt-side ↔ verifier-side handshake.

  const REQUIRED_BOUNDARY_PHRASES = [
    "agent 306's analysis",
    "agent 306's read",
    "agent 306's caveat",
    "the open question is",
    "my read,",
    "my read —",
    "my read:",
  ];

  it("AUTHOR_VOICE_PATTERNS includes every contract-pushed boundary phrase", () => {
    for (const phrase of REQUIRED_BOUNDARY_PHRASES) {
      assert.ok(
        AUTHOR_VOICE_PATTERNS.includes(phrase),
        `AUTHOR_VOICE_PATTERNS must include lane-contract boundary phrase '${phrase}'`,
      );
    }
  });

  it("hasAuthorVoice matches each boundary phrase in a sentence", () => {
    for (const phrase of REQUIRED_BOUNDARY_PHRASES) {
      const sentence = `${phrase} the precedent question is genuinely open here.`;
      assert.equal(
        hasAuthorVoice(sentence),
        true,
        `hasAuthorVoice should match '${phrase}'`,
      );
    }
  });
});

describe("Arbitrum DAO frozen-ETH regression — observed unsupported claims have a contract path", () => {
  // The 2026-05-04 production failure log shows three sentences quarantined
  // as "Not mentioned in source text":
  //
  //   1. "If the DAO chooses to recognize these claims, it creates
  //      precedent that frozen crypto can serve restitution."
  //   2. "Once you open the door to reallocating user funds based on
  //      external legal claims, where does it stop?"
  //   3. "Every future exploit could invite competing claims, lobbying,
  //      and forum warfare that slow down recovery and erode the
  //      principle that code and consensus, not legacy litigation,
  //      should govern."
  //
  // All three are clearly Agent 306's analytical commentary on a chosen
  // signal — Lane B in the contract's vocabulary. The verifier flagged
  // them as Lane A drift because the noun "claims" matched the
  // attribution-verb gate. The contract's preferred-rewrite rules push
  // the writer to mark these with an explicit Lane B boundary phrase
  // ("My read —", "Agent 306's analysis:", "The open question is —"),
  // which AUTHOR_VOICE_PATTERNS now recognizes in ANALYSIS mode.

  it("the contract names the preferred Lane B rewrites for these patterns", () => {
    const block = buildSharedClaimLaneContractBlock("news");
    assert.match(block, /My read —/);
    assert.match(block, /Agent 306's analysis/);
    assert.match(block, /The open question is/);
  });

  it("rewriting one of the failing sentences with a boundary phrase is exempted", () => {
    // Original failing sentence (paraphrased) without the boundary phrase
    // would still match the "claims" attribution verb.
    const original =
      "Once you open the door to reallocating user funds based on external legal claims, where does it stop?";
    // Adding the contract's preferred Lane B boundary phrase lifts the
    // sentence into ANALYSIS author-voice territory.
    const rewrittenAsAnalysis =
      "Agent 306's analysis: once you open the door to reallocating user funds based on external legal claims, the slope is real.";
    const rewrittenAsOpenQuestion =
      "The open question is whether reallocating user funds based on external legal claims sets a precedent the DAO can contain.";
    assert.equal(
      hasAuthorVoice(rewrittenAsAnalysis),
      true,
      "boundary phrase 'Agent 306's analysis' should mark the rewrite as author voice",
    );
    assert.equal(
      hasAuthorVoice(rewrittenAsOpenQuestion),
      true,
      "boundary phrase 'The open question is' should mark the rewrite as author voice",
    );
    // Sanity: the un-marked original is NOT auto-matched by author voice.
    assert.equal(
      hasAuthorVoice(original),
      false,
      "the un-marked original should not accidentally pass author-voice — the contract must drive the rewrite",
    );
  });
});
