/**
 * Smart Model Router for Agent 306.
 *
 * Routes tasks to appropriate models across providers (xAI direct, OpenRouter,
 * Perplexity). The tier namespace was expanded in this PR so the routing matrix
 * can distinguish ASI-sensitive factual reasoning (Grok 4.20 Reasoning, 17%
 * hallucination flagship) from Claude Opus 4.6 (architecture/complex reasoning)
 * without collapsing them back into a single "frontier" bucket.
 *
 * Tier map:
 *   routine            → OpenRouter  google/gemini-3-flash-preview
 *   standard           → OpenRouter  x-ai/grok-4.20                       (legacy alias)
 *   standard-voice     → xAI-direct  grok-4.20-0309-non-reasoning         (public voice)
 *   premium            → OpenRouter  anthropic/claude-sonnet-4.6          (alias for premium-voice)
 *   premium-voice      → OpenRouter  anthropic/claude-sonnet-4.6          (long-form content)
 *   frontier           → OpenRouter  anthropic/claude-opus-4.6            (alias for frontier-reasoning)
 *   frontier-factual   → xAI-direct  grok-4.20-0309-reasoning             (17% hallucination flagship)
 *   frontier-reasoning → OpenRouter  anthropic/claude-opus-4.6            (architecture/complex code reasoning)
 *   multi-agent        → xAI-direct  grok-4.20-multi-agent-0309
 *   live-social        → xAI-direct  grok-4.20-0309-non-reasoning + x_search
 *   live-research      → Perplexity  sonar-pro
 *
 * Both `frontier` and `premium` remain valid tier keys for backwards-compat so
 * no existing caller breaks; they resolve to the same concrete model as their
 * *-reasoning / *-voice successors.
 */

export type TaskComplexity =
  | "routine"
  | "standard"
  | "standard-voice"
  | "premium"
  | "premium-voice"
  | "frontier"
  | "frontier-factual"
  | "frontier-reasoning"
  | "multi-agent"
  | "live-social"
  | "live-research";

/**
 * Tier → provider/model defaults. Lookups are lazy (via getModelMap()) so
 * env-var overrides applied after process start still take effect — useful
 * for tests, Railway env var hot-swaps, and ops "turn off the flagship" knobs.
 */
function getModelMap(): Record<TaskComplexity, string> {
  return {
    routine:              process.env.MODEL_ROUTINE             ?? "google/gemini-3-flash-preview",
    standard:             process.env.MODEL_STANDARD            ?? "x-ai/grok-4.20",
    // standard-voice — public-voice Grok 4.20 non-reasoning via xAI Direct.
    "standard-voice":     process.env.MODEL_STANDARD_VOICE      ?? "x-ai/grok-4.20-non-reasoning",
    premium:              process.env.MODEL_PREMIUM             ?? "anthropic/claude-sonnet-4.6",
    "premium-voice":      process.env.MODEL_PREMIUM_VOICE       ?? "anthropic/claude-sonnet-4.6",
    // frontier — historical alias. New code should prefer frontier-factual or
    // frontier-reasoning so the log line is unambiguous.
    frontier:             process.env.MODEL_FRONTIER            ?? "anthropic/claude-opus-4.6",
    // frontier-factual — Grok 4.20 Reasoning via xAI Direct. Lowest recorded
    // hallucination rate (17% AA-Omniscience, April 2026). Use for factual
    // verification, hypothesis evaluation, red-flag analysis.
    "frontier-factual":   process.env.MODEL_FRONTIER_FACTUAL    ?? "x-ai/grok-4.20-reasoning",
    // frontier-reasoning — Claude Opus 4.6 via OpenRouter.
    "frontier-reasoning": process.env.MODEL_FRONTIER_REASONING  ?? "anthropic/claude-opus-4.6",
    "multi-agent":        process.env.MODEL_MULTI_AGENT         ?? "x-ai/grok-4.20-multi-agent",
    // live-social — xAI Responses API + x_search tool. Must resolve to an xAI-
    // hosted model so postXSearchResponses's provider guard lets the call through.
    "live-social":        process.env.MODEL_LIVE_SOCIAL         ?? "x-ai/grok-4.20-non-reasoning",
    // live-research — Perplexity Sonar for live web-grounded research.
    "live-research":      process.env.MODEL_LIVE_RESEARCH       ?? "sonar-pro",
  };
}

const TASK_COMPLEXITY: Record<string, TaskComplexity> = {
  // Routine — cheap/fast, no deep reasoning needed
  "reflection": "routine",
  "confidence-decay": "routine",
  "contradiction-scan": "routine",
  "connection-scan": "routine",
  "conversation-insights": "routine",
  "hypothesis-resolution": "premium-voice",   // Claude Sonnet 4.6 — multi-agent model uses Responses API (incompatible with Chat Completions JSON output)
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
  // signal-brief uses postXSearchResponses (xAI Responses API + x_search tool).
  "signal-brief": "live-social",
  "parallel-search-subqueries": "routine",  // Generate 3-5 search subqueries from a claim
  "perspective-generation": "routine",      // Alt-perspective generation in knowledge graph
  "episode-reflection": "routine",          // Short post-episode notes
  "ai-roundup": "routine",                  // Roundup packaging (formatting)
  "community-boost": "routine",             // Short supportive reply draft
  "prediction-verification": "routine",     // Rubric-driven prediction check

  // Structured JSON outputs / short templated scoring — all Gemini Flash.
  "knowledge-gap-scan": "routine",
  "goal-evaluation": "routine",
  // x-search — Note: this is the OLD task name used by evidenceDispatcher for
  // short-query crafting, NOT x_search tool invocation. Crafting runs on
  // Gemini; actual x_search calls go through live-social via postXSearchResponses.
  "x-search": "routine",

  // Standard — good reasoning, moderate cost (Grok 4.20 via OpenRouter)
  "research-phase": "standard",
  "self-debate": "multi-agent",             // Grok multi-agent debate engine
  "exploration": "standard-voice",          // Public-voice exploration narrative
  "news-dispatch": "standard-voice",        // Public-facing market commentary
  "research-brief": "premium-voice",
  "reply-generation": "standard-voice",     // Public-voice reply
  "episode-generation": "standard-voice",   // Public-voice script
  "research-agenda-advance": "standard",
  "parallel-search-reduce": "premium-voice",

  // Reasoning pipeline — factual claims go to the 17%-hallucination flagship.
  "hypothesis-evaluation":      "frontier-factual", // Hypothesis verdicts compound into hypothesis base
  "adversarial-evaluation":     "standard",          // Different model for diversity
  "hypothesis-decomposition":   "routine",
  "trust-scoring":              "routine",
  "evidence-triage":            "routine",
  "evidence-search-query-gen":  "routine",
  // Verification / red-flag analysis — factual accuracy is the whole job.
  "fact-verification":          "frontier-factual",
  "red-flag-analysis":          "frontier-factual",

  // Premium-voice — highest quality for long-form public-facing content.
  "deep-reasoning":             "frontier-reasoning", // Architecture/complex reasoning
  "research-agenda-generate":   "premium-voice",
  "podcast-script":             "premium-voice",
  "podcast-from-thread":        "premium-voice",
  "synthesis-report":           "frontier-reasoning", // Master synthesis, shapes downstream research
  "article-draft":              "standard-voice",     // Public voice — Grok 4.20 non-reasoning
  "article_draft":              "standard-voice",
  "article":                    "standard-voice",
  "intro-post":                 "standard-voice",
  "manuscript-generation":      "premium-voice",
  "skill-extraction":           "premium-voice",
  "daily-briefing":             "premium-voice",
  "improvement-plan":           "premium-voice",
  "blog-post":                  "premium-voice",      // Long-form blog = premium voice
  "blog":                       "premium-voice",

  // Research analysis framework (9-prompt, 4-phase)
  "analysis-contradictions":    "premium-voice",
  "analysis-citation-chains":   "premium-voice",
  "analysis-gap-scan":          "premium-voice",
  "analysis-methodology-audit": "premium-voice",
  "analysis-synthesis":         "premium-voice",
  "analysis-knowledge-map":     "premium-voice",

  // Agentic Triad tasks
  "triad-fact-synthesis":   "standard",
  "triad-reasoning":        "multi-agent",       // Grok multi-agent (4-agent collaborative debate)
  "triad-grounding-review": "premium-voice",
  "triad":                  "multi-agent",

  // Self-evolution — architecture/identity reasoning goes to Opus.
  "aspiration-generation":      "frontier-reasoning",
  "self-evolution-reflection":  "frontier-reasoning",
  "architecture":               "frontier-reasoning",
  "complex-code-reasoning":     "frontier-reasoning",

  // Intelligence v2 — Dual-persona debate
  "skeptic-debate":  "standard",
  "builder-debate":  "standard",
  "cross-score":     "routine",
  "graph-analysis":  "routine",

  // Public-voice aliases
  "academy":               "premium-voice",
  "boost":                 "standard-voice",     // Community boost — Agent 306's voice
  "cyoa":                  "standard-voice",     // Public-voice CYOA episodes
  "manuscript":            "premium-voice",
  "conversation-insight":  "routine",
  "research-scan":         "routine",
  "public-voice":          "standard-voice",
  "reply":                 "standard-voice",

  // Explicit entries (previously hitting the default)
  "exploration-synthesis":    "standard",
  "goal-generation":          "standard",
  "hypothesis-consolidation": "standard",

  // Live-research — Perplexity-backed tasks.
  "news-research":          "live-research",
  "breakthrough-research":  "live-research",
  "evidence-research":      "live-research",

  // Scoring / classification → routine
  "scoring":        "routine",
  "classification": "routine",
};

/**
 * Normalize a task name to the canonical form used as TASK_COMPLEXITY keys.
 */
export function normalizeTaskName(task: string): string {
  return task.replace(/_/g, "-").toLowerCase();
}

/**
 * Get the tier (TaskComplexity) assigned to a task after normalization.
 * Unknown tasks fall back to "standard".
 */
export function getTier(task: string): TaskComplexity {
  const normalized = normalizeTaskName(task);
  return TASK_COMPLEXITY[normalized] ?? "standard";
}

/**
 * Get the appropriate model for a task.
 * Normalizes via normalizeTaskName() so both "hypothesis_resolution" and
 * "hypothesis-resolution" resolve to the same routing entry.
 */
export function getModel(task: string): string {
  return getModelMap()[getTier(task)];
}

/**
 * Get all model mappings (for the /api/model-router status endpoint).
 */
export function getModelConfig(): { models: Record<string, string>; tasks: Record<string, string> } {
  const map = getModelMap();
  return {
    models: { ...map },
    tasks: Object.fromEntries(
      Object.entries(TASK_COMPLEXITY).map(([task, complexity]) => [task, map[complexity]])
    ),
  };
}
