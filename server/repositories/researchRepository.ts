/**
 * researchRepository (spec §4) — wraps research_lab.
 */

import { db } from "../db.js";
import { researchLab } from "@shared/schema";
import { eq } from "drizzle-orm";
import { dataPath } from "../dataPaths.js";
import { readThrough, readJsonWithBakFallback, type ImportResult } from "./jsonFallback.js";

const KEY = "main";
const JSON_PATH = dataPath("research_lab.json");

export function readResearchBlob<T = unknown>(): T | null {
  return readThrough<T>({
    dbRead: () => {
      const row = db.select().from(researchLab).where(eq(researchLab.id, KEY)).get();
      if (!row) return null;
      try { return JSON.parse(row.blob) as T; } catch { return null; }
    },
    jsonPath: JSON_PATH,
  });
}

export function writeResearchBlob(blob: unknown): void {
  const payload = JSON.stringify(blob);
  const existing = db.select().from(researchLab).where(eq(researchLab.id, KEY)).get();
  if (existing) {
    db.update(researchLab)
      .set({ blob: payload, updatedAt: new Date().toISOString() })
      .where(eq(researchLab.id, KEY))
      .run();
  } else {
    db.insert(researchLab).values({ id: KEY, blob: payload }).run();
  }
}

/**
 * One-way, first-run-only import. If the DB row already exists with a
 * non-empty blob, we do NOT overwrite it from JSON/.bak — that would
 * silently revert any DB-side mutation (e.g. an operator-applied archive
 * reset) on the next boot. See migrate_json_to_db.ts for the call site.
 *
 * Return value:
 *   "imported"   — DB row was missing/empty; written from JSON or .bak
 *   "skipped-existing-db" — DB row already has data; we left it alone
 *   "skipped-no-source"   — no JSON, no .bak; nothing to import
 *
 * Boolean compatibility: legacy callers only checked truthiness to decide
 * whether to follow up with `verify()`/rename. `"imported"` is the only
 * value that should trigger that follow-up; helpers below preserve that.
 */
export function importResearchFromJson(): ImportResult {
  if (researchRowExists()) return "skipped-existing-db";
  const body = readJsonWithBakFallback<unknown>(JSON_PATH);
  if (body == null) return "skipped-no-source";
  writeResearchBlob(body);
  return "imported";
}

/** Migration safety guard — true iff the DB row exists with a non-empty blob. */
export function researchRowExists(): boolean {
  try {
    const row = db.select().from(researchLab).where(eq(researchLab.id, KEY)).get();
    return !!(row && row.blob && row.blob.length > 2);
  } catch {
    return false;
  }
}
