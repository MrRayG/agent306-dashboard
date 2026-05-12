/**
 * Tests for the Phase 2e sandboxed execution wiring module.
 *
 * Spec invariants this file pins:
 *   1. A successful Phase 2b binding plus complete operator controls produces
 *      a SandboxExecutionPlan with all expected fields.
 *   2. Refusal when the feature flag is missing / off.
 *   3. Refusal when operator approval is missing / false.
 *   4. Refusal when the resource cap is missing, non-integer, below the
 *      minimum, or above the hard cap.
 *   5. Refusal when the bound metric is not the operator-authorized metric.
 *   6. Refusal when the experiment kind is not in the supported set.
 *   7. The dryRun discriminant is honoured on the plan.
 *   8. A force-coerced binding refusal cannot become a plan (defense-in-depth).
 *   9. A force-coerced memory-origin binding cannot become a plan
 *      (defense-in-depth on the binding origin).
 *   10. The plan-only invariant: planning never writes the decision-events
 *       ledger, never mutates `data/research_lab.json`, never registers an
 *       experiment, and `applySandboxExecutionPlan` is a no-op stub.
 *
 * Run: npx tsx --test server/__tests__/hypothesisSandboxExecution.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redirect DATA_DIR and DB_PATH so any accidental ledger / data / db write
// would land in the tmpdir rather than the repo's `data/`. The Phase 2e
// module performs no writes, but we want the test to fail loudly if that
// ever changes. These env vars MUST be set before any module that captures
// them at import time (server/dataPaths.ts, server/db.ts) is imported.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2e-sandbox-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_DATA_DIR        = path.join(REPO_ROOT, "data");
const REAL_RESEARCH_LAB    = path.join(REAL_DATA_DIR, "research_lab.json");
const REAL_MEMORY_KB       = path.join(REAL_DATA_DIR, "memory_knowledge.json");
const REAL_AGENT_GOALS     = path.join(REAL_DATA_DIR, "agent_goals.json");
const REAL_COMPETENCY      = path.join(REAL_DATA_DIR, "competencyProfile.json");
const REAL_DECISION_EVENTS = path.join(REAL_DATA_DIR, "experiment_decision_events.jsonl");
const REAL_SANDBOX_REG     = path.join(REAL_DATA_DIR, "sandbox_registration_records.jsonl");
const REAL_DB              = path.join(REAL_DATA_DIR, "agent306.db");

const {
  planSandboxExecution,
  applySandboxExecutionPlan,
  PHASE2E_HARD_MAX_TRIALS,
  PHASE2E_MIN_TRIALS,
  PHASE2E_SUPPORTED_EXPERIMENT_KINDS,
} = await import("../experiments/hypothesisSandboxExecution.ts");

const {
  bindCandidateMetric,
} = await import("../experiments/hypothesisMetricBinding.ts");
const {
  evaluateHypothesisForExperiment,
} = await import("../experiments/hypothesisExperimentSelector.ts");

import type {
  SandboxExecutionControls,
  SandboxExecutionPlan,
} from "../experiments/hypothesisSandboxExecution.js";
import type { MetricBinding } from "../experiments/hypothesisMetricBinding.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function mkHyp(overrides: Partial<HygieneAwareHypothesis> = {}): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:         "hyp_phase2e_test",
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

function controls(overrides: Partial<SandboxExecutionControls> = {}): SandboxExecutionControls {
  return {
    featureFlag:           true,
    operatorApproved:      true,
    dryRun:                false,
    maxTrials:             10,
    allowedMetricKey:      "routine_task_json_validity",
    allowedExperimentKind: "modelRouter",
    ...overrides,
  };
}

const NOW = new Date("2026-05-09T12:00:00.000Z");

// Snapshot the real data files so we can prove the module made no writes.
let researchLabBefore:     string | null = null;
let memoryKbBefore:        string | null = null;
let agentGoalsBefore:      string | null = null;
let competencyBefore:      string | null = null;
let decisionEventsBefore:  string | null = null;
let sandboxRegBefore:      string | null = null;
let dbSizeBefore: number | null = null;
let dbMtimeBefore: number | null = null;

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
}

before(() => {
  // Loud-failure pin: assert env-var redirects are still pointing at TMP,
  // not at the real repo `data/`. If anything earlier in the test process
  // mutated these, fail before we can write live state.
  assert.ok(
    TMP.startsWith(os.tmpdir()) && !TMP.startsWith(REAL_DATA_DIR),
    `TMP must be under os.tmpdir() and not under real data/: TMP=${TMP}`,
  );
  assert.equal(process.env.DATA_DIR, TMP, "DATA_DIR drifted from TMP");
  assert.equal(
    process.env.DB_PATH,
    path.join(TMP, "test.db"),
    "DB_PATH drifted from TMP/test.db",
  );

  researchLabBefore    = readIfExists(REAL_RESEARCH_LAB);
  memoryKbBefore       = readIfExists(REAL_MEMORY_KB);
  agentGoalsBefore     = readIfExists(REAL_AGENT_GOALS);
  competencyBefore     = readIfExists(REAL_COMPETENCY);
  decisionEventsBefore = readIfExists(REAL_DECISION_EVENTS);
  sandboxRegBefore     = readIfExists(REAL_SANDBOX_REG);
  if (fs.existsSync(REAL_DB)) {
    const st = fs.statSync(REAL_DB);
    dbSizeBefore = st.size;
    dbMtimeBefore = st.mtimeMs;
  }
});

after(() => {
  // Best-effort temp dir cleanup. Test failures must not eat earlier signal,
  // so wrap in try/catch.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("planSandboxExecution — accept path", () => {
  it("produces a complete SandboxExecutionPlan when every control is set", () => {
    const binding = mkBinding();
    const result = planSandboxExecution(binding, controls(), NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.executionPlanId, /^plan_\d+_[0-9a-z]{6}$/);
    assert.equal(result.hypothesisId, binding.hypothesisId);
    assert.equal(result.candidateId,  binding.hypothesisId);
    assert.equal(result.metricKey,    "routine_task_json_validity");
    assert.equal(result.sandboxMode,  "sandbox");
    assert.equal(result.dryRun,       false);
    assert.equal(result.experimentKind, "modelRouter");
    assert.deepEqual(result.resourceCaps, { maxTrials: 10 });
    assert.equal(result.plannedAt, NOW.toISOString());

    assert.equal(result.binding.hypothesisId, binding.hypothesisId);
    assert.equal(result.binding.metricKey,    binding.metricKey);
    assert.equal(result.binding.candidateOrigin, "research_lab.hypotheses");
    assert.ok(result.binding.matchedDataSources.length >= 1);

    assert.ok(result.evidence.length >= 5);
    assert.ok(result.evidence.some(e => e.includes("feature flag")));
    assert.ok(result.evidence.some(e => e.includes("resource cap")));
    assert.ok(result.evidence.some(e => e.includes("modelRouter")));
  });

  it("honours dryRun: true on the plan", () => {
    const result = planSandboxExecution(mkBinding(), controls({ dryRun: true }), NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dryRun, true);
    assert.ok(result.evidence.some(e => e.includes("dry run: true")));
  });

  it("carries operator notes through to the evidence trail", () => {
    const result = planSandboxExecution(
      mkBinding(),
      controls({ notes: "approved by ops 2026-05-09" }),
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.evidence.some(e => e.includes("approved by ops 2026-05-09")));
    assert.equal(result.controls.notes, "approved by ops 2026-05-09");
  });

  it("produces unique executionPlanIds across rapid successive calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = planSandboxExecution(mkBinding(), controls(), NOW);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(!seen.has(r.executionPlanId), `duplicate plan id: ${r.executionPlanId}`);
        seen.add(r.executionPlanId);
      }
    }
  });

  it("accepts maxTrials at the lower and upper bounds", () => {
    const lo = planSandboxExecution(mkBinding(), controls({ maxTrials: PHASE2E_MIN_TRIALS }), NOW);
    const hi = planSandboxExecution(mkBinding(), controls({ maxTrials: PHASE2E_HARD_MAX_TRIALS }), NOW);
    assert.equal(lo.ok, true);
    assert.equal(hi.ok, true);
  });
});

// ── Refusal: feature flag ────────────────────────────────────────────────────

describe("planSandboxExecution — feature flag refusals", () => {
  it("refuses when featureFlag is false", () => {
    const result = planSandboxExecution(mkBinding(), controls({ featureFlag: false }), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "feature_flag_off");
    assert.match(result.reason, /feature flag/i);
  });

  it("refuses when featureFlag is omitted (treated as not-true)", () => {
    const c: any = { ...controls() };
    delete c.featureFlag;
    const result = planSandboxExecution(mkBinding(), c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "feature_flag_off");
  });
});

// ── Refusal: operator approval ───────────────────────────────────────────────

describe("planSandboxExecution — operator approval refusals", () => {
  it("refuses when operatorApproved is false", () => {
    const result = planSandboxExecution(mkBinding(), controls({ operatorApproved: false }), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "operator_not_approved");
  });

  it("refuses when operatorApproved is omitted", () => {
    const c: any = { ...controls() };
    delete c.operatorApproved;
    const result = planSandboxExecution(mkBinding(), c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "operator_not_approved");
  });
});

// ── Refusal: resource cap ────────────────────────────────────────────────────

describe("planSandboxExecution — resource cap refusals", () => {
  it("refuses when maxTrials is missing", () => {
    const c: any = { ...controls() };
    delete c.maxTrials;
    const result = planSandboxExecution(mkBinding(), c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "missing_resource_cap");
  });

  it("refuses when maxTrials is NaN / Infinity / non-integer", () => {
    for (const bad of [NaN, Infinity, -Infinity, 3.5]) {
      const result = planSandboxExecution(mkBinding(), controls({ maxTrials: bad }), NOW);
      assert.equal(result.ok, false, `expected refusal for maxTrials=${bad}`);
      if (result.ok) continue;
      assert.equal(result.code, "missing_resource_cap");
    }
  });

  it("refuses when maxTrials is below the minimum", () => {
    for (const bad of [0, -1, -100]) {
      const result = planSandboxExecution(mkBinding(), controls({ maxTrials: bad }), NOW);
      assert.equal(result.ok, false, `expected refusal for maxTrials=${bad}`);
      if (result.ok) continue;
      assert.equal(result.code, "missing_resource_cap");
    }
  });

  it("refuses when maxTrials exceeds the hard cap", () => {
    const result = planSandboxExecution(
      mkBinding(),
      controls({ maxTrials: PHASE2E_HARD_MAX_TRIALS + 1 }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "resource_cap_exceeds_limit");
    assert.match(result.reason, new RegExp(`${PHASE2E_HARD_MAX_TRIALS}`));
  });
});

// ── Refusal: metric / kind ───────────────────────────────────────────────────

describe("planSandboxExecution — metric / experiment-kind refusals", () => {
  it("refuses when allowedMetricKey is missing", () => {
    const c: any = { ...controls() };
    delete c.allowedMetricKey;
    const result = planSandboxExecution(mkBinding(), c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "metric_not_allowed");
  });

  it("refuses when binding metricKey is not the operator-authorized metric", () => {
    const result = planSandboxExecution(
      mkBinding(),
      controls({ allowedMetricKey: "some_other_metric" }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "metric_not_allowed");
    assert.match(result.reason, /not the operator-authorized metric/);
  });

  it("refuses when allowedExperimentKind is not in the supported set", () => {
    const result = planSandboxExecution(
      mkBinding(),
      controls({ allowedExperimentKind: "promptVariation" as any }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "experiment_kind_not_allowed");
  });

  it("only accepts the documented supported kinds", () => {
    assert.deepEqual([...PHASE2E_SUPPORTED_EXPERIMENT_KINDS], ["modelRouter"]);
  });
});

// ── Refusal: defense-in-depth on the binding ─────────────────────────────────

describe("planSandboxExecution — binding defense-in-depth", () => {
  it("refuses a force-coerced MetricBindingRefusal", () => {
    const refusal: any = {
      ok:           false,
      hypothesisId: "hyp_phase2e_test",
      code:         "unknown_metric",
      reason:       "synthetic refusal",
      rawMetric:    "nope",
      matchedRegistryEntries: [],
      evidence:     [],
      candidate: {
        hypothesisId: "hyp_phase2e_test",
        origin:       "research_lab.hypotheses",
        tag:          "ready_for_experiment",
      },
    };
    const result = planSandboxExecution(refusal, controls(), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "binding_not_ok");
  });

  it("refuses a binding whose candidate.origin is not research_lab.hypotheses", () => {
    const binding = mkBinding();
    const tampered: any = {
      ...binding,
      candidate: { ...binding.candidate, origin: "memory_knowledge" },
    };
    const result = planSandboxExecution(tampered, controls(), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "binding_origin_invalid");
    assert.match(result.reason, /research_lab\.hypotheses/);
  });

  it("refuses when controls is null", () => {
    const result = planSandboxExecution(mkBinding(), null as any, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_controls");
  });

  it("refuses a binding missing metricKey", () => {
    const binding = mkBinding();
    const tampered: any = { ...binding, metricKey: "" };
    const result = planSandboxExecution(tampered, controls(), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "binding_missing_metric_key");
  });
});

// ── Plan-only invariant ──────────────────────────────────────────────────────

describe("planSandboxExecution — plan-only invariant", () => {
  it("does not write the decision-events ledger", () => {
    const ledger = path.join(TMP, "experiment_decision_events.jsonl");
    const before = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf-8") : "";
    planSandboxExecution(mkBinding(), controls(), NOW);
    const after = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf-8") : "";
    assert.equal(after, before, "Phase 2e MUST NOT write the Phase 2d ledger");
  });

  it("does not mutate the real research_lab.json or memory_knowledge.json", () => {
    planSandboxExecution(mkBinding(), controls(), NOW);
    planSandboxExecution(mkBinding(), controls({ dryRun: true }), NOW);
    planSandboxExecution(mkBinding(), controls({ featureFlag: false }), NOW);

    const research = readIfExists(REAL_RESEARCH_LAB);
    const memory   = readIfExists(REAL_MEMORY_KB);
    assert.equal(research, researchLabBefore, "research_lab.json must be unchanged");
    assert.equal(memory,   memoryKbBefore,    "memory_knowledge.json must be unchanged");
  });

  it("does not create any unexpected files in TMP after planning", () => {
    const beforeFiles = new Set(fs.readdirSync(TMP));
    planSandboxExecution(mkBinding(), controls(), NOW);
    const afterFiles = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...afterFiles].sort(), [...beforeFiles].sort(),
      "Phase 2e MUST NOT create any files in DATA_DIR (it is plan-only)");
  });

  it("applySandboxExecutionPlan is a no-op stub deferred to Phase 2e-b", () => {
    const planResult = planSandboxExecution(mkBinding(), controls(), NOW);
    assert.equal(planResult.ok, true);
    if (!planResult.ok) return;
    const apply = applySandboxExecutionPlan(planResult);
    assert.equal(apply.ok, false);
    assert.equal(apply.deferredTo, "phase-2e-b");
    assert.match(apply.reason, /plan-only|deferred|sandbox|dry-run/i);
  });
});

// ── File-level isolation contract ────────────────────────────────────────────
//
// Mirrors the contract added by Phase 2n drains #1–#3 (repositoryBakFallback,
// autonomyMonitor, hypothesisDecisionEvents). Asserts that after every test
// in this file runs, none of the 7 watched live-state files under repo `data/`
// have been touched, and that env-var redirects are still pinned.

describe("hypothesisSandboxExecution.test.ts — file-level isolation contract", () => {
  it("env-var redirects are still pointing at TMP", () => {
    assert.equal(process.env.DATA_DIR, TMP);
    assert.equal(process.env.DB_PATH, path.join(TMP, "test.db"));
  });

  it("research_lab.json is unchanged", () => {
    assert.equal(readIfExists(REAL_RESEARCH_LAB), researchLabBefore);
  });

  it("memory_knowledge.json is unchanged", () => {
    assert.equal(readIfExists(REAL_MEMORY_KB), memoryKbBefore);
  });

  it("agent_goals.json is unchanged", () => {
    assert.equal(readIfExists(REAL_AGENT_GOALS), agentGoalsBefore);
  });

  it("competencyProfile.json is unchanged", () => {
    assert.equal(readIfExists(REAL_COMPETENCY), competencyBefore);
  });

  it("experiment_decision_events.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_DECISION_EVENTS), decisionEventsBefore);
  });

  it("sandbox_registration_records.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_SANDBOX_REG), sandboxRegBefore);
  });

  it("agent306.db is unchanged (size + mtime)", () => {
    if (dbSizeBefore === null) {
      // db did not exist before; assert it still does not exist
      assert.equal(fs.existsSync(REAL_DB), false, "agent306.db should not have been created");
      return;
    }
    assert.ok(fs.existsSync(REAL_DB), "agent306.db must still exist");
    const st = fs.statSync(REAL_DB);
    assert.equal(st.size, dbSizeBefore, "agent306.db size changed");
    assert.equal(st.mtimeMs, dbMtimeBefore, "agent306.db mtime changed (WAL-aware check)");
  });
});
