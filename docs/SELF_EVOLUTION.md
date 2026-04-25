# Self-Evolution Foundation

**Policy:** Agent 306 may propose; humans approve. Nothing on this path auto-applies a code, config, schema, prompt, or data change.

This document describes the self-evolution loop the mega-PR `refactor/self-evolution-foundation` lands. It is the canonical reference for operators reviewing recommendations and for contributors adding new hooks.

## The Loop

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  engines                           selfRecommendationEngine      │
│  (reflection, dream,     ──────►   proposeRecommendation({...})  │
│   metacognition, etc.)             status = 'proposed'           │
│                                             │                    │
│                                             ▼                    │
│                               operator reviews /self-recs UI     │
│                                             │                    │
│                                     ┌───────┴───────┐            │
│                                     ▼               ▼            │
│                                 approve          reject          │
│                                     │                            │
│                                     ▼                            │
│                              status = 'approved'                 │
│                                     │                            │
│                                     ▼                            │
│                              applyRecommendation                 │
│                                     │                            │
│                                     ▼                            │
│                              eval/promotionGate.canPromote       │
│                                     │                            │
│                             ┌───────┴───────┐                    │
│                             ▼               ▼                    │
│                           block           ok                     │
│                                             │                    │
│                                             ▼                    │
│                              status = 'applied'                  │
│                              (+ optional draft PR / patch file)  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Actors

| Surface | Module |
|---|---|
| Propose | `server/selfRecommendationEngine.ts` → `proposeRecommendation()` |
| Store | `self_recommendations` table in `shared/schema.ts` |
| Review UI | `client/src/pages/SelfRecommendations.tsx` |
| HTTP | `server/selfRecommendationRouter.ts` — `/api/self-recommendations/*` |
| Promotion gate | `server/eval/promotionGate.ts` → `canPromote(rec)` |
| Regression runner | `server/eval/regressionRunner.ts` + `data/eval/golden/*.json` |
| Draft PR / patch | `server/githubBridge.ts` |

## Status transitions

`proposed → approved | rejected`
`approved → applied` (ONLY via the promotion gate)
`applied → reverted`

Any attempt to move between any other pair throws. Tests pin every edge:
- `server/__tests__/selfRecommendationEngine.test.ts`
- `server/__tests__/selfRecommendationRouter.test.ts`
- `server/__tests__/promotionGate.test.ts`

## The promotion gate

`canPromote(rec)` is the ONLY path to `status: applied`. It runs every golden set in `data/eval/golden/*.json` and returns a typed `{ok, failures, ranSets}`.

Policy matrix:

| rec.status   | rec.risk  | Golden sets | canPromote result                                                                                                        |
|--------------|-----------|-------------|--------------------------------------------------------------------------------------------------------------------------|
| ≠ approved   | any       | not run     | **block** — `recommendation not approved`                                                                                 |
| approved     | low       | any         | **allow**, failures logged (friction proportional to risk)                                                                |
| approved     | medium    | any failed  | **block**                                                                                                                 |
| approved     | medium    | all pass    | **allow**                                                                                                                 |
| approved     | high      | any failed  | **block**                                                                                                                 |
| approved     | high      | all pass    | **block** unless `PROMOTION_GATE_ALLOW_HIGH_RISK=true` — explicit per-deployment override required                        |

There is no `auto_apply=true` knob. There is no bypass path. The gate is structurally incapable of auto-merging because `applyRecommendation` only writes to a row's status; producing a PR / patch / code diff is a separate, operator-triggered action (`POST /api/self-recommendations/:id/draft-pr`).

## What the agent can propose

The integration hooks (spec §1) are intentionally narrow:

| Engine | Category | Trigger |
|---|---|---|
| `reflectionEngine.addStyleRule` | `prompt` | new style rule created |
| `breakthroughDetector.detectBreakthroughs` | `data` | breakthrough detected |
| `evolutionTracker.takeSnapshot` | `engine` | score regresses >=10 pts |
| `dreamEngine.generateSelfImprovementPlan` | `engine` | improvement plan produced |
| `metacognitionEngine.getMetacognitionState` | `engine` | learning velocity slowing (24h debounced) |
| `hypothesisConsolidator.consolidateHypotheses` | `data` | >=5 duplicates merged |

To add a new hook: import `proposeRecommendation` at the top of the engine and call it once at the natural emit point. Do not branch on the result — the engine should stay unaware of the review flow.

## What the agent cannot propose

- **Source code changes** beyond attaching a unified diff to a `proposedDiff`. The diff never auto-applies; the operator reviews it and either opens a draft PR via `githubBridge` or writes a patch file.
- **Soul mutations**. `memory_soul.json` / the `memorySoul` table are write-through only via `soulRepository.writeSoulBlob()` which records every write in `memorySoulHistory`. There is no hook that calls that from a self-recommendation.
- **Schema changes**. High-risk recommendations are blocked by default; `PROMOTION_GATE_ALLOW_HIGH_RISK` must be set per-deployment AND golden sets must pass.
- **Model routing**. `modelRouter.ts` is pinned by `modelRouter.golden.json`. A self-change that collapses tiers or reroutes `hypothesis-evaluation` off `frontier-factual` fails the gate.

## The operator's review checklist

For each proposed recommendation the operator should verify:

1. **Evidence**. Does the `evidence` array point to real rows (hypothesisId, insightId, logId, metricId, engineRunId) that justify the proposal?
2. **Scope match**. Does the `category` match the actual target? (e.g., a "touches the schema" proposal marked `category: prompt` is a red flag.)
3. **Risk calibration**. Does the `risk` match what would break if applied poorly? Schema changes are `high` by definition.
4. **Golden-set coverage**. If approving a medium/high-risk rec, check `/api/self-recommendations/:id/apply`'s response — `failures` must be empty and `ranSets` must list every set that exercises the surface this change would touch. If a relevant surface has no golden set, ask for one first.
5. **Reversibility**. If applied, can it be reverted by flipping the status back to `reverted` and (for `prompt` changes) deleting the style rule? If reversion requires ops, call that out in the review note.

## Adding a new golden set

See `data/eval/golden/README.md`. Two-step:
1. Register the module in `server/eval/regressionRunner.ts` (static registry).
2. Drop a new `*.golden.json` in `data/eval/golden/`.

## Where nothing auto-applies

`selfRecommendationEngine.applyRecommendation()` (the line-level invariant) refuses to transition unless all three of:
- `existing.status === 'approved'`
- `canPromote(rec).ok`
- operator-initiated call (the router requires the dashboard secret)

Grep for `status: "applied"` across the codebase — the only write site is inside `applyRecommendation()`. That's the single choke point.

## Observability

Every engine run flows through `engineRunWrapper` which writes a row to `engine_runs` and emits a structured event via `observability/structuredLog.logEvent`. Use these to answer "what proposed that rec, when, and with what evidence":

```ts
import { recentEvents } from "./observability/structuredLog";
recentEvents({ engine: "reflectionEngine", limit: 50 });
```

## Optional environment variables

- `BIBLE_API_KEY` — optional. WisdomEngine pulls scripture from https://scripture.api.bible/ when set. If unset or invalid (401), the Bible source is skipped quietly (one log line per process) and the wisdom pull continues with the remaining sources.

## Rollback

- **JSON fallback**: flip `USE_DB_STATE=false` to force every repository back to JSON.
- **Schema**: each new table has `CREATE TABLE IF NOT EXISTS`; an operator who wants to drop one must do it manually — no migration runner auto-drops.
- **Applied recommendation**: operator calls `POST /api/self-recommendations/:id/revert` which transitions `applied → reverted`. The code change itself (if any) is reversed by the operator, not by the platform.
