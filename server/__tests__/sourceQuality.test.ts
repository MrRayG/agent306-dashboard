/**
 * Tests for server/sourceQuality.ts
 *
 * Pure deterministic classifier — no fixtures needed beyond inline
 * SourceObject literals. Covers the operator policy from the 2026-05-02
 * audit:
 *   - X/Twitter ≥ 10k followers → reputable/acceptable
 *   - X/Twitter < 10k followers → low_quality
 *   - X/Twitter no follower count → unverified (NOT silently high-quality)
 *   - REPUTABLE_DOMAINS allowlist → reputable
 *   - .gov / .edu fallback → reputable
 *   - Bare URL with no metadata, unknown domain → unverified
 *
 * Run: npx tsx --test server/__tests__/sourceQuality.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifySource,
  classifySourcePool,
  X_FOLLOWER_FLOOR,
} from "../sourceQuality.js";
import type { SourceObject } from "../sourceLocality.js";

describe("sourceQuality.classifySource", () => {
  it("REPUTABLE domain → reputable, no review needed", () => {
    const c = classifySource({ url: "https://www.nytimes.com/2026/05/01/example.html", title: "Example" });
    assert.equal(c.tier, "reputable");
    assert.equal(c.needsReview, false);
    assert.equal(c.blockedAsPrimary, false);
  });

  it(".gov fallback → reputable", () => {
    const c = classifySource({ url: "https://www.fda.gov/news/example" });
    assert.equal(c.tier, "reputable");
    assert.equal(c.needsReview, false);
  });

  it(".edu fallback → reputable", () => {
    const c = classifySource({ url: "https://hai.stanford.edu/news/ai-index-2025" });
    assert.equal(c.tier, "reputable");
  });

  it("X/Twitter URL with allowlist handle → reputable, no follower count needed", () => {
    const c = classifySource({ url: "https://x.com/sama/status/12345" });
    assert.equal(c.tier, "reputable");
    assert.equal(c.needsReview, false);
  });

  it("X/Twitter URL with followers >= 10k and verified=true → reputable", () => {
    const src = { url: "https://x.com/some_random/status/1", xFollowers: 50_000, xVerified: true } as SourceObject;
    const c = classifySource(src);
    assert.equal(c.tier, "reputable");
    assert.equal(c.needsReview, false);
  });

  it("X/Twitter URL with followers >= 10k but not verified → acceptable", () => {
    const src = { url: "https://twitter.com/random_handle/status/1", xFollowers: 25_000 } as SourceObject;
    const c = classifySource(src);
    assert.equal(c.tier, "acceptable");
    assert.equal(c.needsReview, false);
  });

  it("X/Twitter URL with followers < 10k → low_quality and needs review", () => {
    const src = { url: "https://x.com/tiny_account/status/1", xFollowers: 500 } as SourceObject;
    const c = classifySource(src);
    assert.equal(c.tier, "low_quality");
    assert.equal(c.needsReview, true);
    assert.equal(c.blockedAsPrimary, true);
    assert.ok(c.reasons.some(r => r.includes(`<${X_FOLLOWER_FLOOR}`)));
  });

  it("X/Twitter URL with NO follower count → unverified (not silently treated as high quality)", () => {
    const c = classifySource({ url: "https://x.com/unknown_handle/status/1" });
    assert.equal(c.tier, "unverified");
    assert.equal(c.needsReview, true);
    assert.equal(c.blockedAsPrimary, true);
    assert.ok(c.reasons.includes("x_follower_count_unknown"));
  });

  it("Empty URL → low_quality, blocked", () => {
    const c = classifySource({ url: "" });
    assert.equal(c.tier, "low_quality");
    assert.equal(c.blockedAsPrimary, true);
  });

  it("Unknown domain with no publisher and no title → unverified", () => {
    const c = classifySource({ url: "https://some-blog-that-no-one-knows.example.org/post/1" });
    assert.equal(c.tier, "unverified");
    assert.equal(c.blockedAsPrimary, true);
  });

  it("Unknown domain WITH publisher metadata → acceptable", () => {
    const c = classifySource({
      url: "https://niche-but-real.example.com/article/2025/foo",
      publisher: "Niche But Real Trade Journal",
      title: "Important Industry Report",
    });
    assert.equal(c.tier, "acceptable");
    assert.equal(c.needsReview, false);
  });

  it("malformed URL → falls through to no-publisher path → unverified or low_quality", () => {
    const c = classifySource({ url: "not a real url" });
    // Malformed URL: empty domain, falls through to no-publisher branch.
    // Either unverified or low_quality is acceptable — both signal don't trust.
    assert.ok(c.tier === "unverified" || c.tier === "low_quality");
    assert.equal(c.blockedAsPrimary, true);
  });
});

describe("sourceQuality.classifySourcePool", () => {
  it("Mixed pool → counts by tier, hasReputableSource respected", () => {
    const pool: SourceObject[] = [
      { url: "https://nytimes.com/foo", title: "Foo" },
      { url: "https://x.com/random/status/1" }, // unverified — no follower count
      { url: "https://x.com/tiny/status/2", xFollowers: 100 } as any, // low quality
    ];
    const report = classifySourcePool(pool);
    assert.equal(report.counts.reputable, 1);
    assert.equal(report.counts.unverified, 1);
    assert.equal(report.counts.low_quality, 1);
    assert.equal(report.hasReputableSource, true);
    assert.equal(report.allBelowAcceptable, false);
  });

  it("Pool with only unverified/low_quality → allBelowAcceptable", () => {
    const pool: SourceObject[] = [
      { url: "https://x.com/x/status/1" },
      { url: "https://x.com/y/status/2", xFollowers: 50 } as any,
    ];
    const report = classifySourcePool(pool);
    assert.equal(report.allBelowAcceptable, true);
    assert.equal(report.hasReputableSource, false);
  });

  it("Empty pool → allBelowAcceptable=false (vacuously), hasReputableSource=false", () => {
    const report = classifySourcePool([]);
    assert.equal(report.allBelowAcceptable, false);
    assert.equal(report.hasReputableSource, false);
    assert.equal(report.classifications.length, 0);
  });
});
