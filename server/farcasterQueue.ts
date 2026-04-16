/**
 * -----------------------------------------------------------------
 *  FARCASTER POST QUEUE — Parallel to X Post Scheduler
 *
 *  Engines queue posts via queueFarcasterPost(), and the scheduler
 *  drains the queue when auto-posting is enabled, respecting rate
 *  limits. When auto-post is OFF, content accumulates until the
 *  user manually triggers "Post Now" from the dashboard.
 *
 *  Freshness guard: posts older than 4h are purged.
 *  Cross-platform dedup: reuses the same embedding-based dedup.
 * -----------------------------------------------------------------
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { postCast, isFarcasterEnabled } from "./farcasterEngine.js";
import { registerPost } from "./postCoordinator.js";
import { getEmbedding } from "./embeddingEngine.js";
import { enforceShowTag } from "./contentTypes.js";
import { stripUnverifiedMentions, determineChannel } from "./farcasterEngine.js";

// -- Freshness config (env-configurable) --------------------------------
const FC_QUEUE_MAX_AGE_HOURS = parseInt(process.env.FC_QUEUE_MAX_AGE_HOURS ?? "4", 10);
const FC_QUEUE_MAX_AGE_MS = FC_QUEUE_MAX_AGE_HOURS * 60 * 60 * 1000;

// -- Types --------------------------------------------------------------

export type FarcasterPostType =
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

export interface FarcasterQueuedPost {
  id: string;
  content: string;
  type: FarcasterPostType;
  priority: number;
  createdAt: string;
  posted: boolean;
  postedAt: string | null;
  castUrl: string | null;
  channel?: string;
  skipped?: boolean;
  skippedReason?: string;
}

interface FarcasterQueueState {
  queue: FarcasterQueuedPost[];
}

// -- Priority map (lower = posts first) ---------------------------------
const TYPE_PRIORITY: Record<FarcasterPostType, number> = {
  podcast:      1,
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

// -- Queue check interval -----------------------------------------------
const QUEUE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// -- State persistence --------------------------------------------------
const QUEUE_FILE = dataPath("farcaster_post_queue.json");

function loadQueue(): FarcasterQueueState {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
      return { queue: raw.queue ?? [] };
    }
  } catch {}
  return { queue: [] };
}

function saveQueue(state: FarcasterQueueState): void {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.warn("[FarcasterQueue] Failed to save queue:", e.message);
  }
}

// -- Freshness check ----------------------------------------------------

function isPostStale(post: FarcasterQueuedPost): boolean {
  const age = Date.now() - new Date(post.createdAt).getTime();
  return age > FC_QUEUE_MAX_AGE_MS;
}

// -- Startup: purge stale queued posts ----------------------------------

function purgeStaleQueuedPosts(): void {
  const state = loadQueue();
  const now = Date.now();
  let purged = 0;

  for (const post of state.queue) {
    if (post.posted) continue;
    const age = now - new Date(post.createdAt).getTime();
    if (age > FC_QUEUE_MAX_AGE_MS) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.skipped = true;
      post.skippedReason = "stale_on_startup";
      purged++;
    }
  }

  if (purged > 0) {
    saveQueue(state);
    console.log(`[FarcasterQueue] Purged ${purged} stale queued posts older than ${FC_QUEUE_MAX_AGE_HOURS}h`);
  }
}

// -- Cross-platform dedup -----------------------------------------------

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

function getRecentPostedContent(): Array<{ content: string; postedAt: string }> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const state = loadQueue();
  return state.queue
    .filter(p => p.posted && p.postedAt && !p.skipped && new Date(p.postedAt).getTime() > sevenDaysAgo)
    .map(p => ({ content: p.content, postedAt: p.postedAt! }));
}

async function isDuplicateContent(content: string): Promise<boolean> {
  const recentPosts = getRecentPostedContent();
  if (recentPosts.length === 0) return false;

  const prefix = content.slice(0, 100).toLowerCase();
  for (const recent of recentPosts) {
    if (recent.content.slice(0, 100).toLowerCase() === prefix) return true;
  }

  try {
    const queryEmbedding = await getEmbedding(content);
    if (queryEmbedding.length === 0) return false;

    for (const recent of recentPosts) {
      const recentEmbedding = await getEmbedding(recent.content);
      if (recentEmbedding.length === 0) continue;
      if (cosineSim(queryEmbedding, recentEmbedding) > 0.85) return true;
    }
  } catch (e: any) {
    console.warn("[FarcasterQueue] Embedding dedup failed:", e.message);
  }

  return false;
}

// -- Public API ---------------------------------------------------------

/**
 * Queue a post for Farcaster. Any engine can call this.
 */
export function queueFarcasterPost(
  content: string,
  type: FarcasterPostType,
  priority?: number,
  channel?: string,
): FarcasterQueuedPost {
  const state = loadQueue();
  const post: FarcasterQueuedPost = {
    id: `fcq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content: content.trim(),
    type,
    priority: priority ?? TYPE_PRIORITY[type] ?? 6,
    createdAt: new Date().toISOString(),
    posted: false,
    postedAt: null,
    castUrl: null,
    ...(channel ? { channel } : {}),
  };

  state.queue.push(post);
  saveQueue(state);
  console.log(`[FarcasterQueue] Queued ${type} post (priority: ${post.priority}): ${content.slice(0, 80)}...`);
  return post;
}

/**
 * Get the current queue state (for dashboard display).
 */
export function getFarcasterPostQueue(): {
  queue: FarcasterQueuedPost[];
  pending: FarcasterQueuedPost[];
  postedToday: FarcasterQueuedPost[];
} {
  const state = loadQueue();
  const today = new Date().toISOString().slice(0, 10);

  const postedToday = state.queue.filter(
    p => p.posted && p.postedAt && p.postedAt.startsWith(today) && !p.skipped,
  );

  const pending = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return { queue: state.queue, pending, postedToday };
}

/**
 * Manually clear all pending posts in the queue.
 */
export function clearFarcasterPostQueue(): number {
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
    console.log(`[FarcasterQueue] Queue manually cleared — ${cleared} posts archived`);
  }
  return cleared;
}

/**
 * Post a specific queued item immediately (manual trigger from dashboard).
 * Returns the posted item or null on failure.
 */
export async function postFarcasterQueueItem(postId: string): Promise<FarcasterQueuedPost | null> {
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
    console.log(`[FarcasterQueue] Skipped stale post: ${post.type} from ${post.createdAt}`);
    return null;
  }

  const text = stripUnverifiedMentions(post.content).slice(0, 2500);
  const channel = post.channel || determineChannel(text) || undefined;

  try {
    const cast = await postCast({ text, channel });
    if (cast) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.castUrl = cast.url;
      saveQueue(state);
      registerPost(post.type, cast.url, post.type, "farcaster");
      console.log(`[FarcasterQueue] Posted ${post.type}: ${cast.url}`);
      return post;
    }
  } catch (e: any) {
    console.error(`[FarcasterQueue] Post failed:`, e.message);
  }

  return null;
}

// -- Core: drain the queue -----------------------------------------------

async function processQueue(): Promise<void> {
  if (!isFarcasterEnabled()) {
    console.log("[FarcasterQueue] Auto-post disabled — queue preserved");
    return;
  }

  const state = loadQueue();
  const post = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;

  if (!post) {
    console.log("[FarcasterQueue] No content queued — skipping");
    return;
  }

  console.log(`[FarcasterQueue] Processing: ${post.type} (priority: ${post.priority})`);

  // Freshness guard
  if (isPostStale(post)) {
    post.posted = true;
    post.postedAt = new Date().toISOString();
    post.skipped = true;
    post.skippedReason = "stale";
    saveQueue(state);
    console.log(`[FarcasterQueue] Skipped stale post: ${post.type} from ${post.createdAt}`);
    return;
  }

  // Cross-platform dedup
  try {
    if (await isDuplicateContent(post.content)) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.skipped = true;
      post.skippedReason = "duplicate";
      saveQueue(state);
      console.log(`[FarcasterQueue] Skipped duplicate post`);
      return;
    }
  } catch (e: any) {
    console.warn("[FarcasterQueue] Dedup check failed, proceeding:", e.message);
  }

  const text = stripUnverifiedMentions(post.content).slice(0, 2500);
  const channel = post.channel || determineChannel(text) || undefined;

  try {
    const cast = await postCast({ text, channel });
    if (cast) {
      post.posted = true;
      post.postedAt = new Date().toISOString();
      post.castUrl = cast.url;
      saveQueue(state);
      registerPost(post.type, cast.url, post.type, "farcaster");
      console.log(`[FarcasterQueue] Posted ${post.type}: ${cast.url}`);
    } else {
      console.warn("[FarcasterQueue] postCast returned null — check Farcaster config");
    }
  } catch (e: any) {
    console.error("[FarcasterQueue] Post failed:", e.message);
  }
}

// -- Scheduler loop -----------------------------------------------------

export function startFarcasterPostScheduler(): void {
  console.log("[FarcasterQueue] Starting Farcaster post scheduler (queue drain mode)");

  purgeStaleQueuedPosts();

  // Check for queued content every 30 minutes
  setInterval(() => {
    processQueue().catch(e =>
      console.error("[FarcasterQueue] Queue processing error:", e.message),
    );
  }, QUEUE_CHECK_INTERVAL_MS);

  // Initial check shortly after startup
  const state = loadQueue();
  const pendingCount = state.queue.filter(p => !p.posted).length;
  if (pendingCount > 0) {
    console.log(`[FarcasterQueue] ${pendingCount} queued post(s) found at startup — processing soon`);
    setTimeout(() => processQueue().catch(console.error), 15_000);
  }
}
