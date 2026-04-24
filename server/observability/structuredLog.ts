/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — STRUCTURED LOG (spec §6)
 *
 * Single `logEvent()` entrypoint for every observability signal.
 *
 *   logEvent({ engine, event, level, data, runId })
 *
 * Writes a row to `engine_events` AND echoes a one-line console log so
 * existing grep-the-stdout ops continue to work. Safe by default:
 *   - DB write failures never throw
 *   - data is JSON-stringified with a size cap (8 KiB after serialization)
 *   - level defaults to "info"
 *
 * Used by:
 *   - engineRunWrapper (start / finish / error)
 *   - scheduler/registry (engine-enable / engine-skip / engine-start)
 *   - route handlers that want a durable signal the engines can query
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "../db.js";
import { engineEvents, ENGINE_EVENT_LEVELS, type EngineEventLevel } from "@shared/schema";
import { desc, eq } from "drizzle-orm";

export interface LogEventInput {
  engine: string;
  event: string;
  level?: EngineEventLevel;
  data?: unknown;
  runId?: number;
}

const MAX_DATA_BYTES = 8 * 1024;

function normalizeLevel(level: EngineEventLevel | undefined): EngineEventLevel {
  if (!level) return "info";
  return (ENGINE_EVENT_LEVELS as readonly string[]).includes(level) ? level : "info";
}

function encodeData(data: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(data ?? {});
  } catch {
    json = `{"_": "unserializable"}`;
  }
  if (Buffer.byteLength(json, "utf8") > MAX_DATA_BYTES) {
    return JSON.stringify({
      _: "truncated",
      head: json.slice(0, 2000),
    });
  }
  return json;
}

/** Primary entrypoint — structured log with DB persistence. */
export function logEvent(input: LogEventInput): void {
  const level = normalizeLevel(input.level);
  const payload = encodeData(input.data);

  try {
    db.insert(engineEvents)
      .values({
        engine: input.engine,
        event: input.event,
        level,
        data: payload,
        runId: input.runId,
        emittedAt: new Date().toISOString(),
      })
      .run();
  } catch (e: any) {
    // Observability should never break the caller's code path.
    console.warn("[StructuredLog] DB write failed:", e?.message);
  }

  // One-line console echo — matches the style of [LLM_ROUTE] / [ENGINE_RUN]
  const payloadShort = payload.length > 200 ? `${payload.slice(0, 197)}...` : payload;
  console.log(`[EVENT] engine=${input.engine} event=${input.event} level=${level}${input.runId ? ` run_id=${input.runId}` : ""} data=${payloadShort}`);
}

/** Fetch recent events (for the Diagnostics page / ops). */
export function recentEvents(opts: { engine?: string; level?: EngineEventLevel; limit?: number } = {}): any[] {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
  let q = db.select().from(engineEvents).orderBy(desc(engineEvents.id)).limit(limit);
  if (opts.engine) q = q.where(eq(engineEvents.engine, opts.engine)) as any;
  if (opts.level) q = q.where(eq(engineEvents.level, opts.level)) as any;
  return q.all();
}
