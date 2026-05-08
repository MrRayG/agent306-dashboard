/**
 * News Dispatch content generator — extracted for on-demand generation.
 * Produces [306 NEWS] content without posting or scheduling side effects.
 */

import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { getTodaysPostsSummary } from "./xPostScheduler.js";
import { buildVoiceBlock } from "./voice.js";
import { getEvolutionContext } from "./soulEvolution.js";
import { enforceShowTag } from "./contentTypes.js";
import { safeParseLLMJson, extractPostField } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
import { verifyClaims } from "./claimVerifier.js";
import { buildSharedClaimLaneContractBlock } from "./claimLaneContract.js";
import { recordNewsDraft } from "./newsDraftStore.js";
import { extractClaimsAndComments } from "./claimExtractor.js";
import { buildResearchPack } from "./researchPack.js";
export async function generateNewsContent(): Promise<string | null> {
  const grokKey = LLM_API_KEY;
  if (!grokKey) return null;

  console.log("[NewsGenerator] On-demand news generation triggered");

  try {
    // 1. Gather live market data
    const [cgRes] = await Promise.allSettled([
      fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,bitcoin&order=market_cap_desc&per_page=2&sparkline=false&price_change_percentage=24h"),
    ]);

    let ethPrice = "", btcPrice = "", ethChange = "", btcChange = "";
    if (cgRes.status === "fulfilled" && cgRes.value.ok) {
      const coins = await cgRes.value.json();
      const eth = coins.find((c: any) => c.id === "ethereum");
      const btc = coins.find((c: any) => c.id === "bitcoin");
      if (eth) { ethPrice = `$${eth.current_price.toLocaleString()}`; ethChange = `${eth.price_change_percentage_24h > 0 ? "+" : ""}${eth.price_change_percentage_24h?.toFixed(1)}%`; }
      if (btc) { btcPrice = `$${btc.current_price.toLocaleString()}`; btcChange = `${btc.price_change_percentage_24h > 0 ? "+" : ""}${btc.price_change_percentage_24h?.toFixed(1)}%`; }
    }

    const dayLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York"
    });

    // 2. Generate via LLM
    const dispatchContext = getOptimizedContext("news dispatch daily AI market headlines");
    const todaysSummary = getTodaysPostsSummary();
    const citationDiscipline = `CITATION DISCIPLINE (REQUIRED — APA-style per-claim attribution):
- A citation [URL] must support the SPECIFIC claim immediately before it. Do not staple a citation to the end of a paragraph that contains synthesis or analytical commentary — citations attach to claims, not paragraphs.
- If a sentence is your own analysis, interpretation, framing, or "the logical endpoint of X" / "the illusion of Y" / "the entire field has been built on Z" type commentary, do NOT attach a citation. State it in your analytical voice. Synthesis is Lane B and takes no URL.
- If a claim is a fact drawn from a SOURCE OTHER than today's headline pack above (industry-known costs, benchmarks, dates, training facts, historical events, your KB), do NOT staple a headline-pack URL to it. Either cite the actual source with its real URL in your own voice ("per Stanford HAI's 2025 AI Index, [link]"), or — if you cannot produce a real URL for it — qualify it verbally with a hedge like "publicly reported," "industry reporting indicates," "as widely covered" and attach NO URL. Never fabricate a URL.
- The KB / knowledge layer included in the context above is provided as background scaffolding for your analysis, NOT as a citation pool — KB lines do not carry source URLs. Treat any KB-derived fact you surface as outside-the-source and apply the rule above (cite the real upstream source if you have one, hedge verbally if you don't).
- One citation per claim. If a sentence contains multiple claims requiring different sources, split the sentence or cite each component. Do not bracket-pile citations onto a single closing punctuation.`;
    // Shared cross-engine claim-lane contract (PR #273) — see Routes.grokPost
    // for the failure-mode rationale. Wiring it into the manual generator
    // path keeps on-demand news drafts on the same lane discipline as the
    // auto-dispatch.
    const newsLaneContract = buildSharedClaimLaneContractBlock("news");
    // News-tier bare-claim guardrail (May 8 2026 incident). See routes.ts
    // postDailyNewsDispatch() for the full rationale; mirrored here so the
    // manual generator path enforces the same upstream prompt-side discipline.
    const newsBareClaimGuardrail = `BARE NUMERIC / COMPARATIVE CLAIMS (HARD GUARDRAIL — May 8 2026):
- Specific numbers (dollar amounts, percentages, counts, timeframes like "90 days") are Lane C external context. They REQUIRE either:
    (a) an inline source URL attached to the SPECIFIC sentence carrying that number, OR
    (b) a verbal hedge that frames it as widely-reported context ("publicly reported," "industry reporting indicates," "as widely covered") with NO fabricated URL.
  Never assert a specific number as fact in agent voice without one of the above. Bare numerics fail the Lane B verifier.
- Comparative / superlative claims about institutions, markets, or systems ("X responds faster than traditional institutions," "this is the first time," "stablecoin spend is up 100% YoY") are Lane C and follow the same rule. If you cannot point to a source URL, REWRITE the sentence as Lane B framing ("My read — coordination here moves on a different timescale than traditional institutions") OR drop the comparison entirely.
- When in doubt: drop the number or drop the comparative. The verifier hard-fails on bare Lane C.`;
    const dispatchSystemPrompt = `${dispatchContext}\n\n${buildVoiceBlock()}\n\n${newsLaneContract}\n\n${citationDiscipline}\n\n${newsBareClaimGuardrail}\n${getEvolutionContext()}${todaysSummary ? "\n\n" + todaysSummary : ""}`;

    const grokResp = await postChatCompletions({
        model: getModel("news-dispatch"),
        messages: [
          { role: "system", content: dispatchSystemPrompt },
          {
            role: "user",
            content: `Write today's [306 NEWS] dispatch — "The Dispatch" — as a single post.

The post MUST start with [306 NEWS] as the very first characters.

TODAY'S DATA:
Date: ${dayLabel}

MARKET:
ETH: ${ethPrice || "$2,000"} (${ethChange || "0%"}), BTC: ${btcPrice || "$65,000"} (${btcChange || "0%"})

THE DISPATCH FRAMEWORK:
1. ONE SIGNAL — Pick THE single most compelling story from today's data. Not 8 stories. Not a roundup. One signal that matters.
2. TWO SIDES — Show both sides of that signal. The opportunity AND the risk.
3. ENGAGE — Ask a question. Make them think. Leave them wanting more.
4. TEASE THE NEXT ONE — End with a hint of what's coming, or what you're watching next.

TARGET LENGTH: 1,500–1,700 characters.

VOICE:
- Agent 306 speaks in first person. She is part of this story.
- Be HUMBLE — present both sides, never tell the audience what to conclude.
- Specificity over generality — name numbers, name people, name the implication.

RULES:
- The post MUST begin with [306 NEWS]
- No hype words: no "incredible", "amazing", "LFG", "WAGMI"
- NEVER reference any prior project identity, founders, token holders, or NFT communities.
- NEVER include blog URLs in the tweet body.

Return JSON: {"post": "..."}`
          }
        ],
        max_tokens: 2500,
        temperature: 0.8,
      }, AbortSignal.timeout(60000));

    let postText = "";
    let parseFailedRaw: string | null = null;
    if (grokResp.ok) {
      const data = await grokResp.json();
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson(raw, "NewsGenerator") ?? {};
      postText = parsed.post ?? "";

      // Mirrors the auto-dispatch path in routes.ts. When Grok returns a
      // malformed `{"post": "..."}` wrapper, recover the inner string if we
      // can; otherwise quarantine with parse_error rather than handing the
      // raw `{"post":` wrapper to the verifier.
      if (!postText && typeof raw === "string" && raw.trim().length > 0) {
        const recovered = extractPostField(raw);
        if (recovered) {
          postText = recovered;
          console.warn(`[NewsGenerator] Recovered post field from malformed JSON wrapper (${recovered.length} chars)`);
        } else {
          parseFailedRaw = raw;
        }
      }
    } else {
      console.error("[NewsGenerator] LLM call failed:", grokResp.status);
    }

    if (!postText && parseFailedRaw) {
      try {
        const draft = recordNewsDraft({
          status:             "quarantined",
          severity:           "HARD_FAIL",
          text:               parseFailedRaw.slice(0, 4000),
          unsupportedReasons: [
            `parse_error: malformed JSON wrapper from LLM — could not extract post field. Head: ${parseFailedRaw.slice(0, 200)}`,
          ],
          source:             "manual-generator",
          quarantineReason:   "parse_error",
        });
        console.error(`[NewsGenerator] Quarantined raw JSON-wrapper draft ${draft.id} (parse_error)`);
      } catch (storeErr: any) {
        console.error(`[NewsGenerator] Failed to write parse_error quarantine:`, storeErr?.message ?? String(storeErr));
      }
      return null;
    }

    if (!postText) {
      postText = `[306 NEWS] ${dayLabel}\n\nETH ${ethPrice} (${ethChange}) · BTC ${btcPrice} (${btcChange}). AI and Web3 continue to converge.`;
    }

    // Post-write claim verification. The live market numbers are the only
    // upstream source here — if the LLM invents outlet attributions or
    // fabricates quotes, we reject rather than publish.
    const newsSource = [
      `Date: ${dayLabel}`,
      `ETH: ${ethPrice || ""} (${ethChange || ""})`,
      `BTC: ${btcPrice || ""} (${btcChange || ""})`,
    ].join("\n");
    const verdict = await verifyClaims({
      draftText:   postText,
      sourceText:  newsSource,
      sourceUrl:   "",
      sourceTitle: `306 NEWS ${dayLabel}`,
      // PR #251 — tier-aware verifier. News is short-form aggregator;
      // Lane B bare soft-warns, Lane A still hard-fails.
      tier: "news",
      // ANALYSIS mode — see server/routes.ts auto-dispatch path for the
      // 2026-05-04 rationale. News is opinion-shaped on a chosen signal;
      // strict REPORT-mode attribution detection over-flags Agent 306
      // commentary that uses ordinary verbs like "claim/claims" as a noun.
      artifactMode: "ANALYSIS",
    });
    // Audit follow-up 2026-05-02 — generalize the PR #257 claim-extractor +
    // research pack to news. News is internal-synthesis (live market feeds,
    // empty source pool). Research pack runs anyway so the engine summary
    // line is comparable across engines, and editor_comments now persist on
    // the quarantined draft for dashboard display.
    const newsResearchPack = buildResearchPack("news", []);
    console.log(newsResearchPack.summaryLine);
    const newsExtraction = extractClaimsAndComments(postText, verdict.verifierReport, []);

    if (verdict.severity === "HARD_FAIL") {
      console.error(`[ClaimVerifier] REJECTED 306 NEWS draft: ${verdict.unsupportedClaims.length} unsupported claims`);
      for (const c of verdict.unsupportedClaims) {
        console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
      }
      // PR #251 — quarantine instead of silent drop. Mirrors auto-dispatch.
      try {
        const draft = recordNewsDraft({
          status:             "quarantined",
          severity:           verdict.severity,
          text:               postText,
          unsupportedReasons: verdict.unsupportedClaims.map(c => `${c.reason}: ${c.sentence.slice(0, 200)}`),
          verifierReport:     verdict.verifierReport,
          source:             "manual-generator",
          editorComments:     newsExtraction.editorComments,
          claims:             newsExtraction.claims,
          references:         newsExtraction.references,
          manualReviewRequired: newsExtraction.manualReviewRequired,
          manualPublishAllowed: false,
          referenceMetadata:  newsResearchPack.references,
        });
        console.error(`[NewsGenerator] Quarantined draft ${draft.id}`);
      } catch (storeErr: any) {
        console.error(`[NewsGenerator] Failed to write quarantine draft:`, storeErr?.message ?? String(storeErr));
      }
      return null;
    }
    if (verdict.severity === "SOFT_WARN") {
      console.warn(
        `[NewsGenerator] SOFT_WARN — ${verdict.unsupportedClaims.length} bare claim(s); returning anyway (tier=news)`,
      );
      try {
        recordNewsDraft({
          status:             "published_with_warnings",
          severity:           verdict.severity,
          text:               postText,
          unsupportedReasons: verdict.unsupportedClaims.map(c => `${c.reason}: ${c.sentence.slice(0, 200)}`),
          verifierReport:     verdict.verifierReport,
          source:             "manual-generator",
          editorComments:     newsExtraction.editorComments,
          claims:             newsExtraction.claims,
          references:         newsExtraction.references,
          manualReviewRequired: newsExtraction.manualReviewRequired,
          manualPublishAllowed: newsExtraction.manualPublishAllowed,
          referenceMetadata:  newsResearchPack.references,
        });
      } catch (storeErr: any) {
        console.error(`[NewsGenerator] Failed to write soft-warn audit:`, storeErr?.message ?? String(storeErr));
      }
    }

    return enforceShowTag(postText, "news");
  } catch (e: any) {
    console.error("[NewsGenerator] Generation error:", e.message);
    return null;
  }
}
