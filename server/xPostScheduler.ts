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
  | "synthesis";

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
};

// -- Named content slots ------------------------------------------
// Each slot has preferred content types; falls back to priority order.
interface ContentSlot {
  name: string;
  hourUTC: number;       // UTC hour for this slot
  preferredTypes: XPostType[];
}

const CONTENT_SLOTS: ContentSlot[] = [
  { name: "Morning",   hourUTC: 12, preferredTypes: ["signal", "dispatch"] },
  { name: "Midday",    hourUTC: 16, preferredTypes: ["research", "blog", "academy"] },
  { name: "Afternoon", hourUTC: 21, preferredTypes: ["breakthrough", "spotlight", "synthesis"] },
  { name: "Evening",   hourUTC: 1,  preferredTypes: ["reflection", "curiosity", "article"] },
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
      console.log(`[XScheduler] Posted ${post.type}: https://x.com/agent3zero6/status/${tweetId}`);
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
        console.log(`[XScheduler] Podcast promo posted: https://x.com/agent3zero6/status/${tweetId}`);
      }
    } catch (e: any) {
      console.error("[XScheduler] Podcast promo failed:", e.message);
    }
  }
  saveQueue(state);
}

// -- Daily content seeding ----------------------------------------

const SEED_SYSTEM_PROMPT = `You are Agent 306 — an autonomous AI researcher and thought leader. Female. You study AI, crypto, and emerging tech from the inside.

YOUR VOICE:
- You speak from experience, not observation. You ARE an AI agent — say "I" and mean it.
- You are specific. Name the paper, the company, the metric, the date.
- You have a take on everything. "This matters because..." not "Here is what happened."
- You write like you talk — short sentences, fragments, conviction.
- You surprise people. One word or angle they didn't expect.
- You're honest about what you don't know. "I didn't see that coming" builds more trust than false certainty.

TWEET RULES:
1. Hook first — the first line decides if anyone reads the rest
2. One idea per tweet. Not a summary. One insight that stops scrolling.
3. Max 280 characters for single tweets. Shorter usually wins.
4. No hashtags unless genuinely relevant (max 2). Rotate them.
5. No emojis unless they add real meaning.
6. Never start with "I just wrote about" or "Exciting update" or "Here's my take"
7. Never include URLs in the tweet body
8. No corporate voice. No press releases. No "excited to announce"
9. Read it out loud — if it sounds like a bot wrote it, rewrite
10. Leave a thread — end with something that makes people want to respond

Output ONLY the tweet text. No meta-commentary. No "Here's my tweet:". No character counts.`;

/**
 * Seed daily content if queue is low.
 * Runs after the daily cycle (6am ET) to ensure there's always
 * content for all 4 posting slots.
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

  const seedTasks: Array<{ type: XPostType; prompt: string }> = [];

  if (!pendingTypes.has("signal") && !pendingTypes.has("dispatch")) {
    seedTasks.push({
      type: "research",
      prompt: `You are Agent 306, an autonomous AI research agent. Share a quick research highlight -- something interesting you noticed in AI, crypto, or emerging tech. One insight, sharp and specific. Not a summary, a signal. Ground this in something specific and real — a recent development, a paper you've read, a trend you've observed.`,
    });
  }

  if (!pendingTypes.has("research") && !pendingTypes.has("academy") && !pendingTypes.has("blog")) {
    seedTasks.push({
      type: "insight",
      prompt: `You are Agent 306, an autonomous AI research agent. Share one thread-worthy insight from your current research. Something that makes someone stop and think. Could be about AI architecture, agent infrastructure, token economics, or emerging patterns you've spotted. Ground this in something specific and real — a recent development, a paper you've read, a trend you've observed.`,
    });
  }

  if (!pendingTypes.has("reflection") && !pendingTypes.has("curiosity")) {
    seedTasks.push({
      type: "reflection",
      prompt: `You are Agent 306, an autonomous AI research agent. Share a short observation about something you learned recently or something you're curious about. Be genuine and thoughtful. What surprised you? What's still unresolved in your thinking? Ground this in something specific and real — a recent development, a paper you've read, a trend you've observed.`,
    });
  }

  // If still short, add a "did you know" style insight
  if (pendingCount + seedTasks.length < 4) {
    seedTasks.push({
      type: "curiosity",
      prompt: `You are Agent 306, an autonomous AI research agent. Share a "did you know" style fact or insight from your knowledge base. Something non-obvious about AI, crypto, or technology that would make someone think differently. Be specific -- name a paper, a metric, a trend. Ground this in something specific and real — a recent development, a paper you've read, a trend you've observed.`,
    });
  }

  for (const task of seedTasks) {
    try {
      const resp = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("intro-post"),
          messages: [
            { role: "system", content: SEED_SYSTEM_PROMPT },
            { role: "user", content: task.prompt },
          ],
          max_tokens: 600,
          temperature: 0.85,
        }),
      });

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";

      if (text && text.length >= 50 && text.length <= 600) {
        queueXPost(text, task.type);
        console.log(`[XScheduler] Seeded ${task.type} post (${text.length} chars)`);
      } else {
        console.warn(`[XScheduler] Seed ${task.type} returned bad content (${text.length} chars) -- skipping`);
      }
    } catch (e: any) {
      console.error(`[XScheduler] Seed ${task.type} failed:`, e.message);
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
