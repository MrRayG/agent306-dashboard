/**
 * Calibration — recordOutcome flag-gating test.
 *
 * Pins the Phase 0 invariant: with `featureFlags.calibrationCapture = false`
 * (the default), `recordOutcome` is a no-op — no row is written to the
 * `hypothesis_outcomes` table even when called with a fully-formed
 * resolved hypothesis. Phase 1 will flip the flag in a separate PR.
 *
 * The test redirects DATA_DIR before importing the calibration module so
 * the SQLite handle in db.ts resolves to a tmpDir-rooted file, matching
 * the pattern used by hypothesisActionGate.test.ts.
 *
 * Run: npx tsx --test server/__tests__/hypothesisOutcomesWrite.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Set DATA_DIR + force the flag OFF before the calibration module loads.
// featureFlags reads process.env at module load, so this MUST run before
// the dynamic imports below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-calib-"));
process.env.DATA_DIR = tmpDir;
delete process.env.CALIBRATION_CAPTURE;

const calibrationMod = await import("../calibration/hypothesisOutcomes.js");
const flagsMod = await import("../featureFlags.js");
const dbMod = await import("../db.js");
const schemaMod = await import("@shared/schema");

const { recordOutcome, deriveOutcome } = calibrationMod;
const { featureFlags } = flagsMod;
const { db } = dbMod;
const { hypothesisOutcomes } = schemaMod;

function rowCount(): number {
  return db.select().from(hypothesisOutcomes).all().length;
}

describe("recordOutcome — Phase 0 flag-off invariant", () => {
  before(() => {
    try { db.delete(hypothesisOutcomes).run(); } catch {}
  });
  after(() => {
    try { db.delete(hypothesisOutcomes).run(); } catch {}
  });

  it("featureFlags.calibrationCapture defaults to false", () => {
    assert.equal(featureFlags.calibrationCapture, false);
  });

  it("recordOutcome writes no row when the flag is off", () => {
    const before = rowCount();
    recordOutcome({
      id: "hyp_test_1",
      status: "confirmed",
      resolvedAt: new Date().toISOString(),
      confidence: "high",
      trustScore: 92,
      evaluationResult: { verdict: "confirmed", confidence: 0.91 } as any,
      domain: "ai-news",
    });
    const after = rowCount();
    assert.equal(after, before, "no row should be written while flag is off");
  });

  it("recordOutcome is a no-op even for an awaiting-deadline status (terminal-only writes)", () => {
    // Even if someone flips the flag on by mistake at the wrong write site,
    // awaiting-deadline must never write a row. This verifies the
    // deriveOutcome side of that contract directly.
    assert.equal(deriveOutcome("awaiting-deadline"), null);
  });

  it("deriveOutcome maps each terminal status per design §3.3", () => {
    assert.deepEqual(
      deriveOutcome("confirmed"),
      { actualOutcome: true, outcomeWeight: 1.0, outcomeSource: "auto-resolve" },
    );
    assert.deepEqual(
      deriveOutcome("rejected"),
      { actualOutcome: false, outcomeWeight: 1.0, outcomeSource: "auto-resolve" },
    );
    assert.deepEqual(
      deriveOutcome("expired"),
      { actualOutcome: false, outcomeWeight: 0.5, outcomeSource: "deadline-expiry" },
    );
    assert.deepEqual(
      deriveOutcome("data-unavailable"),
      { actualOutcome: false, outcomeWeight: 0.0, outcomeSource: "manual" },
    );
    assert.deepEqual(
      deriveOutcome("stale-retired"),
      { actualOutcome: false, outcomeWeight: 0.0, outcomeSource: "manual" },
    );
    // Anything not in the resolved set returns null too.
    assert.equal(deriveOutcome("forming"), null);
    assert.equal(deriveOutcome("testing"), null);
    assert.equal(deriveOutcome(""), null);
  });
});
