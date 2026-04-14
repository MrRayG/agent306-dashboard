/**
 * ─────────────────────────────────────────────────────────────
 *  POST FORMAT GUARD
 *
 *  Last-mile safety net that auto-fixes every tweet before it
 *  hits the X API. Generation SHOULD include these elements,
 *  but this guard catches failures.
 *
 *  Every tweet must have:
 *    [SHOW TAG] + body + hashtags + signature
 *
 *  Steps:
 *    1. Ensure show tag is present (bracket format)
 *    2. Inject @ mentions for referenced entities
 *    3. Ensure required hashtags (#AI #AgenticEconomy)
 *    4. Ensure signature (— Agent 306)
 *    5. Trim to 280 char limit
 * ─────────────────────────────────────────────────────────────
 */

import { getShowTag } from "./contentTypes.js";
import { injectMentions } from "./knownHandles.js";

// Valid show tag names (without brackets) — includes types not in contentTypes.ts
const VALID_SHOW_TAG_NAMES = [
  '306 NEWS', '306 SIGNAL', '306 RESEARCH', '306 ROUND UP', '306 ROUNDUP',
  '306 REFLECTION', '306 PROGRESS', '306 DEBATE', '306 ARCHIVE',
  '306 PROMPT', '306 THREAD', '306 ACADEMY', '306 TOOLBOX', '306 DATASET',
];

// Queue type → show tag for types not in contentTypes.ts
const FALLBACK_SHOW_TAGS: Record<string, string> = {
  'reflection': '[306 REFLECTION]',
  'dispatch': '[306 NEWS]',
  'roundup': '[306 ROUNDUP]',
};

const SIGNATURE = '— Agent 306';
const SIGNATURE_PATTERN = /\n*\s*[-—–]+\s*Agent\s*306\s*$/;
const REQUIRED_HASHTAGS = ['#AI', '#AgenticEconomy'];
const MAX_HASHTAGS = 3;
const MAX_CHARS = 280;

/**
 * Auto-fix tweet formatting before posting.
 * This is a SAFETY NET — generation should still include these elements.
 */
export function enforcePostFormat(tweet: string, contentType?: string): string {
  let text = tweet.trim();

  // Step 1: Ensure show tag
  text = ensureShowTag(text, contentType);

  // Step 2: Inject mentions for referenced entities
  text = injectMentions(text);

  // Step 3: Ensure required hashtags
  text = ensureHashtags(text);

  // Step 4: Ensure signature
  text = ensureSignature(text);

  // Step 5: Trim to character limit
  text = trimToLimit(text);

  return text;
}

/**
 * Step 1: Ensure tweet starts with a valid show tag in bracket format.
 */
function ensureShowTag(text: string, contentType?: string): string {
  // Check if tweet already starts with a valid show tag
  const bracketMatch = text.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    const tagName = bracketMatch[1].toUpperCase();
    if (VALID_SHOW_TAG_NAMES.some(name => name === tagName)) {
      return text; // already has a valid tag
    }
  }

  // Check for unbracketed show tag at start (e.g., "306 NEWS ...")
  for (const name of VALID_SHOW_TAG_NAMES) {
    if (text.toUpperCase().startsWith(name)) {
      // Wrap in brackets
      const body = text.slice(name.length).trimStart();
      return `[${name}] ${body}`;
    }
  }

  // No valid tag found — prepend based on contentType
  if (contentType) {
    // Try contentTypes.ts registry first
    let tag = getShowTag(contentType);
    // Fall back to our local map
    if (!tag) tag = FALLBACK_SHOW_TAGS[contentType] || '';
    if (tag) {
      return `${tag} ${text}`;
    }
  }

  return text;
}

/**
 * Step 3: Ensure #AI and #AgenticEconomy are present.
 * Cap total hashtags at 3 (2 required + 1 contextual).
 * Place hashtags on a line before the signature.
 */
function ensureHashtags(text: string): string {
  // Temporarily remove signature if present
  const hasSig = SIGNATURE_PATTERN.test(text);
  let body = hasSig ? text.replace(SIGNATURE_PATTERN, '').trimEnd() : text;
  let sig = hasSig ? `\n\n${SIGNATURE}` : '';

  // Count existing hashtags
  const existingHashtags = body.match(/#\w+/g) || [];
  const existingSet = new Set(existingHashtags.map(h => h.toLowerCase()));

  const hashtagsToAdd: string[] = [];
  for (const required of REQUIRED_HASHTAGS) {
    if (!existingSet.has(required.toLowerCase())) {
      hashtagsToAdd.push(required);
    }
  }

  if (hashtagsToAdd.length === 0) {
    // All required hashtags present — check total count
    if (existingHashtags.length > MAX_HASHTAGS) {
      // Strip excess beyond 3, keeping #AI and #AgenticEconomy
      body = stripExcessHashtags(body, MAX_HASHTAGS);
    }
    return body + sig;
  }

  // If adding would exceed max, strip contextual hashtags first
  const totalAfterAdd = existingHashtags.length + hashtagsToAdd.length;
  if (totalAfterAdd > MAX_HASHTAGS) {
    // Remove non-required hashtags to make room
    body = stripNonRequiredHashtags(body);
  }

  // Add missing required hashtags on a line before signature
  body = body.trimEnd() + '\n' + hashtagsToAdd.join(' ');

  return body + sig;
}

/**
 * Step 4: Ensure tweet ends with "— Agent 306" signature.
 * Normalizes any variation (- Agent 306, -- Agent 306, etc.)
 */
function ensureSignature(text: string): string {
  // Check for existing signature variations
  if (SIGNATURE_PATTERN.test(text)) {
    // Normalize to standard format
    return text.replace(SIGNATURE_PATTERN, `\n\n${SIGNATURE}`);
  }

  // No signature found — append
  return text.trimEnd() + `\n\n${SIGNATURE}`;
}

/**
 * Step 5: Trim body to fit 280 char limit.
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
      bodyEnd = beforeSig.length - lastLine.length - 1; // -1 for the \n
    }
  }

  const body = text.slice(bodyStart, bodyEnd);
  const overhead = tag.length + hashtagLine.length + sig.length;
  const maxBodyLen = MAX_CHARS - overhead;

  if (maxBodyLen <= 0) {
    // Extreme edge case — just truncate everything
    return text.slice(0, MAX_CHARS);
  }

  if (body.length <= maxBodyLen) return text;

  // Trim body — try to cut at sentence boundary
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
    const cutPoint = truncated.length - 40 + sentenceEnd + 1; // +1 to include the punctuation
    return truncated.slice(0, cutPoint).trimEnd();
  }

  // No sentence boundary — cut at last space
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace).trimEnd() + '...';
  }

  return truncated.trimEnd() + '...';
}

/**
 * Strip non-required hashtags from text.
 */
function stripNonRequiredHashtags(text: string): string {
  const requiredLower = new Set(REQUIRED_HASHTAGS.map(h => h.toLowerCase()));
  return text.replace(/#\w+/g, (match) => {
    if (requiredLower.has(match.toLowerCase())) return match;
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
}

/**
 * Strip excess hashtags beyond maxCount, keeping required ones.
 */
function stripExcessHashtags(text: string, maxCount: number): string {
  const requiredLower = new Set(REQUIRED_HASHTAGS.map(h => h.toLowerCase()));
  const hashtags = text.match(/#\w+/g) || [];
  let kept = 0;

  return text.replace(/#\w+/g, (match) => {
    if (requiredLower.has(match.toLowerCase())) {
      kept++;
      return match;
    }
    if (kept < maxCount) {
      kept++;
      return match;
    }
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
}
