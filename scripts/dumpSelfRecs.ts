#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SELF-RECOMMENDATIONS DUMP CLI (operator-only, READ-ONLY)
 *
 * LOCAL DEV (tsx available):
 *   tsx scripts/dumpSelfRecs.ts --ids=rec_a,rec_b --db=/tmp/test.db
 *   tsx scripts/dumpSelfRecs.ts --ids=rec_a --pretty
 *   tsx scripts/dumpSelfRecs.ts --ids=rec_a --status=approved
 *
 * PRODUCTION (Railway SSH — tsx is pruned, use the bundled CJS):
 *   node dist/dumpSelfRecs.cjs --ids=rec_a,rec_b,rec_c --pretty
 *   node dist/dumpSelfRecs.cjs --ids=rec_a --status=approved --no-source-check
 *   (The bundle is produced by the Dockerfile via esbuild; mirrors PR #411.)
 *
 * Hard rules:
 *   - READ-ONLY. The CLI opens better-sqlite3 with `{ readonly: true }` and
 *     ONLY uses `Database#prepare(...).all/.get` for SELECTs. No `.exec`,
 *     no `.run`, no `.transaction`. The CLI deliberately exposes NO write
 *     flag of any kind — there is nothing to apply.
 *   - DETERMINISTIC. No `Date.now`, no `Math.random`, no env reads beyond
 *     the optional defaults the operator passes via flags. The optional
 *     `--now <iso>` pin is the only timestamp surface.
 *   - STDOUT-ONLY for results, STDERR for the source-check banner and any
 *     warnings. Exit code is non-zero on failure.
 *   - SAFETY BANNER. By default the CLI prints the DB absolute path, file
 *     size, table list, target table column list, and total row count to
 *     stderr BEFORE running the query, so the operator can verify they
 *     are hitting the right DB. `--no-source-check` skips this banner.
 *   - PARAMETERIZED QUERY. The `WHERE id IN (?, ?, …)` placeholders are
 *     bound, never string-interpolated. SQL metacharacters in IDs cannot
 *     break the query.
 *
 * Exit codes:
 *   0 = success, results emitted (no zero-row warnings or partial-not-found)
 *   1 = CLI usage / argument error (missing --ids, unknown flag, etc.)
 *   2 = DB not readable / table missing / schema mismatch
 *   3 = query returned zero rows for at least one requested ID (still emits
 *       the JSON payload with `found` and `notFound` populated; this is a
 *       partial-success warning, not a hard error)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ParsedDumpArgs {
  ids: string[];
  dbPath: string;
  pretty: boolean;
  includeEvidence: boolean;
  includeAttestations: boolean;
  allFields: boolean;
  statusFilter: string | null;
  sourceCheck: boolean;
  now: string | null;
  showHelp: boolean;
}

export interface DumpArgsParseError {
  ok: false;
  reason: string;
}

export interface DumpArgsParseOk {
  ok: true;
  args: ParsedDumpArgs;
}

export type DumpArgsParseResult = DumpArgsParseOk | DumpArgsParseError;

/**
 * Hardcoded fallback when neither --db nor DB_PATH supplies a path.
 * The Railway production volume mounts at /data and the DB filename is
 * `agent306.db` (matches server/db.ts's dataPath("agent306.db") and the
 * Dockerfile volume layout). The historical "/data/research_lab.db"
 * default was inherited from a pre-PR-#411 layout that never shipped.
 */
const DEFAULT_DB_PATH = "/data/agent306.db";

/**
 * Resolve the effective default DB path. Priority:
 *   1. process.env.DB_PATH (matches the env-var contract used by server/db.ts
 *      and other operator CLIs).
 *   2. DEFAULT_DB_PATH (/data/agent306.db) — production Railway volume.
 * The --db flag still overrides this at parse time.
 */
export function resolveDefaultDumpDbPath(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.DB_PATH === "string" && env.DB_PATH.length > 0) return env.DB_PATH;
  return DEFAULT_DB_PATH;
}

/** Curated set of columns emitted by default for readability. */
export const CURATED_COLUMNS = [
  "id",
  "status",
  "title",
  "rationale",
  "kind",
  "createdAt",
  "updatedAt",
  "approvedAt",
  "appliedAt",
  "evidence",
  "attestations",
] as const;

/** Columns we attempt to JSON.parse before emitting. */
export const JSON_COLUMNS = new Set<string>([
  "evidence",
  "attestations",
  "metadata",
  "context",
  "tags",
  "diff",
]);

const HELP = `Self-Recommendations Dump CLI (operator-only, READ-ONLY)

usage (local dev, tsx available):
  tsx scripts/dumpSelfRecs.ts --ids=rec_a,rec_b
  tsx scripts/dumpSelfRecs.ts --ids=rec_a --pretty
  tsx scripts/dumpSelfRecs.ts --ids=rec_a --status=approved
  tsx scripts/dumpSelfRecs.ts --ids=rec_a --db=/abs/path/to.db
  tsx scripts/dumpSelfRecs.ts --ids=rec_a --all-fields
  tsx scripts/dumpSelfRecs.ts --ids=rec_a --no-source-check

usage (Railway SSH, tsx pruned — use the bundled CJS):
  node dist/dumpSelfRecs.cjs --ids=rec_a,rec_b,rec_c --pretty
  (Same flags as the tsx invocation. Bundle built by Dockerfile, mirrors PR #411.)

flags:
  --ids=ID1,ID2,…       REQUIRED. Comma-separated list of recommendation IDs.
                        IDs are passed to a parameterized SELECT — SQL meta-
                        characters cannot break the query.
  --db=PATH             Absolute path to the SQLite DB. Default:
                        ${DEFAULT_DB_PATH}.
                        The DB is opened with { readonly: true }.
  --pretty              Pretty-print the JSON payload (2-space indent).
                        Default: compact, single line.
  --include-evidence    Include the \`evidence\` column in output. Default: true.
  --no-include-evidence Omit the \`evidence\` column.
  --include-attestations
                        Include the \`attestations\` column. Default: true.
  --no-include-attestations
                        Omit the \`attestations\` column.
  --all-fields          Emit every column from the row instead of the curated
                        readability set. Useful for deep debugging.
  --status=STATUS       Only return rows whose \`status\` column matches.
  --source-check        Print the source-check banner to stderr before the
                        query. Default: ON.
  --no-source-check     Skip the source-check banner.
  --now=ISO             Pin the \`dumpedAt\` timestamp in the output payload to
                        the given ISO-8601 string. When omitted, \`dumpedAt\`
                        is null. The CLI never reads the wall clock.
  -h, --help            Show this message.

exit codes:
  0  success, every requested ID was found
  1  CLI usage / argument error
  2  DB not readable / table missing / schema mismatch
  3  one or more requested IDs returned zero rows (payload still emitted)

safety:
  - The DB is opened READ-ONLY. The CLI cannot mutate any row.
  - Only \`Database#prepare\` is used. No \`.exec\`, no \`.run\`, no \`.transaction\`.
  - No \`Date.now\`, no \`Math.random\`. The only timestamp surface is --now.
  - Stdout carries the JSON result. Stderr carries the safety banner and
    any warnings (zero-row, partial-not-found).
`;

/** Parse argv into structured options. Pure: no I/O. */
export function parseDumpArgs(argv: readonly string[]): DumpArgsParseResult {
  const args: ParsedDumpArgs = {
    ids: [],
    dbPath: resolveDefaultDumpDbPath(),
    pretty: false,
    includeEvidence: true,
    includeAttestations: true,
    allFields: false,
    statusFilter: null,
    sourceCheck: true,
    now: null,
    showHelp: false,
  };

  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      args.showHelp = true;
    } else if (a.startsWith("--ids=")) {
      const raw = a.slice("--ids=".length);
      const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const p of parts) args.ids.push(p);
    } else if (a.startsWith("--db=")) {
      const v = a.slice("--db=".length).trim();
      if (v.length === 0) {
        return { ok: false, reason: "--db requires a non-empty path" };
      }
      args.dbPath = v;
    } else if (a === "--pretty") {
      args.pretty = true;
    } else if (a === "--include-evidence") {
      args.includeEvidence = true;
    } else if (a === "--no-include-evidence") {
      args.includeEvidence = false;
    } else if (a === "--include-attestations") {
      args.includeAttestations = true;
    } else if (a === "--no-include-attestations") {
      args.includeAttestations = false;
    } else if (a === "--all-fields") {
      args.allFields = true;
    } else if (a.startsWith("--status=")) {
      const v = a.slice("--status=".length).trim();
      if (v.length === 0) {
        return { ok: false, reason: "--status requires a non-empty value" };
      }
      args.statusFilter = v;
    } else if (a === "--source-check") {
      args.sourceCheck = true;
    } else if (a === "--no-source-check") {
      args.sourceCheck = false;
    } else if (a.startsWith("--now=")) {
      const v = a.slice("--now=".length).trim();
      if (v.length === 0) {
        return { ok: false, reason: "--now requires an ISO-8601 timestamp" };
      }
      args.now = v;
    } else {
      return { ok: false, reason: `unknown flag: ${a}` };
    }
  }

  return { ok: true, args };
}

/**
 * Locate the self-recommendations table. We don't hardcode the name — we
 * inspect sqlite_master for any table whose name contains "recommendation"
 * or "rec". We prefer exact matches in this priority order.
 */
export interface SchemaIntrospection {
  allTables: string[];
  candidateTables: string[];
  schemaTable: string | null;
  columns: string[];
  totalRows: number | null;
  dbAbsPath: string;
  dbFileSizeBytes: number | null;
}

const TABLE_PREFERENCE = [
  "selfRecommendations",
  "self_recommendations",
  "recommendations",
];

export function introspectSchema(
  db: Database.Database,
  dbAbsPath: string,
): SchemaIntrospection {
  const allTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const tableNames = allTables.map((r) => r.name);

  const candidateTables = tableNames.filter(
    (n) => /recommendation/i.test(n) || /(^|_)rec(s|$|_)/i.test(n),
  );

  let schemaTable: string | null = null;
  for (const pref of TABLE_PREFERENCE) {
    if (tableNames.includes(pref)) {
      schemaTable = pref;
      break;
    }
  }
  if (schemaTable === null && candidateTables.length > 0) {
    schemaTable = candidateTables[0];
  }

  let columns: string[] = [];
  let totalRows: number | null = null;
  if (schemaTable !== null) {
    // table_info is a pragma — read-only by definition.
    const colRows = db
      .prepare(`PRAGMA table_info(${quoteIdent(schemaTable)})`)
      .all() as Array<{ name: string }>;
    columns = colRows.map((r) => r.name);
    const countRow = db
      .prepare(`SELECT COUNT(*) as n FROM ${quoteIdent(schemaTable)}`)
      .get() as { n: number } | undefined;
    totalRows = countRow?.n ?? 0;
  }

  let dbFileSizeBytes: number | null = null;
  try {
    const st = fs.statSync(dbAbsPath);
    dbFileSizeBytes = st.size;
  } catch {
    dbFileSizeBytes = null;
  }

  return {
    allTables: tableNames,
    candidateTables,
    schemaTable,
    columns,
    totalRows,
    dbAbsPath,
    dbFileSizeBytes,
  };
}

/**
 * Safely quote a SQLite identifier (table or column name) by wrapping in
 * double quotes and escaping any embedded double quote. We only ever apply
 * this to names we read from sqlite_master / PRAGMA — never to user-supplied
 * IDs. User IDs always go through parameterized bindings.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface DumpResult {
  found: Record<string, unknown>[];
  notFound: string[];
  dbPath: string;
  schemaTable: string | null;
  dumpedAt: string | null;
}

/** Parse a JSON string column safely. Returns the original string on parse failure. */
function maybeParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  // Cheap pre-check: only attempt JSON.parse on values that look JSON-ish.
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const head = trimmed[0];
  if (head !== "{" && head !== "[") return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Run the dump against an already-open read-only DB. Pure-ish: only reads
 * from the DB; never writes. Exported for tests.
 */
export function runDump(
  db: Database.Database,
  introspection: SchemaIntrospection,
  args: ParsedDumpArgs,
): DumpResult {
  if (introspection.schemaTable === null) {
    return {
      found: [],
      notFound: [...args.ids],
      dbPath: args.dbPath,
      schemaTable: null,
      dumpedAt: args.now,
    };
  }

  const table = introspection.schemaTable;
  const placeholders = args.ids.map(() => "?").join(", ");
  let sql = `SELECT * FROM ${quoteIdent(table)} WHERE id IN (${placeholders})`;
  const params: unknown[] = [...args.ids];
  if (args.statusFilter !== null) {
    sql += " AND status = ?";
    params.push(args.statusFilter);
  }

  const rawRows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  // Determine which columns to emit.
  const emitColumns = args.allFields
    ? introspection.columns
    : (CURATED_COLUMNS as readonly string[]).filter((c) =>
        introspection.columns.includes(c),
      );

  const shaped: Record<string, unknown>[] = rawRows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of emitColumns) {
      if (col === "evidence" && !args.includeEvidence) continue;
      if (col === "attestations" && !args.includeAttestations) continue;
      if (!(col in row)) continue;
      const raw = row[col];
      out[col] = JSON_COLUMNS.has(col) ? maybeParseJson(raw) : raw;
    }
    return out;
  });

  // Sort the found rows by their position in args.ids for deterministic output.
  const idIndex = new Map<string, number>();
  args.ids.forEach((id, i) => idIndex.set(id, i));
  shaped.sort((a, b) => {
    const ai = idIndex.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER;
    const bi = idIndex.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  const foundIds = new Set<string>(shaped.map((r) => String(r.id)));
  const notFound = args.ids.filter((id) => !foundIds.has(id));

  return {
    found: shaped,
    notFound,
    dbPath: args.dbPath,
    schemaTable: table,
    dumpedAt: args.now,
  };
}

/** Format the introspection banner for stderr. */
export function formatSourceCheckBanner(intro: SchemaIntrospection): string {
  const lines = [
    "[dumpSelfRecs] source-check (read-only):",
    `  dbAbsPath: ${intro.dbAbsPath}`,
    `  dbFileSizeBytes: ${intro.dbFileSizeBytes ?? "(unknown)"}`,
    `  tables: ${intro.allTables.join(", ") || "(none)"}`,
    `  candidateTables: ${intro.candidateTables.join(", ") || "(none)"}`,
    `  schemaTable: ${intro.schemaTable ?? "(none)"}`,
    `  columns: ${intro.columns.join(", ") || "(none)"}`,
    `  totalRows: ${intro.totalRows ?? "(n/a)"}`,
  ];
  return lines.join("\n");
}

interface IoStreams {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
}

interface RunCliDeps {
  argv: readonly string[];
  io: IoStreams;
  /** Factory so tests can inject an in-memory DB. */
  openDb?: (absPath: string) => Database.Database;
}

/**
 * Real entry point. Returns the desired exit code; the caller wires it to
 * `process.exit` in `main()` below. Exported for tests so they can drive
 * the CLI without spawning a subprocess.
 */
export function runDumpSelfRecsCli(deps: RunCliDeps): number {
  const parsed = parseDumpArgs(deps.argv);
  if (!parsed.ok) {
    deps.io.stderr.write(`Error: ${parsed.reason}\n`);
    deps.io.stderr.write("Run with --help for usage.\n");
    return 1;
  }

  const args = parsed.args;
  if (args.showHelp) {
    deps.io.stdout.write(HELP);
    return 0;
  }

  if (args.ids.length === 0) {
    deps.io.stderr.write(
      "Error: --ids is required (comma-separated list of recommendation IDs).\n",
    );
    deps.io.stderr.write("Run with --help for usage.\n");
    return 1;
  }

  const absPath = path.isAbsolute(args.dbPath)
    ? args.dbPath
    : path.resolve(process.cwd(), args.dbPath);

  let db: Database.Database;
  try {
    const opener =
      deps.openDb ?? ((p: string) => new Database(p, { readonly: true }));
    db = opener(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.io.stderr.write(`Error: could not open DB at ${absPath}: ${msg}\n`);
    return 2;
  }

  try {
    const intro = introspectSchema(db, absPath);

    if (args.sourceCheck) {
      deps.io.stderr.write(formatSourceCheckBanner(intro) + "\n");
    }

    if (intro.schemaTable === null) {
      deps.io.stderr.write(
        `Error: could not locate a self-recommendations table in ${absPath}. ` +
          `Tables found: ${intro.allTables.join(", ") || "(none)"}.\n`,
      );
      return 2;
    }
    if (!intro.columns.includes("id")) {
      deps.io.stderr.write(
        `Error: table ${intro.schemaTable} has no 'id' column (got: ${intro.columns.join(", ")}).\n`,
      );
      return 2;
    }

    const result = runDump(db, intro, args);

    const payload = {
      found: result.found,
      notFound: result.notFound,
      dbPath: result.dbPath,
      schemaTable: result.schemaTable,
      dumpedAt: result.dumpedAt,
    };

    const json = args.pretty
      ? JSON.stringify(payload, null, 2)
      : JSON.stringify(payload);
    deps.io.stdout.write(json + "\n");

    if (result.notFound.length > 0) {
      deps.io.stderr.write(
        `[dumpSelfRecs] warning: ${result.notFound.length} of ${args.ids.length} requested ID(s) not found: ${result.notFound.join(", ")}\n`,
      );
      return 3;
    }
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort close on a read-only handle */
    }
  }
}

/* istanbul ignore next — thin entry point */
export function main(): void {
  const exitCode = runDumpSelfRecsCli({
    argv: process.argv.slice(2),
    io: { stdout: process.stdout, stderr: process.stderr },
  });
  process.exit(exitCode);
}

// Direct-invocation guard. We support two live entry points:
//   1. Bundled CJS via esbuild → `node dist/dumpSelfRecs.cjs`.
//   2. ESM direct via tsx     → `tsx scripts/dumpSelfRecs.ts`.
// In every other case (import for tests, library reuse) we MUST NOT call
// main() because doing so would call process.exit() in the test runner.
//
// The guard compares process.argv[1] (the script Node was actually told to
// run) to either this file's path (under ESM via tsx) or the bundle's
// expected basenames (under bundled CJS). The basename check is sufficient
// because the only known callers in either entry mode pass an absolute or
// resolvable path whose final segment matches one of these names.
function isDirectInvocation(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const base = path.basename(argv1);
  if (base === "dumpSelfRecs.cjs" || base === "dumpSelfRecs.ts") return true;
  // Fallback: ESM-aware path comparison via import.meta.url when available.
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
