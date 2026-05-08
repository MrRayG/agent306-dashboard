/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — AGGREGATE TEST RUNNER (Phase 1 closure)
 *
 * Discovers every `server/__tests__/**\/*.test.ts` file and hands them to
 * `tsx --test` in a single invocation. Acts as the canonical `npm test`.
 *
 * Why this exists: Node 20's `--test` flag does not expand globs, and
 * `tsx --test` inherits that limitation. Without an aggregate runner the
 * Phase 1 audit's "no canonical test command" finding stands. This file
 * is intentionally tiny and dependency-free so CI can run it from a cold
 * checkout the same way an engineer can on their laptop.
 *
 * Discovery rules:
 *   - Walk `server/__tests__` recursively.
 *   - Include any file ending in `.test.ts`.
 *   - Treat the absence of test files as a hard failure — a silent
 *     "0 tests ran" is the failure mode this whole runner is meant to
 *     prevent.
 *
 * Exit code mirrors the spawned `tsx --test` process so CI fails loudly
 * on any test failure.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const TESTS_DIR = path.join(ROOT, "server", "__tests__");

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const tests = walk(TESTS_DIR).sort();
if (tests.length === 0) {
  console.error(`[runTests] no *.test.ts files under ${TESTS_DIR} — refusing to report success`);
  process.exit(2);
}

console.error(`[runTests] discovered ${tests.length} test file(s)`);

const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
const child = spawn(tsxBin, ["--test", ...tests], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", code => {
  process.exit(typeof code === "number" ? code : 1);
});
