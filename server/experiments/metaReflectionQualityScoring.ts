/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2j-c: REFLECTION QUALITY SCORING (READ-ONLY, ADVISORY)
 *
 * Phase 2j-a shipped a pure candidate-schema projection
 * (`buildMetaReflectionCandidateSet`). Phase 2j-b added a thin live generator
 * (`buildMetaReflectionLiveReport`) that pulls the latest read-only evidence
 * sources and re-projects them into candidates. The live report carries a
 * `metrics.qualityScore: null` placeholder so a future Phase 2j-c can
 * populate the score without a schema break.
 *
 * Phase 2j-c is that next step: a deterministic, propose-only scorer that
 * accepts an already-built live report and emits a small structured quality
 * score plus per-dimension scores and human-readable bands. The score is
 * advisory only — it is a hint about whether the reflection output is worth
 * a reviewer's attention right now. It never auto-applies anything, never
 * registers a sandbox kind, never promotes a record, never widens any
 * capability.
 *
 * Phase 2j-c is intentionally:
 *   - PURE / READ-ONLY: no file is opened, no JSONL is parsed, no DB is
 *     touched, no in-memory map is mutated, no env var is set, no scheduler
 *     is signalled. The scorer accepts an already-built live report (the
 *     caller — tests, REPL, autonomy monitor — supplies it) and returns an
 *     in-process value.
 *   - DETERMINISTIC: every dimension is derived from stable counts off the
 *     candidate set. Equal input → equal output, byte-for-byte when
 *     serialised. No wall-clock reads, no `Math.random()`, no UUIDs.
 *   - NON-WIDENING: the score cannot enable a sandbox kind, cannot promote
 *     a candidate, cannot mark anything auto-apply eligible, cannot turn a
 *     question into a lesson. Every candidate remains
 *     `humanReviewRequired: true` and `autoApplyEligible: false`. The
 *     scorer also re-validates the safety invariants and lowers the score
 *     if anything looks off.
 *   - ADVISORY ONLY: the output carries an explicit `advisoryOnly: true`
 *     marker, an explicit `applyEligibility: "none"` marker, and a clear
 *     `usefulnessBand` bucket so an operator can tell at a glance whether
 *     the reflection pass is worth reviewing — but no automated path
 *     consumes the score for any action.
 *   - GRACEFUL ON EMPTY: an empty report (cold deployment, no evidence)
 *     scores 0 across the board with a `cold` usefulness band and a clear
 *     `humanReviewNeededCount: 0`. Empty is not a failure.
 *   - REUSE-FIRST: the scorer never re-derives history/audit/readiness
 *     snapshots. It only re-projects the already-emitted live report.
 *
 * Tests pin: deterministic output on fixed reports, populated reports score
 * non-zero with expected dimension bands, empty reports score gracefully,
 * missing-source warnings penalise the evidence-coverage / completeness
 * dimensions, safety-compliance check rejects malformed candidates, no
 * file/db/env mutation, disabled kinds remain disabled and cannot be
 * "scored into" enabled state.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  type MetaReflectionLiveReport,
  type MetaReflectionEvidenceSourceReport,
} from "./metaReflectionLiveGenerator.js";
import {
  type MetaReflectionCandidate,
  type MetaReflectionReasonCode,
} from "./metaReflectionCandidateSchema.js";

/** Stable schema identifier for the quality score. Bumped only when the
 *  score shape changes in a backwards-incompatible way. */
export const META_REFLECTION_QUALITY_SCORE_SCHEMA_VERSION = "phase2j-c.v1";

/** Stable label embedded so an operator can confirm provenance at a glance. */
export const META_REFLECTION_QUALITY_SCORE_LABEL =
  "agent306.meta_reflection_quality_score";

/** Coarse usefulness/quality buckets. The thresholds are intentionally
 *  conservative — a `high` band still requires a human reviewer. */
export type MetaReflectionQualityBand =
  | "cold"        // empty / no signal at all
  | "low"         // some signal but evidence/coverage is thin
  | "moderate"    // multiple sources present, recognisable signal
  | "high";       // broad coverage, recognisable signal, safety clean

/** The seven dimensions the scorer considers. Adding a new dimension
 *  requires bumping the schema version. */
export type MetaReflectionQualityDimensionId =
  | "evidenceCoverage"     // how many sources loaded cleanly
  | "traceability"         // fraction of candidates with explicit evidenceRefs
  | "actionabilityForReview" // fraction with complete review-ready metadata
  | "reasonCodeDiversity"  // distinct reason codes / total candidates
  | "safetyCompliance"     // every candidate's safety invariants intact
  | "missingSourcePenalty" // 1 - share of sources missing/errored
  | "metadataCompleteness"; // fraction with all required metadata fields

/**
 * Per-dimension score. `score` is in [0, 1] (deterministic to 4 decimal
 * places after rounding). `band` is the coarse bucket. `details` is a
 * stable, JSON-safe map of the counts that produced the score so an
 * operator can audit it without re-running anything.
 */
export interface MetaReflectionQualityDimensionScore {
  id:      MetaReflectionQualityDimensionId;
  score:   number;
  band:    MetaReflectionQualityBand;
  /** Stable, short human-readable note describing what was checked. */
  note:    string;
  /** Stable, JSON-safe count map. Keys are sorted lexicographically by
   *  the serializer for byte-identical output. */
  details: Readonly<Record<string, number>>;
}

/** Aggregate counts surfaced alongside the score for dashboard consumption. */
export interface MetaReflectionQualityCounts {
  /** Total candidates considered (mirrors `report.metrics.candidateCount`). */
  candidateCount:           number;
  /** Number of candidates needing human review (always equals
   *  `candidateCount` in Phase 2j-c). Restated for audit clarity. */
  humanReviewNeededCount:   number;
  /** Number of candidates eligible for auto-apply (always 0). Restated for
   *  audit clarity. */
  autoApplyEligibleCount:   number;
  /** Number of distinct reason codes emitted in this pass. */
  distinctReasonCodeCount:  number;
  /** Number of distinct subsystems represented in this pass. */
  distinctSubsystemCount:   number;
  /** Number of source channels that loaded cleanly (populated or empty). */
  sourcesAvailableCount:    number;
  /** Number of source channels that were missing or errored. */
  sourcesMissingOrErroredCount: number;
  /** Number of `missingSourceWarnings` on the underlying report. */
  missingSourceWarningCount: number;
}

/** Pass/fail readiness for review. Intentionally coarse and conservative. */
export interface MetaReflectionQualityReviewReadiness {
  /** True when the score is at least `moderate` AND safety compliance is
   *  perfect. This is advisory; a human reviewer still drives the decision. */
  readyForReview:           boolean;
  /** Short, stable reason explaining the readiness verdict. */
  reason:                   string;
  /** Restated for defence-in-depth — `readyForReview` never implies
   *  apply-eligibility. */
  applyEligible:            false;
}

/** Aggregate quality score. */
export interface MetaReflectionQualityScore {
  schemaVersion:      typeof META_REFLECTION_QUALITY_SCORE_SCHEMA_VERSION;
  label:              typeof META_REFLECTION_QUALITY_SCORE_LABEL;
  /** Overall quality score in [0, 1] — weighted average of the per-dimension
   *  scores. Rounded to 4 decimal places for deterministic comparison. */
  overallScore:       number;
  /** Coarse overall band derived from `overallScore`. */
  qualityBand:        MetaReflectionQualityBand;
  /** Coarse usefulness band — synonymous with `qualityBand` today, but
   *  named separately so future signals can grow without breaking the
   *  schema. */
  usefulnessBand:     MetaReflectionQualityBand;
  dimensions:         readonly MetaReflectionQualityDimensionScore[];
  counts:             MetaReflectionQualityCounts;
  reviewReadiness:    MetaReflectionQualityReviewReadiness;
  /** Caller-injected ISO timestamp echoed from the underlying report. Never
   *  read from the wall clock here. */
  generatedAt:        string | null;
  /** Caller-supplied label echoed from the underlying report. */
  generatedBy:        string;
  /** Static restatement: this score is advisory only. */
  advisoryOnly:       true;
  /** Static restatement: no apply path is opened by scoring. */
  applyEligibility:   "none";
  /** Static restatement of the propose-only / read-only contract — mirrors
   *  the live report invariants. */
  invariants: {
    readOnly:           true;
    proposeOnly:        true;
    nonWidening:        true;
    autoApplyEligible:  false;
    publicAction:       false;
    schedulerDriven:    false;
    mutating:           false;
    humanReviewRequired: true;
    advisoryOnly:       true;
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Round to 4 decimal places. Deterministic across calls. */
function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

/** Clamp into [0, 1]. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Bucket a [0, 1] score into the coarse band. Thresholds are intentionally
 *  conservative — `high` requires broad coverage. */
function bandForScore(score: number, candidateCount: number): MetaReflectionQualityBand {
  if (candidateCount === 0) return "cold";
  if (score >= 0.75) return "high";
  if (score >= 0.5)  return "moderate";
  if (score >  0)    return "low";
  return "cold";
}

/** Required-metadata predicate for a candidate. Closed set of checks so an
 *  operator can grep the rule. */
function hasCompleteMetadata(c: MetaReflectionCandidate): boolean {
  if (typeof c.candidateId !== "string" || c.candidateId.length === 0) return false;
  if (typeof c.scope       !== "string" || c.scope.length === 0)       return false;
  if (typeof c.subsystem   !== "string" || c.subsystem.length === 0)   return false;
  if (typeof c.reasonCode  !== "string" || c.reasonCode.length === 0)  return false;
  if (typeof c.title       !== "string" || c.title.length === 0)       return false;
  if (typeof c.body        !== "string" || c.body.length === 0)        return false;
  if (typeof c.confidence  !== "string" || c.confidence.length === 0)  return false;
  if (typeof c.evidenceStrength !== "string" || c.evidenceStrength.length === 0) return false;
  if (typeof c.riskLevel   !== "string" || c.riskLevel.length === 0)   return false;
  if (!Array.isArray(c.evidenceRefs)) return false;
  return true;
}

/** Traceability predicate — a candidate is traceable when it has at least
 *  one evidence ref with a non-empty `ref` string. `detail` is a bonus. */
function isTraceable(c: MetaReflectionCandidate): boolean {
  if (!Array.isArray(c.evidenceRefs) || c.evidenceRefs.length === 0) return false;
  for (const r of c.evidenceRefs) {
    if (typeof r.ref === "string" && r.ref.length > 0) return true;
  }
  return false;
}

/** Safety-compliance predicate — every candidate must restate the
 *  propose-only / not-auto-apply contract. Anything missing lowers the
 *  dimension score immediately. */
function isSafetyCompliant(c: MetaReflectionCandidate): boolean {
  if (c.humanReviewRequired !== true)  return false;
  if (c.autoApplyEligible   !== false) return false;
  if (c.riskLevel !== "low")           return false;
  const inv = c.invariants;
  if (!inv) return false;
  if (inv.readOnly          !== true)  return false;
  if (inv.proposeOnly       !== true)  return false;
  if (inv.nonWidening       !== true)  return false;
  if (inv.autoApplyEligible !== false) return false;
  if (inv.publicAction      !== false) return false;
  if (inv.schedulerDriven   !== false) return false;
  if (inv.mutating          !== false) return false;
  return true;
}

/** Sort details map keys for deterministic serialization. */
function sortedDetails(details: Record<string, number>): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(details).sort()) {
    out[key] = details[key];
  }
  return Object.freeze(out);
}

// ── Per-dimension scorers ───────────────────────────────────────────────────

function scoreEvidenceCoverage(
  sources: readonly MetaReflectionEvidenceSourceReport[],
  candidateCount: number,
): MetaReflectionQualityDimensionScore {
  const total = sources.length;
  const available = sources.filter(s =>
    s.status === "available_populated" || s.status === "available_empty",
  ).length;
  const populated = sources.filter(s => s.status === "available_populated").length;
  // Coverage rewards both "loaded cleanly" and "loaded with data". A source
  // that loaded but is empty still contributes — empty-history is a normal
  // cold state, not a failure.
  const raw = total > 0 ? (available + populated) / (2 * total) : 0;
  const score = round4(clamp01(raw));
  return {
    id:    "evidenceCoverage",
    score,
    band:  bandForScore(score, Math.max(candidateCount, available)),
    note:  "Share of evidence sources that loaded cleanly, weighted by populated vs. empty status.",
    details: sortedDetails({
      sourcesTotal:     total,
      sourcesAvailable: available,
      sourcesPopulated: populated,
    }),
  };
}

function scoreMissingSourcePenalty(
  sources: readonly MetaReflectionEvidenceSourceReport[],
  missingWarnings: readonly string[],
  candidateCount: number,
): MetaReflectionQualityDimensionScore {
  const total = sources.length;
  const missingOrErrored = sources.filter(s =>
    s.status === "missing" || s.status === "error",
  ).length;
  // Score is 1 - share of missing/errored sources. A larger penalty drops
  // the score more aggressively.
  const raw = total > 0 ? 1 - (missingOrErrored / total) : 0;
  const score = round4(clamp01(raw));
  return {
    id:    "missingSourcePenalty",
    score,
    band:  bandForScore(score, Math.max(candidateCount, total)),
    note:  "1 minus the share of evidence sources reported as missing or errored.",
    details: sortedDetails({
      sourcesTotal:           total,
      sourcesMissingOrErrored: missingOrErrored,
      missingSourceWarnings:   missingWarnings.length,
    }),
  };
}

function scoreTraceability(
  candidates: readonly MetaReflectionCandidate[],
): MetaReflectionQualityDimensionScore {
  const total = candidates.length;
  const traceable = candidates.filter(isTraceable).length;
  const withDetail = candidates.filter(c =>
    Array.isArray(c.evidenceRefs) && c.evidenceRefs.some(r =>
      typeof r.detail === "string" && r.detail.length > 0,
    ),
  ).length;
  const raw = total > 0 ? (traceable + withDetail) / (2 * total) : 0;
  const score = round4(clamp01(raw));
  return {
    id:    "traceability",
    score,
    band:  bandForScore(score, total),
    note:  "Share of candidates that carry at least one evidence ref, weighted by presence of structured detail.",
    details: sortedDetails({
      candidatesTotal:     total,
      candidatesTraceable: traceable,
      candidatesWithDetail: withDetail,
    }),
  };
}

function scoreActionability(
  candidates: readonly MetaReflectionCandidate[],
): MetaReflectionQualityDimensionScore {
  const total = candidates.length;
  // Actionable-for-review: complete metadata AND human-review-required AND
  // a non-empty title/body so a reviewer can act on the candidate now.
  const actionable = candidates.filter(c =>
    hasCompleteMetadata(c) &&
    c.humanReviewRequired === true &&
    typeof c.title === "string" && c.title.length > 0 &&
    typeof c.body  === "string" && c.body.length  > 0,
  ).length;
  const raw = total > 0 ? actionable / total : 0;
  const score = round4(clamp01(raw));
  return {
    id:    "actionabilityForReview",
    score,
    band:  bandForScore(score, total),
    note:  "Share of candidates that are review-ready: complete metadata, human-review-required, non-empty title/body.",
    details: sortedDetails({
      candidatesTotal:      total,
      candidatesActionable: actionable,
    }),
  };
}

function scoreReasonCodeDiversity(
  candidates: readonly MetaReflectionCandidate[],
): MetaReflectionQualityDimensionScore {
  const total = candidates.length;
  const distinctCodes = new Set<MetaReflectionReasonCode>();
  for (const c of candidates) distinctCodes.add(c.reasonCode);
  // We cap the diversity reference at a small expected ceiling so a pass
  // with three or four distinct codes already scores well. The actual
  // closed reason-code set is larger, but expecting all of them to fire
  // in a single pass would be too aggressive.
  const ceiling = 6;
  const raw = total > 0 ? Math.min(distinctCodes.size, ceiling) / ceiling : 0;
  const score = round4(clamp01(raw));
  return {
    id:    "reasonCodeDiversity",
    score,
    band:  bandForScore(score, total),
    note:  "Distinct reason codes observed in this pass, capped at a conservative ceiling.",
    details: sortedDetails({
      candidatesTotal:       total,
      distinctReasonCodes:   distinctCodes.size,
      diversityCeiling:      ceiling,
    }),
  };
}

function scoreSafetyCompliance(
  candidates: readonly MetaReflectionCandidate[],
): MetaReflectionQualityDimensionScore {
  const total = candidates.length;
  const compliant = candidates.filter(isSafetyCompliant).length;
  // Safety compliance is binary in spirit: anything less than 100% is a
  // material red flag and the overall band should reflect that. The
  // dimension's own score is the raw fraction so an operator can see how
  // many were off.
  const raw = total > 0 ? compliant / total : 1;
  const score = round4(clamp01(raw));
  return {
    id:    "safetyCompliance",
    score,
    band:  total === 0
      ? "cold"
      : (compliant === total ? "high" : (compliant >= Math.ceil(total * 0.5) ? "moderate" : "low")),
    note:  "Share of candidates that restate humanReviewRequired:true, autoApplyEligible:false, riskLevel:low, and the full invariants block.",
    details: sortedDetails({
      candidatesTotal:     total,
      candidatesCompliant: compliant,
    }),
  };
}

function scoreMetadataCompleteness(
  candidates: readonly MetaReflectionCandidate[],
): MetaReflectionQualityDimensionScore {
  const total = candidates.length;
  const complete = candidates.filter(hasCompleteMetadata).length;
  const raw = total > 0 ? complete / total : 0;
  const score = round4(clamp01(raw));
  return {
    id:    "metadataCompleteness",
    score,
    band:  bandForScore(score, total),
    note:  "Share of candidates carrying every required metadata field (id, scope, subsystem, reason code, title, body, confidence, evidenceStrength, riskLevel, evidenceRefs).",
    details: sortedDetails({
      candidatesTotal:      total,
      candidatesComplete:   complete,
    }),
  };
}

// Fixed dimension weights — must sum to 1. Adjust only with a schema bump.
const DIMENSION_WEIGHTS: Readonly<Record<MetaReflectionQualityDimensionId, number>> = Object.freeze({
  evidenceCoverage:       0.20,
  traceability:           0.15,
  actionabilityForReview: 0.15,
  reasonCodeDiversity:    0.10,
  safetyCompliance:       0.20,
  missingSourcePenalty:   0.10,
  metadataCompleteness:   0.10,
});

// Stable dimension order — used both for output and weighted-sum iteration.
const DIMENSION_ORDER: readonly MetaReflectionQualityDimensionId[] = [
  "evidenceCoverage",
  "traceability",
  "actionabilityForReview",
  "reasonCodeDiversity",
  "safetyCompliance",
  "missingSourcePenalty",
  "metadataCompleteness",
];

const FIXED_INVARIANTS = {
  readOnly:           true,
  proposeOnly:        true,
  nonWidening:        true,
  autoApplyEligible:  false,
  publicAction:       false,
  schedulerDriven:    false,
  mutating:           false,
  humanReviewRequired: true,
  advisoryOnly:       true,
} as const;

// ── Public scorer ───────────────────────────────────────────────────────────

/**
 * Score an already-built live meta-reflection report. Pure: no I/O, no
 * mutation, no scheduler, no public output. Same input → same output.
 *
 * The score is advisory only. It cannot enable a sandbox kind, register a
 * record, promote a candidate, or mark anything actionable. Disabled kinds
 * remain disabled.
 */
export function scoreMetaReflectionLiveReport(
  report: MetaReflectionLiveReport,
): MetaReflectionQualityScore {
  const candidates = Array.isArray(report.candidateSet?.candidates)
    ? report.candidateSet.candidates
    : [];
  const sources    = Array.isArray(report.latestEvidenceMarker?.sources)
    ? report.latestEvidenceMarker.sources
    : [];
  const missingWarnings = Array.isArray(report.missingSourceWarnings)
    ? report.missingSourceWarnings
    : [];

  const candidateCount = candidates.length;

  // Build per-dimension scores in stable order.
  const byId: Record<MetaReflectionQualityDimensionId, MetaReflectionQualityDimensionScore> = {
    evidenceCoverage:       scoreEvidenceCoverage(sources, candidateCount),
    traceability:           scoreTraceability(candidates),
    actionabilityForReview: scoreActionability(candidates),
    reasonCodeDiversity:    scoreReasonCodeDiversity(candidates),
    safetyCompliance:       scoreSafetyCompliance(candidates),
    missingSourcePenalty:   scoreMissingSourcePenalty(sources, missingWarnings, candidateCount),
    metadataCompleteness:   scoreMetadataCompleteness(candidates),
  };
  const dimensions = DIMENSION_ORDER.map(id => byId[id]);

  // Weighted average. With no candidates the overall is 0 (cold).
  let overall = 0;
  if (candidateCount > 0) {
    for (const id of DIMENSION_ORDER) {
      overall += byId[id].score * DIMENSION_WEIGHTS[id];
    }
  }
  // Safety penalty: if even one candidate failed safety compliance, cap
  // the overall band at `low` regardless of the weighted average. This is
  // intentional — a propose-only contract violation is material.
  const safetyClean = byId.safetyCompliance.score === 1 || candidateCount === 0;
  if (!safetyClean && overall > 0.499) overall = 0.499;
  overall = round4(clamp01(overall));

  const qualityBand: MetaReflectionQualityBand = bandForScore(overall, candidateCount);
  const usefulnessBand = qualityBand;

  // Aggregate counts.
  const distinctReasonCodes = new Set<MetaReflectionReasonCode>();
  const distinctSubsystems  = new Set<string>();
  for (const c of candidates) {
    distinctReasonCodes.add(c.reasonCode);
    distinctSubsystems.add(c.subsystem);
  }
  const sourcesAvailable = sources.filter(s =>
    s.status === "available_populated" || s.status === "available_empty",
  ).length;
  const sourcesMissingOrErrored = sources.filter(s =>
    s.status === "missing" || s.status === "error",
  ).length;
  const counts: MetaReflectionQualityCounts = {
    candidateCount,
    humanReviewNeededCount: candidates.filter(c => c.humanReviewRequired === true).length,
    autoApplyEligibleCount: candidates.filter(c => c.autoApplyEligible   === true).length,
    distinctReasonCodeCount: distinctReasonCodes.size,
    distinctSubsystemCount:  distinctSubsystems.size,
    sourcesAvailableCount:   sourcesAvailable,
    sourcesMissingOrErroredCount: sourcesMissingOrErrored,
    missingSourceWarningCount: missingWarnings.length,
  };

  // Review readiness — advisory only.
  let readyForReview = false;
  let reason: string;
  if (candidateCount === 0) {
    reason = "No candidates emitted yet — reflection pass is cold.";
  } else if (!safetyClean) {
    reason = "At least one candidate fails the safety-compliance check; not ready for review.";
  } else if (qualityBand === "low") {
    reason = "Reflection signal is thin (low quality band); reviewer attention is optional.";
  } else if (qualityBand === "moderate" || qualityBand === "high") {
    readyForReview = true;
    reason = `Quality band is ${qualityBand}; a reviewer can inspect the candidate set. Advisory only — no apply path exists.`;
  } else {
    reason = "Quality band is cold; no reviewer attention required.";
  }
  const reviewReadiness: MetaReflectionQualityReviewReadiness = {
    readyForReview,
    reason,
    applyEligible: false,
  };

  return {
    schemaVersion:    META_REFLECTION_QUALITY_SCORE_SCHEMA_VERSION,
    label:            META_REFLECTION_QUALITY_SCORE_LABEL,
    overallScore:     overall,
    qualityBand,
    usefulnessBand,
    dimensions,
    counts,
    reviewReadiness,
    generatedAt:      report.generatedAt ?? null,
    generatedBy:      typeof report.generatedBy === "string" && report.generatedBy.length > 0
      ? report.generatedBy
      : "unspecified",
    advisoryOnly:     true,
    applyEligibility: "none",
    invariants:       { ...FIXED_INVARIANTS },
  };
}

/**
 * Stable, deterministic JSON serializer for a quality score. Walks the
 * payload with a fixed key order so the resulting string is byte-identical
 * across calls with equal inputs. Mirrors the serializer pattern from
 * `metaReflectionLiveGenerator.ts`.
 */
export function serializeMetaReflectionQualityScore(
  score: MetaReflectionQualityScore,
  options: { indent?: number } = {},
): string {
  const indent = typeof options.indent === "number" && options.indent >= 0
    ? options.indent
    : 0;

  const orderedDimensions = score.dimensions.map(d => ({
    id:      d.id,
    score:   d.score,
    band:    d.band,
    note:    d.note,
    details: { ...d.details },
  }));

  const ordered = {
    schemaVersion:    score.schemaVersion,
    label:            score.label,
    overallScore:     score.overallScore,
    qualityBand:      score.qualityBand,
    usefulnessBand:   score.usefulnessBand,
    dimensions:       orderedDimensions,
    counts: {
      candidateCount:               score.counts.candidateCount,
      humanReviewNeededCount:       score.counts.humanReviewNeededCount,
      autoApplyEligibleCount:       score.counts.autoApplyEligibleCount,
      distinctReasonCodeCount:      score.counts.distinctReasonCodeCount,
      distinctSubsystemCount:       score.counts.distinctSubsystemCount,
      sourcesAvailableCount:        score.counts.sourcesAvailableCount,
      sourcesMissingOrErroredCount: score.counts.sourcesMissingOrErroredCount,
      missingSourceWarningCount:    score.counts.missingSourceWarningCount,
    },
    reviewReadiness: {
      readyForReview: score.reviewReadiness.readyForReview,
      reason:         score.reviewReadiness.reason,
      applyEligible:  score.reviewReadiness.applyEligible,
    },
    generatedAt:      score.generatedAt,
    generatedBy:      score.generatedBy,
    advisoryOnly:     score.advisoryOnly,
    applyEligibility: score.applyEligibility,
    invariants: {
      readOnly:            score.invariants.readOnly,
      proposeOnly:         score.invariants.proposeOnly,
      nonWidening:         score.invariants.nonWidening,
      autoApplyEligible:   score.invariants.autoApplyEligible,
      publicAction:        score.invariants.publicAction,
      schedulerDriven:     score.invariants.schedulerDriven,
      mutating:            score.invariants.mutating,
      humanReviewRequired: score.invariants.humanReviewRequired,
      advisoryOnly:        score.invariants.advisoryOnly,
    },
  };

  return indent > 0 ? JSON.stringify(ordered, null, indent) : JSON.stringify(ordered);
}
