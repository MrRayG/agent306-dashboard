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
import { safeParseLLMJson } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
import { verifyClaims } from "./claimVerifier.js";
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
    const dispatchSystemPrompt = `${dispatchContext}\n\n${buildVoiceBlock()}\n\n${citationDiscipline}\n${getEvolutionContext()}${todaysSummary ? "\n\n" + todaysSummary : ""}`;

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
    if (grokResp.ok) {
      const data = await grokResp.json();
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson(raw, "NewsGenerator") ?? {};
      postText = parsed.post ?? "";
      if (!postText && raw.length > 30) postText = raw;
    } else {
      console.error("[NewsGenerator] LLM call failed:", grokResp.status);
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
    });
    if (verdict.severity === "HARD_FAIL") {
      console.error(`[ClaimVerifier] REJECTED 306 NEWS draft: ${verdict.unsupportedClaims.length} unsupported claims`);
      for (const c of verdict.unsupportedClaims) {
        console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
      }
      return null;
    }

    return enforceShowTag(postText, "news");
  } catch (e: any) {
    console.error("[NewsGenerator] Generation error:", e.message);
    return null;
  }
}
