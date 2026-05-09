/**
 * Tests for the Phase 2b hypothesis → metric binding module.
 *
 * Run: npx tsx --test server/__tests__/hypothesisMetricBinding.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bindCandidateMetric,
  bindCandidates,
  bindReadinessReport,
  listRegisteredMetrics,
  PHASE2B_METRIC_REGISTRY,
} from "../experiments/hypothesisMetricBinding.js";
import {
  buildHypothesisExperimentReadinessReport,
  evaluateHypothesisForExperiment,
  type HypothesisExperimentCandidate,
} from "../experiments/hypothesisExperimentSelector.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { MemoryKnowledgeEntry } from "../memoryHypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

function mkHyp(overrides: Partial<HygieneAwareHypothesis> = {}): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:         "hyp_test",
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
  return { ...base, ...overrides };
}

function mkCandidate(overrides: Partial<HypothesisExperimentCandidate> = {}): HypothesisExperimentCandidate {
  // Use the selector to build a real candidate so we never construct an
  // invalid shape by hand.
  const hyp = mkHyp({ hygieneTag: "ready_for_experiment", ...(overrides as Partial<HygieneAwareHypothesis>) });
  const decision = evaluateHypothesisForExperiment(hyp);
  if (!decision.ok) {
    throw new Error("test fixture is invalid: selector refused");
  }
  return { ...decision.candidate, ...overrides };
}

describe("bindCandidateMetric — accept path", () => {
  it("binds a candidate whose metric matches the canonical key", () => {
    const result = bindCandidateMetric(mkCandidate());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.metricKey, "routine_task_json_validity");
      assert.equal(result.candidate.origin, "research_lab.hypotheses");
      assert.ok(result.matchedDataSources.length >= 1);
      assert.ok(
        result.matchedDataSources.some(s => s.includes("experiment_trials")),
        `expected experiment_trials match, got ${JSON.stringify(result.matchedDataSources)}`,
      );
      assert.ok(result.evidence.some(e => e.includes("bound to registered key")));
    }
  });

  it("binds via an alias (case-insensitive, normalized whitespace)", () => {
    const cand = mkCandidate({ metric: "  JSON  Validity  " });
    const result = bindCandidateMetric(cand);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.metricKey, "routine_task_json_validity");
      assert.equal(result.matchedMetricText, "json validity");
    }
  });

  it("binds when measurementPath is a substring superset of the registered data source", () => {
    const cand = mkCandidate({
      measurementPath:
        "Daily aggregation over experiment_trials.outcome_metric joined with experiments table",
    });
    const result = bindCandidateMetric(cand);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.matchedDataSources.length >= 1);
    }
  });
});

describe("bindCandidateMetric — refusal path", () => {
  it("refuses an unknown free-text metric with code=unknown_metric", () => {
    const cand = mkCandidate({ metric: "vibes per hour" });
    const result = bindCandidateMetric(cand);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unknown_metric");
      assert.equal(result.matchedRegistryEntries.length, 0);
      assert.equal(result.rawMetric, "vibes per hour");
      assert.ok(result.evidence.some(e => e.includes("registry size")));
      assert.ok(result.reason.includes("vibes per hour"));
    }
  });

  it("refuses a candidate with empty measurementPath as missing_data_source", () => {
    // Candidate must still be constructible — selector requires
    // measurementPath to be non-empty, so we construct the candidate via
    // the selector with a valid path then strip it for the binding call.
    const valid = mkCandidate();
    const cand: HypothesisExperimentCandidate = { ...valid, measurementPath: "" };
    const result = bindCandidateMetric(cand);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "missing_data_source");
      assert.equal(result.matchedRegistryEntries.length, 1);
      assert.equal(result.matchedRegistryEntries[0].metricKey, "routine_task_json_validity");
    }
  });

  it("refuses a candidate whose measurementPath does not match any registered data source", () => {
    const valid = mkCandidate();
    const cand: HypothesisExperimentCandidate = {
      ...valid,
      measurementPath: "an external Google Sheet maintained by the analyst",
    };
    const result = bindCandidateMetric(cand);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "unsupported_data_source");
      assert.equal(result.matchedRegistryEntries.length, 1);
      assert.ok(result.evidence.some(e => e.includes("expected data sources")));
    }
  });

  it("refusal echoes the candidate id and origin so the record is self-describing", () => {
    const cand = mkCandidate({ metric: "totally made up" });
    const result = bindCandidateMetric(cand);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.candidate.hypothesisId, cand.hypothesisId);
      assert.equal(result.candidate.origin, "research_lab.hypotheses");
      assert.equal(result.candidate.tag, cand.tag);
    }
  });
});

describe("bindCandidates — composes with the Phase 2 selector output", () => {
  it("binds candidates and reports refusals in one report", () => {
    const ready = mkHyp({ id: "h_ok", hygieneTag: "ready_for_experiment" });
    const unknownMetric = mkHyp({
      id: "h_bad_metric",
      metric: "engagement uplift",  // not in registry
      hygieneTag: "ready_for_experiment",
    });
    const badPath = mkHyp({
      id: "h_bad_path",
      measurementPath: "stored in our private CRM, exported nightly",
      hygieneTag: "ready_for_experiment",
    });

    const sel = buildHypothesisExperimentReadinessReport({
      formal: [ready, unknownMetric, badPath],
    });
    const report = bindCandidates(sel.candidates, new Date("2026-05-09T00:00:00Z"));

    assert.equal(report.summary.candidateCount, 3);
    assert.equal(report.summary.boundCount, 1);
    assert.equal(report.summary.refusalCount, 2);
    assert.equal(report.summary.refusalsByCode.unknown_metric, 1);
    assert.equal(report.summary.refusalsByCode.unsupported_data_source, 1);
    assert.equal(report.bindings[0].hypothesisId, "h_ok");
    assert.equal(report.generatedAt, "2026-05-09T00:00:00.000Z");
  });

  it("empty candidate list produces an empty report (not a failure)", () => {
    const report = bindCandidates([]);
    assert.equal(report.summary.candidateCount, 0);
    assert.equal(report.summary.boundCount, 0);
    assert.equal(report.summary.refusalCount, 0);
    assert.equal(report.bindings.length, 0);
    assert.equal(report.refusals.length, 0);
    for (const code of Object.keys(report.summary.refusalsByCode)) {
      assert.equal(
        report.summary.refusalsByCode[code as keyof typeof report.summary.refusalsByCode],
        0,
      );
    }
  });
});

describe("bindReadinessReport — defense-in-depth against memory-origin records", () => {
  it("memory-origin refusals never reach metric binding as candidates", () => {
    // The Phase 1.5b hard-no policy means a memory entry CANNOT appear in
    // the readiness report's `candidates[]`. Verify that even when memory
    // entries are passed alongside formal hypotheses, only the formal
    // candidates flow into binding.
    const formal = mkHyp({ id: "h_real", hygieneTag: "ready_for_experiment" });
    const memEntry: MemoryKnowledgeEntry = {
      id: "mem_seed",
      title: "Hypothesis: this should never become a candidate",
      summary: "metric=routine_task_json_validity; measurementPath=experiment_trials",
      tier: "B",
      category: "ai-news",
      weight: 0.4,
      learnedAt: new Date().toISOString(),
    };

    const sel = buildHypothesisExperimentReadinessReport({
      formal:        [formal],
      memoryEntries: [memEntry],
    });

    assert.equal(sel.summary.memoryRefusalCount, 1);
    assert.equal(sel.summary.candidateCount, 1);
    assert.equal(sel.candidates[0].origin, "research_lab.hypotheses");

    const report = bindReadinessReport(sel);
    assert.equal(report.summary.candidateCount, 1);
    assert.equal(report.summary.boundCount, 1);
    // Every binding must come from the formal path.
    for (const b of report.bindings) {
      assert.equal(b.candidate.origin, "research_lab.hypotheses");
      assert.notEqual(b.hypothesisId, "mem_seed");
    }
  });

  it("a readiness report with zero candidates produces a zero-binding report", () => {
    const broken = mkHyp({ id: "h_no", measurementPath: undefined });
    const sel = buildHypothesisExperimentReadinessReport({ formal: [broken] });
    assert.equal(sel.summary.candidateCount, 0);

    const report = bindReadinessReport(sel);
    assert.equal(report.summary.candidateCount, 0);
    assert.equal(report.summary.boundCount, 0);
    assert.equal(report.summary.refusalCount, 0);
  });
});

describe("registry shape", () => {
  it("listRegisteredMetrics returns a non-empty seed including the Phase 1 metric", () => {
    const list = listRegisteredMetrics();
    assert.ok(list.length >= 1);
    const keys = list.map(e => e.metricKey);
    assert.ok(
      keys.includes("routine_task_json_validity"),
      `expected routine_task_json_validity in ${JSON.stringify(keys)}`,
    );
    for (const e of list) {
      assert.ok(e.metricKey.length > 0);
      assert.ok(e.description.length > 0);
      assert.ok(e.dataSources.length > 0);
    }
  });

  it("registry constant matches the public view", () => {
    assert.equal(listRegisteredMetrics().length, PHASE2B_METRIC_REGISTRY.length);
  });
});
