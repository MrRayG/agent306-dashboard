# Skill: self-recs-dump

**Owner:** agent306-safety
**Status:** registered
**Card:** [`SKILLCARD.yaml`](./SKILLCARD.yaml)

## Purpose

A read-only operator CLI for dumping arbitrary self-recommendation rows
from the production SQLite DB on Railway. The immediate need is to
inspect a handful of stuck self-recs so we can build phase3aPrep
attestations; the longer-term need is a reusable, generic ad-hoc dump
path that does not require shipping `sqlite3`, `curl`, or `jq` into the
production image.

The skill wraps two files that this PR adds:

- `scripts/dumpSelfRecs.ts` — the operator CLI.
- `Dockerfile` — the esbuild step that bundles the CLI into
  `dist/dumpSelfRecs.cjs` BEFORE `npm prune --production`, so the
  bundle survives the prune and can be invoked from a Railway SSH
  session.

The bundle pattern mirrors `scripts/hypothesisReset.ts` →
`dist/hypothesisReset.cjs` from PR #411. `better-sqlite3` stays external
because it remains a runtime dependency and survives the prune.

## What this skill is NOT

- **Not** a writer. The CLI opens `better-sqlite3` with
  `{ readonly: true }`, uses only `Database#prepare(...).all/.get` for
  SELECTs, and never calls `.exec`, `.run`, or `.transaction`. It
  exposes no write flag of any kind — there is no `--apply` and there
  is nothing to apply.
- **Not** a promoter. `promotion_authority: none` in the card. A
  successful dump is data for the operator; it grants no new authority.
- **Not** autonomous. There is no scheduler hook, cron, app-boot
  wiring, UI control, or API endpoint that invokes this skill. The
  only entry points are the manual `tsx scripts/dumpSelfRecs.ts` and
  the bundled `node dist/dumpSelfRecs.cjs` invocations.
- **Not** non-deterministic. The CLI does NOT call `Date.now()`,
  `Math.random()`, or read environment variables for behaviour. The
  only timestamp surface is the optional `--now <iso>` flag.

## How to invoke

Local dev (tsx available):

```bash
# basic: dump one row, compact JSON, with the source-check banner on stderr
tsx scripts/dumpSelfRecs.ts --ids=rec_alpha

# multiple IDs, pretty-printed
tsx scripts/dumpSelfRecs.ts --ids=rec_a,rec_b,rec_c --pretty

# filter by status
tsx scripts/dumpSelfRecs.ts --ids=rec_a,rec_b --status=approved

# point at a non-default DB (local testing)
tsx scripts/dumpSelfRecs.ts --ids=rec_a --db=/tmp/test.db --pretty

# emit every column for deep debugging
tsx scripts/dumpSelfRecs.ts --ids=rec_a --all-fields

# skip the source-check banner (faster, for piping into jq)
tsx scripts/dumpSelfRecs.ts --ids=rec_a --no-source-check

# pin dumpedAt for deterministic / byte-identical output across runs
tsx scripts/dumpSelfRecs.ts --ids=rec_a --now=2026-05-22T00:00:00.000Z
```

Production (Railway SSH — tsx is pruned, use the bundled CJS):

```bash
node dist/dumpSelfRecs.cjs --ids=rec_a,rec_b,rec_c --pretty
node dist/dumpSelfRecs.cjs --ids=rec_a --status=approved --no-source-check
```

Exit codes:

- `0` — success, every requested ID was found.
- `1` — CLI usage / argument error.
- `2` — DB not readable / table missing / schema mismatch.
- `3` — partial-success warning: one or more requested IDs returned zero
  rows. The payload is still emitted, with `found` and `notFound` both
  populated.

## Safety posture

- READ-ONLY DB open (`{ readonly: true }`); a read-only handle refuses
  any DML. Pinned by
  [`server/__tests__/dumpSelfRecs.test.ts`](../../server/__tests__/dumpSelfRecs.test.ts).
- PARAMETERIZED `WHERE id IN (?, ?, …)`; SQL metacharacters in IDs
  cannot break the query. Pinned by the same test file.
- NO `Date.now()`, NO `Math.random()`, NO env reads for behaviour.
  Pinned by source-code grep in the test file.
- The source-check banner is emitted to stderr BEFORE the main query so
  the operator can verify they're hitting the right DB (path, size,
  table list, target table columns, total row count).

## Evidence

- [`scripts/dumpSelfRecs.ts`](../../scripts/dumpSelfRecs.ts)
- [`Dockerfile`](../../Dockerfile) — esbuild bundle step
- [`server/__tests__/dumpSelfRecs.test.ts`](../../server/__tests__/dumpSelfRecs.test.ts)
