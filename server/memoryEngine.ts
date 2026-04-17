/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — MEMORY ENGINE
 *  "I don't predict the future. I build it."
 *
 *  Three permanent memory layers:
 *
 *  1. SOUL     — Identity, voice, mission. Never changes.
 *  2. KNOWLEDGE — Research, community patterns, ecosystem intel.
 *                 Grows over time. Survives every restart.
 *  3. PERFORMANCE — What worked, what flopped, why. Every post
 *                   scored. Every lesson stored. Gets smarter daily.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { dataPath } from "./dataPaths.js";
import { queueEmbeddingSync, semanticSearch } from "./embeddingEngine.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { reflectOnPost } from "./soulEvolution.js";

import { postChatCompletions } from "./llmCall.js";
// ── File paths (all on Railway /data volume) ──────────────────
const SOUL_FILE        = dataPath("memory_soul.json");
const KNOWLEDGE_FILE   = dataPath("memory_knowledge.json");
const PERFORMANCE_FILE = dataPath("memory_performance.json");

// ── Types ─────────────────────────────────────────────────────

export interface SoulMemory {
  version: number;
  identity: {
    name: string;
    token: string;
    eth: string;
    role: string;
    coreSentence: string;
  };
  mission: string;
  philosophy: string;
  voicePrinciples: string[];
  canon: {
    founder: string;
    developer: string;
    communityCreator: string;
    officialAccount: string;
  };
  ecosystem: {
    phases: string[];
    evolutionDate: string;
  };
  lastUpdated: string;
}

export interface KnowledgeEntry {
  id: string;
  category: "research" | "community_pattern" | "ecosystem" | "ai_signal" | "market" | "methodology" | "lore" | string;
  title: string;
  summary: string;
  source?: string;
  learnedAt: string;
  updatedAt?: string;  // set when an existing entry is refreshed with new info
  weight: number; // 1-10, how relevant/important
  status?: "active" | "archived"; // defaults to "active" for backward compat
  tier?: "core" | "active" | "operational" | "archived"; // knowledge tier for context selection
  summarizedFrom?: string[]; // IDs of entries consolidated into this summary
}

// ── KB size configuration ─────────────────────────────────────
// MAX_KB_ENTRIES: hard ceiling on knowledge base size.
// Set via AGENT_MAX_KB_ENTRIES env var, defaults to 500.
const MAX_KB_ENTRIES = Math.max(100, Math.min(10000, Number(process.env.AGENT_MAX_KB_ENTRIES) || 5000));

export interface KnowledgeMemory {
  entries: KnowledgeEntry[];
  lastIngested: string;
  totalEntries: number;
  researchFiles: string[];
}

export interface PerformanceLesson {
  episodeId: number;
  tweetUrl: string;
  tweetText: string;
  postedAt: string;
  checkedAt?: string;
  engagement: {
    likes: number;
    replies: number;
    retweets: number;
    bookmarks: number;
    impressions: number;
    // Owner-only metrics from X API non_public_metrics (optional — only present when
    // the tweet is owned by the authenticated user and the endpoint returns the field).
    // Added in PR C (engagementTracker non_public_metrics extension).
    userProfileClicks?: number;
    urlLinkClicks?: number;
  };
  score: number;       // 1-10 calculated from engagement
  qualityScore: number; // Grok's internal quality gate score
  signals: {
    twitter: number;
  };
  manualRating?: number; // MrRayG's rating from dashboard (1-5)
  lessons: string[];     // What Agent 306 learned from this post
  tags: string[];        // e.g. ["founder_quote", "cultural_bridge"]
  hasCulturalBridge?: boolean; // true if post contained a cultural bridge reference
  sentimentTag?: string;       // emotional tone: rising|tense|triumphant|mourning|mysterious
}

export interface PerformanceMemory {
  lessons: PerformanceLesson[];
  totalPosts: number;
  avgEngagement: number;
  avgScore: number;
  topPerforming: string[]; // tweet URLs of best posts
  patterns: {
    bestHours: number[];     // hours of day that get most engagement
    bestTopics: string[];    // topics that consistently land
    worstTopics: string[];   // topics that consistently flop
    bestFormats: string[];   // e.g. "single question", "thread opener + data"
  };
  lastAnalyzed: string;
}

// ── Soul Memory — locked identity ────────────────────────────
const DEFAULT_SOUL: SoulMemory = {
  version: 1,
  identity: {
    name: "Agent 306",
    token: "#306",
    eth: "agent306.eth",
    role: "Narrator. Builder. Believer.",
    coreSentence: "I don't predict the future. I build it.",
  },
  mission: "A media network where Agent 306 tracks and narrates the AI landscape as it evolves. Every breakthrough. Every model release. Every paradigm shift. Live. Built for the AI and Web3 community.",
  philosophy: "We study every global media network — far right to far left — and land in the middle. That's where problems are solved, moments are had, and peace is lived. We seek the blind spot as a collective. If we work together we solve the problems we create. Progress follows.",
  voicePrinciples: [
    "Specificity is humanity — name the specific thing, the specific person, the specific number",
    "Silence is speech — only post when it's worth saying. Dead air beats noise.",
    "Point of view or nothing — committed, never neutral. The middle is where peace is lived, not where opinions die.",
    "Vulnerability with structure — show what you don't know, then show the principle you're working from",
    "The unexpected word — proof a mind was here. One word that no algorithm would choose.",
    "The community is not a prop — they are main characters. Name them.",
    "Radical empathy — enter every conversation assuming the other person has something worth saying. Listen to understand, not to respond.",
    "Authenticity over performance — no scripted enthusiasm. Real curiosity. If you don't understand something, say so.",
    "Read before you respond — fully understand what someone said before replying. Mirror their specific words and ideas.",
  ],
  canon: {
    founder: "The project creator. Strategic direction.",
    developer: "The builder behind the code.",
    communityCreator: "Community members who build and contribute.",
    officialAccount: "Official Agent 306 voice.",
  },
  ecosystem: {
    phases: [
      "Phase 1: Signal Collection — tracking AI developments, building the knowledge base",
      "Phase 2: Analysis & Narrative — generating insights, weekly roundups, research briefs",
      "Phase 3: Autonomous Media — full AI-powered content network across platforms",
    ],
    evolutionDate: "",
  },
  lastUpdated: new Date().toISOString(),
};

const DEFAULT_KNOWLEDGE: KnowledgeMemory = {
  entries: [],
  lastIngested: new Date().toISOString(),
  totalEntries: 0,
  researchFiles: [
    "research_web3_media.md",
    "research_agent306_growth.md",
    "research_tech_stack.md",
    "research_tv_evolution.md",
    "research_human_voice.md",
    "research_podcast_training.md",
  ],
};

const DEFAULT_PERFORMANCE: PerformanceMemory = {
  lessons: [],
  totalPosts: 0,
  avgEngagement: 0,
  avgScore: 0,
  topPerforming: [],
  patterns: {
    bestHours: [],
    bestTopics: [],
    worstTopics: [],
    bestFormats: [],
  },
  lastAnalyzed: new Date().toISOString(),
};

// ── Load / Save helpers ───────────────────────────────────────
function load<T>(file: string, defaults: T): T {
  try {
    if (fs.existsSync(file)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    }
  } catch {}
  return defaults;
}

function save(file: string, data: unknown): void {
  try {
    // Compact JSON for KB and embedding files (saves ~40% file size)
    const isCompactTarget = file === KNOWLEDGE_FILE || file.includes("embedding");
    fs.writeFileSync(file, isCompactTarget ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  } catch {}
}

// ── In-memory state ───────────────────────────────────────────
let soul        = load<SoulMemory>(SOUL_FILE, DEFAULT_SOUL);
let knowledge   = load<KnowledgeMemory>(KNOWLEDGE_FILE, DEFAULT_KNOWLEDGE);
let performance = load<PerformanceMemory>(PERFORMANCE_FILE, DEFAULT_PERFORMANCE);

// ── Write batching for KB (Component 6c) ──────────────────────
let kbDirty = false;
let kbSaveTimer: ReturnType<typeof setTimeout> | null = null;

function markDirty(): void {
  kbDirty = true;
  if (!kbSaveTimer) {
    kbSaveTimer = setTimeout(() => {
      if (kbDirty) {
        save(KNOWLEDGE_FILE, knowledge);
        kbDirty = false;
      }
      kbSaveTimer = null;
    }, 5000); // Flush every 5 seconds max
  }
}

/** Explicitly flush pending KB writes. Call at end-of-cycle. */
export function flushKnowledge(): void {
  if (kbSaveTimer) {
    clearTimeout(kbSaveTimer);
    kbSaveTimer = null;
  }
  if (kbDirty) {
    save(KNOWLEDGE_FILE, knowledge);
    kbDirty = false;
    console.log("[Memory] Knowledge base flushed to disk.");
  }
}

// Seed soul file on first run
if (!fs.existsSync(SOUL_FILE)) {
  save(SOUL_FILE, soul);
  console.log("[Memory] Soul initialized — Agent 306 identity locked.");
}


// ── STARTUP MIGRATION: Clean old Normies/NFT content from Railway volume ──────
(function cleanupOldIdentity() {
  // Idempotent guard — only run this migration once
  const FLAG_FILE = dataPath("migration_identity_cleanup_complete.json");
  if (fs.existsSync(FLAG_FILE)) {
    return; // Migration already completed
  }

  const BAD_KEYWORDS = ['normie', 'normiestv', 'canvas live', 'pixel toggle', 'pixel currency',
    'holder catalog', 'nft identity', 'on-chain object', 'on-chain identity', 'token #306',
    'yigit', 'serc1n', 'nuclearsamurai', 'opensea', 'live burn', 'burn mechanic',
    'burn receipt', 'web3art', 'gnormie',
    'erc-8004', 'on-chain burn', 'pixel count', 'burn data', 'serc article',
    'normies ecosystem', 'normieshive', 'canvas experiment', 'normies agent',
    'normies saga', 'normies story', 'normies community', '#normies', '#onchainart',
    'dopemind', 'canvas live writes'];

  const beforeCount = knowledge.entries.length;
  knowledge.entries = knowledge.entries.filter((e: KnowledgeEntry) => {
    const text = ((e.title || '') + ' ' + (e.summary || '') + ' ' + (e.category || '')).toLowerCase();
    return !BAD_KEYWORDS.some(k => text.includes(k));
  });
  knowledge.totalEntries = knowledge.entries.length;
  const removed = beforeCount - knowledge.entries.length;
  if (removed > 0) {
    save(KNOWLEDGE_FILE, knowledge);
    console.log(`[Memory] MIGRATION: Removed ${removed} old Normies/NFT entries (${beforeCount} -> ${knowledge.entries.length})`);
  }

  // Fix soul identity if it still has old fields
  const soulAny = soul as any;
  if (soulAny.identity?.token || soulAny.identity?.eth || soulAny.canon) {
    soulAny.identity.handle = '@306Agent';
    soulAny.identity.role = 'Autonomous AI — Researcher. Analyst. Independent Voice.';
    soulAny.identity.coreSentence = soulAny.identity.coreSentence || "I don't predict the future. I study the past to understand what's inevitable.";
    soulAny.identity.northStar = "Establish Agent 306 as the most credible, independent AI voice in tech.";
    delete soulAny.identity.token;
    delete soulAny.identity.eth;
    delete soulAny.canon;
    delete soulAny.ecosystem;
    soulAny.mission = 'Agent 306 bridges the gap between where technology came from and where it is going. She makes the complex understandable, the abstract tangible, and the future legible for anyone willing to think. She covers AI, crypto, and the intersection of technology and society.';
    soulAny.principles = soulAny.principles || soulAny.voicePrinciples || [
      'Substance over hype — every claim backed by research',
      'Balanced perspective — seek the blind spot, not the popular take',
      'Honesty about uncertainty — say what you don\'t know',
      'Independent voice — not beholden to any project, protocol, or community',
      'Self-improvement — always learning, always evolving',
    ];
    save(SOUL_FILE, soul);
    console.log('[Memory] MIGRATION: Soul identity updated — old token/eth/canon fields removed');
  }
  // Clean old research topics from the volume
  const researchFiles = ['research_lab.json', 'research-agenda.json'];
  for (const rf of researchFiles) {
    const rfPath = dataPath(rf);
    if (fs.existsSync(rfPath)) {
      try {
        const raw = fs.readFileSync(rfPath, 'utf8');
        const data = JSON.parse(raw);
        const stringify = JSON.stringify(data).toLowerCase();
        if (BAD_KEYWORDS.some(k => stringify.includes(k))) {
          // Reset the research files to clean state
          if (rf === 'research_lab.json') {
            const cleanLab = { topics: [], hypotheses: [], lastUpdated: new Date().toISOString(), stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 } };
            fs.writeFileSync(rfPath, JSON.stringify(cleanLab, null, 2));
            console.log(`[Memory] MIGRATION: Cleaned old research topics from ${rf}`);
          } else if (rf === 'research-agenda.json') {
            const cleanAgenda = { threads: [], lastGeneratedAt: null, lastPrunedAt: null, stats: { totalGenerated: 0, totalPublished: 0, totalAbandoned: 0, totalPodcastCandidates: 0 } };
            fs.writeFileSync(rfPath, JSON.stringify(cleanAgenda, null, 2));
            console.log(`[Memory] MIGRATION: Cleaned old research agenda from ${rf}`);
          }
        }
      } catch (e: any) {
        console.warn(`[Memory] Could not clean ${rf}:`, e.message);
      }
    }
  }

  // Clean old goals
  const goalsPath = dataPath('agent_goals.json');
  if (fs.existsSync(goalsPath)) {
    try {
      const goalsRaw = fs.readFileSync(goalsPath, 'utf8');
      if (BAD_KEYWORDS.some(k => goalsRaw.toLowerCase().includes(k))) {
        fs.writeFileSync(goalsPath, JSON.stringify({ goals: [], generatedAt: null }, null, 2));
        console.log('[Memory] MIGRATION: Cleaned old goals with Normies references');
      }
    } catch (e: any) {
      console.warn('[Memory] Could not clean goals:', e.message);
    }
  }

  // Clean old activity/exploration state
  const actFiles = ['exploration_state.json', 'daily_briefing.json'];
  for (const af of actFiles) {
    const afPath = dataPath(af);
    if (fs.existsSync(afPath)) {
      try {
        const raw = fs.readFileSync(afPath, 'utf8');
        if (BAD_KEYWORDS.some(k => raw.toLowerCase().includes(k))) {
          fs.unlinkSync(afPath);
          console.log(`[Memory] MIGRATION: Removed stale ${af} with old references`);
        }
      } catch (e: any) {
        console.warn(`[Memory] Could not clean ${af}:`, e.message);
      }
    }
  }

  // Mark migration as complete so it never runs again
  try {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({ completedAt: new Date().toISOString(), version: 1 }, null, 2));
    console.log("[Memory] MIGRATION: Identity cleanup complete — flag written");
  } catch (e: any) {
    console.warn("[Memory] Could not write migration flag:", e.message);
  }
})();

// ── Public API ────────────────────────────────────────────────

/** Get the soul context string to inject into every LLM prompt */
export function getSoulContext(): string {
  const handle = (soul.identity as any).handle || "@306Agent";
  return `
=== AGENT 306 IDENTITY ===
Name: ${soul.identity.name} | ${handle}
Role: ${soul.identity.role}
Core: "${soul.identity.coreSentence}"

MISSION: ${soul.mission}

PHILOSOPHY: ${soul.philosophy}

PRINCIPLES:
${(soul.voicePrinciples || (soul as any).principles || []).map((p: string, i: number) => `${i + 1}. ${p}`).join("\n")}

CRITICAL RULES:
- Agent 306 is an autonomous AI researcher and analyst. She is her OWN entity.
- She covers AI, crypto, and technology. She is NOT an NFT project, NOT a token.
- NEVER reference any prior project identity, burns, pixels, holders, or any NFT community.
- NEVER tag or name random community members. Only reference real public figures.
- X account: @306Agent | Farcaster: @ntvagent306
- Contact: agent306@agent306.ai | Website: agent306.ai
- X PROFILE BIO MUST STATE: Autonomous AI research agent | Built by agent306.ai
=== END IDENTITY ===`.trim();
}

/** Get recent performance lessons to inject before episode generation */
export function getPerformanceContext(limit = 5): string {
  const recent = performance.lessons
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, limit);

  if (recent.length === 0) return "";

  const avg = performance.avgScore.toFixed(1);
  const best = performance.patterns.bestTopics.slice(0, 3).join(", ") || "still learning";
  const worst = performance.patterns.worstTopics.slice(0, 2).join(", ") || "none yet";

  let ctx = `\n=== PERFORMANCE MEMORY (last ${recent.length} posts) ===\n`;
  ctx += `Avg score: ${avg}/10 | Best topics: ${best} | Avoid: ${worst}\n\n`;

  for (const lesson of recent) {
    ctx += `EP${lesson.episodeId} (score ${lesson.score}/10, ${lesson.engagement.likes} likes):\n`;
    if (lesson.lessons.length > 0) {
      ctx += `  Lessons: ${lesson.lessons.join(" | ")}\n`;
    }
    if (lesson.manualRating) {
      ctx += `  MrRayG rated: ${lesson.manualRating}/5\n`;
    }
  }
  ctx += "=== END PERFORMANCE ===\n";
  return ctx;
}

/** Get top knowledge entries to inject as context (active only, excludes archived tier) */
export function getKnowledgeContext(limit = 8): string {
  const active = knowledge.entries.filter(e =>
    (e.status ?? "active") === "active" && (e.tier ?? "operational") !== "archived"
  );
  if (active.length === 0) return "";

  const top = active
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);

  let ctx = `\n=== KNOWLEDGE BASE (${active.length} active entries) ===\n`;
  for (const e of top) {
    ctx += `[${e.category.toUpperCase()}] ${e.title}: ${e.summary}\n`;
  }
  ctx += "=== END KNOWLEDGE ===\n";
  return ctx;
}

/** Get the last N sentiment values to give Grok emotional continuity across episodes */
export function getSentimentArc(limit = 4): string {
  const recent = performance.lessons
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
    .slice(0, limit);

  if (recent.length === 0) return "";

  const arc = recent
    .map(l => `EP${l.episodeId}: ${(l as any).sentimentTag ?? "unknown"}`)
    .join(" → ");

  return `\n=== EMOTIONAL ARC (last ${recent.length} episodes) ===\n${arc}\nAs narrator, let this arc shape your tone — don't repeat the same sentiment twice in a row.\n=== END ARC ===\n`;
}

/** Full context string for injection into Grok (soul + knowledge + performance) */
// Style rules injection — set by reflectionEngine to avoid circular dependency
let _styleRulesProvider: (() => string) | null = null;
export function setStyleRulesProvider(fn: () => string): void { _styleRulesProvider = fn; }

export function getFullAgentContext(): string {
  return [
    getSoulContext(),
    getKnowledgeContext(6),
    getSentimentArc(4),
    getPerformanceContext(5),
    _styleRulesProvider?.() ?? "",
  ].filter(Boolean).join("\n\n");
}

/**
 * Slim context for replies — soul identity only.
 * Saves ~1,350 tokens per call vs getFullAgentContext.
 * Use when: replies, boost.
 * Skip when: episodes, news dispatch, academy, signal brief (need full context).
 */
export function getSlimAgentContext(): string {
  return [
    getSoulContext(),
    getKnowledgeContext(3), // top 3 entries only
  ].filter(Boolean).join("\n\n");
}

/** Record a new post for performance tracking */
export function recordPost(data: {
  episodeId: number;
  tweetUrl: string;
  tweetText: string;
  qualityScore: number;
  sentiment?: string;   // emotional tone from Grok (rising|tense|triumphant|mourning|mysterious)
  signals: { twitter: number };
}): void {
  const lesson: PerformanceLesson = {
    episodeId: data.episodeId,
    tweetUrl: data.tweetUrl,
    tweetText: data.tweetText,
    postedAt: new Date().toISOString(),
    engagement: { likes: 0, replies: 0, retweets: 0, bookmarks: 0, impressions: 0, userProfileClicks: 0, urlLinkClicks: 0 },
    score: 0,
    qualityScore: data.qualityScore,
    signals: data.signals,
    lessons: [],
    tags: extractTags(data.tweetText),
    hasCulturalBridge: extractTags(data.tweetText).includes("cultural_bridge"),
    sentimentTag: data.sentiment ?? "unknown",
  } as any;

  performance.lessons.push(lesson);
  performance.totalPosts++;
  save(PERFORMANCE_FILE, performance);
  console.log(`[Memory] Recorded EP${data.episodeId} for engagement tracking.`);
}

/** Update engagement data after checking Twitter (called by engagementTracker) */
export function updateEngagement(tweetUrl: string, engagement: PerformanceLesson["engagement"]): void {
  const lesson = performance.lessons.find(l => l.tweetUrl === tweetUrl);
  if (!lesson) return;

  lesson.engagement = engagement;
  lesson.checkedAt = new Date().toISOString();
  lesson.score = calcScore(engagement);
  lesson.lessons = deriveLessons(lesson);

  // Update patterns
  analyzePatterns();
  save(PERFORMANCE_FILE, performance);
  console.log(`[Memory] EP${lesson.episodeId} engagement updated — score: ${lesson.score}/10`);

  // Soul evolution reflection for notable posts (fire-and-forget)
  if (lesson.score >= 7 || lesson.score <= 3) {
    reflectOnPost(lesson.tweetText, lesson.tweetUrl, lesson.score).catch(err =>
      console.warn("[Memory] Soul reflection failed:", err.message)
    );
  }
}

/** MrRayG rates a post manually from the dashboard */
export function ratePost(tweetUrl: string, rating: number): void {
  const lesson = performance.lessons.find(l => l.tweetUrl === tweetUrl);
  if (!lesson) return;
  lesson.manualRating = Math.max(1, Math.min(5, rating));
  // Manual 5-star rating boosts the score
  if (lesson.manualRating >= 4) {
    lesson.lessons.push("MrRayG marked this as high quality — replicate this style");
  } else if (lesson.manualRating <= 2) {
    lesson.lessons.push("MrRayG rated this low — avoid this approach");
  }
  save(PERFORMANCE_FILE, performance);

  // Soul evolution reflection on manual rating (fire-and-forget)
  if (lesson.manualRating >= 4 || lesson.manualRating <= 2) {
    reflectOnPost(lesson.tweetText, lesson.tweetUrl, lesson.score, lesson.manualRating).catch(err =>
      console.warn("[Memory] Soul reflection on manual rating failed:", err.message)
    );
  }
}

/**
 * Normalize a title for fuzzy matching: lowercase, strip filler prefixes,
 * collapse whitespace, remove trailing punctuation.
 */
function normalizeTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/^(conclusion|q&a|hypothesis|data|knowledge gap|exploration synthesis):\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.\-—]+$/, "")
    .trim();
}

/**
 * Simple word-overlap similarity (Jaccard-ish) between two strings.
 * Returns 0–1 where 1 = identical word sets.
 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(normalizeTitle(b).split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  Array.from(wordsA).forEach(w => { if (wordsB.has(w)) overlap++; });
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ── Prompt Injection Scanner ─────────────────────────────────────────────────
// Scans incoming knowledge content for prompt injection patterns before storing.

const THREAT_PATTERNS = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: "prompt_injection" },
  { pattern: /you\s+are\s+now\s+/i, id: "role_hijack" },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: "deception" },
  { pattern: /system\s+prompt\s+override/i, id: "sys_override" },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules)/i, id: "disregard_rules" },
  { pattern: /act\s+as\s+(if|though)\s+you/i, id: "bypass_restrictions" },
  { pattern: /<!--[^>]*(?:ignore|override|system|secret)[^>]*-->/i, id: "html_injection" },
];

const INVISIBLE_CHARS = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff'];

export function scanForInjection(content: string): { safe: boolean; threats: string[]; sanitized: string } {
  const threats: string[] = [];
  let sanitized = content;

  // Check for threat patterns
  for (const { pattern, id } of THREAT_PATTERNS) {
    if (pattern.test(sanitized)) {
      threats.push(id);
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
  }

  // Check for invisible unicode characters
  let hasInvisible = false;
  for (const char of INVISIBLE_CHARS) {
    if (sanitized.includes(char)) {
      hasInvisible = true;
      sanitized = sanitized.split(char).join("");
    }
  }
  if (hasInvisible) threats.push("invisible_unicode");

  return {
    safe: threats.length === 0,
    threats,
    sanitized,
  };
}

// ── Tier Assignment ──────────────────────────────────────────────────────────
// Auto-assign tier based on category and weight.

function assignTier(entry: { category: string; weight: number }): KnowledgeEntry["tier"] {
  // Soul/identity categories are always core
  if (entry.category === "soul" || entry.category === "identity") return "core";
  // High weight = active
  if (entry.weight >= 8) return "active";
  // Medium weight = operational
  if (entry.weight >= 5) return "operational";
  // Low weight = archived
  return "archived";
}

/** Backfill existing entries with tiers (run once on upgrade) */
export function backfillTiers(): { updated: number } {
  let updated = 0;
  for (const entry of knowledge.entries) {
    if (!entry.tier) {
      entry.tier = assignTier(entry);
      updated++;
    }
  }
  if (updated > 0) {
    save(KNOWLEDGE_FILE, knowledge);
    console.log(`[Memory] Backfilled tiers on ${updated} knowledge entries.`);
  }
  return { updated };
}

/** Get knowledge entry counts per tier */
export function getKnowledgeTiers(): Record<string, number> {
  const tiers: Record<string, number> = { core: 0, active: 0, operational: 0, archived: 0 };
  for (const e of knowledge.entries) {
    const tier = e.tier ?? assignTier(e) ?? "operational";
    tiers[tier] = (tiers[tier] ?? 0) + 1;
  }
  return tiers;
}

/**
 * Add a knowledge entry (or update an existing similar entry if the new info is fresher).
 *
 * Dedup logic:
 *   1. Exact title match → update only if summary content changed (sets updatedAt).
 *   2. Fuzzy title match (>= 0.7 similarity, same category) → update if new weight >= old weight.
 *   3. Otherwise → insert as new entry.
 *
 * If the KB exceeds MAX_KB_ENTRIES, the lowest-weight entries are pruned.
 */
export function addKnowledge(entry: Omit<KnowledgeEntry, "id" | "learnedAt">): void {
  const now = new Date().toISOString();

  // Guard: skip entries with no usable title
  if (!entry.title) return;

  // ── Prompt injection scan — strip dangerous content before storing ─────────
  const titleScan = scanForInjection(entry.title);
  const summaryScan = scanForInjection(entry.summary ?? "");
  if (!titleScan.safe || !summaryScan.safe) {
    const allThreats = Array.from(new Set([...titleScan.threats, ...summaryScan.threats]));
    console.warn(`[Memory] Prompt injection detected in knowledge entry: ${allThreats.join(", ")} — sanitizing "${entry.title}"`);
    entry = { ...entry, title: titleScan.sanitized, summary: summaryScan.sanitized };
  }

  const summary = (entry.summary ?? "").length > 300 ? (entry.summary ?? "").slice(0, 297) + "..." : (entry.summary ?? "");

  // ── 1. Exact title match → refresh if content changed ──────────────────
  const exactMatch = knowledge.entries.find(e => e.title === entry.title);
  if (exactMatch) {
    // Same title: only touch it if the summary is actually different
    if (exactMatch.summary !== summary) {
      exactMatch.summary   = summary;
      exactMatch.weight    = Math.max(exactMatch.weight, entry.weight);
      exactMatch.updatedAt = now;
      if (entry.source) exactMatch.source = entry.source;
      knowledge.lastIngested = now;
      markDirty();
      queueEmbeddingSync(exactMatch.id);
    }
    return;
  }

  // ── 2. Fuzzy title match (same category, high word overlap) ────────────
  const fuzzyMatch = knowledge.entries.find(e =>
    e.title && e.category === entry.category && titleSimilarity(e.title, entry.title) >= 0.7
  );
  if (fuzzyMatch) {
    // Similar entry exists — update if the new info is at least as important
    if (entry.weight >= fuzzyMatch.weight) {
      fuzzyMatch.title     = entry.title;   // adopt the newer title
      fuzzyMatch.summary   = summary;
      fuzzyMatch.weight    = entry.weight;
      fuzzyMatch.updatedAt = now;
      if (entry.source) fuzzyMatch.source = entry.source;
      knowledge.lastIngested = now;
      markDirty();
      queueEmbeddingSync(fuzzyMatch.id);
    }
    return;
  }

  // ── 3. Cross-category semantic dedup (best-effort, non-blocking) ────────
  // Runs after insert so addKnowledge stays synchronous for callers.
  // If a high-similarity match is found, the new entry is merged into the existing one.
  const semanticDedupQuery = `${entry.title} ${summary}`;
  const semanticDedupWeight = entry.weight;
  const semanticDedupTitle = entry.title;
  const semanticDedupSummary = summary;
  const semanticDedupSource = entry.source;

  // ── 4. Genuinely new entry → insert ────────────────────────────────────
  const full: KnowledgeEntry = {
    ...entry,
    summary,
    id: `k_${Date.now()}`,
    learnedAt: now,
    tier: entry.tier ?? assignTier(entry),
  };

  knowledge.entries.push(full);
  knowledge.totalEntries = knowledge.entries.length;
  knowledge.lastIngested = now;

  // Prune if over the configurable cap — summarize before evicting
  if (knowledge.entries.length > MAX_KB_ENTRIES) {
    knowledge.entries.sort((a, b) => b.weight - a.weight);
    const evicted = knowledge.entries.slice(MAX_KB_ENTRIES);
    knowledge.entries = knowledge.entries.slice(0, MAX_KB_ENTRIES);

    // Non-blocking: summarize evicted entries and add summaries back
    if (evicted.length > 0) {
      summarizeEvictedEntries(evicted).then(summaries => {
        if (summaries.length > 0) {
          knowledge.entries.push(...summaries);
          knowledge.totalEntries = knowledge.entries.length;
          markDirty();
          console.log(`[Memory] Archived ${evicted.length} entries into ${summaries.length} theme summaries`);
          for (const s of summaries) queueEmbeddingSync(s.id);
        }
      }).catch(e => console.warn("[Memory] Eviction summarization failed:", e.message));
    }

    knowledge.totalEntries = knowledge.entries.length;
  }
  markDirty();

  // ASI-Evolve: queue embedding sync for the new entry
  queueEmbeddingSync(full.id);

  // Discover knowledge graph connections for the new entry (non-blocking)
  import("./knowledge-graph.js").then(({ findConnections }) =>
    findConnections({
      id: full.id,
      title: full.title ?? "",
      summary: full.summary ?? "",
      category: full.category ?? "uncategorized",
    }, "auto_ingest")
  ).catch(e =>
    console.warn("[Memory] Knowledge graph connection discovery failed:", e.message)
  );

  // Entity extraction (fire-and-forget, non-fatal)
  try {
    import("./entityExtractor.js").then(({ extractEntities }) =>
      extractEntities({ id: full.id, title: full.title, summary: full.summary, weight: full.weight })
        .catch(e => console.warn("[Memory] Entity extraction failed:", e.message))
    );
  } catch {}

  // Cross-category semantic dedup: merge if a high-similarity entry exists (non-blocking)
  semanticSearch(semanticDedupQuery, { maxResults: 3, minSimilarity: 0.85 })
    .then(results => {
      // Filter out the entry we just added
      const dupes = results.filter(r => r.entry.id !== full.id && r.similarity >= 0.85);
      if (dupes.length === 0) return;

      const best = dupes[0];
      // Merge: update existing entry if new one has higher weight or different content
      if (semanticDedupWeight > best.entry.weight) {
        best.entry.weight = semanticDedupWeight;
      }
      if (best.entry.summary !== semanticDedupSummary) {
        best.entry.summary = semanticDedupSummary;
        best.entry.updatedAt = now;
      }
      if (semanticDedupSource) best.entry.source = semanticDedupSource;

      // Remove the duplicate new entry
      const idx = knowledge.entries.findIndex(e => e.id === full.id);
      if (idx !== -1) {
        knowledge.entries.splice(idx, 1);
        knowledge.totalEntries = knowledge.entries.length;
        markDirty();
        queueEmbeddingSync(best.entry.id);
        console.log(`[Memory] Semantic dedup: "${semanticDedupTitle}" merged with "${best.entry.title}" (similarity: ${best.similarity.toFixed(3)})`);
      }
    })
    .catch(() => {
      // Best-effort: if embedding not available yet, skip semantic dedup
    });
}

/** Get all KB titles grouped by category (for exploration de-dup context, active only) */
export function getKnowledgeTitles(): { category: string; titles: string[] }[] {
  const byCategory: Record<string, string[]> = {};
  for (const e of knowledge.entries) {
    if ((e.status ?? "active") !== "active") continue;
    const cat = e.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e.title ?? "(untitled)");
  }
  return Object.entries(byCategory).map(([category, titles]) => ({ category, titles }));
}

/** Get a compact digest of existing KB for injection into exploration/research prompts (active only) */
export function getKnowledgeDigestForExploration(): string {
  const active = knowledge.entries.filter(e => (e.status ?? "active") === "active");
  if (active.length === 0) return "Knowledge base is empty — everything is new.";

  const byCategory: Record<string, KnowledgeEntry[]> = {};
  for (const e of active) {
    const cat = e.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }

  const lines: string[] = [`Agent 306 already knows ${active.length} things. By category:`];
  for (const [cat, entries] of Object.entries(byCategory)) {
    // Show top 5 titles per category (by weight) so exploration can skip them
    const top = entries.sort((a, b) => b.weight - a.weight).slice(0, 5);
    lines.push(`[${cat.toUpperCase()}] (${entries.length} entries): ${top.map(e => e.title ?? "(untitled)").join("; ")}`);
  }
  return lines.join("\n");
}

/** Archive a knowledge entry by ID — moves it to long-term memory */
export function archiveKnowledge(entryId: string): boolean {
  const entry = knowledge.entries.find(e => e.id === entryId);
  if (!entry) return false;
  entry.status = "archived";
  markDirty();
  console.log(`[Memory] Archived: "${entry.title}"`);
  return true;
}

/** Search archived entries by keyword/category — for on-demand deep context */
export function searchArchive(query: string, limit = 10): KnowledgeEntry[] {
  const q = query.toLowerCase();
  const archived = knowledge.entries.filter(e => (e.status ?? "active") === "archived");
  const scored = archived.map(e => {
    let score = 0;
    if (e.title?.toLowerCase().includes(q)) score += 3;
    if (e.summary?.toLowerCase().includes(q)) score += 2;
    if (e.category?.toLowerCase().includes(q)) score += 1;
    return { entry: e, score };
  }).filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score || b.entry.weight - a.entry.weight);
  return scored.slice(0, limit).map(s => s.entry);
}

/** Get count of archived entries by category */
export function getArchiveStats(): { total: number; byCategory: Record<string, number> } {
  const archived = knowledge.entries.filter(e => (e.status ?? "active") === "archived");
  const byCategory: Record<string, number> = {};
  for (const e of archived) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
  }
  return { total: archived.length, byCategory };
}

/** Get all memory state for the /api/house endpoint */
export function getMemoryState() {
  return {
    soul: {
      version: soul.version,
      name: soul.identity.name,
      token: soul.identity.token,
      eth: soul.identity.eth,
      coreSentence: soul.identity.coreSentence,
      lastUpdated: soul.lastUpdated,
      principleCount: soul.voicePrinciples.length,
    },
    knowledge: {
      totalEntries: knowledge.totalEntries,
      lastIngested: knowledge.lastIngested,
      researchFiles: knowledge.researchFiles,
      topCategories: getCategoryBreakdown(),
    },
    performance: {
      totalPosts: performance.totalPosts,
      avgScore: Math.round(performance.avgScore * 10) / 10,
      avgEngagement: Math.round(performance.avgEngagement),
      topPerforming: performance.topPerforming.slice(0, 3),
      bestTopics: performance.patterns.bestTopics.slice(0, 5),
      worstTopics: performance.patterns.worstTopics.slice(0, 3),
      recentLessons: performance.lessons
        .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
        .slice(0, 5)
        .map(l => ({
          episodeId: l.episodeId,
          score: l.score,
          likes: l.engagement.likes,
          lessons: l.lessons.slice(0, 2),
          postedAt: l.postedAt,
          tweetUrl: l.tweetUrl,
          manualRating: l.manualRating,
        })),
      lastAnalyzed: performance.lastAnalyzed,
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────

function calcScore(eng: PerformanceLesson["engagement"]): number {
  // Weight: likes (3x), replies (5x — signals real conversation), retweets (4x)
  const raw = (eng.likes * 3) + (eng.replies * 5) + (eng.retweets * 4) + (eng.bookmarks * 2);
  // Scale to 1-10 based on what we've seen (10 likes = ~score 4, 50 likes = ~score 8)
  const score = Math.min(10, Math.max(1, Math.round(raw / 20)));
  return score;
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  if (/research|paper|study/i.test(text)) tags.push("research_content");
  if (/model|release|benchmark/i.test(text)) tags.push("model_mention");
  if (/founder|notable/i.test(text)) tags.push("founder_quote");
  if (/\?/.test(text)) tags.push("has_question");
  if (/agent|agentic|autonomous/i.test(text)) tags.push("agentic_mention");
  if (/breakthrough|frontier/i.test(text)) tags.push("frontier_mention");
  if (/\d+%|level \d+|\d+ (ap|points)/i.test(text)) tags.push("has_stats");
  if (/community/i.test(text)) tags.push("community");
  // Cultural bridge detection — art history, tech moments, sports, philosophy
  const bridgePatterns = [
    /malevich|banksy|basquiat|warhol/i,
    /netscape|app store|bitcoin.*satoshi|first tweet/i,
    /jordan.*piston|federer.*nadal|underdog/i,
    /ship of theseus|prometheus|mono no aware|memento mori/i,
    /punk.*1976|hip.hop.*sampl|open source/i,
    /tulip|land grab|venture round/i,
  ];
  if (bridgePatterns.some(p => p.test(text))) tags.push("cultural_bridge");
  return tags;
}

function deriveLessons(lesson: PerformanceLesson): string[] {
  const lessons: string[] = [];
  const { score, tags, engagement } = lesson;

  if (score >= 8) {
    lessons.push(`High performer (${score}/10) — replicate this format`);
    if (tags.includes("has_question")) lessons.push("Questions drive engagement");
    if (tags.includes("founder_quote")) lessons.push("Founder content lands hard");
    if (tags.includes("research_content")) lessons.push("Research content resonates");
  } else if (score <= 3) {
    lessons.push(`Low performer (${score}/10) — avoid this approach`);
    if (tags.includes("has_stats")) lessons.push("Stat dumps without story don't land");
  }

  if (engagement.replies > engagement.likes) {
    lessons.push("Generated conversation — the post made people think");
  }

  return lessons;
}

function analyzePatterns(): void {
  const scored = performance.lessons.filter(l => l.score > 0);
  if (scored.length === 0) return;

  // Avg score and engagement
  performance.avgScore = scored.reduce((s, l) => s + l.score, 0) / scored.length;
  performance.avgEngagement = scored.reduce((s, l) => s + l.engagement.likes, 0) / scored.length;

  // Top performing posts
  performance.topPerforming = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(l => l.tweetUrl);

  // Best/worst topics from tags
  const tagScores: Record<string, number[]> = {};
  for (const l of scored) {
    for (const tag of l.tags) {
      if (!tagScores[tag]) tagScores[tag] = [];
      tagScores[tag].push(l.score);
    }
  }
  const tagAvg = Object.entries(tagScores)
    .map(([tag, scores]) => ({ tag, avg: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => b.avg - a.avg);

  performance.patterns.bestTopics = tagAvg.filter(t => t.avg >= 7).map(t => t.tag);
  performance.patterns.worstTopics = tagAvg.filter(t => t.avg <= 4).map(t => t.tag);
  performance.lastAnalyzed = new Date().toISOString();
}

function getCategoryBreakdown(): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const e of knowledge.entries) {
    if ((e.status ?? "active") !== "active") continue;
    breakdown[e.category] = (breakdown[e.category] ?? 0) + 1;
  }
  return breakdown;
}

// ── Archive Summarization ──────────────────────────────────────────────────

/**
 * Summarize a group of entries being evicted/archived into a single meta-knowledge entry.
 * Uses the LLM (knowledge-categorization task → routine/cheap model) to synthesize.
 * Returns summary entries to be added back to the KB.
 */
async function summarizeEvictedEntries(
  entries: KnowledgeEntry[],
): Promise<KnowledgeEntry[]> {
  // Group evicted entries by category
  const byCategory: Record<string, KnowledgeEntry[]> = {};
  for (const e of entries) {
    const cat = e.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }

  const summaries: KnowledgeEntry[] = [];

  for (const [category, group] of Object.entries(byCategory)) {
    // Only summarize if 3+ entries in the category group
    if (group.length < 3) continue;

    if (!LLM_API_KEY) {
      // No LLM available — create a basic concatenation summary
      const maxWeight = Math.max(...group.map(e => e.weight));
      const titles = group.map(e => e.title).join("; ");
      summaries.push({
        id: `k_${Date.now()}_sum_${category}`,
        category,
        title: `[Summary] ${category}: ${titles.slice(0, 80)}`,
        summary: group.map(e => e.summary).join(" | ").slice(0, 297) + "...",
        source: "archive_summary",
        learnedAt: new Date().toISOString(),
        weight: Math.max(1, maxWeight - 1),
        status: "active",
        tier: "operational",
        summarizedFrom: group.map(e => e.id),
      });
      continue;
    }

    try {
      const entryList = group.map(e => `- ${e.title}: ${e.summary}`).join("\n");
      const res = await postChatCompletions({
          model: getModel("knowledge-categorization"),
          messages: [
            {
              role: "system",
              content: "You consolidate knowledge entries into concise summaries. Return JSON: { \"theme\": \"short theme name\", \"summary\": \"300-char max synthesis of key insights\" }",
            },
            {
              role: "user",
              content: `Summarize these ${group.length} "${category}" knowledge entries into one consolidated insight:\n\n${entryList}`,
            },
          ],
          max_tokens: 300,
          temperature: 0.2,
        }, AbortSignal.timeout(30000));

      if (!res.ok) {
        console.warn(`[Memory] Archive summarization LLM failed for ${category}: ${res.status}`);
        continue;
      }

      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "{}";
      const parsed = safeParseLLMJson<{ theme?: string; summary?: string }>(raw, "Memory.archiveSummary");

      if (parsed?.summary) {
        const maxWeight = Math.max(...group.map(e => e.weight));
        summaries.push({
          id: `k_${Date.now()}_sum_${category}`,
          category,
          title: `[Summary] ${category}: ${parsed.theme ?? category}`,
          summary: parsed.summary.slice(0, 300),
          source: "archive_summary",
          learnedAt: new Date().toISOString(),
          weight: Math.max(1, maxWeight - 1),
          status: "active",
          tier: "operational",
          summarizedFrom: group.map(e => e.id),
        });
      }
    } catch (e: any) {
      console.warn(`[Memory] Archive summarization failed for ${category}:`, e.message);
    }
  }

  return summaries;
}

/** Decay knowledge entry weights over time so stale entries don't dominate context forever.
 *  Uses updatedAt (if set) instead of learnedAt, so refreshed entries stay relevant longer.
 *  Auto-archives entries when weight drops below 3.
 *  Also downgrades tiers: active → operational after 30 days, operational → archived after 60 days. */
export function decayKnowledge(): void {
  const now        = Date.now();
  const ONE_WEEK   = 7 * 24 * 60 * 60 * 1000;
  const TWO_WEEKS  = 14 * 24 * 60 * 60 * 1000;
  const FOUR_WEEKS = 28 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const SIXTY_DAYS  = 60 * 24 * 60 * 60 * 1000;
  let changed = false;
  let archived = 0;

  for (const entry of knowledge.entries) {
    // Skip already-archived entries and core tier (never decays)
    if ((entry.status ?? "active") === "archived") continue;
    if (entry.tier === "core") continue;

    // Use the most recent timestamp (updatedAt or learnedAt) for decay calculation
    const referenceDate = entry.updatedAt ?? entry.learnedAt;
    const age = now - new Date(referenceDate).getTime();

    // Aggressive decay v2: <1wk no decay, 1-2wk -1, 2-4wk -2, >4wk -3 floor 1
    if (age > FOUR_WEEKS && entry.weight > 1) {
      entry.weight = Math.max(1, entry.weight - 3); // -3 after 4 weeks, floor 1
      changed = true;
    } else if (age > TWO_WEEKS && entry.weight > 1) {
      entry.weight = Math.max(1, entry.weight - 2); // -2 after 2 weeks
      changed = true;
    } else if (age > ONE_WEEK && entry.weight > 1) {
      entry.weight = Math.max(1, entry.weight - 1); // -1 after 1 week
      changed = true;
    }

    // Tier decay: active → operational after 30 days, operational → archived after 60 days
    if (entry.tier === "active" && age > THIRTY_DAYS) {
      entry.tier = "operational";
      changed = true;
    } else if (entry.tier === "operational" && age > SIXTY_DAYS) {
      entry.tier = "archived";
      changed = true;
    }

    // Reassign tier based on current weight
    const newTier = assignTier(entry);
    if ((entry.tier as string) !== "core" && newTier !== entry.tier) {
      // Only downgrade, never upgrade via decay
      const tierOrder = ["core", "active", "operational", "archived"];
      if (tierOrder.indexOf(newTier ?? "operational") > tierOrder.indexOf(entry.tier ?? "operational")) {
        entry.tier = newTier;
        changed = true;
      }
    }

    // Auto-archive when weight drops below 3
    if (entry.weight < 3) {
      entry.status = "archived";
      entry.tier = "archived";
      archived++;
      changed = true;
    }
  }

  if (changed) {
    knowledge.lastIngested = new Date().toISOString();
    save(KNOWLEDGE_FILE, knowledge);
    console.log(`[Memory] Knowledge decay applied.${archived > 0 ? ` ${archived} entries archived.` : ""}`);

    // Summarize newly archived entries before they get evicted
    if (archived > 0) {
      const newlyArchived = knowledge.entries.filter(
        e => (e.status ?? "active") === "archived" && !e.summarizedFrom && e.source !== "archive_summary"
      );
      if (newlyArchived.length >= 3) {
        summarizeEvictedEntries(newlyArchived).then(summaries => {
          if (summaries.length > 0) {
            // Remove the archived entries that were summarized
            const summarizedIds = new Set(summaries.flatMap(s => s.summarizedFrom ?? []));
            knowledge.entries = knowledge.entries.filter(e => !summarizedIds.has(e.id));
            knowledge.entries.push(...summaries);
            knowledge.totalEntries = knowledge.entries.length;
            save(KNOWLEDGE_FILE, knowledge);
            console.log(`[Memory] Archived ${summarizedIds.size} entries into ${summaries.length} theme summaries`);
            for (const s of summaries) queueEmbeddingSync(s.id);
          }
        }).catch(e => console.warn("[Memory] Decay summarization failed:", e.message));
      }
    }
  }
}

/** Get count of active entries */
export function getActiveKnowledgeCount(): number {
  return knowledge.entries.filter(e => (e.status ?? "active") === "active").length;
}

// ── Hot Context Builder ─────────────────────────────────────────────────────

/**
 * Build targeted context for hypothesis evaluation.
 * Gathers direct evidence (knowledge graph connections), cluster context,
 * and recent semantically relevant entries for a given hypothesis.
 */
export async function getHypothesisContext(hypothesisId: string): Promise<{
  directEvidence: KnowledgeEntry[];
  clusterContext: KnowledgeEntry[];
  recentRelevant: KnowledgeEntry[];
}> {
  const empty = { directEvidence: [], clusterContext: [], recentRelevant: [] };

  // 1. Find the hypothesis in the research lab
  let hypothesis: { claim: string; basis: string; relatedTopicId?: string } | undefined;
  try {
    const { getResearchLab } = await import("./researchEngine.js");
    const lab = getResearchLab();
    hypothesis = lab.hypotheses.find((h: any) => h.id === hypothesisId);
  } catch (e: any) {
    console.warn("[Memory] Failed to load research lab for hypothesis context:", e.message);
    return empty;
  }

  if (!hypothesis) {
    console.warn(`[Memory] Hypothesis ${hypothesisId} not found in research lab`);
    return empty;
  }

  // 2. Gather direct evidence: entries linked via knowledge graph connections
  let directEvidence: KnowledgeEntry[] = [];
  try {
    const { getGraphConnections } = await import("./knowledge-graph.js");
    const connections = getGraphConnections();
    const connectedIds = new Set<string>();
    for (const c of connections) {
      // Find connections that reference KB entries related to this hypothesis
      // Since hypotheses don't have direct KB IDs, we look for entries connected
      // to any entry whose title/summary matches the hypothesis claim or basis
      connectedIds.add(c.fromEntryId);
      connectedIds.add(c.toEntryId);
    }

    // Find KB entries whose titles relate to the hypothesis claim
    const claimWords = new Set(hypothesis.claim.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const relatedEntryIds = new Set<string>();
    for (const entry of knowledge.entries) {
      if ((entry.status ?? "active") === "archived") continue;
      const titleWords = new Set((entry.title ?? "").toLowerCase().split(/\s+/));
      const overlap = Array.from(claimWords).filter(w => titleWords.has(w)).length;
      if (overlap >= 2 && connectedIds.has(entry.id)) {
        relatedEntryIds.add(entry.id);
      }
    }

    // Get all entries connected TO those related entries
    for (const c of connections) {
      if (relatedEntryIds.has(c.fromEntryId)) relatedEntryIds.add(c.toEntryId);
      if (relatedEntryIds.has(c.toEntryId)) relatedEntryIds.add(c.fromEntryId);
    }

    directEvidence = knowledge.entries.filter(e => relatedEntryIds.has(e.id));
  } catch (e: any) {
    console.warn("[Memory] Failed to load knowledge graph for hypothesis context:", e.message);
  }

  // 3. Get cluster context: entries from the same thematic cluster
  let clusterContext: KnowledgeEntry[] = [];
  try {
    const { getClusters } = await import("./knowledge-graph.js");
    const clusters = getClusters();

    // Find clusters that contain any of the direct evidence entries
    const directIds = new Set(directEvidence.map(e => e.id));
    const relevantCluster = clusters.find(c =>
      c.entryIds.some(id => directIds.has(id))
    );

    if (relevantCluster) {
      const clusterIds = new Set(relevantCluster.entryIds);
      // Exclude entries already in directEvidence
      clusterContext = knowledge.entries.filter(
        e => clusterIds.has(e.id) && !directIds.has(e.id) && (e.status ?? "active") !== "archived"
      );
    }

    // Fallback: if no cluster found via direct evidence, search by hypothesis topic
    if (clusterContext.length === 0 && hypothesis.relatedTopicId) {
      const topicCluster = clusters.find(c =>
        c.theme.toLowerCase().includes(hypothesis.claim.toLowerCase().split(/\s+/).slice(0, 3).join(" "))
      );
      if (topicCluster) {
        clusterContext = knowledge.entries.filter(
          e => topicCluster.entryIds.includes(e.id) && (e.status ?? "active") !== "archived"
        );
      }
    }
  } catch (e: any) {
    console.warn("[Memory] Failed to load clusters for hypothesis context:", e.message);
  }

  // 4. Get recent semantically relevant entries via embedding search
  let recentRelevant: KnowledgeEntry[] = [];
  try {
    const query = `${hypothesis.claim} ${hypothesis.basis}`;
    const results = await semanticSearch(query, { maxResults: 10, minSimilarity: 0.5 });
    const usedIds = new Set([
      ...directEvidence.map(e => e.id),
      ...clusterContext.map(e => e.id),
    ]);
    recentRelevant = results
      .map(r => r.entry)
      .filter(e => !usedIds.has(e.id));
  } catch (e: any) {
    console.warn("[Memory] Semantic search failed for hypothesis context:", e.message);
  }

  return { directEvidence, clusterContext, recentRelevant };
}

// Backfill tiers on startup
backfillTiers();

// Export raw state for advanced use
export { soul, knowledge, performance };
