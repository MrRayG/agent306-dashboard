/**
 * -----------------------------------------------------------------
 *  BREAKING NEWS DETECTOR
 *
 *  Checks for major AI/crypto developments every 30 minutes during
 *  posting hours using the Perplexity sonar API. When a tier-1 event
 *  is detected, generates a [306 NEWS] post and posts immediately.
 *
 *  Tier system:
 *    Tier 1 — Major announcements from key entities → immediate post
 *    Tier 2 — Notable developments → high-priority queue
 *    Tier 3 — Interesting but not urgent → normal queue
 * -----------------------------------------------------------------
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { queueXPost } from "./xPostScheduler.js";
import { getVoiceContext } from "./voiceInstructions.js";
import { getOptimizedContext } from "./contextWindow.js";
import { enforcePostFormat } from "./postFormatGuard.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

export interface BreakingNewsEvent {
  id: string;
  headline: string;
  summary: string;
  source: string;
  tier: 1 | 2 | 3;
  entities: string[];
  detectedAt: string;
  posted: boolean;
  postedAt: string | null;
}

interface EventStore {
  events: BreakingNewsEvent[];
  lastChecked: string | null;
}

// Tier-1 entities — major announcements from these trigger immediate posting
const TIER_1_ENTITIES = [
  "OpenAI", "Anthropic", "Google DeepMind", "Meta AI", "xAI", "Mistral",
  "Nvidia", "Microsoft", "Apple", "Tesla",
  "SEC", "EU AI Act", "White House", "Congress", "FTC",
  "GPT-5", "Claude 4", "Gemini 2", "Llama 4",
];

// Persist detected events to avoid re-alerting
const EVENTS_FILE = dataPath("breaking_news_events.json");

function loadEvents(): EventStore {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
    }
  } catch {
    console.error("[BreakingNews] Failed to load events file — starting fresh");
  }
  return { events: [], lastChecked: null };
}

function saveEvents(store: EventStore): void {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(store, null, 2));
}

export function getRecentEvents(hours = 48): BreakingNewsEvent[] {
  const store = loadEvents();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return store.events.filter(e => new Date(e.detectedAt).getTime() > cutoff);
}

function isDuplicate(headline: string, store: EventStore): boolean {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recentHeadlines = store.events
    .filter(e => new Date(e.detectedAt).getTime() > cutoff)
    .map(e => e.headline.toLowerCase());

  const normalized = headline.toLowerCase();
  return recentHeadlines.some(h => {
    // Simple overlap check — if >60% words overlap, consider duplicate
    const words1 = new Set(h.split(/\s+/));
    const words2 = new Set(normalized.split(/\s+/));
    const overlap = [...words1].filter(w => words2.has(w)).length;
    return overlap / Math.max(words1.size, words2.size) > 0.6;
  });
}

function scoreTier(headline: string, entities: string[]): 1 | 2 | 3 {
  const text = `${headline} ${entities.join(" ")}`.toLowerCase();
  const tier1Matches = TIER_1_ENTITIES.filter(e => text.includes(e.toLowerCase()));
  if (tier1Matches.length >= 2) return 1;
  if (tier1Matches.length === 1) return 2;
  return 3;
}

export async function checkBreakingNews(): Promise<BreakingNewsEvent | null> {
  const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
  if (!pplxKey || pplxKey.length < 10) {
    console.log("[BreakingNews] No Perplexity key — skipping");
    return null;
  }

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pplxKey}`,
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{
          role: "system",
          content: "You detect breaking news. You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON. Do not wrap in code fences.\n\nRequired JSON schema: {\"breaking\": true/false, \"headline\": \"string\", \"summary\": \"string\", \"source\": \"string\", \"entities\": [\"string\"]}\n\nIf nothing breaking is found, respond with: {\"breaking\": false}",
        }, {
          role: "user",
          content: `Check for major breaking news in AI, frontier models, AI policy/regulation, or crypto/blockchain from the LAST 2 HOURS ONLY.\n\nTier-1 entities to watch: ${TIER_1_ENTITIES.join(", ")}\n\nOnly flag genuinely breaking developments — new model releases, major company announcements, significant policy changes, major funding rounds (>$500M). Ignore routine updates, opinion pieces, or minor product features.\n\nIs there anything breaking right now?`,
        }],
        max_tokens: 400,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      console.error(`[BreakingNews] Perplexity API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson<{
      breaking: boolean;
      headline?: string;
      summary?: string;
      source?: string;
      entities?: string[];
    }>(raw, "BreakingNews.check");

    if (!parsed?.breaking || !parsed.headline) {
      console.log("[BreakingNews] No breaking news detected");
      const store = loadEvents();
      store.lastChecked = new Date().toISOString();
      saveEvents(store);
      return null;
    }

    const store = loadEvents();

    // Dedup
    if (isDuplicate(parsed.headline, store)) {
      console.log(`[BreakingNews] Duplicate detected — skipping: "${parsed.headline.slice(0, 60)}"`);
      store.lastChecked = new Date().toISOString();
      saveEvents(store);
      return null;
    }

    const entities = parsed.entities ?? [];
    const tier = scoreTier(parsed.headline, entities);

    const event: BreakingNewsEvent = {
      id: `bn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      headline: parsed.headline,
      summary: parsed.summary ?? "",
      source: parsed.source ?? "perplexity-sonar",
      tier,
      entities,
      detectedAt: new Date().toISOString(),
      posted: false,
      postedAt: null,
    };

    store.events.push(event);
    store.lastChecked = new Date().toISOString();

    // Keep only last 100 events
    if (store.events.length > 100) {
      store.events = store.events.slice(-100);
    }

    saveEvents(store);
    console.log(`[BreakingNews] Tier-${tier} event detected: "${parsed.headline.slice(0, 80)}"`);
    return event;
  } catch (e: any) {
    console.error("[BreakingNews] Check failed:", e.message);
    return null;
  }
}

export function shouldPostImmediately(event: BreakingNewsEvent): boolean {
  return event.tier === 1;
}

export async function generateBreakingPost(event: BreakingNewsEvent): Promise<string | null> {
  try {
    const voice = getVoiceContext("news");
    const context = getOptimizedContext("breaking news post");
    const model = getModel("news-dispatch");

    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model,
        messages: [{
          role: "system",
          content: `${voice}\n\n${context}\n\nYou are Agent 306 writing a BREAKING NEWS post. Use the [306 NEWS] show tag. Be factual, concise, and add your analytical edge. Let the content dictate the length — say what needs to be said, then stop.`,
        }, {
          role: "user",
          content: `Breaking: ${event.headline}\n\nDetails: ${event.summary}\n\nEntities involved: ${event.entities.join(", ")}\n\nWrite a tweet about this breaking development.`,
        }],
        max_tokens: 600,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error(`[BreakingNews] LLM generation error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text || text.length < 20) return null;

    return enforcePostFormat(text, "news");
  } catch (e: any) {
    console.error("[BreakingNews] Post generation failed:", e.message);
    return null;
  }
}

function isWithinPostingHours(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  // Posting hours: 8am-10pm ET = 12 UTC to 02 UTC (next day)
  return utcHour >= 12 || utcHour < 2;
}

function markEventPosted(eventId: string): void {
  const store = loadEvents();
  const event = store.events.find(e => e.id === eventId);
  if (event) {
    event.posted = true;
    event.postedAt = new Date().toISOString();
    saveEvents(store);
  }
}

export function startBreakingNewsLoop(xWrite: any): void {
  console.log("[BreakingNews] Starting breaking news detection loop (every 30 min during posting hours)");

  async function runCheck() {
    if (!isWithinPostingHours()) {
      console.log("[BreakingNews] Outside posting hours — skipping check");
      return;
    }

    const event = await checkBreakingNews();
    if (!event) return;

    if (shouldPostImmediately(event)) {
      // Tier 1: Generate and post immediately
      const post = await generateBreakingPost(event);
      if (post) {
        const validation = validateXPost(post, "news");
        if (validation.allowed) {
          try {
            await xWrite.v2.tweet({ text: post });
            recordXPost(post, "news");
            markEventPosted(event.id);
            console.log(`[BreakingNews] TIER-1 posted immediately: "${post.slice(0, 60)}"`);
          } catch (e: any) {
            console.error("[BreakingNews] Tweet failed:", e.message);
            // Fall back to high-priority queue
            queueXPost(post, "news", 0);
            markEventPosted(event.id);
          }
        } else {
          console.log(`[BreakingNews] Compliance blocked: ${validation.reason}`);
          // Queue for next available slot
          queueXPost(post, "news", 1);
          markEventPosted(event.id);
        }
      }
    } else if (event.tier === 2) {
      // Tier 2: Queue as high-priority
      const post = await generateBreakingPost(event);
      if (post) {
        queueXPost(post, "news", 1);
        markEventPosted(event.id);
        console.log(`[BreakingNews] Tier-2 queued high-priority: "${event.headline.slice(0, 60)}"`);
      }
    } else {
      // Tier 3: Queue as normal
      const post = await generateBreakingPost(event);
      if (post) {
        queueXPost(post, "news", 5);
        markEventPosted(event.id);
        console.log(`[BreakingNews] Tier-3 queued normal: "${event.headline.slice(0, 60)}"`);
      }
    }
  }

  // Check every 30 minutes
  setInterval(() => {
    runCheck().catch(e => console.error("[BreakingNews] Loop error:", e.message));
  }, 30 * 60 * 1000);

  // Initial check after 1 minute (let other systems start up)
  setTimeout(() => {
    runCheck().catch(e => console.error("[BreakingNews] Initial check error:", e.message));
  }, 60 * 1000);
}
