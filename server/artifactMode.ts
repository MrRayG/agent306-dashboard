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
 *  self-reference. */
export const AUTHOR_VOICE_PATTERNS = [
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
const SOURCE_REFERENT_SUBJECT_PREFIXES = [
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

// ── ANALYSIS exemption decision ─────────────────────────────────────────────

export interface ExemptionResult {
  exempt: boolean;
  /** Reason category. Used for telemetry counters. */
  category: "authorVoice" | "forwardProjection" | "sectionHeader" | "openerHook" | null;
}

/** Decide whether `s` is exempt from Lane A / Lane B classification under
 *  ANALYSIS rules. Order of checks matters because some sentences hit
 *  multiple categories (e.g. forward-projection inside a paragraph that
 *  has a citation). We attribute the exemption to the FIRST matching
 *  category for telemetry stability. */
export function analysisExemption(
  sentence: string,
  draftText: string,
  sourceText?: string,
): ExemptionResult {
  if (isMarkdownHeaderSentence(sentence)) return { exempt: true, category: "sectionHeader" };
  // attribution-by-link is NOT an exemption — it's a separate flagging
  // path handled by the caller. We only short-circuit on it here so a
  // sentence with both attribution-by-link + author-voice still flags.
  if (looksLikeAttributionByLink(sentence)) return { exempt: false, category: null };
  if (hasForwardProjection(sentence)) return { exempt: true, category: "forwardProjection" };
  if (hasAuthorVoice(sentence))       return { exempt: true, category: "authorVoice" };
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
