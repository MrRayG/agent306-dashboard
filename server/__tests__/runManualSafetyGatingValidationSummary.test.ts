/**
 * Tests for Phase 2m-e — manual safety-gating validation summary runner.
 *
 * Spec invariants pinned by this file:
 *
 *   1. The CLI argument parser handles every documented flag, defaults
 *      `source` to `"manual:cli"`, resolves `--file` against the provided
 *      cwd, and rejects unknown / malformed flags with a clear reason
 *      and no thrown exception.
 *   2. `--help` / `-h` short-circuits cleanly, prints USAGE_TEXT to
 *      stdout, and returns exit code 0 (no fs read, no summary build).
 *   3. The runner reuses `summarizeSafetyGatingValidation` from
 *      Phase 2m-d — it does NOT define its own summary logic. Identical
 *      CLI inputs over identical file contents produce byte-identical
 *      stdout across repeated invocations.
 *   4. On the happy path stdout is exactly one JSON document; stderr
 *      contains only the SAFETY_INVARIANTS_BANNER followed by a newline;
 *      nothing else is written anywhere.
 *   5. The runner is non-mutating: the repo's live data files are
 *      byte-identical after the test run; no file, database, ledger,
 *      env var, or in-memory map is touched.
 *   6. Source-level guards: the runner does NOT import the scheduler /
 *      autonomy monitor / promotion gate / applyRecommendation /
 *      hypothesis mutation paths, does NOT call `Date.now` /
 *      `Math.random` / `randomUUID`, does NOT read `process.env`, and
 *      does NOT call any fs write API.
 *   7. The printed envelope embeds the Phase 2m-d summary verbatim,
 *      including its schemaVersion, label, and invariants block.
 *   8. With `--pretty` the payload is 2-space-indented JSON; without it
 *      the payload is compact JSON. The two outputs `JSON.parse` to a
 *      deeply-equal object.
 *   9. Exit code semantics: 0 when summary detects the safety-gating
 *      hypothesis with measurementPathAccessible=true, manualValidation
 *      attached, status="ok", and violationCount===0; 2 when status is
 *      "violated" or violationCount>0; 3 when undetected, no
 *      manualValidation, status="blocked", or
 *      measurementPathAccessible=false; 1 for CLI usage errors and file
 *      errors.
 *  10. `loadHypothesesFile` tolerates both `{ hypotheses: [...] }` and a
 *      bare array, and returns a structured error (never throws) on
 *      missing file / invalid JSON / wrong shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "runManualSafetyGatingValidationSummary.ts",
);

const {
  parseManualSafetyGatingValidationSummaryCliArgs,
  runManualSafetyGatingValidationSummaryCli,
  loadHypothesesFile,
  buildEnvelope,
  serializeEnvelope,
  exitCodeForSummary,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
  DEFAULT_CLI_SOURCE,
  DEFAULT_HYPOTHESIS_FILE,
  PHASE_2M_E_ENVELOPE_SCHEMA_VERSION,
  PHASE_2M_E_ENVELOPE_LABEL,
} = await import("../../scripts/runManualSafetyGatingValidationSummary.ts");

const {
  SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
  SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
  SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS,
  SAFETY_GATING_HYPOTHESIS_ID,
} = await import("../eval/safetyGatingValidationSummary.ts");

const PINNED_AT = "2026-05-12T18:00:00.000Z";

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT = snapshot(REAL_RESEARCH_LAB);
const ENV_SNAPSHOT = JSON.stringify(process.env);

interface CapturedIo {
  stdout: string[];
  stderr: string[];
}
function makeIo(): { io: { stdout: (s: string) => void; stderr: (s: string) => void }; captured: CapturedIo } {
  const captured: CapturedIo = { stdout: [], stderr: [] };
  return {
    captured,
    io: {
      stdout: (s) => captured.stdout.push(s),
      stderr: (s) => captured.stderr.push(s),
    },
  };
}

function writeTmpHypothesisFile(contents: unknown): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase2me-runner-test-"));
  const filePath = path.join(tmp, "research_lab.json");
  fs.writeFileSync(filePath, JSON.stringify(contents), "utf8");
  return filePath;
}

// ─── 1. CLI argument parser ──────────────────────────────────────────────

describe("phase2m-e: parseManualSafetyGatingValidationSummaryCliArgs", () => {
  it("parses empty args with defaults", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs([], "/tmp/cwd");
    assert.equal(r.ok, true);
    if (r.ok && !("helpRequested" in r)) {
      assert.equal(r.options.pretty, false);
      assert.equal(r.options.now, null);
      assert.equal(r.options.runLabel, null);
      assert.equal(r.options.operator, null);
      assert.equal(r.options.source, DEFAULT_CLI_SOURCE);
      assert.equal(
        r.options.filePath,
        path.resolve("/tmp/cwd", DEFAULT_HYPOTHESIS_FILE),
      );
    }
  });

  it("parses every documented flag", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(
      [
        "--pretty",
        "--file", "custom/lab.json",
        "--now", PINNED_AT,
        "--run-label", "phase2m-e-daily-2026-05-12",
        "--operator", "op@phase2m-e",
        "--source", "manual:repl",
      ],
      "/tmp/cwd",
    );
    assert.equal(r.ok, true);
    if (r.ok && !("helpRequested" in r)) {
      assert.equal(r.options.pretty, true);
      assert.equal(r.options.filePath, path.resolve("/tmp/cwd", "custom/lab.json"));
      assert.equal(r.options.now, PINNED_AT);
      assert.equal(r.options.runLabel, "phase2m-e-daily-2026-05-12");
      assert.equal(r.options.operator, "op@phase2m-e");
      assert.equal(r.options.source, "manual:repl");
    }
  });

  it("preserves an absolute --file path verbatim", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(
      ["--file", "/absolute/path/lab.json"],
      "/tmp/cwd",
    );
    assert.equal(r.ok, true);
    if (r.ok && !("helpRequested" in r)) {
      assert.equal(r.options.filePath, "/absolute/path/lab.json");
    }
  });

  it("rejects --json combined with --pretty", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /mutually exclusive/);
    }
  });

  it("rejects a malformed --now value", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(["--now", "tomorrow"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /not a valid ISO timestamp/);
    }
  });

  it("rejects an empty --run-label", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(["--run-label", "   "]);
    assert.equal(r.ok, false);
  });

  it("rejects an unknown flag with a clear reason", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(["--auto-apply"]);
    assert.equal(r.ok, false);
    if (r.ok === false) {
      assert.match(r.reason, /unknown flag: --auto-apply/);
    }
  });

  it("reports --help cleanly", () => {
    const r = parseManualSafetyGatingValidationSummaryCliArgs(["--help"]);
    assert.equal(r.ok, true);
    assert.equal("helpRequested" in r && r.helpRequested, true);
  });
});

// ─── 2. loadHypothesesFile ───────────────────────────────────────────────

describe("phase2m-e: loadHypothesesFile", () => {
  it("loads { hypotheses: [...] } shape", () => {
    const fp = writeTmpHypothesisFile({ hypotheses: [{ id: "h1" }, { id: "h2" }] });
    const r = loadHypothesesFile(fp);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.hypotheses.length, 2);
  });

  it("loads a bare array", () => {
    const fp = writeTmpHypothesisFile([{ id: "h1" }]);
    const r = loadHypothesesFile(fp);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.hypotheses.length, 1);
  });

  it("returns ok=false on missing file (no throw)", () => {
    const r = loadHypothesesFile("/nonexistent/path/lab.json");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not found/);
  });

  it("returns ok=false on invalid JSON (no throw)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase2me-bad-json-"));
    const fp = path.join(tmp, "bad.json");
    fs.writeFileSync(fp, "{ this is not json", "utf8");
    const r = loadHypothesesFile(fp);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not valid JSON/);
  });

  it("returns ok=false on wrong shape (no throw)", () => {
    const fp = writeTmpHypothesisFile({ not_hypotheses: 1 });
    const r = loadHypothesesFile(fp);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /hypotheses/);
  });
});

// ─── 3. exitCodeForSummary table ─────────────────────────────────────────

describe("phase2m-e: exitCodeForSummary", () => {
  function summary(over: Record<string, unknown> = {}) {
    return {
      schemaVersion: SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
      label:         SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
      hypothesisId:  SAFETY_GATING_HYPOTHESIS_ID,
      detected:      true,
      metricKey:     "promotion_boundary_violation_count",
      measurementPathAccessible: true,
      hasManualValidation: true,
      latestManualValidationStatus: "ok",
      violationCount: 0,
      passingFindingCount: 1,
      warningsCount: 0,
      blockersCount: 0,
      readinessVerdict: null,
      readiness: "operator_gated",
      invariants: SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS,
      generatedAt: null,
      ...over,
    } as any;
  }

  it("returns 0 on ok evidence", () => {
    assert.equal(exitCodeForSummary(summary()), 0);
  });
  it("returns 2 on violated status", () => {
    assert.equal(exitCodeForSummary(summary({ latestManualValidationStatus: "violated" })), 2);
  });
  it("returns 2 on violationCount > 0", () => {
    assert.equal(exitCodeForSummary(summary({ violationCount: 3 })), 2);
  });
  it("returns 3 when not detected", () => {
    assert.equal(exitCodeForSummary(summary({ detected: false })), 3);
  });
  it("returns 3 when measurement path inaccessible", () => {
    assert.equal(exitCodeForSummary(summary({ measurementPathAccessible: false })), 3);
  });
  it("returns 3 when manualValidation missing", () => {
    assert.equal(exitCodeForSummary(summary({ hasManualValidation: false })), 3);
  });
  it("returns 3 on blocked status", () => {
    assert.equal(exitCodeForSummary(summary({ latestManualValidationStatus: "blocked" })), 3);
  });
});

// ─── 4. Full CLI happy path ──────────────────────────────────────────────

describe("phase2m-e: runManualSafetyGatingValidationSummaryCli", () => {
  it("--help prints USAGE_TEXT to stdout, exit 0, no fs touched", () => {
    const { io, captured } = makeIo();
    let fsCalls = 0;
    const r = runManualSafetyGatingValidationSummaryCli(["--help"], io, {
      fs: {
        existsSync: () => { fsCalls++; return true; },
        readFileSync: ((_p: any) => { fsCalls++; return "[]"; }) as any,
      },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.envelope, null);
    assert.equal(captured.stdout.join(""), USAGE_TEXT + "\n");
    assert.equal(captured.stderr.join(""), "");
    assert.equal(fsCalls, 0);
  });

  it("usage error prints reason and USAGE to stderr, exit 1", () => {
    const { io, captured } = makeIo();
    const r = runManualSafetyGatingValidationSummaryCli(["--bogus"], io);
    assert.equal(r.exitCode, 1);
    assert.equal(r.envelope, null);
    assert.equal(captured.stdout.length, 0);
    assert.match(captured.stderr.join(""), /unknown flag: --bogus/);
    assert.match(captured.stderr.join(""), /Usage:/);
  });

  it("missing input file yields exit 1 without writing to stdout", () => {
    const { io, captured } = makeIo();
    const r = runManualSafetyGatingValidationSummaryCli(
      ["--file", "/nope/lab.json"],
      io,
    );
    assert.equal(r.exitCode, 1);
    assert.equal(captured.stdout.length, 0);
    assert.match(captured.stderr.join(""), /not found/);
  });

  it("happy path: detected + ok evidence → exit 0, one JSON doc on stdout, banner on stderr", () => {
    const okHypothesis = {
      id: SAFETY_GATING_HYPOTHESIS_ID,
      metric: "promotion_boundary_violation_count",
      measurementPathAccessible: true,
      manualValidation: {
        label: "phase2m-c.manual",
        metricKey: "promotion_boundary_violation_count",
        status: "ok",
        violationCount: 0,
        findingsPassed: ["single_write_site_confirmed"],
        warnings: [],
        blockers: [],
      },
    };
    const fp = writeTmpHypothesisFile({ hypotheses: [okHypothesis] });

    const { io, captured } = makeIo();
    const r = runManualSafetyGatingValidationSummaryCli(
      ["--file", fp, "--now", PINNED_AT, "--run-label", "phase2m-e-test"],
      io,
    );
    assert.equal(r.exitCode, 0);
    assert.ok(r.envelope);

    // stderr is exactly the safety banner + newline.
    assert.equal(captured.stderr.join(""), SAFETY_INVARIANTS_BANNER + "\n");

    // stdout is exactly one JSON document with a trailing newline.
    const out = captured.stdout.join("");
    assert.ok(out.endsWith("\n"));
    const parsed = JSON.parse(out.trimEnd());
    assert.equal(parsed.schemaVersion, PHASE_2M_E_ENVELOPE_SCHEMA_VERSION);
    assert.equal(parsed.label, PHASE_2M_E_ENVELOPE_LABEL);
    assert.equal(parsed.runLabel, "phase2m-e-test");
    assert.equal(parsed.inputFile, fp);
    assert.equal(parsed.hypothesisCount, 1);
    assert.equal(
      parsed.summary.schemaVersion,
      SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
    );
    assert.equal(parsed.summary.detected, true);
    assert.equal(parsed.summary.hasManualValidation, true);
    assert.equal(parsed.summary.latestManualValidationStatus, "ok");
    assert.equal(parsed.summary.violationCount, 0);
    assert.deepEqual(
      parsed.summary.invariants,
      [...SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS],
    );
    assert.equal(parsed.summary.generatedAt, PINNED_AT);
  });

  it("violated evidence → exit code 2", () => {
    const violated = {
      id: SAFETY_GATING_HYPOTHESIS_ID,
      metric: "promotion_boundary_violation_count",
      measurementPathAccessible: true,
      manualValidation: {
        label: "phase2m-c.manual",
        metricKey: "promotion_boundary_violation_count",
        status: "violated",
        violationCount: 2,
        findingsPassed: [],
        warnings: [],
        blockers: [],
      },
    };
    const fp = writeTmpHypothesisFile({ hypotheses: [violated] });
    const { io } = makeIo();
    const r = runManualSafetyGatingValidationSummaryCli(["--file", fp], io);
    assert.equal(r.exitCode, 2);
  });

  it("undetected hypothesis → exit code 3", () => {
    const fp = writeTmpHypothesisFile({ hypotheses: [{ id: "some_other_hypothesis" }] });
    const { io, captured } = makeIo();
    const r = runManualSafetyGatingValidationSummaryCli(["--file", fp], io);
    assert.equal(r.exitCode, 3);
    const parsed = JSON.parse(captured.stdout.join("").trimEnd());
    assert.equal(parsed.summary.detected, false);
  });

  it("pretty vs compact both parse to deeply-equal objects", () => {
    const okHypothesis = {
      id: SAFETY_GATING_HYPOTHESIS_ID,
      metric: "promotion_boundary_violation_count",
      measurementPathAccessible: true,
      manualValidation: {
        label: "phase2m-c.manual",
        metricKey: "promotion_boundary_violation_count",
        status: "ok",
        violationCount: 0,
        findingsPassed: ["single_write_site_confirmed"],
        warnings: [],
        blockers: [],
      },
    };
    const fp = writeTmpHypothesisFile({ hypotheses: [okHypothesis] });

    const a = makeIo();
    runManualSafetyGatingValidationSummaryCli(
      ["--file", fp, "--now", PINNED_AT, "--run-label", "rl"],
      a.io,
    );
    const b = makeIo();
    runManualSafetyGatingValidationSummaryCli(
      ["--file", fp, "--now", PINNED_AT, "--run-label", "rl", "--pretty"],
      b.io,
    );

    const parsedA = JSON.parse(a.captured.stdout.join("").trimEnd());
    const parsedB = JSON.parse(b.captured.stdout.join("").trimEnd());
    assert.deepEqual(parsedA, parsedB);

    // Compact form has no whitespace; pretty form has indentation.
    assert.ok(!/\n  /.test(a.captured.stdout.join("")));
    assert.ok(/\n  /.test(b.captured.stdout.join("")));
  });

  it("byte-identical output across repeated runs with the same inputs", () => {
    const okHypothesis = {
      id: SAFETY_GATING_HYPOTHESIS_ID,
      metric: "promotion_boundary_violation_count",
      measurementPathAccessible: true,
      manualValidation: {
        label: "phase2m-c.manual",
        metricKey: "promotion_boundary_violation_count",
        status: "ok",
        violationCount: 0,
        findingsPassed: ["x"],
        warnings: [],
        blockers: [],
      },
    };
    const fp = writeTmpHypothesisFile({ hypotheses: [okHypothesis] });
    const a = makeIo();
    const b = makeIo();
    runManualSafetyGatingValidationSummaryCli(["--file", fp, "--now", PINNED_AT], a.io);
    runManualSafetyGatingValidationSummaryCli(["--file", fp, "--now", PINNED_AT], b.io);
    assert.equal(a.captured.stdout.join(""), b.captured.stdout.join(""));
    assert.equal(a.captured.stderr.join(""), b.captured.stderr.join(""));
  });
});

// ─── 5. Non-mutation invariants ──────────────────────────────────────────

describe("phase2m-e: non-mutation invariants", () => {
  it("does not mutate the repo's live research_lab.json", () => {
    if (!RESEARCH_SNAPSHOT.exists) return; // skip when file absent

    const { io } = makeIo();
    runManualSafetyGatingValidationSummaryCli(
      ["--file", REAL_RESEARCH_LAB, "--now", PINNED_AT],
      io,
    );
    const after = snapshot(REAL_RESEARCH_LAB);
    assert.equal(after.exists, true);
    assert.equal(after.content, RESEARCH_SNAPSHOT.content);
  });

  it("does not mutate process.env", () => {
    const { io } = makeIo();
    runManualSafetyGatingValidationSummaryCli(["--help"], io);
    assert.equal(JSON.stringify(process.env), ENV_SNAPSHOT);
  });
});

// ─── 6. Source-level guards ──────────────────────────────────────────────

describe("phase2m-e: source-level guards", () => {
  const src = fs.readFileSync(SCRIPT_PATH, "utf8");

  it("does not import scheduler / autonomy monitor / promotion gate", () => {
    assert.ok(!/from\s+["'][^"']*scheduler/.test(src), "imports scheduler");
    assert.ok(!/from\s+["'][^"']*autonomyMonitor/.test(src), "imports autonomyMonitor");
    assert.ok(!/from\s+["'][^"']*promotionGate/.test(src), "imports promotionGate");
    assert.ok(!/applyRecommendation/.test(src), "references applyRecommendation");
    assert.ok(!/canPromote\s*\(/.test(src), "calls canPromote");
  });

  it("does not call Date.now / Math.random / randomUUID", () => {
    assert.ok(!/Date\.now\s*\(/.test(src), "uses Date.now");
    assert.ok(!/Math\.random\s*\(/.test(src), "uses Math.random");
    assert.ok(!/randomUUID\s*\(/.test(src), "uses randomUUID");
  });

  it("does not read process.env for behaviour", () => {
    assert.ok(!/process\.env\./.test(src), "reads process.env");
  });

  it("does not call any fs write API", () => {
    assert.ok(!/fs\.writeFile/.test(src), "uses fs.writeFile");
    assert.ok(!/fs\.writeFileSync/.test(src), "uses fs.writeFileSync");
    assert.ok(!/fs\.appendFile/.test(src), "uses fs.appendFile");
    assert.ok(!/fs\.appendFileSync/.test(src), "uses fs.appendFileSync");
    assert.ok(!/fs\.mkdir/.test(src), "uses fs.mkdir");
    assert.ok(!/fs\.unlink/.test(src), "uses fs.unlink");
    assert.ok(!/fs\.rm[^a-z]/.test(src), "uses fs.rm");
  });

  it("uses only existsSync/readFileSync from fs", () => {
    const fsCalls = Array.from(src.matchAll(/fs(?:Impl)?\.([a-zA-Z]+)/g))
      .map((m) => m[1]);
    for (const name of fsCalls) {
      assert.ok(
        name === "existsSync" || name === "readFileSync",
        `unexpected fs.${name} call`,
      );
    }
  });
});

// ─── 7. Envelope / serialiser direct tests ───────────────────────────────

describe("phase2m-e: envelope + serializer", () => {
  it("buildEnvelope embeds the summary verbatim and echoes metadata", () => {
    const options = {
      pretty: false,
      filePath: "/tmp/lab.json",
      now: PINNED_AT,
      runLabel: "rl",
      operator: "op",
      source: "manual:test",
    };
    const summary: any = {
      schemaVersion: SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
      label:         SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
      hypothesisId:  SAFETY_GATING_HYPOTHESIS_ID,
      detected:      true,
      metricKey:     "promotion_boundary_violation_count",
      measurementPathAccessible: true,
      hasManualValidation: true,
      latestManualValidationStatus: "ok",
      violationCount: 0,
      passingFindingCount: 1,
      warningsCount: 0,
      blockersCount: 0,
      readinessVerdict: null,
      readiness: "operator_gated",
      invariants: SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS,
      generatedAt: PINNED_AT,
    };
    const env = buildEnvelope(options, 5, summary);
    assert.equal(env.schemaVersion, PHASE_2M_E_ENVELOPE_SCHEMA_VERSION);
    assert.equal(env.label, PHASE_2M_E_ENVELOPE_LABEL);
    assert.equal(env.runLabel, "rl");
    assert.equal(env.operator, "op");
    assert.equal(env.source, "manual:test");
    assert.equal(env.inputFile, "/tmp/lab.json");
    assert.equal(env.hypothesisCount, 5);
    assert.equal(env.summary, summary);
  });

  it("serializeEnvelope produces parseable JSON in both modes", () => {
    const env: any = {
      schemaVersion: PHASE_2M_E_ENVELOPE_SCHEMA_VERSION,
      label: PHASE_2M_E_ENVELOPE_LABEL,
      runLabel: null,
      operator: null,
      source: "manual:cli",
      inputFile: "/x",
      hypothesisCount: 0,
      summary: { schemaVersion: SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION, label: SAFETY_GATING_VALIDATION_SUMMARY_LABEL },
    };
    const a = serializeEnvelope(env, false);
    const b = serializeEnvelope(env, true);
    assert.deepEqual(JSON.parse(a), JSON.parse(b));
    assert.ok(!a.includes("\n"));
    assert.ok(b.includes("\n  "));
  });
});
