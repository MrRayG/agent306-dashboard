/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-a: END-TO-END LEARNING LOOP TEST HARNESS (READ-ONLY)
 *
 * Phases 2i / 2j / 2k built the pieces of an evidence-first learning loop:
 *
 *   - Phase 2i-a/b/c shipped the sandbox registration evidence channel:
 *     `executeSummarizationFixtureRegistration`,
 *     `buildSandboxRegistrationHistorySnapshot`,
 *     `buildSandboxRegistrationAuditExport`.
 *   - Phase 2j-a/b/c shipped meta-reflection: a candidate-schema projection
 *     (`buildMetaReflectionCandidateSet`), a thin live generator
 *     (`buildMetaReflectionLiveReport`), and a deterministic advisory
 *     quality score (`scoreMetaReflectionLiveReport`).
 *   - Phase 2k-a/b/c shipped the lessons-database surface: a proposed-lesson
 *     projection (`buildLessonTable`), a manual approval-decision helper
 *     (`recordLessonApproval`), and a read-only suggestion projection for
 *     hypothesis planning (`buildLessonSuggestionsForHypothesis`).
 *
 * The biggest remaining gap the user called out was **testing velocity**:
 * no single deterministic harness wires those helpers together end-to-end,
 * so each phase has to be exercised in isolation. Phase 2l-a closes that
 * gap with a propose-only, read-only, test-only harness that stitches the
 * existing helpers into a single deterministic call.
 *
 * Phase 2l-a is intentionally:
 *
 *   - TEST-ONLY / INTERNAL: there is no UI control, no API endpoint, no
 *     scheduler hook, no app-boot hook, no monitor write-side-effect. The
 *     module lives under `server/experiments/` and is imported only by its
 *     test file and by future REPL / experiment scripts that pin all
 *     inputs explicitly.
 *   - READ-ONLY / PURE: no file is opened, no JSONL is parsed, no DB is
 *     touched, no in-memory map is mutated, no env var is set, no scheduler
 *     is signalled. The harness either uses pre-built evidence inputs from
 *     the caller (preferred — tests pin them) or asks the existing read-only
 *     Phase 2i helpers for their current view of the world. Either way no
 *     mutation happens here.
 *   - PROPOSE-ONLY / SUGGESTION-ONLY: every artefact the harness produces
 *     restates the propose-only contract verbatim. Reflection candidates
 *     remain `humanReviewRequired: true` / `autoApplyEligible: false`.
 *     Quality scores remain `advisoryOnly: true`. Proposed lessons remain
 *     `status: "proposed"` / `active: false`. Approval decision rows
 *     remain `runtimeActionEligible: false` / `publicActionEligible: false`.
 *     Hypothesis suggestions remain `suggestionOnly: true` /
 *     `requiresHumanReviewForUse: true`.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical injected evidence,
 *     identical operator decisions, identical pinned `now`, and identical
 *     hypothesis context, the harness returns deeply-equal output every
 *     time. Serialised output is byte-identical. There is no `Date.now`,
 *     no `Math.random`, no UUID, no env read, no wall-clock read.
 *   - GRACEFUL ON EMPTY: a cold harness call (no evidence, no decisions,
 *     no context) produces a well-typed empty result with zero counts,
 *     zero candidates, zero approvals, zero suggestions, and a clear
 *     `missingSourceWarnings[]` block. Empty is not a failure — the
 *     harness reports its overall status as `cold` rather than `success`.
 *   - REUSE-FIRST: this module does not re-derive any evidence, does not
 *     re-implement any projection, does not bypass any guard. It calls
 *     the existing Phase 2i / 2j / 2k helpers verbatim and returns their
 *     outputs unmodified.
 *   - NON-WIDENING: the harness cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. `summarizationTemplate` remains the only
 *     enabled sandbox kind. Disabled kinds remain disabled — the harness
 *     describes their disabled state for human review, never proposes
 *     enabling them.
 *   - NO PROMOTION GATE BYPASS: the harness never calls
 *     `applyRecommendation`, `canPromote`, the recommendation engine, the
 *     hypothesis creation flow, or any runtime behavior. Approval records
 *     produced here are in-process audit rows only — they are not written
 *     anywhere and are not eligible to drive any downstream action.
 *
 * The harness emits explicit success metrics so a test can fail fast and
 * loudly when any stage of the loop produces unexpected output:
 *
 *   - reflectionCandidateCount, reflectionMissingSourceWarningCount
 *   - qualityScore numeric + qualityBand bucket
 *   - proposedLessonCount, approvalDecisionCount,
 *     approvalRefusalCount
 *   - hypothesisSuggestionCount, hypothesisIneligibleCount
 *   - safetyInvariantsHeld pass/fail summary across every stage
 *
 * Tests pin:
 *   - End-to-end happy path on seeded fixture evidence produces non-zero
 *     candidates, score, lessons, approvals, and suggestions.
 *   - Empty / cold inputs produce zero counts and `overallStatus: "cold"`
 *     without overstating success.
 *   - Repeated runs with identical inputs are deeply-equal and
 *     byte-identical.
 *   - No writes to ledger / fs / db / env / monitor state. Input objects
 *     are not mutated.
 *   - Every output carries the documented safety invariants.
 *   - Disabled sandbox kinds remain disabled / non-actionable through the
 *     full loop.
 *   - The harness is NOT imported by `server/index.ts`, by the autonomy
 *     monitor, by `applyRecommendation`, by `canPromote`, by the scheduler,
 *     or by any UI control.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildSandboxRegistrationHistorySnapshot,
  type SandboxRegistrationHistorySnapshot,
} from "./sandboxRegistrationHistory.js";
import {
  buildSandboxRegistrationAuditExport,
  type SandboxRegistrationAuditExport,
} from "./sandboxRegistrationAuditExport.js";
import {
  buildLowRiskSandboxReadinessSnapshot,
  type LowRiskSandboxReadinessSnapshot,
} from "./lowRiskSandboxReadiness.js";
import {
  type RiskImpactSummary,
} from "./hypothesisRiskImpactScoring.js";
import {
  buildMetaReflectionCandidateSet,
  type MetaReflectionCandidateSet,
} from "./metaReflectionCandidateSchema.js";
import {
  buildMetaReflectionLiveReport,
  type MetaReflectionLiveReport,
} from "./metaReflectionLiveGenerator.js";
import {
  scoreMetaReflectionLiveReport,
  type MetaReflectionQualityScore,
  type MetaReflectionQualityBand,
} from "./metaReflectionQualityScoring.js";
import {
  buildLessonTable,
  type LessonTable,
  type LessonRow,
} from "./lessonsDatabaseSchema.js";
import {
  recordLessonApproval,
  type LessonApprovalDecision,
  type LessonApprovalResult,
  type LessonApprovalRecord,
} from "./lessonsDatabaseApprovalRecord.js";
import {
  buildLessonSuggestionsForHypothesis,
  type LessonSuggestionHypothesisContext,
  type LessonSuggestionSet,
} from "./lessonSuggestionsForHypothesis.js";

/** Stable schema identifier for the harness result. Bumped only when the
 *  result shape changes in a backwards-incompatible way. */
export const LEARNING_LOOP_HARNESS_SCHEMA_VERSION = "phase2l-a.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const LEARNING_LOOP_HARNESS_LABEL =
  "agent306.learning_loop_test_harness";

/** Coarse overall status for the harness run. */
export type LearningLoopHarnessStatus =
  | "cold"          // No evidence and no candidates — empty graceful path.
  | "partial"       // Some stages produced output but at least one is empty.
  | "success"       // Every stage produced output and safety invariants held.
  | "safety_warning"; // At least one stage tripped a safety invariant check.

/** A single explicit operator decision the test/REPL supplies. */
export interface LearningLoopHarnessOperatorDecision {
  /** Source lesson id from the Phase 2k-a lesson table. */
  lessonId:   string;
  /** Decision the operator records — approved / rejected / retired. */
  decision:   LessonApprovalDecision;
  /** Non-empty operator identifier. */
  operator:   string;
  /** Non-empty rationale. */
  rationale:  string;
  /** REQUIRED ISO-8601 string or Date — the harness never reads the wall clock. */
  decidedAt:  Date | string;
}

/** Inputs to the harness. All evidence fields are optional — when omitted
 *  the harness asks the existing read-only Phase 2i helpers for their view.
 *  Tests pin them explicitly to keep the run deterministic. */
export interface LearningLoopHarnessInputs {
  /** Pre-built history snapshot. Default: read-only helper. */
  history?:           SandboxRegistrationHistorySnapshot;
  /** Pre-built audit export. Default: derived from history via helper. */
  auditExport?:       SandboxRegistrationAuditExport;
  /** Pre-built readiness snapshot. Default: read-only helper. */
  readiness?:         LowRiskSandboxReadinessSnapshot;
  /** Optional injected risk-impact summary. Default: omitted. */
  riskImpact?:        RiskImpactSummary;
  /** Optional pre-built candidate set. When provided, the harness skips
   *  candidate-set construction and uses this verbatim. Useful for unit
   *  tests that want to isolate downstream stages. */
  candidateSetOverride?: MetaReflectionCandidateSet;

  /** Operator decisions to apply to proposed lessons. The harness matches
   *  each decision against the proposed lesson table by `lessonId`; missing
   *  lessons surface as `unmatchedDecisions[]`. Empty / omitted means no
   *  approval records will be produced. */
  operatorDecisions?: readonly LearningLoopHarnessOperatorDecision[];

  /** Hypothesis context to feed into the suggestion projection. When
   *  omitted, the suggestion stage is skipped (zero suggestions / zero
   *  ineligibles). */
  hypothesisContext?: LessonSuggestionHypothesisContext;

  /** Optional pinned timestamp used as `now` for the candidate set, live
   *  report, quality score, and lesson table generation. The harness NEVER
   *  reads the wall clock. */
  now?:               Date | string;

  /** Optional caller label echoed onto every stage that supports it. */
  generatedBy?:       string;
}

/** Per-stage success metric block — surfaced for test assertions. */
export interface LearningLoopHarnessMetrics {
  reflectionCandidateCount:          number;
  reflectionMissingSourceWarningCount: number;
  qualityScore:                      number;
  qualityBand:                       MetaReflectionQualityBand;
  proposedLessonCount:               number;
  /** Number of successful approval/decision records (`ok: true`). */
  approvalDecisionCount:             number;
  /** Number of structured refusal records (`ok: false`). */
  approvalRefusalCount:              number;
  hypothesisSuggestionCount:         number;
  hypothesisIneligibleCount:         number;
  /** Decisions that referenced a lesson id not present in the proposed
   *  lesson table. Surfaced for audit, never silently ignored. */
  unmatchedDecisionCount:            number;
  /** True iff every per-stage safety invariant check passed. */
  safetyInvariantsHeld:              boolean;
}

/** A decision that did not match any proposed lesson. */
export interface LearningLoopHarnessUnmatchedDecision {
  /** Index into the input `operatorDecisions[]` array. */
  index:      number;
  lessonId:   string;
  decision:   LessonApprovalDecision;
  /** Short, deterministic reason. */
  reason:     "lesson_not_found";
}

/** Aggregate restatement of every safety invariant across every stage. */
export interface LearningLoopHarnessSafetyInvariants {
  /** Every reflection candidate is `humanReviewRequired:true` and
   *  `autoApplyEligible:false`. */
  reflectionCandidatesProposeOnly:   boolean;
  /** Quality score is `advisoryOnly:true` and `applyEligibility:"none"`. */
  qualityScoreAdvisoryOnly:          boolean;
  /** Every proposed lesson is `status:"proposed"`, `active:false`,
   *  `autoApplyEligible:false`, `applyEligibility:"none"`. */
  proposedLessonsProposeOnly:        boolean;
  /** Every successful approval record keeps the row inactive /
   *  non-actionable. */
  approvalRecordsRuntimeInactive:    boolean;
  /** Every emitted suggestion is `suggestionOnly:true`,
   *  `requiresHumanReviewForUse:true`. */
  suggestionsSuggestionOnly:         boolean;
  /** Aggregate `&&` across every per-stage check. */
  allInvariantsHeld:                 boolean;
}

/** The full harness result. */
export interface LearningLoopHarnessResult {
  schemaVersion:    typeof LEARNING_LOOP_HARNESS_SCHEMA_VERSION;
  label:            typeof LEARNING_LOOP_HARNESS_LABEL;
  /** Caller-injected ISO timestamp. `null` when none was passed. */
  generatedAt:      string | null;
  /** Caller-supplied label. Defaults to `"learning_loop_harness"`. */
  generatedBy:      string;
  /** Coarse overall status. */
  overallStatus:    LearningLoopHarnessStatus;

  /** Stage 1: the Phase 2j-a candidate set, embedded verbatim. */
  candidateSet:     MetaReflectionCandidateSet;
  /** Stage 2: the Phase 2j-b live report, embedded verbatim. */
  liveReport:       MetaReflectionLiveReport;
  /** Stage 3: the Phase 2j-c quality score, embedded verbatim. */
  qualityScore:     MetaReflectionQualityScore;
  /** Stage 4: the Phase 2k-a lesson table, embedded verbatim. */
  lessonTable:      LessonTable;
  /** Stage 5: every approval result returned by `recordLessonApproval`,
   *  ok-records and refusal-records both, in input order. */
  approvalResults:  readonly LessonApprovalResult[];
  /** Stage 6: the Phase 2k-c suggestion set, embedded verbatim. Empty
   *  when no `hypothesisContext` was supplied. */
  suggestionSet:    LessonSuggestionSet;

  /** Decisions that referenced a lesson id not in the proposed table. */
  unmatchedDecisions: readonly LearningLoopHarnessUnmatchedDecision[];

  /** Short, stable warnings derived from the live report's missing source
   *  channels (so a test can fail fast on missing evidence). */
  missingSourceWarnings: readonly string[];

  metrics:          LearningLoopHarnessMetrics;
  safety:           LearningLoopHarnessSafetyInvariants;

  /** Static restatement of the propose-only / read-only contract — also
   *  restated on every embedded stage for defence-in-depth. */
  invariants: {
    readOnly:                  true;
    proposeOnly:               true;
    suggestionOnly:            true;
    nonWidening:               true;
    autoApplyEligible:         false;
    publicAction:              false;
    schedulerDriven:           false;
    mutating:                  false;
    humanReviewRequired:       true;
    runtimeActionEligible:     false;
    publicActionEligible:      false;
    manualReviewedOnly:        true;
    testOnly:                  true;
  };
}

const FIXED_INVARIANTS = {
  readOnly:                  true,
  proposeOnly:               true,
  suggestionOnly:            true,
  nonWidening:               true,
  autoApplyEligible:         false,
  publicAction:              false,
  schedulerDriven:           false,
  mutating:                  false,
  humanReviewRequired:       true,
  runtimeActionEligible:     false,
  publicActionEligible:      false,
  manualReviewedOnly:        true,
  testOnly:                  true,
} as const;

// ── Internal helpers ────────────────────────────────────────────────────────

function normaliseGeneratedAt(now: Date | string | undefined): string | null {
  if (now instanceof Date) {
    const t = now.getTime();
    return Number.isFinite(t) ? now.toISOString() : null;
  }
  if (typeof now === "string" && now.length > 0) {
    const parsed = new Date(now);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now;
  }
  return null;
}

function checkReflectionInvariants(set: MetaReflectionCandidateSet): boolean {
  const candidates = Array.isArray(set?.candidates) ? set.candidates : [];
  for (const c of candidates) {
    if (c.humanReviewRequired !== true)  return false;
    if (c.autoApplyEligible   !== false) return false;
    if (!c.invariants) return false;
    if (c.invariants.readOnly          !== true)  return false;
    if (c.invariants.proposeOnly       !== true)  return false;
    if (c.invariants.autoApplyEligible !== false) return false;
    if (c.invariants.publicAction      !== false) return false;
    if (c.invariants.schedulerDriven   !== false) return false;
    if (c.invariants.mutating          !== false) return false;
  }
  return true;
}

function checkQualityScoreInvariants(score: MetaReflectionQualityScore): boolean {
  if (score.advisoryOnly !== true) return false;
  if (score.applyEligibility !== "none") return false;
  if (!score.invariants) return false;
  if (score.invariants.advisoryOnly !== true) return false;
  if (score.invariants.autoApplyEligible !== false) return false;
  if (score.invariants.proposeOnly !== true) return false;
  return true;
}

function checkProposedLessonInvariants(table: LessonTable): boolean {
  for (const l of table.lessons) {
    if (l.status !== "proposed") return false;
    if (l.active  !== false)     return false;
    if (l.autoApplyEligible !== false) return false;
    if (l.applyEligibility !== "none") return false;
    if (l.humanReviewRequired !== true) return false;
    if (!l.invariants) return false;
    if (l.invariants.autoApplyEligible !== false) return false;
    if (l.invariants.active !== false) return false;
    if (l.invariants.proposeOnly !== true) return false;
  }
  return true;
}

function checkApprovalInvariants(results: readonly LessonApprovalResult[]): boolean {
  for (const r of results) {
    if (r.ok !== true) continue; // refusals don't carry a row — they're fine.
    const rec = r as LessonApprovalRecord;
    if (rec.lesson.active !== false) return false;
    if (rec.lesson.autoApplyEligible !== false) return false;
    if (rec.lesson.applyEligibility !== "none") return false;
    if (rec.lesson.humanReviewRequired !== true) return false;
    if (rec.lesson.runtimeActionEligible !== false) return false;
    if (rec.lesson.publicActionEligible !== false) return false;
    if (rec.lesson.manualReviewedOnly !== true) return false;
    if (!rec.invariants) return false;
    if (rec.invariants.runtimeActionEligible !== false) return false;
    if (rec.invariants.publicActionEligible !== false) return false;
    if (rec.invariants.autoApplyEligible !== false) return false;
  }
  return true;
}

function checkSuggestionInvariants(set: LessonSuggestionSet): boolean {
  for (const s of set.suggestions) {
    if (s.suggestionOnly !== true) return false;
    if (s.autoApplyEligible !== false) return false;
    if (s.applyEligibility !== "none") return false;
    if (s.runtimeActionEligible !== false) return false;
    if (s.publicActionEligible !== false) return false;
    if (s.requiresHumanReviewForUse !== true) return false;
    if (!s.invariants) return false;
    if (s.invariants.suggestionOnly !== true) return false;
    if (s.invariants.autoApplyEligible !== false) return false;
    if (s.invariants.requiresHumanReviewForUse !== true) return false;
  }
  return true;
}

/**
 * Reason codes that indicate the harness saw *positive* evidence — i.e.
 * a populated fixture row / populated history / populated audit export /
 * a non-empty risk-impact summary. Without at least one of these the
 * harness reports `cold`, regardless of how many empty/absent-state
 * candidates the projection emitted.
 */
const POSITIVE_EVIDENCE_REASON_CODES: ReadonlySet<string> = new Set([
  "evidence_present_summarization_fixture",
  "registration_history_populated",
  "audit_export_present",
  "risk_impact_blocked_present",
  "risk_impact_needs_review_present",
]);

function hasPositiveEvidence(set: MetaReflectionCandidateSet): boolean {
  for (const c of set.candidates) {
    if (POSITIVE_EVIDENCE_REASON_CODES.has(c.reasonCode)) return true;
  }
  return false;
}

function deriveOverallStatus(
  metrics: LearningLoopHarnessMetrics,
  hadHypothesisContext: boolean,
  positiveEvidence: boolean,
): LearningLoopHarnessStatus {
  if (!metrics.safetyInvariantsHeld) return "safety_warning";
  // No positive evidence AND no operator decisions AND no hypothesis
  // context → cold. The candidate-set projection still emits "absence"
  // candidates in this state (registration_history_empty,
  // disabled_kind_remains_disabled, …); they are graceful empty-state
  // descriptors, not signs of success.
  if (!positiveEvidence &&
      metrics.approvalDecisionCount  === 0 &&
      metrics.approvalRefusalCount   === 0 &&
      metrics.hypothesisSuggestionCount === 0 &&
      metrics.unmatchedDecisionCount === 0) {
    return "cold";
  }
  // "success" requires positive evidence (so the loop saw something
  // beyond cold-state absence candidates) AND every populated stage
  // produced output. When the caller did not supply a hypothesis
  // context, the suggestion stage is intentionally skipped — that
  // counts as success when every earlier stage produced output.
  const stagesOk =
    positiveEvidence &&
    metrics.proposedLessonCount > 0 &&
    metrics.unmatchedDecisionCount === 0 &&
    metrics.approvalRefusalCount === 0 &&
    (!hadHypothesisContext || metrics.hypothesisSuggestionCount > 0);
  return stagesOk ? "success" : "partial";
}

// ── Public harness ──────────────────────────────────────────────────────────

/**
 * Run the read-only, propose-only, end-to-end learning loop harness.
 *
 * Pure: no I/O write, no DB write, no env mutation, no scheduler signal,
 * no wall-clock read (callers MUST pin `now` for byte-identical output).
 *
 * Empty / missing inputs produce a graceful `cold` result. Any safety
 * invariant violation in any embedded stage flips `overallStatus` to
 * `safety_warning` and marks `metrics.safetyInvariantsHeld` false — the
 * test/reviewer is expected to act on that.
 */
export function runLearningLoopHarness(
  inputs: LearningLoopHarnessInputs = {},
): LearningLoopHarnessResult {
  if (inputs === null || typeof inputs !== "object") {
    throw new TypeError("runLearningLoopHarness: inputs must be an object");
  }

  const generatedBy = typeof inputs.generatedBy === "string" && inputs.generatedBy.length > 0
    ? inputs.generatedBy
    : "learning_loop_harness";
  const generatedAt = normaliseGeneratedAt(inputs.now);

  // Stage 1: candidate set — either injected verbatim or built from evidence.
  let candidateSet: MetaReflectionCandidateSet;
  if (inputs.candidateSetOverride !== undefined) {
    candidateSet = inputs.candidateSetOverride;
  } else {
    // Resolve evidence inputs defensively. Missing evidence surfaces as
    // empty candidate set rather than a throw.
    const history = inputs.history ?? safeBuild(buildSandboxRegistrationHistorySnapshot);
    const auditExport = inputs.auditExport ?? (history !== undefined
      ? safeBuildAudit(history)
      : undefined);
    const readiness = inputs.readiness ?? safeBuild(buildLowRiskSandboxReadinessSnapshot);
    candidateSet = buildMetaReflectionCandidateSet({
      history,
      auditExport,
      readiness,
      riskImpact: inputs.riskImpact,
      now: inputs.now,
      generatedBy,
    });
  }

  // Stage 2: live report — surfaces the evidence-source marker / missing
  // warnings. Built from the same evidence the candidate set used.
  const liveReport = buildMetaReflectionLiveReport({
    history:     inputs.history,
    auditExport: inputs.auditExport,
    readiness:   inputs.readiness,
    riskImpact:  inputs.riskImpact,
    now:         inputs.now,
    generatedBy,
  });

  // Stage 3: quality score — pure projection over the live report.
  const qualityScore = scoreMetaReflectionLiveReport(liveReport);

  // Stage 4: lesson table — pure projection over the candidate set.
  const lessonTable = buildLessonTable({
    candidateSet,
    now: inputs.now,
    proposedBy: generatedBy,
    generatedBy,
  });

  // Stage 5: approval records — caller supplies explicit operator
  // decisions; the harness matches each to a proposed lesson and calls
  // `recordLessonApproval`. Decisions that don't match any lesson surface
  // in `unmatchedDecisions[]`.
  const lessonById = new Map<string, LessonRow>();
  for (const l of lessonTable.lessons) lessonById.set(l.lessonId, l);

  const approvalResults: LessonApprovalResult[] = [];
  const unmatchedDecisions: LearningLoopHarnessUnmatchedDecision[] = [];
  const decisions = Array.isArray(inputs.operatorDecisions) ? inputs.operatorDecisions : [];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const source = lessonById.get(d.lessonId);
    if (source === undefined) {
      unmatchedDecisions.push({
        index:    i,
        lessonId: d.lessonId,
        decision: d.decision,
        reason:   "lesson_not_found",
      });
      continue;
    }
    const result = recordLessonApproval({
      sourceLesson: source,
      decision:     d.decision,
      operator:     d.operator,
      rationale:    d.rationale,
      decidedAt:    d.decidedAt,
    });
    approvalResults.push(result);
  }

  // Stage 6: suggestion set — only built when a hypothesis context is
  // provided. Without a context the harness emits an empty suggestion set
  // (no records fed in) rather than emitting a no-match ineligibility entry
  // per approved record — the suggestion stage is skipped, not failed.
  const hadHypothesisContext = inputs.hypothesisContext !== undefined;
  const suggestionSet = buildLessonSuggestionsForHypothesis({
    hypothesisContext: hadHypothesisContext
      ? inputs.hypothesisContext!
      : { hypothesisId: "harness:no_context" },
    records:           hadHypothesisContext ? approvalResults : [],
    now:               inputs.now,
    generatedBy,
  });

  // Aggregate counts and safety checks.
  const approvalDecisionCount = approvalResults.filter(r => r.ok === true).length;
  const approvalRefusalCount  = approvalResults.filter(r => r.ok === false).length;

  const safety: LearningLoopHarnessSafetyInvariants = {
    reflectionCandidatesProposeOnly: checkReflectionInvariants(candidateSet),
    qualityScoreAdvisoryOnly:        checkQualityScoreInvariants(qualityScore),
    proposedLessonsProposeOnly:      checkProposedLessonInvariants(lessonTable),
    approvalRecordsRuntimeInactive:  checkApprovalInvariants(approvalResults),
    suggestionsSuggestionOnly:       checkSuggestionInvariants(suggestionSet),
    allInvariantsHeld:               false,
  };
  safety.allInvariantsHeld =
    safety.reflectionCandidatesProposeOnly &&
    safety.qualityScoreAdvisoryOnly &&
    safety.proposedLessonsProposeOnly &&
    safety.approvalRecordsRuntimeInactive &&
    safety.suggestionsSuggestionOnly;

  const metrics: LearningLoopHarnessMetrics = {
    reflectionCandidateCount:           candidateSet.candidates.length,
    reflectionMissingSourceWarningCount: liveReport.missingSourceWarnings.length,
    qualityScore:                        qualityScore.overallScore,
    qualityBand:                         qualityScore.qualityBand,
    proposedLessonCount:                 lessonTable.lessons.length,
    approvalDecisionCount,
    approvalRefusalCount,
    hypothesisSuggestionCount:           hadHypothesisContext ? suggestionSet.suggestions.length : 0,
    hypothesisIneligibleCount:           hadHypothesisContext ? suggestionSet.ineligibleRecords.length : 0,
    unmatchedDecisionCount:              unmatchedDecisions.length,
    safetyInvariantsHeld:                safety.allInvariantsHeld,
  };

  const overallStatus = deriveOverallStatus(
    metrics,
    hadHypothesisContext,
    hasPositiveEvidence(candidateSet),
  );

  return {
    schemaVersion:        LEARNING_LOOP_HARNESS_SCHEMA_VERSION,
    label:                LEARNING_LOOP_HARNESS_LABEL,
    generatedAt,
    generatedBy,
    overallStatus,
    candidateSet,
    liveReport,
    qualityScore,
    lessonTable,
    approvalResults,
    suggestionSet,
    unmatchedDecisions,
    missingSourceWarnings: liveReport.missingSourceWarnings,
    metrics,
    safety,
    invariants:           { ...FIXED_INVARIANTS },
  };
}

// Tiny defensive wrappers so the harness never throws on missing evidence.
function safeBuild<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function safeBuildAudit(
  history: SandboxRegistrationHistorySnapshot,
): SandboxRegistrationAuditExport | undefined {
  try {
    return buildSandboxRegistrationAuditExport({ snapshot: history });
  } catch {
    return undefined;
  }
}

/**
 * Stable, deterministic JSON serializer for the harness result. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern used by
 * every other Phase 2j/2k helper.
 */
export function serializeLearningLoopHarnessResult(
  result: LearningLoopHarnessResult,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedUnmatched = result.unmatchedDecisions.map(d => ({
    index:    d.index,
    lessonId: d.lessonId,
    decision: d.decision,
    reason:   d.reason,
  }));

  const ordered = {
    schemaVersion:        result.schemaVersion,
    label:                result.label,
    generatedAt:          result.generatedAt,
    generatedBy:          result.generatedBy,
    overallStatus:        result.overallStatus,
    metrics: {
      reflectionCandidateCount:            result.metrics.reflectionCandidateCount,
      reflectionMissingSourceWarningCount: result.metrics.reflectionMissingSourceWarningCount,
      qualityScore:                        result.metrics.qualityScore,
      qualityBand:                         result.metrics.qualityBand,
      proposedLessonCount:                 result.metrics.proposedLessonCount,
      approvalDecisionCount:               result.metrics.approvalDecisionCount,
      approvalRefusalCount:                result.metrics.approvalRefusalCount,
      hypothesisSuggestionCount:           result.metrics.hypothesisSuggestionCount,
      hypothesisIneligibleCount:           result.metrics.hypothesisIneligibleCount,
      unmatchedDecisionCount:              result.metrics.unmatchedDecisionCount,
      safetyInvariantsHeld:                result.metrics.safetyInvariantsHeld,
    },
    safety: {
      reflectionCandidatesProposeOnly: result.safety.reflectionCandidatesProposeOnly,
      qualityScoreAdvisoryOnly:        result.safety.qualityScoreAdvisoryOnly,
      proposedLessonsProposeOnly:      result.safety.proposedLessonsProposeOnly,
      approvalRecordsRuntimeInactive:  result.safety.approvalRecordsRuntimeInactive,
      suggestionsSuggestionOnly:       result.safety.suggestionsSuggestionOnly,
      allInvariantsHeld:               result.safety.allInvariantsHeld,
    },
    unmatchedDecisions:    orderedUnmatched,
    missingSourceWarnings: [...result.missingSourceWarnings],
    invariants: {
      readOnly:                  result.invariants.readOnly,
      proposeOnly:               result.invariants.proposeOnly,
      suggestionOnly:            result.invariants.suggestionOnly,
      nonWidening:               result.invariants.nonWidening,
      autoApplyEligible:         result.invariants.autoApplyEligible,
      publicAction:              result.invariants.publicAction,
      schedulerDriven:           result.invariants.schedulerDriven,
      mutating:                  result.invariants.mutating,
      humanReviewRequired:       result.invariants.humanReviewRequired,
      runtimeActionEligible:     result.invariants.runtimeActionEligible,
      publicActionEligible:      result.invariants.publicActionEligible,
      manualReviewedOnly:        result.invariants.manualReviewedOnly,
      testOnly:                  result.invariants.testOnly,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
