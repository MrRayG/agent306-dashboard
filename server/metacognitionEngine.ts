// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — METACOGNITION ENGINE (The Mind)
//
// Aggregation endpoint showing cognitive state at a glance: knowledge coverage,
// reasoning quality, learning velocity, confidence calibration.
// ─────────────────────────────────────────────────────────────────────────────

import { knowledge, getActiveKnowledgeCount } from "./memoryEngine.js";
import { getReflectionStats } from "./reflectionEngine.js";
import { getReasoningStats } from "./reasoningEngine.js";
import { getSynthesisStats } from "./synthesisEngine.js";
import { getConversationLearningStats } from "./conversationLearningEngine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetacognitionState {
  knowledgeCoverage: {
    totalActive: number;
    categories: Array<{ name: string; count: number; avgWeight: number }>;
  };
  reasoningQuality: {
    debatesRun: number;
    contradictionsFound: number;
    contradictionsOpen: number;
    contradictionsResolved: number;
  };
  learningVelocity: {
    knowledgeAdded7d: number;
    knowledgeAdded30d: number;
    trend: "accelerating" | "steady" | "slowing";
  };
  confidenceCalibration: {
    highWeightCount: number;
    lowWeightCount: number;
    avgWeight: number;
  };
  reflectionStats: {
    totalReflections: number;
    activeRules: number;
    avgPostScore7d: number;
    avgPostScore30d: number;
    scoreTrend: "improving" | "stable" | "declining";
  };
  synthesisStats: {
    totalConnections: number;
    totalReports: number;
    lastSynthesis: string | null;
  };
  conversationStats: {
    insightsExtracted: number;
    relationshipsTracked: number;
    topContributors: string[];
  };
}

// ── Main aggregation ──────────────────────────────────────────────────────────

export function getMetacognitionState(): MetacognitionState {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  const now = Date.now();
  const d7 = 7 * 24 * 60 * 60 * 1000;
  const d30 = 30 * 24 * 60 * 60 * 1000;

  // Knowledge coverage by category
  const categoryMap = new Map<string, { count: number; totalWeight: number }>();
  for (const e of active) {
    const cat = categoryMap.get(e.category) ?? { count: 0, totalWeight: 0 };
    cat.count++;
    cat.totalWeight += e.weight;
    categoryMap.set(e.category, cat);
  }
  const categories = [...categoryMap.entries()]
    .map(([name, data]) => ({
      name,
      count: data.count,
      avgWeight: Math.round(data.totalWeight / data.count * 10) / 10,
    }))
    .sort((a, b) => b.count - a.count);

  // Learning velocity
  const added7d = active.filter(e => now - new Date(e.learnedAt).getTime() < d7).length;
  const added30d = active.filter(e => now - new Date(e.learnedAt).getTime() < d30).length;
  const weeklyRate = added30d > 0 ? added7d / (added30d / 4) : 1;
  const trend: "accelerating" | "steady" | "slowing" =
    weeklyRate > 1.3 ? "accelerating" : weeklyRate < 0.7 ? "slowing" : "steady";

  // Confidence calibration
  const highWeight = active.filter(e => e.weight >= 7).length;
  const lowWeight = active.filter(e => e.weight <= 3).length;
  const avgWeight = active.length > 0
    ? Math.round(active.reduce((s, e) => s + e.weight, 0) / active.length * 10) / 10
    : 0;

  return {
    knowledgeCoverage: {
      totalActive: getActiveKnowledgeCount(),
      categories,
    },
    reasoningQuality: getReasoningStats(),
    learningVelocity: {
      knowledgeAdded7d: added7d,
      knowledgeAdded30d: added30d,
      trend,
    },
    confidenceCalibration: {
      highWeightCount: highWeight,
      lowWeightCount: lowWeight,
      avgWeight,
    },
    reflectionStats: getReflectionStats(),
    synthesisStats: getSynthesisStats(),
    conversationStats: getConversationLearningStats(),
  };
}
