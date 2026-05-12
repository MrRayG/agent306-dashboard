/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2m-d: SAFETY-GATING VALIDATION SUMMARY (READ-ONLY / PURE)
 *
 * PR #325 introduced the formal hypothesis
 *   `hyp_agent306_safety_gating_single_write_boundary`
 * with metric
 *   `promotion_boundary_violation_count`.
 *
 * PR #326 added a deterministic, read-only static audit
 * (`server/eval/promotionBoundaryAudit.ts`) that produces a structured
 * payload validating the propose-only invariant currently holds.
 *
 * PR #327 recorded the first manual production validation evidence
 * under the hypothesis's optional `manualValidation` field, flipped
 * `measurementPathAccessible: true`, and intentionally left
 * `hygieneTag: "needs_review"`, `rubricVerdict: "review"`, `status:
 * "forming"`, and `queue: "backlog"` so the hypothesis stays
 * operator-gated and non-experiment-ready.
 *
 * Phase 2m-d is the narrowest possible follow-up: the
 * `manualValidation` field was previously untyped. This module:
 *
 *   1. Mirrors the typed shape of `HypothesisManualValidation` (defined
 *      in `server/researchEngine.ts`) so operators / tests can
 *      destructure the evidence record without casting through `any`.
 *   2. Exposes a pure, deterministic read-only projection
 *      (`summarizeSafetyGatingValidation`) over a provided hypothesis
 *      (or a list of hypotheses, in which case the safety-gating
 *      hypothesis is detected by id). The projection reports:
 *        - hypothesisId / metricKey / measurementPathAccessible
 *        - whether manualValidation is present and its latest status
 *        - violationCount / passingFindingCount / warningsCount /
 *          blockersCount
 *        - the existing `canFeedExperiment` readiness verdict
 *        - an `invariants` block restating that evidence is NOT
 *          authorisation.
 *
 * Phase 2m-d is intentionally:
 *
 *   - READ-ONLY / PURE: no fs.read, no fs.write, no DB, no env mutation,
 *     no ledger append, no network call, no scheduler signal, no UI
 *     hook, no API endpoint. The summary operates only over the
 *     hypothesis record(s) provided by the caller.
 *   - DETERMINISTIC: with identical inputs the summary returns deeply-
 *     equal / byte-identical output every call. There is no Date.now /
 *     Math.random / UUID / env read. Any timestamp echoed in the result
 *     comes from the provided hypothesis data or an injected `now`.
 *   - PROPOSE-ONLY / NON-WIDENING: the summary describes readiness — it
 *     cannot mark anything ready, cannot promote a hypothesis, cannot
 *     enable a sandbox kind, cannot mutate the propose-only invariant.
 *     `canPromote` / `applyRecommendation` authority is unchanged.
 *   - REUSE-FIRST: the readiness gate is `canFeedExperiment` from
 *     `server/hypothesisHygiene.ts`. The schema constants are imported
 *     verbatim from `server/eval/promotionBoundaryAudit.ts`. No
 *     runtime-promotion path is imported.
 *   - NOT WIRED TO RUNTIME: this module is not imported by
 *     `server/index.ts`, not imported by the autonomy monitor, not
 *     imported by `applyRecommendation`, `canPromote`, the scheduler,
 *     not exposed by any router, and not referenced by any UI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Hypothesis, HypothesisManualValidation } from "../researchEngine.js";
import {
  canFeedExperiment,
  type HygieneAwareHypothesis,
  type ReadinessVerdict,
} from "../hypothesisHygiene.js";
import {
  PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
  PROMOTION_BOUNDARY_AUDIT_METRIC_KEY,
} from "./promotionBoundaryAudit.js";

/** Stable schema identifier for the summary payload. Bumped only when
 *  the result shape changes in a backwards-incompatible way. */
export const SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION =
  "phase2m-d.v1";

/** Stable label embedded so an operator can confirm provenance. */
export const SAFETY_GATING_VALIDATION_SUMMARY_LABEL =
  "agent306.safety_gating_validation_summary";

/** Hypothesis id the summary detects. Re-exported via the audit module
 *  so a single string moves in lockstep with PR #325 / #326 / #327. */
export const SAFETY_GATING_HYPOTHESIS_ID =
  PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID;

/** Metric key the summary expects on the safety-gating hypothesis. */
export const SAFETY_GATING_METRIC_KEY =
  PROMOTION_BOUNDARY_AUDIT_METRIC_KEY;

/** Static, verbatim safety invariants block embedded in every summary.
 *  Restates the propose-only contract so the summary record carries it
 *  along even when the parent hypothesis JSON is read in isolation. */
export const SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS = [
  "This summary is a read-only, pure projection over a provided",
  "hypothesis record. It opens no file, writes no file, calls no",
  "runtime path, and does not promote, apply, schedule, or publicly",
  "act on any recommendation.",
  "A passing manualValidation (violationCount=0, status=ok) is",
  "evidence the single-write-site invariant currently holds — it is",
  "NOT authorisation to widen the propose-only contract or auto-",
  "promote the hypothesis. canPromote / applyRecommendation authority",
  "is unchanged.",
  "The hypothesis remains operator-gated: hygieneTag, rubricVerdict,",
  "status, and queue are not modified by this summary.",
] as const;

// Re-export the typed shape so callers can `import { HypothesisManualValidation }`
// from the summary module without reaching across files.
export type { HypothesisManualValidation };

/** Coarse readiness label derived from `canFeedExperiment`. */
export type SafetyGatingReadiness =
  | "experiment_ready"
  | "operator_gated"
  | "blocked";

/** Structured summary returned by `summarizeSafetyGatingValidation`. */
export interface SafetyGatingValidationSummary {
  schemaVersion: typeof SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION;
  label:         typeof SAFETY_GATING_VALIDATION_SUMMARY_LABEL;
  /** The detected hypothesis id, or null when no matching hypothesis
   *  was provided. */
  hypothesisId:  string | null;
  /** Whether the safety-gating hypothesis was detected. */
  detected:      boolean;
  /** Metric key from the detected hypothesis, or null when missing. */
  metricKey:     string | null;
  /** Whether the operator marked the measurement path accessible. */
  measurementPathAccessible: boolean;
  /** Whether a manualValidation record is attached. */
  hasManualValidation: boolean;
  /** Latest manualValidation status, or null when absent. */
  latestManualValidationStatus: "ok" | "violated" | "blocked" | null;
  /** Violation count from the latest manualValidation, or null. */
  violationCount: number | null;
  /** Count of passing finding ids in the latest manualValidation. */
  passingFindingCount: number;
  /** Count of warnings in the latest manualValidation. */
  warningsCount: number;
  /** Count of blockers in the latest manualValidation. */
  blockersCount: number;
  /** Readiness verdict from `canFeedExperiment`. Always run, even when
   *  the manualValidation is `ok` — evidence is not authorisation. */
  readinessVerdict: ReadinessVerdict | null;
  /** Coarse label derived from the readiness verdict. */
  readiness:      SafetyGatingReadiness;
  /** Restated invariants block. */
  invariants:     readonly string[];
  /** Pinned ISO-8601 timestamp from the caller; null when not supplied. */
  generatedAt:    string | null;
}

/** Inputs accepted by the summary. Callers MUST inject any wall-clock
 *  value — the helper never reads `Date.now`. */
export interface SummarizeSafetyGatingValidationInputs {
  /** Single hypothesis to summarise. Either `hypothesis` or
   *  `hypotheses` (with detection by id) is required. */
  hypothesis?: HygieneAwareHypothesis | Hypothesis | null;
  /** A list of hypotheses; the safety-gating hypothesis is detected
   *  by id (`SAFETY_GATING_HYPOTHESIS_ID`). */
  hypotheses?: ReadonlyArray<HygieneAwareHypothesis | Hypothesis> | null;
  /** OPTIONAL injected `now` (ISO-8601). When omitted `generatedAt`
   *  is null. */
  now?: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a `manualValidation` record well enough to safely read
 *  its fields. Returns the typed record on success, null on a
 *  structural failure. Pure / read-only / does not throw. */
export function readManualValidation(
  v: unknown,
): HypothesisManualValidation | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.label !== "string" || v.label.length === 0) return null;
  if (typeof v.metricKey !== "string" || v.metricKey.length === 0) return null;
  if (v.status !== "ok" && v.status !== "violated" && v.status !== "blocked") return null;
  return v as unknown as HypothesisManualValidation;
}

/** Detect the safety-gating hypothesis in a list by stable id. Pure. */
export function findSafetyGatingHypothesis(
  hyps: ReadonlyArray<HygieneAwareHypothesis | Hypothesis>,
): HygieneAwareHypothesis | Hypothesis | null {
  for (const h of hyps) {
    if (h && typeof h === "object" && h.id === SAFETY_GATING_HYPOTHESIS_ID) {
      return h;
    }
  }
  return null;
}

function readinessLabel(verdict: ReadinessVerdict | null): SafetyGatingReadiness {
  if (!verdict) return "operator_gated";
  if (verdict.ok) return "experiment_ready";
  if (verdict.blockers.length > 0) return "blocked";
  return "operator_gated";
}

function countArray(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/**
 * Read-only summary of the safety-gating validation status.
 *
 * Accepts either a single hypothesis or a list of hypotheses (in which
 * case the safety-gating hypothesis is detected by id). Returns a
 * deterministic structured payload describing whether the measurement
 * path is accessible, whether manualValidation evidence is attached,
 * and the existing `canFeedExperiment` readiness verdict. The summary
 * does NOT mutate inputs and does NOT touch any runtime path.
 */
export function summarizeSafetyGatingValidation(
  inputs: SummarizeSafetyGatingValidationInputs = {},
): SafetyGatingValidationSummary {
  const explicit = inputs.hypothesis ?? null;
  const list     = inputs.hypotheses ?? null;
  const generatedAt = typeof inputs.now === "string" && inputs.now.length > 0
    ? inputs.now
    : null;

  let target: HygieneAwareHypothesis | Hypothesis | null = null;
  if (explicit && typeof explicit === "object") {
    target = explicit;
  } else if (Array.isArray(list)) {
    target = findSafetyGatingHypothesis(list);
  }

  if (!target) {
    return {
      schemaVersion: SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
      label:         SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
      hypothesisId:  null,
      detected:      false,
      metricKey:     null,
      measurementPathAccessible: false,
      hasManualValidation: false,
      latestManualValidationStatus: null,
      violationCount: null,
      passingFindingCount: 0,
      warningsCount: 0,
      blockersCount: 0,
      readinessVerdict: null,
      readiness:    "operator_gated",
      invariants:   SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS,
      generatedAt,
    };
  }

  const detected = target.id === SAFETY_GATING_HYPOTHESIS_ID;
  const mv = readManualValidation((target as Hypothesis).manualValidation);
  const readinessVerdict = canFeedExperiment(target as HygieneAwareHypothesis);

  return {
    schemaVersion: SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
    label:         SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
    hypothesisId:  target.id,
    detected,
    metricKey:     typeof target.metric === "string" ? target.metric : null,
    measurementPathAccessible: target.measurementPathAccessible === true,
    hasManualValidation: mv !== null,
    latestManualValidationStatus: mv ? mv.status : null,
    violationCount: mv && typeof mv.violationCount === "number"
      ? mv.violationCount
      : null,
    passingFindingCount: mv ? countArray(mv.findingsPassed) : 0,
    warningsCount:       mv ? countArray(mv.warnings)       : 0,
    blockersCount:       mv ? countArray(mv.blockers)       : 0,
    readinessVerdict,
    readiness:    readinessLabel(readinessVerdict),
    invariants:   SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS,
    generatedAt,
  };
}

/**
 * Stable JSON serialisation of a summary. Useful for deterministic
 * comparison in tests and for printing from a manual stdout-only CLI.
 * No I/O.
 */
export function serializeSafetyGatingValidationSummary(
  s: SafetyGatingValidationSummary,
): string {
  return JSON.stringify(s, null, 2);
}
