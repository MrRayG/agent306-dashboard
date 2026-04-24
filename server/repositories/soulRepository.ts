/**
 * soulRepository (spec §4) — wraps memory_soul + memory_soul_history.
 *
 * The soul blob is stored in a single row with id='current'. Every write
 * additionally inserts a history row so drift is auditable. Preserves
 * shape of memory_soul.json so existing callers see the same object.
 */

import { db } from "../db.js";
import { memorySoul, memorySoulHistory } from "@shared/schema";
import { desc, eq } from "drizzle-orm";
import { dataPath } from "../dataPaths.js";
import { readThrough, readJsonWithBakFallback } from "./jsonFallback.js";

const KEY = "current";
const JSON_PATH = dataPath("memory_soul.json");

export function readSoulBlob<T = unknown>(): T | null {
  return readThrough<T>({
    dbRead: () => {
      const row = db.select().from(memorySoul).where(eq(memorySoul.id, KEY)).get();
      if (!row) return null;
      try { return JSON.parse(row.blob) as T; } catch { return null; }
    },
    jsonPath: JSON_PATH,
  });
}

export function writeSoulBlob(blob: { version?: number } & Record<string, unknown>, reason?: string): void {
  const payload = JSON.stringify(blob);
  const now = new Date().toISOString();
  const version = Number(blob.version ?? 0);

  const existing = db.select().from(memorySoul).where(eq(memorySoul.id, KEY)).get();
  if (existing) {
    db.update(memorySoul)
      .set({ blob: payload, updatedAt: now })
      .where(eq(memorySoul.id, KEY))
      .run();
  } else {
    db.insert(memorySoul).values({ id: KEY, blob: payload, updatedAt: now }).run();
  }

  db.insert(memorySoulHistory).values({ version, blob: payload, capturedAt: now, reason }).run();
}

export function getSoulHistory(limit = 20): Array<{ version: number; capturedAt: string; reason: string | null; blob: string }> {
  const rows = db.select().from(memorySoulHistory).orderBy(desc(memorySoulHistory.id)).limit(limit).all();
  return rows.map(r => ({ version: r.version, capturedAt: r.capturedAt, reason: r.reason, blob: r.blob }));
}

export function importSoulFromJson(): boolean {
  const body = readJsonWithBakFallback<{ version?: number } & Record<string, unknown>>(JSON_PATH);
  if (body == null) return false;
  writeSoulBlob(body, "initial JSON import");
  return true;
}
