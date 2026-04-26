/**
 * Gap C — Phase 1 boot-time registration helper.
 *
 * Pins the boot contract enforced by `registerPhase1Experiment()`:
 *   - flag OFF (default): skip path is silent — no DB write
 *   - flag ON (first call): registers the experiment row
 *   - flag ON (subsequent calls): idempotent — duplicate-key path is a
 *     no-op, exactly one row exists, no second row written
 *   - thrown registration error is swallowed — caller (the scheduler)
 *     can continue booting
 *
 * Run: npx tsx --test server/__tests__/registerPhase1.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-regp1-"));
process.env.DATA_DIR = tmpDir;
delete process.env.EXPERIMENT_EXPLORATION;

const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");
const flagsMod = await import("../featureFlags.js");
const cacheMod = await import("../experiments/cache.js");
const phase1Mod = await import("../experiments/registerPhase1.js");
const phase1ConstMod = await import("../experiments/phase1Experiment.js");

const { db } = dbMod;
const { experiments, experimentTrials } = schemaMod;
const { featureFlags } = flagsMod;
const { invalidateExperimentCache } = cacheMod;
const { registerPhase1Experiment } = phase1Mod;
const { PHASE1_EXPERIMENT } = phase1ConstMod;

function wipeAll(): void {
  try { db.delete(experimentTrials).run(); } catch {}
  try { db.delete(experiments).run(); } catch {}
  invalidateExperimentCache();
}

describe("registerPhase1Experiment — boot wire", () => {
  before(wipeAll);
  beforeEach(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });
  after(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });

  it("flag OFF: silent skip path — no DB write", () => {
    featureFlags.experimentExploration = false;
    registerPhase1Experiment();

    const rows = db.select().from(experiments).all();
    assert.equal(rows.length, 0, "no experiment row may be written when the flag is off");
  });

  it("flag ON: idempotent across multiple calls — exactly one row after N invocations", () => {
    featureFlags.experimentExploration = true;

    for (let i = 0; i < 5; i += 1) {
      registerPhase1Experiment();
    }

    const rows = db.select().from(experiments).all() as any[];
    assert.equal(rows.length, 1, "every boot must converge on exactly one row");
    assert.equal(rows[0].experimentKey, PHASE1_EXPERIMENT.experimentKey);
    assert.equal(rows[0].status, "running");
    assert.equal(rows[0].metricKey, "routine_task_json_validity");
  });

  it("flag ON registers the configured baseline + treatment models", () => {
    featureFlags.experimentExploration = true;
    registerPhase1Experiment();

    const row = db.select().from(experiments).all()[0] as any;
    assert.ok(row, "row must exist");
    assert.equal(row.taskKey, PHASE1_EXPERIMENT.taskKey);
    const baseline = JSON.parse(row.baseline);
    const treatment = JSON.parse(row.treatment);
    assert.equal(baseline.model,  PHASE1_EXPERIMENT.baseline.model);
    assert.equal(baseline.provider, PHASE1_EXPERIMENT.baseline.provider);
    assert.equal(treatment.model, PHASE1_EXPERIMENT.treatment.model);
    assert.equal(treatment.provider, PHASE1_EXPERIMENT.treatment.provider);
  });

  it("a thrown registration error is swallowed — caller (scheduler) keeps going", () => {
    featureFlags.experimentExploration = true;

    // Inject a thrower in place of the real registerExperiment. The
    // helper's try/catch must absorb the throw and allow control to
    // return normally so startScheduler can keep booting the engine
    // list. (Without this guarantee, a corrupted DB at boot would knock
    // the entire scheduler offline.)
    const thrower = (() => {
      throw new Error("synthetic db corruption");
    }) as any;

    let threw: unknown = null;
    try {
      registerPhase1Experiment({ registerExperiment: thrower });
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null, "registerPhase1Experiment must not propagate the throw");

    // Defensive: nothing was written.
    assert.equal(db.select().from(experiments).all().length, 0);
  });
});
