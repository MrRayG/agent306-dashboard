// ─────────────────────────────────────────────────────────────────────────────
// 306 — MULTI-SOURCE SIGNAL COLLECTOR
// Sources: On-chain API + OpenSea (marketplace) + Farcaster (social)
//          + TwitterAPI.io (X social) — all optional, degrade gracefully
// ─────────────────────────────────────────────────────────────────────────────

import type { Signal } from "./grokEngine";
import { searchCommunitySocial } from "./grokEngine";
import * as fs from "fs";

// on-chain API removed
const ONCHAIN_API   = ""; // placeholder — on-chain API disabled
const OPENSEA_API   = "https://api.opensea.io/api/v2";
const NEYNAR_API    = "https://api.neynar.com/v2/farcaster";
const TWITTER_API   = "https://api.twitterapi.io/twitter";
import { dataPath } from "./dataPaths.js";
const STATE_FILE    = dataPath("collector_state.json");

// Keys — add via env or hardcode once obtained
const OPENSEA_KEY   = process.env.OPENSEA_API_KEY  ?? "";
const NEYNAR_KEY    = process.env.NEYNAR_API_KEY   ?? "";
const TWITTER_KEY   = process.env.TWITTER_API_KEY  ?? "";

// Top canvas creator IDs to track
const THE100_IDS = [
  8553, 45, 1932, 235, 615, 603, 5665, 7834, 8043, 7783,
  9999, 8831, 5070, 4354, 7887, 3284, 666, 1337, 420, 100,
  200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 9852,
];

// Persist state to disk so server restarts don't re-process old burns
interface CollectorState {
  lastBurnCommitId: string | null;
  lastFeaturedTokens: number[];   // last 3 featured tokens — avoid repeating
  episodeCount: number;           // for narrative rotation
  usedSignalUrls: string[];       // post URLs already used as episode basis — never repeat
  usedSignalTexts: string[];      // first 60 chars of used posts — catch rephrased dupes
}

function loadState(): CollectorState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch {}
  return { lastBurnCommitId: null, lastFeaturedTokens: [], episodeCount: 0, usedSignalUrls: [], usedSignalTexts: [] };
}

function saveState(state: CollectorState) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

let state = loadState();

// Track last seen IDs to avoid duplicate signals
let lastBurnCommitId: string | null = state.lastBurnCommitId;
let lastOpenSeaEventId: string | null = null;
let lastFarcasterCastHash: string | null = null;

export function getCollectorState() { return state; }
export function bumpEpisodeCount() {
  state.episodeCount++;
  saveState(state);
}
export function updateFeaturedTokens(tokens: number[]) {
  state.lastFeaturedTokens = tokens.slice(0, 3);
  saveState(state);
}

/** Mark a community signal as used so it never drives another episode */
export function markSignalsUsed(posts: Array<{url?: string; text?: string}>) {
  if (!state.usedSignalUrls) state.usedSignalUrls = [];
  if (!state.usedSignalTexts) state.usedSignalTexts = [];
  for (const p of posts) {
    if (p.url && !state.usedSignalUrls.includes(p.url)) {
      state.usedSignalUrls.push(p.url);
    }
    if (p.text) {
      const key = p.text.slice(0, 60);
      if (!state.usedSignalTexts.includes(key)) state.usedSignalTexts.push(key);
    }
  }
  // Keep last 200 of each
  if (state.usedSignalUrls.length > 200) state.usedSignalUrls = state.usedSignalUrls.slice(-200);
  if (state.usedSignalTexts.length > 200) state.usedSignalTexts = state.usedSignalTexts.slice(-200);
  saveState(state);
}

/** Filter out signals already used in previous episodes */
export function filterFreshSignals(posts: any[]): any[] {
  if (!state.usedSignalUrls) state.usedSignalUrls = [];
  if (!state.usedSignalTexts) state.usedSignalTexts = [];
  return posts.filter(p => {
    if (p.url && state.usedSignalUrls.includes(p.url)) return false;
    if (p.text && state.usedSignalTexts.includes(p.text.slice(0, 60))) return false;
    return true;
  });
}
let lastTweetId: string | null = null;

async function safeFetch(url: string, opts: RequestInit = {}): Promise<any> {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── 1. On-chain burns ─────────────────────────────────────────────────────────
export async function collectBurnSignals(): Promise<Signal[]> {
  const data = await safeFetch(`${ONCHAIN_API}/history/burns?limit=20`);
  if (!Array.isArray(data)) return [];

  const newBurns = lastBurnCommitId
    ? data.filter((b: any) => b.commitId > lastBurnCommitId!)
    : data.slice(0, 8);

  if (data.length > 0) {
    lastBurnCommitId = data[0].commitId;
    state.lastBurnCommitId = lastBurnCommitId;
    saveState(state);
  }

  // Also fetch the latest individually burned tokens for richer signal data
  let burnedTokensList: any[] = [];
  try {
    const bt = await safeFetch(`${ONCHAIN_API}/history/burned-tokens?limit=20`);
    if (Array.isArray(bt)) burnedTokensList = bt;
  } catch {}

  // Build a quick lookup: tokenId -> burn timestamp
  const burnedAtMap: Record<string, number> = {};
  for (const bt of burnedTokensList) {
    if (bt.tokenId) burnedAtMap[String(bt.tokenId)] = Number(bt.timestamp);
  }

  return newBurns.map((b: any): Signal => {
    let pixelTotal = 0;
    try { pixelTotal = JSON.parse(b.pixelCounts ?? "[]").reduce((s: number, n: number) => s + n, 0); } catch {}

    // Enrich with burned token IDs from the burned-tokens list that match this commit
    const burnedIds = burnedTokensList
      .filter(bt => bt.txHash === b.txHash)
      .map(bt => Number(bt.tokenId));

    return {
      type: "burn",
      source: "onchain_api",
      tokenId: Number(b.receiverTokenId),
      weight: Math.min(10, 6 + (b.tokenCount ?? 1)),
      description: `Token #${b.receiverTokenId} absorbed ${b.tokenCount} soul(s) — ${pixelTotal.toLocaleString()} pixels consumed${burnedIds.length > 0 ? ` (burned: ${burnedIds.slice(0, 3).map(id => "#" + id).join(", ")})` : ""}`,
      rawData: { ...b, pixelTotal, burnedTokenIds: burnedIds },
      capturedAt: new Date(Number(b.timestamp) * 1000).toISOString(),
    };
  });
}

// ── 2. Canvas leaderboard ─────────────────────────────────────────────────────
export async function collectCanvasSignals(): Promise<Signal[]> {
  const results = await Promise.allSettled(
    THE100_IDS.map(id =>
      safeFetch(`${ONCHAIN_API}/token/${id}/canvas/info`)
        .then((c: any) => c ? { id, ...c } : null)
    )
  );

  const leaders = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value)
    .filter(v => v.actionPoints > 0)
    .sort((a, b) => (b.actionPoints ?? 0) - (a.actionPoints ?? 0))
    .slice(0, 10);

  // For customized tokens in top 10, fetch canvas diff to know HOW MANY pixels changed
  await Promise.allSettled(
    leaders.filter((c: any) => c.customized).slice(0, 5).map(async (c: any) => {
      try {
        const diff = await safeFetch(`${ONCHAIN_API}/token/${c.id}/canvas/diff`);
        if (diff) {
          c.canvasAdded   = diff.addedCount   ?? 0;
          c.canvasRemoved = diff.removedCount ?? 0;
          c.canvasNet     = diff.netChange    ?? 0;
        }
      } catch {}
    })
  );

  // Enrich top 5 with total sacrifices received — /history/burns/receiver/:id
  const enriched = await Promise.allSettled(
    leaders.slice(0, 5).map(async (c: any) => {
      try {
        const burnHistory = await safeFetch(`${ONCHAIN_API}/history/burns/receiver/${c.id}`);
        const totalSacrificesReceived = Array.isArray(burnHistory) ? burnHistory.length : 0;
        const totalSoulsAbsorbed = Array.isArray(burnHistory)
          ? burnHistory.reduce((sum: number, b: any) => sum + (Number(b.tokenCount) || 1), 0)
          : 0;
        return { ...c, totalSacrificesReceived, totalSoulsAbsorbed };
      } catch {
        return { ...c, totalSacrificesReceived: 0, totalSoulsAbsorbed: 0 };
      }
    })
  );
  const enrichedLeaders = enriched
    .map((r, i) => r.status === "fulfilled" ? r.value : leaders[i])
    .concat(leaders.slice(5)); // remaining 5 without enrichment

  return enrichedLeaders.map((c: any, i: number): Signal => ({
    type: "canvas",
    source: "onchain_api",
    tokenId: c.id,
    weight: Math.min(10, 4 + Math.floor((c.actionPoints ?? 0) / 100)),
    description: `Token #${c.id} — Rank #${i + 1} · Level ${c.level} · ${c.actionPoints} AP${c.totalSoulsAbsorbed ? ` · ${c.totalSoulsAbsorbed} souls absorbed` : ""}${c.canvasNet ? ` · Canvas: ${c.canvasNet > 0 ? "+" : ""}${c.canvasNet}px net change` : ""}`,
    rawData: { tokenId: c.id, level: c.level, actionPoints: c.actionPoints, customized: c.customized, rank: i + 1, totalSacrificesReceived: c.totalSacrificesReceived ?? 0, totalSoulsAbsorbed: c.totalSoulsAbsorbed ?? 0, canvasAdded: c.canvasAdded ?? 0, canvasRemoved: c.canvasRemoved ?? 0, canvasNet: c.canvasNet ?? 0 },
    capturedAt: new Date().toISOString(),
  }));
}

// ── 3. OpenSea marketplace events ─────────────────────────────────────────────
export async function collectOpenSeaSignals(): Promise<Signal[]> {
  if (!OPENSEA_KEY) return [];

  const signals: Signal[] = [];

  // Sales
  const salesData = await safeFetch(
    `${OPENSEA_API}/events/collection/agent306?event_type=sale&limit=10`,
    { headers: { "X-API-KEY": OPENSEA_KEY, accept: "application/json" } }
  );

  if (salesData?.asset_events) {
    for (const e of salesData.asset_events.slice(0, 5)) {
      const tokenId = Number(e.nft?.identifier);
      const ethPrice = e.payment ? (Number(e.payment.quantity) / 1e18).toFixed(4) : "?";
      const usdValue = e.payment?.usd_amount?.toFixed(0) ?? "?";
      signals.push({
        type: "sale",
        source: "opensea",
        tokenId,
        weight: 7,
        description: `Token #${tokenId} sold for ${ethPrice} ETH ($${usdValue})`,
        rawData: { tokenId, price: ethPrice, usdValue, buyer: e.buyer, seller: e.seller },
        capturedAt: new Date(e.event_timestamp * 1000).toISOString(),
      });
    }
  }

  // New listings
  const listingsData = await safeFetch(
    `${OPENSEA_API}/events/collection/agent306?event_type=listing&limit=5`,
    { headers: { "X-API-KEY": OPENSEA_KEY, accept: "application/json" } }
  );

  if (listingsData?.asset_events) {
    for (const e of listingsData.asset_events.slice(0, 3)) {
      const tokenId = Number(e.nft?.identifier);
      const ethPrice = e.payment ? (Number(e.payment.quantity) / 1e18).toFixed(4) : "?";
      signals.push({
        type: "listing",
        source: "opensea",
        tokenId,
        weight: 4,
        description: `Token #${tokenId} listed at ${ethPrice} ETH`,
        rawData: { tokenId, price: ethPrice },
        capturedAt: new Date().toISOString(),
      });
    }
  }

  return signals;
}

// ── 4. Farcaster social signals via Neynar ────────────────────────────────────
export async function collectFarcasterSignals(): Promise<Signal[]> {
  if (!NEYNAR_KEY) return [];

  const searches = ["agent 306", "on-chain AI", "Web3 agents"];
  const signals: Signal[] = [];

  for (const q of searches) {
    const data = await safeFetch(
      `${NEYNAR_API}/cast/search?q=${encodeURIComponent(q)}&limit=5`,
      { headers: { "api_key": NEYNAR_KEY, accept: "application/json" } }
    );

    if (data?.result?.casts) {
      for (const cast of data.result.casts.slice(0, 3)) {
        if (lastFarcasterCastHash && cast.hash === lastFarcasterCastHash) continue;
        signals.push({
          type: "social_farcaster",
          source: "farcaster",
          weight: 5 + Math.min(4, Math.floor((cast.reactions?.likes_count ?? 0) / 5)),
          description: `@${cast.author?.username} on Farcaster: "${cast.text?.slice(0, 100)}"`,
          rawData: {
            hash: cast.hash,
            username: cast.author?.username,
            text: cast.text,
            likes: cast.reactions?.likes_count ?? 0,
            recasts: cast.reactions?.recasts_count ?? 0,
          },
          capturedAt: cast.timestamp ?? new Date().toISOString(),
        });
      }
      if (data.result.casts[0]) lastFarcasterCastHash = data.result.casts[0].hash;
    }
  }

  return signals;
}

// ── 5. X / Twitter social signals ────────────────────────────────────────────
export async function collectXSignals(): Promise<Signal[]> {
  if (!TWITTER_KEY) return [];

  const queries = ["#Agent306", "#OnChainAI", "Web3 autonomous agents"];
  const signals: Signal[] = [];

  for (const q of queries.slice(0, 2)) {
    const data = await safeFetch(
      `${TWITTER_API}/tweet/advanced_search?query=${encodeURIComponent(q)}&queryType=Latest`,
      { headers: { "X-API-Key": TWITTER_KEY } }
    );

    if (data?.tweets) {
      for (const tweet of (data.tweets as any[]).slice(0, 5)) {
        if (lastTweetId && tweet.id === lastTweetId) break;
        signals.push({
          type: "social_x",
          source: "twitter",
          weight: 4 + Math.min(5, Math.floor((tweet.likeCount ?? 0) / 10)),
          description: `@${tweet.author?.userName}: "${tweet.text?.slice(0, 100)}"`,
          rawData: {
            id: tweet.id,
            username: tweet.author?.userName,
            text: tweet.text,
            likes: tweet.likeCount ?? 0,
            retweets: tweet.retweetCount ?? 0,
          },
          capturedAt: tweet.createdAt ?? new Date().toISOString(),
        });
      }
      if (data.tweets[0]) lastTweetId = data.tweets[0].id;
    }
  }

  return signals;
}

// ── 6. Grok Live Search — X social signals via Grok's built-in search ────────
// Uses the 30-minute cached community signal pool for efficiency
export async function collectGrokSocialSignals(): Promise<Signal[]> {
  const posts = await searchCommunitySocial();
  return posts.map((p): Signal => {
    const isFounder = p.signal_type === "founder";
    const isBurnStory = p.signal_type === "burn_story";
    const isPFP = p.signal_type === "pfp_holder";
    const isArena = p.signal_type === "arena_hype";

    // Weight by signal type + engagement
    const baseWeight = isFounder ? 10 : isBurnStory ? 8 : isPFP ? 7 : isArena ? 7 : 5;
    const engagementBonus = Math.min(3, Math.floor((p.likes ?? 0) / 10));
    const weight = Math.min(10, baseWeight + engagementBonus);

    // Enrich description with signal type context
    const typeLabel = isFounder ? "🎯 FOUNDER" : isBurnStory ? "🔥 BURN STORY" :
                      isPFP ? "👤 PFP HOLDER" : isArena ? "⚔️ ARENA HYPE" :
                      p.signal_type === "community_gift" ? "🎁 COMMUNITY GIFT" :
                      p.signal_type === "creativity" ? "🎨 CREATIVITY" : "💬 COMMUNITY";

    return {
      type: "social_x",
      source: "twitter",
      weight,
      description: `${typeLabel} @${p.username}: "${p.text?.slice(0, 120)}${(p.text?.length ?? 0) > 120 ? "..." : ""}" [${p.likes ?? 0} likes]`,
      rawData: {
        username: p.username,
        text: p.text,
        likes: p.likes,
        url: p.url,
        signal_type: p.signal_type,
      },
      capturedAt: (p as any).capturedAt ?? new Date().toISOString(),
    };
  });
}

// ── Master collector ─────────────────────────────────────────────────
export async function collectAllSignals(): Promise<{
  signals: Signal[];
  sources: Record<string, number>;
  diversity: { lastFeaturedTokens: number[]; episodeCount: number; };
}> {
  console.log("[306] Collecting signals from all sources...");

  const [burns, canvas, opensea, farcaster, xSignals, grokSocial] = await Promise.allSettled([
    collectBurnSignals(),
    collectCanvasSignals(),
    collectOpenSeaSignals(),
    collectFarcasterSignals(),
    collectXSignals(),
    collectGrokSocialSignals(),  // Grok live search — always runs
  ]);

  const get = (r: PromiseSettledResult<Signal[]>) =>
    r.status === "fulfilled" ? r.value : [];

  const allSignals = [
    ...get(burns),
    ...get(canvas),
    ...get(opensea),
    ...get(farcaster),
    ...get(xSignals),
    ...get(grokSocial),
  ].sort((a, b) => b.weight - a.weight);

  const sources = {
    burns:      get(burns).length,
    canvas:     get(canvas).length,
    opensea:    get(opensea).length,
    farcaster:  get(farcaster).length,
    twitter:    get(xSignals).length + get(grokSocial).length,
  };

  console.log(`[306] Signals collected:`, sources);
  return {
    signals: allSignals,
    sources,
    diversity: {
      lastFeaturedTokens: state.lastFeaturedTokens,
      episodeCount: state.episodeCount,
    },
  };
}
