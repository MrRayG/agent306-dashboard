/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS HYGIENE AUDIT (Phase 1.5 CLI)
 *
 * Read-only utility. Loads `data/research_lab.json` (and the archive backup
 * if present), runs `auditHypotheses`, and prints a triage summary so an
 * operator can decide what to mark as `archived_*`, `needs_data`, etc.
 *
 * Run:   npx tsx scripts/hypothesisAudit.ts
 *        npx tsx scripts/hypothesisAudit.ts --json
 *        npx tsx scripts/hypothesisAudit.ts --file path/to/lab.json
 *
 * NEVER writes back to research_lab.json. Annotation is operator-only and
 * happens through the dashboard / a separate write path. This is the
 * reporting half of the loop.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  auditHypotheses,
  classifyHypothesis,
  readinessBlockers,
  HYGIENE_TAGS,
  type HygieneAwareHypothesis,
} from "../server/hypothesisHygiene.js";

interface CliOptions {
  jsonOutput: boolean;
  filePath: string;
  staleDays: number;
  showDetails: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    jsonOutput: false,
    filePath: path.join(process.cwd(), "data", "research_lab.json"),
    staleDays: 30,
    showDetails: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.jsonOutput = true;
    else if (a === "--details") opts.showDetails = true;
    else if (a === "--file" && argv[i + 1]) {
      opts.filePath = path.resolve(argv[++i]);
    } else if (a === "--stale-days" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) opts.staleDays = n;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: hypothesisAudit [--json] [--details] [--file path] [--stale-days N]\n" +
        "\n" +
        "  --json         emit a single JSON object instead of formatted report\n" +
        "  --details      include per-hypothesis tag + blockers (text mode only)\n" +
        "  --file PATH    research lab JSON file (default: data/research_lab.json)\n" +
        "  --stale-days N consider forming/testing records older than N days as stale (default 30)\n",
      );
      process.exit(0);
    }
  }
  return opts;
}

function loadHypotheses(filePath: string): HygieneAwareHypothesis[] {
  if (!fs.existsSync(filePath)) {
    console.error(`[hypothesisAudit] file not found: ${filePath}`);
    process.exit(1);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e: any) {
    console.error(`[hypothesisAudit] failed to parse ${filePath}: ${e.message}`);
    process.exit(1);
  }
  // Tolerate both research_lab.json shape ({ hypotheses: [...] }) and
  // hypothesis_archive.json shape ({ hypotheses: [...], archivedAt, ... }).
  const arr = Array.isArray(raw?.hypotheses) ? raw.hypotheses : Array.isArray(raw) ? raw : null;
  if (!arr) {
    console.error(`[hypothesisAudit] no hypotheses[] found in ${filePath}`);
    process.exit(1);
  }
  return arr as HygieneAwareHypothesis[];
}

function printText(report: ReturnType<typeof auditHypotheses>, hyps: HygieneAwareHypothesis[], showDetails: boolean): void {
  const line = (s: string) => process.stdout.write(s + "\n");

  line("─────────────────────────────────────────────────────────────────────────");
  line(" 306 — Hypothesis Hygiene Audit");
  line(`   generated: ${report.generatedAt}`);
  line(`   total:     ${report.total}`);
  line(`   ready:     ${report.readyCount}`);
  line(`   archived:  ${report.archivedCount}`);
  line("─────────────────────────────────────────────────────────────────────────");

  line("\nBy hygiene tag:");
  for (const tag of HYGIENE_TAGS) {
    const n = report.byTag[tag] ?? 0;
    if (n > 0) line(`  ${tag.padEnd(24)}  ${n}`);
  }

  line("\nBy lifecycle status:");
  for (const [s, n] of Object.entries(report.byStatus)) {
    line(`  ${s.padEnd(24)}  ${n}`);
  }

  if (Object.keys(report.fieldGapCounts).length > 0) {
    line("\nMissing readiness fields:");
    for (const [f, n] of Object.entries(report.fieldGapCounts)) {
      line(`  ${f.padEnd(24)}  ${n}`);
    }
  }

  if (report.duplicateGroups.length > 0) {
    line(`\nDuplicate-claim groups (${report.duplicateGroups.length}):`);
    for (const g of report.duplicateGroups.slice(0, 20)) {
      const trimmed = g.normalizedClaim.length > 80 ? g.normalizedClaim.slice(0, 77) + "..." : g.normalizedClaim;
      line(`  [${g.ids.length}] ${trimmed}`);
      for (const id of g.ids) line(`        - ${id}`);
    }
    if (report.duplicateGroups.length > 20) {
      line(`  ... ${report.duplicateGroups.length - 20} more`);
    }
  }

  if (report.staleCandidates.length > 0) {
    line(`\nStale active hypotheses (${report.staleCandidates.length}):`);
    for (const s of report.staleCandidates.slice(0, 30)) {
      line(`  ${s.id.padEnd(28)} status=${s.status.padEnd(10)} ageDays=${s.ageDays}`);
    }
    if (report.staleCandidates.length > 30) {
      line(`  ... ${report.staleCandidates.length - 30} more`);
    }
  }

  if (showDetails) {
    line("\nPer-hypothesis verdicts:");
    for (const h of hyps) {
      const { tag, reasons } = classifyHypothesis(h);
      const blockers = readinessBlockers(h);
      const claim = (h.claim ?? "").slice(0, 70);
      line(`  ${h.id.padEnd(28)} ${tag.padEnd(22)} "${claim}"`);
      if (blockers.length > 0) line(`        blockers: ${blockers.join("; ")}`);
      if (reasons.length > 0) line(`        reasons:  ${reasons.join("; ")}`);
    }
  }

  line("");
  line("Phase 2 readiness gate (canFeedExperiment) accepts only `ready_for_experiment`");
  line("and `candidate` tags whose readiness fields are complete.");
  line("");
}

async function main() {
  const opts = parseArgs(process.argv);
  const hyps = loadHypotheses(opts.filePath);
  const report = auditHypotheses(hyps, { staleDays: opts.staleDays });

  if (opts.jsonOutput) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  printText(report, hyps, opts.showDetails);
}

main().catch(e => {
  console.error("[hypothesisAudit] fatal:", e);
  process.exit(1);
});
