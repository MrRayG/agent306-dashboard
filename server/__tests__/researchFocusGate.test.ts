/**
 * Tests for the live wiring of the Research Focus Rubric (PR #286).
 *
 * Spec invariants this file pins:
 *   1. evaluateHypothesisForFocus blocks/reviews sub-threshold or
 *      missing-protocol candidates (never silently 'pursue').
 *   2. Missing-scores route to verdict='review' with an explicit reason
 *      (never silent drop).
 *   3. The cycle accumulator tracks every evaluation; cap-exceeded is
 *      demoted to 'review' rather than dropped.
 *   4. Batch evaluation honors MAX_GENERATED_PER_CYCLE and TOP_SELECTION_MAX
 *      via selectTopHypotheses.
 *   5. summarizeCycleEvaluations produces accurate pass/completion stats.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Force a temp DATA_DIR before importing the modules so the archive does not
// leak between tests / repositories.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "focus-gate-test-"));
process.env.DATA_DIR = TMP;

const {
  startResearchCycle,
  endResearchCycle,
  evaluateHypothesisForFocus,
  evaluateHypothesisBatch,
  summarizeCycleEvaluations,
  _resetCycleAccumulatorForTests,
} = await import("../researchFocusGate.ts");
const { MAX_GENERATED_PER_CYCLE } = await import("../researchFocusRubric.ts");

const goodProtocol = {
  metric: "% hypotheses scoring >= 7.5 on the focus rubric per cycle",
  design: "Run two consecutive research cycles A vs B and compare pursue counts.",
  successThreshold: "B yields >= 50% fewer hypotheses below 7.5",
  rollbackCondition: "If pursue count drops below 1 per cycle for 3 cycles, revert.",
};

const goodScores = {
  selfImprovementLeverage:   9,
  selfExperimentFeasibility: 8,
  aiBreakthroughNovelty:     6,
  efficiencyLowWaste:        7,
};

describe("evaluateHypothesisForFocus", () => {
  before(() => { _resetCycleAccumulatorForTests(); });
  beforeEach(() => {
    _resetCycleAccumulatorForTests();
    startResearchCycle(`test_${Date.now()}_${Math.random()}`);
  });

  it("verdict='pursue' when scores pass threshold AND protocol is complete", () => {
    const r = evaluateHypothesisForFocus({
      claim: "A test hypothesis that should clearly pursue",
      scores: goodScores,
      selfExperimentProtocol: goodProtocol,
    });
    assert.equal(r.verdict, "pursue");
    assert.ok((r.overall ?? 0) >= 7.5);
    assert.ok(r.selfExperimentProtocol);
  });

  it("verdict='review' when above threshold but protocol is missing (CRITICAL invariant)", () => {
    const r = evaluateHypothesisForFocus({
      claim: "Strong hypothesis but no protocol attached",
      scores: goodScores,
      selfExperimentProtocol: undefined,
    });
    assert.equal(r.verdict, "review");
    assert.match(r.reason, /selfExperimentProtocol|protocol/);
  });

  it("verdict='reject' when overall < threshold even with complete protocol", () => {
    const r = evaluateHypothesisForFocus({
      claim: "Weak hypothesis with all axes low",
      scores: { selfImprovementLeverage: 3, selfExperimentFeasibility: 3, aiBreakthroughNovelty: 3, efficiencyLowWaste: 3 },
      selfExperimentProtocol: goodProtocol,
    });
    assert.equal(r.verdict, "reject");
    assert.match(r.reason, /threshold/);
  });

  it("verdict='review' with reason='missing_rubric_scores' when generator omits axes (never silent)", () => {
    const r = evaluateHypothesisForFocus({
      claim: "Hypothesis that came from a generator without scoring",
      scores: undefined,
      selfExperimentProtocol: goodProtocol,
    });
    assert.equal(r.verdict, "review");
    assert.match(r.reason, /missing_rubric_scores/);
    assert.equal(r.overall, null);
  });

  it("cap-exceeded demotes the (cap+1)th candidate to 'review' (never silently dropped)", () => {
    _resetCycleAccumulatorForTests();
    startResearchCycle("cap_test");
    const cap = 3;
    const results: string[] = [];
    for (let i = 0; i < cap + 2; i++) {
      const r = evaluateHypothesisForFocus({
        claim: `Hypothesis ${i} unique-${i}`,
        scores: goodScores,
        selfExperimentProtocol: goodProtocol,
      }, { cap });
      results.push(`${r.verdict}|${r.capExceeded}`);
    }
    // First `cap` results pass; the rest are capped → 'review' with capExceeded=true.
    assert.equal(results.slice(0, cap).every(s => s.startsWith("pursue|false")), true);
    assert.equal(results.slice(cap).every(s => s.startsWith("review|true")), true);
  });

  it("cycle accumulator records every evaluation including missing-scores routes", () => {
    _resetCycleAccumulatorForTests();
    startResearchCycle("acc_test");

    evaluateHypothesisForFocus({ claim: "good one alpha alpha alpha", scores: goodScores, selfExperimentProtocol: goodProtocol });
    evaluateHypothesisForFocus({ claim: "no scores beta beta beta", scores: undefined });
    evaluateHypothesisForFocus({ claim: "weak gamma gamma gamma",
      scores: { selfImprovementLeverage: 2, selfExperimentFeasibility: 2, aiBreakthroughNovelty: 2, efficiencyLowWaste: 2 },
      selfExperimentProtocol: goodProtocol,
    });

    const ended = endResearchCycle();
    assert.ok(ended);
    assert.equal(ended!.records.length, 3);
    const stats = summarizeCycleEvaluations(ended!.records);
    assert.equal(stats.total, 3);
    assert.equal(stats.pursued, 1);
    assert.equal(stats.missingScores, 1);
    assert.equal(stats.rejected, 1);
    assert.ok(stats.passRate > 0);
    assert.ok(stats.passRate < 1);
  });
});

describe("evaluateHypothesisBatch", () => {
  beforeEach(() => {
    _resetCycleAccumulatorForTests();
    startResearchCycle(`batch_${Date.now()}_${Math.random()}`);
  });

  it("honors MAX_GENERATED_PER_CYCLE and selects at most TOP_SELECTION_MAX", () => {
    const candidates = Array.from({ length: MAX_GENERATED_PER_CYCLE + 4 }, (_, i) => ({
      claim: `Strong hypothesis variant ${i}-uniquequalified-token`,
      scores: { ...goodScores, selfImprovementLeverage: 10 - (i % 4) },
      selfExperimentProtocol: goodProtocol,
    }));
    const out = evaluateHypothesisBatch(candidates);
    assert.equal(out.stats.generated, candidates.length);
    assert.equal(out.stats.considered, MAX_GENERATED_PER_CYCLE);
    assert.ok(out.selected.length <= 3);
    assert.ok(out.selected.length >= 1);
    assert.ok(out.stats.routedToReview >= 0);
  });

  it("missing-scores entries are recorded but never selected", () => {
    const out = evaluateHypothesisBatch([
      { claim: "good batch alpha", scores: goodScores, selfExperimentProtocol: goodProtocol },
      { claim: "missing scores batch beta" }, // no scores
    ]);
    assert.equal(out.selected.length, 1);
    const records = endResearchCycle()!.records;
    assert.equal(records.length, 2);
    const missing = records.find(r => r.reason.startsWith("missing_rubric_scores"));
    assert.ok(missing);
    assert.equal(missing!.verdict, "review");
  });
});
