/**
 * Tests for the PR #253 voice-tier change in server/claimVerifier.ts.
 *
 * Blogs were previously in STRICT_TIERS, which meant Lane B bare claims
 * thresholded into HARD_FAIL the same way as articles and research papers.
 * Ray's call: blogs are 306's voice — observation, narrative, opinion, NOT
 * footnoted long-form. Strict-tier verifier behavior was wrong for this
 * content type.
 *
 * Post-PR-253:
 *   • tier="blog" → Lane B bare soft-warns (no quarantine via verifier)
 *   • tier="article" → Lane B bare still hard-fails at the strict thresholds
 *   • tier="research" → Lane B bare still hard-fails at the strict thresholds
 *
 * Lane A failures, RETRACTED hits, NCITE patterns, and LANE_A_UNVERIFIABLE
 * remain hard-fail for every tier — those are bright-line wrong regardless
 * of voice vs. essay.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.blog.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyClaims, STRICT_TIERS } from "../claimVerifier.js";

const SOURCE_TEXT =
  "DHS officials showed lawmakers how jailbroken AI models can produce dangerous guidance. " +
  "The briefing prompted questions about safeguards.";

const baseOpts = {
  sourceText: SOURCE_TEXT,
  sourceUrl: "https://example.com/source",
  sourceTitle: "AI safeguards briefing",
  skipLLM: true,
};

// Three bare Lane B sentences — under STRICT_TIERS this would be HARD_FAIL.
const THREE_BARE = "This matters beyond the hearing. Frontier models changed in 2025. Adoption accelerated in 2026. Regulators moved faster in 2024.";

// One Lane B sentence with two numeric markers — under STRICT_TIERS this is HARD_FAIL too.
const ONE_BARE_TWO_NUMERIC = "This matters beyond the hearing. One benchmark moved from 40% in 2024 to 80% in 2026.";

describe("claimVerifier — blog tier is no longer strict (PR #253)", () => {
  it("STRICT_TIERS does NOT include 'blog'", () => {
    assert.equal(STRICT_TIERS.has("blog"), false);
  });

  it("STRICT_TIERS still includes 'article' and 'research'", () => {
    assert.equal(STRICT_TIERS.has("article"), true);
    assert.equal(STRICT_TIERS.has("research"), true);
  });

  it("blog tier soft-warns on three bare Lane B sentences", async () => {
    const verdict = await verifyClaims({
      ...baseOpts,
      draftText: THREE_BARE,
      tier: "blog",
    });
    assert.equal(verdict.severity, "SOFT_WARN");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifierReport.summary.laneBBare, 3);
  });

  it("blog tier soft-warns on one bare Lane B sentence with two numeric markers", async () => {
    const verdict = await verifyClaims({
      ...baseOpts,
      draftText: ONE_BARE_TWO_NUMERIC,
      tier: "blog",
    });
    assert.equal(verdict.severity, "SOFT_WARN");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifierReport.summary.laneBBare, 1);
  });

  it("article tier still HARD_FAILS on three bare Lane B sentences", async () => {
    const verdict = await verifyClaims({
      ...baseOpts,
      draftText: THREE_BARE,
      tier: "article",
    });
    assert.equal(verdict.severity, "HARD_FAIL");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verifierReport.summary.laneBBare, 3);
  });

  it("research tier still HARD_FAILS on one bare Lane B sentence with two numeric markers", async () => {
    const verdict = await verifyClaims({
      ...baseOpts,
      draftText: ONE_BARE_TWO_NUMERIC,
      tier: "research",
    });
    assert.equal(verdict.severity, "HARD_FAIL");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.verifierReport.summary.laneBBare, 1);
  });
});

describe("claimVerifier — blog tier still hard-fails on bright-line failures", () => {
  it("blog tier still HARD_FAILS when a sentence carries a fabricated quote", async () => {
    // The quoted span is not in SOURCE_TEXT — Lane A fabricated quote → HARD_FAIL.
    const verdict = await verifyClaims({
      ...baseOpts,
      draftText: 'According to the briefing, DHS said "we have eliminated all jailbreaks across every model."',
      tier: "blog",
    });
    assert.equal(verdict.severity, "HARD_FAIL");
    assert.equal(verdict.ok, false);
    // At least one Lane A failure recorded.
    assert.ok(verdict.verifierReport.summary.laneAFail >= 1);
  });
});
