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
 *
 * Operator-gated hard block for low-risk (Phase 4-b)
 * ──────────────────────────────────────────────────
 * `PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY` is a
 * SEPARATE, EXPLICIT operator gate from the Phase 4-a soft warning
 * channel. When this env var is set to the literal string `"true"`
 * (case-insensitive) AND the recommendation is `risk === "low"`, the
 * gate authoritatively BLOCKS promotion when the Phase 3a-prep readiness
 * attestation is missing, fails to parse, or reports a verdict other
 * than `fully_prepared`. The block prevents the apply outcome through
 * the existing `gate.ok=false` path — there is NO new write site to
 * `status: "applied"` and NO new public-action surface.
 *
 * Scope is deliberately narrow:
 *   - LOW-RISK ONLY. Medium- and high-risk recommendations are NOT
 *     affected even with the flag on (they follow their existing
 *     golden-set policy and high-risk override flag).
 *   - DEFAULT OFF. Without the env var the gate is byte-identical to
 *     the pre-Phase-4-b baseline for every recommendation.
 *   - This is the FIRST AUTHORITATIVE USE of the attestation channel:
 *     `promotionBoundaryAudit` is updated in lock-step to recognise
 *     the new authorised block source. Pin 11 (single-write-site
 *     boundary) is preserved — `applyRecommendation` still routes only
 *     through `canPromote(rec).ok` and there is exactly one
 *     `status: "applied"` write site.
 *   - The Phase 4-a soft-warning channel is independent: the flag
 *     above does not influence Phase 4-b, and vice-versa. Operators
 *     who enabled only Phase 4-a will see no behavioral change here.
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

/** Env-flag identifier for the Phase 4-b operator-gated authoritative
 *  hard block on LOW-RISK promotions when the phase3aPrep readiness
 *  attestation is missing/parse_error/not `fully_prepared`. When this
 *  env var is set to the literal string `"true"` (case-insensitive)
 *  AND the recommendation is `risk === "low"`, the gate flips
 *  `ok = false` and surfaces a `"phase3aPrep readiness not satisfied
 *  …"` failure string. Default behavior (flag unset / any other value
 *  / non-low risk) is unchanged. */
export const PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV =
  "PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY" as const;

/** Pure helper: read the Phase 4-b flag from `process.env`. Mirrors
 *  `readPhase3aPrepReadyRequiredFlag` semantics: returns `true` ONLY
 *  for the literal string `"true"` (case-insensitive). Any other
 *  value, including unset / empty / `"1"` / `"yes"`, returns `false`.
 *  Phase 4-a and Phase 4-b flags are deliberately INDEPENDENT —
 *  enabling one does not enable the other. */
export function readPhase3aPrepBlockLowRiskFlag(): boolean {
  const v = process.env[PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV];
  if (typeof v !== "string") return false;
  return v.toLowerCase() === "true";
}

/** Env-flag identifier for the Phase 4-c part 2 (PR #403) operator-
 *  gated authoritative hard block on MEDIUM-RISK promotions when the
 *  phase3aPrep readiness attestation is missing / parse_error / not
 *  `fully_prepared` / stale / future-dated. Mirrors the Phase 4-b
 *  low-risk flag exactly: case-insensitive literal `"true"` enables;
 *  any other value (including unset / empty / `"1"` / `"yes"`)
 *  disables. The freshness threshold env var
 *  `PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS` is shared with the
 *  low-risk path — there is ONE freshness window governing both tiers.
 *  Default off so a deploy of PR #403 is a no-op until an operator
 *  flips this flag. High-risk gating is UNTOUCHED by Phase 4-c. */
export const PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV =
  "PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY" as const;

/** Pure helper: read the Phase 4-c part 2 medium-risk flag from
 *  `process.env`. Same case-insensitive `"true"`-only contract as
 *  `readPhase3aPrepBlockLowRiskFlag`. Independent of the low-risk
 *  flag — enabling one does not enable the other. */
export function readPhase3aPrepBlockMediumRiskFlag(): boolean {
  const v = process.env[PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV];
  if (typeof v !== "string") return false;
  return v.toLowerCase() === "true";
}

/** Env-flag identifier for the Phase 4-d (PR #408) operator-gated
 *  authoritative hard block on HIGH-RISK promotions when the phase3aPrep
 *  readiness attestation is missing / parse_error / not `fully_prepared`
 *  / stale / future-dated. Mirrors the Phase 4-c part 2 medium-risk
 *  flag (PR #403) exactly: case-insensitive literal `"true"` enables;
 *  any other value (including unset / empty / `"1"` / `"yes"`) disables.
 *
 *  Stacks on top of `PROMOTION_GATE_ALLOW_HIGH_RISK` — it does NOT
 *  replace that operator override. When Phase 4-d is on AND the
 *  attestation passes, the recommendation STILL needs
 *  `PROMOTION_GATE_ALLOW_HIGH_RISK=true` to clear. When Phase 4-d is
 *  off, high-risk behavior is exactly the pre-PR baseline (i.e.
 *  requires `PROMOTION_GATE_ALLOW_HIGH_RISK=true`).
 *
 *  Freshness threshold env var `PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS`
 *  is shared with the low-risk and medium-risk paths — there is ONE
 *  freshness window governing all three tiers. */
export const PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV =
  "PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY" as const;

/** Pure helper: read the Phase 4-d high-risk flag from `process.env`.
 *  Same case-insensitive `"true"`-only contract as
 *  `readPhase3aPrepBlockMediumRiskFlag`. Independent of the low-risk
 *  and medium-risk flags — enabling one does not enable the others. */
export function readPhase3aPrepBlockHighRiskFlag(): boolean {
  const v = process.env[PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV];
  if (typeof v !== "string") return false;
  return v.toLowerCase() === "true";
}

/** Env-var identifier for the Phase 4-c attestation-freshness gate.
 *  When this env var is set to a positive integer AND the Phase 4-b
 *  master switch is on AND the recommendation is `risk === "low"` AND
 *  the phase3aPrep attestation otherwise passes (status='evaluated',
 *  verdict='fully_prepared'), the gate hard-blocks promotion when the
 *  attestation's `attestedAt` timestamp is older than that many days.
 *  Default behavior (env unset / empty / non-numeric / <= 0) is
 *  identical to pre-4-c: no freshness check, no behavior change.
 *  Phase 4-c does NOT touch medium/high-risk gating. */
export const PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV =
  "PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS" as const;

/** Pure helper: parse the Phase 4-c freshness env var. Returns:
 *    - null when env unset / empty / whitespace-only
 *    - null when the parsed integer is not finite or <= 0
 *    - the positive integer otherwise (whole days, max age inclusive)
 *  Operator-facing: pick the unit so the env var reads naturally as
 *  "max age in days". The gate translates days → ms internally. */
export function readPhase3aPrepMaxAgeDays(): number | null {
  const v = process.env[PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV];
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Pure helper (exported for tests): decide whether a single phase3aPrep
 *  attestation should be treated as STALE under the Phase 4-c freshness
 *  rule. Same input → same output. NEVER reads env / clock / fs / db —
 *  `now` is passed by the caller (milliseconds since epoch).
 *
 *  Returns:
 *    - false when `maxAgeDays === null` (freshness gate disabled)
 *    - false when `attestation.status === "parse_error"` (the existing
 *      Phase 4-b parse_error path already hard-blocks; don't double-fire)
 *    - false when `attestation.attestedAt` is empty / not a parseable
 *      ISO timestamp (defensive — let the existing parse_error path or
 *      the verdict-not-fully_prepared path fire instead; we don't want
 *      this helper to become a second "missing attestation" surface)
 *    - true  when the parsed timestamp is older than
 *      `now - maxAgeDays * 86_400_000` ms
 *    - false otherwise (including future-dated; future-dating is handled
 *      separately by `isPhase3aAttestationFutureDated`) */
export function isPhase3aAttestationStale(
  attestation: PromotionAttestation,
  maxAgeDays:  number | null,
  now:         number,
): boolean {
  if (maxAgeDays === null) return false;
  if (attestation.status === "parse_error") return false;
  if (typeof attestation.attestedAt !== "string" || attestation.attestedAt.length === 0) {
    return false;
  }
  const parsed = Date.parse(attestation.attestedAt);
  if (!Number.isFinite(parsed)) return false;
  const maxAgeMs = maxAgeDays * 86_400_000;
  return now - parsed > maxAgeMs;
}

/** Pure helper (exported for tests): decide whether a single phase3aPrep
 *  attestation is future-dated relative to `now`. Future-dated
 *  attestations are operator-supplied evidence claiming a future
 *  computation time — they are nonsense and the freshness gate
 *  authoritatively blocks them, but only when freshness is on (matching
 *  the existing pattern: a freshness env var is the master switch for
 *  every freshness-derived decision).
 *
 *  Returns:
 *    - false when `maxAgeDays === null` (freshness gate disabled)
 *    - false when status is `"parse_error"` (the existing 4-b parse_error
 *      path already hard-blocks; don't double-fire)
 *    - false when `attestedAt` is empty / unparseable (same reasoning as
 *      `isPhase3aAttestationStale`)
 *    - true  when the parsed timestamp is strictly greater than `now`
 *    - false otherwise */
export function isPhase3aAttestationFutureDated(
  attestation: PromotionAttestation,
  maxAgeDays:  number | null,
  now:         number,
): boolean {
  if (maxAgeDays === null) return false;
  if (attestation.status === "parse_error") return false;
  if (typeof attestation.attestedAt !== "string" || attestation.attestedAt.length === 0) {
    return false;
  }
  const parsed = Date.parse(attestation.attestedAt);
  if (!Number.isFinite(parsed)) return false;
  return parsed > now;
}

/** Pure helper (exported for tests): derive Phase 4-b hard-block
 *  failure strings from the attestation array.
 *
 *  Phase 4-b authoritatively blocks LOW-RISK promotion when the
 *  operator opts in (`flagOn === true`) AND the recommendation is
 *  `risk === "low"` AND the phase3aPrep readiness signal is missing,
 *  parse_error, or its verdict is anything other than `fully_prepared`.
 *
 *  Returns an array of failure strings:
 *    - empty array  → no Phase 4-b block applies. Either the flag is
 *      off, the rec is not low-risk, or readiness is `fully_prepared`.
 *    - one entry    → the gate must surface this as an authoritative
 *      failure (the caller folds it into `failures` and sets `ok=false`).
 *
 *  This helper NEVER reads env / clock / fs / db — `flagOn` and `risk`
 *  are passed by the caller. It is pure: same input → same output.
 *
 *  Pin 11: the helper returns FAILURE STRINGS, not a new write path.
 *  The caller still owns the `ok` boolean and routes everything
 *  through the existing `failures.length === 0` gate. The single
 *  authoritative `status: "applied"` write site is unchanged. */
export function derivePhase3aPrepHardBlockFailures(
  attestations: ReadonlyArray<PromotionAttestation>,
  flagOn: boolean,
  risk: SelfRecommendation["risk"],
  maxAgeDays: number | null = null,
  now: number = Date.now(),
): string[] {
  if (!flagOn) return [];
  if (risk !== "low") return [];

  // Find the phase3aPrep attestation (the adapter contract guarantees
  // at most one is emitted today; if a future adapter emits multiple
  // we conservatively examine the first).
  const att = attestations.find(a => a.source === "phase3aPrep");

  if (att === undefined) {
    return [
      `phase3aPrep readiness attestation missing on low-risk promotion ` +
      `(operator opted in via ${PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true). ` +
      `Hard block — attach a phase3aPrepCandidate evidence marker with verdict='fully_prepared' to unblock.`,
    ];
  }

  if (att.status === "parse_error") {
    return [
      `phase3aPrep readiness attestation could not be parsed (parseError: ${att.parseError ?? "unknown"}); ` +
      `operator opted in via ${PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true. ` +
      `Hard block — fix the phase3aPrepCandidate evidence payload to unblock.`,
    ];
  }

  const verdict = att.readiness?.verdict;
  if (verdict !== "fully_prepared") {
    const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
    const verdictStr = verdict ?? "(missing)";
    return [
      `phase3aPrep readiness for candidate '${candidate}' is '${verdictStr}' ` +
      `(operator opted in via ${PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true). ` +
      `Hard block — drive the candidate to verdict='fully_prepared' to unblock.`,
    ];
  }

  // Phase 4-c (this PR): once the existing verdict / parse_error /
  // missing checks have all passed, optionally enforce attestation
  // freshness. `maxAgeDays === null` keeps behavior byte-identical to
  // pre-PR. Future-dating and over-age are evaluated in a deterministic
  // order — at most one freshness failure is emitted. Determinism is
  // important: a stale attestation that's also future-dated cannot
  // exist (mutually exclusive), so the order only matters for emitting
  // exactly one failure per attestation, never two.
  if (maxAgeDays !== null) {
    const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
    if (isPhase3aAttestationFutureDated(att, maxAgeDays, now)) {
      return [
        `phase3a_prep_attestation_future_dated (candidate '${candidate}', attestedAt='${att.attestedAt}'); ` +
        `operator opted in via ${PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV}=${maxAgeDays}. ` +
        `Hard block — re-compute the phase3aPrepCandidate evidence with a current timestamp.`,
      ];
    }
    if (isPhase3aAttestationStale(att, maxAgeDays, now)) {
      return [
        `phase3a_prep_attestation_stale (candidate '${candidate}', attestedAt='${att.attestedAt}', older than ${maxAgeDays} days); ` +
        `operator opted in via ${PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV}=${maxAgeDays}. ` +
        `Hard block — re-attest the phase3aPrepCandidate evidence to refresh attestedAt.`,
      ];
    }
  }

  return [];
}

/** Pure helper (exported for tests): derive Phase 4-c part 2 (PR #403)
 *  hard-block failure strings for MEDIUM-RISK promotions. Mirrors
 *  `derivePhase3aPrepHardBlockFailures` (the low-risk variant)
 *  byte-for-byte in shape, returning an array with 0 or 1 entries.
 *
 *  Fires only when:
 *    - `flagOn === true` (operator set
 *      `PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY=true`)
 *    - AND `risk === "medium"`.
 *
 *  When it fires, the helper enforces the SAME contract as the low-risk
 *  variant: missing attestation / parse_error / verdict !== fully_prepared
 *  block first; freshness (future-dated or stale) blocks after, gated by
 *  the SHARED `PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS` env var (no
 *  second freshness threshold — one window governs both tiers).
 *
 *  Each failure string references RISK=MEDIUM and the medium-risk env
 *  var name so operators can tell at a glance which branch fired.
 *
 *  Helpers reused (not duplicated):
 *    - `isPhase3aAttestationFutureDated` (from PR #401)
 *    - `isPhase3aAttestationStale` (from PR #401)
 *
 *  Pin 11: returns FAILURE STRINGS only. The caller routes them through
 *  the existing `failures` array and `failures.length === 0` gate. No
 *  new write site, no new mutation route, no new public surface.
 *
 *  High-risk: NEVER fires regardless of `flagOn`. Phase 4-c part 2 does
 *  not touch high-risk gating; that path is owned by a future PR. */
export function deriveMediumRiskPhase3aPrepHardBlockFailures(
  attestations: ReadonlyArray<PromotionAttestation>,
  flagOn: boolean,
  risk: SelfRecommendation["risk"],
  maxAgeDays: number | null = null,
  now: number = Date.now(),
): string[] {
  if (!flagOn) return [];
  if (risk !== "medium") return [];

  const att = attestations.find(a => a.source === "phase3aPrep");

  if (att === undefined) {
    return [
      `phase3aPrep readiness attestation missing on medium-risk promotion ` +
      `(operator opted in via ${PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true). ` +
      `Hard block — attach a phase3aPrepCandidate evidence marker with verdict='fully_prepared' to unblock.`,
    ];
  }

  if (att.status === "parse_error") {
    return [
      `phase3aPrep readiness attestation could not be parsed (parseError: ${att.parseError ?? "unknown"}); ` +
      `operator opted in via ${PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true. ` +
      `Hard block — fix the phase3aPrepCandidate evidence payload to unblock.`,
    ];
  }

  const verdict = att.readiness?.verdict;
  if (verdict !== "fully_prepared") {
    const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
    const verdictStr = verdict ?? "(missing)";
    return [
      `phase3aPrep readiness for candidate '${candidate}' is '${verdictStr}' ` +
      `(operator opted in via ${PROMOTION_GATE_BLOCK_MEDIUM_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true, risk=medium). ` +
      `Hard block — drive the candidate to verdict='fully_prepared' to unblock.`,
    ];
  }

  // Freshness layer — shared threshold env (PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS).
  // Determinism: a stale attestation cannot also be future-dated; at most
  // one failure is emitted per attestation.
  if (maxAgeDays !== null) {
    const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
    if (isPhase3aAttestationFutureDated(att, maxAgeDays, now)) {
      return [
        `phase3a_prep_attestation_future_dated (candidate '${candidate}', attestedAt='${att.attestedAt}', risk=medium); ` +
        `operator opted in via ${PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV}=${maxAgeDays}. ` +
        `Hard block — re-compute the phase3aPrepCandidate evidence with a current timestamp.`,
      ];
    }
    if (isPhase3aAttestationStale(att, maxAgeDays, now)) {
      return [
        `phase3a_prep_attestation_stale (candidate '${candidate}', attestedAt='${att.attestedAt}', older than ${maxAgeDays} days, risk=medium); ` +
        `operator opted in via ${PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV}=${maxAgeDays}. ` +
        `Hard block — re-attest the phase3aPrepCandidate evidence to refresh attestedAt.`,
      ];
    }
  }

  return [];
}

/** Pure helper (exported for tests): derive Phase 4-d (PR #408)
 *  hard-block failure strings for HIGH-RISK promotions. Mirrors
 *  `deriveMediumRiskPhase3aPrepHardBlockFailures` byte-for-byte in
 *  shape, returning an array with 0 or 1 entries.
 *
 *  Fires only when:
 *    - `flagOn === true` (operator set
 *      `PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY=true`)
 *    - AND `risk === "high"`.
 *
 *  When it fires, the helper enforces the SAME contract as the
 *  medium-risk variant: missing attestation / parse_error / verdict !==
 *  fully_prepared block first; freshness (future-dated or stale) blocks
 *  after, gated by the SHARED `PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS`
 *  env var (no third freshness threshold — one window governs all
 *  three tiers).
 *
 *  Each failure string references RISK=HIGH and the high-risk env var
 *  name so operators can tell at a glance which branch fired.
 *
 *  Helpers reused (not duplicated):
 *    - `isPhase3aAttestationFutureDated` (from PR #401)
 *    - `isPhase3aAttestationStale` (from PR #401)
 *
 *  Pin 11: returns FAILURE STRINGS only. The caller routes them through
 *  the existing `failures` array and `failures.length === 0` gate. No
 *  new write site, no new mutation route, no new public surface.
 *
 *  STACKING SEMANTICS: Phase 4-d does NOT replace the existing
 *  `PROMOTION_GATE_ALLOW_HIGH_RISK=true` operator override. When the
 *  flag is on AND the attestation passes, the rec STILL needs the
 *  high-risk override to clear. The caller in `canPromote` keeps the
 *  legacy override check intact and unconditionally below this block. */
export function deriveHighRiskPhase3aPrepHardBlockFailures(
  attestations: ReadonlyArray<PromotionAttestation>,
  flagOn: boolean,
  risk: SelfRecommendation["risk"],
  maxAgeDays: number | null = null,
  now: number = Date.now(),
): string[] {
  if (!flagOn) return [];
  if (risk !== "high") return [];

  const att = attestations.find(a => a.source === "phase3aPrep");

  if (att === undefined) {
    return [
      `phase3aPrep readiness attestation missing on high-risk promotion ` +
      `(operator opted in via ${PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true, risk=high). ` +
      `Hard block — attach a phase3aPrepCandidate evidence marker with verdict='fully_prepared' to unblock.`,
    ];
  }

  if (att.status === "parse_error") {
    return [
      `phase3aPrep readiness attestation could not be parsed (parseError: ${att.parseError ?? "unknown"}); ` +
      `operator opted in via ${PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true, risk=high. ` +
      `Hard block — fix the phase3aPrepCandidate evidence payload to unblock.`,
    ];
  }

  const verdict = att.readiness?.verdict;
  if (verdict !== "fully_prepared") {
    const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
    const verdictStr = verdict ?? "(missing)";
    return [
      `phase3aPrep readiness for candidate '${candidate}' is '${verdictStr}' ` +
      `(operator opted in via ${PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY_ENV}=true, risk=high). ` +
      `Hard block — drive the candidate to verdict='fully_prepared' to unblock.`,
    ];
  }

  // Freshness layer — shared threshold env (PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS).
  // Determinism: a stale attestation cannot also be future-dated; at most
  // one failure is emitted per attestation.
  if (maxAgeDays !== null) {
    const candidate = att.candidateId.length > 0 ? att.candidateId : "(unknown)";
    if (isPhase3aAttestationFutureDated(att, maxAgeDays, now)) {
      return [
        `phase3a_prep_attestation_future_dated (candidate '${candidate}', attestedAt='${att.attestedAt}', risk=high); ` +
        `operator opted in via ${PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV}=${maxAgeDays}. ` +
        `Hard block — re-compute the phase3aPrepCandidate evidence with a current timestamp.`,
      ];
    }
    if (isPhase3aAttestationStale(att, maxAgeDays, now)) {
      return [
        `phase3a_prep_attestation_stale (candidate '${candidate}', attestedAt='${att.attestedAt}', older than ${maxAgeDays} days, risk=high); ` +
        `operator opted in via ${PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS_ENV}=${maxAgeDays}. ` +
        `Hard block — re-attest the phase3aPrepCandidate evidence to refresh attestedAt.`,
      ];
    }
  }

  return [];
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

export async function canPromote(
  rec: SelfRecommendation,
  nowMs?: number,
): Promise<PromotionResult> {
  // When `nowMs` is supplied (probe / tests), every freshness comparison
  // inside this call uses it. Otherwise we fall back to the real wall
  // clock at the point of each comparison (preserves prior behavior).
  const now = nowMs ?? Date.now();
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
  // Phase 4-b: env flag snapshot taken ONCE, independent of Phase 4-a.
  // When set AND the rec is low-risk AND the phase3aPrep readiness
  // signal is missing/parse_error/not `fully_prepared`, the gate
  // appends an authoritative failure and `ok` flips to `false`. This
  // is the FIRST authoritative use of the attestation channel and is
  // mirrored by an update to `promotionBoundaryAudit` so the boundary
  // model recognises the new authorised block source.
  const hardBlockFlagOn = readPhase3aPrepBlockLowRiskFlag();
  // Phase 4-c part 2 (PR #403): independent env-var snapshot for the
  // operator-gated medium-risk hard block. Default off — a deploy of
  // this PR is a no-op until the operator flips this flag. High-risk
  // is UNTOUCHED. The medium-risk branch consumes the SAME freshness
  // threshold env (`PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS`) as the
  // low-risk branch — one window governs both tiers.
  const hardBlockMediumRiskFlagOn = readPhase3aPrepBlockMediumRiskFlag();
  // Phase 4-d (PR #408): independent env-var snapshot for the operator-
  // gated HIGH-RISK hard block. Default off — a deploy of this PR is a
  // no-op until the operator flips this flag. Stacks on top of the
  // existing `PROMOTION_GATE_ALLOW_HIGH_RISK` operator override (does
  // NOT replace it). The high-risk branch consumes the SAME freshness
  // threshold env (`PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS`) as the
  // low-risk and medium-risk branches — one window governs all tiers.
  const hardBlockHighRiskFlagOn = readPhase3aPrepBlockHighRiskFlag();
  // Phase 4-c: env var snapshot taken ONCE. null = freshness check
  // disabled (default). When set to a positive integer, both the
  // low-risk and (PR #403) medium-risk branches additionally enforce
  // `attestedAt` freshness via the two derive helpers. The freshness
  // check ONLY runs when the corresponding tier's hard-block flag is
  // on — the tier flag is the master switch. High-risk does NOT call
  // either helper and remains untouched by Phase 4-c.
  const phase3aMaxAgeDays = readPhase3aPrepMaxAgeDays();

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
    // Phase 4-b: operator-gated hard block on low-risk when the
    // phase3aPrep readiness attestation is missing / parse_error /
    // not `fully_prepared`. Default off; when off, this branch is a
    // no-op and we fall through to `finalize(true, ...)`. The block
    // is routed through the existing `failures`/`ok` machinery — no
    // new write site, no new mutation endpoint, no new public surface.
    const hardBlockFailures = derivePhase3aPrepHardBlockFailures(
      attestations,
      hardBlockFlagOn,
      rec.risk,
      phase3aMaxAgeDays,
      now,
    );
    if (hardBlockFailures.length > 0) {
      for (const f of hardBlockFailures) failures.push(f);
      return finalize(false, failures, ranSets);
    }
    return finalize(true, failures, ranSets);
  }

  // Phase 4-c part 2 (PR #403): operator-gated hard block on medium-risk
  // when the phase3aPrep readiness attestation is missing / parse_error /
  // not `fully_prepared` / stale / future-dated. Default off; when off,
  // this is a no-op and the legacy medium/high branch below decides the
  // verdict. Failures are routed through the existing `failures` / `ok`
  // machinery — no new write site, no new mutation endpoint, no new
  // public surface.
  if (rec.risk === "medium") {
    const mediumRiskHardBlockFailures = deriveMediumRiskPhase3aPrepHardBlockFailures(
      attestations,
      hardBlockMediumRiskFlagOn,
      rec.risk,
      phase3aMaxAgeDays,
      now,
    );
    for (const f of mediumRiskHardBlockFailures) failures.push(f);
  }

  // Phase 4-d (PR #408): operator-gated hard block on high-risk when the
  // phase3aPrep readiness attestation is missing / parse_error / not
  // `fully_prepared` / stale / future-dated. Default off; when off, this
  // is a no-op and high-risk behavior is exactly the pre-PR baseline.
  // STACKING SEMANTICS: this block adds failures on TOP of the existing
  // `PROMOTION_GATE_ALLOW_HIGH_RISK` override check below — it does NOT
  // replace that override. When Phase 4-d is on AND the attestation
  // passes, the rec STILL needs `PROMOTION_GATE_ALLOW_HIGH_RISK=true` to
  // clear. Failures are routed through the existing `failures` / `ok`
  // machinery — no new write site, no new mutation endpoint, no new
  // public surface.
  if (rec.risk === "high") {
    const highRiskHardBlockFailures = deriveHighRiskPhase3aPrepHardBlockFailures(
      attestations,
      hardBlockHighRiskFlagOn,
      rec.risk,
      phase3aMaxAgeDays,
      now,
    );
    for (const f of highRiskHardBlockFailures) failures.push(f);
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
