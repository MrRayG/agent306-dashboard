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
// PR #431 (this PR) extends the dry-run branch to consult a pluggable
// `SynthesisAdapter` (see ./adapter.ts) so that future PRs can wire a
// real planning seam without modifying the executor body. The non-dry-
// run branch still REFUSES — the adapter is dry-run-only and the
// "production engine" disclaimer remains accurate.
//
// What this module DOES today
// ---------------------------
//   - Exposes the `synthesis::scaffold` Primitive descriptor.
//   - Implements an async executor that, when invoked in dry-run mode,
//     consults the currently-installed `SynthesisAdapter` for a
//     structured plan and folds the plan's observations + summary into
//     the returned `PrimitiveExecutionResult`. The default adapter is
//     pure and side-effect-free.
//   - Honours `PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN` (default `true` when
//     the executor itself is enabled). Non-dry-run mode is explicitly
//     guarded: even when both flags are flipped, the executor refuses to
//     perform real synthesis until a real engine adapter is wired in via
//     a future PR (and that path will require additional gating beyond
//     just flipping the dry-run flag off).
//   - Surfaces adapter exceptions by allowing them to propagate to the
//     caller (the guarded dispatcher catches them and surfaces a
//     `{ kind: "error" }` `DispatchResult`).
//
// What this module DOES NOT do today
// ----------------------------------
//   - Run the production `synthesisEngine` or any LLM call. The default
//     adapter is pure. A future PR may add a `liveSynthesisAdapter` that
//     wraps the real engine under additional gating; that adapter is
//     out of scope here.
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
//   - The adapter slot defaults to a pure, deterministic implementation.
//     The executor cannot reach a side-effect-bearing adapter unless a
//     wiring PR explicitly installs one — and such a wiring PR will live
//     behind its own gate, not behind the dry-run flag flip.
// ---------------------------------------------------------------------------

import type {
  Primitive,
  PrimitiveExecutionContext,
  PrimitiveExecutionResult,
  PrimitiveExecutor,
} from "../registry.js";
import { getSynthesisAdapter, type SynthesisPlan } from "./adapter.js";

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
 * Executor body. In dry-run mode (the default whenever the executor is
 * enabled) the executor delegates to the currently-installed
 * `SynthesisAdapter` to compute a structured plan, then folds that plan
 * into the `PrimitiveExecutionResult`. In non-dry-run mode the executor
 * still refuses — no production engine is wired by this PR.
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

  // Dry-run branch: consult the adapter for a structured plan.
  const adapter = getSynthesisAdapter();
  observations.push(`adapterName=${adapter.name}`);

  let plan: SynthesisPlan;
  try {
    plan = await adapter.planSynthesis({
      actionText: ctx.actionText,
      insightText: ctx.insightText,
      recommendationId: ctx.recommendationId,
      sourceInsightId: ctx.sourceInsightId,
    });
  } catch (err: unknown) {
    // Surface the adapter failure as a structured refusal rather than
    // letting it throw out of the executor. The guarded dispatcher
    // (PR #429) ALSO catches throws as `{ kind: "error" }`; this branch
    // is the direct-invocation safety net so callers that bypass the
    // dispatcher (tests, future wiring) get a stable result shape too.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      observations,
      sideEffects: [],
      reason: `synthesis-executor: adapter "${adapter.name}" threw: ${msg}`,
    };
  }

  if (plan.observations) {
    for (const o of plan.observations) observations.push(o);
  }

  return {
    ok: true,
    observations,
    sideEffects: [
      // Append-only, telemetry-shaped. No real work performed.
      `[dry-run] would-synthesize via adapter=${adapter.name}: ${plan.summary}`,
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
    "Dry-run synthesis primitive scaffold (telemetry only; default adapter is pure, no production engine wired).",
  execute: synthesisExecutor,
};
