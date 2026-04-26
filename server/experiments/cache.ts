/**
 * Active-experiment lookup cache.
 *
 * `runExperiment(taskKey)` is on the LLM dispatch hot path (`resolveTask`).
 * We can't hit SQLite on every dispatch — the whole point of the gating
 * model is that the no-experiment case is essentially free.
 *
 * This module loads all `status="running"` rows once, builds a Map keyed
 * by `taskKey`, and serves subsequent lookups from memory. Refresh
 * triggers:
 *   1. 60-second TTL — picks up rows registered by another path that
 *      didn't call `invalidateExperimentCache()` (defense in depth).
 *   2. Explicit `invalidateExperimentCache()` — called by
 *      registerExperiment / endExperiment so the next lookup sees the
 *      change immediately.
 *
 * Single-process cache. Agent 306 is single-process today; revisit if
 * that changes (e.g., the cache becomes stale across forked workers).
 *
 * See docs/EXPLORATION_POLICY.md §4.4.
 */

import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { experiments, type Experiment } from "@shared/schema";

const TTL_MS = 60_000;

let cache: Map<string, Experiment> | null = null;
let cacheLoadedAt = 0;

function loadCache(): Map<string, Experiment> {
  const map = new Map<string, Experiment>();
  try {
    const rows = db.select()
      .from(experiments)
      .where(eq(experiments.status, "running"))
      .all();
    for (const row of rows) {
      // Last-write-wins for duplicate taskKey across active experiments.
      // Phase 0 doesn't allow concurrent experiments on the same task in
      // practice (Phase 1 registers exactly one), but the schema doesn't
      // forbid it; a future PR adding multi-experiment-per-task support
      // would replace this with a list.
      map.set(row.taskKey, row as Experiment);
    }
  } catch (e: any) {
    // A read failure here means we cannot prove an experiment exists.
    // Fail closed to "no experiment" — the dispatch path stays on its
    // baseline. Empty map.
    console.warn("[experiments] cache load failed:", e?.message ?? e);
  }
  return map;
}

/** Returns the active experiment (if any) for the given task key.
 *  Refreshes the cache on first call OR after the TTL OR after an
 *  explicit invalidation. */
export function lookupActiveExperimentForTask(taskKey: string): Experiment | null {
  const now = Date.now();
  if (cache === null || now - cacheLoadedAt > TTL_MS) {
    cache = loadCache();
    cacheLoadedAt = now;
  }
  return cache.get(taskKey) ?? null;
}

/** Force the next lookup to reload from the DB. Called by
 *  registerExperiment and endExperiment so a freshly-registered
 *  experiment is visible on the next dispatch without waiting for
 *  the TTL to tick. */
export function invalidateExperimentCache(): void {
  cache = null;
  cacheLoadedAt = 0;
}

// ── Test-only helpers ──────────────────────────────────────────────────────
// Not exported for production use — tests need to override the cache
// state without monkey-patching the module. Each helper is idempotent.

/** @internal — for tests only. */
export function _setCacheForTest(map: Map<string, Experiment> | null): void {
  cache = map;
  cacheLoadedAt = map === null ? 0 : Date.now();
}
