/**
 * Gap C — Experiment registration helpers.
 *
 * These functions are NOT called anywhere in Phase 0. They ship now so
 * Phase 1 (which registers the first experiment from the scheduler boot
 * path) is a one-line addition rather than a full helper-plus-call PR.
 *
 * Both writes invalidate the runtime cache so the next call to
 * `runExperiment()` sees the change without waiting for the cache TTL.
 *
 * See docs/EXPLORATION_POLICY.md §4.3.
 */

import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { experiments, EXPERIMENT_STATUSES, type ExperimentStatus } from "@shared/schema";
import { invalidateExperimentCache } from "./cache.js";

export interface RegisterExperimentInput {
  experimentKey: string;
  surface:       "modelRouter";  // Phase 0 only supports this
  taskKey:       string;
  baseline:      { model: string; provider: string };
  treatment:     { model: string; provider: string };
  trafficPct?:   number;          // default 0.1
  metricKey:     string;
  notes?:        string;
}

export type EndStatus = Exclude<ExperimentStatus, "running">;

/** Registers a new experiment as `running`. Returns `{ ok: false, reason }`
 *  on validation failure or duplicate key — never throws. On success the
 *  active-experiment cache is invalidated so the next dispatch sees the
 *  new row. */
export function registerExperiment(
  input: RegisterExperimentInput,
): { ok: boolean; reason?: string } {
  if (!input.experimentKey || typeof input.experimentKey !== "string") {
    return { ok: false, reason: "experimentKey is required" };
  }
  if (!input.taskKey || typeof input.taskKey !== "string") {
    return { ok: false, reason: "taskKey is required" };
  }
  if (!input.metricKey || typeof input.metricKey !== "string") {
    return { ok: false, reason: "metricKey is required" };
  }
  if (input.surface !== "modelRouter") {
    return { ok: false, reason: "Phase 0 only supports surface=modelRouter" };
  }
  const trafficPct = input.trafficPct ?? 0.1;
  if (!Number.isFinite(trafficPct) || trafficPct <= 0 || trafficPct >= 1) {
    return { ok: false, reason: "trafficPct must be in (0, 1)" };
  }
  if (!isArmConfig(input.baseline) || !isArmConfig(input.treatment)) {
    return {
      ok: false,
      reason: "baseline and treatment must each be { model: string, provider: string }",
    };
  }

  try {
    const existing = db.select()
      .from(experiments)
      .where(eq(experiments.experimentKey, input.experimentKey))
      .limit(1)
      .all();
    if (existing.length > 0) {
      return { ok: false, reason: "duplicate experimentKey" };
    }

    db.insert(experiments).values({
      experimentKey: input.experimentKey,
      surface:       input.surface,
      taskKey:       input.taskKey,
      baseline:      JSON.stringify(input.baseline),
      treatment:     JSON.stringify(input.treatment),
      trafficPct,
      metricKey:     input.metricKey,
      startedAt:     new Date().toISOString(),
      status:        "running",
      notes:         input.notes ?? null,
    }).run();
  } catch (e: any) {
    return { ok: false, reason: `db error: ${e?.message ?? e}` };
  }

  invalidateExperimentCache();
  return { ok: true };
}

/** Marks an experiment terminal (`ended`, `promoted`, or `rolled-back`).
 *  Returns `{ ok: false }` if the row doesn't exist or is already terminal.
 *  On success the cache is invalidated. */
export function endExperiment(
  experimentKey: string,
  terminalStatus: EndStatus,
): { ok: boolean; reason?: string } {
  if (!experimentKey || typeof experimentKey !== "string") {
    return { ok: false, reason: "experimentKey is required" };
  }
  // Guard against runtime callers (route handlers, scripts) passing a
  // status outside the type-allowed set — `as string` defangs the
  // narrowed union so the runtime check actually compiles.
  const ts = terminalStatus as string;
  if (!EXPERIMENT_STATUSES.includes(ts as ExperimentStatus) || ts === "running") {
    return { ok: false, reason: "terminalStatus must be one of ended|promoted|rolled-back" };
  }

  try {
    const row = db.select()
      .from(experiments)
      .where(eq(experiments.experimentKey, experimentKey))
      .limit(1)
      .all()[0];
    if (!row) return { ok: false, reason: "experiment not found" };
    if (row.status !== "running") {
      return { ok: false, reason: `experiment is already ${row.status}` };
    }

    db.update(experiments)
      .set({
        status:  terminalStatus,
        endedAt: new Date().toISOString(),
      })
      .where(eq(experiments.experimentKey, experimentKey))
      .run();
  } catch (e: any) {
    return { ok: false, reason: `db error: ${e?.message ?? e}` };
  }

  invalidateExperimentCache();
  return { ok: true };
}

function isArmConfig(c: unknown): c is { model: string; provider: string } {
  if (!c || typeof c !== "object") return false;
  const o = c as { model?: unknown; provider?: unknown };
  return typeof o.model === "string" && typeof o.provider === "string";
}
