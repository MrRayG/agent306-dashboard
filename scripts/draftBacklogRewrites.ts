#!/usr/bin/env tsx
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — BACKLOG REWRITE ASSISTANT (operator-only, READ-ONLY, TEMPLATE-ONLY)
 *
 * Consumes a `backlog.json` produced by `scripts/exportManualBacklog.ts`
 * and emits per-item DRAFT rewrites that an operator copy/edits/applies
 * manually. Pairs with the export tool: export → draft → review →
 * operator applies the edit via the existing UI / CLI surface.
 *
 * Propose-only invariant. This script:
 *   - Never reads or writes the SQLite DB.
 *   - Never reads or writes research_lab.json / .bak / memory_knowledge.json.
 *   - Never changes any hypothesis status, hygieneTag, or other field.
 *   - Never archives, promotes, or applies anything.
 *   - Never calls an LLM. Output is deterministic from input (template +
 *     literal text). The same `--input` + `--now` + `--review-deadline`
 *     yields byte-identical `rewrites.json` across runs.
 *   - Never guesses a bucket. Items missing a `bucket` field go to
 *     `skipped.md` with reason "missing bucket tag".
 *   - Always emits at least one `TODO` and one "DRAFT — operator must
 *     edit before applying" sentinel per item. Drafts must never look
 *     "done". Operator review is the bright line.
 *
 * Memory-origin items (`promote_later_memory_origin`) are intentionally
 * skipped — memory→formal promotion is operator-only and out of scope
 * for this assistant.
 *
 * Usage:
 *   npx tsx scripts/draftBacklogRewrites.ts --input=./backlog-export/backlog.json
 *   npx tsx scripts/draftBacklogRewrites.ts --input=./backlog-export/backlog.json \
 *     --out-dir=./backlog-rewrites-2026-05-18 \
 *     --review-deadline=2026-06-01
 *   npx tsx scripts/draftBacklogRewrites.ts --input=... --dry-run
 *
 * Flags:
 *   --input <path>            Required. Path to a backlog.json produced
 *                             by `scripts/exportManualBacklog.ts`.
 *   --out-dir <path>          Directory for the draft artefacts.
 *                             Defaults to ./backlog-rewrites-<UTC-date>.
 *   --buckets <a,b>           Comma-separated buckets to draft. Default:
 *                             rewrite_positional_debate,
 *                             rewrite_missing_evidence_path.
 *   --review-deadline <iso>   ISO date inserted into every draft as the
 *                             review deadline. Defaults to 14 days from
 *                             --now (or wall-clock, if --now unset).
 *   --now <iso>               Pin all clock-derived values for byte-
 *                             deterministic test / repro runs.
 *   --dry-run                 Print counts; write nothing.
 *   -h, --help                Print this usage and exit 0.
 *
 * Exit codes:
 *   0  success
 *   1  CLI usage error (missing --input, unknown flag, bad date, …)
 *   2  --input file unreadable or not a valid backlog-export JSON
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";

// ── Input schema (mirrors scripts/exportManualBacklog.ts BacklogExportPayload) ─

export interface BacklogExportItem {
  id:                  string;
  bucket?:             string;
  origin?:             "formal" | "memory";
  claim?:              string;
  status?:             string;
  formedAt?:           string | null;
  source?:             string | null;
  presentFields?:      string[];
  missingFields?:      string[];
  recommendedAction?:  string;
  classifierReasons?:  string[];
  intakeVerdict?:      string;
}

export interface BacklogExportPayload {
  schemaVersion?:  string;
  generatedAt?:    string | null;
  dataDir?:        string;
  source?:         string;
  gitSha?:         string | null;
  bucketsIncluded?: string[];
  includeArchived?: boolean;
  counts?:         Record<string, number>;
  items:           BacklogExportItem[];
}

// ── Output schema ───────────────────────────────────────────────────────────

export const REWRITE_BUCKETS = [
  "rewrite_positional_debate",
  "rewrite_missing_evidence_path",
] as const;
export type RewriteBucket = typeof REWRITE_BUCKETS[number];

export const DRAFT_SENTINEL = "DRAFT — operator must edit before applying";

export interface DraftEntry {
  id:               string;
  bucket:           RewriteBucket;
  /** Echoed from the input for stable diffs. */
  originalClaim:    string;
  originalSource:   string | null;
  reviewDeadline:   string;
  /** Field names listed as present by the export (no values; the export
   *  does not carry per-field values). */
  presentFields:    string[];
  /** Conceptual fields the assistant requires for this bucket. */
  missingFields:    string[];
  /** Rendered Markdown for this single draft (pinnable for tests). */
  markdown:         string;
}

export interface SkippedEntry {
  id:     string;
  reason: string;
  bucket: string | null;
}

export interface RewritePayload {
  schemaVersion:    "backlog-rewrite-draft-1";
  generatedAt:      string | null;
  reviewDeadline:   string;
  inputPath:        string;
  inputSha256:      string;
  inputSchema:      string | null;
  gitSha:           string | null;
  bucketsRequested: RewriteBucket[];
  counts: {
    rewrite_positional_debate:     number;
    rewrite_missing_evidence_path: number;
    skipped:                       number;
  };
  drafts:  DraftEntry[];
  skipped: SkippedEntry[];
}

// ── CLI parsing ─────────────────────────────────────────────────────────────

export interface CliArgs {
  input:          string | null;
  outDir:         string | null;
  buckets:        RewriteBucket[];
  reviewDeadline: string | null;
  now:            string | null;
  dryRun:         boolean;
  showHelp:       boolean;
}

const HELP_TEXT = [
  "Backlog Rewrite Assistant (read-only, template-only)",
  "",
  "Usage:",
  "  npx tsx scripts/draftBacklogRewrites.ts --input=<backlog.json> [flags]",
  "",
  "Flags:",
  "  --input <path>            Required. backlog.json from exportManualBacklog.ts.",
  "  --out-dir <path>          Output directory (default: ./backlog-rewrites-<UTC-date>).",
  "  --buckets <a,b>           Comma-separated buckets to draft.",
  "                            Default: " + REWRITE_BUCKETS.join(","),
  "  --review-deadline <iso>   Review deadline inserted into drafts.",
  "                            Default: 14 days from --now (or wall clock).",
  "  --now <iso>               Pin clock-derived values for deterministic runs.",
  "  --dry-run                 Print counts; write nothing.",
  "  -h, --help                Print this usage and exit 0.",
].join("\n");

export function parseArgs(argv: readonly string[]): { ok: true; args: CliArgs } | { ok: false; reason: string } {
  const args: CliArgs = {
    input:          null,
    outDir:         null,
    buckets:        [...REWRITE_BUCKETS],
    reviewDeadline: null,
    now:            null,
    dryRun:         false,
    showHelp:       false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { args.showHelp = true; continue; }
    if (a === "--dry-run") { args.dryRun = true; continue; }
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inlineVal = eq >= 0 ? a.slice(eq + 1) : null;
    const nextVal = (): string | null => {
      if (inlineVal !== null) return inlineVal;
      const n = argv[i + 1];
      if (typeof n === "string" && !n.startsWith("--")) { i++; return n; }
      return null;
    };
    switch (key) {
      case "--input": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--input requires a path" };
        args.input = v;
        break;
      }
      case "--out-dir": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--out-dir requires a path" };
        args.outDir = v;
        break;
      }
      case "--buckets": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--buckets requires a csv list" };
        const parsed: RewriteBucket[] = [];
        for (const tok of v.split(",")) {
          const t = tok.trim();
          if (!t) continue;
          if (!(REWRITE_BUCKETS as readonly string[]).includes(t)) {
            return { ok: false, reason: `unsupported bucket for rewrite assistant: ${t}. valid: ${REWRITE_BUCKETS.join(",")}` };
          }
          parsed.push(t as RewriteBucket);
        }
        if (parsed.length === 0) return { ok: false, reason: "--buckets parsed to empty list" };
        args.buckets = parsed;
        break;
      }
      case "--review-deadline": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--review-deadline requires an ISO date" };
        if (!Number.isFinite(Date.parse(v))) {
          return { ok: false, reason: `--review-deadline not a valid ISO date: ${v}` };
        }
        args.reviewDeadline = v;
        break;
      }
      case "--now": {
        const v = nextVal();
        if (!v) return { ok: false, reason: "--now requires an ISO timestamp" };
        if (!Number.isFinite(Date.parse(v))) {
          return { ok: false, reason: `--now not a valid ISO timestamp: ${v}` };
        }
        args.now = v;
        break;
      }
      default:
        return { ok: false, reason: `unknown flag: ${a}` };
    }
  }
  if (!args.showHelp && !args.input) {
    return { ok: false, reason: "--input is required" };
  }
  return { ok: true, args };
}

// ── Deterministic helpers ───────────────────────────────────────────────────

/** Default review deadline = `now` + 14 calendar days, rendered as a
 *  YYYY-MM-DD string in UTC. Pure. */
export function defaultReviewDeadline(now: Date): string {
  const ms = now.getTime() + 14 * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function defaultOutDir(now: Date): string {
  return `./backlog-rewrites-${now.toISOString().slice(0, 10)}`;
}

function safeGitShortSha(): string | null {
  try {
    const out = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      cwd:   path.resolve(new URL(".", import.meta.url).pathname, ".."),
    }).toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ── Templates ───────────────────────────────────────────────────────────────

/** Conceptual required fields per rewrite bucket. The assistant emits a
 *  TODO stub for each one when missing. These names are operator-facing
 *  and intentionally separate from the Hypothesis record's TypeScript
 *  field names — the assistant frames the rewrite in the operator's
 *  vocabulary. */
export const REQUIRED_REWRITE_FIELDS: Readonly<Record<RewriteBucket, readonly string[]>> = Object.freeze({
  rewrite_positional_debate: [
    "research_gap",
    "metric",
    "evidence_source",
    "measurement_path",
    "review_deadline",
  ],
  rewrite_missing_evidence_path: [
    "evidence_source",
    "dataset",
    "measurement_path",
    "review_deadline",
  ],
});

const FIELD_TODO_TEXT: Readonly<Record<string, string>> = Object.freeze({
  research_gap:     "Research gap: TODO (operator: convert the positional claim into a falsifiable empirical question.)",
  metric:           "Metric: TODO (operator: name the quantifiable metric and unit.)",
  evidence_source:  "Evidence source: TODO (operator: name a specific dataset, registry, regulatory filing, or primary source.)",
  dataset:          "Dataset: TODO (operator: identify the dataset row/table/endpoint.)",
  measurement_path: "Measurement path: TODO (operator: how the metric is computed end-to-end from the dataset.)",
});

const FIELD_REQUIREMENT_RATIONALE: Readonly<Record<string, string>> = Object.freeze({
  research_gap:
    "every hypothesis must encode a falsifiable empirical question with a yes/no resolution path; a positional claim cannot resolve.",
  metric:
    "the hypothesis must name a quantifiable measure (with units) so the resolution is unambiguous.",
  evidence_source:
    "the operator must name a specific primary source so the agent can verify it is accessible and stable.",
  dataset:
    "the operator must point at the row/table/endpoint inside the source so retrieval is reproducible.",
  measurement_path:
    "the operator must spell out how the metric is computed from the dataset so two runs of the agent yield the same value.",
  review_deadline:
    "every hypothesis must carry an explicit review deadline so it cannot drift indefinitely.",
});

/** Format the field name for operator display ("evidence_source" → "Evidence source"). */
function humanizeField(name: string): string {
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Bulleted list of present-field names, neutral phrasing. */
function renderPresentFields(present: readonly string[]): string {
  if (present.length === 0) return "_(none reported by the export)_";
  return present.map(f => `- \`${f}\``).join("\n");
}

/** Render the per-bucket "Missing required fields" section: each field
 *  name + the rationale describing WHY it is required. */
function renderMissingRequired(missing: readonly string[]): string {
  if (missing.length === 0) return "_(none — all required fields present)_";
  const lines: string[] = [];
  for (const f of missing) {
    const rationale = FIELD_REQUIREMENT_RATIONALE[f] ?? "required by the bucket's rewrite contract.";
    lines.push(`- **${humanizeField(f)}** — ${rationale}`);
  }
  return lines.join("\n");
}

/** Render the per-bucket "Proposed repair" stub list: one TODO line per
 *  missing required field, plus the pre-filled review_deadline. */
function renderProposedRepair(
  missingFields: readonly string[],
  reviewDeadline: string,
): string {
  const lines: string[] = [];
  for (const f of missingFields) {
    if (f === "review_deadline") {
      lines.push(`- Review deadline: ${reviewDeadline}`);
      continue;
    }
    const todo = FIELD_TODO_TEXT[f] ?? `${humanizeField(f)}: TODO (operator: fill this field.)`;
    lines.push(`- ${todo}`);
  }
  return lines.join("\n");
}

// Convenience constant — keeps the sentinel string in ONE place so the
// test's regex stays in sync with the renderer. Declared before render
// functions to avoid a TDZ trap.
const DRAFT_SENTENCE = DRAFT_SENTINEL;

/** Render a positional-debate draft. */
export function renderPositionalDebateDraft(args: {
  id: string;
  claim: string;
  source: string;
  reviewDeadline: string;
  exportPresentFields: readonly string[];
  exportMissingFields: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`### ${args.id}`);
  lines.push("");
  lines.push(`**Original claim:** ${args.claim}`);
  lines.push(`**Source:** ${args.source}`);
  lines.push(`**Original framing tag:** positional-debate`);
  lines.push("");
  lines.push(`#### Proposed research-gap rewrite (${DRAFT_SENTENCE})`);
  lines.push("");
  lines.push("> Research gap: TODO (operator: convert the positional claim into a falsifiable empirical question.)");
  lines.push(">");
  lines.push("> Metric: TODO (operator: name the quantifiable metric and unit.)");
  lines.push(">");
  lines.push("> Evidence source / dataset: TODO (operator: name a specific dataset or primary source.)");
  lines.push(">");
  lines.push("> Measurement path: TODO (operator: how is the metric computed from the data.)");
  lines.push(">");
  lines.push(`> Review deadline: ${args.reviewDeadline}`);
  lines.push("");
  lines.push("#### Why this is in the rewrite queue");
  lines.push("- Original framing is positional/normative rather than empirical");
  if (args.exportMissingFields.length > 0) {
    lines.push(`- Export missing fields: ${args.exportMissingFields.map(s => "`" + s + "`").join(", ")}`);
  }
  lines.push("");
  lines.push("#### Present fields (per export)");
  lines.push(renderPresentFields(args.exportPresentFields));
  lines.push("");
  lines.push("> Note: the export does not carry per-field values. Operator opens the lab to inspect originals.");
  lines.push("");
  lines.push("#### Operator checklist before applying");
  lines.push("- [ ] Replace \"Research gap\" stub with a falsifiable empirical question");
  lines.push("- [ ] Replace \"Metric\" stub with a quantifiable measure (with unit)");
  lines.push("- [ ] Name a specific evidence source (dataset, registry, document)");
  lines.push("- [ ] Define the measurement path");
  lines.push("- [ ] Confirm review deadline");
  lines.push("");
  return lines.join("\n");
}

/** Render a missing-evidence-path draft. */
export function renderMissingEvidencePathDraft(args: {
  id: string;
  claim: string;
  source: string;
  reviewDeadline: string;
  exportPresentFields: readonly string[];
  exportMissingFields: readonly string[];
}): string {
  // For this bucket, the conceptual "missing required fields" are
  // uniformly evidence_source + dataset + measurement_path + review_deadline.
  // The export's missingFields list (Hypothesis-shape names like
  // "measurementPath") is echoed for audit.
  const requiredMissing = REQUIRED_REWRITE_FIELDS.rewrite_missing_evidence_path;

  const lines: string[] = [];
  lines.push(`### ${args.id}`);
  lines.push("");
  lines.push(`**Original claim:** ${args.claim}`);
  lines.push(`**Source:** ${args.source}`);
  lines.push(`**Original framing tag:** missing-evidence-path`);
  lines.push("");
  lines.push("#### Present fields (per export)");
  lines.push(renderPresentFields(args.exportPresentFields));
  lines.push("");
  lines.push("#### Missing required fields");
  lines.push(renderMissingRequired(requiredMissing));
  if (args.exportMissingFields.length > 0) {
    lines.push("");
    lines.push(`Export-reported missing fields (Hypothesis-shape names): ${args.exportMissingFields.map(s => "`" + s + "`").join(", ")}`);
  }
  lines.push("");
  lines.push(`#### Proposed repair (${DRAFT_SENTENCE})`);
  lines.push("");
  lines.push(renderProposedRepair(requiredMissing, args.reviewDeadline));
  lines.push("");
  lines.push("#### Operator checklist before applying");
  lines.push("- [ ] Fill each TODO with a specific reference");
  lines.push("- [ ] Confirm the evidence source is accessible (not behind a paywall the agent cannot reach)");
  lines.push("- [ ] Confirm the measurement is reproducible");
  lines.push("- [ ] Confirm review deadline");
  lines.push("");
  return lines.join("\n");
}

// ── Build payload ───────────────────────────────────────────────────────────

export interface BuildPayloadInput {
  payload:         BacklogExportPayload;
  inputPath:       string;
  inputSha256:     string;
  buckets:         readonly RewriteBucket[];
  reviewDeadline:  string;
  generatedAt:     string | null;
  gitSha:          string | null;
}

export function buildPayload(input: BuildPayloadInput): RewritePayload {
  const allowed = new Set<string>(input.buckets);
  const drafts:  DraftEntry[]  = [];
  const skipped: SkippedEntry[] = [];

  const sortedItems = [...(input.payload.items ?? [])].sort((a, b) => {
    const ai = typeof a?.id === "string" ? a.id : "";
    const bi = typeof b?.id === "string" ? b.id : "";
    return ai.localeCompare(bi);
  });

  for (const it of sortedItems) {
    if (typeof it.id !== "string" || it.id.length === 0) {
      // Drop unidentifiable rows entirely — they can't be referenced by
      // an operator, so emitting a draft for them would be misleading.
      // Tracked in skipped under a synthetic id.
      skipped.push({
        id:     "(unknown)",
        reason: "missing id",
        bucket: typeof it.bucket === "string" ? it.bucket : null,
      });
      continue;
    }
    if (typeof it.bucket !== "string" || it.bucket.length === 0) {
      skipped.push({ id: it.id, reason: "missing bucket tag", bucket: null });
      continue;
    }
    if (!allowed.has(it.bucket)) {
      skipped.push({
        id:     it.id,
        reason: `bucket not in --buckets (${it.bucket})`,
        bucket: it.bucket,
      });
      continue;
    }

    const bucket = it.bucket as RewriteBucket;
    const claim = (typeof it.claim === "string" && it.claim.trim().length > 0)
      ? it.claim.trim()
      : "(claim missing in export)";
    const source = (typeof it.source === "string" && it.source.trim().length > 0)
      ? it.source.trim()
      : "(source missing in export)";
    const exportPresent = Array.isArray(it.presentFields)
      ? [...it.presentFields]
      : [];
    const exportMissing = Array.isArray(it.missingFields)
      ? [...it.missingFields]
      : [];

    const renderArgs = {
      id:                  it.id,
      claim,
      source,
      reviewDeadline:      input.reviewDeadline,
      exportPresentFields: exportPresent,
      exportMissingFields: exportMissing,
    };
    const markdown = bucket === "rewrite_positional_debate"
      ? renderPositionalDebateDraft(renderArgs)
      : renderMissingEvidencePathDraft(renderArgs);

    drafts.push({
      id:             it.id,
      bucket,
      originalClaim:  claim,
      originalSource: source === "(source missing in export)" ? null : source,
      reviewDeadline: input.reviewDeadline,
      presentFields:  exportPresent,
      missingFields:  [...REQUIRED_REWRITE_FIELDS[bucket]],
      markdown,
    });
  }

  drafts.sort((a, b) => a.id.localeCompare(b.id));
  skipped.sort((a, b) => a.id.localeCompare(b.id));

  const positionalCount = drafts.filter(d => d.bucket === "rewrite_positional_debate").length;
  const missingCount    = drafts.filter(d => d.bucket === "rewrite_missing_evidence_path").length;

  return {
    schemaVersion:    "backlog-rewrite-draft-1",
    generatedAt:      input.generatedAt,
    reviewDeadline:   input.reviewDeadline,
    inputPath:        input.inputPath,
    inputSha256:      input.inputSha256,
    inputSchema:      typeof input.payload.schemaVersion === "string" ? input.payload.schemaVersion : null,
    gitSha:           input.gitSha,
    bucketsRequested: [...input.buckets],
    counts: {
      rewrite_positional_debate:     positionalCount,
      rewrite_missing_evidence_path: missingCount,
      skipped:                       skipped.length,
    },
    drafts,
    skipped,
  };
}

// ── Markdown surfaces ───────────────────────────────────────────────────────

function renderSummary(payload: RewritePayload): string {
  const lines: string[] = [];
  lines.push("# Backlog Rewrite Assistant — Summary");
  lines.push("");
  lines.push(`- **Generated:** ${payload.generatedAt ?? "(not set)"}`);
  lines.push(`- **Input:** \`${payload.inputPath}\``);
  lines.push(`- **Input sha256:** \`${payload.inputSha256}\``);
  lines.push(`- **Input schema:** \`${payload.inputSchema ?? "(unknown)"}\``);
  lines.push(`- **Review deadline (applied to drafts):** ${payload.reviewDeadline}`);
  lines.push(`- **Git SHA:** ${payload.gitSha ?? "(unknown)"}`);
  lines.push(`- **Schema version:** \`${payload.schemaVersion}\``);
  lines.push(`- **Buckets requested:** ${payload.bucketsRequested.map(s => "`" + s + "`").join(", ")}`);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(`- \`rewrite_positional_debate\`: ${payload.counts.rewrite_positional_debate}`);
  lines.push(`- \`rewrite_missing_evidence_path\`: ${payload.counts.rewrite_missing_evidence_path}`);
  lines.push(`- **skipped:** ${payload.counts.skipped}`);
  lines.push(`- **Total drafts:** ${payload.drafts.length}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- This is a **read-only, template-only** assistant. No LLM calls. No DB writes. No status mutations.");
  lines.push("- Every draft carries at least one `TODO` and the `" + DRAFT_SENTINEL + "` sentinel. Drafts must never look done.");
  lines.push("- Memory-origin items (`promote_later_memory_origin`) are intentionally NOT drafted by this assistant — they remain operator-only promotion candidates. See `skipped.md` for the list.");
  lines.push("- The export does not carry per-field values; the assistant lists field NAMES and points the operator at the lab UI for originals.");
  lines.push("");
  return lines.join("\n");
}

function renderBucketFile(title: string, drafts: readonly DraftEntry[]): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Drafts: ${drafts.length}`);
  lines.push("");
  if (drafts.length === 0) {
    lines.push("_No drafts in this bucket._");
    lines.push("");
    return lines.join("\n");
  }
  for (const d of drafts) {
    lines.push(d.markdown);
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

function renderSkippedFile(skipped: readonly SkippedEntry[]): string {
  const lines: string[] = [];
  lines.push("# Skipped items");
  lines.push("");
  lines.push("Items in the input `backlog.json` that this assistant did NOT draft.");
  lines.push("Memory-origin items are intentionally skipped (operator-only promotion).");
  lines.push("");
  if (skipped.length === 0) {
    lines.push("_No skipped items._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| id | bucket | reason |");
  lines.push("| --- | --- | --- |");
  for (const s of skipped) {
    lines.push(`| \`${s.id}\` | ${s.bucket ? "`" + s.bucket + "`" : "_(none)_"} | ${s.reason} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunResult {
  exitCode:     number;
  payload:      RewritePayload | null;
  writtenPaths: string[];
  stdout:       string;
}

export interface RunOptions {
  argv: readonly string[];
  fs?: {
    mkdirSync:    (p: string, opts?: { recursive?: boolean }) => void;
    writeFileSync: (p: string, body: string) => void;
    existsSync:   (p: string) => boolean;
    readFileSync: (p: string) => Buffer;
  };
}

const DEFAULT_FS: NonNullable<RunOptions["fs"]> = {
  mkdirSync:    (p, o) => fs.mkdirSync(p, o ?? {}),
  writeFileSync: (p, b) => fs.writeFileSync(p, b),
  existsSync:   (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p),
};

export function runDraft(opts: RunOptions): RunResult {
  const sink = opts.fs ?? DEFAULT_FS;
  const stdoutParts: string[] = [];

  const parsed = parseArgs(opts.argv);
  if (!parsed.ok) {
    return { exitCode: 1, payload: null, writtenPaths: [], stdout: `error: ${parsed.reason}\n${HELP_TEXT}\n` };
  }
  if (parsed.args.showHelp) {
    return { exitCode: 0, payload: null, writtenPaths: [], stdout: HELP_TEXT + "\n" };
  }
  const args = parsed.args;

  // Load + parse the input.
  let inputBuf: Buffer;
  try {
    inputBuf = sink.readFileSync(args.input!);
  } catch (e: any) {
    return {
      exitCode: 2,
      payload:  null,
      writtenPaths: [],
      stdout: `error: failed to read --input ${args.input}: ${e?.message ?? String(e)}\n`,
    };
  }
  const inputSha256 = crypto.createHash("sha256").update(inputBuf).digest("hex");
  let payload: BacklogExportPayload;
  try {
    payload = JSON.parse(inputBuf.toString("utf8")) as BacklogExportPayload;
  } catch (e: any) {
    return {
      exitCode: 2,
      payload:  null,
      writtenPaths: [],
      stdout: `error: --input is not valid JSON: ${e?.message ?? String(e)}\n`,
    };
  }
  if (!payload || !Array.isArray(payload.items)) {
    return {
      exitCode: 2,
      payload:  null,
      writtenPaths: [],
      stdout: `error: --input does not look like a backlog-export payload (no items[] array)\n`,
    };
  }

  // Resolve clock-derived values.
  const nowDate = args.now ? new Date(args.now) : new Date();
  const generatedAt = args.now ?? nowDate.toISOString();
  const reviewDeadline = args.reviewDeadline ?? defaultReviewDeadline(nowDate);

  const built = buildPayload({
    payload,
    inputPath:       args.input!,
    inputSha256,
    buckets:         args.buckets,
    reviewDeadline,
    generatedAt,
    gitSha:          safeGitShortSha(),
  });

  if (args.dryRun) {
    stdoutParts.push("[dry-run] Backlog rewrite assistant plan");
    stdoutParts.push(`[dry-run] Input:           ${args.input}`);
    stdoutParts.push(`[dry-run] Input sha256:    ${inputSha256}`);
    stdoutParts.push(`[dry-run] Review deadline: ${reviewDeadline}`);
    stdoutParts.push(`[dry-run] Buckets:         ${args.buckets.join(", ")}`);
    stdoutParts.push(`[dry-run] Counts:`);
    stdoutParts.push(`  rewrite_positional_debate:     ${built.counts.rewrite_positional_debate}`);
    stdoutParts.push(`  rewrite_missing_evidence_path: ${built.counts.rewrite_missing_evidence_path}`);
    stdoutParts.push(`  skipped:                       ${built.counts.skipped}`);
    stdoutParts.push("[dry-run] No files written.");
    return { exitCode: 0, payload: built, writtenPaths: [], stdout: stdoutParts.join("\n") + "\n" };
  }

  const outDir = args.outDir ?? defaultOutDir(nowDate);
  if (!sink.existsSync(outDir)) sink.mkdirSync(outDir, { recursive: true });

  const written: string[] = [];

  const summaryPath = path.join(outDir, "summary.md");
  sink.writeFileSync(summaryPath, renderSummary(built));
  written.push(summaryPath);

  if (args.buckets.includes("rewrite_positional_debate")) {
    const posDrafts = built.drafts.filter(d => d.bucket === "rewrite_positional_debate");
    const p = path.join(outDir, "positional-debate-rewrites.md");
    sink.writeFileSync(p, renderBucketFile("Positional-debate rewrites — DRAFTS", posDrafts));
    written.push(p);
  }
  if (args.buckets.includes("rewrite_missing_evidence_path")) {
    const mpDrafts = built.drafts.filter(d => d.bucket === "rewrite_missing_evidence_path");
    const p = path.join(outDir, "missing-evidence-path-repairs.md");
    sink.writeFileSync(p, renderBucketFile("Missing-evidence-path repairs — DRAFTS", mpDrafts));
    written.push(p);
  }

  const skippedPath = path.join(outDir, "skipped.md");
  sink.writeFileSync(skippedPath, renderSkippedFile(built.skipped));
  written.push(skippedPath);

  const jsonPath = path.join(outDir, "rewrites.json");
  sink.writeFileSync(jsonPath, JSON.stringify(built, null, 2) + "\n");
  written.push(jsonPath);

  stdoutParts.push(`Backlog rewrite drafts written to: ${outDir}`);
  stdoutParts.push(`Drafts: ${built.drafts.length} (positional=${built.counts.rewrite_positional_debate}, missing-evidence=${built.counts.rewrite_missing_evidence_path}), skipped=${built.counts.skipped}`);
  stdoutParts.push(`Files: ${written.length}`);

  return { exitCode: 0, payload: built, writtenPaths: written, stdout: stdoutParts.join("\n") + "\n" };
}

function isDirectEntry(): boolean {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string") return false;
  try {
    return new URL(`file://${argv1}`).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = runDraft({ argv: process.argv.slice(2) });
  process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}
