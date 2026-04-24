/**
 * researchRepository (spec §4) — wraps research_lab.
 */

import { db } from "../db.js";
import { researchLab } from "@shared/schema";
import { eq } from "drizzle-orm";
import { dataPath } from "../dataPaths.js";
import { readThrough, readJsonWithBakFallback } from "./jsonFallback.js";

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

export function importResearchFromJson(): boolean {
  const body = readJsonWithBakFallback<unknown>(JSON_PATH);
  if (body == null) return false;
  writeResearchBlob(body);
  return true;
}
