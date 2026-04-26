/**
 * Calibration capture write helper.
 *
 * `recordOutcome(hyp)` is invoked by `resolveHypothesis()` AFTER the
 * resolution has been persisted to research_lab. It is a no-op when
 * `featureFlags.calibrationCapture` is false, which is the Phase 0
 * default. Phase 1 flips the flag on per-deploy via env var.
 *
 * The function MUST never throw — `resolveHypothesis` is on the hot
 * path of the cycle loop and a calibration write failure must not
 * undo the resolution. All errors are swallowed with a console.warn.
 *
 * See docs/CALIBRATED_CONFIDENCE.md §3 and §5.2.
 */

import { db } from "../db.js";
import { hypothesisOutcomes } from "@shared/schema";
import { featureFlags } from "../featureFlags.js";
import { normalizeConfidence, type NormalizableHypothesis } from "./normalizeConfidence.js";

/** Minimal shape recordOutcome needs from a resolved Hypothesis. Kept
 *  structural so this helper doesn't pull in the full researchEngine
 *  module graph. */
export interface ResolvableHypothesis extends NormalizableHypothesis {
  id:               string;
  status:           string;     // already-resolved status from researchEngine
  resolvedAt?:      string;
  domain?:          string;
}

interface OutcomeMapping {
  actualOutcome:  boolean;
  outcomeWeight:  number;
  outcomeSource:  string;
}

/** Maps `Hypothesis.status` → (actualOutcome, outcomeWeight) per design §3.3.
 *  Returns null for `awaiting-deadline` (terminal-only writes; the
 *  hypothesis is parked, not graded). */
export function deriveOutcome(status: string): OutcomeMapping | null {
  switch (status) {
    case "confirmed":
      return { actualOutcome: true,  outcomeWeight: 1.0, outcomeSource: "auto-resolve" };
    case "rejected":
      return { actualOutcome: false, outcomeWeight: 1.0, outcomeSource: "auto-resolve" };
    case "expired":
      // Prediction did not pan out within timeframe. Informative but a
      // weaker signal than a clear confirm/reject — see design §3.3.
      return { actualOutcome: false, outcomeWeight: 0.5, outcomeSource: "deadline-expiry" };
    case "data-unavailable":
      return { actualOutcome: false, outcomeWeight: 0.0, outcomeSource: "manual" };
    case "stale-retired":
      return { actualOutcome: false, outcomeWeight: 0.0, outcomeSource: "manual" };
    case "awaiting-deadline":
      // Terminal-only writes — design §3.3 explicitly excludes this.
      return null;
    default:
      // Any non-resolved status (forming/testing/unknown) — do not write.
      return null;
  }
}

/** Writes one row to hypothesis_outcomes when the flag is on. No-op
 *  otherwise. Never throws. */
export function recordOutcome(hyp: ResolvableHypothesis): void {
  if (!featureFlags.calibrationCapture) return;
  try {
    const mapping = deriveOutcome(hyp.status);
    if (!mapping) return;

    const norm = normalizeConfidence(hyp);
    const resolvedAt = hyp.resolvedAt ?? new Date().toISOString();

    db.insert(hypothesisOutcomes)
      .values({
        hypothesisId:        hyp.id,
        predictedConfidence: norm.predictedConfidence,
        predictedTrustScore: norm.predictedTrustScore,
        // originatingModel deliberately null in Phase 0 — see design §5.4
        // ("does not modify Hypothesis interface"). Phase 1 backfill +
        // future PR adds the field at the write site upstream.
        originatingModel:    null,
        resolvedAt,
        resolutionStatus:    hyp.status,
        actualOutcome:       mapping.actualOutcome,
        outcomeWeight:       mapping.outcomeWeight,
        outcomeSource:       mapping.outcomeSource,
        domain:              hyp.domain ?? null,
      })
      .run();
  } catch (e: any) {
    console.warn("[calibration] recordOutcome failed:", e?.message ?? e);
  }
}
