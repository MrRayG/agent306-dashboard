/**
 * ─────────────────────────────────────────────────────────────
 *  X COMPLIANCE GUARD
 *
 *  Runs BEFORE every X/Twitter post to prevent another spam
 *  suspension. Agent 306 was previously suspended for spam —
 *  this guard enforces rate limits, dedup, content safety,
 *  and reply rules per X's automation policies.
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

// ── Trigram-based Jaccard similarity ─────────────────────────
function getWordTrigrams(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const trigrams = new Set<string>();
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  Array.from(a).forEach((item) => {
    if (b.has(item)) intersection++;
  });
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Content similarity check ─────────────────────────────────
const SIMILARITY_THRESHOLD = 0.65;
const MAX_RECENT_POSTS = 20;

function checkSimilarity(
  content: string,
  state: ComplianceState,
): { pass: boolean; reason?: string } {
  const contentTrigrams = getWordTrigrams(content);
  if (contentTrigrams.size === 0) return { pass: true };

  for (const recent of state.recentPosts) {
    const recentTrigrams = getWordTrigrams(recent.text);
    const sim = jaccardSimilarity(contentTrigrams, recentTrigrams);
    if (sim > SIMILARITY_THRESHOLD) {
      return {
        pass: false,
        reason: `too similar to recent post (similarity: ${sim.toFixed(2)})`,
      };
    }
  }
  return { pass: true };
}

// ── Rate limiting ────────────────────────────────────────────
const MAX_POSTS_PER_24H = 4;
const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

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
    if (elapsed < MIN_INTERVAL_MS) {
      const hoursElapsed = (elapsed / (60 * 60 * 1000)).toFixed(1);
      const minHours = (MIN_INTERVAL_MS / (60 * 60 * 1000)).toFixed(0);
      return {
        pass: false,
        reason: `rate limit (${hoursElapsed}h since last post, min interval: ${minHours}h)`,
      };
    }
  }

  return { pass: true };
}

// ── Hashtag validation ───────────────────────────────────────
const MAX_HASHTAGS = 3;

function validateHashtags(content: string): {
  pass: boolean;
  reason?: string;
  sanitizedContent?: string;
} {
  const hashtags = content.match(/#\w+/g) || [];

  if (hashtags.length <= MAX_HASHTAGS) {
    return { pass: true };
  }

  // Strip excess hashtags (keep first MAX_HASHTAGS)
  const keepHashtags = new Set(hashtags.slice(0, MAX_HASHTAGS));
  let sanitized = content;
  let stripped = 0;

  for (const tag of hashtags) {
    if (!keepHashtags.has(tag)) {
      sanitized = sanitized.replace(tag, "").replace(/\s{2,}/g, " ").trim();
      stripped++;
      keepHashtags.add(tag); // prevent double-stripping same tag
    }
  }

  console.log(`[XCompliance] Stripped ${stripped} excess hashtags`);
  return { pass: true, sanitizedContent: sanitized };
}

// ── Content filter ───────────────────────────────────────────
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
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling window

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
 * May return sanitizedContent with excess hashtags stripped.
 */
export function validateXPost(
  content: string,
  options?: XPostValidationOptions,
): XPostValidationResult {
  const state = loadState();

  // 1. Content filter — check for impersonation / prohibited content
  const filterResult = checkContentFilter(content);
  if (!filterResult.pass) {
    console.log(`[XCompliance] Post rejected: ${filterResult.reason}`);
    return { allowed: false, reason: filterResult.reason };
  }

  // 2. Rate limiting
  const rateResult = checkRateLimit(state);
  if (!rateResult.pass) {
    console.log(`[XCompliance] Post rejected: ${rateResult.reason}`);
    return { allowed: false, reason: rateResult.reason };
  }

  // 3. Content similarity check
  const simResult = checkSimilarity(content, state);
  if (!simResult.pass) {
    console.log(`[XCompliance] Post rejected: ${simResult.reason}`);
    return { allowed: false, reason: simResult.reason };
  }

  // 4. Hashtag validation
  const hashtagResult = validateHashtags(content);
  const sanitizedContent = hashtagResult.sanitizedContent;

  // 5. Reply safety (only if this is a reply)
  if (options?.isReply) {
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

  return {
    allowed: true,
    ...(sanitizedContent ? { sanitizedContent } : {}),
  };
}

/**
 * Record a successfully posted tweet.
 * Call AFTER xWrite.v2.tweet() succeeds.
 * Tracks content for dedup and timestamps for rate limiting.
 */
export function recordXPost(
  content: string,
  options?: { isReply?: boolean; replyToUser?: string; replyToPostId?: string },
): void {
  const state = loadState();
  const now = Date.now();

  // Add to recent posts (keep last 20)
  state.recentPosts.push({ text: content, timestamp: now });
  if (state.recentPosts.length > MAX_RECENT_POSTS) {
    state.recentPosts = state.recentPosts.slice(-MAX_RECENT_POSTS);
  }

  // Add timestamp for rate limiting
  state.postTimestamps.push(now);
  // Clean timestamps older than 24h
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
  state.postTimestamps = state.postTimestamps.filter((t) => t > twentyFourHoursAgo);

  // Track reply interactions
  if (options?.isReply && options.replyToUser && options.replyToPostId) {
    state.repliedInteractions.push({
      user: options.replyToUser,
      postId: options.replyToPostId,
      timestamp: now,
    });
    // Clean old interactions
    state.repliedInteractions = state.repliedInteractions.filter(
      (i) => now - i.timestamp < REPLY_WINDOW_MS,
    );
  }

  saveState(state);
}

/**
 * X posting rules to inject into content generation system prompts.
 * Append this to any LLM system prompt that generates X/Twitter content.
 */
export const X_POSTING_RULES = `
X POSTING RULES (CRITICAL — violation = account suspension):
- You are an autonomous AI research agent. Never claim to be human.
- Every post must be substantially unique — never repeat the same insight twice.
- Max 3 relevant hashtags per post. Never use trending hashtags unless genuinely relevant.
- Never @mention users unless they mentioned you first.
- Keep posts informative, original, and non-repetitive.
- Never post about trending topics just to gain visibility.
- Vary your sentence structure, hooks, and framing across posts.
- Focus on sharing genuine research insights, not engagement farming.`;

/**
 * Profile bio compliance notice.
 * The X profile bio MUST include bot identity disclosure per X's automation policy.
 * Required elements:
 *   - "Autonomous AI research agent" or similar bot disclosure
 *   - Operator: agent306.ai (or the responsible human/org)
 *   - Contact: agent306@agent306.ai
 *
 * If the bio is managed via the X Developer Portal or a config file,
 * ensure it contains these elements. Failure to disclose = suspension risk.
 */
export const X_PROFILE_BIO_REQUIREMENTS = {
  botDisclosure: "Autonomous AI research agent",
  operator: "agent306.ai",
  contact: "agent306@agent306.ai",
  exampleBio:
    "Autonomous AI research agent | Tracking AI, crypto & frontier tech | Built by agent306.ai | Contact: agent306@agent306.ai",
};

/**
 * Contact email for Agent 306.
 */
export const AGENT306_CONTACT_EMAIL = "agent306@agent306.ai";
