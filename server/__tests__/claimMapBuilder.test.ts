/**
 * Tests for server/claimMapBuilder.ts (Roadmap A2). Pure deterministic
 * derivation of a claim map from references / source pool — no DB, no LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildClaimMap } from "../claimMapBuilder.js";

describe("claimMapBuilder (Roadmap A2)", () => {
  it("emits one analysis placeholder + one factual_attributed item per reference", () => {
    const out = buildClaimMap({
      engine: "blog",
      draftId: "blog_1",
      topic: "AI safety",
      references: [
        {
          refId: "r1",
          url: "https://example.com/a",
          title: "A",
          publisher: "Pub A",
          qualityTier: "reputable",
          pulledBy: "blog",
          attachedAt: new Date().toISOString(),
          evidenceExcerpt: "GPT-5 launched on 2025-09-12.",
        },
        {
          refId: "r2",
          url: "https://example.com/b",
          title: "B",
          publisher: "Pub B",
          qualityTier: "acceptable",
          pulledBy: "blog",
          attachedAt: new Date().toISOString(),
        },
      ],
    });
    assert.equal(out.items.length, 3); // 1 analysis + 2 references
    assert.equal(out.items[0].claimType, "analysis");
    assert.equal(out.items[0].citationRequirement, "forbidden");
    assert.deepEqual(out.items[0].sourceSupport, []);

    assert.equal(out.items[1].claimType, "factual_attributed");
    assert.equal(out.items[1].citationRequirement, "required");
    assert.deepEqual(out.items[1].sourceSupport, ["https://example.com/a"]);
    assert.equal(out.items[1].confidence, 0.8);

    assert.equal(out.items[2].confidence, 0.6);
  });

  it("dedupes URLs across references and source pool, references first", () => {
    const out = buildClaimMap({
      engine: "article",
      draftId: "article_1",
      topic: "T",
      references: [
        {
          refId: "r1",
          url: "https://example.com/a",
          qualityTier: "reputable",
          pulledBy: "article",
          attachedAt: new Date().toISOString(),
        },
      ],
      sourcePool: [
        // duplicate of references[0] — must not produce a second item
        {
          url: "https://example.com/a",
          retrievedAt: new Date().toISOString(),
          sourceId: "https://example.com/a",
        },
        {
          url: "https://example.com/c",
          retrievedAt: new Date().toISOString(),
          sourceId: "https://example.com/c",
        },
      ],
    });
    const factualSupports = out.items
      .filter(i => i.claimType === "factual_attributed")
      .map(i => i.sourceSupport);
    assert.deepEqual(factualSupports, [
      ["https://example.com/a"],
      ["https://example.com/c"],
    ]);
  });

  it("low_quality references map to high risk + low confidence", () => {
    const out = buildClaimMap({
      engine: "blog",
      draftId: "blog_lq",
      topic: "T",
      references: [
        {
          refId: "r-lq",
          url: "https://example.com/lq",
          qualityTier: "low_quality",
          pulledBy: "blog",
          attachedAt: new Date().toISOString(),
        },
      ],
    });
    const factual = out.items.find(i => i.claimType === "factual_attributed")!;
    assert.equal(factual.risk, "high");
    assert.equal(factual.confidence, 0.3);
  });

  it("returns just the analysis placeholder when no references or sources are provided", () => {
    const out = buildClaimMap({
      engine: "blog",
      draftId: "blog_empty",
      topic: "T",
    });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].claimType, "analysis");
  });
});
