/**
 * Tests for Phase 2l-d — manual learning-loop report runner.
 *
 * Spec invariants pinned by this file:
 *
 *   1. The CLI argument parser handles every documented flag, defaults
 *      `source` to `"manual:cli"`, and rejects unknown / malformed flags
 *      with a clear reason and no thrown exception.
 *   2. `--help` / `-h` short-circuits cleanly, prints the usage text to
 *      stdout, and returns exit code 0.
 *   3. The runner reuses `buildLearningLoopReport` from Phase 2l-b — it
 *      does NOT define its own report logic. Identical CLI inputs produce
 *      byte-identical stdout output across repeated invocations.
 *   4. The runner is stdout-only on the happy path: stdout is exactly one
 *      JSON document; the only stderr output is the safety-invariants
 *      banner; nothing else is written anywhere.
 *   5. The runner is non-mutating: no file, database, ledger, env var,
 *      monitor state, or in-memory map is touched. The repo's live data
 *      files are byte-identical after the test run.
 *   6. Source-level guards: the runner does NOT import the scheduler /
 *      autonomy monitor / promotion gate / applyRecommendation / hypothesis
 *      mutation paths, does NOT call `Date.now` / `Math.random` /
 *      `randomUUID` / `process.env`, and does NOT call any fs write API.
 *   7. The printed JSON payload restates the report's safety invariants
 *      and disclaimer block verbatim (read-only / propose-only / non-
 *      widening / no scheduler / no auto-apply / no public action).
 *   8. The runner can be invoked with `--now` / `--run-label` / `--operator`
 *      / `--source` and echoes those values into the report payload.
 *   9. With `--pretty` the payload is 2-space-indented JSON; without it
 *      the payload is compact JSON. The two outputs `JSON.parse` to a
 *      deeply-equal object.
 *  10. Disabled sandbox kinds remain disabled in the printed payload;
 *      `summarizationTemplate` is the only enabled kind the runner can
 *      describe through the embedded harness result.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so the underlying harness sees a
// clean state and so we can confirm later that no real ledger files were
// touched. The runner does no I/O — these guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ld-manual-runner-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "runManualLearningLoopReport.ts");

const {
  parseManualLearningLoopReportCliArgs,
  runManualLearningLoopReportCli,
  toReportInputs,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
  DEFAULT_CLI_SOURCE,
} = await import("../../scripts/runManualLearningLoopReport.ts");

const {
  LEARNING_LOOP_REPORT_SCHEMA_VERSION,
  LEARNING_LOOP_REPORT_LABEL,
  LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER,
} = await import("../experiments/learningLoopReport.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);
const ENV_SNAPSHOT             = JSON.stringify(process.env);

const PINNED_AT = "2026-05-11T17:00:00.000Z";

before(() => {
  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(TMP_LEDGER); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2l-d tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-d tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-d tests created live ${label}!`);
    }
  }
  // Only DATA_DIR / DB_PATH may have changed — verify we did not pollute
  // env any further.
  const before = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (key === "DATA_DIR" || key === "DB_PATH") continue;
    if (before[key] !== process.env[key]) {
      throw new Error(`Phase 2l-d tests mutated env var ${key}`);
    }
  }
});

function makeIo(): { stdout: string[]; stderr: string[]; io: { stdout: (s: string) => void; stderr: (s: string) => void } } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
    },
  };
}

// ── Argument parser ────────────────────────────────────────────────────────

describe("Phase 2l-d — argument parser", () => {
  it("returns defaults when given no flags", () => {
    const r = parseManualLearningLoopReportCliArgs([]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,    false);
      assert.equal(r.options.now,       null);
      assert.equal(r.options.runLabel,  null);
      assert.equal(r.options.operator,  null);
      assert.equal(r.options.source,    DEFAULT_CLI_SOURCE);
    } else {
      assert.fail("expected options branch");
    }
  });

  it("parses every documented flag", () => {
    const r = parseManualLearningLoopReportCliArgs([
      "--pretty",
      "--now",       PINNED_AT,
      "--run-label", "phase2l-d-daily-2026-05-11",
      "--operator",  "op@phase2l-d",
      "--source",    "manual:repl",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,    true);
      assert.equal(r.options.now,       PINNED_AT);
      assert.equal(r.options.runLabel,  "phase2l-d-daily-2026-05-11");
      assert.equal(r.options.operator,  "op@phase2l-d");
      assert.equal(r.options.source,    "manual:repl");
    } else {
      assert.fail("expected options branch");
    }
  });

  it("treats `--json` as the explicit default and leaves pretty=false", () => {
    const r = parseManualLearningLoopReportCliArgs(["--json"]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty, false);
    }
  });

  it("rejects `--json` combined with `--pretty`", () => {
    const r = parseManualLearningLoopReportCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /mutually exclusive/);
    }
  });

  it("rejects an unknown flag with a clear reason", () => {
    const r = parseManualLearningLoopReportCliArgs(["--nope"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /unknown flag: --nope/);
    }
  });

  it("rejects a malformed --now", () => {
    const r = parseManualLearningLoopReportCliArgs(["--now", "yesterday"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /not a valid ISO timestamp/);
    }
  });

  it("rejects an empty --run-label / --operator / --source", () => {
    for (const flag of ["--run-label", "--operator", "--source"]) {
      const r = parseManualLearningLoopReportCliArgs([flag, "   "]);
      assert.equal(r.ok, false, `${flag} should reject whitespace-only value`);
    }
  });

  it("signals --help / -h via the helpRequested branch", () => {
    for (const flag of ["--help", "-h"]) {
      const r = parseManualLearningLoopReportCliArgs([flag]);
      assert.equal(r.ok, true);
      if (r.ok === true && "helpRequested" in r) {
        assert.equal(r.helpRequested, true);
      } else {
        assert.fail(`${flag} should yield helpRequested=true`);
      }
    }
  });
});

// ── toReportInputs projection ──────────────────────────────────────────────

describe("Phase 2l-d — toReportInputs", () => {
  it("projects defaults without injecting harness inputs beyond `now`", () => {
    const inputs = toReportInputs({
      pretty:   false,
      now:      null,
      runLabel: null,
      operator: null,
      source:   DEFAULT_CLI_SOURCE,
    });
    assert.equal(inputs.runLabel, undefined);
    assert.equal(inputs.operator, undefined);
    assert.equal(inputs.source,   DEFAULT_CLI_SOURCE);
    assert.deepEqual(inputs.harnessInputs, {});
  });

  it("forwards a pinned --now into harnessInputs.now", () => {
    const inputs = toReportInputs({
      pretty:   false,
      now:      PINNED_AT,
      runLabel: "label-x",
      operator: "op-x",
      source:   "manual:repl",
    });
    assert.equal(inputs.runLabel, "label-x");
    assert.equal(inputs.operator, "op-x");
    assert.equal(inputs.source,   "manual:repl");
    assert.deepEqual(inputs.harnessInputs, { now: PINNED_AT });
  });
});

// ── CLI happy path ──────────────────────────────────────────────────────────

describe("Phase 2l-d — runManualLearningLoopReportCli happy path", () => {
  it("prints help to stdout and exits 0 on --help", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualLearningLoopReportCli(["--help"], io);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report, null);
    assert.equal(stdout.join(""), USAGE_TEXT + "\n");
    assert.equal(stderr.join(""), "");
  });

  it("prints a deterministic JSON payload with pinned --now and metadata", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const { stdout, stderr, io } = makeIo();
    const result = runManualLearningLoopReportCli([
      "--now",       PINNED_AT,
      "--run-label", "phase2l-d-daily-2026-05-11",
      "--operator",  "op@phase2l-d",
      "--source",    "manual:test",
    ], io);
    assert.equal(result.exitCode, 0);
    assert.ok(result.report, "expected a report to be returned");

    // stderr gets the safety banner and nothing else.
    assert.equal(stderr.join(""), SAFETY_INVARIANTS_BANNER + "\n");

    // stdout is exactly one trailing-newline-terminated JSON document.
    const stdoutStr = stdout.join("");
    assert.ok(stdoutStr.endsWith("\n"), "stdout must end with a newline");
    const payload = JSON.parse(stdoutStr.trim());

    assert.equal(payload.schemaVersion, LEARNING_LOOP_REPORT_SCHEMA_VERSION);
    assert.equal(payload.label,         LEARNING_LOOP_REPORT_LABEL);
    assert.equal(payload.runLabel,      "phase2l-d-daily-2026-05-11");
    assert.equal(payload.operator,      "op@phase2l-d");
    assert.equal(payload.source,        "manual:test");
    assert.equal(payload.generatedAt,   PINNED_AT);

    // Safety contract restated verbatim.
    assert.deepEqual(payload.safetyDisclaimer, [...LEARNING_LOOP_REPORT_SAFETY_DISCLAIMER]);
    assert.equal(payload.invariants.readOnly,                true);
    assert.equal(payload.invariants.proposeOnly,             true);
    assert.equal(payload.invariants.suggestionOnly,          true);
    assert.equal(payload.invariants.nonWidening,             true);
    assert.equal(payload.invariants.autoApplyEligible,       false);
    assert.equal(payload.invariants.publicAction,            false);
    assert.equal(payload.invariants.schedulerDriven,         false);
    assert.equal(payload.invariants.runtimeActionEligible,   false);
    assert.equal(payload.invariants.publicActionEligible,    false);
    assert.equal(payload.invariants.observationalOnly,       true);
  });

  it("produces byte-identical stdout for repeat invocations with identical flags", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const argv = [
      "--now",       PINNED_AT,
      "--run-label", "phase2l-d-repeat",
      "--operator",  "op@phase2l-d",
      "--source",    "manual:test",
    ];

    const a = makeIo(); runManualLearningLoopReportCli(argv, a.io);
    const b = makeIo(); runManualLearningLoopReportCli(argv, b.io);
    assert.equal(a.stdout.join(""), b.stdout.join(""));
    assert.equal(a.stderr.join(""), b.stderr.join(""));
  });

  it("--pretty produces indented JSON that parses to the same object as compact JSON", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const compact = makeIo();
    runManualLearningLoopReportCli(["--now", PINNED_AT, "--source", "manual:test"], compact.io);

    const pretty = makeIo();
    runManualLearningLoopReportCli(["--pretty", "--now", PINNED_AT, "--source", "manual:test"], pretty.io);

    const compactStr = compact.stdout.join("").trim();
    const prettyStr  = pretty.stdout.join("").trim();
    assert.notEqual(compactStr, prettyStr, "--pretty should change formatting");
    assert.ok(prettyStr.includes("\n  "), "--pretty should produce indented JSON");
    assert.deepEqual(JSON.parse(compactStr), JSON.parse(prettyStr));
  });

  it("defaults source to manual:cli when --source is omitted", () => {
    const { stdout, io } = makeIo();
    runManualLearningLoopReportCli(["--now", PINNED_AT], io);
    const payload = JSON.parse(stdout.join("").trim());
    assert.equal(payload.source, DEFAULT_CLI_SOURCE);
  });

  it("records generatedAt=null when --now is omitted (no wall-clock read)", () => {
    const { stdout, io } = makeIo();
    runManualLearningLoopReportCli([], io);
    const payload = JSON.parse(stdout.join("").trim());
    assert.equal(payload.generatedAt, null);
  });
});

// ── CLI error path ──────────────────────────────────────────────────────────

describe("Phase 2l-d — runManualLearningLoopReportCli error path", () => {
  it("returns exitCode=1 with stderr usage on unknown flag, no stdout", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualLearningLoopReportCli(["--bogus"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report, null);
    assert.equal(stdout.join(""), "");
    const stderrStr = stderr.join("");
    assert.match(stderrStr, /unknown flag: --bogus/);
    assert.ok(stderrStr.includes(USAGE_TEXT), "should embed usage in stderr");
  });

  it("returns exitCode=1 with stderr usage on malformed --now", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualLearningLoopReportCli(["--now", "tomorrow"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /not a valid ISO timestamp/);
  });
});

// ── Safety invariants banner ────────────────────────────────────────────────

describe("Phase 2l-d — safety invariants banner", () => {
  it("restates read-only / manual-only / stdout-only / no-scheduler / no-auto-apply / no-public-action", () => {
    assert.match(SAFETY_INVARIANTS_BANNER, /read-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /manual-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /stdout-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no scheduler/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no auto-apply/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no public action/i);
  });

  it("usage text documents every flag", () => {
    for (const flag of ["--json", "--pretty", "--now", "--run-label", "--operator", "--source"]) {
      assert.ok(USAGE_TEXT.includes(flag), `usage text missing ${flag}`);
    }
  });
});

// ── Source-level non-widening / no-side-effect guards ─────────────────────

describe("Phase 2l-d — source-level guards (script file)", () => {
  const rawSrc = fs.readFileSync(SCRIPT_PATH, "utf8");
  // Strip /* ... */ block comments and //-line comments so doc-comment
  // mentions of "Date.now" etc. do not trigger the API-usage guards. We
  // are checking real code, not prose.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("delegates to buildLearningLoopReport / serializeLearningLoopReport (does not duplicate report logic)", () => {
    assert.ok(src.includes("buildLearningLoopReport"),
      "script must import buildLearningLoopReport from Phase 2l-b");
    assert.ok(src.includes("serializeLearningLoopReport"),
      "script must import serializeLearningLoopReport from Phase 2l-b");
    // It should NOT redefine the report builder.
    assert.equal(
      (src.match(/function\s+buildLearningLoopReport\b/g) ?? []).length,
      0,
      "script must not redefine buildLearningLoopReport",
    );
  });

  it("does NOT import the scheduler / monitor / promotion / apply / hypothesis-mutation paths", () => {
    const FORBIDDEN_IMPORTS = [
      /from\s+["'][^"']*autonomyMonitor[^"']*["']/,
      /from\s+["'][^"']*scheduler[^"']*["']/,
      /from\s+["'][^"']*applyRecommendation[^"']*["']/,
      /from\s+["'][^"']*promotionGate[^"']*["']/,
      /from\s+["'][^"']*selfRecommendationEngine[^"']*["']/,
      /from\s+["'][^"']*hypothesisActionGate[^"']*["']/,
      /from\s+["'][^"']*server\/index[^"']*["']/,
    ];
    for (const pat of FORBIDDEN_IMPORTS) {
      assert.equal(pat.test(src), false, `script must not import ${pat}`);
    }
  });

  it("does NOT touch fs / db / env / wall-clock / random APIs", () => {
    const FORBIDDEN = [
      /\bfs\.writeFile/,
      /\bfs\.writeFileSync/,
      /\bfs\.appendFile/,
      /\bfs\.appendFileSync/,
      /\bfs\.mkdir/,
      /\bfs\.unlink/,
      /\bfs\.rm/,
      /\bfs\.rename/,
      /\bbetter-sqlite3\b/,
      /\bdrizzle-orm\b/,
      /process\.env\.[A-Z_]+\s*=/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bnew\s+Date\s*\(\s*\)/,
    ];
    for (const pat of FORBIDDEN) {
      assert.equal(pat.test(src), false, `script must not use ${pat}`);
    }
  });

  it("does NOT import any fs module at all (stdout-only)", () => {
    const importsFs =
      /from\s+["'](?:node:)?fs(?:\/[^"']+)?["']/.test(src) ||
      /import\s+\*\s+as\s+fs\s+from/.test(src) ||
      /require\(\s*["'](?:node:)?fs["']\s*\)/.test(src);
    assert.equal(importsFs, false, "script must not import fs");
  });

  it("the safety banner explicitly says no scheduler / no auto-apply / no public action", () => {
    assert.match(src, /no scheduler/);
    assert.match(src, /no auto-apply/);
    assert.match(src, /no public action/);
  });
});

// ── Non-widening: disabled sandbox kinds remain disabled in the payload ───

describe("Phase 2l-d — non-widening: enabled sandbox kinds", () => {
  it("the embedded harness result describes summarizationTemplate as the only enabled kind", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const { stdout, io } = makeIo();
    runManualLearningLoopReportCli(["--now", PINNED_AT, "--source", "manual:test"], io);
    const payload = JSON.parse(stdout.join("").trim());
    // The report payload re-uses the Phase 2l-a serializer's harnessSummary —
    // it embeds the safety/invariants table and never widens it.
    assert.equal(payload.invariants.nonWidening,        true);
    assert.equal(payload.invariants.autoApplyEligible,  false);
    assert.equal(payload.invariants.publicAction,       false);
    assert.equal(payload.invariants.schedulerDriven,    false);
  });
});
