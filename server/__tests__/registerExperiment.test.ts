/**
 * Gap C — registerExperiment / endExperiment admin helpers.
 *
 * Pins the contract documented in docs/EXPLORATION_POLICY.md §4.3:
 *   - register a new experiment, look it up via the cache → roundtrip
 *   - duplicate experimentKey returns ok:false (no second row written)
 *   - endExperiment flips status from running to a terminal value
 *   - invalid trafficPct (≤0 or ≥1) is rejected
 *   - cache invalidation: a registration is visible on the very next
 *     runExperiment call (no TTL wait required)
 *
 * Run: npx tsx --test server/__tests__/registerExperiment.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-regexp-"));
process.env.DATA_DIR = tmpDir;
delete process.env.EXPERIMENT_EXPLORATION;

const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");
const flagsMod = await import("../featureFlags.js");
const cacheMod = await import("../experiments/cache.js");
const registerMod = await import("../experiments/registerExperiment.js");
const runMod = await import("../experiments/runExperiment.js");

const { db } = dbMod;
const { experiments, experimentTrials } = schemaMod;
const { featureFlags } = flagsMod;
const { lookupActiveExperimentForTask, invalidateExperimentCache } = cacheMod;
const { registerExperiment, endExperiment } = registerMod;
const { runExperiment } = runMod;

function wipeAll(): void {
  try { db.delete(experimentTrials).run(); } catch {}
  try { db.delete(experiments).run(); } catch {}
  invalidateExperimentCache();
}

describe("registerExperiment / endExperiment", () => {
  before(wipeAll);
  beforeEach(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });
  after(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });

  it("register → lookupActiveExperimentForTask roundtrip", () => {
    const r = registerExperiment({
      experimentKey: "exp-roundtrip",
      surface: "modelRouter",
      taskKey: "task-roundtrip",
      baseline:  { model: "base-m",  provider: "openrouter" },
      treatment: { model: "treat-m", provider: "openrouter" },
      trafficPct: 0.25,
      metricKey: "metric",
      notes: "first experiment",
    });
    assert.equal(r.ok, true);

    const found = lookupActiveExperimentForTask("task-roundtrip");
    assert.ok(found);
    assert.equal(found!.experimentKey, "exp-roundtrip");
    assert.equal(found!.taskKey, "task-roundtrip");
    assert.equal(found!.status, "running");
    assert.equal(found!.trafficPct, 0.25);

    // Lookup for an unrelated task still returns null.
    assert.equal(lookupActiveExperimentForTask("some-other-task"), null);
  });

  it("duplicate experimentKey returns ok:false and writes no second row", () => {
    const first = registerExperiment({
      experimentKey: "exp-dup",
      surface: "modelRouter",
      taskKey: "task-dup",
      baseline:  { model: "a", provider: "openrouter" },
      treatment: { model: "b", provider: "openrouter" },
      metricKey: "metric",
    });
    assert.equal(first.ok, true);

    const second = registerExperiment({
      experimentKey: "exp-dup",
      surface: "modelRouter",
      taskKey: "task-dup-different",
      baseline:  { model: "x", provider: "openrouter" },
      treatment: { model: "y", provider: "openrouter" },
      metricKey: "metric",
    });
    assert.equal(second.ok, false);
    assert.match(second.reason ?? "", /duplicate/i);

    // Exactly one row exists.
    const rows = db.select().from(experiments).all();
    assert.equal(rows.length, 1);
    assert.equal((rows[0] as any).taskKey, "task-dup");
  });

  it("endExperiment flips status from running to a terminal value", () => {
    registerExperiment({
      experimentKey: "exp-to-end",
      surface: "modelRouter",
      taskKey: "task-end",
      baseline:  { model: "a", provider: "openrouter" },
      treatment: { model: "b", provider: "openrouter" },
      metricKey: "metric",
    });

    const r = endExperiment("exp-to-end", "ended");
    assert.equal(r.ok, true);

    // After end: lookup returns null because the cache filtered status='running'.
    assert.equal(lookupActiveExperimentForTask("task-end"), null);

    // Row exists but with terminal status + endedAt.
    const rows = db.select().from(experiments).all() as any[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "ended");
    assert.ok(rows[0].endedAt, "endedAt must be set");

    // Re-ending fails — status is no longer 'running'.
    const second = endExperiment("exp-to-end", "promoted");
    assert.equal(second.ok, false);
    assert.match(second.reason ?? "", /already/i);
  });

  it("rejects invalid trafficPct (≤0 or ≥1)", () => {
    for (const bad of [0, 1, -0.1, 1.5, NaN, Number.POSITIVE_INFINITY]) {
      const r = registerExperiment({
        experimentKey: `exp-bad-${String(bad)}`,
        surface: "modelRouter",
        taskKey: "task-bad",
        baseline:  { model: "a", provider: "openrouter" },
        treatment: { model: "b", provider: "openrouter" },
        trafficPct: bad,
        metricKey: "metric",
      });
      assert.equal(r.ok, false, `trafficPct=${bad} should be rejected`);
      assert.match(r.reason ?? "", /trafficPct/i);
    }
    // No rows leaked through.
    assert.equal(db.select().from(experiments).all().length, 0);
  });

  it("cache invalidation: registration is visible on the very next runExperiment call", () => {
    featureFlags.experimentExploration = true;

    // No experiment yet — runExperiment returns null (and warms a cold cache).
    assert.equal(runExperiment("task-cache-inv"), null);

    // Register WITHOUT manually invalidating the cache. registerExperiment
    // must call invalidateExperimentCache internally so the next
    // runExperiment sees the new row immediately.
    const r = registerExperiment({
      experimentKey: "exp-cache-inv",
      surface: "modelRouter",
      taskKey: "task-cache-inv",
      baseline:  { model: "base", provider: "openrouter" },
      treatment: { model: "treat", provider: "openrouter" },
      trafficPct: 0.999999,  // assigns treatment deterministically (Math.random() < 1 always true)
      metricKey: "metric",
    });
    assert.equal(r.ok, true);

    const assigned = runExperiment("task-cache-inv");
    assert.ok(assigned, "freshly-registered experiment must be visible without TTL wait");
    assert.equal(assigned!.experimentKey, "exp-cache-inv");
    assert.equal(assigned!.arm, "treatment");
  });
});
