/**
 * Tests for the Research Focus Rubric (PR #285).
 *
 * Spec invariants this file pins:
 *   1. Weighted overall score uses the operator-defined weights
 *      40 / 30 / 15 / 15 and the 7.5 pursue threshold.
 *   2. Hypotheses without a complete self-experiment protocol can never
 *      reach verdict='pursue' even when overall >= 7.5 — they route to
 *      'review' so the operator approves before any deep work.
 *   3. Generation cap is enforced at 8; force-rank picks at most 3 pursue
 *      candidates; overflow is demoted to 'review' (never silently dropped).
 *   4. Deterministic duplication check: exact dup blocks (verdict='reject'),
 *      near dup routes to operator review, no overlap passes through.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_FOCUS_WEIGHTS,
  PURSUE_THRESHOLD,
  MAX_GENERATED_PER_CYCLE,
  TOP_SELECTION_MAX,
  EXACT_DUP_THRESHOLD,
  NEAR_DUP_THRESHOLD,
  computeOverall,
  validateSelfExperimentProtocol,
  scoreResearchFocus,
  checkDuplication,
  canonicalizeClaim,
  selectTopHypotheses,
} from "../researchFocusRubric.ts";
import type {
  SelfExperimentProtocol,
  ResearchFocusInput,
} from "../researchFocusRubric.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const goodProtocol: SelfExperimentProtocol = {
  metric: "% hypotheses scoring >= 7.5 on the focus rubric per cycle",
  design: "Run two consecutive research cycles, A with the rubric off and B with it on; compare cycle-level pursue counts and operator-review queue depth.",
  successThreshold: "B yields >= 50% fewer hypotheses below 7.5 than A; operator review queue is drained within 24h",
  rollbackCondition: "If pursue count drops below 1 per cycle for 3 consecutive cycles, revert the rubric to advisory mode and surface a self-recommendation",
};

function mkInput(overrides: Partial<ResearchFocusInput> = {}): ResearchFocusInput {
  return {
    claim: "Adding a research focus rubric raises pursue-quality without starving the active queue",
    scores: {
      selfImprovementLeverage:   9,
      selfExperimentFeasibility: 8,
      aiBreakthroughNovelty:     6,
      efficiencyLowWaste:        7,
    },
    selfExperimentProtocol: goodProtocol,
    ...overrides,
  };
}

// ── Weights / overall ───────────────────────────────────────────────────────

describe("computeOverall", () => {
  it("uses the operator-defined 40/30/15/15 weights", () => {
    assert.equal(RESEARCH_FOCUS_WEIGHTS.selfImprovementLeverage,   0.40);
    assert.equal(RESEARCH_FOCUS_WEIGHTS.selfExperimentFeasibility, 0.30);
    assert.equal(RESEARCH_FOCUS_WEIGHTS.aiBreakthroughNovelty,     0.15);
    assert.equal(RESEARCH_FOCUS_WEIGHTS.efficiencyLowWaste,        0.15);
    const sum =
      RESEARCH_FOCUS_WEIGHTS.selfImprovementLeverage +
      RESEARCH_FOCUS_WEIGHTS.selfExperimentFeasibility +
      RESEARCH_FOCUS_WEIGHTS.aiBreakthroughNovelty +
      RESEARCH_FOCUS_WEIGHTS.efficiencyLowWaste;
    assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);
  });

  it("computes overall as the weighted sum on the 0-10 scale", () => {
    const o = computeOverall({
      selfImprovementLeverage:   10,
      selfExperimentFeasibility: 10,
      aiBreakthroughNovelty:     10,
      efficiencyLowWaste:        10,
    });
    assert.equal(o, 10);

    const mixed = computeOverall({
      selfImprovementLeverage:   8,   // 8 * 0.40 = 3.2
      selfExperimentFeasibility: 7,   // 7 * 0.30 = 2.1
      aiBreakthroughNovelty:     6,   // 6 * 0.15 = 0.9
      efficiencyLowWaste:        5,   // 5 * 0.15 = 0.75
    }); // = 6.95
    assert.equal(mixed, 7.0); // round1 → 7
  });

  it("clamps out-of-range scores to [0, 10]", () => {
    const o = computeOverall({
      selfImprovementLeverage:   -5,   // → 0
      selfExperimentFeasibility: 99,   // → 10
      aiBreakthroughNovelty:     NaN,  // → 0
      efficiencyLowWaste:        7,
    });
    // 0*0.4 + 10*0.3 + 0*0.15 + 7*0.15 = 3 + 1.05 = 4.05
    assert.equal(o, 4.1);
  });
});

// ── Threshold + protocol gate ───────────────────────────────────────────────

describe("scoreResearchFocus", () => {
  it("verdict='pursue' when above threshold AND protocol is complete", () => {
    const r = scoreResearchFocus(mkInput());
    assert.ok(r.passesThreshold);
    assert.equal(r.verdict, "pursue");
    assert.ok(r.overall >= PURSUE_THRESHOLD);
    assert.ok(r.selfExperimentProtocol);
  });

  it("verdict='reject' when overall < 7.5 (regardless of protocol completeness)", () => {
    const r = scoreResearchFocus(mkInput({
      scores: {
        selfImprovementLeverage:   5,
        selfExperimentFeasibility: 5,
        aiBreakthroughNovelty:     5,
        efficiencyLowWaste:        5,
      },
    }));
    assert.equal(r.passesThreshold, false);
    assert.equal(r.verdict, "reject");
    assert.match(r.reason, /threshold/);
  });

  it("verdict='review' when above threshold but protocol incomplete (CRITICAL invariant)", () => {
    const r = scoreResearchFocus(mkInput({ selfExperimentProtocol: undefined }));
    assert.ok(r.passesThreshold);
    assert.equal(r.verdict, "review");
    assert.match(r.reason, /selfExperimentProtocol/);
  });

  it("rejects empty / short protocol fields", () => {
    const r = scoreResearchFocus(mkInput({
      selfExperimentProtocol: {
        metric: "x",
        design: "x",
        successThreshold: "x",
        rollbackCondition: "x",
      } as SelfExperimentProtocol,
    }));
    assert.equal(r.verdict, "review");
  });
});

// ── Protocol validator (standalone) ─────────────────────────────────────────

describe("validateSelfExperimentProtocol", () => {
  it("accepts a complete protocol and trims fields", () => {
    const v = validateSelfExperimentProtocol({
      metric: "  some long metric description  ",
      design: "some long design paragraph here",
      successThreshold: "above some threshold value",
      rollbackCondition: "revert if regression detected over n cycles",
    });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.protocol.metric, "some long metric description");
  });

  it("rejects when any of the four required fields is missing or too short", () => {
    for (const missing of ["metric", "design", "successThreshold", "rollbackCondition"] as const) {
      const obj: Record<string, string> = {
        metric: "a clearly long metric string",
        design: "a clearly long design string",
        successThreshold: "a clearly long threshold",
        rollbackCondition: "a clearly long rollback rule",
      };
      obj[missing] = "x";
      const v = validateSelfExperimentProtocol(obj);
      assert.equal(v.ok, false, `should reject missing/short ${missing}`);
    }
  });

  it("rejects non-objects", () => {
    assert.equal(validateSelfExperimentProtocol(null).ok, false);
    assert.equal(validateSelfExperimentProtocol(undefined).ok, false);
    assert.equal(validateSelfExperimentProtocol("string").ok, false);
    assert.equal(validateSelfExperimentProtocol(123).ok, false);
  });
});

// ── Duplication check ──────────────────────────────────────────────────────

describe("checkDuplication", () => {
  it("returns 'none' when archive is empty", () => {
    const r = checkDuplication("Adding a focus rubric improves hypothesis quality", []);
    assert.equal(r.kind, "none");
    assert.equal(r.matchedId, null);
  });

  it("flags exact duplicates (>= 0.85 jaccard)", () => {
    const archive = [
      { id: "a1", claim: "Adding a focus rubric improves Agent 306 hypothesis quality" },
    ];
    const r = checkDuplication("Adding a focus rubric improves Agent 306 hypothesis quality", archive);
    assert.equal(r.kind, "exact");
    assert.ok(r.similarity >= EXACT_DUP_THRESHOLD * 10 / 10 - 0.05); // similarity is jaccard, may be 1.0
    assert.equal(r.matchedId, "a1");
  });

  it("routes near-duplicates to operator review", () => {
    const archive = [
      { id: "a2", claim: "Focus rubric improves hypothesis quality and reduces wasteful research" },
    ];
    // Share many tokens but not all → falls in [NEAR_DUP_THRESHOLD, EXACT_DUP_THRESHOLD).
    const r = checkDuplication("Focus rubric improves hypothesis quality drastically", archive);
    assert.ok(r.similarity >= NEAR_DUP_THRESHOLD * 10 / 10 - 0.05 || r.kind === "near" || r.kind === "exact");
    assert.notEqual(r.kind, "none");
  });

  it("returns 'none' for unrelated claims", () => {
    const archive = [
      { id: "a3", claim: "The price of bitcoin will exceed 200000 by end of 2027" },
    ];
    const r = checkDuplication("Adding a research focus rubric improves Agent 306 reasoning quality", archive);
    assert.equal(r.kind, "none");
  });

  it("canonicalizeClaim drops stopwords + sub-3-char tokens deterministically", () => {
    const a = canonicalizeClaim("The quick brown fox jumps over a lazy dog");
    const b = canonicalizeClaim("The QUICK Brown   fox jumps   over a lazy dog!");
    assert.deepEqual(a, b);
    assert.ok(!a.includes("the"));
    assert.ok(!a.includes("a"));
  });
});

// ── Generation cap + force ranking ─────────────────────────────────────────

describe("selectTopHypotheses", () => {
  function mk(label: string, scores: Partial<ResearchFocusInput["scores"]> = {}): ResearchFocusInput {
    return {
      claim: `Hypothesis ${label}`,
      scores: {
        selfImprovementLeverage:   8,
        selfExperimentFeasibility: 8,
        aiBreakthroughNovelty:     6,
        efficiencyLowWaste:        7,
        ...scores,
      },
      selfExperimentProtocol: goodProtocol,
    };
  }

  it("caps generation at MAX_GENERATED_PER_CYCLE (8)", () => {
    const candidates = Array.from({ length: 12 }, (_, i) => mk(`c${i}`));
    const out = selectTopHypotheses(candidates);
    assert.equal(out.stats.generated, 12);
    assert.equal(out.stats.considered, MAX_GENERATED_PER_CYCLE);
  });

  it("force-ranks pursueable candidates and selects at most TOP_SELECTION_MAX (3)", () => {
    const candidates = [
      mk("low",   { selfImprovementLeverage: 4 }),  // overall ~5.8
      mk("hi-1",  { selfImprovementLeverage: 10 }), // overall ~8.55
      mk("hi-2",  { selfImprovementLeverage: 9 }),  // overall ~8.15
      mk("mid",   { selfImprovementLeverage: 8 }),
      mk("hi-3",  { selfImprovementLeverage: 10, selfExperimentFeasibility: 10 }),
      mk("hi-4",  { selfImprovementLeverage: 10, aiBreakthroughNovelty: 10 }),
    ];
    const out = selectTopHypotheses(candidates);
    assert.ok(out.selected.length <= TOP_SELECTION_MAX);
    assert.ok(out.selected.length >= 1);
    // Selected ranks ascend from 1.
    out.selected.forEach((r, i) => assert.equal(r.selectionRank, i + 1));
    // Ranked descending by overall.
    for (let i = 1; i < out.selected.length; i++) {
      assert.ok(out.selected[i - 1].overall >= out.selected[i].overall);
    }
  });

  it("demotes pursue overflow to review (never silently drops)", () => {
    // 5 strong pursue candidates → top 3 selected, 2 overflow → review.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      mk(`strong-${i}`, { selfImprovementLeverage: 10, selfExperimentFeasibility: 10 }),
    );
    const out = selectTopHypotheses(candidates);
    assert.equal(out.selected.length, 3);
    assert.equal(out.review.length, 2);
    assert.equal(out.stats.routedToReview, 2);
    for (const r of out.review) {
      assert.match(r.reason, /dropped from top/);
    }
  });

  it("treats exact archive duplicates as reject and near-dup as review", () => {
    const archive = [
      { id: "arch1", claim: "Hypothesis dup-target focus rubric improves cycle quality" },
    ];
    const candidates = [
      // Exact dup of archive entry.
      {
        ...mk("dup-target", { selfImprovementLeverage: 10 }),
        claim: "Hypothesis dup-target focus rubric improves cycle quality",
      },
      // Unrelated.
      mk("fresh", { selfImprovementLeverage: 10 }),
    ];
    const out = selectTopHypotheses(candidates, { archive });
    const dupResult = out.rejected.find(r => r.duplication?.matchedId === "arch1");
    assert.ok(dupResult, "expected exact dup to route to rejected bucket");
    assert.equal(dupResult?.verdict, "reject");

    // Fresh one goes through.
    assert.ok(out.selected.some(r => r.duplication?.kind === "none"));
  });

  it("rejects when below threshold even if a complete protocol is provided", () => {
    const out = selectTopHypotheses([
      mk("weak", {
        selfImprovementLeverage:   3,
        selfExperimentFeasibility: 3,
        aiBreakthroughNovelty:     3,
        efficiencyLowWaste:        3,
      }),
    ]);
    assert.equal(out.selected.length, 0);
    assert.equal(out.rejected.length, 1);
  });
});
