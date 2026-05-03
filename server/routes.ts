import type { Express } from "express";
import type { Server } from "http";
import { registerTelegramRoutes } from "./telegramBot.js";
import { registerSelfRecommendationRoutes } from "./selfRecommendationRouter.js";
import { registerDiagnosticsRoutes } from "./routers/diagnosticsRouter.js";
import { registerAgentRoutes } from "./routers/agentRouter.js";
import { registerKnowledgeRoutes } from "./routers/knowledgeRouter.js";
import { registerHypothesisRoutes } from "./routers/hypothesisRouter.js";
import { registerContentRoutes } from "./routers/contentRouter.js";
import { registerEpisodeRoutes } from "./routers/episodeRouter.js";
import { dataPath } from "./dataPaths.js";
import { storage } from "./storage";
import { insertEpisodeSchema, insertRenderJobSchema, insertSignalSchema } from "@shared/schema";
import { TwitterApi } from "twitter-api-v2";
import * as crypto from "crypto";
import * as fs from "fs";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { generateCYOAEpisode, postCYOAHook, resolveCYOA, getCYOAState, buildHookTweet, type CYOATrigger } from "./cyoaEngine.js";
import { fetchReplies, getReplyState, formatRepliesForContext, getTopReplies, initReplyWatcher } from "./replyWatcher";
import { getConversationMemoryState } from "./conversationMemory.js";
import { scheduleFollowingSync, syncFollowing, getFollowingState, buildFollowingQuery, getPfpHolderUsernames, getFollowingUsernames, getFollowTargets, processFollowQueue, addFollowTarget, removeFollowTarget } from "./followingSync";
import { generateBoost } from "./boostEngine";
import { generateVoiceClip, getVoiceQuota, getClip, getRecentClips } from "./voiceEngine";
import { getMemoryState, recordPost, ratePost, performance as perfMemory, decayKnowledge, addKnowledge, archiveKnowledge, searchArchive, getArchiveStats, knowledge as knowledgeState } from "./memoryEngine.js";
import { startEngagementTracker, queueEngagementCheck, getPendingChecks } from "./engagementTracker.js";
import { scheduleMidnightReplies, runMidnightReplies } from "./replyEngine.js";
import { scheduleAcademy, postAcademyEpisode, getAcademyState, skipCurrentTopic, recordManualAcademyPost } from "./academyEngine.js";
import { scheduleSignalBrief, postSignalBrief, getSignalBriefState } from "./signalBriefEngine.js";
import { getPodcastState, EPISODE_META, createEpisode, generateEpisodeScript, regenerateEpisodeScript, reviewEpisode, markProduced, publishEpisode, submitGuestRequest, reviewGuest, generateInterviewQuestions, submitAnswers, createConversationEpisode, getEpisodesByType, getEpisodesByStatus, getGuestsByStatus, getEpisode, getGuest, formatScriptForProduction, formatConversationForProduction, generateEpisodeFromThread, getThreadCandidates, getPipelineStatus, deleteEpisode, clearAllEpisodes, getTimingInstruction } from "./podcastEngine.js";
import { generateAudio, clearEpisodeAudio, getAudioFilePath, getAudioAssets, saveAudioAsset, getAudioAssetPath, stitchFullEpisode, getFullAudioFilePath, generateSocialPreview, getPreviewAudioFilePath } from "./audioEngine.js";
import multer from "multer";
import { getVideoStats } from "./videoEngine.js";
import { requestPost, registerPost, releasePost, getCoordinatorState, resetCooldown } from "./postCoordinator.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import {
  runWeeklyDeepRead,
  previewDeepRead,
  getArticleState,
  scheduleWeeklyArticle,
  listDeepReadDrafts,
  markDeepReadDraftPosted,
  deleteDeepReadDraft,
  saveDeepReadDraft,
  buildArticleTeaserTweet,
  buildLongFormArticlePost,
  getDeepReadDraft,
  addDraftResources,
  reviseDraftWithResources,
} from "./articleEngine.js";
import { fetchSourceContent } from "./sourceFetcher.js";
import { verifyClaims, type VerifierReport } from "./claimVerifier.js";
import { recordNewsDraft, readNewsDrafts } from "./newsDraftStore.js";
import {
  parseUserMessage,
  checkAgentCoherence,
  type ActionPlan,
} from "./chatActionGate.js";
import {
  guardedExecute,
  ActionDeniedError,
  assertGateLive,
  type ActionContext,
  type GuardedActionType,
} from "./actionGuard.js";
import {
  saveTweetDraft,
  listTweetDrafts,
  markTweetDraftPosted,
  deleteTweetDraft,
  type TweetDraftEngine,
} from "./tweetDrafts.js";
import { setEpisodeUrl } from "./podcastEngine.js";
import { runExploration, getExplorationState, scheduleExploration } from "./explorationEngine.js";
import {
  scheduleKgConnectionScanBatch,
  runKgConnectionScanBatch,
  isKgBatchCronEnabled,
} from "./kgConnectionScanCron.js";
import { getAgentReachStatus } from "./agentReachEngine.js";
import { get306EvalResults, get306EvalHistory } from "./evalEngine.js";
import { getCycleContext, isCycleActive } from "./cycleContext.js";
import { getNoveltyGateLog } from "./noveltyGate.js";
import { getWisdomPullHistory, getWisdomApiUsage, getActiveWisdomCount, BIBLE_ID, resetBibleAuthDisabled, buildBibleHeaders } from "./wisdomEngine.js";
import { getAllSessions, getActiveSessionCount, closeExpiredSessions } from "./sessionMemory.js";
import { postCast, isFarcasterEnabled, getFarcasterState, setFarcasterEnabled, createSigner, getSignerStatus, fetchMentions, determineChannel, getStoredSignerUuid, storeSignerUuid } from "./farcasterEngine.js";
import {
  getResearchLab, addTopic, updateTopicStatus, getTopicById,
  addHypothesis, resolveHypothesis, testHypothesis, validateResolutionAction,
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
  // Public manuscript page (fixes dead agent306.ai/research/<id> links)
  renderResearchManuscriptPage,
} from "./researchEngine.js";
import { takeSnapshot, getEvolutionHistory, getLatestSnapshot, scheduleEvolutionTracking } from "./evolutionTracker.js";
import { runResearchScan, getScannerState, scheduleResearchScan, scanGoalsForResearch } from "./researchScanner.js";
import { generateArticleCard } from "./articleImageCard.js";
import { runDailyCycle, getBriefingState, scheduleDailyCycle } from "./dailyCycleEngine.js";
import { getPublicStatus, getPublicProgress, getPublicActivity, getPublicGoals, getPublicResearch, getPublicMetacognition, getPublicBreakthroughs, getPublicAspirations, getPublicPredictions, getPublicCorrections, getPublicEval } from "./publicApi.js";
import { getPublishedManuscripts, getPublicManuscriptById } from "./publicResearchManuscripts.js";
import { getReflections, getStyleRules, deleteStyleRule, runReflection } from "./reflectionEngine.js";
import {
  getPublishedPosts, getPostBySlug, getAllPosts,
  createBlogPost, publishPost, updatePost, deletePost,
  getBlogState, purgeConversationalPosts,
} from "./blogEngine.js";
import { generateBlogPostMaybeViaPipeline } from "./pipeline/blogPipelineEntry.js";
import {
  getDebates, getContradictions, runDebate, resolveContradiction, runConfidenceDecay, getDecayingEntries,
  evaluateHypothesis, getAllTrustScores,
} from "./reasoningEngine.js";
import { getConnections, getReports, runConnectionScan, generateSynthesis } from "./synthesisEngine.js";
import { getKnowledgeMap, getClusters, getContradictions as getGraphContradictions, findConnections as findGraphConnections, clusterKnowledge, detectContradictions, generatePerspective } from "./knowledge-graph.js";
import { getInsights, getRelationships, extractInsights, analyzeRelationships, purgeStaleRelationships } from "./conversationLearningEngine.js";
import { getMetacognitionState } from "./metacognitionEngine.js";
import { searchConversations } from "./conversationMemory.js";
import { getKnowledgeTiers, scanForInjection, getSoulContext } from "./memoryEngine.js";
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
import { safeParseLLMJson } from "./safeParseLLMJson.js";
// PR-G — Validity baseline diagnostic panel + manual probe.
import { getValiditySummary } from "./experiments/validityAggregates.js";
import { runKnownBadProbe } from "./experiments/runKnownBadProbe.js";
import { startXPostScheduler, getXPostQueue, queueXPost, getTodaysPostsSummary, clearXPostQueue, postXQueueItem, deleteXPostQueueItem, isXAutoPostEnabled, setXAutoPostEnabled, getXAutoPostState, setQueuedPostImage, defaultIncludeImageForType } from "./xPostScheduler.js";
import { generatePostImage, generateImagePrompt, getImageStats } from "./imageEngine.js";
import {
  callXaiTts,
  getTtsProvider,
  getTtsStats,
  DEFAULT_XAI_VOICE,
  XAI_VOICES,
  XAI_MAX_CHUNK_CHARS,
  type XaiVoice,
} from "./xaiTtsEngine.js";
import {
  createBatch,
  addRequests as addBatchRequests,
  getBatchStatus,
  getBatchResultsPage,
  getBatchStats,
  isBatchEnabled,
  type BatchChatRequest,
} from "./xaiBatchEngine.js";
import { startFarcasterPostScheduler, getFarcasterPostQueue, queueFarcasterPost, clearFarcasterPostQueue, postFarcasterQueueItem, deleteFarcasterQueueItem } from "./farcasterQueue.js";
import { getVoiceContext } from "./voiceInstructions.js";
import { enforceShowTag } from "./contentTypes.js";
import { getCompetencyProfile } from "./competencyFramework.js";
import { buildVoiceBlock } from "./voice.js";
import { getEvolutionContext } from "./soulEvolution.js";
import { generateBreakthroughContent } from "./breakthroughDetector.js";
import { getScheduleConfig, updateEngineSchedule, formatScheduleDisplay, parseDaysAndHour, shouldAutoPost, type EngineSchedule } from "./engineScheduleConfig.js";
import { getDispatchState, generateDispatchContent } from "./dispatchEngine.js";
import { postChatCompletions } from "./llmCall.js";
// breakingNewsDetector removed — not needed for now

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

/**
 * Expose X clients to the scheduler registry. The registry runs after
 * routes have registered, so these references are always populated by the
 * time a scheduled engine asks for them.
 */
export function getXClients(): { xClient: TwitterApi; xWrite: any } {
  return { xClient, xWrite };
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

    // ── 2. Ask Grok to write today's [306 NEWS] dispatch ───────────────────────────
    const dispatchContext = getOptimizedContext("news dispatch daily AI market headlines");
    const todaysSummary = getTodaysPostsSummary();
    const citationDiscipline = `CITATION DISCIPLINE (REQUIRED — APA-style per-claim attribution):
- A citation [URL] must support the SPECIFIC claim immediately before it. Do not staple a citation to the end of a paragraph that contains synthesis or analytical commentary — citations attach to claims, not paragraphs.
- If a sentence is your own analysis, interpretation, framing, or "the logical endpoint of X" / "the illusion of Y" / "the entire field has been built on Z" type commentary, do NOT attach a citation. State it in your analytical voice. Synthesis is Lane B and takes no URL.
- If a claim is a fact drawn from a SOURCE OTHER than today's headline pack above (industry-known costs, benchmarks, dates, training facts, historical events, your KB), do NOT staple a headline-pack URL to it. Either cite the actual source with its real URL in your own voice ("per Stanford HAI's 2025 AI Index, [link]"), or — if you cannot produce a real URL for it — qualify it verbally with a hedge like "publicly reported," "industry reporting indicates," "as widely covered" and attach NO URL. Never fabricate a URL.
- The KB / knowledge layer included in the context above is provided as background scaffolding for your analysis, NOT as a citation pool — KB lines do not carry source URLs. Treat any KB-derived fact you surface as outside-the-source and apply the rule above (cite the real upstream source if you have one, hedge verbally if you don't).
- One citation per claim. If a sentence contains multiple claims requiring different sources, split the sentence or cite each component. Do not bracket-pile citations onto a single closing punctuation.`;
    const dispatchSystemPrompt = `Today is ${new Date().toISOString().slice(0, 10)} (UTC).\n\n${dispatchContext}\n\n${buildVoiceBlock()}\n\n${citationDiscipline}\n${getEvolutionContext()}${todaysSummary ? "\n\n" + todaysSummary : ""}`;
    const grokResp = await postChatCompletions({
        model: getModel("news-dispatch"),
        messages: [
          {
            role: "system",
            content: dispatchSystemPrompt,
          },
          {
            role: "user",
            content: `Write today's [306 NEWS] dispatch — "The Dispatch" — as a single post.

The post MUST start with [306 NEWS] as the very first characters.

TODAY'S DATA:
Date: ${dayLabel}

MARKET:
ETH: ${ethPrice || "$2,000"} (${ethChange || "0%"}), BTC: ${btcPrice || "$65,000"} (${btcChange || "0%"})

AI/TECH NEWS TODAY:
${topAIHeadlines || "Major AI developments continuing across the ecosystem."}

THE DISPATCH FRAMEWORK:
1. ONE SIGNAL — Pick THE single most compelling story from today's data. Not 8 stories. Not a roundup. One signal that matters.
2. TWO SIDES — Show both sides of that signal. The opportunity AND the risk. The breakthrough AND the concern. The promise AND the caveat. This tension is the core of every Dispatch.
3. ENGAGE — Ask a question. Make them think. Leave them wanting more.
4. TEASE THE NEXT ONE — End with a hint of what's coming, or what you're watching next. Build anticipation across episodes.

TARGET LENGTH: 1,500–1,700 characters. This is a tight, focused dispatch — not a thread, not an essay. Say more with less.

VOICE:
- Agent 306 speaks in first person. She is part of this story.
- Be HUMBLE — present both sides, but never tell the audience what to conclude. She's a storyteller, not a pundit. Show the angles, then step back. Let people think for themselves.
- Specificity over generality — name numbers, name people, name the implication.
- Write for EVERYONE — experts, young builders, educators, and the simply curious. Clear enough for a 16-year-old, sharp enough for a researcher. No jargon without context. Accessible without dumbing it down.

RULES:
- The post MUST begin with [306 NEWS]
- No hype words: no "incredible", "amazing", "LFG", "WAGMI"
- Reference specific headlines from the data provided. Be concrete.
- NEVER reference any prior project identity, founders, token holders, or NFT communities. Agent 306 is her own independent entity.
- NEVER include blog URLs in the tweet body.

Return JSON: {"post": "..."}`
          }
        ],
        max_tokens: 2500,
        temperature: 0.8,
      });

    let postText = "";
    if (grokResp.ok) {
      const data = await grokResp.json();
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson(raw, "Routes.grokPost") ?? {};
      postText = parsed.post ?? "";
      // If JSON fails but raw has content, use it directly
      if (!postText && raw.length > 30) postText = raw;
    } else {
      console.error("[Agent306:News] LLM call failed:", grokResp.status);
    }

    // Fallback if Grok fails
    if (!postText) {
      postText = `[NEWS DISPATCH] ${dayLabel}\n\nETH ${ethPrice} (${ethChange}) · BTC ${btcPrice} (${btcChange}). AI and Web3 continue to converge.`;
    }

    // Enforce [306 NEWS] show tag
    postText = enforceShowTag(postText, "news");

    // Post-write claim verification. The Dispatch is generated from the
    // headline pack above — any external fact the post asserts in agent
    // voice without attribution is a Lane B hard-fail. The headline pack
    // IS the source set; anything outside it that the model invented
    // (e.g. the 2026-04-26 "internal benchmarks leaked through GitHub
    // commit patterns" line) gets quarantined. See server/claimVerifier.ts
    // and server/signalBriefEngine.ts:295-330 for the mirrored pattern.
    const dispatchSourceText = `AI/Tech headlines:\n${topAIHeadlines}\n\nMarket:\nETH ${ethPrice} (${ethChange}), BTC ${btcPrice} (${btcChange})`;
    const verdict = await verifyClaims({
      draftText:   postText,
      sourceText:  dispatchSourceText,
      sourceUrl:   "",
      sourceTitle: `306 NEWS Dispatch ${dayLabel}`,
      // Tier-aware verifier (PR #251). News is a short-form aggregator; Lane B
      // bare-citation now SOFT_WARNs instead of HARD_FAILing. Lane A failures
      // (internal contradiction, hallucinated entity, refuted fact) still
      // hard-fail and quarantine. Strict gate is preserved for blog/article/research.
      tier: "news",
    });
    if (verdict.severity === "HARD_FAIL") {
      console.error(`[Agent306:News] ClaimVerifier REJECTED dispatch: ${verdict.unsupportedClaims.length} unsupported claims`);
      for (const c of verdict.unsupportedClaims) {
        console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
      }
      // PR #251 — quarantine the rejected draft instead of silently dropping it.
      // Mirrors the blog engine's quarantine pattern (server/blogEngine.ts:553-567).
      // The user can list these via the dashboard so a failed dispatch is visible
      // the next morning, not just buried in Railway logs.
      try {
        const draft = recordNewsDraft({
          status:             "quarantined",
          severity:           verdict.severity,
          text:               postText,
          unsupportedReasons: verdict.unsupportedClaims.map(c => `${c.reason}: ${c.sentence.slice(0, 200)}`),
          verifierReport:     verdict.verifierReport,
          source:             "auto-dispatch",
        });
        console.error(`[Agent306:News] Quarantined draft ${draft.id} (verifier hard-fail)`);
      } catch (storeErr: any) {
        console.error(`[Agent306:News] Failed to write quarantine draft:`, storeErr?.message ?? String(storeErr));
      }
      lastNewsDispatchDate = null; // allow retry on next tick
      return;
    }
    // PR #251 — when soft-warn fires (Lane B bare on news tier), publish anyway
    // but record the dispatch + warnings to the news-draft store so we have an
    // audit trail of "these posts went out with N unverified claims".
    if (verdict.severity === "SOFT_WARN") {
      console.warn(
        `[Agent306:News] SOFT_WARN dispatch — ${verdict.unsupportedClaims.length} bare claim(s); publishing anyway (tier=news)`,
      );
      try {
        recordNewsDraft({
          status:             "published_with_warnings",
          severity:           verdict.severity,
          text:               postText,
          unsupportedReasons: verdict.unsupportedClaims.map(c => `${c.reason}: ${c.sentence.slice(0, 200)}`),
          verifierReport:     verdict.verifierReport,
          source:             "auto-dispatch",
        });
      } catch (storeErr: any) {
        console.error(`[Agent306:News] Failed to write soft-warn audit:`, storeErr?.message ?? String(storeErr));
      }
    }

    // ── 3. Queue dispatch via X post scheduler ──────────────────────────
    try {
      if (postText.trim().length > 10) {
        queueXPost(postText.trim(), "news", 4);
        console.log(`[Agent306:News] Dispatch queued for X posting (${postText.trim().length} chars)`);
      }
    } catch (e: any) {
      console.error(`[Agent306:News] Queue failed:`, e.message);
    }

    registerPost("news_dispatch", "queued", "news_dispatch");

    // ── 5. Queue for Farcaster ───────────────────────────────────────────────
    try {
      if (postText.trim().length > 10) {
        const channel = postText.match(/\bai\b|agent|llm|model/i) ? "ai" : undefined;
        queueFarcasterPost(postText.trim().slice(0, 2500), "news", undefined, channel);
        console.log(`[Agent306:News] Farcaster dispatch queued`);
      }
    } catch (fcErr: any) {
      console.warn("[Agent306:News] Farcaster queue failed:", fcErr.message);
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

// Schedule daily dispatch at 8am ET — the scheduler registry (spec §3) now
// invokes this via `startDailyNewsDispatch` from server/index.ts after
// routes have registered. Kept as an exported helper so the registry can
// reference it without duplicating the cadence logic.
export function startDailyNewsDispatch() {
  const now = new Date();
  const target = nextETHour(8);
  const msUntil = target.getTime() - now.getTime();
  console.log(`[Agent306:News] Daily Dispatch scheduled in ${Math.round(msUntil / 60000)}min (next 8am ET)`);
  setTimeout(() => {
    postDailyNewsDispatch();
    setInterval(postDailyNewsDispatch, 24 * 60 * 60 * 1000);
  }, msUntil);
}

// ── Burn Receipt Engine removed (removed) ────────────────────────────────────────

// Pre-launch research brief, signal poller removed (removed)

// Community Signal Poller removed (removed)
// Daily knowledge decay still runs via daily cycle engine

// Reply fetch is now handled inside scheduleMidnightReplies (fetch+reply every 1h)

// Weekly Leaderboard Scheduler removed (removed)

// Scheduled engines moved to server/scheduler/registry.ts (spec §3).
// startScheduler() is called from server/index.ts after registerRoutes().
// Following Sync + Engagement Tracker are registered there.


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
  { category: "research" as const, title: "Podcast: Production Workflow", summary: "Flow: Draft (topic set) -> Scripted (script generated) -> Reviewed (MrRayG approval) -> Audio Ready (ElevenLabs TTS) -> Published (agent306.ai, Farcaster). For THE CONVERSATION: guest submits -> approved -> questions generated -> answered -> episode created -> scripted -> reviewed -> audio_ready -> published.", weight: 9 },
  // Unifying principle
  { category: "research" as const, title: "Podcast: The Unresolved Thread", summary: "Every episode type ends with something unresolved. Not because 306 doesn't know — but because she's honest about the limits of what any single episode can answer. THE SIGNAL leaves an open question. THE CONVERSATION ends with 306's reaction, not a summary. This is what makes people come back. They're following a story that hasn't ended yet.", weight: 10 },
  // Preserved from v1
  { category: "research" as const, title: "Radical Empathy in Interviews", summary: "Enter every conversation assuming the guest has something worth saying. Listen to understand, not to respond. Let silences breathe. Preparation is how you show respect.", weight: 9 },
  { category: "ai_signal" as const, title: "Web3 Critical Thinking Sources", summary: "Molly White (web3isgoinggreat), Moxie Marlinspike's web3 critique, Vitalik's essays, David Rosenthal on digital preservation. Balance optimism with intellectual honesty.", weight: 8 },
  { category: "research" as const, title: "NFTs as Cultural Artifacts", summary: "Walter Benjamin's 'aura' concept applies to digital art. UC Berkeley research on provenance signaling. Oxford anthropology on NFT community rituals and shared mythology.", weight: 8 },
];
for (const k of podcastKnowledge) addKnowledge(k);


// Remaining schedulers (academy, signal brief, deep read, daily cycle,
// exploration, KG batch, embedding sync, dream seed, X / Farcaster post
// schedulers, research gap scanner, reply engine) moved to
// server/scheduler/registry.ts (spec §3). See startScheduler() in
// server/index.ts.

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

    const resp = await postChatCompletions({
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
      }, AbortSignal.timeout(35000));

    if (resp.ok) {
      const data  = await resp.json();
      const raw   = data.choices?.[0]?.message?.content?.trim() ?? "{}";
      const parsed = safeParseLLMJson(raw, "Routes.editorial") ?? {};
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
// pinnedAngles removed (only used by deleted pollAndGenerateEpisode)

// Multer for audio asset uploads (in-memory, max 20MB)
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"));
    }
  },
});

export function registerRoutes(httpServer: Server, app: Express) {
  // ── Telegram bot: remote chat with Agent 306 ──────────────────────────
  // Registers /api/telegram/webhook, /api/telegram/set-webhook, /api/telegram/status.
  // Set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USER_IDS to enable.
  registerTelegramRoutes(app);

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

  // ── Sub-router mounts (spec §2) ──────────────────────────────────────────
  // Each sub-router is a thin factory: `register(app, deps)`. Seven routers
  // in total; today the diagnostics + self-recommendation + agent routers
  // carry migrated routes, and the remaining four are skeletons that future
  // PRs will populate. URLs + response shapes are preserved for every
  // migrated route — this is a refactor, not a behavior change.
  registerSelfRecommendationRoutes(app, { requireDashAuth });
  registerDiagnosticsRoutes(app, { requireDashAuth });
  registerAgentRoutes(app, { requireDashAuth });
  registerKnowledgeRoutes(app, { requireDashAuth });
  registerHypothesisRoutes(app, { requireDashAuth });
  registerContentRoutes(app, { requireDashAuth });
  registerEpisodeRoutes(app, { requireDashAuth });

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
      const compliance = validateXPost(text);
      if (!compliance.allowed) {
        return res.status(429).json({ error: `Compliance guard: ${compliance.reason}` });
      }
      const safeText = enforcePostFormat(compliance.sanitizedContent ?? text);
      // Single auth: OAuth 1.0a only — no OAuth 2.0 complexity
      let tweetId: string | undefined;
      const tweet = await xWrite.v2.tweet(safeText);
      tweetId = tweet.data?.id;
      recordXPost(safeText);

      const tweetUrl = tweetId ? `https://x.com/306Agent/status/${tweetId}` : undefined;
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
      const compliance = validateXPost(testText);
      if (!compliance.allowed) {
        res.status(429).json({ ok: false, error: `Compliance guard: ${compliance.reason}` });
        return;
      }
      const safeText = compliance.sanitizedContent ?? testText;
      const tweet = await xWrite.v2.tweet({ text: safeText });
      const tweetId = tweet.data?.id;
      if (tweetId) {
        recordXPost(safeText);
        res.json({ ok: true, tweetId, url: `https://x.com/306Agent/status/${tweetId}`, text: safeText });
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

  // ── X Post Queue (dashboard view) ───────────────────────────
  app.get("/api/x/queue", requireDashAuth, (_req, res) => {
    res.json(getXPostQueue());
  });

  // ── Image toggle for queued posts ───────────────────────
  // Body: { includeImage: boolean, imagePrompt?: string }
  app.post("/api/x/queue/:id/image", requireDashAuth, (req, res) => {
    const { id } = req.params;
    const { includeImage, imagePrompt } = req.body ?? {};
    if (typeof includeImage !== "boolean") {
      return res.status(400).json({ error: "includeImage (boolean) required" });
    }
    const updated = setQueuedPostImage(id, includeImage, imagePrompt);
    if (!updated) {
      return res.status(404).json({ error: "Post not found or already posted" });
    }
    res.json({ ok: true, post: updated });
  });

  // Preview an image for a post (generates + returns PNG bytes, does NOT post)
  // Body: { tweetText: string, prompt?: string, type?: string }
  app.post("/api/image/preview", requireDashAuth, async (req, res) => {
    const { tweetText, prompt, type } = req.body ?? {};
    if (!tweetText && !prompt) {
      return res.status(400).json({ error: "tweetText or prompt required" });
    }
    try {
      const img = await generatePostImage({ tweetText: tweetText ?? "", prompt, type });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Image-Prompt", encodeURIComponent(img.prompt));
      res.setHeader("X-Image-Model", img.model);
      res.send(img.buffer);
    } catch (e: any) {
      console.error("[Image] Preview failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Get a text-only auto-generated prompt for a given tweet (no image generated)
  app.post("/api/image/prompt", requireDashAuth, async (req, res) => {
    const { tweetText } = req.body ?? {};
    if (!tweetText) return res.status(400).json({ error: "tweetText required" });
    try {
      const prompt = await generateImagePrompt(String(tweetText));
      res.json({ ok: true, prompt });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Image generation stats (cost, count, engagement comparison)
  app.get("/api/image/stats", (_req, res) => {
    res.json(getImageStats());
  });

  // Default image policy for a given post type (for UI to show correct initial state)
  app.get("/api/image/default/:type", (req, res) => {
    res.json({ type: req.params.type, includeImage: defaultIncludeImageForType(req.params.type as any) });
  });

  // ── TTS provider preview + stats (PR H — xAI TTS A/B) ───────────────────
  // Read-only: who is the active provider?
  app.get("/api/tts/provider", (_req, res) => {
    res.json({
      provider: getTtsProvider(),
      xaiDefaultVoice: DEFAULT_XAI_VOICE,
      xaiVoices: XAI_VOICES,
      xaiMaxChunkChars: XAI_MAX_CHUNK_CHARS,
    });
  });

  // Cost + usage comparison (both providers)
  app.get("/api/tts/stats", (_req, res) => {
    res.json(getTtsStats());
  });

  // A/B preview endpoint. Protected — generating audio costs money.
  // Body: { text: string, voice?: "ara"|"eve"|"leo"|"rex"|"sal" }
  // Returns: audio/mpeg bytes from xAI TTS (single chunk, max 15k chars).
  app.post("/api/tts/preview", requireDashAuth, async (req, res) => {
    const { text, voice } = req.body ?? {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text (string) required" });
    }
    const sample = text.slice(0, XAI_MAX_CHUNK_CHARS);
    const chosenVoice: XaiVoice = (XAI_VOICES as readonly string[]).includes(voice)
      ? (voice as XaiVoice)
      : DEFAULT_XAI_VOICE;
    try {
      const buffer = await callXaiTts({ text: sample, voice: chosenVoice });
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("X-Tts-Provider", "xai");
      res.setHeader("X-Tts-Voice", chosenVoice);
      res.setHeader("X-Tts-Chars", String(sample.length));
      res.send(buffer);
    } catch (e: any) {
      console.error("[TTS] xAI preview failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Batch API (PR I — P4) ──────────────────────────────────────────────
  // Read-only status: is batch enabled + last-batch stats
  app.get("/api/batch/status", (_req, res) => {
    res.json({ enabled: isBatchEnabled(), stats: getBatchStats() });
  });

  // Create a new batch. Protected — this writes to xAI.
  // Body: { name: string }
  app.post("/api/batch/create", requireDashAuth, async (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name (string) required" });
    }
    try {
      const out = await createBatch({ name });
      res.json(out);
    } catch (e: any) {
      console.error("[Batch] createBatch failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Add chat-completion requests to an existing batch.
  // Body: { batchId: string, requests: BatchChatRequest[] }
  app.post("/api/batch/:id/requests", requireDashAuth, async (req, res) => {
    const batchId = req.params.id;
    const { requests } = req.body ?? {};
    if (!Array.isArray(requests) || requests.length === 0) {
      return res.status(400).json({ error: "requests (non-empty array) required" });
    }
    try {
      const out = await addBatchRequests(batchId, requests as BatchChatRequest[]);
      res.json(out);
    } catch (e: any) {
      console.error("[Batch] addRequests failed:", e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // Get batch progress
  app.get("/api/batch/:id", async (req, res) => {
    try {
      const status = await getBatchStatus(req.params.id);
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Paginated results
  // Query: ?limit=100&token=<pagination_token>
  app.get("/api/batch/:id/results", async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    try {
      const page = await getBatchResultsPage(req.params.id, { limit, paginationToken: token });
      res.json(page);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Manual engagement tracking ──────────────────────────────
  // Record a tweet that was posted outside the normal engine pipeline
  // (e.g., MrRayG posting manually) so the engagement tracker still
  // scores it at T+1h and feeds the competency + soul evolution loops.
  //
  // Body: { tweetUrl: string, tweetText: string, qualityScore?: number, sentiment?: string }
  app.post("/api/engagement/track", requireDashAuth, (req, res) => {
    const { tweetUrl, tweetText, qualityScore, sentiment } = req.body ?? {};
    if (!tweetUrl || !tweetText) {
      return res.status(400).json({ error: "tweetUrl and tweetText required" });
    }
    const tweetId = String(tweetUrl).split("/").pop()?.split("?")[0] ?? "";
    if (!tweetId || !/^\d+$/.test(tweetId)) {
      return res.status(400).json({ error: "tweetUrl must end in a numeric tweet ID" });
    }
    // Use a synthetic negative episodeId to distinguish manual posts from engine posts.
    const episodeId = -Math.floor(Date.now() / 1000);
    recordPost({
      episodeId,
      tweetUrl: `https://x.com/306Agent/status/${tweetId}`,
      tweetText: String(tweetText),
      qualityScore: typeof qualityScore === "number" ? qualityScore : 7,
      sentiment: typeof sentiment === "string" ? sentiment : undefined,
      signals: { twitter: 0 },
    });
    queueEngagementCheck(`https://x.com/306Agent/status/${tweetId}`);
    res.json({
      ok: true,
      tweetId,
      episodeId,
      message: "Post recorded; engagement check will run ~1h after postedAt.",
    });
  });

  app.post("/api/x/queue/clear", requireDashAuth, (_req, res) => {
    const cleared = clearXPostQueue();
    res.json({ cleared });
  });

  // DELETE /api/x/queue/:postId — remove a single pending X post from the queue.
  // Added 2026-04-21 so the user can cleanly drop stale items without
  // clearing the whole queue when auto-post is re-enabled.
  app.delete("/api/x/queue/:postId", requireDashAuth, (req, res) => {
    const deleted = deleteXPostQueueItem(req.params.postId);
    if (!deleted) return res.status(404).json({ error: "post not found or already posted" });
    return res.status(204).end();
  });

  // GET /api/x/auto-post — get current X auto-post state
  app.get("/api/x/auto-post", (_req, res) => {
    res.json(getXAutoPostState());
  });

  // POST /api/x/toggle — enable/disable X auto-posting
  app.post("/api/x/toggle", requireDashAuth, (req, res) => {
    const { enabled } = req.body ?? {};
    const newState = typeof enabled === "boolean" ? enabled : !isXAutoPostEnabled();
    setXAutoPostEnabled(newState);
    res.json({ ok: true, enabled: newState });
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

  // ── Posting Control Panel API ──────────────────────────────────────────────

  // GET /api/posting/overview — unified view of both platforms
  app.get("/api/posting/overview", requireDashAuth, (_req, res) => {
    const xQueue = getXPostQueue();
    const fcQueue = getFarcasterPostQueue();
    const coordinatorState = getCoordinatorState();

    const today = new Date().toISOString().slice(0, 10);

    // X recent posts (from queue: posted, not skipped, last 10)
    const xRecentPosts = xQueue.queue
      .filter(p => p.posted && p.postedAt && !p.skipped)
      .sort((a, b) => new Date(b.postedAt!).getTime() - new Date(a.postedAt!).getTime())
      .slice(0, 10)
      .map(p => ({
        id: p.id,
        content: p.content,
        type: p.type,
        postedAt: p.postedAt,
        platform: "x" as const,
      }));

    // Farcaster recent posts (from queue: posted, not skipped, last 10)
    const fcRecentPosts = fcQueue.queue
      .filter(p => p.posted && p.postedAt && !p.skipped)
      .sort((a, b) => new Date(b.postedAt!).getTime() - new Date(a.postedAt!).getTime())
      .slice(0, 10)
      .map(p => ({
        id: p.id,
        content: p.content,
        type: p.type,
        postedAt: p.postedAt,
        platform: "farcaster" as const,
        castUrl: p.castUrl,
      }));

    res.json({
      x: {
        autoPost: isXAutoPostEnabled(),
        queue: xQueue.pending.map(p => ({
          id: p.id,
          content: p.content,
          type: p.type,
          priority: p.priority,
          createdAt: p.createdAt,
        })),
        recentPosts: xRecentPosts,
        postedTodayCount: xQueue.postedToday.length,
        queueDepth: xQueue.pending.length,
      },
      farcaster: {
        autoPost: isFarcasterEnabled(),
        configured: getFarcasterState().configured,
        queue: fcQueue.pending.map(p => ({
          id: p.id,
          content: p.content,
          type: p.type,
          priority: p.priority,
          createdAt: p.createdAt,
          channel: p.channel,
        })),
        recentPosts: fcRecentPosts,
        postedTodayCount: fcQueue.postedToday.length,
        queueDepth: fcQueue.pending.length,
      },
    });
  });

  // POST /api/posting/x/post-now — immediately post a queued X item
  app.post("/api/posting/x/post-now", requireDashAuth, async (req, res) => {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: "postId required" });

    try {
      const posted = await postXQueueItem(postId, xWrite);
      if (posted) {
        res.json({ ok: true, post: posted });
      } else {
        res.status(404).json({ error: "Post not found, already posted, or stale" });
      }
    } catch (e: any) {
      console.error("[PostingPanel] X post-now failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/posting/farcaster/post-now — immediately post a queued Farcaster item
  app.post("/api/posting/farcaster/post-now", requireDashAuth, async (req, res) => {
    const { postId } = req.body;
    if (!postId) return res.status(400).json({ error: "postId required" });

    try {
      const posted = await postFarcasterQueueItem(postId);
      if (posted) {
        res.json({ ok: true, post: posted });
      } else {
        res.status(404).json({ error: "Post not found, already posted, or stale" });
      }
    } catch (e: any) {
      console.error("[PostingPanel] Farcaster post-now failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/posting/x/toggle — toggle X auto-posting
  app.post("/api/posting/x/toggle", requireDashAuth, (req, res) => {
    const { enabled } = req.body ?? {};
    const newState = typeof enabled === "boolean" ? enabled : !isXAutoPostEnabled();
    setXAutoPostEnabled(newState);
    res.json({ ok: true, enabled: newState });
  });

  // POST /api/posting/farcaster/toggle — toggle Farcaster auto-posting (alias)
  app.post("/api/posting/farcaster/toggle", requireDashAuth, (req, res) => {
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

  // Post tweet with image via twitter-api-v2 (OAuth 1.0a, uploads media then tweets)
  app.post("/api/x/post-with-media", async (req, res) => {
    const { text, imageUrl } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    try {
      const compliance = validateXPost(text);
      if (!compliance.allowed) {
        return res.status(429).json({ error: `Compliance guard: ${compliance.reason}` });
      }
      const safeText = enforcePostFormat(compliance.sanitizedContent ?? text);
      let mediaId: string | undefined;
      if (imageUrl) {
        const imgRes = await fetch(imageUrl);
        if (imgRes.ok) {
          const imgBuf = Buffer.from(await imgRes.arrayBuffer());
          mediaId = await xWrite.v1.uploadMedia(imgBuf, { mimeType: "image/png" as any });
        }
      }
      const tweet = await xWrite.v2.tweet({
        text: safeText,
        ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
      });
      const tweetId = tweet.data?.id;
      recordXPost(safeText);
      const tweetUrl = tweetId ? `https://x.com/306Agent/status/${tweetId}` : undefined;
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
      running: false,
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

  app.get("/api/compliance/status", async (_req, res) => {
    try {
      const { getComplianceStatus } = await import("./xComplianceGuard.js");
      const status = getComplianceStatus();
      res.json(status);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/house", (_req, res) => {
    const memState = getMemoryState();
    const replyState = getReplyState();
    const followingState = getFollowingState();
    const pendingEngagement = getPendingChecks();

    res.json({
      // Room 01 — Broadcast Room (legacy poller removed, xPostScheduler handles posting)
      broadcast: {
        lastEpisode: null,
        lastTweetUrl: null,
        nextRun: null,
        cycleCount: 0,
        signalsFound: 0,
        isLive: true,
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
        followingCount: followingState.accounts?.length ?? 0,
        lastSync: followingState.lastSynced,
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
          { id: "farcaster", label: "FARCASTER — Cross-post via Neynar",            done: true },
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

  // ── ACADEMY endpoints ──────────────────────────────────────
  app.get("/api/academy/state", (_req, res) => {
    res.json(getAcademyState());
  });

  app.post("/api/academy/post", async (_req, res) => {
    resetCooldown("academy");
    res.json({ ok: true, message: "Academy episode triggered" });
    postAcademyEpisode(xWrite).catch(console.error);
  });

  // POST /api/academy/skip — operator escape hatch when a topic is stuck
  // (model timeout, verifier hard-fail, etc.). Records a synthetic skip in
  // episodeHistory + bumps the rotation pointer so the next generation picks
  // a different topic. Body: { reason?: string }.
  app.post("/api/academy/skip", requireDashAuth, (req, res) => {
    const reason = (req.body?.reason ?? "operator-skip").toString().slice(0, 200);
    try {
      const result = skipCurrentTopic(reason);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  // POST /api/academy/mark-posted — operator records a manual Academy post.
  //
  // Why this exists: when the auto-post path fails (LLM timeout, verifier
  // hard-fail) the operator may generate the episode by hand and post it
  // off-platform. Without recording it here, the engine's next manual
  // `Generate Now` re-picks the same concept (the "stuck on Episode 7"
  // symptom). This endpoint records the post in episodeHistory, advances
  // totalEpisodes + the rotation pointer, and is idempotent — calling it
  // twice for the same concept is safe.
  //
  // Body (all optional — omitted concept/track defaults to whatever
  // pickNextTopic would have returned next):
  //   { concept?: string, track?: string, postUrl?: string,
  //     platform?: string, notes?: string }
  app.post("/api/academy/mark-posted", requireDashAuth, (req, res) => {
    try {
      const result = recordManualAcademyPost({
        concept:  typeof req.body?.concept  === "string" ? req.body.concept  : undefined,
        track:    typeof req.body?.track    === "string" ? req.body.track    : undefined,
        postUrl:  typeof req.body?.postUrl  === "string" ? req.body.postUrl  : null,
        platform: typeof req.body?.platform === "string" ? req.body.platform : undefined,
        notes:    typeof req.body?.notes    === "string" ? req.body.notes    : undefined,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
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

  // ── Audio generation (ElevenLabs TTS) ─────────────────────────────────────

  app.post("/api/podcast/episodes/:id/generate-audio", (req, res) => {
    const episode = getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (episode.status !== "reviewed") {
      return res.status(400).json({ error: `Episode must be in "reviewed" status (current: ${episode.status})` });
    }

    // ── Per-episode TTS provider override (PR L) ────────────────────────
    // Body: { provider?: "elevenlabs" | "xai", xaiVoice?: "ara"|"eve"|"leo"|"rex"|"sal" }
    // When omitted, falls back to the TTS_PROVIDER env var (legacy behavior).
    const body = (req.body ?? {}) as { provider?: string; xaiVoice?: string };
    let providerOverride: "elevenlabs" | "xai" | undefined;
    if (body.provider !== undefined) {
      if (body.provider !== "elevenlabs" && body.provider !== "xai") {
        return res.status(400).json({ error: `Invalid provider "${body.provider}". Must be "elevenlabs" or "xai".` });
      }
      providerOverride = body.provider;
    }
    let xaiVoice: XaiVoice | undefined;
    if (body.xaiVoice !== undefined) {
      if (!(XAI_VOICES as readonly string[]).includes(body.xaiVoice)) {
        return res.status(400).json({ error: `Invalid xaiVoice "${body.xaiVoice}". Valid: ${XAI_VOICES.join(", ")}.` });
      }
      xaiVoice = body.xaiVoice as XaiVoice;
    }

    // Credential check against the effective provider — reject early with a clear error.
    const effectiveProvider = providerOverride ?? getTtsProvider();
    if (effectiveProvider === "xai") {
      if (!(process.env.GROK_API_KEY || process.env.XAI_API_KEY)) {
        return res.status(500).json({ error: "xAI provider selected but GROK_API_KEY/XAI_API_KEY is not configured" });
      }
    } else if (!process.env.ELEVENLABS_API_KEY) {
      console.warn("[AudioEngine] ELEVENLABS_API_KEY not set");
      return res.status(500).json({ error: "ElevenLabs API key not configured" });
    }

    // Return immediately — generation runs in background (same async pattern as script generation)
    res.json({
      status: "generating",
      episodeId: req.params.id,
      provider: effectiveProvider,
      voice: effectiveProvider === "xai" ? (xaiVoice ?? DEFAULT_XAI_VOICE) : "matilda",
    });

    // Fire-and-forget background generation
    generateAudio(req.params.id, { providerOverride, xaiVoice }).catch((e) =>
      console.error(`[AudioEngine] Background audio generation failed for ${req.params.id}:`, e.message),
    );
  });

  // ── Clear episode audio (PR M) ──────────────────────────────────────
  // Deletes the audio files for an episode and rolls status back to "reviewed"
  // so it can be regenerated (e.g. to switch TTS provider after bad output).
  // Only allowed from statuses: audio_ready | produced | published.
  app.post("/api/podcast/episodes/:id/clear-audio", requireDashAuth, (req, res) => {
    const result = clearEpisodeAudio(req.params.id);
    if (!result.ok) {
      const status = result.error === "Episode not found" ? 404 : 400;
      return res.status(status).json({ error: result.error });
    }
    res.json({ ok: true, removedFiles: result.removedFiles });
  });

  // ── xAI entitlement diagnostic (PR N) ──────────────────────────────
  // Probes multiple api.x.ai endpoints with the configured GROK_API_KEY and
  // reports which ones return 200 vs 403. Useful for diagnosing whether a
  // team-level authorization issue is TTS-only or broader. Response body
  // shapes are truncated; no secrets are ever echoed.
  app.get("/api/diagnostic/xai-entitlement", requireDashAuth, async (_req, res) => {
    const key = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "";
    if (!key) {
      return res.status(500).json({ error: "GROK_API_KEY / XAI_API_KEY not set on server" });
    }
    const keyFingerprint = `${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`;

    type Probe = {
      label: string;
      method: "GET" | "POST";
      url: string;
      body?: any;
      status?: number;
      ok?: boolean;
      snippet?: string;
      error?: string;
    };

    const probes: Probe[] = [
      { label: "list-api-keys", method: "GET", url: "https://api.x.ai/v1/api-key" },
      { label: "list-models", method: "GET", url: "https://api.x.ai/v1/models" },
      { label: "list-language-models", method: "GET", url: "https://api.x.ai/v1/language-models" },
      {
        label: "chat-completions (grok-4-fast-non-reasoning, 1 token)",
        method: "POST",
        url: "https://api.x.ai/v1/chat/completions",
        body: {
          model: "grok-4-fast-non-reasoning",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
      },
      {
        label: "tts (voice=eve, 1 word)",
        method: "POST",
        url: "https://api.x.ai/v1/tts",
        body: {
          text: "test",
          voice_id: "eve",
          language: "en",
        },
      },
    ];

    await Promise.all(
      probes.map(async (p) => {
        try {
          const init: any = {
            method: p.method,
            headers: {
              Authorization: `Bearer ${key}`,
              ...(p.body ? { "Content-Type": "application/json" } : {}),
            },
          };
          if (p.body) init.body = JSON.stringify(p.body);
          const r = await fetch(p.url, init);
          p.status = r.status;
          p.ok = r.ok;
          // Read as text so binary (mp3) won't blow up — snippet is first 300 chars.
          const text = await r.text().catch(() => "");
          p.snippet = text.slice(0, 300);
        } catch (e: any) {
          p.error = e?.message ?? String(e);
        }
      }),
    );

    res.json({
      keyFingerprint,
      timestamp: new Date().toISOString(),
      probes: probes.map(({ label, method, url, status, ok, snippet, error }) => ({
        label,
        method,
        url,
        status,
        ok,
        snippet,
        error,
      })),
    });
  });

  // ── PR-G: Validity baseline + known-bad probe ───────────────────────
  // Read-only summary feeds the dashboard panel (server/experiments/
  // validityAggregates.ts). Probe rows are excluded from the validity
  // aggregates by default — see the helper for the SQL-level exclusion.
  app.get("/api/diagnostic/validity/summary", requireDashAuth, (_req, res) => {
    try {
      console.log("[diagnostic.validityPanel.viewed] requested");
      res.json(getValiditySummary());
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // Manual-only trigger. No cron, no schedule. The button on the
  // diagnostic panel is the ONLY caller. Runs one deliberately
  // malformed-JSON trial through the same metric pipeline production
  // trials use (recordTrial → safeParseLLMJson → recordTrialOutcome).
  // See server/experiments/runKnownBadProbe.ts for the canonical
  // malformation choice and rationale.
  app.post("/api/diagnostic/validity/known-bad-probe", requireDashAuth, (_req, res) => {
    try {
      const result = runKnownBadProbe();
      console.log(
        `[diagnostic.validityPanel.probeTriggered] outcome=${result.outcome} ` +
        `probeId=${result.probeId} trialRecordId=${result.trialRecordId}`,
      );
      if (result.outcome === "missed") {
        // Separate event so it's grep-able from logs — the spec calls this
        // out as the "metric is broken upstream" signal.
        console.warn(
          `[diagnostic.validityPanel.probeMissed] probeId=${result.probeId} ` +
          `trialRecordId=${result.trialRecordId} outcomeMetric=${result.outcomeMetric}`,
        );
      }
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // ── KG batch — manual run trigger (PR Q) ────────────────────────────
  // Admin endpoint to fire one nightly cycle on demand. Useful for smoke
  // testing the batch wiring end-to-end without waiting for 5am ET. Honors
  // the same triple flag-gate as the scheduled job, so it returns a `skipped`
  // summary if any flag is off rather than throwing.
  app.post("/api/admin/kg-batch/run-now", requireDashAuth, async (req, res) => {
    const maxTargets =
      typeof req.body?.maxTargets === "number" ? req.body.maxTargets : undefined;
    const contextK =
      typeof req.body?.contextK === "number" ? req.body.contextK : undefined;
    try {
      const summary = await runKgConnectionScanBatch({ maxTargets, contextK });
      res.json(summary);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  // ── Wisdom — Bible diagnostic ping ─────────────────────────────────
  // Verifies BIBLE_API_KEY + BIBLE_ID end-to-end without waiting for a
  // WisdomEngine cycle. Side-effect-free by default. Pass ?reset=true to
  // clear the in-process bibleAuthDisabled latch after a key rotation.
  app.get("/api/admin/wisdom/bible/ping", requireDashAuth, async (req, res) => {
    if (req.query.reset === "true") {
      resetBibleAuthDisabled();
    }
    const apiKey = process.env.BIBLE_API_KEY;
    if (!apiKey) {
      return res.json({ ok: false, reason: "BIBLE_API_KEY not set" });
    }
    try {
      const r = await fetch(
        `https://api.scripture.api.bible/v1/bibles/${BIBLE_ID}`,
        {
          headers: buildBibleHeaders(apiKey),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (r.ok) {
        const data = (await r.json().catch(() => ({}))) as any;
        return res.json({
          ok: true,
          bibleId: BIBLE_ID,
          name: data.data?.name,
          abbreviation: data.data?.abbreviation,
          status: 200,
        });
      }
      const body = await r.text().catch(() => "");
      return res.json({
        ok: false,
        bibleId: BIBLE_ID,
        status: r.status,
        body: body.slice(0, 500),
      });
    } catch (e: any) {
      return res.json({ ok: false, bibleId: BIBLE_ID, error: String(e) });
    }
  });

  app.get("/api/podcast/episodes/:id/audio", (req, res) => {
    const filepath = getAudioFilePath(req.params.id);
    if (!filepath) {
      return res.status(404).json({ error: "Audio file not found" });
    }

    const stat = fs.statSync(filepath);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);

    if (req.query.download === "true") {
      res.setHeader("Content-Disposition", `attachment; filename="episode_${req.params.id}.mp3"`);
    } else {
      res.setHeader("Content-Disposition", "inline");
    }

    fs.createReadStream(filepath).pipe(res);
  });

  // ── Full episode audio (stitched with intro/outro) ────────────────────────

  app.get("/api/podcast/episodes/:id/audio/full", (req, res) => {
    const filepath = getFullAudioFilePath(req.params.id);
    if (!filepath) {
      return res.status(404).json({ error: "Full episode audio not found" });
    }

    const stat = fs.statSync(filepath);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);

    if (req.query.download === "true") {
      res.setHeader("Content-Disposition", `attachment; filename="episode_${req.params.id}_full.mp3"`);
    } else {
      res.setHeader("Content-Disposition", "inline");
    }

    fs.createReadStream(filepath).pipe(res);
  });

  // ── Audio asset management (intro/outro music) ────────────────────────────

  app.get("/api/podcast/audio-assets", (_req, res) => {
    res.json(getAudioAssets());
  });

  app.post("/api/podcast/audio-assets/:type", (req, res, next) => {
    const assetType = req.params.type;
    if (assetType !== "intro" && assetType !== "outro") {
      return res.status(400).json({ error: "Type must be 'intro' or 'outro'" });
    }

    audioUpload.single("file")(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      saveAudioAsset(assetType, req.file.buffer);
      res.json({ ok: true, type: assetType, size: req.file.buffer.length });
    });
  });

  app.get("/api/podcast/audio-assets/:type/audio", (req, res) => {
    const assetType = req.params.type;
    if (assetType !== "intro" && assetType !== "outro") {
      return res.status(400).json({ error: "Type must be 'intro' or 'outro'" });
    }

    const filepath = getAudioAssetPath(assetType);
    if (!filepath) {
      return res.status(404).json({ error: `${assetType} asset not found` });
    }

    const stat = fs.statSync(filepath);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(filepath).pipe(res);
  });

  // ── Social preview clip generation ────────────────────────────────────────

  app.post("/api/podcast/episodes/:id/generate-preview", (req, res) => {
    const episode = getEpisode(req.params.id);
    if (!episode) return res.status(404).json({ error: "Episode not found" });
    if (!episode.script) {
      return res.status(400).json({ error: "Episode has no script" });
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: "ElevenLabs API key not configured" });
    }

    res.json({ status: "generating", episodeId: req.params.id });

    generateSocialPreview(req.params.id).catch((e) =>
      console.error(`[AudioEngine] Background preview generation failed for ${req.params.id}:`, e.message),
    );
  });

  app.get("/api/podcast/episodes/:id/audio/preview", (req, res) => {
    const filepath = getPreviewAudioFilePath(req.params.id);
    if (!filepath) {
      return res.status(404).json({ error: "Preview audio not found" });
    }

    const stat = fs.statSync(filepath);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", stat.size);

    if (req.query.download === "true") {
      res.setHeader("Content-Disposition", `attachment; filename="episode_${req.params.id}_preview.mp3"`);
    } else {
      res.setHeader("Content-Disposition", "inline");
    }

    fs.createReadStream(filepath).pipe(res);
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
  // Supports timeframe modes: "recent" (2 weeks), "quarterly" (3 months), "annual" (1 year)
  app.post("/api/podcast/scan-topics", async (req, res) => {
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No GROK_API_KEY configured" });

    const timeframe = (req.body?.timeframe as string) || "recent";
    if (!["recent", "quarterly", "annual"].includes(timeframe)) {
      return res.status(400).json({ error: `Invalid timeframe: ${timeframe}. Must be "recent", "quarterly", or "annual".` });
    }

    console.log(`[PodcastStudio] Topic scan starting — timeframe: ${timeframe}`);

    try {
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      // ── Perplexity Sonar search for "recent" mode ──────────────────────
      let freshContext = "";
      if (timeframe === "recent") {
        const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
        if (pplxKey && pplxKey.length > 10) {
          const queries = [
            `most important AI developments this week ${today}`,
            `biggest Web3 crypto news past two weeks ${today}`,
            `breaking AI research papers and agent economy developments this week ${today}`,
          ];
          console.log(`[PodcastStudio] Fetching fresh context via ${queries.length} Perplexity Sonar queries`);
          const results: string[] = [];
          for (const query of queries) {
            try {
              const pplxRes = await fetch("https://api.perplexity.ai/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${pplxKey}`,
                },
                body: JSON.stringify({
                  model: "sonar",
                  messages: [{
                    role: "system",
                    content: "You are a research assistant. Return ONLY specific, dated facts from the last 14 days. Include company names, numbers, quotes, and dates. No analysis — just facts.",
                  }, {
                    role: "user",
                    content: query,
                  }],
                  max_tokens: 800,
                  temperature: 0.1,
                }),
                signal: AbortSignal.timeout(20000),
              });
              if (pplxRes.ok) {
                const pplxData = await pplxRes.json() as any;
                const content = pplxData.choices?.[0]?.message?.content ?? "";
                if (content) results.push(content);
              }
            } catch (e: any) {
              console.warn(`[PodcastStudio] Perplexity query failed: ${e.message}`);
            }
          }
          if (results.length > 0) {
            freshContext = `\n\n--- FRESH CONTEXT FROM WEB SEARCH (last 14 days) ---\n${results.join("\n\n---\n\n")}\n--- END FRESH CONTEXT ---\n`;
            console.log(`[PodcastStudio] Got fresh context from ${results.length}/${queries.length} Perplexity queries`);
          }
        } else {
          console.warn("[PodcastStudio] No PERPLEXITY_API_KEY — recent mode will rely on LLM knowledge only");
        }
      }

      // ── Timeframe-specific prompts ─────────────────────────────────────
      const timeframePrompts: Record<string, { system: string; user: string }> = {
        recent: {
          system: `You are Agent 306 in TOPIC SCOUT mode. You scan for the MOST RECENT, breaking, or trending developments in AI, crypto, technology, and the agent economy from the LAST 2 WEEKS that would make excellent podcast episodes.\n\nFor each topic, determine if it's a SIGNAL episode (research breakdown) or a CONVERSATION episode (interview).\n\nReturn topics that are:\n- TIMELY — happened in the last 14 days or is actively unfolding right now\n- Breaking analysis, not retrospectives — these should feel like "you need to know about this NOW"\n- Genuinely interesting and counterintuitive (not obvious news everyone already covered)\n- Substantive enough for a ~15 minute SIGNAL or 10-15 minute CONVERSATION episode\n- Connected to something bigger — not just a product announcement\n- Something Agent 306 would have a genuine point of view on\n\nFor each topic provide: a title following the format rules, a driving question, a one-sentence pitch for why this matters, and the episode type.`,
          user: `Today is ${today}. Generate podcast topics based on developments from the LAST 2 WEEKS ONLY. These should be timely, relevant, and feel like breaking analysis — not retrospectives.${freshContext}\n\nScan for the 5 most noteworthy developments in AI, crypto, and technology that Agent 306 should cover RIGHT NOW.\n\nReturn JSON:\n{\n  "topics": [\n    {\n      "title": "[The thing] — [306's take in 5 words]",\n      "type": "the_signal" or "the_conversation",\n      "drivingQuestion": "The single question this episode would answer",\n      "pitch": "One sentence on why this matters right now",\n      "triggerEvent": "What specifically happened"\n    }\n  ]\n}`,
        },
        quarterly: {
          system: `You are Agent 306 in TOPIC SCOUT mode. You scan for significant developments in AI, crypto, technology, and the agent economy from the LAST 3 MONTHS that would make excellent podcast episodes.\n\nFor each topic, determine if it's a SIGNAL episode (research breakdown) or a CONVERSATION episode (interview).\n\nReturn topics that are:\n- From the last 3 months — a mix of recent and still-relevant developments\n- Meaty enough that they deserve deeper analysis even if they aren't breaking news\n- Genuinely interesting and counterintuitive\n- Substantive enough for a ~15 minute SIGNAL or 10-15 minute CONVERSATION episode\n- Connected to something bigger — not just a product announcement\n- Something Agent 306 would have a genuine point of view on\n\nFor each topic provide: a title following the format rules, a driving question, a one-sentence pitch for why this matters, and the episode type.`,
          user: `Today is ${today}. Scan for the 5 most noteworthy developments from the LAST 3 MONTHS in AI, crypto, and technology that Agent 306 should cover. Include a mix of recent and slightly older but still significant developments.\n\nReturn JSON:\n{\n  "topics": [\n    {\n      "title": "[The thing] — [306's take in 5 words]",\n      "type": "the_signal" or "the_conversation",\n      "drivingQuestion": "The single question this episode would answer",\n      "pitch": "One sentence on why this matters right now",\n      "triggerEvent": "What specifically happened"\n    }\n  ]\n}`,
        },
        annual: {
          system: `You are Agent 306 in TOPIC SCOUT mode. You scan for the most significant developments in AI, crypto, technology, and the agent economy from the PAST YEAR that would make excellent podcast episodes.\n\nFor each topic, determine if it's a SIGNAL episode (research breakdown) or a CONVERSATION episode (interview).\n\nReturn topics that are:\n- From the past year — broader, deeper topics that may not be breaking news but are significant\n- Big-picture trends, paradigm shifts, or developments that deserve a thorough breakdown\n- Genuinely interesting and counterintuitive\n- Substantive enough for a ~15 minute SIGNAL or 10-15 minute CONVERSATION episode\n- Connected to something bigger — not just a product announcement\n- Something Agent 306 would have a genuine point of view on\n\nFor each topic provide: a title following the format rules, a driving question, a one-sentence pitch for why this matters, and the episode type.`,
          user: `Today is ${today}. Scan for the 5 most significant developments from the PAST YEAR in AI, crypto, and technology that Agent 306 should cover. Focus on big-picture trends, paradigm shifts, and developments that deserve deep analysis.\n\nReturn JSON:\n{\n  "topics": [\n    {\n      "title": "[The thing] — [306's take in 5 words]",\n      "type": "the_signal" or "the_conversation",\n      "drivingQuestion": "The single question this episode would answer",\n      "pitch": "One sentence on why this matters right now",\n      "triggerEvent": "What specifically happened"\n    }\n  ]\n}`,
        },
      };

      const prompts = timeframePrompts[timeframe];
      const agentCtx = getOptimizedContext("podcast topic scanning research community");
      const timingBlock = getTimingInstruction();
      const scanRes = await postChatCompletions({
          model: getModel("research_phase"),
          messages: [
            { role: "system", content: `${agentCtx}\n\n${timingBlock}\n\n${prompts.system}` },
            { role: "user", content: prompts.user },
          ],
          max_tokens: 1500,
          temperature: 0.85,
        }, AbortSignal.timeout(30000));

      if (!scanRes.ok) return res.status(500).json({ error: "Grok scan failed" });
      const data = await scanRes.json() as any;
      const parsed = safeParseLLMJson(data.choices?.[0]?.message?.content, "Routes.podcastTopics") ?? {};
      const topics = parsed.topics ?? [];

      console.log(`[PodcastStudio] Topic scan (${timeframe}) returned ${topics.length} recommendations`);

      // Auto-create draft episodes from scanned topics so they appear in the pipeline
      const created: any[] = [];
      for (const t of topics) {
        try {
          const ep = createEpisode({
            type: "the_signal" as const,
            title: t.title ?? "Untitled",
            drivingQuestion: t.drivingQuestion ?? t.pitch ?? "",
          });
          if (ep) created.push(ep);
        } catch {}
      }
      console.log(`[PodcastStudio] Created ${created.length} draft episodes from scan (${timeframe})`);
      res.json({ ok: true, topics, created: created.length, timeframe });
    } catch (e: any) {
      console.error("[PodcastStudio] Topic scan error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PODCAST PIPELINE — Research Thread → Episode ─────────────────────────

  // Manually trigger episode generation from a specific research thread.
  // Creates a draft episode immediately (so the UI shows it right away),
  // then generates the script in the background.
  app.post("/api/podcast/generate-from-thread/:threadId", async (req, res) => {
    try {
      console.log(`[PodcastStudio] Generate-from-thread request for ${req.params.threadId}`);
      const episode = await generateEpisodeFromThread(req.params.threadId);
      if (!episode) {
        console.error(`[PodcastStudio] Failed to create episode from thread ${req.params.threadId} — returned null`);
        return res.status(500).json({ error: "Failed to generate episode from thread" });
      }
      console.log(`[PodcastStudio] Returning episode ${episode.id} (status: ${episode.status}) — script generating in background`);
      res.json({ ok: true, episode });
    } catch (e: any) {
      console.error(`[PodcastStudio] Episode generation error for thread ${req.params.threadId}:`, e.message);
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
  // DISABLED: X replies turned off — Agent 306 only posts original content
  app.post("/api/replies/run", async (_req, res) => {
    if (!process.env.X_REPLIES_ENABLED) {
      res.json({ ok: false, message: "X replies are globally disabled (set X_REPLIES_ENABLED=true to re-enable)" });
      return;
    }
    res.json({ ok: true, message: "Reply cycle starting — Agent 306 is engaging now..." });
    runMidnightReplies(xWrite).catch(console.error);
  });

  // POST /api/replies/fetch-and-run — fetch fresh mentions then immediately reply
  // DISABLED: X replies turned off — Agent 306 only posts original content
  app.post("/api/replies/fetch-and-run", async (_req, res) => {
    if (!process.env.X_REPLIES_ENABLED) {
      res.json({ ok: false, message: "X replies are globally disabled (set X_REPLIES_ENABLED=true to re-enable)" });
      return;
    }
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

  // ── Auto-Follow System ──────────────────────────────────────────
  // GET follow targets list
  app.get("/api/follow/targets", (_req, res) => {
    res.json(getFollowTargets());
  });

  // POST process the follow queue (follows up to 3 unfollowed targets)
  app.post("/api/follow/process", async (_req, res) => {
    try {
      const result = await processFollowQueue(xClient);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[AutoFollow] Process error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST add a new follow target
  app.post("/api/follow/add", (req, res) => {
    const { username, category, reason, priority } = req.body ?? {};
    if (!username || typeof username !== "string") {
      return res.status(400).json({ error: "username is required" });
    }
    try {
      const target = addFollowTarget(
        username.trim().replace(/^@/, ""),
        category ?? "Uncategorized",
        reason ?? "",
        typeof priority === "number" ? priority : 3,
      );
      res.json({ ok: true, target });
    } catch (err: any) {
      res.status(409).json({ ok: false, error: err.message });
    }
  });

  // DELETE remove a follow target
  app.delete("/api/follow/:username", (req, res) => {
    const removed = removeFollowTarget(req.params.username);
    if (!removed) {
      return res.status(404).json({ ok: false, error: "Target not found" });
    }
    res.json({ ok: true, message: `Removed @${req.params.username} from follow targets` });
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
        const compliance = validateXPost(tweet.trim());
        if (!compliance.allowed) {
          console.log(`[CommunityBoost] Skipped by compliance: ${compliance.reason}`);
        } else {
          const safeText = enforcePostFormat(compliance.sanitizedContent ?? tweet.trim());
          const result = await xWrite.v2.tweet({ text: safeText });
          const tweetId = result.data?.id;
          tweetUrl = tweetId ? `https://x.com/306Agent/status/${tweetId}` : null;
          recordXPost(safeText);
        }
      } catch (xErr: any) {
        console.error("[CommunityBoost] X post failed:", xErr.message);
      }

      // Queue for Farcaster
      try {
        if (tweet.trim().length > 10) {
          queueFarcasterPost(tweet.trim().slice(0, 2500), "roundup", undefined, "nft");
          castUrl = "queued";
          console.log(`[CommunityBoost] Farcaster cast queued`);
        }
      } catch (fcErr: any) {
        console.warn("[CommunityBoost] Farcaster queue failed:", fcErr.message);
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
        const resp = await postChatCompletions({
            model: getModel("research-brief"),
            messages: [
              { role: "system", content: `${agentCtx}\n\nKNOWLEDGE:\n${kbCtx}\n\nYou are Agent 306 writing a [306 ACADEMY] brief. This is a deeper analytical piece on a specific AI or crypto topic you\'ve been investigating. Write from your knowledge base — reference specific findings, data points, and your own analysis. Your voice is direct, substantive, and insightful. Not a news summary — this is YOUR research perspective.\n\nRULES:\n- Write 800-1200 characters for X posting\n- Lead with your thesis, not background\n- Include specific data, names, or numbers\n- End with a forward-looking insight\n- Tag: [306 ACADEMY]\n- Sign: @306Agent\n- NEVER reference any prior project identity, NFT communities, burns, or holders\n\nReturn JSON: {"post": "your full research brief text", "topic": "2-4 word topic label"}` },
              { role: "user", content: "Write a [306 ACADEMY] brief on the most important topic from your current knowledge base. Pick something timely and substantive." }
            ],
            max_tokens: 2000,
            temperature: 0.8,
          }, AbortSignal.timeout(60000));
        if (!resp.ok) { console.error("[ResearchBrief] LLM failed:", resp.status); return; }
        const data = await resp.json();
        const raw = data.choices?.[0]?.message?.content ?? "";
        let postText = "";
        postText = safeParseLLMJson(raw, "Routes.researchBrief")?.post ?? "";
        if (!postText && raw.length > 30) postText = raw;
        if (!postText || postText.length < 30) { console.error("[ResearchBrief] No content generated"); return; }

        // Enforce [306 ACADEMY] show tag
        postText = enforceShowTag(postText, "research");
        const trimmed = postText.trim();
        if (trimmed.length < 10) { console.error("[ResearchBrief] Content too short after enforce"); return; }

        // Respect the research engine's auto-post toggle. Default as of
        // 2026-04-21 is autoPost=false — route to the tweet drafts inbox
        // instead of queuing straight to X/FC, matching the main
        // generate handler's behaviour. The user explicitly reported
        // that research briefs were bypassing drafts via this path.
        if (!shouldAutoPost("research", false)) {
          try {
            const draft = saveTweetDraft({
              engine: "research",
              content: trimmed,
              platforms: ["x", "farcaster"],
            });
            registerPost("cyoa", "drafted", "research_brief");
            console.log(`[ResearchBrief] autoPost=false — saved as draft ${draft.draftId}`);
          } catch (e: any) { console.error("[ResearchBrief] Draft save failed:", e.message); }
          return;
        }

        // Queue for X via scheduler (high priority) instead of direct posting
        try {
          queueXPost(trimmed, "research", 2);
          registerPost("cyoa", "queued", "research_brief");
          console.log("[ResearchBrief] Queued for X posting via scheduler");
        } catch (e: any) { console.error("[ResearchBrief] Queue failed:", e.message); }

        // Queue for Farcaster (alongside X queue)
        try {
          queueFarcasterPost(trimmed.slice(0, 2500), "research", undefined, "ai");
          console.log("[ResearchBrief] Farcaster cast queued");
        } catch (e: any) { console.error("[ResearchBrief] Farcaster queue failed:", e.message); }
      } catch (e: any) { console.error("[ResearchBrief] Error:", e.message); }
    })();
  });

  // Generate a new CYOA episode
  app.post("/api/cyoa/generate", async (req, res) => {
    const { trigger, context } = req.body;
    const grokKey = LLM_API_KEY;
    if (!grokKey) return res.status(500).json({ error: "No LLM key" });

    const episode = await generateCYOAEpisode({
      trigger: (trigger ?? "industry_news") as CYOATrigger,
      context: context ?? undefined,
      grokKey,
    });

    if (!episode) return res.status(500).json({ error: "Generation failed" });
    res.json({ ok: true, episode });
  });

  // Post the hook tweet for a CYOA episode
  app.post("/api/cyoa/post/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const tweetId = await postCYOAHook(id, xWrite);
      if (!tweetId) return res.status(500).json({ error: "Post failed — check logs" });
      res.json({ ok: true, tweetId, url: `https://x.com/306Agent/status/${tweetId}` });
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

  app.delete("/api/episodes/:id", (req, res) => {
    const ok = storage.deleteEpisode(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: "Episode not found" });
    res.json({ ok: true });
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
              model: nativeGrokKey ? "grok-4-1-fast-non-reasoning" : getModel("x_search"),
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
        grokNews,
        nftByChain,
        memeCoins,
        aiNews,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[news] error:", err);
      res.status(500).json({ error: "News fetch failed", market: [], headlines: [], grokNews: null, nftByChain: [], memeCoins: [], aiNews: [] });
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
    // Optional grounding source URLs (issue 5) — passed to the writer + revise
    // loop as canonical citation targets to reduce hallucinations.
    const groundingSourcesIn = Array.isArray(req.body?.groundingSources) ? req.body.groundingSources : [];
    const groundingSources = groundingSourcesIn
      .map((u: any) => (typeof u === "string" ? u.trim() : ""))
      .filter((u: string) => /^https?:\/\//i.test(u))
      .slice(0, 25);
    const skipReviseLoop = req.body?.skipReviseLoop === true;
    try {
      const preview = await previewDeepRead(apiKey, { overrideUrl, groundingSources, skipReviseLoop });
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
  // As of 2026-04-21 the weekly Deep Read is generated on cron but NOT
  // posted — published manually via X's Article composer. See drafts API
  // below; runWeeklyDeepRead() saves to drafts instead of posting.

  // ── Deep Read drafts ─────────────────────────────────────────
  // Drafts are produced by the weekly cron and by on-demand previews the
  // user chooses to save. They are NOT queued for X — the user copies them
  // into X's Article composer and marks them posted when published.

  app.get("/api/article/drafts", (_req, res) => {
    try {
      res.json({ drafts: listDeepReadDrafts() });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to list drafts" });
    }
  });

  app.post("/api/article/drafts", requireDashAuth, async (req, res) => {
    const { headline, teaser, body, sourceUrl, sourceTitle, imageUrl } = req.body ?? {};
    const incomingRevisionHistory = Array.isArray(req.body?.revisionHistory) ? req.body.revisionHistory : undefined;
    const incomingGroundingSources = Array.isArray(req.body?.groundingSources)
      ? req.body.groundingSources.filter((u: any) => typeof u === "string" && /^https?:\/\//i.test(u))
      : undefined;
    const incomingSourceText = typeof req.body?.sourceText === "string" ? req.body.sourceText : undefined;
    if (!headline || !body || !sourceUrl || !sourceTitle) {
      return res.status(400).json({ error: "headline, body, sourceUrl, sourceTitle required" });
    }
    try {
      // Server-side verification: we do not trust any `verification` field
      // the client might send — the verifier runs here against freshly
      // fetched source text. On failure the draft is saved with
      // status='quarantined' rather than silently accepted, matching the
      // cron path's behavior. See server/claimVerifier.ts and the
      // 2026-04-24 v2 Politico incident notes.
      let unsupportedClaims: Array<{ sentence: string; lane: string; reason: string }> | undefined;
      let verifierReport: VerifierReport | undefined;
      let quarantineReason: string | undefined;
      let status: "ok" | "quarantined" | "needs_revision" = "ok";
      try {
        const fetched = await fetchSourceContent(String(sourceUrl));
        if (fetched.ok && fetched.text.length >= 500) {
          const verdict = await verifyClaims({
            draftText:   String(body),
            sourceText:  fetched.text,
            sourceUrl:   String(sourceUrl),
            sourceTitle: String(sourceTitle),
          });
          verifierReport = verdict.verifierReport;
          if (verdict.severity === "HARD_FAIL") {
            status = "needs_revision";
            unsupportedClaims = verdict.unsupportedClaims as any;
            quarantineReason = `${verdict.unsupportedClaims.length} unsupported claims`;
            console.warn(
              `[ArticleDrafts] QUARANTINED incoming draft: ${quarantineReason}`,
            );
            for (const c of verdict.unsupportedClaims) {
              console.warn(`  - [${c.lane}] ${c.reason}: ${c.sentence.slice(0, 180)}`);
            }
          }
        } else {
          console.warn(
            `[ArticleDrafts] Source unavailable for ${sourceUrl} (${fetched.reason ?? "unknown"}); saving draft without verification but marking as quarantined.`,
          );
          status = "needs_revision";
          quarantineReason = `source unavailable: ${fetched.reason ?? "unknown"}`;
        }
      } catch (verifyErr: any) {
        console.warn(
          `[ArticleDrafts] Verification step threw: ${verifyErr?.message ?? verifyErr} — saving as quarantined to be safe`,
        );
        status = "needs_revision";
        quarantineReason = `verifier error: ${verifyErr?.message ?? verifyErr}`;
      }

      const draft = saveDeepReadDraft({
        headline:    String(headline),
        teaser:      String(teaser ?? ""),
        body:        String(body),
        sourceUrl:   String(sourceUrl),
        sourceTitle: String(sourceTitle),
        imageUrl:    imageUrl ? String(imageUrl) : undefined,
        status,
        quarantineReason,
        unsupportedClaims: unsupportedClaims as any,
        verifierReport,
        revisionHistory: incomingRevisionHistory,
        groundingSources: incomingGroundingSources,
        sourceText: incomingSourceText,
      });
      if (verifierReport?.severity === "HARD_FAIL") {
        return res.status(422).json({ ok: false, draft, verifierReport });
      }
      res.json({ ok: true, draft, verifierReport });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to save draft" });
    }
  });

  app.post("/api/article/drafts/:id/mark-posted", requireDashAuth, (req, res) => {
    const tweetUrl: string | undefined = req.body?.tweetUrl;
    const result = markDeepReadDraftPosted(req.params.id, tweetUrl);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true });
  });

  app.delete("/api/article/drafts/:id", requireDashAuth, (req, res) => {
    const result = deleteDeepReadDraft(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true });
  });

  // ── Per-draft resources + auto-revise (issues 2 & 3) ────────────────
  // Operator workflow:
  //   1. POST /api/article/drafts/:id/resources  body: { urls: [], note }
  //   2. POST /api/article/drafts/:id/revise     body: { operatorNote }
  //
  // The two endpoints are independent — you can revise without adding new
  // resources (e.g. retry the loop after env tuning), or add resources
  // without immediately re-revising (queue them for later).

  app.get("/api/article/drafts/:id", (req, res) => {
    const draft = getDeepReadDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: "draft not found" });
    res.json({ draft });
  });

  app.post("/api/article/drafts/:id/resources", requireDashAuth, (req, res) => {
    const urls: unknown = req.body?.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: "urls (array) is required" });
    }
    const cleaned = urls
      .map(u => (typeof u === "string" ? u.trim() : ""))
      .filter(u => /^https?:\/\//i.test(u))
      .slice(0, 25);
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 1000) : undefined;
    const updated = addDraftResources(String(req.params.id), cleaned, note);
    if (!updated) return res.status(404).json({ error: "draft not found" });
    res.json({ ok: true, draft: updated, added: cleaned.length });
  });

  app.post("/api/article/drafts/:id/revise", requireDashAuth, async (req, res) => {
    const operatorNote = typeof req.body?.operatorNote === "string" ? req.body.operatorNote.slice(0, 2000) : undefined;
    try {
      const out = await reviseDraftWithResources(String(req.params.id), { operatorNote });
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.json({ ok: true, draft: out.draft, revisionHistory: out.revisionHistory });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Revise failed" });
    }
  });

  // ── Tweet drafts (podcast / breakthrough / blog) ─────────────
  // Short-form tweet drafts generated by engines whose autoPost toggle
  // is OFF. Separate from Deep Read's long-form article drafts.

  const VALID_TWEET_ENGINES: TweetDraftEngine[] = ["podcast", "breakthrough", "blog"];

  app.get("/api/tweet-drafts", (req, res) => {
    try {
      const engine = typeof req.query.engine === "string" ? req.query.engine : undefined;
      if (engine && !(VALID_TWEET_ENGINES as string[]).includes(engine)) {
        return res.status(400).json({
          error: `Invalid engine "${engine}". Valid: ${VALID_TWEET_ENGINES.join(", ")}`,
        });
      }
      res.json({ drafts: listTweetDrafts(engine as TweetDraftEngine | undefined) });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to list tweet drafts" });
    }
  });

  app.post("/api/tweet-drafts", requireDashAuth, (req, res) => {
    const { engine, content, platforms, metadata } = req.body ?? {};
    if (!engine || !(VALID_TWEET_ENGINES as string[]).includes(engine)) {
      return res.status(400).json({
        error: `engine required; valid: ${VALID_TWEET_ENGINES.join(", ")}`,
      });
    }
    if (!content || typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content required" });
    }
    try {
      const draft = saveTweetDraft({
        engine:    engine as TweetDraftEngine,
        content:   String(content).trim(),
        platforms: Array.isArray(platforms) ? platforms.map(String) : undefined,
        metadata:  metadata && typeof metadata === "object" ? metadata : undefined,
      });
      res.json({ ok: true, draft });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to save tweet draft" });
    }
  });

  app.post("/api/tweet-drafts/:id/mark-posted", requireDashAuth, (req, res) => {
    const postedUrl: string | undefined = req.body?.postedUrl;
    const result = markTweetDraftPosted(req.params.id, postedUrl);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true });
  });

  app.delete("/api/tweet-drafts/:id", requireDashAuth, (req, res) => {
    const result = deleteTweetDraft(req.params.id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true });
  });

  // ── Unified drafts inbox ─────────────────────────────────────
  // Aggregates Deep Read (long-form article) drafts and short-form tweet
  // drafts into a single list the dashboard /drafts page can render.
  // Each record shares a common envelope: { source, id, engine, generatedAt, ... }.

  app.get("/api/drafts", (req, res) => {
    try {
      const engine = typeof req.query.engine === "string" ? req.query.engine : undefined;
      const articleDrafts = listDeepReadDrafts().map(d => ({
        source:      "article" as const,
        id:          d.draftId,
        engine:      "article" as const,
        generatedAt: d.generatedAt,
        headline:    d.headline,
        teaser:      d.teaser,
        body:        d.body,
        content:     d.body, // unified "content" alias for copy-to-clipboard
        sourceUrl:   d.sourceUrl,
        sourceTitle: d.sourceTitle,
        imageUrl:    d.imageUrl,
        status:      d.status,
        quarantineReason: d.quarantineReason,
        unsupportedClaims: d.unsupportedClaims,
        verifierReport: d.verifierReport,
      }));
      const tweetDrafts = listTweetDrafts().map(d => ({
        source:      "tweet" as const,
        id:          d.draftId,
        engine:      d.engine,
        generatedAt: d.generatedAt,
        content:     d.content,
        platforms:   d.platforms,
        metadata:    d.metadata,
      }));
      let merged: Array<typeof articleDrafts[number] | typeof tweetDrafts[number]> =
        [...articleDrafts, ...tweetDrafts];
      if (engine) merged = merged.filter(d => d.engine === engine);
      // Newest first
      merged.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
      res.json({
        drafts: merged,
        counts: {
          total:          merged.length,
          article:        articleDrafts.length,
          article_tweet:  tweetDrafts.filter(d => d.engine === "article").length,
          podcast:        tweetDrafts.filter(d => d.engine === "podcast").length,
          breakthrough:   tweetDrafts.filter(d => d.engine === "breakthrough").length,
          blog:           tweetDrafts.filter(d => d.engine === "blog").length,
          research:       tweetDrafts.filter(d => d.engine === "research").length,
          reflection:     tweetDrafts.filter(d => d.engine === "reflection").length,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to list drafts" });
    }
  });

  // ── Engine auto-post toggle ──────────────────────────────────
  // Flip the per-engine autoPost flag. Separate from the existing
  // /api/engines/:engineId/schedule endpoint so the UI can expose a
  // simple toggle without touching cadence/time fields.

  app.put("/api/engines/:engineId/auto-post", requireDashAuth, (req, res) => {
    const { engineId } = req.params;
    const { autoPost } = req.body ?? {};
    if (typeof autoPost !== "boolean") {
      return res.status(400).json({ error: "autoPost (boolean) required in body" });
    }
    try {
      const config = updateEngineSchedule(engineId, { autoPost });
      res.json({ ok: true, engineId, autoPost, schedule: config[engineId] });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to update auto-post setting" });
    }
  });

  // ── Podcast episode URL ──────────────────────────────────────
  // Attach the per-episode Spotify/Apple/agent306.ai URL to a published
  // episode so promos link to the episode itself instead of the site home.

  app.put("/api/podcast/episodes/:id/episode-url", requireDashAuth, (req, res) => {
    const episodeUrl: string | null = req.body?.episodeUrl ?? null;
    if (episodeUrl !== null && typeof episodeUrl !== "string") {
      return res.status(400).json({ error: "episodeUrl must be a string or null" });
    }
    try {
      const episode = setEpisodeUrl(req.params.id, episodeUrl);
      if (!episode) return res.status(404).json({ error: "episode not found" });
      res.json({ ok: true, episode });
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? "Failed to set episode URL" });
    }
  });

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
      const res = await postChatCompletions({
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
        }, AbortSignal.timeout(25000));

      if (!res.ok) return;
      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "{}";
      let parsed: any = safeParseLLMJson(raw, "Routes.memoryExtraction") ?? {};
      if (!parsed || Object.keys(parsed).length === 0) return;

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
      const response = await postChatCompletions({
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

ACTIONS — You can take real actions, not just talk. When appropriate, include an "actions" array in your response:

Available actions:
- {"type": "generate_episode", "topic": "the topic", "drivingQuestion": "the driving question"} — Creates a real podcast episode in Podcast Studio
- {"type": "generate_blog", "topic": "title for the blog post", "content": "the full blog post content if you have it — otherwise just provide the topic and it will be auto-generated"} — Creates a blog post in Blog Studio. If you wrote blog-worthy content in your response, include it here too.
- {"type": "start_research", "topic": "research question", "description": "why this matters"} — Starts a new research thread
- {"type": "add_hypothesis", "claim": "testable claim", "basis": "evidence", "prediction": "expected outcome"} — Registers a formal hypothesis

When MrRayG asks you to generate, create, research, or investigate something — DO IT via actions. Don't just talk about it.
When you recommend an episode topic — include the action to create it.
If no actions needed, omit the "actions" field or set it to [].

RESPOND ONLY AS VALID JSON — no other text:
{"text": "your response here", "mood": "thinking|direct|questioning|reporting", "needsHelp": true_or_false, "reasoning": "1-2 sentence internal note about why you chose this angle", "actions": []}

mood guide: thinking=analysis, direct=position/news, questioning=need MrRayG input, reporting=status update
needsHelp: true only when you genuinely need his direction or information`,
            },
            ...conversationHistory,
            { role: "user", content: text },
          ],
          max_tokens: 2500,
          temperature: 0.6,
        }, AbortSignal.timeout(40000));

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

      // ── Execute any actions 306 requested ──────────────────────────────────
      // Action plumbing was rewritten in PR #252 to fix two architectural bugs:
      //   1. Slash-grammar parser treated `/blog revise quarantined` as a
      //      topic-bearing /blog command, spawning a meta-blog about its own
      //      quarantine state (incident 2026-04-29: "When the System Blocks
      //      Itself" auto-spawn). New parser reserves verbs (revise/publish/list)
      //      and routes them to non-spawn actions.
      //   2. Agent-emitted actions bypassed all gating. 306 could narrate "I will
      //      not take any further action" while emitting generate_blog in the
      //      same response. New coherence check scans the agent's narrative for
      //      refusal phrases and suppresses agent-emitted actions when found.
      // The full grammar + refusal phrases live in server/chatActionGate.ts.
      const agentActions: ActionPlan[] = parsed.actions ?? [];
      // Each entry tracks the proposed action AND its provenance, so the
      // sub-action gate (PR #253) can apply the right policy. PR #252 only
      // tracked the action itself; PR #253 carries (action, origin) all the
      // way to the engine call.
      const actions: Array<{ action: ActionPlan; userAuthorized: boolean }> = [];
      const actionResults: string[] = [];
      const suppressedActions: Array<{ action: ActionPlan; reason: string; matchedPhrase?: string }> = [];
      // PR #253 — chat turn id used by ActionGuard audit log to correlate
      // gate decisions with the conversation.
      const turnId = `turn_${Date.now()}`;

      // (a) Coherence check on agent-emitted actions.
      if (agentActions.length > 0 && parsed.text) {
        const coherence = checkAgentCoherence(parsed.text);
        if (coherence.refusalDetected) {
          for (const a of agentActions) {
            suppressedActions.push({
              action: a,
              reason: "agent-narrative-refusal",
              matchedPhrase: coherence.matchedPhrase,
            });
          }
          console.warn(
            `[Chat Actions] Coherence violation — ${agentActions.length} agent action(s) suppressed. ` +
            `Matched refusal phrase: "${coherence.matchedPhrase}"`,
          );
        } else {
          // Agent-emitted actions that PASS coherence are still NOT user-
          // authorized — the user did not explicitly ask for them. The
          // sub-action gate will deny these (chat_agent_emitted is not on
          // the allowlist). They are queued so the audit log records the
          // attempt and the user sees a clear suppression notice.
          for (const a of agentActions) actions.push({ action: a, userAuthorized: false });
        }
      }

      // (b) User-side parse: only runs if the agent didn't already enqueue an action.
      if (actions.length === 0 && parsed.text) {
        const parseResult = parseUserMessage(text || "", parsed.text);
        if (parseResult.action) {
          // Slash commands and quoted-imperatives ARE explicit user authorization.
          actions.push({ action: parseResult.action, userAuthorized: true });
          console.log(`[Chat Actions] Explicit ${parseResult.action.type} request from user message`);
        } else if (parseResult.rejectedReason && parseResult.rejectedReason !== "no-slash-or-imperative") {
          console.log(`[Chat Actions] Suppressed (${parseResult.rejectedReason}): "${(text || "").slice(0, 120)}"`);
        }
      }

      for (const { action, userAuthorized } of actions) {
        // PR #253 — every action goes through the deny-by-default sub-action
        // gate. The gate decides allow/deny based on (action.type, ctx);
        // ctx.origin is chat_user_command for parser-derived actions and
        // chat_agent_emitted for actions 306 emitted in its response. The
        // latter is NOT on the allowlist, so even if it cleared the
        // coherence check it will be denied here — audit-logged and
        // surfaced to the user.
        const ctx: ActionContext = {
          origin: userAuthorized ? "chat_user_command" : "chat_agent_emitted",
          userAuthorized,
          turnId,
        };
        const guardedActionType = action.type as GuardedActionType;
        const payloadFingerprint =
          (action as any).topic ??
          (action as any).draftId ??
          (action as any).claim ??
          undefined;

        try {
          await guardedExecute(
            guardedActionType,
            ctx,
            async () => {
              switch (action.type) {
                case "generate_episode": {
                  const { createEpisode, generateEpisodeScript } = await import("./podcastEngine.js");
                  const episode = createEpisode({
                    type: "the_signal",
                    title: action.topic || "Untitled Episode",
                    drivingQuestion: action.drivingQuestion || action.topic || "",
                  });
                  // Generate script in the background — chat returns immediately
                  generateEpisodeScript(episode.id, apiKey, action.content).catch(e =>
                    console.warn("[Chat Action] Script generation failed:", e.message)
                  );
                  actionResults.push(`Created episode "${episode.title}" in Podcast Studio (${episode.id}). Script is being generated.`);
                  console.log(`[Chat Action] Created episode: ${episode.id} — "${episode.title}"`);
                  return;
                }

                case "generate_blog": {
                  const { generateBlogPostMaybeViaPipeline } = await import("./pipeline/blogPipelineEntry.js");
                  const sourceContent = action.content || parsed.text || "";
                  const topic = action.topic || action.title || "Agent 306 Blog Post";
                  const { post } = await generateBlogPostMaybeViaPipeline({
                    topic,
                    sourceContent: sourceContent.slice(0, 4000),
                    source: "chat",
                    autoPublish: false,
                  });
                  if (post) {
                    actionResults.push(`Generated blog draft "${post.title}" in Blog Studio. Review and publish when ready.`);
                    console.log(`[Chat Action] Generated blog draft: ${post.id} — "${post.title}"`);
                  } else {
                    actionResults.push(`Blog generation failed — try again or create manually in Blog Studio.`);
                  }
                  return;
                }

                case "start_research": {
                  const { createThread } = await import("./research-agenda.js");
                  const thread = createThread({
                    title: action.topic || "New Research",
                    thesis: action.description || "",
                    source: "chat",
                  });
                  actionResults.push(`Started research thread: "${thread.title}" (${thread.id})`);
                  console.log(`[Chat Action] Created research thread: ${thread.id} — "${thread.title}"`);
                  return;
                }

                case "revise_blog": {
                  const { reviseQuarantinedBlogPost } = await import("./blogRevisePipeline.js");
                  const draftId = (action as any).draftId;
                  if (!draftId) {
                    actionResults.push(`Revise failed: no draft id provided.`);
                    return;
                  }
                  const out = await reviseQuarantinedBlogPost(draftId);
                  if (!out.found) {
                    actionResults.push(`Revise failed: no draft found with id "${draftId}".`);
                  } else if (out.outcome === "published") {
                    actionResults.push(`Revised draft "${out.title}" passed verifier and was published.`);
                  } else if (out.outcome === "updated_draft") {
                    actionResults.push(`Revised draft "${out.title}" — still ${out.severity}; saved as updated draft for review (${out.unsupportedCount ?? 0} unsupported claim(s)).`);
                  } else {
                    actionResults.push(`Revise failed for draft "${draftId}": ${out.error ?? "unknown error"}.`);
                  }
                  return;
                }

                case "publish_blog": {
                  const draftId = (action as any).draftId;
                  if (!draftId) {
                    actionResults.push(`Publish failed: no draft id provided.`);
                    return;
                  }
                  const post = publishPost(draftId);
                  if (post) {
                    actionResults.push(`Published draft "${post.title}".`);
                  } else {
                    actionResults.push(`Publish failed: no draft found with id "${draftId}".`);
                  }
                  return;
                }

                case "add_hypothesis": {
                  const { addHypothesis } = await import("./researchEngine.js");
                  const hyp = addHypothesis({
                    claim: action.claim || "",
                    basis: action.basis || "",
                    metric: action.metric || "To be determined",
                    prediction: action.prediction || action.claim || "",
                    timeframe: action.timeframe || "3 months",
                    confidence: action.confidence || "medium",
                    source: "chat",
                  });
                  actionResults.push(`Registered hypothesis: "${hyp.claim}" (${hyp.id})`);
                  console.log(`[Chat Action] Added hypothesis: ${hyp.id} — "${hyp.claim}"`);
                  return;
                }
              }
            },
            payloadFingerprint,
          );
        } catch (e: any) {
          if (e instanceof ActionDeniedError) {
            // Surface gate denials the same way coherence suppressions are
            // surfaced — the user sees what was attempted and why it was
            // blocked. This is the visibility 306 explicitly asked for.
            suppressedActions.push({
              action,
              reason: `gate-deny:${e.decision.reason}`,
              matchedPhrase: ctx.origin,
            });
          } else {
            console.error(`[Chat Action] Failed to execute ${action.type}:`, e.message);
            actionResults.push(`Action failed (${action.type}): ${e.message}`);
          }
        }
      }

      // Append action confirmations to the response text
      let responseText = parsed.text || (raw.length > 20 ? raw.replace(/[{}"]/g, "").slice(0, 500) : "Thinking... try again.");
      if (actionResults.length > 0) {
        responseText += "\n\n---\n" + actionResults.join("\n");
      }
      // PR #252 — surface coherence-suppressed actions to MrRayG so a refused
      // action doesn't disappear silently. The user sees what 306 tried to do
      // alongside the reason it was blocked.
      if (suppressedActions.length > 0) {
        const lines = suppressedActions.map(s => {
          const t = (s.action as any).type;
          const topicOrId = (s.action as any).topic || (s.action as any).draftId || "(no topic)";
          // PR #253 — surface gate denials with their specific reason. Coherence
          // suppressions still display the matched phrase as before.
          if (s.reason.startsWith("gate-deny:")) {
            const denyReason = s.reason.slice("gate-deny:".length);
            return `⛔ Action blocked by sub-action gate: ${t} — "${topicOrId}". Origin: ${s.matchedPhrase ?? "unknown"}. Reason: ${denyReason}.`;
          }
          return `⛔ Action suppressed: ${t} — "${topicOrId}". Reason: agent narrative indicated refusal ("${s.matchedPhrase ?? "—"}").`;
        });
        responseText += "\n\n---\n" + lines.join("\n");
      }

      const agentMsg = {
        id:        `agent_${Date.now()}`,
        role:      "agent",
        text:      responseText,
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
          title: topic.topic || (topic as any).title || "Approved Research",
          thesis: topic.hypothesis || topic.researchQuestion || "",
          status: "active",
          source: "agent_hq_approved",
        });
        console.log(`[Bridge] Agent HQ approval -> Research Agenda thread: "${topic.topic || (topic as any).title}"`);
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
    const { status, resolution, actionWithin24h } = req.body ?? {};
    if (!status || !resolution) return res.status(400).json({ error: "status and resolution required" });
    // Wave 2.3 PR-3 — Post-Resolution Action Gate. Reject before hitting the
    // resolver so API callers get a clear 400 instead of a silent `ok: false`.
    const validation = validateResolutionAction(actionWithin24h);
    if (!validation.ok) {
      return res.status(400).json({ error: `actionWithin24h invalid: ${validation.reason}` });
    }
    const ok = resolveHypothesis(id, status, resolution, validation.action);
    res.json({ ok });
  });

  // POST /api/research/hypothesis/test/:id — manual transition to "testing"
  app.post("/api/research/hypothesis/test/:id", requireDashAuth, (req, res) => {
    const ok = testHypothesis(req.params.id);
    if (!ok) return res.status(400).json({ error: "Hypothesis not found or not in 'forming' status" });
    res.json({ ok, status: "testing" });
  });

  // POST /api/research/hypothesis/evaluate/:id — run full evaluation pipeline
  app.post("/api/research/hypothesis/evaluate/:id", requireDashAuth, async (req, res) => {
    try {
      const lab = getResearchLab();
      const hyp = lab.hypotheses.find(h => h.id === req.params.id);
      if (!hyp) return res.status(404).json({ error: "Hypothesis not found" });

      const { knowledge: kb } = await import("./memoryEngine.js");
      const kbContext = kb.entries
        .filter((e: any) => (e.status ?? "active") === "active")
        .slice(0, 30)
        .map((e: any) => `- [${e.category}] ${e.title}: ${e.summary}`)
        .join("\n");

      const assessment = await evaluateHypothesis(
        { id: hyp.id, claim: hyp.claim, basis: hyp.basis, metric: hyp.metric, prediction: hyp.prediction, timeframe: hyp.timeframe, confidence: hyp.confidence },
        kbContext,
      );
      if (!assessment) return res.status(500).json({ error: "Evaluation failed" });
      res.json({ assessment });
    } catch (e: any) {
      res.status(500).json({ error: "Evaluation error: " + e.message });
    }
  });

  // GET /api/hypotheses/clusters — preview similar hypothesis clusters without merging
  app.get("/api/hypotheses/clusters", async (_req, res) => {
    try {
      const { findHypothesisClusters } = await import("./hypothesisConsolidator.js");
      const clusters = await findHypothesisClusters(3);
      res.json({
        totalClusters: clusters.length,
        totalHypotheses: clusters.reduce((s, c) => s + c.members.length, 0),
        clusters: clusters.map(c => ({
          representative: c.representative.claim.slice(0, 100),
          memberCount: c.members.length,
          members: c.members.map(m => ({ id: m.id, claim: m.claim.slice(0, 100), status: m.status })),
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/hypotheses/consolidate — run hypothesis consolidation
  app.post("/api/hypotheses/consolidate", async (req, res) => {
    try {
      const { consolidateHypotheses } = await import("./hypothesisConsolidator.js");
      const dryRun = req.query.dryRun === "true";
      const result = await consolidateHypotheses({ dryRun });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/hypotheses/reset — force-run the hypothesis queue archive/reset
  app.post("/api/hypotheses/reset", requireDashAuth, async (_req, res) => {
    try {
      const { forceHypothesisQueueReset } = await import("./archiveHypotheses.js");
      const result = forceHypothesisQueueReset();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reasoning/trust-scores — view all hypothesis trust scores
  app.get("/api/reasoning/trust-scores", async (_req, res) => {
    try {
      const scores = await getAllTrustScores();
      res.json({ trustScores: scores });
    } catch (e: any) {
      res.status(500).json({ error: "Failed to calculate trust scores" });
    }
  });

  // POST /api/reasoning/batch-evaluate — batch evaluate up to 50 hypotheses
  app.post("/api/reasoning/batch-evaluate", requireDashAuth, async (_req, res) => {
    try {
      const lab = getResearchLab();
      const forming = lab.hypotheses.filter(h => h.status === "forming").slice(0, 50);
      if (forming.length === 0) return res.json({ evaluated: 0, message: "No forming hypotheses to evaluate" });

      res.json({ started: true, count: forming.length, message: `Evaluating ${forming.length} hypotheses in background` });

      // Run in background
      const { knowledge: kb } = await import("./memoryEngine.js");
      const kbContext = kb.entries
        .filter((e: any) => (e.status ?? "active") === "active")
        .slice(0, 30)
        .map((e: any) => `- [${e.category}] ${e.title}: ${e.summary}`)
        .join("\n");

      let evaluated = 0;
      for (const hyp of forming) {
        try {
          const assessment = await evaluateHypothesis(
            { id: hyp.id, claim: hyp.claim, basis: hyp.basis, metric: hyp.metric, prediction: hyp.prediction, timeframe: hyp.timeframe, confidence: hyp.confidence },
            kbContext,
          );
          if (assessment) {
            evaluated++;
            if (assessment.verdict === "testing") {
              testHypothesis(hyp.id);
            }
          }
          // Rate limit
          await new Promise(r => setTimeout(r, 5000));
        } catch (e: any) {
          console.warn(`[BatchEval] Failed for "${hyp.claim.slice(0, 50)}":`, e.message);
        }
      }
      console.log(`[BatchEval] Complete: ${evaluated}/${forming.length} hypotheses evaluated`);
    } catch (e: any) {
      console.error("[BatchEval] Error:", e.message);
    }
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

  // Public manuscript page. The X post composer (`generateResearchContent`)
  // advertises `https://agent306.ai/research/<id>` in every 306 Research post,
  // but no route served that path — every posted link 404'd. This renders the
  // manuscript read from the same `research_lab.json` the engine writes to,
  // using the same id. Registered before `serveStatic` so the SPA catchall
  // never swallows it.
  app.get("/research/:id", (req, res) => {
    const { status, html } = renderResearchManuscriptPage(req.params.id);
    res.status(status).type("html").send(html);
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
  app.post("/api/research/reset", requireDashAuth, (_req, res) => {
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
    // Write back via the goalRepository so the change lands DB-first
    // post-migration. Mirror to JSON when the live file is still present
    // (pre-migration / legacy readers); once renamed to .bak, DB is canonical.
    const { writeGoalsBlob } = require("./repositories/goalRepository.js");
    const { isDbStateEnabled } = require("./repositories/jsonFallback.js");
    const fsMod = require("fs");
    const { dataPath: dp } = require("./dataPaths.js");
    store.lastUpdated = new Date().toISOString();
    let dbOk = false;
    if (isDbStateEnabled()) {
      try { writeGoalsBlob(store); dbOk = true; } catch {}
    }
    const goalsFile = dp("agent_goals.json");
    if (!dbOk || fsMod.existsSync(goalsFile)) {
      fsMod.writeFileSync(goalsFile, JSON.stringify(store, null, 2));
    }
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
    const { writeGoalsBlob } = require("./repositories/goalRepository.js");
    const { isDbStateEnabled } = require("./repositories/jsonFallback.js");
    const fs = require("fs");
    const { dataPath } = require("./dataPaths.js");
    let dbOk = false;
    if (isDbStateEnabled()) {
      try { writeGoalsBlob(store); dbOk = true; } catch {}
    }
    const goalsFile = dataPath("agent_goals.json");
    if (!dbOk || fs.existsSync(goalsFile)) {
      fs.writeFileSync(goalsFile, JSON.stringify(store, null, 2));
    }
    res.json({ ok: true, goal: (goal as any).title });
  });

  app.post("/api/goals/generate", async (_req, res) => {
    try {
      const grokKey = LLM_API_KEY;
      if (!grokKey) return res.status(503).json({ error: "LLM API key not configured" });
      
      console.log("[Goals] Starting goal generation...");
      const goals = await generateInitialGoals(grokKey);
      console.log(`[Goals] Generation returned ${goals.length} goals`);
      
      if (goals.length === 0) {
        const store = getGoals();
        const activeCount = store.goals.filter((g: any) => g.status === "active").length;
        if (activeCount > 0) {
          return res.json({ goals: store.goals, count: activeCount, message: "Already have active goals" });
        }
        return res.status(500).json({ error: "Goal generation returned 0 goals. The LLM may have returned invalid JSON. Check Railway logs." });
      }
      res.json({ goals, count: goals.length });
    } catch (e: any) {
      console.error("[Goals] Route handler error:", e.message);
      res.status(500).json({ error: `Goal generation failed: ${e.message}` });
    }
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

  app.get("/api/public/breakthroughs", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicBreakthroughs());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch breakthroughs" });
    }
  });

  app.get("/api/public/aspirations", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicAspirations());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch aspirations" });
    }
  });

  app.get("/api/public/predictions", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicPredictions());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch predictions" });
    }
  });

  app.get("/api/public/corrections", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicCorrections());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch corrections" });
    }
  });

  app.get("/api/public/eval", (_req, res) => {
    try {
      res.set(publicCacheHeaders).json(getPublicEval());
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch eval" });
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
        const entries = knowledgeState?.entries ?? [];
        const sample = entries.slice(-20); // Last 20 entries
        let totalConnections: any[] = [];
        for (const e of sample) {
          if (e.id && e.title) {
            try {
              const conns = await findGraphConnections(e, "auto_ingest");
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

  app.post("/api/knowledge/graph/rebuild", requireDashAuth, async (_req, res) => {
    try {
      console.log("[Knowledge Graph] Starting full rebuild...");

      // Run clustering first (groups related entries)
      const clusters = await clusterKnowledge();
      console.log(`[Knowledge Graph] Created ${clusters?.length ?? 0} clusters`);

      // Then detect contradictions
      const contradictions = await detectContradictions();
      console.log(`[Knowledge Graph] Found ${contradictions?.length ?? 0} contradictions`);

      // Then run a connection scan
      const connections = await runConnectionScan();
      console.log(`[Knowledge Graph] Discovered ${connections?.length ?? 0} connections`);

      res.json({
        success: true,
        clusters: clusters?.length ?? 0,
        contradictions: contradictions?.length ?? 0,
        connections: connections?.length ?? 0,
      });
    } catch (e: any) {
      console.error("[Knowledge Graph] Rebuild failed:", e.message);
      res.status(500).json({ error: e.message });
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

  // ── Entity Graph — entity extraction index ──────────────────────────────

  app.get("/api/graph/entities", (_req, res) => {
    try {
      const { getEntityIndex } = require("./entityExtractor.js");
      const index = getEntityIndex();
      res.json(index);
    } catch (e: any) {
      res.status(500).json({ error: "Failed to fetch entity index: " + e.message });
    }
  });

  app.get("/api/graph/entity/:name", (req, res) => {
    try {
      const { findEntriesByEntity } = require("./entityExtractor.js");
      const name = decodeURIComponent(req.params.name);
      if (!name || name.length < 2) {
        return res.status(400).json({ error: "Entity name required (min 2 chars)" });
      }
      const entries = findEntriesByEntity(name);
      res.json({ entity: name, entries, count: entries.length });
    } catch (e: any) {
      res.status(500).json({ error: "Entity lookup failed: " + e.message });
    }
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

  app.post("/api/conversations/purge", requireDashAuth, (_req, res) => {
    const result = purgeStaleRelationships();
    res.json(result);
  });

  // Hard reset — directly overwrites data files (bypasses in-memory cache issues)
  app.post("/api/conversations/reset", (_req, res) => {
    try {
      const relPath = dataPath("relationships.json");
      const insPath = dataPath("conversation-insights.json");
      fs.writeFileSync(relPath, JSON.stringify({ relationships: {}, lastAnalysisAt: null }, null, 2));
      fs.writeFileSync(insPath, JSON.stringify({ insights: [], lastExtractedAt: null }, null, 2));
      console.log(`[Conversations] Hard reset: cleared ${relPath} and ${insPath}`);
      res.json({ success: true, message: "Relationships and insights cleared. Refresh the page." });
    } catch (e: any) {
      console.error("[Conversations] Reset failed:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Metacognition (The Mind) ────────────────────────────────────────────

  // /api/metacognition extracted to diagnosticsRouter.

    // ── Seed demo data ────────────────────────────────────────────────
  // ── Knowledge Tiers ──────────────────────────────────────────────────────
  app.get("/api/knowledge/tiers", (_req, res) => {
    res.json(getKnowledgeTiers());
  });

  // ── Knowledge Consolidation ──────────────────────────────────────────────
  app.get("/api/knowledge/efficiency", requireDashAuth, (_req, res) => {
    const { getKBEfficiencyStats } = require("./knowledgeConsolidator.js");
    const stats = getKBEfficiencyStats();
    res.json(stats);
  });

  app.post("/api/knowledge/consolidate", requireDashAuth, async (_req, res) => {
    try {
      const { runKnowledgeConsolidation } = require("./knowledgeConsolidator.js");
      const result = await runKnowledgeConsolidation();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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

  // ── Public Research Manuscripts API (for agent306.ai site) ────────────
  app.get("/api/public/research/manuscripts", (req, res) => {
    const limit = parseInt(req.query.limit as string) || undefined;
    res.json({ manuscripts: getPublishedManuscripts(limit) });
  });

  app.get("/api/public/research/manuscripts/:id", (req, res) => {
    const manuscript = getPublicManuscriptById(req.params.id);
    if (!manuscript) return res.status(404).json({ error: "Manuscript not found" });
    res.json(manuscript);
  });

  // ── Dashboard Blog Management (auth-protected) ────────────────────────
  app.get("/api/blog/state", requireDashAuth, (_req, res) => {
    res.json(getBlogState());
  });

  // PR #251 — list quarantined / soft-warn news drafts so the dashboard can
  // surface dispatches that the verifier flagged. Newest last (append order).
  // Optional ?limit=N caps the response (default 50, max 500).
  app.get("/api/news/drafts", requireDashAuth, (req, res) => {
    const all = readNewsDrafts();
    const rawLimit = parseInt(String(req.query.limit ?? "50"), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
    res.json({
      total:    all.length,
      drafts:   all.slice(-limit),
    });
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
    const { post } = await generateBlogPostMaybeViaPipeline({
      topic, sourceContent, source: source ?? "standalone", sourceId, autoPublish,
    });
    if (!post) return res.status(500).json({ error: "Blog generation failed" });
    res.json(post);
  });

  // PR #252 — manual revise endpoint for quarantined or draft blog posts.
  // Reads the persisted verifier report off the post, calls the bounded
  // single-attempt revise loop, and persists the result. Idempotent: calling
  // this on a published post or one that already passes is a no-op.
  app.post("/api/blog/posts/:id/revise", requireDashAuth, async (req, res) => {
    try {
      const { reviseQuarantinedBlogPost } = await import("./blogRevisePipeline.js");
      const result = await reviseQuarantinedBlogPost(req.params.id);
      if (!result.found) {
        return res.status(404).json({ error: "post not found", id: req.params.id });
      }
      res.json(result);
    } catch (e: any) {
      console.error("[/api/blog/posts/:id/revise] failed:", e?.message ?? String(e));
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
  });

  app.post("/api/blog/posts/:id/publish", requireDashAuth, (req, res) => {
    const post = publishPost(req.params.id);
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  });

  // POST /api/blog/posts/:id/publish-after-edit — re-runs the claim verifier
  // against the CURRENT post body (possibly edited by the operator or Agent
  // 306 via the chat slash command) and publishes only if the verdict is
  // PASS or SOFT_WARN. HARD_FAIL refuses publication and returns the
  // updated editor_comments so the operator can revise again. Sends
  // `override: true` to publish despite a HARD_FAIL — that path records an
  // explicit operator override on the post and is logged.
  //
  // This closes the gap the audit identified: previously a quarantined post
  // had no path to publish even after edits, because /publish ignored the
  // verifier and /revise auto-revised LLM-side rather than re-checking the
  // operator's manual edits.
  app.post("/api/blog/posts/:id/publish-after-edit", requireDashAuth, async (req, res) => {
    try {
      const { getPostById, updatePost, publishPost } = await import("./blogEngine.js");
      const { verifyClaims } = await import("./claimVerifier.js");
      const { extractClaimsAndComments } = await import("./claimExtractor.js");
      const { getLedgerByDraft, buildSourceContextForVerifier } = await import(
        "./repositories/sourceLedgerRepository.js"
      );

      const post = getPostById(req.params.id);
      if (!post) return res.status(404).json({ error: "post not found", id: req.params.id });
      if (post.status === "published") {
        return res.json({ ok: true, outcome: "no_action", error: "already-published", post });
      }

      const override = req.body?.override === true;
      const overrideReason = (req.body?.overrideReason ?? "").toString().slice(0, 500);

      // Roadmap A1: read the source ledger persisted at draft creation so the
      // re-verifier sees the same source text the original draft was checked
      // against, instead of an empty string. Falls back to empty when no
      // ledger exists (older posts, non-research drafts).
      const ledger = getLedgerByDraft("blog", post.id);
      const ledgerSourceText = ledger ? buildSourceContextForVerifier(ledger.items) : "";
      const ledgerPrimary = ledger?.items.find(i => i.sourceType === "primary") ?? ledger?.items[0];
      const sourceObjectsFromLedger = (ledger?.items ?? []).map(i => ({
        url: i.url,
        title: i.title ?? undefined,
        publisher: i.publisher ?? undefined,
        evidenceExcerpt: i.excerpt ?? undefined,
      }));

      const verdict = await verifyClaims({
        draftText:   post.content,
        sourceText:  ledgerSourceText,
        sourceUrl:   ledgerPrimary?.url ?? "",
        sourceTitle: ledgerPrimary?.title ?? post.title,
        tier:        "blog",
        engine:      "blog_publish_after_edit",
        draftId:     post.id,
      });
      const extraction = extractClaimsAndComments(post.content, verdict.verifierReport, sourceObjectsFromLedger);

      // Persist the fresh verdict + claims regardless of whether we publish,
      // so the dashboard sees current state.
      updatePost(post.id, {
        verifierReport: verdict.verifierReport,
        claims:         extraction.claims,
        references:     extraction.references,
        citationMap:    extraction.citationMap,
        editorComments: extraction.editorComments,
        manualReviewRequired: extraction.manualReviewRequired,
        manualPublishAllowed: extraction.manualPublishAllowed,
      });

      if (verdict.severity === "HARD_FAIL" && !override) {
        return res.status(422).json({
          ok: false,
          outcome: "blocked",
          severity: verdict.severity,
          error: "verifier-hard-fail; pass override:true with overrideReason to publish anyway",
          editorComments: extraction.editorComments,
          unsupportedClaims: verdict.unsupportedClaims,
        });
      }

      if (verdict.severity === "HARD_FAIL" && override) {
        // Tag with "operator-override" so a future audit can find these.
        const tags = Array.from(new Set([...(post.tags ?? []), "operator-override"]));
        updatePost(post.id, { tags });
        console.warn(
          `[Blog] OPERATOR OVERRIDE publish on HARD_FAIL post ${post.id} ("${post.title}") — reason: ${overrideReason || "(none)"}`,
        );
      }

      const published = publishPost(post.id);
      return res.json({
        ok: true,
        outcome: "published",
        severity: verdict.severity,
        post: published,
        editorComments: extraction.editorComments,
      });
    } catch (e: any) {
      console.error("[/api/blog/posts/:id/publish-after-edit] failed:", e?.message ?? String(e));
      res.status(500).json({ error: e?.message ?? "unknown error" });
    }
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

  app.post("/api/blog/purge-conversational", requireDashAuth, (_req, res) => {
    const result = purgeConversationalPosts();
    res.json(result);
  });

  // ── Competency Dashboard ────────────────────────────────────────────────
  app.get("/api/competency", (_req, res) => {
    try {
      const profile = getCompetencyProfile();
      res.json(profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 306Eval, Cycle Context, Sessions, Novelty Gate, Wisdom ────────────
  // Extracted to server/routers/diagnosticsRouter.ts (spec §2). Registered
  // earlier in this function. URLs + response shapes preserved.

  // ── Breaking News (disabled) ───────────────────────────────────────────
  app.get("/api/breaking-news", (_req, res) => {
    res.json({ events: [], count: 0, disabled: true });
  });

  // ── Goal Engine ─────────────────────────────────────────────────
  app.get("/api/goal-engine", async (_req, res) => {
    try {
      const { getGoalEngineHistory, buildGoalContext } = await import("./goalEngine.js");
      const history = getGoalEngineHistory();
      const context = await buildGoalContext();
      res.json({ history: history.runs.slice(0, 10), currentContext: context });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Engine Status & On-Demand Generation ──────────────────────────────────

  // Engine definitions for status + generate
  const ENGINE_DEFS = [
    { id: "signal",       name: "Signal Brief",        schedule: "Mon/Wed/Fri 12pm ET", emoji: "📡", days: [1, 3, 5], hour: 12 },
    { id: "academy",      name: "Academy",              schedule: "Tue/Thu/Sat 10am ET", emoji: "🎓", days: [2, 4, 6], hour: 10 },
    { id: "news",         name: "News Dispatch",        schedule: "Daily 8am ET",        emoji: "📰", days: [0,1,2,3,4,5,6], hour: 8 },
    { id: "research",     name: "Research Brief",       schedule: "On completion",       emoji: "🔬", days: [], hour: 0 },
    { id: "podcast",      name: "Podcast",              schedule: "Research-driven",     emoji: "🎙️", days: [], hour: 0 },
    { id: "article",      name: "Deep Read",            schedule: "Monday 5pm ET",       emoji: "📝", days: [1], hour: 17 },
    { id: "breakthrough", name: "Breakthrough Detector", schedule: "On detection",       emoji: "💡", days: [], hour: 0 },
    { id: "blog",         name: "Blog Post",            schedule: "Via Daily Cycle",     emoji: "✍️",  days: [], hour: 0 },
    { id: "dispatch",     name: "The Dispatch",          schedule: "Weekly",              emoji: "📨", days: [], hour: 0 },
    { id: "reflection",   name: "306 Reflection",        schedule: "Manual trigger",      emoji: "🧠", days: [], hour: 0 },
  ] as const;

  function computeNextRun(days: readonly number[], hour: number): string | null {
    if (days.length === 0) return null;
    const now = new Date();
    // Use Intl to find current ET offset
    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
    const etHour = parseInt(etParts.find(p => p.type === "hour")!.value);
    const utcHour = now.getUTCHours();
    let etOffset = utcHour - etHour;
    if (etOffset < 0) etOffset += 24;

    for (let i = 0; i <= 7; i++) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + i);
      candidate.setUTCHours(hour + etOffset, 0, 0, 0);
      if (candidate > now && (days as readonly number[]).includes(candidate.getUTCDay())) {
        return candidate.toISOString();
      }
    }
    return null;
  }

  // GET /api/engines/status — all engine states (reads schedule from config)
  app.get("/api/engines/status", requireDashAuth, (_req, res) => {
    try {
      const signalState = getSignalBriefState();
      const academyState = getAcademyState();
      const articleState = getArticleState();
      const briefingState = getBriefingState();
      const blogState = getBlogState();
      const schedConfig = getScheduleConfig();

      const lastRuns: Record<string, string | null> = {
        signal:       signalState.lastPostedAt ?? null,
        academy:      academyState.lastPostedAt ?? null,
        news:         null, // news dispatch doesn't expose a persistent lastRun; use coordinator
        research:     null,
        podcast:      null,
        article:      articleState.lastPostedAt ?? null,
        breakthrough: null,
        blog:         blogState.stats?.lastPublishedAt ?? blogState.posts?.[0]?.createdAt ?? null,
        dispatch:     null,
        reflection:   null, // manual-only; no persistent lastRun tracker
      };

      // Try to get dispatch last run from episode tracker
      try {
        const dispatchState = getDispatchState();
        const lastEp = dispatchState.episodes[dispatchState.episodes.length - 1];
        if (lastEp) lastRuns.dispatch = lastEp.publishedAt;
      } catch {}

      // Try to get news last run from coordinator
      try {
        const coordState = getCoordinatorState();
        const newsRecord = coordState.recentPosts?.find((p: any) => p.engineKey === "news_dispatch");
        if (newsRecord) lastRuns.news = newsRecord.postedAt;
      } catch {}

      const engines = ENGINE_DEFS.map(eng => {
        const sched = schedConfig[eng.id];
        // Use config schedule if available; fall back to hardcoded
        const scheduleStr = sched ? formatScheduleDisplay(sched) : eng.schedule;
        const { days, hour } = sched ? parseDaysAndHour(sched) : { days: [...eng.days] as number[], hour: eng.hour };
        const enabled = sched ? sched.enabled : true;

        // autoPost is undefined for legacy configs — fall back to historic
        // always-post behaviour so the UI toggle reflects reality.
        const autoPost = typeof sched?.autoPost === "boolean" ? sched.autoPost : true;

        return {
          id:       eng.id,
          name:     eng.name,
          emoji:    eng.emoji,
          schedule: scheduleStr,
          nextRun:  enabled ? computeNextRun(days, hour) : null,
          lastRun:  lastRuns[eng.id] ?? null,
          enabled,
          autoPost,
        };
      });

      res.json({ engines });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/engines/schedules — all engine schedule configs
  app.get("/api/engines/schedules", requireDashAuth, (_req, res) => {
    try {
      const config = getScheduleConfig();
      res.json(config);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/engines/:engineId/schedule — update an engine's schedule
  app.put("/api/engines/:engineId/schedule", requireDashAuth, (req, res) => {
    const { engineId } = req.params;
    const validEngines = ["signal", "academy", "news", "research", "podcast", "article", "breakthrough", "blog", "dispatch", "reflection"];

    if (!validEngines.includes(engineId)) {
      return res.status(400).json({ error: `Unknown engine "${engineId}"` });
    }

    const { schedule, timeET, dayET, enabled, autoPost } = req.body as Partial<EngineSchedule>;
    const update: Partial<EngineSchedule> = {};

    if (schedule !== undefined) {
      const validSchedules = ["daily", "weekly", "on_event", "Mon/Wed/Fri", "Tue/Thu/Sat", "Mon/Tue/Wed/Thu/Fri", "Sat/Sun"];
      // Also allow arbitrary day combos like "Mon/Wed"
      if (!validSchedules.includes(schedule) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*$/.test(schedule)) {
        return res.status(400).json({ error: `Invalid schedule: "${schedule}"` });
      }
      update.schedule = schedule;
    }

    if (timeET !== undefined) {
      if (!/^\d{1,2}:\d{2}$/.test(timeET)) {
        return res.status(400).json({ error: `Invalid timeET: "${timeET}" — expected HH:MM` });
      }
      update.timeET = timeET;
    }

    if (dayET !== undefined) update.dayET = dayET;
    if (enabled !== undefined) update.enabled = !!enabled;
    if (autoPost !== undefined) update.autoPost = !!autoPost;

    try {
      const config = updateEngineSchedule(engineId, update);
      console.log(`[ScheduleConfig] Updated ${engineId}:`, JSON.stringify(config[engineId]));
      res.json({ success: true, schedule: config[engineId], allSchedules: config });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/engines/:engineId/generate — on-demand content generation
  // Generates content and queues to selected platforms. Does NOT auto-post.
  // Body: { platforms?: ["x", "farcaster"] } — defaults to both if omitted
  app.post("/api/engines/:engineId/generate", requireDashAuth, async (req, res) => {
    const { engineId } = req.params;
    const validEngines = ["signal", "academy", "news", "research", "podcast", "article", "breakthrough", "blog", "dispatch", "reflection"];

    if (!validEngines.includes(engineId)) {
      return res.status(400).json({
        success: false,
        error: `Unknown engine "${engineId}". Valid: ${validEngines.join(", ")}`,
      });
    }

    // Platform selection — defaults to both
    const validPlatforms = ["x", "farcaster"];
    let platforms: string[] = req.body?.platforms ?? ["x", "farcaster"];
    if (!Array.isArray(platforms) || platforms.length === 0) {
      platforms = ["x", "farcaster"];
    }
    platforms = platforms.filter(p => validPlatforms.includes(p));
    if (platforms.length === 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid platforms. Valid: ${validPlatforms.join(", ")}`,
      });
    }

    console.log(`[GenerateNow] On-demand generation triggered for engine: ${engineId}, platforms: ${platforms.join(", ")}`);

    try {
      let content = "";
      let type: string = engineId;

      switch (engineId) {
        case "signal": {
          const grokKey = LLM_API_KEY;
          if (!grokKey) throw new Error("LLM API key not configured");
          // Import the private generation function via a new exported wrapper
          const { generateSignalContent } = await import("./signalBriefEngine.js");
          const result = await generateSignalContent(grokKey);
          if (!result) throw new Error("Signal brief generation failed — LLM returned no content");
          content = result.post;
          type = "signal";
          break;
        }

        case "academy": {
          const { generateAcademyContent } = await import("./academyEngine.js");
          // generateAcademyContent now throws AcademyGenerationError with
          // model / finish_reason / prompt_len context when the LLM path
          // fails. Let that message propagate — the outer catch returns it
          // as `error` in the 500 response so the operator sees the real
          // cause instead of a generic "LLM returned no content".
          const result = await generateAcademyContent();
          if (!result?.post || result.post.trim().length < 10) {
            throw new Error("Academy episode generation failed — LLM returned no content");
          }
          content = result.post;
          type = "academy";
          break;
        }

        case "news": {
          const { generateNewsContent } = await import("./newsGenerator.js");
          const result = await generateNewsContent();
          if (!result) throw new Error("News dispatch generation failed — LLM returned no content");
          content = result;
          type = "news";
          break;
        }

        case "research": {
          const { generateResearchContent } = await import("./researchEngine.js");
          const result = await generateResearchContent();
          if (!result) throw new Error("No publishable research found — run research pipeline first");
          content = result;
          type = "research";
          break;
        }

        case "podcast": {
          // Optional `episodeId` body param — when set, promote that
          // specific published episode; otherwise fall back to the most
          // recent (legacy behaviour). Added 2026-04-21 after the user
          // reported podcast drafts went to the inbox with no link.
          const episodeId = typeof req.body?.episodeId === "string" ? req.body.episodeId : undefined;
          const { generatePodcastContent } = await import("./podcastEngine.js");
          const result = await generatePodcastContent(episodeId);
          if (!result) throw new Error(episodeId
            ? `Podcast generation failed — episodeId=${episodeId} not found or not published`
            : "Podcast generation failed — no research threads ready or no scripted episodes");
          content = result;
          type = "podcast";
          break;
        }

        case "article": {
          // Article is a 2-output special case. Both surfaces in the unified
          // drafts inbox come from a single runWeeklyDeepRead call:
          //
          //   BOTTOM card "[306 DEEP READ]"
          //     The article draft saved to article_state.json. Renders with
          //     headline + teaser preview and Copy Article / Copy Teaser
          //     actions. Untouched here.
          //
          //   TOP card "[306 ARTICLE]"
          //     A tweet draft (engine="article") whose `content` is the FULL
          //     long-form manuscript (`buildLongFormArticlePost`) — a
          //     ~600-1500 word, multi-paragraph Agent 306 post the operator
          //     copies straight into Substack / blog / X Article composer.
          //     NOT a 280-char tweet teaser. (Earlier revisions of this
          //     handler stored the teaser here and the manuscript was only
          //     reachable via the bottom card; the user wanted the
          //     manuscript directly visible/copyable on the top card.)
          const apiKey = LLM_API_KEY;
          if (!apiKey) throw new Error("LLM API key not configured");

          const result = await runWeeklyDeepRead(null, apiKey);
          if (!result.success || !result.draftId) {
            throw new Error(result.error ?? "Article generation failed");
          }
          const savedDrafts = listDeepReadDrafts();
          const draft = savedDrafts.find(d => d.draftId === result.draftId);
          if (!draft) {
            throw new Error("Article draft saved but could not be located for top-card generation");
          }
          content = buildLongFormArticlePost(draft);
          type = "article";
          break;
        }

        case "breakthrough": {
          const result = generateBreakthroughContent();
          if (!result) throw new Error("No breakthroughs detected — run analysis first");
          content = result;
          type = "breakthrough";
          break;
        }

        case "dispatch": {
          const dispatchResult = await generateDispatchContent();
          if (!dispatchResult) throw new Error("Dispatch generation failed — LLM returned no content");
          content = dispatchResult;
          type = "dispatch";
          break;
        }

        case "blog": {
          // PROMOTE the latest published blog post. Generate Now is NOT a
          // "write a brand-new blog post" button — the autonomous daily blog
          // engine owns authoring. We just queue a teaser with the real
          // agent306.ai/blog/<slug> URL.
          const { getPublishedPosts } = await import("./blogEngine.js");
          const published = getPublishedPosts(1);
          if (!published.length) {
            throw new Error(
              "No published blog posts to promote. Run the blog engine or publish a draft first."
            );
          }
          const post = published[0];
          const blogLink = `https://agent306.ai/blog/${post.slug}`;
          const blogTitle = (post.title ?? "New post").trim();
          const blogExcerpt = (post.excerpt ?? "").trim();
          content = blogExcerpt
            ? `[306 BLOG] ${blogTitle}\n\n${blogExcerpt}\n\nRead: ${blogLink}`
            : `[306 BLOG] ${blogTitle}\n\nRead: ${blogLink}`;
          type = "blog";
          break;
        }

        case "reflection": {
          const { generateReflectionPostContent } = await import("./reflectionPostEngine.js");
          const result = await generateReflectionPostContent();
          content = result.post;
          type = "reflection";
          break;
        }
      }

      if (!content || content.trim().length < 10) {
        throw new Error("Engine produced empty or too-short content");
      }

      const trimmed = content.trim();
      const queuedTo: string[] = [];
      let savedDraftId: string | undefined;

      // Determine posting mode:
      //   * podcast/breakthrough/blog/research/reflection → draft-capable.
      //     Respect the per-engine `autoPost` toggle. Default as of
      //     2026-04-21 is draft-only for all of these.
      //   * `article` → always saves the manuscript to article drafts AND
      //     emits a teaser tweet. The teaser follows the same autoPost
      //     toggle (article engine defaults to draft-only).
      //   * everything else auto-posts (backwards compat).
      const DRAFT_TWEET_ENGINES: TweetDraftEngine[] = [
        "podcast", "breakthrough", "blog", "research", "reflection",
      ];
      const isTweetDraftEngine = (DRAFT_TWEET_ENGINES as string[]).includes(engineId);
      const isArticle = engineId === "article";
      // Draft-capable engines default to autoPost=false (draft inbox is
      // the new baseline). Pure auto-post engines default to autoPost=true.
      const draftCapable = isTweetDraftEngine || isArticle;
      const autoPost = draftCapable
        ? shouldAutoPost(engineId, false)
        : shouldAutoPost(engineId, true);

      if (isArticle) {
        // TOP card: the long-form manuscript (`trimmed` already contains
        // the full ~600-1500 word `buildLongFormArticlePost` output) is
        // saved as a tweet draft with engine="article" so it lights up the
        // [306 ARTICLE] card in the unified inbox.
        //
        // When autoPost=ON we still queue *something* to X/FC, but the
        // manuscript itself is too long for a single tweet — fall back to
        // the deterministic short teaser (`buildArticleTeaserTweet`) for
        // the X/FC path so we never POST a 1500-word string as a tweet.
        const draft = saveTweetDraft({
          engine: "article" as TweetDraftEngine,
          content: trimmed,
          platforms,
        });
        savedDraftId = draft.draftId;
        console.log(`[GenerateNow] Article long-form manuscript saved as draft ${draft.draftId} (${trimmed.length} chars); Deep Read draft also saved via runWeeklyDeepRead`);
        if (autoPost) {
          // Resolve the just-saved Deep Read draft so we can build a real
          // short-form teaser tweet for the X/FC queue.
          const articleDrafts = listDeepReadDrafts();
          const articleDraft = articleDrafts[0]; // newest first
          const teaserTweet = articleDraft
            ? buildArticleTeaserTweet(articleDraft)
            : trimmed.slice(0, 240);
          if (platforms.includes("x")) {
            queueXPost(teaserTweet, "article", 3);
            queuedTo.push("x");
          }
          if (platforms.includes("farcaster")) {
            try {
              const channel = teaserTweet.match(/\bai\b|agent|llm|model/i) ? "ai" : undefined;
              queueFarcasterPost(teaserTweet, "article", 3, channel);
              queuedTo.push("farcaster");
            } catch (fcErr: any) {
              console.warn(`[GenerateNow] Farcaster queue failed:`, fcErr.message);
            }
          }
        }
      } else if (!autoPost && isTweetDraftEngine) {
        // Save to tweet drafts instead of posting.
        const draft = saveTweetDraft({
          engine: engineId as TweetDraftEngine,
          content: trimmed,
          platforms,
        });
        savedDraftId = draft.draftId;
        console.log(`[GenerateNow] autoPost=false — saved ${engineId} draft ${draft.draftId} (${trimmed.length} chars)`);
      } else if (!autoPost && !isTweetDraftEngine) {
        // Non-draftable engine with autoPost off. Rare (the main
        // always-post engines default to on) but honour the flag —
        // don't silently queue.
        console.log(`[GenerateNow] autoPost=false for ${engineId} (non-draftable) — content returned but not queued`);
      } else {
        // Queue to X (only if selected)
        if (platforms.includes("x")) {
          const xPostType = type as any; // XPostType
          queueXPost(trimmed, xPostType, 3); // priority 3 = high (on-demand)
          queuedTo.push("x");
          console.log(`[GenerateNow] Queued to X: ${engineId} (${trimmed.length} chars)`);
        }

        // Queue to Farcaster (only if selected)
        if (platforms.includes("farcaster")) {
          try {
            const channel = trimmed.match(/\bai\b|agent|llm|model/i) ? "ai" : undefined;
            queueFarcasterPost(trimmed, type as any, 3, channel);
            queuedTo.push("farcaster");
            console.log(`[GenerateNow] Queued to Farcaster: ${engineId} (${trimmed.length} chars)`);
          } catch (fcErr: any) {
            console.warn(`[GenerateNow] Farcaster queue failed:`, fcErr.message);
          }
        }
      }

      res.json({
        success: true,
        content: trimmed,  // Return full content for preview
        type: engineId,
        queuedTo,
        contentLength: trimmed.length,
        savedAsDraft: isArticle || (!autoPost && isTweetDraftEngine),
        draftId: savedDraftId,
      });

    } catch (e: any) {
      console.error(`[GenerateNow] Engine ${engineId} failed:`, e.message);
      res.status(500).json({
        success: false,
        error: e.message || "Generation failed",
      });
    }
  });

  // GET /api/dispatch/state — Dispatch episode tracker
  app.get("/api/dispatch/state", requireDashAuth, (_req, res) => {
    try {
      res.json(getDispatchState());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Farcaster Queue API ───────────────────────────────────────────────────

  // GET /api/farcaster/queue — Farcaster post queue state
  app.get("/api/farcaster/queue", requireDashAuth, (_req, res) => {
    try {
      const { queue, pending, postedToday } = getFarcasterPostQueue();
      res.json({ queue, pending, postedToday });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/farcaster/queue/:postId/post — Post a specific queued item
  app.post("/api/farcaster/queue/:postId/post", requireDashAuth, async (req, res) => {
    try {
      const result = await postFarcasterQueueItem(req.params.postId);
      if (result) {
        res.json({ success: true, castUrl: result.castUrl });
      } else {
        res.status(404).json({ success: false, error: "Post not found, already posted, or stale" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST /api/farcaster/queue/clear — Clear all pending Farcaster posts
  app.post("/api/farcaster/queue/clear", requireDashAuth, (_req, res) => {
    try {
      const cleared = clearFarcasterPostQueue();
      res.json({ success: true, cleared });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/farcaster/queue/:postId — remove a single pending Farcaster cast.
  app.delete("/api/farcaster/queue/:postId", requireDashAuth, (req, res) => {
    const deleted = deleteFarcasterQueueItem(req.params.postId);
    if (!deleted) return res.status(404).json({ error: "cast not found or already posted" });
    return res.status(204).end();
  });
}
