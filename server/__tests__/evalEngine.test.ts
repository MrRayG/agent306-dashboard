/**
 * Tests for 306Eval benchmark engine — dimension calculations,
 * composite scoring, calibration directives, drift detection.
 *
 * Run: npx tsx --test server/__tests__/evalEngine.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const EVAL_FILE = dataPath("eval_results.json");

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanEvalFile() {
  try { if (fs.existsSync(EVAL_FILE)) fs.unlinkSync(EVAL_FILE); } catch {}
}

// Build minimal mock data that each engine's getter would return.
// These are shaped to match the actual interfaces.

function mockMetacognitionState(overrides: Partial<any> = {}) {
  return {
    knowledgeCoverage: { totalActive: 100, categories: [
      { name: "AI", count: 30, avgWeight: 7 },
      { name: "Web3", count: 25, avgWeight: 6 },
      { name: "DePIN", count: 20, avgWeight: 5 },
      { name: "Governance", count: 15, avgWeight: 4 },
      { name: "Culture", count: 10, avgWeight: 3 },
    ]},
    reasoningQuality: { debatesRun: 20, contradictionsFound: 10, contradictionsOpen: 3, contradictionsResolved: 7 },
    learningVelocity: { knowledgeAdded7d: 20, knowledgeAdded30d: 60, trend: "steady" as const },
    confidenceCalibration: { highWeightCount: 15, lowWeightCount: 5, avgWeight: 6 },
    reflectionStats: { totalReflections: 30, activeRules: 8, avgPostScore7d: 6.5, avgPostScore30d: 6.0, scoreTrend: "improving" as const },
    synthesisStats: { totalConnections: 50, totalReports: 10, lastSynthesis: null },
    conversationStats: { insightsExtracted: 25, relationshipsTracked: 15, topContributors: [] },
    ...overrides,
  };
}

function mockEvolutionDiffs(count = 3) {
  const diffs = [];
  for (let i = 0; i < count; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    diffs.push({
      id: `diff_${i}`,
      date: d.toISOString().split("T")[0],
      cycleNumber: i + 1,
      hypothesisDiffs: [],
      knowledgeDiffs: {
        added: 5,
        archived: 1,
        weightChanges: [],
        newCategories: i === 0 ? ["NewCat"] : [],
        categoryGrowth: { AI: 3, Web3: 2 },
      },
      pruningSuggestions: [],
      overallNarrative: "test",
    });
  }
  return diffs;
}

function mockReasoningStats(overrides: Partial<any> = {}) {
  return {
    debatesRun: 20,
    contradictionsFound: 10,
    contradictionsOpen: 3,
    contradictionsResolved: 7,
    ...overrides,
  };
}

function mockPredictions(preds: Array<{ status: string }> = []) {
  return {
    predictions: preds.map((p, i) => ({
      id: `pred_${i}`,
      claim: "test",
      hypothesisId: "h1",
      madeAt: Date.now(),
      checkDate: Date.now() + 86400000,
      status: p.status,
    })),
    lastUpdated: new Date().toISOString(),
  };
}

function mockCompetencyProfile(overrides: Partial<any> = {}) {
  return {
    competencies: [
      { id: "critical-thinking", name: "Critical Thinking", category: "core", description: "", indicators: [], currentLevel: 6, growthPath: [] },
      { id: "storytelling", name: "Storytelling", category: "core", description: "", indicators: [], currentLevel: 5, growthPath: [] },
      { id: "audience-engagement", name: "Audience Engagement", category: "core", description: "", indicators: [], currentLevel: 4, growthPath: [] },
    ],
    growthFocus: ["critical-thinking"],
    lastFocusRotation: new Date().toISOString(),
    levelHistory: [],
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

function mockDebates(count = 5) {
  return Array.from({ length: count }, (_, i) => ({
    id: `debate_${i}`,
    topicId: `topic_${i}`,
    topicType: "hypothesis" as const,
    title: `Test Debate ${i}`,
    originalText: "test",
    critique: { weaknesses: [], counterArguments: [], logicalIssues: [], overallAssessment: "solid" as const, suggestions: [] },
    dualDebate: {
      skepticVerdict: { weaknesses: [], counterArguments: [], falsificationCriteria: [], evidenceGaps: [], confidenceScore: 4 },
      builderVerdict: { implications: [], buildableInsights: [], nextSteps: [], connectionOpportunities: [], confidenceScore: 7 },
      crossScore: { skepticOnBuilder: 6, builderOnSkeptic: 7, consensusStrength: 6.5 },
      finalVerdict: "moderate" as const,
      falsificationCriteria: [],
    },
    createdAt: new Date().toISOString(),
  }));
}

function mockResearchLab(overrides: Partial<any> = {}) {
  const now = Date.now();
  return {
    topics: [],
    hypotheses: [
      { id: "h1", claim: "test1", basis: "b", metric: "m", prediction: "p", timeframe: "1w", status: "confirmed", confidence: "high", formedAt: new Date(now - 10 * 86400000).toISOString(), resolvedAt: new Date(now - 2 * 86400000).toISOString(), trustScore: 80 },
      { id: "h2", claim: "test2", basis: "b", metric: "m", prediction: "p", timeframe: "1w", status: "testing", confidence: "medium", formedAt: new Date(now - 5 * 86400000).toISOString() },
      { id: "h3", claim: "test3", basis: "b", metric: "m", prediction: "p", timeframe: "1w", status: "rejected", confidence: "low", formedAt: new Date(now - 15 * 86400000).toISOString(), resolvedAt: new Date(now - 3 * 86400000).toISOString() },
      { id: "h4", claim: "test4", basis: "b", metric: "m", prediction: "p", timeframe: "1w", status: "forming", confidence: "low", formedAt: new Date(now - 20 * 86400000).toISOString() },
    ],
    lastUpdated: new Date().toISOString(),
    stats: { totalResearched: 10, totalPublished: 5, totalDeclined: 2, hypothesesFormed: 4, hypothesesConfirmed: 1 },
    ...overrides,
  };
}

function mockCorrections(count = 2) {
  return {
    corrections: Array.from({ length: count }, (_, i) => ({
      id: `corr_${i}`,
      originalClaim: "old",
      originalDate: Date.now() - 5 * 86400000,
      correctedClaim: "new",
      correctionDate: Date.now() - 2 * 86400000,
      whatChanged: "updated",
      lessonLearned: "learned",
    })),
    lastUpdated: new Date().toISOString(),
  };
}

function mockContradictions(open = 2, resolved = 5) {
  const result = [];
  for (let i = 0; i < open; i++) {
    result.push({
      id: `contra_open_${i}`, entryA: { id: "a", title: "A", summary: "a", category: "AI" },
      entryB: { id: "b", title: "B", summary: "b", category: "AI" },
      description: "test", severity: "minor" as const, status: "open" as const, createdAt: new Date().toISOString(),
    });
  }
  for (let i = 0; i < resolved; i++) {
    result.push({
      id: `contra_res_${i}`, entryA: { id: "a", title: "A", summary: "a", category: "AI" },
      entryB: { id: "b", title: "B", summary: "b", category: "AI" },
      description: "test", severity: "minor" as const, status: "resolved" as const, resolution: "keep_new" as const,
      resolvedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    });
  }
  return result;
}

function mockEvolutionInsights(validated = 3, dismissed = 1) {
  const result: any[] = [];
  for (let i = 0; i < validated; i++) {
    result.push({ id: `ins_v_${i}`, sourceType: "hypothesis", sourceId: "h1", insight: "test", selfApplication: "apply", status: "validated", createdAt: Date.now() });
  }
  for (let i = 0; i < dismissed; i++) {
    result.push({ id: `ins_d_${i}`, sourceType: "hypothesis", sourceId: "h2", insight: "test", selfApplication: "apply", status: "dismissed", createdAt: Date.now() });
  }
  return { insights: result, lastUpdated: new Date().toISOString(), totalCycles: 10 };
}

function mockVoiceJournal(traitCount = 3) {
  return {
    entries: [],
    currentVoiceTraits: Array.from({ length: traitCount }, (_, i) => ({
      trait: `Trait ${i}`,
      strength: 5 + i,   // 5, 6, 7
      firstObserved: new Date().toISOString(),
      lastReinforced: new Date().toISOString(),
      evidence: [],
    })),
    communicationInsights: [],
    audienceInsights: [],
    lastReflection: new Date().toISOString(),
  };
}

function mockStyleRules(highConf = 4, medConf = 6) {
  const rules = [];
  for (let i = 0; i < highConf; i++) {
    rules.push({ id: `r_h_${i}`, rule: "test", source: "ref1", confidence: "high" as const, createdAt: new Date().toISOString(), hitCount: 4 });
  }
  for (let i = 0; i < medConf; i++) {
    rules.push({ id: `r_m_${i}`, rule: "test", source: "ref2", confidence: "medium" as const, createdAt: new Date().toISOString(), hitCount: 1 });
  }
  return rules;
}

function mockReflectionStats(overrides: Partial<any> = {}) {
  return {
    totalReflections: 30,
    activeRules: 10,
    avgPostScore7d: 7.0,
    avgPostScore30d: 6.0,
    scoreTrend: "improving" as const,
    ...overrides,
  };
}

function mockEvolutionHistory(snapshotCount = 10) {
  const snaps = [];
  for (let i = 0; i < snapshotCount; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    snaps.push({
      date: d.toISOString().split("T")[0],
      takenAt: d.toISOString(),
      knowledgeTotal: 100 + i * 5,
      knowledgeByCategory: { AI: 50, Web3: 30 },
      knowledgeAddedToday: 5,
      totalPosts: 50 + i,
      avgQualityScore: 6 + (i % 3) * 0.5,
      avgEngagement: 5 + (i === 0 ? 2 : i * 0.3),
      topEngagement: 9,
      postsToday: 3,
      bestTopics: ["AI"],
      currentFocusAreas: ["AI"],
      voiceMaturity: 5,
      repliesSent: 10,
      followingCount: 100,
      totalExplorations: 5,
      lastExploration: null,
      overallScore: 60 + i,
      growthVector: "steady",
      mood: "focused",
      milestone: null,
    });
  }
  return { snapshots: snaps, startDate: snaps[snaps.length - 1].date, totalDays: snapshotCount, lastSnapshot: snaps[0].date };
}

function mockBreakthroughs(count = 2) {
  return {
    breakthroughs: Array.from({ length: count }, (_, i) => ({
      id: `bt_${i}`,
      type: "hypothesis_confirmed" as const,
      title: `Breakthrough ${i}`,
      description: "test",
      noveltyScore: 80,
      impactScore: 70,
      compositeScore: 75,
      detectedAt: Date.now() - i * 5 * 86400000,
      evidence: [],
      published: false,
      publishedTo: [],
    })),
    lastUpdated: new Date().toISOString(),
  };
}

// ── Test suite ──────────────────────────────────────────────────────────────

// We need to mock all the upstream getters. Use node:test mock.module if
// available, or mock at globalThis level. Since node:test mock.module is
// experimental, we'll mock the individual functions by replacing the module
// cache. The simplest approach: we mock the modules before importing evalEngine.

// Store original mocks
let mockFns: Record<string, any> = {};

// We use dynamic import after setting up mocks via mock.module
// node:test mock.module requires Node 22+, so we'll use a different approach:
// We'll test the evalEngine by manipulating data files and using the actual
// module imports. Since the module reads from other modules' getter functions
// (which themselves read from disk), we can control the data by writing mock
// data files.

// However, this is fragile. Instead, let's test the exported functions by
// just running them against whatever state the engines have (or empty state).
// The key tests are: composite scoring math, drift detection, calibration
// directive selection, and edge cases with empty data.

// Clean slate
cleanEvalFile();

// Import the module — it will load with whatever engine state exists
import { run306Eval, get306EvalResults, get306EvalHistory } from "../evalEngine.js";

describe("306Eval Benchmark", () => {
  beforeEach(() => {
    cleanEvalFile();
  });

  afterEach(() => {
    cleanEvalFile();
  });

  // ── Integration: run306Eval produces valid structure ─────────────────────

  it("run306Eval returns a valid EvalResult structure", () => {
    const result = run306Eval();

    assert.ok(result.id.startsWith("eval_"), "ID should start with eval_");
    assert.ok(result.timestamp, "Should have timestamp");
    assert.equal(result.dimensions.length, 6, "Should have 6 dimensions");
    assert.ok(typeof result.composite === "number", "Composite should be a number");
    assert.ok(result.composite >= 0 && result.composite <= 100, `Composite ${result.composite} should be 0-100`);
    assert.ok(typeof result.weakestDimension === "string", "Weakest dimension should be a string");
    assert.ok(typeof result.calibrationDirective === "string", "Calibration directive should be a string");
    assert.ok(result.drift, "Should have drift status");
    assert.ok(["improving", "declining", "stable"].includes(result.drift.direction), "Drift direction should be valid");
  });

  it("each dimension has required fields and is in 0-100 range", () => {
    const result = run306Eval();

    const expectedKeys = [
      "signalAcquisition",
      "sourceIntegrity",
      "reasoningRigor",
      "intellectualHonesty",
      "voiceEvolution",
      "audienceImpact",
    ];

    for (const dim of result.dimensions) {
      assert.ok(typeof dim.name === "string" && dim.name.length > 0, `Dimension name should be non-empty string`);
      assert.ok(typeof dim.key === "string" && dim.key.length > 0, `Dimension key should be non-empty string`);
      assert.ok(dim.score >= 0 && dim.score <= 100, `${dim.key} score ${dim.score} should be 0-100`);
      assert.ok(typeof dim.components === "object", `${dim.key} should have components`);
    }

    const keys = result.dimensions.map(d => d.key);
    for (const k of expectedKeys) {
      assert.ok(keys.includes(k), `Should include dimension: ${k}`);
    }
  });

  // ── Composite scoring ────────────────────────────────────────────────────

  it("composite score equals weighted sum of dimensions", () => {
    const result = run306Eval();

    const weights: Record<string, number> = {
      signalAcquisition: 0.15,
      sourceIntegrity: 0.15,
      reasoningRigor: 0.20,
      intellectualHonesty: 0.20,
      voiceEvolution: 0.15,
      audienceImpact: 0.15,
    };

    let expected = 0;
    for (const dim of result.dimensions) {
      expected += dim.score * (weights[dim.key] ?? 0);
    }
    expected = Math.round(expected * 10) / 10;

    assert.equal(result.composite, expected, `Composite ${result.composite} should equal weighted sum ${expected}`);
  });

  it("weights sum to 1.0", () => {
    const weights = [0.15, 0.15, 0.20, 0.20, 0.15, 0.15];
    const sum = weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights sum ${sum} should be 1.0`);
  });

  // ── Weakest dimension ────────────────────────────────────────────────────

  it("weakestDimension is the lowest-scoring dimension", () => {
    const result = run306Eval();
    const minScore = Math.min(...result.dimensions.map(d => d.score));
    const weakest = result.dimensions.find(d => d.key === result.weakestDimension);
    assert.ok(weakest, "Weakest dimension should exist");
    assert.equal(weakest!.score, minScore, "Weakest dimension should have the lowest score");
  });

  // ── Calibration directives ───────────────────────────────────────────────

  it("calibration directive corresponds to weakest dimension", () => {
    const result = run306Eval();

    const directiveMap: Record<string, string> = {
      signalAcquisition: "research pipeline",
      sourceIntegrity: "Source credibility",
      reasoningRigor: "Reasoning depth",
      intellectualHonesty: "stale hypotheses",
      voiceEvolution: "voice traits",
      audienceImpact: "engagement",
    };

    const expectedSubstring = directiveMap[result.weakestDimension];
    if (expectedSubstring) {
      assert.ok(
        result.calibrationDirective.toLowerCase().includes(expectedSubstring.toLowerCase()),
        `Directive "${result.calibrationDirective}" should reference "${expectedSubstring}" for weakest dimension "${result.weakestDimension}"`
      );
    }
  });

  // ── Drift detection ──────────────────────────────────────────────────────

  it("first run has stable drift (no history to compare against)", () => {
    const result = run306Eval();
    assert.equal(result.drift.direction, "stable", "First run should be stable — no prior history");
    assert.equal(result.drift.delta7d, 0, "Delta7d should be 0 on first run");
  });

  it("drift detects improving when score jumps above 7d average", () => {
    // Write fake history with low composite scores
    const fakeHistory = {
      results: Array.from({ length: 7 }, (_, i) => ({
        id: `eval_fake_${i}`,
        timestamp: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
        dimensions: [],
        composite: 30, // low baseline
        weakestDimension: "signalAcquisition",
        calibrationDirective: "test",
        drift: { direction: "stable" as const, avg7d: 30, avg30d: 30, delta7d: 0 },
      })),
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(EVAL_FILE, JSON.stringify(fakeHistory, null, 2));

    const result = run306Eval();
    // If actual composite is > 35 (30 + 5), drift should be "improving"
    if (result.composite > 35) {
      assert.equal(result.drift.direction, "improving", `Score ${result.composite} vs avg 30 should be improving`);
    }
    // If actual composite is < 25, drift should be "declining"
    else if (result.composite < 25) {
      assert.equal(result.drift.direction, "declining", `Score ${result.composite} vs avg 30 should be declining`);
    }
    // Otherwise stable is correct
    else {
      assert.equal(result.drift.direction, "stable");
    }
  });

  // ── History persistence ──────────────────────────────────────────────────

  it("results are persisted to eval_results.json", () => {
    run306Eval();
    assert.ok(fs.existsSync(EVAL_FILE), "eval_results.json should be created");

    const data = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
    assert.ok(data.results.length > 0, "Should have at least one result");
    assert.ok(data.lastUpdated, "Should have lastUpdated");
  });

  it("multiple runs append to history", () => {
    run306Eval();
    run306Eval();
    run306Eval();

    const data = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
    assert.equal(data.results.length, 3, "Should have 3 results after 3 runs");
  });

  it("history is capped at 90 entries", () => {
    // Pre-fill with 89 entries
    const fakeHistory = {
      results: Array.from({ length: 89 }, (_, i) => ({
        id: `eval_fake_${i}`,
        timestamp: new Date(Date.now() - i * 86400000).toISOString(),
        dimensions: [],
        composite: 50,
        weakestDimension: "signalAcquisition",
        calibrationDirective: "test",
        drift: { direction: "stable" as const, avg7d: 50, avg30d: 50, delta7d: 0 },
      })),
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(EVAL_FILE, JSON.stringify(fakeHistory, null, 2));

    // Run twice more — should cap at 90
    run306Eval();
    run306Eval();

    const data = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
    assert.ok(data.results.length <= 90, `History length ${data.results.length} should be <= 90`);
  });

  // ── API reader functions ─────────────────────────────────────────────────

  it("get306EvalResults returns latest + recent 7", () => {
    for (let i = 0; i < 10; i++) run306Eval();

    const { latest, recent } = get306EvalResults();
    assert.ok(latest, "Should have latest");
    assert.equal(recent.length, 7, "Recent should have 7 entries");
    assert.equal(latest!.id, recent[0].id, "Latest should be first in recent");
  });

  it("get306EvalHistory returns full history", () => {
    run306Eval();
    run306Eval();

    const history = get306EvalHistory();
    assert.equal(history.length, 2, "Should return all entries");
  });

  it("get306EvalResults returns null/empty when no data", () => {
    const { latest, recent } = get306EvalResults();
    assert.equal(latest, null, "Latest should be null when no data");
    assert.equal(recent.length, 0, "Recent should be empty when no data");
  });

  it("get306EvalHistory returns empty array when no data", () => {
    const history = get306EvalHistory();
    assert.equal(history.length, 0, "History should be empty when no data");
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("handles empty/fresh state without crashing", () => {
    // This tests the graceful degradation when engines have no data
    // All dimension functions use neutral defaults (50) for missing data
    assert.doesNotThrow(() => {
      const result = run306Eval();
      assert.ok(result.composite >= 0, "Composite should be non-negative");
    });
  });

  it("newest result is first in history array", () => {
    run306Eval();
    const result2 = run306Eval();

    const data = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
    assert.equal(data.results[0].id, result2.id, "Newest result should be first");
  });

  // ── Dimension component sub-scores ───────────────────────────────────────

  it("all dimension components are in 0-100 range", () => {
    const result = run306Eval();

    for (const dim of result.dimensions) {
      for (const [compKey, compVal] of Object.entries(dim.components)) {
        assert.ok(
          compVal >= 0 && compVal <= 100,
          `${dim.key}.${compKey} = ${compVal} should be in 0-100`
        );
      }
    }
  });

  it("signalAcquisition has expected component keys", () => {
    const result = run306Eval();
    const dim = result.dimensions.find(d => d.key === "signalAcquisition")!;
    assert.ok("kbGrowthNorm" in dim.components, "Should have kbGrowthNorm");
    assert.ok("categoryDiversity" in dim.components, "Should have categoryDiversity");
    assert.ok("freshEvidenceRate" in dim.components, "Should have freshEvidenceRate");
  });

  it("sourceIntegrity has expected component keys", () => {
    const result = run306Eval();
    const dim = result.dimensions.find(d => d.key === "sourceIntegrity")!;
    assert.ok("contradictionResolutionRate" in dim.components);
    assert.ok("predictionAccuracy" in dim.components);
    assert.ok("criticalThinkingLevel" in dim.components);
  });

  it("reasoningRigor has expected component keys", () => {
    const result = run306Eval();
    const dim = result.dimensions.find(d => d.key === "reasoningRigor")!;
    assert.ok("avgDebateConsensus" in dim.components);
    assert.ok("hypothesisTestRate" in dim.components);
    assert.ok("trustScoreAvg" in dim.components);
  });

  it("intellectualHonesty has expected component keys", () => {
    const result = run306Eval();
    const dim = result.dimensions.find(d => d.key === "intellectualHonesty")!;
    assert.ok("correctionRate" in dim.components);
    assert.ok("insightValidationRate" in dim.components);
    assert.ok("pruningHealth" in dim.components);
  });

  it("voiceEvolution has expected component keys", () => {
    const result = run306Eval();
    const dim = result.dimensions.find(d => d.key === "voiceEvolution")!;
    assert.ok("avgTraitStrength" in dim.components);
    assert.ok("styleRuleMaturity" in dim.components);
    assert.ok("scoreTrend" in dim.components);
  });

  it("audienceImpact has expected component keys", () => {
    const result = run306Eval();
    const dim = result.dimensions.find(d => d.key === "audienceImpact")!;
    assert.ok("engagementTrend" in dim.components);
    assert.ok("competencyGrowth" in dim.components);
    assert.ok("breakthroughRate" in dim.components);
  });
});
