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
 *
 * Operator-gated soft warning channel (Phase 4-a)
 * ───────────────────────────────────────────────
 * `softWarnings` is an ADVISORY array of human-readable strings. It is
 * computed STRICTLY after `ok` / `failures` / `ranSets` are determined,
 * is wholly DERIVED FROM `attestations`, and NEVER feeds back into `ok`.
 * Entries are populated only when an operator explicitly opts in via
 * `PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY=true`. With the flag off
 * (the default) `softWarnings` is an empty array — output is byte-
 * identical to pre-Phase-4-a behavior.
 *
 * The flag name uses the verb "REQUIRE" for forward-compatibility with
 * Phase 4-b's authoritative variant; in Phase 4-a it is SOFT-only: the
 * warning is informational, surfaces alongside the existing advisory
 * attestation telemetry, and does not block, reject, mutate status, or
 * widen any public-action surface. Pin 7 and Pin 11 are preserved.
 * Removing the channel is a single-file delete plus removing the
 * `softWarnings` field on this type.
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
  /** Operator-gated advisory soft warnings (Phase 4-a). Populated only
   *  when `PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY=true` AND a
   *  phase3aPrep attestation is present but its readiness verdict is
   *  not `fully_prepared` (or it is a `parse_error`). The array is
   *  ALWAYS irrelevant to `ok`; computed from `attestations` AFTER `ok`
   *  is decided. Callers should treat absence and empty-array as
   *  equivalent. Strings are human-readable; do not parse. */
  softWarnings?: string[];
}

/** Env-flag identifier for the Phase 4-a operator-gated soft warning.
 *  When this env var is set to the literal string `"true"` (case-
 *  insensitive), `canPromote` populates `softWarnings` with one entry
 *  per advisory attestation whose readiness is not `fully_prepared`.
 *  Default behavior (flag unset / any other value) is unchanged. */
export const PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV =
  "PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY" as const;

/** Pure helper: read the Phase 4-a flag from `process.env`. Exported for
 *  test seams and future call sites; the gate itself is the only live
 *  caller. Returns `true` ONLY when the env var equals the literal
 *  string `"true"` (case-insensitive). Any other value, including
 *  unset / empty / `"1"` / `"yes"`, returns `false`. */
export function readPhase3aPrepReadyRequiredFlag(): boolean {
  const v = process.env[PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV];
  if (typeof v !== "string") return false;
  return v.toLowerCase() === "true";
}

/** Pure helper (exported for tests): derive Phase 4-a soft warnings from
 *  the attestation array. Returns an empty array when the flag is off,
 *  when no attestations are present, or when every attestation reports
 *  `status === "evaluated"` AND `readiness.verdict === "fully_prepared"`.
 *  This function NEVER reads env / clock / fs / db — `flagOn` is passed
 *  by the caller. */
export function deriveSoftWarnings(
  attestations: ReadonlyArray<PromotionAttestation>,
  flagOn: boolean,
): string[] {
  if (!flagOn) return [];
  if (attestations.length === 0) return [];
  const out: string[] = [];
  for (const att of attestations) {
    if (att.source !== "phase3aPrep") continue;
    if (att.status === "parse_error") {
      out.push(
        `phase3aPrep attestation could not be parsed (parseError: ${att.parseError ?? "unknown"}); ` +
        `operator opted in via ${PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV}=true. ` +
        `ADVISORY ONLY — gate.ok is unaffected and apply is not blocked.`,
      );
      continue;
    }
    const verdict = att.readiness?.verdict;
    if (verdict !== "fully_prepared") {
      const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
      const verdictStr = verdict ?? "(missing)";
      out.push(
        `phase3aPrep readiness for candidate '${candidate}' is '${verdictStr}' ` +
        `(operator opted in via ${PROMOTION_GATE_REQUIRE_PHASE3A_PREP_READY_ENV}=true). ` +
        `ADVISORY ONLY — gate.ok is unaffected and apply is not blocked.`,
      );
    }
  }
  return out;
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
  // Phase 4-a: env flag snapshot taken ONCE so every return path shares
  // the same value, mirroring `attestations`. Read after `ok` is decided
  // — never feeds into the gate's working state.
  const flagOn = readPhase3aPrepReadyRequiredFlag();

  // Single helper used by every return path. Computes soft warnings
  // strictly AFTER the gate has decided its own `ok` / `failures` /
  // `ranSets`. Pin 11 (single write boundary) is preserved by
  // construction: `softWarnings` is a separate field that no consumer
  // is allowed to read into `ok`.
  const finalize = (
    ok: boolean,
    failuresOut: string[],
    ranSetsOut: string[],
  ): PromotionResult => ({
    ok,
    failures: failuresOut,
    ranSets: ranSetsOut,
    attestations,
    softWarnings: deriveSoftWarnings(attestations, flagOn),
  });

  if (rec.status !== "approved") {
    failures.push(`recommendation not approved (status=${rec.status})`);
    return finalize(false, failures, ranSets);
  }

  let report: Awaited<ReturnType<typeof runAllGoldenSets>>;
  try {
    report = await runAllGoldenSets();
  } catch (e: any) {
    failures.push(`regression runner threw: ${e?.message ?? e}`);
    return finalize(false, failures, ranSets);
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
    return finalize(true, failures, ranSets);
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

  return finalize(failures.length === 0, failures, ranSets);
}
