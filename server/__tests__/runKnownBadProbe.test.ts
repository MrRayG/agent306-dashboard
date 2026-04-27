/**
 * PR-G — manual known-bad probe runner.
 *
 * Pins the contract documented in server/experiments/runKnownBadProbe.ts:
 *   - constructs one malformed-JSON trial
 *   - runs it through the SAME functions the production grading path uses
 *     (recordTrial → safeParseLLMJson → recordTrialOutcome)
 *   - persists the row with isProbe=true
 *   - returns outcome="caught" when the parser correctly rejects the input
 *   - probe rows are excluded from the default validity aggregates
 *   - independent sanity check: the probe input genuinely fails
 *     safeParseLLMJson (defends against future parser regressions that
 *     might silently accept it and flip the probe to a false negative)
 *
 * Run: npx tsx --test server/__tests__/runKnownBadProbe.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-prg-"));
process.env.DATA_DIR = tmpDir;
delete process.env.EXPERIMENT_EXPLORATION;

const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");
const probeMod = await import("../experiments/runKnownBadProbe.js");
const aggregatesMod = await import("../experiments/validityAggregates.js");
const runMod = await import("../experiments/runExperiment.js");
const outcomeMod = await import("../experiments/recordTrialOutcome.js");
const parseMod = await import("../safeParseLLMJson.js");

const { db } = dbMod;
const { experimentTrials } = schemaMod;
const { runKnownBadProbe, KNOWN_BAD_PROBE_INPUT, PROBE_EXPERIMENT_KEY, PROBE_TASK_KEY } = probeMod;
const { getValiditySummary } = aggregatesMod;
const { recordTrial } = runMod;
const { recordTrialOutcome } = outcomeMod;
const { safeParseLLMJson } = parseMod;

function wipeAll(): void {
  try { db.delete(experimentTrials).run(); } catch {}
}

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("PR-G — runKnownBadProbe", () => {
  beforeEach(wipeAll);

  it("constructs a malformed-JSON trial, runs it through the metric path, and returns caught", () => {
    const result = runKnownBadProbe();

    assert.equal(result.outcome, "caught", "known-bad input must be caught by the metric pipeline");
    assert.equal(result.outcomeMetric, 0.0, "caught outcome corresponds to outcomeMetric=0.0");
    assert.equal(result.malformedInput, KNOWN_BAD_PROBE_INPUT);
    assert.match(result.probeId, /^probe_/);
    assert.ok(result.trialRecordId !== null, "trial row should have been written");

    // The persisted row mirrors a real graded trial — same shape, with
    // isProbe=true and outcomeMetric=0.0.
    const row = db.select().from(experimentTrials).all()
      .find((r: any) => r.id === result.trialRecordId);
    assert.ok(row, "probe row should be in experiment_trials");
    assert.equal(row!.experimentKey, PROBE_EXPERIMENT_KEY);
    assert.equal(row!.taskKey, PROBE_TASK_KEY);
    assert.equal(row!.isProbe, true);
    assert.equal(row!.outcomeMetric, 0.0);
    assert.ok(row!.outcomeRecordedAt, "outcome timestamp should be written");
  });

  it("uses the same parse function the production grading path uses", () => {
    // Independent sanity check: the canonical malformation must genuinely
    // defeat safeParseLLMJson. If a future repair-layer change starts
    // accepting this input as JSON, this test fails before runKnownBadProbe
    // silently flips to "missed" in production.
    const parsed = safeParseLLMJson(KNOWN_BAD_PROBE_INPUT, "test.knownBad");
    assert.equal(parsed, null, "the canonical malformation must produce null from safeParseLLMJson");
  });

  it("probe rows are excluded from the default validity aggregates", () => {
    // Seed one real graded trial + one probe trial. The summary should
    // count only the real trial in totalGraded / aggregateValidity.
    const realId = recordTrial({
      experimentKey: "exp-real",
      arm: "baseline",
      taskKey: "analysis-intake",
      resolvedModel: "google/gemini-3-flash-preview",
    });
    assert.ok(realId !== null);
    recordTrialOutcome(realId!, 1.0);

    const probe = runKnownBadProbe();
    assert.equal(probe.outcome, "caught");

    const summary = getValiditySummary();
    assert.equal(summary.totalGraded, 1, "aggregates count only non-probe graded trials");
    assert.equal(summary.aggregateValidity, 1.0);
    assert.equal(summary.baselineCount, 1);

    // The probe row appears in the dedicated probes section of the summary.
    assert.equal(summary.probes.length, 1);
    assert.equal(summary.probes[0].outcome, "caught");
    assert.equal(summary.probes[0].outcomeMetric, 0.0);

    // None of the stratified breakdowns include the probe row's task or
    // resolved model — the probe surface is named distinctly so it cannot
    // collide with a real production task.
    assert.ok(
      !summary.byTaskShape.some(s => s.key === "probe"),
      "probe taskShape should not be in default aggregation",
    );
  });

  it("runs the same recordTrial → recordTrialOutcome chain as production trials", () => {
    // Smoke test: seed a real trial via recordTrial+recordTrialOutcome, then
    // a probe via runKnownBadProbe. Both rows should be visible in the
    // experiment_trials table and indistinguishable in shape (same columns
    // populated, same outcome semantics) — the only difference is isProbe.
    const realId = recordTrial({
      experimentKey: "exp-shape",
      arm: "treatment",
      taskKey: "analysis-intake",
      resolvedModel: "openai/gpt-5",
    });
    assert.ok(realId !== null);
    recordTrialOutcome(realId!, 1.0);

    const probe = runKnownBadProbe();
    const rows = db.select().from(experimentTrials).all() as any[];
    assert.equal(rows.length, 2);

    const realRow = rows.find(r => r.id === realId);
    const probeRow = rows.find(r => r.id === probe.trialRecordId);
    assert.ok(realRow);
    assert.ok(probeRow);

    // Same set of populated columns:
    for (const col of ["experimentKey", "arm", "taskKey", "resolvedModel", "outcomeMetric", "outcomeRecordedAt", "recordedAt"]) {
      assert.ok(realRow[col] !== undefined && realRow[col] !== null,
        `real row should have ${col} populated`);
      assert.ok(probeRow[col] !== undefined && probeRow[col] !== null,
        `probe row should have ${col} populated`);
    }
    // Only the marker differs.
    assert.equal(realRow.isProbe, false);
    assert.equal(probeRow.isProbe, true);
  });
});
