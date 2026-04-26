/**
 * Pure helpers — Brier score and log-loss for binary, weighted samples.
 *
 * Both functions return null when the inputs do not meet the design's
 * sanity floor (sample count or clipping). The cron in Phase 2 will store
 * those nulls so the Mission Control panel can show "insufficient data"
 * for that cell rather than a misleading rank-1 model on 2 samples.
 *
 * See docs/CALIBRATED_CONFIDENCE.md §4.
 */

export interface Sample {
  predictedConfidence: number;   // p_i in [0, 1]
  actualOutcome:       boolean;  // y_i — true if confirmed
  outcomeWeight:       number;   // w_i — see §3.3 weighting table
}

/** Below this floor, Brier and LogLoss are reported as null. Avoids the
 *  "rank-1 model on 2 samples" artifact. Design §4.3. */
export const MIN_SAMPLE_COUNT = 20;

/** ε for log-loss clipping. Predictions < ε or > 1-ε are clamped before
 *  the log; if any *raw* prediction is already outside (ε, 1-ε) we return
 *  null with a debug log because it implies a numerically broken pipeline. */
export const LOG_LOSS_EPSILON = 1e-6;

/** Brier score for binary, weighted samples.
 *
 *   Brier = Σ w_i · (p_i − y_i)² / Σ w_i
 *
 *  Returns null if `samples.length < MIN_SAMPLE_COUNT` or if Σw_i ≤ 0. */
export function computeBrier(samples: Sample[]): number | null {
  if (samples.length < MIN_SAMPLE_COUNT) return null;
  let weightedSqErr = 0;
  let totalWeight = 0;
  for (const s of samples) {
    const w = s.outcomeWeight;
    if (!Number.isFinite(w) || w <= 0) continue;
    const y = s.actualOutcome ? 1 : 0;
    const err = s.predictedConfidence - y;
    weightedSqErr += w * err * err;
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;
  return weightedSqErr / totalWeight;
}

/** Weighted, ε-clipped binary log-loss.
 *
 *   p_clip = clip(p_i, ε, 1−ε)
 *   LogLoss = − Σ w_i · (y_i ln p_clip + (1−y_i) ln(1−p_clip)) / Σ w_i
 *
 *  Returns null if `samples.length < MIN_SAMPLE_COUNT`, if any sample's
 *  raw `predictedConfidence` is outside (ε, 1−ε) (signalling a pipeline
 *  bug, not a calibration issue), or if Σw_i ≤ 0. */
export function computeLogLoss(samples: Sample[]): number | null {
  if (samples.length < MIN_SAMPLE_COUNT) return null;
  // Sanity gate: any raw prediction at the boundary means the upstream
  // never rounded into [0, 1]. Don't try to score that.
  for (const s of samples) {
    if (
      !Number.isFinite(s.predictedConfidence) ||
      s.predictedConfidence <= LOG_LOSS_EPSILON ||
      s.predictedConfidence >= 1 - LOG_LOSS_EPSILON
    ) {
      return null;
    }
  }
  let weightedNegLL = 0;
  let totalWeight = 0;
  for (const s of samples) {
    const w = s.outcomeWeight;
    if (!Number.isFinite(w) || w <= 0) continue;
    const p = clip(s.predictedConfidence, LOG_LOSS_EPSILON, 1 - LOG_LOSS_EPSILON);
    const y = s.actualOutcome ? 1 : 0;
    const term = y * Math.log(p) + (1 - y) * Math.log(1 - p);
    weightedNegLL += w * -term;
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;
  return weightedNegLL / totalWeight;
}

function clip(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
