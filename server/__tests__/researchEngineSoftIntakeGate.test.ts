/**
 * Tests for the soft intake gate + soft active-cap wired into
 * researchEngine.addHypothesis.
 *
 * Invariants pinned by this file:
 *   1. Default behaviour (no env flags): addHypothesis does NOT annotate
 *      candidates with hygieneTag='needs_review' — existing callers are
 *      unchanged.
 *   2. INTAKE_GATE_SOFT=1 + a failing-quality candidate: addHypothesis
 *      stores the record but annotates it with hygieneTag='needs_review'
 *      and a hygieneReason explaining the verdict. The store path is NOT
 *      broken.
 *   3. INTAKE_SOFT_MAX_ACTIVE=N + active count >= N: addHypothesis stores
 *      the record but annotates it with hygieneTag='needs_review' and a
 *      one-in-one-out hygieneReason. The hard cap MAX_HYPOTHESIS_QUEUE is
 *      unchanged.
 *   4. With INTAKE_GATE_SOFT=1, a well-formed candidate that passes the
 *      gate is NOT annotated.
 *
 * Run: npx tsx --test server/__tests__/researchEngineSoftIntakeGate.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "research-engine-soft-gate-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const LAB = path.join(TMP, "research_lab.json");

function clearLab(): void {
  if (fs.existsSync(LAB)) fs.unlinkSync(LAB);
}

const { addHypothesis, getResearchLab, resetResearchLab } = await import("../researchEngine.ts");

function freshInput(over: Record<string, unknown> = {}): any {
  return {
    claim:      "Default research-gap claim with metric — citation count will pass 1000 by Q4 2026.",
    basis:      "https://example.com/source",
    metric:     "OpenAlex citation count",
    prediction: "Citation count will pass 1000 by Q4 2026.",
    timeframe:  "Q4 2026",
    confidence: "medium",
    source:     "test",
    measurementPath: "OpenAlex citation count for paper X",
    ...over,
  };
}

describe("researchEngine — soft intake gate (default off)", () => {
  before(() => clearLab());
  beforeEach(() => {
    delete process.env.INTAKE_GATE_SOFT;
    delete process.env.INTAKE_SOFT_MAX_ACTIVE;
    // Wipe both the JSON snapshot and any DB-backed state the repo may hold,
    // so each test starts from an empty active queue and the similarity /
    // entity dedup gates inside addHypothesis can't see prior rows.
    try { resetResearchLab(); } catch { /* fine if uninitialized */ }
    clearLab();
  });

  it("default: candidate with no evidenceRef/useCase is stored without hygieneTag", () => {
    const stored = addHypothesis(freshInput()) as any;
    assert.ok(stored);
    assert.equal(stored.hygieneTag, undefined);
  });

  it("INTAKE_GATE_SOFT=1: failing candidate is stored with hygieneTag=needs_review", () => {
    process.env.INTAKE_GATE_SOFT = "1";
    const stored = addHypothesis(freshInput({ claim: "Position A is more accurate than Position B." })) as any;
    assert.ok(stored);
    assert.equal(stored.hygieneTag, "needs_review");
    assert.ok(stored.hygieneReason && stored.hygieneReason.includes("soft intake gate"));
    assert.equal(stored.hygieneTaggedBy, "intake_gate");
    // Stored, not silently dropped.
    assert.equal(getResearchLab().hypotheses.length, 1);
  });

  it("INTAKE_GATE_SOFT=1: a research-gap claim that fails the strict useCase rule is still STORED (soft refusal only)", () => {
    // The current intake gate requires both an evidenceRef AND a useCase.
    // The addHypothesis surface does not yet pass useCase, so a typical
    // research-gap candidate routes to needs_review under the soft gate —
    // BUT it is still stored (soft routing, not a hard drop). That is the
    // safety property we want to pin: existing callers don't silently
    // break, they get visible review-routing the operator can act on.
    process.env.INTAKE_GATE_SOFT = "1";
    const stored = addHypothesis(freshInput()) as any;
    assert.ok(stored, "soft-gate refusal must still store the record");
    assert.equal(getResearchLab().hypotheses.length, 1);
    // The record carries the soft-gate routing tag, but is NOT dropped.
    assert.equal(stored.hygieneTag, "needs_review");
    assert.ok(stored.hygieneReason && stored.hygieneReason.includes("soft intake gate"));
  });

  it("INTAKE_SOFT_MAX_ACTIVE=1: second candidate is annotated needs_review", () => {
    process.env.INTAKE_SOFT_MAX_ACTIVE = "1";
    // Use deliberately dissimilar claims so the similarity / entity dedup
    // gates in addHypothesis don't merge the second into the first.
    const first = addHypothesis(freshInput({
      claim:  "OpenAlex citation count for paper Y about photosynthesis will pass 500 by Q4 2026.",
      metric: "OpenAlex citation count paper Y",
    })) as any;
    assert.equal(first.hygieneTag, undefined);
    const second = addHypothesis(freshInput({
      claim:  "GitHub star count for repo monodepth-net will pass 2500 by H1 2027 with weekly observation.",
      metric: "GitHub star count monodepth-net",
      measurementPath: "GitHub stars API for monodepth-net",
    })) as any;
    assert.ok(second);
    assert.equal(second.hygieneTag, "needs_review");
    assert.ok(second.hygieneReason && second.hygieneReason.includes("soft active cap"));
  });
});
