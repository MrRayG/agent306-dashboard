/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SELF-RULE HYGIENE (READ-ONLY DETECTOR)
 *
 * Conservative quarantine for malformed or non-actionable legacy executable
 * self-rules. The ActionEnforcer registry has accumulated rules whose
 * `target` (or canonical noun) is a parser fragment / stopword / function
 * word — e.g. archive_rule rows with target=`or`, `at`, `timer`, `all`,
 * `orphaned`. These rules fire on every DailyCycle tick, never match a real
 * entity, and only generate noise in the firing log.
 *
 * What this module does:
 *   - `isMalformedRule(rule)` → structural diagnosis. Pure, no I/O.
 *   - `summarizeMalformed(rule)` → short reason string for the visibility
 *     panel.
 *
 * What it intentionally does NOT do:
 *   - Mutate `data/enforcement_rules.json`. The historical row stays. The
 *     ActionEnforcer tick filters at evaluation time (read-path
 *     quarantine), preserving append-only / audit posture.
 *   - Disable rules through `disableRule(...)` — that path writes to the
 *     store. We want a soft, recoverable quarantine that can be tightened
 *     or loosened in a single place.
 *   - Inspect data shapes / entity tables. The detector is intentionally
 *     syntactic — we look at the rule's declared `target` (and noun in the
 *     ratio case) and ask "is this a real entity descriptor, or a parser
 *     fragment?". When the rule's `params` shape itself is meaningful, we
 *     re-use the same constraint.
 *
 * Hard invariants (Pin 7 / Pin 11 preserved):
 *   - No public action. No scheduler call. No registration. No PRs / posts
 *     / publishing / promotion-gate path is touched.
 *   - Pure read-side filter. A quarantined rule is still on the registry
 *     file and still surfaces in the audit log — only the runtime tick and
 *     `getEnforceableActiveRules()` skip it.
 *   - The valid-rule set is unchanged: a rule with a real entity target
 *     (`testing_hypothesis`, `kb_entry`, `dream_insight`, `hypothesis`,
 *     `synthesis`, `archived`, `merged`, etc.) is NOT quarantined.
 *
 * Why a separate module:
 *   - The detector is reused by the ActionEnforcer (skip-on-tick) and by
 *     the read-only visibility panel (count / reason surface) without
 *     duplicating the rule.
 *   - Future tightening (e.g. adding a new stopword) lands in one place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { EnforcementRule } from "./actionEnforcer.js";

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Function words / stopwords / parser fragments that are NEVER a real entity
 * descriptor on their own. These come from observed live data — production
 * after PR #380 surfaced archive_rule rows with target=`or`, `at`, `timer`,
 * `all`, `orphaned`. They are short, generic, or grammatically functional
 * words that emerged from regex captures of action text such as
 * "...archive items or remove them" or "...archive at the end of cycle".
 *
 * Conservative bias: a word lands here only if it
 *   (a) has been observed in production as a malformed target, or
 *   (b) is a high-confidence English stopword whose presence as a target
 *       indicates the parser tokenized a function word, not an entity.
 *
 * Add to this list cautiously. New entries should have a paper trail
 * (production sighting or test fixture).
 */
const MALFORMED_TARGET_STOPWORDS: ReadonlySet<string> = new Set([
  // Observed live in production (PR #382 post-deploy snapshot):
  "or",
  "at",
  "timer",
  "all",
  "orphaned",
  // Conservative additions — function words / fragments the same parser
  // path is known to capture:
  "and",
  "the",
  "a",
  "an",
  "of",
  "in",
  "to",
  "for",
  "with",
  "from",
  "by",
  "on",
  "off",
  "as",
  "is",
  "it",
  "if",
  "but",
  "than",
  "then",
  "this",
  "that",
  "those",
  "these",
  "them",
  "their",
  "there",
  "any",
  "some",
  "each",
  "none",
  "no",
  "yes",
  // Short, generic, or empty-shape fragments:
  "x",
  "y",
  "z",
  "n",
  "m",
  "items",
  "item",
  "entity",
  "thing",
  "things",
]);

/**
 * Minimum length below which a target string is treated as a parser fragment
 * (single-letter or two-letter token that is almost never an entity noun).
 * Conservative: real targets in this codebase are multi-character compound
 * snake_case identifiers (`kb_entry`, `testing_hypothesis`, `dream_insight`),
 * so a target of length < MIN_TARGET_LEN is almost always parser noise.
 */
const MIN_TARGET_LEN = 3;

/**
 * Known good substrings the runtime probes for in `target`. If a rule's
 * `target` contains ANY of these tokens, we treat it as actionable (the
 * existing primitive implementations route on these tokens). This list
 * mirrors what ActionEnforcer's `fireTtlRule` / `fireArchiveRule` look
 * for, plus a small set of canonical entity nouns. Used as an early
 * "definitely valid" exit.
 */
const ACTIONABLE_TARGET_TOKENS: readonly string[] = [
  "hypothes",
  "kb",
  "knowledge",
  "dream",
  "goal",
  "synthes",
  "artifact",
  "publication",
  "post",
  "brief",
  "dispatch",
  "narrative",
  "template",
  "behavioral_rule",
  "entity_v2", // intentional: keep room for future actionable targets
];

// ── Public API ──────────────────────────────────────────────────────────────

export interface MalformedRuleDiagnosis {
  /** True when the rule should be quarantined from the tick / read path. */
  malformed: boolean;
  /** Short reasons (one per detector hit). Empty when malformed=false. */
  reasons: string[];
}

/**
 * Diagnose whether an enforcement rule is malformed (non-actionable) and
 * should be quarantined at evaluation time. Pure: no I/O, no mutation, no
 * external state read.
 *
 * Conservative: returns malformed=true only on strong signals — a target
 * that is a stopword / function word / parser fragment, or a missing
 * target on a primitive that requires one. A rule whose target contains
 * an actionable token (`hypothes`, `kb`, `knowledge`, ...) is always
 * considered valid here, even when other params look unusual; this avoids
 * accidentally quarantining a working rule because of a minor field
 * irregularity.
 */
export function isMalformedRule(rule: EnforcementRule): MalformedRuleDiagnosis {
  const reasons: string[] = [];

  // Primitives that route on a `target` param. If the param is missing or
  // a known parser fragment, the rule can never produce a meaningful side
  // effect.
  const TARGET_PRIMITIVES: ReadonlySet<string> = new Set([
    "archive_rule",
    "ttl_rule",
    "gate_rule",
    "verification_rule",
    "rewrite_rule",
  ]);

  if (TARGET_PRIMITIVES.has(rule.primitive)) {
    const rawTarget = (rule.params as any)?.target;
    const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
    if (!target) {
      reasons.push(`${rule.primitive}: missing target param`);
    } else {
      const normalized = target.toLowerCase();
      // Early out — if the target contains any actionable token, the rule
      // is valid by construction. This guard prevents accidental quarantine
      // of e.g. target="kb_entry" or target="testing_hypothesis".
      const isActionable = ACTIONABLE_TARGET_TOKENS.some(tok =>
        normalized.includes(tok),
      );
      if (!isActionable) {
        if (normalized.length < MIN_TARGET_LEN) {
          reasons.push(
            `${rule.primitive}: target="${target}" is too short (<${MIN_TARGET_LEN} chars) to be a real entity descriptor`,
          );
        }
        if (MALFORMED_TARGET_STOPWORDS.has(normalized)) {
          reasons.push(
            `${rule.primitive}: target="${target}" is a stopword / parser fragment, not an entity`,
          );
        }
      }
    }
  }

  // ratio_rule routes on inputNoun + outputNoun. Same conservative
  // detector applied to BOTH nouns: a rule whose nouns are stopwords
  // cannot satisfy a real input/output ratio.
  if (rule.primitive === "ratio_rule") {
    const inputNoun = String((rule.params as any)?.inputNoun ?? "").trim();
    const outputNoun = String((rule.params as any)?.outputNoun ?? "").trim();
    for (const [label, noun] of [
      ["inputNoun", inputNoun],
      ["outputNoun", outputNoun],
    ] as const) {
      if (!noun) {
        reasons.push(`ratio_rule: missing ${label}`);
        continue;
      }
      const n = noun.toLowerCase();
      // Skip when the noun contains an actionable token (kb / knowledge / etc.)
      if (ACTIONABLE_TARGET_TOKENS.some(tok => n.includes(tok))) continue;
      if (n.length < MIN_TARGET_LEN) {
        reasons.push(
          `ratio_rule: ${label}="${noun}" is too short (<${MIN_TARGET_LEN} chars) to be a real noun`,
        );
      }
      if (MALFORMED_TARGET_STOPWORDS.has(n)) {
        reasons.push(
          `ratio_rule: ${label}="${noun}" is a stopword / parser fragment, not a noun`,
        );
      }
    }
  }

  return { malformed: reasons.length > 0, reasons };
}

/**
 * Short, human-readable summary of why a rule is quarantined. Used by the
 * read-only visibility panel. Empty string when the rule is not malformed.
 */
export function summarizeMalformed(rule: EnforcementRule): string {
  const diag = isMalformedRule(rule);
  if (!diag.malformed) return "";
  return diag.reasons.join("; ");
}

/**
 * Partition a rule list into enforceable vs quarantined. Helper for callers
 * that need both sides (tick path skips quarantined; visibility panel
 * counts and labels them).
 */
export function partitionByHygiene(rules: EnforcementRule[]): {
  enforceable: EnforcementRule[];
  quarantined: Array<{ rule: EnforcementRule; reasons: string[] }>;
} {
  const enforceable: EnforcementRule[] = [];
  const quarantined: Array<{ rule: EnforcementRule; reasons: string[] }> = [];
  for (const r of rules) {
    const diag = isMalformedRule(r);
    if (diag.malformed) {
      quarantined.push({ rule: r, reasons: diag.reasons });
    } else {
      enforceable.push(r);
    }
  }
  return { enforceable, quarantined };
}
