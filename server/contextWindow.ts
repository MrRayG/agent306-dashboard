/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — KNOWLEDGE CONTEXT WINDOW
 *
 *  Relevance-ranked KB selection per Grok call instead of
 *  dumping the full 466+ entry knowledge base.
 *
 *  Splits getFullAgentContext() into:
 *    getCoreIdentity()    — always included (soul, principles)
 *    getRelevantContext()  — dynamically selected by query
 *
 *  Grok calls become: getCoreIdentity() + getRelevantContext(query)
 * ─────────────────────────────────────────────────────────────
 */

import {
  getSoulContext,
  getSentimentArc,
  getPerformanceContext,
  knowledge,
  type KnowledgeEntry,
} from "./memoryEngine.js";
import { semanticSearch } from "./embeddingEngine.js";
import * as fs from "fs";
import { dataPath } from "./dataPaths.js";

// ── Operator Directives — persistent standing orders from MrRayG ────────────
const DIRECTIVES_FILE = dataPath("operator_directives.json");

export function addOperatorDirective(title: string, summary: string): void {
  let directives: Array<{ title: string; summary: string; addedAt: string }> = [];
  try {
    if (fs.existsSync(DIRECTIVES_FILE)) {
      directives = JSON.parse(fs.readFileSync(DIRECTIVES_FILE, "utf8"));
    }
  } catch {}

  // Dedup by title similarity
  const isDuplicate = directives.some(d =>
    d.title.toLowerCase() === title.toLowerCase() ||
    d.summary.toLowerCase().includes(summary.toLowerCase().slice(0, 50))
  );
  if (isDuplicate) return;

  directives.push({ title, summary, addedAt: new Date().toISOString() });

  // Keep most recent 30 directives
  if (directives.length > 30) directives = directives.slice(-30);

  try {
    fs.writeFileSync(DIRECTIVES_FILE, JSON.stringify(directives, null, 2));
    console.log(`[Chat] Stored operator directive: "${title}"`);
  } catch (e: any) {
    console.warn("[Chat] Failed to write operator directive:", e.message);
  }
}

export function getOperatorDirectives(): string {
  try {
    if (!fs.existsSync(DIRECTIVES_FILE)) return "";
    const directives = JSON.parse(fs.readFileSync(DIRECTIVES_FILE, "utf8"));
    if (!directives.length) return "";
    const lines = directives.slice(-15).map((d: any) => `- ${d.title}: ${d.summary}`).join("\n");
    return `\nOPERATOR DIRECTIVES (from MrRayG — these are standing orders):\n${lines}\n`;
  } catch { return ""; }
}

// ── Stopwords — filtered from query matching ─────────────────────────────────
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "and",
  "but", "or", "not", "no", "nor", "so", "yet", "both", "each",
  "all", "any", "few", "more", "most", "other", "some", "such",
  "than", "too", "very", "just", "about", "up", "out", "if", "then",
  "that", "this", "it", "its", "what", "which", "who", "whom",
  "when", "where", "why", "how",
]);

/** Tokenize a string into meaningful words */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** Score a knowledge entry against a query */
function scoreEntry(
  entry: KnowledgeEntry,
  queryTokens: string[],
  options: RelevantContextOptions,
): number {
  if (!entry.title && !entry.summary) return 0;

  // Skip archived unless explicitly requested
  if ((entry.status ?? "active") === "archived") return 0;

  // Minimum weight threshold
  if (entry.weight < (options.minWeight ?? 5)) return 0;

  // 1. Keyword match — how many query words appear in title + summary
  const entryText = `${entry.title ?? ""} ${entry.summary ?? ""}`.toLowerCase();
  let keywordScore = 0;
  for (const token of queryTokens) {
    if (entryText.includes(token)) keywordScore++;
  }
  if (keywordScore === 0) return 0; // no match = no relevance

  // Normalize by query length so longer queries don't inflate scores
  const normalizedKeyword = queryTokens.length > 0
    ? keywordScore / queryTokens.length
    : 0;

  // 2. Category boost — if caller specifies preferred categories
  const categoryBoost = options.categories?.includes(entry.category) ? 2.0 : 1.0;

  // 3. Weight factor — entry.weight / 10
  const weightFactor = entry.weight / 10;

  // 4. Recency boost — entries from last 7 days get 1.5x
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const referenceDate = entry.updatedAt ?? entry.learnedAt;
  const age = Date.now() - new Date(referenceDate).getTime();
  const recencyBoost = age < SEVEN_DAYS ? 1.5 : 1.0;

  // 5. Tier boost — core/active entries are more relevant
  const tierBoost =
    (entry as any).tier === "core" ? 2.0 :
    (entry as any).tier === "active" ? 1.3 :
    (entry as any).tier === "archived" ? 0.3 : 1.0;

  return normalizedKeyword * categoryBoost * weightFactor * recencyBoost * tierBoost;
}

interface RelevantContextOptions {
  maxEntries?: number;    // default 20
  maxTokens?: number;     // default 4000 chars (~1000 tokens)
  categories?: string[];  // filter to specific categories
  minWeight?: number;     // minimum weight threshold (default 5)
}

/**
 * Get core identity context — always included in every Grok call.
 * Soul, principles, core sentence — the stuff that never changes.
 */
export function getCoreIdentity(): string {
  return getSoulContext();
}

/**
 * Get relevance-ranked knowledge entries for a specific query.
 * Replaces the full knowledge dump with targeted context.
 */
export function getRelevantContext(
  query: string,
  options: RelevantContextOptions = {},
): string {
  const maxEntries = options.maxEntries ?? 20;
  const maxChars = options.maxTokens ?? 4000;

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    // Fallback: no usable query, return top entries by weight
    const top = knowledge.entries
      .filter(e => (e.status ?? "active") === "active")
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.min(maxEntries, 8));

    if (top.length === 0) return "";

    let ctx = `\n=== KNOWLEDGE CONTEXT (top ${top.length} by weight) ===\n`;
    for (const e of top) {
      ctx += `[${e.category.toUpperCase()}] ${e.title}: ${e.summary}\n`;
    }
    ctx += "=== END KNOWLEDGE ===\n";
    return ctx;
  }

  // Score all active entries
  const scored = knowledge.entries
    .map(entry => ({ entry, score: scoreEntry(entry, queryTokens, options) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Take top N entries within char budget
  const selected: KnowledgeEntry[] = [];
  let totalChars = 0;
  for (const { entry } of scored) {
    const line = `[${entry.category.toUpperCase()}] ${entry.title}: ${entry.summary}\n`;
    if (totalChars + line.length > maxChars) break;
    if (selected.length >= maxEntries) break;
    selected.push(entry);
    totalChars += line.length;
  }

  if (selected.length === 0) return "";

  let ctx = `\n=== RELEVANT KNOWLEDGE (${selected.length} entries matched) ===\n`;
  for (const e of selected) {
    ctx += `[${e.category.toUpperCase()}] ${e.title}: ${e.summary}\n`;
  }
  ctx += "=== END KNOWLEDGE ===\n";
  return ctx;
}

/**
 * Async version of getRelevantContext that uses embedding-based semantic search.
 * Falls back to keyword matching if embeddings are unavailable.
 */
export async function getRelevantContextAsync(
  query: string,
  options: RelevantContextOptions = {},
): Promise<string> {
  const maxEntries = options.maxEntries ?? 20;
  const maxChars = options.maxTokens ?? 4000;

  // Try semantic search first
  try {
    const results = await semanticSearch(query, {
      maxResults: maxEntries,
      minSimilarity: 0.3,
      categories: options.categories,
      excludeArchived: true,
    });

    if (results.length > 0) {
      let ctx = `\n=== RELEVANT KNOWLEDGE (${results.length} entries, semantic match) ===\n`;
      let totalChars = 0;
      for (const { entry, similarity } of results) {
        const line = `[${entry.category.toUpperCase()}] ${entry.title}: ${entry.summary}\n`;
        if (totalChars + line.length > maxChars) break;
        ctx += line;
        totalChars += line.length;
      }
      ctx += "=== END KNOWLEDGE ===\n";
      return ctx;
    }
  } catch (e: any) {
    console.warn("[ContextWindow] Semantic search failed, falling back to keywords:", e.message);
  }

  // Fallback to keyword matching
  return getRelevantContext(query, options);
}

/**
 * Async version of getOptimizedContext that uses semantic search.
 */
export async function getOptimizedContextAsync(query: string, options?: RelevantContextOptions): Promise<string> {
  let styleRules = "";
  try {
    const fs = require("fs");
    const { dataPath } = require("./dataPaths.js");
    const rulesFile = dataPath("style-rules.json");
    if (fs.existsSync(rulesFile)) {
      const data = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
      const rules = (data.rules ?? [])
        .filter((r: any) => r.confidence === "high" || r.hitCount >= 2)
        .slice(0, 10)
        .map((r: any) => `- ${r.rule}`)
        .join("\n");
      if (rules) styleRules = `\nACTIVE STYLE RULES (learned from post performance):\n${rules}`;
    }
  } catch {}

  return [
    getCoreIdentity(),
    getOperatorDirectives(),
    await getRelevantContextAsync(query, options),
    getSentimentArc(4),
    getPerformanceContext(5),
    styleRules,
  ].filter(Boolean).join("\n\n");
}

/**
 * Build the full optimized context for a Grok call.
 * Replaces getFullAgentContext() for callers that have a query.
 *
 * Returns: core identity + relevant knowledge + sentiment arc + performance
 */
export function getOptimizedContext(query: string, options?: RelevantContextOptions): string {
  // Import getFullAgentContext's style rules section via the public API
  // The style rules are injected into getFullAgentContext via setStyleRulesProvider
  // We replicate the same pattern here — getSoulContext already exists,
  // and style rules come from reflectionEngine which registers via setStyleRulesProvider.
  // Since we can't access the private _styleRulesProvider, we pull style rules
  // from the getFullAgentContext output by re-using the registered provider.
  let styleRules = "";
  try {
    // reflectionEngine registers a provider on module load
    // We can access it by importing getFullAgentContext and extracting the style section
    // But simpler: just import the style rules file directly
    const fs = require("fs");
    const { dataPath } = require("./dataPaths.js");
    const rulesFile = dataPath("style-rules.json");
    if (fs.existsSync(rulesFile)) {
      const data = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
      const rules = (data.rules ?? [])
        .filter((r: any) => r.confidence === "high" || r.hitCount >= 2)
        .slice(0, 10)
        .map((r: any) => `- ${r.rule}`)
        .join("\n");
      if (rules) styleRules = `\nACTIVE STYLE RULES (learned from post performance):\n${rules}`;
    }
  } catch {}

  return [
    getCoreIdentity(),
    getOperatorDirectives(),
    getRelevantContext(query, options),
    getSentimentArc(4),
    getPerformanceContext(5),
    styleRules,
  ].filter(Boolean).join("\n\n");
}
