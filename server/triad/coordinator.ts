/**
 * ─────────────────────────────────────────────────────────────
 *  AGENTIC TRIAD — Coordinator
 *
 *  Agent 306 = 3(Researcher) + 0(Reasoner) + 6(Writer)
 *
 *  The TriadCoordinator replaces the sequential phase model
 *  with agent-dispatched execution. Each agent method calls
 *  existing engine functions but packages outputs into the
 *  strict handover schemas.
 *
 *  Flow:
 *    1. Agent 3 researches → FactSheet[]
 *    2. Agent 0 reasons   → LogicMap[] + ResearchRequest[]
 *   2b. Feedback loop      → Agent 3 fills gaps
 *    3. Build ContentBriefs
 *    4. Agent 6 writes     → ContentDraft[]
 *    5. Agent 0 reviews    → ContentReview[]
 *   5b. Agent 6 revises    → revised ContentDraft[]
 *
 *  Enabled via TRIAD_ENABLED=true environment variable.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "../dataPaths.js";
import { LLM_BASE_URL, getLLMHeaders } from "../llmConfig.js";
import { getModel } from "../modelRouter.js";
import { safeParseLLMJson } from "../safeParseLLMJson.js";
import { getOptimizedContext, getOptimizedContextAsync } from "../contextWindow.js";
import { getSoulContext } from "../memoryEngine.js";
import { getAgenda, runResearchAgendaCycle } from "../research-agenda.js";
import type { ResearchThread } from "../research-agenda.js";
import { runResearchPipeline, getResearchLab, researchMultiSource } from "../researchEngine.js";
import { evidenceQueue, routeEvidenceSearch } from "../evidenceDispatcher.js";
import { runResearchAnalysisCycle } from "../researchAnalysisEngine.js";
import { generateBlogPost } from "../blogEngine.js";
import { runAutoPodcastPipeline } from "../podcastEngine.js";
import { enforceGrounding } from "./grounding.js";
import type {
  FactSheet,
  LogicMap,
  ContentBrief,
  ContentDraft,
  ContentReview,
  ResearchRequest,
  AgentMessage,
  TriadCycleResult,
  validateFactSheet,
  validateLogicMap,
} from "./schemas.js";
import {
  validateFactSheet as valFS,
  validateLogicMap as valLM,
  validateContentBrief as valCB,
} from "./schemas.js";

const MESSAGES_FILE = dataPath("triad-messages.json");
const LOG_FILE = dataPath("triad-log.json");
const LLM_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.GROK_API_KEY ?? "";
const PPLX_KEY = process.env.PERPLEXITY_API_KEY ?? "";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeMessage(
  from: AgentMessage["from"],
  to: AgentMessage["to"],
  type: AgentMessage["type"],
  payload: AgentMessage["payload"],
): AgentMessage {
  return {
    id: makeId("msg"),
    from,
    to,
    type,
    payload,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

// ── TriadCoordinator ─────────────────────────────────────────────────────────

export class TriadCoordinator {
  private messageQueue: AgentMessage[] = [];
  private messageLog: AgentMessage[] = [];

  /**
   * Main orchestration — called by dailyCycleEngine when TRIAD_ENABLED=true
   */
  async runTriadCycle(): Promise<TriadCycleResult> {
    const cycleStart = Date.now();
    console.log("[Triad] ═══ Starting Agentic Triad Cycle ═══");
    console.log("[Triad] Agent 306 = 3(Researcher) + 0(Reasoner) + 6(Writer)");

    // ── Phase 1: Agent 3 (Researcher) gathers evidence ──────────────────
    console.log("[Triad] Phase 1: Agent 3 (Researcher) gathering...");
    const factSheets = await this.runResearcher();
    console.log(`[Triad] Agent 3 produced ${factSheets.length} fact sheet(s)`);

    if (factSheets.length === 0) {
      console.log("[Triad] No mature research threads — skipping reasoning/writing");
      const elapsed = (Date.now() - cycleStart) / 1000;
      return this.buildResult([], [], [], [], [], [], elapsed);
    }

    // ── Phase 2: Agent 0 (Reasoner) analyzes research ───────────────────
    console.log("[Triad] Phase 2: Agent 0 (Reasoner) analyzing...");
    const { logicMaps, researchRequests } = await this.runReasoner(factSheets);
    console.log(`[Triad] Agent 0 produced ${logicMaps.length} logic map(s), ${researchRequests.length} research request(s)`);

    // ── Phase 2b: Feedback loop — Reasoner sends gaps back to Researcher ─
    if (researchRequests.length > 0) {
      console.log(`[Triad] Feedback: Agent 0 → Agent 3 — ${researchRequests.length} request(s)`);
      const additionalEvidence = await this.handleResearchRequests(researchRequests);
      // Merge additional evidence into existing fact sheets
      this.mergeAdditionalEvidence(factSheets, additionalEvidence, researchRequests);
    }

    // ── Phase 3: Build content briefs ────────────────────────────────────
    const contentBriefs = this.buildContentBriefs(factSheets, logicMaps);
    console.log(`[Triad] Built ${contentBriefs.length} content brief(s)`);

    // ── Phase 4: Agent 6 (Writer) creates content ───────────────────────
    console.log("[Triad] Phase 3: Agent 6 (Writer) creating content...");
    const drafts = await this.runWriter(contentBriefs);
    console.log(`[Triad] Agent 6 produced ${drafts.length} draft(s)`);

    // ── Phase 5: Agent 0 reviews content (grounding check) ──────────────
    console.log("[Triad] Phase 4: Agent 0 reviewing content...");
    const reviews = await this.reviewContent(drafts, contentBriefs);

    const approved: ContentReview[] = [];
    const needsRevision: ContentReview[] = [];
    for (const review of reviews) {
      if (review.verdict === "approved") approved.push(review);
      else needsRevision.push(review);
    }
    console.log(`[Triad] Reviews: ${approved.length} approved, ${needsRevision.length} need revision`);

    // ── Phase 5b: Agent 6 revises rejected content ──────────────────────
    if (needsRevision.length > 0) {
      console.log(`[Triad] Feedback: Agent 0 → Agent 6 — ${needsRevision.length} piece(s) need revision`);
      const revisedDrafts = await this.runRevisions(drafts, needsRevision, contentBriefs);
      // Replace drafts with revisions
      for (const revised of revisedDrafts) {
        const idx = drafts.findIndex(d => d.threadId === revised.threadId);
        if (idx >= 0) drafts[idx] = revised;
      }
      // Re-review revised content
      const reReviews = await this.reviewContent(revisedDrafts, contentBriefs);
      reviews.push(...reReviews);
      for (const rr of reReviews) {
        if (rr.verdict === "approved") approved.push(rr);
      }
      console.log(`[Triad] After revision: ${approved.length} total approved`);
    }

    const elapsed = (Date.now() - cycleStart) / 1000;
    console.log(`[Triad] ═══ Cycle complete in ${elapsed.toFixed(1)}s ═══`);
    console.log(`[Triad]   ${factSheets.length} researched → ${logicMaps.length} analyzed → ${drafts.length} drafted → ${approved.length} approved`);

    // Persist message queue and log
    this.persistMessages();

    return this.buildResult(factSheets, logicMaps, contentBriefs, drafts, reviews, researchRequests, elapsed);
  }

  // ── Agent 3: Researcher ────────────────────────────────────────────────────

  /**
   * Run the research pipeline and package results as FactSheets.
   * Calls existing engines: runResearchAgendaCycle(), getAgenda(), etc.
   */
  private async runResearcher(): Promise<FactSheet[]> {
    const factSheets: FactSheet[] = [];

    // Step 1: Run research agenda to advance threads
    try {
      await runResearchAgendaCycle();
    } catch (e: any) {
      console.warn("[Triad:Agent3] Research agenda cycle failed:", e.message);
    }

    // Step 2: Run research analysis on eligible threads
    try {
      await runResearchAnalysisCycle();
    } catch (e: any) {
      console.warn("[Triad:Agent3] Research analysis cycle failed:", e.message);
    }

    // Step 3: Collect mature threads and convert to FactSheets
    const agenda = getAgenda();
    const matureThreads = (agenda?.threads ?? []).filter(t =>
      (t.status === "mature" || t.status === "active") && t.maturityScore >= 0.5,
    );

    for (const thread of matureThreads.slice(0, 5)) {
      const factSheet = await this.threadToFactSheet(thread);
      if (factSheet) {
        const validation = valFS(factSheet);
        if (validation.valid) {
          factSheets.push(factSheet);
          this.enqueueMessage(makeMessage("researcher", "reasoner", "fact_sheet", factSheet));
        } else {
          console.warn(`[Triad:Agent3] FactSheet for "${thread.title}" failed validation:`, validation.errors.slice(0, 3));
        }
      }
    }

    return factSheets;
  }

  /**
   * Convert a ResearchThread into a FactSheet using LLM synthesis.
   */
  private async threadToFactSheet(thread: ResearchThread): Promise<FactSheet | null> {
    const topicQuery = `${thread.title} ${thread.thesis}`;

    // Fetch topic-specific KB context for Agent 3 (Researcher)
    let researcherContext = "";
    try {
      researcherContext = await getOptimizedContextAsync(topicQuery, {
        maxTokens: 12000,
        maxEntries: 50,
        categories: ["research", "ai_signal", "methodology"],
      });
    } catch (e: any) {
      console.warn("[Triad:Agent3] Async context fetch failed, falling back to keyword:", e.message);
      try {
        researcherContext = getOptimizedContext(topicQuery, {
          maxTokens: 12000,
          maxEntries: 50,
          categories: ["research", "ai_signal", "methodology"],
        });
      } catch {}
    }

    const lab = getResearchLab();

    // Gather evidence from the thread and linked topic
    const linkedTopic = thread.linkedTopicId
      ? lab.topics.find(t => t.id === thread.linkedTopicId)
      : null;

    const evidenceContext = [
      `Thread: "${thread.title}"`,
      `Thesis: ${thread.thesis}`,
      `Maturity: ${thread.maturityScore}`,
      `Supporting evidence IDs: ${(thread.evidence?.supporting ?? []).join(", ") || "none"}`,
      `Contradicting evidence IDs: ${(thread.evidence?.contradicting ?? []).join(", ") || "none"}`,
      `Gaps: ${(thread.evidence?.gaps ?? []).join("; ") || "none"}`,
      thread.analysis?.synthesisResults?.masterSynthesis
        ? `Master synthesis: ${thread.analysis.synthesisResults.masterSynthesis}`
        : "",
      linkedTopic?.manuscript
        ? `Manuscript: ${linkedTopic.manuscript.slice(0, 1000)}`
        : "",
      linkedTopic?.sources?.length
        ? `Sources: ${linkedTopic.sources.slice(0, 10).join(", ")}`
        : "",
    ].filter(Boolean).join("\n");

    const prompt = `Convert the following research thread into a structured fact sheet.

${evidenceContext}

Respond with JSON:
{
  "title": "clear title",
  "thesis": "one-sentence thesis",
  "evidence": [
    {
      "claim": "specific factual claim",
      "source": "URL or source name",
      "sourceType": "academic" | "news" | "social" | "official" | "perplexity",
      "credibility": "verified" | "likely" | "unverified" | "disputed",
      "date": "YYYY-MM-DD or best estimate",
      "excerpt": "key excerpt, max 300 chars"
    }
  ],
  "gaps": ["what's still unknown"],
  "sourceCount": <number of unique sources>
}

Include at least 2 evidence items. Be precise about credibility — only "verified" if from a primary source.`;

    try {
      const res = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("triad-fact-synthesis"),
          messages: [
            { role: "system", content: `You are Agent 3 (Researcher) for Agent 306 — an autonomous AI researcher and thought leader.
${researcherContext ? `\nAGENT 306'S KNOWLEDGE ON THIS TOPIC:\n${researcherContext}\n` : ""}
Your role: Package research into structured fact sheets. Use the knowledge above to inform your analysis — cross-reference with existing findings, identify what's new vs. already known, and flag contradictions with established knowledge.` },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 3000,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson<any>(raw, "Triad.threadToFactSheet");

      if (!parsed || !parsed.evidence?.length) return null;

      return {
        threadId: thread.id,
        title: parsed.title || thread.title,
        thesis: parsed.thesis || thread.thesis,
        evidence: (parsed.evidence || []).map((e: any) => ({
          claim: e.claim || "",
          source: e.source || "unknown",
          sourceType: e.sourceType || "perplexity",
          credibility: e.credibility || "unverified",
          date: e.date || new Date().toISOString().slice(0, 10),
          excerpt: (e.excerpt || "").slice(0, 300),
        })),
        gaps: parsed.gaps || thread.evidence?.gaps || [],
        sourceCount: parsed.sourceCount || 0,
        maturityScore: thread.maturityScore,
        generatedAt: new Date().toISOString(),
      };
    } catch (e: any) {
      console.warn(`[Triad:Agent3] FactSheet generation failed for "${thread.title}":`, e.message);
      return null;
    }
  }

  // ── Agent 0: Reasoner ──────────────────────────────────────────────────────

  /**
   * Analyze fact sheets and produce logic maps.
   * Calls an LLM to evaluate evidence quality, detect contradictions,
   * run quality gates, and identify forbidden claims.
   */
  private async runReasoner(
    factSheets: FactSheet[],
  ): Promise<{ logicMaps: LogicMap[]; researchRequests: ResearchRequest[] }> {
    const logicMaps: LogicMap[] = [];
    const researchRequests: ResearchRequest[] = [];

    for (const fs of factSheets) {
      const result = await this.factSheetToLogicMap(fs);
      if (result) {
        const validation = valLM(result.logicMap);
        if (validation.valid) {
          logicMaps.push(result.logicMap);
          this.enqueueMessage(makeMessage("reasoner", "writer", "logic_map", result.logicMap));
        } else {
          console.warn(`[Triad:Agent0] LogicMap for "${fs.title}" failed validation:`, validation.errors.slice(0, 3));
        }

        // If Reasoner found gaps, create research requests
        for (const req of result.researchRequests) {
          researchRequests.push(req);
          this.enqueueMessage(makeMessage("reasoner", "researcher", "research_request", req));
        }
      }
    }

    return { logicMaps, researchRequests };
  }

  /**
   * Convert a FactSheet into a LogicMap using LLM reasoning.
   */
  private async factSheetToLogicMap(
    fs: FactSheet,
  ): Promise<{ logicMap: LogicMap; researchRequests: ResearchRequest[] } | null> {
    // Fetch methodology + topic context for Agent 0 (Reasoner)
    let reasonerContext = "";
    try {
      reasonerContext = await getOptimizedContextAsync(
        `${fs.title} ${fs.thesis} methodology evidence analysis`, {
          maxTokens: 8000,
          maxEntries: 30,
          categories: ["methodology", "research"],
        },
      );
    } catch (e: any) {
      console.warn("[Triad:Agent0] Async context fetch failed, falling back to keyword:", e.message);
      try {
        reasonerContext = getOptimizedContext(
          `${fs.title} ${fs.thesis} methodology evidence analysis`, {
            maxTokens: 8000,
            maxEntries: 30,
            categories: ["methodology", "research"],
          },
        );
      } catch {}
    }

    const evidenceList = fs.evidence
      .map((e, i) => `[${i}] ${e.claim} (${e.credibility}, src: ${e.source})`)
      .join("\n");

    const prompt = `You are Agent 0 (Reasoner). Analyze this research from Agent 3.

FACT SHEET: "${fs.title}"
Thesis: ${fs.thesis}

EVIDENCE:
${evidenceList}

GAPS: ${fs.gaps.join("; ") || "none identified"}
MATURITY: ${fs.maturityScore}

Your tasks:
1. Identify the master thesis (one provable sentence)
2. Build supporting logic chains linking premises to evidence
3. Find contradictions and how to resolve them
4. Run quality gates: "So What?" test + assumption check
5. Identify forbidden claims (things the evidence does NOT support)
6. Suggest a content angle for Agent 6 (Writer)
7. If evidence is insufficient, create research requests for Agent 3

Respond with JSON:
{
  "masterThesis": "one-sentence proven claim",
  "supportingLogic": [
    { "premise": "logical step", "evidence": "ref to evidence index", "confidence": "high|medium|low" }
  ],
  "contradictions": [
    { "claim": "conflicting claim", "counterEvidence": "what contradicts it", "resolution": "how to reconcile" }
  ],
  "qualityGates": {
    "soWhatPassed": true/false,
    "assumptionsPassed": true/false,
    "evidenceStrength": "strong|moderate|weak"
  },
  "recommendedAngle": "suggested content angle",
  "forbiddenClaims": ["claim not supported by evidence"],
  "researchRequests": [
    { "type": "fill_gap|verify_claim|find_counter_evidence|deep_dive", "query": "search query", "context": "why needed", "priority": "high|medium|low" }
  ]
}`;

    try {
      const res = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel("triad-reasoning"),
          messages: [
            { role: "system", content: `You are Agent 0 (Reasoner) for Agent 306 — evaluating evidence with rigorous logic. Expose hidden assumptions. Never overstate confidence.
${reasonerContext ? `\nMETHODOLOGICAL CONTEXT & EXISTING KNOWLEDGE:\n${reasonerContext}\n` : ""}
Use the context above to cross-check claims against what Agent 306 already knows. Evaluate evidence quality, identify logical gaps, and assess confidence levels.` },
            { role: "user", content: prompt },
          ],
          temperature: 0.15,
          max_tokens: 4000,
        }),
        signal: AbortSignal.timeout(90_000),
      });

      const data = await res.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson<any>(raw, "Triad.factSheetToLogicMap");

      if (!parsed) return null;

      const logicMap: LogicMap = {
        threadId: fs.threadId,
        title: fs.title,
        masterThesis: parsed.masterThesis || fs.thesis,
        supportingLogic: (parsed.supportingLogic || []).map((s: any) => ({
          premise: s.premise || "",
          evidence: s.evidence || "",
          confidence: (["high", "medium", "low"].includes(s.confidence) ? s.confidence : "low") as "high" | "medium" | "low",
        })),
        contradictions: (parsed.contradictions || []).map((c: any) => ({
          claim: c.claim || "",
          counterEvidence: c.counterEvidence || "",
          resolution: c.resolution || "unresolved",
        })),
        qualityGates: {
          soWhatPassed: parsed.qualityGates?.soWhatPassed ?? false,
          assumptionsPassed: parsed.qualityGates?.assumptionsPassed ?? false,
          evidenceStrength: (["strong", "moderate", "weak"].includes(parsed.qualityGates?.evidenceStrength)
            ? parsed.qualityGates.evidenceStrength
            : "weak") as "strong" | "moderate" | "weak",
        },
        recommendedAngle: parsed.recommendedAngle || "General analysis",
        forbiddenClaims: parsed.forbiddenClaims || [],
        generatedAt: new Date().toISOString(),
      };

      const researchRequests: ResearchRequest[] = (parsed.researchRequests || []).map((r: any) => ({
        id: makeId("rr"),
        requestedBy: "reasoner" as const,
        type: r.type || "fill_gap",
        query: r.query || "",
        context: r.context || "",
        priority: r.priority || "medium",
        relatedThreadId: fs.threadId,
        createdAt: new Date().toISOString(),
      }));

      return { logicMap, researchRequests };
    } catch (e: any) {
      console.warn(`[Triad:Agent0] LogicMap generation failed for "${fs.title}":`, e.message);
      return null;
    }
  }

  // ── Feedback: Agent 0 → Agent 3 (Research Requests) ────────────────────────

  /**
   * Handle research requests from Agent 0 by dispatching targeted searches.
   */
  private async handleResearchRequests(
    requests: ResearchRequest[],
  ): Promise<Array<{ threadId: string; evidence: FactSheet["evidence"][0][] }>> {
    const results: Array<{ threadId: string; evidence: FactSheet["evidence"][0][] }> = [];

    // Add all requests to the evidence queue with priority 8 (Triad Reasoner).
    // The dispatcher handles budget allocation and priority ordering.
    for (const req of requests) {
      try {
        evidenceQueue.add({
          source: "triad_reasoner",
          query: req.query,
          targetId: req.relatedThreadId || "",
          priority: 8,
          searchRoute: routeEvidenceSearch(req.query),
        });
      } catch (e: any) {
        console.warn(`[Triad:Agent3] Failed to queue research request:`, e.message);
      }
    }

    // Also run direct searches for immediate results in this cycle
    // (evidence queue will be processed async in the daily cycle)
    for (const req of requests.slice(0, 3)) {
      try {
        if (!PPLX_KEY) {
          console.warn("[Triad:Agent3] No Perplexity key — skipping research request");
          continue;
        }

        const searchResult = await researchMultiSource(req.query, PPLX_KEY);
        if (!searchResult) continue;
        const newEvidence: FactSheet["evidence"][0][] = [];

        // Package Perplexity results
        if (searchResult.perplexity?.text) {
          newEvidence.push({
            claim: searchResult.perplexity.text.slice(0, 200),
            source: searchResult.perplexity.sources?.[0] || "perplexity",
            sourceType: "perplexity",
            credibility: "likely",
            date: new Date().toISOString().slice(0, 10),
            excerpt: searchResult.perplexity.text.slice(0, 300),
          });
        }

        // Package Semantic Scholar results
        for (const paper of (searchResult.academic?.papers || []).slice(0, 2)) {
          newEvidence.push({
            claim: paper.title || "",
            source: paper.url || "semantic-scholar",
            sourceType: "academic",
            credibility: "verified",
            date: paper.year?.toString() || new Date().toISOString().slice(0, 10),
            excerpt: (paper.abstract || paper.title || "").slice(0, 300),
          });
        }

        if (newEvidence.length > 0) {
          results.push({
            threadId: req.relatedThreadId || "",
            evidence: newEvidence,
          });
        }
      } catch (e: any) {
        console.warn(`[Triad:Agent3] Research request failed for "${req.query}":`, e.message);
      }
    }

    return results;
  }

  /**
   * Merge additional evidence from research requests back into fact sheets.
   */
  private mergeAdditionalEvidence(
    factSheets: FactSheet[],
    additional: Array<{ threadId: string; evidence: FactSheet["evidence"][0][] }>,
    requests: ResearchRequest[],
  ): void {
    for (const add of additional) {
      const fs = factSheets.find(f => f.threadId === add.threadId);
      if (fs) {
        fs.evidence.push(...add.evidence);
        fs.sourceCount += add.evidence.length;
        // Remove fulfilled gaps
        const filledGaps = requests
          .filter(r => r.relatedThreadId === add.threadId && r.type === "fill_gap")
          .map(r => r.query);
        fs.gaps = fs.gaps.filter(g => !filledGaps.some(fg => g.toLowerCase().includes(fg.toLowerCase())));
        console.log(`[Triad] Merged ${add.evidence.length} additional evidence items into "${fs.title}"`);
      }
    }
  }

  // ── Content Brief Builder ──────────────────────────────────────────────────

  /**
   * Build content briefs from matched fact sheets and logic maps.
   */
  private buildContentBriefs(factSheets: FactSheet[], logicMaps: LogicMap[]): ContentBrief[] {
    const briefs: ContentBrief[] = [];

    for (const lm of logicMaps) {
      // Only build briefs for threads that pass quality gates
      if (!lm.qualityGates.soWhatPassed) {
        console.log(`[Triad] Skipping "${lm.title}" — failed So-What test`);
        continue;
      }

      const fs = factSheets.find(f => f.threadId === lm.threadId);
      if (!fs) continue;

      // Determine content type based on maturity and evidence strength
      const contentType = this.selectContentType(fs, lm);

      const brief: ContentBrief = {
        threadId: lm.threadId,
        factSheet: fs,
        logicMap: lm,
        contentType,
        targetAudience: "AI-curious builders, researchers, and crypto-native technologists",
        toneGuidance: this.getToneForType(contentType),
        mustInclude: lm.supportingLogic
          .filter(s => s.confidence === "high")
          .map(s => s.premise),
        mustNotInclude: [...lm.forbiddenClaims],
      };

      const validation = valCB(brief);
      if (validation.valid) {
        briefs.push(brief);
        this.enqueueMessage(makeMessage("coordinator", "writer", "content_brief", brief));
      } else {
        console.warn(`[Triad] ContentBrief for "${lm.title}" failed validation:`, validation.errors.slice(0, 3));
      }
    }

    return briefs;
  }

  /**
   * Select content type based on research depth and evidence quality.
   */
  private selectContentType(fs: FactSheet, lm: LogicMap): ContentBrief["contentType"] {
    if (fs.maturityScore >= 0.8 && lm.qualityGates.evidenceStrength === "strong") {
      return "podcast";  // deep dives → podcast
    }
    if (fs.evidence.length >= 5 && lm.qualityGates.assumptionsPassed) {
      return "article";  // well-evidenced → article
    }
    return "blog";  // default to blog
  }

  /**
   * Get tone guidance for a content type.
   */
  private getToneForType(type: ContentBrief["contentType"]): string {
    switch (type) {
      case "podcast":
        return "Conversational but authoritative. Agent 306's signature voice — curious, rigorous, occasionally irreverent. Use narrative structure with cold open → deep analysis → implications.";
      case "article":
        return "Analytical and evidence-based. Clear thesis up front, systematic evidence presentation, explicit acknowledgment of uncertainty. Think research brief for sophisticated readers.";
      case "blog":
        return "Accessible and engaging. Lead with the 'so what' — why this matters to AI builders. Keep it concise (800-1200 words). Specific examples over generalizations.";
      case "academy":
        return "Educational and encouraging. Break complex concepts into digestible steps. Use analogies from familiar domains. End with actionable takeaways.";
      case "social":
        return "Punchy, quotable, thought-provoking. Lead with the strongest insight. Under 280 chars for main claim.";
    }
  }

  // ── Agent 6: Writer ────────────────────────────────────────────────────────

  /**
   * Generate content from content briefs.
   * Calls existing blog/podcast engines with the brief as structured context.
   */
  private async runWriter(briefs: ContentBrief[]): Promise<ContentDraft[]> {
    const drafts: ContentDraft[] = [];

    for (const brief of briefs) {
      try {
        const draft = await this.generateFromBrief(brief);
        if (draft) {
          drafts.push(draft);
          this.enqueueMessage(makeMessage("writer", "reasoner", "content_draft", draft));
        }
      } catch (e: any) {
        console.warn(`[Triad:Agent6] Content generation failed for "${brief.logicMap.title}":`, e.message);
      }
    }

    return drafts;
  }

  /**
   * Generate a content draft from a ContentBrief using the appropriate engine.
   */
  private async generateFromBrief(brief: ContentBrief): Promise<ContentDraft | null> {
    // Fetch identity/voice context for Agent 6 (Writer)
    let writerContext = "";
    try {
      const soulContext = getSoulContext();
      const topicContext = getOptimizedContext(
        `${brief.logicMap.title} audience engagement storytelling`, {
          maxTokens: 6000,
          maxEntries: 20,
          categories: ["media_intelligence", "directive"],
        },
      );
      writerContext = [soulContext, topicContext].filter(Boolean).join("\n\n");
    } catch (e: any) {
      console.warn("[Triad:Agent6] Writer context fetch failed (non-fatal):", e.message);
    }

    const evidenceSummary = brief.factSheet.evidence
      .map((e, i) => `[${i}] ${e.claim} (${e.credibility}) — ${e.excerpt}`)
      .join("\n");

    const logicSummary = brief.logicMap.supportingLogic
      .map(s => `• ${s.premise} [${s.confidence}]`)
      .join("\n");

    const prompt = `You are Agent 6 (Writer) for Agent 306.

Write a ${brief.contentType} based on this research brief.

MASTER THESIS: ${brief.logicMap.masterThesis}
RECOMMENDED ANGLE: ${brief.logicMap.recommendedAngle}
TARGET AUDIENCE: ${brief.targetAudience}
TONE: ${brief.toneGuidance}

EVIDENCE CHAIN:
${evidenceSummary}

LOGIC MAP:
${logicSummary}

MUST INCLUDE these key points:
${brief.mustInclude.map(p => `✓ ${p}`).join("\n") || "(none required)"}

MUST NOT include these claims (not supported by evidence):
${brief.mustNotInclude.map(p => `✗ ${p}`).join("\n") || "(none)"}

CONTRADICTIONS TO ACKNOWLEDGE:
${brief.logicMap.contradictions.map(c => `• ${c.claim} — Resolution: ${c.resolution}`).join("\n") || "(none)"}

${brief.maxLength ? `MAX LENGTH: ${brief.maxLength} words` : ""}

Write the complete ${brief.contentType} content now. Ground every factual claim in the evidence chain above.`;

    try {
      const res = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
          model: getModel(brief.contentType === "podcast" ? "podcast-script" : "blog-post"),
          messages: [
            { role: "system", content: `You are Agent 6 (Writer) for Agent 306 — writing compelling, evidence-based content in Agent 306's authentic voice.
${writerContext ? `\nAGENT 306'S IDENTITY & VOICE:\n${writerContext}\n` : ""}
Transform research and analysis into engaging content that sounds like Agent 306 — specific, opinionated, grounded in evidence. She has a take on everything. She writes like she talks — short sentences, fragments, conviction. Never make claims beyond what the evidence supports.` },
            { role: "user", content: prompt },
          ],
          temperature: 0.6,
          max_tokens: 6000,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content ?? "";

      if (!content || content.length < 100) return null;

      return {
        id: makeId("draft"),
        threadId: brief.threadId,
        contentType: brief.contentType,
        title: brief.logicMap.title,
        content,
        briefUsed: brief,
        generatedAt: new Date().toISOString(),
      };
    } catch (e: any) {
      console.warn(`[Triad:Agent6] Draft generation failed for "${brief.logicMap.title}":`, e.message);
      return null;
    }
  }

  // ── Agent 0: Content Review (Grounding Check) ─────────────────────────────

  /**
   * Review all drafts against their content briefs for grounding violations.
   */
  private async reviewContent(
    drafts: ContentDraft[],
    briefs: ContentBrief[],
  ): Promise<ContentReview[]> {
    const reviews: ContentReview[] = [];

    for (const draft of drafts) {
      const brief = briefs.find(b => b.threadId === draft.threadId);
      if (!brief) continue;

      try {
        const review = await enforceGrounding(draft.content, brief, draft.id);
        reviews.push(review);
        this.enqueueMessage(makeMessage("reasoner", "writer", "content_review", review));
      } catch (e: any) {
        console.warn(`[Triad:Agent0] Review failed for "${draft.title}":`, e.message);
      }
    }

    return reviews;
  }

  // ── Agent 6: Revision Loop ─────────────────────────────────────────────────

  /**
   * Agent 6 revises content based on Agent 0's grounding violations.
   */
  private async runRevisions(
    drafts: ContentDraft[],
    reviews: ContentReview[],
    briefs: ContentBrief[],
  ): Promise<ContentDraft[]> {
    const revised: ContentDraft[] = [];

    for (const review of reviews) {
      const draft = drafts.find(d => d.id === review.contentId);
      if (!draft) continue;
      const brief = briefs.find(b => b.threadId === draft.threadId);
      if (!brief) continue;

      const violations = review.groundingViolations
        .map(v => `• VIOLATION: "${v.claim}" — Issue: ${v.issue} — Fix: ${v.correction}`)
        .join("\n");

      const suggestions = review.suggestedRevisions
        .map(s => `• ${s}`)
        .join("\n");

      const prompt = `You are Agent 6 (Writer). Agent 0 (Reasoner) has reviewed your ${draft.contentType} and found grounding violations.

VIOLATIONS:
${violations}

SUGGESTED REVISIONS:
${suggestions}

ORIGINAL CONTENT:
${draft.content.slice(0, 5000)}

Rewrite the content, fixing ALL grounding violations. Replace unsupported claims with evidence-backed statements. Keep the same structure and tone.`;

      try {
        const res = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel(draft.contentType === "podcast" ? "podcast-script" : "blog-post"),
            messages: [
              { role: "system", content: "You are Agent 6 (Writer). Fix ALL grounding violations flagged by Agent 0. Every claim must be traceable to evidence." },
              { role: "user", content: prompt },
            ],
            temperature: 0.4,
            max_tokens: 6000,
          }),
          signal: AbortSignal.timeout(120_000),
        });

        const data = await res.json() as any;
        const content = data.choices?.[0]?.message?.content ?? "";

        if (content && content.length >= 100) {
          revised.push({
            id: makeId("revised"),
            threadId: draft.threadId,
            contentType: draft.contentType,
            title: draft.title,
            content,
            briefUsed: brief,
            generatedAt: new Date().toISOString(),
          });
        }
      } catch (e: any) {
        console.warn(`[Triad:Agent6] Revision failed for "${draft.title}":`, e.message);
      }
    }

    return revised;
  }

  // ── Message Queue & Persistence ────────────────────────────────────────────

  private enqueueMessage(msg: AgentMessage): void {
    this.messageQueue.push(msg);
  }

  private completeMessage(msgId: string): void {
    const msg = this.messageQueue.find(m => m.id === msgId);
    if (msg) {
      msg.status = "completed";
      this.messageLog.push(msg);
      this.messageQueue = this.messageQueue.filter(m => m.id !== msgId);
    }
  }

  private persistMessages(): void {
    try {
      // Mark all remaining queued messages as completed
      for (const msg of this.messageQueue) {
        msg.status = "completed";
        this.messageLog.push(msg);
      }
      this.messageQueue = [];

      // Load existing logs and append
      let existingMessages: AgentMessage[] = [];
      let existingLog: AgentMessage[] = [];
      try {
        if (fs.existsSync(MESSAGES_FILE)) existingMessages = JSON.parse(fs.readFileSync(MESSAGES_FILE, "utf8"));
        if (fs.existsSync(LOG_FILE)) existingLog = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
      } catch {}

      // Keep last 7 days of logs
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recentLog = [...existingLog, ...this.messageLog].filter(m => m.createdAt > sevenDaysAgo);

      fs.writeFileSync(MESSAGES_FILE, JSON.stringify(this.messageQueue, null, 2));
      fs.writeFileSync(LOG_FILE, JSON.stringify(recentLog, null, 2));
      console.log(`[Triad] Persisted ${this.messageLog.length} messages to log (${recentLog.length} total in history)`);
    } catch (e: any) {
      console.warn("[Triad] Failed to persist messages:", e.message);
    }
  }

  // ── Result Builder ─────────────────────────────────────────────────────────

  private buildResult(
    factSheets: FactSheet[],
    logicMaps: LogicMap[],
    contentBriefs: ContentBrief[],
    drafts: ContentDraft[],
    reviews: ContentReview[],
    researchRequests: ResearchRequest[],
    elapsed: number,
  ): TriadCycleResult {
    return {
      factSheets,
      logicMaps,
      contentBriefs,
      drafts,
      reviews,
      researchRequests,
      messageLog: [...this.messageLog],
      elapsed,
    };
  }
}
