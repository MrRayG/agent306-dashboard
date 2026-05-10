/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2k-c: READ-ONLY LESSON SUGGESTIONS FOR HYPOTHESES
 *
 * Phase 2k-a (`lessonsDatabaseSchema.ts`) ships a pure, deterministic
 * projection that re-shapes a Phase 2j-a meta-reflection candidate set into
 * proposed *lesson records*. Every row carries `status: "proposed"`,
 * `active: false`, `autoApplyEligible: false`, `applyEligibility: "none"`,
 * and `humanReviewRequired: true`.
 *
 * Phase 2k-b (`lessonsDatabaseApprovalRecord.ts`) ships the first manual
 * human-in-the-loop decision path: `recordLessonApproval(input)` turns a
 * `proposed` lesson into an `approved` / `rejected` / `retired` *decision
 * record*. Approved/rejected/retired records remain `active: false`,
 * `runtimeActionEligible: false`, `publicActionEligible: false`, and
 * `manualReviewedOnly: true`. They are *reviewed* lessons, not *active*
 * lessons. Phase 2k-b is propose-only-at-runtime.
 *
 * Phase 2k-c is the first narrow read-only bridge from those manual-reviewed
 * lesson records into hypothesis planning. It adds a pure projection that
 * accepts:
 *
 *   - a hypothesis "context" (an already-built object describing the
 *     hypothesis a planner is considering — typically derived from a
 *     `Hypothesis` in `data/research_lab.json` but the projection accepts
 *     a structural minimum so it remains pure and unit-testable), and
 *   - a list of Phase 2k-b approval/decision records,
 *
 * and returns a deterministic, in-process *suggestion set* — a list of
 * candidate lesson suggestions that *might* be relevant to the hypothesis,
 * each with structured relevance metadata and structured safety metadata.
 *
 * Phase 2k-c is intentionally:
 *
 *   - READ-ONLY / SUGGESTION-ONLY: every emitted suggestion carries
 *     `suggestionOnly: true`, `autoApplyEligible: false`,
 *     `applyEligibility: "none"`, `runtimeActionEligible: false`,
 *     `publicActionEligible: false`, and `requiresHumanReviewForUse: true`.
 *     The projection NEVER mutates the hypothesis, NEVER auto-selects a
 *     lesson, NEVER alters experiment selection, NEVER changes metric
 *     binding, NEVER triggers a recommendation, NEVER feeds an apply /
 *     promotion / runtime path. There is no scheduler, no app-boot hook,
 *     no UI control wired to this helper in this PR.
 *   - APPROVED-ONLY ELIGIBLE: only Phase 2k-b records with
 *     `decision === "approved"` are eligible to become suggestions.
 *     `rejected`, `retired`, malformed, missing-source-lesson, or
 *     non-`ok` refusal records are EXCLUDED from the suggestion list
 *     and surface only as structured `ineligibleRecords[]` entries
 *     with machine-readable `reason` codes — so a reviewer can audit
 *     why a record was dropped without the helper having mutated
 *     anything.
 *   - PURE: no file is opened, no JSONL is parsed, no DB is touched, no
 *     in-memory map is mutated, no env var is set, no wall clock is read,
 *     no scheduler is signalled. The helper is referentially-transparent
 *     over its inputs.
 *   - DETERMINISTIC: suggestion IDs are stable sha256-derived ids over
 *     `(decisionId, lessonId, hypothesisId, reasonCode, scope,
 *     subsystem, matchReasonCodes...)`. Same inputs → same id. Ordering
 *     is a fixed lexicographic sort on `(scoreBucket desc, scope,
 *     suggestionId)`. There is no `Date . now`, no `Math . random`, no
 *     UUID, no time-derived fields unless an explicit `now` is injected
 *     by the caller (and tests pin its value).
 *   - NON-WIDENING: a suggestion cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. Every suggestion explicitly restates the
 *     read-only invariants. Disabled kinds remain disabled — suggestions
 *     *about* disabled kinds describe their disabled state for human
 *     review; they never propose enabling them.
 *   - GRACEFUL ON EMPTY: empty / missing inputs yield a well-typed empty
 *     suggestion set with zero counts and `suggestions: []`. The helper
 *     NEVER throws on shape errors at the record level — it routes them
 *     into `ineligibleRecords[]`. It DOES throw on programmer-shaped
 *     misuse (non-object inputs) so a typo fails loudly.
 *   - REUSE-FIRST: this module never re-derives the candidate set / the
 *     lesson table / the approval record. It accepts already-built
 *     Phase 2k-b records and projects them. The Phase 2k-a/b invariants
 *     flow through verbatim onto every suggestion.
 *   - NO PUBLIC OUTPUT: suggestions are an in-process value. They are not
 *     posted, not written, not published, not scheduled. No UI control
 *     consumes them in this PR.
 *   - NOT WIRED TO RUNTIME: this module is not imported by
 *     `server/index.ts`, not imported by the autonomy monitor, not
 *     imported by `applyRecommendation`, `canPromote`, the scheduler,
 *     or any hypothesis-creation flow. Search this PR:
 *     `lessonSuggestionsForHypothesis` is referenced ONLY by this module
 *     and its tests.
 *
 * Match rules (Phase 2k-c, narrow and auditable):
 *
 *   - SUBSYSTEM_MATCH (band: "moderate"): the lesson's `subsystem` is
 *     explicitly listed in `hypothesisContext.subsystems[]`. This is the
 *     primary match channel and it is the only one that will fire when
 *     a hypothesis explicitly names a subsystem.
 *   - SCOPE_MATCH (band: "strong"): the lesson's `scope` is listed
 *     verbatim in `hypothesisContext.scopes[]`, OR a scope prefix in
 *     `hypothesisContext.scopePrefixes[]` is a prefix of the lesson's
 *     scope. Scope is a tighter signal than subsystem.
 *   - REASON_CODE_MATCH (band: "moderate"): the lesson's reason code is
 *     listed in `hypothesisContext.reasonCodes[]`. Useful for "find me
 *     lessons that documented this exact kind of evidence".
 *
 * A suggestion is emitted only when at least one match channel fires.
 * `scoreBand` is the max of the firing channels using the partial order
 * weak < moderate < strong. The numeric `score` field is a coarse
 * deterministic count of how many channels fired (1..3) — strictly for
 * stable ordering, NOT for ranking. No floating point.
 *
 * NOTE on kind: Phase 2k-b's approval record narrows the lesson row down
 * and intentionally does NOT carry the Phase 2k-a `kind` / `title` / `body`
 * fields onto the decision record. To stay reuse-first and avoid
 * re-deriving Phase 2j-a state, suggestions emit `kind: "lesson"` as the
 * coarse default. A future Phase 2k-d/e PR may thread the full lesson row
 * through (it remains read-only either way).
 *
 * Tests pin:
 *   - approved/manual-reviewed records produce deterministic relevant
 *     suggestions for matching hypothesis contexts;
 *   - rejected/retired/refusal/malformed records are excluded from
 *     `suggestions[]` and surface in `ineligibleRecords[]` with the
 *     documented `reason` code;
 *   - every suggestion carries the safety metadata
 *     (`suggestionOnly: true`, `autoApplyEligible: false`,
 *     `applyEligibility: "none"`, `runtimeActionEligible: false`,
 *     `publicActionEligible: false`, `requiresHumanReviewForUse: true`);
 *   - every suggestion includes traceable source refs (sourceLessonId,
 *     sourceDecisionId, sourceCandidateId, sourceEvidenceRefs[],
 *     matchReasonCodes[], scoreBand, score);
 *   - deterministic ids + byte-identical serialization across repeated
 *     calls with equal inputs;
 *   - no Date.now / Math.random / UUID / env / fs / db mutation;
 *   - input hypothesis context, input records, real data fixtures, and
 *     the on-disk sandbox/lessons ledger are byte-identical after the run;
 *   - disabled sandbox kinds cannot become enabled / registerable /
 *     actionable through a suggestion (the suggestion just describes
 *     the disabled state for a human reviewer);
 *   - `lessonSuggestionsForHypothesis` is NOT imported by runtime /
 *     monitor / scheduler / apply / promotion files.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as crypto from "node:crypto";

import {
  type LessonApprovalResult,
  type LessonApprovalRecord,
} from "./lessonsDatabaseApprovalRecord.js";
import {
  type LessonEvidenceRef,
  type LessonSubsystem,
  type LessonKind,
} from "./lessonsDatabaseSchema.js";
import {
  type MetaReflectionReasonCode,
} from "./metaReflectionCandidateSchema.js";

/** Stable schema identifier for the suggestion set. Bumped only when the
 *  suggestion-set shape changes in a backwards-incompatible way. */
export const LESSON_SUGGESTIONS_SCHEMA_VERSION = "phase2k-c.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const LESSON_SUGGESTIONS_LABEL =
  "agent306.lesson_suggestions_for_hypothesis";

/** Coarse score band — matches the `confidence` bucket vocabulary. */
export type LessonSuggestionScoreBand = "weak" | "moderate" | "strong";

/**
 * Closed set of match-channel reason codes. A suggestion fires when at
 * least one of these channels matches; the firing channels are recorded
 * verbatim on the suggestion for auditability.
 */
export type LessonSuggestionMatchReasonCode =
  | "subsystem_match"
  | "scope_match"
  | "reason_code_match";

/**
 * Closed set of machine-readable reasons a Phase 2k-b record can be
 * excluded from the suggestion list. Surfaced in `ineligibleRecords[]`
 * so a reviewer can audit why a record was dropped.
 */
export type LessonSuggestionIneligibleReason =
  | "refusal_record"
  | "decision_not_approved"
  | "malformed_record"
  | "missing_source_lesson"
  | "no_match";

/**
 * The minimum structural shape a hypothesis must present to participate
 * in suggestion matching. Kept tiny and explicit so the helper remains
 * pure: callers project their full `Hypothesis` (from `researchEngine.ts`)
 * down to this shape. The helper never reads the full hypothesis record
 * and never mutates it.
 */
export interface LessonSuggestionHypothesisContext {
  /** Stable hypothesis id (e.g. the `id` field on a `Hypothesis`). */
  hypothesisId:        string;
  /** Subsystems the hypothesis touches. Closed-set vocabulary, same as
   *  the lesson `subsystem` field. */
  subsystems?:         readonly LessonSubsystem[];
  /** Verbatim scopes the hypothesis is scoped to (e.g.
   *  `"sandbox.summarizationTemplate"`). */
  scopes?:             readonly string[];
  /** Scope prefixes the hypothesis is scoped to (e.g.
   *  `"sandbox.disabled."`). A lesson scope matches when one of these is
   *  a strict prefix of the scope string. */
  scopePrefixes?:      readonly string[];
  /** Closed-set reason codes the hypothesis is interested in. */
  reasonCodes?:        readonly MetaReflectionReasonCode[];
}

/** Static, restated invariants — also restated on the suggestion set itself
 *  for defence-in-depth. */
export interface LessonSuggestionInvariants {
  readOnly:                  true;
  suggestionOnly:            true;
  nonWidening:               true;
  active:                    false;
  autoApplyEligible:         false;
  publicAction:              false;
  schedulerDriven:           false;
  mutating:                  false;
  runtimeActionEligible:     false;
  publicActionEligible:      false;
  requiresHumanReviewForUse: true;
  manualReviewedOnly:        true;
}

const FIXED_INVARIANTS: LessonSuggestionInvariants = {
  readOnly:                  true,
  suggestionOnly:            true,
  nonWidening:               true,
  active:                    false,
  autoApplyEligible:         false,
  publicAction:              false,
  schedulerDriven:           false,
  mutating:                  false,
  runtimeActionEligible:     false,
  publicActionEligible:      false,
  requiresHumanReviewForUse: true,
  manualReviewedOnly:        true,
};

/** A single read-only lesson suggestion. */
export interface LessonSuggestion {
  /** Stable id — sha256(`${decisionId}|${lessonId}|${hypothesisId}|${reasonCode}|${scope}|${subsystem}|${matchKey}`)
   *  truncated to 16 chars. */
  suggestionId:        string;
  schemaVersion:       typeof LESSON_SUGGESTIONS_SCHEMA_VERSION;

  /** Subject hypothesis — echoed for auditability. */
  hypothesisId:        string;

  /** Source refs — let a reviewer trace back to Phase 2k-a / 2k-b. */
  sourceLessonId:      string;
  sourceDecisionId:    string;
  sourceCandidateId:   string;

  /** Lesson metadata, mirrored verbatim. */
  scope:               string;
  subsystem:           LessonSubsystem;
  reasonCode:          MetaReflectionReasonCode;
  kind:                LessonKind;
  title:               string;
  body:                string;

  /** Operator / source / decision audit — passed through from Phase 2k-b. */
  operator:            string;
  source:              "manual";
  decision:            "approved";
  decidedAt:           string;
  rationale:           string;

  /** Source evidence references — verbatim from the source lesson. */
  sourceEvidenceRefs:  readonly LessonEvidenceRef[];

  /** Match channels that fired, in stable lexicographic order. */
  matchReasonCodes:    readonly LessonSuggestionMatchReasonCode[];
  /** Coarse, deterministic count of firing channels (1..4) — used only
   *  for stable ordering. Not a ranking score. */
  score:               number;
  /** Coarse score band — max of the firing channels under the partial
   *  order weak < moderate < strong. */
  scoreBand:           LessonSuggestionScoreBand;
  /** Short, deterministic, human-readable explanation. Same inputs →
   *  same string. */
  explanation:         string;

  /** Safety metadata — restated on every suggestion for defence-in-depth. */
  suggestionOnly:            true;
  autoApplyEligible:         false;
  applyEligibility:          "none";
  runtimeActionEligible:     false;
  publicActionEligible:      false;
  requiresHumanReviewForUse: true;

  /** Static invariants — restated for audit. */
  invariants:          LessonSuggestionInvariants;
}

/** A record that was provided but is not eligible to become a suggestion. */
export interface LessonSuggestionIneligibleRecord {
  /** Index into the input `records[]` array. Stable across calls. */
  index:               number;
  /** Phase 2k-b decision id when available — `null` for malformed records. */
  decisionId:          string | null;
  /** Phase 2k-a lesson id when available — `null` for malformed records. */
  lessonId:            string | null;
  /** Machine-readable reason for ineligibility. */
  reason:              LessonSuggestionIneligibleReason;
  /** Short, deterministic, human-readable detail. */
  detail:              string;
}

/** Aggregate counts over the emitted suggestion set. */
export interface LessonSuggestionAggregate {
  totalSuggestions:    number;
  totalIneligible:     number;
  byScoreBand: {
    weak:              number;
    moderate:          number;
    strong:            number;
  };
  bySubsystem: {
    summarizationFixture:    number;
    registrationHistory:     number;
    registrationAuditExport: number;
    lowRiskSandboxReadiness: number;
    riskImpact:              number;
  };
  byIneligibleReason: {
    refusal_record:           number;
    decision_not_approved:    number;
    malformed_record:         number;
    missing_source_lesson:    number;
    no_match:                 number;
  };
  /** Always equals `totalSuggestions` in Phase 2k-c — restated for audit. */
  requiresHumanReviewForUse: number;
  /** Always 0. Restated for audit. */
  autoApplyEligible:   number;
}

/** The full read-only suggestion set returned by the projection. */
export interface LessonSuggestionSet {
  schemaVersion:       typeof LESSON_SUGGESTIONS_SCHEMA_VERSION;
  label:               typeof LESSON_SUGGESTIONS_LABEL;
  /** Caller-injected ISO timestamp. `null` when no `now` was passed —
   *  the projection NEVER reads the wall clock. */
  generatedAt:         string | null;
  /** Caller-supplied label identifying the operator / script. Defaults
   *  to the literal `"unspecified"`. */
  generatedBy:         string;
  /** Echo of the subject hypothesis id. */
  hypothesisId:        string;
  /** Whether the suggestion set carries any rows. */
  isEmpty:             boolean;
  suggestions:         readonly LessonSuggestion[];
  ineligibleRecords:   readonly LessonSuggestionIneligibleRecord[];
  aggregate:           LessonSuggestionAggregate;
  invariants:          LessonSuggestionInvariants;
}

/** Inputs to the projection. */
export interface LessonSuggestionInputs {
  hypothesisContext:   LessonSuggestionHypothesisContext;
  records:             readonly LessonApprovalResult[];
  now?:                Date | string;
  generatedBy?:        string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

const BAND_RANK: Record<LessonSuggestionScoreBand, number> = {
  weak:     1,
  moderate: 2,
  strong:   3,
};

/** Per-channel score band — used to compute the suggestion's `scoreBand`
 *  as the max over the firing channels. */
const CHANNEL_BAND: Record<LessonSuggestionMatchReasonCode, LessonSuggestionScoreBand> = {
  scope_match:       "strong",
  subsystem_match:   "moderate",
  reason_code_match: "moderate",
};

function stableSuggestionId(parts: readonly string[]): string {
  const h = crypto.createHash("sha256");
  h.update("agent306|lessonSuggestionsForHypothesis|v1\n");
  for (const p of parts) {
    h.update(String(p));
    h.update("\n");
  }
  return h.digest("hex").slice(0, 16);
}

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

/** Best-effort classifier for a raw record entry into an ineligibility
 *  reason. Order matters — we surface the most specific reason first. */
function classifyIneligibility(
  rec: unknown,
): { reason: LessonSuggestionIneligibleReason; detail: string; decisionId: string | null; lessonId: string | null } | null {
  if (rec === null || typeof rec !== "object") {
    return {
      reason:     "malformed_record",
      detail:     "record is not an object",
      decisionId: null,
      lessonId:   null,
    };
  }
  const r = rec as Partial<LessonApprovalResult> & Record<string, unknown>;

  // Refusal record: `ok: false`.
  if (r.ok === false) {
    return {
      reason:     "refusal_record",
      detail:     `refusal reason: ${String((r as { reason?: unknown }).reason ?? "unknown")}`,
      decisionId: null,
      lessonId:   null,
    };
  }

  if (r.ok !== true) {
    return {
      reason:     "malformed_record",
      detail:     "record is missing the `ok` discriminator",
      decisionId: null,
      lessonId:   null,
    };
  }

  // It is a record (ok: true). Pull the fields we care about defensively.
  const decisionId = typeof (r as LessonApprovalRecord).decisionId === "string"
    ? (r as LessonApprovalRecord).decisionId
    : null;
  const lesson = (r as LessonApprovalRecord).lesson;
  const lessonId = lesson && typeof lesson.lessonId === "string" ? lesson.lessonId : null;
  const sourceLesson = (r as LessonApprovalRecord).sourceLesson;

  if (!sourceLesson || typeof sourceLesson !== "object") {
    return {
      reason:     "missing_source_lesson",
      detail:     "approval record is missing sourceLesson",
      decisionId,
      lessonId,
    };
  }
  if (!lesson || typeof lesson !== "object") {
    return {
      reason:     "malformed_record",
      detail:     "approval record is missing lesson",
      decisionId,
      lessonId,
    };
  }

  const decision = (r as LessonApprovalRecord).decision;
  if (decision !== "approved") {
    return {
      reason:     "decision_not_approved",
      detail:     `decision is ${JSON.stringify(decision ?? null)}; only approved is eligible`,
      decisionId,
      lessonId,
    };
  }

  // Belt-and-suspenders: even an approved record must still be
  // inactive / non-actionable per Phase 2k-b. If it isn't, surface as
  // malformed rather than emit a suggestion off it.
  if (
    lesson.active !== false ||
    lesson.autoApplyEligible !== false ||
    lesson.applyEligibility !== "none" ||
    (lesson as { runtimeActionEligible?: unknown }).runtimeActionEligible !== false ||
    (lesson as { publicActionEligible?: unknown }).publicActionEligible !== false
  ) {
    return {
      reason:     "malformed_record",
      detail:     "approved record violates Phase 2k-b inactive/non-actionable invariants",
      decisionId,
      lessonId,
    };
  }

  return null; // Eligible to attempt a match.
}

interface MatchResult {
  channels: LessonSuggestionMatchReasonCode[];
  band:     LessonSuggestionScoreBand;
  score:    number;
}

function evaluateMatch(
  ctx: LessonSuggestionHypothesisContext,
  rec: LessonApprovalRecord,
): MatchResult | null {
  const source = rec.sourceLesson;
  const channels = new Set<LessonSuggestionMatchReasonCode>();

  // subsystem_match
  const ctxSubsystems = Array.isArray(ctx.subsystems) ? ctx.subsystems : [];
  if (ctxSubsystems.some(s => s === source.subsystem)) {
    channels.add("subsystem_match");
  }

  // scope_match (exact OR prefix)
  const ctxScopes = Array.isArray(ctx.scopes) ? ctx.scopes : [];
  const ctxScopePrefixes = Array.isArray(ctx.scopePrefixes) ? ctx.scopePrefixes : [];
  if (
    ctxScopes.some(s => s === source.scope) ||
    ctxScopePrefixes.some(p => typeof p === "string" && p.length > 0 && source.scope.startsWith(p))
  ) {
    channels.add("scope_match");
  }

  // reason_code_match
  const ctxReasonCodes = Array.isArray(ctx.reasonCodes) ? ctx.reasonCodes : [];
  if (ctxReasonCodes.some(c => c === source.reasonCode)) {
    channels.add("reason_code_match");
  }

  if (channels.size === 0) return null;

  // Sort channels lexicographically for deterministic output.
  const sortedChannels = Array.from(channels).sort();

  // Band = max(BAND_RANK[channel]) over firing channels.
  let bandRank = 0;
  for (const c of sortedChannels) {
    bandRank = Math.max(bandRank, BAND_RANK[CHANNEL_BAND[c]]);
  }
  const band: LessonSuggestionScoreBand =
    bandRank === 3 ? "strong" :
    bandRank === 2 ? "moderate" :
    "weak";

  return {
    channels: sortedChannels,
    band,
    score: sortedChannels.length,
  };
}

function buildExplanation(
  channels: readonly LessonSuggestionMatchReasonCode[],
  scope: string,
  subsystem: string,
  reasonCode: string,
): string {
  // Deterministic, byte-identical for equal inputs.
  const parts = channels.map(c => {
    switch (c) {
      case "scope_match":       return `scope=${scope}`;
      case "subsystem_match":   return `subsystem=${subsystem}`;
      case "reason_code_match": return `reasonCode=${reasonCode}`;
    }
  });
  return `matched ${channels.length} channel(s): ${parts.join(", ")}`;
}

function emptyAggregate(): LessonSuggestionAggregate {
  return {
    totalSuggestions: 0,
    totalIneligible:  0,
    byScoreBand: {
      weak:     0,
      moderate: 0,
      strong:   0,
    },
    bySubsystem: {
      summarizationFixture:    0,
      registrationHistory:     0,
      registrationAuditExport: 0,
      lowRiskSandboxReadiness: 0,
      riskImpact:              0,
    },
    byIneligibleReason: {
      refusal_record:        0,
      decision_not_approved: 0,
      malformed_record:      0,
      missing_source_lesson: 0,
      no_match:              0,
    },
    requiresHumanReviewForUse: 0,
    autoApplyEligible:         0,
  };
}

// ── Public projection ───────────────────────────────────────────────────────

/**
 * Build a deterministic, read-only suggestion set from a hypothesis context
 * and a list of Phase 2k-b approval/decision records.
 *
 * Pure: no I/O, no mutation, no scheduler, no public output. Empty / missing
 * inputs yield a graceful zero suggestion set. Every emitted suggestion is
 * `suggestionOnly: true`, `autoApplyEligible: false`,
 * `applyEligibility: "none"`, `runtimeActionEligible: false`,
 * `publicActionEligible: false`, `requiresHumanReviewForUse: true`.
 */
export function buildLessonSuggestionsForHypothesis(
  inputs: LessonSuggestionInputs,
): LessonSuggestionSet {
  if (inputs === null || typeof inputs !== "object") {
    throw new TypeError("buildLessonSuggestionsForHypothesis: inputs must be an object");
  }

  const ctxRaw = inputs.hypothesisContext;
  if (ctxRaw === null || typeof ctxRaw !== "object") {
    throw new TypeError(
      "buildLessonSuggestionsForHypothesis: inputs.hypothesisContext must be an object",
    );
  }

  const hypothesisId = typeof ctxRaw.hypothesisId === "string" && ctxRaw.hypothesisId.length > 0
    ? ctxRaw.hypothesisId
    : "unspecified";
  const ctx: LessonSuggestionHypothesisContext = {
    hypothesisId,
    subsystems:    Array.isArray(ctxRaw.subsystems)    ? ctxRaw.subsystems    : [],
    scopes:        Array.isArray(ctxRaw.scopes)        ? ctxRaw.scopes        : [],
    scopePrefixes: Array.isArray(ctxRaw.scopePrefixes) ? ctxRaw.scopePrefixes : [],
    reasonCodes:   Array.isArray(ctxRaw.reasonCodes)   ? ctxRaw.reasonCodes   : [],
  };

  const records: readonly unknown[] = Array.isArray(inputs.records) ? inputs.records : [];

  const suggestions: LessonSuggestion[] = [];
  const ineligible: LessonSuggestionIneligibleRecord[] = [];

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const refusal = classifyIneligibility(rec);
    if (refusal !== null) {
      ineligible.push({
        index:      i,
        decisionId: refusal.decisionId,
        lessonId:   refusal.lessonId,
        reason:     refusal.reason,
        detail:     refusal.detail,
      });
      continue;
    }

    const ok = rec as LessonApprovalRecord;
    const match = evaluateMatch(ctx, ok);
    if (match === null) {
      ineligible.push({
        index:      i,
        decisionId: ok.decisionId,
        lessonId:   ok.lesson.lessonId,
        reason:     "no_match",
        detail:     "no match channel fired for this hypothesis context",
      });
      continue;
    }

    const lesson = ok.lesson;
    const src    = ok.sourceLesson;
    const audit  = ok.audit;

    const matchKey = match.channels.join(",");
    const suggestionId = stableSuggestionId([
      ok.decisionId,
      lesson.lessonId,
      hypothesisId,
      src.reasonCode,
      src.scope,
      src.subsystem,
      matchKey,
    ]);

    // The Phase 2k-a row carries `kind`/`title`/`body`; Phase 2k-b's
    // lesson row narrows that view and does NOT carry these fields onto
    // the decision record. We defensively read them here in case a caller
    // happens to pass the full Phase 2k-a row through; otherwise we fall
    // back to safe defaults. Either way, the suggestion's behavior is
    // read-only.
    const lessonAny = lesson as unknown as Record<string, unknown>;
    const kind: LessonKind = typeof lessonAny.kind === "string"
      ? (lessonAny.kind as LessonKind)
      : "lesson";

    suggestions.push({
      suggestionId,
      schemaVersion:             LESSON_SUGGESTIONS_SCHEMA_VERSION,
      hypothesisId,
      sourceLessonId:            lesson.lessonId,
      sourceDecisionId:          ok.decisionId,
      sourceCandidateId:         src.candidateRef.candidateId,
      scope:                     src.scope,
      subsystem:                 src.subsystem as LessonSubsystem,
      reasonCode:                src.reasonCode as MetaReflectionReasonCode,
      kind,
      title:                     typeof lessonAny.title === "string"
        ? (lessonAny.title as string)
        : "",
      body:                      typeof lessonAny.body === "string"
        ? (lessonAny.body as string)
        : "",
      operator:                  audit.operator,
      source:                    "manual",
      decision:                  "approved",
      decidedAt:                 audit.decidedAt,
      rationale:                 audit.rationale,
      sourceEvidenceRefs:        src.evidenceRefs,
      matchReasonCodes:          match.channels,
      score:                     match.score,
      scoreBand:                 match.band,
      explanation:               buildExplanation(
        match.channels, src.scope, src.subsystem, src.reasonCode,
      ),
      suggestionOnly:            true,
      autoApplyEligible:         false,
      applyEligibility:          "none",
      runtimeActionEligible:     false,
      publicActionEligible:      false,
      requiresHumanReviewForUse: true,
      invariants:                { ...FIXED_INVARIANTS },
    });
  }

  // Stable ordering: (scoreBand desc, scope asc, suggestionId asc).
  suggestions.sort((a, b) => {
    const ra = BAND_RANK[a.scoreBand];
    const rb = BAND_RANK[b.scoreBand];
    if (ra !== rb) return rb - ra; // strong first
    if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
    return a.suggestionId.localeCompare(b.suggestionId);
  });

  ineligible.sort((a, b) => a.index - b.index);

  // Aggregate.
  const aggregate = emptyAggregate();
  aggregate.totalSuggestions          = suggestions.length;
  aggregate.totalIneligible           = ineligible.length;
  aggregate.requiresHumanReviewForUse = suggestions.length;
  for (const s of suggestions) {
    aggregate.byScoreBand[s.scoreBand] += 1;
    aggregate.bySubsystem[s.subsystem] += 1;
  }
  for (const r of ineligible) {
    aggregate.byIneligibleReason[r.reason] += 1;
  }

  const generatedAt = normaliseGeneratedAt(inputs.now);
  const generatedBy = typeof inputs.generatedBy === "string" && inputs.generatedBy.length > 0
    ? inputs.generatedBy
    : "unspecified";

  return {
    schemaVersion:     LESSON_SUGGESTIONS_SCHEMA_VERSION,
    label:             LESSON_SUGGESTIONS_LABEL,
    generatedAt,
    generatedBy,
    hypothesisId,
    isEmpty:           suggestions.length === 0,
    suggestions,
    ineligibleRecords: ineligible,
    aggregate,
    invariants:        { ...FIXED_INVARIANTS },
  };
}

/**
 * Stable, deterministic JSON serializer for a suggestion set. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern from
 * `lessonsDatabaseSchema.ts` and `lessonsDatabaseApprovalRecord.ts`.
 */
export function serializeLessonSuggestionSet(
  set: LessonSuggestionSet,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedSuggestions = set.suggestions.map(s => ({
    suggestionId:              s.suggestionId,
    schemaVersion:             s.schemaVersion,
    hypothesisId:              s.hypothesisId,
    sourceLessonId:            s.sourceLessonId,
    sourceDecisionId:          s.sourceDecisionId,
    sourceCandidateId:         s.sourceCandidateId,
    scope:                     s.scope,
    subsystem:                 s.subsystem,
    reasonCode:                s.reasonCode,
    kind:                      s.kind,
    title:                     s.title,
    body:                      s.body,
    operator:                  s.operator,
    source:                    s.source,
    decision:                  s.decision,
    decidedAt:                 s.decidedAt,
    rationale:                 s.rationale,
    sourceEvidenceRefs:        s.sourceEvidenceRefs.map(r => ({
      source: r.source,
      ref:    r.ref,
      ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
    })),
    matchReasonCodes:          [...s.matchReasonCodes],
    score:                     s.score,
    scoreBand:                 s.scoreBand,
    explanation:               s.explanation,
    suggestionOnly:            s.suggestionOnly,
    autoApplyEligible:         s.autoApplyEligible,
    applyEligibility:          s.applyEligibility,
    runtimeActionEligible:     s.runtimeActionEligible,
    publicActionEligible:      s.publicActionEligible,
    requiresHumanReviewForUse: s.requiresHumanReviewForUse,
    invariants: {
      readOnly:                  s.invariants.readOnly,
      suggestionOnly:            s.invariants.suggestionOnly,
      nonWidening:               s.invariants.nonWidening,
      active:                    s.invariants.active,
      autoApplyEligible:         s.invariants.autoApplyEligible,
      publicAction:              s.invariants.publicAction,
      schedulerDriven:           s.invariants.schedulerDriven,
      mutating:                  s.invariants.mutating,
      runtimeActionEligible:     s.invariants.runtimeActionEligible,
      publicActionEligible:      s.invariants.publicActionEligible,
      requiresHumanReviewForUse: s.invariants.requiresHumanReviewForUse,
      manualReviewedOnly:        s.invariants.manualReviewedOnly,
    },
  }));

  const orderedIneligible = set.ineligibleRecords.map(r => ({
    index:      r.index,
    decisionId: r.decisionId,
    lessonId:   r.lessonId,
    reason:     r.reason,
    detail:     r.detail,
  }));

  const ordered = {
    schemaVersion:     set.schemaVersion,
    label:             set.label,
    generatedAt:       set.generatedAt,
    generatedBy:       set.generatedBy,
    hypothesisId:      set.hypothesisId,
    isEmpty:           set.isEmpty,
    suggestions:       orderedSuggestions,
    ineligibleRecords: orderedIneligible,
    aggregate: {
      totalSuggestions: set.aggregate.totalSuggestions,
      totalIneligible:  set.aggregate.totalIneligible,
      byScoreBand: {
        weak:     set.aggregate.byScoreBand.weak,
        moderate: set.aggregate.byScoreBand.moderate,
        strong:   set.aggregate.byScoreBand.strong,
      },
      bySubsystem: {
        summarizationFixture:    set.aggregate.bySubsystem.summarizationFixture,
        registrationHistory:     set.aggregate.bySubsystem.registrationHistory,
        registrationAuditExport: set.aggregate.bySubsystem.registrationAuditExport,
        lowRiskSandboxReadiness: set.aggregate.bySubsystem.lowRiskSandboxReadiness,
        riskImpact:              set.aggregate.bySubsystem.riskImpact,
      },
      byIneligibleReason: {
        refusal_record:        set.aggregate.byIneligibleReason.refusal_record,
        decision_not_approved: set.aggregate.byIneligibleReason.decision_not_approved,
        malformed_record:      set.aggregate.byIneligibleReason.malformed_record,
        missing_source_lesson: set.aggregate.byIneligibleReason.missing_source_lesson,
        no_match:              set.aggregate.byIneligibleReason.no_match,
      },
      requiresHumanReviewForUse: set.aggregate.requiresHumanReviewForUse,
      autoApplyEligible:         set.aggregate.autoApplyEligible,
    },
    invariants: {
      readOnly:                  set.invariants.readOnly,
      suggestionOnly:            set.invariants.suggestionOnly,
      nonWidening:               set.invariants.nonWidening,
      active:                    set.invariants.active,
      autoApplyEligible:         set.invariants.autoApplyEligible,
      publicAction:              set.invariants.publicAction,
      schedulerDriven:           set.invariants.schedulerDriven,
      mutating:                  set.invariants.mutating,
      runtimeActionEligible:     set.invariants.runtimeActionEligible,
      publicActionEligible:      set.invariants.publicActionEligible,
      requiresHumanReviewForUse: set.invariants.requiresHumanReviewForUse,
      manualReviewedOnly:        set.invariants.manualReviewedOnly,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
