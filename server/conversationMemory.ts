/**
 * ─────────────────────────────────────────────────────────────
 *  CONVERSATION MEMORY — Agent 306 remembers who she talks to
 *
 *  Tracks per-user interaction history so replies can reference
 *  past conversations. Stored on /data volume, survives restarts.
 *
 *  Every reply sent and every mention received is logged here.
 *  When generating a new reply, the engine pulls the last N
 *  interactions with that user for context.
 * ─────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";

const STATE_FILE = dataPath("conversation_memory.json");

export interface ConversationEntry {
  direction: "them" | "us";  // "them" = they said something, "us" = we replied
  text: string;
  tweetUrl?: string;
  timestamp: string;
}

interface UserConversation {
  username: string;
  firstInteraction: string;
  lastInteraction: string;
  totalInteractions: number;
  entries: ConversationEntry[];
}

interface ConversationMemoryState {
  conversations: Record<string, UserConversation>;  // keyed by lowercase username
  totalUsers: number;
  totalEntries: number;
}

function loadState(): ConversationMemoryState {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { conversations: {}, totalUsers: 0, totalEntries: 0 };
}

function saveState(s: ConversationMemoryState) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

/**
 * Record that a community member said something to us (mention, reply, tag).
 */
export function recordIncoming(username: string, text: string, tweetUrl?: string): void {
  const key = username.toLowerCase().replace(/^@/, "");
  if (!state.conversations[key]) {
    state.conversations[key] = {
      username: key,
      firstInteraction: new Date().toISOString(),
      lastInteraction: new Date().toISOString(),
      totalInteractions: 0,
      entries: [],
    };
    state.totalUsers++;
  }

  const convo = state.conversations[key];
  const cappedText = text.slice(0, 25000);
  convo.entries.push({
    direction: "them",
    text: cappedText,
    tweetUrl,
    timestamp: new Date().toISOString(),
  });
  convo.totalInteractions++;
  convo.lastInteraction = new Date().toISOString();

  // Index for search
  if (indexBuilt) indexMessage(key, cappedText, convo.entries.length - 1);

  // Keep last 20 entries per user
  if (convo.entries.length > 20) {
    convo.entries = convo.entries.slice(-20);
    // Rebuild index for this user since indices shifted
    buildSearchIndex();
  }

  state.totalEntries++;
  saveState(state);
}

/**
 * Record that Agent 306 replied to someone.
 */
export function recordOutgoing(username: string, text: string, tweetUrl?: string): void {
  const key = username.toLowerCase().replace(/^@/, "");
  if (!state.conversations[key]) {
    state.conversations[key] = {
      username: key,
      firstInteraction: new Date().toISOString(),
      lastInteraction: new Date().toISOString(),
      totalInteractions: 0,
      entries: [],
    };
    state.totalUsers++;
  }

  const convo = state.conversations[key];
  const cappedText = text.slice(0, 25000);
  convo.entries.push({
    direction: "us",
    text: cappedText,
    tweetUrl,
    timestamp: new Date().toISOString(),
  });
  convo.totalInteractions++;
  convo.lastInteraction = new Date().toISOString();

  // Index for search
  if (indexBuilt) indexMessage(key, cappedText, convo.entries.length - 1);

  // Keep last 20 entries per user
  if (convo.entries.length > 20) {
    convo.entries = convo.entries.slice(-20);
    buildSearchIndex();
  }

  state.totalEntries++;
  saveState(state);
}

/**
 * Get conversation history with a specific user (for prompt injection).
 * Returns most recent entries, formatted with relative timestamps.
 */
export function getConversationHistory(username: string, limit = 5): Array<{
  direction: "them" | "us";
  text: string;
  when: string;
}> {
  const key = username.toLowerCase().replace(/^@/, "");
  const convo = state.conversations[key];
  if (!convo || convo.entries.length === 0) return [];

  return convo.entries
    .slice(-limit)
    .map(e => ({
      direction: e.direction,
      text: e.text,
      when: timeAgo(e.timestamp),
    }));
}

/**
 * Get stats about a user's interaction history (for dashboard/context).
 */
export function getUserRelationship(username: string): {
  known: boolean;
  firstSeen: string | null;
  totalInteractions: number;
  lastInteraction: string | null;
} {
  const key = username.toLowerCase().replace(/^@/, "");
  const convo = state.conversations[key];
  if (!convo) return { known: false, firstSeen: null, totalInteractions: 0, lastInteraction: null };
  return {
    known: true,
    firstSeen: convo.firstInteraction,
    totalInteractions: convo.totalInteractions,
    lastInteraction: convo.lastInteraction,
  };
}

/**
 * Get full conversation memory state for the dashboard.
 */
export function getConversationMemoryState() {
  return {
    totalUsers: state.totalUsers,
    totalEntries: state.totalEntries,
    topUsers: Object.values(state.conversations)
      .sort((a, b) => b.totalInteractions - a.totalInteractions)
      .slice(0, 10)
      .map(c => ({
        username: c.username,
        totalInteractions: c.totalInteractions,
        firstInteraction: c.firstInteraction,
        lastInteraction: c.lastInteraction,
      })),
  };
}

// ── In-Memory Full-Text Search Index ─────────────────────────
// Option A from spec: inverted index built from conversation JSON.
// No SQLite dependency — manageable in memory for Agent 306's volume.

export interface ConversationSearchResult {
  username: string;
  timestamp: string;
  text: string;
  direction: "them" | "us";
  score: number;
}

// Inverted index: token → list of { username, entryIndex }
const searchIndex: Map<string, Array<{ username: string; idx: number }>> = new Map();
let indexBuilt = false;

const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "and",
  "but", "or", "not", "so", "it", "its", "this", "that", "i", "we",
  "you", "he", "she", "they", "my", "me", "your", "our",
]);

function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !SEARCH_STOPWORDS.has(w));
}

/** Build the search index from all conversations */
function buildSearchIndex(): void {
  searchIndex.clear();
  for (const [username, convo] of Object.entries(state.conversations)) {
    for (let idx = 0; idx < convo.entries.length; idx++) {
      const tokens = tokenizeForSearch(convo.entries[idx].text);
      Array.from(new Set(tokens)).forEach(token => { // unique tokens per entry
        if (!searchIndex.has(token)) searchIndex.set(token, []);
        searchIndex.get(token)!.push({ username, idx });
      });
    }
  }
  indexBuilt = true;
}

/** Add a single message to the search index */
function indexMessage(username: string, text: string, idx: number): void {
  const key = username.toLowerCase().replace(/^@/, "");
  const tokens = tokenizeForSearch(text);
  Array.from(new Set(tokens)).forEach(token => {
    if (!searchIndex.has(token)) searchIndex.set(token, []);
    searchIndex.get(token)!.push({ username: key, idx });
  });
}

/**
 * Full-text search across all conversation history.
 * Returns matching messages ranked by relevance.
 */
export function searchConversations(query: string, limit = 10): ConversationSearchResult[] {
  if (!indexBuilt) buildSearchIndex();

  const queryTokens = tokenizeForSearch(query);
  if (queryTokens.length === 0) return [];

  // Score each message by how many query tokens match
  const scores: Map<string, number> = new Map(); // "username|idx" → score

  for (const token of queryTokens) {
    const matches = searchIndex.get(token) ?? [];
    for (const { username, idx } of matches) {
      const key = `${username}|${idx}`;
      scores.set(key, (scores.get(key) ?? 0) + 1);
    }
  }

  // Convert to results
  const results: ConversationSearchResult[] = [];
  for (const [key, score] of Array.from(scores.entries())) {
    const [username, idxStr] = key.split("|");
    const idx = parseInt(idxStr, 10);
    const convo = state.conversations[username];
    if (!convo || !convo.entries[idx]) continue;

    const entry = convo.entries[idx];
    results.push({
      username,
      timestamp: entry.timestamp,
      text: entry.text,
      direction: entry.direction,
      score: score / queryTokens.length, // normalize by query length
    });
  }

  // Sort by score desc, then recency
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  return results.slice(0, limit);
}

// Build index on startup
buildSearchIndex();

// ── Helper ────────────────────────────────────────────────────
function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}
