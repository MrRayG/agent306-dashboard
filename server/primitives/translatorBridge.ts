// ---------------------------------------------------------------------------
// 306 — PRIMITIVE TRANSLATOR → DISPATCHER BRIDGE (diagnostic, dry-run only)
//
// Successor to PR #434 (runtime bootstrap audit). Live smoke testing after
// the user enabled all primitive dry-run flags showed:
//
//   - Bootstrap registered synthesis::scaffold / artifact::scaffold /
//     other::scaffold and installed the read-only synthesis planner.
//   - The translator's registry lookup reported primitive hits for the
//     `other`, `synthesis`, and `artifact` families (`primitiveLookupHit`
//     log lines).
//   - But ZERO `engine=primitive-dispatch` telemetry lines were emitted
//     and ZERO `dryRunExecuted` events appeared.
//
// Diagnosis: the translator attaches `registeredPrimitive` metadata to the
// fall-through `{ primitive: "none", ... }` `TranslatedAction` under PR
// #428's gate, but the GoalEngine/action-translation flow never invokes
// the guarded dispatcher from PR #429. The dispatcher has only ever been
// reached from tests.
//
// This module adds the narrow wire: a tiny `bridgeRegisteredPrimitive`
// helper that the GoalEngine calls when it observes a translation with
// `registeredPrimitive` metadata. The helper:
//
//   1. Hands off to `invokeRegisteredPrimitive` from PR #429. ALL gates
//      from that dispatcher remain authoritative — registry, translator-
//      dispatch, executor-invocation, per-family enabled, dry-run.
//   2. Emits a single low-noise `engine=primitive-dispatch` structured
//      log line summarizing the outcome so the next smoke test can
//      observe dry-run results in `engine_events`.
//   3. Contains every throw. The bridge never propagates an exception
//      back into the GoalEngine cycle — that is a load-bearing safety
//      invariant since the GoalEngine cycle currently swallows nothing
//      around the missing-primitive emit path.
//
// What this module DOES NOT do
// ----------------------------
//   - Mutate the `TranslatedAction`. The translator output, the
//     `primitive: "none"` fall-through, and the missing-primitive
//     SelfRecommendation emission stay byte-identical.
//   - Touch `applyRecommendation`, `maybeRegisterRuleForRecommendation`,
//     `registerRuleFromInsight`, the promotion gate, obligation refresh-
//     count escalation, or `missingPrimitiveReconciler.reconcileMissing
//     PrimitiveRecs` lifecycle decisions. Pin 7 / Pin 11 invariants are
//     preserved.
//   - Persist anything beyond the structured log line (which lands in
//     `engine_events`, the same sink existing primitives telemetry
//     already writes to — there is no schema change).
//   - Convert any dispatcher result into rule registration, rec apply,
//     goal promotion, or any other lifecycle side effect. The result is
//     surfaced only via telemetry; the caller does NOT branch on it.
//
// Safety guarantees
// -----------------
//   - Default-off: under default deploy flags every gate inside
//     `invokeRegisteredPrimitive` is OFF and the dispatcher returns
//     `{ kind: "disabled" }` after at most one env read each. The
//     bridge's structured log line emits the `disabled` kind; the
//     executor is never called and no DB-shaped action occurs.
//   - Containment: the bridge is `void`-typed and intended for
//     fire-and-forget use. It catches every throw (including async
//     rejections) so the GoalEngine cycle observes no new failure mode.
//   - Idempotent: the bridge holds no module-scoped state. Repeated
//     invocations for the same translation only generate repeated
//     telemetry lines; they do not mutate the registry, adapter slot,
//     or any DB row.
//   - No new env flags. Every gate already exists; this module composes
//     them through the dispatcher rather than introducing a new toggle.
// ---------------------------------------------------------------------------

import type { TranslatedAction } from "../actionTranslator.js";
import { logEvent } from "../observability/structuredLog.js";
import {
  invokeRegisteredPrimitive,
  type DispatchResult,
} from "./dispatcher.js";
import type { PrimitiveExecutionContext } from "./registry.js";

/** Telemetry engine tag for the bridge's structured-log line. */
export const PRIMITIVE_DISPATCH_BRIDGE_ENGINE = "primitive-dispatch";

/**
 * Caller-supplied context. Mirrors `PrimitiveExecutionContext` exactly —
 * we re-export the same shape so call sites do not need a second type
 * import next to `TranslatedAction`.
 */
export type PrimitiveDispatchBridgeContext = PrimitiveExecutionContext;

/**
 * Summary surfaced to the caller for logging. The caller is expected to
 * ignore it in normal flow; tests assert on it.
 */
export interface BridgeOutcome {
  /** Whether the bridge actually invoked the dispatcher. */
  readonly invoked: boolean;
  /**
   * The dispatcher's result kind when `invoked` is true; otherwise the
   * reason the bridge skipped (e.g. `"no_metadata"`).
   */
  readonly kind: DispatchResult["kind"] | "no_metadata" | "bridge_error";
  /** Family resolved by the dispatcher when known. */
  readonly family?: string;
  /** Primitive id resolved by the dispatcher when known. */
  readonly id?: string;
  /** Free-form reason; populated for skip / disabled / refused / error. */
  readonly reason?: string;
}

/**
 * Conditionally invoke the guarded dispatcher for a `TranslatedAction`
 * that carries `registeredPrimitive` metadata.
 *
 * Contract:
 *   - When `translation.registeredPrimitive` is `undefined`, the bridge
 *     returns immediately with `{ invoked: false, kind: "no_metadata" }`
 *     and emits NO telemetry. The translator's fall-through path is
 *     unobserved by this module unless metadata is attached.
 *   - When metadata is present, the bridge calls
 *     `invokeRegisteredPrimitive(translation, ctx)` and forwards the
 *     dispatcher's outcome to a single `[EVENT] engine=primitive-dispatch`
 *     structured log line.
 *   - Any exception from the dispatcher is caught and surfaced as a
 *     `bridge_error` telemetry line. The bridge never re-throws.
 */
export async function bridgeRegisteredPrimitive(
  translation: TranslatedAction,
  ctx: PrimitiveDispatchBridgeContext,
): Promise<BridgeOutcome> {
  if (!translation.registeredPrimitive) {
    return { invoked: false, kind: "no_metadata" };
  }

  // Capture the metadata up front so an exception inside the dispatcher
  // still has enough context to surface a meaningful telemetry line.
  const meta = translation.registeredPrimitive;

  let result: DispatchResult;
  try {
    result = await invokeRegisteredPrimitive(translation, ctx);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    safeLogEvent({
      event: "dispatchBridgeError",
      level: "warn",
      data: {
        family: meta.family,
        id: meta.id,
        recommendationId: ctx.recommendationId,
        sourceInsightId: ctx.sourceInsightId,
        error: msg,
      },
    });
    return {
      invoked: false,
      kind: "bridge_error",
      family: meta.family,
      id: meta.id,
      reason: msg,
    };
  }

  emitOutcomeTelemetry(result, ctx);

  switch (result.kind) {
    case "disabled":
      return { invoked: false, kind: "disabled", reason: result.reason };
    case "skipped":
      return {
        invoked: false,
        kind: "skipped",
        family: result.family,
        id: result.id,
        reason: result.reason,
      };
    case "ok":
      return {
        invoked: true,
        kind: "ok",
        family: result.family,
        id: result.id,
        reason: result.result.reason,
      };
    case "refused":
      return {
        invoked: true,
        kind: "refused",
        family: result.family,
        id: result.id,
        reason: result.result.reason,
      };
    case "error":
      return {
        invoked: true,
        kind: "error",
        family: result.family,
        id: result.id,
        reason: result.error,
      };
  }
}

function emitOutcomeTelemetry(
  result: DispatchResult,
  ctx: PrimitiveDispatchBridgeContext,
): void {
  const base = {
    recommendationId: ctx.recommendationId,
    sourceInsightId: ctx.sourceInsightId,
  };

  switch (result.kind) {
    case "disabled":
      safeLogEvent({
        event: "dispatchDisabled",
        level: "info",
        data: { ...base, reason: result.reason },
      });
      return;
    case "skipped":
      safeLogEvent({
        event: "dispatchSkipped",
        level: "info",
        data: {
          ...base,
          family: result.family,
          id: result.id,
          reason: result.reason,
        },
      });
      return;
    case "ok":
      safeLogEvent({
        event: "dryRunExecuted",
        level: "info",
        data: {
          ...base,
          family: result.family,
          id: result.id,
          reason: result.result.reason,
          observations: result.result.observations,
        },
      });
      return;
    case "refused":
      safeLogEvent({
        event: "dispatchRefused",
        level: "info",
        data: {
          ...base,
          family: result.family,
          id: result.id,
          reason: result.result.reason,
        },
      });
      return;
    case "error":
      safeLogEvent({
        event: "dispatchError",
        level: "warn",
        data: {
          ...base,
          family: result.family,
          id: result.id,
          error: result.error,
        },
      });
      return;
  }
}

function safeLogEvent(input: {
  event: string;
  level: "info" | "warn";
  data: Record<string, unknown>;
}): void {
  try {
    logEvent({
      engine: PRIMITIVE_DISPATCH_BRIDGE_ENGINE,
      event: input.event,
      level: input.level,
      data: input.data,
    });
  } catch {
    // Observability MUST NOT break the GoalEngine cycle. Swallow.
  }
}
