/**
 * ─────────────────────────────────────────────────────────────────────────────
 * JSON → DB read-through shim (spec §4)
 *
 * Every repository calls `readThrough()` with a DB reader + JSON file path.
 * If USE_DB_STATE === "false", JSON wins unconditionally. Otherwise:
 *
 *   1. Try the DB reader.
 *   2. If the DB row is absent OR the DB read throws, fall back to JSON.
 *   3. If JSON is also absent, return null. Callers supply a default.
 *
 * Writes go to DB only. The migration script copies JSON → DB and renames
 * the JSON file to `<name>.bak` so the JSON path stays available for
 * disaster recovery without competing for writes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";

export function isDbStateEnabled(): boolean {
  // Default true per spec. Explicit "false" disables.
  const v = (process.env.USE_DB_STATE ?? "true").toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

export interface ReadThroughOpts<T> {
  dbRead: () => T | null | undefined;
  jsonPath: string;
  onFallback?: (source: "json" | "missing") => void;
}

export function readThrough<T>(opts: ReadThroughOpts<T>): T | null {
  if (!isDbStateEnabled()) {
    return readJson<T>(opts.jsonPath, opts.onFallback);
  }
  try {
    const row = opts.dbRead();
    if (row != null) return row;
  } catch (e: any) {
    console.warn("[Repository] DB read failed, falling back to JSON:", e?.message);
  }
  return readJson<T>(opts.jsonPath, opts.onFallback);
}

function readJson<T>(path: string, onFallback?: (source: "json" | "missing") => void): T | null {
  try {
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf8");
      onFallback?.("json");
      return JSON.parse(raw) as T;
    }
  } catch (e: any) {
    console.warn(`[Repository] JSON read failed ${path}:`, e?.message);
  }
  onFallback?.("missing");
  return null;
}

/** Attempt the .bak file too (post-migration). */
export function readJsonWithBakFallback<T>(path: string): T | null {
  const primary = readJson<T>(path);
  if (primary) return primary;
  return readJson<T>(`${path}.bak`);
}
