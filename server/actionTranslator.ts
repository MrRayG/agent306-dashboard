// ---------------------------------------------------------------------------
// 306 -- ACTION TRANSLATOR
//
// Converts natural-language insight actions from SelfEvolution into one of
// four enforcement primitives that actually fire at runtime:
//
//   ratio_rule    — force output-per-input ratios (e.g. 1 synthesis / 10 KB)
//   ttl_rule      — expire items after N days without state change
//   gate_rule     — block X until Y condition holds
//   archive_rule  — auto-archive items matching a pattern
//
// Agent 306's own action strings from the log (verbatim) are the design input:
//   - "For every 10 new knowledge entries, force-generate one synthesis"      → ratio_rule
//   - "Implement a strict 14-day TTL on testing hypotheses..."                → ttl_rule
//   - "Implement a pre-registration gate: before any hypothesis enters..."    → gate_rule
//   - "Archive the 2 dream insight entries (speculative, no evidence)..."     → archive_rule
//
// If none match, returns { primitive: "none", reason } and the insight stays
// in `proposed` status until its TTL expires. Vague commitments should die.
// ---------------------------------------------------------------------------

import type { EnforcementPrimitive } from "./insightLedger.js";
import type { GoalCategory } from "./researchEngine.js";
import { registerRule, type EnforcementRule } from "./actionEnforcer.js";

export interface TranslatedAction {
  primitive: EnforcementPrimitive;
  params: Record<string, unknown>;
  verificationCriterion: string;
  suggestedCategory?: GoalCategory;
  minFireCount?: number;
  reason?: string;
}

// -- Parsers -----------------------------------------------------------------

const RATIO_PATTERNS = [
  // "for every 10 new knowledge entries, force-generate one synthesis"
  /(?:for\s+every|per|every)\s+(\d+)\s+(?:new\s+)?(\w+(?:\s+\w+){0,3}?)[,\s]+(?:force[-\s]?generate|generate|produce|ship|publish|create)\s+(?:one|an?|\d+)\s+(\w+(?:\s+\w+){0,2})/i,
  // "1 synthesis per 10 KB entries"
  /(\d+)\s+(\w+(?:\s+\w+){0,2})\s+per\s+(\d+)\s+(\w+(?:\s+\w+){0,3})/i,
];

const TTL_PATTERNS = [
  // "strict 14-day TTL on testing hypotheses"
  /(\d+)[-\s]?day\s+(?:ttl|timeout|expiry|expire|deadline|cutoff)\s+(?:on|for|applied\s+to)\s+(\w+(?:\s+\w+){0,3})/i,
  // "expire after 3 days" / "retire after 14 days"
  /(?:expire|retire|archive|prune|kill|close)\s+(?:items?\s+)?(?:after|in|past|over)\s+(\d+)\s+days?/i,
];

const GATE_PATTERNS = [
  // "pre-registration gate: before any hypothesis enters testing..."
  /(?:pre[-\s]?registration|feasibility|pre[-\s]?check|gate|block)\s+(?:gate\s+)?(?::|before|on|for)\s+([^\.]+)/i,
  // "require X before Y"
  /require[s]?\s+([^\.]+?)\s+before\s+([^\.]+)/i,
];

const ARCHIVE_PATTERNS = [
  // "archive the 2 dream insight entries (speculative, no evidence)"
  /archive\s+(?:the\s+)?(\d+\s+)?([^\.(]+?)(?:\s*\(([^)]+)\))?(?:\s|$|\.)/i,
  // "retire X matching Y"
  /(?:retire|prune|delete|remove)\s+(\w+(?:\s+\w+){0,3})\s+(?:matching|with|containing)\s+([^\.]+)/i,
];

// -- Main translator ---------------------------------------------------------

export function translateAction(actionText: string, insightText: string = ""): TranslatedAction {
  const a = actionText.trim();
  if (!a) return { primitive: "none", params: {}, verificationCriterion: "", reason: "empty action" };

  // Try RATIO first — most specific signature
  for (const pat of RATIO_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      // Pattern 1: "every N input, one output"
      //   m[1]=N (input count), m[2]=input noun, m[3]=output noun
      // Pattern 2: "N output per M input"
      //   m[1]=N, m[2]=output, m[3]=M, m[4]=input
      let inputCount: number, outputCount: number, inputNoun: string, outputNoun: string;
      if (pat === RATIO_PATTERNS[0]) {
        inputCount = parseInt(m[1], 10);
        inputNoun = normalizeNoun(m[2]);
        outputNoun = normalizeNoun(m[3]);
        outputCount = 1;
      } else {
        outputCount = parseInt(m[1], 10);
        outputNoun = normalizeNoun(m[2]);
        inputCount = parseInt(m[3], 10);
        inputNoun = normalizeNoun(m[4]);
      }
      const params = { inputCount, inputNoun, outputCount, outputNoun };
      return {
        primitive: "ratio_rule",
        params,
        verificationCriterion: `ratio(${outputNoun}/${inputNoun}) >= ${outputCount}/${inputCount}`,
        suggestedCategory: "craft",
        minFireCount: 1,
      };
    }
  }

  // TTL
  for (const pat of TTL_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      let days: number, target: string;
      if (pat === TTL_PATTERNS[0]) {
        days = parseInt(m[1], 10);
        target = normalizeNoun(m[2]);
      } else {
        days = parseInt(m[1], 10);
        target = inferTargetFromContext(insightText);
      }
      return {
        primitive: "ttl_rule",
        params: { days, target },
        verificationCriterion: `every ${target} older than ${days}d without state change is expired`,
        suggestedCategory: "knowledge",
        minFireCount: 1,
      };
    }
  }

  // GATE
  for (const pat of GATE_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      const description = m[1]?.slice(0, 200) ?? "unspecified";
      return {
        primitive: "gate_rule",
        params: { description, target: inferGateTarget(a) },
        verificationCriterion: `gate fires on each ${inferGateTarget(a)} entering the guarded state`,
        suggestedCategory: "identity",
        minFireCount: 3,
      };
    }
  }

  // ARCHIVE
  for (const pat of ARCHIVE_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      const target = normalizeNoun(m[2] ?? m[1] ?? "items");
      const criteria = (m[3] ?? m[2] ?? "").slice(0, 200);
      const count = m[1] ? parseInt(m[1], 10) : undefined;
      return {
        primitive: "archive_rule",
        params: { target, criteria, count },
        verificationCriterion: `items matching "${target}" ${criteria ? `+ "${criteria}"` : ""} are archived on next tick`,
        suggestedCategory: "knowledge",
        minFireCount: 1,
      };
    }
  }

  return {
    primitive: "none",
    params: {},
    verificationCriterion: "",
    reason: `No primitive matched action: "${a.slice(0, 120)}"`,
  };
}

function normalizeNoun(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function inferTargetFromContext(insight: string): string {
  const t = insight.toLowerCase();
  if (t.includes("hypothes")) return "testing_hypothesis";
  if (t.includes("kb") || t.includes("knowledge")) return "kb_entry";
  if (t.includes("goal")) return "goal";
  if (t.includes("dream")) return "dream_insight";
  return "item";
}

function inferGateTarget(action: string): string {
  const t = action.toLowerCase();
  if (t.includes("hypothes")) return "hypothesis";
  if (t.includes("goal")) return "goal";
  if (t.includes("post") || t.includes("publish")) return "publication";
  return "entity";
}

// -- Rule registration bridge -----------------------------------------------

/**
 * Register a concrete enforcement rule for a translated insight.
 * Returns the rule ID for storage on the Ledger entry.
 */
export function registerRuleFromInsight(
  insightId: string,
  translation: TranslatedAction,
): string {
  const rule: EnforcementRule = {
    id: `rule_${insightId}_${Date.now().toString(36)}`,
    insightId,
    primitive: translation.primitive,
    params: translation.params,
    criterion: translation.verificationCriterion,
    createdAt: Date.now(),
    fireCount: 0,
    lastFiredAt: null,
    enabled: true,
  };
  registerRule(rule);
  return rule.id;
}
