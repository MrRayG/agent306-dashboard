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

  // Routine (demoted in PR D — P5 batch) — rubric scoring, structured extraction,
  // and short templated outputs. All produce JSON with clear schemas that Gemini
  // flash-lite handles reliably. Previously standard, ~10x cost on calls via getModel().
  "social-preview": "routine",              // Pick best 50-80 word passage from script
  "breakthrough-evaluation": "routine",     // Single novelty score 0-100 + title
  "topic-quality-evaluation": "routine",    // 5 rubric scores 1-10
  "aspiration-evaluation": "routine",       // Progress % + 1-2 sentence self-assessment
  "analysis-so-what": "routine",            // 3-field compression output
  "analysis-assumptions": "routine",        // Structured list of untested assumptions
  "analysis-intake": "routine",             // Phase 1 landscape-mapping extraction
  "signal-collection": "routine",           // Structured signal selection from live data
  "signal-brief": "routine",                // Same family as signal-collection (also matches signal_brief via underscore normalization)
  "parallel-search-subqueries": "routine",  // Generate 3-5 search subqueries from a claim
  "perspective-generation": "routine",      // Alt-perspective generation in knowledge graph
  "episode-reflection": "routine",          // Short post-episode notes
  "ai-roundup": "routine",                  // Roundup packaging (formatting)
  "community-boost": "routine",             // Short supportive reply draft
  "prediction-verification": "routine",     // Rubric-driven prediction check

  // Standard — good reasoning, moderate cost
  "research-phase": "standard",
  "self-debate": "standard",
  "knowledge-gap-scan": "standard",
  "goal-evaluation": "standard",
  "exploration": "standard",
  "news-dispatch": "standard",              // Public-facing market commentary
  "research-brief": "premium",
  "reply-generation": "standard",           // Public-facing voice
  "episode-generation": "standard",         // Public-facing script
  "research-agenda-advance": "standard",
  "parallel-search-reduce": "premium",
  "x_search": "standard",                   // Search-query crafting (quality matters)

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
  "intro-post": "standard",                 // Public-facing (kept at standard)
  "manuscript-generation": "premium",
  "skill-extraction": "premium",
  "daily-briefing": "premium",
  "improvement-plan": "premium",
  "blog-post": "standard",                  // Public-facing long-form

  // Research analysis framework (9-prompt, 4-phase)
  "analysis-contradictions": "premium",    // Phase 2: deep critical thinking
  "analysis-citation-chains": "premium",   // Phase 2: intellectual lineage
  "analysis-gap-scan": "premium",          // Phase 2: gap identification
  "analysis-methodology-audit": "premium", // Phase 2: methodology comparison
  "analysis-synthesis": "premium",         // Phase 3: master synthesis
  "analysis-knowledge-map": "premium",     // Phase 3: knowledge map building
  // (analysis-intake, analysis-so-what, analysis-assumptions demoted to routine above)

  // Agentic Triad tasks
  "triad-fact-synthesis": "standard",       // Agent 3: package research → FactSheet
  "triad-reasoning": "premium",            // Agent 0: analyze evidence → LogicMap
  "triad-grounding-review": "premium",     // Agent 0: review Agent 6 output for grounding violations

  // Self-evolution components
  "aspiration-generation": "premium",      // Forward-looking vision (Claude)
  "self-evolution-reflection": "premium",  // Daily self-reflection loop (Claude)
  // (topic-quality-evaluation, breakthrough-evaluation, aspiration-evaluation demoted to routine above)

  // Intelligence v2 — Dual-persona debate
  "skeptic-debate": "standard",            // Skeptic pass — rigorous critic
  "builder-debate": "standard",            // Builder pass — optimistic builder
  "cross-score": "routine",                // Cross-scoring of both verdicts
  "graph-analysis": "routine",             // Graph gap analysis for aspirations
  // (prediction-verification demoted to routine above)
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
