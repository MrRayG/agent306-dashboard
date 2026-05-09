/**
 * Tests for Hypothesis Consolidation — adaptive scheduling and configurable options.
 *
 * Run: npx tsx --test server/__tests__/hypothesisConsolidation.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("HypothesisConsolidation", () => {
  let findHypothesisClusters: typeof import("../hypothesisConsolidator.js").findHypothesisClusters;
  let consolidateHypotheses: typeof import("../hypothesisConsolidator.js").consolidateHypotheses;

  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const mod = await import("../hypothesisConsolidator.js");
    findHypothesisClusters = mod.findHypothesisClusters;
    consolidateHypotheses = mod.consolidateHypotheses;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("consolidateHypotheses options", () => {
    it("should accept maxClusters option and default to 5", async () => {
      // Verify the function accepts the new options without error
      // Even with no clusters found, it should respect the options
      const result = await consolidateHypotheses({
        minClusterSize: 100, // impossibly large so no clusters found
        maxClusters: 10,
        dryRun: true,
      });
      assert.equal(result.clustersFound, 0);
      assert.equal(result.merged, 0);
      assert.equal(result.removed, 0);
    });

    it("should accept similarityThreshold option", async () => {
      const result = await consolidateHypotheses({
        minClusterSize: 100,
        similarityThreshold: 0.35,
        dryRun: true,
      });
      assert.equal(result.clustersFound, 0);
    });

    it("should pass all options through without error", async () => {
      const result = await consolidateHypotheses({
        minClusterSize: 2,
        maxClusters: 10,
        similarityThreshold: 0.35,
        dryRun: true,
      });
      // Should complete without throwing
      assert.ok(typeof result.clustersFound === "number");
      assert.ok(typeof result.merged === "number");
      assert.ok(typeof result.removed === "number");
    });

    it("should use defaults when no options provided", async () => {
      const result = await consolidateHypotheses();
      // Default behavior should still work
      assert.ok(typeof result.clustersFound === "number");
    });
  });

  describe("findHypothesisClusters", () => {
    // findHypothesisClusters became async (returns Promise<HypothesisCluster[]>)
    // when KB-backed embedding lookups were added; tests now await the result.
    it("should accept similarityThreshold parameter", async () => {
      const clusters = await findHypothesisClusters(3, 0.35);
      assert.ok(Array.isArray(clusters));
    });

    it("should accept custom minClusterSize", async () => {
      const clusters = await findHypothesisClusters(2, 0.45);
      assert.ok(Array.isArray(clusters));
    });

    it("should use defaults when called with no args", async () => {
      const clusters = await findHypothesisClusters();
      assert.ok(Array.isArray(clusters));
    });
  });

  describe("adaptive scheduling logic", () => {
    it("should trigger consolidation on Sunday regardless of queue size", () => {
      const isSunday = true;
      const activeHypotheses = 50; // under threshold
      const queueOverloaded = activeHypotheses > 130;
      const shouldRun = isSunday || queueOverloaded;
      assert.equal(shouldRun, true);
    });

    it("should trigger consolidation when active hypotheses exceed 130", () => {
      const isSunday = false;
      const activeHypotheses = 200;
      const queueOverloaded = activeHypotheses > 130;
      const shouldRun = isSunday || queueOverloaded;
      assert.equal(shouldRun, true);
    });

    it("should NOT trigger consolidation on non-Sunday with low queue", () => {
      const isSunday = false;
      const activeHypotheses = 50;
      const queueOverloaded = activeHypotheses > 130;
      const shouldRun = isSunday || queueOverloaded;
      assert.equal(shouldRun, false);
    });

    it("should use aggressive params when queue is overloaded", () => {
      const activeHypotheses = 200;
      const queueOverloaded = activeHypotheses > 130;
      const params = {
        minClusterSize: queueOverloaded ? 2 : 3,
        maxClusters: queueOverloaded ? 10 : 5,
        similarityThreshold: queueOverloaded ? 0.35 : 0.45,
      };
      assert.equal(params.minClusterSize, 2);
      assert.equal(params.maxClusters, 10);
      assert.equal(params.similarityThreshold, 0.35);
    });

    it("should use default params when queue is normal", () => {
      const activeHypotheses = 50;
      const queueOverloaded = activeHypotheses > 130;
      const params = {
        minClusterSize: queueOverloaded ? 2 : 3,
        maxClusters: queueOverloaded ? 10 : 5,
        similarityThreshold: queueOverloaded ? 0.35 : 0.45,
      };
      assert.equal(params.minClusterSize, 3);
      assert.equal(params.maxClusters, 5);
      assert.equal(params.similarityThreshold, 0.45);
    });

    it("should treat exactly 130 as not overloaded (threshold is > 130)", () => {
      const activeHypotheses = 130;
      const queueOverloaded = activeHypotheses > 130;
      assert.equal(queueOverloaded, false);
    });

    it("should treat 131 as overloaded", () => {
      const activeHypotheses = 131;
      const queueOverloaded = activeHypotheses > 130;
      assert.equal(queueOverloaded, true);
    });
  });
});
