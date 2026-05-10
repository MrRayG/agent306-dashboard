/**
 * Tests for Phase 2k-a — lessons database schema/projection.
 *
 * Spec invariants pinned by this file:
 *   1. Empty / missing candidate set yields a graceful zero lesson table.
 *   2. Populated candidate set yields deterministic lesson rows with stable
 *      IDs, stable ordering, and the documented safety metadata
 *      (status: "proposed", active: false, autoApplyEligible: false,
 *      applyEligibility: "none", humanReviewRequired: true, restated
 *      invariants).
 *   3. Determinism — repeated calls with the same inputs return deeply equal
 *      output AND byte-identical serialised strings.
 *   4. The projection does not write to ledger / DB / fixture / env / fs.
 *      Real data fixtures are byte-identical after the test run.
 *   5. Disabled kinds remain disabled — every disabled-kind candidate becomes
 *      a `disabled_kind_remains_disabled` lesson, and no lesson body proposes
 *      enabling or unblocking.
 *   6. `summarizationTemplate` is the only sandbox kind a lesson can reference
 *      as enabled. Other kinds appear only with status `proposed` and never
 *      become registerable through this schema.
 *   7. Status enum supports proposed/approved/rejected/retired, but the
 *      projection only emits `proposed`, and none of the other statuses
 *      imply activation or apply eligibility (verified via the static
 *      invariants).
 *   8. `proposedAt` is `null` by default and a normalised ISO string when
 *      `now` is injected.
 *   9. Each lesson points back to its source candidate via `candidateRef`,
 *      and the schema version round-trips.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// ledger files were touched. The projection itself does no I/O — these
// guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ka-lessons-db-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildLessonTable,
  serializeLessonTable,
  LESSONS_DATABASE_SCHEMA_VERSION,
  LESSONS_DATABASE_LABEL,
} = await import("../experiments/lessonsDatabaseSchema.ts");

const {
  buildMetaReflectionCandidateSet,
  META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
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

// Closed set of statuses the schema may carry. If this list drifts from the
// implementation, tests fail loudly so we notice the schema change.
const ALLOWED_STATUSES = new Set<string>(["proposed", "approved", "rejected", "retired"]);

const ALLOWED_KINDS = new Set<string>(["lesson", "observation", "question"]);

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
  // belt-and-suspenders pattern as the Phase 2j-a tests.
  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2k-a tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2k-a tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2k-a tests created live ${label}!`);
    }
  }
});

// ── Empty / missing inputs ──────────────────────────────────────────────────

describe("Phase 2k-a — empty / missing input lesson table", () => {
  it("returns a graceful zero lesson table when the candidate set is empty", () => {
    const candidateSet = buildMetaReflectionCandidateSet();
    const table = buildLessonTable({ candidateSet });
    assert.equal(table.schemaVersion, LESSONS_DATABASE_SCHEMA_VERSION);
    assert.equal(table.label, LESSONS_DATABASE_LABEL);
    assert.equal(table.isEmpty, true);
    assert.deepEqual([...table.lessons], []);
    assert.equal(table.aggregate.totalLessons, 0);
    assert.equal(table.aggregate.humanReviewRequired, 0);
    assert.equal(table.aggregate.active, 0);
    assert.equal(table.aggregate.autoApplyEligible, 0);
    assert.equal(table.aggregate.byStatus.proposed, 0);
    assert.equal(table.aggregate.byStatus.approved, 0);
    assert.equal(table.aggregate.byStatus.rejected, 0);
    assert.equal(table.aggregate.byStatus.retired, 0);
    assert.equal(table.evidenceProvided.history, false);
    assert.equal(table.evidenceProvided.auditExport, false);
    assert.equal(table.evidenceProvided.readiness, false);
    assert.equal(table.evidenceProvided.riskImpact, false);
    assert.equal(table.generatedAt, null);
    assert.equal(table.generatedBy, "unspecified");
    assert.equal(table.sourceCandidateSchemaVersion, META_REFLECTION_CANDIDATE_SCHEMA_VERSION);
  });

  it("invariants block restates the propose-only contract on empty table", () => {
    const candidateSet = buildMetaReflectionCandidateSet();
    const table = buildLessonTable({ candidateSet });
    assert.equal(table.invariants.readOnly, true);
    assert.equal(table.invariants.proposeOnly, true);
    assert.equal(table.invariants.nonWidening, true);
    assert.equal(table.invariants.active, false);
    assert.equal(table.invariants.autoApplyEligible, false);
    assert.equal(table.invariants.publicAction, false);
    assert.equal(table.invariants.schedulerDriven, false);
    assert.equal(table.invariants.mutating, false);
    assert.equal(table.invariants.humanReviewRequired, true);
  });

  it("repeated empty calls are deeply equal AND serialise byte-identically", () => {
    const a = buildLessonTable({ candidateSet: buildMetaReflectionCandidateSet() });
    const b = buildLessonTable({ candidateSet: buildMetaReflectionCandidateSet() });
    assert.deepEqual(a, b);
    assert.equal(serializeLessonTable(a), serializeLessonTable(b));
    assert.equal(
      serializeLessonTable(a, { indent: 2 }),
      serializeLessonTable(b, { indent: 2 }),
    );
  });

  it("`generatedAt` and `proposedAt` are null by default; ISO when `now` is injected", () => {
    const candidateSet = buildMetaReflectionCandidateSet();
    const def = buildLessonTable({ candidateSet });
    assert.equal(def.generatedAt, null);

    const pinned = buildLessonTable({
      candidateSet,
      now: new Date("2026-05-10T15:00:00.000Z"),
    });
    assert.equal(pinned.generatedAt, "2026-05-10T15:00:00.000Z");

    const pinnedStr = buildLessonTable({
      candidateSet,
      now: "2026-05-10T15:00:00.000Z",
    });
    assert.equal(pinnedStr.generatedAt, "2026-05-10T15:00:00.000Z");
  });
});

// ── Empty-ledger candidate set → lesson rows ────────────────────────────────

describe("Phase 2k-a — empty-ledger candidate set produces proposed lessons", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
  });

  it("emits one proposed lesson per candidate", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const table = buildLessonTable({ candidateSet });
    assert.equal(table.lessons.length, candidateSet.candidates.length);
    assert.equal(table.aggregate.totalLessons, candidateSet.candidates.length);
    assert.equal(table.aggregate.byStatus.proposed, candidateSet.candidates.length);
    assert.equal(table.aggregate.byStatus.approved, 0);
    assert.equal(table.aggregate.byStatus.rejected, 0);
    assert.equal(table.aggregate.byStatus.retired, 0);
    assert.equal(table.isEmpty, false);
  });

  it("every lesson is proposed, inactive, non-actionable, and human-review-required", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const table = buildLessonTable({ candidateSet });
    for (const l of table.lessons) {
      assert.equal(l.status, "proposed", `lesson ${l.lessonId} should be proposed`);
      assert.equal(l.active, false);
      assert.equal(l.autoApplyEligible, false);
      assert.equal(l.applyEligibility, "none");
      assert.equal(l.humanReviewRequired, true);
      assert.equal(l.invariants.readOnly, true);
      assert.equal(l.invariants.proposeOnly, true);
      assert.equal(l.invariants.nonWidening, true);
      assert.equal(l.invariants.active, false);
      assert.equal(l.invariants.autoApplyEligible, false);
      assert.equal(l.invariants.publicAction, false);
      assert.equal(l.invariants.schedulerDriven, false);
      assert.equal(l.invariants.mutating, false);
      assert.equal(l.invariants.humanReviewRequired, true);
      assert.ok(ALLOWED_STATUSES.has(l.status));
      assert.ok(ALLOWED_KINDS.has(l.kind));
      assert.ok(ALLOWED_SUBSYSTEMS.has(l.subsystem));
      assert.ok(l.lessonId.length === 16 && /^[0-9a-f]{16}$/.test(l.lessonId), `bad id ${l.lessonId}`);
      assert.equal(l.candidateRef.schemaVersion, META_REFLECTION_CANDIDATE_SCHEMA_VERSION);
      assert.equal(typeof l.candidateRef.candidateId, "string");
      assert.ok(l.candidateRef.candidateId.length > 0);
      assert.equal(l.audit.sourceProjection, "phase2j-a-candidate-set");
    }
  });

  it("disabled kinds remain disabled and no lesson body proposes enabling", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const table = buildLessonTable({ candidateSet });
    const disabled = table.lessons.filter(l => l.reasonCode === "disabled_kind_remains_disabled");
    assert.ok(disabled.length >= 1, "expected at least one disabled-kind lesson");
    for (const l of disabled) {
      assert.equal(l.status, "proposed");
      assert.equal(l.active, false);
      assert.match(l.title, /remains disabled/);
      assert.doesNotMatch(l.body, /\benable\b/i, `lesson body must not propose enabling: ${l.body}`);
      assert.doesNotMatch(l.body, /\bunblock\b/i);
    }
    // The kinds named in disabled lessons must NOT include summarizationTemplate
    // (the only enabled kind today).
    const kinds = disabled.map(l => l.scope.replace("sandbox.disabled.", ""));
    assert.ok(!kinds.includes("summarizationTemplate"),
      `summarizationTemplate must not appear as a disabled lesson kind, got: ${kinds.join(",")}`);
  });

  it("lessons are ordered stably by (scope, lessonId)", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const a = buildLessonTable({ candidateSet });
    const b = buildLessonTable({ candidateSet });
    assert.deepEqual(
      a.lessons.map(l => l.lessonId),
      b.lessons.map(l => l.lessonId),
    );
    const scopes = a.lessons.map(l => l.scope);
    const sorted = [...scopes].sort();
    assert.deepEqual(scopes, sorted, "lessons must be ordered by scope");
    // Within a scope, lessonId must be sorted too.
    for (let i = 1; i < a.lessons.length; i++) {
      const prev = a.lessons[i - 1];
      const cur  = a.lessons[i];
      if (prev.scope === cur.scope) {
        assert.ok(prev.lessonId.localeCompare(cur.lessonId) <= 0,
          `within-scope ordering broken at index ${i}`);
      }
    }
  });

  it("repeated calls with the same candidate set are deeply equal AND byte-identical", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const a = buildLessonTable({ candidateSet });
    const b = buildLessonTable({ candidateSet });
    assert.deepEqual(a, b);
    assert.equal(serializeLessonTable(a), serializeLessonTable(b));
    assert.equal(
      serializeLessonTable(a, { indent: 2 }),
      serializeLessonTable(b, { indent: 2 }),
    );
  });

  it("projection does not append to or create the ledger file", () => {
    // Ensure the ledger exists so we can size-compare it.
    if (!fs.existsSync(TMP_LEDGER)) {
      fs.writeFileSync(TMP_LEDGER, "");
    }
    const sizeBefore = fs.statSync(TMP_LEDGER).size;
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    buildLessonTable({ candidateSet });
    serializeLessonTable(buildLessonTable({ candidateSet }));
    serializeLessonTable(buildLessonTable({ candidateSet }), { indent: 2 });
    const sizeAfter = fs.statSync(TMP_LEDGER).size;
    assert.equal(sizeAfter, sizeBefore, "projection must not mutate the ledger");
  });
});

// ── Populated candidate set ─────────────────────────────────────────────────

describe("Phase 2k-a — populated candidate set", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
    const r1 = executeSummarizationFixtureRegistration({
      source: "test:phase2k-a-populated-1",
      now:    new Date("2026-05-10T14:00:00.000Z"),
    });
    if (!r1.ok) throw new Error(`seed registration failed: ${r1.reason}`);
  });

  it("populated history candidates project into populated lessons", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    const readiness = buildLowRiskSandboxReadinessSnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history, auditExport, readiness });
    const table = buildLessonTable({ candidateSet, proposedBy: "test:phase2k-a" });
    assert.equal(table.lessons.length, candidateSet.candidates.length);
    assert.equal(table.isEmpty, false);
    assert.equal(table.evidenceProvided.history, true);
    assert.equal(table.evidenceProvided.auditExport, true);
    assert.equal(table.evidenceProvided.readiness, true);
    assert.equal(table.evidenceProvided.riskImpact, false);
    // Every lesson must point back to the candidate it was derived from.
    const candIds = new Set(candidateSet.candidates.map(c => c.candidateId));
    for (const l of table.lessons) {
      assert.ok(candIds.has(l.candidateRef.candidateId), `candidate id ${l.candidateRef.candidateId} not in candidate set`);
      assert.equal(l.audit.proposedBy, "test:phase2k-a");
    }
  });

  it("aggregate counts mirror the lesson list", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const table = buildLessonTable({ candidateSet });
    assert.equal(table.aggregate.totalLessons, table.lessons.length);
    assert.equal(table.aggregate.humanReviewRequired, table.lessons.length);
    assert.equal(table.aggregate.active, 0);
    assert.equal(table.aggregate.autoApplyEligible, 0);
    assert.equal(table.aggregate.byStatus.proposed, table.lessons.length);

    const observationCount = table.lessons.filter(l => l.kind === "observation").length;
    assert.equal(table.aggregate.byKind.observation, observationCount);

    const subsystemTotal =
      table.aggregate.bySubsystem.summarizationFixture +
      table.aggregate.bySubsystem.registrationHistory +
      table.aggregate.bySubsystem.registrationAuditExport +
      table.aggregate.bySubsystem.lowRiskSandboxReadiness +
      table.aggregate.bySubsystem.riskImpact;
    assert.equal(subsystemTotal, table.lessons.length);
  });

  it("lesson IDs are deterministic across calls AND distinct from candidate IDs", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const a = buildLessonTable({ candidateSet });
    const b = buildLessonTable({ candidateSet });
    const aIds = a.lessons.map(l => l.lessonId);
    const bIds = b.lessons.map(l => l.lessonId);
    assert.deepEqual(aIds, bIds);
    // Lesson id must NOT collide with candidate id — they're different salts
    // and serve different roles, even though they share the candidate refs.
    const candIds = new Set(candidateSet.candidates.map(c => c.candidateId));
    for (const id of aIds) assert.ok(!candIds.has(id), `lesson id ${id} collides with candidate id`);
  });

  it("serialization is byte-identical across repeated calls with the same inputs", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    const candidateSet = buildMetaReflectionCandidateSet({ history, auditExport });
    const t1 = buildLessonTable({
      candidateSet,
      now: new Date("2026-05-10T15:00:00.000Z"),
      proposedBy: "tester",
      generatedBy: "tester",
    });
    const t2 = buildLessonTable({
      candidateSet,
      now: new Date("2026-05-10T15:00:00.000Z"),
      proposedBy: "tester",
      generatedBy: "tester",
    });
    assert.equal(serializeLessonTable(t1), serializeLessonTable(t2));
    assert.equal(
      serializeLessonTable(t1, { indent: 2 }),
      serializeLessonTable(t2, { indent: 2 }),
    );
  });

  it("summarizationTemplate is the only kind that can appear with present-fixture evidence", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const table = buildLessonTable({ candidateSet });
    const presentFixture = table.lessons.filter(
      l => l.reasonCode === "evidence_present_summarization_fixture",
    );
    for (const l of presentFixture) {
      assert.equal(l.scope, "sandbox.summarizationTemplate");
      assert.equal(l.subsystem, "summarizationFixture");
      assert.equal(l.status, "proposed");
      assert.equal(l.active, false);
    }
    // Disabled-kind lessons NEVER reference summarizationTemplate.
    const disabledTemplate = table.lessons.filter(
      l => l.reasonCode === "disabled_kind_remains_disabled" &&
           l.scope === "sandbox.disabled.summarizationTemplate",
    );
    assert.equal(disabledTemplate.length, 0,
      "summarizationTemplate must not appear as a disabled-kind lesson");
  });
});

// ── Status enum coverage ────────────────────────────────────────────────────

describe("Phase 2k-a — status enum supports proposed/approved/rejected/retired but no apply path", () => {
  it("projection only emits `proposed`; other statuses are reserved for future PRs", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history });
    const table = buildLessonTable({ candidateSet });
    for (const l of table.lessons) {
      assert.equal(l.status, "proposed");
    }
    // The aggregate must surface zero counts for the reserved statuses.
    assert.equal(table.aggregate.byStatus.approved, 0);
    assert.equal(table.aggregate.byStatus.rejected, 0);
    assert.equal(table.aggregate.byStatus.retired, 0);
  });

  it("static invariants forbid activation regardless of status (defence-in-depth)", () => {
    const candidateSet = buildMetaReflectionCandidateSet({
      history: buildSandboxRegistrationHistorySnapshot(),
    });
    const table = buildLessonTable({ candidateSet });
    // Every row, regardless of (future) status, must restate the
    // propose-only / inactive / no-auto-apply contract.
    for (const l of table.lessons) {
      assert.equal(l.active, false);
      assert.equal(l.autoApplyEligible, false);
      assert.equal(l.applyEligibility, "none");
      assert.equal(l.humanReviewRequired, true);
    }
    // Table-level invariants restate the same.
    assert.equal(table.invariants.active, false);
    assert.equal(table.invariants.autoApplyEligible, false);
    assert.equal(table.invariants.proposeOnly, true);
  });
});

// ── Sanity: the schema never proposes enabling a disabled kind ──────────────

describe("Phase 2k-a — schema cannot widen sandbox capability", () => {
  it("no lesson body proposes enabling, registering, unblocking, or promoting", () => {
    const history = buildSandboxRegistrationHistorySnapshot();
    const readiness = buildLowRiskSandboxReadinessSnapshot();
    const candidateSet = buildMetaReflectionCandidateSet({ history, readiness });
    const table = buildLessonTable({ candidateSet });
    for (const l of table.lessons) {
      assert.doesNotMatch(l.body, /\benable\b/i, `lesson body must not propose enabling: ${l.body}`);
      assert.doesNotMatch(l.body, /\bunblock\b/i, `lesson body must not propose unblocking: ${l.body}`);
      // The body may legitimately reference "register" only in describing
      // existing fixture evidence (`fixture registration evidence has been
      // recorded`). It must NEVER propose new registration.
      assert.doesNotMatch(l.body, /\bpromote\b/i, `lesson body must not propose promotion: ${l.body}`);
    }
  });
});
