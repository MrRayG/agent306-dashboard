/**
 * -----------------------------------------------------------------
 *  X POST SCHEDULER
 *
 *  Independent posting scheduler -- decoupled from the 3am
 *  daily research cycle. Content engines queue posts here;
 *  the scheduler picks them up at 12 daily time slots (every 2 hours).
 *
 *  12-slot daily schedule (every 2 hours starting 8 AM ET):
 *    8 AM ET  — [306 NEWS]        (morning news dispatch)
 *    10 AM ET — [306 SIGNAL]      (pattern recognition)
 *    12 PM ET — [306 RESEARCH]    (deep dive)
 *    2 PM ET  — agent_voice       (Agent 306 speaks freely)
 *    4 PM ET  — agent_voice       (Agent 306 speaks freely)
 *    6 PM ET  — [306 ROUND UP]    (daily roundup)
 *    8 PM ET  — [THE DISPATCH]    (flagship evening dispatch)
 *    10 PM ET — [306 REFLECTION]  (philosophical, open questions)
 *    12 AM ET — agent_voice       (Agent 306 speaks freely)
 *    2 AM ET  — agent_voice       (Agent 306 speaks freely)
 *    4 AM ET  — agent_voice       (Agent 306 speaks freely)
 *    6 AM ET  — agent_voice       (Agent 306 speaks freely)
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
import { buildTweetSystemPrompt, buildTweetUserPrompt } from "./tweetPromptBuilder.js";
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
  agent_voice:  5,
};

// -- Named content slots ------------------------------------------
// 12-slot daily schedule: every 2 hours starting 8 AM ET.
// Structured slots have FIXED show tags; agent_voice slots are free-form.
interface ContentSlot {
  name: string;
  hourUTC: number;       // UTC hour for this slot
  preferredTypes: XPostType[];
  requiredContentType?: string; // locked content type for this slot (maps to contentTypes.ts key)
  agentChoice?: boolean;        // true = agent picks any format (7pm creative freedom slot)
}

const CONTENT_SLOTS: ContentSlot[] = [
  { name: "Morning News",      hourUTC: 12, preferredTypes: ["news", "signal", "roundup"],       requiredContentType: "news" },                                            // 8 AM ET — [306 NEWS]
  { name: "Morning Signal",    hourUTC: 14, preferredTypes: ["signal", "academy"],               requiredContentType: "signal" },                                          // 10 AM ET — [306 SIGNAL]
  { name: "Midday Research",   hourUTC: 16, preferredTypes: ["research", "blog"],                requiredContentType: "research" },                                        // 12 PM ET — [306 RESEARCH]
  { name: "Afternoon Free",    hourUTC: 18, preferredTypes: ["agent_voice"],                     requiredContentType: "agent_voice", agentChoice: true },                   // 2 PM ET — Agent 306 speaks freely
  { name: "Afternoon Free 2",  hourUTC: 20, preferredTypes: ["agent_voice"],                     requiredContentType: "agent_voice", agentChoice: true },                   // 4 PM ET — Agent 306 speaks freely
  { name: "Evening Roundup",   hourUTC: 22, preferredTypes: ["roundup", "signal"],               requiredContentType: "roundup" },                                         // 6 PM ET — [306 ROUND UP]
  { name: "The Dispatch",      hourUTC: 0,  preferredTypes: ["dispatch"],                        requiredContentType: "dispatch" },                                        // 8 PM ET — [THE DISPATCH]
  { name: "Late Reflection",   hourUTC: 2,  preferredTypes: ["reflection"],                      requiredContentType: "reflection" },                                      // 10 PM ET — [306 REFLECTION]
  { name: "Midnight Free",     hourUTC: 4,  preferredTypes: ["agent_voice"],                     requiredContentType: "agent_voice", agentChoice: true },                   // 12 AM ET — Agent 306 speaks freely
  { name: "Late Night Free",   hourUTC: 6,  preferredTypes: ["agent_voice"],                     requiredContentType: "agent_voice", agentChoice: true },                   // 2 AM ET — Agent 306 speaks freely
  { name: "Pre-Dawn Free",     hourUTC: 8,  preferredTypes: ["agent_voice"],                     requiredContentType: "agent_voice", agentChoice: true },                   // 4 AM ET — Agent 306 speaks freely
  { name: "Early Morning Free", hourUTC: 10, preferredTypes: ["agent_voice"],                    requiredContentType: "agent_voice", agentChoice: true },                   // 6 AM ET — Agent 306 speaks freely
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
// 12 slots, every 2 hours: 8am ET=12 UTC, 10am=14, 12pm=16, 2pm=18,
// 4pm=20, 6pm=22, 8pm=0, 10pm=2, 12am=4, 2am=6, 4am=8, 6am=10
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
  // With 12 slots every 2 hours, we post around the clock
  return true;
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

// -- Quality gate — rejects tweets that don't meet Agent 306's standards --

/**
 * Quality gate — lightweight check. Only catches broken posts.
 * Agent 306 speaks freely — no opinion policing, no opener gatekeeping.
 * Returns { pass: true } or { pass: false, reason: string }.
 */
export function qualityCheck(tweet: string, contentType: string): { pass: boolean; reason?: string } {
  // 1. Completeness: must not end with "..." or "—" (truncated thought)
  const body = tweet.replace(/\n\n[-—–]+\s*Agent\s*306\s*$/, '').replace(/#\w+/g, '').trim();
  if (body.endsWith('...') || body.endsWith('—')) {
    return { pass: false, reason: 'Incomplete thought — ends with ellipsis or dash' };
  }

  // 2. Length: body should be at least 50 chars (catches empty/gibberish)
  const bodyOnly = tweet
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\n#\w+[\s\S]*$/, '')
    .replace(/\n\n[-—–]+\s*Agent\s*306\s*$/, '')
    .trim();
  if (bodyOnly.length < 50) {
    return { pass: false, reason: `Body too short (${bodyOnly.length} chars)` };
  }

  // 3. Character limit
  if (tweet.length > 25000) {
    return { pass: false, reason: `Over character limit (${tweet.length} chars)` };
  }

  return { pass: true };
}

// -- On-demand content generation for empty required slots --------

/**
 * Generate a post on-demand when no matching content exists in the queue
 * for a slot's required content type. Uses the voice-first prompt builder.
 */
// Token limits by content type — richer types get more room,
// the format guard handles final shaping.
const TOKEN_LIMITS: Record<string, number> = {
  news:         600,   // morning news — concise but complete
  dispatch:     800,   // flagship evening dispatch — one signal, two sides (~1,500-1,700 chars)
  signal:       800,   // analysis needs room for the "why"
  research:     1000,  // deep dives need space
  roundup:      1200,  // 3-5 stories need the most room
  reflection:   600,   // evening thoughts — not artificially short
  academy:      1000,  // teaching needs detail
  agent_voice:  600,   // free-form — 400-1200 chars, moderate token budget
};
const DEFAULT_TOKEN_LIMIT = 600;

async function generateOnDemandPost(type: XPostType, state: SchedulerState): Promise<QueuedPost | null> {
  const systemPrompt = buildTweetSystemPrompt(type);
  const basePrompt = buildTweetUserPrompt(type);
  if (!basePrompt) return null;

  // Inject today's posts so she doesn't repeat topics
  const todaysSummary = getTodaysPostsSummary();
  const todaysPending = state.queue
    .filter(p => !p.posted && p.content)
    .map(p => p.content.slice(0, 100))
    .join(" | ");
  const dedupContext = todaysSummary || todaysPending
    ? `\n\nALREADY POSTED/QUEUED TODAY (DO NOT repeat these topics or entities):\n${todaysSummary}${todaysPending ? `\nQueued: ${todaysPending}` : ''}`
    : '';
  const userPrompt = basePrompt + dedupContext;

  const tokenLimit = TOKEN_LIMITS[type] || DEFAULT_TOKEN_LIMIT;

  // Retry up to 3 times — never skip a slot
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];
      const resp = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("intro-post"),
          messages,
          max_tokens: tokenLimit,
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await resp.json();
      let text = data.choices?.[0]?.message?.content?.trim() ?? "";

      if (text && text.length >= 50) {
        const qc = qualityCheck(text, type);
        if (!qc.pass) {
          console.log(`[XScheduler] On-demand ${type} attempt ${attempt}/3 — ${qc.reason}`);
          continue; // retry with a fresh generation
        }

        text = enforceShowTag(text, type);
        const post = queueXPost(text, type);
        console.log(`[XScheduler] On-demand ${type} generated (${text.length} chars, attempt ${attempt})`);
        const freshState = loadQueue();
        const freshPost = freshState.queue.find(p => p.id === post.id);
        if (freshPost) {
          state.queue = freshState.queue;
          return freshPost;
        }
        return post;
      }
      console.warn(`[XScheduler] On-demand ${type} attempt ${attempt}/3 returned short content (${text.length} chars)`);
    } catch (e: any) {
      console.error(`[XScheduler] On-demand ${type} attempt ${attempt}/3 failed:`, e.message);
    }
  }
  console.error(`[XScheduler] On-demand ${type} failed all 3 attempts`);
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
  // agent_voice slots (agentChoice: true) also get on-demand generation
  if (!post && slot?.requiredContentType) {
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

      // Trigger daily soul reflection after the Late Reflection (10pm) slot
      if (slot?.name === "Late Reflection") {
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

  // Collect today's posts for dedup across all seed generations
  const todaysSummary = getTodaysPostsSummary();

  for (const seedType of seedTypes) {
    try {
      const systemPrompt = buildTweetSystemPrompt(seedType);
      const baseUserPrompt = buildTweetUserPrompt(seedType);
      const dedupNote = todaysSummary
        ? `\n\nALREADY POSTED TODAY (pick a DIFFERENT topic):\n${todaysSummary}`
        : '';
      const userPrompt = baseUserPrompt + dedupNote;

      const generate = async (): Promise<string> => {
        const messages: Array<{ role: string; content: string }> = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];
        const resp = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel("intro-post"),
            messages,
            max_tokens: TOKEN_LIMITS[seedType] || DEFAULT_TOKEN_LIMIT,
            temperature: 0.85,
          }),
        });
        const data = await resp.json();
        return data.choices?.[0]?.message?.content?.trim() ?? "";
      };

      let text = await generate();

      if (text && text.length >= 50) {
        // Lightweight quality check — only catches broken posts
        const qc = qualityCheck(text, seedType);
        if (!qc.pass) {
          console.log(`[XScheduler] Seed ${seedType}: ${qc.reason} — skipping this type`);
          continue;
        }

        text = enforceShowTag(text, seedType);
        text = enforcePostFormat(text, seedType);
        queueXPost(text, seedType);
        console.log(`[XScheduler] Seeded ${seedType} post (${text.length} chars)`);
      } else {
        console.warn(`[XScheduler] Seed ${seedType} returned short content (${text.length} chars)`);
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
  console.log("[XScheduler] Starting X post scheduler (12 slots/day, every 2 hours starting 8am ET)");

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
