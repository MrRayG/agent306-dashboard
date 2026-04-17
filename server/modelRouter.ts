/**
 * Smart Model Router for Agent 306.
 *
 * Routes tasks to appropriate models via OpenRouter:
 *   routine     → google/gemini-3-flash-preview    (thinking model at routine prices, PR E)
 *   standard    → x-ai/grok-4.20                   (Class 1 grounded synthesis; xAI Responses API eligible)
 *   premium     → anthropic/claude-sonnet-4.6      (long-form public-facing content)
 *   frontier    → anthropic/claude-opus-4.6        (Class 2 reasoning — ASI-sensitive identity tasks, PR E)
 *   multi-agent → x-ai/grok-4.20-multi-agent       (4-agent collaborative debate)
 *
 * The "frontier" tier exists specifically for tasks where hallucinated output
 * would compound into Agent 306's identity or hypothesis base over time.
 * Claude Opus 4.6 was selected because it has the strongest hallucination-refusal
 * profile (0-14% on AA-Omniscience) among frontier models as of April 2026.
 *
 * OpenRouter model names use provider/model format.
 * If a model is unavailable, OpenRouter returns an error —
 * callers should handle gracefully.
 */

export type TaskComplexity = "routine" | "standard" | "premium" | "frontier" | "multi-agent";

const MODEL_MAP: Record<TaskComplexity, string> = {
  routine:       process.env.MODEL_ROUTINE     ?? "google/gemini-3-flash-preview",
  standard:      process.env.MODEL_STANDARD    ?? "x-ai/grok-4.20",
  premium:       process.env.MODEL_PREMIUM     ?? "anthropic/claude-sonnet-4.6",
  frontier:      process.env.MODEL_FRONTIER    ?? "anthropic/claude-opus-4.6",
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

  // Routine (demoted in PR J — P5 routing audit) — structured JSON outputs and
  // short templated scoring. These match the shape of earlier routine demotions
  // (aspiration-evaluation, parallel-search-subqueries, signal-collection).
  // Gemini 3 Flash handles JSON schema output reliably at ~10x cost savings.
  // Canary: watch knowledge-gap-scan / goal-evaluation hit rate for 1 week;
  // revert via env overrides (MODEL_ROUTINE) if quality regresses.
  "knowledge-gap-scan": "routine",          // Structured gap list, no long-form synthesis
  "goal-evaluation": "routine",             // Rubric-style scoring (same family as aspiration-evaluation)
  "x-search": "routine",                    // Short search-query crafting (same family as parallel-search-subqueries). Note: map key is hyphenated because getModel normalizes underscores to hyphens before lookup.

  // Standard — good reasoning, moderate cost
  "research-phase": "standard",
  "self-debate": "standard",
  "exploration": "standard",
  "news-dispatch": "standard",              // Public-facing market commentary
  "research-brief": "premium",
  "reply-generation": "standard",           // Public-facing voice
  "episode-generation": "standard",         // Public-facing script
  "research-agenda-advance": "standard",
  "parallel-search-reduce": "premium",

  // Reasoning pipeline — diverse models for hypothesis evaluation
  "hypothesis-evaluation": "frontier",       // PR E: Claude Opus 4.6 — keystone reasoning. Hallucinated verdicts compound into hypothesis base.
  "adversarial-evaluation": "standard",      // Grok 4.20 — different model for diversity
  "hypothesis-decomposition": "routine",     // Gemini Flash — fast decomposition
  "trust-scoring": "routine",                // Gemini Flash — formulaic calculation
  "evidence-triage": "routine",              // Gemini Flash — lightweight evidence availability check
  "evidence-search-query-gen": "routine",    // Gemini Flash — generate search queries from claims

  // Premium — highest quality for public-facing content
  "deep-reasoning": "frontier",              // PR E: Claude Opus 4.6 — pure reasoning, hallucination-sensitive
  "research-agenda-generate": "premium",
  "podcast-script": "premium",
  "podcast-from-thread": "premium",
  "synthesis-report": "frontier",            // PR E: Claude Opus 4.6 — master synthesis shapes downstream research
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
  "triad-fact-synthesis": "standard",       // Agent 3: package research → FactSheet (Class 1 grounded, Grok fine)
  "triad-reasoning": "frontier",            // PR E: Claude Opus 4.6 — Agent 0 analytical brain; hallucinated LogicMap corrupts triad
  "triad-grounding-review": "premium",     // Agent 0: review Agent 6 output for grounding violations

  // Self-evolution components
  "aspiration-generation": "frontier",      // PR E: Claude Opus 4.6 — shapes Agent 306's forward-looking identity
  "self-evolution-reflection": "frontier",  // PR E: Claude Opus 4.6 — daily self-reflection directly modifies identity
  // (topic-quality-evaluation, breakthrough-evaluation, aspiration-evaluation demoted to routine above)

  // Intelligence v2 — Dual-persona debate
  "skeptic-debate": "standard",            // Skeptic pass — rigorous critic
  "builder-debate": "standard",            // Builder pass — optimistic builder
  "cross-score": "routine",                // Cross-scoring of both verdicts
  "graph-analysis": "routine",             // Graph gap analysis for aspirations
  // (prediction-verification demoted to routine above)

  // PR #4 — explicit aliases for tasks that were silently falling through
  // to the default "standard" tier. Each entry matches how the task is
  // invoked in the codebase; both hyphenated and underscored variants
  // resolve via normalizeTaskName() below, but we keep explicit entries
  // where the underscore form is the one in active use.
  "academy": "premium",                    // Long-form academy content — public-facing voice
  "boost": "standard",                     // Community boost post — Agent 306's voice
  "cyoa": "standard",                      // Choose-your-own-adventure episodes — public voice
  "manuscript": "premium",                 // Long-form manuscript — public-facing voice
  "conversation-insight": "routine",       // Short insight extraction, same family as conversation-insights
  "research-scan": "routine",              // Goal-scan research pass — structured enumeration
};

/**
 * Normalize a task name to the canonical form used as TASK_COMPLEXITY keys.
 * Replaces underscores with hyphens and lowercases, so "Hypothesis_Resolution"
 * and "hypothesis-resolution" and "HYPOTHESIS_RESOLUTION" all resolve the same.
 */
export function normalizeTaskName(task: string): string {
  return task.replace(/_/g, "-").toLowerCase();
}

/**
 * Get the appropriate model for a task.
 * Normalizes via normalizeTaskName() so both "hypothesis_resolution" and
 * "hypothesis-resolution" resolve to the same routing entry.
 * @param task - Task identifier (e.g., "podcast-script", "reflection")
 * @returns OpenRouter model string (e.g., "anthropic/claude-sonnet-4.6")
 */
export function getModel(task: string): string {
  const normalized = normalizeTaskName(task);
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
