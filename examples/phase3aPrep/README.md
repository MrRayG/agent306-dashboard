# Phase 3a-prep — sample candidate JSON fixtures

Read-only / declarative-only smoke fixtures for the manual Phase 3a-prep
readiness runner (`scripts/runManualPhase3aPrepEvaluation.ts`).

These files are **plain data**, intentionally placed outside the
`server/`, `client/`, and `scripts/` trees so they are invisible to every
Phase 3 boundary regression pin. They exist so an operator (or a new
contributor) can run the manual CLI end-to-end against a real on-disk
candidate without first hand-rolling a 7-precondition × 2-tier JSON
matrix.

---

## What this directory IS

- A set of three caller-supplied candidate bundles, one per harness
  verdict (`fully_prepared`, `high_tier_ready`, `not_ready`).
- A worked example of the attestation shape that
  `computePhase3aPrepReadiness` accepts: `candidateId`, `kind`, and a
  `preconditions` map keyed by the seven precondition keys, each
  carrying a `{ high, low }` tier pair.
- Safe to copy, edit, and re-feed to the manual runner.

## What this directory IS NOT

- **NOT a schema bump.** `PHASE3_ENTRY_POINT_VERSION` stays at
  `phase3a.v3`. `PHASE3A_PREP_HARNESS_VERSION` stays at
  `phase3aPrep.v1`. The `PHASE3_NEVER_AUTHORIZED_BY` list is
  unchanged. The Phase 3 entry point and the Phase 3a-prep harness
  read no file in this directory.
- **NOT a registration record.** Nothing here promotes a candidate,
  enables a sandbox kind, marks anything auto-apply eligible, or
  authorises Phase 3 execution. `summarizationTemplate` remains the
  only enabled sandbox kind. Disabled kinds remain disabled.
- **NOT imported by any production-runtime surface.** No file under
  `server/`, `client/`, or `scripts/` imports anything from this
  directory. The boundary regression suite's Pin 10 still holds:
  the Phase 3a-prep harness has zero production-runtime callers.
- **NOT a public action.** The fixtures describe a hypothetical
  read-only candidate; reading them produces no outbound network
  call, no posting, no replying, no public-surface side effect.
- **NOT a substitute for the test suite.** The runner's behavior is
  pinned in `server/__tests__/runManualPhase3aPrepEvaluation.test.ts`
  (37 tests / 12 suites). This README only documents the fixtures so
  an operator can reproduce the same shapes by hand.

---

## The three fixtures

| File | Verdict | What it demonstrates |
|---|---|---|
| `candidate-fully-prepared.json` | `fully_prepared` | Every precondition's `high` AND `low` slot is `satisfied` with a non-empty `evidenceRef`, and `kind` matches the only Phase 3a-eligible sandbox kind. |
| `candidate-high-tier-ready.json` | `high_tier_ready` | Every `high` slot is `satisfied`; every `low` slot is `unverified` with empty `evidenceRef`. Candidate is required-to-enter-Phase-3a ready, but not yet fully prepared. |
| `candidate-not-ready.json` | `not_ready` | One `high` slot (`rollbackProof.high`) is `unverified` with empty `evidenceRef`; everything else is `satisfied`. Candidate cannot enter Phase 3a. |

The `evidenceRef` paths under `examples/phase3aPrep/evidence/...` are
illustrative caller-supplied strings. The harness records them
verbatim and never opens them — resolution is a reviewer concern.
None of those evidence files exist on disk in this directory and
their absence does not affect the verdict.

---

## Running the manual runner against a fixture

The runner is read-only / stdout-only / no scheduler / no auto-apply /
no public action. Three example invocations:

```bash
# 1. Fully prepared — pretty-printed JSON to stdout, safety banner to stderr.
npx tsx scripts/runManualPhase3aPrepEvaluation.ts \
  --candidate examples/phase3aPrep/candidate-fully-prepared.json \
  --pretty

# 2. High-tier ready — single-line JSON, suitable for piping into jq.
npx tsx scripts/runManualPhase3aPrepEvaluation.ts \
  --candidate examples/phase3aPrep/candidate-high-tier-ready.json \
  --json

# 3. Not ready — same shape, with a run label + operator echo.
npx tsx scripts/runManualPhase3aPrepEvaluation.ts \
  --candidate examples/phase3aPrep/candidate-not-ready.json \
  --run-label demo \
  --operator example-operator \
  --pretty
```

The runner writes exactly one JSON payload to stdout and a single
safety-invariants banner to stderr. It opens no file for writing,
touches no database, sets no env var, mutates no in-memory map, and
never reaches out to the network.

---

## Editing the fixtures

These files are intentionally hand-written, deterministic, and stable.
If you copy one to seed a new candidate:

- Keep `kind` set to `"summarizationTemplate"` — the only Phase 3a-eligible
  sandbox kind. Any other value yields a `not_ready` verdict with a
  sandbox-kind blocker.
- Echo `key` and `priority` inside each attestation; the harness's
  defensive echo check rejects shuffled attestations.
- Leave the seven precondition keys spelled exactly as written, in
  whichever order you like. The harness re-orders them deterministically
  during verdict computation.
- A `"satisfied"` status with an empty `evidenceRef` is a blocker. Either
  fill the reference or mark the status `"unverified"`.

If the harness's candidate shape ever changes (it requires a schema
version bump per the harness's own doc block), update these fixtures in
the same PR.
