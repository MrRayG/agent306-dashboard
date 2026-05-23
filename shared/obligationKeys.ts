/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — OBLIGATION KEY HELPERS (pure, side-effect-free)             [PR #420]
 *
 * Pure extraction from `server/ruleCorrectiveObligations.ts` (PR #384, #419)
 * so that read-only operator tooling (`scripts/inspectObligations.ts`) and
 * the runtime projection can compute the SAME `obligationId` from the SAME
 * `(primitive, outputNoun, inputNoun)` triple.
 *
 * WHY THIS LIVES IN `shared/`:
 *   - Pure functions, NO `fs`, NO `dataPaths` side effects, NO DB import.
 *   - The inspect CLI hard rule (`scripts/inspectObligations.ts` header)
 *     forbids importing from `server/` because the server module loads
 *     `dataPaths.ts` which has a top-level `fs.mkdirSync` side effect at
 *     module-load time. Extracting the noun-family normalization + the
 *     work-item hash to `shared/` is the minimum surface that lets the CLI
 *     match the runtime grouping without dragging in those side effects.
 *
 * NO BEHAVIOR CHANGE:
 *   - `server/ruleCorrectiveObligations.ts` re-exports these from this
 *     module to preserve its public API. The byte-for-byte identity of
 *     `obligationId` for every `(primitive, outputNoun, inputNoun)` triple
 *     is preserved (see `obligationKeys.test.ts` golden vectors).
 *   - Anyone who imported `normalizeNounFamily`, `normalizedWorkItemKey`,
 *     or `obligationIdForWorkItem` from the server module continues to do
 *     so — the names and signatures are unchanged.
 *
 * THIS MODULE MUST REMAIN PURE.
 *   - No `Date.now`, no `Math.random`, no env reads, no `process.cwd`.
 *   - Adding anything that touches the filesystem, the DB, or any global
 *     mutable state breaks the inspect CLI's determinism contract.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from "crypto";

/**
 * Normalize a noun string into a small family of canonical identifiers so
 * that ratio-rule deficits that describe the same work-item (e.g.
 * "archived" vs "archiving" vs "archive") collapse to the SAME obligation.
 *
 * Conservative on purpose: explicit synonym table + a single trailing-"s"
 * drop. No stemming, no Levenshtein matching — staying strict keeps
 * false-positive merges out of the obligation surface.
 */
export function normalizeNounFamily(noun: string): string {
  if (typeof noun !== "string") return "";
  const cleaned = noun
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "";
  // Explicit family folding — order matters: more specific matches first.
  const SYNONYMS: Array<[RegExp, string]> = [
    [/^(kb|knowledge)(_?(entry|entries|item|items|record|records))?$/, "kb_entry"],
    [/^(archive|archived|archiving)$/, "archived"],
    [/^(draft|drafted)(_?(output|artifact|outputs|artifacts))?$/, "draft_output_artifact"],
    [/^(draft_?output_?artifact|draft_?artifact)s?$/, "draft_output_artifact"],
    [/^(synthesi[sz]ed?|synthesi[sz]e)$/, "synthesis"],
  ];
  for (const [re, fam] of SYNONYMS) {
    if (re.test(cleaned)) return fam;
  }
  // Drop a trailing pluralizing "s" only when the singular still looks
  // like an identifier (>2 chars, not already ending in "ss").
  if (cleaned.length > 3 && cleaned.endsWith("s") && !cleaned.endsWith("ss")) {
    return cleaned.slice(0, -1);
  }
  return cleaned;
}

/**
 * Build the canonical content-addressed work-item key for a ratio-rule
 * deficit. Two events with the same `(primitive, outputNoun-family,
 * inputNoun-family)` triple produce the same key — that is the dedupe.
 */
export function normalizedWorkItemKey(
  primitive: "ratio_rule",
  outputNoun: string,
  inputNoun: string,
): string {
  const outFam = normalizeNounFamily(outputNoun);
  const inFam = normalizeNounFamily(inputNoun);
  return `${primitive}|out:${outFam}|in:${inFam}`;
}

/**
 * Hash a normalized work-item key into the 16-hex-char obligationId form
 * (`oblg_<sha1-16>`). Stable, deterministic, content-addressed.
 *
 * Exported because the inspect CLI needs to compute the runtime
 * obligationId for each event in the JSONL ledger so it can group events
 * the same way the runtime projection does (see PR #420 motivation).
 */
export function hashObligationIdFromKey(normalizedKey: string): string {
  const h = crypto
    .createHash("sha1")
    .update(normalizedKey)
    .digest("hex")
    .slice(0, 16);
  return `oblg_${h}`;
}

/**
 * Convenience: compute the obligationId directly from
 * `(primitive, outputNoun, inputNoun)`. Equivalent to
 * `hashObligationIdFromKey(normalizedWorkItemKey(primitive, outputNoun, inputNoun))`.
 */
export function obligationIdForWorkItem(
  primitive: "ratio_rule",
  outputNoun: string,
  inputNoun: string,
): string {
  return hashObligationIdFromKey(normalizedWorkItemKey(primitive, outputNoun, inputNoun));
}
