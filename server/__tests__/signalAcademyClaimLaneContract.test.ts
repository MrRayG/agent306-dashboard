/**
 * Regression tests for the Signal + Academy claim-lane contract wiring
 * (2026-05-04, fix/signal-academy-claim-lane-contract).
 *
 * Mirrors the disciplined pattern shipped in PR #276 for News / The
 * Dispatch. Both Signal (Mon/Wed/Fri intelligence brief) and Academy
 * (Tue/Thu/Sat pedagogical post) carry heavy Agent 306 commentary on
 * top of a tiny (Signal: x_search snippets) or empty (Academy: internal
 * synthesis) source pool. Without the lane contract + ANALYSIS mode,
 * the next live run of either engine is at risk of the same Lane A
 * over-flag that quarantined News two days running on the Arbitrum DAO
 * frozen-ETH dispatch:
 *
 *   [ClaimVerifier] artifactMode=REPORT laneAFail=N
 *   [Engine] ClaimVerifier REJECTED ...: N unsupported claims
 *
 * The fix wires the shared cross-engine claim-lane contract (PR #273)
 * into both engines' generation prompts and switches `verifyClaims()`
 * to ANALYSIS mode for both tiers — same posture News + Article Deep
 * Read already use.
 *
 * Tests are static-source greps that confirm the contract is imported
 * and rendered for engine="signal" / engine="academy", that ANALYSIS
 * mode is set on every verifyClaims() call in those paths, that the
 * canonical lane-contract boundary phrases are recognized in
 * AUTHOR_VOICE_PATTERNS, and that observed-failure sentence shapes have
 * a clean Lane B rewrite path. Pure / hermetic — no LLM calls, no DB.
 *
 * Run: npx tsx --test server/__tests__/signalAcademyClaimLaneContract.test.ts
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

// ─── Signal-engine contract block ────────────────────────────────────────────
describe("Signal-engine claim-lane contract block", () => {
  it("renders a 'signal' engine framing with the shared marker", () => {
    const block = buildSharedClaimLaneContractBlock("signal");
    assert.match(block, /CLAIM_LANE_CONTRACT@v\d+/);
    assert.ok(block.includes(SHARED_CLAIM_LANE_CONTRACT_MARKER));
    // Engine-aware framing names the show + the source set so the writer
    // model knows the upstream signals feed is the Lane A pool.
    assert.match(block, /306 SIGNAL/);
    assert.match(block, /upstream signals-feed URL/);
  });

  it("carries Lane A / Lane B / Lane C definitions", () => {
    const block = buildSharedClaimLaneContractBlock("signal");
    assert.match(block, /LANE A/);
    assert.match(block, /LANE B/);
    assert.match(block, /LANE C/);
    assert.match(block, /SOURCE CLAIMS/);
    assert.match(block, /AGENT ANALYSIS/);
    assert.match(block, /EXTERNAL CONTEXT/);
  });

  it("carries the source-absence commentary rule + preferred Lane B rewrites", () => {
    const block = buildSharedClaimLaneContractBlock("signal");
    assert.match(block, /SOURCE-ABSENCE COMMENTARY/);
    assert.match(block, /the paper does not answer/);
    assert.match(block, /The open question is/);
    assert.match(block, /Agent 306's analysis/);
  });

  it("preserves Agent 306 voice — restricts attribution, does not flatten voice", () => {
    const block = buildSharedClaimLaneContractBlock("signal");
    assert.match(block, /Agent 306 voice is PRESERVED/);
  });
});

// ─── Academy-engine contract block ───────────────────────────────────────────
describe("Academy-engine claim-lane contract block", () => {
  it("renders an 'academy' engine framing with the shared marker", () => {
    const block = buildSharedClaimLaneContractBlock("academy");
    assert.match(block, /CLAIM_LANE_CONTRACT@v\d+/);
    assert.ok(block.includes(SHARED_CLAIM_LANE_CONTRACT_MARKER));
    // Engine-aware framing — names the show form so the writer grounds
    // the rule in Academy's pedagogical surface form.
    assert.match(block, /306 ACADEMY/);
    // Academy is internal-synthesis; the framing should reflect that the
    // primary URL slot is intentionally empty.
    assert.match(block, /no primary URL/i);
  });

  it("carries Lane A / Lane B / Lane C definitions", () => {
    const block = buildSharedClaimLaneContractBlock("academy");
    assert.match(block, /LANE A/);
    assert.match(block, /LANE B/);
    assert.match(block, /LANE C/);
    assert.match(block, /SOURCE CLAIMS/);
    assert.match(block, /AGENT ANALYSIS/);
    assert.match(block, /EXTERNAL CONTEXT/);
  });

  it("preserves Agent 306 voice — restricts attribution, does not flatten voice", () => {
    const block = buildSharedClaimLaneContractBlock("academy");
    assert.match(block, /Agent 306 voice is PRESERVED/);
  });
});

// ─── Signal engine wiring ────────────────────────────────────────────────────
describe("Signal engine (server/signalBriefEngine.ts) — contract + ANALYSIS wiring", () => {
  const src = read("server/signalBriefEngine.ts");

  it("imports buildSharedClaimLaneContractBlock from claimLaneContract", () => {
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "signalBriefEngine.ts must import from claimLaneContract.js",
    );
    assert.ok(
      src.includes("buildSharedClaimLaneContractBlock"),
      "signalBriefEngine.ts must reference buildSharedClaimLaneContractBlock",
    );
  });

  it("renders the shared block with engine='signal'", () => {
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("signal")'),
      'signalBriefEngine.ts must call buildSharedClaimLaneContractBlock("signal")',
    );
  });

  it("verifyClaims uses tier:'signal' and artifactMode:'ANALYSIS'", () => {
    const m = src.match(/verifyClaims\(\{[\s\S]*?\}\)/);
    assert.ok(m, "could not locate the verifyClaims block in signalBriefEngine.ts");
    assert.match(m![0], /tier:\s*"signal"/);
    assert.match(m![0], /artifactMode:\s*"ANALYSIS"/);
  });

  it("preserves verifier hard-fail behavior (HARD_FAIL still rejects + quarantines)", () => {
    // The fix only widens the analytical-commentary exemption set; it
    // must NOT remove the hard-fail rejection path. Look for the
    // canonical "REJECTED signal brief" log line that fires when the
    // verifier returns HARD_FAIL.
    assert.match(src, /verdict\.severity\s*===\s*"HARD_FAIL"/);
    assert.match(src, /REJECTED signal brief/);
    // The HARD_FAIL branch must still return null (signal is not
    // posted) — otherwise we'd be loosening publish gates.
    const hardFailBranch = src.match(/HARD_FAIL[\s\S]*?return null;/);
    assert.ok(
      hardFailBranch,
      "HARD_FAIL branch must still return null so the brief is not posted",
    );
  });
});

// ─── Academy engine wiring ───────────────────────────────────────────────────
describe("Academy engine (server/academyEngine.ts) — contract + ANALYSIS wiring", () => {
  const src = read("server/academyEngine.ts");

  it("imports buildSharedClaimLaneContractBlock from claimLaneContract", () => {
    assert.ok(
      src.includes('from "./claimLaneContract.js"'),
      "academyEngine.ts must import from claimLaneContract.js",
    );
    assert.ok(
      src.includes("buildSharedClaimLaneContractBlock"),
      "academyEngine.ts must reference buildSharedClaimLaneContractBlock",
    );
  });

  it("renders the shared block with engine='academy'", () => {
    assert.ok(
      src.includes('buildSharedClaimLaneContractBlock("academy")'),
      'academyEngine.ts must call buildSharedClaimLaneContractBlock("academy")',
    );
  });

  it("verifyClaims uses tier:'academy' and artifactMode:'ANALYSIS'", () => {
    const m = src.match(/verifyClaims\(\{[\s\S]*?\}\)/);
    assert.ok(m, "could not locate the verifyClaims block in academyEngine.ts");
    assert.match(m![0], /tier:\s*"academy"/);
    assert.match(m![0], /artifactMode:\s*"ANALYSIS"/);
  });

  it("preserves verifier hard-fail behavior (HARD_FAIL still rejects, no queue, advances rotation)", () => {
    // The fix must NOT change the hard-fail handling: when the verifier
    // returns HARD_FAIL, Academy must (a) log the rejection, (b) NOT
    // queue the post, and (c) advance the rotation pointer so a retry
    // doesn't re-pick the failing topic. All three behaviors remain.
    assert.match(src, /verdict\.severity\s*===\s*"HARD_FAIL"/);
    assert.match(src, /REJECTED academy/);
    // Still advances rotation so a retry picks a different topic.
    const hardFailBranch = src.match(/REJECTED academy[\s\S]*?return;/);
    assert.ok(
      hardFailBranch,
      "HARD_FAIL branch must still return without queuing a post",
    );
    assert.match(hardFailBranch![0], /currentTopicIndex\+\+/);
  });
});

// ─── Author-voice handshake ──────────────────────────────────────────────────
describe("Lane-contract boundary phrases are recognized as ANALYSIS author voice (Signal + Academy)", () => {
  // The contract pushes the writer toward explicit Lane B boundary phrases.
  // For the verifier exemption to actually fire on a writer that obeys
  // the contract, ANALYSIS-mode AUTHOR_VOICE_PATTERNS must include each
  // phrase. This is the prompt-side ↔ verifier-side handshake — same set
  // News uses (PR #276), tested here so a future drift in
  // AUTHOR_VOICE_PATTERNS doesn't silently break Signal / Academy.

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
      const sentence = `${phrase} this signal points to a real shift in agentic infrastructure.`;
      assert.equal(
        hasAuthorVoice(sentence),
        true,
        `hasAuthorVoice should match '${phrase}'`,
      );
    }
  });
});

// ─── Generic-failure-pattern guard for both engines ──────────────────────────
describe("Signal / Academy — analytical commentary has a Lane B rewrite path", () => {
  // The observed generic failure pattern across News (and the next-run
  // risk for Signal / Academy) is: analytical commentary, opinion, or an
  // open question gets quarantined as Lane A drift because the noun /
  // verb shape ("claims", "shows", "argues") matches the strict
  // attribution gate even though the sentence is clearly Agent 306's
  // analysis. The contract's preferred-rewrite phrasing pushes the
  // writer to mark these explicitly as Lane B.

  it("Signal-style forward-projection commentary lifts cleanly into ANALYSIS author voice", () => {
    // Original: a Signal-shaped POV sentence using the attribution-noun
    // "claims" and a forward-projection ("once you open the door").
    const original =
      "Once you open the door to autonomous AI signing transactions, the surface area for new attack claims explodes.";
    const rewrittenAsAnalysis =
      "Agent 306's analysis: once you open the door to autonomous AI signing transactions, the surface area for new attack claims is the variable to watch.";
    const rewrittenAsOpenQuestion =
      "The open question is whether autonomous AI signing transactions widens the attack surface faster than the audit tooling matures.";
    assert.equal(hasAuthorVoice(rewrittenAsAnalysis), true);
    assert.equal(hasAuthorVoice(rewrittenAsOpenQuestion), true);
    assert.equal(
      hasAuthorVoice(original),
      false,
      "the un-marked original should not accidentally pass author-voice — the contract must drive the rewrite",
    );
  });

  it("Academy-style pedagogical synthesis lifts cleanly into ANALYSIS author voice", () => {
    // Academy is internal-synthesis. A teaching sentence that READS as
    // attribution ("the research shows") should be re-marked as Lane B
    // — Academy has no source pool, so any factual attribution must
    // either resolve to a Lane C ledger source or be reframed as Agent
    // 306's analysis.
    const original =
      "The research shows that inference cost dropped 99% in two years and the curve is still bending.";
    const rewrittenAsAnalysis =
      "Agent 306's analysis: inference cost has been falling fast enough that previously impossible use cases are now economically viable.";
    const rewrittenAsCaveat =
      "Agent 306's caveat: the inference-cost curve is real but the precise numbers depend on which model and which provider you measure.";
    assert.equal(hasAuthorVoice(rewrittenAsAnalysis), true);
    assert.equal(hasAuthorVoice(rewrittenAsCaveat), true);
    assert.equal(
      hasAuthorVoice(original),
      false,
      "the un-marked original should not accidentally pass author-voice — the contract must drive the rewrite",
    );
  });

  it("the contract names the preferred Lane B rewrites for these patterns (signal)", () => {
    const block = buildSharedClaimLaneContractBlock("signal");
    assert.match(block, /My read —/);
    assert.match(block, /Agent 306's analysis/);
    assert.match(block, /The open question is/);
  });

  it("the contract names the preferred Lane B rewrites for these patterns (academy)", () => {
    const block = buildSharedClaimLaneContractBlock("academy");
    assert.match(block, /My read —/);
    assert.match(block, /Agent 306's analysis/);
    assert.match(block, /The open question is/);
  });
});
