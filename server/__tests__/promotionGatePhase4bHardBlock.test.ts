/**
 * Phase 4-b — operator-gated authoritative hard block on LOW-RISK
 * promotions when the phase3aPrep readiness attestation is missing,
 * parse_error, or reports a verdict other than `fully_prepared`.
 *
 * Phase 4-b is the FIRST authoritative use of the attestation channel.
 * It is OPERATOR-GATED via the env flag
 *   PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY=true
 * which is INDEPENDENT of the Phase 4-a soft-warning flag. The hard
 * block is routed through the existing `gate.ok=false` boundary — no
 * new write site to `status: "applied"`, no new mutation endpoint, no
 * new public-action surface.
 *
 * Properties verified here:
 *   1. Flag OFF (default): every return path of `canPromote` is byte-
 *      identical to the pre-Phase-4-b baseline. No blocks added. The
 *      Phase 4-a soft-warning behaviour is unchanged.
 *   2. Flag ON + low-risk + fully_prepared verdict: gate.ok stays
 *      true; no Phase 4-b failure is appended.
 *   3. Flag ON + low-risk + missing attestation: gate.ok flips to
 *      false; a single Phase 4-b failure string surfaces with a
 *      clear, operator-readable reason; the failure NAMES the flag.
 *   4. Flag ON + low-risk + parse_error attestation: gate.ok flips to
 *      false; failure string mentions the parse error.
 *   5. Flag ON + low-risk + not_ready verdict: gate.ok flips to
 *      false; failure string mentions the candidate id and verdict.
 *   6. Flag ON + low-risk + high_tier_ready verdict (not fully): also
 *      flips ok to false (only `fully_prepared` is considered ready).
 *   7. Flag ON + MEDIUM-risk + missing/not-ready: NO Phase 4-b block.
 *      The medium-risk gate continues to behave per pre-Phase-4-b
 *      policy (golden sets only). Same for high-risk: Phase 4-b does
 *      NOT apply.
 *   8. Flag ON + low-risk + ready: attestation telemetry continues to
 *      surface unchanged (Phase 3a/3b channel intact).
 *   9. Phase 4-a flag and Phase 4-b flag are independent: enabling
 *      Phase 4-a does NOT trigger a Phase 4-b block, and vice-versa.
 *  10. `derivePhase3aPrepHardBlockFailures` is pure with respect to
 *      its `flagOn` / `risk` arguments — same input always yields the
 *      same output regardless of process.env at call time.
 *  11. The Phase 4-b flag parser accepts ONLY the literal "true"
 *      (case-insensitive). Other truthy strings ("1", "yes",
 *      "TRUE-ish") do NOT enable the hard block.
 *  12. Pin 7 (no public-action surface) reaffirmed: this test never
 *      invokes any mutation route; it inspects pure return values
 *      only.
 *  13. Pin 11 (single-write-site boundary) reaffirmed: the block
 *      surfaces via the existing `gate.ok` boolean. No new write site
 *      is exercised here and no Phase 4-b code path mutates engine
 *      state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canPromote,
  derivePhase3aPrepHardBlockFailures,
  readPhase3aPrepBlockLowRiskFlag,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV,
  type PromotionAttestation,
} from "../eval/promotionGate.js";
import {
  PHASE3A_PREP_EVIDENCE_PREFIX,
} from "../eval/phase3aPrepAttestation.js";
import type { SelfRecommendation } from "@shared/schema";

// Track A: this test file intentionally pins the precondition-key list
// locally rather than importing `phase3aPrepHarness`, mirroring the
// approach used in `promotionGatePhase4aSoftWarning.test.ts`. The
// gate-integration tests in `promotionGateAttestation.test.ts` (an
// allow-listed importer of the harness) catch schema drift; this file
// updates the literal list in lock-step.
const LOCAL_PHASE3A_PREP_PRECONDITION_KEYS = [
  "reversibleLowRiskActionOnly",
  "explicitKillSwitchAndResourceLimits",
  "anomalyAndDriftDetectionPlaceholder",
  "rollbackProof",
  "humanApprovalBoundary",
  "metricsClockReadiness",
  "noPublicAction",
] as const;
const LOCAL_PHASE3A_PREP_HARNESS_VERSION = "phase3aPrep.v1" as const;

/* ─── Helpers ──────────────────────────────────────────────────────── */

function mkRec(overrides: Partial<SelfRecommendation> = {}): SelfRecommendation {
  return {
    id: "rec_p4b_1",
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

function fullySatisfiedCandidate(candidateId = "cand-p4b-ready") {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of LOCAL_PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {
      high: { key, priority: "high", status: "satisfied", evidenceRef: "ref://h", rationale: "h" },
      low:  { key, priority: "low",  status: "satisfied", evidenceRef: "ref://l", rationale: "l" },
    };
  }
  // attestedAt: REQUIRED as of Phase 4-c (PR #401). Fixed default keeps existing tests deterministic.
  return { candidateId, kind: "summarizationTemplate", attestedAt: "2026-05-18T19:00:00.000Z", preconditions };
}

function notReadyCandidate(candidateId = "cand-p4b-blocked") {
  const cand = fullySatisfiedCandidate(candidateId);
  const firstKey = LOCAL_PHASE3A_PREP_PRECONDITION_KEYS[0];
  (cand.preconditions[firstKey] as any).high.status = "unverified";
  return cand;
}

/** A candidate whose LOW-tier slots are unverified but HIGH-tier is
 *  satisfied — the harness reports `verdict === "high_tier_ready"`.
 *  Phase 4-b treats anything other than `fully_prepared` as not-ready,
 *  so this is also expected to hard-block. */
function highTierReadyCandidate(candidateId = "cand-p4b-high-tier") {
  const cand = fullySatisfiedCandidate(candidateId);
  for (const key of LOCAL_PHASE3A_PREP_PRECONDITION_KEYS) {
    (cand.preconditions[key] as any).low.status = "unverified";
  }
  return cand;
}

function markerEvidence(payload: unknown): string {
  return JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(payload)]);
}

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

function setHardBlock(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, value);
}
function restoreHardBlock(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
}
function setSoftWarn(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV, value);
}
function restoreSoftWarn(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV, prev);
}

/* ─── 1. flag OFF: byte-identical with pre-Phase-4-b ─────────────── */

describe("promotionGate Phase 4-b — hard-block flag OFF (default)", () => {
  it("no marker, low-risk: gate.ok=true; no Phase 4-b failure appended", async () => {
    const prev = setHardBlock(undefined);
    try {
      const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      assert.equal(r.ok, true);
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
        `unexpected Phase 4-b failure: ${r.failures.join(", ")}`,
      );
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("not-ready marker, low-risk: gate.ok=true; no Phase 4-b failure (flag off)", async () => {
    const prev = setHardBlock(undefined);
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-flagoff-blocked")) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
      );
      // Telemetry channel still surfaces the verdict for observers.
      assert.equal(r.attestations!.length, 1);
      assert.equal(r.attestations![0]!.readiness?.verdict, "not_ready");
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("parse_error marker, low-risk: gate.ok=true; no Phase 4-b failure (flag off)", async () => {
    const prev = setHardBlock(undefined);
    try {
      const bad = JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"]);
      const r = await canPromote(mkRec({ risk: "low", evidence: bad }));
      assert.equal(r.ok, true);
      assert.equal(r.attestations![0]!.status, "parse_error");
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
      );
    } finally {
      restoreHardBlock(prev);
    }
  });
});

/* ─── 2. flag ON + low-risk + fully_prepared: no block ─────────────── */

describe("promotionGate Phase 4-b — flag ON, low-risk, ready candidate", () => {
  it("fully_prepared verdict yields no hard block; gate.ok=true", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-on-ready")) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
      );
      // Attestation telemetry continues to surface unchanged.
      assert.equal(r.attestations!.length, 1);
      assert.equal(r.attestations![0]!.readiness?.verdict, "fully_prepared");
    } finally {
      restoreHardBlock(prev);
    }
  });
});

/* ─── 3. flag ON + low-risk + missing/parse_error/not-ready: HARD BLOCK */

describe("promotionGate Phase 4-b — flag ON, low-risk, missing attestation", () => {
  it("missing phase3aPrep attestation: gate.ok=false; failure names the flag", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /phase3aPrep readiness attestation missing/);
      assert.match(
        r.failures[0]!,
        new RegExp(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV),
      );
      assert.match(r.failures[0]!, /Hard block/);
    } finally {
      restoreHardBlock(prev);
    }
  });
});

describe("promotionGate Phase 4-b — flag ON, low-risk, parse_error attestation", () => {
  it("parse_error: gate.ok=false; failure mentions parse error and flag", async () => {
    const prev = setHardBlock("true");
    try {
      const bad = JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"]);
      const r = await canPromote(mkRec({ risk: "low", evidence: bad }));
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /could not be parsed/);
      assert.match(
        r.failures[0]!,
        new RegExp(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV),
      );
    } finally {
      restoreHardBlock(prev);
    }
  });
});

describe("promotionGate Phase 4-b — flag ON, low-risk, not_ready verdict", () => {
  it("not_ready: gate.ok=false; failure names candidate id and verdict", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-block-nr")) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /cand-block-nr/);
      assert.match(r.failures[0]!, /not_ready/);
      assert.match(r.failures[0]!, /Hard block/);
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("high_tier_ready: gate.ok=false (only fully_prepared is ready)", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(highTierReadyCandidate("cand-block-ht")) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /high_tier_ready/);
      assert.match(r.failures[0]!, /cand-block-ht/);
    } finally {
      restoreHardBlock(prev);
    }
  });
});

/* ─── 4. flag ON + non-low-risk: NO Phase 4-b block ────────────────── */

describe("promotionGate Phase 4-b — flag ON, MEDIUM-risk: unaffected", () => {
  it("medium-risk + missing attestation: NO Phase 4-b failure (out of scope)", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(mkRec({ risk: "medium", evidence: "[]" }));
      // gate.ok is dictated by golden-set policy for medium-risk, not Phase 4-b.
      // In the current codebase golden sets pass, so ok=true. The critical
      // assertion is the ABSENCE of any Phase 4-b failure string.
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
        `unexpected Phase 4-b failure on medium-risk: ${r.failures.join(", ")}`,
      );
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("medium-risk + not_ready marker: NO Phase 4-b failure (out of scope)", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(notReadyCandidate("cand-med-nr")) }),
      );
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
        `unexpected Phase 4-b failure on medium-risk: ${r.failures.join(", ")}`,
      );
      // Phase 4-b does NOT block medium-risk. The medium-risk gate's
      // existing golden-set policy governs ok.
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("high-risk + missing attestation: NO Phase 4-b failure (out of scope)", async () => {
    const prev = setHardBlock("true");
    const prevHi = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = "true";
    try {
      const r = await canPromote(mkRec({ risk: "high", evidence: "[]" }));
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
        `unexpected Phase 4-b failure on high-risk: ${r.failures.join(", ")}`,
      );
    } finally {
      restoreHardBlock(prev);
      if (prevHi === undefined) delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
      else process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prevHi;
    }
  });
});

/* ─── 5. independence from Phase 4-a soft-warning flag ─────────────── */

describe("promotionGate Phase 4-b — independence from Phase 4-a flag", () => {
  it("Phase 4-a ON, Phase 4-b OFF, low-risk + not_ready: NO hard block; soft warning surfaces", async () => {
    const prevA = setSoftWarn("true");
    const prevB = setHardBlock(undefined);
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-indep-a-only")) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.equal(r.softWarnings!.length, 1);
      assert.equal(
        r.failures.some(f => /phase3aPrep readiness/i.test(f)),
        false,
      );
    } finally {
      restoreSoftWarn(prevA);
      restoreHardBlock(prevB);
    }
  });

  it("Phase 4-a OFF, Phase 4-b ON, low-risk + not_ready: hard block; no soft warning", async () => {
    const prevA = setSoftWarn(undefined);
    const prevB = setHardBlock("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-indep-b-only")) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.softWarnings!.length, 0);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /Hard block/);
    } finally {
      restoreSoftWarn(prevA);
      restoreHardBlock(prevB);
    }
  });

  it("Both flags ON, low-risk + not_ready: hard block AND soft warning both surface", async () => {
    const prevA = setSoftWarn("true");
    const prevB = setHardBlock("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-indep-both")) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.softWarnings!.length, 1);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /Hard block/);
      assert.match(r.softWarnings![0]!, /ADVISORY ONLY/);
    } finally {
      restoreSoftWarn(prevA);
      restoreHardBlock(prevB);
    }
  });
});

/* ─── 6. derivePhase3aPrepHardBlockFailures purity ─────────────────── */

describe("promotionGate Phase 4-b — derivePhase3aPrepHardBlockFailures purity", () => {
  function mkAttestation(verdict: "fully_prepared" | "high_tier_ready" | "not_ready"): PromotionAttestation {
    return Object.freeze({
      source: "phase3aPrep" as const,
      harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
      status: "evaluated" as const,
      candidateId: "x",
      readiness: {
        highTierAllSatisfied: verdict !== "not_ready",
        lowTierAllSatisfied:  verdict === "fully_prepared",
        verdict,
        blockers: [],
      },
      parseWarnings: [],
      parseError: null,
    });
  }

  it("returns [] when flagOn is false even on not_ready attestation", () => {
    const out = derivePhase3aPrepHardBlockFailures([mkAttestation("not_ready")], false, "low");
    assert.deepEqual(out, []);
  });

  it("returns [] when risk is not 'low'", () => {
    const att = mkAttestation("not_ready");
    assert.deepEqual(derivePhase3aPrepHardBlockFailures([att], true, "medium"), []);
    assert.deepEqual(derivePhase3aPrepHardBlockFailures([att], true, "high"), []);
  });

  it("returns one entry when flagOn and risk=low and verdict not fully_prepared", () => {
    for (const v of ["high_tier_ready", "not_ready"] as const) {
      const out = derivePhase3aPrepHardBlockFailures([mkAttestation(v)], true, "low");
      assert.equal(out.length, 1);
      assert.match(out[0]!, new RegExp(v));
    }
  });

  it("returns one entry when flagOn and risk=low and attestation missing", () => {
    const out = derivePhase3aPrepHardBlockFailures([], true, "low");
    assert.equal(out.length, 1);
    assert.match(out[0]!, /missing/);
  });

  it("returns [] for evaluated/fully_prepared attestation under flag ON / risk low", () => {
    const out = derivePhase3aPrepHardBlockFailures([mkAttestation("fully_prepared")], true, "low");
    assert.deepEqual(out, []);
  });

  it("is deterministic: same input → same output regardless of process.env", () => {
    const att = mkAttestation("not_ready");
    const a = derivePhase3aPrepHardBlockFailures([att], true, "low");
    const prev = setHardBlock("false");
    try {
      const b = derivePhase3aPrepHardBlockFailures([att], true, "low");
      assert.deepEqual(a, b);
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("ignores non-phase3aPrep attestations (forward-compat: treated as missing)", () => {
    const att = {
      source: "unknownSource" as unknown as "phase3aPrep",
      harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
      status: "evaluated" as const,
      candidateId: "x",
      readiness: { highTierAllSatisfied: true, lowTierAllSatisfied: true, verdict: "fully_prepared" as const, blockers: [] },
      parseWarnings: [],
      parseError: null,
    } as PromotionAttestation;
    const out = derivePhase3aPrepHardBlockFailures([att], true, "low");
    assert.equal(out.length, 1);
    assert.match(out[0]!, /missing/);
  });
});

/* ─── 7. flag parser strictness ────────────────────────────────────── */

describe("promotionGate Phase 4-b — flag parser", () => {
  it("returns false for unset", () => {
    const prev = setHardBlock(undefined);
    try { assert.equal(readPhase3aPrepBlockLowRiskFlag(), false); }
    finally { restoreHardBlock(prev); }
  });
  it("returns true for 'true' (lowercase)", () => {
    const prev = setHardBlock("true");
    try { assert.equal(readPhase3aPrepBlockLowRiskFlag(), true); }
    finally { restoreHardBlock(prev); }
  });
  it("returns true for 'TRUE' (uppercase)", () => {
    const prev = setHardBlock("TRUE");
    try { assert.equal(readPhase3aPrepBlockLowRiskFlag(), true); }
    finally { restoreHardBlock(prev); }
  });
  it("returns false for '1'", () => {
    const prev = setHardBlock("1");
    try { assert.equal(readPhase3aPrepBlockLowRiskFlag(), false); }
    finally { restoreHardBlock(prev); }
  });
  it("returns false for 'yes'", () => {
    const prev = setHardBlock("yes");
    try { assert.equal(readPhase3aPrepBlockLowRiskFlag(), false); }
    finally { restoreHardBlock(prev); }
  });
  it("returns false for empty string", () => {
    const prev = setHardBlock("");
    try { assert.equal(readPhase3aPrepBlockLowRiskFlag(), false); }
    finally { restoreHardBlock(prev); }
  });
});

/* ─── 8. boundary-topology: no new write site / no new public surface ─ */

describe("promotionGate Phase 4-b — boundary topology (Pin 7 / Pin 11)", () => {
  it("Phase 4-b block produces ok=false through the existing gate.ok boolean (no extra fields)", async () => {
    const prev = setHardBlock("true");
    try {
      const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      // The block surfaces exclusively as `ok: false` + `failures: [...]`.
      // No new boolean or mutation flag is added to the result shape.
      const allowedKeys = ["ok", "failures", "ranSets", "attestations", "softWarnings"];
      for (const k of Object.keys(r)) {
        assert.ok(allowedKeys.includes(k), `unexpected key on PromotionResult: ${k}`);
      }
      assert.equal(r.ok, false);
      assert.equal(typeof r.ok, "boolean");
    } finally {
      restoreHardBlock(prev);
    }
  });

  it("gate source declares the Phase 4-b flag literal (boundary audit handshake)", async () => {
    // The audit asserts a `phase4b_hard_block_flag_wired` finding by
    // searching the gate source text for the flag literal. Confirm the
    // literal name we use here is the one the gate exports.
    assert.equal(
      PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
      "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY",
    );
  });
});
