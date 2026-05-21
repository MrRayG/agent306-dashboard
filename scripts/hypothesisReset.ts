#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS RESET CLI (operator-only, dry-run by default)
 *
 * LOCAL DEV (tsx available):
 *   tsx scripts/hypothesisReset.ts                 # full report, no writes
 *   tsx scripts/hypothesisReset.ts --report=json   # JSON form (machine-readable)
 *   tsx scripts/hypothesisReset.ts --bucket=archive_stale          # dry-run apply plan
 *   tsx scripts/hypothesisReset.ts --bucket=archive_stale --apply  # ACTUAL archive
 *   tsx scripts/hypothesisReset.ts --source=/abs/path/research_lab.json
 *   tsx scripts/hypothesisReset.ts --data-dir=/abs/path/to/data
 *
 * PRODUCTION (Railway SSH — tsx is pruned, use the bundled CJS):
 *   node dist/hypothesisReset.cjs                                  # full report
 *   node dist/hypothesisReset.cjs --bucket=archive_stale           # dry-run apply plan
 *   node dist/hypothesisReset.cjs --bucket=archive_stale --apply   # ACTUAL archive
 *   (The bundle is produced by the Dockerfile via esbuild; see PR #411.)
 *
 * Hard rules:
 *   - Default mode is dry-run (no `--apply`). Even with `--bucket=…`, the
 *     CLI prints the plan and exits without writing.
 *   - `--apply` is the ONLY way to flip the actual `research_lab.json`. The
 *     write is an archive (status → stale-retired + hygieneTag → archived_*),
 *     never a delete. The full snapshot is backed up to
 *     `data/hypothesis_reset_backup_<ISO>.json` first; if the backup fails
 *     the apply refuses.
 *   - `--apply` is REFUSED when 0 formal records were loaded from the source
 *     (typical when DATA_DIR points at the wrong volume in production).
 *   - Only the SAFE_APPLY_BUCKETS set (archive_stale, archive_data_unavailable,
 *     archive_duplicate) is eligible. promote_later_memory_origin is HARD-
 *     REFUSED — memory→formal promotion is operator-only and out of scope
 *     for this CLI. rewrite_* / needs_operator_review / keep_active also
 *     require manual review and are hard-refused.
 *   - `--source=<abs path>` overrides the formal-store path entirely.
 *     `--data-dir=<abs path>` re-roots the discovery (also relocates
 *     memory_knowledge.json). Both are operator-only knobs; nothing in the
 *     runtime passes them.
 *   - The CLI is OUT of the runtime / scheduler / autonomous loop. It is a
 *     foreground operator action.
 *
 * Exit codes:
 *   0 = success (report rendered or apply succeeded)
 *   1 = CLI usage / argument error
 *   2 = apply refused (stale report, no records, bucket not safe, …)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { buildResetReport, formatResetReport, type HypothesisResetReport } from "../server/hypothesisResetReport.ts";
import { runResetApply, SAFE_APPLY_BUCKETS } from "../server/hypothesisResetApply.ts";
import type { ResetBucket } from "../server/hypothesisIntakeAuditVisibility.ts";

interface ParsedArgs {
  apply:    boolean;
  reportFmt: "text" | "json";
  buckets:  ResetBucket[];
  showHelp: boolean;
  sourcePath: string | null;
  dataDir:    string | null;
  confirmSource: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    apply: false,
    reportFmt: "text",
    buckets: [],
    showHelp: false,
    sourcePath: null,
    dataDir: null,
    confirmSource: null,
  };
  for (const a of argv) {
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") out.showHelp = true;
    else if (a === "--report=json" || a === "--json") out.reportFmt = "json";
    else if (a === "--report=text") out.reportFmt = "text";
    else if (a.startsWith("--bucket=")) {
      const b = a.slice("--bucket=".length) as ResetBucket;
      out.buckets.push(b);
    } else if (a.startsWith("--buckets=")) {
      for (const b of a.slice("--buckets=".length).split(",")) {
        const t = b.trim();
        if (t) out.buckets.push(t as ResetBucket);
      }
    } else if (a.startsWith("--source=")) {
      out.sourcePath = a.slice("--source=".length).trim() || null;
    } else if (a.startsWith("--data-dir=")) {
      out.dataDir = a.slice("--data-dir=".length).trim() || null;
    } else if (a.startsWith("--confirm-source=")) {
      out.confirmSource = a.slice("--confirm-source=".length).trim().toLowerCase() || null;
    }
  }
  return out;
}

const HELP = `Hypothesis Reset CLI (operator-only)

usage (local dev, tsx available):
  tsx scripts/hypothesisReset.ts                       # print full reset report
  tsx scripts/hypothesisReset.ts --json                # JSON form of the report
  tsx scripts/hypothesisReset.ts --bucket=BUCKET       # dry-run apply for one bucket
  tsx scripts/hypothesisReset.ts --bucket=A --bucket=B # multiple buckets
  tsx scripts/hypothesisReset.ts --buckets=A,B,C       # CSV form
  tsx scripts/hypothesisReset.ts --bucket=A --apply    # WRITE (archive, not delete)
  tsx scripts/hypothesisReset.ts --bucket=A --apply --confirm-source=db
                                                       # WRITE against the SQLite DB row
  tsx scripts/hypothesisReset.ts --source=/abs/path/research_lab.json
  tsx scripts/hypothesisReset.ts --data-dir=/abs/path/to/data

usage (Railway SSH, tsx pruned — use the bundled CJS):
  node dist/hypothesisReset.cjs                        # print full reset report
  node dist/hypothesisReset.cjs --bucket=archive_stale # dry-run apply plan
  node dist/hypothesisReset.cjs --bucket=archive_stale --apply
                                                       # ACTUAL archive write
  (Same flags as the tsx invocation. Bundle built by Dockerfile, PR #411.)

flags:
  --apply         Write the archive. Without this flag the CLI is dry-run only.
                  REFUSED when 0 formal records are loaded from the source.
  --bucket=…      Bucket to apply. Repeatable. Must be in:
                  ${SAFE_APPLY_BUCKETS.join(", ")}.
                  promote_later_memory_origin is hard-refused — memory→formal
                  promotion is operator-only and out of scope for this CLI.
                  rewrite_* and needs_operator_review are hard-refused too.
  --buckets=…     Same as --bucket but takes a comma-separated list.
  --json          Render the report in JSON instead of text.
  --source=PATH   Absolute path to a formal research_lab.json. Bypasses the
                  default DATA_DIR/research_lab.json discovery. Operator-only.
  --data-dir=DIR  Re-root the source discovery (relocates BOTH research_lab.json
                  AND memory_knowledge.json under DIR). Operator-only.
  --confirm-source=db
                  REQUIRED for --apply when the report's formal-chosen source is
                  the SQLite DB row (post-migration deployments). Acknowledges
                  that the archive write will go through getResearchLab() →
                  saveResearchLab() and mutate the DB blob. Only the safe
                  archive buckets are eligible. A pre-apply DB-blob snapshot is
                  written to data/hypothesis_reset_db_backup_<iso>.json before
                  any write. Refusal codes: db_source_confirmation_required,
                  source_changed_between_report_and_apply.
  --help          Show this message.

archive vs delete:
  Apply ARCHIVES rows by setting status='stale-retired' and hygieneTag to
  archived_stale / archived_unsolvable / archived_irrelevant. Rows are NEVER
  removed from research_lab.json (or the DB blob). A full pre-apply snapshot
  is written to data/hypothesis_reset_backup_<ISO>.json (JSON source) or
  data/hypothesis_reset_db_backup_<ISO>.json (DB source) before any change.

DB-aware apply (post-migration):
  After scripts/migrate_json_to_db.ts runs, research_lab.json is renamed to
  .bak and the canonical store lives in the SQLite row
  research_lab[id='main'].blob.hypotheses[]. The CLI detects this via source
  discovery and switches its backup format + write path to the DB. --apply
  still requires --confirm-source=db so the operator explicitly confirms the
  write target. Only safe archive buckets are eligible; the rewrite_* /
  promote_later_memory_origin / needs_operator_review buckets stay refused.

memory-origin coverage:
  When the formal store is missing or empty, the report ALSO classifies
  memory-origin hypothesis-titled entries from memory_knowledge.json into the
  promote_later_memory_origin bucket so the operator can see promotion
  candidates instead of "all zero". These entries are NEVER applied by the
  CLI — promotion is operator-only.

freshness guard:
  Apply refuses if the on-disk record count or per-id classification has
  drifted from the underlying report, or if the report is > 24h old, or if
  the discovered formal-chosen source has moved between the report and the
  apply (source_changed_between_report_and_apply). Re-run the report before
  applying in that case.
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    console.log(HELP);
    process.exit(0);
  }

  const buildOpts: Parameters<typeof buildResetReport>[0] = {};
  if (args.sourcePath) buildOpts.sourcePath = args.sourcePath;
  if (args.dataDir) buildOpts.dataDir = args.dataDir;

  if (args.buckets.length === 0 && !args.apply) {
    // Plain report mode.
    const report = buildResetReport(buildOpts);
    if (args.reportFmt === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatResetReport(report));
    }
    process.exit(0);
  }

  // Apply (dry-run by default unless --apply).
  const report = buildResetReport(buildOpts);
  if (args.apply && args.buckets.length === 0) {
    console.error("--apply requires at least one --bucket=… selection.");
    process.exit(1);
  }

  // Build the apply options. The apply path reads the formal store on its
  // own, but must honour the same overrides — we don't currently thread
  // overrides into runResetApply's lab loader because the production CLI
  // always operates on the real DATA_DIR. Surface a clear refusal if the
  // operator combined --apply with a --source override so they don't
  // accidentally apply against the wrong store.
  if (args.apply && (args.sourcePath || args.dataDir)) {
    console.error(
      "--apply combined with --source/--data-dir is not supported. " +
      "Run the report with the override first, validate it, then re-run --apply " +
      "after pointing the runtime DATA_DIR at the same store.",
    );
    process.exit(1);
  }

  const confirmDbSource = args.confirmSource === "db";
  if (args.confirmSource !== null && args.confirmSource !== "db") {
    console.error(
      `--confirm-source=${args.confirmSource} is not recognized. ` +
      `Only --confirm-source=db is currently supported (it confirms the operator wants the apply to ` +
      `write through the SQLite DB blob).`,
    );
    process.exit(1);
  }

  const result = runResetApply({
    selectedBuckets: args.buckets,
    apply:           args.apply,
    report,
    confirmDbSource,
  });

  if (!result.ok) {
    console.error(`Refused: ${result.reason} — ${result.detail}`);
    if (result.plan) {
      console.error(`Plan was: ${result.plan.changes.length} change(s), ${result.plan.skipped.length} skipped.`);
    }
    process.exit(2);
  }

  console.log(result.summary);
  console.log("");
  console.log(`Selected buckets: [${result.plan.selectedBuckets.join(", ")}]`);
  console.log(`Source role:      ${result.sourceRole}`);
  console.log(`Changes by bucket:`);
  for (const [b, n] of Object.entries(result.plan.countsByBucket)) {
    console.log(`  ${b}: ${n}`);
  }
  console.log(`Changed IDs: ${result.plan.changes.length}`);
  if (result.plan.skipped.length > 0) {
    console.log(`Skipped (${result.plan.skipped.length}):`);
    for (const s of result.plan.skipped.slice(0, 20)) {
      console.log(`  - ${s.id} :: ${s.reason}`);
    }
    if (result.plan.skipped.length > 20) {
      console.log(`  … and ${result.plan.skipped.length - 20} more.`);
    }
  }
  if (result.mode === "dry_run") {
    console.log("");
    console.log("DRY-RUN — no changes written. Pass --apply to perform the archive.");
    if (result.sourceRole === "db") {
      console.log("Source is the SQLite DB blob — --apply will also require --confirm-source=db.");
    }
  } else {
    console.log("");
    console.log(`APPLIED. Backup written to: ${result.backupPath ?? "(missing)"}`);
    console.log(`Records before=${result.countsBefore.total}, after=${result.countsAfter.total} (archive-not-delete).`);
  }
  process.exit(0);
}

main();
