/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — MANUSCRIPT VERIFIER GATE (Roadmap PR #270)
 *
 * Adds a post-write claim-verifier gate to the live manuscript path
 * (researchEngine.runPhase7_Interpretation → topic.manuscript). Mirrors the
 * Article gate (`publishArticleDraft` HARD_FAIL → status='needs_revision')
 * so the same verifier contract / Lane A+B logic protects manuscripts
 * before they're served on the public research surface.
 *
 *   MANUSCRIPT_VERIFIER_ENABLED (env var, default false):
 *     OFF → no verifier call, no status assigned. Phase 7 behavior is
 *           unchanged from PR #269 (source ledger + claim map are still
 *           persisted as additive metadata; nothing in the public path
 *           changes).
 *     ON  → after Phase 7 sets `topic.manuscript`, the verifier runs over
 *           the manuscript using the persisted source ledger as the
 *           `sourceText` bundle. Verdict mapped to `topic.manuscriptStatus`:
 *             PASS / SOFT_WARN              → 'ok'
 *             HARD_FAIL (judge_unreachable
 *                        or NCITE_PATTERN)  → 'quarantined'
 *             HARD_FAIL (other)             → 'needs_revision'
 *           `publicResearchManuscripts` filters out anything not
 *           explicitly 'ok' when the gate is on.
 *
 * Why a separate module vs. inlining in `researchEngine`:
 *   `researchEngine` is already a 3000+ line file. Keeping the verifier
 *   wiring isolated keeps the diff reviewable, the flag test surface
 *   small, and lets a future research-engine refactor swap implementations
 *   without touching the consumer.
 *
 * Defensive: never throws. If anything in the verifier path misfires,
 * Phase 7 returns as if the flag were off — verifier gating is safety
 * scaffolding, not a critical-path dependency.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFlag } from "./featureFlags.js";
import { verifyClaims, type VerifierReport, type ClaimVerdict } from "./claimVerifier.js";
import { getLedgerByDraft, buildSourceContextForVerifier, listLedgerSourceUrls } from "./repositories/sourceLedgerRepository.js";
import { MANUSCRIPT_LEDGER_ENGINE } from "./manuscriptSourceLedger.js";

/** Single source of truth for the env var name. Read at call time so tests
 *  can flip it per-case (mirrors `readArticlePipelineFlag` pattern). */
export const MANUSCRIPT_VERIFIER_ENV = "MANUSCRIPT_VERIFIER_ENABLED";

export type ManuscriptStatus = "ok" | "needs_revision" | "quarantined";

export function manuscriptVerifierEnabled(): boolean {
  return readFlag(MANUSCRIPT_VERIFIER_ENV);
}

export interface ManuscriptVerifyInput {
  topicId: string;
  topic: string;
  manuscript: string;
  /** Optional override for the verifier's `sourceText` bundle. When omitted
   *  the gate hydrates from the persisted source ledger
   *  (engine='manuscript', draftId=topicId), which is what production calls
   *  pass through. */
  sourceTextOverride?: string;
  /** Optional override for the verifier's `sourceUrl` argument. When
   *  omitted, the first http(s) ledger URL is used; failing that, the
   *  empty string. The verifier only uses this for source-domain matching,
   *  so an empty string is safe. */
  sourceUrlOverride?: string;
  /** Test-only — wired through to `verifyClaims` so the deterministic
   *  paths can be exercised without an LLM judge. Production callers
   *  should never set this. */
  skipLLM?: boolean;
}

export interface ManuscriptVerifyResult {
  /** The status the caller should record on the ResearchTopic. Always one
   *  of `ok | needs_revision | quarantined`. */
  status: ManuscriptStatus;
  /** Full verifier report — useful for telemetry / dashboard. */
  verifierReport: VerifierReport;
  /** Mirrors `ClaimVerdict.severity` — surfaced for callers that want to
   *  branch on PASS/SOFT_WARN/HARD_FAIL without re-reading the report. */
  severity: ClaimVerdict["severity"];
  /** Reason string suitable for operator-facing display when the status
   *  is `needs_revision` or `quarantined`. Empty when status is `ok`. */
  reason: string;
  /** Number of sentences flagged as unsupported (HARD_FAIL contributors).
   *  0 when severity != HARD_FAIL. */
  unsupportedCount: number;
}

/**
 * Map a verifier verdict to a manuscript status. Public for testability —
 * the integration tests can pin the mapping behavior independently of the
 * verifier itself.
 *
 * Mapping rules (HARD_FAIL conservative gate):
 *   - PASS / SOFT_WARN → 'ok'
 *   - HARD_FAIL with judge_unreachable OR NCITE_PATTERN_HIT entries
 *                                   → 'quarantined' (operator review only)
 *   - HARD_FAIL otherwise           → 'needs_revision' (revise loop seam)
 *
 * Quarantine vs. needs_revision rationale: judge-unreachable + NCITE
 * patterns are the two cases where the verifier itself is signalling
 * "I can't trust the manuscript at all." Other HARD_FAILs (Lane A
 * fabrication, Lane B bare external facts) are recoverable by a revise
 * pass — Article uses `needs_revision` for the same family. When the
 * future revise loop is wired (using `buildManuscriptReviseSourceContext`),
 * `needs_revision` is the status it consumes.
 */
export function mapVerdictToManuscriptStatus(verdict: ClaimVerdict): {
  status: ManuscriptStatus;
  reason: string;
} {
  if (verdict.severity !== "HARD_FAIL") {
    return { status: "ok", reason: "" };
  }
  const judgeOut = verdict.verifierReport.judgeOutage;
  const judgeUnreachable =
    !!judgeOut && judgeOut.affectedSentences > 0 && !judgeOut.failOpenOverride;
  const ncite = verdict.verifierReport.entries.some(
    e => e.classification === "NCITE_PATTERN_HIT",
  );
  if (judgeUnreachable || ncite) {
    const reason = judgeUnreachable
      ? `${judgeOut!.reason}: ${judgeOut!.affectedSentences} unverifiable claim(s)`
      : `ncite-pattern: ${verdict.unsupportedClaims.length} unsupported claims`;
    return { status: "quarantined", reason };
  }
  return {
    status: "needs_revision",
    reason: `${verdict.unsupportedClaims.length} unsupported claims`,
  };
}

/**
 * Run the verifier over a manuscript and return the status + report.
 * Hydrates the verifier's `sourceText` from the persisted source ledger
 * when possible — same pattern Article's manual-revise hydration uses.
 *
 * This function does NOT mutate the topic. The caller is responsible for
 * recording the returned status on the ResearchTopic; that decision lives
 * with the caller so the gate can stay pure / testable.
 */
export async function runManuscriptVerifier(
  input: ManuscriptVerifyInput,
): Promise<ManuscriptVerifyResult> {
  const ledger = getLedgerByDraft(MANUSCRIPT_LEDGER_ENGINE, input.topicId);
  const ledgerItems = ledger?.items ?? [];
  const ledgerSourceText = ledgerItems.length > 0
    ? buildSourceContextForVerifier(ledgerItems)
    : "";
  const ledgerHttpUrls = listLedgerSourceUrls(ledgerItems);
  const sourceText = input.sourceTextOverride ?? ledgerSourceText;
  const sourceUrl = input.sourceUrlOverride ?? ledgerHttpUrls[0] ?? "";
  const sourceTitle = input.topic ?? "";

  const verdict = await verifyClaims({
    draftText: input.manuscript,
    sourceText,
    sourceUrl,
    sourceTitle,
    skipLLM: input.skipLLM,
    artifactMode: "MANUSCRIPT",
    engine: "manuscript",
    draftId: input.topicId,
  });

  const { status, reason } = mapVerdictToManuscriptStatus(verdict);
  const unsupportedCount = verdict.severity === "HARD_FAIL"
    ? verdict.unsupportedClaims.length
    : 0;
  return {
    status,
    verifierReport: verdict.verifierReport,
    severity: verdict.severity,
    reason,
    unsupportedCount,
  };
}

/**
 * Convenience wrapper that gates on `MANUSCRIPT_VERIFIER_ENABLED` and
 * swallows any unexpected errors. Returns `null` when the flag is off OR
 * the verifier path threw — the caller treats `null` as "no status
 * assigned, leave the manuscript as-is". This is the entry point Phase 7
 * uses; isolating the env-flag check + try/catch here keeps the call site
 * a single line.
 */
export async function maybeRunManuscriptVerifier(
  input: ManuscriptVerifyInput,
): Promise<ManuscriptVerifyResult | null> {
  if (!manuscriptVerifierEnabled()) return null;
  try {
    return await runManuscriptVerifier(input);
  } catch (e: any) {
    console.warn("[ManuscriptVerifier] verifier path failed:", e?.message ?? e);
    return null;
  }
}
