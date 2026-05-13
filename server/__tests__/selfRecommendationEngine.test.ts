/**
 * Self-Recommendation Engine tests (spec §1).
 *
 * Critical invariant under test: propose-only. The engine must never
 * transition a rec to `applied` unless status='approved' AND the promotion
 * gate returns ok. These tests also assert the status transition matrix.
 *
 * Run: npx tsx --test server/__tests__/selfRecommendationEngine.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB / DATA_DIR isolation. Same pattern as `repositories.test.ts`
// (PR #299): parallel test subprocesses share `data/agent306.db`, and sibling
// files that wipe / insert into `self_recommendations` (e.g.
// `selfRecommendationDedupe.test.ts`, `selfRecBuildupSecondPass.test.ts`)
// race with this file's promotion-gate lifecycle assertions. Scoping the DB
// to a per-process tmpdir eliminates the race; production behavior is
// unchanged.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "selfRecEngine-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

// Dynamic imports so DB_PATH / DATA_DIR above are in place before
// `server/db.ts` evaluates (static ESM imports would be hoisted and miss them).
const { db } = await import("../db.js");
const { selfRecommendations, engineEvents } = await import("@shared/schema");
const { desc, eq } = await import("drizzle-orm");
const {
  proposeRecommendation,
  approveRecommendation,
  rejectRecommendation,
  applyRecommendation,
  revertRecommendation,
  listRecommendations,
  getRecommendation,
  parseEvidence,
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

describe("selfRecommendationEngine — propose/approve/apply lifecycle", () => {
  before(wipe);
  beforeEach(wipe);

  it("propose() inserts a row in status=proposed", () => {
    const rec = proposeRecommendation({
      category: "prompt",
      title: "Test rule",
      rationale: "because",
      proposedChange: "keep rule X",
      evidence: ["a", "b"],
    });
    assert.equal(rec.status, "proposed");
    assert.equal(rec.category, "prompt");
    assert.equal(rec.risk, "low");
    assert.deepEqual(parseEvidence(rec), ["a", "b"]);

    const fetched = getRecommendation(rec.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, rec.id);
  });

  it("approve() moves proposed → approved and stamps approvedAt", () => {
    const rec = proposeRecommendation({
      category: "prompt",
      title: "T",
      rationale: "R",
      proposedChange: "P",
    });
    const approved = approveRecommendation(rec.id, "alice", "lgtm");
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, "alice");
    assert.equal(approved.reviewNote, "lgtm");
    assert.ok(approved.approvedAt);
  });

  it("reject() moves proposed → rejected", () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P",
    });
    const rejected = rejectRecommendation(rec.id, "alice", "nope");
    assert.equal(rejected.status, "rejected");
    assert.ok(rejected.rejectedAt);
  });

  it("approve() on a non-proposed rec throws", () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P",
    });
    approveRecommendation(rec.id, "alice");
    assert.throws(() => approveRecommendation(rec.id, "alice"), /Cannot approve/);
  });

  it("apply() refuses a rec in status=proposed (propose-only policy)", async () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P",
    });
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /cannot apply/);

    const after = getRecommendation(rec.id)!;
    assert.equal(after.status, "proposed");
  });

  it("apply() succeeds when approved AND low risk (promotion gate passes)", async () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P", risk: "low",
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, true);

    const after = getRecommendation(rec.id)!;
    assert.equal(after.status, "applied");
    assert.ok(after.appliedAt);
  });

  it("apply() is blocked by promotion gate for high-risk recs (commit-5 gate)", async () => {
    const rec = proposeRecommendation({
      category: "schema", title: "Risky", rationale: "R", proposedChange: "P", risk: "high",
    });
    approveRecommendation(rec.id, "alice");
    const result = await applyRecommendation(rec.id, "alice");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "promotion_gate_failed");
    assert.ok((result.failures ?? []).length > 0);

    const after = getRecommendation(rec.id)!;
    assert.equal(after.status, "approved"); // not transitioned
  });

  it("revert() only works on applied rows", async () => {
    const rec = proposeRecommendation({
      category: "prompt", title: "T", rationale: "R", proposedChange: "P",
    });
    assert.throws(() => revertRecommendation(rec.id, "alice"), /Cannot revert/);

    approveRecommendation(rec.id, "alice");
    await applyRecommendation(rec.id, "alice");

    const reverted = revertRecommendation(rec.id, "alice", "rolled back");
    assert.equal(reverted.status, "reverted");
    assert.ok(reverted.revertedAt);
  });

  it("list() filters by status and orders newest first", () => {
    proposeRecommendation({ category: "prompt", title: "one", rationale: "r", proposedChange: "p" });
    proposeRecommendation({ category: "prompt", title: "two", rationale: "r", proposedChange: "p" });
    proposeRecommendation({ category: "prompt", title: "three", rationale: "r", proposedChange: "p" });

    const all = listRecommendations({});
    assert.equal(all.length, 3);
    // Newest-first
    assert.equal(all[0].title, "three");

    const filtered = listRecommendations({ status: "proposed" });
    assert.equal(filtered.length, 3);
    const none = listRecommendations({ status: "applied" });
    assert.equal(none.length, 0);
  });

  it("propose() rejects invalid category/risk", () => {
    assert.throws(() =>
      proposeRecommendation({ category: "junk" as any, title: "T", rationale: "R", proposedChange: "P" }),
    );
    assert.throws(() =>
      proposeRecommendation({
        category: "prompt",
        risk: "extreme" as any,
        title: "T",
        rationale: "R",
        proposedChange: "P",
      }),
    );
  });
});

/* ─── Phase 3b-a — promotion-attestation event-log persistence ─────────
 *
 * applyRecommendation() now appends one engine_events row when the
 * promotion gate returns a non-empty attestations array. The row is
 * advisory / observable-only:
 *   - It does not change apply ok/reason/failures (behavior-neutral).
 *   - It does not change the promotion boundary (Pin 11).
 *   - No engine_events row is written when no attestation is collected
 *     (noise stays proportional to traffic).
 *   - Persistence happens whether the gate passes OR blocks.
 *
 * Lives in this file (rather than its own) so it shares the same
 * tmp-DB / DATA_DIR isolation already established above — adding a
 * separate test subprocess perturbs worker scheduling under the
 * aggregate runner and surfaces a latent shared-DB race in unrelated
 * test files. Same coverage, smaller blast radius.
 * ────────────────────────────────────────────────────────────────── */

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
  label?: string;
  evidence?: string[];
  risk?: "low" | "medium" | "high";
}): Promise<{ recId: string; result: Awaited<ReturnType<typeof applyRecommendation>> }> {
  const rec = proposeRecommendation({
    category: "prompt",
    risk: opts.risk ?? "low",
    title: opts.label ?? "test",
    rationale: "R",
    proposedChange: opts.label ?? "P",
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
    .filter((row: any) => {
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
      label: "rec_with_marker_low",
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
      label: "rec_no_marker",
      evidence: [],
      risk: "low",
    });
    assert.equal(result.ok, true);
    const rows = readPromotionAttestationRows(recId);
    assert.equal(rows.length, 0, "expected zero promotionAttestation rows when no marker is present");
  });

  it("writes NO promotionAttestation row when evidence is unrelated to phase3aPrep", async () => {
    const { recId, result } = await proposeApproveApply({
      label: "rec_unrelated_evidence",
      evidence: ["url://something", "issue:123"],
      risk: "low",
    });
    assert.equal(result.ok, true);
    const rows = readPromotionAttestationRows(recId);
    assert.equal(rows.length, 0);
  });

  it("persists a parse_error attestation when the marker payload is malformed (gate still ok=true on low risk)", async () => {
    const { recId, result } = await proposeApproveApply({
      label: "rec_parse_error",
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
        label: "rec_high_blocked",
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
      label: "rec_neutral_no_marker",
      evidence: [],
      risk: "low",
    });
    const b = await proposeApproveApply({
      label: "rec_neutral_with_marker",
      evidence: markerEvidence(fullySatisfiedCandidate("cand-neutral")),
      risk: "low",
    });
    assert.equal(a.result.ok, b.result.ok);
    assert.equal(a.result.reason, b.result.reason);
    assert.deepEqual(a.result.failures ?? [], b.result.failures ?? []);
  });

  it("each rec has its own engine_events row (no cross-rec leakage)", async () => {
    const a = await proposeApproveApply({
      label: "rec_a",
      evidence: markerEvidence(fullySatisfiedCandidate("cand-a")),
      risk: "low",
    });
    const b = await proposeApproveApply({
      label: "rec_b",
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
