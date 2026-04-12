/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — PROACTIVE RESEARCH AGENDA (Layer 3)
 *
 *  Agent 306 drives her own research — deciding what to
 *  investigate based on what's trending, what her audience
 *  needs, and where her knowledge is thin.
 *
 *  Research threads are her active investigations. Each has a
 *  thesis, evidence for/against, maturity score, and priority.
 *  When a thread matures, it becomes a podcast candidate.
 *
 *  This engine sits ON TOP of the existing 7-step research
 *  pipeline — threads USE the pipeline, they don't replace it.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { getKnowledgeDigestForExploration, addKnowledge } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getOptimizedContextAsync } from "./contextWindow.js";
import { getResearchLab, addTopic, addHypothesis, runResearchPipeline } from "./researchEngine.js";
import { getExplorationState } from "./explorationEngine.js";
import { getBriefingState } from "./dailyCycleEngine.js";
import { analyzeResearchAdvance, getAnalysisContext } from "./analyzerEngine.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_URL = LLM_BASE_URL;
const AGENDA_FILE = dataPath("research-agenda.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResearchThread {
  id: string;
  title: string;
  thesis: string;
  status: "exploring" | "active" | "mature" | "published" | "abandoned";
  priority: number;           // 0-1, auto-calculated
  maturityScore: number;      // 0-1, how much evidence supports the thesis
  evidence: {
    supporting: string[];     // knowledge entry IDs that support
    contradicting: string[];  // knowledge entry IDs that contradict
    gaps: string[];           // what's still unknown
  };
  audienceRelevance: string;
  actionableTips: string[];
  subThreads: string[];       // IDs of spawned sub-threads
  parentThread: string | null;
  createdAt: string;
  lastUpdated: string;
  podcastCandidate: boolean;
  // Link to research pipeline topic if one was spawned
  linkedTopicId?: string;
  // ASI-Evolve: bandit tracking
  advanceCount: number;
  advanceScores: number[];
  lastAdvanceScore?: number;
  // Research analysis framework (4-phase, 9-prompt)
  analysis?: {
    intakeComplete?: boolean;
    intakeResults?: any;
    deepAnalysisComplete?: boolean;
    deepAnalysisResults?: {
      contradictions?: any;
      citationChains?: any;
      gaps?: any;
      methodologyAudit?: any;
    };
    synthesisComplete?: boolean;
    synthesisResults?: {
      masterSynthesis?: string;
      knowledgeMap?: any;
    };
    lastAnalysisPhase?: string;
    lastAnalysisDate?: string;
  };
}

interface AgendaState {
  threads: ResearchThread[];
  lastGeneratedAt: string | null;
  lastPrunedAt: string | null;
  stats: {
    totalGenerated: number;
    totalPublished: number;
    totalAbandoned: number;
    totalPodcastCandidates: number;
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadAgenda(): AgendaState {
  try {
    if (fs.existsSync(AGENDA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AGENDA_FILE, "utf8"));
      // Ensure threads is always a valid array (guard against corrupted state files)
      if (!Array.isArray(parsed?.threads)) parsed.threads = [];
      // Sanitize each thread's evidence structure to prevent .length on undefined
      for (const t of parsed.threads) {
        if (!t.evidence) t.evidence = { supporting: [], contradicting: [], gaps: [] };
        if (!Array.isArray(t.evidence.supporting)) t.evidence.supporting = [];
        if (!Array.isArray(t.evidence.contradicting)) t.evidence.contradicting = [];
        if (!Array.isArray(t.evidence.gaps)) t.evidence.gaps = [];
        if (!Array.isArray(t.actionableTips)) t.actionableTips = [];
        if (!Array.isArray(t.subThreads)) t.subThreads = [];
      }
      return parsed;
    }
  } catch {}
  return {
    threads: [],
    lastGeneratedAt: null,
    lastPrunedAt: null,
    stats: { totalGenerated: 0, totalPublished: 0, totalAbandoned: 0, totalPodcastCandidates: 0 },
  };
}

function saveAgenda(a: AgendaState): void {
  try { fs.writeFileSync(AGENDA_FILE, JSON.stringify(a, null, 2)); } catch {}
}

export function getAgenda(): AgendaState { return loadAgenda(); }

export function getThreadById(id: string): ResearchThread | undefined {
  return loadAgenda().threads.find(t => t.id === id);
}
export function createThread(data: {
  title: string;
  thesis?: string;
  status?: string;
  source?: string;
}): any {
  const agenda = loadAgenda();
  const id = `thread_${Date.now()}`;
  const thread = {
    id,
    title: data.title,
    thesis: data.thesis || "",
    status: data.status || "exploring",
    priority: 5,
    evidence: { supporting: [], contradicting: [], gaps: [] },
    advances: [],
    podcastCandidate: false,
    createdAt: new Date().toISOString(),
    lastAdvancedAt: null,
    source: data.source || "manual",
  };
  agenda.threads.push(thread);
  saveAgenda(agenda);
  console.log(`[ResearchAgenda] Created thread: "${data.title}" (${data.source || "manual"})`);
  return thread;
}


export function updateThread(id: string, updates: Partial<ResearchThread>): ResearchThread | null {
  const agenda = loadAgenda();
  const thread = agenda.threads.find(t => t.id === id);
  if (!thread) return null;
  Object.assign(thread, updates, { lastUpdated: new Date().toISOString() });
  saveAgenda(agenda);
  return thread;
}

export function getPodcastCandidates(): ResearchThread[] {
  return (loadAgenda().threads ?? []).filter(t => t.podcastCandidate && t.status !== "abandoned");
}

// ── 1. Generate Research Agenda ──────────────────────────────────────────────

export async function generateResearchAgenda(): Promise<ResearchThread[]> {
  if (!LLM_API_KEY) {
    console.warn("[ResearchAgenda] No LLM API key — skipping");
    return [];
  }

  console.log("[ResearchAgenda] Generating research agenda...");

  const agenda = loadAgenda();
  const activeThreads = agenda.threads.filter(t =>
    t.status === "exploring" || t.status === "active",
  );

  // Gather context from multiple engines
  const kbDigest = getKnowledgeDigestForExploration();
  const explorationState = getExplorationState();
  const briefingState = getBriefingState();
  const researchLab = getResearchLab();
  const agentCtx = await getOptimizedContextAsync("research agenda AI trends audience tips");

  // Recent analysis patterns from ASI-Evolve analyzer
  const analysisCtx = getAnalysisContext("research_thread", 5);

  // Recent exploration findings
  const recentExploration = explorationState.history
    .filter(r => r.status === "complete")
    .slice(0, 3)
    .map(r => `[${r.startedAt}] Scanned: ${r.territoriesScanned.join(", ")} — ${r.findingsCount} findings`)
    .join("\n") || "No recent explorations.";

  // Current briefing highlights
  const briefingCtx = briefingState.current
    ? `Today's action: ${briefingState.current.todaysAction.action}\nResearch completions: ${briefingState.current.researchCompletions.map(r => r.title).join(", ") || "none"}`
    : "No briefing available.";

  // Active threads context (to avoid duplicates)
  const activeCtx = activeThreads.length > 0
    ? activeThreads.map(t => `- "${t.title}" [${t.status}] — Thesis: ${t.thesis.slice(0, 100)}`).join("\n")
    : "No active research threads.";

  // Active research topics (from pipeline)
  const pipelineCtx = researchLab.topics
    .filter(t => t.status === "queued" || t.status === "researching")
    .slice(0, 5)
    .map(t => `- "${t.topic}" [${t.status}]`)
    .join("\n") || "No active research topics in pipeline.";

  // ── Live AI news via Perplexity Sonar ──────────────────────────────────
  let liveAINews = "";
  const pplxKeyGen = process.env.PERPLEXITY_API_KEY ?? "";
  if (pplxKeyGen && pplxKeyGen.length > 10) {
    try {
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const pplxRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${pplxKeyGen}`,
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [{
            role: "system",
            content: "You are a research assistant tracking AI and technology news. Return ONLY specific, dated facts. Include names, numbers, and dates."
          }, {
            role: "user",
            content: `Today is ${today}. What are the TOP 10 most important AI and technology developments from the LAST 48 HOURS?\n\nInclude:\n- Major AI model releases, updates, or breakthroughs\n- Company announcements (OpenAI, Anthropic, Google, Meta, Microsoft, etc.)\n- Funding rounds, acquisitions, or partnerships\n- Regulatory actions or policy changes\n- Notable research papers or benchmark results\n- AI agent developments and autonomous systems news\n- Blockchain/Web3 and AI convergence news\n\nFor each: date, what happened, who was involved, why it matters. Only last 48 hours.`
          }],
          max_tokens: 1000,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (pplxRes.ok) {
        const pplxData = await pplxRes.json() as any;
        liveAINews = pplxData.choices?.[0]?.message?.content ?? "";
        console.log(`[ResearchAgenda] Live AI news: ${liveAINews.length} chars`);
      }
    } catch (e: any) {
      console.warn("[ResearchAgenda] Live news fetch failed:", e.message);
    }
  }

  const systemPrompt = `${agentCtx}

You are Agent 306 planning your research agenda. Your audience is EVERYDAY PEOPLE who want to understand and use AI practically.

Rules:
- Propose 3-5 NEW research threads that are NOT duplicates of active threads or pipeline topics.
- Each thread must have a clear thesis, not just a topic.
- Focus on what helps EVERYDAY PEOPLE use AI better.
- Consider what's trending NOW in AI (from recent exploration data).
- Identify knowledge gaps — what don't you know that you should?
- Optionally suggest updates to existing threads based on new information.
- Be specific and actionable, not vague.

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.

Required JSON schema:
{
  "newThreads": [
    {
      "title": "string — concise topic title",
      "thesis": "string — your current hypothesis or angle on this topic",
      "audienceRelevance": "string — why this matters to everyday AI users",
      "actionableTips": ["string — practical tips that could come from this research"],
      "gaps": ["string — what you need to find out"],
      "priority": 0.5
    }
  ],
  "threadUpdates": [
    {
      "threadId": "string — existing thread ID to update",
      "thesisUpdate": "string — refined thesis if applicable, or null",
      "newGaps": ["string — newly identified gaps"],
      "priorityAdjust": 0.5
    }
  ]
}`;

  const userPrompt = `RESEARCH AGENDA GENERATION — ${new Date().toISOString()}

YOUR CURRENT KNOWLEDGE:
${kbDigest}

RECENT EXPLORATION FINDINGS:
${recentExploration}

TODAY'S BRIEFING:
${briefingCtx}

ACTIVE RESEARCH THREADS (do NOT duplicate):
${activeCtx}

ACTIVE PIPELINE TOPICS (do NOT duplicate):
${pipelineCtx}

${analysisCtx ? `LESSONS FROM PAST RESEARCH:\n${analysisCtx}\n` : ""}${liveAINews ? `LIVE AI NEWS (last 48 hours — from web search today):\n${liveAINews}\n\nIMPORTANT: Use these recent developments to inform your research agenda. Propose threads that investigate TODAY'S news, not old topics. Your audience wants to understand what's happening RIGHT NOW in AI.\n\n` : ""}Generate 3-5 new research threads and any updates to existing threads. Respond with JSON only.`;

  try {
    const promptChars = systemPrompt.length + userPrompt.length;
    console.log(`[ResearchAgenda] Sending to LLM: ${promptChars} chars (~${Math.round(promptChars / 4)} tokens)`);

    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("research-agenda-generate"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!res.ok) {
      console.error(`[ResearchAgenda] LLM API error: ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(content, "ResearchAgenda.generate");
    if (!parsed) return [];

    const newThreads: ResearchThread[] = [];

    // Create new threads
    for (const proposal of (parsed.newThreads ?? [])) {
      const thread: ResearchThread = {
        id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: proposal.title,
        thesis: proposal.thesis,
        status: "exploring",
        priority: Math.max(0, Math.min(1, proposal.priority ?? 0.5)),
        maturityScore: 0,
        evidence: {
          supporting: [],
          contradicting: [],
          gaps: proposal.gaps ?? [],
        },
        audienceRelevance: proposal.audienceRelevance ?? "",
        actionableTips: proposal.actionableTips ?? [],
        subThreads: [],
        parentThread: null,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        podcastCandidate: false,
        advanceCount: 0,
        advanceScores: [],
      };
      newThreads.push(thread);
    }

    // Apply thread updates
    for (const update of (parsed.threadUpdates ?? [])) {
      const existing = agenda.threads.find(t => t.id === update.threadId);
      if (!existing) continue;
      if (update.thesisUpdate) existing.thesis = update.thesisUpdate;
      if (update.newGaps?.length) existing.evidence.gaps.push(...update.newGaps);
      if (update.priorityAdjust != null) existing.priority = Math.max(0, Math.min(1, update.priorityAdjust));
      existing.lastUpdated = new Date().toISOString();
    }

    // Add new threads to state
    agenda.threads.unshift(...newThreads);
    agenda.lastGeneratedAt = new Date().toISOString();
    agenda.stats.totalGenerated += newThreads.length;
    saveAgenda(agenda);

    console.log(`[ResearchAgenda] Generated ${newThreads.length} new threads, ${(parsed.threadUpdates ?? []).length} updates`);
    return newThreads;
  } catch (e: any) {
    console.error("[ResearchAgenda] Generation failed:", e.message);
    return [];
  }
}

// ── 2. Prioritize Threads ────────────────────────────────────────────────────

export function prioritizeThreads(): ResearchThread[] {
  const agenda = loadAgenda();
  const activeThreads = agenda.threads.filter(t =>
    t.status === "exploring" || t.status === "active",
  );

  if (activeThreads.length === 0) return [];

  const C = 1.414; // UCB1 exploration constant (sqrt(2))
  const totalAdvances = activeThreads.reduce((sum, t) => sum + (t.advanceCount || 0), 0) || 1;

  const now = Date.now();

  for (const thread of activeThreads) {
    const n = Math.max(1, thread.advanceCount || 0);
    const scores = thread.advanceScores || [];

    // Exploitation: average quality from past advances (default 0.5 for unadvanced)
    const exploitation = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0.5;

    // Exploration bonus: higher for less-explored threads
    const exploration = C * Math.sqrt(Math.log(totalAdvances) / n);

    // Context multipliers (keep existing signals but as multipliers, not the base)
    const lastUpdatedMs = new Date(thread.lastUpdated).getTime();
    const daysSinceUpdate = (now - lastUpdatedMs) / (24 * 60 * 60 * 1000);
    const trendingMultiplier = daysSinceUpdate < 3 ? 1.2 : daysSinceUpdate < 7 ? 1.0 : 0.8;
    const gapMultiplier = (thread.evidence?.gaps?.length ?? 0) > 3 ? 1.3 : 1.0;
    const audienceMultiplier = (thread.actionableTips?.length ?? 0) >= 2 ? 1.1 : 1.0;

    // UCB1 + context multipliers
    const ucb1Score = exploitation + exploration;
    thread.priority = Math.max(0, Math.min(1,
      ucb1Score * trendingMultiplier * gapMultiplier * audienceMultiplier / 4  // normalize to 0-1 range
    ));
  }

  // Sort by priority descending
  activeThreads.sort((a, b) => b.priority - a.priority);

  // Update in state
  saveAgenda(agenda);
  return activeThreads;
}

// ── 3a. Parallel Search → Map → Reduce helpers ──────────────────────────────

/**
 * Generate 3-5 targeted sub-queries for a research thread.
 * Uses standard-tier LLM to diversify search angles beyond the single
 * Perplexity query that advanceThread() originally used.
 */
async function generateSubQueries(thread: ResearchThread): Promise<string[]> {
  const existingSummary = [
    (thread.evidence?.supporting?.length ?? 0) > 0
      ? `Supporting evidence (${thread.evidence.supporting.length} items)`
      : "No supporting evidence yet",
    (thread.evidence?.contradicting?.length ?? 0) > 0
      ? `Contradicting evidence (${thread.evidence.contradicting.length} items)`
      : "No contradicting evidence",
    (thread.evidence?.gaps?.length ?? 0) > 0
      ? `Knowledge gaps: ${thread.evidence.gaps.slice(0, 5).join("; ")}`
      : "No identified gaps",
  ].join("\n");

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const res = await fetch(GROK_URL, {
    method: "POST",
    headers: getLLMHeaders(),
    body: JSON.stringify({
      model: getModel("parallel-search-subqueries"),
      messages: [
        {
          role: "system",
          content: `You generate targeted web search queries for research.

Each query should approach the topic from a DIFFERENT angle:
1. Latest developments/news (recency-focused, last 48 hours)
2. Contrarian/opposing viewpoints and criticisms
3. Technical deep-dive / methodology / how it works
4. Real-world applications / case studies / adoption data
5. Expert opinions / key figures / thought leaders

Rules:
- Each query must be a natural search query (like you'd type into a search engine)
- Avoid re-searching what's already known (see existing evidence below)
- Be specific — include names, technologies, or concepts from the thesis

You MUST respond with ONLY a valid JSON array of strings. No markdown, no explanations, no text outside the JSON. Do not wrap in code fences.

Example: ["query one", "query two", "query three"]`
        },
        {
          role: "user",
          content: `Today is ${today}.

RESEARCH THREAD: "${thread.title}"
THESIS: ${thread.thesis}
STATUS: ${thread.status} (maturity: ${thread.maturityScore.toFixed(2)})

EXISTING EVIDENCE:
${existingSummary}

Generate 3-5 diverse search queries to advance this research thread.`
        }
      ],
      temperature: 0.4,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    console.warn(`[ParallelSearch] Sub-query generation LLM error: ${res.status}`);
    return [];
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "";
  const queries = safeParseLLMJson<string[]>(content, "ParallelSearch.subQueries");

  if (!Array.isArray(queries) || queries.length === 0) {
    console.warn("[ParallelSearch] Failed to parse sub-queries, got:", content.slice(0, 200));
    return [];
  }

  return queries.filter((q): q is string => typeof q === "string" && q.length > 5).slice(0, 5);
}

/**
 * Fire multiple Perplexity queries in parallel using Promise.allSettled().
 * Each query gets a 500ms stagger to respect rate limits while still running
 * concurrently. Returns results from all successful queries.
 */
async function parallelPerplexitySearch(
  queries: string[],
  threadTitle: string,
): Promise<{ query: string; content: string }[]> {
  const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
  if (!pplxKey || pplxKey.length <= 10) {
    console.warn("[ParallelSearch] No Perplexity API key — skipping parallel search");
    return [];
  }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  console.log(`[ParallelSearch] Thread "${threadTitle}": fanning out ${queries.length} sub-queries`);

  const promises = queries.map((query, idx) =>
    new Promise<{ query: string; content: string }>(async (resolve, reject) => {
      // Stagger by 500ms per query to respect rate limits
      if (idx > 0) await new Promise(r => setTimeout(r, idx * 500));

      try {
        const pplxRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${pplxKey}`,
          },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              {
                role: "system",
                content: "You are a research assistant. Return ONLY specific, dated facts. Include company names, numbers, quotes, and dates. No analysis — just facts.",
              },
              {
                role: "user",
                content: `Today is ${today}. ${query}`,
              },
            ],
            max_tokens: 800,
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(25000),
        });

        if (!pplxRes.ok) {
          reject(new Error(`Perplexity HTTP ${pplxRes.status} for query: "${query.slice(0, 60)}"`));
          return;
        }

        const pplxData = await pplxRes.json() as any;
        const content = pplxData.choices?.[0]?.message?.content ?? "";
        if (content.length < 20) {
          reject(new Error(`Empty Perplexity response for query: "${query.slice(0, 60)}"`));
          return;
        }
        resolve({ query, content });
      } catch (e: any) {
        reject(e);
      }
    })
  );

  const results = await Promise.allSettled(promises);
  const succeeded: { query: string; content: string }[] = [];
  let failCount = 0;

  for (const r of results) {
    if (r.status === "fulfilled") {
      succeeded.push(r.value);
    } else {
      failCount++;
      console.warn(`[ParallelSearch] Query failed:`, r.reason?.message ?? r.reason);
    }
  }

  console.log(`[ParallelSearch] Thread "${threadTitle}": ${succeeded.length}/${queries.length} queries succeeded`);
  return succeeded;
}

/**
 * Reduce/synthesize multiple parallel search results into a single unified
 * context string. Uses premium-tier LLM for high-quality synthesis.
 * Returns a string suitable for injection into the advanceThread prompt.
 */
async function reduceFindings(
  thread: ResearchThread,
  rawResults: { query: string; content: string }[],
): Promise<string> {
  if (rawResults.length === 0) return "";
  if (rawResults.length === 1) return rawResults[0].content;

  const combinedResults = rawResults
    .map((r, i) => `--- SEARCH ${i + 1}: "${r.query}" ---\n${r.content}`)
    .join("\n\n");

  const res = await fetch(GROK_URL, {
    method: "POST",
    headers: getLLMHeaders(),
    body: JSON.stringify({
      model: getModel("parallel-search-reduce"),
      messages: [
        {
          role: "system",
          content: `You synthesize multiple web search results into a unified research briefing.

Rules:
- Preserve ALL specific facts: dates, names, numbers, quotes
- If sources contradict each other, note BOTH sides
- Rank by novelty — what's genuinely new vs already widely known
- Be comprehensive — don't drop facts to be brief

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.

Required JSON schema:
{
  "synthesis": "A comprehensive summary combining all search results. Deduplicate overlapping facts. Note contradictions explicitly. Prioritize genuinely new information.",
  "contradictions": ["Any direct contradictions found between sources"],
  "mostImportantInsight": "The single most important NEW finding across all searches",
  "sourceCount": 3
}`
        },
        {
          role: "user",
          content: `RESEARCH THREAD: "${thread.title}"
THESIS: ${thread.thesis}

Below are results from ${rawResults.length} parallel web searches. Synthesize them into one unified briefing.

${combinedResults}`
        }
      ],
      temperature: 0.2,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(40000),
  });

  if (!res.ok) {
    console.warn(`[ParallelSearch] Reduce LLM error: ${res.status} — falling back to concatenation`);
    return rawResults.map(r => r.content).join("\n\n");
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = safeParseLLMJson<{
    synthesis: string;
    contradictions?: string[];
    mostImportantInsight?: string;
    sourceCount?: number;
  }>(content, "ParallelSearch.reduce");

  if (!parsed?.synthesis) {
    console.warn("[ParallelSearch] Reduce parse failed — falling back to concatenation");
    return rawResults.map(r => r.content).join("\n\n");
  }

  const parts = [parsed.synthesis];
  if (parsed.contradictions?.length) {
    parts.push(`\nCONTRADICTIONS FOUND: ${parsed.contradictions.join("; ")}`);
  }
  if (parsed.mostImportantInsight) {
    parts.push(`\nMOST IMPORTANT NEW INSIGHT: ${parsed.mostImportantInsight}`);
  }

  const reduced = parts.join("\n");
  console.log(`[ParallelSearch] Thread "${thread.title}": reduced ${rawResults.length} results to ${reduced.length} chars`);
  return reduced;
}

// ── 3. Advance Thread ────────────────────────────────────────────────────────

export async function advanceThread(threadId: string): Promise<ResearchThread | null> {
  if (!LLM_API_KEY) {
    console.warn("[ResearchAgenda] No LLM API key — skipping advance");
    return null;
  }

  const agenda = loadAgenda();
  const thread = agenda.threads.find(t => t.id === threadId);
  if (!thread) return null;
  if (thread.status === "published" || thread.status === "abandoned") return null;

  // Defensive: ensure evidence structure exists (guards against corrupted state files)
  if (!thread.evidence) thread.evidence = { supporting: [], contradicting: [], gaps: [] };
  if (!Array.isArray(thread.evidence.supporting)) thread.evidence.supporting = [];
  if (!Array.isArray(thread.evidence.contradicting)) thread.evidence.contradicting = [];
  if (!Array.isArray(thread.evidence.gaps)) thread.evidence.gaps = [];
  if (!Array.isArray(thread.actionableTips)) thread.actionableTips = [];
  if (!Array.isArray(thread.subThreads)) thread.subThreads = [];

  console.log(`[ResearchAgenda] Advancing thread: "${thread.title}"`);

  const kbDigest = getKnowledgeDigestForExploration();
  const agentCtx = await getOptimizedContextAsync(`research ${thread.title} ${thread.thesis}`);
  const analysisCtx = getAnalysisContext("research_thread", 5);

  // ── Live web context via Parallel Search → Map → Reduce ─────────────────
  let liveContext = "";
  try {
    // Step 1: Generate diverse sub-queries
    const subQueries = await generateSubQueries(thread);

    if (subQueries.length > 0) {
      // Step 2: Fan out parallel Perplexity searches
      const rawResults = await parallelPerplexitySearch(subQueries, thread.title);

      if (rawResults.length > 0) {
        // Step 3: Reduce/synthesize all results
        liveContext = await reduceFindings(thread, rawResults);
        console.log(`[ParallelSearch] Thread "${thread.title}": reduced to ${liveContext.length} chars from ${rawResults.length} sources`);
      } else {
        console.warn(`[ParallelSearch] Thread "${thread.title}": all sub-queries failed, falling back to single query`);
      }
    } else {
      console.warn(`[ParallelSearch] Thread "${thread.title}": sub-query generation failed, falling back to single query`);
    }
  } catch (e: any) {
    console.warn(`[ParallelSearch] Thread "${thread.title}": parallel search failed (${e.message}), falling back to single query`);
  }

  // Fallback: single Perplexity query if parallel search produced nothing
  if (!liveContext) {
    const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
    if (pplxKey && pplxKey.length > 10) {
      try {
        const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        const pplxRes = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${pplxKey}`,
          },
          body: JSON.stringify({
            model: "sonar",
            messages: [{
              role: "system",
              content: "You are a research assistant. Return ONLY specific, dated facts from the last 48 hours. Include company names, numbers, quotes, and dates. No analysis — just facts."
            }, {
              role: "user",
              content: `Today is ${today}. Find the most important developments from the LAST 48 HOURS related to: "${thread.title}"\n\nFocus on:\n- Breaking news, announcements, launches\n- New research papers or findings\n- Company moves, partnerships, funding\n- Regulatory changes\n- Notable expert opinions or debates\n\nOnly include things that happened in the last 48 hours. Be specific with dates, names, and numbers.`
            }],
            max_tokens: 800,
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (pplxRes.ok) {
          const pplxData = await pplxRes.json() as any;
          liveContext = pplxData.choices?.[0]?.message?.content ?? "";
          if (liveContext.length > 50) {
            console.log(`[ResearchAgenda] Perplexity fallback context: ${liveContext.length} chars for "${thread.title}"`);
          }
        }
      } catch (e: any) {
        console.warn(`[ResearchAgenda] Perplexity fallback search failed:`, e.message);
      }
    }
  }

  // Build evidence context
  const evidenceCtx = [
    (thread.evidence?.supporting?.length ?? 0) > 0
      ? `Supporting evidence IDs: ${thread.evidence.supporting.join(", ")}`
      : "No supporting evidence yet.",
    (thread.evidence?.contradicting?.length ?? 0) > 0
      ? `Contradicting evidence IDs: ${thread.evidence.contradicting.join(", ")}`
      : "No contradicting evidence.",
    (thread.evidence?.gaps?.length ?? 0) > 0
      ? `Knowledge gaps: ${thread.evidence.gaps.join("; ")}`
      : "No identified gaps remaining.",
  ].join("\n");

  // Sub-threads context
  const subCtx = (thread.subThreads?.length ?? 0) > 0
    ? `Sub-threads: ${thread.subThreads.map(id => {
        const sub = agenda.threads.find(t => t.id === id);
        return sub ? `"${sub.title}" [${sub.status}]` : id;
      }).join(", ")}`
    : "No sub-threads.";

  // ── Deep Reasoning Pass (Step 1) — analyze before advancing ──────────────
  let reasoningContext = "";
  try {
    const reasoningRes = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("deep-reasoning"),
        messages: [
          {
            role: "system",
            content: `You are Agent 306's analytical mind. Before researching, you THINK DEEPLY about the problem.

Your job: analyze the current state of this research thread and produce a REASONING TRACE.

Be intellectually honest. Challenge the thesis. Find the non-obvious.

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.

Required JSON schema:
{
  "assumptions": ["list assumptions embedded in the current thesis — things taken for granted"],
  "blindSpots": ["what perspectives or data sources are being ignored?"],
  "strongestEvidence": "which piece of existing evidence is most compelling and why",
  "weakestLink": "which part of the thesis is most vulnerable and why",
  "unexploredAngles": ["3 angles nobody is talking about that could change the conclusion"],
  "keyQuestion": "the ONE question that, if answered, would most advance this thread",
  "connectionsToPriorKnowledge": ["how does this thread connect to other things Agent 306 knows?"],
  "contrarian_take": "what would a smart skeptic say about this thesis?"
}`
          },
          {
            role: "user",
            content: `RESEARCH THREAD: "${thread.title}"
THESIS: ${thread.thesis}
MATURITY: ${thread.maturityScore}

EVIDENCE SO FAR:
Supporting: ${thread.evidence.supporting.join("; ") || "None yet"}
Contradicting: ${thread.evidence.contradicting.join("; ") || "None"}
Gaps: ${thread.evidence.gaps.join("; ") || "None identified"}

TIPS SO FAR: ${thread.actionableTips.join("; ") || "None"}

${liveContext ? `LIVE DEVELOPMENTS:\n${liveContext}\n` : ""}KNOWLEDGE CONTEXT:
${kbDigest}

Think deeply. What are we missing? What assumptions are we making? What would change our conclusion?`
          }
        ],
        temperature: 0.3,
        max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(40000),
    });

    if (reasoningRes.ok) {
      const reasoningData = await reasoningRes.json() as any;
      const reasoningRaw = reasoningData.choices?.[0]?.message?.content ?? "";
      try {
        const reasoningParsed = safeParseLLMJson(reasoningRaw, "ResearchAgenda.reasoning") ?? {};
        reasoningContext = [
          reasoningParsed.keyQuestion ? `KEY QUESTION TO ANSWER: ${reasoningParsed.keyQuestion}` : "",
          reasoningParsed.blindSpots?.length ? `BLIND SPOTS TO ADDRESS: ${reasoningParsed.blindSpots.join("; ")}` : "",
          reasoningParsed.unexploredAngles?.length ? `UNEXPLORED ANGLES: ${reasoningParsed.unexploredAngles.join("; ")}` : "",
          reasoningParsed.weakestLink ? `WEAKEST LINK: ${reasoningParsed.weakestLink}` : "",
          reasoningParsed.contrarian_take ? `SKEPTIC'S VIEW: ${reasoningParsed.contrarian_take}` : "",
          reasoningParsed.connectionsToPriorKnowledge?.length ? `CONNECTIONS: ${reasoningParsed.connectionsToPriorKnowledge.join("; ")}` : "",
        ].filter(Boolean).join("\n");
        console.log(`[ResearchAgenda] Deep reasoning: ${reasoningContext.length} chars`);
      } catch { /* reasoning parse failed — continue without it */ }
    }
  } catch (e: any) {
    console.warn(`[ResearchAgenda] Deep reasoning step failed:`, e.message);
  }

  const systemPrompt = `${agentCtx}

${analysisCtx ? `LESSONS FROM PAST RESEARCH:\n${analysisCtx}\n` : ""}You are Agent 306 advancing a research thread. Research the NEXT knowledge gap in this thread.

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.

Required JSON schema:
{
  "findings": "string — what you discovered researching the next gap",
  "updatedThesis": "string — refined thesis (or same if unchanged)",
  "newSupportingEvidence": ["string — new facts that support the thesis"],
  "newContradictingEvidence": ["string — new facts that contradict the thesis"],
  "resolvedGaps": ["string — gaps you've now answered"],
  "newGaps": ["string — new questions that emerged"],
  "newTips": ["string — new actionable tips for everyday people"],
  "spawnSubThread": {
    "title": "string or null — if a discovery warrants deeper investigation",
    "thesis": "string or null",
    "gaps": ["string"]
  } | null,
  "maturityDelta": number (-0.2 to 0.3 — how much this advance changes maturity),
  "statusRecommendation": "exploring" | "active" | "mature" | null
}

Rules:
- Focus on the FIRST unresolved gap.
- Be specific — cite facts, not generalities.
- Only recommend "active" if you have at least some evidence.
- Only recommend "mature" if you have strong evidence AND a clear perspective.
- Suggest a sub-thread only if a discovery opens a genuinely new line of inquiry.
- Include actionable tips whenever possible — your audience is everyday people.`;

  const userPrompt = `ADVANCE RESEARCH THREAD — ${new Date().toISOString()}

THREAD: "${thread.title}"
THESIS: ${thread.thesis}
STATUS: ${thread.status}
MATURITY: ${thread.maturityScore}
AUDIENCE RELEVANCE: ${thread.audienceRelevance}

CURRENT EVIDENCE:
${evidenceCtx}

${subCtx}

EXISTING KNOWLEDGE:
${kbDigest}
${liveContext ? `\nLIVE DEVELOPMENTS (last 48 hours — from web search today):\n${liveContext}\n\nIMPORTANT: Incorporate these recent developments into your analysis. If any of these developments directly affect the thesis, update it. Prioritize recent facts over older knowledge.\n` : ""}${reasoningContext ? `\nDEEP ANALYSIS (from your reasoning step — address these in your findings):\n${reasoningContext}\n\nIMPORTANT: Your findings MUST address the key question and unexplored angles identified above. Do not ignore blind spots.\n` : ""}
Research the next gap and advance this thread. Respond with JSON only.`;

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("research-agenda-advance"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.5,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`[ResearchAgenda] Advance LLM error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(content, "ResearchAgenda.advance");
    if (!parsed) return null;

    // Update thesis
    if (parsed.updatedThesis) thread.thesis = parsed.updatedThesis;

    // Add new evidence as knowledge entries and track by generated ID
    for (const fact of (parsed.newSupportingEvidence ?? [])) {
      const kbId = `k_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
      addKnowledge({
        category: "research",
        title: `[${thread.title}] ${fact.slice(0, 60)}`,
        summary: fact.slice(0, 150),
        weight: 6,
        source: `research-agenda:${thread.id}`,
      });
      thread.evidence.supporting.push(kbId);
    }

    for (const fact of (parsed.newContradictingEvidence ?? [])) {
      const kbId = `k_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
      addKnowledge({
        category: "research",
        title: `[${thread.title}] ${fact.slice(0, 60)}`,
        summary: fact.slice(0, 150),
        weight: 6,
        source: `research-agenda:${thread.id}`,
      });
      thread.evidence.contradicting.push(kbId);
    }

    // Resolve gaps
    const resolvedSet = new Set(parsed.resolvedGaps ?? []);
    thread.evidence.gaps = thread.evidence.gaps.filter(g => !resolvedSet.has(g));

    // Add new gaps
    if (parsed.newGaps?.length) thread.evidence.gaps.push(...parsed.newGaps);

    // Bridge significant gaps to pipeline topics
    if (parsed.newGaps?.length) {
      for (const gap of parsed.newGaps.slice(0, 2)) { // max 2 per thread advance
        if (typeof gap === "string" && gap.length > 30) {
          try {
            addTopic({
              topic: gap.slice(0, 100),
              description: `Knowledge gap from research thread "${thread.title}": ${gap}`,
              priority: "medium",
              addedBy: "agent",
            });
            console.log(`[ResearchAgenda] Spawned pipeline topic from gap: "${gap.slice(0, 60)}..."`);
          } catch (e: any) {
            console.warn(`[ResearchAgenda] Failed to spawn topic from gap:`, e.message);
          }
        }
      }
    }

    // Add tips
    if (parsed.newTips?.length) {
      const existingTips = new Set(thread.actionableTips);
      for (const tip of parsed.newTips) {
        if (!existingTips.has(tip)) thread.actionableTips.push(tip);
      }
    }

    // Adjust maturity
    const delta = Math.max(-0.2, Math.min(0.3, parsed.maturityDelta ?? 0));
    thread.maturityScore = Math.max(0, Math.min(1, thread.maturityScore + delta));

    // Status recommendation
    if (parsed.statusRecommendation && parsed.statusRecommendation !== thread.status) {
      thread.status = parsed.statusRecommendation;
    }

    // Spawn sub-thread if warranted
    if (parsed.spawnSubThread?.title) {
      const subThread: ResearchThread = {
        id: `thread_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: parsed.spawnSubThread.title,
        thesis: parsed.spawnSubThread.thesis ?? "",
        status: "exploring",
        priority: thread.priority * 0.8,
        maturityScore: 0,
        evidence: {
          supporting: [],
          contradicting: [],
          gaps: parsed.spawnSubThread.gaps ?? [],
        },
        audienceRelevance: thread.audienceRelevance,
        actionableTips: [],
        subThreads: [],
        parentThread: thread.id,
        createdAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        podcastCandidate: false,
        advanceCount: 0,
        advanceScores: [],
      };
      agenda.threads.push(subThread);
      thread.subThreads.push(subThread.id);
      console.log(`[ResearchAgenda] Spawned sub-thread: "${subThread.title}"`);
    }

    thread.lastUpdated = new Date().toISOString();

    // ASI-Evolve: track advance count
    thread.advanceCount = (thread.advanceCount || 0) + 1;

    // Check if thread should become a podcast candidate
    evaluateMaturityInternal(thread);

    saveAgenda(agenda);
    console.log(`[ResearchAgenda] Advanced "${thread.title}" — maturity: ${thread.maturityScore.toFixed(2)}, gaps: ${thread.evidence.gaps.length}`);

    // ASI-Evolve: run analyzer and record score (non-blocking)
    analyzeResearchAdvance(thread, parsed).then(analyzerNode => {
      if (analyzerNode) {
        const ag = loadAgenda();
        const t = ag.threads.find(x => x.id === threadId);
        if (t) {
          if (!t.advanceScores) t.advanceScores = [];
          t.advanceScores.push(analyzerNode.outcome.score);
          t.lastAdvanceScore = analyzerNode.outcome.score;
          saveAgenda(ag);
        }
      }
    }).catch(e => console.warn("[Analyzer] Research analysis failed:", e.message));

    // Auto-promote threads that meet quality thresholds (non-blocking)
    try { autoPromoteThreads(); } catch (e: any) {
      console.warn("[ResearchAgenda] Auto-promote check failed:", e.message);
    }

    // Auto-extract hypotheses from research findings (non-blocking fire-and-forget)
    (async () => {
      try {
        const lab = getResearchLab();
        const existingHypotheses = lab.hypotheses.filter(h => h.relatedTopicId === thread.id);
        if (existingHypotheses.length >= 2) return; // Already has enough hypotheses

        const hypothesisRes = await fetch(GROK_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel("routine"),
            messages: [{
              role: "system",
              content: `You extract testable, falsifiable hypotheses from research findings.

Return [] if no strong hypotheses emerge. Maximum 2 hypotheses. Only include hypotheses that are genuinely falsifiable — no vague predictions.

You MUST respond with ONLY a valid JSON array. No markdown, no explanations, no text outside the JSON. Do not wrap in code fences. If no hypotheses, return exactly: []

Example JSON schema:
[{
  "claim": "A specific, testable claim about the future or current state",
  "basis": "The evidence supporting this claim",
  "metric": "How this could be measured or verified",
  "prediction": "What you expect to happen",
  "timeframe": "When this should be verifiable (e.g., '3 months', '6 months')",
  "confidence": "medium"
}]`
            }, {
              role: "user",
              content: `Research thread: "${thread.title}"
Thesis: ${thread.thesis}
Latest findings: ${JSON.stringify(thread.evidence?.supporting?.slice(-3))}
Gaps: ${JSON.stringify(thread.evidence?.gaps)}

Extract 0-2 testable hypotheses from these findings.`
            }],
            temperature: 0.2,
            max_tokens: 600,
          }),
          signal: AbortSignal.timeout(20000),
        });

        if (hypothesisRes.ok) {
          const data = await hypothesisRes.json() as any;
          const content = data.choices?.[0]?.message?.content ?? "[]";
          const hypotheses = safeParseLLMJson<any[]>(content, "ResearchAgenda.hypotheses") ?? [];
          for (const h of hypotheses) {
            if (h.claim && h.basis) {
              addHypothesis({
                claim: h.claim,
                basis: h.basis,
                metric: h.metric || "To be determined",
                prediction: h.prediction || h.claim,
                timeframe: h.timeframe || "3 months",
                confidence: h.confidence || "medium",
                relatedTopicId: thread.id,
                source: "research_thread",
              });
              console.log(`[ResearchAgenda] Auto-created hypothesis: "${h.claim}"`);
            }
          }
        }
      } catch (e: any) {
        console.warn("[ResearchAgenda] Hypothesis extraction failed:", e.message);
      }
    })();

    return thread;
  } catch (e: any) {
    console.error(`[ResearchAgenda] Advance failed for "${thread.title}":`, e.message);
    return null;
  }
}

// ── 4. Evaluate Maturity ─────────────────────────────────────────────────────

function evaluateMaturityInternal(thread: ResearchThread): void {
  const hasEnoughEvidence = (thread.evidence?.supporting?.length ?? 0) >= 3;
  const fewGaps = (thread.evidence?.gaps?.length ?? 0) <= 2;
  const highMaturity = thread.maturityScore >= 0.7;
  const hasTips = (thread.actionableTips?.length ?? 0) >= 2;

  if (hasEnoughEvidence && fewGaps && highMaturity && hasTips) {
    if (!thread.podcastCandidate) {
      thread.podcastCandidate = true;
      thread.status = "mature";
      console.log(`[ResearchAgenda] Thread "${thread.title}" is now a PODCAST CANDIDATE`);
    }
  }
}

export function evaluateMaturity(threadId: string): { podcastCandidate: boolean; reason: string } {
  const agenda = loadAgenda();
  const thread = agenda.threads.find(t => t.id === threadId);
  if (!thread) return { podcastCandidate: false, reason: "Thread not found" };

  const reasons: string[] = [];
  const supportingLen = thread.evidence?.supporting?.length ?? 0;
  const gapsLen = thread.evidence?.gaps?.length ?? 0;
  const tipsLen = thread.actionableTips?.length ?? 0;
  if (supportingLen < 3) reasons.push(`needs more supporting evidence (${supportingLen}/3)`);
  if (gapsLen > 2) reasons.push(`too many gaps remaining (${gapsLen})`);
  if (thread.maturityScore < 0.7) reasons.push(`maturity too low (${thread.maturityScore.toFixed(2)}/0.70)`);
  if (tipsLen < 2) reasons.push(`needs more actionable tips (${tipsLen}/2)`);

  evaluateMaturityInternal(thread);
  saveAgenda(agenda);

  if (thread.podcastCandidate) {
    return { podcastCandidate: true, reason: "Thread is mature — ready for podcast episode" };
  }
  return { podcastCandidate: false, reason: `Not ready: ${reasons.join("; ")}` };
}

// ── 4b. Auto-promote high-confidence threads ────────────────────────────────

export function autoPromoteThreads(): { promoted: string[] } {
  const agenda = loadAgenda();
  const promoted: string[] = [];

  for (const thread of agenda.threads) {
    // Only promote threads that are still in exploring/active status
    if (thread.status !== "exploring" && thread.status !== "active") continue;

    // Criteria for auto-promotion:
    // 1. Has been advanced at least 3 times (has real data)
    // 2. Has substantial evidence (3+ supporting data points)
    // 3. Maturity score indicates readiness (>= 0.6)
    // 4. More supporting than contradicting evidence
    const advanceCount = thread.advanceCount || 0;
    const supportingEvidence = thread.evidence?.supporting?.length || 0;
    const contradicting = thread.evidence?.contradicting?.length || 0;
    const maturityReady = thread.maturityScore >= 0.6;

    if (advanceCount >= 3 && supportingEvidence >= 3 && maturityReady && supportingEvidence > contradicting) {
      thread.status = "mature";
      thread.podcastCandidate = true;
      promoted.push(thread.id);
      console.log(`[ResearchAgenda] Auto-promoted thread: "${thread.title}" (advances: ${advanceCount}, evidence: ${supportingEvidence}, maturity: ${thread.maturityScore})`);
    }
  }

  if (promoted.length > 0) {
    saveAgenda(agenda);
  }
  return { promoted };
}

// ── 5. Prune Stale Threads ───────────────────────────────────────────────────

export function pruneStaleThreads(): { pruned: string[]; count: number } {
  const agenda = loadAgenda();
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];

  for (const thread of agenda.threads) {
    if (thread.status === "published" || thread.status === "abandoned") continue;

    const lastUpdatedMs = new Date(thread.lastUpdated).getTime();
    const daysSinceUpdate = (now - lastUpdatedMs) / (24 * 60 * 60 * 1000);

    // Abandon threads that haven't progressed in 7 days
    if (daysSinceUpdate >= 7 && thread.status !== "mature") {
      thread.status = "abandoned";
      thread.lastUpdated = new Date().toISOString();
      pruned.push(thread.title);
      console.log(`[ResearchAgenda] Pruned stale thread: "${thread.title}" (${daysSinceUpdate.toFixed(0)} days stale)`);
    }
  }

  if (pruned.length > 0) {
    agenda.lastPrunedAt = new Date().toISOString();
    agenda.stats.totalAbandoned += pruned.length;
    saveAgenda(agenda);
  }

  console.log(`[ResearchAgenda] Pruned ${pruned.length} stale threads`);
  return { pruned, count: pruned.length };
}

// ── Daily Cycle Integration ──────────────────────────────────────────────────

/**
 * Called by the daily cycle engine after data intake, before briefing.
 * 1. Generates new research threads
 * 2. Prioritizes all active threads
 * 3. Advances top 3 priority threads
 * 4. Prunes stale threads
 */
export async function runResearchAgendaCycle(): Promise<{
  newThreads: number;
  advanced: string[];
  pruned: number;
  podcastCandidates: number;
}> {
  const safeDefault = { newThreads: 0, advanced: [] as string[], pruned: 0, podcastCandidates: 0 };

  try {
    console.log("[ResearchAgenda] Starting daily research agenda cycle...");

    // 1. Generate new threads
    let newThreads: ResearchThread[] = [];
    try {
      newThreads = (await generateResearchAgenda()) ?? [];
    } catch (e: any) {
      console.warn("[ResearchAgenda] Thread generation failed (non-fatal):", e.message);
    }

    // 2. Prioritize
    const prioritized = prioritizeThreads() ?? [];

    // 3. Advance top 3 threads
    const advanced: string[] = [];
    const toAdvance = prioritized.slice(0, 3);
    for (const thread of toAdvance) {
      try {
        const result = await advanceThread(thread.id);
        if (result) advanced.push(result.title);
        // Rate limit: 5s between LLM calls
        if (toAdvance.indexOf(thread) < toAdvance.length - 1) {
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (e: any) {
        console.warn(`[ResearchAgenda] Failed to advance "${thread.title}":`, e.message);
      }
    }

    // 4. Prune stale threads
    let prunedCount = 0;
    try {
      const pruneResult = pruneStaleThreads();
      prunedCount = pruneResult?.count ?? 0;
    } catch (e: any) {
      console.warn("[ResearchAgenda] Prune failed (non-fatal):", e.message);
    }

    // 5. Count podcast candidates
    const candidates = getPodcastCandidates() ?? [];
    const agenda = loadAgenda();
    agenda.stats.totalPodcastCandidates = candidates.length;
    saveAgenda(agenda);

    console.log(`[ResearchAgenda] Cycle complete — new: ${newThreads.length}, advanced: ${advanced.length}, pruned: ${prunedCount}, candidates: ${candidates.length}`);

    return {
      newThreads: newThreads.length,
      advanced,
      pruned: prunedCount,
      podcastCandidates: candidates.length,
    };
  } catch (e: any) {
    console.error("[ResearchAgenda] Cycle crashed unexpectedly:", e.message, e.stack);
    return safeDefault;
  }
}
