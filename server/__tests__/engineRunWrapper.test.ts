/**
 * engineRunWrapper tests (spec §3).
 *
 * Confirms that runWrapped() writes an engine_runs row on success, an error
 * row on failure, and captures the insights_emitted delta by counting
 * selfRecommendations rows before/after the wrapped fn.
 *
 * Run: npx tsx --test server/__tests__/engineRunWrapper.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { engineRuns, selfRecommendations } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { runWrapped } from "../scheduler/engineRunWrapper.js";
import { proposeRecommendation } from "../selfRecommendationEngine.js";

function wipe() {
  try { db.delete(engineRuns).run(); } catch {}
  try { db.delete(selfRecommendations).run(); } catch {}
}

describe("engineRunWrapper — run observability", () => {
  before(wipe);
  beforeEach(wipe);

  it("writes an engine_runs row on successful run", async () => {
    const result = await runWrapped("test-engine", () => 42);
    assert.equal(result.outcome, "ok");
    assert.equal(result.data, 42);
    assert.ok(result.runId > 0);
    assert.ok(result.durationMs >= 0);

    const row = db.select().from(engineRuns).where(eq(engineRuns.id, result.runId)).get();
    assert.ok(row);
    assert.equal(row!.engine, "test-engine");
    assert.equal(row!.status, "ok");
    assert.ok(row!.finishedAt);
  });

  it("writes status=error when the fn throws", async () => {
    const result = await runWrapped("bad-engine", () => { throw new Error("boom"); });
    assert.equal(result.outcome, "error");
    assert.match(result.error ?? "", /boom/);

    const row = db.select().from(engineRuns).where(eq(engineRuns.id, result.runId)).get();
    assert.ok(row);
    assert.equal(row!.status, "error");
    assert.match(row!.error ?? "", /boom/);
  });

  it("captures insights_emitted delta from selfRecommendations writes", async () => {
    const result = await runWrapped("emitter", () => {
      proposeRecommendation({ category: "prompt", title: "a", rationale: "r", proposedChange: "p" });
      proposeRecommendation({ category: "prompt", title: "b", rationale: "r", proposedChange: "p" });
      return "done";
    });
    assert.equal(result.insightsEmitted, 2);

    const row = db.select().from(engineRuns).where(eq(engineRuns.id, result.runId)).get();
    assert.equal(row!.insightsEmitted, 2);
  });

  it("defaults triggeredBy to scheduler", async () => {
    const r = await runWrapped("e1", () => 1);
    const row = db.select().from(engineRuns).where(eq(engineRuns.id, r.runId)).get();
    assert.equal(row!.triggeredBy, "scheduler");
  });

  it("respects explicit triggeredBy option", async () => {
    const r = await runWrapped("e2", () => 1, { triggeredBy: "boot" });
    const row = db.select().from(engineRuns).where(eq(engineRuns.id, r.runId)).get();
    assert.equal(row!.triggeredBy, "boot");
  });

  it("finalizes rows in chronological order", async () => {
    await runWrapped("seq1", () => 1);
    await runWrapped("seq2", () => 2);
    await runWrapped("seq3", () => 3);
    const rows = db.select().from(engineRuns).orderBy(desc(engineRuns.id)).limit(3).all();
    assert.equal(rows.length, 3);
    // Insert order: seq1, seq2, seq3 → desc by id should give seq3, seq2, seq1
    assert.deepEqual(rows.map(r => r.engine), ["seq3", "seq2", "seq1"]);
  });
});
