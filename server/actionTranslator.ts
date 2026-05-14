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
  // "before promoting/moving/transitioning any new hypothesis from X to Y, apply a <kind> gate: ..."
  // (added 2026-05-08: PR #282 added the 'forming→testing' data-source gate but
  // SelfEvolution kept emitting the closely-related binary-check rephrasing
  // — "...apply a binary-check gate: if it's structured as 'X is more accurate
  // than Y', rewrite as a threshold or conditional claim. Log compliance and
  // rejection rate." — which fell through to `none` because none of the
  // existing patterns matched the "...apply a ... gate" framing without an
  // explicit "implement/introduce/add" verb. Captures both the forming→testing
  // transition and the gate descriptor so downstream classification still
  // routes to gate_rule on a hypothesis target.)
  /before\s+(?:promoting|advancing|moving|transitioning)\s+(?:any\s+)?(?:new\s+)?([^\.,]+?)\s+from\s+['"]?\w+['"]?\s+to\s+['"]?\w+['"]?\s*,?\s*(?:apply|enforce|run|use)\s+(?:a\s+|an\s+|the\s+)?([^\.:]+?\s+gate)\b/i,
  // "apply a binary-check gate" / "apply the data-source gate" — front-loaded
  // gate verb. Works without the from→to clause for cases like "Apply a binary-
  // check gate before any forming→testing promotion."
  /(?:apply|enforce|run)\s+(?:a\s+|an\s+|the\s+)?(binary[-\s]?check|threshold[-\s]?check|conditional[-\s]?check|data[-\s]?source|spectrum[-\s]?check|measurement[-\s]?path)\s+gate\b/i,
  // (added 2026-05-13: parser-coverage fix for the 4 stale missing-primitive
  // recs the user reviewed after Phase 3b. SelfEvolution kept emitting three
  // gate-shaped insights that all fell through to `none`:
  //   (a) "Implement a mandatory evidence accessibility check: before moving
  //       any hypothesis from forming to testing, name the dataset/API/
  //       observable metric that would resolve it."
  //   (b) "Evidence accessibility check: name the dataset/API/observable
  //       metric for each hypothesis."
  //   (c) "Binary-check gate: before promoting any hypothesis from forming to
  //       testing, rewrite binary positional framing into a measurable
  //       single-variable claim."
  //   (d) "Before promoting any hypothesis from forming to testing, rewrite
  //       binary positional framing into a measurable single-variable claim."
  // (a)/(b) — "<accessibility|data-source|measurement-path|evidence>
  // check" framing. The earlier GATE patterns matched "<descriptor> gate" but
  // not "<descriptor> check"; "check" is an equally common SelfEvolution
  // phrasing for the same forcing pre-transition guardrail.
  // (added 2026-05-14: "evidence access check" — production after #367 still
  // emitted a missing-primitive rec for this exact wording from logs:
  //   "Add a mandatory 'evidence access check' before any hypothesis moves
  //    from forming to testing: explicitly name the data source, access
  //    method, and expected timeline."
  // #367 covered `evidence accessibility check` and bare `evidence check` but
  // not the three-word `evidence access check` shape. Same gate_rule
  // semantics — pre-transition guardrail naming the resolving evidence —
  // so widen the descriptor alternation rather than add a new primitive.)
  /\b(?:mandatory\s+)?((?:evidence\s+accessibility|evidence\s+access|accessibility|data[-\s]?source|measurement[-\s]?path|evidence)\s+check)\b/i,
  // (c) — leading "binary-check gate:" / "data-source gate:" preamble.
  // Existing pattern 0 required whitespace between "gate" and the
  // colon-or-keyword separator, so "Binary-check gate:" (no whitespace before
  // colon) fell through. This narrowly catches the leading-preamble shape.
  /^\s*(binary[-\s]?check|threshold[-\s]?check|spectrum[-\s]?check|conditional[-\s]?check|data[-\s]?source|measurement[-\s]?path)\s+gate\s*[:,]/i,
  // (d) — "before promoting … from A to B, rewrite/reject …" without the
  // "apply a … gate" framing. Pattern 5 required apply/enforce/run/use as
  // the action verb; SelfEvolution sometimes phrases the same forcing
  // rule directly as "rewrite binary X into measurable Y" or "reject A-vs-B
  // claims at the boundary". Treat as gate_rule on the transition target;
  // framingMode hint added downstream when the action mentions binary
  // positional framing.
  /before\s+(?:promoting|advancing|moving|transitioning)\s+(?:any\s+)?(?:new\s+)?([^\.,]+?)\s+from\s+['"]?\w+['"]?\s+to\s+['"]?\w+['"]?\s*,?\s*(?:rewrite|reject)\s+([^\.]+)/i,
];

const ARCHIVE_PATTERNS = [
  // (added 2026-05-13: parser-coverage fix for stale "missing-primitive: other"
  // rec — "Tag pure unanswered KB questions as speculative-queue and
  // review/archive if no evidence attaches within 7 days." The loose pattern
  // below matched but assigned junk groups (target="if"). This more-specific
  // shape captures the KB-question target, the "speculative-queue" tag, and
  // the staleness window so the archive_rule carries a usable criteria
  // string. Listed FIRST so it beats the loose pattern on the same input.
  //   m[1] = source noun ("KB"/"knowledge"/"knowledge-base"),
  //   m[2] = item noun (question/entry/item),
  //   m[3] = tag/queue label,
  //   m[4] = optional staleness day count.
  /\btag\s+(?:pure\s+)?(?:unanswered\s+)?(kb|knowledge|knowledge[-\s]?base)\s+(question|entry|item|questions|entries|items)s?\s+as\s+([a-z][-\w]*?)\s+and\s+(?:review|archive|prune|delete|remove)(?:[^.]*?within\s+(\d+)\s+days?)?/i,
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
  // Front-loaded cycle marker (added 2026-05-07 for live rec from content-strategy
  // cluster: "Next cycle: take one confirmed hypothesis from the content-strategy
  // cluster and produce a single narrative artifact (story-first format, named
  // example, verified detail) as a concrete exercise."
  // The previous patterns required the time-window phrase AFTER the artifact
  // noun. This one anchors on the leading "Next cycle:" / "This cycle:" / "Each
  // cycle:" preamble, then matches a downstream produce/ship/etc. verb against
  // a "single|one|a" artifact-shaped noun. Examples paren is optional.
  /^(?:next|this|each|every)\s+(\d+)?\s*(cycle|day|week|cycles|days|weeks)\b[^.]*?\b(?:produce|ship|publish|generate|create|deliver|write|draft)\s+(?:exactly\s+)?(?:one|1|a\s+single|a)\s+(?:concrete\s+)?(?:output\s+)?(\w+(?:\s+\w+){0,3}?)\s+(?:artifact|asset|output|deliverable|piece|exercise)?(?:\s*\(([^)]+)\))?/i,
  // (added 2026-05-13: parser-coverage fix for stale "missing-primitive:
  // artifact family" rec. SelfEvolution emitted "Force one concrete content
  // artifact (a post draft or thread outline) within 2 cycles." and the
  // closely-related "Force production of one post draft or thread outline
  // within 2 cycles." Both fell through every existing ARTIFACT pattern
  // because the verb "force" was not in the produce/ship/publish/... set.
  // The semantics are identical to the canonical artifact_rule case — one
  // concrete output within an N-cycle window — so we add a "force"-prefixed
  // shape rather than introducing a new primitive. Layout:
  //   m[1] = noun, m[2] = optional parenthetical examples, m[3] = count?,
  //   m[4] = unit. Mirrors ARTIFACT_PATTERNS[0] downstream consumption.
  /\bforce\s+(?:production\s+of\s+)?(?:exactly\s+)?(?:one|1|a\s+single)\s+(?:concrete\s+)?(?:output\s+)?(\w+(?:\s+\w+){0,4})(?:\s*\(([^)]+)\))?[^.]*?\b(?:within|in|by|each|this|next|every|per)\s+(?:the\s+)?(?:next\s+)?(\d+)?\s*(cycle|day|week|cycles|days|weeks)\b/i,
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

// VERIFICATION_SCAFFOLD — observation-only primitive for externally-facing
// outputs. Surfaced 2026-05-07 from the Verification Debt dream insight and
// the semantic-retrieval fidelity hypothesis: outputs that ship publicly
// without (1) a primary source link, (2) a confidence band, and (3) one
// falsification condition cannot be audited by readers or by the
// Self-Change Verifier. This routes the action to a `verification_rule`
// with subtype="scaffold", carrying the three required fields. It is
// non-forcing: it does not block publishing, it does not auto-attach
// fields, it does not modify any output surface. It only registers the
// observation so the operator can wire attachment where a common output
// contract already exists.
const VERIFICATION_SCAFFOLD_PATTERNS = [
  // "include verification scaffold: (1) primary source link, (2) confidence band, (3) one falsification condition"
  /\b(?:include|attach|require|add)\s+(?:a\s+)?verification\s+scaffold\b/i,
  // "for every externally-facing output, include (...primary source link...confidence...falsification...)"
  /\bexternally[-\s]?facing\s+output[s]?\b[^.]*?\bfalsif\w+/i,
  // Loose trio match: any action mentioning all three components together
  /\bprimary\s+source\b[^.]*?\bconfidence\b[^.]*?\bfalsif\w+/i,
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
      const target = inferGateTarget(a);
      // Binary-check / spectrum-check gates carry the framingMode hint so
      // downstream consumers (action enforcer, AgentHQ) treat them like the
      // SPECTRUM_PATTERNS branch. Surface from any gate-descriptor capture
      // group as well as from the raw action text.
      const lowered = a.toLowerCase();
      const params: Record<string, unknown> = { description, target };
      if (
        /\bbinary[-\s]?check|\bspectrum[-\s]?check\b/.test(lowered) ||
        /\brewrite\s+binary\b/.test(lowered) ||
        /\bbinary\s+positional\s+framing\b/.test(lowered)
      ) {
        params.framingMode = "spectrum";
      }
      return {
        primitive: "gate_rule",
        params,
        verificationCriterion: `gate fires on each ${target} entering the guarded state`,
        suggestedCategory: "identity",
        minFireCount: 3,
      };
    }
  }

  // ARCHIVE
  for (const pat of ARCHIVE_PATTERNS) {
    const m = a.match(pat);
    if (m) {
      // Specific KB-question speculative-queue pattern (index 0) carries
      // its own group layout: source/item/tag/staleness-days. Map it to
      // the same archive_rule params so downstream consumers don't change.
      if (pat === ARCHIVE_PATTERNS[0]) {
        const source = normalizeNoun(m[1] ?? "kb");
        const item = normalizeNoun(m[2] ?? "question");
        const tag = (m[3] ?? "").trim();
        const staleDays = m[4] ? parseInt(m[4], 10) : undefined;
        const target = `${source}_${item}`;
        const criteriaParts: string[] = [];
        if (tag) criteriaParts.push(`tag=${tag}`);
        if (staleDays !== undefined) criteriaParts.push(`no evidence within ${staleDays}d`);
        const criteria = criteriaParts.join("; ").slice(0, 200);
        return {
          primitive: "archive_rule",
          params: { target, criteria, staleDays },
          verificationCriterion: `${target} items tagged "${tag}" with no evidence within ${staleDays ?? "N"}d are archived`,
          suggestedCategory: "knowledge",
          minFireCount: 1,
        };
      }
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
      // Group layout differs per pattern:
      //   P0 (post-window): m[1]=noun, m[2]=examples?, m[3]=count?, m[4]=unit?
      //   P1 (dedicate):    m[1]=noun
      //   P2 (front-loaded): m[1]=count?, m[2]=unit, m[3]=noun, m[4]=examples?
      //   P3 (force):       m[1]=noun, m[2]=examples?, m[3]=count?, m[4]=unit?
      const isFrontLoaded = pat === ARTIFACT_PATTERNS[2];
      const isForce = pat === ARTIFACT_PATTERNS[3];
      const nounGroup    = isFrontLoaded ? (m[3] ?? "artifact") : (m[1] ?? "artifact");
      const examplesRaw  = (pat === ARTIFACT_PATTERNS[0] || isForce
        ? (m[2] ?? "")
        : isFrontLoaded ? (m[4] ?? "") : "") ?? "";
      const artifactNoun = normalizeNoun(nounGroup);
      const examples = examplesRaw
        .split(/[,;]|\bor\b/i)
        .map(s => s.trim())
        .filter(s => s.length > 0 && s.length < 50)
        .slice(0, 5);
      // Window: default 1 cycle if not captured.
      let windowCount = 1;
      let windowUnit = "cycle";
      if (pat === ARTIFACT_PATTERNS[0] || isForce) {
        if (m[3]) windowCount = parseInt(m[3], 10);
        if (m[4]) windowUnit = m[4].toLowerCase().replace(/s$/, "");
      } else if (isFrontLoaded) {
        if (m[1]) windowCount = parseInt(m[1], 10);
        if (m[2]) windowUnit = m[2].toLowerCase().replace(/s$/, "");
      }
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

  // VERIFICATION_SCAFFOLD — externally-facing output trio (source link +
  // confidence band + falsification condition). Routed as verification_rule
  // with subtype="scaffold" so the existing rule lifecycle/verification
  // applies unchanged. Observation-only — no auto-publish, no surface
  // modification, no claim-verifier threshold change.
  for (const pat of VERIFICATION_SCAFFOLD_PATTERNS) {
    if (!pat.test(a)) continue;
    return {
      primitive: "verification_rule",
      params: {
        subject: "verification_scaffold",
        target: "externally_facing_output",
        subtype: "scaffold",
        requiredFields: ["primary_source_link", "confidence_band", "falsification_condition"],
        windowCount: 1,
        windowUnit: "cycle",
        autoAttach: false,
        autoPublish: false,
      },
      verificationCriterion:
        `observation-only: detect each externally-facing output that includes all three scaffold fields ` +
        `(primary_source_link, confidence_band, falsification_condition); no auto-attach, no auto-publish`,
      suggestedCategory: "identity",
      minFireCount: 1,
    };
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
  | "artifact"             // produce/ship/publish ONE thing
  | "ratio"                // for every N input, force one output
  | "ttl"                  // expire/retire after N days
  | "gate"                 // pre-X gate / require Y before Z
  | "archive"              // archive/retire matching items
  | "spectrum"             // rewrite binary framing to spectrum
  | "synthesis"            // synthesize/aggregate/cluster
  | "rewrite"              // rewrite template / structural change
  | "verification"         // measure/track/observe — not yet a primitive
  | "verification_scaffold" // attach (source link, confidence band, falsification) to externally-facing outputs
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
  // Gate cues: explicit gate/block keywords, "require X before Y", or the
  // newer "<accessibility|data-source|measurement-path|evidence> check"
  // framing (the 5/13 parser-coverage fix). The check-cue requires a
  // qualifier so plain "check" alone doesn't fire on noise.
  if (
    /\b(pre[-\s]?registration|pre[-\s]?check|gate|block)\b|\brequire[s]?\b.*\bbefore\b/.test(a) ||
    /\b(evidence\s+accessibility|evidence\s+access|accessibility|data[-\s]?source|measurement[-\s]?path|evidence)\s+check\b/.test(a)
  ) {
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
  // verification_scaffold — externally-facing outputs need a (source link,
  // confidence band, falsification condition) trio. Surfaced 2026-05-07
  // from the Verification Debt dream insight + semantic-retrieval fidelity
  // hypothesis: outputs that ship publicly without these three fields can't
  // be audited by the Self-Change Verifier or by readers. Must be checked
  // BEFORE generic "verification" because the cues overlap (the trio
  // language explicitly *includes* "verification scaffold" / "falsification
  // condition" / "primary source"). Classification only — the runtime
  // attachment is handled where the externally-facing surface already has a
  // common contract; we do NOT auto-publish or modify the surface here.
  if (
    /\bverification\s+scaffold\b/.test(a) ||
    /\bfalsification\s+condition\b/.test(a) ||
    (/\bprimary\s+source\b/.test(a) && /\bconfidence\b/.test(a)) ||
    (/\bsource\s+link\b/.test(a) && /\bfalsif\w+\b/.test(a))
  ) {
    return "verification_scaffold";
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
    case "verification_scaffold": return "Add a `verification_scaffold` primitive (attach primary source link + confidence band + falsification condition to externally-facing outputs; observation-only, no auto-publish).";
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
