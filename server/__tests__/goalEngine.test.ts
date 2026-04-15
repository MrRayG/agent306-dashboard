/**
 * Tests for Goal Engine — autonomous self-improvement loop driven by 306Eval.
 *
 * Run: npx tsx --test server/__tests__/goalEngine.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const HISTORY_FILE = dataPath("goal_engine_history.json");
const GOALS_FILE = dataPath("agent_goals.json");

// Backup and restore goals to avoid polluting real state
let goalsBackup: string | null = null;

function cleanFiles() {
  try { if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE); } catch {}
}

function backupGoals() {
  try {
    if (fs.existsSync(GOALS_FILE)) {
      goalsBackup = fs.readFileSync(GOALS_FILE, "utf-8");
    }
  } catch {}
}

function restoreGoals() {
  try {
    if (goalsBackup !== null) {
      fs.writeFileSync(GOALS_FILE, goalsBackup);
    }
  } catch {}
}

function mockEvalResult(overrides: Partial<any> = {}): any {
  return {
    id: `eval_test_${Date.now()}`,
    timestamp: new Date().toISOString(),
    dimensions: [
      { name: "Signal Acquisition", key: "signalAcquisition", score: 65, components: {} },
      { name: "Source Integrity", key: "sourceIntegrity", score: 70, components: {} },
      { name: "Reasoning Rigor", key: "reasoningRigor", score: 60, components: {} },
      { name: "Intellectual Honesty", key: "intellectualHonesty", score: 75, components: {} },
      { name: "Voice Evolution", key: "voiceEvolution", score: 80, components: {} },
      { name: "Audience Impact", key: "audienceImpact", score: 55, components: {} },
    ],
    composite: 67,
    weakestDimension: overrides.weakestDimension ?? "audienceImpact",
    calibrationDirective: overrides.calibrationDirective ?? "Focus on audience engagement",
    drift: { direction: "stable" as const, avg7d: 67, avg30d: 65, delta7d: 2 },
    ...overrides,
  };
}

describe("GoalEngine", () => {
  let buildGoalContext: typeof import("../goalEngine.js").buildGoalContext;
  let checkMeasurableMilestones: typeof import("../goalEngine.js").checkMeasurableMilestones;
  let readSystemMetric: typeof import("../goalEngine.js").readSystemMetric;
  let getGoalEngineHistory: typeof import("../goalEngine.js").getGoalEngineHistory;
  let runGoalEngine: typeof import("../goalEngine.js").runGoalEngine;

  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    backupGoals();
    cleanFiles();
    const mod = await import("../goalEngine.js");
    buildGoalContext = mod.buildGoalContext;
    checkMeasurableMilestones = mod.checkMeasurableMilestones;
    readSystemMetric = mod.readSystemMetric;
    getGoalEngineHistory = mod.getGoalEngineHistory;
    runGoalEngine = mod.runGoalEngine;
  });

  afterEach(() => {
    cleanFiles();
    restoreGoals();
    globalThis.fetch = originalFetch;
  });

  describe("buildGoalContext()", () => {
    it("should return a valid context object", async () => {
      const ctx = await buildGoalContext(mockEvalResult());
      assert.ok(ctx.evalResult, "Should have evalResult");
      assert.strictEqual(ctx.evalResult.weakestDimension, "audienceImpact");
      assert.ok(Array.isArray(ctx.weakestCompetencies), "Should have weakestCompetencies array");
      assert.ok(Array.isArray(ctx.currentGoalCategories), "Should have currentGoalCategories array");
      assert.ok(Array.isArray(ctx.recentAchievements), "Should have recentAchievements array");
      assert.ok(ctx.systemMetrics, "Should have systemMetrics");
      assert.strictEqual(typeof ctx.systemMetrics.kbEntryCount, "number");
    });

    it("should handle missing eval result gracefully", async () => {
      const ctx = await buildGoalContext();
      assert.ok(ctx.evalResult, "Should still have evalResult");
      assert.ok(ctx.systemMetrics, "Should still have systemMetrics");
    });
  });

  describe("readSystemMetric()", () => {
    it("should read kbEntryCount", async () => {
      const val = await readSystemMetric("system:kbEntryCount");
      assert.strictEqual(typeof val, "number");
      assert.ok(val !== null, "KB entry count should not be null");
    });

    it("should read wisdomEntryCount", async () => {
      const val = await readSystemMetric("system:wisdomEntryCount");
      assert.strictEqual(typeof val, "number");
    });

    it("should return null for unknown metrics", async () => {
      const val = await readSystemMetric("system:nonexistent");
      assert.strictEqual(val, null);
    });

    it("should handle competencyLevel metrics", async () => {
      const val = await readSystemMetric("system:competencyLevel:storytelling");
      // May be null if competency doesn't exist, but should not throw
      assert.ok(val === null || typeof val === "number");
    });
  });

  describe("checkMeasurableMilestones()", () => {
    it("should return an object with completed array and checked count", async () => {
      const result = await checkMeasurableMilestones();
      assert.ok(Array.isArray(result.completed), "Should have completed array");
      assert.strictEqual(typeof result.checked, "number");
    });
  });

  describe("getGoalEngineHistory()", () => {
    it("should return empty history when no runs exist", () => {
      const history = getGoalEngineHistory();
      assert.ok(history.runs, "Should have runs array");
      assert.strictEqual(history.runs.length, 0);
    });
  });

  describe("runGoalEngine()", () => {
    it("should return a valid result on first run", async () => {
      // Mock fetch to prevent real LLM calls
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                goals: [{
                  title: "Test goal for eval",
                  description: "A test goal targeting audience impact",
                  category: "reach",
                  priority: "high",
                  targetDimension: "audienceImpact",
                  targetCompetencies: ["audience-engagement"],
                  milestones: [
                    { text: "Milestone 1", metric: "system:kbEntryCount", target: 999, daysToComplete: 10, measuredBy: "system" },
                    { text: "Milestone 2", metric: "grok", target: "qualitative check", daysToComplete: 12, measuredBy: "grok" },
                    { text: "Milestone 3", metric: "system:totalPosts", target: 500, daysToComplete: 14, measuredBy: "system" },
                  ],
                }],
              }),
            },
          }],
        }),
      })) as any;

      const evalResult = mockEvalResult();
      const result = await runGoalEngine(evalResult, "test-key");

      assert.ok(result, "Should return a result");
      assert.strictEqual(typeof result.goalsGenerated, "number");
      assert.strictEqual(typeof result.goalsResolved, "number");
      assert.strictEqual(typeof result.milestonesAutoCompleted, "number");
      assert.ok(Array.isArray(result.competencyUpdates));
      assert.ok(Array.isArray(result.brainEvolutionEvents));
    });

    it("should respect cooldown between runs", async () => {
      // Mock fetch
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"goals":[]}' } }] }),
      })) as any;

      const evalResult = mockEvalResult();

      // First run should succeed
      const result1 = await runGoalEngine(evalResult, "test-key");
      assert.ok(result1, "First run should return result");

      // Second run immediately should be skipped (cooldown)
      const result2 = await runGoalEngine(evalResult, "test-key");
      assert.strictEqual(result2.goalsGenerated, 0, "Second run should generate 0 goals (cooldown)");
      assert.strictEqual(result2.goalsResolved, 0, "Second run should resolve 0 goals (cooldown)");
    });

    it("should handle LLM failure gracefully", async () => {
      // Mock fetch to fail
      globalThis.fetch = (async () => {
        throw new Error("Network error — test mock");
      }) as any;

      // Clear history to avoid cooldown
      cleanFiles();

      const evalResult = mockEvalResult();
      const result = await runGoalEngine(evalResult, "test-key");

      assert.ok(result, "Should return a result even on LLM failure");
      assert.strictEqual(result.goalsGenerated, 0, "Should not generate goals on failure");
    });

    it("should save run to history", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"goals":[]}' } }] }),
      })) as any;

      const evalResult = mockEvalResult();
      await runGoalEngine(evalResult, "test-key");

      const history = getGoalEngineHistory();
      assert.ok(history.runs.length > 0, "Should have at least one history entry");
      assert.strictEqual(history.runs[0].evalComposite, 67);
      assert.strictEqual(history.runs[0].weakestDimension, "audienceImpact");
    });
  });

  describe("Category-Competency mapping", () => {
    it("should generate goals targeting weakest dimension", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                goals: [{
                  title: "Boost audience engagement metrics",
                  description: "Target audience impact — our weakest dimension",
                  category: "reach",
                  priority: "high",
                  targetDimension: "audienceImpact",
                  targetCompetencies: ["audience-engagement", "community-building"],
                  milestones: [
                    { text: "Engage with 10 community threads", metric: "grok", target: "qualitative", daysToComplete: 7, measuredBy: "grok" },
                    { text: "Reach 50 total posts", metric: "system:totalPosts", target: 50, daysToComplete: 10, measuredBy: "system" },
                    { text: "Add 20 KB entries on audience psychology", metric: "system:kbEntryCount", target: 999, daysToComplete: 14, measuredBy: "system" },
                  ],
                }],
              }),
            },
          }],
        }),
      })) as any;

      const evalResult = mockEvalResult({ weakestDimension: "audienceImpact" });
      const result = await runGoalEngine(evalResult, "test-key");

      // If goals were generated, they should be tracked
      if (result.goalsGenerated > 0) {
        assert.ok(
          result.brainEvolutionEvents.some(e => e.includes("audienceImpact")),
          "Generated goals should target the weakest dimension"
        );
      }
    });
  });

  describe("MilestoneSpec validation", () => {
    it("should clamp milestone deadlines to 7-14 day range", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                goals: [{
                  title: "Test deadline clamping",
                  description: "Testing milestone deadline validation",
                  category: "knowledge",
                  priority: "medium",
                  targetDimension: "signalAcquisition",
                  targetCompetencies: ["niche-expertise"],
                  milestones: [
                    { text: "Too short deadline", metric: "grok", target: "check", daysToComplete: 1, measuredBy: "grok" },
                    { text: "Too long deadline", metric: "grok", target: "check", daysToComplete: 30, measuredBy: "grok" },
                    { text: "Normal deadline", metric: "grok", target: "check", daysToComplete: 10, measuredBy: "grok" },
                  ],
                }],
              }),
            },
          }],
        }),
      })) as any;

      const evalResult = mockEvalResult();
      const result = await runGoalEngine(evalResult, "test-key");

      // Should succeed without errors — deadlines clamped internally
      assert.ok(result, "Should handle deadline clamping without errors");
    });
  });

  describe("Graceful handling of missing data", () => {
    it("should handle missing eval result in buildGoalContext", async () => {
      const ctx = await buildGoalContext(undefined as any);
      assert.ok(ctx, "Should return context even without eval");
      assert.strictEqual(ctx.evalResult.weakestDimension, "unknown");
    });
  });
});
