/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PR-G — manual "known-bad" validity probe runner.
 *
 * Purpose: verify that the json_validity metric pipeline can actually detect
 * a known-bad LLM response. If the probe outcome is `caught` the pipeline
 * is healthy; if `missed` the metric is silently failing closed and any
 * 1.000 reading should be treated as suspect.
 *
 * The probe runs the EXACT SAME functions production trials run:
 *
 *   recordTrial(...)            // server/experiments/runExperiment.ts
 *     ↓ writes one row in experiment_trials with isProbe=true
 *   safeParseLLMJson(raw)       // server/safeParseLLMJson.ts
 *     ↓ same parse function callAnalysisLLM uses on real LLM output
 *   recordTrialOutcome(id, v)   // server/experiments/recordTrialOutcome.ts
 *     ↓ same outcome write the production grading path uses
 *
 * The ONLY difference vs a real trial is that we never make an HTTP call
 * to the LLM — instead we hand-craft a deliberately malformed response.
 * `safeParseLLMJson` and `recordTrialOutcome` see the exact same inputs
 * they would see if a real LLM had produced this output, so a "missed"
 * outcome is a real signal that the pipeline is broken.
 *
 * No cron, no schedule, no auto-trigger. Manual-only via the diagnostic
 * panel button.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { recordTrial } from "./runExperiment.js";
import { recordTrialOutcome } from "./recordTrialOutcome.js";
import { safeParseLLMJson } from "../safeParseLLMJson.js";

/**
 * Canonical malformation chosen for the probe — a non-JSON string with no
 * brace anywhere in it.
 *
 * Why this shape: `safeParseLLMJson` defends against the two most common
 * real-world failure modes (markdown fences and truncated braces) and
 * ATTEMPTS to repair them. A "truncated brace" probe would be silently
 * repaired and would falsely report `caught=false` even though the
 * pipeline is doing its job. A pure-prose response with no brace at all
 * is the canonical irrecoverable failure: `extractOutermostJson` finds
 * nothing, the truncation repairs do nothing, the markdown-prose
 * fallback doesn't match. Parser returns null → outcome 0.0 → caught.
 *
 * Keeping this string fixed across runs makes "caught" / "missed"
 * stable signal: a regression in the parser that suddenly accepts this
 * input as JSON would flip the probe to `missed` and the dashboard
 * would surface it.
 */
export const KNOWN_BAD_PROBE_INPUT =
  "This is not JSON at all — the LLM hallucinated a sentence instead of an object.";

/** Probe metadata persisted to the trial row. */
export const PROBE_EXPERIMENT_KEY = "validity-known-bad-probe";
export const PROBE_TASK_KEY       = "analysis-intake-probe";
export const PROBE_RESOLVED_MODEL = "n/a-known-bad-probe";

export type ProbeOutcome = "caught" | "missed";

export interface ProbeResult {
  /** Synthetic id for the probe invocation (timestamp-based, distinct from
   *  the trial row id so the UI can reference both). */
  probeId: string;
  /** experiment_trials.id of the row written for this probe. `null` only
   *  when the DB write failed (recordTrial swallows errors). */
  trialRecordId: number | null;
  /** caught = parser returned null → outcome recorded as 0.0 (correct
   *  behavior for the malformed input). missed = parser returned a
   *  non-null value → outcome recorded as 1.0 even though the input was
   *  obviously malformed (metric is broken upstream). */
  outcome: ProbeOutcome;
  /** ISO timestamp the probe was triggered. */
  triggeredAt: string;
  /** Echo of the malformation we sent through the pipeline. Useful for
   *  the UI's "raw record" expander. */
  malformedInput: string;
  /** Numeric outcome metric written to the trial row (0.0 or 1.0). */
  outcomeMetric: number;
}

/** Inject the canonical malformation through the real metric pipeline.
 *  Returns enough information for the panel to render the result inline. */
export function runKnownBadProbe(): ProbeResult {
  const triggeredAt = new Date().toISOString();
  const probeId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // 1. Write a trial row marked isProbe=true. Same writer the production
  //    dispatch path uses (server/experiments/runExperiment.ts:recordTrial).
  const trialRecordId = recordTrial({
    experimentKey: PROBE_EXPERIMENT_KEY,
    arm:           "baseline",
    taskKey:       PROBE_TASK_KEY,
    resolvedModel: PROBE_RESOLVED_MODEL,
    isProbe:       true,
  });

  // 2. Run the exact parse function callAnalysisLLM uses on real LLM
  //    responses. If the parser correctly rejects the malformation it
  //    returns null; if it accepts (i.e. recovers structured data from
  //    the prose) the metric pipeline is broken.
  const parsed = safeParseLLMJson(KNOWN_BAD_PROBE_INPUT, "ValidityProbe.knownBad");
  const outcomeMetric = parsed === null ? 0.0 : 1.0;
  const outcome: ProbeOutcome = parsed === null ? "caught" : "missed";

  // 3. Persist the outcome via the production grading path so the row
  //    looks identical in shape to any real graded trial.
  if (trialRecordId !== null) {
    recordTrialOutcome(trialRecordId, outcomeMetric);
  }

  return {
    probeId,
    trialRecordId,
    outcome,
    triggeredAt,
    malformedInput: KNOWN_BAD_PROBE_INPUT,
    outcomeMetric,
  };
}
