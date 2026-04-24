/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — ENGINE RUN WRAPPER (spec §3)
 *
 * Wraps the top-level run() of any scheduled engine and writes one row to
 * `engine_runs` with start/finish timestamps, duration, outcome, and an
 * `insights_emitted` delta (measured as the count of self-recommendations
 * proposed during the run). Propose-only — the wrapper observes, it never
 * applies or forces anything.
 *
 * The row is created immediately on start (status='running') so a crash is
 * visible. The row is updated to ok | error | skipped on completion. Lines
 * also stream through the structured logger (commit 6 expands that surface).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "../db.js";
import { engineRuns, selfRecommendations } from "@shared/schema";
import { count } from "drizzle-orm";

export type EngineOutcome = "ok" | "error" | "skipped";

export interface WrappedRunResult {
  runId: number;
  outcome: EngineOutcome;
  durationMs: number;
  insightsEmitted: number;
  error?: string;
  data?: unknown;
}

/**
 * Count rows in selfRecommendations — used to compute a delta across a run.
 * We use a simple count query because the ids are timestamp-prefixed so two
 * runs overlapping on the same millisecond are not a real concern for this
 * observability surface. If contention becomes real we'll promote this to a
 * per-run sentinel id range.
 */
function countRecs(): number {
  try {
    const row = db.select({ n: count() }).from(selfRecommendations).get();
    return Number((row as any)?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function runWrapped<T>(
  engine: string,
  fn: () => Promise<T> | T,
  opts: { triggeredBy?: string } = {},
): Promise<WrappedRunResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const triggeredBy = opts.triggeredBy ?? "scheduler";

  const insert = db
    .insert(engineRuns)
    .values({
      engine,
      startedAt,
      status: "running",
      insightsEmitted: 0,
      metricsJson: "{}",
      triggeredBy,
    })
    .returning()
    .get();
  const runId = insert.id;
  const recsBefore = countRecs();

  let outcome: EngineOutcome = "ok";
  let errorStr: string | undefined;
  let data: T | undefined;

  try {
    data = await fn();
  } catch (e: any) {
    outcome = "error";
    errorStr = (e?.message ?? String(e)).slice(0, 2000);
  }

  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - startedAtMs;
  const insightsEmitted = Math.max(0, countRecs() - recsBefore);

  try {
    db.update(engineRuns)
      .set({
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs,
        status: outcome,
        error: errorStr,
        insightsEmitted,
      })
      .where(
        // drizzle-orm's eq is imported lazily to avoid a circular with db.ts
        (await import("drizzle-orm")).eq(engineRuns.id, runId),
      )
      .run();
  } catch (e: any) {
    console.warn(`[EngineRunWrapper] failed to finalize row ${runId}:`, e?.message);
  }

  // Structured log (commit 6 will replace this console.log with a proper
  // structured logger; the semantic payload matches).
  console.log(
    `[ENGINE_RUN] engine=${engine} run_id=${runId} status=${outcome} duration_ms=${durationMs} insights_emitted=${insightsEmitted}${errorStr ? ` error=${errorStr.slice(0, 120)}` : ""}`,
  );

  return { runId, outcome, durationMs, insightsEmitted, error: errorStr, data };
}
