/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — KB ACCUMULATION SELF-HEALING GATE (PR #414)
 *
 * Wires the `ratio_rule` corrective obligation for KB accumulation into a
 * pre-write self-healing gate. When the kb_added/archived ratio violates the
 * configured threshold, the gate auto-archives up to N oldest qualifying
 * stale entries (via the existing `archiveKnowledge` write site, single-
 * write-site preserved) THEN allows the write. It does NOT hard-block; the
 * write proceeds either way. The point is to keep the KB from running away
 * while remaining recoverable and reversible.
 *
 * DEFAULT OFF. Reversible. Single-write-site preserved.
 *
 *   KB_ACCUMULATION_GATE_ENABLED=true        — master switch (default false)
 *   KB_ACCUMULATION_RATIO_ADD=10              — N in "for every N added"
 *   KB_ACCUMULATION_RATIO_ARCHIVE=3           — M in "archive at least M"
 *   KB_ACCUMULATION_AUTO_ARCHIVE_CAP=3        — max auto-archives per write
 *   KB_ACCUMULATION_BACKUP_DIR (optional)     — override backup directory
 *
 * WRITE PATH (Pin 11):
 *   addKnowledge → maybeRunKbAccumulationGate (this module) →
 *     archiveStaleByIds (kbAutoArchive) → archiveKnowledge (memoryEngine.ts:908)
 *
 * No new HTTP endpoint, no new scheduler, no new public surface.
 *
 * BACKUP-THEN-MUTATE: per "tick" (== per call when the gate would fire),
 * the gate writes a single backup file `kb_auto_archive_backup_<iso>.json`
 * to the DATA_DIR before any archive runs. The backup contains the BEFORE
 * snapshot of every entry that will be archived. If the backup write fails
 * the gate refuses to archive and lets the write proceed without
 * intervention — degradation is safer than mutation-without-rollback.
 *
 * NO-OP CONDITIONS (write always proceeds):
 *   - env flag not set / not "true"
 *   - ratio currently satisfied (no deficit)
 *   - zero qualifying stale entries available
 *   - backup file write fails
 *
 * Returns a structured result so the caller can log and/or annotate the
 * obligation projection, but the caller is REQUIRED to proceed with the
 * write regardless of the gate outcome.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";

import { dataPath, DATA_DIR } from "./dataPaths.js";
import { knowledge, type KnowledgeEntry } from "./memoryEngine.js";
import { selectStaleKbEntries, archiveStaleByIds, type StaleEntrySnapshot } from "./kbAutoArchive.js";
import {
  recordKbRatioSatisfaction,
  type KbRatioSatisfactionEvent,
} from "./ruleCorrectiveObligations.js";

/** Default env values. Kept conservative; operators can widen via env. */
const DEFAULT_RATIO_ADD = 10;
const DEFAULT_RATIO_ARCHIVE = 3;
const DEFAULT_AUTO_ARCHIVE_CAP = 3;

export interface GateConfig {
  enabled: boolean;
  ratioAdd: number;       // N: "for every N added"
  ratioArchive: number;   // M: "archive at least M"
  autoArchiveCap: number; // cap on archives per write
}

export interface GateOutcome {
  /** Was the gate even consulted (env flag on)? */
  enabled: boolean;
  /** Whether ANY archive actually happened on this call. */
  archived: boolean;
  /** Ids that were archived (empty if nothing happened). */
  archivedIds: string[];
  /** Path to the backup file written before mutation (null if no backup
   *  was written — either because the gate didn't fire or because the
   *  backup attempt failed and the gate aborted). */
  backupPath: string | null;
  /** Was the deficit fully cleared by this auto-archive? */
  deficitCleared: boolean;
  /** When deficitCleared === false but archives happened, this is the
   *  partial-satisfaction signal carried into the obligation projection. */
  partialSatisfaction: boolean;
  /** Free-text reason (always populated; useful for logs). */
  reason: string;
}

/** Pure: read env-derived configuration. Side-effect-free. */
export function readGateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const enabled = (env.KB_ACCUMULATION_GATE_ENABLED ?? "").trim().toLowerCase() === "true";
  const parsePos = (s: string | undefined, fallback: number): number => {
    if (typeof s !== "string" || s.trim() === "") return fallback;
    const n = Math.floor(Number(s));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled,
    ratioAdd:       parsePos(env.KB_ACCUMULATION_RATIO_ADD, DEFAULT_RATIO_ADD),
    ratioArchive:   parsePos(env.KB_ACCUMULATION_RATIO_ARCHIVE, DEFAULT_RATIO_ARCHIVE),
    autoArchiveCap: parsePos(env.KB_ACCUMULATION_AUTO_ARCHIVE_CAP, DEFAULT_AUTO_ARCHIVE_CAP),
  };
}

/** Pure ratio probe over the current KB. Returns:
 *   - `actualActive` — count of entries with status active (or undefined,
 *     which defaults to "active" for backward compat).
 *   - `actualArchived` — count of entries with status === "archived".
 *   - `ratioViolated` — true when (actualActive / actualArchived) exceeds
 *     the configured (ratioAdd / ratioArchive). When actualArchived === 0
 *     and actualActive >= ratioAdd, the ratio is trivially violated.
 *   - `deficit` — how many MORE archives the system would need to bring
 *     the ratio within bounds (rounded up; clamped to >= 0).
 */
export interface RatioProbe {
  actualActive: number;
  actualArchived: number;
  ratioViolated: boolean;
  deficit: number;
}

export function probeRatio(cfg: GateConfig, entries: readonly KnowledgeEntry[] = knowledge.entries): RatioProbe {
  let actualActive = 0;
  let actualArchived = 0;
  for (const e of entries) {
    const status = e.status ?? "active";
    if (status === "active") actualActive++;
    else if (status === "archived") actualArchived++;
  }
  // Required archives to satisfy ratio: ceil(actualActive * ratioArchive / ratioAdd).
  const required = Math.ceil((actualActive * cfg.ratioArchive) / Math.max(1, cfg.ratioAdd));
  const deficit = Math.max(0, required - actualArchived);
  const ratioViolated = deficit > 0;
  return { actualActive, actualArchived, ratioViolated, deficit };
}

/** Backup-file path for a given tick. Exposed for tests. */
export function backupFilePath(now: Date): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const filename = `kb_auto_archive_backup_${iso}.json`;
  return process.env.KB_ACCUMULATION_BACKUP_DIR
    ? path.join(process.env.KB_ACCUMULATION_BACKUP_DIR, filename)
    : dataPath(filename);
}

/** Write the BEFORE snapshot for the entries about to be archived. One
 *  backup file per tick (per gate firing). Returns the path on success or
 *  `null` on failure. */
function writeBackup(snapshots: readonly StaleEntrySnapshot[], now: Date): string | null {
  const file = backupFilePath(now);
  try {
    // Ensure DATA_DIR exists (also covers the case where DATA_DIR is the
    // configured /data volume on Railway).
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: now.toISOString(),
          reason: "kb_accumulation_gate auto-archive backup (PR #414)",
          dataDir: DATA_DIR,
          snapshots,
        },
        null,
        2,
      ),
      "utf8",
    );
    return file;
  } catch (e: any) {
    console.warn(`[kbAccumulationGate] backup write failed (${file}): ${e?.message ?? e} — refusing to auto-archive`);
    return null;
  }
}

/** Generate a unique-ish event id (matches the obligation event format). */
function nextEventId(now: Date): string {
  const tail = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return `evt_${now.getTime()}_${tail}`;
}

/**
 * The pre-write hook called from `addKnowledge`. Always SAFE to call —
 * any failure to archive is swallowed and the write is allowed to
 * proceed. The caller MUST NOT use the return value to gate the write
 * itself.
 *
 * @returns a structured outcome the caller can log / surface.
 */
export function maybeRunKbAccumulationGate(opts?: {
  now?: Date;
  /** Inject env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Inject entry list for tests. */
  entries?: readonly KnowledgeEntry[];
}): GateOutcome {
  const now = opts?.now ?? new Date();
  const cfg = readGateConfigFromEnv(opts?.env);

  if (!cfg.enabled) {
    return {
      enabled: false,
      archived: false,
      archivedIds: [],
      backupPath: null,
      deficitCleared: false,
      partialSatisfaction: false,
      reason: "gate disabled (KB_ACCUMULATION_GATE_ENABLED != true)",
    };
  }

  const probe = probeRatio(cfg, opts?.entries);
  if (!probe.ratioViolated) {
    return {
      enabled: true,
      archived: false,
      archivedIds: [],
      backupPath: null,
      deficitCleared: true,
      partialSatisfaction: false,
      reason: `ratio satisfied: ${probe.actualActive} active / ${probe.actualArchived} archived; no archive needed`,
    };
  }

  // K = min(cap, deficit) — the most we can address this call.
  const k = Math.min(cfg.autoArchiveCap, probe.deficit);
  const snapshots = selectStaleKbEntries({ now, cap: k, entries: opts?.entries });
  if (snapshots.length === 0) {
    return {
      enabled: true,
      archived: false,
      archivedIds: [],
      backupPath: null,
      deficitCleared: false,
      partialSatisfaction: false,
      reason: `ratio violated (deficit=${probe.deficit}) but no qualifying stale entries to archive (graceful degradation)`,
    };
  }

  // Single backup per tick BEFORE any mutation.
  const backupPath = writeBackup(snapshots, now);
  if (!backupPath) {
    return {
      enabled: true,
      archived: false,
      archivedIds: [],
      backupPath: null,
      deficitCleared: false,
      partialSatisfaction: false,
      reason: "backup write failed — auto-archive refused, write will proceed without intervention",
    };
  }

  // Route every status mutation through archiveKnowledge (Pin 11).
  const archivedIds = archiveStaleByIds(snapshots.map((s) => s.id));

  const deficitCleared = archivedIds.length >= probe.deficit;
  const partialSatisfaction = archivedIds.length > 0 && !deficitCleared;
  const reason =
    `kb_accumulation_gate fired: active=${probe.actualActive} archived=${probe.actualArchived} ` +
    `ratio(${cfg.ratioAdd}/${cfg.ratioArchive}) deficit=${probe.deficit}; ` +
    `auto-archived ${archivedIds.length}/${snapshots.length} (cap=${cfg.autoArchiveCap})`;

  // Telemetry row per archive — same ledger boundary as obligation events.
  for (const id of archivedIds) {
    const evt: KbRatioSatisfactionEvent = {
      eventId: nextEventId(now),
      type: "kb_ratio_satisfaction",
      recordedAt: now.toISOString(),
      archivedEntryId: id,
      reason,
      deficitCleared,
      partialSatisfaction,
      tickedAt: now.getTime(),
    };
    recordKbRatioSatisfaction(evt);
  }

  return {
    enabled: true,
    archived: archivedIds.length > 0,
    archivedIds,
    backupPath,
    deficitCleared,
    partialSatisfaction,
    reason,
  };
}
