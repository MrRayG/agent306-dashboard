/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2m-b: PROMOTION BOUNDARY AUDIT CLI (READ-ONLY / STDOUT-ONLY)
 *
 * Manual operator entry point for `auditPromotionBoundary` (phase 2m-b
 * measurement layer for hypothesis
 * `hyp_agent306_safety_gating_single_write_boundary`, metric
 * `promotion_boundary_violation_count`).
 *
 * Phase 2m-b CLI is intentionally:
 *
 *   - MANUAL-ONLY: there is no scheduler hook, no cron, no app-boot
 *     wiring, no UI control, no API endpoint, no monitor side effect.
 *     The only way this code runs is when an operator (or a test)
 *     invokes it explicitly.
 *   - STDOUT-ONLY: the runner writes its audit payload to stdout. It
 *     opens no file for writing, appends to no JSONL, touches no
 *     database, sets no env var, signals no scheduler, mutates no
 *     in-memory map, and produces no file artefacts. Stderr carries
 *     only the safety-invariants banner.
 *   - READ-ONLY / PROPOSE-ONLY: the audit cannot widen any contract.
 *     `violationCount=0` is evidence, not authorisation. The CLI's
 *     non-zero exit code on `violated` / `blocked` is a signal for
 *     operators / CI; it does not trigger any action.
 *   - REUSE-FIRST: the CLI imports `auditPromotionBoundary` and
 *     `serializePromotionBoundaryAudit` and shapes the output. It
 *     does NOT re-implement any check logic.
 *   - DETERMINISTIC ON FIXED INPUTS: with identical `--repo-root`,
 *     `--now`, `--run-label`, `--operator`, `--source`, and identical
 *     repo source contents, the runner prints byte-identical output
 *     every time. There is no Date.now, no Math.random, no UUID, no
 *     env read for behaviour purposes, no wall-clock read.
 *
 * Usage:
 *   npx tsx scripts/auditPromotionBoundary.ts
 *   npx tsx scripts/auditPromotionBoundary.ts --pretty
 *   npx tsx scripts/auditPromotionBoundary.ts --now 2026-05-12T17:00:00.000Z
 *   npx tsx scripts/auditPromotionBoundary.ts --run-label phase2m-b-daily-2026-05-12
 *   npx tsx scripts/auditPromotionBoundary.ts --operator op@phase2m-b
 *   npx tsx scripts/auditPromotionBoundary.ts --source manual:repl
 *
 * Flags:
 *   --json               Print the audit as compact JSON (default).
 *   --pretty             Print the audit as 2-space-indented JSON.
 *   --repo-root <path>   Absolute path to the repository root.
 *                        Defaults to the resolved path of this script's
 *                        parent directory. Required only when running
 *                        from outside the repo checkout.
 *   --now <iso>          Pin the audit's `generatedAt` timestamp.
 *                        When omitted no wall-clock read happens.
 *   --run-label <text>   Echo a free-text run label.
 *   --operator <text>    Echo a free-text operator identifier.
 *                        Informational only — confers no authority.
 *   --source <text>      Override the source field. Default: "manual:cli".
 *   -h, --help           Print this usage and exit 0.
 *
 * Exit codes:
 *   0  audit ran AND violationCount === 0 (status === "ok")
 *   2  audit ran AND violationCount  >  0 (status === "violated")
 *   3  audit could not run — at least one prerequisite blocker
 *   1  CLI usage error (unknown flag, malformed --now, etc.)
 *
 * What this script does NOT do:
 *   - Run a scheduler / cron / daily cycle hook.
 *   - Touch any database, ledger, env var, or monitor state.
 *   - Apply, promote, register, or otherwise act on any recommendation.
 *   - Produce any public action or any output beyond the printed payload
 *     on stdout and the safety-invariants banner on stderr.
 *   - Read the wall clock for behaviour — every payload timestamp comes
 *     from `--now` (or is null when omitted).
 *   - Approve a hypothesis. A `violationCount=0` audit is evidence; the
 *     formal hypothesis remains operator-gated until the existing
 *     hypothesis hygiene process advances it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as path from "node:path";

import {
  auditPromotionBoundary,
  serializePromotionBoundaryAudit,
  type PromotionBoundaryAuditInputs,
  type PromotionBoundaryAuditResult,
} from "../server/eval/promotionBoundaryAudit.js";

/** Parsed CLI options. */
export interface AuditPromotionBoundaryCliOptions {
  pretty:   boolean;
  repoRoot: string;
  now:      string | null;
  runLabel: string | null;
  operator: string | null;
  source:   string;
}

/** Default value for the `source` metadata field when `--source` is omitted. */
export const DEFAULT_CLI_SOURCE = "manual:cli";

/** Program name used in stderr error messages. */
const PROGRAM_NAME = "auditPromotionBoundary";

/** Static usage string. Returned verbatim by tests for byte-level pinning. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/auditPromotionBoundary.ts [flags]",
  "",
  "Phase 2m-b promotion-boundary audit runner.",
  "Prints exactly one deterministic, read-only audit payload to stdout.",
  "The runner does NOT write to any file, database, ledger, env var,",
  "monitor, or scheduler. A violationCount=0 result is evidence the",
  "single-write-site invariant currently holds — it is NOT authorisation",
  "to widen the propose-only contract or promote a hypothesis.",
  "",
  "Flags:",
  "  --json               Print the audit as compact JSON (default).",
  "  --pretty             Print the audit as 2-space-indented JSON.",
  "  --repo-root <path>   Absolute path to the repository root.",
  "                       Defaults to the resolved repo root for this script.",
  "  --now <iso>          Pin the audit's generatedAt timestamp (ISO-8601).",
  "                       When omitted no wall-clock read happens — generatedAt",
  "                       is null.",
  "  --run-label <text>   Echo a free-text run label.",
  "  --operator <text>    Echo a free-text operator identifier.",
  "                       Informational only — confers no authority.",
  `  --source <text>      Override the source field. Default: "${DEFAULT_CLI_SOURCE}".`,
  "  -h, --help           Print this usage and exit 0.",
  "",
  "Exit codes:",
  "  0  audit ran AND violationCount === 0 (status === \"ok\")",
  "  2  audit ran AND violationCount  >  0 (status === \"violated\")",
  "  3  audit could not run — at least one prerequisite blocker",
  "  1  CLI usage error (unknown flag, malformed --now, etc.)",
].join("\n");

/** Safety-invariants banner. Printed to stderr so the stdout payload
 *  remains a single parseable JSON document. */
export const SAFETY_INVARIANTS_BANNER = [
  "[phase2m-b] promotion boundary audit",
  "[phase2m-b] read-only, manual-only, stdout-only",
  "[phase2m-b] no scheduler, no auto-apply, no promotion, no public action",
  "[phase2m-b] no file / database / ledger / env / monitor writes",
  "[phase2m-b] violationCount=0 is evidence the invariant currently holds, not authorisation to widen it",
].join("\n");

/** Discriminated parse result so callers can pin success and error paths. */
export type ParseResult =
  | { ok: true; options: AuditPromotionBoundaryCliOptions }
  | { ok: true; helpRequested: true }
  | { ok: false; reason: string };

function looksLikeIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  return true;
}

/** Resolve the repo root relative to this script's location. */
export function resolveDefaultRepoRoot(): string {
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "..");
}

/**
 * Parse `process.argv.slice(2)` into structured CLI options. Pure: no I/O,
 * no env read, no wall-clock read.
 */
export function parseAuditPromotionBoundaryCliArgs(
  argv: readonly string[],
  defaults?: { repoRoot?: string },
): ParseResult {
  let pretty   = false;
  let json     = false;
  let repoRoot: string | null = null;
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
      case "--repo-root": {
        const v = argv[++i];
        if (typeof v !== "string" || v.trim().length === 0) {
          return { ok: false, reason: "--repo-root requires a non-empty path" };
        }
        repoRoot = v;
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
      repoRoot: repoRoot ?? defaults?.repoRoot ?? resolveDefaultRepoRoot(),
      now,
      runLabel,
      operator,
      source: source ?? DEFAULT_CLI_SOURCE,
    },
  };
}

/** Project parsed CLI options into the audit helper's input shape. */
export function toAuditInputs(
  options: AuditPromotionBoundaryCliOptions,
): PromotionBoundaryAuditInputs {
  return {
    repoRoot: options.repoRoot,
    now:      options.now,
    runLabel: options.runLabel,
    operator: options.operator,
    source:   options.source,
  };
}

/** I/O handles. */
export interface AuditPromotionBoundaryCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/** One CLI invocation result. */
export interface AuditPromotionBoundaryCliResult {
  exitCode: number;
  /** The audit payload, or null when help / usage error short-circuited. */
  audit:    PromotionBoundaryAuditResult | null;
}

/**
 * Run the audit CLI. Pure aside from the supplied stdout/stderr sinks and
 * the `auditPromotionBoundary` helper's source-file reads.
 */
export function runAuditPromotionBoundaryCli(
  argv: readonly string[],
  io:   AuditPromotionBoundaryCliIo,
  defaults?: { repoRoot?: string },
): AuditPromotionBoundaryCliResult {
  const parsed = parseAuditPromotionBoundaryCliArgs(argv, defaults);

  if ("helpRequested" in parsed && parsed.helpRequested === true) {
    io.stdout(USAGE_TEXT + "\n");
    return { exitCode: 0, audit: null };
  }

  if (parsed.ok === false) {
    io.stderr(`${PROGRAM_NAME}: ${parsed.reason}\n`);
    io.stderr(USAGE_TEXT + "\n");
    return { exitCode: 1, audit: null };
  }

  io.stderr(SAFETY_INVARIANTS_BANNER + "\n");

  const audit = auditPromotionBoundary(toAuditInputs(parsed.options));
  const serialized = serializePromotionBoundaryAudit(
    audit,
    parsed.options.pretty ? { indent: 2 } : {},
  );
  io.stdout(serialized + "\n");

  let exitCode: number;
  switch (audit.status) {
    case "ok":       exitCode = 0; break;
    case "violated": exitCode = 2; break;
    case "blocked":  exitCode = 3; break;
    default:         exitCode = 1; break;
  }

  return { exitCode, audit };
}

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
  const result = runAuditPromotionBoundaryCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
