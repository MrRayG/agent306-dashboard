/**
 * Confidence-shape normalization for calibration scoring.
 *
 * The codebase carries three concurrent confidence-shaped values per
 * hypothesis. To grade a prediction post-hoc against the eventual
 * outcome, we need a single 0..1 scalar. This helper picks one with
 * a documented precedence and emits the source it used so the caller
 * can audit how a given row was scored.
 *
 * See docs/CALIBRATED_CONFIDENCE.md §4.4.
 */

export type CategoricalConfidence = "high" | "medium" | "low";

/** Minimal shape this helper needs from a Hypothesis. Kept as a structural
 *  type rather than an import of the full Hypothesis interface so the
 *  helper is reusable from tests and the future Phase 1 backfill script
 *  without a circular dep on researchEngine. */
export interface NormalizableHypothesis {
  confidence?:    CategoricalConfidence;
  trustScore?:    number;
  evaluationResult?: { confidence?: number };
}

export interface NormalizedConfidence {
  predictedConfidence: number;
  predictedTrustScore: number | null;
  source: "evaluationResult" | "trustScore" | "categorical" | "default";
}

/** Categorical → numeric mapping, documented as a fallback only.
 *  Not a calibration claim; just a way to keep legacy resolutions in
 *  the dataset until they age out. */
const CATEGORICAL_MAP: Record<CategoricalConfidence, number> = {
  high:   0.85,
  medium: 0.6,
  low:    0.3,
};

/** Default when a hypothesis carries no confidence signal at all.
 *  0.5 is the maximum-entropy prior — neutral with respect to outcome. */
const DEFAULT_CONFIDENCE = 0.5;

export function normalizeConfidence(hyp: NormalizableHypothesis): NormalizedConfidence {
  const trust = typeof hyp.trustScore === "number" && Number.isFinite(hyp.trustScore)
    ? hyp.trustScore
    : null;

  const evalConf = hyp.evaluationResult?.confidence;
  if (typeof evalConf === "number" && Number.isFinite(evalConf) && evalConf >= 0 && evalConf <= 1) {
    return {
      predictedConfidence: evalConf,
      predictedTrustScore: trust,
      source: "evaluationResult",
    };
  }

  if (trust !== null) {
    return {
      predictedConfidence: clamp01(trust / 100),
      predictedTrustScore: trust,
      source: "trustScore",
    };
  }

  if (hyp.confidence && hyp.confidence in CATEGORICAL_MAP) {
    return {
      predictedConfidence: CATEGORICAL_MAP[hyp.confidence],
      predictedTrustScore: trust,
      source: "categorical",
    };
  }

  return {
    predictedConfidence: DEFAULT_CONFIDENCE,
    predictedTrustScore: trust,
    source: "default",
  };
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
