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

  console.warn(`[JSONRepair] Could not parse JSON for ${label}: ${text.slice(0, 200)}`);
  return null;
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
