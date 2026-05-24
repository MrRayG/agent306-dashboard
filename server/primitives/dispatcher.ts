// ---------------------------------------------------------------------------
// 306 — PRIMITIVE EXECUTOR INVOCATION DISPATCHER (guarded, dry-run only)
//
// Successor to PR #428 (controlled translator metadata dispatch). PR #428
// added the `registeredPrimitive` metadata field on the
// `{ primitive: "none", ... }` fall-through path when both the master
// registry flag and the translator-dispatch gate were ON. That PR
// deliberately stopped short of invoking the registered executor.
//
// This module adds the next phase: a guarded *invocation* layer that
// accepts a `TranslatedAction` carrying `registeredPrimitive` metadata,
// looks the primitive up in the registry, and calls its executor — but
// only when ALL of the following are true:
//
//   1. `PRIMITIVE_REGISTRY_ENABLED === "true"`
//   2. `PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED === "true"`
//   3. `PRIMITIVE_EXECUTOR_INVOCATION_ENABLED === "true"` (new in this PR)
//   4. The relevant family executor's per-family enabled flag is ON
//      (e.g. `PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED === "true"`).
//
// Any missing gate causes the dispatcher to return a structured
// `disabled` result and NEVER call the executor. The translator path is
// not modified by this module — it remains caller responsibility to
// invoke the dispatcher explicitly. Today there are NO production call
// sites; the dispatcher is reachable only from tests / future wiring.
//
// What this module DOES today
// ---------------------------
//   - Exposes `invokeRegisteredPrimitive(translation, ctx)` returning
//     a `DispatchResult` discriminated union: `disabled`, `skipped`,
//     `ok`, `refused`, or `error`.
//   - Reads only the flags listed above. Does not consult any DB.
//   - Wraps the underlying executor in a try/catch so executor errors
//     are contained — they NEVER throw into the production flow.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Wire itself into the action-translator path. PR #428's controlled
//     dispatch behavior remains: translator attaches metadata only, no
//     executor is called.
//   - Touch `applyRecommendation`, `maybeRegisterRuleForRecommendation`,
//     the promotion gate, obligation refresh-count escalation, or
//     `missingPrimitiveReconciler`. Pin 7 / Pin 11 remain in force.
//   - Persist anything. No DB writes, no journal entries, no rec
//     mutations.
//   - Convert dry-run executor results into "ok" production action.
//     The existing scaffold executors refuse non-dry-run; this
//     dispatcher faithfully surfaces that refusal as `refused`.
//   - Mutate the `primitive: "none"` semantics on the
//     `TranslatedAction`. The dispatcher accepts the translation as
//     input and returns a structured result; it does NOT mutate
//     `translation` or feed results back to the rule registration
//     path.
//
// Safety guarantees
// -----------------
//   - Default-off: with `PRIMITIVE_EXECUTOR_INVOCATION_ENABLED` unset,
//     the dispatcher returns `{ kind: "disabled" }` after the env read
//     and never consults the registry, never calls the executor.
//   - Family-level guarding: even if the master invocation flag is ON,
//     each family's own `PRIMITIVE_<FAMILY>_EXECUTOR_ENABLED` flag must
//     also be ON. This mirrors the bootstrap module's per-family gate
//     so an operator who wants to enable invocation for ONE family can
//     do so without enabling all three.
//   - Error containment: any throw from inside the executor is caught
//     and surfaced as `{ kind: "error", ... }`. No exception escapes
//     the dispatcher to the caller.
//   - Missing metadata / unknown family: the dispatcher returns
//     `{ kind: "skipped", reason }` without calling anything.
//   - Idempotent / side-effect-free import. The module-load side of
//     this file does not touch the registry or env. Importing
//     `dispatcher.ts` is safe in any context.
// ---------------------------------------------------------------------------

import type { TranslatedAction } from "../actionTranslator.js";
import {
  getPrimitive,
  isPrimitiveRegistryEnabled,
  isPrimitiveTranslatorDispatchEnabled,
  type Primitive,
  type PrimitiveExecutionContext,
  type PrimitiveExecutionResult,
  type PrimitiveFamily,
} from "./registry.js";
import {
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  isSynthesisExecutorDryRun,
} from "./synthesis/index.js";
import {
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  isArtifactExecutorDryRun,
} from "./artifact/index.js";
import {
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  isOtherExecutorDryRun,
} from "./other/index.js";
import {
  recordDispatchTelemetry,
  hashActionText,
  type DispatchTelemetryKind,
} from "./telemetry.js";

/**
 * Master env flag controlling whether the dispatcher will ever call a
 * registered executor. Default: OFF. Independent of the registry +
 * dispatch flags — all three must be `"true"` to permit invocation.
 *
 * Not memoized; matches the PR #419 / PR #423 / PR #428 convention so
 * operators can flip without a process restart.
 */
export const PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV =
  "PRIMITIVE_EXECUTOR_INVOCATION_ENABLED";

/** Telemetry tag for `[EVENT]` log lines emitted by this module. */
export const PRIMITIVE_DISPATCHER_TELEMETRY_ENGINE = "primitive-dispatcher";

/**
 * Read the master invocation flag. Treated as the only source of truth.
 */
export function isPrimitiveExecutorInvocationEnabled(): boolean {
  return process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] === "true";
}

/**
 * Map of family → its per-family enabled env var name. Lives next to the
 * dispatcher rather than inside each family module so the dispatcher can
 * gate without importing the executor body.
 *
 * `PrimitiveFamily` is aliased to `MissingPrimitiveFamily`, which has 11
 * variants (artifact, ratio, ttl, gate, archive, spectrum, synthesis,
 * rewrite, verification, verification_scaffold, other) — only three of
 * those have registered executors today (synthesis / artifact / other,
 * landed by PRs #425 / #426 / #427). Typing this as a `Partial<...>`
 * keeps the map honest: only the families with an executor scaffold map
 * to a flag name. Lookups for families without a registered executor
 * return `undefined` and `isFamilyExecutorEnabled` returns `false`,
 * which is the correct "not yet wired" answer.
 */
export const FAMILY_ENABLED_ENV: Partial<Record<PrimitiveFamily, string>> = {
  synthesis: PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  artifact: PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  other: PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
};

/**
 * Read a family's per-family enabled flag.
 */
export function isFamilyExecutorEnabled(family: PrimitiveFamily): boolean {
  const envName = FAMILY_ENABLED_ENV[family];
  if (!envName) return false;
  return process.env[envName] === "true";
}

/**
 * Discriminated union surfaced by the dispatcher. Each variant carries
 * enough context for telemetry and for callers to decide what (if
 * anything) to do downstream.
 *
 * Variants:
 *   - `disabled` — one or more required env flags are OFF. The executor
 *     was NOT called. This is the default outcome.
 *   - `skipped`  — flags allow invocation, but the input doesn't have a
 *     `registeredPrimitive` metadata key, OR the metadata names an
 *     unknown (family, id) pair. The executor was NOT called.
 *   - `ok`       — the executor ran and returned `ok: true`.
 *   - `refused`  — the executor ran and returned `ok: false` (e.g. a
 *     non-dry-run scaffold refusing to perform real work).
 *   - `error`    — the executor threw. The throw was caught; the error
 *     message is surfaced.
 */
export type DispatchResult =
  | { kind: "disabled"; reason: string }
  | { kind: "skipped"; reason: string; family?: PrimitiveFamily; id?: string }
  | {
      kind: "ok";
      family: PrimitiveFamily;
      id: string;
      result: PrimitiveExecutionResult;
    }
  | {
      kind: "refused";
      family: PrimitiveFamily;
      id: string;
      result: PrimitiveExecutionResult;
    }
  | {
      kind: "error";
      family: PrimitiveFamily;
      id: string;
      error: string;
    };

function logEvent(event: string, extra: Record<string, unknown> = {}): void {
  const parts = Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(
    `[EVENT] engine=${PRIMITIVE_DISPATCHER_TELEMETRY_ENGINE} event=${event}${parts ? " " + parts : ""}`,
  );
}

/**
 * Guard: returns a `disabled` result if any of the three master flags
 * is OFF. Reading the env three times rather than caching is deliberate
 * — matches the rest of the primitives stack and lets operators flip
 * flags between cycles without restart.
 *
 * Order matches the layered gate model:
 *   1. registry — without it, no primitives exist at all
 *   2. translator dispatch — without it, the upstream metadata path is
 *      itself off and a caller shouldn't have arrived here with
 *      `registeredPrimitive` populated
 *   3. invocation — the new gate added by this PR
 */
type DisabledResult = Extract<DispatchResult, { kind: "disabled" }>;

function checkMasterGates(): DisabledResult | null {
  if (!isPrimitiveRegistryEnabled()) {
    return {
      kind: "disabled",
      reason: `${PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV}: registry master flag is OFF`,
    };
  }
  if (!isPrimitiveTranslatorDispatchEnabled()) {
    return {
      kind: "disabled",
      reason: `${PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV}: translator-dispatch flag is OFF`,
    };
  }
  if (!isPrimitiveExecutorInvocationEnabled()) {
    return {
      kind: "disabled",
      reason: `${PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV}: invocation flag is OFF`,
    };
  }
  return null;
}

/**
 * Entry point. Given a `TranslatedAction` whose `registeredPrimitive`
 * metadata identifies a (family, id) pair, conditionally invoke the
 * executor under the gates described in the module header.
 *
 * Returns a `DispatchResult` rather than throwing. Errors thrown by the
 * underlying executor are caught and surfaced as `{ kind: "error" }`.
 *
 * NOTE: this function is intentionally not exported into the action
 * translator path by this PR. Production paths today neither produce
 * `ok` nor `refused` results, because nothing calls this dispatcher in
 * a production flow. The scaffold ships ready for a future PR to wire
 * it in once invocation telemetry is observed stable in tests/CI.
 */
export async function invokeRegisteredPrimitive(
  translation: TranslatedAction,
  ctx: PrimitiveExecutionContext,
): Promise<DispatchResult> {
  const actionHash = hashActionText(ctx.actionText);
  const captureTelemetry = (
    kind: DispatchTelemetryKind,
    extra: {
      family?: PrimitiveFamily;
      id?: string;
      gateReason?: string;
      resultReason?: string;
      dryRun?: boolean;
    } = {},
  ): void => {
    recordDispatchTelemetry({
      kind,
      family: extra.family,
      id: extra.id,
      actionHash,
      recommendationId: ctx.recommendationId,
      gateReason: extra.gateReason,
      resultReason: extra.resultReason,
      dryRun: extra.dryRun,
    });
  };

  const gateFail = checkMasterGates();
  if (gateFail) {
    logEvent("invocationDisabled", { reason: gateFail.reason });
    captureTelemetry("disabled", { gateReason: gateFail.reason });
    return gateFail;
  }

  const meta = translation.registeredPrimitive;
  if (!meta) {
    const reason =
      "no registeredPrimitive metadata on TranslatedAction; nothing to invoke";
    logEvent("invocationSkipped", { reason });
    captureTelemetry("skipped_missing_metadata", { gateReason: reason });
    return { kind: "skipped", reason };
  }

  if (!isFamilyExecutorEnabled(meta.family)) {
    const envName = FAMILY_ENABLED_ENV[meta.family];
    const reason = envName
      ? `${envName} is OFF; family executor disabled`
      : `family executor disabled (no enabled-flag mapping for family=${meta.family})`;
    logEvent("invocationSkipped", { family: meta.family, id: meta.id, reason });
    captureTelemetry("skipped_family_disabled", {
      family: meta.family,
      id: meta.id,
      gateReason: reason,
    });
    // Family-level gate intentionally surfaces as `skipped` rather than
    // `disabled` because the *master* gates passed. Callers / telemetry
    // distinguish "all-off" (disabled) from "this family opted-out"
    // (skipped) cleanly.
    return { kind: "skipped", reason, family: meta.family, id: meta.id };
  }

  const primitive: Primitive | undefined = getPrimitive(meta.family, meta.id);
  if (!primitive) {
    const reason = `no primitive registered under ${meta.family}::${meta.id}`;
    logEvent("invocationSkipped", { family: meta.family, id: meta.id, reason });
    captureTelemetry("skipped_unknown_primitive", {
      family: meta.family,
      id: meta.id,
      gateReason: reason,
    });
    return { kind: "skipped", reason, family: meta.family, id: meta.id };
  }

  const dryRun = familyDryRunSnapshot(meta.family);

  let result: PrimitiveExecutionResult;
  try {
    result = await primitive.execute(ctx);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("invocationError", {
      family: meta.family,
      id: meta.id,
      error: msg,
    });
    captureTelemetry("error", {
      family: meta.family,
      id: meta.id,
      resultReason: msg,
      dryRun,
    });
    return { kind: "error", family: meta.family, id: meta.id, error: msg };
  }

  if (result.ok) {
    logEvent("invocationOk", { family: meta.family, id: meta.id });
    captureTelemetry("ok", {
      family: meta.family,
      id: meta.id,
      resultReason: result.reason,
      dryRun,
    });
    return { kind: "ok", family: meta.family, id: meta.id, result };
  }

  logEvent("invocationRefused", {
    family: meta.family,
    id: meta.id,
    reason: result.reason ?? "",
  });
  captureTelemetry("refused", {
    family: meta.family,
    id: meta.id,
    resultReason: result.reason,
    dryRun,
  });
  return { kind: "refused", family: meta.family, id: meta.id, result };
}

/**
 * Best-effort snapshot of whether the family executor will run under
 * dry-run semantics. Pure read of env; returns `undefined` for families
 * without a dry-run flag mapping (today: any future family beyond the
 * scaffolded three). Used only for telemetry — the executor's own
 * behavior is unchanged.
 */
function familyDryRunSnapshot(
  family: PrimitiveFamily,
): boolean | undefined {
  switch (family) {
    case "synthesis":
      return isSynthesisExecutorDryRun();
    case "artifact":
      return isArtifactExecutorDryRun();
    case "other":
      return isOtherExecutorDryRun();
    default:
      return undefined;
  }
}
