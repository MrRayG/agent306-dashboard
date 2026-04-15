/**
 * Tests for cross-system wiring enhancements.
 *
 * Run: npx tsx --test server/__tests__/wiringEnhancements.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Enhancement 1: Entity-Level Hypothesis Dedup ─────────────────────────────

describe("extractEntitiesFromClaim", () => {
  it("extracts capitalized entity names from text", async () => {
    const { extractEntitiesFromClaim } = await import("../researchEngine.js");
    const entities = extractEntitiesFromClaim("OpenAI released GPT-5 as a rival to Google DeepMind");
    assert.ok(entities.includes("OpenAI"));
    assert.ok(entities.includes("Google DeepMind"));
  });

  it("skips common stop words", async () => {
    const { extractEntitiesFromClaim } = await import("../researchEngine.js");
    const entities = extractEntitiesFromClaim("The company And Also This But Not that");
    assert.ok(!entities.includes("The"));
    assert.ok(!entities.includes("And"));
    assert.ok(!entities.includes("Also"));
    assert.ok(!entities.includes("This"));
    assert.ok(!entities.includes("But"));
    assert.ok(!entities.includes("Not"));
  });
});

describe("Entity dedup in addHypothesis", () => {
  it("deduplicates hypothesis with >60% entity overlap and >0.3 keyword similarity", async () => {
    const {
      addHypothesis,
      getResearchLab,
      saveResearchLab,
    } = await import("../researchEngine.js");

    // Seed a hypothesis with known entities
    const lab = getResearchLab();
    const existingHyp = {
      id: "hyp_test_entity_dedup",
      claim: "OpenAI GPT-5 scaling research shows diminishing returns for reasoning tasks",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      status: "forming" as const,
      confidence: "medium" as const,
      formedAt: new Date().toISOString(),
      trustScore: 5,
    };

    // Inject existing hypothesis directly
    const existingIdx = lab.hypotheses.findIndex(h => h.id === "hyp_test_entity_dedup");
    if (existingIdx >= 0) {
      lab.hypotheses[existingIdx] = existingHyp;
    } else {
      lab.hypotheses.unshift(existingHyp);
    }
    saveResearchLab(lab);

    // Add a hypothesis with overlapping entities (OpenAI, GPT-5) and similar keywords
    const result = addHypothesis({
      claim: "OpenAI GPT-5 scaling laws suggest reasoning performance plateaus",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      confidence: "medium",
    });

    // Should return the existing hypothesis (deduped), not create a new one
    assert.equal(result.id, "hyp_test_entity_dedup");
    // Trust score should have been bumped
    assert.ok((result.trustScore ?? 0) >= 5.5, `trustScore should be >= 5.5, got ${result.trustScore}`);

    // Cleanup
    const labAfter = getResearchLab();
    labAfter.hypotheses = labAfter.hypotheses.filter(h => h.id !== "hyp_test_entity_dedup");
    saveResearchLab(labAfter);
  });

  it("creates hypothesis normally when entity overlap is low", async () => {
    const {
      addHypothesis,
      getResearchLab,
      saveResearchLab,
    } = await import("../researchEngine.js");

    // Seed an existing hypothesis
    const lab = getResearchLab();
    const existingHyp = {
      id: "hyp_test_no_dedup",
      claim: "Tesla autonomous driving safety metrics improve quarterly",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      status: "forming" as const,
      confidence: "medium" as const,
      formedAt: new Date().toISOString(),
      trustScore: 5,
    };

    const existingIdx = lab.hypotheses.findIndex(h => h.id === "hyp_test_no_dedup");
    if (existingIdx >= 0) {
      lab.hypotheses[existingIdx] = existingHyp;
    } else {
      lab.hypotheses.unshift(existingHyp);
    }
    saveResearchLab(lab);

    // Add a hypothesis with completely different entities
    const result = addHypothesis({
      claim: "Google DeepMind AlphaFold protein structure predictions accelerate drug discovery",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      confidence: "medium",
    });

    // Should create a new hypothesis (different entities)
    assert.notEqual(result.id, "hyp_test_no_dedup");
    assert.ok(result.id.startsWith("hyp_"));

    // Cleanup
    const labAfter = getResearchLab();
    labAfter.hypotheses = labAfter.hypotheses.filter(
      h => h.id !== "hyp_test_no_dedup" && h.id !== result.id,
    );
    saveResearchLab(labAfter);
  });

  it("falls through gracefully when entity extraction fails", async () => {
    const {
      addHypothesis,
      getResearchLab,
      saveResearchLab,
    } = await import("../researchEngine.js");

    // A claim with no capitalized entities should just fall through entity dedup
    const result = addHypothesis({
      claim: "lower case claim with no entities whatsoever about nothing in particular here",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      confidence: "low",
    });

    // Should still create the hypothesis (no entities to dedup against)
    assert.ok(result.id.startsWith("hyp_"));
    assert.equal(result.status, "forming");

    // Cleanup
    const labAfter = getResearchLab();
    labAfter.hypotheses = labAfter.hypotheses.filter(h => h.id !== result.id);
    saveResearchLab(labAfter);
  });
});

// ── Enhancement 3: Eval-Aware Consolidation Prioritization ───────────────────

describe("prioritizeClusters", () => {
  // Helper to create a mock cluster
  function makeCluster(claims: string[]): import("../hypothesisConsolidator.js").HypothesisCluster {
    const members = claims.map((claim, i) => ({
      id: `hyp_test_${i}_${Date.now()}`,
      claim,
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      status: "forming" as const,
      confidence: "medium" as const,
      formedAt: new Date().toISOString(),
    }));
    return {
      representative: members[0],
      members,
      similarity: 0.5,
    };
  }

  it("sorts clusters matching weak dimension keywords first", async () => {
    const { prioritizeClusters } = await import("../hypothesisConsolidator.js");

    const reasoningCluster = makeCluster([
      "Logic and analysis of reasoning patterns in debate outcomes",
      "Contradiction detection via logical argument chains",
      "Hypothesis testing through structured reasoning",
    ]);
    const audienceCluster = makeCluster([
      "Audience engagement metrics for social media posts",
      "Community growth through content distribution",
      "Follower retention impact analysis",
    ]);
    const neutralCluster = makeCluster([
      "Market price movement correlations",
      "Economic indicator trends quarterly",
      "Supply chain disruption patterns",
    ]);

    // Weakest dimension: reasoningRigor — reasoning cluster should sort first
    const result = prioritizeClusters(
      [audienceCluster, neutralCluster, reasoningCluster],
      "reasoningRigor",
    );

    assert.equal(result[0], reasoningCluster, "Reasoning cluster should be first for reasoningRigor");
  });

  it("sorts larger clusters before smaller at same relevance", async () => {
    const { prioritizeClusters } = await import("../hypothesisConsolidator.js");

    const smallCluster = makeCluster([
      "Data source scanning for signals",
      "Signal detection via monitoring",
    ]);
    const largeCluster = makeCluster([
      "Research data from multiple sources",
      "Data feed scanning improvements",
      "Source monitoring signal detection",
      "Research signal analysis pipeline",
      "Data quality monitoring tools",
      "Signal verification from sources",
    ]);

    // Both match signalAcquisition keywords similarly per-member,
    // but the larger one should sort first due to size tiebreak
    const result = prioritizeClusters(
      [smallCluster, largeCluster],
      "signalAcquisition",
    );

    assert.equal(
      result[0],
      largeCluster,
      "Larger cluster should sort first when relevance scores tie per-member",
    );
  });

  it("returns clusters unchanged when dimension is missing or unknown", async () => {
    const { prioritizeClusters } = await import("../hypothesisConsolidator.js");

    const clusters = [
      makeCluster(["Cluster A topic one", "Cluster A topic two"]),
      makeCluster(["Cluster B topic one", "Cluster B topic two"]),
    ];

    // No dimension
    const result1 = prioritizeClusters(clusters, undefined);
    assert.deepEqual(result1, clusters);

    // Unknown dimension
    const result2 = prioritizeClusters(clusters, "nonexistentDimension");
    assert.deepEqual(result2, clusters);
  });
});
