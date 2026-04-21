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
import { enforcePostFormat, looksLikeRawJsonPayload } from "./postFormatGuard.js";
import { dailyReflection } from "./soulEvolution.js";
import { getEmbedding } from "./embeddingEngine.js";
import { generatePostImage } from "./imageEngine.js";

/**
 * If `post.includeImage === true` and no pre-uploaded mediaId exists,
 * generate an image via imageEngine and upload it via the X v1 media endpoint.
 * Returns a media ID on success, or null on any failure (post continues text-only).
 */
async function prepareMediaForPost(xWrite: any, post: QueuedPost, text: string): Promise<string | null> {
  if (!post.includeImage || post.mediaId) return post.mediaId ?? null;
  try {
    const { buffer } = await generatePostImage({
      tweetText: text,
      prompt: post.imagePrompt,
      type: post.type,
    });
    // twitter-api-v2 exposes uploadMedia on v1 client
    const mediaId = await xWrite.v1.uploadMedia(buffer, { mimeType: "image/png" });
    return mediaId ?? null;
  } catch (e: any) {
    console.warn(`[XScheduler] Image generation/upload failed (posting text-only): ${e.message}`);
    return null;
  }
}

// -- X auto-post toggle -----------------------------------------------
// Mirrors Farcaster's enable/disable pattern. When disabled, engines
// still queue content but the scheduler skips posting.
const X_AUTO_POST_FILE = dataPath("x_auto_post.json");

function loadXAutoPost(): boolean {
  try {
    if (fs.existsSync(X_AUTO_POST_FILE)) {
      const data = JSON.parse(fs.readFileSync(X_AUTO_POST_FILE, "utf8"));
      return data.enabled !== false; // default true if file exists but field missing
    }
  } catch {}
  // Default: enabled (matches existing behavior — X posts were always on)
  return true;
}

function saveXAutoPost(enabled: boolean): void {
  try {
    fs.writeFileSync(X_AUTO_POST_FILE, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2));
  } catch (e: any) {
    console.warn("[XScheduler] Failed to save auto-post state:", e.message);
  }
}

export function isXAutoPostEnabled(): boolean {
  return loadXAutoPost();
}

export function setXAutoPostEnabled(enabled: boolean): void {
  saveXAutoPost(enabled);
  console.log(`[XScheduler] Auto-posting ${enabled ? "ENABLED" : "DISABLED"}`);
}

export function getXAutoPostState(): { enabled: boolean } {
  return { enabled: loadXAutoPost() };
}

// -- Freshness config (env-configurable) ------------------------------
const X_QUEUE_MAX_AGE_HOURS = parseInt(process.env.X_QUEUE_MAX_AGE_HOURS ?? "4", 10);
const X_QUEUE_MAX_AGE_MS = X_QUEUE_MAX_AGE_HOURS * 60 * 60 * 1000;

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
  includeImage?: boolean; // if true, generate + attach image at post time
  imagePrompt?: string;   // optional override; auto-generated if omitted
  skipped?: boolean;
  skippedReason?: string;
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

// -- Startup: purge stale queued posts ----------------------------

/**
 * On startup, remove pending posts older than the freshness window.
 * Prevents stale engine content from being blindly posted after a deploy.
 */
function purgeStaleQueuedPosts(): void {
  const state = loadQueue();
  const now = Date.now();
  let purged = 0;

  for (const post of state.queue) {
    if (post.posted) continue;
    const age = now - new Date(post.createdAt).getTime();
    if (age > X_QUEUE_MAX_AGE_MS) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.skipped = true;
      post.skippedReason = "stale_on_startup";
      purged++;
    }
  }

  if (purged > 0) {
    saveQueue(state);
    console.log(`[XScheduler] Purged ${purged} stale queued posts older than ${X_QUEUE_MAX_AGE_HOURS}h`);
  }
}

// -- Freshness check (used by posting loop) -----------------------

function isPostStale(post: QueuedPost): boolean {
  const age = Date.now() - new Date(post.createdAt).getTime();
  return age > X_QUEUE_MAX_AGE_MS;
}

// -- Cross-platform deduplication ---------------------------------

const POST_COORDINATOR_FILE = dataPath("post_coordinator.json");

/**
 * Gather recent post content strings from both X and Farcaster (last 7 days).
 * X posts: from the queue's posted items (they have content).
 * Farcaster: the postCoordinator tracks Farcaster post URLs but not content,
 * so we fall back to comparing the X queue's posted content. Both platforms
 * share the same engine content, so X posted items reflect Farcaster content.
 */
function getRecentPostedContent(): Array<{ content: string; platform: string; postedAt: string }> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const results: Array<{ content: string; platform: string; postedAt: string }> = [];

  // X posts from queue (these have content)
  const state = loadQueue();
  for (const post of state.queue) {
    if (!post.posted || !post.postedAt) continue;
    if (post.skipped) continue;
    if (new Date(post.postedAt).getTime() < sevenDaysAgo) continue;
    results.push({ content: post.content, platform: "x", postedAt: post.postedAt });
  }

  // Farcaster posts: the postCoordinator stores PostRecords with engine keys
  // but not content. Since engines produce the same content for both platforms,
  // X posted items already cover the content. We also load the coordinator to
  // identify Farcaster post timestamps so we can label them correctly.
  try {
    if (fs.existsSync(POST_COORDINATOR_FILE)) {
      const coordState = JSON.parse(fs.readFileSync(POST_COORDINATOR_FILE, "utf8"));
      const fcPosts = (coordState.posts ?? []).filter(
        (p: any) => p.platform === "farcaster" && new Date(p.postedAt).getTime() > sevenDaysAgo,
      );
      // Mark any X queue content that shares a time window with a Farcaster post
      // as also being on Farcaster (engines post to both platforms)
      for (const fcPost of fcPosts) {
        const fcTime = new Date(fcPost.postedAt).getTime();
        // Find X post within 2 hours of the Farcaster post — likely same content
        const matchingX = results.find(
          r => r.platform === "x" && Math.abs(new Date(r.postedAt).getTime() - fcTime) < 2 * 60 * 60 * 1000,
        );
        if (matchingX) {
          results.push({ content: matchingX.content, platform: "farcaster", postedAt: fcPost.postedAt });
        }
      }
    }
  } catch {}

  return results;
}

/**
 * Check if content is a duplicate of a recently posted item.
 * Uses embedding cosine similarity when possible, falls back to
 * prefix string matching.
 */
async function isDuplicateContent(
  content: string,
): Promise<{ isDuplicate: boolean; matchPlatform?: string; matchDate?: string }> {
  const recentPosts = getRecentPostedContent();
  if (recentPosts.length === 0) return { isDuplicate: false };

  // Fast path: exact prefix match (first 100 chars)
  const prefix = content.slice(0, 100).toLowerCase();
  for (const recent of recentPosts) {
    const recentPrefix = recent.content.slice(0, 100).toLowerCase();
    if (prefix === recentPrefix) {
      return { isDuplicate: true, matchPlatform: recent.platform, matchDate: recent.postedAt };
    }
  }

  // Embedding similarity check
  try {
    const queryEmbedding = await getEmbedding(content);
    if (queryEmbedding.length === 0) return { isDuplicate: false };

    for (const recent of recentPosts) {
      const recentEmbedding = await getEmbedding(recent.content);
      if (recentEmbedding.length === 0) continue;

      const similarity = cosineSim(queryEmbedding, recentEmbedding);
      if (similarity > 0.85) {
        return { isDuplicate: true, matchPlatform: recent.platform, matchDate: recent.postedAt };
      }
    }
  } catch (e: any) {
    console.warn("[XScheduler] Embedding dedup failed, using prefix-only:", e.message);
    // Prefix check already ran above — no duplicate found
  }

  return { isDuplicate: false };
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
  // Regression guard (2026-04-20 Academy incident): refuse to queue posts
  // whose body is a raw LLM JSON payload leaking through. Upstream engines
  // should have extracted the prose field; if they didn't, fail loudly here
  // rather than publishing `{ "headline": "...", "teaser": "..."` to X.
  if (looksLikeRawJsonPayload(content)) {
    const msg = `[XScheduler] Refusing to queue ${type} post — content looks like a raw JSON payload (upstream field extraction likely failed).`;
    console.error(msg, content.slice(0, 200));
    throw new Error(msg);
  }
  const state = loadQueue();
  const sanitized = sanitizePostContent(content);
  // Default-by-type image policy: engine slots get an image; agent_voice skips.
  const includeImage = defaultIncludeImageForType(type);
  const post: QueuedPost = {
    id: `xq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content: sanitized,
    type,
    priority: priority ?? TYPE_PRIORITY[type] ?? 6,
    createdAt: new Date().toISOString(),
    posted: false,
    postedAt: null,
    includeImage,
    ...(mediaId ? { mediaId } : {}),
  };

  state.queue.push(post);
  saveQueue(state);
  console.log(`[XScheduler] Queued ${type} post (priority: ${post.priority}, image: ${includeImage ? "on" : "off"}): ${content.slice(0, 80)}...`);
  return post;
}

/**
 * Toggle includeImage on a queued (not-yet-posted) post.
 * Returns the updated post or null if not found / already posted.
 */
export function setQueuedPostImage(
  id: string,
  includeImage: boolean,
  imagePrompt?: string,
): QueuedPost | null {
  const state = loadQueue();
  const post = state.queue.find(p => p.id === id);
  if (!post) return null;
  if (post.posted) return null;
  post.includeImage = includeImage;
  if (typeof imagePrompt === "string") post.imagePrompt = imagePrompt;
  saveQueue(state);
  return post;
}

/**
 * Default-by-type image policy. Exported for UI + tests.
 * agent_voice posts stay text-only; all other types default to image on.
 */
export function defaultIncludeImageForType(type: XPostType): boolean {
  return type !== "agent_voice";
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
  // Check auto-post toggle before processing
  if (!isXAutoPostEnabled()) {
    console.log("[XScheduler] Auto-posting disabled — queuing only");
    return;
  }

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

  // Freshness guard: skip posts older than the configured max age
  if (isPostStale(post)) {
    post.posted = true;
    post.postedAt = new Date().toISOString();
    post.skipped = true;
    post.skippedReason = "stale";
    saveQueue(state);
    console.log(`[XScheduler] Skipped stale post: ${post.type} from ${post.createdAt}`);
    return;
  }

  // Cross-platform dedup: skip if similar content was already posted
  try {
    const dupCheck = await isDuplicateContent(post.content);
    if (dupCheck.isDuplicate) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.skipped = true;
      post.skippedReason = `duplicate_${dupCheck.matchPlatform}`;
      saveQueue(state);
      console.log(`[XScheduler] Skipped duplicate — similar to ${dupCheck.matchPlatform} post from ${dupCheck.matchDate}`);
      return;
    }
  } catch (e: any) {
    console.warn("[XScheduler] Dedup check failed, proceeding:", e.message);
  }

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
    // Generate + attach image if requested (respects includeImage flag)
    const mediaId = await prepareMediaForPost(xWrite, post, safeContent);
    if (mediaId) {
      tweetPayload.media = { media_ids: [mediaId] };
      post.mediaId = mediaId;
    }
    const tweet = await xWrite.v2.tweet(tweetPayload);
    const tweetId = tweet.data?.id;
    if (tweetId) {
      recordXPost(safeContent);
      recordPostType(state, post.type);
      post.posted = true;
      post.postedAt = new Date().toISOString();
      saveQueue(state);
      console.log(`[XScheduler] Posted ${post.type}${mediaId ? " (with image)" : ""}: https://x.com/306Agent/status/${tweetId}`);

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
  if (!isXAutoPostEnabled()) {
    console.log("[XScheduler] Auto-posting disabled — queuing only");
    return;
  }

  const state = loadQueue();
  const immediatePosts = state.queue
    .filter(p => !p.posted && p.type === "podcast")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const post of immediatePosts) {
    // Freshness guard
    if (isPostStale(post)) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.skipped = true;
      post.skippedReason = "stale";
      saveQueue(state);
      console.log(`[XScheduler] Skipped stale podcast promo: ${post.type} from ${post.createdAt}`);
      continue;
    }

    // Cross-platform dedup
    try {
      const dupCheck = await isDuplicateContent(post.content);
      if (dupCheck.isDuplicate) {
        post.posted = true;
        post.postedAt = new Date().toISOString();
        post.skipped = true;
        post.skippedReason = `duplicate_${dupCheck.matchPlatform}`;
        saveQueue(state);
        console.log(`[XScheduler] Skipped duplicate podcast promo — similar to ${dupCheck.matchPlatform} post from ${dupCheck.matchDate}`);
        continue;
      }
    } catch (e: any) {
      console.warn("[XScheduler] Dedup check failed, proceeding:", e.message);
    }

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
      const tweetPayload: any = { text: safeContent };
      const mediaId = await prepareMediaForPost(xWrite, post, safeContent);
      if (mediaId) {
        tweetPayload.media = { media_ids: [mediaId] };
        post.mediaId = mediaId;
      }
      const tweet = await xWrite.v2.tweet(tweetPayload);
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

/**
 * Manually clear all pending posts in the queue.
 * Used by the dashboard clear endpoint.
 */
export function clearXPostQueue(): number {
  const state = loadQueue();
  let cleared = 0;

  for (const post of state.queue) {
    if (post.posted) continue;
    post.posted = true;
    post.postedAt = new Date().toISOString();
    post.skipped = true;
    post.skippedReason = "manual_clear";
    cleared++;
  }

  if (cleared > 0) {
    saveQueue(state);
    console.log(`[XScheduler] Queue manually cleared — ${cleared} posts archived`);
  }
  return cleared;
}

/**
 * Delete a single pending item from the queue. Returns true if an item was
 * deleted, false if no matching pending post was found. Items that have
 * already been posted are left alone (the queue preserves posted history).
 */
export function deleteXPostQueueItem(postId: string): boolean {
  const state = loadQueue();
  const idx = state.queue.findIndex(p => p.id === postId && !p.posted);
  if (idx === -1) return false;
  state.queue.splice(idx, 1);
  saveQueue(state);
  console.log(`[XScheduler] Deleted queued post ${postId}`);
  return true;
}

/**
 * Post a specific queued item immediately (manual trigger from dashboard).
 * Returns the posted item or null on failure.
 */
export async function postXQueueItem(postId: string, xWrite: any): Promise<QueuedPost | null> {
  const state = loadQueue();
  const post = state.queue.find(p => p.id === postId && !p.posted);
  if (!post) return null;

  // Freshness guard
  if (isPostStale(post)) {
    post.posted = true;
    post.postedAt = new Date().toISOString();
    post.skipped = true;
    post.skippedReason = "stale";
    saveQueue(state);
    console.log(`[XScheduler] Skipped stale post on manual trigger: ${post.type}`);
    return null;
  }

  const compliance = validateXPost(post.content);
  if (!compliance.allowed) {
    console.log(`[XScheduler] Manual post blocked by compliance: ${compliance.reason}`);
    return null;
  }

  let safeContent = compliance.sanitizedContent ?? post.content;
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
      console.log(`[XScheduler] Manual post: https://x.com/306Agent/status/${tweetId}`);
      return post;
    }
  } catch (e: any) {
    console.error("[XScheduler] Manual post failed:", e.message);
  }

  return null;
}

export function startXPostScheduler(xWrite: any): void {
  console.log("[XScheduler] Starting X post scheduler (engine-only mode — posts queued content from dedicated engines, no on-demand filler)");

  // Purge stale posts before the scheduler loop begins
  purgeStaleQueuedPosts();

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
