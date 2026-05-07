/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  RESEARCH CYCLE META-IMPROVEMENT (PR #286)
 *
 *  At end-of-cycle, analyze the rubric trace produced by researchFocusGate
 *  and:
 *    1. Append a per-cycle lesson record to the improvement archive
 *       (improvementArchive.jsonl) so future cycles see what worked / failed.
 *    2. When metrics suggest the rubric, weights, threshold, generation cap,
 *       or hypothesis-prompt should change, file a self-recommendation via
 *       selfRecommendationEngine (proposes-only, operator approval required).
 *
 *  Approval-safe invariants:
 *    • Never auto-applies a procedure change. Procedure changes are filed
 *      via proposeRecommendation() with status='proposed' and the
 *      operator-approval path is the only route to status='applied'. The
 *      promotion gate still sits in front of any apply.
 *    • Never edits the rubric weights, threshold, MAX_GENERATED_PER_CYCLE,
 *      or any prompt — those constants are pinned in researchFocusRubric.ts
 *      and the prompt lives in researchEngine.runPhase3_HypothesisFormation.
 *    • Always records the lesson, even when no procedure change is
 *      proposed, so the archive has a continuous trace.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  endResearchCycle,
  summarizeCycleEvaluations,
  type CycleEvaluationRecord,
  type CycleStats,
} from "./researchFocusGate.js";
import { appendImprovementRecord, type ImprovementRecord } from "./improvementArchive.js";
import { proposeRecommendation } from "./selfRecommendationEngine.js";
import type { SelfRecommendation } from "@shared/schema";
import {
  scoreReasoningTrace,
  type ReasoningQualityScorecard,
} from "./reasoningQualityHarness.js";
import {
  appendReasoningQualityEntry,
  readReasoningQualityEntries,
} from "./reasoningQualityStore.js";

// ── Heuristic thresholds for procedure-change suggestions ───────────────────

/** Below this pursue-rate (out of total scored), the rubric/prompt is suspect. */
export const LOW_PASS_RATE_THRESHOLD = 0.10;
/** Above this missing-protocol rate, the prompt fails to elicit a protocol. */
export const HIGH_MISSING_PROTOCOL_RATE = 0.50;
/** Above this duplicate rate, novelty seeding is broken. */
export const HIGH_DUPLICATE_RATE = 0.40;
/** Above this missing-scores rate, the generator prompt likely strips axes. */
export const HIGH_MISSING_SCORES_RATE = 0.50;
/** Above this cap-exceeded count, the generator overshot the per-cycle cap. */
export const CAP_EXCEEDED_THRESHOLD = 1;
/** Minimum cycle size before procedure-change suggestions fire. Below this, signal is too noisy. */
export const MIN_CYCLE_SIZE_FOR_PROCEDURE_CHANGE = 3;

// ── Public types ────────────────────────────────────────────────────────────

export interface MetaImprovementResult {
  cycleId: string;
  stats: CycleStats;
  archiveRecord: ImprovementRecord;
  /** Recommendations filed (or matched via dedupe). Empty when nothing was anomalous. */
  recommendations: SelfRecommendation[];
  /** Plain-text summary suitable for cycle-end logging. */
  summary: string;
  /**
   * PR #288 — provisional reasoning-quality scorecard for this cycle's lesson
   * trace. Observational only: never gates publishing, never auto-applies a
   * change. `null` when scoring was disabled for the run.
   */
  reasoningScorecard: ReasoningQualityScorecard | null;
}

export interface RunMetaOptions {
  /** Cycle id to record. Defaults to time-based when not provided. */
  cycleId?: string;
  /** Variant label written to improvementArchive. */
  variantLabel?: string;
  /** Operator may pass an explicit list of pre-loaded records (tests). */
  recordsOverride?: CycleEvaluationRecord[];
  /** Disable proposal filing (tests). Default true (filing enabled). */
  fileRecommendations?: boolean;
  /**
   * PR #288 — disable observational reasoning-quality scoring (tests).
   * Default true. When false, no scorecard is computed and no JSONL line
   * is appended; the rest of the meta-improvement path is unchanged.
   */
  scoreReasoning?: boolean;
}

// ── Procedure-change detection ──────────────────────────────────────────────

interface ProcedureChangeProposal {
  title: string;
  rationale: string;
  proposedChange: string;
  evidence: string[];
  /** Stable per-axis dedupe key so the same anomaly doesn't pile up daily. */
  dedupeKey: string;
}

/**
 * Inspect cycle stats and produce zero-or-more procedure-change proposals.
 * Pure: no I/O, no LLM, deterministic for a given stats object. Each
 * proposal is a *suggestion* — never a directive — and routes through the
 * propose-only path.
 */
export function deriveProcedureChangeProposals(stats: CycleStats): ProcedureChangeProposal[] {
  const proposals: ProcedureChangeProposal[] = [];

  if (stats.total < MIN_CYCLE_SIZE_FOR_PROCEDURE_CHANGE) return proposals;

  // 1. Pass-rate floor — rubric or prompt is starving the queue.
  if (stats.passRate < LOW_PASS_RATE_THRESHOLD) {
    proposals.push({
      title: "Research focus rubric: pursue rate fell below floor",
      rationale:
        `Pursue rate ${(stats.passRate * 100).toFixed(1)}% (${stats.pursued}/${stats.total}) ` +
        `is below the ${LOW_PASS_RATE_THRESHOLD * 100}% floor. Either the threshold is too tight, ` +
        `the generator prompt is mis-anchored, or the cycle is dominated by speculative claims.`,
      proposedChange:
        "Operator review: consider lowering PURSUE_THRESHOLD by 0.5, OR rewriting the Phase-3 hypothesis prompt to anchor higher-leverage claims, OR loosening selfExperimentFeasibility expectations for the next 2 cycles. Any change must be approved before applying.",
      evidence: [
        `passRate=${stats.passRate.toFixed(3)}`,
        `pursued=${stats.pursued}`,
        `reviewed=${stats.reviewed}`,
        `rejected=${stats.rejected}`,
      ],
      dedupeKey: `meta_pass_rate_floor`,
    });
  }

  // 2. Missing-protocol rate — Phase-3 prompt fails to elicit a complete protocol.
  if (stats.missingProtocol / Math.max(1, stats.total) > HIGH_MISSING_PROTOCOL_RATE) {
    proposals.push({
      title: "Phase-3 prompt: hypothesis self-experiment protocol missing in majority of candidates",
      rationale:
        `${stats.missingProtocol}/${stats.total} candidates this cycle had no complete ` +
        `selfExperimentProtocol — the generator produces hypotheses without a metric/design/threshold/rollback structure.`,
      proposedChange:
        "Operator review: tighten the runPhase3_HypothesisFormation prompt to require all four protocol fields with example values, OR add a retry pass when protocol is missing.",
      evidence: [
        `missingProtocol=${stats.missingProtocol}`,
        `total=${stats.total}`,
        `rate=${(stats.missingProtocol / stats.total).toFixed(2)}`,
      ],
      dedupeKey: `meta_missing_protocol_rate`,
    });
  }

  // 3. Duplicate / near-dup rate — novelty seeding is broken.
  if (stats.duplicateOrNear / Math.max(1, stats.total) > HIGH_DUPLICATE_RATE) {
    proposals.push({
      title: "Hypothesis duplication: archive overlap rate is high",
      rationale:
        `${stats.duplicateOrNear}/${stats.total} candidates this cycle were exact or near-duplicates ` +
        `of prior archive entries. The generator is re-emitting prior claims instead of seeking gaps.`,
      proposedChange:
        "Operator review: feed the top-K most-recent archive claims into the Phase-3 prompt as a 'do not repeat' list, OR rotate the seed query/topic selection.",
      evidence: [
        `duplicateOrNear=${stats.duplicateOrNear}`,
        `total=${stats.total}`,
        `rate=${(stats.duplicateOrNear / stats.total).toFixed(2)}`,
      ],
      dedupeKey: `meta_duplicate_rate`,
    });
  }

  // 4. Missing-scores rate — generator strips rubric scores.
  if (stats.missingScores / Math.max(1, stats.total) > HIGH_MISSING_SCORES_RATE) {
    proposals.push({
      title: "Phase-3 prompt: hypothesis rubric scores missing in majority of candidates",
      rationale:
        `${stats.missingScores}/${stats.total} candidates this cycle had no 4-axis rubric scores. ` +
        `Without scores the gate cannot run; all such candidates routed to operator review by default.`,
      proposedChange:
        "Operator review: tighten the Phase-3 prompt JSON schema to require a numeric rubricScores object, OR add a structured retry that re-asks for scores when the first parse omits them.",
      evidence: [
        `missingScores=${stats.missingScores}`,
        `total=${stats.total}`,
        `rate=${(stats.missingScores / stats.total).toFixed(2)}`,
      ],
      dedupeKey: `meta_missing_scores_rate`,
    });
  }

  // 5. Cap-exceeded — generator over-produced this cycle.
  if (stats.capExceeded >= CAP_EXCEEDED_THRESHOLD) {
    proposals.push({
      title: "Hypothesis generation cap exceeded this cycle",
      rationale:
        `${stats.capExceeded} candidate(s) this cycle were demoted to operator review because the ` +
        `MAX_GENERATED_PER_CYCLE cap was hit. Repeat over-production wastes Phase-3 token budget.`,
      proposedChange:
        "Operator review: reduce the number of seeded research topics per cycle, OR consider whether MAX_GENERATED_PER_CYCLE should be lifted for high-pressure cycles. Any change must be approved.",
      evidence: [
        `capExceeded=${stats.capExceeded}`,
        `total=${stats.total}`,
      ],
      dedupeKey: `meta_cap_exceeded`,
    });
  }

  return proposals;
}

// ── Lesson summarization for archive ────────────────────────────────────────

function summarizeForArchive(stats: CycleStats, proposalCount: number): string {
  const lines = [
    `cycle stats: total=${stats.total} pursued=${stats.pursued} reviewed=${stats.reviewed} rejected=${stats.rejected}`,
    `passRate=${stats.passRate.toFixed(3)} completionRate=${stats.completionRate.toFixed(3)}`,
    `missingScores=${stats.missingScores} missingProtocol=${stats.missingProtocol} dups=${stats.duplicateOrNear} capExceeded=${stats.capExceeded}`,
    `proposals filed: ${proposalCount}`,
  ];
  return lines.join(" | ");
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run end-of-cycle meta-improvement. Always idempotent at the cycle level —
 * if no cycle is active and no recordsOverride is supplied, returns null.
 *
 * Side effects (intentional, all propose-only):
 *   1. appendImprovementRecord — JSONL line.
 *   2. zero-or-more proposeRecommendation calls — status='proposed'.
 *
 * No other persistent state is mutated. The promotion gate continues to
 * sit between any approved recommendation and any apply transition.
 */
export function runResearchCycleMetaImprovement(opts: RunMetaOptions = {}): MetaImprovementResult | null {
  const fileRecs = opts.fileRecommendations ?? true;
  const doScore = opts.scoreReasoning ?? true;
  let cycleId: string;
  let records: CycleEvaluationRecord[];

  if (opts.recordsOverride) {
    cycleId = opts.cycleId ?? `override_${Date.now()}`;
    records = opts.recordsOverride;
  } else {
    const ended = endResearchCycle();
    if (!ended) return null;
    cycleId = opts.cycleId ?? ended.cycleId;
    records = ended.records;
  }

  const stats = summarizeCycleEvaluations(records);
  const proposals = deriveProcedureChangeProposals(stats);

  // File proposals (idempotent via dedupeKey). Each is category='engine',
  // risk='low' — these are propose-only suggestions, the operator decides
  // whether they merit any procedure change.
  const filed: SelfRecommendation[] = [];
  if (fileRecs) {
    for (const p of proposals) {
      try {
        const rec = proposeRecommendation({
          category: "engine",
          risk: "low",
          title: p.title,
          rationale: p.rationale,
          proposedChange: p.proposedChange,
          evidence: p.evidence,
          author: "agent",
          dedupeKey: p.dedupeKey,
        });
        filed.push(rec);
      } catch (e: any) {
        console.warn(`[MetaImprovement] proposeRecommendation failed for "${p.title}":`, e?.message ?? e);
      }
    }
  }

  const variantLabel = opts.variantLabel ?? `cycle/${cycleId}`;
  const lessonText = summarizeForArchive(stats, filed.length);
  const archiveRecord = appendImprovementRecord({
    variantLabel,
    claim: `meta-improvement trace for cycle ${cycleId}`,
    overall: stats.passRate * 10, // archive expects 0-10; use passRate scaled
    lesson: lessonText,
    proposesChange: filed.length > 0,
    selfRecommendationId: filed[0]?.id,
  });

  // PR #288 — observational reasoning-quality score over the cycle's lesson
  // trace. Scoring is pure / deterministic / cheap and the harness pins
  // autoApply=false. The store rejects any tampered scorecard at the
  // boundary. Nothing here gates publishing or modifies engine state.
  let reasoningScorecard: ReasoningQualityScorecard | null = null;
  if (doScore) {
    try {
      // Use prior cycle scorecards' flourishingProxy as recent history so
      // the harness can compute a delta and (if persistently low) raise the
      // self-obviation recommendation. Recommendation is observational —
      // no caller in this PR consumes it for auto-action.
      const recentHistory = readReasoningQualityEntries()
        .slice(-5)
        .map(e => e.scorecard.flourishingProxy)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

      reasoningScorecard = scoreReasoningTrace({
        text: lessonText,
        prompt: `cycle ${cycleId} meta-improvement summary`,
        reportedConfidence: stats.passRate,
        irreversibleCommit: false, // archive append is reversible-by-policy
        alternativesConsidered: proposals.map(p => p.title),
        sources: records.map(r => r.candidateRef).slice(0, 8),
        domain: "research-cycle/meta-improvement",
        recentFlourishingHistory: recentHistory,
      });

      appendReasoningQualityEntry({
        engineStep: "research-cycle/meta-improvement",
        cycleId,
        domain: "lesson",
        scorecard: reasoningScorecard,
      });
    } catch (e: any) {
      console.warn(`[MetaImprovement] reasoning-quality scoring failed (non-fatal):`, e?.message ?? e);
    }
  }

  const summary =
    `[MetaImprovement] cycle=${cycleId} ${lessonText}` +
    (reasoningScorecard
      ? ` | reasoning-band=${reasoningScorecard.reasoningQualityBand} F=${reasoningScorecard.flourishingProxy} σ=${reasoningScorecard.sigma}`
      : "");
  console.log(summary);

  return {
    cycleId,
    stats,
    archiveRecord,
    recommendations: filed,
    summary,
    reasoningScorecard,
  };
}
