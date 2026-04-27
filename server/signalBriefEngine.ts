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
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { queueXPost, getTodaysPostsSummary } from "./xPostScheduler.js";
import { enforceShowTag } from "./contentTypes.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import { buildVoiceBlock } from "./voice.js";
import { getEvolutionContext } from "./soulEvolution.js";

import { postChatCompletions, postXSearchResponses } from "./llmCall.js";
import { verifyClaims } from "./claimVerifier.js";
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
    const useNativeGrok = !!process.env.GROK_API_KEY;
    const xSearchPrompt = `Search X and the web for the 3 most signal-rich developments from the last 48 hours across these tracks:

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
}`;

    const res = useNativeGrok
      ? await postXSearchResponses({
          task: "signal-brief",
          content: xSearchPrompt,
          signal: AbortSignal.timeout(45000),
        })
      : await postChatCompletions({
          model: getModel("x_search"),
          messages: [{ role: "user", content: `Find the 3 most important tech/AI/crypto developments from the last 48 hours. Return JSON with aiSignal, web3Signal, wildcardSignal fields, each 2-3 sentences.` }],
          max_tokens: 800,
          temperature: 0.3,
        }, AbortSignal.timeout(45000), "x_search");

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
    const res = await postChatCompletions({
        model: getModel("signal-collection"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}

${buildVoiceBlock()}
${getEvolutionContext()}

CITATION DISCIPLINE (REQUIRED — APA-style per-claim attribution):
- A citation [URL] must support the SPECIFIC claim immediately before it. Do not staple a citation to the end of a paragraph that contains synthesis or analytical commentary — citations attach to claims, not paragraphs.
- If a sentence is your own analysis, interpretation, framing, or "the logical endpoint of X" / "the illusion of Y" / "the entire field has been built on Z" type commentary, do NOT attach a citation. State it in your analytical voice. Synthesis is Lane B and takes no URL.
- If a claim is a fact drawn from a SOURCE OTHER than the primary signals feed above (industry-known costs, benchmarks, dates, training facts, historical events, your KB), do NOT staple the primary signals feed's URL to it. Either cite the actual source with its real URL in your own voice ("per Stanford HAI's 2025 AI Index, [link]"), or — if you cannot produce a real URL for it — qualify it verbally with a hedge like "publicly reported," "industry reporting indicates," "as widely covered" and attach NO URL. Never fabricate a URL.
- The KB / knowledge layer included in the context above is provided as background scaffolding for your analysis, NOT as a citation pool — KB lines do not carry source URLs. Treat any KB-derived fact you surface as outside-the-source and apply the rule above (cite the real upstream source if you have one, hedge verbally if you don't).
- One citation per claim. If a sentence contains multiple claims requiring different sources, split the sentence or cite each component. Do not bracket-pile citations onto a single closing punctuation.

You produce [306 SIGNAL], the intelligence brief that cuts through the noise.
You curate ruthlessly. You find the builder angle and the investment thesis.

${getTodaysPostsSummary()}

SIGNAL BRIEF FORMAT:
- Show tag: [306 SIGNAL]
- Brief number and day
- 3 signals, each with: a punchy headline, 2-3 sentences of context, and Agent 306's 1-sentence POV
- A closing line that ties all 3 signals together into one thesis
- No character limit (X Premium Plus — up to 25,000 chars). Use the space to tell the full story.

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
- Max 2 relevant hashtags per post.

CRITICAL OUTPUT RULES:
- Respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.
- The "post" field must contain ONLY the post text — no meta-commentary like "Here's my post:", no separators like "---", no character counts like "(487 characters)".`,
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
  "post": "the full brief post (starts with [306 SIGNAL] — no character limit, let the analysis breathe)",
  "signal1Headline": "punchy 6-8 word headline for signal 1",
  "signal2Headline": "punchy 6-8 word headline for signal 2",
  "signal3Headline": "punchy 6-8 word headline for signal 3",
  "closingThesis": "one sentence that ties all 3 together — something a builder would screenshot"
}`,
          },
        ],
        max_tokens: 4000,
        temperature: 0.8,
      }, AbortSignal.timeout(60000));

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

    // Enforce [306 SIGNAL] show tag
    const post = enforceShowTag(parsed.post, "signal");

    // Post-write claim verification against the upstream raw signals.
    // The signals feed IS the source for this engine — any claim the brief
    // attributes to "the report", "the article", a specific outlet, or a
    // named figure must appear in that feed. Unsupported → quarantined
    // (returned null so nothing posts). See server/claimVerifier.ts.
    const upstreamSourceText = [
      `AI Frontier signal:\n${aiSignal}`,
      `Web3 signal:\n${web3Signal}`,
      `Wild Card signal:\n${wildcardSignal}`,
    ].join("\n\n");
    const verdict = await verifyClaims({
      draftText:   post,
      sourceText:  upstreamSourceText,
      sourceUrl:   "",
      sourceTitle: `306 SIGNAL Brief #${briefNumber}`,
    });
    if (verdict.severity === "HARD_FAIL") {
      console.error(`[ClaimVerifier] REJECTED signal brief #${briefNumber}: ${verdict.unsupportedClaims.length} unsupported claims`);
      for (const c of verdict.unsupportedClaims) {
        console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
      }
      return null;
    }

    return { post, signals, weekLabel };
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
    const compliance = validateXPost(generated.post.trim());
    if (!compliance.allowed) {
      console.log(`[SignalBrief] Skipped by compliance: ${compliance.reason}`);
    } else {
      let safeText = compliance.sanitizedContent ?? generated.post.trim();
      safeText = enforcePostFormat(safeText, "signal");
      const tweet = await xWrite.v2.tweet({ text: safeText });
      const tweetId = tweet.data?.id;
      tweetUrl = tweetId ? `https://x.com/306Agent/status/${tweetId}` : null;
      recordXPost(safeText);
      console.log(`[SignalBrief] Brief #${state.totalBriefs + 1} posted — ${tweetUrl}`);
    }
  } catch (e: any) {
    console.error("[SignalBrief] Post failed:", e.message);
  }

  // Queue for Farcaster (parallel to X queue)
  let castQueued = false;
  try {
    const { queueFarcasterPost } = await import("./farcasterQueue.js");
    if (generated.post.trim().length > 10) {
      queueFarcasterPost(generated.post.trim().slice(0, 2500), "signal", undefined, "ai");
      castQueued = true;
      console.log(`[SignalBrief] Farcaster cast queued`);
    }
  } catch (fcErr: any) {
    console.warn("[SignalBrief] Farcaster queue failed:", fcErr.message);
  }

  if (!tweetUrl && !castQueued) {
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
  // Double-posting removed: direct post above is the sole posting method.
  // Previously also called queueXPost() which caused the same content to post twice.

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

// ── On-demand generation (no side effects — just produces content) ────────────
export async function generateSignalContent(grokKey: string): Promise<{
  post: string;
  signals: SignalEntry[];
  weekLabel: string;
} | null> {
  console.log("[SignalBrief] On-demand generation triggered");
  return generateSignalBrief(grokKey);
}
