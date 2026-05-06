// ---------------------------------------------------------------------------
// 306 -- ACTION TRANSLATOR
//
// Converts natural-language insight actions from SelfEvolution into one of
// six enforcement primitives that actually fire at runtime:
//
//   ratio_rule        — force output-per-input ratios (e.g. 1 synthesis / 10 KB)
//   ttl_rule          — expire items after N days without state change
//   gate_rule         — block X until Y condition holds
//   archive_rule      — auto-archive items matching a pattern
//   artifact_rule     — force ONE concrete output artifact within N cycles
//                       (added 2026-05-01: closes the missing-primitive gap that
//                       surfaced 12+ times in the 4/25–4/30 self-recommendation log,
//                       where SelfEvolution kept producing "produce one concrete
//                       output artifact this cycle" insights with no translator
//                       target. The result was a maintenance loop: zero breakthroughs,
//                       zero archives, zero self-change commitments closed.)
//   verification_rule — track/measure a state without forcing a rule.
//                       (added 2026-05-05: SelfEvolution kept emitting "track
//                       firing rate next cycle" / "measure adoption of behavioral
//                       rule X" actions that the translator dropped because none
//                       of the five forcing primitives applied. Verification is
//                       observation-only — no transition is blocked, no artifact
//                       is forced — but the rule still fires each tick so the
//                       Self-Change Verifier can credit observed adoption
//                       instead of letting the commitment quietly expire.)
//   rewrite_rule      — structural template rewrite (non-forcing).
//                       (added 2026-05-06: SelfEvolution kept emitting
//                       "Reframe content strategy growth focus from 'produce
//                       story-first posts' to '...'" — a commitment to change
//                       the *shape* of a downstream template/framing, not a
//                       count or a transition gate. The translator previously
//                       fell through to `none` and the GoalEngine emitted the
//                       same "missing-primitive: rewrite family" rec every
//                       cycle. The rewrite primitive is observation-only:
//                       it ticks each cycle so the Self-Change Verifier can
//                       credit adoption when the new template appears, but
//                       does not block transitions or force counts. Promote
//                       to gate_rule once the structural check is stable
//                       enough to express as a hard rule.)
//
// Agent 306's own action strings from the log (verbatim) are the design input:
//   - "For every 10 new knowledge entries, force-generate one synthesis"      → ratio_rule
//   - "Implement a strict 14-day TTL on testing hypotheses..."                → ttl_rule
//   - "Implement a pre-registration gate: before any hypothesis enters..."    → gate_rule
//   - "Archive the 2 dream insight entries (speculative, no evidence)..."     → archive_rule
//   - "Promote 1 additional behavioral rule ... track firing rate next cycle" → verification_rule
//   - "Implement a mandatory pre-testing gate: before any hypothesis moves    → gate_rule
//      from forming to testing, require explicit identification of the
//      specific data source that could confirm/reject it..."
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
  // "implement a mandatory pre-testing gate" / "implement a pre-formation gate"
  // Captures the gate descriptor without needing a colon.
  /(?:implement|introduce|add|install)\s+(?:a\s+)?(?:mandatory\s+)?(pre[-\s]?(?:testing|formation|registration|check|flight|merge|publish)[-\s\w]*\s+gate)/i,
  // "before X moves from A to B, require Y" — measurement-path / data-source gate
  /before\s+(?:any\s+)?([^\.]+?)\s+(?:moves?|transitions?)\s+from\s+\w+\s+to\s+\w+\s*,?\s*require\s+([^\.]+)/i,
  // "before forming any new hypothesis, require a measurement path field"
  /before\s+forming\s+(?:any\s+)?(?:new\s+)?([^\.,]+?)\s*,?\s*require\s+(?:a\s+|an\s+|the\s+)?([^\.]+)/i,
];

const ARCHIVE_PATTERNS = [
  // "archive the 2 dream insight entries (speculative, no evidence)"
  /archive\s+(?:the\s+)?(\d+\s+)?([^\.(]+?)(?:\s*\(([^)]+)\))?(?:\s|$|\.)/i,
  // "retire X matching Y"
  /(?:retire|prune|delete|remove)\s+(\w+(?:\s+\w+){0,3})\s+(?:matching|with|containing)\s+([^\.]+)/i,
];

// ARTIFACT — "produce/ship/publish ONE concrete <thing> within/this cycle".
// This is the primitive that was missing from 4/25–4/30. SelfEvolution was
// generating insights like:
//   "Next cycle: produce one concrete output artifact (a synthesized narrative,
//    a decision framework, or a content draft) that exercises Storytelling or
//    Creativity before adding any new hypotheses."
//   "Dedicate next cycle's first action to producing one concrete output artifact
//    (a briefing, a thread, a post) that synthesizes the confirmed hypotheses."
// Both fell through every other primitive and landed in `none`.
const ARTIFACT_PATTERNS = [
  // "produce one concrete output artifact (...) within next cycle"
  // The [^.]*? between the optional parens and the time-window phrase lets us
  // tolerate qualifying prose like "...that exercises Storytelling or Creativity".
  /(?:produce|ship|publish|generate|create|deliver|write|draft)\s+(?:exactly\s+)?(?:one|1|a\s+single)\s+(?:concrete\s+)?(?:output\s+)?(\w+(?:\s+\w+){0,3}?)(?:\s*\(([^)]+)\))?[^.]*?\b(?:within|in|by|before|this|next|each)\s+(?:the\s+)?(?:next\s+)?(\d+)?\s*(cycle|day|week|cycles|days|weeks)\b/i,
  // "dedicate next cycle's first action to producing one concrete output artifact"
  /(?:dedicate|commit|allocate)\s+(?:next\s+)?(?:cycle['']?s?\s+)?(?:first\s+)?action\s+to\s+(?:producing|shipping|publishing|generating|creating|delivering|writing|drafting)\s+(?:one|1|a\s+single)\s+(?:concrete\s+)?(\w+(?:\s+\w+){0,3})/i,
];

// VERIFICATION — observation-only primitive. Surfaces patterns like
//   "track firing rate next cycle"
//   "measure adoption of behavioral rule X"
//   "monitor how often the new gate triggers"
// where the action is to OBSERVE a state, not to force a transition or
// produce an artifact. Without this, SelfEvolution emitted these as untyped
// actions and they fell through to `none`, which caused a stream of
// "missing-primitive: verification family" recommendations. The rule
// itself is non-blocking — it ticks every cycle, reports the metric, and
// lets the Self-Change Verifier credit observed adoption.
const VERIFICATION_PATTERNS = [
  // "track firing rate ... next cycle" / "track adoption of X over N cycles"
  /(?:track|monitor|measure|observe|quantify)\s+(?:the\s+)?([^\.,]+?)(?:\s+(?:over|across|for|next|each|this|every)\s+(?:the\s+)?(?:next\s+)?(\d+)?\s*(cycle|day|week|cycles|days|weeks))?\b/i,
  // "verify firing rate" / "verify adoption"
  /verify\s+(?:the\s+)?(\w+(?:[-\s]\w+){0,3}?\s+rate)\b/i,
];

// SPECTRUM — "rewrite hypothesis template to require conditional/spectrum framing".
// Per the 4/30 self-recommendation: 4 rejected hypotheses shared a binary
// "Position A vs Position B" pattern that forced false dichotomies. Detected
// here so the GoalEngine can register a structural rewrite of the template.
const SPECTRUM_PATTERNS = [
  /(?:rewrite|change|update|reframe)\s+(?:the\s+)?(\w+(?:\s+\w+){0,2})\s+template\s+(?:to\s+)?require[s]?\s+(?:conditional|spectrum|nuanced|continuous)/i,
  /(?:replace|swap)\s+(?:binary|dichotom\w+|adversarial)\s+\w*\s*(?:framing|format|structure)\s+with\s+(?:conditional|spectrum|nuanced|continuous)/i,
];

// REWRITE — generic structural-template change. Surfaces actions that
// commit to changing the *shape* of a downstream template/framing/goal
// without forcing a count or blocking a transition. Common shape:
//   "Reframe <subject> from '<old>' to '<new>'"
//   "Rewrite the <subject> to <new>"
//   "Replace <subject> with <new>"
// Must be checked AFTER the more-specific primitives (artifact/gate/
// spectrum) so we don't eat their canonical matches. Non-forcing — the
// rule ticks each cycle so the Self-Change Verifier can credit adoption.
const REWRITE_PATTERNS = [
  // "reframe content strategy growth focus from 'X' to 'Y'"
  /(?:reframe|rewrite|restructure|reword)\s+(?:the\s+)?([^.'"]+?)\s+from\s+['"]?([^'"]+?)['"]?\s+to\s+['"]([^'"]+)['"]/i,
  // "reframe X from A to B" — fallback without strict quoting
  /(?:reframe|rewrite|restructure|reword)\s+(?:the\s+)?([^.]+?)\s+from\s+([^.]+?)\s+to\s+([^.]+)/i,
  // "rewrite the X to Y" / "restructure the X to Y" — single-clause rewrite
  /(?:rewrite|restructure|reword)\s+(?:the\s+)?([^.]+?)\s+to\s+([^.]+)/i,
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

  // ARTIFACT — must come after the more-specific primitives so it doesn't
  // swallow ratio/ttl/gate/archive matches.
  for (const pat of ARTIFACT_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      const artifactNoun = normalizeNoun(m[1] ?? "artifact");
      // Pattern 1 captures examples in parens (e.g. "a briefing, a thread, a post");
      // Pattern 2 doesn't have that group.
      const examplesRaw = (pat === ARTIFACT_PATTERNS[0] ? m[2] : "") ?? "";
      const examples = examplesRaw
        .split(/[,;]|\bor\b/i)
        .map(s => s.trim())
        .filter(s => s.length > 0 && s.length < 50)
        .slice(0, 5);
      // Window: default 1 cycle if not captured.
      const windowCount = pat === ARTIFACT_PATTERNS[0] && m[3] ? parseInt(m[3], 10) : 1;
      const windowUnit = pat === ARTIFACT_PATTERNS[0] && m[4] ? m[4].toLowerCase().replace(/s$/, "") : "cycle";
      return {
        primitive: "artifact_rule",
        params: {
          artifactNoun,
          examples,
          windowCount,
          windowUnit,
          requiredCount: 1,
          competencyHint: inferCompetencyFromAction(a),
        },
        verificationCriterion: `at least 1 "${artifactNoun}" produced within ${windowCount} ${windowUnit}${windowCount === 1 ? "" : "s"}`,
        suggestedCategory: "craft",
        minFireCount: 1,
      };
    }
  }

  // VERIFICATION — observation-only. Must come AFTER the forcing primitives
  // so an action like "produce one artifact" isn't reclassified as a generic
  // "track artifact" measurement.
  for (const pat of VERIFICATION_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      const subjectRaw = (m[1] ?? "").trim();
      // Skip uselessly-short subjects ("rate", "X") so we don't fire on noise.
      if (!subjectRaw || subjectRaw.length < 3) continue;
      const subject = normalizeNoun(subjectRaw);
      const windowCount = m[2] ? parseInt(m[2], 10) : 1;
      const windowUnit = (m[3] ?? "cycle").toLowerCase().replace(/s$/, "");
      const target = inferVerificationTarget(a, insightText);
      return {
        primitive: "verification_rule",
        params: {
          subject,
          target,
          windowCount,
          windowUnit,
        },
        verificationCriterion: `observation-only: track "${subject}" on ${target} over ${windowCount} ${windowUnit}${windowCount === 1 ? "" : "s"}`,
        suggestedCategory: "identity",
        // Non-forcing rule — credit the commitment as soon as the metric is
        // observed at all, not after several deficits.
        minFireCount: 1,
      };
    }
  }

  // SPECTRUM — register as a gate_rule with a template-rewrite description, since
  // it's structurally a gate on hypothesis creation. Kept here for clarity.
  for (const pat of SPECTRUM_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      const targetTemplate = normalizeNoun(m[1] ?? "hypothesis");
      return {
        primitive: "gate_rule",
        params: {
          description: `reject ${targetTemplate} entries framed as binary "A vs B"; require conditional or spectrum framing`,
          target: targetTemplate.includes("hypothes") ? "hypothesis" : targetTemplate,
          framingMode: "spectrum",
        },
        verificationCriterion: `every new ${targetTemplate} passes the binary-framing check`,
        suggestedCategory: "identity",
        minFireCount: 3,
      };
    }
  }

  // REWRITE — structural template change. Non-forcing; the rule ticks each
  // cycle so the Self-Change Verifier can credit adoption when artifacts
  // produced under the new shape appear. Must come last so the more-specific
  // primitives (gate/artifact/spectrum) win when an action is forcing in
  // shape, not just structural.
  for (const pat of REWRITE_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      const subject = (m[1] ?? "").trim();
      // Skip uselessly-short subjects so we don't fire on noise like "rewrite X to Y".
      if (!subject || subject.length < 3) continue;
      const fromText = (m[2] ?? "").trim();
      const toText = (m[3] ?? m[2] ?? "").trim();
      const target = inferRewriteTarget(subject, insightText);
      return {
        primitive: "rewrite_rule",
        params: {
          subject: subject.slice(0, 200),
          target,
          structuralChange: toText.slice(0, 240),
          fromText: fromText.slice(0, 240),
        },
        verificationCriterion: `observation-only: detect "${target}" artifacts produced under the new template shape`,
        suggestedCategory: "identity",
        // Non-forcing — credit adoption as soon as one artifact under the new
        // shape is observed.
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

/**
 * Hint at which subsystem a verification rule should observe. Used for
 * non-forcing observation rules (e.g. "track firing rate of behavioral
 * rule X next cycle" → target = "behavioral_rule"). Falls back to "entity"
 * so a verification_rule never escapes the translator without a target.
 */
function inferVerificationTarget(action: string, insight: string): string {
  const t = `${action} ${insight}`.toLowerCase();
  if (/\bbehavioral?\s+rule\b/.test(t)) return "behavioral_rule";
  if (/\bhypothes/.test(t)) return "hypothesis";
  if (/\bgate\b/.test(t)) return "gate";
  if (/\bartifact|briefing|thread|post|synthes/.test(t)) return "artifact";
  if (/\bkb|knowledge\b/.test(t)) return "kb_entry";
  if (/\bgoal\b/.test(t)) return "goal";
  return "entity";
}

/**
 * Hint at which subsystem a rewrite_rule should observe. Mirrors
 * inferVerificationTarget but biased toward authoring surfaces (templates,
 * content strategy, goal phrasing) rather than measurement targets.
 */
function inferRewriteTarget(subject: string, insight: string): string {
  const t = `${subject} ${insight}`.toLowerCase();
  if (/\bcontent\s+strategy\b/.test(t)) return "content_strategy";
  if (/\bhypothes/.test(t)) return "hypothesis_template";
  if (/\bgoal/.test(t)) return "goal_template";
  if (/\bkb|knowledge\b/.test(t)) return "kb_template";
  if (/\bartifact|briefing|thread|post|narrative\b/.test(t)) return "artifact_template";
  return "template";
}

/**
 * Hint at which competency the artifact is intended to exercise. SelfEvolution
 * frequently names the target competency in the action text ("...exercises
 * Storytelling or Creativity..."); we surface it so the artifact_rule can
 * route the resulting goal into the right growth-focus area.
 */
function inferCompetencyFromAction(action: string): string | undefined {
  const t = action.toLowerCase();
  const known = [
    "storytelling",
    "creativity",
    "empathy",
    "content_strategy",
    "content strategy",
    "reasoning",
    "synthesis",
  ];
  for (const k of known) {
    if (t.includes(k)) return k.replace(/\s+/g, "_");
  }
  return undefined;
}

// -- Missing-primitive classification ----------------------------------------

export type MissingPrimitiveFamily =
  | "artifact"      // produce/ship/publish ONE thing
  | "ratio"         // for every N input, force one output
  | "ttl"           // expire/retire after N days
  | "gate"          // pre-X gate / require Y before Z
  | "archive"       // archive/retire matching items
  | "spectrum"      // rewrite binary framing to spectrum
  | "synthesis"     // synthesize/aggregate/cluster
  | "rewrite"       // rewrite template / structural change
  | "verification"  // measure/track/observe — not yet a primitive
  | "other";

/**
 * Classify an unparseable action into a coarse "missing primitive family".
 *
 * Used to compute a stable canonical dedupe key for missing-primitive
 * self-recommendations. Two cycles failing on related actions
 * ("produce one concrete artifact this cycle" vs "ship one synthesized
 * artifact next cycle") collapse into ONE row keyed by the artifact family,
 * instead of N rows keyed by the verbatim insight text.
 *
 * Pure: no DB, no LLM. Lowercases the action, scans for verb/keyword cues
 * in priority order, and picks the most-specific family. Returns "other"
 * when nothing is recognized — those still dedupe by family ("other"), so
 * a stream of unrelated unparseable actions collapses to ONE catch-all row
 * rather than an unbounded queue.
 */
export function classifyMissingPrimitiveFamily(actionText: string): MissingPrimitiveFamily {
  const a = (actionText || "").toLowerCase();
  if (!a.trim()) return "other";

  // Most-specific cues first. Ratio is checked BEFORE artifact because
  // "for every N new entries, generate one synthesis" matches both — the
  // ratio framing is the more informative classification.
  if (/\b(for\s+every|per|every)\s+\d+/.test(a) && /\b(produce|generate|ship|publish|create|force[-\s]?generate)\b/.test(a)) {
    return "ratio";
  }
  if (/\b(produce|ship|publish|deliver|write|draft|generate|create)\b.*\b(artifact|briefing|thread|post|synthes(?:is|ized?)|narrative|framework|draft)\b/.test(a)) {
    return "artifact";
  }
  if (/\bttl\b|\bexpir(?:e|y)\b|\bretire\b.*\bafter\b|\bcutoff\b/.test(a)) {
    return "ttl";
  }
  if (/\b(pre[-\s]?registration|pre[-\s]?check|gate|block)\b|\brequire[s]?\b.*\bbefore\b/.test(a)) {
    return "gate";
  }
  if (/\barchive\b|\bprune\b|\bdelete\b.*\b(stale|old|matching)\b/.test(a)) {
    return "archive";
  }
  if (/\b(binary|dichotom\w+|adversarial)\b|\b(spectrum|conditional|nuanced)\s+framing\b/.test(a)) {
    return "spectrum";
  }
  if (/\bsynthes(?:ize|is|ized?)\b|\bcluster\b|\baggregate\b|\bcompose\b/.test(a)) {
    return "synthesis";
  }
  if (/\brewrite\b|\breframe\b|\btemplate\b|\bstructure\b/.test(a)) {
    return "rewrite";
  }
  if (/\bmeasure\b|\btrack\b|\bobserv\w+\b|\bmonitor\b|\bquantif\w+\b/.test(a)) {
    return "verification";
  }
  return "other";
}

/**
 * Operator-readable description of what a missing-primitive family means.
 * Used in the proposedChange text so the rec doesn't dump verbatim insight
 * content into the field.
 */
export function describeMissingPrimitiveFamily(family: MissingPrimitiveFamily): string {
  switch (family) {
    case "artifact":     return "Add an `artifact` enforcement primitive (force ONE concrete output within N cycles).";
    case "ratio":        return "Add a `ratio` enforcement primitive (force one output per N inputs).";
    case "ttl":          return "Add a `ttl` enforcement primitive (expire items after N days without state change).";
    case "gate":         return "Add a `gate` enforcement primitive (block X until Y holds).";
    case "archive":      return "Add an `archive` enforcement primitive (retire items matching a pattern).";
    case "spectrum":     return "Add a `spectrum` rewrite primitive (reject binary framing in templates).";
    case "synthesis":    return "Add a `synthesis` enforcement primitive (force aggregation / cluster output).";
    case "rewrite":      return "Add a `rewrite` enforcement primitive (structural template change).";
    case "verification": return "Add a `verification` primitive (track/measure a state without a forcing rule).";
    case "other":        return "Action did not match any known primitive family — classify and add or sharpen the action.";
  }
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
