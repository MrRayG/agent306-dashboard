# Phase 2 — Evidence-Based Hypothesis Experiments

**Status:** Phase 2 entry slice + Phase 2b metric binding merged. Statistical decision rules, promotion/retraction events, and live scheduler automation are deferred to **Phase 2c**.

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

## What is deferred to Phase 2c

- Statistical decision rules (Bayes / SPRT / CUPED-style).
- Promotion / retraction events and their persistence on the hypothesis record.
- Live scheduler automation that calls `registerExperiment` from a bound candidate (today the binding output is *advisory* — a Phase 2c registration helper will read `MetricBinding.metricKey` and decide whether to register).
- Dashboard surfaces over the binding report.
- Growing the registry from a database, config file, or LLM proposal — and the migration logic that comes with it.

The selector + binding modules are intentionally *propose-only*. Phase 2c will wire them into the daily-cycle / scheduler boot path, but only behind a feature flag and only after the statistical decision work is done.

## Invariants Phase 2 preserves

- **Propose-only**: nothing in this module writes to the database, the JSON files, or the experiment registry. The output is candidates and refusals; an operator (or a future Phase 2b helper) decides what to do.
- **Single readiness gate**: `canFeedExperiment` from `server/hypothesisHygiene.ts` is the only function that says "yes, a formal hypothesis may proceed". The selector composes it; it does not re-implement it.
- **Memory-origin records are never candidates**: the type system, the function partitioning, and the absence of any `ok: true` branch on `canMemoryEntryFeedExperiment` all enforce this.
- **History is preserved**: no records are mutated. The selector is a pure read.
