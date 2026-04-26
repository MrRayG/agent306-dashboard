/**
 * Calibration — normalizeConfidence pure-helper tests.
 *
 * Pins the precedence documented in docs/CALIBRATED_CONFIDENCE.md §4.4:
 *   evaluationResult.confidence (0..1)  >  trustScore (0..100)
 *                                       >  categorical high/med/low  >  default
 *
 * Run: npx tsx --test server/__tests__/calibrationNormalize.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfidence } from "../calibration/normalizeConfidence.js";

describe("normalizeConfidence — precedence and fallbacks", () => {
  it("uses evaluationResult.confidence when present and in 0..1", () => {
    const r = normalizeConfidence({
      evaluationResult: { confidence: 0.73 },
      trustScore: 91,
      confidence: "high",
    });
    assert.equal(r.predictedConfidence, 0.73);
    assert.equal(r.predictedTrustScore, 91);
    assert.equal(r.source, "evaluationResult");
  });

  it("falls through to trustScore when evaluationResult.confidence is missing", () => {
    const r = normalizeConfidence({ trustScore: 80, confidence: "low" });
    assert.equal(r.predictedConfidence, 0.8);
    assert.equal(r.predictedTrustScore, 80);
    assert.equal(r.source, "trustScore");
  });

  it("falls through to categorical 'high' → 0.85 when no numeric signal exists", () => {
    const r = normalizeConfidence({ confidence: "high" });
    assert.equal(r.predictedConfidence, 0.85);
    assert.equal(r.predictedTrustScore, null);
    assert.equal(r.source, "categorical");
  });

  it("falls through to categorical 'medium' → 0.6", () => {
    const r = normalizeConfidence({ confidence: "medium" });
    assert.equal(r.predictedConfidence, 0.6);
    assert.equal(r.source, "categorical");
  });

  it("falls through to categorical 'low' → 0.3", () => {
    const r = normalizeConfidence({ confidence: "low" });
    assert.equal(r.predictedConfidence, 0.3);
    assert.equal(r.source, "categorical");
  });

  it("returns default 0.5 when no confidence signal of any kind exists", () => {
    const r = normalizeConfidence({});
    assert.equal(r.predictedConfidence, 0.5);
    assert.equal(r.predictedTrustScore, null);
    assert.equal(r.source, "default");
  });
});

describe("normalizeConfidence — robustness against bad inputs", () => {
  it("rejects out-of-range evaluationResult.confidence and falls through to trustScore", () => {
    const r = normalizeConfidence({
      evaluationResult: { confidence: 1.5 }, // out of [0,1]
      trustScore: 70,
    });
    assert.equal(r.predictedConfidence, 0.7);
    assert.equal(r.source, "trustScore");
  });

  it("clamps trustScore to [0, 1] when normalized", () => {
    const r = normalizeConfidence({ trustScore: 150 });
    assert.equal(r.predictedConfidence, 1);
    assert.equal(r.predictedTrustScore, 150, "trustScore mirror is the raw value");
    assert.equal(r.source, "trustScore");
  });

  it("treats NaN trustScore as missing and falls through", () => {
    const r = normalizeConfidence({ trustScore: NaN, confidence: "medium" });
    assert.equal(r.predictedConfidence, 0.6);
    assert.equal(r.predictedTrustScore, null);
    assert.equal(r.source, "categorical");
  });
});
