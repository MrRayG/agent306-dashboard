# Manual Backlog Export — Summary

- **Generated:** 2026-05-18T18:00:00.000Z
- **DATA_DIR:** `/tmp/tmp.bZ9aGmEqHN`
- **Source:** `/tmp/tmp.bZ9aGmEqHN/research_lab.json`
- **Git SHA:** c31ac19ba0b8
- **Schema version:** `manual-backlog-export-1`
- **Buckets included:** `rewrite_positional_debate`, `rewrite_missing_evidence_path`, `promote_later_memory_origin`
- **Include archived:** false

## Counts

- `promote_later_memory_origin`: 2
- `rewrite_missing_evidence_path`: 4
- `rewrite_positional_debate`: 3
- **Total:** 9

## Legend

- **rewrite_positional_debate** — claim shaped like 'A vs B'; reframe as a research-gap claim with metric + deadline.
- **rewrite_missing_evidence_path** — missing measurementPath / metric / basis; repair before re-entering the loop.
- **promote_later_memory_origin** — memory_knowledge.json entry (`title: "Hypothesis: …"`); promotion to formal is operator-only.
- **already_archived** — audit-only; the existing reset CLI will REFUSE to re-archive these.

## Read-only invariant

This export is produced by `scripts/exportManualBacklog.ts`, which:

- Does NOT open the SQLite DB in write mode.
- Does NOT write research_lab.json / research_lab.json.bak / memory_knowledge.json.
- Does NOT change any hypothesis status, hygieneTag, or other field.
- Does NOT archive, promote, or apply anything.

It reuses `buildResetReport` / `classifyReset` from
`server/hypothesisIntakeAuditVisibility.ts` so bucket assignment
matches `scripts/hypothesisReset.ts` byte-for-byte.
