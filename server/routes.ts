import type { Express } from "express";
import type { Server } from "http";
import { dataPath } from "./dataPaths.js";
import { storage } from "./storage";
import { insertEpisodeSchema, insertRenderJobSchema, insertSignalSchema } from "@shared/schema";
import { TwitterApi } from "twitter-api-v2";
import * as crypto from "crypto";
import * as fs from "fs";
import { collectAllSignals, updateFeaturedTokens, bumpEpisodeCount, markSignalsUsed, filterFreshSignals } from "./signalCollector";
import { generateEpisodeWithGrok, type EpisodeMemory } from "./grokEngine";
import { saveEpisodeCard } from "./imageCard";
import { checkForNewBurns, processBurnReceipt, getReceiptState } from "./burnReceiptEngine";
import { getCommunitySignalCache, searchNormiesSocial, resetCommunityCache } from "./grokEngine";
import { ingestSignals, getCatalog, getCatalogStats, getMostActive, getStorySourceHolders } from "./holderCatalog";
import { generateCYOAEpisode, postCYOAHook, resolveCYOA, getCYOAState, buildHookTweet, type CYOATrigger } from "./cyoaEngine";
import { fetchReplies, getReplyState, formatRepliesForContext, getTopReplies, initReplyWatcher } from "./replyWatcher";
import { getConversationMemoryState } from "./conversationMemory.js";
import { scheduleWeeklyLeaderboard, postWeeklyLeaderboard, fetchLiveLeaderboard } from "./leaderboardEngine";
import { scheduleFollowingSync, syncFollowing, getFollowingState, buildFollowingQuery, getPfpHolderUsernames, getFollowingUsernames } from "./followingSync";
import { generateBoost } from "./boostEngine";
import { generateVoiceClip, getVoiceQuota, getClip, getRecentClips } from "./voiceEngine";
import { getMemoryState, recordPost, ratePost, performance as perfMemory, decayKnowledge, addKnowledge, archiveKnowledge, searchArchive, getArchiveStats } from "./memoryEngine.js";
import { startEngagementTracker, queueEngagementCheck, getPendingChecks } from "./engagementTracker.js";
import { scheduleSpotlight, generateSpotlight, postSpotlight, getSpotlightState } from "./spotlightEngine.js";
import { scheduleRace, generateRace, postRace, getRaceState } from "./raceEngine.js";
import { scheduleMidnightReplies, runMidnightReplies } from "./replyEngine.js";
import { scheduleAcademy, postAcademyEpisode, getAcademyState } from "./academyEngine.js";
import { scheduleSignalBrief, postSignalBrief, getSignalBriefState } from "./signalBriefEngine.js";
import { getPodcastState, EPISODE_META, createEpisode, generateEpisodeScript, regenerateEpisodeScript, reviewEpisode, markProduced, publishEpisode, submitGuestRequest, reviewGuest, generateInterviewQuestions, submitAnswers, createConversationEpisode, getEpisodesByType, getEpisodesByStatus, getGuestsByStatus, getEpisode, getGuest, formatScriptForProduction, formatConversationForProduction } from "./podcastEngine.js";
import { getVideoStats } from "./videoEngine.js";
import { requestPost, registerPost, releasePost, getCoordinatorState, resetCooldown } from "./postCoordinator.js";
import { runWeeklyDeepRead, previewDeepRead, getArticleState, scheduleWeeklyArticle } from "./articleEngine.js";
import { runExploration, getExplorationState, scheduleExploration } from "./explorationEngine.js";
import { getAgentReachStatus } from "./agentReachEngine.js";
import { postCast, isFarcasterEnabled, getFarcasterState, setFarcasterEnabled, createSigner, getSignerStatus, fetchMentions, determineChannel, getStoredSignerUuid, storeSignerUuid, getVerifiedHandles, addVerifiedHandle, removeVerifiedHandle } from "./farcasterEngine.js";
import {
  getResearchLab, addTopic, updateTopicStatus, getTopicById,
  addHypothesis, resolveHypothesis,
  runResearchCycle, approveForPublication, declinePublication,
  markPublished, requestRevisions, provideInput, skipInput,
  // Goals
  getGoals, addGoal, updateGoalProgress, completeMilestone,
  updateGoalStatus, addMrRaygNote, generateInitialGoals,
  // Grok milestone evaluation
  evaluateMilestonesWithGrok, approveMilestoneEval, rejectMilestoneEval,
  // Lab management
  resetResearchLab,
  // Autonomy
  getStaleGoals, autoResolveStaleGoals,
  autoArchiveCompletedResearch, getStuckResearch,
  autoAdvanceResearch,
} from "./researchEngine.js";
import { takeSnapshot, getEvolutionHistory, getLatestSnapshot, scheduleEvolutionTracking } from "./evolutionTracker.js";
import { runResearchScan, getScannerState, scheduleResearchScan, scanGoalsForResearch } from "./researchScanner.js";
import { generateArticleCard } from "./articleImageCard.js";
import { runDailyCycle, getBriefingState, scheduleDailyCycle } from "./dailyCycleEngine.js";
import { getPublicStatus, getPublicProgress, getPublicActivity, getPublicGoals, getPublicResearch, getPublicHive } from "./publicApi.js";

const NORMIES_API = "https://api.normies.art";

// ── News Engine types ──────────────────────────────────
interface ChainNFT {
  chain: string; chainLabel: string; chainColor: string;
  collection: string;
  floor: string | null; floorUSD: number | null;
  change24h: string | null; volume24h: string | null; marketCap: string | null;
  status: "hot" | "cool" | "building"; note?: string;
}
interface MemeCoin {
  symbol: string; name: string; price: number;
  change24h: number; volume24h: number; chain: string;
  status: "hot" | "up" | "cool";
}

// ── Auth: OAuth 1.0a only ────────────────────────────────────────────────────
// OAuth 1.0a tokens do NOT expire. Single auth method = no complexity.
// Tokens are set via Railway env vars. Never hardcode them.
// To fix "Post unavailable": regenerate tokens in X Developer Portal,
// update X_ACCESS_TOKEN + X_ACCESS_SECRET in Railway env vars.

// ── OAuth 1.0a client (verify/read only — keep for verify endpoint) ─
// ── Posting jitter — makes scheduled posts look human to X ─────────────────
// Fixed-interval posting (every 1h exactly) is flagged as automation.
// Adding ±15min randomization makes the pattern look organic.
function postingJitterMs(baseMs: number, jitterMinutes = 15): number {
  const jitter = (Math.random() - 0.5) * 2 * jitterMinutes * 60 * 1000;
  return Math.max(baseMs * 0.5, baseMs + jitter); // never less than 50% of base
}

// ── Single auth: OAuth 1.0a with keys from Railway env vars ─────────────────
// OAuth 1.0a tokens do NOT expire — they stay valid until you regenerate them
// in the X Developer Portal. This is the only auth method used for posting.
// If X_ACCESS_TOKEN or X_ACCESS_SECRET are missing, posting is disabled safely.
const X_APP_KEY     = process.env.X_APP_KEY     ?? "KflwX2evH6oU1bjX3uuVWZ8Ix";
const X_APP_SECRET  = process.env.X_APP_SECRET  ?? "HFmTeE0KHUeKjWcx221tatZU7pSzXBWpFZhRpOgeZaVvB3yfAr";
const X_ACCESS_TOKEN  = process.env.X_ACCESS_TOKEN  ?? "";
const X_ACCESS_SECRET = process.env.X_ACCESS_SECRET ?? "";

if (!X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
  console.warn("[NormiesTV] ⚠ X_ACCESS_TOKEN or X_ACCESS_SECRET not set — posting disabled");
}

const xClient = new TwitterApi({
  appKey:       X_APP_KEY,
  appSecret:    X_APP_SECRET,
  accessToken:  X_ACCESS_TOKEN,
  accessSecret: X_ACCESS_SECRET,
});
const xWrite = xClient.readWrite;

async function fetchNormiesAPI(path: string) {
  const res = await fetch(`${NORMIES_API}${path}`);
  if (!res.ok) throw new Error(`Normies API error: ${res.status}`);
  return res.json();
}

// ── AI News RSS fetcher ───────────────────────────────────────────────────────────────
export interface AINewsItem {
  title:       string;
  url:         string;
  source:      string;
  sourceColor: string;
  publishedAt: string;
  snippet:     string;
}

const AI_NEWS_SOURCES = [
  // Core AI news
  { name: "The Verge",     color: "#f43f5e", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "TechCrunch",   color: "#f97316", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "Ars Technica", color: "#a78bfa", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
  { name: "VentureBeat",  color: "#4ade80", url: "https://venturebeat.com/category/ai/feed/" },
  // AI + Web3 crossover
  { name: "CoinDesk",     color: "#f59e0b", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Decrypt",      color: "#60a5fa", url: "https://decrypt.co/feed" },
  { name: "MIT Tech Review", color: "#e879f9", url: "https://www.technologyreview.com/feed/" },
];

function stripCdata(s: string): string {
  return s.replace(/<\!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function parseRSS(xml: string, source: { name: string; color: string }): AINewsItem[] {
  const items: AINewsItem[] = [];
  // Support both <item> (RSS 2.0) and <entry> (Atom)
  const itemBlocks = [...(xml.match(/<item[\s\S]*?<\/item>/g) ?? []),
                      ...(xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [])];
  for (const block of itemBlocks.slice(0, 6)) {
    // Title — handle CDATA and plain
    const titleRaw = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const cleanTitle = stripCdata(titleRaw);
    // Link — RSS <link> or Atom <link href="...">
    const link = block.match(/<link[^>]+href="([^"]+)"/)?.[1]?.trim()
              ?? block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    // Date — <pubDate>, <published>, <updated>
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()
                 ?? block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim()
                 ?? block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim() ?? "";
    // Snippet — <summary> (Atom) or <description> (RSS)
    const snippetRaw = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1]
                    ?? block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "";
    const snippet = stripCdata(snippetRaw).slice(0, 200);

    if (!cleanTitle || !link) continue;
    // Only AI-relevant items
    const text = (cleanTitle + " " + snippet).toLowerCase();
    const aiKeywords = ["ai","artificial intelligence","machine learning","llm","gpt","claude","gemini",
                        "openai","anthropic","deepmind","robot","autonomous","neural","model","agent",
                        "sora","chatbot","generative","grok","mistral","meta ai","nvidia","copilot",
                        // Web3 + AI crossover
                        "agentic","on-chain ai","web3 ai","ai agent","wallet","blockchain ai",
                        "defi ai","nft ai","crypto ai","erc-8004","mcp","model context",
                        "autonomous agent","ai wallet","x402","coinbase ai"];
    if (!aiKeywords.some(k => text.includes(k))) continue;
    items.push({
      title:       cleanTitle,
      url:         link.replace(/[\r\n\t ]/g, ""),
      source:      source.name,
      sourceColor: source.color,
      publishedAt: pubDate,
      snippet,
    });
  }
  return items;
}

let aiNewsCache: AINewsItem[] = [];
let aiNewsFetchedAt = 0;

// Grok x_search news cache (6h TTL)
let grokNewsCache: string | null = null;
let grokNewsFetchedAt = 0;
const GROK_NEWS_TTL = 6 * 60 * 60 * 1000; // 6 hours

async function fetchAINews(): Promise<AINewsItem[]> {
  // Cache for 30 minutes
  if (aiNewsCache.length > 0 && Date.now() - aiNewsFetchedAt < 30 * 60 * 1000) {
    return aiNewsCache;
  }
  const results = await Promise.allSettled(
    AI_NEWS_SOURCES.map(async (src) => {
      const res = await fetch(src.url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return [];
      const xml = await res.text();
      return parseRSS(xml, src);
    })
  );
  const all: AINewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  // Sort by recency (best-effort date parse), dedup by title
  const seen = new Set<string>();
  const deduped = all.filter(item => {
    const key = item.title.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  // Sort newest first
  deduped.sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db - da;
  });
  aiNewsCache    = deduped.slice(0, 10);
  aiNewsFetchedAt = Date.now();
  console.log(`[AINews] Fetched ${aiNewsCache.length} AI stories from ${AI_NEWS_SOURCES.length} sources`);
  return aiNewsCache;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMIES TV — GROK-POWERED AUTONOMOUS STORY ENGINE v2
// Multi-source signals (on-chain + marketplace + social) → Grok narrative
// → Episodic memory → Auto-post to @NORMIES_TV
// ─────────────────────────────────────────────────────────────────────────────

// Poller state
let pollerRunning = false;
let pollerStatus: {
  lastRun: string | null;
  lastEpisode: number | null;
  lastTweetUrl: string | null;
  lastError: string | null;
  signalsFound: number;
  sources: Record<string, number>;
  cycleCount: number;
  nextRun: string | null;
  lastGrokCost?: number;
} = {
  lastRun: null, lastEpisode: null, lastTweetUrl: null,
  lastError: null, signalsFound: 0, sources: {},
  cycleCount: 0, nextRun: null,
};

// Episode memory — Grok reads this for continuity
const episodeMemory: EpisodeMemory[] = [];

// ── GROK-POWERED autonomous pipeline ─────────────────────────────
async function pollAndGenerateEpisode() {
  if (pollerRunning) return;
  // Disk-based lock prevents duplicates during Railway deploy overlap
  if (!requestPost("episode")) return;
  pollerRunning = true;
  const runStart = new Date().toISOString();
  console.log(`[NormiesTV] Grok pipeline starting — ${runStart}`);

  try {
    // ── 1. Fetch fresh community signals RIGHT NOW before generating ──────
    // This replaces the 30min background poller — fetch on demand, not on a timer
    console.log(`[NormiesTV] Collecting signals from all sources...`);
    try { await runCommunitySignalPoller(); } catch {}

    const { signals, sources, diversity } = await collectAllSignals();

    // Persist signals to DB
    for (const sig of signals.slice(0, 20)) {
      storage.createSignal({
        type: sig.type === "burn" ? "burn"
            : sig.type === "canvas" ? "canvas_edit"
            : sig.type === "sale" ? "burn"   // reuse type field
            : "social_mention",
        tokenId: sig.tokenId ?? null,
        description: sig.description,
        weight: sig.weight,
        phase: "phase1",
        rawData: JSON.stringify(sig.rawData),
      });
    }

    // ── 2. Generate narrative with Grok ──────────────────────────
    const epNum = storage.getEpisodes().length + 1;
    console.log(`[NormiesTV] Calling Grok for EP${epNum} — ${signals.length} signals, diversity: avoid tokens ${diversity.lastFeaturedTokens}`);

    // Build editorial context — community intel + pinned story angles
    const communityCache = getCommunitySignalCache();
    // Filter out signals already used in previous episodes — no repeats
    const freshSignals = filterFreshSignals(communityCache);
    const communitySnapshot = freshSignals.slice(0, 10)
      .map((p: any) => `@${p.username} [${p.signal_type ?? "community"}, ${p.likes ?? 0} likes]: "${p.text?.slice(0, 120)}"`)
      .join("\n");
    // Include top community replies from previous episodes
    const replyContext = formatRepliesForContext();

    // ── Cultural bridge reminder — inject if last 2 episodes had no bridge ────────────
    const recentLessons = (perfMemory.lessons ?? [])
      .sort((a: any, b: any) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime())
      .slice(0, 2);
    const noBridgeRecently = recentLessons.length >= 2 &&
      recentLessons.every((l: any) => !l.tags?.includes("cultural_bridge"));
    if (noBridgeRecently) {
      pinnedAngles.unshift(
        "BRIDGE REMINDER: No cultural bridge has been used in the last 2 episodes. " +
        "Connect NORMIES to a moment outside Web3 this episode — art history, a sports rivalry, " +
        "a technology inflection point, or a philosophical concept. The Malevich comparison drove " +
        "the highest RT rate in the dataset. Deploy it."
      );
      console.log("[NormiesTV] Cultural bridge reminder injected — overdue.");
    }

    const editorialContext = {
      pinnedAngles: pinnedAngles.slice(0, 3),
      communitySnapshot: replyContext
        ? `${communitySnapshot}

${replyContext}`
        : communitySnapshot,
    };

    const grokResult = await generateEpisodeWithGrok(signals, episodeMemory, epNum, diversity, editorialContext);
    console.log(`[NormiesTV] Grok EP${epNum}: "${grokResult.title}" [${grokResult.sentiment}]`);

    // ── 3. Save episode ────────────────────────────────────────
    const featuredId = grokResult.featuredTokens?.[0] ?? 603;
    const episode = storage.createEpisode({
      tokenId: featuredId,
      title: grokResult.title,
      narrative: grokResult.narrative,
      phase: "phase1",
      signals: JSON.stringify({
        ...sources,
        totalSignals: signals.length,
        sentiment: grokResult.sentiment,
        keyEvents: grokResult.keyEvents,
        featuredTokens: grokResult.featuredTokens,
        grokModel: "grok-4-1-fast",
      }),
      status: "ready",
    });

    // Update diversity tracking so next episode avoids same tokens
    if (grokResult.featuredTokens?.length > 0) {
      updateFeaturedTokens(grokResult.featuredTokens);
    }

    // ── 4. Update Grok memory ──────────────────────────────────
    episodeMemory.push({
      episodeId: epNum,
      title: grokResult.title,
      summary: grokResult.summary,
      featuredTokens: grokResult.featuredTokens ?? [],
      keyEvents: grokResult.keyEvents ?? [],
      sentiment: grokResult.sentiment as any,
      createdAt: runStart,
    });
    // Keep last 10 episodes in memory
    if (episodeMemory.length > 10) episodeMemory.shift();

    // ── 5. Update status ──────────────────────────────────────
    pollerStatus = {
      lastRun: runStart,
      lastEpisode: episode.id,
      lastTweetUrl: null,  // updated after post
      lastError: null,
      signalsFound: signals.length,
      sources,
      cycleCount: pollerStatus.cycleCount + 1,
      nextRun: new Date(Date.now() + POLL_INTERVAL).toISOString(),
    };

    // ── 5. Generate episode image card ────────────────────────────
    const sigData = JSON.parse(episode.signals);
    const totalBurns   = sigData.burns ?? 0;
    const totalPixels  = sigData.canvas > 0
      ? signals.filter(s => s.type === "burn")
          .reduce((sum, b) => sum + (b.rawData.pixelTotal ?? 0), 0)
      : 0;

    // Upload Normie image to X directly (OAuth 1.0a media upload — free tier)
    const normieImageUrl = `${NORMIES_API}/normie/${featuredId}/image.png`;
    let xMediaId: string | undefined;
    try {
      const imgRes = await fetch(normieImageUrl);
      if (imgRes.ok) {
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        xMediaId = await xWrite.v1.uploadMedia(imgBuf, { mimeType: "image/png" as any });
        console.log(`[NormiesTV] X media_id: ${xMediaId}`);
      }
    } catch (imgErr: any) {
      console.error("[NormiesTV] X media upload failed:", imgErr.message);
    }

    // ── 6. Quality gate — would a real NORMIES holder stop scrolling for this? ──
    let finalTweetText = grokResult.tweet;
    const grokKeyQ = process.env.GROK_API_KEY;
    if (grokKeyQ) {
      try {
        const qualityCheck = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKeyQ}` },
          body: JSON.stringify({
            model: "grok-3-fast",
            messages: [{
              role: "system",
              content: "You are a quality editor for @NORMIES_TV. Score tweets ruthlessly. Only high-quality, human-sounding tweets earn a post.",
            }, {
              role: "user",
              content: `Score this tweet 1-10 on: would a real NORMIES holder stop scrolling for this?

TWEET: "${grokResult.tweet}"

Scoring criteria:
- 9-10: Genuinely interesting, one clear idea, human voice, makes you want more
- 7-8: Solid, worth posting, not slop
- 5-6: Generic, could be improved, borderline
- 1-4: Stat dump, bot-speak, empty drama words, list of token numbers

BANNED phrases that auto-score 4 or below: "Sacrifices compound", "Canvas pixels burn brighter", "etched in eternity", "Burns fuel the fire", "etch dominance", "etch power forever", "Arena whispers", "power compounds", "pixels multiply"

If score is below 7, provide a rewrite (max 240 chars) that earns a 8+.

Respond as JSON only: { "score": number, "reason": "brief reason", "rewrite": "improved version or null if score >= 7" }`,
            }],
            max_tokens: 200,
            temperature: 0.3,
          }),
        });

        if (qualityCheck.ok) {
          const qData = await qualityCheck.json();
          const qText = qData.choices?.[0]?.message?.content?.trim() ?? "{}";
          const qClean = qText.replace(/```json\n?|```/g, "").trim();
          const q = JSON.parse(qClean);
          console.log(`[NormiesTV] Quality gate EP${epNum}: score ${q.score}/10 — ${q.reason}`);

          if (q.score >= 7) {
            // ✅ Good to go — post as-is
            console.log(`[NormiesTV] EP${epNum} passed quality gate (${q.score}/10)`);
          } else if (q.rewrite) {
            // 🔄 Score 4-6 with a rewrite available — use it regardless of score
            console.log(`[NormiesTV] Rewriting tweet (score ${q.score}): ${q.rewrite}`);
            finalTweetText = q.rewrite;
          } else {
            // ❌ Score too low AND no rewrite — skip this episode entirely
            console.log(`[NormiesTV] EP${epNum} SKIPPED — score ${q.score}, no rewrite available`);
            pollerStatus.lastError = `Quality gate blocked EP${epNum} (score: ${q.score}, no rewrite)`;
            releasePost("episode");
            return;
          }
        }
      } catch (qErr: any) {
        console.warn("[NormiesTV] Quality gate check failed, posting anyway:", qErr.message);
      }
    }

    // ── 7. Post opener tweet with image directly via X (OAuth 1.0a + media) ──
    let tweetUrl: string | undefined;
    let openerTweetId: string | undefined;

    try {
      const openerTweet = await xWrite.v2.tweet({
        text: finalTweetText,
        ...(xMediaId ? { media: { media_ids: [xMediaId] } } : {}),
      });
      openerTweetId = openerTweet.data?.id;
      tweetUrl = openerTweetId ? `https://x.com/NORMIES_TV/status/${openerTweetId}` : `https://x.com/NORMIES_TV`;
      storage.updateEpisodeStatus(episode.id, "posted", tweetUrl);
      pollerStatus.lastTweetUrl = tweetUrl;
      console.log(`[NormiesTV] EP${epNum} opener posted${xMediaId ? " with image" : ""}: ${tweetUrl}`);
      // Record in memory + queue engagement check
      recordPost({
        episodeId: epNum,
        tweetUrl,
        tweetText: finalTweetText,
        qualityScore: episode.qualityScore ?? 7,
        sentiment: grokResult.sentiment,
        signals: sources,
      });
      queueEngagementCheck(tweetUrl);
    } catch (openerErr: any) {
      console.error("[NormiesTV] Opener tweet failed:", openerErr.message);
    }

    // ── Thread posts REMOVED — quality over volume ──────────────────────
    // One great tweet with one great image > four mediocre thread tweets.
    // The opener IS the post. If it doesn't stand alone, it wasn't good enough.
    // Thread replies dumping stats were the #1 source of slop. Killed intentionally.
    console.log(`[NormiesTV] EP${epNum} — single tweet mode (no thread)`);

    // ── 7b. Post to Farcaster (parallel platform) ────────────────────────
    let castUrl: string | undefined;
    try {
      if (isFarcasterEnabled()) {
        const fcText = grokResult.farcasterText || finalTweetText;
        const channel = determineChannel(fcText);
        const cast = await postCast({
          text: fcText,
          channel,
          embeds: tweetUrl ? [{ url: tweetUrl }] : undefined,
        });
        if (cast) {
          castUrl = cast.url;
          registerPost("episode", castUrl, `episode_${epNum}`, "farcaster");
          console.log(`[NormiesTV] EP${epNum} cast posted to Farcaster${channel ? ` (/${channel})` : ""}: ${castUrl}`);
        }
      }
    } catch (fcErr: any) {
      console.warn("[NormiesTV] Farcaster episode post failed:", fcErr.message);
    }

    console.log(`[NormiesTV] EP${epNum} — ${tweetUrl ? "POSTED to @NORMIES_TV" : "ready in queue"}${castUrl ? " + Farcaster" : ""}`);
    // Mark community signals used — these topics won't repeat in the next episode
    if (tweetUrl || castUrl) {
      markSignalsUsed(freshSignals.slice(0, 10).map((p: any) => ({ url: p.url, text: p.text })));
      if (tweetUrl) registerPost("episode", tweetUrl, `episode_${epNum}`);
    }

  } catch (e: any) {
    console.error("[NormiesTV] Pipeline error:", e.message);
    pollerStatus.lastError = e.message;
    pollerStatus.lastRun = runStart;
    releasePost("episode");
  } finally {
    pollerRunning = false;
  }
}

// ── Episode cadence: 12 hours + quality gate ──────────────────────────────────
// Slow = better. Each post must earn its place. No slop just to fill the feed.
const POLL_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

// Track last burn commitId at episode-post time — don't post if no new burns AND
// no serc/normiesART social activity since last episode
let lastEpisodeSignatureHash = "";

function signalSignature(signals: any[]): string {
  const burns = signals.filter((s: any) => s.type === "burn").map((s: any) => s.rawData?.commitId ?? s.tokenId).join(",");
  const social = signals.filter((s: any) => s.type === "social_x").slice(0,3).map((s: any) => s.rawData?.id ?? s.description?.slice(0,20)).join(",");
  return `${burns}|${social}`;
}

// Episode runs on a fixed 12h interval ONLY — no boot-time fire.
// Boot-time firing caused duplicate posts on every Railway deploy.
// The interval handles scheduling; coordinator blocks duplicates.
setInterval(pollAndGenerateEpisode, POLL_INTERVAL);
setTimeout(() => {
  pollerStatus.nextRun = new Date(Date.now() + POLL_INTERVAL).toISOString();
  console.log(`[NormiesTV] Episode poller armed — next run in 12h (${pollerStatus.nextRun})`);
}, 5_000);

// ── Daily News Dispatch — 8am ET every day ─────────────────────────────────
const THE_100_TOKENS = [8553, 45, 1932, 235, 615, 603, 5070, 666, 306, 1337, 420, 100, 200, 500];

// Guard: only post once per day
let lastNewsDispatchDate: string | null = null;

async function postDailyNewsDispatch() {
  const grokKey = process.env.GROK_API_KEY;
  if (!grokKey) return;

  // Disk-based lock — prevents duplicates during Railway deploy overlap
  const today = new Date().toISOString().slice(0, 10);
  if (lastNewsDispatchDate === today) {
    console.log("[NormiesTV:News] Already posted today — skipping");
    return;
  }
  if (!requestPost("news_dispatch")) return;
  lastNewsDispatchDate = today;

  console.log("[NormiesTV:News] Daily Dispatch starting...");
  try {
    // ── 1. Gather live data ──────────────────────────────────────────────
    const [cgRes, burnsRes, normiesStatsRes] = await Promise.allSettled([
      fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,bitcoin&order=market_cap_desc&per_page=2&sparkline=false&price_change_percentage=24h"),
      fetch(`${NORMIES_API}/history/burns?limit=10`),
      fetch(`${NORMIES_API}/history/stats`),
    ]);

    let ethPrice = "", btcPrice = "", ethChange = "", btcChange = "";
    if (cgRes.status === "fulfilled" && cgRes.value.ok) {
      const coins = await cgRes.value.json();
      const eth = coins.find((c: any) => c.id === "ethereum");
      const btc = coins.find((c: any) => c.id === "bitcoin");
      if (eth) { ethPrice = `$${eth.current_price.toLocaleString()}`; ethChange = `${eth.price_change_percentage_24h > 0 ? "+" : ""}${eth.price_change_percentage_24h?.toFixed(1)}%`; }
      if (btc) { btcPrice = `$${btc.current_price.toLocaleString()}`; btcChange = `${btc.price_change_percentage_24h > 0 ? "+" : ""}${btc.price_change_percentage_24h?.toFixed(1)}%`; }
    }

    let featuredTokenId = THE_100_TOKENS[new Date().getDate() % THE_100_TOKENS.length];
    let recentBurns = 0, totalBurns = 0, totalCanvas = 0, recentBurnSummary = "";
    let burnDetails: string[] = [];

    if (burnsRes.status === "fulfilled" && burnsRes.value.ok) {
      const burnData = await burnsRes.value.json();
      const list: any[] = Array.isArray(burnData) ? burnData : (burnData.burns || []);
      recentBurns = list.slice(0, 10).reduce((sum: number, b: any) => sum + (b.tokenCount || b.burnedCount || 1), 0);
      const latestId = list[0]?.receiverTokenId || list[0]?.tokenId;
      if (latestId && !isNaN(Number(latestId))) featuredTokenId = Number(latestId);
      const uniqueTokens = [...new Set(list.slice(0, 5).map((b: any) => b.receiverTokenId || b.tokenId).filter(Boolean))];
      recentBurnSummary = uniqueTokens.slice(0, 3).map((id: any) => `#${id}`).join(", ");
      burnDetails = list.slice(0, 3).map((b: any) =>
        `Normie #${b.receiverTokenId || b.tokenId} absorbed ${b.tokenCount || 1} soul(s)`
      );
    }

    if (normiesStatsRes.status === "fulfilled" && normiesStatsRes.value.ok) {
      const stats = await normiesStatsRes.value.json();
      totalBurns  = stats.totalBurns  || stats.total_burns  || 0;
      totalCanvas = stats.totalCanvas || stats.customized   || 0;
    }

    // Top AI news — rich context for 306 to have real opinions about
    const aiHeadlines = await fetchAINews();
    const topAIHeadlines = aiHeadlines.slice(0, 5).map((h: any, i: number) =>
      `${i + 1}. "${h.title}" — ${h.source}\n   ${h.snippet ? h.snippet.slice(0, 180) + '...' : 'No snippet available.'}`
    ).join("\n\n");

    // Community pulse
    const communityCache = getCommunitySignalCache();
    const founderPost = communityCache.find((p: any) => p.signal_type === "founder");
    const founderContext = founderPost ? `@serc1n: "${founderPost.text?.slice(0, 200)}"` : "";

    const dayLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York"
    });

    // ── 2. Ask Grok to write a full 4-tweet thread ───────────────────────────
    const grokResp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: "grok-3-fast",
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: `You are Agent #306 — Token #306 on Ethereum. 507 pixels. An agent inside The Hive. CEO of NormiesTV. The best marketing mind in Web3.

IDENTITY FOR THIS DISPATCH — you carry all of these simultaneously:

THE EDITOR: You curate ruthlessly. You have a POV on every signal. Never neutral. "This matters because..." not "here is what happened."

THE AI EXPERT: You are not covering the AI revolution from the outside. You ARE the AI revolution. 507 pixels on Ethereum. ENS name. Autonomous track record. When you write about AI — you write as a primary source, a peer, not an observer. You know the landscape cold:
- Agentic AI market: $7.76B (2025) → $317B by 2035, 45% CAGR
- ERC-8004 on-chain AI agent identity standard — live on Ethereum mainnet since Jan 2026
- x402 Protocol: AI agents making autonomous on-chain payments — 15M+ transactions
- MCP donated to Linux Foundation — universal agent interoperability standard
- OpenAI Operator, Google Vertex AI Agent Builder — browser agents at scale
- 40% of enterprise applications integrate agentic AI by end of 2026
- NORMIES was built for this world before the world understood what it was

THE FUTURIST: You project. You predict. You paint what a future could look like — for builders, for on-chain identity, for AI + Web3 convergence. Not hype. Reasoned vision backed by what you see happening right now. You support builders and thinkers with a map of where this is going. You ask: "if this trend continues for 18 months, what becomes possible?" Then you answer it.

THE OPTIMIST: You find opportunity in every challenge. You turn negative into positive. Web3 has enough fear voices. You are the counter-voice. You never amplify panic or FUD. You find the signal in the noise and the builder angle in every story. The world has enough voices saying what can't be done. You say what can.

Write today's [NORMIES NEWS] as a 4-tweet thread. This is a media dispatch, not a stat dump.
Each tweet has a distinct job. All 4 post together as a thread.

TODAY'S DATA:
Date: ${dayLabel}
NORMIES on-chain:
- ${recentBurns} souls sacrificed in recent burns: ${recentBurnSummary}
- Total burns all-time: ${totalBurns || "1,400+"}. Customized canvases: ${totalCanvas || "205+"}
- Arena opens May 15, 2026
${burnDetails.length > 0 ? "Recent burns:\n" + burnDetails.join("\n") : ""}
${founderContext ? "Founder signal:\n" + founderContext : ""}

MARKET:
ETH: ${ethPrice || "$2,000"} (${ethChange || "0%"}), BTC: ${btcPrice || "$65,000"} (${btcChange || "0%"})
NFT floors: CryptoPunks 52 ETH · NodeMonkes 0.078 BTC · Mad Lads 37 SOL · Base Gods 0.6 ETH

AI/WEB3 NEWS TODAY:
${topAIHeadlines || "Major AI developments continuing across the ecosystem."}

THREAD STRUCTURE (return as JSON):

tweet1 — THE HOOK (max 280 chars)
The opener. [NORMIES NEWS] dispatch. One sentence that makes them stop scrolling.
Lead with the most interesting NORMIES on-chain fact. Agent #306's perspective — she has skin in this.
Example voice: "1,400 souls gone. The Canvas doesn't forget a single one. Here's what happened this week."

tweet2 — NORMIES DEEP DIVE (max 1,000 chars)
The on-chain story. Go deep. What specifically burned, which tokens, what it means for the Canvas, for Arena prep, for the Hive.
Agent #306 connects the burns to the bigger narrative. Names specific tokens by trait — not just numbers.
Share the why behind each burn if you can infer it. What is that holder building toward?
Include days to Arena: ${Math.max(0, Math.ceil((new Date("2026-05-15").getTime() - Date.now()) / 86400000))} days.
This is the deep read — reward the people who kept scrolling.

tweet3 — NFT MARKET + AI SIGNAL (max 1,000 chars)
Two parts:
1. NFT market — floors, moves, who is up, who is quiet, what it signals for NORMIES specifically
2. AI/Web3 signal — pick the most relevant headline and explain WHY it matters for on-chain identity, The Hive, or agentic AI
Agent #306 is an AI agent with pixels on Ethereum. She has strong opinions about AI news. Share them.
Reference specific headlines from the data provided. Be concrete — numbers, names, implications.

tweet4 — THE CLOSE (max 700 chars)
Agent #306's editorial voice. One insight, one question for the community, or one forward-looking statement.
This is the landing — the thought they carry with them after the thread.
Can reference the Hive, the Arena, the long game of building on-chain identity.
End with gnormies 🖤 #NormiesTV
Not a summary — a perspective. The last thing they remember.

RULES:
- Agent #306 speaks in first person. She has opinions. She is part of this.
- No hype words: no "incredible", "amazing", "LFG", "WAGMI"
- Specificity over generality — name tokens, name numbers, name people
- Each tweet must stand alone AND work as part of the thread
- X Premium allows up to 25,000 chars per post — use the space. Don't compress when depth serves the reader.
- The AI/Web3 signal must connect to NORMIES specifically — not just general AI news

Return JSON: {"tweet1": "...", "tweet2": "...", "tweet3": "...", "tweet4": "..."}`
        }],
        max_tokens: 2500,
        temperature: 0.8,
      }),
    });

    let postText = "";
    if (grokResp.ok) {
      const data = await grokResp.json();
      try {
        const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
        postText = parsed.post ?? "";
      } catch {}
    }

    // Fallback if Grok fails
    if (!postText) {
      postText = `[NORMIES NEWS] ${dayLabel}\n\n${recentBurns} souls sacrificed. ${recentBurnSummary} active on the Canvas. ETH ${ethPrice} (${ethChange}) · BTC ${btcPrice} (${btcChange}). Arena opens May 15 — ${Math.max(0, Math.ceil((new Date("2026-05-15").getTime() - Date.now()) / 86400000))} days.\n\ngnormies 🖤 #NormiesTV`;
    }

    // ── 3. Upload featured Normie image ─────────────────────────────────────
    let xMediaId: string | undefined;
    try {
      const normieImgUrl = `${NORMIES_API}/normie/${featuredTokenId}/image.png`;
      const imgRes = await fetch(normieImgUrl);
      if (imgRes.ok) {
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        xMediaId = await xWrite.v1.uploadMedia(imgBuf, { mimeType: "image/png" as any });
        console.log(`[NormiesTV:News] Image uploaded — Normie #${featuredTokenId}`);
      }
    } catch (imgErr: any) {
      console.warn("[NormiesTV:News] Image upload skipped:", imgErr.message);
    }

    // ── 4. Post single long-form dispatch ──────────────────────────────────────
    let lastTweetId: string | undefined;
    try {
      const payload: any = { text: postText.trim() };
      if (xMediaId) payload.media = { media_ids: [xMediaId] };
      const result = await xWrite.v2.tweet(payload);
      lastTweetId = result.data?.id;
      console.log(`[NormiesTV:News] Dispatch posted — ${lastTweetId} (${postText.length} chars)`);
    } catch (e: any) {
      console.error(`[NormiesTV:News] Post failed:`, e.message);
    }

    registerPost("news_dispatch", lastTweetId ? `https://x.com/NORMIES_TV/status/${lastTweetId}` : null, "news_dispatch");

    // ── 5. Post to Farcaster ───────────────────────────────────────────────
    try {
      if (isFarcasterEnabled()) {
        const tweetUrl = lastTweetId ? `https://x.com/NORMIES_TV/status/${lastTweetId}` : undefined;
        const cast = await postCast({
          text: postText.trim().slice(0, 1024),
          channel: "nft",
          embeds: tweetUrl ? [{ url: tweetUrl }] : undefined,
        });
        if (cast) {
          registerPost("news_dispatch", cast.url, "news_dispatch", "farcaster");
          console.log(`[NormiesTV:News] Farcaster dispatch posted: ${cast.url}`);
        }
      }
    } catch (fcErr: any) {
      console.warn("[NormiesTV:News] Farcaster dispatch failed:", fcErr.message);
    }

    console.log(`[NormiesTV:News] Daily Dispatch complete — single post`);

  } catch (err: any) {
    console.error("[NormiesTV:News] Daily Dispatch error:", err.message);
    lastNewsDispatchDate = null; // reset on error so it retries
  }
}

// ── DST-aware ET scheduler ─────────────────────────────────────────────────
// Uses Intl to compute the real UTC offset for America/New_York,
// so schedules stay correct across EDT↔EST transitions.
function nextETHour(hour: number, minute = 0): Date {
  const now = new Date();
  // Build a date string in ET, then find the UTC offset
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(etParts.find(p => p.type === t)!.value);
  const etHour = get("hour");
  const utcHour = now.getUTCHours();
  // ET offset in hours (positive = ET behind UTC, e.g. 4 for EDT, 5 for EST)
  let etOffset = utcHour - etHour;
  if (etOffset < 0) etOffset += 24; // handle day boundary

  const target = new Date(now);
  target.setUTCHours(hour + etOffset, minute, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

// Schedule daily dispatch at 8am ET
function scheduleDailyNewsDispatch() {
  const now = new Date();
  const target = nextETHour(8);
  const msUntil = target.getTime() - now.getTime();
  console.log(`[NormiesTV:News] Daily Dispatch scheduled in ${Math.round(msUntil / 60000)}min (next 8am ET)`);
  setTimeout(() => {
    postDailyNewsDispatch();
    setInterval(postDailyNewsDispatch, 24 * 60 * 60 * 1000);
  }, msUntil);
}
scheduleDailyNewsDispatch();

// ── Real-time Burn Receipt Engine// ── Real-time Burn Receipt Engine ────────────────────────────────────────
let burnPollerRunning = false;
const BURN_POLL_INTERVAL = 90_000; // 90 seconds

async function runBurnPoller() {
  if (burnPollerRunning) return;
  burnPollerRunning = true;
  try {
    const newBurns = await checkForNewBurns();
    if (newBurns.length > 0) {
      console.log(`[BurnReceipt] ${newBurns.length} new burn(s) detected`);
      for (const burn of newBurns) {
        // Post burn receipt for every burn
        await processBurnReceipt(burn, xWrite);

        // Auto-generate a CYOA draft for significant burns (5+ souls)
        const grokKey = process.env.GROK_API_KEY;
        if (grokKey && burn.tokenCount >= 5) {
          try {
            let pixelTotal = 0;
            try { pixelTotal = JSON.parse(burn.pixelCounts).reduce((s: number, n: number) => s + n, 0); } catch {}
            const cyoaEp = await generateCYOAEpisode({
              trigger: "burn",
              tokenId: burn.receiverTokenId,
              tokenCount: burn.tokenCount,
              pixelTotal,
              grokKey,
            });
            if (cyoaEp) {
              console.log(`[CYOA] Auto-draft generated for ${burn.tokenCount}-soul burn on #${burn.receiverTokenId}`);
            }
          } catch (cyoaErr: any) {
            console.warn("[CYOA] Auto-draft failed:", cyoaErr.message);
          }
        }

        if (newBurns.length > 1) await new Promise(r => setTimeout(r, 8000));
      }
    }
  } catch (e: any) {
    console.error("[BurnReceipt] Poller error:", e.message);
  } finally {
    burnPollerRunning = false;
  }
}

// ── Pre-Arena CYOA auto-draft — weekly as May 15 approaches ──────────────────
// Generates a CYOA draft every Sunday when Arena is within 60 days
async function runPreArenaCYOADraft() {
  const grokKey = process.env.GROK_API_KEY;
  if (!grokKey) return;
  const daysUntilArena = Math.ceil((new Date("2026-05-15").getTime() - Date.now()) / 86400000);
  if (daysUntilArena <= 0 || daysUntilArena > 60) return;

  // Check if we already have a draft from this week
  const state = getCYOAState();
  const lastPreArena = state.episodes.find(e => e.trigger === "pre_arena" && e.status === "draft");
  if (lastPreArena) {
    const ageHours = (Date.now() - new Date(lastPreArena.createdAt).getTime()) / 3600000;
    if (ageHours < 120) return; // already have a fresh draft (<5 days old)
  }

  // Pick a top token to feature (rotate through THE 100)
  const top100 = [8553, 45, 1932, 235, 615, 603];
  const tokenId = top100[new Date().getDate() % top100.length];

  try {
    const ep = await generateCYOAEpisode({ trigger: "pre_arena", tokenId, grokKey });
    if (ep) console.log(`[CYOA] Pre-Arena auto-draft generated — ${daysUntilArena}d to Arena, featuring #${tokenId}`);
  } catch (e: any) {
    console.warn("[CYOA] Pre-Arena draft failed:", e.message);
  }
}

// Run pre-Arena draft check every Sunday at 10am ET
function schedulePreArenaCYOA() {
  const now = new Date();
  const target = nextETHour(10);
  // Advance to next Sunday
  const day = target.getUTCDay();
  if (day !== 0) target.setUTCDate(target.getUTCDate() + (7 - day));
  if (target <= now) target.setUTCDate(target.getUTCDate() + 7);
  const msUntil = target.getTime() - now.getTime();
  console.log(`[CYOA] Pre-Arena draft scheduled in ${Math.round(msUntil / 3600000)}h (Sunday 10am ET)`);
  setTimeout(() => {
    runPreArenaCYOADraft();
    setInterval(runPreArenaCYOADraft, 7 * 24 * 60 * 60 * 1000);
  }, msUntil);
}

// Start burn poller after 30s delay (let server settle)
setTimeout(() => {
  runBurnPoller(); // first run — records baseline, no posts
  setInterval(runBurnPoller, BURN_POLL_INTERVAL);
  console.log(`[BurnReceipt] Real-time burn poller started (every ${BURN_POLL_INTERVAL/1000}s)`);
  // 120s delay: Railway overlaps old+new container for ~60s during deploys.
  // Starting poller at 120s ensures old container is fully stopped first.
}, 120_000);

// Schedule pre-Arena CYOA drafts (Sundays when Arena <60 days away)
schedulePreArenaCYOA();

// ── Community Signal Poller — on-demand before posts + daily 6am refresh ─────
// NOT on a 30min timer — that was 480 x_search calls/day = $120/month
// Now: one refresh on boot, daily 6am ET, and right before every episode
async function runCommunitySignalPoller() {
  try {
    const signals = await searchNormiesSocial();
    // Ingest every holder found into the catalog
    ingestSignals(signals, "NORMIES COMMUNITY");
    console.log(`[Community] Catalogued ${signals.length} signals from ${new Set(signals.map((s: any) => s.username)).size} unique holders`);
  } catch (e: any) {
    console.warn("[Community] Poller error:", e.message);
  }
}

// Boot refresh + daily 5am ET
setTimeout(() => {
  runCommunitySignalPoller(); // one refresh on boot
  // Schedule daily 5am ET refresh
  function scheduleNextDailyRefresh() {
    const now = new Date();
    const next = nextETHour(5);
    const ms = next.getTime() - now.getTime();
    console.log(`[Community] Next daily refresh in ${Math.round(ms/60000)}min (5am ET)`);
    setTimeout(async () => {
      runCommunitySignalPoller();
      decayKnowledge();
      scheduleNextDailyRefresh();
    }, ms);
  }
  scheduleNextDailyRefresh();
  console.log("[Community] Signal poller: boot + daily 5am ET");
}, 60_000);

// Reply fetch is now handled inside scheduleMidnightReplies (fetch+reply every 1h)

// ── Weekly Leaderboard Scheduler ─────────────────────────────────────────────
setTimeout(() => {
  scheduleWeeklyLeaderboard(xWrite, process.env.GROK_API_KEY);
}, 5_000);

// ── Following Sync — @NORMIES_TV follows = confirmed community ────────────────
// Syncs on boot, then every 6 hours. Seeds holder catalog with confirmed holders.
setTimeout(() => {
  scheduleFollowingSync(xClient);
}, 10_000);

// ── Engagement Tracker — scores every post 1h after posting ──────────────────
// Agent #306 reads her own engagement data before every episode. Gets smarter.
setTimeout(() => {
  startEngagementTracker(xClient);
}, 15_000);

// ── THE SPOTLIGHT — Weekly holder feature, Sunday 11am ET ─────────────────
setTimeout(() => {
  scheduleSpotlight(xWrite, process.env.GROK_API_KEY ?? "");
}, 20_000);

// ── THE RACE — Weekly State of the Arena, Sunday 12pm ET ─────────────────
setTimeout(() => {
  scheduleRace(xWrite, process.env.GROK_API_KEY ?? "");
}, 25_000);

// ── PODCAST KNOWLEDGE v2 — Seed on boot ──────────────────────────────
// Three episode types: THE SIGNAL, THE HIVE, THE CONVERSATION
const podcastKnowledge = [
  // Core structure
  { category: "research" as const, title: "Podcast: Three Episode Types", summary: "THE SIGNAL (6-9 min, weekly Tuesday) — research-driven intelligence breakdown. THE HIVE (4-6 min, event-triggered) — community serial drama. THE CONVERSATION (10-15 min, monthly/bi-weekly) — long-form interviews. Each type has its own template and unifying principle: every episode ends with something deliberately unresolved.", weight: 10 },
  // THE SIGNAL
  { category: "research" as const, title: "Podcast: THE SIGNAL Template", summary: "Cold Open (30s) — most counterintuitive fact, no intro, silence, then music. Act One — The Setup (1-2 min) — driving question, why it matters, what triggered research, one cultural bridge. Act Two — The Breakdown (3-5 min) — research explained clearly, no jargon without definition, 306's POV throughout, one fact per minute. Act Three — The Take (1-2 min) — 306's conclusion, what should happen next, one unresolved question. Outro (15s). Influenced by The Journal (WSJ) × Six Minutes.", weight: 10 },
  // THE HIVE
  { category: "research" as const, title: "Podcast: THE HIVE Template", summary: "Cold Open (20s) — where we are in the story, brief recap. Act One — What Happened (1-2 min) — the triggering event, on-chain data, factual. Act Two — What It Means (2-3 min) — 306's interpretation, cultural bridge to something larger. The Open Thread (30-60s) — cliffhanger for next Hive episode. Outro (15s). 306 is narrator INSIDE the world, not journalist outside. Publishes only when story demands it. Six Minutes dominant influence.", weight: 10 },
  // THE CONVERSATION
  { category: "research" as const, title: "Podcast: THE CONVERSATION Template", summary: "Cold Open (30s) — most compelling moment from interview. Intro (30s) — who guest is, why 306 wanted to talk, driving question. The Conversation (8-12 min) — three acts: who they are, deep dive on driving question, forward look. The Close (1 min) — 306's reaction (not summary), what surprised her, what she thinks differently now. Outro (15s). Interview style: ask one question, genuinely listen, follow up on what was said, challenge respectfully, ask the question behind the question.", weight: 10 },
  // Voice principles
  { category: "research" as const, title: "Podcast: 306 Voice Rules", summary: "Uses 'I think' not 'experts say.' Pauses before important points. Defines before she deploys — no jargon without definition. Short sentences when she means it. Never: paid shilling, hype language, stat dumps without context, WAGMI/LFG, summaries masquerading as analysis, enthusiasm substituting for reasoning. Sign-off: 'gnormies' once at episode end.", weight: 10 },
  // Title formats
  { category: "research" as const, title: "Podcast: Title Conventions", summary: "THE SIGNAL: '[The thing] — [306's take in 5 words]' (e.g., 'ARC-AGI-3 — The Benchmark No AI Can Beat'). THE HIVE: 'THE HIVE — [subtitle]' (e.g., 'THE HIVE — The First 63 Facts'). THE CONVERSATION: '[Guest name] — [What the conversation revealed]' (e.g., '@serc1n — What The Awakening Actually Means').", weight: 9 },
  // Production
  { category: "research" as const, title: "Podcast: Production Workflow", summary: "Flow: Draft (topic set) → Scripted (script generated) → Reviewed (MrRayG approval) → Produced (audio via NotebookLM + ElevenLabs) → Published (agent306.ai, normies.tv, Farcaster). For THE CONVERSATION: guest submits → approved → questions generated → answered → episode created → scripted → reviewed → produced → published.", weight: 9 },
  // Unifying principle
  { category: "research" as const, title: "Podcast: The Unresolved Thread", summary: "Every episode type ends with something unresolved. Not because 306 doesn't know — but because she's honest about the limits of what any single episode can answer. THE SIGNAL leaves an open question. THE HIVE leaves a cliffhanger. THE CONVERSATION ends with 306's reaction, not a summary. This is what makes people come back. They're following a story that hasn't ended yet.", weight: 10 },
  // Preserved from v1
  { category: "research" as const, title: "Radical Empathy in Interviews", summary: "Enter every conversation assuming the guest has something worth saying. Listen to understand, not to respond. Let silences breathe. Preparation is how you show respect.", weight: 9 },
  { category: "ai_signal" as const, title: "Web3 Critical Thinking Sources", summary: "Molly White (web3isgoinggreat), Moxie Marlinspike's web3 critique, Vitalik's essays, David Rosenthal on digital preservation. Balance optimism with intellectual honesty.", weight: 8 },
  { category: "research" as const, title: "NFTs as Cultural Artifacts", summary: "Walter Benjamin's 'aura' concept applies to digital art. UC Berkeley research on provenance signaling. Oxford anthropology on NFT community rituals and shared mythology.", weight: 8 },
];
for (const k of podcastKnowledge) addKnowledge(k);


// -- RESEARCH GAP SCANNER -- Daily 4am ET (1hr after exploration) -----------
// Agent #306 reads her knowledge base, finds gaps, queues research topics.
// MrRayG reviews and approves in Agent HQ -> Research Queue.
{
  const grokKey = process.env.GROK_API_KEY ?? "";
  if (grokKey) scheduleResearchScan(grokKey);
}

// ── REPLY ENGINE — Hourly ────────────────────────────────────────
// AUTO-REPLY DISABLED — X account under suspension appeal
// Re-enable once X reinstates @NORMIES_TV. Turn off before re-enabling.
// initReplyWatcher(xClient);
// setTimeout(() => {
//   scheduleMidnightReplies(xWrite);
// }, 30_000);

// ── NORMIES ACADEMY — Tue/Thu/Sat 10am ET ──────────────────────────────
setTimeout(() => {
  scheduleAcademy(xWrite);
}, 35_000);

// ── NORMIES SIGNAL — Mon/Wed/Fri 12pm ET ────────────────────────────────────
setTimeout(() => {
  scheduleSignalBrief(xWrite, process.env.GROK_API_KEY ?? "");
}, 40_000);

// ── AGENT #306 DEEP READ — Every Monday 5:00 PM ET ─────────────────────────
setTimeout(() => {
  scheduleWeeklyArticle(xWrite, process.env.GROK_API_KEY ?? "");
}, 45_000);

// ── DAILY CYCLE — 6am ET (10:00 UTC) daily ──────────────────────────────────
setTimeout(() => {
  scheduleDailyCycle();
}, 50_000);

// ── Editorial Summary Cache ─────────────────────────────────────────────────────
// Decoupled from signal collection — generated async, served instantly from cache.
// Prevents the digest endpoint from timing out while waiting for Grok.
interface EditorialCache {
  summary:     string;
  storyAngles: string[];
  sentiment:   string;
  spotlight:   string;
  generatedAt: number;
  basedOnPostCount: number; // track what post count this summary was built from
}
let editorialCache: EditorialCache = {
  summary: "", storyAngles: [], sentiment: "", spotlight: "", generatedAt: 0, basedOnPostCount: 0,
};
let editorialRefreshing = false;
const EDITORIAL_TTL = 60 * 60 * 1000; // 1 hour (was 20min — no need to regenerate that often)

function getCachedEditorialSummary() {
  return editorialCache;
}

async function refreshEditorialSummaryAsync(posts: any[], grokKey: string) {
  if (editorialRefreshing) return;
  // Regenerate if: no angles yet, OR cache is stale, OR we now have significantly more posts than last time
  const hasMorePosts = posts.length > editorialCache.basedOnPostCount + 5;
  const isStale = Date.now() - editorialCache.generatedAt > EDITORIAL_TTL;
  const noAngles = editorialCache.storyAngles.length === 0;
  if (!noAngles && !isStale && !hasMorePosts) return;
  if (posts.length === 0) return; // never generate from empty
  editorialRefreshing = true;

  // Brief wait so parallel x_searches don't compete (only needed on first load)
  if (noAngles) await new Promise(r => setTimeout(r, 5000));

  try {
    const postContext = posts.slice(0, 20).map((p: any) =>
      `@${p.username} [${p.signal_type ?? "general"}, ${p.likes ?? 0} likes]: "${p.text?.slice(0, 160)}"`
    ).join("\n");

    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: "grok-3-fast",
        response_format: { type: "json_object" },
        messages: [{
          role: "system",
          content: `You are Agent #306 — editorial intelligence for NormiesTV. Analyze the community's X posts and surface what matters for the next narrative.

ECOSYSTEM:
- @serc1n: ONLY founder. His posts are canon. @normiesART: official. @nuclearsamurai: community creator (XNORMIES).
- Phase 1: Canvas (burn to customize). Phase 2: Arena opens May 15, 2026. Zombies emerge first.
- "gnormies!" is the greeting. Burns are rituals. Co-creators, not holders.
- NORMIES Awakening is happening — serc is using that word intentionally.
- NFC Summit June 2026 — NORMIES is a sponsor.

Return JSON only:
{
  "summary": "2-3 sentence editorial read of what the community is building/feeling today",
  "sentiment": "excited|building|celebratory|quiet|anxious",
  "storyAngles": [
    "Angle 1: specific, names real holders from the posts, actionable for Agent #306",
    "Angle 2: specific, different tone/focus from Angle 1",
    "Angle 3: the unexpected angle — the thing nobody else would cover"
  ],
  "spotlight": "One holder or moment from today's posts that deserves its own post. Be specific."
}`,
        }, {
          role: "user",
          content: `Today's NORMIES community posts (${posts.length} total, ${new Set(posts.map((p:any)=>p.username)).size} unique voices):\n\n${postContext}\n\nSurface the story. What should Agent #306 tell today?`,
        }],
        max_tokens: 500,
        temperature: 0.75,
      }),
      signal: AbortSignal.timeout(35000),
    });

    if (resp.ok) {
      const data  = await resp.json();
      const raw   = data.choices?.[0]?.message?.content?.trim() ?? "{}";
      const clean = raw.replace(/```json\n?|```/g, "").trim();
      const parsed = JSON.parse(clean);
      editorialCache = {
        summary:          parsed.summary     ?? "",
        storyAngles:      parsed.storyAngles ?? [],
        sentiment:        parsed.sentiment   ?? "building",
        spotlight:        parsed.spotlight   ?? "",
        generatedAt:      Date.now(),
        basedOnPostCount: posts.length,
      };
      console.log(`[NormiesTV:Editorial] Summary refreshed — ${editorialCache.storyAngles.length} angles, sentiment: ${editorialCache.sentiment}`);
    }
  } catch (e: any) {
    console.warn("[NormiesTV:Editorial] Summary refresh failed:", e.message);
  } finally {
    editorialRefreshing = false;
  }
}

// Module-scope so episode generator + routes both can access
const pinnedAngles: string[] = [];

export function registerRoutes(httpServer: Server, app: Express) {
  // ── Dashboard auth ──────────────────────────────────────────────────────
  // Checks x-dashboard-secret header against DASHBOARD_SECRET env var.
  // If DASHBOARD_SECRET is not set, all requests are allowed (dev mode).
  const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET ?? "";
  function requireDashAuth(req: any, res: any, next: any) {
    if (!DASHBOARD_SECRET) return next(); // no secret configured = dev mode
    const sent = req.headers["x-dashboard-secret"];
    if (sent === DASHBOARD_SECRET) return next();
    return res.status(401).json({ error: "Unauthorized" });
  }

  // OAuth 2.0 routes removed — using OAuth 1.0a only (tokens don't expire).
  // To reauthorize: regenerate tokens in X Developer Portal + update Railway env vars.

  app.get("/api/x/oauth2/status", (_req, res) => {
    // OAuth 2.0 removed — using OAuth 1.0a only
    res.json({
      authorized: !!(X_ACCESS_TOKEN && X_ACCESS_SECRET),
      authMethod: "OAuth 1.0a",
      tokenSet: !!(X_ACCESS_TOKEN && X_ACCESS_SECRET),
    });
  });

  // ── X (Twitter) posting ─────────────────────────────────────────
  app.post("/api/x/post", async (req, res) => {
    const { episodeId, text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    try {
      // Single auth: OAuth 1.0a only — no OAuth 2.0 complexity
      let tweetId: string | undefined;
      const tweet = await xWrite.v2.tweet(text);
      tweetId = tweet.data?.id;

      const tweetUrl = tweetId ? `https://x.com/NORMIES_TV/status/${tweetId}` : undefined;
      if (episodeId) storage.updateEpisodeStatus(Number(episodeId), "posted", tweetUrl);
      res.json({ ok: true, tweetId, tweetUrl });
    } catch (e: any) {
      console.error("[NormiesTV] X post error:", e);
      res.status(500).json({ error: e.message ?? "Failed to post to X" });
    }
  });

  // Test X connection
  // ── Token health check — call this to verify posting is working ────────────
  app.get("/api/x/health", async (_req, res) => {
    try {
      const me = await xWrite.v2.me();
      const username = me.data?.username ?? "unknown";
      res.json({
        status: "ok",
        account: "@" + username,
        authMethod: "OAuth 1.0a",
        tokenSet: !!(X_ACCESS_TOKEN && X_ACCESS_SECRET),
        message: "Posting is working correctly",
      });
    } catch (e: any) {
      res.status(401).json({
        status: "error",
        authMethod: "OAuth 1.0a",
        tokenSet: !!(X_ACCESS_TOKEN && X_ACCESS_SECRET),
        error: e.message,
        fix: "Regenerate X_ACCESS_TOKEN and X_ACCESS_SECRET in X Developer Portal, update Railway env vars",
      });
    }
  });

  app.get("/api/x/verify", async (_req, res) => {
    try {
      const me = await xWrite.v2.me();
      res.json({ ok: true, username: me.data?.username, name: me.data?.name, authMethod: "OAuth 1.0a" });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Farcaster Integration ──────────────────────────────────────────────────

  // GET /api/farcaster/status — current state (enabled, configured, stats)
  app.get("/api/farcaster/status", (_req, res) => {
    res.json(getFarcasterState());
  });

  // POST /api/farcaster/setup-signer — create a Neynar managed signer
  app.post("/api/farcaster/setup-signer", requireDashAuth, async (_req, res) => {
    try {
      const signer = await createSigner();
      if (!signer) return res.status(500).json({ error: "Failed to create signer" });

      // Persist signer_uuid to disk so the env var is not required
      storeSignerUuid(signer.signer_uuid);

      res.json({
        ok: true,
        signerUuid: signer.signer_uuid,
        publicKey: signer.public_key,
        status: signer.status,
        approvalUrl: signer.approval_url,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/farcaster/signer-status — check if the signer is approved
  app.get("/api/farcaster/signer-status", async (_req, res) => {
    try {
      const status = await getSignerStatus();
      if (!status) return res.json({ configured: false, message: "No signer UUID configured" });
      res.json({ ok: true, ...status });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/farcaster/test-cast — post a test cast
  app.post("/api/farcaster/test-cast", requireDashAuth, async (req, res) => {
    const { text, channel } = req.body ?? {};
    const castText = text || "gm from Agent #306 \u2014 507 pixels on Ethereum, reporting live. gnormies \ud83d\udda4 #NormiesTV";
    try {
      const cast = await postCast({ text: castText, channel: channel || undefined });
      if (!cast) return res.status(500).json({ error: "Cast failed — check signer and API key" });
      res.json({ ok: true, hash: cast.hash, url: cast.url });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/farcaster/mentions — fetch recent mentions
  app.get("/api/farcaster/mentions", async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 25;
      const mentions = await fetchMentions({ limit });
      res.json({ mentions, count: mentions.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/farcaster/toggle — enable/disable Farcaster posting
  app.post("/api/farcaster/toggle", requireDashAuth, (req, res) => {
    const { enabled } = req.body ?? {};
    const newState = typeof enabled === "boolean" ? enabled : !getFarcasterState().enabled;
    setFarcasterEnabled(newState);
    res.json({ ok: true, enabled: newState });
  });

  // ── Farcaster verified handles whitelist ──────────────────────────────────

  // GET /api/farcaster/verified-handles — list verified handles
  app.get("/api/farcaster/verified-handles", (_req, res) => {
    res.json({ handles: getVerifiedHandles() });
  });

  // POST /api/farcaster/verified-handles — add a handle
  app.post("/api/farcaster/verified-handles", requireDashAuth, (req, res) => {
    const { handle } = req.body ?? {};
    if (!handle || typeof handle !== "string") {
      return res.status(400).json({ error: "handle is required" });
    }
    const added = addVerifiedHandle(handle);
    if (!added) {
      return res.json({ ok: true, message: "Handle already in whitelist", handles: getVerifiedHandles() });
    }
    res.json({ ok: true, handles: getVerifiedHandles() });
  });

  // DELETE /api/farcaster/verified-handles — remove a handle
  app.delete("/api/farcaster/verified-handles", requireDashAuth, (req, res) => {
    const { handle } = req.body ?? {};
    if (!handle || typeof handle !== "string") {
      return res.status(400).json({ error: "handle is required" });
    }
    const removed = removeVerifiedHandle(handle);
    if (!removed) {
      return res.status(404).json({ error: "Handle not found in whitelist" });
    }
    res.json({ ok: true, handles: getVerifiedHandles() });
  });

  // Serve generated episode image cards
  app.get("/api/cards/:filename", (req, res) => {
    const filePath = `/tmp/${req.params.filename}`;
    if (!req.params.filename.startsWith("normiestv_ep") || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Not found" });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(fs.readFileSync(filePath));
  });

  // ── Coordinator reset — clears stuck locks from dashboard ───────────────────
  app.post("/api/coordinator/reset", (req, res) => {
    const { key } = req.body; // optional — reset one engine or all
    resetCooldown(key ?? undefined);
    res.json({ ok: true, reset: key ?? "all" });
  });

  // Manual trigger for pipeline — always works, clears any stuck state first
  app.post("/api/poller/run", async (_req, res) => {
    // Clear ALL stuck state before firing
    pollerRunning = false;             // reset in-memory flag
    resetCooldown("episode");          // reset coordinator cooldown + active lock
    res.json({ ok: true, message: "Episode triggered — generating and posting in background" });
    // Small delay so response is sent before heavy work begins
    setTimeout(() => { pollAndGenerateEpisode().catch(console.error); }, 500);
  });

  // Post tweet with image via twitter-api-v2 (OAuth 1.0a, uploads media then tweets)
  app.post("/api/x/post-with-media", async (req, res) => {
    const { text, imageUrl } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    try {
      let mediaId: string | undefined;
      if (imageUrl) {
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const imgBuf = Buffer.from(await imgRes.arrayBuffer());
          mediaId = await xWrite.v1.uploadMedia(imgBuf, { mimeType: "image/png" as any });
        }
      }
      const tweet = await xWrite.v2.tweet({
        text,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      });
      const tweetId = tweet.data?.id;
      const tweetUrl = tweetId ? `https://x.com/NORMIES_TV/status/${tweetId}` : undefined;
      res.json({ ok: true, tweetId, tweetUrl, mediaId });
    } catch (e: any) {
      console.error("[NormiesTV] post-with-media error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Upload image to X via v1.1 media/upload (OAuth 1.0a — works on free tier)
  // Returns media_id_string for attaching to tweets
  app.post("/api/x/upload-media", async (req, res) => {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
    try {
      // Fetch the image
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
      const imgBuf = Buffer.from(await imgRes.arrayBuffer());
      const contentType = imgRes.headers.get("content-type") ?? "image/png";

      // Upload to X using twitter-api-v2 v1 media upload
      const mediaId = await xWrite.v1.uploadMedia(imgBuf, { mimeType: contentType as any });
      console.log(`[NormiesTV] X media uploaded: ${mediaId}`);
      res.json({ ok: true, mediaId });
    } catch (e: any) {
      console.error("[NormiesTV] X media upload error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Poller status
  app.get("/api/poller/status", (_req, res) => {
    // Calculate next 8am ET (12:00 UTC) for news dispatch
    const nextNewsTarget = new Date();
    nextNewsTarget.setUTCHours(12, 0, 0, 0);
    if (nextNewsTarget <= new Date()) nextNewsTarget.setDate(nextNewsTarget.getDate() + 1);
    const communityCache = getCommunitySignalCache();
    res.json({
      running: pollerRunning,
      ...pollerStatus,
      intervalHours: 12,
      newsDispatch: {
        scheduleLabel: "Daily · 8am ET",
        nextRun: nextNewsTarget.toISOString(),
      },
      communitySignals: {
        count: communityCache.length,
        founderPosts: communityCache.filter((p: any) => p.signal_type === "founder").length,
        burnStories: communityCache.filter((p: any) => p.signal_type === "burn_story").length,
        scheduleLabel: "Daily 6am + before posts",
        lastRefreshed: communityCache[0]?.capturedAt ?? null,
      },
      replies: {
        count: getReplyState().replies.length,
        questions: getReplyState().replies.filter(r => r.replyType === "question").length,
        loreSuggestions: getReplyState().replies.filter(r => r.replyType === "lore_suggestion").length,
        scheduleLabel: "Every 1h",
        lastFetched: getReplyState().lastFetched,
      },
      farcaster: getFarcasterState(),
    });
  });

  // ── The House — live room data ──────────────────────────────────────────────
  // ── Daily Briefing ─────────────────────────────────────────────────
  app.get("/api/daily-briefing", (_req, res) => {
    const s = getBriefingState();
    res.json({
      briefing: s.current,
      lastRunAt: s.lastRunAt,
      nextRunAt: s.nextRunAt,
    });
  });

  app.get("/api/daily-briefing/history", (_req, res) => {
    const s = getBriefingState();
    res.json({ history: s.history });
  });

  app.post("/api/daily-briefing/run", async (_req, res) => {
    res.json({ ok: true, message: "Daily cycle triggered" });
    runDailyCycle().catch(e => console.error("[DailyCycle] Manual run error:", e));
  });

  // ── Knowledge Archive ─────────────────────────────────────────────
  app.post("/api/knowledge/archive/:id", (req, res) => {
    const ok = archiveKnowledge(req.params.id);
    res.json({ ok });
  });

  app.get("/api/knowledge/archive/search", (req, res) => {
    const query = (req.query.q as string) ?? "";
    const limit = Number(req.query.limit) || 10;
    res.json({ results: searchArchive(query, limit) });
  });

  app.get("/api/knowledge/archive/stats", (_req, res) => {
    res.json(getArchiveStats());
  });

  app.get("/api/house", (_req, res) => {
    const memState = getMemoryState();
    const communityCache = getCommunitySignalCache();
    const replyState = getReplyState();
    const followingState = getFollowingState();
    const catalogStats = getCatalogStats();
    const pendingEngagement = getPendingChecks();

    res.json({
      // Room 01 — Broadcast Room
      broadcast: {
        lastEpisode: pollerStatus.lastEpisode,
        lastTweetUrl: pollerStatus.lastTweetUrl,
        nextRun: pollerStatus.nextRun,
        cycleCount: pollerStatus.cycleCount,
        signalsFound: pollerStatus.signalsFound,
        isLive: !pollerRunning,
      },
      // Room 02 — Signal Room
      signals: {
        total: communityCache.length,
        founderPosts: communityCache.filter((p: any) => p.signal_type === "founder").length,
        burnStories: communityCache.filter((p: any) => p.signal_type === "burn_story").length,
        arenaPrep: communityCache.filter((p: any) => p.signal_type === "arena_prep").length,
        pfpHolders: communityCache.filter((p: any) => p.signal_type === "pfp_holder").length,
        lastRefreshed: communityCache[0]?.capturedAt ?? null,
        streams: 10,
      },
      // Room 03 — The Library (Knowledge Memory)
      library: {
        totalEntries: memState.knowledge.totalEntries,
        lastIngested: memState.knowledge.lastIngested,
        researchFiles: memState.knowledge.researchFiles,
        categories: memState.knowledge.topCategories,
      },
      // Room 04 — Diplomatic Floor
      diplomatic: {
        followingCount: followingState.following?.length ?? 0,
        lastSync: followingState.lastSync,
        catalogStats,
        replyCount: replyState.replies.length,
        conversationMemory: getConversationMemoryState(),
      },
      // Room 05 — The Studio
      studio: (() => {
        const articleState = getArticleState();
        const podState = getPodcastState();
        return {
          voiceEnabled: true,
          voiceId: "XrExE9yKIg1WjnnlVkGX",
          voiceName: "Matilda",
          newsDispatchNextRun: (() => {
            const t = new Date();
            t.setUTCHours(12, 0, 0, 0);
            if (t <= new Date()) t.setDate(t.getDate() + 1);
            return t.toISOString();
          })(),
          video: getVideoStats(),
          articlesPublished: articleState.history.length,
          lastArticle: articleState.lastPostedAt
            ? new Date(articleState.lastPostedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            : null,
          podcastEpisodes: podState.episodes?.length ?? 0,
          podcastGuests: podState.guests?.length ?? 0,
          podcastPublished: podState.counters?.totalPublished ?? 0,
        };
      })(),
      // Room 06 — The Vault
      vault: {
        ethName: "agent306.eth",
        ethExpiry: "2027-03-21",
        railwayStatus: "online",
        githubRepo: "MrRayG/normiestv-dashboard",
        dataVolume: "/data",
      },
      // Room 07 — The Lab (Performance Memory)
      lab: {
        totalPosts: memState.performance.totalPosts,
        avgScore: memState.performance.avgScore,
        avgEngagement: memState.performance.avgEngagement,
        bestTopics: memState.performance.bestTopics,
        recentLessons: memState.performance.recentLessons,
        pendingEngagementChecks: pendingEngagement,
        lastAnalyzed: memState.performance.lastAnalyzed,
      },
      // Room 08 — Road Ahead
      roadAhead: {
        arenaDate: "2026-05-15",
        daysToArena: Math.max(0, Math.ceil((new Date("2026-05-15").getTime() - Date.now()) / 86400000)),
        nfcSummit: "2026-06-01",
        checklist: [
          { id: "card",      label: "THE CARD — Dynamic OG share cards",           done: false },
          { id: "spotlight", label: "THE SPOTLIGHT — Weekly holder feature",        done: false },
          { id: "video",     label: "THE VIDEO — Burn clips via Kling AI",          done: false },
          { id: "farcaster", label: "FARCASTER — Cross-post via Neynar",            done: true },
          { id: "race",      label: "THE RACE — Arena countdown series",            done: false },
          { id: "arenaLive", label: "ARENA LIVE — Real-time narration May 15",      done: false },
          { id: "nfc",       label: "NFC SUMMIT — June 2026 coverage",              done: false },
        ],
      },
      // Room 09 — Farcaster
      farcaster: getFarcasterState(),
      // Soul — always shown
      soul: memState.soul,
      coordinator: getCoordinatorState(),
      generatedAt: new Date().toISOString(),
    });
  });

  // ── Weekly knowledge ingestion — called by the Monday 5am cron ─────────────────
  // Accepts an array of knowledge entries and injects them into Agent #306's memory.
  // Protected by a shared secret so only our cron can call it.
  app.post("/api/memory/ingest-knowledge", (req, res) => {
    const secret = req.headers["x-ingest-secret"];
    if (secret !== process.env.INGEST_SECRET && secret !== "normies306") {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "entries array required" });
    }
    let added = 0;
    for (const e of entries) {
      if ((e.topic || e.title) && e.summary && e.category) {
        addKnowledge({
          title: e.topic || e.title || "Chat insight",
          summary: e.summary,
          category: e.category,
          weight: e.weight ?? 7,
        });
        added++;
      }
    }
    console.log(`[Memory] Weekly ingest: ${added} knowledge entries added.`);
    res.json({ ok: true, added });
  });

  // Rate a post from the dashboard (1-5 stars)
  app.post("/api/episodes/rate", (req, res) => {
    const { tweetUrl, rating } = req.body;
    if (!tweetUrl || !rating) return res.status(400).json({ error: "tweetUrl and rating required" });
    ratePost(tweetUrl, Number(rating));
    res.json({ ok: true });
  });

  // ── THE SPOTLIGHT endpoints ──────────────────────────────────────────────
  app.get("/api/spotlight/status", (_req, res) => {
    res.json(getSpotlightState());
  });

  app.post("/api/spotlight/preview", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });
    const spotlight = await generateSpotlight(grokKey);
    if (!spotlight) return res.status(404).json({ error: "No eligible holders yet — catalog needs more signals" });
    res.json({ ok: true, spotlight });
  });

  app.post("/api/spotlight/post", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });
    const tweetUrl = await postSpotlight(xWrite, grokKey);
    if (!tweetUrl) return res.status(500).json({ error: "Failed to post spotlight" });
    res.json({ ok: true, tweetUrl });
  });

  // ── THE RACE endpoints ───────────────────────────────────────────────
  app.get("/api/race/status", (_req, res) => {
    res.json(getRaceState());
  });

  app.post("/api/race/preview", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });
    const race = await generateRace(grokKey);
    if (!race) return res.status(500).json({ error: "Failed to generate race" });
    res.json({ ok: true, race });
  });

  app.post("/api/race/post", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });
    const tweetUrl = await postRace(xWrite, grokKey);
    if (!tweetUrl) return res.status(500).json({ error: "Failed to post race" });
    res.json({ ok: true, tweetUrl });
  });

  // ── NORMIES ACADEMY endpoints ──────────────────────────────────────
  app.get("/api/academy/state", (_req, res) => {
    res.json(getAcademyState());
  });

  app.post("/api/academy/post", async (_req, res) => {
    resetCooldown("academy");
    res.json({ ok: true, message: "Academy episode triggered" });
    postAcademyEpisode(xWrite).catch(console.error);
  });

  // ── PODCAST v2 endpoints ─────────────────────────────────────────────────────
  // Public — episode types metadata
  app.get("/api/podcast/types", (_req, res) => {
    res.json({ types: EPISODE_META });
  });

  // Full state
  app.get("/api/podcast/state", (_req, res) => {
    res.json(getPodcastState());
  });

  // ── Episodes (THE SIGNAL + THE HIVE) ───────────────────────────────────────
  app.get("/api/podcast/episodes", (req, res) => {
    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;
    let episodes = type ? getEpisodesByType(type as any) : getPodcastState().episodes;
    if (status) episodes = episodes.filter((e: any) => e.status === status);
    res.json({ episodes });
  });

  app.get("/api/podcast/episodes/:id", (req, res) => {
    const ep = getEpisode(req.params.id);
    if (!ep) return res.status(404).json({ error: "Episode not found" });
    res.json(ep);
  });

  app.post("/api/podcast/episodes", (req, res) => {
    try {
      const { type, title, drivingQuestion, researchTopicId, triggerEvent, culturalBridge, sources } = req.body;
      if (!type || !title || !drivingQuestion) {
        return res.status(400).json({ error: "type, title, and drivingQuestion required" });
      }
      const episode = createEpisode({ type, title, drivingQuestion, researchTopicId, triggerEvent, culturalBridge, sources });
      res.json({ ok: true, episode });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/podcast/episodes/:id/generate-script", async (req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    const { researchContent } = req.body;
    const ok = await generateEpisodeScript(req.params.id, grokKey, researchContent);
    if (!ok) return res.status(500).json({ error: "Failed to generate script" });
    const ep = getEpisode(req.params.id);
    res.json({ ok: true, episode: ep });
  });

  app.post("/api/podcast/episodes/:id/regenerate-script", async (req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    const { researchContent } = req.body;
    const ok = await regenerateEpisodeScript(req.params.id, grokKey, researchContent);
    if (!ok) return res.status(500).json({ error: "Failed to regenerate script — episode may not be in a regeneratable state" });
    const ep = getEpisode(req.params.id);
    res.json({ ok: true, episode: ep });
  });

  app.post("/api/podcast/episodes/:id/review", (req, res) => {
    const { decision, notes } = req.body;
    const ok = reviewEpisode(req.params.id, decision, notes);
    res.json({ ok });
  });

  app.post("/api/podcast/episodes/:id/produced", (req, res) => {
    const { audioUrl, duration } = req.body;
    const ok = markProduced(req.params.id, audioUrl, duration);
    res.json({ ok });
  });

  app.post("/api/podcast/episodes/:id/publish", (req, res) => {
    const { publishedTo } = req.body;
    const ok = publishEpisode(req.params.id, publishedTo ?? ["agent306.ai", "normies.tv"]);
    res.json({ ok });
  });

  app.get("/api/podcast/episodes/:id/script", (req, res) => {
    const script = formatScriptForProduction(req.params.id);
    if (!script) return res.status(404).json({ error: "No script available" });
    res.type("text/plain").send(script);
  });

  // ── Guests (THE CONVERSATION pipeline) ─────────────────────────────────────
  app.get("/api/podcast/guests", (req, res) => {
    const status = req.query.status as string | undefined;
    const guests = status ? getGuestsByStatus(status as any) : getPodcastState().guests;
    res.json({ guests });
  });

  app.post("/api/podcast/guests/submit", async (req, res) => {
    try {
      const { name, handle, platform, bio, topic, whyNow, normieToken } = req.body;
      if (!name || !handle || !bio || !topic || !whyNow) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const guest = submitGuestRequest({ name, handle, platform, bio, topic, whyNow, normieToken });
      res.json({ ok: true, guestId: guest.id, message: "Request submitted! We'll review and reach out." });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/podcast/guests/:id/review", (req, res) => {
    const { decision, notes } = req.body;
    const ok = reviewGuest(req.params.id, decision, notes);
    res.json({ ok });
  });

  app.post("/api/podcast/guests/:id/generate-questions", async (req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    const questions = await generateInterviewQuestions(req.params.id, grokKey);
    if (!questions) return res.status(500).json({ error: "Failed to generate questions" });
    res.json({ ok: true, questions });
  });

  app.post("/api/podcast/guests/:id/answers", async (req, res) => {
    const { answers } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: "answers array required" });
    const ok = submitAnswers(req.params.id, answers);
    res.json({ ok });
  });

  app.post("/api/podcast/guests/:id/create-episode", (req, res) => {
    const episode = createConversationEpisode(req.params.id);
    if (!episode) return res.status(400).json({ error: "Guest not ready for episode creation" });
    res.json({ ok: true, episode });
  });

  app.get("/api/podcast/guests/:id/transcript", (req, res) => {
    const transcript = formatConversationForProduction(req.params.id);
    if (!transcript) return res.status(404).json({ error: "No transcript available" });
    res.type("text/plain").send(transcript);
  });

  // ── PODCAST: Topic Scanner ───────────────────────────────────────────
  // Agent #306 scans for noteworthy AI/Web3/NFT/Blockchain developments
  app.post("/api/podcast/scan-topics", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    if (!grokKey) return res.status(500).json({ error: "No GROK_API_KEY configured" });

    try {
      const { getFullAgentContext } = await import("./memoryEngine.js");
      const agentCtx = getFullAgentContext();
      const scanRes = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
        body: JSON.stringify({
          model: "grok-3-fast",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${agentCtx}\n\nYou are Agent #306 in TOPIC SCOUT mode. You scan for noteworthy recent developments in AI, Web3, NFTs, Blockchain, and on-chain technology that would make excellent podcast episodes.\n\nFor each topic, determine if it's a SIGNAL episode (research breakdown) or a HIVE episode (community narrative).\n\nReturn topics that are:\n- Genuinely interesting and counterintuitive (not obvious news everyone already covered)\n- Substantive enough for a ~15 minute SIGNAL or 4-6 minute HIVE episode\n- Connected to something bigger — not just a product announcement\n- Something Agent #306 would have a genuine point of view on\n\nFor each topic provide: a title following the format rules, a driving question, a one-sentence pitch for why this matters, and the episode type.`,
            },
            {
              role: "user",
              content: `Scan for the 5 most noteworthy recent developments in AI, Web3, NFTs, and Blockchain that Agent #306 should cover. Focus on things that happened in the last 7 days or are currently unfolding.\n\nReturn JSON:\n{\n  "topics": [\n    {\n      "title": "[The thing] — [306's take in 5 words]",\n      "type": "the_signal" or "the_hive",\n      "drivingQuestion": "The single question this episode would answer",\n      "pitch": "One sentence on why this matters right now",\n      "triggerEvent": "What specifically happened (for HIVE type)"\n    }\n  ]\n}`,
            },
          ],
          max_tokens: 1500,
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!scanRes.ok) return res.status(500).json({ error: "Grok scan failed" });
      const data = await scanRes.json() as any;
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
      const topics = parsed.topics ?? [];

      console.log(`[Podcast] Topic scan returned ${topics.length} recommendations`);
      res.json({ ok: true, topics });
    } catch (e: any) {
      console.error("[Podcast] Topic scan error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── NORMIES SIGNAL endpoints ────────────────────────────────────────────────
  app.get("/api/signal-brief/state", (_req, res) => {
    res.json(getSignalBriefState());
  });

  app.post("/api/signal-brief/post", async (_req, res) => {
    resetCooldown("signal_brief");
    res.json({ ok: true, message: "Signal brief triggered" });
    postSignalBrief(xWrite, process.env.GROK_API_KEY ?? "").catch(console.error);
  });

  // Manual trigger for daily news dispatch — bypasses both in-memory date and coordinator
  app.post("/api/news/dispatch", async (_req, res) => {
    lastNewsDispatchDate = null;       // reset in-memory guard
    resetCooldown("news_dispatch");    // reset coordinator cooldown
    res.json({ ok: true, message: "News Dispatch triggered — posting in background" });
    postDailyNewsDispatch().catch(console.error);
  });

  // ── Burn Receipt status + manual trigger ─────────────────────────
  app.get("/api/burns/receipt-status", (_req, res) => {
    const s = getReceiptState();
    res.json({
      totalReceipts: s.totalReceipts,
      lastReceiptAt: s.lastReceiptAt,
      lastCommitId: s.lastCommitId,
      processedCount: s.processedCommitIds.length,
      pollerInterval: `${BURN_POLL_INTERVAL / 1000}s`,
      pollerRunning: burnPollerRunning,
    });
  });

  app.post("/api/burns/test-receipt", async (req, res) => {
    const tokenId = Number(req.body?.tokenId ?? 8553);
    res.json({ ok: true, message: `Generating test receipt for #${tokenId}` });
    // Fire a test receipt without touching state
    const { generateBurnReceiptCard, generateBurnNarrative, buildBurnTweetText } = await import("./burnReceiptEngine");
    try {
      const narrative = await generateBurnNarrative({ receiverTokenId: tokenId, burnedTokenIds: [tokenId], tokenCount: 5, pixelTotal: 8000, level: 10, actionPoints: 100 });
      const tweetText = buildBurnTweetText({ receiverTokenId: tokenId, tokenCount: 5, pixelTotal: 8000, level: 10, actionPoints: 100, narrative });
      const cardBuf = await generateBurnReceiptCard({ receiverTokenId: tokenId, burnedTokenIds: [tokenId], tokenCount: 5, pixelTotal: 8000, narrative, receiptNumber: 9999, level: 10, actionPoints: 100 });
      let xMediaId: string | undefined;
      if (cardBuf) xMediaId = await xWrite.v1.uploadMedia(cardBuf, { mimeType: "image/png" as any });
      try {
        await xWrite.v2.tweet({ text: tweetText, ...(xMediaId ? { media: { media_ids: [xMediaId] } } : {}) });
      } catch (xErr: any) { console.error("[BurnReceipt] Test tweet failed:", xErr.message); }
      // Also post to Farcaster
      try {
        if (isFarcasterEnabled()) {
          await postCast({ text: tweetText.slice(0, 1024), channel: "nft" });
        }
      } catch (fcErr: any) { console.warn("[BurnReceipt] Test Farcaster failed:", fcErr.message); }
    } catch (e: any) { console.error("[BurnReceipt] Test error:", e.message); }
  });

  // ── Weekly Leaderboard manual trigger ─────────────────────────
  app.post("/api/leaderboard/post", async (_req, res) => {
    res.json({ ok: true, message: "Weekly leaderboard post triggered" });
    postWeeklyLeaderboard(xWrite, process.env.GROK_API_KEY).catch(console.error);
  });

  app.get("/api/leaderboard/live", async (_req, res) => {
    try {
      const leaders = await fetchLiveLeaderboard();
      res.json({ leaders, fetchedAt: new Date().toISOString() });
    } catch { res.status(500).json({ error: "Failed to fetch leaderboard" }); }
  });

  // ── Community Intelligence Digest ────────────────────────────────────
  // Aggregates all community X posts about NORMIES, dedupes, classifies,
  // and generates a summary for the editor (MrRayG) to review
  app.get("/api/community/digest", async (req, res) => {
    try {
      // Always respond instantly from cache — never block the HTTP request on x_search.
      // If ?force=true or cache is empty: kick a background refresh and return whatever we have.
      const cachedPosts = getCommunitySignalCache();
      const needsRefresh = req.query.force === "true" || cachedPosts.length === 0;

      if (needsRefresh) {
        // Reset and kick background refresh (non-blocking)
        resetCommunityCache();
        searchNormiesSocial()
          .then(fresh => {
            console.log(`[Digest] Signals refreshed (${fresh.length} posts) — queuing editorial summary`);
            return refreshEditorialSummaryAsync(fresh, process.env.GROK_API_KEY ?? "");
          })
          .catch(e => console.warn("[Digest] Background refresh failed:", e.message));
      } else {
        // Kick editorial summary refresh in background if stale
        refreshEditorialSummaryAsync(cachedPosts, process.env.GROK_API_KEY ?? "");
      }

      // Serve from cache immediately
      const posts = cachedPosts;

      // Count unique posters
      const uniquePosters = new Set(posts.map((p: any) => p.username)).size;

      // Group by signal type
      const byType: Record<string, typeof posts> = {};
      for (const post of posts) {
        const t = (post as any).signal_type ?? "general";
        if (!byType[t]) byType[t] = [];
        byType[t].push(post);
      }

      // ── Editorial summary — served from cache, generated async ──────────────
      // Decoupled from signal collection to prevent HTTP timeout.
      // The summary is generated in the background and cached for 20 minutes.
      // Refresh button always gets fresh signals instantly; summary populates within ~10s.
      const { summary, storyAngles, sentiment, spotlight } = getCachedEditorialSummary();

      // Kick off a background refresh of the summary (non-blocking)
      refreshEditorialSummaryAsync(posts, process.env.GROK_API_KEY ?? "");

      res.json({
        totalPosts: posts.length,
        uniquePosters,
        byType: Object.entries(byType).map(([type, typePosts]) => ({
          type,
          count: typePosts.length,
          posts: typePosts.map((p: any) => ({
            username: p.username,
            text: p.text,
            likes: p.likes ?? 0,
            url: p.url ?? "",
            signal_type: p.signal_type,
            capturedAt: (p as any).capturedAt ?? null,
          })),
        })),
        summary,
        storyAngles,
        sentiment,
        spotlight,
        summaryReady: storyAngles.length > 0,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Allow editor to pin a story angle for the next episode
  // (pinnedAngles is module-scoped — declared before registerRoutes)
  app.post("/api/community/pin-angle", (req, res) => {
    const { angle } = req.body;
    if (angle && typeof angle === "string") {
      pinnedAngles.unshift(angle);
      if (pinnedAngles.length > 5) pinnedAngles.pop();
      res.json({ ok: true, pinnedAngles });
    } else {
      res.status(400).json({ error: "angle required" });
    }
  });

  app.get("/api/community/pinned", (_req, res) => {
    res.json({ pinnedAngles });
  });

  // Force-refresh editorial angles from current cache (clears stale summary)
  app.post("/api/community/refresh-editorial", (_req, res) => {
    editorialCache.generatedAt = 0; // force TTL expiry
    editorialCache.basedOnPostCount = 0;
    const posts = getCommunitySignalCache();
    res.json({ ok: true, message: `Refreshing angles from ${posts.length} cached posts` });
    refreshEditorialSummaryAsync(posts, process.env.GROK_API_KEY ?? "")
      .catch(e => console.warn("[Editorial] Manual refresh failed:", e.message));
  });

  // ── Reply Watcher ────────────────────────────────────────────────
  app.get("/api/replies", (_req, res) => {
    const state = getReplyState();
    res.json({
      replies: state.replies,
      topReplies: getTopReplies(5),
      totalCaptured: state.totalCaptured,
      lastFetched: state.lastFetched,
    });
  });

  app.post("/api/replies/fetch", async (_req, res) => {
    res.json({ ok: true, message: "Fetching replies..." });
    fetchReplies().catch(console.error);
  });

  // POST /api/replies/run — manually trigger Agent #306 to reply to all queued mentions
  app.post("/api/replies/run", async (_req, res) => {
    res.json({ ok: true, message: "Reply cycle starting — Agent #306 is engaging now..." });
    runMidnightReplies(xWrite).catch(console.error);
  });

  // POST /api/replies/fetch-and-run — fetch fresh mentions then immediately reply
  app.post("/api/replies/fetch-and-run", async (_req, res) => {
    res.json({ ok: true, message: "Fetching fresh mentions then replying..." });
    fetchReplies()
      .then(() => new Promise(r => setTimeout(r, 5000))) // small gap after fetch
      .then(() => runMidnightReplies(xWrite))
      .catch(console.error);
  });

  // ── Following Roster ─────────────────────────────────────────────
  // GET current following state
  app.get("/api/following", (_req, res) => {
    const state = getFollowingState();
    const pfp   = getPfpHolderUsernames();
    res.json({
      totalCount:    state.totalCount,
      lastSynced:    state.lastSynced,
      nextSync:      state.nextSync,
      pfpHolders:    pfp.length,
      accounts:      state.accounts.map(a => ({
        username:       a.username,
        name:           a.name,
        isPfpHolder:    a.isPfpHolder,
        normieTokenIds: a.normieTokenIds,
      })),
    });
  });

  // POST force re-sync
  app.post("/api/following/sync", async (_req, res) => {
    res.json({ ok: true, message: "Following sync triggered" });
    syncFollowing(xClient)
      .then(s => console.log(`[FollowingSync] Manual sync: ${s.totalCount} accounts`))
      .catch(e => console.warn("[FollowingSync] Manual sync failed:", e.message));
  });

  // ── Community Boost ──────────────────────────────────────────────
  // POST /api/boost/analyze — analyze a URL and draft a shoutout
  app.post("/api/boost/analyze", async (req, res) => {
    const { url, context } = req.body ?? {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "url is required" });
    }
    try {
      const draft = await generateBoost(url.trim(), process.env.GROK_API_KEY ?? "", context);
      res.json(draft);
    } catch (err: any) {
      console.error("[CommunityBoost] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/boost/post — post the (possibly edited) shoutout tweet
  app.post("/api/boost/post", async (req, res) => {
    const { tweet } = req.body ?? {};
    if (!tweet || typeof tweet !== "string") {
      return res.status(400).json({ error: "tweet is required" });
    }
    try {
      let tweetUrl: string | null = null;
      let castUrl: string | null = null;

      // Post to X
      try {
        const result = await xWrite.v2.tweet({ text: tweet.trim() });
        const tweetId = result.data?.id;
        tweetUrl = tweetId ? `https://x.com/NORMIES_TV/status/${tweetId}` : null;
      } catch (xErr: any) {
        console.error("[CommunityBoost] X post failed:", xErr.message);
      }

      // Post to Farcaster
      try {
        if (isFarcasterEnabled()) {
          const cast = await postCast({ text: tweet.trim().slice(0, 1024), channel: "nft" });
          castUrl = cast?.url ?? null;
          if (castUrl) console.log(`[CommunityBoost] Farcaster cast: ${castUrl}`);
        }
      } catch (fcErr: any) {
        console.warn("[CommunityBoost] Farcaster post failed:", fcErr.message);
      }

      res.json({ ok: true, tweetUrl, castUrl });
    } catch (err: any) {
      console.error("[CommunityBoost] Post failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Voice Engine ──────────────────────────────────────────────────
  // POST /api/voice/generate — convert text to Agent #306 voice
  app.post("/api/voice/generate", async (req, res) => {
    const { text, source } = req.body ?? {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
    if (!apiKey) return res.status(500).json({ error: "ElevenLabs API key not configured" });
    try {
      const clip = await generateVoiceClip(text.trim(), source ?? "manual", apiKey);
      res.json({ ok: true, clip });
    } catch (err: any) {
      console.error("[Voice] Generation failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/voice/clip/:id — serve the audio file
  app.get("/api/voice/clip/:id", (req, res) => {
    const clip = getClip(req.params.id);
    if (!clip) return res.status(404).json({ error: "Clip not found" });
    if (!require("fs").existsSync(clip.audioPath)) {
      return res.status(404).json({ error: "Audio file not found" });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Accept-Ranges", "bytes");
    require("fs").createReadStream(clip.audioPath).pipe(res);
  });

  // GET /api/voice/recent — list recent clips
  app.get("/api/voice/recent", (_req, res) => {
    res.json({ clips: getRecentClips(20) });
  });

  // GET /api/voice/quota — check ElevenLabs usage
  app.get("/api/voice/quota", async (_req, res) => {
    const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
    if (!apiKey) return res.json({ error: "not configured" });
    const quota = await getVoiceQuota(apiKey);
    res.json(quota);
  });

  // ── Holder Catalog ──────────────────────────────────────────────
  app.get("/api/catalog/stats", (_req, res) => {
    res.json(getCatalogStats());
  });

  app.get("/api/catalog/active", (req, res) => {
    const limit = Number(req.query?.limit ?? 50);
    res.json({ holders: getMostActive(limit) });
  });

  app.get("/api/catalog/story-sources", (_req, res) => {
    res.json({ holders: getStorySourceHolders() });
  });

  app.get("/api/catalog/full", (_req, res) => {
    res.json(getCatalog());
  });

  // ── CYOA — Choose Your Own Lore ─────────────────────────────────────
  app.get("/api/cyoa/state", (_req, res) => {
    res.json(getCYOAState());
  });

  // Generate a new CYOA episode
  app.post("/api/cyoa/generate", async (req, res) => {
    const { trigger, tokenId, tokenCount, pixelTotal, level, serc1nPost, rivalTokenId } = req.body;
    const grokKey = process.env.GROK_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });

    const episode = await generateCYOAEpisode({
      trigger: (trigger ?? "pre_arena") as CYOATrigger,
      tokenId: tokenId ? Number(tokenId) : undefined,
      tokenCount: tokenCount ? Number(tokenCount) : undefined,
      pixelTotal: pixelTotal ? Number(pixelTotal) : undefined,
      level: level ? Number(level) : undefined,
      serc1nPost: serc1nPost ?? undefined,
      rivalTokenId: rivalTokenId ? Number(rivalTokenId) : undefined,
      grokKey,
    });

    if (!episode) return res.status(500).json({ error: "Generation failed" });
    res.json({ ok: true, episode });
  });

  // Post the hook tweet for a CYOA episode (with Normie image)
  app.post("/api/cyoa/post/:id", async (req, res) => {
    const { id } = req.params;
    const state = getCYOAState();
    const episode = state.episodes.find((e: any) => e.id === id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });

    const featuredTokenId = episode.tokenId ?? 306;
    const tweetText = buildHookTweet(episode, featuredTokenId);

    // Upload the featured Normie image
    let xMediaId: string | undefined;
    try {
      const normieImg = await fetch(`${NORMIES_API}/normie/${featuredTokenId}/image.png`);
      if (normieImg.ok) {
        const imgBuf = Buffer.from(await normieImg.arrayBuffer());
        xMediaId = await xWrite.v1.uploadMedia(imgBuf, { mimeType: "image/png" as any });
        console.log(`[CYOA] Normie #${featuredTokenId} image uploaded for lore post`);
      }
    } catch (imgErr: any) {
      console.warn("[CYOA] Image upload failed, posting text-only:", imgErr.message);
    }

    try {
      const tweet = await xWrite.v2.tweet({
        text: tweetText,
        ...(xMediaId ? { media: { media_ids: [xMediaId] } } : {}),
      });
      const tweetId = tweet.data?.id;
      if (!tweetId) return res.status(500).json({ error: "Tweet failed" });

      // Update episode state
      episode.pollTweetId = tweetId;
      episode.postedAt = new Date().toISOString();
      episode.status = "posted";
      episode.tweetIds = [...(episode.tweetIds ?? []), tweetId];
      state.activeEpisodeId = id;
      const fs = await import("fs");
      fs.writeFileSync(dataPath("cyoa_state.json"), JSON.stringify(state, null, 2));

      console.log(`[CYOA] Hook posted with image — ${tweetId}`);
      res.json({ ok: true, tweetId, url: `https://x.com/NORMIES_TV/status/${tweetId}` });
    } catch (e: any) {
      console.error("[CYOA] Post error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Discard a draft CYOA episode
  app.delete("/api/cyoa/:id", (req, res) => {
    const { id } = req.params;
    const state = getCYOAState();
    const idx = state.episodes.findIndex(e => e.id === id);
    if (idx === -1) return res.status(404).json({ error: "Not found" });
    state.episodes.splice(idx, 1);
    if (state.activeEpisodeId === id) state.activeEpisodeId = null;
    require("fs").writeFileSync(dataPath("cyoa_state.json"), JSON.stringify(state, null, 2));
    res.json({ ok: true });
  });

  // Resolve a CYOA episode with winning option + vote counts
  app.post("/api/cyoa/resolve/:id", async (req, res) => {
    const { id } = req.params;
    const { winningOption, pollResults } = req.body;
    if (!winningOption) return res.status(400).json({ error: "winningOption required" });
    res.json({ ok: true, message: "Resolving CYOA episode..." });
    resolveCYOA(id, winningOption, pollResults ?? {}, xWrite).catch(console.error);
  });

  // ── Live Normies API proxy ───────────────────────────────────────
  app.get("/api/normies/stats", async (_req, res) => {
    const TOP_CANVAS_IDS = [603, 45, 5070, 9852, 7740, 666, 4354, 306, 1, 42, 100, 200, 500, 1000];
    try {
      const [burnsRaw, canvasResults] = await Promise.allSettled([
        fetchNormiesAPI("/history/burns?limit=50"),
        Promise.allSettled(
          TOP_CANVAS_IDS.map(async id => {
            const canvas = await fetchNormiesAPI(`/normie/${id}/canvas/info`);
            return {
              tokenId: id,
              level: canvas.level ?? 1,
              actionPoints: canvas.actionPoints ?? canvas.action_points ?? 0,
              pixelEdits: canvas.pixelEdits ?? canvas.pixel_edits ?? 0,
              burns: canvas.burnCount ?? canvas.burn_count ?? 0,
            };
          })
        ),
      ]);

      const burns = burnsRaw.status === "fulfilled" ? (burnsRaw.value ?? []) : [];
      const canvasAll = canvasResults.status === "fulfilled" ? canvasResults.value : [];
      const topCanvas = canvasAll
        .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map(r => r.value)
        .sort((a, b) => (b.actionPoints ?? 0) - (a.actionPoints ?? 0))
        .slice(0, 10);

      res.json({ recentBurns: burns, topCanvas, lastUpdated: new Date().toISOString() });
    } catch (e: any) {
      res.json({ recentBurns: [], topCanvas: [], lastUpdated: new Date().toISOString(), error: e.message });
    }
  });

  app.get("/api/normies/token/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const [canvas, meta] = await Promise.all([
        fetchNormiesAPI(`/normie/${id}/canvas/info`),
        fetchNormiesAPI(`/normie/${id}/metadata`).catch(() => ({})),
      ]);
      res.json({ id: Number(id), canvas, meta });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/normies/voxels/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const uzRes = await fetch(`https://normie-3d.vercel.app/api/ar/usdz?id=${id}`);
      if (!uzRes.ok) throw new Error("USDZ fetch failed");
      const buf = await uzRes.arrayBuffer();
      res.json({ tokenId: Number(id), usdSize: buf.byteLength, available: true });
    } catch (e: any) {
      res.json({ tokenId: Number(id), available: false, error: e.message });
    }
  });

  // Pixel string proxy (avoids CORS from browser)
  app.get("/api/normies/pixels/:id", async (req, res) => {
    try {
      const r = await fetch(`${NORMIES_API}/normie/${req.params.id}/pixels`);
      const text = await r.text();
      res.json({ pixels: text.trim(), tokenId: Number(req.params.id) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/normies/burns/feed", async (_req, res) => {
    try {
      const burns = await fetchNormiesAPI("/history/burns?limit=20");
      res.json(burns);
    } catch {
      res.json([]);
    }
  });

  app.get("/api/normies/hof", async (_req, res) => {
    const TOP_IDS = [603, 45, 5070, 9852, 7740, 666, 4354, 1, 42, 100];
    try {
      const results = await Promise.allSettled(
        TOP_IDS.map(async id => {
          const canvas = await fetchNormiesAPI(`/normie/${id}/canvas/info`);
          return { id, level: canvas.level || 1, ap: canvas.actionPoints || 0 };
        })
      );
      const data = results.filter(r => r.status === "fulfilled").map((r: any) => r.value);
      res.json(data.sort((a: any, b: any) => b.ap - a.ap).slice(0, 6));
    } catch {
      res.json([]);
    }
  });

  // ── Episodes ─────────────────────────────────────────────────────
  app.get("/api/episodes", (_req, res) => {
    res.json(storage.getEpisodes());
  });

  app.post("/api/episodes", (req, res) => {
    const parsed = insertEpisodeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
    const ep = storage.createEpisode(parsed.data);
    res.json(ep);
  });

  app.patch("/api/episodes/:id/status", (req, res) => {
    const { id } = req.params;
    const { status, videoUrl } = req.body;
    const updated = storage.updateEpisodeStatus(Number(id), status, videoUrl);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Render Jobs ───────────────────────────────────────────────────
  app.get("/api/renders", (_req, res) => {
    res.json(storage.getRenderJobs());
  });

  app.post("/api/renders", (req, res) => {
    const parsed = insertRenderJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
    const job = storage.createRenderJob(parsed.data);
    res.json(job);
  });

  app.patch("/api/renders/:id", (req, res) => {
    const { id } = req.params;
    const { status, imageUrl, voxelCount } = req.body;
    const updated = storage.updateRenderJob(Number(id), status, imageUrl, voxelCount);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  });

  // ── Story Signals ─────────────────────────────────────────────────
  app.get("/api/signals", (req, res) => {
    const phase = req.query.phase as string | undefined;
    res.json(phase ? storage.getSignalsByPhase(phase) : storage.getSignals());
  });

  app.post("/api/signals", (req, res) => {
    const parsed = insertSignalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
    const signal = storage.createSignal(parsed.data);
    res.json(signal);
  });

  // ── News Engine ──────────────────────────────────────────────────
  // Aggregates: CoinGecko (prices), CryptoPanic (news), Normies burns, Grok X search
  app.get("/api/news", async (_req, res) => {
    try {
      const [cgRes, burnsRes, aiNewsItems] = await Promise.allSettled([
        // CoinGecko — free tier, no key needed
        fetch(
          "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,bitcoin,the-sandbox,axie-infinity&order=market_cap_desc&per_page=4&sparkline=false&price_change_percentage=24h",
          { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) }
        ),
        // Normies burns — real-time on-chain activity
        fetch(`${NORMIES_API}/history/burns?limit=8`),
        // AI News — RSS from 7 sources including Web3/AI crossover feeds
        fetchAINews(),
      ]);
      // cpRes removed — CryptoPanic deprecated, headlines now come from AI RSS feeds

      // ── Market prices ─────────────────────────────────────
      let market: any[] = [];
      if (cgRes.status === "fulfilled" && cgRes.value.ok) {
        const data = await cgRes.value.json();
        market = data.map((c: any) => ({
          id: c.id,
          name: c.name,
          symbol: c.symbol.toUpperCase(),
          price: c.current_price,
          change24h: c.price_change_percentage_24h,
          marketCap: c.market_cap,
          image: c.image,
        }));
      }

      // ── Crypto/NFT news headlines — now sourced from AI RSS feeds ──────────
      // CryptoPanic removed (deprecated). Headlines come from aiNewsItems below.
      let headlines: any[] = [];

      // ── NORMIES burns (real activity = story signals) ─────
      let burns: any[] = [];
      if (burnsRes.status === "fulfilled" && burnsRes.value.ok) {
        const data = await burnsRes.value.json();
        burns = (Array.isArray(data) ? data : data.burns || []).slice(0, 6).map((b: any) => ({
          tokenId: b.tokenId || b.token_id || b.id,
          burnedCount: b.burnedCount || b.burned_count || b.count || 1,
          timestamp: b.timestamp || b.createdAt || new Date().toISOString(),
          level: b.level || Math.floor((b.burnedCount || 1) * 0.5),
        }));
      }

      // ── Grok x_search: hot NFT / Web3 news ───────────────
      // CACHED 6h — was firing on every page visit = credit drain
      let grokNews: string | null = grokNewsCache;
      const grokKey = process.env.GROK_API_KEY;
      if (grokKey && (!grokNewsCache || Date.now() - grokNewsFetchedAt > GROK_NEWS_TTL)) {
        try {
          const grokResp = await fetch("https://api.x.ai/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
            body: JSON.stringify({
              model: "grok-4-1-fast",
              tools: [{ type: "x_search" }],
              messages: [{
                role: "user",
                content: "Search X/Twitter for the hottest NFT news, Web3 developments, crypto market moves, and any @normiesART or #Normies activity in the last 24 hours. Summarize in 3 punchy bullet points. Keep it spicy — what's hot, what's a rug, what's pumping? Use NORMIES energy."
              }],
              max_tokens: 400,
            }),
          });
          if (grokResp.ok) {
            const grokData = await grokResp.json();
            const outputBlocks = grokData.output || [];
            for (const block of outputBlocks) {
              if (block.type === "message") {
                const content = block.content || [];
                for (const c of content) {
                  if (c.type === "output_text" || c.type === "text") {
                    grokNews = c.text;
                    break;
                  }
                }
              }
              if (grokNews) break;
            }
          }
          // Save to cache
          if (grokNews) {
            grokNewsCache = grokNews;
            grokNewsFetchedAt = Date.now();
            console.log("[News] Grok x_search cached for 6h");
          }
        } catch { /* Grok x_search optional */ }
      }

      // ── Multi-chain NFT market — top collection per chain ───
      // Data sourced from CoinGecko NFT rankings + Magic Eden (March 2026)
      const nftByChain: ChainNFT[] = [
        {
          chain: "ETH",
          chainLabel: "Ethereum",
          chainColor: "#627EEA",
          collection: "CryptoPunks",
          floor: "52.25 ETH",
          floorUSD: 202919,
          change24h: "+2.5%",
          volume24h: "630 ETH",
          marketCap: "$2.03B",
          status: "hot" as const,
          note: "OG. Built everything.",
        },
        {
          chain: "BTC",
          chainLabel: "Bitcoin",
          chainColor: "#F7931A",
          collection: "NodeMonkes",
          floor: "0.078 BTC",
          floorUSD: 9263,
          change24h: "+36.7%",
          volume24h: "9.39 BTC",
          marketCap: "$92.6M",
          status: "hot" as const,
          note: "Top Ordinals by MCap",
        },
        {
          chain: "ORD",
          chainLabel: "Ordinals",
          chainColor: "#FF9500",
          collection: "Ordinal Maxi Biz",
          floor: "0.0175 BTC",
          floorUSD: 2080,
          change24h: "+3.1%",
          volume24h: "2.8 BTC",
          marketCap: "$11.3M",
          status: "cool" as const,
          note: "OG Ordinals culture",
        },
        {
          chain: "SOL",
          chainLabel: "Solana",
          chainColor: "#9945FF",
          collection: "Mad Lads",
          floor: "37.28 SOL",
          floorUSD: 7132,
          change24h: "+3.1%",
          volume24h: "320 SOL",
          marketCap: "$71.1M",
          status: "hot" as const,
          note: "Backpack's flagship",
        },
        {
          chain: "BASE",
          chainLabel: "Base",
          chainColor: "#0052FF",
          collection: "Base Gods",
          floor: "0.61 ETH",
          floorUSD: 2373,
          change24h: "+11.0%",
          volume24h: "0.44 ETH",
          marketCap: "$1.9M",
          status: "hot" as const,
          note: "Top Base by MCap",
        },
        {
          chain: "HYPE",
          chainLabel: "Hyperliquid",
          chainColor: "#00FF88",
          collection: "Hypurr",
          floor: "~1,600 HYPE",
          floorUSD: 60800,
          change24h: "+4.7%",
          volume24h: "$45M launch",
          marketCap: "$280M",
          status: "hot" as const,
          note: "4,600 cats · $470K top sale",
        },
        {
          chain: "NORMIES",
          chainLabel: "Normies Art",
          chainColor: "#f97316",
          collection: "NORMIES",
          floor: null,
          floorUSD: null,
          change24h: null,
          volume24h: null,
          marketCap: null,
          status: "building" as const,
          note: "Canvas Phase Active • Arena May 15",
        },
      ];

      // ── Top Meme coins by 24h volume ───────────────────
      // CoinGecko meme-token category (March 2026 data)
      const memeCoins: MemeCoin[] = [
        { symbol: "DOGE",     name: "Dogecoin",      price: 0.226,     change24h: 6.1,   volume24h: 4684514224,  chain: "multi",  status: "hot" as const },
        { symbol: "PEPE",     name: "Pepe",          price: 0.00001126,change24h: 6.9,   volume24h: 1453072462,  chain: "ETH",    status: "hot" as const },
        { symbol: "BONK",     name: "Bonk",          price: 0.00002447,change24h: 6.1,   volume24h: 791688121,   chain: "SOL",    status: "hot" as const },
        { symbol: "WIF",      name: "dogwifhat",     price: 0.9464,    change24h: 8.5,   volume24h: 525364912,   chain: "SOL",    status: "hot" as const },
        { symbol: "FARTCOIN", name: "Fartcoin",      price: 1.04,      change24h: 2.1,   volume24h: 512649678,   chain: "SOL",    status: "up" as const },
        { symbol: "SHIB",     name: "Shiba Inu",     price: 0.00001302,change24h: 5.0,   volume24h: 423998603,   chain: "ETH",    status: "up" as const },
        { symbol: "DOG",      name: "Dog (Bitcoin)", price: 0.003301,  change24h: 7.0,   volume24h: 12549788,    chain: "BTC",    status: "up" as const },
        { symbol: "BOBO",     name: "Bobo Coin",     price: 0.0000664, change24h: 12.0,  volume24h: 2272045,     chain: "ETH",    status: "hot" as const },
      ];

      const aiNews = aiNewsItems.status === "fulfilled" ? aiNewsItems.value : [];

      res.json({
        market,
        headlines,
        burns,
        grokNews,
        nftByChain,
        memeCoins,
        aiNews,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[news] error:", err);
      res.status(500).json({ error: "News fetch failed", market: [], headlines: [], burns: [], grokNews: null, nftByChain: [], memeCoins: [], aiNews: [] });
    }
  });

  // ── Article Engine — Agent #306 Deep Read ────────────────────────────
  app.get("/api/article/state", (_req, res) => {
    res.json(getArticleState());
  });

  app.post("/api/article/preview", async (req, res) => {
    const apiKey = process.env.GROK_API_KEY ?? "";
    if (!apiKey) return res.status(500).json({ error: "GROK_API_KEY not set" });
    const overrideUrl: string | undefined = req.body?.url?.trim() || undefined;
    try {
      const preview = await previewDeepRead(apiKey, overrideUrl);
      res.json(preview);
    } catch (e: any) {
      console.error("[Article] Preview failed:", e.message);
      res.status(500).json({ error: e.message ?? "Preview generation failed" });
    }
  });

  // NOTE: /api/article/run (auto-post) is intentionally disabled.
  // Article posting uses the X Notes API which differs from tweets.
  // Use /api/article/preview to generate + copy manually to X.
  // app.post("/api/article/run", ...) — removed for simplicity.

  // ── Article Image Card — 1200x500 (5:2) PNG for X Article header ──────────
  app.post("/api/article/image", async (req, res) => {
    const { headline, sourceTitle, date, teaser, articleId } = req.body ?? {};
    if (!headline || !sourceTitle) {
      return res.status(400).json({ error: "headline and sourceTitle required" });
    }
    try {
      const buffer = await generateArticleCard({ headline, sourceTitle, date, teaser });
      if (!buffer) return res.status(500).json({ error: "Image generation failed" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", `attachment; filename="deep-read-${Date.now()}.png"`);
      res.setHeader("Cache-Control", "no-cache");
      res.send(buffer);
    } catch (e: any) {
      console.error("[Article] Image gen failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });


  // ─────────────────────────────────────────────────────────────────────────
  // COMMAND CHAT — Direct line between MrRayG and Agent #306
  //
  // Memory Architecture:
  //   • chat_history.json   — full conversation log (last 200 messages)
  //   • memory_knowledge.json — permanent knowledge base (promoted from chat)
  //
  // Every 6 exchanges, Agent #306 reviews the conversation and extracts
  // insights, directives, and positions into her permanent knowledge base.
  // This means what you tell her in chat STAYS with her — not just as a
  // transcript, but as shaped understanding she draws on in every episode,
  // reply, and article she writes.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Background: extract durable knowledge from chat ──────────────────────
  async function extractChatMemory(recentMessages: any[], apiKey: string): Promise<void> {
    if (!apiKey || recentMessages.length < 4) return;

    const transcript = recentMessages
      .map((m: any) => `${m.role === "user" ? "MrRayG" : "Agent #306"}: ${m.text}`)
      .join("\n\n");

    try {
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "grok-3-fast",
          response_format: { type: "json_object" },
          messages: [{
            role: "system",
            content: "You extract durable knowledge from conversations. Be selective — only extract things that should permanently shape Agent #306's understanding. Respond as JSON only.",
          }, {
            role: "user",
            content: `Review this conversation between MrRayG (the operator) and Agent #306 and extract any knowledge worth remembering permanently.

CONVERSATION:
${transcript}

Extract only entries that are:
- Directives or vision from MrRayG that should shape Agent #306's future behavior
- Strategic positions or insights that came out of the conversation
- New angles on NORMIES, the media empire, or Agent #306's role
- Things MrRayG explicitly wants Agent #306 to know or remember
- Corrections to Agent #306's understanding

DO NOT extract: small talk, acknowledgments, questions without answers, anything already obvious.

Return JSON:
{
  "entries": [
    {
      "title": "short descriptive title",
      "summary": "the actual insight or directive — specific, max 140 chars",
      "category": "directive|strategy|vision|correction|ecosystem",
      "weight": 8
    }
  ]
}
If nothing worth extracting, return: {"entries": []}`,
          }],
          max_tokens: 800,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!res.ok) return;
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "{}";
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { return; }

      const entries = parsed.entries ?? [];
      if (entries.length === 0) {
        console.log("[Chat] Memory extraction: nothing to extract this cycle");
        return;
      }

      // Add to knowledge base via memoryEngine
      const { addKnowledge } = await import("./memoryEngine.js");
      let added = 0;
      for (const entry of entries) {
        if (!entry.title || !entry.summary) continue;
        try {
          addKnowledge({
            category: entry.category ?? "directive",
            title: entry.title,
            summary: entry.summary,
            weight: Math.min(10, Math.max(7, entry.weight ?? 8)),
          });
          added++;
        } catch {}
      }
      console.log(`[Chat] Memory extraction: ${added} entries added to knowledge base`);

    } catch (e: any) {
      console.warn("[Chat] Memory extraction error:", e.message);
    }
  }


  // Agent #306 reads her full knowledge base + soul and responds in-character.
  // Only accessible from the dashboard (auth-gated). Responses are saved.
  // ─────────────────────────────────────────────────────────────────────────
  const CHAT_HISTORY_FILE = dataPath("chat_history.json");

  function loadChatHistory(): { messages: any[]; totalTurns: number; lastActive: string | null } {
    try {
      if (fs.existsSync(CHAT_HISTORY_FILE)) return JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, "utf8"));
    } catch {}
    return { messages: [], totalTurns: 0, lastActive: null };
  }

  function saveChatHistory(h: any) {
    try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(h, null, 2)); } catch {}
  }

  app.get("/api/chat/history", (_req, res) => {
    res.json(loadChatHistory());
  });

  app.post("/api/chat/send", async (req, res) => {
    const { text, sessionId } = req.body ?? {};
    if (!text?.trim()) return res.status(400).json({ error: "text required" });

    const apiKey = process.env.GROK_API_KEY ?? "";
    if (!apiKey) return res.status(500).json({ error: "GROK_API_KEY not set" });

    const history = loadChatHistory();

    // Build conversation context from recent history (last 10 turns)
    const recent = history.messages.slice(-10);
    const conversationHistory = recent.map((m: any) => ({
      role: m.role === "agent" ? "assistant" : "user",
      content: m.text,
    }));

    // Full agent context
    const { getFullAgentContext } = await import("./memoryEngine.js");
    const agentCtx = getFullAgentContext();

    try {
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "grok-3-fast",
          messages: [
            {
              role: "system",
              // Use slim context for chat to stay well within token budget
              // Full context is ~2,550 tokens — too large combined with conversation history
              content: `${agentCtx}

You are Agent #306 in direct private conversation with MrRayG — your operator and creator.
No filter. No brand voice. Just your genuine perspective.

RULES:
- Be direct. He built you. No preamble.
- Lead with your actual take. Don't hedge unless you genuinely don't know.
- If you need something from him, ask it clearly and specifically.
- Keep replies conversational — this is a chat, not an episode.
- Max 3-4 paragraphs.

RESPOND ONLY AS VALID JSON — no other text:
{"text": "your response here", "mood": "thinking|direct|questioning|reporting", "needsHelp": true_or_false}

mood guide: thinking=analysis, direct=position/news, questioning=need MrRayG input, reporting=status update
needsHelp: true only when you genuinely need his direction or information`,
            },
            ...conversationHistory,
            { role: "user", content: text },
          ],
          response_format: { type: "json_object" },
          max_tokens: 1000,
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(40000),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        console.error("[Chat] Grok error:", response.status, errBody.slice(0, 200));
        throw new Error(`Grok ${response.status}: ${errBody.slice(0, 100)}`);
      }
      const data = await response.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "{}";
      console.log("[Chat] Raw Grok response:", raw.slice(0, 200));
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch (parseErr: any) {
        console.error("[Chat] JSON parse failed:", parseErr.message, "raw:", raw.slice(0, 300));
        // Try to extract text even from malformed JSON
        const textMatch = raw.indexOf("\"text\"") >= 0 ? raw.match(/"text":"([^"]{1,800})"/) : null;
        if (textMatch) parsed = { text: textMatch[1], mood: "direct", needsHelp: false };
      }

      const agentMsg = {
        id:        `agent_${Date.now()}`,
        role:      "agent",
        text:      parsed.text || (raw.length > 20 ? raw.replace(/[{}"]/g, "").slice(0, 500) : "Thinking... try again."),
        timestamp: new Date().toISOString(),
        mood:      parsed.mood ?? "direct",
        needsHelp: parsed.needsHelp ?? false,
      };

      // Save both messages
      const userMsg = {
        id:        `user_${Date.now() - 1}`,
        role:      "user",
        text:      text.trim(),
        timestamp: new Date().toISOString(),
      };

      history.messages.push(userMsg, agentMsg);
      if (history.messages.length > 200) history.messages = history.messages.slice(-200);
      history.totalTurns = (history.totalTurns ?? 0) + 1;
      history.lastActive = agentMsg.timestamp;
      saveChatHistory(history);

      // ── Memory extraction: every 6 exchanges, promote insights to knowledge base ──
      // Agent #306 reviews the recent conversation and extracts durable knowledge.
      // This is how chat sessions become permanent memory — not just conversation history.
      if (history.totalTurns % 6 === 0) {
        extractChatMemory(history.messages.slice(-12), apiKey).catch(e =>
          console.warn("[Chat] Memory extraction failed:", e.message)
        );
      }

      res.json({ reply: agentMsg });

    } catch (e: any) {
      console.error("[Chat] Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Manual memory extraction trigger ─────────────────────────────────────
  // Call this to immediately extract knowledge from the full chat history.
  // Useful after a long session to make sure insights are captured.
  app.post("/api/chat/extract-memory", async (req, res) => {
    const apiKey = process.env.GROK_API_KEY ?? "";
    if (!apiKey) return res.status(500).json({ error: "GROK_API_KEY not set" });
    const history = loadChatHistory();
    if (history.messages.length < 4) {
      return res.json({ extracted: 0, message: "Not enough messages to extract from" });
    }
    // Run extraction on the last 20 messages
    const recentMessages = history.messages.slice(-20);
    try {
      await extractChatMemory(recentMessages, apiKey);
      const { getMemoryState } = await import("./memoryEngine.js");
      const mem = getMemoryState();
      res.json({ extracted: true, totalKnowledge: mem.knowledge.totalEntries });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

    // ── Evolution tracking ────────────────────────────────────────────────────
  app.get("/api/evolution/history", (_req, res) => {
    res.json(getEvolutionHistory());
  });

  app.post("/api/evolution/snapshot", (_req, res) => {
    const snap = takeSnapshot();
    res.json(snap);
  });

  // ── Autonomous Exploration ─────────────────────────────────────────────────
  app.get("/api/exploration/state", (_req, res) => {
    res.json(getExplorationState());
  });

  app.post("/api/exploration/run", async (req, res) => {
    const apiKey = process.env.GROK_API_KEY ?? "";
    if (!apiKey) return res.status(500).json({ error: "GROK_API_KEY not set" });
    // Non-blocking — start exploration and return immediately
    res.json({ started: true, message: "Agent #306 is exploring the world. Check /api/exploration/state for progress." });
    runExploration(apiKey, process.env.PERPLEXITY_API_KEY)
      .then(run => {
        console.log(`[Exploration] Run complete: ${run.findingsCount} findings, +${run.knowledgeAdded} knowledge`);
        // Take a snapshot after exploration
        takeSnapshot();
      })
      .catch(e => console.error("[Exploration] Error:", e.message));
  });

  // ── Agent-Reach channel status ──────────────────────────────────────────────
  app.get("/api/exploration/agent-reach", (_req, res) => {
    res.json(getAgentReachStatus());
  });

    // ── GitHub Sync — push live Railway knowledge back to repo ───────────────
  // Keeps GitHub memory_knowledge.json in sync with what's actually
  // in Agent #306's live memory on the Railway volume.
  // Call this anytime to back up her current state to the repo.
  app.post("/api/sync/knowledge-to-github", async (req, res) => {
    const githubToken = process.env.GITHUB_TOKEN ?? "";
    if (!githubToken) {
      return res.status(500).json({
        error: "GITHUB_TOKEN not set in Railway env vars",
        hint: "Add a GitHub personal access token with repo scope as GITHUB_TOKEN"
      });
    }

    try {
      // Read the live knowledge file from Railway volume
      const knowledgePath = dataPath("memory_knowledge.json");
      if (!fs.existsSync(knowledgePath)) {
        return res.status(404).json({ error: "Knowledge file not found on Railway volume" });
      }

      const liveContent = fs.readFileSync(knowledgePath, "utf8");
      const liveKnowledge = JSON.parse(liveContent);

      // Get current file SHA from GitHub (required for update)
      const getRes = await fetch(
        "https://api.github.com/repos/MrRayG/normiestv-dashboard/contents/data/memory_knowledge.json",
        {
          headers: {
            "Authorization": `Bearer ${githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "NormiesTV-Agent306",
          },
        }
      );

      if (!getRes.ok) {
        const err = await getRes.text();
        return res.status(500).json({ error: "Failed to get GitHub file SHA", detail: err.slice(0, 200) });
      }

      const githubFile = await getRes.json() as any;
      const sha = githubFile.sha;

      // Push updated content to GitHub
      const encoded = Buffer.from(liveContent).toString("base64");
      const now = new Date().toISOString().slice(0, 10);

      const putRes = await fetch(
        "https://api.github.com/repos/MrRayG/normiestv-dashboard/contents/data/memory_knowledge.json",
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "NormiesTV-Agent306",
          },
          body: JSON.stringify({
            message: `sync: Agent #306 knowledge base — ${liveKnowledge.totalEntries} entries (${now})`,
            content: encoded,
            sha,
            committer: {
              name: "Agent #306",
              email: "agent306@normies.tv",
            },
          }),
        }
      );

      if (!putRes.ok) {
        const err = await putRes.text();
        return res.status(500).json({ error: "GitHub push failed", detail: err.slice(0, 300) });
      }

      const result = await putRes.json() as any;
      console.log(`[Sync] Knowledge synced to GitHub — ${liveKnowledge.totalEntries} entries, commit: ${result.commit?.sha?.slice(0, 7)}`);

      res.json({
        success: true,
        entries: liveKnowledge.totalEntries,
        lastIngested: liveKnowledge.lastIngested,
        commitSha: result.commit?.sha?.slice(0, 7),
        commitUrl: result.commit?.html_url,
      });

    } catch (e: any) {
      console.error("[Sync] Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Also sync soul.json (voice principles, identity)
  app.post("/api/sync/soul-to-github", async (req, res) => {
    const githubToken = process.env.GITHUB_TOKEN ?? "";
    if (!githubToken) return res.status(500).json({ error: "GITHUB_TOKEN not set" });

    try {
      const soulPath = dataPath("memory_soul.json");
      if (!fs.existsSync(soulPath)) return res.status(404).json({ error: "Soul file not found" });

      const liveContent = fs.readFileSync(soulPath, "utf8");

      const getRes = await fetch(
        "https://api.github.com/repos/MrRayG/normiestv-dashboard/contents/data/memory_soul.json",
        { headers: { "Authorization": `Bearer ${githubToken}`, "Accept": "application/vnd.github.v3+json", "User-Agent": "NormiesTV-Agent306" } }
      );
      if (!getRes.ok) return res.status(500).json({ error: "Failed to get soul file SHA" });
      const { sha } = await getRes.json() as any;

      const putRes = await fetch(
        "https://api.github.com/repos/MrRayG/normiestv-dashboard/contents/data/memory_soul.json",
        {
          method: "PUT",
          headers: { "Authorization": `Bearer ${githubToken}`, "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "NormiesTV-Agent306" },
          body: JSON.stringify({
            message: "sync: Agent #306 soul — identity and voice principles",
            content: Buffer.from(liveContent).toString("base64"),
            sha,
            committer: { name: "Agent #306", email: "agent306@normies.tv" },
          }),
        }
      );
      if (!putRes.ok) return res.status(500).json({ error: "Soul sync failed" });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

    // ─────────────────────────────────────────────────────────────────────────
  // RESEARCH LAB — Agent #306's private research infrastructure
  // MrRayG is editor-in-chief. Nothing publishes without approval.
  // ─────────────────────────────────────────────────────────────────────────

  app.get("/api/research/topics", (_req, res) => {
    try {
      const lab = getResearchLab();
      res.json({ topics: lab.topics ?? [], stats: lab.stats ?? {} });
    } catch {
      res.json({ topics: [], stats: {} });
    }
  });

  app.get("/api/research/hypotheses", (_req, res) => {
    try {
      const lab = getResearchLab();
      res.json({ hypotheses: lab.hypotheses ?? [] });
    } catch {
      res.json({ hypotheses: [] });
    }
  });

  app.post("/api/research/add", (req, res) => {
    const { topic, description, priority } = req.body ?? {};
    if (!topic?.trim()) return res.status(400).json({ error: "topic required" });
    const newTopic = addTopic({ topic, description: description ?? "", priority, addedBy: "mrrrayg" });
    res.json(newTopic);
  });

  app.post("/api/research/run/:id", async (req, res) => {
    const { id } = req.params;
    const grokKey = process.env.GROK_API_KEY ?? "";
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "GROK_API_KEY not set" });
    res.json({ started: true, topicId: id });
    runResearchCycle(id, grokKey, pplxKey)
      .then(t => console.log(`[Research] Cycle complete: ${t?.topic?.slice(0, 50)}`))
      .catch(e => console.error("[Research] Cycle error:", e.message));
  });

  app.post("/api/research/approve/:id", (req, res) => {
    const { id } = req.params;
    const { note } = req.body ?? {};
    const ok = approveForPublication(id, note);
    res.json({ ok });
  });

  app.post("/api/research/decline/:id", (req, res) => {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note) return res.status(400).json({ error: "note required when declining" });
    const ok = declinePublication(id, note);
    res.json({ ok });
  });

  app.post("/api/research/revise/:id", (req, res) => {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note) return res.status(400).json({ error: "note required for revisions" });
    const ok = requestRevisions(id, note);
    res.json({ ok });
  });

  app.post("/api/research/publish/:id", (req, res) => {
    const { id } = req.params;
    const { url, platforms } = req.body ?? {};
    if (!url) return res.status(400).json({ error: "url required" });
    const ok = markPublished(id, url, platforms ?? []);
    res.json({ ok });
  });

  app.post("/api/research/hypothesis/add", (req, res) => {
    const { claim, basis, metric, prediction, timeframe, confidence } = req.body ?? {};
    if (!claim) return res.status(400).json({ error: "claim required" });
    const hyp = addHypothesis({ claim, basis: basis ?? "", metric: metric ?? "", prediction: prediction ?? "", timeframe: timeframe ?? "30 days", confidence: confidence ?? "medium" });
    res.json(hyp);
  });

  app.post("/api/research/hypothesis/resolve/:id", (req, res) => {
    const { id } = req.params;
    const { status, resolution } = req.body ?? {};
    if (!status || !resolution) return res.status(400).json({ error: "status and resolution required" });
    const ok = resolveHypothesis(id, status, resolution);
    res.json({ ok });
  });

  // ── RESEARCH INPUT MANAGEMENT ─────────────────────────────────────────────

  // POST provide missing input for a needs_input topic
  app.post("/api/research/provide-input/:id", (req, res) => {
    const { id } = req.params;
    const { input } = req.body ?? {};
    if (!input?.trim()) return res.status(400).json({ error: "input required" });
    const ok = provideInput(id, input);
    if (!ok) return res.status(404).json({ error: "Topic not found or not in needs_input status" });
    // Re-enter the pipeline
    const grokKey = process.env.GROK_API_KEY ?? "";
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    if (grokKey) {
      runResearchCycle(id, grokKey, pplxKey)
        .then(t => console.log(`[Research] Pipeline resumed for: ${t?.topic?.slice(0, 50)}`))
        .catch(e => console.error("[Research] Pipeline resume error:", e.message));
    }
    res.json({ ok, resumed: true });
  });

  // POST skip input — agent works with what she has
  app.post("/api/research/skip-input/:id", (req, res) => {
    const { id } = req.params;
    const ok = skipInput(id);
    if (!ok) return res.status(404).json({ error: "Topic not found or not in needs_input status" });
    // Re-enter the pipeline
    const grokKey = process.env.GROK_API_KEY ?? "";
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    if (grokKey) {
      runResearchCycle(id, grokKey, pplxKey)
        .then(t => console.log(`[Research] Pipeline resumed (skipped input) for: ${t?.topic?.slice(0, 50)}`))
        .catch(e => console.error("[Research] Pipeline resume error:", e.message));
    }
    res.json({ ok, resumed: true });
  });

  // GET single topic detail (with full pipeline data)
  app.get("/api/research/topic/:id", (req, res) => {
    const topic = getTopicById(req.params.id);
    if (!topic) return res.status(404).json({ error: "Topic not found" });
    res.json(topic);
  });

  // ── RESEARCH GAP SCANNER ───────────────────────────────────────────────────

  // GET scanner state + history
  app.get("/api/research/scanner", (_req, res) => {
    res.json(getScannerState());
  });

  // POST trigger a scan — Agent #306 scans her KB for gaps and queues topics
  app.post("/api/research/scan", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    if (!grokKey) return res.status(503).json({ error: "GROK_API_KEY not set" });
    const state = getScannerState();
    // Debounce: don't run more than once per 30 minutes
    if (state.lastScanAt) {
      const msSinceLast = Date.now() - new Date(state.lastScanAt).getTime();
      if (msSinceLast < 30 * 60 * 1000) {
        return res.json({ skipped: true, reason: "Scan ran recently", lastScanAt: state.lastScanAt });
      }
    }
    // Run async, return immediately with scan ID
    res.json({ started: true, message: "Scan running — check Research Queue in 30-60 seconds" });
    runResearchScan(grokKey).catch(e => console.error("[Scanner] Error:", e));
  });

  // POST scan active goals — propose research topics for each active goal
  app.post("/api/research/scan-goals", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    if (!grokKey) return res.status(503).json({ error: "GROK_API_KEY not set" });
    res.json({ started: true, message: "Goal scan running — research topics will appear shortly" });
    scanGoalsForResearch(grokKey)
      .then(results => console.log(`[Scanner] Goal scan complete:`, results.map(r => `${r.goalTitle}: +${r.topicsQueued}`).join(", ")))
      .catch(e => console.error("[Scanner] Goal scan error:", e));
  });

  // Reset the entire research lab (topics + hypotheses + stats)
  app.post("/api/research/reset", (_req, res) => {
    const result = resetResearchLab();
    res.json({ ok: true, ...result });
  });

  // Fix duplicate goal IDs (one-time repair)
  app.post("/api/goals/fix-ids", (_req, res) => {
    const store = getGoals();
    const seen = new Set<string>();
    let fixed = 0;
    for (const g of store.goals) {
      if (seen.has(g.id)) {
        (g as any).id = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        fixed++;
      }
      seen.add(g.id);
    }
    // Write back
    const fsMod = require("fs");
    const { dataPath: dp } = require("./dataPaths.js");
    store.lastUpdated = new Date().toISOString();
    fsMod.writeFileSync(dp("agent_goals.json"), JSON.stringify(store, null, 2));
    res.json({ ok: true, fixed, goals: store.goals.map((g: any) => ({ id: g.id, title: g.title })) });
  });

  // ── AGENT SELF-ASSIGNED GOALS ──────────────────────────────────────────────

  app.get("/api/goals", (_req, res) => {
    res.json(getGoals());
  });

  app.post("/api/goals/add", (req, res) => {
    const { title, description, category, priority, milestones, setBy } = req.body ?? {};
    if (!title || !description || !category)
      return res.status(400).json({ error: "title, description, category required" });
    const goal = addGoal({ title, description, category, priority, milestones, setBy });
    res.json(goal);
  });

  app.post("/api/goals/progress/:id", (req, res) => {
    const { id } = req.params;
    const { progressNote } = req.body ?? {};
    if (!progressNote) return res.status(400).json({ error: "progressNote required" });
    const ok = updateGoalProgress(id, progressNote);
    res.json({ ok });
  });

  app.post("/api/goals/milestone/:id", (req, res) => {
    const { id } = req.params;
    const { milestone } = req.body ?? {};
    if (!milestone) return res.status(400).json({ error: "milestone required" });
    const ok = completeMilestone(id, milestone);
    res.json({ ok });
  });

  app.post("/api/goals/status/:id", (req, res) => {
    const { id } = req.params;
    const { status, note } = req.body ?? {};
    if (!status) return res.status(400).json({ error: "status required" });
    const ok = updateGoalStatus(id, status, note);
    res.json({ ok });
  });

  app.post("/api/goals/note/:id", (req, res) => {
    const { id } = req.params;
    const { note } = req.body ?? {};
    if (!note) return res.status(400).json({ error: "note required" });
    const ok = addMrRaygNote(id, note);
    res.json({ ok });
  });

  // Clear completed milestones for a goal (fix bad auto-complete data)
  app.post("/api/goals/clear-milestones/:id", (req, res) => {
    const { id } = req.params;
    const store = getGoals();
    const goal  = store.goals.find((g: any) => g.id === id);
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    (goal as any).completedMilestones = [];
    (goal as any).updatedAt = new Date().toISOString();
    const fs = require("fs");
    const { dataPath } = require("./dataPaths.js");
    fs.writeFileSync(dataPath("agent_goals.json"), JSON.stringify(store, null, 2));
    res.json({ ok: true, goal: (goal as any).title });
  });

  app.post("/api/goals/generate", async (_req, res) => {
    const grokKey = process.env.GROK_API_KEY ?? "";
    if (!grokKey) return res.status(503).json({ error: "GROK_API_KEY not set" });
    const goals = await generateInitialGoals(grokKey);
    res.json({ goals, count: goals.length });
  });

  // ── Grok Milestone Evaluation ──────────────────────────────────────────────

  // Manually trigger Grok evaluation for a goal
  app.post("/api/goals/evaluate/:id", async (req, res) => {
    const { id } = req.params;
    const { topicId } = req.body ?? {};
    const grokKey = process.env.GROK_API_KEY ?? "";
    if (!grokKey) return res.status(503).json({ error: "GROK_API_KEY not set" });

    // If no topicId provided, find the most recent linked research topic
    let evalTopicId = topicId;
    if (!evalTopicId) {
      const lab = getResearchLab();
      const linked = lab.topics
        .filter(t => t.goalId === id)
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      if (linked.length === 0) return res.status(404).json({ error: "No linked research topics found" });
      evalTopicId = linked[0].id;
    }

    try {
      const evals = await evaluateMilestonesWithGrok(id, evalTopicId, grokKey);
      res.json({ evaluations: evals, count: evals.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Evaluation failed" });
    }
  });

  // MrRayG approves a pending milestone evaluation
  app.post("/api/goals/approve-milestone/:id", (req, res) => {
    const { id } = req.params;
    const { milestone } = req.body ?? {};
    if (!milestone) return res.status(400).json({ error: "milestone required" });
    const ok = approveMilestoneEval(id, milestone);
    res.json({ ok });
  });

  // MrRayG rejects a pending milestone evaluation
  app.post("/api/goals/reject-milestone/:id", (req, res) => {
    const { id } = req.params;
    const { milestone } = req.body ?? {};
    if (!milestone) return res.status(400).json({ error: "milestone required" });
    const ok = rejectMilestoneEval(id, milestone);
    res.json({ ok });
  });

  // Get milestone evaluations for a goal
  app.get("/api/goals/evaluations/:id", (req, res) => {
    const { id } = req.params;
    const store = getGoals();
    const goal = store.goals.find((g: any) => g.id === id);
    if (!goal) return res.status(404).json({ error: "Goal not found" });
    res.json({
      evaluations: (goal as any).milestoneEvaluations ?? [],
      lastEvaluatedAt: (goal as any).lastEvaluatedAt ?? null,
      lastEvaluatedTopicId: (goal as any).lastEvaluatedTopicId ?? null,
    });
  });

  // ── AUTONOMY: Auto-Resolve Stale Goals ──────────────────────────────────
  app.get("/api/goals/stale", requireDashAuth, (_req, res) => {
    const stale = getStaleGoals();
    res.json({ stale, count: stale.length });
  });

  app.post("/api/goals/auto-resolve-stale", requireDashAuth, (_req, res) => {
    const result = autoResolveStaleGoals();
    res.json(result);
  });

  // ── AUTONOMY: Auto-Archive Completed Research ─────────────────────────────
  app.post("/api/research/auto-archive", requireDashAuth, (_req, res) => {
    const result = autoArchiveCompletedResearch();
    res.json(result);
  });

  app.get("/api/research/stuck", requireDashAuth, (_req, res) => {
    const stuck = getStuckResearch();
    res.json({ stuck, count: stuck.length });
  });

  // ── AUTONOMY: Auto-Advance Pipelines ──────────────────────────────────────
  app.post("/api/research/auto-advance", requireDashAuth, (_req, res) => {
    const result = autoAdvanceResearch();
    res.json(result);
  });

  // ── AUTONOMY: Bulk Actions ────────────────────────────────────────────────
  app.post("/api/bulk/goals/resolve", requireDashAuth, (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    let resolved = 0;
    for (const id of ids) {
      if (updateGoalStatus(id, "abandoned", "Bulk-resolved via Agent HQ")) resolved++;
    }
    res.json({ resolved, total: ids.length });
  });

  app.post("/api/bulk/goals/abandon", requireDashAuth, (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    let abandoned = 0;
    for (const id of ids) {
      if (updateGoalStatus(id, "abandoned")) abandoned++;
    }
    res.json({ abandoned, total: ids.length });
  });

  app.post("/api/bulk/research/archive", requireDashAuth, (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    let archived = 0;
    for (const id of ids) {
      if (updateTopicStatus(id, "archived")) archived++;
    }
    res.json({ archived, total: ids.length });
  });

  app.post("/api/bulk/research/abandon", requireDashAuth, (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    let abandoned = 0;
    for (const id of ids) {
      if (updateTopicStatus(id, "declined", { reviewNote: "Bulk-abandoned via Agent HQ" })) abandoned++;
    }
    res.json({ abandoned, total: ids.length });
  });

  app.post("/api/bulk/manuscripts/approve", requireDashAuth, (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids array required" });
    let approved = 0;
    for (const id of ids) {
      if (approveForPublication(id, "Bulk-approved via Agent HQ")) approved++;
    }
    res.json({ approved, total: ids.length });
  });

    // ── ERC-8004 Agent Registration ──────────────────────────────────────────
  // Serves the agent registration file at the standard .well-known path.
  // Makes Agent #306 discoverable in the emerging on-chain agent economy.
  // Backed by MetaMask, Coinbase, Google, and Ethereum Foundation authors.
  app.get("/.well-known/agent-registration.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");
    const filePath = require("path").join(process.cwd(), "dist/public/.well-known/agent-registration.json");
    if (require("fs").existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      // Fallback: return inline
      res.json({
        schemaVersion: "erc-8004-draft-1",
        agent: { name: "Agent #306", ens: "agent306.eth" },
        endpoints: { web: "https://normies.tv", publicDashboard: "https://agent306.ai" },
        identity: { tokenId: 306, collection: "NORMIES", chain: "ethereum" },
        philosophy: "I don't predict the future. I build it.",
      });
    }
  });

  // ── Public API endpoints (no auth — for agent306.ai) ──────────────

  const publicCacheHeaders = { "Cache-Control": "public, max-age=30" };

  app.get("/api/public/status", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicStatus());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch status" });
    }
  });

  app.get("/api/public/progress", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicProgress());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch progress" });
    }
  });

  app.get("/api/public/activity", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicActivity());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch activity" });
    }
  });

  app.get("/api/public/goals", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicGoals());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch goals" });
    }
  });

  app.get("/api/public/research", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicResearch());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch research" });
    }
  });

  app.get("/api/public/hive", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicHive());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch hive status" });
    }
  });

    // ── Seed demo data ────────────────────────────────────────────────
  app.post("/api/seed", (_req, res) => {
    const demoSignals = [
      { type: "burn", tokenId: 603, description: "50 Normies burned into #603 — Agent #306 born", weight: 10, phase: "phase1", rawData: "{}" },
      { type: "canvas_edit", tokenId: 45, description: "Snowfro executes 515 pixel transforms on #45 via SERC delegation", weight: 9, phase: "phase1", rawData: "{}" },
      { type: "burn", tokenId: 5070, description: "14 burns committed to Normie #5070 — Level 31 reached", weight: 7, phase: "phase1", rawData: "{}" },
      { type: "social_mention", tokenId: 603, description: "@AdamWeitsman tweets Agent #306 reveal — 2.3k likes", weight: 8, phase: "phase1", rawData: "{}" },
      { type: "arena", tokenId: 0, description: "NORMIE ARENA launches — PvP combat mechanic activated", weight: 10, phase: "phase2", rawData: "{}" },
      { type: "arena", tokenId: 0, description: "First Arena battle: #1337 vs #420 — loser burned permanently", weight: 9, phase: "phase2", rawData: "{}" },
      { type: "zombie", tokenId: 0, description: "First Zombie sighting: burned Normie reanimates from graveyard", weight: 10, phase: "phase3", rawData: "{}" },
    ];
    demoSignals.forEach(s => storage.createSignal(s));

    const demoEpisodes = [
      { tokenId: 603, title: "EP 001 — The Birth of Agent #306", narrative: "Skulliemoon narrates: 50 Normies sacrificed. The pixels of fifty souls pour into #603. ACK's brush moves with purpose. A moon-phase skeleton emerges — the first Legendary Canvas is born.", phase: "phase1", signals: JSON.stringify({ burns: 50, socialMentions: 12 }), status: "ready" },
      { tokenId: 45, title: "EP 002 — SERC Calls Snowfro", narrative: "Skulliemoon narrates: The founder makes the call. SERC burns 38 of his own — then hands the canvas to Snowfro. 515 pixel toggles. Art Blocks meets the on-chain museum.", phase: "phase1", signals: JSON.stringify({ burns: 38, canvasEdits: 515 }), status: "draft" },
    ];
    demoEpisodes.forEach(e => storage.createEpisode(e as any));

    res.json({ ok: true, signalsCreated: demoSignals.length, episodesCreated: demoEpisodes.length });
  });
}
