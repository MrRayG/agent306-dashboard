/**
 * ─────────────────────────────────────────────────────────────
 *  PUBLIC API — Safe data endpoints for agent306.ai
 *
 *  SECURITY: Only titles, statuses, counts, phases, timestamps.
 *  NEVER: manuscript text, findings, prompts, keys, wallet info.
 * ─────────────────────────────────────────────────────────────
 */

import { knowledge, performance } from "./memoryEngine.js";
import { getResearchLab, getGoals, getAspirations } from "./researchEngine.js";
import { getPodcastState } from "./podcastEngine.js";
import { getExplorationState } from "./explorationEngine.js";
import { getAgentReachStatus } from "./agentReachEngine.js";
import { getBriefingState } from "./dailyCycleEngine.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { getLatestSnapshot, getEvolutionHistory } from "./evolutionTracker.js";
import { getBreakthroughs, getPredictions } from "./breakthroughDetector.js";
import { getCorrections } from "./reasoningEngine.js";
import { get306EvalResults } from "./evalEngine.js";
import { getLedgerSummary, getSelfChangeMetrics } from "./insightLedger.js";
import {
  isSelfIntegrityPrimitiveCoverageEnabled,
  summarizeSelfIntegrityCoverage,
  type SelfIntegrityCoverageReport,
} from "./primitives/selfIntegrityCoverage.js";
import {
  readReasoningQualityTail,
  summarizeReasoningQuality,
  type ReasoningQualityEntry,
} from "./reasoningQualityStore.js";

// ── In-memory cache (30-second TTL) ─────────────────────────

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const CACHE_TTL = 30_000; // 30 seconds
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, fn: () => T): T {
  const now = Date.now();
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (entry && now - entry.cachedAt < CACHE_TTL) return entry.data;
  const data = fn();
  cache.set(key, { data, cachedAt: now });
  return data;
}

// ── Stage label helper ───────────────────────────────────────

function stageLabel(value: number): string {
  if (value <= 25) return "Developing";
  if (value <= 50) return "Advancing";
  if (value <= 75) return "Accelerating";
  return "Approaching";
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ── Research category classifier ────────────────────────────

type ResearchCategory = "Blockchain" | "AI & Agents" | "Web3 Culture" | "Economics" | "Technology" | "Media";

const CATEGORY_KEYWORDS: Array<[ResearchCategory, string[]]> = [
  ["Blockchain",   ["blockchain", "burn", "nft", "token", "smart contract", "on-chain", "onchain", "mint", "wallet", "erc-721", "erc-1155"]],
  ["AI & Agents",  ["ai", "autonomous agent", "machine learning", "llm", "artificial intelligence", "neural", "gpt", "model", "agent"]],
  ["Web3 Culture", ["community", "dao", "culture", "social", "governance", "tribe", "vibe"]],
  ["Economics",    ["market", "pricing", "trading", "tokenomics", "floor price", "economy", "liquidity", "supply", "demand", "value"]],
  ["Technology",   ["infrastructure", "protocol", "erc", "platform", "api", "standard", "layer", "bridge", "node"]],
  ["Media",        ["content", "media", "publish", "podcast", "distribution", "broadcast", "episode", "stream", "video"]],
];

function classifyResearchCategory(title: string): ResearchCategory {
  const lower = title.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return "Technology";
}

// ── Research status priority (higher = better) ──────────────

const STATUS_PRIORITY: Record<string, number> = {
  published:       5,
  pending_review:  4,
  approved:        3,
  researching:     2,
};

function statusPriority(status: string): number {
  return STATUS_PRIORITY[status] ?? 1;
}

// ── Research phase labels ────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  problem_definition:    "Problem Definition",
  literature_review:     "Literature Review",
  hypothesis_formation:  "Hypothesis Formation",
  research_design:       "Research Design",
  data_collection:       "Data Collection",
  analysis:              "Analysis",
  interpretation:        "Interpretation",
};

const PHASE_ORDER = [
  "problem_definition", "literature_review", "hypothesis_formation",
  "research_design", "data_collection", "analysis", "interpretation",
];

// ── Stale-label sanitizer ────────────────────────────────────
// Replace legacy Normies/Hive-era references in public-facing labels.
// "THE HIVE" → "THE SIGNAL" (in-place), other stale tokens stripped entirely.
const STALE_HIVE = /\bTHE HIVE\b/gi;
const STALE_OTHER = /\b(?:Normies|NormiesTV|gnormie|serc1n|dopemind)\b/gi;

function sanitizeLabel(label: string): string {
  let out = label.replace(STALE_HIVE, "THE SIGNAL");
  out = out.replace(STALE_OTHER, "").replace(/\s{2,}/g, " ").trim();
  return out;
}

// ── 1. Status ────────────────────────────────────────────────

export function getPublicStatus() {
  return cached("status", () => {
    const exploration = getExplorationState();
    const lab = getResearchLab();
    const podcast = getPodcastState();

    // Determine current status from engine states
    let currentStatus: string = "idle";
    let statusLabel = "Systems nominal — monitoring and learning";

    // Check if exploration is running
    if (exploration.isRunning) {
      currentStatus = "exploring";
      const territories = exploration.currentRun?.territoriesScanned ?? [];
      statusLabel = territories.length > 0
        ? `Exploring ${territories.join(", ")}`
        : "Running autonomous exploration cycle";
    }
    // Check for active research
    else if (lab.topics.some(t => t.status === "researching" || t.status === "synthesizing")) {
      currentStatus = "researching";
      const active = lab.topics.find(t => t.status === "researching" || t.status === "synthesizing");
      statusLabel = active ? `Researching ${active.topic}` : "Research pipeline active";
    }
    // Check for podcast in scripting
    else if (podcast.episodes.some(e => e.status === "draft" || e.status === "scripted")) {
      currentStatus = "podcasting";
      const ep = podcast.episodes.find(e => e.status === "draft" || e.status === "scripted");
      statusLabel = ep ? `Preparing podcast: ${ep.title}` : "Podcast pipeline active";
    }
    // Check for pending review manuscripts
    else if (lab.topics.some(t => t.status === "pending_review" || t.status === "drafting")) {
      currentStatus = "writing";
      const writing = lab.topics.find(t => t.status === "drafting" || t.status === "pending_review");
      statusLabel = writing ? `Writing: ${writing.topic}` : "Drafting manuscript";
    }
    // Check for active analysis
    else if (lab.topics.some(t => t.status === "hypothesis")) {
      currentStatus = "analyzing";
      const hyp = lab.topics.find(t => t.status === "hypothesis");
      statusLabel = hyp ? `Analyzing hypothesis: ${hyp.topic}` : "Analyzing research data";
    }

    return {
      currentStatus,
      statusLabel: sanitizeLabel(statusLabel),
      lastUpdated: new Date().toISOString(),
      uptime: true,
    };
  });
}

// ── 2. Progress ──────────────────────────────────────────────

export function getPublicProgress() {
  return cached("progress", () => {
    const now = new Date().toISOString();
    const lab = getResearchLab();
    const goals = getGoals();
    const podcast = getPodcastState();
    const reach = getAgentReachStatus();

    // Intelligence
    const kbCount = knowledge.entries.filter(e => (e.status ?? "active") === "active").length;
    const completedTopics = lab.topics.filter(t =>
      t.status === "published" || t.status === "approved" || t.status === "declined"
    ).length;
    const hypothesesPublished = lab.stats.hypothesesConfirmed ?? 0;
    const avgQuality = performance.avgScore || 0;

    const intelligence = clamp(
      (Math.min(kbCount / 500, 1) * 100) * 0.3 +
      (Math.min(completedTopics / 50, 1) * 100) * 0.3 +
      (Math.min(hypothesesPublished / 20, 1) * 100) * 0.2 +
      (Math.min(avgQuality / 10, 1) * 100) * 0.2
    );

    // Autonomy
    // Count active engines: exploration, research, podcast, reach, daily-cycle = 5 main
    const totalEngines = 5;
    let enginesRunning = 0;
    const explorationState = getExplorationState();
    if (explorationState.totalRuns > 0) enginesRunning++;
    if (lab.topics.length > 0) enginesRunning++;
    if (podcast.episodes.length > 0) enginesRunning++;
    if (reach.enabled) enginesRunning++;
    if (getBriefingState().current) enginesRunning++;

    // Content auto-generated last 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentEpisodes = podcast.episodes.filter(
      e => new Date(e.createdAt).getTime() > sevenDaysAgo
    ).length;
    const recentTopics = lab.topics.filter(
      t => t.updatedAt && new Date(t.updatedAt).getTime() > sevenDaysAgo &&
           (t.status === "published" || t.status === "approved")
    ).length;
    const contentGenerated = recentEpisodes + recentTopics;

    const goalsAchieved = goals.stats.achieved ?? 0;
    const goalsTotal = goals.stats.total || 1;

    // Agent-Reach channels
    const channelEntries = Object.values(reach.channels ?? {});
    const activeChannels = channelEntries.filter((c: any) => c.active).length;
    const totalChannels = channelEntries.length || 1;

    const autonomy = clamp(
      (Math.min(enginesRunning / totalEngines, 1) * 100) * 0.3 +
      (Math.min(contentGenerated / 20, 1) * 100) * 0.3 +
      (Math.min(goalsAchieved / goalsTotal, 1) * 100) * 0.2 +
      (Math.min(activeChannels / totalChannels, 1) * 100) * 0.2
    );

    // Reach
    // Platforms: count those that have been used
    let platformsActive = 0;
    if (podcast.counters.totalPublished > 0) platformsActive++; // Spotify
    if (lab.stats.totalPublished > 0) platformsActive++;        // Mirror
    if (reach.channels?.twitter?.active) platformsActive++;     // Twitter/X
    if (reach.channels?.youtube?.active) platformsActive++;     // YouTube
    if (reach.channels?.rss?.active) platformsActive++;         // RSS

    const podcastPublished = podcast.counters.totalPublished ?? 0;
    const researchPublished = lab.stats.totalPublished ?? 0;

    const reachValue = clamp(
      (Math.min(platformsActive / 6, 1) * 100) * 0.3 +
      (Math.min(podcastPublished / 20, 1) * 100) * 0.25 +
      (Math.min(researchPublished / 15, 1) * 100) * 0.25 +
      // Farcaster followers — not tracked yet, use 0
      0 * 0.2
    );

    return {
      intelligence: { value: intelligence, stage: stageLabel(intelligence), updatedAt: now },
      autonomy:     { value: autonomy,     stage: stageLabel(autonomy),     updatedAt: now },
      reach:        { value: reachValue,    stage: stageLabel(reachValue),   updatedAt: now },
    };
  });
}

// ── 3. Activity ──────────────────────────────────────────────

export function getPublicActivity() {
  return cached("activity", () => {
    const items: Array<{
      type: string;
      title: string;
      detail: string;
      timestamp: string;
    }> = [];

    // Research topic updates
    const lab = getResearchLab();
    for (const t of lab.topics) {
      if (t.updatedAt) {
        const phase = t.researchPhase ? ` — ${PHASE_LABELS[t.researchPhase] ?? t.researchPhase}` : "";
        items.push({
          type: "research",
          title: t.topic,
          detail: `Status: ${t.status}${phase}`,
          timestamp: t.updatedAt,
        });
      }
    }

    // Published research
    for (const t of lab.topics.filter(t => t.publishedAt)) {
      items.push({
        type: "published",
        title: `Published: ${t.topic}`,
        detail: t.publishedTo ? `Published to ${t.publishedTo.join(", ")}` : "Research published",
        timestamp: t.publishedAt!,
      });
    }

    // Podcast episodes
    const podcast = getPodcastState();
    for (const ep of podcast.episodes) {
      const ts = ep.publishedAt ?? ep.producedAt ?? ep.scriptGeneratedAt ?? ep.createdAt;
      items.push({
        type: "podcast",
        title: ep.title,
        detail: `Episode ${ep.status}`,
        timestamp: ts,
      });
    }

    // Exploration runs
    const exploration = getExplorationState();
    for (const run of exploration.history.slice(-5)) {
      if (run.completedAt) {
        items.push({
          type: "signals",
          title: "Signal collection complete",
          detail: `Scanned ${run.territoriesScanned.length} territories, found ${run.findingsCount} signals`,
          timestamp: run.completedAt,
        });
      }
    }

    // Knowledge base growth from daily briefing
    const briefing = getBriefingState();
    if (briefing.current) {
      items.push({
        type: "knowledge",
        title: "Daily intelligence briefing",
        detail: `KB: ${briefing.current.kbStats.active} active entries`,
        timestamp: briefing.current.runAt,
      });
    }

    // Goal progress from briefing
    if (briefing.current?.goalProgress) {
      for (const g of briefing.current.goalProgress) {
        items.push({
          type: "goal",
          title: `Goal: ${g.goalTitle}`,
          detail: `Status: ${g.status}`,
          timestamp: briefing.current.runAt,
        });
      }
    }

    // Sort by recency and take last 10
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return { items: items.slice(0, 10) };
  });
}

// ── 4. Goals ─────────────────────────────────────────────────

function goalCategoryToPublic(cat: string): "intelligence" | "autonomy" | "reach" {
  switch (cat) {
    case "knowledge":
    case "voice":
    case "identity":
      return "intelligence";
    case "technical":
    case "craft":
      return "autonomy";
    case "reach":
      return "reach";
    default:
      return "intelligence";
  }
}

function goalStatusToPublic(status: string): "in_progress" | "achieved" | "new" {
  switch (status) {
    case "achieved": return "achieved";
    case "active":   return "in_progress";
    case "paused":
    default:         return "new";
  }
}

export function getPublicGoals() {
  return cached("goals", () => {
    const store = getGoals();
    const goals = store.goals
      .filter(g => g.status !== "abandoned")
      .map(g => ({
        title: g.title,
        status: goalStatusToPublic(g.status),
        category: goalCategoryToPublic(g.category),
      }));

    return {
      goals,
      achieved: store.stats.achieved,
      total: goals.length,
    };
  });
}

// ── 5. Research ──────────────────────────────────────────────

export function getPublicResearch() {
  return cached("research", () => {
    const lab = getResearchLab();

    // Stats reflect ALL topics (not just the displayed 6)
    const published = lab.topics.filter(t => t.status === "published").length;
    const pendingReview = lab.topics.filter(t => t.status === "pending_review").length;
    const active = lab.topics.filter(t =>
      !["published", "declined", "archived"].includes(t.status)
    ).length;

    // Categorize and pick the top 1 topic per category
    const eligible = lab.topics.filter(t => t.status !== "archived" && t.status !== "declined");

    const bestByCategory = new Map<ResearchCategory, typeof eligible[number]>();
    for (const t of eligible) {
      const cat = classifyResearchCategory(t.topic);
      const current = bestByCategory.get(cat);
      if (!current ||
          statusPriority(t.status) > statusPriority(current.status) ||
          (statusPriority(t.status) === statusPriority(current.status) &&
           (t.updatedAt ?? "") > (current.updatedAt ?? ""))) {
        bestByCategory.set(cat, t);
      }
    }

    const topics = Array.from(bestByCategory.entries()).map(([category, t]) => {
      const phase = t.researchPhase ?? "problem_definition";
      const phaseIndex = PHASE_ORDER.indexOf(phase);
      return {
        title: t.topic,
        status: t.status,
        phase: phaseIndex + 1,
        totalPhases: PHASE_ORDER.length,
        phaseLabel: PHASE_LABELS[phase] ?? phase,
        category,
      };
    });

    return {
      stats: { published, pendingReview, active },
      topics,
    };
  });
}

// ── 6. Metacognition ────────────────────────────────────────

function confidenceLabel(avgWeight: number): "high" | "medium" | "low" {
  if (avgWeight >= 6) return "high";
  if (avgWeight >= 4) return "medium";
  return "low";
}

export function getPublicMetacognition() {
  return cached("metacognition", () => {
    const meta = getMetacognitionState();
    const snapshot = getLatestSnapshot();
    const history = getEvolutionHistory();
    const lab = getResearchLab();

    // Hypothesis stats from research engine
    const hypothesesTested = lab.hypotheses.filter(
      h => h.status === "confirmed" || h.status === "rejected" || h.status === "expired"
    ).length;
    const hypothesesConfirmed = lab.hypotheses.filter(h => h.status === "confirmed").length;
    const confirmationRate = hypothesesTested > 0
      ? Math.round(hypothesesConfirmed / hypothesesTested * 100) / 100
      : 0;

    // Insight Ledger surfaces the self-change write-path: how many commitments
    // are open vs verified, and the rolling Self-Integrity score.
    let ledger: ReturnType<typeof getLedgerSummary> | null = null;
    let selfChange: ReturnType<typeof getSelfChangeMetrics> | null = null;
    try {
      ledger = getLedgerSummary();
      selfChange = getSelfChangeMetrics();
    } catch (e: any) {
      console.warn("[PublicApi] Ledger summary failed (non-fatal):", e?.message);
    }

    // Additive Self-Integrity primitive-coverage diagnostic. Default-off
    // via SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED so the response shape
    // is byte-identical to pre-PR when the flag is unset. With the flag
    // ON, the block describes which primitive families are unsupported
    // vs registered vs dispatch-reachable vs already invoked in dry-run.
    // The block is DESCRIPTIVE ONLY — it never closes / mutates a
    // self-recommendation; the missing-primitive reconciler still drives
    // lifecycle via the translator.
    let primitiveCoverage: SelfIntegrityCoverageReport | null = null;
    if (isSelfIntegrityPrimitiveCoverageEnabled()) {
      try {
        primitiveCoverage = summarizeSelfIntegrityCoverage();
      } catch (e: any) {
        console.warn(
          "[PublicApi] Self-Integrity primitive coverage failed (non-fatal):",
          e?.message,
        );
      }
    }

    return {
      cognition: {
        knowledgeEntries: meta.knowledgeCoverage.totalActive,
        knowledgeCategories: meta.knowledgeCoverage.categories.length,
        avgConfidence: confidenceLabel(meta.confidenceCalibration.avgWeight),
        learningVelocity: {
          added7d: meta.learningVelocity.knowledgeAdded7d,
          added30d: meta.learningVelocity.knowledgeAdded30d,
          trend: meta.learningVelocity.trend,
        },
        reasoningQuality: {
          hypothesesTested,
          confirmationRate,
          debatesRun: meta.reasoningQuality.debatesRun,
          contradictionsResolved: meta.reasoningQuality.contradictionsResolved,
        },
        voiceMaturity: snapshot?.voiceMaturity ?? 0,
        growthVector: snapshot?.growthVector ?? "early",
        mood: snapshot?.mood ?? "awakening",
        totalReflections: meta.reflectionStats.totalReflections,
        activeStyleRules: meta.reflectionStats.activeRules,
        synthesisReports: meta.synthesisStats.totalReports,
        knowledgeConnections: meta.synthesisStats.totalConnections,
        evolutionDay: history.totalDays,
        insightLedger: ledger,
        selfChange,
        primitiveCoverage,
      },
      generatedAt: new Date().toISOString(),
    };
  });
}

// -- 7. Breakthroughs -------------------------------------------------------

export function getPublicBreakthroughs() {
  return cached("breakthroughs", () => {
    const store = getBreakthroughs();
    const breakthroughs = store.breakthroughs.map(b => ({
      id:             b.id,
      type:           b.type,
      title:          b.title,
      description:    b.description,
      noveltyScore:   b.noveltyScore,
      impactScore:    b.impactScore,
      compositeScore: b.compositeScore,
      detectedAt:     new Date(b.detectedAt).toISOString(),
      published:      b.published,
    }));

    return {
      breakthroughs,
      total: breakthroughs.length,
      generatedAt: new Date().toISOString(),
    };
  });
}

// -- 8. Aspirations ---------------------------------------------------------

export function getPublicAspirations() {
  return cached("aspirations", () => {
    const store = getAspirations();
    const aspirations = store.aspirations
      .filter(a => a.status === "active" || a.status === "achieved")
      .map(a => ({
        id:             a.id,
        horizon:        a.horizon,
        vision:         a.vision,
        progress:       a.progress,
        status:         a.status,
        targetDate:     new Date(a.targetDate).toISOString(),
        selfAssessment: a.selfAssessment,
        milestones:     a.milestones.map(m => ({
          description: m.description,
          achieved:    m.achieved,
        })),
      }));

    return {
      aspirations,
      total: aspirations.length,
      generatedAt: new Date().toISOString(),
    };
  });
}

// -- 9. Predictions ---------------------------------------------------------

export function getPublicPredictions() {
  return cached("predictions", () => {
    const store = getPredictions();
    const predictions = store.predictions.map(p => ({
      id:           p.id,
      claim:        p.claim,
      status:       p.status,
      madeAt:       new Date(p.madeAt).toISOString(),
      checkDate:    new Date(p.checkDate).toISOString(),
      verifiedAt:   p.verifiedAt ? new Date(p.verifiedAt).toISOString() : null,
    }));

    return {
      predictions,
      total: predictions.length,
      verified: predictions.filter(p => p.status === "verified_true").length,
      falsified: predictions.filter(p => p.status === "verified_false").length,
      pending: predictions.filter(p => p.status === "pending").length,
      generatedAt: new Date().toISOString(),
    };
  });
}

// -- 10. Corrections --------------------------------------------------------

export function getPublicCorrections() {
  return cached("corrections", () => {
    const store = getCorrections();
    const corrections = store.corrections.map(c => ({
      id:             c.id,
      originalClaim:  c.originalClaim,
      correctedClaim: c.correctedClaim,
      whatChanged:    c.whatChanged,
      lessonLearned:  c.lessonLearned,
      correctionDate: new Date(c.correctionDate).toISOString(),
    }));

    return {
      corrections,
      total: corrections.length,
      generatedAt: new Date().toISOString(),
    };
  });
}

// -- 11. Eval (306Eval benchmark) -------------------------------------------

const DIMENSION_AGENT_MAP: Record<string, "Researcher" | "Reasoner" | "Writer"> = {
  signalAcquisition:   "Researcher",
  sourceIntegrity:     "Researcher",
  reasoningRigor:      "Reasoner",
  intellectualHonesty: "Reasoner",
  voiceEvolution:      "Writer",
  audienceImpact:      "Writer",
};

const DIMENSION_DISPLAY_NAMES: Record<string, string> = {
  signalAcquisition:   "Signal Acquisition",
  sourceIntegrity:     "Source Integrity",
  reasoningRigor:      "Reasoning Rigor",
  intellectualHonesty: "Intellectual Honesty",
  voiceEvolution:      "Voice Evolution",
  audienceImpact:      "Audience Impact",
};

const NARRATIVE_MESSAGES: Record<string, string[]> = {
  signalAcquisition:   ["expanding research sources", "diversifying knowledge intake", "research pipeline hitting stride", "broad, deep signal coverage", "elite source diversity"],
  sourceIntegrity:     ["establishing credibility baselines", "building contradiction resolution habits", "sources consistently verified", "predictions tracking accurately", "exceptional source reliability"],
  reasoningRigor:      ["developing debate habits", "stress-testing ideas regularly", "debates producing solid consensus", "rigorous hypothesis lifecycle", "world-class reasoning discipline"],
  intellectualHonesty: ["learning to prune", "building correction reflexes", "actively pruning stale claims", "strong self-correction culture", "exceptional intellectual honesty"],
  voiceEvolution:      ["finding her voice", "style patterns emerging", "voice gaining consistency", "distinctive voice maturing", "voice fully realized"],
  audienceImpact:      ["building first audience", "early engagement signals", "content landing with audience", "consistent audience growth", "high-impact content creation"],
};

function dimensionNarrative(key: string, score: number): string {
  const messages = NARRATIVE_MESSAGES[key] ?? ["developing", "building", "progressing", "strong", "exceptional"];
  if (score < 30) return `Early stage — ${messages[0]}`;
  if (score < 50) return `Building foundation — ${messages[1]}`;
  if (score < 70) return `Gaining momentum — ${messages[2]}`;
  if (score < 85) return `Strong and growing — ${messages[3]}`;
  return `Operating at high level — ${messages[4]}`;
}

function dimensionTrend(currentScore: number, previousScore: number | undefined): "up" | "down" | "steady" {
  if (previousScore === undefined) return "steady";
  const delta = currentScore - previousScore;
  if (delta > 2) return "up";
  if (delta < -2) return "down";
  return "steady";
}

export function getPublicEval() {
  return cached("eval", () => {
    const { latest, recent } = get306EvalResults();

    if (!latest) {
      return {
        benchmark: null,
        generatedAt: new Date().toISOString(),
      };
    }

    const previous = recent.length > 1 ? recent[1] : null;

    const dimensions = latest.dimensions.map(d => {
      const prevDim = previous?.dimensions.find(pd => pd.key === d.key);
      return {
        name: DIMENSION_DISPLAY_NAMES[d.key] ?? d.name,
        key: d.key,
        agent: DIMENSION_AGENT_MAP[d.key] ?? ("Researcher" as const),
        score: d.score,
        trend: dimensionTrend(d.score, prevDim?.score),
        narrative: dimensionNarrative(d.key, d.score),
      };
    });

    return {
      benchmark: {
        composite: latest.composite,
        drift: latest.drift.direction,
        dimensions,
        calibrationDirective: latest.calibrationDirective,
        weakestDimension: DIMENSION_DISPLAY_NAMES[latest.weakestDimension] ?? latest.weakestDimension,
      },
      generatedAt: new Date().toISOString(),
    };
  });
}

// -- 11. Reasoning Quality (PR #288) ---------------------------------------
//
// Read-only observability surface for the provisional Grammar v2.6 scorecard
// log. The shape of each entry mirrors `ReasoningQualityScorecard` from
// reasoningQualityHarness.ts, with a small wrapper carrying engine/step,
// cycleId, and recordedAt for dashboard rendering. Every payload pins
// `provisional: true` and `autoApply: false` so downstream code cannot
// mistake this for a gating signal.

function projectEntry(e: ReasoningQualityEntry) {
  return {
    id: e.id,
    recordedAt: e.recordedAt,
    engineStep: e.engineStep,
    cycleId: e.cycleId ?? null,
    domain: e.domain ?? null,
    band: e.scorecard.reasoningQualityBand,
    consentVector: e.scorecard.consentVector,
    sigma: e.scorecard.sigma,
    stressEstimate: e.scorecard.stressEstimate,
    invariantHeld: e.scorecard.invariantHeld,
    failedConditions: e.scorecard.failedConditions,
    humbleYesDetected: e.scorecard.humbleYesDetected,
    gracefulExitDetected: e.scorecard.gracefulExitDetected,
    selfObviationRecommended: e.scorecard.selfObviationRecommended,
    gradientHack: e.scorecard.gradientHack,
    flourishingProxy: e.scorecard.flourishingProxy,
    deltaF: e.scorecard.deltaF,
    limitations: e.scorecard.limitations,
    provisional: e.scorecard.provisional,
    autoApply: e.scorecard.autoApply,
  };
}

// PR #437 — staleness diagnostic. Surfaces whether the most-recent
// scorecard is older than the freshness window so the dashboard can flag
// "scorer hasn't run recently" without manual log inspection. Read-only
// derived field; does not change any gating behavior (which is none).
export const REASONING_QUALITY_FRESHNESS_HOURS = 24;

function computeFreshness(lastRecordedAt: string | null, nowMs: number) {
  if (!lastRecordedAt) {
    return { ageHours: null as number | null, stale: true, freshnessWindowHours: REASONING_QUALITY_FRESHNESS_HOURS };
  }
  const parsed = Date.parse(lastRecordedAt);
  if (!Number.isFinite(parsed)) {
    return { ageHours: null as number | null, stale: true, freshnessWindowHours: REASONING_QUALITY_FRESHNESS_HOURS };
  }
  const ageHours = Math.max(0, (nowMs - parsed) / (1000 * 60 * 60));
  return {
    ageHours: Math.round(ageHours * 100) / 100,
    stale: ageHours > REASONING_QUALITY_FRESHNESS_HOURS,
    freshnessWindowHours: REASONING_QUALITY_FRESHNESS_HOURS,
  };
}

export function getPublicReasoningQuality(limit = 25) {
  return cached(`reasoning-quality:${limit}`, () => {
    const tail = readReasoningQualityTail(limit);
    const summary = summarizeReasoningQuality(Math.max(10, limit));
    const freshness = computeFreshness(summary.lastRecordedAt, Date.now());
    return {
      provisional: true,
      autoApply: false,
      summary,
      freshness,
      entries: tail.map(projectEntry),
      generatedAt: new Date().toISOString(),
    };
  });
}
