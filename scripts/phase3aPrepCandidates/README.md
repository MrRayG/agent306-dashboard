# Phase 3a-prep candidate JSONs for the 8 stuck self-recommendations

These per-rec `Phase3aPrepCandidate` JSON files are the **honest, real-data**
attestations attached as evidence to unblock the 8 self-recommendations that
are currently stuck at `status=approved` with the promotion gate returning
409 `promotion_gate_failed` (env var
`PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY=true`).

## Methodology — honest classification

Each precondition is filled per-rec with `satisfied` or `unverified` based on
the rec's actual content (not fabricated). The classifier is:

| precondition | rule |
|---|---|
| `reversibleLowRiskActionOnly` | `satisfied` only for primitive / gate / TTL recs that only flip env-gated dormant code paths. `unverified` for content-engine recs whose action surface produces public script output. |
| `explicitKillSwitchAndResourceLimits` | `satisfied` when the rec's action ships behind an env flag (e.g. `KB_ACCUMULATION_GATE_ENABLED`). `unverified` otherwise. |
| `anomalyAndDriftDetectionPlaceholder` | `satisfied` when the rec mentions drift / anomaly / monitoring. `unverified` otherwise. |
| `rollbackProof` | `satisfied` when the rec ships behind an env flag (single flag flip = rollback). `unverified` if the rec mutates runtime state without a flag. |
| `humanApprovalBoundary` | `satisfied` for ALL 8 recs — they went through the approval workflow (`status=approved`). |
| `metricsClockReadiness` | `satisfied` when the rec specifies a metric + measurement cadence. `unverified` otherwise. |
| `noPublicAction` | `satisfied` for internal autonomy primitives. **`unverified` for recs 6/7/8** — they relate to script truncation enforcement, AudFit shaping, and confirmed-hypothesis → publishable output, all of which touch publication output. |

The candidate `kind` field is **always** `"summarizationTemplate"` — that is
the literal required by the Phase 3a-prep harness's kind-parity gate
(`PHASE3_ENTRY_KIND`). It is the schema label for the attestation payload,
not a claim about the rec's content type.

## Expected verdicts

- **Recs 1–5** (primitives / TTL / gate / kb-accumulation / archive-debt /
  other-concern): `fully_prepared`.
- **Recs 6–8** (content-engine recs — script truncation enforcement, AudFit
  shaping, output conversion): **not `fully_prepared`** — these honestly fail
  one or more high-tier preconditions (typically `noPublicAction` and
  `reversibleLowRiskActionOnly`). The promotion gate WILL continue to block
  them, and that is the correct outcome until the user manually shapes a
  publication-isolated execution boundary for them.

## Source of truth

Generated from `/home/user/workspace/stuck_recs_dump.json` (the dump produced
by PR #415's `dumpSelfRecs.cjs` against `/data/agent306.db`).

Each candidate file is paired with `<rec_id>.verdict.txt` capturing the
`runManualPhase3aPrepEvaluation.ts --candidate <file>` stdout for the PR
record.
