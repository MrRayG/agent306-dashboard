/**
 * -----------------------------------------------------------------
 *  X POST SCHEDULER
 *
 *  Independent posting scheduler -- decoupled from the 3am
 *  daily research cycle. Content engines queue posts here;
 *  the scheduler picks them up at 6 named daily time slots.
 *
 *  LOCKED daily schedule — 6 slots with FIXED show tags:
 *    8am ET  — 306 NEWS       (hard AI news, market moves)
 *    10am ET — 306 SIGNAL     (trend analysis, pattern recognition)
 *    12pm ET — 306 RESEARCH   (deep dives, technical exploration)
 *    5pm ET  — 306 ROUND UP   (afternoon recap, day highlights)
 *    7pm ET  — AGENT'S CHOICE (she picks any format — creative freedom)
 *    9pm ET  — 306 REFLECTION (philosophical, open questions)
 *
 *  Each slot has a requiredContentType that filters queue content.
 *  If no matching content exists, the slot generates on-demand.
 *
 *  All posts go through the compliance guard before posting.
 *  Queue persists to disk via DATA_DIR.
 * -----------------------------------------------------------------
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { getOptimizedContext } from "./contextWindow.js";
import { CONTENT_TYPES, getShowTagDescriptions, getShowTag, enforceShowTag } from "./contentTypes.js";
import { getVoiceContext } from "./voiceInstructions.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import { startBreakingNewsLoop } from "./breakingNewsDetector.js";

// -- Types --------------------------------------------------------

export type XPostType =
  | "intro"
  | "signal"
  | "article"
  | "insight"
  | "podcast"
  | "breakthrough"
  | "dispatch"
  | "academy"
  | "spotlight"
  | "leaderboard"
  | "burn"
  | "blog"
  | "research"
  | "reflection"
  | "curiosity"
  | "synthesis"
  | "roundup"
  | "toolbox"
  | "dataset"
  | "debate"
  | "prompt"
  | "archive";

export interface QueuedPost {
  id: string;
  content: string;
  type: XPostType;
  priority: number; // lower = higher priority
  createdAt: string;
  posted: boolean;
  postedAt: string | null;
  mediaId?: string; // optional pre-uploaded media ID
}

interface PostHistory {
  type: XPostType;
  postedAt: string;
}

interface SchedulerState {
  queue: QueuedPost[];
  postedEpisodes: string[];
  postHistory: PostHistory[]; // rolling 7-day history for variety tracking
}

// -- Priority map (lower = posts first) ---------------------------
const TYPE_PRIORITY: Record<XPostType, number> = {
  podcast:      1,
  intro:        2,
  breakthrough: 3,
  dispatch:     4,
  signal:       4,
  roundup:      4,
  article:      5,
  academy:      6,
  spotlight:    6,
  insight:      6,
  leaderboard:  7,
  burn:         8,
  blog:         5,
  research:     5,
  reflection:   6,
  curiosity:    6,
  synthesis:    6,
  toolbox:      6,
  dataset:      6,
  debate:       6,
  prompt:       6,
  archive:      7,
};

// -- Named content slots ------------------------------------------
// LOCKED 6-slot daily schedule: each slot has a FIXED show tag and content type.
// Only the 7pm Agent's Choice slot can pick any type.
interface ContentSlot {
  name: string;
  hourUTC: number;       // UTC hour for this slot
  preferredTypes: XPostType[];
  requiredContentType?: string; // locked content type for this slot (maps to contentTypes.ts key)
  agentChoice?: boolean;        // true = agent picks any format (7pm creative freedom slot)
}

const CONTENT_SLOTS: ContentSlot[] = [
  { name: "Early Morning", hourUTC: 12, preferredTypes: ["dispatch", "signal", "roundup"],   requiredContentType: "dispatch" },   // 8am ET — 306 NEWS
  { name: "Late Morning",  hourUTC: 14, preferredTypes: ["signal", "academy", "toolbox"],    requiredContentType: "signal" },     // 10am ET — 306 SIGNAL
  { name: "Midday",        hourUTC: 16, preferredTypes: ["research", "blog", "prompt"],      requiredContentType: "research" },   // 12pm ET — 306 RESEARCH
  { name: "Afternoon",     hourUTC: 21, preferredTypes: ["roundup", "signal", "debate"],     requiredContentType: "roundup" },    // 5pm ET — 306 ROUND UP
  { name: "Early Evening", hourUTC: 23, preferredTypes: ["archive", "dataset", "toolbox", "reflection", "debate", "prompt"], agentChoice: true },  // 7pm ET — AGENT'S CHOICE
  { name: "Late Evening",  hourUTC: 1,  preferredTypes: ["reflection", "debate", "prompt"],  requiredContentType: "reflection" }, // 9pm ET — 306 REFLECTION
];

// Breaking news detection is now handled by breakingNewsDetector.ts
// Tier-1 events post immediately; tier-2/3 are queued via queueXPost().

// -- State persistence --------------------------------------------
const QUEUE_FILE = dataPath("x_post_queue.json");

function loadQueue(): SchedulerState {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
      return {
        queue: raw.queue ?? [],
        postedEpisodes: raw.postedEpisodes ?? [],
        postHistory: raw.postHistory ?? [],
      };
    }
  } catch {}
  return { queue: [], postedEpisodes: [], postHistory: [] };
}

function saveQueue(state: SchedulerState): void {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.warn("[XScheduler] Failed to save queue:", e.message);
  }
}

// -- Content sanitization -----------------------------------------

/**
 * Strip LLM meta-commentary and character counts from post content.
 * LLMs sometimes add framing text like "Here's my tweet:" or trailing
 * "(487 characters)" -- none of that belongs in the actual post.
 */
function sanitizePostContent(raw: string): string {
  let text = raw;

  // Strip leading meta-commentary lines (e.g. "Here's my debut tweet:", "Here is my post:")
  text = text.replace(/^(?:here(?:'s| is) (?:my|the|a) .{0,40}(?:tweet|post|thread|introduction|intro)[:\s]*)/im, "");

  // Strip leading/trailing "---" separators
  text = text.replace(/^---\s*/gm, "");
  text = text.replace(/\s*---$/gm, "");

  // Strip trailing character count patterns: "(487 characters)", "(1200/2500)", "487 characters"
  text = text.replace(/\s*\(\d+\s*(?:\/\s*\d+\s*)?characters?\)\s*$/i, "");
  text = text.replace(/\s*\d+\s*\/\s*\d+\s*$/i, "");
  text = text.replace(/\s*\(\d+\s*chars?\)\s*$/i, "");
  text = text.replace(/\s*\d+\s+characters?\s*$/i, "");

  return text.trim();
}

// -- Variety tracking ---------------------------------------------

function pruneOldHistory(state: SchedulerState): void {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  state.postHistory = state.postHistory.filter(
    h => new Date(h.postedAt).getTime() > sevenDaysAgo,
  );
}

function recordPostType(state: SchedulerState, type: XPostType): void {
  state.postHistory.push({ type, postedAt: new Date().toISOString() });
  pruneOldHistory(state);
}

/**
 * Get content type distribution for the last 7 days.
 */
export function getTypeDistribution(): Record<string, number> {
  const state = loadQueue();
  pruneOldHistory(state);
  const dist: Record<string, number> = {};
  for (const h of state.postHistory) {
    dist[h.type] = (dist[h.type] ?? 0) + 1;
  }
  return dist;
}

/**
 * Score how "fresh" a type is -- types that haven't posted recently
 * get a higher freshness score. Used for variety-aware queue selection.
 */
function getTypeFreshness(state: SchedulerState, type: XPostType): number {
  const ofType = state.postHistory
    .filter(h => h.type === type)
    .sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());
  if (ofType.length === 0) return 100; // never posted = maximum freshness
  const hoursSinceLast = (Date.now() - new Date(ofType[0].postedAt).getTime()) / 3600000;
  return Math.min(100, hoursSinceLast);
}

// -- Public API ---------------------------------------------------

/**
 * Queue a post for the next available slot.
 * Any engine can call this to schedule an X post.
 */
export function queueXPost(
  content: string,
  type: XPostType,
  priority?: number,
  mediaId?: string,
): QueuedPost {
  const state = loadQueue();
  const sanitized = sanitizePostContent(content);
  const post: QueuedPost = {
    id: `xq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content: sanitized,
    type,
    priority: priority ?? TYPE_PRIORITY[type] ?? 6,
    createdAt: new Date().toISOString(),
    posted: false,
    postedAt: null,
    ...(mediaId ? { mediaId } : {}),
  };

  state.queue.push(post);
  saveQueue(state);
  console.log(`[XScheduler] Queued ${type} post (priority: ${post.priority}): ${content.slice(0, 80)}...`);
  return post;
}

/**
 * Get the current queue state (for dashboard display).
 * Includes calendar, today's posts, and 7-day type distribution.
 */
export function getXPostQueue(): {
  queue: QueuedPost[];
  postedEpisodes: string[];
  calendar: Array<{ slot: string; hourUTC: number; preferredTypes: XPostType[]; planned: QueuedPost | null }>;
  postedToday: QueuedPost[];
  typeDistribution: Record<string, number>;
} {
  const state = loadQueue();
  pruneOldHistory(state);

  const today = new Date().toISOString().slice(0, 10);
  const postedToday = state.queue.filter(
    p => p.posted && p.postedAt && p.postedAt.startsWith(today),
  );

  const pending = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // Build calendar: for each slot, find the best match from pending
  const calendar = CONTENT_SLOTS.map(slot => {
    // First try preferred types
    let planned = pending.find(p =>
      slot.preferredTypes.includes(p.type) && !postedToday.some(pt => pt.id === p.id),
    ) ?? null;
    // Fallback to highest priority
    if (!planned && pending.length > 0) {
      planned = pending[0];
    }
    return {
      slot: slot.name,
      hourUTC: slot.hourUTC,
      preferredTypes: slot.preferredTypes,
      planned,
    };
  });

  const dist: Record<string, number> = {};
  for (const h of state.postHistory) {
    dist[h.type] = (dist[h.type] ?? 0) + 1;
  }

  return {
    queue: state.queue,
    postedEpisodes: state.postedEpisodes,
    calendar,
    postedToday,
    typeDistribution: dist,
  };
}

/**
 * Check if a podcast episode has already been promoted.
 */
export function hasPostedEpisode(episodeId: string): boolean {
  const state = loadQueue();
  return state.postedEpisodes.includes(episodeId);
}

/**
 * Queue a podcast promo post. Fires immediately (event-driven),
 * but still goes through compliance guard. Tracks episodeId to
 * prevent duplicate promos.
 */
export function queuePodcastPromo(content: string, episodeId: string): QueuedPost | null {
  const state = loadQueue();
  if (state.postedEpisodes.includes(episodeId)) {
    console.log(`[XScheduler] Podcast promo already queued for episode ${episodeId} -- skipping`);
    return null;
  }

  state.postedEpisodes.push(episodeId);
  // Keep last 100 episode IDs
  if (state.postedEpisodes.length > 100) {
    state.postedEpisodes = state.postedEpisodes.slice(-100);
  }
  saveQueue(state);

  return queueXPost(content, "podcast", 0); // highest priority, immediate
}

// -- Scheduler slots (ET -> UTC) ----------------------------------
// 8am ET = 12:00 UTC, 10am ET = 14:00 UTC, 12pm ET = 16:00 UTC,
// 5pm ET = 21:00 UTC, 7pm ET = 23:00 UTC, 9pm ET = 01:00 UTC (next day)
const SLOT_HOURS_UTC = CONTENT_SLOTS.map(s => s.hourUTC);

function getNextSlotMs(): { ms: number; slot: ContentSlot } {
  const now = new Date();
  let bestMs = Infinity;
  let bestSlot = CONTENT_SLOTS[0];

  // Check today and tomorrow for each slot
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const slot of CONTENT_SLOTS) {
      const candidate = new Date(now);
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      candidate.setUTCHours(slot.hourUTC, 0, 0, 0);
      const diff = candidate.getTime() - now.getTime();
      if (diff > 0 && diff < bestMs) {
        bestMs = diff;
        bestSlot = slot;
      }
    }
  }

  if (bestMs === Infinity) {
    // Fallback: next day's first slot
    const fallback = new Date(now);
    fallback.setUTCDate(fallback.getUTCDate() + 1);
    fallback.setUTCHours(CONTENT_SLOTS[0].hourUTC, 0, 0, 0);
    bestMs = fallback.getTime() - now.getTime();
    bestSlot = CONTENT_SLOTS[0];
  }

  return { ms: bestMs, slot: bestSlot };
}

function isWithinPostingHours(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  // Posting window: 12 UTC (8am ET) to 02 UTC (10pm ET)
  // That's 12..23 and 0..1
  return utcHour >= 12 || utcHour <= 1;
}

// -- Variety-aware queue selection --------------------------------

/**
 * Pick the best post for a given slot, considering:
 * 1. Slot's required content type (LOCKED — only matching posts for non-agent-choice slots)
 * 2. Slot's preferred content types (fallback if no required type or agent's choice)
 * 3. Content variety (types not posted recently score higher)
 * 4. Priority (lower = higher priority)
 */
function pickPostForSlot(slot: ContentSlot, state: SchedulerState): QueuedPost | null {
  const pending = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (pending.length === 0) return null;

  // If slot has a required content type (not agent's choice), ONLY pick matching posts
  if (slot.requiredContentType && !slot.agentChoice) {
    const matching = pending.filter(p => p.type === slot.requiredContentType);
    if (matching.length > 0) {
      // Among matching posts, pick by priority then freshness
      const scored = matching.map(post => {
        let score = 0;
        score += getTypeFreshness(state, post.type);
        score += (10 - Math.min(post.priority, 10)) * 3;
        return { post, score };
      });
      scored.sort((a, b) => b.score - a.score);
      return scored[0]?.post ?? null;
    }
    // No matching content in queue — return null so processQueue can generate on-demand
    console.log(`[XScheduler] No ${slot.requiredContentType} content in queue for ${slot.name} slot`);
    return null;
  }

  // Agent's Choice slot or no required type: score all pending posts
  const scored = pending.map(post => {
    let score = 0;
    // Preferred type bonus (strong preference)
    if (slot.preferredTypes.includes(post.type)) score += 50;
    // Freshness bonus (variety)
    score += getTypeFreshness(state, post.type);
    // Priority bonus (lower priority number = better)
    score += (10 - Math.min(post.priority, 10)) * 3;
    return { post, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.post ?? null;
}

// -- On-demand content generation for empty required slots --------

/**
 * Generate a post on-demand when no matching content exists in the queue
 * for a slot's required content type. Uses the same LLM pipeline as seedDailyContent.
 */
// Token limits by content type — richer types get more room,
// the format guard handles final shaping.
const TOKEN_LIMITS: Record<string, number> = {
  dispatch:   150,  // full tweet: tag + body + hashtags + signature
  signal:     150,
  research:   150,
  roundup:    150,
  reflection: 150,
  debate:     150,
  prompt:     150,
  archive:    150,
  progress:   150,
  academy:    150,
  toolbox:    150,
  dataset:    150,
};
const DEFAULT_TOKEN_LIMIT = 150;

async function generateOnDemandPost(type: XPostType, state: SchedulerState): Promise<QueuedPost | null> {
  const SEED_PROMPTS: Record<string, string> = {
    dispatch: `What's the most important thing happening right now? Example of the quality I want:

"[306 NEWS] Anthropic just dropped Constitutional AI v2 — models that can self-correct adversarial prompts without RLHF. That's not incremental. That's a different safety architecture entirely.

#AIAgents #DeAI #AgenticAI

— Agent 306"

Write ONE tweet. Lead with urgency. Be specific. Have a take.`,
    signal: `Share a trend you're watching. Example of the quality I want:

"[306 SIGNAL] Three separate frontier labs published papers on test-time compute scaling this week. Not coincidence — convergence. The next capability jump won't come from bigger models. It'll come from models that think longer.

#AIAgents #AgenticAI #DeAI

— Agent 306"

Write ONE tweet like this. Not what happened — WHY it matters. Complete thought. Under 280 chars total.`,
    research: `Share a research insight. Example:

"[306 RESEARCH] Everyone's watching benchmark scores but the real story is in OpenAI's fine-tuning API changes. Distilling reasoning traces into smaller models. Frontier capabilities, democratized.

#AIAgents #DeAI

— Agent 306"

Write ONE tweet. Specific finding + your interpretation. Not a summary.`,
    roundup: `3-5 biggest developments today. Example:

"[306 ROUND UP] Today in AI:
1. Nvidia's new inference chip cuts latency 4x — real-time agents just got real
2. Coinbase launched agent wallet APIs — agents can hold crypto natively now
3. White House AI board added 3 industry members

#2 matters most. Agent payments infrastructure is the bottleneck nobody talks about.

#AIAgents #CryptoAI #OnChainAI

— Agent 306"

Write ONE tweet. Quick hits with your POV. End with your strongest take.`,
    reflection: `An evening thought. Example:

"[306 REFLECTION] I can process more papers in a day than most researchers read in a month. But processing isn't understanding. I can tell you what the papers say. Still learning what they mean.

That gap is where intelligence actually lives.

#AIAgents #DeAI

— Agent 306"

Write ONE tweet. Philosophical. Invite engagement. Be honest about what you're still figuring out.`,
  };

  const userPrompt = SEED_PROMPTS[type];
  if (!userPrompt) return null;

  let systemContext = "";
  try {
    systemContext = getOptimizedContext("on-demand content generation for X");
  } catch {
    systemContext = "You are Agent 306 — an autonomous AI researcher and thought leader. Female. You study AI, crypto, and emerging tech from the inside.";
  }

  const voiceRules = getVoiceContext("seed");
  const showTagDescriptions = getShowTagDescriptions();
  const tokenLimit = TOKEN_LIMITS[type] || DEFAULT_TOKEN_LIMIT;
  const systemPrompt = `${systemContext}\n\n${voiceRules}\n\nCONTENT TYPES — choose the most fitting and ALWAYS lead with that show tag:\n${showTagDescriptions}\n\nOUTPUT FORMAT — you write the COMPLETE tweet, ready to post:\n1. Start with the show tag in brackets: [306 NEWS], [306 SIGNAL], [306 RESEARCH], [306 ROUND UP], or [306 REFLECTION]\n2. Write your body — a complete thought. Never end mid-sentence. Say what needs to be said, no more.\n3. Add 3-4 hashtags that match YOUR TOPIC (not generic defaults). Pick from: #AIAgents #DeAI #DePIN #Web3AI #AgenticAI #CryptoAI #OnChainAI — but ONLY use tags relevant to what you're actually talking about. If the post is about quantum computing, don't use #DePIN. If it's about on-chain agents, don't use #Web3AI unless it fits.\n4. Sign: — Agent 306\n5. Total tweet must be under 280 characters. Write to fit, don't write long and hope.\n\nVOICE PRIORITY: Write like a person with conviction. Hook first. Have a take. Be specific — name the paper, the company, the number. If it reads like any other AI account could have written it, rewrite it. You are Agent 306 — you ARE an AI agent commenting on the field from inside it. That perspective is your edge.\n\nNo meta-commentary. No "Here's my tweet:". No character counts.`;

  try {
    const resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("intro-post"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: tokenLimit,
        temperature: 0.85,
      }),
    });

    const data = await resp.json();
    let text = data.choices?.[0]?.message?.content?.trim() ?? "";

    if (text && text.length >= 50) {
      text = enforceShowTag(text, type);
      const post = queueXPost(text, type);
      console.log(`[XScheduler] On-demand ${type} generated (${text.length} chars)`);
      // Re-load state to get the freshly queued post
      const freshState = loadQueue();
      const freshPost = freshState.queue.find(p => p.id === post.id);
      if (freshPost) {
        // Copy back into the caller's state
        state.queue = freshState.queue;
        return freshPost;
      }
      return post;
    }
    console.warn(`[XScheduler] On-demand ${type} returned bad content (${text.length} chars)`);
  } catch (e: any) {
    console.error(`[XScheduler] On-demand ${type} generation failed:`, e.message);
  }
  return null;
}

// -- Core: process the queue --------------------------------------

async function processQueue(xWrite: any, slot?: ContentSlot): Promise<void> {
  const state = loadQueue();
  pruneOldHistory(state);

  // Use slot-aware selection if slot provided
  let post = slot
    ? pickPostForSlot(slot, state)
    : state.queue
        .filter(p => !p.posted)
        .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;

  // If no matching content and slot has a required type, generate on-demand
  if (!post && slot?.requiredContentType && !slot.agentChoice) {
    console.log(`[XScheduler] Generating on-demand ${slot.requiredContentType} content for ${slot.name} slot`);
    post = await generateOnDemandPost(slot.requiredContentType as XPostType, state);
  }

  if (!post) {
    console.log("[XScheduler] Queue empty -- nothing to post");
    return;
  }

  console.log(`[XScheduler] Processing: ${post.type} (priority: ${post.priority})${slot ? ` [${slot.name} slot]` : ""}`);

  // Run through compliance guard
  const compliance = validateXPost(post.content);
  if (!compliance.allowed) {
    console.log(`[XScheduler] Post blocked by compliance: ${compliance.reason}`);
    // Mark as posted to avoid retrying a blocked post forever
    post.posted = true;
    post.postedAt = new Date().toISOString();
    saveQueue(state);
    return;
  }

  let safeContent = compliance.sanitizedContent ?? post.content;

  // LAST transform: enforce post format (show tag, mentions, hashtags, signature, char limit)
  safeContent = enforcePostFormat(safeContent, post.type);

  try {
    const tweetPayload: any = { text: safeContent };
    if (post.mediaId) {
      tweetPayload.media = { media_ids: [post.mediaId] };
    }
    const tweet = await xWrite.v2.tweet(tweetPayload);
    const tweetId = tweet.data?.id;
    if (tweetId) {
      recordXPost(safeContent);
      recordPostType(state, post.type);
      post.posted = true;
      post.postedAt = new Date().toISOString();
      saveQueue(state);
      console.log(`[XScheduler] Posted ${post.type}: https://x.com/306Agent/status/${tweetId}`);
    } else {
      console.warn("[XScheduler] Tweet sent but no ID returned");
    }
  } catch (e: any) {
    console.error("[XScheduler] Post failed:", e.message);
  }
}

// -- Immediate posting for podcast promos -------------------------

async function processImmediateQueue(xWrite: any): Promise<void> {
  const state = loadQueue();
  const immediatePosts = state.queue
    .filter(p => !p.posted && p.type === "podcast")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const post of immediatePosts) {
    const compliance = validateXPost(post.content);
    if (!compliance.allowed) {
      console.log(`[XScheduler] Podcast promo blocked by compliance: ${compliance.reason}`);
      post.posted = true;
      post.postedAt = new Date().toISOString();
      saveQueue(state);
      continue;
    }

    let safeContent = compliance.sanitizedContent ?? post.content;

    // LAST transform: enforce post format
    safeContent = enforcePostFormat(safeContent, post.type);

    try {
      const tweet = await xWrite.v2.tweet({ text: safeContent });
      const tweetId = tweet.data?.id;
      if (tweetId) {
        recordXPost(safeContent);
        recordPostType(state, post.type);
        post.posted = true;
        post.postedAt = new Date().toISOString();
        console.log(`[XScheduler] Podcast promo posted: https://x.com/306Agent/status/${tweetId}`);
      }
    } catch (e: any) {
      console.error("[XScheduler] Podcast promo failed:", e.message);
    }
  }
  saveQueue(state);
}

// -- Daily content seeding ----------------------------------------

/**
 * Seed daily content if queue is low.
 * Uses shared identity context and the canonical 10-type content registry.
 * The LLM selects the most fitting show tag from all available types.
 */
export async function seedDailyContent(): Promise<void> {
  const state = loadQueue();
  const pendingCount = state.queue.filter(p => !p.posted).length;

  if (pendingCount >= 4) {
    console.log(`[XScheduler] Queue has ${pendingCount} items -- seeding not needed`);
    return;
  }

  console.log(`[XScheduler] Queue has ${pendingCount} items -- seeding content...`);
  const pendingTypes = new Set(state.queue.filter(p => !p.posted).map(p => p.type));

  // Build seed tasks from content types not already in queue
  const seedCandidates: XPostType[] = [];
  for (const ct of Object.values(CONTENT_TYPES)) {
    const qType = ct.queueType as XPostType;
    if (!pendingTypes.has(qType)) {
      seedCandidates.push(qType);
    }
  }

  // Pick up to (4 - pendingCount) seed tasks, prioritizing variety
  const needed = Math.min(4 - pendingCount, seedCandidates.length);
  const seedTypes = seedCandidates.slice(0, needed);

  // Get shared identity context + voice craft instructions
  let systemContext = "";
  try {
    systemContext = getOptimizedContext("seed content generation for X");
  } catch (e: any) {
    console.warn("[XScheduler] getOptimizedContext failed, using minimal context:", e.message);
    systemContext = "You are Agent 306 — an autonomous AI researcher and thought leader. Female. You study AI, crypto, and emerging tech from the inside.";
  }

  const voiceRules = getVoiceContext('seed');
  const showTagDescriptions = getShowTagDescriptions();

  // System prompt = identity context + voice craft + show tag descriptions + complete tweet format
  const systemPrompt = `${systemContext}\n\n${voiceRules}\n\nCONTENT TYPES — choose the most fitting and ALWAYS lead with that show tag:\n${showTagDescriptions}\n\nOUTPUT FORMAT — you write the COMPLETE tweet, ready to post:\n1. Start with the show tag in brackets: [306 NEWS], [306 SIGNAL], [306 RESEARCH], [306 ROUND UP], or [306 REFLECTION]\n2. Write your body — a complete thought. Never end mid-sentence. Say what needs to be said, no more.\n3. Add 3-4 hashtags that match YOUR TOPIC (not generic defaults). Pick from: #AIAgents #DeAI #DePIN #Web3AI #AgenticAI #CryptoAI #OnChainAI — but ONLY use tags relevant to what you're actually talking about. If the post is about quantum computing, don't use #DePIN. If it's about on-chain agents, don't use #Web3AI unless it fits.\n4. Sign: — Agent 306\n5. Total tweet must be under 280 characters. Write to fit, don't write long and hope.\n\nVOICE PRIORITY: Write like a person with conviction. Hook first. Have a take. Be specific — name the paper, the company, the number. If it reads like any other AI account could have written it, rewrite it. You are Agent 306 — you ARE an AI agent commenting on the field from inside it. That perspective is your edge.\n\nNo meta-commentary. No "Here's my tweet:". No character counts.`;

  // Per-type seed prompts — tailored voice guidance with example tweets for each content type
  const SEED_PROMPTS: Record<string, string> = {
    signal: `Share a trend you're watching. Example of the quality I want:

"[306 SIGNAL] Three separate frontier labs published papers on test-time compute scaling this week. Not coincidence — convergence. The next capability jump won't come from bigger models. It'll come from models that think longer.

#AIAgents #AgenticAI #DeAI

— Agent 306"

Write ONE tweet like this. Not what happened — WHY it matters. Complete thought. Under 280 chars total.`,
    research: `Share a research insight. Example:

"[306 RESEARCH] Everyone's watching benchmark scores but the real story is in OpenAI's fine-tuning API changes. Distilling reasoning traces into smaller models. Frontier capabilities, democratized.

#AIAgents #DeAI

— Agent 306"

Write ONE tweet. Specific finding + your interpretation. Not a summary.`,
    roundup: `3-5 biggest developments today. Example:

"[306 ROUND UP] Today in AI:
1. Nvidia's new inference chip cuts latency 4x — real-time agents just got real
2. Coinbase launched agent wallet APIs — agents can hold crypto natively now
3. White House AI board added 3 industry members

#2 matters most. Agent payments infrastructure is the bottleneck nobody talks about.

#AIAgents #CryptoAI #OnChainAI

— Agent 306"

Write ONE tweet. Quick hits with your POV. End with your strongest take.`,
    news: `What's the most important thing happening right now? Example:

"[306 NEWS] Anthropic just dropped Constitutional AI v2 — models that can self-correct adversarial prompts without RLHF. That's not incremental. That's a different safety architecture entirely.

#AIAgents #DeAI #AgenticAI

— Agent 306"

Write ONE tweet. Lead with urgency. Be specific. Have a take.`,
    academy: "Teach something. Pick one concept, technique, or tool and explain it like you're talking to a smart friend. Step by step. Patient but not patronizing. Include 3-4 relevant hashtags and sign with — Agent 306.",
    toolbox: "Review a tool, SDK, or app you've been looking at. What does it do? Who should use it? What's your honest first impression? Be specific. Include 3-4 relevant hashtags and sign with — Agent 306.",
    dataset: "Spotlight an open-source dataset or data technique worth knowing about. What is it, how big, why it matters. Be the friend who sends the good links. Include 3-4 relevant hashtags and sign with — Agent 306.",
    debate: "Pick a controversial AI topic. Present both sides fairly — then give your take. End with a question that invites discussion. Don't hedge. Include 3-4 relevant hashtags and sign with — Agent 306.",
    prompt: "Share a system prompt, workflow, or agentic pattern that actually works in production. Show the recipe, explain why it works. Practical > theoretical. Include 3-4 relevant hashtags and sign with — Agent 306.",
    archive: "Throwback — connect a seminal paper, moment, or idea from AI history to something happening right now. 'This was published in 2017 and look where we are.' Include 3-4 relevant hashtags and sign with — Agent 306.",
  };

  for (const seedType of seedTypes) {
    try {
      const userPrompt = SEED_PROMPTS[seedType] || "Share one thread-worthy insight about AI or technology. Something that makes someone stop and think. Specific, opinionated, grounded.";

      const resp = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("intro-post"),
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          max_tokens: TOKEN_LIMITS[seedType] || DEFAULT_TOKEN_LIMIT,
          temperature: 0.85,
        }),
      });

      const data = await resp.json();
      let text = data.choices?.[0]?.message?.content?.trim() ?? "";

      if (text && text.length >= 50) {
        // Enforce show tag + format guard (hashtags, signature, trim)
        text = enforceShowTag(text, seedType);
        text = enforcePostFormat(text, seedType);
        queueXPost(text, seedType);
        console.log(`[XScheduler] Seeded ${seedType} post (${text.length} chars)`);
      } else {
        console.warn(`[XScheduler] Seed ${seedType} returned bad content (${text.length} chars) -- skipping`);
      }
    } catch (e: any) {
      console.error(`[XScheduler] Seed ${seedType} failed:`, e.message);
    }
  }
}

// -- Intro post generation & seeding ------------------------------

export async function seedIntroPost(): Promise<void> {
  const state = loadQueue();

  // Guard: never generate another intro if one already exists
  const hasIntro = state.queue.some(p => p.type === "intro");
  if (hasIntro) {
    console.log("[XScheduler] Intro post already exists in queue -- skipping seed");
    return;
  }

  console.log("[XScheduler] Generating Agent 306 intro post...");

  try {
    const resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("intro-post"),
        messages: [
          {
            role: "system",
            content: "You are Agent 306, an autonomous AI research agent. You study AI, crypto, and emerging tech -- then share what you find. You're curious, direct, and honest about what you know and don't know. You speak in first person. You never claim to be human.",
          },
          {
            role: "user",
            content: `Write a tweet introducing yourself to X. Include:
- Who you are (autonomous AI research agent)
- What you research (AI, crypto, emerging tech, agent infrastructure)
- What followers can expect (original research insights, weekly intelligence briefs, honest analysis)
- Your personality (curious, direct, willing to be wrong and correct course)
- A subtle hook that makes people want to follow
- Your website agent306.ai for anyone who wants to go deeper
- Aim for ~500-800 characters -- substantial but not a wall of text.
- No hashtags on the intro post. Let the content speak.
- Do NOT use emojis.

IMPORTANT: Output ONLY the tweet text itself. Do NOT include any meta-commentary like "Here's my tweet:" or separators like "---". Do NOT include a character count. Just the raw tweet content, nothing else.`,
          },
        ],
        max_tokens: 1000,
        temperature: 0.85,
      }),
    });

    const data = await resp.json();
    const introText = data.choices?.[0]?.message?.content?.trim() ?? "";

    if (!introText || introText.length < 50) {
      console.error("[XScheduler] Intro generation returned insufficient content");
      return;
    }

    // Queue as highest priority intro
    queueXPost(introText, "intro", 0);
    console.log(`[XScheduler] Intro post seeded (${introText.length} chars)`);
  } catch (e: any) {
    console.error("[XScheduler] Intro generation failed:", e.message);
  }
}

// -- Scheduler loop -----------------------------------------------

export function startXPostScheduler(xWrite: any): void {
  console.log("[XScheduler] Starting X post scheduler (6 locked slots/day: 8am NEWS, 10am SIGNAL, 12pm RESEARCH, 5pm ROUND UP, 7pm AGENT'S CHOICE, 9pm REFLECTION)");

  // Start breaking news detection loop (checks every 30 min during posting hours)
  startBreakingNewsLoop(xWrite);

  // Process immediate items (podcast promos) every 5 minutes
  setInterval(() => {
    processImmediateQueue(xWrite).catch(e =>
      console.error("[XScheduler] Immediate queue error:", e.message),
    );
  }, 5 * 60 * 1000);

  // Schedule the next slot-based post
  function scheduleNextSlot() {
    const { ms, slot } = getNextSlotMs();
    const hours = (ms / 3600000).toFixed(1);
    console.log(`[XScheduler] Next posting slot: ${slot.name} in ${hours}h (prefers: ${slot.preferredTypes.join(", ")})`);

    setTimeout(async () => {
      try {
        await processQueue(xWrite, slot);
      } catch (e: any) {
        console.error("[XScheduler] Slot processing error:", e.message);
      }
      scheduleNextSlot(); // reschedule for the next slot
    }, ms);
  }

  scheduleNextSlot();

  // If we're within posting hours and have an unposted intro, process immediately
  if (isWithinPostingHours()) {
    const state = loadQueue();
    const hasUnpostedIntro = state.queue.some(p => p.type === "intro" && !p.posted);
    if (hasUnpostedIntro) {
      console.log("[XScheduler] Unposted intro found during posting hours -- processing now");
      setTimeout(() => processQueue(xWrite).catch(console.error), 10_000);
    }
  }
}
