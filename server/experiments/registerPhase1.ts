/**
 * Gap C — Phase 1 boot-time registration helper.
 *
 * Wraps `registerExperiment(PHASE1_EXPERIMENT)` with the gating + logging
 * contract enforced at scheduler startup:
 *   - feature-flag OFF (default): silent skip + one info log line, no DB write
 *   - feature-flag ON: idempotent register; duplicate-key path on subsequent
 *     boots is a no-op + info log
 *   - any thrown error is logged at warn level and swallowed so the
 *     scheduler keeps booting
 *
 * Lives in its own module so it can be unit-tested without spinning the
 * full scheduler.
 */

import { featureFlags } from "../featureFlags.js";
import { logEvent } from "../observability/structuredLog.js";
import { registerExperiment as defaultRegisterExperiment } from "./registerExperiment.js";
import { PHASE1_EXPERIMENT } from "./phase1Experiment.js";

/** Optional override hook for tests — production callers leave this
 *  undefined and pick up the real `registerExperiment` import. */
export interface RegisterPhase1Deps {
  registerExperiment?: typeof defaultRegisterExperiment;
}

export function registerPhase1Experiment(deps: RegisterPhase1Deps = {}): void {
  const registerExperiment = deps.registerExperiment ?? defaultRegisterExperiment;

  if (!featureFlags.experimentExploration) {
    console.log("[ExperimentBoot] experimentExploration flag OFF — skipping registration");
    logEvent({
      engine: "experiments",
      event:  "experiment_registration_skipped",
      data:   { reason: "flag_off", experimentKey: PHASE1_EXPERIMENT.experimentKey },
    });
    return;
  }
  try {
    const r = registerExperiment(PHASE1_EXPERIMENT);
    if (r.ok) {
      console.log(
        `[ExperimentBoot] registered experiment_key=${PHASE1_EXPERIMENT.experimentKey} ` +
        `baseline=${PHASE1_EXPERIMENT.baseline.model} ` +
        `treatment=${PHASE1_EXPERIMENT.treatment.model} ` +
        `trafficPct=${PHASE1_EXPERIMENT.trafficPct}`,
      );
      logEvent({
        engine: "experiments",
        event:  "experiment_registered",
        data: {
          experimentKey: PHASE1_EXPERIMENT.experimentKey,
          taskKey:       PHASE1_EXPERIMENT.taskKey,
          baseline:      PHASE1_EXPERIMENT.baseline.model,
          treatment:     PHASE1_EXPERIMENT.treatment.model,
          trafficPct:    PHASE1_EXPERIMENT.trafficPct,
        },
      });
    } else {
      const dup = /duplicate/i.test(r.reason ?? "");
      console.log(
        `[ExperimentBoot] registration ${dup ? "no-op (already registered)" : "failed"}: ${r.reason ?? "unknown"}`,
      );
      logEvent({
        engine: "experiments",
        event:  dup ? "experiment_already_registered" : "experiment_registration_failed",
        level:  dup ? "info" : "warn",
        data:   { experimentKey: PHASE1_EXPERIMENT.experimentKey, reason: r.reason },
      });
    }
  } catch (e: any) {
    console.warn(`[ExperimentBoot] registration threw — continuing scheduler boot: ${e?.message ?? e}`);
    logEvent({
      engine: "experiments",
      event:  "experiment_registration_failed",
      level:  "warn",
      data:   { experimentKey: PHASE1_EXPERIMENT.experimentKey, error: e?.message ?? String(e) },
    });
  }
}
