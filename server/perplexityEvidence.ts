// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — PERPLEXITY EVIDENCE GROUNDING
//
// Fresh web grounding for hypotheses about current events (legislation,
// product launches, trial status) where academic sources (openalex/arxiv/
// crossref) cannot possibly help.
//
// Routes via the modelRouter's live-research tier (perplexity / sonar-pro)
// using the existing postPerplexity() helper — no new router mappings are
// introduced here.
//
// Fails gracefully: missing PERPLEXITY_API_KEY, 401/429/5xx, and network
// errors all return an empty result and log once. Never throws.
// ─────────────────────────────────────────────────────────────────────────────

import { postPerplexity } from "./llmCall.js";

export interface PerplexityGroundingResult {
  content:   string;
  citations: string[];
  ok:        boolean;
  reason?:   string;     // present when ok === false, describes why
}

const EMPTY: PerplexityGroundingResult = { content: "", citations: [], ok: false };

/**
 * Gather fresh web evidence for a hypothesis. The caller supplies a short
 * query string (typically derived from hypothesis.claim / prediction).
 *
 * Behaviour:
 *   - If PERPLEXITY_API_KEY is unset → logs once, returns {ok:false}.
 *   - If the API returns a non-2xx status → logs status + returns {ok:false}.
 *   - If the fetch throws → logs + returns {ok:false}.
 *
 * On success logs:
 *   [DataSources] Perplexity grounding for "<query>": <n> citations, <chars> chars
 */
export async function gatherPerplexityEvidence(
  hypothesisText: string,
  options?: { signal?: AbortSignal; maxTokens?: number },
): Promise<PerplexityGroundingResult> {
  if (!hypothesisText || hypothesisText.trim().length === 0) {
    return { ...EMPTY, reason: "empty query" };
  }

  const key = process.env.PERPLEXITY_API_KEY ?? "";
  if (!key || key.length < 10) {
    console.warn("[DataSources] Perplexity grounding skipped — PERPLEXITY_API_KEY not set");
    return { ...EMPTY, reason: "no api key" };
  }

  const signal = options?.signal ?? AbortSignal.timeout(45000);
  const maxTokens = options?.maxTokens ?? 1200;
  const userPrompt =
    `Find recent, specific evidence (news, official announcements, filings, ` +
    `reports) relevant to this hypothesis. Include dates and sources. ` +
    `Hypothesis: ${hypothesisText.slice(0, 1500)}`;

  let res: Response;
  try {
    res = await postPerplexity({
      task: "evidence-research",
      messages: [
        {
          role: "system",
          content:
            "You are a fact-grounding assistant. Return concise, dated, cited facts " +
            "that either support or contradict the hypothesis. Prioritise primary " +
            "sources. Do not speculate.",
        },
        { role: "user", content: userPrompt },
      ],
      maxTokens,
      temperature: 0.1,
      signal,
    });
  } catch (e: any) {
    console.warn(`[DataSources] Perplexity grounding error: ${e?.message ?? e}`);
    return { ...EMPTY, reason: `exception: ${e?.message ?? "unknown"}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[DataSources] Perplexity grounding HTTP ${res.status} — ${body.slice(0, 160)}`,
    );
    return { ...EMPTY, reason: `http ${res.status}` };
  }

  let data: any;
  try {
    data = await res.json();
  } catch (e: any) {
    console.warn(`[DataSources] Perplexity grounding parse error: ${e?.message ?? e}`);
    return { ...EMPTY, reason: "parse error" };
  }

  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const citationsRaw: unknown = data?.citations ?? data?.choices?.[0]?.message?.citations ?? [];
  const citations: string[] = Array.isArray(citationsRaw)
    ? (citationsRaw as unknown[]).filter((c: unknown): c is string => typeof c === "string")
    : [];

  const preview = hypothesisText.slice(0, 60).replace(/\s+/g, " ");
  console.log(
    `[DataSources] Perplexity grounding for "${preview}": ${citations.length} citations, ${content.length} chars`,
  );

  return {
    content,
    citations,
    ok: content.length > 0,
  };
}
