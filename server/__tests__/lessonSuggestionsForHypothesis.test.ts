/**
 * Tests for Phase 2k-c — read-only lesson suggestions for hypotheses.
 *
 * Spec invariants pinned by this file:
 *   1. Empty / missing inputs yield a graceful zero suggestion set.
 *   2. Approved/manual-reviewed records produce deterministic relevant
 *      suggestions for matching hypothesis contexts, with stable IDs and
 *      stable ordering by (scoreBand desc, scope asc, suggestionId asc).
 *   3. Only Phase 2k-b records with decision === "approved" become
 *      suggestions. Rejected, retired, refusal (ok:false), missing-source,
 *      and malformed records are excluded and surface in
 *      `ineligibleRecords[]` with documented reason codes.
 *   4. Records that ARE approved but match no channel surface as
 *      `ineligibleRecords[]` with reason `no_match` (audit trail, NOT a
 *      suggestion).
 *   5. Every suggestion carries the safety metadata
 *      (`suggestionOnly: true`, `autoApplyEligible: false`,
 *      `applyEligibility: "none"`, `runtimeActionEligible: false`,
 *      `publicActionEligible: false`, `requiresHumanReviewForUse: true`).
 *   6. Every suggestion includes traceable source refs (sourceLessonId,
 *      sourceDecisionId, sourceCandidateId, sourceEvidenceRefs[]),
 *      operator/source/decidedAt/rationale, matchReasonCodes[], scoreBand,
 *      score, explanation, and the static invariants.
 *   7. Deterministic IDs: same inputs → same suggestionId. Byte-identical
 *      serialization across repeated calls.
 *   8. The projection performs no I/O: ledger files, real-data fixtures,
 *      and the inputs themselves are byte-identical after the run. Source
 *      file does not reference Date.now / Math.random / randomUUID /
 *      process.env / fs / db.
 *   9. Disabled sandbox kinds remain disabled — approving a
 *      `disabled_kind_remains_disabled` lesson and matching it into a
 *      suggestion does NOT enable/register/activate that kind. The
 *      suggestion just describes the disabled state.
 *  10. `summarizationTemplate` is the only enabled sandbox kind in the
 *      audit trail; suggestions cannot widen that set.
 *  11. The module is NOT imported by runtime/monitor/scheduler/apply/
 *      promotion files (read-only invariant).
 *  12. Programmer-shaped misuse (non-object inputs) throws a TypeError.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// ledger files were touched. The helper itself does no I/O — these
// guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2kc-lesson-suggestions-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildLessonSuggestionsForHypothesis,
  serializeLessonSuggestionSet,
  LESSON_SUGGESTIONS_SCHEMA_VERSION,
  LESSON_SUGGESTIONS_LABEL,
} = await import("../experiments/lessonSuggestionsForHypothesis.ts");

const {
  recordLessonApproval,
} = await import("../experiments/lessonsDatabaseApprovalRecord.ts");

const {
  buildLessonTable,
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

const ALLOWED_MATCH_CODES = new Set<string>([
  "subsystem_match", "scope_match", "reason_code_match",
]);

const ALLOWED_INELIGIBLE_REASONS = new Set<string>([
  "refusal_record",
  "decision_not_approved",
  "malformed_record",
  "missing_source_lesson",
  "no_match",
]);

const ALLOWED_SCORE_BANDS = new Set<string>(["weak", "moderate", "strong"]);

const PINNED_AT = "2026-05-10T16:00:00.000Z";

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
      if (!after.exists) throw new Error(`Phase 2k-c tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2k-c tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2k-c tests created live ${label}!`);
    }
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildProposedLessons() {
  const history = buildSandboxRegistrationHistorySnapshot();
  const candidateSet = buildMetaReflectionCandidateSet({ history });
  const table = buildLessonTable({ candidateSet });
  assert.ok(table.lessons.length >= 1, "expected at least one proposed lesson");
  return table.lessons;
}

function approveAll(lessons: readonly any[], operator = "op", rationale = "ok") {
  const results: any[] = [];
  for (const l of lessons) {
    const r = recordLessonApproval({
      sourceLesson: l,
      decision:     "approved",
      operator,
      rationale,
      decidedAt:    PINNED_AT,
    });
    assert.equal(r.ok, true);
    results.push(r);
  }
  return results;
}

// Hypothesis context that covers every subsystem the lesson table can
// emit. This is broad enough to match every approved lesson so the test
// can audit suggestion shape against real projected rows.
function broadContext(hypothesisId = "hyp:test:1") {
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

// ── Empty / missing inputs ──────────────────────────────────────────────────

describe("Phase 2k-c — empty inputs yield a graceful zero suggestion set", () => {
  it("empty records array → empty suggestion set", () => {
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: { hypothesisId: "hyp:empty" },
      records:           [],
    });
    assert.equal(set.isEmpty, true);
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords.length, 0);
    assert.equal(set.aggregate.totalSuggestions, 0);
    assert.equal(set.aggregate.totalIneligible,  0);
    assert.equal(set.hypothesisId, "hyp:empty");
    assert.equal(set.generatedAt, null);
    assert.equal(set.generatedBy, "unspecified");
  });

  it("approved records but empty context → all records routed to no_match", () => {
    const approved = approveAll(buildProposedLessons());
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: { hypothesisId: "hyp:none" },
      records:           approved,
    });
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords.length, approved.length);
    for (const r of set.ineligibleRecords) {
      assert.equal(r.reason, "no_match");
      assert.ok(r.decisionId, "no_match should still surface the decisionId");
      assert.ok(r.lessonId,   "no_match should still surface the lessonId");
    }
  });
});

// ── Happy path: broad context matches every approved record ─────────────────

describe("Phase 2k-c — broad context emits a suggestion per approved record", () => {
  it("every approved record matches via subsystem and scope-prefix", () => {
    const lessons = buildProposedLessons();
    const approved = approveAll(lessons);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
    });
    assert.equal(set.isEmpty, false);
    assert.equal(set.suggestions.length, approved.length);
    assert.equal(set.aggregate.totalSuggestions, approved.length);
    assert.equal(set.aggregate.totalIneligible,  0);
    for (const s of set.suggestions) {
      // Source references trace back to Phase 2k-a / 2k-b / 2j-a.
      assert.ok(/^[0-9a-f]{16}$/.test(s.suggestionId), `suggestionId malformed: ${s.suggestionId}`);
      assert.ok(s.sourceLessonId.length > 0);
      assert.ok(s.sourceDecisionId.length > 0);
      assert.ok(s.sourceCandidateId.length > 0);
      // Match channels are a non-empty subset of the allowed set.
      assert.ok(s.matchReasonCodes.length >= 1, "must fire at least one channel");
      for (const m of s.matchReasonCodes) {
        assert.ok(ALLOWED_MATCH_CODES.has(m), `unknown channel: ${m}`);
      }
      // Channels are sorted lexicographically.
      const sorted = [...s.matchReasonCodes].sort();
      assert.deepEqual(s.matchReasonCodes, sorted);
      // scoreBand is one of weak/moderate/strong; score in 1..3.
      assert.ok(ALLOWED_SCORE_BANDS.has(s.scoreBand), `bad band: ${s.scoreBand}`);
      assert.ok(s.score >= 1 && s.score <= 3, `bad score: ${s.score}`);
      // Safety metadata.
      assert.equal(s.suggestionOnly, true);
      assert.equal(s.autoApplyEligible, false);
      assert.equal(s.applyEligibility, "none");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
      assert.equal(s.requiresHumanReviewForUse, true);
      // Invariants restated.
      assert.equal(s.invariants.readOnly, true);
      assert.equal(s.invariants.suggestionOnly, true);
      assert.equal(s.invariants.nonWidening, true);
      assert.equal(s.invariants.autoApplyEligible, false);
      assert.equal(s.invariants.publicAction, false);
      assert.equal(s.invariants.publicActionEligible, false);
      assert.equal(s.invariants.runtimeActionEligible, false);
      assert.equal(s.invariants.requiresHumanReviewForUse, true);
      assert.equal(s.invariants.manualReviewedOnly, true);
      // Operator/source preserved.
      assert.equal(s.operator, "op");
      assert.equal(s.source, "manual");
      assert.equal(s.decision, "approved");
      assert.equal(s.decidedAt, PINNED_AT);
    }
  });

  it("ordering is (scoreBand desc, scope asc, suggestionId asc)", () => {
    const approved = approveAll(buildProposedLessons());
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
    });
    const bandRank = { weak: 1, moderate: 2, strong: 3 } as const;
    for (let i = 1; i < set.suggestions.length; i++) {
      const a = set.suggestions[i - 1];
      const b = set.suggestions[i];
      const ra = bandRank[a.scoreBand];
      const rb = bandRank[b.scoreBand];
      if (ra !== rb) {
        assert.ok(ra >= rb, `band order broken at ${i}: ${a.scoreBand} vs ${b.scoreBand}`);
      } else if (a.scope !== b.scope) {
        assert.ok(a.scope.localeCompare(b.scope) <= 0, `scope order broken at ${i}`);
      } else {
        assert.ok(a.suggestionId.localeCompare(b.suggestionId) <= 0, `id order broken at ${i}`);
      }
    }
  });
});

// ── Scope vs subsystem vs reason-code matching ──────────────────────────────

describe("Phase 2k-c — match channels fire independently", () => {
  it("exact-scope match yields scope_match channel (strong band)", () => {
    const lessons = buildProposedLessons();
    const target = lessons.find(l => l.scope === "sandbox.summarizationTemplate");
    assert.ok(target, "expected at least one summarizationTemplate lesson");
    const [approved] = approveAll([target!]);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: {
        hypothesisId: "hyp:scope",
        scopes:       ["sandbox.summarizationTemplate"],
      },
      records:           [approved],
    });
    assert.equal(set.suggestions.length, 1);
    const s = set.suggestions[0];
    assert.ok(s.matchReasonCodes.includes("scope_match"));
    assert.equal(s.scoreBand, "strong");
  });

  it("subsystem-only match yields subsystem_match channel (moderate band)", () => {
    const lessons = buildProposedLessons();
    const target = lessons.find(l => l.subsystem === "summarizationFixture");
    assert.ok(target);
    const [approved] = approveAll([target!]);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: {
        hypothesisId: "hyp:sub",
        subsystems:   ["summarizationFixture"],
      },
      records:           [approved],
    });
    assert.equal(set.suggestions.length, 1);
    const s = set.suggestions[0];
    assert.ok(s.matchReasonCodes.includes("subsystem_match"));
    // Without a scope match, the band is moderate.
    assert.equal(s.scoreBand, "moderate");
  });

  it("reason-code-only match yields reason_code_match channel (moderate band)", () => {
    const lessons = buildProposedLessons();
    const target = lessons.find(l => l.reasonCode === "disabled_kind_remains_disabled");
    assert.ok(target, "expected at least one disabled-kind lesson");
    const [approved] = approveAll([target!]);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: {
        hypothesisId: "hyp:reason",
        reasonCodes:  ["disabled_kind_remains_disabled"],
      },
      records:           [approved],
    });
    assert.equal(set.suggestions.length, 1);
    const s = set.suggestions[0];
    assert.ok(s.matchReasonCodes.includes("reason_code_match"));
    assert.equal(s.scoreBand, "moderate");
  });

  it("multiple firing channels combine — strong wins the band", () => {
    const lessons = buildProposedLessons();
    const target = lessons.find(l => l.scope === "sandbox.summarizationTemplate");
    assert.ok(target);
    const [approved] = approveAll([target!]);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: {
        hypothesisId: "hyp:combo",
        scopes:       ["sandbox.summarizationTemplate"],
        subsystems:   ["summarizationFixture"],
        reasonCodes:  [target!.reasonCode],
      },
      records:           [approved],
    });
    assert.equal(set.suggestions.length, 1);
    const s = set.suggestions[0];
    assert.ok(s.matchReasonCodes.length >= 2);
    assert.equal(s.scoreBand, "strong");
    assert.ok(s.score >= 2);
  });

  it("scope prefix match fires even when exact scope misses", () => {
    const lessons = buildProposedLessons();
    const target = lessons[0];
    const [approved] = approveAll([target]);
    const prefix = target.scope.split(".").slice(0, 2).join(".") + ".";
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: {
        hypothesisId:  "hyp:prefix",
        scopePrefixes: [prefix],
      },
      records:           [approved],
    });
    assert.equal(set.suggestions.length, 1);
    assert.ok(set.suggestions[0].matchReasonCodes.includes("scope_match"));
  });
});

// ── Ineligibility paths ─────────────────────────────────────────────────────

describe("Phase 2k-c — only approved records are eligible", () => {
  it("rejected records are routed to ineligibleRecords with decision_not_approved", () => {
    const [source] = buildProposedLessons();
    const rejected = recordLessonApproval({
      sourceLesson: source,
      decision:     "rejected",
      operator:     "op",
      rationale:    "no good",
      decidedAt:    PINNED_AT,
    });
    assert.equal(rejected.ok, true);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           [rejected],
    });
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords.length, 1);
    assert.equal(set.ineligibleRecords[0].reason, "decision_not_approved");
  });

  it("retired records are routed to ineligibleRecords with decision_not_approved", () => {
    const [source] = buildProposedLessons();
    const retired = recordLessonApproval({
      sourceLesson: source,
      decision:     "retired",
      operator:     "op",
      rationale:    "stale",
      decidedAt:    PINNED_AT,
    });
    assert.equal(retired.ok, true);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           [retired],
    });
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords[0].reason, "decision_not_approved");
  });

  it("refusal records (ok:false) are routed to ineligibleRecords with refusal_record", () => {
    const [source] = buildProposedLessons();
    const refusal = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(refusal.ok, false);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           [refusal],
    });
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords.length, 1);
    assert.equal(set.ineligibleRecords[0].reason, "refusal_record");
  });

  it("malformed record (non-object) is routed to ineligibleRecords with malformed_record", () => {
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      // @ts-expect-error — exercising the runtime guard
      records:           [null, "not a record", 42],
    });
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords.length, 3);
    for (const r of set.ineligibleRecords) {
      assert.equal(r.reason, "malformed_record");
    }
  });

  it("approved record with missing sourceLesson is routed with missing_source_lesson", () => {
    const [source] = buildProposedLessons();
    const r = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    // Strip the sourceLesson to simulate a corrupted record.
    const corrupt: any = { ...r, sourceLesson: undefined };
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           [corrupt],
    });
    assert.equal(set.ineligibleRecords.length, 1);
    assert.equal(set.ineligibleRecords[0].reason, "missing_source_lesson");
  });

  it("approved record violating Phase 2k-b invariants is surfaced as malformed_record", () => {
    const [source] = buildProposedLessons();
    const r = recordLessonApproval({
      sourceLesson: source,
      decision:     "approved",
      operator:     "op",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    if (r.ok !== true) throw new Error("expected approved");
    // Forge an active row — this MUST be rejected as malformed by the
    // suggestion projection (defence in depth, even though Phase 2k-b
    // can never produce one).
    const forged: any = {
      ...r,
      lesson: { ...r.lesson, active: true },
    };
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           [forged],
    });
    assert.equal(set.suggestions.length, 0);
    assert.equal(set.ineligibleRecords.length, 1);
    assert.equal(set.ineligibleRecords[0].reason, "malformed_record");
  });

  it("mixed input: ineligible reasons aggregated and indexed", () => {
    const lessons = buildProposedLessons();
    const approved = approveAll([lessons[0]]);
    const rejected = recordLessonApproval({
      sourceLesson: lessons[1] ?? lessons[0],
      decision:     "rejected",
      operator:     "op",
      rationale:    "no",
      decidedAt:    PINNED_AT,
    });
    const refusal = recordLessonApproval({
      sourceLesson: lessons[0],
      decision:     "approved",
      operator:     "",
      rationale:    "ok",
      decidedAt:    PINNED_AT,
    });
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           [approved[0], rejected, refusal, null as any],
    });
    // Approved + matched → 1 suggestion. Other three are ineligible.
    assert.equal(set.suggestions.length, 1);
    assert.equal(set.ineligibleRecords.length, 3);
    // Indices preserved.
    const indices = set.ineligibleRecords.map(r => r.index);
    assert.deepEqual(indices, [1, 2, 3]);
    // Aggregate counts.
    assert.equal(set.aggregate.byIneligibleReason.decision_not_approved, 1);
    assert.equal(set.aggregate.byIneligibleReason.refusal_record,        1);
    assert.equal(set.aggregate.byIneligibleReason.malformed_record,      1);
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe("Phase 2k-c — projection is deterministic", () => {
  it("same inputs → deeply-equal output", () => {
    const approved = approveAll(buildProposedLessons());
    const inputs = {
      hypothesisContext: broadContext(),
      records:           approved,
    };
    const s1 = buildLessonSuggestionsForHypothesis(inputs);
    const s2 = buildLessonSuggestionsForHypothesis(inputs);
    assert.deepEqual(s1, s2);
  });

  it("same inputs → byte-identical serialised output", () => {
    const approved = approveAll(buildProposedLessons());
    const inputs = {
      hypothesisContext: broadContext(),
      records:           approved,
    };
    const a = serializeLessonSuggestionSet(buildLessonSuggestionsForHypothesis(inputs));
    const b = serializeLessonSuggestionSet(buildLessonSuggestionsForHypothesis(inputs));
    assert.equal(a, b);
    const aPretty = serializeLessonSuggestionSet(buildLessonSuggestionsForHypothesis(inputs), { indent: 2 });
    const bPretty = serializeLessonSuggestionSet(buildLessonSuggestionsForHypothesis(inputs), { indent: 2 });
    assert.equal(aPretty, bPretty);
  });

  it("schema version + label round-trip through serialisation", () => {
    const approved = approveAll(buildProposedLessons());
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
    });
    const out = serializeLessonSuggestionSet(set);
    assert.match(out, new RegExp(LESSON_SUGGESTIONS_SCHEMA_VERSION));
    assert.match(out, new RegExp(LESSON_SUGGESTIONS_LABEL));
  });

  it("different hypothesisId → different suggestionIds", () => {
    const approved = approveAll(buildProposedLessons());
    const s1 = buildLessonSuggestionsForHypothesis({
      hypothesisContext: { ...broadContext("hyp:1") },
      records:           approved,
    });
    const s2 = buildLessonSuggestionsForHypothesis({
      hypothesisContext: { ...broadContext("hyp:2") },
      records:           approved,
    });
    assert.equal(s1.suggestions.length, s2.suggestions.length);
    for (let i = 0; i < s1.suggestions.length; i++) {
      assert.notEqual(
        s1.suggestions[i].suggestionId,
        s2.suggestions[i].suggestionId,
        "suggestionId should depend on hypothesisId",
      );
    }
  });

  it("Date vs ISO string for `now` normalise to the same generatedAt", () => {
    const approved = approveAll(buildProposedLessons());
    const s1 = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
      now:               PINNED_AT,
    });
    const s2 = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
      now:               new Date(PINNED_AT),
    });
    assert.equal(s1.generatedAt, s2.generatedAt);
    assert.equal(s1.generatedAt, PINNED_AT);
  });
});

// ── Read-only: no I/O, no wall-clock, no mutation of inputs ─────────────────

describe("Phase 2k-c — projection performs no I/O and reads no wall clock", () => {
  it("ledger files are untouched by repeated calls", () => {
    if (!fs.existsSync(TMP_LEDGER)) fs.writeFileSync(TMP_LEDGER, "");
    const sizeBefore = fs.statSync(TMP_LEDGER).size;
    const approved = approveAll(buildProposedLessons());
    for (let i = 0; i < 10; i++) {
      buildLessonSuggestionsForHypothesis({
        hypothesisContext: broadContext(`hyp:${i}`),
        records:           approved,
      });
    }
    assert.equal(fs.statSync(TMP_LEDGER).size, sizeBefore);
  });

  it("source file does not reference Date.now / Math.random / randomUUID / process.env / fs / db", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "server", "experiments", "lessonSuggestionsForHypothesis.ts"),
      "utf8",
    );
    assert.doesNotMatch(src, /Date\.now\(/);
    assert.doesNotMatch(src, /Math\.random\(/);
    assert.doesNotMatch(src, /randomUUID\b/);
    assert.doesNotMatch(src, /process\.env\./);
    assert.doesNotMatch(src, /\bfs\.(?:write|append|unlink|mkdir|rename|chmod)/);
    assert.doesNotMatch(src, /better-sqlite3|drizzle|db\.execute|db\.run/);
  });

  it("input arrays / objects are not mutated", () => {
    const approved = approveAll(buildProposedLessons());
    const ctx = broadContext();
    const ctxBefore = JSON.stringify(ctx);
    const recordsBefore = JSON.stringify(approved);
    buildLessonSuggestionsForHypothesis({
      hypothesisContext: ctx,
      records:           approved,
    });
    assert.equal(JSON.stringify(ctx), ctxBefore);
    assert.equal(JSON.stringify(approved), recordsBefore);
  });
});

// ── Disabled kinds remain disabled ──────────────────────────────────────────

describe("Phase 2k-c — disabled kinds remain disabled through suggestions", () => {
  it("approved disabled-kind lessons surface as suggestions but stay non-actionable", () => {
    const lessons = buildProposedLessons();
    const disabled = lessons.filter(l => l.reasonCode === "disabled_kind_remains_disabled");
    assert.ok(disabled.length >= 1, "expected at least one disabled-kind lesson");
    const approved = approveAll(disabled);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
    });
    assert.equal(set.suggestions.length, disabled.length);
    for (const s of set.suggestions) {
      // Suggestion describes the disabled state and stays read-only.
      assert.match(s.scope, /^sandbox\.disabled\./);
      assert.notEqual(s.scope, "sandbox.summarizationTemplate");
      assert.equal(s.suggestionOnly, true);
      assert.equal(s.autoApplyEligible, false);
      assert.equal(s.applyEligibility, "none");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
      assert.equal(s.requiresHumanReviewForUse, true);
      assert.equal(s.invariants.nonWidening, true);
      // The serialised body cannot propose enabling the kind — we don't
      // emit free-form text from this projection, but the explanation is
      // a closed-form match string.
      assert.doesNotMatch(s.explanation, /enable|activate|register/i);
    }
  });

  it("summarizationTemplate remains the only enabled sandbox kind in the audit trail", () => {
    const lessons = buildProposedLessons();
    // The only lessons referencing sandbox.summarizationTemplate carry the
    // fixture-evidence reason codes (present or absent depending on whether
    // the fixture has been registered in this test environment). Whichever
    // reason fires, the audit trail must never rename the scope away from
    // summarizationTemplate.
    const summarization = lessons.filter(
      l => l.scope === "sandbox.summarizationTemplate",
    );
    assert.ok(summarization.length >= 1, "expected at least one summarization lesson");
    const approved = approveAll(summarization);
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
    });
    for (const s of set.suggestions) {
      assert.equal(s.scope, "sandbox.summarizationTemplate");
      assert.equal(s.runtimeActionEligible, false);
      assert.equal(s.publicActionEligible, false);
    }
  });
});

// ── Programmer-shaped misuse ────────────────────────────────────────────────

describe("Phase 2k-c — programmer-shaped misuse throws", () => {
  it("non-object inputs throw a TypeError", () => {
    assert.throws(
      // @ts-expect-error
      () => buildLessonSuggestionsForHypothesis(null),
      /inputs must be an object/,
    );
    assert.throws(
      // @ts-expect-error
      () => buildLessonSuggestionsForHypothesis("nope"),
      /inputs must be an object/,
    );
  });

  it("non-object hypothesisContext throws a TypeError", () => {
    assert.throws(
      () => buildLessonSuggestionsForHypothesis({
        // @ts-expect-error
        hypothesisContext: null,
        records:           [],
      }),
      /hypothesisContext must be an object/,
    );
  });
});

// ── Aggregate counts ────────────────────────────────────────────────────────

describe("Phase 2k-c — aggregate counts are correct", () => {
  it("aggregate equals per-suggestion counts", () => {
    const approved = approveAll(buildProposedLessons());
    const set = buildLessonSuggestionsForHypothesis({
      hypothesisContext: broadContext(),
      records:           approved,
    });
    let weak = 0, moderate = 0, strong = 0;
    const subCounts: Record<string, number> = {
      summarizationFixture: 0,
      registrationHistory: 0,
      registrationAuditExport: 0,
      lowRiskSandboxReadiness: 0,
      riskImpact: 0,
    };
    for (const s of set.suggestions) {
      if (s.scoreBand === "weak") weak++;
      if (s.scoreBand === "moderate") moderate++;
      if (s.scoreBand === "strong") strong++;
      subCounts[s.subsystem] = (subCounts[s.subsystem] ?? 0) + 1;
    }
    assert.equal(set.aggregate.byScoreBand.weak,     weak);
    assert.equal(set.aggregate.byScoreBand.moderate, moderate);
    assert.equal(set.aggregate.byScoreBand.strong,   strong);
    for (const k of Object.keys(subCounts)) {
      assert.equal((set.aggregate.bySubsystem as any)[k], subCounts[k]);
    }
    assert.equal(set.aggregate.requiresHumanReviewForUse, set.suggestions.length);
    assert.equal(set.aggregate.autoApplyEligible, 0);
  });
});

// ── Read-only invariant: module is NOT wired to runtime ─────────────────────

describe("Phase 2k-c — module is not imported by runtime / monitor / scheduler / apply-promote files", () => {
  const FORBIDDEN_IMPORTERS = [
    "server/index.ts",
    "server/routes.ts",
    "server/autonomyMonitor.ts",
    "server/selfRecommendationEngine.ts",
    "server/eval/promotionGate.ts",
    "server/researchEngine.ts",
    "server/hypothesisHygiene.ts",
    "server/hypothesisStateMachine.ts",
    "server/hypothesisTriage.ts",
  ];

  it("runtime / monitor / apply / promotion / hypothesis files do not import lessonSuggestionsForHypothesis", () => {
    for (const rel of FORBIDDEN_IMPORTERS) {
      const p = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      assert.doesNotMatch(
        src,
        /lessonSuggestionsForHypothesis/,
        `${rel} must not import lessonSuggestionsForHypothesis`,
      );
    }
  });

  it("no scheduler / hypothesis-creation / recommendation file imports lessonSuggestionsForHypothesis", () => {
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
        /lessonSuggestionsForHypothesis/,
        `${path.relative(REPO_ROOT, f)} must not import lessonSuggestionsForHypothesis`,
      );
    }
  });
});
