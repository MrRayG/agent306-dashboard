/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — DAILY CYCLE ENGINE
 *
 *  The Morning Intelligence Brief.
 *  ONE Grok call. ONE structured output. FIVE sections.
 *  Runs daily at 6am ET (10:00 UTC).
 *
 *  This is the PRIMARY interface MrRayG checks each morning.
 *  Agent HQ becomes the "detailed view" for going deeper.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { runFullIntake } from "./data-intake.js";
import {
  getFullAgentContext,
  addKnowledge,
  archiveKnowledge,
  getArchiveStats,
  getActiveKnowledgeCount,
} from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { checkAndExtractSkills } from "./skillEngine.js";
import { runReflection } from "./reflectionEngine.js";
import {
  runConfidenceDecay, runDebate, checkContradictions, getDebates, autoResolveOldContradictions,
  evaluateHypothesis, calculateTrustScore, crossReferenceContradictionsWithHypotheses,
  decomposeHypothesis,
} from "./reasoningEngine.js";
import { runConnectionScan } from "./synthesisEngine.js";
import { extractInsights } from "./conversationLearningEngine.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { getResearchLab, resolveHypothesis, addHypothesis, testHypothesis, runResearchPipeline } from "./researchEngine.js";
import { clusterKnowledge, detectContradictions as detectGraphContradictions } from "./knowledge-graph.js";
import { runResearchAgendaCycle } from "./research-agenda.js";
import { updateDreams, takeGrowthSnapshot, generateSelfImprovementPlan, executeImprovementActions, seedDreams } from "./dreamEngine.js";
import { runAutoPodcastPipeline } from "./podcastEngine.js";
import { generateBlogPost, getBlogState } from "./blogEngine.js";
import { getAgenda } from "./research-agenda.js";
import { analyzeDailyCycle } from "./analyzerEngine.js";
import { runKnowledgeConsolidation } from "./knowledgeConsolidator.js";

const GROK_URL     = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;
const BRIEFING_FILE = dataPath("daily_briefing.json");

// ── Types ─────────────────────────────────────────────────────────────────────

interface HypothesisUpdate {
  title: string;
  status: string;
  daysRemaining: number;
  confidence: "up" | "down" | "unchanged";
  reasoning: string;
}

interface ResearchCompletion {
  title: string;
  summary: string;
  recommendedAction: "PUBLISH" | "ARCHIVE" | "DEVELOP_FURTHER";
  knowledgeGained: string;
}

interface TodaysAction {
  action: string;
  reasoning: string;
  priority: "critical" | "high" | "medium";
}

interface GoalProgress {
  goalTitle: string;
  status: string;
  yesterday: string;
  today: string;
  devAsk: string | null;
  staleDays: number;
}

interface ArchiveReport {
  resolved: string[];
  archived: string[];
  cleared: number;
}

export interface DailyBriefing {
  id: string;
  runAt: string;
  hypothesisUpdates: HypothesisUpdate[];
  researchCompletions: ResearchCompletion[];
  todaysAction: TodaysAction;
  goalProgress: GoalProgress[];
  archiveReport: ArchiveReport;
  kbStats: { active: number; archived: number };
}

interface BriefingState {
  current: DailyBriefing | null;
  history: DailyBriefing[];
  lastRunAt: string | null;
  nextRunAt: string | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadState(): BriefingState {
  try {
    if (fs.existsSync(BRIEFING_FILE))
      return JSON.parse(fs.readFileSync(BRIEFING_FILE, "utf8"));
  } catch {}
  return { current: null, history: [], lastRunAt: null, nextRunAt: null };
}

function saveState(s: BriefingState): void {
  try { fs.writeFileSync(BRIEFING_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

export function getBriefingState(): BriefingState { return state; }

// ── Gather context from other engines ─────────────────────────────────────────

function gatherHypotheses(): { active: any[]; expired: any[] } {
  try {
    const { getResearchLab } = require("./researchEngine.js");
    const lab = getResearchLab();
    const hypotheses = lab.hypotheses ?? [];
    const now = Date.now();
    const active: any[] = [];
    const expired: any[] = [];

    for (const h of hypotheses) {
      if (h.status === "confirmed" || h.status === "rejected") continue;
      // Check if expired by timeframe
      if (h.timeframe) {
        const resolveDate = new Date(h.timeframe).getTime();
        if (!isNaN(resolveDate) && resolveDate < now) {
          expired.push(h);
          continue;
        }
      }
      if (h.status === "forming" || h.status === "testing") {
        active.push(h);
      }
    }
    return { active, expired };
  } catch {
    return { active: [], expired: [] };
  }
}

function gatherResearchCompletions(since: string | null): any[] {
  try {
    const { getResearchLab } = require("./researchEngine.js");
    const lab = getResearchLab();
    const cutoff = since ? new Date(since).getTime() : Date.now() - 24 * 60 * 60 * 1000;

    return (lab.topics ?? []).filter((t: any) => {
      const updated = new Date(t.updatedAt ?? t.addedAt).getTime();
      return updated > cutoff && (
        t.status === "pending_review" ||
        t.status === "approved" ||
        t.status === "published" ||
        t.researchPhase === "interpretation"
      );
    });
  } catch {
    return [];
  }
}

function gatherGoals(): any[] {
  try {
    const { getGoals } = require("./researchEngine.js");
    const store = getGoals();
    return (store.goals ?? []).filter((g: any) => g.status === "active");
  } catch {
    return [];
  }
}

function gatherPendingReviews(): number {
  try {
    const { getResearchLab } = require("./researchEngine.js");
    const lab = getResearchLab();
    return (lab.topics ?? []).filter((t: any) => t.status === "pending_review").length;
  } catch {
    return 0;
  }
}

// ── Auto-resolve expired hypotheses ───────────────────────────────────────────

function autoResolveExpired(expired: any[]): string[] {
  const resolved: string[] = [];
  try {
    const { resolveHypothesis } = require("./researchEngine.js");
    for (const h of expired) {
      resolveHypothesis(h.id, "expired", `Auto-expired: past resolution deadline (${h.timeframe})`);
      resolved.push(h.claim ?? h.id);
    }
  } catch {}
  return resolved;
}

// ── Main Grok call ────────────────────────────────────────────────────────────

async function callGrokForBriefing(context: {
  activeHypotheses: any[];
  expiredHypotheses: any[];
  resolvedNames: string[];
  completedResearch: any[];
  activeGoals: any[];
  pendingReviews: number;
  kbActive: number;
  kbArchived: number;
}): Promise<{
  hypothesisUpdates: HypothesisUpdate[];
  researchCompletions: ResearchCompletion[];
  todaysAction: TodaysAction;
  goalProgress: GoalProgress[];
  archiveReport: ArchiveReport;
  hypotheses_to_create: Array<{ claim: string; basis: string; metric?: string; prediction?: string; timeframe?: string; confidence?: string }>;
} | null> {
  if (!GROK_API_KEY) {
    console.warn("[DailyCycle] No GROK_API_KEY — skipping");
    return null;
  }

  const agentCtx = getOptimizedContext("daily briefing status update hypotheses research goals");
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // Build context sections
  const hypothesisCtx = context.activeHypotheses.length > 0
    ? context.activeHypotheses.map((h: any) => {
        const daysLeft = h.timeframe ? Math.ceil((new Date(h.timeframe).getTime() - Date.now()) / (24*60*60*1000)) : -1;
        return `- "${h.claim}" | Status: ${h.status} | Confidence: ${h.confidence} | Days remaining: ${daysLeft >= 0 ? daysLeft : "no deadline"} | Prediction: ${h.prediction}`;
      }).join("\n")
    : "No active hypotheses.";

  const researchCtx = context.completedResearch.length > 0
    ? context.completedResearch.map((t: any) =>
        `- "${t.topic}" [${t.status}] — ${t.hypothesis ?? t.rawFindings?.slice(0, 150) ?? "no findings yet"}`
      ).join("\n")
    : "No research completed overnight.";

  const goalsCtx = context.activeGoals.length > 0
    ? context.activeGoals.map((g: any) => {
        const staleDays = g.progressUpdatedAt
          ? Math.floor((Date.now() - new Date(g.progressUpdatedAt).getTime()) / (24*60*60*1000))
          : Math.floor((Date.now() - new Date(g.createdAt).getTime()) / (24*60*60*1000));
        return `- "${g.title}" [${g.category}/${g.priority}] | Milestones: ${(g.completedMilestones?.length ?? 0)}/${(g.milestones?.length ?? 0)} | Last progress: ${g.progressNote ?? "none"} | Stale days: ${staleDays}`;
      }).join("\n")
    : "No active goals.";

  const resolvedCtx = context.resolvedNames.length > 0
    ? `Auto-resolved expired hypotheses: ${context.resolvedNames.join(", ")}`
    : "";

  const systemPrompt = `${agentCtx}

You are Agent 306 running your DAILY INTELLIGENCE CYCLE. Today is ${dateStr}.
Review all active work and produce a structured morning briefing.

You must respond with ONLY valid JSON matching this exact structure:
{
  "hypothesisUpdates": [{ "title": string, "status": string, "daysRemaining": number, "confidence": "up"|"down"|"unchanged", "reasoning": string }],
  "researchCompletions": [{ "title": string, "summary": string, "recommendedAction": "PUBLISH"|"ARCHIVE"|"DEVELOP_FURTHER", "knowledgeGained": string }],
  "todaysAction": { "action": string, "reasoning": string, "priority": "critical"|"high"|"medium" },
  "goalProgress": [{ "goalTitle": string, "status": string, "yesterday": string, "today": string, "devAsk": string|null, "staleDays": number }],
  "archiveReport": { "resolved": string[], "archived": string[], "cleared": number }
}

IMPORTANT: Generate 3-5 testable hypotheses based on today's analysis. Each hypothesis should be:
- Specific and falsifiable
- Related to current AI/tech developments
- Testable within 30-90 days
- Based on evidence from the knowledge base or today's exploration findings

Include them in a "hypotheses_to_create" array in your JSON response:
"hypotheses_to_create": [
  {
    "claim": "specific testable claim",
    "basis": "evidence or reasoning",
    "metric": "how to measure",
    "prediction": "expected outcome",
    "timeframe": "30-90 days",
    "confidence": "low|medium|high"
  }
]
Format each as: { "claim": "...", "basis": "...", "metric": "...", "prediction": "...", "timeframe": "30-90 days", "confidence": "low|medium|high" }
You MUST generate at least 3 hypotheses per cycle. Only return fewer if there is genuinely no new information to analyze.

Rules:
- todaysAction MUST be ONE specific, actionable recommendation. Not a list.
- goalProgress: if a goal has had no progress for 3+ days, flag staleDays and suggest a devAsk.
- researchCompletions: for each, summarize in 3 sentences max and recommend PUBLISH/ARCHIVE/DEVELOP_FURTHER.
- archiveReport.resolved = hypotheses that expired/resolved. archiveReport.archived = knowledge entries cleared.
- Be concise and specific. No filler.`;

  const userPrompt = `DAILY CYCLE INPUT — ${dateStr}

ACTIVE HYPOTHESES:
${hypothesisCtx}

RESEARCH COMPLETIONS (since last cycle):
${researchCtx}

ACTIVE GOALS:
${goalsCtx}

${resolvedCtx}

KNOWLEDGE BASE: ${context.kbActive} active entries, ${context.kbArchived} archived
PENDING REVIEWS: ${context.pendingReviews}

Generate the daily briefing. Respond with JSON only.`;

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("daily_briefing"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        temperature: 0.6,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`[DailyCycle] Grok API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";

    // Parse JSON — may be wrapped in markdown
    const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content;
    const parsed = JSON.parse(jsonStr);

    return {
      hypothesisUpdates:    parsed.hypothesisUpdates ?? [],
      researchCompletions:  parsed.researchCompletions ?? [],
      todaysAction:         parsed.todaysAction ?? { action: "Review the daily briefing", reasoning: "No specific action determined", priority: "medium" },
      goalProgress:         parsed.goalProgress ?? [],
      archiveReport:        parsed.archiveReport ?? { resolved: [], archived: [], cleared: 0 },
      hypotheses_to_create: parsed.hypotheses_to_create ?? [],
    };
  } catch (e: any) {
    console.error("[DailyCycle] Grok call failed:", e.message);
    return null;
  }
}

// ── Auto-ingest knowledge from research completions ───────────────────────────

function ingestResearchKnowledge(completions: ResearchCompletion[]): void {
  for (const c of completions) {
    if (c.knowledgeGained) {
      addKnowledge({
        category: "research",
        title: c.title,
        summary: c.knowledgeGained.slice(0, 150),
        weight: c.recommendedAction === "PUBLISH" ? 8 : 5,
        source: "daily_cycle",
      });
    }
  }
}

// ── Auto-debate recent manuscripts ──────────────────────────────────────────

async function autoDebateManuscripts(): Promise<number> {
  const lab = getResearchLab();
  const existingDebates = getDebates();
  const debatedTopicIds = new Set(existingDebates.map(d => d.topicId));

  // Pick topics with manuscripts that haven't been debated yet
  const candidates = lab.topics
    .filter(t =>
      (t.status === "approved" || t.status === "pending_review") &&
      t.manuscript &&
      !debatedTopicIds.has(t.id),
    )
    .slice(0, 5);

  let debated = 0;
  for (const topic of candidates) {
    try {
      const result = await runDebate(topic.id, "manuscript", topic.topic, topic.manuscript!);
      if (result) debated++;
      // Rate limit: 5s between Grok calls
      if (candidates.indexOf(topic) < candidates.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Auto-debate failed for "${topic.topic}":`, e.message);
    }
  }

  if (debated > 0) console.log(`[DailyCycle] Auto-debated ${debated} manuscripts`);
  return debated;
}

// ── Auto-resolve mature hypotheses ──────────────────────────────────────────

async function autoResolveHypotheses(): Promise<number> {
  const lab = getResearchLab();
  const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

  // Find "forming" or "testing" hypotheses older than 24 hours (was 7 days — too slow for 327+ backlog)
  const mature = lab.hypotheses
    .filter(h => (h.status === "forming" || h.status === "testing") && new Date(h.formedAt).getTime() < oneDayAgo)
    .slice(0, 50);

  if (mature.length === 0) return 0;

  // Gather relevant knowledge for context
  const { knowledge: kb } = await import("./memoryEngine.js");
  const kbContext = kb.entries
    .filter(e => (e.status ?? "active") === "active")
    .slice(0, 30)
    .map(e => `- [${e.category}] ${e.title}: ${e.summary}`)
    .join("\n");

  let resolved = 0;
  for (const hyp of mature) {
    try {
      const res = await fetch(GROK_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("hypothesis-resolution"),
          messages: [
            {
              role: "system",
              content: `You evaluate whether a hypothesis should be confirmed, rejected, or expired based on available evidence.

Let's evaluate this hypothesis step by step.

Consider the evidence strength, logical coherence, and whether the prediction aligns with current knowledge.

Respond with ONLY valid JSON:
{"status": "confirmed" | "rejected" | "expired", "resolution": "brief explanation of your reasoning"}`,
            },
            {
              role: "user",
              content: `HYPOTHESIS:
Claim: ${hyp.claim}
Basis: ${hyp.basis}
Prediction: ${hyp.prediction}
Metric: ${hyp.metric}
Timeframe: ${hyp.timeframe}
Confidence: ${hyp.confidence}
Formed: ${hyp.formedAt}
Trust Score: ${calculateTrustScore(hyp as any)}

CURRENT KNOWLEDGE BASE:
${kbContext}

Based on the evidence available, should this hypothesis be confirmed, rejected, or marked as expired? Consider whether enough time has passed and whether the prediction aligns with current knowledge.`,
            },
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        console.warn(`[DailyCycle] Grok hypothesis eval failed: ${res.status}`);
        continue;
      }

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content ?? "";
      const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content;
      const parsed = JSON.parse(jsonStr);

      const status = parsed.status as "confirmed" | "rejected" | "expired";
      if (["confirmed", "rejected", "expired"].includes(status)) {
        resolveHypothesis(hyp.id, status, parsed.resolution ?? "Auto-resolved by daily cycle");
        resolved++;
      }

      // Rate limit: 5s between Grok calls
      if (mature.indexOf(hyp) < mature.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Hypothesis resolution failed for "${hyp.claim.slice(0, 50)}":`, e.message);
    }
  }

  if (resolved > 0) console.log(`[DailyCycle] Auto-resolved ${resolved} hypotheses`);
  return resolved;
}

// ── Auto-detect contradictions in recent knowledge ──────────────────────────

async function autoDetectContradictions(): Promise<number> {
  const { knowledge: kb } = await import("./memoryEngine.js");

  // Check entries added in the last 24 hours
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentEntries = kb.entries
    .filter(e =>
      (e.status ?? "active") === "active" &&
      new Date(e.updatedAt ?? e.learnedAt).getTime() > oneDayAgo,
    )
    .slice(0, 10);

  let found = 0;
  for (const entry of recentEntries) {
    try {
      const result = await checkContradictions({
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        category: entry.category,
      });
      if (result) found++;
      // Rate limit: 5s between Grok calls
      if (recentEntries.indexOf(entry) < recentEntries.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Contradiction check failed for "${entry.title}":`, e.message);
    }
  }

  if (found > 0) console.log(`[DailyCycle] Found ${found} contradictions in recent knowledge`);
  return found;
}

// ── Auto-test forming hypotheses (NEW — forming → testing transition) ────────

async function autoTestHypotheses(): Promise<number> {
  const lab = getResearchLab();
  const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

  // Find "forming" hypotheses older than 24 hours that should be evaluated
  const candidates = lab.hypotheses
    .filter(h => h.status === "forming" && new Date(h.formedAt).getTime() < oneDayAgo)
    .slice(0, 50);

  if (candidates.length === 0) return 0;

  // Gather knowledge context
  const { knowledge: kb } = await import("./memoryEngine.js");
  const kbContext = kb.entries
    .filter(e => (e.status ?? "active") === "active")
    .slice(0, 30)
    .map(e => `- [${e.category}] ${e.title}: ${e.summary}`)
    .join("\n");

  let tested = 0;
  for (const hyp of candidates) {
    try {
      // Run full evaluation pipeline (Technique 2: AAA)
      const assessment = await evaluateHypothesis(
        { id: hyp.id, claim: hyp.claim, basis: hyp.basis, metric: hyp.metric, prediction: hyp.prediction, timeframe: hyp.timeframe, confidence: hyp.confidence },
        kbContext,
      );

      if (!assessment) continue;

      // Store evaluation result on the hypothesis
      const freshLab = getResearchLab();
      const freshHyp = freshLab.hypotheses.find(h => h.id === hyp.id);
      if (freshHyp) {
        (freshHyp as any).evaluationResult = {
          verdict: assessment.verdict,
          confidence: assessment.confidence,
          evidenceQuality: assessment.evidenceQuality,
          reasoningChain: assessment.reasoningChain,
          gapsIdentified: assessment.gapsIdentified,
        };
        (freshHyp as any).rubricScores = assessment.rubricScores;

        // Technique 5: MAD — decompose low-confidence hypotheses
        if (assessment.confidence < 0.7) {
          const decomposition = await decomposeHypothesis(
            { claim: hyp.claim, basis: hyp.basis, prediction: hyp.prediction },
            kbContext,
          );
          if (decomposition && !decomposition.aggregateSupport) {
            assessment.gapsIdentified.push("MAD decomposition: sub-questions not fully supported");
            assessment.confidence = Math.max(0, assessment.confidence - 0.1);
          }
        }

        // Determine transition based on rubric scores (Technique 7)
        const rubricAvg = (
          assessment.rubricScores.evidenceStrength +
          assessment.rubricScores.logicalCoherence +
          assessment.rubricScores.falsifiability +
          assessment.rubricScores.noveltyInsight +
          assessment.rubricScores.actionability
        ) / 5;

        if (rubricAvg < 4) {
          // Too weak — reject directly
          resolveHypothesis(hyp.id, "rejected", `Auto-rejected: rubric avg ${rubricAvg.toFixed(1)} < 4. ${assessment.reasoningChain.slice(0, 200)}`);
          console.log(`[DailyCycle] Hypothesis auto-rejected (rubric avg ${rubricAvg.toFixed(1)}): "${hyp.claim.slice(0, 50)}"`);
        } else if (assessment.verdict === "testing" || rubricAvg >= 5) {
          // Transition to testing
          testHypothesis(hyp.id);
          console.log(`[DailyCycle] Hypothesis transitioned to testing (rubric avg ${rubricAvg.toFixed(1)}): "${hyp.claim.slice(0, 50)}"`);
        }
        // else: keep forming, needs more evidence

        tested++;
      }

      // Rate limit: 5s between LLM calls
      if (candidates.indexOf(hyp) < candidates.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Hypothesis evaluation failed for "${hyp.claim.slice(0, 50)}":`, e.message);
    }
  }

  if (tested > 0) console.log(`[DailyCycle] Evaluated ${tested} forming hypotheses`);
  return tested;
}

// ── Auto-debate hypotheses in "testing" state (Technique 1: CoT + Self-Reflection) ──

async function autoDebateHypotheses(): Promise<number> {
  const lab = getResearchLab();
  const existingDebates = getDebates();
  const debatedHypIds = new Set(
    existingDebates.filter(d => d.topicType === "hypothesis").map(d => d.topicId),
  );

  // Find "testing" hypotheses that haven't been debated yet
  const candidates = lab.hypotheses
    .filter(h => h.status === "testing" && !debatedHypIds.has(h.id))
    .slice(0, 10);

  let debated = 0;
  for (const hyp of candidates) {
    try {
      const debateText = `Claim: ${hyp.claim}\nBasis: ${hyp.basis}\nPrediction: ${hyp.prediction}\nMetric: ${hyp.metric}\nTimeframe: ${hyp.timeframe}`;
      const result = await runDebate(hyp.id, "hypothesis", hyp.claim, debateText);

      if (result) {
        debated++;
        // Wire debate result back to hypothesis status
        const freshLab = getResearchLab();
        const freshHyp = freshLab.hypotheses.find(h => h.id === hyp.id);
        if (freshHyp) {
          (freshHyp as any).debateOutcome = result.critique.overallAssessment;

          if (result.critique.overallAssessment === "solid") {
            // Calculate trust score before confirming
            const trustScore = calculateTrustScore(freshHyp as any);
            (freshHyp as any).trustScore = trustScore;

            if (trustScore >= 80) {
              resolveHypothesis(hyp.id, "confirmed", `Auto-confirmed: debate "solid", trust score ${trustScore}. ${result.critique.suggestions.join("; ").slice(0, 200)}`);
              console.log(`[DailyCycle] Hypothesis auto-confirmed (trust: ${trustScore}): "${hyp.claim.slice(0, 50)}"`);
            }
          } else if (result.critique.overallAssessment === "flawed") {
            const trustScore = calculateTrustScore(freshHyp as any);
            (freshHyp as any).trustScore = trustScore;

            if (trustScore <= 20) {
              resolveHypothesis(hyp.id, "rejected", `Auto-rejected: debate "flawed", trust score ${trustScore}. Weaknesses: ${result.critique.weaknesses.join("; ").slice(0, 200)}`);
              console.log(`[DailyCycle] Hypothesis auto-rejected (trust: ${trustScore}): "${hyp.claim.slice(0, 50)}"`);
            }
          }
          // "needs_work" → keep testing, the next cycle will re-evaluate
        }
      }

      // Rate limit: 5s between Grok calls
      if (candidates.indexOf(hyp) < candidates.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Hypothesis debate failed for "${hyp.claim.slice(0, 50)}":`, e.message);
    }
  }

  if (debated > 0) console.log(`[DailyCycle] Debated ${debated} testing hypotheses`);
  return debated;
}

// ── Auto red-flag check (Technique 3) ───────────────────────────────────────

async function autoRedFlagCheck(): Promise<number> {
  return crossReferenceContradictionsWithHypotheses();
}

// ── Cold-start: seed hypotheses when none exist ─────────────────────────────

async function generateSeedHypotheses(): Promise<number> {
  if (!GROK_API_KEY) return 0;

  const lab = getResearchLab();
  if (lab.hypotheses.length > 0) return 0; // Not a cold start

  console.log("[DailyCycle] Cold start detected: 0 hypotheses. Generating seeds...");

  // Gather knowledge context for seeding
  const { getKnowledgeDigestForExploration } = require("./memoryEngine.js");
  const digest: string = getKnowledgeDigestForExploration();
  const kbContext = digest.slice(0, 6000); // Top knowledge entries

  const systemPrompt = `You are Agent 306, an autonomous AI researcher covering AI, crypto, and technology.
You currently have ZERO hypotheses in your research lab — this is a cold start.
Generate 5-10 diverse, testable hypotheses spanning your knowledge domains (AI, crypto, tech, society).

Each hypothesis must be:
- Specific and falsifiable
- Testable within 30-90 days
- Based on current trends and evidence
- Covering different domains (don't cluster all in one area)

Respond with ONLY a JSON array:
[
  {
    "claim": "specific testable claim",
    "basis": "evidence or reasoning supporting this",
    "metric": "how to measure or verify",
    "prediction": "expected outcome",
    "timeframe": "30-90 days",
    "confidence": "low|medium|high"
  }
]`;

  const userPrompt = `KNOWLEDGE BASE CONTEXT:\n${kbContext}\n\nGenerate 5-10 seed hypotheses based on this knowledge and current tech trends. Respond with JSON array only.`;

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("daily_briefing"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 3000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`[DailyCycle] Seed hypothesis LLM error: ${res.status}`);
      return 0;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const hypotheses = JSON.parse(jsonMatch[0]);
    let created = 0;
    for (const h of hypotheses) {
      if (h.claim && h.basis) {
        addHypothesis({
          claim: h.claim,
          basis: h.basis,
          metric: h.metric || "To be determined",
          prediction: h.prediction || h.claim,
          timeframe: h.timeframe || "60 days",
          confidence: h.confidence || "medium",
          source: "cold_start_seed",
        });
        created++;
      }
    }
    console.log(`[DailyCycle] Cold-start: seeded ${created} hypotheses`);
    return created;
  } catch (e: any) {
    console.error("[DailyCycle] Seed hypothesis generation failed:", e.message);
    return 0;
  }
}

// ── Cold-start: seed research threads when none exist ───────────────────────

async function seedResearchThreadsIfEmpty(): Promise<number> {
  const agenda = getAgenda();
  const activeThreads = agenda.threads.filter((t: any) => t.status !== "abandoned" && t.status !== "published");
  if (activeThreads.length > 0) return 0;

  console.log("[DailyCycle] Cold start detected: 0 active research threads. Triggering generation...");
  try {
    const { generateResearchAgenda } = require("./research-agenda.js");
    const newThreads = await generateResearchAgenda();
    console.log(`[DailyCycle] Cold-start: generated ${newThreads.length} research threads`);
    return newThreads.length;
  } catch (e: any) {
    console.error("[DailyCycle] Cold-start thread generation failed:", e.message);
    return 0;
  }
}

// ── Main: Run Daily Cycle ─────────────────────────────────────────────────────

export async function runDailyCycle(): Promise<DailyBriefing | null> {
  console.log("[DailyCycle] Starting daily intelligence cycle...");

  // 0. Run data intake FIRST — pull fresh AI/tech intelligence before reasoning
  try {
    console.log("[DailyCycle] Running data intake...");
    const intakeItems = await runFullIntake();
    console.log(`[DailyCycle] Data intake complete — ${intakeItems.length} new items ingested`);
  } catch (e: any) {
    console.warn("[DailyCycle] Data intake failed (non-fatal):", e.message);
  }

  // 0b. Cold-start checks: seed hypotheses and research threads if empty
  try {
    await generateSeedHypotheses();
    await seedResearchThreadsIfEmpty();
  } catch (e: any) {
    console.warn("[DailyCycle] Cold-start seeding failed (non-fatal):", e.message);
  }

  // 1. Gather all inputs
  const { active: activeHypotheses, expired: expiredHypotheses } = gatherHypotheses();
  const completedResearch = gatherResearchCompletions(state.lastRunAt);
  const activeGoals = gatherGoals();
  const pendingReviews = gatherPendingReviews();
  const archiveStats = getArchiveStats();
  const kbActive = getActiveKnowledgeCount();

  // 2. Auto-resolve expired hypotheses
  const resolvedNames = autoResolveExpired(expiredHypotheses);

  // 2b. Proactive Research Agenda (Layer 3) — generate threads, advance top 3, prune stale
  try {
    console.log("[DailyCycle] Running research agenda cycle...");
    const agendaResult = await runResearchAgendaCycle();
    console.log(`[DailyCycle] Research agenda: ${agendaResult.newThreads} new threads, ${agendaResult.advanced.length} advanced, ${agendaResult.pruned} pruned, ${agendaResult.podcastCandidates} podcast candidates`);
  } catch (e: any) {
    console.warn("[DailyCycle] Research agenda cycle failed (non-fatal):", e.message);
  }

  // 2c. Auto-run research pipeline on queued/in-progress topics
  try {
    const lab = getResearchLab();
    const queuedTopics = lab.topics
      .filter(t => t.status === "queued" || (t.status === "researching" && t.researchPhase !== "interpretation"))
      .slice(0, 3); // max 3 per cycle to avoid Railway timeout

    if (queuedTopics.length > 0) {
      const grokKey = GROK_API_KEY;
      const pplxKey = process.env.PERPLEXITY_API_KEY;
      if (grokKey) {
        for (const topic of queuedTopics) {
          try {
            console.log(`[DailyCycle] Auto-running pipeline for topic: "${topic.topic}" (phase: ${topic.researchPhase || "start"})`);
            await runResearchPipeline(topic.id, grokKey, pplxKey);
            console.log(`[DailyCycle] Pipeline completed for topic: "${topic.topic}"`);
          } catch (e: any) {
            console.warn(`[DailyCycle] Pipeline failed for "${topic.topic}":`, e.message);
          }
        }
      }
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Research pipeline auto-run failed (non-fatal):", e.message);
  }

  // 3. Make ONE Grok call
  const result = await callGrokForBriefing({
    activeHypotheses,
    expiredHypotheses,
    resolvedNames,
    completedResearch,
    activeGoals,
    pendingReviews,
    kbActive,
    kbArchived: archiveStats.total,
  });

  if (!result) {
    console.warn("[DailyCycle] Briefing generation failed");
    return null;
  }

  // 4. Auto-ingest knowledge from research completions
  ingestResearchKnowledge(result.researchCompletions);

  // 4a. Auto-create hypotheses from briefing (non-blocking)
  try {
    const briefingHypotheses = (result as any).hypotheses_to_create;
    if (briefingHypotheses && Array.isArray(briefingHypotheses)) {
      for (const h of briefingHypotheses) {
        if (h.claim && h.basis) {
          addHypothesis({
            claim: h.claim,
            basis: h.basis,
            metric: h.metric || "To be determined",
            prediction: h.prediction || h.claim,
            timeframe: h.timeframe || "3 months",
            confidence: h.confidence || "medium",
            source: "daily_cycle",
          });
          console.log(`[DailyCycle] Auto-created hypothesis: "${h.claim}"`);
        }
      }
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Hypothesis creation from briefing failed:", e.message);
  }

  // 4b. Self-improvement cycle (non-blocking — failures are logged, never crash)
  try {
    console.log("[DailyCycle] Running self-improvement engines...");
    // Reflection: analyze posts with new engagement data
    await runReflection().catch(e => console.warn("[DailyCycle] Reflection failed:", e.message));
    // Confidence decay: downgrade stale knowledge
    runConfidenceDecay();
    // Knowledge synthesis: scan for new connections if KB was updated
    await runConnectionScan().catch(e => console.warn("[DailyCycle] Connection scan failed:", e.message));
    // Conversation learning: extract insights from recent conversations
    await extractInsights().catch(e => console.warn("[DailyCycle] Insight extraction failed:", e.message));
    // Auto-debate: critique recent manuscripts that haven't been debated
    await autoDebateManuscripts().catch(e => console.warn("[DailyCycle] Auto-debate failed:", e.message));
    // NEW: Auto-test forming hypotheses → evaluate & transition to "testing" (forming > 24h)
    await autoTestHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis testing failed:", e.message));
    // NEW: Auto-debate hypotheses in "testing" state → The Forge → adversarial evaluation
    await autoDebateHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis debate failed:", e.message));
    // Auto-resolve: evaluate mature hypotheses with trust scores → confirm/reject
    await autoResolveHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis resolution failed:", e.message));
    // Contradiction detection: scan recent knowledge entries for conflicts
    await autoDetectContradictions().catch(e => console.warn("[DailyCycle] Contradiction detection failed:", e.message));
    // NEW: Red-flag check — cross-reference contradictions with active hypotheses
    await autoRedFlagCheck().catch(e => console.warn("[DailyCycle] Red-flag check failed:", e.message));
    // Auto-resolve minor contradictions older than 3 days
    try { autoResolveOldContradictions(); } catch (e: any) { console.warn("[DailyCycle] Auto-resolve contradictions failed:", e.message); }
    // Knowledge graph: cluster knowledge into themes and detect graph-level contradictions
    await clusterKnowledge().catch(e => console.warn("[DailyCycle] Knowledge clustering failed:", e.message));
    await detectGraphContradictions().catch(e => console.warn("[DailyCycle] Graph contradiction detection failed:", e.message));
    // Metacognition: log cognitive state summary
    const meta = getMetacognitionState();
    console.log(`[DailyCycle] Cognitive state — KB: ${meta.knowledgeCoverage.totalActive} entries, Velocity: ${meta.learningVelocity.trend}, Connections: ${meta.synthesisStats.totalConnections}`);
    // Skill extraction: check for recent successful outcomes and extract patterns
    const skills = await checkAndExtractSkills().catch(e => { console.warn("[DailyCycle] Skill extraction failed:", e.message); return []; });
    if (skills.length > 0) console.log(`[DailyCycle] Extracted ${skills.length} new skill(s)`);

    // Dream engine: ensure dreams are seeded, then update against new knowledge
    seedDreams(); // no-op if already seeded
    await updateDreams().catch(e => console.warn("[DailyCycle] Dream update failed:", e.message));
    // Growth snapshot: aggregate all metrics and generate self-assessment
    await takeGrowthSnapshot().catch(e => console.warn("[DailyCycle] Growth snapshot failed:", e.message));
    // Weekly improvement plan: generate every Monday (day 1)
    if (new Date().getUTCDay() === 1) {
      await generateSelfImprovementPlan().catch(e => console.warn("[DailyCycle] Improvement plan failed:", e.message));
    }
    // Execute pending improvement actions (runs daily to process any pending items)
    await executeImprovementActions().catch(e => console.warn("[DailyCycle] Improvement execution failed:", e.message));
  } catch (e: any) {
    console.warn("[DailyCycle] Self-improvement cycle error (non-fatal):", e.message);
  }

  // 4c. Auto-podcast pipeline: generate episode from mature research threads (max 1/day)
  try {
    console.log("[DailyCycle] Checking podcast pipeline for ready threads...");
    const autoEpisode = await runAutoPodcastPipeline().catch(e => {
      console.warn("[DailyCycle] Podcast pipeline failed:", e.message);
      return null;
    });
    if (autoEpisode) {
      console.log(`[DailyCycle] Auto-generated podcast episode: "${autoEpisode.title}"`);
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Podcast pipeline error (non-fatal):", e.message);
  }

  // 4d. Auto-generate blog drafts from approved research (max 1/cycle)
  try {
    const agenda = getAgenda();
    const matureThreads = agenda.threads.filter(t =>
      t.status === "mature" && t.evidence.supporting.length >= 3,
    );

    const blogState = getBlogState();
    const existingSourceIds = new Set(blogState.posts.map(p => p.sourceId));
    const unbloggedThreads = matureThreads.filter(t => !existingSourceIds.has(t.id));

    if (unbloggedThreads.length > 0) {
      const thread = unbloggedThreads[0];
      const sourceContent = thread.thesis + "\n\n" +
        (thread.evidence.supporting.length > 0 ? `Supporting evidence: ${thread.evidence.supporting.join(", ")}` : "") +
        (thread.actionableTips.length > 0 ? `\n\nTips: ${thread.actionableTips.join("; ")}` : "");
      const post = await generateBlogPost({
        topic: thread.title,
        sourceContent,
        source: "research",
        sourceId: thread.id,
        autoPublish: true, // Safety scanner will catch issues and downgrade to draft
      }).catch(e => {
        console.warn("[DailyCycle] Blog generation failed:", e.message);
        return null;
      });
      if (post) {
        console.log(`[DailyCycle] Auto-generated blog draft: "${post.title}"`);
      }
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Blog generation step failed:", e.message);
  }

  // 4e. Weekly knowledge consolidation (Sundays)
  const today = new Date();
  if (today.getDay() === 0) {
    try {
      const consolResult = await runKnowledgeConsolidation();
      console.log(`[DailyCycle] KB consolidation: saved ${consolResult.savings} entries`);
    } catch (e: any) {
      console.warn("[DailyCycle] KB consolidation failed:", e.message);
    }
  }

  // 5. Build briefing
  const briefing: DailyBriefing = {
    id: `briefing_${Date.now()}`,
    runAt: new Date().toISOString(),
    ...result,
    kbStats: { active: kbActive, archived: archiveStats.total },
  };

  // 6. Save to state
  state.current = briefing;
  state.lastRunAt = briefing.runAt;
  state.history.unshift(briefing);
  if (state.history.length > 7) state.history = state.history.slice(0, 7);
  state.nextRunAt = getNextRunTime().toISOString();
  saveState(state);

  console.log(`[DailyCycle] Briefing complete — action: "${result.todaysAction.action}"`);

  // ASI-Evolve: analyze the daily cycle (non-blocking)
  analyzeDailyCycle(briefing).catch(e => console.warn("[DailyCycle] Analyzer failed:", e.message));

  return briefing;
}

// ── Scheduling — 6am ET (10:00 UTC) daily ─────────────────────────────────────

function getNextRunTime(): Date {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setUTCHours(10, 0, 0, 0); // 6am ET = 10:00 UTC

  if (candidate <= now) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function msUntilNextRun(): number {
  return getNextRunTime().getTime() - Date.now();
}

export function scheduleDailyCycle(): void {
  function scheduleNext() {
    const ms    = msUntilNextRun();
    const hours = Math.round(ms / 3600000);
    state.nextRunAt = getNextRunTime().toISOString();
    saveState(state);
    console.log(`[DailyCycle] Next briefing in ${hours}h (6am ET / 10:00 UTC)`);
    setTimeout(async () => {
      await runDailyCycle().catch(e => console.error("[DailyCycle] Error:", e));
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
