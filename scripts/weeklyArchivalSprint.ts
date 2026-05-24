#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — WEEKLY ARCHIVAL SPRINT CLI (operator-only, READ-ONLY)
 *
 * Implements the agent's own repeated "Dev Ask" goal:
 *   "every Sunday, flag the 10 oldest KB entries with no hypothesis linkage
 *    for archival review"
 *
 * LOCAL DEV (tsx available):
 *   tsx scripts/weeklyArchivalSprint.ts --pretty
 *   tsx scripts/weeklyArchivalSprint.ts --limit 20
 *   tsx scripts/weeklyArchivalSprint.ts --include-research-linked
 *
 * PRODUCTION (Railway SSH — tsx is pruned, use the bundled CJS):
 *   node dist/weeklyArchivalSprint.cjs --pretty
 *
 * Hard rules:
 *   - READ-ONLY. The CLI opens better-sqlite3 with `{ readonly: true }` and
 *     only uses `Database#prepare(...).get/.all` for SELECTs. No `.exec`,
 *     `.run`, `.transaction`. No write flag of any kind. The operator
 *     decides what to archive *after* reviewing the output — this CLI
 *     does NOT mutate.
 *   - PROPOSE-ONLY: outputs a candidate list. Archival is not performed.
 *   - SCHEMA DISCOVERY: the "KB" lives in the `memory_knowledge` table
 *     as a single JSON blob (id='main') whose `entries[]` array is the
 *     knowledge base. There is no separate hypothesis-KB linkage table —
 *     linkage is implicit:
 *       - `entry.promotedToHypothesisId` set ⇒ linked
 *       - `entry.title` starts with "Hypothesis:" ⇒ hypothesis-origin
 *       - any hypothesis in `research_lab.blob.hypotheses[]` referencing
 *         the entry id ⇒ linked
 *     "Active" status is encoded by `entry.tier === "active"` (and the
 *     absence of any `archivedAt` field). See PR body for full schema notes.
 *   - DETERMINISTIC: no `Date.now`, no `Math.random`. Age computations use
 *     a pinned reference timestamp (`--now`); when omitted the age field
 *     is null instead of being computed against the wall clock.
 *
 * Exit codes:
 *   0 = success
 *   1 = CLI usage / argument error
 *   2 = DB not readable / required table missing
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_DB_PATH = "/data/agent306.db";
const DEFAULT_LIMIT = 10;
const KB_TABLE = "memory_knowledge";
const KB_ROW_ID = "main";
const RESEARCH_LAB_TABLE = "research_lab";
const RESEARCH_LAB_ROW_ID = "main";

export interface ParsedArchivalArgs {
  dbPath: string;
  limit: number;
  pretty: boolean;
  includeResearchLinked: boolean;
  sourceCheck: boolean;
  now: string | null;
  showHelp: boolean;
}

export type ArgsParseResult =
  | { ok: true; args: ParsedArchivalArgs }
  | { ok: false; reason: string };

const HELP = `Weekly Archival Sprint CLI (operator-only, READ-ONLY)

USAGE:
  tsx scripts/weeklyArchivalSprint.ts [--pretty] [--limit N]
  node dist/weeklyArchivalSprint.cjs [--pretty] [--limit N]

OPTIONS:
  --limit N                   Top-N oldest unlinked candidates. Default: ${DEFAULT_LIMIT}.
  --db PATH                   SQLite DB path. Defaults to $DB_PATH then
                              ${DEFAULT_DB_PATH}. Opened with { readonly: true }.
  --pretty                    Pretty-print JSON (2-space indent). Default: compact.
  --include-research-linked   Relaxes the filter to include entries that have
                              research-thread linkage but still no hypothesis
                              linkage. NOTE: this codebase has no research-
                              thread linkage table; the flag is accepted for
                              forward compatibility and emits a banner note
                              when used.
  --no-source-check           Suppress the source-check banner on stderr.
  --now ISO                   Pin the reference timestamp used to compute
                              ageInDays. When omitted, ageInDays is null.
  -h, --help                  Print this message and exit.

OUTPUT:
  default: JSON { generatedAt, dbPath, candidates: [...], counts: { ... } }
  --pretty: indented JSON
  Stderr carries the source-check banner and a final one-line summary.

SAFETY:
  - The DB is opened READ-ONLY. The CLI exposes no write flag.
  - Only Database#prepare(...).get/.all is used. No INSERT/UPDATE/DELETE.
  - The operator decides what (if anything) to archive after review.
`;

export function resolveDefaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.DB_PATH === "string" && env.DB_PATH.length > 0) return env.DB_PATH;
  return DEFAULT_DB_PATH;
}

export function parseArgs(argv: readonly string[]): ArgsParseResult {
  const args: ParsedArchivalArgs = {
    dbPath: resolveDefaultDbPath(),
    limit: DEFAULT_LIMIT,
    pretty: false,
    includeResearchLinked: false,
    sourceCheck: true,
    now: null,
    showHelp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.showHelp = true;
      continue;
    }
    if (a === "--pretty") {
      args.pretty = true;
      continue;
    }
    if (a === "--include-research-linked") {
      args.includeResearchLinked = true;
      continue;
    }
    if (a === "--no-source-check") {
      args.sourceCheck = false;
      continue;
    }
    if (a === "--source-check") {
      args.sourceCheck = true;
      continue;
    }
    // --flag=value form
    if (a.startsWith("--db=")) {
      const v = a.slice("--db=".length).trim();
      if (!v) return { ok: false, reason: "--db requires a non-empty path" };
      args.dbPath = v;
      continue;
    }
    if (a.startsWith("--limit=")) {
      const v = a.slice("--limit=".length).trim();
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 0) return { ok: false, reason: `--limit expects a non-negative integer (got: ${v})` };
      args.limit = n;
      continue;
    }
    if (a.startsWith("--now=")) {
      const v = a.slice("--now=".length).trim();
      if (!v) return { ok: false, reason: "--now requires an ISO-8601 timestamp" };
      args.now = v;
      continue;
    }
    // --flag value form (next arg)
    if (a === "--db") {
      const v = argv[++i];
      if (!v) return { ok: false, reason: "--db requires a path" };
      args.dbPath = v;
      continue;
    }
    if (a === "--limit") {
      const v = argv[++i];
      const n = Number.parseInt(String(v), 10);
      if (!Number.isFinite(n) || n < 0) return { ok: false, reason: `--limit expects a non-negative integer (got: ${v})` };
      args.limit = n;
      continue;
    }
    if (a === "--now") {
      const v = argv[++i];
      if (!v) return { ok: false, reason: "--now requires an ISO-8601 timestamp" };
      args.now = v;
      continue;
    }
    return { ok: false, reason: `unknown flag: ${a}` };
  }
  return { ok: true, args };
}

/** Shape of an entry inside memory_knowledge.blob.entries[]. */
export interface KbEntry {
  id: string;
  title?: string;
  summary?: string;
  category?: string;
  tier?: string;
  weight?: number;
  learnedAt?: string;
  updatedAt?: string;
  source?: string;
  /** Set only when an operator has explicitly promoted this KB entry into
   *  a formal `research_lab.hypotheses[]` record. */
  promotedToHypothesisId?: string;
  archivedAt?: string;
  /** Optional forward-compat: research-thread linkage. Not currently used
   *  by any code path in this repo, but if a future version writes it the
   *  CLI will count it. */
  researchThreadIds?: unknown;
  [k: string]: unknown;
}

/** Shape of a hypothesis inside research_lab.blob.hypotheses[]. */
export interface Hypothesis {
  id: string;
  /** Optional list of KB entry ids this hypothesis was formed from. The
   *  formal hypothesis schema does NOT currently include this field;
   *  reading it is forward-compatible and silently ignored when absent. */
  knowledgeEntryIds?: unknown;
  /** Some past hypotheses carry a single-source pointer instead of a list. */
  sourceKnowledgeId?: string;
  [k: string]: unknown;
}

export interface ArchivalCandidate {
  id: string;
  title: string;
  category: string | null;
  createdAt: string | null;
  ageInDays: number | null;
  linkedHypothesisCount: number;
  linkedResearchThreadCount: number;
  reason: string;
}

export interface ArchivalReport {
  generatedAt: string | null;
  dbPath: string;
  candidates: ArchivalCandidate[];
  counts: {
    totalActive: number;
    totalUnlinked: number;
    returned: number;
  };
  notes: string[];
}

/**
 * Build a set of KB entry ids that are linked to at least one hypothesis.
 * Linkage signals (any one qualifies):
 *   - hypothesis.knowledgeEntryIds (array of strings) — forward-compat field
 *   - hypothesis.sourceKnowledgeId (single string)
 */
export function buildLinkedKbIdsFromHypotheses(hypotheses: readonly Hypothesis[]): Set<string> {
  const out = new Set<string>();
  for (const h of hypotheses) {
    if (Array.isArray(h.knowledgeEntryIds)) {
      for (const id of h.knowledgeEntryIds) {
        if (typeof id === "string" && id.length > 0) out.add(id);
      }
    }
    if (typeof h.sourceKnowledgeId === "string" && h.sourceKnowledgeId.length > 0) {
      out.add(h.sourceKnowledgeId);
    }
  }
  return out;
}

/** Count research-thread-style linkage on an entry. The repo has no
 *  research-thread table; this only counts the optional entry-level
 *  field if a future version starts writing it. Returns 0 when absent. */
export function countResearchThreadLinks(entry: KbEntry): number {
  if (Array.isArray(entry.researchThreadIds)) return entry.researchThreadIds.length;
  return 0;
}

/** An entry is treated as "active" when its `tier` is "active". Entries
 *  with `tier === "operational"` are config-like records and are excluded
 *  from archival sweeps. Entries with an `archivedAt` field set are also
 *  excluded. */
export function isActiveKbEntry(entry: KbEntry): boolean {
  if (typeof entry.archivedAt === "string" && entry.archivedAt.length > 0) return false;
  return entry.tier === "active";
}

/** "Hypothesis linkage" — true if ANY of the following hold:
 *   1. entry.promotedToHypothesisId is set (operator-promoted)
 *   2. entry id appears in the linked-from-hypotheses set
 *   3. entry.title starts with "Hypothesis:" (hypothesis-origin marker;
 *      these are write-only memory shadows of a hypothesis record and
 *      should NOT be archived without the operator examining them) */
export function hasHypothesisLinkage(
  entry: KbEntry,
  linkedFromHypotheses: ReadonlySet<string>,
): boolean {
  if (typeof entry.promotedToHypothesisId === "string" && entry.promotedToHypothesisId.length > 0) {
    return true;
  }
  if (linkedFromHypotheses.has(entry.id)) return true;
  if (typeof entry.title === "string" && entry.title.trim().toLowerCase().startsWith("hypothesis:")) {
    return true;
  }
  return false;
}

function ageInDays(createdAt: string | undefined, now: string | null): number | null {
  if (!createdAt || !now) return null;
  const t = Date.parse(createdAt);
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  return Math.floor((n - t) / 86_400_000);
}

function titleOrSummary(entry: KbEntry): string {
  if (typeof entry.title === "string" && entry.title.length > 0) return entry.title;
  if (typeof entry.summary === "string") return entry.summary.slice(0, 80);
  return "(untitled)";
}

/** Pure builder: given parsed entries + hypotheses, returns the report
 *  payload. No I/O. Exported so tests can drive it directly. */
export function buildReport(
  entries: readonly KbEntry[],
  hypotheses: readonly Hypothesis[],
  args: { limit: number; includeResearchLinked: boolean; now: string | null; dbPath: string },
): ArchivalReport {
  const linkedFromHypotheses = buildLinkedKbIdsFromHypotheses(hypotheses);
  const notes: string[] = [];
  const active = entries.filter(isActiveKbEntry);
  const unlinked = active.filter((e) => !hasHypothesisLinkage(e, linkedFromHypotheses));

  let pool = unlinked;
  if (!args.includeResearchLinked) {
    pool = unlinked.filter((e) => countResearchThreadLinks(e) === 0);
  } else {
    notes.push(
      "includeResearchLinked=true: this repo has no research-thread linkage table; " +
        "the relaxation is a no-op until a future version writes entry.researchThreadIds.",
    );
  }

  pool = [...pool].sort((a, b) => {
    const at = a.learnedAt ?? "";
    const bt = b.learnedAt ?? "";
    if (at === bt) return a.id.localeCompare(b.id);
    return at.localeCompare(bt);
  });

  const top = pool.slice(0, args.limit);

  const candidates: ArchivalCandidate[] = top.map((e) => {
    const age = ageInDays(e.learnedAt, args.now);
    return {
      id: e.id,
      title: titleOrSummary(e),
      category: typeof e.category === "string" ? e.category : null,
      createdAt: typeof e.learnedAt === "string" ? e.learnedAt : null,
      ageInDays: age,
      linkedHypothesisCount: 0,
      linkedResearchThreadCount: countResearchThreadLinks(e),
      reason: age === null
        ? "no hypothesis linkage, age=unknown (no --now pinned)"
        : `no hypothesis linkage, age=${age} days`,
    };
  });

  return {
    generatedAt: args.now,
    dbPath: args.dbPath,
    candidates,
    counts: {
      totalActive: active.length,
      totalUnlinked: pool.length,
      returned: candidates.length,
    },
    notes,
  };
}

/** Parse the JSON blob from a row; returns the parsed object or null on
 *  any failure. Tolerant by design — the CLI should never throw on
 *  malformed blobs. */
function safeParseBlob(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export function readKbEntries(db: Database.Database): KbEntry[] {
  const row = db
    .prepare(`SELECT blob FROM ${quoteIdent(KB_TABLE)} WHERE id = ?`)
    .get(KB_ROW_ID) as { blob: string } | undefined;
  if (!row) return [];
  const parsed = safeParseBlob(row.blob);
  if (!parsed) return [];
  const entries = parsed.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e): e is KbEntry => !!e && typeof e === "object" && typeof (e as KbEntry).id === "string",
  );
}

export function readHypotheses(db: Database.Database): Hypothesis[] {
  // research_lab may not exist in older DBs; tolerate absence by returning [].
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(RESEARCH_LAB_TABLE) as { name: string } | undefined;
  if (!tableExists) return [];
  const row = db
    .prepare(`SELECT blob FROM ${quoteIdent(RESEARCH_LAB_TABLE)} WHERE id = ?`)
    .get(RESEARCH_LAB_ROW_ID) as { blob: string } | undefined;
  if (!row) return [];
  const parsed = safeParseBlob(row.blob);
  if (!parsed) return [];
  const hypotheses = parsed.hypotheses;
  if (!Array.isArray(hypotheses)) return [];
  return hypotheses.filter(
    (h): h is Hypothesis => !!h && typeof h === "object" && typeof (h as Hypothesis).id === "string",
  );
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function formatPrettyTable(report: ArchivalReport): string {
  const lines: string[] = [];
  lines.push("Weekly Archival Sprint — KB candidates with no hypothesis linkage");
  lines.push(`  generatedAt: ${report.generatedAt ?? "(not pinned)"}`);
  lines.push(`  dbPath:      ${report.dbPath}`);
  lines.push(
    `  counts:      totalActive=${report.counts.totalActive} ` +
      `totalUnlinked=${report.counts.totalUnlinked} returned=${report.counts.returned}`,
  );
  if (report.notes.length > 0) {
    lines.push("  notes:");
    for (const n of report.notes) lines.push(`    - ${n}`);
  }
  lines.push("");
  if (report.candidates.length === 0) {
    lines.push("(no candidates)");
    return lines.join("\n") + "\n";
  }
  // Compact column table.
  const header = ["#", "id", "ageDays", "category", "createdAt", "title"];
  const rows = report.candidates.map((c, i) => [
    String(i + 1),
    c.id,
    c.ageInDays === null ? "?" : String(c.ageInDays),
    c.category ?? "-",
    c.createdAt ?? "-",
    (c.title ?? "").slice(0, 80),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  lines.push(header.map((h, i) => pad(h, widths[i])).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) lines.push(r.map((c, i) => pad(c, widths[i])).join("  "));
  return lines.join("\n") + "\n";
}

interface IoStreams {
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
}

interface RunDeps {
  argv: readonly string[];
  io: IoStreams;
  /** Test seam — inject an open in-memory DB instead of opening from disk. */
  openDb?: (absPath: string) => Database.Database;
}

export function runCli(deps: RunDeps): number {
  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) {
    deps.io.stderr.write(`weeklyArchivalSprint: ${parsed.reason}\n`);
    deps.io.stderr.write("Run with --help for usage.\n");
    return 1;
  }
  const args = parsed.args;
  if (args.showHelp) {
    deps.io.stdout.write(HELP);
    return 0;
  }

  const absPath = path.isAbsolute(args.dbPath)
    ? args.dbPath
    : path.resolve(process.cwd(), args.dbPath);

  let db: Database.Database;
  try {
    const opener = deps.openDb ?? ((p: string) => new Database(p, { readonly: true }));
    db = opener(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.io.stderr.write(`weeklyArchivalSprint: could not open DB at ${absPath}: ${msg}\n`);
    return 2;
  }

  try {
    if (args.sourceCheck) {
      let size: number | null = null;
      try {
        size = fs.statSync(absPath).size;
      } catch {
        size = null;
      }
      const tables = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      deps.io.stderr.write(
        `[weeklyArchivalSprint] source-check (read-only):\n` +
          `  dbAbsPath: ${absPath}\n` +
          `  dbFileSizeBytes: ${size ?? "(unknown)"}\n` +
          `  tables: ${tables.join(", ") || "(none)"}\n` +
          `  kbTable: ${KB_TABLE} (row id='${KB_ROW_ID}')\n` +
          `  researchLabTable: ${RESEARCH_LAB_TABLE} (row id='${RESEARCH_LAB_ROW_ID}')\n`,
      );
      if (!tables.includes(KB_TABLE)) {
        deps.io.stderr.write(
          `weeklyArchivalSprint: required table '${KB_TABLE}' not found.\n`,
        );
        return 2;
      }
    } else {
      const tableExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(KB_TABLE) as { name: string } | undefined;
      if (!tableExists) {
        deps.io.stderr.write(
          `weeklyArchivalSprint: required table '${KB_TABLE}' not found.\n`,
        );
        return 2;
      }
    }

    const entries = readKbEntries(db);
    const hypotheses = readHypotheses(db);
    const report = buildReport(entries, hypotheses, {
      limit: args.limit,
      includeResearchLinked: args.includeResearchLinked,
      now: args.now,
      dbPath: absPath,
    });

    if (args.pretty) {
      // --pretty switches the *whole* surface to human-readable mode: a
      // formatted table on stdout, summary on stderr.
      deps.io.stdout.write(formatPrettyTable(report));
    } else {
      deps.io.stdout.write(JSON.stringify(report) + "\n");
    }
    deps.io.stderr.write(
      `[weeklyArchivalSprint] ${report.counts.totalActive} total active KB entries, ` +
        `${report.counts.totalUnlinked} with no hypothesis linkage. ` +
        `Showing oldest ${report.counts.returned}.\n`,
    );
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort close on read-only handle */
    }
  }
}

export function main(): void {
  const code = runCli({
    argv: process.argv.slice(2),
    io: { stdout: process.stdout, stderr: process.stderr },
  });
  process.exit(code);
}

function isDirectInvocation(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const base = path.basename(argv1);
  if (
    base === "weeklyArchivalSprint.cjs" ||
    base === "weeklyArchivalSprint.ts" ||
    base === "weeklyArchivalSprint.js" ||
    base === "weeklyArchivalSprint.mjs"
  ) {
    return true;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metaUrl = (import.meta as any)?.url as string | undefined;
    if (typeof metaUrl !== "string") return false;
    const filePath = metaUrl.startsWith("file://") ? metaUrl.slice("file://".length) : metaUrl;
    return path.resolve(filePath) === path.resolve(argv1);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main();
}
