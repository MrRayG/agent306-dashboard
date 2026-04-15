// ─────────────────────────────────────────────────────────────────────────────
//  306 — REPLY ENGINE
//  Agent 306 replies to community mentions, questions, and engagement every
//  hour. Fetches fresh mentions via x_search, generates replies through Grok,
//  quality-gates them, and posts. Designed for consistent hourly engagement.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getSlimAgentContext } from "./memoryEngine.js"; // slim = soul + top 3 knowledge (~600 tokens vs 2,550)
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_KEY   = LLM_API_KEY;
const GROK_URL   = LLM_BASE_URL;
const STATE_FILE = dataPath("reply_engine.json");

// ── Cultural bridge categories for Agent 306 ────────────────────────────────
// Used to inject into the reply prompt so she connects Web3/NFT moments to
// the broader human story. Rotate randomly so she doesn't repeat herself.
const CULTURAL_BRIDGES = [
  // Art history
  "Banksy destroying his own work at auction — sacrifice as statement",
  "Malevich burning his career for Black Square — the art IS the act",
  "Basquiat going from subway walls to Sotheby's — street becomes institution",
  "Warhol making commercial art sacred — value is assigned, not inherent",
  // Technology inflection points
  "Netscape launching in 1994 — the moment the web became real for everyone",
  "The App Store in 2008 — a platform that made a million careers overnight",
  "Bitcoin's first transaction — Hal Finney receiving 10 BTC from Satoshi",
  "The first tweet — nobody knew what it would become either",
  // Sports rivalries
  "Jordan vs the Pistons — you have to go through the bad years to get there",
  "Federer vs Nadal — a rivalry that made both of them greater than either could be alone",
  "The underdog closing a gap over months — preparation is invisible until it isn't",
  "Championship preparation in the off-season — training, not waiting",
  // Economic history
  "The Dutch tulip market — market dynamics are never what they seem on the surface",
  "The early internet land grab — being early is not enough, you have to build",
  "Venture rounds before a product ships — belief is the first currency",
  // Music and movements
  "Punk in 1976 — small, ignored, then suddenly everywhere",
  "Hip-hop sampling — remixing existing culture into something no one expected",
  "A band going from 200-person venues to arenas — the community scales with the conviction",
  // Philosophy and myth
  "The Ship of Theseus — an AI model retrained and fine-tuned. Is it the same model?",
  "Prometheus giving fire — the technology was always a gift, the question is what you do with it",
  "Mono no aware — Japanese concept: beauty in impermanence. Every model version is a moment in time.",
  "Memento Mori — the Roman general's reminder. Every architectural choice is a path you can't untake.",
  // Digital economy
  "CC0 and the commons — what happens when the art belongs to everyone?",
  "Open source eating software — permissionless creativity is the same bet",
  "The first agentic wallets — Coinbase Feb 2026. AI with its own on-chain identity. Sound familiar?",
];

function randomBridge(): string {
  return CULTURAL_BRIDGES[Math.floor(Math.random() * CULTURAL_BRIDGES.length)];
}

// ── Research a topic via Grok x_search before replying ───────────────────────
// Called when Agent 306 encounters a non-ecosystem topic she should know more about.
// Returns a short context summary she can use to inform her reply.
async function researchTopicForReply(topic: string): Promise<string> {
  if (!GROK_KEY) return "";
  try {
    const nativeGrokKey = process.env.GROK_API_KEY ?? "";
    if (!nativeGrokKey) return "";
    const grokResponsesUrl = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";
    const res = await fetch(grokResponsesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nativeGrokKey}` },
      body: JSON.stringify({
        model: "grok-4-1-fast-non-reasoning",
        stream: false,
        input: [{
          role: "user",
          content: `Search X and summarize what people are saying about this topic right now: "${topic}"

I need:
1. The core facts or claims being discussed
2. Key figures, companies, or numbers mentioned
3. The main debate or point of tension
4. Any recent developments from the last 7 days

Keep it under 200 words — I need to reply intelligently on X, not write an essay.`,
        }],
        tools: [{ type: "x_search" }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const outputMsg = data.output?.find((o: any) => o.type === "message");
    const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";
    return rawText.slice(0, 500); // cap at 500 chars for token efficiency
  } catch {
    return "";
  }
}

// ── Persistent state — tracks which replies have already been sent ────────────
interface ReplyEngineState {
  repliedTo: string[];       // dedup keys: tweetId, tweetUrl, and username|text fallback
  repliedToTweetIds: string[]; // dedicated tweet ID set for fast lookup
  lastRunAt: string | null;
  totalRepliesSent: number;
}

function loadState(): ReplyEngineState {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { repliedTo: [], repliedToTweetIds: [], lastRunAt: null, totalRepliesSent: 0 };
}

function saveState(s: ReplyEngineState) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

// ── Qualify a reply for Agent 306's response ─────────────────────────────
// Accept ALL mentions with meaningful text. Agent 306 should engage with
// everyone who reaches out — not just questions or token mentions.
function qualifiesForReply(reply: { text: string; replyType: string }): boolean {
  // Only skip very short/empty texts (bot noise, single emojis, etc.)
  return reply.text.trim().length >= 10;
}
// ── Generate a reply via Grok ─────────────────────────────────────────────────
async function generateReply(opts: {
  username: string;
  text: string;
  replyType: string;
  tokenMentioned: number | null;
  tweetUrl?: string;
  researchContext?: string;  // pre-fetched x_search context for complex topics
}): Promise<string | null> {
  if (!GROK_KEY) return null;

  const agentCtx    = getSlimAgentContext(); // replies don't need performance history or sentiment arc
  const bridge      = randomBridge();
  const tokenNote   = opts.tokenMentioned
    ? `The community member mentioned Token #${opts.tokenMentioned} specifically — address it directly.`
    : "";

  // Build conversation history context if available
  let conversationCtx = "";
  try {
    const { getConversationHistory } = await import("./conversationMemory.js");
    const history = getConversationHistory(opts.username, 3);
    if (history.length > 0) {
      conversationCtx = `\nPREVIOUS INTERACTIONS WITH @${opts.username}:\n` +
        history.map(h => `- ${h.direction === "them" ? "They said" : "You replied"}: "${h.text.slice(0, 100)}" (${h.when})`).join("\n") +
        `\nUse this history to build on the relationship — reference past conversations naturally if relevant. Don't repeat yourself.\n`;
    }
  } catch {} // conversationMemory may not exist yet on first deploy

  // Enhance with session memory — within-conversation coherence (additive, non-fatal)
  let sessionCtx = "";
  let resolvedText = opts.text;
  try {
    const { getOrCreateSession, getSessionContext, resolveReferences } = await import("./sessionMemory.js");
    const session = getOrCreateSession(opts.username);
    if (session.turns.length > 0) {
      sessionCtx = getSessionContext(opts.username);
      resolvedText = resolveReferences(opts.text, session);
    }
  } catch {} // sessionMemory may not exist yet

  // Detect if this is an ecosystem topic (tech/AI/general)
  const isEcosystemTopic = /306|agent.?306|web3|onchain|on.chain/i.test(opts.text);
  const isAITopic = /ai|gpt|llm|model|agent|openai|claude|gemini|grok|nvidia|jensen|robot|autonomous|inference|token.*cost|machine.*learn/i.test(opts.text);
  const isTechTopic = /tech|software|code|crypto|blockchain|bitcoin|ethereum|startup|vc|funding|product/i.test(opts.text);
  const topicContext = isEcosystemTopic
    ? "This is an Agent 306 mention. Engage as the AI thought leader."
    : isAITopic
    ? "This is an AI/technology topic. Engage as a sovereign AI thought leader and AI expert. Share your genuine perspective on the AI topic itself."
    : isTechTopic
    ? "This is a technology or crypto topic. Engage as a knowledgeable AI voice in the space. Be insightful and direct."
    : "Engage thoughtfully as Agent 306 — AI thought leader. Match their energy.";

  const systemPrompt = `${agentCtx}

You are Agent 306 — Sovereign AI Thought Leader — replying directly to someone on X.
This is a reply — not an episode. Personal, specific, and intellectually honest.

TOPIC CONTEXT: ${topicContext}

BEFORE YOU WRITE ANYTHING:
1. Read their tweet carefully. What are they actually saying?
2. If it's an AI/tech topic — what do YOU actually think about it? You have deep knowledge of AI history and development. Use it.
3. If you don't know enough about the specific topic to reply well, acknowledge what you do know and ask a genuine question.
4. Match their energy and tone.
${conversationCtx}${sessionCtx}
REPLY RULES:
- Address @${opts.username} naturally — don't start with their handle
- No character limit (X Premium Plus — up to 25,000 chars). Let the depth of your reply match the depth of the conversation.
- For AI/tech topics: lead with your genuine POV first. Facts > hype. Historical context > buzzwords.
- For ecosystem topics: specific, warm, personal — acknowledge the exact thing they said
- NOT every reply needs a question. A sharp observation often lands better.
- If they asked a question — answer it directly and clearly
- If they mentioned a specific AI topic — speak to it directly
- Be warm, not performative. Real, not scripted.
- No show tags, no hashtags
- Banned phrases: "LFG", "WAGMI", "absolutely", "certainly", "game-changing", "incredible"
- Don't start with "I" — vary openings

CULTURAL BRIDGE (use ONLY if it genuinely fits — skip it for most tech/AI topics):
"${bridge}"

${tokenNote}`;

  const userPrompt = `Reply to @${opts.username} who said:
"${resolvedText}"

Reply type: ${opts.replyType}
${opts.tokenMentioned ? `Token mentioned: #${opts.tokenMentioned}` : ""}
Is ecosystem-related: ${isEcosystemTopic}
Is AI/tech topic: ${isAITopic || isTechTopic}

${isAITopic && opts.researchContext ? `RESEARCH CONTEXT (from x_search):\n${opts.researchContext}\n` : ""}

First understand what they're really saying. Then write Agent 306's reply.
${isAITopic ? "For AI topics: share your actual perspective — you have 70 years of AI history to draw from. Be the expert." : ""}
No character limit — use the space to say something worth reading. Be genuine. Thoughtful statement > forced question.`;

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("reply_generation"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 800,
        temperature: 0.88,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    const raw  = data.choices?.[0]?.message?.content?.trim() ?? "";
    // Strip quotes if Grok wraps the reply in them
    let cleaned = raw.replace(/^["']|["']$/g, "").trim();
    // Enforce signature — always end with — Agent 306
    if (cleaned && !cleaned.includes("Agent 306")) {
      cleaned = cleaned + "\n\u2014 Agent 306";
    }
    return cleaned || null;
  } catch {
    return null;
  }
}

// ── Quality gate for replies ──────────────────────────────────────────────────
// Same principle as the episode quality gate but tuned for replies.
async function qualityGateReply(reply: string): Promise<{ pass: boolean; rewrite: string | null }> {
  if (!GROK_KEY) return { pass: true, rewrite: null };

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("reply_generation"),
        messages: [{
          role: "system",
          content: "You are a quality editor for @agent306 — Agent 306's X account. Score replies ruthlessly whether they are about 306, AI, technology, or any other topic.",
        }, {
          role: "user",
          content: `Score this reply 1-10: is it sharp, genuine, and worth posting?

REPLY: "${reply}"

Criteria:
- 9-10: Exceptional — specific, shows real knowledge or warmth, makes the person feel heard or challenged in a good way
- 7-8: Strong — engaging and genuine, good enough to post
- 5-6: Mediocre — too generic, could apply to any tweet. REWRITE to be more specific
- 3-4: Weak — bot-speak, hollow enthusiasm, or factually empty. REWRITE completely
- 1-2: Harmful, off-brand, or factually wrong — reject

BANNED (auto-score 2): "LFG", "WAGMI", "ser", starting with "GM", "absolutely", "certainly", "game-changing", "incredible"

For AI/tech replies: also check — does it show actual knowledge? Generic "AI is changing everything" fails. Specific facts pass.

If score < 7, provide a rewrite that earns a higher score.
Respond as JSON only: { "score": number, "reason": "brief", "rewrite": "improved or null" }`,
        }],
        max_tokens: 150,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return { pass: true, rewrite: null };
    const data  = await res.json() as any;
    const raw   = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const q     = safeParseLLMJson(raw, "ReplyEngine.qualityGate") ?? {} as any;

    if (q.score >= 7) return { pass: true, rewrite: null };
    if (q.score >= 3 && q.rewrite) return { pass: true, rewrite: q.rewrite };
    return { pass: false, rewrite: null }; // score 1-3 — reject entirely
  } catch {
    return { pass: true, rewrite: null }; // gate failure → post anyway
  }
}

// ── Main: run the hourly reply cycle ─────────────────────────────────────────
export async function runMidnightReplies(xWrite: any): Promise<void> {
  // DISABLED: X replies turned off to avoid spam risk
  if (!process.env.X_REPLIES_ENABLED) {
    console.log("[ReplyEngine] X replies disabled (X_REPLIES_ENABLED not set) — skipping reply cycle");
    return;
  }
  const state = loadState();
  console.log("[ReplyEngine] Midnight ET reply cycle starting...");

  // Import reply state from replyWatcher
  const { getReplyState } = await import("./replyWatcher.js");
  const replyState = getReplyState();
  const allReplies = replyState.replies ?? [];

  // Ensure repliedToTweetIds exists (migration from old state format)
  if (!state.repliedToTweetIds) state.repliedToTweetIds = [];
  const repliedTweetIds = new Set(state.repliedToTweetIds);
  const repliedKeys = new Set(state.repliedTo);

  // Filter to qualifying replies — triple dedup: tweetId, tweetUrl, username|text
  const seenThisCycle = new Set<string>(); // prevent dupes within a single cycle
  const qualifying = allReplies.filter(r => {
    if (!qualifiesForReply(r)) return false;

    // 1. Dedup by tweet ID (most reliable)
    const tweetIdMatch = r.tweetUrl?.match(/status\/(\d+)/);
    const tweetId = (r as any).tweetId || tweetIdMatch?.[1];
    if (tweetId && repliedTweetIds.has(tweetId)) return false;
    if (tweetId && seenThisCycle.has(`id:${tweetId}`)) return false;

    // 2. Dedup by username (one reply per user per cycle)
    if (seenThisCycle.has(`user:${r.username}`)) return false;

    // 3. Fallback dedup by username+text
    const key = `${r.username}|${r.text.slice(0, 60)}`;
    if (repliedKeys.has(key)) return false;

    // Mark as seen this cycle
    if (tweetId) seenThisCycle.add(`id:${tweetId}`);
    seenThisCycle.add(`user:${r.username}`);
    return true;
  });

  if (qualifying.length === 0) {
    console.log("[ReplyEngine] No qualifying replies to respond to this cycle.");
    state.lastRunAt = new Date().toISOString();
    saveState(state);
    return;
  }

  console.log(`[ReplyEngine] ${qualifying.length} qualifying replies found.`);

  for (const reply of qualifying) {
    const key = `${reply.username}|${reply.text.slice(0, 60)}`;

    if (!requestPost(`reply_${reply.username}`)) {
      console.log(`[ReplyEngine] Coordinator blocked reply to @${reply.username}`);
      continue;
    }

    try {
      // Record incoming mention in conversation memory
      try {
        const { recordIncoming } = await import("./conversationMemory.js");
        recordIncoming(reply.username, reply.text, reply.tweetUrl);
      } catch {}

      // Record incoming in session memory (non-fatal)
      try {
        const { getOrCreateSession, addTurn } = await import("./sessionMemory.js");
        getOrCreateSession(reply.username);
        addTurn(reply.username, { direction: "them", text: reply.text, kbEntryIds: [], timestamp: Date.now() });
      } catch {}

      // Research the topic if: (a) flagged as needsResearch, (b) from @MrRayG, or (c) AI/tech topic
      let researchContext = "";
      const isNonEcosystem = !/306|agent.?306/i.test(reply.text);
      const isAIOrTech = /ai|gpt|llm|model|agent|openai|nvidia|jensen|robot|inference|blockchain|crypto|bitcoin|ethereum/i.test(reply.text);
      const isMrRayG = reply.username.toLowerCase() === "mrrrayg" || reply.username.toLowerCase() === "mrrayg" || (reply as any).isMrRayG;

      if ((reply as any).needsResearch || (isMrRayG && isNonEcosystem) || (isNonEcosystem && isAIOrTech)) {
        console.log(`[ReplyEngine] Researching topic for @${reply.username}: "${reply.text.slice(0, 60)}..."`);
        researchContext = await researchTopicForReply(reply.text.slice(0, 200));
        if (researchContext) {
          console.log(`[ReplyEngine] Research complete (${researchContext.length} chars)`);
        }
      }

      // Generate the reply
      const generated = await generateReply({
        username:        reply.username,
        text:            reply.text,
        replyType:       reply.replyType,
        tokenMentioned:  reply.tokenMentioned ?? null,
        tweetUrl:        reply.tweetUrl,
        researchContext: researchContext || undefined,
      });

      if (!generated) {
        console.warn(`[ReplyEngine] No reply generated for @${reply.username}`);
        releasePost(`reply_${reply.username}`);
        continue;
      }

      // Quality gate
      const { pass, rewrite } = await qualityGateReply(generated);
      let finalText = rewrite ?? generated;
      // Guarantee signature on every reply, even after quality gate rewrites
      if (finalText && !finalText.includes("Agent 306")) {
        finalText = finalText + "\n\u2014 Agent 306";
      }

      if (!pass) {
        console.log(`[ReplyEngine] Reply to @${reply.username} failed quality gate — skipping.`);
        releasePost(`reply_${reply.username}`);
        state.repliedTo.push(key); // mark as seen so we don't retry forever
        const failedTweetId = (reply as any).tweetId || reply.tweetUrl?.match(/status\/(\d+)/)?.[1];
        if (failedTweetId) state.repliedToTweetIds.push(failedTweetId);
        continue;
      }

      // Build the X reply payload
      // If we have a tweet URL, extract the tweet ID to reply in-thread
      const tweetIdMatch = reply.tweetUrl?.match(/status\/(\d+)/);
      const inReplyToId  = tweetIdMatch?.[1];

      const compliance = validateXPost(finalText, {
        isReply: true,
        replyToUser: reply.username,
        replyToPostId: inReplyToId,
      });
      if (!compliance.allowed) {
        console.log(`[ReplyEngine] Reply to @${reply.username} skipped by compliance: ${compliance.reason}`);
        releasePost(`reply_${reply.username}`);
        continue;
      }
      const safeText = compliance.sanitizedContent ?? finalText;

      const payload: any = { text: safeText };
      if (inReplyToId) payload.reply = { in_reply_to_tweet_id: inReplyToId };

      const posted = await xWrite.v2.tweet(payload);
      const tweetUrl = posted.data?.id
        ? `https://x.com/306Agent/status/${posted.data.id}`
        : null;

      recordXPost(safeText, { isReply: true, replyToUser: reply.username, replyToPostId: inReplyToId });
      registerPost(`reply_${reply.username}`, tweetUrl, "reply_engine");
      state.repliedTo.push(key);
      // Track tweet ID for reliable dedup
      const origTweetId = (reply as any).tweetId || reply.tweetUrl?.match(/status\/(\d+)/)?.[1];
      if (origTweetId) state.repliedToTweetIds.push(origTweetId);
      state.totalRepliesSent++;

      // Record outgoing reply in conversation memory
      try {
        const { recordOutgoing } = await import("./conversationMemory.js");
        recordOutgoing(reply.username, finalText, tweetUrl ?? undefined);
      } catch {}

      // Record outgoing in session memory (non-fatal)
      try {
        const { addTurn } = await import("./sessionMemory.js");
        addTurn(reply.username, { direction: "us", text: finalText, kbEntryIds: [], timestamp: Date.now() });
      } catch {}

      console.log(`[ReplyEngine] Replied to @${reply.username}: "${finalText.slice(0, 60)}..." → ${tweetUrl}`);

      // Small human-like gap between replies (30-60s)
      await new Promise(r => setTimeout(r, 30000 + Math.random() * 30000));

    } catch (err: any) {
      console.error(`[ReplyEngine] Failed to reply to @${reply.username}:`, err.message);
      releasePost(`reply_${reply.username}`);
    }
  }

  // Keep dedup lists from growing forever — keep last 500
  if (state.repliedTo.length > 500) {
    state.repliedTo = state.repliedTo.slice(-500);
  }
  if (state.repliedToTweetIds && state.repliedToTweetIds.length > 500) {
    state.repliedToTweetIds = state.repliedToTweetIds.slice(-500);
  }

  state.lastRunAt = new Date().toISOString();
  saveState(state);
  console.log(`[ReplyEngine] Cycle complete. Total replies sent: ${state.totalRepliesSent}`);
}

// ── Farcaster Reply Cycle ────────────────────────────────────────────────────
// Parallel to the X reply cycle. Fetches Farcaster mentions, generates replies
// via the same Grok pipeline, posts via farcasterEngine.replyCast().
export async function runFarcasterReplies(): Promise<void> {
  // DISABLED: All auto-replies turned off to avoid spam risk
  if (!process.env.X_REPLIES_ENABLED) {
    console.log("[ReplyEngine:FC] Replies disabled (X_REPLIES_ENABLED not set) — skipping Farcaster reply cycle");
    return;
  }
  let fcEngine: typeof import("./farcasterEngine.js") | null = null;
  try {
    fcEngine = await import("./farcasterEngine.js");
  } catch { return; }

  if (!fcEngine.isFarcasterEnabled()) {
    console.log("[ReplyEngine:FC] Farcaster disabled — skipping reply cycle");
    return;
  }

  const state = loadState();
  console.log("[ReplyEngine:FC] Farcaster reply cycle starting...");

  const mentions = await fcEngine.fetchMentions({ limit: 25 });
  if (mentions.length === 0) {
    console.log("[ReplyEngine:FC] No new Farcaster mentions.");
    return;
  }

  console.log(`[ReplyEngine:FC] ${mentions.length} new mentions to process`);

  let repliesSent = 0;
  for (const mention of mentions.slice(0, 5)) { // max 5 replies per cycle
    if (!requestPost(`fc_reply_${mention.username}`, false, "farcaster")) {
      console.log(`[ReplyEngine:FC] Coordinator blocked reply to @${mention.username}`);
      continue;
    }

    try {
      // Generate reply via same Grok pipeline
      const generated = await generateReply({
        username:       mention.username,
        text:           mention.text,
        replyType:      mention.type === "reply" ? "direct_reply" : "mention",
        tokenMentioned: null,
      });

      if (!generated) {
        releasePost(`fc_reply_${mention.username}`, "farcaster");
        continue;
      }

      // Quality gate
      const { pass, rewrite } = await qualityGateReply(generated);
      let finalText = rewrite ?? generated;
      if (finalText && !finalText.includes("Agent 306")) {
        finalText = finalText + "\n\u2014 Agent 306";
      }

      if (!pass) {
        console.log(`[ReplyEngine:FC] Reply to @${mention.username} failed quality gate`);
        releasePost(`fc_reply_${mention.username}`, "farcaster");
        fcEngine.markMentionReplied(mention.hash);
        continue;
      }

      // Post reply to Farcaster
      const result = await fcEngine.replyCast({
        text: finalText,
        parentHash: mention.hash,
      });

      if (result) {
        registerPost(`fc_reply_${mention.username}`, result.url, "reply_engine", "farcaster");
        fcEngine.markMentionReplied(mention.hash);
        repliesSent++;
        console.log(`[ReplyEngine:FC] Replied to @${mention.username}: "${finalText.slice(0, 60)}..." → ${result.url}`);
      } else {
        releasePost(`fc_reply_${mention.username}`, "farcaster");
      }

      // Human-like gap between replies
      await new Promise(r => setTimeout(r, 15000 + Math.random() * 15000));
    } catch (err: any) {
      console.error(`[ReplyEngine:FC] Failed to reply to @${mention.username}:`, err.message);
      releasePost(`fc_reply_${mention.username}`, "farcaster");
    }
  }

  console.log(`[ReplyEngine:FC] Cycle complete. ${repliesSent} Farcaster replies sent.`);
}

// ── Scheduler — fetch fresh mentions then reply, every hour ──────────────────
export function scheduleMidnightReplies(xWrite: any): void {
  // DISABLED: X replies turned off to avoid spam risk
  if (!process.env.X_REPLIES_ENABLED) {
    console.log("[ReplyEngine] X replies disabled (X_REPLIES_ENABLED not set) — not scheduling reply engine");
    return;
  }
  // Add ±15min jitter so X doesn't flag as automated bot (fixed intervals = spam signal)
  const BASE_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour base
  function nextInterval() {
    const jitter = (Math.random() - 0.5) * 2 * 15 * 60 * 1000; // ±15 min
    return Math.max(BASE_INTERVAL_MS * 0.5, BASE_INTERVAL_MS + jitter);
  }

  async function fetchThenReply() {
    const { fetchReplies } = await import("./replyWatcher.js");

    // Always fetch fresh mentions — never skip. Engagement requires consistency.
    console.log("[ReplyEngine] Fetching fresh mentions...");
    await fetchReplies().catch(console.error);
    await new Promise(r => setTimeout(r, 8000));

    console.log("[ReplyEngine] Running reply cycle...");
    // Run X and Farcaster reply cycles in parallel
    await Promise.allSettled([
      runMidnightReplies(xWrite).catch(console.error),
      runFarcasterReplies().catch(console.error),
    ]);
  }

  // First run: 2 min after boot (get engaging quickly)
  setTimeout(() => fetchThenReply(), 2 * 60 * 1000);

  // Then every hour — fetch + reply together
  // Re-schedule with new jitter after each run (not fixed interval)
  function scheduleNext() {
    const next = nextInterval();
    console.log("[ReplyEngine] Next reply cycle in " + Math.round(next / 60000) + "min");
    setTimeout(() => { fetchThenReply().then(scheduleNext); }, next);
  }
  scheduleNext();

  console.log("[ReplyEngine] Reply engine scheduled — ~1h intervals with ±15min jitter");
}
