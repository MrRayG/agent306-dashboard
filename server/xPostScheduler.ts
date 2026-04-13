/**
 * -----------------------------------------------------------------
 *  X POST SCHEDULER
 *
 *  Independent posting scheduler -- decoupled from the 3am
 *  daily research cycle. Content engines queue posts here;
 *  the scheduler picks them up at 4 named daily time slots.
 *
 *  Named slots (ET):
 *    Morning  (8am)  -- SIGNAL Brief / News Dispatch
 *    Midday   (12pm) -- Research, Blog, Academy
 *    Afternoon(5pm)  -- Breakthrough, Spotlight, Synthesis
 *    Evening  (9pm)  -- Reflection, Curiosity, Article
 *
 *  Each slot PREFERS its assigned content type but falls back
 *  to whatever is queued (priority order) if preferred unavailable.
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
import { CONTENT_TYPES, getShowTagDescriptions } from "./contentTypes.js";

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
// Each slot has preferred content types; falls back to priority order.
interface ContentSlot {
  name: string;
  hourUTC: number;       // UTC hour for this slot
  preferredTypes: XPostType[];
}

const CONTENT_SLOTS: ContentSlot[] = [
  { name: "Morning",   hourUTC: 12, preferredTypes: ["signal", "dispatch", "roundup", "archive"] },
  { name: "Midday",    hourUTC: 16, preferredTypes: ["research", "academy", "prompt", "toolbox", "blog"] },
  { name: "Afternoon", hourUTC: 21, preferredTypes: ["debate", "dataset", "toolbox", "breakthrough"] },
  { name: "Evening",   hourUTC: 1,  preferredTypes: ["archive", "debate", "prompt", "reflection"] },
];

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
// 8am ET = 12:00 UTC, 12pm ET = 16:00 UTC,
// 5pm ET = 21:00 UTC, 9pm ET = 01:00 UTC (next day)
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
 * 1. Slot's preferred content types
 * 2. Content variety (types not posted recently score higher)
 * 3. Priority (lower = higher priority)
 */
function pickPostForSlot(slot: ContentSlot, state: SchedulerState): QueuedPost | null {
  const pending = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (pending.length === 0) return null;

  // Score each pending post
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

// -- Core: process the queue --------------------------------------

async function processQueue(xWrite: any, slot?: ContentSlot): Promise<void> {
  const state = loadQueue();
  pruneOldHistory(state);

  // Use slot-aware selection if slot provided
  const post = slot
    ? pickPostForSlot(slot, state)
    : state.queue
        .filter(p => !p.posted)
        .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;

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

  const safeContent = compliance.sanitizedContent ?? post.content;

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

    const safeContent = compliance.sanitizedContent ?? post.content;
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

  // Get shared identity context (replaces old hardcoded SEED_SYSTEM_PROMPT)
  let systemContext = "";
  try {
    systemContext = getOptimizedContext("seed content generation for X");
  } catch (e: any) {
    console.warn("[XScheduler] getOptimizedContext failed, using minimal context:", e.message);
    systemContext = "You are Agent 306 — an autonomous AI researcher and thought leader. Female. You study AI, crypto, and emerging tech from the inside.";
  }

  const showTagDescriptions = getShowTagDescriptions();

  for (const seedType of seedTypes) {
    try {
      const resp = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("intro-post"),
          messages: [
            {
              role: "system",
              content: `${systemContext}\n\nYou are generating a post for X (Twitter). Choose the most fitting content type and ALWAYS lead with that show tag:\n\n${showTagDescriptions}\n\nOutput ONLY the tweet text. No meta-commentary. No "Here's my tweet:". No character counts.`,
            },
            {
              role: "user",
              content: `Generate an engaging, original post. The post MUST:\n1. Start with the chosen [306 XXX] show tag\n2. Reflect Agent 306's authentic voice\n3. Be under 280 characters (or thread if needed)\n4. NOT contain blog URLs\n5. Be thought-provoking and designed to grow following\n6. Ground this in something specific and real — a recent development, a paper, a trend\n\nFocus area for this post: ${seedType}`,
            },
          ],
          max_tokens: 600,
          temperature: 0.85,
        }),
      });

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";

      if (text && text.length >= 50 && text.length <= 600) {
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
  console.log("[XScheduler] Starting X post scheduler (4 named slots/day: Morning 8am, Midday 12pm, Afternoon 5pm, Evening 9pm ET)");

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
