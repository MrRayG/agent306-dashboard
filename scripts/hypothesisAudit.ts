/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS HYGIENE AUDIT (Phase 1.5 + 1.5b CLI)
 *
 * Read-only utility. Two modes:
 *
 *  Formal mode (default) — load `data/research_lab.json` (or any file with a
 *  `hypotheses[]` array), run `auditHypotheses`, and print a triage summary.
 *
 *  Memory mode — when `--memory-file` is supplied, load a knowledge file
 *  shaped like `data/memory_knowledge.json` (`entries[]`), detect entries
 *  whose `title` starts with `Hypothesis:`, and run the Phase 1.5b memory
 *  hygiene audit. Memory-origin entries can NEVER feed Phase 2 directly;
 *  this CLI prints that verdict and the per-entry breakdown so an operator
 *  can decide whether to promote any of them to formal hypotheses.
 *
 * Run:
 *   npx tsx scripts/hypothesisAudit.ts
 *   npx tsx scripts/hypothesisAudit.ts --json
 *   npx tsx scripts/hypothesisAudit.ts --file path/to/lab.json
 *   npx tsx scripts/hypothesisAudit.ts --memory-file data/memory_knowledge.json
 *   npx tsx scripts/hypothesisAudit.ts --memory-file /app/data/memory_knowledge.json --details
 *
 * NEVER writes back to research_lab.json or memory_knowledge.json. Annotation
 * is operator-only and happens through the dashboard / a separate write path.
 * This is the reporting half of the loop.
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
import {
  auditMemoryHypotheses,
  type MemoryKnowledgeFile,
  type MemoryHygieneReport,
} from "../server/memoryHypothesisHygiene.js";

interface CliOptions {
  jsonOutput: boolean;
  filePath: string;
  memoryFilePath?: string;
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
    } else if (a === "--memory-file" && argv[i + 1]) {
      opts.memoryFilePath = path.resolve(argv[++i]);
    } else if (a === "--stale-days" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) opts.staleDays = n;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: hypothesisAudit [--json] [--details] [--file path] [--memory-file path] [--stale-days N]\n" +
        "\n" +
        "  --json              emit a single JSON object instead of formatted report\n" +
        "  --details           include per-record verdict + blockers (text mode only)\n" +
        "  --file PATH         research lab JSON file (default: data/research_lab.json)\n" +
        "  --memory-file PATH  audit hypothesis-titled entries in a memory_knowledge-shaped file\n" +
        "                      (entries whose title starts with 'Hypothesis:'). Reports counts,\n" +
        "                      tier/category/weight breakdown, and the verdict that no raw\n" +
        "                      memory entry can feed Phase 2 experiments directly.\n" +
        "  --stale-days N      consider forming/testing records older than N days as stale (default 30)\n",
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

function loadMemoryFile(filePath: string): MemoryKnowledgeFile {
  if (!fs.existsSync(filePath)) {
    console.error(`[hypothesisAudit] memory file not found: ${filePath}`);
    process.exit(1);
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e: any) {
    console.error(`[hypothesisAudit] failed to parse ${filePath}: ${e.message}`);
    process.exit(1);
  }
  if (raw === null || typeof raw !== "object") {
    console.error(`[hypothesisAudit] memory file is not a JSON object: ${filePath}`);
    process.exit(1);
  }
  // memory_soul.json and similar files lack `entries[]`. Treat that as
  // an empty hypothesis file rather than an error so the same CLI invocation
  // works across all memory shapes.
  return raw as MemoryKnowledgeFile;
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

function printMemoryText(report: MemoryHygieneReport, showDetails: boolean): void {
  const line = (s: string) => process.stdout.write(s + "\n");

  line("─────────────────────────────────────────────────────────────────────────");
  line(" 306 — Memory-Origin Hypothesis Hygiene Audit (Phase 1.5b)");
  line(`   generated:        ${report.generatedAt}`);
  if (report.source) line(`   source:           ${report.source}`);
  line(`   totalEntries:     ${report.totalEntries}`);
  line(`   hypothesisCount:  ${report.hypothesisCount}`);
  line(`   promoted:         ${report.promotedCount}`);
  line(`   unpromoted:       ${report.unpromotedCount}`);
  line("─────────────────────────────────────────────────────────────────────────");

  if (report.hypothesisCount === 0) {
    line("");
    line(report.readinessSummary);
    line("");
    return;
  }

  if (Object.keys(report.byTier).length > 0) {
    line("\nBy tier:");
    for (const [k, n] of Object.entries(report.byTier)) {
      line(`  ${k.padEnd(20)}  ${n}`);
    }
  }
  if (Object.keys(report.byCategory).length > 0) {
    line("\nBy category:");
    for (const [k, n] of Object.entries(report.byCategory)) {
      line(`  ${k.padEnd(20)}  ${n}`);
    }
  }
  if (Object.keys(report.byWeight).length > 0) {
    line("\nBy weight:");
    for (const [k, n] of Object.entries(report.byWeight)) {
      line(`  weight=${k.padEnd(14)}  ${n}`);
    }
  }
  if (Object.keys(report.byTag).length > 0) {
    line("\nBy hygiene tag (memory-origin):");
    for (const [k, n] of Object.entries(report.byTag)) {
      line(`  ${k.padEnd(24)}  ${n}`);
    }
  }

  if (showDetails) {
    line("\nPer-entry verdicts:");
    for (const v of report.verdicts) {
      const t = (v.title ?? "").slice(0, 76);
      line(`  [#${String(v.index).padStart(3)}] ${v.id.padEnd(20)} tier=${(v.tier ?? "?").padEnd(12)} ` +
           `tag=${v.tag.padEnd(20)} learnedAt=${v.learnedAt ?? "?"}`);
      line(`         "${t}"`);
      if (v.promotedToHypothesisId) {
        line(`         promotedToHypothesisId=${v.promotedToHypothesisId}`);
      }
    }
  }

  line("");
  line(report.readinessSummary);
  line("");
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.memoryFilePath) {
    const file = loadMemoryFile(opts.memoryFilePath);
    const report = auditMemoryHypotheses(file, { source: opts.memoryFilePath });
    if (opts.jsonOutput) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    printMemoryText(report, opts.showDetails);
    return;
  }

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
