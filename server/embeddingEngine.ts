/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — EMBEDDING ENGINE (ASI-Evolve Upgrade 1)
 *
 *  Semantic search over the knowledge base using OpenRouter
 *  embeddings (text-embedding-3-small via OpenAI compatibility).
 *
 *  Replaces pure keyword matching with cosine-similarity search.
 *  Embedding cache persisted to knowledge_embeddings.json.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import crypto from "crypto";
import { dataPath } from "./dataPaths.js";
import { LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { knowledge, type KnowledgeEntry } from "./memoryEngine.js";

const EMBEDDINGS_FILE = dataPath("knowledge_embeddings.json");
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_URL = "https://openrouter.ai/api/v1/embeddings";
const BATCH_SIZE = 50;
const RATE_LIMIT_MS = 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface EmbeddingCacheEntry {
  embedding: number[];
  textHash: string;
}

interface EmbeddingCache {
  version: number;
  entries: Record<string, EmbeddingCacheEntry>;
  lastUpdated: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

let cache: EmbeddingCache = loadCache();

function loadCache(): EmbeddingCache {
  try {
    if (fs.existsSync(EMBEDDINGS_FILE))
      return JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, "utf8"));
  } catch {}
  return { version: 1, entries: {}, lastUpdated: new Date().toISOString() };
}

function saveCache(): void {
  try { fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(cache, null, 2)); } catch {}
}

// ── Hashing ───────────────────────────────────────────────────────────────────

function textHash(text: string): string {
  return crypto.createHash("md5").update(text).digest("hex");
}

function entryText(entry: KnowledgeEntry): string {
  return `${entry.title ?? ""} ${entry.summary ?? ""}`.trim();
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Embedding API ─────────────────────────────────────────────────────────────

let lastApiCall = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const wait = RATE_LIMIT_MS - (now - lastApiCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApiCall = Date.now();
}

/**
 * Generate embedding for a text string via OpenRouter.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  if (!LLM_API_KEY) throw new Error("No LLM API key configured");

  await rateLimitWait();

  const res = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: getLLMHeaders(),
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Embedding API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  return data.data?.[0]?.embedding ?? [];
}

/**
 * Generate embeddings for a batch of texts (up to BATCH_SIZE).
 */
async function getBatchEmbeddings(texts: string[]): Promise<number[][]> {
  if (!LLM_API_KEY) throw new Error("No LLM API key configured");
  if (texts.length === 0) return [];

  await rateLimitWait();

  const res = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: getLLMHeaders(),
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Batch embedding API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  const results: number[][] = [];
  for (const item of (data.data ?? [])) {
    results[item.index] = item.embedding;
  }
  return results;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Ensure all active knowledge entries have up-to-date embeddings.
 */
export async function syncEmbeddings(): Promise<{ synced: number; cached: number }> {
  const activeEntries = knowledge.entries.filter(
    e => (e.status ?? "active") === "active",
  );

  const toEmbed: { id: string; text: string }[] = [];
  let cached = 0;

  for (const entry of activeEntries) {
    const text = entryText(entry);
    if (!text) continue;
    const hash = textHash(text);
    const existing = cache.entries[entry.id];

    if (existing && existing.textHash === hash && existing.embedding?.length > 0) {
      cached++;
    } else {
      toEmbed.push({ id: entry.id, text });
    }
  }

  if (toEmbed.length === 0) {
    return { synced: 0, cached };
  }

  let synced = 0;

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    try {
      const embeddings = await getBatchEmbeddings(batch.map(b => b.text));
      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j]?.length > 0) {
          cache.entries[batch[j].id] = {
            embedding: embeddings[j],
            textHash: textHash(batch[j].text),
          };
          synced++;
        }
      }
    } catch (e: any) {
      console.warn(`[Embeddings] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, e.message);
    }
  }

  cache.lastUpdated = new Date().toISOString();
  saveCache();

  return { synced, cached };
}

// ── Queued sync (debounced) ───────────────────────────────────────────────────

let syncQueue: Set<string> = new Set();
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 30000; // 30 seconds
const SYNC_BATCH_TRIGGER = 10;

/**
 * Queue an entry for embedding sync. Batches are flushed every 30s or when 10+ entries queued.
 */
export function queueEmbeddingSync(entryId: string): void {
  syncQueue.add(entryId);

  if (syncQueue.size >= SYNC_BATCH_TRIGGER) {
    flushSyncQueue();
    return;
  }

  if (!syncTimer) {
    syncTimer = setTimeout(() => flushSyncQueue(), SYNC_DEBOUNCE_MS);
  }
}

async function flushSyncQueue(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }

  const ids = Array.from(syncQueue);
  syncQueue.clear();
  if (ids.length === 0) return;

  const toEmbed: { id: string; text: string }[] = [];
  for (const id of ids) {
    const entry = knowledge.entries.find(e => e.id === id);
    if (!entry) continue;
    const text = entryText(entry);
    if (!text) continue;
    toEmbed.push({ id, text });
  }

  if (toEmbed.length === 0) return;

  try {
    const embeddings = await getBatchEmbeddings(toEmbed.map(b => b.text));
    for (let j = 0; j < toEmbed.length; j++) {
      if (embeddings[j]?.length > 0) {
        cache.entries[toEmbed[j].id] = {
          embedding: embeddings[j],
          textHash: textHash(toEmbed[j].text),
        };
      }
    }
    cache.lastUpdated = new Date().toISOString();
    saveCache();
    console.log(`[Embeddings] Queued sync: ${toEmbed.length} entries embedded`);
  } catch (e: any) {
    console.warn("[Embeddings] Queued sync failed:", e.message);
  }
}

// ── Semantic search ───────────────────────────────────────────────────────────

/**
 * Find top N knowledge entries most similar to a query using cosine similarity.
 */
export async function semanticSearch(
  query: string,
  options: {
    maxResults?: number;
    minSimilarity?: number;
    categories?: string[];
    excludeArchived?: boolean;
  } = {},
): Promise<Array<{ entry: KnowledgeEntry; similarity: number }>> {
  const maxResults = options.maxResults ?? 20;
  const minSimilarity = options.minSimilarity ?? 0.3;
  const excludeArchived = options.excludeArchived ?? true;

  // Get query embedding
  let queryEmbedding: number[];
  try {
    queryEmbedding = await getEmbedding(query);
  } catch (e: any) {
    console.warn("[Embeddings] Query embedding failed:", e.message);
    return [];
  }

  if (queryEmbedding.length === 0) return [];

  const results: Array<{ entry: KnowledgeEntry; similarity: number }> = [];

  for (const entry of knowledge.entries) {
    // Filters
    if (excludeArchived && (entry.status ?? "active") === "archived") continue;
    if (options.categories?.length && !options.categories.includes(entry.category)) continue;

    const cached = cache.entries[entry.id];
    if (!cached?.embedding?.length) continue;

    const similarity = cosineSimilarity(queryEmbedding, cached.embedding);
    if (similarity >= minSimilarity) {
      results.push({ entry, similarity });
    }
  }

  // Sort by similarity descending, take top N
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, maxResults);
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Get embedding cache status for the API.
 */
export function getEmbeddingStatus(): {
  totalEntries: number;
  embeddedEntries: number;
  cacheVersion: number;
  lastUpdated: string;
} {
  const activeEntries = knowledge.entries.filter(
    e => (e.status ?? "active") === "active",
  );
  const embeddedCount = activeEntries.filter(
    e => cache.entries[e.id]?.embedding?.length > 0,
  ).length;

  return {
    totalEntries: activeEntries.length,
    embeddedEntries: embeddedCount,
    cacheVersion: cache.version,
    lastUpdated: cache.lastUpdated,
  };
}
