/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — QUARANTINED TESTS MANIFEST + FILTER TESTS (Issue #332)
 *
 * Pure tests against the quarantine manifest and the
 * `applyQuarantineFilter` helper exported from `scripts/runTests.ts`.
 *
 * Source-level invariants enforced (regex over the manifest source):
 *   - No Date.now / Math.random / randomUUID  (DETERMINISTIC)
 *   - No fs.write* / fs.append* / fs.unlink   (READ-ONLY MANIFEST)
 *   - No process.env reads                    (NO ENV COUPLING)
 *   - No scheduler / monitor imports          (NO RUNTIME COUPLING)
 *
 * Behavioral invariants enforced:
 *   - Manifest is sorted by path.
 *   - All entries have priority "high" or "low" (closed vocabulary).
 *   - All entries have reason in the closed set.
 *   - All entries reference issue "#332".
 *   - QUARANTINED_TEST_PATHS matches the set of QUARANTINED_TESTS paths.
 *   - applyQuarantineFilter correctly partitions a sample input.
 *   - applyQuarantineFilter is deterministic across repeated calls.
 *
 * This test file MUST NOT mutate any data file or shared state. It only
 * reads the manifest source for the source-guard regex scan.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  QUARANTINED_TESTS,
  QUARANTINED_TEST_PATHS,
  countByPriority,
  type QuarantinedTest,
  type QuarantinePriority,
  type QuarantineReason,
} from "../../scripts/quarantinedTests.ts";
import { applyQuarantineFilter } from "../../scripts/runTests.ts";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "quarantinedTests.ts");

const ALLOWED_PRIORITIES: ReadonlySet<QuarantinePriority> = new Set(["high", "low"]);
const ALLOWED_REASONS: ReadonlySet<QuarantineReason> = new Set([
  "mutates_core_state",
  "tmp_blog_legacy_root_leak",
]);

describe("quarantinedTests manifest — source-level guards", () => {
  const source = fs.readFileSync(MANIFEST_PATH, "utf8");

  it("does not call Date.now / Math.random / randomUUID", () => {
    assert.equal(/\bDate\.now\b/.test(source), false, "Date.now usage detected");
    assert.equal(/\bMath\.random\b/.test(source), false, "Math.random usage detected");
    assert.equal(/\brandomUUID\b/.test(source), false, "randomUUID usage detected");
  });

  it("does not write or delete files", () => {
    assert.equal(/fs\.write/.test(source), false, "fs.write* detected");
    assert.equal(/fs\.append/.test(source), false, "fs.append* detected");
    assert.equal(/fs\.unlink/.test(source), false, "fs.unlink detected");
    assert.equal(/fs\.rm\b/.test(source), false, "fs.rm detected");
  });

  it("does not read process.env", () => {
    assert.equal(/process\.env\b/.test(source), false, "process.env access detected");
  });

  it("does not import scheduler or monitor modules", () => {
    assert.equal(/from\s+["'][^"']*scheduler/.test(source), false, "scheduler import detected");
    assert.equal(/from\s+["'][^"']*monitor/.test(source), false, "monitor import detected");
  });
});

describe("quarantinedTests manifest — shape", () => {
  it("is non-empty (Issue #332 established the initial 19 culprits; drain reduces this number)", () => {
    assert.ok(QUARANTINED_TESTS.length > 0);
  });

  it("contains exactly 10 quarantined culprits (19 - 9 drained: repositoryBakFallback, autonomyMonitor, hypothesisDecisionEvents, hypothesisSandboxExecution, listHypothesisPromotionCandidates, lowRiskSandboxRegistry, promotionBoundaryAudit, sandboxRegistrationRecords, selfChangeVerifier)", () => {
    // Each entry removed by a per-culprit drain PR updates this count.
    // When this reaches 0 the quarantine mechanism itself can be removed.
    assert.equal(QUARANTINED_TESTS.length, 10);
  });

  it("is sorted alphabetically by path", () => {
    const paths = QUARANTINED_TESTS.map(e => e.path);
    const sorted = [...paths].sort();
    assert.deepEqual(paths, sorted);
  });

  it("has no duplicate paths", () => {
    const paths = QUARANTINED_TESTS.map(e => e.path);
    assert.equal(new Set(paths).size, paths.length);
  });

  it("every entry has a valid priority", () => {
    for (const entry of QUARANTINED_TESTS) {
      assert.ok(
        ALLOWED_PRIORITIES.has(entry.priority),
        `invalid priority ${String(entry.priority)} for ${entry.path}`,
      );
    }
  });

  it("every entry has a valid reason", () => {
    for (const entry of QUARANTINED_TESTS) {
      assert.ok(
        ALLOWED_REASONS.has(entry.reason),
        `invalid reason ${String(entry.reason)} for ${entry.path}`,
      );
    }
  });

  it("every entry references Issue #332 as the filing issue", () => {
    for (const entry of QUARANTINED_TESTS) {
      assert.equal(entry.issue, "#332", `wrong issue for ${entry.path}`);
    }
  });

  it("every entry has a non-empty note", () => {
    for (const entry of QUARANTINED_TESTS) {
      assert.ok(entry.note.length > 0, `empty note for ${entry.path}`);
      assert.equal(entry.note.includes("\n"), false, `multi-line note for ${entry.path}`);
    }
  });

  it("every path is under server/__tests__/ and ends with .test.ts", () => {
    for (const entry of QUARANTINED_TESTS) {
      assert.ok(
        entry.path.startsWith("server/__tests__/"),
        `path not under server/__tests__/: ${entry.path}`,
      );
      assert.ok(entry.path.endsWith(".test.ts"), `path not a .test.ts: ${entry.path}`);
    }
  });

  it("every quarantined path resolves to a real file on disk", () => {
    for (const entry of QUARANTINED_TESTS) {
      const abs = path.join(REPO_ROOT, entry.path);
      assert.ok(fs.existsSync(abs), `manifest references missing file: ${entry.path}`);
    }
  });
});

describe("quarantinedTests manifest — high/low priority split", () => {
  it("has exactly 2 high-priority entries (was 11; drained: repositoryBakFallback, autonomyMonitor, hypothesisDecisionEvents, hypothesisSandboxExecution, listHypothesisPromotionCandidates, lowRiskSandboxRegistry, promotionBoundaryAudit, sandboxRegistrationRecords, selfChangeVerifier)", () => {
    const counts = countByPriority();
    assert.equal(counts.high, 2, `expected 2 high, got ${counts.high}`);
  });

  it("has exactly 8 low-priority entries", () => {
    const counts = countByPriority();
    assert.equal(counts.low, 8, `expected 8 low, got ${counts.low}`);
  });

  it("high + low equals the manifest length", () => {
    const counts = countByPriority();
    assert.equal(counts.high + counts.low, QUARANTINED_TESTS.length);
  });
});

describe("QUARANTINED_TEST_PATHS lookup set", () => {
  it("matches the set of paths from QUARANTINED_TESTS", () => {
    const fromArray = new Set(QUARANTINED_TESTS.map(e => e.path));
    assert.equal(QUARANTINED_TEST_PATHS.size, fromArray.size);
    for (const p of fromArray) {
      assert.ok(QUARANTINED_TEST_PATHS.has(p), `missing in lookup set: ${p}`);
    }
  });
});

describe("applyQuarantineFilter — pure partition", () => {
  it("returns empty kept/excluded for empty input", () => {
    const result = applyQuarantineFilter([], REPO_ROOT);
    assert.deepEqual(result.kept, []);
    assert.deepEqual(result.excluded, []);
  });

  it("keeps a path that is not in the manifest", () => {
    const cleanTest = path.join(
      REPO_ROOT,
      "server",
      "__tests__",
      "runManualSafetyGatingValidationSummary.test.ts",
    );
    const result = applyQuarantineFilter([cleanTest], REPO_ROOT);
    assert.deepEqual(result.kept, [cleanTest]);
    assert.deepEqual(result.excluded, []);
  });

  it("excludes a path that is in the manifest", () => {
    const culprit = QUARANTINED_TESTS[0]!.path;
    const abs = path.join(REPO_ROOT, culprit);
    const result = applyQuarantineFilter([abs], REPO_ROOT);
    assert.deepEqual(result.kept, []);
    assert.deepEqual(result.excluded, [culprit]);
  });

  it("partitions a mixed list correctly", () => {
    const culprit = path.join(REPO_ROOT, QUARANTINED_TESTS[0]!.path);
    const clean = path.join(
      REPO_ROOT,
      "server",
      "__tests__",
      "runManualSafetyGatingValidationSummary.test.ts",
    );
    const result = applyQuarantineFilter([culprit, clean], REPO_ROOT);
    assert.deepEqual(result.kept, [clean]);
    assert.deepEqual(result.excluded, [QUARANTINED_TESTS[0]!.path]);
  });

  it("excludes every culprit when given the full manifest as input", () => {
    const inputs = QUARANTINED_TESTS.map(e => path.join(REPO_ROOT, e.path));
    const result = applyQuarantineFilter(inputs, REPO_ROOT);
    assert.deepEqual(result.kept, []);
    assert.equal(result.excluded.length, QUARANTINED_TESTS.length);
  });

  it("accepts an injected quarantine set (deterministic, no I/O)", () => {
    const injected = new Set(["server/__tests__/x.test.ts"]);
    const abs = path.join(REPO_ROOT, "server", "__tests__", "x.test.ts");
    const other = path.join(REPO_ROOT, "server", "__tests__", "y.test.ts");
    const result = applyQuarantineFilter([abs, other], REPO_ROOT, injected);
    assert.deepEqual(result.kept, [other]);
    assert.deepEqual(result.excluded, ["server/__tests__/x.test.ts"]);
  });

  it("is deterministic across repeated calls", () => {
    const inputs = QUARANTINED_TESTS.map(e => path.join(REPO_ROOT, e.path));
    const first = applyQuarantineFilter(inputs, REPO_ROOT);
    const second = applyQuarantineFilter(inputs, REPO_ROOT);
    assert.deepEqual(first, second);
  });

  it("does not mutate its input array", () => {
    const inputs: string[] = QUARANTINED_TESTS.map(e => path.join(REPO_ROOT, e.path));
    const snapshot = [...inputs];
    applyQuarantineFilter(inputs, REPO_ROOT);
    assert.deepEqual(inputs, snapshot);
  });
});

describe("manifest type — compile-time exhaustiveness sanity", () => {
  it("typed entry shape round-trips", () => {
    const sample: QuarantinedTest = QUARANTINED_TESTS[0]!;
    assert.equal(typeof sample.path, "string");
    assert.equal(typeof sample.note, "string");
    assert.equal(typeof sample.priority, "string");
    assert.equal(typeof sample.reason, "string");
    assert.equal(sample.issue, "#332");
  });
});
