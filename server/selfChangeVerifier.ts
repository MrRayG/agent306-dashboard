// ---------------------------------------------------------------------------
// 306 -- SELF-CHANGE VERIFIER
//
// Before the next SelfEvolution cycle runs, check whether prior-cycle
// commitments actually produced behavior change. The verifier reads the
// Insight Ledger, queries the ActionEnforcer fire counts, and transitions
// each open commitment to either:
//
//   verified — the rule fired at least minFireCount times, producing at least
//              one side effect. The behavior change is real.
//   failed   — the rule is registered but never fired, or fired without any
//              side effect. First-class self-change failure signal.
//
// Failed commitments feed the NEXT SelfEvolution cycle's reflection prompt
// as meta-input: "last time I said I'd do X and didn't — why?" That's the
// mechanism that turns metacognition into actual learning.
//
// Also updates the Self-Integrity competency based on the verified/failed
// ratio over a rolling 30-day window.
// ---------------------------------------------------------------------------

import {
  loadLedger,
  transitionEntry,
  computeLedgerStats,
  getOpenCommitments,
  getClosedCommitmentsSince,
  type InsightLedgerEntry,
} from "./insightLedger.js";
import { getRulesByInsight } from "./actionEnforcer.js";
import { updateCompetencyLevel } from "./competencyFramework.js";

export interface VerificationResult {
  verified: number;
  failed: number;
  stillOpen: number;
  selfIntegrityScore: number;
  checkedAt: number;
  details: Array<{ id: string; status: string; reason: string }>;
}

/**
 * Run the verification pass. Called at the start of each SelfEvolution cycle,
 * before fresh reflection happens, so the next reflection can see which
 * prior commitments were kept.
 */
export function runVerificationPass(): VerificationResult {
  const result: VerificationResult = {
    verified: 0,
    failed: 0,
    stillOpen: 0,
    selfIntegrityScore: 0,
    checkedAt: Date.now(),
    details: [],
  };

  const open = getOpenCommitments();
  for (const entry of open) {
    const { status, reason } = verifyOneCommitment(entry);
    if (status === "verified") {
      transitionEntry(entry.id, "verified", {
        evidenceOfChange: [reason],
      });
      result.verified++;
      result.details.push({ id: entry.id, status: "verified", reason });
    } else if (status === "failed") {
      transitionEntry(entry.id, "failed", {
        selfChangeFailureReason: reason,
      });
      result.failed++;
      result.details.push({ id: entry.id, status: "failed", reason });
    } else {
      result.stillOpen++;
      result.details.push({ id: entry.id, status: "open", reason });
    }
  }

  // Update self-integrity competency based on ledger stats.
  const stats = computeLedgerStats(result.checkedAt);
  result.selfIntegrityScore = stats.selfIntegrityScore;
  applySelfIntegrityCompetency(stats.selfIntegrityScore, result.verified, result.failed);

  return result;
}

/**
 * Check a single open commitment. Returns the transition to apply.
 *
 * Verified rules: fired >= minFireCount times AND produced at least one side
 * effect. Without side effects, we can't call it a real behavior change.
 *
 * Failed rules: rule is registered but fireCount is 0 after the acceptance
 * window, OR rule fired but all outcomes were "no-op" (no side effects).
 *
 * Still open: rule is firing but hasn't yet hit its verification criterion.
 */
function verifyOneCommitment(entry: InsightLedgerEntry): { status: "verified" | "failed" | "open"; reason: string } {
  if (!entry.ruleId) {
    return { status: "open", reason: "no rule registered" };
  }
  const rules = getRulesByInsight(entry.id);
  if (rules.length === 0) {
    // Rule was registered but disappeared (file corruption? cap eviction?)
    const ageMs = Date.now() - (entry.acceptedAt ?? entry.createdAt);
    if (ageMs > 14 * 24 * 60 * 60 * 1000) {
      return { status: "failed", reason: "registered rule missing for 14+ days" };
    }
    return { status: "open", reason: "rule not yet discoverable" };
  }

  const rule = rules[0];
  const minFires = 3;            // Configurable via primitive in future
  const minSideEffects = 1;
  const hasEnoughFires = rule.fireCount >= minFires;
  const hasSideEffect = (rule.sideEffectCount ?? 0) >= minSideEffects;

  // Verified: meets both bars
  if (hasEnoughFires && hasSideEffect) {
    return {
      status: "verified",
      reason: `rule fired ${rule.fireCount}x with ${rule.sideEffectCount} side effects — commitment kept`,
    };
  }

  // Failed: acceptance window elapsed without meeting bars
  const ageMs = Date.now() - (entry.acceptedAt ?? entry.createdAt);
  const windowMs = 14 * 24 * 60 * 60 * 1000;
  if (ageMs > windowMs) {
    if (rule.fireCount === 0) {
      return { status: "failed", reason: "rule registered but never fired" };
    }
    if (!hasSideEffect) {
      return {
        status: "failed",
        reason: `rule fired ${rule.fireCount}x but produced 0 side effects — behavior didn't change`,
      };
    }
    return {
      status: "failed",
      reason: `rule fired ${rule.fireCount}x but fell short of ${minFires}-fire threshold within window`,
    };
  }

  return {
    status: "open",
    reason: `rule fired ${rule.fireCount}/${minFires} with ${rule.sideEffectCount ?? 0} side effects`,
  };
}

/**
 * Apply Self-Integrity delta to the competency framework.
 * Called once per verification pass, independent of individual entry outcomes.
 *
 * Self-Integrity is not a level you cross once — it's a rolling ratio of
 * commitments-kept to commitments-made. Score drives a slow-moving delta so a
 * single bad cycle doesn't tank it.
 */
function applySelfIntegrityCompetency(score: number, verifiedThisCycle: number, failedThisCycle: number): void {
  if (verifiedThisCycle + failedThisCycle === 0) return;
  // Map score 0-1 to a gentle delta.
  //   score >= 0.8 → +0.3 (strong follow-through)
  //   score in 0.5..0.8 → +0.1
  //   score in 0.3..0.5 → -0.1
  //   score < 0.3 → -0.3 (chronic self-change failure)
  let delta = 0;
  if (score >= 0.8) delta = 0.3;
  else if (score >= 0.5) delta = 0.1;
  else if (score >= 0.3) delta = -0.1;
  else delta = -0.3;

  const reason =
    `[self-change-verifier] ${verifiedThisCycle} verified, ${failedThisCycle} failed this pass; ` +
    `rolling 30d self-integrity = ${score.toFixed(2)}`;

  try {
    updateCompetencyLevel("self-integrity", delta, reason);
  } catch (e: any) {
    console.warn("[SelfChangeVerifier] Competency update failed (non-fatal):", e.message);
  }
}

/**
 * Build a short meta-reflection string for inclusion in the NEXT SelfEvolution
 * cycle's reflection prompt. This is how failed commitments become inputs to
 * learning rather than quietly accumulating.
 */
export function buildMetaReflectionContext(): string {
  const recentFailuresMs = 7 * 24 * 60 * 60 * 1000;
  const since = Date.now() - recentFailuresMs;
  const closed = getClosedCommitmentsSince(since);
  const failures = closed.filter(e => e.status === "failed");
  const verifieds = closed.filter(e => e.status === "verified");

  if (failures.length === 0 && verifieds.length === 0) {
    return "SELF-CHANGE TRACK RECORD: No commitments closed in the past 7 days yet.";
  }

  const parts: string[] = ["SELF-CHANGE TRACK RECORD (past 7 days):"];

  if (verifieds.length > 0) {
    parts.push(`\nKept (${verifieds.length}):`);
    for (const e of verifieds.slice(0, 5)) {
      parts.push(`  ✓ "${e.insight.slice(0, 90)}" — rule fired, behavior changed`);
    }
  }

  if (failures.length > 0) {
    parts.push(`\nBroken (${failures.length}) — these demand honest meta-reflection:`);
    for (const e of failures.slice(0, 5)) {
      parts.push(`  ✗ "${e.insight.slice(0, 90)}" — ${e.selfChangeFailureReason ?? "no reason recorded"}`);
    }
    parts.push(
      `\nFor any broken commitment, ask: was the action too vague to enforce? Was the rule right but the system blocked? Am I diagnosing the same problem repeatedly because the fix doesn't stick? Surface at least one insight that addresses WHY a prior commitment failed.`,
    );
  }

  return parts.join("\n");
}
