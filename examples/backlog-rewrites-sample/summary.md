# Backlog Rewrite Assistant — Summary

- **Generated:** 2026-05-18T00:00:00.000Z
- **Input:** `examples/backlog-export-sample/backlog.json`
- **Input sha256:** `bd642b8670d53f04903f07c0a0060d70c5c0eea749f0cb0a2327af03941c7ea4`
- **Input schema:** `manual-backlog-export-1`
- **Review deadline (applied to drafts):** 2026-06-01
- **Git SHA:** d8034486b3f1
- **Schema version:** `backlog-rewrite-draft-1`
- **Buckets requested:** `rewrite_positional_debate`, `rewrite_missing_evidence_path`

## Counts

- `rewrite_positional_debate`: 3
- `rewrite_missing_evidence_path`: 4
- **skipped:** 2
- **Total drafts:** 7

## Notes

- This is a **read-only, template-only** assistant. No LLM calls. No DB writes. No status mutations.
- Every draft carries at least one `TODO` and the `DRAFT — operator must edit before applying` sentinel. Drafts must never look done.
- Memory-origin items (`promote_later_memory_origin`) are intentionally NOT drafted by this assistant — they remain operator-only promotion candidates. See `skipped.md` for the list.
- The export does not carry per-field values; the assistant lists field NAMES and points the operator at the lab UI for originals.
