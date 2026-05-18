/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Unit tests for server/eval/phase3aPrepAttestation.ts
 *
 *  Pin 7 (reaffirmed for Phase 3a-proper): the attestation adapter is
 *  read-only, stdout-only, no scheduler, no auto-apply, no public action.
 *  These tests verify exactly that: the adapter is a pure function with
 *  no side effects.
 *
 *  Test surface (organised by suite):
 *   1. detection / opt-in convention
 *      - no phase3aPrepCandidate evidence entry  → null
 *      - empty evidence array                    → null
 *      - malformed evidence JSON (not an array)  → null (degrades safely)
 *   2. happy-path evaluation
 *      - well-formed candidate, fully prepared    → status=evaluated, verdict=fully_prepared
 *      - well-formed candidate, high tier only    → status=evaluated, verdict=high_tier_ready
 *      - well-formed candidate, not ready         → status=evaluated, verdict=not_ready
 *   3. parse-error path
 *      - marker present, JSON.parse fails         → status=parse_error, readiness=null
 *      - marker present, JSON parses to non-object → status=parse_error
 *      - marker present, wrong `kind`             → status=parse_error
 *      - marker present, missing precondition key → status=parse_error
 *      - marker present, malformed attestation    → status=parse_error
 *   4. multiplicity / parseWarnings
 *      - two markers                              → uses first, warning lists count
 *   5. invariants / safety
 *      - adapter is pure: same input → same output
 *      - adapter never mutates rec.evidence
 *      - PromotionAttestation.harnessVersion pins to phase3aPrep.v1
 *      - PHASE3A_PREP_EVIDENCE_PREFIX matches the documented constant
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SelfRecommendation } from "@shared/schema";
import {
  buildPhase3aPrepAttestation,
  PHASE3A_PREP_EVIDENCE_PREFIX,
} from "../eval/phase3aPrepAttestation.js";
import {
  PHASE3A_PREP_HARNESS_VERSION,
  PHASE3A_PREP_PRECONDITION_KEYS,
} from "../experiments/phase3aPrepHarness.js";

/** Minimal SelfRecommendation factory. Builds a row with sane defaults
 *  and an explicit evidence array (JSON-stringified). */
function makeRec(opts: {
  id?:        string;
  evidence?:  string[];
  status?:    string;
  risk?:      string;
}): SelfRecommendation {
  return {
    id:                  opts.id ?? "rec-test-1",
    category:            "architecture",
    risk:                opts.risk ?? "low",
    title:               "Test recommendation",
    rationale:           "Test rationale",
    proposedChange:      "Test proposed change",
    proposedDiff:        null,
    evidence:            JSON.stringify(opts.evidence ?? []),
    status:              opts.status ?? "proposed",
    author:              "agent",
    sourceHypothesisId:  null,
    sourceInsightId:     null,
    dedupeKey:           null,
    prUrl:               null,
    patchPath:           null,
    createdAt:           "2026-05-13T00:00:00.000Z",
    approvedAt:          null,
    rejectedAt:          null,
    appliedAt:           null,
    revertedAt:          null,
    approvedBy:          null,
    reviewNote:          null,
  } as SelfRecommendation;
}

/** Build a complete 7-precondition × 2-tier attestation matrix where
 *  every entry has the given `status` and a non-empty evidenceRef. */
function fullyAttested(status: "satisfied" | "violated" | "unverified"): Record<string, Record<string, {
  key: string; priority: "high" | "low"; status: string; evidenceRef: string; rationale: string;
}>> {
  const out: Record<string, Record<string, {
    key: string; priority: "high" | "low"; status: string; evidenceRef: string; rationale: string;
  }>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    out[key] = {
      high: { key, priority: "high", status, evidenceRef: "ref://high",  rationale: "high tier" },
      low:  { key, priority: "low",  status, evidenceRef: "ref://low",   rationale: "low tier"  },
    };
  }
  return out;
}

function candidateWith(
  preconditions: unknown,
  candidateId = "cand-1",
  kind: unknown = "summarizationTemplate",
  attestedAt: unknown = "2026-05-18T19:00:00.000Z",
) {
  // `attestedAt` is REQUIRED by validateCandidate as of Phase 4-c
  // (PR #401). All historical fixtures default to a fixed ISO timestamp
  // so existing tests remain deterministic; tests that exercise the
  // attestedAt validation path pass an explicit override.
  return { candidateId, kind, preconditions, attestedAt };
}

function evidenceMarker(payload: unknown): string {
  return PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(payload);
}

/* ─── 1. detection / opt-in convention ────────────────────────────── */

describe("phase3aPrepAttestation — detection convention", () => {
  it("returns null when the recommendation carries no evidence entries", () => {
    const rec = makeRec({ evidence: [] });
    assert.equal(buildPhase3aPrepAttestation(rec), null);
  });

  it("returns null when no evidence entry starts with the phase3aPrep prefix", () => {
    const rec = makeRec({
      evidence: ["hypothesis:H42", "insight:I99", "metric:promotion_boundary_violation_count"],
    });
    assert.equal(buildPhase3aPrepAttestation(rec), null);
  });

  it("returns null when rec.evidence is malformed JSON (degrades safely)", () => {
    const rec = makeRec({});
    // Bypass the helper to write a non-array JSON value.
    (rec as { evidence: string }).evidence = '{"not": "an array"}';
    assert.equal(buildPhase3aPrepAttestation(rec), null);
  });

  it("returns null when rec.evidence is a non-JSON string (degrades safely)", () => {
    const rec = makeRec({});
    (rec as { evidence: string }).evidence = "this is not JSON at all";
    assert.equal(buildPhase3aPrepAttestation(rec), null);
  });

  it("PHASE3A_PREP_EVIDENCE_PREFIX is the documented constant", () => {
    assert.equal(PHASE3A_PREP_EVIDENCE_PREFIX, "phase3aPrepCandidate:");
  });
});

/* ─── 2. happy-path evaluation ────────────────────────────────────── */

describe("phase3aPrepAttestation — happy path", () => {
  it("evaluates a fully-prepared candidate to verdict='fully_prepared'", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "fully-prepared-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att, "expected non-null attestation");
    assert.equal(att.source, "phase3aPrep");
    assert.equal(att.status, "evaluated");
    assert.equal(att.candidateId, "fully-prepared-1");
    assert.equal(att.harnessVersion, PHASE3A_PREP_HARNESS_VERSION);
    assert.equal(att.parseError, null);
    assert.deepEqual(att.parseWarnings, []);
    assert.ok(att.readiness, "readiness present on evaluated status");
    assert.equal(att.readiness!.verdict, "fully_prepared");
    assert.equal(att.readiness!.highTierAllSatisfied, true);
    assert.equal(att.readiness!.lowTierAllSatisfied, true);
    assert.deepEqual(att.readiness!.blockers, []);
  });

  it("evaluates a high-tier-only candidate to verdict='high_tier_ready'", () => {
    // Build a candidate whose high tier is satisfied but at least one low
    // tier is unverified. Resulting verdict: high_tier_ready.
    const pre = fullyAttested("satisfied");
    const firstKey = PHASE3A_PREP_PRECONDITION_KEYS[0];
    pre[firstKey].low = { ...pre[firstKey].low, status: "unverified" };
    const cand = candidateWith(pre, "high-tier-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "evaluated");
    assert.equal(att.readiness!.verdict, "high_tier_ready");
    assert.equal(att.readiness!.highTierAllSatisfied, true);
    assert.equal(att.readiness!.lowTierAllSatisfied, false);
  });

  it("evaluates a not-ready candidate to verdict='not_ready'", () => {
    const pre = fullyAttested("unverified");
    const cand = candidateWith(pre, "not-ready-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "evaluated");
    assert.equal(att.readiness!.verdict, "not_ready");
    assert.equal(att.readiness!.highTierAllSatisfied, false);
  });
});

/* ─── 3. parse-error path ─────────────────────────────────────────── */

describe("phase3aPrepAttestation — parse-error path", () => {
  it("returns status='parse_error' when the suffix is not valid JSON", () => {
    const rec = makeRec({ evidence: [PHASE3A_PREP_EVIDENCE_PREFIX + "{not json"] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att, "expected non-null attestation (parse_error is still visible)");
    assert.equal(att.status, "parse_error");
    assert.equal(att.readiness, null);
    assert.equal(att.candidateId, "");
    assert.match(att.parseError ?? "", /JSON parse failed/);
  });

  it("returns status='parse_error' when the suffix parses to a non-object", () => {
    const rec = makeRec({ evidence: [PHASE3A_PREP_EVIDENCE_PREFIX + "42"] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "parse_error");
    assert.match(att.parseError ?? "", /not an object/);
  });

  it("returns status='parse_error' when kind != 'summarizationTemplate'", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "wrong-kind-1", "blogDraft");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "parse_error");
    assert.equal(att.candidateId, "wrong-kind-1");
    assert.match(att.parseError ?? "", /candidate\.kind.*summarizationTemplate/);
  });

  it("returns status='parse_error' when a precondition key is missing", () => {
    const pre = fullyAttested("satisfied");
    // Delete the first precondition entry entirely.
    const firstKey = PHASE3A_PREP_PRECONDITION_KEYS[0];
    delete (pre as Record<string, unknown>)[firstKey];
    const cand = candidateWith(pre, "missing-key-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "parse_error");
    assert.match(att.parseError ?? "", new RegExp(`preconditions\\.${firstKey}`));
  });

  it("returns status='parse_error' when an attestation has bad status", () => {
    const pre = fullyAttested("satisfied");
    const firstKey = PHASE3A_PREP_PRECONDITION_KEYS[0];
    (pre[firstKey].high as { status: string }).status = "completely_bogus";
    const cand = candidateWith(pre, "bad-status-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "parse_error");
    assert.match(att.parseError ?? "", /invalid status/);
  });

  it("returns status='parse_error' when candidateId is empty", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "parse_error");
    assert.match(att.parseError ?? "", /candidateId/);
  });
});

/* ─── 4. multiplicity / parseWarnings ─────────────────────────────── */

describe("phase3aPrepAttestation — multiplicity warnings", () => {
  it("warns when two phase3aPrepCandidate markers are present; consumes the first", () => {
    const c1 = candidateWith(fullyAttested("satisfied"), "first-1");
    const c2 = candidateWith(fullyAttested("unverified"), "second-1");
    const rec = makeRec({ evidence: [evidenceMarker(c1), evidenceMarker(c2)] });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "evaluated");
    // First candidate is fully prepared.
    assert.equal(att.candidateId, "first-1");
    assert.equal(att.readiness!.verdict, "fully_prepared");
    // Warning lists count.
    assert.equal(att.parseWarnings.length, 1);
    assert.match(att.parseWarnings[0], /multiple phase3aPrepCandidate evidence entries \(2\)/);
  });

  it("does NOT warn when the recommendation has unrelated evidence entries alongside one marker", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "with-noise-1");
    const rec = makeRec({
      evidence: ["hypothesis:H1", evidenceMarker(cand), "insight:I2", "metric:foo"],
    });

    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.status, "evaluated");
    assert.equal(att.candidateId, "with-noise-1");
    assert.deepEqual(att.parseWarnings, []);
  });
});

/* ─── 5. invariants / safety ──────────────────────────────────────── */

describe("phase3aPrepAttestation — invariants", () => {
  it("is pure: same input twice → byte-identical JSON output", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "pure-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });

    const a = buildPhase3aPrepAttestation(rec);
    const b = buildPhase3aPrepAttestation(rec);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("does not mutate rec.evidence", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "no-mutate-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand), "hypothesis:H1"] });
    const before = rec.evidence;
    buildPhase3aPrepAttestation(rec);
    assert.equal(rec.evidence, before);
  });

  it("attestation object is frozen", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "frozen-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });
    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(Object.isFrozen(att), true);
  });

  it("harnessVersion pins to phase3aPrep.v1 (schema bumps must update this test)", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "version-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });
    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.harnessVersion, "phase3aPrep.v1");
    assert.equal(att.harnessVersion, PHASE3A_PREP_HARNESS_VERSION);
  });

  it("source field is always 'phase3aPrep'", () => {
    const cand = candidateWith(fullyAttested("satisfied"), "source-1");
    const rec = makeRec({ evidence: [evidenceMarker(cand)] });
    const att = buildPhase3aPrepAttestation(rec);
    assert.ok(att);
    assert.equal(att.source, "phase3aPrep");
  });
});
