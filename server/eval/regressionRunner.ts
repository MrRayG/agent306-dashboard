/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — REGRESSION RUNNER (spec §5)
 *
 * Runs golden sets against the current engine code and produces a pass/fail
 * report. Used by the promotion gate to block self-change applications on
 * any failing case.
 *
 * Two execution modes are supported:
 *
 *   1. Simple, declarative cases (voice, hypothesisTriage, modelRouter):
 *      `fn` is a string like "voice.buildVoiceBlock"; we resolve the module
 *      via a small static MODULES registry and run the case through the
 *      declarative `expect` matcher. No dynamic imports, no string→path
 *      resolution.
 *
 *   2. Async handler-driven sets (claimVerifier and any future surface
 *      whose contract doesn't fit a single fn-call shape): the set name is
 *      mapped to an async handler in HANDLERS. The handler reads the set,
 *      runs each case through the real engine code, and returns
 *      CaseResults. This is how `claimVerifier.golden.json` is enforced —
 *      `verifyClaims()` is async, so it cannot be expressed via the simple
 *      MODULES path.
 *
 * COVERAGE INVARIANT: every golden file on disk must be reachable by either
 * (a) a registered HANDLERS entry, or (b) at least one case whose `fn`
 * resolves into MODULES. If a golden file is unreachable, runAllGoldenSets
 * surfaces it as a synthetic failure rather than silently skipping it.
 * Phase 1 audit found `claimVerifier.golden.json` was being silently
 * skipped because no handler was registered — that bypass is closed here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { loadGoldenSets, type GoldenCase, type GoldenSet, type GoldenExpect } from "./goldenSets.js";
import * as voice from "../voice.js";
import * as hypothesisTriage from "../hypothesisTriage.js";
import * as modelRouter from "../modelRouter.js";
import { runClaimVerifierGoldenSet } from "./claimVerifierHandler.js";

type FnRegistry = Record<string, Record<string, unknown>>;

/**
 * Static registry of modules the simple golden runner can address.
 * Intentionally explicit — we never resolve a `fn` string into a dynamic
 * import. Adding a new module here is the mechanism for a new simple
 * golden case surface.
 */
const MODULES: FnRegistry = {
  voice: voice as any,
  hypothesisTriage: hypothesisTriage as any,
  modelRouter: modelRouter as any,
};

/**
 * Async handlers for golden sets that don't fit the simple fn-call shape.
 * Keyed by set name (matches `name` field in the JSON file). Each handler
 * is responsible for running every case in the set and returning a flat
 * array of CaseResults.
 */
const HANDLERS: Record<string, (set: GoldenSet) => Promise<CaseResult[]>> = {
  claimVerifier: runClaimVerifierGoldenSet,
};

export interface CaseResult {
  setName: string;
  caseId: string;
  ok: boolean;
  reason?: string;
  actual?: unknown;
}

export interface RegressionReport {
  ranAt: string;
  sets: Array<{ name: string; version: number; total: number; passed: number; failed: number }>;
  results: CaseResult[];
  overallOk: boolean;
}

function resolveFn(spec: string): { fn: (...args: any[]) => unknown } | { value: unknown } | { error: string } {
  const [mod, name] = spec.split(".", 2);
  if (!mod || !name) return { error: `malformed fn spec: ${spec}` };
  const registry = MODULES[mod];
  if (!registry) return { error: `unknown module: ${mod}` };
  const target = registry[name];
  if (target === undefined) return { error: `unknown export: ${spec}` };
  if (typeof target === "function") return { fn: target as (...args: any[]) => unknown };
  return { value: target };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a as any).sort();
  const kb = Object.keys(b as any).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual((a as any)[ka[i]], (b as any)[kb[i]])) return false;
  }
  return true;
}

function checkExpect(actual: unknown, expect: GoldenExpect): { ok: boolean; reason?: string } {
  switch (expect.kind) {
    case "equals":
      return deepEqual(actual, expect.value)
        ? { ok: true }
        : { ok: false, reason: `expected ${JSON.stringify(expect.value)}, got ${JSON.stringify(actual)}` };
    case "contains": {
      const needle = String(expect.value);
      if (typeof actual === "string" && actual.includes(needle)) return { ok: true };
      if (Array.isArray(actual) && actual.includes(expect.value)) return { ok: true };
      return { ok: false, reason: `expected to contain ${needle}` };
    }
    case "minLength": {
      const min = Number(expect.value);
      const len = (actual as any)?.length;
      return typeof len === "number" && len >= min
        ? { ok: true }
        : { ok: false, reason: `expected length >= ${min}, got ${len}` };
    }
    case "objectContains": {
      const expected = expect.value as Record<string, unknown>;
      if (!actual || typeof actual !== "object") return { ok: false, reason: "actual is not an object" };
      for (const [k, v] of Object.entries(expected)) {
        if (!deepEqual((actual as any)[k], v)) {
          return { ok: false, reason: `key ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify((actual as any)[k])}` };
        }
      }
      return { ok: true };
    }
    case "greaterThan": {
      return typeof actual === "number" && actual > Number(expect.value)
        ? { ok: true }
        : { ok: false, reason: `expected > ${expect.value}, got ${JSON.stringify(actual)}` };
    }
    case "truthy":
      return actual ? { ok: true } : { ok: false, reason: "expected truthy" };
    default:
      return { ok: false, reason: `unknown expect.kind: ${(expect as any).kind}` };
  }
}

export function runCase(setName: string, c: GoldenCase): CaseResult {
  const resolved = resolveFn(c.fn);
  if ("error" in resolved) {
    return { setName, caseId: c.id, ok: false, reason: resolved.error };
  }
  let actual: unknown;
  try {
    actual = "fn" in resolved ? resolved.fn(...(c.args ?? [])) : resolved.value;
  } catch (e: any) {
    return { setName, caseId: c.id, ok: false, reason: `fn threw: ${e?.message}` };
  }
  const check = checkExpect(actual, c.expect);
  return { setName, caseId: c.id, ok: check.ok, reason: check.reason, actual };
}

export function runGoldenSet(set: GoldenSet): CaseResult[] {
  return set.cases.map(c => runCase(set.name, c));
}

/**
 * Decide whether a set is meant to be run by an async handler. We match by
 * name first (explicit registration is authoritative); otherwise we treat
 * it as a simple fn-call set.
 */
function isHandlerSet(set: GoldenSet): boolean {
  return Object.prototype.hasOwnProperty.call(HANDLERS, set.name);
}

/**
 * Async-aware runner. Handler-backed sets (claimVerifier, …) are awaited.
 * Simple sets continue to run synchronously inside the same loop. The
 * promotion gate calls this — see canPromote().
 */
export async function runAllGoldenSets(): Promise<RegressionReport> {
  const sets = loadGoldenSets();
  const results: CaseResult[] = [];
  const summary: RegressionReport["sets"] = [];

  // Coverage assertion — every golden file MUST be reachable by either a
  // registered handler or by case-level fn resolution. If a file is on
  // disk but unreachable, surface it as a synthetic failure so the gate
  // blocks rather than silently passing.
  for (const s of sets) {
    if (isHandlerSet(s)) continue;
    if (s.cases.length === 0) {
      results.push({
        setName: s.name,
        caseId: "__coverage__",
        ok: false,
        reason: `golden set "${s.name}" has no cases AND no async handler — register one in regressionRunner HANDLERS or add cases`,
      });
      summary.push({ name: s.name, version: s.version, total: 1, passed: 0, failed: 1 });
      continue;
    }
    const unreachable = s.cases
      .map(c => ({ c, r: resolveFn(c.fn) }))
      .filter(({ r }) => "error" in r);
    if (unreachable.length === s.cases.length) {
      results.push({
        setName: s.name,
        caseId: "__coverage__",
        ok: false,
        reason: `golden set "${s.name}" has no resolvable cases — register a handler or expose the module in MODULES`,
      });
      summary.push({ name: s.name, version: s.version, total: 1, passed: 0, failed: 1 });
      continue;
    }
    const r = runGoldenSet(s);
    results.push(...r);
    const passed = r.filter(x => x.ok).length;
    summary.push({ name: s.name, version: s.version, total: r.length, passed, failed: r.length - passed });
  }

  for (const s of sets) {
    if (!isHandlerSet(s)) continue;
    const handler = HANDLERS[s.name];
    let r: CaseResult[];
    try {
      r = await handler(s);
    } catch (e: any) {
      r = [{ setName: s.name, caseId: "__handler__", ok: false, reason: `handler threw: ${e?.message ?? e}` }];
    }
    results.push(...r);
    const passed = r.filter(x => x.ok).length;
    summary.push({ name: s.name, version: s.version, total: r.length, passed, failed: r.length - passed });
  }

  return {
    ranAt: new Date().toISOString(),
    sets: summary,
    results,
    overallOk: results.every(r => r.ok),
  };
}

/**
 * Test-only helper: list the set names the runner will dispatch through an
 * async handler. Used by the coverage assertion test in
 * server/__tests__/regressionRunnerCoverage.test.ts.
 */
export function listRegisteredHandlers(): string[] {
  return Object.keys(HANDLERS);
}

/** Test-only helper for coverage assertions. */
export function listRegisteredModules(): string[] {
  return Object.keys(MODULES);
}
