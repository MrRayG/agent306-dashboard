/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — EVIDENCE DISPATCHER
 *
 *  Centerpiece of the Proactive Evidence-Fetching pipeline.
 *  All evidence requests flow through a unified priority queue.
 *
 *  Components:
 *    - EvidenceRequestQueue: in-memory priority queue with dedup
 *    - routeEvidenceSearch(): keyword → optimal search sources
 *    - searchXPlatform(): Grok x_search wrapper for evidence
 *    - processEvidenceQueue(): batch-processes queued requests
 * ─────────────────────────────────────────────────────────────
 */

import { getModel } from "./modelRouter.js";
import { researchWithPerplexity, researchWithSemanticScholar, researchMultiSource } from "./researchEngine.js";
import { addKnowledge } from "./memoryEngine.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SourceType = "perplexity_web" | "semantic_scholar" | "grok_x_search" | "perplexity_news";

export interface SearchRoute {
  sources: Array<{
    type: SourceType;
    priority: number;       // 1 = primary, 2 = secondary
    queryModifier?: string; // e.g., "site:arxiv.org" for academic
  }>;
  maxQueries: number;       // cost cap per hypothesis
  recencyFilter?: string;   // "day", "week", "month"
}

export interface EvidenceRequest {
  id: string;
  source: "hypothesis_test" | "hypothesis_resolve" | "debate_suggestion" | "triad_reasoner" | "analysis_loopback" | "grounding_review";
  priority: number;          // 1-10, higher = more urgent
  query: string;
  targetId: string;          // hypothesis ID or thread ID
  searchRoute: SearchRoute;
  status: "queued" | "searching" | "completed" | "failed";
  createdAt: number;
  result?: EvidenceResult;
}

export interface EvidenceResult {
  content: string;
  citations: string[];
  source: SourceType;
  addedToKB: boolean;
  kbEntryId?: string;
}

// ── In-memory Evidence Request Queue ─────────────────────────────────────────

const MAX_REQUESTS_PER_CYCLE = 8;

class EvidenceRequestQueue {
  private queue: EvidenceRequest[] = [];
  private processedQueries: Array<{ query: string; processedAt: number }> = [];

  /**
   * Add a request to the queue with deduplication.
   * Uses simple keyword overlap to avoid duplicate searches within 24h.
   */
  add(request: Omit<EvidenceRequest, "id" | "status" | "createdAt">): EvidenceRequest | null {
    // Deduplication: check for similar queries processed in last 24h
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.processedQueries = this.processedQueries.filter(pq => pq.processedAt > twentyFourHoursAgo);

    if (this.isDuplicate(request.query)) {
      console.log(`[EvidenceDispatcher] Skipping duplicate query: "${request.query.slice(0, 60)}..."`);
      return null;
    }

    const entry: EvidenceRequest = {
      ...request,
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "queued",
      createdAt: Date.now(),
    };

    this.queue.push(entry);
    // Sort by priority descending (higher = more urgent)
    this.queue.sort((a, b) => b.priority - a.priority);

    console.log(`[EvidenceDispatcher] Queued: "${request.query.slice(0, 60)}" (priority: ${request.priority}, source: ${request.source})`);
    return entry;
  }

  /**
   * Simple keyword overlap deduplication.
   * Extracts significant words from both queries and checks overlap ratio.
   */
  private isDuplicate(newQuery: string): boolean {
    const newKeywords = this.extractKeywords(newQuery);
    if (newKeywords.length === 0) return false;

    for (const processed of this.processedQueries) {
      const existingKeywords = this.extractKeywords(processed.query);
      if (existingKeywords.length === 0) continue;

      const overlap = newKeywords.filter(kw => existingKeywords.includes(kw)).length;
      const overlapRatio = overlap / Math.min(newKeywords.length, existingKeywords.length);
      if (overlapRatio >= 0.7) return true;
    }

    // Also check queued items
    for (const queued of this.queue) {
      if (queued.status !== "queued") continue;
      const queuedKeywords = this.extractKeywords(queued.query);
      if (queuedKeywords.length === 0) continue;

      const overlap = newKeywords.filter(kw => queuedKeywords.includes(kw)).length;
      const overlapRatio = overlap / Math.min(newKeywords.length, queuedKeywords.length);
      if (overlapRatio >= 0.7) return true;
    }

    return false;
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "in", "on", "at", "to", "for", "of", "and", "or", "but", "with", "by", "from", "this", "that", "it", "be", "has", "have", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "not", "no", "as", "if", "about", "than", "so", "up", "out", "just", "also", "how", "what", "which", "who", "when", "where", "why", "all", "each", "every", "both", "few", "more", "most", "other", "some", "such", "only", "very", "new", "old", "latest", "evidence", "against", "look", "recent", "data", "studies", "announcements", "expert", "analysis"]);
    return text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  /**
   * Get the next batch of queued requests (up to budget cap).
   */
  getNextBatch(limit: number = MAX_REQUESTS_PER_CYCLE): EvidenceRequest[] {
    return this.queue
      .filter(r => r.status === "queued")
      .slice(0, limit);
  }

  markSearching(id: string): void {
    const req = this.queue.find(r => r.id === id);
    if (req) req.status = "searching";
  }

  markCompleted(id: string, result: EvidenceResult): void {
    const req = this.queue.find(r => r.id === id);
    if (req) {
      req.status = "completed";
      req.result = result;
      this.processedQueries.push({ query: req.query, processedAt: Date.now() });
    }
  }

  markFailed(id: string): void {
    const req = this.queue.find(r => r.id === id);
    if (req) req.status = "failed";
  }

  getStats(): { queued: number; searching: number; completed: number; failed: number; total: number } {
    return {
      queued: this.queue.filter(r => r.status === "queued").length,
      searching: this.queue.filter(r => r.status === "searching").length,
      completed: this.queue.filter(r => r.status === "completed").length,
      failed: this.queue.filter(r => r.status === "failed").length,
      total: this.queue.length,
    };
  }

  /**
   * Get all completed results for a specific target (hypothesis/thread).
   */
  getResultsForTarget(targetId: string): EvidenceResult[] {
    return this.queue
      .filter(r => r.targetId === targetId && r.status === "completed" && r.result)
      .map(r => r.result!);
  }
}

// Module-level singleton — resets on deploy (no DB needed)
export const evidenceQueue = new EvidenceRequestQueue();

// ── Source-Aware Search Routing ──────────────────────────────────────────────

/**
 * Maps hypothesis claim keywords to optimal search sources.
 * Simple keyword matching — NOT LLM-powered. Fast and cheap.
 */
export function routeEvidenceSearch(claimText: string): SearchRoute {
  const lower = claimText.toLowerCase();

  // Business/market claims → web + social
  if (/\b(adoption|market|enterprise|revenue|growth|valuation|funding|startup)\b/.test(lower)) {
    return {
      sources: [
        { type: "perplexity_web", priority: 1 },
        { type: "grok_x_search", priority: 2 },
      ],
      maxQueries: 3,
      recencyFilter: "month",
    };
  }

  // Academic/research claims → papers first
  if (/\b(paper|research|algorithm|model|benchmark|arxiv|peer-review|study|dataset)\b/.test(lower)) {
    return {
      sources: [
        { type: "semantic_scholar", priority: 1 },
        { type: "perplexity_web", priority: 2 },
      ],
      maxQueries: 3,
    };
  }

  // News/announcement claims → recent coverage
  if (/\b(announcement|release|launch|update|announced|released|partnership|acquisition)\b/.test(lower)) {
    return {
      sources: [
        { type: "perplexity_news", priority: 1, queryModifier: "latest" },
        { type: "grok_x_search", priority: 2 },
      ],
      maxQueries: 2,
      recencyFilter: "week",
    };
  }

  // Social/community claims → X evidence
  if (/\b(community|discourse|sentiment|twitter|social|discussion|developer|devs|users)\b/.test(lower)) {
    return {
      sources: [
        { type: "grok_x_search", priority: 1 },
        { type: "perplexity_web", priority: 2 },
      ],
      maxQueries: 2,
      recencyFilter: "month",
    };
  }

  // Default fallback → web + academic
  return {
    sources: [
      { type: "perplexity_web", priority: 1 },
      { type: "semantic_scholar", priority: 2 },
    ],
    maxQueries: 2,
  };
}

// ── Grok x_search Wrapper for Evidence Pipeline ─────────────────────────────

/**
 * Wrapper around Grok x_search for the evidence pipeline.
 * Reuses the pattern from grokEngine.ts runGrokSearch() but returns
 * structured EvidenceResult.
 */
export async function searchXPlatform(query: string): Promise<EvidenceResult> {
  const nativeGrokKey = process.env.GROK_API_KEY ?? "";
  if (!nativeGrokKey) {
    console.warn("[EvidenceDispatcher] GROK_API_KEY not set — skipping x_search");
    return { content: "", citations: [], source: "grok_x_search", addedToKB: false };
  }

  try {
    // Sanitize query to avoid 400 errors from special characters or excessive length
    const sanitizedQuery = query
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    const grokResponsesUrl = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";
    const res = await fetch(grokResponsesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nativeGrokKey}` },
      body: JSON.stringify({
        model: getModel("x_search"),
        stream: false,
        input: [{ role: "user", content: sanitizedQuery }],
        tools: [{ type: "x_search" }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.warn(`[EvidenceDispatcher] x_search failed: ${res.status} — query: "${sanitizedQuery.slice(0, 100)}" — body: ${errorBody.slice(0, 200)}`);
      return { content: "", citations: [], source: "grok_x_search", addedToKB: false };
    }

    const data = await res.json() as any;

    // Extract text content from Grok response
    const outputMsg = data.output?.find((o: any) => o.type === "message" || o.content);
    const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text
      ?? data.output?.find((o: any) => o.text)?.text ?? "";

    // Extract URLs from x_search tool results
    const citations: string[] = [];
    for (const output of (data.output ?? [])) {
      if (output.type === "tool_result" || output.type === "x_search") {
        const urls = (JSON.stringify(output).match(/https?:\/\/[^\s"]+/g) ?? []);
        citations.push(...urls.slice(0, 5));
      }
    }

    return {
      content: rawText.slice(0, 3000),
      citations: Array.from(new Set(citations)),
      source: "grok_x_search",
      addedToKB: false,
    };
  } catch (e: any) {
    console.error(`[EvidenceDispatcher] x_search error:`, e.message);
    return { content: "", citations: [], source: "grok_x_search", addedToKB: false };
  }
}

// ── Single Source Search ─────────────────────────────────────────────────────

/**
 * Execute a search against a single source type.
 */
async function executeSearch(query: string, sourceType: SourceType, queryModifier?: string): Promise<EvidenceResult> {
  const fullQuery = queryModifier ? `${queryModifier} ${query}` : query;

  switch (sourceType) {
    case "perplexity_web":
    case "perplexity_news": {
      const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
      if (!pplxKey) {
        console.warn("[EvidenceDispatcher] PERPLEXITY_API_KEY not set — skipping Perplexity search");
        return { content: "", citations: [], source: sourceType, addedToKB: false };
      }
      try {
        const result = await researchWithPerplexity(fullQuery, pplxKey);
        return {
          content: (result?.text ?? "").slice(0, 3000),
          citations: result?.sources ?? [],
          source: sourceType,
          addedToKB: false,
        };
      } catch (e: any) {
        console.error(`[EvidenceDispatcher] Perplexity search failed:`, e.message);
        return { content: "", citations: [], source: sourceType, addedToKB: false };
      }
    }

    case "semantic_scholar": {
      try {
        const result = await researchWithSemanticScholar(fullQuery);
        const papers = result?.papers ?? [];
        const content = papers
          .slice(0, 5)
          .map(p => `"${p.title}" (${p.year}, ${p.citationCount} citations): ${(p.abstract ?? "").slice(0, 200)}`)
          .join("\n");
        const citations = papers.slice(0, 5).map(p => p.url).filter(Boolean);
        return {
          content: content || "",
          citations,
          source: "semantic_scholar",
          addedToKB: false,
        };
      } catch (e: any) {
        console.error(`[EvidenceDispatcher] Semantic Scholar search failed:`, e.message);
        return { content: "", citations: [], source: "semantic_scholar", addedToKB: false };
      }
    }

    case "grok_x_search": {
      return searchXPlatform(fullQuery);
    }

    default:
      return { content: "", citations: [], source: sourceType, addedToKB: false };
  }
}

// ── Process Evidence Queue ───────────────────────────────────────────────────

/**
 * Process queued evidence requests, execute searches, store results in KB.
 * Called 3 times per daily cycle for progressive evidence enrichment.
 *
 * Budget: max 8 requests per call (cost control).
 */
export async function processEvidenceQueue(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  kbEntriesAdded: number;
}> {
  const batch = evidenceQueue.getNextBatch(MAX_REQUESTS_PER_CYCLE);
  if (batch.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, kbEntriesAdded: 0 };
  }

  console.log(`[EvidenceDispatcher] Processing ${batch.length} evidence requests...`);

  let succeeded = 0;
  let failed = 0;
  let kbEntriesAdded = 0;

  for (const request of batch) {
    evidenceQueue.markSearching(request.id);

    try {
      // Execute searches based on the route — primary first, then secondary if budget allows
      const primarySource = request.searchRoute.sources.find(s => s.priority === 1);
      const secondarySource = request.searchRoute.sources.find(s => s.priority === 2);

      let bestResult: EvidenceResult = { content: "", citations: [], source: "perplexity_web", addedToKB: false };

      // Primary search
      if (primarySource) {
        bestResult = await executeSearch(request.query, primarySource.type, primarySource.queryModifier);
      }

      // Secondary search if primary returned thin results
      if (bestResult.content.length < 100 && secondarySource) {
        const secondaryResult = await executeSearch(request.query, secondarySource.type, secondarySource.queryModifier);
        if (secondaryResult.content.length > bestResult.content.length) {
          // Merge — keep both
          bestResult = {
            content: [bestResult.content, secondaryResult.content].filter(Boolean).join("\n\n"),
            citations: [...bestResult.citations, ...secondaryResult.citations],
            source: secondaryResult.source,
            addedToKB: false,
          };
        }
      }

      if (bestResult.content.length > 0) {
        // Store result in KB via addKnowledge()
        try {
          const kbEntryId = `ev_kb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          addKnowledge({
            category: "research",
            title: `Evidence: ${request.query.slice(0, 80)}`,
            summary: bestResult.content.slice(0, 500),
            source: bestResult.citations[0] ?? `evidence-dispatcher:${bestResult.source}`,
            weight: request.priority >= 8 ? 7 : 5,
          });
          bestResult.addedToKB = true;
          bestResult.kbEntryId = kbEntryId;
          kbEntriesAdded++;
          console.log(`[EvidenceDispatcher] Evidence stored in KB for "${request.query.slice(0, 50)}"`);
        } catch (e: any) {
          console.error(`[EvidenceDispatcher] KB storage failed:`, e.message);
        }

        evidenceQueue.markCompleted(request.id, bestResult);
        succeeded++;
      } else {
        evidenceQueue.markFailed(request.id);
        failed++;
        console.warn(`[EvidenceDispatcher] No evidence found for "${request.query.slice(0, 50)}"`);
      }

      // Rate limit: 1s between searches
      await new Promise(r => setTimeout(r, 1000));
    } catch (e: any) {
      console.error(`[EvidenceDispatcher] Request processing failed:`, e.message);
      evidenceQueue.markFailed(request.id);
      failed++;
    }
  }

  const stats = evidenceQueue.getStats();
  console.log(`[EvidenceDispatcher] Batch complete — succeeded: ${succeeded}, failed: ${failed}, KB entries: ${kbEntriesAdded}, queue remaining: ${stats.queued}`);

  return { processed: batch.length, succeeded, failed, kbEntriesAdded };
}
