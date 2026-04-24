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
import { db } from "../db.js";
import { selfRecommendations } from "@shared/schema";
import {
  proposeRecommendation,
  approveRecommendation,
  rejectRecommendation,
  applyRecommendation,
  revertRecommendation,
  listRecommendations,
  getRecommendation,
  parseEvidence,
} from "../selfRecommendationEngine.js";

function wipe() {
  try { db.delete(selfRecommendations).run(); } catch {}
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
