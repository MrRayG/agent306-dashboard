// ---------------------------------------------------------------------------
// 306 — SELF-INTEGRITY PRIMITIVE COVERAGE DIAGNOSTIC (additive, lifecycle-neutral)
//
// Companion to:
//   - PR #429 (guarded executor invocation path / dispatcher telemetry)
//   - PR #430 (dry-run telemetry + reconciler awareness)
//   - PR #433-#435 (synthesis/artifact/other scaffold registration + guarded
//     dispatch validated in production logs on 2026-05-27)
//   - PR #437 (Grammar v2.6 scorecard freshness restore)
//
// PROBLEM
//   The May 27 production-log validation showed primitive dry-run dispatch
//   is working end-to-end for the synthesis/artifact/other families:
//
//     [EVENT] engine=primitive-registry event=primitiveLookupHit family=other id=scaffold
//     [EVENT] engine=primitive-dispatcher event=invocationOk family=other ...
//     [EVENT] engine=primitive-dispatch event=dispatch_ok dryRun=true ...
//     dryRunExecuted
//
//   But Self-Integrity / the insight ledger / the metacognition response
//   still treat every "missing-primitive: <family>" rec as a parser-coverage
//   gap — i.e. as if the family were entirely unsupported. There is no
//   place in the surface that distinguishes "no primitive at all" from
//   "registered + dry-run dispatch working", so the Self-Integrity narrative
//   doesn't reflect the work PRs #423-#437 actually shipped.
//
//   This module adds a finer 5-state classification on top of the coarse
//   3-state `classifyPrimitiveCoverageForFamily` in `coverageDiagnostic.ts`:
//
//     unsupported            — no primitive registered for this family
//     registered             — primitive registered, but not all gates ON
//     lookup_hit             — gates ON; dispatcher could route here, no
//                              observed invocation in the telemetry buffer
//     dry_run_invoked        — dispatcher telemetry shows at least one `ok`
//                              outcome under dry-run for this family
//     real_execution_pending — dispatcher telemetry shows the executor was
//                              reached (`ok`/`refused`/`error`) but every
//                              observed `ok` outcome was under dry-run;
//                              real (non-dry-run) execution is the next step
//
//   archive and ttl both have scaffolds now (PR #440 + PR-ttl-scaffold)
//   — when the operator opts in via PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED
//   or PRIMITIVE_TTL_EXECUTOR_ENABLED plus the master/dispatch/invocation
//   gates, each family can advance from `unsupported` → `registered` →
//   `lookup_hit` → `dry_run_invoked`. The diagnostic logic is unchanged;
//   the seed-family + registry-keyed reads naturally surface whichever
//   state each family is in right now. With every flag default-OFF
//   (today's deploy), archive and ttl both still classify as
//   `unsupported`.
//
// What this module DOES today
// ---------------------------
//   - Exports `classifySelfIntegrityCoverageForFamily(family, opts?)`
//     returning the 5-state status above.
//   - Exports `summarizeSelfIntegrityCoverage(opts?)` aggregating per-family
//     classification into bucket counts + a per-family breakdown.
//   - Reads only the registry, the gate-flag env, and the in-memory
//     dispatcher telemetry ring buffer. Nothing is mutated.
//   - Optional `nowMs` and `telemetry` overrides for deterministic tests.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Mutate any recommendation lifecycle. The classification is purely
//     observational. `applyRecommendation`, the promotion gate, the
//     missing-primitive reconciler's rejection logic, the rule registration
//     path — none are touched. Pin 7 / Pin 11 invariants are untouched.
//   - Auto-approve, auto-reject, auto-apply, auto-resolve, or hide any
//     existing self-recommendations. Old `missing-primitive:` recs remain
//     in their current `proposed` status even when their family now
//     classifies as `dry_run_invoked` or `real_execution_pending`.
//   - Modify the Self-Integrity SCORE itself
//     (`computeLedgerStats.selfIntegrityScore`). The score is unchanged
//     by the presence/absence of this diagnostic.
//   - Persist anything. No DB write, no journal entry, no rec mutation.
//   - Invoke the dispatcher / any executor. We only inspect the existing
//     ring buffer that the dispatcher has already populated as a side
//     effect of normal operation.
//
// Safety guarantees
// -----------------
//   - Pure / side-effect-free. The functions can be called freely.
//   - Default-off opt-in at the caller layer via
//     `SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED` (default: OFF). With
//     the flag OFF, callers omit the diagnostic block from public API
//     output and the metacognition response shape is byte-identical
//     to pre-PR.
//   - With the flag ON, the diagnostic block is added under a new key
//     (`primitiveCoverage`) on the metacognition response. Consumers
//     that don't reference it are unaffected.
//   - Existing missing-primitive recs are NOT closed or mutated. The
//     coverage block carries an additive `coveredFamilies` set the UI
//     can use to annotate stale recs as "now covered in dry-run" without
//     changing the rec row itself.
// ---------------------------------------------------------------------------

import {
  classifyPrimitiveCoverageForFamily,
  type PrimitiveCoverageStatus,
} from "./coverageDiagnostic.js";
import {
  getRecentDispatchTelemetry,
  type DispatchTelemetryRecord,
} from "./telemetry.js";
import { listFamilies, type PrimitiveFamily } from "./registry.js";

/**
 * Master env flag controlling whether the public-API + metacognition
 * surface includes the Self-Integrity primitive-coverage diagnostic
 * block. Default: OFF. With the flag OFF, the surface is byte-identical
 * to pre-PR.
 *
 * Independent of the diagnostic functions themselves — those remain
 * read-only and callable regardless of this flag (the reconciler /
 * tests may consult them directly).
 */
export const SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV =
  "SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED";

/**
 * Finer 5-state coverage status used by the Self-Integrity surface.
 * Ordered from least to most ready.
 *
 * - `unsupported`            no primitive registered for this family
 * - `registered`             primitive registered, but not every gate is ON,
 *                            so the dispatcher would not invoke it today
 * - `lookup_hit`             primitive registered AND every gate is ON —
 *                            dispatch is reachable. No observed invocation
 *                            in the telemetry ring buffer yet.
 * - `dry_run_invoked`        dispatcher telemetry shows at least one `ok`
 *                            outcome under dry-run for this family
 * - `real_execution_pending` executor reached at least once (any of
 *                            `ok`/`refused`/`error`); every observed `ok`
 *                            outcome was under dry-run. Real
 *                            (non-dry-run) execution is the next step.
 */
export type SelfIntegrityCoverageStatus =
  | "unsupported"
  | "registered"
  | "lookup_hit"
  | "dry_run_invoked"
  | "real_execution_pending";

export interface SelfIntegrityFamilyCoverage {
  readonly family: PrimitiveFamily;
  readonly status: SelfIntegrityCoverageStatus;
  /** The first registered primitive id for this family, if any. */
  readonly primitiveId?: string;
  /** Coarse 3-state status, for cross-reference. */
  readonly coarseStatus: PrimitiveCoverageStatus;
  /** Whether every gate (registry/dispatch/invocation/family) is ON. */
  readonly gatesAllOn: boolean;
  /**
   * Whether the diagnostic saw at least one dispatcher `ok` outcome
   * under `dryRun === true` for this family within the observed window.
   */
  readonly observedDryRunOk: boolean;
  /**
   * Whether the diagnostic saw any executor-reaching outcome
   * (`ok`/`refused`/`error`) for this family within the observed window.
   * Used to distinguish `lookup_hit` (gates ON but no invocation seen)
   * from `real_execution_pending` (invoked, but only in dry-run so far).
   */
  readonly observedAnyInvocation: boolean;
  /**
   * Human-readable rationale string. Useful for tooltips / why-changed
   * blurbs in the dashboard. Short on purpose.
   */
  readonly explanation: string;
}

export interface SelfIntegrityCoverageReport {
  /** `Date.now()` at the time of report generation. */
  readonly generatedAtMs: number;
  /** Bucket counts. Sum equals `families.length`. */
  readonly buckets: Readonly<Record<SelfIntegrityCoverageStatus, number>>;
  /** Per-family breakdown. */
  readonly families: readonly SelfIntegrityFamilyCoverage[];
  /**
   * Families that are at least `dry_run_invoked` — the UI can use this
   * set to annotate stale `missing-primitive: <family>` recs as
   * "now covered in dry-run" without mutating the rec row.
   */
  readonly coveredFamilies: readonly PrimitiveFamily[];
  /**
   * Families that are still `unsupported` — i.e. no primitive registered.
   * Mirrors the May 27 production state: `archive` and `ttl` remain
   * unresolved/unsupported until their scaffolds land.
   */
  readonly unsupportedFamilies: readonly PrimitiveFamily[];
  /**
   * The window (ms) of dispatcher telemetry the report considered. The
   * dispatcher's ring buffer caps at 200 entries; this field is the
   * span between the oldest and newest captured record, or 0 when the
   * buffer is empty.
   */
  readonly telemetryWindowMs: number;
}

export interface SelfIntegrityCoverageOptions {
  /** Override `Date.now()` (tests). */
  readonly nowMs?: number;
  /**
   * Override the telemetry source (tests). When omitted the module reads
   * the dispatcher's in-memory ring buffer via
   * `getRecentDispatchTelemetry()`.
   */
  readonly telemetry?: readonly DispatchTelemetryRecord[];
  /**
   * Additional families to include in the report even when they have no
   * registered primitive. The missing-primitive reconciler / metacog
   * surface uses this to ensure `archive` and `ttl` appear as
   * `unsupported` in the report rather than being silently dropped.
   */
  readonly extraFamilies?: readonly PrimitiveFamily[];
}

/**
 * Read the master env flag. Treated as the only source of truth — not
 * memoized so an operator can flip it without a restart.
 */
export function isSelfIntegrityPrimitiveCoverageEnabled(): boolean {
  return (
    process.env[SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV] === "true"
  );
}

/**
 * The default seed family set the report considers when no
 * `extraFamilies` are passed. Includes the scaffolded families
 * (`synthesis`, `artifact`, `other`, `archive`) plus the one family that
 * the May 27 production logs called out as still unresolved (`ttl`).
 * This is deliberate: even when a family has no registered primitive
 * AND the rec backlog happens to be empty for that family in a given
 * snapshot, the diagnostic should still report it (`unsupported` /
 * `registered` / etc.) so the Self-Integrity surface tells the truth.
 *
 * NOTE: archive and ttl remain in the seed even though both now have
 * scaffolds, because the seed's job is to keep the report honest about
 * families the operator cares about regardless of whether they're
 * registered yet. Until the operator flips
 * `PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED` / `PRIMITIVE_TTL_EXECUTOR_ENABLED`,
 * each family continues to classify as `unsupported` — the seed just
 * guarantees it appears in the report.
 */
const DEFAULT_SEED_FAMILIES: readonly PrimitiveFamily[] = [
  "synthesis",
  "artifact",
  "other",
  "archive",
  "ttl",
];

/**
 * Classify ONE family under the 5-state Self-Integrity model.
 *
 * Pure: reads the registry, gate flags, and the telemetry buffer. Does
 * not invoke any executor, does not mutate any state.
 */
export function classifySelfIntegrityCoverageForFamily(
  family: PrimitiveFamily,
  opts: SelfIntegrityCoverageOptions = {},
): SelfIntegrityFamilyCoverage {
  const coarse = classifyPrimitiveCoverageForFamily(family);
  const gatesAllOn = coarse.status === "dispatch_capable";

  const telemetry =
    opts.telemetry ?? getRecentDispatchTelemetry();
  const familyRecords = telemetry.filter((r) => r.family === family);
  const observedAnyInvocation = familyRecords.some(
    (r) => r.kind === "ok" || r.kind === "refused" || r.kind === "error",
  );
  const observedDryRunOk = familyRecords.some(
    (r) => r.kind === "ok" && r.dryRun === true,
  );

  // Did we ever see a non-dry-run executor attempt? If the dispatcher
  // ran the executor outside dry-run mode (regardless of `ok` /
  // `refused` / `error`), that's the signal that "real execution" is
  // actively being attempted. Today every scaffolded executor refuses
  // non-dry-run, so this is mostly a forward-looking distinction.
  const observedNonDryRunAttempt = familyRecords.some(
    (r) =>
      (r.kind === "ok" || r.kind === "refused" || r.kind === "error") &&
      r.dryRun === false,
  );

  let status: SelfIntegrityCoverageStatus;
  if (coarse.status === "not_registered") {
    status = "unsupported";
  } else if (!gatesAllOn) {
    status = "registered";
  } else if (observedNonDryRunAttempt) {
    // Gates ON, dispatcher reached the executor outside dry-run mode at
    // least once. Real execution is the active next step — the
    // scaffolded executors refuse today, so this surfaces the wiring
    // gap precisely.
    status = "real_execution_pending";
  } else if (observedDryRunOk) {
    // Gates ON, at least one successful dry-run dispatch observed.
    // This is the May 27 production state for synthesis/artifact/other:
    // `dryRunExecuted`.
    status = "dry_run_invoked";
  } else {
    // Gates ON. Either executor never reached in the observed window
    // (immediately after startup, before any rec triggers a dispatch)
    // OR only refused/errored dry-run attempts so far. Surfacing as
    // `lookup_hit` keeps the bucket meaning "dispatch path reachable
    // but no successful dry-run yet". This is conservative — we never
    // claim dry-run coverage without an observed `ok` outcome.
    status = "lookup_hit";
  }

  return {
    family,
    status,
    primitiveId: coarse.primitiveId,
    coarseStatus: coarse.status,
    gatesAllOn,
    observedDryRunOk,
    observedAnyInvocation,
    explanation: explainStatus({
      family,
      status,
      gatesAllOn,
      observedDryRunOk,
      observedAnyInvocation,
      primitiveId: coarse.primitiveId,
    }),
  };
}

/**
 * Build the full Self-Integrity coverage report. Includes:
 *   - the default seed families (synthesis/artifact/other/archive/ttl);
 *   - any family currently in the primitive registry;
 *   - any `extraFamilies` passed by the caller (e.g. families observed
 *     in the rec backlog by the reconciler).
 *
 * Pure: never mutates state.
 */
export function summarizeSelfIntegrityCoverage(
  opts: SelfIntegrityCoverageOptions = {},
): SelfIntegrityCoverageReport {
  const seen = new Set<PrimitiveFamily>(DEFAULT_SEED_FAMILIES);
  for (const f of listFamilies()) seen.add(f);
  for (const f of opts.extraFamilies ?? []) seen.add(f);

  const families = Array.from(seen).map((f) =>
    classifySelfIntegrityCoverageForFamily(f, opts),
  );

  const buckets: Record<SelfIntegrityCoverageStatus, number> = {
    unsupported: 0,
    registered: 0,
    lookup_hit: 0,
    dry_run_invoked: 0,
    real_execution_pending: 0,
  };
  for (const f of families) buckets[f.status]++;

  const coveredFamilies = families
    .filter(
      (f) =>
        f.status === "dry_run_invoked" || f.status === "real_execution_pending",
    )
    .map((f) => f.family);
  const unsupportedFamilies = families
    .filter((f) => f.status === "unsupported")
    .map((f) => f.family);

  const telemetry = opts.telemetry ?? getRecentDispatchTelemetry();
  let telemetryWindowMs = 0;
  if (telemetry.length > 1) {
    const sorted = telemetry
      .map((r) => r.timestampMs)
      .filter((t) => typeof t === "number")
      .sort((a, b) => a - b);
    if (sorted.length > 1) {
      telemetryWindowMs = sorted[sorted.length - 1] - sorted[0];
    }
  }

  return {
    generatedAtMs: opts.nowMs ?? Date.now(),
    buckets,
    families,
    coveredFamilies,
    unsupportedFamilies,
    telemetryWindowMs,
  };
}

function explainStatus(input: {
  family: PrimitiveFamily;
  status: SelfIntegrityCoverageStatus;
  gatesAllOn: boolean;
  observedDryRunOk: boolean;
  observedAnyInvocation: boolean;
  primitiveId?: string;
}): string {
  const { family, status, primitiveId } = input;
  switch (status) {
    case "unsupported":
      return `No primitive registered for the ${family} family — coverage gap is real.`;
    case "registered":
      return primitiveId
        ? `${family}::${primitiveId} is registered, but not every gate is ON; dispatcher would not invoke today.`
        : `${family} primitive registered, but not every gate is ON.`;
    case "lookup_hit":
      return primitiveId
        ? `${family}::${primitiveId} is registered and every gate is ON; dispatcher is reachable but no invocation observed yet.`
        : `${family} dispatch path reachable; no invocation observed yet.`;
    case "dry_run_invoked":
      return primitiveId
        ? `${family}::${primitiveId} dispatched successfully under dry-run; real execution not yet attempted.`
        : `${family} dry-run dispatch observed.`;
    case "real_execution_pending":
      return primitiveId
        ? `${family}::${primitiveId} reached by dispatcher outside dry-run; awaiting successful non-dry-run execution.`
        : `${family} executor reached outside dry-run; real execution pending.`;
  }
}
