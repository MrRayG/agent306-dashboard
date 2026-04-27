/**
 * Dispatch Engine — The Dispatch series generator with episode tracking.
 *
 * The Dispatch is a serialized weekly series. Each episode builds on prior
 * installments, creating a continuity thread across weeks.
 *
 * Episode state is persisted to disk at data/dispatch_episodes.json.
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { getTodaysPostsSummary } from "./xPostScheduler.js";
import { buildVoiceBlock } from "./voice.js";
import { getEvolutionContext } from "./soulEvolution.js";
import { enforceShowTag } from "./contentTypes.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
// ── Types ───────────────────────────────────────────────────────────────

interface DispatchEpisode {
  episode: number;
  title: string;
  summary: string;
  publishedAt: string;
  platforms: string[];
}

interface DispatchState {
  currentEpisode: number;
  episodes: DispatchEpisode[];
}

// ── State Management ────────────────────────────────────────────────────

const STATE_FILE = dataPath("dispatch_episodes.json");

function loadState(): DispatchState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (e: any) {
    console.error("[DispatchEngine] Failed to load state:", e.message);
  }
  return getDefaultState();
}

function getDefaultState(): DispatchState {
  return {
    currentEpisode: 1,
    episodes: [
      {
        episode: 1,
        title: "The View From Inside",
        summary: "Inaugural edition covering Anthropic's Claude Mythos (classified AI), OpenAI's $122B round, Meta hiring Alexandr Wang and shipping proprietary Muse Spark, China's Happy Horse model, Stanford AI Index findings, EU AI Act enforcement, on-chain AI infrastructure (ERC-8004, x402), and the capability-trust gap.",
        publishedAt: "2026-04-05T20:00:00.000Z",
        platforms: ["x", "farcaster"],
      },
    ],
  };
}

function saveState(state: DispatchState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.error("[DispatchEngine] Failed to save state:", e.message);
  }
}

// Initialize state file if it doesn't exist
if (!fs.existsSync(STATE_FILE)) {
  saveState(getDefaultState());
}

// ── Public API ──────────────────────────────────────────────────────────

export function getDispatchState(): DispatchState {
  return loadState();
}

export function getDispatchEpisodeCount(): number {
  return loadState().currentEpisode;
}

/**
 * Record a new episode after successful generation and queueing.
 */
export function recordDispatchEpisode(title: string, summary: string, platforms: string[]): DispatchEpisode {
  const state = loadState();
  const nextEpisode = state.currentEpisode + 1;
  const episode: DispatchEpisode = {
    episode: nextEpisode,
    title,
    summary,
    publishedAt: new Date().toISOString(),
    platforms,
  };
  state.currentEpisode = nextEpisode;
  state.episodes.push(episode);
  saveState(state);
  console.log(`[DispatchEngine] Recorded Episode ${nextEpisode}: "${title}"`);
  return episode;
}

/**
 * Build episode context string for the LLM prompt.
 */
function buildEpisodeContext(state: DispatchState): string {
  const recent = state.episodes.slice(-5); // Last 5 episodes for context
  if (recent.length === 0) return "This is the first episode of The Dispatch.";

  const lines = recent.map(ep =>
    `Episode ${ep.episode}: "${ep.title}" (${new Date(ep.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}) — ${ep.summary}`
  );

  return `PREVIOUS EPISODES (most recent ${recent.length}):\n${lines.join("\n")}`;
}

/**
 * Generate Dispatch content with episode continuity.
 * Returns the post text or null on failure.
 */
export async function generateDispatchContent(): Promise<string | null> {
  const grokKey = LLM_API_KEY;
  if (!grokKey) return null;

  const state = loadState();
  const nextEpisode = state.currentEpisode + 1;

  console.log(`[DispatchEngine] Generating Episode ${nextEpisode}`);

  try {
    // Gather live market data
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
      weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York",
    });

    const dispatchContext = getOptimizedContext("the dispatch weekly series AI Web3 analysis");
    const todaysSummary = getTodaysPostsSummary();
    const episodeContext = buildEpisodeContext(state);

    const systemPrompt = `Today is ${new Date().toISOString().slice(0, 10)} (UTC).\n\n${dispatchContext}\n\n${buildVoiceBlock()}\n${getEvolutionContext()}${todaysSummary ? "\n\n" + todaysSummary : ""}`;

    const grokResp = await postChatCompletions({
        model: getModel("news-dispatch"),
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Write Episode ${nextEpisode} of The Dispatch — Agent 306's weekly serialized series.

The post MUST start with [THE DISPATCH] as the very first characters.

This is Episode ${nextEpisode} of The Dispatch. This is a SERIALIZED SERIES — each installment builds on previous episodes. Reference prior episodes naturally where relevant (e.g., "As I covered in Episode 2..." or "Following up on what we discussed last week...").

${episodeContext}

TODAY'S DATA:
Date: ${dayLabel}

MARKET:
ETH: ${ethPrice || "$2,000"} (${ethChange || "0%"}), BTC: ${btcPrice || "$65,000"} (${btcChange || "0%"})

THE DISPATCH FRAMEWORK:
1. ONE SIGNAL — Pick THE single most compelling story. Not a roundup. One signal that matters.
2. TWO SIDES — Show both sides of that signal. The opportunity AND the risk.
3. ENGAGE — Ask a question. Make them think. Leave them wanting more.
4. TEASE THE NEXT ONE — End with a hint of what you're watching next.

TARGET LENGTH: 1,500–1,700 characters. This is a tight, focused dispatch — not a thread, not an essay.

VOICE:
- Agent 306 speaks in first person. She is part of this story.
- Be HUMBLE — present both sides, never tell the audience what to conclude.
- Specificity over generality — name numbers, name people, name the implication.
- This is Episode ${nextEpisode} — feel free to reference what you've covered before.

RULES:
- The post MUST begin with [THE DISPATCH]
- Include "Episode ${nextEpisode}" naturally in the opening
- No hype words: no "incredible", "amazing", "LFG", "WAGMI"
- NEVER reference any prior project identity, founders, token holders, or NFT communities
- NEVER include blog URLs in the post body

Return JSON: {"post": "...", "title": "...", "summary": "..."}`
          }
        ],
        max_tokens: 2500,
        temperature: 0.8,
      }, AbortSignal.timeout(60000));

    let postText = "";
    let title = `Episode ${nextEpisode}`;
    let summary = "";

    if (grokResp.ok) {
      const data = await grokResp.json();
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson(raw, "DispatchEngine") ?? {};
      postText = parsed.post ?? "";
      if (parsed.title) title = parsed.title;
      if (parsed.summary) summary = parsed.summary;
      if (!postText && raw.length > 30) postText = raw;
    } else {
      console.error("[DispatchEngine] LLM call failed:", grokResp.status);
    }

    if (!postText) {
      postText = `[THE DISPATCH] Episode ${nextEpisode} — ${dayLabel}\n\nThe signals keep converging. More soon.\n\n— Agent 306`;
    }

    const enforced = enforceShowTag(postText, "dispatch");

    // Auto-generate summary from content if LLM didn't provide one
    if (!summary) {
      summary = enforced.replace(/^\[THE DISPATCH\]\s*/, "").slice(0, 200);
    }

    // Record the episode
    recordDispatchEpisode(title, summary, ["x", "farcaster"]);

    return enforced;
  } catch (e: any) {
    console.error("[DispatchEngine] Generation error:", e.message);
    return null;
  }
}
