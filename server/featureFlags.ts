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
  /** Enables Gap C experiment dispatch interception in `modelRouter.resolveTask`.
   *  Default OFF. When OFF, `runExperiment()` short-circuits to null and
   *  resolveTask behaves identically to pre-Phase-0. Phase 1 (separate PR)
   *  registers the first experiment and flips this on staging. */
  experimentExploration: flagOn("EXPERIMENT_EXPLORATION"),
  /** Roadmap B1 — routes blog generation through the shared
   *  `draftProductionPipeline` so structured pipeline.* events land in
   *  engine_events. Default OFF; behavior under the flag is intentionally
   *  equivalent to the existing blog hot path (same writer prompt, same
   *  verifier gate, same publish decision). When OFF, blog generation
   *  uses `generateBlogPost` directly as it did before. See
   *  server/pipeline/draftProductionPipeline.ts and
   *  server/pipeline/blogAdapter.ts. */
  blogPipelineEnabled: flagOn("BLOG_PIPELINE_ENABLED"),
};

/** Read a feature flag at call time instead of at module load. Some flags
 *  (notably `blogPipelineEnabled`) are flipped per-request in tests; the
 *  static `featureFlags` snapshot captures process-startup state, which
 *  is fine for production but brittle for tests that toggle env vars
 *  between cases. Production callers can use either; tests should prefer
 *  this helper. */
export function readFlag(envVar: string): boolean {
  return flagOn(envVar);
}
