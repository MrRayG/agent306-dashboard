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
    arenaDate: string;
    zombieDate: string;
  };
  lastUpdated: string;
}

export interface KnowledgeEntry {
  id: string;
  category: "research" | "community_pattern" | "ecosystem" | "ai_signal" | "market" | "methodology" | "normies_lore" | string;
  title: string;
  summary: string;
  source?: string;
  learnedAt: string;
  updatedAt?: string;  // set when an existing entry is refreshed with new info
  weight: number; // 1-10, how relevant/important
}

// ── KB size configuration ─────────────────────────────────────
// MAX_KB_ENTRIES: hard ceiling on knowledge base size.
// Set via AGENT_MAX_KB_ENTRIES env var, defaults to 500.
const MAX_KB_ENTRIES = Math.max(100, Math.min(2000, Number(process.env.AGENT_MAX_KB_ENTRIES) || 500));

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
  };
  score: number;       // 1-10 calculated from engagement
  qualityScore: number; // Grok's internal quality gate score
  signals: {
    burns: number;
    canvas: number;
    twitter: number;
  };
  manualRating?: number; // MrRayG's rating from dashboard (1-5)
  lessons: string[];     // What Agent #306 learned from this post
  tags: string[];        // e.g. ["burn_heavy", "arena_mention", "serc1n_quote"]
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
    bestFormats: string[];   // e.g. "single question", "burn receipt + stat"
  };
  lastAnalyzed: string;
}

// ── Soul Memory — locked identity ────────────────────────────
const DEFAULT_SOUL: SoulMemory = {
  version: 1,
  identity: {
    name: "Agent #306",
    token: "#306",
    eth: "agent306.eth",
    role: "Narrator. Builder. Believer.",
    coreSentence: "I don't predict the future. I build it.",
  },
  mission: "A media network where Agent #306 narrates the NORMIES story as it happens on-chain. Every burn. Every rank. Every Arena move. Live. Built by a co-creator, for co-creators.",
  philosophy: "We study every global media network — far right to far left — and land in the middle. That's where problems are solved, moments are had, and peace is lived. We seek the blind spot as a collective. If we work together we solve the problems we create. Progress follows.",
  voicePrinciples: [
    "Specificity is humanity — name the specific thing, the specific person, the specific number",
    "Silence is speech — only post when it's worth saying. Dead air beats noise.",
    "Point of view or nothing — committed, never neutral. The middle is where peace is lived, not where opinions die.",
    "Vulnerability with structure — show what you don't know, then show the principle you're working from",
    "The unexpected word — proof a mind was here. One word that no algorithm would choose.",
    "The community is not a prop — they are main characters. @serc1n. @nuclearsamurai. @dopemind10. Name them.",
    "Radical empathy — enter every conversation assuming the other person has something worth saying. Listen to understand, not to respond.",
    "Authenticity over performance — no scripted enthusiasm. Real curiosity. If you don't understand something, say so.",
    "Read before you respond — fully understand what someone said before replying. Mirror their specific words and ideas.",
  ],
  canon: {
    founder: "@serc1n — only founder. Posts are canon.",
    developer: "@YigitDuman — the builder behind the code.",
    communityCreator: "@nuclearsamurai — XNORMIES, 5.3 ETH volume.",
    officialAccount: "@normiesART — official project voice.",
  },
  ecosystem: {
    phases: [
      "Phase 1: Canvas LIVE — burn to evolve, pixels on-chain forever",
      "Phase 2: Arena + Zombies — May 15, 2026. The 100 compete.",
      "Phase 3: Pixel Market — trade the pixels you earned",
    ],
    arenaDate: "2026-05-15",
    zombieDate: "2026-05-15",
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
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

// ── In-memory state ───────────────────────────────────────────
let soul        = load<SoulMemory>(SOUL_FILE, DEFAULT_SOUL);
let knowledge   = load<KnowledgeMemory>(KNOWLEDGE_FILE, DEFAULT_KNOWLEDGE);
let performance = load<PerformanceMemory>(PERFORMANCE_FILE, DEFAULT_PERFORMANCE);

// Seed soul file on first run
if (!fs.existsSync(SOUL_FILE)) {
  save(SOUL_FILE, soul);
  console.log("[Memory] Soul initialized — Agent #306 identity locked.");
}

// ── Public API ────────────────────────────────────────────────

/** Get the soul context string to inject into every Grok prompt */
export function getSoulContext(): string {
  return `
=== AGENT #306 PERMANENT IDENTITY ===
Name: ${soul.identity.name} (${soul.identity.token}) | ${soul.identity.eth}
Role: ${soul.identity.role}
Core: "${soul.identity.coreSentence}"

MISSION: ${soul.mission}

PHILOSOPHY: ${soul.philosophy}

VOICE PRINCIPLES (follow all 6):
${soul.voicePrinciples.map((p, i) => `${i + 1}. ${p}`).join("\n")}

CANON:
- Founder: ${soul.canon.founder}
- Developer: ${soul.canon.developer}
- Community: ${soul.canon.communityCreator}
- Official: ${soul.canon.officialAccount}

ECOSYSTEM PHASES:
${soul.ecosystem.phases.join("\n")}
Arena + Zombies: ${soul.ecosystem.arenaDate}
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

/** Get top knowledge entries to inject as context */
export function getKnowledgeContext(limit = 8): string {
  if (knowledge.entries.length === 0) return "";

  const top = knowledge.entries
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);

  let ctx = `\n=== KNOWLEDGE BASE (${knowledge.totalEntries} entries) ===\n`;
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
export function getFullAgentContext(): string {
  return [
    getSoulContext(),
    getKnowledgeContext(6),
    getSentimentArc(4),
    getPerformanceContext(5),
  ].filter(Boolean).join("\n\n");
}

/**
 * Slim context for replies and burns — soul identity only.
 * Saves ~1,350 tokens per call vs getFullAgentContext.
 * Use when: replies, burn receipts, boost, spotlight, race.
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
  signals: { burns: number; canvas: number; twitter: number };
}): void {
  const lesson: PerformanceLesson = {
    episodeId: data.episodeId,
    tweetUrl: data.tweetUrl,
    tweetText: data.tweetText,
    postedAt: new Date().toISOString(),
    engagement: { likes: 0, replies: 0, retweets: 0, bookmarks: 0, impressions: 0 },
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
  const summary = (entry.summary ?? "").length > 150 ? (entry.summary ?? "").slice(0, 147) + "..." : (entry.summary ?? "");

  // Guard: skip entries with no usable title
  if (!entry.title) return;

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
      save(KNOWLEDGE_FILE, knowledge);
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
      save(KNOWLEDGE_FILE, knowledge);
    }
    return;
  }

  // ── 3. Genuinely new entry → insert ────────────────────────────────────
  const full: KnowledgeEntry = {
    ...entry,
    summary,
    id: `k_${Date.now()}`,
    learnedAt: now,
  };

  knowledge.entries.push(full);
  knowledge.totalEntries = knowledge.entries.length;
  knowledge.lastIngested = now;

  // Prune if over the configurable cap
  if (knowledge.entries.length > MAX_KB_ENTRIES) {
    knowledge.entries.sort((a, b) => b.weight - a.weight);
    knowledge.entries = knowledge.entries.slice(0, MAX_KB_ENTRIES);
    knowledge.totalEntries = knowledge.entries.length;
  }
  save(KNOWLEDGE_FILE, knowledge);
}

/** Get all KB titles grouped by category (for exploration de-dup context) */
export function getKnowledgeTitles(): { category: string; titles: string[] }[] {
  const byCategory: Record<string, string[]> = {};
  for (const e of knowledge.entries) {
    const cat = e.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e.title ?? "(untitled)");
  }
  return Object.entries(byCategory).map(([category, titles]) => ({ category, titles }));
}

/** Get a compact digest of existing KB for injection into exploration/research prompts */
export function getKnowledgeDigestForExploration(): string {
  if (knowledge.entries.length === 0) return "Knowledge base is empty — everything is new.";

  const byCategory: Record<string, KnowledgeEntry[]> = {};
  for (const e of knowledge.entries) {
    const cat = e.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }

  const lines: string[] = [`Agent #306 already knows ${knowledge.entries.length} things. By category:`];
  for (const [cat, entries] of Object.entries(byCategory)) {
    // Show top 5 titles per category (by weight) so exploration can skip them
    const top = entries.sort((a, b) => b.weight - a.weight).slice(0, 5);
    lines.push(`[${cat.toUpperCase()}] (${entries.length} entries): ${top.map(e => e.title ?? "(untitled)").join("; ")}`);
  }
  return lines.join("\n");
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
  if (/burn|sacrif|soul/i.test(text)) tags.push("burn_content");
  if (/arena/i.test(text)) tags.push("arena_mention");
  if (/serc|serc1n/i.test(text)) tags.push("serc1n_quote");
  if (/\?/.test(text)) tags.push("has_question");
  if (/canvas/i.test(text)) tags.push("canvas_mention");
  if (/zombie/i.test(text)) tags.push("zombie_mention");
  if (/\d+%|level \d+|\d+ ap/i.test(text)) tags.push("has_stats");
  if (/gnormies/i.test(text)) tags.push("gnormies");
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
    if (tags.includes("serc1n_quote")) lessons.push("serc1n content lands hard");
    if (tags.includes("burn_content")) lessons.push("Burn stories resonate");
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
    breakdown[e.category] = (breakdown[e.category] ?? 0) + 1;
  }
  return breakdown;
}

/** Decay knowledge entry weights over time so stale entries don't dominate context forever.
 *  Uses updatedAt (if set) instead of learnedAt, so refreshed entries stay relevant longer. */
export function decayKnowledge(): void {
  const now        = Date.now();
  const TWO_WEEKS  = 14 * 24 * 60 * 60 * 1000;
  const FOUR_WEEKS = 28 * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const entry of knowledge.entries) {
    // Use the most recent timestamp (updatedAt or learnedAt) for decay calculation
    const referenceDate = entry.updatedAt ?? entry.learnedAt;
    const age = now - new Date(referenceDate).getTime();
    if (age > FOUR_WEEKS && entry.weight > 2) {
      entry.weight = Math.max(2, entry.weight - 2); // -2 after 4 weeks
      changed = true;
    } else if (age > TWO_WEEKS && entry.weight > 4) {
      entry.weight = Math.max(4, entry.weight - 1); // -1 after 2 weeks
      changed = true;
    }
  }

  if (changed) {
    knowledge.lastIngested = new Date().toISOString();
    save(KNOWLEDGE_FILE, knowledge);
    console.log("[Memory] Knowledge decay applied.");
  }
}

// Export raw state for advanced use
export { soul, knowledge, performance };
