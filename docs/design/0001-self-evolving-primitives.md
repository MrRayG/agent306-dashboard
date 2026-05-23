# 0001 — Self-Evolving Primitives Architecture

| Field        | Value                                                                                   |
|--------------|-----------------------------------------------------------------------------------------|
| Doc ID       | 0001                                                                                    |
| Status       | **DRAFT — pending review**                                                              |
| Owner        | MrRayG (rgill003@gmail.com)                                                             |
| Drafted      | 2026-05-23                                                                              |
| Target PR    | #417 (to be opened after this design doc merges)                                        |
| Relates to   | PR #412 (Reasoning Quality v2.6), PR #414 (KB ratio gate primitive), PR #416 (Phase 3a-prep attestations) |
| Audience     | Operator (MrRayG), future reviewers, future verifier modules                            |
| Scope        | **DOCUMENTATION ONLY.** No code change in this PR. No server/ files touched.            |

> This document describes the **plan** for PR #417. It is **not** the implementation. The implementation PR
> (#417) will follow after operator sign-off on this doc. Every section below names code that **will** change
> but does not change it here.

---

## 1. Problem statement — the loop is eating its own tail

Agent 306 correctly diagnoses its operational gaps and proposes fixes — but the rec engine can only emit
prose action text, and the translator (`server/actionTranslator.ts`) only recognises a fixed set of six
forcing primitives (`ratio_rule`, `ttl_rule`, `gate_rule`, `archive_rule`, `artifact_rule`,
`verification_rule`) plus a non-forcing `rewrite_rule` (see header comment at
`server/actionTranslator.ts:1–54`). When an action proposes a **new** primitive family that doesn't exist
(`ttl`, `gate`, etc., as *primitive definitions* rather than *primitive uses*), the translator falls through
to `none` and emits `reason: "No primitive matched action"` at
`server/actionTranslator.ts:832–838`. The rec then sits forever, because the fix for the missing primitive
requires a **human to write TypeScript and ship a PR**.

### 1.1 Today's cycle (2026-05-23T11:41:01Z) — direct evidence

Verbatim from the live cycle log:

- `[Competency] Self-Integrity: 3.2 → 3 ([self-evolution] Four broken self-change commitments firing 10-15x with zero side effects is direct evidence of integrity failure — I commit to changes I don't execute. Honest downgrade warranted.)`
- `[Competency] Critical Thinking & Problem-Solving: 7.6 → 7.7 ([self-evolution] The diagnosis of WHY commitments fail (observational rules vs. operational mechanisms) is sharper this cycle than previous cycles.)`
- `[Competency] Content Strategy: 2.1 → 2`
- `[SelfEvolution] Diff appended — 4 hypothesis changes, 47 KB added, 8 pruning suggestions`

Three new self-recs proposed at 7:41:01 AM EDT:

| Rec ID                          | Family                                | Status          |
|---------------------------------|---------------------------------------|-----------------|
| `rec_1779534403884_yyywag`      | archive-debt (3rd consecutive cycle)  | proposed        |
| `rec_1779534403888_4yfprs`      | KB-accumulation (47 added / 0 archived) | proposed     |
| `rec_1779534403889_hcfqvt`      | dream insights stagnating (CS 2.1 → 2) | proposed       |

### 1.2 Yesterday's apply path — the smoking gun

Four of five `fully_prepared` recs from yesterday's apply path registered **no rule** because the action
text named a primitive that does not yet exist. The translator emits `reason: "untranslatable"` at
`server/selfRecommendationEngine.ts:438` via `maybeRegisterRuleForRecommendation` (line 401–470):

| Rec ID                       | Source insight              | Action text (extracted)                                                                            | Translator outcome |
|------------------------------|-----------------------------|-----------------------------------------------------------------------------------------------------|--------------------|
| `rec_1779362735356_uld3zy`   | `evo_1779362735301_kihp`    | (untranslatable)                                                                                    | `untranslatable`   |
| `rec_1779362735353_oirek5`   | `evo_1779362735301_ebcw`    | (untranslatable)                                                                                    | `untranslatable`   |
| `rec_1779447024967_vqh06n`   | `il_1779362735348_p7du`     | "Add a `gate` enforcement primitive (block X until Y holds)."                                       | `untranslatable`   |
| `rec_1779447024953_tzdxk0`   | `il_1779362735348_vbh8`     | "Add a `ttl` enforcement primitive (expire items after N days without state change)."              | `untranslatable`   |

Both of those action strings are the **literal output** of
`describeMissingPrimitiveFamily()` at `server/actionTranslator.ts:1037–1051`. Agent 306 is asking for
new primitives in the exact words the system writes when it can't translate. The system then refuses
to translate its own words.

### 1.3 Open obligations — advisory only, gathering refresh counts

Per the live cycle:

- Open obligation `oblg_5ef74bb3104b7691` — `draft_output_artifact` deficit 308, required=10, refreshed **9** times, **advisory only**.
- Open obligation `oblg_9a9f8a52bf8a3bd3` — `archived` deficit 162, required=10, refreshed **19** times, **advisory only**, dedupes 3 source rules.

`server/ruleCorrectiveObligations.ts:459` says verbatim:
> `"This is not a hard block — KB writes are not gated by this …"`

### 1.4 Frame

She correctly diagnoses ("Four broken self-change commitments firing 10-15x with zero side effects is direct
evidence of integrity failure"). She correctly proposes (`Add a gate primitive…`, `Add a ttl primitive…`).
She would correctly approve the fix. **The translator is the limit, because the fix requires
human-written TypeScript.** This PR proposes the three architectural moves that lift that limit *without*
breaking the single-write-site promotion boundary (Pin 11) or opening any public-action surface (Pin 7).

---

## 2. Three architectural moves

### Move 1 — `define_primitive` meta-primitive

A new translator branch that recognises action text whose semantics are **"register a new primitive family"**
and parses it into a structured primitive contract instead of emitting `none` with
`reason: "No primitive matched action"`.

#### 2.1.1 Primitive contract shape (JSON-Schema-style)

```jsonc
// PrimitiveContract — written into the new primitive_registry table.
{
  "name":          "ttl",                                      // family identifier, lowercase, [a-z_]+
  "family":        "ttl",                                      // same as name OR a sub-family of an existing one
  "actionShape": {
    "regex_or_keywords": ["expire items after N days", "ttl primitive"],
    "requiredFields":    ["days", "target"]
  },
  "sideEffectSpec": {
    "kind":   "tick_observation",                              // observation | corrective_obligation | gate | rewrite
    "target": "kb_entry",
    "op":     "log_deficit",
    "args":   { "thresholdDays": 14 }
  },
  "envFlag":            "PRIMITIVE_TTL_ENABLED",               // operator-controlled, default false
  "dryRunCycles":       3,                                     // observe-only cycles before side effects activate
  "observabilityProbe": { "eventName": "primitiveTtlWouldFire", "engine": "actionEnforcer" }
}
```

#### 2.1.2 New table — `primitive_registry`

Sqlite-compatible, matching the convention in `shared/schema.ts` (text PK, `text` columns, JSON-encoded
arrays, ISO-8601 `created_at`). Full statement in §4.

#### 2.1.3 New translator branch

`server/actionTranslator.ts` gains an additional pass after `REWRITE_PATTERNS` (which is currently the last
loop, lines 806–830) and **before** the final fall-through return at lines 832–838. Action text whose shape
matches the `define_primitive` parser (e.g. begins with `Add a`, contains `primitive`, AND
`classifyMissingPrimitiveFamily(actionText)` at line 962 returns something other than `"other"`) is
parsed into a `PrimitiveContract` and the translator returns
`{ primitive: "define_primitive", params: { contract }, ... }` instead of `{ primitive: "none", reason }`.

The existing six families' shapes (`RATIO_PATTERNS` 71–116, `TTL_PATTERNS` 118–139, `GATE_PATTERNS` 141–248,
`ARCHIVE_PATTERNS` 250–267, `ARTIFACT_PATTERNS` 278–350, `VERIFICATION_PATTERNS` 362–397,
`VERIFICATION_SCAFFOLD_PATTERNS` 410–417, `SPECTRUM_PATTERNS` 423–426, `REWRITE_PATTERNS` 437–469) are
**not modified**. The `define_primitive` branch is a strict superset — it only catches action text that
*today* falls through to `none`.

#### 2.1.4 Three-cycle dry-run requirement

Every newly registered primitive runs `dryRunCycles` (default 3) **observe-only** cycles. During dry-run the
action enforcer logs `primitive<Name>WouldFire` events but registers **no** side effects, opens **no**
corrective obligations, and gates **no** transitions. Only after the dry-run window closes AND
`PRIMITIVE_REGISTRY_ENABLED=true` AND the per-primitive env flag (`PRIMITIVE_<NAME>_ENABLED=true`) does
the primitive become eligible to register real `ActionEnforcer` rules via
`registerRuleFromInsight` (`server/actionTranslator.ts:1059–1076`).

#### 2.1.5 Approve path unchanged

The operator still calls `approveRecommendation` → `applyRecommendation` exactly as today
(`server/selfRecommendationEngine.ts:235`, `:292`). The single new effect: when `apply` succeeds AND
the rec's translation yields `primitive === "define_primitive"`, the post-apply hook
`maybeRegisterRuleForRecommendation` (lines 401–470) writes one row into `primitive_registry` and the
translator reloads its registry on next cycle. No new write site to `self_recommendations`. No new
write site for `status: "applied"`.

#### 2.1.6 Boundary preservation — `canPromote(rec).ok` unaffected

`server/eval/promotionGate.ts` is **not modified**. `canPromote` is still the single authorisation
signal. `define_primitive` recs themselves are subject to the Phase 3a-prep attestation contract from
`server/experiments/phase3aPrepHarness.ts:112–118` — the meta-primitive **eats its own dogfood** (§6).

---

### Move 2 — shape classifier on rec emit

`server/selfRecommendationEngine.ts:proposeRecommendation` (line 156) gains a single call to
`classifyRecommendationShape(input)` before `db.insert(...)` happens. The classifier routes the rec into
one of three tables:

| Shape             | Table                  | Apply button?     | Effect                                                                                   |
|-------------------|------------------------|-------------------|------------------------------------------------------------------------------------------|
| `operational`     | `self_recommendations` (existing) | Yes (existing) | Today's behavior. No change.                                                  |
| `capability_gap`  | `capability_gaps` (new) | Yes (routes to `define_primitive` flow on apply) | Operator approves → translator writes a contract into `primitive_registry`. |
| `diagnostic_only` | `diagnostic_signals` (new) | **No**          | Surfaces in the dashboard as a signal; feeds next cycle's context; cannot be applied.    |

#### 2.2.1 Classifier rules (keyword + structural heuristic at emit time)

Pure function. No DB. No LLM. Lowercases the action text, scans for cue patterns in priority order:

| Cue                                                                                                                | Classification    |
|--------------------------------------------------------------------------------------------------------------------|-------------------|
| `/\b(add|implement|create|introduce) (?:a|an) [`'\w-]+ (?:enforcement )?primitive\b/`                              | `capability_gap`  |
| `/\bimplement (?:the |a )?[a-z-]+ (?:translator|enforcement mechanism|registry|harness)\b/`                        | `capability_gap`  |
| `/\b(self-integrity is|i committed but did not execute|integrity failure)\b/`                                      | `diagnostic_only` |
| `classifyMissingPrimitiveFamily(actionText) !== "other"` AND translator returns `primitive === "none"`             | `capability_gap`  |
| anything else with an action verb that matches an existing primitive (ratio/ttl/gate/archive/artifact/verify/rewrite) | `operational` |

Fallback: classifier confidence < threshold → `operational` (preserves today's behavior as the safe
default; the existing dedupe path in `proposeRecommendation` continues to apply).

#### 2.2.2 Worked example — today's three new recs

| Rec ID                          | Action text (paraphrased from cycle log)             | Cue matched                                                          | Classification    |
|---------------------------------|------------------------------------------------------|----------------------------------------------------------------------|-------------------|
| `rec_1779534403884_yyywag`      | "Archive 10 stale KB entries…" (3rd consecutive)     | matches existing `ARCHIVE_PATTERNS` at line 250                      | `operational`     |
| `rec_1779534403888_4yfprs`      | "For every 10 new KB entries, archive at least 3…"   | matches `RATIO_PATTERNS[4]` at line 115 (PR #414)                    | `operational`     |
| `rec_1779534403889_hcfqvt`      | "Dream-insight Content Strategy 2.1 → 2 — invest in dream-loop synthesis cadence" | scaffolds a Self-Integrity-style complaint → `diagnostic_only` | `diagnostic_only` |

And yesterday's four stuck recs:

| Rec ID                       | Cue matched                                                                  | Classification     |
|------------------------------|------------------------------------------------------------------------------|--------------------|
| `rec_1779447024967_vqh06n`   | `Add a` … `enforcement primitive` (from describeMissingPrimitiveFamily 1042) | `capability_gap`   |
| `rec_1779447024953_tzdxk0`   | `Add a` … `enforcement primitive` (from describeMissingPrimitiveFamily 1041) | `capability_gap`   |
| `rec_1779362735356_uld3zy`   | (action text unavailable in this report — see §8)                            | unverified         |
| `rec_1779362735353_oirek5`   | (action text unavailable in this report — see §8)                            | unverified         |

---

### Move 3 — obligation escalation policy

Today, every `ruleCorrectiveObligations` row carries `enforcement: "advisory"` — explicitly stated at
`server/ruleCorrectiveObligations.ts:459`:
> *"This is not a hard block — KB writes are not gated by this …"*

The dashboard surfaces `refreshCount` (`server/ruleCorrectiveObligations.ts:587`) but no policy promotes
the obligation when refreshes accumulate. As of today, `oblg_9a9f8a52bf8a3bd3` has refreshed **19** times
with zero side effects.

#### 2.3.1 Escalation policy

After `N` refreshes (default `N=5`) without satisfaction, the obligation's `enforcement` field flips:

```
advisory  →  gating_proposed   (after N refreshes)
gating_proposed  →  gating_active    (after operator flips env flag)
```

#### 2.3.2 `gating_proposed` auto-generates an env flag

When the obligation enters `gating_proposed`, the tick logs a structured event
(`obligationGatingProposed`) carrying a stable env-flag name:

```
OBLIGATION_GATE_<obligationId>_ENABLED      // default FALSE
```

The flag is added to `.env.example` (documentation) on next cycle. **Nothing fires until the operator
flips it.**

#### 2.3.3 `gating_active` puts teeth in

When the operator sets `OBLIGATION_GATE_<obligationId>_ENABLED=true`, the obligation upgrades to
`enforcement: "gating_active"`. The next firing of the corresponding rule **blocks** the target add
path (e.g. `oblg_9a9f8a52bf8a3bd3` would refuse new `kb_entry` writes until 10 items are archived).

The env flag is the **only** thing that puts teeth in. Pin 7 (operator authority over public action) and
Pin 11 (single-write-site) are both preserved: the gating decision is read from `process.env` at tick
boundary, not stored as authorisation state. The operator's flip is the single source of authority.

#### 2.3.4 Mid-cycle env flag flips don't apply until next cycle boundary

Clean semantics — the tick reads the flag value at the start of its scheduling pass and uses that value
for the entire pass. Flipping the flag in the middle of a tick does **not** change behavior for the
current tick. This avoids race conditions and makes the rollback (§7) deterministic.

---

## 3. Boundary preservation analysis

For each invariant, the answer is per move. Quotes from the actual audit code are inline.

### 3.1 Pin 7 — public-action ban / scheduler ban / auto-apply ban

`server/eval/promotionBoundaryAudit.ts:51–59` declares:
> *"PROPOSE-ONLY / NON-WIDENING: the audit returns findings only. It cannot mark anything ready, cannot
> promote a recommendation, cannot enable a sandbox kind, cannot mutate the propose-only invariant."*

| Move   | Touches public action? | Touches scheduler? | Auto-applies anything? | Verdict     |
|--------|-----------------------|---------------------|------------------------|-------------|
| Move 1 | No — `define_primitive` writes only to `primitive_registry`; no posting, no scheduler hook | No | No — operator approve→apply still required | **Preserved** |
| Move 2 | No — `capability_gaps` and `diagnostic_signals` are passive tables; no surface change | No | No — `diagnostic_only` recs are **non-applyable by design** | **Preserved** |
| Move 3 | No — `gating_active` is gated by an operator-set env flag; the flip is the human action | No | No — escalation proposes, does not auto-flip | **Preserved** |

### 3.2 Pin 11 — `canPromote(rec).ok` is the single authority

`server/eval/promotionBoundaryAudit.ts:5–13` pins the contract:
> *"The hypothesis predicts that every promotion-capable path in the repository routes through the single
> human-gated `canPromote(rec).ok` boundary at the one write site in
> `server/selfRecommendationEngine.ts:applyRecommendation`."*

The audit's Check 5 (`single_write_site_for_status_applied`, finding id at
`server/eval/promotionBoundaryAudit.ts:566`) enforces:
> *"No file other than the engine writes `status='applied'` to `selfRecommendations`."*

| Move   | Adds new `status: "applied"` write? | Routes through `canPromote.ok`? | Verdict     |
|--------|--------------------------------------|---------------------------------|-------------|
| Move 1 | No — `primitive_registry` is a separate table; the rec that *creates* the primitive still routes through `applyRecommendation` at line 292 | Yes — `define_primitive` is just another rec category | **Preserved** |
| Move 2 | No — `capability_gaps` and `diagnostic_signals` are separate tables; recs in `capability_gaps` route through the same `apply` flow when promoted | N/A for `diagnostic_only` (never applied) | **Preserved** |
| Move 3 | No — obligations live in a separate table; their `enforcement` field is not a `self_recommendations.status` value | N/A | **Preserved** |

### 3.3 The existing findings array must continue to pass

`server/eval/promotionBoundaryAudit.ts` declares ten findings today (`promotion_gate_exports_canPromote`,
`apply_recommendation_function_exists`, `applyRecommendation_calls_canPromote_before_applied_write`,
`applyRecommendation_requires_approved_status`, `single_write_site_for_status_applied`,
`engine_applied_writes_inside_applyRecommendation`, `phase4b_hard_block_flag_wired`,
`phase4c_freshness_flag_wired`, `phase4c_medium_risk_hard_block_wired`, `phase4d_hard_block_flag_wired`
— sed line 496–710). **All ten must continue to return `ok: true` after #417 ships.**

The implementation PR (#417) extends the findings array additively (§9) — it does **not** remove or
weaken any existing check.

---

## 4. Schema and migration plan

Two new tables. Both start empty (no backfill). Migration file naming follows the existing convention
(`scripts/migrate_json_to_db.ts`-aware migration block; tables added directly to
`shared/schema.ts` as drizzle sqliteTable declarations, mirroring `selfRecommendations` at line 61–94).

### 4.1 `primitive_registry`

```sql
CREATE TABLE primitive_registry (
  id                    TEXT PRIMARY KEY,                       -- "prim_<name>_<ts>"
  name                  TEXT NOT NULL,                          -- family identifier, [a-z_]+
  family                TEXT NOT NULL,                          -- same as name OR a sub-family of an existing one
  action_shape          TEXT NOT NULL,                          -- JSON: { regex_or_keywords[], requiredFields[] }
  side_effect_spec      TEXT NOT NULL,                          -- JSON: { kind, target, op, args }
  env_flag              TEXT NOT NULL,                          -- e.g. "PRIMITIVE_TTL_ENABLED"
  dry_run_cycles        INTEGER NOT NULL DEFAULT 3,
  observability_probe   TEXT NOT NULL,                          -- JSON: { eventName, engine }
  source_recommendation_id TEXT NOT NULL,                       -- FK → self_recommendations(id)
  source_insight_id     TEXT,                                   -- denormalised for query convenience
  dry_run_cycles_remaining INTEGER NOT NULL,                    -- counts down from dry_run_cycles on each tick
  status                TEXT NOT NULL DEFAULT 'dry_run',        -- dry_run | active | retired
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at          TEXT,                                   -- set when status flips to 'active'
  retired_at            TEXT,
  FOREIGN KEY (source_recommendation_id) REFERENCES self_recommendations(id)
);

CREATE UNIQUE INDEX idx_primitive_registry_name      ON primitive_registry(name);
CREATE        INDEX idx_primitive_registry_status    ON primitive_registry(status);
CREATE        INDEX idx_primitive_registry_env_flag  ON primitive_registry(env_flag);
```

### 4.2 `capability_gaps`

```sql
CREATE TABLE capability_gaps (
  id                       TEXT PRIMARY KEY,                    -- "capgap_<ts>_<rand>"
  recommendation_id        TEXT NOT NULL,                       -- FK → self_recommendations(id)
  detected_family          TEXT NOT NULL,                       -- value from classifyMissingPrimitiveFamily()
  classifier_confidence    REAL NOT NULL,                       -- 0.0 – 1.0
  proposed_primitive_name  TEXT,                                -- extracted from action text when present
  proposed_primitive_contract TEXT,                             -- JSON: PrimitiveContract preview (may be partial)
  status                   TEXT NOT NULL DEFAULT 'open',        -- open | promoted_to_registry | rejected
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  promoted_at              TEXT,
  rejected_at              TEXT,
  FOREIGN KEY (recommendation_id) REFERENCES self_recommendations(id)
);

CREATE INDEX idx_capability_gaps_status                ON capability_gaps(status);
CREATE INDEX idx_capability_gaps_detected_family       ON capability_gaps(detected_family);
CREATE INDEX idx_capability_gaps_recommendation_id     ON capability_gaps(recommendation_id);
```

### 4.3 `diagnostic_signals`

```sql
CREATE TABLE diagnostic_signals (
  id                  TEXT PRIMARY KEY,                          -- "diag_<ts>_<rand>"
  recommendation_id   TEXT,                                      -- FK → self_recommendations(id), nullable: signals can be emitted without a rec
  signal_text         TEXT NOT NULL,                             -- verbatim cycle-log snippet that triggered the signal
  competency          TEXT,                                      -- e.g. "self_integrity", "content_strategy"
  delta               REAL,                                      -- e.g. -0.2 for Self-Integrity 3.2 → 3
  cycle_id            TEXT,                                      -- if available
  status              TEXT NOT NULL DEFAULT 'open',              -- open | acknowledged | superseded
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at     TEXT,
  FOREIGN KEY (recommendation_id) REFERENCES self_recommendations(id)
);

CREATE INDEX idx_diagnostic_signals_status      ON diagnostic_signals(status);
CREATE INDEX idx_diagnostic_signals_competency  ON diagnostic_signals(competency);
CREATE INDEX idx_diagnostic_signals_cycle_id    ON diagnostic_signals(cycle_id);
```

### 4.4 Migration shape

A single new migration file (following the `migrate_json_to_db.ts` pattern in `scripts/`) creates the three
tables and their indexes. Backfill: **none** — all three tables start empty. The existing
`self_recommendations` table is **not modified**; classifier output lives in the new sibling tables.

---

## 5. Env flag table

All new flags default to `false`. The `.env.example` block follows the convention already established at
`.env.example:82–86` for `PROMOTION_GATE_ALLOW_HIGH_RISK`.

| Flag                                          | Default | Move(s) | What it gates                                                                                                                  |
|-----------------------------------------------|---------|---------|--------------------------------------------------------------------------------------------------------------------------------|
| `PRIMITIVE_REGISTRY_ENABLED`                  | `false` | 1       | Master flag — when `false`, the translator's `define_primitive` branch is a no-op and the registry is not consulted at tick.    |
| `PRIMITIVE_<NAME>_ENABLED`                    | `false` | 1       | Per-primitive activation, auto-generated when a new primitive is registered (e.g. `PRIMITIVE_TTL_ENABLED`).                     |
| `RECOMMENDATION_SHAPE_CLASSIFIER_ENABLED`     | `false` | 2       | When `false`, `proposeRecommendation` writes only to `self_recommendations` (today's behavior).                                |
| `OBLIGATION_ESCALATION_ENABLED`               | `false` | 3       | When `false`, no obligation can leave `enforcement: "advisory"`.                                                               |
| `OBLIGATION_ESCALATION_REFRESH_THRESHOLD`     | `5`     | 3       | Integer. Number of refreshes before `advisory → gating_proposed` (open question §8).                                            |
| `OBLIGATION_GATE_<obligationId>_ENABLED`      | `false` | 3       | Per-obligation hard-block flag, **auto-generated** when an obligation enters `gating_proposed`.                                 |
| `PRIMITIVE_DRY_RUN_CYCLES_DEFAULT`            | `3`     | 1       | Integer. Default `dryRunCycles` for newly-registered primitives (open question §8).                                             |

**Auto-generation rule for `OBLIGATION_GATE_*_ENABLED`:** when the escalation policy flips an obligation
to `gating_proposed`, the tick logs a structured event `obligationGatingProposed` carrying the suggested
flag name. The flag is **not** written to `process.env` programmatically — the operator must explicitly
add it to `.env`. This preserves Pin 7 (no auto-public-action) by design.

---

## 6. Self-attestation — eat your own dogfood

The #417 implementation PR is autonomy-primitive infrastructure. By Agent 306's own Phase 3a-prep contract
(`server/experiments/phase3aPrepHarness.ts:112–118`), it MUST ship with `fully_prepared` attestations across
all 14 slots (7 preconditions × {high, low}).

The seven preconditions, in the frozen array order from
`server/experiments/phase3aPrepHarness.ts:112–119`:

1. `reversibleLowRiskActionOnly`
2. `explicitKillSwitchAndResourceLimits`
3. `anomalyAndDriftDetectionPlaceholder`
4. `rollbackProof`
5. `humanApprovalBoundary`
6. `metricsClockReadiness`
7. `noPublicAction`

### 6.1 14-slot attestation table for PR #417 itself

| Precondition                              | Tier | Status        | EvidenceRef                                                                 | Rationale                                                                                                  |
|-------------------------------------------|------|---------------|-----------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| reversibleLowRiskActionOnly               | high | satisfied     | This doc §7 (rollback procedure)                                            | All three moves are env-flag-gated; rollback is a one-line env flip.                                       |
| reversibleLowRiskActionOnly               | low  | satisfied     | §7.4 — worst-case-recovery sequence and verification SQL                    | Worst-case recovery is documented and verifiable.                                                          |
| explicitKillSwitchAndResourceLimits       | high | satisfied     | §5 — env flag table; every move has a default-off master flag               | `PRIMITIVE_REGISTRY_ENABLED`, `RECOMMENDATION_SHAPE_CLASSIFIER_ENABLED`, `OBLIGATION_ESCALATION_ENABLED`.   |
| explicitKillSwitchAndResourceLimits       | low  | satisfied     | `server/ruleCorrectiveObligations.ts:75` (`OBLIGATION_BOUND_CAP = 10`)      | Re-uses existing bounded-action cap; new tables carry no unbounded growth surface (rows are append-only with terminal statuses). |
| anomalyAndDriftDetectionPlaceholder       | high | satisfied     | §2.3.2 — `obligationGatingProposed` structured event                        | Each move emits structured events on its state transitions; existing `engineEvents` table receives them.   |
| anomalyAndDriftDetectionPlaceholder       | low  | **unverified** | (no implementation yet — see §8)                                            | Detection thresholds (e.g. "primitive_registry growth > N per cycle") to be set in the implementation PR.  |
| rollbackProof                             | high | satisfied     | §7 — per-move rollback procedures, all env-flag-driven                      | Each move's rollback is one env flag flip; new tables remain as read-only audit trails after rollback.     |
| rollbackProof                             | low  | satisfied     | §7.4 — verification SQL                                                     | The worst-case-recovery SQL exists in this doc and is testable in CI.                                      |
| humanApprovalBoundary                     | high | satisfied     | `server/selfRecommendationEngine.ts:292–296` (existing approve→apply gate)  | Every move routes through the unchanged approve→apply flow; no auto-apply path is introduced.              |
| humanApprovalBoundary                     | low  | satisfied     | §3.1, §3.2 (Pin 7 / Pin 11 preservation table)                              | Boundary preservation is enumerated per move with quoted invariants.                                       |
| metricsClockReadiness                     | high | satisfied     | `server/eval/promotionBoundaryAudit.ts:80–95` (existing `PROMOTION_BOUNDARY_AUDIT_METRIC_KEY`) | Existing metric `promotion_boundary_violation_count` continues to read 0 after #417. |
| metricsClockReadiness                     | low  | **unverified** | (golden case for new `pin7_define_primitive_no_new_write_site` finding TBD) | New audit findings (§9) need their own deterministic golden cases — to be authored in #417.                |
| noPublicAction                            | high | satisfied     | §3.1 (Pin 7 table)                                                          | No move opens a posting/scheduler/public-output surface; per-move analysis in §3.1.                        |
| noPublicAction                            | low  | satisfied     | §2.3.4 (mid-cycle flag flip semantics)                                      | Env flag flips read at tick boundary; no in-cycle public-action surface introduced.                        |

**Two `unverified` slots are honest** — both depend on implementation details that this design doc
deliberately does not specify. They are listed as open questions (§8) and will be re-attested at
`fully_prepared` in #417's PR description.

---

## 7. Rollback procedure

Per move:

### 7.1 Move 1 rollback

```bash
# Flip master flag
export PRIMITIVE_REGISTRY_ENABLED=false
```

Effect: the translator's `define_primitive` branch becomes a no-op (returns `none` as today). Existing
registered primitives stop loading at tick. Primitives in `dry_run` status simply stop counting down. To
fully roll back, run a migration revert that drops `primitive_registry`. Recs in `capability_gaps`
remain as a read-only audit trail.

### 7.2 Move 2 rollback

```bash
export RECOMMENDATION_SHAPE_CLASSIFIER_ENABLED=false
```

Effect: `proposeRecommendation` reverts to single-bucket emission — every rec writes to
`self_recommendations` and only `self_recommendations`. The `capability_gaps` and `diagnostic_signals`
rows already written remain (read-only audit trail).

### 7.3 Move 3 rollback

```bash
export OBLIGATION_ESCALATION_ENABLED=false
# Per individual gate that was already flipped:
unset OBLIGATION_GATE_<obligationId>_ENABLED
```

Effect: all obligations stay at `enforcement: "advisory"`. Any already-flipped
`OBLIGATION_GATE_*_ENABLED` flags can be individually reverted. The escalation policy does **not** run.

### 7.4 Worst-case recovery sequence

```bash
# Order matters: master flags before per-instance flags
export PRIMITIVE_REGISTRY_ENABLED=false
export RECOMMENDATION_SHAPE_CLASSIFIER_ENABLED=false
export OBLIGATION_ESCALATION_ENABLED=false
# Then individually unset every OBLIGATION_GATE_*_ENABLED flag the operator had set:
env | grep '^OBLIGATION_GATE_' | cut -d= -f1 | xargs -n1 unset
# And every PRIMITIVE_<NAME>_ENABLED flag:
env | grep '^PRIMITIVE_' | grep -v '^PRIMITIVE_REGISTRY_' | grep -v '^PRIMITIVE_DRY_RUN_' | cut -d= -f1 | xargs -n1 unset
# Restart the process so the new env is picked up at next tick boundary.
```

Verification SQL — confirm no orphaned state:

```sql
-- 1. No primitive_registry rows in 'active' status with their per-primitive env flag still consulted.
SELECT id, name, status FROM primitive_registry WHERE status = 'active';

-- 2. No capability_gaps rows in 'promoted_to_registry' that don't correspond to a primitive_registry row.
SELECT cg.id, cg.recommendation_id
FROM capability_gaps cg
LEFT JOIN primitive_registry pr ON pr.source_recommendation_id = cg.recommendation_id
WHERE cg.status = 'promoted_to_registry' AND pr.id IS NULL;

-- 3. No diagnostic_signals rows accidentally referencing a non-existent recommendation.
SELECT ds.id FROM diagnostic_signals ds
LEFT JOIN self_recommendations sr ON sr.id = ds.recommendation_id
WHERE ds.recommendation_id IS NOT NULL AND sr.id IS NULL;

-- 4. The existing promotion-boundary audit metric still reads zero.
-- Run: `npx tsx scripts/auditPromotionBoundary.ts --pretty` and verify status === "ok" and violationCount === 0.
```

---

## 8. Open questions

Honest questions the operator (MrRayG) needs to decide before #417 lands. Marked **unverified** in §6
where they intersect attestation slots.

1. **Should `define_primitive` recs require an EXTRA approval step beyond the standard apply** (e.g.
   operator must explicitly type the primitive name as a confirmation)? Default plan: **no** — the
   standard approve→apply flow is the contract. But the operator may want a typed-confirmation gate
   for primitive *definition* given its compounding effect (every primitive defines a new class of
   future side effects).

2. **Default `dryRunCycles` for new primitives — 3? 5? configurable per primitive?** This doc proposes
   `3` as the default with a `PRIMITIVE_DRY_RUN_CYCLES_DEFAULT` env flag override. The per-primitive
   field in `primitive_registry.dry_run_cycles` lets individual primitives override the default.

3. **Should `diagnostic_only` recs still surface in the dashboard's `proposed` filter, or only in a
   separate "signals" tab?** This doc proposes **separate tab** (the whole point of the classification
   is to remove non-actionable items from the apply queue). Operator preference may differ.

4. **`N` (refresh count threshold) for obligation escalation — 5? 10? per-rule configurable?** This doc
   proposes default `N=5` via `OBLIGATION_ESCALATION_REFRESH_THRESHOLD`, with per-rule overrides
   possible in a follow-up. With `oblg_9a9f8a52bf8a3bd3` at 19 refreshes, N=5 would have flipped this
   obligation to `gating_proposed` 14 refreshes ago — that's the intended behavior.

5. **Back-port the 4 currently-stuck recs?** Should `rec_1779362735356_uld3zy`,
   `rec_1779362735353_oirek5`, `rec_1779447024967_vqh06n`, `rec_1779447024953_tzdxk0` (all applied,
   all registered no rule, all `reason: untranslatable`) be back-ported into the new
   `capability_gaps` flow once #417 lands? Or marked `superseded`? This doc has **no recommendation**
   — it's an operator call.

6. **Action text for `rec_1779362735356_uld3zy` and `rec_1779362735353_oirek5`** is not in the cycle
   data provided in this design brief — only the rec IDs and source insight IDs. The classifier
   worked example in §2.2.2 marks these as `unverified`. The implementation PR will need to read the
   actual action strings from the DB before back-porting.

---

## 9. Implementation plan (skeleton — NOT the #417 code)

File-level changes #417 would make. **Listed only — no code.**

| File                                                         | Change                                                                                                                                                                          | Reference                  |
|--------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------|
| `server/actionTranslator.ts`                                 | Add `parseDefinePrimitive(actionText)` helper. Add a new translator branch after `REWRITE_PATTERNS` loop (lines 806–830) and before the final `return { primitive: "none", … }` (lines 832–838). Returns `{ primitive: "define_primitive", params: { contract } }` on match. | line 832–838 (insertion before) |
| `server/selfRecommendationEngine.ts`                         | Add `classifyRecommendationShape(input)` called inside `proposeRecommendation` (line 156). Route to `capability_gaps` or `diagnostic_signals` via new helper writes. Extend `maybeRegisterRuleForRecommendation` (line 401–470) to handle `primitive === "define_primitive"` by writing a row to `primitive_registry`. | lines 156, 401–470 |
| `server/actionEnforcer.ts`                                   | Add obligation-escalation pass on tick. Read `OBLIGATION_ESCALATION_ENABLED` at tick boundary. When obligation `refreshCount` ≥ threshold, flip `enforcement` field and emit `obligationGatingProposed` event. Read `OBLIGATION_GATE_<id>_ENABLED` at tick boundary to decide between `gating_proposed` and `gating_active`. | lines 200–280 (refresh path) |
| `shared/schema.ts`                                           | Add `primitiveRegistry`, `capabilityGaps`, `diagnosticSignals` table declarations (drizzle `sqliteTable`). Mirror conventions used by `selfRecommendations` at line 61–94.       | line 61–94 (template)      |
| `server/eval/promotionGate.ts`                               | **UNTOUCHED.** Boundary preservation is the point. Pin 11 stays at `canPromote(rec).ok`.                                                                                        | n/a                        |
| `server/eval/promotionBoundaryAudit.ts`                      | Extend `findings[]` (after line 698) to include `pin7_define_primitive_no_new_write_site`, `pin11_shape_classifier_advisory_only`, `obligation_escalation_env_gated`. Each is a source-only string check mirroring `phase4b_hard_block_flag_wired` (line 621–632). | line 698 (append)          |
| New migration file `scripts/migrations/0001_self_evolving_primitives.ts` | `CREATE TABLE` for the three new tables + indexes. Empty backfill.                                                                                              | matches existing `scripts/migrate_json_to_db.ts` shape |
| `Dockerfile`                                                 | Bundle target for an `observeNewPrimitive.cjs` CLI (analog to the `dumpSelfRecs.cjs` bundle at line 56–70). Operator inspects registered primitives without needing a sqlite CLI. | line 56–70 (template)      |
| `.env.example`                                               | Add the env flag table (§5) as documentation.                                                                                                                                  | after line 86              |
| `server/__tests__/actionTranslator.definePrimitive.test.ts`  | New test file: golden cases for the four currently-stuck rec action strings (each must translate to `define_primitive`).                                                       | new                        |
| `server/__tests__/promotionBoundaryAudit.pin7Pin11.test.ts`  | New test file: each of the three new findings must be deterministic and pass for the implementation PR's gate source.                                                          | new                        |
| `server/__tests__/obligationEscalation.test.ts`              | New test file: threshold crossing, env-flag read at tick boundary, mid-cycle flip semantics.                                                                                   | new                        |

---

## 10. Out-of-scope (explicitly NOT in #417)

- **Auto-executing `define_primitive` without operator approve→apply.** The flow is identical to every
  other rec — approve, then apply, then the side effect happens. No exception.
- **Removing the env flag gates on any move.** All three master flags stay opt-in indefinitely. There is
  no "graduate to default-on" milestone in this design.
- **Modifying the existing 6 primitive families' shapes.** `RATIO_PATTERNS`, `TTL_PATTERNS`,
  `GATE_PATTERNS`, `ARCHIVE_PATTERNS`, `ARTIFACT_PATTERNS`, `VERIFICATION_PATTERNS` are untouched. So
  are `VERIFICATION_SCAFFOLD_PATTERNS`, `SPECTRUM_PATTERNS`, `REWRITE_PATTERNS`. Lines 71–469 of
  `server/actionTranslator.ts` are read-only for #417.
- **Stage 10 → Stage 11 cross-cycle synthesis** (separate roadmap item).
- **Touching `server/experiments/phase3aPrepHarness.ts`.** The harness stays pure — #417 only adds new
  attested types **for** the harness; it does not modify the harness itself. Per
  `server/experiments/phase3aPrepHarness.ts:22–28`:
  > *"This file does NOT: Enable, register, schedule, dispatch, or authorise any Phase 3 trial. Define
  > any execution path, dry-run, or sandbox handler. Set any feature flag, env var, or scheduler hook."*

---

## 11. References

### 11.1 Today's cycle (2026-05-23T11:41:01Z) — verbatim log excerpts

- `[Competency] Self-Integrity: 3.2 → 3 ([self-evolution] Four broken self-change commitments firing 10-15x with zero side effects is direct evidence of integrity failure — I commit to changes I don't execute. Honest downgrade warranted.)`
- `[Competency] Critical Thinking & Problem-Solving: 7.6 → 7.7 ([self-evolution] The diagnosis of WHY commitments fail (observational rules vs. operational mechanisms) is sharper this cycle than previous cycles.)`
- `[Competency] Content Strategy: 2.1 → 2`
- `[SelfEvolution] Diff appended — 4 hypothesis changes, 47 KB added, 8 pruning suggestions`
- New self-recs: `rec_1779534403884_yyywag`, `rec_1779534403888_4yfprs`, `rec_1779534403889_hcfqvt`.
- Yesterday's untranslatable apply events: `rec_1779362735356_uld3zy` (insight `evo_1779362735301_kihp`),
  `rec_1779362735353_oirek5` (insight `evo_1779362735301_ebcw`), `rec_1779447024967_vqh06n` (insight
  `il_1779362735348_p7du`, action="Add a `gate` enforcement primitive (block X until Y holds)."),
  `rec_1779447024953_tzdxk0` (insight `il_1779362735348_vbh8`, action="Add a `ttl` enforcement primitive
  (expire items after N days without state change).").
- Open obligation `oblg_5ef74bb3104b7691` — refreshed 9 times, `draft_output_artifact` deficit 308.
- Open obligation `oblg_9a9f8a52bf8a3bd3` — refreshed 19 times, `archived` deficit 162, dedupes 3 source rules.

### 11.2 Prior PRs

| PR    | Outcome                                                                                                |
|-------|--------------------------------------------------------------------------------------------------------|
| #412  | Reasoning Quality v2.6                                                                                 |
| #413  | (referenced for parser-coverage continuity; widened the missing-primitive family classification)        |
| #414  | KB ratio gate primitive — added `RATIO_PATTERNS[4]` (active-voice imperative) at `server/actionTranslator.ts:115` and `GATE_PATTERNS[12]` (conditional-cap "unless" gate) at line 247 |
| #415  | `dumpSelfRecs.cjs` operator CLI shape (`Dockerfile:56–70`) — template for the `observeNewPrimitive.cjs` bundle in #417 |
| #416  | Phase 3a-prep attestations — `server/experiments/phase3aPrepHarness.ts` (full file, declarative-only)   |

### 11.3 Pin 7 / Pin 11 invariants — exact source citations

- Pin 11 contract: `server/eval/promotionBoundaryAudit.ts:5–13`.
- Pin 11 audit findings declared at `server/eval/promotionBoundaryAudit.ts:496, 512, 528, 543, 566, 592,
  621, 643, 670, 699`.
- Pin 7 propose-only invariant: `server/eval/promotionBoundaryAudit.ts:51–59` and
  `server/experiments/phase3aPrepHarness.ts:22–28`.
- Single-write-site contract:
  `server/selfRecommendationEngine.ts:292–322` (`applyRecommendation` body, including the single
  `db.update(...).set({ status: "applied", ... })` write at lines 307–315).

### 11.4 Phase 3a-prep readiness contract

- Schema version: `server/experiments/phase3aPrepHarness.ts:67` (`PHASE3A_PREP_HARNESS_VERSION = "phase3aPrep.v1"`).
- Frozen precondition list: `server/experiments/phase3aPrepHarness.ts:112–119`.
- Verdict semantics (`fully_prepared` vs `high_tier_ready`): `server/experiments/phase3aPrepHarness.ts:34–43`.

### 11.5 Translator self-quotation

`describeMissingPrimitiveFamily` at `server/actionTranslator.ts:1037–1051` returns the literal strings
Agent 306 then uses as `proposedChange` text — and which the translator then refuses to translate. The
loop is empirically observable.
