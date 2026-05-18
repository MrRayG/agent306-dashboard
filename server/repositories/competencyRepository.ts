/**
 * competencyRepository (spec §4) — wraps competencyProfile.
 */

import { db } from "../db.js";
import { competencyProfileTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { dataPath } from "../dataPaths.js";
import { readThrough, readJsonWithBakFallback, type ImportResult } from "./jsonFallback.js";

const KEY = "main";
const JSON_PATH = dataPath("competencyProfile.json");

export function readCompetencyBlob<T = unknown>(): T | null {
  return readThrough<T>({
    dbRead: () => {
      const row = db.select().from(competencyProfileTable).where(eq(competencyProfileTable.id, KEY)).get();
      if (!row) return null;
      try { return JSON.parse(row.blob) as T; } catch { return null; }
    },
    jsonPath: JSON_PATH,
  });
}

export function writeCompetencyBlob(blob: unknown): void {
  const payload = JSON.stringify(blob);
  const existing = db.select().from(competencyProfileTable).where(eq(competencyProfileTable.id, KEY)).get();
  if (existing) {
    db.update(competencyProfileTable)
      .set({ blob: payload, updatedAt: new Date().toISOString() })
      .where(eq(competencyProfileTable.id, KEY))
      .run();
  } else {
    db.insert(competencyProfileTable).values({ id: KEY, blob: payload }).run();
  }
}

/**
 * First-run-only JSON→DB import. If the DB row already has a non-empty
 * blob, we do NOT overwrite it from JSON/.bak — see
 * researchRepository.importResearchFromJson for the full contract.
 */
export function importCompetencyFromJson(): ImportResult {
  if (competencyRowExists()) return "skipped-existing-db";
  const body = readJsonWithBakFallback<unknown>(JSON_PATH);
  if (body == null) return "skipped-no-source";
  writeCompetencyBlob(body);
  return "imported";
}

/** Migration safety guard — true iff the DB row exists with a non-empty blob. */
export function competencyRowExists(): boolean {
  try {
    const row = db.select().from(competencyProfileTable).where(eq(competencyProfileTable.id, KEY)).get();
    return !!(row && row.blob && row.blob.length > 2);
  } catch {
    return false;
  }
}
