/**
 * Tests for Phase 2j-a — meta-reflection candidate schema/projection.
 *
 * Spec invariants pinned by this file:
 *   1. Empty / missing inputs yield a graceful zero candidate set.
 *   2. Populated history evidence yields deterministic candidates with
 *      stable IDs, stable ordering, and the documented safety metadata
 *      (humanReviewRequired: true, autoApplyEligible: false, riskLevel: low,
 *      restated invariants).
 *   3. Audit-export evidence and readiness evidence each emit the expected
 *      candidates with the documented reason codes.
 *   4. Risk-impact evidence — only emits candidates when blocked /
 *      needs_review counts are non-zero.
 *   5. Determinism — repeated calls with the same inputs return deeply equal
 *      output AND byte-identical serialised strings.
 *   6. The projection does not write to ledger / DB / fixture / env / fs.
 *      Real data fixtures are byte-identical after the test run.
 *   7. Disabled kinds remain disabled — every disabled kind appears as a
 *      `disabled_kind_remains_disabled` candidate, and no candidate proposes
 *      enabling.
 *   8. Reason codes are drawn only from the closed set declared in the
 *      module.
 *   9. `generatedAt` is `null` by default and a normalised ISO string when
 *      `now` is injected.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// ledger files were touched. The projection itself does no I/O — these
// guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ja-meta-reflection-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildMetaReflectionCandidateSet,
  serializeMetaReflectionCandidateSet,
  META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
  META_REFLECTION_CANDIDATE_LABEL,
} = await import("../experiments/metaReflectionCandidateSchema.ts");

const {
  buildSandboxRegistrationHistorySnapshot,
} = await import("../experiments/sandboxRegistrationHistory.ts");

const {
  buildSandboxRegistrationAuditExport,
} = await import("../experiments/sandboxRegistrationAuditExport.ts");

const {
  buildLowRiskSandboxReadinessSnapshot,
} = await import("../experiments/lowRiskSandboxReadiness.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const {
  executeSummarizationFixtureRegistration,
} = await import("../experiments/summarizationSandboxFixtureRegistration.ts");

// Closed set of reason codes the module is allowed to emit. If this list
// drifts from the implementation, tests fail loudly so we notice the
// schema change.
const ALLOWED_REASON_CODES = new Set<string>([
  "evidence_present_summarization_fixture",
  "evidence_absent_summarization_fixture",
  "registration_history_empty",
  "registration_history_populated",
  "registration_history_refused_present",
  "audit_export_present",
  "audit_export_empty",
  "disabled_kind_remains_disabled",
  "readiness_blocked_kind",
  "readiness_needs_review_kind",
  "risk_impact_blocked_present",
  "risk_impact_needs_review_present",
]);

const ALLOWED_SUBSYSTEMS = new Set<string>([
  "summarizationFixture",
  "registrationHistory",
  "registrationAuditExport",
  "lowRiskSandboxReadiness",
  "riskImpact",
]);

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);

before(() => {
  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(TMP_LEDGER); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  // Real data fixtures must be byte-identical after the test run — same
  // belt-and-suspenders pattern as the Phase 2i tests.
  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2j-a tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2j-a tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2j-a tests created live ${label}!`);
    }
  }
});

// ── Empty / missing inputs ──────────────────────────────────────────────────

describe("Phase 2j-a — empty / missing input candidate set", () => {
  it("returns a graceful zero candidate set when no inputs are provided", () => {
    const set = buildMetaReflectionCandidateSet();
    assert.equal(set.schemaVersion, META_REFLECTION_CANDIDATE_SCHEMA_VERSION);
    assert.equal(set.label, META_REFLECTION_CANDIDATE_LABEL);
    assert.equal(set.isEmpty, true);
    assert.deepEqual([...set.candidates], []);
    assert.equal(set.aggregate.totalCandidates, 0);
    assert.equal(set.aggregate.humanReviewRequired, 0);
    assert.equal(set.aggregate.autoApplyEligible, 0);
    assert.equal(set.evidenceProvided.history, false);
    assert.equal(set.evidenceProvided.auditExport, false);
    assert.equal(set.evidenceProvided.readiness, false);
    assert.equal(set.evidenceProvided.riskImpact, false);
    assert.equal(set.generatedAt, null);
    assert.equal(set.generatedBy, "unspecified");
  });

  it("invariants block restates the propose-only contract on empty set", () => {
    const set = buildMetaReflectionCandidateSet();
    assert.equal(set.invariants.readOnly, true);
    assert.equal(set.invariants.proposeOnly, true);
    assert.equal(set.invariants.nonWidening, true);
    assert.equal(set.invariants.autoApplyEligible, false);
    assert.equal(set.invariants.publicAction, false);
    assert.equal(set.invariants.schedulerDriven, false);
    assert.equal(set.invariants.mutating, false);
    assert.equal(set.invariants.humanReviewRequired, true);
  });

  it("repeated empty calls are deeply equal AND serialise byte-identically", () => {
    const a = buildMetaReflectionCandidateSet();
    const b = buildMetaReflectionCandidateSet();
    assert.deepEqual(a, b);
    assert.equal(
      serializeMetaReflectionCandidateSet(a),
      serializeMetaReflectionCandidateSet(b),
    );
  });

  it("`generatedAt` is `null` by default and an ISO string when injected", () => {
    const def = buildMetaReflectionCandidateSet();
    assert.equal(def.generatedAt, null);
    const fixed = buildMetaReflectionCandidateSet({ now: new Date("2026-05-10T15:00:00.000Z") });
    assert.equal(fixed.generatedAt, "2026-05-10T15:00:00.000Z");
    const fixedStr = buildMetaReflectionCandidateSet({ now: "2026-05-10T15:00:00.000Z" });
    assert.equal(fixedStr.generatedAt, "2026-05-10T15:00:00.000Z");
  });
});

// ── History-only evidence on a fresh ledger ─────────────────────────────────

describe("Phase 2j-a — history-only evidence (empty ledger)", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
  });

  it("emits empty-history + absent-fixture + 4 disabled-kind candidates", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const set = buildMetaReflectionCandidateSet({ history });
    // 1 empty-history + 1 absent-fixture + 4 disabled kinds = 6
    assert.equal(set.candidates.length, 6, `got ${set.candidates.length} candidates`);
    const codes = set.candidates.map(c => c.reasonCode).sort();
    assert.deepEqual(codes, [
      "disabled_kind_remains_disabled",
      "disabled_kind_remains_disabled",
      "disabled_kind_remains_disabled",
      "disabled_kind_remains_disabled",
      "evidence_absent_summarization_fixture",
      "registration_history_empty",
    ]);
    assert.equal(set.evidenceProvided.history, true);
    assert.equal(set.isEmpty, false);
  });

  it("every emitted candidate is human-review-required and not auto-apply eligible", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const set = buildMetaReflectionCandidateSet({ history });
    for (const c of set.candidates) {
      assert.equal(c.humanReviewRequired, true,  `candidate ${c.candidateId} should require human review`);
      assert.equal(c.autoApplyEligible,   false, `candidate ${c.candidateId} should not be auto-apply eligible`);
      assert.equal(c.riskLevel, "low");
      assert.equal(c.invariants.proposeOnly, true);
      assert.equal(c.invariants.nonWidening, true);
      assert.equal(c.invariants.autoApplyEligible, false);
      assert.equal(c.invariants.publicAction, false);
      assert.equal(c.invariants.schedulerDriven, false);
      assert.equal(c.invariants.mutating, false);
      assert.ok(ALLOWED_REASON_CODES.has(c.reasonCode), `unknown reason code ${c.reasonCode}`);
      assert.ok(ALLOWED_SUBSYSTEMS.has(c.subsystem), `unknown subsystem ${c.subsystem}`);
      assert.ok(c.candidateId.length === 16 && /^[0-9a-f]{16}$/.test(c.candidateId), `bad id ${c.candidateId}`);
    }
  });

  it("exactly one disabled-kind candidate per disabled kind, none proposes enabling", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const set = buildMetaReflectionCandidateSet({ history });
    const disabledCands = set.candidates.filter(c => c.reasonCode === "disabled_kind_remains_disabled");
    const kinds = disabledCands.map(c => c.scope.replace("sandbox.disabled.", "")).sort();
    assert.deepEqual(kinds, [
      "memoryRetrievalHeuristic",
      "reasoningTemplate",
      "selfCritiquePrompt",
      "taskDecompositionPattern",
    ]);
    for (const c of disabledCands) {
      assert.match(c.title, /remains disabled/);
      // Body never proposes enabling.
      assert.doesNotMatch(c.body, /enable/i);
      assert.doesNotMatch(c.body, /unblock/i);
    }
  });

  it("repeated calls with the same history input are deeply equal", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const a = buildMetaReflectionCandidateSet({ history });
    const b = buildMetaReflectionCandidateSet({ history });
    assert.deepEqual(a, b);
    assert.equal(
      serializeMetaReflectionCandidateSet(a),
      serializeMetaReflectionCandidateSet(b),
    );
    assert.equal(
      serializeMetaReflectionCandidateSet(a, { indent: 2 }),
      serializeMetaReflectionCandidateSet(b, { indent: 2 }),
    );
  });
});

// ── Populated history evidence ──────────────────────────────────────────────

describe("Phase 2j-a — populated history evidence", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
    const r1 = executeSummarizationFixtureRegistration({
      source: "test:phase2j-a-populated-1",
      now:    new Date("2026-05-10T14:00:00.000Z"),
    });
    if (!r1.ok) throw new Error(`seed registration failed: ${r1.reason}`);
    const r2 = executeSummarizationFixtureRegistration({
      source: "test:phase2j-a-populated-2",
      now:    new Date("2026-05-10T14:05:00.000Z"),
    });
    if (!r2.ok) throw new Error(`seed registration failed: ${r2.reason}`);
  });

  it("emits present-fixture + populated-history + 4 disabled-kind candidates", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const set = buildMetaReflectionCandidateSet({ history });
    const codes = set.candidates.map(c => c.reasonCode).sort();
    assert.deepEqual(codes, [
      "disabled_kind_remains_disabled",
      "disabled_kind_remains_disabled",
      "disabled_kind_remains_disabled",
      "disabled_kind_remains_disabled",
      "evidence_present_summarization_fixture",
      "registration_history_populated",
    ]);
  });

  it("aggregate counts mirror the candidate list", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const set = buildMetaReflectionCandidateSet({ history });
    assert.equal(set.aggregate.totalCandidates, set.candidates.length);
    assert.equal(set.aggregate.humanReviewRequired, set.candidates.length);
    assert.equal(set.aggregate.autoApplyEligible, 0);
    const observationCount = set.candidates.filter(c => c.kind === "observation").length;
    assert.equal(set.aggregate.candidatesByKind.observation, observationCount);
  });

  it("ordering is stable across repeated builds (by scope, candidateId)", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const a = buildMetaReflectionCandidateSet({ history });
    const b = buildMetaReflectionCandidateSet({ history });
    assert.deepEqual(
      a.candidates.map(c => c.candidateId),
      b.candidates.map(c => c.candidateId),
    );
    const scopes = a.candidates.map(c => c.scope);
    const sorted = [...scopes].sort();
    assert.deepEqual(scopes, sorted, "candidates must be ordered by scope");
  });

  it("includes audit export evidence when provided alongside history", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    const set = buildMetaReflectionCandidateSet({ history, auditExport });
    const codes = set.candidates.map(c => c.reasonCode);
    assert.ok(codes.includes("audit_export_present"), `expected audit_export_present in ${codes.join(",")}`);
    assert.equal(set.evidenceProvided.auditExport, true);
  });

  it("projection does not append to or create the ledger file", () => {
    const sizeBefore = fs.statSync(TMP_LEDGER).size;
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    buildMetaReflectionCandidateSet({ history });
    buildMetaReflectionCandidateSet({ history, auditExport });
    serializeMetaReflectionCandidateSet(buildMetaReflectionCandidateSet({ history, auditExport }));
    serializeMetaReflectionCandidateSet(buildMetaReflectionCandidateSet({ history, auditExport }), { indent: 2 });
    const sizeAfter = fs.statSync(TMP_LEDGER).size;
    assert.equal(sizeAfter, sizeBefore, "projection must not mutate the ledger");
  });
});

// ── Readiness evidence ──────────────────────────────────────────────────────

describe("Phase 2j-a — readiness evidence", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
  });

  it("emits a candidate per blocked / needs_review readiness kind, not for ready ones", () => {
    const readiness = buildLowRiskSandboxReadinessSnapshot();
    const set = buildMetaReflectionCandidateSet({ readiness });
    const blocked = set.candidates.filter(c => c.reasonCode === "readiness_blocked_kind");
    const needsReview = set.candidates.filter(c => c.reasonCode === "readiness_needs_review_kind");
    // Today summarizationTemplate is the single ready kind; the other four are
    // either blocked or needs_review. Either way, total readiness candidates
    // must equal `kinds.length - readyCount`.
    const readyCount = readiness.kinds.filter(k => k.readiness === "ready").length;
    assert.equal(
      blocked.length + needsReview.length,
      readiness.kinds.length - readyCount,
    );
    // None of these candidates proposes enabling.
    for (const c of [...blocked, ...needsReview]) {
      assert.doesNotMatch(c.body, /\benable\b/i, `body must not propose enabling: ${c.body}`);
      assert.equal(c.autoApplyEligible, false);
      assert.equal(c.humanReviewRequired, true);
    }
  });
});

// ── Risk-impact evidence ────────────────────────────────────────────────────

describe("Phase 2j-a — risk-impact evidence", () => {
  it("emits no risk-impact candidates when blocked / needs_review counts are zero", () => {
    const ri = {
      total: 0,
      byDecision:   { eligible: 0, needs_review: 0, blocked: 0 },
      byRisk:       { low: 0, moderate: 0, high: 0, unclassifiable: 0 },
      byImpact:     { low: 0, moderate: 0, high: 0, unknown: 0 },
      byReadiness:  { ready: 0, planned: 0, blocked: 0 },
      byReasonCode: {} as Record<string, number>,
      eligibleLowRisk: 0,
    } as any;
    const set = buildMetaReflectionCandidateSet({ riskImpact: ri });
    assert.equal(set.candidates.length, 0);
    assert.equal(set.evidenceProvided.riskImpact, true);
  });

  it("emits a `risk_impact_blocked_present` observation when blocked > 0", () => {
    const ri = {
      total: 3,
      byDecision:   { eligible: 1, needs_review: 0, blocked: 2 },
      byRisk:       { low: 1, moderate: 1, high: 1, unclassifiable: 0 },
      byImpact:     { low: 1, moderate: 1, high: 1, unknown: 0 },
      byReadiness:  { ready: 1, planned: 0, blocked: 2 },
      byReasonCode: {} as Record<string, number>,
      eligibleLowRisk: 1,
    } as any;
    const set = buildMetaReflectionCandidateSet({ riskImpact: ri });
    const codes = set.candidates.map(c => c.reasonCode);
    assert.deepEqual(codes, ["risk_impact_blocked_present"]);
    assert.equal(set.candidates[0].kind, "observation");
  });

  it("emits a `risk_impact_needs_review_present` question when needs_review > 0", () => {
    const ri = {
      total: 2,
      byDecision:   { eligible: 0, needs_review: 2, blocked: 0 },
      byRisk:       { low: 1, moderate: 1, high: 0, unclassifiable: 0 },
      byImpact:     { low: 1, moderate: 1, high: 0, unknown: 0 },
      byReadiness:  { ready: 0, planned: 2, blocked: 0 },
      byReasonCode: {} as Record<string, number>,
      eligibleLowRisk: 0,
    } as any;
    const set = buildMetaReflectionCandidateSet({ riskImpact: ri });
    const codes = set.candidates.map(c => c.reasonCode);
    assert.deepEqual(codes, ["risk_impact_needs_review_present"]);
    assert.equal(set.candidates[0].kind, "question");
  });
});

// ── Determinism + reason code closure ────────────────────────────────────────

describe("Phase 2j-a — deterministic IDs and reason code closure", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
  });

  it("candidate IDs are stable hashes of source-evidence references", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const a = buildMetaReflectionCandidateSet({ history });
    const b = buildMetaReflectionCandidateSet({ history });
    for (let i = 0; i < a.candidates.length; i++) {
      assert.equal(a.candidates[i].candidateId, b.candidates[i].candidateId);
    }
  });

  it("every emitted reasonCode is in the documented closed set", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    const readiness = buildLowRiskSandboxReadinessSnapshot();
    const set = buildMetaReflectionCandidateSet({ history, auditExport, readiness });
    for (const c of set.candidates) {
      assert.ok(ALLOWED_REASON_CODES.has(c.reasonCode), `unexpected reason code ${c.reasonCode}`);
    }
  });

  it("serialized output is byte-identical with all four channels populated", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    const readiness = buildLowRiskSandboxReadinessSnapshot();
    const ri = {
      total: 1,
      byDecision:   { eligible: 1, needs_review: 0, blocked: 0 },
      byRisk:       { low: 1, moderate: 0, high: 0, unclassifiable: 0 },
      byImpact:     { low: 1, moderate: 0, high: 0, unknown: 0 },
      byReadiness:  { ready: 1, planned: 0, blocked: 0 },
      byReasonCode: {} as Record<string, number>,
      eligibleLowRisk: 1,
    } as any;
    const a = buildMetaReflectionCandidateSet({ history, auditExport, readiness, riskImpact: ri });
    const b = buildMetaReflectionCandidateSet({ history, auditExport, readiness, riskImpact: ri });
    assert.equal(
      serializeMetaReflectionCandidateSet(a),
      serializeMetaReflectionCandidateSet(b),
    );
    assert.deepEqual(a, b);
  });

  it("env snapshot is unchanged by repeated projection calls", () => {
    const before = JSON.stringify({
      DATA_DIR: process.env.DATA_DIR,
      DB_PATH:  process.env.DB_PATH,
    });
    for (let i = 0; i < 5; i++) {
      buildMetaReflectionCandidateSet();
      buildMetaReflectionCandidateSet({
        history: buildSandboxRegistrationHistorySnapshot(),
      });
    }
    const after = JSON.stringify({
      DATA_DIR: process.env.DATA_DIR,
      DB_PATH:  process.env.DB_PATH,
    });
    assert.equal(before, after, "env vars must not change across calls");
  });
});
