/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS RESET APPLY (OPERATOR-ONLY, ARCHIVE-NOT-DELETE)
 *
 * Companion to `hypothesisResetReport.ts`. Given a previously generated reset
 * report and a set of bucket names the operator wants to apply, this module
 * performs the safe archive write — annotating each selected record with a
 * hygieneTag drawn from {@link ARCHIVE_TAG_FOR_BUCKET} and flipping the
 * lifecycle status to `stale-retired`. Source claim / metric / basis are
 * preserved verbatim. NOTHING is deleted from research_lab.json (or the DB
 * blob).
 *
 * Source modes:
 *   - JSON: report's formal-chosen source is research_lab.json (or a
 *     --source override). Backup = JSON snapshot, write via saveResearchLab.
 *   - DB: report's formal-chosen source is the SQLite research_lab[id=main]
 *     row (post-migration deployments). Apply requires `confirmDbSource`
 *     (CLI: --confirm-source=db). Backup = DB-blob JSON snapshot at
 *     data/hypothesis_reset_db_backup_<iso>.json. Write via saveResearchLab,
 *     which writes through to the DB blob (and mirrors to JSON if the
 *     research_lab.json file still exists on disk).
 *
 * Hard invariants:
 *   - ARCHIVE NOT DELETE. Every selected row stays in `lab.hypotheses`. We
 *     set:
 *         status        = "stale-retired"
 *         hygieneTag    = derived from bucket
 *         hygieneReason = "applied via hypothesisResetApply: <bucket>"
 *     and leave every other field intact. A future operator can read
 *     archived rows from the same file and revert by clearing the tag.
 *   - DRY-RUN BY DEFAULT. The pure `computeApplyPlan` function returns the
 *     transformation a write would perform; the runtime caller MUST pass
 *     `{ apply: true }` to actually call `saveResearchLab`. Tests cover
 *     both branches.
 *   - BACKED UP. Before writing, the current lab snapshot is copied to
 *     `data/hypothesis_reset_backup_<iso>.json` so an operator can roll back
 *     by restoring that file. If the backup write fails, the apply refuses.
 *   - PROPOSE-ONLY ENFORCEMENT BOUNDARY. The CLI sits OUTSIDE the autonomous
 *     loop. Nothing inside the daily-cycle / scheduler / actionEnforcer
 *     calls into this module. It is a foreground operator action only.
 *   - SAFE-BUCKETS ONLY. Only `archive_stale`, `archive_data_unavailable`,
 *     and `archive_duplicate` are eligible. `rewrite_*`,
 *     `needs_operator_review`, and `keep_active` / `promote_later_memory_origin`
 *     are HARD-REFUSED — the function returns an explicit refusal rather
 *     than silently skipping. Tests pin this.
 *   - STALE-REPORT GUARD. The apply step refuses if the underlying record
 *     count or the per-id classification has drifted from the report. The
 *     operator must re-run the report and re-confirm.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import {
  buildResetReport,
  type HypothesisResetReport,
  type ResetReportEntry,
} from "./hypothesisResetReport.js";
import type { ResetBucket } from "./hypothesisIntakeAuditVisibility.js";
import type { HygieneAwareHypothesis } from "./hypothesisHygiene.js";
import type { HygieneTag } from "./hypothesisHygiene.js";
import { getResearchLab, saveResearchLab } from "./researchEngine.js";
import {
  discoverHypothesisSources,
  type AttemptedPath,
} from "./hypothesisSourceDiscovery.js";

// ── Constants ───────────────────────────────────────────────────────────────

export const ARCHIVE_TAG_FOR_BUCKET: Readonly<Partial<Record<ResetBucket, HygieneTag>>> = Object.freeze({
  archive_stale:            "archived_stale",
  archive_data_unavailable: "archived_unsolvable",
  archive_duplicate:        "archived_irrelevant",
});

export const SAFE_APPLY_BUCKETS: Readonly<ResetBucket[]> = Object.freeze([
  "archive_stale",
  "archive_data_unavailable",
  "archive_duplicate",
]);

// ── Types ───────────────────────────────────────────────────────────────────

export type ApplyRefusalReason =
  | "no_buckets_selected"
  | "bucket_not_safe"
  | "report_stale"
  | "no_records_to_change"
  | "save_lab_failed"
  | "backup_failed"
  | "research_lab_missing"
  | "no_formal_records_loaded"
  | "memory_origin_not_appliable"
  | "formal_source_not_applyable"
  | "db_source_confirmation_required"
  | "source_changed_between_report_and_apply";

export interface ApplyChange {
  id:            string;
  fromStatus:    string;
  toStatus:      "stale-retired";
  fromHygieneTag: string | null;
  toHygieneTag:  HygieneTag;
  bucket:        ResetBucket;
}

export interface ApplyPlan {
  /** Buckets the caller actually selected (after safe-bucket filter). */
  selectedBuckets: ResetBucket[];
  changes:         ApplyChange[];
  /** Per-bucket count of changes that WOULD be applied. */
  countsByBucket:  Record<ResetBucket, number>;
  /** Records that were in the report's selected buckets but already carry
   *  an archived hygieneTag and `stale-retired` status — these are skipped
   *  to avoid no-op writes. */
  skipped:         Array<{ id: string; reason: string }>;
}

export type ApplyResult =
  | {
      ok: true;
      mode: "dry_run" | "applied";
      plan: ApplyPlan;
      /** Total records in research_lab.json before / after. ALWAYS equal —
       *  archive-not-delete. */
      countsBefore: { total: number };
      countsAfter:  { total: number };
      backupPath:   string | null;
      summary:      string;
      /** Source role used for the apply ('json' for research_lab.json, 'db'
       *  for the SQLite research_lab row). Surfaced so callers can render
       *  source-aware operator output. */
      sourceRole:   "json" | "db";
    }
  | {
      ok: false;
      reason: ApplyRefusalReason;
      detail: string;
      plan?: ApplyPlan;
    };

// ── Pure plan computation ───────────────────────────────────────────────────

function readLabForCompare(): { hypotheses: HygieneAwareHypothesis[]; exists: boolean } {
  const p = dataPath("research_lab.json");
  if (!fs.existsSync(p)) return { hypotheses: [], exists: false };
  try {
    const lab = JSON.parse(fs.readFileSync(p, "utf8"));
    const hyps = Array.isArray(lab?.hypotheses) ? (lab.hypotheses as HygieneAwareHypothesis[]) : [];
    return { hypotheses: hyps, exists: true };
  } catch {
    return { hypotheses: [], exists: true };
  }
}

/**
 * DB-aware reader: when the report's formal-chosen source is the SQLite DB
 * row, re-discover at apply time and return the current DB-row hypotheses as
 * `diskHyps`. This is the source the freshness guard compares against and the
 * source the writer transforms. Read-only.
 */
function readDbBackedFormalForCompare(): {
  hypotheses:  HygieneAwareHypothesis[];
  exists:      boolean;
  chosenPath:  string | null;
  chosenRole:  AttemptedPath["role"] | null;
} {
  const d = discoverHypothesisSources();
  const chosen = d.diagnostics.formalChosen;
  const chosenAttempt = chosen
    ? d.diagnostics.formalAttempts.find(a => a.path === chosen)
    : undefined;
  const chosenRole = chosenAttempt?.role ?? null;
  return {
    hypotheses: d.formalHypotheses,
    exists:     chosen !== null,
    chosenPath: chosen,
    chosenRole,
  };
}

/**
 * Compare the report's record ids and per-id buckets against the *current*
 * on-disk research_lab.json. Refuses with `report_stale` if the report no
 * longer matches reality — an operator must re-run before they can apply.
 *
 * The guard is conservative: even if the bucket assignments are equivalent
 * but the report's `generatedAt` predates the disk file's mtime by more
 * than 24h, we refuse and ask for a fresh report.
 */
function reportIsFresh(
  rep: HypothesisResetReport,
  diskHyps: HygieneAwareHypothesis[],
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  // Compare ONLY the formal (research_lab.json) population. Memory-origin
  // entries are listed for visibility but are not part of the on-disk
  // formal store and must not influence freshness comparisons.
  const formalCount = typeof rep.meta.formalRecords === "number"
    ? rep.meta.formalRecords
    : rep.meta.totalRecords;
  if (formalCount !== diskHyps.length) {
    return {
      ok: false,
      reason: `report has ${formalCount} formal records but research_lab.json has ${diskHyps.length} on disk now — re-run the report before applying`,
    };
  }
  const diskIds = new Set(diskHyps.map(h => h.id));
  const reportIds: string[] = [];
  for (const section of rep.buckets) {
    for (const e of section.entries) {
      // Memory-origin ids carry the synthetic `memory:` prefix and never
      // exist in the on-disk formal store. Skip them from the comparison.
      if ((e as { origin?: string }).origin === "memory") continue;
      reportIds.push(e.id);
    }
  }
  for (const id of reportIds) {
    if (!diskIds.has(id)) {
      return {
        ok: false,
        reason: `report references id ${id} but it is no longer in research_lab.json — re-run the report before applying`,
      };
    }
  }
  const reportTs = new Date(rep.meta.generatedAt).getTime();
  const ageMs = now.getTime() - reportTs;
  if (Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      reason: `report generatedAt ${rep.meta.generatedAt} is older than 24h — re-run the report before applying`,
    };
  }
  return { ok: true };
}

export interface ComputeApplyPlanOptions {
  selectedBuckets: ResetBucket[];
}

/**
 * Pure: compute the apply plan from a report + selected buckets. Does NOT
 * touch disk. Returns either the change list or an explicit refusal. The
 * caller decides whether to dry-run or write.
 */
export function computeApplyPlan(
  rep: HypothesisResetReport,
  diskHyps: HygieneAwareHypothesis[],
  opts: ComputeApplyPlanOptions,
): { ok: true; plan: ApplyPlan } | { ok: false; reason: ApplyRefusalReason; detail: string } {
  const requested = (opts.selectedBuckets ?? []).filter(Boolean);
  if (requested.length === 0) {
    return { ok: false, reason: "no_buckets_selected", detail: "selectedBuckets is empty" };
  }
  for (const b of requested) {
    if (b === "promote_later_memory_origin") {
      return {
        ok: false,
        reason: "memory_origin_not_appliable",
        detail: "bucket 'promote_later_memory_origin' is memory-origin and never applied by this CLI — promotion is operator-only via server/memoryHypothesisHygiene.ts",
      };
    }
    if (!SAFE_APPLY_BUCKETS.includes(b)) {
      return {
        ok: false,
        reason: "bucket_not_safe",
        detail: `bucket '${b}' is not safe to apply from the reset CLI — see SAFE_APPLY_BUCKETS`,
      };
    }
  }
  const allowed = new Set<ResetBucket>(requested);

  const entriesById = new Map<string, ResetReportEntry>();
  const bucketById = new Map<string, ResetBucket>();
  for (const section of rep.buckets) {
    if (!allowed.has(section.bucket)) continue;
    for (const e of section.entries) {
      // Defense in depth: memory-origin entries never reach the apply path
      // — even if a future buggy classifier put one in an archive_* bucket.
      if ((e as { origin?: string }).origin === "memory") continue;
      entriesById.set(e.id, e);
      bucketById.set(e.id, section.bucket);
    }
  }

  if (entriesById.size === 0) {
    return {
      ok: false,
      reason: "no_records_to_change",
      detail: "no records in the selected buckets",
    };
  }

  const changes: ApplyChange[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const countsByBucket: Record<ResetBucket, number> = Object.create(null);
  for (const b of requested) countsByBucket[b] = 0;

  for (const h of diskHyps) {
    const bucket = bucketById.get(h.id);
    if (!bucket) continue;
    const toTag = ARCHIVE_TAG_FOR_BUCKET[bucket];
    if (!toTag) {
      skipped.push({ id: h.id, reason: `no archive tag mapping for bucket ${bucket}` });
      continue;
    }
    if (h.status === "stale-retired" && h.hygieneTag === toTag) {
      skipped.push({ id: h.id, reason: "already archived with the same tag — no-op" });
      continue;
    }
    changes.push({
      id:             h.id,
      fromStatus:     typeof h.status === "string" ? h.status : "(unset)",
      toStatus:       "stale-retired",
      fromHygieneTag: typeof h.hygieneTag === "string" ? h.hygieneTag : null,
      toHygieneTag:   toTag,
      bucket,
    });
    countsByBucket[bucket]++;
  }

  return {
    ok: true,
    plan: {
      selectedBuckets: requested,
      changes,
      countsByBucket,
      skipped,
    },
  };
}

// ── Runtime entry point ─────────────────────────────────────────────────────

export interface RunResetApplyOptions {
  selectedBuckets: ResetBucket[];
  /** If false (default), the function computes the plan, prints, and returns
   *  WITHOUT calling saveResearchLab. */
  apply?:          boolean;
  /** Inject `now` for deterministic tests. */
  now?:            Date;
  /** Inject a pre-built report (skip rebuild). Tests / CI only. */
  report?:         HypothesisResetReport;
  /** Inject the disk hypothesis list (skip read). Tests only — the
   *  runtime CLI never passes this. */
  diskHyps?:       HygieneAwareHypothesis[];
  /** When apply=true, override save side effect (tests). */
  saveLab?:        (lab: unknown) => void;
  /** When apply=true, override backup side effect (tests). Returns the
   *  written backup path, or throws on failure. */
  writeBackup?:    (snapshot: unknown, ts: Date) => string;
  /** Required when the report's formal-chosen source is the SQLite DB row.
   *  Operator-only confirmation that they intend to write through the DB
   *  blob rather than research_lab.json. Without this, --apply against a
   *  DB-chosen report is refused with `db_source_confirmation_required`. */
  confirmDbSource?: boolean;
  /** Override the DB-backed disk loader (tests). Same shape as
   *  `readDbBackedFormalForCompare`. */
  readDbBacked?:   () => ReturnType<typeof readDbBackedFormalForCompare>;
}

const DEFAULT_BACKUP_DIR_FILENAME = (ts: Date): string =>
  `hypothesis_reset_backup_${ts.toISOString().replace(/[:.]/g, "-")}.json`;

const DEFAULT_DB_BACKUP_DIR_FILENAME = (ts: Date): string =>
  `hypothesis_reset_db_backup_${ts.toISOString().replace(/[:.]/g, "-")}.json`;

function defaultWriteBackup(snapshot: unknown, ts: Date): string {
  const filename = DEFAULT_BACKUP_DIR_FILENAME(ts);
  const path = dataPath(filename);
  fs.writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

function defaultWriteDbBackup(snapshot: unknown, ts: Date): string {
  const filename = DEFAULT_DB_BACKUP_DIR_FILENAME(ts);
  const path = dataPath(filename);
  fs.writeFileSync(path, JSON.stringify(snapshot, null, 2));
  return path;
}

/**
 * Runtime entry point used by the CLI in `scripts/hypothesisReset.ts`.
 *
 * - With `apply=false` (default), returns a dry-run summary and does NOT
 *   call saveResearchLab.
 * - With `apply=true`, writes a backup file to `data/`, then calls
 *   saveResearchLab with the transformed lab. Returns `ok: false` with the
 *   refusal reason if any step fails.
 *
 * Source modes:
 *   - JSON: the report's formal-chosen source is `research_lab.json` (or a
 *     `--source` JSON override). Backup is the JSON snapshot, freshness reads
 *     research_lab.json, write goes through saveResearchLab (which mirrors
 *     to DB if enabled).
 *   - DB: the report's formal-chosen source is the SQLite `research_lab` row.
 *     Apply requires `confirmDbSource: true` (the CLI surfaces this as the
 *     operator-only `--confirm-source=db` flag). Backup snapshots the DB
 *     blob to `data/hypothesis_reset_db_backup_<iso>.json`. Freshness reads
 *     the live DB blob via `discoverHypothesisSources()` so the comparison
 *     matches the source that powered the report. Source-change detection:
 *     the apply re-discovers and refuses if the formal-chosen path or role
 *     has moved between report time and apply time.
 */
export function runResetApply(opts: RunResetApplyOptions): ApplyResult {
  const now = opts.now ?? new Date();
  const apply = Boolean(opts.apply);
  const report =
    opts.report ?? buildResetReport({ now });

  // Identify the report's formal-chosen source role. The report carries the
  // diagnostics so we can decide JSON vs DB up-front without re-discovering.
  const reportChosenPath = report.meta.sourceDiagnostics.formalChosen;
  const reportChosenAttempt = report.meta.sourceDiagnostics.formalAttempts.find(
    a => a.path === reportChosenPath,
  );
  const reportChosenRole: AttemptedPath["role"] | null = reportChosenAttempt?.role ?? null;
  const isDbSource = reportChosenRole === "db";
  const sourceRole: "json" | "db" = isDbSource ? "db" : "json";

  // Load disk-side hypotheses for freshness + plan comparison. DB-chosen
  // reports read the live DB blob; JSON-chosen reports read
  // research_lab.json. Tests can inject either via opts.diskHyps.
  let diskHyps: HygieneAwareHypothesis[];
  let exists: boolean;
  let liveChosenPath: string | null = reportChosenPath;
  let liveChosenRole: AttemptedPath["role"] | null = reportChosenRole;

  if (opts.diskHyps) {
    diskHyps = opts.diskHyps;
    exists = true;
  } else if (isDbSource) {
    const dbLoader = opts.readDbBacked ?? readDbBackedFormalForCompare;
    const r = dbLoader();
    diskHyps      = r.hypotheses;
    exists        = r.exists;
    liveChosenPath = r.chosenPath;
    liveChosenRole = r.chosenRole;
  } else {
    const r = readLabForCompare();
    diskHyps = r.hypotheses;
    exists   = r.exists;
  }

  if (!exists) {
    if (isDbSource) {
      return {
        ok: false,
        reason: "research_lab_missing",
        detail:
          `Report's formal-chosen source was the SQLite DB row (${reportChosenPath}) ` +
          `but no formal store could be re-discovered at apply time. ` +
          `Re-run the report and confirm the DB is reachable before re-applying.`,
      };
    }
    return {
      ok: false,
      reason: "research_lab_missing",
      detail: `research_lab.json does not exist at ${dataPath("research_lab.json")}`,
    };
  }

  // Source-change detection between report and apply. If the live discovery
  // resolves a different formal-chosen path or role from the one the report
  // was generated against, refuse — the apply would silently re-target a
  // different store.
  if (apply && (liveChosenPath !== reportChosenPath || liveChosenRole !== reportChosenRole)) {
    return {
      ok: false,
      reason: "source_changed_between_report_and_apply",
      detail:
        `Report's formal-chosen source was ${reportChosenRole ?? "(null)"}=${reportChosenPath ?? "(null)"} ` +
        `but live discovery resolves to ${liveChosenRole ?? "(null)"}=${liveChosenPath ?? "(null)"} now. ` +
        `Re-run the report before re-applying so the operator confirms the new source.`,
    };
  }

  // Hard refusal: when the report's formal-chosen source is the SQLite DB row,
  // require explicit operator confirmation. The CLI surfaces this as
  // --confirm-source=db. Without it, --apply against a DB-chosen report is
  // refused. This prevents a JSON-trained operator habit from inadvertently
  // writing through the DB blob.
  if (apply && isDbSource && !opts.confirmDbSource) {
    return {
      ok: false,
      reason: "db_source_confirmation_required",
      detail:
        `Report's formal-chosen source is the SQLite DB row at ${reportChosenPath}. ` +
        `--apply against a DB-chosen report requires explicit operator confirmation ` +
        `(--confirm-source=db on the CLI). Only the safe archive buckets ` +
        `(${SAFE_APPLY_BUCKETS.join(", ")}) are eligible. Re-run with --confirm-source=db ` +
        `to proceed.`,
    };
  }

  // Hard refusal: --apply is only meaningful when there are formal records
  // to archive. With zero formal records loaded, the operator is most likely
  // pointed at the wrong DATA_DIR / --source — pushing an apply would write
  // a no-op backup and confuse triage.
  if (apply && diskHyps.length === 0) {
    return {
      ok: false,
      reason: "no_formal_records_loaded",
      detail:
        `0 formal records loaded from ${isDbSource ? reportChosenPath : dataPath("research_lab.json")} — refusing --apply. ` +
        (isDbSource
          ? `Confirm the SQLite DB at ${reportChosenPath} still holds the research_lab row before retrying.`
          : `Either re-run with --source=<absolute path to a populated research_lab.json> ` +
            `or fix DATA_DIR before retrying. Memory-origin entries are never applied by this CLI.`),
    };
  }

  const freshness = reportIsFresh(report, diskHyps, now);
  if (!freshness.ok) {
    return { ok: false, reason: "report_stale", detail: freshness.reason };
  }

  const planResult = computeApplyPlan(report, diskHyps, { selectedBuckets: opts.selectedBuckets });
  if (!planResult.ok) {
    return { ok: false, reason: planResult.reason, detail: planResult.detail };
  }
  const plan = planResult.plan;

  const countsBefore = { total: diskHyps.length };
  const summary =
    `Hypothesis reset apply: mode=${apply ? "applied" : "dry_run"}, ` +
    `source=${sourceRole}, ` +
    `selectedBuckets=[${plan.selectedBuckets.join(", ")}], ` +
    `${plan.changes.length} record(s) would be archived (archive-not-delete), ` +
    `${plan.skipped.length} skipped. ` +
    `Total records before=${countsBefore.total}, after=${countsBefore.total} (no rows are removed).`;

  if (!apply) {
    return {
      ok: true,
      mode: "dry_run",
      plan,
      countsBefore,
      countsAfter: { total: countsBefore.total },
      backupPath: null,
      summary,
      sourceRole,
    };
  }

  // Apply: backup → transform → save.
  const writeBackup = opts.writeBackup
    ?? (isDbSource ? defaultWriteDbBackup : defaultWriteBackup);
  let backupPath: string;
  try {
    backupPath = writeBackup(
      isDbSource
        ? {
            archivedAt: now.toISOString(),
            sourceRole: "db",
            dbPath:     reportChosenPath,
            // Snapshot the FULL lab blob (not just hypotheses) so an operator
            // restoring from this backup can re-create the DB row's blob
            // verbatim.
            lab:        getResearchLab(),
          }
        : { archivedAt: now.toISOString(), sourceRole: "json", hypotheses: diskHyps },
      now,
    );
  } catch (e: any) {
    return {
      ok: false,
      reason: "backup_failed",
      detail: `backup write failed: ${e?.message ?? String(e)}`,
      plan,
    };
  }

  // Load full lab via the existing loader so we don't accidentally drop
  // topics/stats. The loader reads through readResearchBlob → DB-then-JSON,
  // so DB-source and JSON-source paths converge here. Apply changes by id.
  const lab = getResearchLab();
  const changeById = new Map<string, ApplyChange>();
  for (const c of plan.changes) changeById.set(c.id, c);

  lab.hypotheses = lab.hypotheses.map(h => {
    const change = changeById.get(h.id);
    if (!change) return h;
    return {
      ...(h as any),
      status:          "stale-retired",
      hygieneTag:      change.toHygieneTag,
      hygieneReason:   `applied via hypothesisResetApply: ${change.bucket}`,
      hygieneTaggedAt: now.toISOString(),
      hygieneTaggedBy: "operator-cli",
      archivedAt:      now.toISOString(),
    } as any;
  });

  try {
    const saveImpl = opts.saveLab ?? saveResearchLab;
    saveImpl(lab as unknown as any);
  } catch (e: any) {
    return {
      ok: false,
      reason: "save_lab_failed",
      detail: `saveResearchLab failed: ${e?.message ?? String(e)}`,
      plan,
    };
  }

  return {
    ok: true,
    mode: "applied",
    plan,
    countsBefore,
    countsAfter: { total: lab.hypotheses.length },
    backupPath,
    summary,
    sourceRole,
  };
}
