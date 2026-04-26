/**
 * Calibration — Brier / LogLoss golden-number tests.
 *
 * Pins the formulas in docs/CALIBRATED_CONFIDENCE.md §4 against
 * hand-computed expectations. Both functions return `null` when inputs
 * fail the design's sanity floor (sample count, raw-prediction range).
 *
 * Run: npx tsx --test server/__tests__/calibrationCompute.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeBrier,
  computeLogLoss,
  MIN_SAMPLE_COUNT,
  type Sample,
} from "../calibration/computeCalibration.js";

function repeat<T>(n: number, mk: (i: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) out.push(mk(i));
  return out;
}

const N = MIN_SAMPLE_COUNT; // 20 — the floor

describe("computeBrier — golden numbers", () => {
  it("perfect prediction (all p=1, y=true) → Brier = 0", () => {
    const samples: Sample[] = repeat(N, () => ({
      predictedConfidence: 1,
      actualOutcome: true,
      outcomeWeight: 1,
    }));
    assert.equal(computeBrier(samples), 0);
  });

  it("always wrong (all p=1, y=false) → Brier = 1", () => {
    const samples: Sample[] = repeat(N, () => ({
      predictedConfidence: 1,
      actualOutcome: false,
      outcomeWeight: 1,
    }));
    assert.equal(computeBrier(samples), 1);
  });

  it("uniform 0.5 prediction → Brier = 0.25", () => {
    const samples: Sample[] = repeat(N, (i) => ({
      predictedConfidence: 0.5,
      actualOutcome: i % 2 === 0,
      outcomeWeight: 1,
    }));
    assert.equal(computeBrier(samples), 0.25);
  });

  it("mixed well-calibrated: half (0.7, true), half (0.3, false) → Brier = 0.09", () => {
    const samples: Sample[] = [
      ...repeat(N / 2, () => ({ predictedConfidence: 0.7, actualOutcome: true,  outcomeWeight: 1 })),
      ...repeat(N / 2, () => ({ predictedConfidence: 0.3, actualOutcome: false, outcomeWeight: 1 })),
    ];
    const got = computeBrier(samples)!;
    assert.ok(Math.abs(got - 0.09) < 1e-12, `expected 0.09, got ${got}`);
  });

  it("returns null when samples.length < MIN_SAMPLE_COUNT (boundary 19)", () => {
    const samples: Sample[] = repeat(N - 1, () => ({
      predictedConfidence: 0.5,
      actualOutcome: true,
      outcomeWeight: 1,
    }));
    assert.equal(computeBrier(samples), null);
  });

  it("weighted Brier respects outcomeWeight (zero-weight samples excluded)", () => {
    // 20 samples: 10 informative (p=0.8, y=true, w=1) + 10 noise (p=0.0, y=false, w=0).
    // Weighted Brier = (10·(0.8-1)²·1) / 10 = 0.04.
    const samples: Sample[] = [
      ...repeat(10, () => ({ predictedConfidence: 0.8, actualOutcome: true,  outcomeWeight: 1 })),
      ...repeat(10, () => ({ predictedConfidence: 0.0, actualOutcome: false, outcomeWeight: 0 })),
    ];
    const got = computeBrier(samples)!;
    assert.ok(Math.abs(got - 0.04) < 1e-12, `expected 0.04, got ${got}`);
  });
});

describe("computeLogLoss — golden numbers and clipping", () => {
  it("uniform 0.5 prediction → LogLoss ≈ ln(2) ≈ 0.6931", () => {
    const samples: Sample[] = repeat(N, (i) => ({
      predictedConfidence: 0.5,
      actualOutcome: i % 2 === 0,
      outcomeWeight: 1,
    }));
    const got = computeLogLoss(samples)!;
    assert.ok(Math.abs(got - Math.log(2)) < 1e-12, `expected ln(2)=${Math.log(2)}, got ${got}`);
  });

  it("returns null when samples.length < MIN_SAMPLE_COUNT (boundary 19)", () => {
    const samples: Sample[] = repeat(N - 1, () => ({
      predictedConfidence: 0.5,
      actualOutcome: true,
      outcomeWeight: 1,
    }));
    assert.equal(computeLogLoss(samples), null);
  });

  it("returns null when any raw predictedConfidence is at 1.0 (out of (ε, 1-ε))", () => {
    const samples: Sample[] = [
      { predictedConfidence: 1.0, actualOutcome: true, outcomeWeight: 1 },
      ...repeat(N - 1, () => ({ predictedConfidence: 0.6, actualOutcome: true, outcomeWeight: 1 })),
    ];
    assert.equal(computeLogLoss(samples), null);
  });
});
