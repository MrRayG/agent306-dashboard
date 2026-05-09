/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PHASE 2b: HYPOTHESIS METRIC BINDING
 *
 * Phase 2 produced `HypothesisExperimentCandidate`: a formal hypothesis the
 * hygiene gate has cleared as eligible to feed an experiment. The candidate's
 * `metric` and `measurementPath` are still **free text** on the hypothesis
 * record — Phase 2 deliberately did not enforce that they map to anything the
 * runtime experiment harness (`registerExperiment` / `runExperiment` /
 * `recordTrialOutcome`) can actually grade.
 *
 * Phase 2b closes that gap, narrowly. Given a Phase 2 candidate, this module
 * answers exactly one question:
 *
 *     "Can the candidate's metric be bound to a registered experiment metric
 *      key with a known data source — and if not, why not?"
 *
 * The output is `MetricBinding` (success) or `MetricBindingRefusal` (failure).
 * Both shapes carry explicit decision evidence so an operator (or a future
 * Phase 2c registration helper) can audit the call without re-running it.
 *
 * This module is intentionally:
 *   - PURE: no I/O, no DB writes, no LLM calls. Inputs are candidate records;
 *     outputs are typed verdicts. The registry below is a hand-curated
 *     constant — Phase 2c may grow it into a database or feature-flagged
 *     lookup, but Phase 2b ships an explicit seed.
 *   - PROPOSE-ONLY: nothing here calls `registerExperiment`. The output is
 *     evidence; an operator decides what to do with it. This mirrors the
 *     Phase 2 selector, the Phase 1.5 hygiene gate, and the propose-only
 *     invariant in `selfRecommendationEngine.ts`.
 *   - DEFENSE-IN-DEPTH: the function signature accepts only a
 *     `HypothesisExperimentCandidate`, which by construction came out of the
 *     Phase 2 selector — i.e. the formal hygiene gate has already cleared it.
 *     Memory-origin entries cannot reach this function: they are typed as
 *     `MemoryOriginRefusal`, not `HypothesisExperimentCandidate`, and the
 *     selector has no `ok: true` branch for them. There is no bypass path.
 *
 * Phase 2b entry criteria (codified):
 *   1. Input is a `HypothesisExperimentCandidate` produced by the Phase 2
 *      selector (`origin === "research_lab.hypotheses"`).
 *   2. Candidate's `metric` matches a registered `metricKey` in
 *      `PHASE2B_METRIC_REGISTRY` (case-insensitive, normalized whitespace,
 *      with a small alias table for the metrics in active use today).
 *   3. Candidate's `measurementPath` matches at least one of the registry
 *      entry's `dataSources[]` patterns.
 *
 * Out of scope for Phase 2b (deferred to Phase 2c):
 *   - Statistical decision rules (Bayes / SPRT / CUPED).
 *   - Promotion / retraction events and their persistence.
 *   - Live scheduler automation that calls `registerExperiment` from a
 *     bound candidate.
 *   - Dashboard surfaces.
 *   - Growing the registry from a database, config file, or LLM proposal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  HypothesisExperimentCandidate,
  HypothesisExperimentReadinessReport,
} from "./hypothesisExperimentSelector.js";

// ── Refusal codes ────────────────────────────────────────────────────────────
//
// Codes are an enum-like union so callers can branch on a stable identifier
// rather than parsing free-text. Every refusal carries both the code and a
// human-readable `reason` so the structured shape and the audit trail stay
// coherent.

export type MetricBindingRefusalCode =
  | "unknown_metric"
  | "ambiguous_metric"
  | "missing_data_source"
  | "unsupported_data_source"
  | "not_yet_bindable";

// ── Registry shape ───────────────────────────────────────────────────────────

/**
 * One registered metric key. The shape is intentionally narrow — Phase 2b
 * needs to answer "does this name a known metric, and is the data source one
 * we can actually read?" Nothing more.
 *
 * Field semantics:
 *   - `metricKey`: the canonical identifier the runtime harness uses (see
 *     `experiments.metricKey` in `shared/schema.ts` and the Phase 1
 *     experiment definition in `server/experiments/phase1Experiment.ts`).
 *   - `aliases[]`: free-text spellings observed on the hypothesis backlog
 *     that should bind to this metric. Compared after `normalize()`.
 *   - `dataSources[]`: substrings (lower-cased) that, when found inside the
 *     candidate's `measurementPath`, are sufficient to bind. We intentionally
 *     use substring match rather than full equality so an operator's
 *     measurement path like "experiment_trials.outcome_metric (graded by
 *     safeParseLLMJson)" can still bind to the `experiment_trials` source.
 *   - `description`: short human-readable description, surfaced in evidence
 *     so an audit reader can see *what* metric was bound without cross-
 *     referencing the registry.
 *   - `notYetBindable`: if true, the metric is registered but not wired into
 *     the runtime harness yet. Binding refuses with `not_yet_bindable` so
 *     Phase 2c can flip the flag without changing call sites.
 */
export interface RegisteredMetric {
  metricKey:        string;
  aliases:          readonly string[];
  dataSources:      readonly string[];
  description:      string;
  notYetBindable?:  boolean;
}

/**
 * Phase 2b registry seed. Hand-curated from the metrics in active use today.
 *
 * NOTE — keep entries in sync with:
 *   - `server/experiments/phase1Experiment.ts` (`metricKey`)
 *   - `server/experiments/validityAggregates.ts` (json_validity semantics)
 *   - `shared/schema.ts` (`experiments.metricKey`, `experimentTrials.outcomeMetric`)
 *
 * Phase 2c may replace this with a generated or database-backed lookup, but
 * the explicit seed is the canonical source of truth for Phase 2b. Adding a
 * new metric here is the single change required to make a new hypothesis
 * bindable; nothing else in the codebase needs to know.
 */
export const PHASE2B_METRIC_REGISTRY: readonly RegisteredMetric[] = [
  {
    metricKey:   "routine_task_json_validity",
    aliases: [
      "routine_task_json_validity",
      "json validity",
      "json_validity",
      "humaneval pass@1",            // shape-equivalent: 1.0 / 0.0 outcome metric
      "json parse rate",
      "json parse validity",
    ],
    dataSources: [
      "experiment_trials",
      "experiment_trials.outcome_metric",
      "experiments table",
    ],
    description:
      "Per-trial JSON validity outcome metric written by recordTrialOutcome (1.0 = parsed, 0.0 = parse failed). Aggregated by validityAggregates.getValiditySummary.",
  },
] as const;

// ── Normalization helpers ────────────────────────────────────────────────────

function normalize(s: string | undefined | null): string {
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns every registered metric whose `metricKey` or any alias normalizes
 * to the candidate's metric. Used to detect both "unknown" and "ambiguous"
 * cases. The result preserves registry order so callers see a stable list
 * in evidence.
 */
function findRegistryMatches(metric: string): RegisteredMetric[] {
  const target = normalize(metric);
  if (!target) return [];
  const out: RegisteredMetric[] = [];
  for (const entry of PHASE2B_METRIC_REGISTRY) {
    const candidates = [entry.metricKey, ...entry.aliases].map(normalize);
    if (candidates.includes(target)) out.push(entry);
  }
  return out;
}

/**
 * Returns the registry-side data sources that the candidate's
 * `measurementPath` substring-matches (lower-cased). Empty when the
 * measurementPath does not name any of the registry's data sources.
 */
function matchedDataSources(
  measurementPath: string | undefined,
  entry: RegisteredMetric,
): string[] {
  const path = normalize(measurementPath);
  if (!path) return [];
  return entry.dataSources.filter(src => path.includes(normalize(src)));
}

// ── Binding shapes ───────────────────────────────────────────────────────────

/**
 * Successful binding. Every field exists so a downstream
 * `registerExperiment` helper has the exact `metricKey` to write, and an
 * audit reader can reconstruct the decision.
 */
export interface MetricBinding {
  ok: true;
  hypothesisId:    string;
  /** The canonical key the runtime harness uses. Distinct from the
   *  candidate's free-text `metric`. */
  metricKey:       string;
  /** Echoed from the registry so callers can render "what is this metric?"
   *  without a second lookup. */
  metricDescription: string;
  /** The candidate's free-text metric, normalized. Useful in evidence so
   *  the audit reader can see what was matched. */
  matchedMetricText: string;
  /** Subset of the registry entry's `dataSources` that the candidate's
   *  `measurementPath` substring-matched. Always non-empty on success. */
  matchedDataSources: string[];
  /** Echo of the candidate id and origin so a single binding record is
   *  self-describing in logs. */
  candidate: {
    hypothesisId: string;
    origin: HypothesisExperimentCandidate["origin"];
    tag:    HypothesisExperimentCandidate["tag"];
  };
  /** Narrative evidence — "metric '<x>' bound to registered key '<y>' via
   *  alias '<z>'; data source '<src>' present in measurement path." */
  evidence: string[];
}

/**
 * Refusal. `code` is the stable enum; `reason` is a one-sentence narrative;
 * `evidence[]` lists every concrete observation that contributed to the
 * refusal (e.g. "no registered metric matched 'foo'", "registered metric
 * 'routine_task_json_validity' has dataSources [...] but candidate path
 * '...' substring-matches none").
 */
export interface MetricBindingRefusal {
  ok: false;
  hypothesisId:    string;
  code:            MetricBindingRefusalCode;
  reason:          string;
  /** Free-text metric exactly as it appears on the candidate. */
  rawMetric:       string;
  /** Free-text measurement path exactly as it appears on the candidate. */
  rawMeasurementPath?: string;
  /** Registry entries that *did* match the metric, when there were any.
   *  Always populated for `ambiguous_metric` (length ≥ 2) and
   *  `unsupported_data_source` / `not_yet_bindable` (length === 1). */
  matchedRegistryEntries: Array<{ metricKey: string; description: string }>;
  evidence:        string[];
  /** Echo of the candidate id and origin so a refusal record is self-
   *  describing in logs. */
  candidate: {
    hypothesisId: string;
    origin: HypothesisExperimentCandidate["origin"];
    tag:    HypothesisExperimentCandidate["tag"];
  };
}

// ── Binding ──────────────────────────────────────────────────────────────────

/**
 * Bind a single Phase 2 candidate to a registered experiment metric, or
 * refuse with structured evidence.
 *
 * Pre-condition: callers MUST pass a `HypothesisExperimentCandidate`
 * produced by the Phase 2 selector. The TypeScript type on the parameter
 * enforces this; do not coerce a refusal or a memory-origin record into
 * this shape. The selector partitions inputs so memory-origin records never
 * reach this function — they appear in `memoryRefusals` instead.
 */
export function bindCandidateMetric(
  candidate: HypothesisExperimentCandidate,
): MetricBinding | MetricBindingRefusal {
  const rawMetric = candidate.metric ?? "";
  const rawMeasurementPath = candidate.measurementPath;
  const candidateEcho = {
    hypothesisId: candidate.hypothesisId,
    origin:       candidate.origin,
    tag:          candidate.tag,
  };
  const refusalBase = {
    ok:                     false as const,
    hypothesisId:           candidate.hypothesisId,
    rawMetric,
    rawMeasurementPath,
    candidate:              candidateEcho,
  };

  const matches = findRegistryMatches(rawMetric);

  if (matches.length === 0) {
    return {
      ...refusalBase,
      code:                   "unknown_metric",
      reason:
        `metric '${rawMetric}' does not match any registered Phase 2b metric key or alias`,
      matchedRegistryEntries: [],
      evidence: [
        `normalized metric: '${normalize(rawMetric)}'`,
        `registry size: ${PHASE2B_METRIC_REGISTRY.length}`,
        `registered keys: ${PHASE2B_METRIC_REGISTRY.map(e => e.metricKey).join(", ")}`,
      ],
    };
  }

  if (matches.length > 1) {
    return {
      ...refusalBase,
      code:   "ambiguous_metric",
      reason:
        `metric '${rawMetric}' matched ${matches.length} registry entries; binding requires exactly one`,
      matchedRegistryEntries: matches.map(m => ({
        metricKey:   m.metricKey,
        description: m.description,
      })),
      evidence: [
        `normalized metric: '${normalize(rawMetric)}'`,
        `ambiguous matches: ${matches.map(m => m.metricKey).join(", ")}`,
      ],
    };
  }

  const entry = matches[0];

  if (entry.notYetBindable) {
    return {
      ...refusalBase,
      code:    "not_yet_bindable",
      reason:
        `metric '${rawMetric}' maps to registered key '${entry.metricKey}' but the runtime harness is not wired up yet (Phase 2c)`,
      matchedRegistryEntries: [{
        metricKey:   entry.metricKey,
        description: entry.description,
      }],
      evidence: [
        `matched registry entry: ${entry.metricKey}`,
        `flag: notYetBindable=true`,
      ],
    };
  }

  if (!rawMeasurementPath || normalize(rawMeasurementPath) === "") {
    return {
      ...refusalBase,
      code:    "missing_data_source",
      reason:
        `candidate has no measurementPath; registered metric '${entry.metricKey}' requires one of [${entry.dataSources.join(", ")}]`,
      matchedRegistryEntries: [{
        metricKey:   entry.metricKey,
        description: entry.description,
      }],
      evidence: [
        `matched registry entry: ${entry.metricKey}`,
        `expected data sources: ${entry.dataSources.join(", ")}`,
        `candidate measurementPath: <empty>`,
      ],
    };
  }

  const matchedSources = matchedDataSources(rawMeasurementPath, entry);
  if (matchedSources.length === 0) {
    return {
      ...refusalBase,
      code:    "unsupported_data_source",
      reason:
        `candidate measurementPath '${rawMeasurementPath}' does not name any data source supported by registered metric '${entry.metricKey}'`,
      matchedRegistryEntries: [{
        metricKey:   entry.metricKey,
        description: entry.description,
      }],
      evidence: [
        `matched registry entry: ${entry.metricKey}`,
        `expected data sources: ${entry.dataSources.join(", ")}`,
        `candidate measurementPath: '${rawMeasurementPath}'`,
      ],
    };
  }

  return {
    ok:                true,
    hypothesisId:      candidate.hypothesisId,
    metricKey:         entry.metricKey,
    metricDescription: entry.description,
    matchedMetricText: normalize(rawMetric),
    matchedDataSources: matchedSources,
    candidate:         candidateEcho,
    evidence: [
      `metric '${rawMetric}' bound to registered key '${entry.metricKey}'`,
      `data source(s) matched: ${matchedSources.join(", ")}`,
      `candidate origin: ${candidate.origin}`,
      `candidate hygiene tag: ${candidate.tag}`,
    ],
  };
}

// ── Top-level report ─────────────────────────────────────────────────────────

export interface MetricBindingReport {
  bindings:     MetricBinding[];
  refusals:     MetricBindingRefusal[];
  summary: {
    candidateCount: number;
    boundCount:     number;
    refusalCount:   number;
    /** Refusal counts keyed by code, for quick CLI / dashboard rendering. */
    refusalsByCode: Record<MetricBindingRefusalCode, number>;
  };
  generatedAt: string;
}

const ZERO_REFUSAL_COUNTS: Record<MetricBindingRefusalCode, number> = {
  unknown_metric:           0,
  ambiguous_metric:         0,
  missing_data_source:      0,
  unsupported_data_source:  0,
  not_yet_bindable:         0,
};

/**
 * Bind every candidate in a Phase 2 readiness report. Memory-origin refusals
 * from the input report are NOT considered — they cannot become candidates
 * by construction (Phase 1.5b). Empty input produces an empty report (not a
 * failure).
 */
export function bindReadinessReport(
  report: HypothesisExperimentReadinessReport,
  now: Date = new Date(),
): MetricBindingReport {
  return bindCandidates(report.candidates, now);
}

/**
 * Bind a list of Phase 2 candidates directly. Useful when the caller has
 * already partitioned the readiness report or has constructed a candidate
 * list from another path.
 */
export function bindCandidates(
  candidates: HypothesisExperimentCandidate[],
  now: Date = new Date(),
): MetricBindingReport {
  const bindings: MetricBinding[] = [];
  const refusals: MetricBindingRefusal[] = [];
  const refusalsByCode: Record<MetricBindingRefusalCode, number> = { ...ZERO_REFUSAL_COUNTS };

  for (const candidate of candidates) {
    const result = bindCandidateMetric(candidate);
    if (result.ok) {
      bindings.push(result);
    } else {
      refusals.push(result);
      refusalsByCode[result.code] += 1;
    }
  }

  return {
    bindings,
    refusals,
    summary: {
      candidateCount: candidates.length,
      boundCount:     bindings.length,
      refusalCount:   refusals.length,
      refusalsByCode,
    },
    generatedAt: now.toISOString(),
  };
}

// ── Public registry view ─────────────────────────────────────────────────────

/**
 * Read-only view of the registered metrics. Useful for dashboards or audit
 * CLIs that want to render "what metrics can Phase 2b bind today?" without
 * importing the constant directly.
 */
export function listRegisteredMetrics(): Array<{
  metricKey:   string;
  description: string;
  aliases:     readonly string[];
  dataSources: readonly string[];
  notYetBindable: boolean;
}> {
  return PHASE2B_METRIC_REGISTRY.map(e => ({
    metricKey:      e.metricKey,
    description:    e.description,
    aliases:        e.aliases,
    dataSources:    e.dataSources,
    notYetBindable: e.notYetBindable === true,
  }));
}
