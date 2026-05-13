/**
 * Phase 4-a — operator-gated phase3aPrep soft warning channel.
 *
 * The Phase 4-a soft warning channel is an OPERATOR-GATED, ADVISORY-ONLY
 * extension of the Phase 3a/3b attestation telemetry. It is wholly
 * controlled by the env flag `PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY`
 * and MUST be byte-identical to pre-Phase-4-a behavior when the flag is
 * off (the default).
 *
 * Properties verified here:
 *   1. Flag OFF (default): every return path of `canPromote` emits
 *      `softWarnings: []` regardless of attestation contents. The gate's
 *      `ok` / `failures` / `ranSets` / `attestations` are unchanged from
 *      the pre-Phase-4-a baseline (proxied here by the flag-off path).
 *   2. Flag ON + ready (fully_prepared) verdict: `softWarnings: []`.
 *   3. Flag ON + not-ready verdict on any precondition: `softWarnings`
 *      contains exactly one human-readable entry, AND `gate.ok` is
 *      unaffected (Pin 11 reaffirmed).
 *   4. Flag ON + parse_error attestation: `softWarnings` contains a
 *      parse-error entry, AND `gate.ok` is unaffected.
 *   5. Flag ON + no marker (no attestations): `softWarnings: []`. The
 *      operator opted in, but there is nothing to warn about.
 *   6. `deriveSoftWarnings` is pure with respect to its `flagOn`
 *      argument — same input always yields the same output regardless
 *      of process.env at call time.
 *   7. The flag parser accepts ONLY the literal "true" (case-
 *      insensitive). Other truthy strings ("1", "yes", "TRUE-ish") do
 *      NOT enable the soft warning.
 *
 * Pin 7 (no public-action surface) reaffirmed: this test never invokes
 * any mutation route; it inspects pure return values only.
 *
 * Pin 11 (single-write-site boundary) reaffirmed: every assertion below
 * pins `gate.ok` independent of the soft warning state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canPromote,
  deriveSoftWarnings,
  readPhase3aPrepReadyRequiredFlag,
  PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV,
  type PromotionAttestation,
} from "../eval/promotionGate.js";
import {
  PHASE3A_PREP_EVIDENCE_PREFIX,
} from "../eval/phase3aPrepAttestation.js";
import type { SelfRecommendation } from "@shared/schema";

// Track A: this test file is intentionally NOT included in the
// `phase3aPrepHarness` allow-list. We construct candidate payloads
// from a locally-pinned precondition-key list, mirroring the closed
// vocabulary the harness ships. If the harness ever bumps its schema
// the gate-integration tests in `promotionGateAttestation.test.ts`
// (an allow-listed importer) will catch the drift; this file then
// updates the literal list in lock-step. The locally-pinned harness
// version string below is similarly inert — it is echoed onto a
// frozen `PromotionAttestation` literal solely for the
// `deriveSoftWarnings` purity tests.
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
    id: "rec_p4a_1",
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

function fullySatisfiedCandidate(candidateId = "cand-p4a-ready") {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of LOCAL_PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {
      high: { key, priority: "high", status: "satisfied", evidenceRef: "ref://h", rationale: "h" },
      low:  { key, priority: "low",  status: "satisfied", evidenceRef: "ref://l", rationale: "l" },
    };
  }
  return { candidateId, kind: "summarizationTemplate", preconditions };
}

/** A candidate whose first precondition's high-tier is `unverified` so
 *  the readiness verdict comes back as `not_ready` rather than
 *  `fully_prepared`. */
function notReadyCandidate(candidateId = "cand-p4a-blocked") {
  const cand = fullySatisfiedCandidate(candidateId);
  const firstKey = LOCAL_PHASE3A_PREP_PRECONDITION_KEYS[0];
  (cand.preconditions[firstKey] as any).high.status = "unverified";
  return cand;
}

function markerEvidence(payload: unknown): string {
  return JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(payload)]);
}

function setFlag(value: string | undefined): string | undefined {
  const prev = process.env[PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV];
  if (value === undefined) {
    delete process.env[PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV];
  } else {
    process.env[PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV] = value;
  }
  return prev;
}

function restoreFlag(prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV];
  } else {
    process.env[PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV] = prev;
  }
}

/* ─── 1. flag OFF: byte-identical with pre-Phase-4-a ─────────────── */

describe("promotionGate Phase 4-a — flag OFF (default)", () => {
  it("no marker: softWarnings is present-and-empty; gate.ok unchanged", async () => {
    const prev = setFlag(undefined);
    try {
      const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      assert.equal(r.ok, true);
      assert.deepEqual(r.softWarnings, []);
    } finally {
      restoreFlag(prev);
    }
  });

  it("ready marker present: softWarnings is empty; gate.ok unchanged", async () => {
    const prev = setFlag(undefined);
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-flagoff-ready")) }),
      );
      assert.equal(r.ok, true);
      assert.deepEqual(r.softWarnings, []);
    } finally {
      restoreFlag(prev);
    }
  });

  it("not-ready marker present: softWarnings is empty; gate.ok unchanged", async () => {
    const prev = setFlag(undefined);
    try {
      const r = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-flagoff-blocked")) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.deepEqual(r.softWarnings, []);
      // Attestation channel must still report the verdict for telemetry.
      assert.equal(r.attestations!.length, 1);
      assert.equal(r.attestations![0]!.status, "evaluated");
      assert.equal(r.attestations![0]!.readiness?.verdict, "not_ready");
    } finally {
      restoreFlag(prev);
    }
  });

  it("parse_error marker: softWarnings is empty; gate.ok unchanged", async () => {
    const prev = setFlag(undefined);
    try {
      const bad = JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"]);
      const r = await canPromote(mkRec({ risk: "low", evidence: bad }));
      assert.equal(r.ok, true);
      assert.deepEqual(r.softWarnings, []);
      assert.equal(r.attestations![0]!.status, "parse_error");
    } finally {
      restoreFlag(prev);
    }
  });

  it("not-approved path: softWarnings is empty; gate.ok stays false (not-approved reason)", async () => {
    const prev = setFlag(undefined);
    try {
      const r = await canPromote(
        mkRec({ status: "proposed", evidence: markerEvidence(notReadyCandidate("cand-flagoff-na")) }),
      );
      assert.equal(r.ok, false);
      assert.deepEqual(r.softWarnings, []);
    } finally {
      restoreFlag(prev);
    }
  });
});

/* ─── 2. flag ON + ready: no warning ──────────────────────────────── */

describe("promotionGate Phase 4-a — flag ON, ready candidate", () => {
  it("fully_prepared verdict yields no soft warning; gate.ok unchanged", async () => {
    const prev = setFlag("true");
    try {
      const baseline = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-flagon-ready")) }),
      );
      assert.equal(baseline.ok, true, `failures: ${baseline.failures.join(", ")}`);
      assert.deepEqual(baseline.softWarnings, []);
      assert.equal(baseline.attestations![0]!.readiness?.verdict, "fully_prepared");
    } finally {
      restoreFlag(prev);
    }
  });
});

/* ─── 3. flag ON + not-ready: warning surfaces ────────────────────── */

describe("promotionGate Phase 4-a — flag ON, not-ready candidate", () => {
  it("emits exactly one soft warning entry; gate.ok unchanged (Pin 11)", async () => {
    const prev = setFlag("true");
    try {
      const flagOff = setFlag(undefined);
      const off = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-warn-baseline")) }),
      );
      restoreFlag(flagOff);

      const on = await canPromote(
        mkRec({ risk: "low", evidence: markerEvidence(notReadyCandidate("cand-warn-baseline")) }),
      );

      // Pin 11: ok is byte-identical between flag-on and flag-off branches.
      assert.equal(on.ok, off.ok);
      assert.deepEqual(on.failures, off.failures);
      assert.deepEqual(on.ranSets, off.ranSets);

      // The warning is the ONLY difference.
      assert.equal(on.softWarnings!.length, 1);
      assert.match(on.softWarnings![0]!, /phase3aPrep readiness/);
      assert.match(on.softWarnings![0]!, /not_ready/);
      assert.match(on.softWarnings![0]!, /cand-warn-baseline/);
      assert.match(on.softWarnings![0]!, /ADVISORY ONLY/);
      assert.match(on.softWarnings![0]!, new RegExp(PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV));
    } finally {
      restoreFlag(prev);
    }
  });

  it("medium-risk + not-ready: soft warning does NOT flip a passing gate.ok", async () => {
    const prev = setFlag("true");
    try {
      const r = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(notReadyCandidate("cand-warn-med")) }),
      );
      // We assert the gate.ok matches what the same rec would produce
      // with the flag off — the soft warning channel cannot change it.
      const off = setFlag(undefined);
      const baseline = await canPromote(
        mkRec({ risk: "medium", evidence: markerEvidence(notReadyCandidate("cand-warn-med")) }),
      );
      restoreFlag(off);
      assert.equal(r.ok, baseline.ok);
      // Flag-on path still surfaces the warning.
      assert.equal(r.softWarnings!.length, 1);
    } finally {
      restoreFlag(prev);
    }
  });
});

/* ─── 4. flag ON + parse_error attestation ────────────────────────── */

describe("promotionGate Phase 4-a — flag ON, parse_error attestation", () => {
  it("emits a soft warning naming the parse error; gate.ok still true on low-risk", async () => {
    const prev = setFlag("true");
    try {
      const bad = JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"]);
      const r = await canPromote(mkRec({ risk: "low", evidence: bad }));
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.equal(r.softWarnings!.length, 1);
      assert.match(r.softWarnings![0]!, /phase3aPrep attestation could not be parsed/);
      assert.match(r.softWarnings![0]!, /ADVISORY ONLY/);
    } finally {
      restoreFlag(prev);
    }
  });
});

/* ─── 5. flag ON + no marker: nothing to warn about ───────────────── */

describe("promotionGate Phase 4-a — flag ON, no attestation marker", () => {
  it("returns softWarnings: [] when no marker is present", async () => {
    const prev = setFlag("true");
    try {
      const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
      assert.equal(r.ok, true);
      assert.deepEqual(r.softWarnings, []);
      assert.equal(r.attestations!.length, 0);
    } finally {
      restoreFlag(prev);
    }
  });
});

/* ─── 6. deriveSoftWarnings purity ─────────────────────────────────── */

describe("promotionGate Phase 4-a — deriveSoftWarnings purity", () => {
  it("returns [] when flagOn is false even if attestations are non-empty", () => {
    const att: PromotionAttestation = Object.freeze({
      source: "phase3aPrep" as const,
      harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
      status: "evaluated" as const,
      candidateId: "x",
      readiness: { highTierAllSatisfied: false, lowTierAllSatisfied: false, verdict: "not_ready", blockers: [] },
      parseWarnings: [],
      parseError: null,
    });
    const out = deriveSoftWarnings([att], false);
    assert.deepEqual(out, []);
  });

  it("emits a warning when flagOn is true and verdict is high_tier_ready (not fully_prepared)", () => {
    const att: PromotionAttestation = Object.freeze({
      source: "phase3aPrep" as const,
      harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
      status: "evaluated" as const,
      candidateId: "high-tier-x",
      readiness: { highTierAllSatisfied: true, lowTierAllSatisfied: false, verdict: "high_tier_ready", blockers: [] },
      parseWarnings: [],
      parseError: null,
    });
    const out = deriveSoftWarnings([att], true);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /high_tier_ready/);
    assert.match(out[0]!, /high-tier-x/);
  });

  it("ignores attestations whose source is not phase3aPrep (forward-compat)", () => {
    const att = {
      source: "unknownSource" as unknown as "phase3aPrep",
      harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
      status: "evaluated" as const,
      candidateId: "x",
      readiness: { highTierAllSatisfied: false, lowTierAllSatisfied: false, verdict: "not_ready", blockers: [] },
      parseWarnings: [],
      parseError: null,
    } as PromotionAttestation;
    const out = deriveSoftWarnings([att], true);
    assert.deepEqual(out, []);
  });

  it("is deterministic: same input → same output, regardless of process.env", () => {
    const att: PromotionAttestation = Object.freeze({
      source: "phase3aPrep" as const,
      harnessVersion: LOCAL_PHASE3A_PREP_HARNESS_VERSION,
      status: "evaluated" as const,
      candidateId: "x",
      readiness: { highTierAllSatisfied: false, lowTierAllSatisfied: false, verdict: "not_ready", blockers: [] },
      parseWarnings: [],
      parseError: null,
    });
    const a = deriveSoftWarnings([att], true);
    const prev = setFlag("false");
    try {
      const b = deriveSoftWarnings([att], true);
      assert.deepEqual(a, b);
    } finally {
      restoreFlag(prev);
    }
  });
});

/* ─── 7. flag parser strictness ────────────────────────────────────── */

describe("promotionGate Phase 4-a — flag parser", () => {
  it("returns false for unset", () => {
    const prev = setFlag(undefined);
    try { assert.equal(readPhase3aPrepReadyRequiredFlag(), false); }
    finally { restoreFlag(prev); }
  });
  it("returns true for 'true' (lowercase)", () => {
    const prev = setFlag("true");
    try { assert.equal(readPhase3aPrepReadyRequiredFlag(), true); }
    finally { restoreFlag(prev); }
  });
  it("returns true for 'TRUE' (uppercase)", () => {
    const prev = setFlag("TRUE");
    try { assert.equal(readPhase3aPrepReadyRequiredFlag(), true); }
    finally { restoreFlag(prev); }
  });
  it("returns false for '1' (non-canonical)", () => {
    const prev = setFlag("1");
    try { assert.equal(readPhase3aPrepReadyRequiredFlag(), false); }
    finally { restoreFlag(prev); }
  });
  it("returns false for 'yes' (non-canonical)", () => {
    const prev = setFlag("yes");
    try { assert.equal(readPhase3aPrepReadyRequiredFlag(), false); }
    finally { restoreFlag(prev); }
  });
  it("returns false for empty string", () => {
    const prev = setFlag("");
    try { assert.equal(readPhase3aPrepReadyRequiredFlag(), false); }
    finally { restoreFlag(prev); }
  });
});
