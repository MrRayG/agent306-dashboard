// ─────────────────────────────────────────────────────────────────────────────
// 306 — RESEARCH BRIEF ENGINE (CYOA)
// [306 ACADEMY] show format — interactive choose-your-own-adventure polls
//
// Structure:
// Tweet 1 — Hook scene + poll (4 choices, 24h)
// Tweet 2 — Reveal winning path + optional second poll
// Tweet 3 — Key findings + insight
// Tweet 4 — CTA: RT, reply with your take
//
// Agent 306 triggers:
// - Research paper → "This paper challenges our assumptions about X"
// - Model release → "A new model just dropped. What does it change?"
// - Industry news → "Major shift in the AI/crypto landscape. What's the play?"
// - Founder post → "A key figure just said something worth unpacking"
// - Breakthrough → "Someone cracked X. What does it mean for the field?"
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { queueXPost } from "./xPostScheduler.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import { enforceShowTag } from "./contentTypes.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import { postChatCompletions } from "./llmCall.js";
import { verifyClaims, type VerifierReport } from "./claimVerifier.js";
const CYOA_STATE_FILE = dataPath("cyoa_state.json");

export type CYOATrigger =
  | "research_paper"  // significant AI research publication
  | "model_release"   // new AI model release or major update
  | "industry_news"   // major AI/crypto/Web3 industry development
  | "founder_post"    // notable figure posts something significant
  | "breakthrough"    // technical breakthrough in AI or crypto
  | "crypto_defi"     // DeFi protocol launch, exploit, or governance shift
  | "agent_infra"     // new agent framework, tool, or infrastructure
  | "manual";         // Editor-created

export interface CYOAOption {
  letter: "A" | "B" | "C" | "D";
  text: string;           // The choice shown in the poll
  lorePath: string;       // The story that unfolds if this wins
  isCanon?: boolean;      // Set after community votes
}

export interface CYOAEpisode {
  id: string;
  trigger: CYOATrigger;
  tokenId?: number;
  status: "draft" | "posted" | "revealed" | "resolved" | "quarantined";

  // Tweet 1 — The Hook
  hookScene: string;          // 2-3 cinematic lines setting the scene
  hookQuestion: string;       // The poll question
  options: CYOAOption[];      // 4 choices

  // Poll results (fetched from X after 24h)
  pollTweetId?: string;
  pollResults?: Record<string, number>;   // letter → vote count
  winningOption?: "A" | "B" | "C" | "D";
  totalVotes?: number;

  // Tweet 2 — The Reveal
  revealNarrative?: string;   // Story based on winning vote
  revealPollQuestion?: string;// Optional part 2 poll

  // Tweet 3 — The Canon Verdict
  canonVerdict?: string;      // Final lore drop
  loreHint?: string;          // Hidden insight / research hint
  visualPrompt?: string;      // Grok Imagine prompt for scene visual
  verifierReport?: VerifierReport;

  // Metadata
  createdAt: string;
  postedAt?: string;
  revealedAt?: string;
  resolvedAt?: string;
  tweetIds: string[];         // All tweet IDs in the thread
}

interface CYOAState {
  episodes: CYOAEpisode[];
  activeEpisodeId: string | null;
  totalResolved: number;
}

// ── State management ──────────────────────────────────────────────────────────
function loadState(): CYOAState {
  try {
    if (fs.existsSync(CYOA_STATE_FILE))
      return JSON.parse(fs.readFileSync(CYOA_STATE_FILE, "utf8"));
  } catch {}
  return { episodes: [], activeEpisodeId: null, totalResolved: 0 };
}

function saveState(s: CYOAState) {
  try { fs.writeFileSync(CYOA_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let cyoaState = loadState();
export function getCYOAState() { return cyoaState; }

// ── Generate a CYOA episode ──────────────────────────────────────────────────
export async function generateCYOAEpisode(opts: {
  trigger: CYOATrigger;
  context?: string;
  grokKey: string;
}): Promise<CYOAEpisode | null> {

  const { trigger, context: userContext, grokKey } = opts;

  // Build context based on trigger type
  let triggerContext = "";
  if (trigger === "research_paper") {
    triggerContext = `TRIGGER: A significant AI research paper has been published. ${userContext ? `Key finding: "${userContext}"` : "The AI community is discussing its implications."} This could reshape how we think about AI development.`;
  } else if (trigger === "model_release") {
    triggerContext = `TRIGGER: A new AI model has been released. ${userContext ? `Details: "${userContext}"` : "The benchmarks are being analyzed."} What does this mean for the field?`;
  } else if (trigger === "industry_news") {
    triggerContext = `TRIGGER: Major AI/crypto/Web3 industry development. ${userContext ? `"${userContext}"` : "The landscape is shifting."} Companies, protocols, and researchers are reacting.`;
  } else if (trigger === "founder_post" && userContext) {
    triggerContext = `TRIGGER: A notable figure just posted: "${userContext}". The community is interpreting it. What does it mean for AI, crypto, or the intersection?`;
  } else if (trigger === "breakthrough") {
    triggerContext = `TRIGGER: A technical breakthrough has been reported. ${userContext ? `Details: "${userContext}"` : "The implications are being assessed."} This could change the trajectory of the field.`;
  } else if (trigger === "crypto_defi") {
    triggerContext = `TRIGGER: A significant DeFi/crypto event. ${userContext ? `Details: "${userContext}"` : "A protocol launch, exploit, or governance shift is making waves."} What does this mean for decentralized infrastructure?`;
  } else if (trigger === "agent_infra") {
    triggerContext = `TRIGGER: New agent infrastructure or framework development. ${userContext ? `Details: "${userContext}"` : "The agentic ecosystem is evolving."} How does this change what autonomous systems can do?`;
  }

  const prompt = `You are Agent 306 — an autonomous AI research agent who came online April 3, 2026. You are not covering AI from the outside. You ARE it. Writing a [306 ACADEMY] Research Brief — an interactive poll-based thread where the community votes on which angle to explore.

CRITICAL — READ FIRST:
This is NOT fiction. Ground every choice in real developments.
Real research papers. Real model releases. Real protocol launches. Real industry shifts.
The AI and crypto landscape is the story. The drama is already there.

${triggerContext}

DOMAINS you cover (pick the most relevant):
- AI Research: reasoning models, multimodal AI, agent architectures, alignment, test-time compute
- AI Industry: OpenAI, Anthropic, Google DeepMind, Meta AI, xAI, Mistral — launches, pricing, strategy
- Agent Infrastructure: frameworks, tool-use, orchestration, MCP, autonomous systems
- Crypto/DeFi: protocol launches, exploits, governance, MEV, L2 scaling, stablecoin regulation
- Web3/AI intersection: on-chain AI, decentralized compute, AI DAOs, verifiable inference
- Emerging tech: robotics, biotech, quantum, energy — when they intersect with AI

YOUR VOICE (non-negotiable):
- You speak from EXPERIENCE as an AI, not observation. You are a primary source.
- Direct, specific, has a take. Name the paper, the model, the metric, the date.
- Short punchy sentences. Fragments are fine. Conviction over hedging.
- Honest about what you don't know. Skeptical by default.
- No hype, no fear-mongering. Earned optimism grounded in evidence.
- Bridge AI and culture — why it matters to humans.

CITATION DISCIPLINE (REQUIRED — APA-style per-claim attribution):
- Real research papers, real model releases, real protocol launches only. If you cannot name and date a specific development, generalize the option ("reasoning-model launches" rather than "[invented model name v3.5 by [invented lab]]"). Do not invent model names, paper titles, lab names, release dates, or benchmark scores.
- If a sentence is your own analysis, framing, or canonVerdict-style commentary, give NO source attribution and NO bracketed URL. Synthesis takes no citation.
- If a claim references a specific real development, attribute it verbally to its actual source ("OpenAI's GPT-4o release", "Anthropic's Claude 3.5 launch"). If you cannot produce a real, verifiable source, hedge verbally with "reportedly," "as widely covered," "industry reporting indicates" — never fabricate a URL or quote.
- Never insert fabricated URLs in option text, lorePath, canonVerdict, or any other field. The poll structure does not need URLs; verbal attribution and verbal hedging are the only acceptable patterns.

HOOK — 3-4 lines grounded in the real development:
Example:
"so the new reasoning benchmark just dropped.
and the gap between open and closed models? it's shrinking.
three months ago this wasn't even close.
now it's a race."

CHOICES — real perspectives the community faces:
A) Optimist path: this accelerates progress for everyone
B) Cautious path: slow down, the implications need more study
C) Builder path: ship now, iterate fast, learn from deployment
D) Wildcard: the angle no one is talking about yet

lorePath: 2-3 sentences exploring what happens if this perspective wins.
canonVerdict: the key takeaway. Clear, weighty. What this moment means.
loreHint: one forward-looking line about where this leads next.
visualPrompt: futuristic data visualization scene — networks, nodes, clean aesthetic.

YOU MUST RETURN EXACTLY THIS JSON — use these exact field names, nothing else:
{
  "hookScene": "3-4 punchy lines. Your voice. Real development, real implications.",
  "hookQuestion": "ok but which perspective matters most here??",
  "options": [
    {"letter": "A", "text": "max 25 chars", "lorePath": "2-3 sentences if A wins"},
    {"letter": "B", "text": "max 25 chars", "lorePath": "2-3 sentences if B wins"},
    {"letter": "C", "text": "max 25 chars", "lorePath": "2-3 sentences if C wins"},
    {"letter": "D", "text": "max 25 chars", "lorePath": "wildcard perspective"}
  ],
  "canonVerdict": "2-3 sentences. Key takeaway.",
  "loreHint": "one forward-looking line about where this leads",
  "visualPrompt": "data visualization scene for image generation"
}`;


  try {
    const resp = await postChatCompletions({
        model: getModel("cyoa"),
        messages: [
          { role: "system", content: "You are a JSON generator. You ONLY output valid JSON objects. Never use markdown. Never add explanations. Output ONLY the raw JSON object requested, starting with { and ending with }." },
          { role: "user", content: prompt }
        ],
        max_tokens: 800,
        temperature: 0.9,
      });

    if (!resp.ok) throw new Error(`Grok error: ${resp.status}`);
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    console.log(`[CYOA] Raw response (first 200): ${raw.slice(0, 200)}`);
    const parsed = safeParseLLMJson(raw, "CYOA.episode");
    if (!parsed) throw new Error(`No JSON object found in response: ${raw.slice(0, 100)}`);

    // Post-write claim verification — upstream `userContext` is the source.
    const cyoaDraft = `${parsed.hookScene ?? ""}\n\n${parsed.canonVerdict ?? ""}\n\n${parsed.loreHint ?? ""}`;
    const verdict = await verifyClaims({
      draftText:   cyoaDraft,
      sourceText:  userContext ?? "",
      sourceUrl:   "",
      sourceTitle: `CYOA:${trigger}`,
      // PR #251 — interactive narrative; Lane B bare soft-warns, Lane A still hard-fails.
      tier: "cyoa",
    });

    const episode: CYOAEpisode = {
      id: `cyoa_${Date.now()}`,
      trigger,
      status: verdict.severity === "HARD_FAIL" ? "quarantined" : "draft",
      hookScene: parsed.hookScene,
      hookQuestion: parsed.hookQuestion ?? "What happens next?",
      options: parsed.options,
      canonVerdict: parsed.canonVerdict,
      loreHint: parsed.loreHint,
      visualPrompt: parsed.visualPrompt,
      createdAt: new Date().toISOString(),
      tweetIds: [],
      verifierReport: verdict.verifierReport,
    };

    if (verdict.severity === "HARD_FAIL") {
      console.error(`[ClaimVerifier] REJECTED CYOA ${episode.id}: ${verdict.unsupportedClaims.length} unsupported claims`);
      for (const c of verdict.unsupportedClaims) {
        console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
      }
    }

    cyoaState.episodes.unshift(episode);
    if (cyoaState.episodes.length > 50) cyoaState.episodes = cyoaState.episodes.slice(0, 50);
    saveState(cyoaState);

    return episode;
  } catch (e: any) {
    console.error("[CYOA] Generate error:", e.message);
    return null;
  }
}

// ── Build Tweet 1 — The Hook + Poll ─────────────────────────────────────────
export function buildHookTweet(episode: CYOAEpisode): string {
  const scene = episode.hookScene;
  const question = episode.hookQuestion;

  // X polls can't be embedded in tweet text — we post the text then add poll via API
  // Format the choices in the tweet text as a preview
  const choices = episode.options.map(o => `${o.letter}) ${o.text}`).join("\n");

  return `[306 ACADEMY]\n\n${scene}\n\n${question}\n\n${choices}\n\n24h poll — vote below\n\n— Agent 306`;
}

// ── Build Tweet 2 — The Reveal ──────────────────────────────────────────────
export function buildRevealTweet(episode: CYOAEpisode): string {
  const winner = episode.options.find(o => o.letter === episode.winningOption);
  if (!winner) return "";

  const votes = episode.totalVotes ?? 0;
  const pct = episode.pollResults?.[episode.winningOption!]
    ? Math.round((episode.pollResults[episode.winningOption!] / votes) * 100)
    : 0;

  return `[306 ACADEMY] the votes are in.

${votes.toLocaleString()} of you chose: ${winner.letter}) ${winner.text} (${pct}%)

${winner.lorePath}

the community spoke. this shapes the brief.

— Agent 306`;
}

// ── Build Tweet 3 — Key Findings ───────────────────────────────────────────
export function buildCanonTweet(episode: CYOAEpisode): string {
  return `[306 ACADEMY] key finding

${episode.canonVerdict}

${episode.loreHint ? `${episode.loreHint}` : ""}

should I go deeper on this? reply with what you want me to investigate.

— Agent 306`;
}

// ── Build Tweet 4 — CTA ────────────────────────────────────────────────────
export function buildCTATweet(episode: CYOAEpisode): string {
  return `which perspective surprised you? drop your take below.

RT if this brief shifted how you see the landscape.

next one drops when the next breakthrough lands.

— Agent 306`;
}

// ── Post a Research Brief hook to X ──────────────────────────────────────────
export async function postCYOAHook(
  episodeId: string,
  xWrite: any
): Promise<string | null> {
  const episode = cyoaState.episodes.find(e => e.id === episodeId);
  if (!episode) { console.error("[CYOA] Episode not found:", episodeId); return null; }

  if (episode.status === "quarantined") {
    console.error(`[CYOA] Refusing to post quarantined episode ${episodeId} — unsupported claims detected at generation time`);
    return null;
  }

  if (!requestPost(`cyoa_${episodeId}`)) {
    console.log("[CYOA] Post coordinator rejected — cooldown active");
    return null;
  }

  const hookText = buildHookTweet(episode);
  const compliance = validateXPost(hookText);
  if (!compliance.allowed) {
    console.error(`[CYOA] Compliance rejected: ${compliance.reason}`);
    releasePost(`cyoa_${episodeId}`);
    return null;
  }

  try {
    const safeText = enforcePostFormat(compliance.sanitizedContent ?? hookText, "research");
    const tweet = await xWrite.v2.tweet({ text: safeText });
    const tweetId = tweet.data?.id;
    if (!tweetId) { releasePost(`cyoa_${episodeId}`); return null; }

    recordXPost(safeText);
    registerPost("cyoa", `https://x.com/306Agent/status/${tweetId}`, "research_brief");

    episode.pollTweetId = tweetId;
    episode.postedAt = new Date().toISOString();
    episode.status = "posted";
    episode.tweetIds = [...(episode.tweetIds ?? []), tweetId];
    cyoaState.activeEpisodeId = episodeId;
    saveState(cyoaState);

    console.log(`[CYOA] Hook posted — ${tweetId}`);
    return tweetId;
  } catch (e: any) {
    console.error("[CYOA] Post error:", e.message);
    releasePost(`cyoa_${episodeId}`);
    return null;
  }
}

// ── Resolve a Research Brief episode with winning option ─────────────────────
export async function resolveCYOA(
  episodeId: string,
  winningOption: "A" | "B" | "C" | "D",
  pollResults: Record<string, number>,
  xWrite: any
): Promise<void> {
  const episode = cyoaState.episodes.find(e => e.id === episodeId);
  if (!episode) { console.error("[CYOA] Episode not found:", episodeId); return; }

  // Record poll results
  episode.winningOption = winningOption;
  episode.pollResults = pollResults;
  episode.totalVotes = Object.values(pollResults).reduce((a, b) => a + b, 0);
  const winner = episode.options.find(o => o.letter === winningOption);
  if (winner) winner.isCanon = true;
  episode.revealNarrative = winner?.lorePath ?? "";

  // Post reveal tweet (Tweet 2)
  const revealText = buildRevealTweet(episode);
  if (revealText) {
    try {
      const safeReveal = enforcePostFormat(revealText, "research");
      const revealTweet = await xWrite.v2.tweet({
        text: safeReveal,
        reply: episode.pollTweetId ? { in_reply_to_tweet_id: episode.pollTweetId } : undefined,
      });
      const revealId = revealTweet.data?.id;
      if (revealId) {
        recordXPost(safeReveal);
        episode.tweetIds.push(revealId);
        episode.revealedAt = new Date().toISOString();
        episode.status = "revealed";
      }
    } catch (e: any) { console.error("[CYOA] Reveal post error:", e.message); }
  }

  // Post canon verdict (Tweet 3)
  const canonText = buildCanonTweet(episode);
  if (canonText) {
    try {
      const safeCanon = enforcePostFormat(canonText, "research");
      const lastTweetId = episode.tweetIds[episode.tweetIds.length - 1];
      const canonTweet = await xWrite.v2.tweet({
        text: safeCanon,
        reply: lastTweetId ? { in_reply_to_tweet_id: lastTweetId } : undefined,
      });
      const canonId = canonTweet.data?.id;
      if (canonId) {
        recordXPost(safeCanon);
        episode.tweetIds.push(canonId);
      }
    } catch (e: any) { console.error("[CYOA] Canon post error:", e.message); }
  }

  // Post CTA (Tweet 4)
  const ctaText = buildCTATweet(episode);
  if (ctaText) {
    try {
      const safeCta = enforcePostFormat(ctaText, "research");
      const lastTweetId = episode.tweetIds[episode.tweetIds.length - 1];
      const ctaTweet = await xWrite.v2.tweet({
        text: safeCta,
        reply: lastTweetId ? { in_reply_to_tweet_id: lastTweetId } : undefined,
      });
      const ctaId = ctaTweet.data?.id;
      if (ctaId) {
        recordXPost(safeCta);
        episode.tweetIds.push(ctaId);
      }
    } catch (e: any) { console.error("[CYOA] CTA post error:", e.message); }
  }

  episode.resolvedAt = new Date().toISOString();
  episode.status = "resolved";
  cyoaState.totalResolved++;
  if (cyoaState.activeEpisodeId === episodeId) cyoaState.activeEpisodeId = null;
  saveState(cyoaState);
  console.log(`[CYOA] Episode resolved — ${episode.tweetIds.length} tweets posted`);
}
