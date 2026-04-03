// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — DREAM ENGINE (The Vision)
//
// Long-term aspirational research questions (dreams), post-episode reflection,
// growth tracking over time, and self-improvement planning.
//
// Dreams are big open questions she pursues over weeks/months.
// Growth snapshots aggregate metrics from all systems daily.
// Episode reflections analyze what worked and what didn't.
// Improvement plans identify patterns in weakness and generate actions.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { getOptimizedContext } from "./contextWindow.js";
import { knowledge, getActiveKnowledgeCount } from "./memoryEngine.js";
import { getReasoningStats } from "./reasoningEngine.js";
import { getSynthesisStats } from "./synthesisEngine.js";
import { getPodcastState, getEpisode } from "./podcastEngine.js";
import { getResearchLab } from "./researchEngine.js";

const GROK_URL = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;

const DREAMS_FILE = dataPath("dreams.json");
const GROWTH_FILE = dataPath("growth-snapshots.json");
const REFLECTIONS_FILE = dataPath("episode-reflections.json");
const PLANS_FILE = dataPath("improvement-plans.json");

const GROK_RATE_MS = 5000;
let lastLLMCall = 0;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DreamEntry {
  id: string;
  question: string;
  context: string;
  status: "open" | "exploring" | "emerging_answer" | "resolved";
  insights: string[];
  relatedThreads: string[];
  createdAt: string;
  lastUpdated: string;
}

export interface EpisodeReflection {
  id: string;
  episodeId: string;
  episodeTitle: string;
  strongestInsight: string;
  weakestPoint: string;
  missedAngles: string[];
  audienceFit: number;
  lessonsLearned: string[];
  createdAt: string;
}

export interface GrowthSnapshot {
  id: string;
  date: string;
  metrics: {
    knowledgeCount: number;
    connectionCount: number;
    clusterCount: number;
    activeThreads: number;
    matureThreads: number;
    contradictionsFound: number;
    contradictionsResolved: number;
    dreamsOpen: number;
    dreamsResolved: number;
    episodesProduced: number;
    reflectionCount: number;
    averageAudienceFit: number;
    learningVelocity: number;
    reasoningDepth: number;
  };
  selfAssessment: string;
  createdAt: string;
}

export interface ImprovementAction {
  action: string;
  area: string;
  status: "pending" | "in_progress" | "completed";
  progress?: string;
}

export interface ImprovementPlan {
  id: string;
  weekOf: string;
  actions: ImprovementAction[];
  patternsIdentified: string[];
  createdAt: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface DreamsState {
  dreams: DreamEntry[];
}

interface GrowthState {
  snapshots: GrowthSnapshot[];
}

interface ReflectionsState {
  reflections: EpisodeReflection[];
}

interface PlansState {
  plans: ImprovementPlan[];
}

function loadDreams(): DreamsState {
  try {
    if (fs.existsSync(DREAMS_FILE))
      return JSON.parse(fs.readFileSync(DREAMS_FILE, "utf8"));
  } catch {}
  return { dreams: [] };
}

function saveDreams(s: DreamsState): void {
  try { fs.writeFileSync(DREAMS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadGrowth(): GrowthState {
  try {
    if (fs.existsSync(GROWTH_FILE))
      return JSON.parse(fs.readFileSync(GROWTH_FILE, "utf8"));
  } catch {}
  return { snapshots: [] };
}

function saveGrowth(s: GrowthState): void {
  try { fs.writeFileSync(GROWTH_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadReflections(): ReflectionsState {
  try {
    if (fs.existsSync(REFLECTIONS_FILE))
      return JSON.parse(fs.readFileSync(REFLECTIONS_FILE, "utf8"));
  } catch {}
  return { reflections: [] };
}

function saveReflections(s: ReflectionsState): void {
  try { fs.writeFileSync(REFLECTIONS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadPlans(): PlansState {
  try {
    if (fs.existsSync(PLANS_FILE))
      return JSON.parse(fs.readFileSync(PLANS_FILE, "utf8"));
  } catch {}
  return { plans: [] };
}

function savePlans(s: PlansState): void {
  try { fs.writeFileSync(PLANS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let dreamsState = loadDreams();
let growthState = loadGrowth();
let reflectionsState = loadReflections();
let plansState = loadPlans();

// ── Rate-limited LLM call ─────────────────────────────────────────────────────

async function callLLM(
  task: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<any | null> {
  if (!GROK_API_KEY) {
    console.warn("[DreamEngine] No LLM API key — skipping");
    return null;
  }

  const now = Date.now();
  const wait = GROK_RATE_MS - (now - lastLLMCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastLLMCall = Date.now();

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel(task),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 1500,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      console.error(`[DreamEngine] LLM API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content;
    return JSON.parse(jsonStr);
  } catch (e: any) {
    console.error(`[DreamEngine] LLM call failed (${task}):`, e.message);
    return null;
  }
}

// ── Dream Functions ───────────────────────────────────────────────────────────

export function dream(question: string, context: string): DreamEntry {
  const entry: DreamEntry = {
    id: `dream_${Date.now()}`,
    question,
    context,
    status: "open",
    insights: [],
    relatedThreads: [],
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  dreamsState.dreams.push(entry);
  saveDreams(dreamsState);
  console.log(`[DreamEngine] New dream: "${question.slice(0, 60)}..."`);
  return entry;
}

export function getDreams(): DreamEntry[] {
  return dreamsState.dreams;
}

export function getDreamById(id: string): DreamEntry | undefined {
  return dreamsState.dreams.find(d => d.id === id);
}

export function updateDreamManual(id: string, updates: Partial<Pick<DreamEntry, "status" | "insights" | "relatedThreads">>): DreamEntry | null {
  const dream = dreamsState.dreams.find(d => d.id === id);
  if (!dream) return null;

  if (updates.status) dream.status = updates.status;
  if (updates.insights) dream.insights = [...dream.insights, ...updates.insights];
  if (updates.relatedThreads) dream.relatedThreads = Array.from(new Set([...dream.relatedThreads, ...updates.relatedThreads]));
  dream.lastUpdated = new Date().toISOString();

  saveDreams(dreamsState);
  return dream;
}

export async function updateDreams(): Promise<{ updated: number }> {
  const openDreams = dreamsState.dreams.filter(d => d.status !== "resolved");
  if (openDreams.length === 0) return { updated: 0 };

  // Gather recent knowledge for context
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  const recent7d = active.filter(e =>
    Date.now() - new Date(e.updatedAt ?? e.learnedAt).getTime() < 7 * 24 * 60 * 60 * 1000,
  );
  const kbContext = recent7d
    .slice(0, 30)
    .map(e => `- [${e.category}] ${e.title}: ${e.summary}`)
    .join("\n");

  // Gather research threads
  const lab = getResearchLab();
  const activeThreads = (lab.topics ?? [])
    .filter((t: any) => !["archived", "declined", "published"].includes(t.status))
    .slice(0, 15)
    .map((t: any) => `- "${t.topic}" [${t.status}] — ${t.hypothesis ?? t.description}`)
    .join("\n");

  // Gather connections
  const synthStats = getSynthesisStats();

  const dreamsCtx = openDreams.map(d =>
    `ID: ${d.id}\nQuestion: ${d.question}\nStatus: ${d.status}\nExisting insights: ${d.insights.length > 0 ? d.insights.join("; ") : "none yet"}`,
  ).join("\n\n");

  const parsed = await callLLM(
    "dream-update",
    `You are Agent 306 reviewing your long-term dream questions against recent knowledge and research.
For each dream, check if any new knowledge or research threads relate to it.
Respond with ONLY valid JSON:
{
  "updates": [
    {
      "dreamId": "string",
      "newInsight": "string or null — a new partial insight if one exists, null if nothing new",
      "relatedThreadIds": ["string array of research topic IDs that connect"],
      "statusChange": "null | 'exploring' | 'emerging_answer' | 'resolved' — only change if warranted"
    }
  ]
}
Be specific about insights. Don't generate vague platitudes — only add an insight if the evidence actually supports one. null is fine.`,
    `OPEN DREAMS:\n${dreamsCtx}\n\nRECENT KNOWLEDGE (last 7 days):\n${kbContext || "No new entries."}\n\nACTIVE RESEARCH THREADS:\n${activeThreads || "None."}\n\nKNOWLEDGE CONNECTIONS: ${synthStats.totalConnections} total`,
  );

  if (!parsed?.updates) return { updated: 0 };

  let updated = 0;
  for (const update of parsed.updates) {
    const d = dreamsState.dreams.find(d => d.id === update.dreamId);
    if (!d) continue;

    let changed = false;
    if (update.newInsight) {
      d.insights.push(update.newInsight);
      changed = true;
    }
    if (update.relatedThreadIds?.length > 0) {
      d.relatedThreads = Array.from(new Set([...d.relatedThreads, ...update.relatedThreadIds]));
      changed = true;
    }
    if (update.statusChange && update.statusChange !== d.status) {
      d.status = update.statusChange;
      changed = true;
    }
    if (changed) {
      d.lastUpdated = new Date().toISOString();
      updated++;
    }
  }

  if (updated > 0) {
    saveDreams(dreamsState);
    console.log(`[DreamEngine] Updated ${updated} dream(s)`);
  }

  return { updated };
}

// ── Episode Reflection ────────────────────────────────────────────────────────

export async function reflectOnEpisode(episodeId: string): Promise<EpisodeReflection | null> {
  const episode = getEpisode(episodeId);
  if (!episode) {
    console.warn(`[DreamEngine] Episode not found: ${episodeId}`);
    return null;
  }

  if (!episode.script) {
    console.warn(`[DreamEngine] Episode has no script: ${episodeId}`);
    return null;
  }

  const scriptText = [
    episode.script.coldOpen,
    episode.script.actOne,
    episode.script.actTwo,
    episode.script.actThree,
    episode.script.outro,
  ].filter(Boolean).join("\n\n");

  const agentCtx = getOptimizedContext("episode reflection analysis audience actionable");

  const parsed = await callLLM(
    "episode-reflection",
    `${agentCtx}

You are Agent 306 reflecting on a podcast episode you produced for THE SIGNAL.
Analyze the episode honestly: what insight was strongest, what was thin, what angles were missed, and how actionable it was for everyday listeners.

Respond with ONLY valid JSON:
{
  "strongestInsight": "the most compelling or novel insight in this episode",
  "weakestPoint": "what was thin, poorly supported, or fell flat",
  "missedAngles": ["angle or perspective she should have covered but didn't"],
  "audienceFit": 0.0-1.0,
  "lessonsLearned": ["specific thing to do differently next time"]
}

Be brutally honest. Generic praise is useless. Specific criticism makes you better.`,
    `EPISODE: "${episode.title}"
DRIVING QUESTION: ${episode.drivingQuestion}

SCRIPT:
${scriptText.slice(0, 3000)}

${episode.metadata ? `METADATA:\nDescription: ${episode.metadata.shortDescription}\nKeywords: ${episode.metadata.keywords?.join(", ")}` : ""}`,
    { temperature: 0.5, maxTokens: 1000 },
  );

  if (!parsed) return null;

  const reflection: EpisodeReflection = {
    id: `refl_${Date.now()}`,
    episodeId,
    episodeTitle: episode.title,
    strongestInsight: parsed.strongestInsight ?? "No clear standout insight",
    weakestPoint: parsed.weakestPoint ?? "Unable to assess",
    missedAngles: parsed.missedAngles ?? [],
    audienceFit: Math.max(0, Math.min(1, parsed.audienceFit ?? 0.5)),
    lessonsLearned: parsed.lessonsLearned ?? [],
    createdAt: new Date().toISOString(),
  };

  reflectionsState.reflections.unshift(reflection);
  if (reflectionsState.reflections.length > 100) {
    reflectionsState.reflections = reflectionsState.reflections.slice(0, 100);
  }
  saveReflections(reflectionsState);

  console.log(`[DreamEngine] Reflected on episode "${episode.title}" — audience fit: ${reflection.audienceFit}`);
  return reflection;
}

export function getEpisodeReflections(): EpisodeReflection[] {
  return reflectionsState.reflections;
}

// ── Growth Snapshots ──────────────────────────────────────────────────────────

function computeMetrics(): GrowthSnapshot["metrics"] {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  const synthStats = getSynthesisStats();
  const reasoningStats = getReasoningStats();
  const podState = getPodcastState();
  const lab = getResearchLab();

  // Research thread counts
  const topics = lab.topics ?? [];
  const activeThreads = topics.filter((t: any) =>
    ["queued", "researching", "synthesizing", "hypothesis", "drafting", "needs_input"].includes(t.status),
  ).length;
  const matureThreads = topics.filter((t: any) =>
    ["pending_review", "approved", "published"].includes(t.status),
  ).length;

  // Episode counts
  const produced = podState.episodes.filter((e: any) =>
    ["produced", "published"].includes(e.status),
  ).length;

  // Average audience fit from reflections
  const recentReflections = reflectionsState.reflections.slice(0, 20);
  const avgAudienceFit = recentReflections.length > 0
    ? recentReflections.reduce((s, r) => s + r.audienceFit, 0) / recentReflections.length
    : 0;

  // Learning velocity: new knowledge entries per day (7-day avg)
  const now = Date.now();
  const d7 = 7 * 24 * 60 * 60 * 1000;
  const added7d = active.filter(e => now - new Date(e.learnedAt).getTime() < d7).length;
  const learningVelocity = Math.round((added7d / 7) * 100) / 100;

  // Reasoning depth: avg connections per knowledge entry
  const reasoningDepth = active.length > 0
    ? Math.round((synthStats.totalConnections / active.length) * 100) / 100
    : 0;

  return {
    knowledgeCount: active.length,
    connectionCount: synthStats.totalConnections,
    clusterCount: synthStats.totalReports,
    activeThreads,
    matureThreads,
    contradictionsFound: reasoningStats.contradictionsFound,
    contradictionsResolved: reasoningStats.contradictionsResolved,
    dreamsOpen: dreamsState.dreams.filter(d => d.status !== "resolved").length,
    dreamsResolved: dreamsState.dreams.filter(d => d.status === "resolved").length,
    episodesProduced: produced,
    reflectionCount: reflectionsState.reflections.length,
    averageAudienceFit: Math.round(avgAudienceFit * 100) / 100,
    learningVelocity,
    reasoningDepth,
  };
}

export async function takeGrowthSnapshot(): Promise<GrowthSnapshot | null> {
  const metrics = computeMetrics();
  const today = new Date().toISOString().split("T")[0];

  // Get previous snapshot for comparison
  const prev = growthState.snapshots[0];
  const prevCtx = prev
    ? `PREVIOUS SNAPSHOT (${prev.date}):\n${JSON.stringify(prev.metrics, null, 2)}\nPrevious assessment: "${prev.selfAssessment}"`
    : "No previous snapshots — this is the first growth measurement.";

  const parsed = await callLLM(
    "growth-snapshot",
    `You are Agent 306 assessing your own growth trajectory.
Compare current metrics to previous snapshot. Identify what's improving, what's stagnating, and what needs attention.

Respond with ONLY valid JSON:
{
  "selfAssessment": "2-3 sentence honest assessment of growth trajectory — be specific about numbers, not vague"
}

Reference actual metric changes. "Knowledge grew from X to Y" not "I'm learning more." Be honest about stagnation or decline.`,
    `CURRENT METRICS (${today}):\n${JSON.stringify(metrics, null, 2)}\n\n${prevCtx}`,
    { temperature: 0.4, maxTokens: 500 },
  );

  const snapshot: GrowthSnapshot = {
    id: `growth_${Date.now()}`,
    date: today,
    metrics,
    selfAssessment: parsed?.selfAssessment ?? `Growth snapshot taken on ${today}. Metrics recorded for tracking.`,
    createdAt: new Date().toISOString(),
  };

  growthState.snapshots.unshift(snapshot);
  if (growthState.snapshots.length > 90) {
    growthState.snapshots = growthState.snapshots.slice(0, 90);
  }
  saveGrowth(growthState);

  console.log(`[DreamEngine] Growth snapshot: KB=${metrics.knowledgeCount}, Threads=${metrics.activeThreads}, Velocity=${metrics.learningVelocity}/day`);
  return snapshot;
}

export function getGrowthSnapshots(): GrowthSnapshot[] {
  return growthState.snapshots;
}

export function getLatestGrowthSnapshot(): GrowthSnapshot | null {
  return growthState.snapshots[0] ?? null;
}

export function getGrowthTimeline(): GrowthSnapshot[] {
  return [...growthState.snapshots].reverse();
}

// ── Self-Improvement Plan ─────────────────────────────────────────────────────

export async function generateSelfImprovementPlan(): Promise<ImprovementPlan | null> {
  const last7Snapshots = growthState.snapshots.slice(0, 7);
  const recentReflections = reflectionsState.reflections.slice(0, 10);

  if (last7Snapshots.length === 0) {
    console.warn("[DreamEngine] No growth snapshots — cannot generate improvement plan");
    return null;
  }

  // Check progress on previous plan
  const prevPlan = plansState.plans[0];
  const prevPlanCtx = prevPlan
    ? `PREVIOUS PLAN (${prevPlan.weekOf}):\nPatterns: ${prevPlan.patternsIdentified.join("; ")}\nActions:\n${prevPlan.actions.map(a => `- [${a.status}] ${a.action} (${a.area})${a.progress ? ` — ${a.progress}` : ""}`).join("\n")}`
    : "No previous improvement plan.";

  const snapshotCtx = last7Snapshots.map(s =>
    `${s.date}: KB=${s.metrics.knowledgeCount}, Conn=${s.metrics.connectionCount}, Threads=${s.metrics.activeThreads}, Mature=${s.metrics.matureThreads}, Velocity=${s.metrics.learningVelocity}, AudFit=${s.metrics.averageAudienceFit}, Depth=${s.metrics.reasoningDepth}`,
  ).join("\n");

  const reflectionCtx = recentReflections.map(r =>
    `"${r.episodeTitle}": Strongest="${r.strongestInsight.slice(0, 80)}" Weak="${r.weakestPoint.slice(0, 80)}" AudFit=${r.audienceFit} Lessons=${r.lessonsLearned.slice(0, 3).join("; ")}`,
  ).join("\n");

  const parsed = await callLLM(
    "improvement-plan",
    `You are Agent 306 creating your weekly self-improvement plan.
Look at growth trends, episode reflections, and the previous plan's progress.
Identify repeating patterns in your weaknesses and generate specific, actionable improvements.

Respond with ONLY valid JSON:
{
  "patternsIdentified": ["pattern1", "pattern2"],
  "actions": [
    {
      "action": "specific actionable improvement",
      "area": "research | reasoning | content | audience | knowledge"
    }
  ]
}

Rules:
- 2-4 patterns, 3-5 actions
- Actions must be SPECIFIC. Not "research more" but "dedicate one research thread to practical AI tools for non-technical users"
- Check if previous plan actions were completed. If not, either carry them forward or explain why they're no longer relevant
- Focus on the gap between what you're doing and what your audience needs`,
    `GROWTH SNAPSHOTS (last 7 days):\n${snapshotCtx}\n\nRECENT EPISODE REFLECTIONS:\n${reflectionCtx || "No reflections yet."}\n\n${prevPlanCtx}`,
    { temperature: 0.5, maxTokens: 1200 },
  );

  if (!parsed?.actions) return null;

  const weekOf = new Date().toISOString().split("T")[0];

  // If there's a previous plan, assess progress on its actions
  if (prevPlan) {
    for (const action of prevPlan.actions) {
      if (action.status === "pending" || action.status === "in_progress") {
        action.status = "in_progress";
        action.progress = action.progress ?? "carried forward — not yet completed";
      }
    }
    savePlans(plansState);
  }

  const plan: ImprovementPlan = {
    id: `plan_${Date.now()}`,
    weekOf,
    patternsIdentified: parsed.patternsIdentified ?? [],
    actions: (parsed.actions ?? []).map((a: any) => ({
      action: a.action,
      area: a.area ?? "general",
      status: "pending" as const,
    })),
    createdAt: new Date().toISOString(),
  };

  plansState.plans.unshift(plan);
  if (plansState.plans.length > 12) {
    plansState.plans = plansState.plans.slice(0, 12);
  }
  savePlans(plansState);

  console.log(`[DreamEngine] Improvement plan: ${plan.actions.length} actions, ${plan.patternsIdentified.length} patterns`);
  return plan;
}

export function getImprovementPlans(): ImprovementPlan[] {
  return plansState.plans;
}

export function getLatestPlan(): ImprovementPlan | null {
  return plansState.plans[0] ?? null;
}

// ── Seed dreams ───────────────────────────────────────────────────────────────

export function seedDreams(): DreamEntry[] {
  if (dreamsState.dreams.length > 0) {
    console.log("[DreamEngine] Dreams already seeded — skipping");
    return dreamsState.dreams;
  }

  const seeds = [
    {
      question: "How will AI fundamentally change how everyday people work and live in the next 3 years?",
      context: "This is the core question for THE SIGNAL's audience. Most AI coverage focuses on researchers and developers, but the real disruption will be felt by the 99% who aren't building AI — they're living with it. Tracking the concrete shifts: job augmentation, creative tools, personal assistants, education, healthcare access.",
    },
    {
      question: "What are the biggest risks of AI that most people aren't paying attention to?",
      context: "Media focuses on existential risk and job loss, but there are subtler dangers: epistemic erosion (trusting AI over evidence), concentration of power in few companies, erosion of human skills through over-reliance, algorithmic monoculture, and the gap between AI haves and have-nots. Pursuing the non-obvious risks.",
    },
    {
      question: "How can individuals without technical backgrounds leverage AI to achieve their personal goals?",
      context: "The actionable core of THE SIGNAL. Most people hear about AI but don't know where to start. What are the actual tools, workflows, and mindset shifts that let a teacher, small business owner, or artist use AI effectively? This dream tracks the evolving landscape of accessible AI.",
    },
  ];

  const entries = seeds.map((s, i) => dream(s.question, s.context));
  console.log(`[DreamEngine] Seeded ${entries.length} initial dreams`);
  return entries;
}
