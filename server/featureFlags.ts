/**
 * Centralized feature flags. Each flag must default to OFF and is read
 * once per process from `process.env`. Flags are intended to be flipped
 * per-deploy via env vars, not per-request — for run-time toggles use a
 * config table instead.
 *
 * Phase 0 of Gap A (Calibrated Confidence) ships `calibrationCapture`
 * default OFF; see docs/CALIBRATED_CONFIDENCE.md §5.2.
 */

function flagOn(envVar: string): boolean {
  return (process.env[envVar] ?? "false").toLowerCase() === "true";
}

export const featureFlags = {
  /** Enables `recordOutcome()` writes from `resolveHypothesis()` into the
   *  `hypothesis_outcomes` table. Default OFF — Phase 1 flips this on. */
  calibrationCapture: flagOn("CALIBRATION_CAPTURE"),
};
