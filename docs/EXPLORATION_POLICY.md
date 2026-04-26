# Gap C — Exploration Policy Design Doc

**Author**: Computer (Perplexity), session 2026-04-26
**Status**: Design — awaiting scaffolding PR
**Scope**: Quarter-scale; this doc covers the additive scaffolding PR (Phase 0) and Phases 1–3 that follow. Phase 0 ships in this session.
**Codebase**: `MrRayG/agent306-dashboard`
**Companion docs**: `IMAGE_VS_AGENT306_GAP_ANALYSIS.md` §C, `GAP_A_CALIBRATED_CONFIDENCE_DESIGN.md` (parallel quarter-scale work).

---

## 1 · Problem statement

Per the gap analysis (§C), Agent 306 today is heavily exploitation-biased:

- Hard-coded 20-hour goal cooldowns.
- Deterministic engine schedules in `scheduler/registry.ts`.
- Every model choice is a static entry in `modelRouter.TIER_MAP`.
- Every improvement requires operator-introduced changes through the self-rec flow.

The diagram (IMG_2663 §7) calls out exploration as foundational for autonomous improvement: "exploration helps discover better strategies; policies evolve over time for improved decision-making." Today, Agent 306 has no mechanism to *propose its own variants and grade them against baseline*.

The `risk: "low"` hard-code in `selfEvolutionEngine.bridgeInsightsToSelfRecs` (audit HIGH #3) means even the existing self-rec flow is friction-mismatched. **Gap C deliberately routes around that bug** by calling `proposeRecommendation` directly with explicit risk on model-router experiments — so Gap C does not depend on HIGH #3 being fixed first.

## 2 · What this doc designs

A four-phase rollout. **This session ships only Phase 0** (additive scaffolding behind a flag, no live experiment registered, no behavior change to the LLM dispatch path).

| Phase | Scope | Behavior change | Phase gate |
|---|---|---|---|
| **0 · Scaffolding** | new tables + `runExperiment()` helper + flagged `resolveTask` interception + tests | none (flag default OFF, no experiment registered) | this session |
| **1 · First experiment** | register one `routine`-tier model A/B in `scheduler/registry.ts`; flip flag on staging | 10% of `routine` tier calls go to a treatment model | after Phase 0 review + 24h staging soak |
| **2 · Promote** | `analyzeExperiments()` cron writes results; auto-opens draft self-rec via `proposeRecommendation` (explicit `risk: "medium"`); Mission Control panel | adds promotion path; operator still approves | ≥30 days OR ≥100 trials per experiment |
| **3 · Expand surfaces** | additional experiment surfaces (prompt phrasing, scheduling cadence, dispatch parameters) | wider exploration | only after Phase 2 has produced ≥1 successful promotion cycle |

Phase 3 is intentionally far away. Per the user's invariant ("don't break what's not broken"), every phase requires explicit operator approval to flip flags.

---

## 3 · Schema (Phase 0)

Two new sqlite tables in `shared/schema.ts`, both purely additive. We follow the project convention from Gap A — Drizzle declarations in `shared/schema.ts` plus `CREATE TABLE IF NOT EXISTS` in `server/db.ts`.

### 3.1 `experiments`

Configuration table — one row per registered experiment. Read by the runtime helper.

```ts
export const experiments = sqliteTable("experiments", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  experimentKey:  text("experiment_key").notNull().unique(),  // e.g. "model-router-routine-v1"
  surface:        text("surface").notNull(),                  // "modelRouter" | "prompt" | "schedule" (Phase 0: always modelRouter)
  taskKey:        text("task_key").notNull(),                 // when surface=modelRouter: the task name to intercept
  baseline:       text("baseline").notNull(),                 // JSON-encoded baseline config (e.g. {"model":"google/gemini-3-flash-preview","provider":"openrouter"})
  treatment:      text("treatment").notNull(),                // JSON-encoded treatment config
  trafficPct:     real("traffic_pct").notNull().default(0.1), // fraction routed to treatment (0.0..1.0)
  metricKey:      text("metric_key").notNull(),               // identifier of the metric we'll grade against (Phase 2 reads this)
  startedAt:      text("started_at").notNull(),
  endedAt:        text("ended_at"),                           // null while running
  status:         text("status").notNull().default("running"),// "running" | "ended" | "promoted" | "rolled-back"
  notes:          text("notes"),
  createdAt:      text("created_at").notNull().default(new Date().toISOString()),
});
```

Indexes:
- `(experimentKey)` — uniqueness already implied by column constraint
- `(status, surface)` — for the active-experiment lookup hot path
- `(taskKey)` — to short-circuit `runExperiment` lookup

### 3.2 `experiment_trials`

Append-only fact table — one row per assignment. Phase 0 writes only `surface="modelRouter"` rows from the `resolveTask` interception. Phase 2 reads it.

```ts
export const experimentTrials = sqliteTable("experiment_trials", {
  id:              integer("id").primaryKey({ autoIncrement: true }),
  experimentKey:   text("experiment_key").notNull(),
  arm:             text("arm").notNull(),                     // "baseline" | "treatment"
  taskKey:         text("task_key").notNull(),
  resolvedModel:   text("resolved_model").notNull(),          // the model actually chosen for this call
  contextHash:     text("context_hash"),                      // null in Phase 0; reserved for stratified analysis
  outcomeMetric:   real("outcome_metric"),                    // null until Phase 2 grades it
  outcomeRecordedAt: text("outcome_recorded_at"),
  recordedAt:      text("recorded_at").notNull().default(new Date().toISOString()),
});
```

Indexes:
- `(experimentKey, arm)` — Phase 2 aggregation
- `(experimentKey, recordedAt)` — windowed analysis

### 3.3 Why two tables, not one

`experiments` is mutable (status, endedAt, notes); `experiment_trials` is append-only. Joining a mutable config table to an append-only fact table is the standard analytics shape and lets Phase 2 cleanly express queries like "for experiments where status='running', count baseline vs treatment for the last 30 days."

---

## 4 · Runtime helpers (Phase 0)

### 4.1 `runExperiment(taskKey)` — the assignment helper

Returns the arm assignment for a given task call. Pure (no LLM, no I/O beyond the trial write):

```ts
// server/experiments/runExperiment.ts
export interface ExperimentAssignment {
  experimentKey: string | null;   // null when no experiment active for this task
  arm: "baseline" | "treatment";
  resolvedModel: string;          // the model to actually use
  resolvedProvider: string;
}

export function runExperiment(taskKey: string): ExperimentAssignment | null {
  if (!featureFlags.experimentExploration) return null;     // flag off → no-op
  const exp = lookupActiveExperimentForTask(taskKey);       // small in-memory cache; refreshed on registry update
  if (!exp) return null;                                    // no experiment for this task
  const arm: "baseline" | "treatment" = Math.random() < exp.trafficPct ? "treatment" : "baseline";
  const cfg = JSON.parse(arm === "treatment" ? exp.treatment : exp.baseline);
  recordTrial({ experimentKey: exp.experimentKey, arm, taskKey, resolvedModel: cfg.model });
  return {
    experimentKey: exp.experimentKey,
    arm,
    resolvedModel: cfg.model,
    resolvedProvider: cfg.provider,
  };
}
```

`recordTrial` is a try/catch wrapper that writes to `experiment_trials` and swallows errors (calibration-style — must never break the dispatch path).

### 4.2 `resolveTask` interception — the single touch site

The entire Gap C dispatch hook is **3 lines** added to `server/modelRouter.ts:resolveTask()`:

```ts
export function resolveTask(task: string): { tier: TaskComplexity; provider: RouteProvider; model: string } {
  // Gap C Phase 0 — exploration assignment (flag-gated, no-op when flag off)
  const assignment = runExperiment(task);
  if (assignment) return { tier: "routine" as TaskComplexity, provider: assignment.resolvedProvider as RouteProvider, model: assignment.resolvedModel };
  // ... existing logic unchanged below ...
}
```

Critical properties:
- When `featureFlags.experimentExploration === false` (default), `runExperiment` returns `null` immediately — zero change.
- When flag is on but no experiment is registered for `task`, `runExperiment` returns `null` — zero change.
- When an experiment is registered, the assignment fetches the right model from JSON; the rest of the dispatch pipeline (`callLLM`, retries, observability) is unchanged.
- The `tier` we hand back when overriding is `"routine"` — this matches the surface we're starting with. A future Phase 3 surface that experiments on `frontier-factual` would need a small extension here, but Phase 0 doesn't need that.

### 4.3 `registerExperiment()` — admin write helper

Used by Phase 1 (registers via a one-shot script), and later by Phase 2 (promotes a treatment to baseline by ending the current experiment + opening a draft self-rec).

```ts
export interface RegisterExperimentInput {
  experimentKey: string;
  surface: "modelRouter";  // Phase 0 only supports this
  taskKey: string;
  baseline: { model: string; provider: string };
  treatment: { model: string; provider: string };
  trafficPct?: number;     // default 0.1
  metricKey: string;
  notes?: string;
}

export function registerExperiment(input: RegisterExperimentInput): { ok: boolean; reason?: string };
```

Phase 0 ships this function but **does not call it anywhere** — no live experiment is registered.

### 4.4 In-memory active-experiment cache

A simple map keyed by `taskKey`, populated lazily on first call to `lookupActiveExperimentForTask`. Refresh trigger: any call to `registerExperiment` or `endExperiment` invalidates the cache. We do NOT hit the DB on every LLM call; that would defeat the purpose. The cache is per-process; Agent 306 is single-process so this is fine. Documented inline.

---

## 5 · Statistical math (Phase 2 — pre-planned, not shipped in Phase 0)

For sequencing clarity. Phase 0 does not ship any of this.

### 5.1 Two-sample test of proportions (binary metrics)

For binary outcome metrics (`outcomeMetric ∈ {0, 1}`), use a two-proportion z-test with continuity correction. Significance threshold: p < 0.05 (one-sided, treatment > baseline).

```
p_combined = (x_b + x_t) / (n_b + n_t)
SE = sqrt(p_combined · (1 - p_combined) · (1/n_b + 1/n_t))
z = ((x_t/n_t) - (x_b/n_b)) / SE
```

### 5.2 Welch's t-test (continuous metrics)

For continuous metrics (e.g. trust score, latency), Welch's t-test (does not assume equal variance).

### 5.3 Minimum sample size

Auto-promotion requires both:
- `n_baseline ≥ 50 AND n_treatment ≥ 50` — minimum 100 trials per experiment
- `p < 0.05`
- `(treatment_mean - baseline_mean) / baseline_mean > 0.05` — at least 5% relative improvement (avoids promoting on statistically-significant-but-meaningless deltas)

### 5.4 Promotion via existing self-rec path

When all three thresholds are met, `analyzeExperiments` calls `proposeRecommendation` directly:

```ts
proposeRecommendation({
  category: "engine",                          // routes through promotionGate
  risk: "medium",                              // EXPLICIT — sidesteps HIGH #3's hard-coded "low"
  title: `Promote treatment for ${exp.experimentKey} (Δ ${pctChange}%)`,
  rationale: `Treatment "${treatmentModel}" beat baseline "${baselineModel}" on ${exp.metricKey} (n_t=${n_t}, n_b=${n_b}, p=${p.toFixed(4)}, Δ=${pctChange.toFixed(1)}%) over ${windowDays} days.`,
  proposedChange: `Update modelRouter TIER_MAP entry for ${exp.taskKey} from ${baselineModel} to ${treatmentModel}.`,
  evidence: [exp.experimentKey, `experiment_trials@${windowEnd}`],
  author: "agent",
});
```

This produces a draft rec the operator approves — preserving the propose-only invariant — and the explicit `risk: "medium"` correctly hits the gate's medium-friction tier instead of the `risk: "low"` log-only path. Documented in the design doc: **Gap C does not depend on HIGH #3 fix landing first**.

---

## 6 · Phase 0 — what ships in this session's PR

All additive. Zero behavior change.

### 6.1 Files added

```
shared/schema.ts                                  +2 tables (experiments, experimentTrials) + zod schemas + types
server/experiments/runExperiment.ts               NEW — assignment helper + recordTrial
server/experiments/registerExperiment.ts          NEW — admin write helper + endExperiment
server/experiments/cache.ts                       NEW — lazy in-memory active-experiment cache
server/__tests__/runExperiment.test.ts            NEW — flag-off no-op, flag-on assignment distribution, no-experiment short-circuit (8 cases)
server/__tests__/registerExperiment.test.ts       NEW — register/end/duplicate-key/cache-invalidation (5 cases)
docs/EXPLORATION_POLICY.md                        NEW — design doc copy + Phase 1-3 plan
```

### 6.2 Files modified — minimal touch

```
server/featureFlags.ts            +1 flag: experimentExploration (default false; reads CALIBRATION_CAPTURE pattern → process.env.EXPERIMENT_EXPLORATION === "true")
server/modelRouter.ts             +3 lines inside resolveTask() — assignment hook (gated, no-op when flag off)
server/db.ts                      +CREATE TABLE IF NOT EXISTS for both new tables + 5 indexes (additive only)
```

### 6.3 What this PR does **not** do

- ❌ Does not turn the flag on
- ❌ Does not register any experiment
- ❌ Does not implement Phase 2 statistical analysis (`analyzeExperiments`)
- ❌ Does not surface anything to Mission Control
- ❌ Does not auto-call `proposeRecommendation`
- ❌ Does not modify `bridgeInsightsToSelfRecs` (HIGH #3 stays open and unrelated)

The interception hook is wired at exactly one site (`resolveTask`) and is a no-op when the flag is off OR when no experiment is registered for the task. Both conditions hold by default after this PR merges.

### 6.4 Production-code blast radius

- `server/modelRouter.ts`: +3 lines (one early-return assignment block)
- `server/db.ts`: ~25 lines (additive DDL + indexes)
- `server/featureFlags.ts`: +1 line (the flag)
- Total: **~4 lines of behavior-affecting code**, all flag-gated.

---

## 7 · Phase 1 plan — First live experiment (next PR after Phase 0)

1. Choose treatment model: a sibling `routine`-tier model. Candidates: a different Gemini variant, or a comparable openrouter model. Phase 1 PR proposes it; operator picks before merge.
2. Register experiment in `scheduler/registry.ts`'s `startScheduler` boot path (one-shot idempotent call to `registerExperiment` keyed by `experimentKey`).
3. `metricKey` for the first experiment: `routine_task_json_validity` — % of responses that parse as valid JSON via `safeParseLLMJson`. This is a binary metric, computed at the call site that handles `routine` outputs (one site; Phase 1 wires the metric write into that site).
4. Flip `EXPERIMENT_EXPLORATION=true` on staging only.
5. Soak 24h. Watch `engine_events` for any errors.
6. Flip prod.

Exit criteria: 7 days of clean trials; both arms accumulate ≥20 trials; no errors.

## 8 · Phase 2 plan — Analyze + promote (next PR after Phase 1 stable)

1. New cron `analyzeExperimentsCron` — weekly, Sundays 09:00 UTC (parallel slot to Gap A's calibration cron).
2. For each `status=running` experiment with ≥100 trials and ≥30 days runtime: run §5 statistical tests.
3. If thresholds met: call `proposeRecommendation` per §5.4. Mark experiment `status="promoted"` (terminal; experiment stops running). The actual `TIER_MAP` change happens only when the operator approves the rec.
4. New Mission Control panel `/admin/experiments`: list active experiments + sample sizes + p-values. Per-experiment timeseries.

## 9 · Phase 3 plan — Expand surfaces (far future)

`surface` extensions to `prompt` (A/B prompt phrasings on a single task) and `schedule` (A/B scheduling cadence on an engine slot). Each surface needs its own interception point but reuses the same `experiments` + `experiment_trials` schema. Out of scope for this design doc beyond noting the schema is built to extend.

---

## 10 · Risks & non-goals

### Risks
- **Single-process cache assumption.** The active-experiment cache is per-process. Agent 306 today is single-process; if that ever changes, the cache becomes stale across processes. Documented inline; mitigated by short cache TTL (60s) AND explicit invalidation on `registerExperiment`/`endExperiment`. For Phase 0 this is a non-issue because no experiment is registered.
- **`outcomeMetric` write-path doesn't exist yet.** Phase 0's `experiment_trials` rows have `outcomeMetric=null`. Phase 1 wires the metric write at the call site. Until then, the table is just trial-count data. This is intentional sequencing.
- **`Math.random()` is not statistically rigorous for tiny `trafficPct`.** For 10% rollout it's fine; if Phase 3 ever wants 1% canary surfaces we'll need a hash-based assignment for stability. Not a Phase 0 concern.
- **HIGH #3 (`risk:"low"` hard-code) is unrelated.** Gap C's promotion path explicitly passes `risk: "medium"` directly to `proposeRecommendation`, bypassing `bridgeInsightsToSelfRecs`. HIGH #3 should still be fixed for the *insights* path; Gap C just doesn't depend on it.

### Non-goals
- ❌ **Multi-armed bandit.** Pure 90/10 split for Phase 0/1. Bandit logic (Thompson sampling, ε-greedy) is Phase 4+ if ever.
- ❌ **Stratified assignment.** All assignment is unstratified `Math.random() < trafficPct`. Phase 3 may revisit if domain skew emerges.
- ❌ **Real-time stats panels.** Phase 2's Mission Control panel reads from the weekly cron's results table, not live trials.
- ❌ **Surface support beyond `modelRouter`.** Phase 0 ships the schema column to allow it later; the runtime only handles `modelRouter`.

---

## 11 · Sign-off checklist for Phase 0 PR

- [ ] Schema declarations added to `shared/schema.ts`; `CREATE TABLE IF NOT EXISTS` added to `server/db.ts`
- [ ] Both tables + indexes created on a fresh DB boot (verified)
- [ ] `runExperiment` unit tests cover all 4 branches (flag off, flag on no exp, flag on baseline, flag on treatment)
- [ ] `registerExperiment` unit tests cover register, end, duplicate key, cache invalidation
- [ ] `resolveTask` modification is exactly 3 lines; no other modelRouter changes
- [ ] `featureFlags.experimentExploration` defaults false
- [ ] No new env vars required (flag defaults false in code)
- [ ] No imports from `client/` or `dist/`
- [ ] PR title prefix `feat(experiments)` and body links this design doc + gap analysis
- [ ] Note in PR body: "Flag is OFF. No experiment is registered. Phase 1 (register first experiment + flip flag on staging) is a separate future PR."

---

End of design.
