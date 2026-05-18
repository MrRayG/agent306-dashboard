# Operator: backlog rewrite assistant

**Purpose:** turn a `backlog.json` from `scripts/exportManualBacklog.ts`
into per-item Markdown DRAFT rewrites the operator copies, edits, and
applies manually. Template-only — no LLM, no DB writes, no
auto-application.

## Two-step operator workflow

```bash
# Step 1 — export the live manual backlog (read-only).
npx tsx scripts/exportManualBacklog.ts \
  --data-dir=/data \
  --out-dir=./backlog-export

# Step 2 — turn the export into per-item drafts (read-only).
npx tsx scripts/draftBacklogRewrites.ts \
  --input=./backlog-export/backlog.json \
  --out-dir=./backlog-rewrites
```

Then: operator reviews each `### {id}` section, fills the `TODO`
placeholders, and applies the edit via the existing UI or CLI surface.
The assistant never writes anything to the lab.

## Flags

| flag | purpose |
| --- | --- |
| `--input <path>` | **required.** `backlog.json` produced by the export tool. |
| `--out-dir <path>` | output directory (default `./backlog-rewrites-<UTC-date>`). |
| `--buckets <a,b>` | which rewrite buckets to draft. Default `rewrite_positional_debate,rewrite_missing_evidence_path`. Memory-origin items are **never** drafted by this assistant. |
| `--review-deadline <iso>` | review deadline inserted into every draft. Default = 14 days from `--now`. |
| `--now <iso>` | pin clock-derived values for deterministic test / repro runs. |
| `--dry-run` | print counts; write nothing. |

## Propose-only invariant

The script:

- Never reads or writes the SQLite DB.
- Never reads or writes `research_lab.json` / `.bak` / `memory_knowledge.json`.
- Never calls an LLM. Output is deterministic from input.
- Never changes any hypothesis `status`, `hygieneTag`, or other field.
- Never archives, promotes, or applies anything.
- Never guesses a bucket. Items without a `bucket` tag go to `skipped.md`.

Every emitted draft carries at least one literal `TODO` AND the literal
sentinel `DRAFT — operator must edit before applying`. A test
(`server/__tests__/draftBacklogRewrites.test.ts` case 5) asserts both
sentinels appear in every draft, so a future change cannot quietly
produce a "looks-done" draft.

## Memory-origin items are out of scope

`promote_later_memory_origin` items in the input `backlog.json` are
**intentionally skipped** by this assistant — memory→formal promotion
is operator-only and not a template rewrite. They appear in
`skipped.md` with their ids so the operator sees the full coverage of
the input.

## Output structure

```
backlog-rewrites-<YYYY-MM-DD>/
├── summary.md                              # counts + input sha256 + review-deadline + run metadata
├── positional-debate-rewrites.md           # one section per draft
├── missing-evidence-path-repairs.md        # one section per draft
├── skipped.md                              # ids not drafted, with reasons
└── rewrites.json                           # structured payload, sorted by id
```

## Determinism

Items are sorted by `id` lexicographically. The only clock-derived
value embedded in `summary.md` is the `Generated:` line — everything
else (review deadline, draft bodies) is template-deterministic. Pin
`--now` AND `--review-deadline` for byte-identical reruns over the same
input. The determinism test
(`server/__tests__/draftBacklogRewrites.test.ts` case 4) asserts
sha256-equality across both `rewrites.json` and all `.md` files.

## See also

- `docs/MANUAL_BACKLOG_EXPORT.md` — the step-1 export tool.
- `examples/backlog-rewrites-sample/` — sample output for shape comparison
  (synthetic fixture).
- `scripts/hypothesisReset.ts` — the operator-only archive CLI, which is
  the existing apply surface. The rewrite assistant does NOT replace it
  and does NOT call it.
