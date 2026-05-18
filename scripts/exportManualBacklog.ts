#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — MANUAL BACKLOG EXPORT CLI (operator-only, READ-ONLY)
 *
 * Produces a deterministic Markdown + JSON export of the manual-backlog
 * hypotheses (positional-debate rewrites, missing-evidence-path repairs,
 * memory-origin promotion candidates) for offline operator review.
 *
 * Read-only by construction. This script:
 *   - Never opens the SQLite DB in write mode.
 *   - Never writes to research_lab.json or research_lab.json.bak.
 *   - Never mutates memory_knowledge.json.
 *   - Never changes any hypothesis status, hygieneTag, or other field.
 *   - Never archives, promotes, or applies anything.
 *
 * It REUSES the canonical reset-report classifier (`buildResetReport` →
 * `classifyReset` in server/hypothesisIntakeAuditVisibility.ts) so the
 * bucket assignment is byte-for-byte the same as what
 * `scripts/hypothesisReset.ts` reports. No reset / archive code path is
 * called.
 *
 * Defaults are deliberately conservative — `already_archived` (the 338
 * rows the operator must NOT touch) is OFF unless `--include-archived`
 * is explicit, and `keep_active` / `archive_*` / `needs_operator_review`
 * are also excluded by default. Only the three buckets the operator
 * actually has to work on land in the export.
 *
 * Usage:
 *   npx tsx scripts/exportManualBacklog.ts
 *   npx tsx scripts/exportManualBacklog.ts --data-dir=/data
 *   npx tsx scripts/exportManualBacklog.ts --source=/abs/path/research_lab.json
 *   npx tsx scripts/exportManualBacklog.ts --out-dir=./backlog-export-2026-05-18
 *   npx tsx scripts/exportManualBacklog.ts --format=json
 *   npx tsx scripts/exportManualBacklog.ts --buckets=rewrite_positional_debate
 *   npx tsx scripts/exportManualBacklog.ts --include-archived
 *   npx tsx scripts/exportManualBacklog.ts --dry-run
 *
 * Flags:
 *   --data-dir <path>       Where research_lab.json / agent306.db live.
 *                           Defaults to env DATA_DIR or the repo's data/
 *                           directory; pass `/data` in production.
 *   --source <path>         Absolute path to a formal research_lab.json
 *                           override. Bypasses DATA_DIR discovery.
 *   --out-dir <path>        Directory for the export artefacts.
 *                           Defaults to ./backlog-export-<UTC-date>.
 *   --buckets <a,b,c>       Comma-separated reset buckets to include.
 *                           Default:
 *                             rewrite_positional_debate,
 *                             rewrite_missing_evidence_path,
 *                             promote_later_memory_origin
 *   --format <md|json|both> Which artefacts to write. Default: both.
 *   --include-archived      Also include the `already_archived` bucket
 *                           (the 338 audit-only rows). OFF by default.
 *   --dry-run               Print bucket counts to stdout; write nothing.
 *   --now <iso>             Pin the "Generated" timestamp (tests / repro).
 *   -h, --help              Print this usage and exit 0.
 *
 * Exit codes:
 *   0  success (export written, or dry-run printed)
 *   1  CLI usage error
 *   2  source discovery surfaced 0 records — refusing to write a misleading
 *      empty export when the operator likely pointed at the wrong volume.
 *      (Suppressed under --dry-run, which always exits 0 unless usage
 *      itself was malformed.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import {
  RESET_BUCKETS,
  type ResetBucket,
} from "../server/hypothesisIntakeAuditVisibility.js";
import {
  buildResetReport,
  type ResetReportEntry,
  type ResetReportBucketSection,
  type HypothesisResetReport,
} from "../server/hypothesisResetReport.js";
import { discoverHypothesisSources } from "../server/hypothesisSourceDiscovery.js";
import type { HygieneAwareHypothesis } from "../server/hypothesisHygiene.js";

// ── Public types (exported so the test file can pin them) ───────────────────

export const DEFAULT_BACKLOG_BUCKETS: readonly ResetBucket[] = [
  "rewrite_positional_debate",
  "rewrite_missing_evidence_path",
  "promote_later_memory_origin",
] as const;

export const ARCHIVED_BUCKET: ResetBucket = "already_archived";

/** Required fields per bucket for the "missing fields" inventory.
 *  Deterministic — no LLM, no fuzzy matching. */
const REQUIRED_FIELDS_PER_BUCKET: Readonly<Record<ResetBucket, readonly string[]>> = Object.freeze({
  keep_active:                   ["claim", "metric", "basis", "measurementPath", "prediction", "timeframe"],
  archive_stale:                 [],
  archive_data_unavailable:      [],
  archive_duplicate:             [],
  already_archived:              [],
  rewrite_positional_debate:     ["claim", "metric", "basis", "measurementPath", "prediction", "timeframe"],
  rewrite_missing_evidence_path: ["claim", "metric", "basis", "measurementPath", "prediction", "timeframe"],
  promote_later_memory_origin:   ["claim"],
  needs_operator_review:         [],
});

/** One-line recommended action per bucket. Bucket → action is deterministic
 *  by construction (no LLM, no clock dependency). */
const RECOMMENDED_ACTION_PER_BUCKET: Readonly<Record<ResetBucket, string>> = Object.freeze({
  keep_active:                   "No action — record stays in the active loop.",
  archive_stale:                 "Operator may archive via scripts/hypothesisReset.ts --bucket=archive_stale --apply after review.",
  archive_data_unavailable:      "Operator may archive via scripts/hypothesisReset.ts --bucket=archive_data_unavailable --apply after review.",
  archive_duplicate:             "Operator may archive via scripts/hypothesisReset.ts --bucket=archive_duplicate --apply after review.",
  already_archived:              "No action — already archived by a prior reset apply. Listed for audit only.",
  rewrite_positional_debate:     "rewrite as research-gap framing",
  rewrite_missing_evidence_path: "repair evidence path",
  promote_later_memory_origin:   "review for operator promotion",
  needs_operator_review:         "Manual operator review.",
});

/** Per-item structured export shape. Stable — sort by `id` lexicographically
 *  for deterministic `backlog.json`. */
export interface BacklogExportItem {
  id:                  string;
  bucket:              ResetBucket;
  origin:              "formal" | "memory";
  claim:               string;
  status:              string;
  formedAt:            string | null;
  source:              string | null;
  presentFields:       string[];
  missingFields:       string[];
  recommendedAction:   string;
  /** Classifier reasons echoed for audit. */
  classifierReasons:   string[];
  /** Intake gate verdict echoed for triage. */
  intakeVerdict:       string;
}

export interface BacklogExportPayload {
  schemaVersion: "manual-backlog-export-1";
  generatedAt:   string | null;
  dataDir:       string;
  source:        string;
  gitSha:        string | null;
  bucketsIncluded: ResetBucket[];
  includeArchived: boolean;
  counts:        Record<string, number>;
  items:         BacklogExportItem[];
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

export interface CliArgs {
  dataDir:         string | null;
  source:          string | null;
  outDir:          string | null;
  buckets:         ResetBucket[];
  format:          "markdown" | "json" | "both";
  includeArchived: boolean;
  dryRun:          boolean;
  now:             string | null;
  showHelp:        boolean;
}

const HELP_TEXT = [
  "Manual Backlog Export CLI (read-only)",
  "",
  "Usage:",
  "  npx tsx scripts/exportManualBacklog.ts [flags]",
  "",
  "Flags:",
  "  --data-dir <path>         DATA_DIR override (default: env DATA_DIR or repo data/)",
  "  --source <path>           Absolute research_lab.json override",
  "  --out-dir <path>          Output directory (default: ./backlog-export-<UTC-date>)",
  "  --buckets <a,b,c>         Comma-separated reset buckets to include",
  "                            (default: " + DEFAULT_BACKLOG_BUCKETS.join(",") + ")",
  "  --format <md|json|both>   Artefacts to write (default: both)",
  "  --include-archived        Include the `already_archived` bucket (OFF by default)",
  "  --dry-run                 Print bucket counts; write nothing",
  "  --now <iso>               Pin the Generated timestamp (tests / repro)",
  "  -h, --help                Print this usage and exit 0",
].join("\n");

export function parseArgs(argv: readonly string[]): { ok: true; args: CliArgs } | { ok: false; reason: string } {
  const args: CliArgs = {
    dataDir:         null,
    source:          null,
    outDir:          null,
    buckets:         [...DEFAULT_BACKLOG_BUCKETS],
    format:          "both",
    includeArchived: false,
    dryRun:          false,
    now:             null,
    showHelp:        false,
  };
  let bucketsExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { args.showHelp = true; continue; }
    if (a === "--dry-run") { args.dryRun = true; continue; }
    if (a === "--include-archived" || a === "--include-archived=true") { args.includeArchived = true; continue; }
    if (a === "--include-archived=false") { args.includeArchived = false; continue; }

    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inlineVal = eq >= 0 ? a.slice(eq + 1) : null;
    const nextVal = (): string | null => {
      if (inlineVal !== null) return inlineVal;
      const n = argv[i + 1];
      if (typeof n === "string" && !n.startsWith("--")) { i++; return n; }
      return null;
    };

    switch (key) {
      case "--data-dir": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--data-dir requires a path" };
        args.dataDir = v;
        break;
      }
      case "--source": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--source requires an absolute path" };
        args.source = v;
        break;
      }
      case "--out-dir": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--out-dir requires a path" };
        args.outDir = v;
        break;
      }
      case "--buckets": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--buckets requires a comma-separated list" };
        const parsed: ResetBucket[] = [];
        for (const tok of v.split(",")) {
          const t = tok.trim();
          if (!t) continue;
          if (!RESET_BUCKETS.includes(t as ResetBucket)) {
            return { ok: false, reason: `unknown bucket: ${t}. Valid: ${RESET_BUCKETS.join(",")}` };
          }
          parsed.push(t as ResetBucket);
        }
        if (parsed.length === 0) return { ok: false, reason: "--buckets parsed to an empty list" };
        args.buckets = parsed;
        bucketsExplicit = true;
        break;
      }
      case "--format": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--format requires markdown|json|both (or md / json)" };
        const norm = v.toLowerCase() === "md" ? "markdown" : v.toLowerCase();
        if (norm !== "markdown" && norm !== "json" && norm !== "both") {
          return { ok: false, reason: `--format must be markdown|json|both, got: ${v}` };
        }
        args.format = norm as CliArgs["format"];
        break;
      }
      case "--now": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--now requires an ISO-8601 timestamp" };
        if (!Number.isFinite(Date.parse(v))) {
          return { ok: false, reason: `--now is not a valid ISO timestamp: ${v}` };
        }
        args.now = v;
        break;
      }
      default:
        return { ok: false, reason: `unknown flag: ${a}` };
    }
  }

  // When --include-archived is set AND the operator did not explicitly
  // pass --buckets, append already_archived to the default set so the
  // operator sees what they asked for.
  if (args.includeArchived && !bucketsExplicit && !args.buckets.includes(ARCHIVED_BUCKET)) {
    args.buckets.push(ARCHIVED_BUCKET);
  }

  return { ok: true, args };
}

// ── Field inventory + recommended action ─────────────────────────────────────

/** Extract present / missing field lists for a hypothesis-like record.
 *  Deterministic. Empty strings count as missing. */
export function inventoryFields(
  rec:           Record<string, unknown>,
  requiredKeys:  readonly string[],
): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const k of requiredKeys) {
    const v = rec[k];
    const ok = (typeof v === "string" && v.trim().length > 0)
      || (typeof v === "number" && Number.isFinite(v))
      || (Array.isArray(v) && v.length > 0)
      || (v !== null && typeof v === "object" && Object.keys(v as object).length > 0);
    if (ok) present.push(k); else missing.push(k);
  }
  return { present, missing };
}

// ── Item assembly ────────────────────────────────────────────────────────────

/** Build the structured export payload from a reset report + raw record
 *  map. Pure / deterministic. */
export function buildExportPayload(args: {
  report:           HypothesisResetReport;
  recordsById:      ReadonlyMap<string, HygieneAwareHypothesis | Record<string, unknown>>;
  buckets:          readonly ResetBucket[];
  generatedAt:      string | null;
  dataDir:          string;
  source:           string;
  gitSha:           string | null;
  includeArchived:  boolean;
}): BacklogExportPayload {
  const selected = new Set<ResetBucket>(args.buckets);
  const items: BacklogExportItem[] = [];
  const counts: Record<string, number> = Object.create(null);
  for (const b of args.buckets) counts[b] = 0;

  for (const section of args.report.buckets) {
    if (!selected.has(section.bucket)) continue;
    for (const entry of section.entries) {
      const item = assembleItem(entry, section, args.recordsById);
      items.push(item);
      counts[section.bucket] = (counts[section.bucket] ?? 0) + 1;
    }
  }

  // Deterministic sort by id across the entire export.
  items.sort((a, b) => a.id.localeCompare(b.id));

  return {
    schemaVersion:   "manual-backlog-export-1",
    generatedAt:     args.generatedAt,
    dataDir:         args.dataDir,
    source:          args.source,
    gitSha:          args.gitSha,
    bucketsIncluded: [...args.buckets],
    includeArchived: args.includeArchived,
    counts,
    items,
  };
}

function assembleItem(
  entry:       ResetReportEntry,
  section:     ResetReportBucketSection,
  recordsById: ReadonlyMap<string, HygieneAwareHypothesis | Record<string, unknown>>,
): BacklogExportItem {
  const raw = recordsById.get(entry.id) ?? null;
  const requiredKeys = REQUIRED_FIELDS_PER_BUCKET[entry.bucket] ?? [];
  const inv = raw
    ? inventoryFields(raw as Record<string, unknown>, requiredKeys)
    : { present: [], missing: [...requiredKeys] };

  // Memory-origin entries don't have a full Hypothesis shape — they
  // carry the title-derived claim in entry.claimPreview. Fall back to that
  // when the raw record is a memory entry or null.
  const claim = (raw && typeof (raw as any).claim === "string" && (raw as any).claim.trim().length > 0)
    ? (raw as any).claim as string
    : entry.claimPreview;

  const source = (raw && typeof (raw as any).source === "string" && (raw as any).source.trim().length > 0)
    ? (raw as any).source as string
    : (entry.origin === "memory" ? "memory_knowledge.json" : null);

  return {
    id:                entry.id,
    bucket:            entry.bucket,
    origin:            entry.origin,
    claim,
    status:            entry.status,
    formedAt:          entry.formedAt,
    source,
    presentFields:     inv.present,
    missingFields:     inv.missing,
    recommendedAction: RECOMMENDED_ACTION_PER_BUCKET[entry.bucket],
    classifierReasons: [...entry.reasons],
    intakeVerdict:     entry.intakeVerdict,
  };
}

// ── Markdown rendering ───────────────────────────────────────────────────────

/** Render the per-bucket markdown body. Pure / deterministic. */
export function renderBucketMarkdown(
  title:        string,
  bucket:       ResetBucket,
  items:        readonly BacklogExportItem[],
): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Bucket: \`${bucket}\``);
  lines.push(`Items:  ${items.length}`);
  lines.push("");
  if (items.length === 0) {
    lines.push("_No items in this bucket._");
    lines.push("");
    return lines.join("\n");
  }
  for (const it of items) {
    lines.push(`### ${it.id}`);
    lines.push("");
    lines.push(`- **Bucket:** \`${it.bucket}\``);
    lines.push(`- **Origin:** ${it.origin}`);
    lines.push(`- **Status:** ${it.status}`);
    lines.push(`- **Formed at:** ${it.formedAt ?? "(unset)"}`);
    lines.push(`- **Source:** ${it.source ?? "(unset)"}`);
    lines.push(`- **Recommended action:** ${it.recommendedAction}`);
    lines.push(`- **Intake verdict:** \`${it.intakeVerdict}\``);
    lines.push(`- **Present fields:** ${it.presentFields.length > 0 ? it.presentFields.map(s => "`" + s + "`").join(", ") : "_(none)_"}`);
    lines.push(`- **Missing fields:** ${it.missingFields.length > 0 ? it.missingFields.map(s => "`" + s + "`").join(", ") : "_(none)_"}`);
    if (it.classifierReasons.length > 0) {
      lines.push(`- **Classifier reasons:**`);
      for (const r of it.classifierReasons) lines.push(`    - ${r}`);
    }
    lines.push("");
    lines.push(`**Claim:**`);
    lines.push("");
    lines.push("> " + it.claim.replace(/\n/g, "\n> "));
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

/** Render summary.md — counts + run metadata + a legend.
 *  `generatedAt` is the ONLY clock-derived value embedded in the output.
 *  Tests pin it via --now so the file becomes byte-deterministic. */
export function renderSummaryMarkdown(payload: BacklogExportPayload): string {
  const lines: string[] = [];
  lines.push("# Manual Backlog Export — Summary");
  lines.push("");
  lines.push(`- **Generated:** ${payload.generatedAt ?? "(not set)"}`);
  lines.push(`- **DATA_DIR:** \`${payload.dataDir}\``);
  lines.push(`- **Source:** \`${payload.source}\``);
  lines.push(`- **Git SHA:** ${payload.gitSha ?? "(unknown)"}`);
  lines.push(`- **Schema version:** \`${payload.schemaVersion}\``);
  lines.push(`- **Buckets included:** ${payload.bucketsIncluded.map(b => "`" + b + "`").join(", ")}`);
  lines.push(`- **Include archived:** ${payload.includeArchived}`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  const bucketEntries = [...payload.bucketsIncluded].sort();
  for (const b of bucketEntries) {
    lines.push(`- \`${b}\`: ${payload.counts[b] ?? 0}`);
  }
  lines.push(`- **Total:** ${payload.items.length}`);
  lines.push("");
  lines.push("## Legend");
  lines.push("");
  lines.push("- **rewrite_positional_debate** — claim shaped like 'A vs B'; reframe as a research-gap claim with metric + deadline.");
  lines.push("- **rewrite_missing_evidence_path** — missing measurementPath / metric / basis; repair before re-entering the loop.");
  lines.push("- **promote_later_memory_origin** — memory_knowledge.json entry (`title: \"Hypothesis: …\"`); promotion to formal is operator-only.");
  lines.push("- **already_archived** — audit-only; the existing reset CLI will REFUSE to re-archive these.");
  lines.push("");
  lines.push("## Read-only invariant");
  lines.push("");
  lines.push("This export is produced by `scripts/exportManualBacklog.ts`, which:");
  lines.push("");
  lines.push("- Does NOT open the SQLite DB in write mode.");
  lines.push("- Does NOT write research_lab.json / research_lab.json.bak / memory_knowledge.json.");
  lines.push("- Does NOT change any hypothesis status, hygieneTag, or other field.");
  lines.push("- Does NOT archive, promote, or apply anything.");
  lines.push("");
  lines.push("It reuses `buildResetReport` / `classifyReset` from");
  lines.push("`server/hypothesisIntakeAuditVisibility.ts` so bucket assignment");
  lines.push("matches `scripts/hypothesisReset.ts` byte-for-byte.");
  lines.push("");
  return lines.join("\n");
}

// ── File layout ──────────────────────────────────────────────────────────────

/** Per-bucket output filename (stable). */
export function filenameForBucket(b: ResetBucket): string | null {
  switch (b) {
    case "rewrite_positional_debate":     return "positional-debate-rewrites.md";
    case "rewrite_missing_evidence_path": return "missing-evidence-path-repairs.md";
    case "promote_later_memory_origin":   return "memory-origin-promotion-candidates.md";
    case "already_archived":              return "already-archived-audit-only.md";
    case "keep_active":                   return "keep-active.md";
    case "archive_stale":                 return "archive-stale.md";
    case "archive_data_unavailable":      return "archive-data-unavailable.md";
    case "archive_duplicate":             return "archive-duplicate.md";
    case "needs_operator_review":         return "needs-operator-review.md";
    default:                              return null;
  }
}

function titleForBucket(b: ResetBucket): string {
  switch (b) {
    case "rewrite_positional_debate":     return "Positional-debate rewrites";
    case "rewrite_missing_evidence_path": return "Missing-evidence-path repairs";
    case "promote_later_memory_origin":   return "Memory-origin promotion candidates";
    case "already_archived":              return "Already archived (audit only)";
    default:                              return b;
  }
}

// ── Helpers: git SHA, default out-dir, source label ──────────────────────────

function safeGitShortSha(): string | null {
  try {
    const out = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      cwd:   path.resolve(new URL(".", import.meta.url).pathname, ".."),
    }).toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function defaultOutDir(now: Date): string {
  const iso = now.toISOString().slice(0, 10);
  return `./backlog-export-${iso}`;
}

function sourceLabel(report: HypothesisResetReport): string {
  return report.meta.researchLabPath ?? "(unknown)";
}

// ── Main entry ───────────────────────────────────────────────────────────────

export interface RunResult {
  exitCode:    number;
  payload:     BacklogExportPayload | null;
  writtenPaths: string[];
  /** Captured stdout for dry-run / summary; tests can assert on this. */
  stdout:      string;
}

export interface RunOptions {
  argv:    readonly string[];
  /** Pluggable file writer for tests. Defaults to fs. */
  fs?:     {
    mkdirSync:    (p: string, opts?: { recursive?: boolean }) => void;
    writeFileSync: (p: string, body: string) => void;
    existsSync:   (p: string) => boolean;
  };
}

const DEFAULT_FS: NonNullable<RunOptions["fs"]> = {
  mkdirSync:    (p, o) => fs.mkdirSync(p, o ?? {}),
  writeFileSync: (p, b) => fs.writeFileSync(p, b),
  existsSync:   (p) => fs.existsSync(p),
};

/** Runner. Pure aside from the injected fs sink. */
export function runExport(opts: RunOptions): RunResult {
  const sink = opts.fs ?? DEFAULT_FS;
  const stdoutParts: string[] = [];

  const parsed = parseArgs(opts.argv);
  if (!parsed.ok) {
    return {
      exitCode: 1,
      payload:  null,
      writtenPaths: [],
      stdout: `error: ${parsed.reason}\n${HELP_TEXT}\n`,
    };
  }
  if (parsed.args.showHelp) {
    return { exitCode: 0, payload: null, writtenPaths: [], stdout: HELP_TEXT + "\n" };
  }
  const args = parsed.args;

  // Source discovery (read-only). We also call discoverHypothesisSources
  // directly to keep a side-channel map of raw records by id so the
  // export can quote claim text + run the per-bucket field inventory.
  const discOpts: { sourcePath?: string; dataDir?: string } = {};
  if (args.source) discOpts.sourcePath = args.source;
  if (args.dataDir) discOpts.dataDir = args.dataDir;
  const discovered = discoverHypothesisSources(discOpts);

  const recordsById = new Map<string, HygieneAwareHypothesis | Record<string, unknown>>();
  for (const h of discovered.formalHypotheses) {
    if (typeof h.id === "string") recordsById.set(h.id, h);
  }
  for (const e of discovered.memoryHypothesisEntries) {
    const key = `memory:${e.id}`;
    recordsById.set(key, e as unknown as Record<string, unknown>);
  }

  const reportOpts: Parameters<typeof buildResetReport>[0] = {};
  if (args.source) reportOpts.sourcePath = args.source;
  if (args.dataDir) reportOpts.dataDir = args.dataDir;
  if (args.now) reportOpts.now = new Date(args.now);
  const report = buildResetReport(reportOpts);

  const totalRecordsInScope = report.buckets
    .filter(b => args.buckets.includes(b.bucket))
    .reduce((n, b) => n + b.count, 0);

  const payload = buildExportPayload({
    report,
    recordsById,
    buckets: args.buckets,
    generatedAt: args.now ?? new Date().toISOString(),
    dataDir: report.meta.dataDir,
    source: sourceLabel(report),
    gitSha: safeGitShortSha(),
    includeArchived: args.includeArchived,
  });

  // Dry-run path — print, write nothing.
  if (args.dryRun) {
    stdoutParts.push(`[dry-run] Manual backlog export plan`);
    stdoutParts.push(`[dry-run] DATA_DIR: ${payload.dataDir}`);
    stdoutParts.push(`[dry-run] Source:   ${payload.source}`);
    stdoutParts.push(`[dry-run] Buckets:  ${payload.bucketsIncluded.join(", ")}`);
    stdoutParts.push(`[dry-run] Counts:`);
    for (const b of payload.bucketsIncluded) {
      stdoutParts.push(`  ${b}: ${payload.counts[b] ?? 0}`);
    }
    stdoutParts.push(`[dry-run] Total items in scope: ${payload.items.length}`);
    stdoutParts.push(`[dry-run] No files written.`);
    return { exitCode: 0, payload, writtenPaths: [], stdout: stdoutParts.join("\n") + "\n" };
  }

  // Refuse to write a misleading empty export. The operator most likely
  // pointed at the wrong DATA_DIR. The dry-run path is exempt so an
  // operator can still confirm "yes, zero items expected".
  if (totalRecordsInScope === 0) {
    stdoutParts.push(`error: 0 records in scope across buckets [${args.buckets.join(", ")}].`);
    stdoutParts.push(`refusing to write an empty export (likely wrong --data-dir or --source).`);
    stdoutParts.push(`re-run with --dry-run if zero is the expected count.`);
    return { exitCode: 2, payload, writtenPaths: [], stdout: stdoutParts.join("\n") + "\n" };
  }

  const outDir = args.outDir ?? defaultOutDir(new Date(payload.generatedAt ?? Date.now()));
  if (!sink.existsSync(outDir)) sink.mkdirSync(outDir, { recursive: true });

  const written: string[] = [];

  if (args.format === "markdown" || args.format === "both") {
    const summaryPath = path.join(outDir, "summary.md");
    sink.writeFileSync(summaryPath, renderSummaryMarkdown(payload));
    written.push(summaryPath);

    for (const bucket of args.buckets) {
      const fname = filenameForBucket(bucket);
      if (fname === null) continue;
      const items = payload.items.filter(i => i.bucket === bucket);
      const md = renderBucketMarkdown(titleForBucket(bucket), bucket, items);
      const fpath = path.join(outDir, fname);
      sink.writeFileSync(fpath, md);
      written.push(fpath);
    }
  }

  if (args.format === "json" || args.format === "both") {
    const jsonPath = path.join(outDir, "backlog.json");
    sink.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
    written.push(jsonPath);
  }

  stdoutParts.push(`Manual backlog export written to: ${outDir}`);
  stdoutParts.push(`Items: ${payload.items.length} across ${payload.bucketsIncluded.length} bucket(s)`);
  for (const b of payload.bucketsIncluded) {
    stdoutParts.push(`  ${b}: ${payload.counts[b] ?? 0}`);
  }
  stdoutParts.push(`Files: ${written.length}`);

  return { exitCode: 0, payload, writtenPaths: written, stdout: stdoutParts.join("\n") + "\n" };
}

function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  try {
    return new URL(`file://${argv1}`).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = runExport({ argv: process.argv.slice(2) });
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
