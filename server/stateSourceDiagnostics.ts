/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — State Source Diagnostics (READ-ONLY)
 *
 * Surface a tiny, defensive snapshot of each high-churn core-state store so
 * operators can see at a glance, from the autonomy monitor:
 *
 *   - which canonical source the read-through shim would resolve right now
 *     (`db` row present? live JSON present? `.bak` present?)
 *   - when the DB row was last written (`updatedAt`)
 *   - rough fingerprints of the DB blob, live JSON, and `.bak` so a mismatch
 *     is visible without having to SSH into the container
 *
 * No mutation; safe to call on every page render. Every external read is
 * wrapped in try/catch — missing or unreadable sources surface as `null`.
 *
 * Motivated by the 2026-05-18 deploy/restart bug where the on-boot
 * JSON→DB migration overwrote an operator-applied archive reset from the
 * stale `research_lab.json.bak`. The fix (first-run-only guard in each
 * `importXFromJson()`) makes the overwrite path inert; this diagnostic
 * makes the inversion (live DB newer than fallback .bak) trivially
 * visible so any future regression is caught by eye, not by the audit
 * three weeks later.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as crypto from "crypto";
import { db } from "./db.js";
import {
  agentGoals,
  competencyProfileTable,
  memoryKnowledge,
  memorySoul,
  researchLab,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { dataPath } from "./dataPaths.js";

export interface StateSourceRow {
  /** Logical store name. Matches the migration script's `name`. */
  store: "memory_knowledge" | "memory_soul" | "agent_goals" | "competency_profile" | "research_lab";
  /** Absolute path the read-through shim would read live JSON from. */
  jsonPath: string;
  /** True iff the SQLite row exists with a non-empty blob. */
  dbRowPresent: boolean;
  /** ISO string from the DB row's `updated_at` column, if present. */
  dbUpdatedAt: string | null;
  /** First 12 hex chars of sha256(blob) for the DB row, if present. */
  dbBlobHash: string | null;
  /** True iff the live `.json` file exists (pre-migration shape). */
  jsonPresent: boolean;
  /** Mtime + hash of the live JSON, if present. */
  jsonUpdatedAt: string | null;
  jsonHash: string | null;
  /** True iff the post-migration `.json.bak` file exists. */
  bakPresent: boolean;
  /** Mtime + hash of the `.bak`, if present. */
  bakUpdatedAt: string | null;
  bakHash: string | null;
  /**
   * Which source the read-through shim would resolve to right now. Mirrors
   * `readThrough()`'s DB → live JSON → `.bak` walk.
   */
  effectiveSource: "db" | "json" | "bak" | "missing";
  /**
   * True when the DB row exists AND the `.bak` hash differs from the DB
   * blob hash. The migration script with the first-run-only guard treats
   * this as expected (DB has diverged from the original JSON snapshot via
   * operator mutation — that is the whole point of the fix). A boot log
   * line surfacing this lets the operator confirm the live DB is the one
   * in use, not the stale `.bak`.
   */
  dbAheadOfBak: boolean;
}

export interface StateSourceDiagnostics {
  generatedAt: string;
  rows: StateSourceRow[];
  /**
   * Operator-friendly summary: at least one row where the DB row exists AND
   * the `.bak` is newer-by-mtime than the DB row, which would be a sign
   * that operator-applied DB mutations have been reverted. With the
   * first-run-only guard in place this should always be false.
   */
  warnings: string[];
}

const STORES: Array<{
  name: StateSourceRow["store"];
  jsonName: string;
  read: () => { blob: string; updatedAt: string | null } | null;
}> = [
  {
    name: "memory_knowledge",
    jsonName: "memory_knowledge.json",
    read: () => readBlobRow(() => db.select().from(memoryKnowledge).where(eq(memoryKnowledge.id, "main")).get()),
  },
  {
    name: "memory_soul",
    jsonName: "memory_soul.json",
    read: () => readBlobRow(() => db.select().from(memorySoul).where(eq(memorySoul.id, "current")).get()),
  },
  {
    name: "agent_goals",
    jsonName: "agent_goals.json",
    read: () => readBlobRow(() => db.select().from(agentGoals).where(eq(agentGoals.id, "main")).get()),
  },
  {
    name: "competency_profile",
    jsonName: "competencyProfile.json",
    read: () => readBlobRow(() => db.select().from(competencyProfileTable).where(eq(competencyProfileTable.id, "main")).get()),
  },
  {
    name: "research_lab",
    jsonName: "research_lab.json",
    read: () => readBlobRow(() => db.select().from(researchLab).where(eq(researchLab.id, "main")).get()),
  },
];

function readBlobRow(
  fetch: () => { blob?: string; updatedAt?: string | null } | undefined | null,
): { blob: string; updatedAt: string | null } | null {
  try {
    const row = fetch();
    if (!row || !row.blob || row.blob.length <= 2) return null;
    return { blob: row.blob, updatedAt: row.updatedAt ?? null };
  } catch {
    return null;
  }
}

function hashShort(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function readFileMeta(p: string): { content: string; mtimeIso: string } | null {
  try {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, "utf8");
    return { content, mtimeIso: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

export function buildStateSourceDiagnostics(now: Date = new Date()): StateSourceDiagnostics {
  const rows: StateSourceRow[] = [];
  const warnings: string[] = [];

  for (const s of STORES) {
    const jsonPath = dataPath(s.jsonName);
    const bakPath  = `${jsonPath}.bak`;

    const dbRow = s.read();
    const live  = readFileMeta(jsonPath);
    const bak   = readFileMeta(bakPath);

    const dbBlobHash = dbRow ? hashShort(dbRow.blob) : null;
    const jsonHash   = live  ? hashShort(live.content) : null;
    const bakHash    = bak   ? hashShort(bak.content)  : null;

    const effectiveSource: StateSourceRow["effectiveSource"] =
      dbRow ? "db" :
      live  ? "json" :
      bak   ? "bak" :
              "missing";

    const dbAheadOfBak = !!dbRow && !!bak && dbBlobHash !== bakHash;

    rows.push({
      store:         s.name,
      jsonPath,
      dbRowPresent:  !!dbRow,
      dbUpdatedAt:   dbRow?.updatedAt ?? null,
      dbBlobHash,
      jsonPresent:   !!live,
      jsonUpdatedAt: live?.mtimeIso ?? null,
      jsonHash,
      bakPresent:    !!bak,
      bakUpdatedAt:  bak?.mtimeIso ?? null,
      bakHash,
      effectiveSource,
      dbAheadOfBak,
    });

    // Only flag a true inversion: live DB row missing AND a `.bak` exists.
    // That is the state we would see if a deploy wiped /data and the next
    // boot resurrected the store from the in-image `.bak`. Under the new
    // guard the import won't overwrite a populated DB; but if the DB row
    // is gone entirely (volume not mounted), the operator should see it.
    if (!dbRow && bak) {
      warnings.push(
        `${s.name}: DB row absent but .bak present at ${bakPath}. ` +
        `If /data is a persistent volume, the DB row should exist — investigate volume mount.`,
      );
    }
  }

  return { generatedAt: now.toISOString(), rows, warnings };
}
