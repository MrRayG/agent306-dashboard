/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS HYGIENE (Phase 1.5)
 *
 * Phase 2 will turn hypotheses into evidence-based experiment proposals.
 * Before that happens, the active hypothesis backlog needs a triage layer so
 * irrelevant, stale, duplicate, non-actionable, or unsolvable hypotheses do
 * not feed the experiment-decisioning loop.
 *
 * This module is intentionally:
 *   - PURE: no I/O, no LLM calls, no DB writes. Inputs are `Hypothesis` records,
 *     outputs are typed verdicts. Callers (CLI, daily cycle, dashboard router)
 *     decide what to do with the verdict.
 *   - ADDITIVE: no existing field is renamed, no existing status enum is
 *     repurposed. The new `hygieneTag` lives next to `status` and `queue` and
 *     is computed on demand. We do not silently mutate stored records.
 *   - CONSERVATIVE: when uncertain, classifier returns `needs_review` rather
 *     than archiving. History is preserved; archival is the operator's call.
 *
 * Phase 2 readiness gate (`canFeedExperiment`) is the hard guard: only
 * hypotheses whose computed verdict is `ready_for_experiment` may be picked
 * up by experiment registration. That guard is exported here and consumed
 * by any future Phase 2 code path. Display surfaces are unaffected.
 *
 * Design echoes the propose-only invariant in `selfRecommendationEngine.ts`:
 * a verdict is a *recommendation*, not a write. The single caller that ever
 * gates experiment promotion is required to call `canFeedExperiment(hyp)`
 * and refuse on `{ ok: false }`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Hypothesis } from "./researchEngine.js";

// ── Triage tags ──────────────────────────────────────────────────────────────
//
// Tags are computed *from* a hypothesis record; they do not replace the
// existing `status` field (which tracks lifecycle: forming/testing/...). A
// hypothesis with `status === "testing"` may still be tagged `needs_data` if
// its measurement path is missing — the lifecycle says "we are working on
// it", the tag says "but it cannot graduate to an experiment in its current
// shape".
//
// Tags are ordered roughly by readiness:
//   ready_for_experiment > candidate > needs_review/needs_rewrite > needs_data
//   > duplicate > blocked > archived_*
//
// Only `ready_for_experiment` (and `candidate` once an operator has reviewed
// it — see `READY_TAGS`) is allowed to feed the Phase 2 experiment path.

export type HygieneTag =
  | "ready_for_experiment"
  | "candidate"
  | "needs_data"
  | "needs_rewrite"
  | "needs_review"
  | "duplicate"
  | "blocked"
  | "archived_irrelevant"
  | "archived_unsolvable"
  | "archived_stale";

export const HYGIENE_TAGS: readonly HygieneTag[] = [
  "ready_for_experiment",
  "candidate",
  "needs_data",
  "needs_rewrite",
  "needs_review",
  "duplicate",
  "blocked",
  "archived_irrelevant",
  "archived_unsolvable",
  "archived_stale",
] as const;

/**
 * Tags that an operator has explicitly cleared as "this hypothesis can move
 * forward". Phase 2 experiment registration MUST refuse anything not in this
 * set. `candidate` is included because operators use it to mark a hypothesis
 * that has cleared review but is queued behind another experiment — once the
 * experiment slot opens, it should not be re-classified as needing rewrite.
 */
export const READY_TAGS: readonly HygieneTag[] = [
  "ready_for_experiment",
  "candidate",
] as const;

/**
 * Tags that mean "this hypothesis is intentionally out of the active loop".
 * Audit utilities use this set to compute backlog vs. archive counts. Records
 * with these tags should be retained (preserve history) but never iterated.
 */
export const ARCHIVED_TAGS: readonly HygieneTag[] = [
  "archived_irrelevant",
  "archived_unsolvable",
  "archived_stale",
] as const;

export function isReadyTag(tag: HygieneTag): boolean {
  return (READY_TAGS as readonly HygieneTag[]).includes(tag);
}

export function isArchivedTag(tag: HygieneTag): boolean {
  return (ARCHIVED_TAGS as readonly HygieneTag[]).includes(tag);
}

// ── Readiness criteria ───────────────────────────────────────────────────────

/**
 * Every field a hypothesis MUST have before Phase 2 is allowed to register an
 * experiment for it. These are inspectable so the audit utility can report
 * the precise blocker per record.
 *
 * Why each one:
 *   - `claim`           : non-empty, ≥10 chars — anything shorter is a stub
 *   - `metric`          : a measurable indicator must be named
 *   - `basis`           : the evidence basis must be stated (not just a guess)
 *   - `prediction`      : the predicted outcome must be specific
 *   - `measurementPath` : the data source that could confirm/reject it
 *
 * `actionWithin24h` is NOT a readiness requirement — that is the *resolution*
 * gate (Wave 2.3 PR-3) and only applies once the hypothesis transitions out
 * of testing. The Phase 2 readiness gate runs *before* an experiment is
 * registered, not after it resolves.
 */
export interface ReadinessFieldStatus {
  field: string;
  ok: boolean;
  reason?: string;
}

const MIN_CLAIM_CHARS = 10;
const MIN_METRIC_CHARS = 3;
const MIN_PREDICTION_CHARS = 5;

function nonEmpty(s: unknown, min = 1): boolean {
  return typeof s === "string" && s.trim().length >= min;
}

export function computeReadinessFields(hyp: Hypothesis): ReadinessFieldStatus[] {
  const out: ReadinessFieldStatus[] = [];
  out.push({
    field: "claim",
    ok: nonEmpty(hyp.claim, MIN_CLAIM_CHARS),
    reason: nonEmpty(hyp.claim, MIN_CLAIM_CHARS) ? undefined : `claim is missing or shorter than ${MIN_CLAIM_CHARS} chars`,
  });
  out.push({
    field: "metric",
    ok: nonEmpty(hyp.metric, MIN_METRIC_CHARS),
    reason: nonEmpty(hyp.metric, MIN_METRIC_CHARS) ? undefined : "metric is missing — Phase 2 needs a measurable indicator",
  });
  out.push({
    field: "basis",
    ok: nonEmpty(hyp.basis),
    reason: nonEmpty(hyp.basis) ? undefined : "basis is missing — Phase 2 needs the evidence the hypothesis rests on",
  });
  out.push({
    field: "prediction",
    ok: nonEmpty(hyp.prediction, MIN_PREDICTION_CHARS),
    reason: nonEmpty(hyp.prediction, MIN_PREDICTION_CHARS) ? undefined : "prediction is missing or too short to be falsifiable",
  });
  out.push({
    field: "measurementPath",
    ok: nonEmpty(hyp.measurementPath),
    reason: nonEmpty(hyp.measurementPath) ? undefined : "measurementPath is missing — no data source declared (PR #280)",
  });
  return out;
}

export function readinessBlockers(hyp: Hypothesis): string[] {
  return computeReadinessFields(hyp)
    .filter(f => !f.ok)
    .map(f => f.reason ?? `${f.field} is missing`);
}

// ── Tag computation ──────────────────────────────────────────────────────────

/**
 * Compute the hygiene tag for a hypothesis from its fields. Pure,
 * deterministic, no I/O. The verdict layers on top of the existing lifecycle
 * `status` — it does NOT mutate it.
 *
 * Resolution order matters; we want the most specific verdict to win:
 *   1. Operator-set archived/blocked verdicts (`hyp.hygieneTag`) — preserved
 *      verbatim. We never overwrite an operator's archival decision.
 *   2. Lifecycle-derived archives:
 *        status === "data-unavailable" → archived_unsolvable
 *        status === "stale-retired"    → archived_stale
 *        status === "expired"          → archived_stale
 *   3. Explicit duplicates — `hyp.aliasOf` set means consolidator absorbed
 *      this record into a canonical.
 *   4. Field-level readiness — missing measurementPath, missing basis, etc.
 *      get `needs_data` / `needs_rewrite`.
 *   5. Domain rubric verdict — `rubricVerdict === "review"` becomes
 *      `needs_review`; `rubricVerdict === "reject"` becomes `needs_rewrite`.
 *   6. Default — `candidate` if all readiness fields are present and we
 *      haven't found a blocker. `ready_for_experiment` is reserved for
 *      records the operator has explicitly cleared (see `markReady`).
 */
export interface ClassifyOptions {
  /** Treat the operator-set tag (`hyp.hygieneTag`) as authoritative for
   *  archived/blocked/ready_for_experiment values. Defaults to true.
   *  Pass false when re-running the audit to detect drift between operator
   *  intent and current field state. */
  respectOperatorTag?: boolean;
}

export function classifyHypothesis(
  hyp: HygieneAwareHypothesis,
  opts: ClassifyOptions = {},
): { tag: HygieneTag; reasons: string[] } {
  const respect = opts.respectOperatorTag !== false;
  const reasons: string[] = [];

  const operatorTag = hyp.hygieneTag;
  if (respect && operatorTag) {
    if (isArchivedTag(operatorTag) || operatorTag === "blocked" || operatorTag === "ready_for_experiment") {
      reasons.push(`operator-set tag preserved: ${operatorTag}`);
      return { tag: operatorTag, reasons };
    }
  }

  // Lifecycle-derived archives
  if (hyp.status === "data-unavailable") {
    reasons.push("status=data-unavailable → archived_unsolvable");
    return { tag: "archived_unsolvable", reasons };
  }
  if (hyp.status === "stale-retired") {
    reasons.push("status=stale-retired → archived_stale");
    return { tag: "archived_stale", reasons };
  }
  if (hyp.status === "expired") {
    reasons.push("status=expired → archived_stale");
    return { tag: "archived_stale", reasons };
  }

  // Resolved hypotheses are not experiment candidates — they are history.
  // Tag them as candidate-archived so audits can count them, but the
  // readiness gate refuses them.
  if (hyp.status === "confirmed" || hyp.status === "rejected") {
    reasons.push(`status=${hyp.status} → archived_irrelevant (already resolved)`);
    return { tag: "archived_irrelevant", reasons };
  }

  // Duplicates — consolidator wrote aliasOf to point at the canonical.
  if (typeof hyp.aliasOf === "string" && hyp.aliasOf.length > 0) {
    reasons.push(`aliasOf=${hyp.aliasOf} (consolidated into canonical)`);
    return { tag: "duplicate", reasons };
  }

  // Field-level readiness
  const blockers = readinessBlockers(hyp);
  const missingMeasurement = blockers.some(b => b.includes("measurementPath"));
  const missingMetric = blockers.some(b => b.startsWith("metric is missing"));
  const missingBasis = blockers.some(b => b.startsWith("basis is missing"));
  const missingClaim = blockers.some(b => b.startsWith("claim is missing"));
  const missingPrediction = blockers.some(b => b.startsWith("prediction is missing"));

  // Rubric verdict from PR #286 — rejections trump field-level fixes.
  if (hyp.rubricVerdict === "reject") {
    reasons.push("rubricVerdict=reject → needs_rewrite");
    return { tag: "needs_rewrite", reasons };
  }
  if (hyp.rubricVerdict === "review") {
    reasons.push("rubricVerdict=review → needs_review");
    return { tag: "needs_review", reasons };
  }

  if (missingClaim || missingPrediction) {
    reasons.push("claim or prediction missing → needs_rewrite");
    return { tag: "needs_rewrite", reasons };
  }

  if (missingMeasurement) {
    reasons.push("measurementPath missing → needs_data");
    return { tag: "needs_data", reasons };
  }

  if (missingMetric || missingBasis) {
    reasons.push("metric or basis missing → needs_rewrite");
    return { tag: "needs_rewrite", reasons };
  }

  // PR #280 data-source gate already blocked this record.
  if (hyp.dataSourceGateBlockedAt) {
    reasons.push(`data-source gate blocked at ${hyp.dataSourceGateBlockedAt} → needs_data`);
    return { tag: "needs_data", reasons };
  }

  // Operator opt-in for "ready" — only honored when respectOperatorTag is on.
  if (respect && operatorTag === "ready_for_experiment") {
    reasons.push("operator-set ready_for_experiment");
    return { tag: "ready_for_experiment", reasons };
  }
  if (respect && operatorTag === "candidate") {
    reasons.push("operator-set candidate");
    return { tag: "candidate", reasons };
  }

  reasons.push("all readiness fields present, awaiting operator review");
  return { tag: "candidate", reasons };
}

// ── Phase 2 readiness gate ───────────────────────────────────────────────────

export interface ReadinessVerdict {
  ok: boolean;
  tag: HygieneTag;
  reasons: string[];
  blockers: string[];
}

/**
 * The single guard Phase 2 experiment-registration code must call before
 * registering an experiment from a hypothesis. Refuses anything not in
 * `READY_TAGS` and anything with outstanding readiness blockers. A `candidate`
 * with all fields populated is allowed; a `candidate` with missing fields
 * is not (defense-in-depth — operators should not be able to fast-path a
 * record that the field-level audit would catch).
 *
 * NEVER bypass this gate. The Phase 2 propose→approve→apply loop already has
 * its own promotion gate (`server/eval/promotionGate.ts`); this is a *prior*
 * gate that filters which hypotheses can even enter that loop.
 */
export function canFeedExperiment(hyp: HygieneAwareHypothesis): ReadinessVerdict {
  const { tag, reasons } = classifyHypothesis(hyp);
  const blockers = readinessBlockers(hyp);
  if (!isReadyTag(tag)) {
    return {
      ok: false,
      tag,
      reasons: [...reasons, `tag '${tag}' is not in READY_TAGS`],
      blockers,
    };
  }
  if (blockers.length > 0) {
    return {
      ok: false,
      tag,
      reasons: [...reasons, "tag is ready but readiness fields are incomplete"],
      blockers,
    };
  }
  return { ok: true, tag, reasons, blockers: [] };
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface DuplicateGroup {
  normalizedClaim: string;
  ids: string[];
}

export interface HygieneAuditReport {
  total: number;
  byTag: Record<HygieneTag, number>;
  byStatus: Record<string, number>;
  readyCount: number;
  archivedCount: number;
  duplicateGroups: DuplicateGroup[];
  fieldGapCounts: Record<string, number>;
  staleCandidates: Array<{ id: string; ageDays: number; status: string }>;
  generatedAt: string;
}

const DEFAULT_STALE_DAYS = 30;

function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function findDuplicateGroups(hyps: HygieneAwareHypothesis[]): DuplicateGroup[] {
  const groups = new Map<string, string[]>();
  for (const h of hyps) {
    const norm = normalizeClaim(h.claim ?? "");
    if (!norm) continue;
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm)!.push(h.id);
  }
  const out: DuplicateGroup[] = [];
  for (const [norm, ids] of groups) {
    if (ids.length > 1) out.push({ normalizedClaim: norm, ids });
  }
  return out.sort((a, b) => b.ids.length - a.ids.length);
}

export function auditHypotheses(
  hyps: HygieneAwareHypothesis[],
  opts: { now?: Date; staleDays?: number } = {},
): HygieneAuditReport {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;

  const byTag = Object.fromEntries(HYGIENE_TAGS.map(t => [t, 0])) as Record<HygieneTag, number>;
  const byStatus: Record<string, number> = {};
  const fieldGapCounts: Record<string, number> = {};
  const staleCandidates: HygieneAuditReport["staleCandidates"] = [];

  let readyCount = 0;
  let archivedCount = 0;

  for (const h of hyps) {
    const { tag } = classifyHypothesis(h);
    byTag[tag] = (byTag[tag] ?? 0) + 1;
    byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
    if (isReadyTag(tag)) readyCount++;
    if (isArchivedTag(tag)) archivedCount++;

    for (const f of computeReadinessFields(h)) {
      if (!f.ok) fieldGapCounts[f.field] = (fieldGapCounts[f.field] ?? 0) + 1;
    }

    // Stale candidates: still in active lifecycle, formed more than staleDays
    // ago, never resolved. We do NOT auto-archive — this is a list for the
    // operator to review.
    if (h.status === "forming" || h.status === "testing") {
      const formed = h.formedAt ? new Date(h.formedAt) : null;
      if (formed && !isNaN(formed.getTime())) {
        const ageMs = now.getTime() - formed.getTime();
        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        if (ageDays >= staleDays) {
          staleCandidates.push({ id: h.id, ageDays, status: h.status });
        }
      }
    }
  }

  return {
    total: hyps.length,
    byTag,
    byStatus,
    readyCount,
    archivedCount,
    duplicateGroups: findDuplicateGroups(hyps),
    fieldGapCounts,
    staleCandidates: staleCandidates.sort((a, b) => b.ageDays - a.ageDays),
    generatedAt: now.toISOString(),
  };
}

// ── Optional persistent annotation ───────────────────────────────────────────
//
// Operators who want the hygiene verdict reflected in the stored record may
// annotate it via `hygieneTag` + `hygieneReason` + `hygieneTaggedAt`. These
// fields are read by `classifyHypothesis` (when `respectOperatorTag` is on)
// but no production code path mutates them automatically. The CLI audit and
// any future review UI are the only writers.

export interface HygieneAwareHypothesis extends Hypothesis {
  /** Operator-set tag. When present and is one of READY_TAGS / ARCHIVED_TAGS
   *  / "blocked", `classifyHypothesis` honors it verbatim. */
  hygieneTag?: HygieneTag;
  hygieneReason?: string;
  hygieneTaggedAt?: string;
  hygieneTaggedBy?: string;
}

export function annotate(
  hyp: HygieneAwareHypothesis,
  tag: HygieneTag,
  reason: string,
  taggedBy = "operator",
  now: Date = new Date(),
): HygieneAwareHypothesis {
  return {
    ...hyp,
    hygieneTag: tag,
    hygieneReason: reason,
    hygieneTaggedAt: now.toISOString(),
    hygieneTaggedBy: taggedBy,
  };
}
