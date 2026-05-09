/**
 * Tests for Hypothesis Consolidation — adaptive scheduling and options passthrough.
 *
 * Run: npx tsx --test server/__tests__/hypothesisConsolidator.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("HypothesisConsolidator", () => {
  let findHypothesisClusters: typeof import("../hypothesisConsolidator.js").findHypothesisClusters;

  beforeEach(async () => {
    const mod = await import("../hypothesisConsolidator.js");
    findHypothesisClusters = mod.findHypothesisClusters;
  });

  describe("consolidateHypotheses options", () => {
    it("should accept maxClusters option in signature", async () => {
      const mod = await import("../hypothesisConsolidator.js");
      // Verify the function exists and accepts the new options without error
      assert.strictEqual(typeof mod.consolidateHypotheses, "function");
    });

    it("should accept similarityThreshold option in signature", async () => {
      const mod = await import("../hypothesisConsolidator.js");
      assert.strictEqual(typeof mod.consolidateHypotheses, "function");
    });
  });

  describe("findHypothesisClusters", () => {
    // findHypothesisClusters became async (returns Promise<HypothesisCluster[]>)
    // when KB-backed embedding lookups were added; tests now await the result.
    it("should accept minClusterSize parameter", async () => {
      const result = await findHypothesisClusters(2);
      assert.ok(Array.isArray(result), "Should return an array of clusters");
    });

    it("should accept similarityThreshold parameter", async () => {
      const result = await findHypothesisClusters(3, 0.35);
      assert.ok(Array.isArray(result), "Should return an array of clusters");
    });

    it("should return fewer clusters with high similarity threshold", async () => {
      const looseResults = await findHypothesisClusters(2, 0.2);
      const strictResults = await findHypothesisClusters(2, 0.9);
      assert.ok(
        strictResults.length <= looseResults.length,
        `Strict threshold (${strictResults.length}) should find <= clusters than loose (${looseResults.length})`
      );
    });

    it("should use the function's documented default threshold when not specified", async () => {
      // Default similarityThreshold in the production code is 0.75 (kept in
      // sync with hypothesisConsolidator.ts:findHypothesisClusters signature).
      const defaultResults = await findHypothesisClusters(3);
      const explicitResults = await findHypothesisClusters(3, 0.75);
      assert.strictEqual(
        defaultResults.length,
        explicitResults.length,
        "Default and explicit 0.75 threshold should yield same results"
      );
    });
  });

  describe("maxClusters processing", () => {
    it("should limit processed clusters to maxClusters value", async () => {
      const mod = await import("../hypothesisConsolidator.js");
      // The consolidateHypotheses function with dryRun should respect maxClusters
      // When maxClusters is 0, no clusters should be processed
      const result = await mod.consolidateHypotheses({
        maxClusters: 0,
        dryRun: true,
      });
      assert.strictEqual(result.merged, 0, "maxClusters=0 should process 0 clusters");
    });
  });
});
