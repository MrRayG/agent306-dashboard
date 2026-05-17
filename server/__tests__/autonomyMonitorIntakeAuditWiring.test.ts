/**
 * Tests for the Hypothesis Intake Audit panel wiring on the Autonomy
 * Monitor.
 *
 * Invariants pinned by this file:
 *   1. The autonomy-monitor snapshot exposes `hypothesisIntakeAudit` with a
 *      well-shaped schema even when research_lab.json is missing.
 *   2. When research_lab.json is missing, dataMissingNotes includes the
 *      absolute path (so an operator knows where to put or look for the
 *      file) and a tip about DATA_DIR.
 *   3. When research_lab.json exists, dataMissingNotes for that file is
 *      empty.
 *   4. The intake-audit block is present alongside every other panel block
 *      already on the snapshot (no other block is dropped).
 *
 * Run: npx tsx --test server/__tests__/autonomyMonitorIntakeAuditWiring.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-monitor-intake-audit-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const LAB = path.join(TMP, "research_lab.json");

function clearLab(): void { if (fs.existsSync(LAB)) fs.unlinkSync(LAB); }

const { buildAutonomyMonitorSnapshot } = await import("../autonomyMonitor.ts");
const { buildHypothesisIntakeAuditVisibility } = await import("../hypothesisIntakeAuditVisibility.ts");

describe("autonomy-monitor — hypothesisIntakeAudit panel wiring", () => {
  beforeEach(() => clearLab());

  it("includes hypothesisIntakeAudit on the snapshot", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const block = (snap as any).hypothesisIntakeAudit;
    assert.ok(block, "snapshot must expose hypothesisIntakeAudit");
    assert.equal(block.schemaVersion, "phase-intake-audit-1");
    assert.equal(block.label, "hypothesis-intake-audit-visibility");
    assert.ok(Array.isArray(block.resetBuckets));
    assert.ok(Array.isArray(block.formationSources));
    assert.ok(typeof block.capPolicy === "object");
  });

  it("includes every other expected panel block alongside intake-audit", () => {
    const snap = buildAutonomyMonitorSnapshot() as any;
    for (const k of [
      "promotionGateAuthority",
      "workloadBudget",
      "selfRuleEnforcement",
      "hypothesisIntakeAudit",
      "stages",
      "pipelineSummary",
    ]) {
      assert.ok(snap[k], `snapshot must include ${k}`);
    }
  });

  it("dataMissingNotes carries the absolute path + DATA_DIR when research_lab.json is missing", () => {
    clearLab();
    const v = buildHypothesisIntakeAuditVisibility();
    const labNote = v.dataMissingNotes.find(n => n.includes("research_lab.json"));
    assert.ok(labNote, "dataMissingNotes must mention research_lab.json");
    assert.ok(labNote!.includes(LAB), "note must include the absolute path");
    assert.ok(labNote!.includes("DATA_DIR"), "note must include DATA_DIR for triage");
  });

  it("dataMissingNotes does NOT flag research_lab.json once the file exists", () => {
    fs.writeFileSync(LAB, JSON.stringify({ hypotheses: [], topics: [], stats: {} }));
    const v = buildHypothesisIntakeAuditVisibility();
    const flagged = v.dataMissingNotes.find(n => n.includes("research_lab.json missing"));
    assert.equal(flagged, undefined);
  });
});
