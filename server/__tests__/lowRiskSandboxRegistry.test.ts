/**
 * Tests for the Phase 2e-b low-risk sandbox registration registry.
 *
 * Spec invariants this file pins:
 *   1. `summarizationTemplate` registration succeeds only with feature flag,
 *      operator approval, dryRun=true, fixtureSource="static", scheduler off,
 *      promotion off, and maxTrials in [1, 25].
 *   2. Disabled kinds (reasoningTemplate, selfCritiquePrompt,
 *      memoryRetrievalHeuristic, taskDecompositionPattern) refuse with
 *      `kind_disabled` and the registry's `disabledReason`.
 *   3. Each refusal carries a stable `code` + structured evidence.
 *   4. Live traffic / scheduler / promotion / non-dry-run / non-static
 *      fixture / too many trials / missing controls all refuse with the
 *      appropriate code.
 *   5. The metric seed (summary_quality_score) and four guardrails
 *      (hallucination_count, citation_source_retention, format_compliance,
 *      length_compliance) are present on the success record for
 *      summarizationTemplate.
 *   6. Registering does NOT create files under DATA_DIR, does NOT mutate
 *      data/research_lab.json, data/memory_knowledge.json, or the live
 *      experiments table; the Phase 2d ledger file is not touched.
 *   7. `applyLowRiskSandboxRegistration` is a no-op stub deferred to 2e-c.
 *   8. Phase 2e plan-only behavior remains intact (sanity import + smoke).
 *
 * Run: npx tsx --test server/__tests__/lowRiskSandboxRegistry.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Redirect DATA_DIR and DB_PATH so any accidental ledger / data / db write
// would land in the tmpdir rather than the repo's `data/`. Phase 2e-b
// performs no writes, but we want the test to fail loudly if that ever
// changes. These env vars MUST be set before any module that captures them
// at import time (server/dataPaths.ts, server/db.ts) is imported.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2eb-lowrisk-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_DATA_DIR        = path.join(REPO_ROOT, "data");
const REAL_RESEARCH_LAB    = path.join(REAL_DATA_DIR, "research_lab.json");
const REAL_MEMORY_KB       = path.join(REAL_DATA_DIR, "memory_knowledge.json");
const REAL_AGENT_GOALS     = path.join(REAL_DATA_DIR, "agent_goals.json");
const REAL_COMPETENCY      = path.join(REAL_DATA_DIR, "competencyProfile.json");
const REAL_LEDGER          = path.join(REAL_DATA_DIR, "experiment_decision_events.jsonl");
const REAL_SANDBOX_REG     = path.join(REAL_DATA_DIR, "sandbox_registration_records.jsonl");
const REAL_DB              = path.join(REAL_DATA_DIR, "agent306.db");

const {
  registerLowRiskSandboxKind,
  applyLowRiskSandboxRegistration,
  listLowRiskSandboxKinds,
  listLowRiskSandboxRegistrations,
  getLowRiskSandboxRegistration,
  __resetLowRiskSandboxRegistryForTests,
  LOW_RISK_SANDBOX_KINDS,
  LOW_RISK_SANDBOX_REGISTRY,
  PHASE2EB_GLOBAL_MAX_TRIALS,
  PHASE2EB_MIN_TRIALS,
  SUMMARIZATION_METRIC_KEY,
  SUMMARIZATION_GUARDRAIL_KEYS,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

// Phase 2e plan-only sanity import — used by the cross-phase smoke test.
const {
  planSandboxExecution,
  applySandboxExecutionPlan,
} = await import("../experiments/hypothesisSandboxExecution.ts");
const {
  bindCandidateMetric,
} = await import("../experiments/hypothesisMetricBinding.ts");
const {
  evaluateHypothesisForExperiment,
} = await import("../experiments/hypothesisExperimentSelector.ts");

import type {
  LowRiskSandboxControls,
  LowRiskSandboxRegistration,
} from "../experiments/lowRiskSandboxRegistry.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function controls(overrides: Partial<LowRiskSandboxControls> = {}): LowRiskSandboxControls {
  return {
    featureFlag:       true,
    operatorApproved:  true,
    dryRun:            true,
    fixtureSource:     "static",
    maxTrials:         5,
    promotionEligible: false,
    useScheduler:      false,
    ...overrides,
  };
}

function mkHyp(): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:         "hyp_phase2eb_test",
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
  return { ...base, hygieneTag: "ready_for_experiment" };
}

const NOW = new Date("2026-05-09T12:00:00.000Z");

// Snapshot the real data files so we can prove the module made no writes.
let researchLabBefore:    string | null = null;
let memoryKbBefore:       string | null = null;
let agentGoalsBefore:     string | null = null;
let competencyBefore:     string | null = null;
let ledgerBefore:         string | null = null;
let sandboxRegBefore:     string | null = null;
let dbSizeBefore: number | null = null;
let dbMtimeBefore: number | null = null;

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
}

before(() => {
  // Loud-failure pin: assert env-var redirects still point at TMP, not at
  // the real repo `data/`. If anything earlier in the test process mutated
  // these, fail before we can write live state.
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

  researchLabBefore = readIfExists(REAL_RESEARCH_LAB);
  memoryKbBefore    = readIfExists(REAL_MEMORY_KB);
  agentGoalsBefore  = readIfExists(REAL_AGENT_GOALS);
  competencyBefore  = readIfExists(REAL_COMPETENCY);
  ledgerBefore      = readIfExists(REAL_LEDGER);
  sandboxRegBefore  = readIfExists(REAL_SANDBOX_REG);
  if (fs.existsSync(REAL_DB)) {
    const st = fs.statSync(REAL_DB);
    dbSizeBefore = st.size;
    dbMtimeBefore = st.mtimeMs;
  }
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  __resetLowRiskSandboxRegistryForTests();
});

// ── Registry shape ───────────────────────────────────────────────────────────

describe("lowRiskSandboxRegistry — registry shape", () => {
  it("exposes exactly the five user-approved kinds", () => {
    assert.deepEqual(
      [...LOW_RISK_SANDBOX_KINDS].sort(),
      [
        "memoryRetrievalHeuristic",
        "reasoningTemplate",
        "selfCritiquePrompt",
        "summarizationTemplate",
        "taskDecompositionPattern",
      ],
    );
  });

  it("enables only summarizationTemplate by default", () => {
    const enabled = LOW_RISK_SANDBOX_REGISTRY.filter(e => e.enabled).map(e => e.kind);
    assert.deepEqual(enabled, ["summarizationTemplate"]);
  });

  it("every disabled kind has a stable disabledReason code", () => {
    for (const entry of LOW_RISK_SANDBOX_REGISTRY) {
      if (!entry.enabled) {
        assert.ok(entry.disabledReason, `kind '${entry.kind}' is disabled but missing disabledReason`);
        assert.ok(
          [
            "future_phase_not_wired",
            "requires_internal_persona",
            "requires_rag_pipeline",
            "requires_strategy_router",
          ].includes(entry.disabledReason!),
          `kind '${entry.kind}' has unexpected disabledReason '${entry.disabledReason}'`,
        );
      }
    }
  });

  it("summarizationTemplate has the expected metric seed and guardrails", () => {
    const entry = LOW_RISK_SANDBOX_REGISTRY.find(e => e.kind === "summarizationTemplate")!;
    assert.equal(entry.metricKey, SUMMARIZATION_METRIC_KEY);
    assert.equal(entry.metricKey, "summary_quality_score");
    assert.deepEqual([...entry.guardrails].sort(), [...SUMMARIZATION_GUARDRAIL_KEYS].sort());
    assert.deepEqual(
      [...entry.guardrails].sort(),
      [
        "citation_source_retention",
        "format_compliance",
        "hallucination_count",
        "length_compliance",
      ],
    );
  });

  it("every kind cap is at or below the global cap (25)", () => {
    assert.equal(PHASE2EB_GLOBAL_MAX_TRIALS, 25);
    for (const entry of LOW_RISK_SANDBOX_REGISTRY) {
      assert.ok(
        entry.maxTrialsCap <= PHASE2EB_GLOBAL_MAX_TRIALS,
        `kind '${entry.kind}' has maxTrialsCap ${entry.maxTrialsCap} > global ${PHASE2EB_GLOBAL_MAX_TRIALS}`,
      );
    }
  });

  it("listLowRiskSandboxKinds reflects the registry shape", () => {
    const view = listLowRiskSandboxKinds();
    assert.equal(view.length, 5);
    const sum = view.find(v => v.kind === "summarizationTemplate")!;
    assert.equal(sum.enabled, true);
    assert.equal(sum.metricKey, "summary_quality_score");
    const rt = view.find(v => v.kind === "reasoningTemplate")!;
    assert.equal(rt.enabled, false);
    assert.equal(rt.disabledReason, "future_phase_not_wired");
  });
});

// ── Happy path: summarizationTemplate accept ─────────────────────────────────

describe("registerLowRiskSandboxKind — accept path (summarizationTemplate)", () => {
  it("produces a complete registration when every control is set", () => {
    const result = registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.registrationId, /^lowrisk_\d+_[0-9a-z]{6}$/);
    assert.equal(result.kind, "summarizationTemplate");
    assert.equal(result.sandboxMode, "sandbox-dry-run");
    assert.equal(result.metricKey, "summary_quality_score");
    assert.deepEqual(result.resourceCaps, { maxTrials: 5 });
    assert.equal(result.registeredAt, NOW.toISOString());

    // Guardrails seeded.
    assert.deepEqual([...result.guardrails].sort(), [
      "citation_source_retention",
      "format_compliance",
      "hallucination_count",
      "length_compliance",
    ]);

    // Evidence trail mentions the controls.
    assert.ok(result.evidence.some(e => e.includes("dry run: true")));
    assert.ok(result.evidence.some(e => e.includes("static")));
    assert.ok(result.evidence.some(e => e.includes("scheduler: disabled")));
    assert.ok(result.evidence.some(e => e.includes("promotion: disabled")));
    assert.ok(result.evidence.some(e => e.includes("summary_quality_score")));

    // Controls echoed back.
    assert.equal(result.controls.dryRun, true);
    assert.equal(result.controls.fixtureSource, "static");
    assert.equal(result.controls.useScheduler, false);
    assert.equal(result.controls.promotionEligible, false);
  });

  it("carries operator notes through to the evidence trail", () => {
    const result = registerLowRiskSandboxKind(
      "summarizationTemplate",
      controls({ notes: "approved by ops 2026-05-09 for sandbox eval" }),
      NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.evidence.some(e => e.includes("approved by ops 2026-05-09")));
    assert.equal(result.controls.notes, "approved by ops 2026-05-09 for sandbox eval");
  });

  it("accepts maxTrials at the lower and upper bounds", () => {
    const lo = registerLowRiskSandboxKind("summarizationTemplate", controls({ maxTrials: PHASE2EB_MIN_TRIALS }), NOW);
    assert.equal(lo.ok, true);
    const hi = registerLowRiskSandboxKind("summarizationTemplate", controls({ maxTrials: 25 }), NOW);
    assert.equal(hi.ok, true);
  });

  it("produces unique registrationIds across rapid successive calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(!seen.has(r.registrationId), `duplicate id: ${r.registrationId}`);
        seen.add(r.registrationId);
      }
    }
  });

  it("stores accepted registrations in the in-memory map", () => {
    const r = registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const fetched = getLowRiskSandboxRegistration(r.registrationId);
    assert.ok(fetched, "registration was not stored");
    assert.equal(fetched!.registrationId, r.registrationId);
    const all = listLowRiskSandboxRegistrations();
    assert.equal(all.length, 1);
  });
});

// ── Refusal: feature flag / operator approval ────────────────────────────────

describe("registerLowRiskSandboxKind — feature flag / approval refusals", () => {
  it("refuses when featureFlag is false", () => {
    const result = registerLowRiskSandboxKind("summarizationTemplate", controls({ featureFlag: false }), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "feature_flag_off");
  });

  it("refuses when featureFlag is omitted", () => {
    const c: any = { ...controls() };
    delete c.featureFlag;
    const result = registerLowRiskSandboxKind("summarizationTemplate", c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "feature_flag_off");
  });

  it("refuses when operatorApproved is false", () => {
    const result = registerLowRiskSandboxKind("summarizationTemplate", controls({ operatorApproved: false }), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "operator_not_approved");
  });

  it("refuses when operatorApproved is omitted", () => {
    const c: any = { ...controls() };
    delete c.operatorApproved;
    const result = registerLowRiskSandboxKind("summarizationTemplate", c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "operator_not_approved");
  });
});

// ── Refusal: dry-run / fixture / live traffic ────────────────────────────────

describe("registerLowRiskSandboxKind — dry-run / fixture refusals", () => {
  it("refuses when dryRun is false", () => {
    const result = registerLowRiskSandboxKind(
      "summarizationTemplate",
      controls({ dryRun: false }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "dry_run_required");
  });

  it("refuses when dryRun is omitted", () => {
    const c: any = { ...controls() };
    delete c.dryRun;
    const result = registerLowRiskSandboxKind("summarizationTemplate", c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "dry_run_required");
  });

  it("refuses when fixtureSource is not 'static' (synthetic, generated)", () => {
    for (const src of ["synthetic", "generated", "snapshot"]) {
      const result = registerLowRiskSandboxKind(
        "summarizationTemplate",
        controls({ fixtureSource: src }),
        NOW,
      );
      assert.equal(result.ok, false, `expected refusal for fixtureSource='${src}'`);
      if (result.ok) continue;
      assert.equal(result.code, "fixture_source_not_allowed");
    }
  });

  it("refuses with live_traffic_not_allowed when fixtureSource names live/production", () => {
    for (const src of ["live_traffic", "production", "live", "prod"]) {
      const result = registerLowRiskSandboxKind(
        "summarizationTemplate",
        controls({ fixtureSource: src }),
        NOW,
      );
      assert.equal(result.ok, false, `expected refusal for fixtureSource='${src}'`);
      if (result.ok) continue;
      assert.equal(result.code, "live_traffic_not_allowed");
    }
  });
});

// ── Refusal: scheduler / promotion ───────────────────────────────────────────

describe("registerLowRiskSandboxKind — scheduler / promotion refusals", () => {
  it("refuses when useScheduler is true", () => {
    const result = registerLowRiskSandboxKind(
      "summarizationTemplate",
      controls({ useScheduler: true }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "scheduler_not_allowed");
  });

  it("refuses when promotionEligible is true", () => {
    const result = registerLowRiskSandboxKind(
      "summarizationTemplate",
      controls({ promotionEligible: true }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "promotion_not_allowed");
  });
});

// ── Refusal: resource caps ───────────────────────────────────────────────────

describe("registerLowRiskSandboxKind — resource cap refusals", () => {
  it("refuses when maxTrials is missing", () => {
    const c: any = { ...controls() };
    delete c.maxTrials;
    const result = registerLowRiskSandboxKind("summarizationTemplate", c, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "missing_resource_cap");
  });

  it("refuses when maxTrials is NaN / Infinity / non-integer", () => {
    for (const bad of [NaN, Infinity, -Infinity, 3.5]) {
      const result = registerLowRiskSandboxKind(
        "summarizationTemplate",
        controls({ maxTrials: bad }),
        NOW,
      );
      assert.equal(result.ok, false, `expected refusal for maxTrials=${bad}`);
      if (result.ok) continue;
      assert.equal(result.code, "missing_resource_cap");
    }
  });

  it("refuses when maxTrials is below the minimum", () => {
    for (const bad of [0, -1, -100]) {
      const result = registerLowRiskSandboxKind(
        "summarizationTemplate",
        controls({ maxTrials: bad }),
        NOW,
      );
      assert.equal(result.ok, false, `expected refusal for maxTrials=${bad}`);
      if (result.ok) continue;
      assert.equal(result.code, "missing_resource_cap");
    }
  });

  it("refuses when maxTrials exceeds the kind cap (25)", () => {
    const result = registerLowRiskSandboxKind(
      "summarizationTemplate",
      controls({ maxTrials: 26 }),
      NOW,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "resource_cap_exceeds_limit");
  });
});

// ── Refusal: kind / disabled kinds ───────────────────────────────────────────

describe("registerLowRiskSandboxKind — kind refusals", () => {
  it("refuses an unknown kind", () => {
    const result = registerLowRiskSandboxKind("notAKind" as any, controls(), NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unknown_kind");
  });

  for (const disabledKind of [
    { kind: "reasoningTemplate",        reason: "future_phase_not_wired" },
    { kind: "selfCritiquePrompt",       reason: "requires_internal_persona" },
    { kind: "memoryRetrievalHeuristic", reason: "requires_rag_pipeline" },
    { kind: "taskDecompositionPattern", reason: "requires_strategy_router" },
  ]) {
    it(`refuses disabled kind '${disabledKind.kind}' with code 'kind_disabled' and reason '${disabledKind.reason}'`, () => {
      const result = registerLowRiskSandboxKind(disabledKind.kind as any, controls(), NOW);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.code, "kind_disabled");
      assert.equal(result.disabledReason, disabledKind.reason);
    });
  }
});

// ── Refusal: invalid controls ────────────────────────────────────────────────

describe("registerLowRiskSandboxKind — invalid controls", () => {
  it("refuses when controls is null", () => {
    const result = registerLowRiskSandboxKind("summarizationTemplate", null as any, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_controls");
  });

  it("refuses when controls is undefined", () => {
    const result = registerLowRiskSandboxKind("summarizationTemplate", undefined as any, NOW);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_controls");
  });
});

// ── Plan-only / propose-only invariants ──────────────────────────────────────

describe("registerLowRiskSandboxKind — propose-only invariants", () => {
  it("does not write any file under DATA_DIR", () => {
    const beforeFiles = new Set(fs.readdirSync(TMP));
    registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
    registerLowRiskSandboxKind("summarizationTemplate", controls({ dryRun: false }), NOW);
    registerLowRiskSandboxKind("reasoningTemplate", controls(), NOW);
    const afterFiles = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...afterFiles].sort(), [...beforeFiles].sort(),
      "Phase 2e-b MUST NOT create any files in DATA_DIR (it is propose-only)");
  });

  it("does not mutate the real research_lab.json or memory_knowledge.json", () => {
    registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
    registerLowRiskSandboxKind("summarizationTemplate", controls({ maxTrials: 25 }), NOW);
    registerLowRiskSandboxKind("reasoningTemplate", controls(), NOW);

    const research = readIfExists(REAL_RESEARCH_LAB);
    const memory   = readIfExists(REAL_MEMORY_KB);
    assert.equal(research, researchLabBefore, "research_lab.json must be unchanged");
    assert.equal(memory,   memoryKbBefore,    "memory_knowledge.json must be unchanged");
  });

  it("does not write the Phase 2d decision-events ledger", () => {
    registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
    const ledgerNow = readIfExists(REAL_LEDGER);
    assert.equal(ledgerNow, ledgerBefore, "Phase 2e-b MUST NOT write the Phase 2d ledger");
  });

  it("applyLowRiskSandboxRegistration is a no-op stub deferred to Phase 2e-c", () => {
    const r = registerLowRiskSandboxKind("summarizationTemplate", controls(), NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const apply = applyLowRiskSandboxRegistration(r);
    assert.equal(apply.ok, false);
    assert.equal(apply.deferredTo, "phase-2e-c");
    assert.match(apply.reason, /registration-only|deferred|sandbox|dry-run/i);
  });
});

// ── Cross-phase smoke: Phase 2e plan-only behavior still works ───────────────

describe("Phase 2e plan-only behavior preserved alongside Phase 2e-b", () => {
  it("Phase 2e planSandboxExecution still produces a plan from a Phase 2b binding", () => {
    const decision = evaluateHypothesisForExperiment(mkHyp());
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    const bound = bindCandidateMetric(decision.candidate);
    assert.equal(bound.ok, true);
    if (!bound.ok) return;

    const plan = planSandboxExecution(
      bound,
      {
        featureFlag:           true,
        operatorApproved:      true,
        dryRun:                false,
        maxTrials:             10,
        allowedMetricKey:      bound.metricKey,
        allowedExperimentKind: "modelRouter",
      },
      NOW,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.experimentKind, "modelRouter");
    assert.equal(plan.sandboxMode, "sandbox");
    assert.equal(plan.metricKey, "routine_task_json_validity");

    const apply = applySandboxExecutionPlan(plan);
    assert.equal(apply.ok, false);
    assert.equal(apply.deferredTo, "phase-2e-b");
  });
});

// ── File-level isolation contract ────────────────────────────────────────────
//
// Mirrors the contract added by Phase 2n drains #1–#5. Asserts that after
// every test in this file runs, none of the 7 watched live-state files
// under repo `data/` have been touched, and that env-var redirects are
// still pinned.

describe("lowRiskSandboxRegistry.test.ts — file-level isolation contract", () => {
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
    assert.equal(readIfExists(REAL_LEDGER), ledgerBefore);
  });

  it("sandbox_registration_records.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_SANDBOX_REG), sandboxRegBefore);
  });

  it("agent306.db is unchanged (size + mtime)", () => {
    if (dbSizeBefore === null) {
      assert.equal(fs.existsSync(REAL_DB), false, "agent306.db should not have been created");
      return;
    }
    assert.ok(fs.existsSync(REAL_DB), "agent306.db must still exist");
    const st = fs.statSync(REAL_DB);
    assert.equal(st.size, dbSizeBefore, "agent306.db size changed");
    assert.equal(st.mtimeMs, dbMtimeBefore, "agent306.db mtime changed (WAL-aware check)");
  });
});
