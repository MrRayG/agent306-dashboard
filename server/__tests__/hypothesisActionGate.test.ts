/**
 * Tests for the Post-Resolution Action Gate (Wave 2.3 PR-3).
 *
 * The gate requires any hypothesis transition to a resolved state
 * (confirmed/rejected/expired/awaiting-deadline/data-unavailable/stale-retired)
 * to carry an `actionWithin24h` payload. Rejection paths: missing action,
 * wrong type, empty detail, explicit-none with <40 char detail.
 *
 * Run: npx tsx --test server/__tests__/hypothesisActionGate.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// The research engine reads/writes to a file path derived from dataPath().
// We redirect it via env before importing so tests don't touch prod data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-action-gate-"));
process.env.DATA_DIR = tmpDir;

const labPath = path.join(tmpDir, "research_lab.json");

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
}

function readLab(): any {
  return JSON.parse(fs.readFileSync(labPath, "utf8"));
}

function mkHyp(overrides: Record<string, unknown> = {}): any {
  return {
    id:         overrides.id ?? "hyp_gate_1",
    claim:      "Example claim for gate tests.",
    basis:      "basis",
    metric:     "metric",
    prediction: "something will happen",
    timeframe:  "30 days",
    status:     "testing",
    confidence: "medium",
    formedAt:   new Date().toISOString(),
    ...overrides,
  };
}

// Lazy import so DATA_DIR env is in place first.
const engine = await import("../researchEngine.js");
const { resolveHypothesis, validateResolutionAction } = engine;

describe("Post-Resolution Action Gate — validateResolutionAction", () => {
  it("rejects null/undefined", () => {
    assert.equal(validateResolutionAction(undefined).ok, false);
    assert.equal(validateResolutionAction(null).ok, false);
  });

  it("rejects unknown type", () => {
    const r = validateResolutionAction({ type: "tweet", detail: "something" });
    assert.equal(r.ok, false);
  });

  it("rejects empty detail", () => {
    const r = validateResolutionAction({ type: "blog", detail: "   " });
    assert.equal(r.ok, false);
  });

  it("rejects explicit-none with <40 char detail", () => {
    const r = validateResolutionAction({ type: "explicit-none", detail: "too short" });
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.ok(r.reason.includes("40"), `reason should mention floor: ${r.reason}`);
    }
  });

  it("accepts all five action types with non-trivial detail", () => {
    for (const type of ["blog", "podcast", "new-hypothesis", "source-change"] as const) {
      const r = validateResolutionAction({ type, detail: `commit to ${type}` });
      assert.equal(r.ok, true, `expected ${type} to pass`);
    }
    const e = validateResolutionAction({
      type: "explicit-none",
      detail: "forty-char justification explaining the skip adequately",
    });
    assert.equal(e.ok, true);
  });

  it("stamps committedAt when missing", () => {
    const r = validateResolutionAction({ type: "blog", detail: "go" });
    assert.equal(r.ok, true);
    if (r.ok === true) {
      assert.ok(typeof r.action.committedAt === "string" && r.action.committedAt.length > 0);
    }
  });
});

describe("Post-Resolution Action Gate — resolveHypothesis", () => {
  beforeEach(() => {
    writeLab([mkHyp({ id: "hyp_gate_1" })]);
  });

  afterEach(() => {
    if (fs.existsSync(labPath)) fs.unlinkSync(labPath);
  });

  it("rejects resolution without actionWithin24h (undefined)", () => {
    const ok = resolveHypothesis("hyp_gate_1", "confirmed", "strong evidence", undefined as any);
    assert.equal(ok, false);
    const lab = readLab();
    assert.equal(lab.hypotheses[0].status, "testing");
    assert.equal(lab.hypotheses[0].actionWithin24h, undefined);
  });

  it("rejects resolution with malformed action (wrong type)", () => {
    const ok = resolveHypothesis("hyp_gate_1", "rejected", "bad", { type: "tweet", detail: "x" } as any);
    assert.equal(ok, false);
    assert.equal(readLab().hypotheses[0].status, "testing");
  });

  it("rejects explicit-none with <40 char detail", () => {
    const ok = resolveHypothesis(
      "hyp_gate_1",
      "rejected",
      "weak",
      { type: "explicit-none", detail: "too short" } as any,
    );
    assert.equal(ok, false);
    assert.equal(readLab().hypotheses[0].status, "testing");
  });

  it("accepts blog action and persists it", () => {
    const ok = resolveHypothesis(
      "hyp_gate_1",
      "confirmed",
      "supported by Perplexity + KB",
      { type: "blog", detail: "Draft blog on Web3 market cap pattern" } as any,
    );
    assert.equal(ok, true);
    const h = readLab().hypotheses[0];
    assert.equal(h.status, "confirmed");
    assert.equal(h.actionWithin24h.type, "blog");
    assert.equal(h.actionWithin24h.detail, "Draft blog on Web3 market cap pattern");
    assert.ok(typeof h.actionWithin24h.committedAt === "string");
  });

  it("accepts podcast action", () => {
    const ok = resolveHypothesis(
      "hyp_gate_1",
      "confirmed",
      "r",
      { type: "podcast", detail: "script an episode" } as any,
    );
    assert.equal(ok, true);
    assert.equal(readLab().hypotheses[0].actionWithin24h.type, "podcast");
  });

  it("accepts new-hypothesis action", () => {
    const ok = resolveHypothesis(
      "hyp_gate_1",
      "confirmed",
      "r",
      { type: "new-hypothesis", detail: "spawn follow-up" } as any,
    );
    assert.equal(ok, true);
    assert.equal(readLab().hypotheses[0].actionWithin24h.type, "new-hypothesis");
  });

  it("accepts source-change action on expired", () => {
    const ok = resolveHypothesis(
      "hyp_gate_1",
      "expired",
      "deadline passed",
      { type: "source-change", detail: "audit feed" } as any,
    );
    assert.equal(ok, true);
    const h = readLab().hypotheses[0];
    assert.equal(h.status, "expired");
    assert.equal(h.actionWithin24h.type, "source-change");
  });

  it("accepts explicit-none with >=40 char justification", () => {
    const detail = "No publishable insight — rubric too weak to blog and claim not strong enough to spawn follow-up.";
    const ok = resolveHypothesis(
      "hyp_gate_1",
      "rejected",
      "weak rubric",
      { type: "explicit-none", detail } as any,
    );
    assert.equal(ok, true);
    assert.equal(readLab().hypotheses[0].actionWithin24h.type, "explicit-none");
  });

  it("works for awaiting-deadline / data-unavailable / stale-retired states", () => {
    const statuses = ["awaiting-deadline", "data-unavailable", "stale-retired"] as const;
    for (const status of statuses) {
      writeLab([mkHyp({ id: "hyp_gate_1" })]);
      const ok = resolveHypothesis(
        "hyp_gate_1",
        status,
        `moved to ${status}`,
        { type: "source-change", detail: `waiting on ${status}` } as any,
      );
      assert.equal(ok, true, `expected ${status} to pass gate`);
      assert.equal(readLab().hypotheses[0].status, status);
    }
  });
});

describe("Post-Resolution Action Gate — backward compat", () => {
  it("reads legacy hypothesis without actionWithin24h field", () => {
    // Legacy resolved hypothesis with no actionWithin24h — must remain readable.
    const legacy = mkHyp({
      id: "hyp_legacy_1",
      status: "confirmed",
      resolvedAt: new Date().toISOString(),
      resolution: "Legacy resolved before gate existed",
    });
    writeLab([legacy]);
    const lab = readLab();
    assert.equal(lab.hypotheses[0].id, "hyp_legacy_1");
    assert.equal(lab.hypotheses[0].status, "confirmed");
    assert.equal(lab.hypotheses[0].actionWithin24h, undefined);
    // And a fresh resolution on a different hypothesis still works with the gate.
    writeLab([legacy, mkHyp({ id: "hyp_new_1" })]);
    const ok = resolveHypothesis(
      "hyp_new_1",
      "confirmed",
      "ok",
      { type: "blog", detail: "write it" } as any,
    );
    assert.equal(ok, true);
    const labAfter = readLab();
    const legacyAfter = labAfter.hypotheses.find((h: any) => h.id === "hyp_legacy_1");
    const newAfter    = labAfter.hypotheses.find((h: any) => h.id === "hyp_new_1");
    assert.equal(legacyAfter.actionWithin24h, undefined);
    assert.equal(newAfter.actionWithin24h.type, "blog");
  });
});
