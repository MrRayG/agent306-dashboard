// ---------------------------------------------------------------------------
// 306 — PRIMITIVE REGISTRY (scaffolding only)
//
// First step in the phased implementation of the self-evolving primitives
// architecture described in docs/design/0001-self-evolving-primitives.md
// (PR #418, advisory). This file adds the *seam* — types + a singleton
// registry + a lookup helper — that subsequent PRs will plug executors into:
//
//   PR #423: synthesis primitive executor
//   PR #424: artifact primitive executor
//   PR #425: other / threading primitive executor
//
// What this module DOES today
// ---------------------------
//   - Declares the types (`PrimitiveFamily`, `Primitive`, `PrimitiveExecutor`,
//     `PrimitiveExecutionResult`) future executors implement.
//   - Provides a module-scoped singleton registry with `registerPrimitive`,
//     `getPrimitive`, `listPrimitives`, `listFamilies`, and (test-only)
//     `__resetForTests`.
//   - Exposes `lookupPrimitiveForFamily(family)` which the action translator
//     calls before falling through to its `{ primitive: "none", reason }`
//     branch. With zero primitives registered today, the lookup always
//     returns `null` and translator behavior is byte-identical.
//   - Gates the entire lookup path behind `PRIMITIVE_REGISTRY_ENABLED`
//     (default `false`). With the flag off, the registry is never consulted.
//
// What this module DOES NOT do today
// ----------------------------------
//   - Register any primitives. No executor exists yet.
//   - Touch obligation/gating code from PRs #419/#420/#421.
//   - Persist anything. Registry is in-memory only; the design doc's
//     `primitive_registry` table is deferred to a later PR.
//   - Change DB schema, the dashboard, or any external surface.
//   - Modify `selfRecommendationEngine.applyRecommendation` or the
//     promotion boundary — Pin 7 and Pin 11 are untouched.
//
// Safety guarantees
// -----------------
//   - Default-off via PRIMITIVE_REGISTRY_ENABLED. Same pattern as
//     OBLIGATION_ESCALATION_ENABLED from PR #419.
//   - With the flag OFF: the new lookup path returns null without
//     consulting the registry at all (early return on the env read).
//   - With the flag ON and the registry empty: the lookup still returns
//     null because no primitives are registered. Translator behavior is
//     byte-identical to flag-OFF.
//   - Conflict handling: registering two primitives with the same
//     (family, id) pair throws at registration time. We want this to
//     surface as a startup failure, never silent.
// ---------------------------------------------------------------------------

import type { MissingPrimitiveFamily } from "../actionTranslator.js";

/**
 * Master env flag name. When `process.env[PRIMITIVE_REGISTRY_ENABLED_ENV]`
 * is not the literal string `"true"`, the registry is not consulted by the
 * action translator. Default: OFF.
 */
export const PRIMITIVE_REGISTRY_ENABLED_ENV = "PRIMITIVE_REGISTRY_ENABLED";

/**
 * Dispatch-gate env flag. When `process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV]`
 * is not the literal string `"true"`, the translator MUST treat the registry
 * lookup result as if it did not exist — `TranslatedAction` shape is
 * byte-identical to pre-#427 main. When set to `"true"` AND
 * PRIMITIVE_REGISTRY_ENABLED is also `"true"` AND a primitive is registered
 * for the family, the translator attaches a `registeredPrimitive` metadata
 * field on the fall-through return. The `primitive` field stays `"none"`,
 * so `applyRecommendation` / `maybeRegisterRuleForRecommendation` continue
 * to treat the rec as `untranslatable`. This is the first controlled
 * dispatch phase — metadata-only, no executor invocation, no rule
 * registration impact, no promotion-gate or obligation impact.
 *
 * Default: OFF. Independent of PRIMITIVE_REGISTRY_ENABLED — both must be
 * ON for the dispatch path to surface metadata. With this flag OFF,
 * translator output is byte-identical regardless of registry state.
 */
export const PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV =
  "PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED";

/**
 * Telemetry tag for [EVENT] log lines emitted by this module. Mirrors the
 * `engine=<name> event=<...>` convention used elsewhere in the codebase
 * (see ruleCorrectiveObligations, actionEnforcer).
 */
export const PRIMITIVE_REGISTRY_TELEMETRY_ENGINE = "primitive-registry";

/**
 * The family axis a primitive belongs to.
 *
 * We reuse `MissingPrimitiveFamily` (defined in `server/actionTranslator.ts`)
 * rather than redefining a parallel set. The translator's missing-primitive
 * classifier already maps action text to one of these labels, so future
 * executors register under the same key the translator looks up by.
 *
 * Today's auto-cycle produced three missing-primitive recs — `synthesis`,
 * `artifact`, and `other` — which are exactly the family labels PRs #423,
 * #424, and #425 will plug executors into.
 */
export type PrimitiveFamily = MissingPrimitiveFamily;

/**
 * Structured result a primitive executor returns to the caller. This is
 * the contract subsequent PRs will fulfill. We keep it small and
 * deliberately not-DB-shaped so future persistence is an additive change.
 */
export interface PrimitiveExecutionResult {
  /** True iff the executor ran its side effect to completion. */
  ok: boolean;
  /**
   * Free-form observations the executor wants surfaced (e.g. "skipped:
   * inputs missing", "synthesized 1 entry"). Surfaces in telemetry and
   * eventually in the dashboard. Keep short.
   */
  observations?: readonly string[];
  /**
   * Append-only log of side effects the executor performed (or would
   * have performed in dry-run). Future PRs will format these for the
   * audit trail.
   */
  sideEffects?: readonly string[];
  /**
   * Human-readable reason, when `ok` is false. Surfaces in the rule
   * registration event the same way the translator's existing `reason`
   * field does today.
   */
  reason?: string;
}

/**
 * Context passed to an executor at dispatch time. Deliberately minimal —
 * we add fields as concrete executors need them. Keep this interface
 * append-only.
 */
export interface PrimitiveExecutionContext {
  /** The raw action text that triggered the lookup. */
  readonly actionText: string;
  /** The insight text associated with the action (may be empty). */
  readonly insightText: string;
  /**
   * The recommendation id, when the dispatch is happening inside the
   * apply-rec path. Optional because the registry is also useful for
   * direct dispatch from tests.
   */
  readonly recommendationId?: string;
  /** The source-insight id, mirrors `selfRecommendations.sourceInsightId`. */
  readonly sourceInsightId?: string;
}

/**
 * The shape future executors implement. Async because real executors will
 * call LLMs, write to the DB, or both.
 *
 * Today: no executor is registered. PR #423 will register the first.
 */
export type PrimitiveExecutor = (
  ctx: PrimitiveExecutionContext,
) => Promise<PrimitiveExecutionResult>;

/**
 * A registered primitive: an executor plus the family/id it dispatches
 * for, plus declarative metadata that future PRs may surface in the
 * dashboard.
 */
export interface Primitive {
  /** The family axis (see {@link PrimitiveFamily}). */
  readonly family: PrimitiveFamily;
  /**
   * Identifier unique within the family. Lowercase, [a-z0-9_-]+.
   * Together with `family` forms the registry key.
   */
  readonly id: string;
  /** Operator-readable summary of what this primitive does. */
  readonly description: string;
  /** The async dispatcher. */
  readonly execute: PrimitiveExecutor;
}

// ─── singleton state ─────────────────────────────────────────────────────────
//
// Module-scoped singleton (as opposed to a DI'd registry instance) keeps the
// call sites trivial. Tests reset via `__resetForTests()`.

const VALID_ID_RE = /^[a-z0-9_-]+$/;

const registry: Map<string, Primitive> = new Map();

function keyOf(family: PrimitiveFamily, id: string): string {
  return `${family}::${id}`;
}

/** Telemetry helper. Mirrors the `[EVENT]` convention. */
function logEvent(event: string, extra: Record<string, unknown> = {}): void {
  const parts = Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  console.log(
    `[EVENT] engine=${PRIMITIVE_REGISTRY_TELEMETRY_ENGINE} event=${event}${parts ? " " + parts : ""}`,
  );
}

/**
 * Read the master env flag. Treated as the only source of truth — we do
 * NOT memoize the value, so the flag can be flipped between cycles
 * without restarting the process (matches the PR #419 convention).
 */
export function isPrimitiveRegistryEnabled(): boolean {
  return process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] === "true";
}

/**
 * Read the dispatch-gate env flag. Not memoized — flip without restart.
 *
 * Returning `true` does NOT by itself cause the translator to attach
 * metadata: the master `PRIMITIVE_REGISTRY_ENABLED` flag must also be
 * `"true"` and a primitive must be registered for the family. The
 * dispatch gate is the additional opt-in beyond the registry being
 * populated.
 */
export function isPrimitiveTranslatorDispatchEnabled(): boolean {
  return process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] === "true";
}

/**
 * Register a primitive. Throws if:
 *   - `id` is empty or fails `[a-z0-9_-]+`.
 *   - A primitive with the same (family, id) pair is already registered.
 *
 * The conflict throw is deliberate. Two primitives claiming the same
 * (family, id) is a wiring bug we want surfaced at module load, not
 * silently masked.
 */
export function registerPrimitive(p: Primitive): void {
  if (!p.id || !VALID_ID_RE.test(p.id)) {
    throw new Error(
      `[primitive-registry] invalid primitive id "${p.id}" (must match /^[a-z0-9_-]+$/)`,
    );
  }
  if (typeof p.execute !== "function") {
    throw new Error(
      `[primitive-registry] primitive ${p.family}::${p.id} must provide an execute function`,
    );
  }
  const k = keyOf(p.family, p.id);
  if (registry.has(k)) {
    throw new Error(
      `[primitive-registry] duplicate primitive registration: ${k}`,
    );
  }
  registry.set(k, p);
  logEvent("primitiveRegistered", { family: p.family, id: p.id });
}

/**
 * Look up a specific primitive by (family, id). Returns `undefined` when
 * no primitive matches.
 */
export function getPrimitive(
  family: PrimitiveFamily,
  id: string,
): Primitive | undefined {
  return registry.get(keyOf(family, id));
}

/**
 * Return all currently-registered primitives. Order is insertion order
 * (Map iteration order).
 */
export function listPrimitives(): readonly Primitive[] {
  return Array.from(registry.values());
}

/**
 * Return the set of families that currently have at least one registered
 * primitive. Useful for the dashboard / debugging.
 */
export function listFamilies(): readonly PrimitiveFamily[] {
  const seen = new Set<PrimitiveFamily>();
  for (const p of registry.values()) seen.add(p.family);
  return Array.from(seen);
}

/**
 * Action-translator lookup hook.
 *
 * Called from `translateAction` immediately before the final
 * `{ primitive: "none", reason: "No primitive matched action: ..." }`
 * fall-through (server/actionTranslator.ts ~line 832). Returns the first
 * primitive registered under `family`, or `null` if:
 *   - The master env flag is OFF (default).
 *   - No primitive is registered under that family.
 *
 * Why "first" rather than disambiguating by id: in this scaffolding PR
 * we have a single-executor-per-family model. PRs #423/#424/#425 each
 * register exactly one primitive per family. When a second primitive
 * per family becomes necessary, the translator integration will need a
 * disambiguation hook (likely an action-text regex on each Primitive);
 * out of scope for this PR.
 *
 * Behavior preservation: with the flag OFF, this returns `null` after a
 * single env read — no Map iteration, no telemetry. With the flag ON
 * and the registry empty (today's state), this also returns `null`
 * after the Map lookup. Either way, the translator falls through
 * identically to today.
 */
export function lookupPrimitiveForFamily(
  family: PrimitiveFamily,
): Primitive | null {
  if (!isPrimitiveRegistryEnabled()) return null;
  for (const p of registry.values()) {
    if (p.family === family) {
      logEvent("primitiveLookupHit", { family, id: p.id });
      return p;
    }
  }
  logEvent("primitiveLookupMiss", { family });
  return null;
}

/**
 * Test-only reset. Not part of the public surface; consumers in
 * production code MUST NOT call this. Exported as a named export with
 * the `__` prefix so it's obvious in call sites.
 */
export function __resetForTests(): void {
  registry.clear();
}
