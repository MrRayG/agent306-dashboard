/**
 * ─────────────────────────────────────────────────────────────
 *  HYPOTHESIS TRIAGE QUEUE — operator-facing stalled-hypothesis surface
 *
 *  Surfaces low-confidence (research-gap) hypotheses that are still in
 *  forming/testing/awaiting-deadline status, sorted by how stale they are
 *  (oldest signal of progress first), so an operator can decide whether
 *  to mark them `data-unavailable` in a single click.
 *
 *  This is a *triage view*, not an auto-archiver. The DailyCycle already
 *  routes things to data-unavailable structurally (≥3 consecutive
 *  insufficient-evidence cycles); this module is for the human in the
 *  loop to handle the long tail that the cycle has not yet auto-handled,
 *  e.g. hypotheses sitting in `forming` because the data-source gate is
 *  blocking a measurement path.
 *
 *  Pure functions only — no I/O, no LLM calls. Easy to test.
 * ─────────────────────────────────────────────────────────────
 */

import type { Hypothesis } from "./researchEngine.js";

export interface StalledHypothesisRow {
  id:                 string;
  claim:              string;
  status:             Hypothesis["status"];
  confidence:         Hypothesis["confidence"];
  triageConfidence?:  Hypothesis["triageConfidence"];
  stake?:             Hypothesis["stake"];
  formedAt:           string;
  /**
   * Timestamp of the most recent visible activity on this hypothesis
   * (deadline check, data-source gate block, formation). This is what
   * the days-stale calculation is anchored to.
   */
  lastActivityAt:     string;
  daysSinceActivity:  number;
  /** Why we think the operator should look at this row first. */
  staleReason:        string;
  /**
   * Whether this row already has a recorded data-source gate block. We
   * surface this in the UI so the operator sees the gate's reason
   * before deciding to archive.
   */
  dataSourceGateReason?: string;
  /**
   * Pending-confirmation flag (added 2026-05-08). True when the row is a
   * stalled low-confidence hypothesis with NO evidence update in 30+ days
   * — the operator should confirm whether to mark data-unavailable. This
   * is purely advisory — the UI still requires explicit operator click;
   * nothing auto-archives based on this flag.
   */
  pendingConfirmation?: boolean;
}

/**
 * Most recent activity timestamp we can derive from a Hypothesis. We
 * prefer signals that change over time (deadline re-checks, gate blocks,
 * testing-started) over `formedAt` so a long-stuck row sorts older even
 * if the cycle keeps poking it.
 */
export function lastActivityTimestamp(h: Hypothesis): string {
  const candidates = [
    h.deadlineCheckedAt,
    h.dataSourceGateBlockedAt,
    h.testingStartedAt,
    h.formedAt,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  if (candidates.length === 0) return new Date(0).toISOString();
  const newest = candidates
    .map(s => ({ s, t: new Date(s).getTime() }))
    .filter(c => Number.isFinite(c.t))
    .sort((a, b) => b.t - a.t);
  return newest[0]?.s ?? candidates[0];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days of inactivity that flip a stalled low-confidence hypothesis into
 * "pending-confirmation" — the operator should review and decide whether
 * to mark it data-unavailable. NOT an auto-archive trigger; the UI still
 * requires an explicit operator click.
 *
 * Surfaced 2026-05-08: status panel kept asking for "auto-flag any
 * hypothesis with confidence low and no evidence update in 30+ days as
 * data-unavailable pending human confirmation". 30 days mirrors that ask.
 */
export const PENDING_CONFIRMATION_DAYS = 30;

export function daysSince(iso: string, now: Date = new Date()): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  const diffMs = now.getTime() - t;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * A hypothesis is a "research-gap / data-unavailable triage candidate"
 * iff it is still actively tracked AND the operator has signalled
 * (directly or via the LLM triage classifier) that the framing is
 * low-confidence — i.e. we don't yet know how to test it.
 *
 * We deliberately exclude already-resolved states (confirmed/rejected/
 * expired/data-unavailable/stale-retired) — operators should never see
 * those in the triage queue.
 */
export function isTriageCandidate(h: Hypothesis): boolean {
  // Only show rows that aren't already resolved / archived.
  const ACTIVE_STATES: Hypothesis["status"][] = ["forming", "testing", "awaiting-deadline"];
  if (!ACTIVE_STATES.includes(h.status)) return false;

  // The "research-gap" signal is either:
  //  (a) the LLM triage classifier marked it `triageConfidence: "low"`
  //      (Wave 2.3 PR-4), or
  //  (b) the legacy operator-set `confidence: "low"`.
  // Either is enough to surface — false positives are cheap (operator
  // ignores the row), false negatives starve the queue.
  const triageLow = h.triageConfidence === "low";
  const legacyLow = h.confidence === "low";
  if (!triageLow && !legacyLow) return false;

  return true;
}

/**
 * Build the operator triage queue: rows that are stalled, sorted by
 * days-since-last-activity descending (oldest first). Caller decides
 * the size cap; default 50 keeps the UI responsive without truncating
 * the typical backlog (~10s of rows).
 */
export function selectStalledTriageCandidates(
  hyps: Hypothesis[],
  opts: { now?: Date; limit?: number } = {},
): StalledHypothesisRow[] {
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  const rows: StalledHypothesisRow[] = [];
  for (const h of hyps) {
    if (!isTriageCandidate(h)) continue;
    const lastActivityAt = lastActivityTimestamp(h);
    const days = daysSince(lastActivityAt, now);

    let staleReason: string;
    if (h.dataSourceGateBlockedAt) {
      staleReason = "blocked by data-source gate";
    } else if (h.status === "awaiting-deadline") {
      staleReason = "awaiting external deadline";
    } else if ((h.consecutiveInsufficientCycles ?? 0) > 0) {
      staleReason = `${h.consecutiveInsufficientCycles} consecutive insufficient-evidence cycles`;
    } else {
      staleReason = "low-confidence research-gap";
    }

    rows.push({
      id:                   h.id,
      claim:                h.claim,
      status:               h.status,
      confidence:           h.confidence,
      triageConfidence:     h.triageConfidence,
      stake:                h.stake,
      formedAt:             h.formedAt,
      lastActivityAt,
      daysSinceActivity:    days,
      staleReason,
      dataSourceGateReason: h.dataSourceGateReason,
      pendingConfirmation:  days >= PENDING_CONFIRMATION_DAYS,
    });
  }

  rows.sort((a, b) => {
    if (b.daysSinceActivity !== a.daysSinceActivity) {
      return b.daysSinceActivity - a.daysSinceActivity;
    }
    // Tie-break: oldest formedAt first so long-waiting rows beat fresh ones.
    return new Date(a.formedAt).getTime() - new Date(b.formedAt).getTime();
  });

  return rows.slice(0, limit);
}

/**
 * Pending-confirmation subset: rows where daysSinceActivity >=
 * PENDING_CONFIRMATION_DAYS. The full triage queue includes both fresh and
 * stale rows; this selector is for the dedicated "needs operator decision"
 * view that surfaces only rows old enough that the agent has stopped
 * making progress. Read-only — does NOT mutate hypotheses, does NOT
 * auto-archive. Operator must still click the existing one-click closure
 * button on each row.
 */
export function selectPendingConfirmationRows(
  hyps: Hypothesis[],
  opts: { now?: Date; limit?: number } = {},
): StalledHypothesisRow[] {
  return selectStalledTriageCandidates(hyps, opts).filter(r => r.pendingConfirmation === true);
}
