// ---------------------------------------------------------------------------
// 306 — PRIMITIVE COVERAGE DIAGNOSTIC (additive, lifecycle-neutral)
//
// Companion to PR #429 (guarded executor invocation path) and the
// dispatcher telemetry module in this PR. Provides a thin, READ-ONLY
// classifier the missing-primitive reconciler can call to answer:
//
//   "Even though the translator still returns 'none' for this rec, is
//    the primitive family it represents now REGISTERED with the
//    primitive registry, and would the dispatcher consider it
//    INVOCABLE under the current flag set?"
//
// The answer is surfaced as additive metadata on the reconciler's
// result. Reconciler lifecycle decisions (which recs get rejected vs.
// left as `proposed`) are UNCHANGED — this module only describes the
// world, it does not act on it.
//
// What this module DOES today
// ---------------------------
//   - Exposes `classifyPrimitiveCoverageForFamily(family)` returning a
//     coarse status (`not_registered` | `registered_only` |
//     `dispatch_capable`). The classifier reads the registry + flag
//     state through the existing public surface; nothing is mutated.
//   - Exposes `summarizeRegisteredPrimitiveCoverage()` returning a
//     small report keyed by family.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Auto-accept, auto-reject, auto-promote, or otherwise change the
//     status of any recommendation. The reconciler still gates on
//     `translateAction(...).primitive !== "none"` for any state
//     transition.
//   - Touch `applyRecommendation`, `maybeRegisterRuleForRecommendation`,
//     the promotion gate, or any obligation/refresh path. Pin 7 / Pin 11
//     are untouched.
//   - Persist anything. No DB write, no journal entry.
//   - Invoke the dispatcher or any registered executor. The "dispatch
//     capable" answer is computed by inspecting the gate flags + the
//     registry, not by attempting a dispatch.
//
// Safety guarantees
// -----------------
//   - Pure / side-effect-free. Calling these functions never mutates
//     module-scoped state.
//   - Default-off opt-in at the caller layer: the reconciler only
//     populates the `primitiveCoverage` diagnostic when
//     `PRIMITIVE_RECONCILER_AWARENESS_ENABLED === "true"`. With the
//     flag OFF the reconciler's output shape is byte-identical to
//     today's. (This module itself does NOT consult the flag — that
//     decision lives at the call site.)
// ---------------------------------------------------------------------------

import {
  isPrimitiveRegistryEnabled,
  isPrimitiveTranslatorDispatchEnabled,
  listFamilies,
  listPrimitives,
  type PrimitiveFamily,
} from "./registry.js";
import {
  isFamilyExecutorEnabled,
  isPrimitiveExecutorInvocationEnabled,
} from "./dispatcher.js";

/**
 * Master env flag controlling whether the missing-primitive reconciler
 * populates the `primitiveCoverage` diagnostic block in its result.
 *
 * Default: OFF. With the flag OFF, the reconciler's result is shape-
 * compatible with every consumer that exists today. With the flag ON,
 * the result gains an optional `primitiveCoverage` field; consumers
 * that don't reference it are unaffected.
 */
export const PRIMITIVE_RECONCILER_AWARENESS_ENABLED_ENV =
  "PRIMITIVE_RECONCILER_AWARENESS_ENABLED";

/**
 * Coarse coverage status for a primitive family. Ordered from least to
 * most "ready" — useful for sorting reports.
 *
 * - `not_registered`     no primitive registered for this family
 * - `registered_only`    a primitive IS registered, but the gates
 *                        (registry + translator-dispatch + invocation
 *                        + per-family) are not all ON, so the
 *                        dispatcher would not invoke it today
 * - `dispatch_capable`   a primitive is registered AND every gate that
 *                        the dispatcher checks is ON; a dispatch attempt
 *                        from a future call site would actually invoke
 *                        the executor
 */
export type PrimitiveCoverageStatus =
  | "not_registered"
  | "registered_only"
  | "dispatch_capable";

export interface FamilyCoverage {
  readonly family: PrimitiveFamily;
  readonly status: PrimitiveCoverageStatus;
  /** The first registered primitive id for this family, if any. */
  readonly primitiveId?: string;
  /**
   * The set of master/family gate flags that must all be ON for the
   * dispatcher to invoke. Each entry is `{ name, on }`. Useful for the
   * reconciler note so an operator can see exactly which flag is
   * holding the family back.
   */
  readonly gates: ReadonlyArray<{ readonly name: string; readonly on: boolean }>;
}

export interface PrimitiveCoverageReport {
  /** Snapshot timestamp (`Date.now()`) for the report. */
  readonly generatedAtMs: number;
  /** Number of families with at least one registered primitive. */
  readonly familiesRegistered: number;
  /** Number of families currently dispatch-capable under the active gates. */
  readonly familiesDispatchCapable: number;
  /** Per-family breakdown. */
  readonly families: readonly FamilyCoverage[];
}

/**
 * Whether the reconciler should populate the `primitiveCoverage` block.
 * Independent from the diagnostic functions themselves — those remain
 * read-only and callable regardless of this flag.
 */
export function isReconcilerAwarenessEnabled(): boolean {
  return (
    process.env[PRIMITIVE_RECONCILER_AWARENESS_ENABLED_ENV] === "true"
  );
}

/**
 * Read-only classification for one family. See {@link PrimitiveCoverageStatus}
 * for the meaning of each value. Pure: does not invoke any executor.
 */
export function classifyPrimitiveCoverageForFamily(
  family: PrimitiveFamily,
): FamilyCoverage {
  const primitive = listPrimitives().find((p) => p.family === family);
  const gates = collectGates(family);
  if (!primitive) {
    return { family, status: "not_registered", gates };
  }
  const allOn = gates.every((g) => g.on);
  return {
    family,
    status: allOn ? "dispatch_capable" : "registered_only",
    primitiveId: primitive.id,
    gates,
  };
}

/**
 * Whole-registry snapshot. Includes every family that has at least one
 * registered primitive today; families with no registration are
 * included only on explicit ask via the `extraFamilies` parameter (used
 * by the reconciler to report on families it observed in the rec
 * backlog even when no primitive is yet registered).
 */
export function summarizeRegisteredPrimitiveCoverage(
  extraFamilies: readonly PrimitiveFamily[] = [],
): PrimitiveCoverageReport {
  const seen = new Set<PrimitiveFamily>(listFamilies());
  for (const f of extraFamilies) seen.add(f);

  const families = Array.from(seen).map(classifyPrimitiveCoverageForFamily);
  const familiesRegistered = families.filter(
    (f) => f.status !== "not_registered",
  ).length;
  const familiesDispatchCapable = families.filter(
    (f) => f.status === "dispatch_capable",
  ).length;
  return {
    generatedAtMs: Date.now(),
    familiesRegistered,
    familiesDispatchCapable,
    families,
  };
}

/**
 * Build the gate list once so the classifier and the report agree on
 * which flags are inspected. The set mirrors `checkMasterGates` +
 * `isFamilyExecutorEnabled` in `dispatcher.ts` so a future reader can
 * cross-reference the two cheaply.
 */
function collectGates(
  family: PrimitiveFamily,
): ReadonlyArray<{ name: string; on: boolean }> {
  return [
    { name: "PRIMITIVE_REGISTRY_ENABLED", on: isPrimitiveRegistryEnabled() },
    {
      name: "PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED",
      on: isPrimitiveTranslatorDispatchEnabled(),
    },
    {
      name: "PRIMITIVE_EXECUTOR_INVOCATION_ENABLED",
      on: isPrimitiveExecutorInvocationEnabled(),
    },
    {
      name: `PRIMITIVE_${family.toUpperCase()}_EXECUTOR_ENABLED`,
      on: isFamilyExecutorEnabled(family),
    },
  ];
}
