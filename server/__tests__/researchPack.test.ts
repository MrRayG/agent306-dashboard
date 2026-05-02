/**
 * Tests for server/researchPack.ts
 *
 * The research pack is the shared pre-draft layer every engine can call.
 * It composes a SourceQualityReport from the input pool, applies an
 * engine-specific policy, and emits gate flags + KB-friendly references.
 *
 * Run: npx tsx --test server/__tests__/researchPack.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildResearchPack, packToReferences, DEFAULT_POLICY } from "../researchPack.js";
import type { SourceObject } from "../sourceLocality.js";

describe("researchPack.buildResearchPack — long-form engines (blog/article/deep_read)", () => {
  it("blog engine with reputable source → manualReviewRequired=false", () => {
    const pack = buildResearchPack("blog", [
      { url: "https://nytimes.com/2026/05/01/example", title: "Example" },
    ]);
    assert.equal(pack.engine, "blog");
    assert.equal(pack.manualReviewRequired, false);
    assert.equal(pack.manualPublishAllowed, true);
    assert.equal(pack.qualityReport.counts.reputable, 1);
    assert.equal(pack.references.length, 1);
    assert.equal(pack.references[0].qualityTier, "reputable");
    assert.equal(pack.references[0].pulledBy, "blog");
  });

  it("article engine with empty pool → manualReviewRequired=true (long-form needs sources)", () => {
    const pack = buildResearchPack("article", []);
    assert.equal(pack.manualReviewRequired, true);
  });

  it("deep_read engine with only unverified X source → manualReviewRequired=true", () => {
    const pack = buildResearchPack("deep_read", [
      { url: "https://x.com/unknown_handle/status/1" }, // unverified by our gate
    ]);
    assert.equal(pack.qualityReport.counts.unverified, 1);
    assert.equal(pack.manualReviewRequired, true);
    // Pool has 1 unverified, 0 low_quality — manualPublishAllowed remains true,
    // but the engine should still escalate via manualReviewRequired.
  });

  it("blog engine with low-follower X source → manualPublishAllowed=false", () => {
    const pack = buildResearchPack("blog", [
      { url: "https://x.com/tiny/status/1", xFollowers: 200 } as SourceObject,
    ]);
    assert.equal(pack.qualityReport.counts.low_quality, 1);
    assert.equal(pack.manualPublishAllowed, false);
    assert.equal(pack.manualReviewRequired, true);
  });

  it("blog engine with mixed reputable + low-quality → still publishable, but flagged", () => {
    const pack = buildResearchPack("blog", [
      { url: "https://nytimes.com/foo" },
      { url: "https://x.com/tiny/status/1", xFollowers: 200 } as SourceObject,
    ]);
    // Has at least one reputable source → minTier=acceptable is met.
    assert.equal(pack.manualReviewRequired, false);
    assert.equal(pack.manualPublishAllowed, true);
  });
});

describe("researchPack.buildResearchPack — internal-synthesis engines (academy/dispatch/news/signal)", () => {
  it("academy with empty pool → does NOT trip the gate (allowEmptyPool=true)", () => {
    const pack = buildResearchPack("academy", []);
    assert.equal(pack.manualReviewRequired, false);
    assert.equal(pack.manualPublishAllowed, true);
  });

  it("news with empty pool → does NOT trip the gate", () => {
    const pack = buildResearchPack("news", []);
    assert.equal(pack.manualReviewRequired, false);
  });

  it("dispatch with empty pool → does NOT trip the gate", () => {
    const pack = buildResearchPack("dispatch", []);
    assert.equal(pack.manualReviewRequired, false);
  });

  it("signal with empty pool → does NOT trip the gate", () => {
    const pack = buildResearchPack("signal", []);
    assert.equal(pack.manualReviewRequired, false);
  });

  it("academy with ONLY low-quality sources → tripping the gate (sources are present so policy applies)", () => {
    const pack = buildResearchPack("academy", [
      { url: "https://x.com/tiny/status/1", xFollowers: 200 } as SourceObject,
    ]);
    assert.equal(pack.manualPublishAllowed, false);
    // Academy minTier is unverified — low_quality is below that → manualReviewRequired
    assert.equal(pack.manualReviewRequired, true);
  });
});

describe("researchPack.buildResearchPack — references and dedup", () => {
  it("Dedupes by URL", () => {
    const pack = buildResearchPack("blog", [
      { url: "https://nytimes.com/foo", title: "T1" },
      { url: "https://nytimes.com/foo", title: "T2" },
    ]);
    assert.equal(pack.sourcePool.length, 1);
    assert.equal(pack.references.length, 1);
  });

  it("packToReferences produces Blog/Article-shaped reference list", () => {
    const pack = buildResearchPack("blog", [
      { url: "https://nytimes.com/foo", title: "Title", publisher: "NYT" },
    ]);
    const refs = packToReferences(pack);
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0], { url: "https://nytimes.com/foo", title: "Title", publisher: "NYT" });
  });

  it("References preserve qualityTier per source for cross-engine KB filtering", () => {
    const pack = buildResearchPack("blog", [
      { url: "https://nytimes.com/foo" },
      { url: "https://niche.example.com/x", publisher: "Niche" },
    ]);
    assert.equal(pack.references[0].qualityTier, "reputable");
    assert.equal(pack.references[1].qualityTier, "acceptable");
    assert.equal(pack.references[0].pulledBy, "blog");
  });
});

describe("researchPack.buildResearchPack — policy override", () => {
  it("Custom policy can relax minTier for an engine", () => {
    // Force blog to accept unverified pool by overriding minTier.
    const pack = buildResearchPack(
      "blog",
      [{ url: "https://x.com/unknown/status/1" }],
      { policy: { minTier: "unverified" } },
    );
    assert.equal(pack.manualReviewRequired, false);
  });
});

describe("researchPack — engine name vocabulary parity", () => {
  it("Has policy entries for every engine the audit covers", () => {
    const engines = ["blog", "article", "deep_read", "academy", "dispatch", "news", "signal"] as const;
    for (const e of engines) {
      assert.ok(DEFAULT_POLICY[e], `missing default policy for engine=${e}`);
    }
  });
});
