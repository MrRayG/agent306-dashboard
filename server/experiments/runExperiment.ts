/**
 * Gap C — A/B assignment helper.
 *
 * `runExperiment(taskKey)` is called once by `modelRouter.resolveTask`.
 * It returns:
 *   - `null` when the flag is off (default — zero behavior change)
 *   - `null` when the flag is on but no experiment is registered for this taskKey
 *   - `ExperimentAssignment` when an experiment is active — the caller
 *     uses `resolvedModel`/`resolvedProvider` to override its routing
 *
 * `recordTrial` is the side-effect write into `experiment_trials`. It is
 * wrapped in try/catch and swallows errors with a `console.warn`, so a
 * trial-table write failure can NEVER break the LLM dispatch path. This
 * mirrors `server/calibration/hypothesisOutcomes.ts:recordOutcome` exactly.
 *
 * See docs/EXPLORATION_POLICY.md §4.1.
 */

import { db } from "../db.js";
import { experimentTrials } from "@shared/schema";
import { featureFlags } from "../featureFlags.js";
import { lookupActiveExperimentForTask } from "./cache.js";

export interface ExperimentAssignment {
  /** Key of the experiment that produced this assignment. */
  experimentKey: string;
  arm: "baseline" | "treatment";
  /** The model the dispatch path should actually call. */
  resolvedModel: string;
  /** The provider the dispatch path should route through. */
  resolvedProvider: string;
  /** Rowid of the `experiment_trials` row written for this assignment.
   *  Phase 1 metric callers use it to correlate the LLM response back to
   *  this trial via `recordTrialOutcome`. `null` if the trial-row write
   *  failed (recordTrial swallows DB errors). */
  trialId: number | null;
}

/** Parses an arm config blob. Returns null when the JSON is malformed
 *  or missing the required fields — caller treats null as "no override". */
function parseArmConfig(raw: string): { model: string; provider: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.model !== "string" || typeof parsed.provider !== "string") {
      return null;
    }
    return { model: parsed.model, provider: parsed.provider };
  } catch {
    return null;
  }
}

/** Writes one row into `experiment_trials`. Never throws — a write
 *  failure must not break the dispatch path. Returns the inserted rowid
 *  (or `null` if the write failed) so the caller can later attach an
 *  outcome metric via `recordTrialOutcome`. */
export function recordTrial(args: {
  experimentKey: string;
  arm: "baseline" | "treatment";
  taskKey: string;
  resolvedModel: string;
}): number | null {
  try {
    const result = db.insert(experimentTrials)
      .values({
        experimentKey: args.experimentKey,
        arm:           args.arm,
        taskKey:       args.taskKey,
        resolvedModel: args.resolvedModel,
        // contextHash is populated by Phase 2 — see
        // docs/EXPLORATION_POLICY.md §3.2. outcomeMetric is filled in by
        // Phase 1's recordTrialOutcome when the response is graded.
      })
      .run();
    const rowid = result.lastInsertRowid;
    return typeof rowid === "bigint" ? Number(rowid) : (rowid ?? null);
  } catch (e: any) {
    console.warn("[experiments] recordTrial failed:", e?.message ?? e);
    return null;
  }
}

/** Returns the arm assignment for `taskKey`, or null when no experiment
 *  is active (or the flag is off). On non-null returns, also writes one
 *  row into `experiment_trials`. Pure decision logic otherwise — no LLM,
 *  no network. */
export function runExperiment(taskKey: string): ExperimentAssignment | null {
  if (!featureFlags.experimentExploration) return null;

  const exp = lookupActiveExperimentForTask(taskKey);
  if (!exp) return null;

  // Math.random is sufficient for the 10% rollouts Phase 1 will use.
  // For tiny canary surfaces (<1%) Phase 3 may switch to a hash-based
  // assignment for stability — design §10 (non-goals).
  const arm: "baseline" | "treatment" =
    Math.random() < exp.trafficPct ? "treatment" : "baseline";

  const cfg = parseArmConfig(arm === "treatment" ? exp.treatment : exp.baseline);
  if (!cfg) {
    // Malformed arm config — fail closed to "no override" rather than
    // crash the dispatch. The registration helper validates JSON shape
    // at write time, so this branch only fires if a row was hand-edited.
    console.warn(
      `[experiments] active experiment ${exp.experimentKey} has unparsable ${arm} config; skipping override`,
    );
    return null;
  }

  const trialId = recordTrial({
    experimentKey: exp.experimentKey,
    arm,
    taskKey,
    resolvedModel: cfg.model,
  });

  return {
    experimentKey:    exp.experimentKey,
    arm,
    resolvedModel:    cfg.model,
    resolvedProvider: cfg.provider,
    trialId,
  };
}
