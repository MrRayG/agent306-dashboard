/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — HYPOTHESIS RESET REPORT (READ-ONLY EXPORT)
 *
 * Operator-facing companion to `hypothesisIntakeAuditVisibility.ts`. The
 * visibility module gives the panel a summary projection (per-bucket counts +
 * up-to-5 example ids); this module produces the *full*, per-id classification
 * report an operator can review BEFORE approving any cleanup run.
 *
 * Output is a single JSON-serializable blob plus a text-formatter. Both are
 * PURE — no file is written, no DB row is inserted, no scheduler is touched,
 * nothing in `data/` is mutated. The CLI in `scripts/hypothesisReset.ts`
 * consumes this report; the read path is the same whether the CLI is run in
 * default dry-run mode or with `--apply`.
 *
 * Hard invariants:
 *   - READ-ONLY. No write paths are imported. `archiveHypotheses.ts`,
 *     `researchEngine.ts:saveLab`, `selfRecommendationEngine.applyRecommendation`
 *     are all out of scope here.
 *   - DETERMINISTIC. Given the same `research_lab.json` snapshot and the same
 *     `now` instant, two calls return byte-identical output. Tests pin this.
 *   - NON-WIDENING. No new API endpoint, no new auth, no new primitive. The
 *     CLI is operator-only and uses the same reader as the panel.
 *   - PROPOSE-ONLY. The report exposes a `bucket` per id, an aggregate of the
 *     intake-quality verdict on the same record, and an "operator should…"
 *     `recommendedAction` per bucket. Nothing here decides anything; the
 *     final apply step lives behind an explicit operator flag in the CLI.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath, DATA_DIR } from "./dataPaths.js";
import {
  classifyReset,
  gateIntake,
  RESET_BUCKETS,
  DEFAULT_ACTIVE_CAP,
  type ResetBucket,
  type IntakeGateVerdict,
  type IntakeCandidate,
} from "./hypothesisIntakeAuditVisibility.js";
import type { HygieneAwareHypothesis } from "./hypothesisHygiene.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface ResetReportEntry {
  id:              string;
  bucket:          ResetBucket;
  reasons:         string[];
  /** Short claim preview (first ~120 chars), useful for operator scan. */
  claimPreview:    string;
  /** Existing status/formedAt for context. */
  status:          string;
  formedAt:        string | null;
  /** Re-run intake gate over the existing record so the report shows both
   *  the lifecycle bucket and the gate verdict on the same row. */
  intakeVerdict:   IntakeGateVerdict;
}

export interface ResetReportBucketSection {
  bucket:        ResetBucket;
  count:         number;
  /** All entries assigned to this bucket (NOT capped). */
  entries:       ResetReportEntry[];
  /** Operator-facing single-sentence description of this bucket. */
  description:   string;
  /** Suggested next operator action for the bucket. Text only. */
  recommendedAction: string;
  /** True when this bucket is safe to apply via the CLI as an archive
   *  (status → archived, hygieneTag preserved). `keep_active`,
   *  `needs_operator_review`, and the `rewrite_*` buckets are NOT safe to
   *  archive blindly. */
  safeToArchiveFromCli: boolean;
}

export interface ResetReportMeta {
  generatedAt:        string;
  dataDir:            string;
  researchLabPath:    string;
  researchLabExists:  boolean;
  totalRecords:       number;
  /** Snapshot inputs used to compute the report. */
  inputs: {
    now:              string;
    staleDays:        number;
    maxActive:        number;
    maxNewPerDailyCycle: number;
  };
}

export interface HypothesisResetReport {
  schemaVersion: "hypothesis-reset-report-1";
  meta:          ResetReportMeta;
  /** Ordered list of bucket sections. Empty buckets are included so the
   *  consumer can render a stable layout. */
  buckets:       ResetReportBucketSection[];
  /** Flat counts grid for quick consumption. */
  counts:        Record<ResetBucket, number>;
  /** Optional advisory text appended at the bottom of the report. */
  notes:         string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const BUCKET_DESCRIPTIONS: Readonly<Record<ResetBucket, string>> = Object.freeze({
  keep_active:                   "Active forming/testing record with no detected blocker — leave in the loop.",
  archive_stale:                 "Already resolved, expired, or forming/testing for more than staleDays — operator may archive.",
  archive_data_unavailable:      "Marked data-unavailable or archived_unsolvable — measurement path will not exist.",
  archive_duplicate:             "Consolidator pointed this record at a canonical via aliasOf — operator may archive.",
  rewrite_positional_debate:     "Claim shaped like 'Position A vs Position B' with no evidence path on either side. Rewrite as a research-gap claim with a metric and deadline.",
  rewrite_missing_evidence_path: "Required field missing (measurementPath, metric, or basis). Operator must fill before re-entering the loop.",
  promote_later_memory_origin:   "Memory-origin (Hypothesis: …) entry that has NOT been promoted to a formal record. Promotion is operator-only.",
  needs_operator_review:         "Conservative fallback — hygiene classifier flagged needs_data / needs_rewrite / needs_review.",
});

const BUCKET_RECOMMENDED_ACTION: Readonly<Record<ResetBucket, string>> = Object.freeze({
  keep_active:                   "No action — record stays in the active loop.",
  archive_stale:                 "Operator may run `tsx scripts/hypothesisReset.ts --bucket=archive_stale --apply` after review.",
  archive_data_unavailable:      "Operator may run `tsx scripts/hypothesisReset.ts --bucket=archive_data_unavailable --apply` after review.",
  archive_duplicate:             "Operator may run `tsx scripts/hypothesisReset.ts --bucket=archive_duplicate --apply` after review. aliasOf is preserved.",
  rewrite_positional_debate:     "Manual rewrite required. Reframe as a research-gap claim (metric + dataset + deadline). Do NOT bulk-archive — these are recoverable.",
  rewrite_missing_evidence_path: "Manual rewrite required. Fill measurementPath / metric / basis or archive individually.",
  promote_later_memory_origin:   "Operator-only promotion via existing memory→formal path. Do NOT apply this bucket from this CLI.",
  needs_operator_review:         "Conservative bucket — review individually before any action.",
});

const SAFE_TO_ARCHIVE_BUCKETS: Readonly<Set<ResetBucket>> = new Set<ResetBucket>([
  "archive_stale",
  "archive_data_unavailable",
  "archive_duplicate",
]);

interface ResearchLabBlob {
  hypotheses?: HygieneAwareHypothesis[];
}

function readResearchLabSafe(): { blob: ResearchLabBlob | null; exists: boolean } {
  const p = dataPath("research_lab.json");
  if (!fs.existsSync(p)) return { blob: null, exists: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object") return { blob: parsed as ResearchLabBlob, exists: true };
    return { blob: null, exists: true };
  } catch {
    return { blob: null, exists: true };
  }
}

function previewClaim(claim: string | undefined): string {
  if (typeof claim !== "string") return "";
  const s = claim.trim();
  if (s.length <= 120) return s;
  return s.slice(0, 117) + "...";
}

function intakeVerdictFor(h: HygieneAwareHypothesis): IntakeGateVerdict {
  const candidate: IntakeCandidate = {
    claim:           h.claim,
    basis:           h.basis,
    metric:          h.metric,
    prediction:      h.prediction,
    timeframe:       h.timeframe,
    source:          h.source,
    measurementPath: h.measurementPath,
    evidenceRef:     looksLikeEvidenceRef(h.basis) ? h.basis : undefined,
    useCase:         undefined,
  };
  return gateIntake(candidate).verdict;
}

function looksLikeEvidenceRef(s: string | undefined): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^doi:/i.test(t)) return true;
  if (/^arxiv:/i.test(t)) return true;
  return false;
}

// ── Public entry points ─────────────────────────────────────────────────────

export interface BuildResetReportOptions {
  now?:                  Date;
  staleDays?:            number;
  maxActive?:            number;
  maxNewPerDailyCycle?:  number;
  /** Allow injecting hypothesis list (tests); defaults to reading
   *  `research_lab.json`. */
  hypotheses?:           HygieneAwareHypothesis[];
}

/**
 * Build the full per-id reset classification report. Read-only.
 *
 * The report is sorted by:
 *   1. Bucket order (RESET_BUCKETS, then per-bucket entries in stable id order).
 *   2. Inside each bucket, entries are sorted by id for determinism.
 */
export function buildResetReport(opts: BuildResetReportOptions = {}): HypothesisResetReport {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_ACTIVE_CAP.staleDays;
  const maxActive = opts.maxActive ?? DEFAULT_ACTIVE_CAP.maxActive;
  const maxNewPerDailyCycle = opts.maxNewPerDailyCycle ?? DEFAULT_ACTIVE_CAP.maxNewPerDailyCycle;

  let hyps: HygieneAwareHypothesis[];
  let exists: boolean;
  if (Array.isArray(opts.hypotheses)) {
    hyps = opts.hypotheses;
    exists = true;
  } else {
    const { blob, exists: e } = readResearchLabSafe();
    hyps = Array.isArray(blob?.hypotheses) ? (blob!.hypotheses as HygieneAwareHypothesis[]) : [];
    exists = e;
  }

  // Group entries by bucket.
  const byBucket: Record<ResetBucket, ResetReportEntry[]> = Object.create(null);
  for (const b of RESET_BUCKETS) byBucket[b] = [];
  for (const h of hyps) {
    const cls = classifyReset(h, { now, staleDays });
    byBucket[cls.bucket].push({
      id:            h.id,
      bucket:        cls.bucket,
      reasons:       cls.reasons,
      claimPreview:  previewClaim(h.claim),
      status:        typeof h.status === "string" ? h.status : "(unset)",
      formedAt:      typeof h.formedAt === "string" ? h.formedAt : null,
      intakeVerdict: intakeVerdictFor(h),
    });
  }
  for (const b of RESET_BUCKETS) {
    byBucket[b].sort((a, b2) => a.id.localeCompare(b2.id));
  }

  const buckets: ResetReportBucketSection[] = RESET_BUCKETS.map(b => ({
    bucket:               b,
    count:                byBucket[b].length,
    entries:              byBucket[b],
    description:          BUCKET_DESCRIPTIONS[b],
    recommendedAction:    BUCKET_RECOMMENDED_ACTION[b],
    safeToArchiveFromCli: SAFE_TO_ARCHIVE_BUCKETS.has(b),
  }));

  const counts: Record<ResetBucket, number> = Object.create(null);
  for (const b of RESET_BUCKETS) counts[b] = byBucket[b].length;

  const notes: string[] = [
    "Read-only report. The CLI in scripts/hypothesisReset.ts is dry-run by default and requires --apply for any write.",
    "The CLI ARCHIVES (sets status='archived' + hygieneTag) — it never deletes. The full pre-apply snapshot is also backed up before any write.",
    "rewrite_* and needs_operator_review buckets are NOT applied by the CLI; they require manual operator review.",
  ];

  return {
    schemaVersion: "hypothesis-reset-report-1",
    meta: {
      generatedAt:       now.toISOString(),
      dataDir:           DATA_DIR,
      researchLabPath:   dataPath("research_lab.json"),
      researchLabExists: exists,
      totalRecords:      hyps.length,
      inputs: {
        now:                 now.toISOString(),
        staleDays,
        maxActive,
        maxNewPerDailyCycle,
      },
    },
    buckets,
    counts,
    notes,
  };
}

/** Human-readable text rendering of a report. */
export function formatResetReport(rep: HypothesisResetReport): string {
  const lines: string[] = [];
  lines.push(`# Hypothesis Reset Report`);
  lines.push(``);
  lines.push(`Generated: ${rep.meta.generatedAt}`);
  lines.push(`DATA_DIR:  ${rep.meta.dataDir}`);
  lines.push(`Source:    ${rep.meta.researchLabPath} (exists=${rep.meta.researchLabExists})`);
  lines.push(`Records:   ${rep.meta.totalRecords}`);
  lines.push(``);
  lines.push(`## Bucket counts`);
  for (const b of RESET_BUCKETS) {
    lines.push(`  - ${b}: ${rep.counts[b]}`);
  }
  lines.push(``);
  for (const section of rep.buckets) {
    lines.push(`## ${section.bucket} (${section.count})`);
    lines.push(`> ${section.description}`);
    lines.push(`recommended action: ${section.recommendedAction}`);
    lines.push(`safe to archive via CLI: ${section.safeToArchiveFromCli}`);
    if (section.entries.length === 0) {
      lines.push(`(no records)`);
    } else {
      for (const e of section.entries.slice(0, 25)) {
        lines.push(
          `  - ${e.id} [status=${e.status}, intakeVerdict=${e.intakeVerdict}] ${e.claimPreview}`,
        );
        for (const r of e.reasons) lines.push(`      · ${r}`);
      }
      if (section.entries.length > 25) {
        lines.push(`  … and ${section.entries.length - 25} more (see JSON form for full list)`);
      }
    }
    lines.push(``);
  }
  if (rep.notes.length > 0) {
    lines.push(`## Notes`);
    for (const n of rep.notes) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}

/**
 * Convenience: filter a report down to only the entries an operator marked
 * for an "apply" pass via the CLI. Excludes any bucket whose
 * `safeToArchiveFromCli` is false. Read-only.
 */
export function selectApplicableEntries(
  rep: HypothesisResetReport,
  buckets: ResetBucket[],
): ResetReportEntry[] {
  const allowed = new Set<ResetBucket>();
  for (const b of buckets) {
    const section = rep.buckets.find(s => s.bucket === b);
    if (section && section.safeToArchiveFromCli) allowed.add(b);
  }
  const out: ResetReportEntry[] = [];
  for (const section of rep.buckets) {
    if (!allowed.has(section.bucket)) continue;
    for (const e of section.entries) out.push(e);
  }
  return out;
}
