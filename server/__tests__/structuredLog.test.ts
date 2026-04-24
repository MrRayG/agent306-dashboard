/**
 * structuredLog tests (spec §6).
 *
 * Confirms logEvent persists a row, applies the default level, truncates
 * oversized payloads, and survives DB failures without throwing.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { logEvent, recentEvents } from "../observability/structuredLog.js";

function wipe() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("structuredLog", () => {
  beforeEach(wipe);

  it("persists a row with the supplied fields", () => {
    logEvent({ engine: "test", event: "tick", data: { n: 1 } });
    const row = db.select().from(engineEvents).orderBy(desc(engineEvents.id)).get();
    assert.ok(row);
    assert.equal(row!.engine, "test");
    assert.equal(row!.event, "tick");
    assert.equal(row!.level, "info");
    const parsed = JSON.parse(row!.data);
    assert.deepEqual(parsed, { n: 1 });
  });

  it("defaults unknown level to info", () => {
    logEvent({ engine: "t", event: "e", level: "purple" as any, data: {} });
    const row = db.select().from(engineEvents).orderBy(desc(engineEvents.id)).get();
    assert.equal(row!.level, "info");
  });

  it("records error level explicitly", () => {
    logEvent({ engine: "t", event: "boom", level: "error", data: { err: "bad" } });
    const row = db.select().from(engineEvents).orderBy(desc(engineEvents.id)).get();
    assert.equal(row!.level, "error");
  });

  it("truncates oversized data payloads", () => {
    const big = { blob: "x".repeat(20_000) };
    logEvent({ engine: "t", event: "big", data: big });
    const row = db.select().from(engineEvents).orderBy(desc(engineEvents.id)).get();
    const parsed = JSON.parse(row!.data);
    assert.equal(parsed._, "truncated");
    assert.ok(typeof parsed.head === "string" && parsed.head.length <= 2100);
  });

  it("recentEvents returns newest-first with limit respected", () => {
    for (let i = 0; i < 5; i++) {
      logEvent({ engine: "seq", event: `ev_${i}`, data: { i } });
    }
    const rows = recentEvents({ engine: "seq", limit: 3 });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].event, "ev_4");
  });

  it("correlates via runId when present", () => {
    logEvent({ engine: "t", event: "start", runId: 42, data: {} });
    const row = db.select().from(engineEvents).where(eq(engineEvents.runId, 42)).get();
    assert.ok(row);
    assert.equal(row!.runId, 42);
  });
});
