// ─────────────────────────────────────────────────────────────────────────────
// 306 — CLAIM VERIFIER
//
// Post-write grounding check for any draft that attributes claims to a
// specific source. Walks the draft for attribution sentences, quoted
// spans, and specific statistics, then checks them against the source
// text. A small LLM call on the frontier-factual tier handles the
// paraphrase judgement; verbatim quotes and statistics are checked
// deterministically before the LLM even sees them.
//
// Motivation: on 2026-04-22 Agent 306's Deep Read cited Politico and
// fabricated "60% success rates", three unnamed AI developers, and a
// quote ("We're not losing the arms race...") that did not appear in
// the source. None of those survive this verifier.
// ─────────────────────────────────────────────────────────────────────────────

import { getModel } from "./modelRouter.js";
import { postChatCompletions } from "./llmCall.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

export interface ClaimVerdict {
  ok: boolean;
  unsupportedClaims: Array<{ sentence: string; reason: string }>;
  supportedCount: number;
}

export interface VerifyClaimsOpts {
  draftText:   string;
  sourceText:  string;
  sourceUrl:   string;
  sourceTitle: string;
  /** Escape hatch for tests: skip the LLM call, use only deterministic checks. */
  skipLLM?:    boolean;
}

// Attribution verbs / phrases that imply the sentence is quoting the source.
const ATTRIBUTION_RX = /\b(reported|reports|reporting|according to|cites?|cited|said|wrote|writes|notes?|noted|quoted|claims?|claimed|argues?|argued|the article|the piece|the report|the investigation|the study|the paper|the analysis)\b/i;

// Specific statistic shapes that MUST appear in sourceText if attributed.
const STAT_RX = /(\d{1,3}(?:\.\d+)?\s*%|\d{4}\s*[–-]\s*\d{4}|\b\d+(?:\.\d+)?[xX]\b)/g;

// Quoted spans — text inside "straight" or "curly" double-quotes.
const QUOTE_RX = /[""]([^""]{8,500})[""]/g;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function splitSentences(text: string): string[] {
  // Simple sentence splitter. Handles ., !, ? as terminators, preserves
  // sentence text including the terminator. Good enough — we don't need
  // linguistic accuracy, we need coverage.
  const cleaned = text.replace(/\n+/g, " ").replace(/\s+/g, " ");
  const parts = cleaned.match(/[^.!?]+[.!?]+/g) ?? [cleaned];
  return parts.map(s => s.trim()).filter(s => s.length > 0);
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

/**
 * Verify that every claim the draft attributes to the source is actually
 * backed by the source text. Returns { ok: false, unsupportedClaims }
 * if ANY attributed claim, quoted span, or attributed statistic fails
 * the check.
 *
 * Quoted spans are checked verbatim (case/whitespace-normalized). Stats
 * and attribution sentences may be paraphrased — for those we fall back
 * to a small LLM call on the frontier-factual tier (grok-4.20-reasoning).
 * When skipLLM is set, only deterministic checks run; sentences that
 * can't be decided deterministically are treated as SUPPORTED to avoid
 * false positives in unit tests.
 */
export async function verifyClaims(opts: VerifyClaimsOpts): Promise<ClaimVerdict> {
  const { draftText, sourceText, sourceUrl, sourceTitle } = opts;
  const unsupported: Array<{ sentence: string; reason: string }> = [];
  let supportedCount = 0;

  if (!draftText) {
    return {
      ok: false,
      unsupportedClaims: [{ sentence: "(no draft)", reason: "missing draft text" }],
      supportedCount: 0,
    };
  }

  // If no source text is provided, the draft is only acceptable if it
  // contains NO external attribution (no "according to X", no quoted spans,
  // no stats in attributed sentences). An all-original post with no source
  // claims is fine; a post that claims "Politico reports 60%" with no
  // sourceText to verify against is rejected.
  if (!sourceText) {
    const hasQuotes = QUOTE_RX.test(draftText);
    QUOTE_RX.lastIndex = 0;
    const sentencesNoSrc = splitSentences(draftText);
    const attributedNoSrc = sentencesNoSrc.some(s => ATTRIBUTION_RX.test(s));
    if (hasQuotes || attributedNoSrc) {
      return {
        ok: false,
        unsupportedClaims: [{
          sentence: "(draft attributes claims but no source text was provided)",
          reason:   "no source to verify against",
        }],
        supportedCount: 0,
      };
    }
    return { ok: true, unsupportedClaims: [], supportedCount: 0 };
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
        reason:   "fabricated quote",
      });
    } else {
      supportedCount += 1;
    }
  }

  // ── 2. Collect attribution sentences ───────────────────────────────
  const domain = sourceDomain(sourceUrl);
  const title = (sourceTitle || "").trim();
  const sentences = splitSentences(draftText);

  const attributed = sentences.filter(s => {
    if (ATTRIBUTION_RX.test(s)) return true;
    if (title && title.length > 6 && s.toLowerCase().includes(title.toLowerCase())) return true;
    if (domain && s.toLowerCase().includes(domain)) return true;
    return false;
  });

  // ── 3. Stats inside attributed sentences must appear in sourceText ──
  const statSentences: string[] = [];
  for (const sent of attributed) {
    const stats = sent.match(STAT_RX) ?? [];
    if (stats.length === 0) continue;
    let sentOk = true;
    for (const stat of stats) {
      if (!normalizedContains(sourceText, stat)) {
        unsupported.push({
          sentence: sent,
          reason:   `statistic "${stat}" not in source`,
        });
        sentOk = false;
      }
    }
    if (sentOk) {
      supportedCount += 1;
      statSentences.push(sent);
    }
  }

  // ── 4. Remaining attributed sentences → LLM paraphrase judgement ────
  const llmCandidates = attributed.filter(s => !statSentences.includes(s));

  if (llmCandidates.length === 0 || opts.skipLLM) {
    return {
      ok: unsupported.length === 0,
      unsupportedClaims: unsupported,
      supportedCount,
    };
  }

  // Cap candidates to keep the LLM prompt bounded. If a draft has more
  // than 30 attributed sentences, sample the first 30 — if any of those
  // are unsupported we reject regardless.
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
      // Fail-open on LLM infra issues — flag as WARN but don't block the
      // draft on a transient outage. Deterministic checks above still
      // catch the Politico-style fabrications.
      console.warn(`[ClaimVerifier] LLM call failed (http ${res.status}); falling back to deterministic-only verdict`);
      return {
        ok: unsupported.length === 0,
        unsupportedClaims: unsupported,
        supportedCount,
      };
    }

    const data = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(raw, "ClaimVerifier.verdicts") as
      | { verdicts?: Array<{ index: number; status: string; reason?: string }> }
      | null;

    if (!parsed?.verdicts || !Array.isArray(parsed.verdicts)) {
      console.warn("[ClaimVerifier] LLM verdict JSON malformed; falling back to deterministic-only verdict");
      return {
        ok: unsupported.length === 0,
        unsupportedClaims: unsupported,
        supportedCount,
      };
    }

    for (const v of parsed.verdicts) {
      const idx = v.index - 1;
      if (idx < 0 || idx >= capped.length) continue;
      if ((v.status ?? "").toUpperCase() === "UNSUPPORTED") {
        unsupported.push({
          sentence: capped[idx],
          reason:   v.reason ?? "unsupported by source",
        });
      } else {
        supportedCount += 1;
      }
    }
  } catch (e: any) {
    console.warn(`[ClaimVerifier] LLM error ${e?.message ?? e}; falling back to deterministic-only verdict`);
  }

  return {
    ok: unsupported.length === 0,
    unsupportedClaims: unsupported,
    supportedCount,
  };
}
