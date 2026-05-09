/**
 * Tests for the Phase 2d decision evidence persistence module.
 *
 * Spec invariants this file pins:
 *   1. Append events for each Phase 2c verdict (promote / reject / continue
 *      / needs_review) round-trip via the JSONL ledger.
 *   2. Event ids match the documented `evt_<unix-ms>_<base36>` pattern and
 *      are unique across rapid successive calls.
 *   3. The full evidence payload is preserved exactly.
 *   4. The ledger is append-only — earlier records survive subsequent appends
 *      and the reader tolerates a corrupt line.
 *   5. Invalid / refusal-shaped inputs cannot be persisted.
 *   6. DATA_DIR isolation works — the ledger is written into the test temp
 *      directory and not into the repo's `data/`.
 *   7. Appending an event does NOT mutate `data/research_lab.json` or
 *      `data/memory_knowledge.json` fixtures (no auto-promotion side effect).
 *   8. The `readDecisionEventsForHypothesis` filter narrows correctly.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redirect DATA_DIR to a temp dir BEFORE importing the module so dataPaths.ts
// sees the override at first import. Same pattern as improvementArchive.test.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2d-events-test-"));
process.env.DATA_DIR = TMP;

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB    = path.join(REPO_ROOT, "data", "memory_knowledge.json");

const {
  appendDecisionEvent,
  readDecisionEvents,
  readDecisionEventsTail,
  readDecisionEventsForHypothesis,
} = await import("../experiments/hypothesisDecisionEvents.ts");

const {
  decideExperimentOutcome,
} = await import("../experiments/hypothesisExperimentDecision.ts");
const {
  bindCandidateMetric,
} = await import("../experiments/hypothesisMetricBinding.ts");
const {
  evaluateHypothesisForExperiment,
} = await import("../experiments/hypothesisExperimentSelector.ts");

import type {
  ExperimentDecision,
  ExperimentDecisionInput,
  ArmAggregate,
} from "../experiments/hypothesisExperimentDecision.js";
import type { MetricBinding } from "../experiments/hypothesisMetricBinding.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

const LEDGER_FILE = path.join(TMP, "experiment_decision_events.jsonl");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function mkHyp(overrides: Partial<HygieneAwareHypothesis> = {}): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:         "hyp_phase2d_test",
    claim:      "Routine-tier JSON validity will exceed 0.95 on analysis-intake",
    basis:      "Phase 1 baseline aggregate hovers at 0.93",
    metric:     "routine_task_json_validity",
    prediction: "≥0.95 mean outcome_metric across non-probe trials by 2026-Q3",
    timeframe:  "2026-Q3",
    status:     "testing",
    confidence: "medium",
    formedAt:   new Date().toISOString(),
    measurementPath:
      "experiment_trials.outcome_metric (graded by safeParseLLMJson, isProbe=false)",
  };
  return { ...base, hygieneTag: "ready_for_experiment", ...overrides };
}

function mkBinding(): MetricBinding {
  const decision = evaluateHypothesisForExperiment(mkHyp());
  if (!decision.ok) throw new Error("test fixture: selector refused");
  const bound = bindCandidateMetric(decision.candidate);
  if (!bound.ok) throw new Error("test fixture: binder refused");
  return bound;
}

function arm(count: number, metric: number): ArmAggregate {
  return { count, metric };
}

const NOW = new Date("2026-05-09T12:00:00.000Z");

function decide(
  baseline: ArmAggregate,
  treatment: ArmAggregate,
  extra: Partial<ExperimentDecisionInput> = {},
): ExperimentDecision {
  return decideExperimentOutcome(
    { binding: mkBinding(), baseline, treatment, ...extra },
    NOW,
  );
}

// Capture the (possibly nonexistent) state of the live data fixtures so we
// can assert below that nothing was touched.
function snapshotFile(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
const RESEARCH_SNAPSHOT = snapshotFile(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT   = snapshotFile(REAL_MEMORY_KB);

before(() => {
  try { fs.unlinkSync(LEDGER_FILE); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ── Append + round-trip ─────────────────────────────────────────────────────

describe("appendDecisionEvent — verdict round-trips", () => {
  it("persists a promote decision and reads it back", () => {
    const d = decide(arm(20, 0.90), arm(20, 0.96));
    assert.equal(d.verdict, "promote");
    const r = appendDecisionEvent({
      decision:    d,
      source:      "test:fixture",
      ruleVersion: "phase2c.v1",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.event.decision, "promote");
    assert.equal(r.event.reasonCode, "primary_metric_better");
    assert.equal(r.event.metricKey, "routine_task_json_validity");
    assert.equal(r.event.hypothesisId, "hyp_phase2d_test");
    assert.equal(r.event.decidedAt, NOW.toISOString());
    assert.equal(r.event.ruleVersion, "phase2c.v1");
    assert.equal(r.event.source, "test:fixture");

    const all = readDecisionEvents();
    assert.equal(all.length, 1);
    assert.equal(all[0].eventId, r.event.eventId);
    assert.deepEqual(all[0].evidence, d.evidence);
    assert.deepEqual(all[0].thresholdsUsed, d.thresholdsUsed);
  });

  it("persists reject / continue / needs_review verdicts with the right reason codes", () => {
    const beforeCount = readDecisionEvents().length;

    // reject — primary metric clearly worse (>=5pp worse, sample met).
    const dReject = decide(arm(20, 0.95), arm(20, 0.85));
    assert.equal(dReject.verdict, "reject");
    assert.equal(dReject.reasonCode, "primary_metric_worse");
    assert.equal(
      appendDecisionEvent({ decision: dReject, source: "t", ruleVersion: "phase2c.v1" }).ok,
      true,
    );

    // continue — sample below per-arm minimum (default 15).
    const dContinue = decide(arm(5, 0.90), arm(5, 0.92));
    assert.equal(dContinue.verdict, "continue");
    assert.equal(dContinue.reasonCode, "insufficient_sample");
    assert.equal(
      appendDecisionEvent({ decision: dContinue, source: "t", ruleVersion: "phase2c.v1" }).ok,
      true,
    );

    // needs_review — invalid aggregate (NaN metric).
    const dNeedsReview = decide(arm(20, Number.NaN), arm(20, 0.92));
    assert.equal(dNeedsReview.verdict, "needs_review");
    assert.equal(dNeedsReview.reasonCode, "invalid_aggregate");
    assert.equal(
      appendDecisionEvent({ decision: dNeedsReview, source: "t", ruleVersion: "phase2c.v1" }).ok,
      true,
    );

    const all = readDecisionEvents();
    assert.equal(all.length, beforeCount + 3);
    const verdicts = all.slice(-3).map(e => e.decision);
    assert.deepEqual(verdicts, ["reject", "continue", "needs_review"]);
  });
});

// ── Event id format + uniqueness ────────────────────────────────────────────

describe("event ids", () => {
  it("match the evt_<unix-ms>_<base36> pattern and are unique across rapid appends", () => {
    const d = decide(arm(20, 0.90), arm(20, 0.96));
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = appendDecisionEvent({
        decision: d, source: `t${i}`, ruleVersion: "phase2c.v1",
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.match(r.event.eventId, /^evt_\d+_[0-9a-z]{6}$/);
      ids.add(r.event.eventId);
    }
    assert.equal(ids.size, 20);
  });
});

// ── Evidence payload preserved ──────────────────────────────────────────────

describe("evidence payload", () => {
  it("preserves the evidence array and thresholdsUsed exactly", () => {
    const d = decide(
      arm(20, 0.90),
      arm(20, 0.96),
      {
        guardrails: [
          { name: "judge_outage_rate", passed: true, fatal: true },
        ],
        thresholds: { promoteAbsoluteDelta: 0.04 },
      },
    );
    const r = appendDecisionEvent({
      decision: d, source: "t", ruleVersion: "phase2c.v1",
      binding: {
        hypothesisId:       d.hypothesisId,
        metricKey:          d.metricKey,
        matchedDataSources: ["experiment_trials.outcome_metric"],
      },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const all = readDecisionEvents();
    const written = all.find(e => e.eventId === r.event.eventId)!;
    assert.deepEqual(written.evidence, d.evidence);
    assert.deepEqual(written.thresholdsUsed, d.thresholdsUsed);
    assert.equal(written.thresholdsUsed.promoteAbsoluteDelta, 0.04);
    assert.equal(written.binding?.metricKey, "routine_task_json_validity");
    assert.deepEqual(written.binding?.matchedDataSources, ["experiment_trials.outcome_metric"]);
  });
});

// ── Append-only behaviour + reader tolerance ────────────────────────────────

describe("append-only behaviour", () => {
  it("earlier records survive subsequent appends, and the reader skips corrupt lines", () => {
    const d = decide(arm(20, 0.90), arm(20, 0.96));
    const before = readDecisionEvents().length;
    const r1 = appendDecisionEvent({ decision: d, source: "a1", ruleVersion: "phase2c.v1" });
    const r2 = appendDecisionEvent({ decision: d, source: "a2", ruleVersion: "phase2c.v1" });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);

    // Inject a corrupt line in the middle of the file.
    fs.appendFileSync(LEDGER_FILE, "this-is-not-json\n", "utf8");

    const r3 = appendDecisionEvent({ decision: d, source: "a3", ruleVersion: "phase2c.v1" });
    assert.equal(r3.ok, true);

    const all = readDecisionEvents();
    assert.equal(all.length, before + 3);
    const tail3 = all.slice(-3).map(e => e.source);
    assert.deepEqual(tail3, ["a1", "a2", "a3"]);

    // The corrupt line is still on disk but did not break the reader.
    const raw = fs.readFileSync(LEDGER_FILE, "utf8");
    assert.ok(raw.includes("this-is-not-json"));
  });

  it("readDecisionEventsTail returns most-recent first", () => {
    const tail = readDecisionEventsTail(2);
    assert.equal(tail.length, 2);
    assert.equal(tail[0].source, "a3");
    assert.equal(tail[1].source, "a2");
  });
});

// ── Invalid / refusal inputs are refused ────────────────────────────────────

describe("input validation", () => {
  const goodDecision = (): ExperimentDecision =>
    decide(arm(20, 0.90), arm(20, 0.96));

  it("refuses to persist when source is empty", () => {
    const r = appendDecisionEvent({
      decision: goodDecision(), source: "  ", ruleVersion: "phase2c.v1",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /source/i);
  });

  it("refuses to persist when ruleVersion is empty", () => {
    const r = appendDecisionEvent({
      decision: goodDecision(), source: "t", ruleVersion: "",
    });
    assert.equal(r.ok, false);
  });

  it("refuses to persist a decision with an unrecognised verdict", () => {
    const d = goodDecision();
    const tampered = { ...d, verdict: "approve" as any };
    const r = appendDecisionEvent({
      decision: tampered, source: "t", ruleVersion: "phase2c.v1",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /verdict/i);
  });

  it("refuses to persist a decision with an unrecognised reason code", () => {
    const d = goodDecision();
    const tampered = { ...d, reasonCode: "metric_meh" as any };
    const r = appendDecisionEvent({
      decision: tampered, source: "t", ruleVersion: "phase2c.v1",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /reason/i);
  });

  it("refuses to persist when hypothesisId / metricKey / decidedAt are blank", () => {
    const d = goodDecision();
    for (const field of ["hypothesisId", "metricKey", "decidedAt"] as const) {
      const tampered = { ...d, [field]: "" } as ExperimentDecision;
      const r = appendDecisionEvent({
        decision: tampered, source: "t", ruleVersion: "phase2c.v1",
      });
      assert.equal(r.ok, false);
    }
  });

  it("refuses to persist a Phase 2b refusal (cannot pass by construction, but defensive validator catches it)", () => {
    // A `MetricBindingRefusal` lacks a `verdict` field entirely; the validator
    // must reject it, even if a caller force-coerces it to ExperimentDecision.
    const refusalShaped = {
      hypothesisId: "hyp_x",
      metricKey:    "",
      decidedAt:    "",
      verdict:      undefined,
      reasonCode:   undefined,
      reason:       "",
      evidence:     [],
      thresholdsUsed: {},
      candidate:    { hypothesisId: "hyp_x", origin: "research_lab.hypotheses", tag: "ready_for_experiment" },
    } as unknown as ExperimentDecision;
    const r = appendDecisionEvent({
      decision: refusalShaped, source: "t", ruleVersion: "phase2c.v1",
    });
    assert.equal(r.ok, false);
  });

  it("does not write to the ledger when validation refuses", () => {
    const beforeRaw = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
    appendDecisionEvent({
      decision: { ...goodDecision(), verdict: "approve" as any },
      source: "t", ruleVersion: "phase2c.v1",
    });
    const afterRaw = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
    assert.equal(afterRaw, beforeRaw);
  });
});

// ── DATA_DIR isolation ──────────────────────────────────────────────────────

describe("DATA_DIR isolation", () => {
  it("writes the ledger under DATA_DIR, not the repo's data/ directory", () => {
    assert.ok(fs.existsSync(LEDGER_FILE), "expected ledger inside the temp DATA_DIR");
    const repoDataLedger = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
    assert.equal(
      fs.existsSync(repoDataLedger),
      false,
      "ledger leaked into the repo's data/ directory",
    );
  });

  it("does not mutate research_lab.json or memory_knowledge.json fixtures", () => {
    const research = snapshotFile(REAL_RESEARCH_LAB);
    const memory   = snapshotFile(REAL_MEMORY_KB);
    assert.equal(research.exists, RESEARCH_SNAPSHOT.exists);
    assert.equal(research.content, RESEARCH_SNAPSHOT.content);
    assert.equal(memory.exists,   MEMORY_SNAPSHOT.exists);
    assert.equal(memory.content,  MEMORY_SNAPSHOT.content);
  });
});

// ── Per-hypothesis filter ───────────────────────────────────────────────────

describe("readDecisionEventsForHypothesis", () => {
  it("returns only events for the requested hypothesis id", () => {
    const d = decide(arm(20, 0.90), arm(20, 0.96));
    const dOther: ExperimentDecision = { ...d, hypothesisId: "hyp_other_phase2d" };
    appendDecisionEvent({ decision: dOther, source: "t", ruleVersion: "phase2c.v1" });

    const onlyOther = readDecisionEventsForHypothesis("hyp_other_phase2d");
    assert.ok(onlyOther.length >= 1);
    for (const ev of onlyOther) {
      assert.equal(ev.hypothesisId, "hyp_other_phase2d");
    }

    const noneForUnknown = readDecisionEventsForHypothesis("hyp_does_not_exist");
    assert.equal(noneForUnknown.length, 0);

    const blank = readDecisionEventsForHypothesis("");
    assert.equal(blank.length, 0);
  });
});
