// ─────────────────────────────────────────────────────────────────────────────
// PR-I — Artifact-mode helpers for the claim verifier.
//
// The verifier's two-lane standard (server/claimVerifier.ts) was built for
// faithful summary / news-report content where every sentence is either
// (a) a source-attribution claim or (b) a bare external fact requiring
// citation. Deep Read output is opinion-piece-shaped — the agent has a
// voice — so applying the same rules produces false positives on author
// voice, forward projections, section headers, and opener hooks.
//
// This module encodes the ANALYSIS-mode exemption rules as small focused
// helpers with EXPLICIT trigger lists (no regex spaghetti). Each trigger
// in each list is pinned by a regression test in
// server/__tests__/artifactModeVerification.test.ts.
//
// Three modes:
//   - REPORT (default, preserves current behavior): no exemptions.
//   - ANALYSIS (Deep Read, opinion pieces): exempt author voice, forward
//     projections, section headers, opener hooks. Strictness on
//     fabricated quotes, direct attribution verbs, and verbatim source
//     support is unchanged.
//   - MANUSCRIPT (strictest): no exemptions, no opinion exception. Same
//     as REPORT today + always skips standalone section headers.
//
// Hard rules:
//   - Section headers are skipped in ALL modes (including REPORT and
//     unset/default). Current behavior treats `## Heading` as content; that
//     is the bug behind sentences 35 and 78 in the spec. Skipping headers
//     is independent of mode.
//   - ANALYSIS does not relax fabrication detection. The verifier's
//     deterministic quote check (claimVerifier.ts:494-528) and the LLM
//     judge path are reached AFTER mode branching for sentences that
//     are NOT exempted.
//   - "Attribution-by-link" (sentences 69 and 75 in the spec) is the
//     intentional exception: in ANALYSIS, a sentence with an inline
//     source link AND a quantitative/editorial assertion AND no
//     attribution verb AND no source support is STILL flagged. This is
//     the writer's job to fix.
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeForMatching } from "./textNormalization.js";

export type ArtifactMode = "ANALYSIS" | "REPORT" | "MANUSCRIPT";

/** Default mode when the writer doesn't set one. Today's verifier
 *  behavior matches REPORT (current Lane A / Lane B rules apply
 *  uniformly; no author-voice exemption). The audit for PR-I confirmed
 *  this — see PR body. */
export const DEFAULT_ARTIFACT_MODE: ArtifactMode = "REPORT";

export function resolveArtifactMode(input: ArtifactMode | undefined | null): ArtifactMode {
  if (input === "ANALYSIS" || input === "REPORT" || input === "MANUSCRIPT") return input;
  return DEFAULT_ARTIFACT_MODE;
}

// ── Trigger lists (each entry is pinned by a regression test) ───────────────

/** Attribution verbs / phrases — sentences containing one of these in
 *  ANALYSIS mode are eligible for Lane A classification (and the
 *  source-text check). Sentences NOT containing one of these are NOT
 *  treated as attribution claims in ANALYSIS, even if they contain a
 *  domain match or an inline source link.
 *
 *  This is intentionally narrower than claimVerifier.ts:ATTRIBUTION_RX,
 *  which also fires on bare "the article / the report" phrases that are
 *  often part of the agent's analytical setup. ANALYSIS uses a small
 *  list of UNAMBIGUOUS attribution constructions. */
export const ATTRIBUTION_VERBS_ANALYSIS = [
  "wrote", "writes",
  "said", "says",
  "stated", "states",
  "argues", "argued",
  "claims", "claimed",
  "reports", "reported",
  "noted", "notes",
  "according to",
  "per the document",
  "per the principles",
  "per the article",
  "per the report",
  "the document states",
  "the document says",
  "the article states",
  "the article says",
  "the report states",
  "the report says",
  "it states plainly",
  "it explicitly calls",
  "explicitly calls",
  "altman writes",
  "altman wrote",
  "altman says",
  "altman said",
  "openai says",
  "openai writes",
];

/** Forward-projection markers — sentences containing one of these are
 *  treated as the agent's projection in ANALYSIS, NOT as external facts.
 *  Each of these is pinned by a forward-projection-exemption test. */
export const FORWARD_PROJECTION_MARKERS = [
  "by 2027",
  "by 2028",
  "by 2029",
  "by 2030",
  "by 2031",
  "by 2032",
  "by 2033",
  "by 2034",
  "by 2035",
  "by 2040",
  "by 2050",
  "by 2060",
  "in five years",
  "in ten years",
  "in fifteen years",
  "in twenty years",
  "in the next decade",
  "looking ahead",
  "we should see",
  "we will see",
  "the question becomes",
  "the decisive question becomes",
];

/** Author-voice constructions — sentences containing one of these are
 *  treated as the agent's voice in ANALYSIS. Includes hedging modals
 *  immediately after first-person, framing phrases, and agent
 *  self-reference.
 *
 *  PR-I.1 additions: forward-projection author-summary framings
 *  ("the pattern is clear", "the trajectory is clear", …). These are
 *  appended below the PR-I seed list — additive only, no edits to
 *  existing entries. */
export const AUTHOR_VOICE_PATTERNS = [
  // ── PR-I (seed) ─────────────────────────────────────────────────────
  "what i think",
  "i think",
  "i read this",
  "i read it",
  "my read is",
  "my take is",
  "as an autonomous ai",
  "as an autonomous research agent",
  "as an autonomous ai research agent",
  "agent 306 lens",
  "the decisive question",
  "the real signal",
  "read between the lines",
  "the headline outcome",
  "the bigger picture",
  "what this means for",
  // ── PR-I.1 — forward-projection author-summary framings ─────────────
  "the pattern is clear",
  "the trajectory is clear",
  "the throughline is",
  "what emerges is",
  "the takeaway is",
  "the upshot is",
  "the throughline here",
  "what this adds up to",
  // ── 2026-05-04 — lane-contract boundary phrases ─────────────────────
  // The shared claim-lane contract (server/claimLaneContract.ts) pushes
  // the writer to mark Lane B agent commentary with explicit boundary
  // phrases so a reader (and the verifier) cannot mistake analysis for
  // source attribution. These phrases are recognized as author voice in
  // ANALYSIS mode so when the writer obeys the contract on engines like
  // News / The Dispatch, the analytical sentences get exempted before
  // the Lane A gate fires. Additive only — every PR-I / PR-I.1 entry
  // above is preserved.
  "my read —",
  "my read,",
  "my read:",
  "agent 306's read",
  "agent 306's analysis",
  "agent 306's caveat",
  "agent 306's take",
  "the open question is",
];

/** Markdown section-header detector. A line that begins (after any
 *  leading whitespace) with `#`, `##`, `###`, etc., followed by a space
 *  and content, is a header.
 *
 *  We use the FIRST 64 characters of the snippet to decide so that the
 *  splitSentences-merged "## Heading sentence text" lines (the verifier
 *  collapses newlines) still classify as headers. Specifically: if the
 *  snippet begins with `## ` followed by a Title-Case label and then
 *  contains the rest of a paragraph, treat ONLY the leading header
 *  portion as a header for skipping purposes — the remaining sentence
 *  content is still classified normally. */
export function isMarkdownHeaderSentence(s: string): boolean {
  // Strict standalone header: e.g. "## Opening Hook" with no trailing prose.
  // After splitSentences flattens newlines, a real heading typically reads
  // as "## Opening Hook On April 26, …" — the heading label runs into the
  // following paragraph. Detect the standalone-header shape (heading label
  // only) by length + ## prefix.
  const trimmed = s.trim();
  if (!/^#{1,6}\s+\S/.test(trimmed)) return false;
  // Standalone header: short, no terminal sentence punctuation.
  const woHeading = trimmed.replace(/^#{1,6}\s+/, "");
  // Consider it a standalone header when it's <= 6 words AND has no
  // terminal punctuation. The merged-into-paragraph form ("## Heading
  // First sentence of paragraph.") is NOT a standalone header — see
  // stripLeadingHeader below for that case.
  if (woHeading.split(/\s+/).length <= 6 && !/[.!?]$/.test(trimmed)) return true;
  return false;
}

/** Strip a leading `## Heading` from a flattened sentence so the
 *  remaining content can be classified independently. Returns the
 *  sentence body without the leading header label, or the original
 *  sentence if no leading header is present.
 *
 *  Heuristic: a leading header is `## ` (or `###`/`#`/etc.) followed by
 *  a sequence of Title-Case words (each starting with a capital and
 *  containing only letters / digits / `-`/`'`), then a space, then a
 *  capital that begins the actual sentence body. The greedy match
 *  consumes as many Title-Case header tokens as possible so headings
 *  longer than 6 words still get stripped before the body starts. */
export function stripLeadingMarkdownHeader(s: string): { body: string; hadHeader: boolean } {
  // Match: "## " (or ###/#) + 1-8 Title-Case tokens + space + "[A-Z]" body start.
  const m = s.match(/^(#{1,6}\s+)(?:[A-Z][A-Za-z0-9'’\-]*\s+){1,8}(?=[A-Z][a-z])/);
  if (!m) return { body: s, hadHeader: false };
  return { body: s.slice(m[0].length), hadHeader: true };
}

/** True if `s` contains any of the forward-projection markers. Case-
 *  insensitive substring match. Each marker is a phrase, not a regex,
 *  so the trigger list is auditable. */
export function hasForwardProjection(s: string): boolean {
  const lower = s.toLowerCase();
  return FORWARD_PROJECTION_MARKERS.some(m => lower.includes(m));
}

/** True if `s` contains any author-voice pattern. */
export function hasAuthorVoice(s: string): boolean {
  const lower = s.toLowerCase();
  return AUTHOR_VOICE_PATTERNS.some(m => lower.includes(m));
}

// ── PR-I.1 — closing rhetoric tied to source host ──────────────────────────
//
// Agent 306's closing voice sometimes names the source venue:
//   "These principles sound good on openai.com but lack teeth."
//   "It reads well on theatlantic.com — less so anywhere else."
// PR-E plumbed the source URL through verifyClaims; we use the URL's host
// (NOT a hardcoded list) to recognize this construction. The check:
//   1. Compute host = URL(sourceUrl).hostname, strip leading "www.".
//   2. Match `[verb phrase] on <host>` (case-insensitive) where verb phrase
//      is one of the small explicit list below.
// If the sentence references a DIFFERENT host, this returns false — the
// closing rhetoric is tied to the source venue, not generic.

const CLOSING_RHETORIC_VERB_PHRASES = [
  "sound good on",
  "sounds good on",
  "read well on",
  "reads well on",
  "play in",
  "plays in",
  "land well on",
  "lands well on",
  "look good on",
  "looks good on",
];

function sourceHostFromUrl(sourceUrl?: string): string {
  if (!sourceUrl) return "";
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

// ── PR-I.1 — title + opener composite ──────────────────────────────────────
//
// PR-I gated the source-referent exemption on the presence of an inline
// source link (artifactMode.ts L387: `hasInlineSourceLink(s) && …`). The
// post-PR-I Deep Read flagged opener sentences that DON'T have an inline
// link but DO start with a source-referent prefix and continue with
// author commentary ("The piece opens with a deceptively simple frame: …",
// "The article opens by laying out three commitments before naming any of
// them."). PR-I.1 adds a separate path that exempts these as author voice
// even without an inline link.
//
// The detection is conservative: require either
//   (a) a quoted/italicized span at the very start of the sentence, OR
//   (b) a source-referent subject prefix from SOURCE_REFERENT_SUBJECT_PREFIXES
//       followed by author commentary.
// Today (b) is sufficient on its own — the prefix list is small and
// curated, so any sentence whose subject starts with one of these prefixes
// is the agent framing the source rather than asserting an external fact.

const TITLE_OPENER_QUOTE_RX =
  /^(?:#{1,6}\s+(?:[A-Z][A-Za-z0-9'’\-]*\s+){0,8})?\s*[“"][^”"\n]{2,}["”]/;

/** True when `s` is a title + opener composite — either it opens with a
 *  quoted title or it begins with a source-referent prefix. PR-I.1
 *  exemption path. */
export function isTitleOpenerComposite(s: string): boolean {
  if (TITLE_OPENER_QUOTE_RX.test(s)) return true;
  return startsWithSourceReferentSubject(s);
}

/** True when `s` contains a closing-rhetoric "[verb phrase] on <host>"
 *  construction tied to the source URL's host. Returns false if the
 *  sentence's host doesn't match the source host, or if no source URL
 *  is provided. */
export function hasClosingRhetoricOnSourceHost(s: string, sourceUrl?: string): boolean {
  const host = sourceHostFromUrl(sourceUrl);
  if (!host) return false;
  const lower = s.toLowerCase();
  if (!lower.includes(host)) return false;
  return CLOSING_RHETORIC_VERB_PHRASES.some(p => {
    const probe = `${p} ${host}`;
    return lower.includes(probe);
  });
}

/** True if `s` contains any of the ANALYSIS-mode attribution verbs. */
export function hasAttributionVerbAnalysis(s: string): boolean {
  const lower = s.toLowerCase();
  return ATTRIBUTION_VERBS_ANALYSIS.some(v => lower.includes(v));
}

/** Markdown inline link presence. Mirror of claimVerifier.ts:MD_LINK_RX. */
export function hasInlineSourceLink(s: string): boolean {
  return /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(s);
}

/** Quantitative or editorial assertion that we use to draw the line
 *  between "context-link with author projection" (allowed in ANALYSIS)
 *  and "attribution-by-link with unsupported claim" (still flagged in
 *  ANALYSIS). The concrete rule:
 *
 *    A sentence that has an inline source link AND no attribution verb
 *    AND a quantitative-or-editorial assertion AND no source support
 *    SHOULD still flag in ANALYSIS — this is the writer's job to
 *    rephrase as her own projection.
 *
 *  Quantitative markers: percentages, dates, dollar amounts, multipliers,
 *  named units, AND specific phrases like "order of magnitude" /
 *  "fold reduction" / "double" that read as quantitative claims.
 *
 *  Editorial assertions: short copular declarative phrases that read as
 *  "is real / is true / is a first / is the" with the inline link
 *  attached. We keep this list small and explicit — the bar for
 *  flagging in ANALYSIS is "writer used a link as attribution, not
 *  context." */
const QUANTITATIVE_PHRASES = [
  "order of magnitude",
  "fold reduction",
  "fold improvement",
  "fold increase",
  "doubled",
  "tripled",
  "halved",
  "another order",
];

const EDITORIAL_ASSERTION_PHRASES = [
  "is real",
  "is true",
  "is the first time",
  "is a first",
  "is the case",
  "is the truth",
  "is the strongest",
  "is the weakest",
];

const NUMERIC_RX =
  /(\d{1,3}(?:[.,]\d+)?\s*%|\$\s*\d+(?:[.,]\d+)?|\b\d+(?:\.\d+)?[xX]\b)/i;

/** Subjects that, when they appear AS THE SENTENCE SUBJECT (start of
 *  sentence, or right after a leading "## Heading "), indicate the
 *  sentence is framing the SOURCE itself (e.g. "OpenAI has published…",
 *  "The document treats X as Y", "The principles invoke …"). Such
 *  sentences are context-frames about the source, not
 *  attribution-by-link. The match is anchored at sentence start so
 *  sentences that merely mention "the document" or "the article"
 *  somewhere inside ("the uncertainty the document embraces is real")
 *  are NOT exempted — those still flag as attribution-by-link if they
 *  carry a source link + editorial assertion. */
// Exported for PR-I.1 audit / regression tests (no list changes — existing
// shorter prefixes like "the article " already cover the opener/closer
// variants such as "The article opens by …" via startsWith semantics).
export const SOURCE_REFERENT_SUBJECT_PREFIXES = [
  "the document ",
  "the article ",
  "the report ",
  "the piece ",
  "the principles ",
  "the post ",
  "the essay ",
  "the statement ",
  "openai has ",
  "openai's ",
  "altman's ",
  "altman has ",
  "this is the first time openai ",
  "this is the first time the ",
];

/** Predicate for the attribution-by-link line. Returns true when the
 *  sentence reads like an attribution-via-link — i.e. it carries the
 *  inline link AND the writer has NOT used an explicit attribution
 *  verb AND has packed in a quantitative or editorial assertion AND
 *  the assertion is NOT framing the source itself.
 *
 *  Concrete rule (the line called out in the spec):
 *
 *    context-link + author projection (no quantitative/editorial assertion
 *      OR assertion is about the source itself) = allowed in ANALYSIS
 *    context-link + quantitative/editorial assertion not in source AND
 *      not about the source itself                = flagged in ANALYSIS
 *
 *  Spec sentences 69 / 75 hit the second branch; sentence 35 is the
 *  first branch ("this is the first time OpenAI has published…" — the
 *  subject IS OpenAI / the source). */
export function looksLikeAttributionByLink(s: string): boolean {
  if (!hasInlineSourceLink(s)) return false;
  if (hasAttributionVerbAnalysis(s)) return false; // explicit attribution → Lane A path
  // Source-referent framing exempts the sentence from attribution-by-link.
  // The agent is talking ABOUT the source, not making a claim and
  // attributing it to the source. Match is anchored at the sentence
  // SUBJECT (after any leading "## Heading " is stripped) so sentences
  // that merely mention the source somewhere inside still flag.
  if (startsWithSourceReferentSubject(s)) return false;
  const lower = s.toLowerCase();
  if (QUANTITATIVE_PHRASES.some(p => lower.includes(p))) return true;
  if (NUMERIC_RX.test(s)) return true;
  if (EDITORIAL_ASSERTION_PHRASES.some(p => lower.includes(p))) return true;
  return false;
}

/** Check whether a sentence is in the first paragraph of `draftText`.
 *  Used by the opener-hook tolerance rule. */
export function isInFirstParagraph(sentence: string, draftText: string): boolean {
  const firstPara = draftText.split(/\n\s*\n/, 1)[0] ?? "";
  return firstPara.includes(sentence.trim().slice(0, Math.min(40, sentence.length)));
}

/** Opener-hook detector — a sentence in the first paragraph that contains
 *  a date or named entity AND has a citation in the same paragraph. */
export function isOpenerHook(sentence: string, draftText: string): boolean {
  if (!isInFirstParagraph(sentence, draftText)) return false;
  // Has a date OR a named entity (capitalized multi-word phrase).
  const hasDate = /\b(?:19|20)\d{2}\b/.test(sentence) ||
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(sentence);
  const hasNamedEntity = /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(sentence); // "Sam Altman", "OpenAI Inc"
  if (!hasDate && !hasNamedEntity) return false;
  const firstPara = draftText.split(/\n\s*\n/, 1)[0] ?? "";
  return /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(firstPara);
}

// ── PR-K — Critique-by-absence pattern recognition ─────────────────────────
//
// In ANALYSIS mode, Agent 306 writes meta-claims about the source's
// omissions ("The article does not specify …", "It does not address …",
// "The piece never names …"). Today the verifier treats these as content
// claims, looks for support in the source, and (by construction) finds
// none — flagging LANE_A_FAIL.
//
// PR-K detects the pattern (source-referent subject + negated discussion
// verb) and exempts as critique-by-absence. The detection requires BOTH
// signals — a source-referent subject ALONE or a negated verb ALONE is
// insufficient. The discussion-verb list is curated; verbs like "work",
// "improve", "exist", "function", "succeed", "deliver" are NOT discussion
// verbs and must not be added — they would turn content claims into
// exemptions.
//
// Each curated phrase below is pinned by a regression test in
// server/__tests__/artifactMode.critiqueByAbsence.test.ts and
// server/__tests__/claimVerifier.critiqueByAbsence.test.ts.

/** Negated discussion-verb phrases. Lowercase, after PR-H normalization.
 *  Curated and small. The exemption only fires when one of these phrases
 *  matches the predicate AND the subject is source-referent. */
export const CRITIQUE_BY_ABSENCE_VERB_PHRASES = [
  // does not + discussion verb
  "does not specify",
  "does not address",
  "does not define",
  "does not mention",
  "does not discuss",
  "does not explain",
  "does not name",
  "does not list",
  "does not say",
  "does not state",
  "does not clarify",
  "does not articulate",
  // fails to + discussion verb
  "fails to specify",
  "fails to address",
  "fails to define",
  "fails to mention",
  "fails to discuss",
  "fails to explain",
  "fails to name",
  "fails to list",
  // never + discussion verb
  "never specifies",
  "never addresses",
  "never defines",
  "never mentions",
  "never discusses",
  "never explains",
  "never names",
  "never lists",
];

/** True if `s` contains any of the negated discussion-verb phrases. */
function hasNegatedDiscussionVerb(s: string): boolean {
  const lower = normalizeForMatching(s, { caseFold: true });
  return CRITIQUE_BY_ABSENCE_VERB_PHRASES.some(p => lower.includes(p));
}

/** True if `s` opens with a conservative source-referent subject suitable
 *  for the critique-by-absence path. Two cases:
 *   (a) `startsWithSourceReferentSubject(s)` — covers "The article ",
 *       "The document ", "The piece ", "The report ", "The principles ",
 *       "The post ", "The essay ", "The statement ", etc.
 *   (b) "It " or "The source " openers — accepted ONLY as part of the
 *       conjunction with `hasNegatedDiscussionVerb`. The verb requirement
 *       guards against content-claim "It" sentences ("It does not work").
 *
 *  Cross-sentence pronoun resolution (sentence-pair tracking) is OUT of
 *  scope for this PR — the conservative "It + discussion verb" pattern
 *  handles the S64 case without it. */
function hasCritiqueByAbsenceSubject(s: string): boolean {
  if (startsWithSourceReferentSubject(s)) return true;
  const { body } = stripLeadingMarkdownHeader(s);
  const trimmed = body.trim();
  // "It " opener — conservative; the discussion-verb requirement (checked
  // by the caller) carries the weight of disambiguation.
  if (/^It\s+/.test(trimmed)) return true;
  // "The source " opener — "the source does not specify …".
  if (/^[Tt]he source\s+/.test(trimmed)) return true;
  return false;
}

/** True when `s` is a critique-by-absence sentence — i.e. the source-
 *  referent subject points out an omission via a negated discussion verb.
 *  The conjunction is REQUIRED: both subject and verb conditions must hold.
 *
 *  Examples (true):
 *    - "The article does not specify how alignment will be measured."
 *    - "It does not address the question of accountability."
 *    - "The piece never names the labs it considers comparable."
 *    - "The source fails to define what 'serious alignment' means."
 *
 *  Examples (false — content claims, must still flag):
 *    - "The medication does not work for chronic pain patients."  ← "work"
 *      not in verb list
 *    - "The model does not improve on prior baselines."           ← "improve"
 *      not in verb list
 *    - "It does not exist in the wild."                           ← "exist"
 *      not in verb list
 *    - "GPT-4 does not function in low-resource languages."       ← subject
 *      not source-referent AND "function" not in verb list */
export function isCritiqueByAbsence(s: string): boolean {
  if (!s) return false;
  if (!hasNegatedDiscussionVerb(s)) return false;
  if (!hasCritiqueByAbsenceSubject(s)) return false;
  return true;
}

// ── ANALYSIS exemption decision ─────────────────────────────────────────────

export interface ExemptionResult {
  exempt: boolean;
  /** Reason category. Used for telemetry counters. */
  category:
    | "authorVoice"
    | "forwardProjection"
    | "sectionHeader"
    | "openerHook"
    | "critiqueByAbsence"
    | null;
}

/** Decide whether `s` is exempt from Lane A / Lane B classification under
 *  ANALYSIS rules. Order of checks matters because some sentences hit
 *  multiple categories (e.g. forward-projection inside a paragraph that
 *  has a citation). We attribute the exemption to the FIRST matching
 *  category for telemetry stability.
 *
 *  PR-I.1: optional `sourceUrl` plumbed in so the closing-rhetoric
 *  exemption ("[verb phrase] on <host>") can tie to the source host
 *  rather than relying on a hardcoded venue list. Backwards-compatible —
 *  callers that don't pass sourceUrl simply skip the closing-rhetoric
 *  branch. */
export function analysisExemption(
  sentence: string,
  draftText: string,
  sourceText?: string,
  sourceUrl?: string,
): ExemptionResult {
  if (isMarkdownHeaderSentence(sentence)) return { exempt: true, category: "sectionHeader" };
  // attribution-by-link is NOT an exemption — it's a separate flagging
  // path handled by the caller. We only short-circuit on it here so a
  // sentence with both attribution-by-link + author-voice still flags.
  if (looksLikeAttributionByLink(sentence)) return { exempt: false, category: null };
  if (hasForwardProjection(sentence)) return { exempt: true, category: "forwardProjection" };
  if (hasAuthorVoice(sentence))       return { exempt: true, category: "authorVoice" };
  // PR-I.1 — closing rhetoric tied to source host. Categorized as
  // authorVoice for telemetry (it's the agent's closing framing language).
  if (hasClosingRhetoricOnSourceHost(sentence, sourceUrl)) {
    return { exempt: true, category: "authorVoice" };
  }
  // PR-I.1 — title + opener composite. A sentence whose subject is the
  // article itself ("The piece opens …", "The article opens by …") is the
  // agent framing the source, not asserting an external fact. Section 1's
  // verbatim-quote check still runs independently, so fabricated quoted
  // spans inside such sentences continue to flag LANE_A_FAIL.
  //
  // Carve-outs (the exemption is conservative):
  //   1. If the sentence carries quoted spans, defer to PR-J's
  //      quote+commentary path (LANE_A_PASS_QUOTED_COMMENTARY when every
  //      span verifies, LANE_A_FAIL when any span is fabricated).
  //   2. If the sentence carries an explicit ANALYSIS attribution verb
  //      ("reports", "claims", "states", …) it's an attributed claim, not
  //      a framing-of-the-source — leave it to Lane A so the source check
  //      runs.
  // PR-K — critique-by-absence: sentences pointing out what the source
  // OMITS or FAILS to address. Meta-claims about source coverage, not
  // content claims. Checked BEFORE the title-opener composite branch so
  // sentences whose subject is BOTH source-referent (e.g. "The article ")
  // AND uses a negated discussion verb get categorized as critique-by-
  // absence — the more specific category — rather than the generic title-
  // opener authorVoice bucket.
  //
  // Conservative carve-outs (mirror PR-I.1 title-opener):
  //   1. Quoted spans → defer to PR-J's quote+commentary path so any
  //      fabricated quote still flags via section 1.
  //   2. Explicit attribution verb → defer to Lane A as an attributed
  //      claim ("Politico reports that the article does not specify Y" is
  //      an attributed claim about another source's reading, not pure
  //      critique-by-absence).
  if (
    isCritiqueByAbsence(sentence) &&
    extractQuotedSpans(sentence).length === 0 &&
    !hasAttributionVerbAnalysis(sentence)
  ) {
    return { exempt: true, category: "critiqueByAbsence" };
  }
  if (
    isTitleOpenerComposite(sentence) &&
    extractQuotedSpans(sentence).length === 0 &&
    !hasAttributionVerbAnalysis(sentence)
  ) {
    return { exempt: true, category: "authorVoice" };
  }
  if (isOpenerHook(sentence, draftText)) return { exempt: true, category: "openerHook" };
  // Context-frame exemption: a sentence with a year / numeric / named
  // entity that also appears in the cited source is the agent's
  // contextual reference to material the source itself mentions, not a
  // new external fact. Categorized as authorVoice for telemetry
  // accounting (the framing language is the agent's). This catches the
  // S34 case ("It references the GPT-2 weights release debate in 2019…")
  // where 2019 appears in the source's GPT-2 history.
  if (sourceText && isContextFrameOfSource(sentence, sourceText)) {
    return { exempt: true, category: "authorVoice" };
  }
  // Source-referent framing exemption (S35 case): a sentence with an
  // inline source link whose subject is the source itself ("OpenAI has
  // published…", "the document …") is the agent's framing about the
  // source — not a claim attributed to the source. ANALYSIS treats this
  // as author voice. Caught here AFTER the context-frame check so a
  // sentence with both signals is still attributed to context-frame
  // (specific over general).
  if (hasInlineSourceLink(sentence) && hasSourceReferentSubject(sentence)) {
    return { exempt: true, category: "authorVoice" };
  }
  return { exempt: false, category: null };
}

/** True when the sentence STARTS with a source-referent subject — i.e.
 *  the agent is FRAMING the source itself ("OpenAI has published…",
 *  "The document treats X as …"). The match is anchored after any
 *  leading markdown header marker. We strip a leading "## Heading "
 *  using stripLeadingMarkdownHeader (greedy enough to consume a
 *  realistic Title-Case header label of any length), then check the
 *  prefix list against the lowercased remainder. */
export function startsWithSourceReferentSubject(s: string): boolean {
  const { body } = stripLeadingMarkdownHeader(s);
  const lower = body.trim().toLowerCase();
  return SOURCE_REFERENT_SUBJECT_PREFIXES.some(p => lower.startsWith(p));
}

/** Back-compat alias. */
export const hasSourceReferentSubject = startsWithSourceReferentSubject;

/** A sentence is a "context frame" of the source when it references a
 *  hyphenated named identifier (`GPT-2`, `GPT-3`, `Claude-3.5`) that
 *  appears in the source — the agent is pointing at content the source
 *  itself names. We treat hyphenated identifiers as a stronger signal
 *  than year-only or capitalized-phrase-only because they're highly
 *  specific to the source's domain.
 *
 *  Trigger A: hyphenated all-caps identifier (`GPT-2`, `GPT-3`, `RLHF-2`)
 *             appears in BOTH the sentence and the source. Sufficient on
 *             its own.
 *  Trigger B: a 4-digit year appears in the sentence AND in the source,
 *             AND any named multi-word capitalized phrase from the
 *             sentence also appears in the source.
 *
 *  We avoid false-positive matches on common names like "OpenAI"
 *  (which is in the source domain) by requiring at least one
 *  source-overlapping identifier or year. */
export function isContextFrameOfSource(sentence: string, sourceText: string): boolean {
  if (!sourceText) return false;
  const lowerSource = sourceText.toLowerCase();

  // Trigger A: hyphenated identifier match (GPT-2, GPT-3, etc.). The
  // source may use either ASCII hyphen or U+2011 NBH.
  const idents = sentence.match(/\b[A-Z]{2,}(?:[-‑]\d+(?:\.\d+)?)\b/g) ?? [];
  for (const id of idents) {
    const idLower = id.toLowerCase();
    // Try ASCII and U+2011 variants in source (PR-H source-page typography).
    const idAscii = idLower.replace(/[‑]/g, "-");
    const idNbh   = idLower.replace(/-/g, "‑");
    if (lowerSource.includes(idAscii) || lowerSource.includes(idNbh)) return true;
  }

  // Trigger B: year + named-entity overlap.
  const yearMatch = sentence.match(/\b(?:19|20)\d{2}\b/);
  if (!yearMatch) return false;
  const year = yearMatch[0];
  if (!lowerSource.includes(year)) return false;
  const entities = sentence.match(/\b(?:[A-Z][a-z]+(?:[\s][A-Z][a-z]+)+)\b/g) ?? [];
  for (const e of entities) {
    if (e.length < 5) continue;
    if (lowerSource.includes(e.toLowerCase())) return true;
  }
  return false;
}

// ─── PR-J — Quote-plus-commentary span extraction ──────────────────────────
//
// Pulls quoted spans out of an ANALYSIS sentence so the verifier can route
// quote+commentary sentences through the verbatim-quote check (and exempt
// the surrounding gloss as author voice when every quoted span verifies).
//
// Rules:
//   - ASCII double quotes "…": always extracted.
//   - Curly double quotes “…” (U+201C / U+201D): always extracted (the
//     PR-H normalizer folds these to ASCII " before extraction so we only
//     need one matcher).
//   - ASCII single quotes '…' AND curly singles ‘…’ (U+2018 / U+2019):
//     only extracted when the candidate span is ≥ 4 words. This avoids
//     matching contractions (`don't`), possessives (`Agent 306's`), and
//     short emphasis spans that aren't quotes-as-quotation.
//
// The input is normalized with `normalizeForMatching` first (PR-H) — but
// with case folding turned OFF so we don't lose the original casing in the
// extracted span (the verifier's `normalizedContains` will fold case again
// on its side). The fold collapses curly quotes/apostrophes, NBSPs,
// zero-width chars, and the dash family to ASCII before we run the
// extraction regexes — so a single regex can cover both ASCII and curly
// delimiters without separate code paths.

const DOUBLE_QUOTE_SPAN_RX = /"([^"\n]{1,500})"/g;
const SINGLE_QUOTE_SPAN_RX = /(?:^|[^A-Za-z0-9])'([^'\n]{1,500})'(?=$|[^A-Za-z0-9])/g;

export function extractQuotedSpans(sentence: string): string[] {
  if (!sentence) return [];
  // Fold curly quotes/apostrophes/dashes/NBSPs to ASCII so we only need
  // one set of delimiter regexes. Keep case so the original span content
  // is preserved for downstream display/matching.
  const normalized = normalizeForMatching(sentence, { caseFold: false });

  const spans: string[] = [];
  let m: RegExpExecArray | null;

  // Double quotes: always extracted, regardless of word count. Double
  // quotes around prose are unambiguously quotation marks.
  DOUBLE_QUOTE_SPAN_RX.lastIndex = 0;
  while ((m = DOUBLE_QUOTE_SPAN_RX.exec(normalized)) !== null) {
    const span = m[1].trim();
    if (span.length >= 1) spans.push(span);
  }

  // Single quotes: only extracted when the span is ≥ 4 words. The
  // surrounding boundary check ([^A-Za-z0-9] before the opening `'`,
  // EOS or [^A-Za-z0-9] after the closing `'`) excludes possessives
  // (`306's`) and contractions (`don't`) where the apostrophe is
  // adjacent to a letter on both sides. The ≥ 4 word rule rejects short
  // emphatic spans where ASCII single quotes are too ambiguous.
  SINGLE_QUOTE_SPAN_RX.lastIndex = 0;
  while ((m = SINGLE_QUOTE_SPAN_RX.exec(normalized)) !== null) {
    const span = m[1].trim();
    if (!span) continue;
    const wordCount = span.split(/\s+/).filter(w => w.length > 0).length;
    if (wordCount >= 4) spans.push(span);
    // Reset lastIndex one position back so overlapping matches (the
    // closing-boundary char may be the next opening boundary) aren't
    // skipped. The regex already advances, but defensive.
  }

  return spans;
}

// ── Explicit Agent 306 analysis/recommendation framing ─────────────────────
//
// Mode-independent detector for sentences whose author has EXPLICITLY
// labeled them as Agent 306's analysis / recommendation / advice /
// take / read / caveat using a sentence-leading boundary phrase
// (typically followed by `:` or em-dash).
//
// Example (the reported regression):
//   "**Agent 306's analysis: build a brief regular review habit.** Check
//    your bank statement periodically for AI-handled transactions — look
//    for auto-pay notes or assistant-flagged entries."
//
// Such a sentence should NOT be treated as Lane A source-attribution and
// hard-failed when the source text does not contain Agent 306 or the
// recommended habit. The user has explicitly told the reader (and the
// verifier) that this is the agent's voice, not a claim attributed to
// the source.
//
// IMPORTANT — boundary-phrase abuse guard:
//   The framing is recognized ONLY at the sentence's leading subject
//   (after markdown bold/italic and any leading header is stripped).
//   It does NOT exempt embedded factual claims — see
//   `embeddedFactualClaimRequiresSourcing` below — so a sentence like
//     "Agent 306's analysis: the model hit 92.4% accuracy in the
//      benchmark."
//   still routes through the regular Lane B numeric-fact check (and
//   "Politico reports …" inside the analysis still routes through the
//   regular attribution-verb path).
//
// Two checks are exported:
//   - `hasExplicitAgent306AnalysisFraming(s)` → sentence is framed as
//     Agent 306 analysis/recommendation/advice/take/read/caveat.
//   - `embeddedFactualClaimRequiresSourcing(s)` → sentence (presumed
//     already framed) carries a numeric/year marker, named external
//     authority phrase, or explicit attribution verb that still needs
//     sourcing. When true, the regular Lane B / Lane A path applies.

/** Phrases that, when they appear at the start of the sentence (after
 *  optional markdown bold/italic + leading header), label the sentence
 *  as Agent 306's own voice. Each entry is the LOWERCASE prefix exactly
 *  as it appears in the draft, MINUS the trailing `:` or em-dash —
 *  those are checked separately below.
 *
 *  Curated and small. Extending this list is a deliberate act — every
 *  new entry licenses a sentence to bypass the deterministic Lane A
 *  attribution gate. */
export const AGENT_306_FRAMING_PREFIXES = [
  "agent 306's analysis",
  "agent 306's recommendation",
  "agent 306's recommendations",
  "agent 306's advice",
  "agent 306's take",
  "agent 306's read",
  "agent 306's caveat",
  "agent 306 analysis",
  "agent 306 recommendation",
  "agent 306 recommendations",
  "agent 306 advice",
];

/** Strip leading markdown emphasis (`**`, `__`, `*`, `_`) from a string. */
function stripLeadingEmphasis(s: string): string {
  return s.replace(/^[\s*_`]+/, "");
}

/** True when `s` begins with one of `AGENT_306_FRAMING_PREFIXES` followed
 *  by a colon, em-dash, en-dash, or hyphen — i.e. the writer is using
 *  the contract's boundary phrase to label the sentence as the agent's
 *  voice.
 *
 *  The check tolerates leading markdown emphasis (`**Agent 306's
 *  analysis:**`) and a leading `## Heading ` so the merged-into-paragraph
 *  form still classifies. Apostrophe typography is normalized (curly
 *  `'` → straight `'`) before matching so writers using either form get
 *  the same exemption. */
export function hasExplicitAgent306AnalysisFraming(s: string): boolean {
  if (!s) return false;
  const { body } = stripLeadingMarkdownHeader(s);
  // Fold curly apostrophes/quotes to ASCII so the prefix list (which uses
  // straight apostrophes) matches drafts written with either typography.
  // Case-fold off — we lowercase explicitly below.
  const folded = normalizeForMatching(body.trim(), { caseFold: false });
  // Strip leading emphasis markers and whitespace, then lowercase.
  const head = stripLeadingEmphasis(folded).toLowerCase().slice(0, 96);
  for (const prefix of AGENT_306_FRAMING_PREFIXES) {
    if (!head.startsWith(prefix)) continue;
    const after = head.slice(prefix.length);
    // The boundary phrase must be followed by an explicit framing
    // punctuation — colon, em-dash, en-dash, or hyphen — possibly
    // preceded by `**` (closing bold) and/or spaces.
    if (/^[\s*_`]*[:—–\-]/.test(after)) return true;
  }
  return false;
}

/** Single-token "named authority" pattern that should still require
 *  sourcing even inside an Agent 306 analysis sentence. Mirrors the
 *  Lane B `LANE_B_NAMED_AUTHORITY_RX` shape: `study|report|index|…`
 *  followed by `by|from|of`. */
const NAMED_AUTHORITY_INSIDE_ANALYSIS_RX =
  /\b(study|report|index|benchmark|paper|survey)\s+(by|from|of)\b/i;

/** Numeric / unit markers that read as concrete factual claims and
 *  should not be exempted by the Agent 306 framing on their own. */
const NUMERIC_INSIDE_ANALYSIS_RX =
  /(\d{1,3}(?:[.,]\d+)?\s*%|\$\s*\d+(?:[.,]\d+)?\s*(?:thousand|million|billion|trillion|[KMBT])?\b|\b\d+(?:\.\d+)?\s*(?:days?|users?|parameters?|tokens?|attendees?|models?|percent|bps|K|M|B|T)\b|\b\d+(?:\.\d+)?[xX]\b|\b(?:19|20)\d{2}\b)/i;

/** Verb-shape phrases that, inside a framed Agent-306 sentence, signal
 *  an EMBEDDED attribution claim the writer cannot duck behind the
 *  framing label. Each entry must be a strong verb-shape construction:
 *  the bare-noun forms ("notes", "reports") are deliberately excluded
 *  because they show up in ordinary prose ("auto-pay notes",
 *  "expense reports").
 *
 *  Curated and small. Compared to `ATTRIBUTION_VERBS_ANALYSIS`, this
 *  list drops the bare nouns and keeps only verb-shape forms with a
 *  clear subject-verb construction. */
const EMBEDDED_ATTRIBUTION_VERB_RX = new RegExp(
  [
    // "X reports that …", "X stated that …", "X writes that …", …
    "\\b(reports|reported|reporting|stated|states|writes|wrote|argues|argued|claims|claimed|said|says|noted)\\s+(?:that|how|when|why|whether)\\b",
    // "according to …", "per the document …" — discourse-level attribution.
    "\\baccording to\\b",
    "\\bper the (?:document|article|report|principles|piece|paper|study|essay|statement)\\b",
    "\\bthe (?:document|article|report|principles|piece|paper|study|essay|statement)\\s+(?:states|said|says|writes|wrote|argues|reported|reports)\\b",
  ].join("|"),
  "i",
);

function containsEmbeddedAttributionVerb(s: string): boolean {
  return EMBEDDED_ATTRIBUTION_VERB_RX.test(s);
}

/** True when an Agent-306-framed sentence ALSO carries a concrete
 *  factual claim that the writer cannot duck behind the framing label —
 *  numeric markers, named-authority "study by …" phrases, or an
 *  embedded explicit attribution verb construction. In that case, the
 *  verifier falls through to the regular Lane A / Lane B paths so the
 *  embedded claim still gets checked.
 *
 *  Quoted spans are NOT counted here — the verifier's verbatim-quote
 *  check (claimVerifier.ts section 1) handles fabricated quotes
 *  independently and runs in all modes. */
export function embeddedFactualClaimRequiresSourcing(s: string): boolean {
  if (!s) return false;
  if (NUMERIC_INSIDE_ANALYSIS_RX.test(s)) return true;
  if (NAMED_AUTHORITY_INSIDE_ANALYSIS_RX.test(s)) return true;
  if (containsEmbeddedAttributionVerb(s)) return true;
  return false;
}
