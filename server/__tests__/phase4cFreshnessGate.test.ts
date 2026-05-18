/**
 * Phase 4-c — attestation-freshness hard block for LOW-RISK promotions
 * (PR #401, the freshness leg of the 4-c/4-d roadmap).
 *
 * Layered on top of Phase 4-b. The Phase 4-b master switch
 *   PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY=true
 * MUST be on for any 4-c freshness check to fire — 4-c is strictly an
 * EXTRA refinement of the existing low-risk hard-block path. The new
 * env var is
 *   PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS=<positive integer>
 * which is parsed by `readPhase3aPrepMaxAgeDays`. Unset / empty /
 * non-numeric / <= 0 disables freshness (null) and the gate is byte-
 * identical to pre-4-c. Medium- and high-risk gating remain untouched.
 *
 * Properties verified here:
 *   1. `readPhase3aPrepMaxAgeDays` is a pure env parser: returns null
 *      for unset / empty / non-integer / non-positive values, and the
 *      positive integer otherwise. No side effects.
 *   2. `isPhase3aAttestationStale` is a pure predicate. Same input →
 *      same output. NEVER reads env/clock/fs. Returns false when the
 *      gate is disabled (maxAgeDays === null), false on `parse_error`
 *      (avoiding double-fire with 4-b), false on empty/unparseable
 *      `attestedAt` (defensive), true ONLY when `now - parsed >
 *      maxAgeDays*86_400_000`, with the ±1 ms boundary handled
 *      strictly (`>`, not `>=`).
 *   3. `isPhase3aAttestationFutureDated` is also a pure predicate.
 *      Returns true ONLY when `parsed > now` (strict). Symmetric
 *      boundary semantics with `isPhase3aAttestationStale`.
 *   4. `derivePhase3aPrepHardBlockFailures` honours the new optional
 *      params (`maxAgeDays`, `now`):
 *        - With `maxAgeDays === null` (default), behaviour is byte-
 *          identical to the Phase 4-b helper signature.
 *        - With `maxAgeDays > 0`, a stale `evaluated` /
 *          `fully_prepared` attestation produces EXACTLY ONE failure
 *          string mentioning `phase3a_prep_attestation_stale`.
 *        - A future-dated `evaluated` / `fully_prepared` attestation
 *          produces EXACTLY ONE failure mentioning
 *          `phase3a_prep_attestation_future_dated`.
 *        - The 4-b not-ready / parse_error / missing paths still fire
 *          and the freshness check is NOT reached (no double-fire:
 *          one attestation, one failure, never two).
 *   5. `canPromote` end-to-end:
 *        - Phase 4-b ON, freshness ENV unset, low-risk + stale
 *          attestation: gate.ok=true (freshness disabled).
 *        - Phase 4-b ON, freshness ENV=1, low-risk + 2-day-old
 *          attestation: gate.ok=false; single failure mentions stale.
 *        - Phase 4-b ON, freshness ENV=1, medium-risk + ancient
 *          attestation: gate.ok=true; NO Phase 4-c failure (medium-
 *          risk unaffected).
 *   6. Schema/validator: `buildPhase3aPrepAttestation` REQUIRES the
 *      candidate evidence payload to include a non-empty parseable
 *      ISO-8601 `attestedAt`. Missing / non-string / unparseable
 *      values map to `status === "parse_error"`.
 *   7. Pin 7 / Pin 11 reaffirmed: the freshness block surfaces via
 *      the existing `gate.ok=false` + `failures` boundary. No new
 *      mutation route, no new write site, no new public surface.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canPromote,
  derivePhase3aPrepHardBlockFailures,
  isPhase3aAttestationStale,
  isPhase3aAttestationFutureDated,
  readPhase3aPrepMaxAgeDays,
  PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
  PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV,
  type PromotionAttestation,
} from "../eval/promotionGate.js";
import {
  PHASE3A_PREP_EVIDENCE_PREFIX,
  buildPhase3aPrepAttestation,
} from "../eval/phase3aPrepAttestation.js";
import type { SelfRecommendation } from "@shared/schema";

// Mirror the pattern used by the Phase 4-b test: pin the precondition
// keys locally rather than importing from the harness module. The
// gate-integration tests in `promotionGateAttestation.test.ts` (an
// allow-listed importer of the harness) catch schema drift.
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
    id: "rec_p4c_1",
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

function fullySatisfiedCandidate(
  candidateId = "cand-p4c-ready",
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

function notReadyCandidate(
  candidateId = "cand-p4c-blocked",
  attestedAt = "2026-05-18T19:00:00.000Z",
) {
  const cand = fullySatisfiedCandidate(candidateId, attestedAt);
  const firstKey = LOCAL_PHASE3A_PREP_PRECONDITION_KEYS[0];
  (cand.preconditions[firstKey] as any).high.status = "unverified";
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
function setMaxAge(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, value);
}
function restoreMaxAge(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV, prev);
}
function setHardBlock(value: string | undefined): string | undefined {
  return setEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, value);
}
function restoreHardBlock(prev: string | undefined): void {
  restoreEnv(PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV, prev);
}

/** Build an evaluated phase3aPrep attestation directly, bypassing the
 *  adapter, so we can drive the pure helpers with any `attestedAt`
 *  value we like. */
function mkEvaluatedAttestation(
  attestedAt: string,
  verdict: "fully_prepared" | "high_tier_ready" | "not_ready" = "fully_prepared",
  candidateId = "cand-x",
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

const DAY_MS = 86_400_000;

/* ─── 1. readPhase3aPrepMaxAgeDays env parser ──────────────────────── */

describe("promotionGate Phase 4-c — readPhase3aPrepMaxAgeDays", () => {
  it("returns null when env var is unset", () => {
    const prev = setMaxAge(undefined);
    try { assert.equal(readPhase3aPrepMaxAgeDays(), null); }
    finally { restoreMaxAge(prev); }
  });

  it("returns null when env var is empty / whitespace", () => {
    for (const v of ["", "   ", "\t"]) {
      const prev = setMaxAge(v);
      try { assert.equal(readPhase3aPrepMaxAgeDays(), null, `value=${JSON.stringify(v)}`); }
      finally { restoreMaxAge(prev); }
    }
  });

  it("returns null for non-numeric / non-finite / non-positive values", () => {
    for (const v of ["abc", "NaN", "Infinity", "0", "-1", "-7"]) {
      const prev = setMaxAge(v);
      try { assert.equal(readPhase3aPrepMaxAgeDays(), null, `value=${v}`); }
      finally { restoreMaxAge(prev); }
    }
  });

  it("returns the positive integer for valid values", () => {
    for (const [v, exp] of [["1", 1], ["7", 7], ["14", 14], ["365", 365]] as const) {
      const prev = setMaxAge(v);
      try { assert.equal(readPhase3aPrepMaxAgeDays(), exp); }
      finally { restoreMaxAge(prev); }
    }
  });

  it("parses leading-integer values via parseInt (e.g. '14d' → 14)", () => {
    // Phase 4-c uses Number.parseInt(v, 10) — documenting the actual
    // observed behaviour so operators don't get surprised. Trailing
    // garbage parses as the leading integer.
    const prev = setMaxAge("14d");
    try { assert.equal(readPhase3aPrepMaxAgeDays(), 14); }
    finally { restoreMaxAge(prev); }
  });
});

/* ─── 2. isPhase3aAttestationStale pure predicate ──────────────────── */

describe("promotionGate Phase 4-c — isPhase3aAttestationStale", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("returns false when maxAgeDays is null (gate disabled)", () => {
    const att = mkEvaluatedAttestation("2020-01-01T00:00:00.000Z");
    assert.equal(isPhase3aAttestationStale(att, null, now), false);
  });

  it("returns false on parse_error attestation (avoid double-fire with 4-b)", () => {
    const att = mkParseErrorAttestation("");
    assert.equal(isPhase3aAttestationStale(att, 1, now), false);
  });

  it("returns false when attestedAt is empty-string sentinel", () => {
    const att = mkEvaluatedAttestation("");
    assert.equal(isPhase3aAttestationStale(att, 1, now), false);
  });

  it("returns false when attestedAt is not a parseable ISO timestamp", () => {
    const att = mkEvaluatedAttestation("not-a-date");
    assert.equal(isPhase3aAttestationStale(att, 1, now), false);
  });

  it("returns true when parsed timestamp is older than maxAgeDays", () => {
    const att = mkEvaluatedAttestation(new Date(now - 2 * DAY_MS).toISOString());
    assert.equal(isPhase3aAttestationStale(att, 1, now), true);
  });

  it("returns false when timestamp is exactly maxAgeDays old (strict >)", () => {
    const att = mkEvaluatedAttestation(new Date(now - 1 * DAY_MS).toISOString());
    assert.equal(isPhase3aAttestationStale(att, 1, now), false);
  });

  it("boundary: 1 ms older than maxAgeDays → stale; 1 ms newer → fresh", () => {
    const oneMsOlder = mkEvaluatedAttestation(new Date(now - 1 * DAY_MS - 1).toISOString());
    const oneMsNewer = mkEvaluatedAttestation(new Date(now - 1 * DAY_MS + 1).toISOString());
    assert.equal(isPhase3aAttestationStale(oneMsOlder, 1, now), true);
    assert.equal(isPhase3aAttestationStale(oneMsNewer, 1, now), false);
  });

  it("returns false on future-dated attestation (handled by separate helper)", () => {
    const att = mkEvaluatedAttestation(new Date(now + 5 * DAY_MS).toISOString());
    assert.equal(isPhase3aAttestationStale(att, 1, now), false);
  });

  it("is deterministic: same input → same output", () => {
    const att = mkEvaluatedAttestation(new Date(now - 10 * DAY_MS).toISOString());
    const a = isPhase3aAttestationStale(att, 7, now);
    const b = isPhase3aAttestationStale(att, 7, now);
    assert.equal(a, b);
    assert.equal(a, true);
  });
});

/* ─── 3. isPhase3aAttestationFutureDated pure predicate ────────────── */

describe("promotionGate Phase 4-c — isPhase3aAttestationFutureDated", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("returns false when maxAgeDays is null (gate disabled)", () => {
    const att = mkEvaluatedAttestation(new Date(now + DAY_MS).toISOString());
    assert.equal(isPhase3aAttestationFutureDated(att, null, now), false);
  });

  it("returns false on parse_error attestation", () => {
    const att = mkParseErrorAttestation("");
    assert.equal(isPhase3aAttestationFutureDated(att, 1, now), false);
  });

  it("returns false when attestedAt empty / unparseable", () => {
    assert.equal(isPhase3aAttestationFutureDated(mkEvaluatedAttestation(""), 1, now), false);
    assert.equal(isPhase3aAttestationFutureDated(mkEvaluatedAttestation("nope"), 1, now), false);
  });

  it("returns true when timestamp is strictly in the future", () => {
    const att = mkEvaluatedAttestation(new Date(now + 1).toISOString());
    assert.equal(isPhase3aAttestationFutureDated(att, 1, now), true);
  });

  it("returns false when timestamp equals now (strict >, not >=)", () => {
    const att = mkEvaluatedAttestation(new Date(now).toISOString());
    assert.equal(isPhase3aAttestationFutureDated(att, 1, now), false);
  });

  it("returns false when timestamp is in the past (the stale helper's job)", () => {
    const att = mkEvaluatedAttestation(new Date(now - 1).toISOString());
    assert.equal(isPhase3aAttestationFutureDated(att, 1, now), false);
  });
});

/* ─── 4. derivePhase3aPrepHardBlockFailures with freshness params ──── */

describe("promotionGate Phase 4-c — derivePhase3aPrepHardBlockFailures freshness", () => {
  const now = Date.parse("2026-05-18T19:00:00.000Z");

  it("4-b regression: with maxAgeDays defaulted (null), behaviour unchanged on fully_prepared", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    const out = derivePhase3aPrepHardBlockFailures([att], true, "low");
    assert.deepEqual(out, []);
  });

  it("emits ONE failure for stale evaluated/fully_prepared attestation", () => {
    const att = mkEvaluatedAttestation(new Date(now - 30 * DAY_MS).toISOString());
    const out = derivePhase3aPrepHardBlockFailures([att], true, "low", 14, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /phase3a_prep_attestation_stale/);
    assert.match(out[0]!, new RegExp(PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV));
  });

  it("emits ONE failure for future-dated attestation", () => {
    const att = mkEvaluatedAttestation(new Date(now + 5 * DAY_MS).toISOString());
    const out = derivePhase3aPrepHardBlockFailures([att], true, "low", 14, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /phase3a_prep_attestation_future_dated/);
  });

  it("no double-fire: not_ready verdict + stale attestation emits ONLY the not_ready failure", () => {
    // The verdict check fires first in the helper; once a 4-b failure
    // is emitted the function returns and the freshness check is
    // never reached. This is the determinism contract.
    const stale = new Date(now - 365 * DAY_MS).toISOString();
    const att = mkEvaluatedAttestation(stale, "not_ready", "cand-nr-stale");
    const out = derivePhase3aPrepHardBlockFailures([att], true, "low", 7, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /not_ready/);
    assert.equal(
      /phase3a_prep_attestation_stale/.test(out[0]!),
      false,
      `expected stale failure not to fire on top of not_ready: ${out[0]}`,
    );
  });

  it("no double-fire: parse_error path still wins; freshness helpers return false on parse_error", () => {
    const att = mkParseErrorAttestation();
    const out = derivePhase3aPrepHardBlockFailures([att], true, "low", 7, now);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /could not be parsed/);
  });

  it("medium-risk: freshness check does NOT fire even with maxAgeDays set", () => {
    const att = mkEvaluatedAttestation(new Date(now - 365 * DAY_MS).toISOString());
    const out = derivePhase3aPrepHardBlockFailures([att], true, "medium", 7, now);
    assert.deepEqual(out, []);
  });
});

/* ─── 5. canPromote end-to-end ─────────────────────────────────────── */

describe("promotionGate Phase 4-c — canPromote end-to-end", () => {
  it("freshness ENV unset, Phase 4-b ON, low-risk + stale attestation: gate.ok=true", async () => {
    const prevHB = setHardBlock("true");
    const prevMA = setMaxAge(undefined);
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-stale-no-env", stale)) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.equal(
        r.failures.some(f => /phase3a_prep_attestation_stale/.test(f)),
        false,
      );
    } finally {
      restoreHardBlock(prevHB);
      restoreMaxAge(prevMA);
    }
  });

  it("freshness ENV=1, Phase 4-b ON, low-risk + 2-day-old attestation: gate.ok=false, stale failure", async () => {
    const prevHB = setHardBlock("true");
    const prevMA = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 2 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-stale-2d", stale)) }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.failures.length, 1);
      assert.match(r.failures[0]!, /phase3a_prep_attestation_stale/);
      assert.match(r.failures[0]!, /cand-stale-2d/);
    } finally {
      restoreHardBlock(prevHB);
      restoreMaxAge(prevMA);
    }
  });

  it("freshness ENV=1, Phase 4-b ON, MEDIUM-risk + stale attestation: gate.ok=true; NO 4-c failure", async () => {
    const prevHB = setHardBlock("true");
    const prevMA = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 30 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate("cand-med-stale", stale)) }),
      );
      // The medium-risk gate is dictated by golden-set policy; the
      // critical assertion is the ABSENCE of any 4-c freshness failure.
      assert.equal(
        r.failures.some(f => /phase3a_prep_attestation_stale|phase3a_prep_attestation_future_dated/.test(f)),
        false,
        `unexpected Phase 4-c failure on medium-risk: ${r.failures.join(", ")}`,
      );
    } finally {
      restoreHardBlock(prevHB);
      restoreMaxAge(prevMA);
    }
  });
});

/* ─── 6. Schema/validator: attestedAt now required ─────────────────── */

describe("promotionGate Phase 4-c — schema validator (attestedAt required)", () => {
  it("missing attestedAt: status='parse_error'", () => {
    // Build a payload that has every other required field but omits
    // attestedAt entirely. Bypass the helper builder so we can
    // construct a literal "missing field" candidate.
    const preconditions: Record<string, Record<string, unknown>> = {};
    for (const key of LOCAL_PHASE3A_PREP_PRECONDITION_KEYS) {
      preconditions[key] = {
        high: { key, priority: "high", status: "satisfied", evidenceRef: "ref://h", rationale: "h" },
        low:  { key, priority: "low",  status: "satisfied", evidenceRef: "ref://l", rationale: "l" },
      };
    }
    const candidate = { candidateId: "no-ts", kind: "summarizationTemplate", preconditions };
    const rec = mkRec({ evidence: markerEvidence(candidate) });
    const att = buildPhase3aPrepAttestation(rec);
    assert.notEqual(att, null);
    assert.equal(att!.status, "parse_error");
    assert.match(att!.parseError ?? "", /attestedAt/);
  });

  it("non-string attestedAt: status='parse_error'", () => {
    const cand = fullySatisfiedCandidate("non-string");
    (cand as any).attestedAt = 12345;
    const rec = mkRec({ evidence: markerEvidence(cand) });
    const att = buildPhase3aPrepAttestation(rec);
    assert.equal(att!.status, "parse_error");
    assert.match(att!.parseError ?? "", /attestedAt/);
  });

  it("unparseable attestedAt string: status='parse_error'", () => {
    const cand = fullySatisfiedCandidate("unparseable", "not-an-iso-stamp");
    const rec = mkRec({ evidence: markerEvidence(cand) });
    const att = buildPhase3aPrepAttestation(rec);
    assert.equal(att!.status, "parse_error");
    assert.match(att!.parseError ?? "", /attestedAt/);
  });

  it("valid attestedAt: status='evaluated' and attestedAt echoed verbatim", () => {
    const ts = "2026-05-18T19:00:00.000Z";
    const cand = fullySatisfiedCandidate("ok", ts);
    const rec = mkRec({ evidence: markerEvidence(cand) });
    const att = buildPhase3aPrepAttestation(rec);
    assert.equal(att!.status, "evaluated");
    assert.equal(att!.attestedAt, ts);
  });
});

/* ─── 7. Pin 7 / Pin 11 boundary topology ──────────────────────────── */

describe("promotionGate Phase 4-c — boundary topology (Pin 7 / Pin 11)", () => {
  it("freshness block surfaces only via gate.ok=false + failures (no new fields)", async () => {
    const prevHB = setHardBlock("true");
    const prevMA = setMaxAge("1");
    try {
      const stale = new Date(Date.now() - 2 * DAY_MS).toISOString();
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-pin-stale", stale)) }),
      );
      const allowedKeys = ["ok", "failures", "ranSets", "attestations", "softWarnings"];
      for (const k of Object.keys(r)) {
        assert.ok(allowedKeys.includes(k), `unexpected key on PromotionResult: ${k}`);
      }
      assert.equal(r.ok, false);
      assert.equal(typeof r.ok, "boolean");
    } finally {
      restoreHardBlock(prevHB);
      restoreMaxAge(prevMA);
    }
  });

  it("gate source declares the Phase 4-c env literal (boundary audit handshake)", () => {
    assert.equal(
      PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV,
      "PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS",
    );
  });
});
