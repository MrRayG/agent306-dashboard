/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2: HYPOTHESIS → EXPERIMENT SELECTION
 *
 * Phase 1.5 produced the hygiene gate (`canFeedExperiment`) and Phase 1.5b
 * produced the hard-no for memory-origin hypotheses. Phase 2 turns that into
 * a *selector*: given the formal `research_lab.hypotheses[]` backlog, return
 * the subset that is allowed to feed experiment registration, with explicit
 * decision evidence (or refusal reasons) for every record.
 *
 * This module is intentionally:
 *   - PURE: no I/O, no DB writes, no LLM calls. Inputs are arrays of
 *     `Hypothesis` records, outputs are typed reports. The repository read
 *     is delegated to the caller (`server/repositories/researchRepository.ts`)
 *     so this module is unit-testable without a database or filesystem.
 *   - PROPOSE-ONLY: it never registers an experiment. The output is a
 *     candidate list; the operator (or a future router) decides what to do.
 *     This mirrors the propose-only invariant in `selfRecommendationEngine.ts`
 *     and `hypothesisHygiene.ts`.
 *   - DEFENSE-IN-DEPTH: every candidate goes through `canFeedExperiment` from
 *     `hypothesisHygiene.ts`. Memory-origin hypotheses are explicitly refused
 *     by `selectMemoryOriginRefusals` — there is no path that lets a raw
 *     `memory_knowledge.json` entry become an experiment candidate.
 *
 * Phase 2 entry criteria (codified):
 *   1. Record lives in `data/research_lab.json` under `hypotheses[]` (i.e. is
 *      a *formal* `Hypothesis`, not a `MemoryKnowledgeEntry`).
 *   2. `canFeedExperiment(hyp).ok === true` — hygiene tag in `READY_TAGS`,
 *      no readiness-field blockers, no operator archive.
 *   3. (Phase 2b will layer on per-experiment metric/data-source binding.)
 *
 * Out of scope for Phase 2 (deferred to Phase 2b):
 *   - Statistical decision rules (Bayes / SPRT / CUPED).
 *   - Promotion / retraction events and their persistence.
 *   - Live scheduler automation (we do NOT auto-call `registerExperiment`
 *     from this module).
 *   - Dashboards.
 *   - Per-candidate metric → `experiments.metricKey` binding (today the
 *     metric is a free-text field on the hypothesis; Phase 2b will tighten
 *     this to a registered metric key).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  canFeedExperiment,
  classifyHypothesis,
  readinessBlockers,
  type HygieneAwareHypothesis,
  type HygieneTag,
  type ReadinessVerdict,
} from "../hypothesisHygiene.js";
import {
  isMemoryHypothesisEntry,
  canMemoryEntryFeedExperiment,
  type MemoryKnowledgeEntry,
} from "../memoryHypothesisHygiene.js";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A formal hypothesis the selector accepted as a candidate for Phase 2
 * experiment registration. The `verdict` is the raw output of
 * `canFeedExperiment` so a downstream caller can audit *why* this record
 * was accepted (e.g. operator-set `ready_for_experiment` vs. derived
 * `candidate`).
 */
export interface HypothesisExperimentCandidate {
  hypothesisId: string;
  claim:        string;
  metric:       string;
  measurementPath?: string;
  tag:          HygieneTag;
  verdict:      ReadinessVerdict;
  /** Always "research_lab.hypotheses" for the formal path. Memory-origin
   *  inputs never reach this list — they appear in `memoryRefusals` instead. */
  origin:       "research_lab.hypotheses";
}

/**
 * A formal hypothesis the selector refused, with structured evidence so the
 * operator can fix the underlying record (or decide to leave it archived).
 */
export interface HypothesisExperimentRefusal {
  hypothesisId: string;
  claim?:       string;
  tag:          HygieneTag;
  reasons:      string[];
  blockers:     string[];
  origin:       "research_lab.hypotheses";
}

/**
 * Refusal record for a memory-origin entry. Always non-ok by construction —
 * `canMemoryEntryFeedExperiment` has no `ok: true` branch (Phase 1.5b).
 *
 * Distinct type from `HypothesisExperimentRefusal` so callers cannot
 * accidentally treat a memory-origin record as a formal hypothesis refusal
 * and try to "fix the readiness fields" on a record that should be promoted
 * via the formal path instead.
 */
export interface MemoryOriginRefusal {
  /** Memory entry id, prefixed with `memory:` so it cannot collide with a
   *  formal hypothesis id in mixed reporting. */
  refId:        string;
  /** Original memory entry id (without prefix). */
  memoryEntryId: string;
  title:        string;
  reasons:      string[];
  origin:       "memory_knowledge";
  /** When the operator has already promoted this entry into a formal
   *  hypothesis, the formal id appears here so the operator can route the
   *  decision through the formal `canFeedExperiment` path instead. */
  promotedToHypothesisId?: string;
}

export interface HypothesisExperimentReadinessReport {
  /** Hypotheses accepted as Phase 2 experiment candidates. */
  candidates:      HypothesisExperimentCandidate[];
  /** Formal hypotheses refused with structured evidence. */
  refusals:        HypothesisExperimentRefusal[];
  /** Memory-origin entries that the selector explicitly refused. Always
   *  populated when memory entries are passed in, never when they are not. */
  memoryRefusals:  MemoryOriginRefusal[];
  /** Counts for quick dashboard / CLI rendering. */
  summary: {
    formalInputCount:   number;
    memoryInputCount:   number;
    candidateCount:     number;
    refusalCount:       number;
    memoryRefusalCount: number;
  };
  generatedAt: string;
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * Pure selector: partition a list of formal hypothesis records into
 * (candidates, refusals). The hygiene gate runs once per record; refusals
 * carry the full reason + blocker list so the caller can render them.
 *
 * Inputs:
 *   - `hypotheses`: the `research_lab.hypotheses[]` array (or any subset of
 *     it). Pass `[]` to get an empty report (not a failure).
 *
 * Pre-condition: callers must NEVER pass a `MemoryKnowledgeEntry` here.
 * The TypeScript type rejects it; the `origin` discriminant on the output
 * documents that the records came from the formal path.
 */
export function selectFormalHypothesisCandidates(
  hypotheses: HygieneAwareHypothesis[],
): { candidates: HypothesisExperimentCandidate[]; refusals: HypothesisExperimentRefusal[] } {
  const candidates: HypothesisExperimentCandidate[] = [];
  const refusals:   HypothesisExperimentRefusal[]   = [];

  for (const hyp of hypotheses) {
    const verdict = canFeedExperiment(hyp);
    if (verdict.ok) {
      candidates.push({
        hypothesisId:    hyp.id,
        claim:           hyp.claim,
        metric:          hyp.metric,
        measurementPath: hyp.measurementPath,
        tag:             verdict.tag,
        verdict,
        origin:          "research_lab.hypotheses",
      });
    } else {
      // Re-classify so the refusal reports the tag even on records the gate
      // refused for blocker reasons (the verdict's tag is already correct,
      // but we want to call out that the hygiene classifier and the gate
      // agreed — defense-in-depth against silent drift).
      const { tag } = classifyHypothesis(hyp);
      refusals.push({
        hypothesisId: hyp.id,
        claim:        hyp.claim,
        tag,
        reasons:      verdict.reasons,
        blockers:     verdict.blockers.length > 0 ? verdict.blockers : readinessBlockers(hyp),
        origin:       "research_lab.hypotheses",
      });
    }
  }

  return { candidates, refusals };
}

/**
 * Pure refusal builder for memory-origin entries. By Phase 1.5b policy, a raw
 * memory entry can NEVER feed a Phase 2 experiment — promotion to a formal
 * `research_lab.hypotheses[]` record is the only supported path. This
 * function exists so any caller that has a mixed list (e.g. an audit CLI
 * that surfaces both backlogs side-by-side) can produce the structured
 * refusal with the same evidence shape used for formal refusals.
 *
 * Returns refusals only — there is no "ok" branch by design.
 */
export function selectMemoryOriginRefusals(
  entries: MemoryKnowledgeEntry[],
): MemoryOriginRefusal[] {
  const out: MemoryOriginRefusal[] = [];
  for (const entry of entries) {
    if (!isMemoryHypothesisEntry(entry)) continue;
    const verdict = canMemoryEntryFeedExperiment(entry);
    out.push({
      refId:                  `memory:${entry.id}`,
      memoryEntryId:          entry.id,
      title:                  entry.title,
      reasons:                verdict.reasons,
      origin:                 "memory_knowledge",
      promotedToHypothesisId: entry.promotedToHypothesisId,
    });
  }
  return out;
}

// ── Top-level report ─────────────────────────────────────────────────────────

export interface BuildReportInput {
  /** Formal hypothesis backlog from `research_lab.hypotheses[]`. */
  formal?: HygieneAwareHypothesis[];
  /** Optional memory-origin entries (from `memory_knowledge.json#entries[]`)
   *  for explicit refusal reporting. Omit if the caller has no memory list. */
  memoryEntries?: MemoryKnowledgeEntry[];
  /** Override clock for deterministic tests. */
  now?: Date;
}

/**
 * Build the full Phase 2 readiness report. Empty inputs produce an empty
 * report (not a failure) so callers can wire this into a CLI or daily-cycle
 * hook safely.
 */
export function buildHypothesisExperimentReadinessReport(
  input: BuildReportInput = {},
): HypothesisExperimentReadinessReport {
  const formal = input.formal ?? [];
  const memoryEntries = input.memoryEntries ?? [];
  const now = input.now ?? new Date();

  const { candidates, refusals } = selectFormalHypothesisCandidates(formal);
  const memoryRefusals = selectMemoryOriginRefusals(memoryEntries);

  return {
    candidates,
    refusals,
    memoryRefusals,
    summary: {
      formalInputCount:   formal.length,
      memoryInputCount:   memoryEntries.length,
      candidateCount:     candidates.length,
      refusalCount:       refusals.length,
      memoryRefusalCount: memoryRefusals.length,
    },
    generatedAt: now.toISOString(),
  };
}

// ── Sugar for the common single-record check ─────────────────────────────────

/**
 * Convenience wrapper for callers that want to ask "can this *one* formal
 * hypothesis feed an experiment?" and get back a structured candidate or
 * refusal. Equivalent to passing a single-element array through
 * `selectFormalHypothesisCandidates` and unwrapping.
 *
 * This is the function a future Phase 2b experiment-registration helper
 * should call before invoking `registerExperiment`. It does NOT register
 * anything itself — propose-only.
 */
export function evaluateHypothesisForExperiment(
  hyp: HygieneAwareHypothesis,
): { ok: true; candidate: HypothesisExperimentCandidate }
 | { ok: false; refusal:  HypothesisExperimentRefusal } {
  const { candidates, refusals } = selectFormalHypothesisCandidates([hyp]);
  if (candidates.length === 1) {
    return { ok: true, candidate: candidates[0] };
  }
  return { ok: false, refusal: refusals[0] };
}
