/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  RESEARCH FOCUS GATE (PR #286 — live wiring of #285)
 *
 *  PR #285 introduced researchFocusRubric.ts (a pure scorer + duplication +
 *  protocol validator) and improvementArchive.ts (an append-only JSONL log).
 *  Neither was wired into the live research/hypothesis pipeline. This module
 *  is the narrow integration point: given a freshly-generated hypothesis
 *  candidate (from runPhase3_HypothesisFormation, archive backfills, or any
 *  future generator) it returns a deterministic verdict.
 *
 *  Approval-safe invariants this module preserves:
 *    1. Never auto-publishes anything.
 *    2. Never silently drops a candidate. Sub-threshold or missing-protocol
 *       hypotheses are routed to verdict='review' / 'reject' with an explicit
 *       reason callers must surface.
 *    3. Never modifies the rubric, weights, threshold, archive contents, or
 *       any other engine state. Procedure changes happen only via
 *       selfRecommendationEngine.proposeRecommendation() and operator
 *       approval.
 *    4. Observability — every evaluation accumulates a stat record in the
 *       active cycle accumulator so researchCycleMetaImprovement can produce
 *       a trace at end-of-cycle.
 *
 *  Generation cap: callers that produce a batch (>1) per cycle should call
 *  evaluateHypothesisBatch(); single-candidate callers can use
 *  evaluateHypothesisForFocus() and the in-memory accumulator will still
 *  enforce MAX_GENERATED_PER_CYCLE across all single-candidate calls within
 *  a cycle window (those above the cap are routed to 'review' with
 *  reason="cap_exceeded").
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  scoreResearchFocus,
  selectTopHypotheses,
  validateSelfExperimentProtocol,
  MAX_GENERATED_PER_CYCLE,
  TOP_SELECTION_MAX,
  type ResearchFocusInput,
  type ResearchFocusResult,
  type ResearchFocusScores,
  type SelfExperimentProtocol,
  type RubricVerdict,
  type ArchiveEntry,
} from "./researchFocusRubric.js";
import { archiveAsClaimSet } from "./improvementArchive.js";

// ── Per-cycle in-memory accumulator ─────────────────────────────────────────

export interface CycleEvaluationRecord {
  /** Unique candidate fingerprint (claim hash). */
  candidateRef: string;
  /** Verdict produced by the rubric (or our cap-overflow demote). */
  verdict: RubricVerdict;
  /** Weighted rubric overall score, or null if scores were missing entirely. */
  overall: number | null;
  /** True iff a complete selfExperimentProtocol was attached. */
  hadProtocol: boolean;
  /** True iff candidate matched an existing archive entry above near-dup threshold. */
  isDuplicate: boolean;
  /** Reason string (rubric or cap/null-scores). */
  reason: string;
  /** Optional caller-supplied tag (e.g. "phase3", "consolidator") for trace analysis. */
  source?: string;
  /** ISO timestamp of evaluation. */
  recordedAt: string;
}

interface CycleAccumulator {
  cycleId: string;
  startedAt: string;
  records: CycleEvaluationRecord[];
}

let activeCycle: CycleAccumulator | null = null;

/**
 * Begin (or reset) the cycle-scoped accumulator. dailyCycleEngine should call
 * this at the start of every cycle. Idempotent: a second call with the same
 * cycleId is a no-op so re-entrant cycle code (e.g. an in-process retry) does
 * not lose prior records.
 */
export function startResearchCycle(cycleId: string): void {
  if (activeCycle && activeCycle.cycleId === cycleId) return;
  activeCycle = {
    cycleId,
    startedAt: new Date().toISOString(),
    records: [],
  };
}

/**
 * End the cycle accumulator and return its records. Idempotent: returns an
 * empty record list if no cycle is active. Callers that need stats should
 * pair this with summarizeCycleEvaluations().
 */
export function endResearchCycle(): { cycleId: string; startedAt: string; records: CycleEvaluationRecord[] } | null {
  if (!activeCycle) return null;
  const out = activeCycle;
  activeCycle = null;
  return out;
}

/** Read the active cycle without ending it. Used by tests / observability. */
export function peekActiveCycle(): CycleAccumulator | null {
  return activeCycle;
}

function recordEvaluation(rec: Omit<CycleEvaluationRecord, "recordedAt">): void {
  if (!activeCycle) return;
  activeCycle.records.push({ ...rec, recordedAt: new Date().toISOString() });
}

// ── Single-candidate evaluation ─────────────────────────────────────────────

export interface EvaluateForFocusOptions {
  /** Caller-supplied archive override; defaults to live improvementArchive. */
  archive?: ArchiveEntry[];
  /** Tag for trace analysis (e.g. "phase3", "consolidator"). */
  source?: string;
  /** Override generation cap (tests). */
  cap?: number;
}

export interface EvaluateForFocusResult {
  /** Final verdict — pursue / review / reject. */
  verdict: RubricVerdict;
  /** Reason string suitable for stamping on the hypothesis. */
  reason: string;
  /** Weighted rubric overall (0-10), or null if scores were missing. */
  overall: number | null;
  /** Echoed protocol when present and complete. */
  selfExperimentProtocol?: SelfExperimentProtocol;
  /** Underlying rubric result when scores were available; undefined when missing. */
  rubricResult?: ResearchFocusResult;
  /** True iff this candidate was demoted due to MAX_GENERATED_PER_CYCLE. */
  capExceeded: boolean;
}

/**
 * Hash the canonicalized claim text so duplicate evaluations of the same
 * claim within a cycle don't double-count in the accumulator. Cheap; no
 * cryptographic claim — just a stable bucket.
 */
function candidateRefFor(claim: string): string {
  let h = 0;
  for (let i = 0; i < claim.length; i++) h = ((h << 5) - h + claim.charCodeAt(i)) | 0;
  return `cand_${(h >>> 0).toString(36)}`;
}

/**
 * Evaluate a single hypothesis candidate against the focus rubric. Always
 * returns a verdict. Sub-threshold → reject; passing without complete
 * protocol → review. Caller is responsible for stamping the verdict on the
 * hypothesis row and surfacing the reason. This function does NOT mutate
 * any persistent state besides the per-cycle accumulator.
 *
 * Missing-scores policy: if the caller cannot produce structured rubric
 * scores (e.g. the LLM returned no axis numbers), we fail to verdict='review'
 * with reason="missing_rubric_scores". Never silently 'pursue'.
 */
export function evaluateHypothesisForFocus(
  input: {
    claim: string;
    scores?: Partial<ResearchFocusScores>;
    selfExperimentProtocol?: unknown;
    notes?: string;
  },
  options: EvaluateForFocusOptions = {},
): EvaluateForFocusResult {
  const ref = candidateRefFor(input.claim.trim());
  const archive = options.archive ?? archiveAsClaimSet();
  const cap = options.cap ?? MAX_GENERATED_PER_CYCLE;

  // Cap enforcement (cycle-scoped). Counts only candidates we've evaluated
  // in the active cycle — accept the (cap+1)th and beyond as 'review' with
  // an explicit reason so nothing is silently dropped.
  const seenSoFar = activeCycle?.records.filter(r => r.source === options.source || !options.source).length ?? 0;
  const capExceeded = activeCycle != null && seenSoFar >= cap;

  // Missing-scores guard. We require all four axes present and finite to
  // run the rubric. Otherwise route to 'review' rather than guessing.
  const s = input.scores ?? {};
  const haveScores =
    typeof s.selfImprovementLeverage   === "number" && Number.isFinite(s.selfImprovementLeverage)   &&
    typeof s.selfExperimentFeasibility === "number" && Number.isFinite(s.selfExperimentFeasibility) &&
    typeof s.aiBreakthroughNovelty     === "number" && Number.isFinite(s.aiBreakthroughNovelty)     &&
    typeof s.efficiencyLowWaste        === "number" && Number.isFinite(s.efficiencyLowWaste);

  if (!haveScores) {
    const reason = "missing_rubric_scores — generator did not supply 4-axis scores; routing to operator review";
    recordEvaluation({
      candidateRef: ref,
      verdict: "review",
      overall: null,
      hadProtocol: validateSelfExperimentProtocol(input.selfExperimentProtocol).ok,
      isDuplicate: false,
      reason,
      source: options.source,
    });
    return { verdict: "review", reason, overall: null, capExceeded: false };
  }

  if (capExceeded) {
    const reason = `cap_exceeded — already evaluated ${seenSoFar} hypotheses this cycle (cap=${cap}); routing to operator review`;
    recordEvaluation({
      candidateRef: ref,
      verdict: "review",
      overall: null,
      hadProtocol: validateSelfExperimentProtocol(input.selfExperimentProtocol).ok,
      isDuplicate: false,
      reason,
      source: options.source,
    });
    return { verdict: "review", reason, overall: null, capExceeded: true };
  }

  // Use selectTopHypotheses with a single candidate so we get duplication
  // routing for free (and matching review/reject semantics).
  const rubricInput: ResearchFocusInput = {
    claim: input.claim,
    scores: {
      selfImprovementLeverage:   s.selfImprovementLeverage   as number,
      selfExperimentFeasibility: s.selfExperimentFeasibility as number,
      aiBreakthroughNovelty:     s.aiBreakthroughNovelty     as number,
      efficiencyLowWaste:        s.efficiencyLowWaste        as number,
    },
    selfExperimentProtocol: validateSelfExperimentProtocol(input.selfExperimentProtocol).ok
      ? (input.selfExperimentProtocol as SelfExperimentProtocol)
      : undefined,
    notes: input.notes,
  };
  const batch = selectTopHypotheses([rubricInput], { archive });
  const r: ResearchFocusResult =
    batch.selected[0] ?? batch.review[0] ?? batch.rejected[0] ?? scoreResearchFocus(rubricInput);

  recordEvaluation({
    candidateRef: ref,
    verdict: r.verdict,
    overall: r.overall,
    hadProtocol: !!r.selfExperimentProtocol,
    isDuplicate: r.duplication?.kind === "exact" || r.duplication?.kind === "near",
    reason: r.reason,
    source: options.source,
  });

  return {
    verdict: r.verdict,
    reason: r.reason,
    overall: r.overall,
    selfExperimentProtocol: r.selfExperimentProtocol,
    rubricResult: r,
    capExceeded: false,
  };
}

// ── Batch evaluation (preferred when a generator emits >1 candidate at once) ─

export interface EvaluateBatchOptions extends EvaluateForFocusOptions {
  /** Override TOP_SELECTION_MAX (tests). */
  topN?: number;
}

export interface EvaluateBatchResult {
  selected: ResearchFocusResult[];
  review:   ResearchFocusResult[];
  rejected: ResearchFocusResult[];
  /** Generation/cap stats from selectTopHypotheses. */
  stats: {
    generated: number;
    considered: number;
    passingThreshold: number;
    selected: number;
    routedToReview: number;
    rejected: number;
  };
}

/**
 * Evaluate a full cycle's worth of generated candidates at once. This is the
 * preferred entry point for any generator that emits in batches because it
 * applies the deterministic top-N selection rule and produces accurate stats
 * (versus single-candidate cap accounting which only sees the order-of-arrival).
 */
export function evaluateHypothesisBatch(
  candidates: Array<{
    claim: string;
    scores?: Partial<ResearchFocusScores>;
    selfExperimentProtocol?: unknown;
    notes?: string;
  }>,
  options: EvaluateBatchOptions = {},
): EvaluateBatchResult {
  const archive = options.archive ?? archiveAsClaimSet();
  const topN = options.topN ?? TOP_SELECTION_MAX;
  const cap = options.cap ?? MAX_GENERATED_PER_CYCLE;

  // Convert to ResearchFocusInput, dropping candidates that didn't supply
  // structured scores. We still record them in the accumulator so the cycle
  // trace has a complete account of what the generator produced.
  const usable: ResearchFocusInput[] = [];
  for (const c of candidates) {
    const s = c.scores ?? {};
    const have =
      typeof s.selfImprovementLeverage   === "number" && Number.isFinite(s.selfImprovementLeverage)   &&
      typeof s.selfExperimentFeasibility === "number" && Number.isFinite(s.selfExperimentFeasibility) &&
      typeof s.aiBreakthroughNovelty     === "number" && Number.isFinite(s.aiBreakthroughNovelty)     &&
      typeof s.efficiencyLowWaste        === "number" && Number.isFinite(s.efficiencyLowWaste);
    if (!have) {
      recordEvaluation({
        candidateRef: candidateRefFor(c.claim.trim()),
        verdict: "review",
        overall: null,
        hadProtocol: validateSelfExperimentProtocol(c.selfExperimentProtocol).ok,
        isDuplicate: false,
        reason: "missing_rubric_scores — generator did not supply 4-axis scores",
        source: options.source,
      });
      continue;
    }
    usable.push({
      claim: c.claim,
      scores: {
        selfImprovementLeverage:   s.selfImprovementLeverage   as number,
        selfExperimentFeasibility: s.selfExperimentFeasibility as number,
        aiBreakthroughNovelty:     s.aiBreakthroughNovelty     as number,
        efficiencyLowWaste:        s.efficiencyLowWaste        as number,
      },
      selfExperimentProtocol: validateSelfExperimentProtocol(c.selfExperimentProtocol).ok
        ? (c.selfExperimentProtocol as SelfExperimentProtocol)
        : undefined,
      notes: c.notes,
    });
  }

  const out = selectTopHypotheses(usable, { archive, topN, cap });

  // Push all scored results into the accumulator so the trace is complete.
  for (const bucket of [out.selected, out.review, out.rejected]) {
    for (const r of bucket) {
      recordEvaluation({
        candidateRef: candidateRefFor(r.scores ? `r_${r.overall}_${r.reason.slice(0, 24)}` : r.reason),
        verdict: r.verdict,
        overall: r.overall,
        hadProtocol: !!r.selfExperimentProtocol,
        isDuplicate: r.duplication?.kind === "exact" || r.duplication?.kind === "near",
        reason: r.reason,
        source: options.source,
      });
    }
  }

  return out;
}

// ── Cycle stats summarisation ───────────────────────────────────────────────

export interface CycleStats {
  total: number;
  pursued: number;
  reviewed: number;
  rejected: number;
  missingScores: number;
  missingProtocol: number;
  duplicateOrNear: number;
  capExceeded: number;
  /** Pass rate = pursued / total. Returns 0 when total==0. */
  passRate: number;
  /** Pursue+review (anything not rejected) / total. */
  completionRate: number;
}

/**
 * Compute summary stats from a cycle's evaluation records. Pure; safe to
 * call from any caller (post-cycle hook, dashboard, tests).
 */
export function summarizeCycleEvaluations(records: CycleEvaluationRecord[]): CycleStats {
  const total = records.length;
  let pursued = 0, reviewed = 0, rejected = 0;
  let missingScores = 0, missingProtocol = 0, duplicateOrNear = 0, capExceeded = 0;
  for (const r of records) {
    if (r.verdict === "pursue") pursued++;
    else if (r.verdict === "review") reviewed++;
    else rejected++;

    if (r.overall === null && r.reason.startsWith("missing_rubric_scores")) missingScores++;
    if (r.reason.startsWith("cap_exceeded")) capExceeded++;
    if (!r.hadProtocol) missingProtocol++;
    if (r.isDuplicate) duplicateOrNear++;
  }
  return {
    total,
    pursued,
    reviewed,
    rejected,
    missingScores,
    missingProtocol,
    duplicateOrNear,
    capExceeded,
    passRate:       total > 0 ? pursued / total : 0,
    completionRate: total > 0 ? (pursued + reviewed) / total : 0,
  };
}

// ── Test-only reset (not for production callers) ────────────────────────────

/**
 * Internal utility for tests. Production cycle code should use
 * startResearchCycle/endResearchCycle for proper lifecycle control.
 */
export function _resetCycleAccumulatorForTests(): void {
  activeCycle = null;
}
