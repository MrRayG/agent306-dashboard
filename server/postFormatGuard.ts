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
 *    5. Trim to 25000 char limit (X Premium Plus)
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
const MAX_HASHTAGS = 5;
const MAX_CHARS = 25000;

// ── Hashtag Strategy (based on Apr 2026 engagement data) ─────────
//
// Performance ranking (observed likes/views in Web3 AI niche):
//   #AIAgents  — Very High (100–1300+ likes, 2k–200k+ views)
//   #DePIN     — High (60–500+ likes)
//   #DeAI      — High & Rising (50–400+ likes)
//   #Web3AI    — Medium-High (50–300+ likes)
//   #AgenticAI — Medium-High (50–200+ likes)
//   #CryptoAI  — Medium (50–150+ likes)
//   #OnChainAI — Medium (40–200+ likes)
//
// Max 4–5 per post. Place at end.
// Project-specific tags (#AKT, #Theta, #VIRTUAL, #TAO) boost when relevant.

// Core combo for most posts (strongest performers first)
const PRIMARY_HASHTAGS = ['#AIAgents', '#DeAI', '#DePIN', '#Web3AI'];

// Content-type specific combos
const HASHTAG_COMBOS: Record<string, string[]> = {
  // SIGNAL briefs / research drops
  'signal':     ['#AIAgents', '#DeAI', '#DePIN', '#Web3AI'],
  'research':   ['#AIAgents', '#DeAI', '#DePIN', '#Web3AI'],
  // News / market dispatches
  'dispatch':   ['#AIAgents', '#DeAI', '#Web3AI', '#AgenticAI'],
  // Agent economies, identity, payments, on-chain
  'roundup':    ['#AIAgents', '#DeAI', '#OnChainAI', '#CryptoAI'],
  // Alignment / agent foundations
  'reflection': ['#AIAgents', '#AgenticAI', '#DeAI'],
  'debate':     ['#AIAgents', '#AgenticAI', '#DeAI'],
  // General / catch-all
  'prompt':     ['#AIAgents', '#DeAI', '#Web3AI', '#AgenticAI'],
  'archive':    ['#AIAgents', '#DeAI', '#Web3AI'],
  'progress':   ['#AIAgents', '#DeAI', '#Web3AI', '#AgenticAI'],
};

// Topic-specific tags the generation engine can add when relevant:
// #DeFi (agent trading/automation), #GPU / #zkML (infra/technical),
// #AKT #Theta #VIRTUAL #TAO (project-specific boosts)

function getHashtagsForType(contentType?: string): string[] {
  if (contentType && HASHTAG_COMBOS[contentType]) {
    return HASHTAG_COMBOS[contentType];
  }
  return PRIMARY_HASHTAGS;
}

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

  // Step 3: Ensure required hashtags (context-aware per content type)
  text = ensureHashtags(text, contentType);

  // Step 4: Ensure signature
  text = ensureSignature(text);

  // Step 5: Strip markdown (X renders it as raw characters)
  text = stripMarkdown(text);

  // Step 6: Trim to character limit
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
 * Step 3: Ensure context-aware hashtags are present.
 * Uses content-type combos (3-5 hashtags, placed at end).
 * Generation may also add topic-specific tags (#DePIN, #zkML, etc.)
 */
function ensureHashtags(text: string, contentType?: string): string {
  // Temporarily remove signature if present
  const hasSig = SIGNATURE_PATTERN.test(text);
  let body = hasSig ? text.replace(SIGNATURE_PATTERN, '').trimEnd() : text;
  const sig = hasSig ? `\n\n${SIGNATURE}` : '';

  const existingHashtags = body.match(/#\w+/g) || [];

  // If she picked 2+ hashtags, trust her. Only cap at max.
  if (existingHashtags.length >= 2) {
    if (existingHashtags.length > MAX_HASHTAGS) {
      body = stripExcessHashtags(body, MAX_HASHTAGS);
    }
    return body + sig;
  }

  // 0-1 hashtags = she missed them. Add defaults.
  const requiredTags = getHashtagsForType(contentType);
  const existingSet = new Set(existingHashtags.map(h => h.toLowerCase()));
  const hashtagsToAdd: string[] = [];
  for (const tag of requiredTags) {
    if (!existingSet.has(tag.toLowerCase())) {
      hashtagsToAdd.push(tag);
    }
    if (existingHashtags.length + hashtagsToAdd.length >= 4) break;
  }

  if (hashtagsToAdd.length > 0) {
    body = body.trimEnd() + '\n' + hashtagsToAdd.join(' ');
  }

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
 * Step 5: Trim body to fit 25000 char limit (X Premium Plus).
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
 * Strip excess hashtags beyond maxCount, keeping primary combo tags.
 */
function stripExcessHashtags(text: string, maxCount: number): string {
  const primaryLower = new Set(PRIMARY_HASHTAGS.map(h => h.toLowerCase()));
  let kept = 0;

  return text.replace(/#\w+/g, (match) => {
    if (primaryLower.has(match.toLowerCase())) {
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
