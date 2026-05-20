/**
 * Phase 4-d (PR #408) — attestation-readiness + attestation-freshness
 * hard block for HIGH-RISK promotions.
 *
 * Mirrors `server/__tests__/phase4cMediumRiskGate.test.ts` (the PR #403
 * medium-risk variant). The new env var is
 *
 *   PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY=true
 *
 * which gates a NEW high-risk branch in `canPromote`. When the flag is
 * on AND the rec is `risk === "high"`, the gate enforces the identical
 * missing / parse_error / not-`fully_prepared` / stale / future-dated
 * checks the medium-risk branch enforces under Phase 4-c part 2. The
 * freshness threshold env var (`PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS`)
 * is SHARED across all three tiers — one window governs low-risk,
 * medium-risk, and high-risk; this PR does NOT add a third freshness
 * env var.
 *
 * STACKING SEMANTICS (critical): Phase 4-d STACKS on top of the existing
 * `PROMOTION_GATE_ALLOW_HIGH_RISK=true` operator override — it does NOT
 * replace it. When the flag is on AND the attestation passes, the rec
 * STILL needs `PROMOTION_GATE_ALLOW_HIGH_RISK=true` to clear. When the
 * flag is off, high-risk behavior is exactly the pre-PR baseline.
 *
 * Properties verified here:
 *   1. `readPhase3aPrepBlockHighRiskFlag` is a pure env parser; only a
 *      case-insensitive literal `"true"` enables.
 *   2. `deriveHighRiskPhase3aPrepHardBlockFailures` is pure and mirrors
 *      the medium-risk helper byte-for-byte in shape.
 *   3. `canPromote` end-to-end stacking behavior.
 *   4. Pin 7 / Pin 11 reaffirmed: the high-risk block surfaces via the
 *      existing `gate.ok=false` + `failures` boundary. No new mutation
 *      route, no new write site, no new public surface.
 *   5. Track A isolation: this file does NOT import the harness module
 *      `server/experiments/phase3aPrepHarness`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canPromote,
  deriveHighRiskPhase3aPrepHardBlockFailures,
  deriveMediumRiskPhase3aPrepHardBlockFailures,
  derivePhase3aPrepHardBlockFailures,
  readPhase3aPrepBlockHighRiskFlag,
  PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
  type PromotionAttestation,
} from "../eval/promotionGate.js";
import { PHASE3A_PREP_EVIDENCE_PREFIX } from "../eval/phase3aPrepAttestation.js";
import type { SelfRecommendation } from "@shared/schema";

// Local mirror constants (Track A isolation — do NOT import from
// server/experiments/phase3aPrepHarness).
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
const DAY_MS = 86_400_000;
const ALLOW_HIGH_RISK_ENV = "PROMOTION_GATE_ALLOW_HIGH_RISK";

/* ─── Helpers ──────────────────────────────────────────────────────── */

function mkRec(overrides: Partial<SelfRecommendation> = {}): SelfRecommendation {
  return {
    id: "rec_p4d",
    category: "prompt",
    risk: "high",
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

function fullySatisfiedCandidate(
  candidateId = "cand-p4d-ready",
  attestedAt = "2026-05-18T19:00:00.000Z",
) {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of LOCAL_PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {
      high: { key, priority: "high", status: "satisfied", evidenceRef: "ref://h", rationale: "h" },
      low:  { key, priority: "low",  status: "satisfied", evidenceRef: "ref://l", rationale: "l" },
    };
  }
  return { candidateId, kind: "summarizationTemplate", attestedAt, preconditions };
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
function setHighFlag(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, value);
}
function restoreHighFlag(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
}
function setMediumFlag(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, value);
}
function restoreMediumFlag(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
}
function setLowFlag(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, value);
}
function restoreLowFlag(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
}
function setMaxAge(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, value);
}
function restoreMaxAge(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prev);
}
function setAllowHigh(value: string | undefined): string | undefined {
  return setEnv(ALLOW_HIGH_RISK_ENV, value);
}
function restoreAllowHigh(prev: string | undefined): void {
  restoreEnv(ALLOW_HIGH_RISK_ENV, prev);
}

function mkEvaluatedAttestation(
  attestedAt: string,
  verdict: "fully_prepared" | "high_tier_ready" | "not_ready" = "fully_prepared",
  candidateId = "cand-high",
): PromotionAttestation {
  return Object.freeze({
    source: "phase3aPrep" as const,
    harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
    status: "evaluated" as const,
    candidateId,
    attestedAt,
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

function mkParseErrorAttestation(attestedAt = ""): PromotionAttestation {
  return Object.freeze({
    source: "phase3aPrep" as const,
    harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
    status: "parse_error" as const,
    candidateId: "",
    attestedAt,
    readiness: null,
    parseWarnings: [],
    parseError: "shape validation failed: candidate.attestedAt: required ISO-8601 string is missing",
  });
}

/* ─── 1. readPhase3aPrepBlockHighRiskFlag env parser ───────────────── */

describe("promotionGate Phase 4-d — readPhase3aPrepBlockHighRiskFlag", () => {
  it("returns false when env is unset", () => {
    const prev = setHighFlag(undefined);
    try { assert.equal(readPhase3aPrepBlockHighRiskFlag(), false); }
    finally { restoreHighFlag(prev); }
  });

  it("returns true only for literal 'true' (case-insensitive)", () => {
    for (const v of ["true", "True", "TRUE", "tRuE"]) {
      const prev = setHighFlag(v);
      try { assert.equal(readPhase3aPrepBlockHighRiskFlag(), true, `value=${v}`); }
      finally { restoreHighFlag(prev); }
    }
  });

  it("returns false for any other value", () => {
    for (const v of ["", " ", "1", "yes", "on", "TrueButTrailing", "false", "0"]) {
      const prev = setHighFlag(v);
      try { assert.equal(readPhase3aPrepBlockHighRiskFlag(), false, `value=${JSON.stringify(v)}`); }
      finally { restoreHighFlag(prev); }
    }
  });

  it("is independent of low/medium-risk flags (enabling them does not enable high-risk)", () => {
    const prevHigh = setHighFlag(undefined);
    const prevMed  = setMediumFlag("true");
    const prevLow  = setLowFlag("true");
    try {
      assert.equal(readPhase3aPrepBlockHighRiskFlag(), false);
    } finally {
      restoreHighFlag(prevHigh);
      restoreMediumFlag(prevMed);
      restoreLowFlag(prevLow);
    }
  });
});

/* ─── 2. deriveHighRiskPhase3aPrepHardBlockFailures — pure ─────────── */

describe("promotionGate Phase 4-d — deriveHighRiskPhase3aPrepHardBlockFailures (flag off)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("flagOn=false → [] regardless of risk / freshness / attestation state", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], false, "high", 7, now), []);
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], false, "low", 7, now), []);
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], false, "medium", 7, now), []);
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([], false, "high", 7, now), []);
  });
});

describe("promotionGate Phase 4-d — deriveHighRiskPhase3aPrepHardBlockFailures (risk gate)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("flagOn=true + risk='low' → [] (low-risk is governed by PR #400/401)", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "low", 7, now), []);
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([], true, "low", 7, now), []);
  });

  it("flagOn=true + risk='medium' → [] (medium-risk is governed by PR #403)", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "medium", 7, now), []);
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([mkParseErrorAttestation()], true, "medium", 7, now), []);
  });
});

describe("promotionGate Phase 4-d — deriveHighRiskPhase3aPrepHardBlockFailures (high-risk readiness)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("missing attestation: ONE failure mentioning high-risk promotion + high-risk env var", () => {
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([], true, "high", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /missing on high-risk promotion/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV));
    assert.match(out[0]!, /risk=high/);
  });

  it("parse_error attestation: ONE failure mentioning parse_error + high-risk env var + risk=high", () => {
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([mkParseErrorAttestation()], true, "high", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /could not be parsed/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV));
    assert.match(out[0]!, /risk=high/);
  });

  it("verdict='not_ready': ONE failure mentioning not_ready + risk=high", () => {
    const att = mkEvaluatedAttestation("2026-05-18T19:00:00.000Z", "not_ready", "cand-nr");
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /not_ready/);
    assert.match(out[0]!, /risk=high/);
    assert.match(out[0]!, /cand-nr/);
  });

  it("verdict='high_tier_ready': ONE failure", () => {
    const att = mkEvaluatedAttestation("2026-05-18T19:00:00.000Z", "high_tier_ready", "cand-htr");
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /high_tier_ready/);
    assert.match(out[0]!, /risk=high/);
  });

  it("fully_prepared + freshness disabled (maxAgeDays=null): [] (no readiness block)", () => {
    const att = mkEvaluatedAttestation("2026-05-18T19:00:00.000Z");
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", null, now), []);
  });
});

describe("promotionGate Phase 4-d — deriveHighRiskPhase3aPrepHardBlockFailures (high-risk freshness)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("stale fully_prepared attestation: ONE failure mentioning stale + risk=high + max-age env var", () => {
    const att = mkEvaluatedAttestation(new Date(now - 30 * DAY_MS).toISOString());
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", 14, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /phase3a_prep_attestation_stale/);
    assert.match(out[0]!, /risk=high/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV));
  });

  it("future-dated attestation: ONE failure mentioning future_dated + risk=high", () => {
    const att = mkEvaluatedAttestation(new Date(now + 5 * DAY_MS).toISOString());
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", 14, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /phase3a_prep_attestation_future_dated/);
    assert.match(out[0]!, /risk=high/);
  });

  it("fresh fully_prepared attestation (1ms inside window): []", () => {
    const att = mkEvaluatedAttestation(new Date(now - DAY_MS + 1).toISOString());
    assert.deepEqual(deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", 1, now), []);
  });

  it("no double-fire: not_ready + stale → ONLY the not_ready failure", () => {
    const stale = new Date(now - 365 * DAY_MS).toISOString();
    const att = mkEvaluatedAttestation(stale, "not_ready", "cand-nr-stale");
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", 7, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /not_ready/);
    assert.equal(/phase3a_prep_attestation_stale/.test(out[0]!), false);
  });

  it("no double-fire: parse_error + stale-flagged → ONLY parse_error", () => {
    const att = mkParseErrorAttestation();
    const out = deriveHighRiskPhase3aPrepHardBlockFailures([att], true, "high", 7, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /could not be parsed/);
  });

  it("freshness shares the SAME maxAgeDays threshold as low/medium (one window)", () => {
    const just1MsOlder = mkEvaluatedAttestation(new Date(now - DAY_MS - 1).toISOString());
    const just1MsNewer = mkEvaluatedAttestation(new Date(now - DAY_MS + 1).toISOString());
    assert.equal(
      deriveHighRiskPhase3aPrepHardBlockFailures([just1MsOlder], true, "high", 1, now).length,
      1,
      "1ms past the window must fire",
    );
    assert.deepEqual(
      deriveHighRiskPhase3aPrepHardBlockFailures([just1MsNewer], true, "high", 1, now),
      [],
      "1ms inside the window must NOT fire",
    );
  });
});

/* ─── 3. canPromote end-to-end ─────────────────────────────────────── */

describe("promotionGate Phase 4-d — canPromote end-to-end", () => {
  it("default off + missing attestation + ALLOW_HIGH_RISK=true: passes (legacy baseline preserved)", async () => {
    const prevHigh  = setHighFlag(undefined);
    const prevAllow = setAllowHigh("true");
    try {
      const r = await canPromote(mkRec({ risk: "high", evidence: "[]" }));
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      const phase4dLeakage = r.failures.some(f =>
        /missing on high-risk promotion/.test(f) ||
        /risk=high/.test(f),
      );
      assert.equal(phase4dLeakage, false,
        `Phase 4-d failure leaked when flag is off: ${r.failures.join(", ")}`);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  it("flag on + missing attestation: gate.ok=false; missing-on-high-risk failure (regardless of ALLOW_HIGH_RISK)", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    try {
      const r = await canPromote(mkRec({ risk: "high", evidence: "[]" }));
      assert.equal(r.ok, false);
      const missingFailures = r.failures.filter(f => /missing on high-risk promotion/.test(f));
      assert.equal(missingFailures.length, 1);
      assert.match(missingFailures[0]!, new RegExp(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV));
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  it("flag on + parse_error attestation: gate.ok=false", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    try {
      // Force a parse error by including an invalid marker payload (missing attestedAt).
      const evidence = JSON.stringify([
        PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify({ candidateId: "cand-pe", kind: "summarizationTemplate", preconditions: {} }),
      ]);
      const r = await canPromote(mkRec({ risk: "high", evidence }));
      assert.equal(r.ok, false);
      const parseFailures = r.failures.filter(f => /could not be parsed/.test(f) && /risk=high/.test(f));
      assert.equal(parseFailures.length, 1);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  it("flag on + verdict='not_ready': gate.ok=false; not_ready + risk=high failure", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    try {
      const cand = fullySatisfiedCandidate("cand-high-nr");
      const firstKey = LOCAL_PHASE3A_PREP_PRECONDITION_KEYS[0];
      (cand.preconditions[firstKey] as any).high.status = "unverified";
      const r = await canPromote(mkRec({ risk: "high", evidence: markerEvidence(cand) }));
      assert.equal(r.ok, false);
      const verdictFailures = r.failures.filter(f =>
        /readiness for candidate/.test(f) && /risk=high/.test(f),
      );
      assert.equal(verdictFailures.length, 1);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  it("flag on + freshness ENV=1 + stale fully_prepared: gate.ok=false; stale + risk=high failure", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    const prevMA    = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 2 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high-stale-2d", stale)) }),
      );
      assert.equal(r.ok, false);
      const staleFailures = r.failures.filter(f => /phase3a_prep_attestation_stale/.test(f));
      assert.equal(staleFailures.length, 1, `expected exactly 1 stale failure, got ${staleFailures.length}: ${r.failures.join(" | ")}`);
      assert.match(staleFailures[0]!, /risk=high/);
      assert.match(staleFailures[0]!, /cand-high-stale-2d/);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
      restoreMaxAge(prevMA);
    }
  });

  it("flag on + freshness ENV=1 + future-dated attestation: gate.ok=false; future_dated + risk=high failure", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    const prevMA    = setMaxAge("1");
    try {
      const future = new Date(Date.now() + 5 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high-future", future)) }),
      );
      assert.equal(r.ok, false);
      const futureFailures = r.failures.filter(f => /phase3a_prep_attestation_future_dated/.test(f));
      assert.equal(futureFailures.length, 1);
      assert.match(futureFailures[0]!, /risk=high/);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
      restoreMaxAge(prevMA);
    }
  });

  it("STACKING: flag on + fully_prepared + fresh + ALLOW_HIGH_RISK unset: gate.ok=false (still needs override)", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh(undefined);
    try {
      const fresh = new Date(Date.now()).toISOString();
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high-fresh", fresh)) }),
      );
      assert.equal(r.ok, false,
        `Phase 4-d must STACK on ALLOW_HIGH_RISK — attestation passing does NOT bypass the override: ${r.failures.join(", ")}`);
      const overrideFailures = r.failures.filter(f => /PROMOTION_GATE_ALLOW_HIGH_RISK/.test(f) && /explicit operator override/.test(f));
      assert.equal(overrideFailures.length, 1,
        `expected exactly 1 ALLOW_HIGH_RISK override failure, got: ${r.failures.join(" | ")}`);
      // No Phase 4-d attestation failure should fire — the attestation passed.
      const phase4dFailures = r.failures.filter(f =>
        /missing on high-risk promotion/.test(f) ||
        (/risk=high/.test(f) && new RegExp(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV).test(f)),
      );
      assert.equal(phase4dFailures.length, 0,
        `Phase 4-d failure leaked when attestation passed: ${r.failures.join(", ")}`);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  it("STACKING: flag on + fully_prepared + fresh + ALLOW_HIGH_RISK=true: gate.ok=true (both required, both satisfied)", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    try {
      const fresh = new Date(Date.now()).toISOString();
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high-pass", fresh)) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  it("flag off + missing attestation + ALLOW_HIGH_RISK=true: gate.ok=true (legacy behavior preserved)", async () => {
    const prevHigh  = setHighFlag(undefined);
    const prevAllow = setAllowHigh("true");
    try {
      const r = await canPromote(mkRec({ risk: "high", evidence: "[]" }));
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
    }
  });

  /* ─── 4. ISOLATION — flag on does NOT change low/medium-risk ──────── */

  it("flag on does NOT change low-risk behavior (low-risk branch untouched)", async () => {
    const prevHigh  = setHighFlag("true");
    const prevLow   = setLowFlag(undefined);
    const prevMA    = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-low-stale-high-env", stale)) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      const highLeakage = r.failures.some(f =>
        /high-risk promotion/.test(f) ||
        /risk=high/.test(f),
      );
      assert.equal(highLeakage, false);
    } finally {
      restoreHighFlag(prevHigh);
      restoreLowFlag(prevLow);
      restoreMaxAge(prevMA);
    }
  });

  it("flag on does NOT change medium-risk behavior (medium-risk branch untouched)", async () => {
    const prevHigh = setHighFlag("true");
    const prevMed  = setMediumFlag(undefined);
    const prevMA   = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate("cand-med-stale-high-env", stale)) }),
      );
      // Medium-risk + medium-risk flag OFF: existing golden-set policy governs.
      // No high-risk-branch failure should surface.
      const highLeakage = r.failures.some(f =>
        /high-risk promotion/.test(f) ||
        /risk=high/.test(f) ||
        new RegExp(PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV).test(f),
      );
      assert.equal(highLeakage, false,
        `Phase 4-d failure leaked into medium-risk path: ${r.failures.join(", ")}`);
    } finally {
      restoreHighFlag(prevHigh);
      restoreMediumFlag(prevMed);
      restoreMaxAge(prevMA);
    }
  });

  // Symmetric helper-purity assertions: low / medium derive helpers must
  // remain inert for high-risk inputs, regardless of flag state.
  it("low/medium derive helpers stay inert when risk='high' (no cross-tier leakage)", () => {
    const now = Date.parse("2026-05-18T19:00:00.000Z");
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(derivePhase3aPrepHardBlockFailures([att], true, "high", 7, now), []);
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "high", 7, now), []);
  });
});

/* ─── 5. Pin 7 / Pin 11 boundary topology ──────────────────────────── */

describe("promotionGate Phase 4-d — boundary topology (Pin 7 / Pin 11)", () => {
  it("high-risk hard block surfaces only via gate.ok=false + failures (no new fields)", async () => {
    const prevHigh  = setHighFlag("true");
    const prevAllow = setAllowHigh("true");
    const prevMA    = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-pin", stale)) }),
      );
      assert.equal(typeof r.ok, "boolean");
      assert.ok(Array.isArray(r.failures));
      assert.ok(Array.isArray(r.ranSets));
      const allowedKeys = new Set(["ok", "failures", "ranSets", "attestations", "softWarnings"]);
      for (const k of Object.keys(r)) {
        assert.equal(allowedKeys.has(k), true, `unexpected new field on PromotionResult: ${k}`);
      }
    } finally {
      restoreHighFlag(prevHigh);
      restoreAllowHigh(prevAllow);
      restoreMaxAge(prevMA);
    }
  });
});
