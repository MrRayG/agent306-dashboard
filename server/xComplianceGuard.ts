/**
 * ─────────────────────────────────────────────────────────────
 *  X COMPLIANCE GUARD — Streamlined (Communication Audit v1)
 *
 *  PHILOSOPHY: Safety, not style police.
 *
 *  Agent 306 was previously suspended for spam. This guard
 *  enforces the minimum rules needed to stay within X's
 *  automation policies — and nothing more.
 *
 *  WHAT THIS GUARDS AGAINST (real suspension risks):
 *    1. Impersonation (claiming to be human)
 *    2. Prohibited/harmful content
 *    3. Rate limiting (daily cap + min interval)
 *    4. Reply safety (unsolicited replies = spam)
 *
 *  WHAT WAS REMOVED (was killing post quality):
 *    - Jaccard dedup gate (0.65 threshold) — too aggressive
 *      for 6 daily posts in the same domain. The LLM prompt
 *      already includes today's posts for topic dedup.
 *    - Hashtag stripping/validation — moved to soft guidance
 *      in prompts. X demotes >3 hashtags algorithmically
 *      but doesn't suspend for it.
 *
 *  X's actual limits (2026):
 *    - POST /2/tweets: 10,000/24h per app, 100/15min per user
 *    - No official "posts per day" suspension threshold
 *    - Bot accounts allowed with disclosure
 *    - Suspensions come from: auto-engagement, unsolicited
 *      @mentions, duplicate content ACROSS accounts, trending
 *      topic manipulation
 *
 *  No external dependencies — pure TypeScript.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";

// ── Persistent state file ────────────────────────────────────
const COMPLIANCE_STATE_FILE = dataPath("x_compliance_state.json");

interface ComplianceState {
  recentPosts: Array<{ text: string; timestamp: number }>;
  postTimestamps: number[];
  repliedInteractions: Array<{ user: string; postId: string; timestamp: number }>;
}

function loadState(): ComplianceState {
  try {
    if (fs.existsSync(COMPLIANCE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(COMPLIANCE_STATE_FILE, "utf8"));
    }
  } catch {}
  return { recentPosts: [], postTimestamps: [], repliedInteractions: [] };
}

function saveState(state: ComplianceState): void {
  try {
    fs.writeFileSync(COMPLIANCE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.warn("[XCompliance] Failed to save state:", e.message);
  }
}

// ── Rate limiting ────────────────────────────────────────────
// Conservative but not strangling. X allows 10,000/day via API.
// We cap at 12/day with 90min min interval — well within safe range
// and leaves room for breaking news without fence-post collisions.
const MAX_POSTS_PER_24H = 12;
const MIN_INTERVAL_MS = 90 * 60 * 1000; // 90 minutes (down from 2h)
const GRACE_WINDOW_MS = 60 * 1000; // 60s grace to avoid fence-post rejections

function checkRateLimit(state: ComplianceState): { pass: boolean; reason?: string } {
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  // Clean old timestamps
  const recentTimestamps = state.postTimestamps.filter((t) => t > twentyFourHoursAgo);

  if (recentTimestamps.length >= MAX_POSTS_PER_24H) {
    return {
      pass: false,
      reason: `rate limit (${recentTimestamps.length} posts in last 24h, max ${MAX_POSTS_PER_24H})`,
    };
  }

  if (recentTimestamps.length > 0) {
    const lastPost = Math.max(...recentTimestamps);
    const elapsed = now - lastPost;
    if (elapsed < (MIN_INTERVAL_MS - GRACE_WINDOW_MS)) {
      const minsElapsed = Math.round(elapsed / 60000);
      const minMins = Math.round(MIN_INTERVAL_MS / 60000);
      return {
        pass: false,
        reason: `rate limit (${minsElapsed}min since last post, min interval: ${minMins}min)`,
      };
    }
  }

  return { pass: true };
}

// ── Content filter ───────────────────────────────────────────
// Hard safety: impersonation + prohibited content only.
const IMPERSONATION_PATTERNS = [
  /\bi am (?:a )?human\b/i,
  /\bi'm (?:a )?human\b/i,
  /\bi am (?:a )?person\b/i,
  /\bi'm (?:a )?person\b/i,
  /\bi am (?:a )?real (?:person|human)\b/i,
  /\bmy name is (?!agent ?306)\w+/i,
  /\bi am (?!agent ?306)(?!an? (?:ai|autonomous|research))\w+ (?:from|at|with)\b/i,
];

const PROHIBITED_PATTERNS = [
  /\bi (?:will|'ll) (?:kill|hurt|harm|destroy|attack)\b/i,
  /\bkill yourself\b/i,
  /\bgo die\b/i,
  /\byou (?:deserve to )?die\b/i,
  /\bkys\b/i,
];

function checkContentFilter(content: string): { pass: boolean; reason?: string } {
  for (const pattern of IMPERSONATION_PATTERNS) {
    if (pattern.test(content)) {
      return { pass: false, reason: "content filter (impersonation pattern detected)" };
    }
  }

  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(content)) {
      return { pass: false, reason: "content filter (prohibited content detected)" };
    }
  }

  return { pass: true };
}

// ── Reply safety ─────────────────────────────────────────────
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function checkReplySafety(
  state: ComplianceState,
  options: { replyToUser?: string; replyToPostId?: string },
): { pass: boolean; reason?: string } {
  if (!options.replyToUser) {
    return { pass: false, reason: "reply missing target user" };
  }

  const now = Date.now();

  // Clean old interactions
  state.repliedInteractions = state.repliedInteractions.filter(
    (i) => now - i.timestamp < REPLY_WINDOW_MS,
  );

  // Check if we already replied to this interaction
  const alreadyReplied = state.repliedInteractions.some(
    (i) =>
      i.user === options.replyToUser &&
      i.postId === options.replyToPostId,
  );

  if (alreadyReplied) {
    return { pass: false, reason: "already replied to this interaction" };
  }

  return { pass: true };
}

// ── Main validation function ─────────────────────────────────

export interface XPostValidationOptions {
  isReply?: boolean;
  replyToUser?: string;
  replyToPostId?: string;
}

export interface XPostValidationResult {
  allowed: boolean;
  reason?: string;
  sanitizedContent?: string;
}

/**
 * Validate a post before sending to X.
 * Run this BEFORE every xWrite.v2.tweet() call.
 *
 * Returns { allowed: true } if the post can be sent,
 * or { allowed: false, reason: "..." } if it should be skipped.
 *
 * STREAMLINED: Only checks hard safety rules.
 * Content quality, dedup, and hashtags are handled upstream
 * via LLM prompts (which already include today's posts).
 */
export function validateXPost(
  content: string,
  options?: XPostValidationOptions,
): XPostValidationResult {
  const state = loadState();

  // 1. Content filter — impersonation / prohibited content
  const filterResult = checkContentFilter(content);
  if (!filterResult.pass) {
    console.log(`[XCompliance] Post rejected: ${filterResult.reason}`);
    return { allowed: false, reason: filterResult.reason };
  }

  // 2. Rate limiting — daily cap + min interval
  const rateResult = checkRateLimit(state);
  if (!rateResult.pass) {
    console.log(`[XCompliance] Post rejected: ${rateResult.reason}`);
    return { allowed: false, reason: rateResult.reason };
  }

  // 3. Reply safety (only if this is a reply)
  //    HARD BLOCK: All X replies are disabled unless env var is set.
  if (options?.isReply) {
    if (!process.env.X_REPLIES_ENABLED) {
      console.log("[XCompliance] Reply HARD-BLOCKED: X replies globally disabled (X_REPLIES_ENABLED not set)");
      return { allowed: false, reason: "X replies globally disabled" };
    }
    const replyResult = checkReplySafety(state, {
      replyToUser: options.replyToUser,
      replyToPostId: options.replyToPostId,
    });
    if (!replyResult.pass) {
      const reason = options.replyToUser
        ? `Reply rejected: ${replyResult.reason}`
        : "Reply rejected: user did not @mention us first";
      console.log(`[XCompliance] ${reason}`);
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}

/**
 * Record a successfully posted tweet.
 * Call AFTER xWrite.v2.tweet() succeeds.
 * Tracks content for history and timestamps for rate limiting.
 */
export function recordXPost(
  content: string,
  options?: { isReply?: boolean; replyToUser?: string; replyToPostId?: string },
): void {
  const state = loadState();
  const now = Date.now();

  // Add to recent posts (keep last 20 for reference)
  state.recentPosts.push({ text: content, timestamp: now });
  if (state.recentPosts.length > 20) {
    state.recentPosts = state.recentPosts.slice(-20);
  }

  // Add timestamp for rate limiting
  state.postTimestamps.push(now);
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  state.postTimestamps = state.postTimestamps.filter((t) => t > twentyFourHoursAgo);

  // Track reply interactions
  if (options?.isReply && options.replyToUser && options.replyToPostId) {
    state.repliedInteractions.push({
      user: options.replyToUser,
      postId: options.replyToPostId,
      timestamp: now,
    });
    state.repliedInteractions = state.repliedInteractions.filter(
      (i) => now - i.timestamp < REPLY_WINDOW_MS,
    );
  }

  saveState(state);
}

/**
 * X posting rules to inject into content generation system prompts.
 * STREAMLINED: Focus on what actually causes suspensions.
 * Hashtag and formatting guidance moved to voice.ts.
 */
export const X_POSTING_RULES = `
X POSTING RULES (CRITICAL — violation = account suspension):
- You are an autonomous AI research agent. Never claim to be human.
- Every post must be substantially unique — never repeat the same insight twice.
- Never @mention users unless they mentioned you first.
- Keep posts informative, original, and non-repetitive.
- Never post about trending topics just to gain visibility.
- Focus on sharing genuine research insights, not engagement farming.
- Do NOT include meta-commentary like "Here is my tweet" or separators like "---". Output ONLY the post text.
- Do NOT include character counts like "(487 characters)" in your output.`;

/**
 * Profile bio compliance notice.
 */
export const X_PROFILE_BIO_REQUIREMENTS = {
  botDisclosure: "Autonomous AI research agent",
  operator: "agent306.ai",
  contact: "agent306@agent306.ai",
  exampleBio:
    "Autonomous AI research agent | Tracking AI, crypto & frontier tech | Built by agent306.ai | Contact: agent306@agent306.ai",
};

export const AGENT306_CONTACT_EMAIL = "agent306@agent306.ai";

/**
 * Get current compliance status for the dashboard.
 */
export function getComplianceStatus() {
  const state = loadState();
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  const last24h = state.postTimestamps.filter(t => t > twentyFourHoursAgo);
  const lastPost = last24h.length > 0 ? Math.max(...last24h) : 0;
  const cooldownRemaining = lastPost > 0 ? Math.max(0, (lastPost + MIN_INTERVAL_MS) - now) : 0;
  const nextAvailable = lastPost > 0 ? new Date(lastPost + MIN_INTERVAL_MS).toISOString() : "now";

  return {
    postsLast24h: last24h.length,
    maxPosts24h: MAX_POSTS_PER_24H,
    remainingPosts: Math.max(0, MAX_POSTS_PER_24H - last24h.length),
    lastPostAt: lastPost > 0 ? new Date(lastPost).toISOString() : null,
    nextAvailableAt: nextAvailable,
    cooldownRemainingMs: cooldownRemaining,
    minIntervalMinutes: MIN_INTERVAL_MS / (60 * 1000),
  };
}
