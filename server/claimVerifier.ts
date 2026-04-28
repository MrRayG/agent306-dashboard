// ─────────────────────────────────────────────────────────────────────────────
// 306 — CLAIM VERIFIER (two-lane)
//
// Post-write grounding check for any draft that attributes claims to a
// specific source. Walks the draft for attribution sentences, quoted
// spans, and specific statistics, then checks them against the source
// text.
//
// FAIL-CLOSED ON JUDGE OUTAGE (added 2026-04-25):
//   When the LLM judge call fails (network error, non-2xx, malformed
//   JSON), every still-unresolved Lane A sentence is recorded as
//   `LANE_A_UNVERIFIABLE` (lane='unverifiable') and severity is forced
//   to HARD_FAIL. The previous behavior — silently dropping the
//   unresolved sentences from the report and letting severity collapse
//   to PASS — is preserved only when the operator explicitly opts in
//   via `VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true`. Default is closed.
//   Each affected sentence emits a single
//   `[CLAIM_VERIFIER] judge_unreachable` log line with reason + model.
//
// TWO-LANE STANDARD (after the v2 Politico incident, 2026-04-24):
//
//   LANE A — SOURCE-ATTRIBUTED. Sentences that frame a claim as coming
//     from the source (verbs: reported, according to, said, cited,
//     quoted, the article/piece/report/study/briefing/demo/session, …)
//     OR sentences containing the source title / source domain, OR
//     sentences containing a quoted span. These MUST appear verbatim or
//     as a clear paraphrase in sourceText. Violations are a HARD FAIL.
//
//   LANE B — EXTERNAL FACTS the agent introduces in her own voice. A
//     sentence with a year, a number with units, or a named study /
//     benchmark / institution that is NOT attributed to the source. The
//     user's standard: "Anything factual is fine as long as it relates
//     to the article on what the agent is trying to message. If it
//     doesn't relate or connect in some way then it would not be
//     great." Operationally, Lane B sentences MUST contain a markdown
//     link `[…](http…)` in the sentence or the enclosing paragraph.
//     Missing citation → SOFT WARNING (lane='external-uncited').
//
//   EMBEDDED-EXTERNAL-IN-ATTRIBUTION — Lane B fact dressed as Lane A
//     reporting. Example: "researchers from NCITE, a DHS Center of
//     Excellence that receives funding from the Department of Homeland
//     Security, presented findings…" The appositive fact is external
//     but the sentence frames it as coming from the cited source. HARD
//     FAIL in all paths — this is the worst failure mode.
//
// Quoted spans are still checked verbatim. Statistics inside Lane A
// sentences must still appear in sourceText.
// ─────────────────────────────────────────────────────────────────────────────

import { getModel } from "./modelRouter.js";
import { postChatCompletions } from "./llmCall.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { checkRetractedClaims } from "./retractedClaims.js";
// PR-H — symmetric typographic / Unicode fold for source comparison. See
// server/textNormalization.ts for the per-step justification (each fold
// step is pinned to a regression test in
// server/__tests__/verifierTextNormalization.test.ts).
import { normalizeForMatching } from "./textNormalization.js";
// PR-I — artifact-mode aware exemptions. ANALYSIS mode lets the agent's
// voice through (forward projections, section headers, author-voice
// constructions, opener hooks) while preserving fabrication detection,
// attribution-verb checks, and verbatim-quote enforcement. See
// server/artifactMode.ts for the per-trigger-list justification.
import {
  type ArtifactMode,
  resolveArtifactMode,
  analysisExemption,
  isMarkdownHeaderSentence,
  looksLikeAttributionByLink,
  hasAttributionVerbAnalysis as hasAttributionVerbInAnalysisMode,
  extractQuotedSpans,
} from "./artifactMode.js";

export type ClaimLane =
  | "source-attributed"
  | "external-uncited"
  | "embedded-external-in-attribution"
  | "retracted"
  | "unverifiable";

export type VerifierSeverity = "PASS" | "SOFT_WARN" | "HARD_FAIL";

export type SentenceClassification =
  | "LANE_A_OK"
  | "LANE_A_FAIL"
  | "LANE_A_UNVERIFIABLE"
  | "LANE_A_PASS_QUOTED_COMMENTARY"
  | "LANE_B_OK"
  | "LANE_B_BARE"
  | "RETRACTED_HIT"
  | "NCITE_PATTERN_HIT";

/** Why a Lane A sentence was marked LANE_A_UNVERIFIABLE — surfaced to ops. */
export type UnverifiableReason =
  | "judge_unreachable"
  | "judge_parse_error"
  | "judge_timeout";

/** Operators may opt in to the legacy fail-open behavior during a known
 * judge-model outage by setting VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true.
 * Default is fail-closed: every unverifiable sentence is HARD_FAIL. */
export function failOpenOnJudgeOutageEnabled(): boolean {
  return (process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE ?? "false").toLowerCase() === "true";
}

export interface VerifierReportEntry {
  sentenceIndex: number;
  snippet: string;
  classification: SentenceClassification;
  reason: string;
  suggestedFix?: string;
}

export interface VerifierReport {
  severity: VerifierSeverity;
  entries: VerifierReportEntry[];
  summary: {
    laneAOk: number;
    laneAFail: number;
    laneAUnverifiable: number;
    /** PR-J — ANALYSIS-mode quote+commentary sentences whose quoted spans
     *  all verified against source. Surfaced separately from `laneAOk` so
     *  the dashboard can show "passed via quoted-span verification" — never
     *  silently masked as a regular pass. */
    laneAPassQuotedCommentary: number;
    laneBOk: number;
    laneBBare: number;
    retractedHits: number;
    ncitePatternHits: number;
  };
  /** Set when at least one sentence was marked LANE_A_UNVERIFIABLE.
   * `failOpenOverride: true` means VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE
   * was set and the verdict was NOT auto-failed despite the outage. */
  judgeOutage?: {
    affectedSentences: number;
    reason: UnverifiableReason;
    model?: string;
    failOpenOverride: boolean;
  };
  /** PR-I — the resolved artifact mode for this verification run. */
  artifactMode?: ArtifactMode;
  /** PR-I — telemetry counters for ANALYSIS-mode exemptions. Always
   *  present so the dashboard can render a stable shape regardless of mode;
   *  every counter is 0 outside ANALYSIS mode.
   *
   *  - authorVoice / forwardProjection / sectionHeader / openerHook:
   *    sentences exempted by the corresponding ANALYSIS rule.
   *  - preBranchFlagged / postBranchFlagged: count of LANE_A_FAIL +
   *    LANE_B_BARE + NCITE_PATTERN_HIT + RETRACTED_HIT entries that
   *    would have fired under REPORT-mode rules vs. what actually fires
   *    after the mode branch. The delta is the impact the mode created. */
  modeExemptions?: {
    authorVoice: number;
    forwardProjection: number;
    sectionHeader: number;
    openerHook: number;
    preBranchFlagged: number;
    postBranchFlagged: number;
  };
}

export interface UnsupportedClaim {
  sentence: string;
  lane:     ClaimLane;
  reason:   string;
}

export interface ClaimVerdict {
  ok: boolean;
  unsupportedClaims: UnsupportedClaim[];
  supportedCount:     number;
  /** Lane B sentences that included a citation (counted as OK). */
  externalCitedCount: number;
  /** Structured verifier output for operator UI and API consumers. */
  verifierReport: VerifierReport;
  /** Alias of verifierReport.severity for simple gate checks. */
  severity: VerifierSeverity;
}

/** Minimal subset of postChatCompletions for tests to inject. Both the
 *  real module and the test stub conform to this shape. */
export type LLMJudgeClient = (
  body: any,
  signal: AbortSignal,
  endpoint: string,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text?: () => Promise<string>;
}>;

export interface VerifyClaimsOpts {
  draftText:   string;
  sourceText:  string;
  sourceUrl:   string;
  sourceTitle: string;
  /** Escape hatch for tests: skip the LLM call, use only deterministic checks. */
  skipLLM?:    boolean;
  /** Test-only: override the LLM judge transport so the outage paths are
   *  reachable without monkey-patching the module. Production callers
   *  always omit this and the real `postChatCompletions` is used. */
  judgeClient?: LLMJudgeClient;
  /** PR-I — artifact-mode flag set explicitly by the writer entry point.
   *  When unset, defaults to REPORT (preserves current behavior). Deep Read
   *  sets ANALYSIS; other engines stay on default. See server/artifactMode.ts.
   */
  artifactMode?: ArtifactMode;
}

// ── Detection patterns ─────────────────────────────────────────────────────
// Attribution verbs / phrases that imply the sentence is quoting the source.
// Expanded in v2 to catch "the briefing showed", "the session", "the demonstration".
const ATTRIBUTION_RX = /\b(reported|reports|reporting|according to|cites?|cited|said|wrote|writes|notes?|noted|quoted|claims?|claimed|argues?|argued|presented|demonstrated|unveiled|announced|revealed|the article|the piece|the report|the investigation|the study|the paper|the analysis|the briefing|the demonstration|the demo|the session|the hearing|the findings? (?:showed|revealed|indicate))\b/i;

// Specific statistic shapes.
const STAT_RX = /(\d{1,3}(?:\.\d+)?\s*%|\d{4}\s*[–-]\s*\d{4}|\b\d+(?:\.\d+)?[xX]\b)/g;

// Lane B numeric/unit signals: percentages, multipliers, dollar amounts,
// SI-ish units (M/B/K/bps), or bare years. Used to classify a NON-attributed
// sentence as "making an external factual claim".
const LANE_B_NUMERIC_RX =
  /(\d{1,3}(?:[.,]\d+)?\s*%|\$\s*\d+(?:[.,]\d+)?\s*(?:thousand|million|billion|trillion|[KMBT])?\b|\b\d+(?:\.\d+)?\s*(?:days?|users?|parameters?|tokens?|attendees?|models?|percent|bps|K|M|B|T)\b|\b\d+(?:\.\d+)?[xX]\b|\b(?:19|20)\d{2}\b)/i;

const NUMERIC_MARKER_RX =
  /(\d{1,3}(?:[.,]\d+)?\s*%|\$\s*\d+(?:[.,]\d+)?\s*(?:thousand|million|billion|trillion|[KMBT])?\b|\b(?:19|20)\d{2}(?:\s*[–-]\s*(?:19|20)\d{2})?\b|\b\d+(?:\.\d+)?\s*(?:days?|users?|parameters?|tokens?|attendees?|models?|percent|bps|K|M|B|T)\b|\b\d+(?:\.\d+)?[xX]\b)/gi;

// Lane B "named external authority" heuristic. Triggers if the sentence
// contains `STUDY|REPORT|INDEX|BENCHMARK|PAPER|ANALYSIS` followed by
// `by|from|of`, which is a common way external facts get name-checked.
const LANE_B_NAMED_AUTHORITY_RX =
  /\b(study|report|index|benchmark|paper|analysis|survey)\s+(by|from|of)\b/i;

// Quoted spans — text inside straight or curly double-quotes.
const QUOTE_RX = /[""]([^""]{8,500})[""]/g;

// Markdown link pattern — presence in a sentence/paragraph counts as citation.
const MD_LINK_RX = /\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/;

// Appositive pattern that tends to introduce external facts inside an
// otherwise-attributed sentence. Permissive by design — false positives
// here are cheaper than the NCITE fabrication. Matches:
//   ", a [noun phrase] that …"
//   ", the [noun phrase] based at …"
//   "(a [noun phrase])"
// Anchored on comma-or-paren boundaries so it doesn't match ordinary prose.
const APPOSITIVE_RX =
  /(?:,\s+|\(\s*)(an?|the)\s+[^,()]{10,160}?(?:\s+(?:that|which|funded by|based at|founded in|run by|operated by|owned by|headed by)\s+[^,()]+?)?(?:,|\))/gi;

// Small helpers ────────────────────────────────────────────────────────────
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Do not split decimal statistics such as 54.6% or 19.7%.
    if (
      ch === "." &&
      /\d/.test(cleaned[i - 1] ?? "") &&
      /\d/.test(cleaned[i + 1] ?? "")
    ) {
      continue;
    }

    while (i + 1 < cleaned.length && /[.!?]/.test(cleaned[i + 1])) i += 1;
    const next = cleaned[i + 1] ?? "";
    if (next && !/\s/.test(next)) continue;

    const part = cleaned.slice(start, i + 1).trim();
    if (part) parts.push(part);
    start = i + 1;
  }

  const tail = cleaned.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

function sourceDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizedContains(haystack: string, needle: string): boolean {
  if (needle.length < 3) return true;
  // PR-H: apply the richer typographic/Unicode fold on both sides before the
  // substring check. The fold is a strict superset of the previous
  // lowercase + whitespace-collapse normalization, so anything that matched
  // before still matches; the new behavior is that curly quotes,
  // apostrophes, NBHs, en/em dashes, NBSPs, and zero-width characters in
  // either string no longer cause false-positive "fabricated quote" rejections
  // on text that appears verbatim in the source modulo typography.
  // Strictness on real fabrications is unchanged: a string that does not
  // appear in the source AFTER normalization still produces no match.
  const H = normalizeForMatching(haystack);
  const N = normalizeForMatching(needle);
  return H.includes(N);
}

function isAttributionSentence(
  s: string,
  title: string,
  domain: string,
): boolean {
  if (ATTRIBUTION_RX.test(s)) return true;
  if (title && title.length > 6 && s.toLowerCase().includes(title.toLowerCase())) return true;
  if (domain && s.toLowerCase().includes(domain)) return true;
  if (QUOTE_RX.test(s)) {
    QUOTE_RX.lastIndex = 0;
    return true;
  }
  QUOTE_RX.lastIndex = 0;
  return false;
}

/** Heuristic: does this non-attribution sentence make an external factual claim? */
function isLaneBFactSentence(s: string): boolean {
  if (LANE_B_NUMERIC_RX.test(s)) return true;
  if (LANE_B_NAMED_AUTHORITY_RX.test(s)) return true;
  return false;
}


function snippetFor(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > 240 ? clean.slice(0, 237) + "..." : clean;
}

function countNumericMarkers(s: string): number {
  NUMERIC_MARKER_RX.lastIndex = 0;
  const matches = s.match(NUMERIC_MARKER_RX) ?? [];
  return matches.length;
}

function computeSummary(entries: VerifierReportEntry[]): VerifierReport["summary"] {
  return {
    laneAOk: entries.filter(e => e.classification === "LANE_A_OK").length,
    laneAFail: entries.filter(e => e.classification === "LANE_A_FAIL").length,
    laneAUnverifiable: entries.filter(e => e.classification === "LANE_A_UNVERIFIABLE").length,
    laneAPassQuotedCommentary: entries.filter(e => e.classification === "LANE_A_PASS_QUOTED_COMMENTARY").length,
    laneBOk: entries.filter(e => e.classification === "LANE_B_OK").length,
    laneBBare: entries.filter(e => e.classification === "LANE_B_BARE").length,
    retractedHits: entries.filter(e => e.classification === "RETRACTED_HIT").length,
    ncitePatternHits: entries.filter(e => e.classification === "NCITE_PATTERN_HIT").length,
  };
}

function reportSeverity(
  entries: VerifierReportEntry[],
  opts: { unverifiableForcesHardFail?: boolean } = {},
): VerifierSeverity {
  const hardClass = entries.some(e =>
    e.classification === "RETRACTED_HIT" ||
    e.classification === "LANE_A_FAIL" ||
    e.classification === "NCITE_PATTERN_HIT",
  );
  if (hardClass) return "HARD_FAIL";
  // Fail-closed: any LANE_A_UNVERIFIABLE entry escalates the verdict to
  // HARD_FAIL unless the operator opted into failing-open via
  // VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true (then unverifiableForcesHardFail
  // is false and the entries are merely informational).
  if (opts.unverifiableForcesHardFail !== false &&
      entries.some(e => e.classification === "LANE_A_UNVERIFIABLE")) {
    return "HARD_FAIL";
  }
  const bareLaneB = entries.filter(e => e.classification === "LANE_B_BARE");
  const laneBNumericHardFail = bareLaneB.some(e => countNumericMarkers(e.snippet) >= 2);
  if (bareLaneB.length >= 3 || laneBNumericHardFail) return "HARD_FAIL";
  if (bareLaneB.length > 0) return "SOFT_WARN";
  return "PASS";
}

function finalizeVerdict(args: {
  unsupported: UnsupportedClaim[];
  supportedCount: number;
  externalCitedCount: number;
  entries: VerifierReportEntry[];
  judgeOutage?: VerifierReport["judgeOutage"];
  artifactMode?: ArtifactMode;
  modeExemptions?: VerifierReport["modeExemptions"];
}): ClaimVerdict {
  const summary = computeSummary(args.entries);
  // Operator escape hatch — VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true makes
  // unverifiable entries informational instead of blocking.
  const failOpen = failOpenOnJudgeOutageEnabled();
  const severity = reportSeverity(args.entries, { unverifiableForcesHardFail: !failOpen });
  // Stamp the judgeOutage block so consumers can show "judge outage" in
  // the UI even when failOpen is on.
  let outage = args.judgeOutage;
  if (outage && failOpen) outage = { ...outage, failOpenOverride: true };
  return {
    ok: severity !== "HARD_FAIL",
    unsupportedClaims: args.unsupported,
    supportedCount: args.supportedCount,
    externalCitedCount: args.externalCitedCount,
    severity,
    verifierReport: {
      severity,
      entries: args.entries,
      summary,
      ...(outage ? { judgeOutage: outage } : {}),
      ...(args.artifactMode ? { artifactMode: args.artifactMode } : {}),
      ...(args.modeExemptions ? { modeExemptions: args.modeExemptions } : {}),
    },
  };
}

function addEntry(
  entries: VerifierReportEntry[],
  sentenceIndex: number,
  sentence: string,
  classification: SentenceClassification,
  reason: string,
  suggestedFix?: string,
): void {
  entries.push({
    sentenceIndex,
    snippet: snippetFor(sentence),
    classification,
    reason,
    ...(suggestedFix ? { suggestedFix } : {}),
  });
}

/** Locate which paragraph of `draftText` contains the sentence (first match). */
function paragraphFor(sentence: string, draftText: string): string {
  const paras = splitParagraphs(draftText);
  const needle = normalize(sentence).slice(0, 80);
  for (const p of paras) {
    if (normalize(p).includes(needle)) return p;
  }
  return sentence;
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Verify that every claim the draft attributes to the source is actually
 * backed by the source text, and that external facts the draft brings in
 * from the agent's own knowledge are cited with a real URL. See the
 * module header comment for the two-lane standard.
 */
export async function verifyClaims(opts: VerifyClaimsOpts): Promise<ClaimVerdict> {
  const { draftText, sourceText, sourceUrl, sourceTitle } = opts;
  const unsupported: UnsupportedClaim[] = [];
  const entries: VerifierReportEntry[] = [];
  let supportedCount = 0;
  let externalCitedCount = 0;

  if (!draftText) {
    unsupported.push({
      sentence: "(no draft)",
      lane:     "source-attributed",
      reason:   "missing draft text",
    });
    addEntry(entries, -1, "(no draft)", "LANE_A_FAIL", "missing draft text");
    return finalizeVerdict({ unsupported, supportedCount, externalCitedCount, entries });
  }

  const domain = sourceDomain(sourceUrl);
  const title  = (sourceTitle || "").trim();
  const sentences = splitSentences(draftText);
  const sentenceIndex = new Map<string, number>();
  sentences.forEach((s, i) => {
    const key = normalize(s);
    if (!sentenceIndex.has(key)) sentenceIndex.set(key, i);
  });

  const failedLaneA = new Set<string>();
  const failedEmbedded = new Set<string>();
  const okLaneA = new Set<string>();
  const handledLaneB = new Set<string>();
  const retractedSentences = new Set<string>();

  // ── PR-I: artifact-mode resolution + per-mode pre-classification ────
  // The mode flag is set explicitly by the writer at the entry point.
  // Default (unset) resolves to REPORT — preserves current behavior. The
  // ANALYSIS branch exempts author voice / forward projections / section
  // headers / opener hooks before Lane A and Lane B classification run.
  // MANUSCRIPT is REPORT + section-header skipping (which is also applied
  // in REPORT and default since it fixes a separate bug — see audit).
  const artifactMode = resolveArtifactMode(opts.artifactMode);
  const exemptKeys = new Set<string>();
  const exemptionCounters = {
    authorVoice: 0,
    forwardProjection: 0,
    sectionHeader: 0,
    openerHook: 0,
    preBranchFlagged: 0,
    postBranchFlagged: 0,
  };
  // PR-I attribution-by-link rule: in ANALYSIS, sentences with an inline
  // source link AND no attribution verb AND a quantitative-or-editorial
  // assertion AND no support in source are STILL flagged. This is the
  // explicit line between "context-link with author projection" (allowed)
  // and "attribution-by-link with unsupported claim" (flagged).
  const attributionByLinkSentences = new Set<string>();

  // PR-I scoping note (audit follow-up):
  //   The spec calls out that section headers are "never classified in any
  //   mode" as the right end-state. Today's verifier classifies them as
  //   content because splitSentences flattens newlines — that's a separate
  //   bug that should NOT be silently fixed under PR-I (per the spec's
  //   hard constraint: "do not silently fix it under this PR; flag it for
  //   follow-up"). For PR-I we only skip section headers in ANALYSIS mode,
  //   keeping REPORT / MANUSCRIPT / default byte-identical to today on
  //   header sentences. The cross-mode header skip lands as PR-I1.

  if (artifactMode === "ANALYSIS") {
    for (const s of sentences) {
      if (isMarkdownHeaderSentence(s)) {
        exemptKeys.add(normalize(s));
        exemptionCounters.sectionHeader += 1;
      }
    }
  }

  if (artifactMode === "ANALYSIS") {
    for (const s of sentences) {
      const key = normalize(s);
      if (exemptKeys.has(key)) continue; // already handled (header)
      // Attribution-by-link is NOT an exemption. It flags later as
      // LANE_A_FAIL when source check fails. Detect it here.
      if (looksLikeAttributionByLink(s)) {
        attributionByLinkSentences.add(key);
        continue;
      }
      const result = analysisExemption(s, draftText, sourceText);
      if (result.exempt && result.category) {
        exemptKeys.add(key);
        exemptionCounters[result.category] += 1;
      }
    }
  }

  // 0. Do-not-republish registry — highest severity, checked before publish gates.
  for (const [idx, s] of sentences.entries()) {
    const hits = checkRetractedClaims(s);
    for (const hit of hits) {
      unsupported.push({
        sentence: s,
        lane:     "retracted",
        reason:   hit.reason,
      });
      addEntry(
        entries,
        idx,
        s,
        "RETRACTED_HIT",
        `${hit.id}: ${hit.reason}`,
        "Drop this retracted claim or replace it with a freshly cited, operator-approved rewrite.",
      );
      retractedSentences.add(normalize(s));
    }
  }

  // If there's no sourceText at all, every attribution is unsupported —
  // and every Lane B fact still needs a citation.
  if (!sourceText) {
    for (const [idx, s] of sentences.entries()) {
      const key = normalize(s);
      // PR-I: skip exempt sentences (section headers in any mode, author
      // voice / forward projection / opener hook in ANALYSIS).
      if (exemptKeys.has(key)) continue;
      if (isAttributionSentence(s, title, domain)) {
        unsupported.push({
          sentence: s,
          lane:     "source-attributed",
          reason:   "no source text provided to verify attribution",
        });
        addEntry(
          entries,
          idx,
          s,
          "LANE_A_FAIL",
          "no source text provided to verify attribution",
          "Remove the attribution or provide source text that supports it.",
        );
        failedLaneA.add(key);
      } else if (isLaneBFactSentence(s)) {
        const para = paragraphFor(s, draftText);
        if (!MD_LINK_RX.test(s) && !MD_LINK_RX.test(para)) {
          unsupported.push({
            sentence: s,
            lane:     "external-uncited",
            reason:   "external fact without a citation link",
          });
          addEntry(
            entries,
            idx,
            s,
            "LANE_B_BARE",
            "external fact without a citation link",
            "Add an inline markdown citation in this sentence/paragraph or drop the fact.",
          );
        } else {
          externalCitedCount += 1;
          addEntry(entries, idx, s, "LANE_B_OK", "external fact has an inline citation");
        }
        handledLaneB.add(key);
      }
    }
    return finalizeVerdict({
      unsupported, supportedCount, externalCitedCount, entries,
      artifactMode, modeExemptions: exemptionCounters,
    });
  }

  // ── 1. Quoted spans — must appear verbatim in sourceText ────────────
  const seenQuotes = new Set<string>();
  let qm: RegExpExecArray | null;
  QUOTE_RX.lastIndex = 0;
  while ((qm = QUOTE_RX.exec(draftText)) !== null) {
    const span = qm[1].trim();
    if (span.length < 8) continue;
    const key = normalize(span);
    if (seenQuotes.has(key)) continue;
    seenQuotes.add(key);
    if (!normalizedContains(sourceText, span)) {
      const quoteSentence = sentences.find(s => s.includes(span)) ?? `"${span}"`;
      const idx = sentenceIndex.get(normalize(quoteSentence)) ?? -1;
      unsupported.push({
        sentence: `"${span}"`,
        lane:     "source-attributed",
        reason:   "fabricated quote",
      });
      addEntry(
        entries,
        idx,
        quoteSentence,
        "LANE_A_FAIL",
        `fabricated quote: "${span}"`,
        "Use only quotes that appear verbatim in the source text, or paraphrase without quotation marks.",
      );
      failedLaneA.add(normalize(quoteSentence));
    } else {
      supportedCount += 1;
    }
  }

  // ── PR-J: ANALYSIS quote-plus-commentary recognition ────────────────
  // In ANALYSIS mode, sentences combining a verbatim source quote with
  // the agent's gloss should pass when EVERY quoted span verifies — the
  // surrounding gloss is treated as author voice. Section 1 above is
  // strict on fabrications (spans ≥ 8 chars not in source = LANE_A_FAIL),
  // and that strictness is preserved: if any extracted span is fabricated,
  // the existing path flags it and we do NOT grant the new sub-status.
  //
  // The new sub-status `LANE_A_PASS_QUOTED_COMMENTARY` is emitted ONLY
  // when ALL extracted spans pass `normalizedContains(sourceText, span)`
  // AND at least one span exists. The sentence is then exempted from
  // section 2's attribution classification AND the LLM-judge fallback
  // (the gloss is author voice, not a Lane A claim).
  //
  // Hard rule: this branch is ANALYSIS-only. REPORT / MANUSCRIPT / default
  // are byte-identical to today.
  const quotedCommentaryPassed = new Set<string>();
  if (artifactMode === "ANALYSIS") {
    for (const s of sentences) {
      const key = normalize(s);
      if (exemptKeys.has(key)) continue;
      if (failedLaneA.has(key)) continue; // a fabricated span already flagged this sentence
      const spans = extractQuotedSpans(s);
      if (spans.length === 0) continue;
      const allPass = spans.every(span => normalizedContains(sourceText, span));
      if (!allPass) continue; // any fabricated span → fall through to existing path
      quotedCommentaryPassed.add(key);
      addEntry(
        entries,
        sentenceIndex.get(key) ?? -1,
        s,
        "LANE_A_PASS_QUOTED_COMMENTARY",
        `quote+commentary: ${spans.length} quoted span(s) verified against source; surrounding gloss treated as author voice`,
      );
      supportedCount += 1;
    }
  }

  // ── 2. Classify every sentence ─────────────────────────────────────
  // PR-I: in ANALYSIS, the "attribution" gate is narrower — only explicit
  // attribution verbs and direct quotes count. An inline source link
  // alone is treated as a context pointer (per spec). Sentences that
  // look like attribution-by-link without a verb are routed to the
  // attribution-by-link flagging path that runs after this loop.
  function isAttributionForMode(s: string): boolean {
    if (artifactMode === "ANALYSIS") {
      // Quoted spans: handled by section 1 (verbatim quote check) above.
      // Here we count only sentences whose Lane A signal is an explicit
      // attribution VERB or a quoted span — NOT a domain or title match.
      const hasQuotedSpan = /[""][^""\n]{8,500}[""]/.test(s);
      return hasAttributionVerbInAnalysisMode(s) || hasQuotedSpan;
    }
    // REPORT / MANUSCRIPT / default — preserve the existing gate.
    return isAttributionSentence(s, title, domain);
  }

  const attributed: string[] = [];
  const laneBCandidates: string[] = [];
  for (const s of sentences) {
    const key = normalize(s);
    if (exemptKeys.has(key)) continue;
    // PR-I: attribution-by-link sentences are NOT routed through the
    // ANALYSIS attribution gate (which requires an explicit verb). They
    // get their own flagging path below.
    if (artifactMode === "ANALYSIS" && attributionByLinkSentences.has(key)) continue;
    // PR-J: ANALYSIS quote+commentary sentences whose quoted spans all
    // verified are exempt from Lane A / Lane B classification — they
    // already have their LANE_A_PASS_QUOTED_COMMENTARY entry above.
    if (artifactMode === "ANALYSIS" && quotedCommentaryPassed.has(key)) continue;
    if (isAttributionForMode(s)) {
      attributed.push(s);
    } else if (isLaneBFactSentence(s)) {
      laneBCandidates.push(s);
    }
  }

  // ── PR-I: attribution-by-link rule (ANALYSIS only) ──────────────────
  // Sentences that aren't classified Lane A by the deterministic gate but
  // still read as attribution-via-link (inline link + quantitative or
  // editorial assertion + no attribution verb) are flagged when the
  // assertion is not in the source. This catches sentences 69 and 75 from
  // the spec.
  if (artifactMode === "ANALYSIS") {
    for (const s of sentences) {
      const key = normalize(s);
      if (!attributionByLinkSentences.has(key)) continue;
      if (exemptKeys.has(key)) continue;
      // If the deterministic Lane A gate already picked this up, leave it.
      if (attributed.includes(s)) continue;
      // Source-text check: take the assertion (sentence minus the link
      // markdown) and look for any meaningful overlap with the source.
      const assertion = s.replace(/\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/g, " ").trim();
      // Coarse support check — strip the link, take the longest word run
      // (8+ chars, no inline markdown), and look for it in the source.
      const tokens = assertion
        .split(/\s+/)
        .filter(t => t.length >= 6 && /^[A-Za-z][A-Za-z0-9'-]*$/.test(t))
        .slice(0, 6)
        .join(" ");
      const supportsAssertion = tokens.length >= 8 && normalizedContains(sourceText, tokens);
      if (!supportsAssertion) {
        unsupported.push({
          sentence: s,
          lane:     "source-attributed",
          reason:   "attribution-by-link: inline source link + assertion not in source (no attribution verb)",
        });
        addEntry(
          entries,
          sentenceIndex.get(key) ?? -1,
          s,
          "LANE_A_FAIL",
          "attribution-by-link: inline source link + quantitative/editorial assertion not in source (no attribution verb)",
          "Rephrase as your own projection (drop the source link) or add a direct attribution verb that the source supports.",
        );
        failedLaneA.add(key);
      }
    }
  }

  // ── 3. Lane A: stats inside attribution sentences must be in source ─
  const statSentences = new Set<string>();
  for (const sent of attributed) {
    const stats = sent.match(STAT_RX) ?? [];
    if (stats.length === 0) continue;
    let sentOk = true;
    const idx = sentenceIndex.get(normalize(sent)) ?? -1;
    for (const stat of stats) {
      if (!normalizedContains(sourceText, stat)) {
        unsupported.push({
          sentence: sent,
          lane:     "source-attributed",
          reason:   `statistic "${stat}" not in source`,
        });
        addEntry(
          entries,
          idx,
          sent,
          "LANE_A_FAIL",
          `statistic "${stat}" not in source`,
          "Remove the attributed statistic or rewrite it with an external citation outside the source attribution.",
        );
        failedLaneA.add(normalize(sent));
        sentOk = false;
      }
    }
    if (sentOk) {
      supportedCount += 1;
      statSentences.add(sent);
    }
  }

  // ── 4. Lane A: embedded-external (NCITE pattern) ─────────────────────
  // For every attribution sentence, pull out appositive phrases and check
  // whether the appositive content appears in the source text. If it
  // doesn't, this is the highest-severity flag: a Lane B external fact
  // dressed as Lane A reporting.
  for (const sent of attributed) {
    const appositives = sent.match(APPOSITIVE_RX) ?? [];
    for (const appRaw of appositives) {
      // Strip the bounding punctuation and article so we compare only the
      // substantive phrase.
      const app = appRaw
        .replace(/^[,(]\s*/, "")
        .replace(/[,)]\s*$/, "")
        .replace(/^(an?|the)\s+/i, "")
        .trim();
      if (app.length < 15) continue;
      if (normalizedContains(sourceText, app)) continue;
      // Partial match: check the head noun phrase (first 6 words).
      const head = app.split(/\s+/).slice(0, 6).join(" ");
      if (head.length >= 10 && normalizedContains(sourceText, head)) continue;
      unsupported.push({
        sentence: sent,
        lane:     "embedded-external-in-attribution",
        reason:   `appositive "${app.slice(0, 140)}" not in source — Lane B fact embedded in Lane A sentence`,
      });
      addEntry(
        entries,
        sentenceIndex.get(normalize(sent)) ?? -1,
        sent,
        "NCITE_PATTERN_HIT",
        `appositive "${app.slice(0, 140)}" not in source — Lane B fact embedded in Lane A sentence`,
        "Move the external detail into a separately cited Lane B sentence, or drop it.",
      );
      failedEmbedded.add(normalize(sent));
      // One flag per sentence is enough.
      break;
    }
  }

  // ── 5. Lane B: external facts must carry a citation ──────────────────
  for (const sent of laneBCandidates) {
    const idx = sentenceIndex.get(normalize(sent)) ?? -1;
    const para = paragraphFor(sent, draftText);
    if (MD_LINK_RX.test(sent) || MD_LINK_RX.test(para)) {
      externalCitedCount += 1;
      addEntry(entries, idx, sent, "LANE_B_OK", "external fact has an inline citation");
    } else {
      unsupported.push({
        sentence: sent,
        lane:     "external-uncited",
        reason:   "external fact (number / named study) without a citation link",
      });
      addEntry(
        entries,
        idx,
        sent,
        "LANE_B_BARE",
        "external fact (number / named study) without a citation link",
        "Add an inline markdown citation in this sentence/paragraph or drop the fact.",
      );
    }
    handledLaneB.add(normalize(sent));
  }

  // ── 6. Remaining attributed sentences → LLM paraphrase judgement ────
  const llmCandidates = attributed.filter(s => !statSentences.has(s));
  const hasUnresolvedLaneA = llmCandidates.length > 0;

  // Tracks whether the LLM judge failed in a way that left Lane A claims
  // unjudged. When this is non-null and we have unresolved Lane A
  // candidates, every still-unjudged sentence becomes LANE_A_UNVERIFIABLE
  // (fail-closed) — unless VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true, which
  // is a per-deploy operator escape hatch (see header).
  let judgeOutage: { reason: UnverifiableReason; model?: string } | null = null;
  const judgeModel = getModel("claim-verification");

  if (hasUnresolvedLaneA && !opts.skipLLM) {
    const capped = llmCandidates.slice(0, 30);

    try {
      const judge: LLMJudgeClient = opts.judgeClient ?? (postChatCompletions as unknown as LLMJudgeClient);
      const res = await judge({
        model: judgeModel,
        messages: [
          {
            role: "system",
            content:
              "You are a strict fact-verification assistant. For each claim, answer SUPPORTED if the source text contains the claim verbatim or as a clear paraphrase, or UNSUPPORTED with a one-line reason. Do not use outside knowledge. If the source text does not contain the claim, it is UNSUPPORTED. JSON only, no prose.",
          },
          {
            role: "user",
            content:
              "SOURCE TEXT:\n" + sourceText.slice(0, 12000) +
              "\n\nCLAIMS (numbered):\n" +
              capped.map((c, i) => `${i + 1}. ${c}`).join("\n") +
              "\n\nReturn JSON of the form:\n" +
              `{"verdicts":[{"index":1,"status":"SUPPORTED"|"UNSUPPORTED","reason":"..."}]}`,
          },
        ],
        max_tokens: 1200,
        temperature: 0,
      }, AbortSignal.timeout(45000), "claim-verification");

      if (!res.ok) {
        // Non-2xx — judge unreachable for this draft. Mark every
        // unresolved Lane A sentence LANE_A_UNVERIFIABLE downstream.
        judgeOutage = { reason: "judge_unreachable", model: judgeModel };
        console.warn(`[ClaimVerifier] LLM call failed (http ${res.status}); marking ${capped.length} Lane A sentence(s) as LANE_A_UNVERIFIABLE`);
      } else {
        const data = await res.json();
        const raw: string = data?.choices?.[0]?.message?.content ?? "";
        const parsed = safeParseLLMJson(raw, "ClaimVerifier.verdicts") as
          | { verdicts?: Array<{ index: number; status: string; reason?: string }> }
          | null;
        if (parsed?.verdicts && Array.isArray(parsed.verdicts)) {
          for (const v of parsed.verdicts) {
            const idx = v.index - 1;
            if (idx < 0 || idx >= capped.length) continue;
            const sentence = capped[idx];
            const key = normalize(sentence);
            if ((v.status ?? "").toUpperCase() === "UNSUPPORTED") {
              unsupported.push({
                sentence,
                lane:     "source-attributed",
                reason:   v.reason ?? "unsupported by source",
              });
              addEntry(
                entries,
                sentenceIndex.get(key) ?? -1,
                sentence,
                "LANE_A_FAIL",
                v.reason ?? "unsupported by source",
                "Rewrite this attribution so it only says what the source text supports.",
              );
              failedLaneA.add(key);
            } else {
              supportedCount += 1;
              okLaneA.add(key);
            }
          }
        } else {
          // Judge returned 2xx but the JSON was malformed — same blast
          // radius as a transport failure: we have no verdicts. Treat
          // remaining sentences as unverifiable rather than silently OK.
          judgeOutage = { reason: "judge_parse_error", model: judgeModel };
          console.warn(`[ClaimVerifier] LLM verdict JSON malformed; marking ${capped.length} Lane A sentence(s) as LANE_A_UNVERIFIABLE`);
        }
      }
    } catch (e: any) {
      // Network error, abort timeout, exception inside the call. Mark
      // unresolved Lane A as unverifiable.
      const isTimeout = /aborted|timed? ?out/i.test(String(e?.message ?? ""));
      judgeOutage = {
        reason: isTimeout ? "judge_timeout" : "judge_unreachable",
        model: judgeModel,
      };
      console.warn(`[ClaimVerifier] LLM error ${e?.message ?? e}; marking ${capped.length} Lane A sentence(s) as LANE_A_UNVERIFIABLE`);
    }
  }

  // If the judge outage flagged the run, every unresolved Lane A sentence
  // becomes LANE_A_UNVERIFIABLE. The deterministic checks above already
  // marked any failed-deterministically Lane A as LANE_A_FAIL — those win
  // over unverifiable.
  let unverifiableCount = 0;
  if (judgeOutage) {
    for (const sent of llmCandidates) {
      const key = normalize(sent);
      if (failedLaneA.has(key) || failedEmbedded.has(key) || okLaneA.has(key)) continue;
      addEntry(
        entries,
        sentenceIndex.get(key) ?? -1,
        sent,
        "LANE_A_UNVERIFIABLE",
        `judge ${judgeOutage.reason}: model="${judgeOutage.model ?? "(unknown)"}"`,
        "Cannot verify against source until the judge model is reachable. Re-run the verifier or hold the draft for manual review.",
      );
      unsupported.push({
        sentence: sent,
        lane: "unverifiable",
        reason: `judge ${judgeOutage.reason}`,
      });
      // One log line per unverifiable sentence so operators can find them
      // by grepping.
      console.warn(
        `[CLAIM_VERIFIER] judge_unreachable reason=${judgeOutage.reason} model=${judgeOutage.model ?? "(unknown)"} snippet=${snippetFor(sent).slice(0, 120)}`,
      );
      unverifiableCount += 1;
    }
  }

  // Deterministic-only path (tests) or successful LLM: mark remaining Lane A
  // as OK for operator visibility when no deterministic check already failed
  // AND the run wasn't a judge outage.
  for (const sent of attributed) {
    const key = normalize(sent);
    if (failedLaneA.has(key) || failedEmbedded.has(key)) continue;
    if (judgeOutage && llmCandidates.includes(sent) && !okLaneA.has(key)) continue;
    if (okLaneA.has(key) || statSentences.has(sent) || opts.skipLLM || !hasUnresolvedLaneA) {
      addEntry(entries, sentenceIndex.get(key) ?? -1, sent, "LANE_A_OK", "source-attributed claim passed deterministic/available checks");
      okLaneA.add(key);
    }
  }

  // Include pure retracted sentences that were otherwise not Lane B/A in the
  // unsupported list/report only once; retracted hits are already entries.
  void handledLaneB;
  void retractedSentences;

  // PR-I: compute pre-/post-branch flagged counts for telemetry. Pre is
  // "what REPORT-mode rules would have flagged on this same draft + source"
  // — simulate by counting the deterministic Lane A / Lane B candidates
  // that would have been picked up if we had not applied the exemptions.
  // Post is the actual flagged count emitted in `entries`.
  if (artifactMode === "ANALYSIS") {
    const FAIL_CLASS = new Set(["LANE_A_FAIL", "LANE_B_BARE", "NCITE_PATTERN_HIT", "RETRACTED_HIT"]);
    exemptionCounters.postBranchFlagged = entries.filter(e => FAIL_CLASS.has(e.classification)).length;
    // Pre-branch: would-have-flagged count if no exemptions applied. We
    // approximate by counting Lane A attribution candidates that would
    // have failed source check, plus Lane B candidates that would have
    // been bare (no inline markdown link in sentence/paragraph). The
    // approximation is fine for telemetry: it captures the directional
    // delta the mode is creating.
    let preFlag = 0;
    for (const s of sentences) {
      if (isAttributionSentence(s, title, domain)) preFlag += 1;
      else if (isLaneBFactSentence(s)) {
        const para = paragraphFor(s, draftText);
        if (!MD_LINK_RX.test(s) && !MD_LINK_RX.test(para)) preFlag += 1;
      }
    }
    exemptionCounters.preBranchFlagged = preFlag;
  }

  console.log(
    `[ClaimVerifier] artifactMode=${artifactMode} laneAFail=${entries.filter(e => e.classification === "LANE_A_FAIL").length} ` +
    `laneBBare=${entries.filter(e => e.classification === "LANE_B_BARE").length} ` +
    `analysisExemptions sectionHeader=${exemptionCounters.sectionHeader} ` +
    `forwardProjection=${exemptionCounters.forwardProjection} ` +
    `authorVoice=${exemptionCounters.authorVoice} ` +
    `openerHook=${exemptionCounters.openerHook} ` +
    `pre=${exemptionCounters.preBranchFlagged} post=${exemptionCounters.postBranchFlagged}`,
  );

  return finalizeVerdict({
    unsupported,
    supportedCount,
    externalCitedCount,
    entries,
    artifactMode,
    modeExemptions: exemptionCounters,
    judgeOutage: judgeOutage
      ? {
          affectedSentences: unverifiableCount,
          reason: judgeOutage.reason,
          model: judgeOutage.model,
          failOpenOverride: false, // finalizeVerdict flips this when env says so
        }
      : undefined,
  });
}
