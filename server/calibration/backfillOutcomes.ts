/**
 * One-shot backfill for hypothesis_outcomes from research_lab.blob.
 * Idempotent: skips rows where (hypothesisId, resolvedAt) already exists.
 * Safe to run repeatedly. Independent of the calibrationCapture flag —
 * this is a manually-invoked operator tool, not the on-resolution hook.
 *
 * CLI: `npm run calibration:backfill [-- --dry-run]`
 *
 * See docs/CALIBRATED_CONFIDENCE.md §6 for the Phase 1 runbook.
 */

import { fileURLToPath, pathToFileURL } from "url";
import { and, eq } from "drizzle-orm";
import { db } from "../db.js";
import { hypothesisOutcomes } from "@shared/schema";
import { normalizeConfidence } from "./normalizeConfidence.js";
import { deriveOutcome, type ResolvableHypothesis } from "./hypothesisOutcomes.js";

export interface BackfillSummary {
  scanned:         number;  // count of resolved (terminal) hypotheses considered
  written:         number;  // rows actually inserted
  skippedExisting: number;  // (hypothesisId, resolvedAt) row already present
  skippedAwaiting: number;  // status === "awaiting-deadline" (terminal-only writes)
  errors:          number;  // per-row exceptions, swallowed and counted
}

export interface BackfillOptions {
  /** When true, no INSERTs run. Same scan + duplicate detection so the
   *  reported counts predict the live run. */
  dryRun?: boolean;
}

/** True when a hypothesis_outcomes row with the given key already exists. */
function existingOutcome(hypothesisId: string, resolvedAt: string): boolean {
  try {
    const row = db.select()
      .from(hypothesisOutcomes)
      .where(and(
        eq(hypothesisOutcomes.hypothesisId, hypothesisId),
        eq(hypothesisOutcomes.resolvedAt, resolvedAt),
      ))
      .limit(1)
      .all();
    return row.length > 0;
  } catch {
    // A read error here means we can't prove non-existence; fail safe by
    // treating it as "exists" so we don't write a duplicate.
    return true;
  }
}

/** Walks `research_lab.blob`, writes one outcome row per terminally-resolved
 *  hypothesis that doesn't already have one. Returns a count summary. */
export async function runBackfill(opts: BackfillOptions = {}): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    scanned: 0,
    written: 0,
    skippedExisting: 0,
    skippedAwaiting: 0,
    errors: 0,
  };

  // Lazy import so this module stays cheap to load in tests that don't
  // exercise the full research stack.
  const { getResearchLab } = await import("../researchEngine.js");
  const lab = getResearchLab();
  const hypotheses = lab?.hypotheses ?? [];

  for (const hyp of hypotheses) {
    try {
      const status = (hyp as any).status as string | undefined;
      if (!status) continue;
      if (status === "awaiting-deadline") {
        summary.skippedAwaiting += 1;
        continue;
      }
      const mapping = deriveOutcome(status);
      if (!mapping) {
        // Non-terminal (forming/testing/speculative-watchlist/etc) — not
        // counted in scanned, since the design treats these as not-graded.
        continue;
      }
      const resolvedAt: string | undefined = (hyp as any).resolvedAt;
      if (!resolvedAt) continue;

      summary.scanned += 1;

      if (existingOutcome((hyp as any).id, resolvedAt)) {
        summary.skippedExisting += 1;
        continue;
      }

      if (opts.dryRun) {
        // Count as scanned but not written. The intent is "what would
        // happen if I ran for real?" — the existing-vs-new split above
        // is the answer.
        continue;
      }

      const norm = normalizeConfidence(hyp as ResolvableHypothesis);
      db.insert(hypothesisOutcomes)
        .values({
          hypothesisId:        (hyp as any).id,
          predictedConfidence: norm.predictedConfidence,
          predictedTrustScore: norm.predictedTrustScore,
          originatingModel:    (hyp as any).originatingModel ?? null,
          resolvedAt,
          resolutionStatus:    status,
          actualOutcome:       mapping.actualOutcome,
          outcomeWeight:       mapping.outcomeWeight,
          outcomeSource:       mapping.outcomeSource,
          domain:              (hyp as any).domain ?? null,
        })
        .run();
      summary.written += 1;
    } catch (e: any) {
      summary.errors += 1;
      console.warn(`[calibration] backfill row error id=${(hyp as any)?.id}:`, e?.message ?? e);
    }
  }

  console.log(
    `[calibration] backfill ${opts.dryRun ? "(dry-run) " : ""}complete — scanned=${summary.scanned} written=${summary.written} skippedExisting=${summary.skippedExisting} skippedAwaiting=${summary.skippedAwaiting} errors=${summary.errors}`,
  );
  return summary;
}

// ── CLI entry point ─────────────────────────────────────────────────────────
// Run only when invoked directly via `tsx server/calibration/backfillOutcomes.ts`.
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href ||
  fileURLToPath(import.meta.url) === (process.argv[1] ?? "");

if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run");
  runBackfill({ dryRun })
    .then(s => process.exit(s.errors > 0 ? 1 : 0))
    .catch(e => {
      console.error("[calibration] backfill failed:", e?.message ?? e);
      process.exit(1);
    });
}
