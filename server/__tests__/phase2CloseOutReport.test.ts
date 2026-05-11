/**
 * Tests for Phase 2l-c — Phase 2 close-out readiness report (read-only / test-only).
 *
 * Spec invariants pinned by this file:
 *   1. Schema constants: stable schema version, label, and a verbatim
 *      safety disclaimer that explicitly mentions read-only, propose-only,
 *      observational, close-out, and the "candidate" cap.
 *   2. Populated/seeding path: a seeded happy-path learning loop maps to
 *      `learningLoopStatus: "success"` and a conservative
 *      `readinessRecommendation: "ready_for_manual_daily_testing"`
 *      when no Phase 3 attestations are supplied.
 *   3. Phase 3 ceiling: with every Phase 3 attestation explicitly
 *      `satisfied`, the recommendation rises to
 *      `ready_for_sandbox_only_trial_candidate` — and only then.
 *      One missing or violated attestation drops it back to
 *      `ready_for_manual_daily_testing`.
 *   4. Cold path: no evidence / decisions / context → readiness is
 *      `not_ready` and the Phase 3 attestations cannot lift it.
 *   5. Partial path: unmatched operator decision → `learningLoopStatus:
 *      "partial"`, `readiness: "not_ready"`, learning-loop blockers
 *      bubble up.
 *   6. Safety-warning path: a forced safety invariant violation →
 *      `learningLoopStatus: "safety_warning"`, `readiness: "not_ready"`,
 *      even with every Phase 3 attestation satisfied.
 *   7. Sandbox readiness invariant: if the injected sandbox readiness
 *      summary reports any enabled kind other than `summarizationTemplate`,
 *      readiness is forced to `not_ready` and a hard blocker surfaces.
 *   8. Determinism: identical inputs → deeply equal output AND
 *      byte-identical serialised string (both compact and pretty).
 *   9. Metadata: runLabel / operator / source are echoed verbatim when
 *      supplied; default to `null` / `null` / `"manual"` when omitted.
 *  10. No mutation: report does not mutate its inputs, fixtures, env,
 *      or the on-disk sandbox registration ledger.
 *  11. Forbidden imports / source: report does NOT call Date.now /
 *      Math.random / randomUUID / read process.env / write to fs. It
 *      does NOT import autonomyMonitor / selfRecommendationEngine /
 *      promotionGate / a scheduler / any UI / API path. It is NOT
 *      imported by any runtime / monitor / scheduler / apply / promote
 *      file.
 *  12. Phase 3 checklist shape: every criterion key from the closed
 *      enum is present in stable order with the expected description
 *      and a tri-state attestation.
 *  13. Disabled sandbox kinds remain disabled — the report describes
 *      their disabled state but never proposes enabling them.
 *  14. Programmer-shaped misuse throws TypeError.
 *  15. Phase 2l-b learning-loop report is embedded verbatim.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so the report's underlying harness
// sees a clean state and so we can confirm later that no real ledger files
// were touched. The report and harness do no I/O — these guards are
// belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2lc-close-out-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildPhase2CloseOutReport,
  serializePhase2CloseOutReport,
  PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION,
  PHASE2_CLOSE_OUT_REPORT_LABEL,
  PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER,
} = await import("../experiments/phase2CloseOutReport.ts");

const {
  buildSandboxRegistrationHistorySnapshot,
} = await import("../experiments/sandboxRegistrationHistory.ts");

const {
  executeSummarizationFixtureRegistration,
} = await import("../experiments/summarizationSandboxFixtureRegistration.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const {
  runLearningLoopHarness,
} = await import("../experiments/learningLoopHarness.ts");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);

const PINNED_AT = "2026-05-11T18:00:00.000Z";

const PHASE3_KEYS = [
  "reversibleLowRiskActionOnly",
  "explicitKillSwitchAndResourceLimits",
  "anomalyAndDriftDetectionPlaceholder",
  "rollbackProof",
  "humanApprovalBoundary",
  "metricsClockReadiness",
  "noPublicAction",
] as const;

function allSatisfied(): Record<typeof PHASE3_KEYS[number], "satisfied"> {
  const out = {} as Record<typeof PHASE3_KEYS[number], "satisfied">;
  for (const k of PHASE3_KEYS) out[k] = "satisfied";
  return out;
}

function pinnedRuntimeVisibility() {
  return {
    freshness:        "running" as const,
    freshnessReason:  "engine_runs row in last 5m",
    generatedAt:      PINNED_AT,
    commitShortSha:   "abc1234",
    environment:      "production",
    packageVersion:   "1.0.0",
    decisionEventsLast24h:       2,
    sandboxRegistrationsLast24h: 1,
  };
}

function pinnedSandboxReadiness() {
  return {
    total:        5,
    enabled:      1,
    ready:        1,
    blocked:      3,
    needsReview:  1,
    disabled:     0,
    enabledKinds: ["summarizationTemplate"] as const,
  };
}

function pinnedRiskImpact() {
  return {
    total:           4,
    eligibleLowRisk: 1,
    byDecision: { eligible: 1, needs_review: 2, blocked: 1 },
  };
}

function broadHypothesisContext(hypothesisId = "hyp:closeout:e2e") {
  return {
    hypothesisId,
    subsystems: [
      "summarizationFixture",
      "registrationHistory",
      "registrationAuditExport",
      "lowRiskSandboxReadiness",
      "riskImpact",
    ] as const,
    scopePrefixes: ["sandbox."],
  };
}

before(() => {
  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(TMP_LEDGER); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2l-c tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-c tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-c tests created live ${label}!`);
    }
  }
});

// ── Schema / label sanity ──────────────────────────────────────────────────

describe("Phase 2l-c — schema constants", () => {
  it("exposes a stable schema version, label, and safety disclaimer", () => {
    assert.equal(PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION, "phase2l-c.v1");
    assert.equal(PHASE2_CLOSE_OUT_REPORT_LABEL, "agent306.phase2_close_out_readiness_report");
    assert.ok(Array.isArray(PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER));
    assert.ok(PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER.length >= 1);
    const joined = PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER.join(" ");
    assert.ok(/read-only/i.test(joined),    "disclaimer must mention read-only");
    assert.ok(/propose-only/i.test(joined), "disclaimer must mention propose-only");
    assert.ok(/observational/i.test(joined), "disclaimer must mention observational");
    assert.ok(/close-out/i.test(joined),     "disclaimer must mention close-out");
    assert.ok(/candidate/i.test(joined),     "disclaimer must mention candidate cap");
    assert.ok(/Phase 3/i.test(joined),       "disclaimer must mention Phase 3");
  });
});

// ── Cold path ──────────────────────────────────────────────────────────────

describe("Phase 2l-c — cold path: no evidence / decisions / context", () => {
  it("returns not_ready with cold learning-loop blockers and cannot be lifted", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const r = buildPhase2CloseOutReport();
    assert.equal(r.schemaVersion, PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION);
    assert.equal(r.label,         PHASE2_CLOSE_OUT_REPORT_LABEL);
    assert.equal(r.learningLoopStatus,      "cold");
    assert.equal(r.readinessRecommendation, "not_ready");
    assert.match(r.readinessRationale, /cold/i);
    assert.equal(r.generatedAt, null);
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source,   "manual");

    // Phase 3 checklist defaults to unverified.
    assert.equal(r.phase3Gating.aggregate.total, PHASE3_KEYS.length);
    assert.equal(r.phase3Gating.aggregate.satisfied, 0);
    assert.equal(r.phase3Gating.aggregate.unverified, PHASE3_KEYS.length);
    assert.equal(r.phase3Gating.aggregate.allSatisfied, false);

    // Even attesting every Phase 3 criterion cannot lift cold.
    const r2 = buildPhase2CloseOutReport({ phase3Attestations: allSatisfied() });
    assert.equal(r2.readinessRecommendation, "not_ready");
  });
});

// ── Populated happy path ───────────────────────────────────────────────────

describe("Phase 2l-c — populated happy path: success → ready_for_manual_daily_testing by default", () => {
  it("seeded happy path lands on success + manual-daily-testing with zero blockers and clean safety", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-happy",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true, `fixture seed failed: ${(seed as any).reason}`);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    assert.ok(dry.lessonTable.lessons.length >= 1);

    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op@phase2l-c",
      rationale: "phase 2l-c close-out happy path",
      decidedAt: PINNED_AT,
    }));

    const r = buildPhase2CloseOutReport({
      runLabel: "phase2l-c-2026-05-11",
      operator: "op@phase2l-c",
      source:   "test:phase2l-c",
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      learningLoopInputs: {
        harnessInputs: {
          history,
          operatorDecisions,
          hypothesisContext: broadHypothesisContext(),
          now: PINNED_AT,
          generatedBy: "phase2l-c-test",
        },
      },
    });

    assert.equal(r.learningLoopStatus, "success");
    assert.equal(r.readinessRecommendation, "ready_for_manual_daily_testing");
    assert.match(r.readinessRationale, /Phase 3 gating criterion/i);
    assert.equal(r.generatedAt, PINNED_AT);
    assert.equal(r.runLabel, "phase2l-c-2026-05-11");
    assert.equal(r.operator, "op@phase2l-c");
    assert.equal(r.source,   "test:phase2l-c");

    // Learning-loop sub-report is embedded verbatim and matches.
    assert.equal(r.learningLoopReport.overallStatus, "success");
    assert.equal(r.learningLoopReport.label, "agent306.manual_learning_loop_report");
    assert.equal(r.learningLoopReport.priority, "informational");

    // Safety table reflects the underlying success.
    assert.equal(r.safety.allHeld, true);

    // No learning-loop blockers on the happy path; Phase 3 gating
    // blockers are the only ones expected.
    const llBlockers = r.blockers.filter(b => b.code === "learning_loop_blocker");
    assert.equal(llBlockers.length, 0, `expected no learning_loop blockers, got ${JSON.stringify(llBlockers)}`);

    // Phase 3 gating blockers reflect every criterion's default
    // unverified attestation.
    const phase3Blockers = r.blockers.filter(b => b.code === "phase3_gate_unverified");
    assert.equal(phase3Blockers.length, PHASE3_KEYS.length);

    // No "unexpected enabled kinds" or "missing visibility" blockers.
    assert.equal(r.blockers.some(b => b.code === "unexpected_enabled_sandbox_kinds"), false);
    assert.equal(r.warnings.some(w => w.code === "runtime_visibility_missing"), false);
    assert.equal(r.warnings.some(w => w.code === "sandbox_readiness_missing"), false);
    assert.equal(r.warnings.some(w => w.code === "risk_impact_missing"),       false);

    // The disclaimer is verbatim.
    assert.deepEqual(r.safetyDisclaimer, [...PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER]);

    // Invariants restated, including the close-out flags.
    assert.equal(r.invariants.observationalOnly, true);
    assert.equal(r.invariants.closeOutOnly,      true);
    assert.equal(r.invariants.phase3Gated,       true);
    assert.equal(r.invariants.autoApplyEligible, false);
    assert.equal(r.invariants.runtimeActionEligible, false);
    assert.equal(r.invariants.publicActionEligible, false);
  });

  it("with every Phase 3 attestation satisfied, readiness rises to the candidate ceiling", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-attest",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "x",
      decidedAt: PINNED_AT,
    }));

    const baseInputs = {
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      learningLoopInputs: {
        harnessInputs: {
          history,
          operatorDecisions,
          hypothesisContext: broadHypothesisContext(),
          now: PINNED_AT,
        },
      },
    };

    const ceiling = buildPhase2CloseOutReport({
      ...baseInputs,
      phase3Attestations: allSatisfied(),
    });
    assert.equal(ceiling.readinessRecommendation, "ready_for_sandbox_only_trial_candidate");
    assert.match(ceiling.readinessRationale, /CANDIDATE/);
    assert.equal(ceiling.phase3Gating.aggregate.allSatisfied, true);
    assert.equal(ceiling.phase3Gating.aggregate.satisfied,    PHASE3_KEYS.length);
    assert.equal(ceiling.phase3Gating.aggregate.unverified,   0);
    assert.equal(ceiling.phase3Gating.aggregate.violated,     0);
    // No Phase 3 gating blockers when all satisfied.
    const phase3Blockers = ceiling.blockers.filter(
      b => b.code === "phase3_gate_unverified" || b.code === "phase3_gate_violated",
    );
    assert.equal(phase3Blockers.length, 0);
  });

  it("one missing or violated attestation drops the recommendation back to manual-daily-testing", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-drop",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "x",
      decidedAt: PINNED_AT,
    }));

    const baseInputs = {
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      learningLoopInputs: {
        harnessInputs: {
          history,
          operatorDecisions,
          hypothesisContext: broadHypothesisContext(),
          now: PINNED_AT,
        },
      },
    };

    // Drop one attestation entirely.
    const attestationsMissingOne = allSatisfied() as Record<string, any>;
    delete attestationsMissingOne.rollbackProof;
    const dropped = buildPhase2CloseOutReport({
      ...baseInputs,
      phase3Attestations: attestationsMissingOne,
    });
    assert.equal(dropped.readinessRecommendation, "ready_for_manual_daily_testing");
    assert.ok(dropped.blockers.some(b => b.code === "phase3_gate_unverified" && /rollbackProof/.test(b.message)));

    // Set one attestation explicitly to violated.
    const violatedOne = { ...allSatisfied(), humanApprovalBoundary: "violated" as const };
    const dropped2 = buildPhase2CloseOutReport({
      ...baseInputs,
      phase3Attestations: violatedOne,
    });
    assert.equal(dropped2.readinessRecommendation, "ready_for_manual_daily_testing");
    assert.ok(dropped2.blockers.some(b => b.code === "phase3_gate_violated" && /humanApprovalBoundary/.test(b.message)));
  });
});

// ── Partial path ──────────────────────────────────────────────────────────

describe("Phase 2l-c — partial path: unmatched operator decisions", () => {
  it("partial learning loop forces not_ready and surfaces wrapped learning-loop blockers", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const r = buildPhase2CloseOutReport({
      learningLoopInputs: {
        harnessInputs: {
          operatorDecisions: [{
            lessonId:  "deadbeefdeadbeef",
            decision:  "approved",
            operator:  "op",
            rationale: "test",
            decidedAt: PINNED_AT,
          }],
          now: PINNED_AT,
        },
      },
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      phase3Attestations: allSatisfied(),
    });
    assert.equal(r.learningLoopStatus, "partial");
    assert.equal(r.readinessRecommendation, "not_ready");
    const wrappedBlocker = r.blockers.find(
      b => b.code === "learning_loop_blocker" && /unmatched_operator_decisions/.test(b.message),
    );
    assert.ok(wrappedBlocker, "expected wrapped learning_loop unmatched_operator_decisions blocker");
  });
});

// ── Safety-warning path ────────────────────────────────────────────────────

describe("Phase 2l-c — safety_warning forces not_ready even with all attestations", () => {
  it("forged candidate set with broken invariants → safety_warning → not_ready", () => {
    const forged = {
      schemaVersion: "phase2j-a.v1",
      generatedAt: null,
      generatedBy: "test",
      candidates: [{
        candidateId:           "forge0000000001",
        schemaVersion:         "phase2j-a.v1",
        kind:                  "observation",
        reasonCode:            "evidence_present_summarization_fixture",
        scope:                 "sandbox.summarizationTemplate",
        subsystem:             "summarizationFixture",
        title:                 "forged",
        body:                  "forged candidate to trip safety",
        confidence:            "moderate",
        evidenceStrength:      "moderate",
        riskLevel:             "low",
        evidenceRefs:          [],
        humanReviewRequired:   true,
        autoApplyEligible:     false,
        invariants: {
          readOnly:              true,
          proposeOnly:           true,
          autoApplyEligible:     false,
          publicAction:          true,   // ← intentionally wrong
          schedulerDriven:       false,
          mutating:              false,
        },
      }],
      aggregate: {
        totalCandidates: 1,
        candidatesByKind: { lesson: 0, observation: 1, question: 0 },
        candidatesBySubsystem: {
          summarizationFixture: 1,
          registrationHistory: 0,
          registrationAuditExport: 0,
          lowRiskSandboxReadiness: 0,
          riskImpact: 0,
        },
        humanReviewRequired: 1,
        autoApplyEligible: 0,
      },
      isEmpty: false,
      evidenceProvided: { history: false, auditExport: false, readiness: false, riskImpact: false },
      invariants: {
        readOnly: true, proposeOnly: true, autoApplyEligible: false,
        publicAction: false, schedulerDriven: false, mutating: false,
      },
    } as any;

    const r = buildPhase2CloseOutReport({
      learningLoopInputs: {
        harnessInputs: {
          candidateSetOverride: forged,
          now: PINNED_AT,
        },
      },
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      phase3Attestations: allSatisfied(),
    });
    assert.equal(r.learningLoopStatus, "safety_warning");
    assert.equal(r.readinessRecommendation, "not_ready");
    assert.match(r.readinessRationale, /safety/i);
    const safetyBlocker = r.blockers.find(
      b => b.code === "learning_loop_blocker" && /safety_invariant_violation/.test(b.message),
    );
    assert.ok(safetyBlocker, "expected wrapped learning_loop safety blocker");
    assert.equal(r.safety.allHeld, false);
  });
});

// ── Sandbox readiness invariant ────────────────────────────────────────────

describe("Phase 2l-c — sandbox readiness invariant: only summarizationTemplate enabled", () => {
  it("reports a hard blocker and forces not_ready when an unexpected kind is enabled", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-drift",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "x",
      decidedAt: PINNED_AT,
    }));

    const drift = {
      total:        5,
      enabled:      2,
      ready:        2,
      blocked:      2,
      needsReview:  1,
      disabled:     0,
      enabledKinds: ["summarizationTemplate", "reasoningTemplate"] as const,
    };

    const r = buildPhase2CloseOutReport({
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  drift,
      riskImpact:        pinnedRiskImpact(),
      phase3Attestations: allSatisfied(),
      learningLoopInputs: {
        harnessInputs: {
          history,
          operatorDecisions,
          hypothesisContext: broadHypothesisContext(),
          now: PINNED_AT,
        },
      },
    });

    assert.equal(r.readinessRecommendation, "not_ready");
    assert.match(r.readinessRationale, /summarizationTemplate-only/);
    const blocker = r.blockers.find(b => b.code === "unexpected_enabled_sandbox_kinds");
    assert.ok(blocker, "expected unexpected_enabled_sandbox_kinds blocker");
  });

  it("warns when sandbox readiness summary is missing entirely", () => {
    const r = buildPhase2CloseOutReport({
      runtimeVisibility: pinnedRuntimeVisibility(),
      riskImpact:        pinnedRiskImpact(),
    });
    const w = r.warnings.find(x => x.code === "sandbox_readiness_missing");
    assert.ok(w, "expected sandbox_readiness_missing warning");
  });
});

// ── Runtime visibility warnings ────────────────────────────────────────────

describe("Phase 2l-c — runtime visibility surfaces warnings, never blockers", () => {
  it("missing runtime visibility surfaces a warning", () => {
    const r = buildPhase2CloseOutReport({
      sandboxReadiness: pinnedSandboxReadiness(),
      riskImpact:       pinnedRiskImpact(),
    });
    const w = r.warnings.find(x => x.code === "runtime_visibility_missing");
    assert.ok(w, "expected runtime_visibility_missing warning");
    assert.equal(r.runtimeVisibility, null);
  });

  it("stale runtime visibility surfaces a warning but not a blocker", () => {
    const stale = { ...pinnedRuntimeVisibility(), freshness: "stale" as const, freshnessReason: "no events in 30m" };
    const r = buildPhase2CloseOutReport({
      runtimeVisibility: stale,
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
    });
    const w = r.warnings.find(x => x.code === "runtime_visibility_not_running");
    assert.ok(w, "expected runtime_visibility_not_running warning");
    assert.equal(r.blockers.some(b => /runtime/i.test(b.code)), false);
  });
});

// ── Phase 3 checklist shape ────────────────────────────────────────────────

describe("Phase 2l-c — Phase 3 gating checklist shape is stable", () => {
  it("exposes every closed-set criterion key in stable order with non-empty descriptions", () => {
    const r = buildPhase2CloseOutReport();
    const keys = r.phase3Gating.criteria.map(c => c.key);
    assert.deepEqual(keys, [...PHASE3_KEYS]);
    for (const c of r.phase3Gating.criteria) {
      assert.ok(typeof c.description === "string" && c.description.length > 10,
        `criterion ${c.key} has empty / short description`);
      assert.equal(c.attestation, "unverified");
      assert.equal(c.satisfied, false);
    }
  });
});

// ── Determinism ────────────────────────────────────────────────────────────

describe("Phase 2l-c — repeated runs with identical inputs are deeply equal and byte-identical", () => {
  it("running the report twice returns identical output", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-det",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "det",
      decidedAt: PINNED_AT,
    }));

    const inputs = {
      runLabel: "phase2l-c-det",
      operator: "op",
      source:   "test",
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      phase3Attestations: allSatisfied(),
      learningLoopInputs: {
        harnessInputs: {
          history,
          operatorDecisions,
          hypothesisContext: broadHypothesisContext(),
          now: PINNED_AT,
        },
      },
    };

    const a = buildPhase2CloseOutReport(inputs);
    const b = buildPhase2CloseOutReport(inputs);

    assert.deepEqual(a.runtimeVisibility, b.runtimeVisibility);
    assert.deepEqual(a.sandboxReadiness,  b.sandboxReadiness);
    assert.deepEqual(a.riskImpact,        b.riskImpact);
    assert.deepEqual(a.safety,            b.safety);
    assert.deepEqual(a.phase3Gating,      b.phase3Gating);
    assert.deepEqual(a.blockers,          b.blockers);
    assert.deepEqual(a.warnings,          b.warnings);
    assert.deepEqual(a.invariants,        b.invariants);
    assert.deepEqual(a.inputsSummary,     b.inputsSummary);
    assert.deepEqual(a.safetyDisclaimer,  b.safetyDisclaimer);

    assert.equal(
      serializePhase2CloseOutReport(a),
      serializePhase2CloseOutReport(b),
    );
    assert.equal(
      serializePhase2CloseOutReport(a, { indent: 2 }),
      serializePhase2CloseOutReport(b, { indent: 2 }),
    );
  });
});

// ── Metadata fields ────────────────────────────────────────────────────────

describe("Phase 2l-c — metadata fields are echoed verbatim or defaulted, never from wall clock", () => {
  it("omitted runLabel / operator → null, omitted source → manual", () => {
    const r = buildPhase2CloseOutReport();
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source,   "manual");
    assert.equal(r.generatedAt, null);
  });

  it("empty / non-string runLabel / operator / source coerce to defaults", () => {
    const r = buildPhase2CloseOutReport({
      runLabel: "",
      operator: 42 as any,
      source:   null as any,
    });
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source,   "manual");
  });
});

// ── No mutation of inputs / external state ─────────────────────────────────

describe("Phase 2l-c — report does not mutate its inputs or external state", () => {
  it("input arrays/objects are unchanged after the call", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-no-mutate",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const decisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "x",
      decidedAt: PINNED_AT,
    }));
    const ctx = broadHypothesisContext();
    const rv  = pinnedRuntimeVisibility();
    const sr  = pinnedSandboxReadiness();
    const ri  = pinnedRiskImpact();
    const att = allSatisfied();

    const harnessInputs = {
      history,
      operatorDecisions: decisions,
      hypothesisContext: ctx,
      now: PINNED_AT,
    };
    const reportInputs = {
      runLabel: "label",
      operator: "op",
      source:   "src",
      runtimeVisibility: rv,
      sandboxReadiness:  sr,
      riskImpact:        ri,
      phase3Attestations: att,
      learningLoopInputs: { harnessInputs },
    };

    const beforeHistoryJson    = JSON.stringify(history);
    const beforeDecisionsJson  = JSON.stringify(decisions);
    const beforeCtxJson        = JSON.stringify(ctx);
    const beforeRvJson         = JSON.stringify(rv);
    const beforeSrJson         = JSON.stringify(sr);
    const beforeRiJson         = JSON.stringify(ri);
    const beforeAttJson        = JSON.stringify(att);
    const beforeHarnessJson    = JSON.stringify(harnessInputs);
    const beforeReportJson     = JSON.stringify(reportInputs);

    buildPhase2CloseOutReport(reportInputs);

    assert.equal(JSON.stringify(history),       beforeHistoryJson,   "history was mutated");
    assert.equal(JSON.stringify(decisions),     beforeDecisionsJson, "decisions were mutated");
    assert.equal(JSON.stringify(ctx),           beforeCtxJson,       "hypothesis context was mutated");
    assert.equal(JSON.stringify(rv),            beforeRvJson,        "runtime visibility was mutated");
    assert.equal(JSON.stringify(sr),            beforeSrJson,        "sandbox readiness was mutated");
    assert.equal(JSON.stringify(ri),            beforeRiJson,        "risk impact was mutated");
    assert.equal(JSON.stringify(att),           beforeAttJson,       "attestations were mutated");
    assert.equal(JSON.stringify(harnessInputs), beforeHarnessJson,   "harnessInputs was mutated");
    assert.equal(JSON.stringify(reportInputs),  beforeReportJson,    "reportInputs was mutated");
  });

  it("source file does not call Date.now / Math.random / randomUUID / read process.env / write to fs", async () => {
    const src = await fs.promises.readFile(
      path.join(REPO_ROOT, "server", "experiments", "phase2CloseOutReport.ts"),
      "utf8",
    );
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.ok(!/Date\.now\s*\(/.test(codeOnly),    "report must not call Date.now()");
    assert.ok(!/Math\.random\s*\(/.test(codeOnly), "report must not call Math.random()");
    assert.ok(!/randomUUID\s*\(/.test(codeOnly),   "report must not call randomUUID()");
    assert.ok(!/process\.env/.test(codeOnly),      "report must not read process.env");
    assert.ok(!/fs\.write/.test(codeOnly),         "report must not write to fs");
    assert.ok(!/appendFile/.test(codeOnly),        "report must not append to fs");
    assert.ok(!/from\s+["'][^"']*autonomyMonitor/.test(src),           "report must not import autonomyMonitor");
    assert.ok(!/from\s+["'][^"']*selfRecommendationEngine/.test(src),  "report must not import selfRecommendationEngine");
    assert.ok(!/from\s+["'][^"']*selfRecommendationRouter/.test(src),  "report must not import selfRecommendationRouter");
    assert.ok(!/from\s+["'][^"']*promotionGate/.test(src),             "report must not import promotionGate");
    assert.ok(!/from\s+["'][^"']*scheduler/i.test(src),                "report must not import any scheduler");
    assert.ok(!/from\s+["'][^"']*autonomyRuntimeVisibility/.test(src), "report must not import live runtime visibility (caller injects)");
  });

  it("report module is not imported by runtime / monitor / scheduler / apply / promote files", async () => {
    const forbidden = [
      "server/index.ts",
      "server/autonomyMonitor.ts",
      "server/selfRecommendationEngine.ts",
      "server/selfRecommendationRouter.ts",
      "server/eval/promotionGate.ts",
    ];
    for (const rel of forbidden) {
      const p = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const src = await fs.promises.readFile(p, "utf8");
      assert.ok(
        !src.includes("phase2CloseOutReport"),
        `${rel} must not import the Phase 2l-c report — propose-only invariant`,
      );
    }
  });
});

// ── Programmer-shaped misuse ───────────────────────────────────────────────

describe("Phase 2l-c — programmer-shaped misuse throws TypeError", () => {
  it("non-object input throws", () => {
    assert.throws(() => buildPhase2CloseOutReport(null as any), TypeError);
    assert.throws(() => buildPhase2CloseOutReport("nope" as any), TypeError);
    assert.throws(() => buildPhase2CloseOutReport(42 as any), TypeError);
  });

  it("non-object learningLoopInputs throws", () => {
    assert.throws(
      () => buildPhase2CloseOutReport({ learningLoopInputs: "nope" as any }),
      TypeError,
    );
  });
});

// ── Disabled kinds stay disabled ───────────────────────────────────────────

describe("Phase 2l-c — disabled sandbox kinds remain disabled through the close-out", () => {
  it("the embedded learning-loop suggestions / approvals stay inert for disabled-kind rows", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-c-disabled",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });

    const disabledLessons = dry.lessonTable.lessons.filter(
      l => l.reasonCode === "disabled_kind_remains_disabled",
    );
    assert.ok(disabledLessons.length >= 1);

    const decisions = disabledLessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "describing disabled state",
      decidedAt: PINNED_AT,
    }));

    const r = buildPhase2CloseOutReport({
      runtimeVisibility: pinnedRuntimeVisibility(),
      sandboxReadiness:  pinnedSandboxReadiness(),
      riskImpact:        pinnedRiskImpact(),
      learningLoopInputs: {
        harnessInputs: {
          history,
          operatorDecisions: decisions,
          hypothesisContext: {
            hypothesisId: "hyp:disabled",
            reasonCodes:  ["disabled_kind_remains_disabled"],
          },
          now: PINNED_AT,
        },
      },
    });

    for (const ar of r.learningLoopReport.harnessResult.approvalResults) {
      assert.equal((ar as any).ok, true);
      const rec = ar as any;
      assert.equal(rec.lesson.active, false);
      assert.equal(rec.lesson.autoApplyEligible, false);
      assert.equal(rec.lesson.runtimeActionEligible, false);
      assert.equal(rec.lesson.publicActionEligible, false);
    }
    for (const s of r.learningLoopReport.harnessResult.suggestionSet.suggestions) {
      assert.equal(s.reasonCode, "disabled_kind_remains_disabled");
      assert.equal(s.suggestionOnly, true);
      assert.equal(s.autoApplyEligible, false);
      assert.equal(s.applyEligibility, "none");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
      assert.ok(!/enable/i.test(s.body),
        `suggestion body must not propose enabling: ${s.body}`);
    }
    // The close-out report itself cannot enable a kind.
    assert.equal(r.invariants.observationalOnly, true);
    assert.equal(r.invariants.closeOutOnly,      true);
    assert.equal(r.invariants.phase3Gated,       true);
  });
});

// ── Serializer shape ───────────────────────────────────────────────────────

describe("Phase 2l-c — serialised report has stable shape", () => {
  it("serialised report contains all required top-level keys in fixed order", () => {
    const r = buildPhase2CloseOutReport();
    const s = serializePhase2CloseOutReport(r);
    const o = JSON.parse(s);
    const keys = Object.keys(o);
    assert.deepEqual(keys, [
      "schemaVersion",
      "label",
      "runLabel",
      "operator",
      "source",
      "generatedAt",
      "learningLoopStatus",
      "readinessRecommendation",
      "readinessRationale",
      "inputsSummary",
      "runtimeVisibility",
      "sandboxReadiness",
      "riskImpact",
      "safety",
      "phase3Gating",
      "blockers",
      "warnings",
      "safetyDisclaimer",
      "learningLoopSummary",
      "invariants",
    ]);
    assert.equal(o.invariants.observationalOnly, true);
    assert.equal(o.invariants.closeOutOnly,      true);
    assert.equal(o.invariants.phase3Gated,       true);
  });
});
