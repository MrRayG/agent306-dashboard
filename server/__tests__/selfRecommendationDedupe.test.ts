/**
 * Dedupe regression tests for selfRecommendationEngine.
 *
 * Background: SelfEvolution mints a fresh insight ID every cycle
 * (`evo_${Date.now()}_${rand}`), and GoalEngine's missing-primitive emit
 * uses `il_${Date.now()}_${rand}` from the insight ledger. Before the
 * dedupeKey path landed, the LLM emitting the same governance-debt
 * suggestion (or the action translator failing on the same vague action)
 * on consecutive days produced N identical proposed rows because the
 * existing sourceInsightId-based idempotency never matched across cycles.
 *
 * These tests pin the new behavior: a content fingerprint collapses
 * semantically-equivalent proposals into the existing active row, while
 * leaving operator-drafted recs and post-decision (rejected/applied) rows
 * unaffected.
 *
 * Run: npx tsx --test server/__tests__/selfRecommendationDedupe.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { selfRecommendations } from "@shared/schema";
import {
  proposeRecommendation,
  approveRecommendation,
  rejectRecommendation,
  listRecommendations,
  computeDedupeKey,
  findActiveRecommendationByDedupeKey,
} from "../selfRecommendationEngine.js";

function wipe() {
  try {
    db.delete(selfRecommendations).run();
  } catch {}
}

describe("selfRecommendationEngine — content-fingerprint dedupe", () => {
  before(wipe);
  beforeEach(wipe);
  after(wipe); // Don't leak rows into other test files that share the persistent DB.

  it("collapses two semantically-equivalent SelfEvolution proposals into one row", () => {
    // Simulate two consecutive cycles producing the same governance-debt
    // suggestion with different (always-fresh) insight IDs.
    const first = proposeRecommendation({
      category: "engine",
      title: "Self-evolution insight: Hard cap active hypotheses at 12",
      rationale: "Active hypothesis count drifting; introduce a cap.",
      proposedChange: "Implement a hard cap of 12 active hypotheses; archive the rest.",
      sourceInsightId: "evo_1700000000000_aaaaaa",
    });
    const second = proposeRecommendation({
      category: "engine",
      title: "Self-evolution insight: Hard cap active hypotheses at 12",
      rationale: "Active hypothesis count drifting; introduce a cap.",
      proposedChange: "Implement a hard cap of 12 active hypotheses; archive the rest.",
      sourceInsightId: "evo_1700000086400_bbbbbb",
    });

    assert.equal(first.id, second.id, "second propose() should collapse into the first");
    const all = listRecommendations({});
    assert.equal(all.length, 1, "only one row should exist after the duplicate insert");
  });

  it("normalizes whitespace and punctuation so near-identical proposals collapse", () => {
    const first = proposeRecommendation({
      category: "engine",
      title: "1-in-1-out hypothesis policy",
      rationale: "We keep adding hypotheses without retiring any.",
      proposedChange: "For each new hypothesis, archive one stale hypothesis (1-in-1-out).",
    });
    const second = proposeRecommendation({
      category: "engine",
      // Same content, different surface: extra spaces, different punctuation,
      // case differences. The normalized fingerprint should still match.
      title: "1 in 1 out hypothesis policy",
      rationale: "Whatever the rationale - rationale isn't part of the key.",
      proposedChange: "For   each NEW hypothesis,  archive one stale hypothesis (1 in 1 out).",
    });
    assert.equal(first.id, second.id, "near-identical proposals should collapse via normalization");
  });

  it("does NOT collapse genuinely different proposals", () => {
    const a = proposeRecommendation({
      category: "engine",
      title: "Hard cap active hypotheses",
      rationale: "Drift",
      proposedChange: "Cap at 12 active hypotheses.",
    });
    const b = proposeRecommendation({
      category: "engine",
      title: "Pre-formation data-access gate",
      rationale: "Avoid hypotheses with no data path",
      proposedChange: "Block hypothesis creation until data availability is confirmed.",
    });
    assert.notEqual(a.id, b.id);
    assert.equal(listRecommendations({}).length, 2);
  });

  it("treats different categories as different fingerprints", () => {
    const a = proposeRecommendation({
      category: "engine",
      title: "Cap hypotheses",
      rationale: "x",
      proposedChange: "Cap at 12.",
    });
    const b = proposeRecommendation({
      category: "config", // different category — should NOT dedupe
      title: "Cap hypotheses",
      rationale: "x",
      proposedChange: "Cap at 12.",
    });
    assert.notEqual(a.id, b.id);
  });

  it("allows a fresh proposal once the prior one is rejected (operator decision unblocks future signals)", () => {
    const first = proposeRecommendation({
      category: "engine",
      title: "Archive 10-15 stale hypotheses",
      rationale: "Backlog",
      proposedChange: "Archive 10-15 stale hypotheses immediately.",
    });
    rejectRecommendation(first.id, "alice", "not now");

    const second = proposeRecommendation({
      category: "engine",
      title: "Archive 10-15 stale hypotheses",
      rationale: "Backlog",
      proposedChange: "Archive 10-15 stale hypotheses immediately.",
    });
    // Once the operator has acted, dedupe lets the same concern re-surface.
    assert.notEqual(first.id, second.id);
  });

  it("does NOT collapse when caller explicitly opts out (operator-drafted via router)", () => {
    const first = proposeRecommendation({
      category: "prompt",
      title: "Tone tweak",
      rationale: "x",
      proposedChange: "Use warmer tone.",
    });
    const second = proposeRecommendation({
      category: "prompt",
      title: "Tone tweak",
      rationale: "x",
      proposedChange: "Use warmer tone.",
      dedupeKey: null, // operator opted out — they want the duplicate
      author: "operator",
    });
    assert.notEqual(first.id, second.id);
    assert.equal(listRecommendations({}).length, 2);
  });

  it("explicit dedupeKey overrides the default fingerprint (caller knows the semantic axis)", () => {
    // Two proposals with totally different titles/text but the same caller-
    // supplied semantic key (e.g. "missing-primitive: produce one artifact").
    // They should still collapse — the caller is asserting these are the
    // same concern.
    const first = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: action translator could not parse insight",
      rationale: "Insight 1: produce one concrete artifact this cycle",
      proposedChange: "Add primitive supporting artifact-once goals.",
      dedupeKey: "shared-key-abc",
    });
    const second = proposeRecommendation({
      category: "engine",
      // Different surface text, same caller-supplied key
      title: "missing-primitive: artifact-once unsupported",
      rationale: "Insight 2: produce one briefing this cycle",
      proposedChange: "Translator gap on artifact-once primitive.",
      dedupeKey: "shared-key-abc",
    });
    assert.equal(first.id, second.id);
  });

  it("findActiveRecommendationByDedupeKey returns the live row, ignores rejected/applied", () => {
    const key = computeDedupeKey("engine", "Test", "Test change");
    const rec = proposeRecommendation({
      category: "engine",
      title: "Test",
      rationale: "r",
      proposedChange: "Test change",
    });
    assert.equal(rec.dedupeKey, key);
    assert.equal(findActiveRecommendationByDedupeKey(key)?.id, rec.id);

    rejectRecommendation(rec.id, "alice");
    // Rejected rows are NOT considered active — a future proposal can re-emit.
    assert.equal(findActiveRecommendationByDedupeKey(key), undefined);
  });

  it("approved rows still block a duplicate proposal (operator hasn't dismissed yet)", () => {
    const first = proposeRecommendation({
      category: "engine",
      title: "Convert one hypothesis to content artifact",
      rationale: "r",
      proposedChange: "Pick one validated hypothesis and ship a synthesis post.",
    });
    approveRecommendation(first.id, "alice");

    const second = proposeRecommendation({
      category: "engine",
      title: "Convert one hypothesis to content artifact",
      rationale: "r",
      proposedChange: "Pick one validated hypothesis and ship a synthesis post.",
    });
    assert.equal(first.id, second.id, "approved-but-not-applied row still blocks duplicate");
  });
});

describe("missing-primitive emit — repeat suppression across cycles", () => {
  before(wipe);
  beforeEach(wipe);
  after(wipe);

  it("two cycles failing to translate the same vague action emit ONE rec", () => {
    // Mirrors goalEngine.promoteInsightToGoal: it computes a dedupeKey from
    // the (action + insight) text, NOT from the always-fresh insight id.
    // Two ledger entries with different ids but the same vague action text
    // should collapse to one missing-primitive rec.
    const sharedAction = "Produce one concrete output artifact this cycle to exercise Storytelling.";
    const sharedInsight = "Storytelling competency has been flat for 3 cycles.";

    const dedupeKey = computeDedupeKey(
      "engine",
      "missing-primitive: action translator gap",
      `${sharedAction}\n${sharedInsight}`,
    );

    const first = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: action translator could not parse insight",
      rationale: `GoalEngine could not translate insight il_111_aaa: '${sharedAction}'`,
      proposedChange: `Add action primitive supporting: ${sharedInsight}`,
      sourceInsightId: "il_111_aaa",
      dedupeKey,
    });
    const second = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: action translator could not parse insight",
      rationale: `GoalEngine could not translate insight il_222_bbb: '${sharedAction}'`,
      proposedChange: `Add action primitive supporting: ${sharedInsight}`,
      sourceInsightId: "il_222_bbb", // fresh insight id, same content
      dedupeKey,
    });

    assert.equal(first.id, second.id, "second cycle should collapse into the first row");
    const all = listRecommendations({});
    assert.equal(all.length, 1);
  });

  it("two cycles failing on DIFFERENT vague actions emit TWO recs (no over-collapse)", () => {
    const keyA = computeDedupeKey(
      "engine",
      "missing-primitive: action translator gap",
      "Action A about storytelling\nInsight A",
    );
    const keyB = computeDedupeKey(
      "engine",
      "missing-primitive: action translator gap",
      "Action B about empathy\nInsight B",
    );
    assert.notEqual(keyA, keyB);

    const a = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: action translator could not parse insight",
      rationale: "x",
      proposedChange: "x",
      dedupeKey: keyA,
    });
    const b = proposeRecommendation({
      category: "engine",
      title: "missing-primitive: action translator could not parse insight",
      rationale: "x",
      proposedChange: "x",
      dedupeKey: keyB,
    });
    assert.notEqual(a.id, b.id);
  });
});
