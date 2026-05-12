/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2l-f: MANUAL SELF-EVOLUTION HYPOTHESIS CANDIDATES CLI
 *
 * Phase 2l-f ships `buildSelfEvolutionHypothesisCandidates`: a pure,
 * deterministic, propose-only helper that synthesises operator-curated
 * self-evolution hypothesis candidates from QualityGrammar v2.6
 * observational failures, learning-loop signals, and Phase 3 readiness
 * signals. Each candidate is mission-aligned (reversibility, sigma /
 * variance, saturation/void balance, meta-reflection usefulness,
 * learning-loop compounding, safety gating, sandbox readiness,
 * rollback proof) and never `ready_for_experiment` automatically.
 *
 * This script is the narrowest possible operator entry point: a manual
 * CLI that accepts QG failure codes / signal ids via repeated flags
 * (or falls back to a compact default sample) and prints exactly one
 * structured JSON payload to stdout. It is the propose-only / stdout-
 * only sibling of the Phase 2l-e promotion candidate runner.
 *
 * Phase 2l-f is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot
 *     wiring, no UI control, no API endpoint, no monitor side effect.
 *     The only way this code runs is when an operator (or a test)
 *     invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its candidate payload to stdout
 *     and the safety banner to stderr. It opens no file for writing,
 *     appends to no JSONL, touches no database, sets no env var,
 *     signals no scheduler, and mutates no in-memory map. The runner
 *     does NOT read any file from disk — every input is a flag.
 *   - READ-ONLY / PROPOSE-ONLY: every artefact in the printed payload
 *     restates the propose-only contract. This runner cannot widen
 *     those contracts, cannot promote anything, cannot register a
 *     sandbox kind, cannot mark anything auto-apply eligible, cannot
 *     emit `ready_for_experiment`.
 *   - REUSE-FIRST: the runner imports `buildSelfEvolutionHypothesisCandidates`
 *     and `serializeSelfEvolutionCandidateSet` from the helper and
 *     shapes the output. It does NOT re-derive any candidate logic.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical flags, the runner
 *     prints byte-identical output every time. There is no `Date.now`,
 *     no `Math.random`, no UUID, no env read, no wall-clock read.
 *   - NON-WIDENING: the runner cannot enable a sandbox kind, cannot
 *     register a kind, cannot promote a record. `summarizationTemplate`
 *     remains the only enabled sandbox kind.
 *
 * Usage:
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts --pretty
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts --limit 3
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts \
 *       --qg-failure reversibility_below_threshold \
 *       --qg-failure sigma_above_max
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts \
 *       --ll-signal ll.lessons.count \
 *       --phase3-signal phase3.readiness.score
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts --now 2026-05-12T17:00:00.000Z
 *   npx tsx scripts/generateSelfEvolutionHypothesisCandidates.ts --generated-by op@phase2l-f
 *
 * Flags:
 *   --json                       Print the candidate set as compact JSON (default).
 *   --pretty                     Print the candidate set as 2-space-indented JSON.
 *   --limit <n>                  Cap candidate count. Default 5. Use --no-limit to disable.
 *   --no-limit                   Disable the candidate limit entirely.
 *   --qg-failure <code>          Add a QualityGrammar failure code. May be repeated.
 *                                Allowed codes: reversibility_below_threshold,
 *                                sigma_above_max, saturation_void_balance,
 *                                valence_below_uncertainty_threshold, stress_below_min.
 *   --ll-signal <id>             Add a learning-loop signal id. May be repeated.
 *   --phase3-signal <id>         Add a Phase 3 readiness signal id. May be repeated.
 *   --now <iso>                  Pin the candidate set's generatedAt. Omitted → null.
 *   --generated-by <text>        Operator / script identifier. Default: "manual:cli".
 *   -h, --help                   Print this usage and exit 0.
 *
 * Exit codes:
 *   0  the runner printed exactly one candidate-set payload
 *   1  CLI usage error (unknown flag, malformed --now/--limit, invalid code)
 *
 * What this script does NOT do:
 *   - Promote anything into research_lab.json or anywhere else.
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Write to any file, database, ledger, env var, or monitor state.
 *   - Apply, register, or otherwise act on any candidate.
 *   - Read any file from disk — every input is a flag or a default.
 *   - Produce any public action or any output beyond the printed payload.
 *   - Emit `ready_for_experiment: true` on any candidate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  buildSelfEvolutionHypothesisCandidates,
  serializeSelfEvolutionCandidateSet,
  DEFAULT_SELF_EVOLUTION_LIMIT,
  type SelfEvolutionCandidateSet,
  type QualityGrammarFailureCode,
  type QualityGrammarFailureSignal,
  type LearningLoopSignal,
  type Phase3ReadinessSignal,
} from "../server/experiments/selfEvolutionHypothesisCandidates.js";

/** Allowed QualityGrammar failure codes — copied verbatim from the helper
 *  so the CLI can validate flag values without importing the runtime
 *  reasoning-quality harness. */
const ALLOWED_QG_CODES: readonly QualityGrammarFailureCode[] = [
  "reversibility_below_threshold",
  "sigma_above_max",
  "saturation_void_balance",
  "valence_below_uncertainty_threshold",
  "stress_below_min",
];

/** Parsed CLI options. */
export interface SelfEvolutionCliOptions {
  pretty:      boolean;
  limit:       number | null;
  qgFailures:  readonly QualityGrammarFailureCode[];
  llSignals:   readonly string[];
  p3Signals:   readonly string[];
  now:         string | null;
  generatedBy: string;
}

/** Default value for `--generated-by` when the flag is omitted. */
export const DEFAULT_GENERATED_BY = "manual:cli";

const PROGRAM_NAME = "generateSelfEvolutionHypothesisCandidates";

/** Static usage string. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/generateSelfEvolutionHypothesisCandidates.ts [flags]",
  "",
  "Phase 2l-f manual self-evolution hypothesis candidate runner.",
  "Prints exactly one deterministic, read-only, propose-only candidate-set",
  "payload to stdout. The runner does NOT write to any file, database,",
  "ledger, env var, monitor, or scheduler. Listing a candidate confers",
  "NO promotion authority and NO ready_for_experiment status — promotion",
  "remains a manual operator step.",
  "",
  "Flags:",
  "  --json                       Print the candidate set as compact JSON (default).",
  "  --pretty                     Print the candidate set as 2-space-indented JSON.",
  `  --limit <n>                  Cap candidate count. Default: ${DEFAULT_SELF_EVOLUTION_LIMIT}. Use --no-limit to disable.`,
  "  --no-limit                   Disable the candidate limit.",
  "  --qg-failure <code>          Add a QualityGrammar failure code. Repeatable.",
  `                               Allowed: ${ALLOWED_QG_CODES.join(", ")}.`,
  "  --ll-signal <id>             Add a learning-loop signal id. Repeatable.",
  "  --phase3-signal <id>         Add a Phase 3 readiness signal id. Repeatable.",
  "  --now <iso>                  Pin generatedAt (ISO-8601). Omitted → null.",
  `  --generated-by <text>        Operator / script identifier. Default: "${DEFAULT_GENERATED_BY}".`,
  "  -h, --help                   Print this usage and exit 0.",
].join("\n");

/** Safety-invariants banner printed to stderr ahead of the candidate set. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase2l-f] manual self-evolution hypothesis candidates runner",
  "[phase2l-f] read-only, manual-only, stdout-only, operator-synthesized",
  "[phase2l-f] no scheduler, no auto-apply, no promotion, no public action",
  "[phase2l-f] no file / database / ledger / env / monitor writes",
  "[phase2l-f] candidates start at hygiene tag 'candidate', never 'ready_for_experiment'",
  "[phase2l-f] summarizationTemplate remains the only enabled sandbox kind",
].join("\n");

/** Discriminated parse result. */
export type ParseResult =
  | { ok: true;  options: SelfEvolutionCliOptions }
  | { ok: false; reason: string }
  | { ok: true;  helpRequested: true };

function looksLikeIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function isAllowedQgCode(v: string): v is QualityGrammarFailureCode {
  return (ALLOWED_QG_CODES as readonly string[]).includes(v);
}

/**
 * Parse a `process.argv.slice(2)` array into structured CLI options. Pure:
 * no I/O, no env read, no wall-clock read.
 */
export function parseSelfEvolutionCliArgs(argv: readonly string[]): ParseResult {
  let pretty = false;
  let json   = false;
  let limit: number | null | undefined = undefined;
  const qgFailures: QualityGrammarFailureCode[] = [];
  const llSignals:  string[] = [];
  const p3Signals:  string[] = [];
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
      case "--qg-failure": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--qg-failure requires a non-empty failure code" };
        }
        if (!isAllowedQgCode(v)) {
          return { ok: false, reason: `--qg-failure value is not an allowed code: ${v}` };
        }
        qgFailures.push(v);
        break;
      }
      case "--ll-signal": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--ll-signal requires a non-empty id" };
        }
        llSignals.push(v);
        break;
      }
      case "--phase3-signal": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--phase3-signal requires a non-empty id" };
        }
        p3Signals.push(v);
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
      limit: limit === undefined ? DEFAULT_SELF_EVOLUTION_LIMIT : limit,
      qgFailures,
      llSignals,
      p3Signals,
      now,
      generatedBy: generatedBy ?? DEFAULT_GENERATED_BY,
    },
  };
}

/** I/O handles passed into `runSelfEvolutionCli` so tests can capture
 *  stdout/stderr without spawning a subprocess. */
export interface SelfEvolutionCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** Result of one CLI invocation. */
export interface SelfEvolutionCliResult {
  exitCode: number;
  set:      SelfEvolutionCandidateSet | null;
}

/**
 * Run the manual self-evolution-candidates CLI. Pure aside from the supplied
 * stdout/stderr sinks: no fs reads or writes, no db, no env mutation, no
 * scheduler signal, no wall-clock read.
 */
export function runSelfEvolutionCli(
  argv: readonly string[],
  io:   SelfEvolutionCliIo,
): SelfEvolutionCliResult {
  const parsed = parseSelfEvolutionCliArgs(argv);

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

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const qgFailures: QualityGrammarFailureSignal[] | undefined =
    opts.qgFailures.length === 0
      ? undefined
      : opts.qgFailures.map(code => ({ code }));
  const llSignals: LearningLoopSignal[] | undefined =
    opts.llSignals.length === 0
      ? undefined
      : opts.llSignals.map(id => ({ id }));
  const p3Signals: Phase3ReadinessSignal[] | undefined =
    opts.p3Signals.length === 0
      ? undefined
      : opts.p3Signals.map(id => ({ id }));

  const set = buildSelfEvolutionHypothesisCandidates({
    qualityGrammarFailures: qgFailures,
    learningLoopSignals:    llSignals,
    phase3ReadinessSignals: p3Signals,
    limit:                  opts.limit,
    now:                    opts.now,
    generatedBy:            opts.generatedBy,
  });

  const serialized = serializeSelfEvolutionCandidateSet(
    set,
    opts.pretty ? { indent: 2 } : {},
  );
  io.stdout(serialized + "\n");
  return { exitCode: 0, set };
}

/** Entry-point invoked when the module is run directly via `tsx`. */
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
  const result = runSelfEvolutionCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
