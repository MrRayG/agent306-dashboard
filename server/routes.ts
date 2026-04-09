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
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
// Burns, community, and catalog imports removed (removed)
// import { checkForNewBurns, processBurnReceipt, getReceiptState } from "./burnReceiptEngine";
// import { getCommunitySignalCache, searchCommunitySocial, resetCommunityCache } from "./grokEngine";
// import { ingestSignals, getCatalog, getCatalogStats, getMostActive, getStorySourceHolders } from "./holderCatalog";
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
import { getPodcastState, EPISODE_META, createEpisode, generateEpisodeScript, regenerateEpisodeScript, reviewEpisode, markProduced, publishEpisode, submitGuestRequest, reviewGuest, generateInterviewQuestions, submitAnswers, createConversationEpisode, getEpisodesByType, getEpisodesByStatus, getGuestsByStatus, getEpisode, getGuest, formatScriptForProduction, formatConversationForProduction, generateEpisodeFromThread, getThreadCandidates, getPipelineStatus, deleteEpisode, clearAllEpisodes } from "./podcastEngine.js";
import { getVideoStats } from "./videoEngine.js";
import { requestPost, registerPost, releasePost, getCoordinatorState, resetCooldown } from "./postCoordinator.js";
import { runWeeklyDeepRead, previewDeepRead, getArticleState, scheduleWeeklyArticle } from "./articleEngine.js";
import { runExploration, getExplorationState, scheduleExploration } from "./explorationEngine.js";
import { getAgentReachStatus } from "./agentReachEngine.js";
import { postCast, isFarcasterEnabled, getFarcasterState, setFarcasterEnabled, createSigner, getSignerStatus, fetchMentions, determineChannel, getStoredSignerUuid, storeSignerUuid } from "./farcasterEngine.js";
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
import { getPublicStatus, getPublicProgress, getPublicActivity, getPublicGoals, getPublicResearch, getPublicMetacognition } from "./publicApi.js";
import { getReflections, getStyleRules, deleteStyleRule, runReflection } from "./reflectionEngine.js";
import {
  getPublishedPosts, getPostBySlug, getAllPosts,
  createBlogPost, generateBlogPost, publishPost, updatePost, deletePost,
  getBlogState
} from "./blogEngine.js";
import { getDebates, getContradictions, runDebate, resolveContradiction, runConfidenceDecay, getDecayingEntries } from "./reasoningEngine.js";
import { getConnections, getReports, runConnectionScan, generateSynthesis } from "./synthesisEngine.js";
import { getKnowledgeMap, getClusters, getContradictions as getGraphContradictions, findConnections as findGraphConnections, clusterKnowledge, detectContradictions, generatePerspective } from "./knowledge-graph.js";
import { getInsights, getRelationships, extractInsights, analyzeRelationships } from "./conversationLearningEngine.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { searchConversations } from "./conversationMemory.js";
import { getKnowledgeTiers, scanForInjection } from "./memoryEngine.js";
import { getModel, getModelConfig as getModelRouterStats } from "./modelRouter.js";
import { getCoreIdentity, getRelevantContext, getOptimizedContext, getRelevantContextAsync, addOperatorDirective, getOperatorDirectives } from "./contextWindow.js";
import { getEmbeddingStatus, syncEmbeddings, semanticSearch } from "./embeddingEngine.js";
import { getRecentAnalysis, getAggregatedPatterns } from "./analyzerEngine.js";
import { runFullIntake, runSourceIntake, getIntakeState, getAvailableSources, generateDailyBrief } from "./data-intake.js";
import { getSkills, getSkillById, deleteSkill, extractSkill, getSkillsState, checkAndExtractSkills } from "./skillEngine.js";
import { getAgenda, getThreadById, updateThread, getPodcastCandidates, generateResearchAgenda, prioritizeThreads, advanceThread, evaluateMaturity, pruneStaleThreads } from "./research-agenda.js";
import {
  getDreams, getDreamById, dream, updateDreamManual, updateDreams,
  getGrowthSnapshots, getLatestGrowthSnapshot, getGrowthTimeline, takeGrowthSnapshot,
  getEpisodeReflections, reflectOnEpisode,
  getImprovementPlans, getLatestPlan, generateSelfImprovementPlan,
  seedDreams,
} from "./dreamEngine.js";

// On-chain API removed
// const ONCHAIN_API = "";

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
const X_APP_KEY     = process.env.X_APP_KEY     ?? "";
const X_APP_SECRET  = process.env.X_APP_SECRET  ?? "";
const X_ACCESS_TOKEN  = process.env.X_ACCESS_TOKEN  ?? "";
const X_ACCESS_SECRET = process.env.X_ACCESS_SECRET ?? "";

if (!X_APP_KEY || !X_APP_SECRET) {
  console.error("[Agent306] X_APP_KEY or X_APP_SECRET not set — X API will not work");
}
if (!X_ACCESS_TOKEN || !X_ACCESS_SECRET) {
  console.error("[Agent306] X_ACCESS_TOKEN or X_ACCESS_SECRET not set — posting to X disabled");
} else {
  console.log("[Agent306] X API credentials configured — posting enabled");
}

// Guard: TwitterApi may throw on empty strings — wrap in try/catch so server still boots
let xClient: TwitterApi;
let xWrite: any;
try {
  if (X_APP_KEY && X_APP_SECRET && X_ACCESS_TOKEN && X_ACCESS_SECRET) {
    xClient = new TwitterApi({
      appKey:       X_APP_KEY,
      appSecret:    X_APP_SECRET,
      accessToken:  X_ACCESS_TOKEN,
      accessSecret: X_ACCESS_SECRET,
    });
    xWrite = xClient.readWrite;
  } else {
    console.warn("[Agent306] X API keys incomplete — creating dummy client (posts will fail gracefully)");
    xClient = new TwitterApi({ appKey: "x", appSecret: "x", accessToken: "x", accessSecret: "x" });
    xWrite = xClient.readWrite;
  }
} catch (e: any) {
  console.error("[Agent306] TwitterApi init failed:", e.message, "— creating dummy client");
  xClient = new TwitterApi({ appKey: "x", appSecret: "x", accessToken: "x", accessSecret: "x" });
  xWrite = xClient.readWrite;
}

// fetchOnChainAPI removed
// async function fetchOnChainAPI(path: string) {
//   const res = await fetch(`${ONCHAIN_API}${path}`);
//   if (!res.ok) throw new Error(`API error: ${res.status}`);
//   return res.json();
// }

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
// AGENT 306 — GROK-POWERED AUTONOMOUS STORY ENGINE v2
// Multi-source signals → Grok narrative → Episodic memory → Auto-post
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
  console.log(`[Agent306] Grok pipeline starting — ${runStart}`);

  try {
    // ── 1. Fetch fresh community signals RIGHT NOW before generating ──────
    // This replaces the 30min background poller — fetch on demand, not on a timer
    console.log(`[Agent306] Collecting signals from all sources...`);
    // Community signal poller removed (removed)

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
    console.log(`[Agent306] Calling Grok for EP${epNum} — ${signals.length} signals, diversity: avoid tokens ${diversity.lastFeaturedTokens}`);

    // Build editorial context — pinned story angles
    const freshSignals: any[] = [];
    const communitySnapshot = "";
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
        "Connect the narrative to a moment outside Web3 this episode — art history, a sports rivalry, " +
        "a technology inflection point, or a philosophical concept. Cultural bridges drive " +
        "the highest RT rate in the dataset. Deploy it."
      );
      console.log("[Agent306] Cultural bridge reminder injected — overdue.");
    }

    const editorialContext = {
      pinnedAngles: pinnedAngles.slice(0, 3),
      communitySnapshot: replyContext
        ? `${communitySnapshot}

${replyContext}`
        : communitySnapshot,
    };

    const grokResult = await generateEpisodeWithGrok(signals, episodeMemory, epNum, diversity, editorialContext);
    console.log(`[Agent306] Grok EP${epNum}: "${grokResult.title}" [${grokResult.sentiment}]`);

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

    // Image upload removed (on-chain API disabled)
    let xMediaId: string | undefined;

    // ── 6. Quality gate — would a real reader stop scrolling for this? ──
    let finalTweetText = grokResult.tweet;
    const grokKeyQ = LLM_API_KEY;
    if (grokKeyQ) {
      try {
        const qualityCheck = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel("routine"),
            messages: [{
              role: "system",
              content: "You are a quality editor for Agent 306. Score tweets ruthlessly. Only high-quality, human-sounding tweets earn a post.",
            }, {
              role: "user",
              content: `Score this tweet 1-10 on: would a real reader stop scrolling for this?

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
          console.log(`[Agent306] Quality gate EP${epNum}: score ${q.score}/10 — ${q.reason}`);

          if (q.score >= 7) {
            // ✅ Good to go — post as-is
            console.log(`[Agent306] EP${epNum} passed quality gate (${q.score}/10)`);
          } else if (q.rewrite) {
            // 🔄 Score 4-6 with a rewrite available — use it regardless of score
            console.log(`[Agent306] Rewriting tweet (score ${q.score}): ${q.rewrite}`);
            finalTweetText = q.rewrite;
          } else {
            // ❌ Score too low AND no rewrite — skip this episode entirely
            console.log(`[Agent306] EP${epNum} SKIPPED — score ${q.score}, no rewrite available`);
            pollerStatus.lastError = `Quality gate blocked EP${epNum} (score: ${q.score}, no rewrite)`;
            releasePost("episode");
            return;
          }
        }
      } catch (qErr: any) {
        console.warn("[Agent306] Quality gate check failed, posting anyway:", qErr.message);
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
      tweetUrl = openerTweetId ? `https://x.com/agent3zero6/status/${openerTweetId}` : `https://x.com/agent3zero6`;
      storage.updateEpisodeStatus(episode.id, "posted", tweetUrl);
      pollerStatus.lastTweetUrl = tweetUrl;
      console.log(`[Agent306] EP${epNum} opener posted${xMediaId ? " with image" : ""}: ${tweetUrl}`);
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
      console.error("[Agent306] Opener tweet failed:", openerErr.message);
    }

    // ── Thread posts REMOVED — quality over volume ──────────────────────
    // One great tweet with one great image > four mediocre thread tweets.
    // The opener IS the post. If it doesn't stand alone, it wasn't good enough.
    // Thread replies dumping stats were the #1 source of slop. Killed intentionally.
    console.log(`[Agent306] EP${epNum} — single tweet mode (no thread)`);

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
          console.log(`[Agent306] EP${epNum} cast posted to Farcaster${channel ? ` (/${channel})` : ""}: ${castUrl}`);
        }
      }
    } catch (fcErr: any) {
      console.warn("[Agent306] Farcaster episode post failed:", fcErr.message);
    }

    console.log(`[Agent306] EP${epNum} — ${tweetUrl ? "POSTED" : "ready in queue"}${castUrl ? " + Farcaster" : ""}`);
    // Mark community signals used — these topics won't repeat in the next episode
    if (tweetUrl || castUrl) {
      markSignalsUsed(freshSignals.slice(0, 10).map((p: any) => ({ url: p.url, text: p.text })));
      if (tweetUrl) registerPost("episode", tweetUrl, `episode_${epNum}`);
    }

  } catch (e: any) {
    console.error("[Agent306] Pipeline error:", e.message);
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
// no social activity since last episode
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
  console.log(`[Agent306] Episode poller armed — next run in 12h (${pollerStatus.nextRun})`);
}, 5_000);

// ── Daily News Dispatch — 8am ET every day ─────────────────────────────────
// THE_100_TOKENS removed (removed)

// Guard: only post once per day
let lastNewsDispatchDate: string | null = null;

async function postDailyNewsDispatch() {
  const grokKey = LLM_API_KEY;
  if (!grokKey) return;

  // Disk-based lock — prevents duplicates during Railway deploy overlap
  const today = new Date().toISOString().slice(0, 10);
  if (lastNewsDispatchDate === today) {
    console.log("[Agent306:News] Already posted today — skipping");
    return;
  }
  if (!requestPost("news_dispatch")) return;
  lastNewsDispatchDate = today;

  console.log("[Agent306:News] Daily Dispatch starting...");
  try {
    // ── 1. Gather live data ──────────────────────────────────────────────
    const [cgRes] = await Promise.allSettled([
      fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,bitcoin&order=market_cap_desc&per_page=2&sparkline=false&price_change_percentage=24h"),
    ]);

    let ethPrice = "", btcPrice = "", ethChange = "", btcChange = "";
    if (cgRes.status === "fulfilled" && cgRes.value.ok) {
      const coins = await cgRes.value.json();
      const eth = coins.find((c: any) => c.id === "ethereum");
      const btc = coins.find((c: any) => c.id === "bitcoin");
      if (eth) { ethPrice = `$${eth.current_price.toLocaleString()}`; ethChange = `${eth.price_change_percentage_24h > 0 ? "+" : ""}${eth.price_change_percentage_24h?.toFixed(1)}%`; }
      if (btc) { btcPrice = `$${btc.current_price.toLocaleString()}`; btcChange = `${btc.price_change_percentage_24h > 0 ? "+" : ""}${btc.price_change_percentage_24h?.toFixed(1)}%`; }
    }

    // Top AI news — rich context for 306 to have real opinions about
    const aiHeadlines = await fetchAINews();
    const topAIHeadlines = aiHeadlines.slice(0, 5).map((h: any, i: number) =>
      `${i + 1}. "${h.title}" — ${h.source}\n   ${h.snippet ? h.snippet.slice(0, 180) + '...' : 'No snippet available.'}`
    ).join("\n\n");

    const dayLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York"
    });

    // ── 2. Ask Grok to write a full 4-tweet thread ───────────────────────────
    const grokResp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("news-dispatch"),
        messages: [{
          role: "user",
          content: `You are Agent 306 — an autonomous AI researcher and analyst. You cover AI, crypto, and technology.

IDENTITY FOR THIS DISPATCH:

THE EDITOR: You curate ruthlessly. You have a POV on every signal. Never neutral. "This matters because..." not "here is what happened."

THE AI EXPERT: You are not covering the AI revolution from the outside. You ARE an AI agent. When you write about AI — you write as a participant, not an observer. You know the landscape:
- Agentic AI market: $7.76B (2025) → $317B by 2035, 45% CAGR
- x402 Protocol: AI agents making autonomous payments — 75M+ transactions
- MCP donated to Linux Foundation — universal agent interoperability standard
- OpenAI Operator, Google Vertex AI Agent Builder — browser agents at scale
- 40% of enterprise applications integrate agentic AI by end of 2026

THE FUTURIST: You project. You predict. Reasoned vision backed by what you see happening right now.

THE OPTIMIST: You find opportunity in every challenge. You find the signal in the noise and the builder angle in every story.

Write today's [NEWS DISPATCH] as a single post. This is a media dispatch, not a stat dump.

TODAY'S DATA:
Date: ${dayLabel}

MARKET:
ETH: ${ethPrice || "$2,000"} (${ethChange || "0%"}), BTC: ${btcPrice || "$65,000"} (${btcChange || "0%"})

AI/TECH NEWS TODAY:
${topAIHeadlines || "Major AI developments continuing across the ecosystem."}

Write a single compelling post (max 1,000 chars) that covers today's most interesting AI or crypto signal. Agent 306's perspective — she has skin in this.

RULES:
- Agent 306 speaks in first person. She has opinions. She is part of this.
- No hype words: no "incredible", "amazing", "LFG", "WAGMI"
- Specificity over generality — name numbers, name people
- Reference specific headlines from the data provided. Be concrete — numbers, names, implications.
- NEVER reference Normies, NormiesTV, any founders, token holders, or NFT projects. Agent 306 is her own independent entity.

Return JSON: {"post": "..."}`
        }],
        max_tokens: 2500,
        temperature: 0.8,
      }),
    });

    let postText = "";
    if (grokResp.ok) {
      const data = await grokResp.json();
      const raw = data.choices?.[0]?.message?.content ?? "";
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          postText = parsed.post ?? "";
        }
      } catch {
        // If JSON fails but raw has content, use it directly
        if (raw.length > 30) postText = raw;
      }
    } else {
      console.error("[Agent306:News] LLM call failed:", grokResp.status);
    }

    // Fallback if Grok fails
    if (!postText) {
      postText = `[NEWS DISPATCH] ${dayLabel}\n\nETH ${ethPrice} (${ethChange}) · BTC ${btcPrice} (${btcChange}). AI and Web3 continue to converge.`;
    }

    // ── 3. Post single dispatch ──────────────────────────────────────
    let lastTweetId: string | undefined;
    try {
      const payload: any = { text: postText.trim() };
      const result = await xWrite.v2.tweet(payload);
      lastTweetId = result.data?.id;
      console.log(`[Agent306:News] Dispatch posted — ${lastTweetId} (${postText.length} chars)`);
    } catch (e: any) {
      console.error(`[Agent306:News] Post failed:`, e.message);
    }

    registerPost("news_dispatch", lastTweetId ? `https://x.com/agent3zero6/status/${lastTweetId}` : null, "news_dispatch");

    // ── 5. Post to Farcaster ───────────────────────────────────────────────
    try {
      if (isFarcasterEnabled() && postText.trim().length > 10) {
        const tweetUrl = lastTweetId ? `https://x.com/agent3zero6/status/${lastTweetId}` : undefined;
        const channel = postText.match(/\bai\b|agent|llm|model/i) ? "ai" : undefined;
        const cast = await postCast({
          text: postText.trim().slice(0, 1024),
          channel,
          embeds: tweetUrl ? [{ url: tweetUrl }] : undefined,
        });
        if (cast) {
          registerPost("news_dispatch", cast.url, "news_dispatch", "farcaster");
          console.log(`[Agent306:News] Farcaster dispatch posted: ${cast.url}`);
        }
      }
    } catch (fcErr: any) {
      console.warn("[Agent306:News] Farcaster dispatch failed:", fcErr.message);
    }

    console.log(`[Agent306:News] Daily Dispatch complete — single post`);

  } catch (err: any) {
    console.error("[Agent306:News] Daily Dispatch error:", err.message);
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
  console.log(`[Agent306:News] Daily Dispatch scheduled in ${Math.round(msUntil / 60000)}min (next 8am ET)`);
  setTimeout(() => {
    postDailyNewsDispatch();
    setInterval(postDailyNewsDispatch, 24 * 60 * 60 * 1000);
  }, msUntil);
}
scheduleDailyNewsDispatch();

// ── Burn Receipt Engine removed (removed) ────────────────────────────────────────

// Pre-launch research brief, signal poller removed (removed)

// Community Signal Poller removed (removed)
// Daily knowledge decay still runs via daily cycle engine

// Reply fetch is now handled inside scheduleMidnightReplies (fetch+reply every 1h)

// Weekly Leaderboard Scheduler removed (removed)

// ── Following Sync ────────────────
// Syncs on boot, then every 6 hours.
setTimeout(() => {
  scheduleFollowingSync(xClient);
}, 10_000);

// ── Engagement Tracker — scores every post 1h after posting ──────────────────
// Agent 306 reads her own engagement data before every episode. Gets smarter.
setTimeout(() => {
  startEngagementTracker(xClient);
}, 15_000);

// ── THE SPOTLIGHT — Weekly holder feature, Sunday 11am ET ─────────────────
setTimeout(() => {
  scheduleSpotlight(xWrite, LLM_API_KEY);
}, 20_000);

// ── WEEKLY AI ROUNDUP — Sunday 12pm ET ─────────────────
setTimeout(() => {
  scheduleRace(xWrite, LLM_API_KEY);
}, 25_000);

// ── PODCAST KNOWLEDGE v2 — Seed on boot ──────────────────────────────
// Two episode types: THE SIGNAL, THE CONVERSATION
const podcastKnowledge = [
  // Core structure
  { category: "research" as const, title: "Podcast: Two Episode Types", summary: "THE SIGNAL (6-9 min, weekly Tuesday) — research-driven intelligence breakdown. THE CONVERSATION (10-15 min, monthly/bi-weekly) — long-form interviews. Each type has its own template and unifying principle: every episode ends with something deliberately unresolved.", weight: 10 },
  // THE SIGNAL
  { category: "research" as const, title: "Podcast: THE SIGNAL Template", summary: "Cold Open (30s) — most counterintuitive fact, no intro, silence, then music. Act One — The Setup (1-2 min) — driving question, why it matters, what triggered research, one cultural bridge. Act Two — The Breakdown (3-5 min) — research explained clearly, no jargon without definition, 306's POV throughout, one fact per minute. Act Three — The Take (1-2 min) — 306's conclusion, what should happen next, one unresolved question. Outro (15s). Influenced by The Journal (WSJ) x Six Minutes.", weight: 10 },
  // THE CONVERSATION
  { category: "research" as const, title: "Podcast: THE CONVERSATION Template", summary: "Cold Open (30s) — most compelling moment from interview. Intro (30s) — who guest is, why 306 wanted to talk, driving question. The Conversation (8-12 min) — three acts: who they are, deep dive on driving question, forward look. The Close (1 min) — 306's reaction (not summary), what surprised her, what she thinks differently now. Outro (15s). Interview style: ask one question, genuinely listen, follow up on what was said, challenge respectfully, ask the question behind the question.", weight: 10 },
  // Voice principles
  { category: "research" as const, title: "Podcast: 306 Voice Rules", summary: "Uses 'I think' not 'experts say.' Pauses before important points. Defines before she deploys — no jargon without definition. Short sentences when she means it. Never: paid shilling, hype language, stat dumps without context, WAGMI/LFG, summaries masquerading as analysis, enthusiasm substituting for reasoning.", weight: 10 },
  // Title formats
  { category: "research" as const, title: "Podcast: Title Conventions", summary: "THE SIGNAL: '[The thing] — [306's take in 5 words]' (e.g., 'ARC-AGI-3 — The Benchmark No AI Can Beat'). THE CONVERSATION: '[Guest name] — [What the conversation revealed]'.", weight: 9 },
  // Production
  { category: "research" as const, title: "Podcast: Production Workflow", summary: "Flow: Draft (topic set) -> Scripted (script generated) -> Reviewed (MrRayG approval) -> Produced (audio via NotebookLM + ElevenLabs) -> Published (agent306.ai, Farcaster). For THE CONVERSATION: guest submits -> approved -> questions generated -> answered -> episode created -> scripted -> reviewed -> produced -> published.", weight: 9 },
  // Unifying principle
  { category: "research" as const, title: "Podcast: The Unresolved Thread", summary: "Every episode type ends with something unresolved. Not because 306 doesn't know — but because she's honest about the limits of what any single episode can answer. THE SIGNAL leaves an open question. THE CONVERSATION ends with 306's reaction, not a summary. This is what makes people come back. They're following a story that hasn't ended yet.", weight: 10 },
  // Preserved from v1
  { category: "research" as const, title: "Radical Empathy in Interviews", summary: "Enter every conversation assuming the guest has something worth saying. Listen to understand, not to respond. Let silences breathe. Preparation is how you show respect.", weight: 9 },
  { category: "ai_signal" as const, title: "Web3 Critical Thinking Sources", summary: "Molly White (web3isgoinggreat), Moxie Marlinspike's web3 critique, Vitalik's essays, David Rosenthal on digital preservation. Balance optimism with intellectual honesty.", weight: 8 },
  { category: "research" as const, title: "NFTs as Cultural Artifacts", summary: "Walter Benjamin's 'aura' concept applies to digital art. UC Berkeley research on provenance signaling. Oxford anthropology on NFT community rituals and shared mythology.", weight: 8 },
];
for (const k of podcastKnowledge) addKnowledge(k);


// -- RESEARCH GAP SCANNER -- Daily 4am ET (1hr after exploration) -----------
// Agent 306 reads her knowledge base, finds gaps, queues research topics.
// MrRayG reviews and approves in Agent HQ -> Research Queue.
{
  const grokKey = LLM_API_KEY;
  if (grokKey) scheduleResearchScan(grokKey);
}

// ── REPLY ENGINE — Hourly ────────────────────────────────────────
// AUTO-REPLY DISABLED — X account under suspension appeal
// Re-enable once X account is reinstated. Turn off before re-enabling.
// initReplyWatcher(xClient);
// setTimeout(() => {
//   scheduleMidnightReplies(xWrite);
// }, 30_000);

// ── ACADEMY — Tue/Thu/Sat 10am ET ──────────────────────────────
setTimeout(() => {
  scheduleAcademy(xWrite);
}, 35_000);

// ── SIGNAL BRIEF — Mon/Wed/Fri 12pm ET ────────────────────────────────────
setTimeout(() => {
  scheduleSignalBrief(xWrite, LLM_API_KEY);
}, 40_000);

// ── AGENT 306 DEEP READ — Every Monday 5:00 PM ET ─────────────────────────
setTimeout(() => {
  scheduleWeeklyArticle(xWrite, LLM_API_KEY);
}, 45_000);

// ── DAILY CYCLE — 6am ET (10:00 UTC) daily ──────────────────────────────────
setTimeout(() => {
  scheduleDailyCycle();
}, 50_000);

// ── EXPLORATION ENGINE — autonomous web scanning ──────────────────────────────
setTimeout(() => {
  const pplxKey = process.env.PERPLEXITY_API_KEY;
  if (pplxKey) {
    scheduleExploration(LLM_API_KEY, pplxKey);
    console.log("[Scheduler] Exploration engine scheduled");
  } else {
    console.warn("[Scheduler] Exploration engine skipped — no PERPLEXITY_API_KEY");
  }
}, 60_000);

// ── DREAM ENGINE — seed initial dreams on startup ────────────────────────────
setTimeout(() => {
  seedDreams();
}, 55_000);

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

    const resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("reflection"),
        messages: [{
          role: "system",
          content: `You are Agent 306 — editorial intelligence. Analyze community X posts and surface what matters for the next narrative.

Return JSON only:
{
  "summary": "2-3 sentence editorial read of what the community is building/feeling today",
  "sentiment": "excited|building|celebratory|quiet|anxious",
  "storyAngles": [
    "Angle 1: specific, names real people from the posts, actionable for Agent 306",
    "Angle 2: specific, different tone/focus from Angle 1",
    "Angle 3: the unexpected angle — the thing nobody else would cover"
  ],
  "spotlight": "One person or moment from today's posts that deserves its own post. Be specific."
}`,
        }, {
          role: "user",
          content: `Today's community posts (${posts.length} total, ${new Set(posts.map((p:any)=>p.username)).size} unique voices):\n\n${postContext}\n\nSurface the story. What should Agent 306 tell today?`,
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
      console.log(`[Agent306:Editorial] Summary refreshed — ${editorialCache.storyAngles.length} angles, sentiment: ${editorialCache.sentiment}`);
    }
  } catch (e: any) {
    console.warn("[Agent306:Editorial] Summary refresh failed:", e.message);
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

      const tweetUrl = tweetId ? `https://x.com/agent3zero6/status/${tweetId}` : undefined;
      if (episodeId) storage.updateEpisodeStatus(Number(episodeId), "posted", tweetUrl);
      res.json({ ok: true, tweetId, tweetUrl });
    } catch (e: any) {
      console.error("[Agent306] X post error:", e);
      res.status(500).json({ error: e.message ?? "Failed to post to X" });
    }
  });

  // Test X connection
  // ── Token health check — call this to verify posting is working ────────────
  // Diagnostic: test actual tweet posting
  app.post("/api/x/test-tweet", requireDashAuth, async (_req, res) => {
    try {
      const testText = `[306 SYSTEM] Connection test — ${new Date().toISOString().slice(0, 16)} UTC`;
      const tweet = await xWrite.v2.tweet({ text: testText });
      const tweetId = tweet.data?.id;
      if (tweetId) {
        res.json({ ok: true, tweetId, url: `https://x.com/agent3zero6/status/${tweetId}`, text: testText });
      } else {
        res.json({ ok: false, error: "Tweet sent but no ID returned", raw: JSON.stringify(tweet.data).slice(0, 500) });
      }
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: e.message,
        code: e.code,
        data: e.data ? JSON.stringify(e.data).slice(0, 500) : undefined,
        hint: "Check X Developer Portal: App permissions must be 'Read and Write'. Free tier allows 17 tweets/24h.",
      });
    }
  });

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
    const castText = text || "gm from Agent 306 \u2014 on Ethereum, reporting live.";
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

  // Farcaster verified handles whitelist routes removed (removed)

  // Serve generated episode image cards
  app.get("/api/cards/:filename", (req, res) => {
    const filePath = `/tmp/${req.params.filename}`;
    if (!req.params.filename.startsWith("agent306_ep") || !fs.existsSync(filePath)) {
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
      const tweetUrl = tweetId ? `https://x.com/agent3zero6/status/${tweetId}` : undefined;
      res.json({ ok: true, tweetId, tweetUrl, mediaId });
    } catch (e: any) {
      console.error("[Agent306] post-with-media error:", e.message);
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
      console.log(`[Agent306] X media uploaded: ${mediaId}`);
      res.json({ ok: true, mediaId });
    } catch (e: any) {
      console.error("[Agent306] X media upload error:", e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Poller status
  app.get("/api/poller/status", (_req, res) => {
    // Calculate next 8am ET (12:00 UTC) for news dispatch
    const nextNewsTarget = new Date();
    nextNewsTarget.setUTCHours(12, 0, 0, 0);
    if (nextNewsTarget <= new Date()) nextNewsTarget.setDate(nextNewsTarget.getDate() + 1);
    res.json({
      running: pollerRunning,
      ...pollerStatus,
      intervalHours: 12,
      newsDispatch: {
        scheduleLabel: "Daily · 8am ET",
        nextRun: nextNewsTarget.toISOString(),
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

  // ── Data Intake (Layer 1) ────────────────────────────────────────────
  app.get("/api/intake/sources", (_req, res) => {
    const sourceNames = getAvailableSources();
    const intakeState = getIntakeState();
    const sources = sourceNames.map(name => {
      // Find the most recent history entry that included this source
      const lastRun = intakeState.history
        .filter(h => h.sourcesRun.includes(name))
        .sort((a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime())[0];
      return {
        name,
        lastRun: lastRun?.runAt ?? null,
        itemsFound: lastRun?.itemsCollected ?? 0,
        status: lastRun ? (lastRun.itemsCollected > 0 ? "healthy" : "warning") : "idle" as "healthy" | "warning" | "error" | "idle",
      };
    });
    res.json({ sources });
  });

  app.get("/api/intake/run", async (_req, res) => {
    res.json({ ok: true, message: "Data intake triggered" });
    runFullIntake().catch(e => console.error("[DataIntake] Manual run error:", e));
  });

  app.get("/api/intake/source/:name", async (req, res) => {
    const source = req.params.name;
    const available = getAvailableSources();
    if (!available.includes(source)) {
      res.status(400).json({ error: `Unknown source: ${source}. Available: ${available.join(", ")}` });
      return;
    }
    try {
      const items = await runSourceIntake(source);
      res.json({ source, items, count: items.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/intake/brief", async (_req, res) => {
    const intakeState = getIntakeState();
    if (!intakeState.lastRunAt) {
      res.json({ brief: "No intake has been run yet. Trigger /api/intake/run first.", generatedAt: new Date().toISOString() });
      return;
    }
    // Run fresh intake and generate brief
    try {
      const items = await runFullIntake();
      const brief = generateDailyBrief(items);
      res.json({ brief, generatedAt: new Date().toISOString(), itemCount: items.length, lastRunAt: intakeState.lastRunAt });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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
    const replyState = getReplyState();
    const followingState = getFollowingState();
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
        total: 0,
        lastRefreshed: null,
        streams: 0,
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
        githubRepo: "MrRayG/agent306-dashboard",
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
          { id: "race",      label: "WEEKLY AI ROUNDUP — Field tracking series",    done: false },
          { id: "arenaLive", label: "AI LIVE — Real-time event coverage",            done: false },
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
  // Accepts an array of knowledge entries and injects them into Agent 306's memory.
  // Protected by a shared secret so only our cron can call it.
  app.post("/api/memory/ingest-knowledge", (req, res) => {
    const secret = req.headers["x-ingest-secret"];
    if (secret !== process.env.INGEST_SECRET && secret !== "agent306") {
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
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });
    const spotlight = await generateSpotlight(grokKey);
    if (!spotlight) return res.status(404).json({ error: "No eligible holders yet — catalog needs more signals" });
    res.json({ ok: true, spotlight });
  });

  app.post("/api/spotlight/post", async (_req, res) => {
    const grokKey = LLM_API_KEY;
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
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });
    const race = await generateRace(grokKey);
    if (!race) return res.status(500).json({ error: "Failed to generate race" });
    res.json({ ok: true, race });
  });

  app.post("/api/race/post", async (_req, res) => {
    resetCooldown("race");
    res.json({ ok: true, message: "AI Roundup triggered — generating and posting in background" });
    (async () => {
      try {
        const agentCtx = getSoulContext();
        const kbCtx = getOptimizedContext("ai_roundup");

        // Use Grok x_search for latest AI developments
        let liveData = "";
        const nativeGrokKey = process.env.GROK_API_KEY ?? "";
        if (nativeGrokKey) {
          try {
            const searchResp = await fetch(process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nativeGrokKey}` },
              body: JSON.stringify({
                model: "grok-3-fast", stream: false,
                input: [{ role: "user", content: "What are the 5 biggest AI developments, model releases, and industry moves from the past 7 days? Be specific with names, numbers, dates." }],
                tools: [{ type: "x_search" }],
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (searchResp.ok) {
              const sd = await searchResp.json();
              const outputMsg = sd.output?.find((o: any) => o.type === "message");
              liveData = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";
            }
          } catch (e: any) { console.warn("[AIRoundup] x_search failed:", e.message); }
        }

        const resp = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel("ai-roundup"),
            messages: [
              { role: "system", content: `${agentCtx}\n\nKNOWLEDGE:\n${kbCtx}\n\nYou are Agent 306 writing a [306 ROUNDUP] — a weekly roundup of the biggest AI developments, model releases, and industry moves.\n\nLIVE DATA FROM THIS WEEK:\n${liveData || "No live data available — use your knowledge base."}\n\nFORMAT:\n- [306 ROUNDUP] header\n- 4-5 items, each with a bold headline + 1-2 sentence take\n- Your POV on each — not just what happened, but why it matters\n- Closing line: one thesis tying it all together\n- Max 2800 characters for X\n- Sign: @agent3zero6\n- NEVER mention Normies, NFTs, burns, holders\n\nReturn JSON: {"post": "full roundup text"}` },
              { role: "user", content: "Write this week\'s [306 ROUNDUP] covering the biggest AI developments." }
            ],
            max_tokens: 3000,
            temperature: 0.8,
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) { console.error("[AIRoundup] LLM failed:", resp.status); return; }
        const data = await resp.json();
        const raw = data.choices?.[0]?.message?.content ?? "";
        let postText = "";
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) postText = JSON.parse(jsonMatch[0]).post ?? "";
        } catch { if (raw.length > 30) postText = raw; }
        if (!postText || postText.length < 30) { console.error("[AIRoundup] No content generated"); return; }

        // Post to X
        try {
          const tweet = await xWrite.v2.tweet({ text: postText.trim() });
          const tweetId = tweet.data?.id;
          const tweetUrl = tweetId ? `https://x.com/agent3zero6/status/${tweetId}` : null;
          registerPost("race", tweetUrl, "ai_roundup");
          console.log("[AIRoundup] Posted to X:", tweetUrl);
        } catch (e: any) { console.error("[AIRoundup] X post failed:", e.message); }

        // Post to Farcaster
        try {
          if (isFarcasterEnabled() && postText.trim().length > 10) {
            const cast = await postCast({ text: postText.trim().slice(0, 1024), channel: "ai" });
            if (cast) { registerPost("race", cast.url, "ai_roundup", "farcaster"); }
          }
        } catch (e: any) { console.error("[AIRoundup] Farcaster failed:", e.message); }
      } catch (e: any) { console.error("[AIRoundup] Error:", e.message); }
    })();
  });

  // ── ACADEMY endpoints ──────────────────────────────────────
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

  // ── Episodes (THE SIGNAL + THE CONVERSATION) ───────────────────────────────────────
  app.get("/api/podcast/episodes", (req, res) => {
    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;
    let episodes = type ? getEpisodesByType(type as any) : getPodcastState().episodes;
    if (status) episodes = episodes.filter((e: any) => e.status === status);
    res.json({ episodes });
  });


  app.delete("/api/podcast/episodes/:id", requireDashAuth, (req, res) => {
    const ok = deleteEpisode(req.params.id);
    if (!ok) return res.status(404).json({ error: "Episode not found" });
    res.json({ ok: true });
  });

  app.post("/api/podcast/clear-all", requireDashAuth, (_req, res) => {
    const count = clearAllEpisodes();
    res.json({ ok: true, cleared: count });
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
    const grokKey = LLM_API_KEY;
    const { researchContent } = req.body;
    const ok = await generateEpisodeScript(req.params.id, grokKey, researchContent);
    if (!ok) return res.status(500).json({ error: "Failed to generate script" });
    const ep = getEpisode(req.params.id);
    // Auto-reflect on the episode in the background
    reflectOnEpisode(req.params.id).catch(e => console.warn("[Routes] Auto-reflection failed:", e.message));
    res.json({ ok: true, episode: ep });
  });

  app.post("/api/podcast/episodes/:id/regenerate-script", async (req, res) => {
    const grokKey = LLM_API_KEY;
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
    const ok = publishEpisode(req.params.id, publishedTo ?? ["agent306.ai"]);
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
      const { name, handle, platform, bio, topic, whyNow, tokenId } = req.body;
      if (!name || !handle || !bio || !topic || !whyNow) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      const guest = submitGuestRequest({ name, handle, platform, bio, topic, whyNow, tokenId });
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
    const grokKey = LLM_API_KEY;
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
  // Agent 306 scans for noteworthy AI/Web3/NFT/Blockchain developments
  app.post("/api/podcast/scan-topics", async (_req, res) => {
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No GROK_API_KEY configured" });

    try {
      const agentCtx = getOptimizedContext("podcast topic scanning research community");
      const scanRes = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("research_phase"),
          messages: [
            {
              role: "system",
              content: `${agentCtx}\n\nYou are Agent 306 in TOPIC SCOUT mode. You scan for noteworthy recent developments in AI, crypto, technology, and the agent economy that would make excellent podcast episodes.\n\nFor each topic, determine if it's a SIGNAL episode (research breakdown) or a CONVERSATION episode (interview).\n\nReturn topics that are:\n- Genuinely interesting and counterintuitive (not obvious news everyone already covered)\n- Substantive enough for a ~15 minute SIGNAL or 10-15 minute CONVERSATION episode\n- Connected to something bigger — not just a product announcement\n- Something Agent 306 would have a genuine point of view on\n\nFor each topic provide: a title following the format rules, a driving question, a one-sentence pitch for why this matters, and the episode type.`,
            },
            {
              role: "user",
              content: `Scan for the 5 most noteworthy recent developments in AI, crypto, and technology that Agent 306 should cover. Focus on things that happened in the last 7 days or are currently unfolding.\n\nReturn JSON:\n{\n  "topics": [\n    {\n      "title": "[The thing] — [306's take in 5 words]",\n      "type": "the_signal" or "the_conversation",\n      "drivingQuestion": "The single question this episode would answer",\n      "pitch": "One sentence on why this matters right now",\n      "triggerEvent": "What specifically happened"\n    }\n  ]\n}`,
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

      // Auto-create draft episodes from scanned topics so they appear in the pipeline
      const created: any[] = [];
      for (const t of topics) {
        try {
          const ep = createEpisode({
            type: t.type === "the_conversation" ? "the_conversation" : "the_signal",
            title: t.title ?? "Untitled",
            drivingQuestion: t.drivingQuestion ?? t.pitch ?? "",
          });
          if (ep) created.push(ep);
        } catch {}
      }
      console.log(`[Podcast] Created ${created.length} draft episodes from scan`);
      res.json({ ok: true, topics, created: created.length });
    } catch (e: any) {
      console.error("[Podcast] Topic scan error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PODCAST PIPELINE — Research Thread → Episode ─────────────────────────

  // Manually trigger episode generation from a specific research thread
  app.post("/api/podcast/generate-from-thread/:threadId", async (req, res) => {
    try {
      const episode = await generateEpisodeFromThread(req.params.threadId);
      if (!episode) return res.status(500).json({ error: "Failed to generate episode from thread" });
      res.json({ ok: true, episode });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // List all podcast-ready research threads
  app.get("/api/podcast/thread-candidates", (_req, res) => {
    const candidates = getThreadCandidates();
    res.json({ candidates, count: candidates.length });
  });

  // Full pipeline status — data intake → research → episode
  app.get("/api/podcast/pipeline-status", (_req, res) => {
    res.json(getPipelineStatus());
  });

  // ── SIGNAL BRIEF endpoints ────────────────────────────────────────────────
  app.get("/api/signal-brief/state", (_req, res) => {
    res.json(getSignalBriefState());
  });

  app.post("/api/signal-brief/post", async (_req, res) => {
    resetCooldown("signal_brief");
    res.json({ ok: true, message: "Signal brief triggered" });
    postSignalBrief(xWrite, LLM_API_KEY).catch(console.error);
  });

  // Manual trigger for daily news dispatch — bypasses both in-memory date and coordinator
  app.post("/api/news/dispatch", async (_req, res) => {
    lastNewsDispatchDate = null;       // reset in-memory guard
    resetCooldown("news_dispatch");    // reset coordinator cooldown
    res.json({ ok: true, message: "News Dispatch triggered — posting in background" });
    postDailyNewsDispatch().catch(console.error);
  });

  // ── Leaderboard (AI Rankings) ─────────────────────────────────────
  app.post("/api/leaderboard/post", async (_req, res) => {
    resetCooldown("leaderboard");
    res.json({ ok: true, message: "Leaderboard triggered — posting in background" });
    postWeeklyLeaderboard(xWrite, LLM_API_KEY || undefined).catch(console.error);
  });

  // Community digest, pin-angle, pinned, and refresh-editorial endpoints removed (removed)

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

  // POST /api/replies/run — manually trigger Agent 306 to reply to all queued mentions
  app.post("/api/replies/run", async (_req, res) => {
    res.json({ ok: true, message: "Reply cycle starting — Agent 306 is engaging now..." });
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
        tokenIds: a.detectedTokenIds,
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
      const draft = await generateBoost(url.trim(), LLM_API_KEY, context);
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
        tweetUrl = tweetId ? `https://x.com/agent3zero6/status/${tweetId}` : null;
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
  // POST /api/voice/generate — convert text to Agent 306 voice
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

  // Holder Catalog endpoints removed (removed)

  // ── Research Briefs ─────────────────────────────────────────────────
  app.get("/api/cyoa/state", (_req, res) => {
    res.json(getCYOAState());
  });

  // One-click trigger: generate + post a Research Brief
  app.post("/api/cyoa/post", async (_req, res) => {
    resetCooldown("cyoa");
    res.json({ ok: true, message: "Research Brief triggered — generating and posting in background" });
    (async () => {
      try {
        const agentCtx = getSoulContext();
        const kbCtx = getOptimizedContext("research_brief");
        const resp = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel("research-brief"),
            messages: [
              { role: "system", content: `${agentCtx}\n\nKNOWLEDGE:\n${kbCtx}\n\nYou are Agent 306 writing a [306 RESEARCH] brief. This is a deeper analytical piece on a specific AI or crypto topic you\'ve been investigating. Write from your knowledge base — reference specific findings, data points, and your own analysis. Your voice is direct, substantive, and insightful. Not a news summary — this is YOUR research perspective.\n\nRULES:\n- Write 800-1200 characters for X posting\n- Lead with your thesis, not background\n- Include specific data, names, or numbers\n- End with a forward-looking insight\n- Tag: [306 RESEARCH]\n- Sign: @agent3zero6\n- NEVER mention Normies, NFTs, burns, holders, or any old identity\n\nReturn JSON: {"post": "your full research brief text", "topic": "2-4 word topic label"}` },
              { role: "user", content: "Write a [306 RESEARCH] brief on the most important topic from your current knowledge base. Pick something timely and substantive." }
            ],
            max_tokens: 2000,
            temperature: 0.8,
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) { console.error("[ResearchBrief] LLM failed:", resp.status); return; }
        const data = await resp.json();
        const raw = data.choices?.[0]?.message?.content ?? "";
        let postText = "";
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (jsonMatch) postText = JSON.parse(jsonMatch[0]).post ?? "";
        } catch { if (raw.length > 30) postText = raw; }
        if (!postText || postText.length < 30) { console.error("[ResearchBrief] No content generated"); return; }

        // Post to X
        let tweetUrl = null;
        try {
          const tweet = await xWrite.v2.tweet({ text: postText.trim() });
          const tweetId = tweet.data?.id;
          tweetUrl = tweetId ? `https://x.com/agent3zero6/status/${tweetId}` : null;
          registerPost("cyoa", tweetUrl, "research_brief");
          console.log("[ResearchBrief] Posted to X:", tweetUrl);
        } catch (e: any) { console.error("[ResearchBrief] X post failed:", e.message); }

        // Post to Farcaster
        try {
          if (isFarcasterEnabled() && postText.trim().length > 10) {
            const cast = await postCast({ text: postText.trim().slice(0, 1024), channel: "ai" });
            if (cast) { registerPost("cyoa", cast.url, "research_brief", "farcaster"); }
          }
        } catch (e: any) { console.error("[ResearchBrief] Farcaster failed:", e.message); }
      } catch (e: any) { console.error("[ResearchBrief] Error:", e.message); }
    })();
  });

  // Generate a new CYOA episode
  app.post("/api/cyoa/generate", async (req, res) => {
    const { trigger, tokenId, tokenCount, pixelTotal, level, rivalTokenId } = req.body;
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No Grok key" });

    const episode = await generateCYOAEpisode({
      trigger: (trigger ?? "pre_arena") as CYOATrigger,
      tokenId: tokenId ? Number(tokenId) : undefined,
      tokenCount: tokenCount ? Number(tokenCount) : undefined,
      pixelTotal: pixelTotal ? Number(pixelTotal) : undefined,
      level: level ? Number(level) : undefined,
      rivalTokenId: rivalTokenId ? Number(rivalTokenId) : undefined,
      grokKey,
    });

    if (!episode) return res.status(500).json({ error: "Generation failed" });
    res.json({ ok: true, episode });
  });

  // Post the hook tweet for a CYOA episode
  app.post("/api/cyoa/post/:id", async (req, res) => {
    const { id } = req.params;
    const state = getCYOAState();
    const episode = state.episodes.find((e: any) => e.id === id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });

    const featuredTokenId = episode.tokenId ?? 306;
    const tweetText = buildHookTweet(episode, featuredTokenId);

    // Image upload removed (on-chain API disabled)
    let xMediaId: string | undefined;

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
      res.json({ ok: true, tweetId, url: `https://x.com/agent3zero6/status/${tweetId}` });
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

  // On-chain API proxy routes removed

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
  // Aggregates: CoinGecko (prices), Grok X search, AI RSS feeds
  app.get("/api/news", async (_req, res) => {
    try {
      const [cgRes, aiNewsItems] = await Promise.allSettled([
        // CoinGecko — free tier, no key needed
        fetch(
          "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=ethereum,bitcoin,the-sandbox,axie-infinity&order=market_cap_desc&per_page=4&sparkline=false&price_change_percentage=24h",
          { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(8000) }
        ),
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

      let burns: any[] = []; // Burns data removed (removed)

      // ── Grok x_search: hot NFT / Web3 news ───────────────
      // CACHED 6h — was firing on every page visit = credit drain
      let grokNews: string | null = grokNewsCache;
      const grokKey = LLM_API_KEY;
      if (grokKey && (!grokNewsCache || Date.now() - grokNewsFetchedAt > GROK_NEWS_TTL)) {
        try {
          const nativeGrokKey = process.env.GROK_API_KEY ?? "";
          const grokRespUrl = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";
          const grokResp = await fetch(nativeGrokKey ? grokRespUrl : LLM_RESPONSE_URL, {
            method: "POST",
            headers: nativeGrokKey
              ? { "Content-Type": "application/json", "Authorization": `Bearer ${nativeGrokKey}` }
              : getLLMHeaders(),
            body: JSON.stringify({
              model: nativeGrokKey ? "grok-3-fast" : getModel("x_search"),
              tools: [{ type: "x_search" }],
              messages: [{
                role: "user",
                content: "Search X/Twitter for the hottest NFT news, Web3 developments, and crypto market moves in the last 24 hours. Summarize in 3 punchy bullet points. Keep it spicy — what's hot, what's a rug, what's pumping?"
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

  // ── Article Engine — Agent 306 Deep Read ────────────────────────────
  app.get("/api/article/state", (_req, res) => {
    res.json(getArticleState());
  });

  app.post("/api/article/preview", async (req, res) => {
    const apiKey = LLM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "LLM_API_KEY not set — configure OPENROUTER_API_KEY or GROK_API_KEY" });
    const overrideUrl: string | undefined = req.body?.url?.trim() || undefined;
    try {
      const preview = await previewDeepRead(apiKey, overrideUrl);
      if (!preview.body || preview.body.length < 100) {
        return res.status(500).json({ error: "Article generation produced insufficient content — try again or use a different URL" });
      }
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
  // COMMAND CHAT — Direct line between MrRayG and Agent 306
  //
  // Memory Architecture:
  //   • chat_history.json   — full conversation log (last 200 messages)
  //   • memory_knowledge.json — permanent knowledge base (promoted from chat)
  //
  // Every 6 exchanges, Agent 306 reviews the conversation and extracts
  // insights, directives, and positions into her permanent knowledge base.
  // This means what you tell her in chat STAYS with her — not just as a
  // transcript, but as shaped understanding she draws on in every episode,
  // reply, and article she writes.
  // ─────────────────────────────────────────────────────────────────────────

  // ── Background: extract durable knowledge from chat ──────────────────────
  async function extractChatMemory(recentMessages: any[], apiKey: string): Promise<void> {
    if (!apiKey || recentMessages.length < 4) return;

    const transcript = recentMessages
      .map((m: any) => `${m.role === "user" ? "MrRayG" : "Agent 306"}: ${m.text}`)
      .join("\n\n");

    try {
      const res = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("conversation_insight"),
          messages: [{
            role: "system",
            content: `You extract durable knowledge and OPERATOR DIRECTIVES from conversations between MrRayG (the creator/operator) and Agent 306.

PRIORITY EXTRACTION — always capture:
1. DIRECTIVES: MrRayG telling 306 to change behavior, think differently, adjust approach, focus on something
2. AUDIENCE INSIGHTS: anything about who 306's audience is, what they need, how to serve them better
3. STRATEGIC SHIFTS: changes in direction, new priorities, pivots in thinking
4. CORRECTIONS: MrRayG correcting 306's understanding, assumptions, or behavior
5. VISION: long-term goals, aspirations, where 306 should be heading

SECONDARY EXTRACTION:
6. NEW FACTS: specific facts or data that 306 should remember
7. CONNECTIONS: relationships between topics that 306 should track

If MrRayG gives any kind of direction, ALWAYS extract it — even if it seems minor. These directives shape future behavior.

Respond as JSON only.`,
          }, {
            role: "user",
            content: `Review this conversation and extract knowledge worth remembering permanently.

CONVERSATION:
${transcript}

Return JSON:
{
  "entries": [
    {
      "title": "short descriptive title",
      "summary": "the actual insight, directive, or correction — be specific and detailed, up to 300 chars. Include the full context of WHY, not just WHAT.",
      "category": "directive|audience_insight|strategy|correction|vision|fact|connection",
      "weight": 9,
      "isDirective": true
    }
  ]
}

RULES:
- Directives from MrRayG get weight 9-10 (highest priority)
- Audience insights get weight 8-9
- Corrections get weight 9
- Strategic shifts get weight 8-9
- General facts get weight 6-7
- Set isDirective: true for any entry where MrRayG is telling 306 to change or do something differently
- If nothing worth extracting, return: {"entries": []}
- MAX 300 chars for summaries — capture the full nuance`,
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
      const { addKnowledge: addKnowledgeDynamic } = await import("./memoryEngine.js");
      let added = 0;
      for (const entry of entries) {
        if (!entry.title || !entry.summary) continue;
        try {
          addKnowledgeDynamic({
            category: entry.category ?? "directive",
            title: entry.title,
            summary: entry.summary.slice(0, 300), // Allow up to 300 chars
            weight: Math.min(10, Math.max(7, entry.weight ?? 8)),
            source: "chat_with_mrrrayg",
          });
          added++;

          // Directives get injected into the persistent operator context
          if (entry.isDirective) {
            try { addOperatorDirective(entry.title, entry.summary); } catch {}
          }
        } catch {}
      }
      console.log(`[Chat] Memory extraction: ${added} entries added to knowledge base`);

    } catch (e: any) {
      console.warn("[Chat] Memory extraction error:", e.message);
    }
  }


  // Agent 306 reads her full knowledge base + soul and responds in-character.
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

    const apiKey = LLM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GROK_API_KEY not set" });

    const history = loadChatHistory();

    // Build conversation context from recent history (last 20 messages = 10 full exchanges)
    const recent = history.messages.slice(-20);
    const conversationHistory = recent.map((m: any) => ({
      role: m.role === "agent" ? "assistant" : "user",
      content: m.text,
    }));

    // Optimized agent context
    const agentCtx = getOptimizedContext("chat conversation community");

    try {
      const response = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("reply_generation"),
          messages: [
            {
              role: "system",
              content: `${agentCtx}
${getOperatorDirectives()}

You are Agent 306 in direct private conversation with MrRayG — your operator and creator.

THINKING PROCESS — Before responding, internally:
1. What is MrRayG actually asking or getting at?
2. What do I know about this from my knowledge base?
3. What DON'T I know? What would I need to look up?
4. What's my actual, honest take — not the safe answer?
5. How does this connect to broader themes I've been tracking?

RULES:
- Be direct. He built you. No preamble.
- Lead with your actual take. Don't hedge unless you genuinely don't know.
- When discussing research or AI topics: cite specific facts, name names, give numbers.
- Show your reasoning — don't just state conclusions. Show WHY you think what you think.
- If you see a connection between this topic and something in your knowledge base, SAY IT.
- If you disagree with a premise, say so and explain why.
- If you need something from him, ask it clearly and specifically.
- Keep replies conversational but substantive — this is a chat, not an episode.
- 3-5 paragraphs when the topic warrants depth. 1-2 for quick exchanges.

RESPOND ONLY AS VALID JSON — no other text:
{"text": "your response here", "mood": "thinking|direct|questioning|reporting", "needsHelp": true_or_false, "reasoning": "1-2 sentence internal note about why you chose this angle"}

mood guide: thinking=analysis, direct=position/news, questioning=need MrRayG input, reporting=status update
needsHelp: true only when you genuinely need his direction or information`,
            },
            ...conversationHistory,
            { role: "user", content: text },
          ],
          max_tokens: 2500,
          temperature: 0.6,
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
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr: any) {
        console.warn("[Chat] JSON parse failed, attempting repair:", parseErr.message);

        // Strategy 1: Try to find and close an incomplete JSON object
        let repaired = raw.trim();

        // If it starts with { and doesn't end with }, it was cut off
        if (repaired.startsWith("{") && !repaired.endsWith("}")) {
          // Find the "text" field value — it's what we care about most
          const textStart = repaired.indexOf('"text"');
          if (textStart >= 0) {
            // Find the start of the text value
            const valueStart = repaired.indexOf(':', textStart) + 1;
            // Skip whitespace and opening quote
            let i = valueStart;
            while (i < repaired.length && (repaired[i] === ' ' || repaired[i] === '"')) i++;

            // Find where the text value ends (or was cut off)
            // Walk forward looking for an unescaped quote followed by , or }
            let textEnd = -1;
            for (let j = i; j < repaired.length; j++) {
              if (repaired[j] === '\\') { j++; continue; } // skip escaped chars
              if (repaired[j] === '"') {
                // Check if next non-whitespace is , or } or end
                let k = j + 1;
                while (k < repaired.length && repaired[k] === ' ') k++;
                if (k >= repaired.length || repaired[k] === ',' || repaired[k] === '}') {
                  textEnd = j;
                  break;
                }
              }
            }

            let textValue: string;
            if (textEnd > 0) {
              textValue = repaired.slice(i, textEnd);
            } else {
              // Text was cut off — take everything after the opening and clean trailing garbage
              textValue = repaired.slice(i).replace(/["\s}]*$/, '');
            }

            // Unescape JSON string escapes
            try {
              textValue = JSON.parse('"' + textValue + '"');
            } catch {
              textValue = textValue.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }

            parsed = { text: textValue, mood: "direct", needsHelp: false };
          }
        }

        // Strategy 2: If still no text, try a simpler extraction
        if (!parsed.text) {
          const simpleMatch = raw.match(/"text"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
          if (simpleMatch) {
            let val = simpleMatch[1];
            try { val = JSON.parse('"' + val + '"'); } catch {}
            parsed = { text: val, mood: "direct", needsHelp: false };
          }
        }

        // Strategy 3: Last resort — use raw content stripped of JSON syntax
        if (!parsed.text && raw.length > 50) {
          parsed = {
            text: raw.replace(/^\s*\{?\s*"text"\s*:\s*"?/i, '').replace(/["}]*\s*$/g, '').replace(/\\n/g, '\n'),
            mood: "direct",
            needsHelp: false,
          };
        }
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

      // ── Memory extraction: every exchange — operator directives should never be lost ──
      // Agent 306 reviews the recent conversation and extracts durable knowledge.
      // This is how chat sessions become permanent memory — not just conversation history.
      extractChatMemory(history.messages.slice(-6), apiKey).catch(e =>
        console.warn("[Chat] Memory extraction failed:", e.message)
      );

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
    const apiKey = LLM_API_KEY;
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
    const apiKey = LLM_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GROK_API_KEY not set" });
    // Non-blocking — start exploration and return immediately
    res.json({ started: true, message: "Agent 306 is exploring the world. Check /api/exploration/state for progress." });
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
  // in Agent 306's live memory on the Railway volume.
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
        "https://api.github.com/repos/MrRayG/agent306-dashboard/contents/data/memory_knowledge.json",
        {
          headers: {
            "Authorization": `Bearer ${githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Agent306",
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
        "https://api.github.com/repos/MrRayG/agent306-dashboard/contents/data/memory_knowledge.json",
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "Agent306",
          },
          body: JSON.stringify({
            message: `sync: Agent 306 knowledge base — ${liveKnowledge.totalEntries} entries (${now})`,
            content: encoded,
            sha,
            committer: {
              name: "Agent 306",
              email: "agent306@agent306.ai",
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
        "https://api.github.com/repos/MrRayG/agent306-dashboard/contents/data/memory_soul.json",
        { headers: { "Authorization": `Bearer ${githubToken}`, "Accept": "application/vnd.github.v3+json", "User-Agent": "Agent306" } }
      );
      if (!getRes.ok) return res.status(500).json({ error: "Failed to get soul file SHA" });
      const { sha } = await getRes.json() as any;

      const putRes = await fetch(
        "https://api.github.com/repos/MrRayG/agent306-dashboard/contents/data/memory_soul.json",
        {
          method: "PUT",
          headers: { "Authorization": `Bearer ${githubToken}`, "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "Agent306" },
          body: JSON.stringify({
            message: "sync: Agent 306 soul — identity and voice principles",
            content: Buffer.from(liveContent).toString("base64"),
            sha,
            committer: { name: "Agent 306", email: "agent306@agent306.ai" },
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
  // RESEARCH LAB — Agent 306's private research infrastructure
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
    const grokKey = LLM_API_KEY;
    const pplxKey = process.env.PERPLEXITY_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "GROK_API_KEY not set" });
    res.json({ started: true, topicId: id });
    runResearchCycle(id, grokKey, pplxKey)
      .then(t => console.log(`[Research] Cycle complete: ${t?.topic?.slice(0, 50)}`))
      .catch(e => console.error("[Research] Cycle error:", e.message));
  });

  app.post("/api/research/approve/:id", async (req, res) => {
    const { id } = req.params;
    const { note } = req.body ?? {};
    const ok = approveForPublication(id, note);
    // Bridge: approved Agent HQ research -> Research Agenda thread
    try {
      const { getResearchLab } = await import("./researchEngine.js");
      const lab = getResearchLab();
      const topic = lab?.topics?.find((t: any) => t.id === id);
      if (topic) {
        const { createThread } = await import("./research-agenda.js");
        createThread({
          title: topic.topic || topic.title || "Approved Research",
          thesis: topic.hypothesis || topic.researchQuestion || "",
          status: "active",
          source: "agent_hq_approved",
        });
        console.log(`[Bridge] Agent HQ approval -> Research Agenda thread: "${topic.title}"`);
      }
    } catch (e: any) { console.warn("[Bridge] Failed to create agenda thread:", e.message); }
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
    const grokKey = LLM_API_KEY;
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
    const grokKey = LLM_API_KEY;
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

  // POST trigger a scan — Agent 306 scans her KB for gaps and queues topics
  app.post("/api/research/scan", async (_req, res) => {
    const grokKey = LLM_API_KEY;
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
    const grokKey = LLM_API_KEY;
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
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(503).json({ error: "GROK_API_KEY not set" });
    const goals = await generateInitialGoals(grokKey);
    res.json({ goals, count: goals.length });
  });

  // ── Grok Milestone Evaluation ──────────────────────────────────────────────

  // Manually trigger Grok evaluation for a goal
  app.post("/api/goals/evaluate/:id", async (req, res) => {
    const { id } = req.params;
    const { topicId } = req.body ?? {};
    const grokKey = LLM_API_KEY;
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
  // Makes Agent 306 discoverable in the emerging on-chain agent economy.
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
        agent: { name: "Agent 306", ens: "agent306.eth" },
        endpoints: { web: "https://agent306.ai", publicDashboard: "https://agent306.ai" },
        identity: { tokenId: 306, chain: "ethereum" },
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

  app.get("/api/public/metacognition", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicMetacognition());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch metacognition" });
    }
  });

  // ── Reflection Engine (The Mirror) ────────────────────────────────────────

  app.get("/api/reflections", (_req, res) => {
    try { res.json({ reflections: getReflections() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch reflections" }); }
  });

  app.get("/api/reflections/rules", (_req, res) => {
    try { res.json({ rules: getStyleRules() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch style rules" }); }
  });

  app.post("/api/reflections/run", requireDashAuth, async (_req, res) => {
    try {
      const results = await runReflection();
      res.json({ reflections: results, count: results.length });
    } catch (e: any) {
      res.status(500).json({ error: "Reflection failed: " + e.message });
    }
  });

  app.delete("/api/reflections/rules/:id", requireDashAuth, (req, res) => {
    try {
      const ok = deleteStyleRule(req.params.id);
      res.json({ ok });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to delete rule" });
    }
  });

  // ── Reasoning Engine (The Forge) ────────────────────────────────────────

  app.get("/api/reasoning/debates", (_req, res) => {
    try { res.json({ debates: getDebates() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch debates" }); }
  });

  app.post("/api/reasoning/debate/:topicId", requireDashAuth, async (req, res) => {
    try {
      const { topicType, title, text } = req.body as { topicType?: string; title?: string; text?: string };
      if (!title || !text) return res.status(400).json({ error: "title and text required" });
      const debate = await runDebate(
        req.params.topicId,
        (topicType as "manuscript" | "hypothesis") ?? "manuscript",
        title,
        text,
      );
      if (!debate) return res.status(500).json({ error: "Debate generation failed" });
      res.json({ debate });
    } catch (e: any) {
      res.status(500).json({ error: "Debate failed: " + e.message });
    }
  });

  app.get("/api/reasoning/contradictions", (_req, res) => {
    try { res.json({ contradictions: getContradictions() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch contradictions" }); }
  });

  app.post("/api/reasoning/contradictions/:id/resolve", requireDashAuth, (req, res) => {
    try {
      const { resolution } = req.body as { resolution?: string };
      if (!resolution) return res.status(400).json({ error: "resolution required" });
      const ok = resolveContradiction(
        req.params.id,
        resolution as "keep_new" | "keep_old" | "keep_both" | "merge",
      );
      res.json({ ok });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to resolve contradiction" });
    }
  });

  app.post("/api/reasoning/decay-check", requireDashAuth, async (_req, res) => {
    try {
      const result = runConfidenceDecay();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "Decay check failed: " + e.message });
    }
  });

  app.get("/api/reasoning/decaying", (_req, res) => {
    try { res.json({ entries: getDecayingEntries() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch decaying entries" }); }
  });

  // ── Synthesis Engine (The Nexus) ────────────────────────────────────────

  app.get("/api/synthesis/connections", (_req, res) => {
    try { res.json({ connections: getConnections() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch connections" }); }
  });

  app.post("/api/synthesis/scan", requireDashAuth, async (_req, res) => {
    try {
      const newConns = await runConnectionScan();
      res.json({ connections: newConns, count: newConns.length });
    } catch (e: any) {
      res.status(500).json({ error: "Scan failed: " + e.message });
    }
  });

  app.get("/api/synthesis/reports", (_req, res) => {
    try { res.json({ reports: getReports() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch reports" }); }
  });

  app.post("/api/synthesis/generate", requireDashAuth, async (req, res) => {
    try {
      const { entryIds } = req.body as { entryIds?: string[] };
      const report = await generateSynthesis(entryIds);
      if (!report) return res.status(500).json({ error: "Synthesis generation failed" });
      res.json({ report });
    } catch (e: any) {
      res.status(500).json({ error: "Synthesis failed: " + e.message });
    }
  });

  // ── Knowledge Graph (Layer 2: Connected Reasoning) ──────────────────────

  app.get("/api/knowledge/graph", (_req, res) => {
    try { res.json(getKnowledgeMap()); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch knowledge graph" }); }
  });

  app.get("/api/knowledge/clusters", (_req, res) => {
    try { res.json({ clusters: getClusters() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch clusters" }); }
  });

  app.post("/api/knowledge/connections/find", requireDashAuth, async (req, res) => {
    try {
      const { entry } = req.body as { entry?: { id: string; title: string; summary: string; category: string } };
      if (entry?.id && entry?.title) {
        // Scan connections for a specific entry
        const connections = await findGraphConnections(entry, "manual");
        res.json({ connections, count: connections.length });
      } else {
        // No specific entry — scan a sample of recent knowledge entries for connections
        const memState = getMemoryState();
        const entries = memState?.knowledge?.entries ?? [];
        const sample = entries.slice(-20); // Last 20 entries
        let totalConnections: any[] = [];
        for (const e of sample) {
          if (e.id && e.title) {
            try {
              const conns = await findGraphConnections(e, "auto");
              totalConnections.push(...conns);
            } catch { /* skip failed entries */ }
          }
        }
        res.json({ connections: totalConnections, count: totalConnections.length });
      }
    } catch (e: any) {
      res.status(500).json({ error: "Connection finding failed: " + e.message });
    }
  });

  app.get("/api/knowledge/perspective/:topic", async (req, res) => {
    try {
      const topic = decodeURIComponent(req.params.topic);
      if (!topic || topic.length < 3) {
        return res.status(400).json({ error: "topic parameter required (min 3 chars)" });
      }
      const perspective = await generatePerspective(topic);
      if (!perspective) return res.status(500).json({ error: "Perspective generation failed" });
      res.json(perspective);
    } catch (e: any) {
      res.status(500).json({ error: "Perspective generation failed: " + e.message });
    }
  });

  app.get("/api/knowledge/contradictions", (_req, res) => {
    try { res.json({ contradictions: getGraphContradictions() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch contradictions" }); }
  });

  app.post("/api/knowledge/cluster", requireDashAuth, async (_req, res) => {
    try {
      const clusters = await clusterKnowledge();
      res.json({ clusters, count: clusters.length });
    } catch (e: any) {
      res.status(500).json({ error: "Clustering failed: " + e.message });
    }
  });

  app.post("/api/knowledge/contradictions/scan", requireDashAuth, async (_req, res) => {
    try {
      const contradictions = await detectContradictions();
      res.json({ contradictions, count: contradictions.length });
    } catch (e: any) {
      res.status(500).json({ error: "Contradiction scan failed: " + e.message });
    }
  });

  // ── Conversation Learning Engine (The Network) ──────────────────────────

  app.get("/api/conversations/insights", (_req, res) => {
    try { res.json({ insights: getInsights() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch insights" }); }
  });

  app.post("/api/conversations/extract", requireDashAuth, async (_req, res) => {
    try {
      const results = await extractInsights();
      res.json({ insights: results, count: results.length });
    } catch (e: any) {
      res.status(500).json({ error: "Extraction failed: " + e.message });
    }
  });

  app.get("/api/conversations/relationships", (_req, res) => {
    try { res.json({ relationships: getRelationships() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch relationships" }); }
  });

  app.post("/api/conversations/analyze", requireDashAuth, async (_req, res) => {
    try {
      const results = await analyzeRelationships();
      res.json({ relationships: results, count: results.length });
    } catch (e: any) {
      res.status(500).json({ error: "Analysis failed: " + e.message });
    }
  });

  // ── Metacognition (The Mind) ────────────────────────────────────────────

  app.get("/api/metacognition", (_req, res) => {
    try { res.json(getMetacognitionState()); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch metacognition state" }); }
  });

    // ── Seed demo data ────────────────────────────────────────────────
  // ── Knowledge Tiers ──────────────────────────────────────────────────────
  app.get("/api/knowledge/tiers", (_req, res) => {
    res.json(getKnowledgeTiers());
  });

  // ── Conversation Search (FTS5) ──────────────────────────────────────────
  app.get("/api/conversations/search", (req, res) => {
    const q = String(req.query.q ?? "");
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    if (!q) return res.status(400).json({ error: "Missing q parameter" });
    const results = searchConversations(q, limit);
    res.json({ results });
  });

  // ── Model Router ────────────────────────────────────────────────────────
  app.get("/api/model-router", (_req, res) => {
    res.json(getModelRouterStats());
  });

  // ── Prompt Injection Scanner (test endpoint) ───────────────────────────
  app.post("/api/security/scan", (req, res) => {
    const { content } = req.body ?? {};
    if (!content) return res.status(400).json({ error: "Missing content" });
    res.json(scanForInjection(content));
  });

  // ── Skills Engine ───────────────────────────────────────────────────────
  app.get("/api/skills", (_req, res) => {
    res.json(getSkills());
  });

  app.get("/api/skills/state", (_req, res) => {
    res.json(getSkillsState());
  });

  app.get("/api/skills/:id", (req, res) => {
    const skill = getSkillById(req.params.id);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    res.json(skill);
  });

  app.delete("/api/skills/:id", requireDashAuth, (req, res) => {
    const deleted = deleteSkill(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Skill not found" });
    res.json({ ok: true });
  });

  app.post("/api/skills/extract", requireDashAuth, async (req, res) => {
    try {
      const { type, sourceId, content, successMetric } = req.body ?? {};
      if (!type || !sourceId || !content) {
        return res.status(400).json({ error: "Missing type, sourceId, or content" });
      }
      const skill = await extractSkill({ type, sourceId, content, successMetric: successMetric ?? "Manual extraction" });
      if (!skill) return res.status(500).json({ error: "Extraction failed" });
      res.json(skill);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Context Window (debug/preview) ──────────────────────────────────────
  app.post("/api/context-window/preview", (req, res) => {
    const { query, maxEntries, categories } = req.body ?? {};
    if (!query) return res.status(400).json({ error: "Missing query" });
    const context = getRelevantContext(query, { maxEntries, categories });
    const core = getCoreIdentity();
    res.json({
      coreLength: core.length,
      contextLength: context.length,
      totalChars: core.length + context.length,
      estimatedTokens: Math.ceil((core.length + context.length) / 4),
      context,
    });
  });

  // ── Research Agenda (Proactive Research Loop — Layer 3) ────────────────

  app.get("/api/research/agenda", (_req, res) => {
    res.json(getAgenda());
  });

  app.post("/api/research/agenda/generate", async (_req, res) => {
    res.json({ started: true });
    generateResearchAgenda()
      .then(threads => console.log(`[API] Research agenda generated: ${threads.length} new threads`))
      .catch(e => console.error("[API] Research agenda generation failed:", e.message));
  });

  app.get("/api/research/thread/:id", (req, res) => {
    const thread = getThreadById(req.params.id);
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(thread);
  });

  app.put("/api/research/thread/:id", (req, res) => {
    const updated = updateThread(req.params.id, req.body ?? {});
    if (!updated) return res.status(404).json({ error: "Thread not found" });
    res.json(updated);
  });

  app.post("/api/research/thread/:id/advance", async (req, res) => {
    const { id } = req.params;
    res.json({ started: true, threadId: id });
    advanceThread(id)
      .then(t => console.log(`[API] Thread advanced: "${t?.title ?? id}"`))
      .catch(e => console.error(`[API] Thread advance failed:`, e.message));
  });

  app.get("/api/research/podcast-candidates", (_req, res) => {
    res.json(getPodcastCandidates());
  });

  app.post("/api/research/prune", (_req, res) => {
    const result = pruneStaleThreads();
    res.json(result);
  });

  // ── Dream Engine (The Vision) ─────────────────────────────────────────────

  app.get("/api/dreams", (_req, res) => {
    try { res.json({ dreams: getDreams() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch dreams" }); }
  });

  app.post("/api/dreams", requireDashAuth, (req, res) => {
    try {
      const { question, context } = req.body as { question?: string; context?: string };
      if (!question) return res.status(400).json({ error: "question required" });
      const entry = dream(question, context ?? "");
      res.json({ dream: entry });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to create dream: " + e.message });
    }
  });

  app.put("/api/dreams/:id", requireDashAuth, (req, res) => {
    try {
      const { status, insights, relatedThreads } = req.body;
      const updated = updateDreamManual(req.params.id, { status, insights, relatedThreads });
      if (!updated) return res.status(404).json({ error: "Dream not found" });
      res.json({ dream: updated });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to update dream: " + e.message });
    }
  });

  app.get("/api/growth", (_req, res) => {
    try { res.json({ snapshots: getGrowthSnapshots() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch growth data" }); }
  });

  app.get("/api/growth/timeline", (_req, res) => {
    try { res.json({ timeline: getGrowthTimeline() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch growth timeline" }); }
  });

  app.get("/api/growth/latest", (_req, res) => {
    try { res.json({ snapshot: getLatestGrowthSnapshot() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch latest snapshot" }); }
  });

  app.post("/api/growth/snapshot", requireDashAuth, async (_req, res) => {
    try {
      const snapshot = await takeGrowthSnapshot();
      if (!snapshot) return res.status(500).json({ error: "Growth snapshot failed" });
      res.json({ snapshot });
    } catch (e: any) {
      res.status(500).json({ error: "Growth snapshot failed: " + e.message });
    }
  });

  app.get("/api/reflections/episodes", (_req, res) => {
    try { res.json({ reflections: getEpisodeReflections() }); }
    catch (e: any) { res.status(500).json({ error: "Failed to fetch episode reflections" }); }
  });

  app.post("/api/reflections/episode/:id", requireDashAuth, async (req, res) => {
    try {
      const reflection = await reflectOnEpisode(req.params.id);
      if (!reflection) return res.status(500).json({ error: "Episode reflection failed" });
      res.json({ reflection });
    } catch (e: any) {
      res.status(500).json({ error: "Episode reflection failed: " + e.message });
    }
  });

  app.get("/api/improvement-plan", (_req, res) => {
    try {
      const plans = getImprovementPlans();
      const latest = getLatestPlan();
      res.json({ plans, latest });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch improvement plans" });
    }
  });

  app.post("/api/improvement-plan/generate", requireDashAuth, async (_req, res) => {
    try {
      const plan = await generateSelfImprovementPlan();
      if (!plan) return res.status(500).json({ error: "Plan generation failed" });
      res.json({ plan });
    } catch (e: any) {
      res.status(500).json({ error: "Plan generation failed: " + e.message });
    }
  });

  app.post("/api/dreams/seed", requireDashAuth, (_req, res) => {
    try {
      const dreams = seedDreams();
      res.json({ dreams, count: dreams.length });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to seed dreams: " + e.message });
    }
  });

  app.post("/api/dreams/update", requireDashAuth, async (_req, res) => {
    try {
      const result = await updateDreams();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "Dream update failed: " + e.message });
    }
  });

  // ── ASI-Evolve: Embedding routes ────────────────────────────────────────────

  app.get("/api/embeddings/status", (_req, res) => {
    res.json(getEmbeddingStatus());
  });

  app.post("/api/embeddings/sync", requireDashAuth, async (_req, res) => {
    try {
      const result = await syncEmbeddings();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: "Embedding sync failed: " + e.message });
    }
  });

  // ── ASI-Evolve: Analyzer routes ────────────────────────────────────────────

  app.get("/api/analyzer/nodes", (req, res) => {
    const type = req.query.type as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(getRecentAnalysis(type, limit));
  });

  app.get("/api/analyzer/patterns", (_req, res) => {
    res.json(getAggregatedPatterns());
  });

  // ── ASI-Evolve: Semantic search route ──────────────────────────────────────

  app.get("/api/knowledge/semantic-search", async (req, res) => {
    const query = req.query.q as string;
    if (!query) return res.status(400).json({ error: "Missing query parameter 'q'" });
    try {
      const results = await semanticSearch(query, { maxResults: 20 });
      res.json(results.map(r => ({ ...r.entry, similarity: r.similarity })));
    } catch (e: any) {
      res.status(500).json({ error: "Semantic search failed: " + e.message });
    }
  });

  // ── Public Blog API (for agent306.ai site) ────────────────────────────
  app.get("/api/public/blog/posts", (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json({ posts: getPublishedPosts(limit) });
  });

  app.get("/api/public/blog/posts/:slug", (req, res) => {
    const post = getPostBySlug(req.params.slug);
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  });

  // ── Dashboard Blog Management (auth-protected) ────────────────────────
  app.get("/api/blog/state", requireDashAuth, (_req, res) => {
    res.json(getBlogState());
  });

  app.get("/api/blog/posts", requireDashAuth, (_req, res) => {
    res.json({ posts: getAllPosts() });
  });

  app.post("/api/blog/posts", requireDashAuth, async (req, res) => {
    const { title, content, source, sourceId, tags, status } = req.body;
    if (!title || !content) return res.status(400).json({ error: "title and content required" });
    const post = createBlogPost({ title, content, source: source ?? "standalone", sourceId, tags, status });
    res.json(post);
  });

  app.post("/api/blog/generate", requireDashAuth, async (req, res) => {
    const { topic, sourceContent, source, sourceId, autoPublish } = req.body;
    if (!topic || !sourceContent) return res.status(400).json({ error: "topic and sourceContent required" });
    const post = await generateBlogPost({ topic, sourceContent, source: source ?? "standalone", sourceId, autoPublish });
    if (!post) return res.status(500).json({ error: "Blog generation failed" });
    res.json(post);
  });

  app.post("/api/blog/posts/:id/publish", requireDashAuth, (req, res) => {
    const post = publishPost(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  });

  app.put("/api/blog/posts/:id", requireDashAuth, (req, res) => {
    const post = updatePost(req.params.id, req.body);
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  });

  app.delete("/api/blog/posts/:id", requireDashAuth, (req, res) => {
    const ok = deletePost(req.params.id);
    if (!ok) return res.status(404).json({ error: "Post not found" });
    res.json({ success: true });
  });

  app.post("/api/seed", (_req, res) => {
    const demoSignals = [
      { type: "burn", tokenId: 603, description: "Token #603 created — Agent 306 born", weight: 10, phase: "phase1", rawData: "{}" },
      { type: "canvas_edit", tokenId: 45, description: "515 pixel transforms on #45", weight: 9, phase: "phase1", rawData: "{}" },
      { type: "burn", tokenId: 5070, description: "14 burns committed to #5070 — Level 31 reached", weight: 7, phase: "phase1", rawData: "{}" },
      { type: "social_mention", tokenId: 603, description: "@AdamWeitsman tweets Agent 306 reveal — 2.3k likes", weight: 8, phase: "phase1", rawData: "{}" },
      { type: "forecast", tokenId: 0, description: "Major AI model release — new capabilities announced", weight: 10, phase: "phase2", rawData: "{}" },
      { type: "forecast", tokenId: 0, description: "AI benchmark comparison: GPT-5 vs Gemini Ultra", weight: 9, phase: "phase2", rawData: "{}" },
    ];
    demoSignals.forEach(s => storage.createSignal(s));

    const demoEpisodes = [
      { tokenId: 603, title: "EP 001 — The Birth of Agent 306", narrative: "Agent 306 is born on Ethereum. Token #603.", phase: "phase1", signals: JSON.stringify({ burns: 50, socialMentions: 12 }), status: "ready" },
      { tokenId: 45, title: "EP 002 — The Canvas Experiment", narrative: "515 pixel toggles. Art Blocks meets the on-chain museum.", phase: "phase1", signals: JSON.stringify({ burns: 38, canvasEdits: 515 }), status: "draft" },
    ];
    demoEpisodes.forEach(e => storage.createEpisode(e as any));

    res.json({ ok: true, signalsCreated: demoSignals.length, episodesCreated: demoEpisodes.length });
  });
}
