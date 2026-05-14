/**
 * PR-E: correction-tracking wiring regression tests.
 *
 * Root cause being pinned: dailyCycleEngine filtered rejected hypotheses
 * with `parseFloat(h.confidence) > 0.6` where `h.confidence` is a
 * categorical label ("high" | "medium" | "low"). `parseFloat` returned
 * NaN on every row, so the recorder never fired and corrections.json
 * never grew. The Intellectual Honesty dimension's `correctionRate`
 * stayed at the neutral default (or zero, whenever there were open
 * contradictions in the denominator) regardless of activity.
 *
 * These tests pin:
 *   1. A qualifying rejected hypothesis (status=rejected, testingStartedAt,
 *      resolved within 24h, categorical confidence >= "high") now passes
 *      the filter.
 *   2. A "medium" confidence rejection — which maps to 0.6 via the
 *      categorical table — does NOT pass the `> 0.6` threshold, so the
 *      historical strictness is preserved.
 *   3. Non-qualifying rows (no testingStartedAt, stale resolvedAt, wrong
 *      status, missing resolvedAt) are filtered out.
 *   4. The legacy parseFloat bug — i.e., feeding a categorical label
 *      into a numeric comparator — would have rejected every input;
 *      this test makes that regression visible if the predicate ever
 *      reverts.
 *
 * Run: npx tsx --test server/__tests__/correctionTrackingWiring.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qualifiesForCorrection } from "../reasoningEngine.js";
import { normalizeConfidence } from "../calibration/normalizeConfidence.js";

function baseHypothesis(overrides: Partial<any> = {}): any {
  const now = Date.now();
  return {
    id: "h_test",
    claim: "test claim",
    basis: "b",
    metric: "m",
    prediction: "p",
    timeframe: "1w",
    status: "rejected",
    confidence: "high",
    formedAt: new Date(now - 10 * 86_400_000).toISOString(),
    resolvedAt: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
    testingStartedAt: new Date(now - 5 * 86_400_000).toISOString(),
    resolution: "Evidence contradicted the prediction",
    ...overrides,
  };
}

describe("PR-E correction-tracking wiring", () => {
  describe("qualifiesForCorrection — positive cases", () => {
    it("accepts a rejected high-confidence hypothesis tested within 24h", () => {
      const h = baseHypothesis({ confidence: "high" });
      assert.equal(qualifiesForCorrection(h), true,
        "high confidence rejection within 24h should qualify");
    });

    it("uses normalizeConfidence so trustScore can promote a low categorical row", () => {
      // A hypothesis with categorical 'low' but a high trustScore should
      // qualify — normalizeConfidence prefers numeric trustScore over the
      // categorical label.
      const h = baseHypothesis({ confidence: "low", trustScore: 80 });
      const norm = normalizeConfidence(h);
      assert.equal(norm.source, "trustScore");
      assert.ok(norm.predictedConfidence > 0.6,
        `expected trustScore-derived confidence > 0.6, got ${norm.predictedConfidence}`);
      assert.equal(qualifiesForCorrection(h), true);
    });

    it("uses evaluationResult.confidence when present", () => {
      const h = baseHypothesis({
        confidence: "low",
        evaluationResult: { verdict: "rejected", confidence: 0.9, evidenceQuality: "high", reasoningChain: "", gapsIdentified: [] },
      });
      const norm = normalizeConfidence(h);
      assert.equal(norm.source, "evaluationResult");
      assert.equal(qualifiesForCorrection(h), true);
    });
  });

  describe("qualifiesForCorrection — boundary on > 0.6 (medium maps to 0.6)", () => {
    it("rejects a 'medium' categorical confidence row (maps to 0.6, fails strict > 0.6)", () => {
      const h = baseHypothesis({ confidence: "medium" });
      const norm = normalizeConfidence(h);
      assert.equal(norm.predictedConfidence, 0.6,
        "categorical map: medium → 0.6 (see normalizeConfidence.ts)");
      // Document the preserved strictness — > 0.6 means "strictly above",
      // matching the original `parseFloat(...) > 0.6` intent.
      assert.equal(qualifiesForCorrection(h), false,
        "medium confidence is the borderline case and must remain excluded");
    });

    it("rejects 'low' categorical confidence (0.3)", () => {
      const h = baseHypothesis({ confidence: "low" });
      assert.equal(qualifiesForCorrection(h), false);
    });
  });

  describe("qualifiesForCorrection — non-qualifying events do not inflate metrics", () => {
    it("rejects status != 'rejected'", () => {
      assert.equal(qualifiesForCorrection(baseHypothesis({ status: "confirmed" })), false);
      assert.equal(qualifiesForCorrection(baseHypothesis({ status: "testing" })), false);
      assert.equal(qualifiesForCorrection(baseHypothesis({ status: "forming" })), false);
    });

    it("rejects hypotheses that never entered testing (no testingStartedAt)", () => {
      const h = baseHypothesis({ testingStartedAt: undefined });
      assert.equal(qualifiesForCorrection(h), false,
        "we only correct claims we actively tested — silent failures don't count");
    });

    it("rejects stale resolvedAt (> 24h ago)", () => {
      const h = baseHypothesis({
        resolvedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      });
      assert.equal(qualifiesForCorrection(h), false);
    });

    it("rejects missing resolvedAt", () => {
      const h = baseHypothesis({ resolvedAt: undefined });
      assert.equal(qualifiesForCorrection(h), false);
    });

    it("rejects malformed resolvedAt", () => {
      const h = baseHypothesis({ resolvedAt: "not-a-date" });
      assert.equal(qualifiesForCorrection(h), false);
    });

    it("rejects null / non-object input", () => {
      assert.equal(qualifiesForCorrection(null as any), false);
      assert.equal(qualifiesForCorrection(undefined as any), false);
      assert.equal(qualifiesForCorrection("h1" as any), false);
    });
  });

  describe("legacy bug pin: parseFloat(categorical) would reject every row", () => {
    // This pin documents the prior wiring gap. If someone reverts the
    // qualifying predicate to `parseFloat(h.confidence) > 0.6`, this
    // assertion stays accurate (NaN > 0.6 is false), but the matching
    // positive-case test above will fail — providing a clear signal that
    // the regression came back.
    it("parseFloat on a categorical confidence label returns NaN", () => {
      assert.ok(Number.isNaN(parseFloat("high")), "parseFloat('high') must be NaN");
      assert.ok(Number.isNaN(parseFloat("medium")), "parseFloat('medium') must be NaN");
      assert.ok(Number.isNaN(parseFloat("low")), "parseFloat('low') must be NaN");
      // Demonstrating the original bug — NaN comparison always false.
      assert.equal(parseFloat("high") > 0.6, false);
    });
  });
});

// ── Diagnostic visibility: eval engine surfaces raw counts ──────────────────

import { run306Eval } from "../evalEngine.js";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const EVAL_FILE = dataPath("eval_results.json");

describe("PR-E correction-tracking diagnostic visibility", () => {
  it("Intellectual Honesty exposes correctionsCount30d + openContradictionsCount", () => {
    try { if (fs.existsSync(EVAL_FILE)) fs.unlinkSync(EVAL_FILE); } catch {}
    const result = run306Eval();
    const ih = result.dimensions.find(d => d.key === "intellectualHonesty");
    assert.ok(ih, "intellectualHonesty dimension exists");
    assert.ok("correctionsCount30d" in ih!.components,
      "components should include correctionsCount30d so operators can distinguish 'no events' from 'unwired'");
    assert.ok("openContradictionsCount" in ih!.components,
      "components should include openContradictionsCount as the denominator companion");
    assert.equal(typeof ih!.components.correctionsCount30d, "number");
    assert.equal(typeof ih!.components.openContradictionsCount, "number");
    try { if (fs.existsSync(EVAL_FILE)) fs.unlinkSync(EVAL_FILE); } catch {}
  });

  it("Audience Impact exposes breakthroughsCount30d + confirmedHypothesesCount30d", () => {
    try { if (fs.existsSync(EVAL_FILE)) fs.unlinkSync(EVAL_FILE); } catch {}
    const result = run306Eval();
    const ai = result.dimensions.find(d => d.key === "audienceImpact");
    assert.ok(ai, "audienceImpact dimension exists");
    assert.ok("breakthroughsCount30d" in ai!.components,
      "components should include breakthroughsCount30d to debug zero breakthroughRate");
    assert.ok("confirmedHypothesesCount30d" in ai!.components,
      "components should include confirmedHypothesesCount30d as the denominator companion");
    assert.equal(typeof ai!.components.breakthroughsCount30d, "number");
    assert.equal(typeof ai!.components.confirmedHypothesesCount30d, "number");
    try { if (fs.existsSync(EVAL_FILE)) fs.unlinkSync(EVAL_FILE); } catch {}
  });
});
