/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — GOLDEN SETS LOADER (spec §5)
 *
 * Loads versioned golden sets from data/eval/golden/*.json. Each file defines
 * a batch of test cases binding a module function name to expected output.
 * The regression runner turns these into per-case pass/fail and the
 * promotion gate blocks self-change applications on any failing case.
 *
 * Format:
 *   {
 *     "name": "<set name>",
 *     "version": 1,
 *     "cases": [
 *       { "id": "...", "fn": "<module>.<export>", "args": [...], "expect": { ... } }
 *     ]
 *   }
 *
 * `expect` kinds:
 *   - { kind: "equals", value: any }                 — deep-equal value
 *   - { kind: "contains", value: string }            — haystack.includes(value)
 *   - { kind: "minLength", value: number }           — (string | array).length >= value
 *   - { kind: "objectContains", value: object }      — every k/v in `value` present on result
 *   - { kind: "greaterThan", value: number }         — result > value (numeric)
 *   - { kind: "truthy" }                             — Boolean(result) === true
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import { dataPath } from "../dataPaths.js";

export interface GoldenExpect {
  kind: "equals" | "contains" | "minLength" | "objectContains" | "greaterThan" | "truthy";
  value?: unknown;
}

export interface GoldenCase {
  id: string;
  fn: string;              // "<moduleKey>.<exportName>" — resolved in regressionRunner
  args: unknown[];
  expect: GoldenExpect;
}

export interface GoldenSet {
  name: string;
  version: number;
  description?: string;
  cases: GoldenCase[];
}

const GOLDEN_DIR = path.join(dataPath(""), "eval", "golden").replace(/\/$/, "");

function goldenDir(): string {
  // dataPath("") gives us DATA_DIR; adjust to the eval/golden subtree.
  const base = dataPath("").replace(/\/$/, "");
  return path.join(base, "eval", "golden");
}

export function loadGoldenSets(): GoldenSet[] {
  const dir = goldenDir();
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".golden.json"));
    const sets: GoldenSet[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const parsed = JSON.parse(raw) as GoldenSet;
        if (!parsed.name || !Array.isArray(parsed.cases)) {
          console.warn(`[GoldenSets] ${file}: missing name or cases array — skipping`);
          continue;
        }
        sets.push(parsed);
      } catch (e: any) {
        console.warn(`[GoldenSets] ${file}: parse failed — ${e?.message}`);
      }
    }
    return sets;
  } catch (e: any) {
    console.warn("[GoldenSets] load failed:", e?.message);
    return [];
  }
}

export function loadGoldenSet(name: string): GoldenSet | null {
  return loadGoldenSets().find(s => s.name === name) ?? null;
}

/** Path used by the README + ops runbook. */
export function getGoldenDir(): string {
  return goldenDir();
}

// Avoid unused-var warning while keeping the constant around for docs.
void GOLDEN_DIR;
