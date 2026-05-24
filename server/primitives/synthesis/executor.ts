// ---------------------------------------------------------------------------
// 306 — SYNTHESIS PRIMITIVE EXECUTOR (scaffold, dry-run by default)
//
// First concrete primitive executor wired onto the registry scaffolding
// landed by PR #423 (commit 199be6d). The registry seam exists but is
// never dispatched from: `actionTranslator.translateAction` performs the
// `lookupPrimitiveForFamily(family)` call, then deliberately discards the
// result via `void registered;`. This PR adds an executor and a
// registration helper; it does NOT change the translator. The translator
// continues to return `{ primitive: "none", ... }` on the fall-through
// path so production behavior remains byte-identical.
//
// What this module DOES today
// ---------------------------
//   - Exposes the `synthesis::scaffold` Primitive descriptor.
//   - Implements an async executor that, when invoked, performs no side
//     effects and returns a structured `PrimitiveExecutionResult` shaped
//     for telemetry only.
//   - Honours `PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN` (default `true` when
//     the executor itself is enabled). Non-dry-run mode is explicitly
//     guarded: even when both flags are flipped, the executor refuses to
//     perform real synthesis until a real engine is injected.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Run the production `synthesisEngine` or any LLM call. Real engine
//     wiring is deferred to a follow-up PR once dry-run telemetry has
//     observed stable across multiple cycles.
//   - Persist anything. No DB writes, no journal entries, no rec
//     mutations.
//   - Mutate the action-translator output. The translator continues to
//     ignore the registry's return value (`void registered;`).
//   - Touch obligation, promotion gate, applyRecommendation, or the
//     missingPrimitiveReconciler. Pin 7 / Pin 11 remain in force.
//
// Safety guarantees
// -----------------
//   - The module is import-safe: importing it does NOT register anything.
//     Registration only happens through `registerSynthesisPrimitive()`,
//     which the bootstrap module calls conditionally.
//   - Dry-run is the default whenever the executor is enabled. The
//     non-dry-run guard returns `ok: false` with a structured reason
//     until a future PR injects a real engine. There is no "just do it"
//     branch reachable from flags alone.
// ---------------------------------------------------------------------------

import type {
  Primitive,
  PrimitiveExecutionContext,
  PrimitiveExecutionResult,
  PrimitiveExecutor,
} from "../registry.js";

/**
 * Env flag controlling whether the synthesis executor should be
 * registered at bootstrap. Default: OFF. Independent of the master
 * `PRIMITIVE_REGISTRY_ENABLED` flag — both must be ON for the executor
 * to be reachable from the translator path (today the translator never
 * dispatches anyway; see module header).
 */
export const PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV =
  "PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED";

/**
 * Env flag controlling dry-run vs. live behavior of the executor. When
 * the executor is enabled, dry-run defaults to ON. Operators must
 * explicitly set this to `"false"` to opt OUT of dry-run, AND the
 * executor must have a real engine wired in — which today it does not.
 */
export const PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV =
  "PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN";

/** Stable family/id key. Mirrors the `family::id` convention used by registry. */
export const SYNTHESIS_PRIMITIVE_ID = "scaffold";

/**
 * Read the executor-enabled flag. Treated as the only source of truth;
 * not memoized so operators can flip without a process restart (matches
 * PR #419 / PR #423 convention).
 */
export function isSynthesisExecutorEnabled(): boolean {
  return process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] === "true";
}

/**
 * Read the dry-run flag. Returns `true` (dry-run) unless explicitly set
 * to the literal string `"false"`. The default-to-dry-run posture is
 * intentional — we never want a flag flip alone to enable side effects.
 */
export function isSynthesisExecutorDryRun(): boolean {
  return process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] !== "false";
}

/**
 * Executor body. Today it is intentionally side-effect-free regardless
 * of the dry-run flag — the non-dry-run branch refuses to run because
 * no production engine is wired in.
 */
export const synthesisExecutor: PrimitiveExecutor = async (
  ctx: PrimitiveExecutionContext,
): Promise<PrimitiveExecutionResult> => {
  const dryRun = isSynthesisExecutorDryRun();
  const observations: string[] = [
    `family=synthesis`,
    `id=${SYNTHESIS_PRIMITIVE_ID}`,
    `dryRun=${dryRun}`,
    `actionTextLen=${ctx.actionText.length}`,
    `insightTextLen=${ctx.insightText.length}`,
  ];
  if (ctx.recommendationId) observations.push(`recId=${ctx.recommendationId}`);
  if (ctx.sourceInsightId) observations.push(`sourceInsightId=${ctx.sourceInsightId}`);

  if (!dryRun) {
    // Non-dry-run requested but no production engine has been wired in
    // by this PR. Refuse explicitly — never let a flag flip alone reach
    // a real side effect.
    return {
      ok: false,
      observations,
      sideEffects: [],
      reason:
        "synthesis-executor: non-dry-run requested but no production engine is wired; refusing",
    };
  }

  return {
    ok: true,
    observations,
    sideEffects: [
      // Append-only, telemetry-shaped. No real work performed.
      `[dry-run] would-synthesize from action="${ctx.actionText.slice(0, 80)}"`,
    ],
  };
};

/**
 * Primitive descriptor consumed by `registerPrimitive`. Exported so
 * tests can inspect the shape without needing to go through bootstrap.
 */
export const SYNTHESIS_PRIMITIVE: Primitive = {
  family: "synthesis",
  id: SYNTHESIS_PRIMITIVE_ID,
  description:
    "Dry-run synthesis primitive scaffold (telemetry only; no production engine wired).",
  execute: synthesisExecutor,
};
