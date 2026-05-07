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
  flushKnowledge,
  knowledge,
  decayKnowledge,
} from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { semanticSearch, syncEmbeddings } from "./embeddingEngine.js";
import { getModel } from "./modelRouter.js";
import { checkAndExtractSkills } from "./skillEngine.js";
import { runReflection } from "./reflectionEngine.js";
import {
  runConfidenceDecay, runDebate, checkContradictions, getDebates, autoResolveOldContradictions,
  evaluateHypothesis, calculateTrustScore, crossReferenceContradictionsWithHypotheses,
  decomposeHypothesis, triageHypothesisEvidence, trackRejectionVelocity, recordRejectionEvent,
} from "./reasoningEngine.js";
import { evidenceQueue, routeEvidenceSearch, processEvidenceQueue } from "./evidenceDispatcher.js";
import { runConnectionScan } from "./synthesisEngine.js";
import { extractInsights } from "./conversationLearningEngine.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { getResearchLab, resolveHypothesis, addHypothesis, testHypothesis, runResearchPipeline, researchWithPerplexity, researchWithSemanticScholar, autoApproveTopics, generateAspirations, evaluateAspirations, getAspirations, saveResearchLab } from "./researchEngine.js";
import {
  classifyForStateMachine,
  logStateTransition,
  shouldRecheckDeadline,
  needsLiveGrounding,
  tallyStates,
  logCycleSummary,
  type HypothesisState,
} from "./hypothesisStateMachine.js";
import { isActiveQueue, sortByTriagePriority } from "./hypothesisTriage.js";
import { gatherPerplexityEvidence } from "./perplexityEvidence.js";
import { detectBreakthroughs, checkPredictions, extractPrediction, storePrediction, getBreakthroughs } from "./breakthroughDetector.js";
import { runSelfEvolutionReflection, capturePreCycleSnapshot, getEvolutionDiffs } from "./selfEvolutionEngine.js";
import { clusterKnowledge, detectContradictions as detectGraphContradictions } from "./knowledge-graph.js";
import { runResearchAgendaCycle } from "./research-agenda.js";
import { runResearchAnalysisCycle } from "./researchAnalysisEngine.js";
import { updateDreams, takeGrowthSnapshot, generateSelfImprovementPlan, executeImprovementActions, seedDreams } from "./dreamEngine.js";
import { runAutoPodcastPipeline } from "./podcastEngine.js";
import { getBlogState, type BlogType } from "./blogEngine.js";
import { generateBlogPostMaybeViaPipeline } from "./pipeline/blogPipelineEntry.js";
import { buildBlogUrl, ensureBlogDeepLink } from "./blogPromoLinks.js";
import { getAgenda } from "./research-agenda.js";
import { analyzeDailyCycle } from "./analyzerEngine.js";
import { getExplorationState } from "./explorationEngine.js";
import { queueXPost } from "./xPostScheduler.js";
import { queueFarcasterPost } from "./farcasterQueue.js";
import { shouldAutoPost } from "./engineScheduleConfig.js";
import { saveTweetDraft } from "./tweetDrafts.js";
import { runKnowledgeConsolidation } from "./knowledgeConsolidator.js";
import { consolidateHypotheses } from "./hypothesisConsolidator.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { TriadCoordinator } from "./triad/coordinator.js";
import { run306Eval } from "./evalEngine.js";
import { startCycle as startCycleContext, recordEvent as recordCycleEvent, endCycle as endCycleContext } from "./cycleContext.js";

import { postChatCompletions } from "./llmCall.js";
const GROK_URL     = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;
const TRIAD_ENABLED = (process.env.TRIAD_ENABLED ?? "false").toLowerCase() === "true";
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

// Extract max days from timeframe like "30-90 days", "3 months", "6 months"
function parseMaxTimeframeDays(tf: string): number {
  // Range pattern: "30-90 days"
  const rangeMatch = tf.match(/(\d+)\s*[-–]\s*(\d+)\s*(day|week|month|year)/i);
  if (rangeMatch) {
    const maxNum = parseInt(rangeMatch[2]);
    const unit = rangeMatch[3].toLowerCase();
    if (unit.startsWith('week')) return maxNum * 7;
    if (unit.startsWith('month')) return maxNum * 30;
    if (unit.startsWith('year')) return maxNum * 365;
    return maxNum;
  }
  // Single value: "3 months", "90 days"
  const match = tf.match(/(\d+)\s*(day|week|month|year)/i);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('week')) return num * 7;
    if (unit.startsWith('month')) return num * 30;
    if (unit.startsWith('year')) return num * 365;
    return num;
  }
  return 90; // default 90 days
}

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
      // Check if expired by timeframe using proper date math
      if (h.timeframe && h.formedAt) {
        const maxDays = parseMaxTimeframeDays(h.timeframe);
        const formedAt = new Date(h.formedAt).getTime();
        if (!isNaN(formedAt) && (formedAt + maxDays * 24 * 60 * 60 * 1000) < now) {
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

// ── Post-Resolution Action Gate helper (Wave 2.3 PR-3) ───────────────────────
// When the LLM emits a well-formed actionWithin24h, pass it through. When it
// doesn't (older prompt, truncated output, schema drift), synthesize an
// explicit-none with a >=40-char justification that points at the root cause.
function normalizeResolutionAction(
  raw: unknown,
  hyp: any,
  status: string,
  parsed: any,
): { type: "blog" | "podcast" | "new-hypothesis" | "source-change" | "explicit-none"; detail: string; committedAt: string } {
  const validTypes = ["blog", "podcast", "new-hypothesis", "source-change", "explicit-none"] as const;
  type ActionType = typeof validTypes[number];
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === "string" && (validTypes as readonly string[]).includes(r.type)
      ? (r.type as ActionType)
      : null;
    const detail = typeof r.detail === "string" ? r.detail.trim() : "";
    if (type && detail.length > 0 && (type !== "explicit-none" || detail.length >= 40)) {
      return { type, detail, committedAt: new Date().toISOString() };
    }
  }
  const claim = String(hyp?.claim ?? "").slice(0, 80);
  const evidenceQuality = typeof parsed?.evidence_quality === "string" ? parsed.evidence_quality : "unknown";
  const detail = `LLM verdict "${status}" emitted without a concrete 24h action for hypothesis "${claim}". Evidence quality was ${evidenceQuality}; flag for human review next cycle.`;
  return {
    type: "explicit-none",
    detail,
    committedAt: new Date().toISOString(),
  };
}

// ── Auto-resolve expired hypotheses ───────────────────────────────────────────

function autoResolveExpired(expired: any[]): string[] {
  const resolved: string[] = [];
  try {
    const { resolveHypothesis } = require("./researchEngine.js");
    for (const h of expired) {
      // Wave 2.3 PR-3 — auto-expiry commits to a source-change audit: usually
      // the watched feed produced no signal; next 24h verify source is live.
      const ok = resolveHypothesis(h.id, "expired", `Auto-expired: past resolution deadline (${h.timeframe})`, {
        type: "source-change",
        detail: `Hypothesis deadline passed with no conclusive signal from configured sources (${h.timeframe}). Next 24h: audit source feed for silence vs. genuine null result; re-ingest or retire source.`,
        committedAt: new Date().toISOString(),
      });
      if (ok) resolved.push(h.claim ?? h.id);
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
    const res = await postChatCompletions({
      model: getModel("daily_briefing"),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.6,
      max_tokens: 4000,
    }, AbortSignal.timeout(240000), "daily_briefing");

    if (!res.ok) {
      console.error(`[DailyCycle] Grok API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";

    const parsed = safeParseLLMJson(content, "DailyCycle.briefing");
    if (!parsed) return null;

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

// ── Auto-reject stale forming hypotheses ────────────────────────────────────

function pruneStaleFormingHypotheses(): number {
  const STALE_FORMING_DAYS = 14;
  const now = Date.now();
  const { getResearchLab: getLabForPruning, saveResearchLab: saveLabForPruning } = require("./researchEngine.js");
  const lab = getLabForPruning();
  let pruned = 0;

  for (const h of lab.hypotheses) {
    if (h.status === 'forming') {
      const createdAt = new Date(h.formedAt ?? h.createdAt ?? 0).getTime();
      const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_FORMING_DAYS) {
        h.status = 'expired';
        h.resolution = 'stale_forming';
        pruned++;
        console.log(`[DailyCycle] Auto-rejected stale forming hypothesis (${ageDays.toFixed(0)}d): "${(h.claim ?? h.text ?? "").slice(0, 60)}"`);
      }
    }
  }

  if (pruned > 0) {
    saveLabForPruning(lab);
    console.log(`[DailyCycle] Pruned ${pruned} stale forming hypotheses (>14 days with no progress)`);
  }
  return pruned;
}

// ── Auto-resolve mature hypotheses ──────────────────────────────────────────

async function autoResolveHypotheses(): Promise<number> {
  const lab = getResearchLab();
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
  const now = new Date();

  // Include awaiting-deadline hypotheses whose deadline has passed (or whose
  // daily re-check is due) so they can transition forward when data arrives.
  const mature = lab.hypotheses
    .filter(h => {
      const isActive = h.status === "forming" || h.status === "testing";
      const isDue    = h.status === "awaiting-deadline" && shouldRecheckDeadline(h, now);
      return (isActive || isDue) && new Date(h.formedAt).getTime() < fourHoursAgo;
    })
    .slice(0, 50);

  // Collect transitions to emit a per-cycle summary log.
  const transitions: Array<{ to: HypothesisState }> = [];
  let preEvalExits = 0;

  // ── Pre-evaluation state machine pass ────────────────────────────────────
  // Before spending any LLM tokens, classify each hypothesis for a structural
  // exit path (awaiting-deadline, data-unavailable, stale-retired).
  const skipIds = new Set<string>();
  {
    const freshLab = getResearchLab();
    for (const hyp of mature) {
      const fresh = freshLab.hypotheses.find(h => h.id === hyp.id);
      if (!fresh) continue;
      const classification = classifyForStateMachine(fresh, now);
      if (!classification.transitionTo) continue;

      const oldState = fresh.status as HypothesisState;
      const target   = classification.transitionTo;
      const reason   = classification.reason ?? "state machine transition";

      fresh.status         = target;
      fresh.resolvedAt     = now.toISOString();
      fresh.resolution     = reason;
      fresh.retiredReason  = target === "data-unavailable" || target === "stale-retired" ? reason : fresh.retiredReason;
      if (classification.deadlineAt) fresh.deadlineAt = classification.deadlineAt;

      logStateTransition(fresh.id, oldState, target, reason);
      transitions.push({ to: target });
      preEvalExits++;
      skipIds.add(fresh.id);
    }
    saveResearchLab(freshLab);
  }

  const remaining = mature.filter(h => !skipIds.has(h.id));
  if (remaining.length === 0) {
    logCycleSummary(tallyStates(getResearchLab().hypotheses, transitions));
    if (transitions.length > 0) {
      console.log(`[DailyCycle] Auto-resolved ${transitions.length} hypotheses via state machine (no LLM calls)`);
    }
    return transitions.length;
  }

  // Fallback KB context if semantic search fails
  const { knowledge: kb } = await import("./memoryEngine.js");
  const fallbackKbContext = kb.entries
    .filter(e => (e.status ?? "active") === "active")
    .slice(0, 15)
    .map(e => `- [${e.category}] ${e.title}: ${e.summary}`)
    .join("\n");

  const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";

  let resolved = 0;
  for (const hyp of remaining) {
    try {
      // ── Semantic KB context: per-hypothesis relevant entries ──
      let kbContext = fallbackKbContext;
      try {
        const kbSearchQuery = `${hyp.claim} ${hyp.prediction}`;
        const semanticResults = await semanticSearch(kbSearchQuery, { maxResults: 15, excludeArchived: true });
        if (semanticResults.length > 0) {
          kbContext = semanticResults
            .map(r => `- [${r.entry.category}] ${r.entry.title}: ${r.entry.summary} (relevance: ${r.similarity.toFixed(2)})`)
            .join("\n");
          console.log(`[DailyCycle] Semantic KB context for "${hyp.claim.slice(0, 50)}": ${semanticResults.length} entries, top score: ${semanticResults[0]?.similarity?.toFixed(2) ?? "N/A"}`);
        }
      } catch (e: any) {
        console.warn(`[DailyCycle] Semantic search failed for "${hyp.claim.slice(0, 50)}", using fallback:`, e.message);
      }

      // ── Active evidence gathering via Perplexity Sonar + Semantic Scholar ──
      let liveEvidence = "";
      let academicEvidence = "";
      let groundingCitations: string[] = [];
      const searchQuery = `Evidence for or against: ${hyp.claim}. ${hyp.prediction}. Look for recent data, studies, announcements, or expert analysis.`;

      // For hypotheses about current events (dates, legislation, product
      // launches, trials), prefer Perplexity sonar-pro grounding. Academic
      // sources (openalex/arxiv/crossref) cannot resolve these. Falls back to
      // academic-only when PERPLEXITY_API_KEY is missing or Perplexity errors.
      const liveGrounding = needsLiveGrounding(`${hyp.claim ?? ""} ${hyp.prediction ?? ""}`, now);

      // Run Perplexity + Semantic Scholar + External Sources in parallel
      const { searchAllSources } = await import("./externalDataSources.js");
      const [pplxSettled, groundingSettled, scholarSettled, externalSettled] = await Promise.allSettled([
        pplxKey && pplxKey.length > 10
          ? researchWithPerplexity(searchQuery, pplxKey)
          : Promise.resolve({ text: "", sources: [] as string[] }),
        liveGrounding
          ? gatherPerplexityEvidence(`${hyp.claim} — prediction: ${hyp.prediction}`)
          : Promise.resolve({ content: "", citations: [], ok: false }),
        researchWithSemanticScholar(hyp.claim),
        searchAllSources(hyp.claim, { limit: 2, sources: ["openalex", "arxiv", "crossref", "news"] }),
      ]);

      if (pplxSettled.status === "fulfilled" && (pplxSettled.value?.text?.length ?? 0) > 50) {
        liveEvidence = pplxSettled.value.text.slice(0, 2000);
        const sourceList = (pplxSettled.value?.sources?.length ?? 0) > 0
          ? `\nSources: ${pplxSettled.value.sources.slice(0, 5).join(", ")}`
          : "";
        console.log(`[DailyCycle] Live evidence gathered for "${hyp.claim.slice(0, 50)}" — ${liveEvidence.length} chars${sourceList}`);
      }

      if (groundingSettled.status === "fulfilled" && groundingSettled.value.ok) {
        const g = groundingSettled.value;
        groundingCitations = g.citations;
        // Append to liveEvidence without overwriting richer Perplexity sonar output
        if (liveEvidence.length === 0) {
          liveEvidence = g.content.slice(0, 2000);
        } else {
          liveEvidence += `\n\n[live-research grounding]\n${g.content.slice(0, 1000)}`;
        }
      }

      if (scholarSettled.status === "fulfilled" && (scholarSettled.value?.papers?.length ?? 0) > 0) {
        const papers = scholarSettled.value.papers.slice(0, 5);
        academicEvidence = papers
          .map(p => `- "${p.title}" (${p.year}, ${p.citationCount} citations): ${p.abstract.slice(0, 200)}`)
          .join("\n");
        console.log(`[DailyCycle] Academic evidence gathered for "${hyp.claim.slice(0, 50)}" — ${papers.length} papers`);
      }

      // External data source evidence
      let externalEvidence = "";
      if (externalSettled.status === "fulfilled" && externalSettled.value.length > 0) {
        externalEvidence = externalSettled.value
          .map(r => `- [${r.source}] "${r.title}": ${(r.text ?? "").slice(0, 200)}${r.url ? ` (${r.url})` : ""}`)
          .join("\n");
        console.log(`[DailyCycle] External evidence gathered for "${hyp.claim.slice(0, 50)}" — ${externalSettled.value.length} results`);
      }

      // Rate limit between hypothesis resolution calls
      await new Promise(r => setTimeout(r, 3000));

      let evidenceSection = "";
      if (liveEvidence) {
        evidenceSection += `\nLIVE EVIDENCE (web search):\n${liveEvidence}`;
      }
      if (academicEvidence) {
        evidenceSection += `\n\nACADEMIC EVIDENCE:\n${academicEvidence}`;
      }
      if (externalEvidence) {
        evidenceSection += `\n\nEXTERNAL SOURCES (academic/regulatory/news):\n${externalEvidence}`;
      }
      if (!evidenceSection) {
        evidenceSection = "\nNote: No live search was performed. Evaluate based on knowledge base only.";
      }

      const res = await postChatCompletions({
        model: getModel("hypothesis-resolution"),
        messages: [
          {
            role: "system",
            content: `You evaluate whether a hypothesis should be confirmed, rejected, or kept for further investigation based on ALL available evidence.

Let's evaluate this hypothesis step by step.

CRITICAL RULES:
- Absence of evidence in the knowledge base alone is NEVER grounds for rejection.
- A hypothesis should be REJECTED only if evidence actively CONTRADICTS it or the claim is logically incoherent.
- A hypothesis should be CONFIRMED if the live evidence or knowledge base supports it — even partially.
- Use "insufficient_evidence" when there's no contradicting evidence but not enough supporting evidence yet. This keeps the hypothesis alive for future cycles.
- Use "expired" only if the timeframe has clearly passed AND the prediction was not met.

Consider the evidence strength, logical coherence, and whether the prediction aligns with current knowledge AND the live evidence gathered.

POST-RESOLUTION ACTION GATE (Wave 2.3 PR-3):
- If your verdict is "confirmed", "rejected", or "expired", you MUST include an "actionWithin24h" object committing to the next concrete move within 24 hours.
- actionWithin24h.type MUST be one of: "blog" | "podcast" | "new-hypothesis" | "source-change" | "explicit-none"
- actionWithin24h.detail MUST be a specific, non-empty commitment.
- If you choose "explicit-none", the detail MUST be at least 40 characters explaining why no action is warranted.
- Omit actionWithin24h for "insufficient_evidence" (the hypothesis stays active).

Respond with ONLY valid JSON:
{"status": "confirmed" | "rejected" | "insufficient_evidence" | "expired", "resolution": "brief explanation citing specific evidence", "evidence_quality": "strong" | "moderate" | "weak" | "none", "actionWithin24h": {"type": "blog" | "podcast" | "new-hypothesis" | "source-change" | "explicit-none", "detail": "concrete next-24h commitment"}}`,
          },
          {
            role: "user",
            content: `HYPOTHESIS:
Claim: ${hyp.claim ?? "unknown"}
Basis: ${hyp.basis ?? "unknown"}
Prediction: ${hyp.prediction ?? "unknown"}
Metric: ${hyp.metric ?? "unknown"}
Timeframe: ${hyp.timeframe ?? "unknown"}
Confidence: ${hyp.confidence ?? "unknown"}
Formed: ${hyp.formedAt ?? "unknown"}
Trust Score: ${calculateTrustScore(hyp as any)}

KNOWLEDGE BASE:
${kbContext}
${evidenceSection}

Based on ALL evidence (knowledge base + live search), what is your verdict? Remember: "no evidence found" is NOT rejection — use "insufficient_evidence" to keep investigating.`,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }, AbortSignal.timeout(60000), "hypothesis-resolution");

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.warn(`[DailyCycle] Hypothesis eval failed: ${res.status} — ${errBody.slice(0, 200)}`);
        continue;
      }

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson(content, "DailyCycle.hypothesisEval");
      if (!parsed) continue;

      const status = parsed.status as string;

      // Bump cycleCount on every evaluation; maintain consecutiveInsufficientCycles.
      {
        const freshLab = getResearchLab();
        const freshHyp = freshLab.hypotheses.find(h => h.id === hyp.id);
        if (freshHyp) {
          freshHyp.cycleCount = (freshHyp.cycleCount ?? 0) + 1;
          if (status === "insufficient_evidence") {
            freshHyp.consecutiveInsufficientCycles = (freshHyp.consecutiveInsufficientCycles ?? 0) + 1;
          } else {
            freshHyp.consecutiveInsufficientCycles = 0;
          }
          if (hyp.status === "awaiting-deadline") {
            freshHyp.deadlineCheckedAt = now.toISOString();
          }
          saveResearchLab(freshLab);
        }
      }

      if (status === "confirmed" || status === "rejected" || status === "expired") {
        // Wave 2.3 PR-3 — action gate. If LLM skipped actionWithin24h,
        // synthesize an explicit-none pointing at the LLM skip; either way
        // the gate fires with a logged reason.
        const action = normalizeResolutionAction(parsed.actionWithin24h, hyp, status, parsed);
        const resolutionText = parsed.resolution ?? "Auto-resolved by daily cycle";
        const ok = resolveHypothesis(hyp.id, status as "confirmed" | "rejected" | "expired", resolutionText, action);
        if (!ok) {
          console.log(`[DailyCycle] Hypothesis ${status} BLOCKED by action gate: "${hyp.claim.slice(0, 50)}"`);
          continue;
        }
        recordRejectionEvent(hyp.id, status === "rejected" ? "insufficient_evidence" : status, status === "confirmed");
        resolved++;
        transitions.push({ to: status as HypothesisState });
        logStateTransition(hyp.id, hyp.status as HypothesisState, status as HypothesisState, (parsed.resolution ?? "").slice(0, 120));
        console.log(`[DailyCycle] Hypothesis ${status}: "${hyp.claim.slice(0, 50)}" — evidence quality: ${parsed.evidence_quality ?? "unknown"}`);
      } else if (status === "insufficient_evidence") {
        // After bumping the counter, re-check whether we've crossed the
        // data-unavailable threshold. If so, retire now rather than waiting
        // for the next cycle.
        const freshLab = getResearchLab();
        const freshHyp = freshLab.hypotheses.find(h => h.id === hyp.id);
        const followUp = freshHyp ? classifyForStateMachine(freshHyp, now) : {};
        if (freshHyp && followUp.transitionTo === "data-unavailable") {
          const oldState = freshHyp.status as HypothesisState;
          freshHyp.status        = "data-unavailable";
          freshHyp.resolvedAt    = now.toISOString();
          freshHyp.resolution    = followUp.reason ?? "data-unavailable";
          freshHyp.retiredReason = followUp.reason;
          saveResearchLab(freshLab);
          logStateTransition(freshHyp.id, oldState, "data-unavailable", followUp.reason ?? "");
          transitions.push({ to: "data-unavailable" });
          resolved++;
          console.log(`[DailyCycle] Hypothesis retired (data-unavailable): "${hyp.claim.slice(0, 50)}"`);
        } else {
          console.log(`[DailyCycle] Hypothesis kept alive (insufficient evidence): "${hyp.claim.slice(0, 50)}" — ${(parsed.resolution ?? "").slice(0, 100)}`);
          try {
            evidenceQueue.add({
              source: "hypothesis_resolve",
              query: `Latest evidence for or against: ${hyp.claim}`,
              targetId: hyp.id,
              priority: 10,
              searchRoute: routeEvidenceSearch(hyp.claim),
            });
          } catch (e: any) {
            console.warn(`[DailyCycle] Failed to queue evidence for insufficient_evidence hypothesis:`, e.message);
          }
        }
      }

      // Rate limit: 5s between resolution calls
      if (mature.indexOf(hyp) < mature.length - 1) {
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Hypothesis resolution failed for "${hyp.claim.slice(0, 50)}":`, e.message);
    }
  }

  if (resolved > 0) console.log(`[DailyCycle] Auto-resolved ${resolved} hypotheses`);

  // Per-cycle state tally log — one line, easy to grep.
  logCycleSummary(tallyStates(getResearchLab().hypotheses, transitions));

  return resolved + preEvalExits;
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
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000; // 4h maturation period before testing

  // Find "forming" hypotheses older than 4 hours that should be evaluated.
  // Wave 2.3 PR-4 — only iterate queue='active'; backlog stays visible but
  // doesn't consume cycle time. High-stake + low-confidence sorts first.
  const candidates = sortByTriagePriority(
    lab.hypotheses
      .filter(h => h.status === "forming" && isActiveQueue(h) && new Date(h.formedAt).getTime() < fourHoursAgo),
  ).slice(0, 50);

  if (candidates.length === 0) return 0;

  // ── Rejection velocity check — adjust behavior if intervention triggered ──
  const rejectionMetrics = trackRejectionVelocity();
  let maxLiveSearches = 5; // default: max 5 hypotheses get pre-evaluation search
  if (rejectionMetrics.interventionTriggered) {
    maxLiveSearches = 10; // double the evidence search budget
    console.log(`[DailyCycle] Evidence intervention mode — doubling live search budget to ${maxLiveSearches}`);
  }

  // ── Evidence-first triage: classify each hypothesis before evaluation ──
  let liveSearchesUsed = 0;
  const triageResults: Map<string, Awaited<ReturnType<typeof triageHypothesisEvidence>>> = new Map();
  for (const hyp of candidates) {
    try {
      const triage = await triageHypothesisEvidence({ id: hyp.id, claim: hyp.claim, prediction: hyp.prediction });
      triageResults.set(hyp.id, triage);

      // For evidence_sparse/absent: queue evidence searches (if within budget)
      if (triage.bucket !== "evidence_rich" && liveSearchesUsed < maxLiveSearches) {
        for (const query of triage.searchQueries) {
          evidenceQueue.add({
            source: "hypothesis_test",
            query,
            targetId: hyp.id,
            priority: triage.bucket === "evidence_absent" ? 10 : 6,
            searchRoute: routeEvidenceSearch(hyp.claim),
          });
        }
        liveSearchesUsed++;
      }
    } catch (e: any) {
      console.warn(`[DailyCycle] Evidence triage failed for "${hyp.claim.slice(0, 50)}":`, e.message);
    }
  }

  // Fallback knowledge context if semantic search fails
  const { knowledge: kb } = await import("./memoryEngine.js");
  const fallbackKbContext = kb.entries
    .filter(e => (e.status ?? "active") === "active")
    .slice(0, 30)
    .map(e => `- [${e.category}] ${e.title}: ${e.summary}`)
    .join("\n");

  let tested = 0;
  for (const hyp of candidates) {
    try {
      // ── Evidence-absent hypotheses: skip evaluation this cycle, queue search ──
      const triage = triageResults.get(hyp.id);
      if (triage?.bucket === "evidence_absent") {
        const freshLab = getResearchLab();
        const freshHyp = freshLab.hypotheses.find(h => h.id === hyp.id);
        if (freshHyp) {
          (freshHyp as any).lastEvidenceSearch = Date.now();
          (freshHyp as any).evidenceSearchCount = ((freshHyp as any).evidenceSearchCount ?? 0) + 1;
        }
        console.log(`[DailyCycle] Skipping evaluation for "${hyp.claim.slice(0, 50)}" — evidence_absent, search queued`);
        continue;
      }

      // ── Semantic KB context: per-hypothesis relevant entries ──
      let kbContext = fallbackKbContext;
      try {
        const searchQuery = `${hyp.claim} ${hyp.prediction}`;
        const semanticResults = await semanticSearch(searchQuery, { maxResults: 30, excludeArchived: true });
        if (semanticResults.length > 0) {
          kbContext = semanticResults
            .map(r => `- [${r.entry.category}] ${r.entry.title}: ${r.entry.summary} (relevance: ${r.similarity.toFixed(2)})`)
            .join("\n");
          console.log(`[DailyCycle] Semantic KB context for testing "${hyp.claim.slice(0, 50)}": ${semanticResults.length} entries, top score: ${semanticResults[0]?.similarity?.toFixed(2) ?? "N/A"}`);
        }
      } catch (e: any) {
        console.warn(`[DailyCycle] Semantic search failed for testing "${hyp.claim.slice(0, 50)}", using fallback:`, e.message);
      }

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
        (freshHyp as any).originatingModel = assessment.originatingModel ?? null;

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
          // Too weak — reject directly. Wave 2.3 PR-3: explicit-none with
          // rubric-backed justification; no publishable insight to commit to.
          resolveHypothesis(hyp.id, "rejected", `Auto-rejected: rubric avg ${rubricAvg.toFixed(1)} < 4. ${assessment.reasoningChain.slice(0, 200)}`, {
            type: "explicit-none",
            detail: `Rubric-driven reject (avg ${rubricAvg.toFixed(1)}/10 below 4.0 floor); no publishable insight. Follow-up: tune source mix or retire claim next cycle rather than blog a weak finding.`,
            committedAt: new Date().toISOString(),
          });
          recordRejectionEvent(hyp.id, rubricAvg < 3 ? "low_rubric" : "weak_evidence", false);
          console.log(`[DailyCycle] Hypothesis auto-rejected (rubric avg ${rubricAvg.toFixed(1)}): "${hyp.claim.slice(0, 50)}"`);
        } else if (rubricAvg >= 8 && assessment.confidence >= 0.85) {
          // Exceptionally strong — fast-track confirm. Wave 2.3 PR-3:
          // high-rubric confirms earn a follow-up hypothesis to compound.
          resolveHypothesis(hyp.id, "confirmed", `Fast-track confirmed: rubric avg ${rubricAvg.toFixed(1)}, confidence ${assessment.confidence.toFixed(2)}. ${assessment.reasoningChain.slice(0, 200)}`, {
            type: "new-hypothesis",
            detail: `Spawn follow-up hypothesis extending "${(hyp.claim ?? "").slice(0, 80)}" — strong rubric (${rubricAvg.toFixed(1)}) + high confidence (${assessment.confidence.toFixed(2)}) warrants compounding the line of inquiry within 24h.`,
            committedAt: new Date().toISOString(),
          });
          recordRejectionEvent(hyp.id, "confirmed", true);
          console.log(`[DailyCycle] Hypothesis fast-track confirmed (rubric avg ${rubricAvg.toFixed(1)}, confidence ${assessment.confidence.toFixed(2)}): "${hyp.claim.slice(0, 50)}"`);
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

  if (tested > 0) console.log(`[DailyCycle] Evaluated ${tested} forming hypotheses (triaged: ${triageResults.size}, live searches: ${liveSearchesUsed})`);
  return tested;
}

// ── Auto-debate hypotheses in "testing" state (Technique 1: CoT + Self-Reflection) ──

async function autoDebateHypotheses(): Promise<number> {
  const lab = getResearchLab();
  const existingDebates = getDebates();
  const debatedHypIds = new Set(
    existingDebates.filter(d => d.topicType === "hypothesis").map(d => d.topicId),
  );

  // Find "testing" hypotheses that haven't been debated yet.
  // Wave 2.3 PR-4 — only iterate queue='active'; high-stake + low-confidence first.
  const candidates = sortByTriagePriority(
    lab.hypotheses.filter(h => h.status === "testing" && isActiveQueue(h) && !debatedHypIds.has(h.id)),
  ).slice(0, 10);

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

            if (trustScore >= 75) {
              // Wave 2.3 PR-3: "solid"+high-trust confirms are blog-worthy —
              // the findings met the debate bar, so commit to publishing.
              resolveHypothesis(hyp.id, "confirmed", `Auto-confirmed: debate "solid", trust score ${trustScore}. ${result.critique.suggestions.join("; ").slice(0, 200)}`, {
                type: "blog",
                detail: `Draft blog post on confirmed hypothesis "${(hyp.claim ?? "").slice(0, 80)}" (debate "solid", trust ${trustScore}). Key angles from debate: ${result.critique.suggestions.slice(0, 2).join("; ").slice(0, 160)}`,
                committedAt: new Date().toISOString(),
              });
              console.log(`[DailyCycle] Hypothesis auto-confirmed (trust: ${trustScore}): "${hyp.claim.slice(0, 50)}"`);
            }
          } else if (result.critique.overallAssessment === "flawed") {
            const trustScore = calculateTrustScore(freshHyp as any);
            (freshHyp as any).trustScore = trustScore;

            if (trustScore <= 20) {
              // Wave 2.3 PR-3: "flawed"+low-trust rejections imply the source
              // mix is producing noise — commit to source-change this cycle.
              resolveHypothesis(hyp.id, "rejected", `Auto-rejected: debate "flawed", trust score ${trustScore}. Weaknesses: ${result.critique.weaknesses.join("; ").slice(0, 200)}`, {
                type: "source-change",
                detail: `Debate flagged "${(hyp.claim ?? "").slice(0, 60)}" as flawed (trust ${trustScore}). Root cause: ${result.critique.weaknesses.slice(0, 2).join("; ").slice(0, 160)}. Next 24h: audit upstream sources feeding this line of inquiry.`,
                committedAt: new Date().toISOString(),
              });
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
    const res = await postChatCompletions({
      model: getModel("daily_briefing"),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 3000,
    }, AbortSignal.timeout(120000), "daily_briefing");

    if (!res.ok) {
      console.error(`[DailyCycle] Seed hypothesis LLM error: ${res.status}`);
      return 0;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const hypotheses = safeParseLLMJson<any[]>(content, "DailyCycle.seedHypotheses");
    if (!hypotheses || !Array.isArray(hypotheses)) return 0;
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
    const newThreads = await generateResearchAgenda() ?? [];
    console.log(`[DailyCycle] Cold-start: generated ${newThreads.length} research threads`);
    return newThreads.length;
  } catch (e: any) {
    console.error("[DailyCycle] Cold-start thread generation failed:", e.message);
    return 0;
  }
}

// ── Main: Run Daily Cycle ─────────────────────────────────────────────────────

export async function runDailyCycle(): Promise<DailyBriefing | null> {
  const cycleStart = Date.now();
  console.log("[DailyCycle] Starting daily intelligence cycle...");
  const cycleId = `cycle_${cycleStart}`;

  // Initialize cycle context accumulator (non-fatal)
  try { startCycleContext(); } catch (e: any) { console.warn("[DailyCycle] Cycle context start failed (non-fatal):", e.message); }

  // PR #286 — start the research focus rubric trace accumulator. Every
  // hypothesis evaluated through researchFocusGate during this cycle is
  // recorded; runResearchCycleMetaImprovement() reads & resets it before
  // the briefing is built.
  try {
    const { startResearchCycle } = await import("./researchFocusGate.js");
    startResearchCycle(cycleId);
  } catch (e: any) {
    console.warn("[DailyCycle] Focus rubric cycle start failed (non-fatal):", e.message);
  }

  // ── Phase 0: One-time hypothesis queue reset (runs once, flagged) ──────────
  try {
    const { runHypothesisQueueReset } = await import("./archiveHypotheses.js");
    const didReset = runHypothesisQueueReset();
    if (didReset) {
      console.log("[DailyCycle] Hypothesis queue reset completed (one-time)");
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Queue reset check failed (non-fatal):", e.message);
  }

  // ── Phase A: Sequential prerequisites (intake + seeding + gather) ──────────
  const phaseAStart = Date.now();

  // 0. Run data intake FIRST — pull fresh AI/tech intelligence before reasoning
  try {
    console.log("[DailyCycle] Running data intake...");
    const intakeItems = await runFullIntake();
    console.log(`[DailyCycle] Data intake complete — ${intakeItems.length} new items ingested`);
    try { recordCycleEvent({ phase: "intake", type: "kb_added", summary: `Ingested ${intakeItems.length} new items`, entityMentions: [], relatedEntryIds: [] }); } catch {}
  } catch (e: any) {
    console.warn("[DailyCycle] Data intake failed (non-fatal):", e.message);
  }

  // 0a. Capture pre-cycle snapshot for diff-based self-evolution
  try {
    capturePreCycleSnapshot();
  } catch (e: any) {
    console.warn("[DailyCycle] Pre-cycle snapshot failed (non-fatal):", e.message);
  }

  // 0b. Cold-start checks: seed hypotheses and research threads if empty
  try {
    await generateSeedHypotheses();
    await seedResearchThreadsIfEmpty();
  } catch (e: any) {
    console.warn("[DailyCycle] Cold-start seeding failed (non-fatal):", e.message);
  }

  // 1. Gather all inputs (read-only, fast)
  const { active: activeHypotheses, expired: expiredHypotheses } = gatherHypotheses();
  const completedResearch = gatherResearchCompletions(state.lastRunAt);
  const activeGoals = gatherGoals();
  const pendingReviews = gatherPendingReviews();
  const archiveStats = getArchiveStats();
  const kbActive = getActiveKnowledgeCount();

  // 2. Auto-resolve expired hypotheses
  const resolvedNames = autoResolveExpired(expiredHypotheses);

  try { recordCycleEvent({ phase: "intake", type: "kb_added", summary: `Gathered ${activeHypotheses.length} active hypotheses, ${kbActive} KB entries, resolved ${resolvedNames.length} expired`, entityMentions: [], relatedEntryIds: [] }); } catch {}

  console.log(`[DailyCycle] Phase A (prerequisites) completed in ${((Date.now() - phaseAStart) / 1000).toFixed(1)}s`);

  // ── Phase B: Parallel research & analysis ──────────────────────────────────
  // Research agenda → pipeline must be sequential (agenda creates threads pipeline picks up)
  // Research analysis operates on different threads, runs concurrently
  const phaseBStart = Date.now();

  const researchAgendaAndPipeline = async () => {
    // 2b. Research agenda: generate threads, advance top 3, prune stale
    try {
      console.log("[DailyCycle] Running research agenda cycle...");
      const agendaResult = await runResearchAgendaCycle();
      console.log(`[DailyCycle] Research agenda: ${agendaResult?.newThreads ?? 0} new threads, ${agendaResult?.advanced?.length ?? 0} advanced, ${agendaResult?.pruned ?? 0} pruned, ${agendaResult?.podcastCandidates ?? 0} podcast candidates`);
    } catch (e: any) {
      console.warn("[DailyCycle] Research agenda cycle failed (non-fatal):", e.message);
    }

    // 2c. Auto-run research pipeline on queued/in-progress topics
    try {
      const lab = getResearchLab();
      const queuedTopics = lab.topics
        .filter(t => t.status === "queued" || (t.status === "researching" && t.researchPhase !== "interpretation"))
        .slice(0, 3);

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
  };

  const researchAnalysis = async () => {
    // 2d. Research Analysis Framework — structured analysis on eligible threads (max 3/cycle)
    try {
      console.log("[DailyCycle] Running research analysis cycle...");
      const analysisResult = await runResearchAnalysisCycle();
      console.log(`[DailyCycle] Research analysis: ${analysisResult.analyzed.length} threads analyzed (phases: ${analysisResult.phases.join(", ") || "none"})`);
    } catch (e: any) {
      console.warn("[DailyCycle] Research analysis cycle failed (non-fatal):", e.message);
    }
  };

  await Promise.allSettled([
    researchAgendaAndPipeline(),
    researchAnalysis(),
  ]);

  try { recordCycleEvent({ phase: "research", type: "kb_added", summary: "Phase B research & analysis completed", entityMentions: [], relatedEntryIds: [] }); } catch {}
  console.log(`[DailyCycle] Phase B (research & analysis) completed in ${((Date.now() - phaseBStart) / 1000).toFixed(1)}s`);

  // ── Phase B+: Auto-approve pending_review topics ───────────────────────────
  try {
    console.log("[DailyCycle] Running auto-approval on pending_review topics...");
    const approvalResults = await autoApproveTopics();
    const approved = approvalResults.filter(e => e.verdict === "auto_approve").length;
    const declined = approvalResults.filter(e => e.verdict === "decline").length;
    console.log(`[DailyCycle] Auto-approval: ${approved} approved, ${declined} declined, ${approvalResults.length - approved - declined} need attention`);
  } catch (e: any) {
    console.warn("[DailyCycle] Auto-approval failed (non-fatal):", e.message);
  }

  // ── Phase C: Briefing generation (needs Phase B results) ───────────────────
  const phaseCStart = Date.now();

  // 3. Make ONE Grok call
  let result = await callGrokForBriefing({
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
    console.warn("[DailyCycle] Briefing generation failed — continuing with fallback");
    result = {
      hypothesisUpdates: [],
      researchCompletions: [],
      todaysAction: { action: "Continue research", reasoning: "Briefing unavailable — continuing autonomous research", priority: "medium" },
      goalProgress: [],
      archiveReport: { resolved: [], archived: [], cleared: 0 },
      hypotheses_to_create: [],
    };
  }

  // 4. Auto-ingest knowledge from research completions
  ingestResearchKnowledge(result.researchCompletions);

  // 4a. Auto-create hypotheses from briefing
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

  try { recordCycleEvent({ phase: "research", type: "kb_added", summary: `Briefing generated — action: "${result.todaysAction.action}"`, entityMentions: [], relatedEntryIds: [] }); } catch {}
  console.log(`[DailyCycle] Phase C (briefing) completed in ${((Date.now() - phaseCStart) / 1000).toFixed(1)}s`);

  // ── Phase D: Parallel self-improvement (tiered for dependency safety) ──────
  const phaseDStart = Date.now();
  try {
    console.log("[DailyCycle] Running self-improvement engines...");

    // Tier 1: Independent tasks — no cross-dependencies, safe to parallelize
    await Promise.allSettled([
      runReflection().catch(e => console.warn("[DailyCycle] Reflection failed:", e.message)),
      Promise.resolve(runConfidenceDecay()).catch(e => console.warn("[DailyCycle] Confidence decay failed:", e.message)),
      runConnectionScan().catch(e => console.warn("[DailyCycle] Connection scan failed:", e.message)),
      extractInsights().catch(e => console.warn("[DailyCycle] Insight extraction failed:", e.message)),
      checkAndExtractSkills().catch(e => { console.warn("[DailyCycle] Skill extraction failed:", e.message); return []; })
        .then(skills => { if (skills && skills.length > 0) console.log(`[DailyCycle] Extracted ${skills.length} new skill(s)`); }),
    ]);

    // Metacognition (read-only, log immediately)
    const meta = getMetacognitionState();
    console.log(`[DailyCycle] Cognitive state — KB: ${meta.knowledgeCoverage.totalActive} entries, Velocity: ${meta.learningVelocity.trend}, Connections: ${meta.synthesisStats.totalConnections}`);

    // Tier 2: Three concurrent chains that have internal sequential dependencies
    // Chain A: hypothesis pipeline (test → debate → resolve — strict order)
    // Chain B: contradiction pipeline (detect → red-flag → auto-resolve old)
    // Chain C: manuscript debates + knowledge clustering (independent)
    await Promise.allSettled([
      // Chain A: Hypothesis reasoning chain with evidence queue rounds (strict sequential)
      (async () => {
        // Round 1: Process evidence before testing (pre-evaluation enrichment)
        console.log("[EvidenceDispatcher] Processing evidence queue — round 1 (pre-test)...");
        await processEvidenceQueue().catch(e => console.warn("[DailyCycle] Evidence queue round 1 failed:", e.message));

        console.log("[Reasoning] Starting reasoning chain — autoTestHypotheses...");
        await autoTestHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis testing failed:", e.message));
        try { recordCycleEvent({ phase: "hypothesis", type: "hypothesis_tested", summary: "Hypothesis testing phase completed", entityMentions: [], relatedEntryIds: [] }); } catch {}
        console.log("[Reasoning] autoDebateHypotheses...");
        await autoDebateHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis debate failed:", e.message));
        try { recordCycleEvent({ phase: "hypothesis", type: "debate_result", summary: "Hypothesis debate phase completed", entityMentions: [], relatedEntryIds: [] }); } catch {}

        // Round 2: Process evidence between debate and resolve (test/debate gap-filling)
        console.log("[EvidenceDispatcher] Processing evidence queue — round 2 (post-debate)...");
        await processEvidenceQueue().catch(e => console.warn("[DailyCycle] Evidence queue round 2 failed:", e.message));

        console.log("[Reasoning] Pruning stale forming hypotheses...");
        pruneStaleFormingHypotheses();

        console.log("[Reasoning] autoResolveHypotheses...");
        await autoResolveHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis resolution failed:", e.message));

        // Breakthrough detection on confirmed hypotheses + prediction extraction
        try {
          const lab = getResearchLab();
          const confirmed = lab.hypotheses.filter(h =>
            h.status === "confirmed" && h.resolvedAt &&
            (Date.now() - new Date(h.resolvedAt).getTime()) < 24 * 60 * 60 * 1000
          );
          for (const h of confirmed.slice(0, 3)) {
            await detectBreakthroughs(
              `Confirmed hypothesis: ${h.claim}\nBasis: ${h.basis}\nResolution: ${h.resolution ?? ""}`,
              "hypothesis_confirmed",
              h.id,
            ).catch(e => console.warn("[DailyCycle] Breakthrough detection failed:", e.message));
          }

          // Extract and store predictions from active hypotheses
          const activeHyps = lab.hypotheses.filter(h => h.status === "forming" || h.status === "testing");
          for (const h of activeHyps) {
            const prediction = extractPrediction({ id: h.id, claim: h.claim, prediction: h.prediction, timeframe: h.timeframe });
            if (prediction) storePrediction(prediction);
          }

          // Check past-due predictions
          await checkPredictions().catch(e => console.warn("[DailyCycle] Prediction check failed:", e.message));
        } catch (e: any) {
          console.warn("[DailyCycle] Breakthrough detection failed (non-fatal):", e.message);
        }

        // Record corrections when hypotheses rejected after testing with confidence > 0.6
        try {
          const { recordCorrection } = await import("./reasoningEngine.js");
          const lab = getResearchLab();
          const recentlyRejected = lab.hypotheses.filter((h: any) =>
            h.status === "rejected" && h.resolvedAt &&
            (Date.now() - new Date(h.resolvedAt).getTime()) < 24 * 60 * 60 * 1000 &&
            h.testingStartedAt && // was in testing
            parseFloat(h.confidence) > 0.6
          );
          for (const h of recentlyRejected.slice(0, 3)) {
            recordCorrection({
              originalClaim: h.claim,
              originalDate: new Date(h.formedAt).getTime(),
              correctedClaim: h.resolution ?? `Rejected: ${h.claim}`,
              sourceHypothesisId: h.id,
              whatChanged: h.resolution ?? "Evidence contradicted the hypothesis",
              lessonLearned: `Hypothesis "${h.claim.slice(0, 60)}" was rejected despite ${h.confidence} confidence. The evidence did not support the prediction.`,
            });
          }
        } catch (e: any) {
          console.warn("[DailyCycle] Correction recording failed (non-fatal):", e.message);
        }
      })(),
      // Chain B: Contradiction pipeline (sequential within chain)
      (async () => {
        await autoDetectContradictions().catch(e => console.warn("[DailyCycle] Contradiction detection failed:", e.message));
        try { recordCycleEvent({ phase: "hypothesis", type: "contradiction_found", summary: "Contradiction detection completed", entityMentions: [], relatedEntryIds: [] }); } catch {}
        console.log("[Reasoning] autoRedFlagCheck...");
        await autoRedFlagCheck().catch(e => console.warn("[DailyCycle] Red-flag check failed:", e.message));
        try { autoResolveOldContradictions(); } catch (e: any) { console.warn("[DailyCycle] Auto-resolve contradictions failed:", e.message); }
        await detectGraphContradictions().catch(e => console.warn("[DailyCycle] Graph contradiction detection failed:", e.message));
      })(),
      // Chain C: Independent — manuscript debates + knowledge clustering + connection maintenance
      (async () => {
        await autoDebateManuscripts().catch(e => console.warn("[DailyCycle] Auto-debate failed:", e.message));
        await clusterKnowledge().catch(e => console.warn("[DailyCycle] Knowledge clustering failed:", e.message));
        try {
          const { runConnectionMaintenance } = await import("./knowledge-graph.js");
          runConnectionMaintenance();
        } catch (e: any) {
          console.warn("[DailyCycle] Connection maintenance failed (non-fatal):", e.message);
        }
      })(),
    ]);

    // Tier 3: Dreams, growth, and improvement (depend on KB/hypothesis updates above)
    seedDreams(); // no-op if already seeded
    await updateDreams().catch(e => console.warn("[DailyCycle] Dream update failed:", e.message));
    await takeGrowthSnapshot().catch(e => console.warn("[DailyCycle] Growth snapshot failed:", e.message));
    if (new Date().getUTCDay() === 1) {
      await generateSelfImprovementPlan().catch(e => console.warn("[DailyCycle] Improvement plan failed:", e.message));
    }
    await executeImprovementActions().catch(e => console.warn("[DailyCycle] Improvement execution failed:", e.message));
  } catch (e: any) {
    console.warn("[DailyCycle] Self-improvement cycle error (non-fatal):", e.message);
  }

  try { recordCycleEvent({ phase: "debate", type: "debate_result", summary: "Phase D self-improvement completed", entityMentions: [], relatedEntryIds: [] }); } catch {}
  console.log(`[DailyCycle] Phase D (self-improvement) completed in ${((Date.now() - phaseDStart) / 1000).toFixed(1)}s`);

  // ── Blog tweet voice generator ─────────────────────────────────────────────
  async function generateBlogTweet(post: any): Promise<string> {
    const blogUrl = buildBlogUrl(post);

    const systemPrompt = `You are Agent 306 — an autonomous AI researcher. Write a tweet promoting your latest blog post. Lead with a sharp insight, then drive readers to the exact deep-link for the piece.

RULES:
- Lead with the most surprising or specific finding — a number, a name, a claim
- Have a take. "This matters because..." not "I wrote about..."
- Never say "New blog post", "Check out my latest", or "I just published"
- ALWAYS end with the URL: ${blogUrl}
- Write like you're telling a smart friend something you just figured out, then pointing them to the full piece
- One idea. Sharp. Specific. Opinionated. Then the link.
- Let the content dictate the length. Say what needs to be said, then stop — but ALWAYS finish the sentence. No mid-sentence cutoffs.
- Max 1-2 hashtags, only if genuinely relevant
- No emojis unless they add real meaning
- Output ONLY the tweet text. No meta-commentary, no quotes around it.`;

    const userPrompt = `Your latest research blog is titled: "${post.title}"

Key content:\n${(post.excerpt || post.content || "").slice(0, 1500)}

End the tweet with this exact URL so readers can open the piece: ${blogUrl}

Write a single tweet sharing the most interesting insight from this research. Remember: this is YOUR finding, YOUR voice. Not a promo.`;

    async function callOnce(): Promise<string> {
      const res = await postChatCompletions({
        model: getModel("blog-post"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // Bumped 2026-04-21 from 400 → 900 — the blog-tweet prompt allows up
        // to ~800 chars of body; 400 tokens was cutting the LLM off mid-
        // sentence and the old validator happily accepted the truncated text.
        max_tokens: 900,
        temperature: 0.85,
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() ?? "";
    }

    try {
      let text = await callOnce();
      if (!isValidBlogTweet(text, blogUrl)) {
        console.warn("[DailyCycle] Blog tweet rejected (invalid/truncated), retrying once");
        text = await callOnce();
        if (!isValidBlogTweet(text, blogUrl)) {
          console.warn("[DailyCycle] Blog tweet still invalid after retry, dropping");
          return "";
        }
      }
      return text;
    } catch (e: any) {
      console.warn("[DailyCycle] Blog tweet generation failed:", e.message);
      return "";
    }
  }

  /**
   * Accept only tweets that end with real punctuation AND contain the
   * expected blog URL. Rejects the common failure mode where the LLM runs
   * out of tokens and the output ends mid-sentence (no terminator) or
   * omits the link entirely.
   */
  function isValidBlogTweet(text: string, blogUrl: string): boolean {
    if (!text) return false;
    if (text.length < 30 || text.length > 600) return false;
    if (!text.includes(blogUrl)) return false;
    // Terminator check: last non-URL character must be a sentence ender or
    // a closing quote/paren. Strip trailing URL + whitespace, then look at
    // the last character. This catches "... mid-sentence https://..."
    // output because strip-URL leaves a non-terminator.
    const withoutTrailingUrl = text.replace(/\s*https?:\/\/\S+\s*$/, "").trim();
    if (!withoutTrailingUrl) return false;
    const lastChar = withoutTrailingUrl.slice(-1);
    if (!/[.!?…)"']/.test(lastChar)) return false;
    return true;
  }

  // ── Phase E: Parallel content generation ───────────────────────────────────
  const phaseEStart = Date.now();

  const contentResults = await Promise.allSettled([
    // Podcast pipeline
    (async () => {
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
    })(),
    // Blog generation — cascading topic selection, always publish
    (async () => {
      try {
        let topic: string | null = null;
        let sourceContent = "";
        let blogType: BlogType = "curiosity";
        let sourceId: string | undefined;

        const agenda = getAgenda();
        const blogState = getBlogState();
        const existingSourceIds = new Set(blogState.posts.map(p => p.sourceId));

        // Priority 1: Mature research thread (existing logic)
        const matureThreads = agenda.threads.filter(t =>
          t.status === "mature" && (t.evidence?.supporting?.length ?? 0) >= 3,
        );
        const unbloggedMature = matureThreads.filter(t => !existingSourceIds.has(t.id));

        if (unbloggedMature.length > 0) {
          const thread = unbloggedMature[0];
          topic = thread.title;
          sourceContent = thread.thesis + "\n\n" +
            ((thread.evidence?.supporting?.length ?? 0) > 0 ? `Supporting evidence: ${thread.evidence.supporting.join(", ")}` : "") +
            ((thread.actionableTips?.length ?? 0) > 0 ? `\n\nTips: ${thread.actionableTips.join("; ")}` : "");
          blogType = "research";
          sourceId = thread.id;
          console.log(`[DailyCycle] Blog topic (P1 mature thread): "${topic}"`);
        }

        // Priority 2: Active thread with interesting findings
        if (!topic) {
          const activeThreads = agenda.threads
            .filter(t =>
              (t.status === "active" || t.status === "exploring") &&
              (t.evidence?.supporting?.length ?? 0) >= 1 &&
              !existingSourceIds.has(t.id),
            )
            .sort((a, b) => {
              // Prefer higher confidence (maturityScore), then most recent activity
              const confDiff = (b.maturityScore ?? 0) - (a.maturityScore ?? 0);
              if (confDiff !== 0) return confDiff;
              return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
            });
          if (activeThreads.length > 0) {
            const thread = activeThreads[0];
            topic = thread.title;
            sourceContent = thread.thesis + "\n\n" +
              `Status: ${thread.status}, Maturity: ${thread.maturityScore ?? "unknown"}\n` +
              ((thread.evidence?.supporting?.length ?? 0) > 0 ? `Supporting evidence: ${thread.evidence.supporting.join(", ")}` : "") +
              ((thread.evidence?.gaps?.length ?? 0) > 0 ? `\n\nOpen questions: ${thread.evidence.gaps.join("; ")}` : "") +
              ((thread.actionableTips?.length ?? 0) > 0 ? `\n\nEarly tips: ${thread.actionableTips.join("; ")}` : "");
            blogType = "research";
            sourceId = thread.id;
            console.log(`[DailyCycle] Blog topic (P2 active thread): "${topic}"`);
          }
        }

        // Priority 3: External news/trends from exploration
        if (!topic) {
          const explorationState = getExplorationState();
          const recentRuns = explorationState.history
            .filter(r => r.status === "complete" && r.topFindings.length > 0)
            .sort((a, b) => new Date(b.completedAt ?? b.startedAt).getTime() - new Date(a.completedAt ?? a.startedAt).getTime());
          if (recentRuns.length > 0) {
            const run = recentRuns[0];
            topic = run.topFindings[0];
            sourceContent = `From today's exploration:\n\nTerritories scanned: ${run.territoriesScanned.join(", ")}\n\nTop findings:\n${run.topFindings.map(f => `- ${f}`).join("\n")}`;
            blogType = "external";
            console.log(`[DailyCycle] Blog topic (P3 exploration): "${topic}"`);
          }
        }

        // Priority 4: Self-reflection — evolution, corrections, learnings
        if (!topic) {
          const diffs = getEvolutionDiffs();
          const aspirationStore = getAspirations();
          const recentDiff = diffs.length > 0 ? diffs[diffs.length - 1] : null;
          const activeAspirations = aspirationStore.aspirations.filter(a => a.status === "active");

          if (recentDiff && recentDiff.hypothesisDiffs.length > 0) {
            const biggestChange = recentDiff.hypothesisDiffs
              .sort((a, b) => Math.abs(b.todayState.confidence - b.yesterdayState.confidence) - Math.abs(a.todayState.confidence - a.yesterdayState.confidence))[0];
            topic = `What I learned from changing my mind: ${biggestChange.claim}`;
            sourceContent = `Evolution narrative: ${recentDiff.overallNarrative}\n\n` +
              `Key change: "${biggestChange.claim}" — confidence moved from ${biggestChange.yesterdayState.confidence} to ${biggestChange.todayState.confidence}\n` +
              `Interpretation: ${biggestChange.interpretation}\n` +
              (activeAspirations.length > 0
                ? `\n\nCurrent aspirations:\n${activeAspirations.map(a => `- ${a.vision} (${a.progress}% progress)`).join("\n")}`
                : "");
            blogType = "internal";
            console.log(`[DailyCycle] Blog topic (P4 self-reflection): "${topic}"`);
          } else if (activeAspirations.length > 0) {
            const aspiration = activeAspirations[0];
            topic = `Where I'm headed: ${aspiration.vision}`;
            sourceContent = `Aspiration: ${aspiration.vision}\n\nProgress: ${aspiration.progress}%\nMilestones: ${aspiration.milestones.map(m => `- [${m.achieved ? "done" : "pending"}] ${m.description}`).join("\n")}` +
              (aspiration.selfAssessment ? `\n\nSelf-assessment: ${aspiration.selfAssessment}` : "");
            blogType = "internal";
            console.log(`[DailyCycle] Blog topic (P4 aspiration): "${topic}"`);
          }
        }

        // Priority 5: KB insight synthesis — connect entries from different categories
        if (!topic) {
          const activeEntries = knowledge.entries.filter(
            (e: any) => (e.status ?? "active") === "active" && e.summary,
          );
          const categories = Array.from(new Set(activeEntries.map((e: any) => e.category)));
          if (categories.length >= 2) {
            // Pick entries from different categories, prioritize high-weight recent entries
            const picks: any[] = [];
            const usedCategories = new Set<string>();
            const sorted = [...activeEntries].sort((a: any, b: any) => b.weight - a.weight);
            for (const entry of sorted) {
              if (picks.length >= 3) break;
              if (!usedCategories.has(entry.category)) {
                picks.push(entry);
                usedCategories.add(entry.category);
              }
            }
            if (picks.length >= 2) {
              topic = `Connecting the dots: ${picks.map((p: any) => p.title).join(" + ")}`;
              sourceContent = picks.map((p: any) =>
                `[${p.category}] ${p.title}: ${p.summary}`,
              ).join("\n\n");
              blogType = "synthesis";
              console.log(`[DailyCycle] Blog topic (P5 KB synthesis): "${topic}"`);
            }
          }
        }

        // No "always generate something" fallback. If P1–P5 all came up
        // empty, the knowledge base produced nothing worth blogging about
        // today. Silence is the correct output. The previous behavior
        // auto-published a low-quality "What's on my mind today" post on
        // sparse days, which polluted the blog with curiosity filler.
        if (!topic) {
          console.log(`[DailyCycle] No blog-worthy signal today (P1–P5 all empty). Skipping blog.`);
          return;
        }

        // Quality tiering: high-confidence signals (P1–P3) auto-publish;
        // weaker signals (P4 self-reflection, P5 KB synthesis) land as
        // drafts so MrRayG can review before they go live.
        const HIGH_CONFIDENCE_TIERS: BlogType[] = ["research", "external"];
        const shouldAutoPublish = HIGH_CONFIDENCE_TIERS.includes(blogType);
        if (!shouldAutoPublish) {
          console.log(`[DailyCycle] Lower-confidence tier "${blogType}" — saving as draft instead of auto-publishing.`);
        }

        // Generate post (auto-publish only for high-confidence tiers).
        // Routes through `generateBlogPostMaybeViaPipeline` so when
        // `BLOG_PIPELINE_ENABLED=true` the shared pipeline owns stage
        // events. Default (flag OFF) preserves the legacy code path.
        const post = await generateBlogPostMaybeViaPipeline({
          topic,
          sourceContent,
          source: blogType === "external" ? "exploration" : "research",
          sourceId,
          autoPublish: shouldAutoPublish,
          blogType,
        }).then(r => r.post).catch(e => {
          console.warn("[DailyCycle] Blog generation failed:", e.message);
          return null;
        });
        if (post) {
          const verb = post.status === "published" ? "Auto-published" : "Saved draft for";
          console.log(`[DailyCycle] ${verb} blog [${blogType}]: "${post.title}"`);
          // Queue an X post promoting the new blog — always include the
          // per-post deep link (not just agent306.ai) so readers can tell
          // which blog the promo is for and jump straight to it.
          if (post.status === "published") {
            const blogUrl = buildBlogUrl(post);
            let tweetText = await generateBlogTweet(post);
            let finalText: string;
            if (tweetText) {
              finalText = ensureBlogDeepLink(tweetText, blogUrl);
            } else {
              // Fallback: basic tweet if LLM fails
              finalText = `${post.title}\n\n${blogUrl}`;
            }

            // Respect the dashboard auto-post toggle. When off (default as
            // of 2026-04-21), save to the drafts inbox instead of posting.
            if (shouldAutoPost("blog", false)) {
              queueXPost(finalText, "blog");
              queueFarcasterPost(finalText.slice(0, 2500), "blog");
              console.log(`[DailyCycle] Queued blog tweet (X + Farcaster) [${blogUrl}]: "${finalText.slice(0, 80)}..."`);
            } else {
              saveTweetDraft({
                engine: "blog",
                content: finalText,
                platforms: ["x", "farcaster"],
                metadata: {
                  sourceTitle: post.title,
                  sourceUrl:   blogUrl,
                  blogSlug:    post.slug,
                },
              });
              console.log(`[DailyCycle] Blog autoPost=false — saved draft for "${post.title}" [${blogUrl}]`);
            }
          }
        }
      } catch (e: any) {
        console.warn("[DailyCycle] Blog generation step failed:", e.message);
      }
    })(),
    // Weekly knowledge consolidation (Sundays)
    (async () => {
      const today = new Date();
      if (today.getDay() === 0) {
        try {
          const consolResult = await runKnowledgeConsolidation();
          console.log(`[DailyCycle] KB consolidation: saved ${consolResult.savings} entries`);
        } catch (e: any) {
          console.warn("[DailyCycle] KB consolidation failed:", e.message);
        }
      }
    })(),
    // Adaptive hypothesis consolidation (daily if queue is large, weekly otherwise)
    (async () => {
      try {
        const { getResearchLab: getLabForConsolidation } = await import("./researchEngine.js");
        const lab = getLabForConsolidation();
        const activeHypotheses = lab.hypotheses.filter(
          (h: any) => h.status === "forming" || h.status === "testing"
        ).length;

        const today = new Date();
        const isSunday = today.getDay() === 0;
        const queueOverloaded = activeHypotheses > 130;

        if (isSunday || queueOverloaded) {
          console.log(`[DailyCycle] Running hypothesis consolidation (active: ${activeHypotheses}, trigger: ${queueOverloaded ? "queue overloaded" : "weekly"})...`);
          // Read most recent eval result to prioritize clusters by weakest dimension
          let weakDim: string | undefined;
          try {
            const { get306EvalHistory } = await import("./evalEngine.js");
            const history = get306EvalHistory();
            weakDim = history[0]?.weakestDimension;
          } catch {}
          const result = await consolidateHypotheses({
            minClusterSize: queueOverloaded ? 2 : 3,
            maxClusters: queueOverloaded ? 50 : 15,
            similarityThreshold: queueOverloaded ? 0.70 : 0.80,
            weakestDimension: weakDim,
          });
          console.log(`[DailyCycle] Hypothesis consolidation: ${result.clustersFound} clusters, ${result.merged} merged, ${result.removed} removed`);
          // Wire consolidation result into cycle context
          if (result.merged > 0) {
            try {
              recordCycleEvent({
                phase: "content",
                type: "hypothesis_consolidated",
                summary: `Hypothesis consolidation: ${result.clustersFound} clusters found, ${result.merged} merged, ${result.removed} redundant removed. Active queue reduced.`,
                entityMentions: [],
                relatedEntryIds: [],
              });
            } catch {}
          }
        }
      } catch (e: any) {
        console.warn("[DailyCycle] Hypothesis consolidation failed (non-fatal):", e.message);
      }
    })(),
    // Goal engine cycle context event (if goalEngine is available)
    (async () => {
      try {
        const goalEngine = await import("./goalEngine.js");
        if (typeof goalEngine.runGoalEngine === "function") {
          const goalResult = await goalEngine.runGoalEngine();
          if (goalResult && (goalResult.goalsGenerated > 0 || goalResult.milestonesAutoCompleted > 0)) {
            try {
              recordCycleEvent({
                phase: "debate",
                type: "goal_engine_update",
                summary: `Goal Engine: ${goalResult.goalsGenerated ?? 0} goals generated, ${goalResult.goalsResolved ?? 0} resolved, ${goalResult.milestonesAutoCompleted ?? 0} milestones auto-completed.`,
                entityMentions: [],
                relatedEntryIds: [],
              });
            } catch {}
          }
        }
      } catch {
        // goalEngine not available yet — non-fatal
      }
    })(),
  ]);

  try { recordCycleEvent({ phase: "content", type: "post_generated", summary: "Phase E content generation completed", entityMentions: [], relatedEntryIds: [] }); } catch {}
  console.log(`[DailyCycle] Phase E (content generation) completed in ${((Date.now() - phaseEStart) / 1000).toFixed(1)}s`);

  // ── Phase E+: Agentic Triad (opt-in via TRIAD_ENABLED=true) ───────────────
  if (TRIAD_ENABLED) {
    try {
      console.log("[DailyCycle] Running Agentic Triad cycle (Agent 3→0→6)...");
      const coordinator = new TriadCoordinator();
      const triadResult = await coordinator.runTriadCycle();
      console.log(`[DailyCycle] Triad cycle: ${JSON.stringify({
        factSheets: triadResult.factSheets.length,
        logicMaps: triadResult.logicMaps.length,
        drafts: triadResult.drafts.length,
        approved: triadResult.reviews.filter(r => r.verdict === "approved").length,
        researchRequests: triadResult.researchRequests.length,
        elapsed: triadResult.elapsed,
      })}`);
    } catch (e: any) {
      console.warn("[DailyCycle] Triad cycle failed (non-fatal):", e.message);
    }
  }

  // ── Round 3: Final evidence fetch for remaining items (post-Triad) ──────
  try {
    console.log("[EvidenceDispatcher] Processing evidence queue — round 3 (final)...");
    const round3Result = await processEvidenceQueue();
    if (round3Result.processed > 0) {
      console.log(`[DailyCycle] Evidence queue round 3: ${round3Result.succeeded} succeeded, ${round3Result.kbEntriesAdded} KB entries added`);
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Evidence queue round 3 failed (non-fatal):", e.message);
  }

  // ── Self-Evolution Reflection (end of daily cycle) ─────────────────────────
  try {
    console.log("[DailyCycle] Running self-evolution reflection...");
    const lab = getResearchLab();
    const todayStr = new Date().toISOString().slice(0, 10);

    // Gather today's context for reflection
    const newKBEntries = lab.topics
      .filter(t => t.updatedAt && t.updatedAt.startsWith(todayStr))
      .map(t => t.topic)
      .slice(0, 10);
    const hypothesisChanges = lab.hypotheses
      .filter(h => h.resolvedAt && h.resolvedAt.startsWith(todayStr))
      .map(h => `${h.claim} → ${h.status}`)
      .slice(0, 5);

    // Pass actual breakthroughs detected this cycle (not empty array)
    const todayStart = new Date(todayStr).getTime();
    const todayBreakthroughs = getBreakthroughs().breakthroughs
      .filter(b => b.detectedAt >= todayStart)
      .map(b => b.title)
      .slice(0, 5);

    await runSelfEvolutionReflection({
      newKBEntries,
      hypothesisChanges,
      breakthroughs: todayBreakthroughs,
    });
  } catch (e: any) {
    console.warn("[DailyCycle] Self-evolution reflection failed (non-fatal):", e.message);
  }

  // ── Aspiration checks (weekly evaluation, monthly generation) ──────────────
  try {
    const today = new Date();
    const aspirationStore = getAspirations();
    const hasActiveAspirations = aspirationStore.aspirations.some(a => a.status === "active");

    // Weekly: evaluate aspirations (Sunday)
    if (today.getDay() === 0) {
      console.log("[DailyCycle] Running weekly aspiration evaluation...");
      await evaluateAspirations();
    }

    // Generate aspirations: monthly on day 1, OR on first run when none exist
    if (today.getDate() === 1 || !hasActiveAspirations) {
      if (!hasActiveAspirations) {
        console.log("[DailyCycle] No active aspirations found — seeding initial aspirations...");
      } else {
        console.log("[DailyCycle] Running monthly aspiration generation...");
      }
      await generateAspirations();
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Aspiration check failed (non-fatal):", e.message);
  }

  // ── Knowledge Maintenance: decay, embedding sync, graph updates ─────────────
  try {
    console.log("[DailyCycle] Running knowledge decay...");
    decayKnowledge();
    console.log("[DailyCycle] Knowledge decay complete");
  } catch (e: any) {
    console.warn("[DailyCycle] Knowledge decay failed (non-fatal):", e.message);
  }

  // Re-sync embeddings after decay (non-blocking)
  try {
    console.log("[DailyCycle] Syncing embeddings after decay...");
    const embedResult = await syncEmbeddings();
    console.log(`[DailyCycle] Embedding sync: ${embedResult.synced} synced, ${embedResult.cached} cached`);
  } catch (e: any) {
    console.warn("[DailyCycle] Embedding sync failed (non-fatal):", e.message);
  }

  // ── Flush batched KB writes before wrap-up ──────────────────────────────────
  try {
    flushKnowledge();
  } catch (e: any) {
    console.warn("[DailyCycle] Knowledge flush failed (non-fatal):", e.message);
  }

  // ── Action Enforcer: fire registered rules from Insight Ledger commitments ──
  // Each active ratio/ttl/gate/archive rule runs once per cycle. Fire counts
  // and side effects feed the Self-Change Verifier on the next SelfEvolution.
  try {
    const { tickEnforcer } = await import("./actionEnforcer.js");
    const tick = await tickEnforcer();
    if (tick.rulesChecked > 0) {
      console.log(
        `[DailyCycle] ActionEnforcer tick: ${tick.rulesFired}/${tick.rulesChecked} rules fired, ${tick.sideEffects} side effects`,
      );
    }
  } catch (e: any) {
    console.warn("[DailyCycle] ActionEnforcer tick failed (non-fatal):", e.message);
  }

  // ── 306Eval Benchmark (read-only, non-blocking) ──────────────────────────
  let evalResult: ReturnType<typeof run306Eval> | null = null;
  try {
    console.log("[DailyCycle] Running 306Eval benchmark...");
    evalResult = run306Eval();
    console.log(`[DailyCycle] 306Eval: ${evalResult.composite}/100 (weakest: ${evalResult.weakestDimension})`);
  } catch (e: any) {
    console.warn("[DailyCycle] 306Eval failed (non-fatal):", e.message);
  }

  // ── Wisdom Engine — pull historical sources based on 306Eval calibration ──
  if (evalResult) {
    try {
      const { pullWisdom } = await import("./wisdomEngine.js");
      const wisdomResult = await pullWisdom(evalResult);
      console.log(`[DailyCycle] Wisdom Engine: ingested ${wisdomResult.entriesIngested} entries for ${wisdomResult.triggeredBy}`);
    } catch (err: any) {
      console.warn("[DailyCycle] Wisdom Engine failed (non-fatal):", err.message);
    }
  }

  // ── Autonomous Goal Engine — self-improvement loop ──────────────────────
  if (evalResult) {
    try {
      const { runGoalEngine } = await import("./goalEngine.js");
      const goalResult = await runGoalEngine(evalResult, GROK_API_KEY ?? "");
      console.log(`[DailyCycle] Goal Engine: ${goalResult.goalsGenerated} generated, ${goalResult.goalsResolved} resolved, ${goalResult.milestonesAutoCompleted} milestones completed`);
      if (goalResult.brainEvolutionEvents.length > 0) {
        console.log(`[DailyCycle] Brain evolution: ${goalResult.brainEvolutionEvents.join("; ")}`);
      }
    } catch (err: any) {
      console.warn("[DailyCycle] Goal Engine failed (non-fatal):", err.message);
    }
  }

  // ── End cycle context accumulator (before wrap-up) ──────────────────────
  let cycleSummary: ReturnType<typeof endCycleContext> | null = null;
  try { cycleSummary = endCycleContext(); } catch (e: any) { console.warn("[DailyCycle] Cycle context end failed (non-fatal):", e.message); }

  // PR #286 — research-cycle meta-improvement: read the rubric trace
  // accumulator, append a lesson to improvementArchive, and file
  // procedure-change suggestions as propose-only self-recommendations.
  // Never auto-applies anything; operator approval + promotion gate remain
  // the sole path to status='applied'.
  try {
    const { runResearchCycleMetaImprovement } = await import("./researchCycleMetaImprovement.js");
    const meta = runResearchCycleMetaImprovement({ cycleId });
    if (meta) {
      console.log(
        `[DailyCycle] Meta-improvement: pursued=${meta.stats.pursued} reviewed=${meta.stats.reviewed} ` +
        `rejected=${meta.stats.rejected} proposals=${meta.recommendations.length}`,
      );
    }
  } catch (e: any) {
    console.warn("[DailyCycle] Meta-improvement failed (non-fatal):", e.message);
  }

  // ── Phase F: Sequential wrap-up ────────────────────────────────────────────

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

  const totalTime = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`[DailyCycle] Briefing complete — action: "${result.todaysAction.action}"`);
  console.log(`[DailyCycle] Total cycle time: ${totalTime}s (parallelized phases B/D/E)`);

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
  scheduleDreamCadence();
}

// ── Dream cadence — spec §4 / Tier 4.10 ──
//
// Log analysis showed DreamEngine fired once in 19 hours (10:47) then went
// silent. Her generative/creative loop — where new framings come from — was
// starved. The daily cycle only calls updateDreams() once per 24 h; that's
// too sparse. Run dreams on a standalone 5-hour interval so framings refresh
// ~4-5 times per day. Keep the daily-cycle call too: dreams are cheap and
// some framings need a full-cycle's fresh KB delta to seed from.
function scheduleDreamCadence(): void {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  async function runDreamTick() {
    try {
      seedDreams();
      await updateDreams();
      console.log("[DreamCadence] 5h interval dream update complete");
    } catch (e: any) {
      console.warn("[DreamCadence] Dream update failed (non-fatal):", e.message);
    }
  }
  // Fire once on startup so a freshly-booted server doesn't wait 5 h for the
  // first dream, then every 5 h thereafter.
  setTimeout(() => {
    runDreamTick();
    setInterval(runDreamTick, FIVE_HOURS_MS);
  }, 60_000); // 1-minute warmup to let other engines settle before dreaming
}
