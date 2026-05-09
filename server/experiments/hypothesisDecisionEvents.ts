/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2d: HYPOTHESIS DECISION EVIDENCE PERSISTENCE
 *
 * Phase 2c produced an `ExperimentDecision`: a deterministic, propose-only
 * verdict (`promote | reject | continue | needs_review`) computed from a
 * Phase 2b `MetricBinding`, per-arm aggregates, optional cost figures, and
 * optional guardrail outcomes. Phase 2c does not write anything — it returns
 * a verdict and the evidence that supports it.
 *
 * Phase 2d closes the next narrow gap: persisting that evidence package as an
 * append-only audit trail. An operator (or a future review surface) can read
 * back exactly what the system decided, when, and on what basis — without
 * having to recompute it.
 *
 * The output is one `HypothesisDecisionEvent` per call to `appendDecisionEvent`,
 * stored as one JSONL line in `data/experiment_decision_events.jsonl`. The file
 * is read by `readDecisionEvents` / `readDecisionEventsTail`. The DATA_DIR
 * resolver (`server/dataPaths.ts`) routes the path through `process.env.DATA_DIR`
 * so tests can isolate the ledger to a temp directory.
 *
 * This module is intentionally:
 *   - APPEND-ONLY: each call writes a single JSONL line; existing lines are
 *     never rewritten. A torn write or a corrupt line never corrupts prior
 *     records — the reader skips bad lines and continues.
 *   - PROPOSE-ONLY: appending an event MUST NOT mutate hypothesis status,
 *     experiment registration, promotion / retraction state, memory entries,
 *     or any other engine state. The ledger is a record store — nothing more.
 *     This mirrors `improvementArchive.ts` and the propose-only invariant in
 *     `selfRecommendationEngine.ts` (see CLAUDE.md self-evolution policy).
 *   - DEFENSE-IN-DEPTH: the input is typed as the Phase 2c `ExperimentDecision`,
 *     so a refusal or a hand-rolled record cannot be persisted. The validator
 *     checks the verdict + reasonCode are in the closed enum and that the
 *     hypothesisId / metricKey / decidedAt fields are non-empty strings before
 *     writing. A malformed decision returns a structured refusal and writes
 *     nothing.
 *   - DETERMINISTIC EVENT IDS: `eventId = evt_<unix-ms>_<6-char-base36>` —
 *     unique per process, sortable by time, prefix-stable for log grep.
 *   - ISOLATED FOR TESTS: the file path is resolved via `dataPath()` on every
 *     call (not at import time) so a test that sets `DATA_DIR` after the
 *     module is loaded still gets the redirected path.
 *
 * Out of scope for Phase 2d (deferred to Phase 2e / 2f):
 *   - Sandboxed execution wiring: a daily-cycle / scheduler helper that
 *     consumes `ExperimentDecision`s from the ledger and calls a registration
 *     or promotion helper. Phase 2d does not run experiments — it only
 *     persists the verdicts the Phase 2c rule already produced.
 *   - Meta-reflection / lessons database: a layer that reads the ledger and
 *     summarises what the system has learned (which thresholds fire most
 *     often, which guardrails dominate, how often `needs_review` resolves to
 *     promote vs. reject). Phase 2d gives 2f the raw input — it does not
 *     compute the summary.
 *   - Promotion event persistence (`promotion_events` / `retraction_events`)
 *     and the schema migrations that come with it. The decision-events
 *     ledger is a *proposal* record. An applied promotion is a different
 *     record type and lives in a different table.
 *   - Dashboard UI surfaces over the ledger.
 *   - Migrating live data: this module ships with an empty ledger; existing
 *     deployments do not need a backfill.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "../dataPaths.js";
import type {
  ExperimentDecision,
  ExperimentDecisionVerdict,
  ExperimentDecisionReasonCode,
  ExperimentDecisionThresholds,
} from "./hypothesisExperimentDecision.js";

// ── Storage location ─────────────────────────────────────────────────────────
//
// Resolved on every call (not at import) so a test that sets DATA_DIR after
// the module is imported still sees the redirected path. Same convention as
// improvementArchive.ts but with per-call resolution to be friendly to
// dynamic-import test harnesses.

const LEDGER_FILENAME = "experiment_decision_events.jsonl";

function ledgerPath(): string {
  return dataPath(LEDGER_FILENAME);
}

// ── Verdict / reason enums (mirrored from Phase 2c) ─────────────────────────
//
// Re-exporting the closed enum members here lets the validator branch on a
// stable value set without re-importing Phase 2c. New verdicts/codes are an
// additive change in Phase 2c and require an update here.

const VALID_VERDICTS: readonly ExperimentDecisionVerdict[] = [
  "promote",
  "reject",
  "continue",
  "needs_review",
];

const VALID_REASON_CODES: readonly ExperimentDecisionReasonCode[] = [
  "missing_aggregate",
  "invalid_aggregate",
  "ambiguous_guardrail",
  "insufficient_sample",
  "inconclusive",
  "guardrail_failure",
  "primary_metric_worse",
  "cost_up_without_improvement",
  "primary_metric_better",
];

function isValidVerdict(v: unknown): v is ExperimentDecisionVerdict {
  return typeof v === "string" && (VALID_VERDICTS as readonly string[]).includes(v);
}

function isValidReasonCode(c: unknown): c is ExperimentDecisionReasonCode {
  return typeof c === "string" && (VALID_REASON_CODES as readonly string[]).includes(c);
}

// ── Event shape ─────────────────────────────────────────────────────────────

/**
 * Optional, lightweight binding summary echoed onto the event so an audit
 * reader does not need a join. The full Phase 2b `MetricBinding` carries
 * additional registry-internal fields (description, matched aliases) that we
 * intentionally do NOT persist here — the ledger is a decision record, not a
 * registry snapshot. If a future surface wants the registry text, it can
 * look up the metricKey at read time.
 */
export interface DecisionEventBindingSummary {
  hypothesisId:       string;
  metricKey:          string;
  matchedDataSources: string[];
}

/**
 * One persisted decision evidence event. Each call to `appendDecisionEvent`
 * produces exactly one of these and writes one JSONL line.
 */
export interface HypothesisDecisionEvent {
  /** Unique per process; format: `evt_<unix-ms>_<6-char-base36>`. */
  eventId:        string;
  /** ISO timestamp the event was appended. May differ from `decidedAt` if
   *  the caller persisted out-of-band. */
  recordedAt:     string;
  /** The Phase 2c `decidedAt` from the input — when the rule fired. */
  decidedAt:      string;
  /** The hypothesis the decision is about. */
  hypothesisId:   string;
  /** Optional experiment / candidate identifier when the caller has one
   *  (e.g. an `experiments.id` from `registerExperiment`, or an internal
   *  candidate handle). Phase 2c does not produce one — Phase 2e will. */
  experimentId?:  string;
  candidateId?:   string;
  /** The metric the decision is about. Echoed from the binding. */
  metricKey:      string;
  decision:       ExperimentDecisionVerdict;
  reasonCode:     ExperimentDecisionReasonCode;
  /** One-sentence narrative; same value as `ExperimentDecision.reason`. */
  reason:         string;
  /** Concrete observation list from `ExperimentDecision.evidence`. */
  evidence:       string[];
  /** Stable label for the rule revision that produced this decision. The
   *  Phase 2c module is unversioned today; we tag every event with the
   *  current rule version so a future change to the threshold layer is
   *  diffable in the ledger. */
  ruleVersion:    string;
  /** Operator-supplied source / actor label, e.g. "phase2c-cron",
   *  "operator:rey", "test:fixture". Free text; non-empty. */
  source:         string;
  /** Optional lightweight summary of the binding the decision was based on. */
  binding?:       DecisionEventBindingSummary;
  /** Echo of `thresholdsUsed` from the Phase 2c decision so an audit reader
   *  does not have to cross-reference defaults. */
  thresholdsUsed: Required<ExperimentDecisionThresholds>;
}

// ── Append result ───────────────────────────────────────────────────────────

export interface AppendDecisionEventInput {
  /** The Phase 2c decision to persist. Must be a fully-formed
   *  `ExperimentDecision` — refusals cannot be passed by construction. */
  decision:      ExperimentDecision;
  /** Free-text actor / pipeline label. Non-empty. */
  source:        string;
  /** Stable rule version label, e.g. `"phase2c.v1"`. Non-empty. */
  ruleVersion:   string;
  /** Optional experiment row id the decision relates to. */
  experimentId?: string;
  /** Optional internal candidate handle. */
  candidateId?:  string;
  /** Optional binding summary; usually built from the same `MetricBinding`
   *  that produced the decision. When omitted, only the metricKey from the
   *  decision is persisted. */
  binding?:      DecisionEventBindingSummary;
}

export type AppendDecisionEventResult =
  | { ok: true;  event: HypothesisDecisionEvent }
  | { ok: false; reason: string };

// ── Helpers ─────────────────────────────────────────────────────────────────

function nextEventId(): string {
  // Six base36 chars + ms timestamp gives ~36^6 ≈ 2.1B unique ids per ms;
  // collisions are not possible in a single-process append path.
  return `evt_${Date.now()}_${Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0")}`;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function validateDecision(d: ExperimentDecision | undefined): string | null {
  if (!d || typeof d !== "object") return "decision is missing or not an object";
  if (!isNonEmptyString(d.hypothesisId)) return "decision.hypothesisId is missing or empty";
  if (!isNonEmptyString(d.metricKey))    return "decision.metricKey is missing or empty";
  if (!isNonEmptyString(d.decidedAt))    return "decision.decidedAt is missing or empty";
  if (!isValidVerdict(d.verdict))        return `decision.verdict '${String(d.verdict)}' is not a recognised Phase 2c verdict`;
  if (!isValidReasonCode(d.reasonCode))  return `decision.reasonCode '${String(d.reasonCode)}' is not a recognised Phase 2c reason code`;
  if (!Array.isArray(d.evidence))        return "decision.evidence must be an array";
  if (!d.thresholdsUsed || typeof d.thresholdsUsed !== "object") {
    return "decision.thresholdsUsed is missing";
  }
  return null;
}

// ── Append ──────────────────────────────────────────────────────────────────

/**
 * Append a single decision-evidence event to the JSONL ledger. Returns the
 * materialised event on success, or a structured refusal if the input does
 * not look like a Phase 2c decision.
 *
 * Append failure (filesystem error) returns `{ ok: false }` and writes
 * nothing — the caller decides whether to retry. The append is the only
 * side effect; nothing else in the system is mutated.
 */
export function appendDecisionEvent(
  input: AppendDecisionEventInput,
): AppendDecisionEventResult {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "input is missing or not an object" };
  }
  const validationError = validateDecision(input.decision);
  if (validationError) {
    return { ok: false, reason: validationError };
  }
  if (!isNonEmptyString(input.source)) {
    return { ok: false, reason: "source is required (non-empty string)" };
  }
  if (!isNonEmptyString(input.ruleVersion)) {
    return { ok: false, reason: "ruleVersion is required (non-empty string)" };
  }

  const d = input.decision;
  const event: HypothesisDecisionEvent = {
    eventId:        nextEventId(),
    recordedAt:     new Date().toISOString(),
    decidedAt:      d.decidedAt,
    hypothesisId:   d.hypothesisId,
    experimentId:   input.experimentId,
    candidateId:    input.candidateId,
    metricKey:      d.metricKey,
    decision:       d.verdict,
    reasonCode:     d.reasonCode,
    reason:         d.reason,
    // Defensive copy so a later mutation of the decision object cannot
    // alter what was persisted (the JSON write already serialised, but the
    // returned event is also held by the caller).
    evidence:       [...d.evidence],
    ruleVersion:    input.ruleVersion.trim(),
    source:         input.source.trim(),
    binding:        input.binding
      ? {
          hypothesisId:       input.binding.hypothesisId,
          metricKey:          input.binding.metricKey,
          matchedDataSources: [...input.binding.matchedDataSources],
        }
      : undefined,
    thresholdsUsed: { ...d.thresholdsUsed },
  };

  try {
    fs.appendFileSync(ledgerPath(), JSON.stringify(event) + "\n", "utf8");
  } catch (e: any) {
    return { ok: false, reason: `ledger write failed: ${e?.message ?? e}` };
  }
  return { ok: true, event };
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Read all events from the ledger. Tolerates partial / corrupt lines by
 * skipping them — append-only design means a torn write never corrupts
 * prior records.
 *
 * Filters out any line whose `decision` or `reasonCode` is no longer in the
 * Phase 2c enum. This protects callers that branch on the verdict from a
 * future enum widening that has not been propagated to all readers.
 */
export function readDecisionEvents(): HypothesisDecisionEvent[] {
  const path = ledgerPath();
  if (!fs.existsSync(path)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: HypothesisDecisionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (
        obj &&
        typeof obj === "object" &&
        typeof obj.eventId === "string" &&
        typeof obj.hypothesisId === "string" &&
        isValidVerdict(obj.decision) &&
        isValidReasonCode(obj.reasonCode)
      ) {
        out.push(obj as HypothesisDecisionEvent);
      }
    } catch {
      // Skip bad line. Append-only — earlier records are still intact.
    }
  }
  return out;
}

/** Convenience: most-recent first slice for dashboard rendering. */
export function readDecisionEventsTail(limit = 50): HypothesisDecisionEvent[] {
  const all = readDecisionEvents();
  return all.slice(-Math.max(1, limit)).reverse();
}

/**
 * Filter helper: events for a single hypothesis, oldest first. Useful when a
 * future Phase 2e wants to review the decision history before scheduling a
 * new run.
 */
export function readDecisionEventsForHypothesis(
  hypothesisId: string,
): HypothesisDecisionEvent[] {
  if (!isNonEmptyString(hypothesisId)) return [];
  return readDecisionEvents().filter(e => e.hypothesisId === hypothesisId);
}
