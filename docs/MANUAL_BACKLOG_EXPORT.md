# Operator: manual backlog export

**Purpose:** produce a deterministic Markdown + JSON snapshot of the
hypotheses that need manual operator attention — positional-debate
rewrites, missing-evidence-path repairs, and memory-origin promotion
candidates — for offline review without touching production state.

## Invocation

```bash
# Dry-run first (recommended). Prints bucket counts; writes nothing.
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --dry-run

# Real export. Writes to ./backlog-export-<UTC-date>/ by default.
npx tsx scripts/exportManualBacklog.ts --data-dir=/data

# Include the already-archived rows (audit-only — the existing reset CLI
# will REFUSE to re-archive these).
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --include-archived

# JSON-only or Markdown-only.
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --format=json
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --format=markdown

# Reproducible run (pins the Generated timestamp; useful for diffs / CI).
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --now=2026-05-18T18:00:00.000Z
```

## Read-only invariant

The script:

- Never opens the SQLite DB in write mode.
- Never writes to `research_lab.json`, `research_lab.json.bak`, or `memory_knowledge.json`.
- Never changes any hypothesis `status`, `hygieneTag`, or other field.
- Never archives, promotes, or applies anything.

Bucket assignment is delegated to `buildResetReport` / `classifyReset`
in `server/hypothesisIntakeAuditVisibility.ts` — the same classifier
`scripts/hypothesisReset.ts` uses — so the export matches the reset
CLI's view byte-for-byte.

## Default bucket selection

| bucket | recommended action |
| --- | --- |
| `rewrite_positional_debate` | rewrite as research-gap framing |
| `rewrite_missing_evidence_path` | repair evidence path |
| `promote_later_memory_origin` | review for operator promotion |

`already_archived`, `keep_active`, the `archive_*` buckets, and
`needs_operator_review` are **excluded by default** so the export only
surfaces what the operator actually has to work on. Pass
`--buckets=<comma-separated>` to override, or `--include-archived` to
add `already_archived`.

## Output structure

```
backlog-export-<YYYY-MM-DD>/
├── summary.md                              # counts per bucket + run metadata + legend
├── positional-debate-rewrites.md           # one section per item
├── missing-evidence-path-repairs.md        # one section per item
├── memory-origin-promotion-candidates.md   # one section per item
└── backlog.json                            # structured payload, sorted by id
```

Each per-item section captures:

- `id`, `bucket`, `origin` (`formal` / `memory`)
- `claim` (full text, blockquoted)
- `status`, `formedAt`, `source`
- `presentFields` and `missingFields` against the bucket's required-field list
- `recommendedAction` (deterministic from bucket, no LLM)
- `intakeVerdict` and the classifier's `reasons` for audit

## Determinism

The export is sorted by `id` lexicographically, and the only clock-derived
value is `summary.md`'s `Generated:` line plus the default `--out-dir`
name. Pin `--now` and `--out-dir` to get byte-identical reruns.

## Sample

`examples/backlog-export-sample/` carries a synthetic 3 + 4 + 2 export
showing the file layout. See its README for the fixture and how it was
produced. The sample is **NOT** production data.

## See also

- `docs/BACKLOG_REWRITE_ASSISTANT.md` — step 2 of the workflow:
  feed this export's `backlog.json` into the rewrite assistant to get
  per-item Markdown DRAFT rewrites for operator review.
