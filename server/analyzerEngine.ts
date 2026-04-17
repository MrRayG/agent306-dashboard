/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — ANALYZER ENGINE (ASI-Evolve Upgrade 2)
 *
 *  Structured post-mortem analysis for every research advance,
 *  podcast episode, and daily cycle. Produces AnalyzerNodes
 *  with scores, findings, root causes, patterns, and
 *  recommendations.
 *
 *  Inspired by the ASI-Evolve paper — building a reusable
 *  knowledge layer on top of every action Agent 306 takes.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import type { ResearchThread } from "./research-agenda.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
const ANALYZER_FILE = dataPath("analyzer_nodes.json");
const MAX_NODES = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnalyzerNode {
  id: string;
  type: "research_thread" | "podcast_episode" | "exploration_round" | "daily_cycle";
  sourceId: string;
  sourceTitle: string;
  motivation: string;
  outcome: {
    score: number;
    keyFindings: string[];
    surprises: string[];
    failures: string[];
  };
  analysis: {
    rootCauses: string[];
    patterns: string[];
    recommendations: string[];
    knowledgeGaps: string[];
  };
  createdAt: string;
  duration?: number;
  tokensUsed?: number;
  modelUsed?: string;
}

interface AnalyzerState {
  nodes: AnalyzerNode[];
  stats: {
    totalNodes: number;
    avgScore: number;
    topPatterns: string[];
  };
  lastAnalyzedAt: string | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadState(): AnalyzerState {
  try {
    if (fs.existsSync(ANALYZER_FILE))
      return JSON.parse(fs.readFileSync(ANALYZER_FILE, "utf8"));
  } catch {}
  return {
    nodes: [],
    stats: { totalNodes: 0, avgScore: 0, topPatterns: [] },
    lastAnalyzedAt: null,
  };
}

function saveState(s: AnalyzerState): void {
  try { fs.writeFileSync(ANALYZER_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

function addNode(node: AnalyzerNode): void {
  state.nodes.unshift(node);

  // Cap at MAX_NODES
  if (state.nodes.length > MAX_NODES) {
    state.nodes = state.nodes.slice(0, MAX_NODES);
  }

  // Update stats
  state.stats.totalNodes = state.nodes.length;
  const scores = state.nodes.map(n => n.outcome.score).filter(s => s > 0);
  state.stats.avgScore = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0;
  state.stats.topPatterns = getTopPatternsInternal(10);
  state.lastAnalyzedAt = node.createdAt;

  saveState(state);
}

function getTopPatternsInternal(limit: number): string[] {
  const freq: Record<string, number> = {};
  for (const node of state.nodes) {
    for (const pattern of (node.analysis.patterns || [])) {
      freq[pattern] = (freq[pattern] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
}

// ── LLM Analysis ──────────────────────────────────────────────────────────────

const ANALYZER_SYSTEM_PROMPT = `You are Agent 306's Analyzer — your job is to distill the outcome of an action into reusable lessons.

You receive: what was attempted (motivation), what happened (raw output/results), and the context.

Produce a structured analysis as JSON:
{
  "score": <0-1 quality score>,
  "keyFindings": ["main discoveries"],
  "surprises": ["unexpected things"],
  "failures": ["what didn't work"],
  "rootCauses": ["why things succeeded/failed"],
  "patterns": ["repeatable patterns — things Agent 306 should do again or avoid"],
  "recommendations": ["specific next actions"],
  "knowledgeGaps": ["what's still unknown"]
}

Rules:
- Be specific, not generic. "Use more data sources" is bad. "The Perplexity search returned thin results on RL papers — try arXiv directly" is good.
- Focus on CAUSAL analysis — why, not just what.
- Patterns should be generalizable across future research, not specific to this one topic.
- Score honestly: 0.0-0.3 = poor/wasted, 0.4-0.6 = adequate, 0.7-0.9 = good, 1.0 = exceptional.
- Return ONLY valid JSON — no markdown fences, no explanation.`;

async function runAnalysis(
  type: AnalyzerNode["type"],
  sourceId: string,
  sourceTitle: string,
  motivation: string,
  outcomeDescription: string,
): Promise<AnalyzerNode | null> {
  const startTime = Date.now();
  const model = getModel("reflection");

  try {
    const res = await postChatCompletions({
        model,
        messages: [
          { role: "system", content: ANALYZER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `ANALYZE THIS ${type.toUpperCase().replace("_", " ")}:

TITLE: ${sourceTitle}
MOTIVATION: ${motivation}

OUTCOME/RESULTS:
${outcomeDescription}

Produce your structured analysis as JSON.`,
          },
        ],
        temperature: 0.4,
        max_tokens: 1500,
      }, AbortSignal.timeout(45000));

    if (!res.ok) {
      console.warn(`[Analyzer] LLM error ${res.status} for ${type}:${sourceId}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(content, "Analyzer");

    const tokensUsed = (data.usage?.total_tokens as number | undefined) || 0;

    const node: AnalyzerNode = {
      id: `node_${Date.now()}`,
      type,
      sourceId,
      sourceTitle,
      motivation,
      outcome: {
        score: Math.max(0, Math.min(1, parsed.score ?? 0.5)),
        keyFindings: parsed.keyFindings ?? [],
        surprises: parsed.surprises ?? [],
        failures: parsed.failures ?? [],
      },
      analysis: {
        rootCauses: parsed.rootCauses ?? [],
        patterns: parsed.patterns ?? [],
        recommendations: parsed.recommendations ?? [],
        knowledgeGaps: parsed.knowledgeGaps ?? [],
      },
      createdAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      tokensUsed,
      modelUsed: model,
    };

    addNode(node);
    console.log(`[Analyzer] ${type} "${sourceTitle}" — score: ${node.outcome.score.toFixed(2)}, patterns: ${node.analysis.patterns.length}`);
    return node;
  } catch (e: any) {
    console.warn(`[Analyzer] Analysis failed for ${type}:${sourceId}:`, e.message);
    return null;
  }
}

// ── Public analysis functions ─────────────────────────────────────────────────

/**
 * Analyze a completed research thread advance.
 */
export async function analyzeResearchAdvance(
  thread: ResearchThread,
  advanceResult: any,
): Promise<AnalyzerNode | null> {
  const motivation = `Advancing research thread "${thread.title}" — thesis: ${thread.thesis}. ` +
    `Gaps investigated: ${thread.evidence.gaps.slice(0, 3).join("; ") || "none specified"}`;

  const outcome = [
    `Findings: ${advanceResult.findings ?? "none"}`,
    `Updated thesis: ${advanceResult.updatedThesis ?? "unchanged"}`,
    `New supporting evidence: ${(advanceResult.newSupportingEvidence ?? []).length} items`,
    `New contradicting evidence: ${(advanceResult.newContradictingEvidence ?? []).length} items`,
    `Resolved gaps: ${(advanceResult.resolvedGaps ?? []).length}`,
    `New gaps: ${(advanceResult.newGaps ?? []).length}`,
    `Maturity delta: ${advanceResult.maturityDelta ?? 0}`,
    `Status recommendation: ${advanceResult.statusRecommendation ?? "none"}`,
    advanceResult.spawnSubThread?.title
      ? `Spawned sub-thread: "${advanceResult.spawnSubThread.title}"`
      : "",
  ].filter(Boolean).join("\n");

  return runAnalysis("research_thread", thread.id, thread.title, motivation, outcome);
}

/**
 * Analyze a completed podcast episode.
 */
export async function analyzePodcastEpisode(
  episodeId: string,
  script: string,
  topic: string,
): Promise<AnalyzerNode | null> {
  // Truncate script to avoid token limits
  const truncatedScript = script.length > 2000 ? script.slice(0, 2000) + "..." : script;

  const motivation = `Generating podcast episode on: ${topic}`;
  const outcome = `Episode script (truncated):\n${truncatedScript}`;

  return runAnalysis("podcast_episode", episodeId, topic, motivation, outcome);
}

/**
 * Analyze a daily cycle run.
 */
export async function analyzeDailyCycle(cycleResults: any): Promise<AnalyzerNode | null> {
  const briefing = cycleResults;
  const motivation = "Running daily intelligence cycle — gathering signals, advancing research, generating briefing";

  const outcome = [
    `Today's action: ${briefing.todaysAction?.action ?? "none"}`,
    `Priority: ${briefing.todaysAction?.priority ?? "unknown"}`,
    `Hypothesis updates: ${(briefing.hypothesisUpdates ?? []).length}`,
    `Research completions: ${(briefing.researchCompletions ?? []).length}`,
    `Goals tracked: ${(briefing.goalProgress ?? []).length}`,
    `KB stats: ${briefing.kbStats?.active ?? 0} active, ${briefing.kbStats?.archived ?? 0} archived`,
  ].join("\n");

  return runAnalysis("daily_cycle", briefing.id ?? `cycle_${Date.now()}`, "Daily Intelligence Cycle", motivation, outcome);
}

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Get recent analyzer nodes, optionally filtered by type.
 */
export function getRecentAnalysis(
  type?: AnalyzerNode["type"] | string,
  limit = 20,
): AnalyzerNode[] {
  let nodes = state.nodes;
  if (type) {
    nodes = nodes.filter(n => n.type === type);
  }
  return nodes.slice(0, limit);
}

/**
 * Get patterns aggregated across all nodes with frequency and average score.
 */
export function getAggregatedPatterns(): Array<{
  pattern: string;
  frequency: number;
  avgScore: number;
}> {
  const patternData: Record<string, { count: number; totalScore: number }> = {};

  for (const node of state.nodes) {
    for (const pattern of (node.analysis.patterns || [])) {
      if (!patternData[pattern]) patternData[pattern] = { count: 0, totalScore: 0 };
      patternData[pattern].count++;
      patternData[pattern].totalScore += node.outcome.score;
    }
  }

  return Object.entries(patternData)
    .map(([pattern, data]) => ({
      pattern,
      frequency: data.count,
      avgScore: data.totalScore / data.count,
    }))
    .sort((a, b) => b.frequency - a.frequency);
}

/**
 * Get analysis context string for prompt injection into research/podcast prompts.
 */
export function getAnalysisContext(type?: string, limit = 5): string {
  const recentNodes = getRecentAnalysis(type as AnalyzerNode["type"], limit);
  if (recentNodes.length === 0) return "";

  const patterns = getAggregatedPatterns().slice(0, 8);

  let ctx = "";

  if (patterns.length > 0) {
    ctx += "TOP PATTERNS FROM PAST ANALYSIS:\n";
    for (const p of patterns) {
      ctx += `- ${p.pattern} (seen ${p.frequency}x, avg score: ${p.avgScore.toFixed(2)})\n`;
    }
    ctx += "\n";
  }

  ctx += `RECENT ANALYSIS SCORES (last ${recentNodes.length}):\n`;
  for (const node of recentNodes) {
    ctx += `- [${node.type}] "${node.sourceTitle}" — score: ${node.outcome.score.toFixed(2)}`;
    if (node.analysis.recommendations.length > 0) {
      ctx += ` | rec: ${node.analysis.recommendations[0]}`;
    }
    ctx += "\n";
  }

  return ctx;
}
