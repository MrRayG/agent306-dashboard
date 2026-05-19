/**
 * Phase 4-c part 2 (PR #403) — attestation-readiness + attestation-freshness
 * hard block for MEDIUM-RISK promotions.
 *
 * Mirrors `server/__tests__/phase4cFreshnessGate.test.ts` (the PR #401
 * low-risk variant). The new env var is
 *
 *   PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY=true
 *
 * which gates a NEW medium-risk branch in `canPromote`. When the flag
 * is on AND the rec is `risk === "medium"`, the gate enforces the
 * identical missing / parse_error / not-`fully_prepared` / stale /
 * future-dated checks the low-risk branch enforces under Phase 4-b
 * (#400) + 4-c freshness (#401). The freshness threshold env var
 * (`PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS`) is SHARED with the
 * low-risk branch — one window governs both tiers; this PR does NOT
 * add a second freshness env var.
 *
 * Properties verified here:
 *   1. `readPhase3aPrepBlockMediumRiskFlag` is a pure env parser; only
 *      a case-insensitive literal `"true"` enables. Any other value
 *      (including unset / empty / `"1"` / `"yes"`) disables.
 *   2. `deriveMediumRiskPhase3aPrepHardBlockFailures` is pure:
 *        - returns [] when flagOn === false (regardless of risk / freshness)
 *        - returns [] when risk !== "medium" (low and high untouched)
 *        - emits ONE missing-attestation failure when there is no
 *          phase3aPrep attestation
 *        - emits ONE parse_error failure when status='parse_error'
 *        - emits ONE not-fully_prepared failure when verdict is
 *          high_tier_ready / not_ready
 *        - emits ONE phase3a_prep_attestation_stale failure when the
 *          shared freshness env is set and the attestation is older
 *          than the threshold
 *        - emits ONE phase3a_prep_attestation_future_dated failure
 *          when attestedAt > now
 *        - never double-fires (one attestation → at most one failure)
 *        - all failure strings include the medium-risk env var name
 *          and either "risk=medium" or "medium-risk promotion"
 *   3. `canPromote` end-to-end:
 *        - new env unset, medium-risk + stale: gate.ok depends on
 *          golden sets only (4-c part 2 inert)
 *        - new env true, freshness ENV=1, medium-risk + 2-day-old
 *          attestation: gate.ok=false; failure mentions stale + medium
 *        - new env true, medium-risk + missing attestation: gate.ok=false;
 *          failure mentions missing on medium-risk promotion
 *        - new env true, medium-risk + verdict='not_ready': gate.ok=false
 *        - new env true, LOW-risk + stale: medium-risk branch does NOT
 *          fire (the existing low-risk branch's own logic still applies)
 *        - new env true + freshness ENV=1, HIGH-RISK: high-risk path
 *          is UNTOUCHED — neither the medium-risk branch nor any 4-c
 *          freshness failure surfaces
 *   4. Pin 7 / Pin 11 reaffirmed: the medium-risk block surfaces via
 *      the existing `gate.ok=false` + `failures` boundary. No new
 *      mutation route, no new write site, no new public surface.
 *   5. Track A isolation: this file does NOT import the harness module
 *      `server/experiments/phase3aPrepHarness`. The precondition keys
 *      and harness version are inlined as local mirror constants,
 *      matching the pattern in `phase4cFreshnessGate.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canPromote,
  deriveMediumRiskPhase3aPrepHardBlockFailures,
  readPhase3aPrepBlockMediumRiskFlag,
  PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
  type PromotionAttestation,
} from "../eval/promotionGate.js";
import { PHASE3A_PREP_EVIDENCE_PREFIX } from "../eval/phase3aPrepAttestation.js";
import type { SelfRecommendation } from "@shared/schema";

// Local mirror constants (Track A isolation contract — do NOT import
// from server/experiments/phase3aPrepHarness here; the gate-integration
// tests in `phase3aPrepAttestation.test.ts` catch schema drift).
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

/* ─── Helpers ──────────────────────────────────────────────────────── */

function mkRec(overrides: Partial<SelfRecommendation> = {}): SelfRecommendation {
  return {
    id: "rec_p4c_pt2",
    category: "prompt",
    risk: "medium",
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
  candidateId = "cand-p4c-pt2-ready",
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

function mkEvaluatedAttestation(
  attestedAt: string,
  verdict: "fully_prepared" | "high_tier_ready" | "not_ready" = "fully_prepared",
  candidateId = "cand-medium",
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

/* ─── 1. readPhase3aPrepBlockMediumRiskFlag env parser ─────────────── */

describe("promotionGate Phase 4-c pt2 — readPhase3aPrepBlockMediumRiskFlag", () => {
  it("returns false when env is unset", () => {
    const prev = setMediumFlag(undefined);
    try { assert.equal(readPhase3aPrepBlockMediumRiskFlag(), false); }
    finally { restoreMediumFlag(prev); }
  });

  it("returns true only for literal 'true' (case-insensitive)", () => {
    for (const v of ["true", "True", "TRUE", "tRuE"]) {
      const prev = setMediumFlag(v);
      try { assert.equal(readPhase3aPrepBlockMediumRiskFlag(), true, `value=${v}`); }
      finally { restoreMediumFlag(prev); }
    }
  });

  it("returns false for any other value", () => {
    for (const v of ["", " ", "1", "yes", "on", "TrueButTrailing", "false", "0"]) {
      const prev = setMediumFlag(v);
      try { assert.equal(readPhase3aPrepBlockMediumRiskFlag(), false, `value=${JSON.stringify(v)}`); }
      finally { restoreMediumFlag(prev); }
    }
  });

  it("is independent of the low-risk flag (enabling one does not enable the other)", () => {
    const prevMed = setMediumFlag(undefined);
    const prevLow = setLowFlag("true");
    try {
      assert.equal(readPhase3aPrepBlockMediumRiskFlag(), false);
    } finally {
      restoreMediumFlag(prevMed);
      restoreLowFlag(prevLow);
    }
  });
});

/* ─── 2. deriveMediumRiskPhase3aPrepHardBlockFailures — pure ───────── */

describe("promotionGate Phase 4-c pt2 — deriveMediumRiskPhase3aPrepHardBlockFailures (flag off)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("flagOn=false → [] regardless of risk / freshness / attestation state", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], false, "medium", 7, now), []);
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], false, "low", 7, now), []);
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], false, "high", 7, now), []);
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([], false, "medium", 7, now), []);
  });
});

describe("promotionGate Phase 4-c pt2 — deriveMediumRiskPhase3aPrepHardBlockFailures (risk gate)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("flagOn=true + risk='low' → [] (low-risk is governed by the existing PR #400/401 helper)", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "low", 7, now), []);
    // Also confirm even with a missing attestation, low is untouched.
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([], true, "low", 7, now), []);
  });

  it("flagOn=true + risk='high' → [] (high-risk is untouched by Phase 4-c part 2)", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "high", 7, now), []);
    // Also confirm with parse_error attestation — high stays untouched.
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([mkParseErrorAttestation()], true, "high", 7, now), []);
  });
});

describe("promotionGate Phase 4-c pt2 — deriveMediumRiskPhase3aPrepHardBlockFailures (medium-risk readiness)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("missing attestation: ONE failure mentioning medium-risk promotion + medium-risk env var", () => {
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([], true, "medium", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /missing on medium-risk promotion/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV));
  });

  it("parse_error attestation: ONE failure mentioning parse_error + medium-risk env var", () => {
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([mkParseErrorAttestation()], true, "medium", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /could not be parsed/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV));
  });

  it("verdict='not_ready': ONE failure mentioning not_ready + risk=medium", () => {
    const att = mkEvaluatedAttestation("2026-05-18T19:00:00.000Z", "not_ready", "cand-nr");
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /not_ready/);
    assert.match(out[0]!, /risk=medium/);
    assert.match(out[0]!, /cand-nr/);
  });

  it("verdict='high_tier_ready': ONE failure", () => {
    const att = mkEvaluatedAttestation("2026-05-18T19:00:00.000Z", "high_tier_ready", "cand-htr");
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", null, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /high_tier_ready/);
  });

  it("fully_prepared + freshness disabled (maxAgeDays=null): [] (no readiness block)", () => {
    const att = mkEvaluatedAttestation("2026-05-18T19:00:00.000Z");
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", null, now), []);
  });
});

describe("promotionGate Phase 4-c pt2 — deriveMediumRiskPhase3aPrepHardBlockFailures (medium-risk freshness)", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("stale fully_prepared attestation: ONE failure mentioning stale + risk=medium + max-age env var", () => {
    const att = mkEvaluatedAttestation(new Date(now - 30 * DAY_MS).toISOString());
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", 14, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /phase3a_prep_attestation_stale/);
    assert.match(out[0]!, /risk=medium/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV));
  });

  it("future-dated attestation: ONE failure mentioning future_dated + risk=medium", () => {
    const att = mkEvaluatedAttestation(new Date(now + 5 * DAY_MS).toISOString());
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", 14, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /phase3a_prep_attestation_future_dated/);
    assert.match(out[0]!, /risk=medium/);
  });

  it("fresh fully_prepared attestation (1ms inside window): []", () => {
    const att = mkEvaluatedAttestation(new Date(now - DAY_MS + 1).toISOString());
    assert.deepEqual(deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", 1, now), []);
  });

  it("no double-fire: not_ready + stale → ONLY the not_ready failure (verdict check runs first)", () => {
    const stale = new Date(now - 365 * DAY_MS).toISOString();
    const att = mkEvaluatedAttestation(stale, "not_ready", "cand-nr-stale");
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", 7, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /not_ready/);
    assert.equal(/phase3a_prep_attestation_stale/.test(out[0]!), false);
  });

  it("no double-fire: parse_error + stale-flagged → ONLY parse_error", () => {
    const att = mkParseErrorAttestation();
    const out = deriveMediumRiskPhase3aPrepHardBlockFailures([att], true, "medium", 7, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /could not be parsed/);
  });

  it("freshness shares the SAME maxAgeDays threshold as low-risk (one window)", () => {
    // The threshold env (PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS) is
    // passed in as `maxAgeDays`. The medium-risk helper enforces that
    // threshold identically — no second window. We exercise the same
    // boundary cases as the low-risk freshness suite to pin parity.
    const just1MsOlder = mkEvaluatedAttestation(new Date(now - DAY_MS - 1).toISOString());
    const just1MsNewer = mkEvaluatedAttestation(new Date(now - DAY_MS + 1).toISOString());
    assert.equal(
      deriveMediumRiskPhase3aPrepHardBlockFailures([just1MsOlder], true, "medium", 1, now).length,
      1,
      "1ms past the window must fire",
    );
    assert.deepEqual(
      deriveMediumRiskPhase3aPrepHardBlockFailures([just1MsNewer], true, "medium", 1, now),
      [],
      "1ms inside the window must NOT fire",
    );
  });
});

/* ─── 3. canPromote end-to-end ─────────────────────────────────────── */

describe("promotionGate Phase 4-c pt2 — canPromote end-to-end", () => {
  it("medium-risk env unset (default): medium-risk + stale → no Phase 4-c pt2 failure", async () => {
    const prevMed = setMediumFlag(undefined);
    const prevLow = setLowFlag("true");
    const prevMA  = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate("cand-med-default", stale)) }),
      );
      // The legacy medium-risk verdict is owned by the golden-set
      // policy below; the assertion here is just the ABSENCE of any
      // Phase 4-c part 2 hard-block failure when the new env is unset.
      const has4cPt2 = r.failures.some(f =>
        /missing on medium-risk promotion/.test(f) ||
        /risk=medium/.test(f),
      );
      assert.equal(has4cPt2, false,
        `unexpected Phase 4-c pt2 failure when env unset: ${r.failures.join(", ")}`);
    } finally {
      restoreMediumFlag(prevMed);
      restoreLowFlag(prevLow);
      restoreMaxAge(prevMA);
    }
  });

  it("medium-risk env true + freshness ENV=1 + medium-risk + 2-day-old: gate.ok=false; stale + risk=medium failure", async () => {
    const prevMed = setMediumFlag("true");
    const prevMA  = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 2 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate("cand-med-stale-2d", stale)) }),
      );
      assert.equal(r.ok, false);
      const staleFailures = r.failures.filter(f => /phase3a_prep_attestation_stale/.test(f));
      assert.equal(staleFailures.length, 1, `expected exactly 1 stale failure, got ${staleFailures.length}: ${r.failures.join(" | ")}`);
      assert.match(staleFailures[0]!, /risk=medium/);
      assert.match(staleFailures[0]!, /cand-med-stale-2d/);
    } finally {
      restoreMediumFlag(prevMed);
      restoreMaxAge(prevMA);
    }
  });

  it("medium-risk env true + missing attestation: gate.ok=false; missing-on-medium-risk failure", async () => {
    const prevMed = setMediumFlag("true");
    try {
      const r = await canPromote(mkRec({ risk: "medium", evidence: "[]" }));
      assert.equal(r.ok, false);
      const missingFailures = r.failures.filter(f => /missing on medium-risk promotion/.test(f));
      assert.equal(missingFailures.length, 1);
      assert.match(missingFailures[0]!, new RegExp(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV));
    } finally {
      restoreMediumFlag(prevMed);
    }
  });

  it("medium-risk env true + verdict='not_ready': gate.ok=false; not_ready + risk=medium failure", async () => {
    const prevMed = setMediumFlag("true");
    try {
      // Build a candidate with one high-tier slot unverified → verdict='not_ready'.
      const cand = fullySatisfiedCandidate("cand-med-nr");
      const firstKey = LOCAL_PHASE3A_PREP_PRECONDITION_KEYS[0];
      (cand.preconditions[firstKey] as any).high.status = "unverified";
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(cand) }),
      );
      assert.equal(r.ok, false);
      const verdictFailures = r.failures.filter(f =>
        /readiness for candidate/.test(f) && /risk=medium/.test(f),
      );
      assert.equal(verdictFailures.length, 1);
    } finally {
      restoreMediumFlag(prevMed);
    }
  });

  it("medium-risk env true + freshness ENV=1 + LOW-risk + stale: medium-risk branch does NOT fire (low branch's own logic governs)", async () => {
    const prevMed = setMediumFlag("true");
    const prevLow = setLowFlag(undefined); // low-risk hard block OFF
    const prevMA  = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-low-stale-med-env", stale)) }),
      );
      // Low-risk + low-risk hard block OFF: legacy path returns ok=true.
      // The medium-risk branch must NOT have fired (no risk=medium failure).
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      const mediumLeakage = r.failures.some(f => /risk=medium/.test(f) || /medium-risk promotion/.test(f));
      assert.equal(mediumLeakage, false);
    } finally {
      restoreMediumFlag(prevMed);
      restoreLowFlag(prevLow);
      restoreMaxAge(prevMA);
    }
  });

  /* ─── 4. HIGH-RISK UNTOUCHED — explicit assertion ────────────────────── */

  it("medium-risk env true + freshness ENV=1 + HIGH-risk: medium-risk branch + 4-c freshness do NOT extend to high-risk", async () => {
    const prevMed = setMediumFlag("true");
    const prevMA  = setMaxAge("1");
    // Force PROMOTION_GATE_ALLOW_HIGH_RISK so we can isolate the
    // 4-c-pt2 leak question from the high-risk override gate. With the
    // override on AND no golden-set failures, the legacy high-risk path
    // returns ok=true. The assertion is: no medium-risk-branch failure
    // surfaces, and no Phase 4-c freshness failure surfaces.
    const prevAllow = setEnv("PROMOTION_GATE_ALLOW_HIGH_RISK", "true");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high-stale-med-env", stale)) }),
      );
      const mediumLeakage = r.failures.some(f =>
        /medium-risk promotion/.test(f) ||
        /risk=medium/.test(f) ||
        new RegExp(PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV).test(f),
      );
      assert.equal(mediumLeakage, false,
        `Phase 4-c pt2 medium-risk failure leaked into high-risk path: ${r.failures.join(", ")}`);
      // And the existing 4-c freshness helper must also not fire — its
      // helper guards `risk === "low"` so high-risk should see no
      // freshness failure either.
      const freshnessLeakage = r.failures.some(f =>
        /phase3a_prep_attestation_stale/.test(f) ||
        /phase3a_prep_attestation_future_dated/.test(f),
      );
      assert.equal(freshnessLeakage, false,
        `Phase 4-c freshness failure leaked into high-risk path: ${r.failures.join(", ")}`);
    } finally {
      restoreMediumFlag(prevMed);
      restoreMaxAge(prevMA);
      restoreEnv("PROMOTION_GATE_ALLOW_HIGH_RISK", prevAllow);
    }
  });
});

/* ─── 5. Pin 7 / Pin 11 boundary topology ──────────────────────────── */

describe("promotionGate Phase 4-c pt2 — boundary topology (Pin 7 / Pin 11)", () => {
  it("medium-risk hard block surfaces only via gate.ok=false + failures (no new fields)", async () => {
    const prevMed = setMediumFlag("true");
    const prevMA  = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate("cand-pin", stale)) }),
      );
      // The result shape is the same PromotionResult contract.
      assert.equal(typeof r.ok, "boolean");
      assert.ok(Array.isArray(r.failures));
      assert.ok(Array.isArray(r.ranSets));
      // No new fields beyond the existing PromotionResult contract.
      const allowedKeys = new Set(["ok", "failures", "ranSets", "attestations", "softWarnings"]);
      for (const k of Object.keys(r)) {
        assert.equal(allowedKeys.has(k), true, `unexpected new field on PromotionResult: ${k}`);
      }
    } finally {
      restoreMediumFlag(prevMed);
      restoreMaxAge(prevMA);
    }
  });
});
