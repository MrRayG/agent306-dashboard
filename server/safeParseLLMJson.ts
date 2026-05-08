/**
 * ─────────────────────────────────────────────────────────────
 *  Shared JSON parser for LLM responses.
 *
 *  Handles the two most common failure modes:
 *    1. Markdown code-block wrapping (```json ... ```)
 *    2. Truncated JSON (missing closing brackets/braces)
 *
 *  Usage:
 *    import { safeParseLLMJson } from "./safeParseLLMJson.js";
 *    const obj = safeParseLLMJson(rawLLMText, "DailyCycle.briefing");
 *    if (!obj) { /* total failure – handle gracefully * / }
 * ─────────────────────────────────────────────────────────────
 */

/**
 * Attempt to parse a JSON string from an LLM response.
 * Never throws — returns `null` on total failure.
 */
export function safeParseLLMJson<T = any>(
  raw: string | null | undefined,
  label = "unknown",
): T | null {
  if (!raw || typeof raw !== "string") return null;

  let text = raw.trim();

  // ── Step 1: Strip markdown code fences ──────────────────────────────────
  text = stripMarkdownFences(text);

  // ── Step 2: Direct parse ────────────────────────────────────────────────
  try {
    return JSON.parse(text) as T;
  } catch {
    // continue to repair
  }

  // ── Step 3: Extract outermost JSON structure ────────────────────────────
  const extracted = extractOutermostJson(text);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      // continue to repair the extracted portion
      text = extracted;
    }
  }

  // ── Step 4: Repair truncated JSON ───────────────────────────────────────
  const repaired = repairTruncatedJson(text);
  if (repaired !== text) {
    try {
      const result = JSON.parse(repaired) as T;
      console.warn(`[JSONRepair] Repaired truncated JSON for ${label}`);
      return result;
    } catch {
      // continue to aggressive fallback
    }
  }

  // ── Step 5: Aggressive truncation — find last complete object ───────────
  const aggressive = aggressiveTruncate(text);
  if (aggressive) {
    try {
      const result = JSON.parse(aggressive) as T;
      console.warn(`[JSONRepair] Repaired truncated JSON for ${label} (aggressive truncation)`);
      return result;
    } catch {
      // total failure
    }
  }

  // ── Step 6: Markdown prose recovery ─────────────────────────────────────
  // If the LLM returned markdown prose with **Key:** patterns, try to
  // extract structured data from it as a last resort.
  const markdownRecovered = recoverFromMarkdown(raw.trim());
  if (markdownRecovered) {
    console.warn(`[JSONRepair] Recovered structured data from markdown prose for ${label}`);
    return markdownRecovered as T;
  }

  console.warn(`[JSONRepair] Could not parse JSON for ${label}: ${text.slice(0, 200)}`);
  return null;
}

/**
 * Best-effort extraction of the inner string of a `{"post": "..."}` wrapper
 * when `safeParseLLMJson` cannot parse the structure (truncated quote, missing
 * closing brace, escaped newlines that broke JSON.parse, etc.).
 *
 * Background — News dispatch incident, May 8 2026
 * ─────────────────────────────────────────────────
 * Grok returned a `{"post": "[306 NEWS] Arbitrum DAO voted ..."` blob whose
 * closing quote/brace was lost. `safeParseLLMJson` returned null. The caller's
 * fallback (`if (!postText && raw.length > 30) postText = raw`) then handed the
 * raw `{"post":` wrapper string straight to the claim verifier and the X
 * queue. The verifier saw the literal `{"post":` prefix as part of the post
 * text and hard-failed; meanwhile `looksLikeRawJsonPayload` only trips when
 * two known schema keys appear, so a single-key `{"post": ...}` wrapper would
 * have leaked all the way to X if the verifier had passed it.
 *
 * This helper is a defense-in-depth recovery: when JSON.parse fails on a
 * payload that begins with `{"post":` (or `{"post" :`), strip the wrapper and
 * return the inner string content so the caller can run it through the
 * verifier as a normal post. If the wrapper shape isn't there, return null
 * and let the caller decide whether to quarantine with a parse_error reason
 * rather than blindly passing raw text downstream.
 *
 * This is intentionally narrow — it only handles the `{"post": "..."}` shape
 * because that is the shape the news/dispatch prompt asks for. It does NOT
 * try to be a general JSON repair tool; that's `safeParseLLMJson`'s job.
 */
export function extractPostField(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  text = stripMarkdownFences(text);

  // Must start with a JSON object whose first key is "post". Tolerate
  // whitespace and either single or double quoting on the key.
  const headMatch = text.match(/^\{\s*["']post["']\s*:\s*["']/);
  if (!headMatch) return null;

  // Slice past the `{"post":"` prefix.
  let inner = text.slice(headMatch[0].length);

  // Strip trailing wrapper artifacts: a closing `"` then optional `}` plus
  // whitespace at the end of the string. Truncated payloads will simply have
  // none of these and we keep whatever content we got.
  inner = inner.replace(/\s*$/, "");
  inner = inner.replace(/\}\s*$/, "");
  inner = inner.replace(/"\s*$/, "");

  // Decode the most common JSON escape sequences so the recovered text reads
  // as natural prose (the verifier and X poster operate on prose, not JSON).
  inner = inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");

  inner = inner.trim();
  if (inner.length < 10) return null;
  return inner;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Remove leading ```json / ``` and trailing ``` */
function stripMarkdownFences(text: string): string {
  // Strip leading fence: ```json, ```JSON, or bare ```
  text = text.replace(/^```(?:json|JSON)?\s*\n?/, "");
  // Strip trailing fence
  text = text.replace(/\n?```\s*$/, "");
  return text.trim();
}

/** Extract outermost { ... } or [ ... ] from text that may have preamble/postamble */
function extractOutermostJson(text: string): string | null {
  // Try object first
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  // Try array
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1);
  }

  return null;
}

/** Attempt to repair truncated JSON by closing open brackets/braces */
function repairTruncatedJson(text: string): string {
  let repaired = text;

  // Remove trailing incomplete string value (truncated mid-string like: "value": "long-f )
  // Match a trailing incomplete string: comma/colon followed by an unclosed quote
  repaired = repaired.replace(/,\s*"[^"]*$/, "");         // trailing key or value mid-string
  repaired = repaired.replace(/:\s*"[^"]*$/, ': ""');      // truncated value — close the string
  repaired = repaired.replace(/,\s*$/, "");                // trailing comma

  // Count unmatched braces/brackets and close them
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  // Close in reverse nesting order: ] first, then }
  repaired += "]".repeat(Math.max(0, openBrackets - closeBrackets));
  repaired += "}".repeat(Math.max(0, openBraces - closeBraces));

  return repaired;
}

/**
 * Attempt to recover structured data from markdown prose.
 *
 * Handles patterns like:
 *   **Novelty Score: 68**\n**Suggested Title: ...**\n**Reasoning: ...**
 *   **Consolidated Entry 1: ...**
 *   **No strong, falsifiable hypotheses can be extracted.**
 *
 * Returns a plain object/array or null if unrecoverable.
 */
function recoverFromMarkdown(text: string): any | null {
  // Pattern 1: "**No ... hypotheses ...**" → empty array (the LLM is saying "none")
  if (/\*\*no\s+(strong|valid|falsifiable|testable)/i.test(text) &&
      /hypothes[ei]s/i.test(text)) {
    return [];
  }

  // Pattern 2: Key-value markdown like "**Novelty Score: 68**\n**Suggested Title: ...**"
  const kvPairs: Record<string, any> = {};
  const kvPattern = /\*\*([^:*]+?)(?:\s*:\s*|\*\*\s*:\s*)([^*]*?)(?:\*\*|$)/gm;
  let match: RegExpExecArray | null;
  let kvCount = 0;

  while ((match = kvPattern.exec(text)) !== null) {
    const key = match[1].trim()
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .replace(/^_+|_+$/g, "");
    let value: any = match[2].trim();

    // Try to parse numeric values
    if (/^\d+(\.\d+)?$/.test(value)) {
      value = parseFloat(value);
    }

    // Normalize common key names to camelCase
    const keyMap: Record<string, string> = {
      "Novelty_Score": "noveltyScore",
      "novelty_score": "noveltyScore",
      "Suggested_Title": "suggestedTitle",
      "suggested_title": "suggestedTitle",
      "Reasoning": "reasoning",
      "reasoning": "reasoning",
      "Impact_Score": "impactScore",
      "impact_score": "impactScore",
      "Composite_Score": "compositeScore",
      "composite_score": "compositeScore",
    };

    const normalizedKey = keyMap[key] ?? key.charAt(0).toLowerCase() + key.slice(1);
    kvPairs[normalizedKey] = value;
    kvCount++;
  }

  if (kvCount >= 2) return kvPairs;

  // Pattern 3: Numbered entries like "**Consolidated Entry 1: ...**"
  const entryPattern = /\*\*(?:Consolidated\s+)?Entry\s+\d+\s*:\s*([^*]+)\*\*/gi;
  const entries: any[] = [];
  while ((match = entryPattern.exec(text)) !== null) {
    entries.push({ title: match[1].trim(), summary: match[1].trim() });
  }
  if (entries.length > 0) return { consolidated: entries };

  return null;
}

/** Last resort: find the last complete object boundary and close the structure */
function aggressiveTruncate(text: string): string | null {
  // For arrays of objects: truncate to last complete object
  const lastComplete = text.lastIndexOf("},");
  if (lastComplete > 0) {
    const truncated = text.slice(0, lastComplete + 1);
    // Determine root structure
    const firstChar = text.trimStart()[0];
    if (firstChar === "[") {
      return truncated + "]";
    }
    // For an object containing arrays, try closing both
    const open = truncated;
    const openBraces = (open.match(/{/g) || []).length;
    const closeBraces = (open.match(/}/g) || []).length;
    const openBrackets = (open.match(/\[/g) || []).length;
    const closeBrackets = (open.match(/\]/g) || []).length;
    return open
      + "]".repeat(Math.max(0, openBrackets - closeBrackets))
      + "}".repeat(Math.max(0, openBraces - closeBraces));
  }

  return null;
}
