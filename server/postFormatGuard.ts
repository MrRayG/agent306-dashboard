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

// ── Signal POV formatting ────────────────────────────────

// Mathematical Bold lookup — X does not render markdown so we use Unicode
// mathematical bold characters. Survives copy/paste and renders as bold on
// iOS/macOS/Android system fonts. Reference: U+1D400–U+1D433 (A–Z, a–z).
const BOLD_MAP: Record<string, string> = {};
for (let i = 0; i < 26; i++) {
  // Uppercase A–Z → 𝐀–𝐙  (U+1D400 + i)
  BOLD_MAP[String.fromCharCode(65 + i)] = String.fromCodePoint(0x1D400 + i);
  // Lowercase a–z → 𝐚–𝐳  (U+1D41A + i)
  BOLD_MAP[String.fromCharCode(97 + i)] = String.fromCodePoint(0x1D41A + i);
}
// Digits 0–9 → 𝟎–𝟗 (U+1D7CE)
for (let i = 0; i < 10; i++) {
  BOLD_MAP[String.fromCharCode(48 + i)] = String.fromCodePoint(0x1D7CE + i);
}

/** Convert ASCII letters/digits to Unicode mathematical bold. Non-ASCII chars pass through. */
export function toUnicodeBold(text: string): string {
  let out = "";
  for (const ch of text) {
    out += BOLD_MAP[ch] ?? ch;
  }
  return out;
}

/**
 * Format POV label inside a Signal brief tweet:
 *   • Ensure a blank line precedes every `POV:` label.
 *   • Render the `POV:` label itself in Unicode mathematical bold
 *     (𝐏𝐎𝐕:) so it pops visually on X without needing markdown.
 *
 * Idempotent — running it twice has the same effect as running it once.
 * Only touches `POV:` as a label at the start of a line or after prose;
 * never touches letters `P`, `O`, `V` appearing mid-word.
 */
export function formatSignalPOV(text: string): string {
  const BOLD_POV = toUnicodeBold("POV") + ":"; // 𝐏𝐎𝐕:

  // Already-bold + has blank line: leave it alone (idempotent).
  // To detect "already bold", we check for the bold P character.
  const BOLD_P = toUnicodeBold("P");

  // Step 1: Normalise any pre-existing bold-POV back to ASCII so we can
  // re-apply the blank-line rule consistently.
  let out = text.split(BOLD_POV).join("POV:");

  // Step 2: Split `POV:` off the end of a preceding sentence so it starts
  // its own paragraph. We only match `POV:` as a label (colon required,
  // start-of-word boundary) to avoid touching the middle of words.
  // Insert \n\n before `POV:` when it is NOT already preceded by \n\n.
  out = out.replace(/([^\n])\n?POV:/g, (_m, prev) => `${prev}\n\nPOV:`);
  // Also handle `POV:` that appears at the very start of a line but
  // without a blank line above it (i.e. \nPOV: instead of \n\nPOV:).
  out = out.replace(/([^\n])\nPOV:/g, (_m, prev) => `${prev}\n\nPOV:`);

  // Step 3: Bold the label (and only the label — not the POV content).
  out = out.split("POV:").join(BOLD_POV);

  // Safety: never leave a stray bare `P` that might look like half-applied
  // bold. Only the full `POV` triad gets bolded.
  void BOLD_P;

  return out;
}

// ── Raw-JSON detection (defense in depth) ───────────────────

/**
 * Detect tweet text that is actually a raw JSON payload leaking through
 * from an LLM response. Regression guard for the 2026-04-20 [306 ACADEMY]
 * incident where a truncated JSON response was posted verbatim with
 * `{ "headline": "...", "teaser": "..."` visible to readers.
 */
export function looksLikeRawJsonPayload(text: string): boolean {
  const stripped = text.replace(/^\[[^\]]+\]\s*/, "").trimStart();
  if (!stripped.startsWith("{")) return false;
  // Two or more known LLM schema keys in the first ~400 chars → almost
  // certainly a raw JSON object, not prose that happens to start with `{`.
  const head = stripped.slice(0, 400);
  const schemaKeyHits = [
    /"headline"\s*:/, /"teaser"\s*:/, /"body"\s*:/,
    /"post"\s*:/, /"dashboardNarrative"\s*:/, /"concept"\s*:/,
  ].reduce((n, rx) => n + (rx.test(head) ? 1 : 0), 0);
  return schemaKeyHits >= 2;
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

  // Step 4: Content-type–specific polish. For Signal briefs we ensure
  // every `POV:` label sits on its own line with a blank line above and
  // is rendered in Unicode mathematical bold.
  if (contentType === "signal") {
    text = formatSignalPOV(text);
  }

  // Step 5: Trim to character limit
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
