/**
 * Tests for Phase 2k-b — manual lesson approval records.
 *
 * Spec invariants pinned by this file:
 *   1. recordLessonApproval only produces a record from a `proposed` source
 *      lesson AND only when explicit operator/rationale/decidedAt inputs
 *      are supplied.
 *   2. Missing/empty operator, missing/empty rationale, missing/invalid
 *      decidedAt, and non-proposed source lessons return structured refusal
 *      results (ok:false, machine-readable reason). Never an approved record.
 *   3. Approved records carry status: "approved" but still: active: false,
 *      autoApplyEligible: false, applyEligibility: "none",
 *      humanReviewRequired: true, runtimeActionEligible: false,
 *      publicActionEligible: false, manualReviewedOnly: true.
 *   4. Rejected and retired decisions also produce records (audit trail),
 *      and they carry the same inactive/non-actionable invariants.
 *   5. Deterministic decision IDs: same inputs → same id. Byte-identical
 *      serialization across repeated calls.
 *   6. No wall-clock reads (no Date.now). No Math.random. No env reads.
 *      No fs/db mutation. Real data fixtures byte-identical after the run.
 *   7. Disabled sandbox kinds remain disabled — approving a
 *      `disabled_kind_remains_disabled` lesson does NOT enable/register/
 *      activate that kind.
 *   8. `summarizationTemplate` is the only enabled sandbox kind and
 *      approving lessons cannot widen that set.
 *   9. lessonsDatabaseApprovalRecord is NOT imported by runtime/monitor/
 *      scheduler/apply-promote files (propose-only invariant).
 *  10. Invalid `decision` values throw a TypeError (programmer error).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// ledger files were touched. The helper itself does no I/O — these
// guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2kb-lessons-approval-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  recordLessonApproval,
  serializeLessonApprovalResult,
  LESSON_APPROVAL_RECORD_SCHEMA_VERSION,
  LESSON_APPROVAL_RECORD_LABEL,
} = await import("../experiments/lessonsDatabaseApprovalRecord.ts");

const {
  buildLessonTable,
  LESSONS_DATABASE_SCHEMA_VERSION,
} = await import("../experiments/lessonsDatabaseSchema.ts");

const {
  buildMetaReflectionCandidateSet,
} = await import("../experiments/metaReflectionCandidateSchema.ts");

const {
  buildSandboxRegistrationHistorySnapshot,
} = await import("../experiments/sandboxRegistrationHistory.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const ALLOWED_DECISIONS = new Set<string>(["approved", "rejected", "retired"]);

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

  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2k-b tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2k-b tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2k-b tests created live ${label}!`);
    }
  }
});

// Build a deterministic table of proposed lesson rows once. Every test case
// derives its source rows from this table so we exercise the real
// projection output.
function buildProposedLessons() {
  const history = buildSandboxRegistrationHistorySnapshot();
  const candidateSet = buildMetaReflectionCandidateSet({ history });
  const table = buildLessonTable({ candidateSet });
  assert.ok(table.lessons.length >= 1, "expected at least one proposed lesson");
  return table.lessons;
}

const PINNED_AT = "2026-05-10T15:00:00.000Z";

// ── Happy path: approve a proposed lesson ───────────────────────────────────

describe("Phase 2k-b — recordLessonApproval(approved) happy path", () => {
  it("emits an approval record when all inputs are supplied", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "test:operator",
      rationale:    "evidence verified by reviewer",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, true);
    if (result.ok !== true) return;
    assert.equal(result.schemaVersion, LESSON_APPROVAL_RECORD_SCHEMA_VERSION);
    assert.equal(result.label,         LESSON_APPROVAL_RECORD_LABEL);
    assert.equal(result.decision,      "approved");
    assert.equal(result.lesson.status, "approved");
    assert.ok(/^[0-9a-f]{16}$/.test(result.decisionId), `decisionId malformed: ${result.decisionId}`);
  });

  it("approved record still carries every inactive / non-actionable invariant", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "test:operator",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, true);
    if (result.ok !== true) return;
    assert.equal(result.lesson.active, false);
    assert.equal(result.lesson.autoApplyEligible, false);
    assert.equal(result.lesson.applyEligibility, "none");
    assert.equal(result.lesson.humanReviewRequired, true);
    assert.equal(result.lesson.runtimeActionEligible, false);
    assert.equal(result.lesson.publicActionEligible, false);
    assert.equal(result.lesson.manualReviewedOnly, true);
    assert.equal(result.invariants.readOnly, true);
    assert.equal(result.invariants.proposeOnly, true);
    assert.equal(result.invariants.nonWidening, true);
    assert.equal(result.invariants.active, false);
    assert.equal(result.invariants.autoApplyEligible, false);
    assert.equal(result.invariants.publicAction, false);
    assert.equal(result.invariants.schedulerDriven, false);
    assert.equal(result.invariants.mutating, false);
    assert.equal(result.invariants.humanReviewRequired, true);
    assert.equal(result.invariants.runtimeActionEligible, false);
    assert.equal(result.invariants.publicActionEligible, false);
    assert.equal(result.invariants.manualReviewedOnly, true);
  });

  it("source lesson is preserved verbatim in the record", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "test:operator",
      rationale:    "verified",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, true);
    if (result.ok !== true) return;
    assert.equal(result.sourceLesson.lessonId, source.lessonId);
    assert.equal(result.sourceLesson.schemaVersion, LESSONS_DATABASE_SCHEMA_VERSION);
    assert.equal(result.sourceLesson.status, "proposed");
    assert.equal(result.sourceLesson.scope, source.scope);
    assert.equal(result.sourceLesson.subsystem, source.subsystem);
    assert.equal(result.sourceLesson.reasonCode, source.reasonCode);
    assert.equal(result.sourceLesson.candidateRef.candidateId, source.candidateRef.candidateId);
    assert.deepEqual(
      result.sourceLesson.evidenceRefs.map(r => `${r.source}:${r.ref}`),
      source.evidenceRefs.map(r => `${r.source}:${r.ref}`),
    );
    // The post-decision lesson keeps the same id (it's the same lesson).
    assert.equal(result.lesson.lessonId, source.lessonId);
  });

  it("audit metadata captures operator, rationale, decision, decidedAt and the transition", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "test:operator",
      rationale:    "reviewer signed off",
      decidedAt:    new Date(PINNED_AT),
    });
    assert.equal(result.ok, true);
    if (result.ok !== true) return;
    assert.equal(result.audit.operator, "test:operator");
    assert.equal(result.audit.source, "manual");
    assert.equal(result.audit.decision, "approved");
    assert.equal(result.audit.decidedAt, PINNED_AT);
    assert.equal(result.audit.rationale, "reviewer signed off");
    assert.equal(result.audit.sourceCandidateId, source.candidateRef.candidateId);
    assert.equal(result.audit.statusTransition.from, "proposed");
    assert.equal(result.audit.statusTransition.to, "approved");
    assert.deepEqual(
      result.audit.sourceEvidenceRefs.map(r => `${r.source}:${r.ref}`),
      source.evidenceRefs.map(r => `${r.source}:${r.ref}`),
    );
  });

  it("operator and rationale are trimmed before being stored", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "  test:operator  ",
      rationale:    "   verified   ",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, true);
    if (result.ok !== true) return;
    assert.equal(result.audit.operator, "test:operator");
    assert.equal(result.audit.rationale, "verified");
  });
});

// ── Rejected and retired ────────────────────────────────────────────────────

describe("Phase 2k-b — recordLessonApproval(rejected|retired) keeps inactive invariants", () => {
  for (const decision of ["rejected", "retired"] as const) {
    it(`${decision} record carries inactive/non-actionable invariants`, () => {
      const [source] = buildProposedLessons();
      const result = recordLessonApproval({
        sourceLesson: source,
        decision,
        operator:     "test:operator",
        rationale:    "documented",
        decidedAt:    PINNED_AT,
      });
      assert.equal(result.ok, true);
      if (result.ok !== true) return;
      assert.equal(result.decision, decision);
      assert.equal(result.lesson.status, decision);
      assert.equal(result.lesson.active, false);
      assert.equal(result.lesson.autoApplyEligible, false);
      assert.equal(result.lesson.applyEligibility, "none");
      assert.equal(result.lesson.runtimeActionEligible, false);
      assert.equal(result.lesson.publicActionEligible, false);
      assert.equal(result.lesson.manualReviewedOnly, true);
      assert.equal(result.audit.statusTransition.to, decision);
    });
  }
});

// ── Refusal paths ───────────────────────────────────────────────────────────

describe("Phase 2k-b — recordLessonApproval refuses without explicit approval input", () => {
  it("missing operator → safe refusal, never approved", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "missing_operator");
  });

  it("whitespace-only operator → safe refusal", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "   ",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "missing_operator");
  });

  it("missing rationale → safe refusal, never approved", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "missing_rationale");
  });

  it("missing decidedAt → safe refusal, never approved", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      // @ts-expect-error — exercising the runtime guard
      decidedAt:    undefined,
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "missing_decided_at");
  });

  it("invalid decidedAt → safe refusal", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    "not-a-date",
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "invalid_decided_at");
  });

  it("source lesson not in `proposed` status → safe refusal", () => {
    const [source] = buildProposedLessons();
    // Simulate an already-approved row by cloning the proposed row with a
    // mutated status. The helper must refuse to "re-approve" it.
    const approvedSource = { ...source, status: "approved" as const };
    const result = recordLessonApproval({
      // @ts-expect-error — the helper must refuse at runtime even if a
      // caller manages to pass a non-proposed row.
      sourceLesson: approvedSource,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "source_lesson_not_proposed");
  });

  it("missing source lesson → safe refusal", () => {
    const result = recordLessonApproval({
      // @ts-expect-error — exercising the runtime guard
      sourceLesson: undefined,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(result.ok, false);
    if (result.ok !== false) return;
    assert.equal(result.reason, "missing_source_lesson");
  });

  it("invalid decision value throws (programmer error, not runtime refusal)", () => {
    const [source] = buildProposedLessons();
    assert.throws(
      () => recordLessonApproval({
        sourceLesson: source,
        // @ts-expect-error
        decision:     "applied",
        operator:     "op",
        rationale:    "ok",
        decidedAt:    PINNED_AT,
      }),
      /invalid decision/,
    );
  });

  it("non-object input throws (programmer error)", () => {
    assert.throws(
      // @ts-expect-error
      () => recordLessonApproval(null),
      /input must be an object/,
    );
    assert.throws(
      // @ts-expect-error
      () => recordLessonApproval("nope"),
      /input must be an object/,
    );
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe("Phase 2k-b — recordLessonApproval is deterministic", () => {
  it("same inputs → same decisionId", () => {
    const [source] = buildProposedLessons();
    const r1 = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    const r2 = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (r1.ok !== true || r2.ok !== true) return;
    assert.equal(r1.decisionId, r2.decisionId);
    assert.deepEqual(r1, r2);
  });

  it("different operators / rationales / decisions / timestamps → different ids", () => {
    const [source] = buildProposedLessons();
    const base = {
      sourceLesson: source,
      decision:     "approved" as const,
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    };
    const r0 = recordLessonApproval(base);
    const r1 = recordLessonApproval({ ...base, operator:  "op-2" });
    const r2 = recordLessonApproval({ ...base, rationale: "different reason" });
    const r3 = recordLessonApproval({ ...base, decision:  "rejected" });
    const r4 = recordLessonApproval({ ...base, decidedAt: "2026-05-11T15:00:00.000Z" });

    const ids = [r0, r1, r2, r3, r4].map(r => (r.ok ? r.decisionId : "refused"));
    for (const id of ids) assert.notEqual(id, "refused", "expected all five to be accepted");
    const unique = new Set(ids);
    assert.equal(unique.size, 5, `expected 5 distinct ids, got: ${ids.join(",")}`);
  });

  it("Date vs ISO string for decidedAt normalises to the same id", () => {
    const [source] = buildProposedLessons();
    const r1 = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    const r2 = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    new Date(PINNED_AT),
    });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    if (r1.ok !== true || r2.ok !== true) return;
    assert.equal(r1.decisionId, r2.decisionId);
  });

  it("serialization is byte-identical across repeated calls (approved & refusal)", () => {
    const [source] = buildProposedLessons();
    const a = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    const b = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(serializeLessonApprovalResult(a), serializeLessonApprovalResult(b));
    assert.equal(
      serializeLessonApprovalResult(a, { indent: 2 }),
      serializeLessonApprovalResult(b, { indent: 2 }),
    );

    const refA = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    const refB = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(serializeLessonApprovalResult(refA), serializeLessonApprovalResult(refB));
  });
});

// ── No I/O / no wall-clock / no env reads ───────────────────────────────────

describe("Phase 2k-b — helper performs no I/O and reads no wall clock", () => {
  it("ledger files are untouched by repeated calls", () => {
    if (!fs.existsSync(TMP_LEDGER)) fs.writeFileSync(TMP_LEDGER, "");
    const sizeBefore = fs.statSync(TMP_LEDGER).size;
    const [source] = buildProposedLessons();
    for (let i = 0; i < 10; i++) {
      recordLessonApproval({
        sourceLesson: source,
        decision:     "approved",
        operator:     `op-${i}`,
        rationale:    "ok",
        decidedAt:    PINNED_AT,
      });
    }
    assert.equal(fs.statSync(TMP_LEDGER).size, sizeBefore);
  });

  it("source file does not reference Date.now / Math.random / crypto.randomUUID", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "server", "experiments", "lessonsDatabaseApprovalRecord.ts"),
      "utf8",
    );
    assert.doesNotMatch(src, /Date\.now\(/);
    assert.doesNotMatch(src, /Math\.random\(/);
    assert.doesNotMatch(src, /randomUUID\b/);
    assert.doesNotMatch(src, /process\.env\./);
  });
});

// ── Non-widening / disabled kinds remain disabled ───────────────────────────

describe("Phase 2k-b — disabled kinds remain disabled even when their lessons are approved", () => {
  it("approving a disabled-kind lesson does not enable / register / activate it", () => {
    const lessons = buildProposedLessons();
    const disabled = lessons.filter(l => l.reasonCode === "disabled_kind_remains_disabled");
    assert.ok(disabled.length >= 1, "expected at least one disabled-kind lesson");
    for (const source of disabled) {
      const result = recordLessonApproval({
        sourceLesson: source,
        decision:     "approved",
        operator:     "op",
        rationale:    "documenting disabled state",
        decidedAt:    PINNED_AT,
      });
      assert.equal(result.ok, true);
      if (result.ok !== true) continue;
      // The approved row carries the same inactive/non-actionable invariants.
      assert.equal(result.lesson.active, false);
      assert.equal(result.lesson.autoApplyEligible, false);
      assert.equal(result.lesson.applyEligibility, "none");
      assert.equal(result.lesson.runtimeActionEligible, false);
      assert.equal(result.lesson.publicActionEligible, false);
      // The recorded scope still names the disabled kind — the record
      // cannot rename it to summarizationTemplate.
      assert.match(result.sourceLesson.scope, /^sandbox\.disabled\./);
      assert.ok(
        !result.sourceLesson.scope.endsWith("summarizationTemplate"),
        "summarizationTemplate must never appear as a disabled kind",
      );
    }
  });

  it("summarizationTemplate remains the only enabled sandbox kind in the audit trail", () => {
    const lessons = buildProposedLessons();
    // The only `evidence_present_summarization_fixture` reason in the
    // candidate set today should reference summarizationTemplate, and an
    // approved record must not rewrite that scope.
    const presentFixture = lessons.filter(
      l => l.reasonCode === "evidence_present_summarization_fixture",
    );
    for (const source of presentFixture) {
      const result = recordLessonApproval({
        sourceLesson: source,
        decision:     "approved",
        operator:     "op",
        rationale:    "verified",
        decidedAt:    PINNED_AT,
      });
      assert.equal(result.ok, true);
      if (result.ok !== true) continue;
      assert.equal(result.sourceLesson.scope, "sandbox.summarizationTemplate");
      assert.equal(result.lesson.active, false);
    }
  });
});

// ── Schema label round-trip ─────────────────────────────────────────────────

describe("Phase 2k-b — schema label and version round-trip", () => {
  it("serializeLessonApprovalResult emits the schema version + label", () => {
    const [source] = buildProposedLessons();
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    const out = serializeLessonApprovalResult(result);
    assert.match(out, new RegExp(LESSON_APPROVAL_RECORD_SCHEMA_VERSION));
    assert.match(out, new RegExp(LESSON_APPROVAL_RECORD_LABEL));
  });

  it("decision values must be one of approved|rejected|retired (closed enum)", () => {
    const [source] = buildProposedLessons();
    for (const d of ["approved", "rejected", "retired"] as const) {
      assert.ok(ALLOWED_DECISIONS.has(d));
      const result = recordLessonApproval({
        sourceLesson: source,
        decision:     d,
        operator:     "op",
        rationale:    "ok",
        decidedAt:    PINNED_AT,
      });
      assert.equal(result.ok, true);
      if (result.ok !== true) continue;
      assert.equal(result.decision, d);
    }
  });
});

// ── Propose-only invariant: helper is NOT wired to runtime ──────────────────

describe("Phase 2k-b — module is not imported by runtime / monitor / scheduler / apply-promote files", () => {
  const FORBIDDEN_IMPORTERS = [
    "server/index.ts",
    "server/routes.ts",
    "server/autonomyMonitor.ts",
    "server/selfRecommendationEngine.ts",
    "server/eval/promotionGate.ts",
  ];

  it("runtime / monitor / apply / promotion files do not import lessonsDatabaseApprovalRecord", () => {
    for (const rel of FORBIDDEN_IMPORTERS) {
      const p = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      assert.doesNotMatch(
        src,
        /lessonsDatabaseApprovalRecord/,
        `${rel} must not import lessonsDatabaseApprovalRecord`,
      );
    }
  });

  it("no scheduler / hypothesis-creation / recommendation file imports lessonsDatabaseApprovalRecord", () => {
    const serverDir = path.join(REPO_ROOT, "server");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        if (entry.name === "experiments") continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(p);
      }
      return out;
    };
    for (const f of walk(serverDir)) {
      const src = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(
        src,
        /lessonsDatabaseApprovalRecord/,
        `${path.relative(REPO_ROOT, f)} must not import lessonsDatabaseApprovalRecord`,
      );
    }
  });
});
