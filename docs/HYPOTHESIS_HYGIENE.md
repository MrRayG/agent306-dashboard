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
```

Output sections:

- **By hygiene tag** — counts per `HygieneTag`
- **By lifecycle status** — counts per existing `Hypothesis.status`
- **Missing readiness fields** — count of records missing each required field
- **Duplicate-claim groups** — claims that normalize identically (lowercased, punctuation-stripped) appearing on ≥2 records
- **Stale active hypotheses** — `forming`/`testing` records older than `--stale-days` (default 30)

The CLI **never writes back** to `research_lab.json`. Annotation is operator-only.

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
| `hypothesisHygiene.ts` (this PR)            | Phase 1.5 triage tags + Phase 2 readiness gate — composes all of the above |

The new module reads existing fields; it does not duplicate any of those gates. Each lower-level signal feeds a tag verdict (e.g. `aliasOf` → `duplicate`, `dataSourceGateBlockedAt` → `needs_data`).

## What NOT to put here

- Phase 2 decisioning rules (which experiments to fund, promotion events, retraction events) — that is the next PR.
- Dashboards or new experiment-summary tables.
- Auto-archival logic. The operator decides; this module reports.
- Mutations of stored records during a normal cycle.
