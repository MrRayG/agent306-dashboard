/**
 * PR-J — `extractQuotedSpans` unit tests.
 *
 * Spec: pr_j_spec.md.
 *
 * The helper extracts quoted spans from a sentence so the verifier's
 * ANALYSIS branch can route quote+commentary sentences through the
 * verbatim-quote check (and exempt the surrounding gloss as author voice
 * when every quoted span verifies). Detection rules:
 *
 *   - ASCII double quotes "…": always extracted.
 *   - Curly double quotes “…”: always extracted.
 *   - ASCII single quotes '…': only when span is ≥ 4 words (avoid
 *     contractions/possessives like don't, Agent 306's).
 *   - Curly single quotes ‘…’: same ≥ 4 word rule.
 *
 * Input is normalized via the PR-H text-normalization helpers BEFORE
 * extraction so curly typography in the sentence still matches ASCII
 * delimiters in source.
 *
 * Run: npx tsx --test server/__tests__/artifactMode.quotes.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractQuotedSpans } from "../artifactMode.js";

describe("PR-J — extractQuotedSpans", () => {
  it("extracts an ASCII double-quoted span", () => {
    const spans = extractQuotedSpans(`The article says "safe and beneficial AGI" is the goal.`);
    assert.deepEqual(spans, ["safe and beneficial AGI"]);
  });

  it("extracts a curly double-quoted span (U+201C/U+201D)", () => {
    const spans = extractQuotedSpans(`The article says “safe and beneficial AGI” is the goal.`);
    assert.deepEqual(spans, ["safe and beneficial AGI"]);
  });

  it("extracts a single-quoted span ≥ 4 words", () => {
    const spans = extractQuotedSpans(`The frame is 'a misplaced worry about extinction' from the principles.`);
    assert.deepEqual(spans, ["a misplaced worry about extinction"]);
  });

  it("extracts a curly single-quoted span ≥ 4 words (U+2018/U+2019)", () => {
    const spans = extractQuotedSpans(`The frame is ‘a misplaced worry about extinction’ from the principles.`);
    assert.deepEqual(spans, ["a misplaced worry about extinction"]);
  });

  it("does NOT extract a possessive ('s)", () => {
    const spans = extractQuotedSpans(`Agent 306's read is that the principles are deliberately broad.`);
    assert.deepEqual(spans, []);
  });

  it("does NOT extract a contraction (don't)", () => {
    const spans = extractQuotedSpans(`Altman doesn't claim certainty here.`);
    assert.deepEqual(spans, []);
  });

  it("does NOT extract a 1-3 word single-quoted span", () => {
    const spans = extractQuotedSpans(`Altman writes about 'safe AGI' in the post.`);
    assert.deepEqual(spans, []);
  });

  it("DOES extract a 1-3 word DOUBLE-quoted span (double quotes are unambiguous)", () => {
    const spans = extractQuotedSpans(`Altman writes about "safe AGI" in the post.`);
    assert.deepEqual(spans, ["safe AGI"]);
  });

  it("extracts multiple double-quoted spans in one sentence", () => {
    const spans = extractQuotedSpans(
      `The piece frames it as "a misplaced worry" while also calling it "the decisive question".`,
    );
    assert.deepEqual(spans, ["a misplaced worry", "the decisive question"]);
  });

  it("returns [] when there are no quoted spans", () => {
    const spans = extractQuotedSpans(`The agent reads the principles as deliberately broad.`);
    assert.deepEqual(spans, []);
  });

  it("normalizes input first — curly delimiters with NBSP inside still extract", () => {
    // U+00A0 NBSP between words; PR-H normalizer collapses to ASCII space
    const sentence = `Per the doc, “new economic models” will emerge.`;
    const spans = extractQuotedSpans(sentence);
    assert.equal(spans.length, 1);
    assert.equal(spans[0], "new economic models");
  });

  it("does not extract a single-quoted span that contains a possessive (still under 4 words)", () => {
    const spans = extractQuotedSpans(`The agent's view is 'OpenAI's plan' is broad.`);
    // Outer single-quoted span is "OpenAI's plan" — 2 words, below threshold,
    // so it should NOT be extracted. Possessive 's also should not match.
    assert.deepEqual(spans, []);
  });
});
