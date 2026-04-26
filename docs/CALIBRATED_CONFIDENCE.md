# Gap A — Calibrated Confidence Design Doc

**Author**: Computer (Perplexity), session 2026-04-26
**Status**: Design — awaiting scaffolding PR
**Scope**: Quarter-scale; this doc covers the additive scaffolding PR (Phase 0) and Phases 1-3 that follow.
**Codebase**: `MrRayG/agent306-dashboard`

---

## 1 · Problem statement

Per the gap analysis (`IMAGE_VS_AGENT306_GAP_ANALYSIS.md` §A), Agent 306 emits a `Hypothesis.evaluationResult.confidence` (0-1) and a `Hypothesis.trustScore` (0-100) at evaluation time. Neither is currently graded against the eventual outcome. As a result:

- Two hypotheses scored 0.85 are treated identically even if one of the underlying models is consistently overconfident (predicts 0.85 → only 0.55 of those resolve "confirmed") and another is well-calibrated.
- `modelRouter` weights cannot reflect calibration quality because the data does not exist.
- The Mission Control narrative around "we have a Trust-Score" is correct but unverifiable at the system level.

The diagram (IMG_2663 §7) calls this out as a missing piece: probabilistic decisions require calibrated likelihoods, not raw scalars.

## 2 · What this doc designs

A four-phase rollout. **This session ships only Phase 0** (additive scaffolding behind a flag, no behavior change). Phases 1-3 are sequenced after — each is its own PR.

| Phase | Scope | Behavior change | Phase gate |
|---|---|---|---|
| **0 · Scaffolding** | new table + helpers + flagged write hook + disabled cron skeleton | none | this session |
| **1 · Capture** | flip flag on; start writing rows from `resolveHypothesis()` | additive only — no read path uses the data | after Phase 0 review + 24h staging soak |
| **2 · Score** | weekly cron computes Brier + log-loss; writes to `model_calibration_scores`; surfaces on Mission Control | adds a read panel; no decision-loop wiring | ≥30 days of Phase 1 data |
| **3 · Reweight** | `modelRouter` consults Brier when picking models for hypothesis evaluation | feedback loop closed; behind another flag | ≥60 days of Phase 2 data + operator approval |

The Phase 3 wiring is intentionally far away. Per the user's invariant, we don't break what isn't broken.

---

## 3 · Schema (Phase 0)

Two new sqlite tables in `shared/schema.ts`. Both purely additive.

### 3.1 `hypothesis_outcomes`

Append-only fact table. One row per resolved hypothesis. Resolution data is duplicated from `research_lab.blob` so we can aggregate without loading the entire blob.

```ts
export const hypothesisOutcomes = sqliteTable("hypothesis_outcomes", {
  id:                  integer("id").primaryKey({ autoIncrement: true }),
  hypothesisId:        text("hypothesis_id").notNull(),                  // matches Hypothesis.id
  predictedConfidence: real("predicted_confidence").notNull(),           // 0..1, normalized at write time
  predictedTrustScore: real("predicted_trust_score"),                    // 0..100; null for legacy
  originatingModel:    text("originating_model"),                        // e.g. "grok-4.20-reasoning"; null for legacy
  resolvedAt:          text("resolved_at").notNull(),                    // ISO; mirrors hyp.resolvedAt
  resolutionStatus:    text("resolution_status").notNull(),              // "confirmed"|"rejected"|"expired"|"data-unavailable"|"stale-retired"|"awaiting-deadline"
  actualOutcome:       integer("actual_outcome", { mode: "boolean" }).notNull(), // confirmed=true; rejected=false; others=null is NOT allowed (see §3.3)
  outcomeWeight:       real("outcome_weight").notNull().default(1.0),    // 0.0 for non-graded resolutions; 1.0 otherwise
  outcomeSource:       text("outcome_source").notNull(),                 // "auto-resolve"|"debate"|"rubric"|"manual"|"deadline-expiry"
  domain:              text("domain"),                                   // "ai-news"|"regulatory"|"foundational"|"unknown"
  recordedAt:          text("recorded_at").notNull().default(new Date().toISOString()),
});
```

Indexes (added in migration):
- `(originatingModel, resolvedAt)` — per-model rollup
- `(domain, resolvedAt)` — per-domain rollup
- `(resolvedAt)` — windowed queries

### 3.2 `model_calibration_scores`

Computed by Phase 2's weekly cron. Idempotent per `(model, windowEndDate, windowDays)` triple.

```ts
export const modelCalibrationScores = sqliteTable("model_calibration_scores", {
  id:             integer("id").primaryKey({ autoIncrement: true }),
  model:          text("model").notNull(),
  windowDays:     integer("window_days").notNull(),                      // 7, 30, 90
  windowEndDate:  text("window_end_date").notNull(),                     // ISO date (no time)
  sampleCount:    integer("sample_count").notNull(),
  brierScore:     real("brier_score"),                                   // null if sampleCount < threshold
  logLoss:        real("log_loss"),                                      // null if any predictions out of (0,1) after clipping
  meanConfidence: real("mean_confidence"),
  meanOutcome:    real("mean_outcome"),
  computedAt:     text("computed_at").notNull().default(new Date().toISOString()),
});
```

Unique index on `(model, windowDays, windowEndDate)` so re-runs upsert.

### 3.3 Outcome semantics — what counts as a graded resolution

Decision rule for `outcomeWeight` and `actualOutcome` at write time:

| `Hypothesis.status` at resolution | `actualOutcome` | `outcomeWeight` | Counted in Brier? |
|---|---|---|---|
| `confirmed` | `true` | 1.0 | ✅ |
| `rejected` | `false` | 1.0 | ✅ |
| `expired` (passed deadline, evidence inconclusive) | `false` | 0.5 | partial |
| `data-unavailable` | `false` | 0.0 | ❌ (excluded from scoring) |
| `stale-retired` | `false` | 0.0 | ❌ |
| `awaiting-deadline` | — | — | not written (terminal-only writes) |

Rationale: an `expired` hypothesis means the prediction did not pan out within its timeframe — that is informative but weaker signal than a true confirmed/rejected. `data-unavailable` and `stale-retired` are *system* failures, not prediction failures, and must not penalize the model. The weighted Brier formula in §4.2 handles `outcomeWeight`.

We write a row even for `outcomeWeight = 0` rows so that Phase 2 can report "% of hypotheses we never got to grade" as a signal of pipeline health.

---

## 4 · Math

### 4.1 Brier score (binary, weighted)

Per the standard binary-Brier definition with a per-row weight:

```
Brier = (Σ w_i · (p_i - y_i)²) / (Σ w_i)
```

where `p_i = predictedConfidence`, `y_i = 1 if actualOutcome else 0`, `w_i = outcomeWeight`.

Lower is better. Perfect calibration = 0; always-wrong = 1; uniform 0.5 prediction = 0.25.

### 4.2 Log-loss (binary, weighted, ε-clipped)

```
ε = 1e-6
p_clip = clip(p_i, ε, 1 - ε)
LogLoss = -(Σ w_i · (y_i · ln(p_clip) + (1 - y_i) · ln(1 - p_clip))) / (Σ w_i)
```

Reported only if `min(predictedConfidence) > ε` and `max(predictedConfidence) < 1 - ε` *after clipping* (sanity check that data is in range). Otherwise `null` with a debug log.

### 4.3 Sample-count threshold

Brier and LogLoss are written as `null` if `sampleCount < 20` for that `(model, windowDays)` cell. Avoids spurious "best model" rankings on 2-sample windows.

### 4.4 Confidence normalization at write time

The codebase has three concurrent confidence-shaped values:

- `Hypothesis.confidence` — categorical "high"/"medium"/"low"
- `Hypothesis.evaluationResult.confidence` — numeric 0..1 (the canonical signal)
- `Hypothesis.trustScore` — 0..100

Phase 0 helper `normalizeConfidence(hyp)` precedence:

1. If `hyp.evaluationResult?.confidence` exists and is `0..1`, use it as `predictedConfidence`.
2. Else if `hyp.trustScore` exists, use `trustScore / 100`.
3. Else map categorical: `high → 0.85`, `medium → 0.6`, `low → 0.3`.
4. Always also write `predictedTrustScore = trustScore ?? null`.

The mapping in (3) is documented inline as a fallback, not a source of truth — the goal is to avoid losing legacy resolutions, not to claim those are calibrated.

---

## 5 · Phase 0 — what ships in this session's PR

All additive. Zero behavior change.

### 5.1 Files added

```
shared/schema.ts                                  + 2 tables, + 4 types
server/calibration/hypothesisOutcomes.ts          NEW — repo-style read/write helper
server/calibration/normalizeConfidence.ts         NEW — pure helper + tests
server/calibration/computeCalibration.ts          NEW — pure Brier/log-loss helper + tests (unwired)
server/calibration/calibrationCron.ts             NEW — cron entry point, GUARDED by flag, default OFF
server/__tests__/calibrationNormalize.test.ts     NEW — 6 cases
server/__tests__/calibrationCompute.test.ts       NEW — 8 cases (golden numbers)
server/__tests__/hypothesisOutcomesWrite.test.ts  NEW — verifies write hook is no-op when flag is OFF
docs/CALIBRATED_CONFIDENCE.md                     NEW — design doc copy + Phase 1-3 plan
```

### 5.2 Files modified — minimal touch

```
server/researchEngine.ts          + 4 lines: import recordOutcome; call it INSIDE the success branch of resolveHypothesis(), wrapped in try/catch and gated by featureFlags.calibrationCapture
server/featureFlags.ts (new file) + 1 flag: calibrationCapture (default false)
server/index.ts                   + 1 conditional: register calibrationCron only if flag on (default off)
```

That is the entire production-code footprint: **5 lines of behavior code**, all flag-gated.

### 5.3 Migration

Drizzle migration generated alongside. Migrations are already wired through `migrationGuard` (per audit CRITICAL #1's PR #225) so the additive ALTERs flow through the same orphaned-engine fallback path.

### 5.4 What this PR does **not** do

- ❌ Does not turn the flag on
- ❌ Does not register any cron schedule
- ❌ Does not surface anything to Mission Control yet
- ❌ Does not touch `modelRouter`
- ❌ Does not modify `Hypothesis` interface (the `originatingModel` field can wait — it requires write-site changes throughout the pipeline that are out of scope for scaffolding)

The capture hook is wired at exactly one site (`resolveHypothesis`) and is a no-op when the flag is off. If someone reads `hypothesis_outcomes` before Phase 1 flips the flag, they get an empty table — which is correct.

---

## 6 · Phase 1 plan — Capture (this PR)

Phase 1 is shipped as additive code only. The flag remains OFF in code; the
operator enables it per-deploy via `CALIBRATION_CAPTURE=true`. The runbook
below is the rollout sequence after merging.

### 6.1 What Phase 1 ships

- `originatingModel` field on `Hypothesis` (and `HypothesisAssessment`),
  populated at the canonical `evaluateHypothesis` write site by a new
  sibling helper `callGrokWithModelMeta` in `reasoningEngine.ts`. The
  existing `callGrokWithModel` is unchanged; its 7 other callers are
  unaffected.
- `recordOutcome` now reads `hyp.originatingModel` instead of always
  writing `null`.
- `server/calibration/backfillOutcomes.ts` — idempotent operator script
  that walks `research_lab.blob` and writes one `hypothesis_outcomes`
  row per terminally-resolved hypothesis. Skips rows that already exist
  by `(hypothesisId, resolvedAt)`. Bypasses the capture flag — it's a
  manual tool, not the on-resolution hook.

### 6.2 Runbook — staging then production

1. Merge this PR.
2. On the **staging** deployment env: set `CALIBRATION_CAPTURE=true`. Restart.
3. Run `npm run calibration:backfill` once on staging. Confirm the count
   summary printed at the end is sane (`scanned` should match the
   number of resolved hypotheses in `research_lab`).
4. Watch logs for **24h**. Look for any `[calibration] recordOutcome failed`
   warnings. None expected.
5. After a daily cycle has run, query `hypothesis_outcomes` count; it
   should match the number of new resolutions in that cycle.
6. If clean: set `CALIBRATION_CAPTURE=true` on **prod**. Restart.
   Run `npm run calibration:backfill` on prod.
7. Open the Phase 2 PR (cron + scoring + Mission Control panel).

### 6.3 Rollback

Set `CALIBRATION_CAPTURE=false` and restart. The hook becomes a no-op
immediately. Existing rows in `hypothesis_outcomes` remain — additive
data, safe to leave. To purge:

```sql
DELETE FROM hypothesis_outcomes;
```

You almost certainly don't want to. Phase 2 will read this data, and
losing the backfill means re-running it.

### 6.4 Environment variables

| Var | Default | Effect |
|---|---|---|
| `CALIBRATION_CAPTURE` | `false` | When `true`, `resolveHypothesis()` writes one row to `hypothesis_outcomes` per terminally-resolved hypothesis. The on-resolution write site is the only consumer of this flag. The backfill script bypasses it. |

### 6.5 Exit criteria for moving to Phase 2

- 7 days of clean writes — no `[calibration] recordOutcome failed` warnings
- `recentEvents` (correctly filtering after PR #227) shows expected volume
- `hypothesis_outcomes` row count growth matches `research_lab` resolution
  cadence over those 7 days

## 7 · Phase 2 plan — Score (next PR after Phase 1 stable)

1. Wire `calibrationCron` to the engine-runner registry. Schedule: weekly, Sundays 09:00 UTC.
2. Compute three windows per model: 7d, 30d, 90d. Upsert into `model_calibration_scores`.
3. New Mission Control panel `/admin/calibration`: per-model Brier table sorted ascending; per-domain Brier as a secondary cut.
4. New `recentEvents` engine ID `calibrationCron` so failures are observable.

Exit criteria: ≥30 days of capture data; Brier scores stable across two consecutive runs; operator review of the panel.

## 8 · Phase 3 plan — Reweight (far future, separate approval)

`modelRouter` reads `model_calibration_scores` (90d window) and applies a small additive weight (e.g., +5 router-points for the model with the lowest Brier in the relevant task family, capped). New flag `featureFlags.calibrationReweight`. Default off. Requires explicit operator turn-on.

This is the only phase that can change behavior outside calibration storage. It is intentionally far in the future and out of scope for the design doc beyond noting it exists.

---

## 9 · Risks & non-goals

### Risks
- **Confidence normalization fallback is lossy.** The categorical → numeric map in §4.4 (3) is a convention, not a calibration. Documented in code so nobody mistakes it for ground truth.
- **`expired` weighting is debatable.** We chose `weight=0.5, outcome=false`. An expired hypothesis with `confidence: 0.9` is still informatively wrong, just less so than a clear rejection. Could revisit after Phase 2 data lands.
- **Model attribution is best-effort.** Legacy hypotheses lack `originatingModel`. They count toward the global Brier but not per-model. We accept this; the per-model rollup just becomes useful gradually as new resolutions accumulate.

### Non-goals
- ❌ Calibrating `Hypothesis.confidence` (categorical) directly. The numeric `evaluationResult.confidence` is the canonical signal.
- ❌ Multi-class outcomes. Binary only — confirmed vs not. Multi-class adds complexity without payoff at this scale.
- ❌ Replacing `trustScore`. Trust-Score is a quality-during-production signal; calibration is a post-hoc grade. They coexist.

---

## 10 · Sign-off checklist for Phase 0 PR

- [ ] Schema migration generated and applies cleanly on a fresh DB
- [ ] `normalizeConfidence` unit tests cover all 4 fallback branches
- [ ] `computeCalibration` unit tests verify against hand-computed golden numbers
- [ ] `recordOutcome` is no-op when flag off (test exists)
- [ ] No imports from `client/` or `dist/`
- [ ] No new env vars required (flag defaults false in code)
- [ ] PR title prefix `feat(calibration)` and body links this design doc + gap analysis

---

End of design.
