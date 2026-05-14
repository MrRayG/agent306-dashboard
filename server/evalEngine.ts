// ---------------------------------------------------------------------------
// 306 -- EVAL ENGINE (306Eval Benchmark)
//
// Read-only observer module that aggregates existing metrics from all engines
// into a 6-dimension benchmark score. Pure computation — no LLM calls,
// no mutation of other engines' data. Writes only to data/eval_results.json.
//
// Dimensions (mapped to the 3-0-6 Triad):
//   Agent 3: Signal Acquisition, Source Integrity
//   Agent 0: Reasoning Rigor, Intellectual Honesty
//   Agent 6: Voice Evolution, Audience Impact
//
// Composite: weighted average (reasoning-heavy at 0.20 each, others 0.15).
// Includes drift detection (7d/30d rolling) and calibration directives.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getCompetencyProfile } from "./competencyFramework.js";
import {
  getReasoningStats,
  getContradictions,
  getCorrections,
  getDebates,
} from "./reasoningEngine.js";
import { getReflectionStats, getStyleRules } from "./reflectionEngine.js";
import {
  getBreakthroughs,
  getPredictions,
} from "./breakthroughDetector.js";
import { getEvolutionHistory } from "./evolutionTracker.js";
import {
  getEvolutionInsights,
  getEvolutionDiffs,
} from "./selfEvolutionEngine.js";
import { getVoiceJournal } from "./soulEvolution.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { getResearchLab } from "./researchEngine.js";

// -- Types ------------------------------------------------------------------

export interface EvalDimension {
  name:  string;
  key:   string;
  score: number;          // 0–100
  components: Record<string, number>;  // sub-scores for transparency
}

export interface DriftStatus {
  direction: "improving" | "declining" | "stable";
  avg7d:     number;
  avg30d:    number;
  delta7d:   number;       // current - avg7d
}

export interface EvalResult {
  id:                   string;
  timestamp:            string;
  dimensions:           EvalDimension[];
  composite:            number;      // 0–100 weighted average
  weakestDimension:     string;      // key of lowest-scoring dimension
  calibrationDirective: string;      // actionable sentence for next cycle
  drift:                DriftStatus;
}

interface EvalHistoryStore {
  results: EvalResult[];             // newest first, 90-day rolling cap
  lastUpdated: string;
}

// -- Constants ---------------------------------------------------------------

const EVAL_FILE   = "eval_results.json";
const HISTORY_CAP = 90;

const DIMENSION_WEIGHTS: Record<string, number> = {
  signalAcquisition:   0.15,
  sourceIntegrity:     0.15,
  reasoningRigor:      0.20,
  intellectualHonesty: 0.20,
  voiceEvolution:      0.15,
  audienceImpact:      0.15,
};

// -- Helpers -----------------------------------------------------------------

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function safeDiv(num: number, den: number, fallback = 0): number {
  return den > 0 ? num / den : fallback;
}

function loadHistory(): EvalHistoryStore {
  try {
    const raw = fs.readFileSync(dataPath(EVAL_FILE), "utf-8");
    return JSON.parse(raw) as EvalHistoryStore;
  } catch {
    return { results: [], lastUpdated: "" };
  }
}

function saveHistory(store: EvalHistoryStore): void {
  store.lastUpdated = new Date().toISOString();
  fs.writeFileSync(dataPath(EVAL_FILE), JSON.stringify(store, null, 2));
}

function daysAgo(d: number): number {
  return Date.now() - d * 86_400_000;
}

// -- Dimension Calculators ---------------------------------------------------

/**
 * Dimension 1: Signal Acquisition (Agent 3 — Researcher)
 * How effectively is she finding real information?
 */
function computeSignalAcquisition(): EvalDimension {
  const meta = getMetacognitionState();
  const diffs = getEvolutionDiffs();

  // KB growth: 7d vs normalized 30d
  const kbAdded7d  = meta.learningVelocity.knowledgeAdded7d;
  const kbAdded30d = meta.learningVelocity.knowledgeAdded30d;
  const kbGrowthRatio = safeDiv(kbAdded7d, Math.max(kbAdded30d / 4, 1), 1);
  const kbGrowthNorm = clamp(kbGrowthRatio * 100);

  // Category diversity: unique categories with new entries in recent diffs / total categories
  const recentDiffs = diffs.filter(d => new Date(d.date).getTime() > daysAgo(7));
  const categoriesWithGrowth = new Set<string>();
  for (const diff of recentDiffs) {
    if (diff.knowledgeDiffs?.categoryGrowth) {
      for (const [cat, growth] of Object.entries(diff.knowledgeDiffs.categoryGrowth)) {
        if (growth > 0) categoriesWithGrowth.add(cat);
      }
    }
    if (diff.knowledgeDiffs?.newCategories) {
      for (const cat of diff.knowledgeDiffs.newCategories) {
        categoriesWithGrowth.add(cat);
      }
    }
  }
  const totalCategories = meta.knowledgeCoverage.categories.length;
  const categoryDiversity = clamp(safeDiv(categoriesWithGrowth.size, Math.max(totalCategories, 1)) * 100);

  // Fresh evidence rate: high-weight recent entries / total active
  const highWeightRecent = meta.confidenceCalibration.highWeightCount;
  const totalActive = meta.knowledgeCoverage.totalActive;
  const freshEvidenceRate = clamp(safeDiv(highWeightRecent, Math.max(totalActive, 1)) * 100);

  const score = clamp(kbGrowthNorm * 0.4 + categoryDiversity * 0.3 + freshEvidenceRate * 0.3);

  return {
    name: "Signal Acquisition",
    key: "signalAcquisition",
    score: Math.round(score * 10) / 10,
    components: {
      kbGrowthNorm: Math.round(kbGrowthNorm * 10) / 10,
      categoryDiversity: Math.round(categoryDiversity * 10) / 10,
      freshEvidenceRate: Math.round(freshEvidenceRate * 10) / 10,
    },
  };
}

/**
 * Dimension 2: Source Integrity (Agent 3 — Researcher)
 * How trustworthy are her sources?
 */
function computeSourceIntegrity(): EvalDimension {
  const stats = getReasoningStats();
  const predictions = getPredictions();
  const profile = getCompetencyProfile();

  // Contradiction resolution rate
  const resolved = stats.contradictionsResolved;
  const open = stats.contradictionsOpen;
  const totalContradictions = resolved + open;
  const contradictionResolutionRate = totalContradictions > 0
    ? clamp((resolved / totalContradictions) * 100)
    : 50; // neutral if none exist

  // Prediction accuracy
  const preds = predictions.predictions || [];
  const verifiedTrue  = preds.filter(p => p.status === "verified_true").length;
  const verifiedFalse = preds.filter(p => p.status === "verified_false").length;
  const totalVerified = verifiedTrue + verifiedFalse;
  const predictionAccuracy = totalVerified > 0
    ? clamp((verifiedTrue / totalVerified) * 100)
    : 50; // neutral if none exist

  // Critical thinking level
  const ctComp = profile.competencies.find(c => c.id === "critical-thinking");
  const ctLevel = ctComp?.currentLevel ?? 5;
  const criticalThinkingLevel = clamp((ctLevel / 10) * 100);

  const score = clamp(
    contradictionResolutionRate * 0.35 +
    predictionAccuracy * 0.35 +
    criticalThinkingLevel * 0.30
  );

  return {
    name: "Source Integrity",
    key: "sourceIntegrity",
    score: Math.round(score * 10) / 10,
    components: {
      contradictionResolutionRate: Math.round(contradictionResolutionRate * 10) / 10,
      predictionAccuracy: Math.round(predictionAccuracy * 10) / 10,
      criticalThinkingLevel: Math.round(criticalThinkingLevel * 10) / 10,
    },
  };
}

/**
 * Dimension 3: Reasoning Rigor (Agent 0 — Reasoner)
 * How well does she stress-test ideas?
 */
function computeReasoningRigor(): EvalDimension {
  const debates = getDebates();
  const lab = getResearchLab();

  // Average debate consensus: mean consensusStrength across last 10 debates, scaled 0–100
  const recentDebates = debates.slice(-10);
  let avgDebateConsensus = 50; // neutral default
  if (recentDebates.length > 0) {
    const consensusValues = recentDebates
      .filter(d => d.dualDebate?.crossScore?.consensusStrength != null)
      .map(d => d.dualDebate!.crossScore.consensusStrength);
    if (consensusValues.length > 0) {
      const mean = consensusValues.reduce((a, b) => a + b, 0) / consensusValues.length;
      avgDebateConsensus = clamp((mean / 10) * 100); // consensusStrength is 0-10
    }
  }

  // Hypothesis test rate: hypotheses that reached "testing" or beyond / total formed in 30d
  const hypotheses = lab.hypotheses || [];
  const thirtyDaysAgo = daysAgo(30);
  const recentHypotheses = hypotheses.filter(h => new Date(h.formedAt).getTime() > thirtyDaysAgo);
  const testedOrBeyond = recentHypotheses.filter(
    h => h.status === "testing" || h.status === "confirmed" || h.status === "rejected"
  ).length;
  const hypothesisTestRate = recentHypotheses.length > 0
    ? clamp((testedOrBeyond / recentHypotheses.length) * 100)
    : 50; // neutral if no recent hypotheses

  // Trust score average: mean trust score of confirmed hypotheses in last 30d
  const confirmedRecent = hypotheses.filter(
    h => h.status === "confirmed" && h.resolvedAt && new Date(h.resolvedAt).getTime() > thirtyDaysAgo
  );
  let trustScoreAvg = 50; // neutral default
  if (confirmedRecent.length > 0) {
    const trustScores = confirmedRecent
      .filter((h: any) => h.trustScore != null)
      .map((h: any) => h.trustScore as number);
    if (trustScores.length > 0) {
      trustScoreAvg = clamp(trustScores.reduce((a, b) => a + b, 0) / trustScores.length);
    }
  }

  const score = clamp(
    avgDebateConsensus * 0.30 +
    hypothesisTestRate * 0.35 +
    trustScoreAvg * 0.35
  );

  return {
    name: "Reasoning Rigor",
    key: "reasoningRigor",
    score: Math.round(score * 10) / 10,
    components: {
      avgDebateConsensus: Math.round(avgDebateConsensus * 10) / 10,
      hypothesisTestRate: Math.round(hypothesisTestRate * 10) / 10,
      trustScoreAvg: Math.round(trustScoreAvg * 10) / 10,
    },
  };
}

/**
 * Dimension 4: Intellectual Honesty (Agent 0 — Reasoner)
 * Does she correct herself and prune bad ideas?
 */
function computeIntellectualHonesty(): EvalDimension {
  const corrections = getCorrections();
  const contradictions = getContradictions();
  const insights = getEvolutionInsights();
  const lab = getResearchLab();

  const thirtyDaysAgo = daysAgo(30);

  // Correction rate: corrections in 30d / (corrections + open contradictions)
  const recentCorrections = (corrections.corrections || []).filter(
    c => c.correctionDate > thirtyDaysAgo
  );
  const openContradictions = contradictions.filter(c => c.status === "open");
  const correctionDenom = recentCorrections.length + openContradictions.length;
  const correctionRate = correctionDenom > 0
    ? clamp((recentCorrections.length / correctionDenom) * 100)
    : 50; // neutral

  // Insight validation rate: validated / (validated + dismissed)
  const allInsights = insights.insights || [];
  const validated = allInsights.filter(i => i.status === "validated").length;
  const dismissed = allInsights.filter(i => i.status === "dismissed").length;
  const insightDenom = validated + dismissed;
  const insightValidationRate = insightDenom > 0
    ? clamp((validated / insightDenom) * 100)
    : 50; // neutral

  // Pruning health: rejected / (rejected + stuck_forming_7d+)
  const hypotheses = lab.hypotheses || [];
  const sevenDaysAgo = daysAgo(7);
  const rejected = hypotheses.filter(h => h.status === "rejected").length;
  const stuckForming = hypotheses.filter(
    h => h.status === "forming" && new Date(h.formedAt).getTime() < sevenDaysAgo
  ).length;
  const pruningDenom = rejected + stuckForming;
  const pruningHealth = pruningDenom > 0
    ? clamp((rejected / pruningDenom) * 100)
    : 50; // neutral — no stuck hypotheses is fine

  const score = clamp(
    correctionRate * 0.30 +
    insightValidationRate * 0.35 +
    pruningHealth * 0.35
  );

  return {
    name: "Intellectual Honesty",
    key: "intellectualHonesty",
    score: Math.round(score * 10) / 10,
    components: {
      correctionRate: Math.round(correctionRate * 10) / 10,
      insightValidationRate: Math.round(insightValidationRate * 10) / 10,
      pruningHealth: Math.round(pruningHealth * 10) / 10,
      // Diagnostic counts so operators can distinguish "zero because no
      // qualifying events" from "zero because the recorder is unwired".
      correctionsCount30d: recentCorrections.length,
      openContradictionsCount: openContradictions.length,
    },
  };
}

/**
 * Dimension 5: Voice Evolution (Agent 6 — Writer)
 * Is her communication getting stronger?
 */
function computeVoiceEvolution(): EvalDimension {
  const journal = getVoiceJournal();
  const rules = getStyleRules();
  const reflectionStats = getReflectionStats();

  // Average trait strength: mean of active trait strengths / 10 * 100
  const traits = journal.currentVoiceTraits || [];
  let avgTraitStrength = 50; // neutral default
  if (traits.length > 0) {
    const mean = traits.reduce((a, t) => a + t.strength, 0) / traits.length;
    avgTraitStrength = clamp((mean / 10) * 100);
  }

  // Style rule maturity: high-confidence rules / total rules
  const highConfidence = rules.filter(r => r.confidence === "high").length;
  const totalRules = rules.length;
  const styleRuleMaturity = totalRules > 0
    ? clamp((highConfidence / totalRules) * 100)
    : 50; // neutral

  // Score trend: 7d avg score / 10 * 100, with trend bonus/penalty
  const baseScoreTrend = clamp((reflectionStats.avgPostScore7d / 10) * 100);
  let trendBonus = 0;
  if (reflectionStats.scoreTrend === "improving") trendBonus = 10;
  else if (reflectionStats.scoreTrend === "declining") trendBonus = -10;
  const scoreTrend = clamp(baseScoreTrend + trendBonus);

  const score = clamp(
    avgTraitStrength * 0.30 +
    styleRuleMaturity * 0.30 +
    scoreTrend * 0.40
  );

  return {
    name: "Voice Evolution",
    key: "voiceEvolution",
    score: Math.round(score * 10) / 10,
    components: {
      avgTraitStrength: Math.round(avgTraitStrength * 10) / 10,
      styleRuleMaturity: Math.round(styleRuleMaturity * 10) / 10,
      scoreTrend: Math.round(scoreTrend * 10) / 10,
    },
  };
}

/**
 * Dimension 6: Audience Impact (Agent 6 — Writer)
 * Is her content actually landing?
 */
function computeAudienceImpact(): EvalDimension {
  const history = getEvolutionHistory();
  const profile = getCompetencyProfile();
  const breakthroughs = getBreakthroughs();
  const lab = getResearchLab();

  const snapshots = history.snapshots || [];
  const thirtyDaysAgo = daysAgo(30);

  // Engagement trend: latest avgEngagement / peak avgEngagement in 30d
  const recentSnapshots = snapshots.filter(s => new Date(s.date).getTime() > thirtyDaysAgo);
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const latestEngagement = latest?.avgEngagement ?? 0;
  const peakEngagement = recentSnapshots.length > 0
    ? Math.max(...recentSnapshots.map(s => s.avgEngagement))
    : 1;
  const engagementTrend = clamp(safeDiv(latestEngagement, Math.max(peakEngagement, 1)) * 100);

  // Competency growth: avg level now vs 30d ago
  const comps = profile.competencies || [];
  const avgLevelNow = comps.length > 0
    ? comps.reduce((a, c) => a + c.currentLevel, 0) / comps.length
    : 5;
  // Estimate avg level 30d ago from level history
  const historyEntries = profile.levelHistory || [];
  const entriesOlderThan30d = historyEntries.filter(
    e => new Date(e.timestamp).getTime() < thirtyDaysAgo
  );
  // If we have old entries, reconstruct approximate old average
  let avgLevel30dAgo = avgLevelNow; // default: no growth
  if (entriesOlderThan30d.length > 0) {
    // Sum of net deltas applied in last 30 days
    const recentDeltas = historyEntries.filter(
      e => new Date(e.timestamp).getTime() > thirtyDaysAgo
    );
    const netDelta = recentDeltas.reduce((a, e) => a + (e.newLevel - e.oldLevel), 0);
    const avgDelta = comps.length > 0 ? netDelta / comps.length : 0;
    avgLevel30dAgo = avgLevelNow - avgDelta;
  }
  const competencyGrowth = clamp(((avgLevelNow - avgLevel30dAgo) / 10) * 100);

  // Breakthrough rate: breakthroughs in 30d / hypotheses confirmed in 30d
  const recentBreakthroughs = (breakthroughs.breakthroughs || []).filter(
    b => b.detectedAt > thirtyDaysAgo
  );
  const hypotheses = lab.hypotheses || [];
  const confirmedRecent = hypotheses.filter(
    h => h.status === "confirmed" && h.resolvedAt && new Date(h.resolvedAt).getTime() > thirtyDaysAgo
  ).length;
  const breakthroughRate = clamp(
    safeDiv(recentBreakthroughs.length, Math.max(confirmedRecent, 1)) * 100
  );

  const score = clamp(
    engagementTrend * 0.35 +
    competencyGrowth * 0.30 +
    breakthroughRate * 0.35
  );

  return {
    name: "Audience Impact",
    key: "audienceImpact",
    score: Math.round(score * 10) / 10,
    components: {
      engagementTrend: Math.round(engagementTrend * 10) / 10,
      competencyGrowth: Math.round(competencyGrowth * 10) / 10,
      breakthroughRate: Math.round(breakthroughRate * 10) / 10,
      // Diagnostic counts so operators can distinguish "zero because no
      // qualifying events" from "zero because the detector is unwired".
      breakthroughsCount30d: recentBreakthroughs.length,
      confirmedHypothesesCount30d: confirmedRecent,
    },
  };
}

// -- Composite & Calibration -------------------------------------------------

function computeComposite(dimensions: EvalDimension[]): number {
  let total = 0;
  for (const dim of dimensions) {
    const w = DIMENSION_WEIGHTS[dim.key] ?? 0;
    total += dim.score * w;
  }
  return Math.round(total * 10) / 10;
}

function findWeakest(dimensions: EvalDimension[]): EvalDimension {
  return dimensions.reduce((min, d) => d.score < min.score ? d : min, dimensions[0]);
}

const CALIBRATION_DIRECTIVES: Record<string, string> = {
  signalAcquisition:   "Your research pipeline is slowing — prioritize exploring new source categories this cycle.",
  sourceIntegrity:     "Source credibility is dipping — focus on resolving open contradictions and verifying predictions.",
  reasoningRigor:      "Reasoning depth is low — run more debates and push forming hypotheses to testing.",
  intellectualHonesty: "You have stale hypotheses accumulating — prioritize pruning or resolving stuck claims.",
  voiceEvolution:      "Your voice traits are flattening — lean harder into what's working in your top-performing posts.",
  audienceImpact:      "Audience engagement is softening — analyze what recent high-performers had in common.",
};

// -- Drift Detection ---------------------------------------------------------

function computeDrift(current: number, history: EvalResult[]): DriftStatus {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 86_400_000;
  const thirtyDaysAgo = now - 30 * 86_400_000;

  const scores7d = history
    .filter(r => new Date(r.timestamp).getTime() > sevenDaysAgo)
    .map(r => r.composite);
  const scores30d = history
    .filter(r => new Date(r.timestamp).getTime() > thirtyDaysAgo)
    .map(r => r.composite);

  const avg7d  = scores7d.length > 0  ? scores7d.reduce((a, b) => a + b, 0) / scores7d.length   : current;
  const avg30d = scores30d.length > 0 ? scores30d.reduce((a, b) => a + b, 0) / scores30d.length : current;

  const delta7d = current - avg7d;

  let direction: DriftStatus["direction"] = "stable";
  if (delta7d > 5) direction = "improving";
  else if (delta7d < -5) direction = "declining";

  return {
    direction,
    avg7d:  Math.round(avg7d * 10) / 10,
    avg30d: Math.round(avg30d * 10) / 10,
    delta7d: Math.round(delta7d * 10) / 10,
  };
}

// -- Main Entry Point --------------------------------------------------------

/**
 * Run the full 306Eval benchmark. Computes all 6 dimensions, composite score,
 * drift detection, and calibration directive. Writes results to disk.
 * This is a synchronous, pure-computation function — no LLM calls.
 */
export function run306Eval(): EvalResult {
  console.log("[306Eval] Computing benchmark dimensions...");

  const dimensions: EvalDimension[] = [
    computeSignalAcquisition(),
    computeSourceIntegrity(),
    computeReasoningRigor(),
    computeIntellectualHonesty(),
    computeVoiceEvolution(),
    computeAudienceImpact(),
  ];

  const composite = computeComposite(dimensions);
  const weakest = findWeakest(dimensions);

  // Load history for drift detection
  const store = loadHistory();
  const drift = computeDrift(composite, store.results);
  const calibrationDirective = CALIBRATION_DIRECTIVES[weakest.key]
    ?? "Continue balanced growth across all dimensions.";

  const result: EvalResult = {
    id: `eval_${Date.now()}`,
    timestamp: new Date().toISOString(),
    dimensions,
    composite,
    weakestDimension: weakest.key,
    calibrationDirective,
    drift,
  };

  // Append to history (newest first, cap at 90 entries)
  store.results.unshift(result);
  if (store.results.length > HISTORY_CAP) {
    store.results = store.results.slice(0, HISTORY_CAP);
  }
  saveHistory(store);

  console.log(`[306Eval] Benchmark complete: ${composite}/100`);
  console.log(`[306Eval] Weakest: ${weakest.name} (${weakest.score})`);
  console.log(`[306Eval] Drift: ${drift.direction} (Δ7d: ${drift.delta7d})`);
  console.log(`[306Eval] Directive: ${calibrationDirective}`);

  return result;
}

// -- Public Readers ----------------------------------------------------------

/** Returns the latest eval result plus the last 7 entries from history. */
export function get306EvalResults(): { latest: EvalResult | null; recent: EvalResult[] } {
  const store = loadHistory();
  return {
    latest: store.results[0] ?? null,
    recent: store.results.slice(0, 7),
  };
}

/** Returns the full 90-day eval history. */
export function get306EvalHistory(): EvalResult[] {
  const store = loadHistory();
  return store.results;
}
