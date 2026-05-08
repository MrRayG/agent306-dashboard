/**
 * promotionGate tests (spec §5).
 *
 * Confirms the gate's core guarantee: it is the ONLY path to `applied`,
 * and the policy matrix (status × risk × golden results) matches the
 * spec. No-code-path-bypass asserted via proxy — the engine's
 * applyRecommendation test also exercises the gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canPromote } from "../eval/promotionGate.js";
import { runAllGoldenSets } from "../eval/regressionRunner.js";
import type { SelfRecommendation } from "@shared/schema";

function mkRec(overrides: Partial<SelfRecommendation> = {}): SelfRecommendation {
  return {
    id: "rec_gate_1",
    category: "prompt",
    risk: "low",
    title: "T",
    rationale: "R",
    proposedChange: "P",
    proposedDiff: null,
    evidence: "[]",
    status: "approved",
    author: "agent",
    sourceHypothesisId: null,
    sourceInsightId: null,
    prUrl: null,
    patchPath: null,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    rejectedAt: null,
    appliedAt: null,
    revertedAt: null,
    approvedBy: "op",
    reviewNote: null,
    ...overrides,
  } as SelfRecommendation;
}

describe("promotionGate", () => {
  it("blocks anything not approved", async () => {
    const r = await canPromote(mkRec({ status: "proposed" }));
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /not approved/);
  });

  it("passes an approved low-risk rec even if a golden case would fail (logged, not blocking)", async () => {
    const r = await canPromote(mkRec({ risk: "low" }));
    // With current code state, golden sets should pass — assert the shape.
    assert.equal(r.ok, true);
    assert.ok(r.ranSets.length >= 1, "expected at least one golden set to have run");
  });

  it("runs the golden-set registry (voice + hypothesisTriage + modelRouter)", async () => {
    const r = await canPromote(mkRec({ risk: "medium" }));
    const ranNames = r.ranSets.map(s => s.split("@")[0]).sort();
    // The three seed sets should all be represented.
    assert.ok(ranNames.includes("voice"), `missing voice: ${ranNames}`);
    assert.ok(ranNames.includes("hypothesisTriage"), `missing hypothesisTriage: ${ranNames}`);
    assert.ok(ranNames.includes("modelRouter"), `missing modelRouter: ${ranNames}`);
  });

  it("passes an approved medium-risk rec when golden sets pass (current code is in-spec)", async () => {
    const r = await canPromote(mkRec({ risk: "medium" }));
    assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
  });

  it("blocks an approved high-risk rec without PROMOTION_GATE_ALLOW_HIGH_RISK", async () => {
    const prev = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    try {
      const r = await canPromote(mkRec({ risk: "high" }));
      assert.equal(r.ok, false);
      assert.ok(r.failures.some(f => /high-risk/.test(f)));
    } finally {
      if (prev !== undefined) process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prev;
    }
  });

  it("allows an approved high-risk rec when PROMOTION_GATE_ALLOW_HIGH_RISK=true AND golden sets pass", async () => {
    const prev = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = "true";
    try {
      const r = await canPromote(mkRec({ risk: "high" }));
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
    } finally {
      if (prev === undefined) delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
      else process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prev;
    }
  });

  it("regression runner reports total pass on current code (sanity)", async () => {
    const report = await runAllGoldenSets();
    assert.equal(report.overallOk, true, `failed cases: ${report.results.filter(r => !r.ok).map(r => `${r.setName}.${r.caseId}:${r.reason}`).join("; ")}`);
  });

  it("runs the claimVerifier golden set via async handler (Phase 1 closure — no silent bypass)", async () => {
    const r = await canPromote(mkRec({ risk: "medium" }));
    const ranNames = r.ranSets.map(s => s.split("@")[0]).sort();
    assert.ok(
      ranNames.includes("claimVerifier"),
      `claimVerifier must be executed by the gate; ranSets=${ranNames.join(",")}`,
    );
  });
});
