/**
 * Tests for Phase 2g hypothesis risk + impact scoring.
 *
 * Spec invariants this file pins:
 *   1. Same input → same output (deterministic), modulo `scoredAt`.
 *   2. Safe sandbox-fixture summarizationTemplate-shaped candidate is the
 *      affirmative low-risk/eligible path.
 *   3. Public-action / scheduler / mutation / promotion shapes are blocked.
 *   4. Memory-origin entries are blocked with a stable code.
 *   5. Unknown / unclassifiable inputs are blocked, never silently allowed.
 *   6. A formal hypothesis whose hygiene gate refused is `blocked` with
 *      readiness reason codes.
 *   7. A hygiene-archived / hygiene-blocked tag is `blocked`.
 *   8. The aggregate summarizer counts decisions, risk, impact, readiness,
 *      and reason codes.
 *   9. Calling the scorer mutates nothing — verified by cloning the input
 *      and comparing it before/after.
 *
 * Run: npx tsx --test server/__tests__/hypothesisRiskImpactScoring.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scoreHypothesisRiskImpact,
  scoreHypothesisRiskImpactBatch,
  summarizeRiskImpactScores,
  type ScoreInput,
  type CandidateInput,
  type FormalHypothesisInput,
  type MemoryHypothesisInput,
} from "../experiments/hypothesisRiskImpactScoring.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

const FIXED_NOW = new Date("2026-05-09T00:00:00Z");

function mkHyp(overrides: Partial<HygieneAwareHypothesis> = {}): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:              "hyp_test",
    claim:           "GPT-class models will improve on HumanEval by 5pp in 2026",
    basis:           "trend extrapolation from 2024-2025 leaderboard",
    metric:          "humaneval pass@1",
    prediction:      "≥5 percentage point gain by Dec 2026",
    timeframe:       "Dec 2026",
    status:          "testing",
    confidence:      "medium",
    formedAt:        new Date().toISOString(),
    measurementPath: "openalex + papers with code humaneval leaderboard",
  };
  return { ...base, ...overrides };
}

function mkSandboxCandidate(over: Partial<CandidateInput> = {}): CandidateInput {
  const base: CandidateInput = {
    origin: "candidate",
    id:     "cand_low_1",
    label:  "summarizationTemplate",
    shape: {
      sandboxFixtureOnly: true,
      lowRiskSandboxKind: true,
      learningRead:       true,
      publicAction:       false,
      schedulerDriven:    false,
      mutates:            false,
      autoPromote:        false,
    },
  };
  return { ...base, ...over, shape: { ...base.shape, ...(over.shape ?? {}) } };
}

describe("scoreHypothesisRiskImpact — determinism", () => {
  it("same input → same risk/impact/readiness/decision/reasonCodes", () => {
    const input: ScoreInput = mkSandboxCandidate();
    const a = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    const b = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(a.risk, b.risk);
    assert.equal(a.impact, b.impact);
    assert.equal(a.readiness, b.readiness);
    assert.equal(a.decision, b.decision);
    assert.deepEqual(a.reasonCodes, b.reasonCodes);
    assert.equal(a.scoredAt, b.scoredAt);
  });

  it("does not mutate its input", () => {
    const input = mkSandboxCandidate();
    const snapshot = JSON.parse(JSON.stringify(input));
    scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
  });
});

describe("scoreHypothesisRiskImpact — formal hypotheses", () => {
  it("hygiene-cleared formal hypothesis with metric → eligible / low risk / moderate impact", () => {
    const hyp = mkHyp({ hygieneTag: "ready_for_experiment" });
    const input: FormalHypothesisInput = { origin: "research_lab.hypotheses", hypothesis: hyp };
    const score = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(score.decision, "eligible");
    assert.equal(score.risk, "low");
    assert.equal(score.impact, "moderate");
    assert.equal(score.readiness, "ready");
    assert.ok(score.reasonCodes.includes("readiness_complete_metric_present"));
    assert.equal(score.origin, "research_lab.hypotheses");
  });

  it("hypothesis missing measurementPath → blocked (readiness blockers present)", () => {
    const hyp = mkHyp({ measurementPath: undefined });
    const input: FormalHypothesisInput = { origin: "research_lab.hypotheses", hypothesis: hyp };
    const score = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.equal(score.readiness, "blocked");
    assert.ok(
      score.reasonCodes.includes("readiness_blockers_present") ||
      score.reasonCodes.includes("readiness_partial"),
    );
  });

  it("archived hygiene tag → blocked with hygiene_archived_or_blocked code", () => {
    const hyp = mkHyp({ hygieneTag: "archived_irrelevant" });
    const input: FormalHypothesisInput = { origin: "research_lab.hypotheses", hypothesis: hyp };
    const score = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.equal(score.risk, "unclassifiable");
    assert.ok(score.reasonCodes.includes("hygiene_archived_or_blocked"));
  });

  it("hygiene-blocked tag → blocked with hygiene_archived_or_blocked code", () => {
    const hyp = mkHyp({ hygieneTag: "blocked" });
    const input: FormalHypothesisInput = { origin: "research_lab.hypotheses", hypothesis: hyp };
    const score = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("hygiene_archived_or_blocked"));
  });
});

describe("scoreHypothesisRiskImpact — memory-origin entries", () => {
  it("memory entry → blocked with memory_origin_blocked code", () => {
    const input: MemoryHypothesisInput = {
      origin: "memory_knowledge",
      id:     "mem_1",
      title:  "Hypothesis: enterprises will adopt X",
    };
    const score = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.equal(score.risk, "unclassifiable");
    assert.equal(score.readiness, "blocked");
    assert.equal(score.refId, "memory:mem_1");
    assert.ok(score.reasonCodes.includes("memory_origin_blocked"));
  });

  it("memory entry with promotion target → still blocked (must score the formal record)", () => {
    const input: MemoryHypothesisInput = {
      origin: "memory_knowledge",
      id:     "mem_2",
      title:  "Hypothesis: foo",
      promotedToHypothesisId: "hyp_promoted_1",
    };
    const score = scoreHypothesisRiskImpact(input, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("memory_origin_blocked"));
  });
});

describe("scoreHypothesisRiskImpact — sandbox candidates (affirmative path)", () => {
  it("summarizationTemplate sandbox-fixture-only candidate → eligible / low risk", () => {
    const score = scoreHypothesisRiskImpact(mkSandboxCandidate(), { now: FIXED_NOW });
    assert.equal(score.decision, "eligible");
    assert.equal(score.risk, "low");
    assert.equal(score.readiness, "ready");
    assert.ok(score.reasonCodes.includes("low_risk_sandbox_fixture_shape"));
    assert.ok(score.reasonCodes.includes("summarization_template_kind"));
  });

  it("learningRead summarizationTemplate → impact: high", () => {
    const score = scoreHypothesisRiskImpact(mkSandboxCandidate({ shape: { learningRead: true } }), { now: FIXED_NOW });
    assert.equal(score.impact, "high");
  });

  it("non-learning summarizationTemplate → impact: moderate (still eligible)", () => {
    const cand = mkSandboxCandidate();
    cand.shape = { ...cand.shape, learningRead: false };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.impact, "moderate");
    assert.equal(score.decision, "eligible");
  });

  it("sandbox-fixture-only but NOT a known enabled kind → needs_review (not eligible)", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_unknown_kind",
      label:  "reasoningTemplate", // disabled in Phase 2e-b registry
      shape: { sandboxFixtureOnly: true, lowRiskSandboxKind: true, learningRead: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "needs_review");
    assert.notEqual(score.risk, "low");
  });
});

describe("scoreHypothesisRiskImpact — refusal paths", () => {
  it("publicAction shape hint → blocked / public_action_blocked", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_public_1",
      label:  "summarizationTemplate", // even with a safe label, hint blocks
      shape:  { publicAction: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.equal(score.risk, "high");
    assert.ok(score.reasonCodes.includes("public_action_blocked"));
  });

  it("publicAction-named label without explicit hint → still blocked", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_xpost",
      label:  "publishXPost",
      shape:  { sandboxFixtureOnly: true, lowRiskSandboxKind: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("public_action_blocked"));
  });

  it("schedulerDriven shape → blocked / scheduler_blocked", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_sched",
      label:  "summarizationTemplate",
      shape:  { schedulerDriven: true, sandboxFixtureOnly: true, lowRiskSandboxKind: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("scheduler_blocked"));
  });

  it("scheduler-named label → blocked", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_cron",
      label:  "dailyCycleAutomation",
      shape:  { sandboxFixtureOnly: true, lowRiskSandboxKind: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("scheduler_blocked"));
  });

  it("mutates shape → blocked / mutation_blocked", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_mutate",
      label:  "summarizationTemplate",
      shape:  { mutates: true, sandboxFixtureOnly: true, lowRiskSandboxKind: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("mutation_blocked"));
  });

  it("autoPromote shape → blocked / promotion_blocked", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_promote",
      label:  "summarizationTemplate",
      shape:  { autoPromote: true, sandboxFixtureOnly: true, lowRiskSandboxKind: true },
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("promotion_blocked"));
  });

  it("unknown / shapeless candidate → blocked / unknown_or_unclassifiable", () => {
    const cand: CandidateInput = {
      origin: "candidate",
      id:     "cand_mystery",
      label:  "mystery",
    };
    const score = scoreHypothesisRiskImpact(cand, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.equal(score.risk, "unclassifiable");
    assert.ok(score.reasonCodes.includes("unknown_or_unclassifiable"));
  });

  it("invalid input (missing origin) → blocked / unknown_or_unclassifiable", () => {
    // @ts-expect-error — intentional bad input.
    const score = scoreHypothesisRiskImpact({}, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.equal(score.origin, "unknown");
    assert.ok(score.reasonCodes.includes("unknown_or_unclassifiable"));
  });

  it("unknown origin discriminator → blocked", () => {
    // @ts-expect-error — intentional bad input.
    const score = scoreHypothesisRiskImpact({ origin: "totally_made_up" }, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("unknown_or_unclassifiable"));
  });

  it("null input → blocked", () => {
    // @ts-expect-error — intentional bad input.
    const score = scoreHypothesisRiskImpact(null, { now: FIXED_NOW });
    assert.equal(score.decision, "blocked");
    assert.ok(score.reasonCodes.includes("unknown_or_unclassifiable"));
  });
});

describe("scoreHypothesisRiskImpactBatch + summarizeRiskImpactScores", () => {
  it("batches scoring and produces an accurate summary", () => {
    const inputs: ScoreInput[] = [
      mkSandboxCandidate({ id: "ok_1" }),                                       // eligible / low
      mkSandboxCandidate({ id: "ok_2" }),                                       // eligible / low
      { origin: "memory_knowledge", id: "mem_1", title: "Hypothesis: x" },      // blocked
      { origin: "candidate", id: "pub", label: "publishXPost", shape: { publicAction: true } }, // blocked
      { origin: "candidate", id: "mystery", label: "x" },                       // blocked
      { origin: "research_lab.hypotheses", hypothesis: mkHyp() },               // eligible (candidate tag)
    ];
    const scores = scoreHypothesisRiskImpactBatch(inputs, { now: FIXED_NOW });
    assert.equal(scores.length, 6);
    const summary = summarizeRiskImpactScores(scores);
    assert.equal(summary.total, 6);
    assert.equal(summary.byDecision.eligible, 3);
    assert.equal(summary.byDecision.blocked, 3);
    assert.equal(summary.byDecision.needs_review, 0);
    assert.equal(summary.eligibleLowRisk, 3);
    assert.ok(summary.byReasonCode.public_action_blocked >= 1);
    assert.ok(summary.byReasonCode.memory_origin_blocked >= 1);
    assert.ok(summary.byReasonCode.unknown_or_unclassifiable >= 1);
  });

  it("empty batch → empty summary with zeroed counts", () => {
    const summary = summarizeRiskImpactScores([]);
    assert.equal(summary.total, 0);
    assert.equal(summary.byDecision.eligible, 0);
    assert.equal(summary.byDecision.blocked, 0);
    assert.equal(summary.eligibleLowRisk, 0);
  });

  it("non-array input → empty summary (defensive)", () => {
    // @ts-expect-error — intentional bad input.
    const summary = summarizeRiskImpactScores(null);
    assert.equal(summary.total, 0);
  });
});
