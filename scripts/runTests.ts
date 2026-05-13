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
 * Flags:
 *   --exclude-quarantined
 *     Filters out any test file whose path matches an entry in
 *     `scripts/quarantinedTests.ts` (Issue #332). Used by
 *     `npm run test:guarded`, which is in turn used by the
 *     `core-state-integrity` CI guard (PR #331). Default `npm test`
 *     behavior is unchanged — the full suite still runs.
 *
 * Exit code mirrors the spawned `tsx --test` process so CI fails loudly
 * on any test failure.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { QUARANTINED_TEST_PATHS } from "./quarantinedTests.ts";

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

/**
 * Filter the discovered test list against the quarantine manifest.
 * Returns `{ kept, excluded }` where each element of `excluded` is the
 * repo-relative path matched against the manifest.
 *
 * Exported and pure so `quarantinedTests.test.ts` can exercise the
 * filtering logic without spawning a child process.
 */
export function applyQuarantineFilter(
  testPaths: readonly string[],
  repoRoot: string,
  quarantined: ReadonlySet<string> = QUARANTINED_TEST_PATHS,
): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const abs of testPaths) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
    if (quarantined.has(rel)) excluded.push(rel);
    else kept.push(abs);
  }
  return { kept, excluded };
}

// CLI entry point. Guarded so importing this module from a test file
// (for `applyQuarantineFilter`) does not spawn the test runner.
const INVOKED_AS_CLI = import.meta.url === `file://${process.argv[1]}`;

if (INVOKED_AS_CLI) {
  const excludeQuarantined = process.argv.includes("--exclude-quarantined");

  const discovered = walk(TESTS_DIR).sort();
  if (discovered.length === 0) {
    console.error(`[runTests] no *.test.ts files under ${TESTS_DIR} — refusing to report success`);
    process.exit(2);
  }

  let tests = discovered;
  if (excludeQuarantined) {
    const { kept, excluded } = applyQuarantineFilter(discovered, ROOT);
    tests = kept;
    console.error(
      `[runTests] --exclude-quarantined: ${excluded.length} file(s) excluded, ${kept.length} kept`,
    );
    for (const rel of excluded) console.error(`  - ${rel}`);
  }

  console.error(`[runTests] discovered ${discovered.length} test file(s); running ${tests.length}`);

  // AGENT306_AGGREGATE_RUN tells per-file isolation contracts that they
  // are executing under the aggregate parallel runner (where sibling test
  // files concurrently write to live data/agent306.db). The contract
  // block's WAL-aware DB-stat assertion is meant to catch *this file*
  // mutating live DB; under aggregate runs the live-DB mtime drift is
  // caused by siblings, not by the file under test, so the contract
  // skips that single assertion. Watched-JSON contracts still run, and
  // the end-of-run scripts/checkCoreStateIntegrity.sh remains the
  // canonical source-of-truth for "did the full suite mutate live DB".
  // See PR #354 (drain #17) for the race that surfaced this.
  const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
  const child = spawn(tsxBin, ["--test", ...tests], {
    stdio: "inherit",
    env: { ...process.env, AGENT306_AGGREGATE_RUN: "1" },
  });

  child.on("exit", code => {
    process.exit(typeof code === "number" ? code : 1);
  });
}
