#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS RESET CLI (operator-only, dry-run by default)
 *
 *   tsx scripts/hypothesisReset.ts                 # full report, no writes
 *   tsx scripts/hypothesisReset.ts --report=json   # JSON form (machine-readable)
 *   tsx scripts/hypothesisReset.ts --bucket=archive_stale          # dry-run apply plan
 *   tsx scripts/hypothesisReset.ts --bucket=archive_stale --apply  # ACTUAL archive
 *
 * Hard rules:
 *   - Default mode is dry-run (no `--apply`). Even with `--bucket=…`, the
 *     CLI prints the plan and exits without writing.
 *   - `--apply` is the ONLY way to flip the actual `research_lab.json`. The
 *     write is an archive (status → stale-retired + hygieneTag → archived_*),
 *     never a delete. The full snapshot is backed up to
 *     `data/hypothesis_reset_backup_<ISO>.json` first; if the backup fails
 *     the apply refuses.
 *   - Only the SAFE_APPLY_BUCKETS set (archive_stale, archive_data_unavailable,
 *     archive_duplicate) is eligible. rewrite_* / needs_operator_review /
 *     keep_active / promote_later_memory_origin require manual review and
 *     are hard-refused by `computeApplyPlan`.
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
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { apply: false, reportFmt: "text", buckets: [], showHelp: false };
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
    }
  }
  return out;
}

const HELP = `Hypothesis Reset CLI (operator-only)

usage:
  tsx scripts/hypothesisReset.ts                       # print full reset report
  tsx scripts/hypothesisReset.ts --json                # JSON form of the report
  tsx scripts/hypothesisReset.ts --bucket=BUCKET       # dry-run apply for one bucket
  tsx scripts/hypothesisReset.ts --bucket=A --bucket=B # multiple buckets
  tsx scripts/hypothesisReset.ts --buckets=A,B,C       # CSV form
  tsx scripts/hypothesisReset.ts --bucket=A --apply    # WRITE (archive, not delete)

flags:
  --apply         Write the archive. Without this flag the CLI is dry-run only.
  --bucket=…      Bucket to apply. Repeatable. Must be in:
                  ${SAFE_APPLY_BUCKETS.join(", ")}.
  --buckets=…     Same as --bucket but takes a comma-separated list.
  --json          Render the report in JSON instead of text.
  --help          Show this message.

archive vs delete:
  Apply ARCHIVES rows by setting status='stale-retired' and hygieneTag to
  archived_stale / archived_unsolvable / archived_irrelevant. Rows are NEVER
  removed from research_lab.json. A full pre-apply snapshot is written to
  data/hypothesis_reset_backup_<ISO>.json before any change.

freshness guard:
  Apply refuses if the on-disk record count or per-id classification has
  drifted from the underlying report, or if the report is > 24h old. Re-run
  the report before applying in that case.
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.buckets.length === 0 && !args.apply) {
    // Plain report mode.
    const report = buildResetReport();
    if (args.reportFmt === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatResetReport(report));
    }
    process.exit(0);
  }

  // Apply (dry-run by default unless --apply).
  const report = buildResetReport();
  if (args.apply && args.buckets.length === 0) {
    console.error("--apply requires at least one --bucket=… selection.");
    process.exit(1);
  }

  const result = runResetApply({
    selectedBuckets: args.buckets,
    apply:           args.apply,
    report,
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
  console.log(`Changes by bucket:`);
  for (const [b, n] of Object.entries(result.plan.countsByBucket)) {
    console.log(`  ${b}: ${n}`);
  }
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
  } else {
    console.log("");
    console.log(`APPLIED. Backup written to: ${result.backupPath ?? "(missing)"}`);
    console.log(`Records before=${result.countsBefore.total}, after=${result.countsAfter.total} (archive-not-delete).`);
  }
  process.exit(0);
}

main();
