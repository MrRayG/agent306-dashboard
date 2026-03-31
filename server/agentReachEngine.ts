// ─────────────────────────────────────────────────────────────────────────────
// 306 — AGENT-REACH EXPLORATION CHANNELS
//
// Node.js native implementations inspired by Agent-Reach's architecture.
// Three channels:
//   1. Twitter/X Reading via Jina Reader (free, no API key)
//   2. YouTube Transcripts via RSS + Jina Reader
//   3. RSS Feeds via rss-parser
//
// All channels return raw text for extractKnowledge() to process.
// Graceful degradation — if any channel fails, others continue.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import RssParser from "rss-parser";
import { dataPath } from "./dataPaths.js";

const JINA_READER_BASE = "https://r.jina.ai/";
const YOUTUBE_RSS_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const STATE_FILE = dataPath("agent_reach_state.json");

// ── Configuration with env-var overrides ──────────────────────────────────────

const DEFAULT_TWITTER_ACCOUNTS = [
  // ── AI Leaders & Labs ──
  "OpenAI",
  "GoogleDeepMind",
  "AnthropicAI",
  "xai",
  "sama",
  "karpathy",
  "AndrewYNg",
  "ylecun",
  "TheRundownAI",
  "dair_ai",
  // ── Web3 & Crypto ──
  "VitalikButerin",
  "binance",
  "coinbase",
  "ethereum",
  "cz_binance",
  "brian_armstrong",
  "balajis",
  "APompliano",
  "saylor",
  "a16z",
  "BoredApeGazette",
  "punk6529",
  "ai16zdao",
  // ── 306 Ecosystem ──
];

const DEFAULT_YOUTUBE_CHANNELS: { name: string; channelId: string }[] = [
  { name: "Bankless", channelId: "UCPMdKoKQHaACff9JKxmRIJA" },
  { name: "The Defiant", channelId: "UCL0J4MLEdLP0-UyLu0hCktg" },
  { name: "AI Explained", channelId: "UCNJ1Ymd5yFuUPtn21xtRbbw" },
];

const DEFAULT_RSS_FEEDS: { name: string; url: string }[] = [
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Bankless", url: "https://www.bankless.com/rss.xml" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
];

function getConfig() {
  const enabled = (process.env.AGENT_REACH_ENABLED ?? "true").toLowerCase() !== "false";

  const twitterAccounts = process.env.AGENT_REACH_TWITTER_ACCOUNTS
    ? process.env.AGENT_REACH_TWITTER_ACCOUNTS.split(",").map(s => s.trim().replace(/^@/, ""))
    : DEFAULT_TWITTER_ACCOUNTS;

  const youtubeChannels = process.env.AGENT_REACH_YOUTUBE_CHANNELS
    ? process.env.AGENT_REACH_YOUTUBE_CHANNELS.split(",").map(s => {
        const trimmed = s.trim();
        return { name: trimmed, channelId: trimmed };
      })
    : DEFAULT_YOUTUBE_CHANNELS;

  const rssFeeds = process.env.AGENT_REACH_RSS_FEEDS
    ? process.env.AGENT_REACH_RSS_FEEDS.split(",").map(s => {
        const trimmed = s.trim();
        return { name: trimmed, url: trimmed };
      })
    : DEFAULT_RSS_FEEDS;

  return { enabled, twitterAccounts, youtubeChannels, rssFeeds };
}

// ── Persistent state for tracking last-fetched timestamps ─────────────────────

interface AgentReachState {
  rssLastFetched: Record<string, string>;   // feed URL → ISO timestamp
  lastTwitterFetch: string | null;
  lastYouTubeFetch: string | null;
  channelStatus: {
    twitter: { ok: boolean; lastError?: string; lastSuccess?: string };
    youtube: { ok: boolean; lastError?: string; lastSuccess?: string };
    rss:     { ok: boolean; lastError?: string; lastSuccess?: string };
  };
}

function loadReachState(): AgentReachState {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return {
    rssLastFetched: {},
    lastTwitterFetch: null,
    lastYouTubeFetch: null,
    channelStatus: {
      twitter: { ok: true },
      youtube: { ok: true },
      rss:     { ok: true },
    },
  };
}

function saveReachState(s: AgentReachState) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

export function getAgentReachStatus() {
  const config = getConfig();
  const state = loadReachState();
  return {
    enabled: config.enabled,
    channels: {
      twitter: {
        active: config.twitterAccounts.length > 0,
        accounts: config.twitterAccounts.length,
        ...state.channelStatus.twitter,
      },
      youtube: {
        active: config.youtubeChannels.length > 0,
        channels: config.youtubeChannels.length,
        ...state.channelStatus.youtube,
      },
      rss: {
        active: config.rssFeeds.length > 0,
        feeds: config.rssFeeds.length,
        ...state.channelStatus.rss,
      },
    },
  };
}

// ── Rate-limiting helper ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Jina Reader fetch helper ──────────────────────────────────────────────────

async function fetchViaJina(url: string): Promise<string> {
  try {
    const res = await fetch(JINA_READER_BASE + url, {
      headers: {
        "Accept": "text/plain",
        "X-Return-Format": "text",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`[AgentReach] Jina returned ${res.status} for ${url}`);
      return "";
    }
    const text = await res.text();
    return text.slice(0, 5000); // cap per-page content
  } catch (e: any) {
    console.warn(`[AgentReach] Jina fetch failed for ${url}: ${e.message}`);
    return "";
  }
}

// ── Channel 1: Twitter/X Reading via Jina ─────────────────────────────────────

export async function fetchTwitterFeed(): Promise<string> {
  const config = getConfig();
  if (!config.enabled || config.twitterAccounts.length === 0) return "";

  const state = loadReachState();
  console.log(`[AgentReach] Twitter Pulse: reading ${config.twitterAccounts.length} accounts via Jina...`);

  const results: string[] = [];

  for (const account of config.twitterAccounts) {
    try {
      const profileUrl = `https://x.com/${account}`;
      const content = await fetchViaJina(profileUrl);
      if (content && content.length > 100) {
        results.push(`=== @${account} ===\n${content.slice(0, 2000)}`);
        console.log(`[AgentReach] Twitter @${account}: ${content.length} chars`);
      } else {
        console.warn(`[AgentReach] Twitter @${account}: insufficient content (${content.length} chars)`);
      }
      // Rate limit: 2s between Jina requests
      await delay(2000);
    } catch (e: any) {
      console.warn(`[AgentReach] Twitter @${account} failed: ${e.message}`);
    }
  }

  const combined = results.join("\n\n");
  state.lastTwitterFetch = new Date().toISOString();
  state.channelStatus.twitter = {
    ok: results.length > 0,
    lastSuccess: results.length > 0 ? new Date().toISOString() : state.channelStatus.twitter.lastSuccess,
    lastError: results.length === 0 ? "No content retrieved from any account" : undefined,
  };
  saveReachState(state);

  console.log(`[AgentReach] Twitter Pulse: ${results.length}/${config.twitterAccounts.length} accounts returned content`);
  return combined;
}

// ── Channel 2: YouTube Transcripts via RSS + Jina ─────────────────────────────

export async function fetchYouTubeTranscripts(): Promise<string> {
  const config = getConfig();
  if (!config.enabled || config.youtubeChannels.length === 0) return "";

  const state = loadReachState();
  console.log(`[AgentReach] Video Intelligence: scanning ${config.youtubeChannels.length} YouTube channels...`);

  const results: string[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago

  for (const channel of config.youtubeChannels) {
    try {
      // Fetch YouTube RSS feed for the channel
      const rssUrl = YOUTUBE_RSS_BASE + channel.channelId;
      const rssRes = await fetch(rssUrl, { signal: AbortSignal.timeout(10000) });
      if (!rssRes.ok) {
        console.warn(`[AgentReach] YouTube RSS for ${channel.name}: ${rssRes.status}`);
        continue;
      }

      const xml = await rssRes.text();

      // Parse entries from the XML
      const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
      const recentVideos: { title: string; videoId: string; published: string }[] = [];

      for (const entry of entries.slice(0, 5)) {
        const title = (entry.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1]?.trim() ?? "";
        const videoId = (entry.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/) ?? [])[1]?.trim() ?? "";
        const published = (entry.match(/<published>([\s\S]*?)<\/published>/) ?? [])[1]?.trim() ?? "";

        if (published && new Date(published).getTime() > cutoff) {
          recentVideos.push({ title, videoId, published });
        }
      }

      if (recentVideos.length === 0) {
        console.log(`[AgentReach] YouTube ${channel.name}: no videos in last 48h`);
        continue;
      }

      console.log(`[AgentReach] YouTube ${channel.name}: ${recentVideos.length} recent videos`);

      // Use Jina to read the video page (gets description + any available transcript)
      for (const video of recentVideos.slice(0, 2)) {
        const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
        const content = await fetchViaJina(videoUrl);
        if (content && content.length > 100) {
          results.push(`=== ${channel.name}: "${video.title}" (${video.published}) ===\n${content.slice(0, 3000)}`);
        }
        await delay(2000); // Rate limit
      }
    } catch (e: any) {
      console.warn(`[AgentReach] YouTube ${channel.name} failed: ${e.message}`);
    }
  }

  const combined = results.join("\n\n");
  state.lastYouTubeFetch = new Date().toISOString();
  state.channelStatus.youtube = {
    ok: results.length > 0,
    lastSuccess: results.length > 0 ? new Date().toISOString() : state.channelStatus.youtube.lastSuccess,
    lastError: results.length === 0 ? "No recent video content retrieved" : undefined,
  };
  saveReachState(state);

  console.log(`[AgentReach] Video Intelligence: ${results.length} video transcripts/descriptions retrieved`);
  return combined;
}

// ── Channel 3: RSS Feeds ──────────────────────────────────────────────────────

export async function fetchRSSFeeds(): Promise<string> {
  const config = getConfig();
  if (!config.enabled || config.rssFeeds.length === 0) return "";

  const state = loadReachState();
  const parser = new RssParser();
  console.log(`[AgentReach] RSS Wire: fetching ${config.rssFeeds.length} feeds...`);

  const results: string[] = [];

  for (const feed of config.rssFeeds) {
    try {
      const lastFetched = state.rssLastFetched[feed.url]
        ? new Date(state.rssLastFetched[feed.url]).getTime()
        : Date.now() - 24 * 60 * 60 * 1000; // default: last 24h

      const parsed = await parser.parseURL(feed.url);
      const newItems = (parsed.items ?? []).filter(item => {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        return pubDate > lastFetched;
      });

      if (newItems.length === 0) {
        console.log(`[AgentReach] RSS ${feed.name}: no new items since last fetch`);
        continue;
      }

      // Take up to 5 newest items
      const topItems = newItems.slice(0, 5);
      const feedContent = topItems.map(item => {
        const title = item.title ?? "Untitled";
        const snippet = (item.contentSnippet ?? item.content ?? "")
          .replace(/<[^>]*>/g, "")  // strip HTML
          .slice(0, 300);
        const pubDate = item.pubDate ?? "";
        return `- ${title} (${pubDate})\n  ${snippet}`;
      }).join("\n\n");

      results.push(`=== ${feed.name} (${topItems.length} new articles) ===\n${feedContent}`);
      console.log(`[AgentReach] RSS ${feed.name}: ${topItems.length} new items`);

      // Update last-fetched timestamp
      state.rssLastFetched[feed.url] = new Date().toISOString();

      await delay(500); // Light rate limit between feeds
    } catch (e: any) {
      console.warn(`[AgentReach] RSS ${feed.name} failed: ${e.message}`);
    }
  }

  const combined = results.join("\n\n");
  state.channelStatus.rss = {
    ok: results.length > 0,
    lastSuccess: results.length > 0 ? new Date().toISOString() : state.channelStatus.rss.lastSuccess,
    lastError: results.length === 0 ? "No new RSS content retrieved" : undefined,
  };
  saveReachState(state);

  console.log(`[AgentReach] RSS Wire: ${results.length}/${config.rssFeeds.length} feeds returned new content`);
  return combined;
}

// ── Master enabled check ──────────────────────────────────────────────────────

export function isAgentReachEnabled(): boolean {
  return getConfig().enabled;
}
