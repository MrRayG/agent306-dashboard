/**
 * ─────────────────────────────────────────────────────────────
 *  POST FORMAT GUARD — Streamlined (Communication Audit v1)
 *
 *  PHILOSOPHY: Safety net, not rewrite engine.
 *
 *  The LLM generates the post with voice, show tag, hashtags,
 *  and signature via prompt guidance. This guard catches only
 *  genuine failures — it should NOT reshape the LLM's output.
 *
 *  WHAT THIS DOES:
 *    1. Ensure show tag is present (bracket format)
 *    2. Ensure signature (— Agent 306) — normalize variants
 *    3. Strip markdown (X renders as raw characters)
 *    4. Trim to 25000 char limit (X Premium Plus)
 *
 *  WHAT WAS REMOVED (was hurting quality):
 *    - injectMentions() — auto-injecting @handles broke prose
 *      rhythm and risks X's "unsolicited mentions" rule. The
 *      LLM can mention handles naturally when she wants to.
 *    - ensureHashtags() — force-adding #AIAgents when the LLM
 *      chose zero was overriding her editorial judgment. If she
 *      decides a post is better without hashtags, respect that.
 *      (X algorithm actually demotes posts with >3 hashtags.)
 *    - Excess hashtag stripping — the compliance guard's old
 *      hashtag cap (5) was redundant with prompt guidance
 *      telling her to use 2-4. Removed.
 *
 *  Net effect: The LLM's output reaches X with minimal surgery.
 *  Same approach Farcaster already uses — just trim + post.
 * ─────────────────────────────────────────────────────────────
 */

import { getShowTag } from "./contentTypes.js";

// Valid show tag names (without brackets). Kept in sync with CONTENT_TYPES
// in contentTypes.ts. Any tag that appears at the start of a post and
// matches one of these is treated as legitimate and preserved as-is.
const VALID_SHOW_TAG_NAMES = [
  '306 NEWS', '306 SIGNAL', '306 ACADEMY', '306 ROUND UP', '306 ROUNDUP',
  '306 REFLECTION', '306 UNPLUGGED', '306 PROGRESS', '306 ARCHIVE',
  '306 THREAD', '306 ARTICLE', '306 BLOG', '306 BREAKTHROUGH',
  'THE DISPATCH',
];

// Queue type → show tag for types not in contentTypes.ts
const FALLBACK_SHOW_TAGS: Record<string, string> = {
  'reflection': '[306 REFLECTION]',
  'roundup': '[306 ROUNDUP]',
  'research': '[306 ACADEMY]',
  'agent_voice': '[306 UNPLUGGED]',
};

const SIGNATURE = '— Agent 306';
const SIGNATURE_PATTERN = /\n*\s*[-—–]+\s*Agent\s*306\s*$/;
const MAX_CHARS = 25000;

// ── Markdown stripping ──────────────────────────────────────

/**
 * Strip markdown formatting that X renders as raw characters.
 * Converts **bold**, *italic*, [links](url), ## headers, `code`, ~~strike~~ to plain text.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1');
}

// ── Main format enforcement ─────────────────────────────────

/**
 * Light-touch tweet formatting before posting.
 * Only fixes genuine issues — does NOT reshape the LLM's voice.
 */
export function enforcePostFormat(tweet: string, contentType?: string): string {
  let text = tweet.trim();

  // Step 1: Ensure show tag
  text = ensureShowTag(text, contentType);

  // Step 2: Ensure signature
  text = ensureSignature(text);

  // Step 3: Strip markdown (X renders it as raw characters)
  text = stripMarkdown(text);

  // Step 4: Trim to character limit
  text = trimToLimit(text);

  return text;
}

/**
 * Step 1: Ensure tweet starts with a valid show tag in bracket format.
 */
function ensureShowTag(text: string, contentType?: string): string {
  // Check if tweet already starts with a bracketed show tag
  const bracketMatch = text.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    const tagName = bracketMatch[1].toUpperCase();
    if (VALID_SHOW_TAG_NAMES.some(name => name === tagName)) {
      return text; // already has a valid tag
    }
    // Has a bracket tag but it's not valid (e.g. [306 RESEARCH]) — strip it
    text = text.slice(bracketMatch[0].length).trimStart();
  }

  // Check for unbracketed show tag at start (e.g., "306 NEWS ...")
  for (const name of VALID_SHOW_TAG_NAMES) {
    if (text.toUpperCase().startsWith(name)) {
      const body = text.slice(name.length).trimStart();
      return `[${name}] ${body}`;
    }
  }

  // No valid tag found — prepend based on contentType
  if (contentType) {
    let tag = getShowTag(contentType);
    if (!tag) tag = FALLBACK_SHOW_TAGS[contentType] || '';
    if (tag) {
      return `${tag} ${text}`;
    }
  }

  return text;
}

/**
 * Step 2: Ensure tweet ends with "— Agent 306" signature.
 * Normalizes any variation (- Agent 306, -- Agent 306, etc.)
 */
function ensureSignature(text: string): string {
  if (SIGNATURE_PATTERN.test(text)) {
    return text.replace(SIGNATURE_PATTERN, `\n\n${SIGNATURE}`);
  }
  return text.trimEnd() + `\n\n${SIGNATURE}`;
}

/**
 * Step 3: Trim body to fit 25000 char limit (X Premium Plus).
 * Preserves show tag, hashtags, and signature.
 */
function trimToLimit(text: string): string {
  if (text.length <= MAX_CHARS) return text;

  // Parse components
  const tagMatch = text.match(/^(\[[^\]]+\]\s*)/);
  const tag = tagMatch ? tagMatch[1] : '';
  const bodyStart = tag.length;

  // Find signature
  const sigMatch = text.match(/(\n\n— Agent 306)$/);
  const sig = sigMatch ? sigMatch[1] : '';

  // Find hashtag line (line before signature that contains hashtags)
  const beforeSig = text.slice(0, sig ? text.length - sig.length : text.length);
  const lines = beforeSig.split('\n');
  let hashtagLine = '';
  let bodyEnd = beforeSig.length;

  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1];
    if (/#\w+/.test(lastLine)) {
      hashtagLine = '\n' + lastLine;
      bodyEnd = beforeSig.length - lastLine.length - 1;
    }
  }

  const body = text.slice(bodyStart, bodyEnd);
  const overhead = tag.length + hashtagLine.length + sig.length;
  const maxBodyLen = MAX_CHARS - overhead;

  if (maxBodyLen <= 0) {
    return text.slice(0, MAX_CHARS);
  }

  if (body.length <= maxBodyLen) return text;

  const trimmedBody = trimAtBoundary(body, maxBodyLen);
  return tag + trimmedBody + hashtagLine + sig;
}

/**
 * Trim text to maxLen, preferring sentence boundaries.
 */
function trimAtBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const truncated = text.slice(0, maxLen);

  // Try to find a sentence boundary (. ! ?) within last 40 chars
  const searchWindow = truncated.slice(-40);
  const sentenceEnd = Math.max(
    searchWindow.lastIndexOf('. '),
    searchWindow.lastIndexOf('! '),
    searchWindow.lastIndexOf('? '),
    searchWindow.lastIndexOf('.\n'),
    searchWindow.lastIndexOf('!\n'),
    searchWindow.lastIndexOf('?\n'),
  );

  if (sentenceEnd > 0) {
    const cutPoint = truncated.length - 40 + sentenceEnd + 1;
    return truncated.slice(0, cutPoint).trimEnd();
  }

  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace).trimEnd() + '...';
  }

  return truncated.trimEnd() + '...';
}
