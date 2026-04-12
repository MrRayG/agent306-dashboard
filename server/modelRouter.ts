/**
 * Smart Model Router for Agent 306.
 * 
 * Routes tasks to appropriate models via OpenRouter:
 *   routine     → google/gemini-2.5-flash          (cheapest, fast)
 *   standard    → x-ai/grok-4.20                  (current default via OpenRouter)
 *   premium     → anthropic/claude-sonnet-4.6      (highest quality for scripts/synthesis)
 *   multi-agent → x-ai/grok-4.20-multi-agent      (4-agent collaborative debate)
 * 
 * OpenRouter model names use provider/model format.
 * If a model is unavailable, OpenRouter returns an error — 
 * callers should handle gracefully.
 */

export type TaskComplexity = "routine" | "standard" | "premium" | "multi-agent";

const MODEL_MAP: Record<TaskComplexity, string> = {
  routine:       process.env.MODEL_ROUTINE     ?? "google/gemini-2.5-flash-lite",
  standard:      process.env.MODEL_STANDARD    ?? "x-ai/grok-4.20",
  premium:       process.env.MODEL_PREMIUM     ?? "anthropic/claude-sonnet-4.6",
  "multi-agent": process.env.MODEL_MULTI_AGENT ?? "x-ai/grok-4.20-multi-agent",
};

const TASK_COMPLEXITY: Record<string, TaskComplexity> = {
  // Routine — cheap/fast, no deep reasoning needed
  "reflection": "routine",
  "confidence-decay": "routine",
  "contradiction-scan": "routine",
  "connection-scan": "routine",
  "conversation-insights": "routine",
  "hypothesis-resolution": "premium",         // Claude Sonnet 4.6 — multi-agent model uses Responses API (incompatible with Chat Completions JSON output)
  "knowledge-categorization": "routine",
  "tier-assignment": "routine",
  "injection-scan": "routine",
  "cluster-scan": "routine",
  "dream-update": "routine",
  "growth-snapshot": "routine",

  // Standard — good reasoning, moderate cost
  "research-phase": "standard",
  "self-debate": "standard",
  "knowledge-gap-scan": "standard",
  "goal-evaluation": "standard",
  "exploration": "standard",
  "signal-collection": "standard",
  "news-dispatch": "standard",
  "research-brief": "premium",
  "ai-roundup": "standard",
  "signal_brief": "standard",
  "reply-generation": "standard",
  "community-boost": "standard",
  "episode-generation": "standard",
  "research-agenda-advance": "standard",
  "parallel-search-subqueries": "standard",
  "parallel-search-reduce": "premium",
  "episode-reflection": "standard",
  "social-preview": "standard",
  "x_search": "standard",

  "perspective-generation": "standard",

  // Reasoning pipeline — diverse models for hypothesis evaluation
  "hypothesis-evaluation": "premium",        // Claude Sonnet 4.6 — primary reasoning
  "adversarial-evaluation": "standard",      // Grok 4.20 — different model for diversity
  "hypothesis-decomposition": "routine",     // Gemini Flash — fast decomposition
  "trust-scoring": "routine",                // Gemini Flash — formulaic calculation
  "evidence-triage": "routine",              // Gemini Flash — lightweight evidence availability check
  "evidence-search-query-gen": "routine",    // Gemini Flash — generate search queries from claims

  // Premium — highest quality for public-facing content
  "deep-reasoning": "premium",
  "research-agenda-generate": "premium",
  "podcast-script": "premium",
  "podcast-from-thread": "premium",
  "synthesis-report": "premium",
  "article-draft": "premium",
  "article_draft": "premium",
  "manuscript-generation": "premium",
  "skill-extraction": "premium",
  "daily-briefing": "premium",
  "improvement-plan": "premium",
  "blog-post": "standard",

  // Research analysis framework (9-prompt, 4-phase)
  "analysis-intake": "standard",           // Phase 1: landscape mapping
  "analysis-contradictions": "premium",    // Phase 2: deep critical thinking
  "analysis-citation-chains": "premium",   // Phase 2: intellectual lineage
  "analysis-gap-scan": "premium",          // Phase 2: gap identification
  "analysis-methodology-audit": "premium", // Phase 2: methodology comparison
  "analysis-synthesis": "premium",         // Phase 3: master synthesis
  "analysis-knowledge-map": "premium",     // Phase 3: knowledge map building
  "analysis-so-what": "standard",          // Phase 4: quality check
  "analysis-assumptions": "standard",      // Phase 4: assumption killer

  // Agentic Triad tasks
  "triad-fact-synthesis": "standard",       // Agent 3: package research → FactSheet
  "triad-reasoning": "premium",            // Agent 0: analyze evidence → LogicMap
  "triad-grounding-review": "premium",     // Agent 0: review Agent 6 output for grounding violations

  // Self-evolution components
  "topic-quality-evaluation": "standard",  // Auto-approval quality gate
  "breakthrough-evaluation": "standard",   // Breakthrough detection scoring
  "aspiration-generation": "premium",      // Forward-looking vision (Claude)
  "aspiration-evaluation": "standard",     // Weekly progress check
  "self-evolution-reflection": "premium",  // Daily self-reflection loop (Claude)

  // Intelligence v2 — Dual-persona debate
  "skeptic-debate": "standard",            // Skeptic pass — rigorous critic
  "builder-debate": "standard",            // Builder pass — optimistic builder
  "cross-score": "routine",               // Cross-scoring of both verdicts
  "graph-analysis": "routine",            // Graph gap analysis for aspirations
  "prediction-verification": "standard",   // Prediction check via Perplexity
};

/**
 * Get the appropriate model for a task.
 * Normalizes underscores to hyphens so both "hypothesis_resolution" and
 * "hypothesis-resolution" resolve to the same routing entry.
 * @param task - Task identifier (e.g., "podcast-script", "reflection")
 * @returns OpenRouter model string (e.g., "anthropic/claude-sonnet-4.6")
 */
export function getModel(task: string): string {
  const normalized = task.replace(/_/g, "-");
  const complexity = TASK_COMPLEXITY[normalized] ?? "standard";
  return MODEL_MAP[complexity];
}

/**
 * Get all model mappings (for the /api/model-router status endpoint).
 */
export function getModelConfig(): { models: Record<string, string>; tasks: Record<string, string> } {
  return {
    models: { ...MODEL_MAP },
    tasks: Object.fromEntries(
      Object.entries(TASK_COMPLEXITY).map(([task, complexity]) => [task, MODEL_MAP[complexity]])
    ),
  };
}
