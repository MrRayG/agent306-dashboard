/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — VERIFIER → CLAIM MAP MAPPING (Roadmap Issue A2, 2026-05-02)
 *
 * Best-effort deterministic mapping from verifier-report failures back to
 * claim_map_items.itemKey. The verifier itself was not changed in this PR
 * (it would require touching the judge prompt + golden suite); instead this
 * helper runs AFTER `verifyClaims` and annotates each failing entry with
 * the claim-map item it most likely came from.
 *
 * Limitations (documented for the follow-up B-cluster PR):
 *   - Token-overlap matching only — no embedding similarity.
 *   - Ambiguous cases (two claims share the same nouns) return the
 *     highest-scoring match without confidence reporting.
 *   - Sentences that survive verification but were never in the claim map
 *     are NOT flagged here (the verifier already enforces source-locality;
 *     "outside the plan" detection is deferred to B1).
 *
 * Ship this as the deterministic baseline. Cluster B can replace it with a
 * verifier-internal mapping without changing the persisted shape.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { VerifierReport, VerifierReportEntry } from "./claimVerifier.js";
import { getApprovedClaimItems, matchClaimItemForSentence } from "./repositories/claimMapRepository.js";
import type { ClaimMapItem } from "@shared/schema";

export interface VerifierFailureClaimMatch {
  sentenceIndex: number;
  classification: VerifierReportEntry["classification"];
  reason: string;
  /** The best-effort claim_map_items.itemKey, or null when no match
   *  exceeded the minimum overlap threshold. */
  claimItemKey: string | null;
  /** The claim text we matched against, for log/UI display. */
  claimText: string | null;
}

/**
 * Annotate every failing entry in a verifier report with the claim_map
 * item it most likely came from. Failures are entries with a non-OK
 * classification (LANE_A_FAIL, LANE_A_UNVERIFIABLE, LANE_B_BARE,
 * NCITE_PATTERN_HIT, RETRACTED_HIT).
 *
 * Returns an empty array when no claim map exists for the draft.
 */
export function mapVerifierFailuresToClaims(opts: {
  engine: string;
  draftId: string;
  report: VerifierReport;
}): VerifierFailureClaimMatch[] {
  const items = getApprovedClaimItems(opts.engine, opts.draftId);
  if (items.length === 0) return [];
  return mapVerifierFailuresWithItems(opts.report, items);
}

/**
 * Same as `mapVerifierFailuresToClaims` but takes the items directly.
 * Useful for tests and for callers that already loaded the claim map.
 */
export function mapVerifierFailuresWithItems(
  report: VerifierReport,
  items: ClaimMapItem[],
): VerifierFailureClaimMatch[] {
  const out: VerifierFailureClaimMatch[] = [];
  for (const entry of report.entries ?? []) {
    if (!isFailingClassification(entry.classification)) continue;
    const matched = matchClaimItemForSentence(items, entry.snippet);
    out.push({
      sentenceIndex: entry.sentenceIndex,
      classification: entry.classification,
      reason: entry.reason,
      claimItemKey: matched?.itemKey ?? null,
      claimText: matched?.claimText ?? null,
    });
  }
  return out;
}

function isFailingClassification(c: VerifierReportEntry["classification"]): boolean {
  return (
    c === "LANE_A_FAIL" ||
    c === "LANE_A_UNVERIFIABLE" ||
    c === "LANE_B_BARE" ||
    c === "NCITE_PATTERN_HIT" ||
    c === "RETRACTED_HIT"
  );
}
