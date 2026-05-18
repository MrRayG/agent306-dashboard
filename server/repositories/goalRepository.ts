/**
 * goalRepository (spec §4) — wraps agent_goals.
 *
 * Stores the full agent_goals.json blob under id='main'. Callers in
 * researchEngine (which owns goal CRUD) can migrate to this repo in a
 * subsequent PR without a shape change.
 */

import { db } from "../db.js";
import { agentGoals } from "@shared/schema";
import { eq } from "drizzle-orm";
import { dataPath } from "../dataPaths.js";
import { readThrough, readJsonWithBakFallback, type ImportResult } from "./jsonFallback.js";

const KEY = "main";
const JSON_PATH = dataPath("agent_goals.json");

export function readGoalsBlob<T = unknown>(): T | null {
  return readThrough<T>({
    dbRead: () => {
      const row = db.select().from(agentGoals).where(eq(agentGoals.id, KEY)).get();
      if (!row) return null;
      try { return JSON.parse(row.blob) as T; } catch { return null; }
    },
    jsonPath: JSON_PATH,
  });
}

export function writeGoalsBlob(blob: unknown): void {
  const payload = JSON.stringify(blob);
  const existing = db.select().from(agentGoals).where(eq(agentGoals.id, KEY)).get();
  if (existing) {
    db.update(agentGoals)
      .set({ blob: payload, updatedAt: new Date().toISOString() })
      .where(eq(agentGoals.id, KEY))
      .run();
  } else {
    db.insert(agentGoals).values({ id: KEY, blob: payload }).run();
  }
}

/**
 * First-run-only JSON→DB import. If the DB row already has a non-empty
 * blob, we do NOT overwrite it from JSON/.bak — see
 * researchRepository.importResearchFromJson for the full contract.
 */
export function importGoalsFromJson(): ImportResult {
  if (goalsRowExists()) return "skipped-existing-db";
  const body = readJsonWithBakFallback<unknown>(JSON_PATH);
  if (body == null) return "skipped-no-source";
  writeGoalsBlob(body);
  return "imported";
}

/** Migration safety guard — true iff the DB row exists with a non-empty blob. */
export function goalsRowExists(): boolean {
  try {
    const row = db.select().from(agentGoals).where(eq(agentGoals.id, KEY)).get();
    return !!(row && row.blob && row.blob.length > 2);
  } catch {
    return false;
  }
}
