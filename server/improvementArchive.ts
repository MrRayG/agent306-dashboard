/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  IMPROVEMENT ARCHIVE (PR #285)
 *
 *  A persistent, append-only JSONL log of past hypothesis-rubric variants,
 *  scores, and lessons learned. Used to:
 *    • give Agent 306 a long-term memory of which hypothesis patterns
 *      previously scored well / poorly so future cycles can avoid repeats;
 *    • collect lessons + improvement proposals after each research cycle.
 *
 *  Approval-safe invariant: writing a record here is *propose-only*. Any
 *  improvement record carrying `proposesChange: true` MUST also be filed
 *  through selfRecommendationEngine.proposeRecommendation() by the caller
 *  so the operator-review path is the only way to apply it. This module
 *  does NOT mutate prompts, configs, code, or any other engine state. It
 *  is a record store — nothing more.
 *
 *  Storage: data/improvement_archive.jsonl (one record per line, never
 *  rewritten — append-only by design).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import type { ResearchFocusScores, SelfExperimentProtocol, RubricVerdict } from "./researchFocusRubric.js";

const ARCHIVE_FILE = dataPath("improvement_archive.jsonl");

export interface ImprovementRecord {
  /** Local id; not a primary key — used for human-readable cross-reference. */
  id: string;
  /** ISO timestamp the record was appended. */
  recordedAt: string;
  /** Free-form variant label, e.g. "rubric-v1", "research-focus-rubric/2026-05-07". */
  variantLabel: string;
  /** Short snapshot of the hypothesis claim text (<= 200 chars). */
  claim: string;
  /** Rubric scores from researchFocusRubric.scoreResearchFocus, if available. */
  scores?: ResearchFocusScores;
  /** Weighted overall score (0-10). */
  overall?: number;
  /** Verdict rendered by the rubric, if available. */
  verdict?: RubricVerdict;
  /** The self-experiment protocol that was attached. */
  protocol?: SelfExperimentProtocol;
  /** What the cycle learned, in <= 500 chars. Free-form. */
  lesson?: string;
  /**
   * If true, the operator should review a corresponding self-recommendation.
   * Caller is responsible for filing that recommendation — this module does
   * not auto-apply or auto-publish anything.
   */
  proposesChange: boolean;
  /** Optional: the recommendation id created by the caller, if any. */
  selfRecommendationId?: string;
}

export interface AppendInput {
  variantLabel: string;
  claim: string;
  scores?: ResearchFocusScores;
  overall?: number;
  verdict?: RubricVerdict;
  protocol?: SelfExperimentProtocol;
  lesson?: string;
  proposesChange?: boolean;
  selfRecommendationId?: string;
}

function nextId(): string {
  return `imp_${Date.now()}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Append a new record to the JSONL archive. Returns the materialised record.
 * If the underlying write fails, the error is caught and logged (call site is
 * usually a non-critical post-cycle hook); a stub record is still returned so
 * the caller can decide what to do with it.
 */
export function appendImprovementRecord(input: AppendInput): ImprovementRecord {
  const record: ImprovementRecord = {
    id:                   nextId(),
    recordedAt:           new Date().toISOString(),
    variantLabel:         input.variantLabel.trim(),
    claim:                input.claim.trim().slice(0, 200),
    scores:               input.scores,
    overall:              input.overall,
    verdict:              input.verdict,
    protocol:             input.protocol,
    lesson:               input.lesson?.trim().slice(0, 500),
    proposesChange:       Boolean(input.proposesChange),
    selfRecommendationId: input.selfRecommendationId,
  };

  try {
    fs.appendFileSync(ARCHIVE_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (e: any) {
    console.warn(`[ImprovementArchive] failed to append ${record.id}:`, e?.message ?? e);
  }
  return record;
}

/**
 * Read all archive records. Tolerates partial / corrupt lines by skipping
 * them — append-only design means a torn write never corrupts prior records.
 */
export function readImprovementArchive(): ImprovementRecord[] {
  if (!fs.existsSync(ARCHIVE_FILE)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(ARCHIVE_FILE, "utf8");
  } catch {
    return [];
  }
  const records: ImprovementRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.id === "string") {
        records.push(obj as ImprovementRecord);
      }
    } catch {
      // Skip bad line. Append-only — earlier records are still intact.
    }
  }
  return records;
}

/** Convenience: most-recent first slice for dashboard rendering. */
export function readImprovementArchiveTail(limit = 50): ImprovementRecord[] {
  const all = readImprovementArchive();
  return all.slice(-Math.max(1, limit)).reverse();
}

/**
 * Convert archive entries to the lightweight ArchiveEntry shape consumed by
 * researchFocusRubric.checkDuplication(). Caller may filter to just records
 * with a useful claim (defaults to all that have non-empty claim text).
 */
export function archiveAsClaimSet(): Array<{ id: string; claim: string }> {
  return readImprovementArchive()
    .filter(r => r.claim && r.claim.length > 0)
    .map(r => ({ id: r.id, claim: r.claim }));
}
