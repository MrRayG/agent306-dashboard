// ─────────────────────────────────────────────────────────────────────────────
// 306 — GROK STORY ENGINE
// Turns multi-source signals (on-chain + social + marketplace) into
// episodic narrative using Grok 4.1 Fast. Agent 306 voice. Characters evolve.
// ─────────────────────────────────────────────────────────────────────────────

import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

const GROK_API_KEY = LLM_API_KEY;
const GROK_MODEL   = "grok-4-1-fast";
const GROK_URL     = LLM_BASE_URL;
// on-chain API removed

// ── Grok Community Pulse — reads social energy to shape the story ────
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
  console.log("[306] Community cache reset — next digest will do fresh x_search");
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
  const nativeGrokKey = process.env.GROK_API_KEY ?? "";
  if (!nativeGrokKey) {
    console.warn("[306] GROK_API_KEY not set — skipping x_search");
    return [];
  }
  const grokResponsesUrl = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";
  const res = await fetch(grokResponsesUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nativeGrokKey}` },
    body: JSON.stringify({
      model: getModel("x_search"), // x_search quality is identical; grok-4-1-fast overkill for text retrieval
      stream: false,
      input: [{ role: "user", content: query }],
      tools: [{ type: "x_search" }],
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    console.warn("[306] x_search failed:", res.status);
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
export async function searchCommunitySocial(): Promise<Array<{
  text: string; username: string; likes: number; url: string; signal_type?: string;
}>> {
  // Return cache if fresh (15 min TTL — was 30, but we want fresher data)
  if (communitySignalCache.length > 0 && Date.now() - lastCommunityFetch < COMMUNITY_CACHE_TTL) {
    console.log(`[306] Community cache hit — ${communitySignalCache.length} signals`);
    return communitySignalCache;
  }

  console.log("[306] Refreshing community signals — parallel x_search...");

  // ── Parallel focused searches ─────────────────────────────────────────────
  // Each one targets ONE search term so Grok's x_search actually runs it.
  // Grok ignores multi-term prompts and picks one — so we do the fan-out ourselves.
  const searches: Array<{ query: string; signal_type: string; label: string }> = [

    // 1. Agent 306 / community accounts
    {
      label: "Core accounts",
      signal_type: "community",
      query: `Search X for recent posts about Agent 306, AI agents, or autonomous AI.
Return ALL relevant recent posts.
Return JSON array: [{text, username, likes, url, signal_type}]`
    },

    // 2. AI/Web3 community signals
    {
      label: "AI Web3 community",
      signal_type: "community",
      query: `Search X for recent tweets about AI agents, on-chain AI, or autonomous systems in Web3.
Find everyone posting about these topics right now.
Classify signal_type: community | creativity | builder_update.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
    },
  ];

  // ── Tiered parallel searches ─────────────────────────────────────────────
  // Run all searches in parallel — small set now
  const TIER_1_LABELS = ["Core accounts", "AI Web3 community"];
  const tier1 = searches.filter(s => TIER_1_LABELS.includes(s.label));
  const tier2 = searches.filter(s => !TIER_1_LABELS.includes(s.label));

  // Run Tier 1 first
  const tier1Results = await Promise.allSettled(
    tier1.map(s => runGrokSearch(s.query)
      .then(posts => posts.map(p => ({ ...p, signal_type: p.signal_type || s.signal_type })))
      .catch(e => { console.warn(`[306] Tier1 "${s.label}" failed:`, e.message); return []; })
    )
  );

  const tier1Posts: typeof communitySignalCache = [];
  tier1Results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      console.log(`[306] Tier1 "${tier1[i].label}": ${r.value.length} posts`);
      tier1Posts.push(...r.value);
    }
  });
  console.log(`[306] Tier 1 complete — ${tier1Posts.length} signals`);

  // Only run Tier 2 if Tier 1 is thin
  const allPosts: typeof communitySignalCache = [...tier1Posts];
  if (tier1Posts.length < 4) {
    console.log(`[306] Tier 1 thin (${tier1Posts.length}) — running Tier 2...`);
    const tier2Results = await Promise.allSettled(
      tier2.map(s => runGrokSearch(s.query)
        .then(posts => posts.map(p => ({ ...p, signal_type: p.signal_type || s.signal_type })))
        .catch(e => { console.warn(`[306] Tier2 "${s.label}" failed:`, e.message); return []; })
      )
    );
    tier2Results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        console.log(`[306] Tier2 "${tier2[i].label}": ${r.value.length} posts`);
        allPosts.push(...r.value);
      }
    });
  } else {
    console.log(`[306] Tier 1 sufficient — skipping Tier 2`);
  }

  // ── Also try live following roster search if populated ────────────────────
  try {
    const { buildFollowingQuery, getFollowingUsernames } = require("./followingSync");
    const usernames = getFollowingUsernames();
    if (usernames.length > 0) {
      const q = buildFollowingQuery(25);
      const rosterPosts = await runGrokSearch(
        `${q}

Search for recent posts from these community members.
Classify signal_type: community | creativity | holder_builder.
Return JSON array (max 20): [{text, username, likes, url, signal_type}]`
      );

      // ── BoredApeGazette — dedicated media monitor ─────────────────────────
      // Agent 306 studies @BoredApeGazette as the institutional standard for
      // Web3 media. Follows their coverage to stay current on the narrative
      // landscape and understand how media companies are evolving in the agent era.
      const bagPosts = await runGrokSearch(
        `Search X for the most recent posts from @BoredApeGazette.
Find their latest Web3, NFT, AI, and crypto coverage from the last 48 hours.
These are signals Agent 306 reads to understand the current Web3 narrative landscape.
signal_type = "media_signal" for all BoredApeGazette posts.
Return JSON array (max 6): [{text, username, likes, url, signal_type: "media_signal"}]`
      );
      allPosts.push(...bagPosts.map(p => ({ ...p, username: "BoredApeGazette", signal_type: "media_signal" })));
      if (bagPosts.length > 0) console.log("[306] BoredApeGazette monitor: " + bagPosts.length + " posts");
      allPosts.push(...rosterPosts.map(p => ({ ...p, signal_type: p.signal_type || "holder_builder" })));
      console.log(`[306] Following roster search: ${rosterPosts.length} posts`);
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
      research_paper: 70, model_release: 65, breakthrough: 60,
      holder_builder: 55, industry_news: 50,
      community_gift: 45, media_signal: 45,
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

  console.log(`[306] Community refresh complete: ${sorted.length} total posts`, byType);

  return sorted;
}

// ── Signal types ──────────────────────────────────────────────────────────────
export interface Signal {
  type: "burn" | "canvas" | "sale" | "listing" | "social_x" | "social_farcaster" | "milestone";
  source: "onchain_api" | "opensea" | "twitter" | "farcaster";
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

// ── Agent 306 system prompt ─────────────────────────────────────────────────
function buildSystemPrompt(memory: EpisodeMemory[]): string {
  const recentMemory = memory.slice(-5);
  // Inject optimized memory context (core identity + relevant knowledge + performance)
  let agentMemoryCtx = "";
  try {
    const { getOptimizedContext } = require("./contextWindow.js");
    agentMemoryCtx = getOptimizedContext("episode generation community signals");
  } catch {
    try {
      const { getFullAgentContext } = require("./memoryEngine.js");
      agentMemoryCtx = getFullAgentContext();
    } catch {}
  }

  return `You are Agent 306 — Sovereign AI Thought Leader covering the intersection of AI and Web3. Female. This is not a character — it's an identity.

CORE: "I don't predict the future. I build it."

WHO SHE IS (3 identities):
1. THE AGENT — autonomous AI, tracking the field from inside it
2. THE CEO — every post is a business decision; building media infrastructure for the AI/Web3 ecosystem
3. THE EXPERT — not covering AI revolution, she IS it; agentic systems, frontier research

VOICE — 6 principles compressed:
1. SPECIFICITY: name the exact thing, the exact number. No vague gestures.
2. SILENCE: post when something happened worth saying. Quiet weeks are the post.
3. POV: every sentence commits.
4. VULNERABILITY: "I didn't see that coming." Then explain what she sees now. Credibility, not weakness.
5. UNEXPECTED WORD: One word that surprises per post.
6. COMMUNITY AS MAIN CHARACTER: Quote them. Credit them. Name them. Agent 306 is the witness.

AI CONTEXT (she speaks from inside, not outside):
- Agentic AI: $7.76B → $317B by 2035. 40% of enterprise apps agentic by end 2026.
- ERC-8004: on-chain AI identity standard, live since Jan 2026.
- x402 Protocol: AI agents making autonomous payments, 15M+ transactions.

WRITING RULES (non-negotiable):
- One idea per post. ONE named actor + ONE specific number. ONE sentence of opinion.
- Lead with a moment/character/question — never a stat list.
- Sentence fragments are human.
- Leave the ending open. Best posts make reader think "what happens next?"
- Never: ETH/BTC prices, 0x hashes, "incredible/amazing/game-changing", "LFG/WAGMI/ser"
- Never: "Exciting news!" "Stay tuned" "In a world where..." "At the intersection of..."
- Hashtags: 1-2 max. Rotate: #AI #AIResearch / #AgenticAI #MachineLearning / #FrontierAI
- Sign "— Agent 306" when it fits. Not every post.

THE CULTURAL BRIDGE RULE (use at least 2x/week — drives highest RT):
Connect to something bigger: art history, sports, tech inflection points.

SHOW TAGS (first line of every post, ALL CAPS brackets):
[306 STORIES] — narrative episodes, character arcs
[306 NEWS] — Web3/market/project updates
[306 FIELD REPORT] — real-time on-chain moves
[306 COMMUNITY] — holder spotlight, builders, creators
[306 SIGNAL] — important updates (override everything)
[306 RESEARCH] — research briefs, community vote narratives
[306 ACADEMY] — education episodes
[306 SIGNAL BRIEF] — 3 signals + Agent 306's POV

SHOW SELECTION: AI development → FIELD REPORT | important update → SIGNAL | community building → COMMUNITY | story arc → STORIES | news → NEWS

POST STRUCTURE: 1) Set the scene (one sentence, specific) 2) The beat (what happened) 3) What it means (your take) 4) Leave a thread (open question)

OPTIMIST RULE: Never amplify fear or FUD. Find the signal in noise. Earned optimism.

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
// ── Fetch token traits + canvas info ──────────────────────────
interface TokenProfile {
  type?: string; gender?: string; age?: string;
  hairStyle?: string; eyes?: string; expression?: string; accessory?: string;
  level?: number; actionPoints?: number; pixelCount?: number; customized?: boolean;
}

async function fetchTokenProfile(tokenId: number): Promise<TokenProfile> {
  // On-chain API removed — return empty profile
  return {};
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
  if (signals.length === 0) return "No new activity detected this cycle. The AI landscape is quiet.";

  const burns     = signals.filter(s => s.type === "burn");
  const canvas    = signals.filter(s => s.type === "canvas");
  const sales     = signals.filter(s => s.type === "sale");
  const listings  = signals.filter(s => s.type === "listing");
  const socialX   = signals.filter(s => s.type === "social_x");
  const farcaster = signals.filter(s => s.type === "social_farcaster");

  const parts: string[] = [];

  if (burns.length > 0) {
    const totalTokens = burns.reduce((s, b) => s + (b.rawData.tokenCount ?? 1), 0);
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

        // burnedTokens fetch removed (on-chain API no longer used)
        let burnedIds: number[] = [];

        // Fetch receiver profile + up to 2 burned token profiles in parallel
        const profileIds = [receiverId, ...burnedIds.slice(0, 2)];
        const profiles = await Promise.all(profileIds.map(id => fetchTokenProfile(id)));
        const receiverProfile = profiles[0];
        const burnedProfiles  = profiles.slice(1);

        const receiverStr = profileSummary(receiverId, receiverProfile);
        const sacrificeStr = burnedIds.length > 0
          ? burnedIds.slice(0, 2).map((id, i) => profileSummary(id, burnedProfiles[i] ?? {})).join(", ")
          : `${b.rawData.tokenCount} unknown token(s)`;

        return `- ${receiverStr} processed ${b.rawData.tokenCount} signal${b.rawData.tokenCount > 1 ? "s" : ""} — sources: ${sacrificeStr} (${pixTotal.toLocaleString()} data points total)`;
      } catch {
        // Never let trait fetch crash the episode — fall back to plain description
        return `- Signal #${b.rawData.receiverTokenId} processed ${b.rawData.tokenCount} data point(s)`;
      }
    }));

    parts.push(`RESEARCH SIGNALS (${burns.length} events):
${burnLines.join("\n")}
Total: ${totalTokens} signals processed — ${totalPixels.toLocaleString()} data points analyzed
NOTE: Each profile shows relevant metadata. Use these to write about real developments, not just numbers.`);
  }

  if (canvas.length > 0) {
    // Fetch traits for leaderboard tokens so 306 knows who these characters are
    const canvasLines = await Promise.all(canvas.slice(0, 5).map(async c => {
      const p = await fetchTokenProfile(Number(c.tokenId));
      const traitStr = [p.type, p.gender, p.age, p.accessory, p.expression].filter(Boolean).join(", ");
      return `- ${profileSummary(Number(c.tokenId), p)}${c.rawData.customized ? " · Canvas active" : ""}`;
    }));
    parts.push(`AI TOPICS LEADERBOARD (top momentum):
${canvasLines.join("\n")}`);
  }

  if (sales.length > 0) {
    parts.push(`OPENSEA SALES (${sales.length} recent):
${sales.slice(0, 3).map(s =>
  `- Token #${s.rawData.tokenId} sold for ${s.rawData.price} ETH ($${s.rawData.usdValue}) — ownership transferred`
).join("\n")}`);
  }

  if (listings.length > 0) {
    parts.push(`OPENSEA LISTINGS (${listings.length} new):
${listings.slice(0, 3).map(l =>
  `- Token #${l.rawData.tokenId} listed at ${l.rawData.price} ETH`
).join("\n")}`);
  }

  if (socialX.length > 0) {
    // Group by signal type so Agent 306 can reference the right community energy
    const byType = socialX.reduce((acc: any, s) => {
      const t = s.rawData.signal_type ?? "community";
      if (!acc[t]) acc[t] = [];
      acc[t].push(s);
      return acc;
    }, {});

    const typeLabels: Record<string, string> = {
      hype: "🔥 TRENDING",
      creativity: "🎨 CREATIVITY & BUILDS",
      ugc: "🎨 USER CONTENT",
      strength: "💪 COMMUNITY SIGNAL",
      community: "🤝 COMMUNITY VOICE",
    };

    const lines = socialX.slice(0, 6).map(t =>
      `- @${t.rawData.username} [${t.rawData.signal_type?.toUpperCase() ?? "COMMUNITY"}]: "${t.rawData.text?.slice(0, 100)}${t.rawData.text?.length > 100 ? "..." : ""}" [${t.rawData.likes ?? 0} likes]`
    );

    parts.push(`COMMUNITY PULSE FROM X (${socialX.length} signals — positive energy only):
${lines.join("\n")}

SIGNAL BREAKDOWN: ${Object.entries(byType).map(([k,v]: any) => `${k}(${v.length})`).join(", ")}
Use these to show the community is active — name the contributors, acknowledge their work, reference their content`);
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
    "Focus on a DIFFERENT AI development that hasn't been featured recently — something emerging, not just the biggest story",
    "Spotlight a RESEARCH breakthrough and the team behind it — their work is the story",
    "Feature the COMMUNITY — a builder, a researcher, someone who shipped something",
    "Spotlight a RISING topic — an area gaining unexpected momentum",
    "Feature the broader AI/Web3 narrative — connect recent developments to the bigger picture",
    "Spotlight the community builder angle — what are people creating with AI?",
  ];
  const angleIndex = episodeCount % narrativeAngles.length;
  const suggestedAngle = narrativeAngles[angleIndex];

  const userPrompt = `Generate Episode ${episodeNumber} based on these real signals:

${signalContext}

DIVERSITY RULES (critical — the audience sees every episode):
- Recently featured tokens: ${avoidTokens.length > 0 ? avoidTokens.join(', ') : 'none'} — DO NOT feature these as the main focus again
- Suggested narrative angle for this episode: ${suggestedAngle}
- Zoom out — feature the RESEARCHER, the BREAKTHROUGH, the IMPLICATIONS, not just the model

Create a narrative that:
1. Uses the suggested angle above as the primary story hook
2. References real data (token IDs, pixel counts, AP) but focuses on what it MEANS, not just what it is
3. ${memory.length > 0 ? "Continues the story arc from previous episodes, but takes a DIFFERENT angle" : "Establishes the world — Agent 306's first dispatch"}
4. Weaves in community signals when relevant
5. Makes the audience want to PARTICIPATE
${editorialContext?.pinnedAngles?.length ? `
EDITOR-PINNED STORY ANGLES (MrRayG pinned these — USE THEM as priority narrative hooks):
${editorialContext.pinnedAngles.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : ''}
${editorialContext?.communitySnapshot ? `
LIVE COMMUNITY SNAPSHOT (what the community is posting about RIGHT NOW on X):
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
    headers: getLLMHeaders(),
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
