/**
 * Phase 3b-a — Promotion-attestation event-log persistence.
 *
 * The Phase 3a-proper advisory attestation channel collected attestations
 * in-process only. Phase 3b-a persists them on the existing engine_events
 * log so downstream observers (e.g. the SelfRecommendations page in 3b-b)
 * can read what attestations were attached to a given apply attempt.
 *
 * Invariants this file pins:
 *
 *   1. Behavior-neutrality. applyRecommendation()'s ok/reason/failures
 *      surface is byte-identical with and without attestation evidence on
 *      the recommendation. Pin 11 (the promotion boundary) is unchanged.
 *
 *   2. Presence semantics. When the recommendation carries a
 *      phase3aPrepCandidate evidence marker, exactly one engine_events
 *      row is appended with engine="selfRecommendation",
 *      event="promotionAttestation", and a payload that echoes the
 *      attestations the gate collected.
 *
 *   3. Absence semantics. When no marker is present (the vast majority
 *      of recs today), NO promotionAttestation row is written — the
 *      event log stays quiet so noise is proportional to traffic.
 *
 *   4. Persistence happens whether the gate passes OR blocks. The
 *      attestation is observability for both outcomes.
 *
 * Read-only, no public action surface added.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB isolation, mirroring selfRecommendationEngine.test.ts.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phase3b-a-attestation-event-log-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const { db } = await import("../db.js");
const { selfRecommendations, engineEvents } = await import("@shared/schema");
const { desc, eq } = await import("drizzle-orm");
const {
  proposeRecommendation,
  approveRecommendation,
  applyRecommendation,
} = await import("../selfRecommendationEngine.js");
const {
  PHASE3A_PREP_EVIDENCE_PREFIX,
} = await import("../eval/phase3aPrepAttestation.js");
const {
  PHASE3A_PREP_PRECONDITION_KEYS,
} = await import("../experiments/phase3aPrepHarness.js");

function wipe() {
  try { db.delete(selfRecommendations).run(); } catch {}
  try { db.delete(engineEvents).run(); } catch {}
}

function fullySatisfiedCandidate(candidateId: string) {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {
      high: { key, priority: "high", status: "satisfied", evidenceRef: "ref://h", rationale: "h" },
      low:  { key, priority: "low",  status: "satisfied", evidenceRef: "ref://l", rationale: "l" },
    };
  }
  return { candidateId, kind: "summarizationTemplate", preconditions };
}

function markerEvidence(payload: unknown): string[] {
  return [PHASE3A_PREP_EVIDENCE_PREFIX + JSON.stringify(payload)];
}

async function proposeApproveApply(opts: {
  id?: string;
  evidence?: string[];
  risk?: "low" | "medium" | "high";
}): Promise<{ recId: string; result: Awaited<ReturnType<typeof applyRecommendation>> }> {
  const rec = proposeRecommendation({
    category: "prompt",
    risk: opts.risk ?? "low",
    title: opts.id ?? "test",
    rationale: "R",
    proposedChange: opts.id ?? "P",
    evidence: opts.evidence ?? [],
  });
  approveRecommendation(rec.id, "alice");
  const result = await applyRecommendation(rec.id, "alice");
  return { recId: rec.id, result };
}

function readPromotionAttestationRows(recId: string) {
  return db
    .select()
    .from(engineEvents)
    .where(eq(engineEvents.event, "promotionAttestation"))
    .orderBy(desc(engineEvents.id))
    .all()
    .filter((row) => {
      try {
        const parsed = JSON.parse(row.data);
        return parsed.recommendationId === recId;
      } catch {
        return false;
      }
    });
}

describe("phase3b-a promotion-attestation event-log persistence", () => {
  before(wipe);
  beforeEach(wipe);

  it("writes ONE promotionAttestation row when the rec carries a phase3aPrep marker (gate ok=true)", async () => {
    const { recId, result } = await proposeApproveApply({
      id: "rec_with_marker_low",
      evidence: markerEvidence(fullySatisfiedCandidate("cand-low")),
      risk: "low",
    });
    assert.equal(result.ok, true, `failures: ${(result.failures ?? []).join(", ")}`);
    const rows = readPromotionAttestationRows(recId);
    assert.equal(rows.length, 1, "expected exactly one promotionAttestation row");
    const row = rows[0]!;
    assert.equal(row.engine, "selfRecommendation");
    assert.equal(row.event, "promotionAttestation");
    assert.equal(row.level, "info");
    const payload = JSON.parse(row.data);
    assert.equal(payload.recommendationId, recId);
    assert.equal(payload.gateOk, true);
    assert.ok(Array.isArray(payload.attestations));
    assert.equal(payload.attestations.length, 1);
    assert.equal(payload.attestations[0].source, "phase3aPrep");
    assert.equal(payload.attestations[0].candidateId, "cand-low");
    assert.equal(payload.attestations[0].status, "evaluated");
  });

  it("writes NO promotionAttestation row when the rec has no phase3aPrep marker", async () => {
    const { recId, result } = await proposeApproveApply({
      id: "rec_no_marker",
      evidence: [],
      risk: "low",
    });
    assert.equal(result.ok, true);
    const rows = readPromotionAttestationRows(recId);
    assert.equal(rows.length, 0, "expected zero promotionAttestation rows when no marker is present");
  });

  it("writes NO promotionAttestation row when evidence is unrelated to phase3aPrep", async () => {
    const { recId, result } = await proposeApproveApply({
      id: "rec_unrelated_evidence",
      evidence: ["url://something", "issue:123"],
      risk: "low",
    });
    assert.equal(result.ok, true);
    const rows = readPromotionAttestationRows(recId);
    assert.equal(rows.length, 0);
  });

  it("persists a parse_error attestation when the marker payload is malformed (gate still ok=true on low risk)", async () => {
    const { recId, result } = await proposeApproveApply({
      id: "rec_parse_error",
      evidence: [PHASE3A_PREP_EVIDENCE_PREFIX + "{not-json"],
      risk: "low",
    });
    assert.equal(result.ok, true);
    const rows = readPromotionAttestationRows(recId);
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0]!.data);
    assert.equal(payload.gateOk, true);
    assert.equal(payload.attestations.length, 1);
    assert.equal(payload.attestations[0].status, "parse_error");
    assert.equal(payload.attestations[0].readiness, null);
    assert.ok(typeof payload.attestations[0].parseError === "string");
  });

  it("persists the attestation even when the gate blocks (high-risk without override)", async () => {
    const prev = process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    delete process.env.PROMOTION_GATE_ALLOW_HIGH_RISK;
    try {
      const { recId, result } = await proposeApproveApply({
        id: "rec_high_blocked",
        evidence: markerEvidence(fullySatisfiedCandidate("cand-high")),
        risk: "high",
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "promotion_gate_failed");
      const rows = readPromotionAttestationRows(recId);
      assert.equal(rows.length, 1, "expected attestation persistence even on a blocked apply");
      const payload = JSON.parse(rows[0]!.data);
      assert.equal(payload.gateOk, false);
      assert.equal(payload.attestations[0].candidateId, "cand-high");
    } finally {
      if (prev !== undefined) process.env.PROMOTION_GATE_ALLOW_HIGH_RISK = prev;
    }
  });

  it("behavior-neutrality: apply ok/reason/failures match with and without an attestation marker (low risk)", async () => {
    const a = await proposeApproveApply({
      id: "rec_neutral_no_marker",
      evidence: [],
      risk: "low",
    });
    const b = await proposeApproveApply({
      id: "rec_neutral_with_marker",
      evidence: markerEvidence(fullySatisfiedCandidate("cand-neutral")),
      risk: "low",
    });
    assert.equal(a.result.ok, b.result.ok);
    assert.equal(a.result.reason, b.result.reason);
    assert.deepEqual(a.result.failures ?? [], b.result.failures ?? []);
  });

  it("each rec has its own engine_events row (no cross-rec leakage)", async () => {
    const a = await proposeApproveApply({
      id: "rec_a",
      evidence: markerEvidence(fullySatisfiedCandidate("cand-a")),
      risk: "low",
    });
    const b = await proposeApproveApply({
      id: "rec_b",
      evidence: markerEvidence(fullySatisfiedCandidate("cand-b")),
      risk: "low",
    });
    const rowsA = readPromotionAttestationRows(a.recId);
    const rowsB = readPromotionAttestationRows(b.recId);
    assert.equal(rowsA.length, 1);
    assert.equal(rowsB.length, 1);
    assert.equal(JSON.parse(rowsA[0]!.data).attestations[0].candidateId, "cand-a");
    assert.equal(JSON.parse(rowsB[0]!.data).attestations[0].candidateId, "cand-b");
  });
});
