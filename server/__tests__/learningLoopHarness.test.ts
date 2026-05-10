/**
 * Tests for Phase 2l-a — end-to-end learning loop test harness.
 *
 * Spec invariants pinned by this file:
 *   1. End-to-end seeded happy path: seeded summarizationTemplate fixture
 *      evidence → reflection candidates, advisory quality score, proposed
 *      lessons, explicit approval decision records, and read-only
 *      hypothesis suggestions.
 *   2. Empty / cold path: with no evidence, no decisions, no context the
 *      harness returns `overallStatus: "cold"`, zero counts across every
 *      stage, and `safety.allInvariantsHeld: true` (cold ≠ failure).
 *   3. Deterministic repeated runs: same injected inputs → deeply equal
 *      result + byte-identical serialised string.
 *   4. No side effects: real data fixtures, the on-disk sandbox registration
 *      ledger, the env, and the input objects themselves are byte-identical
 *      after every test.
 *   5. Safety invariants restated: every reflection candidate, quality
 *      score, proposed lesson, approval record (ok-row), and suggestion
 *      carries its documented propose-only / suggestion-only contract.
 *   6. Disabled sandbox kinds remain disabled: lessons / suggestions about
 *      disabled kinds describe the disabled state but never propose
 *      enabling.
 *   7. The harness module is NOT imported by runtime / monitor / scheduler /
 *      apply / promotion files. Only its tests reference it.
 *   8. Programmer-shaped misuse (non-object input) throws a TypeError.
 *   9. Unmatched operator decisions surface as `unmatchedDecisions[]`
 *      with `reason: "lesson_not_found"` and never cause the harness to
 *      throw.
 *  10. Refusal-shaped approval results (missing operator etc.) surface as
 *      refusal entries in `approvalResults[]` and contribute to
 *      `approvalRefusalCount`, never to `approvalDecisionCount`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so the harness's evidence helpers
// see a clean state and so we can confirm later that no real ledger files
// were touched. The harness itself does no I/O — these guards are
// belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2la-learning-loop-harness-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  runLearningLoopHarness,
  serializeLearningLoopHarnessResult,
  LEARNING_LOOP_HARNESS_SCHEMA_VERSION,
  LEARNING_LOOP_HARNESS_LABEL,
} = await import("../experiments/learningLoopHarness.ts");

const {
  buildSandboxRegistrationHistorySnapshot,
} = await import("../experiments/sandboxRegistrationHistory.ts");

const {
  executeSummarizationFixtureRegistration,
} = await import("../experiments/summarizationSandboxFixtureRegistration.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);

const PINNED_AT = "2026-05-10T17:00:00.000Z";

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
      if (!after.exists) throw new Error(`Phase 2l-a tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-a tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-a tests created live ${label}!`);
    }
  }
});

function broadHypothesisContext(hypothesisId = "hyp:harness:e2e") {
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

describe("Phase 2l-a — schema constants", () => {
  it("exposes a stable schema version and label", () => {
    assert.equal(LEARNING_LOOP_HARNESS_SCHEMA_VERSION, "phase2l-a.v1");
    assert.equal(LEARNING_LOOP_HARNESS_LABEL, "agent306.learning_loop_test_harness");
  });
});

// ── Cold / empty path ──────────────────────────────────────────────────────

describe("Phase 2l-a — cold harness path handles missing evidence gracefully", () => {
  it("no inputs at all (no positive evidence, no decisions, no context) → overallStatus=cold, no overstated success", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const r = runLearningLoopHarness();
    assert.equal(r.schemaVersion, LEARNING_LOOP_HARNESS_SCHEMA_VERSION);
    assert.equal(r.label,         LEARNING_LOOP_HARNESS_LABEL);
    assert.equal(r.overallStatus, "cold",
      "harness must report cold when no positive evidence / decisions / context");
    assert.equal(r.generatedAt,   null);
    assert.equal(r.generatedBy,   "learning_loop_harness");

    // Action-stage counts are zero — no operator decisions, no context.
    assert.equal(r.metrics.approvalDecisionCount,              0);
    assert.equal(r.metrics.approvalRefusalCount,               0);
    assert.equal(r.metrics.hypothesisSuggestionCount,          0);
    assert.equal(r.metrics.hypothesisIneligibleCount,          0);
    assert.equal(r.metrics.unmatchedDecisionCount,             0);
    assert.equal(r.metrics.safetyInvariantsHeld,               true);

    // No positive-evidence reason code is in the candidate set.
    const POSITIVE = new Set([
      "evidence_present_summarization_fixture",
      "registration_history_populated",
      "audit_export_present",
      "risk_impact_blocked_present",
      "risk_impact_needs_review_present",
    ]);
    for (const c of r.candidateSet.candidates) {
      assert.ok(!POSITIVE.has(c.reasonCode),
        `cold harness emitted positive-evidence reason code: ${c.reasonCode}`);
    }

    // Suggestion / approval embedded stages are empty.
    assert.equal(r.approvalResults.length, 0);
    assert.equal(r.suggestionSet.suggestions.length, 0);
    assert.equal(r.suggestionSet.ineligibleRecords.length, 0);

    // Safety contract — every per-stage check passes.
    assert.equal(r.safety.allInvariantsHeld, true);
    assert.equal(r.safety.reflectionCandidatesProposeOnly, true);
    assert.equal(r.safety.qualityScoreAdvisoryOnly,        true);
    assert.equal(r.safety.proposedLessonsProposeOnly,      true);
    assert.equal(r.safety.approvalRecordsRuntimeInactive,  true);
    assert.equal(r.safety.suggestionsSuggestionOnly,       true);

    // Static invariants restated.
    assert.equal(r.invariants.readOnly, true);
    assert.equal(r.invariants.proposeOnly, true);
    assert.equal(r.invariants.testOnly, true);
    assert.equal(r.invariants.autoApplyEligible, false);
    assert.equal(r.invariants.runtimeActionEligible, false);
    assert.equal(r.invariants.publicActionEligible, false);
  });

  it("empty injected snapshots → still cold (no positive-evidence codes)", () => {
    const r = runLearningLoopHarness({
      history:     buildSandboxRegistrationHistorySnapshot(),
      readiness:   { kinds: [] } as any,
      // No riskImpact, no candidateSetOverride, no decisions, no context.
    });
    assert.equal(r.overallStatus, "cold");
    assert.equal(r.safety.allInvariantsHeld, true);
  });
});

// ── End-to-end seeded happy path ───────────────────────────────────────────

describe("Phase 2l-a — seeded e2e produces candidates, score, lessons, approvals, suggestions", () => {
  it("happy path: every stage produces output and safety holds", () => {
    // Reset and seed a fresh summarizationTemplate fixture row into the
    // per-test ledger. Phase 2i-a guarantees this is registration-only.
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seedNow = new Date(PINNED_AT);
    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-a-e2e",
      now:    seedNow,
    });
    assert.equal((seed as any).ok, true, `fixture seed failed: ${(seed as any).reason}`);

    // Build a candidate set + lesson table via the harness with NO operator
    // decisions first — we use the resulting lesson ids to construct the
    // operator decisions deterministically.
    const dry = runLearningLoopHarness({
      history: buildSandboxRegistrationHistorySnapshot(),
      now:     PINNED_AT,
    });
    assert.ok(dry.lessonTable.lessons.length >= 1,
      `expected at least one proposed lesson, got ${dry.lessonTable.lessons.length}`);

    // Approve every proposed lesson.
    const operatorDecisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op@phase2l-a",
      rationale: "phase 2l-a e2e harness approval",
      decidedAt: PINNED_AT,
    }));

    const r = runLearningLoopHarness({
      history: buildSandboxRegistrationHistorySnapshot(),
      operatorDecisions,
      hypothesisContext: broadHypothesisContext(),
      now:     PINNED_AT,
      generatedBy: "phase2l-a-test",
    });

    // Overall status: success (every stage populated, safety holds).
    assert.equal(r.overallStatus, "success");
    assert.equal(r.generatedAt, PINNED_AT);
    assert.equal(r.generatedBy, "phase2l-a-test");

    // Reflection.
    assert.ok(r.metrics.reflectionCandidateCount >= 1,
      `expected >=1 reflection candidate, got ${r.metrics.reflectionCandidateCount}`);
    for (const c of r.candidateSet.candidates) {
      assert.equal(c.humanReviewRequired, true);
      assert.equal(c.autoApplyEligible,   false);
      assert.equal(c.invariants.proposeOnly, true);
      assert.equal(c.invariants.publicAction, false);
      assert.equal(c.invariants.schedulerDriven, false);
      assert.equal(c.invariants.mutating, false);
    }

    // Quality score — non-zero, advisory-only.
    assert.ok(r.metrics.qualityScore > 0,
      `expected non-zero quality score, got ${r.metrics.qualityScore}`);
    assert.ok(["low", "moderate", "high"].includes(r.metrics.qualityBand),
      `expected non-cold quality band, got ${r.metrics.qualityBand}`);
    assert.equal(r.qualityScore.advisoryOnly, true);
    assert.equal(r.qualityScore.applyEligibility, "none");

    // Lessons.
    assert.equal(r.metrics.proposedLessonCount, r.lessonTable.lessons.length);
    for (const l of r.lessonTable.lessons) {
      assert.equal(l.status, "proposed");
      assert.equal(l.active, false);
      assert.equal(l.autoApplyEligible, false);
      assert.equal(l.applyEligibility, "none");
      assert.equal(l.humanReviewRequired, true);
    }

    // Approvals — one ok record per proposed lesson, no refusals.
    assert.equal(r.metrics.approvalDecisionCount, operatorDecisions.length);
    assert.equal(r.metrics.approvalRefusalCount, 0);
    assert.equal(r.metrics.unmatchedDecisionCount, 0);
    for (const ar of r.approvalResults) {
      assert.equal((ar as any).ok, true);
      const rec = ar as any;
      assert.equal(rec.lesson.active, false);
      assert.equal(rec.lesson.runtimeActionEligible, false);
      assert.equal(rec.lesson.publicActionEligible, false);
      assert.equal(rec.lesson.manualReviewedOnly, true);
      assert.equal(rec.lesson.autoApplyEligible, false);
      assert.equal(rec.audit.source, "manual");
      assert.equal(rec.audit.decidedAt, PINNED_AT);
      assert.equal(rec.audit.operator, "op@phase2l-a");
    }

    // Suggestions — at least one suggestion under broad context.
    assert.ok(r.metrics.hypothesisSuggestionCount >= 1,
      `expected >=1 suggestion, got ${r.metrics.hypothesisSuggestionCount}`);
    for (const s of r.suggestionSet.suggestions) {
      assert.equal(s.suggestionOnly, true);
      assert.equal(s.autoApplyEligible, false);
      assert.equal(s.applyEligibility, "none");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
      assert.equal(s.requiresHumanReviewForUse, true);
      assert.equal(s.hypothesisId, "hyp:harness:e2e");
    }

    // Safety — every per-stage check passed.
    assert.equal(r.safety.allInvariantsHeld, true);
    assert.equal(r.safety.reflectionCandidatesProposeOnly, true);
    assert.equal(r.safety.qualityScoreAdvisoryOnly,        true);
    assert.equal(r.safety.proposedLessonsProposeOnly,      true);
    assert.equal(r.safety.approvalRecordsRuntimeInactive,  true);
    assert.equal(r.safety.suggestionsSuggestionOnly,       true);
  });
});

// ── Determinism ────────────────────────────────────────────────────────────

describe("Phase 2l-a — repeated runs are deeply equal and byte-identical", () => {
  it("running the harness twice with identical inputs returns identical output", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-a-det",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();

    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const decisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "det",
      decidedAt: PINNED_AT,
    }));

    const inputs = {
      history,
      operatorDecisions: decisions,
      hypothesisContext: broadHypothesisContext(),
      now: PINNED_AT,
    };

    const a = runLearningLoopHarness(inputs);
    const b = runLearningLoopHarness(inputs);

    // Metrics deeply equal.
    assert.deepEqual(a.metrics, b.metrics);
    assert.deepEqual(a.safety,  b.safety);
    assert.deepEqual(a.unmatchedDecisions, b.unmatchedDecisions);

    // Per-suggestion ids stable.
    const ida = a.suggestionSet.suggestions.map(s => s.suggestionId);
    const idb = b.suggestionSet.suggestions.map(s => s.suggestionId);
    assert.deepEqual(ida, idb);

    // Per-approval decision ids stable.
    const da = a.approvalResults.map(r => (r as any).decisionId);
    const db = b.approvalResults.map(r => (r as any).decisionId);
    assert.deepEqual(da, db);

    // Byte-identical serialisation of the top-level harness summary.
    assert.equal(serializeLearningLoopHarnessResult(a), serializeLearningLoopHarnessResult(b));
  });
});

// ── No mutation of inputs / external state ─────────────────────────────────

describe("Phase 2l-a — harness does not mutate its inputs or external state", () => {
  it("input arrays/objects are unchanged after the call", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-a-no-mutate",
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

    const beforeHistoryJson = JSON.stringify(history);
    const beforeDecisionsJson = JSON.stringify(decisions);
    const beforeCtxJson = JSON.stringify(ctx);

    runLearningLoopHarness({
      history,
      operatorDecisions: decisions,
      hypothesisContext: ctx,
      now: PINNED_AT,
    });

    assert.equal(JSON.stringify(history),   beforeHistoryJson,   "history was mutated");
    assert.equal(JSON.stringify(decisions), beforeDecisionsJson, "decisions were mutated");
    assert.equal(JSON.stringify(ctx),       beforeCtxJson,       "hypothesis context was mutated");
  });

  it("source file does not call Date.now / Math.random / randomUUID / read process.env / write to fs", async () => {
    const src = await fs.promises.readFile(
      path.join(REPO_ROOT, "server", "experiments", "learningLoopHarness.ts"),
      "utf8",
    );
    // Strip line comments and block comments so the docstring references
    // to forbidden APIs don't trip the regex.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.ok(!/Date\.now\s*\(/.test(codeOnly),    "harness must not call Date.now()");
    assert.ok(!/Math\.random\s*\(/.test(codeOnly), "harness must not call Math.random()");
    assert.ok(!/randomUUID\s*\(/.test(codeOnly),   "harness must not call randomUUID()");
    assert.ok(!/process\.env/.test(codeOnly),      "harness must not read process.env");
    assert.ok(!/fs\.write/.test(codeOnly),         "harness must not write to fs");
    assert.ok(!/appendFile/.test(codeOnly),        "harness must not append to fs");
  });

  it("harness module is not imported by runtime / monitor / scheduler / apply / promote files", async () => {
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
        !src.includes("learningLoopHarness"),
        `${rel} must not import the Phase 2l-a harness — propose-only invariant`,
      );
    }
  });
});

// ── Programmer-shaped misuse ───────────────────────────────────────────────

describe("Phase 2l-a — programmer-shaped misuse throws TypeError", () => {
  it("non-object input throws", () => {
    assert.throws(() => runLearningLoopHarness(null as any), TypeError);
    assert.throws(() => runLearningLoopHarness("nope" as any), TypeError);
    assert.throws(() => runLearningLoopHarness(42 as any), TypeError);
  });
});

// ── Unmatched decisions & refusal records ──────────────────────────────────

describe("Phase 2l-a — unmatched decisions and refusal records surface cleanly", () => {
  it("decisions referencing a non-existent lessonId surface as unmatched", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const r = runLearningLoopHarness({
      operatorDecisions: [{
        lessonId:  "deadbeefdeadbeef",
        decision:  "approved",
        operator:  "op",
        rationale: "test",
        decidedAt: PINNED_AT,
      }],
      now: PINNED_AT,
    });
    assert.equal(r.metrics.unmatchedDecisionCount, 1);
    assert.equal(r.unmatchedDecisions.length, 1);
    assert.equal(r.unmatchedDecisions[0].lessonId, "deadbeefdeadbeef");
    assert.equal(r.unmatchedDecisions[0].reason, "lesson_not_found");
    assert.equal(r.metrics.approvalDecisionCount, 0);
    assert.equal(r.metrics.approvalRefusalCount, 0);
  });

  it("missing-operator decisions produce a refusal entry, not an ok decision", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-a-refusal",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    assert.ok(dry.lessonTable.lessons.length >= 1);

    const r = runLearningLoopHarness({
      history,
      operatorDecisions: [{
        lessonId:  dry.lessonTable.lessons[0].lessonId,
        decision:  "approved",
        operator:  "",                    // missing → refusal
        rationale: "rationale",
        decidedAt: PINNED_AT,
      }],
      now: PINNED_AT,
    });
    assert.equal(r.metrics.approvalDecisionCount, 0);
    assert.equal(r.metrics.approvalRefusalCount, 1);
    assert.equal(r.approvalResults.length, 1);
    assert.equal((r.approvalResults[0] as any).ok, false);
  });
});

// ── Disabled kinds remain disabled ─────────────────────────────────────────

describe("Phase 2l-a — disabled sandbox kinds remain disabled through the loop", () => {
  it("disabled-kind candidates flow through lessons + approvals + suggestions describing only the disabled state", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-a-disabled",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });

    // The Phase 2j-a projection emits at least one
    // `disabled_kind_remains_disabled` candidate from the readiness
    // snapshot (the four disabled kinds).
    const disabledLessons = dry.lessonTable.lessons.filter(
      l => l.reasonCode === "disabled_kind_remains_disabled",
    );
    assert.ok(disabledLessons.length >= 1,
      `expected >=1 disabled-kind lesson, got ${disabledLessons.length}`);

    // Approve every disabled-kind lesson.
    const decisions = disabledLessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "describing disabled state for review",
      decidedAt: PINNED_AT,
    }));

    const r = runLearningLoopHarness({
      history,
      operatorDecisions: decisions,
      hypothesisContext: {
        hypothesisId: "hyp:disabled",
        reasonCodes:  ["disabled_kind_remains_disabled"],
      },
      now: PINNED_AT,
    });

    // Every disabled-kind row stays inactive / non-actionable across
    // approvals and suggestions.
    for (const ar of r.approvalResults) {
      assert.equal((ar as any).ok, true);
      const rec = ar as any;
      assert.equal(rec.lesson.active, false);
      assert.equal(rec.lesson.autoApplyEligible, false);
      assert.equal(rec.lesson.runtimeActionEligible, false);
      assert.equal(rec.lesson.publicActionEligible, false);
    }
    for (const s of r.suggestionSet.suggestions) {
      assert.equal(s.reasonCode, "disabled_kind_remains_disabled");
      assert.equal(s.suggestionOnly, true);
      assert.equal(s.autoApplyEligible, false);
      assert.equal(s.applyEligibility, "none");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
      // Title/body do not propose enabling.
      assert.ok(!/enable/i.test(s.body),
        `suggestion body must not propose enabling: ${s.body}`);
    }
  });
});

// ── Optional hypothesis context ────────────────────────────────────────────

describe("Phase 2l-a — no hypothesis context → suggestion stage is skipped, not failed", () => {
  it("approvals exist but no context → zero suggestions, zero ineligibles, status=success when no decisions are unmatched", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const seed = executeSummarizationFixtureRegistration({
      source: "test:phase2l-a-no-ctx",
      now:    new Date(PINNED_AT),
    });
    assert.equal((seed as any).ok, true);

    const history = buildSandboxRegistrationHistorySnapshot();
    const dry = runLearningLoopHarness({ history, now: PINNED_AT });
    const decisions = dry.lessonTable.lessons.map(l => ({
      lessonId:  l.lessonId,
      decision:  "approved" as const,
      operator:  "op",
      rationale: "ok",
      decidedAt: PINNED_AT,
    }));

    const r = runLearningLoopHarness({
      history,
      operatorDecisions: decisions,
      // No hypothesisContext on purpose.
      now: PINNED_AT,
    });
    assert.equal(r.metrics.hypothesisSuggestionCount, 0);
    assert.equal(r.metrics.hypothesisIneligibleCount, 0);
    assert.equal(r.suggestionSet.suggestions.length, 0);
    assert.equal(r.suggestionSet.ineligibleRecords.length, 0);
    assert.equal(r.overallStatus, "success");
  });
});
