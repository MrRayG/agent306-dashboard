/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-d: MANUAL LEARNING-LOOP REPORT RUNNER (READ-ONLY / STDOUT-ONLY)
 *
 * Phase 2l-b shipped `buildLearningLoopReport`: a deterministic, propose-only,
 * test-only helper that wraps one Phase 2l-a harness run into a structured
 * report payload. Until now the only way to exercise it outside of the test
 * suite was an ad-hoc `tsx -e "..."` invocation, which is easy to mistype
 * and easy to point at the wrong inputs.
 *
 * Phase 2l-d adds the narrowest possible operator entry point: a manual CLI
 * that pins inputs explicitly and prints exactly one report payload to
 * stdout. It is the propose-only / stdout-only sibling of the Phase 2i-a
 * fixture registration script — same operator ergonomics, none of the
 * write-side authority.
 *
 * Phase 2l-d is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot wiring,
 *     no UI control, no API endpoint, no monitor side effect. The only way
 *     this code runs is when an operator (or a test) invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its output to stdout. It opens no
 *     file, appends to no JSONL, touches no database, sets no env var,
 *     signals no scheduler, and mutates no in-memory map.
 *   - READ-ONLY / PROPOSE-ONLY: every artefact embedded in the printed
 *     payload still carries its propose-only / suggestion-only contract;
 *     this runner cannot widen those contracts.
 *   - REUSE-FIRST: the runner imports `buildLearningLoopReport` and
 *     `serializeLearningLoopReport` from Phase 2l-b and shapes the
 *     output. It does NOT re-derive any evidence and does NOT duplicate
 *     report / harness logic.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical `--now`,
 *     `--run-label`, `--operator`, and `--source` flags, the runner
 *     prints byte-identical output every time. There is no `Date.now`,
 *     no `Math.random`, no UUID, no env read, no wall-clock read.
 *   - NON-WIDENING: the runner cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. `summarizationTemplate` remains the only
 *     enabled sandbox kind. Disabled kinds remain disabled; the runner
 *     describes their disabled state through the report it prints,
 *     never proposes enabling them.
 *
 * Usage:
 *   npx tsx scripts/runManualLearningLoopReport.ts
 *   npx tsx scripts/runManualLearningLoopReport.ts --json
 *   npx tsx scripts/runManualLearningLoopReport.ts --pretty
 *   npx tsx scripts/runManualLearningLoopReport.ts --now 2026-05-11T17:00:00.000Z
 *   npx tsx scripts/runManualLearningLoopReport.ts --run-label phase2l-d-daily-2026-05-11
 *   npx tsx scripts/runManualLearningLoopReport.ts --operator op@phase2l-d
 *   npx tsx scripts/runManualLearningLoopReport.ts --source manual:repl
 *
 * Flags:
 *   --json              Print the report as compact JSON (default).
 *   --pretty            Print the report as 2-space-indented JSON.
 *   --now <iso>         Pin the report's `now` timestamp (ISO-8601).
 *                       When omitted no wall-clock read happens; the
 *                       report records `generatedAt: null`.
 *   --run-label <text>  Echo a free-text run label into the report's
 *                       `runLabel` metadata field. Informational only.
 *   --operator <text>   Echo a free-text operator identifier into the
 *                       report's `operator` metadata field.
 *                       Informational only — confers no authority.
 *   --source <text>     Override the report's `source` metadata field.
 *                       Defaults to `"manual:cli"` so an operator-run
 *                       invocation is distinguishable from in-process
 *                       test runs. Informational only.
 *
 * Exit codes:
 *   0  the runner printed exactly one report payload
 *   1  CLI usage error (unknown flag, malformed --now, etc.)
 *
 * What this script does NOT do:
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Touch any file, database, ledger, env var, or monitor state.
 *   - Apply, promote, register, or otherwise act on any embedded artefact.
 *   - Produce any public action or any output beyond the printed payload.
 *   - Mutate the input objects it received.
 *   - Read the wall clock — every report timestamp comes from `--now`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildLearningLoopReport,
  serializeLearningLoopReport,
  type LearningLoopReportInputs,
  type LearningLoopReport,
} from "../server/experiments/learningLoopReport.js";

/** Parsed CLI options. Each field maps 1:1 onto a Phase 2l-b report input. */
export interface ManualLearningLoopReportCliOptions {
  /** True when `--pretty` is supplied; otherwise compact JSON. */
  pretty:    boolean;
  /** Pinned ISO timestamp from `--now`, or `null` when omitted. */
  now:       string | null;
  /** Caller-supplied `--run-label`, or `null` when omitted. */
  runLabel:  string | null;
  /** Caller-supplied `--operator`, or `null` when omitted. */
  operator:  string | null;
  /** Caller-supplied `--source`. Defaults to `"manual:cli"`. */
  source:    string;
}

/** Default value for the `source` metadata field when `--source` is omitted.
 *  Distinguishes operator-run invocations from in-process test runs. */
export const DEFAULT_CLI_SOURCE = "manual:cli";

/** Default value injected into stderr error messages so a typo is obvious. */
const PROGRAM_NAME = "runManualLearningLoopReport";

/** Static usage string. Returned verbatim by `formatUsage()` so tests can
 *  pin the exact text without string-fuzz. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/runManualLearningLoopReport.ts [flags]",
  "",
  "Phase 2l-d manual learning-loop report runner.",
  "Prints exactly one deterministic, read-only, propose-only report payload",
  "to stdout. The runner does NOT write to any file, database, ledger, env",
  "var, monitor, or scheduler. Every embedded artefact still carries its",
  "propose-only / suggestion-only contract; this runner cannot widen them.",
  "",
  "Flags:",
  "  --json               Print the report as compact JSON (default).",
  "  --pretty             Print the report as 2-space-indented JSON.",
  "  --now <iso>          Pin the report's `now` timestamp (ISO-8601).",
  "                       Required for byte-identical repeat output. When",
  "                       omitted no wall-clock read happens — generatedAt",
  "                       is null.",
  "  --run-label <text>   Echo a free-text run label into the report.",
  "  --operator <text>    Echo a free-text operator identifier.",
  "                       Informational only — confers no authority.",
  `  --source <text>      Override the source field. Default: "${DEFAULT_CLI_SOURCE}".`,
  "  -h, --help           Print this usage and exit 0.",
].join("\n");

/** Safety-invariants banner printed to stderr ahead of the report. Kept
 *  separate from the JSON payload so the payload stays a single parseable
 *  JSON document on stdout. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase2l-d] manual learning-loop report runner",
  "[phase2l-d] read-only, manual-only, stdout-only",
  "[phase2l-d] no scheduler, no auto-apply, no promotion, no public action",
  "[phase2l-d] no file / database / ledger / env / monitor writes",
  "[phase2l-d] embedded artefacts retain propose-only / suggestion-only contracts",
].join("\n");

/** Discriminated result of `parseManualLearningLoopReportCliArgs`. Returning
 *  a structured value (instead of throwing) lets tests pin both success and
 *  error paths without try/catch noise. */
export type ParseResult =
  | { ok: true;  options: ManualLearningLoopReportCliOptions }
  | { ok: false; reason: string }
  | { ok: true;  helpRequested: true };

function looksLikeIsoTimestamp(value: string): boolean {
  // Cheap, deterministic ISO-8601 acceptance. Date.parse is permissive, so
  // we additionally re-serialise and compare the date roundtrip is finite.
  // Avoids accepting "" / "now" / "tomorrow".
  if (value.length < 10) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  return true;
}

/**
 * Parse a `process.argv.slice(2)` array into structured CLI options. Pure:
 * no I/O, no env read, no wall-clock read. Returns `{ ok: false, reason }`
 * for any usage error so callers can format the error themselves.
 */
export function parseManualLearningLoopReportCliArgs(argv: readonly string[]): ParseResult {
  let pretty   = false;
  let json     = false;
  let now:      string | null = null;
  let runLabel: string | null = null;
  let operator: string | null = null;
  let source:   string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        return { ok: true, helpRequested: true };
      case "--json":
        json = true;
        break;
      case "--pretty":
        pretty = true;
        break;
      case "--now": {
        const v = argv[++i];
        if (typeof v !== "string" || v.length === 0) {
          return { ok: false, reason: "--now requires an ISO-8601 timestamp" };
        }
        if (!looksLikeIsoTimestamp(v)) {
          return { ok: false, reason: `--now value is not a valid ISO timestamp: ${v}` };
        }
        now = v;
        break;
      }
      case "--run-label": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--run-label requires a non-empty value" };
        }
        runLabel = v;
        break;
      }
      case "--operator": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--operator requires a non-empty value" };
        }
        operator = v;
        break;
      }
      case "--source": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--source requires a non-empty value" };
        }
        source = v;
        break;
      }
      default:
        return { ok: false, reason: `unknown flag: ${a}` };
    }
  }

  if (json && pretty) {
    return { ok: false, reason: "--json and --pretty are mutually exclusive" };
  }

  return {
    ok:      true,
    options: {
      pretty,
      now,
      runLabel,
      operator,
      source: source ?? DEFAULT_CLI_SOURCE,
    },
  };
}

/**
 * Project a parsed CLI options object into the shape the Phase 2l-b
 * report helper expects. The runner intentionally does NOT inject any
 * `harnessInputs.history` / `auditExport` / `readiness` / `operatorDecisions`
 * / `hypothesisContext` — the helper falls back to its read-only Phase 2i
 * helpers, which are themselves byte-deterministic on identical world state.
 *
 * Test note: a future flag (e.g. `--fixture-seed`) could inject deterministic
 * test evidence; until that exists, operators should pin world state by
 * other means (e.g. run after `executeSummarizationFixtureRegistration`).
 */
export function toReportInputs(
  options: ManualLearningLoopReportCliOptions,
): LearningLoopReportInputs {
  return {
    runLabel: options.runLabel ?? undefined,
    operator: options.operator ?? undefined,
    source:   options.source,
    harnessInputs: options.now !== null ? { now: options.now } : {},
  };
}

/** I/O handles passed into `runManualLearningLoopReportCli` so tests can
 *  capture stdout/stderr without spawning a subprocess. */
export interface ManualLearningLoopReportCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** Result of one CLI invocation. The exit code is returned (not thrown)
 *  so a test can assert on it directly. */
export interface ManualLearningLoopReportCliResult {
  exitCode: number;
  /** The shaped report (or `null` when help / usage error short-circuited
   *  before report generation). Exposed for test assertions. */
  report:   LearningLoopReport | null;
}

/**
 * Run the manual learning-loop report CLI. Pure aside from the supplied
 * stdout/stderr sinks: no fs / db / env / scheduler / wall-clock touch.
 */
export function runManualLearningLoopReportCli(
  argv: readonly string[],
  io:   ManualLearningLoopReportCliIo,
): ManualLearningLoopReportCliResult {
  const parsed = parseManualLearningLoopReportCliArgs(argv);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, report: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, report: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const reportInputs = toReportInputs(parsed.options);
  const report = buildLearningLoopReport(reportInputs);
  const serialized = serializeLearningLoopReport(
    report,
    parsed.options.pretty ? { indent: 2 } : {},
  );
  io.stdout(serialized + "\n");
  return { exitCode: 0, report };
}

/** Entry-point invoked when the module is run directly via `tsx`. Tests
 *  import the named helpers above and do NOT exercise this branch. */
function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  // ESM does not give us require.main; compare resolved module URL to argv[1].
  const moduleUrl = import.meta.url;
  try {
    const argvUrl = new URL(`file://${argv1}`).href;
    return moduleUrl === argvUrl;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = runManualLearningLoopReportCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
