/**
 * Tests for Phase 2n-a — manual Phase 2 close-out report runner.
 *
 * Spec invariants pinned by this file:
 *
 *   1. The CLI argument parser handles every documented flag (including
 *      the seven per-criterion `--attest-*` flags), defaults `source` to
 *      `"manual:cli"`, rejects unknown / malformed / duplicate flags with
 *      a clear reason, and never throws.
 *   2. `--help` / `-h` short-circuits cleanly, prints the usage text to
 *      stdout, and returns exit code 0.
 *   3. The runner reuses `buildPhase2CloseOutReport` /
 *      `serializePhase2CloseOutReport` from Phase 2l-c — it does NOT
 *      define its own report logic. Identical CLI inputs produce
 *      byte-identical stdout output across repeated invocations.
 *   4. The runner is stdout-only on the happy path: stdout is exactly
 *      one JSON document; the only stderr output is the safety-
 *      invariants banner; nothing else is written anywhere.
 *   5. The runner is non-mutating: no file, database, ledger, env var,
 *      monitor state, or in-memory map is touched. The repo's live data
 *      files are byte-identical after the test run.
 *   6. Source-level guards: the runner does NOT import the scheduler /
 *      autonomy monitor / promotion gate / applyRecommendation /
 *      hypothesis mutation paths, does NOT call `Date.now` /
 *      `Math.random` / `randomUUID` / `process.env`, and does NOT call
 *      any fs write API.
 *   7. The printed JSON payload restates the Phase 2 close-out safety
 *      disclaimer block verbatim and pins every fixed invariant flag
 *      (read-only / propose-only / non-widening / no scheduler / no
 *      auto-apply / no public action / close-out-only / phase-3-gated).
 *   8. The runner can be invoked with `--now` / `--run-label` /
 *      `--operator` / `--source` and echoes those values into the
 *      report payload.
 *   9. With `--pretty` the payload is 2-space-indented JSON; without it
 *      the payload is compact JSON. The two outputs `JSON.parse` to a
 *      deeply-equal object.
 *  10. Default invocation (no `--attest-*` flags) is capped at
 *      `not_ready` because the runner intentionally injects no
 *      learning-loop evidence, no runtime-visibility snapshot, no
 *      sandbox-readiness summary, and no risk-impact summary. The
 *      phase-3 checklist still records every criterion as
 *      `unverified` and surfaces one `phase3_gate_unverified` blocker
 *      per criterion (seven). This is by design: the CLI cannot
 *      fabricate Phase 2 evidence.
 *  11. Passing every `--attest-*` flag as `satisfied` flips the
 *      phase-3 checklist aggregate to `allSatisfied=true` and clears
 *      every `phase3_gate_*` blocker, but the overall verdict stays
 *      `not_ready` while learning-loop evidence is absent. The
 *      verdict can never rise above `not_ready` from a CLI-only
 *      invocation — execution is gated by human approval and the
 *      Phase 2 evidence chain.
 *  12. A single `--attest-* violated` produces exactly one
 *      `phase3_gate_violated` blocker for that criterion. The verdict
 *      remains capped (never lifts to the candidate verdict).
 *  13. Each `--attest-*` flag can be supplied at most once; a duplicate
 *      is a usage error.
 *  14. The runner is NOT imported by `server/index.ts`, the autonomy
 *      monitor, the scheduler, the promotion gate, the apply
 *      recommendation path, or any production-running module.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so the underlying harness sees a
// clean state and so we can confirm later that no real ledger files were
// touched. The runner does no I/O — these guards are belt-and-suspenders.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2na-manual-runner-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "runManualPhase2CloseOutReport.ts");

const {
  parseManualPhase2CloseOutReportCliArgs,
  runManualPhase2CloseOutReportCli,
  toReportInputs,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
  DEFAULT_CLI_SOURCE,
  ATTESTATION_FLAG_TO_KEY,
  ATTESTATION_FLAG_ORDER,
} = await import("../../scripts/runManualPhase2CloseOutReport.ts");

const {
  PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION,
  PHASE2_CLOSE_OUT_REPORT_LABEL,
  PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER,
} = await import("../experiments/phase2CloseOutReport.ts");

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

const PINNED_AT = "2026-05-12T17:00:00.000Z";

const ALL_SATISFIED_ARGS: string[] = ATTESTATION_FLAG_ORDER.flatMap(
  (f: string) => [f, "satisfied"],
);

before(() => {
  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(TMP_LEDGER); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  for (const [label, beforeSnap, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const afterSnap = snapshot(p);
    if (beforeSnap.exists) {
      if (!afterSnap.exists) throw new Error(`Phase 2n-a tests removed live ${label}!`);
      if (afterSnap.content !== beforeSnap.content) throw new Error(`Phase 2n-a tests mutated live ${label}!`);
    } else {
      if (afterSnap.exists) throw new Error(`Phase 2n-a tests created live ${label}!`);
    }
  }
  // Only DATA_DIR / DB_PATH may have changed — verify we did not pollute
  // env any further.
  const beforeEnv = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (key === "DATA_DIR" || key === "DB_PATH") continue;
    if (beforeEnv[key] !== process.env[key]) {
      throw new Error(`Phase 2n-a tests mutated env var ${key}`);
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

describe("Phase 2n-a — argument parser", () => {
  it("returns defaults when given no flags", () => {
    const r = parseManualPhase2CloseOutReportCliArgs([]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,    false);
      assert.equal(r.options.now,       null);
      assert.equal(r.options.runLabel,  null);
      assert.equal(r.options.operator,  null);
      assert.equal(r.options.source,    DEFAULT_CLI_SOURCE);
      assert.deepEqual(r.options.phase3Attestations, {});
    } else {
      assert.fail("expected options branch");
    }
  });

  it("parses every documented metadata flag", () => {
    const r = parseManualPhase2CloseOutReportCliArgs([
      "--pretty",
      "--now",       PINNED_AT,
      "--run-label", "phase2n-a-daily-2026-05-12",
      "--operator",  "op@phase2n-a",
      "--source",    "manual:repl",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,    true);
      assert.equal(r.options.now,       PINNED_AT);
      assert.equal(r.options.runLabel,  "phase2n-a-daily-2026-05-12");
      assert.equal(r.options.operator,  "op@phase2n-a");
      assert.equal(r.options.source,    "manual:repl");
    } else {
      assert.fail("expected options branch");
    }
  });

  it("treats `--json` as the explicit default and leaves pretty=false", () => {
    const r = parseManualPhase2CloseOutReportCliArgs(["--json"]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty, false);
    }
  });

  it("rejects `--json` combined with `--pretty`", () => {
    const r = parseManualPhase2CloseOutReportCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /mutually exclusive/);
    }
  });

  it("rejects an unknown flag with a clear reason", () => {
    const r = parseManualPhase2CloseOutReportCliArgs(["--nope"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /unknown flag: --nope/);
    }
  });

  it("rejects a malformed --now", () => {
    const r = parseManualPhase2CloseOutReportCliArgs(["--now", "yesterday"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /not a valid ISO timestamp/);
    }
  });

  it("rejects an empty --run-label / --operator / --source", () => {
    for (const flag of ["--run-label", "--operator", "--source"]) {
      const r = parseManualPhase2CloseOutReportCliArgs([flag, "   "]);
      assert.equal(r.ok, false, `${flag} should reject whitespace-only value`);
    }
  });

  it("signals --help / -h via the helpRequested branch", () => {
    for (const flag of ["--help", "-h"]) {
      const r = parseManualPhase2CloseOutReportCliArgs([flag]);
      assert.equal(r.ok, true);
      if (r.ok === true && "helpRequested" in r) {
        assert.equal(r.helpRequested, true);
      } else {
        assert.fail(`${flag} should yield helpRequested=true`);
      }
    }
  });

  it("parses every individual attestation flag with each of the three values", () => {
    for (const flag of ATTESTATION_FLAG_ORDER) {
      for (const value of ["satisfied", "violated", "unverified"]) {
        const r = parseManualPhase2CloseOutReportCliArgs([flag, value]);
        assert.equal(r.ok, true, `${flag} ${value} should parse`);
        if (r.ok === true && !("helpRequested" in r)) {
          const key = ATTESTATION_FLAG_TO_KEY[flag];
          assert.equal(r.options.phase3Attestations[key], value,
            `${flag} ${value} should map to ${key}=${value}`);
        }
      }
    }
  });

  it("rejects an unknown attestation value", () => {
    const r = parseManualPhase2CloseOutReportCliArgs([
      "--attest-rollback-proof", "maybe",
    ]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /satisfied, violated, unverified/);
      assert.match(r.reason, /got: maybe/);
    }
  });

  it("rejects a missing value for an attestation flag", () => {
    const r = parseManualPhase2CloseOutReportCliArgs([
      "--attest-rollback-proof",
    ]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /--attest-rollback-proof requires a value/);
    }
  });

  it("rejects a duplicate attestation flag", () => {
    const r = parseManualPhase2CloseOutReportCliArgs([
      "--attest-rollback-proof", "satisfied",
      "--attest-rollback-proof", "violated",
    ]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /--attest-rollback-proof was supplied more than once/);
    }
  });

  it("parses every attestation flag as `satisfied` in one call", () => {
    const r = parseManualPhase2CloseOutReportCliArgs(ALL_SATISFIED_ARGS);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      const att = r.options.phase3Attestations;
      assert.equal(Object.keys(att).length, ATTESTATION_FLAG_ORDER.length);
      for (const flag of ATTESTATION_FLAG_ORDER) {
        const key = ATTESTATION_FLAG_TO_KEY[flag];
        assert.equal(att[key], "satisfied");
      }
    } else {
      assert.fail("expected options branch");
    }
  });
});

// ── toReportInputs projection ──────────────────────────────────────────────

describe("Phase 2n-a — toReportInputs", () => {
  it("projects defaults without injecting harness inputs beyond `now`", () => {
    const inputs = toReportInputs({
      pretty:             false,
      now:                null,
      runLabel:           null,
      operator:           null,
      source:             DEFAULT_CLI_SOURCE,
      phase3Attestations: {},
    });
    assert.equal(inputs.runLabel,           undefined);
    assert.equal(inputs.operator,           undefined);
    assert.equal(inputs.source,             DEFAULT_CLI_SOURCE);
    assert.deepEqual(inputs.learningLoopInputs, {});
    assert.equal(inputs.phase3Attestations, undefined,
      "empty attestations object must project to undefined so helper applies its own defaults");
  });

  it("forwards a pinned --now into learningLoopInputs.harnessInputs.now", () => {
    const inputs = toReportInputs({
      pretty:             false,
      now:                PINNED_AT,
      runLabel:           "label-x",
      operator:           "op-x",
      source:             "manual:repl",
      phase3Attestations: {},
    });
    assert.equal(inputs.runLabel, "label-x");
    assert.equal(inputs.operator, "op-x");
    assert.equal(inputs.source,   "manual:repl");
    assert.deepEqual(inputs.learningLoopInputs, { harnessInputs: { now: PINNED_AT } });
  });

  it("forwards non-empty attestations through verbatim", () => {
    const inputs = toReportInputs({
      pretty:             false,
      now:                null,
      runLabel:           null,
      operator:           null,
      source:             DEFAULT_CLI_SOURCE,
      phase3Attestations: { rollbackProof: "satisfied" },
    });
    assert.deepEqual(inputs.phase3Attestations, { rollbackProof: "satisfied" });
  });
});

// ── CLI happy path ──────────────────────────────────────────────────────────

describe("Phase 2n-a — runManualPhase2CloseOutReportCli happy path", () => {
  it("prints help to stdout and exits 0 on --help", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualPhase2CloseOutReportCli(["--help"], io);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report, null);
    assert.equal(stdout.join(""), USAGE_TEXT + "\n");
    assert.equal(stderr.join(""), "");
  });

  it("prints a deterministic JSON payload with pinned --now and metadata", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const { stdout, stderr, io } = makeIo();
    const result = runManualPhase2CloseOutReportCli([
      "--now",       PINNED_AT,
      "--run-label", "phase2n-a-daily-2026-05-12",
      "--operator",  "op@phase2n-a",
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

    assert.equal(payload.schemaVersion, PHASE2_CLOSE_OUT_REPORT_SCHEMA_VERSION);
    assert.equal(payload.label,         PHASE2_CLOSE_OUT_REPORT_LABEL);
    assert.equal(payload.runLabel,      "phase2n-a-daily-2026-05-12");
    assert.equal(payload.operator,      "op@phase2n-a");
    assert.equal(payload.source,        "manual:test");
    assert.equal(payload.generatedAt,   PINNED_AT);

    // Safety contract restated verbatim.
    assert.deepEqual(payload.safetyDisclaimer, [...PHASE2_CLOSE_OUT_REPORT_SAFETY_DISCLAIMER]);
    assert.equal(payload.invariants.readOnly,              true);
    assert.equal(payload.invariants.proposeOnly,           true);
    assert.equal(payload.invariants.suggestionOnly,        true);
    assert.equal(payload.invariants.nonWidening,           true);
    assert.equal(payload.invariants.autoApplyEligible,     false);
    assert.equal(payload.invariants.publicAction,          false);
    assert.equal(payload.invariants.schedulerDriven,       false);
    assert.equal(payload.invariants.runtimeActionEligible, false);
    assert.equal(payload.invariants.publicActionEligible,  false);
    assert.equal(payload.invariants.closeOutOnly,          true);
    assert.equal(payload.invariants.phase3Gated,           true);
  });

  it("produces byte-identical stdout for repeat invocations with identical flags", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const argv = [
      "--now",       PINNED_AT,
      "--run-label", "phase2n-a-repeat",
      "--operator",  "op@phase2n-a",
      "--source",    "manual:test",
    ];

    const a = makeIo(); runManualPhase2CloseOutReportCli(argv, a.io);
    const b = makeIo(); runManualPhase2CloseOutReportCli(argv, b.io);
    assert.equal(a.stdout.join(""), b.stdout.join(""));
    assert.equal(a.stderr.join(""), b.stderr.join(""));
  });

  it("produces byte-identical stdout for repeat invocations with all attestations satisfied", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const argv = [
      "--now",       PINNED_AT,
      "--run-label", "phase2n-a-all-satisfied",
      "--operator",  "op@phase2n-a",
      "--source",    "manual:test",
      ...ALL_SATISFIED_ARGS,
    ];

    const a = makeIo(); runManualPhase2CloseOutReportCli(argv, a.io);
    const b = makeIo(); runManualPhase2CloseOutReportCli(argv, b.io);
    assert.equal(a.stdout.join(""), b.stdout.join(""));
  });

  it("--pretty produces indented JSON that parses to the same object as compact JSON", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const compact = makeIo();
    runManualPhase2CloseOutReportCli(["--now", PINNED_AT, "--source", "manual:test"], compact.io);

    const pretty = makeIo();
    runManualPhase2CloseOutReportCli(["--pretty", "--now", PINNED_AT, "--source", "manual:test"], pretty.io);

    const compactStr = compact.stdout.join("").trim();
    const prettyStr  = pretty.stdout.join("").trim();
    assert.notEqual(compactStr, prettyStr, "--pretty should change formatting");
    assert.ok(prettyStr.includes("\n  "), "--pretty should produce indented JSON");
    assert.deepEqual(JSON.parse(compactStr), JSON.parse(prettyStr));
  });

  it("defaults source to manual:cli when --source is omitted", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
    const { stdout, io } = makeIo();
    runManualPhase2CloseOutReportCli(["--now", PINNED_AT], io);
    const payload = JSON.parse(stdout.join("").trim());
    assert.equal(payload.source, DEFAULT_CLI_SOURCE);
  });

  it("records generatedAt=null when --now is omitted (no wall-clock read)", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
    const { stdout, io } = makeIo();
    runManualPhase2CloseOutReportCli([], io);
    const payload = JSON.parse(stdout.join("").trim());
    assert.equal(payload.generatedAt, null);
  });
});

// ── CLI error path ──────────────────────────────────────────────────────────

describe("Phase 2n-a — runManualPhase2CloseOutReportCli error path", () => {
  it("returns exitCode=1 with stderr usage on unknown flag, no stdout", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualPhase2CloseOutReportCli(["--bogus"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report, null);
    assert.equal(stdout.join(""), "");
    const stderrStr = stderr.join("");
    assert.match(stderrStr, /unknown flag: --bogus/);
    assert.ok(stderrStr.includes(USAGE_TEXT), "should embed usage in stderr");
  });

  it("returns exitCode=1 with stderr usage on malformed --now", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualPhase2CloseOutReportCli(["--now", "tomorrow"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /not a valid ISO timestamp/);
  });

  it("returns exitCode=1 on unknown attestation value", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualPhase2CloseOutReportCli([
      "--attest-rollback-proof", "kinda",
    ], io);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /got: kinda/);
  });

  it("returns exitCode=1 on duplicate attestation flag", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runManualPhase2CloseOutReportCli([
      "--attest-rollback-proof", "satisfied",
      "--attest-rollback-proof", "satisfied",
    ], io);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /supplied more than once/);
  });
});

// ── Safety invariants banner ────────────────────────────────────────────────

describe("Phase 2n-a — safety invariants banner", () => {
  it("restates read-only / manual-only / stdout-only / no-scheduler / no-auto-apply / no-public-action", () => {
    assert.match(SAFETY_INVARIANTS_BANNER, /read-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /manual-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /stdout-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no scheduler/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no auto-apply/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no public action/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /close-out-only/i);
    // The banner must make crystal clear that the highest verdict is a
    // CANDIDATE only — Phase 3 execution is still gated.
    assert.match(SAFETY_INVARIANTS_BANNER, /ready_for_sandbox_only_trial_candidate/);
    assert.match(SAFETY_INVARIANTS_BANNER, /CANDIDATE/);
  });

  it("usage text documents every flag", () => {
    for (const flag of ["--json", "--pretty", "--now", "--run-label", "--operator", "--source"]) {
      assert.ok(USAGE_TEXT.includes(flag), `usage text missing ${flag}`);
    }
    for (const flag of ATTESTATION_FLAG_ORDER) {
      assert.ok(USAGE_TEXT.includes(flag), `usage text missing attestation flag ${flag}`);
    }
  });
});

// ── Source-level non-widening / no-side-effect guards ─────────────────────

describe("Phase 2n-a — source-level guards (script file)", () => {
  const rawSrc = fs.readFileSync(SCRIPT_PATH, "utf8");
  // Strip /* ... */ block comments and //-line comments so doc-comment
  // mentions of "Date.now" etc. do not trigger the API-usage guards. We
  // are checking real code, not prose.
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("delegates to buildPhase2CloseOutReport / serializePhase2CloseOutReport (does not duplicate report logic)", () => {
    assert.ok(src.includes("buildPhase2CloseOutReport"),
      "script must import buildPhase2CloseOutReport from Phase 2l-c");
    assert.ok(src.includes("serializePhase2CloseOutReport"),
      "script must import serializePhase2CloseOutReport from Phase 2l-c");
    // It should NOT redefine the report builder.
    assert.equal(
      (src.match(/function\s+buildPhase2CloseOutReport\b/g) ?? []).length,
      0,
      "script must not redefine buildPhase2CloseOutReport",
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
      /\bfs\.rm\b/,
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

// ── Phase 3 attestation behaviour ─────────────────────────────────────────

describe("Phase 2n-a — Phase 3 attestation behaviour", () => {
  it("default invocation (no attestations) caps verdict at not_ready and records 7 unverified phase3 blockers", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const { stdout, io } = makeIo();
    runManualPhase2CloseOutReportCli(["--now", PINNED_AT, "--source", "manual:test"], io);
    const payload = JSON.parse(stdout.join("").trim());

    // Verdict cap — CLI alone cannot fabricate Phase 2 evidence, so the
    // underlying learning loop is cold and the verdict cannot rise.
    assert.equal(payload.readinessRecommendation, "not_ready");

    // Every Phase 3 criterion shows up as unverified regardless.
    assert.equal(payload.phase3Gating.criteria.length, ATTESTATION_FLAG_ORDER.length);
    for (const c of payload.phase3Gating.criteria) {
      assert.equal(c.attestation, "unverified");
      assert.equal(c.satisfied,   false);
    }
    assert.equal(payload.phase3Gating.aggregate.allSatisfied, false);
    assert.equal(payload.phase3Gating.aggregate.unverified,   ATTESTATION_FLAG_ORDER.length);
    assert.equal(payload.phase3Gating.aggregate.violated,     0);

    // Exactly one phase3_gate_unverified blocker per criterion.
    const unverifiedBlockers = payload.blockers.filter(
      (b: { code: string }) => b.code === "phase3_gate_unverified",
    );
    assert.equal(unverifiedBlockers.length, ATTESTATION_FLAG_ORDER.length);
  });

  it("all attestations satisfied marks the checklist allSatisfied=true but cannot lift the verdict from a CLI-only invocation", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    const { stdout, io } = makeIo();
    runManualPhase2CloseOutReportCli([
      "--now",      PINNED_AT,
      "--source",   "manual:test",
      ...ALL_SATISFIED_ARGS,
    ], io);
    const payload = JSON.parse(stdout.join("").trim());

    // CRITICAL non-widening property: with no learning-loop evidence
    // injected, attestations alone CANNOT lift the verdict above
    // not_ready. The verdict can never reach the candidate verdict
    // from a CLI-only invocation.
    assert.equal(payload.readinessRecommendation, "not_ready");
    assert.notEqual(payload.readinessRecommendation, "ready_for_sandbox_only_trial_candidate");

    // The checklist itself reflects what was attested.
    assert.equal(payload.phase3Gating.aggregate.allSatisfied, true);
    assert.equal(payload.phase3Gating.aggregate.satisfied,    ATTESTATION_FLAG_ORDER.length);
    assert.equal(payload.phase3Gating.aggregate.unverified,   0);
    assert.equal(payload.phase3Gating.aggregate.violated,     0);

    // No phase3_gate_unverified / phase3_gate_violated blockers.
    for (const b of payload.blockers) {
      assert.notEqual(b.code, "phase3_gate_unverified");
      assert.notEqual(b.code, "phase3_gate_violated");
    }

    // Non-widening: invariants stay fixed.
    assert.equal(payload.invariants.autoApplyEligible,     false);
    assert.equal(payload.invariants.publicAction,          false);
    assert.equal(payload.invariants.schedulerDriven,       false);
    assert.equal(payload.invariants.runtimeActionEligible, false);
    assert.equal(payload.invariants.publicActionEligible,  false);
    assert.equal(payload.invariants.closeOutOnly,          true);
    assert.equal(payload.invariants.phase3Gated,           true);
  });

  it("a single violated attestation surfaces exactly one phase3_gate_violated blocker and caps the verdict", () => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}

    // Start from all-satisfied, then flip one to violated.
    const argv = [
      "--now",    PINNED_AT,
      "--source", "manual:test",
      ...ALL_SATISFIED_ARGS,
    ];
    // Replace the value following the first --attest-rollback-proof.
    const idx = argv.indexOf("--attest-rollback-proof");
    assert.ok(idx >= 0);
    argv[idx + 1] = "violated";

    const { stdout, io } = makeIo();
    runManualPhase2CloseOutReportCli(argv, io);
    const payload = JSON.parse(stdout.join("").trim());

    // Verdict must NOT be the candidate verdict.
    assert.notEqual(payload.readinessRecommendation, "ready_for_sandbox_only_trial_candidate");

    // Aggregate reflects the single violation.
    assert.equal(payload.phase3Gating.aggregate.allSatisfied, false);
    assert.equal(payload.phase3Gating.aggregate.violated,     1);

    // Exactly one phase3_gate_violated blocker, naming the criterion.
    const violatedBlockers = payload.blockers.filter(
      (b: { code: string }) => b.code === "phase3_gate_violated",
    );
    assert.equal(violatedBlockers.length, 1);
    assert.match(violatedBlockers[0].message, /rollbackProof/);
  });
});

// ── Production / runtime isolation ─────────────────────────────────────────

describe("Phase 2n-a — production runtime isolation", () => {
  // The runner is a manual / propose-only operator entry point and must
  // not be wired into any production module. A grep across server/ for
  // the runner script path is the cheapest, most robust guard.
  it("is NOT imported by any module under server/", () => {
    const SERVER_DIR = path.join(REPO_ROOT, "server");
    const TEST_FILENAME = path.basename(SCRIPT_PATH).replace(/\.ts$/, "");
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
        // The test file itself is allowed to mention the runner.
        if (path.basename(full) === path.basename(__filename())) continue;
        const text = fs.readFileSync(full, "utf8");
        // Look only for real import sites — not stringly mentions in
        // comments or constants.
        const importRe = new RegExp(
          `from\\s+["'][^"']*${TEST_FILENAME}[^"']*["']`,
        );
        if (importRe.test(text)) {
          offenders.push(full);
        }
      }
    }
    function __filename(): string {
      return new URL(import.meta.url).pathname;
    }

    walk(SERVER_DIR);
    assert.deepEqual(offenders, [],
      `Phase 2n-a runner must not be imported by any module under server/. Offenders: ${offenders.join(", ")}`);
  });
});
