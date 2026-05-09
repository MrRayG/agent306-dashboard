/**
 * Tests for the Phase 2c experiment decision rule module.
 *
 * Run: npx tsx --test server/__tests__/hypothesisExperimentDecision.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideExperimentOutcome,
  decideExperimentOutcomes,
  getDefaultDecisionThresholds,
  type ExperimentDecisionInput,
  type ArmAggregate,
  type GuardrailOutcome,
} from "../experiments/hypothesisExperimentDecision.js";
import {
  bindCandidateMetric,
  type MetricBinding,
} from "../experiments/hypothesisMetricBinding.js";
import {
  evaluateHypothesisForExperiment,
} from "../experiments/hypothesisExperimentSelector.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function mkHyp(overrides: Partial<HygieneAwareHypothesis> = {}): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:         "hyp_phase2c_test",
    claim:      "Routine-tier JSON validity will exceed 0.95 on analysis-intake",
    basis:      "Phase 1 baseline aggregate hovers at 0.93",
    metric:     "routine_task_json_validity",
    prediction: "≥0.95 mean outcome_metric across non-probe trials by 2026-Q3",
    timeframe:  "2026-Q3",
    status:     "testing",
    confidence: "medium",
    formedAt:   new Date().toISOString(),
    measurementPath:
      "experiment_trials.outcome_metric (graded by safeParseLLMJson, isProbe=false)",
  };
  return { ...base, hygieneTag: "ready_for_experiment", ...overrides };
}

/**
 * Build a real `MetricBinding` via the Phase 2 selector + Phase 2b binder so
 * we never construct an invalid shape by hand.
 */
function mkBinding(): MetricBinding {
  const hyp = mkHyp();
  const decision = evaluateHypothesisForExperiment(hyp);
  if (!decision.ok) throw new Error("test fixture: selector refused");
  const bound = bindCandidateMetric(decision.candidate);
  if (!bound.ok) throw new Error("test fixture: binder refused");
  return bound;
}

function arm(count: number, metric: number): ArmAggregate {
  return { count, metric };
}

// Frozen `now` for deterministic timestamps.
const NOW = new Date("2026-05-09T12:00:00.000Z");

// ── Promote ──────────────────────────────────────────────────────────────────

describe("decideExperimentOutcome — promote", () => {
  it("promotes when treatment beats baseline by ≥ promote threshold and sample is met", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.96),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "promote");
    assert.equal(d.reasonCode, "primary_metric_better");
    assert.equal(d.metricKey, "routine_task_json_validity");
    assert.ok(d.evidence.some(e => e.includes("delta")));
    assert.equal(d.decidedAt, NOW.toISOString());
    assert.equal(d.candidate.origin, "research_lab.hypotheses");
  });

  it("does NOT promote when delta meets the threshold but sample is below the per-arm minimum", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(5, 0.90),
      treatment: arm(5, 0.99),
    };
    const d = decideExperimentOutcome(input, NOW);
    // 5 < 15 per-arm → continue, even though the delta would otherwise promote.
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "insufficient_sample");
  });
});

// ── Reject — primary metric worse ────────────────────────────────────────────

describe("decideExperimentOutcome — reject (primary metric worse)", () => {
  it("rejects when treatment underperforms baseline by ≥ reject threshold", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.95),
      treatment: arm(20, 0.85),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "reject");
    assert.equal(d.reasonCode, "primary_metric_worse");
    assert.ok(d.reason.includes("below baseline"));
  });
});

// ── Reject — guardrail failure ───────────────────────────────────────────────

describe("decideExperimentOutcome — reject (guardrail failure)", () => {
  it("rejects on the first failed fatal guardrail, before sample / metric rules", () => {
    const guardrails: GuardrailOutcome[] = [
      { name: "judge_outage_rate", passed: true },
      { name: "p99_latency_ms", passed: false, fatal: true, detail: "p99 = 12000ms" },
    ];
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      // Sample below threshold, metric improving — without guardrails this
      // would be `continue`. The guardrail must short-circuit.
      baseline:  arm(5, 0.90),
      treatment: arm(5, 0.99),
      guardrails,
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "reject");
    assert.equal(d.reasonCode, "guardrail_failure");
    assert.ok(d.reason.includes("p99_latency_ms"));
    assert.ok(d.evidence.some(e => e.includes("p99 = 12000ms")));
  });

  it("routes to needs_review when an advisory guardrail fails", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.96),
      guardrails: [
        { name: "model_drift_warning", passed: false, fatal: false, detail: "drift detected" },
      ],
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "needs_review");
    assert.equal(d.reasonCode, "ambiguous_guardrail");
    assert.ok(d.reason.includes("advisory"));
  });

  it("ignores passing guardrails", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.96),
      guardrails: [
        { name: "judge_outage_rate", passed: true },
        { name: "p99_latency_ms", passed: true, fatal: true },
      ],
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "promote");
  });
});

// ── Continue — insufficient sample ───────────────────────────────────────────

describe("decideExperimentOutcome — continue (insufficient sample)", () => {
  it("returns continue when total sample is below threshold", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(2, 0.50),
      treatment: arm(2, 0.50),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "insufficient_sample");
    assert.ok(d.evidence.some(e => e.includes("baseline.count: 2")));
  });

  it("returns continue when total is met but per-arm is below threshold", () => {
    const input: ExperimentDecisionInput = {
      // 25 + 5 = 30 (meets total) but treatment=5 < 15 per-arm.
      binding:  mkBinding(),
      baseline:  arm(25, 0.90),
      treatment: arm(5,  0.99),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "insufficient_sample");
  });

  it("respects threshold overrides", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(2, 0.90),
      treatment: arm(2, 0.99),
      thresholds: { minTotalSamples: 4, minPerArmSamples: 2, promoteAbsoluteDelta: 0.05 },
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "promote");
    assert.equal(d.thresholdsUsed.minTotalSamples, 4);
    assert.equal(d.thresholdsUsed.minPerArmSamples, 2);
  });
});

// ── Continue — inconclusive ──────────────────────────────────────────────────

describe("decideExperimentOutcome — continue (inconclusive)", () => {
  it("returns continue when sample is met but delta is inside the band", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.92), // +0.02 < +0.05
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "inconclusive");
    assert.ok(d.evidence.some(e => e.includes("delta")));
  });

  it("returns continue at the exact lower edge of the promote threshold", () => {
    // delta = +0.0499 → still inside the band, still continue.
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.9000),
      treatment: arm(20, 0.9499),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "inconclusive");
  });
});

// ── needs_review — missing aggregate ─────────────────────────────────────────

describe("decideExperimentOutcome — needs_review (missing aggregate)", () => {
  it("returns needs_review when the baseline aggregate is omitted", () => {
    // Caller may pass an undefined arm in TS-loose contexts (e.g. constructed
    // from a partial JSON). The decision module must not throw.
    const input = {
      binding:  mkBinding(),
      baseline:  undefined as unknown as ArmAggregate,
      treatment: arm(20, 0.96),
    } as ExperimentDecisionInput;
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "needs_review");
    assert.equal(d.reasonCode, "missing_aggregate");
    assert.ok(d.evidence.some(e => e.includes("baseline present: no")));
  });

  it("returns needs_review when the aggregate has non-finite metric (NaN)", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  { count: 20, metric: Number.NaN },
      treatment: arm(20, 0.96),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "needs_review");
    assert.equal(d.reasonCode, "invalid_aggregate");
  });

  it("returns needs_review when an arm has a negative count", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  { count: -1, metric: 0.5 },
      treatment: arm(20, 0.96),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "needs_review");
    assert.equal(d.reasonCode, "invalid_aggregate");
  });
});

// ── Reject — cost up without improvement ─────────────────────────────────────

describe("decideExperimentOutcome — reject (cost up without improvement)", () => {
  it("rejects when cost rises above the flat-cost ratio with no metric improvement", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.901), // +0.001, below the 0.005 improvement floor
      baselineCost:  { costUsd: 0.10 },
      treatmentCost: { costUsd: 0.20 }, // +100%, way above 10% flat-cost ratio
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "reject");
    assert.equal(d.reasonCode, "cost_up_without_improvement");
    assert.ok(d.evidence.some(e => e.includes("cost ratio")));
  });

  it("does NOT reject on cost when there is a meaningful metric improvement", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.96), // +0.06, well above the 0.005 floor → promote
      baselineCost:  { costUsd: 0.10 },
      treatmentCost: { costUsd: 0.30 },
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "promote");
  });

  it("skips cost rule when one side's cost is missing (does not invent data)", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.901),
      baselineCost:  { costUsd: 0.10 },
      // treatmentCost omitted on purpose
    };
    const d = decideExperimentOutcome(input, NOW);
    // Falls through to inconclusive (delta in band) rather than invented reject.
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "inconclusive");
  });

  it("skips cost rule when costs are present but invalid (negative)", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.901),
      baselineCost:  { costUsd: 0.10 },
      treatmentCost: { costUsd: -1 },
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.verdict, "continue");
    assert.equal(d.reasonCode, "inconclusive");
  });
});

// ── Composition with Phase 2b binding ────────────────────────────────────────

describe("decideExperimentOutcome — composition with Phase 2 / 2b", () => {
  it("threads candidate origin and tag through the decision record", () => {
    const input: ExperimentDecisionInput = {
      binding:  mkBinding(),
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.96),
    };
    const d = decideExperimentOutcome(input, NOW);
    assert.equal(d.candidate.origin, "research_lab.hypotheses");
    assert.equal(d.candidate.tag, "ready_for_experiment");
    assert.equal(d.candidate.hypothesisId, d.hypothesisId);
  });

  it("only the binding's metricKey reaches the decision (not the candidate's free text)", () => {
    // Even if the candidate's free-text metric is different, the binding has
    // already canonicalized it. The decision module trusts the binding.
    const hyp = mkHyp({ metric: "JSON Validity" }); // alias
    const sel = evaluateHypothesisForExperiment(hyp);
    if (!sel.ok) throw new Error("selector refused");
    const bound = bindCandidateMetric(sel.candidate);
    if (!bound.ok) throw new Error("binder refused");
    const d = decideExperimentOutcome({
      binding:  bound,
      baseline:  arm(20, 0.90),
      treatment: arm(20, 0.96),
    }, NOW);
    assert.equal(d.metricKey, "routine_task_json_validity");
  });
});

// ── Bulk + threshold view ────────────────────────────────────────────────────

describe("decideExperimentOutcomes — bulk", () => {
  it("decides each input independently and tallies verdicts", () => {
    const binding = mkBinding();
    const inputs: ExperimentDecisionInput[] = [
      { binding, baseline: arm(20, 0.90), treatment: arm(20, 0.96) }, // promote
      { binding, baseline: arm(20, 0.95), treatment: arm(20, 0.85) }, // reject
      { binding, baseline: arm(2,  0.90), treatment: arm(2,  0.91) }, // continue (insufficient)
      { binding, baseline: arm(20, 0.90), treatment: arm(20, 0.92) }, // continue (inconclusive)
      { binding, baseline: arm(20, 0.90), treatment: { count: 20, metric: Number.NaN } }, // needs_review
    ];
    const report = decideExperimentOutcomes(inputs, NOW);
    assert.equal(report.summary.inputCount, 5);
    assert.equal(report.summary.byVerdict.promote,      1);
    assert.equal(report.summary.byVerdict.reject,       1);
    assert.equal(report.summary.byVerdict.continue,     2);
    assert.equal(report.summary.byVerdict.needs_review, 1);
    assert.equal(report.generatedAt, NOW.toISOString());
  });

  it("empty input yields an empty report (not a failure)", () => {
    const report = decideExperimentOutcomes([], NOW);
    assert.equal(report.summary.inputCount, 0);
    assert.equal(report.decisions.length, 0);
  });
});

describe("getDefaultDecisionThresholds", () => {
  it("exposes the documented defaults", () => {
    const t = getDefaultDecisionThresholds();
    assert.equal(t.minTotalSamples, 30);
    assert.equal(t.minPerArmSamples, 15);
    assert.equal(t.promoteAbsoluteDelta, 0.05);
    assert.equal(t.rejectAbsoluteDelta, 0.05);
    assert.equal(t.minMetricImprovementForCost, 0.005);
    assert.equal(t.maxFlatCostRatio, 0.10);
  });

  it("returns a fresh copy each call (caller cannot mutate the canonical defaults)", () => {
    const t = getDefaultDecisionThresholds();
    t.minTotalSamples = 9999;
    const fresh = getDefaultDecisionThresholds();
    assert.equal(fresh.minTotalSamples, 30);
  });
});
