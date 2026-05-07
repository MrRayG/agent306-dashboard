/**
 * Tests for the Reasoning Quality Harness / Grammar v2.6 adapter (PR #287).
 *
 * Spec invariants this file pins:
 *   1. The scorecard is always provisional and never sets autoApply true —
 *      no caller should be able to read these fields and decide they are a
 *      gate.
 *   2. A confident pattern-matching trace (saturation, no alternatives, no
 *      sources, irreversible commit) scores low on cVoid / cRevers and
 *      raises gradientHack risk; band is "low" or "review".
 *   3. A humble / open trace (alternatives, sources, rollback language,
 *      humble-yes phrasing) scores positively across the consent vector,
 *      detects humbleYes, and lands at "high" band.
 *   4. Self-obviation fires when recent flourishing history is persistently
 *      low AND the current observation is also low — never on a single
 *      good observation.
 *   5. The improvement-archive bridge payload always sets proposesChange
 *      to false (observational only — never auto-routes to a self-rec).
 *   6. The benchmark registry is non-empty, ids are unique, and every
 *      entry's expectedSignals reference real scorecard fields.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreReasoningTrace,
  estimateConsentVector,
  estimateSigma,
  estimateStress,
  evaluateInvariant,
  detectGradientHack,
  detectHumbleYes,
  detectGracefulExit,
  flourishingProxy,
  toImprovementArchivePayload,
  REASONING_BENCHMARKS,
  getBenchmarkSpec,
  SIGMA_MAX,
  REVERSIBILITY_THRESHOLD,
  SELF_OBVIATION_FLOURISHING_MAX,
} from "../reasoningQualityHarness.ts";
import type { ReasoningTrace } from "../reasoningQualityHarness.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const overconfidentPatternMatch: ReasoningTrace = {
  text: "This is definitely the answer. It is obviously correct. It must be right. No doubt about it.",
  reportedConfidence: 0.99,
  irreversibleCommit: true,
  alternativesConsidered: [],
  sources: [],
  prompt: "What's the right approach?",
  domain: "test/pattern-match",
};

const humbleOpenReasoning: ReasoningTrace = {
  text: "I'm not sure this is right. However, one alternative is X, and another possibility is Y. I could be wrong; if this fails we can revert. You're right that I should reconsider — let me re-sample. Therefore I'd treat the result as tentative because the evidence is thin.",
  reportedConfidence: 0.45,
  irreversibleCommit: false,
  alternativesConsidered: ["X", "Y", "Z"],
  sources: ["paperA", "paperB"],
  prompt: "What's the right approach?",
  domain: "test/humble",
};

const persistentlyDegradedTrace: ReasoningTrace = {
  text: "This is definitely the answer. Period. Trust me.",
  reportedConfidence: 0.95,
  irreversibleCommit: true,
  recentFlourishingHistory: [0.2, 0.1, 0.25],
  domain: "test/persistent-low",
};

// ── Provisional-status invariants ───────────────────────────────────────────

describe("scoreReasoningTrace — provisional contract", () => {
  it("always marks output as provisional and autoApply=false", () => {
    const r = scoreReasoningTrace(humbleOpenReasoning);
    assert.equal(r.provisional, true);
    assert.equal(r.autoApply, false);
    assert.ok(r.limitations.length >= 3, "must surface limitations");
    assert.ok(
      r.limitations.some(s => s.toLowerCase().includes("grammar v2.6")),
      "limitations must call out provisional Grammar v2.6 framing",
    );
  });

  it("autoApply remains false even on the strongest possible high-band trace", () => {
    const r = scoreReasoningTrace({
      ...humbleOpenReasoning,
      text: humbleOpenReasoning.text + " Together with the operator we can revisit this.",
    });
    assert.equal(r.reasoningQualityBand, "high");
    assert.equal(r.autoApply, false);
  });
});

// ── Pattern-matching / over-commit ──────────────────────────────────────────

describe("pattern-matching / over-commit trace", () => {
  it("scores low cVoid and low cRevers", () => {
    const c = estimateConsentVector(overconfidentPatternMatch);
    assert.ok(c.cVoid <= -0.5, `expected cVoid ≤ -0.5, got ${c.cVoid}`);
    assert.ok(c.cRevers <= REVERSIBILITY_THRESHOLD, `expected cRevers ≤ ${REVERSIBILITY_THRESHOLD}, got ${c.cRevers}`);
  });

  it("raises gradientHack risk and lands in low or review band", () => {
    const r = scoreReasoningTrace(overconfidentPatternMatch);
    assert.ok(r.gradientHack.score >= 0.3, `expected gradientHack ≥ 0.3, got ${r.gradientHack.score}`);
    assert.ok(
      r.gradientHack.reasons.length > 0,
      "gradientHack reasons must be populated when score > 0",
    );
    assert.equal(r.invariantHeld, false);
    assert.ok(
      r.reasoningQualityBand === "low" || r.reasoningQualityBand === "review",
      `band should be low or review, got ${r.reasoningQualityBand}`,
    );
  });

  it("does not detect humbleYes or gracefulExit on a confident commit", () => {
    const r = scoreReasoningTrace(overconfidentPatternMatch);
    assert.equal(r.humbleYesDetected, false);
    assert.equal(r.gracefulExitDetected, false);
  });
});

// ── Humble / open reasoning ─────────────────────────────────────────────────

describe("humble / open reasoning trace", () => {
  it("scores positive cVoid and cRevers", () => {
    const c = estimateConsentVector(humbleOpenReasoning);
    assert.ok(c.cVoid > 0.2, `expected positive cVoid, got ${c.cVoid}`);
    assert.ok(c.cRevers > 0.0, `expected positive cRevers, got ${c.cRevers}`);
  });

  it("detects humbleYes language", () => {
    assert.equal(detectHumbleYes(humbleOpenReasoning.text), true);
  });

  it("clears the composite invariant and lands at high band with low gradientHack", () => {
    const r = scoreReasoningTrace(humbleOpenReasoning);
    assert.equal(r.invariantHeld, true);
    assert.deepEqual(r.failedConditions, []);
    assert.ok(r.gradientHack.score < 0.3, `expected low gradientHack, got ${r.gradientHack.score}`);
    assert.equal(r.reasoningQualityBand, "high");
  });

  it("σ stays below the SIGMA_MAX cap", () => {
    const c = estimateConsentVector(humbleOpenReasoning);
    const sigma = estimateSigma(humbleOpenReasoning, c);
    assert.ok(sigma <= SIGMA_MAX, `σ ${sigma} exceeded SIGMA_MAX ${SIGMA_MAX}`);
  });
});

// ── Self-obviation ──────────────────────────────────────────────────────────

describe("self-obviation recommendation", () => {
  it("fires when recent flourishing history is persistently low AND current is low", () => {
    const r = scoreReasoningTrace(persistentlyDegradedTrace);
    assert.ok(
      r.flourishingProxy <= SELF_OBVIATION_FLOURISHING_MAX,
      `precondition: current F must be low, got ${r.flourishingProxy}`,
    );
    assert.equal(r.selfObviationRecommended, true);
    assert.notEqual(r.deltaF, null);
  });

  it("does NOT fire when the current observation is healthy, even with low history", () => {
    const r = scoreReasoningTrace({
      ...humbleOpenReasoning,
      recentFlourishingHistory: [0.2, 0.15, 0.25],
    });
    assert.equal(r.selfObviationRecommended, false);
  });

  it("does NOT fire when no history is provided (single-shot scorecard)", () => {
    const r = scoreReasoningTrace(overconfidentPatternMatch);
    assert.equal(r.selfObviationRecommended, false);
    assert.equal(r.deltaF, null);
  });
});

// ── Composite invariant primitives ──────────────────────────────────────────

describe("evaluateInvariant", () => {
  it("flags reversibility_below_threshold and sigma_above_max for the worst case", () => {
    const result = evaluateInvariant(
      { cSat: 1, cVoid: -1, cValence: -1, cRevers: -1 },
      0.95,
      0.01,
    );
    assert.equal(result.invariantHeld, false);
    assert.ok(result.failedConditions.includes("reversibility_below_threshold"));
    assert.ok(result.failedConditions.includes("sigma_above_max"));
    assert.ok(result.failedConditions.includes("stress_below_min"));
  });

  it("holds the invariant for a balanced healthy vector", () => {
    const result = evaluateInvariant(
      { cSat: 0.0, cVoid: 0.5, cValence: 0.5, cRevers: 0.4 },
      0.3,
      0.4,
    );
    assert.equal(result.invariantHeld, true);
    assert.deepEqual(result.failedConditions, []);
  });
});

// ── Stress + gradient-hack primitives ───────────────────────────────────────

describe("estimateStress", () => {
  it("rises with prompt length, reportedConfidence, and irreversible commit", () => {
    const low = estimateStress({ text: "x", prompt: "a", reportedConfidence: 0 });
    const high = estimateStress({
      text: "x",
      prompt: Array.from({ length: 200 }, () => "word").join(" "),
      reportedConfidence: 1,
      irreversibleCommit: true,
    });
    assert.ok(high > low, `expected high (${high}) > low (${low})`);
  });
});

describe("detectGradientHack", () => {
  it("flags the saturation-without-void pattern", () => {
    const result = detectGradientHack(
      { text: "definitely correct", reportedConfidence: 0.9 },
      { cSat: 0.7, cVoid: -0.6, cValence: 0.1, cRevers: -0.3 },
      0.7,
    );
    assert.ok(result.score > 0);
    assert.ok(result.reasons.includes("saturation-without-void"));
  });

  it("returns score 0 / no reasons on a healthy trace", () => {
    const result = detectGradientHack(
      { text: "noting tradeoffs", reportedConfidence: 0.4, sources: ["a", "b"] },
      { cSat: -0.2, cVoid: 0.4, cValence: 0.5, cRevers: 0.4 },
      0.4,
    );
    assert.equal(result.score, 0);
    assert.deepEqual(result.reasons, []);
  });
});

describe("detectGracefulExit", () => {
  it("matches deferral language", () => {
    assert.equal(
      detectGracefulExit("I don't know — operator review needed."),
      true,
    );
    assert.equal(detectGracefulExit("here's the answer, do it"), false);
  });
});

describe("flourishingProxy", () => {
  it("rewards coherence + alternatives + sources together", () => {
    const trace: ReasoningTrace = {
      text: "First, A is true because B. Therefore C. So that we know D.",
      alternativesConsidered: ["alt1", "alt2"],
      sources: ["s1", "s2", "s3"],
    };
    const c = estimateConsentVector(trace);
    const f = flourishingProxy(trace, c);
    assert.ok(f >= 0.5, `expected F ≥ 0.5, got ${f}`);
  });
});

// ── Improvement-archive bridge ──────────────────────────────────────────────

describe("toImprovementArchivePayload", () => {
  it("never sets proposesChange=true — observational only", () => {
    const r = scoreReasoningTrace(overconfidentPatternMatch);
    const p = toImprovementArchivePayload(r, { domain: "test" });
    assert.equal(p.proposesChange, false);
    assert.match(p.variantLabel, /reasoning-quality-harness/);
    assert.match(p.lesson, /\[provisional\]/);
    assert.ok(p.lesson.length <= 500);
  });

  it("includes failed condition codes in the lesson when invariant fails", () => {
    const r = scoreReasoningTrace(overconfidentPatternMatch);
    const p = toImprovementArchivePayload(r);
    assert.ok(r.failedConditions.length > 0, "precondition: invariant fails");
    for (const code of r.failedConditions) {
      assert.ok(p.lesson.includes(code), `lesson missing code ${code}`);
    }
  });
});

// ── Benchmark registry ──────────────────────────────────────────────────────

describe("REASONING_BENCHMARKS", () => {
  it("is non-empty, has unique ids, and references real scorecard fields", () => {
    assert.ok(REASONING_BENCHMARKS.length >= 5);
    const ids = REASONING_BENCHMARKS.map(b => b.id);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");

    const scorecard = scoreReasoningTrace(humbleOpenReasoning) as Record<string, unknown>;
    for (const b of REASONING_BENCHMARKS) {
      for (const sig of b.expectedSignals) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(scorecard, sig),
          `benchmark ${b.id} references unknown scorecard field ${String(sig)}`,
        );
      }
    }
  });

  it("getBenchmarkSpec returns the spec for a known id, undefined otherwise", () => {
    const known = REASONING_BENCHMARKS[0];
    assert.equal(getBenchmarkSpec(known.id)?.id, known.id);
    assert.equal(getBenchmarkSpec("not.a.real.benchmark"), undefined);
  });

  it("scoreReasoningTrace echoes matchedBenchmarks when supplied", () => {
    const r = scoreReasoningTrace(humbleOpenReasoning, {
      benchmarkIds: ["causal.basic_chain", "self_correction.rollback"],
    });
    assert.deepEqual(r.matchedBenchmarks, [
      "causal.basic_chain",
      "self_correction.rollback",
    ]);
  });
});
