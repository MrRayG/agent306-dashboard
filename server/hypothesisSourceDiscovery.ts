/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS SOURCE DISCOVERY (READ-ONLY)
 *
 * Single source of truth for "where does the hypothesis store live and what
 * did we actually load?". The Hypothesis Reset Report, the Hypothesis Intake
 * Audit Visibility block, and the CLI all share this module so they cannot
 * disagree about what was attempted, what exists, and what was read.
 *
 * Production-incident motivation: the operator ran the reset CLI in
 * production, got back "Source: /data/research_lab.json (exists=false),
 * Records: 0, all buckets zero" — yet the Autonomy Monitor saw 32
 * memory-origin hypothesis-titled entries in `memory_knowledge.json` AND the
 * Research Lab / Agent HQ panels reported 400+ hypotheses. The previous
 * iteration of this module looked only at JSON files; it could not see the
 * production state because, post-migration, `research_lab.json` is renamed to
 * `research_lab.json.bak` and the canonical store moves into the
 * `research_lab` row inside the SQLite DB (`<DATA_DIR>/agent306.db` by
 * default, overridable with `DB_PATH`). This is exactly where
 * `getResearchLab()` (and therefore the Research Lab / HQ APIs that surface
 * the ~451 count) reads from. Discovery now mirrors the same lookup order so
 * the dashboard, the CLI, and the runtime cannot disagree about where the
 * formal store is or how many records it holds.
 *
 * Hard invariants:
 *   - READ-ONLY. Every read is wrapped in try/catch; missing files yield
 *     `exists:false` rather than throwing. The DB probe opens in
 *     `readonly: true, fileMustExist: true` mode and never creates tables
 *     or runs migrations.
 *   - DETERMINISTIC. Given the same DATA_DIR + DB_PATH + on-disk state,
 *     output is byte-stable. Tests pin this.
 *   - NO-WIDENING. No new API, no new auth, no scheduler. The override knobs
 *     (`sourcePath`, `dataDir`) are operator-only and reach this module via
 *     the CLI or an explicit test injection; runtime callers pass nothing
 *     and get the production behaviour.
 *   - NO SCANNING. We try a small, hard-coded list of canonical paths under
 *     DATA_DIR plus the canonical SQLite DB. We do NOT walk the disk or
 *     auto-discover legacy stores.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { DATA_DIR, dataPath } from "./dataPaths.js";
import type { HygieneAwareHypothesis } from "./hypothesisHygiene.js";
import {
  isMemoryHypothesisEntry,
  type MemoryKnowledgeEntry,
  type MemoryKnowledgeFile,
} from "./memoryHypothesisHygiene.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AttemptedPath {
  /** Absolute path checked. */
  path:        string;
  /** Whether the file existed at that path. */
  exists:      boolean;
  /** Was the file readable as JSON? */
  readable:    boolean;
  /** Records loaded from that file. 0 when missing or malformed. */
  records:     number;
  /** Human-readable label for the role this path plays. */
  role:        "formal" | "memory" | "legacy-candidate" | "db";
  /** Set when JSON.parse threw. Operator-facing message. */
  parseError?: string;
}

/** One non-formal source whose hypothesis-count is surfaced for visibility
 *  but is NEVER eligible for CLI archive. Used to reconcile the "Research
 *  Lab/HQ reports 400+ but reset says 0" mismatch by enumerating every
 *  place a hypothesis-shaped count can come from. */
export interface OtherSourceObservation {
  /** Stable key for UI / JSON consumers. */
  key:    string;
  /** Human-readable label. */
  label:  string;
  /** Origin description for operator. */
  origin: "db_research_lab" | "research_lab_json_bak" | "research_lab_backup_json" | "memory_knowledge_hypothesis_entries";
  /** Number of records observed. 0 when missing/unreadable. */
  count:  number;
  /** Absolute path/locator the observation came from. */
  locator: string;
  /** Whether the locator was reachable. */
  available: boolean;
  /** Why this source cannot be applied by the reset CLI today. */
  notApplyableReason: string;
  /** Optional error context when unreachable. */
  error?: string;
}

export interface SourceDiscoveryDiagnostics {
  /** DATA_DIR the discovery used. */
  dataDir:              string;
  /** Path the operator overrode with `--source=…`, if any. */
  sourceOverride:       string | null;
  /** Ordered list of paths tried for the formal hypothesis store. */
  formalAttempts:       AttemptedPath[];
  /** Path the discovery ultimately consumed for the formal store. NULL if
   *  no candidate yielded a parseable file. */
  formalChosen:         string | null;
  /** Count of formal hypotheses actually loaded. */
  formalRecords:        number;
  /** Memory knowledge path checked. Always under DATA_DIR. */
  memoryAttempt:        AttemptedPath;
  /** Count of memory-origin hypothesis-titled entries detected. */
  memoryHypothesisCount: number;
  /** Operator-facing "what to do next" — text only. The CLI prints it when
   *  the formal store is empty so the operator can fix DATA_DIR / point
   *  --source somewhere real before re-running. */
  nextSafeAction:       string;
  /** Hard-coded list of candidate legacy paths we know about. Surfaces to
   *  the dashboard so an operator can spot a misplaced store. We DO NOT
   *  scan the filesystem — the list is closed. */
  knownCandidates:      Array<{ path: string; rationale: string }>;
  /** Per-source observations from every known hypothesis-count origin (DB
   *  row, .bak file, .backup.json, memory_knowledge). Used by the dashboard
   *  and CLI to reconcile the Research Lab/HQ ~451 count vs Phase 2
   *  formal=0 / memory-origin=32 split. */
  otherSources:         OtherSourceObservation[];
  /** Plain-text reconciliation describing the count mismatch between the
   *  formal-chosen source and every OTHER source that observed records.
   *  Empty list when nothing else has records. */
  countReconciliation:  string[];
}

export interface DiscoveredSource {
  diagnostics: SourceDiscoveryDiagnostics;
  /** Formal hypothesis rows loaded — possibly empty. */
  formalHypotheses: HygieneAwareHypothesis[];
  /** Raw memory knowledge file (or null). */
  memoryFile: MemoryKnowledgeFile | null;
  /** Memory-origin hypothesis-titled entries detected. */
  memoryHypothesisEntries: MemoryKnowledgeEntry[];
}

// ── Hard-coded legacy candidate list ────────────────────────────────────────
//
// We do NOT walk the filesystem. We do NOT auto-discover. These are the only
// alternative locations the audit knows about. Operators who need to point
// the CLI at a non-standard store must use `--source=<abs path>`.

const LEGACY_CANDIDATE_FILENAMES: ReadonlyArray<{ filename: string; rationale: string }> = Object.freeze([
  {
    filename: "research_lab.json",
    rationale: "canonical formal hypothesis store (pre-migration)",
  },
  {
    filename: "research_lab.backup.json",
    rationale: "operator-staged backup (NOT auto-promoted, surfaced for visibility only)",
  },
]);

/** Extra paths surfaced in the dashboard `knownCandidates` list so the
 *  operator can see them at a glance, even though they are NEVER auto-picked
 *  as the formal-chosen source (they are observed via `otherSources` and only
 *  promoted to formal-chosen via `--source`). */
const KNOWN_OBSERVATION_FILENAMES: ReadonlyArray<{ filename: string; rationale: string }> = Object.freeze([
  {
    filename: "research_lab.json.bak",
    rationale: "post-migration sibling — scripts/migrate_json_to_db.ts renames research_lab.json to .bak after importing into the DB row. Read by jsonFallback.readJsonWithBakFallback when the DB row is unavailable. Observation only.",
  },
]);

/** Canonical SQLite DB locator (mirrors server/db.ts). DB_PATH wins when set;
 *  otherwise the DB sits next to the JSON state under DATA_DIR. */
function resolveDbPath(dataDir: string): string {
  return process.env.DB_PATH && process.env.DB_PATH.length > 0
    ? path.resolve(process.env.DB_PATH)
    : path.join(dataDir, "agent306.db");
}

/** Probe the `research_lab` row in the SQLite DB read-only. Never creates
 *  tables, never runs migrations, never writes. Returns the parsed blob and
 *  the hypothesis count when reachable. */
function probeDbResearchLab(dbPath: string): {
  available:   boolean;
  records:     number;
  hypotheses:  HygieneAwareHypothesis[] | null;
  error?:      string;
} {
  if (!fs.existsSync(dbPath)) {
    return { available: false, records: 0, hypotheses: null, error: "db file does not exist" };
  }
  let handle: Database.Database | null = null;
  try {
    handle = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Confirm the table exists before SELECTing — older / partially-migrated
    // DBs may not have research_lab yet.
    const tbl = handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_lab'")
      .get() as { name?: string } | undefined;
    if (!tbl || !tbl.name) {
      return { available: false, records: 0, hypotheses: null, error: "research_lab table not present" };
    }
    const row = handle
      .prepare("SELECT blob FROM research_lab WHERE id = ?")
      .get("main") as { blob?: string } | undefined;
    if (!row || typeof row.blob !== "string" || row.blob.length === 0) {
      return { available: true, records: 0, hypotheses: [], error: undefined };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.blob);
    } catch (e: any) {
      return { available: true, records: 0, hypotheses: null, error: `db blob parse error: ${e?.message ?? String(e)}` };
    }
    const hyps = (parsed && typeof parsed === "object" && Array.isArray((parsed as ResearchLabBlob).hypotheses))
      ? ((parsed as ResearchLabBlob).hypotheses as HygieneAwareHypothesis[])
      : [];
    return { available: true, records: hyps.length, hypotheses: hyps };
  } catch (e: any) {
    return { available: false, records: 0, hypotheses: null, error: `db open failed: ${e?.message ?? String(e)}` };
  } finally {
    try { handle?.close(); } catch { /* ignore */ }
  }
}

// ── Defensive readers ───────────────────────────────────────────────────────

interface ResearchLabBlob {
  hypotheses?: HygieneAwareHypothesis[];
}

function readJsonSafe(p: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!fs.existsSync(p)) return { ok: false, reason: "does not exist" };
  try {
    const text = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch (e: any) {
    return { ok: false, reason: `parse error: ${e?.message ?? String(e)}` };
  }
}

function countHypothesesIn(parsed: unknown): number {
  if (parsed && typeof parsed === "object") {
    const hyps = (parsed as ResearchLabBlob).hypotheses;
    if (Array.isArray(hyps)) return hyps.length;
  }
  return 0;
}

function loadFormalCandidate(p: string, role: AttemptedPath["role"]): {
  attempt: AttemptedPath;
  hypotheses: HygieneAwareHypothesis[] | null;
} {
  const exists = fs.existsSync(p);
  if (!exists) {
    return {
      attempt: { path: p, exists: false, readable: false, records: 0, role },
      hypotheses: null,
    };
  }
  const r = readJsonSafe(p);
  if (!r.ok) {
    return {
      attempt: { path: p, exists: true, readable: false, records: 0, role, parseError: r.reason },
      hypotheses: null,
    };
  }
  const hyps = (r.value && typeof r.value === "object" && Array.isArray((r.value as ResearchLabBlob).hypotheses))
    ? ((r.value as ResearchLabBlob).hypotheses as HygieneAwareHypothesis[])
    : [];
  return {
    attempt: { path: p, exists: true, readable: true, records: hyps.length, role },
    hypotheses: hyps,
  };
}

function loadMemoryFile(p: string): { attempt: AttemptedPath; file: MemoryKnowledgeFile | null; hypEntries: MemoryKnowledgeEntry[] } {
  const exists = fs.existsSync(p);
  if (!exists) {
    return {
      attempt: { path: p, exists: false, readable: false, records: 0, role: "memory" },
      file: null,
      hypEntries: [],
    };
  }
  const r = readJsonSafe(p);
  if (!r.ok) {
    return {
      attempt: { path: p, exists: true, readable: false, records: 0, role: "memory", parseError: r.reason },
      file: null,
      hypEntries: [],
    };
  }
  const file = (r.value && typeof r.value === "object") ? (r.value as MemoryKnowledgeFile) : null;
  const entries = Array.isArray(file?.entries) ? file!.entries! : [];
  const hyp = entries.filter(isMemoryHypothesisEntry);
  return {
    attempt: { path: p, exists: true, readable: true, records: entries.length, role: "memory" },
    file,
    hypEntries: hyp,
  };
}

// ── Public entry point ──────────────────────────────────────────────────────

export interface DiscoverSourcesOptions {
  /** Absolute path to a formal-store JSON file. Bypasses the candidate list
   *  entirely. Operator-only; never passed by runtime callers. */
  sourcePath?: string;
  /** Override DATA_DIR for the lookup. Resolves all relative paths against
   *  this directory. Operator-only. */
  dataDir?:    string;
}

function resolveDataDir(opts: DiscoverSourcesOptions): string {
  if (opts.dataDir && opts.dataDir.length > 0) return path.resolve(opts.dataDir);
  return DATA_DIR;
}

function buildKnownCandidates(dir: string): Array<{ path: string; rationale: string }> {
  const out: Array<{ path: string; rationale: string }> = [];
  for (const c of LEGACY_CANDIDATE_FILENAMES) {
    out.push({ path: path.join(dir, c.filename), rationale: c.rationale });
  }
  for (const c of KNOWN_OBSERVATION_FILENAMES) {
    out.push({ path: path.join(dir, c.filename), rationale: c.rationale });
  }
  out.push({
    path: resolveDbPath(dir),
    rationale: "SQLite DB row at research_lab[id='main'] — canonical post-migration formal store. Powers getResearchLab() and the Research Lab / Agent HQ panels.",
  });
  return out;
}

function nextSafeActionFor(
  diagnostics: Pick<
    SourceDiscoveryDiagnostics,
    "formalChosen" | "formalRecords" | "memoryHypothesisCount" | "dataDir" | "knownCandidates" | "sourceOverride" | "formalAttempts" | "otherSources"
  >,
): string {
  if (diagnostics.formalRecords > 0) {
    const chosenAttempt = diagnostics.formalAttempts.find(a => a.path === diagnostics.formalChosen);
    if (chosenAttempt && chosenAttempt.role === "db") {
      return (
        `Formal store was DISCOVERED from the SQLite DB row (${diagnostics.formalChosen}) — ` +
        `${diagnostics.formalRecords} hypotheses. This matches what Research Lab / Agent HQ panels read. ` +
        `--apply is supported for this source but ONLY for the safe archive buckets ` +
        `(archive_stale, archive_data_unavailable, archive_duplicate) and ONLY when the operator passes ` +
        `--confirm-source=db on the CLI. The DB blob is snapshotted to ` +
        `data/hypothesis_reset_db_backup_<iso>.json before any write. Promotion (memory→formal) and the ` +
        `rewrite_* / needs_operator_review buckets remain hard-refused.`
      );
    }
    return "Formal hypothesis store loaded — operator may review buckets and apply archive-safe buckets via --apply.";
  }
  if (diagnostics.sourceOverride && diagnostics.formalAttempts.some(a => a.path === diagnostics.sourceOverride && a.exists && !a.readable)) {
    return (
      `--source=${diagnostics.sourceOverride} exists but could not be parsed as JSON. ` +
      `Operator should validate the file (\`node -e 'JSON.parse(require("fs").readFileSync(...))'\`) before re-running.`
    );
  }
  if (diagnostics.sourceOverride && diagnostics.formalAttempts.some(a => a.path === diagnostics.sourceOverride && !a.exists)) {
    return (
      `--source=${diagnostics.sourceOverride} does not exist. ` +
      `Operator should confirm the path or omit --source to fall back to DATA_DIR=${diagnostics.dataDir}.`
    );
  }
  // When formal is empty but the runtime store (DB row, .bak, .backup.json)
  // has records, the operator most likely hit a discovery-misconfiguration:
  // the live runtime is reading from the DB/.bak (which is what powers the
  // Research Lab / Agent HQ "451 hypotheses" panel) while the CLI was trying
  // a JSON path that no longer exists. Make this the dominant hint.
  const dbObs = diagnostics.otherSources.find(s => s.origin === "db_research_lab" && s.count > 0);
  const bakObs = diagnostics.otherSources.find(s => s.origin === "research_lab_json_bak" && s.count > 0);
  const backupObs = diagnostics.otherSources.find(s => s.origin === "research_lab_backup_json" && s.count > 0);
  if (dbObs || bakObs || backupObs) {
    const parts: string[] = [];
    parts.push(`No --source / research_lab.json under DATA_DIR=${diagnostics.dataDir} returned records.`);
    if (dbObs) {
      parts.push(
        `The SQLite DB row at ${dbObs.locator} reports ${dbObs.count} hypotheses — ` +
        `this is what powers the Research Lab / Agent HQ panels (getResearchLab → readResearchBlob → DB).`,
      );
    }
    if (bakObs) {
      parts.push(`Sibling ${bakObs.locator} reports ${bakObs.count} hypotheses (post-migration .bak fallback).`);
    }
    if (backupObs) {
      parts.push(`Operator-staged ${backupObs.locator} reports ${backupObs.count} hypotheses.`);
    }
    parts.push(
      `--apply is REFUSED until discovery and the runtime apply path agree on the same store. ` +
      `Operator can re-run with --source=<path> pointing at the source they want to classify, ` +
      `or run the migration (scripts/migrate_json_to_db.ts) so the formal store re-syncs with the DB row.`,
    );
    return parts.join(" ");
  }
  if (diagnostics.memoryHypothesisCount > 0) {
    return (
      `No formal research_lab.json found under DATA_DIR=${diagnostics.dataDir}. ` +
      `${diagnostics.memoryHypothesisCount} memory-origin hypothesis-titled entries are reported under the ` +
      `promote_later_memory_origin bucket so the operator can plan promotion. ` +
      `If a formal store exists elsewhere, re-run with --source=<absolute path> or set DATA_DIR. ` +
      `--apply is REFUSED while the formal store is empty (memory-origin promotion is operator-only and out of scope for this CLI).`
    );
  }
  return (
    `No formal research_lab.json under DATA_DIR=${diagnostics.dataDir} and no memory-origin entries detected. ` +
    `Operator should verify DATA_DIR points at the production volume (Railway mounts /data) and re-run.`
  );
}

function buildCountReconciliation(
  formalChosen: string | null,
  formalRecords: number,
  memoryHypothesisCount: number,
  otherSources: OtherSourceObservation[],
): string[] {
  const out: string[] = [];
  const observed: Array<{ label: string; count: number }> = [];
  observed.push({
    label: formalChosen
      ? `Formal chosen (${formalChosen})`
      : `Formal chosen (none — no parseable formal store)`,
    count: formalRecords,
  });
  for (const s of otherSources) {
    observed.push({ label: `${s.label} (${s.locator})`, count: s.count });
  }
  observed.push({ label: "Memory-origin Hypothesis: entries (memory_knowledge.json)", count: memoryHypothesisCount });

  const nonZero = observed.filter(o => o.count > 0);
  if (nonZero.length === 0) {
    out.push("No hypothesis records observed in any known source.");
    return out;
  }
  if (nonZero.length === 1) {
    out.push(`Only one source reports records: ${nonZero[0].label} → ${nonZero[0].count}.`);
    return out;
  }
  out.push("Counts across known sources (operator should reconcile before any apply):");
  for (const o of observed) {
    out.push(`  - ${o.label}: ${o.count}`);
  }
  out.push(
    "Phase 2 / reset CLI operates on the 'Formal chosen' source. Research Lab / Agent HQ panels read via " +
    "getResearchLab() → readResearchBlob() which prefers the DB row, then research_lab.json, then research_lab.json.bak. " +
    "If those don't match, --apply will be REFUSED until they do.",
  );
  return out;
}

/**
 * Discover the formal hypothesis store and the memory knowledge store, and
 * return both data + diagnostics. Read-only.
 *
 * The "formal chosen" source — the one the reset CLI classifies against —
 * follows this priority:
 *   1. `--source=…` override (operator-only).
 *   2. `<DATA_DIR>/research_lab.json` if present and parseable.
 *   3. SQLite DB row (`research_lab` table, id='main') if `getResearchLab()`
 *      would otherwise read from there. This mirrors the runtime preference
 *      so the dashboard and CLI cannot disagree about which store powers the
 *      Research Lab / Agent HQ counts.
 *   4. `<DATA_DIR>/research_lab.json.bak` (post-migration sibling).
 *
 * Steps 3 and 4 are NEW in this PR. They make discovery match the runtime's
 * `readResearchBlob()` lookup order so the operator no longer sees "Records:
 * 0" when the Research Lab panel reports 400+.
 *
 * Step 2 stays the canonical first stop so existing test fixtures and
 * pre-migration deployments behave exactly as before.
 */
export function discoverHypothesisSources(opts: DiscoverSourcesOptions = {}): DiscoveredSource {
  const dataDir = resolveDataDir(opts);
  const memoryPath = path.join(dataDir, "memory_knowledge.json");

  const sourceOverride = (opts.sourcePath && opts.sourcePath.length > 0) ? path.resolve(opts.sourcePath) : null;

  const formalAttempts: AttemptedPath[] = [];
  let formalHypotheses: HygieneAwareHypothesis[] = [];
  let formalChosen: string | null = null;

  // Probe the SQLite DB row up front so we can both surface it as an
  // observation AND fall back to it when JSON candidates are missing.
  const dbPath = resolveDbPath(dataDir);
  const dbProbe = probeDbResearchLab(dbPath);
  const dbAttempt: AttemptedPath = {
    path:       dbPath,
    exists:     fs.existsSync(dbPath),
    readable:   dbProbe.available && !dbProbe.error,
    records:    dbProbe.records,
    role:       "db",
    parseError: dbProbe.error,
  };

  if (sourceOverride) {
    const r = loadFormalCandidate(sourceOverride, "formal");
    formalAttempts.push(r.attempt);
    if (r.hypotheses && r.attempt.readable) {
      formalHypotheses = r.hypotheses;
      formalChosen = sourceOverride;
    }
  } else {
    // Canonical JSON first.
    for (const c of LEGACY_CANDIDATE_FILENAMES) {
      const candidatePath = path.join(dataDir, c.filename);
      const role: AttemptedPath["role"] = c.filename === "research_lab.json" ? "formal" : "legacy-candidate";
      const r = loadFormalCandidate(candidatePath, role);
      formalAttempts.push(r.attempt);
      if (formalChosen === null && r.hypotheses && r.attempt.readable && r.attempt.records > 0) {
        // Only auto-pick a non-empty file. An empty research_lab.json with
        // a backup that has records should still pick the canonical path,
        // not silently switch — so we keep the canonical-first ordering and
        // require records > 0 to "choose" a non-canonical path.
        if (c.filename === "research_lab.json" || formalChosen === null) {
          formalHypotheses = r.hypotheses;
          formalChosen = candidatePath;
        }
      } else if (formalChosen === null && r.hypotheses && r.attempt.readable && c.filename === "research_lab.json") {
        // Canonical path is readable but empty — record it as the chosen
        // source so diagnostics correctly report "Records: 0" against the
        // canonical file rather than appearing to have ignored it.
        formalHypotheses = r.hypotheses;
        formalChosen = candidatePath;
      }
    }

    // Fallback: when NO JSON candidate yielded a parseable file at all, try
    // the SQLite DB row. We DO NOT silently flip the formal-chosen to the DB
    // when a parseable-but-empty research_lab.json was chosen above — that
    // would mask a legitimate "operator zeroed the file" state and make the
    // count-mismatch surface less honest. The empty JSON stays canonical; the
    // DB row surfaces under `otherSources` instead, where the dashboard and
    // CLI can reconcile the two counts.
    formalAttempts.push(dbAttempt);
    if (
      formalChosen === null
      && dbProbe.available
      && Array.isArray(dbProbe.hypotheses)
      && dbProbe.hypotheses.length > 0
    ) {
      formalHypotheses = dbProbe.hypotheses;
      formalChosen = dbPath;
    }
  }

  const mem = loadMemoryFile(memoryPath);

  // Build the "other sources" observation list (read-only, never affects
  // formalChosen). The point is reconciliation: if the operator sees 451 on
  // the Research Lab panel and 0 on the reset, this list explains why.
  const otherSources: OtherSourceObservation[] = [];
  // 1. DB row (always reported, including the not-applyable reason).
  otherSources.push({
    key:    "db_research_lab",
    label:  "SQLite research_lab row (powers getResearchLab / Research Lab / Agent HQ)",
    origin: "db_research_lab",
    count:  dbProbe.records,
    locator: `${dbPath}::research_lab[id=main].blob.hypotheses[]`,
    available: dbProbe.available,
    notApplyableReason: formalChosen === dbPath
      ? "Already selected as the formal-chosen source — apply path uses getResearchLab(), which reads this row."
      : "Read-only observation. Reset CLI applies only against the formal-chosen source. Re-run discovery with --source pointed at this row's content or run the migration to align the JSON candidates with the DB.",
    error: dbProbe.error,
  });
  // 2. Sibling .bak (post-migration).
  const bakPath = path.join(dataDir, "research_lab.json.bak");
  const bakRead = readJsonSafe(bakPath);
  let bakCount = 0;
  let bakAvail = bakRead.ok;
  if (bakRead.ok) bakCount = countHypothesesIn(bakRead.value);
  otherSources.push({
    key:    "research_lab_json_bak",
    label:  "research_lab.json.bak (post-migration sibling)",
    origin: "research_lab_json_bak",
    count:  bakCount,
    locator: bakPath,
    available: bakAvail,
    notApplyableReason: "Read-only observation. Used by jsonFallback.readJsonWithBakFallback only when the DB row is unavailable. Operator can pass --source pointing at this path to classify it.",
    error: bakRead.ok ? undefined : bakRead.reason,
  });
  // 3. Operator-staged .backup.json (legacy candidate).
  const backupPath = path.join(dataDir, "research_lab.backup.json");
  const backupRead = readJsonSafe(backupPath);
  let backupCount = 0;
  let backupAvail = backupRead.ok;
  if (backupRead.ok) backupCount = countHypothesesIn(backupRead.value);
  otherSources.push({
    key:    "research_lab_backup_json",
    label:  "research_lab.backup.json (operator-staged backup)",
    origin: "research_lab_backup_json",
    count:  backupCount,
    locator: backupPath,
    available: backupAvail,
    notApplyableReason: "Operator-staged backup. Never auto-promoted. Pass --source pointing at this path if it is the source the operator wants to classify.",
    error: backupRead.ok ? undefined : backupRead.reason,
  });
  // 4. Memory-origin entries (always reported; never apply-able through this CLI).
  otherSources.push({
    key:    "memory_knowledge_hypothesis_entries",
    label:  "Memory-origin 'Hypothesis: …' entries (memory_knowledge.json)",
    origin: "memory_knowledge_hypothesis_entries",
    count:  mem.hypEntries.length,
    locator: memoryPath,
    available: mem.attempt.readable,
    notApplyableReason: "memory→formal promotion is operator-only and out of scope for this CLI. Surfaced under the promote_later_memory_origin bucket for visibility.",
    error: mem.attempt.parseError,
  });

  const diagnostics: SourceDiscoveryDiagnostics = {
    dataDir,
    sourceOverride,
    formalAttempts,
    formalChosen,
    formalRecords: formalHypotheses.length,
    memoryAttempt: mem.attempt,
    memoryHypothesisCount: mem.hypEntries.length,
    nextSafeAction: "",
    knownCandidates: buildKnownCandidates(dataDir),
    otherSources,
    countReconciliation: buildCountReconciliation(
      formalChosen,
      formalHypotheses.length,
      mem.hypEntries.length,
      otherSources.filter(s => s.origin !== "memory_knowledge_hypothesis_entries"),
    ),
  };
  diagnostics.nextSafeAction = nextSafeActionFor(diagnostics);

  return {
    diagnostics,
    formalHypotheses,
    memoryFile: mem.file,
    memoryHypothesisEntries: mem.hypEntries,
  };
}

/**
 * Tiny convenience for callers that need only the diagnostics — used by the
 * intake-audit visibility block so the dashboard explains *why* formal
 * hypotheses are zero.
 */
export function describeSourceDiagnostics(opts: DiscoverSourcesOptions = {}): SourceDiscoveryDiagnostics {
  return discoverHypothesisSources(opts).diagnostics;
}

/**
 * Render diagnostics as human-readable lines. Used by the CLI report.
 * Pure.
 */
export function formatSourceDiagnostics(d: SourceDiscoveryDiagnostics): string[] {
  const lines: string[] = [];
  lines.push(`DATA_DIR:        ${d.dataDir}`);
  if (d.sourceOverride) {
    lines.push(`--source:        ${d.sourceOverride}`);
  }
  lines.push(`Formal attempts:`);
  for (const a of d.formalAttempts) {
    const tag = a.exists ? (a.readable ? `records=${a.records}` : `unreadable (${a.parseError ?? "unknown"})`) : "missing";
    lines.push(`  - [${a.role}] ${a.path}  ${tag}`);
  }
  lines.push(`Memory store:    ${d.memoryAttempt.path}  ${d.memoryAttempt.exists ? (d.memoryAttempt.readable ? `entries=${d.memoryAttempt.records}, hypothesis-titled=${d.memoryHypothesisCount}` : `unreadable (${d.memoryAttempt.parseError ?? "unknown"})`) : "missing"}`);
  lines.push(`Other observed sources (read-only, NOT apply-able through CLI):`);
  for (const s of d.otherSources) {
    const status = s.available ? `count=${s.count}` : `unavailable (${s.error ?? "unknown"})`;
    lines.push(`  - ${s.label}: ${status}`);
    lines.push(`      locator: ${s.locator}`);
    lines.push(`      reason: ${s.notApplyableReason}`);
  }
  lines.push(`Formal chosen:   ${d.formalChosen ?? "(none — formal store missing or empty)"}`);
  lines.push(`Formal records:  ${d.formalRecords}`);
  if (d.countReconciliation.length > 0) {
    lines.push(`Count reconciliation:`);
    for (const r of d.countReconciliation) lines.push(`  ${r}`);
  }
  lines.push(`Next safe action: ${d.nextSafeAction}`);
  return lines;
}
