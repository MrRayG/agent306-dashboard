#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 3a-prep ATTESTATION ATTACHMENT CLI
 *
 * Reads the per-rec `Phase3aPrepCandidate` JSON files under
 * `scripts/phase3aPrepCandidates/` and appends them as
 * `phase3aPrepCandidate:<JSON>` markers to the `evidence` JSON-array column
 * of the matching rows in the `self_recommendations` SQLite table.
 *
 * Default behaviour: DRY-RUN. The CLI prints exactly what it would do and
 * writes nothing. `--apply` is the only switch that performs writes.
 *
 *   tsx scripts/attachPhase3aPrepAttestations.ts                # dry-run
 *   tsx scripts/attachPhase3aPrepAttestations.ts --apply        # writes
 *   node dist/attachPhase3aPrepAttestations.cjs --apply         # prod
 *
 * Hard rules:
 *   - DRY-RUN BY DEFAULT. Writes happen ONLY when `--apply` is passed.
 *   - IDEMPOTENT. If a rec's evidence array already contains a
 *     `phase3aPrepCandidate:` marker, the CLI skips that rec (it does NOT
 *     append a duplicate).
 *   - BACKUP-THEN-MUTATE. Before any write, the CLI snapshots every
 *     affected row to `/tmp/self_recs_backup_<timestamp>.json` so the
 *     prior state is recoverable even if the SQLite WAL is corrupted.
 *   - PARAMETERIZED. The only write is a single UPDATE per rec using
 *     `Database#prepare(...).run(evidenceJson, id)` — IDs are bound,
 *     never string-interpolated.
 *   - NARROW MUTATION. Only the `evidence` column is mutated. No other
 *     field (status, appliedAt, approvedAt, etc.) is touched. The CLI
 *     does NOT call the apply endpoint and does NOT change status.
 *   - DB PATH. The CLI reads `RAILWAY_VOLUME_MOUNT_PATH` (Railway sets
 *     this to the volume mount root) and falls back to `/data`. Within
 *     that directory the CLI uses `agent306.db`. This deliberately
 *     differs from the dump CLI's `research_lab.db` default, which is a
 *     known historical bug in `scripts/dumpSelfRecs.ts` (#415).
 *   - `--db=<path>` overrides the default for local testing.
 *
 * Exit codes:
 *   0 = success (dry-run printed plan, OR --apply wrote N rows OR all
 *       rows were already idempotently up to date)
 *   1 = CLI usage / argument error
 *   2 = DB / candidates dir not readable / schema mismatch
 *   3 = at least one candidate ID is missing from the DB (partial-success
 *       warning; dry-run still completes)
 *
 * Out-of-scope:
 *   - Does NOT call the apply endpoint.
 *   - Does NOT flip any env var.
 *   - Does NOT modify selfRecommendationEngine.ts, promotionGate.ts, or
 *     the phase3aPrepHarness.
 *   - Does NOT call `gh pr merge`. Open the PR via `gh pr create` and
 *     wait for human review.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ParsedAttachArgs {
  dbPath: string;
  candidatesDir: string;
  apply: boolean;
  pretty: boolean;
  showHelp: boolean;
  /** Optional: pin a deterministic backup-file basename for tests. */
  backupBasename: string | null;
}

export interface AttachArgsParseError { ok: false; reason: string; }
export interface AttachArgsParseOk    { ok: true; args: ParsedAttachArgs; }
export type AttachArgsParseResult = AttachArgsParseOk | AttachArgsParseError;

const DEFAULT_DB_BASENAME = "agent306.db";
const DEFAULT_VOLUME_MOUNT = "/data";
const PHASE3A_PREP_EVIDENCE_PREFIX = "phase3aPrepCandidate:";

const HELP = `Phase 3a-prep attestation attachment CLI (DRY-RUN by default)

usage (local dev, tsx available):
  tsx scripts/attachPhase3aPrepAttestations.ts                 # dry-run
  tsx scripts/attachPhase3aPrepAttestations.ts --pretty        # dry-run + indented JSON
  tsx scripts/attachPhase3aPrepAttestations.ts --apply         # PERFORMS WRITES
  tsx scripts/attachPhase3aPrepAttestations.ts --db=/tmp/test.db --apply

usage (Railway SSH, tsx pruned — use the bundled CJS):
  node dist/attachPhase3aPrepAttestations.cjs                  # dry-run
  node dist/attachPhase3aPrepAttestations.cjs --apply          # PERFORMS WRITES

flags:
  --apply                Actually mutate the database. Without this flag the
                         CLI prints exactly what it WOULD do and exits 0.
                         Writes are gated behind this flag — there is no
                         shorthand. Default: OFF.
  --db=PATH              Absolute path to the SQLite DB. Default:
                         \$RAILWAY_VOLUME_MOUNT_PATH/agent306.db (with
                         fallback to /data/agent306.db).
  --candidates-dir=PATH  Directory containing <rec_id>.json files. Default:
                         scripts/phase3aPrepCandidates/ relative to cwd.
  --pretty               Pretty-print the JSON plan / outcome (2-space).
  --backup-basename=NAME Override the backup-file basename. Default:
                         self_recs_backup_<unix-ms>.json. Useful for tests.
  -h, --help             Show this message.

exit codes:
  0  dry-run completed OR --apply wrote N rows (including zero already-idempotent)
  1  CLI usage / argument error
  2  DB / candidates dir not readable / table missing / schema mismatch
  3  one or more candidate IDs missing from the DB (warning)

safety:
  - DRY-RUN by default. Writes require --apply.
  - The only mutation is appending one phase3aPrepCandidate:<JSON> entry to
    the evidence JSON array of each matching rec. If a marker is already
    present, the rec is skipped (idempotent).
  - A snapshot of every affected row is written to /tmp/self_recs_backup_
    <timestamp>.json BEFORE any UPDATE runs.
  - The CLI uses Database#prepare(...).run(...) with bound parameters only.
  - The CLI does NOT call the apply endpoint, does NOT change status, does
    NOT flip env vars, and does NOT touch any column other than evidence.
`;

/** Parse argv into structured options. Pure. */
export function parseAttachArgs(argv: readonly string[]): AttachArgsParseResult {
  const args: ParsedAttachArgs = {
    dbPath: "",
    candidatesDir: "",
    apply: false,
    pretty: false,
    showHelp: false,
    backupBasename: null,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      args.showHelp = true;
    } else if (a === "--apply") {
      args.apply = true;
    } else if (a === "--pretty") {
      args.pretty = true;
    } else if (a.startsWith("--db=")) {
      const v = a.slice("--db=".length).trim();
      if (v.length === 0) return { ok: false, reason: "--db requires a non-empty path" };
      args.dbPath = v;
    } else if (a.startsWith("--candidates-dir=")) {
      const v = a.slice("--candidates-dir=".length).trim();
      if (v.length === 0) return { ok: false, reason: "--candidates-dir requires a non-empty path" };
      args.candidatesDir = v;
    } else if (a.startsWith("--backup-basename=")) {
      const v = a.slice("--backup-basename=".length).trim();
      if (v.length === 0) return { ok: false, reason: "--backup-basename requires a non-empty value" };
      args.backupBasename = v;
    } else {
      return { ok: false, reason: `unknown flag: ${a}` };
    }
  }
  return { ok: true, args };
}

/** Resolve the default DB path. RAILWAY_VOLUME_MOUNT_PATH || /data, then
 *  append agent306.db. Exported for tests. */
export function resolveDefaultDbPath(env: NodeJS.ProcessEnv): string {
  const root = env.RAILWAY_VOLUME_MOUNT_PATH && env.RAILWAY_VOLUME_MOUNT_PATH.length > 0
    ? env.RAILWAY_VOLUME_MOUNT_PATH
    : DEFAULT_VOLUME_MOUNT;
  return path.join(root, DEFAULT_DB_BASENAME);
}

export function resolveDefaultCandidatesDir(cwd: string): string {
  return path.join(cwd, "scripts", "phase3aPrepCandidates");
}

export interface LoadedCandidate {
  recId:        string;
  filePath:     string;
  rawJson:      string;   // pre-stringified payload (no whitespace) for the marker
  parsed:       Record<string, unknown>;
}

/** Read every <rec_id>.json file under candidatesDir and return a list of
 *  loaded candidates. The CLI does NOT validate the inner shape here — the
 *  promotion gate's adapter (`server/eval/phase3aPrepAttestation.ts`) is
 *  the single source of validation truth, and operators have already
 *  verified each candidate via `runManualPhase3aPrepEvaluation.ts`. The
 *  CLI rejects files whose top-level `candidateId` does not match the
 *  filename basename — that catches accidental renames. */
export function loadCandidates(candidatesDir: string): LoadedCandidate[] {
  if (!fs.existsSync(candidatesDir)) {
    throw new Error(`candidates directory not found: ${candidatesDir}`);
  }
  const entries = fs
    .readdirSync(candidatesDir)
    .filter((n) => n.startsWith("rec_") && n.endsWith(".json"))
    .sort();
  const out: LoadedCandidate[] = [];
  for (const name of entries) {
    const filePath = path.join(candidatesDir, name);
    const raw = fs.readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`candidate ${name} is not valid JSON: ${(e as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`candidate ${name} must contain a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    const expectedId = name.replace(/\.json$/, "");
    if (obj.candidateId !== expectedId) {
      throw new Error(
        `candidate ${name}: candidateId ${JSON.stringify(obj.candidateId)} does not match filename basename ${JSON.stringify(expectedId)}`,
      );
    }
    // Compact JSON for the marker payload (one line, no spaces) so the
    // evidence array stays compact in the DB.
    const compact = JSON.stringify(obj);
    out.push({ recId: expectedId, filePath, rawJson: compact, parsed: obj });
  }
  return out;
}

/** Parse a self_recommendations row's evidence column into a string array.
 *  Mirrors `parseEvidence` in `server/selfRecommendationEngine.ts` without
 *  importing it (this CLI must bundle without pulling in the server). */
export function parseEvidenceColumn(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface RecPlan {
  recId:             string;
  filePath:          string;
  /** True iff a row with this id exists in the DB. */
  rowExists:         boolean;
  /** Evidence array as currently stored on the row (empty if no row). */
  currentEvidence:   string[];
  /** True iff currentEvidence already contains a phase3aPrepCandidate: marker. */
  alreadyAttested:   boolean;
  /** The new evidence array we would write (empty if rowExists=false or alreadyAttested). */
  newEvidence:       string[] | null;
  /** Action label: "missing" | "skip-already-attested" | "attach". */
  action:            "missing" | "skip-already-attested" | "attach";
}

export interface PlanOutput {
  dbPath:           string;
  candidatesDir:    string;
  apply:            boolean;
  backupPath:       string | null;
  rowsToAttach:     number;
  rowsAlreadyAttested: number;
  rowsMissing:      number;
  rowsWritten:      number;
  plans:            RecPlan[];
}

/** Build a per-rec plan. Pure: only reads, no writes. */
export function buildPlans(
  db: Database.Database,
  candidates: readonly LoadedCandidate[],
): RecPlan[] {
  const selectStmt = db.prepare(
    "SELECT id, evidence FROM self_recommendations WHERE id = ?",
  );
  const plans: RecPlan[] = [];
  for (const cand of candidates) {
    const row = selectStmt.get(cand.recId) as
      | { id: string; evidence: string }
      | undefined;
    if (row === undefined) {
      plans.push({
        recId:           cand.recId,
        filePath:        cand.filePath,
        rowExists:       false,
        currentEvidence: [],
        alreadyAttested: false,
        newEvidence:     null,
        action:          "missing",
      });
      continue;
    }
    const currentEvidence = parseEvidenceColumn(row.evidence);
    const alreadyAttested = currentEvidence.some((e) =>
      e.startsWith(PHASE3A_PREP_EVIDENCE_PREFIX),
    );
    if (alreadyAttested) {
      plans.push({
        recId:           cand.recId,
        filePath:        cand.filePath,
        rowExists:       true,
        currentEvidence,
        alreadyAttested: true,
        newEvidence:     null,
        action:          "skip-already-attested",
      });
      continue;
    }
    const marker = PHASE3A_PREP_EVIDENCE_PREFIX + cand.rawJson;
    plans.push({
      recId:           cand.recId,
      filePath:        cand.filePath,
      rowExists:       true,
      currentEvidence,
      alreadyAttested: false,
      newEvidence:     [...currentEvidence, marker],
      action:          "attach",
    });
  }
  return plans;
}

export interface IoStreams {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
}

export interface RunCliDeps {
  argv: readonly string[];
  io: IoStreams;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Factory so tests can inject an in-memory DB. */
  openDb?: (absPath: string, readonly: boolean) => Database.Database;
  /** Source of the backup timestamp. Tests pin this. */
  now?: () => number;
  /** fs override for tests. */
  writeBackupFile?: (absPath: string, contents: string) => void;
}

/** Run the CLI. Returns the exit code. */
export function runAttachCli(deps: RunCliDeps): number {
  const parsed = parseAttachArgs(deps.argv);
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

  const dbPath = args.dbPath.length > 0
    ? args.dbPath
    : resolveDefaultDbPath(deps.env);
  const candidatesDir = args.candidatesDir.length > 0
    ? args.candidatesDir
    : resolveDefaultCandidatesDir(deps.cwd);

  let candidates: LoadedCandidate[];
  try {
    candidates = loadCandidates(candidatesDir);
  } catch (e) {
    deps.io.stderr.write(`Error: ${(e as Error).message}\n`);
    return 2;
  }
  if (candidates.length === 0) {
    deps.io.stderr.write(
      `Error: no candidate files (rec_*.json) found in ${candidatesDir}\n`,
    );
    return 2;
  }

  // Open DB. Read-only when no --apply; read-write only when --apply.
  let db: Database.Database;
  const opener = deps.openDb
    ?? ((p: string, ro: boolean) => new Database(p, { readonly: ro }));
  try {
    db = opener(dbPath, !args.apply);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.io.stderr.write(`Error: could not open DB at ${dbPath}: ${msg}\n`);
    return 2;
  }

  let exitCode = 0;
  let backupPath: string | null = null;
  let rowsWritten = 0;
  try {
    // Confirm table exists.
    const tableRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='self_recommendations'",
      )
      .get();
    if (tableRow === undefined) {
      deps.io.stderr.write(
        `Error: self_recommendations table not found in ${dbPath}\n`,
      );
      return 2;
    }

    const plans = buildPlans(db, candidates);
    const toAttach    = plans.filter((p) => p.action === "attach");
    const skipped     = plans.filter((p) => p.action === "skip-already-attested");
    const missing     = plans.filter((p) => p.action === "missing");

    if (missing.length > 0) {
      deps.io.stderr.write(
        `[attachPhase3aPrepAttestations] warning: ${missing.length} candidate id(s) not found in DB: ${missing.map((m) => m.recId).join(", ")}\n`,
      );
      exitCode = 3;
    }

    if (args.apply && toAttach.length > 0) {
      // Build backup payload from the CURRENT rows that we will mutate.
      const ts = (deps.now ?? Date.now)();
      const backupName = args.backupBasename ?? `self_recs_backup_${ts}.json`;
      backupPath = `/tmp/${backupName}`;
      const backupRows: Array<{ id: string; evidence: string; evidenceParsed: string[] }> = [];
      const fetchRow = db.prepare("SELECT id, evidence FROM self_recommendations WHERE id = ?");
      for (const p of toAttach) {
        const row = fetchRow.get(p.recId) as { id: string; evidence: string } | undefined;
        if (row !== undefined) {
          backupRows.push({
            id: row.id,
            evidence: row.evidence,
            evidenceParsed: parseEvidenceColumn(row.evidence),
          });
        }
      }
      const backupPayload = {
        backupAt:       new Date(ts).toISOString(),
        dbPath,
        affectedRowCount: backupRows.length,
        rows:           backupRows,
      };
      const backupJson = JSON.stringify(backupPayload, null, 2);
      const writer = deps.writeBackupFile
        ?? ((p: string, c: string) => fs.writeFileSync(p, c));
      try {
        writer(backupPath, backupJson);
      } catch (e) {
        deps.io.stderr.write(
          `Error: failed to write backup to ${backupPath}: ${(e as Error).message}\n`,
        );
        return 2;
      }
      deps.io.stderr.write(`[attachPhase3aPrepAttestations] backup written: ${backupPath} (${backupRows.length} rows)\n`);

      // Single UPDATE per rec, parameterized.
      const updateStmt = db.prepare(
        "UPDATE self_recommendations SET evidence = ? WHERE id = ?",
      );
      const txn = db.transaction((items: RecPlan[]) => {
        for (const p of items) {
          if (p.newEvidence === null) continue;
          updateStmt.run(JSON.stringify(p.newEvidence), p.recId);
          rowsWritten += 1;
        }
      });
      try {
        txn(toAttach);
      } catch (e) {
        deps.io.stderr.write(
          `Error: UPDATE failed: ${(e as Error).message}. Backup preserved at ${backupPath}.\n`,
        );
        return 2;
      }
      deps.io.stderr.write(`[attachPhase3aPrepAttestations] applied ${rowsWritten} rows\n`);
    }

    const output: PlanOutput = {
      dbPath,
      candidatesDir,
      apply: args.apply,
      backupPath,
      rowsToAttach:        toAttach.length,
      rowsAlreadyAttested: skipped.length,
      rowsMissing:         missing.length,
      rowsWritten,
      plans,
    };
    const json = args.pretty
      ? JSON.stringify(output, null, 2)
      : JSON.stringify(output);
    deps.io.stdout.write(json + "\n");

    if (!args.apply) {
      deps.io.stderr.write(
        "[attachPhase3aPrepAttestations] DRY-RUN only — no rows written. Pass --apply to persist.\n",
      );
    }
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }

  return exitCode;
}

export function main(): void {
  const exitCode = runAttachCli({
    argv: process.argv.slice(2),
    io:   { stdout: process.stdout, stderr: process.stderr },
    env:  process.env,
    cwd:  process.cwd(),
  });
  process.exit(exitCode);
}

// Direct-invocation guard. Mirrors `scripts/dumpSelfRecs.ts`.
function isDirectInvocation(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const base = path.basename(argv1);
  if (base === "attachPhase3aPrepAttestations.cjs" || base === "attachPhase3aPrepAttestations.ts") {
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
