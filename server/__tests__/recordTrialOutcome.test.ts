/**
 * Gap C — recordTrialOutcome (Phase 1).
 *
 * Pins the contract documented in docs/EXPLORATION_POLICY.md §3.2:
 *   - writes outcome_metric and outcome_recorded_at on a trial row
 *   - first write wins; re-recording the same trial id is rejected with
 *     reason="already_recorded" (decision documented in
 *     server/experiments/recordTrialOutcome.ts header)
 *   - rejects bad trial ids and non-finite metric values
 *   - never throws — DB errors come back as { ok: false, reason }
 *
 * Run: npx tsx --test server/__tests__/recordTrialOutcome.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-rto-"));
process.env.DATA_DIR = tmpDir;
delete process.env.EXPERIMENT_EXPLORATION;

const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");
const flagsMod = await import("../featureFlags.js");
const cacheMod = await import("../experiments/cache.js");
const registerMod = await import("../experiments/registerExperiment.js");
const runMod = await import("../experiments/runExperiment.js");
const outcomeMod = await import("../experiments/recordTrialOutcome.js");

const { db } = dbMod;
const { experiments, experimentTrials } = schemaMod;
const { featureFlags } = flagsMod;
const { invalidateExperimentCache } = cacheMod;
const { registerExperiment } = registerMod;
const { runExperiment } = runMod;
const { recordTrialOutcome } = outcomeMod;

function wipeAll(): void {
  try { db.delete(experimentTrials).run(); } catch {}
  try { db.delete(experiments).run(); } catch {}
  invalidateExperimentCache();
}

function getTrial(id: number): any {
  return db.select().from(experimentTrials).all().find((r: any) => r.id === id);
}

function freshTrialId(): number {
  // Register a deterministically-treatment experiment, run once, return the
  // trial id so each test starts from a clean trial row.
  registerExperiment({
    experimentKey: `exp-${Math.random().toString(36).slice(2, 8)}`,
    surface: "modelRouter",
    taskKey: `task-${Math.random().toString(36).slice(2, 8)}`,
    baseline:  { model: "base", provider: "openrouter" },
    treatment: { model: "treat", provider: "openrouter" },
    trafficPct: 0.999999,
    metricKey: "routine_task_json_validity",
  });
  // pick up the latest registered task key
  const exp = db.select().from(experiments).all().sort(
    (a: any, b: any) => (a.id < b.id ? 1 : -1),
  )[0] as any;
  invalidateExperimentCache();
  const r = runExperiment(exp.taskKey);
  assert.ok(r, "runExperiment must produce an assignment");
  assert.ok(r!.trialId, "trialId must be populated");
  return r!.trialId!;
}

describe("recordTrialOutcome", () => {
  before(wipeAll);
  beforeEach(() => {
    wipeAll();
    featureFlags.experimentExploration = true;
  });
  after(() => {
    wipeAll();
    featureFlags.experimentExploration = false;
  });

  it("writes outcome_metric and outcome_recorded_at on the trial row", () => {
    const trialId = freshTrialId();

    // Pre-write state: outcome columns null.
    const before = getTrial(trialId);
    assert.equal(before.outcomeMetric, null);
    assert.equal(before.outcomeRecordedAt, null);

    const r = recordTrialOutcome(trialId, 1.0);
    assert.equal(r.ok, true);

    const after = getTrial(trialId);
    assert.equal(after.outcomeMetric, 1.0);
    assert.ok(after.outcomeRecordedAt, "outcomeRecordedAt must be set");
  });

  it("accepts 0.0 (parse failure) and roundtrips through the column", () => {
    const trialId = freshTrialId();
    const r = recordTrialOutcome(trialId, 0.0);
    assert.equal(r.ok, true);
    assert.equal(getTrial(trialId).outcomeMetric, 0.0);
  });

  it("first write wins — re-recording the same trial id is rejected", () => {
    const trialId = freshTrialId();
    const first = recordTrialOutcome(trialId, 1.0);
    assert.equal(first.ok, true);

    const second = recordTrialOutcome(trialId, 0.0);
    assert.equal(second.ok, false);
    assert.equal(
      (second as { reason: string }).reason,
      "already_recorded",
      "re-recording must be rejected with already_recorded",
    );

    // Original value preserved.
    assert.equal(getTrial(trialId).outcomeMetric, 1.0);
  });

  it("returns trial-not-found for unknown trial id", () => {
    const r = recordTrialOutcome(999_999, 1.0);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /not found/i);
  });

  it("rejects invalid trial id", () => {
    for (const bad of [0, -1, 1.5, NaN]) {
      const r = recordTrialOutcome(bad as number, 1.0);
      assert.equal(r.ok, false, `trialId=${bad} should be rejected`);
      assert.match((r as { reason: string }).reason, /trialId/i);
    }
  });

  it("rejects non-finite metric values", () => {
    const trialId = freshTrialId();
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = recordTrialOutcome(trialId, bad);
      assert.equal(r.ok, false, `metricValue=${bad} should be rejected`);
      assert.match((r as { reason: string }).reason, /metricValue/i);
    }
    // No outcome was written.
    assert.equal(getTrial(trialId).outcomeMetric, null);
  });
});
