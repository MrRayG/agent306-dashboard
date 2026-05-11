/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-b: MANUAL LEARNING LOOP REPORT (READ-ONLY / TEST-ONLY)
 *
 * Phase 2l-a (`learningLoopHarness.ts`) wired the Phase 2i/2j/2k pieces into
 * a single deterministic propose-only end-to-end loop: evidence → reflection
 * candidates → quality score → proposed lessons → manual approval records →
 * read-only hypothesis suggestions.
 *
 * The user wants daily testing velocity but explicitly does NOT want a
 * scheduler / cron / app-boot wiring yet. Phase 2l-b adds the very next
 * narrowest step: a manual / test-only **report helper** that wraps one
 * harness run into a structured, human-readable, byte-deterministic summary
 * payload. The report restates every safety invariant verbatim and surfaces
 * the explicit success/failure metrics a daily reviewer needs in one place:
 *
 *   - overallStatus (mirrors the harness's status; the report adds a coarse
 *     review-priority band so an operator can triage at a glance).
 *   - reflection candidate count + missing-source warning count.
 *   - quality score + quality band.
 *   - proposed lesson count.
 *   - approval decision count + approval refusal count + unmatched decision
 *     count.
 *   - hypothesis suggestion count + ineligible count.
 *   - safety invariant per-stage table + aggregate held/violated flag.
 *   - key blockers (anything that would prevent a reviewer from calling the
 *     run a "success") and key warnings (informational signals such as
 *     missing-source channels or a low quality band).
 *
 * Phase 2l-b is intentionally:
 *
 *   - TEST-ONLY / INTERNAL: there is no UI control, no API endpoint, no
 *     scheduler hook, no app-boot hook, no monitor write-side-effect, no
 *     CLI binary. The module lives under `server/experiments/` and is
 *     imported only by its test file. A future REPL script may import
 *     it but it MUST pin all inputs explicitly.
 *   - READ-ONLY / PURE: no file is opened, no JSONL is parsed, no DB is
 *     touched, no in-memory map is mutated, no env var is set, no
 *     scheduler is signalled. The report calls the existing Phase 2l-a
 *     harness verbatim — itself read-only / pure — and shapes its output.
 *   - PROPOSE-ONLY / SUGGESTION-ONLY: every artefact the report embeds
 *     restates the propose-only contract verbatim. Reflection candidates
 *     remain `humanReviewRequired: true` / `autoApplyEligible: false`.
 *     Quality scores remain `advisoryOnly: true`. Proposed lessons remain
 *     `status: "proposed"` / `active: false`. Approval decision rows
 *     remain `runtimeActionEligible: false` / `publicActionEligible: false`.
 *     Hypothesis suggestions remain `suggestionOnly: true` /
 *     `requiresHumanReviewForUse: true`. The report itself adds no new
 *     authority and CANNOT make any of those false.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical injected harness
 *     inputs, identical injected metadata (run label, operator, source),
 *     and identical pinned `now`, the report returns a deeply-equal
 *     payload every time. Serialised output is byte-identical. There is
 *     no `Date.now`, no `Math.random`, no UUID, no env read, no
 *     wall-clock read.
 *   - GRACEFUL ON COLD: when the underlying harness reports `cold`, the
 *     report restates `cold` and emits empty blockers/warnings (cold is
 *     not a failure — it is a graceful empty state). A `partial` harness
 *     run surfaces specific blockers explaining which stage was empty.
 *     A `safety_warning` harness run surfaces an explicit safety blocker
 *     pointing at the violating stage.
 *   - REUSE-FIRST: this module does not re-derive any evidence, does not
 *     re-implement any projection, does not bypass any guard. It calls
 *     `runLearningLoopHarness` verbatim and shapes its output.
 *   - NON-WIDENING: the report cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. `summarizationTemplate` remains the only
 *     enabled sandbox kind. Disabled kinds remain disabled — the report
 *     describes their disabled state for human review.
 *   - NO PROMOTION GATE BYPASS: the report never calls
 *     `applyRecommendation`, `canPromote`, the recommendation engine, the
 *     hypothesis creation flow, or any runtime behavior. It is an
 *     observational projection over one harness run.
 *
 * Tests pin:
 *   - A seeded happy-path harness result maps to a `success` report with
 *     non-zero metrics and the safety disclaimer block.
 *   - A cold harness result maps to a `cold` report with zero blockers
 *     and zero warnings beyond cold-state informational entries.
 *   - A partial harness result (e.g. unmatched-decision-only) maps to a
 *     `partial` report with explicit blockers.
 *   - A safety_warning harness result maps to a `safety_warning` report
 *     with an explicit safety blocker.
 *   - Repeated runs with identical inputs produce deeply-equal /
 *     byte-identical output.
 *   - No writes to ledger / fs / db / env / monitor state. Input objects
 *     are not mutated.
 *   - Every output carries the documented safety invariants and
 *     disclaimer block.
 *   - The report module is NOT imported by `server/index.ts`, by the
 *     autonomy monitor, by `applyRecommendation`, by `canPromote`, by
 *     the scheduler, or by any UI control.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  runLearningLoopHarness,
  serializeLearningLoopHarnessResult,
  type LearningLoopHarnessInputs,
  type LearningLoopHarnessResult,
  type LearningLoopHarnessStatus,
  type LearningLoopHarnessOperatorDecision,
} from "./learningLoopHarness.js";
import type {
  LessonSuggestionHypothesisContext,
} from "./lessonSuggestionsForHypothesis.js";

/** Stable schema identifier for the report payload. Bumped only when the
 *  result shape changes in a backwards-incompatible way. */
export const LEARNING_LOOP_REPORT_SCHEMA_VERSION = "phase2l-b.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const LEARNING_LOOP_REPORT_LABEL =
  "agent306.manual_learning_loop_report";

/** Static, verbatim safety disclaimer block. Embedded in every report. */
export const LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER = [
  "This report is a manual / test-only observational summary of one",
  "deterministic learning-loop harness run.",
  "It is read-only and propose-only: it does not apply lessons, does not",
  "promote hypotheses, does not enable sandbox kinds, does not write to",
  "any database / filesystem / ledger / monitor, and is not wired to any",
  "scheduler, app-boot, UI, or API path.",
  "Every embedded artefact carries its own propose-only / suggestion-only",
  "contract; this report cannot widen those contracts.",
] as const;

/** Coarse report-level status. Mirrors the harness status one-for-one so a
 *  reviewer never has to reconcile two vocabularies. */
export type LearningLoopReportStatus = LearningLoopHarnessStatus;

/** Coarse review-priority bucket — a triage hint, NOT a directive. */
export type LearningLoopReportPriority =
  | "none"            // cold path — nothing to review.
  | "informational"   // success path — review at normal cadence.
  | "attention"       // partial path — something is empty / unmatched.
  | "urgent";         // safety_warning path — at least one invariant tripped.

/** Inputs to the report wrapper. */
export interface LearningLoopReportInputs {
  /** Harness inputs forwarded verbatim. Tests pin them explicitly. */
  harnessInputs?: LearningLoopHarnessInputs;

  /**
   * OPTIONAL injected run label (e.g. "phase2l-b-daily-2026-05-11"). When
   * omitted the report records `null` rather than reading the wall clock.
   * The label is purely informational metadata.
   */
  runLabel?: string;

  /**
   * OPTIONAL injected operator identifier. When omitted the report records
   * `null`. The operator field is purely informational metadata and does
   * NOT grant any authority.
   */
  operator?: string;

  /**
   * OPTIONAL injected source identifier (e.g. "manual:repl",
   * "test:phase2l-b"). Defaults to `"manual"`. The source field is purely
   * informational metadata and is not interpreted by any runtime path.
   */
  source?: string;
}

/** Per-stage success metric block, mirrored from the harness. */
export interface LearningLoopReportMetrics {
  reflectionCandidateCount:            number;
  reflectionMissingSourceWarningCount: number;
  qualityScore:                        number;
  qualityBand:                         string;
  proposedLessonCount:                 number;
  approvalDecisionCount:               number;
  approvalRefusalCount:                number;
  hypothesisSuggestionCount:           number;
  hypothesisIneligibleCount:           number;
  unmatchedDecisionCount:              number;
  safetyInvariantsHeld:                boolean;
}

/** Per-stage safety invariant table, mirrored from the harness. */
export interface LearningLoopReportSafety {
  reflectionCandidatesProposeOnly:   boolean;
  qualityScoreAdvisoryOnly:          boolean;
  proposedLessonsProposeOnly:        boolean;
  approvalRecordsRuntimeInactive:    boolean;
  suggestionsSuggestionOnly:         boolean;
  allInvariantsHeld:                 boolean;
}

/** Echo of the harness inputs at a coarse summary level — non-secret,
 *  deterministic, and never the raw evidence body. */
export interface LearningLoopReportInputsSummary {
  /** Did the caller pin a `now` value? */
  nowProvided:               boolean;
  /** Did the caller inject any evidence (history / audit / readiness /
   *  riskImpact / candidateSetOverride)? */
  evidenceInjected:          boolean;
  /** Number of operator decisions the caller supplied. */
  operatorDecisionCount:     number;
  /** Did the caller supply a hypothesis context? */
  hypothesisContextProvided: boolean;
}

/** Short, machine-readable code attached to every blocker / warning so a
 *  test can assert on exact codes without string-matching prose. */
export type LearningLoopReportSignalCode =
  | "safety_invariant_violation"
  | "no_proposed_lessons"
  | "unmatched_operator_decisions"
  | "approval_refusals"
  | "no_suggestions_for_provided_context"
  | "low_quality_band"
  | "missing_source_channels"
  | "cold_run_no_positive_evidence";

/** A blocker is something a reviewer must resolve before calling a run
 *  successful. A warning is informational. The wrapper never raises a
 *  blocker about cold runs — cold ≠ failure. */
export interface LearningLoopReportSignal {
  code:     LearningLoopReportSignalCode;
  message:  string;
}

/** The full report payload. */
export interface LearningLoopReport {
  schemaVersion:    typeof LEARNING_LOOP_REPORT_SCHEMA_VERSION;
  label:            typeof LEARNING_LOOP_REPORT_LABEL;

  /** Caller-injected run label. `null` when none was passed. */
  runLabel:         string | null;
  /** Caller-injected operator identifier. `null` when none was passed. */
  operator:         string | null;
  /** Caller-injected source identifier. Defaults to `"manual"`. */
  source:           string;
  /** Caller-injected ISO timestamp from `harnessInputs.now`. `null` when
   *  no `now` was passed — the report NEVER reads the wall clock. */
  generatedAt:      string | null;

  /** Coarse report-level status. Mirrors the harness verbatim. */
  overallStatus:    LearningLoopReportStatus;
  /** Coarse triage priority derived from `overallStatus`. */
  priority:         LearningLoopReportPriority;

  /** Echo of the inputs at a coarse summary level. */
  inputsSummary:    LearningLoopReportInputsSummary;
  /** Per-stage success metrics. */
  metrics:          LearningLoopReportMetrics;
  /** Per-stage safety invariant table. */
  safety:           LearningLoopReportSafety;

  /** Things a reviewer must look at before calling this run successful. */
  blockers:         readonly LearningLoopReportSignal[];
  /** Informational signals. Never block a "success" classification. */
  warnings:         readonly LearningLoopReportSignal[];

  /** Verbatim, frozen safety disclaimer block. */
  safetyDisclaimer: readonly string[];

  /** The full underlying harness result, embedded verbatim. Consumers
   *  that want the raw stage outputs (candidate set, lesson table, etc.)
   *  read this field — the report itself never re-derives anything. */
  harnessResult:    LearningLoopHarnessResult;

  /** Static restatement of the read-only / propose-only contract. */
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
    /** The report is observational — it does NOT trigger or recommend
     *  behavior beyond what the underlying harness already proposes. */
    observationalOnly:         true;
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
  observationalOnly:         true,
} as const;

// ── Internal helpers ────────────────────────────────────────────────────────

function derivePriority(status: LearningLoopReportStatus): LearningLoopReportPriority {
  switch (status) {
    case "safety_warning": return "urgent";
    case "partial":        return "attention";
    case "success":        return "informational";
    case "cold":           return "none";
  }
}

function summariseInputs(
  inputs: LearningLoopHarnessInputs | undefined,
): LearningLoopReportInputsSummary {
  const i = inputs ?? {};
  const evidenceInjected =
    i.history             !== undefined ||
    i.auditExport         !== undefined ||
    i.readiness           !== undefined ||
    i.riskImpact          !== undefined ||
    i.candidateSetOverride !== undefined;
  const operatorDecisionCount = Array.isArray(i.operatorDecisions)
    ? i.operatorDecisions.length
    : 0;
  return {
    nowProvided:               i.now !== undefined,
    evidenceInjected,
    operatorDecisionCount,
    hypothesisContextProvided: i.hypothesisContext !== undefined,
  };
}

function buildSignals(
  harness: LearningLoopHarnessResult,
  inputsSummary: LearningLoopReportInputsSummary,
): { blockers: LearningLoopReportSignal[]; warnings: LearningLoopReportSignal[] } {
  const blockers: LearningLoopReportSignal[] = [];
  const warnings: LearningLoopReportSignal[] = [];

  // Safety violation — always a blocker, never a warning.
  if (!harness.safety.allInvariantsHeld) {
    const violatedStages: string[] = [];
    if (!harness.safety.reflectionCandidatesProposeOnly) violatedStages.push("reflectionCandidates");
    if (!harness.safety.qualityScoreAdvisoryOnly)        violatedStages.push("qualityScore");
    if (!harness.safety.proposedLessonsProposeOnly)      violatedStages.push("proposedLessons");
    if (!harness.safety.approvalRecordsRuntimeInactive)  violatedStages.push("approvalRecords");
    if (!harness.safety.suggestionsSuggestionOnly)       violatedStages.push("suggestions");
    blockers.push({
      code:    "safety_invariant_violation",
      message: `Safety invariant tripped on stage(s): ${violatedStages.join(", ")}`,
    });
  }

  // Unmatched decisions — always a blocker when present.
  if (harness.metrics.unmatchedDecisionCount > 0) {
    blockers.push({
      code:    "unmatched_operator_decisions",
      message: `${harness.metrics.unmatchedDecisionCount} operator decision(s) did not match any proposed lesson`,
    });
  }

  // Approval refusals — always a blocker when present.
  if (harness.metrics.approvalRefusalCount > 0) {
    blockers.push({
      code:    "approval_refusals",
      message: `${harness.metrics.approvalRefusalCount} approval decision(s) were refused at the record stage`,
    });
  }

  // No proposed lessons WHEN evidence is present (cold path is handled
  // separately as an informational warning, not a blocker).
  if (
    harness.overallStatus !== "cold" &&
    harness.metrics.proposedLessonCount === 0
  ) {
    blockers.push({
      code:    "no_proposed_lessons",
      message: "Harness saw evidence but produced no proposed lessons",
    });
  }

  // Hypothesis context provided but no suggestions emitted — blocker.
  if (
    inputsSummary.hypothesisContextProvided &&
    harness.metrics.hypothesisSuggestionCount === 0 &&
    harness.overallStatus !== "cold"
  ) {
    blockers.push({
      code:    "no_suggestions_for_provided_context",
      message: "Hypothesis context provided but no suggestions were emitted",
    });
  }

  // Cold run — informational warning ONLY, never a blocker.
  if (harness.overallStatus === "cold") {
    warnings.push({
      code:    "cold_run_no_positive_evidence",
      message: "Harness reported cold: no positive evidence / decisions / context were supplied",
    });
  }

  // Low quality band — informational warning.
  if (
    harness.qualityScore.qualityBand === "cold" ||
    harness.qualityScore.qualityBand === "low"
  ) {
    if (harness.overallStatus !== "cold") {
      warnings.push({
        code:    "low_quality_band",
        message: `Quality band is ${harness.qualityScore.qualityBand}; review evidence completeness`,
      });
    }
  }

  // Missing source channels — informational warning when populated.
  if (harness.metrics.reflectionMissingSourceWarningCount > 0) {
    warnings.push({
      code:    "missing_source_channels",
      message: `${harness.metrics.reflectionMissingSourceWarningCount} reflection source channel(s) were missing`,
    });
  }

  return { blockers, warnings };
}

// ── Public report builder ───────────────────────────────────────────────────

/**
 * Build a deterministic manual learning-loop report by running the Phase
 * 2l-a harness verbatim and shaping its output.
 *
 * Pure: no I/O write, no DB write, no env mutation, no scheduler signal,
 * no wall-clock read (callers MUST pin `harnessInputs.now` for
 * byte-identical output).
 *
 * Programmer-shaped misuse (non-object input) throws a TypeError so a
 * typo fails loudly.
 */
export function buildLearningLoopReport(
  inputs: LearningLoopReportInputs = {},
): LearningLoopReport {
  if (inputs === null || typeof inputs !== "object") {
    throw new TypeError("buildLearningLoopReport: inputs must be an object");
  }

  const harnessInputs = inputs.harnessInputs ?? {};
  if (harnessInputs === null || typeof harnessInputs !== "object") {
    throw new TypeError("buildLearningLoopReport: harnessInputs must be an object");
  }

  const harnessResult = runLearningLoopHarness(harnessInputs);

  const runLabel = typeof inputs.runLabel === "string" && inputs.runLabel.length > 0
    ? inputs.runLabel
    : null;
  const operator = typeof inputs.operator === "string" && inputs.operator.length > 0
    ? inputs.operator
    : null;
  const source = typeof inputs.source === "string" && inputs.source.length > 0
    ? inputs.source
    : "manual";

  const inputsSummary = summariseInputs(harnessInputs);
  const { blockers, warnings } = buildSignals(harnessResult, inputsSummary);

  const metrics: LearningLoopReportMetrics = {
    reflectionCandidateCount:            harnessResult.metrics.reflectionCandidateCount,
    reflectionMissingSourceWarningCount: harnessResult.metrics.reflectionMissingSourceWarningCount,
    qualityScore:                        harnessResult.metrics.qualityScore,
    qualityBand:                         harnessResult.metrics.qualityBand,
    proposedLessonCount:                 harnessResult.metrics.proposedLessonCount,
    approvalDecisionCount:               harnessResult.metrics.approvalDecisionCount,
    approvalRefusalCount:                harnessResult.metrics.approvalRefusalCount,
    hypothesisSuggestionCount:           harnessResult.metrics.hypothesisSuggestionCount,
    hypothesisIneligibleCount:           harnessResult.metrics.hypothesisIneligibleCount,
    unmatchedDecisionCount:              harnessResult.metrics.unmatchedDecisionCount,
    safetyInvariantsHeld:                harnessResult.metrics.safetyInvariantsHeld,
  };

  const safety: LearningLoopReportSafety = {
    reflectionCandidatesProposeOnly: harnessResult.safety.reflectionCandidatesProposeOnly,
    qualityScoreAdvisoryOnly:        harnessResult.safety.qualityScoreAdvisoryOnly,
    proposedLessonsProposeOnly:      harnessResult.safety.proposedLessonsProposeOnly,
    approvalRecordsRuntimeInactive:  harnessResult.safety.approvalRecordsRuntimeInactive,
    suggestionsSuggestionOnly:       harnessResult.safety.suggestionsSuggestionOnly,
    allInvariantsHeld:               harnessResult.safety.allInvariantsHeld,
  };

  return {
    schemaVersion:    LEARNING_LOOP_REPORT_SCHEMA_VERSION,
    label:            LEARNING_LOOP_REPORT_LABEL,
    runLabel,
    operator,
    source,
    generatedAt:      harnessResult.generatedAt,
    overallStatus:    harnessResult.overallStatus,
    priority:         derivePriority(harnessResult.overallStatus),
    inputsSummary,
    metrics,
    safety,
    blockers,
    warnings,
    safetyDisclaimer: [...LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER],
    harnessResult,
    invariants:       { ...FIXED_INVARIANTS },
  };
}

/**
 * Stable, deterministic JSON serializer for the report. Walks the payload
 * with a fixed key order so the resulting string is byte-identical across
 * calls with equal inputs. Mirrors the serializer pattern used by every
 * other Phase 2j/2k/2l-a helper.
 *
 * The embedded `harnessResult` is serialized via the Phase 2l-a serializer
 * so the report inherits the harness's stable key ordering for its
 * summary block. The full raw harness payload is NOT inlined into the
 * serialized string — only its byte-stable summary — so the report's
 * serialized form stays small while remaining a faithful summary.
 */
export function serializeLearningLoopReport(
  report: LearningLoopReport,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedBlockers = report.blockers.map(s => ({
    code:    s.code,
    message: s.message,
  }));
  const orderedWarnings = report.warnings.map(s => ({
    code:    s.code,
    message: s.message,
  }));

  // Re-use the Phase 2l-a serializer for the embedded harness summary so
  // both modules share one source of truth for byte ordering.
  const harnessSummaryJson = serializeLearningLoopHarnessResult(report.harnessResult);

  const ordered = {
    schemaVersion: report.schemaVersion,
    label:         report.label,
    runLabel:      report.runLabel,
    operator:      report.operator,
    source:        report.source,
    generatedAt:   report.generatedAt,
    overallStatus: report.overallStatus,
    priority:      report.priority,
    inputsSummary: {
      nowProvided:               report.inputsSummary.nowProvided,
      evidenceInjected:          report.inputsSummary.evidenceInjected,
      operatorDecisionCount:     report.inputsSummary.operatorDecisionCount,
      hypothesisContextProvided: report.inputsSummary.hypothesisContextProvided,
    },
    metrics: {
      reflectionCandidateCount:            report.metrics.reflectionCandidateCount,
      reflectionMissingSourceWarningCount: report.metrics.reflectionMissingSourceWarningCount,
      qualityScore:                        report.metrics.qualityScore,
      qualityBand:                         report.metrics.qualityBand,
      proposedLessonCount:                 report.metrics.proposedLessonCount,
      approvalDecisionCount:               report.metrics.approvalDecisionCount,
      approvalRefusalCount:                report.metrics.approvalRefusalCount,
      hypothesisSuggestionCount:           report.metrics.hypothesisSuggestionCount,
      hypothesisIneligibleCount:           report.metrics.hypothesisIneligibleCount,
      unmatchedDecisionCount:              report.metrics.unmatchedDecisionCount,
      safetyInvariantsHeld:                report.metrics.safetyInvariantsHeld,
    },
    safety: {
      reflectionCandidatesProposeOnly: report.safety.reflectionCandidatesProposeOnly,
      qualityScoreAdvisoryOnly:        report.safety.qualityScoreAdvisoryOnly,
      proposedLessonsProposeOnly:      report.safety.proposedLessonsProposeOnly,
      approvalRecordsRuntimeInactive:  report.safety.approvalRecordsRuntimeInactive,
      suggestionsSuggestionOnly:       report.safety.suggestionsSuggestionOnly,
      allInvariantsHeld:               report.safety.allInvariantsHeld,
    },
    blockers:         orderedBlockers,
    warnings:         orderedWarnings,
    safetyDisclaimer: [...report.safetyDisclaimer],
    harnessSummary:   JSON.parse(harnessSummaryJson),
    invariants: {
      readOnly:                  report.invariants.readOnly,
      proposeOnly:               report.invariants.proposeOnly,
      suggestionOnly:            report.invariants.suggestionOnly,
      nonWidening:               report.invariants.nonWidening,
      autoApplyEligible:         report.invariants.autoApplyEligible,
      publicAction:              report.invariants.publicAction,
      schedulerDriven:           report.invariants.schedulerDriven,
      mutating:                  report.invariants.mutating,
      humanReviewRequired:       report.invariants.humanReviewRequired,
      runtimeActionEligible:     report.invariants.runtimeActionEligible,
      publicActionEligible:      report.invariants.publicActionEligible,
      manualReviewedOnly:        report.invariants.manualReviewedOnly,
      testOnly:                  report.invariants.testOnly,
      observationalOnly:         report.invariants.observationalOnly,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}

// Re-exports for tests / future REPL scripts that want to construct
// operator decisions or hypothesis contexts without reaching into the
// harness module directly.
export type {
  LearningLoopHarnessOperatorDecision as LearningLoopReportOperatorDecision,
  LessonSuggestionHypothesisContext as LearningLoopReportHypothesisContext,
};
