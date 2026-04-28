/**
 * PR-K — Critique-by-absence pattern recognition (ANALYSIS mode only).
 *
 * Spec: pr_k_spec.md.
 *
 * In ANALYSIS mode, Agent 306 writes meta-claims about the source's
 * omissions ("The article does not specify …", "It does not address …").
 * Today the verifier treats these as content claims and flags them as
 * LANE_A_FAIL because by construction the content is ABSENT from the
 * source. PR-K recognizes the pattern (source-referent subject + negated
 * discussion verb) and exempts as critique-by-absence.
 *
 * The detection requires BOTH:
 *   1. A source-referent subject ("The article", "The piece", "The source",
 *      "It " when followed by a discussion verb)
 *   2. A negated discussion verb from the curated list ("does not specify",
 *      "fails to address", "never names", …)
 *
 * Hard rule: verbs like "work", "improve", "exist", "function", "succeed",
 * "deliver" are NOT discussion verbs — sentences using them must still
 * flag.
 *
 * Run: npx tsx --test server/__tests__/artifactMode.critiqueByAbsence.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isCritiqueByAbsence } from "../artifactMode.js";

// ── True positives (the 4 patterns this PR closes) ────────────────────────

describe("PR-K — true positives (source-referent subject + negated discussion verb)", () => {
  it("S62 — 'The article does not specify how alignment will be measured.'", () => {
    const s = "The article does not specify how alignment will be measured.";
    assert.equal(isCritiqueByAbsence(s), true);
  });

  it("S64 — 'It does not address the question of accountability.'", () => {
    const s = "It does not address the question of accountability.";
    assert.equal(isCritiqueByAbsence(s), true);
  });

  it("'The piece never names the labs it considers comparable.'", () => {
    const s = "The piece never names the labs it considers comparable.";
    assert.equal(isCritiqueByAbsence(s), true);
  });

  it("'The source fails to define what \"serious alignment\" means in practice.'", () => {
    const s = `The source fails to define what 'serious alignment' means in practice.`;
    assert.equal(isCritiqueByAbsence(s), true);
  });

  it("'The document does not mention specific compute thresholds.'", () => {
    const s = "The document does not mention specific compute thresholds.";
    assert.equal(isCritiqueByAbsence(s), true);
  });

  it("'The report fails to discuss the role of regulators.'", () => {
    const s = "The report fails to discuss the role of regulators.";
    assert.equal(isCritiqueByAbsence(s), true);
  });
});

// ── True negatives (CRITICAL regression-prevention tests) ────────────────

describe("PR-K — true negatives (content claims must NOT be exempted)", () => {
  it("'The medication does not work for chronic pain patients.' — not source-referent, 'work' not a discussion verb", () => {
    // Subject is "the medication", not source-referent. "work" is not a
    // discussion verb — must NOT be exempted.
    const s = "The medication does not work for chronic pain patients.";
    assert.equal(isCritiqueByAbsence(s), false);
  });

  it("'The model does not improve on prior baselines.' — 'improve' not a discussion verb", () => {
    // Subject ("the model") is not in the source-referent list AND
    // "improve" is not a discussion verb.
    const s = "The model does not improve on prior baselines.";
    assert.equal(isCritiqueByAbsence(s), false);
  });

  it("'It does not exist in the wild.' — 'exist' not a discussion verb", () => {
    const s = "It does not exist in the wild.";
    assert.equal(isCritiqueByAbsence(s), false);
  });

  it("'GPT-4 does not function in low-resource languages.' — subject is GPT-4 + 'function' not a discussion verb", () => {
    const s = "GPT-4 does not function in low-resource languages.";
    assert.equal(isCritiqueByAbsence(s), false);
  });

  it("'It does not work as advertised.' — 'work' not a discussion verb (even with 'It' subject)", () => {
    // Important: even when the subject is "It " (which by itself MIGHT be
    // source-referent in context), the discussion-verb requirement still
    // protects against content claims with non-discussion verbs.
    const s = "It does not work as advertised.";
    assert.equal(isCritiqueByAbsence(s), false);
  });

  it("'The article succeeds in its goals.' — no negation, no discussion verb match", () => {
    const s = "The article succeeds in its goals.";
    assert.equal(isCritiqueByAbsence(s), false);
  });

  it("'The article specifies how alignment will be measured.' — not negated", () => {
    const s = "The article specifies how alignment will be measured.";
    assert.equal(isCritiqueByAbsence(s), false);
  });
});
