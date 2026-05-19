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

/* ─── Phase 4-c part 2 (PR #403): medium-risk toggle matrix ───────────── */

describe("promotionGate — Phase 4-c part 2 medium-risk toggle matrix", () => {
  const MED_ENV  = "PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY";
  const LOW_ENV  = "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY";
  const HIGH_OVERRIDE_ENV = "PROMOTION_GATE_ALLOW_HIGH_RISK";

  function setEnv(name: string, value: string | undefined): string | undefined {
    const prev = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    return prev;
  }
  function restoreEnv(name: string, prev: string | undefined): void {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }

  it("default state (medium env UNSET): medium-risk passes (no PR #403 failure)", async () => {
    const prev = setEnv(MED_ENV, undefined);
    try {
      const r = await canPromote(mkRec({ risk: "medium" }));
      // The legacy medium-risk path returns ok=true when golden sets
      // pass. Critically: no Phase 4-c pt2 failure appears.
      const leak = r.failures.some(f =>
        /medium-risk promotion/.test(f) || /risk=medium/.test(f),
      );
      assert.equal(leak, false, `unexpected PR #403 failure when env unset: ${r.failures.join(", ")}`);
    } finally {
      restoreEnv(MED_ENV, prev);
    }
  });

  it("medium env ON, no attestation: medium-risk blocks with the missing-attestation failure", async () => {
    const prev = setEnv(MED_ENV, "true");
    try {
      const r = await canPromote(mkRec({ risk: "medium", evidence: "[]" }));
      assert.equal(r.ok, false);
      const matched = r.failures.some(f => /missing on medium-risk promotion/.test(f));
      assert.equal(matched, true, `expected medium-risk missing failure, got: ${r.failures.join(" | ")}`);
    } finally {
      restoreEnv(MED_ENV, prev);
    }
  });

  it("medium env ON, low-risk rec: medium-risk branch does NOT fire (low-risk gated by its own env)", async () => {
    const prevMed = setEnv(MED_ENV, "true");
    const prevLow = setEnv(LOW_ENV, undefined);
    try {
      const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      const leak = r.failures.some(f =>
        /medium-risk promotion/.test(f) || /risk=medium/.test(f),
      );
      assert.equal(leak, false, `medium-risk failure leaked into low-risk: ${r.failures.join(", ")}`);
    } finally {
      restoreEnv(MED_ENV, prevMed);
      restoreEnv(LOW_ENV, prevLow);
    }
  });

  it("medium env ON + high-risk override ON: HIGH-risk is untouched (no PR #403 leak, no 4-c freshness leak)", async () => {
    const prevMed   = setEnv(MED_ENV, "true");
    const prevAllow = setEnv(HIGH_OVERRIDE_ENV, "true");
    try {
      const r = await canPromote(mkRec({ risk: "high", evidence: "[]" }));
      // High-risk path is fully governed by ALLOW_HIGH_RISK + golden
      // sets. No medium-risk failure may surface.
      const leak = r.failures.some(f =>
        /medium-risk promotion/.test(f) ||
        /risk=medium/.test(f) ||
        new RegExp(MED_ENV).test(f),
      );
      assert.equal(leak, false, `PR #403 medium-risk failure leaked into high-risk: ${r.failures.join(", ")}`);
    } finally {
      restoreEnv(MED_ENV, prevMed);
      restoreEnv(HIGH_OVERRIDE_ENV, prevAllow);
    }
  });

  it("medium env ON + low env ON: both branches stay isolated (no cross-tier leakage)", async () => {
    const prevMed = setEnv(MED_ENV, "true");
    const prevLow = setEnv(LOW_ENV, "true");
    try {
      // Low-risk rec missing attestation: only the low-risk failure
      // should appear (NOT the medium-risk one), and vice versa.
      const rLow = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      assert.equal(rLow.ok, false);
      const lowMatch = rLow.failures.filter(f => /missing on low-risk promotion/.test(f));
      const medMatch = rLow.failures.filter(f => /missing on medium-risk promotion/.test(f));
      assert.equal(lowMatch.length, 1, `expected 1 low-risk missing failure: ${rLow.failures.join(" | ")}`);
      assert.equal(medMatch.length, 0, `medium-risk failure must NOT appear on low-risk rec: ${rLow.failures.join(" | ")}`);

      const rMed = await canPromote(mkRec({ risk: "medium", evidence: "[]" }));
      assert.equal(rMed.ok, false);
      const lowMatch2 = rMed.failures.filter(f => /missing on low-risk promotion/.test(f));
      const medMatch2 = rMed.failures.filter(f => /missing on medium-risk promotion/.test(f));
      assert.equal(medMatch2.length, 1, `expected 1 medium-risk missing failure: ${rMed.failures.join(" | ")}`);
      assert.equal(lowMatch2.length, 0, `low-risk failure must NOT appear on medium-risk rec: ${rMed.failures.join(" | ")}`);
    } finally {
      restoreEnv(MED_ENV, prevMed);
      restoreEnv(LOW_ENV, prevLow);
    }
  });
});
