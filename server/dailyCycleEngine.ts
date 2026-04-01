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
import { runConfidenceDecay, runDebate, checkContradictions, getDebates } from "./reasoningEngine.js";
import { runConnectionScan } from "./synthesisEngine.js";
import { extractInsights } from "./conversationLearningEngine.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { getResearchLab, resolveHypothesis } from "./researchEngine.js";
import { updateDreams, takeGrowthSnapshot, generateSelfImprovementPlan, seedDreams } from "./dreamEngine.js";

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
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: getModel("daily_briefing"),
        response_format: { type: "json_object" },
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
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Find "forming" hypotheses older than 7 days
  const mature = lab.hypotheses
    .filter(h => h.status === "forming" && new Date(h.formedAt).getTime() < sevenDaysAgo)
    .slice(0, 10);

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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROK_API_KEY}`,
        },
        body: JSON.stringify({
          model: getModel("hypothesis_resolution"),
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `You evaluate whether a hypothesis should be confirmed, rejected, or expired based on available evidence. Respond with ONLY valid JSON:
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

// ── Main: Run Daily Cycle ─────────────────────────────────────────────────────

export async function runDailyCycle(): Promise<DailyBriefing | null> {
  console.log("[DailyCycle] Starting daily intelligence cycle...");

  // 1. Gather all inputs
  const { active: activeHypotheses, expired: expiredHypotheses } = gatherHypotheses();
  const completedResearch = gatherResearchCompletions(state.lastRunAt);
  const activeGoals = gatherGoals();
  const pendingReviews = gatherPendingReviews();
  const archiveStats = getArchiveStats();
  const kbActive = getActiveKnowledgeCount();

  // 2. Auto-resolve expired hypotheses
  const resolvedNames = autoResolveExpired(expiredHypotheses);

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
    // Auto-resolve: evaluate mature hypotheses (forming > 7 days)
    await autoResolveHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis resolution failed:", e.message));
    // Contradiction detection: scan recent knowledge entries for conflicts
    await autoDetectContradictions().catch(e => console.warn("[DailyCycle] Contradiction detection failed:", e.message));
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
  } catch (e: any) {
    console.warn("[DailyCycle] Self-improvement cycle error (non-fatal):", e.message);
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
