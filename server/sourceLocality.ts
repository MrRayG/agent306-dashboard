// ─────────────────────────────────────────────────────────────────────────────
// 306 — SOURCE OBJECT PLUMBING + CITATION LOCALITY (PR-E)
//
// Shared helpers used by blogEngine and articleEngine / Deep Read to:
//
//   1. Carry structured source objects (URL + title + publisher + excerpt)
//      from research / KB intake into writer context, the post-generation
//      citation-locality pre-check, and the verifier's evidence bundle.
//
//   2. Detect Lane B "external fact" sentences whose supporting citation
//      appears in an ADJACENT paragraph rather than the same paragraph.
//      The two-lane verifier (server/claimVerifier.ts) treats Lane B as OK
//      when a markdown link is present in the sentence OR in the enclosing
//      paragraph — so the failure mode this module repairs is the
//      cross-paragraph case ("URL is in the next paragraph"). Same-paragraph
//      adjacency already passes; we still prefer same-sentence placement.
//
//   3. Repair the locality WITHOUT fabricating URLs. Repair only ever
//      reuses a URL that is already present in the supplied source pool.
//      If no relevant source is available, the repair pass HEDGES the
//      sentence verbally (e.g. "publicly reported" / "industry reporting
//      indicates") so the bare external fact is no longer a hard claim.
//      Repair must never invent a URL.
//
// This module is purely deterministic — no LLM calls. The downstream
// claim verifier still runs unchanged after repair: thresholds are NOT
// relaxed, hard failures are NOT converted to pass/fail-open.
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceObject {
  /** Canonical URL — required for any source that should be usable as a citation target. */
  url: string;
  /** Human-readable source title. Optional but strongly preferred. */
  title?: string;
  /** Publisher / outlet name (e.g. "Politico", "OpenAI", "Stanford HAI"). */
  publisher?: string;
  /** ISO timestamp of when the content was retrieved or published. */
  retrievedAt?: string;
  /** kb id / thread id / research id — used for audit, not rendered. */
  sourceId?: string;
  /** Short excerpt (~ 1-2 sentences) supporting the source. Used for relevance scoring. */
  evidenceExcerpt?: string;
}

export interface SourceTelemetry {
  sourceObjectsCount: number;
  sourceUrlsCount: number;
  citedSentencesCount: number;
  bareExternalFactSentencesCount: number;
  citationRepairApplied: number;
  evidenceBundleBytes: number;
}

// ── Pattern library (kept in sync with claimVerifier.ts) ─────────────────────
// Same regexes used by the two-lane verifier so this module's classification
// matches what the verifier will see at gate time. If these drift apart the
// repair pass will leave failures behind and the verifier will quarantine.

const ATTRIBUTION_RX =
  /\b(reported|reports|reporting|according to|cites?|cited|said|wrote|writes|notes?|noted|quoted|claims?|claimed|argues?|argued|presented|demonstrated|unveiled|announced|revealed|the article|the piece|the report|the investigation|the study|the paper|the analysis|the briefing|the demonstration|the demo|the session|the hearing|the findings? (?:showed|revealed|indicate))\b/i;

const LANE_B_NUMERIC_RX =
  /(\d{1,3}(?:[.,]\d+)?\s*%|\$\s*\d+(?:[.,]\d+)?\s*(?:thousand|million|billion|trillion|[KMBT])?\b|\b\d+(?:\.\d+)?\s*(?:days?|users?|parameters?|tokens?|attendees?|models?|percent|bps|K|M|B|T)\b|\b\d+(?:\.\d+)?[xX]\b|\b(?:19|20)\d{2}\b)/i;

const LANE_B_NAMED_AUTHORITY_RX =
  /\b(study|report|index|benchmark|paper|analysis|survey)\s+(by|from|of)\b/i;

const QUOTE_RX = /[""]([^""]{8,500})[""]/;

const MD_LINK_RX = /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/;
const BARE_URL_RX = /https?:\/\/[^\s)]+/;

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","of","in","on","at","to","for",
  "with","by","from","as","is","are","was","were","be","been","being","that",
  "this","these","those","it","its","into","over","under","up","down","out",
  "about","after","before","through","between","among","during","while","than",
  "such","which","who","whom","whose","what","when","where","why","how","not",
  "no","yes","do","does","did","done","has","have","had","will","would","can",
  "could","may","might","must","should","one","two","i","you","he","she","they",
  "we","them","him","her","us","my","your","his","their","our","also","just",
  "more","most","some","any","each","all","every","there","here","very","much",
  "many","few","other","another","new","newer","newest",
]);

// ── Source extraction ───────────────────────────────────────────────────────

/** Pull every markdown link target and bare URL out of a text blob into
 *  SourceObject stubs. URLs are deduped. Used as a fallback when the writer
 *  context already contains source URLs but they were never structured. */
export function extractSourceObjects(text: string): SourceObject[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: SourceObject[] = [];

  const mdLinkRx = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRx.exec(text)) !== null) {
    const url = m[2].trim();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: m[1].trim() });
  }

  const bareRx = /(?<![(\[])https?:\/\/[^\s)<\]]+/g;
  let b: RegExpExecArray | null;
  while ((b = bareRx.exec(text)) !== null) {
    const url = b[0].replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url });
  }

  return out;
}

/** De-duplicate by URL. Later entries win on title/excerpt fields when the
 *  earlier entry was missing them — so structured sources (with title +
 *  excerpt) override extracted bare URLs of the same target. */
export function dedupeSources(sources: SourceObject[]): SourceObject[] {
  const map = new Map<string, SourceObject>();
  for (const s of sources) {
    if (!s?.url) continue;
    const key = s.url.trim();
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...s, url: key });
      continue;
    }
    map.set(key, {
      ...prev,
      ...s,
      url: key,
      title: prev.title ?? s.title,
      publisher: prev.publisher ?? s.publisher,
      retrievedAt: prev.retrievedAt ?? s.retrievedAt,
      sourceId: prev.sourceId ?? s.sourceId,
      evidenceExcerpt: prev.evidenceExcerpt ?? s.evidenceExcerpt,
    });
  }
  return Array.from(map.values());
}

// ── Sentence / paragraph splitters (must match verifier behavior) ────────────

export function splitSentencesPreserving(text: string): { sentence: string; start: number; end: number }[] {
  const out: { sentence: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (
      ch === "." &&
      /\d/.test(text[i - 1] ?? "") &&
      /\d/.test(text[i + 1] ?? "")
    ) {
      continue;
    }
    while (i + 1 < text.length && /[.!?]/.test(text[i + 1])) i += 1;
    const next = text[i + 1] ?? "";
    if (next && !/\s/.test(next) && next !== "\n") continue;
    const sentence = text.slice(start, i + 1).trim();
    if (sentence) out.push({ sentence, start, end: i + 1 });
    start = i + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ sentence: tail, start, end: text.length });
  return out;
}

function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

// ── Lane B detection ─────────────────────────────────────────────────────────

/** Same predicate the verifier uses: an attributed sentence is Lane A and
 *  takes its citation from the source paraphrase check, NOT a markdown
 *  link. We deliberately exclude attributed sentences from repair targets. */
export function isAttributionSentence(s: string): boolean {
  if (ATTRIBUTION_RX.test(s)) return true;
  if (QUOTE_RX.test(s)) return true;
  return false;
}

/** True iff the sentence is a Lane B "external fact" — has a hard factual
 *  signal (number / year / unit / named study) and is not framed as
 *  source-attributed. Same predicate the verifier classifies on. */
export function isLaneBFactSentence(s: string): boolean {
  if (isAttributionSentence(s)) return false;
  if (LANE_B_NUMERIC_RX.test(s)) return true;
  if (LANE_B_NAMED_AUTHORITY_RX.test(s)) return true;
  return false;
}

/** Sentence already carries a markdown citation. */
export function sentenceHasInlineCitation(s: string): boolean {
  return MD_LINK_RX.test(s);
}

/** Paragraph-level citation presence — what the verifier currently passes on. */
export function paragraphHasCitation(paragraph: string): boolean {
  return MD_LINK_RX.test(paragraph);
}

// ── Relevance scoring (deterministic, no LLM) ────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Pick the most relevant source for a sentence, or null if none scores
 *  above the floor. Floor is intentionally non-zero so we never staple a
 *  totally unrelated URL onto a fact. */
export function pickSourceForSentence(
  sentence: string,
  sources: SourceObject[],
  opts: { minScore?: number } = {},
): SourceObject | null {
  const minScore = opts.minScore ?? 0.06;
  let best: SourceObject | null = null;
  let bestScore = 0;
  for (const src of sources) {
    const haystack = [src.title ?? "", src.publisher ?? "", src.evidenceExcerpt ?? ""].join(" ");
    if (!haystack.trim()) continue;
    const score = jaccard(sentence, haystack);
    if (score > bestScore) {
      best = src;
      bestScore = score;
    }
  }
  return bestScore >= minScore ? best : null;
}

// ── The repair pass ──────────────────────────────────────────────────────────

export interface RepairResult {
  draft: string;
  citationsAdded: number;
  sentencesHedged: number;
  /** Sentences that still look like Lane B facts and have no citation in
   *  their paragraph after repair. The caller can use this for telemetry
   *  or pre-check flagging before verification. */
  bareAfterRepair: number;
  /** Repair never inserts a URL that wasn't in the supplied source pool. */
  fabricatedUrls: 0;
}

export interface RepairOptions {
  /** When true (default false) and no relevant source is available for a
   *  Lane B fact sentence, prepend a verbal hedge that generalizes the
   *  claim. Off by default because the verifier may reclassify the hedged
   *  sentence as Lane A and trigger a different failure path. The blog +
   *  article engines use this only when they have a non-empty source pool
   *  that simply doesn't match a particular sentence — never when the
   *  pool is empty (empty-pool drafts skip repair entirely). */
  hedgeWhenNoSource?: boolean;
}

// "As widely reported" intentionally avoids attribution verbs the
// verifier's ATTRIBUTION_RX picks up (reported|cited|said|noted|...).
// "As widely reported" matches "reported" → would reclassify the
// sentence as Lane A. We use "Broadly, " instead — a generalization that
// keeps the sentence in Lane B but without a hard date/number attached.
const HEDGE_PREFIX = "Broadly, ";

/** Apply the citation-locality repair pass.
 *
 *  Walks every paragraph in the draft. For each Lane B fact sentence:
 *    1. If the sentence already has a markdown citation, leave it.
 *    2. If the enclosing paragraph already has a markdown citation, leave it
 *       (the verifier accepts paragraph-level locality today; we still
 *       prefer same-sentence placement, but cross-paragraph is the actual
 *       failure mode we're fixing).
 *    3. Otherwise: find the most relevant source from `sources`. If one
 *       scores above the floor, append `[publisher](url)` to the sentence
 *       (same-sentence placement — strictest locality).
 *    4. If no relevant source is available, prepend a soft hedge so the
 *       sentence is no longer a hard external factual claim. We never
 *       fabricate a URL.
 *
 *  Attribution sentences (Lane A) are never repaired — they're handled by
 *  the source-text paraphrase check, not URL placement.
 */
export function repairCitationLocality(
  draft: string,
  sources: SourceObject[],
  options: RepairOptions = {},
): RepairResult {
  if (!draft) {
    return { draft, citationsAdded: 0, sentencesHedged: 0, bareAfterRepair: 0, fabricatedUrls: 0 };
  }

  const usable = dedupeSources(sources).filter(s => /^https?:\/\//i.test(s.url));

  // Empty-pool short-circuit: with no usable sources, repair has nothing
  // to add and any hedging would be applied indiscriminately. Defer to
  // the verifier and the rewriter loop, both of which can still flag /
  // rewrite the bare sentences. We still report `bareAfterRepair` for
  // telemetry parity.
  if (usable.length === 0) {
    return {
      draft,
      citationsAdded: 0,
      sentencesHedged: 0,
      bareAfterRepair: countBareExternalFactSentences(draft),
      fabricatedUrls: 0,
    };
  }

  // Default hedge behavior: ON when we have a source pool but a specific
  // sentence has no relevant match. The caller can override via
  // `hedgeWhenNoSource`. The hedge prefix is chosen to NOT match the
  // verifier's ATTRIBUTION_RX so the sentence stays in Lane B.
  const hedgeWhenNoSource = options.hedgeWhenNoSource ?? true;

  const paragraphs = draft.split(/(\n\s*\n)/); // keep paragraph boundaries
  let citationsAdded = 0;
  let sentencesHedged = 0;
  let bareAfterRepair = 0;

  for (let pi = 0; pi < paragraphs.length; pi += 1) {
    const para = paragraphs[pi];
    if (!para || /^\s*\n+\s*$/.test(para)) continue;
    if (paragraphHasCitation(para)) {
      // Already covered at paragraph granularity. Same-sentence placement
      // is preferred but the verifier already passes; do not touch.
      continue;
    }

    const sentences = splitSentencesPreserving(para);
    if (sentences.length === 0) continue;

    let rewritten = para;
    let offset = 0;

    for (const seg of sentences) {
      if (!isLaneBFactSentence(seg.sentence)) continue;
      if (sentenceHasInlineCitation(seg.sentence)) continue;

      const pick = pickSourceForSentence(seg.sentence, usable);
      if (pick) {
        const label = pick.publisher ?? pick.title ?? "source";
        const cite = ` [${label}](${pick.url})`;
        // Insert before the trailing punctuation if present, otherwise append.
        const segText = seg.sentence;
        const punctMatch = segText.match(/[.!?]+\s*$/);
        let replacement: string;
        if (punctMatch) {
          const head = segText.slice(0, segText.length - punctMatch[0].length);
          replacement = `${head}${cite}${punctMatch[0]}`;
        } else {
          replacement = `${segText}${cite}`;
        }
        const localStart = seg.start + offset;
        const localEnd = seg.end + offset;
        // Skip leading whitespace inside the paragraph slice so we don't
        // wipe out the sentence delimiter.
        rewritten = rewritten.slice(0, localStart) + replacement + rewritten.slice(localEnd).replace(/^\s*[.!?]\s*/, m => " ");
        offset += replacement.length - (seg.end - seg.start);
        citationsAdded += 1;
        continue;
      }

      // No relevant source — optionally hedge to soften the hard claim.
      if (!hedgeWhenNoSource) {
        bareAfterRepair += 1;
        continue;
      }
      const segText = seg.sentence;
      // Skip headings ("## ...") and list-item leads — they aren't claims.
      if (/^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/.test(segText)) {
        bareAfterRepair += 1;
        continue;
      }
      // Avoid double-hedging.
      if (/^\s*(?:broadly,|as widely reported|publicly reported|industry reporting indicates)/i.test(segText)) {
        bareAfterRepair += 1;
        continue;
      }
      const hedged = HEDGE_PREFIX + segText.charAt(0).toLowerCase() + segText.slice(1);
      const localStart = seg.start + offset;
      const localEnd = seg.end + offset;
      rewritten = rewritten.slice(0, localStart) + hedged + rewritten.slice(localEnd);
      offset += hedged.length - (seg.end - seg.start);
      sentencesHedged += 1;
    }

    paragraphs[pi] = rewritten;
  }

  const finalDraft = paragraphs.join("");

  // Re-scan for any Lane B sentences whose paragraph still has no link —
  // hedged sentences will be reclassified as non-fact (no longer a hard
  // external claim). Pure telemetry; does not affect verifier severity.
  for (const para of paragraphsOf(finalDraft)) {
    if (paragraphHasCitation(para)) continue;
    for (const seg of splitSentencesPreserving(para)) {
      if (!isLaneBFactSentence(seg.sentence)) continue;
      if (sentenceHasInlineCitation(seg.sentence)) continue;
      bareAfterRepair += 1;
    }
  }

  return {
    draft: finalDraft,
    citationsAdded,
    sentencesHedged,
    bareAfterRepair,
    fabricatedUrls: 0,
  };
}

// ── Telemetry helpers ────────────────────────────────────────────────────────

export function summarizeSources(sources: SourceObject[]): { sourceObjectsCount: number; sourceUrlsCount: number } {
  const deduped = dedupeSources(sources);
  return {
    sourceObjectsCount: deduped.length,
    sourceUrlsCount: deduped.filter(s => /^https?:\/\//i.test(s.url)).length,
  };
}

/** Count sentences that carry an inline citation OR live in a paragraph
 *  that does. Mirrors verifier acceptance. */
export function countCitedSentences(draft: string): number {
  let cited = 0;
  for (const para of paragraphsOf(draft)) {
    const paraCited = paragraphHasCitation(para);
    for (const seg of splitSentencesPreserving(para)) {
      if (sentenceHasInlineCitation(seg.sentence) || paraCited) cited += 1;
    }
  }
  return cited;
}

/** Count Lane B "external fact" sentences without a citation in their paragraph. */
export function countBareExternalFactSentences(draft: string): number {
  let bare = 0;
  for (const para of paragraphsOf(draft)) {
    if (paragraphHasCitation(para)) continue;
    for (const seg of splitSentencesPreserving(para)) {
      if (!isLaneBFactSentence(seg.sentence)) continue;
      if (sentenceHasInlineCitation(seg.sentence)) continue;
      bare += 1;
    }
  }
  return bare;
}

/** Approx byte-size of the evidence bundle handed to the verifier. */
export function evidenceBundleSize(sourceText: string, sources: SourceObject[]): number {
  const sourceBytes = sourceText ? Buffer.byteLength(sourceText, "utf8") : 0;
  let extraBytes = 0;
  for (const s of sources) {
    extraBytes += Buffer.byteLength(JSON.stringify(s), "utf8");
  }
  return sourceBytes + extraBytes;
}

/** Build the structured "AVAILABLE SOURCES" block the writer prompt
 *  receives. Same shape blogEngine and articleEngine consume so the
 *  inline-citation guidance lands consistently. */
export function buildSourcesPromptBlock(sources: SourceObject[]): string {
  const deduped = dedupeSources(sources).filter(s => /^https?:\/\//i.test(s.url));
  if (deduped.length === 0) return "";
  const rows = deduped.slice(0, 12).map((s, i) => {
    const label = s.publisher ?? s.title ?? `Source ${i + 1}`;
    const excerpt = s.evidenceExcerpt ? ` — ${s.evidenceExcerpt.slice(0, 200)}` : "";
    return `- [${label}](${s.url})${s.title && s.title !== label ? ` ("${s.title}")` : ""}${excerpt}`;
  });
  return [
    "AVAILABLE SOURCE URLS — use these as inline markdown citations in the SAME sentence as the fact they support:",
    ...rows,
    "Use the format [Publisher](URL) immediately after the supported claim. Do not invent URLs. If no listed source supports a hard factual claim, hedge or drop the claim — do not fabricate a citation.",
  ].join("\n");
}

/** Full telemetry snapshot for a draft + source pool. Used by both engines
 *  so log lines stay consistent. */
export function computeSourceTelemetry(opts: {
  draft: string;
  sources: SourceObject[];
  sourceText: string;
  citationRepairApplied: number;
}): SourceTelemetry {
  const { sourceObjectsCount, sourceUrlsCount } = summarizeSources(opts.sources);
  return {
    sourceObjectsCount,
    sourceUrlsCount,
    citedSentencesCount: countCitedSentences(opts.draft),
    bareExternalFactSentencesCount: countBareExternalFactSentences(opts.draft),
    citationRepairApplied: opts.citationRepairApplied,
    evidenceBundleBytes: evidenceBundleSize(opts.sourceText, opts.sources),
  };
}
