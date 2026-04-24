/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PROMOTION GATE (spec §5)
 *
 * The ONLY path to `status: applied` on a SelfRecommendation. Called by
 * selfRecommendationEngine.applyRecommendation before any transition.
 *
 * Contract:
 *   canPromote(rec) → { ok, failures, ranSets }
 *
 * Policy:
 *   - rec MUST be in status='approved' (enforced here AND at the engine).
 *   - For any non-low risk (`medium` or `high`) change, the regression
 *     runner must pass every golden case. Promotion is blocked on any
 *     failing case and the failing case ids come back in `failures`.
 *   - For `low` risk changes, golden sets are still RUN and logged so the
 *     agent has telemetry, but a non-fatal failure does not block. This
 *     mirrors the audit's "propose-only" posture: the friction should be
 *     proportional to the risk.
 *
 * Anything fails-closed: if loading golden sets throws, we treat that as
 * a gate failure rather than passing silently. That way a corrupted
 * golden file surfaces as a visible block rather than an invisible allow.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SelfRecommendation } from "@shared/schema";
import { runAllGoldenSets } from "./regressionRunner.js";

export interface PromotionResult {
  ok: boolean;
  failures: string[];
  ranSets: string[];
}

export async function canPromote(rec: SelfRecommendation): Promise<PromotionResult> {
  const failures: string[] = [];
  const ranSets: string[] = [];

  if (rec.status !== "approved") {
    failures.push(`recommendation not approved (status=${rec.status})`);
    return { ok: false, failures, ranSets };
  }

  let report: ReturnType<typeof runAllGoldenSets>;
  try {
    report = runAllGoldenSets();
  } catch (e: any) {
    failures.push(`regression runner threw: ${e?.message ?? e}`);
    return { ok: false, failures, ranSets };
  }

  for (const s of report.sets) ranSets.push(`${s.name}@v${s.version}`);
  const failed = report.results.filter(r => !r.ok);

  if (rec.risk === "low") {
    // low risk: log failures but don't block. Propose-only policy still
    // applies — only an *approved* rec that passes *its own* operator sign-
    // off reaches this path in the first place.
    if (failed.length > 0) {
      console.warn(
        `[PromotionGate] ${failed.length} golden-case failures on low-risk rec ${rec.id} — not blocking`,
      );
      for (const f of failed.slice(0, 5)) {
        console.warn(`  ${f.setName}.${f.caseId}: ${f.reason ?? "fail"}`);
      }
    }
    return { ok: true, failures, ranSets };
  }

  // medium / high: block on any failure.
  for (const f of failed) {
    failures.push(`${f.setName}.${f.caseId}: ${f.reason ?? "fail"}`);
  }

  // High-risk recs additionally require an explicit operator override
  // (PROMOTION_GATE_ALLOW_HIGH_RISK=true). Even passing golden sets is not
  // sufficient — schema/architecture changes deserve a second deliberate
  // signal. This preserves the propose-only posture for the riskiest
  // category and matches the documented self-change policy.
  if (rec.risk === "high" && (process.env.PROMOTION_GATE_ALLOW_HIGH_RISK ?? "false").toLowerCase() !== "true") {
    failures.push("high-risk changes require PROMOTION_GATE_ALLOW_HIGH_RISK=true as an explicit operator override");
  }

  return { ok: failures.length === 0, failures, ranSets };
}
