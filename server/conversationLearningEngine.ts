// ─────────────────────────────────────────────────────────────────────────────
// AGENT #306 — CONVERSATION LEARNING ENGINE (The Network)
//
// Extracts insights from community conversations into knowledge base,
// tracks relationship intelligence (who engages, allies, critics, power users).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { addKnowledge, getFullAgentContext, scanForInjection } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_URL = LLM_BASE_URL;
const GROK_API_KEY = LLM_API_KEY;
const INSIGHTS_FILE = dataPath("conversation-insights.json");
const RELATIONSHIPS_FILE = dataPath("relationships.json");
const CONVERSATION_MEMORY_FILE = dataPath("conversation_memory.json");

const GROK_RATE_MS = 5000;

// ── Stale-Handle Filter (Normies-era purge) ──────────────────────────────────
// Handles from the old Normies Discord that should never appear in relationship
// analysis. These were purged on startup but the underlying conversation_memory
// data kept regenerating them on every "Analyze Relationships" click.

const BAD_HANDLES = new Set([
  "serc1n", "dopemind10", "tryaskom", "spoliticusmedia", "persy41430289",
  "nuclearsamurai", "gnormie",
]);

// Broader keyword list — any conversation entry or LLM result mentioning these
// is from the old Normies/NFT era and should be filtered out.
const STALE_KEYWORDS = [
  "normie", "normiestv", "canvas live", "pixel toggle", "pixel currency",
  "holder catalog", "nft identity", "on-chain object", "on-chain identity",
  "token #306", "yigit", "serc1n", "nuclearsamurai", "opensea", "live burn",
  "burn mechanic", "burn receipt", "web3art", "gnormie",
  "erc-8004", "on-chain burn", "pixel count", "burn data", "serc article",
  "normies ecosystem", "normieshive", "canvas experiment", "normies agent",
  "normies saga", "normies story", "normies community", "#normies",
  "#onchainart", "dopemind", "canvas live writes",
];

function isStaleHandle(username: string): boolean {
  return BAD_HANDLES.has(username.toLowerCase().replace(/^@/, ""));
}

function containsStaleKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return STALE_KEYWORDS.some(k => lower.includes(k));
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConversationInsight {
  id: string;
  insight: string;
  source: string; // e.g., "conversation with @username"
  confidence: "high" | "medium" | "low";
  addedToKB: boolean;
  createdAt: string;
}

export interface Relationship {
  username: string;
  totalInteractions: number;
  avgSentiment: number; // -1 to 1
  lastInteraction: string;
  tags: ("power_user" | "critic" | "ally" | "new_voice" | "contributor" | "lurker")[];
  notableContributions: string[];
  firstSeen: string;
}

interface InsightsState {
  insights: ConversationInsight[];
  lastExtractionAt: string | null;
}

interface RelationshipsState {
  relationships: Record<string, Relationship>;
  lastAnalysisAt: string | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadInsights(): InsightsState {
  try {
    if (fs.existsSync(INSIGHTS_FILE))
      return JSON.parse(fs.readFileSync(INSIGHTS_FILE, "utf8"));
  } catch {}
  return { insights: [], lastExtractionAt: null };
}

function saveInsights(s: InsightsState): void {
  try { fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function loadRelationships(): RelationshipsState {
  try {
    if (fs.existsSync(RELATIONSHIPS_FILE))
      return JSON.parse(fs.readFileSync(RELATIONSHIPS_FILE, "utf8"));
  } catch {}
  return { relationships: {}, lastAnalysisAt: null };
}

function saveRelationships(s: RelationshipsState): void {
  try {
    fs.writeFileSync(RELATIONSHIPS_FILE, JSON.stringify(s, null, 2));
    console.log(`[Relationships] Saved ${Object.keys(s.relationships).length} relationships to ${RELATIONSHIPS_FILE}`);
  } catch (e: any) {
    console.error(`[Relationships] FAILED to save: ${e.message} — path: ${RELATIONSHIPS_FILE}`);
  }
}

let insights = loadInsights();
let relationships = loadRelationships();

// ── Grok call ─────────────────────────────────────────────────────────────────

let lastGrokCall = 0;

async function callGrok(systemPrompt: string, userPrompt: string): Promise<any | null> {
  if (!GROK_API_KEY) return null;

  const now = Date.now();
  const wait = GROK_RATE_MS - (now - lastGrokCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGrokCall = Date.now();

  let raw = "";
  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("conversation_insight"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    raw = data.choices?.[0]?.message?.content ?? "{}";
    return safeParseLLMJson(raw, "ConversationLearning");
  } catch (e: any) {
    console.error(`[ConversationLearning] LLM JSON parse failed:`, e.message, `— raw response: ${raw?.slice(0, 200)}`);
    return null;
  }
}

// ── Load conversation memory ──────────────────────────────────────────────────

function loadConversationMemory(): Record<string, {
  username: string;
  firstInteraction: string;
  lastInteraction: string;
  totalInteractions: number;
  entries: Array<{ direction: "them" | "us"; text: string; timestamp: string }>;
}> {
  try {
    if (fs.existsSync(CONVERSATION_MEMORY_FILE)) {
      const state = JSON.parse(fs.readFileSync(CONVERSATION_MEMORY_FILE, "utf8"));
      return state.conversations ?? {};
    }
  } catch {}
  return {};
}

// ── Insight Extraction ────────────────────────────────────────────────────────

export async function extractInsights(): Promise<ConversationInsight[]> {
  const conversations = loadConversationMemory();
  // Filter out stale Normies-era handles
  const users = Object.values(conversations)
    .filter(u => !isStaleHandle(u.username));
  if (users.length === 0) return [];

  // Get recent conversations (entries from last 7 days)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentConvos: string[] = [];

  for (const user of users) {
    const recent = user.entries.filter(e =>
      new Date(e.timestamp).getTime() > cutoff && !containsStaleKeyword(e.text)
    );
    if (recent.length === 0) continue;

    recentConvos.push(
      `--- @${user.username} (${user.totalInteractions} total interactions) ---\n` +
      recent.map(e => `${e.direction === "them" ? "THEM" : "AGENT306"}: ${e.text}`).join("\n")
    );
  }

  if (recentConvos.length === 0) return [];

  const systemPrompt = `${getOptimizedContext("community conversation insights knowledge extraction")}

You extract knowledge insights from Agent 306's community conversations.
Respond with ONLY valid JSON:
{
  "insights": [
    {
      "insight": "what was learned — a fact, correction, or new perspective",
      "source": "conversation with @username",
      "confidence": "high" | "medium" | "low"
    }
  ]
}

Rules:
- Only extract genuine new information or corrections
- Skip pleasantries, thank-yous, and meta-conversation
- High confidence: directly stated facts with evidence
- Medium: reasonable claims worth tracking
- Low: opinions or unverified claims
- 0-10 insights per batch`;

  const userPrompt = `RECENT COMMUNITY CONVERSATIONS (last 7 days):

${recentConvos.slice(0, 15).join("\n\n")}

What new facts, corrections, or perspectives did Agent 306 learn from these interactions?`;

  const result = await callGrok(systemPrompt, userPrompt);
  if (!result?.insights) return [];

  const extracted: ConversationInsight[] = [];

  for (const i of result.insights) {
    if (!i.insight) continue;

    const entry: ConversationInsight = {
      id: `insight_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      insight: i.insight,
      source: i.source ?? "community conversations",
      confidence: i.confidence ?? "medium",
      addedToKB: false,
      createdAt: new Date().toISOString(),
    };

    // Auto-add high-confidence insights to KB (with injection scan)
    if (entry.confidence === "high") {
      const scan = scanForInjection(entry.insight);
      if (scan.safe) {
        addKnowledge({
          category: "community_pattern",
          title: entry.insight.slice(0, 80),
          summary: entry.insight,
          weight: 6,
          source: entry.source,
        });
        entry.addedToKB = true;
      } else {
        console.warn(`[ConvoLearning] Blocked insight injection: ${scan.threats.join(", ")}`);
      }
    }

    extracted.push(entry);
  }

  if (extracted.length > 0) {
    insights.insights.unshift(...extracted);
    if (insights.insights.length > 200) insights.insights = insights.insights.slice(0, 200);
    insights.lastExtractionAt = new Date().toISOString();
    saveInsights(insights);
    console.log(`[ConvoLearning] Extracted ${extracted.length} insights (${extracted.filter(i => i.addedToKB).length} added to KB)`);
  }

  return extracted;
}

// ── Relationship Analysis ─────────────────────────────────────────────────────

export async function analyzeRelationships(): Promise<Relationship[]> {
  const conversations = loadConversationMemory();
  // Filter out stale Normies-era handles before sending anything to the LLM
  const users = Object.values(conversations)
    .filter(u => !isStaleHandle(u.username));
  if (users.length === 0) return [];

  // Build summary for Grok
  const userSummaries = users
    .sort((a, b) => b.totalInteractions - a.totalInteractions)
    .slice(0, 30)
    .map(u => {
      // Also filter individual entries that mention stale keywords
      const cleanEntries = u.entries.filter(e => !containsStaleKeyword(e.text));
      const recentEntries = cleanEntries.slice(-5);
      const sampleTexts = recentEntries
        .map(e => `${e.direction === "them" ? "THEM" : "US"}: ${e.text.slice(0, 100)}`)
        .join(" | ");
      return `@${u.username}: ${u.totalInteractions} interactions, first: ${u.firstInteraction.slice(0, 10)}, last: ${u.lastInteraction.slice(0, 10)}, recent: "${sampleTexts}"`;
    })
    .filter(s => !containsStaleKeyword(s))
    .join("\n");

  const systemPrompt = `Analyze community relationships for Agent 306.
Respond with ONLY valid JSON:
{
  "relationships": [
    {
      "username": "string",
      "sentiment": -1 to 1 (number),
      "tags": ["power_user"|"critic"|"ally"|"new_voice"|"contributor"|"lurker"],
      "notableContribution": "string or null"
    }
  ]
}

Tags:
- power_user: high engagement, frequent interactor
- critic: asks tough questions, challenges Agent 306
- ally: supportive, amplifies content
- new_voice: recent first interaction
- contributor: provides useful information
- lurker: low interaction but present`;

  const userPrompt = `COMMUNITY MEMBERS:

${userSummaries}

Classify each member's relationship with Agent 306.`;

  const result = await callGrok(systemPrompt, userPrompt);
  if (!result?.relationships) return [];

  const updated: Relationship[] = [];

  for (const r of result.relationships) {
    if (!r.username) continue;
    const key = r.username.toLowerCase().replace(/^@/, "");

    // Post-analysis safety net: skip stale handles even if LLM returned them
    if (isStaleHandle(key)) continue;
    if (containsStaleKeyword(key)) continue;
    if (r.notableContribution && containsStaleKeyword(r.notableContribution)) continue;

    const convo = conversations[key];
    if (!convo) continue;

    const existing = relationships.relationships[key];

    relationships.relationships[key] = {
      username: key,
      totalInteractions: convo.totalInteractions,
      avgSentiment: r.sentiment ?? 0,
      lastInteraction: convo.lastInteraction,
      tags: r.tags ?? [],
      notableContributions: [
        ...(existing?.notableContributions ?? []),
        ...(r.notableContribution ? [r.notableContribution] : []),
      ].slice(-5),
      firstSeen: existing?.firstSeen ?? convo.firstInteraction,
    };

    updated.push(relationships.relationships[key]);
  }

  if (updated.length > 0) {
    relationships.lastAnalysisAt = new Date().toISOString();
    saveRelationships(relationships);
    console.log(`[ConvoLearning] Analyzed ${updated.length} relationships`);
  }

  return updated;
}

// ── Getters ───────────────────────────────────────────────────────────────────

export function getInsights(): ConversationInsight[] {
  return insights.insights;
}

export function getRelationships(): Relationship[] {
  return Object.values(relationships.relationships)
    .sort((a, b) => b.totalInteractions - a.totalInteractions);
}

export function purgeStaleRelationships(): { purged: number } {
  const before = Object.keys(relationships.relationships).length;

  // Remove all relationships — Agent 306 is no longer in the Normies community
  // Fresh relationships will build from new Farcaster/X interactions
  relationships.relationships = {};
  relationships.lastAnalysisAt = null;

  insights.insights = insights.insights.filter((i) => {
    const content = JSON.stringify(i).toLowerCase();
    return !content.includes("normies") && !content.includes("serc1n") && !content.includes("dopemind");
  });

  saveRelationships(relationships);
  saveInsights(insights);
  return { purged: before };
}

/**
 * One-time startup purge: remove stale Normies-era users from conversation_memory.json.
 * This is the SOURCE data that analyzeRelationships() reads — without cleaning it,
 * every "Analyze Relationships" click regenerates old handles.
 * Uses the same idempotent flag pattern as memoryEngine.ts cleanupOldIdentity().
 */
export function purgeStaleConversationMemory(): { purgedUsers: number; purgedEntries: number } {
  const FLAG_FILE = dataPath("migration_conversation_memory_cleanup.json");
  if (fs.existsSync(FLAG_FILE)) return { purgedUsers: 0, purgedEntries: 0 };

  if (!fs.existsSync(CONVERSATION_MEMORY_FILE)) {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({ completedAt: new Date().toISOString(), version: 1 }, null, 2));
    return { purgedUsers: 0, purgedEntries: 0 };
  }

  let state: { conversations: Record<string, any>; totalUsers: number; totalEntries: number };
  try {
    state = JSON.parse(fs.readFileSync(CONVERSATION_MEMORY_FILE, "utf8"));
  } catch {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({ completedAt: new Date().toISOString(), version: 1 }, null, 2));
    return { purgedUsers: 0, purgedEntries: 0 };
  }

  let purgedUsers = 0;
  let purgedEntries = 0;

  // Remove entire user records for known bad handles
  for (const key of Object.keys(state.conversations ?? {})) {
    if (isStaleHandle(key)) {
      purgedEntries += state.conversations[key].entries?.length ?? 0;
      delete state.conversations[key];
      purgedUsers++;
    }
  }

  // For remaining users, remove individual entries that contain stale keywords
  for (const key of Object.keys(state.conversations ?? {})) {
    const convo = state.conversations[key];
    const before = convo.entries?.length ?? 0;
    convo.entries = (convo.entries ?? []).filter(
      (e: any) => !containsStaleKeyword(e.text ?? "")
    );
    const removed = before - convo.entries.length;
    if (removed > 0) {
      purgedEntries += removed;
      convo.totalInteractions = convo.entries.length;
    }
  }

  if (purgedUsers > 0 || purgedEntries > 0) {
    state.totalUsers = Object.keys(state.conversations).length;
    state.totalEntries = Object.values(state.conversations)
      .reduce((sum: number, c: any) => sum + (c.entries?.length ?? 0), 0);
    fs.writeFileSync(CONVERSATION_MEMORY_FILE, JSON.stringify(state, null, 2));
    console.log(`[ConvoLearning] MIGRATION: Purged ${purgedUsers} stale users, ${purgedEntries} stale entries from conversation_memory.json`);
  }

  fs.writeFileSync(FLAG_FILE, JSON.stringify({ completedAt: new Date().toISOString(), version: 1 }, null, 2));
  console.log("[ConvoLearning] MIGRATION: Conversation memory cleanup complete — flag written");
  return { purgedUsers, purgedEntries };
}

export function getConversationLearningStats() {
  const rels = Object.values(relationships.relationships);
  const topContributors = rels
    .filter(r => r.tags.includes("power_user") || r.tags.includes("contributor"))
    .sort((a, b) => b.totalInteractions - a.totalInteractions)
    .slice(0, 5)
    .map(r => r.username);

  return {
    insightsExtracted: insights.insights.length,
    relationshipsTracked: rels.length,
    topContributors,
  };
}
