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
import { semanticSearch } from "./embeddingEngine.js";
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
import { getResearchLab, resolveHypothesis, addHypothesis, testHypothesis, runResearchPipeline, researchWithPerplexity, researchWithSemanticScholar } from "./researchEngine.js";
import { clusterKnowledge, detectContradictions as detectGraphContradictions } from "./knowledge-graph.js";
import { runResearchAgendaCycle } from "./research-agenda.js";
import { runResearchAnalysisCycle } from "./researchAnalysisEngine.js";
import { updateDreams, takeGrowthSnapshot, generateSelfImprovementPlan, executeImprovementActions, seedDreams } from "./dreamEngine.js";
import { runAutoPodcastPipeline } from "./podcastEngine.js";
import { generateBlogPost, getBlogState } from "./blogEngine.js";
import { getAgenda } from "./research-agenda.js";
import { analyzeDailyCycle } from "./analyzerEngine.js";
import { runKnowledgeConsolidation } from "./knowledgeConsolidator.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { TriadCoordinator } from "./triad/coordinator.js";

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
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(240000),
    });

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

// ── Auto-resolve mature hypotheses ──────────────────────────────────────────

async function autoResolveHypotheses(): Promise<number> {
  const lab = getResearchLab();
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;

  const mature = lab.hypotheses
    .filter(h => (h.status === "forming" || h.status === "testing") && new Date(h.formedAt).getTime() < fourHoursAgo)
    .slice(0, 50);

  if (mature.length === 0) return 0;

  // Fallback KB context if semantic search fails
  const { knowledge: kb } = await import("./memoryEngine.js");
  const fallbackKbContext = kb.entries
    .filter(e => (e.status ?? "active") === "active")
    .slice(0, 15)
    .map(e => `- [${e.category}] ${e.title}: ${e.summary}`)
    .join("\n");

  const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";

  let resolved = 0;
  for (const hyp of mature) {
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
      const searchQuery = `Evidence for or against: ${hyp.claim}. ${hyp.prediction}. Look for recent data, studies, announcements, or expert analysis.`;

      // Run Perplexity + Semantic Scholar in parallel
      const [pplxSettled, scholarSettled] = await Promise.allSettled([
        pplxKey && pplxKey.length > 10
          ? researchWithPerplexity(searchQuery, pplxKey)
          : Promise.resolve({ text: "", sources: [] as string[] }),
        researchWithSemanticScholar(hyp.claim),
      ]);

      if (pplxSettled.status === "fulfilled" && (pplxSettled.value?.text?.length ?? 0) > 50) {
        liveEvidence = pplxSettled.value.text.slice(0, 2000);
        const sourceList = (pplxSettled.value?.sources?.length ?? 0) > 0
          ? `\nSources: ${pplxSettled.value.sources.slice(0, 5).join(", ")}`
          : "";
        console.log(`[DailyCycle] Live evidence gathered for "${hyp.claim.slice(0, 50)}" — ${liveEvidence.length} chars${sourceList}`);
      }

      if (scholarSettled.status === "fulfilled" && (scholarSettled.value?.papers?.length ?? 0) > 0) {
        const papers = scholarSettled.value.papers.slice(0, 5);
        academicEvidence = papers
          .map(p => `- "${p.title}" (${p.year}, ${p.citationCount} citations): ${p.abstract.slice(0, 200)}`)
          .join("\n");
        console.log(`[DailyCycle] Academic evidence gathered for "${hyp.claim.slice(0, 50)}" — ${papers.length} papers`);
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
      if (!evidenceSection) {
        evidenceSection = "\nNote: No live search was performed. Evaluate based on knowledge base only.";
      }

      const res = await fetch(GROK_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
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

Respond with ONLY valid JSON:
{"status": "confirmed" | "rejected" | "insufficient_evidence" | "expired", "resolution": "brief explanation citing specific evidence", "evidence_quality": "strong" | "moderate" | "weak" | "none"}`,
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
        }),
        signal: AbortSignal.timeout(60000),
      });

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
      if (status === "confirmed" || status === "rejected" || status === "expired") {
        resolveHypothesis(hyp.id, status as "confirmed" | "rejected" | "expired", parsed.resolution ?? "Auto-resolved by daily cycle");
        recordRejectionEvent(hyp.id, status === "rejected" ? "insufficient_evidence" : status, status === "confirmed");
        resolved++;
        console.log(`[DailyCycle] Hypothesis ${status}: "${hyp.claim.slice(0, 50)}" — evidence quality: ${parsed.evidence_quality ?? "unknown"}`);
      } else if (status === "insufficient_evidence") {
        // Keep alive — queue targeted search for next cycle
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

      // Rate limit: 5s between resolution calls
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
  const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000; // 4h maturation period before testing

  // Find "forming" hypotheses older than 4 hours that should be evaluated
  const candidates = lab.hypotheses
    .filter(h => h.status === "forming" && new Date(h.formedAt).getTime() < fourHoursAgo)
    .slice(0, 50);

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
          recordRejectionEvent(hyp.id, rubricAvg < 3 ? "low_rubric" : "weak_evidence", false);
          console.log(`[DailyCycle] Hypothesis auto-rejected (rubric avg ${rubricAvg.toFixed(1)}): "${hyp.claim.slice(0, 50)}"`);
        } else if (rubricAvg >= 8 && assessment.confidence >= 0.85) {
          // Exceptionally strong — fast-track confirm
          resolveHypothesis(hyp.id, "confirmed", `Fast-track confirmed: rubric avg ${rubricAvg.toFixed(1)}, confidence ${assessment.confidence.toFixed(2)}. ${assessment.reasoningChain.slice(0, 200)}`);
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

            if (trustScore >= 75) {
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
      signal: AbortSignal.timeout(120000),
    });

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

  // ── Phase A: Sequential prerequisites (intake + seeding + gather) ──────────
  const phaseAStart = Date.now();

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

  // 1. Gather all inputs (read-only, fast)
  const { active: activeHypotheses, expired: expiredHypotheses } = gatherHypotheses();
  const completedResearch = gatherResearchCompletions(state.lastRunAt);
  const activeGoals = gatherGoals();
  const pendingReviews = gatherPendingReviews();
  const archiveStats = getArchiveStats();
  const kbActive = getActiveKnowledgeCount();

  // 2. Auto-resolve expired hypotheses
  const resolvedNames = autoResolveExpired(expiredHypotheses);

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

  console.log(`[DailyCycle] Phase B (research & analysis) completed in ${((Date.now() - phaseBStart) / 1000).toFixed(1)}s`);

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
        console.log("[Reasoning] autoDebateHypotheses...");
        await autoDebateHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis debate failed:", e.message));

        // Round 2: Process evidence between debate and resolve (test/debate gap-filling)
        console.log("[EvidenceDispatcher] Processing evidence queue — round 2 (post-debate)...");
        await processEvidenceQueue().catch(e => console.warn("[DailyCycle] Evidence queue round 2 failed:", e.message));

        console.log("[Reasoning] autoResolveHypotheses...");
        await autoResolveHypotheses().catch(e => console.warn("[DailyCycle] Hypothesis resolution failed:", e.message));
      })(),
      // Chain B: Contradiction pipeline (sequential within chain)
      (async () => {
        await autoDetectContradictions().catch(e => console.warn("[DailyCycle] Contradiction detection failed:", e.message));
        console.log("[Reasoning] autoRedFlagCheck...");
        await autoRedFlagCheck().catch(e => console.warn("[DailyCycle] Red-flag check failed:", e.message));
        try { autoResolveOldContradictions(); } catch (e: any) { console.warn("[DailyCycle] Auto-resolve contradictions failed:", e.message); }
        await detectGraphContradictions().catch(e => console.warn("[DailyCycle] Graph contradiction detection failed:", e.message));
      })(),
      // Chain C: Independent — manuscript debates + knowledge clustering
      (async () => {
        await autoDebateManuscripts().catch(e => console.warn("[DailyCycle] Auto-debate failed:", e.message));
        await clusterKnowledge().catch(e => console.warn("[DailyCycle] Knowledge clustering failed:", e.message));
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

  console.log(`[DailyCycle] Phase D (self-improvement) completed in ${((Date.now() - phaseDStart) / 1000).toFixed(1)}s`);

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
    // Blog generation
    (async () => {
      try {
        const agenda = getAgenda();
        const matureThreads = agenda.threads.filter(t =>
          t.status === "mature" && (t.evidence?.supporting?.length ?? 0) >= 3,
        );

        const blogState = getBlogState();
        const existingSourceIds = new Set(blogState.posts.map(p => p.sourceId));
        const unbloggedThreads = matureThreads.filter(t => !existingSourceIds.has(t.id));

        if (unbloggedThreads.length > 0) {
          const thread = unbloggedThreads[0];
          const sourceContent = thread.thesis + "\n\n" +
            ((thread.evidence?.supporting?.length ?? 0) > 0 ? `Supporting evidence: ${thread.evidence.supporting.join(", ")}` : "") +
            ((thread.actionableTips?.length ?? 0) > 0 ? `\n\nTips: ${thread.actionableTips.join("; ")}` : "");
          const post = await generateBlogPost({
            topic: thread.title,
            sourceContent,
            source: "research",
            sourceId: thread.id,
            autoPublish: true,
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
  ]);

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
}
