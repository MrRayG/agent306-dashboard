/**
 * Tests for Phase 2n-b — Phase 3a entry-point constant.
 *
 * Spec invariants pinned by this file:
 *
 *   1. Every exported constant is structurally frozen — `Object.isFrozen`
 *      returns true at the top level, and mutation attempts in strict
 *      mode throw.
 *   2. `PHASE3_ENTRY_POINT_VERSION` is the literal string `"phase3a.v2"`.
 *      Any change to this value is a contract break and MUST be paired
 *      with an updated test expectation. The bump from `phase3a.v1` to
 *      `phase3a.v2` was Track A / Phase 3a-prep-b: added
 *      `server/experiments/phase3aPrepHarness.ts` to
 *      `PHASE3_NEVER_AUTHORIZED_BY`.  Criteria list, entry kind, and
 *      boundary contract were UNCHANGED.
 *   3. `PHASE3_ENTRY_KIND` is exactly `"summarizationTemplate"`. This
 *      matches the Phase 2 invariant that summarizationTemplate is the
 *      only enabled low-risk sandbox kind. Widening this value is a
 *      contract break.
 *   4. `PHASE3_ENTRY_PRECONDITIONS` is an ordered array whose contents
 *      and order match Phase 2l-c's gating criteria 1:1. The Phase 2l-c
 *      report's checklist iterates in the same order; any drift between
 *      the two is a contract break.
 *   5. `PHASE3_BOUNDARY_CONTRACT` pins eight `true` flags (the things a
 *      Phase 3a trial MUST have) and four `false` flags (the things a
 *      Phase 3a trial MUST NOT have) plus `sandboxOnly: true`. Every
 *      flag is pinned literally.
 *   6. `PHASE3_NEVER_AUTHORIZED_BY` lists workspace-relative paths that
 *      actually exist in the repo. A rename of any listed file must
 *      break this test loudly rather than silently lose meaning.
 *   7. `PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS` lists relative import paths
 *      that any future Phase 3a enablement code MUST NOT use. The
 *      strings are exposed as a frozen array so the Phase 2n-c
 *      boundary regression tests can iterate over them.
 *   8. The aggregated `PHASE3_ENTRY_POINT` object exposes every
 *      sub-constant under a stable key. `Phase3EntryPoint` is
 *      `typeof PHASE3_ENTRY_POINT`.
 *   9. Source-level guards: the module does NOT import the scheduler /
 *      autonomy monitor / applyRecommendation / promotion gate /
 *      hypothesis action gate / selfRecommendation engine. It does NOT
 *      call `Date.now` / `Math.random` / `randomUUID`, does NOT touch
 *      `process.env`, and does NOT call any fs / db API.
 *  10. The module is NOT imported by `server/index.ts`, the autonomy
 *      monitor, the scheduler, the promotion gate, the apply
 *      recommendation path, or any other currently-running production
 *      module. Importing this file confers no authority — it is a
 *      declarative anchor only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const ENTRY_POINT_SOURCE = path.join(REPO_ROOT, "server", "experiments", "phase3EntryPoint.ts");

const {
  PHASE3_ENTRY_POINT_VERSION,
  PHASE3_ENTRY_POINT_LABEL,
  PHASE3_ENTRY_KIND,
  PHASE3_ENTRY_PRECONDITIONS,
  PHASE3_BOUNDARY_CONTRACT,
  PHASE3_NEVER_AUTHORIZED_BY,
  PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS,
  PHASE3_ENTRY_POINT,
} = await import("../experiments/phase3EntryPoint.ts");

// ── Schema version + identity ──────────────────────────────────────────────

describe("Phase 2n-b — schema version + identity", () => {
  it("pins PHASE3_ENTRY_POINT_VERSION to phase3a.v2", () => {
    assert.equal(PHASE3_ENTRY_POINT_VERSION, "phase3a.v2");
  });

  it("PHASE3_ENTRY_POINT_LABEL mentions Phase 3a, sandbox-only, and human-approval", () => {
    assert.match(PHASE3_ENTRY_POINT_LABEL, /Phase 3a/);
    assert.match(PHASE3_ENTRY_POINT_LABEL, /sandbox-only/i);
    assert.match(PHASE3_ENTRY_POINT_LABEL, /human-approval/i);
  });

  it("PHASE3_ENTRY_KIND is exactly 'summarizationTemplate'", () => {
    assert.equal(PHASE3_ENTRY_KIND, "summarizationTemplate");
  });
});

// ── Preconditions list parity with Phase 2l-c ──────────────────────────────

describe("Phase 2n-b — preconditions parity with Phase 2l-c", () => {
  it("contains exactly the seven Phase 2l-c criterion keys in stable order", () => {
    const expected = [
      "reversibleLowRiskActionOnly",
      "explicitKillSwitchAndResourceLimits",
      "anomalyAndDriftDetectionPlaceholder",
      "rollbackProof",
      "humanApprovalBoundary",
      "metricsClockReadiness",
      "noPublicAction",
    ];
    assert.deepEqual([...PHASE3_ENTRY_PRECONDITIONS], expected);
  });

  it("matches the criterion order surfaced by buildPhase2CloseOutReport", async () => {
    // The Phase 2l-c builder iterates PHASE3_CRITERIA_ORDER and emits
    // one criterion entry per key in that order. We confirm by reading
    // a built report's checklist keys and comparing them 1:1.
    const { buildPhase2CloseOutReport } = await import(
      "../experiments/phase2CloseOutReport.ts"
    );
    const r = buildPhase2CloseOutReport();
    const checklistKeys = r.phase3Gating.criteria.map(c => c.key);
    assert.deepEqual([...PHASE3_ENTRY_PRECONDITIONS], checklistKeys);
  });
});

// ── Boundary contract literal flags ────────────────────────────────────────

describe("Phase 2n-b — boundary contract literal flags", () => {
  it("pins every required-true flag", () => {
    assert.equal(PHASE3_BOUNDARY_CONTRACT.reversibleOnly,           true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.killSwitchRequired,       true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.resourceLimitsRequired,   true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.anomalyDetectionRequired, true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.rollbackProofRequired,    true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.humanApprovalRequired,    true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.metricsClockRequired,     true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.noPublicAction,           true);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.sandboxOnly,              true);
  });

  it("pins every required-false flag (non-widening / no-promotion)", () => {
    assert.equal(PHASE3_BOUNDARY_CONTRACT.schedulerDriven,       false);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.autoApplyEligible,     false);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.publicActionEligible,  false);
    assert.equal(PHASE3_BOUNDARY_CONTRACT.runtimeActionEligible, false);
  });

  it("has exactly the documented 13 flags and no unexpected extras", () => {
    const expected = new Set([
      "reversibleOnly",
      "killSwitchRequired",
      "resourceLimitsRequired",
      "anomalyDetectionRequired",
      "rollbackProofRequired",
      "humanApprovalRequired",
      "metricsClockRequired",
      "noPublicAction",
      "sandboxOnly",
      "schedulerDriven",
      "autoApplyEligible",
      "publicActionEligible",
      "runtimeActionEligible",
    ]);
    const actual = new Set(Object.keys(PHASE3_BOUNDARY_CONTRACT));
    assert.deepEqual(actual, expected);
  });
});

// ── Negative-space declaration: NEVER_AUTHORIZED_BY ────────────────────────

describe("Phase 2n-b — PHASE3_NEVER_AUTHORIZED_BY artefacts exist on disk", () => {
  it("every listed path resolves to an existing file in the repo", () => {
    for (const rel of PHASE3_NEVER_AUTHORIZED_BY) {
      const abs = path.join(REPO_ROOT, rel);
      assert.ok(
        fs.existsSync(abs),
        `PHASE3_NEVER_AUTHORIZED_BY lists ${rel} but the file does not exist (was it renamed?)`,
      );
    }
  });

  it("contains the Phase 2l-c close-out report and the Phase 2n-a manual runner explicitly", () => {
    assert.ok(
      PHASE3_NEVER_AUTHORIZED_BY.includes("server/experiments/phase2CloseOutReport.ts"),
      "must list the Phase 2l-c close-out report as a non-authorising artefact",
    );
    assert.ok(
      PHASE3_NEVER_AUTHORIZED_BY.includes("scripts/runManualPhase2CloseOutReport.ts"),
      "must list the Phase 2n-a manual runner as a non-authorising artefact",
    );
  });

  it("contains the Phase 3a-prep harness (added in phase3a.v2)", () => {
    assert.ok(
      PHASE3_NEVER_AUTHORIZED_BY.includes("server/experiments/phase3aPrepHarness.ts"),
      "phase3a.v2 must list the Phase 3a-prep harness as a non-authorising artefact",
    );
  });
});

// ── Forbidden-enablement-imports list ──────────────────────────────────────

describe("Phase 2n-b — PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS", () => {
  it("lists scheduler, autonomy monitor, applyRecommendation, promotionGate, hypothesisActionGate, selfRecommendationEngine", () => {
    const joined = PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS.join("|");
    assert.match(joined, /scheduler/);
    assert.match(joined, /autonomyMonitor/);
    assert.match(joined, /applyRecommendation/);
    assert.match(joined, /promotionGate/);
    assert.match(joined, /hypothesisActionGate/);
    assert.match(joined, /selfRecommendationEngine/);
  });
});

// ── Structural freezing ────────────────────────────────────────────────────

describe("Phase 2n-b — structural freezing", () => {
  it("PHASE3_ENTRY_POINT is frozen at the top level", () => {
    assert.equal(Object.isFrozen(PHASE3_ENTRY_POINT), true);
  });

  it("PHASE3_BOUNDARY_CONTRACT is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3_BOUNDARY_CONTRACT), true);
  });

  it("PHASE3_ENTRY_PRECONDITIONS is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3_ENTRY_PRECONDITIONS), true);
  });

  it("PHASE3_NEVER_AUTHORIZED_BY is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3_NEVER_AUTHORIZED_BY), true);
  });

  it("PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS), true);
  });

  it("mutation attempts on PHASE3_BOUNDARY_CONTRACT throw in strict mode", () => {
    "use strict";
    assert.throws(() => {
      // @ts-expect-error — runtime mutation attempt against a frozen object
      PHASE3_BOUNDARY_CONTRACT.reversibleOnly = false;
    }, /Cannot assign to read only property|object is not extensible|frozen/);
  });

  it("mutation attempts on PHASE3_ENTRY_PRECONDITIONS throw in strict mode", () => {
    "use strict";
    assert.throws(() => {
      // @ts-expect-error — runtime push against a frozen array
      (PHASE3_ENTRY_PRECONDITIONS as unknown as string[]).push("rogueCriterion");
    });
  });
});

// ── Aggregated PHASE3_ENTRY_POINT shape ────────────────────────────────────

describe("Phase 2n-b — aggregated PHASE3_ENTRY_POINT shape", () => {
  it("exposes every sub-constant under a stable key", () => {
    assert.equal(PHASE3_ENTRY_POINT.version,                    PHASE3_ENTRY_POINT_VERSION);
    assert.equal(PHASE3_ENTRY_POINT.label,                      PHASE3_ENTRY_POINT_LABEL);
    assert.equal(PHASE3_ENTRY_POINT.kind,                       PHASE3_ENTRY_KIND);
    assert.equal(PHASE3_ENTRY_POINT.preconditions,              PHASE3_ENTRY_PRECONDITIONS);
    assert.equal(PHASE3_ENTRY_POINT.contract,                   PHASE3_BOUNDARY_CONTRACT);
    assert.equal(PHASE3_ENTRY_POINT.neverAuthorizedBy,          PHASE3_NEVER_AUTHORIZED_BY);
    assert.equal(PHASE3_ENTRY_POINT.forbiddenEnablementImports, PHASE3_FORBIDDEN_ENABLEMENT_IMPORTS);
  });

  it("has no unexpected extra top-level keys", () => {
    const expected = new Set([
      "version",
      "label",
      "kind",
      "preconditions",
      "contract",
      "neverAuthorizedBy",
      "forbiddenEnablementImports",
    ]);
    const actual = new Set(Object.keys(PHASE3_ENTRY_POINT));
    assert.deepEqual(actual, expected);
  });
});

// ── Source-level guards ────────────────────────────────────────────────────

describe("Phase 2n-b — source-level guards", () => {
  const rawSrc = fs.readFileSync(ENTRY_POINT_SOURCE, "utf8");
  // Strip block + line comments so doc-comment mentions of forbidden
  // names don't trip the API-usage guards.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("does NOT import scheduler / monitor / promotion / apply / hypothesis-mutation / selfRecommendation paths", () => {
    const FORBIDDEN_IMPORTS = [
      /from\s+["'][^"']*scheduler[^"']*["']/,
      /from\s+["'][^"']*autonomyMonitor[^"']*["']/,
      /from\s+["'][^"']*applyRecommendation[^"']*["']/,
      /from\s+["'][^"']*promotionGate[^"']*["']/,
      /from\s+["'][^"']*hypothesisActionGate[^"']*["']/,
      /from\s+["'][^"']*selfRecommendationEngine[^"']*["']/,
      /from\s+["'][^"']*server\/index[^"']*["']/,
    ];
    for (const pat of FORBIDDEN_IMPORTS) {
      assert.equal(pat.test(src), false, `module must not import ${pat}`);
    }
  });

  it("does NOT touch fs / db / env / wall-clock / random APIs", () => {
    const FORBIDDEN = [
      /\bfs\b/,
      /\bbetter-sqlite3\b/,
      /\bdrizzle-orm\b/,
      /process\.env\b/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bnew\s+Date\s*\(/,
    ];
    for (const pat of FORBIDDEN) {
      assert.equal(pat.test(src), false, `module must not use ${pat}`);
    }
  });

  it("only imports types from phase2CloseOutReport (declarative anchor only)", () => {
    // The single import in the file should be a type-only import from
    // phase2CloseOutReport. Any other `import` line is suspect.
    const importLines = src
      .split("\n")
      .filter(line => /^\s*import\s/.test(line));
    assert.equal(importLines.length, 1,
      `expected exactly one import line, got ${importLines.length}:\n${importLines.join("\n")}`);
    assert.match(importLines[0], /import\s+type\s+\{/,
      "the sole import must be a type-only import");
    assert.match(importLines[0], /phase2CloseOutReport/);
  });
});

// ── Production runtime isolation ───────────────────────────────────────────

describe("Phase 2n-b — production runtime isolation", () => {
  it("is NOT imported by any module under server/ (other than its own test)", () => {
    const SERVER_DIR = path.join(REPO_ROOT, "server");
    const MODULE_BASENAME = "phase3EntryPoint";
    const SELF_BASENAME   = path.basename(new URL(import.meta.url).pathname);
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
        // Skip the module itself and its own test file.
        if (path.basename(full) === `${MODULE_BASENAME}.ts`) continue;
        if (path.basename(full) === SELF_BASENAME) continue;
        const text = fs.readFileSync(full, "utf8");
        const importRe = new RegExp(`from\\s+["'][^"']*${MODULE_BASENAME}[^"']*["']`);
        if (importRe.test(text)) {
          offenders.push(full);
        }
      }
    }

    walk(SERVER_DIR);
    assert.deepEqual(offenders, [],
      `Phase 3a entry-point constant must not be imported by any module under server/ yet. Offenders: ${offenders.join(", ")}`);
  });
});
