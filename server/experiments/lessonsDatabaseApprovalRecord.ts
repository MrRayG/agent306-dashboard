/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2k-b: MANUAL LESSON APPROVAL RECORDS (PROPOSE-ONLY → APPROVED)
 *
 * Phase 2k-a (`lessonsDatabaseSchema.ts`) shipped a pure, deterministic
 * projection that re-shapes a Phase 2j-a meta-reflection candidate set into
 * proposed *lesson records*. Every emitted lesson there carries
 * `status: "proposed"`, `active: false`, `autoApplyEligible: false`,
 * `applyEligibility: "none"`, and `humanReviewRequired: true`. The status
 * enum reserves `approved` / `rejected` / `retired`, but Phase 2k-a only
 * ever emitted `proposed` rows and intentionally did NOT include a status
 * transition helper.
 *
 * Phase 2k-b is the first explicit human-in-the-loop record path. It adds a
 * pure helper module that turns a *proposed* lesson record into an
 * *approval/decision record* — `approved`, `rejected`, or `retired` — but
 * ONLY when an explicit operator approval input is supplied at the call
 * site. Missing or empty approval input produces a safe refusal value,
 * never an approved record.
 *
 * Phase 2k-b is intentionally:
 *   - MANUAL-ONLY: there is exactly one public entry point —
 *     `recordLessonApproval(input)` — and it requires the caller to supply
 *     a non-empty `operator`, a `decision`, a non-empty `rationale`, and
 *     a pinned `decidedAt` timestamp. There is no scheduler, no app-boot
 *     hook, no monitor read, no UI button wired to this helper in this PR.
 *   - PROPOSE-ONLY-AT-RUNTIME: even when the decision is `approved`, the
 *     emitted lesson row keeps `active: false`, `autoApplyEligible: false`,
 *     `applyEligibility: "none"`, `humanReviewRequired: true`, and the
 *     full Phase 2k-a invariants. Approved lessons are *reviewed* lessons,
 *     not *active* lessons. New invariants (`runtimeActionEligible: false`,
 *     `publicActionEligible: false`) restate this contract at the
 *     decision-record level.
 *   - PURE: no file is opened, no JSONL is parsed, no DB is touched, no
 *     in-memory map is mutated, no env var is set, no scheduler is signalled.
 *     `recordLessonApproval` is a referentially-transparent function over
 *     its inputs.
 *   - DETERMINISTIC: decision IDs are stable sha256 hashes derived from the
 *     source lesson id, the decision, the operator, the rationale, and the
 *     injected `decidedAt`. Same inputs → same id. `decidedAt` is REQUIRED
 *     and must be ISO-8601 or a `Date`; the helper NEVER reads the wall
 *     clock.
 *   - SOURCE-PRESERVING: the resulting `LessonApprovalRecord` carries a
 *     `sourceLesson` block (the Phase 2k-a lesson id + status + candidate
 *     ref + evidence refs) so an auditor can resolve back to the originating
 *     reflection candidate without re-deriving anything.
 *   - NON-WIDENING: a decision MUST refer to an existing proposed lesson
 *     (`source.status === "proposed"`). Re-approving an already-approved
 *     lesson is REFUSED — every approved/rejected/retired record is derived
 *     exactly once from a `proposed` row. The helper never enables a
 *     sandbox kind, never registers a kind, never mutates a fixture.
 *     Disabled kinds remain disabled.
 *   - NO PROMOTION GATE BYPASS: approved lessons are NOT inputs to
 *     `applyRecommendation`, `canPromote`, the recommendation engine, the
 *     hypothesis creation flow, or any runtime behavior. Search this PR:
 *     `lessonsDatabaseApprovalRecord` is referenced ONLY by this module and
 *     its tests. It is not imported by `server/index.ts`, by the autonomy
 *     monitor, by `applyRecommendation`, by `canPromote`, by the scheduler,
 *     by any UI control.
 *   - SAFE REFUSAL: missing/empty operator/rationale/decidedAt, or a source
 *     lesson whose status is not `proposed`, returns a structured refusal
 *     record (`ok: false`, machine-readable `reason`). The helper does not
 *     throw on these cases — but it does throw on programmer-shaped misuse
 *     (non-object inputs, illegal decision values) so a typo fails loudly.
 *   - REJECTED / RETIRED REMAIN INACTIVE: the helper also supports
 *     `decision: "rejected"` and `decision: "retired"` — both produce
 *     decision records that keep the inactive/non-actionable invariants.
 *     Rejected/retired are recorded so the audit trail is complete, never
 *     to enable behavior.
 *
 * Tests pin:
 *   - approved/rejected/retired records can ONLY be produced from a
 *     `proposed` source lesson and ONLY when explicit operator/rationale/
 *     decidedAt are supplied;
 *   - approved records are still `active: false`, `autoApplyEligible: false`,
 *     `applyEligibility: "none"`, `runtimeActionEligible: false`,
 *     `publicActionEligible: false`;
 *   - deterministic ids and byte-identical serialization across repeated
 *     calls with equal inputs;
 *   - no Date.now usage, no Math.random, no UUID, no env reads, no fs/db
 *     mutation, real data fixtures byte-identical after the run;
 *   - missing/empty operator/rationale/decidedAt return safe refusal,
 *     never an approved record;
 *   - disabled sandbox kinds cannot become enabled / registerable /
 *     actionable through an approval record;
 *   - `lessonsDatabaseApprovalRecord` is not imported by runtime/monitor/
 *     scheduler/apply-promote files.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from "node:crypto";

import {
  type LessonRow,
  type LessonStatus,
  type LessonApplyEligibility,
  type LessonEvidenceRef,
  type LessonCandidateRef,
  LESSONS_DATABASE_SCHEMA_VERSION,
} from "./lessonsDatabaseSchema.js";

/** Stable schema identifier for the approval-record table. */
export const LESSON_APPROVAL_RECORD_SCHEMA_VERSION = "phase2k-b.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const LESSON_APPROVAL_RECORD_LABEL = "agent306.lesson_approval_record";

/** Closed set of decisions a human reviewer can record against a proposed
 *  lesson. Mirrors the `LessonStatus` enum minus `proposed` (the input). */
export type LessonApprovalDecision = "approved" | "rejected" | "retired";

const ALLOWED_DECISIONS: ReadonlySet<LessonApprovalDecision> = new Set([
  "approved",
  "rejected",
  "retired",
]);

/** Closed set of machine-readable refusal reasons. */
export type LessonApprovalRefusalReason =
  | "missing_source_lesson"
  | "source_lesson_not_proposed"
  | "missing_operator"
  | "missing_rationale"
  | "missing_decided_at"
  | "invalid_decided_at"
  | "invalid_decision";

/** Static, restated invariants for an approval *record*. Mirrors the
 *  Phase 2k-a row-level invariants but adds the two extra non-actionable
 *  fields required by Phase 2k-b. */
export interface LessonApprovalRecordInvariants {
  readOnly:                true;
  proposeOnly:             true;
  nonWidening:             true;
  active:                  false;
  autoApplyEligible:       false;
  publicAction:            false;
  schedulerDriven:         false;
  mutating:                false;
  humanReviewRequired:     true;
  runtimeActionEligible:   false;
  publicActionEligible:    false;
  manualReviewedOnly:      true;
}

const FIXED_RECORD_INVARIANTS: LessonApprovalRecordInvariants = {
  readOnly:                true,
  proposeOnly:             true,
  nonWidening:             true,
  active:                  false,
  autoApplyEligible:       false,
  publicAction:            false,
  schedulerDriven:         false,
  mutating:                false,
  humanReviewRequired:     true,
  runtimeActionEligible:   false,
  publicActionEligible:    false,
  manualReviewedOnly:      true,
};

/** A frozen snapshot of the source lesson — enough to audit the decision
 *  without re-deriving anything. */
export interface LessonApprovalSourceLesson {
  lessonId:        string;
  schemaVersion:   typeof LESSONS_DATABASE_SCHEMA_VERSION;
  status:          LessonStatus;
  scope:           string;
  subsystem:       string;
  reasonCode:      string;
  candidateRef:    LessonCandidateRef;
  evidenceRefs:    readonly LessonEvidenceRef[];
}

/** The "after" lesson row produced by approval — keeps every Phase 2k-a
 *  inactive/non-actionable invariant. The only differences from the input
 *  proposed row are the `status` and the inclusion of the decision audit
 *  block. */
export interface LessonApprovalLessonRow {
  lessonId:                string;
  schemaVersion:           typeof LESSONS_DATABASE_SCHEMA_VERSION;
  status:                  Exclude<LessonStatus, "proposed">;
  active:                  false;
  autoApplyEligible:       false;
  applyEligibility:        LessonApplyEligibility;
  humanReviewRequired:     true;
  /** Extra Phase 2k-b invariants restated at the row level. */
  runtimeActionEligible:   false;
  publicActionEligible:    false;
  manualReviewedOnly:      true;
}

/** Audit metadata captured at approval time. */
export interface LessonApprovalAuditMetadata {
  operator:        string;
  source:          "manual";
  decision:        LessonApprovalDecision;
  decidedAt:       string;
  rationale:       string;
  /** Echo of the originating reflection candidate id (passed through from
   *  the source lesson) — lets an auditor resolve back to the candidate
   *  without re-running the projection. */
  sourceCandidateId:     string;
  /** Verbatim evidence refs from the source lesson. */
  sourceEvidenceRefs:    readonly LessonEvidenceRef[];
  /** Records what the lesson was before the decision and what it is now. */
  statusTransition: {
    from: "proposed";
    to:   LessonApprovalDecision;
  };
}

/** A complete approval-decision record. */
export interface LessonApprovalRecord {
  ok:              true;
  decisionId:      string;
  schemaVersion:   typeof LESSON_APPROVAL_RECORD_SCHEMA_VERSION;
  label:           typeof LESSON_APPROVAL_RECORD_LABEL;
  decision:        LessonApprovalDecision;
  sourceLesson:    LessonApprovalSourceLesson;
  lesson:          LessonApprovalLessonRow;
  audit:           LessonApprovalAuditMetadata;
  invariants:      LessonApprovalRecordInvariants;
}

/** A safe refusal returned for missing/invalid inputs. Never throws. */
export interface LessonApprovalRefusal {
  ok:              false;
  reason:          LessonApprovalRefusalReason;
  /** Stable, deterministic human-readable explanation. */
  message:         string;
  schemaVersion:   typeof LESSON_APPROVAL_RECORD_SCHEMA_VERSION;
  label:           typeof LESSON_APPROVAL_RECORD_LABEL;
}

export type LessonApprovalResult = LessonApprovalRecord | LessonApprovalRefusal;

/** Inputs to the approval helper. */
export interface LessonApprovalInputs {
  sourceLesson:    LessonRow;
  decision:        LessonApprovalDecision;
  operator:        string;
  rationale:       string;
  /** REQUIRED. The helper never reads the wall clock — callers MUST pin
   *  this. Accepts a `Date` or an ISO-8601 string. */
  decidedAt:       Date | string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function stableDecisionId(parts: readonly string[]): string {
  const h = crypto.createHash("sha256");
  h.update("agent306|lessonApprovalRecord|v1\n");
  for (const p of parts) {
    h.update(String(p));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

function normaliseDecidedAt(value: Date | string): string | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

function refuse(
  reason: LessonApprovalRefusalReason,
  message: string,
): LessonApprovalRefusal {
  return {
    ok:            false,
    reason,
    message,
    schemaVersion: LESSON_APPROVAL_RECORD_SCHEMA_VERSION,
    label:         LESSON_APPROVAL_RECORD_LABEL,
  };
}

// ── Public helper ───────────────────────────────────────────────────────────

/**
 * Record a manual approval/rejection/retirement decision against a *proposed*
 * Phase 2k-a lesson row.
 *
 * Returns a structured `LessonApprovalRecord` on success or a structured
 * `LessonApprovalRefusal` for the documented refusal reasons. Throws only
 * on programmer-shaped misuse (non-object input, unknown decision value)
 * so a typo fails loudly.
 *
 * This helper is PURE: no I/O, no env read, no wall-clock read, no
 * scheduler signal. Caller MUST pin `decidedAt`.
 */
export function recordLessonApproval(input: LessonApprovalInputs): LessonApprovalResult {
  if (input === null || typeof input !== "object") {
    throw new TypeError("recordLessonApproval: input must be an object");
  }

  // Decision must be one of the allowed values. A typo'd decision is a
  // programmer error (caller's switch is broken), not a refusal.
  if (typeof input.decision !== "string" || !ALLOWED_DECISIONS.has(input.decision as LessonApprovalDecision)) {
    throw new TypeError(
      `recordLessonApproval: invalid decision ${JSON.stringify(input.decision)}; ` +
      `expected one of approved|rejected|retired`,
    );
  }

  const source = input.sourceLesson;
  if (source === null || typeof source !== "object") {
    return refuse(
      "missing_source_lesson",
      "recordLessonApproval requires a source lesson row (Phase 2k-a)",
    );
  }

  // Defence in depth: we ONLY transition `proposed` rows. Anything else
  // (approved/rejected/retired already, or an unknown status) refuses.
  if (source.status !== "proposed") {
    return refuse(
      "source_lesson_not_proposed",
      `source lesson ${source.lessonId} has status ${source.status}; ` +
      `only proposed lessons can be approved/rejected/retired`,
    );
  }

  const operator = typeof input.operator === "string" ? input.operator.trim() : "";
  if (operator.length === 0) {
    return refuse(
      "missing_operator",
      "recordLessonApproval requires a non-empty operator identifier",
    );
  }

  const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
  if (rationale.length === 0) {
    return refuse(
      "missing_rationale",
      "recordLessonApproval requires a non-empty rationale",
    );
  }

  // Caller MUST pin decidedAt — the helper never reads the wall clock.
  if (input.decidedAt === undefined || input.decidedAt === null) {
    return refuse(
      "missing_decided_at",
      "recordLessonApproval requires an explicit decidedAt (Date or ISO-8601 string)",
    );
  }
  const decidedAt = normaliseDecidedAt(input.decidedAt);
  if (decidedAt === null) {
    return refuse(
      "invalid_decided_at",
      `recordLessonApproval could not parse decidedAt ${JSON.stringify(input.decidedAt)}`,
    );
  }

  const decision: LessonApprovalDecision = input.decision as LessonApprovalDecision;

  // Stable, deterministic decision id — derived from inputs only.
  const evidenceKey = source.evidenceRefs
    .map(r => `${r.source}:${r.ref}:${r.detail ?? ""}`)
    .join("|");
  const decisionId = stableDecisionId([
    source.lessonId,
    source.candidateRef.candidateId,
    decision,
    operator,
    rationale,
    decidedAt,
    evidenceKey,
  ]);

  const sourceLesson: LessonApprovalSourceLesson = {
    lessonId:      source.lessonId,
    schemaVersion: source.schemaVersion,
    status:        source.status,
    scope:         source.scope,
    subsystem:     source.subsystem,
    reasonCode:    source.reasonCode,
    candidateRef: {
      candidateId:   source.candidateRef.candidateId,
      schemaVersion: source.candidateRef.schemaVersion,
    },
    evidenceRefs:  source.evidenceRefs,
  };

  const lesson: LessonApprovalLessonRow = {
    lessonId:              source.lessonId,
    schemaVersion:         source.schemaVersion,
    status:                decision,
    active:                false,
    autoApplyEligible:     false,
    applyEligibility:      "none",
    humanReviewRequired:   true,
    runtimeActionEligible: false,
    publicActionEligible:  false,
    manualReviewedOnly:    true,
  };

  const audit: LessonApprovalAuditMetadata = {
    operator,
    source:               "manual",
    decision,
    decidedAt,
    rationale,
    sourceCandidateId:    source.candidateRef.candidateId,
    sourceEvidenceRefs:   source.evidenceRefs,
    statusTransition: {
      from: "proposed",
      to:   decision,
    },
  };

  return {
    ok:            true,
    decisionId,
    schemaVersion: LESSON_APPROVAL_RECORD_SCHEMA_VERSION,
    label:         LESSON_APPROVAL_RECORD_LABEL,
    decision,
    sourceLesson,
    lesson,
    audit,
    invariants:    { ...FIXED_RECORD_INVARIANTS },
  };
}

/**
 * Stable, deterministic JSON serializer for an approval result. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern from
 * `lessonsDatabaseSchema.ts`.
 */
export function serializeLessonApprovalResult(
  result: LessonApprovalResult,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  let ordered: Record<string, unknown>;
  if (result.ok === false) {
    ordered = {
      ok:            false,
      reason:        result.reason,
      message:       result.message,
      schemaVersion: result.schemaVersion,
      label:         result.label,
    };
  } else {
    ordered = {
      ok:            true,
      decisionId:    result.decisionId,
      schemaVersion: result.schemaVersion,
      label:         result.label,
      decision:      result.decision,
      sourceLesson: {
        lessonId:      result.sourceLesson.lessonId,
        schemaVersion: result.sourceLesson.schemaVersion,
        status:        result.sourceLesson.status,
        scope:         result.sourceLesson.scope,
        subsystem:     result.sourceLesson.subsystem,
        reasonCode:    result.sourceLesson.reasonCode,
        candidateRef: {
          candidateId:   result.sourceLesson.candidateRef.candidateId,
          schemaVersion: result.sourceLesson.candidateRef.schemaVersion,
        },
        evidenceRefs:  result.sourceLesson.evidenceRefs.map(r => ({
          source: r.source,
          ref:    r.ref,
          ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
        })),
      },
      lesson: {
        lessonId:              result.lesson.lessonId,
        schemaVersion:         result.lesson.schemaVersion,
        status:                result.lesson.status,
        active:                result.lesson.active,
        autoApplyEligible:     result.lesson.autoApplyEligible,
        applyEligibility:      result.lesson.applyEligibility,
        humanReviewRequired:   result.lesson.humanReviewRequired,
        runtimeActionEligible: result.lesson.runtimeActionEligible,
        publicActionEligible:  result.lesson.publicActionEligible,
        manualReviewedOnly:    result.lesson.manualReviewedOnly,
      },
      audit: {
        operator:           result.audit.operator,
        source:             result.audit.source,
        decision:           result.audit.decision,
        decidedAt:          result.audit.decidedAt,
        rationale:          result.audit.rationale,
        sourceCandidateId:  result.audit.sourceCandidateId,
        sourceEvidenceRefs: result.audit.sourceEvidenceRefs.map(r => ({
          source: r.source,
          ref:    r.ref,
          ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
        })),
        statusTransition: {
          from: result.audit.statusTransition.from,
          to:   result.audit.statusTransition.to,
        },
      },
      invariants: {
        readOnly:              result.invariants.readOnly,
        proposeOnly:           result.invariants.proposeOnly,
        nonWidening:           result.invariants.nonWidening,
        active:                result.invariants.active,
        autoApplyEligible:     result.invariants.autoApplyEligible,
        publicAction:          result.invariants.publicAction,
        schedulerDriven:       result.invariants.schedulerDriven,
        mutating:              result.invariants.mutating,
        humanReviewRequired:   result.invariants.humanReviewRequired,
        runtimeActionEligible: result.invariants.runtimeActionEligible,
        publicActionEligible:  result.invariants.publicActionEligible,
        manualReviewedOnly:    result.invariants.manualReviewedOnly,
      },
    };
  }

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
