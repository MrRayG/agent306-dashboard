/**
 * recentEvents — query builder filter regression test.
 *
 * Pre-fix the chain was `.select().from().orderBy().limit()` and `.where()`
 * was tacked on AFTER `.limit()` with `as any` casts. In Drizzle that
 * compose-after-terminal pattern silently no-ops the filter — so
 * `recentEvents({ engine: 'reflectionEngine' })` returned the most-recent
 * N events from ALL engines. This test pins the contract that engine and
 * level filters actually narrow the result set.
 *
 * Run: npx tsx --test server/__tests__/recentEvents.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { recentEvents } from "../observability/structuredLog.js";

const TEST_ENGINES = ["__test_recentEvents_reflection", "__test_recentEvents_goal"] as const;

function deleteTestRows() {
  for (const e of TEST_ENGINES) {
    try { db.delete(engineEvents).where(eq(engineEvents.engine, e)).run(); } catch {}
  }
}

function seed() {
  const now = new Date().toISOString();
  // 2 reflection (one warn, one info) + 2 goal (one warn, one info).
  db.insert(engineEvents).values([
    { engine: TEST_ENGINES[0], event: "tick",    level: "info", data: "{}", emittedAt: now },
    { engine: TEST_ENGINES[0], event: "anomaly", level: "warn", data: "{}", emittedAt: now },
    { engine: TEST_ENGINES[1], event: "tick",    level: "info", data: "{}", emittedAt: now },
    { engine: TEST_ENGINES[1], event: "anomaly", level: "warn", data: "{}", emittedAt: now },
  ]).run();
}

describe("recentEvents — engine/level filters narrow results", () => {
  beforeEach(() => {
    deleteTestRows();
    seed();
  });
  afterEach(() => {
    deleteTestRows();
  });

  it("engine filter returns only that engine's rows", () => {
    const rows = recentEvents({ engine: TEST_ENGINES[0], limit: 500 })
      .filter((r: any) => (TEST_ENGINES as readonly string[]).includes(r.engine));
    assert.equal(rows.length, 2, "expected 2 rows for the reflection test engine");
    for (const r of rows) {
      assert.equal(r.engine, TEST_ENGINES[0], "every returned row must match the engine filter");
    }
  });

  it("level filter returns rows at that level across engines", () => {
    const rows = recentEvents({ level: "warn", limit: 500 })
      .filter((r: any) => (TEST_ENGINES as readonly string[]).includes(r.engine));
    assert.equal(rows.length, 2, "expected 2 warn rows across the test engines");
    for (const r of rows) {
      assert.equal(r.level, "warn");
    }
  });

  it("engine + level compose with AND", () => {
    const rows = recentEvents({ engine: TEST_ENGINES[0], level: "warn", limit: 500 })
      .filter((r: any) => (TEST_ENGINES as readonly string[]).includes(r.engine));
    assert.equal(rows.length, 1, "expected exactly 1 reflection-engine warn row");
    assert.equal(rows[0].engine, TEST_ENGINES[0]);
    assert.equal(rows[0].level, "warn");
  });

  it("no filter returns all seeded rows", () => {
    const rows = recentEvents({ limit: 500 })
      .filter((r: any) => (TEST_ENGINES as readonly string[]).includes(r.engine));
    assert.ok(rows.length >= 4, `expected >= 4 seeded rows, got ${rows.length}`);
  });

  it("orderBy/limit still apply when filters are present", () => {
    const rows = recentEvents({ engine: TEST_ENGINES[0], limit: 1 });
    assert.equal(rows.length, 1, "limit must still cap the result set");
    assert.equal(rows[0].engine, TEST_ENGINES[0], "filtered + limited row must match the engine filter");
  });
});
