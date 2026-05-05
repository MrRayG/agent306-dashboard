/**
 * Tests for the PR #280 Hypothesis Data-Source Gate.
 *
 *   - Pure-function tests over evaluateDataSourceGate.
 *   - Integration tests over testHypothesisDetailed (the forming→testing
 *     transition that the API endpoint calls).
 *
 * Run: npx tsx --test server/__tests__/hypothesisDataSourceGate.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Redirect data dir BEFORE importing engines that read DATA_DIR at module load.
// All engine imports below MUST be dynamic (`await import`) so the env-var
// assignment lands before dataPaths.ts captures DATA_DIR.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-data-source-gate-"));
process.env.DATA_DIR = tmpDir;

const labPath = path.join(tmpDir, "research_lab.json");

let researchRepo: {
  writeResearchBlob: (b: unknown) => void;
  db: any;
  researchLab: any;
} | null = null;
let testHypothesisDetailed: typeof import("../researchEngine.js").testHypothesisDetailed;
let evaluateDataSourceGate: typeof import("../hypothesisDataSourceGate.js").evaluateDataSourceGate;

{
  const gateMod = await import("../hypothesisDataSourceGate.js");
  evaluateDataSourceGate = gateMod.evaluateDataSourceGate;
  const engine = await import("../researchEngine.js");
  testHypothesisDetailed = engine.testHypothesisDetailed;
  const repo = await import("../repositories/researchRepository.js");
  const dbMod = await import("../db.js");
  const schemaMod = await import("@shared/schema");
  researchRepo = {
    writeResearchBlob: repo.writeResearchBlob,
    db: dbMod.db,
    researchLab: schemaMod.researchLab,
  };
}

function writeLab(hypotheses: any[]): void {
  const lab = {
    topics:      [],
    hypotheses,
    lastUpdated: new Date().toISOString(),
    stats: {
      totalResearched:     0,
      totalPublished:      0,
      totalDeclined:       0,
      hypothesesFormed:    hypotheses.length,
      hypothesesConfirmed: 0,
    },
  };
  fs.writeFileSync(labPath, JSON.stringify(lab, null, 2));
  if (researchRepo) {
    try { researchRepo.db.delete(researchRepo.researchLab).run(); } catch {}
    try { researchRepo.writeResearchBlob(lab); } catch {}
  }
}

function readLab(): any {
  return JSON.parse(fs.readFileSync(labPath, "utf8"));
}

function mkHyp(overrides: Record<string, unknown> = {}): any {
  return {
    id:         "hyp_dsgate_1",
    claim:      "GPT-5 will exceed 92% on MMLU within 6 months.",
    basis:      "current GPT-4 at 86.5% on MMLU; trend over GPT-3 → 4 was +20pts",
    metric:     "MMLU benchmark score on the public leaderboard",
    prediction: "GPT-5 scores ≥ 92% on MMLU",
    timeframe:  "6 months",
    status:     "forming",
    confidence: "medium",
    formedAt:   new Date().toISOString(),
    ...overrides,
  };
}

// ── Pure-function tests ──────────────────────────────────────────────────────

describe("evaluateDataSourceGate — pure", () => {
  it("blocks when no measurement path / metric / basis is provided", () => {
    const r = evaluateDataSourceGate({
      claim: "Something will happen.",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.code, "missing_measurement_path");
      assert.equal(r.recommendedRoute, "block");
      assert.match(r.reason, /measurementPath/);
    }
  });

  it("blocks when measurement path is too short to be meaningful", () => {
    const r = evaluateDataSourceGate({
      measurementPath: "x",
      metric: "x",
      basis: "x",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.code, "missing_measurement_path");
  });

  it("passes when an accessible source is named (heuristic match)", () => {
    const r = evaluateDataSourceGate({
      measurementPath: "OpenAlex citation count for arXiv:2402.12345",
    });
    assert.equal(r.ok, true);
  });

  it("passes when metric describes a public benchmark (fallback)", () => {
    const r = evaluateDataSourceGate({
      metric: "MMLU benchmark score on the public leaderboard",
    });
    assert.equal(r.ok, true);
  });

  it("passes when basis names a public corpus (fallback)", () => {
    const r = evaluateDataSourceGate({
      basis: "github commit log of facebook/llama",
    });
    assert.equal(r.ok, true);
  });

  it("blocks with inaccessible-source verdict when source is described as private/internal", () => {
    const r = evaluateDataSourceGate({
      measurementPath: "Anthropic's internal eval scores (proprietary, not public)",
    });
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.equal(r.code, "inaccessible_source");
      assert.equal(r.recommendedRoute, "speculative-watchlist");
    }
  });

  it("respects operator-asserted accessibility=true (overrides heuristic)", () => {
    const r = evaluateDataSourceGate({
      measurementPath: "Anthropic's internal proprietary scoreboard",
      measurementPathAccessible: true,
    });
    assert.equal(r.ok, true);
  });

  it("respects operator-asserted accessibility=false (overrides public hint)", () => {
    const r = evaluateDataSourceGate({
      measurementPath: "OpenAlex citation count",
      measurementPathAccessible: false,
    });
    assert.equal(r.ok, false);
    if (r.ok === false) assert.equal(r.recommendedRoute, "speculative-watchlist");
  });

  it("passes when a 'reasonable proxy' is explicitly named", () => {
    const r = evaluateDataSourceGate({
      measurementPath: "proxy: GitHub release cadence as stand-in for internal velocity",
    });
    assert.equal(r.ok, true);
  });

  it("passes (conservative) when no inaccessibility signal and no public hint", () => {
    // Source is unfamiliar but not described as private. Don't starve testing
    // queue on heuristic uncertainty; the feasibility gate catches the rest.
    const r = evaluateDataSourceGate({
      measurementPath: "Quarterly aggregate report from MetricsCo dashboard",
    });
    assert.equal(r.ok, true);
  });
});

// ── Integration: testHypothesisDetailed ──────────────────────────────────────

describe("testHypothesisDetailed — forming → testing gate", () => {
  beforeEach(() => {
    writeLab([mkHyp()]);
  });
  afterEach(() => {
    if (fs.existsSync(labPath)) fs.unlinkSync(labPath);
  });

  it("succeeds when measurement path + accessible source are present", () => {
    const r = testHypothesisDetailed("hyp_dsgate_1");
    assert.equal(r.ok, true, `expected pass, got: ${JSON.stringify(r)}`);
    assert.equal(r.status, "testing");
    const h = readLab().hypotheses[0];
    assert.equal(h.status, "testing");
    assert.ok(h.testingStartedAt);
    assert.equal(h.dataSourceGateBlockedAt, undefined);
  });

  it("blocks when no measurement path / metric / basis exists", () => {
    writeLab([mkHyp({ metric: "", basis: "", measurementPath: "" })]);
    const r = testHypothesisDetailed("hyp_dsgate_1");
    assert.equal(r.ok, false);
    assert.equal(r.blockedBy, "data_source_gate");
    assert.equal(r.gateCode, "missing_measurement_path");
    // State unchanged — still forming.
    const h = readLab().hypotheses[0];
    assert.equal(h.status, "forming");
    assert.ok(h.dataSourceGateBlockedAt);
    assert.match(h.dataSourceGateReason, /measurementPath/);
  });

  it("blocks when the only source is described as proprietary/internal", () => {
    writeLab([mkHyp({
      metric: "",
      basis: "",
      measurementPath: "OpenAI's internal proprietary eval scores (NDA only)",
    })]);
    const r = testHypothesisDetailed("hyp_dsgate_1");
    assert.equal(r.ok, false);
    assert.equal(r.blockedBy, "data_source_gate");
    assert.equal(r.gateCode, "inaccessible_source");
    const h = readLab().hypotheses[0];
    // Per spec: do not invent state. Leave in forming.
    assert.equal(h.status, "forming");
    assert.ok(h.dataSourceGateReason);
  });

  it("operator override (measurementPathAccessible=true) lets transition through", () => {
    writeLab([mkHyp({
      metric: "",
      basis: "",
      measurementPath: "OpenAI's internal proprietary eval scores",
      measurementPathAccessible: true,
    })]);
    const r = testHypothesisDetailed("hyp_dsgate_1");
    assert.equal(r.ok, true);
    assert.equal(readLab().hypotheses[0].status, "testing");
  });

  it("does not modify hypotheses already in 'testing'", () => {
    writeLab([mkHyp({ status: "testing", testingStartedAt: "2026-04-01T00:00:00.000Z" })]);
    const r = testHypothesisDetailed("hyp_dsgate_1");
    assert.equal(r.ok, false);
    assert.equal(r.blockedBy, "wrong_state");
    const h = readLab().hypotheses[0];
    // Still in testing, fields untouched.
    assert.equal(h.status, "testing");
    assert.equal(h.testingStartedAt, "2026-04-01T00:00:00.000Z");
    assert.equal(h.dataSourceGateBlockedAt, undefined);
  });

  it("does not modify confirmed/rejected/etc — non-forming transitions are refused", () => {
    for (const status of ["confirmed", "rejected", "expired", "stale-retired"] as const) {
      writeLab([mkHyp({ status })]);
      const r = testHypothesisDetailed("hyp_dsgate_1");
      assert.equal(r.ok, false);
      assert.equal(r.blockedBy, "wrong_state");
      assert.equal(readLab().hypotheses[0].status, status);
    }
  });

  it("returns 'not_found' for unknown id", () => {
    const r = testHypothesisDetailed("nonexistent_id");
    assert.equal(r.ok, false);
    assert.equal(r.blockedBy, "not_found");
  });

  it("clears stale block stamps when transition succeeds", () => {
    writeLab([mkHyp({
      dataSourceGateBlockedAt: "2026-04-01T00:00:00.000Z",
      dataSourceGateReason:    "stale block from earlier attempt",
    })]);
    const r = testHypothesisDetailed("hyp_dsgate_1");
    assert.equal(r.ok, true);
    const h = readLab().hypotheses[0];
    assert.equal(h.status, "testing");
    assert.equal(h.dataSourceGateBlockedAt, undefined);
    assert.equal(h.dataSourceGateReason, undefined);
  });
});
