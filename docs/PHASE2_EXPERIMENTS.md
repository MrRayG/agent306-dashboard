# Phase 2 — Evidence-Based Hypothesis Experiments

**Status:** Phase 2 entry slice + Phase 2b metric binding + Phase 2c decision rules merged. Promotion/retraction event persistence and live scheduler automation are deferred to **Phase 2d**.

Phase 2 turns the formal hypothesis backlog into a *selection* problem: given `research_lab.hypotheses[]`, which records are eligible to feed an experiment, and which are refused — with explicit, structured evidence — and why.

## Entry criteria

A hypothesis becomes a Phase 2 **experiment candidate** if and only if all of:

1. It is a formal `Hypothesis` record stored in `data/research_lab.json` under the `hypotheses[]` array (i.e. it lives in the `research_lab` repository, not in `memory_knowledge.json`).
2. `canFeedExperiment(hyp).ok === true`. This composes:
   - The hygiene tag is in `READY_TAGS = [ready_for_experiment, candidate]`.
   - All readiness fields are populated (`claim` ≥10 chars, `metric` ≥3 chars, `basis` non-empty, `prediction` ≥5 chars, `measurementPath` non-empty).
   - No archive / duplicate / blocked / `data-source-gate-blocked` signal is set.
3. (Phase 2b) The hypothesis names a metric and data source the experiment registry can bind. Today this is captured as free text on the hypothesis; Phase 2b will tighten it to a registered `metricKey` and a recognised data source.

If a record fails any of these, the selector emits a structured **refusal** with the precise reason and blocker list, so the operator can fix the underlying record (or leave it archived, intentionally).

## Research topics vs. formal hypotheses vs. memory hypotheses vs. experiments

These four shapes are NOT interchangeable. Phase 2 only operates on the third row.

| Shape                                       | Storage                                              | Can feed Phase 2?                              |
|---------------------------------------------|------------------------------------------------------|------------------------------------------------|
| **Research topic**                          | `research_lab.json#topics[]`                         | No — a topic is a question to investigate, not a hypothesis. Resolves into a topic record (`thesis` / `report` / `deep_read` / `hypothesis`). When `hypothesis`, a formal `Hypothesis` is written to `hypotheses[]`. |
| **Formal hypothesis (`Hypothesis`)**        | `research_lab.json#hypotheses[]`                     | **Yes**, via `canFeedExperiment` — the only supported path. |
| **Memory-origin hypothesis entry**          | `memory_knowledge.json#entries[]` with `title` starting `Hypothesis:` | **No.** Hard-no by `canMemoryEntryFeedExperiment`. The only route to Phase 2 is for the operator to *promote* the entry into a formal `Hypothesis` record (with hygiene metadata + readiness fields), then the standard `canFeedExperiment` gate decides. |
| **Experiment**                              | `experiments` table (sqlite)                         | A successful Phase 2 candidate may *eventually* be registered as an experiment via `registerExperiment`. Phase 2 itself does not write to this table — that wiring lands in Phase 2b. |

## Selector module

`server/experiments/hypothesisExperimentSelector.ts` is pure (no I/O, no DB writes, no LLM calls). Inputs are arrays of records the caller has already loaded; outputs are typed reports.

```ts
import {
  buildHypothesisExperimentReadinessReport,
  selectFormalHypothesisCandidates,
  selectMemoryOriginRefusals,
  evaluateHypothesisForExperiment,
} from "./experiments/hypothesisExperimentSelector.js";

// Full report, including hard-no for memory-origin entries:
const report = buildHypothesisExperimentReadinessReport({
  formal:        researchLab.hypotheses,         // HygieneAwareHypothesis[]
  memoryEntries: memoryKnowledge.entries ?? [],  // MemoryKnowledgeEntry[] (optional)
});

// One-record sugar for a future registration helper:
const decision = evaluateHypothesisForExperiment(hyp);
if (decision.ok) {
  // decision.candidate.hypothesisId, .metric, .measurementPath, .verdict
} else {
  // decision.refusal.reasons, .blockers, .tag
}
```

### Output shapes

- `HypothesisExperimentCandidate` — `{ hypothesisId, claim, metric, measurementPath?, tag, verdict, origin: "research_lab.hypotheses" }`
- `HypothesisExperimentRefusal` — `{ hypothesisId, claim?, tag, reasons[], blockers[], origin: "research_lab.hypotheses" }`
- `MemoryOriginRefusal` — `{ refId: "memory:<id>", memoryEntryId, title, reasons[], origin: "memory_knowledge", promotedToHypothesisId? }`
- `HypothesisExperimentReadinessReport` — `{ candidates[], refusals[], memoryRefusals[], summary, generatedAt }`

The `origin` discriminant on every output prevents a memory-origin record from ever being mistaken for a formal candidate. The `MemoryOriginRefusal` type has no `ok: true` representation by construction.

### Refusal evidence

Every refusal carries:

- `tag` — the hygiene classification (e.g. `needs_data`, `archived_stale`, `duplicate`).
- `reasons` — narrative chain, including the verdict from `classifyHypothesis` and the gate failure (`tag '<tag>' is not in READY_TAGS`, or `tag is ready but readiness fields are incomplete`).
- `blockers` — the explicit field-level list from `readinessBlockers` (e.g. `metric is missing — Phase 2 needs a measurable indicator`).

This is the audit trail the operator (or a future review UI) consumes to decide whether to fix the hypothesis, archive it, or leave it queued.

## Hard-no for memory-origin hypotheses

`selectMemoryOriginRefusals` exists so any caller that has a mixed list (audit CLIs, dashboards) can produce structured evidence that a memory entry will not be promoted automatically. There is **no bypass**:

- `canMemoryEntryFeedExperiment` has no `ok: true` branch (Phase 1.5b).
- The selector accepts `MemoryKnowledgeEntry` only as input to `selectMemoryOriginRefusals`, never to `selectFormalHypothesisCandidates`.
- Even when a memory entry is `promotedToHypothesisId`, the refusal still references the *formal* record that came out of the promotion. The formal record is what Phase 2 evaluates.

Promotion path: `memory_knowledge.json#entries[]` → operator review → write a new `research_lab.hypotheses[]` record with `claim` / `basis` / `metric` / `prediction` / `measurementPath` filled out → `canFeedExperiment` decides.

## What is in scope for Phase 2

- The selector module (above).
- Refusal evidence shape on every non-ready record.
- Integration tests against the full set of Phase 1.5 hygiene cases (ready, candidate, missing-metric, missing-data-source, archived, duplicate, needs_review, memory-origin).
- Documentation of the four shapes and the supported promotion path.

## Phase 2b — Metric binding (merged)

Phase 2b answers exactly one new question for each Phase 2 candidate:

> "Can the candidate's metric be bound to a registered experiment metric key with a known data source — and if not, why not?"

### Entry criteria

A candidate is **bindable** if and only if all of:

1. The input is a `HypothesisExperimentCandidate` produced by `selectFormalHypothesisCandidates` (`origin === "research_lab.hypotheses"`). Memory-origin records cannot reach this layer — Phase 1.5b's hard-no makes them `MemoryOriginRefusal[]`, not candidates.
2. The candidate's `metric` matches a registered `metricKey` in `PHASE2B_METRIC_REGISTRY` (case-insensitive, normalized whitespace). Aliases for spellings observed on the active backlog are explicit in the registry entry.
3. The candidate's `measurementPath` substring-matches at least one of the registry entry's `dataSources[]`.

If a candidate fails any of these, `bindCandidateMetric` emits a structured `MetricBindingRefusal` with a stable `code`, a one-sentence `reason`, and an `evidence[]` audit trail.

### Refusal codes

| Code                       | Meaning                                                                                                          |
|----------------------------|------------------------------------------------------------------------------------------------------------------|
| `unknown_metric`           | The free-text metric on the hypothesis matches no registered key or alias.                                        |
| `ambiguous_metric`         | The free-text metric matches more than one registry entry — binding requires exactly one.                         |
| `missing_data_source`      | The metric matched a registry entry, but the candidate has no `measurementPath`.                                  |
| `unsupported_data_source`  | The metric matched, the candidate has a `measurementPath`, but it does not name any of the registered data sources. |
| `not_yet_bindable`         | The metric is registered but its `notYetBindable` flag is set — the runtime harness is not wired up yet.          |

### Binding module

`server/experiments/hypothesisMetricBinding.ts` is pure (no I/O, no DB writes, no LLM calls). Inputs are Phase 2 candidates (or a full readiness report); outputs are typed `MetricBinding | MetricBindingRefusal` records.

```ts
import {
  bindCandidateMetric,
  bindReadinessReport,
  bindCandidates,
  listRegisteredMetrics,
} from "./experiments/hypothesisMetricBinding.js";

// One-record sugar (the common path for a future Phase 2c registration helper):
const result = bindCandidateMetric(candidate);
if (result.ok) {
  // result.metricKey is the canonical key registerExperiment should write
  // result.matchedDataSources, result.evidence are the audit trail
} else {
  // result.code, result.reason, result.evidence
}

// Bulk: bind every candidate from a Phase 2 readiness report.
const report = bindReadinessReport(selectorReport);
// report.summary.refusalsByCode breaks refusals out by code for dashboards.
```

### Phase 2b registry seed

The registry is a hand-curated constant in `hypothesisMetricBinding.ts`. Today it contains the single metric in active use:

| `metricKey`                     | Description                                                                                                              | Data sources (substring matches)                                  |
|---------------------------------|--------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| `routine_task_json_validity`    | Per-trial JSON validity outcome metric written by `recordTrialOutcome` (1.0 = parsed, 0.0 = parse failed). Aggregated by `validityAggregates.getValiditySummary`. | `experiment_trials`, `experiment_trials.outcome_metric`, `experiments table` |

Adding a new metric is a one-file change: append a `RegisteredMetric` to `PHASE2B_METRIC_REGISTRY`. Phase 2c may replace the seed with a database-backed lookup, but the explicit seed is the canonical source of truth for Phase 2b.

### Phase 2b invariants

- **Propose-only**: nothing in this module writes to the database, the JSON files, or the experiment registry. Output is `MetricBinding | MetricBindingRefusal` records; an operator (or a future Phase 2c helper) decides what to do.
- **Composes with the Phase 2 selector**: the function signature accepts only `HypothesisExperimentCandidate` records — the type system (plus the absence of any `ok: true` branch on `canMemoryEntryFeedExperiment`) ensures memory-origin entries cannot reach metric binding.
- **No mutation of the hypothesis record**: the candidate's free-text `metric` and `measurementPath` are echoed verbatim in the binding evidence; nothing is rewritten.

## Phase 2c — Experiment decision rules (merged)

Phase 2c answers exactly one question on top of a Phase 2b binding plus an aggregate outcome:

> "Given the evidence so far, should this experiment be promoted, rejected, continued, or sent to a human reviewer?"

The output is `ExperimentDecision`. The module is pure, deterministic, and propose-only — it never writes `promotion_events`, never calls `registerExperiment`, never mutates a hypothesis record. An operator (or a future Phase 2d helper) decides what to do with the verdict.

### Verdicts

| Verdict          | When                                                                                          |
|------------------|-----------------------------------------------------------------------------------------------|
| `promote`        | Treatment beats baseline by ≥ `promoteAbsoluteDelta`, sample threshold met, no guardrail failure, no cost regression. |
| `reject`         | Hard guardrail failure, OR treatment underperforms by ≥ `rejectAbsoluteDelta`, OR cost rose above the flat-cost ratio with no metric improvement. |
| `continue`       | Sample below threshold, OR sample met but delta inside the inconclusive band.                  |
| `needs_review`   | Missing or invalid aggregate fields, OR an advisory (non-fatal) guardrail failed. The safe-default verdict for ambiguous evidence. |

### Reason codes

Stable enum surfaced on every decision so callers can branch without parsing prose:

| `reasonCode`                  | Verdict        |
|-------------------------------|----------------|
| `missing_aggregate`           | `needs_review` |
| `invalid_aggregate`           | `needs_review` |
| `ambiguous_guardrail`         | `needs_review` |
| `insufficient_sample`         | `continue`     |
| `inconclusive`                | `continue`     |
| `guardrail_failure`           | `reject`       |
| `primary_metric_worse`        | `reject`       |
| `cost_up_without_improvement` | `reject`       |
| `primary_metric_better`       | `promote`      |

### Evaluation order

The rules are evaluated in this order; the first match wins. This ordering is part of the contract — moving a rule changes the verdict on edge cases.

1. Missing aggregate (`baseline` or `treatment` undefined) → `needs_review` / `missing_aggregate`.
2. Invalid aggregate (NaN, negative count, non-integer count) → `needs_review` / `invalid_aggregate`.
3. Failed guardrail — `fatal !== false` ⇒ `reject` / `guardrail_failure`; `fatal === false` ⇒ `needs_review` / `ambiguous_guardrail`.
4. Sample below `minTotalSamples` OR either arm below `minPerArmSamples` → `continue` / `insufficient_sample`.
5. Cost ratio above `maxFlatCostRatio` with metric delta below `minMetricImprovementForCost` → `reject` / `cost_up_without_improvement`.
6. `treatment.metric − baseline.metric ≤ −rejectAbsoluteDelta` → `reject` / `primary_metric_worse`.
7. `treatment.metric − baseline.metric ≥ +promoteAbsoluteDelta` → `promote` / `primary_metric_better`.
8. Otherwise → `continue` / `inconclusive`.

### Defaults

```ts
{
  minTotalSamples:             30,
  minPerArmSamples:            15,
  promoteAbsoluteDelta:        0.05,
  rejectAbsoluteDelta:         0.05,
  minMetricImprovementForCost: 0.005,
  maxFlatCostRatio:            0.10,
}
```

Defaults are deliberately conservative — Phase 2c is a threshold layer, not a sequential statistical test. We want the module to recommend `continue` or `needs_review` more often than `promote` or `reject` until Phase 2d adds rigor. Callers can override any subset; the active values are echoed on every decision in `thresholdsUsed`.

### Decision module

`server/experiments/hypothesisExperimentDecision.ts` is pure (no I/O, no DB writes, no LLM calls, no clock). The `now` argument is injectable so tests are deterministic.

```ts
import {
  decideExperimentOutcome,
  decideExperimentOutcomes,
  getDefaultDecisionThresholds,
  type ExperimentDecisionInput,
} from "./experiments/hypothesisExperimentDecision.js";

const decision = decideExperimentOutcome({
  binding,                                    // MetricBinding from Phase 2b
  baseline:  { count: 20, metric: 0.91 },
  treatment: { count: 20, metric: 0.96 },
  baselineCost:  { costUsd: 0.10 },
  treatmentCost: { costUsd: 0.12 },
  guardrails: [
    { name: "judge_outage_rate", passed: true },
    { name: "p99_latency_ms",    passed: true, fatal: true },
  ],
});
// decision.verdict, .reasonCode, .reason, .evidence, .thresholdsUsed
```

### Evidence shape

Every decision carries:

- `verdict` — one of the four verdicts.
- `reasonCode` — the stable enum value.
- `reason` — a one-sentence narrative for the audit panel.
- `evidence[]` — concrete observations (per-arm counts, metric delta, active thresholds, failing guardrail detail). The list is ordered roughly by relevance and is stable input-by-input so an operator can diff two decisions.
- `thresholdsUsed` — the merged threshold record, with defaults filled in.
- `decidedAt` — ISO timestamp from injected `now`.
- `candidate` — `{ hypothesisId, origin, tag }` echo so a single decision record is self-describing in logs without a join.

### Phase 2c invariants

- **Propose-only**: nothing in this module writes to the database, the JSON files, the experiment registry, or `promotion_events` / `retraction_events`. The output is a verdict; an operator decides what to do.
- **Composes with Phase 2 / 2b**: the decision input is a successful `MetricBinding` (TypeScript narrows `MetricBinding | MetricBindingRefusal` on `ok: true`) — a refusal cannot reach the decision module. Memory-origin records cannot become a binding by Phase 1.5b's hard-no, so they cannot become a decision either. There is no bypass.
- **Deterministic**: every rule is a finite-arithmetic threshold comparison on the inputs. No randomness, no statistical sampling, no clock reads (the `now` argument is injectable). The same input always produces the same verdict.
- **No invented data**: when an aggregate is missing or invalid, the module returns `needs_review` rather than substituting a default. When cost data is incomplete or invalid on either arm, the cost rule is skipped silently rather than guessed.
- **Conservative by default**: thresholds are tuned so ambiguous cases recommend `continue` or `needs_review`. Phase 2d may tune them tighter once enough trials exist to calibrate.

## What is deferred to Phase 2d

- Persisting `promotion_events` / `retraction_events` on the hypothesis record (and the schema migrations that come with it).
- A live scheduler / daily-cycle helper that consumes `ExperimentDecision` and calls a registration / promotion helper — today the decision is purely advisory.
- A statistical sequential test (SPRT, Bayesian posterior, CUPED-style variance reduction) that replaces the threshold layer once we have enough trials to calibrate one.
- Dashboard surfaces over the decision report.
- Growing the metric registry from a database / config file / LLM proposal — and the migration logic that comes with it.

The selector + binding + decision modules are intentionally *propose-only*. Phase 2d will wire them into the daily-cycle / scheduler boot path, but only behind a feature flag and only with `promotion_events` / `retraction_events` persistence in place.

## Invariants Phase 2 preserves

- **Propose-only**: nothing in this module writes to the database, the JSON files, or the experiment registry. The output is candidates and refusals; an operator (or a future Phase 2b helper) decides what to do.
- **Single readiness gate**: `canFeedExperiment` from `server/hypothesisHygiene.ts` is the only function that says "yes, a formal hypothesis may proceed". The selector composes it; it does not re-implement it.
- **Memory-origin records are never candidates**: the type system, the function partitioning, and the absence of any `ok: true` branch on `canMemoryEntryFeedExperiment` all enforce this.
- **History is preserved**: no records are mutated. The selector is a pure read.
