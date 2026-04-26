/**
 * Gap C — Phase 1 outcome recorder.
 *
 * Updates a single `experiment_trials` row with an outcome metric value.
 * Called once per dispatched routine-tier task after the response has
 * been graded (e.g. JSON validity = 1.0 if `safeParseLLMJson` returned a
 * non-null object, 0.0 otherwise).
 *
 * Idempotency policy (chosen): re-recording is **rejected** — the first
 * write wins, subsequent writes return `{ ok: false, reason: "already_recorded" }`.
 * This is appropriate for routine-tier tasks where a single LLM dispatch
 * produces exactly one outcome; collapsing multiple grades into a single
 * row would silently lose signal. Tests pin this contract.
 *
 * Like `recordTrial`, this helper NEVER throws — the dispatch path stays
 * alive on a DB write failure.
 *
 * See docs/EXPLORATION_POLICY.md §3.2.
 */

import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db.js";
import { experimentTrials } from "@shared/schema";

export type RecordTrialOutcomeResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Attach an outcome metric to a previously-written trial row. The first
 *  successful write wins; subsequent calls for the same trial id are
 *  rejected with `reason: "already_recorded"`. */
export function recordTrialOutcome(
  trialId: number,
  metricValue: number,
): RecordTrialOutcomeResult {
  if (!Number.isInteger(trialId) || trialId <= 0) {
    return { ok: false, reason: "trialId must be a positive integer" };
  }
  if (!Number.isFinite(metricValue)) {
    return { ok: false, reason: "metricValue must be a finite number" };
  }

  try {
    // Conditional update — only writes when outcome_metric is still NULL.
    // Drizzle's `.run()` returns a result with `changes` (better-sqlite3
    // backed) so we can detect the "already recorded" case without a
    // round-trip read.
    const result = db.update(experimentTrials)
      .set({
        outcomeMetric:     metricValue,
        outcomeRecordedAt: new Date().toISOString(),
      })
      .where(and(
        eq(experimentTrials.id, trialId),
        isNull(experimentTrials.outcomeMetric),
      ))
      .run();

    const changes = (result as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      // Either the trial id doesn't exist OR outcome was already recorded.
      // Disambiguate so callers can log informatively.
      const row = db.select()
        .from(experimentTrials)
        .where(eq(experimentTrials.id, trialId))
        .limit(1)
        .all()[0];
      if (!row) return { ok: false, reason: "trial not found" };
      return { ok: false, reason: "already_recorded" };
    }
    return { ok: true };
  } catch (e: any) {
    console.warn("[experiments] recordTrialOutcome failed:", e?.message ?? e);
    return { ok: false, reason: `db error: ${e?.message ?? e}` };
  }
}
