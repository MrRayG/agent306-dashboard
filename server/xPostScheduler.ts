/**
 * -----------------------------------------------------------------
 *  X POST SCHEDULER — Engine-Only Mode
 *
 *  X posts come exclusively from dedicated content engines
 *  (Signal Brief, Academy, News Dispatch, Research Brief,
 *  Podcast, Community Boost). No on-demand filler generation.
 *
 *  The scheduler is a simple queue drainer: engines queue posts
 *  via queueXPost(), and the scheduler posts them at the next
 *  available window, respecting rate limits (90-min cooldown
 *  from postCoordinator). If there are only 5 engine posts
 *  today, X posts 5 times — same as Farcaster.
 *
 *  All posts go through the compliance guard before posting.
 *  Queue persists to disk via DATA_DIR.
 * -----------------------------------------------------------------
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import { dailyReflection } from "./soulEvolution.js";

// -- Types --------------------------------------------------------

export type XPostType =
  | "intro"
  | "signal"
  | "article"
  | "podcast"
  | "breakthrough"
  | "dispatch"
  | "news"
  | "academy"
  | "blog"
  | "research"
  | "reflection"
  | "roundup"
  | "agent_voice";

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
  news:         4,
  signal:       4,
  roundup:      4,
  article:      5,
  blog:         5,
  research:     5,
  academy:      6,
  reflection:   6,
  agent_voice:  7,
};

// -- Queue check interval -----------------------------------------
// Check for queued engine content every 30 minutes.
// Posts are spaced by the 90-min cooldown in xComplianceGuard.
const QUEUE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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
 * Get a compact summary of what was posted today for cross-engine awareness.
 * Engines inject this into prompts so the LLM knows what topics were already
 * covered and avoids repeating them.
 */
export function getTodaysPostsSummary(): string {
  const state = loadQueue();
  const today = new Date().toISOString().slice(0, 10);
  const todayPosts = state.queue.filter(
    p => p.posted && p.postedAt && p.postedAt.startsWith(today),
  );

  if (todayPosts.length === 0) return "";

  const lines = todayPosts.map(p => {
    const time = p.postedAt
      ? new Date(p.postedAt).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/New_York",
        })
      : "unknown time";
    // Extract first ~80 chars of content as topic hint
    const topic = p.content.replace(/^\[.*?\]\s*/, "").slice(0, 80).trim();
    return `- [${p.type.toUpperCase()}] "${topic}..." (${time} ET)`;
  });

  return `ALREADY POSTED TODAY:\n${lines.join("\n")}\n\nDo NOT repeat topics already covered today. You may reference them naturally if relevant.`;
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
 * Includes pending posts, today's posts, and 7-day type distribution.
 */
export function getXPostQueue(): {
  queue: QueuedPost[];
  postedEpisodes: string[];
  pending: QueuedPost[];
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

  const dist: Record<string, number> = {};
  for (const h of state.postHistory) {
    dist[h.type] = (dist[h.type] ?? 0) + 1;
  }

  return {
    queue: state.queue,
    postedEpisodes: state.postedEpisodes,
    pending,
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

// -- Quality gate — minimal sanity check (not a content gatekeeper) ----------

/**
 * Quality gate — absolute minimum sanity check.
 * Only catches genuinely broken output (empty, gibberish, over char limit).
 * Agent 306 speaks freely — this is NOT a style or quality filter.
 * Returns { pass: true } or { pass: false, reason: string }.
 */
export function qualityCheck(tweet: string, contentType: string): { pass: boolean; reason?: string } {
  // 1. Length: body should be at least 30 chars (catches empty/gibberish)
  const bodyOnly = tweet
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\n#\w+[\s\S]*$/, '')
    .replace(/\n\n[-—–]+\s*Agent\s*306\s*$/, '')
    .trim();
  if (bodyOnly.length < 30) {
    return { pass: false, reason: `Body too short (${bodyOnly.length} chars)` };
  }

  // 2. Character limit (X Premium Plus)
  if (tweet.length > 25000) {
    return { pass: false, reason: `Over character limit (${tweet.length} chars)` };
  }

  return { pass: true };
}

// -- Core: process the queue (engine-only — no on-demand generation) --------

/**
 * Drain the queue: pick the highest-priority unposted item and post it.
 * If the queue is empty, skip — no filler generation. X only posts
 * content from dedicated engines (same as Farcaster).
 */
async function processQueue(xWrite: any): Promise<void> {
  const state = loadQueue();
  pruneOldHistory(state);

  const post = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;

  if (!post) {
    console.log("[XScheduler] No engine content queued — skipping");
    return;
  }

  console.log(`[XScheduler] Processing: ${post.type} (priority: ${post.priority})`);

  // Run through compliance guard
  const compliance = validateXPost(post.content);
  if (!compliance.allowed) {
    console.log(`[XScheduler] Post blocked by compliance: ${compliance.reason}`);
    // Rate limit rejections are temporary — DON'T mark as posted.
    // The post stays in queue for the next check.
    // Only kill the post for hard safety rejections (content filter).
    if (compliance.reason?.includes('content filter')) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      saveQueue(state);
      console.log(`[XScheduler] Post permanently killed (safety violation)`);
    } else {
      console.log(`[XScheduler] Post preserved in queue — will retry next check`);
    }
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

      // Trigger daily soul reflection after the last post of the day (after 10pm ET / 02:00 UTC)
      const nowUTC = new Date().getUTCHours();
      if (nowUTC >= 2 && nowUTC < 6) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const todaysPosts = state.queue
          .filter(p => p.posted && p.postedAt?.startsWith(todayStr))
          .map(p => ({ text: p.content, score: 0, url: "" }));
        dailyReflection(todaysPosts).catch(err =>
          console.warn("[XScheduler] Daily reflection failed:", err.message)
        );
      }
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

// -- Scheduler loop -----------------------------------------------

export function startXPostScheduler(xWrite: any): void {
  console.log("[XScheduler] Starting X post scheduler (engine-only mode — posts queued content from dedicated engines, no on-demand filler)");

  // Process immediate items (podcast promos) every 5 minutes
  setInterval(() => {
    processImmediateQueue(xWrite).catch(e =>
      console.error("[XScheduler] Immediate queue error:", e.message),
    );
  }, 5 * 60 * 1000);

  // Check for queued engine content every 30 minutes.
  // The compliance guard's 90-min cooldown handles rate limiting.
  setInterval(() => {
    processQueue(xWrite).catch(e =>
      console.error("[XScheduler] Queue processing error:", e.message),
    );
  }, QUEUE_CHECK_INTERVAL_MS);

  // Initial check — post any queued content shortly after startup
  const state = loadQueue();
  const pendingCount = state.queue.filter(p => !p.posted).length;
  if (pendingCount > 0) {
    console.log(`[XScheduler] ${pendingCount} queued engine post(s) found at startup — processing soon`);
    setTimeout(() => processQueue(xWrite).catch(console.error), 10_000);
  }
}
