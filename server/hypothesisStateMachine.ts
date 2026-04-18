// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — HYPOTHESIS STATE MACHINE
//
// Gives hypotheses exit paths other than "kept alive forever":
//   - awaiting-deadline : resolution date is in the future, skip eval until then
//   - data-unavailable  : kept alive N≥3 cycles on identical insufficient-evidence
//                         → likely needs non-public data (IRB protocols, firmware)
//   - stale-retired     : >7 cycles with no resolution and no new evidence
//
// All transitions emit `[Hypothesis] <id> <old> → <new> — <reason>` and are
// additive. Existing forming/testing/confirmed/rejected/expired flow is
// unchanged; this module only layers in the new exit paths.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hypothesis } from "./researchEngine.js";
import { isPastHalfLife } from "./hypothesisDomainClassifier.js";

export type HypothesisState =
  | "forming"
  | "testing"
  | "confirmed"
  | "rejected"
  | "expired"
  | "awaiting-deadline"
  | "data-unavailable"
  | "stale-retired";

export const INSUFFICIENT_CYCLES_THRESHOLD = 3;
export const STALE_CYCLES_THRESHOLD        = 7;

// ── Date extraction ──────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6,
  aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Scan hypothesis text (claim + prediction + timeframe) for an explicit future
 * date. Returns ISO string of the date if one is found AND it is strictly in
 * the future; otherwise null.
 *
 * Heuristic — we do not need to be perfect. Missing a date just means the
 * hypothesis stays in the normal flow. Finding a close-enough date lets us
 * skip evidence gathering until it passes.
 */
export function extractFutureDeadline(text: string, now: Date = new Date()): string | null {
  if (!text) return null;
  const candidates: Date[] = [];

  // 1. ISO-style: 2026-06-15, 2026/6/15
  const isoRe = /\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoRe.exec(text)) !== null) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!isNaN(d.getTime())) candidates.push(d);
  }

  // 2. "June 15, 2026" / "June 15 2026" / "15 June 2026"
  const natRe = /\b(?:(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})|(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(20\d{2}))\b/gi;
  while ((m = natRe.exec(text)) !== null) {
    const monName = (m[1] ?? m[5] ?? "").toLowerCase();
    const day     = +(m[2] ?? m[4]);
    const year    = +(m[3] ?? m[6]);
    const mon     = MONTHS[monName];
    if (mon !== undefined && day > 0 && day <= 31 && year > 0) {
      const d = new Date(Date.UTC(year, mon, day));
      if (!isNaN(d.getTime())) candidates.push(d);
    }
  }

  // 3. "by June 2026" / "before June 2026" / "in June 2026" (month + year only)
  //    Default to end-of-month so we don't prematurely re-evaluate.
  const monYearRe = /\b(?:by|before|in|around|until|during|completion[^.]*in|expected[^.]*in)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(20\d{2})\b/gi;
  while ((m = monYearRe.exec(text)) !== null) {
    const mon = MONTHS[m[1].toLowerCase()];
    const yr  = +m[2];
    if (mon !== undefined) {
      const d = new Date(Date.UTC(yr, mon + 1, 0)); // last day of that month
      if (!isNaN(d.getTime())) candidates.push(d);
    }
  }

  // 4. "window ... <date>" phrases — already covered above if the date is explicit

  const future = candidates
    .filter(d => d.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  return future.length > 0 ? future[0].toISOString() : null;
}

// ── Live-grounding need detection ────────────────────────────────────────────

/**
 * Decide whether a hypothesis needs fresh web evidence (Perplexity sonar-pro)
 * rather than academic sources alone. Heuristic — looks for recency cues,
 * company/product mentions, legislative language, etc.
 */
export function needsLiveGrounding(text: string, now: Date = new Date()): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Current / recent year
  const year = now.getUTCFullYear();
  if (lower.includes(String(year)) || lower.includes(String(year - 1))) return true;

  // Month names — typical in short-horizon hypotheses
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(lower)) {
    return true;
  }

  // Policy / legislation / regulatory
  if (/\b(ld\s?\d+|hr\s?\d+|sb\s?\d+|bill|legislation|moratorium|ruling|sec filing|executive order|regulatio|policy)\b/.test(lower)) {
    return true;
  }

  // Trials / clinical / product launches / earnings / news
  if (/\b(trial|nct\d+|ide|irb|launch|release|announced|earnings|quarterly|q[1-4]\s?20\d{2}|breaking|report)\b/.test(lower)) {
    return true;
  }

  // Company / product-ish (capitalized multi-word in original text suggests a named entity)
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-zA-Z]+)+\b/.test(text)) return true;

  return false;
}

// ── Log helper ───────────────────────────────────────────────────────────────

export function logStateTransition(
  hypId: string,
  oldState: HypothesisState,
  newState: HypothesisState,
  reason: string,
): void {
  console.log(`[Hypothesis] ${hypId} ${oldState} → ${newState} — ${reason.slice(0, 200)}`);
}

// ── Pre-evaluation classifier ────────────────────────────────────────────────

export interface PreEvalClassification {
  transitionTo?: HypothesisState;
  reason?:       string;
  deadlineAt?:   string;
}

/**
 * Before spending tokens on an LLM evaluation, decide whether this hypothesis
 * has a structural exit path. Returns a non-null `transitionTo` when the
 * caller should skip evaluation and move the hypothesis to that state instead.
 */
export function classifyForStateMachine(
  hyp: Hypothesis,
  now: Date = new Date(),
): PreEvalClassification {
  const cycleCount = hyp.cycleCount ?? 0;
  const consec     = hyp.consecutiveInsufficientCycles ?? 0;

  // 1. awaiting-deadline — future date in claim/prediction/timeframe
  //    Skip if we already have one recorded.
  const searchText = [hyp.claim, hyp.prediction, hyp.timeframe].filter(Boolean).join(" ");
  const existing   = hyp.deadlineAt ? new Date(hyp.deadlineAt) : null;
  const parsed     = hyp.deadlineAt ? null : extractFutureDeadline(searchText, now);
  const deadline   = existing && existing.getTime() > now.getTime()
    ? existing
    : parsed
      ? new Date(parsed)
      : null;

  if (deadline && deadline.getTime() > now.getTime()) {
    return {
      transitionTo: "awaiting-deadline",
      reason:       `resolution date ${deadline.toISOString().slice(0, 10)} is in the future`,
      deadlineAt:   deadline.toISOString(),
    };
  }

  // 2. data-unavailable — kept alive ≥ threshold consecutive cycles on
  //    insufficient-evidence reasoning.
  if (consec >= INSUFFICIENT_CYCLES_THRESHOLD) {
    return {
      transitionTo: "data-unavailable",
      reason:       `${consec} consecutive cycles of insufficient evidence — required data not in public sources`,
    };
  }

  // 3. domain-aware half-life (Wave 2.3 PR-1) — wall-clock decay, only for
  //    actively-testing hypotheses so newly-formed ones keep their grace.
  if (
    hyp.status === "testing"
    && typeof hyp.halfLifeHours === "number"
    && hyp.formedAt
    && isPastHalfLife(hyp.formedAt, hyp.halfLifeHours, now)
  ) {
    return {
      transitionTo: "stale-retired",
      reason:       `past ${hyp.halfLifeHours}h half-life for domain=${hyp.domain ?? "unknown"}`,
    };
  }

  // 4. legacy stale-retired — very old, still unresolved, no new evidence.
  //    Suppressed when a domain half-life is cached (that clock is authoritative).
  const hasCachedHalfLife = typeof hyp.halfLifeHours === "number";
  if (!hasCachedHalfLife && cycleCount >= STALE_CYCLES_THRESHOLD) {
    return {
      transitionTo: "stale-retired",
      reason:       `${cycleCount} cycles elapsed with no resolution`,
    };
  }

  return {};
}

// ── Deadline re-check ────────────────────────────────────────────────────────

/**
 * For hypotheses in awaiting-deadline, determine whether this cycle should
 * actually re-evaluate them. We only re-check once the deadline has passed OR
 * once per calendar day (whichever is later) to avoid cycling on them.
 */
export function shouldRecheckDeadline(hyp: Hypothesis, now: Date = new Date()): boolean {
  if (hyp.status !== "awaiting-deadline") return false;
  const deadline = hyp.deadlineAt ? new Date(hyp.deadlineAt) : null;
  if (!deadline) return true; // no deadline recorded → safe to re-check
  if (deadline.getTime() <= now.getTime()) return true; // past the date

  const lastCheck = hyp.deadlineCheckedAt ? new Date(hyp.deadlineCheckedAt) : null;
  if (!lastCheck) return true;
  const oneDayMs = 24 * 60 * 60 * 1000;
  return now.getTime() - lastCheck.getTime() >= oneDayMs;
}

// ── Cycle summary ────────────────────────────────────────────────────────────

export interface CycleStateTally {
  active:             number;
  awaitingDeadline:   number;
  dataUnavailable:    number;
  confirmedThisCycle: number;
  rejectedThisCycle:  number;
  retiredThisCycle:   number;
}

export function tallyStates(
  hypotheses: Hypothesis[],
  transitions: Array<{ to: HypothesisState }>,
): CycleStateTally {
  const counts = {
    active:             0,
    awaitingDeadline:   0,
    dataUnavailable:    0,
    confirmedThisCycle: 0,
    rejectedThisCycle:  0,
    retiredThisCycle:   0,
  };
  for (const h of hypotheses) {
    if (h.status === "forming" || h.status === "testing") counts.active++;
    else if (h.status === "awaiting-deadline") counts.awaitingDeadline++;
    else if (h.status === "data-unavailable") counts.dataUnavailable++;
  }
  for (const t of transitions) {
    if (t.to === "confirmed")       counts.confirmedThisCycle++;
    else if (t.to === "rejected")   counts.rejectedThisCycle++;
    else if (t.to === "stale-retired" || t.to === "data-unavailable") counts.retiredThisCycle++;
  }
  return counts;
}

export function logCycleSummary(tally: CycleStateTally): void {
  console.log(
    `[DailyCycle] Hypothesis state: ${tally.active} active, ${tally.awaitingDeadline} awaiting-deadline, ` +
    `${tally.dataUnavailable} data-unavailable, ${tally.confirmedThisCycle} confirmed this cycle, ` +
    `${tally.rejectedThisCycle} rejected this cycle, ${tally.retiredThisCycle} retired this cycle`,
  );
}
