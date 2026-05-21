// ---------------------------------------------------------------------------
// 306 — MISSING-PRIMITIVE RECONCILER (PR #410)
//
// PROBLEM
//   When SelfEvolution emits an action whose wording the action translator
//   cannot parse, GoalEngine proposes a `missing-primitive: <family> family`
//   SelfRecommendation so the parser-coverage gap becomes a tracked, operator-
//   reviewable signal. The dedupe key is family-scoped, so a single family
//   only ever has one open rec at a time — that part works.
//
//   What DIDN'T work: once a parser-coverage PR (e.g. #409) lands and the
//   translator can now parse those wordings, the OLD proposed recs continue
//   to sit in the operator queue indefinitely. They are persisted ledger
//   rows, not derived views. Re-evaluation only happens on the next SelfEvo
//   emission of that exact insight — but insights are one-shot ledger entries,
//   so the original recs never get a second look. The "self-clear via dedupe"
//   pattern only protects FUTURE recs of the same wording, not past ones.
//
// FIX
//   Once per GoalEngine cycle, walk every `proposed` rec whose title starts
//   with `missing-primitive:`. For each one, look up the insight in the
//   Insight Ledger via `sourceInsightId`, re-run `translateAction(action,
//   insight)`, and if the translator now resolves to a non-`none` primitive,
//   auto-reject the rec with a structured operator note pointing at the
//   primitive that now catches it.
//
// SAFETY
//   - Gated behind `MISSING_PRIMITIVE_RECONCILER_ENABLED` (default true) so
//     it can be flipped off without a redeploy.
//   - Capped at `MAX_RECONCILED_PER_RUN` (default 20) so a backlog drain
//     doesn't dominate a cycle log.
//   - Operator-attributable: rejected recs carry operator="reconciler" and a
//     structured note with primitive name + PR # so the rejection trail is
//     auditable.
//   - Read-only when the ledger entry is missing (logs a warning, leaves the
//     rec alone). The same applies when translation still returns "none" —
//     the parser-coverage gap is still real and the rec should stay visible.
//
// INVARIANTS (covered by tests)
//   1. Recs whose insight now translates to a real primitive → REJECTED.
//   2. Recs whose insight still returns "none" → UNCHANGED.
//   3. Recs whose ledger entry no longer exists → UNCHANGED (warn-logged).
//   4. Non-missing-primitive recs are never touched.
//   5. Approved/rejected/closed recs are never touched (only `proposed`).
//   6. The cap is respected (drains earliest N first).
//
// PRIOR ART
//   - Same lifecycle shape as `expireStaleProposed` in insightLedger.ts:
//     stateless sweep, structured log event, bounded work per call.
//   - Mirrors the auto-resolution pattern in `autoResolveStaleGoals`
//     (researchEngine.ts).
// ---------------------------------------------------------------------------

import { loadLedger, type InsightLedgerEntry } from "./insightLedger.js";
import { translateAction } from "./actionTranslator.js";
import {
  listRecommendations,
  rejectRecommendation,
} from "./selfRecommendationEngine.js";
import { logEvent } from "./observability/structuredLog.js";

export interface ReconcilerOptions {
  /** Cap on rejections per call. Default 20. */
  maxReconciledPerRun?: number;
  /**
   * Operator string recorded on the rejection. Defaults to "reconciler".
   * Tests override this to assert the audit trail.
   */
  operator?: string;
}

export interface ReconcilerResult {
  scanned: number;
  reconciled: number;
  stillUnparseable: number;
  missingLedgerEntry: number;
  errors: number;
  rejectedRecIds: string[];
}

const DEFAULT_MAX = 20;
const TITLE_PREFIX = "missing-primitive:";

/**
 * Reconcile open missing-primitive recs against the current translator.
 *
 * Returns a structured summary suitable for inclusion in GoalEngineResult or
 * a dashboard panel. Idempotent: safe to call once per cycle.
 */
export function reconcileMissingPrimitiveRecs(
  opts: ReconcilerOptions = {},
): ReconcilerResult {
  const cap = Math.max(1, opts.maxReconciledPerRun ?? DEFAULT_MAX);
  const operator = opts.operator ?? "reconciler";

  const result: ReconcilerResult = {
    scanned: 0,
    reconciled: 0,
    stillUnparseable: 0,
    missingLedgerEntry: 0,
    errors: 0,
    rejectedRecIds: [],
  };

  // Pull all proposed recs; filter to missing-primitive family in-process.
  // listRecommendations is bounded (max 500). We explicitly sort by
  // createdAt ASC so the cap drains the OLDEST stale recs first, matching
  // operator expectation that the longest-sitting backlog items clear first.
  // (Don't rely on listRecommendations's desc order + `.reverse()` — under
  // sub-millisecond rec insertion, secondary ordering by row insertion can
  // make the reversed-desc order non-deterministic.)
  const proposed = listRecommendations({ status: "proposed", limit: 500 });
  const missingPrimitiveRecs = proposed
    .filter((r) => (r.title ?? "").startsWith(TITLE_PREFIX))
    .sort((a, b) => {
      // ISO timestamps sort lexically the same as chronologically.
      const at = String(a.createdAt ?? "");
      const bt = String(b.createdAt ?? "");
      if (at < bt) return -1;
      if (at > bt) return 1;
      // Stable tiebreaker on id for deterministic cap behavior.
      return String(a.id).localeCompare(String(b.id));
    });

  if (missingPrimitiveRecs.length === 0) {
    return result;
  }

  // Lazy-load the ledger once per call — entries[] is small (LEDGER_CAP=500)
  // and we want a consistent snapshot across the sweep.
  const ledger = loadLedger();
  // Build an id→entry map once so the inner loop is O(1) per rec.
  const byId = new Map<string, InsightLedgerEntry>();
  for (const e of ledger.entries) byId.set(e.id, e);

  for (const rec of missingPrimitiveRecs) {
    if (result.reconciled >= cap) break;
    result.scanned++;

    const insightId = rec.sourceInsightId;
    if (!insightId) {
      // Defensive: a missing-primitive rec without a sourceInsightId can't be
      // reconciled. Leave it; log so we can find the bug.
      result.errors++;
      logEvent({
        engine: "goalEngine",
        event: "missing-primitive-reconciler-skip",
        level: "warn",
        data: { recId: rec.id, reason: "no sourceInsightId on rec" },
      });
      continue;
    }

    const entry = byId.get(insightId);
    if (!entry) {
      // Ledger entry was rotated out (LEDGER_CAP) or pruned. Without the
      // insight + action text we can't re-translate. Leave the rec alone —
      // an operator can still reject it manually if they want.
      result.missingLedgerEntry++;
      logEvent({
        engine: "goalEngine",
        event: "missing-primitive-reconciler-skip",
        level: "info",
        data: { recId: rec.id, insightId, reason: "ledger entry not found" },
      });
      continue;
    }

    let translation;
    try {
      translation = translateAction(entry.proposedAction, entry.insight);
    } catch (e: any) {
      result.errors++;
      logEvent({
        engine: "goalEngine",
        event: "missing-primitive-reconciler-error",
        level: "warn",
        data: {
          recId: rec.id,
          insightId,
          error: e?.message ?? String(e),
        },
      });
      continue;
    }

    if (translation.primitive === "none") {
      // Parser still can't handle this wording. Leave the rec visible — the
      // coverage gap is real and the operator should still see it.
      result.stillUnparseable++;
      continue;
    }

    // Parser now handles this insight. Auto-reject the stale rec.
    const note = buildRejectionNote(translation.primitive, translation.reason);
    try {
      rejectRecommendation(rec.id, operator, note);
      result.reconciled++;
      result.rejectedRecIds.push(rec.id);
      logEvent({
        engine: "goalEngine",
        event: "missing-primitive-reconciler-cleared",
        level: "info",
        data: {
          recId: rec.id,
          insightId,
          resolvedTo: translation.primitive,
          operator,
        },
      });
    } catch (e: any) {
      // Race: another process may have approved/rejected this rec between
      // listRecommendations and rejectRecommendation. Treat as benign.
      result.errors++;
      logEvent({
        engine: "goalEngine",
        event: "missing-primitive-reconciler-error",
        level: "warn",
        data: {
          recId: rec.id,
          insightId,
          error: e?.message ?? String(e),
          phase: "rejectRecommendation",
        },
      });
    }
  }

  if (result.reconciled > 0 || result.errors > 0) {
    logEvent({
      engine: "goalEngine",
      event: "missing-primitive-reconciler-summary",
      level: "info",
      data: result,
    });
  }

  return result;
}

function buildRejectionNote(primitive: string, reason?: string): string {
  // Structured, paste-readable note. Operators can grep the audit trail.
  // Reason is included when present so we capture which pattern matched.
  const base =
    `[reconciler] action translator now resolves this insight to ` +
    `'${primitive}'. Parser-coverage gap closed (PR #409 sweep); ` +
    `auto-rejecting stale missing-primitive rec.`;
  return reason ? `${base} Match: ${reason}` : base;
}
