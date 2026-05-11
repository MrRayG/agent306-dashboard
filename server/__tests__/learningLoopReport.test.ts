/**
 * Tests for Phase 2l-b — manual learning loop report (read-only / test-only).
 *
 * Spec invariants pinned by this file:
 *   1. End-to-end seeded happy path: a successful harness run maps to a
 *      report with `overallStatus: "success"`, `priority: "informational"`,
 *      non-zero metrics across every stage, a populated safety table, and
 *      the verbatim safety disclaimer block.
 *   2. Cold path: with no evidence / decisions / context the harness
 *      reports cold; the report mirrors `overallStatus: "cold"`,
 *      `priority: "none"`, zero metrics, no blockers, and exactly one
 *      informational warning (`cold_run_no_positive_evidence`).
 *   3. Partial path: unmatched operator decision → `overallStatus:
 *      "partial"`, `priority: "attention"`, and a blocker with code
 *      `unmatched_operator_decisions`.
 *   4. Safety-warning path: when a stage's safety invariant is forced
 *      false, the report status is `safety_warning`, priority is
 *      `urgent`, and the blockers list contains
 *      `safety_invariant_violation`.
 *   5. Deterministic repeated runs: same injected inputs → deeply equal
 *      result + byte-identical serialised string.
 *   6. No side effects: the on-disk sandbox registration ledger, the
 *      data fixtures, the env, and the input objects themselves are
 *      byte-identical after every test.
 *   7. Metadata fields (runLabel, operator, source) are echoed verbatim
 *      when supplied, default to `null` / `"manual"` when omitted, and
 *      never read from the wall clock.
 *   8. Safety contract: every embedded artefact still carries its
 *      propose-only / suggestion-only invariants, AND the report adds
 *      `observationalOnly: true` to its own invariant block.
 *   9. The report module is NOT imported by runtime / monitor /
 *      scheduler / apply / promote / UI / API files.
 *  10. Programmer-shaped misuse (non-object input) throws a TypeError.
 *  11. The report source does NOT call Date.now / Math.random /
 *      randomUUID / read process.env / write to fs.
 *  12. Disabled sandbox kinds remain disabled — the report describes
 *      their disabled state but never proposes enabling them.
 *  13. Hypothesis-context-without-suggestions surfaces as a blocker
 *      (`no_suggestions_for_provided_context`) when the harness is not
 *      cold but the suggestion stage came back empty.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2lb-learning-loop-report-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildLearningLoopReport,
  serializeLearningLoopReport,
  LEARNING_LOOP_REPORT_SCHEMA_VERSION,
  LEARNING_LOOP_REPORT_LABEL,
  LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER,
} = await import("../experiments/learningLoopReport.ts");

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

const PINNED_AT = "2026-05-11T17:00:00.000Z";

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
      if (!after.exists) throw new Error(`Phase 2l-b tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-b tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-b tests created live ${label}!`);
    }
  }
});

function broadHypothesisContext(hypothesisId = "hyp:report:e2e") {
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

// ── Schema / label sanity ──────────────────────────────────────────────────

describe("Phase 2l-b — schema constants", () => {
  it("exposes a stable schema version, label, and safety disclaimer", () => {
    assert.equal(LEARNING_LOOP_REPORT_SCHEMA_VERSION, "phase2l-b.v1");
    assert.equal(LEARNING_LOOP_REPORT_LABEL, "agent306.manual_learning_loop_report");
    assert.ok(Array.isArray(LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER));
    assert.ok(LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER.length >= 1);
    // Safety disclaimer must explicitly say read-only / propose-only.
    const joined = LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER.join(" ");
    assert.ok(/read-only/i.test(joined),    "disclaimer must mention read-only");
    assert.ok(/propose-only/i.test(joined), "disclaimer must mention propose-only");
  });
});

// ── Cold path ──────────────────────────────────────────────────────────────

describe("Phase 2l-b — cold path: no evidence / no decisions / no context", () => {
  it("returns a cold report with priority=none, zero metrics, and a cold warning", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const r = buildLearningLoopReport();
    assert.equal(r.schemaVersion, LEARNING_LOOP_REPORT_SCHEMA_VERSION);
    assert.equal(r.label,         LEARNING_LOOP_REPORT_LABEL);
    assert.equal(r.overallStatus, "cold");
    assert.equal(r.priority,      "none");
    assert.equal(r.runLabel,      null);
    assert.equal(r.operator,      null);
    assert.equal(r.source,        "manual");
    assert.equal(r.generatedAt,   null);

    // Metrics are all zero.
    assert.equal(r.metrics.approvalDecisionCount,    0);
    assert.equal(r.metrics.approvalRefusalCount,     0);
    assert.equal(r.metrics.hypothesisSuggestionCount, 0);
    assert.equal(r.metrics.hypothesisIneligibleCount, 0);
    assert.equal(r.metrics.unmatchedDecisionCount,    0);
    assert.equal(r.metrics.safetyInvariantsHeld,      true);

    // No blockers, exactly one informational cold warning.
    assert.equal(r.blockers.length, 0);
    const coldWarnings = r.warnings.filter(w => w.code === "cold_run_no_positive_evidence");
    assert.equal(coldWarnings.length, 1, "expected exactly one cold warning");

    // Safety contract.
    assert.equal(r.safety.allInvariantsHeld, true);

    // Verbatim disclaimer.
    assert.deepEqual(r.safetyDisclaimer, [...LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER]);

    // Static invariants restated (including observationalOnly).
    assert.equal(r.invariants.readOnly, true);
    assert.equal(r.invariants.proposeOnly, true);
    assert.equal(r.invariants.testOnly, true);
    assert.equal(r.invariants.observationalOnly, true);
    assert.equal(r.invariants.autoApplyEligible, false);
    assert.equal(r.invariants.runtimeActionEligible, false);
    assert.equal(r.invariants.publicActionEligible, false);
    assert.equal(r.invariants.schedulerDriven, false);
  });

  it("inputsSummary echoes flags accurately on cold input", () => {
    const r = buildLearningLoopReport();
    assert.equal(r.inputsSummary.nowProvided, false);
    assert.equal(r.inputsSummary.evidenceInjected, false);
    assert.equal(r.inputsSummary.operatorDecisionCount, 0);
    assert.equal(r.inputsSummary.hypothesisContextProvided, false);
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe("Phase 2l-b — seeded happy path: every stage populated", () => {
  it("maps a successful harness run to success/informational with non-zero metrics", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-b-e2e",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true, `fixture seed failed: ${(seed as any).reason}`);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    assert.ok(dry.lessonTable.lessons.length >= 1);

    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op@phase2l-b",
      rationale: "phase 2l-b report happy path",
      decidedAt: PINNED_AT,
    }));

    const r = buildLearningLoopReport({
      runLabel: "phase2l-b-daily-2026-05-11",
      operator: "op@phase2l-b",
      source:   "test:phase2l-b",
      harnessInputs: {
        history,
        operatorDecisions,
        hypothesisContext: broadHypothesisContext(),
        now:     PINNED_AT,
        generatedBy: "phase2l-b-test",
      },
    });

    assert.equal(r.overallStatus, "success");
    assert.equal(r.priority,      "informational");
    assert.equal(r.runLabel,      "phase2l-b-daily-2026-05-11");
    assert.equal(r.operator,      "op@phase2l-b");
    assert.equal(r.source,        "test:phase2l-b");
    assert.equal(r.generatedAt,   PINNED_AT);

    // Inputs summary.
    assert.equal(r.inputsSummary.nowProvided, true);
    assert.equal(r.inputsSummary.evidenceInjected, true);
    assert.equal(r.inputsSummary.operatorDecisionCount, operatorDecisions.length);
    assert.equal(r.inputsSummary.hypothesisContextProvided, true);

    // Non-zero metrics.
    assert.ok(r.metrics.reflectionCandidateCount >= 1);
    assert.ok(r.metrics.proposedLessonCount >= 1);
    assert.equal(r.metrics.approvalDecisionCount, operatorDecisions.length);
    assert.equal(r.metrics.approvalRefusalCount, 0);
    assert.equal(r.metrics.unmatchedDecisionCount, 0);
    assert.ok(r.metrics.hypothesisSuggestionCount >= 1);
    assert.ok(r.metrics.qualityScore > 0);
    assert.ok(["low", "moderate", "high"].includes(r.metrics.qualityBand));
    assert.equal(r.metrics.safetyInvariantsHeld, true);

    // Safety table holds.
    assert.equal(r.safety.allInvariantsHeld, true);

    // No blockers on the happy path.
    assert.equal(r.blockers.length, 0);

    // Safety disclaimer present.
    assert.ok(r.safetyDisclaimer.length >= 1);

    // Embedded harness result is the real harness result, with matching status.
    assert.equal(r.harnessResult.overallStatus, "success");
    assert.equal(r.harnessResult.label, "agent306.learning_loop_test_harness");
  });
});

// ── Partial path ───────────────────────────────────────────────────────────

describe("Phase 2l-b — partial path: unmatched operator decisions", () => {
  it("returns overallStatus=partial, priority=attention, and an unmatched-decisions blocker", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const r = buildLearningLoopReport({
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
    });
    assert.equal(r.overallStatus, "partial");
    assert.equal(r.priority,      "attention");

    const unmatched = r.blockers.find(b => b.code === "unmatched_operator_decisions");
    assert.ok(unmatched, "expected unmatched_operator_decisions blocker");
    assert.match(unmatched!.message, /1 operator decision/);

    // No approval refusals were produced.
    assert.equal(r.metrics.approvalRefusalCount, 0);
    assert.equal(r.metrics.unmatchedDecisionCount, 1);
  });

  it("returns an approval_refusals blocker on missing-operator decisions", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-b-refusal",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    assert.ok(dry.lessonTable.lessons.length >= 1);

    const r = buildLearningLoopReport({
      harnessInputs: {
        history,
        operatorDecisions: [{
          lessonId:  dry.lessonTable.lessons[0].lessonId,
          decision:  "approved",
          operator:  "",                    // missing → refusal
          rationale: "rationale",
          decidedAt: PINNED_AT,
        }],
        now: PINNED_AT,
      },
    });
    assert.equal(r.metrics.approvalRefusalCount, 1);
    const refusal = r.blockers.find(b => b.code === "approval_refusals");
    assert.ok(refusal, "expected approval_refusals blocker");
    // A missing-operator does not flag a safety invariant violation — only
    // a refusal record. The safety table must still hold.
    assert.equal(r.safety.allInvariantsHeld, true);
  });

  it("returns no_suggestions_for_provided_context when context yields zero suggestions", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-b-no-sugg",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();

    // Provide a context with subsystems / scopes that won't match anything
    // and NO operator decisions (so no approved records to project from).
    const r = buildLearningLoopReport({
      harnessInputs: {
        history,
        hypothesisContext: {
          hypothesisId: "hyp:nomatch",
          subsystems: ["nope_subsystem"] as any,
          scopePrefixes: ["nope."],
        },
        now: PINNED_AT,
      },
    });

    if (r.overallStatus !== "cold") {
      const sigBlock = r.blockers.find(b => b.code === "no_suggestions_for_provided_context");
      assert.ok(sigBlock, "expected no_suggestions_for_provided_context blocker on non-cold run");
    }
  });
});

// ── Safety-warning path ────────────────────────────────────────────────────

describe("Phase 2l-b — safety_warning harness result maps to urgent priority", () => {
  it("flagging safety_invariant_violation on a synthetic forged harness result", async () => {
    // The Phase 2l-a harness already throws if its inputs are misused, and
    // its embedded artefacts are guard-checked — there is no public knob to
    // *force* the harness to emit a safety violation. We construct a minimal
    // forged harness result and feed it through the report's signal builder
    // indirectly by monkey-patching the harness function. We do NOT mutate
    // any module export at the top-level: we patch on a private dynamic
    // import that we own for this single test.
    //
    // Instead of patching, we build a forged harness payload by hand and
    // verify the report-status mapping directly via the report's exported
    // priority/status logic — see the next test. This test pins that the
    // *report-side* derivation surfaces "safety_warning" → "urgent" in
    // every code path that consumes the underlying harness status field.
    // The forged-result test exercises the actual signal-building code.

    // We use the report builder with a candidateSetOverride that supplies
    // exactly one candidate whose invariants are intentionally absent, so
    // the harness's safety check trips. The harness then surfaces
    // `safety_warning` via its own `deriveOverallStatus`.
    const r = buildLearningLoopReport({
      harnessInputs: {
        candidateSetOverride: {
          // Minimum-shape candidate set the harness can consume without
          // throwing, but with an invariants field that fails the per-stage
          // safety check.
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
        } as any,
        now: PINNED_AT,
      },
    });

    assert.equal(r.overallStatus, "safety_warning",
      `expected safety_warning, got ${r.overallStatus}`);
    assert.equal(r.priority,      "urgent");
    assert.equal(r.safety.allInvariantsHeld, false);
    const safetyBlocker = r.blockers.find(b => b.code === "safety_invariant_violation");
    assert.ok(safetyBlocker, "expected safety_invariant_violation blocker");
    assert.match(safetyBlocker!.message, /reflectionCandidates/);
  });
});

// ── Determinism ────────────────────────────────────────────────────────────

describe("Phase 2l-b — repeated runs are deeply equal and byte-identical", () => {
  it("running the report twice with identical inputs returns identical output", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-b-det",
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
      runLabel: "phase2l-b-det",
      operator: "op",
      source:   "test",
      harnessInputs: {
        history,
        operatorDecisions,
        hypothesisContext: broadHypothesisContext(),
        now: PINNED_AT,
      },
    };

    const a = buildLearningLoopReport(inputs);
    const b = buildLearningLoopReport(inputs);

    // Deep equality on every top-level summary field.
    assert.deepEqual(a.metrics,        b.metrics);
    assert.deepEqual(a.safety,         b.safety);
    assert.deepEqual(a.inputsSummary,  b.inputsSummary);
    assert.deepEqual(a.blockers,       b.blockers);
    assert.deepEqual(a.warnings,       b.warnings);
    assert.deepEqual(a.safetyDisclaimer, b.safetyDisclaimer);
    assert.deepEqual(a.invariants,     b.invariants);

    // Byte-identical serialisation.
    assert.equal(
      serializeLearningLoopReport(a),
      serializeLearningLoopReport(b),
    );

    // Pretty-printed form is also byte-identical.
    assert.equal(
      serializeLearningLoopReport(a, { indent: 2 }),
      serializeLearningLoopReport(b, { indent: 2 }),
    );
  });
});

// ── Metadata fields ────────────────────────────────────────────────────────

describe("Phase 2l-b — metadata fields are echoed verbatim or defaulted, never derived from wall clock", () => {
  it("omitted runLabel / operator → null, omitted source → manual", () => {
    const r = buildLearningLoopReport();
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source,   "manual");
    assert.equal(r.generatedAt, null);
  });

  it("supplied empty-string runLabel / operator / source coerce to defaults", () => {
    const r = buildLearningLoopReport({
      runLabel: "",
      operator: "",
      source:   "",
    });
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source,   "manual");
  });

  it("supplied non-string runLabel / operator / source coerce to defaults", () => {
    const r = buildLearningLoopReport({
      runLabel: 42 as any,
      operator: { x: 1 } as any,
      source:   null as any,
    });
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source,   "manual");
  });

  it("generatedAt mirrors harness's generatedAt, which mirrors harnessInputs.now", () => {
    const r = buildLearningLoopReport({
      harnessInputs: { now: PINNED_AT },
    });
    assert.equal(r.generatedAt, PINNED_AT);
  });
});

// ── No mutation of inputs / external state ─────────────────────────────────

describe("Phase 2l-b — report does not mutate its inputs or external state", () => {
  it("input arrays/objects are unchanged after the call", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-b-no-mutate",
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
      harnessInputs,
    };

    const beforeHistoryJson    = JSON.stringify(history);
    const beforeDecisionsJson  = JSON.stringify(decisions);
    const beforeCtxJson        = JSON.stringify(ctx);
    const beforeHarnessJson    = JSON.stringify(harnessInputs);
    const beforeReportJson     = JSON.stringify(reportInputs);

    buildLearningLoopReport(reportInputs);

    assert.equal(JSON.stringify(history),       beforeHistoryJson,   "history was mutated");
    assert.equal(JSON.stringify(decisions),     beforeDecisionsJson, "decisions were mutated");
    assert.equal(JSON.stringify(ctx),           beforeCtxJson,       "hypothesis context was mutated");
    assert.equal(JSON.stringify(harnessInputs), beforeHarnessJson,   "harnessInputs was mutated");
    assert.equal(JSON.stringify(reportInputs),  beforeReportJson,    "reportInputs was mutated");
  });

  it("source file does not call Date.now / Math.random / randomUUID / read process.env / write to fs", async () => {
    const src = await fs.promises.readFile(
      path.join(REPO_ROOT, "server", "experiments", "learningLoopReport.ts"),
      "utf8",
    );
    // Strip line comments and block comments so docstring references to
    // forbidden APIs don't trip the regex.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.ok(!/Date\.now\s*\(/.test(codeOnly),    "report must not call Date.now()");
    assert.ok(!/Math\.random\s*\(/.test(codeOnly), "report must not call Math.random()");
    assert.ok(!/randomUUID\s*\(/.test(codeOnly),   "report must not call randomUUID()");
    assert.ok(!/process\.env/.test(codeOnly),      "report must not read process.env");
    assert.ok(!/fs\.write/.test(codeOnly),         "report must not write to fs");
    assert.ok(!/appendFile/.test(codeOnly),        "report must not append to fs");
    // Belt-and-suspenders: the report must not import any scheduler /
    // monitor / promotion / apply / UI / API symbol.
    assert.ok(!/from\s+["'][^"']*autonomyMonitor/.test(src), "report must not import autonomyMonitor");
    assert.ok(!/from\s+["'][^"']*selfRecommendationEngine/.test(src), "report must not import selfRecommendationEngine");
    assert.ok(!/from\s+["'][^"']*promotionGate/.test(src), "report must not import promotionGate");
    assert.ok(!/from\s+["'][^"']*scheduler/i.test(src),    "report must not import any scheduler");
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
        !src.includes("learningLoopReport"),
        `${rel} must not import the Phase 2l-b report — propose-only invariant`,
      );
    }
  });
});

// ── Programmer-shaped misuse ───────────────────────────────────────────────

describe("Phase 2l-b — programmer-shaped misuse throws TypeError", () => {
  it("non-object input throws", () => {
    assert.throws(() => buildLearningLoopReport(null as any), TypeError);
    assert.throws(() => buildLearningLoopReport("nope" as any), TypeError);
    assert.throws(() => buildLearningLoopReport(42 as any), TypeError);
  });

  it("non-object harnessInputs throws", () => {
    assert.throws(
      () => buildLearningLoopReport({ harnessInputs: "nope" as any }),
      TypeError,
    );
    assert.throws(
      () => buildLearningLoopReport({ harnessInputs: 7 as any }),
      TypeError,
    );
  });
});

// ── Disabled kinds stay disabled ───────────────────────────────────────────

describe("Phase 2l-b — disabled sandbox kinds remain disabled through the report", () => {
  it("disabled-kind lessons surface inertly: status proposed, approval inactive, suggestions never propose enabling", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-b-disabled",
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

    const r = buildLearningLoopReport({
      harnessInputs: {
        history,
        operatorDecisions: decisions,
        hypothesisContext: {
          hypothesisId: "hyp:disabled",
          reasonCodes:  ["disabled_kind_remains_disabled"],
        },
        now: PINNED_AT,
      },
    });

    // The embedded harness still surfaces every disabled-kind row inert.
    for (const ar of r.harnessResult.approvalResults) {
      assert.equal((ar as any).ok, true);
      const rec = ar as any;
      assert.equal(rec.lesson.active, false);
      assert.equal(rec.lesson.autoApplyEligible, false);
      assert.equal(rec.lesson.runtimeActionEligible, false);
      assert.equal(rec.lesson.publicActionEligible, false);
    }
    for (const s of r.harnessResult.suggestionSet.suggestions) {
      assert.equal(s.reasonCode, "disabled_kind_remains_disabled");
      assert.equal(s.suggestionOnly, true);
      assert.equal(s.autoApplyEligible, false);
      assert.equal(s.applyEligibility, "none");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
      assert.ok(!/enable/i.test(s.body),
        `suggestion body must not propose enabling: ${s.body}`);
    }
    // The report itself must not say anything that enables a kind. The
    // safety table must still hold.
    assert.equal(r.safety.allInvariantsHeld, true);
    // Report cannot become non-observational regardless of inputs.
    assert.equal(r.invariants.observationalOnly, true);
  });
});

// ── Serializer shape ───────────────────────────────────────────────────────

describe("Phase 2l-b — serialised report has stable shape", () => {
  it("serialised report contains all required top-level keys in fixed order", () => {
    const r = buildLearningLoopReport();
    const s = serializeLearningLoopReport(r);
    const o = JSON.parse(s);
    const keys = Object.keys(o);
    assert.deepEqual(keys, [
      "schemaVersion",
      "label",
      "runLabel",
      "operator",
      "source",
      "generatedAt",
      "overallStatus",
      "priority",
      "inputsSummary",
      "metrics",
      "safety",
      "blockers",
      "warnings",
      "safetyDisclaimer",
      "harnessSummary",
      "invariants",
    ]);
    assert.equal(o.invariants.observationalOnly, true);
  });
});
