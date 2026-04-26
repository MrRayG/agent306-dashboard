/**
 * Calibration scoring cron — Phase 0 stub.
 *
 * Phase 0 ships a no-op skeleton so the call site exists once Phase 2
 * lands the actual scoring logic. The function is NOT registered with
 * the engine scheduler in Phase 0 (design doc §5.4: "does not register
 * any cron schedule"). Phase 2 wires it via the engine-runner registry
 * with a weekly schedule (Sundays 09:00 UTC) — see docs/CALIBRATED_CONFIDENCE.md §7.
 *
 * Keeping the export shape stable now means Phase 2's wiring PR is a
 * single-line addition in server/index.ts plus the body of `run()`.
 */

export interface CalibrationCronResult {
  ran: boolean;
  reason?: string;
}

// TODO(Phase 2 — see docs/CALIBRATED_CONFIDENCE.md §7): replace this
// stub with the actual scoring loop. The full plan:
//   1. Read featureFlags.calibrationCapture; if off, return {ran:false}.
//   2. For each model that has any hypothesis_outcomes rows in the past
//      90d, compute Brier + log-loss for the 7d/30d/90d windows.
//   3. Upsert into model_calibration_scores (unique key model+window+endDate).
//   4. logEvent({engine:"calibrationCron", event:"computed", ...}).
export async function runCalibrationCron(): Promise<CalibrationCronResult> {
  return { ran: false, reason: "phase 0 — disabled" };
}
