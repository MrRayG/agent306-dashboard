/**
 * memoryRepository (spec §4) — wraps memory_knowledge.
 *
 * Stores the full KnowledgeMemory blob under id='main'. This preserves the
 * existing shape byte-identically so memoryEngine callers can migrate one
 * at a time without a shape change.
 */

import { db } from "../db.js";
import { memoryKnowledge } from "@shared/schema";
import { eq } from "drizzle-orm";
import { dataPath } from "../dataPaths.js";
import { readThrough, readJsonWithBakFallback, type ImportResult } from "./jsonFallback.js";

const KEY = "main";
const JSON_PATH = dataPath("memory_knowledge.json");

export function readMemoryKnowledgeBlob<T = unknown>(): T | null {
  return readThrough<T>({
    dbRead: () => {
      const row = db.select().from(memoryKnowledge).where(eq(memoryKnowledge.id, KEY)).get();
      if (!row) return null;
      try {
        return JSON.parse(row.blob) as T;
      } catch {
        return null;
      }
    },
    jsonPath: JSON_PATH,
  });
}

export function writeMemoryKnowledgeBlob(blob: unknown): void {
  const payload = JSON.stringify(blob);
  const existing = db.select().from(memoryKnowledge).where(eq(memoryKnowledge.id, KEY)).get();
  if (existing) {
    db.update(memoryKnowledge)
      .set({ blob: payload, updatedAt: new Date().toISOString() })
      .where(eq(memoryKnowledge.id, KEY))
      .run();
  } else {
    db.insert(memoryKnowledge).values({ id: KEY, blob: payload }).run();
  }
}

/**
 * First-run-only JSON→DB import. Used by the migration script. See
 * researchRepository.importResearchFromJson for the full contract — if the
 * DB row already has data, we do NOT overwrite it from JSON/.bak.
 */
export function importMemoryKnowledgeFromJson(): ImportResult {
  if (memoryKnowledgeRowExists()) return "skipped-existing-db";
  const body = readJsonWithBakFallback<unknown>(JSON_PATH);
  if (body == null) return "skipped-no-source";
  writeMemoryKnowledgeBlob(body);
  return "imported";
}

/** Migration safety guard — true iff the DB row exists with a non-empty blob. */
export function memoryKnowledgeRowExists(): boolean {
  try {
    const row = db.select().from(memoryKnowledge).where(eq(memoryKnowledge.id, KEY)).get();
    return !!(row && row.blob && row.blob.length > 2);
  } catch {
    return false;
  }
}
