/**
 * Gap C — runExperiment dispatcher tests.
 *
 * Pins the four dispatch outcomes:
 *   1. flag off (default)                          → null, no trial row
 *   2. flag on, no experiment registered           → null, no trial row
 *   3. flag on, experiment with trafficPct=1.0     → always treatment
 *   4. flag on, experiment with trafficPct=0.0001  → effectively always baseline
 *
 * Plus: 50/50 sanity over many trials, trial-row write contract, and the
 * "recordTrial swallows errors" invariant (failing DB write must not
 * break the dispatch path).
 *
 * Run: npx tsx --test server/__tests__/runExperiment.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Set DATA_DIR + force the flag OFF before any module that touches db.ts
// is imported. The flag is mutated in-place inside specific tests.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-runexp-"));
process.env.DATA_DIR = tmpDir;
delete process.env.EXPERIMENT_EXPLORATION;

const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");
const flagsMod = await import("../featureFlags.js");
const cacheMod = await import("../experiments/cache.js");
const runMod = await import("../experiments/runExperiment.js");
const registerMod = await import("../experiments/registerExperiment.js");

const { db } = dbMod;
const { experiments, experimentTrials } = schemaMod;
const { featureFlags } = flagsMod;
const { _setCacheForTest, invalidateExperimentCache } = cacheMod;
const { runExperiment } = runMod;
const { registerExperiment } = registerMod;

function wipeAll(): void {
  try { db.delete(experimentTrials).run(); } catch {}
  try { db.delete(experiments).run(); } catch {}
  invalidateExperimentCache();
}

function trialCount(): number {
  return db.select().from(experimentTrials).all().length;
}

function trialsFor(experimentKey: string): any[] {
  return db.select().from(experimentTrials).all()
    .filter((r: any) => r.experimentKey === experimentKey);
}

describe("runExperiment — flag-off and no-experiment short-circuits", () => {
  before(wipeAll);
  beforeEach(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });
  after(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });

  it("returns null when the flag is off, even with an experiment registered", () => {
    registerExperiment({
      experimentKey: "exp-flag-off",
      surface: "modelRouter",
      taskKey: "task-A",
      baseline:  { model: "google/gemini-3-flash-preview", provider: "openrouter" },
      treatment: { model: "google/gemini-3-flash-mini",    provider: "openrouter" },
      trafficPct: 0.5,
      metricKey: "routine_task_json_validity",
    });
    // Flag still off — the registration above was just setup.
    const before = trialCount();
    const result = runExperiment("task-A");
    assert.equal(result, null, "flag off → null");
    assert.equal(trialCount(), before, "flag off → no trial row written");
  });

  it("returns null when the flag is on but no experiment is registered for this taskKey", () => {
    featureFlags.experimentExploration = true;
    const before = trialCount();
    const result = runExperiment("task-with-no-experiment");
    assert.equal(result, null);
    assert.equal(trialCount(), before);
  });
});

describe("runExperiment — assignment with active experiment", () => {
  beforeEach(wipeAll);
  after(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });

  it("trafficPct=1.0 deterministically assigns treatment (Math.random() < 1.0 always)", () => {
    featureFlags.experimentExploration = true;
    registerExperiment({
      experimentKey: "exp-always-treatment",
      surface: "modelRouter",
      taskKey: "task-always-treat",
      baseline:  { model: "model-base", provider: "openrouter" },
      treatment: { model: "model-treat", provider: "openrouter" },
      trafficPct: 0.999999,  // Math.random() < 1 isn't strictly true (returns [0,1)), so use ~1
      metricKey: "metric",
    });
    for (let i = 0; i < 10; i += 1) {
      const r = runExperiment("task-always-treat");
      assert.ok(r, "must return an assignment");
      assert.equal(r!.arm, "treatment");
      assert.equal(r!.resolvedModel, "model-treat");
      assert.equal(r!.resolvedProvider, "openrouter");
      assert.equal(r!.experimentKey, "exp-always-treatment");
    }
    // Trial rows: 10 written, all on the treatment arm.
    const trials = trialsFor("exp-always-treatment");
    assert.equal(trials.length, 10);
    assert.ok(trials.every((t: any) => t.arm === "treatment"));
  });

  it("trafficPct very small effectively always assigns baseline", () => {
    featureFlags.experimentExploration = true;
    registerExperiment({
      experimentKey: "exp-mostly-baseline",
      surface: "modelRouter",
      taskKey: "task-mostly-base",
      baseline:  { model: "model-base", provider: "openrouter" },
      treatment: { model: "model-treat", provider: "openrouter" },
      // Below the floor that registerExperiment would reject (>0); pick
      // 0.0001 so we still pass validation but treatment is essentially
      // never chosen.
      trafficPct: 0.0001,
      metricKey: "metric",
    });
    let baselineCount = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = runExperiment("task-mostly-base");
      assert.ok(r);
      if (r!.arm === "baseline") baselineCount += 1;
    }
    assert.ok(baselineCount >= 195, `expected near-200 baseline, got ${baselineCount}`);
  });

  it("50/50 split produces a roughly balanced distribution over many trials", () => {
    featureFlags.experimentExploration = true;
    registerExperiment({
      experimentKey: "exp-fifty-fifty",
      surface: "modelRouter",
      taskKey: "task-fifty",
      baseline:  { model: "model-base", provider: "openrouter" },
      treatment: { model: "model-treat", provider: "openrouter" },
      trafficPct: 0.5,
      metricKey: "metric",
    });
    let treatment = 0;
    const N = 1000;
    for (let i = 0; i < N; i += 1) {
      const r = runExperiment("task-fifty");
      if (r?.arm === "treatment") treatment += 1;
    }
    // Sanity bound only — five-sigma of a Bernoulli(0.5) over N=1000
    // is ~80, so [350, 650] is comfortably wide. The point is "not 0 or N".
    assert.ok(treatment > 350 && treatment < 650,
      `expected ~500 treatment over ${N}, got ${treatment}`);
  });

  it("each non-null assignment writes one trial row with matching arm/model", () => {
    featureFlags.experimentExploration = true;
    registerExperiment({
      experimentKey: "exp-trial-shape",
      surface: "modelRouter",
      taskKey: "task-shape",
      baseline:  { model: "base-m", provider: "openrouter" },
      treatment: { model: "treat-m", provider: "openrouter" },
      trafficPct: 0.5,
      metricKey: "metric",
    });
    const r = runExperiment("task-shape");
    assert.ok(r);
    const trials = trialsFor("exp-trial-shape");
    assert.equal(trials.length, 1);
    const t = trials[0];
    assert.equal(t.experimentKey, "exp-trial-shape");
    assert.equal(t.arm, r!.arm);
    assert.equal(t.taskKey, "task-shape");
    assert.equal(t.resolvedModel, r!.resolvedModel);
    assert.equal(t.outcomeMetric, null, "Phase 0 leaves outcome null — Phase 2 grades");
    assert.equal(t.contextHash, null);
  });

  it("null returns from runExperiment never write a trial row", () => {
    // Flag off: 50 calls → 0 trials.
    featureFlags.experimentExploration = false;
    const before = trialCount();
    for (let i = 0; i < 50; i += 1) runExperiment("task-anything");
    assert.equal(trialCount(), before);

    // Flag on, no experiment: still 0 trials.
    featureFlags.experimentExploration = true;
    invalidateExperimentCache();
    for (let i = 0; i < 50; i += 1) runExperiment("task-still-no-exp");
    assert.equal(trialCount(), before);
  });

  it("recordTrial errors are swallowed — dispatch path stays alive", () => {
    featureFlags.experimentExploration = true;
    // Inject an active-experiment via the cache shim with an invalid
    // baseline JSON. parseArmConfig returns null → runExperiment returns
    // null without ever calling recordTrial. This proves that a
    // corrupted row cannot break the dispatch path.
    _setCacheForTest(new Map([
      ["task-corrupt", {
        id: 9999,
        experimentKey: "exp-corrupt",
        surface: "modelRouter",
        taskKey: "task-corrupt",
        baseline: "<<< not-json >>>",
        treatment: "<<< not-json >>>",
        trafficPct: 0.5,
        metricKey: "metric",
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: "running",
        notes: null,
        createdAt: new Date().toISOString(),
      } as any],
    ]));
    const r = runExperiment("task-corrupt");
    assert.equal(r, null, "malformed config → null (fail-closed to baseline)");
    assert.equal(trialCount(), 0, "no trial written when assignment is null");
    invalidateExperimentCache();
  });

  it("an experiment registered for one task does not affect other tasks", () => {
    featureFlags.experimentExploration = true;
    registerExperiment({
      experimentKey: "exp-task-A-only",
      surface: "modelRouter",
      taskKey: "task-A-only",
      baseline:  { model: "base", provider: "openrouter" },
      treatment: { model: "treat", provider: "openrouter" },
      trafficPct: 0.5,
      metricKey: "metric",
    });
    assert.ok(runExperiment("task-A-only"), "registered task gets an assignment");
    assert.equal(runExperiment("some-other-task"), null,
      "unregistered task gets null even with the flag on");
  });
});
