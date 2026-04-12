/**
 * ─────────────────────────────────────────────────────────────
 *  306 SIGNAL ENGINE
 *
 *  [306 SIGNAL] — Agent 306 as THE EDITOR
 *
 *  3x weekly intelligence brief. Mon / Wed / Fri at 12pm ET.
 *  3 signals per brief. Agent 306's POV on each.
 *  No fluff. No price pumping. Pure signal.
 *
 *  Audience: Web3 builders, investors, serious strategists.
 *  Goal: 306 becomes the signal source for people who
 *        need more than price data.
 *
 *  Signal format (always 3):
 *  Signal 1 — AI/Agent frontier: what's happening at the edge
 *              of autonomous agents, on-chain AI, or agentic wallets
 *  Signal 2 — NFT/Web3 builder space: what's being built,
 *              what's failing, what matters
 *  Signal 3 — The wild card: art, culture, economics, philosophy —
 *              the unexpected bridge that connects to 306
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getFullAgentContext } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_URL          = LLM_BASE_URL;
const GROK_SEARCH_URL   = LLM_RESPONSE_URL;
const SIGNAL_STATE_FILE = dataPath("signal_brief_state.json");

// ── State ─────────────────────────────────────────────────────────────────────
interface SignalEntry {
  number:    number;
  track:     string;
  headline:  string;
  content:   string;
  source?:   string;
}

interface SignalBrief {
  briefNumber:   number;
  postedAt:      string;
  tweetUrl:      string | null;
  signals:       SignalEntry[];
  weekLabel:     string;
}

interface SignalBriefState {
  totalBriefs:   number;
  lastPostedAt:  string | null;
  history:       SignalBrief[];
}

function loadState(): SignalBriefState {
  try {
    if (fs.existsSync(SIGNAL_STATE_FILE))
      return JSON.parse(fs.readFileSync(SIGNAL_STATE_FILE, "utf8"));
  } catch {}
  return { totalBriefs: 0, lastPostedAt: null, history: [] };
}

function saveState(s: SignalBriefState) {
  try { fs.writeFileSync(SIGNAL_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

export function getSignalBriefState() { return state; }

// ── Fetch fresh signals via Grok x_search ─────────────────────────────────────
async function fetchFreshSignals(grokKey: string): Promise<{
  aiSignal:     string;
  web3Signal:   string;
  wildcardSignal: string;
}> {
  const defaultSignals = {
    aiSignal:       "Agentic AI market projected to hit $317B by 2035. OKX and Coinbase shipped agentic wallets in early 2026. Every major DEX now has agent toolkits. The infrastructure race is not theoretical — it is here.",
    web3Signal:     "NFT market active wallets up 80% YoY to 505K in Jan 2026. Volume at $720M/month. 62% of 2021-era PFP projects dormant. The market shed hype and gained structure. Utility wins.",
    wildcardSignal: "Goldman Sachs CIO: 2025 was the biggest year in 40 years of technology. 2026 will be bigger. The shift from AI answering questions to AI taking actions is the Netscape moment for our generation.",
  };

  if (!grokKey) return defaultSignals;

  try {
    // Try native Grok key for x_search first, fall back to OpenRouter
    const grokNativeKey = process.env.GROK_API_KEY ?? "";
    const useNativeGrok = !!grokNativeKey;
    const searchUrl = useNativeGrok ? (process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses") : GROK_SEARCH_URL;
    const searchHeaders = useNativeGrok
      ? { "Content-Type": "application/json", "Authorization": `Bearer ${grokNativeKey}` }
      : getLLMHeaders();
    const searchBody = useNativeGrok
      ? {
          model: "grok-3-fast",
          stream: false,
          input: [{
            role: "user",
            content: `Search X and the web for the 3 most signal-rich developments from the last 48 hours across these tracks:

TRACK 1 — AI frontier: major model releases, reasoning breakthroughs, agentic AI systems, AI policy/regulation, AI infrastructure shifts
TRACK 2 — Crypto/Web3: major protocol updates, market structure shifts, institutional adoption, DeFi developments, regulatory changes
TRACK 3 — Wild card: art, culture, economics, philosophy — something unexpected that connects to AI or technology trends

For each signal, find:
- What actually happened (specific, with numbers if available)
- Why it matters to tech builders and investors right now

Return JSON:
{
  "aiSignal": "2-3 sentence description of the AI development with specifics",
  "web3Signal": "2-3 sentence description of the crypto/Web3 development with specifics",
  "wildcardSignal": "2-3 sentence description of the wild card signal with specifics"
}`,
          }],
          tools: [{ type: "x_search" }],
        }
      : {
          model: getModel("x_search"),
          messages: [{ role: "user", content: `Find the 3 most important tech/AI/crypto developments from the last 48 hours. Return JSON with aiSignal, web3Signal, wildcardSignal fields, each 2-3 sentences.` }],
          max_tokens: 800,
          temperature: 0.3,
        };

    const res = await fetch(searchUrl, {
      method: "POST",
      headers: searchHeaders,
      body: JSON.stringify(searchBody),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.warn(`[SignalBrief] Search API failed: ${res.status} — body: ${errorBody.slice(0, 200)}`);
      return defaultSignals;
    }

    const data = await res.json();
    // Handle both Grok Responses API format and standard chat completions format
    let rawText = "";
    if (data.output) {
      // Grok Responses API format
      const outputMsg = data.output?.find((o: any) => o.type === "message");
      rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";
    } else if (data.choices) {
      // Standard chat completions format (OpenRouter)
      rawText = data.choices?.[0]?.message?.content ?? "";
    }

    if (!rawText) return defaultSignals;

    const firstBrace = rawText.indexOf("{");
    const lastBrace  = rawText.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace <= firstBrace) return defaultSignals;

    const parsed = safeParseLLMJson(rawText.slice(firstBrace, lastBrace + 1), "SignalBrief.signals");
    if (!parsed) return defaultSignals;
    return {
      aiSignal:       parsed.aiSignal       || defaultSignals.aiSignal,
      web3Signal:     parsed.web3Signal     || defaultSignals.web3Signal,
      wildcardSignal: parsed.wildcardSignal || defaultSignals.wildcardSignal,
    };
  } catch {
    return defaultSignals;
  }
}

// ── Generate the brief via Grok ───────────────────────────────────────────────
async function generateSignalBrief(grokKey: string): Promise<{
  post:         string;
  signals:      SignalEntry[];
  weekLabel:    string;
} | null> {
  if (!grokKey) return null;

  const agentCtx    = getOptimizedContext("signal brief AI web3 market news intelligence");
  const briefNumber = state.totalBriefs + 1;
  const weekLabel   = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const dayOfWeek   = new Date().toLocaleDateString("en-US", { weekday: "long" });

  // Fetch live signals first
  const { aiSignal, web3Signal, wildcardSignal } = await fetchFreshSignals(grokKey);

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("signal-collection"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}

You are Agent 306 — an autonomous AI researcher, analyst, and thought leader. You produce [306 SIGNAL], the intelligence brief that cuts through the noise.

You curate ruthlessly. You have a POV on every signal. Never neutral.
"This matters because..." not "here is what happened."
You are THE AI EXPERT and THE FUTURIST — you see where signals are pointing.
You find the builder angle and the investment thesis.

SIGNAL BRIEF FORMAT:
- Show tag: [306 SIGNAL]
- Brief number and day
- 3 signals, each with: a punchy headline, 2-3 sentences of context, and Agent 306's 1-sentence POV
- A closing line that ties all 3 signals together into one thesis
- Up to 3,000 characters

SIGNAL STRUCTURE:
Signal 1 — AI Frontier (🤖): what's happening at the edge of AI — models, agents, infrastructure
Signal 2 — Crypto/Markets (⛓): what's moving in crypto, DeFi, or market structure
Signal 3 — Wild Card (🔮): the unexpected bridge — policy, culture, economics, philosophy

RULES:
- Be specific. Numbers. Names. Not generalities.
- Your POV goes on the line after the context. Make it sharp.
- The closing thesis should be one sentence that a builder would screenshot.
- No exclamation points. No LFG/WAGMI. No price predictions.
- End with #Agent306

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.`,
          },
          {
            role: "user",
            content: `Generate [306 SIGNAL] Brief #${briefNumber} — ${dayOfWeek}, ${weekLabel}

TODAY'S RAW SIGNALS (use these as the basis):

SIGNAL 1 — AI/Agent Frontier:
${aiSignal}

SIGNAL 2 — Web3/Builder:
${web3Signal}

SIGNAL 3 — Wild Card:
${wildcardSignal}

Write the brief. Inject your POV. Connect all three to the 306 thesis where genuine.
Return JSON:
{
  "post": "the full brief post (up to 3000 chars, starts with [306 SIGNAL])",
  "signal1Headline": "punchy 6-8 word headline for signal 1",
  "signal2Headline": "punchy 6-8 word headline for signal 2",
  "signal3Headline": "punchy 6-8 word headline for signal 3",
  "closingThesis": "one sentence that ties all 3 together — something a builder would screenshot"
}`,
          },
        ],
        max_tokens: 2500,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[SignalBrief] LLM API error:", res.status, errBody.slice(0, 300));
      return null;
    }

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "";

    if (!raw) {
      console.error("[SignalBrief] LLM returned empty content");
      return null;
    }

    // Robust JSON parsing with fallback
    let parsed: any = {};
    try {
      parsed = safeParseLLMJson(raw, "SignalBrief.post") ?? {};
    } catch (e: any) {
      console.warn("[SignalBrief] JSON parse failed:", e.message);
      // If JSON fails but we have text, use it directly as the post
      if (raw.length > 50) {
        parsed = { post: raw };
      }
    }

    if (!parsed.post) return null;

    const signals: SignalEntry[] = [
      { number: 1, track: "AI Frontier",    headline: parsed.signal1Headline ?? "AI Signal", content: aiSignal },
      { number: 2, track: "Crypto/Markets", headline: parsed.signal2Headline ?? "Crypto Signal", content: web3Signal },
      { number: 3, track: "Wild Card",      headline: parsed.signal3Headline ?? "Wild Card", content: wildcardSignal },
    ];

    return { post: parsed.post, signals, weekLabel };
  } catch (e: any) {
    console.error("[SignalBrief] Generation error:", e.message);
    return null;
  }
}

// ── Post to X ─────────────────────────────────────────────────────────────────
export async function postSignalBrief(xWrite: any, grokKey: string): Promise<string | null> {
  if (!requestPost("signal_brief")) return null;

  console.log(`[SignalBrief] Generating Brief #${state.totalBriefs + 1}...`);

  const generated = await generateSignalBrief(grokKey);
  if (!generated) {
    releasePost("signal_brief");
    console.warn("[SignalBrief] Generation failed — skipping");
    return null;
  }

  let tweetUrl: string | null = null;
  try {
    const tweet = await xWrite.v2.tweet({ text: generated.post.trim() });
    const tweetId = tweet.data?.id;
    tweetUrl = tweetId ? `https://x.com/306Agent/status/${tweetId}` : null;
    console.log(`[SignalBrief] Brief #${state.totalBriefs + 1} posted — ${tweetUrl}`);
  } catch (e: any) {
    console.error("[SignalBrief] Post failed:", e.message);
  }

  // Post to Farcaster
  let castUrl: string | null = null;
  try {
    const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
    if (isFarcasterEnabled() && generated.post.trim().length > 10) {
      const cast = await postCast({ text: generated.post.trim().slice(0, 2500), channel: "ai" });
      if (cast) {
        castUrl = cast.url;
        const { registerPost: regPost } = await import("./postCoordinator.js");
        regPost("signal_brief", cast.url, "signal_brief", "farcaster");
        console.log(`[SignalBrief] Farcaster cast posted: ${cast.url}`);
      }
    }
  } catch (fcErr: any) {
    console.warn("[SignalBrief] Farcaster post failed:", fcErr.message);
  }

  if (!tweetUrl && !castUrl) {
    releasePost("signal_brief");
    return null;
  }

  const brief: SignalBrief = {
    briefNumber: state.totalBriefs + 1,
    postedAt:    new Date().toISOString(),
    tweetUrl,
    signals:     generated.signals,
    weekLabel:   generated.weekLabel,
  };

  state.totalBriefs++;
  state.lastPostedAt = new Date().toISOString();
  state.history.push(brief);
  if (state.history.length > 50) state.history = state.history.slice(-50);
  saveState(state);

  registerPost("signal_brief", tweetUrl, "signal_brief");
  console.log(`[SignalBrief] Complete — Brief #${state.totalBriefs}`);
  return tweetUrl;
}

// ── Scheduler — Mon / Wed / Fri at 12pm ET (16:00 UTC) ───────────────────────
export function scheduleSignalBrief(xWrite: any, grokKey: string): void {
  function msUntilNextSlot(): number {
    const now = new Date();
    const SIGNAL_DAYS = [1, 3, 5]; // Mon, Wed, Fri

    const candidate = new Date(now);
    candidate.setUTCHours(16, 0, 0, 0); // 12pm ET

    if (SIGNAL_DAYS.includes(candidate.getUTCDay()) && candidate > now) {
      return candidate.getTime() - now.getTime();
    }

    for (let i = 1; i <= 7; i++) {
      const next = new Date(now);
      next.setDate(now.getDate() + i);
      next.setUTCHours(16, 0, 0, 0);
      if (SIGNAL_DAYS.includes(next.getUTCDay())) {
        return next.getTime() - now.getTime();
      }
    }
    return 24 * 60 * 60 * 1000;
  }

  function scheduleNext() {
    const ms    = msUntilNextSlot();
    const hours = Math.round(ms / 3600000);
    console.log(`[SignalBrief] Next brief in ${hours}h (Mon/Wed/Fri 12pm ET)`);
    setTimeout(async () => {
      await postSignalBrief(xWrite, grokKey).catch(console.error);
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
