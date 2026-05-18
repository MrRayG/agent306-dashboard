# Sample: `scripts/draftBacklogRewrites.ts` output

This directory shows the **shape** of the draft artefacts produced by
`scripts/draftBacklogRewrites.ts` so an operator can compare against a
real production run.

> ⚠️ **Synthetic fixture, NOT production data.**
> The 7 drafts (3 positional + 4 missing-evidence) and 2 skipped
> memory-origin rows are derived from
> `examples/backlog-export-sample/backlog.json` — itself a synthetic
> fixture. No production hypothesis ids appear here.

## How this sample was produced

```bash
# Step 1 (already done) — exportManualBacklog.ts produced
# examples/backlog-export-sample/backlog.json.

# Step 2 — feed that backlog.json into the rewrite assistant.
npx tsx scripts/draftBacklogRewrites.ts \
  --input=examples/backlog-export-sample/backlog.json \
  --out-dir=examples/backlog-rewrites-sample \
  --now=2026-05-18T00:00:00.000Z \
  --review-deadline=2026-06-01
```

## Files

| file | purpose |
| --- | --- |
| `summary.md` | counts, input sha256, review-deadline used, run metadata |
| `positional-debate-rewrites.md` | one `### {id}` section per item with template TODO stubs |
| `missing-evidence-path-repairs.md` | same format, missing-required-field rationale included |
| `skipped.md` | items the assistant did NOT draft (memory-origin, or excluded by `--buckets`) |
| `rewrites.json` | full structured payload sorted by id (byte-stable for diffs) |

## Propose-only invariant in the sample

Every section in the two `*-rewrites.md` files contains:

- The literal sentinel **`DRAFT — operator must edit before applying`**
- At least one literal **`TODO`** in the proposed-rewrite body

The assistant's tests assert both conditions are true for every draft
emitted. If a future change ever produces a draft without these
sentinels, CI catches it before the PR can merge.

## Operator workflow

```bash
# Production volume: export → draft → review → apply manually.
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --out-dir=./backlog-export
npx tsx scripts/draftBacklogRewrites.ts --input=./backlog-export/backlog.json --out-dir=./backlog-rewrites
```

The assistant NEVER applies the drafts. Operator opens each section,
fills the TODOs, and uses the existing UI / CLI surface to apply the
edit. See `docs/BACKLOG_REWRITE_ASSISTANT.md` for the full operator doc.
