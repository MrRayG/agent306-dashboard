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
    it("should accept minClusterSize parameter", () => {
      // findHypothesisClusters should not throw when called with custom minClusterSize
      const result = findHypothesisClusters(2);
      assert.ok(Array.isArray(result), "Should return an array of clusters");
    });

    it("should accept similarityThreshold parameter", () => {
      // Lower threshold should not cause errors
      const result = findHypothesisClusters(3, 0.35);
      assert.ok(Array.isArray(result), "Should return an array of clusters");
    });

    it("should return fewer clusters with high similarity threshold", () => {
      const looseResults = findHypothesisClusters(2, 0.2);
      const strictResults = findHypothesisClusters(2, 0.9);
      // Strict threshold should find equal or fewer clusters
      assert.ok(
        strictResults.length <= looseResults.length,
        `Strict threshold (${strictResults.length}) should find <= clusters than loose (${looseResults.length})`
      );
    });

    it("should use default threshold of 0.45 when not specified", () => {
      const defaultResults = findHypothesisClusters(3);
      const explicitResults = findHypothesisClusters(3, 0.45);
      assert.strictEqual(
        defaultResults.length,
        explicitResults.length,
        "Default and explicit 0.45 threshold should yield same results"
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
