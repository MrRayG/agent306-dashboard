/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PROMOTION GATE (spec §5)
 *
 * Placeholder implementation landed with commit 1 so `selfRecommendationEngine`
 * has something to import. Commit 5 expands this to run golden sets against
 * current engines and compute a pass/fail report.
 *
 * The contract is: `canPromote(rec)` is the ONLY path to `status: applied`.
 * Every code path that could apply a change calls this function.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SelfRecommendation } from "@shared/schema";

export interface PromotionResult {
  ok: boolean;
  failures: string[];
  ranSets: string[];
}

/**
 * Default gate: rejects anything `high` risk unless golden sets have been run
 * and passed. Commit 5 wires the actual golden-set runner. Until then, the
 * gate pass criterion is: status === 'approved' (enforced by caller) AND risk
 * is not 'high'.
 */
export async function canPromote(rec: SelfRecommendation): Promise<PromotionResult> {
  const failures: string[] = [];
  const ranSets: string[] = [];
  if (rec.status !== "approved") {
    failures.push(`recommendation not approved (status=${rec.status})`);
  }
  if (rec.risk === "high") {
    // High-risk changes require an explicit golden-set pass once commit 5 lands.
    // Until then, they are gated out to preserve the propose-only policy.
    failures.push("high-risk changes require golden-set regression sign-off");
  }
  // commit 5 will push regression-runner results onto ranSets/failures.
  return { ok: failures.length === 0, failures, ranSets };
}
