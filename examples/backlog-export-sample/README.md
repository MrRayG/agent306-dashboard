# Sample: `scripts/exportManualBacklog.ts` output

This directory shows the **shape** of the artefacts produced by
`scripts/exportManualBacklog.ts` so an operator can compare against a
real production run.

> ⚠️ **Synthetic fixture, NOT production data.**
> The 9 records (3 positional-debate + 4 missing-evidence-path + 2
> memory-origin) are fabricated in-memory for documentation purposes.
> No production hypothesis ids appear here. The repo's
> `data/research_lab.json` carries 0 in-scope formal-backlog records at
> the current HEAD; running the script against the real `/data` volume
> will produce a different, larger output.

## How this sample was produced

```bash
# 1. Build a synthetic fixture in a tmp directory.
SAMPLE_TMP=$(mktemp -d)
cat > "$SAMPLE_TMP/research_lab.json" <<'EOF'
{ "hypotheses": [ /* 3 positional-debate + 4 missing-evidence-path rows */ ] }
EOF
cat > "$SAMPLE_TMP/memory_knowledge.json" <<'EOF'
{ "entries": [ /* 2 Hypothesis: …-titled entries */ ] }
EOF

# 2. Run the export against that fixture with a pinned timestamp.
npx tsx scripts/exportManualBacklog.ts \
  --data-dir="$SAMPLE_TMP" \
  --out-dir=examples/backlog-export-sample \
  --now=2026-05-18T18:00:00.000Z
```

## Files

| file | purpose |
| --- | --- |
| `summary.md` | counts per bucket, run metadata (DATA_DIR, source, git SHA), and a legend |
| `positional-debate-rewrites.md` | one `### {id}` section per item with claim, present fields, missing fields, recommended action |
| `missing-evidence-path-repairs.md` | same format |
| `memory-origin-promotion-candidates.md` | same format |
| `backlog.json` | a single structured JSON file containing all items, sorted by `id` for stable diffs |

## Operator usage in production

```bash
# Dry-run against the prod volume to confirm counts before writing.
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --dry-run

# Real export.
npx tsx scripts/exportManualBacklog.ts --data-dir=/data

# Include the 338 already-archived rows (audit-only).
npx tsx scripts/exportManualBacklog.ts --data-dir=/data --include-archived
```

## Read-only invariant

The script:
- Never opens the SQLite DB in write mode.
- Never writes to `research_lab.json`, `research_lab.json.bak`, or `memory_knowledge.json`.
- Never changes any hypothesis status, hygieneTag, or other field.
- Never archives, promotes, or applies anything.

Bucket classification is delegated to `buildResetReport` /
`classifyReset` in `server/hypothesisIntakeAuditVisibility.ts` — the
same classifier `scripts/hypothesisReset.ts` uses — so the export
matches the reset CLI's view byte-for-byte.
