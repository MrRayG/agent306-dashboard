# Skill: kb-accumulation-gate

**Owner:** agent306-safety
**Status:** registered (PR #414 — first true autonomy-expanding skill)
**Card:** [`SKILLCARD.yaml`](./SKILLCARD.yaml)

## Purpose

Closes the chronic broken-commitment loop the operator surfaced after the
Reasoning Quality v2.6 score drop:

> "Every cycle SelfEvolution emits the same `ratio_rule` corrective
> obligation for KB accumulation (kb_added/archived ratio violated), the
> obligation gets logged, and nothing actually happens. The KB keeps
> growing. The score keeps falling."

This skill wires that propose-only ratio_rule obligation into a
self-healing, env-gated, default-OFF pre-write gate. When
`KB_ACCUMULATION_GATE_ENABLED=true` and the configured kb_added/archived
ratio is violated at the moment of `addKnowledge`, the gate:

1. Reads a backup snapshot of the entries that would be archived to
   `/data/kb_auto_archive_backup_<iso>.json` (single backup per tick).
2. Routes up to `KB_ACCUMULATION_AUTO_ARCHIVE_CAP` (default 3) status
   mutations through the EXISTING `archiveKnowledge` write site at
   `server/memoryEngine.ts:908` — the same boundary the operator CLI
   uses. Pin 11 (single-write-site preserved) holds.
3. Appends a `kb_ratio_satisfaction` event per archive to
   `data/rule_corrective_obligations.jsonl` for telemetry.
4. Lets the `addKnowledge` write proceed regardless. The gate is NOT a
   hard block — it self-heals what it can and never refuses a write.

## Configuration (default OFF)

| Env var                              | Default | Meaning                            |
| ------------------------------------ | ------- | ---------------------------------- |
| `KB_ACCUMULATION_GATE_ENABLED`       | unset   | Master switch (must be "true")     |
| `KB_ACCUMULATION_RATIO_ADD`          | 10      | N in "for every N added"           |
| `KB_ACCUMULATION_RATIO_ARCHIVE`      | 3       | M in "archive at least M"          |
| `KB_ACCUMULATION_AUTO_ARCHIVE_CAP`   | 3       | Max auto-archives per write        |
| `KB_ACCUMULATION_BACKUP_DIR`         | DATA_DIR| Override for backup file directory |

## Qualifying stale entries (do NOT touch live content)

An entry is eligible for auto-archive only if ALL hold:

- `status === "active"` (or undefined, the legacy default).
- `tier` is neither `"core"` nor `"active"`.
- Age (`now - learnedAt`) > 30 days.
- No `updatedAt` newer than 30 days.

Entries are sorted by oldest `learnedAt` ASC, then capped at
`KB_ACCUMULATION_AUTO_ARCHIVE_CAP`.

## Safety posture

- **Default OFF.** Without the env flag the gate is dormant —
  `addKnowledge` behaves identically to pre-PR (pinned in test 1).
- **Reversible.** Per-tick backup file lets an operator restore the
  before-snapshot. Unsetting the env var stops the gate immediately.
- **Single-write-site preserved.** No new `status = "archived"`
  assignment. All status mutations go through `archiveKnowledge`. Pin
  11 holds (`git grep -nE 'status\s*[:=]\s*"archived"' server/`).
- **Blast radius: single-class.** Only `KnowledgeEntry.status` is
  mutated. No new entity types, no public surface, no scheduler.
- **Backup-then-mutate.** If the backup write fails the gate refuses
  to archive and the write proceeds without intervention.
- **No new public surface.** No HTTP endpoint, no cron, no UI control.

## What this skill is NOT

- **Not a hard block on KB writes.** `addKnowledge` always succeeds.
- **Not a deletion path.** `writes.archive_delete` stays `false`.
  Status mutation on an existing entry is not a delete; conflating
  them would widen blast radius.
- **Not a scheduler change.** Triggered only from existing
  `addKnowledge` call sites.
- **Not an operator policy widening.** `propose_only` remains `true`;
  `promotion_authority` remains `"none"`. The expansion is bounded by
  the env flag, the cap, the qualifying filter, and the existing
  archive boundary.

## Followups (NOT in this PR)

- PR #415: `rewrite_rule` automation loops (separate primitive,
  separate write path).
- PR #416+: Stage 10/11 dashboard surfaces for gate state visibility.
- Future: `draft_output_artifact` archive automation (content-adjacent,
  needs its own write-boundary review).
