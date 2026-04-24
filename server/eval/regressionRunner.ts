/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — REGRESSION RUNNER (spec §5)
 *
 * Runs golden sets against the current engine code and produces a pass/fail
 * report. Used by the promotion gate to block self-change applications on
 * any failing case.
 *
 * Golden case `fn` is a string like "voice.buildVoiceBlock"; we resolve the
 * module by a small registry below to avoid dynamic `require`/`import`
 * with user-controlled paths.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { loadGoldenSets, type GoldenCase, type GoldenSet, type GoldenExpect } from "./goldenSets.js";
import * as voice from "../voice.js";
import * as hypothesisTriage from "../hypothesisTriage.js";
import * as modelRouter from "../modelRouter.js";

type FnRegistry = Record<string, Record<string, unknown>>;

/**
 * Static registry of modules the golden runner can address. Intentionally
 * explicit — we never resolve a `fn` string into a dynamic import. Adding
 * a new module here is the mechanism for a new golden case surface.
 */
const MODULES: FnRegistry = {
  voice: voice as any,
  hypothesisTriage: hypothesisTriage as any,
  modelRouter: modelRouter as any,
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

export function runAllGoldenSets(): RegressionReport {
  const sets = loadGoldenSets();
  const results: CaseResult[] = [];
  const summary: RegressionReport["sets"] = [];
  for (const s of sets) {
    const r = runGoldenSet(s);
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
