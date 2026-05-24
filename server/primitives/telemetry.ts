// ---------------------------------------------------------------------------
// 306 — PRIMITIVE DISPATCH TELEMETRY (observability for guarded invocation)
//
// Successor to PR #429 (guarded executor invocation path). PR #429 added the
// guarded `invokeRegisteredPrimitive` dispatcher and emitted plain `[EVENT]`
// console lines for each outcome. This module adds a thin *structured*
// telemetry layer on top — capturing the same outcome set as records that
// callers/tests can read back, and optionally forwarding them through the
// existing `observability/structuredLog.logEvent` sink (which persists to
// `engine_events`).
//
// What this module DOES today
// ---------------------------
//   - Exposes a `recordDispatchTelemetry(record)` entrypoint that the
//     dispatcher calls once per `DispatchResult` it returns. Each record
//     captures the dispatcher outcome (`kind`), the family/id when known,
//     the gate state (`gateReason`), the result reason on `refused`, the
//     error message on `error`, plus a stable action hash and a timestamp.
//   - Default-off: no record is forwarded to `logEvent` unless
//     `PRIMITIVE_DISPATCH_TELEMETRY_ENABLED === "true"`. With the flag OFF
//     this module is a no-op — no DB write, no console echo (the
//     dispatcher's pre-existing `[EVENT]` lines are independent).
//   - Optional in-memory ring buffer (`getRecentDispatchTelemetry()`) for
//     tests + future ops dashboards. Capped at 200 entries to avoid
//     unbounded growth in long-lived processes.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Mutate the dispatcher's `DispatchResult`. The record is derived from
//     the result; the result shape is unchanged.
//   - Change any of the gate flags or invocation semantics. The dispatcher
//     still returns the same `DispatchResult` for the same inputs whether
//     telemetry is enabled or not.
//   - Persist into the recommendations table, journal, or any rule-
//     registration / promotion path. Pin 7 / Pin 11 are not touched.
//   - Add a runtime dependency on the dispatcher returning here — the
//     dispatcher imports this module and calls into it; this module knows
//     nothing about how the dispatcher reaches a verdict.
//
// Safety guarantees
// -----------------
//   - Default-off via PRIMITIVE_DISPATCH_TELEMETRY_ENABLED.
//   - The ring buffer is ALWAYS populated (cheap, in-memory only) so tests
//     can assert on captured records without flipping a flag, but the
//     STRUCTURED LOG sink (`logEvent`, which writes to `engine_events`) is
//     ONLY called when the flag is `"true"`. This keeps the default-deploy
//     observability footprint zero.
//   - The forward sink is wrapped in a try/catch so a logEvent failure
//     never escapes into the dispatcher's caller.
//   - The dispatcher already produces zero records on its hot path under
//     default flags (it returns `disabled` and emits ONE `[EVENT]` line),
//     so adding telemetry capture here cannot generate noisy production
//     logs on a default deploy.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import type { PrimitiveFamily } from "./registry.js";
import { logEvent } from "../observability/structuredLog.js";

/**
 * Master env flag controlling whether captured dispatch records are
 * forwarded to the structured-log sink (`logEvent` → `engine_events`).
 * Default: OFF. The in-memory ring buffer is independent and always on
 * (used by tests), but no DB row is written and no console-echo line is
 * emitted by this module under the default deploy.
 *
 * Not memoized; matches the rest of the primitives stack so operators
 * can flip without a process restart.
 */
export const PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV =
  "PRIMITIVE_DISPATCH_TELEMETRY_ENABLED";

/** Telemetry tag for `[EVENT]` rows emitted via structuredLog. */
export const PRIMITIVE_DISPATCH_TELEMETRY_ENGINE = "primitive-dispatch";

/** Cap on the in-memory ring buffer. Small on purpose. */
const RING_CAP = 200;

/**
 * Discriminator for the captured dispatcher outcome. Mirrors the
 * `DispatchResult["kind"]` values plus the additional family-disabled
 * sub-classification we want surfaced separately so dashboards can
 * distinguish "no metadata" from "family opted out".
 *
 * Keep this list in sync with `DispatchResult` in `dispatcher.ts`.
 */
export type DispatchTelemetryKind =
  | "disabled"
  | "skipped_missing_metadata"
  | "skipped_unknown_primitive"
  | "skipped_family_disabled"
  | "ok"
  | "refused"
  | "error";

/**
 * Structured record captured per dispatcher invocation. Optional fields
 * are only populated when relevant — for example, `family`/`id` are
 * absent on `disabled` and `skipped_missing_metadata`.
 *
 * Fields are intentionally append-only: adding new optional fields here
 * is non-breaking for the in-memory consumer + the structured-log sink.
 */
export interface DispatchTelemetryRecord {
  /** `Date.now()` at the moment the record was created. */
  readonly timestampMs: number;
  /** Coarse outcome bucket; see {@link DispatchTelemetryKind}. */
  readonly kind: DispatchTelemetryKind;
  /** Which family the dispatcher resolved (when known). */
  readonly family?: PrimitiveFamily;
  /** Which primitive id within the family (when known). */
  readonly id?: string;
  /**
   * Stable hex digest of the action text that drove the dispatch.
   * Useful for correlating a dispatcher outcome back to a recommendation
   * without persisting potentially-PII-ish raw action text in
   * `engine_events`. SHA-1 is fine here: this is an identity hint, not a
   * security boundary.
   */
  readonly actionHash?: string;
  /**
   * The recommendation id when the dispatcher was invoked inside an
   * apply-rec path. Today there are NO production call sites, so this
   * field is populated only by tests or future wiring.
   */
  readonly recommendationId?: string;
  /**
   * For `disabled` / `skipped_*` outcomes: the reason text the dispatcher
   * returned. Trimmed to 300 chars to keep records compact.
   */
  readonly gateReason?: string;
  /**
   * Whether the underlying executor was invoked under dry-run semantics.
   * Populated for `ok` / `refused` / `error` when known.
   */
  readonly dryRun?: boolean;
  /**
   * For `refused`: the executor's `reason`. For `error`: the caught
   * error message. Trimmed to 300 chars.
   */
  readonly resultReason?: string;
  /** Caller identification — defaults to "primitive-dispatcher". */
  readonly source: string;
}

const ring: DispatchTelemetryRecord[] = [];

/**
 * Read the master flag. Treated as the only source of truth. Not
 * memoized so an operator can flip it between cycles.
 */
export function isPrimitiveDispatchTelemetryEnabled(): boolean {
  return (
    process.env[PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV] === "true"
  );
}

/**
 * Hash an action string into a short hex digest. Returns `undefined`
 * for empty input so callers can drop the field rather than emit a
 * digest of the empty string (which is misleading).
 */
export function hashActionText(action: string | undefined): string | undefined {
  if (!action) return undefined;
  const trimmed = action.trim();
  if (trimmed.length === 0) return undefined;
  return createHash("sha1").update(trimmed).digest("hex").slice(0, 16);
}

function trimReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.length > 300 ? reason.slice(0, 297) + "..." : reason;
}

/**
 * Capture a single dispatcher outcome. Always appends to the in-memory
 * ring buffer; ONLY forwards to `logEvent` when the master flag is ON.
 */
export function recordDispatchTelemetry(
  input: Omit<DispatchTelemetryRecord, "timestampMs" | "source"> & {
    timestampMs?: number;
    source?: string;
  },
): DispatchTelemetryRecord {
  const record: DispatchTelemetryRecord = {
    timestampMs: input.timestampMs ?? Date.now(),
    kind: input.kind,
    family: input.family,
    id: input.id,
    actionHash: input.actionHash,
    recommendationId: input.recommendationId,
    gateReason: trimReason(input.gateReason),
    dryRun: input.dryRun,
    resultReason: trimReason(input.resultReason),
    source: input.source ?? "primitive-dispatcher",
  };

  ring.push(record);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);

  if (isPrimitiveDispatchTelemetryEnabled()) {
    try {
      logEvent({
        engine: PRIMITIVE_DISPATCH_TELEMETRY_ENGINE,
        event: `dispatch_${record.kind}`,
        level: record.kind === "error" ? "warn" : "info",
        data: {
          family: record.family,
          id: record.id,
          actionHash: record.actionHash,
          recommendationId: record.recommendationId,
          gateReason: record.gateReason,
          dryRun: record.dryRun,
          resultReason: record.resultReason,
          source: record.source,
        },
      });
    } catch {
      // Observability must never break the dispatcher's caller. Swallow.
    }
  }

  return record;
}

/**
 * Test / ops helper. Returns a copy of the in-memory ring buffer in
 * insertion order (oldest first). The buffer is shared across the
 * process; tests should call {@link __resetDispatchTelemetryForTests}
 * in their `beforeEach`.
 */
export function getRecentDispatchTelemetry(): readonly DispatchTelemetryRecord[] {
  return ring.slice();
}

/**
 * Test-only reset. Not part of the public surface; production callers
 * MUST NOT invoke this. Exported with the `__` prefix to mirror the
 * registry's `__resetForTests`.
 */
export function __resetDispatchTelemetryForTests(): void {
  ring.length = 0;
}
