// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — STYLE-RULE CONFIDENCE PROMOTER (PR-D)
//
// Conservative, evidence-based promoter that lifts repeated/high-performing
// style rules into a stronger prompt-inclusion weight.
//
// SCOPE / INVARIANTS (do not weaken without re-review):
//   - Prompt/context weighting only. No public surface, no scheduler, no
//     content auto-generation. Pin 7 / Pin 11 boundaries preserved.
//   - Conservative: a rule promotes only when multiple, independent evidence
//     thresholds are met (hits, performance, completeness, no verifier
//     failure). When in doubt, do not promote.
//   - Auditable: every promotion records reason + evidence on the rule.
//   - Idempotent: a rule already at the promoted weight is a no-op.
//   - Pure: `evaluateStyleRulePromotion` has no side effects. The wrapper
//     `runStyleRulePromotion` performs the metadata mutation + save and is
//     intended to be invoked from existing reflection maintenance paths.
// ─────────────────────────────────────────────────────────────────────────────

import type { Reflection, StyleRule } from "./reflectionEngine.js";
import type { PerformanceLesson } from "./memoryEngine.js";

// ── Thresholds (intentionally conservative) ──────────────────────────────────

export const PROMOTER_THRESHOLDS = {
  // Repeated observation: at least 3 hits on the rule signature.
  MIN_HIT_COUNT: 3,
  // Need at least this many associated post-lessons to call it a signal.
  MIN_ASSOCIATED_POSTS: 3,
  // Promoted rules must clearly clear the noise floor on post score.
  MIN_AVG_SCORE: 6.0,
  // And must beat the recent baseline by at least this margin.
  MIN_MARGIN_OVER_BASELINE: 0.5,
  // Rule text must be complete enough to be useful in a prompt.
  MIN_RULE_CHARS: 20,
  MAX_RULE_CHARS: 600,
  // Promoted weight. `1` is normal/medium, `2` is "lifted" — used by
  // `getStyleRulesContext` to sort and to surface as a stronger directive.
  PROMOTED_WEIGHT: 2,
} as const;

// Tokens that strongly suggest the rule text is truncated or a verifier
// hard-fail / quarantine marker. Conservative — false positives just keep
// us at medium confidence.
const TRUNCATION_MARKERS = [" ...", "…", "[truncated]", "[TRUNCATED]"];
const VERIFIER_FAIL_MARKERS = [
  "verifier hard-fail",
  "verifier_failed",
  "quarantined",
  "hard fail",
  "lane a fail",
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface PromotionEvidence {
  associatedPostCount: number;
  avgAssociatedScore: number;
  baselineAvgScore: number;
  margin: number;
  hitCount: number;
  checkedAt: string;
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  evidence: PromotionEvidence;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rule text is complete enough to ship as a stronger prompt directive. */
export function isRuleTextHealthy(rule: string): boolean {
  if (!rule) return false;
  const trimmed = rule.trim();
  if (trimmed.length < PROMOTER_THRESHOLDS.MIN_RULE_CHARS) return false;
  if (trimmed.length > PROMOTER_THRESHOLDS.MAX_RULE_CHARS) return false;
  for (const m of TRUNCATION_MARKERS) {
    if (trimmed.includes(m)) return false;
  }
  // Reject rules that obviously end mid-word (no terminal punctuation AND
  // ends in a hyphen or a comma — strong truncation tells).
  const last = trimmed.slice(-1);
  if (last === "-" || last === ",") return false;
  return true;
}

/** Reflections whose ruleCandidate or sourceId matches this rule. */
export function findAssociatedReflections(
  rule: StyleRule,
  reflections: Reflection[],
): Reflection[] {
  const ruleText = (rule.rule || "").toLowerCase();
  const sourcePrefix = (rule.source || "").toLowerCase();
  const ruleHead = ruleText.slice(0, 30);

  const out: Reflection[] = [];
  for (const r of reflections) {
    if (rule.source && r.id === rule.source) {
      out.push(r);
      continue;
    }
    const cand = (r.analysis?.ruleCandidate || "").toLowerCase();
    if (cand && ruleHead && (cand.includes(ruleHead) || ruleText.includes(cand.slice(0, 30)))) {
      out.push(r);
      continue;
    }
    // Same-source family (e.g. "podcast_reflection") — useful when the
    // engine groups many evidence rows under one source bucket.
    if (sourcePrefix && sourcePrefix !== "improvement_plan" && r.id.toLowerCase().startsWith(sourcePrefix)) {
      out.push(r);
    }
  }
  return out;
}

/** Returns true if any associated evidence row is a verifier hard-fail signal. */
export function hasVerifierFailAssociation(
  rule: StyleRule,
  reflections: Reflection[],
  lessons: PerformanceLesson[],
): boolean {
  const ruleText = (rule.rule || "").toLowerCase();
  for (const m of VERIFIER_FAIL_MARKERS) {
    if (ruleText.includes(m)) return true;
  }
  for (const r of reflections) {
    const blob = [
      r.analysis?.whyWorked || "",
      r.analysis?.styleNote || "",
      ...(r.analysis?.patterns || []),
    ].join(" ").toLowerCase();
    for (const m of VERIFIER_FAIL_MARKERS) {
      if (blob.includes(m)) return true;
    }
  }
  // Bottom-rated by operator counts as a hard veto: if any associated
  // post was manually rated 1, do not promote.
  const associatedUrls = new Set(reflections.map(r => r.postUrl));
  for (const l of lessons) {
    if (!associatedUrls.has(l.tweetUrl)) continue;
    if (typeof l.manualRating === "number" && l.manualRating <= 1) return true;
  }
  return false;
}

/** Recent baseline = mean lesson score over the recent window. */
export function computeBaselineScore(lessons: PerformanceLesson[]): number {
  const scored = lessons.filter(l => typeof l.score === "number" && l.score > 0);
  if (scored.length === 0) return 0;
  const sum = scored.reduce((s, l) => s + l.score, 0);
  return sum / scored.length;
}

// ── Pure evaluator ───────────────────────────────────────────────────────────

/**
 * Decide whether a style rule should be promoted to stronger prompt inclusion.
 * Pure function — no I/O, no mutation. Caller decides whether to apply.
 */
export function evaluateStyleRulePromotion(
  rule: StyleRule,
  reflections: Reflection[],
  lessons: PerformanceLesson[],
  nowIso: string = new Date().toISOString(),
): PromotionDecision {
  const baseline = computeBaselineScore(lessons);
  const baseEvidence: PromotionEvidence = {
    associatedPostCount: 0,
    avgAssociatedScore: 0,
    baselineAvgScore: Math.round(baseline * 100) / 100,
    margin: 0,
    hitCount: rule.hitCount ?? 0,
    checkedAt: nowIso,
  };

  if ((rule.hitCount ?? 0) < PROMOTER_THRESHOLDS.MIN_HIT_COUNT) {
    return { promote: false, reason: "insufficient_hit_count", evidence: baseEvidence };
  }

  if (!isRuleTextHealthy(rule.rule || "")) {
    return { promote: false, reason: "rule_text_unhealthy", evidence: baseEvidence };
  }

  const associated = findAssociatedReflections(rule, reflections);
  const associatedUrls = new Set(associated.map(r => r.postUrl));
  const associatedLessons = lessons.filter(l => associatedUrls.has(l.tweetUrl));

  // Use lesson scores when we have them (truer to post performance) and
  // fall back to reflection-recorded score otherwise.
  const associatedScores: number[] = [];
  for (const l of associatedLessons) {
    if (typeof l.score === "number" && l.score > 0) associatedScores.push(l.score);
  }
  if (associatedScores.length === 0) {
    for (const r of associated) {
      if (typeof r.score === "number" && r.score > 0) associatedScores.push(r.score);
    }
  }

  const evidence: PromotionEvidence = {
    ...baseEvidence,
    associatedPostCount: associatedScores.length,
  };

  if (associatedScores.length < PROMOTER_THRESHOLDS.MIN_ASSOCIATED_POSTS) {
    return { promote: false, reason: "insufficient_associated_posts", evidence };
  }

  const avg = associatedScores.reduce((s, v) => s + v, 0) / associatedScores.length;
  evidence.avgAssociatedScore = Math.round(avg * 100) / 100;
  evidence.margin = Math.round((avg - baseline) * 100) / 100;

  if (avg < PROMOTER_THRESHOLDS.MIN_AVG_SCORE) {
    return { promote: false, reason: "below_min_avg_score", evidence };
  }
  if (baseline > 0 && (avg - baseline) < PROMOTER_THRESHOLDS.MIN_MARGIN_OVER_BASELINE) {
    return { promote: false, reason: "below_baseline_margin", evidence };
  }

  if (hasVerifierFailAssociation(rule, associated, lessons)) {
    return { promote: false, reason: "verifier_fail_or_low_rating_association", evidence };
  }

  return { promote: true, reason: "evidence_thresholds_met", evidence };
}

// ── Idempotency check ────────────────────────────────────────────────────────

/** A rule is "already promoted" if its weight is at/above the promoted bar. */
export function isAlreadyPromoted(rule: StyleRule): boolean {
  return (rule.weight ?? 1) >= PROMOTER_THRESHOLDS.PROMOTED_WEIGHT;
}

// ── Apply (mutating wrapper) ─────────────────────────────────────────────────

export interface PromotionApplyResult {
  ruleId: string;
  promoted: boolean;
  alreadyPromoted: boolean;
  reason: string;
  evidence: PromotionEvidence;
}

/**
 * Evaluate one rule and, if eligible, lift its weight + record audit
 * metadata. Mutates `rule` in place. Idempotent: already-promoted rules
 * short-circuit. Does not save to disk — caller persists.
 */
export function applyPromotionDecision(
  rule: StyleRule,
  reflections: Reflection[],
  lessons: PerformanceLesson[],
  nowIso: string = new Date().toISOString(),
): PromotionApplyResult {
  if (isAlreadyPromoted(rule)) {
    return {
      ruleId: rule.id,
      promoted: false,
      alreadyPromoted: true,
      reason: "already_promoted",
      evidence: {
        associatedPostCount: 0,
        avgAssociatedScore: 0,
        baselineAvgScore: 0,
        margin: 0,
        hitCount: rule.hitCount ?? 0,
        checkedAt: nowIso,
      },
    };
  }

  const decision = evaluateStyleRulePromotion(rule, reflections, lessons, nowIso);
  if (!decision.promote) {
    return {
      ruleId: rule.id,
      promoted: false,
      alreadyPromoted: false,
      reason: decision.reason,
      evidence: decision.evidence,
    };
  }

  rule.weight = PROMOTER_THRESHOLDS.PROMOTED_WEIGHT;
  rule.confidence = "high";
  rule.promotedAt = nowIso;
  rule.promotionReason = decision.reason;
  rule.promotionEvidence = decision.evidence;

  return {
    ruleId: rule.id,
    promoted: true,
    alreadyPromoted: false,
    reason: decision.reason,
    evidence: decision.evidence,
  };
}
