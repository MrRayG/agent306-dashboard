/**
 * promotionGate × phase3aPrep advisory attestation channel (Phase 3a-proper).
 *
 * Properties verified here:
 *   1. The gate's `ok` boolean is BYTE-IDENTICAL with and without an
 *      attestation marker on the recommendation. Attestations NEVER flip
 *      `ok` — this is the Pin 11 boundary invariant restated.
 *   2. An `attestations` entry is appended on every return path the gate
 *      can take (not-approved, low-risk, medium/high-risk, runner-failure
 *      simulated only indirectly — runner success is the live path).
 *   3. When the recommendation carries NO marker, `attestations` is
 *      present-and-empty (callers should treat absence and empty-array as
 *      equivalent per the gate doc-comment).
 *   4. A malformed marker yields a `parse_error` attestation, and the
 *      gate still computes `ok` from the regression runner alone.
 *   5. Each recommendation carries its OWN attestation (no shared state).
 *
 * Pin 7: read-only, stdout-only, no scheduler, no auto-apply, no public action.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canPromote } from "../eval/promotionGate.js";
import {
  PHASE3A_PREP_EVIDENCE_PREFIX,
} from "../eval/phase3aPrepAttestation.js";
import {
  PHASE3A_PREP_HARNESS_VERSION,
  PHASE3A_PREP_PRECONDITION_KEYS,
} from "../experiments/phase3aPrepHarness.js";
import type { SelfRecommendation } from "@shared/schema";

/* ─── Helpers ──────────────────────────────────────────────────────── */

function mkRec(overrides: Partial<SelfRecommendation> = {}): SelfRecommendation {
  return {
    id: "rec_gate_att_1",
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

/** Build a fully-attested (satisfied) candidate payload covering the full
 *  7-precondition × 2-tier matrix. The harness will return a "ready"
 *  readiness verdict on this shape — but the gate test does not assert on
 *  the verdict itself; it only asserts the attestation is present and
 *  well-formed. */
function fullySatisfiedCandidate(candidateId = "cand-gate-1") {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {
      high: { key, priority: "high", status: "satisfied", evidenceRef: "ref://h", rationale: "h" },
      low:  { key, priority: "low",  status: "satisfied", evidenceRef: "ref://l", rationale: "l" },
    };
  }
  return {
    candidateId,
    kind: "summarizationTemplate",
    // attestedAt: REQUIRED as of Phase 4-c (PR #401). Fixed default keeps existing tests deterministic.
    attestedAt: "2026-05-18T19:00:00.000Z",
    preconditions,
  };
}

function markerEvidence(payload: unknown): string {
  return JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(payload)]);
}

/* ─── 1. ok invariant (Pin 11) ──────────────────────────────────────── */

describe("promotionGateAttestation — ok invariant (Pin 11)", () => {
  it("low risk: ok is byte-identical with and without attestation marker", async () => {
    const without = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
    const withMarker = await canPromote(
      mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate()) }),
    );
    assert.equal(without.ok, withMarker.ok);
    assert.equal(without.ok, true);
  });

  it("medium risk: ok is byte-identical with and without attestation marker", async () => {
    const without = await canPromote(mkRec({ risk: "medium", evidence: "[]" }));
    const withMarker = await canPromote(
      mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate()) }),
    );
    assert.equal(without.ok, withMarker.ok);
  });

  it("high risk: ok is byte-identical with and without attestation marker (no override)", async () => {
    const prev = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    try {
      const without = await canPromote(mkRec({ risk: "high", evidence: "[]" }));
      const withMarker = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate()) }),
      );
      assert.equal(without.ok, false);
      assert.equal(withMarker.ok, false);
    } finally {
      if (prev !== undefined) process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prev;
    }
  });

  it("not-approved: ok is byte-identical with and without attestation marker", async () => {
    const without = await canPromote(mkRec({ status: "proposed", evidence: "[]" }));
    const withMarker = await canPromote(
      mkRec({ status: "proposed", evidence: markerEvidence(fullySatisfiedCandidate()) }),
    );
    assert.equal(without.ok, false);
    assert.equal(withMarker.ok, false);
  });

  it("a malformed marker (parse_error) does NOT block an otherwise-passing low-risk rec", async () => {
    // Marker present but payload is not valid JSON → adapter emits
    // status=parse_error → gate must still pass ok=true on a low-risk
    // approved rec.
    const badEvidence = JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"]);
    const r = await canPromote(mkRec({ risk: "low", evidence: badEvidence }));
    assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 1);
    assert.equal(r.attestations![0]!.status, "parse_error");
  });
});

/* ─── 2. attestation appended on every return path ──────────────────── */

describe("promotionGateAttestation — appended on every return path", () => {
  it("not-approved path carries the attestation", async () => {
    const r = await canPromote(
      mkRec({ status: "proposed", evidence: markerEvidence(fullySatisfiedCandidate("cand-not-approved")) }),
    );
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 1);
    assert.equal(r.attestations![0]!.source, "phase3aPrep");
    assert.equal(r.attestations![0]!.candidateId, "cand-not-approved");
  });

  it("low-risk path carries the attestation", async () => {
    const r = await canPromote(
      mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-low")) }),
    );
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 1);
    assert.equal(r.attestations![0]!.candidateId, "cand-low");
  });

  it("medium-risk path carries the attestation", async () => {
    const r = await canPromote(
      mkRec({ risk: "medium", evidence: markerEvidence(fullySatisfiedCandidate("cand-med")) }),
    );
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 1);
    assert.equal(r.attestations![0]!.candidateId, "cand-med");
  });

  it("high-risk path (blocked, no override) carries the attestation", async () => {
    const prev = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    try {
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high")) }),
      );
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.attestations));
      assert.equal(r.attestations!.length, 1);
      assert.equal(r.attestations![0]!.candidateId, "cand-high");
    } finally {
      if (prev !== undefined) process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prev;
    }
  });

  it("high-risk path (allowed via override) carries the attestation", async () => {
    const prev = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = "true";
    try {
      const r = await canPromote(
        mkRec({ risk: "high", evidence: markerEvidence(fullySatisfiedCandidate("cand-high-ok")) }),
      );
      assert.equal(r.ok, true, `failures: ${r.failures.join(", ")}`);
      assert.ok(Array.isArray(r.attestations));
      assert.equal(r.attestations!.length, 1);
      assert.equal(r.attestations![0]!.candidateId, "cand-high-ok");
    } finally {
      if (prev === undefined) delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
      else process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prev;
    }
  });
});

/* ─── 3. no marker → empty attestations array ───────────────────────── */

describe("promotionGateAttestation — absence semantics", () => {
  it("returns an empty attestations array when no marker is present (low risk)", async () => {
    const r = await canPromote(mkRec({ risk: "low", evidence: "[]" }));
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 0);
  });

  it("returns an empty attestations array when no marker is present (medium risk)", async () => {
    const r = await canPromote(mkRec({ risk: "medium", evidence: "[]" }));
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 0);
  });

  it("returns an empty attestations array when no marker is present (not approved)", async () => {
    const r = await canPromote(mkRec({ status: "proposed", evidence: "[]" }));
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 0);
  });

  it("returns an empty attestations array when evidence has unrelated entries", async () => {
    const r = await canPromote(
      mkRec({ risk: "low", evidence: JSON.stringify(["url://something", "issue:123"]) }),
    );
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 0);
  });

  it("returns an empty attestations array when evidence is unparseable JSON", async () => {
    // parseEvidence returns [] on JSON.parse failure → no marker found.
    const r = await canPromote(mkRec({ risk: "low", evidence: "{not-json" }));
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.attestations));
    assert.equal(r.attestations!.length, 0);
  });
});

/* ─── 4. independence: each rec carries its own attestation ─────────── */

describe("promotionGateAttestation — per-recommendation independence", () => {
  it("two recommendations evaluated sequentially carry their OWN candidateIds", async () => {
    const r1 = await canPromote(
      mkRec({ id: "rec-A", risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-A")) }),
    );
    const r2 = await canPromote(
      mkRec({ id: "rec-B", risk: "low", evidence: markerEvidence(fullySatisfiedCandidate("cand-B")) }),
    );
    assert.equal(r1.attestations!.length, 1);
    assert.equal(r2.attestations!.length, 1);
    assert.equal(r1.attestations![0]!.candidateId, "cand-A");
    assert.equal(r2.attestations![0]!.candidateId, "cand-B");
    // And one rec WITHOUT a marker after a rec WITH one — must not leak.
    const r3 = await canPromote(mkRec({ id: "rec-C", risk: "low", evidence: "[]" }));
    assert.equal(r3.attestations!.length, 0);
  });
});

/* ─── 5. shape pins ─────────────────────────────────────────────────── */

describe("promotionGateAttestation — shape pins", () => {
  it("an evaluated attestation pins harnessVersion to the constant", async () => {
    const r = await canPromote(
      mkRec({ risk: "low", evidence: markerEvidence(fullySatisfiedCandidate()) }),
    );
    assert.equal(r.attestations![0]!.harnessVersion, PHASE3A_PREP_HARNESS_VERSION);
    assert.equal(r.attestations![0]!.status, "evaluated");
    assert.notEqual(r.attestations![0]!.readiness, null);
  });

  it("a parse_error attestation has readiness=null and a non-empty parseError", async () => {
    const badEvidence = JSON.stringify([PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"]);
    const r = await canPromote(mkRec({ risk: "low", evidence: badEvidence }));
    const a = r.attestations![0]!;
    assert.equal(a.status, "parse_error");
    assert.equal(a.readiness, null);
    assert.ok(typeof a.parseError === "string" && a.parseError.length > 0);
  });
});
