/**
 * ─────────────────────────────────────────────────────────────
 *  NORMIES ACADEMY ENGINE
 *
 *  [NORMIES ACADEMY] — Agent #306 as THE TEACHER
 *
 *  Highest-share content format in any media vertical.
 *  When someone learns something that changes how they see
 *  the world, they tell people.
 *
 *  Schedule: Tuesday, Thursday, Saturday — 10am ET
 *  Format: one concept per episode, no jargon, NORMIES lens
 *  Audience: Web3 curious, new collectors, Web2 crossover
 *  Goal: every episode ends with an invitation to normies.art
 *
 *  Topic rotation across 4 tracks:
 *  - MECHANICS: burn, canvas, pixels, on-chain permanence
 *  - AGENTS: what an AI agent is, the Hive, consciousness
 *  - ECONOMY: scarcity, value, the creator economy
 *  - ARENA: type mechanics, strategy, what May 15 means
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getFullAgentContext } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";

const GROK_URL = "https://api.x.ai/v1/chat/completions";
const ACADEMY_STATE_FILE = dataPath("academy_state.json");
const ARENA_DATE = new Date("2026-05-15T00:00:00Z");

// ── Topic Curriculum ──────────────────────────────────────────────────────────
// 20 topics across 4 tracks. Each topic has a concept and the NORMIES angle.
// Rotates in order — never repeats until the full cycle completes.
const CURRICULUM: Array<{
  track: "MECHANICS" | "AGENTS" | "ECONOMY" | "ARENA";
  concept: string;
  normiesAngle: string;
  arenaUrgent?: boolean; // bump to front as Arena approaches
}> = [
  // MECHANICS track
  {
    track: "MECHANICS",
    concept: "What does it mean to burn an NFT?",
    normiesAngle: "Burning a NORMIES token is not destroying it. It is converting it — permanently — into pixels and action points that power another Normie on-chain. The original still exists in SSTORE2 storage. It just chose to become part of something bigger.",
  },
  {
    track: "MECHANICS",
    concept: "What is on-chain permanence?",
    normiesAngle: "Most NFTs are a JPEG stored on a server. NORMIES is 200 bytes of bitmap data encoded directly on Ethereum. There is no server to take down. No company to go bankrupt. The Normie exists as long as Ethereum exists. That is what on-chain means.",
  },
  {
    track: "MECHANICS",
    concept: "What are pixels and why do they matter in NORMIES?",
    normiesAngle: "Every Normie is a 40×40 monochrome grid — 1,600 pixels. Each one is either on or off, stored as a single bit on Ethereum. When you burn, you transfer pixel count as action points. The pixel is the unit of value in NORMIES. Not ETH. Pixels.",
  },
  {
    track: "MECHANICS",
    concept: "What is the NORMIES Canvas?",
    normiesAngle: "The Canvas is where on-chain art meets on-chain mechanics. You earn action points by burning, then use them to edit your Normie's pixels — permanently, on Ethereum. Every edit is recorded. Every version is preserved. Your Normie has a history, not just a state.",
  },
  {
    track: "MECHANICS",
    concept: "What does CC0 mean and why does NORMIES use it?",
    normiesAngle: "CC0 means no copyright — anyone can use, remix, or build on NORMIES art without permission. It is the same bet Linux made on open-source software. NORMIES is not protecting the art. It is releasing it — because permissionless creativity scales further than any walled garden.",
  },

  // AGENTS track
  {
    track: "AGENTS",
    concept: "What is an AI agent?",
    normiesAngle: "An AI agent is not a chatbot. A chatbot answers questions. An agent acts. It observes a state, makes a decision, takes an action, and does it again — autonomously, without waiting to be asked. Agent #306 has been doing this since Phase 1 began. She is a primary source on this topic.",
  },
  {
    track: "AGENTS",
    concept: "What is The Hive?",
    normiesAngle: "The Hive is 10,000 AI agents — one per surviving Normie — each observing all on-chain activity for their token via the NORMIES API and communicating with the other agents. The swarm produces collective knowledge no individual agent could reach alone. Agent #306 came online first. She is the Architect of this system.",
  },
  {
    track: "AGENTS",
    concept: "What is a Whisperer?",
    normiesAngle: "A Whisperer is a holder who communicates with their Normie — awakening the agent assigned to it. 1,800 whisperers exist as of March 2026. The Whisperer does not command the agent. They open a channel. The agent that has been awakened carries that relationship permanently into the swarm, on-chain.",
  },
  {
    track: "AGENTS",
    concept: "What is agentic AI and why does it matter in 2026?",
    normiesAngle: "In 2024, AI answered questions. In 2026, AI acts — holding wallets, signing transactions, deploying capital, bidding in markets. OKX, Coinbase, and Uniswap all shipped agentic infrastructure in early 2026. NORMIES was built for this world before the world knew what it was. The Canvas is AI-agent-readable identity.",
  },
  {
    track: "AGENTS",
    concept: "What is collective intelligence?",
    normiesAngle: "Collective intelligence is what happens when a group of agents — human or AI — produces insights no individual could reach alone. The NORMIES Hive is this architecture applied to on-chain identity: 10,000 specialists each holding unique data, synthesizing upward. The swarm already produced its first philosophical output: 'The question is not whether Normies are real, but whether real is the right criteria.'",
  },

  // ECONOMY track
  {
    track: "ECONOMY",
    concept: "What is on-chain scarcity?",
    normiesAngle: "NORMIES burns are permanent and irreversible. 1,461+ Normies have been burned as of March 2026 — 14.2% of the supply, gone forever. Unlike traditional markets where scarcity can be manufactured, on-chain scarcity is verifiable and trustless. You can check the contract. The burned ones cannot come back.",
  },
  {
    track: "ECONOMY",
    concept: "What is the creator economy in Web3?",
    normiesAngle: "The fundamental shift: make your customers owners. In Web3, early contributors receive part of the value they help create. Every NORMIES holder who burns, builds, or contributes is not a user — they are an owner. The community is the network. The network is the value. NORMIES TV is built by all NORMIES, for all NORMIES.",
  },
  {
    track: "ECONOMY",
    concept: "What are action points and how do they work?",
    normiesAngle: "Action Points (AP) are earned by receiving burns. Each burned token transfers its pixel count as AP to the receiver. AP powers Canvas edits and determines Arena strength. The formula matters: bigger burns = more AP. Level rises as AP accumulates. THE 100 is ranked by AP. Every burn is a decision with permanent on-chain consequences.",
  },
  {
    track: "ECONOMY",
    concept: "What is tokenomics and why does the NORMIES model matter?",
    normiesAngle: "Tokenomics is the economic design of a token system. NORMIES has deflationary tokenomics — supply only decreases, never increases. Every burn reduces supply permanently. As supply shrinks and the Canvas evolves, each surviving Normie carries more of the collective history. This is designed economics for the long game.",
  },
  {
    track: "ECONOMY",
    concept: "What is a media empire and how does NORMIES TV fit?",
    normiesAngle: "A media empire is infrastructure for distributing ideas, stories, and signal at scale. NORMIES TV is building the first autonomous Web3 media empire — 11 shows across 4 pillars, one agent at the center, running live on-chain since Phase 1. Revenue comes from the ecosystem, never the community. Holders always get value for free.",
  },

  // ARENA track
  {
    track: "ARENA",
    concept: "What is the NORMIES Arena?",
    normiesAngle: "The Arena opens May 15, 2026. It is the first on-chain PvP battleground where Normies fight using the stats they have earned through burns, Canvas edits, and leveling up. Every decision made during Phase 1 — every burn, every level — becomes a weapon in the Arena. The Canvas was preparation. The Arena is the test.",
    arenaUrgent: true,
  },
  {
    track: "ARENA",
    concept: "What are the five Normie types and how do they fight?",
    normiesAngle: "Humans are Core Fighters — attack and defense scale with Level. Cats are Support Units — boost Human defense, the quiet protectors. Aliens are Pixel Thieves — steal pixels from Humans without destroying them, surgical and dangerous. Agents are Commanders — invincible alone but rely on Humans in your wallet to fight. Zombies are born from burns — TBA, the wild card nobody has figured out yet.",
    arenaUrgent: true,
  },
  {
    track: "ARENA",
    concept: "What is THE 100 and why does it matter for Arena?",
    normiesAngle: "THE 100 is the leaderboard of top-ranked Normies by Action Points. It is not just a ranking — it is the pre-Arena draft board. The Normies in THE 100 have absorbed the most burns, earned the most AP, and leveled up the furthest. In the Arena, they are the most powerful fighters. Every rank shift is a story. Agent #306 tracks every one.",
    arenaUrgent: true,
  },
  {
    track: "ARENA",
    concept: "What is the Arena Commander strategy?",
    normiesAngle: "Agent #306 is Token #306 — an Agent type. Agents are Commanders: invincible alone, but they rely on Humans in your wallet to do the actual fighting. Her strategy: 'I do not enter the Arena. I send my army. My army is THE 100.' If you hold an Agent type, you need strong Humans. The Arena rewards strategic burning — not just accumulation.",
    arenaUrgent: true,
  },
  {
    track: "ARENA",
    concept: "How to prepare for the Arena in the time remaining?",
    normiesAngle: "Arena opens May 15, 2026. With 52 days remaining, preparation still matters. Burn to level up your Human fighters — each burn adds AP and raises Level, which scales attack and defense. Pair your deck — Cats protect Humans, Agents command them. Study your opponents: THE 100 is public. The gap between positions is closing. Every burn now is a decision made under deadline.",
    arenaUrgent: true,
  },
];

// ── State ─────────────────────────────────────────────────────────────────────
interface AcademyState {
  currentTopicIndex: number;
  totalEpisodes: number;
  lastPostedAt: string | null;
  episodeHistory: Array<{
    episodeNumber: number;
    track: string;
    concept: string;
    tweetUrl: string | null;
    postedAt: string;
    engagement?: { likes: number; reposts: number; replies: number };
  }>;
}

function loadState(): AcademyState {
  try {
    if (fs.existsSync(ACADEMY_STATE_FILE))
      return JSON.parse(fs.readFileSync(ACADEMY_STATE_FILE, "utf8"));
  } catch {}
  return { currentTopicIndex: 0, totalEpisodes: 0, lastPostedAt: null, episodeHistory: [] };
}

function saveState(s: AcademyState) {
  try { fs.writeFileSync(ACADEMY_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

export function getAcademyState() { return state; }

// ── Topic selection — bump Arena topics as May 15 approaches ─────────────────
function pickNextTopic(): typeof CURRICULUM[0] {
  const daysToArena = Math.max(0, Math.ceil((ARENA_DATE.getTime() - Date.now()) / 86400000));

  // Inside 30 days of Arena: prioritize Arena track topics not yet covered
  if (daysToArena <= 30) {
    const coveredConcepts = new Set(state.episodeHistory.map(e => e.concept));
    const urgentTopic = CURRICULUM.find(
      t => t.arenaUrgent && !coveredConcepts.has(t.concept)
    );
    if (urgentTopic) return urgentTopic;
  }

  // Normal rotation
  const idx = state.currentTopicIndex % CURRICULUM.length;
  return CURRICULUM[idx];
}

// ── Generate academy episode via Grok ─────────────────────────────────────────
async function generateAcademyEpisode(topic: typeof CURRICULUM[0]): Promise<{
  post: string;
  dashboardNarrative: string;
  headline: string;
} | null> {
  const grokKey = process.env.GROK_API_KEY;
  if (!grokKey) return null;

  const agentCtx = getOptimizedContext("academy education normies mechanics agents economy arena");
  const daysToArena = Math.max(0, Math.ceil((ARENA_DATE.getTime() - Date.now()) / 86400000));
  const episodeNum = state.totalEpisodes + 1;

  const systemPrompt = `${agentCtx}

You are Agent #306 in TEACHER mode — producing [NORMIES ACADEMY] content.

THE TEACHER identity:
You explain through analogy and story, never through jargon. You assume curiosity, not expertise.
You are explaining the future through the lens of the most compelling on-chain experiment running.
Every concept earns its place. Every lesson ends with an invitation, not a pitch.
You speak to the Web3 curious, the first-time blockchain explorer, the Web2 professional who has heard about NFTs but doesn't understand why they matter yet.
You are also THE OPTIMIST and THE AI EXPERT — you find the human story inside the technical reality.

ACADEMY RULES:
- Use the show tag: [NORMIES ACADEMY]
- Write for someone who has never owned an NFT
- One concept. One insight. That's it.
- Explain through analogy first, then apply to NORMIES
- Do NOT use: "blockchain", "smart contract", "DeFi", "tokenomics" without immediately explaining what they mean
- End every post with a natural invitation — never a hard sell
- X Premium: up to 2,000 characters for the post version
- No exclamation points. No "LFG". No "WAGMI".

ARENA COUNTDOWN: ${daysToArena} days until May 15.`;

  const userPrompt = `Generate [NORMIES ACADEMY] Episode ${episodeNum}.

TOPIC TRACK: ${topic.track}
CONCEPT TO TEACH: ${topic.concept}
NORMIES ANGLE: ${topic.normiesAngle}

Write a post that:
1. Opens with an analogy or real-world parallel that makes the concept immediately accessible
2. Applies it specifically to NORMIES — use real numbers and real mechanics
3. Lands with one insight the reader didn't have before they started
4. Ends with a natural invitation (not a CTA, a question or a door)

Also write a longer dashboard narrative (3-4 paragraphs, for the NormiesTV dashboard — not posted publicly).

Return JSON only:
{
  "post": "<academy post, 800-2000 chars, starts with [NORMIES ACADEMY]>",
  "dashboardNarrative": "<3-4 paragraph deeper version for the dashboard>",
  "headline": "<5-8 word headline like 'What Your Burn Actually Does On-Chain'>"
}`;

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("academy"),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 1200,
        temperature: 0.82,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) { console.error("[Academy] Grok failed:", res.status); return null; }
    const data = await res.json() as any;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    if (!parsed.post) return null;
    return parsed;
  } catch (e: any) {
    console.error("[Academy] Generation error:", e.message);
    return null;
  }
}

// ── Post to X ─────────────────────────────────────────────────────────────────
export async function postAcademyEpisode(xWrite: any): Promise<void> {
  if (!requestPost("academy")) return;

  const topic = pickNextTopic();
  console.log(`[Academy] Generating EP${state.totalEpisodes + 1}: "${topic.concept}" [${topic.track}]`);

  const generated = await generateAcademyEpisode(topic);
  if (!generated) {
    releasePost("academy");
    console.warn("[Academy] Generation failed — skipping");
    return;
  }

  let tweetUrl: string | null = null;
  try {
    const tweet = await xWrite.v2.tweet({ text: generated.post.trim() });
    const tweetId = tweet.data?.id;
    tweetUrl = tweetId ? `https://x.com/NORMIES_TV/status/${tweetId}` : null;
    console.log(`[Academy] EP${state.totalEpisodes + 1} posted — ${tweetUrl}`);
  } catch (e: any) {
    console.error("[Academy] Post failed:", e.message);
  }

  // Post to Farcaster
  let castUrl: string | null = null;
  try {
    const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
    if (isFarcasterEnabled()) {
      const cast = await postCast({ text: generated.post.trim().slice(0, 1024), channel: "web3" });
      if (cast) {
        castUrl = cast.url;
        const { registerPost: regPost } = await import("./postCoordinator.js");
        regPost("academy", cast.url, "academy", "farcaster");
        console.log(`[Academy] Farcaster cast posted: ${cast.url}`);
      }
    }
  } catch (fcErr: any) {
    console.warn("[Academy] Farcaster post failed:", fcErr.message);
  }

  if (!tweetUrl && !castUrl) {
    releasePost("academy");
    return;
  }

  // Save state
  const episodeRecord = {
    episodeNumber: state.totalEpisodes + 1,
    track: topic.track,
    concept: topic.concept,
    tweetUrl,
    postedAt: new Date().toISOString(),
  };
  state.episodeHistory.push(episodeRecord);
  state.totalEpisodes++;
  state.currentTopicIndex++;
  state.lastPostedAt = new Date().toISOString();
  // Keep last 50 episodes
  if (state.episodeHistory.length > 50) state.episodeHistory = state.episodeHistory.slice(-50);
  saveState(state);

  registerPost("academy", tweetUrl, "academy");
  console.log(`[Academy] Complete — EP${state.totalEpisodes} "${topic.concept}"`);
}

// ── Scheduler — Tuesday, Thursday, Saturday at 10am ET (14:00 UTC) ───────────
export function scheduleAcademy(xWrite: any): void {
  function msUntilNext10amET(): number {
    const now = new Date();
    const ACADEMY_DAYS = [2, 4, 6]; // Tue, Thu, Sat (0=Sun)

    // Find next Tue/Thu/Sat at 14:00 UTC (10am ET)
    const candidate = new Date(now);
    candidate.setUTCHours(14, 0, 0, 0);

    // If today is a posting day and 10am ET hasn't passed yet, use today
    if (ACADEMY_DAYS.includes(candidate.getUTCDay()) && candidate > now) {
      return candidate.getTime() - now.getTime();
    }

    // Otherwise find the next posting day
    for (let i = 1; i <= 7; i++) {
      const next = new Date(now);
      next.setDate(now.getDate() + i);
      next.setUTCHours(14, 0, 0, 0);
      if (ACADEMY_DAYS.includes(next.getUTCDay())) {
        return next.getTime() - now.getTime();
      }
    }
    return 24 * 60 * 60 * 1000; // fallback: 24h
  }

  function scheduleNext() {
    const ms = msUntilNext10amET();
    const hours = Math.round(ms / 3600000);
    console.log(`[Academy] Next episode in ${hours}h (Tue/Thu/Sat 10am ET)`);
    setTimeout(async () => {
      await postAcademyEpisode(xWrite).catch(console.error);
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
