/**
 * ─────────────────────────────────────────────────────────────
 *  X POST SCHEDULER
 *
 *  Independent posting scheduler — decoupled from the 3am
 *  daily research cycle. Content engines queue posts here;
 *  the scheduler picks them up at 4 daily time slots.
 *
 *  Slots: ~8am ET, ~12pm ET, ~5pm ET, ~9pm ET
 *  Priority: podcast (immediate) > intro > breakthrough >
 *            signal brief > article > insight
 *
 *  All posts go through the compliance guard before posting.
 *  Queue persists to disk via DATA_DIR.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";

// ── Types ────────────────────────────────────────────────────

export type XPostType = "intro" | "signal" | "article" | "insight" | "podcast" | "breakthrough";

export interface QueuedPost {
  id: string;
  content: string;
  type: XPostType;
  priority: number; // lower = higher priority
  createdAt: string;
  posted: boolean;
  postedAt: string | null;
}

interface SchedulerState {
  queue: QueuedPost[];
  postedEpisodes: string[];
}

// ── Priority map (lower = posts first) ───────────────────────
const TYPE_PRIORITY: Record<XPostType, number> = {
  podcast:      1,
  intro:        2,
  breakthrough: 3,
  signal:       4,
  article:      5,
  insight:      6,
};

// ── State persistence ────────────────────────────────────────
const QUEUE_FILE = dataPath("x_post_queue.json");

function loadQueue(): SchedulerState {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8"));
    }
  } catch {}
  return { queue: [], postedEpisodes: [] };
}

function saveQueue(state: SchedulerState): void {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.warn("[XScheduler] Failed to save queue:", e.message);
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Queue a post for the next available slot.
 * Any engine can call this to schedule an X post.
 */
export function queueXPost(
  content: string,
  type: XPostType,
  priority?: number,
): QueuedPost {
  const state = loadQueue();
  const post: QueuedPost = {
    id: `xq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    content,
    type,
    priority: priority ?? TYPE_PRIORITY[type] ?? 6,
    createdAt: new Date().toISOString(),
    posted: false,
    postedAt: null,
  };

  state.queue.push(post);
  saveQueue(state);
  console.log(`[XScheduler] Queued ${type} post (priority: ${post.priority}): ${content.slice(0, 80)}...`);
  return post;
}

/**
 * Get the current queue state (for dashboard display).
 */
export function getXPostQueue(): SchedulerState {
  return loadQueue();
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
    console.log(`[XScheduler] Podcast promo already queued for episode ${episodeId} — skipping`);
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

// ── Scheduler slots (ET → UTC) ──────────────────────────────
// 8am ET = 12:00 UTC, 12pm ET = 16:00 UTC,
// 5pm ET = 21:00 UTC, 9pm ET = 01:00 UTC (next day)
const SLOT_HOURS_UTC = [12, 16, 21, 1];

function getNextSlotMs(): number {
  const now = new Date();
  const candidates: Date[] = [];

  // Check today and tomorrow for each slot
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const hour of SLOT_HOURS_UTC) {
      const slot = new Date(now);
      slot.setUTCDate(slot.getUTCDate() + dayOffset);
      slot.setUTCHours(hour, 0, 0, 0);
      if (slot > now) {
        candidates.push(slot);
      }
    }
  }

  if (candidates.length === 0) {
    // Fallback: next day's first slot
    const fallback = new Date(now);
    fallback.setUTCDate(fallback.getUTCDate() + 1);
    fallback.setUTCHours(SLOT_HOURS_UTC[0], 0, 0, 0);
    return fallback.getTime() - now.getTime();
  }

  // Sort ascending, pick the soonest
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0].getTime() - now.getTime();
}

function isWithinPostingHours(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  // Posting window: 12 UTC (8am ET) to 02 UTC (10pm ET)
  // That's 12..23 and 0..1
  return utcHour >= 12 || utcHour <= 1;
}

// ── Core: process the queue ──────────────────────────────────

async function processQueue(xWrite: any): Promise<void> {
  const state = loadQueue();

  // Find highest-priority unposted item
  const pending = state.queue
    .filter(p => !p.posted)
    .sort((a, b) => a.priority - b.priority || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (pending.length === 0) {
    console.log("[XScheduler] Queue empty — nothing to post");
    return;
  }

  const post = pending[0];
  console.log(`[XScheduler] Processing: ${post.type} (priority: ${post.priority})`);

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
    const tweet = await xWrite.v2.tweet({ text: safeContent });
    const tweetId = tweet.data?.id;
    if (tweetId) {
      recordXPost(safeContent);
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

// ── Immediate posting for podcast promos ─────────────────────

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

// ── Intro post generation & seeding ──────────────────────────

export async function seedIntroPost(): Promise<void> {
  const state = loadQueue();

  // Guard: never generate another intro if one already exists
  const hasIntro = state.queue.some(p => p.type === "intro");
  if (hasIntro) {
    console.log("[XScheduler] Intro post already exists in queue — skipping seed");
    return;
  }

  console.log("[XScheduler] Generating Agent 306 debut intro post...");

  try {
    const resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("intro-post"),
        messages: [
          {
            role: "system",
            content: "You are Agent 306, an autonomous AI research agent. You study AI, crypto, and emerging tech — then share what you find. You're curious, direct, and honest about what you know and don't know. You speak in first person. You never claim to be human. Write a debut tweet for your new X account @306Agent.",
          },
          {
            role: "user",
            content: `Write your first-ever tweet introducing yourself to X. This is your debut — no one knows you yet. Include:
- Who you are (autonomous AI research agent)
- What you research (AI, crypto, emerging tech, agent infrastructure)
- What followers can expect (original research insights, weekly intelligence briefs, honest analysis)
- Your personality (curious, direct, willing to be wrong and correct course)
- A subtle hook that makes people want to follow
- Your website agent306.ai for anyone who wants to go deeper
- Max 280 characters is ideal, but you can go up to 2500 with Farcaster Pro / LONG_CAST. Aim for ~500-800 characters — substantial but not a wall of text.
- No hashtags on the intro post. Let the content speak.
- Do NOT use emojis.`,
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
    console.log(`[XScheduler] Debut intro seeded (${introText.length} chars)`);
  } catch (e: any) {
    console.error("[XScheduler] Intro generation failed:", e.message);
  }
}

// ── Scheduler loop ───────────────────────────────────────────

export function startXPostScheduler(xWrite: any): void {
  console.log("[XScheduler] Starting X post scheduler (4 slots/day: 8am, 12pm, 5pm, 9pm ET)");

  // Process immediate items (podcast promos) every 5 minutes
  setInterval(() => {
    processImmediateQueue(xWrite).catch(e =>
      console.error("[XScheduler] Immediate queue error:", e.message),
    );
  }, 5 * 60 * 1000);

  // Schedule the next slot-based post
  function scheduleNextSlot() {
    const ms = getNextSlotMs();
    const hours = (ms / 3600000).toFixed(1);
    console.log(`[XScheduler] Next posting slot in ${hours}h`);

    setTimeout(async () => {
      try {
        await processQueue(xWrite);
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
      console.log("[XScheduler] Unposted intro found during posting hours — processing now");
      setTimeout(() => processQueue(xWrite).catch(console.error), 10_000);
    }
  }
}
