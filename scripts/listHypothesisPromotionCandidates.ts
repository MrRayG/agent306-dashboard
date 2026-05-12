/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-e: MANUAL HYPOTHESIS PROMOTION CANDIDATES CLI (READ-ONLY)
 *
 * Phase 2l-e ships `buildHypothesisPromotionCandidates`: a pure,
 * deterministic, propose-only helper that turns a `MemoryKnowledgeFile`
 * shape into a structured candidate set for an operator to consider.
 *
 * This script is the narrowest possible operator entry point: a manual
 * CLI that loads `data/memory_knowledge.json` (or a path supplied via
 * `--memory-file`), runs the helper, and prints exactly one structured
 * JSON payload to stdout. It is the propose-only / stdout-only sibling
 * of the Phase 2l-d manual learning-loop report runner.
 *
 * Phase 2l-e is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot
 *     wiring, no UI control, no API endpoint, no monitor side effect.
 *     The only way this code runs is when an operator (or a test)
 *     invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its candidate payload to stdout
 *     and the safety banner to stderr. It opens no file for writing,
 *     appends to no JSONL, touches no database, sets no env var,
 *     signals no scheduler, and mutates no in-memory map. The ONLY
 *     filesystem touch is a single read of the input memory file —
 *     never a write.
 *   - READ-ONLY / PROPOSE-ONLY: every artefact in the printed payload
 *     restates the propose-only contract. This runner cannot widen
 *     those contracts, cannot promote a memory entry, cannot register
 *     a sandbox kind, cannot mark anything auto-apply eligible.
 *   - REUSE-FIRST: the runner imports `buildHypothesisPromotionCandidates`
 *     and `serializePromotionCandidatesSet` from the Phase 2l-e helper
 *     and shapes the output. It does NOT re-derive the ranking, the
 *     ineligibility codes, or the readiness gaps.
 *   - DETERMINISTIC ON FIXED INPUTS: with an identical `--memory-file`,
 *     `--limit`, `--now`, and `--generated-by`, the runner prints
 *     byte-identical output every time. There is no `Date.now`, no
 *     `Math.random`, no UUID, no env read, no wall-clock read.
 *   - NON-WIDENING: the runner cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record. `summarizationTemplate`
 *     remains the only enabled low-risk sandbox kind.
 *
 * Usage:
 *   npx tsx scripts/listHypothesisPromotionCandidates.ts
 *   npx tsx scripts/listHypothesisPromotionCandidates.ts --pretty
 *   npx tsx scripts/listHypothesisPromotionCandidates.ts --limit 3
 *   npx tsx scripts/listHypothesisPromotionCandidates.ts --memory-file data/memory_knowledge.json
 *   npx tsx scripts/listHypothesisPromotionCandidates.ts --now 2026-05-11T17:00:00.000Z
 *   npx tsx scripts/listHypothesisPromotionCandidates.ts --generated-by op@phase2l-e
 *
 * Flags:
 *   --json                  Print the candidate set as compact JSON (default).
 *   --pretty                Print the candidate set as 2-space-indented JSON.
 *   --limit <n>             Cap the number of candidates emitted. Pass 0 for
 *                           "no candidates" (still emits the structured set).
 *                           Defaults to 3. Use `--no-limit` to disable the cap.
 *   --no-limit              Disable the candidate limit entirely.
 *   --memory-file <path>    Path to a memory_knowledge.json-shaped file.
 *                           Defaults to `data/memory_knowledge.json` relative
 *                           to the current working directory.
 *   --now <iso>             Pin the candidate set's `generatedAt` (ISO-8601).
 *                           When omitted no wall-clock read happens; the
 *                           candidate set records `generatedAt: null`.
 *   --generated-by <text>   Echo a free-text operator identifier into the
 *                           candidate set's `generatedBy` field.
 *                           Informational only — confers no authority.
 *   -h, --help              Print this usage and exit 0.
 *
 * Exit codes:
 *   0  the runner printed exactly one candidate-set payload
 *   1  CLI usage error (unknown flag, malformed --now/--limit, missing file)
 *
 * What this script does NOT do:
 *   - Promote a memory entry into research_lab.json or anywhere else.
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Write to any file, database, ledger, env var, or monitor state.
 *   - Apply, register, or otherwise act on any candidate.
 *   - Produce any public action or any output beyond the printed payload.
 *   - Mutate the input file it loaded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  buildHypothesisPromotionCandidates,
  serializePromotionCandidatesSet,
  DEFAULT_CANDIDATE_LIMIT,
  type PromotionCandidatesSet,
  type MemoryKnowledgeFile,
} from "../server/experiments/hypothesisPromotionCandidates.js";

/** Parsed CLI options. Each field maps 1:1 onto a helper input. */
export interface PromotionCandidatesCliOptions {
  /** True when `--pretty` is supplied; otherwise compact JSON. */
  pretty:       boolean;
  /** Limit cap. `null` means `--no-limit`. */
  limit:        number | null;
  /** Path to the memory_knowledge.json-shaped file to load. */
  memoryFile:   string;
  /** Pinned ISO timestamp from `--now`, or `null` when omitted. */
  now:          string | null;
  /** Caller-supplied `--generated-by`, or `"manual:cli"` when omitted. */
  generatedBy:  string;
}

/** Default value for `--generated-by` when the flag is omitted. */
export const DEFAULT_GENERATED_BY = "manual:cli";

/** Default value for `--memory-file` (relative to cwd). */
export const DEFAULT_MEMORY_FILE_RELATIVE = "data/memory_knowledge.json";

/** Default value injected into stderr error messages so a typo is obvious. */
const PROGRAM_NAME = "listHypothesisPromotionCandidates";

/** Static usage string. Returned verbatim by `USAGE_TEXT` so tests can
 *  pin the exact text without string-fuzz. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/listHypothesisPromotionCandidates.ts [flags]",
  "",
  "Phase 2l-e manual hypothesis promotion candidates runner.",
  "Prints exactly one deterministic, read-only, propose-only candidate-set",
  "payload to stdout. The runner does NOT write to any file, database,",
  "ledger, env var, monitor, or scheduler. Listing an entry as a candidate",
  "confers NO promotion authority — promotion remains a manual operator step.",
  "",
  "Flags:",
  "  --json                  Print the candidate set as compact JSON (default).",
  "  --pretty                Print the candidate set as 2-space-indented JSON.",
  `  --limit <n>             Cap candidate count. Default: ${DEFAULT_CANDIDATE_LIMIT}. Use --no-limit to disable.`,
  "  --no-limit              Disable the candidate limit.",
  `  --memory-file <path>    Memory knowledge file path. Default: ${DEFAULT_MEMORY_FILE_RELATIVE}.`,
  "  --now <iso>             Pin generatedAt (ISO-8601). Omitted → null.",
  `  --generated-by <text>   Operator / script identifier. Default: "${DEFAULT_GENERATED_BY}".`,
  "  -h, --help              Print this usage and exit 0.",
].join("\n");

/** Safety-invariants banner printed to stderr ahead of the candidate set.
 *  Kept separate from the JSON payload so the payload stays a single
 *  parseable JSON document on stdout. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase2l-e] manual hypothesis promotion candidates runner",
  "[phase2l-e] read-only, manual-only, stdout-only",
  "[phase2l-e] no scheduler, no auto-apply, no promotion, no public action",
  "[phase2l-e] no file / database / ledger / env / monitor writes",
  "[phase2l-e] candidates are suggestions; operator promotion remains manual",
  "[phase2l-e] embedded artefacts retain propose-only / suggestion-only contracts",
].join("\n");

/** Discriminated result of `parsePromotionCandidatesCliArgs`. */
export type ParseResult =
  | { ok: true;  options: PromotionCandidatesCliOptions }
  | { ok: false; reason: string }
  | { ok: true;  helpRequested: true };

function looksLikeIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/**
 * Parse a `process.argv.slice(2)` array into structured CLI options. Pure:
 * no I/O, no env read, no wall-clock read. Returns `{ ok: false, reason }`
 * for any usage error so callers can format the error themselves.
 */
export function parsePromotionCandidatesCliArgs(argv: readonly string[]): ParseResult {
  let pretty = false;
  let json   = false;
  let limit: number | null | undefined = undefined;
  let memoryFile: string | null = null;
  let now: string | null = null;
  let generatedBy: string | null = null;

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
      case "--no-limit":
        limit = null;
        break;
      case "--limit": {
        const v = argv[++i];
        if (typeof v !== "string" || v.length === 0) {
          return { ok: false, reason: "--limit requires a non-negative integer" };
        }
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          return { ok: false, reason: `--limit value must be a non-negative integer: ${v}` };
        }
        limit = n;
        break;
      }
      case "--memory-file": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--memory-file requires a non-empty path" };
        }
        memoryFile = v;
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
      case "--generated-by": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--generated-by requires a non-empty value" };
        }
        generatedBy = v;
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
      limit: limit === undefined ? DEFAULT_CANDIDATE_LIMIT : limit,
      memoryFile: memoryFile ?? DEFAULT_MEMORY_FILE_RELATIVE,
      now,
      generatedBy: generatedBy ?? DEFAULT_GENERATED_BY,
    },
  };
}

/** I/O handles passed into `runPromotionCandidatesCli` so tests can capture
 *  stdout/stderr and inject a fake file loader without spawning a subprocess
 *  or touching the real filesystem. */
export interface PromotionCandidatesCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  /** Reads the memory file. Tests inject an in-memory loader to keep the
   *  CLI hermetic. The real entrypoint binds this to `readFileSync`. */
  readMemoryFile: (filePath: string) => string;
}

/** Result of one CLI invocation. */
export interface PromotionCandidatesCliResult {
  exitCode: number;
  /** The shaped candidate set (or `null` when help / usage error
   *  short-circuited before generation). Exposed for test assertions. */
  set: PromotionCandidatesSet | null;
}

function parseMemoryFile(raw: string): MemoryKnowledgeFile {
  const data = JSON.parse(raw);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("memory file is not a JSON object");
  }
  return data as MemoryKnowledgeFile;
}

/**
 * Run the manual promotion-candidates CLI. Pure aside from the supplied
 * stdout/stderr sinks + the injected `readMemoryFile`: no fs writes, no
 * db, no env mutation, no scheduler signal, no wall-clock read.
 */
export function runPromotionCandidatesCli(
  argv: readonly string[],
  io:   PromotionCandidatesCliIo,
): PromotionCandidatesCliResult {
  const parsed = parsePromotionCandidatesCliArgs(argv);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, set: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, set: null };
  }

  const opts = parsed.options;

  let raw: string;
  try {
    raw = io.readMemoryFile(opts.memoryFile);
  } catch (err) {
    io.stderr(`${PROGRAM_NAME}: failed to read --memory-file ${opts.memoryFile}: ${(err as Error).message}\n`);
    return { exitCode: 1, set: null };
  }

  let file: MemoryKnowledgeFile;
  try {
    file = parseMemoryFile(raw);
  } catch (err) {
    io.stderr(`${PROGRAM_NAME}: failed to parse --memory-file ${opts.memoryFile}: ${(err as Error).message}\n`);
    return { exitCode: 1, set: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const set = buildHypothesisPromotionCandidates({
    file,
    limit: opts.limit,
    now: opts.now,
    generatedBy: opts.generatedBy,
  });

  const serialized = serializePromotionCandidatesSet(
    set,
    opts.pretty ? { indent: 2 } : {},
  );
  io.stdout(serialized + "\n");
  return { exitCode: 0, set };
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
  const result = runPromotionCandidatesCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    readMemoryFile: (p) => readFileSync(path.resolve(p), "utf8"),
  });
  process.exit(result.exitCode);
}
