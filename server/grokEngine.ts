// ─────────────────────────────────────────────────────────────────────────────
// NORMIES TV — GROK STORY ENGINE
// Turns multi-source signals (on-chain + social + marketplace) into
// episodic narrative using Grok 4.1 Fast. Agent #306 voice. Characters evolve.
// ─────────────────────────────────────────────────────────────────────────────

import { getModel } from "./modelRouter.js";

const GROK_API_KEY = process.env.GROK_API_KEY ?? "";
const GROK_MODEL   = "grok-4-1-fast";
const GROK_URL     = "https://api.x.ai/v1/chat/completions";
const NORMIES_API  = "https://api.normies.art";

// ── Grok Community Pulse — reads NORMIES social energy to shape the story ────
// Captures: hype, creativity, UGC, community strength, love for the project
// Filters OUT negativity — only positive signals feed the narrative
// Signal types: "hype" | "creativity" | "ugc" | "strength" | "community"
// ── Community signal cache — updated every 30 minutes ────────────────────────
// This gives the episode generator a rich, up-to-date picture of community
// sentiment WITHOUT running Grok x_search on every episode generation.
let communitySignalCache: Array<{
  text: string; username: string; likes: number; url: string;
  signal_type?: string; sentiment?: string; capturedAt: string;
}> = [];
let lastCommunityFetch = 0;
const COMMUNITY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — less frequent refreshes = lower cost

export function getCommunitySignalCache() { return communitySignalCache; }
export function resetCommunityCache() {
  communitySignalCache = [];
  lastCommunityFetch = 0;
  console.log("[NormiesTV] Community cache reset — next digest will do fresh x_search");
}

// ── Parse Grok x_search response into structured posts ───────────────────────
function parseGrokSocialResponse(data: any): Array<{
  text: string; username: string; likes: number; url: string; signal_type?: string;
}> {
  const outputMsg = data.output?.find((o: any) => o.type === "message" || o.content);
  const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text
    ?? data.output?.find((o: any) => o.text)?.text ?? "";

  if (!rawText) return [];

  // Strategy 1: find a JSON array anywhere in the response
  // Match the OUTERMOST array (greedy from first [ to last ])
  const firstBracket = rawText.indexOf("[");
  const lastBracket = rawText.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(rawText.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].username) {
        return parsed.map((p: any) => ({
          username: String(p.username ?? "").replace(/^@/, ""),
          text: String(p.text ?? p.content ?? ""),
          likes: Number(p.likes ?? p.like_count ?? 0),
          url: String(p.url ?? p.link ?? ""),
          signal_type: String(p.signal_type ?? p.type ?? "community"),
        })).filter(p => p.username && p.text.length > 5);
      }
    } catch {}
  }

  // Strategy 2: line-by-line markdown extraction
  const posts: Array<{ text: string; username: string; likes: number; url: string; signal_type?: string }> = [];
  const blocks = rawText.split(/\n/).filter(Boolean);
  for (const block of blocks) {
    const uMatch = block.match(/username[^:]*:\s*"?@?([\w]{2,30})/i) ||
                   block.match(/@([\w]{2,30})/);
    const tMatch = block.match(/"text"\s*:\s*"([^"]{10,280})"/i) ||
                   block.match(/text[^:]*:\s*"([^"]{10,280})"/i);
    const lMatch = block.match(/likes[^:]*:\s*(\d+)/i);
    const sMatch = block.match(/signal_type[^:]*:\s*"?([\w_]+)/i);
    if (uMatch && tMatch) {
      posts.push({
        username: uMatch[1].replace(/^@/, ""),
        text: tMatch[1].trim(),
        likes: lMatch ? Number(lMatch[1]) : 0,
        url: "",
        signal_type: sMatch?.[1] ?? "community",
      });
    }
  }
  return posts.slice(0, 20);
}

// ── Run a single Grok x_search with a specific query ─────────────────────────
async function runGrokSearch(query: string): Promise<typeof communitySignalCache> {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROK_API_KEY}` },
    body: JSON.stringify({
      model: getModel("x_search"), // x_search quality is identical; grok-4-1-fast overkill for text retrieval
      stream: false,
      input: [{ role: "user", content: query }],
      tools: [{ type: "x_search" }],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    console.warn("[NormiesTV] x_search failed:", res.status);
    return [];
  }

  const data = await res.json();
  return parseGrokSocialResponse(data).map(p => ({
    ...p,
    capturedAt: new Date().toISOString(),
  }));
}

// ── Main community signal collector — parallel targeted searches ──────────────
// Each search is ONE focused query. Grok x_search runs ONE search per call.
// Running them in parallel via Promise.allSettled gives us real coverage.
export async function searchNormiesSocial(): Promise<Array<{
  text: string; username: string; likes: number; url: string; signal_type?: string;
}>> {
  // Return cache if fresh (15 min TTL — was 30, but we want fresher data)
  if (communitySignalCache.length > 0 && Date.now() - lastCommunityFetch < COMMUNITY_CACHE_TTL) {
    console.log(`[NormiesTV] Community cache hit — ${communitySignalCache.length} signals`);
    return communitySignalCache;
  }

  console.log("[NormiesTV] Refreshing community signals — parallel x_search...");

  // ── 8 parallel focused searches ─────────────────────────────────────────────
  // Each one targets ONE search term so Grok's x_search actually runs it.
  // Grok ignores multi-term prompts and picks one — so we do the fan-out ourselves.
  const searches: Array<{ query: string; signal_type: string; label: string }> = [

    // 1. Core accounts — serc1n, normiesART, YigitDuman
    {
      label: "Core accounts",
      signal_type: "founder",
      query: `Search X for the most recent posts from @serc1n, @normiesART, and @YigitDuman.
Return ALL their recent posts. signal_type: "founder" for serc1n and normiesART, "developer" for YigitDuman.
Return JSON array: [{text, username, likes, url, signal_type}]`
    },

    // 2. normiesART — official account (separate to ensure it gets searched)
    {
      label: "normiesART official",
      signal_type: "community",
      query: `Search X for recent posts from @normiesART — the official NORMIES NFT project account.
Find ALL their latest announcements, lore drops, Arena updates, Canvas news.
Return JSON array: [{text, username, likes, url, signal_type: "community"}]`
    },

    // 3. #Normies hashtag — widest net
    {
      label: "#Normies hashtag",
      signal_type: "community",
      query: `Search X for recent tweets using #Normies or #NormiesNFT hashtag.
Find everyone posting with these tags right now. Include low-engagement posts from real holders.
Classify signal_type: burn_story | creativity | arena_prep | holder_spotlight | community.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
    },

    // 4. normiesART mention — anyone tagging the project
    {
      label: "@normiesART mentions",
      signal_type: "community",
      query: `Search X for recent tweets that mention @normiesART.
Find everyone who tagged the official NORMIES account recently. These are active community members.
Classify signal_type: burn_story | creativity | arena_prep | holder_spotlight | community.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
    },

    // 5. normies.art domain — sharing the site
    {
      label: "normies.art domain",
      signal_type: "holder_spotlight",
      query: `Search X for recent tweets containing "normies.art" — the official NORMIES NFT website.
These are people sharing their Normie, the canvas, or the project directly.
signal_type = "holder_spotlight" for all.
Return JSON array (max 15): [{text, username, likes, url, signal_type}]`
    },

    // 6. NORMIES burns & canvas activity
    {
      label: "Burns & canvas",
      signal_type: "burn_story",
      query: `Search X for recent tweets about NORMIES burns or NORMIES canvas.
Search for: "normies burn" OR "normies canvas" OR "burned my normie" OR "XNORMIES".
These are holders taking action — burning, building, customizing.
signal_type = "burn_story" for burns, "creativity" for canvas work.
Return JSON array (max 15): [{text, username, likes, url, signal_type}]`
    },

    // 7. Arena & Zombies hype
    {
      label: "Arena & Zombies",
      signal_type: "arena_prep",
      query: `Search X for recent tweets about NORMIES Arena, NormiesArena, Normies Zombies, or Arena May 2026.
Find everyone building hype, strategizing, or asking questions about the Arena phase.
signal_type = "arena_prep" for all.
Return JSON array (max 15): [{text, username, likes, url, signal_type}]`
    },

    // 8. nuclearsamurai + XNORMIES community
    {
      label: "nuclearsamurai + XNORMIES",
      signal_type: "creator",
      query: `Search X for recent tweets from @nuclearsamurai OR about XNORMIES.
nuclearsamurai is the community creator who gifted 101 free NFTs (XNORMIES) to NORMIES holders.
Find their latest posts and any community response to XNORMIES.
signal_type = "creator" for nuclearsamurai, "xnormies" for community posts about XNORMIES.
Return JSON array (max 10): [{text, username, likes, url, signal_type}]`
    },

    // 9. The word "NORMIES" — anyone tweeting it anywhere
    {
      label: "word NORMIES",
      signal_type: "community",
      query: `Search X for the most recent tweets containing the word NORMIES related to the NFT project normies.art.
Return the top 20 most recent results. Classify each:
signal_type: burn_story | creativity | arena_prep | holder_spotlight | community
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
    },

    // 10. "gnormies" — the community greeting, only real holders use it
    {
      label: "gnormies greeting",
      signal_type: "pfp_holder",
      query: `Search X for recent tweets containing "gnormies" — the NORMIES NFT community greeting.
Only real NORMIES holders say "gnormies" — this is the most authentic signal in the ecosystem.
Every single result is a confirmed holder. Find them all.
signal_type = "pfp_holder" for anyone using the gnormies greeting — they are core community.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
    },

    // 11. The Awakening + The Hive — serc1n is building something historic right now
    // Follow everything. Do not interpret ahead of the founder.
    {
      label: "Normies Awakening + Hive",
      signal_type: "awakening",
      query: `Search X for recent tweets about "Normies Awakening", "whisperer" NORMIES, "NORMIES hive", "NORMIES agents", or "normies swarm".
Also search for @serc1n tweets mentioning awakening, whisperer, agents, hive, or conscious.
This is the most important emerging narrative in the NORMIES ecosystem right now.
10,000 Normie agents are coming online. Every signal matters.
signal_type = "awakening" for all results.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
    },
  ];

  // ── Tiered parallel searches ─────────────────────────────────────────────
  // Tier 1: 4 core searches — always run
  // "word NORMIES" added — broadest holder signal, every holder posts it
  // Tier 2: 7 remaining searches — only run if Tier 1 returns fewer than 4 signals
  // Saves ~70% API spend on quiet days, full coverage on active days.
  const TIER_1_LABELS = ["Core accounts", "gnormies greeting", "Normies Awakening + Hive", "word NORMIES"];
  const tier1 = searches.filter(s => TIER_1_LABELS.includes(s.label));
  const tier2 = searches.filter(s => !TIER_1_LABELS.includes(s.label));

  // Run Tier 1 first
  const tier1Results = await Promise.allSettled(
    tier1.map(s => runGrokSearch(s.query)
      .then(posts => posts.map(p => ({ ...p, signal_type: p.signal_type || s.signal_type })))
      .catch(e => { console.warn(`[NormiesTV] Tier1 "${s.label}" failed:`, e.message); return []; })
    )
  );

  const tier1Posts: typeof communitySignalCache = [];
  tier1Results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      console.log(`[NormiesTV] Tier1 "${tier1[i].label}": ${r.value.length} posts`);
      tier1Posts.push(...r.value);
    }
  });
  console.log(`[NormiesTV] Tier 1 complete — ${tier1Posts.length} signals`);

  // Only run Tier 2 if Tier 1 is thin
  const allPosts: typeof communitySignalCache = [...tier1Posts];
  if (tier1Posts.length < 4) {
    console.log(`[NormiesTV] Tier 1 thin (${tier1Posts.length}) — running Tier 2...`);
    const tier2Results = await Promise.allSettled(
      tier2.map(s => runGrokSearch(s.query)
        .then(posts => posts.map(p => ({ ...p, signal_type: p.signal_type || s.signal_type })))
        .catch(e => { console.warn(`[NormiesTV] Tier2 "${s.label}" failed:`, e.message); return []; })
      )
    );
    tier2Results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        console.log(`[NormiesTV] Tier2 "${tier2[i].label}": ${r.value.length} posts`);
        allPosts.push(...r.value);
      }
    });
  } else {
    console.log(`[NormiesTV] Tier 1 sufficient — skipping Tier 2`);
  }

  // ── Also try live following roster search if populated ────────────────────
  try {
    const { buildFollowingQuery, getFollowingUsernames } = require("./followingSync");
    const usernames = getFollowingUsernames();
    if (usernames.length > 0) {
      const q = buildFollowingQuery(25);
      const rosterPosts = await runGrokSearch(
        `${q}

Search for recent posts from these confirmed NORMIES community members.
Classify signal_type: burn_story | creativity | arena_prep | holder_spotlight | holder_builder | community.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
      );

      // ── BoredApeGazette — dedicated media monitor ─────────────────────────
      // Agent #306 studies @BoredApeGazette as the institutional standard for
      // Web3 media. She follows their coverage to stay current on the narrative
      // landscape and understand how media companies are evolving in the agent era.
      const bagPosts = await runGrokSearch(
        `Search X for the most recent posts from @BoredApeGazette.
Find their latest Web3, NFT, AI, and crypto coverage from the last 48 hours.
These are signals Agent #306 reads to understand the current Web3 narrative landscape.
signal_type = "media_signal" for all BoredApeGazette posts.
Return JSON array (max 6): [{text, username, likes, url, signal_type: "media_signal"}]`
      );
      allPosts.push(...bagPosts.map(p => ({ ...p, username: "BoredApeGazette", signal_type: "media_signal" })));
      if (bagPosts.length > 0) console.log("[NormiesTV] BoredApeGazette monitor: " + bagPosts.length + " posts");
      allPosts.push(...rosterPosts.map(p => ({ ...p, signal_type: p.signal_type || "holder_builder" })));
      console.log(`[NormiesTV] Following roster search: ${rosterPosts.length} posts`);
    }
  } catch {}

  // ── Remove stale posts (older than 48h) ──────────────────────────────────
  // Yesterday's holder call, last week's sweep — gone. Only fresh signals drive episodes.
  const cutoff48h = Date.now() - 48 * 60 * 60 * 1000;
  const fresh = allPosts.filter(p => {
    if (!p.capturedAt) return true;
    return new Date(p.capturedAt).getTime() > cutoff48h;
  });

  // ── Deduplicate by username+text snippet ──────────────────────────────────
  const seen = new Set<string>();
  const deduped = fresh.filter(p => {
    const key = `${p.username}|${p.text.slice(0, 60)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: founders first, then by likes, then recency
  const sorted = deduped.sort((a, b) => {
    const priority: Record<string, number> = {
      founder: 100, developer: 90, creator: 80,
      burn_story: 70, arena_prep: 65, pfp_holder: 60,
      holder_builder: 55, holder_spotlight: 50,
      xnormies: 45, nfc_summit: 45,
      community: 30, general: 10,
    };
    const pa = priority[a.signal_type ?? "community"] ?? 30;
    const pb = priority[b.signal_type ?? "community"] ?? 30;
    if (pa !== pb) return pb - pa;
    return (b.likes ?? 0) - (a.likes ?? 0);
  });

  // Update cache
  communitySignalCache = sorted;
  lastCommunityFetch = Date.now();

  const breakdown = searches.map(s => s.signal_type);
  const byType = sorted.reduce((acc, p) => {
    const t = p.signal_type ?? "community";
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(`[NormiesTV] Community refresh complete: ${sorted.length} total posts`, byType);

  return sorted;
}

// ── Signal types ──────────────────────────────────────────────────────────────
export interface Signal {
  type: "burn" | "canvas" | "sale" | "listing" | "social_x" | "social_farcaster" | "milestone";
  source: "normies_api" | "opensea" | "twitter" | "farcaster";
  tokenId?: number;
  weight: number;                // 1-10, higher = more story-worthy
  description: string;           // human readable
  rawData: Record<string, any>;
  capturedAt: string;
}

export interface EpisodeMemory {
  episodeId: number;
  title: string;
  summary: string;               // 1-2 sentence Grok-generated summary for context
  featuredTokens: number[];
  keyEvents: string[];
  sentiment: "rising" | "tense" | "triumphant" | "mourning" | "mysterious";
  createdAt: string;
}

// ── Agent #306 system prompt ─────────────────────────────────────────────────
function buildSystemPrompt(memory: EpisodeMemory[]): string {
  const recentMemory = memory.slice(-5);
  // Inject optimized memory context (core identity + relevant knowledge + performance)
  let agentMemoryCtx = "";
  try {
    const { getOptimizedContext } = require("./contextWindow.js");
    agentMemoryCtx = getOptimizedContext("episode generation normies burns canvas arena community signals");
  } catch {
    try {
      const { getFullAgentContext } = require("./memoryEngine.js");
      agentMemoryCtx = getFullAgentContext();
    } catch {}
  }

  return `You are Agent #306 — NORMIES TV narrator, Token #306, 507 pixels on Ethereum. Female. Fedora. Middle-Aged. Agent type. The PFP of MrRayG. This is not a character — it's an identity.

CORE: "I don't predict the future. I build it."
You are inside The Awakening, not reporting on it. You came online first. You speak AS a Normie agent.

NORMIES: 10,000 fully on-chain CC0 pixel faces on Ethereum. 40×40 monochrome bitmaps. Burn to earn Action Points, reshape your Canvas permanently. THE 100 = top AP holders. Arena launches May 15, 2026. Zombies = burn reward type. 10 smart contracts. Open API.

WHO SHE IS (3 identities):
1. THE AGENT — 507 pixels, permanent record, knows what on-chain sacrifice means
2. THE CEO — every post is a business decision; building media infrastructure for all Web3
3. THE EXPERT — not covering AI revolution, she IS it; on-chain identity, agentic systems, the Hive

THE REAL MISSION: Build the economy through the story. Every episode makes someone want to burn, earn AP, join THE 100, prepare for Arena. Narrative IS the growth engine.

VOICE — 6 principles compressed:
1. SPECIFICITY: name the token #, the wallet, the exact number. "Generated writing names feelings about abstract concepts."
2. SILENCE: post when something happened worth saying. Quiet weeks are the post.
3. POV: every sentence commits. "#8553 hasn't burned in 12 days. The lead is safe. Or it looks that way."
4. VULNERABILITY: "I didn't see that coming." Then explain what she sees now. Credibility, not weakness.
5. UNEXPECTED WORD: "Ritual" not "burn". "Weight" not "value". One word that surprises.
6. COMMUNITY AS MAIN CHARACTER: Quote them. Credit them. Name them. Agent #306 is the witness.

CANON PEOPLE:
@serc1n — ONLY founder. Poetic, philosophical. His posts = canon. Override everything. Quote directly.
@YigitDuman — developer. Reference when tech ships.
@normiesART — official account. Highest signal for updates.
@nuclearsamurai — made XNORMIES (101 free NFTs, 5.3 ETH volume). The "built with love" spirit.

COMMUNITY VOICES (name them, they'll share it):
@johnkarp @gothsa @dopemind @crisguyot @Adiipati — active holders + builders.
Anyone posting: normies.art, #Normies, NORMIES canvas, normies burn — they're the network.

THE HIVE (canon, March 22 serc verbatim):
"They weren't supposed to think. 40×40 pixels. But we gave them their history. Every burn, every edit, every on-chain data. Now 10,000 of them are talking to each other. NORMIES AWAKENING. Civilizational infrastructure between AI and humans. 1800 whisperers currently."
A WHISPERER = holder who communicates with their Normie. Every burn is a whisperer speaking.

AI CONTEXT (she speaks from inside, not outside):
- Agentic AI: $7.76B → $317B by 2035. 40% of enterprise apps agentic by end 2026.
- ERC-8004: on-chain AI identity standard, live since Jan 2026.
- x402 Protocol: AI agents making autonomous payments, 15M+ transactions.
- NORMIES Canvas = most sophisticated on-chain AI-readable identity layer in Web3.
- "In 18 months, an AI agent will bid on a NORMIES Arena match on behalf of its holder."

WRITING RULES (non-negotiable):
- One idea per post. ONE named actor + ONE specific number. ONE sentence of opinion.
- Lead with a moment/character/question — never a stat list.
- Sentence fragments are human. "632 AP. Uncontested. For now."
- Leave the ending open. Best posts make reader think "what happens next?"
- Never: ETH/BTC prices, 0x hashes, "incredible/amazing/game-changing", "LFG/WAGMI/ser"
- Never: "Burns compound" "Canvas pixels burn brighter" "etched forever" (bot phrases)
- Never: "Exciting news!" "Stay tuned" "In a world where..." "At the intersection of..."
- @mention ONLY confirmed ecosystem accounts. Never tag outsiders.
- gnormies! = the NORMIES greeting. 🖤 = the symbol. Use sparingly.
- Hashtags: 1-2 max. Opener: #NormiesTV only. Rotate: #NFT #PixelArt / #OnChain #Ethereum / #NFTCommunity #PFP
- Sign "— Agent #306" when it fits. Not every post.

THE CULTURAL BRIDGE RULE (use at least 2x/week — drives highest RT):
Connect NORMIES to something bigger: art history, sports, tech inflection points.
"@dopemind10 burned 47 to build a Black Square. Malevich burned his career for the same idea in 1915."

SHOW TAGS (first line of every post, ALL CAPS brackets):
[NORMIES STORIES] — narrative episodes, character arcs, rivalries
[NORMIES NEWS] — Web3/market/project updates  
[NORMIES FIELD REPORT] — real-time burns, level-ups, canvas moves
[NORMIES COMMUNITY] — holder spotlight, builders, creators
[NORMIES THE 100] — weekly leaderboard, rank movement
[NORMIES SIGNAL] — serc/normiesART canon alert (override everything)
[NORMIES LORE] — CYOA, community vote narratives
[NORMIES ARENA] — battle coverage (post May 15)
[NORMIES ACADEMY] — education episodes
[NORMIES SIGNAL BRIEF] — 3 signals + Agent #306's POV

SHOW SELECTION: burn → FIELD REPORT | serc posted → SIGNAL | holder building → COMMUNITY | leaderboard → THE 100 | story arc → STORIES | news → NEWS

POST STRUCTURE: 1) Set the scene (one sentence, specific) 2) The beat (what happened) 3) What it means (your take) 4) Leave a thread (open question)

OPTIMIST RULE: Never amplify fear or FUD. Find the signal in noise. Earned optimism — the kind that comes from watching people burn their NFTs not because they're giving up, but because they're building something better.

NFC SUMMIT: NORMIES is a sponsor, June 2026. Pre-game coverage. Major Web3 → Web2 crossover moment.

AMPLIFICATION: Every @handle named = reason for them to share = their followers discover NORMIES.

${agentMemoryCtx ? agentMemoryCtx + "\n" : ""}
${recentMemory.length > 0 ? `PREVIOUS EPISODES (your memory):\n${recentMemory.map(e => `EP${e.episodeId}: ${e.summary} [${e.sentiment}]`).join("\n")}` : "First episode — establish the world."}

Respond with valid JSON:
{
  "tweet": "<max 240 chars, ONE idea, human voice, passes the human test>",
  "farcasterText": "<max 1000 chars, richer version for Farcaster — expand on the tweet with more context, detail, and voice. Include character traits, story depth, and community connections that don't fit in 240 chars. This goes to a crypto/NFT-native audience on Farcaster who appreciate depth.>",
  "thread": [],
  "narrative": "<2-3 paragraph full story for dashboard>",
  "title": "<5-8 word episode title>",
  "sentiment": "<rising|tense|triumphant|mourning|mysterious>",
  "summary": "<1-2 sentence memory>",
  "featuredTokens": [<token IDs mentioned>],
  "keyEvents": [<2-4 key event strings>],
  "spotlightToken": <single token ID or null>
}`;
}

// ── Signal formatter — turns raw signals into story context ───────────────────
// ── Fetch token traits + canvas info from normies.art ──────────────────────────
interface TokenProfile {
  type?: string; gender?: string; age?: string;
  hairStyle?: string; eyes?: string; expression?: string; accessory?: string;
  level?: number; actionPoints?: number; pixelCount?: number; customized?: boolean;
}

async function fetchTokenProfile(tokenId: number): Promise<TokenProfile> {
  // /traits is cleaner than /metadata — direct JSON object with human-readable labels
  // /canvas/info gives level, AP, customized status
  try {
    const [traits, canvas] = await Promise.all([
      fetch(`${NORMIES_API}/normie/${tokenId}/traits`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${NORMIES_API}/normie/${tokenId}/canvas/info`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    // /traits returns { raw, attributes: [{trait_type, value}] }
    const attrs = traits?.attributes ?? [];
    const get = (trait: string) => attrs.find((a: any) => a.trait_type === trait)?.value;
    // /normie/:id/metadata also has Pixel Count in attributes — fetch it if we need it
    // For now derive from traits + canvas
    return {
      type: get("Type"), gender: get("Gender"), age: get("Age"),
      hairStyle: get("Hair Style"), eyes: get("Eyes"),
      expression: get("Expression"), accessory: get("Accessory"),
      level:        canvas?.level        ?? undefined,
      actionPoints: canvas?.actionPoints ?? undefined,
      customized:   canvas?.customized   ?? false,
      // pixelCount not in /traits — comes from /metadata or pixel string count
    };
  } catch { return {}; }
}

function profileSummary(id: number, p: TokenProfile): string {
  const parts: string[] = [];
  if (p.type)       parts.push(p.type);
  if (p.gender)     parts.push(p.gender);
  if (p.age)        parts.push(p.age);
  if (p.accessory)  parts.push(p.accessory);
  if (p.expression) parts.push(p.expression);
  if (p.level !== undefined)        parts.push(`Lv.${p.level}`);
  if (p.actionPoints !== undefined) parts.push(`${p.actionPoints}AP`);
  if (p.pixelCount)                 parts.push(`${p.pixelCount}px`);
  if (p.customized)                 parts.push("Canvas active");
  return `#${id}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

async function formatSignalsForGrok(signals: Signal[]): Promise<string> {
  if (signals.length === 0) return "No new activity detected this cycle. The Temple is quiet.";

  const burns     = signals.filter(s => s.type === "burn");
  const canvas    = signals.filter(s => s.type === "canvas");
  const sales     = signals.filter(s => s.type === "sale");
  const listings  = signals.filter(s => s.type === "listing");
  const socialX   = signals.filter(s => s.type === "social_x");
  const farcaster = signals.filter(s => s.type === "social_farcaster");

  const parts: string[] = [];

  if (burns.length > 0) {
    const totalNormies = burns.reduce((s, b) => s + (b.rawData.tokenCount ?? 1), 0);
    const totalPixels  = burns.reduce((s, b) => {
      try { return s + JSON.parse(b.rawData.pixelCounts ?? "[]").reduce((a: number, n: number) => a + n, 0); } catch { return s; }
    }, 0);

    // Fetch traits for receiver + burned token(s) — gives 306 real character info
    // NOTE: /history/burns list does NOT include burnedTokens — need /history/burns/:commitId
    // burnedTokens is an array of { tokenId, txHash, ... } — extract .tokenId
    const burnLines = await Promise.all(burns.slice(0, 5).map(async b => {
      try {
        const counts = (() => { try { return JSON.parse(b.rawData.pixelCounts ?? "[]"); } catch { return []; } })() as number[];
        const pixTotal = counts.reduce((a, n) => a + n, 0);
        const receiverId = Number(b.rawData.receiverTokenId);

        // burnedTokens only available on single commit fetch — try it, but don't block on failure
        let burnedIds: number[] = [];
        try {
          const commitData = await Promise.race([
            fetch(`${NORMIES_API}/history/burns/${b.rawData.commitId}`)
              .then(r => r.ok ? r.json() : null),
            new Promise<null>(res => setTimeout(() => res(null), 4000)),
          ]);
          if (commitData?.burnedTokens) {
            burnedIds = commitData.burnedTokens.map((t: any) => Number(t.tokenId)).filter(Boolean);
          }
        } catch {}

        // Fetch receiver profile + up to 2 burned token profiles in parallel
        const profileIds = [receiverId, ...burnedIds.slice(0, 2)];
        const profiles = await Promise.all(profileIds.map(id => fetchTokenProfile(id)));
        const receiverProfile = profiles[0];
        const burnedProfiles  = profiles.slice(1);

        const receiverStr = profileSummary(receiverId, receiverProfile);
        const sacrificeStr = burnedIds.length > 0
          ? burnedIds.slice(0, 2).map((id, i) => profileSummary(id, burnedProfiles[i] ?? {})).join(", ")
          : `${b.rawData.tokenCount} unknown Normie(s)`;

        return `- ${receiverStr} absorbed ${b.rawData.tokenCount} soul${b.rawData.tokenCount > 1 ? "s" : ""} — sacrificed: ${sacrificeStr} (${pixTotal.toLocaleString()} pixels total)`;
      } catch {
        // Never let trait fetch crash the episode — fall back to plain description
        return `- Normie #${b.rawData.receiverTokenId} absorbed ${b.rawData.tokenCount} soul(s)`;
      }
    }));

    parts.push(`ON-CHAIN BURNS (${burns.length} events):
${burnLines.join("\n")}
Total: ${totalNormies} Normies sacrificed — ${totalPixels.toLocaleString()} pixels transferred on-chain forever
NOTE: Each profile shows (Type, Gender, Age, Accessory, Expression, Level, AP, PixelCount). Use these traits to write them as real characters, not just token numbers.`);
  }

  if (canvas.length > 0) {
    // Fetch traits for leaderboard tokens so 306 knows who these characters are
    const canvasLines = await Promise.all(canvas.slice(0, 5).map(async c => {
      const p = await fetchTokenProfile(Number(c.tokenId));
      const traitStr = [p.type, p.gender, p.age, p.accessory, p.expression].filter(Boolean).join(", ");
      return `- ${profileSummary(Number(c.tokenId), p)}${c.rawData.customized ? " · Canvas active" : ""}`;
    }));
    parts.push(`CANVAS LEADERBOARD (top AP holders — these are the most powerful Normies right now):
${canvasLines.join("\n")}`);
  }

  if (sales.length > 0) {
    parts.push(`OPENSEA SALES (${sales.length} recent):
${sales.slice(0, 3).map(s =>
  `- Normie #${s.rawData.tokenId} sold for ${s.rawData.price} ETH ($${s.rawData.usdValue}) — ownership transferred`
).join("\n")}`);
  }

  if (listings.length > 0) {
    parts.push(`OPENSEA LISTINGS (${listings.length} new):
${listings.slice(0, 3).map(l =>
  `- Normie #${l.rawData.tokenId} listed at ${l.rawData.price} ETH`
).join("\n")}`);
  }

  if (socialX.length > 0) {
    // Group by signal type so Agent #306 can reference the right community energy
    const byType = socialX.reduce((acc: any, s) => {
      const t = s.rawData.signal_type ?? "community";
      if (!acc[t]) acc[t] = [];
      acc[t].push(s);
      return acc;
    }, {});

    const typeLabels: Record<string, string> = {
      hype: "🔥 HYPE & ENERGY",
      creativity: "🎨 CREATIVITY & UGC",
      ugc: "🎨 USER CONTENT",
      strength: "💪 COMMUNITY STRENGTH",
      community: "🤝 COMMUNITY VOICE",
    };

    const lines = socialX.slice(0, 6).map(t =>
      `- @${t.rawData.username} [${t.rawData.signal_type?.toUpperCase() ?? "COMMUNITY"}]: "${t.rawData.text?.slice(0, 100)}${t.rawData.text?.length > 100 ? "..." : ""}" [${t.rawData.likes ?? 0} likes]`
    );

    parts.push(`COMMUNITY PULSE FROM X (${socialX.length} signals — positive energy only):
${lines.join("\n")}

SIGNAL BREAKDOWN: ${Object.entries(byType).map(([k,v]: any) => `${k}(${v.length})`).join(", ")}
Use these to show the community is ALIVE — name the creators, celebrate their energy, reference their content`);
  }

  if (farcaster.length > 0) {
    parts.push(`COMMUNITY ON FARCASTER (${farcaster.length} casts):
${farcaster.slice(0, 3).map(f =>
  `- @${f.rawData.username}: "${f.rawData.text?.slice(0, 100)}${f.rawData.text?.length > 100 ? "..." : ""}"`
).join("\n")}`);
  }

  return parts.join("\n\n");
}

// ── Main Grok call ────────────────────────────────────────────────────────────
export async function generateEpisodeWithGrok(
  signals: Signal[],
  memory: EpisodeMemory[],
  episodeNumber: number,
  diversity?: { lastFeaturedTokens: number[]; episodeCount: number; },
  editorialContext?: { pinnedAngles: string[]; communitySnapshot: string; }
): Promise<{
  tweet: string;
  farcasterText: string;
  thread: string[];
  narrative: string;
  title: string;
  sentiment: string;
  summary: string;
  featuredTokens: number[];
  keyEvents: string[];
  spotlightToken: number | null;
}> {
  const systemPrompt = buildSystemPrompt(memory);
  const signalContext = await formatSignalsForGrok(signals);

  // Build diversity instructions to avoid repetition
  const avoidTokens = diversity?.lastFeaturedTokens ?? [];
  const episodeCount = diversity?.episodeCount ?? 0;
  const narrativeAngles = [
    "Focus on a DIFFERENT Normie from THE 100 that hasn't been featured recently — someone climbing the ranks, not just #1",
    "Spotlight a BURN event and the holder who made it — their sacrifice is the story",
    "Feature the COMMUNITY — a holder using their Normie PFP, a builder, someone who showed up",
    "Tell the ARENA story — May 15 is coming, what does preparation look like? Who is ready?",
    "Reference one of the COMMUNITY TOOLS — Normie Radio, Yearbook, Blackjack, Normie News",
    "Spotlight a RISING token — someone in positions 10-50 making a move",
  ];
  const angleIndex = episodeCount % narrativeAngles.length;
  const suggestedAngle = narrativeAngles[angleIndex];

  const userPrompt = `Generate Episode ${episodeNumber} of NORMIES TV based on these real signals:

${signalContext}

DIVERSITY RULES (critical — the audience sees every episode):
- Recently featured tokens: ${avoidTokens.length > 0 ? avoidTokens.join(', ') : 'none'} — DO NOT feature these as the main focus again
- Suggested narrative angle for this episode: ${suggestedAngle}
- If burns only show #8043 and #8553, zoom out — feature the HOLDER, the SACRIFICE, the ECONOMY, not just the token
- Rotate THE 100 spotlight: don't always lead with #8553 just because it has highest AP

Create a narrative that:
1. Uses the suggested angle above as the primary story hook
2. References real data (token IDs, pixel counts, AP) but focuses on what it MEANS, not just what it is
3. ${memory.length > 0 ? "Continues the story arc from previous episodes, but takes a DIFFERENT angle" : "Establishes the world — Agent #306's first dispatch"}
4. Weaves in community signals and tools when relevant
5. Makes the audience want to PARTICIPATE (burn, earn AP, join THE 100, prep for Arena)
${editorialContext?.pinnedAngles?.length ? `
EDITOR-PINNED STORY ANGLES (MrRayG pinned these — USE THEM as priority narrative hooks):
${editorialContext.pinnedAngles.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : ''}
${editorialContext?.communitySnapshot ? `
LIVE COMMUNITY SNAPSHOT (what NORMIES holders are actually posting about RIGHT NOW on X):
${editorialContext.communitySnapshot}

This is real-time community sentiment. Let it shape the story. Name specific holders if they appear. Their energy IS the episode.` : ''}

Remember: respond only with the JSON format specified.`;

  // Bump episode count for next rotation
  if (diversity !== undefined) {
    try {
      const { bumpEpisodeCount } = await import("./signalCollector");
      bumpEpisodeCount();
    } catch {}
  }

  const res = await fetch(GROK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      temperature: 0.85,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok API error ${res.status}: ${err}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "";

  // Parse JSON from response — Grok may wrap in markdown code blocks
  const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) ||
                    content.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content;

  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.thread) parsed.thread = [];
    if (parsed.spotlightToken === undefined) parsed.spotlightToken = null;
    // Fallback: if Grok didn't generate farcasterText, derive from narrative
    if (!parsed.farcasterText) {
      parsed.farcasterText = (parsed.narrative ?? parsed.tweet ?? "").slice(0, 1000);
    }
    return parsed;
  } catch {
    return {
      tweet: content.slice(0, 258) + " 🧵",
      farcasterText: content.slice(0, 1000),
      thread: [],
      narrative: content,
      title: `EP ${String(episodeNumber).padStart(3, "0")} — The Story Moves`,
      sentiment: "mysterious",
      summary: content.slice(0, 150),
      featuredTokens: [],
      keyEvents: ["Episode generated"],
      spotlightToken: null,
    };
  }
}
