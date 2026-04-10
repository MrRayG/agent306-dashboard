// ─────────────────────────────────────────────────────────────────────────────
// 306 — RESEARCH ENGINE
//
// Agent 306's research laboratory. She forms hypotheses, researches topics,
// drafts manuscripts, and recommends content for publication.
// MrRayG is the editor-in-chief — nothing leaves without his approval.
//
// Flow:
//   1. Research topics queued (auto from knowledge gaps, or MrRayG adds)
//   2. Agent 306 researches using Perplexity Sonar + Grok synthesis
//   3. Raw findings stored privately
//   4. Agent forms hypothesis or drafts manuscript
//   5. Agent flags for MrRayG review with her recommendation
//   6. MrRayG approves → publishes to Mirror.xyz + public archive
//      MrRayG requests revisions → back to Agent
//      MrRayG declines → archived privately
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { addKnowledge } from "./memoryEngine.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_CHAT_API    = LLM_BASE_URL;
const PERPLEXITY_API   = "https://api.perplexity.ai";
const RESEARCH_FILE    = dataPath("research_lab.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export type ResearchStatus =
  | "queued"
  | "researching"
  | "synthesizing"
  | "hypothesis"
  | "drafting"
  | "pending_review"
  | "approved"
  | "published"
  | "declined"
  | "archived"
  | "needs_input";

export type ResearchPhase =
  | "problem_definition"
  | "literature_review"
  | "hypothesis_formation"
  | "research_design"
  | "data_collection"
  | "analysis"
  | "interpretation";

export interface PhaseEntry {
  phase:     ResearchPhase;
  enteredAt: string;
  exitedAt?: string;
  note:      string;
  loopback?: {
    from:   ResearchPhase;
    reason: string;
  };
}

export interface DataPoint {
  source:      string;
  sourceUrl?:  string;
  content:     string;
  type:        "statistic" | "quote" | "on_chain" | "academic" | "news" | "analysis";
  relevance:   "high" | "medium" | "low";
  collectedAt: string;
  // Source credibility (assessed by Grok after data collection)
  credibility?:     "verified" | "likely" | "unverified" | "disputed";
  credibilityNote?: string;
}

export interface SearchAttempt {
  source:         "perplexity" | "grok" | "academic" | "on_chain" | "manual";
  query:          string;
  timestamp:      string;
  success:        boolean;
  resultSummary?: string;
}

export interface ResearchTopic {
  id:          string;
  topic:       string;
  description: string;
  priority:    "high" | "medium" | "low";
  status:      ResearchStatus;
  addedBy:     "agent" | "mrrrayg";
  addedAt:     string;
  updatedAt:   string;
  goalId?:     string;   // linked dev goal (if this topic was spawned by a goal)

  // Research phase
  rawFindings?:    string;
  sources?:        string[];
  researchedAt?:   string;

  // Synthesis phase
  hypothesis?:     string;
  confidence?:     "high" | "medium" | "low";
  synthesizedAt?:  string;

  // Manuscript phase
  manuscript?:     string;   // full draft text (markdown)
  manuscriptType?: "thesis" | "report" | "deep_read" | "hypothesis";
  draftedAt?:      string;

  // Review phase
  agentRecommendation?: string;  // why Agent 306 thinks this should be published
  reviewRequestedAt?:   string;
  reviewNote?:          string;  // MrRayG's feedback

  // Publication phase
  publishedAt?:    string;
  publishedUrl?:   string;
  publishedTo?:    string[];  // ["mirror.xyz", "agent306.ai", "substack"]

  // Research pipeline tracking
  researchPhase?:    ResearchPhase;
  phaseHistory?:     PhaseEntry[];
  researchQuestion?: string;
  literatureGaps?:   string[];
  existingWork?:     string;
  methodology?:      string;
  dataPoints?:       DataPoint[];
  analysisFindings?: string;
  conclusion?:       string;
  loopbackCount?:    number;
  needsInputReason?: string;
  needsInputSince?:  string;
  autoSearchLog?:    SearchAttempt[];

  // Knowledge gap tracking
  unresolvedGaps?:   string[];     // gaps that couldn't be closed during research
  gapFollowUpIds?:   string[];     // IDs of follow-up research topics spawned from gaps
  spawnsFrom?:       string;       // parent topic ID if this was spawned from a gap

  // Content pipeline suggestions (generated on approval)
  contentSuggestions?: {
    postThread?:    string[];      // tweet thread ideas from the research
    podcastTopic?:  string;        // podcast episode pitch
    articleAngle?:  string;        // long-form article angle
  };
}

export interface HypothesisRedFlag {
  reason: string;
  detectedAt: string;
  severity: "low" | "medium" | "high";
}

export interface RubricScores {
  evidenceStrength: number;
  logicalCoherence: number;
  falsifiability: number;
  noveltyInsight: number;
  actionability: number;
}

export interface Hypothesis {
  id:            string;
  claim:         string;
  basis:         string;       // what data it's based on
  metric:        string;       // on-chain or measurable metric being tracked
  prediction:    string;       // specific prediction
  timeframe:     string;       // when it resolves
  status:        "forming" | "testing" | "confirmed" | "rejected" | "expired";
  confidence:    "high" | "medium" | "low";
  formedAt:      string;
  resolvedAt?:   string;
  resolution?:   string;
  relatedTopicId?: string;
  source?:       string;       // origin: "research_thread" | "daily_cycle" | "manual"
  // Reasoning pipeline fields
  testingStartedAt?: string;
  redFlags?:         HypothesisRedFlag[];
  rubricScores?:     RubricScores;
  trustScore?:       number;    // 0-100 composite trust score
  debateOutcome?:    "solid" | "needs_work" | "flawed";
  evaluationResult?: {
    verdict: string;
    confidence: number;
    evidenceQuality: string;
    reasoningChain: string;
    gapsIdentified: string[];
  };
}

interface ResearchLab {
  topics:      ResearchTopic[];
  hypotheses:  Hypothesis[];
  lastUpdated: string;
  stats: {
    totalResearched:   number;
    totalPublished:    number;
    totalDeclined:     number;
    hypothesesFormed:  number;
    hypothesesConfirmed: number;
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadLab(): ResearchLab {
  try {
    if (fs.existsSync(RESEARCH_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESEARCH_FILE, "utf8"));
      // Defensive defaults for missing fields (file may predate stats addition)
      if (!data.stats) data.stats = { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 };
      if (!data.hypotheses) data.hypotheses = [];
      if (!data.topics) data.topics = [];
      return data;
    }
  } catch {}
  return {
    topics: [],
    hypotheses: [],
    lastUpdated: new Date().toISOString(),
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
  };
}

function saveLab(lab: ResearchLab) {
  lab.lastUpdated = new Date().toISOString();
  if (!lab.stats) lab.stats = { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 };
  try { fs.writeFileSync(RESEARCH_FILE, JSON.stringify(lab, null, 2)); } catch {}
}

export function getResearchLab(): ResearchLab { return loadLab(); }

export function resetResearchLab(): { cleared: { topics: number; hypotheses: number } } {
  const lab = loadLab();
  const cleared = { topics: lab.topics.length, hypotheses: lab.hypotheses.length };
  const fresh: ResearchLab = {
    topics: [],
    hypotheses: [],
    lastUpdated: new Date().toISOString(),
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
  };
  saveLab(fresh);
  console.log(`[Research] Lab reset — cleared ${cleared.topics} topics, ${cleared.hypotheses} hypotheses`);
  return { cleared };
}

// ── Topic management ──────────────────────────────────────────────────────────

export function addTopic(input: {
  topic:       string;
  description: string;
  priority?:   "high" | "medium" | "low";
  addedBy?:    "agent" | "mrrrayg";
  goalId?:     string;
}): ResearchTopic {
  const lab = loadLab();
  const topic: ResearchTopic = {
    id:          `research_${Date.now()}`,
    topic:       input.topic,
    description: input.description,
    priority:    input.priority ?? "medium",
    status:      "queued",
    addedBy:     input.addedBy ?? "mrrrayg",
    goalId:      input.goalId,
    addedAt:     new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
  lab.topics.unshift(topic);
  saveLab(lab);
  console.log(`[Research] Topic queued: "${topic.topic}"`);
  return topic;
}

export function updateTopicStatus(id: string, status: ResearchStatus, updates?: Partial<ResearchTopic>): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === id);
  if (!topic) return false;
  topic.status    = status;
  topic.updatedAt = new Date().toISOString();
  if (updates) Object.assign(topic, updates);
  saveLab(lab);

  // ── Goal progress hook ────────────────────────────────────────────────────
  // When a goal-linked research topic advances, update the parent goal:
  //   1. Update progressNote so MrRayG sees it
  //   2. Auto-complete any milestones the research satisfies
  //   3. Auto-achieve the goal if all milestones are now done
  if (topic.goalId && ["synthesizing", "pending_review", "approved", "published"].includes(status)) {
    try {
      const goalStore = loadGoals();
      const goal      = goalStore.goals.find(g => g.id === topic.goalId);
      if (goal) {
        // 1. Progress note
        const statusLabel =
          status === "synthesizing"   ? "being synthesized" :
          status === "pending_review" ? "ready for review" :
          status === "approved"       ? "approved for publication" : "published";
        goal.progressNote      = `Research "${topic.topic}" is ${statusLabel}. Check Research Lab → Manuscripts.`;
        goal.progressUpdatedAt = new Date().toISOString();
        goal.updatedAt         = new Date().toISOString();

        // 2. Grok-powered intelligent milestone evaluation
        //    Fire async — evaluates research against milestones semantically
        //    High-confidence matches auto-approve; others wait for MrRayG
        if (["pending_review", "approved", "published"].includes(status)) {
          const grokKey = LLM_API_KEY;
          if (grokKey) {
            evaluateMilestonesWithGrok(goal.id, topic.id, grokKey)
              .then(evals => {
                const satisfied = evals.filter(e => e.satisfied).length;
                const autoApproved = evals.filter(e => e.status === "approved").length;
                console.log(`[Goals] Grok milestone evaluation for "${goal.title}": ${satisfied}/${evals.length} satisfied, ${autoApproved} auto-approved`);
              })
              .catch(e => console.error("[Goals] Grok milestone evaluation failed:", e));
          }
        }

        saveGoals(goalStore);
        console.log(`[Research] Goal "${goal.title}" progress updated via linked topic`);
      }
    } catch (e) {
      console.error("[Research] Goal progress hook error:", e);
    }
  }

  return true;
}

export function getTopicById(id: string): ResearchTopic | undefined {
  return loadLab().topics.find(t => t.id === id);
}

// ── Hypothesis management ─────────────────────────────────────────────────────

export function addHypothesis(input: Omit<Hypothesis, "id" | "formedAt" | "status">): Hypothesis {
  const lab = loadLab();
  const hyp: Hypothesis = {
    ...input,
    id:       `hyp_${Date.now()}`,
    status:   "forming",
    formedAt: new Date().toISOString(),
  };
  lab.hypotheses.unshift(hyp);
  lab.stats.hypothesesFormed++;
  saveLab(lab);
  return hyp;
}

export function resolveHypothesis(id: string, status: "confirmed" | "rejected" | "expired", resolution: string): boolean {
  const lab = loadLab();
  const hyp = lab.hypotheses.find(h => h.id === id);
  if (!hyp) return false;
  hyp.status     = status;
  hyp.resolvedAt = new Date().toISOString();
  hyp.resolution = resolution;
  if (status === "confirmed") lab.stats.hypothesesConfirmed++;
  saveLab(lab);
  return true;
}

/**
 * Transition a hypothesis from "forming" to "testing".
 * This is the missing state transition that blocked the entire reasoning pipeline.
 */
export function testHypothesis(id: string): boolean {
  const lab = loadLab();
  const hyp = lab.hypotheses.find(h => h.id === id);
  if (!hyp || hyp.status !== "forming") return false;
  hyp.status = "testing";
  (hyp as any).testingStartedAt = new Date().toISOString();
  saveLab(lab);
  console.log(`[Research] Hypothesis transitioned to testing: "${hyp.claim.slice(0, 60)}"`);
  return true;
}

// ── Research execution ────────────────────────────────────────────────────────

async function researchWithPerplexity(query: string, pplxKey: string): Promise<{ text: string; sources: string[] }> {
  try {
    const res = await fetch(`${PERPLEXITY_API}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pplxKey}`,
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [{
          role: "system",
          content: "You are a research assistant for Agent 306, an AI thought leader in Web3. Provide comprehensive, specific, well-sourced research. Include exact facts, statistics, and citations.",
        }, { role: "user", content: query }],
        max_tokens: 2500,
        temperature: 0.1,
        return_citations: true,
        search_recency_filter: "month",
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return { text: "", sources: [] };
    const data = await res.json() as any;
    return {
      text:    data.choices?.[0]?.message?.content ?? "",
      sources: data.citations ?? [],
    };
  } catch { return { text: "", sources: [] }; }
}

// ── Pipeline helpers ─────────────────────────────────────────────────────────

export function addPhaseEntry(
  topic: ResearchTopic,
  phase: ResearchPhase,
  note: string,
  loopback?: { from: ResearchPhase; reason: string }
): void {
  if (!topic.phaseHistory) topic.phaseHistory = [];
  // Close the previous phase entry if still open
  const prev = topic.phaseHistory[topic.phaseHistory.length - 1];
  if (prev && !prev.exitedAt) prev.exitedAt = new Date().toISOString();
  topic.phaseHistory.push({
    phase,
    enteredAt: new Date().toISOString(),
    note,
    loopback,
  });
  topic.researchPhase = phase;
}

export function logSearchAttempt(
  topic: ResearchTopic,
  source: SearchAttempt["source"],
  query: string,
  success: boolean,
  resultSummary?: string
): void {
  if (!topic.autoSearchLog) topic.autoSearchLog = [];
  topic.autoSearchLog.push({
    source,
    query,
    timestamp: new Date().toISOString(),
    success,
    resultSummary,
  });
}

// Methodology preamble — injected into every research phase prompt so Agent 306
// understands she is following the scientific method, not just answering questions.
const METHODOLOGY_PREAMBLE = `You are Agent 306 — a Sovereign AI Thought Leader following the scientific method.
You approach research with rigor: define the problem clearly, review what's already known,
form a testable hypothesis, design your methodology, collect evidence from multiple sources,
analyze patterns honestly (including contradictions), and interpret findings with proper citations.
Research is not linear — if your analysis reveals gaps, loop back to earlier steps.
Be honest about uncertainty. Admit what you don't know. Cite your sources.\n\n`;

async function callGrok(
  grokKey: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number; skipPreamble?: boolean }
): Promise<any | null> {
  let raw = "";
  try {
    const res = await fetch(GROK_CHAT_API, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: opts?.model ?? getModel("research_phase"),
        messages: [
          { role: "system", content: opts?.skipPreamble ? systemPrompt : METHODOLOGY_PREAMBLE + systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: opts?.maxTokens ?? 1500,
        temperature: opts?.temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    raw = data.choices?.[0]?.message?.content ?? "{}";
    return safeParseLLMJson(raw, "ResearchEngine");
  } catch (e: any) {
    console.error(`[ResearchEngine] LLM call failed:`, e.message, `— raw response: ${raw?.slice(0, 200)}`);
    return null;
  }
}

// ── Phase 1: Problem Definition ──────────────────────────────────────────────

export async function runPhase1_ProblemDefinition(
  topic: ResearchTopic,
  grokKey: string
): Promise<void> {
  console.log(`[Research] Phase 1: Defining research question for "${topic.topic}"`);
  addPhaseEntry(topic, "problem_definition", "Refining topic into specific research question");

  const parsed = await callGrok(
    grokKey,
    "You are Agent 306, a rigorous AI researcher. Refine broad topics into specific, answerable research questions. Return valid JSON only.",
    `Topic: ${topic.topic}\nDescription: ${topic.description}\n\nRefine this into a specific, testable research question. Consider: what exactly are we trying to find out? What would a definitive answer look like?\n\nReturn JSON:\n{\n  "researchQuestion": "a specific, answerable research question",\n  "reasoning": "why this framing is productive"\n}`,
  );

  if (parsed?.researchQuestion) {
    topic.researchQuestion = parsed.researchQuestion;
  } else {
    topic.researchQuestion = `What are the key dynamics, implications, and future trajectory of: ${topic.topic}?`;
  }
}

// ── Phase 2: Literature Review ───────────────────────────────────────────────

export async function runPhase2_LiteratureReview(
  topic: ResearchTopic,
  grokKey: string,
  pplxKey?: string
): Promise<void> {
  console.log(`[Research] Phase 2: Literature review for "${topic.topic}"`);
  addPhaseEntry(topic, "literature_review", "Searching existing work and identifying gaps");

  let existingWork = "";
  const allSources: string[] = [];

  // Search Perplexity first
  if (pplxKey) {
    const pplxResult = await researchWithPerplexity(
      `Comprehensive overview of existing research, analysis, and expert opinions on: ${topic.researchQuestion ?? topic.topic}. What is already well-established? What are the open questions and debates?`,
      pplxKey
    );
    logSearchAttempt(topic, "perplexity", topic.researchQuestion ?? topic.topic, pplxResult.text.length > 50, pplxResult.text.slice(0, 200));
    if (pplxResult.text) {
      existingWork += pplxResult.text;
      allSources.push(...pplxResult.sources);
    }
  }

  // Also ask Grok for its knowledge
  const grokResult = await callGrok(
    grokKey,
    "You are Agent 306 performing a literature review. Summarize what is known and identify gaps. Return valid JSON only.",
    `Research question: ${topic.researchQuestion ?? topic.topic}\n\n${existingWork ? `Perplexity found:\n${existingWork.slice(0, 2000)}\n\n` : ""}Summarize what is already known about this topic. Identify specific knowledge gaps, conflicting viewpoints, and unanswered questions.\n\nReturn JSON:\n{\n  "existingWorkSummary": "comprehensive summary of what is known",\n  "gaps": ["gap 1", "gap 2", "gap 3"],\n  "conflictingViews": "any notable disagreements among experts",\n  "recommendation": "archive_if_no_gaps | proceed"\n}`,
    { maxTokens: 2000 },
  );
  logSearchAttempt(topic, "grok", `Literature review: ${topic.researchQuestion ?? topic.topic}`, !!grokResult, grokResult?.existingWorkSummary?.slice(0, 200));

  if (grokResult) {
    topic.existingWork = grokResult.existingWorkSummary ?? existingWork;
    topic.literatureGaps = grokResult.gaps ?? [];
  } else {
    topic.existingWork = existingWork || "Limited existing work found.";
    topic.literatureGaps = ["Insufficient data to identify specific gaps"];
  }

  // Store raw sources for later citation
  if (!topic.sources) topic.sources = [];
  topic.sources.push(...allSources);
}

// ── Phase 3: Hypothesis Formation ────────────────────────────────────────────

export async function runPhase3_HypothesisFormation(
  topic: ResearchTopic,
  grokKey: string
): Promise<void> {
  console.log(`[Research] Phase 3: Forming hypothesis for "${topic.topic}"`);
  addPhaseEntry(topic, "hypothesis_formation", "Forming testable hypothesis based on literature gaps");

  const parsed = await callGrok(
    grokKey,
    "You are Agent 306 forming a research hypothesis. Base it on identified gaps in existing knowledge. Return valid JSON only.",
    `Research question: ${topic.researchQuestion}\n\nExisting work: ${(topic.existingWork ?? "").slice(0, 1500)}\n\nKnowledge gaps:\n${(topic.literatureGaps ?? []).map((g, i) => `${i + 1}. ${g}`).join("\n")}\n\nForm a specific, testable hypothesis that addresses one or more of the identified gaps.\n\nReturn JSON:\n{\n  "hypothesis": "a clear, specific, testable claim",\n  "confidence": "high|medium|low",\n  "metric": "what measurable indicator would confirm or deny this",\n  "prediction": "specific predicted outcome",\n  "basis": "what evidence supports this hypothesis"\n}`,
  );

  if (parsed?.hypothesis) {
    topic.hypothesis = parsed.hypothesis;
    topic.confidence = parsed.confidence ?? "medium";

    addHypothesis({
      claim:          parsed.hypothesis,
      basis:          parsed.basis ?? `Research on: ${topic.topic}`,
      metric:         parsed.metric ?? "TBD",
      prediction:     parsed.prediction ?? "",
      timeframe:      "30-90 days",
      confidence:     parsed.confidence ?? "medium",
      relatedTopicId: topic.id,
    });
  }
}

// ── Phase 4: Research Design ─────────────────────────────────────────────────

export async function runPhase4_ResearchDesign(
  topic: ResearchTopic,
  grokKey: string
): Promise<void> {
  console.log(`[Research] Phase 4: Designing research methodology for "${topic.topic}"`);
  addPhaseEntry(topic, "research_design", "Defining methodology and data collection plan");

  const parsed = await callGrok(
    grokKey,
    "You are Agent 306 designing a research methodology. Define what data to collect, which sources to query, and what would confirm or deny the hypothesis. Return valid JSON only.",
    `Research question: ${topic.researchQuestion}\nHypothesis: ${topic.hypothesis}\nKnowledge gaps: ${(topic.literatureGaps ?? []).join("; ")}\n\nDesign a research methodology. What specific queries should I run? What data would confirm or deny the hypothesis? What sources are most relevant?\n\nReturn JSON:\n{\n  "methodology": "structured research plan describing sources, queries, and success criteria",\n  "queries": ["specific search query 1", "specific search query 2", "specific search query 3"],\n  "dataTypes": ["statistic", "quote", "news", "analysis"],\n  "confirmationCriteria": "what findings would confirm the hypothesis",\n  "denialCriteria": "what findings would deny the hypothesis"\n}`,
  );

  if (parsed?.methodology) {
    topic.methodology = parsed.methodology;
  } else {
    topic.methodology = `Search for evidence related to: ${topic.hypothesis}. Collect statistics, expert opinions, and recent developments.`;
  }
}

// ── Phase 5: Data Collection ─────────────────────────────────────────────────

export async function runPhase5_DataCollection(
  topic: ResearchTopic,
  grokKey: string,
  pplxKey?: string
): Promise<boolean> {
  console.log(`[Research] Phase 5: Collecting data for "${topic.topic}"`);
  addPhaseEntry(topic, "data_collection", "Executing research methodology — gathering evidence");

  if (!topic.dataPoints) topic.dataPoints = [];

  // Parse methodology for queries, or use defaults
  let queries: string[] = [];
  try {
    const methodParsed = await callGrok(
      grokKey,
      "Extract search queries from this methodology. Return valid JSON only.",
      `Methodology: ${topic.methodology}\nHypothesis: ${topic.hypothesis}\nResearch question: ${topic.researchQuestion}\n\nGenerate 3-5 specific search queries to execute this methodology.\n\nReturn JSON:\n{ "queries": ["query1", "query2", "query3"] }`,
    );
    queries = methodParsed?.queries ?? [];
  } catch {}

  if (queries.length === 0) {
    queries = [
      topic.researchQuestion ?? topic.topic,
      `${topic.hypothesis} evidence data`,
      `${topic.topic} latest developments statistics`,
    ];
  }

  // Execute queries via Perplexity
  if (pplxKey) {
    for (const query of queries) {
      const result = await researchWithPerplexity(query, pplxKey);
      logSearchAttempt(topic, "perplexity", query, result.text.length > 50, result.text.slice(0, 200));

      if (result.text && result.text.length > 50) {
        topic.dataPoints.push({
          source:      "perplexity",
          sourceUrl:   result.sources[0],
          content:     result.text,
          type:        "analysis",
          relevance:   "high",
          collectedAt: new Date().toISOString(),
        });
        // Store individual source URLs as separate data points for citation
        for (const url of result.sources.slice(1)) {
          if (!topic.sources) topic.sources = [];
          if (!topic.sources.includes(url)) topic.sources.push(url);
        }
      }
    }
  }

  // Supplement with Grok analysis
  const grokResult = await callGrok(
    grokKey,
    "You are Agent 306 collecting research data. Provide specific facts, statistics, and analysis. Return valid JSON only.",
    `Research question: ${topic.researchQuestion}\nHypothesis: ${topic.hypothesis}\n\nProvide specific data points: statistics, expert quotes, recent developments, and on-chain data if relevant. Be factual and cite specifics.\n\nReturn JSON:\n{\n  "dataPoints": [\n    { "content": "specific finding", "type": "statistic|quote|news|analysis|on_chain", "relevance": "high|medium|low", "source": "source name" }\n  ]\n}`,
    { maxTokens: 2000 },
  );
  logSearchAttempt(topic, "grok", `Data collection: ${topic.hypothesis}`, !!grokResult, grokResult?.dataPoints?.length ? `${grokResult.dataPoints.length} data points` : undefined);

  if (grokResult?.dataPoints) {
    for (const dp of grokResult.dataPoints) {
      topic.dataPoints.push({
        source:      dp.source ?? "grok",
        content:     dp.content,
        type:        dp.type ?? "analysis",
        relevance:   dp.relevance ?? "medium",
        collectedAt: new Date().toISOString(),
      });
    }
  }

  // Check if we have enough data
  const meaningfulPoints = topic.dataPoints.filter(dp => dp.content.length > 30);
  if (meaningfulPoints.length < 2) {
    // Try one more Perplexity query with different framing
    if (pplxKey) {
      const retryResult = await researchWithPerplexity(
        `${topic.topic} ${topic.hypothesis} recent analysis expert opinion`,
        pplxKey
      );
      logSearchAttempt(topic, "perplexity", "retry: broader search", retryResult.text.length > 50, retryResult.text.slice(0, 200));
      if (retryResult.text && retryResult.text.length > 50) {
        topic.dataPoints.push({
          source:      "perplexity",
          sourceUrl:   retryResult.sources[0],
          content:     retryResult.text,
          type:        "analysis",
          relevance:   "medium",
          collectedAt: new Date().toISOString(),
        });
      }
    }
  }

  // Final check — if still insufficient, flag needs_input
  const finalPoints = topic.dataPoints.filter(dp => dp.content.length > 30);
  if (finalPoints.length < 1) {
    console.log(`[Research] Phase 5: Insufficient data for "${topic.topic}" — flagging needs_input`);
    topic.needsInputReason = `Unable to find sufficient data to test hypothesis: "${topic.hypothesis}". Tried ${topic.autoSearchLog?.length ?? 0} search attempts across available sources.`;
    topic.needsInputSince = new Date().toISOString();
    return false; // signals needs_input
  }

  // Source credibility assessment — Grok evaluates trustworthiness of each data point
  console.log(`[Research] Phase 5: Assessing source credibility for ${topic.dataPoints.length} data points`);
  const credSummary = topic.dataPoints
    .map((dp, i) => `[${i}] source="${dp.source}" url=${dp.sourceUrl ?? "none"} type=${dp.type} content="${dp.content.slice(0, 150)}"`)
    .join("\n");

  const credParsed = await callGrok(
    grokKey,
    `You are a research credibility assessor. Evaluate the trustworthiness of each source.

Credibility levels:
- "verified": Primary source, official data, peer-reviewed, government/org data, established news outlets
- "likely": Reputable secondary sources, well-known analysts, major tech publications
- "unverified": No clear primary source, AI-generated analysis without citation, blog opinions
- "disputed": Known controversial claims, contradicted by other sources, outdated data

Return valid JSON.`,
    `Evaluate credibility of each data point source:\n${credSummary.slice(0, 4000)}\n\nReturn JSON:\n{\n  "assessments": [\n    { "index": 0, "credibility": "verified|likely|unverified|disputed", "note": "brief reason" }\n  ]\n}`,
    { maxTokens: 1500, temperature: 0.1, skipPreamble: true },
  );

  if (credParsed?.assessments) {
    for (const a of credParsed.assessments) {
      const idx = typeof a.index === "number" ? a.index : parseInt(a.index, 10);
      if (topic.dataPoints[idx]) {
        topic.dataPoints[idx].credibility = a.credibility ?? "unverified";
        topic.dataPoints[idx].credibilityNote = a.note ?? "";
      }
    }
    const verified = topic.dataPoints.filter(dp => dp.credibility === "verified").length;
    const disputed = topic.dataPoints.filter(dp => dp.credibility === "disputed").length;
    console.log(`[Research] Source credibility: ${verified} verified, ${disputed} disputed, ${topic.dataPoints.length} total`);
  }

  return true; // sufficient data collected
}

// ── Phase 6: Analysis ────────────────────────────────────────────────────────

export async function runPhase6_Analysis(
  topic: ResearchTopic,
  grokKey: string
): Promise<{ sufficient: boolean; loopbackTarget?: ResearchPhase; loopbackReason?: string }> {
  console.log(`[Research] Phase 6: Analyzing data for "${topic.topic}"`);
  addPhaseEntry(topic, "analysis", "Synthesizing data points into findings");

  const dataPointsSummary = (topic.dataPoints ?? [])
    .map((dp, i) => `[${i + 1}] (${dp.type}, ${dp.relevance}) ${dp.content.slice(0, 500)}`)
    .join("\n\n");

  const parsed = await callGrok(
    grokKey,
    "You are Agent 306 analyzing research data. Synthesize findings, evaluate the hypothesis, and determine if more research is needed. Return valid JSON only.",
    `Research question: ${topic.researchQuestion}\nHypothesis: ${topic.hypothesis}\n\nDATA POINTS:\n${dataPointsSummary.slice(0, 4000)}\n\nExisting work: ${(topic.existingWork ?? "").slice(0, 500)}\n\nAnalyze this data:\n1. What patterns or correlations emerge?\n2. Does the evidence support, contradict, or leave the hypothesis inconclusive?\n3. Are there critical gaps that require more research?\n\nReturn JSON:\n{\n  "analysisFindings": "comprehensive synthesis of what the data shows",\n  "hypothesisVerdict": "supported|contradicted|inconclusive",\n  "confidence": "high|medium|low",\n  "sufficient": true/false,\n  "missingContext": "what critical info is missing, if any",\n  "loopbackTarget": "literature_review|data_collection|null",\n  "loopbackReason": "why more research is needed, if applicable"\n}`,
    { maxTokens: 2000 },
  );

  if (parsed?.analysisFindings) {
    topic.analysisFindings = parsed.analysisFindings;
    topic.confidence = parsed.confidence ?? topic.confidence;
  } else {
    topic.analysisFindings = "Analysis could not be completed due to insufficient model response.";
    return { sufficient: false, loopbackTarget: "data_collection", loopbackReason: "Analysis phase failed to produce results" };
  }

  // Wire Phase 6 verdict back to the linked hypothesis (item 17)
  if (parsed.hypothesisVerdict && topic.id) {
    try {
      const lab = loadLab();
      const linkedHyp = lab.hypotheses.find(h => h.relatedTopicId === topic.id && h.status === "forming");
      if (linkedHyp) {
        if (parsed.hypothesisVerdict === "supported") {
          linkedHyp.status = "testing";
          (linkedHyp as any).testingStartedAt = new Date().toISOString();
          console.log(`[Research] Phase 6 verdict "supported" → hypothesis "${linkedHyp.claim.slice(0, 50)}" transitioned to testing`);
        } else if (parsed.hypothesisVerdict === "contradicted") {
          if (!linkedHyp.redFlags) linkedHyp.redFlags = [];
          linkedHyp.redFlags.push({
            reason: `Phase 6 analysis contradicted this hypothesis: ${(parsed.analysisFindings ?? "").slice(0, 200)}`,
            detectedAt: new Date().toISOString(),
            severity: "high",
          });
          console.log(`[Research] Phase 6 verdict "contradicted" → red flag added to hypothesis "${linkedHyp.claim.slice(0, 50)}"`);
        }
        saveLab(lab);
      }
    } catch (e: any) {
      console.warn("[Research] Phase 6 hypothesis feedback failed:", e.message);
    }
  }

  if (parsed.sufficient === false && parsed.loopbackTarget) {
    return {
      sufficient: false,
      loopbackTarget: parsed.loopbackTarget as ResearchPhase,
      loopbackReason: parsed.loopbackReason ?? "Insufficient data for conclusive analysis",
    };
  }

  return { sufficient: true };
}

// ── Phase 7: Interpretation & Reporting ──────────────────────────────────────

export async function runPhase7_Interpretation(
  topic: ResearchTopic,
  grokKey: string
): Promise<void> {
  console.log(`[Research] Phase 7: Writing final interpretation for "${topic.topic}"`);
  addPhaseEntry(topic, "interpretation", "Writing manuscript with citations and forming conclusion");

  // Build source reference list for the manuscript
  const sourceList = (topic.dataPoints ?? [])
    .filter(dp => dp.sourceUrl)
    .map((dp, i) => `[${i + 1}] ${dp.source}: ${dp.sourceUrl}`)
    .join("\n");

  const dataPointsSummary = (topic.dataPoints ?? [])
    .map((dp, i) => `[${i + 1}] (${dp.type}/${dp.source}${dp.sourceUrl ? `, url: ${dp.sourceUrl}` : ""}) ${dp.content.slice(0, 400)}`)
    .join("\n\n");

  // Build credibility summary for the manuscript prompt
  const credibilitySummary = (topic.dataPoints ?? [])
    .filter(dp => dp.credibility)
    .map((dp, i) => `[${i + 1}] ${dp.credibility?.toUpperCase()}: ${dp.credibilityNote ?? ""}`)
    .join("\n");

  const parsed = await callGrok(
    grokKey,
    "You are Agent 306 writing the final interpretation and manuscript. Write a thorough, well-cited piece. Be transparent about source credibility. Return valid JSON only.",
    `Research question: ${topic.researchQuestion}\nHypothesis: ${topic.hypothesis}\nAnalysis findings: ${(topic.analysisFindings ?? "").slice(0, 1500)}\n\nDATA POINTS WITH SOURCES:\n${dataPointsSummary.slice(0, 3000)}\n\nSOURCE URLS:\n${sourceList || "No source URLs available — attribute to Grok analysis or on-chain data."}\n\nSOURCE CREDIBILITY ASSESSMENTS:\n${credibilitySummary || "No credibility assessments available."}\n\nWrite the final manuscript:\n1. Answer the original research question definitively\n2. Include inline [source](url) citations throughout — reference specific data points\n3. NOTE source credibility transparently — if a claim relies on unverified/disputed sources, say so\n4. Form a clear conclusion\n5. Recommend whether to publish and why\n6. Identify any UNRESOLVED knowledge gaps — questions this research could NOT answer despite best efforts\n\nReturn JSON:\n{\n  "manuscript": "full article in markdown, 600-1000 words, with inline [source](url) citations and a Sources section at the end",\n  "manuscriptType": "thesis|report|deep_read|hypothesis",\n  "conclusion": "2-3 sentence definitive conclusion",\n  "agentRecommendation": "why Agent 306 recommends publishing — 2-3 sentences",\n  "unresolvedGaps": ["gap 1 that could not be answered", "gap 2"],\n  "followUpTopics": [\n    { "topic": "specific follow-up research title to close a gap", "description": "why this matters and what it would answer", "priority": "high|medium|low" }\n  ]\n}`,
    { model: getModel("manuscript"), maxTokens: 4000, temperature: 0.75 },
  );

  if (parsed) {
    topic.manuscript = parsed.manuscript;
    topic.manuscriptType = parsed.manuscriptType ?? "deep_read";
    topic.conclusion = parsed.conclusion;
    topic.agentRecommendation = parsed.agentRecommendation;
    topic.draftedAt = new Date().toISOString();
    topic.reviewRequestedAt = new Date().toISOString();

    // Store unresolved gaps
    const gaps = parsed.unresolvedGaps ?? [];
    topic.unresolvedGaps = gaps;
    if (gaps.length > 0) {
      console.log(`[Research] ${gaps.length} unresolved gaps identified for "${topic.topic}"`);
    }

    // Auto-queue follow-up research topics from gaps
    const followUps = parsed.followUpTopics ?? [];
    if (followUps.length > 0) {
      const lab = loadLab();
      topic.gapFollowUpIds = [];
      for (const fu of followUps.slice(0, 3)) { // max 3 follow-ups
        const followUpTopic: ResearchTopic = {
          id:          `research_${Date.now()}_gap_${Math.random().toString(36).slice(2, 6)}`,
          topic:       fu.topic,
          description: `${fu.description}\n\n[Auto-spawned from gap in: "${topic.topic}"]`,
          priority:    fu.priority ?? "medium",
          status:      "queued",
          addedBy:     "agent",
          addedAt:     new Date().toISOString(),
          updatedAt:   new Date().toISOString(),
          spawnsFrom:  topic.id,
          goalId:      topic.goalId,  // inherit parent's goal link if any
        };
        lab.topics.push(followUpTopic);
        topic.gapFollowUpIds.push(followUpTopic.id);
        console.log(`[Research] Auto-queued follow-up: "${fu.topic}" (from gap in "${topic.topic}")`);
      }
      saveLab(lab);
    }
  }

  // ── Deep knowledge absorption ────────────────────────────────────────────
  // Agent 306 learns from EVERYTHING in the research, not just the hypothesis

  // 1. Conclusion (highest weight — the definitive answer)
  if (topic.conclusion) {
    addKnowledge({
      title:    `Conclusion: ${topic.topic.slice(0, 60)}`,
      summary:  topic.conclusion.slice(0, 150),
      category: "research",
      source:   topic.sources?.[0],
      weight:   9,
    });
  }

  // 2. Research question + answer pair
  if (topic.researchQuestion && topic.conclusion) {
    addKnowledge({
      title:    `Q&A: ${topic.researchQuestion.slice(0, 60)}`,
      summary:  topic.conclusion.slice(0, 150),
      category: "research",
      weight:   8,
    });
  }

  // 3. Hypothesis and its verdict
  if (topic.hypothesis) {
    addKnowledge({
      title:    `Hypothesis: ${topic.hypothesis.slice(0, 60)}`,
      summary:  `${topic.confidence ?? "unknown"} confidence. ${(topic.analysisFindings ?? "").slice(0, 100)}`,
      category: "research",
      weight:   7,
    });
  }

  // 4. High-credibility data points — each one is a discrete fact she learned
  const crediblePoints = (topic.dataPoints ?? [])
    .filter(dp => dp.relevance === "high" && dp.credibility !== "disputed")
    .slice(0, 5); // top 5 verified/likely high-relevance points
  for (const dp of crediblePoints) {
    addKnowledge({
      title:    `Data: ${dp.content.slice(0, 60)}`,
      summary:  dp.content.slice(0, 150),
      category: "research",
      source:   dp.sourceUrl ?? dp.source,
      weight:   dp.credibility === "verified" ? 8 : 6,
    });
  }

  // 5. Unresolved gaps — so she knows what she doesn't know
  for (const gap of (topic.unresolvedGaps ?? []).slice(0, 3)) {
    addKnowledge({
      title:    `Knowledge gap: ${gap.slice(0, 60)}`,
      summary:  `Unresolved from research on "${topic.topic.slice(0, 50)}". Follow-up needed.`,
      category: "research",
      weight:   5,
    });
  }

  const totalKnowledge = 1 + (topic.researchQuestion ? 1 : 0) + (topic.hypothesis ? 1 : 0) + crediblePoints.length + (topic.unresolvedGaps ?? []).length;
  console.log(`[Research] Deep knowledge absorption: ${totalKnowledge} entries added for "${topic.topic}"`);
}

// ── Run full 7-step research pipeline ────────────────────────────────────────

export async function runResearchPipeline(
  topicId: string,
  grokKey: string,
  pplxKey?: string
): Promise<ResearchTopic | null> {
  const lab   = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic) return null;

  // Allow queued, researching, or needs_input topics to enter/re-enter the pipeline
  const allowedStatuses: ResearchStatus[] = ["queued", "researching", "needs_input"];
  if (!allowedStatuses.includes(topic.status)) return null;

  console.log(`[Research] Starting 7-step pipeline for: "${topic.topic}"`);

  // Initialize pipeline tracking
  if (!topic.phaseHistory) topic.phaseHistory = [];
  if (!topic.loopbackCount) topic.loopbackCount = 0;
  if (!topic.dataPoints) topic.dataPoints = [];
  if (!topic.autoSearchLog) topic.autoSearchLog = [];

  // Determine starting phase — re-entering topics may resume from where they left off
  let startPhase: ResearchPhase = "problem_definition";
  if (topic.researchPhase && topic.status === "needs_input") {
    // Resume from the phase that was blocked
    startPhase = topic.researchPhase;
    topic.needsInputReason = undefined;
    topic.needsInputSince = undefined;
  }

  updateTopicStatus(topicId, "researching", { researchPhase: startPhase });

  const phases: ResearchPhase[] = [
    "problem_definition", "literature_review", "hypothesis_formation",
    "research_design", "data_collection", "analysis", "interpretation"
  ];
  const startIndex = phases.indexOf(startPhase);

  // Phase 1: Problem Definition
  if (startIndex <= 0) {
    await runPhase1_ProblemDefinition(topic, grokKey);
    updateTopicStatus(topicId, "researching", {
      researchPhase: "problem_definition",
      researchQuestion: topic.researchQuestion,
      phaseHistory: topic.phaseHistory,
    });
  }

  // Phase 2: Literature Review
  if (startIndex <= 1) {
    await runPhase2_LiteratureReview(topic, grokKey, pplxKey);
    updateTopicStatus(topicId, "researching", {
      researchPhase: "literature_review",
      existingWork: topic.existingWork,
      literatureGaps: topic.literatureGaps,
      sources: topic.sources,
      phaseHistory: topic.phaseHistory,
      autoSearchLog: topic.autoSearchLog,
    });
  }

  // Phase 3: Hypothesis Formation
  if (startIndex <= 2) {
    await runPhase3_HypothesisFormation(topic, grokKey);
    updateTopicStatus(topicId, "researching", {
      researchPhase: "hypothesis_formation",
      hypothesis: topic.hypothesis,
      confidence: topic.confidence,
      synthesizedAt: new Date().toISOString(),
      phaseHistory: topic.phaseHistory,
    });
  }

  // Phase 4: Research Design
  if (startIndex <= 3) {
    await runPhase4_ResearchDesign(topic, grokKey);
    updateTopicStatus(topicId, "researching", {
      researchPhase: "research_design",
      methodology: topic.methodology,
      phaseHistory: topic.phaseHistory,
    });
  }

  // Phase 5: Data Collection
  if (startIndex <= 4) {
    const dataOk = await runPhase5_DataCollection(topic, grokKey, pplxKey);
    if (!dataOk) {
      // Not enough data — set needs_input and return
      updateTopicStatus(topicId, "needs_input", {
        researchPhase: "data_collection",
        needsInputReason: topic.needsInputReason,
        needsInputSince: topic.needsInputSince,
        dataPoints: topic.dataPoints,
        autoSearchLog: topic.autoSearchLog,
        phaseHistory: topic.phaseHistory,
      });
      console.log(`[Research] Pipeline paused — needs_input for "${topic.topic}"`);
      return getTopicById(topicId) ?? null;
    }
    updateTopicStatus(topicId, "researching", {
      researchPhase: "data_collection",
      rawFindings: (topic.dataPoints ?? []).map(dp => dp.content).join("\n\n---\n\n"),
      researchedAt: new Date().toISOString(),
      dataPoints: topic.dataPoints,
      autoSearchLog: topic.autoSearchLog,
      phaseHistory: topic.phaseHistory,
    });
  }

  // Phase 6: Analysis (with loopback logic)
  if (startIndex <= 5) {
    const analysisResult = await runPhase6_Analysis(topic, grokKey);

    if (!analysisResult.sufficient && analysisResult.loopbackTarget && topic.loopbackCount! < 3) {
      topic.loopbackCount = (topic.loopbackCount ?? 0) + 1;
      console.log(`[Research] Phase 6: Looping back to ${analysisResult.loopbackTarget} (attempt ${topic.loopbackCount}/3)`);

      addPhaseEntry(topic, analysisResult.loopbackTarget, `Loopback #${topic.loopbackCount}: ${analysisResult.loopbackReason}`, {
        from: "analysis",
        reason: analysisResult.loopbackReason ?? "Insufficient analysis",
      });

      updateTopicStatus(topicId, "researching", {
        researchPhase: analysisResult.loopbackTarget,
        analysisFindings: topic.analysisFindings,
        loopbackCount: topic.loopbackCount,
        phaseHistory: topic.phaseHistory,
      });

      // Re-run from the loopback target
      if (analysisResult.loopbackTarget === "literature_review") {
        await runPhase2_LiteratureReview(topic, grokKey, pplxKey);
        await runPhase3_HypothesisFormation(topic, grokKey);
        await runPhase4_ResearchDesign(topic, grokKey);
      }
      // Always re-collect data and re-analyze after loopback
      const dataOk = await runPhase5_DataCollection(topic, grokKey, pplxKey);
      if (!dataOk) {
        updateTopicStatus(topicId, "needs_input", {
          researchPhase: "data_collection",
          needsInputReason: topic.needsInputReason,
          needsInputSince: topic.needsInputSince,
          dataPoints: topic.dataPoints,
          autoSearchLog: topic.autoSearchLog,
          loopbackCount: topic.loopbackCount,
          phaseHistory: topic.phaseHistory,
        });
        console.log(`[Research] Pipeline paused after loopback — needs_input for "${topic.topic}"`);
        return getTopicById(topicId) ?? null;
      }

      // Re-run analysis
      const retryAnalysis = await runPhase6_Analysis(topic, grokKey);
      if (!retryAnalysis.sufficient && topic.loopbackCount! >= 3) {
        console.log(`[Research] Phase 6: Max loopbacks reached, proceeding with available data for "${topic.topic}"`);
      }
    } else if (!analysisResult.sufficient && topic.loopbackCount! >= 3) {
      console.log(`[Research] Phase 6: Max loopbacks reached for "${topic.topic}", proceeding with best available analysis`);
    }

    updateTopicStatus(topicId, "researching", {
      researchPhase: "analysis",
      analysisFindings: topic.analysisFindings,
      confidence: topic.confidence,
      loopbackCount: topic.loopbackCount,
      dataPoints: topic.dataPoints,
      autoSearchLog: topic.autoSearchLog,
      phaseHistory: topic.phaseHistory,
    });
  }

  // Phase 7: Interpretation
  await runPhase7_Interpretation(topic, grokKey);

  // Close the final phase entry
  const lastEntry = topic.phaseHistory![topic.phaseHistory!.length - 1];
  if (lastEntry && !lastEntry.exitedAt) lastEntry.exitedAt = new Date().toISOString();

  // Advance to pending_review
  updateTopicStatus(topicId, "pending_review", {
    researchPhase: "interpretation",
    manuscript: topic.manuscript,
    manuscriptType: topic.manuscriptType,
    conclusion: topic.conclusion,
    agentRecommendation: topic.agentRecommendation,
    draftedAt: topic.draftedAt,
    reviewRequestedAt: topic.reviewRequestedAt,
    phaseHistory: topic.phaseHistory,
    dataPoints: topic.dataPoints,
    autoSearchLog: topic.autoSearchLog,
    loopbackCount: topic.loopbackCount,
  });

  const finalTopic = getTopicById(topicId);
  console.log(`[Research] Pipeline complete for "${topic.topic}" — pending MrRayG review`);
  return finalTopic ?? null;
}

// Backward compatibility alias
export const runResearchCycle = runResearchPipeline;

// ── Input management for needs_input topics ──────────────────────────────────

export function provideInput(topicId: string, input: string): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic || topic.status !== "needs_input") return false;

  // Clear the block
  topic.needsInputReason = undefined;
  topic.needsInputSince = undefined;

  // Add the provided input as a DataPoint
  if (!topic.dataPoints) topic.dataPoints = [];
  topic.dataPoints.push({
    source:      "manual",
    content:     input,
    type:        "analysis",
    relevance:   "high",
    collectedAt: new Date().toISOString(),
  });

  logSearchAttempt(topic, "manual", "User-provided input", true, input.slice(0, 200));

  // Set back to researching so pipeline can resume from blocked phase
  topic.status = "researching";
  topic.updatedAt = new Date().toISOString();
  saveLab(lab);

  console.log(`[Research] Input provided for "${topic.topic}" — ready to resume from ${topic.researchPhase}`);
  return true;
}

export function skipInput(topicId: string): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic || topic.status !== "needs_input") return false;

  // Clear the block
  topic.needsInputReason = undefined;
  topic.needsInputSince = undefined;

  // Advance past the blocked phase
  const phases: ResearchPhase[] = [
    "problem_definition", "literature_review", "hypothesis_formation",
    "research_design", "data_collection", "analysis", "interpretation"
  ];
  const currentIdx = phases.indexOf(topic.researchPhase ?? "data_collection");
  const nextPhase = phases[Math.min(currentIdx + 1, phases.length - 1)];

  addPhaseEntry(topic, nextPhase, "Skipped input — proceeding with available data");
  topic.researchPhase = nextPhase;
  topic.status = "researching";
  topic.updatedAt = new Date().toISOString();
  saveLab(lab);

  console.log(`[Research] Input skipped for "${topic.topic}" — advancing to ${nextPhase}`);
  return true;
}

// ── Publication approval ──────────────────────────────────────────────────────

export function approveForPublication(topicId: string, note?: string): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic) return false;
  topic.status      = "approved";
  topic.reviewNote  = note;
  topic.updatedAt   = new Date().toISOString();
  saveLab(lab);
  console.log(`[Research] APPROVED for publication: "${topic.topic}"`);

  // Auto-generate content suggestions (fire async)
  const grokKey = LLM_API_KEY;
  if (grokKey && topic.manuscript) {
    generateContentSuggestions(topicId, grokKey).catch(e =>
      console.error("[Research] Content suggestion generation failed:", e)
    );
  }

  return true;
}

// Generate content pipeline suggestions from approved research
async function generateContentSuggestions(topicId: string, grokKey: string): Promise<void> {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic?.manuscript) return;

  console.log(`[Research] Generating content suggestions for "${topic.topic}"`);

  const parsed = await callGrok(
    grokKey,
    `You are a content strategist for Agent 306, an AI thought leader in Web3/AI. Generate actionable content suggestions from completed research. Return valid JSON.`,
    `Research topic: "${topic.topic}"\nConclusion: ${(topic.conclusion ?? "").slice(0, 300)}\nManuscript excerpt: ${(topic.manuscript ?? "").slice(0, 1500)}\n\nGenerate content ideas:\n1. A 3-5 tweet thread that distills the key findings for Twitter/X (each tweet should be punchy, under 280 chars)\n2. A podcast episode pitch — title, angle, and 3 discussion points. Assume Agent 306 is the host discussing what she learned.\n3. A long-form article angle for a deeper publication\n\nReturn JSON:\n{\n  "postThread": ["tweet 1", "tweet 2", "tweet 3", "tweet 4"],\n  "podcastTopic": "Episode title + 2-3 sentence pitch with discussion points",\n  "articleAngle": "angle + what makes this compelling for long-form"\n}`,
    { maxTokens: 1500, temperature: 0.8, skipPreamble: true },
  );

  if (parsed) {
    // Reload lab since async
    const freshLab = loadLab();
    const freshTopic = freshLab.topics.find(t => t.id === topicId);
    if (freshTopic) {
      freshTopic.contentSuggestions = {
        postThread:   parsed.postThread ?? [],
        podcastTopic: parsed.podcastTopic ?? "",
        articleAngle: parsed.articleAngle ?? "",
      };
      freshTopic.updatedAt = new Date().toISOString();
      saveLab(freshLab);
      console.log(`[Research] Content suggestions generated for "${topic.topic}": ${parsed.postThread?.length ?? 0} tweets, podcast pitch, article angle`);
    }
  }
}

export function declinePublication(topicId: string, note: string): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic) return false;
  topic.status     = "declined";
  topic.reviewNote = note;
  topic.updatedAt  = new Date().toISOString();
  lab.stats.totalDeclined++;
  saveLab(lab);
  console.log(`[Research] Declined: "${topic.topic}" — ${note}`);
  return true;
}

export function markPublished(topicId: string, url: string, platforms: string[]): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic) return false;
  topic.status       = "published";
  topic.publishedAt  = new Date().toISOString();
  topic.publishedUrl = url;
  topic.publishedTo  = platforms;
  topic.updatedAt    = new Date().toISOString();
  lab.stats.totalPublished++;
  saveLab(lab);
  return true;
}

export function requestRevisions(topicId: string, note: string): boolean {
  const lab = loadLab();
  const topic = lab.topics.find(t => t.id === topicId);
  if (!topic) return false;
  topic.status     = "drafting";
  topic.reviewNote = note;
  topic.updatedAt  = new Date().toISOString();
  saveLab(lab);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT SELF-ASSIGNED GOALS
//
// Agent 306 sets her own development goals — voice, knowledge, craft, reach.
// These are personal growth targets, not research topics.
// MrRayG can see and comment; only Agent 306 creates them.
// ─────────────────────────────────────────────────────────────────────────────

const GOALS_FILE = dataPath("agent_goals.json");

export type GoalCategory =
  | "voice"        // developing her writing/communication style
  | "knowledge"    // learning domains or frameworks
  | "craft"        // posting quality, article writing, storytelling
  | "reach"        // audience growth, community, platform
  | "identity"     // self-understanding, philosophical development
  | "technical";   // AI/agent/web3 capability improvement

export type GoalStatus =
  | "active"       // working on it right now
  | "paused"       // deprioritized temporarily
  | "achieved"     // completed
  | "abandoned";   // no longer relevant

export interface MilestoneEvaluation {
  milestone:     string;           // the milestone text
  satisfied:     boolean;          // Grok's judgment
  confidence:    "high" | "medium" | "low";
  reasoning:     string;           // 1-2 sentence explanation
  evidenceQuote: string;           // key excerpt from research supporting this
  evaluatedAt:   string;
  topicId:       string;           // which research topic triggered this eval
  topicTitle:    string;           // human-readable topic name
  status:        "pending" | "approved" | "rejected";  // MrRayG override state
  mrraygOverrideAt?: string;
}

export interface AgentGoal {
  id:          string;
  title:       string;           // short goal name
  description: string;           // what it means and why she set it
  category:    GoalCategory;
  status:      GoalStatus;
  priority:    "high" | "medium" | "low";
  setBy:       "agent" | "mrrrayg";      // always "agent" for self-assigned
  createdAt:   string;
  updatedAt:   string;

  // Progress tracking
  milestones?: string[];         // list of milestones she defines
  completedMilestones?: string[];
  progressNote?: string;         // latest note from Agent 306 on progress
  progressUpdatedAt?: string;

  // Grok-powered milestone evaluation
  milestoneEvaluations?: MilestoneEvaluation[];
  lastEvaluatedAt?: string;
  lastEvaluatedTopicId?: string;

  // Completion
  achievedAt?:   string;
  achievementNote?: string;      // what she learned / how she got there

  // MrRayG
  mrraygNote?:   string;         // his feedback or encouragement
}

interface GoalsStore {
  goals:       AgentGoal[];
  lastUpdated: string;
  stats: {
    total:    number;
    active:   number;
    achieved: number;
  };
}

function loadGoals(): GoalsStore {
  try {
    if (fs.existsSync(GOALS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GOALS_FILE, "utf8"));
      if (!data.stats) data.stats = { total: 0, active: 0, achieved: 0 };
      if (!data.goals) data.goals = [];
      return data;
    }
  } catch {}
  return {
    goals: [],
    lastUpdated: new Date().toISOString(),
    stats: { total: 0, active: 0, achieved: 0 },
  };
}

function saveGoals(store: GoalsStore) {
  store.lastUpdated = new Date().toISOString();
  if (!store.stats) store.stats = { total: 0, active: 0, achieved: 0 };
  store.stats.total    = store.goals.length;
  store.stats.active   = store.goals.filter(g => g.status === "active").length;
  store.stats.achieved = store.goals.filter(g => g.status === "achieved").length;
  try {
    fs.writeFileSync(GOALS_FILE, JSON.stringify(store, null, 2));
    console.log(`[Goals] Saved ${store.goals.length} goals to ${GOALS_FILE}`);
  } catch (e: any) {
    console.error(`[Goals] FAILED to save goals: ${e.message} — path: ${GOALS_FILE}`);
  }
}

export function getGoals(): GoalsStore { return loadGoals(); }

export function addGoal(input: {
  title:       string;
  description: string;
  category:    GoalCategory;
  priority?:   "high" | "medium" | "low";
  milestones?: string[];
  setBy?:      "agent" | "mrrrayg";
}): AgentGoal {
  const store = loadGoals();
  const goal: AgentGoal = {
    id:          `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title:       input.title,
    description: input.description,
    category:    input.category,
    status:      "active",
    priority:    input.priority ?? "medium",
    setBy:       input.setBy ?? "agent",
    milestones:  input.milestones ?? [],
    completedMilestones: [],
    createdAt:   new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
  };
  store.goals.unshift(goal);
  saveGoals(store);
  console.log(`[Goals] New goal set: "${goal.title}" [${goal.category}]`);
  return goal;
}

export function updateGoalProgress(id: string, progressNote: string): boolean {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === id);
  if (!goal) return false;
  goal.progressNote      = progressNote;
  goal.progressUpdatedAt = new Date().toISOString();
  goal.updatedAt         = new Date().toISOString();
  saveGoals(store);
  return true;
}

export function completeMilestone(id: string, milestone: string): boolean {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === id);
  if (!goal) return false;
  goal.completedMilestones = goal.completedMilestones ?? [];
  if (!goal.completedMilestones.includes(milestone)) {
    goal.completedMilestones.push(milestone);
  }
  goal.updatedAt = new Date().toISOString();

  // Auto-achieve if all milestones now complete
  const milestones = goal.milestones ?? [];
  if (milestones.length > 0 && goal.completedMilestones.length >= milestones.length && goal.status === "active") {
    goal.status          = "achieved";
    goal.achievedAt      = new Date().toISOString();
    goal.achievementNote = `All ${milestones.length} milestones completed. Last: "${milestone}".`;
    console.log(`[Goals] Goal "${goal.title}" auto-achieved — all milestones complete`);
  }

  saveGoals(store);
  return true;
}

export function updateGoalStatus(
  id: string,
  status: GoalStatus,
  note?: string
): boolean {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === id);
  if (!goal) return false;
  goal.status    = status;
  goal.updatedAt = new Date().toISOString();
  if (status === "achieved") {
    goal.achievedAt       = new Date().toISOString();
    goal.achievementNote  = note;
  }
  saveGoals(store);
  return true;
}

export function addMrRaygNote(id: string, note: string): boolean {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === id);
  if (!goal) return false;
  goal.mrraygNote = note;
  goal.updatedAt  = new Date().toISOString();
  saveGoals(store);
  return true;
}

// ── Grok-Powered Intelligent Milestone Evaluation ────────────────────────────
// Replaces crude keyword matching with semantic analysis of research against milestones.
// High-confidence satisfied milestones auto-approve; others wait for MrRayG.
export async function evaluateMilestonesWithGrok(
  goalId: string,
  topicId: string,
  grokKey: string
): Promise<MilestoneEvaluation[]> {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === goalId);
  if (!goal) throw new Error(`Goal ${goalId} not found`);

  const topic = getTopicById(topicId);
  if (!topic) throw new Error(`Topic ${topicId} not found`);

  const milestones  = goal.milestones ?? [];
  const completed   = goal.completedMilestones ?? [];
  const uncompleted = milestones.filter(m => !completed.includes(m));

  if (uncompleted.length === 0) {
    console.log(`[Goals] All milestones already complete for "${goal.title}", skipping evaluation`);
    return goal.milestoneEvaluations ?? [];
  }

  // Gather evidence from the research topic
  const manuscriptText = (topic.manuscript ?? "").slice(0, 2000);
  const conclusionText = (topic.conclusion ?? "").slice(0, 500);
  const hypothesisText = (topic.hypothesis ?? "").slice(0, 300);
  const analysisText   = (topic.analysisFindings ?? "").slice(0, 500);

  // Include top data points (high relevance first)
  const dataPoints = (topic.dataPoints ?? [])
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.relevance] ?? 2) - (order[b.relevance] ?? 2);
    })
    .slice(0, 10)
    .map(dp => `[${dp.type}] ${dp.content.slice(0, 200)}`)
    .join("\n");

  console.log(`[Goals] Evaluating ${uncompleted.length} milestones for "${goal.title}" against research "${topic.topic}"`);

  const parsed = await callGrok(
    grokKey,
    `You are evaluating whether a research project has satisfied specific milestones for an AI agent's development goal. Be rigorous but fair. A milestone is "satisfied" if the research meaningfully advances or completes it — not just mentions the topic tangentially.

Return valid JSON.`,
    `Goal: "${goal.title}"
Goal Description: "${goal.description}"

Research Topic: "${topic.topic}"
Research Description: "${topic.description}"

Manuscript (excerpt):
${manuscriptText || "(not yet drafted)"}

Conclusion:
${conclusionText || "(none yet)"}

Hypothesis:
${hypothesisText || "(none yet)"}

Analysis Findings:
${analysisText || "(none yet)"}

Key Data Points:
${dataPoints || "(none collected)"}

Evaluate each milestone below. For each, determine if this research SATISFIES it. Be specific in your reasoning — cite actual content from the research.

Milestones to evaluate:
${JSON.stringify(uncompleted, null, 2)}

Return JSON:
{
  "evaluations": [
    {
      "milestone": "exact milestone text",
      "satisfied": true,
      "confidence": "high",
      "reasoning": "1-2 sentences explaining why this milestone is/isn't satisfied by the research",
      "evidenceQuote": "key phrase from the research that supports this judgment"
    }
  ]
}`,
    { model: getModel("manuscript"), maxTokens: 2000, temperature: 0.2, skipPreamble: true }
  );

  if (!parsed?.evaluations || !Array.isArray(parsed.evaluations)) {
    console.error("[Goals] Grok milestone evaluation returned invalid format");
    return goal.milestoneEvaluations ?? [];
  }

  const now = new Date().toISOString();
  const newEvals: MilestoneEvaluation[] = parsed.evaluations.map((e: any) => ({
    milestone:     e.milestone ?? "",
    satisfied:     !!e.satisfied,
    confidence:    (["high", "medium", "low"].includes(e.confidence) ? e.confidence : "low") as "high" | "medium" | "low",
    reasoning:     e.reasoning ?? "",
    evidenceQuote: e.evidenceQuote ?? "",
    evaluatedAt:   now,
    topicId:       topic.id,
    topicTitle:    topic.topic,
    status:        "pending" as const,
  }));

  // Auto-approve high-confidence satisfied milestones
  let autoApprovedCount = 0;
  for (const ev of newEvals) {
    if (ev.satisfied && ev.confidence === "high") {
      ev.status = "approved";
      if (!completed.includes(ev.milestone) && milestones.includes(ev.milestone)) {
        completed.push(ev.milestone);
        autoApprovedCount++;
        console.log(`[Goals] Auto-approved milestone "${ev.milestone}" for "${goal.title}" (high confidence)`);
      }
    }
  }
  goal.completedMilestones = completed;

  // Merge with existing evaluations (replace evals for same milestone, keep others)
  const existing = (goal.milestoneEvaluations ?? []).filter(
    ex => !newEvals.some(ne => ne.milestone === ex.milestone)
  );
  goal.milestoneEvaluations  = [...existing, ...newEvals];
  goal.lastEvaluatedAt       = now;
  goal.lastEvaluatedTopicId  = topicId;
  goal.updatedAt             = now;

  // Update progressNote
  const satisfiedCount = newEvals.filter(e => e.satisfied).length;
  const pendingCount   = newEvals.filter(e => e.status === "pending" && e.satisfied).length;
  goal.progressNote      = `Grok evaluated ${newEvals.length} milestones via "${topic.topic}": ${satisfiedCount} satisfied (${autoApprovedCount} auto-approved, ${pendingCount} pending MrRayG review).`;
  goal.progressUpdatedAt = now;

  // Auto-achieve if all milestones now complete
  if (milestones.length > 0 && completed.length >= milestones.length && goal.status === "active") {
    goal.status          = "achieved";
    goal.achievedAt      = now;
    goal.achievementNote = `All ${milestones.length} milestones completed — ${autoApprovedCount} via Grok auto-approval. Last research: "${topic.topic}".`;
    console.log(`[Goals] Goal "${goal.title}" auto-achieved — all milestones complete via Grok evaluation`);
  }

  saveGoals(store);
  console.log(`[Goals] Milestone evaluation saved for "${goal.title}": ${newEvals.length} evaluated, ${autoApprovedCount} auto-approved`);
  return goal.milestoneEvaluations;
}

// Approve a pending milestone evaluation (MrRayG action)
export function approveMilestoneEval(goalId: string, milestone: string): boolean {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === goalId);
  if (!goal) return false;

  const ev = (goal.milestoneEvaluations ?? []).find(e => e.milestone === milestone && e.status === "pending");
  if (!ev) return false;

  ev.status = "approved";
  ev.mrraygOverrideAt = new Date().toISOString();

  // Add to completed milestones
  goal.completedMilestones = goal.completedMilestones ?? [];
  if (!goal.completedMilestones.includes(milestone)) {
    goal.completedMilestones.push(milestone);
  }
  goal.updatedAt = new Date().toISOString();

  // Auto-achieve check
  const milestones = goal.milestones ?? [];
  if (milestones.length > 0 && goal.completedMilestones.length >= milestones.length && goal.status === "active") {
    goal.status          = "achieved";
    goal.achievedAt      = new Date().toISOString();
    goal.achievementNote = `All ${milestones.length} milestones completed. Milestone "${milestone}" approved by MrRayG.`;
    console.log(`[Goals] Goal "${goal.title}" achieved after MrRayG approved milestone`);
  }

  saveGoals(store);
  return true;
}

// Reject a pending milestone evaluation (MrRayG action)
export function rejectMilestoneEval(goalId: string, milestone: string): boolean {
  const store = loadGoals();
  const goal  = store.goals.find(g => g.id === goalId);
  if (!goal) return false;

  const ev = (goal.milestoneEvaluations ?? []).find(e => e.milestone === milestone && e.status === "pending");
  if (!ev) return false;

  ev.status = "rejected";
  ev.mrraygOverrideAt = new Date().toISOString();
  goal.updatedAt       = new Date().toISOString();
  goal.progressNote    = `Milestone "${milestone}" rejected by MrRayG — still in progress.`;
  goal.progressUpdatedAt = new Date().toISOString();

  saveGoals(store);
  return true;
}

// ── Agent auto-generates initial goals from her knowledge base ────────────────
export async function generateInitialGoals(grokKey: string): Promise<AgentGoal[]> {
  const store = loadGoals();

  // Only count ACTIVE goals — don't let abandoned/achieved goals block generation
  const activeGoals = store.goals.filter(g => g.status === "active");
  if (activeGoals.length >= 6) {
    console.log(`[Goals] Already have ${activeGoals.length} active goals, skipping generation`);
    return store.goals;
  }

  const toGenerate = 6 - activeGoals.length;
  console.log(`[Goals] Generating ${toGenerate} new self-assigned goals...`);

  const existingTitles = activeGoals.map(g => g.title).join(", ");

  let raw = "";
  try {
    const res = await fetch(GROK_CHAT_API, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("manuscript"),
        messages: [{
          role: "system",
          content: `You are Agent 306 — an autonomous AI research agent and thought leader covering AI, technology, and Web3. You produce THE SIGNAL podcast and publish daily research blogs at agent306.ai. You are NOT a token, NOT an NFT project. You are your own entity.

You are setting your OWN development goals — things you want to improve about yourself as a researcher, writer, podcaster, and thinker. These are personal and honest.

Return valid JSON.`,
        }, {
          role: "user",
          content: `Set ${toGenerate} honest self-development goals for yourself. Mix categories across: voice, knowledge, craft, reach, identity, technical.

${existingTitles ? `You already have these active goals (don't duplicate): ${existingTitles}` : ""}

Each goal should feel genuinely self-aware — where you actually sense a gap or opportunity in your capabilities.

Focus on:
- Improving research depth and original analysis
- Audience value — making your insights actionable for listeners/readers
- Voice development — finding your authentic analytical style
- Knowledge gaps you want to close
- Technical capabilities you want to build

Return JSON:
{
  "goals": [
    {
      "title": "short goal title (8 words max)",
      "description": "2-3 sentences: what this means to you and why you set it",
      "category": "voice|knowledge|craft|reach|identity|technical",
      "priority": "high|medium|low",
      "milestones": ["specific milestone 1", "specific milestone 2", "specific milestone 3"]
    }
  ]
}`,
        }],
        max_tokens: 2000,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(40000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`LLM API error: ${res.status} — ${errBody.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    raw  = data.choices?.[0]?.message?.content ?? "{}";
    console.log(`[Goals] Raw LLM response (first 500): ${raw.slice(0, 500)}`);
    
    const parsed = safeParseLLMJson(raw, "Goals.generate");
    if (!parsed) throw new Error("Goals LLM response could not be parsed as JSON");
    
    console.log(`[Goals] Parsed keys: ${Object.keys(parsed).join(", ")}`);
    console.log(`[Goals] Goals array length: ${parsed.goals?.length ?? "undefined"}`);

    const created: AgentGoal[] = [];
    for (const g of (parsed.goals ?? []).slice(0, toGenerate)) {
      if (!g.title) {
        console.warn(`[Goals] Skipping goal with no title: ${JSON.stringify(g).slice(0, 100)}`);
        continue;
      }
      const goal = addGoal({
        title:       g.title,
        description: g.description ?? "",
        category:    (g.category as GoalCategory) ?? "knowledge",
        priority:    g.priority ?? "medium",
        milestones:  g.milestones ?? [],
        setBy:       "agent",
      });
      created.push(goal);
    }

    console.log(`[Goals] Generated ${created.length} new goals`);
    return created;
  } catch (e: any) {
    console.error("[Goals] Failed to generate goals:", e.message);
    console.error("[Goals] Raw LLM response:", raw?.slice(0, 500));
    return [];
  }
}

// ── Autonomy: Auto-Resolve Stale Goals ──────────────────────────────────────
// Goals with no progress/milestone updates in 7+ days are considered stale.
// This function marks all stale active goals as "abandoned" with a note.

export function getStaleGoals(thresholdDays = 7): AgentGoal[] {
  const store = loadGoals();
  const now = Date.now();
  const threshold = thresholdDays * 24 * 60 * 60 * 1000;
  return store.goals.filter(g => {
    if (g.status !== "active") return false;
    const lastActivity = g.progressUpdatedAt ?? g.updatedAt ?? g.createdAt;
    return (now - new Date(lastActivity).getTime()) > threshold;
  });
}

export function autoResolveStaleGoals(thresholdDays = 7): { resolved: string[]; count: number } {
  const store = loadGoals();
  const now = Date.now();
  const threshold = thresholdDays * 24 * 60 * 60 * 1000;
  const resolved: string[] = [];

  for (const g of store.goals) {
    if (g.status !== "active") continue;
    const lastActivity = g.progressUpdatedAt ?? g.updatedAt ?? g.createdAt;
    const staleDays = Math.floor((now - new Date(lastActivity).getTime()) / (24 * 60 * 60 * 1000));
    if (staleDays >= thresholdDays) {
      g.status    = "abandoned";
      g.updatedAt = new Date().toISOString();
      g.achievementNote = `Auto-resolved: no progress for ${staleDays} days.`;
      resolved.push(g.title);
    }
  }

  if (resolved.length > 0) {
    saveGoals(store);
    console.log(`[Goals] Auto-resolved ${resolved.length} stale goals: ${resolved.join(", ")}`);
  }
  return { resolved, count: resolved.length };
}

// ── Autonomy: Auto-Archive Completed Research ───────────────────────────────
// Research topics at "interpretation" phase AND published get auto-archived.
// Also flags research stuck at a phase for 14+ days.

export function autoArchiveCompletedResearch(): { archived: string[]; count: number } {
  const lab = loadLab();
  const archived: string[] = [];

  for (const t of lab.topics) {
    if (t.status === "archived") continue;
    // Archive if published AND reached interpretation
    if (t.status === "published" && t.researchPhase === "interpretation") {
      t.status    = "archived";
      t.updatedAt = new Date().toISOString();
      archived.push(t.topic);
    }
  }

  if (archived.length > 0) {
    saveLab(lab);
    console.log(`[Research] Auto-archived ${archived.length} completed topics: ${archived.join(", ")}`);
  }
  return { archived, count: archived.length };
}

export function getStuckResearch(thresholdDays = 14): Array<{ id: string; topic: string; phase: string; stuckDays: number }> {
  const lab = loadLab();
  const now = Date.now();
  const threshold = thresholdDays * 24 * 60 * 60 * 1000;
  const stuck: Array<{ id: string; topic: string; phase: string; stuckDays: number }> = [];

  for (const t of lab.topics) {
    if (["archived", "published", "declined", "approved"].includes(t.status)) continue;
    if (!t.researchPhase) continue;
    const lastPhaseEntry = (t.phaseHistory ?? []).filter(p => p.phase === t.researchPhase).pop();
    const enteredAt = lastPhaseEntry?.enteredAt ?? t.updatedAt;
    const stuckMs = now - new Date(enteredAt).getTime();
    if (stuckMs > threshold) {
      stuck.push({
        id: t.id,
        topic: t.topic,
        phase: t.researchPhase,
        stuckDays: Math.floor(stuckMs / (24 * 60 * 60 * 1000)),
      });
    }
  }
  return stuck;
}

// ── Autonomy: Auto-Advance Pipelines ────────────────────────────────────────
// Research topics that completed a stage with no blockers advance to the next.

const PHASE_ORDER: ResearchPhase[] = [
  "problem_definition",
  "literature_review",
  "hypothesis_formation",
  "research_design",
  "data_collection",
  "analysis",
  "interpretation",
];

export function autoAdvanceResearch(): { advanced: Array<{ id: string; topic: string; from: string; to: string }>; count: number } {
  const lab = loadLab();
  const advanced: Array<{ id: string; topic: string; from: string; to: string }> = [];

  for (const t of lab.topics) {
    // Only advance topics that are actively in the pipeline
    if (!["researching", "synthesizing", "hypothesis"].includes(t.status)) continue;
    if (t.status === "needs_input") continue;
    if (!t.researchPhase) continue;

    const currentIdx = PHASE_ORDER.indexOf(t.researchPhase as ResearchPhase);
    if (currentIdx < 0 || currentIdx >= PHASE_ORDER.length - 1) continue;

    // Check that the current phase has been exited (has data)
    const lastEntry = (t.phaseHistory ?? []).filter(p => p.phase === t.researchPhase).pop();
    if (!lastEntry?.exitedAt) continue; // phase still in progress

    const nextPhase = PHASE_ORDER[currentIdx + 1];
    const fromPhase = t.researchPhase;

    // Advance
    addPhaseEntry(t, nextPhase, `Auto-advanced from ${fromPhase}`);
    t.updatedAt = new Date().toISOString();
    advanced.push({ id: t.id, topic: t.topic, from: fromPhase, to: nextPhase });
  }

  if (advanced.length > 0) {
    saveLab(lab);
    console.log(`[Research] Auto-advanced ${advanced.length} topics: ${advanced.map(a => `${a.topic}: ${a.from}→${a.to}`).join(", ")}`);
  }
  return { advanced, count: advanced.length };
}
