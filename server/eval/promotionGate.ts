/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — PROMOTION GATE (spec §5)
 *
 * The ONLY path to `status: applied` on a SelfRecommendation. Called by
 * selfRecommendationEngine.applyRecommendation before any transition.
 *
 * Contract:
 *   canPromote(rec) → { ok, failures, ranSets, attestations? }
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
 *
 * Advisory attestation channel (Phase 3a-proper)
 * ──────────────────────────────────────────────
 * `attestations` is an OPTIONAL, ADVISORY array. Entries are appended by
 * adapter modules (currently only `phase3aPrepAttestation`) when the
 * recommendation opts in via a stable evidence-ID convention. The
 * attestation channel is STRICTLY non-authoritative: no entry on this
 * array can flip `ok`. The single-write-site promotion boundary remains
 * `canPromote(rec).ok` — Pin 11 (boundary regression) and the
 * promotion-boundary audit (`server/eval/promotionBoundaryAudit.ts`)
 * remain the canonical pin. Removing the channel is a single-file
 * delete plus removing the `attestations` field on this type.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SelfRecommendation } from "@shared/schema";
import { runAllGoldenSets } from "./regressionRunner.js";
import {
  buildPhase3aPrepAttestation,
  type PromotionAttestation,
} from "./phase3aPrepAttestation.js";

export type { PromotionAttestation } from "./phase3aPrepAttestation.js";

export interface PromotionResult {
  ok: boolean;
  failures: string[];
  ranSets: string[];
  /** Advisory, non-authoritative attestation telemetry. ALWAYS
   *  irrelevant to `ok`. May be omitted on call paths that emit no
   *  attestations; callers should treat absence and empty-array as
   *  equivalent. */
  attestations?: PromotionAttestation[];
}

/** Run every registered advisory attestation adapter against the
 *  recommendation. Adapters are pure and non-throwing; this helper
 *  wraps each call in a try/catch as belt-and-suspenders so a future
 *  buggy adapter cannot blow up the gate. The returned array is empty
 *  when no adapter opts in. */
function collectAttestations(rec: SelfRecommendation): PromotionAttestation[] {
  const out: PromotionAttestation[] = [];
  try {
    const att = buildPhase3aPrepAttestation(rec);
    if (att !== null) out.push(att);
  } catch (e: unknown) {
    // Defensive — adapter is documented non-throwing, but if a future
    // change regresses we want a visible log line rather than a gate
    // crash. The gate's `ok` is unaffected either way.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[PromotionGate] phase3aPrep attestation adapter threw (ignored): ${msg}`,
    );
  }
  return out;
}

export async function canPromote(rec: SelfRecommendation): Promise<PromotionResult> {
  const failures: string[] = [];
  const ranSets: string[] = [];
  // Advisory attestations are collected ONCE up front so every early-
  // return path carries the same telemetry. The collection is pure and
  // does not affect `failures` / `ranSets` / `ok`. If a future adapter
  // needs gate state (it shouldn't), it must take it as an argument —
  // we never let attestations read from the gate's working state.
  const attestations = collectAttestations(rec);

  if (rec.status !== "approved") {
    failures.push(`recommendation not approved (status=${rec.status})`);
    return { ok: false, failures, ranSets, attestations };
  }

  let report: Awaited<ReturnType<typeof runAllGoldenSets>>;
  try {
    report = await runAllGoldenSets();
  } catch (e: any) {
    failures.push(`regression runner threw: ${e?.message ?? e}`);
    return { ok: false, failures, ranSets, attestations };
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
    return { ok: true, failures, ranSets, attestations };
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

  return { ok: failures.length === 0, failures, ranSets, attestations };
}
