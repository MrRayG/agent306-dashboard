/**
 * -----------------------------------------------------------------
 *  NOVELTY GATE
 *
 *  Checks Agent 306's KB + knowledge graph + entity index before
 *  allowing [306 NEWS] framing. Prevents old news from being
 *  presented as breaking — reframes to [306 SIGNAL] or [306 ACADEMY]
 *  when the topic already exists in the knowledge base.
 * -----------------------------------------------------------------
 */

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getRelevantContext } from "./contextWindow.js";
import { getGraphConnections } from "./knowledge-graph.js";
import { knowledge, type KnowledgeEntry } from "./memoryEngine.js";


// ── Optional imports (loaded lazily on first use) ────────────────

type SemanticSearchFn = (query: string, options?: { maxResults?: number; minSimilarity?: number }) => Promise<Array<{ entry: KnowledgeEntry; similarity: number }>>;
type FindEntriesByEntityFn = (name: string) => KnowledgeEntry[];

let semanticSearchFn: SemanticSearchFn | null | undefined; // undefined = not yet loaded
let findEntriesByEntityFn: FindEntriesByEntityFn | null | undefined;

async function getSemanticSearch(): Promise<SemanticSearchFn | null> {
  if (semanticSearchFn !== undefined) return semanticSearchFn;
  try {
    const embedding = await import("./embeddingEngine.js");
    if (typeof embedding.semanticSearch === "function") {
      semanticSearchFn = embedding.semanticSearch;
      return semanticSearchFn;
    }
  } catch {
    console.warn("[NoveltyGate] embeddingEngine not available — skipping semantic search");
  }
  semanticSearchFn = null;
  return null;
}

async function getFindEntriesByEntity(): Promise<FindEntriesByEntityFn | null> {
  if (findEntriesByEntityFn !== undefined) return findEntriesByEntityFn;
  try {
    const entityMod = await import("./entityExtractor.js");
    if (typeof entityMod.findEntriesByEntity === "function") {
      findEntriesByEntityFn = entityMod.findEntriesByEntity;
      return findEntriesByEntityFn;
    }
  } catch {
    console.warn("[NoveltyGate] entityExtractor not available — skipping entity search");
  }
  findEntriesByEntityFn = null;
  return null;
}

// ── Types ────────────────────────────────────────────────────────

export interface NoveltyCheckResult {
  isNovel: boolean;
  confidence: number;
  existingEntries: string[];
  existingConnections: number;
  oldestMention: string | null;
  recommendation: "breaking" | "update" | "analysis" | "skip";
  reason: string;
}

interface NoveltyGateLogEntry {
  id: string;
  timestamp: string;
  headline: string;
  result: NoveltyCheckResult;
  action: "allowed" | "reframed" | "blocked";
}

interface NoveltyGateLog {
  checks: NoveltyGateLogEntry[];
}

// ── Persistence ──────────────────────────────────────────────────

const LOG_FILE = dataPath("novelty_gate_log.json");
const MAX_LOG_ENTRIES = 200;

function loadLog(): NoveltyGateLog {
  try {
    if (fs.existsSync(LOG_FILE)) {
      return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
    }
  } catch (e) {
    console.warn("[NoveltyGate] Failed to load log:", e);
  }
  return { checks: [] };
}

function saveLog(log: NoveltyGateLog): void {
  try {
    if (log.checks.length > MAX_LOG_ENTRIES) {
      log.checks = log.checks.slice(0, MAX_LOG_ENTRIES);
    }
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.warn("[NoveltyGate] Failed to save log:", e);
  }
}

// ── Core Logic ───────────────────────────────────────────────────

export async function checkNovelty(
  headline: string,
  summary: string,
  entities: string[],
): Promise<NoveltyCheckResult> {
  const matchedEntryIds = new Set<string>();
  const matchedEntries: KnowledgeEntry[] = [];

  // Step 1: KB search (keyword)
  const searchQuery = `${headline} ${entities.join(" ")}`.trim();
  try {
    const contextResult = getRelevantContext(searchQuery, { maxEntries: 10, minWeight: 3 });
    // getRelevantContext returns formatted markdown; parse matched entries from KB directly
    const queryTokens = searchQuery.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const activeEntries = knowledge.entries.filter(e => (e.status ?? "active") === "active");
    for (const entry of activeEntries) {
      const entryText = `${entry.title} ${entry.summary}`.toLowerCase();
      const matchCount = queryTokens.filter(t => entryText.includes(t)).length;
      if (matchCount >= Math.max(2, queryTokens.length * 0.3)) {
        if (!matchedEntryIds.has(entry.id)) {
          matchedEntryIds.add(entry.id);
          matchedEntries.push(entry);
        }
      }
    }
  } catch (e) {
    console.warn("[NoveltyGate] KB keyword search failed:", e);
  }

  // Step 1b: Semantic search (if available)
  const semSearch = await getSemanticSearch();
  if (semSearch) {
    try {
      const semanticResults = await semSearch(headline, { maxResults: 5, minSimilarity: 0.5 });
      for (const result of semanticResults) {
        if (!matchedEntryIds.has(result.entry.id)) {
          matchedEntryIds.add(result.entry.id);
          matchedEntries.push(result.entry);
        }
      }
    } catch (e) {
      console.warn("[NoveltyGate] Semantic search failed:", e);
    }
  }

  // Step 2: Graph connection check
  let totalConnections = 0;
  try {
    const allConnections = getGraphConnections();
    for (const entry of matchedEntries) {
      const entryConnections = allConnections.filter(
        c => c.fromEntryId === entry.id || c.toEntryId === entry.id,
      );
      totalConnections += entryConnections.length;
    }
  } catch (e) {
    console.warn("[NoveltyGate] Graph connection check failed:", e);
  }

  // Step 2b: Entity index check
  const entitySearch = await getFindEntriesByEntity();
  if (entitySearch) {
    try {
      for (const entityName of entities) {
        const entityEntries = entitySearch(entityName);
        for (const entry of entityEntries) {
          if (!matchedEntryIds.has(entry.id)) {
            matchedEntryIds.add(entry.id);
            matchedEntries.push(entry);
          }
        }
      }
    } catch (e) {
      console.warn("[NoveltyGate] Entity search failed:", e);
    }
  }

  // Step 3: Temporal analysis
  let oldestMention: string | null = null;
  let temporalScore = 0.9; // default: novel (no matches found)

  if (matchedEntries.length > 0) {
    const dates = matchedEntries
      .map(e => e.learnedAt)
      .filter(Boolean)
      .sort();

    if (dates.length > 0) {
      oldestMention = dates[0];
      const ageMs = Date.now() - new Date(oldestMention).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);

      if (ageHours < 6) {
        temporalScore = 0.8; // likely novel
      } else if (ageHours < 24) {
        temporalScore = 0.5; // possibly novel
      } else if (ageHours < 168) { // 7 days
        temporalScore = 0.1; // likely NOT novel
      } else {
        temporalScore = 0.0; // definitely NOT novel
      }
    }
  }

  // Step 4: Recommendation logic
  const confidence = temporalScore;
  const isNovel = confidence > 0.6;
  let recommendation: NoveltyCheckResult["recommendation"];
  let reason: string;

  if (isNovel) {
    recommendation = "breaking";
    reason = matchedEntries.length === 0
      ? "No existing KB entries found — topic is new to Agent 306"
      : `Topic is recent (oldest mention: ${oldestMention}) — still qualifies as breaking`;
  } else if (confidence > 0.3 && matchedEntries.length <= 2) {
    recommendation = "update";
    reason = `Thin existing knowledge (${matchedEntries.length} entries) but topic not new — frame as update`;
  } else if (matchedEntries.length > 2 || totalConnections > 3) {
    recommendation = "analysis";
    reason = `Well-established topic (${matchedEntries.length} entries, ${totalConnections} graph connections) — frame as analysis`;
  } else {
    recommendation = "skip";
    reason = `Topic already covered (${matchedEntries.length} entries, confidence: ${confidence.toFixed(2)}) — skip posting`;
  }

  return {
    isNovel,
    confidence,
    existingEntries: Array.from(matchedEntryIds),
    existingConnections: totalConnections,
    oldestMention,
    recommendation,
    reason,
  };
}

// ── Dashboard helpers ────────────────────────────────────────────

export function getNoveltyGateLog(limit = 50): NoveltyGateLogEntry[] {
  const log = loadLog();
  return log.checks.slice(0, limit);
}
