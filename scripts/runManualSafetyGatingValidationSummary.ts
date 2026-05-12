/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2m-e: MANUAL SAFETY-GATING VALIDATION SUMMARY RUNNER
 *                   (READ-ONLY / STDOUT-ONLY)
 *
 * PR #325 (phase2m-a) introduced the formal hypothesis
 *   `hyp_agent306_safety_gating_single_write_boundary`
 * with metric
 *   `promotion_boundary_violation_count`.
 *
 * PR #326 (phase2m-b) shipped `auditPromotionBoundary`, a read-only static
 * audit that produces a structured payload validating the propose-only
 * invariant currently holds.
 *
 * PR #327 (phase2m-c) recorded the first manual production validation
 * evidence under the hypothesis's `manualValidation` field and flipped
 * `measurementPathAccessible: true`, while intentionally leaving
 * `hygieneTag: "needs_review"`, `rubricVerdict: "review"`,
 * `status: "forming"`, and `queue: "backlog"` so the hypothesis remains
 * operator-gated and non-experiment-ready.
 *
 * PR #328 (phase2m-d) shipped `summarizeSafetyGatingValidation` — a pure,
 * deterministic, read-only projection over a provided hypothesis (or list
 * of hypotheses) that reports measurementPathAccessible, manualValidation
 * presence and status, violation / passing / warning / blocker counts, the
 * `canFeedExperiment` readiness verdict, and an invariants block. Until
 * now the only way to exercise that helper outside of the test suite was
 * an ad-hoc `tsx -e "..."` invocation.
 *
 * Phase 2m-e adds the narrowest possible operator entry point: a manual
 * CLI that loads the hypothesis record from `data/research_lab.json` (or
 * any caller-supplied JSON file with the same shape), runs the Phase 2m-d
 * summary, and prints exactly one summary payload to stdout. It is the
 * propose-only / stdout-only sibling of the Phase 2l-d manual learning-
 * loop report runner and the Phase 2m-b promotion-boundary audit CLI —
 * same operator ergonomics, none of the write-side authority.
 *
 * Phase 2m-e is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot
 *     wiring, no UI control, no API endpoint, no monitor side effect.
 *     The only way this code runs is when an operator (or a test)
 *     invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its summary payload to stdout. It
 *     opens no file for writing, appends to no JSONL, touches no
 *     database, sets no env var, signals no scheduler, mutates no
 *     in-memory map, and produces no file artefacts. Stderr carries
 *     only the safety-invariants banner and (on usage error) the
 *     reason + usage text.
 *   - READ-ONLY / PROPOSE-ONLY: the summary describes readiness — it
 *     cannot mark anything ready, cannot promote a hypothesis, cannot
 *     enable a sandbox kind, cannot mutate the propose-only invariant.
 *     The CLI's non-zero exit codes are signals for operators / CI;
 *     they do not trigger any action.
 *   - REUSE-FIRST: the runner imports `summarizeSafetyGatingValidation`
 *     and `serializeSafetyGatingValidationSummary` from Phase 2m-d. It
 *     does NOT re-implement any summary logic, re-derive any verdict,
 *     or duplicate the hypothesis-detection rule.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical `--file`, `--now`,
 *     `--run-label`, `--operator`, `--source` flags, and identical
 *     contents of the referenced hypothesis file, the runner prints
 *     byte-identical output every time. There is no `Date.now`, no
 *     `Math.random`, no UUID, no env read for behaviour purposes, no
 *     wall-clock read.
 *   - NON-WIDENING: the runner cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record, cannot mark anything
 *     auto-apply eligible. `summarizationTemplate` remains the only
 *     enabled sandbox kind. The hypothesis remains operator-gated.
 *
 * Usage:
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts --pretty
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts --file path/to/lab.json
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts --now 2026-05-12T18:00:00.000Z
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts --run-label phase2m-e-daily-2026-05-12
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts --operator op@phase2m-e
 *   npx tsx scripts/runManualSafetyGatingValidationSummary.ts --source manual:repl
 *
 * Flags:
 *   --json               Print the summary as compact JSON (default).
 *   --pretty             Print the summary as 2-space-indented JSON.
 *   --file <path>        Path to a JSON file with `{ hypotheses: [...] }`
 *                        (or a bare array). Defaults to
 *                        `data/research_lab.json` resolved against the
 *                        current working directory.
 *   --now <iso>          Pin the summary's `generatedAt` timestamp.
 *                        When omitted no wall-clock read happens;
 *                        generatedAt is null.
 *   --run-label <text>   Echo a free-text run label into the printed
 *                        envelope's `runLabel` metadata field.
 *   --operator <text>    Echo a free-text operator identifier into the
 *                        envelope's `operator` metadata field.
 *                        Informational only — confers no authority.
 *   --source <text>      Override the envelope's `source` field.
 *                        Default: "manual:cli".
 *   -h, --help           Print this usage and exit 0.
 *
 * Exit codes:
 *   0  summary ran, detected=true, hasManualValidation=true,
 *      latestManualValidationStatus="ok" AND violationCount===0
 *   2  summary ran, detected=true, BUT latest status is "violated"
 *      OR violationCount > 0
 *   3  summary could not produce an "ok" evidence verdict — hypothesis
 *      not detected, manualValidation missing/unreadable, status is
 *      "blocked", or measurementPathAccessible=false
 *   1  CLI usage error (unknown flag, malformed --now, file not found,
 *      file not valid JSON, etc.)
 *
 * What this script does NOT do:
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Write to any file, database, ledger, env var, or monitor state.
 *   - Apply, promote, register, or otherwise act on any artefact.
 *   - Produce any public action or any output beyond the printed payload
 *     on stdout and the safety-invariants banner on stderr.
 *   - Mutate the input objects it received (including the file it read).
 *   - Read the wall clock for behaviour — every payload timestamp comes
 *     from `--now` (or is null when omitted).
 *   - Approve the hypothesis. An `ok` evidence verdict is evidence; the
 *     formal hypothesis remains operator-gated until the existing
 *     hypothesis hygiene process advances it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  summarizeSafetyGatingValidation,
  serializeSafetyGatingValidationSummary,
  SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
  SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
  SAFETY_GATING_HYPOTHESIS_ID,
  type SafetyGatingValidationSummary,
} from "../server/eval/safetyGatingValidationSummary.js";
import type { HygieneAwareHypothesis } from "../server/hypothesisHygiene.js";

/** Parsed CLI options. Each field maps 1:1 onto a Phase 2m-d summary input
 *  or a piece of envelope metadata. */
export interface ManualSafetyGatingValidationSummaryCliOptions {
  /** True when `--pretty` is supplied; otherwise compact JSON. */
  pretty:   boolean;
  /** Resolved absolute path to the hypothesis JSON file. */
  filePath: string;
  /** Pinned ISO timestamp from `--now`, or `null` when omitted. */
  now:      string | null;
  /** Caller-supplied `--run-label`, or `null` when omitted. */
  runLabel: string | null;
  /** Caller-supplied `--operator`, or `null` when omitted. */
  operator: string | null;
  /** Caller-supplied `--source`. Defaults to `"manual:cli"`. */
  source:   string;
}

/** Default `source` value when `--source` is omitted. Distinguishes
 *  operator-run invocations from in-process test runs. */
export const DEFAULT_CLI_SOURCE = "manual:cli";

/** Default hypothesis file path relative to the current working directory,
 *  matching the convention used by `scripts/hypothesisAudit.ts`. */
export const DEFAULT_HYPOTHESIS_FILE = path.join("data", "research_lab.json");

/** Program name used in stderr error messages. */
const PROGRAM_NAME = "runManualSafetyGatingValidationSummary";

/** Stable schema identifier for the printed envelope. Bumped only when
 *  the envelope shape changes in a backwards-incompatible way. The
 *  embedded `summary` payload carries its own
 *  `SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION`. */
export const PHASE_2M_E_ENVELOPE_SCHEMA_VERSION = "phase2m-e.v1";

/** Stable envelope label so an operator can confirm provenance. */
export const PHASE_2M_E_ENVELOPE_LABEL =
  "agent306.manual_safety_gating_validation_summary";

/** Static usage string. Returned verbatim by `formatUsage()` so tests
 *  can pin the exact text without string-fuzz. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/runManualSafetyGatingValidationSummary.ts [flags]",
  "",
  "Phase 2m-e manual safety-gating validation summary runner.",
  "Prints exactly one deterministic, read-only summary payload to stdout.",
  "The runner does NOT write to any file, database, ledger, env var,",
  "monitor, or scheduler. The summary describes readiness — it cannot",
  "promote, apply, enable, or widen any contract. The hypothesis remains",
  "operator-gated.",
  "",
  "Flags:",
  "  --json               Print the payload as compact JSON (default).",
  "  --pretty             Print the payload as 2-space-indented JSON.",
  `  --file <path>        Hypothesis JSON file (default: ${DEFAULT_HYPOTHESIS_FILE}).`,
  "                       Must contain either { hypotheses: [...] } or a",
  "                       bare array. Read-only — never written back.",
  "  --now <iso>          Pin the summary's `generatedAt` timestamp.",
  "                       Required for byte-identical repeat output.",
  "                       When omitted no wall-clock read happens —",
  "                       generatedAt is null.",
  "  --run-label <text>   Echo a free-text run label into the envelope.",
  "  --operator <text>    Echo a free-text operator identifier.",
  "                       Informational only — confers no authority.",
  `  --source <text>      Override the source field. Default: "${DEFAULT_CLI_SOURCE}".`,
  "  -h, --help           Print this usage and exit 0.",
].join("\n");

/** Safety-invariants banner printed to stderr ahead of the summary. Kept
 *  separate from the stdout payload so the payload stays a single
 *  parseable JSON document. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase2m-e] manual safety-gating validation summary runner",
  "[phase2m-e] read-only, manual-only, stdout-only",
  "[phase2m-e] no scheduler, no auto-apply, no promotion, no public action",
  "[phase2m-e] no file / database / ledger / env / monitor writes",
  "[phase2m-e] evidence is NOT authorisation — hypothesis remains operator-gated",
].join("\n");

/** Discriminated parse result. Lets tests pin both success and error
 *  paths without try/catch noise. */
export type ParseResult =
  | { ok: true;  options: ManualSafetyGatingValidationSummaryCliOptions }
  | { ok: false; reason: string }
  | { ok: true;  helpRequested: true };

function looksLikeIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  return true;
}

/**
 * Parse a `process.argv.slice(2)` array into structured CLI options.
 * Pure: no I/O, no env read, no wall-clock read. Returns
 * `{ ok: false, reason }` for any usage error.
 */
export function parseManualSafetyGatingValidationSummaryCliArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): ParseResult {
  let pretty   = false;
  let json     = false;
  let filePath: string | null = null;
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
      case "--file": {
        const v = argv[++i];
        if (typeof v !== "string" || v.length === 0) {
          return { ok: false, reason: "--file requires a path" };
        }
        filePath = path.isAbsolute(v) ? v : path.resolve(cwd, v);
        break;
      }
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
    ok: true,
    options: {
      pretty,
      filePath: filePath ?? path.resolve(cwd, DEFAULT_HYPOTHESIS_FILE),
      now,
      runLabel,
      operator,
      source: source ?? DEFAULT_CLI_SOURCE,
    },
  };
}

/** Discriminated result of loading the hypothesis file. */
export type LoadHypothesesResult =
  | { ok: true;  hypotheses: HygieneAwareHypothesis[] }
  | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load and shallow-validate a hypothesis JSON file. Read-only: never
 * writes back, never opens for writing, never mutates the parsed value.
 * Tolerates both `{ hypotheses: [...] }` shape and a bare array — mirrors
 * `scripts/hypothesisAudit.ts`.
 */
export function loadHypothesesFile(
  filePath: string,
  fsImpl: Pick<typeof fs, "existsSync" | "readFileSync"> = fs,
): LoadHypothesesResult {
  if (!fsImpl.existsSync(filePath)) {
    return { ok: false, reason: `hypothesis file not found: ${filePath}` };
  }
  let raw: string;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `could not read hypothesis file: ${msg}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `hypothesis file is not valid JSON: ${msg}` };
  }
  let arr: unknown;
  if (isPlainObject(parsed) && Array.isArray(parsed.hypotheses)) {
    arr = parsed.hypotheses;
  } else if (Array.isArray(parsed)) {
    arr = parsed;
  } else {
    return {
      ok: false,
      reason: "hypothesis file must contain { hypotheses: [...] } or a bare array",
    };
  }
  if (!Array.isArray(arr)) {
    return { ok: false, reason: "hypothesis file did not yield an array" };
  }
  // The summary helper accepts a broad union; we cast to the hygiene-aware
  // shape because `canFeedExperiment` reads optional hygiene fields. The
  // cast is structurally safe: any missing field is read as `undefined`
  // and the summary helper handles that.
  return { ok: true, hypotheses: arr as HygieneAwareHypothesis[] };
}

/** Envelope printed to stdout. Carries metadata + the Phase 2m-d summary. */
export interface ManualSafetyGatingValidationSummaryEnvelope {
  schemaVersion: typeof PHASE_2M_E_ENVELOPE_SCHEMA_VERSION;
  label:         typeof PHASE_2M_E_ENVELOPE_LABEL;
  /** Echoed CLI metadata. */
  runLabel:      string | null;
  operator:      string | null;
  source:        string;
  /** Echoed file path so an operator can confirm provenance. */
  inputFile:     string;
  /** Total number of hypothesis records read from the file. */
  hypothesisCount: number;
  /** The Phase 2m-d summary payload, including its own schemaVersion. */
  summary:       SafetyGatingValidationSummary;
}

/** Build the printed envelope from parsed options and a summary. Pure. */
export function buildEnvelope(
  options: ManualSafetyGatingValidationSummaryCliOptions,
  hypothesisCount: number,
  summary: SafetyGatingValidationSummary,
): ManualSafetyGatingValidationSummaryEnvelope {
  return {
    schemaVersion:  PHASE_2M_E_ENVELOPE_SCHEMA_VERSION,
    label:          PHASE_2M_E_ENVELOPE_LABEL,
    runLabel:       options.runLabel,
    operator:       options.operator,
    source:         options.source,
    inputFile:      options.filePath,
    hypothesisCount,
    summary,
  };
}

/** Serialise the envelope to JSON. Pretty = 2-space indent; otherwise the
 *  embedded summary is re-serialised compactly. */
export function serializeEnvelope(
  envelope: ManualSafetyGatingValidationSummaryEnvelope,
  pretty: boolean,
): string {
  return pretty
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
}

/** Compute the runner's exit code from the summary payload. See the
 *  module header for the full code table. Pure. */
export function exitCodeForSummary(s: SafetyGatingValidationSummary): 0 | 2 | 3 {
  if (!s.detected) return 3;
  if (!s.measurementPathAccessible) return 3;
  if (!s.hasManualValidation) return 3;
  if (s.latestManualValidationStatus === "blocked") return 3;
  if (s.latestManualValidationStatus === "violated") return 2;
  if (typeof s.violationCount === "number" && s.violationCount > 0) return 2;
  if (s.latestManualValidationStatus === "ok"
      && (s.violationCount === 0 || s.violationCount === null)) {
    return 0;
  }
  return 3;
}

/** I/O handles passed into `runManualSafetyGatingValidationSummaryCli` so
 *  tests can capture stdout/stderr without spawning a subprocess. */
export interface ManualSafetyGatingValidationSummaryCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** Result of one CLI invocation. The exit code is returned (not thrown)
 *  so a test can assert on it directly. */
export interface ManualSafetyGatingValidationSummaryCliResult {
  exitCode: number;
  /** The envelope printed (or null when help / usage error short-circuited
   *  before envelope construction). Exposed for test assertions. */
  envelope: ManualSafetyGatingValidationSummaryEnvelope | null;
}

/**
 * Run the manual safety-gating validation summary CLI. Pure aside from
 * the supplied stdout/stderr sinks and the read-only fs read of the
 * hypothesis file. No db / env / scheduler / wall-clock touch.
 */
export function runManualSafetyGatingValidationSummaryCli(
  argv: readonly string[],
  io:   ManualSafetyGatingValidationSummaryCliIo,
  deps: {
    cwd?: string;
    fs?:  Pick<typeof fs, "existsSync" | "readFileSync">;
  } = {},
): ManualSafetyGatingValidationSummaryCliResult {
  const cwd    = deps.cwd ?? process.cwd();
  const fsImpl = deps.fs  ?? fs;

  const parsed = parseManualSafetyGatingValidationSummaryCliArgs(argv, cwd);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, envelope: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, envelope: null };
  }

  const options = parsed.options;

  const loaded = loadHypothesesFile(options.filePath, fsImpl);
  if (!loaded.ok) {
    io.stderr(`${PROGRAM_NAME}: ${loaded.reason}\n`);
    return { exitCode: 1, envelope: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const summary = summarizeSafetyGatingValidation({
    hypotheses: loaded.hypotheses,
    now:        options.now,
  });

  // Sanity-pin the embedded schema id so a future refactor can't
  // accidentally swap helpers without bumping the envelope version.
  if (summary.schemaVersion !== SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION
   || summary.label         !== SAFETY_GATING_VALIDATION_SUMMARY_LABEL) {
    io.stderr(
      `${PROGRAM_NAME}: unexpected summary schema/label — refusing to print\n`,
    );
    return { exitCode: 1, envelope: null };
  }

  const envelope = buildEnvelope(options, loaded.hypotheses.length, summary);
  const serialized = serializeEnvelope(envelope, options.pretty);

  // The embedded summary already pretty-prints via
  // `serializeSafetyGatingValidationSummary`. We use the envelope's own
  // serializer for stable formatting, then reference the helper's
  // serializer for parity assertions in tests.
  void serializeSafetyGatingValidationSummary;

  // Pin a stable reference to the hypothesis id so tests can sanity-check
  // detection through the envelope without re-importing the constant.
  void SAFETY_GATING_HYPOTHESIS_ID;

  io.stdout(serialized + "\n");
  return { exitCode: exitCodeForSummary(summary), envelope };
}

/** Entry-point invoked when the module is run directly via `tsx`. Tests
 *  import the named helpers above and do NOT exercise this branch. */
function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  const moduleUrl = import.meta.url;
  try {
    const argvUrl = new URL(`file://${argv1}`).href;
    return moduleUrl === argvUrl;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = runManualSafetyGatingValidationSummaryCli(
    process.argv.slice(2),
    {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    },
  );
  process.exit(result.exitCode);
}
