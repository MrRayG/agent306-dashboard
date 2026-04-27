// ─────────────────────────────────────────────────────────────────────────────
// PR-H — shared text normalization for verifier source matching.
//
// The two-lane verifier (server/claimVerifier.ts) compares quoted spans and
// short attributed phrases against source text using a `lowercase + collapse
// whitespace` normalization. That step is too thin: it does not fold smart
// quotes, curly apostrophes, non-breaking hyphens, or NBSPs. The OpenAI
// "Our Principles" Deep Read on 2026-04-26 produced four false-positive
// "fabricated quote" rejections on text that appears verbatim in the source
// but uses curly typography on one side and ASCII on the other.
//
// This module centralizes the normalization so claim text and source text
// can be compared symmetrically. Each step below is justified by a regression
// test in server/__tests__/verifierTextNormalization.test.ts that fails
// without it. No additional steps are added speculatively.
//
// Hard rules:
//   - The fold is for COMPARISON ONLY. We never write the normalized form
//     back into draft text or source text — the user-visible strings are
//     untouched.
//   - The fold is symmetric: claim and source go through the same function
//     with the same options. Any asymmetry would re-introduce the same
//     class of false positive.
//   - The fold does NOT relax fabrication detection. A genuinely fabricated
//     quote is still absent from the source after normalization.
// ─────────────────────────────────────────────────────────────────────────────

/** Curly / typographic double quotes → ASCII straight double quote.
 *
 *  Justified by: "smart quotes in source vs. straight quotes in claim"
 *  and "straight quotes in source vs. smart quotes in claim". */
const SMART_DOUBLE_QUOTES = /[“”‟″❝❞〝〞]/g;

/** Curly / typographic single quotes / apostrophes → ASCII straight apostrophe.
 *
 *  Justified by: "curly apostrophe in source vs. straight apostrophe in
 *  claim" and the longer 'misplaced worry' sentence test (which contains
 *  `weren't` with U+2019 in the source vs ASCII U+0027 in the claim). */
const SMART_SINGLE_QUOTES = /[‘’‚‛′❛❜]/g;

/** Hyphen / dash family → ASCII hyphen-minus.
 *
 *  Justified by: U+2011 NBH bidirectional tests (the GPT‑2 case from the
 *  spec) AND the em/en/ASCII-double-hyphen matrix test.
 *  Includes:
 *    U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
 *    U+2013 en dash, U+2014 em dash, U+2015 horizontal bar,
 *    U+2212 minus sign, U+FE58 small em dash, U+FE63 small hyphen-minus,
 *    U+FF0D fullwidth hyphen-minus.
 *  ASCII double-hyphen `--` is collapsed to `-` after this fold so
 *  `--` in a draft normalizes to the same single hyphen as `—` in source. */
const DASH_FAMILY = /[‐‑‒–—―−﹘﹣－]/g;

/** Whitespace family → single ASCII space, then runs collapsed.
 *
 *  Justified by: "NBSP in source vs. regular space in claim". Also folds
 *  zero-width characters (U+200B-U+200D, U+FEFF) which sometimes leak in
 *  via clipboard or HTML pastes — they are invisible to the human eye and
 *  cause spurious mismatch. */
const ZERO_WIDTH = /[​‌‍﻿]/g;
const WHITESPACE_RUN = /\s+/g;

/** Options for the normalization. The defaults mirror the verifier's
 *  `normalize` function: lowercase + whitespace fold. The PR-H additions
 *  (quote folding, dash folding, zero-width strip) are on by default
 *  because every existing call site benefits from them — there is no
 *  call site that wants to distinguish curly from straight quotes for
 *  source matching. */
export interface NormalizeForMatchingOptions {
  /** Lowercase the result. Default true. */
  caseFold?: boolean;
  /** Fold curly quotes / apostrophes to ASCII. Default true. */
  foldQuotes?: boolean;
  /** Fold dash/hyphen family to ASCII `-` (incl. ASCII `--` → `-`). Default true. */
  foldDashes?: boolean;
}

/**
 * Normalize a string for verifier substring/equality comparison.
 *
 * The transform pipeline (in order):
 *   1. Strip zero-width characters (U+200B-U+200D, U+FEFF).
 *   2. Optional: fold curly double + single quotes to ASCII " and '.
 *   3. Optional: fold the dash/hyphen family (incl. U+2011 NBH, en/em
 *      dashes) to ASCII `-`. Then collapse runs of `-` to a single `-`,
 *      so an ASCII `--` em-dash substitute folds to the same single `-`
 *      that `—` would.
 *   4. Replace any whitespace (incl. NBSP / tabs / newlines) with a single
 *      ASCII space, then collapse runs.
 *   5. Optional lowercase.
 *   6. Trim.
 *
 * All transformations are idempotent (running the function twice gives
 * the same output as running it once).
 */
export function normalizeForMatching(s: string, opts: NormalizeForMatchingOptions = {}): string {
  if (!s) return "";
  const caseFold  = opts.caseFold  ?? true;
  const foldQuotes = opts.foldQuotes ?? true;
  const foldDashes = opts.foldDashes ?? true;

  let out = s.replace(ZERO_WIDTH, "");

  if (foldQuotes) {
    out = out.replace(SMART_DOUBLE_QUOTES, '"').replace(SMART_SINGLE_QUOTES, "'");
  }

  if (foldDashes) {
    out = out.replace(DASH_FAMILY, "-");
    // Collapse runs of `-` to a single `-` so the ASCII double-hyphen
    // convention (`--` for em dash) folds to the same single `-` that
    // `—` does. Without this collapse "shipped quickly--faster" would
    // remain `shipped quickly--faster` and not match `shipped quickly-faster`.
    out = out.replace(/-{2,}/g, "-");
  }

  out = out.replace(WHITESPACE_RUN, " ").trim();
  if (caseFold) out = out.toLowerCase();
  return out;
}

/**
 * Substring containment check using the same normalization on both sides.
 * Mirrors the verifier's `normalizedContains(haystack, needle)` semantics
 * (return true for needles shorter than 3 chars, otherwise normalized
 * substring match).
 *
 * Symmetric — both inputs go through the SAME normalize call with the
 * SAME options. Any asymmetry here would re-introduce the bug class
 * PR-H is fixing.
 */
export function normalizedContainsForMatching(
  haystack: string,
  needle: string,
  opts: NormalizeForMatchingOptions = {},
): boolean {
  if (needle.length < 3) return true;
  const H = normalizeForMatching(haystack, opts);
  const N = normalizeForMatching(needle, opts);
  return H.includes(N);
}
