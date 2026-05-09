# Hypothesis Hygiene (Phase 1.5)

**Policy:** Phase 2 will turn hypotheses into evidence-based experiment proposals. Before that, a triage layer keeps irrelevant, stale, duplicate, non-actionable, or unsolvable hypotheses out of the experiment-decisioning loop. This module is **propose-only and conservative**: it never archives or deletes records on its own. Operators (or future review surfaces) make the final call.

## Triage tags

`server/hypothesisHygiene.ts` defines `HygieneTag`. Tags are computed *from* a hypothesis record; they do **not** replace the existing lifecycle `status` (`forming` / `testing` / `confirmed` / `rejected` / `expired` / `awaiting-deadline` / `data-unavailable` / `stale-retired`).

| Tag                    | Meaning                                                                                  |
|------------------------|------------------------------------------------------------------------------------------|
| `ready_for_experiment` | Operator-cleared. Phase 2 may register an experiment.                                    |
| `candidate`            | All readiness fields present; awaiting operator review.                                  |
| `needs_data`           | No measurement path, or PR #280 data-source gate blocked it.                             |
| `needs_rewrite`        | Missing claim/metric/basis/prediction, or rubric verdict = `reject`.                     |
| `needs_review`         | Rubric verdict = `review` — operator must inspect.                                       |
| `duplicate`            | Consolidator absorbed it (`aliasOf` populated).                                          |
| `blocked`              | Operator-set: temporarily blocked behind something else.                                 |
| `archived_irrelevant`  | Operator-set, or status = `confirmed` / `rejected` (already resolved).                   |
| `archived_unsolvable`  | Status = `data-unavailable`, or operator-set.                                            |
| `archived_stale`       | Status = `stale-retired` / `expired`, or operator-set.                                   |

`READY_TAGS = [ready_for_experiment, candidate]`. `ARCHIVED_TAGS = [archived_irrelevant, archived_unsolvable, archived_stale]`. The two sets are disjoint.

## Phase 2 readiness gate

```ts
import { canFeedExperiment } from "./hypothesisHygiene.js";

const verdict = canFeedExperiment(hyp);
if (!verdict.ok) {
  // refuse — log verdict.reasons and verdict.blockers
  return;
}
// proceed to Phase 2 experiment registration
```

`canFeedExperiment` **must** be called by every Phase 2 code path that turns a hypothesis into an experiment. It refuses anything not in `READY_TAGS`, and it refuses even ready-tagged hypotheses if any readiness field is missing (defense-in-depth — operators can't fast-path a record that the field-level audit would catch). There is **no bypass**. This sits *before* the existing promotion gate (`server/eval/promotionGate.ts`); the two compose.

## Required readiness fields

A hypothesis is field-ready when ALL of the following hold:

- `claim`           : ≥10 non-whitespace chars
- `metric`          : ≥3 non-whitespace chars
- `basis`           : non-empty
- `prediction`      : ≥5 non-whitespace chars
- `measurementPath` : non-empty (PR #280)

`actionWithin24h` is **not** a readiness field — that is the Wave 2.3 PR-3 *resolution* gate, applied when transitioning to a resolved state, not when feeding a new experiment.

## CLI: `scripts/hypothesisAudit.ts`

Read-only utility. Loads `data/research_lab.json`, runs the audit, prints a triage summary.

```bash
npx tsx scripts/hypothesisAudit.ts
npx tsx scripts/hypothesisAudit.ts --json
npx tsx scripts/hypothesisAudit.ts --details
npx tsx scripts/hypothesisAudit.ts --file data/hypothesis_archive.json
npx tsx scripts/hypothesisAudit.ts --stale-days 14

# also exposed as an npm script
npm run hypothesis:audit
npm run hypothesis:audit -- --json
npm run hypothesis:audit -- --memory-file data/memory_knowledge.json
```

Output sections:

- **By hygiene tag** — counts per `HygieneTag`
- **By lifecycle status** — counts per existing `Hypothesis.status`
- **Missing readiness fields** — count of records missing each required field
- **Duplicate-claim groups** — claims that normalize identically (lowercased, punctuation-stripped) appearing on ≥2 records
- **Stale active hypotheses** — `forming`/`testing` records older than `--stale-days` (default 30)

The CLI **never writes back** to `research_lab.json`. Annotation is operator-only.

### Live (Railway) audit commands

`research_lab.json` (formal hypotheses) and `memory_knowledge.json` are mounted at `/app/data/` on the deployed Railway container. Run the CLI against the live files via the Railway shell:

```bash
# Phase 1.5 — formal research_lab hypotheses
npx tsx scripts/hypothesisAudit.ts --file /app/data/research_lab.json
npx tsx scripts/hypothesisAudit.ts --file /app/data/hypothesis_archive.json

# Phase 1.5b — memory-origin hypothesis-shaped entries
npx tsx scripts/hypothesisAudit.ts --memory-file /app/data/memory_knowledge.json
npx tsx scripts/hypothesisAudit.ts --memory-file /app/data/memory_knowledge.json --details
npx tsx scripts/hypothesisAudit.ts --memory-file /app/data/memory_soul.json   # 0-entry shape; reports cleanly
```

The 2026-05 Railway audit revealed `topics: []` and `hypotheses: []` in `research_lab.json` while `memory_knowledge.json` carried 28 entries whose `title` started with `Hypothesis:`. Those memory entries were written by `researchEngine.ts` (`addKnowledge({ title: "Hypothesis: ${topic.hypothesis.slice(0,60)}", ... })`) as a write-only telemetry side effect of past research cycles. They are **not** formal hypothesis records — they have no `metric`, `prediction`, `basis`, or `measurementPath`, and no production code path treats them as candidate experiment inputs. Phase 1.5b makes that invariant explicit (see below).

## Phase 1.5b: memory-origin hypothesis hygiene

`server/memoryHypothesisHygiene.ts` extends Phase 1.5 to cover hypothesis-shaped records living in `data/memory_knowledge.json`. It is **propose-only** in the same sense as Phase 1.5: pure functions, no mutation of stored memory entries, no auto-archival. History is preserved.

### Detection

A memory entry is treated as a memory-origin hypothesis when its `title` starts with `Hypothesis:` (case-insensitive). The prefix is exported as `HYPOTHESIS_TITLE_PREFIX` for reuse.

### Classification

Memory-origin entries default to **`needs_review`**. They never receive `ready_for_experiment` or `candidate` regardless of their content — by Phase 1.5 readiness rules they would always fail (no `metric`, `prediction`, `basis`, or `measurementPath`), and the operator action is "decide whether to promote to a formal hypothesis", not "fix fields on this entry". Operator-set `status === "archived"` maps to `archived_irrelevant`.

### Phase 2 readiness gate

```ts
import { canMemoryEntryFeedExperiment } from "./memoryHypothesisHygiene.js";

const verdict = canMemoryEntryFeedExperiment(entry);
if (!verdict.ok) {
  // refuse — log verdict.reasons and verdict.blockers
  return;
}
// (unreachable — there is no ok=true branch)
```

`canMemoryEntryFeedExperiment` has **no `ok: true` branch**. Raw memory-origin entries cannot feed Phase 2 experiments under any condition. Promotion to a formal `research_lab.hypotheses[]` record (with hygiene metadata + readiness fields) is the only supported path; once promoted, the formal `canFeedExperiment` from `hypothesisHygiene.ts` decides. This keeps the Phase 2 readiness gate single-source-of-truth on formal `Hypothesis` records.

At the time of writing, no production code path enumerates `memory_knowledge.json` entries as candidate hypotheses for experiments. The gate exists as defense-in-depth: any future code path that *might* iterate the memory has a single, documented place to refuse.

### How to interpret the 28 live `Hypothesis:`-prefixed memory entries

- They are **historical research output**, not current experiment candidates.
- They were authored by `researchEngine.ts:1666` (`addKnowledge({ title: "Hypothesis: ..." })`) as `category: "research"`, `tier: "operational"`, `weight: 7`, `learnedAt` 2026-03-29 / 2026-03-30.
- Phase 1.5b classifies all 28 as `needs_review` with `canFeedExperiment: false`. None of them carries the readiness fields a Phase 2 experiment needs.
- To resurface a specific entry as a real experiment candidate, an operator must hand-author a corresponding formal hypothesis in `research_lab.hypotheses[]` (with `claim` / `metric` / `basis` / `prediction` / `measurementPath` / hygiene metadata) and set `promotedToHypothesisId` on the memory entry for traceability. The formal record then goes through the Phase 1.5 readiness gate.

## Operator annotation

If an operator wants the verdict reflected on the stored record:

```ts
import { annotate } from "./hypothesisHygiene.js";

const annotated = annotate(hyp, "archived_irrelevant", "off-domain — not aligned with current research focus");
// then save through the normal researchEngine writer
```

Adds: `hygieneTag`, `hygieneReason`, `hygieneTaggedAt`, `hygieneTaggedBy`. No production code path mutates these automatically. Future review UI / dashboard endpoints are the only writers.

## Relationship to existing infrastructure

| Component                                   | Role                                                                  |
|---------------------------------------------|-----------------------------------------------------------------------|
| `hypothesisFeasibilityGate.ts` (PR #280)    | Pre-`testing` heuristic — feeds `dataSourceGateBlockedAt` field       |
| `hypothesisDataSourceGate.ts`               | Same — measurement-path enforcement                                   |
| `hypothesisStateMachine.ts`                 | Lifecycle transitions (awaiting-deadline / data-unavailable / stale)  |
| `hypothesisTriage.ts` (Wave 2.3 PR-4)       | Stake × confidence 2×2; computes `queue` (active/backlog)             |
| `hypothesisConsolidator.ts`                 | Pre-insertion similarity dedup; sets `aliasOf` for duplicates         |
| `hypothesisHygiene.ts` (Phase 1.5)          | Triage tags + Phase 2 readiness gate — composes all of the above       |
| `memoryHypothesisHygiene.ts` (Phase 1.5b)   | Detect/classify memory-origin `Hypothesis:`-titled entries; hard-no Phase 2 gate |

The new module reads existing fields; it does not duplicate any of those gates. Each lower-level signal feeds a tag verdict (e.g. `aliasOf` → `duplicate`, `dataSourceGateBlockedAt` → `needs_data`).

## What NOT to put here

- Phase 2 decisioning rules (which experiments to fund, promotion events, retraction events) — that is the next PR.
- Dashboards or new experiment-summary tables.
- Auto-archival logic. The operator decides; this module reports.
- Mutations of stored records during a normal cycle.

## Downstream — Phase 2

`canFeedExperiment` is consumed by `server/experiments/hypothesisExperimentSelector.ts` (Phase 2). The selector partitions the formal `research_lab.hypotheses[]` backlog into experiment **candidates** and structured **refusals**, and pairs that with explicit hard-no refusals for memory-origin entries. See [`PHASE2_EXPERIMENTS.md`](./PHASE2_EXPERIMENTS.md) for the entry criteria, output types, and the relationship between research topics, formal hypotheses, memory hypotheses, and experiments.
