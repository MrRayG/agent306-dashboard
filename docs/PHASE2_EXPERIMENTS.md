# Phase 2 — Evidence-Based Hypothesis Experiments

**Status:** Phase 2 entry slice + Phase 2b metric binding + Phase 2c decision rules + Phase 2d decision evidence persistence + Phase 2e sandboxed execution wiring (plan-only) + Phase 2e-b low-risk sandbox registration registry + Phase 2e-c persistent sandbox registration records merged. Live sandbox application (running fixtures, grading, auto-apply) remains deferred to **Phase 2e-d**; meta-reflection / lessons database is deferred to **Phase 2f**.

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

## Phase 2d — Decision Evidence Persistence

Phase 2c emits a verdict but writes nothing. Phase 2d closes the next narrow gap: persisting that verdict and its evidence as an append-only audit trail an operator (or a future review surface) can read back later — without recomputing it.

### Module

`server/experiments/hypothesisDecisionEvents.ts`. Append-only JSONL ledger at `data/experiment_decision_events.jsonl`, routed through `dataPath()` so `DATA_DIR` overrides isolate the ledger in tests.

```ts
import {
  appendDecisionEvent,
  readDecisionEvents,
  readDecisionEventsTail,
  readDecisionEventsForHypothesis,
} from "./experiments/hypothesisDecisionEvents.js";

const decision = decideExperimentOutcome({ binding, baseline, treatment });
const result = appendDecisionEvent({
  decision,
  source:        "phase2c-cron",       // free-text actor / pipeline label
  ruleVersion:   "phase2c.v1",         // stable label for the rule revision
  experimentId:  "exp_42",             // optional
  candidateId:   "cand_7",             // optional
  binding: {                            // optional binding summary
    hypothesisId:       binding.hypothesisId,
    metricKey:          binding.metricKey,
    matchedDataSources: binding.matchedDataSources,
  },
});
if (!result.ok) console.warn("event refused:", result.reason);
```

### Event shape

`HypothesisDecisionEvent` carries everything an audit reader needs without a join:

- `eventId` — `evt_<unix-ms>_<6-char-base36>`. Sortable by time; unique per process.
- `recordedAt` — ISO timestamp the event was appended.
- `decidedAt` — ISO timestamp from the Phase 2c input (when the rule fired).
- `hypothesisId`, `metricKey` — echoed from the decision.
- `experimentId?`, `candidateId?` — operator-supplied handles when available.
- `decision` — `promote | reject | continue | needs_review`.
- `reasonCode` — the stable Phase 2c enum value.
- `reason` — one-sentence narrative copied from the decision.
- `evidence[]` — the same observation list the decision produced (defensively copied so a later mutation cannot alter the persisted record).
- `ruleVersion` — caller-supplied label for the rule revision.
- `source` — caller-supplied pipeline / actor label.
- `binding?` — optional `{ hypothesisId, metricKey, matchedDataSources }` summary.
- `thresholdsUsed` — the merged threshold record from the decision.

### Validation

`appendDecisionEvent` refuses to persist a record that does not look like a Phase 2c decision:

- `decision` must be present, with non-empty `hypothesisId`, `metricKey`, and `decidedAt`.
- `decision.verdict` must be one of `promote | reject | continue | needs_review`.
- `decision.reasonCode` must be one of the nine Phase 2c reason codes.
- `decision.evidence` must be an array; `decision.thresholdsUsed` must be present.
- `source` and `ruleVersion` are required (non-empty strings).

A refusal returns `{ ok: false, reason: "<diagnostic>" }` and writes nothing. A `MetricBindingRefusal` cannot be persisted by construction (it has no `verdict` field) and a force-coerced one is caught by the validator.

### Phase 2d invariants

- **Append-only**: each call writes exactly one JSONL line; existing lines are never rewritten. A torn write or a corrupt line never corrupts prior records — the reader skips bad lines.
- **Propose-only**: appending an event MUST NOT mutate hypothesis status, the experiment registry, `promotion_events` / `retraction_events`, memory entries, or any other engine state. The ledger is a record store — nothing more. This mirrors `improvementArchive.ts` and the propose-only invariant in `selfRecommendationEngine.ts` (CLAUDE.md self-evolution policy).
- **Defense-in-depth**: the input is typed as `ExperimentDecision`, so a refusal cannot be persisted by construction; the runtime validator additionally checks the verdict and reason code are in the closed enum before writing.
- **Test isolation**: the ledger path is resolved via `dataPath()` on every call (not at import time), so a test that sets `DATA_DIR` after the module loads still sees the redirected path.
- **No live data migration**: the ledger ships empty; existing deployments do not need a backfill.

## Phase 2e — Sandboxed execution wiring (plan-only)

Phase 2d ends with a verdict and an audit trail; nothing in 2a–2d ever calls `registerExperiment`, `runExperiment`, or any other live side effect. Phase 2e closes the next narrow gap: turning a successful Phase 2b binding into a **sandboxed execution plan** an operator can review (or a future Phase 2e-b helper can act on, when live registration is sandbox-safe).

The output is `SandboxExecutionPlan` (success) or `SandboxExecutionRefusal` (failure). Both shapes carry explicit decision evidence so an operator (or a future Phase 2e-b helper) can audit the call without re-running it.

### Module

`server/experiments/hypothesisSandboxExecution.ts`. Pure (no I/O, no DB writes, no LLM calls, no clock at module-load — `now` is injectable). The active `registerExperiment` is a direct DB write that creates a `running` row and invalidates the runtime cache, so it is NOT obviously sandbox-safe; calling it from this layer is **deferred to Phase 2e-b** once a dry-run / sandbox flag exists on the registration helper itself. The `applySandboxExecutionPlan` function is shipped as an explicit no-op stub so the boundary is visible to anyone who imports the module.

```ts
import {
  planSandboxExecution,
  applySandboxExecutionPlan,
  PHASE2E_HARD_MAX_TRIALS,
  PHASE2E_SUPPORTED_EXPERIMENT_KINDS,
  type SandboxExecutionControls,
} from "./experiments/hypothesisSandboxExecution.js";

const plan = planSandboxExecution(binding, {
  featureFlag:           true,
  operatorApproved:      true,
  dryRun:                false,
  maxTrials:             20,
  allowedMetricKey:      binding.metricKey,
  allowedExperimentKind: "modelRouter",
  notes:                 "approved by ops 2026-05-09",
});
if (plan.ok) {
  // plan.executionPlanId, .hypothesisId, .candidateId, .metricKey,
  // .sandboxMode, .dryRun, .resourceCaps, .experimentKind,
  // .plannedAt, .reason, .evidence, .binding, .controls
} else {
  // plan.code, plan.reason, plan.evidence
}

// Phase 2e is plan-only — applying is a no-op until Phase 2e-b lands.
applySandboxExecutionPlan(plan); // { ok: false, deferredTo: "phase-2e-b" }
```

### Entry criteria

A plan is produced if and only if all of:

1. Input is a successful `MetricBinding` from `bindCandidateMetric` (Phase 2b output) — i.e. the Phase 2 selector cleared the formal hypothesis and the binder mapped the metric to a registered key with a known data source. A `MetricBindingRefusal` cannot reach the function by TypeScript narrowing; a force-coerced refusal is caught by a runtime `binding.ok !== true` check.
2. `binding.candidate.origin === "research_lab.hypotheses"` (defense-in-depth re-check on the binding origin so a hand-rolled record cannot bypass Phase 1.5b's hard-no for memory-origin entries).
3. `controls.featureFlag === true` (deployment-wide gate).
4. `controls.operatorApproved === true` (per-call human approval — there is no stored "always approved" shortcut).
5. `controls.maxTrials` is a finite integer in `[PHASE2E_MIN_TRIALS, PHASE2E_HARD_MAX_TRIALS]` (today: `[1, 200]`).
6. `controls.allowedMetricKey === binding.metricKey` (the operator must explicitly spell out the metric they are authorizing).
7. `controls.allowedExperimentKind` is in `PHASE2E_SUPPORTED_EXPERIMENT_KINDS` (today: `["modelRouter"]`, mirroring the surfaces `registerExperiment` supports).

If any of those fails, `planSandboxExecution` emits a structured `SandboxExecutionRefusal` with a stable `code`, a one-sentence `reason`, and an `evidence[]` audit trail.

### Refusal codes

| Code                            | Meaning                                                                                                  |
|---------------------------------|----------------------------------------------------------------------------------------------------------|
| `feature_flag_off`              | `controls.featureFlag !== true`.                                                                          |
| `operator_not_approved`         | `controls.operatorApproved !== true`.                                                                     |
| `missing_resource_cap`          | `maxTrials` missing, non-integer, NaN, Infinity, or below `PHASE2E_MIN_TRIALS`.                           |
| `resource_cap_exceeds_limit`    | `maxTrials` exceeds `PHASE2E_HARD_MAX_TRIALS`.                                                            |
| `metric_not_allowed`            | `allowedMetricKey` missing OR not equal to `binding.metricKey`.                                            |
| `experiment_kind_not_allowed`   | `allowedExperimentKind` missing or not in `PHASE2E_SUPPORTED_EXPERIMENT_KINDS`.                            |
| `binding_not_ok`                | Caller force-coerced a `MetricBindingRefusal` past the type system (`binding.ok !== true`).                 |
| `binding_origin_invalid`        | `binding.candidate.origin !== "research_lab.hypotheses"` (defense-in-depth on the memory-origin hard-no). |
| `binding_missing_metric_key`    | `binding.metricKey` empty / non-string.                                                                    |
| `invalid_controls`              | `controls` is `null` / `undefined` / not an object.                                                        |

### Plan shape

`SandboxExecutionPlan` carries everything an audit reader needs without a join:

- `executionPlanId` — `plan_<unix-ms>_<6-char-base36>`. Sortable by time, unique per process.
- `hypothesisId`, `candidateId`, `metricKey` — echoed from the binding.
- `sandboxMode` — always `"sandbox"` in Phase 2e. Phase 2e-b may add `"sandbox-live"` for plans the live registration helper is allowed to act on.
- `dryRun` — when `true`, a future Phase 2e-b helper that *does* call `registerExperiment` MUST skip the live side effect. Phase 2e itself does not look at this flag for any side effect — it is a contract for the next layer.
- `resourceCaps` — the `{ maxTrials }` cap applied to this plan.
- `experimentKind` — the operator-authorized kind (today: `"modelRouter"`).
- `plannedAt` — ISO timestamp from injected `now`.
- `reason`, `evidence[]` — narrative + concrete observations.
- `binding` — `{ hypothesisId, metricKey, matchedDataSources, candidateOrigin, candidateTag }` summary.
- `controls` — defensively-copied echo of the controls so a single plan record is self-describing in logs.

### Phase 2e invariants

- **Plan-only**: nothing in this module calls `registerExperiment`, `recordTrialOutcome`, `runExperiment`, the scheduler, or any other live-side-effect path. The output is a typed plan record. The `applySandboxExecutionPlan` shim is intentionally a no-op stub returning `{ ok: false, deferredTo: "phase-2e-b" }` so the boundary is visible.
- **Propose-only**: appending a plan MUST NOT mutate hypothesis status, the experiment registry, `promotion_events` / `retraction_events`, the Phase 2d decision-events ledger, memory entries, or any other engine state. Tests pin this by snapshotting `data/research_lab.json` and `data/memory_knowledge.json` before/after, asserting the Phase 2d ledger file does not appear, and asserting `DATA_DIR` stays empty.
- **Default-refuse**: every control is required and explicit. A caller who omits the feature flag, the operator approval, or the resource cap gets a structured refusal — there is no convenient "default-yes" path.
- **Defense-in-depth on memory origin**: the function signature requires a successful `MetricBinding`, which by Phase 1.5b's hard-no cannot have come from a memory entry. The runtime additionally re-checks `binding.candidate.origin === "research_lab.hypotheses"` so a hand-rolled record is refused with `binding_origin_invalid`.
- **No auto-promotion**: Phase 2e does not write decision events, does not mutate hypotheses, and does not schedule anything. There is no scheduler / daily-cycle automation in this module.
- **Deterministic**: the only state in the module is a per-process counter for `executionPlanId`. With a fixed `now`, plan output is otherwise deterministic. No clock reads at module load, no LLM calls, no file I/O.

## Phase 2e-b: Low-risk sandbox registration registry (`server/experiments/lowRiskSandboxRegistry.ts`)

Phase 2e produced typed sandbox execution **plans** for a single supported experiment kind (`modelRouter`) — the kind `registerExperiment` already understands. Operators have approved a small, narrow set of low-risk experiment kinds they want represented in the system separately from the Phase 2 / 2b / 2e formal-hypothesis chain. Phase 2e-b is the registry that represents those kinds and lets exactly one of them (`summarizationTemplate`) produce a typed sandbox **registration** record.

Phase 2e-b is intentionally a separate scope from Phase 2e:

- It does not consume a Phase 2b `MetricBinding`. The kinds it represents are not bound to formal-hypothesis metrics and are not selected by the Phase 2 selector.
- It does not call the live `registerExperiment` helper. The output is an in-process registration record, not a row in the live `experiments` table.
- It does not call `applySandboxExecutionPlan` or any other Phase 2e helper; the two modules are independent inputs to a future Phase 2e-c apply layer.

### Operator-approved low-risk candidates (current enablement matrix)

| Kind                        | Description                                | Enabled? | Disabled reason                  | Metric seed                    | Cap |
|-----------------------------|--------------------------------------------|---------:|----------------------------------|--------------------------------|----:|
| `summarizationTemplate`     | Output formatting / summariser template    | **YES**  | —                                | `summary_quality_score`        |  25 |
| `reasoningTemplate`         | Prompt-level reasoning pattern             | no       | `future_phase_not_wired`         | `reasoning_quality_score`      |  25 |
| `selfCritiquePrompt`        | Internal self-critique persona             | no       | `requires_internal_persona`      | `self_critique_signal`         |  25 |
| `memoryRetrievalHeuristic`  | Read-only RAG weighting / filtering        | no       | `requires_rag_pipeline`          | `retrieval_quality_score`      |  25 |
| `taskDecompositionPattern`  | Strategy / task-decomposition pattern      | no       | `requires_strategy_router`       | `decomposition_quality_score`  |  25 |

Disabled kinds are **registered but un-callable**: a registration request returns `{ ok: false, code: "kind_disabled", disabledReason: "<code>" }`. They surface in `listLowRiskSandboxKinds()` for audit panels without giving them an execution path. Flipping `enabled: true` for any of them is a separate decision with its own approval and PR.

### `summarizationTemplate` constraints

A registration for `summarizationTemplate` succeeds only when **every** control is set explicitly:

| Control            | Required value                | Refusal code (when violated)            |
|--------------------|-------------------------------|-----------------------------------------|
| `featureFlag`      | `true`                        | `feature_flag_off`                      |
| `operatorApproved` | `true`                        | `operator_not_approved`                 |
| `dryRun`           | `true` (Phase 2e-b is dry-run-ONLY) | `dry_run_required`                |
| `fixtureSource`    | `"static"` (Phase 2e-b is static-fixture-ONLY) | `fixture_source_not_allowed`, or `live_traffic_not_allowed` if the source names live/production |
| `maxTrials`        | finite integer in `[1, 25]`   | `missing_resource_cap` / `resource_cap_exceeds_limit` |
| `useScheduler`     | `false` (Phase 2e-b is scheduler-free) | `scheduler_not_allowed`           |
| `promotionEligible`| `false` (Phase 2e-b registrations are not promotable) | `promotion_not_allowed` |

The metric seed is `summary_quality_score`, with four guardrail keys carried into the registration's evidence trail: `hallucination_count`, `citation_source_retention`, `format_compliance`, `length_compliance`. Phase 2e-b does **not** grade trials — these are measurement targets a future Phase 2e-c runner would compute from static fixture outputs.

### Usage

```ts
import {
  registerLowRiskSandboxKind,
  applyLowRiskSandboxRegistration,
  listLowRiskSandboxKinds,
  PHASE2EB_GLOBAL_MAX_TRIALS,
  type LowRiskSandboxControls,
} from "./experiments/lowRiskSandboxRegistry.js";

const reg = registerLowRiskSandboxKind("summarizationTemplate", {
  featureFlag:       true,
  operatorApproved:  true,
  dryRun:            true,
  fixtureSource:     "static",
  maxTrials:         5,
  promotionEligible: false,
  useScheduler:      false,
  notes:             "approved by ops 2026-05-09 for sandbox eval",
});
if (reg.ok) {
  // reg.registrationId, .kind, .sandboxMode, .metricKey, .guardrails,
  // .resourceCaps, .registeredAt, .reason, .evidence, .controls
} else {
  // reg.code, reg.disabledReason?, reg.reason, reg.evidence
}

// Phase 2e-b is registration-only — applying is a no-op until Phase 2e-c lands.
applyLowRiskSandboxRegistration(reg); // { ok: false, deferredTo: "phase-2e-c" }
```

### Phase 2e-b invariants

- **Registration-only**: nothing in this module calls `registerExperiment`, `recordTrialOutcome`, `runExperiment`, the scheduler, or any other live helper. The output is a typed in-process record. The `applyLowRiskSandboxRegistration` shim is a no-op stub returning `{ ok: false, deferredTo: "phase-2e-c" }`.
- **Propose-only**: storing a registration in the in-memory map is process-local. Tests pin that no file under `DATA_DIR` is created, the real `data/research_lab.json` and `data/memory_knowledge.json` snapshots are unchanged, and the Phase 2d decision-events ledger is not written.
- **Default-refuse**: every control is required and explicit. A caller who omits the feature flag, the operator approval, the dry-run flag, the fixture source, the resource cap, the scheduler flag, or the promotion flag gets a structured refusal — there is no convenient "default-yes" path.
- **Single-kind enablement**: `summarizationTemplate` is the only kind whose `enabled` flag is `true` today. Every other kind in `LOW_RISK_SANDBOX_KINDS` refuses with `kind_disabled` and the registry entry's `disabledReason`.
- **Independent scope**: Phase 2e-b does not share the Phase 2b metric registry, the Phase 2e plan shape, or the Phase 2c decision rules. It is the next-narrowest input to a future Phase 2e-c apply layer.
- **Phase 2e plan-only behavior preserved**: the existing Phase 2e module is untouched; `planSandboxExecution` still produces plans for `modelRouter` and `applySandboxExecutionPlan` is still a no-op deferred to Phase 2e-b. (Phase 2e-b does not change Phase 2e's wiring.)

## Phase 2e-c: Persistent sandbox registration records (`server/experiments/sandboxRegistrationRecords.ts`)

Phase 2e-b produced typed in-memory `LowRiskSandboxRegistration` records. The map was process-local and not durable. Phase 2e-c closes the next narrow gap: persisting those registrations as an append-only audit trail, complete enough for a future apply / promotion / rollback layer to act on without re-running registration.

Phase 2e-c does NOT enable any new live behavior — there is still no scheduler, no `registerExperiment` call, no auto-apply, no mutation of hypotheses or memory. The only side effect is appending JSONL lines to `data/sandbox_registration_records.jsonl` (path resolved through `DATA_DIR`).

### Record shape

Each call appends one event line. Three event types share the ledger; readers branch on `event`:

| Event           | When                                            | Row meaning                                      |
|-----------------|-------------------------------------------------|--------------------------------------------------|
| `registration`  | initial persistence of a Phase 2e-b success     | `active: true`, `status: "active"`, manifest + snapshot hash + preMetrics + empty postMetrics + rollback instructions |
| `completion`    | follow-up that ATTACHES `postMetrics`           | `active: false`, `status: "completed"`, reuses the registration's `recordId`, sets `completedAt` / `updatedAt` |
| `refused`       | persisted Phase 2e-b refusal (e.g. disabled kind) | `active: false`, `status: "refused"`, never an active registration |

The full required field set on a `registration` row:

| Field                       | Required? | Notes                                                                                              |
|-----------------------------|-----------|-----------------------------------------------------------------------------------------------------|
| `recordId`                  | yes       | `regrec_<unix-ms>_<6-base36>`. Reused by the matching `completion` row.                             |
| `eventId`                   | yes       | Unique per line: `evt_<unix-ms>_<6-base36>`.                                                       |
| `event`                     | yes       | `"registration" \| "completion" \| "refused"`.                                                     |
| `kind`                      | yes       | One of the five `LOW_RISK_SANDBOX_KINDS`.                                                          |
| `active`                    | yes       | `true` only on registration rows.                                                                  |
| `manifest`                  | yes (registration) | Full Phase 2e-b manifest snapshot: `kind`, `sandboxMode`, `metricKey`, `guardrails`, `resourceCaps`, `registeredAt`, `controls` echo. Defensive copy — later mutation of the in-memory registration cannot retroactively change this. |
| `sandboxSnapshotHash`       | yes (registration) | When the caller does not supply one, derived as `sha256(canonicalJSON(manifest excluding registrationId))`. Two semantically-equivalent manifests produce the same hash; a tampered manifest does not. |
| `preMetrics`                | yes (registration) | `Record<string, finite number>`. May be `{}`. Numbers only — non-finite values refuse.            |
| `postMetrics`               | yes (registration) | Always present. Initially `{}` on the registration row; populated on the matching `completion` row. |
| `rollbackInstructions`      | yes (registration) | Non-empty array of non-empty strings. Required: missing/empty refuses, writing nothing.            |
| `operator`                  | yes       | `{ source, note?, approvalRef? }`. `source` non-empty.                                             |
| `featureFlagState`          | yes (registration) | `{ name, enabled, rollout? }`.                                                                     |
| `metricKey`                 | yes (registration) | Hoisted from manifest for fast filtering.                                                          |
| `guardrailKeys`             | yes (registration) | Hoisted from manifest for fast filtering.                                                          |
| `sandboxAutoApplyEligible`  | optional  | **Defaults to `false`.** Even when explicitly `true`, NO auto-apply behavior runs — this is a flag for a future apply layer.                                                                              |
| `autoApplyPolicy`           | optional  | Free-text label; defaults to `"manual-only"`.                                                      |
| `phase2ebRegistrationId`    | optional  | Echo of the in-memory Phase 2e-b id when one exists.                                               |
| `hypothesisId` / `candidateId` / `bindingId` | optional | Reserved for a future Phase 2e-d binding wiring; today low-risk kinds don't produce these. |
| `createdAt`                 | yes (registration) | ISO timestamp; mirrors `manifest.registeredAt`.                                                    |
| `updatedAt` / `completedAt` | yes (completion)   | ISO timestamps set on the completion row.                                                          |
| `refusalCode` / `refusalReason` / `refusalEvidence` | yes (refused) | Echo of the Phase 2e-b refusal payload.                                          |

### Usage

```ts
import {
  appendRegistrationRecord,
  appendCompletionRecord,
  appendRefusedRegistrationRecord,
  readRecords,
  readRecordsTail,
  readRecordsForRecordId,
  readActiveRegistrationRecords,
} from "./experiments/sandboxRegistrationRecords.js";

const reg = registerLowRiskSandboxKind("summarizationTemplate", controls);
if (!reg.ok) {
  // Persist the refusal as a non-active record (audit trail).
  appendRefusedRegistrationRecord({
    refusal:  reg,
    operator: { source: "operator:rey" },
    featureFlagState: { name: "phase2eb_lowrisk", enabled: true },
  });
} else {
  const ev = appendRegistrationRecord({
    registration:         reg,
    rollbackInstructions: [
      "Disable the Phase 2e-b sandbox feature flag (set to false).",
      "Drop the in-memory registration via __resetLowRiskSandboxRegistryForTests in dev/test only.",
      "Append a refused record with reason='operator-initiated rollback' for audit.",
    ],
    operator:         { source: "operator:rey", note: "approved 2026-05-09" },
    featureFlagState: { name: "phase2eb_lowrisk", enabled: true, rollout: 1.0 },
    preMetrics:       { summary_quality_score: 0.71 },
    // sandboxAutoApplyEligible: false  (this is the default; no need to set)
  });
  // Later, after a sandbox-only static-fixture run produces postMetrics:
  if (ev.ok) {
    appendCompletionRecord({
      recordId:    ev.event.recordId,
      postMetrics: { summary_quality_score: 0.84, format_compliance: 0.97 },
      operator:    { source: "operator:rey" },
      outcome:     "clean",
    });
  }
}
```

### Phase 2e-c invariants

- **Append-only**: each call writes one JSONL line; existing lines are never rewritten. A torn write or a corrupt line never corrupts prior records — the reader skips bad lines.
- **Propose-only**: appending a record MUST NOT mutate hypothesis status, the live `experiments` table, the Phase 2d decision-events ledger, the Phase 2e-b in-memory map, `data/research_lab.json`, or `data/memory_knowledge.json`. Tests pin all of these.
- **No auto-apply**: `sandboxAutoApplyEligible` is recorded but never read by anything that mutates state. The user policy is documented below and enforced by the **absence** of a code path here.
- **Default-refuse on inputs**: missing rollback instructions, empty rollback instructions, malformed `featureFlagState`, non-finite `preMetrics`, an empty caller-supplied `sandboxSnapshotHash`, a Phase 2e-b refusal passed to `appendRegistrationRecord`, a completion that names no prior registration, or a completion with an empty / non-finite `postMetrics` — all refuse, writing nothing.
- **Disabled kinds cannot become active registrations**: `appendRegistrationRecord` requires `registration.ok === true`. Disabled-kind requests must go through `appendRefusedRegistrationRecord`, which writes `event: "refused"` / `active: false`.
- **Deterministic snapshot hash**: when omitted, the snapshot hash is derived from the manifest's canonical JSON (sorted keys, recursive). Identical manifests hash identically; tampered manifests do not.

### Enablement roadmap for the four currently-disabled low-risk kinds

The Phase 2e-b enablement matrix is unchanged in this phase: only `summarizationTemplate` is `enabled: true`. Flipping any other kind is a separate PR with its own approval. The current operator-approved order (subject to revision) is:

1. **`selfCritiquePrompt`** — internal critique persona. Likely the next to enable once the persona harness lands; runs entirely on internal-only personas with no external surface.
2. **`taskDecompositionPattern`** — strategy / task-decomposition pattern. Enable alongside or shortly after `selfCritiquePrompt`; needs a decomposition router.
3. **`reasoningTemplate`** — prompt-level reasoning pattern. Enable once a Phase 2e-d reasoning runner exists.
4. **`memoryRetrievalHeuristic`** — read-only RAG weighting / filtering. **Last** of the four. Even read-only changes affect context selection more broadly, so this kind requires a sandbox-safe RAG read path AND a deeper review of context-selection blast radius before its `enabled` flag flips.

Each enablement is a **registry-flip** change: set `enabled: true` and remove `disabledReason` for that kind in `LOW_RISK_SANDBOX_REGISTRY`. The Phase 2e-c persistence layer needs no changes to support a newly-enabled kind — the JSONL ledger already accepts every kind in `LOW_RISK_SANDBOX_KINDS`.

### Sandbox-only auto-apply policy (post-track-record)

Phase 2e-c records the `sandboxAutoApplyEligible` flag but never acts on it. The operator-approved policy for a future apply layer is:

- After **5–10 clean low-risk sandbox registrations** have landed and run cleanly through the static-fixture cycle (no degraded outcomes, no rollback events, no surprising postMetrics), **consider** allowing Agent 306 to auto-apply selected kinds inside sandbox sessions without per-call human approval. Candidates are kinds whose blast radius is provably contained to the sandbox (most likely `summarizationTemplate` first; `selfCritiquePrompt` and `taskDecompositionPattern` next).
- **Public posting and publishing remain ALWAYS approval-gated** by GitHub / explicit user approval. Sandbox-only auto-apply does NOT extend to anything that crosses the GitHub boundary, posts to a public surface, or mutates production memory or the live `experiments` table.
- The transition is itself a separate PR: a future `applyLowRiskSandboxRegistration` would read `sandboxAutoApplyEligible` from the ledger, gate on a feature flag, and refuse anything that would cross the public boundary. Phase 2e-c does not ship that layer.

## What remains deferred to Phase 2e-d (live sandbox application)

- A live scheduler / daily-cycle helper that consumes `ExperimentDecision` events from the Phase 2d ledger and calls a registration helper. Phase 2e produces plans on demand from a binding; a scheduler that walks the ledger and produces plans automatically is explicitly out of scope.
- A sandbox-safe `registerExperiment` (or a sandbox flag on the existing helper) that respects `dryRun` and `maxTrials`. The current `registerExperiment` writes a `running` row and invalidates the runtime cache — calling it from a sandbox plan or a Phase 2e-b registration today would mean a live-traffic experiment; Phase 2e and Phase 2e-b both refuse to do that.
- Wiring `applySandboxExecutionPlan` and `applyLowRiskSandboxRegistration` to the new sandbox-safe registration helper. Today both functions are no-op stubs. A Phase 2e-d apply layer would also be the first reader of `sandboxAutoApplyEligible` from the Phase 2e-c ledger.
- Persisting `promotion_events` / `retraction_events` on the hypothesis record (and the schema migrations that come with it). A decision-event is a *proposal* record; an applied promotion is a different record type with its own table.
- A statistical sequential test (SPRT, Bayesian posterior, CUPED-style variance reduction) that replaces the threshold layer once we have enough trials to calibrate one.
- Dashboard surfaces over the ledger, the plan record store, the Phase 2e-b registration map, or the Phase 2e-c records ledger.
- Growing the metric registry from a database / config file / LLM proposal — and the migration logic that comes with it.
- A live runner for `summarizationTemplate` that computes `hallucination_count`, `citation_source_retention`, `format_compliance`, and `length_compliance` from static-fixture outputs. The metric seed and guardrails are present so a future Phase 2e-d runner has a clean target.
- Enabling the four currently-disabled low-risk kinds (`reasoningTemplate`, `selfCritiquePrompt`, `memoryRetrievalHeuristic`, `taskDecompositionPattern`). Each requires its own runner / persona / pipeline before its `enabled` flag can flip — see the Phase 2e-c enablement roadmap above for current ordering.

## What is deferred to Phase 2f (meta-reflection / lessons database)

- A layer that reads the decision-events ledger and summarises what the system has learned: which thresholds fire most often, which guardrails dominate, how often `needs_review` resolves to `promote` vs. `reject` after operator review, distribution of decision lag, etc.
- A "lessons database" surface: structured derivations from the ledger that feed back into the research-topic / hypothesis pipeline (e.g. "metric X has produced N inconclusive runs in a row — propose a different operationalisation").
- Phase 2d gives 2f the raw input: a clean, append-only event log with stable verdict / reason-code enums and `thresholdsUsed` per row. Phase 2d does not compute the summary.

The selector + binding + decision + ledger + sandbox-plan + low-risk-registry + sandbox-registration-records modules are intentionally *propose-only*. Phase 2e produces sandbox execution plans on demand for the formal-hypothesis chain. Phase 2e-b adds an independent low-risk sandbox registration registry (today: `summarizationTemplate` enabled, four other operator-approved kinds disabled). Phase 2e-c persists those registrations as an append-only JSONL audit trail with manifest snapshots, snapshot hashes, pre/post metrics fields, and rollback instructions — still without any live application path. All three are registration-only / plan-only — none of them calls `registerExperiment`, mutates a hypothesis, writes the Phase 2d ledger, or schedules anything. Phase 2e-d will wire `applySandboxExecutionPlan` and `applyLowRiskSandboxRegistration` into a sandbox-safe `registerExperiment` and the daily-cycle / scheduler boot path, but only behind a feature flag, only with `promotion_events` / `retraction_events` persistence in place, and only after the operator-approved track-record threshold (5–10 clean low-risk registrations) has been reached.

## Invariants Phase 2 preserves

- **Propose-only**: nothing in this module writes to the database, the JSON files, or the experiment registry. The output is candidates and refusals; an operator (or a future Phase 2b helper) decides what to do. (Phase 2d's ledger and Phase 2e-c's records ledger are the only file writes — they persist evidence/registration records, never engine state.)
- **Single readiness gate**: `canFeedExperiment` from `server/hypothesisHygiene.ts` is the only function that says "yes, a formal hypothesis may proceed". The selector composes it; it does not re-implement it.
- **Memory-origin records are never candidates**: the type system, the function partitioning, and the absence of any `ok: true` branch on `canMemoryEntryFeedExperiment` all enforce this.
- **History is preserved**: no records are mutated. The selector is a pure read; the Phase 2d ledger and the Phase 2e-c records ledger are both append-only.
