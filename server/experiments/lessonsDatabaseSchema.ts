/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2k-a: LESSONS DATABASE SCHEMA (READ-ONLY, PROPOSED-ONLY)
 *
 * Phase 2j-a shipped a pure meta-reflection candidate schema/projection
 * (`buildMetaReflectionCandidateSet`). Phase 2j-b added a thin live generator
 * (`buildMetaReflectionLiveReport`) that surfaced candidates on the autonomy
 * monitor. Phase 2j-c added a deterministic, advisory quality score over the
 * live report. None of those PRs opened an apply path: every emitted
 * candidate carries `humanReviewRequired: true` and `autoApplyEligible: false`.
 *
 * Phase 2k-a takes the first narrow step toward a human-reviewed lessons
 * database: a pure schema/projection that re-shapes a Phase 2j-a candidate
 * set into proposed *lesson records*. A lesson record is the canonical
 * "lessons database row" shape — what a reviewer will eventually approve or
 * reject in a future Phase 2k-b/c. This PR is schema/model only; it does NOT
 * persist, register, activate, or apply anything.
 *
 * Phase 2k-a is intentionally:
 *   - PROPOSE-ONLY: every emitted lesson carries `status: "proposed"`,
 *     `active: false`, `autoApplyEligible: false`, `applyEligibility: "none"`,
 *     and `humanReviewRequired: true`. The supported status enum includes
 *     `approved`, `rejected`, and `retired` so a future PR can record human
 *     decisions, but the projection in this PR ONLY emits `proposed` rows.
 *     None of the other status values imply activation or apply eligibility.
 *   - READ-ONLY / PURE: no file is opened, no JSONL is parsed, no DB is
 *     touched, no in-memory map is mutated, no env var is set, no scheduler
 *     is signalled. The module accepts an already-built Phase 2j-a candidate
 *     set (the caller — test, REPL, future review script — constructs it)
 *     and returns an in-process value.
 *   - DETERMINISTIC: lesson IDs are stable sha256 hashes derived from the
 *     candidate id, reason code, subsystem, scope, and evidence refs. Same
 *     inputs always produce the same ids. Ordering is a fixed lexicographic
 *     sort on `(scope, lessonId)`. There is no `Date.now()`, no
 *     `Math.random()`, no UUID; `proposedAt` is `null` unless the caller
 *     pins it explicitly (and tests pin it).
 *   - NON-WIDENING: a lesson record cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. Every lesson restates the propose-only invariants.
 *     Disabled kinds remain disabled — lessons *about* disabled kinds
 *     describe their disabled state for human review; they never propose
 *     enabling them.
 *   - APPEND-ONLY-IN-SHAPE: the schema is structured so that, if a future
 *     PR adds persistence, it can be append-only and proposed-only. There
 *     is no `lessonId` reuse, no "update in place", no mutable field.
 *   - GRACEFUL ON EMPTY: empty / missing candidate set yields a well-typed
 *     empty lesson table with zero counts and `lessons: []`. Rendering
 *     NEVER throws.
 *   - REUSE-FIRST: this module never re-derives history / audit / readiness
 *     evidence. It re-projects an already-built Phase 2j-a candidate set
 *     into lesson rows. The Phase 2j-a invariants flow through verbatim
 *     onto every lesson.
 *   - NO PUBLIC OUTPUT: lessons are an in-process value. They are not
 *     posted, not written, not published, not scheduled. No UI control
 *     consumes them in this PR.
 *   - NOT WIRED TO RUNTIME: this module is not imported by `server/index.ts`,
 *     not imported by the autonomy monitor, not imported by any scheduler.
 *     It exists as a helper module that tests / future review scripts can
 *     call.
 *
 * The `meta_reflection` autonomy stage remains as it is today (Phase 2j-b/c
 * surface). Phase 2k-a is a lesson schema + projection helper only. Future
 * Phase 2k-b/c PRs may add a read-only lessons review surface and an
 * approval/reject status transition with strict guards; that is explicitly
 * out of scope here.
 *
 * Tests pin: populated lesson table shape, empty lesson table shape,
 * deterministic ordering, deterministic stable IDs, byte-identical
 * serialization across repeated calls, no filesystem / DB / env mutation,
 * disabled kinds remain disabled, every lesson is proposed/inactive/
 * non-actionable, alternative status values do not imply activation, the
 * single enabled sandbox kind (`summarizationTemplate`) is the only one
 * lessons can reference as enabled.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from "node:crypto";

import {
  type MetaReflectionCandidateSet,
  type MetaReflectionCandidate,
  type MetaReflectionEvidenceRef,
  type MetaReflectionConfidence,
  type MetaReflectionKind,
  type MetaReflectionReasonCode,
  type MetaReflectionSubsystem,
} from "./metaReflectionCandidateSchema.js";

/** Stable schema identifier for the lesson table. Bumped only when the
 *  lesson-row shape changes in a backwards-incompatible way. */
export const LESSONS_DATABASE_SCHEMA_VERSION = "phase2k-a.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const LESSONS_DATABASE_LABEL = "agent306.lessons_database";

/**
 * Closed set of lifecycle statuses for a lesson row.
 *
 *   - `proposed`  — emitted by this projection. Awaits human review. Inactive.
 *   - `approved`  — a human reviewer has approved the lesson for *reference*.
 *                   This status is RESERVED for a future PR. It MUST NOT
 *                   imply activation, application, or auto-apply eligibility.
 *   - `rejected`  — a human reviewer has rejected the lesson. Inactive.
 *                   Reserved for a future PR.
 *   - `retired`   — a previously-approved lesson has been retired by a human
 *                   reviewer. Inactive. Reserved for a future PR.
 *
 * Phase 2k-a only emits `proposed`. The enum is declared up-front so the
 * lesson row shape is stable across future Phase 2k PRs.
 */
export type LessonStatus = "proposed" | "approved" | "rejected" | "retired";

/**
 * Closed set of `applyEligibility` values. Phase 2k-a only emits `"none"`.
 * Future PRs MUST treat any value other than `"none"` as a request from a
 * human reviewer that still requires `canPromote(...)` to gate the
 * transition.
 */
export type LessonApplyEligibility = "none";

/** Coarse confidence buckets — mirrors the candidate schema's coarse buckets. */
export type LessonConfidence = MetaReflectionConfidence;

/** Source-of-lesson kind — mirrors the candidate `kind` vocabulary. A
 *  `question` candidate produces a `question` lesson; a `lesson` candidate
 *  produces a `lesson` lesson; etc. */
export type LessonKind = MetaReflectionKind;

/** Affected subsystem — mirrors the candidate schema. */
export type LessonSubsystem = MetaReflectionSubsystem;

/** Stable reference into the originating candidate set. Kept opaque on
 *  purpose so a future review surface can resolve back to the candidate. */
export interface LessonCandidateRef {
  /** Phase 2j-a candidate id (sha256-derived, 16 hex chars). */
  candidateId:   string;
  /** Phase 2j-a candidate set schema version, embedded so a future PR can
   *  refuse to consume rows it doesn't understand. */
  schemaVersion: string;
}

/** Source-evidence reference passed through verbatim from the candidate. */
export type LessonEvidenceRef = MetaReflectionEvidenceRef;

/**
 * Audit metadata block. `proposedAt` is `null` unless the caller pinned a
 * timestamp via `now` — the projection never reads the wall clock.
 * `proposedBy` defaults to the literal `"unspecified"`. The block is
 * append-only in spirit: future PRs may add `decidedAt` / `decidedBy` /
 * `retiredAt` / `retiredBy` fields, but Phase 2k-a only carries the
 * proposed-time fields.
 */
export interface LessonAuditMetadata {
  proposedAt: string | null;
  proposedBy: string;
  /** Source label so an audit can tell "this lesson came from the
   *  Phase 2j-a candidate set projection" vs "this came from a future
   *  manual review surface". Always `"phase2j-a-candidate-set"` in this PR. */
  sourceProjection: "phase2j-a-candidate-set";
}

/** Static, restated invariants — also restated on the lesson table itself
 *  for defence-in-depth. */
export interface LessonRowInvariants {
  readOnly:            true;
  proposeOnly:         true;
  nonWidening:         true;
  active:              false;
  autoApplyEligible:   false;
  publicAction:        false;
  schedulerDriven:     false;
  mutating:            false;
  humanReviewRequired: true;
}

/** A single proposed lesson record. Equivalent in shape to what a future
 *  lessons-database row will store. */
export interface LessonRow {
  /** Stable id — sha256(`${candidateId}|${reasonCode}|${subsystem}|${scope}|${refs...}`)
   *  truncated to 16 chars. Same inputs always produce the same id. */
  lessonId:            string;
  schemaVersion:       typeof LESSONS_DATABASE_SCHEMA_VERSION;
  status:              LessonStatus;
  /** Restated on every row — Phase 2k-a only emits `proposed`. */
  active:              false;
  autoApplyEligible:   false;
  applyEligibility:    LessonApplyEligibility;
  humanReviewRequired: true;
  kind:                LessonKind;
  /** Short, stable scope label (mirrors the candidate scope). */
  scope:               string;
  subsystem:           LessonSubsystem;
  reasonCode:          MetaReflectionReasonCode;
  /** Short, stable, human-readable title — passed through from the
   *  candidate. NEVER includes wall-clock timestamps. */
  title:               string;
  /** Longer, stable, human-readable body — passed through from the
   *  candidate. */
  body:                string;
  /** Coarse confidence bucket — passed through from the candidate. */
  confidence:          LessonConfidence;
  /** Coarse evidence-strength bucket — passed through from the candidate. */
  evidenceStrength:    LessonConfidence;
  /** Source candidate reference — lets a reviewer trace back to Phase 2j-a. */
  candidateRef:        LessonCandidateRef;
  /** Source evidence references — passed through verbatim. */
  evidenceRefs:        readonly LessonEvidenceRef[];
  audit:               LessonAuditMetadata;
  invariants:          LessonRowInvariants;
}

/** Aggregate counts over the emitted lesson table. */
export interface LessonTableAggregate {
  totalLessons:        number;
  byStatus: {
    proposed:          number;
    approved:          number;
    rejected:          number;
    retired:           number;
  };
  byKind: {
    lesson:            number;
    observation:       number;
    question:          number;
  };
  bySubsystem: {
    summarizationFixture:    number;
    registrationHistory:     number;
    registrationAuditExport: number;
    lowRiskSandboxReadiness: number;
    riskImpact:              number;
  };
  /** Always equals `totalLessons` in Phase 2k-a — restated for audit. */
  humanReviewRequired: number;
  /** Always 0. Restated for audit. */
  active:              number;
  /** Always 0. Restated for audit. */
  autoApplyEligible:   number;
}

/** The full read-only lesson table returned by the projection. */
export interface LessonTable {
  schemaVersion:    typeof LESSONS_DATABASE_SCHEMA_VERSION;
  label:            typeof LESSONS_DATABASE_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  the projection NEVER reads the wall clock. */
  generatedAt:      string | null;
  /** Caller-supplied label identifying the operator / script. Defaults
   *  to the literal `"unspecified"`. */
  generatedBy:      string;
  /** Whether the lesson table carries any rows. */
  isEmpty:          boolean;
  lessons:          readonly LessonRow[];
  aggregate:        LessonTableAggregate;
  /** Echo of which evidence channels were supplied to the upstream candidate
   *  set. Lets a reviewer see "no readiness snapshot was provided" vs
   *  "readiness was empty". */
  evidenceProvided: {
    history:        boolean;
    auditExport:    boolean;
    readiness:      boolean;
    riskImpact:     boolean;
  };
  /** Echo of the upstream candidate set's schema version so a future PR
   *  can refuse to consume rows it doesn't understand. */
  sourceCandidateSchemaVersion: string;
  /** Static restatement of the propose-only contract — also restated on
   *  every individual lesson for defence-in-depth. */
  invariants: {
    readOnly:            true;
    proposeOnly:         true;
    nonWidening:         true;
    active:              false;
    autoApplyEligible:   false;
    publicAction:        false;
    schedulerDriven:     false;
    mutating:            false;
    humanReviewRequired: true;
  };
}

/** Inputs to the projection. */
export interface LessonTableInputs {
  candidateSet:  MetaReflectionCandidateSet;
  now?:          Date | string;
  proposedBy?:   string;
  generatedBy?:  string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function stableLessonId(parts: readonly string[]): string {
  // sha256 truncated to 16 hex chars — deterministic and grep-able. Salt is
  // fixed so the id is reproducible across processes.
  const h = crypto.createHash("sha256");
  h.update("agent306|lessonsDatabase|v1\n");
  for (const p of parts) {
    h.update(String(p));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

const FIXED_ROW_INVARIANTS: LessonRowInvariants = {
  readOnly:            true,
  proposeOnly:         true,
  nonWidening:         true,
  active:              false,
  autoApplyEligible:   false,
  publicAction:        false,
  schedulerDriven:     false,
  mutating:            false,
  humanReviewRequired: true,
};

function normaliseGeneratedAt(now: Date | string | undefined): string | null {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.length > 0) {
    const parsed = new Date(now);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now;
  }
  return null;
}

function lessonRowFromCandidate(
  c: MetaReflectionCandidate,
  audit: LessonAuditMetadata,
  candidateSchemaVersion: string,
): LessonRow {
  const refKey = c.evidenceRefs
    .map(r => `${r.source}:${r.ref}:${r.detail ?? ""}`)
    .join("|");
  const lessonId = stableLessonId([
    c.candidateId,
    c.reasonCode,
    c.subsystem,
    c.scope,
    refKey,
  ]);
  return {
    lessonId,
    schemaVersion:       LESSONS_DATABASE_SCHEMA_VERSION,
    status:              "proposed",
    active:              false,
    autoApplyEligible:   false,
    applyEligibility:    "none",
    humanReviewRequired: true,
    kind:                c.kind,
    scope:               c.scope,
    subsystem:           c.subsystem,
    reasonCode:          c.reasonCode,
    title:               c.title,
    body:                c.body,
    confidence:          c.confidence,
    evidenceStrength:    c.evidenceStrength,
    candidateRef: {
      candidateId:   c.candidateId,
      schemaVersion: candidateSchemaVersion,
    },
    evidenceRefs:        c.evidenceRefs,
    audit,
    invariants:          { ...FIXED_ROW_INVARIANTS },
  };
}

function buildAggregate(lessons: readonly LessonRow[]): LessonTableAggregate {
  const byStatus = { proposed: 0, approved: 0, rejected: 0, retired: 0 };
  const byKind   = { lesson: 0, observation: 0, question: 0 };
  const bySub    = {
    summarizationFixture:    0,
    registrationHistory:     0,
    registrationAuditExport: 0,
    lowRiskSandboxReadiness: 0,
    riskImpact:              0,
  };
  for (const l of lessons) {
    byStatus[l.status] += 1;
    byKind[l.kind]     += 1;
    bySub[l.subsystem] += 1;
  }
  return {
    totalLessons:        lessons.length,
    byStatus,
    byKind,
    bySubsystem:         bySub,
    humanReviewRequired: lessons.length,
    active:              0,
    autoApplyEligible:   0,
  };
}

// ── Public projection ───────────────────────────────────────────────────────

/**
 * Build a deterministic, propose-only lesson table from an already-built
 * Phase 2j-a candidate set. Pure: no I/O, no mutation, no scheduler, no
 * public output.
 *
 * Empty / missing inputs yield a graceful zero lesson table. Every emitted
 * lesson is `status: "proposed"`, `active: false`, `autoApplyEligible: false`,
 * `applyEligibility: "none"`, and `humanReviewRequired: true`.
 */
export function buildLessonTable(inputs: LessonTableInputs): LessonTable {
  const candidateSet = inputs.candidateSet;
  const candidates: readonly MetaReflectionCandidate[] = Array.isArray(candidateSet?.candidates)
    ? candidateSet.candidates
    : [];

  const proposedAt = normaliseGeneratedAt(inputs.now);
  const proposedBy = typeof inputs.proposedBy === "string" && inputs.proposedBy.length > 0
    ? inputs.proposedBy
    : "unspecified";
  const audit: LessonAuditMetadata = {
    proposedAt,
    proposedBy,
    sourceProjection: "phase2j-a-candidate-set",
  };

  const candidateSchemaVersion = typeof candidateSet?.schemaVersion === "string"
    ? candidateSet.schemaVersion
    : "unknown";

  const lessons: LessonRow[] = candidates.map(c =>
    lessonRowFromCandidate(c, audit, candidateSchemaVersion),
  );

  // Stable ordering: (scope, lessonId). Both derived from the candidate so
  // equal inputs produce equal ordering.
  lessons.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.lessonId.localeCompare(b.lessonId);
  });

  const generatedBy = typeof inputs.generatedBy === "string" && inputs.generatedBy.length > 0
    ? inputs.generatedBy
    : "unspecified";
  const generatedAt = normaliseGeneratedAt(inputs.now);

  return {
    schemaVersion: LESSONS_DATABASE_SCHEMA_VERSION,
    label:         LESSONS_DATABASE_LABEL,
    generatedAt,
    generatedBy,
    isEmpty:       lessons.length === 0,
    lessons,
    aggregate:     buildAggregate(lessons),
    evidenceProvided: {
      history:     candidateSet?.evidenceProvided?.history     === true,
      auditExport: candidateSet?.evidenceProvided?.auditExport === true,
      readiness:   candidateSet?.evidenceProvided?.readiness   === true,
      riskImpact:  candidateSet?.evidenceProvided?.riskImpact  === true,
    },
    sourceCandidateSchemaVersion: candidateSchemaVersion,
    invariants: {
      readOnly:            true,
      proposeOnly:         true,
      nonWidening:         true,
      active:              false,
      autoApplyEligible:   false,
      publicAction:        false,
      schedulerDriven:     false,
      mutating:            false,
      humanReviewRequired: true,
    },
  };
}

/**
 * Stable, deterministic JSON serializer for a lesson table. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern from
 * `metaReflectionCandidateSchema.ts`.
 */
export function serializeLessonTable(
  table: LessonTable,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedLessons = table.lessons.map(l => ({
    lessonId:            l.lessonId,
    schemaVersion:       l.schemaVersion,
    status:              l.status,
    active:              l.active,
    autoApplyEligible:   l.autoApplyEligible,
    applyEligibility:    l.applyEligibility,
    humanReviewRequired: l.humanReviewRequired,
    kind:                l.kind,
    scope:               l.scope,
    subsystem:           l.subsystem,
    reasonCode:          l.reasonCode,
    title:               l.title,
    body:                l.body,
    confidence:          l.confidence,
    evidenceStrength:    l.evidenceStrength,
    candidateRef: {
      candidateId:   l.candidateRef.candidateId,
      schemaVersion: l.candidateRef.schemaVersion,
    },
    evidenceRefs: l.evidenceRefs.map(r => ({
      source: r.source,
      ref:    r.ref,
      ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
    })),
    audit: {
      proposedAt:       l.audit.proposedAt,
      proposedBy:       l.audit.proposedBy,
      sourceProjection: l.audit.sourceProjection,
    },
    invariants: {
      readOnly:            l.invariants.readOnly,
      proposeOnly:         l.invariants.proposeOnly,
      nonWidening:         l.invariants.nonWidening,
      active:              l.invariants.active,
      autoApplyEligible:   l.invariants.autoApplyEligible,
      publicAction:        l.invariants.publicAction,
      schedulerDriven:     l.invariants.schedulerDriven,
      mutating:            l.invariants.mutating,
      humanReviewRequired: l.invariants.humanReviewRequired,
    },
  }));

  const ordered = {
    schemaVersion: table.schemaVersion,
    label:         table.label,
    generatedAt:   table.generatedAt,
    generatedBy:   table.generatedBy,
    isEmpty:       table.isEmpty,
    lessons:       orderedLessons,
    aggregate: {
      totalLessons: table.aggregate.totalLessons,
      byStatus: {
        proposed: table.aggregate.byStatus.proposed,
        approved: table.aggregate.byStatus.approved,
        rejected: table.aggregate.byStatus.rejected,
        retired:  table.aggregate.byStatus.retired,
      },
      byKind: {
        lesson:      table.aggregate.byKind.lesson,
        observation: table.aggregate.byKind.observation,
        question:    table.aggregate.byKind.question,
      },
      bySubsystem: {
        summarizationFixture:    table.aggregate.bySubsystem.summarizationFixture,
        registrationHistory:     table.aggregate.bySubsystem.registrationHistory,
        registrationAuditExport: table.aggregate.bySubsystem.registrationAuditExport,
        lowRiskSandboxReadiness: table.aggregate.bySubsystem.lowRiskSandboxReadiness,
        riskImpact:              table.aggregate.bySubsystem.riskImpact,
      },
      humanReviewRequired: table.aggregate.humanReviewRequired,
      active:              table.aggregate.active,
      autoApplyEligible:   table.aggregate.autoApplyEligible,
    },
    evidenceProvided: {
      history:     table.evidenceProvided.history,
      auditExport: table.evidenceProvided.auditExport,
      readiness:   table.evidenceProvided.readiness,
      riskImpact:  table.evidenceProvided.riskImpact,
    },
    sourceCandidateSchemaVersion: table.sourceCandidateSchemaVersion,
    invariants: {
      readOnly:            table.invariants.readOnly,
      proposeOnly:         table.invariants.proposeOnly,
      nonWidening:         table.invariants.nonWidening,
      active:              table.invariants.active,
      autoApplyEligible:   table.invariants.autoApplyEligible,
      publicAction:        table.invariants.publicAction,
      schedulerDriven:     table.invariants.schedulerDriven,
      mutating:            table.invariants.mutating,
      humanReviewRequired: table.invariants.humanReviewRequired,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
