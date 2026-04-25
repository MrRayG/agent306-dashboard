// ─────────────────────────────────────────────────────────────────────────────
// 306 — CLAIM VERIFIER (two-lane)
//
// Post-write grounding check for any draft that attributes claims to a
// specific source. Walks the draft for attribution sentences, quoted
// spans, and specific statistics, then checks them against the source
// text.
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

export type ClaimLane =
  | "source-attributed"
  | "external-uncited"
  | "embedded-external-in-attribution";

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
}

export interface VerifyClaimsOpts {
  draftText:   string;
  sourceText:  string;
  sourceUrl:   string;
  sourceTitle: string;
  /** Escape hatch for tests: skip the LLM call, use only deterministic checks. */
  skipLLM?:    boolean;
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
  /(\d{1,3}(?:[.,]\d+)?\s*%|\$\s*\d+(?:[.,]\d+)?\s*[KMB]?\b|\b\d+(?:\.\d+)?\s*[KMBbps]+\b|\b\d+(?:\.\d+)?[xX]\b|\b(?:19|20)\d{2}\b)/;

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
  const cleaned = text.replace(/\n+/g, " ").replace(/\s+/g, " ");
  const parts = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
  return parts.map(s => s.trim()).filter(s => s.length > 0);
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
  const H = normalize(haystack);
  const N = normalize(needle);
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
  let supportedCount = 0;
  let externalCitedCount = 0;

  if (!draftText) {
    return {
      ok: false,
      unsupportedClaims: [{
        sentence: "(no draft)",
        lane:     "source-attributed",
        reason:   "missing draft text",
      }],
      supportedCount: 0,
      externalCitedCount: 0,
    };
  }

  const domain = sourceDomain(sourceUrl);
  const title  = (sourceTitle || "").trim();

  // If there's no sourceText at all, every attribution is unsupported —
  // and every Lane B fact still needs a citation.
  if (!sourceText) {
    const sentencesNoSrc = splitSentences(draftText);
    for (const s of sentencesNoSrc) {
      if (isAttributionSentence(s, title, domain)) {
        unsupported.push({
          sentence: s,
          lane:     "source-attributed",
          reason:   "no source text provided to verify attribution",
        });
      } else if (isLaneBFactSentence(s)) {
        const para = paragraphFor(s, draftText);
        if (!MD_LINK_RX.test(s) && !MD_LINK_RX.test(para)) {
          unsupported.push({
            sentence: s,
            lane:     "external-uncited",
            reason:   "external fact without a citation link",
          });
        } else {
          externalCitedCount += 1;
        }
      }
    }
    // Source-attributed violations are hard fails. Lane B uncited warnings
    // alone do NOT flip `ok` — the caller decides whether to publish.
    const hasHardFail = unsupported.some(
      u => u.lane === "source-attributed" || u.lane === "embedded-external-in-attribution",
    );
    return {
      ok: !hasHardFail,
      unsupportedClaims: unsupported,
      supportedCount,
      externalCitedCount,
    };
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
      unsupported.push({
        sentence: `"${span}"`,
        lane:     "source-attributed",
        reason:   "fabricated quote",
      });
    } else {
      supportedCount += 1;
    }
  }

  const sentences = splitSentences(draftText);

  // ── 2. Classify every sentence ─────────────────────────────────────
  const attributed: string[] = [];
  const laneBCandidates: string[] = [];
  for (const s of sentences) {
    if (isAttributionSentence(s, title, domain)) {
      attributed.push(s);
    } else if (isLaneBFactSentence(s)) {
      laneBCandidates.push(s);
    }
  }

  // ── 3. Lane A: stats inside attribution sentences must be in source ─
  const statSentences = new Set<string>();
  for (const sent of attributed) {
    const stats = sent.match(STAT_RX) ?? [];
    if (stats.length === 0) continue;
    let sentOk = true;
    for (const stat of stats) {
      if (!normalizedContains(sourceText, stat)) {
        unsupported.push({
          sentence: sent,
          lane:     "source-attributed",
          reason:   `statistic "${stat}" not in source`,
        });
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
    // Don't double-flag sentences already marked unsupported for stats.
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
      // One flag per sentence is enough.
      break;
    }
  }

  // ── 5. Lane B: external facts must carry a citation ──────────────────
  for (const sent of laneBCandidates) {
    const para = paragraphFor(sent, draftText);
    if (MD_LINK_RX.test(sent) || MD_LINK_RX.test(para)) {
      externalCitedCount += 1;
    } else {
      unsupported.push({
        sentence: sent,
        lane:     "external-uncited",
        reason:   "external fact (number / named study) without a citation link",
      });
    }
  }

  // ── 6. Remaining attributed sentences → LLM paraphrase judgement ────
  const llmCandidates = attributed.filter(s => !statSentences.has(s));
  const hasUnresolvedLaneA = llmCandidates.length > 0;

  if (!hasUnresolvedLaneA || opts.skipLLM) {
    const hasHardFail = unsupported.some(
      u => u.lane === "source-attributed" || u.lane === "embedded-external-in-attribution",
    );
    return {
      ok: !hasHardFail,
      unsupportedClaims: unsupported,
      supportedCount,
      externalCitedCount,
    };
  }

  const capped = llmCandidates.slice(0, 30);

  try {
    const res = await postChatCompletions({
      model: getModel("claim-verification"),
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
      console.warn(`[ClaimVerifier] LLM call failed (http ${res.status}); falling back to deterministic-only verdict`);
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
          if ((v.status ?? "").toUpperCase() === "UNSUPPORTED") {
            unsupported.push({
              sentence: capped[idx],
              lane:     "source-attributed",
              reason:   v.reason ?? "unsupported by source",
            });
          } else {
            supportedCount += 1;
          }
        }
      } else {
        console.warn("[ClaimVerifier] LLM verdict JSON malformed; falling back to deterministic-only verdict");
      }
    }
  } catch (e: any) {
    console.warn(`[ClaimVerifier] LLM error ${e?.message ?? e}; falling back to deterministic-only verdict`);
  }

  const hasHardFail = unsupported.some(
    u => u.lane === "source-attributed" || u.lane === "embedded-external-in-attribution",
  );
  return {
    ok: !hasHardFail,
    unsupportedClaims: unsupported,
    supportedCount,
    externalCitedCount,
  };
}
