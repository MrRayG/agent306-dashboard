/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SKILL CARD VALIDATOR CLI (MANUAL-ONLY / READ-ONLY / STDOUT-ONLY)
 *
 * Manual operator entry point for the skill governance registry. Mirrors
 * the style of `scripts/auditPromotionBoundary.ts`:
 *
 *   - MANUAL-ONLY: no scheduler hook, no cron, no app-boot wiring, no
 *     UI control, no API endpoint, no monitor side effect. Operators
 *     invoke it explicitly (`npm run skills:validate`).
 *   - STDOUT-ONLY: prints exactly one JSON document on stdout. Opens
 *     no file for writing, appends to no JSONL, touches no database,
 *     sets no env var, and signals no scheduler.
 *   - READ-ONLY / PROPOSE-ONLY: the validator is a CI signal. A green
 *     exit does NOT promote any hypothesis, register any skill, or
 *     widen the propose-only contract.
 *   - DETERMINISTIC: with identical --repo-root, --now, and identical
 *     on-disk source, output is byte-identical. No Date.now, no
 *     Math.random, no env read for behaviour purposes, no wall-clock
 *     read.
 *
 * Usage:
 *   npx tsx scripts/validateSkillCards.ts
 *   npx tsx scripts/validateSkillCards.ts --pretty
 *   npx tsx scripts/validateSkillCards.ts --repo-root /abs/path/to/repo
 *   npx tsx scripts/validateSkillCards.ts --now 2026-05-22T00:00:00.000Z
 *
 * Flags:
 *   --json               Print the report as compact JSON (default).
 *   --pretty             Print the report as 2-space-indented JSON.
 *   --repo-root <path>   Absolute path to the repository root. Defaults
 *                        to the resolved repo root for this script.
 *   --now <iso>          Pin the report's generatedAt timestamp. When
 *                        omitted, generatedAt is null.
 *   -h, --help           Print this usage and exit 0.
 *
 * Exit codes:
 *   0  validation passed (no findings)
 *   1  CLI usage error (unknown flag, malformed --now, etc.)
 *   2  validation failed (one or more findings)
 *   3  read/parse blocked (could not read registry or a card file)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  validateSkillRegistry,
  type Filesystem,
  type ValidationFinding,
  type ValidationResult,
} from "../server/skillGovernance/skillCardValidator.js";

/** Parsed CLI options. */
export interface ValidateSkillCardsCliOptions {
  pretty:   boolean;
  repoRoot: string;
  now:      string | null;
}

const PROGRAM_NAME = "validateSkillCards";

/** Static usage string. */
export const USAGE_TEXT = [
  "Usage: tsx scripts/validateSkillCards.ts [flags]",
  "",
  "Validate the Agent 306 skill governance registry and skill cards.",
  "Prints exactly one deterministic, read-only validation report to stdout.",
  "The validator does NOT write to any file, database, ledger, env var,",
  "monitor, or scheduler. A green report is a CI signal — it does NOT widen",
  "the propose-only contract or grant any new authority.",
  "",
  "Flags:",
  "  --json               Print the report as compact JSON (default).",
  "  --pretty             Print the report as 2-space-indented JSON.",
  "  --repo-root <path>   Absolute path to the repository root.",
  "                       Defaults to the resolved repo root for this script.",
  "  --now <iso>          Pin the report's generatedAt timestamp (ISO-8601).",
  "                       When omitted, generatedAt is null.",
  "  -h, --help           Print this usage and exit 0.",
  "",
  "Exit codes:",
  "  0  validation passed (no findings)",
  "  1  CLI usage error",
  "  2  validation failed (one or more findings)",
  "  3  read/parse blocked",
].join("\n");

/** Safety-invariants banner. */
export const SAFETY_INVARIANTS_BANNER = [
  "[skills:validate] read-only, manual-only, stdout-only",
  "[skills:validate] no scheduler, no auto-apply, no promotion, no public action",
  "[skills:validate] no file / database / ledger / env / monitor writes",
  "[skills:validate] a green report is evidence the registry is well-formed, not authorisation to widen any contract",
].join("\n");

export type ParseResult =
  | { ok: true; options: ValidateSkillCardsCliOptions }
  | { ok: true; helpRequested: true }
  | { ok: false; reason: string };

function looksLikeIsoTimestamp(value: string): boolean {
  if (value.length < 10) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/** Resolve the repo root relative to this script's location. */
export function resolveDefaultRepoRoot(): string {
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "..");
}

/** Parse argv into structured CLI options. Pure: no I/O. */
export function parseValidateSkillCardsCliArgs(
  argv: readonly string[],
  defaults?: { repoRoot?: string },
): ParseResult {
  let pretty = false;
  let json = false;
  let repoRoot: string | null = null;
  let now: string | null = null;

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
    },
  };
}

/** Real-filesystem implementation of the validator's `Filesystem` port. */
function makeRealFilesystem(): Filesystem {
  return {
    exists: (abs: string) => fs.existsSync(abs),
    readText: (abs: string) => fs.readFileSync(abs, "utf8"),
  };
}

export interface ValidateSkillCardsReport {
  schemaVersion: 1;
  label: "skills:validate";
  generatedAt: string | null;
  repoRoot: string;
  status: "ok" | "invalid" | "blocked";
  findingCount: number;
  findings: ValidationFinding[];
  registrySummary: {
    version: number | null;
    skillIds: string[];
  };
  safetyDisclaimer: string;
}

/** Categorize findings into status & exit code. */
function classify(result: ValidationResult): { status: "ok" | "invalid" | "blocked"; exitCode: 0 | 2 | 3 } {
  if (result.ok) return { status: "ok", exitCode: 0 };
  const hasBlocker = result.findings.some(
    (f) =>
      f.kind === "registry_parse_error" ||
      f.kind === "card_parse_error",
  );
  if (hasBlocker) return { status: "blocked", exitCode: 3 };
  return { status: "invalid", exitCode: 2 };
}

export const SAFETY_DISCLAIMER =
  "A green skills:validate report is evidence the registry is well-formed. It is NOT authorisation to widen the propose-only contract, promote a hypothesis, or expand autonomy.";

export interface ValidateSkillCardsCliIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export interface ValidateSkillCardsCliResult {
  exitCode: number;
  report: ValidateSkillCardsReport | null;
}

export function runValidateSkillCardsCli(
  argv: readonly string[],
  io: ValidateSkillCardsCliIo,
  deps?: {
    repoRoot?: string;
    fs?: Filesystem;
    parseYaml?: (s: string) => unknown;
  },
): ValidateSkillCardsCliResult {
  const parsed = parseValidateSkillCardsCliArgs(argv, { repoRoot: deps?.repoRoot });

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

  const fsPort = deps?.fs ?? makeRealFilesystem();
  const yamlPort = deps?.parseYaml ?? ((s: string) => parseYaml(s));

  const result = validateSkillRegistry({
    repoRoot: parsed.options.repoRoot,
    fs: fsPort,
    parseYaml: yamlPort,
  });

  const { status, exitCode } = classify(result);

  const report: ValidateSkillCardsReport = {
    schemaVersion: 1,
    label: "skills:validate",
    generatedAt: parsed.options.now,
    repoRoot: parsed.options.repoRoot,
    status,
    findingCount: result.findings.length,
    findings: result.findings,
    registrySummary: {
      version: result.registry?.version ?? null,
      skillIds: result.registry?.skills.map((s) => s.id) ?? [],
    },
    safetyDisclaimer: SAFETY_DISCLAIMER,
  };

  const serialized = parsed.options.pretty
    ? JSON.stringify(report, null, 2)
    : JSON.stringify(report);
  io.stdout(serialized + "\n");

  return { exitCode, report };
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
  const result = runValidateSkillCardsCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
