// ─────────────────────────────────────────────────────────────────────────────
// 306 — DATA INTAKE MODULE (Layer 1)
//
// Broad AI/tech research intake from multiple sources:
//   • arXiv — recent AI/ML papers (cs.AI, cs.LG, cs.CL)
//   • HuggingFace — trending models & spaces
//   • AI News RSS — TechCrunch, MIT Tech Review, The Verge, Ars Technica
//   • GitHub Trending — AI/ML repos via GitHub search API
//   • Reddit — r/MachineLearning, r/artificial, r/LocalLLaMA
//   • Official AI Blogs — OpenAI, Anthropic, Google AI, Meta AI
//
// All sources degrade gracefully — if one is down, others continue.
// Runs as part of the daily cycle, BEFORE briefing generation.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as crypto from "crypto";
import { dataPath } from "./dataPaths.js";
import { addKnowledge, knowledge } from "./memoryEngine.js";
import { findConnections } from "./knowledge-graph.js";
import RssParser from "rss-parser";

const INTAKE_FILE = dataPath("intake-history.json");

// ── Types ────────────────────────────────────────────────────────────────────

export interface IntakeItem {
  id: string;
  source: string;
  title: string;
  summary: string;
  url: string;
  category: string;
  publishedAt: string;
  relevanceScore: number;
  raw: any;
}

interface IntakeState {
  lastRunAt: string | null;
  totalRuns: number;
  history: IntakeRun[];
}

interface IntakeRun {
  runId: string;
  runAt: string;
  sourcesRun: string[];
  itemsCollected: number;
  itemsNew: number;
  itemsIngested: number;
  durationMs: number;
}

// ── State persistence ────────────────────────────────────────────────────────

function loadState(): IntakeState {
  try {
    if (fs.existsSync(INTAKE_FILE))
      return JSON.parse(fs.readFileSync(INTAKE_FILE, "utf8"));
  } catch {}
  return { lastRunAt: null, totalRuns: 0, history: [] };
}

function saveState(s: IntakeState): void {
  try { fs.writeFileSync(INTAKE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

export function getIntakeState(): IntakeState { return state; }

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeId(source: string, title: string): string {
  return crypto.createHash("sha256").update(`${source}:${title}`).digest("hex").slice(0, 16);
}

async function safeFetch(url: string, opts: RequestInit = {}): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Agent306-DataIntake/1.0",
        ...opts.headers,
      },
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

const rssParser = new RssParser({ timeout: 15000 });

// AI relevance keywords for scoring
const AI_KEYWORDS = [
  "artificial intelligence", "machine learning", "deep learning", "neural network",
  "large language model", "llm", "transformer", "gpt", "claude", "gemini",
  "diffusion", "generative ai", "reinforcement learning", "computer vision",
  "natural language processing", "nlp", "ai safety", "alignment", "rlhf",
  "fine-tuning", "open source", "hugging face", "openai", "anthropic", "google ai",
  "meta ai", "mistral", "llama", "multimodal", "agent", "rag", "retrieval",
  "embedding", "benchmark", "reasoning", "inference", "training", "dataset",
  "robotics", "autonomous", "ai regulation", "ai policy",
];

// ── Relevance scoring ────────────────────────────────────────────────────────

export function scoreRelevance(item: IntakeItem): number {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  let score = 0.3; // base score for being from an AI source

  // Keyword matching
  let keywordHits = 0;
  for (const kw of AI_KEYWORDS) {
    if (text.includes(kw)) keywordHits++;
  }
  score += Math.min(0.4, keywordHits * 0.08);

  // Recency bonus — items from last 24h get a boost
  const ageMs = Date.now() - new Date(item.publishedAt).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < 6) score += 0.2;
  else if (ageHours < 24) score += 0.1;
  else if (ageHours < 72) score += 0.05;

  // Source-specific bonuses
  if (item.source === "arxiv") score += 0.05; // academic rigor
  if (item.source === "ai_blog") score += 0.05; // official announcements

  return Math.min(1, Math.round(score * 100) / 100);
}

// ── Source: arXiv ────────────────────────────────────────────────────────────

async function fetchArxiv(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Fetching arXiv...");
  const categories = ["cs.AI", "cs.LG", "cs.CL"];
  const query = categories.map(c => `cat:${c}`).join("+OR+");
  const url = `http://export.arxiv.org/api/query?search_query=${query}&sortBy=submittedDate&sortOrder=descending&max_results=20`;

  const res = await safeFetch(url);
  if (!res) return [];

  const xml = await res.text();
  const items: IntakeItem[] = [];

  // Parse Atom XML — extract <entry> blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const link = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "";
    const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? new Date().toISOString();
    const categoryMatches = entry.match(/<category[^>]*term="([^"]+)"/g) ?? [];
    const cats = categoryMatches.map(c => c.match(/term="([^"]+)"/)?.[1] ?? "").filter(Boolean);

    if (!title) continue;

    const item: IntakeItem = {
      id: makeId("arxiv", title),
      source: "arxiv",
      title,
      summary: summary.slice(0, 300),
      url: link,
      category: cats.includes("cs.CL") ? "nlp" : cats.includes("cs.LG") ? "ml" : "ai",
      publishedAt: published,
      relevanceScore: 0,
      raw: { categories: cats },
    };
    item.relevanceScore = scoreRelevance(item);
    items.push(item);
  }

  console.log(`[DataIntake] arXiv: ${items.length} papers`);
  return items;
}

// ── Source: HuggingFace ──────────────────────────────────────────────────────

async function fetchHuggingFace(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Fetching HuggingFace trending...");
  const items: IntakeItem[] = [];

  // Trending models
  const modelsRes = await safeFetch("https://huggingface.co/api/models?sort=trending&limit=20");
  if (modelsRes) {
    try {
      const models = await modelsRes.json() as any[];
      for (const m of models) {
        const item: IntakeItem = {
          id: makeId("huggingface", m.modelId ?? m.id ?? ""),
          source: "huggingface",
          title: `[Model] ${m.modelId ?? m.id}`,
          summary: (m.description || m.pipeline_tag || "Trending model on HuggingFace").slice(0, 300),
          url: `https://huggingface.co/${m.modelId ?? m.id}`,
          category: "models",
          publishedAt: m.createdAt ?? m.lastModified ?? new Date().toISOString(),
          relevanceScore: 0,
          raw: { downloads: m.downloads, likes: m.likes, pipeline_tag: m.pipeline_tag, tags: m.tags },
        };
        item.relevanceScore = scoreRelevance(item);
        items.push(item);
      }
    } catch {}
  }

  // Trending spaces
  const spacesRes = await safeFetch("https://huggingface.co/api/spaces?sort=trending&limit=10");
  if (spacesRes) {
    try {
      const spaces = await spacesRes.json() as any[];
      for (const s of spaces) {
        const item: IntakeItem = {
          id: makeId("huggingface", `space:${s.id ?? ""}`),
          source: "huggingface",
          title: `[Space] ${s.id}`,
          summary: (s.description || s.cardData?.short_description || "Trending space on HuggingFace").slice(0, 300),
          url: `https://huggingface.co/spaces/${s.id}`,
          category: "spaces",
          publishedAt: s.createdAt ?? s.lastModified ?? new Date().toISOString(),
          relevanceScore: 0,
          raw: { likes: s.likes, sdk: s.sdk },
        };
        item.relevanceScore = scoreRelevance(item);
        items.push(item);
      }
    } catch {}
  }

  console.log(`[DataIntake] HuggingFace: ${items.length} items`);
  return items;
}

// ── Source: AI News RSS ──────────────────────────────────────────────────────

const AI_NEWS_FEEDS = [
  { name: "TechCrunch AI",       url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "MIT Tech Review AI",  url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
  { name: "The Verge AI",        url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "Ars Technica AI",     url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
];

async function fetchAINewsRSS(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Fetching AI news RSS feeds...");
  const items: IntakeItem[] = [];

  const results = await Promise.allSettled(
    AI_NEWS_FEEDS.map(async (feed) => {
      try {
        const parsed = await rssParser.parseURL(feed.url);
        const feedItems: IntakeItem[] = [];
        for (const entry of (parsed.items ?? []).slice(0, 10)) {
          const title = entry.title ?? "";
          if (!title) continue;
          const item: IntakeItem = {
            id: makeId("news_rss", title),
            source: "news_rss",
            title,
            summary: (entry.contentSnippet ?? entry.content ?? "").replace(/<[^>]*>/g, "").slice(0, 300),
            url: entry.link ?? "",
            category: "ai_news",
            publishedAt: entry.isoDate ?? entry.pubDate ?? new Date().toISOString(),
            relevanceScore: 0,
            raw: { feed: feed.name, author: entry.creator ?? entry.author },
          };
          item.relevanceScore = scoreRelevance(item);
          feedItems.push(item);
        }
        return feedItems;
      } catch (e: any) {
        console.warn(`[DataIntake] RSS feed failed (${feed.name}):`, e.message);
        return [];
      }
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
  }

  console.log(`[DataIntake] AI News RSS: ${items.length} articles`);
  return items;
}

// ── Source: GitHub Trending ──────────────────────────────────────────────────

async function fetchGitHubTrending(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Fetching GitHub trending AI/ML repos...");
  // Use GitHub search API — repos created recently with AI/ML topics, sorted by stars
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const query = encodeURIComponent(`topic:machine-learning topic:artificial-intelligence created:>${weekAgo}`);
  const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=20`;

  const res = await safeFetch(url, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res) return [];

  const items: IntakeItem[] = [];
  try {
    const data = await res.json() as any;
    for (const repo of (data.items ?? []).slice(0, 20)) {
      const item: IntakeItem = {
        id: makeId("github", repo.full_name ?? ""),
        source: "github",
        title: repo.full_name,
        summary: (repo.description ?? "No description").slice(0, 300),
        url: repo.html_url,
        category: "github_trending",
        publishedAt: repo.created_at ?? new Date().toISOString(),
        relevanceScore: 0,
        raw: {
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          language: repo.language,
          topics: repo.topics,
        },
      };
      item.relevanceScore = scoreRelevance(item);
      // Boost high-star repos
      if (repo.stargazers_count > 100) item.relevanceScore = Math.min(1, item.relevanceScore + 0.1);
      if (repo.stargazers_count > 1000) item.relevanceScore = Math.min(1, item.relevanceScore + 0.1);
      items.push(item);
    }
  } catch {}

  console.log(`[DataIntake] GitHub: ${items.length} repos`);
  return items;
}

// ── Source: Reddit ───────────────────────────────────────────────────────────

const REDDIT_SUBS = ["MachineLearning", "artificial", "LocalLLaMA"];

async function fetchReddit(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Fetching Reddit AI subs...");
  const items: IntakeItem[] = [];

  const results = await Promise.allSettled(
    REDDIT_SUBS.map(async (sub) => {
      const res = await safeFetch(`https://www.reddit.com/r/${sub}/hot.json?limit=15`, {
        headers: { Accept: "application/json" },
      });
      if (!res) return [];

      const subItems: IntakeItem[] = [];
      try {
        const data = await res.json() as any;
        for (const child of (data?.data?.children ?? []).slice(0, 15)) {
          const post = child.data;
          if (!post || post.stickied) continue;
          const item: IntakeItem = {
            id: makeId("reddit", post.title ?? post.id ?? ""),
            source: "reddit",
            title: post.title ?? "",
            summary: ((post.selftext ?? "").replace(/\n/g, " ").slice(0, 300)) || (post.title ?? ""),
            url: `https://reddit.com${post.permalink}`,
            category: `reddit_${sub.toLowerCase()}`,
            publishedAt: new Date((post.created_utc ?? 0) * 1000).toISOString(),
            relevanceScore: 0,
            raw: {
              subreddit: sub,
              score: post.score,
              num_comments: post.num_comments,
              upvote_ratio: post.upvote_ratio,
              author: post.author,
            },
          };
          item.relevanceScore = scoreRelevance(item);
          // Boost high-upvote posts
          if (post.score > 100) item.relevanceScore = Math.min(1, item.relevanceScore + 0.1);
          if (post.score > 500) item.relevanceScore = Math.min(1, item.relevanceScore + 0.1);
          subItems.push(item);
        }
      } catch {}
      return subItems;
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
  }

  console.log(`[DataIntake] Reddit: ${items.length} posts`);
  return items;
}

// ── Source: Official AI Blogs ────────────────────────────────────────────────

const AI_BLOG_FEEDS = [
  { name: "OpenAI Blog",    url: "https://openai.com/blog/rss.xml" },
  { name: "Anthropic Blog", url: "https://www.anthropic.com/feed" },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/" },
  { name: "Meta AI Blog",   url: "https://ai.meta.com/blog/rss/" },
];

async function fetchAIBlogs(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Fetching official AI blogs...");
  const items: IntakeItem[] = [];

  const results = await Promise.allSettled(
    AI_BLOG_FEEDS.map(async (feed) => {
      try {
        const parsed = await rssParser.parseURL(feed.url);
        const feedItems: IntakeItem[] = [];
        for (const entry of (parsed.items ?? []).slice(0, 5)) {
          const title = entry.title ?? "";
          if (!title) continue;
          const item: IntakeItem = {
            id: makeId("ai_blog", title),
            source: "ai_blog",
            title,
            summary: (entry.contentSnippet ?? entry.content ?? "").replace(/<[^>]*>/g, "").slice(0, 300),
            url: entry.link ?? "",
            category: "ai_blog",
            publishedAt: entry.isoDate ?? entry.pubDate ?? new Date().toISOString(),
            relevanceScore: 0,
            raw: { blog: feed.name, author: entry.creator ?? entry.author },
          };
          item.relevanceScore = scoreRelevance(item);
          feedItems.push(item);
        }
        return feedItems;
      } catch (e: any) {
        console.warn(`[DataIntake] Blog feed failed (${feed.name}):`, e.message);
        return [];
      }
    })
  );

  for (const r of results) {
    if (r.status === "fulfilled") items.push(...r.value);
  }

  console.log(`[DataIntake] AI Blogs: ${items.length} posts`);
  return items;
}

// ── Deduplication ────────────────────────────────────────────────────────────

export function deduplicateAgainstKnowledge(
  items: IntakeItem[],
  existingKnowledge: any[],
): IntakeItem[] {
  // Build a set of normalized existing titles for fast lookup
  const existingTitles = new Set(
    existingKnowledge.map((e: any) => (e.title ?? "").toLowerCase().trim())
  );

  // Also deduplicate within the batch itself
  const seen = new Set<string>();

  return items.filter(item => {
    const normTitle = item.title.toLowerCase().trim();
    if (seen.has(item.id) || seen.has(normTitle)) return false;
    if (existingTitles.has(normTitle)) return false;

    // Fuzzy check — if 80%+ of words match an existing title, skip
    const itemWords = normTitle.split(/\s+/).filter((w: string) => w.length > 3);
    for (const existing of Array.from(existingTitles)) {
      const existingWords = existing.split(/\s+/).filter((w: string) => w.length > 3);
      if (itemWords.length === 0 || existingWords.length === 0) continue;
      const existingSet = new Set(existingWords);
      const overlap = itemWords.filter((w: string) => existingSet.has(w)).length;
      const similarity = overlap / Math.max(itemWords.length, existingWords.length);
      if (similarity >= 0.8) return false;
    }

    seen.add(item.id);
    seen.add(normTitle);
    return true;
  });
}

// ── Daily Brief Generation ───────────────────────────────────────────────────

export function generateDailyBrief(items: IntakeItem[]): string {
  if (items.length === 0) return "# Data Intake Brief\n\nNo new items collected.";

  const sorted = [...items].sort((a, b) => b.relevanceScore - a.relevanceScore);
  const topItems = sorted.slice(0, 15);

  const bySource: Record<string, IntakeItem[]> = {};
  for (const item of topItems) {
    if (!bySource[item.source]) bySource[item.source] = [];
    bySource[item.source].push(item);
  }

  const sourceLabels: Record<string, string> = {
    arxiv: "Academic Papers (arXiv)",
    huggingface: "HuggingFace Trending",
    news_rss: "AI News",
    github: "GitHub Trending",
    reddit: "Reddit AI Discussion",
    ai_blog: "Official AI Blogs",
  };

  const lines: string[] = [
    `# Agent 306 — Daily Intelligence Brief`,
    `**Date**: ${new Date().toISOString().split("T")[0]}`,
    `**Sources scanned**: ${Object.keys(bySource).length} | **Items collected**: ${items.length} | **Top items**: ${topItems.length}`,
    "",
  ];

  for (const [source, sourceItems] of Object.entries(bySource)) {
    lines.push(`## ${sourceLabels[source] ?? source}`);
    for (const item of sourceItems.slice(0, 5)) {
      lines.push(`- **${item.title}** (relevance: ${item.relevanceScore}) — ${item.summary.slice(0, 120)}${item.summary.length > 120 ? "..." : ""}`);
      if (item.url) lines.push(`  ${item.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Source Runners (individual + full) ───────────────────────────────────────

const SOURCE_MAP: Record<string, () => Promise<IntakeItem[]>> = {
  arxiv: fetchArxiv,
  huggingface: fetchHuggingFace,
  news_rss: fetchAINewsRSS,
  github: fetchGitHubTrending,
  reddit: fetchReddit,
  ai_blog: fetchAIBlogs,
};

export async function runSourceIntake(source: string): Promise<IntakeItem[]> {
  const fn = SOURCE_MAP[source];
  if (!fn) {
    console.warn(`[DataIntake] Unknown source: ${source}`);
    return [];
  }
  try {
    return await fn();
  } catch (e: any) {
    console.error(`[DataIntake] Source ${source} failed:`, e.message);
    return [];
  }
}

const RELEVANCE_THRESHOLD = 0.5;

export async function runFullIntake(): Promise<IntakeItem[]> {
  console.log("[DataIntake] Starting full intake cycle...");
  const startTime = Date.now();

  // Run all sources in parallel — failures are isolated
  const results = await Promise.allSettled(
    Object.entries(SOURCE_MAP).map(async ([name, fn]) => {
      try {
        return await fn();
      } catch (e: any) {
        console.error(`[DataIntake] ${name} failed:`, e.message);
        return [];
      }
    })
  );

  // Flatten results
  let allItems: IntakeItem[] = [];
  const sourcesRun: string[] = [];
  const sourceNames = Object.keys(SOURCE_MAP);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value.length > 0) {
      allItems.push(...r.value);
      sourcesRun.push(sourceNames[i]);
    }
  }

  console.log(`[DataIntake] Collected ${allItems.length} items from ${sourcesRun.length} sources`);

  // Deduplicate against existing knowledge base
  let existingKB: any[] = [];
  try {
    const kbFile = dataPath("memory_knowledge.json");
    if (fs.existsSync(kbFile)) {
      const kbData = JSON.parse(fs.readFileSync(kbFile, "utf8"));
      existingKB = kbData.entries ?? [];
    }
  } catch {}

  const newItems = deduplicateAgainstKnowledge(allItems, existingKB);
  console.log(`[DataIntake] ${newItems.length} new items after dedup (${allItems.length - newItems.length} duplicates removed)`);

  // Auto-ingest high-relevance items into knowledge base
  let ingested = 0;
  for (const item of newItems) {
    if (item.relevanceScore >= RELEVANCE_THRESHOLD) {
      addKnowledge({
        category: "ai_signal",
        title: item.title.slice(0, 100),
        summary: item.summary.slice(0, 150),
        weight: Math.round(item.relevanceScore * 10),
        source: `data_intake:${item.source}`,
      });
      ingested++;
    }
  }
  console.log(`[DataIntake] Ingested ${ingested} items into knowledge base (threshold: ${RELEVANCE_THRESHOLD})`);

  // Auto-find knowledge graph connections for top ingested items (limit to 3 to control LLM calls)
  const topIngestedItems = newItems
    .filter(item => item.relevanceScore >= RELEVANCE_THRESHOLD)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 3);

  let connectionsFound = 0;
  for (const item of topIngestedItems) {
    try {
      // Find the KB entry that was just created for this item
      const kbEntry = knowledge.entries.find(e => e.title === item.title.slice(0, 100));
      if (kbEntry) {
        const conns = await findConnections({
          id: kbEntry.id,
          title: kbEntry.title,
          summary: kbEntry.summary ?? "",
          category: kbEntry.category,
        }, "auto_ingest");
        connectionsFound += conns.length;
      }
    } catch (e: any) {
      console.warn(`[DataIntake] Connection finding failed for "${item.title}":`, e.message);
    }
  }
  if (connectionsFound > 0) {
    console.log(`[DataIntake] Found ${connectionsFound} knowledge graph connections for ingested items`);
  }

  // Save run to history
  const durationMs = Date.now() - startTime;
  const run: IntakeRun = {
    runId: `intake_${Date.now()}`,
    runAt: new Date().toISOString(),
    sourcesRun,
    itemsCollected: allItems.length,
    itemsNew: newItems.length,
    itemsIngested: ingested,
    durationMs,
  };

  state.lastRunAt = run.runAt;
  state.totalRuns++;
  state.history.unshift(run);
  if (state.history.length > 14) state.history = state.history.slice(0, 14);
  saveState(state);

  console.log(`[DataIntake] Full intake complete in ${(durationMs / 1000).toFixed(1)}s — ${newItems.length} new, ${ingested} ingested`);

  return newItems;
}

// ── Available sources listing ────────────────────────────────────────────────

export function getAvailableSources(): string[] {
  return Object.keys(SOURCE_MAP);
}
