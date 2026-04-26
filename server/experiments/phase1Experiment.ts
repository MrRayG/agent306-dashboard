/**
 * Gap C — Phase 1 experiment definition.
 *
 * One concrete experiment registered at scheduler boot when
 * `featureFlags.experimentExploration` is ON. Default flag is OFF, so this
 * file ships dormant — registration is a no-op until the env var flips.
 *
 * Surface: routine-tier model dispatch on the `analysis-intake` task. JSON
 * validity is the outcome metric (1.0 = parsed, 0.0 = parse failed). The
 * baseline is the current routine-tier default; the treatment is a
 * sibling-tier model picked from the PR description proposals.
 *
 * IMPORTANT — TREATMENT MODEL IS PROVISIONAL.
 * Reviewer must pick a treatment from the proposals listed in the Phase 1
 * PR body before flipping EXPERIMENT_EXPLORATION on. The constant below is
 * a placeholder so the registration call is syntactically complete; do
 * NOT enable the flag with the placeholder still in place.
 */

export const PHASE1_EXPERIMENT = {
  experimentKey: "routine-analysis-intake-2026q2",
  surface:       "modelRouter" as const,
  taskKey:       "analysis-intake",
  metricKey:     "routine_task_json_validity",
  trafficPct:    0.05,
  baseline: {
    // Mirrors the current routine-tier default in modelRouter.TIER_MAP.
    model:    "google/gemini-3-flash-preview",
    provider: "openrouter",
  },
  treatment: {
    // Locked in 2026-04-26 — Pro-tier quality-up experiment.
    // GPT-5 chosen for strongest server-enforced JSON contract
    // (OpenAI Structured Outputs) at lowest Pro-tier cost
    // (2.5× input / 3.3× output vs gemini-3-flash-preview).
    // Routes via existing OPENROUTER_API_KEY — no new credentials.
    model:    "openai/gpt-5",
    provider: "openrouter",
  },
  notes: "Phase 1: routine-tier JSON-validity A/B on analysis-intake.",
};
