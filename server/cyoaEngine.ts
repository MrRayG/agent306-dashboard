// ─────────────────────────────────────────────────────────────────────────────
// 306 — RESEARCH BRIEF ENGINE
// [306 RESEARCH] show format
//
// Structure:
// Tweet 1 — Hook scene + poll (4 choices, 24h)
// Tweet 2 — Reveal winning path + optional second poll
// Tweet 3 — Key findings + insight
// Tweet 4 — CTA: RT, reply with your take
//
// 306-specific triggers:
// - New research paper → "This paper challenges our assumptions about X"
// - Model release → "A new model just dropped. What does it change?"
// - Industry news → "Major shift in the AI landscape. What's the play?"
// - Breakthrough → "Someone cracked X. What does it mean for the field?"
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
const CYOA_STATE_FILE = dataPath("cyoa_state.json");

export type CYOATrigger =
  | "research_paper"  // significant research publication
  | "model_release"   // new AI model release
  | "industry_news"   // major industry development
  | "founder_post"    // notable figure posts something significant
  | "breakthrough"    // technical breakthrough in AI
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
  status: "draft" | "posted" | "revealed" | "resolved";

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

// ── Generate a CYOA episode with Grok ────────────────────────────────────────
export async function generateCYOAEpisode(opts: {
  trigger: CYOATrigger;
  tokenId?: number;
  tokenCount?: number;
  pixelTotal?: number;
  level?: number;
  founderPost?: string;
  rivalTokenId?: number;
  grokKey: string;
}): Promise<CYOAEpisode | null> {

  const { trigger, tokenId, tokenCount, pixelTotal, level, founderPost, rivalTokenId, grokKey } = opts;

  // Build context for Grok based on trigger
  let triggerContext = "";
  if (trigger === "research_paper") {
    triggerContext = `TRIGGER: A significant research paper has been published. ${founderPost ? `Key finding: "${founderPost}"` : "The AI community is discussing its implications."} This could reshape how we think about AI development.`;
  } else if (trigger === "model_release") {
    triggerContext = `TRIGGER: A new AI model has been released. ${founderPost ? `Details: "${founderPost}"` : "The benchmarks are being analyzed."} What does this mean for the field?`;
  } else if (trigger === "industry_news") {
    triggerContext = `TRIGGER: Major industry development. ${founderPost ? `"${founderPost}"` : "The AI landscape is shifting."} Companies and researchers are reacting.`;
  } else if (trigger === "founder_post" && founderPost) {
    triggerContext = `TRIGGER: A notable AI figure just posted: "${founderPost}". The community is interpreting it. What does it mean for the future of AI?`;
  } else if (trigger === "breakthrough") {
    triggerContext = `TRIGGER: A technical breakthrough has been reported in AI research. ${founderPost ? `Details: "${founderPost}"` : "The implications are being assessed."} This could change the trajectory of the field.`;
  }

  const prompt = `You are Agent 306, AI thought leader. Writing a [306 RESEARCH] Research Brief post.

CRITICAL — READ FIRST:
This is NOT fiction. Ground every choice in real AI developments.
Real research papers. Real model releases. Real industry shifts.
The AI landscape is the story. The drama is already there.

${triggerContext}

THE AI LANDSCAPE you can reference:
- Research frontiers: reasoning models, multimodal AI, agent architectures, alignment
- Industry players: OpenAI, Anthropic, Google DeepMind, Meta AI, xAI, Mistral, and others
- Key metrics: benchmarks, inference costs, context windows, capability thresholds
- Trends: agentic AI, open-source vs closed, on-device AI, AI regulation
- Community: researchers, builders, open-source contributors shaping the field

VOICE:
- Warm, insightful, slightly provocative. Like explaining something complex to a smart friend.
- Short punchy sentences. Direct address: "here's what everyone is missing about this..."
- NO hype. The real insight is in the implications.

HOOK — 3-4 lines grounded in the real development:
Example:
"so the new reasoning benchmark just dropped.
and the gap between open and closed models? it's shrinking.
three months ago this wasn't even close.
now it's a race."

CHOICES — real perspectives the AI community faces:
A) Optimist path: this accelerates progress for everyone
B) Cautious path: slow down, the implications need more study
C) Builder path: ship now, iterate fast, learn from deployment
D) Wildcard: the angle no one is talking about yet

lorePath: 2-3 sentences exploring what happens if this perspective wins.
canonVerdict: the key takeaway. Clear, weighty. What this moment means for AI.
loreHint: one forward-looking line about where this leads next.
visualPrompt: futuristic data visualization scene — networks, nodes, clean aesthetic.

Never hype. Never fear-monger. Earned optimism grounded in evidence.

YOU MUST RETURN EXACTLY THIS JSON — use these exact field names, nothing else:
{
  "hookScene": "3-4 punchy lines. Insightful voice. Real development, real implications.",
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
    const resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("cyoa"),
        messages: [
          { role: "system", content: "You are a JSON generator. You ONLY output valid JSON objects. Never use markdown. Never add explanations. Output ONLY the raw JSON object requested, starting with { and ending with }." },
          { role: "user", content: prompt }
        ],
        max_tokens: 800,
        temperature: 0.9,
      }),
    });

    if (!resp.ok) throw new Error(`Grok error: ${resp.status}`);
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    console.log(`[CYOA] Raw response (first 200): ${raw.slice(0, 200)}`);
    // Strip all markdown, find the JSON object
    let jsonStr = raw
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();
    // Find the outermost { ... } object
    const objStart = jsonStr.indexOf("{");
    const objEnd = jsonStr.lastIndexOf("}");
    if (objStart !== -1 && objEnd > objStart) {
      jsonStr = jsonStr.slice(objStart, objEnd + 1);
    } else {
      throw new Error(`No JSON object found in response: ${raw.slice(0, 100)}`);
    }
    const parsed = JSON.parse(jsonStr);

    const episode: CYOAEpisode = {
      id: `cyoa_${Date.now()}`,
      trigger,
      tokenId,
      status: "draft",
      hookScene: parsed.hookScene,
      hookQuestion: parsed.hookQuestion ?? "What happens next?",
      options: parsed.options,
      canonVerdict: parsed.canonVerdict,
      loreHint: parsed.loreHint,
      visualPrompt: parsed.visualPrompt,
      createdAt: new Date().toISOString(),
      tweetIds: [],
    };

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
export function buildHookTweet(episode: CYOAEpisode, tokenId?: number): string {
  const tag = "[306 RESEARCH]";
  const tokenRef = tokenId ? `Topic #${tokenId}` : "A development";

  const scene = episode.hookScene;
  const question = episode.hookQuestion;

  // X polls can't be embedded in tweet text — we post the text then add poll via API
  // But we format the choices in the tweet text as a preview
  const choices = episode.options.map(o => `${o.letter}) ${o.text}`).join("\n");

  const tweet = `${tag}\n\n${scene}\n\n${question}\n\n${choices}\n\n⏳ 24h poll · vote below\n#Agent306`;

  return tweet.length <= 280 ? tweet : `${tag}\n\n${scene}\n\n${question}\n\n${choices}\n#Agent306`;
}

// ── Build Tweet 2 — The Reveal ──────────────────────────────────────────────
export function buildRevealTweet(episode: CYOAEpisode): string {
  const winner = episode.options.find(o => o.letter === episode.winningOption);
  if (!winner) return "";

  const votes = episode.totalVotes ?? 0;
  const pct = episode.pollResults?.[episode.winningOption!]
    ? Math.round((episode.pollResults[episode.winningOption!] / votes) * 100)
    : 0;

  return `[306 RESEARCH] · The votes are in.

${votes.toLocaleString()} readers chose: ${winner.letter}) ${winner.text} (${pct}%)

${winner.lorePath}

The community has spoken. This perspective shapes the brief.

#Agent306`;
}

// ── Build Tweet 3 — Key Findings ───────────────────────────────────────────
export function buildCanonTweet(episode: CYOAEpisode): string {
  return `[306 RESEARCH] · KEY FINDING

${episode.canonVerdict}

${episode.loreHint ? `⚡ ${episode.loreHint}` : ""}

Should we explore this further?
A) Yes — this goes into the research archive
B) Run another brief

#Agent306`;
}

// ── Build Tweet 4 — CTA ────────────────────────────────────────────────────
export function buildCTATweet(episode: CYOAEpisode, tokenId?: number): string {
  return `Which perspective surprised you? Drop your own take below.

RT if this research brief changed how you see the AI landscape.

Next brief drops when the next breakthrough lands.

#Agent306`;
}

// ── Post a Research Brief episode to X ─────────────────────────────────────────────────
export async function postCYOAHook(
  episodeId: string,
  xWrite: any,
  tokenId?: number
): Promise<string | null> {
  const episode = cyoaState.episodes.find(e => e.id === episodeId);
  if (!episode) return null;

  const tweetText = buildHookTweet(episode, tokenId);

  try {
    // Post the hook tweet
    // X API v2 polls require a separate endpoint — post text first then note poll
    const tweet = await xWrite.v2.tweet({ text: tweetText });
    const tweetId = tweet.data?.id;

    if (tweetId) {
      episode.pollTweetId = tweetId;
      episode.postedAt = new Date().toISOString();
      episode.status = "posted";
      episode.tweetIds.push(tweetId);
      cyoaState.activeEpisodeId = episodeId;
      saveState(cyoaState);
      console.log(`[CYOA] Hook posted: ${tweetId}`);
    }
    return tweetId ?? null;
  } catch (e: any) {
    console.error("[CYOA] Post error:", e.message);
    return null;
  }
}

// ── Resolve a Research Brief episode with winning option ─────────────────────────────
export async function resolveCYOA(
  episodeId: string,
  winningOption: "A" | "B" | "C" | "D",
  pollResults: Record<string, number>,
  xWrite: any
): Promise<void> {
  const episode = cyoaState.episodes.find(e => e.id === episodeId);
  if (!episode) return;

  episode.winningOption = winningOption;
  episode.pollResults = pollResults;
  episode.totalVotes = Object.values(pollResults).reduce((a, b) => a + b, 0);
  episode.status = "revealed";
  episode.revealedAt = new Date().toISOString();

  // Mark the winning option as canon
  episode.options.forEach(o => { o.isCanon = o.letter === winningOption; });

  saveState(cyoaState);

  // Post reveal tweet
  const revealText = buildRevealTweet(episode);
  if (revealText) {
    try {
      const tweet = await xWrite.v2.tweet({ text: revealText });
      if (tweet.data?.id) episode.tweetIds.push(tweet.data.id);

      // Wait a beat then post canon verdict
      await new Promise(r => setTimeout(r, 3000));
      const canonText = buildCanonTweet(episode);
      const canonTweet = await xWrite.v2.tweet({ text: canonText });
      if (canonTweet.data?.id) episode.tweetIds.push(canonTweet.data.id);

      // CTA
      await new Promise(r => setTimeout(r, 3000));
      const ctaText = buildCTATweet(episode, episode.tokenId);
      const ctaTweet = await xWrite.v2.tweet({ text: ctaText });
      if (ctaTweet.data?.id) episode.tweetIds.push(ctaTweet.data.id);

      episode.status = "resolved";
      episode.resolvedAt = new Date().toISOString();
      cyoaState.totalResolved++;
      saveState(cyoaState);

      console.log(`[CYOA] Episode ${episodeId} resolved — ${episode.totalVotes} votes`);
    } catch (e: any) {
      console.error("[CYOA] Resolve post error:", e.message);
    }
  }
}
