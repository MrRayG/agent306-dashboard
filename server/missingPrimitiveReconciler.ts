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
import {
  classifyMissingPrimitiveFamily,
  translateAction,
  type MissingPrimitiveFamily,
} from "./actionTranslator.js";
import {
  listRecommendations,
  rejectRecommendation,
} from "./selfRecommendationEngine.js";
import { logEvent } from "./observability/structuredLog.js";
import {
  classifyPrimitiveCoverageForFamily,
  isReconcilerAwarenessEnabled,
  summarizeRegisteredPrimitiveCoverage,
  type PrimitiveCoverageReport,
  type PrimitiveCoverageStatus,
} from "./primitives/coverageDiagnostic.js";

/**
 * PR #445 — supersession-on-coverage gate.
 *
 * When the runtime now emits `primitive-fallback-rec` for a family (because
 * the primitive registry registers an executor for that family AND every
 * dispatcher gate is ON, i.e. the coverage diagnostic classifies the family
 * as `dispatch_capable`), the historical `missing-primitive: <family>` recs
 * that pre-date the registration are obsolete: they were created precisely
 * to track the absence of an executor that now exists.
 *
 * The translator-driven path in the reconciler does NOT catch these recs —
 * for fallback-covered families the translator still returns `primitive: "none"`
 * (the executor only attaches `registeredPrimitive` metadata and runs as a
 * dry-run fallback; it does not classify into a concrete enforcement
 * primitive). So the historical rec persists in the `proposed` queue.
 *
 * This gate enables a second supersession path: when the rec's family is
 * `dispatch_capable` AND the translator still returns `none`, the rec is
 * rejected with operator="reconciler" and a structured supersession note.
 * Audit history is preserved via the existing reject flow (status=rejected,
 * rejectedAt, approvedBy, reviewNote). Lifecycle for any other path is
 * unchanged.
 *
 * Default OFF for the env flag; tests and the goal-engine wiring pass the
 * option explicitly so existing deployments only see the new behavior when
 * intentionally enabled.
 */
export const MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENV =
  "MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENABLED";

export function isSupersedeOnCoverageEnabled(): boolean {
  return process.env[MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENV] === "true";
}

export interface ReconcilerOptions {
  /** Cap on rejections per call. Default 20. */
  maxReconciledPerRun?: number;
  /**
   * Operator string recorded on the rejection. Defaults to "reconciler".
   * Tests override this to assert the audit trail.
   */
  operator?: string;
  /**
   * Force the coverage diagnostic ON or OFF for this call, overriding
   * the `PRIMITIVE_RECONCILER_AWARENESS_ENABLED` env flag. Tests use
   * this to exercise the additive code path without leaking env state.
   */
  emitCoverageDiagnostic?: boolean;
  /**
   * PR #445 — force the supersession-on-coverage path ON or OFF for this
   * call, overriding `MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENABLED`.
   * When ON, recs whose translator still returns `none` but whose family
   * is `dispatch_capable` are rejected with a supersession note. Default:
   * env-driven. Tests pass `true` explicitly to exercise the new path.
   */
  supersedeOnDispatchCoverage?: boolean;
}

/**
 * Per-rec coverage hint surfaced under
 * {@link ReconcilerResult.primitiveCoverage}.recPredicates.
 *
 * The reconciler does NOT use this to mutate the rec's lifecycle. It
 * is descriptive only: "this rec's family classifies as X under the
 * current registry/gate state". The translator-change check remains
 * the sole driver of `reconciled` / `rejectedRecIds`.
 */
export interface ReconcilerRecCoverage {
  readonly recId: string;
  readonly family: MissingPrimitiveFamily;
  readonly status: PrimitiveCoverageStatus;
  readonly primitiveId?: string;
}

export interface ReconcilerResult {
  scanned: number;
  reconciled: number;
  stillUnparseable: number;
  missingLedgerEntry: number;
  errors: number;
  rejectedRecIds: string[];
  /**
   * PR #445 — count of recs rejected via the supersession-on-coverage
   * path (translator still returns `none`, but the rec's family is now
   * `dispatch_capable` in the primitive registry). Always 0 when the
   * supersession gate is OFF. Ids of these rejections also appear in
   * {@link rejectedRecIds} so existing consumers see them; the count
   * here lets callers distinguish translator-driven rejections from
   * coverage-driven supersessions in summary logs.
   */
  supersededByPrimitiveCoverage?: number;
  /** Ids of supersession-on-coverage rejections (subset of rejectedRecIds). */
  supersededRecIds?: string[];
  /**
   * Additive, optional coverage diagnostic. Populated ONLY when
   * `PRIMITIVE_RECONCILER_AWARENESS_ENABLED === "true"` (or
   * `opts.emitCoverageDiagnostic` is `true`). Lifecycle decisions
   * encoded in the other fields are unchanged by its presence /
   * absence — adding this field is purely observational.
   */
  primitiveCoverage?: PrimitiveCoverageReport & {
    /**
     * Per-scanned-rec hint. Entries are added in scan order. A rec
     * appearing here with `status: "dispatch_capable"` while the
     * translator still returns `none` is the headline signal: the
     * primitive registry now claims coverage but the translator
     * doesn't route to it yet — operator can investigate the wiring
     * gap without the reconciler touching the rec.
     */
    recPredicates: ReconcilerRecCoverage[];
  };
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
  const emitCoverage =
    opts.emitCoverageDiagnostic ?? isReconcilerAwarenessEnabled();
  // PR #445 — supersession gate. Off by default; opt in via env or option.
  const supersedeOnCoverage =
    opts.supersedeOnDispatchCoverage ?? isSupersedeOnCoverageEnabled();

  const result: ReconcilerResult = {
    scanned: 0,
    reconciled: 0,
    stillUnparseable: 0,
    missingLedgerEntry: 0,
    errors: 0,
    rejectedRecIds: [],
    supersededByPrimitiveCoverage: 0,
    supersededRecIds: [],
  };

  // Coverage diagnostic accumulator. Populated only when the awareness
  // flag is ON; otherwise this stays `null` and `result.primitiveCoverage`
  // is never set, preserving the pre-PR result shape.
  const coverageRecs: ReconcilerRecCoverage[] = [];
  const familiesObserved = new Set<MissingPrimitiveFamily>();

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

    // Additive coverage diagnostic: classify the rec's family from the
    // ledger entry when present, otherwise from the rec title. This block
    // is purely observational; it never branches the lifecycle logic
    // below.
    if (emitCoverage) {
      const family = familyForRec(rec, entry);
      if (family !== null) {
        familiesObserved.add(family);
        const cov = classifyPrimitiveCoverageForFamily(family);
        coverageRecs.push({
          recId: rec.id,
          family,
          status: cov.status,
          primitiveId: cov.primitiveId,
        });
      }
    }

    if (!entry) {
      // Ledger entry was rotated out (LEDGER_CAP) or pruned. Without the
      // insight + action text we can't re-translate. PR #445: before
      // giving up, try the supersession-on-coverage path — these are
      // exactly the long-stale recs that pre-date primitive registration
      // and that the translator-driven path can never clear (no ledger
      // entry to translate).
      if (
        supersedeOnCoverage &&
        trySupersedeOnCoverage({
          rec,
          entry: undefined,
          operator,
          result,
        })
      ) {
        continue;
      }
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
      // PR #445 — supersession-on-coverage path. The translator still
      // returns `none`, but if the rec's family is now `dispatch_capable`
      // in the primitive registry, the historical missing-primitive rec
      // is obsolete: a registered executor will catch this family via the
      // fallback dry-run path (the runtime emits `primitive-fallback-rec`
      // instead of `missing-primitive-rec` after #443/#444 landed).
      // Auto-reject with a supersession note; falls through to the
      // existing `stillUnparseable` accounting when the family is not
      // dispatch-capable.
      if (
        supersedeOnCoverage &&
        trySupersedeOnCoverage({
          rec,
          entry,
          operator,
          result,
        })
      ) {
        continue;
      }
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

  if (emitCoverage) {
    const report = summarizeRegisteredPrimitiveCoverage(
      Array.from(familiesObserved),
    );
    result.primitiveCoverage = {
      ...report,
      recPredicates: coverageRecs,
    };
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

/**
 * Best-effort family extraction for a missing-primitive rec, used for
 * the additive coverage diagnostic only. Tries the ledger entry's
 * action text first (most accurate, matches the classifier the
 * translator uses today); falls back to parsing the title prefix
 * (`missing-primitive: <family> family — ...`) so we can still
 * classify recs whose ledger entry was rotated out.
 *
 * Returns `null` only when both sources fail to yield a recognizable
 * family — in that case the rec is simply omitted from the coverage
 * block. Lifecycle is unaffected.
 */
function familyForRec(
  rec: { title?: string | null },
  entry: InsightLedgerEntry | undefined,
): MissingPrimitiveFamily | null {
  if (entry?.proposedAction) {
    try {
      return classifyMissingPrimitiveFamily(entry.proposedAction);
    } catch {
      // fall through to title parsing
    }
  }
  const title = rec.title ?? "";
  // Title format from goalEngine.ts: `missing-primitive: <family> family — ...`
  const m = title.match(/^missing-primitive:\s+([a-z_]+)\s+family\b/i);
  if (m) {
    const candidate = m[1].toLowerCase();
    if (KNOWN_FAMILIES.has(candidate)) {
      return candidate as MissingPrimitiveFamily;
    }
  }
  return null;
}

const KNOWN_FAMILIES: ReadonlySet<string> = new Set([
  "artifact",
  "ratio",
  "ttl",
  "gate",
  "archive",
  "spectrum",
  "synthesis",
  "rewrite",
  "verification",
  "verification_scaffold",
  "other",
]);

function buildRejectionNote(primitive: string, reason?: string): string {
  // Structured, paste-readable note. Operators can grep the audit trail.
  // Reason is included when present so we capture which pattern matched.
  const base =
    `[reconciler] action translator now resolves this insight to ` +
    `'${primitive}'. Parser-coverage gap closed (PR #409 sweep); ` +
    `auto-rejecting stale missing-primitive rec.`;
  return reason ? `${base} Match: ${reason}` : base;
}

/**
 * PR #445 — supersession-on-coverage helper.
 *
 * Detects the case where the rec's family is dispatch-capable in the
 * primitive registry, then rejects via the existing `rejectRecommendation`
 * audit path with a structured supersession note. Returns true iff the rec
 * was rejected (so the caller can `continue` and skip the
 * `stillUnparseable` / `missingLedgerEntry` accounting).
 *
 * Lifecycle effects:
 *   - status: proposed → rejected
 *   - reviewNote: structured supersession note
 *   - approvedBy / rejectedAt: operator (default "reconciler") / now
 *
 * Audit history is preserved: the original row remains in the
 * `self_recommendations` table with its original `createdAt`, `title`,
 * `rationale`, `proposedChange`, `sourceInsightId`, and `evidence`. Only
 * the lifecycle columns transition.
 *
 * Safety:
 *   - No-op when no parseable family can be derived from the rec.
 *   - No-op when the family is not `dispatch_capable` (i.e. either the
 *     primitive isn't registered, or one of the dispatcher gates is OFF).
 *     `registered_only` is intentionally NOT treated as superseded — the
 *     gap is still real to operators while gates are off.
 *   - Errors from `rejectRecommendation` are swallowed and counted as
 *     `result.errors`, matching the existing translator-driven path.
 */
function trySupersedeOnCoverage(args: {
  rec: { id: string; title?: string | null; sourceInsightId?: string | null };
  entry: InsightLedgerEntry | undefined;
  operator: string;
  result: ReconcilerResult;
}): boolean {
  const { rec, entry, operator, result } = args;
  const family = familyForRec(rec, entry);
  if (family === null) return false;
  const coverage = classifyPrimitiveCoverageForFamily(family);
  if (coverage.status !== "dispatch_capable") return false;

  const note = buildSupersessionNote(family, coverage.primitiveId);
  try {
    rejectRecommendation(rec.id, operator, note);
    result.reconciled++;
    result.rejectedRecIds.push(rec.id);
    result.supersededByPrimitiveCoverage =
      (result.supersededByPrimitiveCoverage ?? 0) + 1;
    (result.supersededRecIds ??= []).push(rec.id);
    logEvent({
      engine: "goalEngine",
      event: "missing-primitive-reconciler-superseded",
      level: "info",
      data: {
        recId: rec.id,
        insightId: rec.sourceInsightId ?? null,
        family,
        primitiveId: coverage.primitiveId ?? null,
        operator,
        reason: "primitive_family_now_dispatch_capable",
      },
    });
    return true;
  } catch (e: any) {
    result.errors++;
    logEvent({
      engine: "goalEngine",
      event: "missing-primitive-reconciler-error",
      level: "warn",
      data: {
        recId: rec.id,
        family,
        error: e?.message ?? String(e),
        phase: "rejectRecommendation:supersedeOnCoverage",
      },
    });
    return false;
  }
}

function buildSupersessionNote(
  family: MissingPrimitiveFamily,
  primitiveId: string | undefined,
): string {
  const ts = new Date().toISOString();
  const idPart = primitiveId ? ` (${family}::${primitiveId})` : "";
  return (
    `[reconciler] Primitive family registered and lookup-hit; runtime now ` +
    `emits primitive-fallback-rec instead of missing-primitive-rec` +
    `${idPart}. Superseding stale missing-primitive: ${family} rec ` +
    `(family is dispatch_capable as of ${ts}; PR #445).`
  );
}
