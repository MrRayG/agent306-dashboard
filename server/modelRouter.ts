/**
 * Smart Model Router for Agent 306.
 *
 * Locked routing matrix (PR: router-tier-split):
 *   frontier-factual    → xai-direct   grok-4.20-0309-reasoning       (17% hallucination flagship — factual eval)
 *   frontier-reasoning  → openrouter   anthropic/claude-opus-4.6      (identity-shaping reasoning)
 *   premium-voice       → openrouter   anthropic/claude-sonnet-4.6    (long-form public voice)
 *   standard-voice      → xai-direct   grok-4.20-0309-non-reasoning   (public voice, article/reply)
 *   multi-agent         → xai-direct   grok-4.20-multi-agent-0309     (4-agent debate)
 *   live-social         → xai-direct   grok-4.20-0309-non-reasoning   (+x_search tool)
 *   live-research       → perplexity   sonar-pro                      (news grounding)
 *   routine             → openrouter   google/gemini-3-flash-preview  (structured JSON / scoring)
 *
 * frontier-factual exists specifically so hypothesis-eval / fact-verification
 * / red-flag analysis / evidence eval hit Grok 4.20 Reasoning (lowest recorded
 * hallucination rate on AA-Omniscience) instead of getting collapsed into a
 * single "frontier" bucket that was exclusively serving Claude Opus.
 *
 * Backwards-compat aliases:
 *   frontier → frontier-reasoning
 *   premium  → premium-voice
 *   standard → standard-voice
 * Any external caller that still resolves by the old tier name keeps working.
 */

export type TaskComplexity =
  | "routine"
  | "standard-voice"
  | "premium-voice"
  | "frontier-factual"
  | "frontier-reasoning"
  | "multi-agent"
  | "live-social"
  | "live-research";

export type RouteProvider = "xai-direct" | "openrouter" | "perplexity";

export interface TierConfig {
  provider: RouteProvider;
  model: string;
}

/**
 * Tier → {provider, model}. Defaults use OpenRouter-format strings for
 * xAI tiers so resolveChatRoute()/toXAINativeModel() (in llmConfig) continue
 * to translate them to the correct native name (e.g. grok-4.20-0309-reasoning)
 * before dispatch. Env overrides may use either format.
 */
const TIER_MAP: Record<TaskComplexity, TierConfig> = {
  "routine": {
    provider: "openrouter",
    model: process.env.MODEL_ROUTINE ?? "google/gemini-3-flash-preview",
  },
  "standard-voice": {
    provider: "xai-direct",
    model: process.env.MODEL_STANDARD_VOICE ?? "x-ai/grok-4.20-non-reasoning",
  },
  "premium-voice": {
    provider: "openrouter",
    model: process.env.MODEL_PREMIUM_VOICE ?? "anthropic/claude-sonnet-4.6",
  },
  "frontier-factual": {
    provider: "xai-direct",
    // x-ai/grok-4.20-reasoning → grok-4.20-0309-reasoning via toXAINativeModel()
    model: process.env.MODEL_FRONTIER_FACTUAL ?? "x-ai/grok-4.20-reasoning",
  },
  "frontier-reasoning": {
    provider: "openrouter",
    model: process.env.MODEL_FRONTIER_REASONING ?? "anthropic/claude-opus-4.6",
  },
  "multi-agent": {
    provider: "xai-direct",
    model: process.env.MODEL_MULTI_AGENT ?? "x-ai/grok-4.20-multi-agent",
  },
  "live-social": {
    // Tasks that need xAI Responses API + x_search tool. Must resolve to an
    // xAI-hosted model so toXAINativeModel() returns non-null in
    // postXSearchResponses; otherwise the helper hard-fails.
    provider: "xai-direct",
    model: process.env.MODEL_LIVE_SOCIAL ?? "x-ai/grok-4.20-non-reasoning",
  },
  "live-research": {
    provider: "perplexity",
    model: process.env.MODEL_LIVE_RESEARCH ?? "sonar-pro",
  },
};

/**
 * Collapsed-alias map. Pre-PR callers (and one external integration) still
 * use the short tier names; these keep resolving without a code change.
 */
const TIER_ALIAS: Record<string, TaskComplexity> = {
  "frontier": "frontier-reasoning",
  "premium":  "premium-voice",
  "standard": "standard-voice",
};

function resolveTier(name: string): TaskComplexity {
  if ((TIER_MAP as Record<string, TierConfig>)[name]) return name as TaskComplexity;
  const aliased = TIER_ALIAS[name];
  if (aliased) return aliased;
  return "standard-voice";
}

const TASK_COMPLEXITY: Record<string, TaskComplexity> = {
  // ── Routine — structured JSON outputs, rubric scoring, short extraction ──
  "reflection": "routine",
  "confidence-decay": "routine",
  "contradiction-scan": "routine",
  "connection-scan": "routine",
  "conversation-insights": "routine",
  "knowledge-categorization": "routine",
  "tier-assignment": "routine",
  "injection-scan": "routine",
  "cluster-scan": "routine",
  "dream-update": "routine",
  "growth-snapshot": "routine",
  "social-preview": "routine",
  "breakthrough-evaluation": "routine",
  "topic-quality-evaluation": "routine",
  "aspiration-evaluation": "routine",
  "analysis-so-what": "routine",
  "analysis-assumptions": "routine",
  "analysis-intake": "routine",
  "signal-collection": "routine",
  "parallel-search-subqueries": "routine",
  "perspective-generation": "routine",
  "episode-reflection": "routine",
  "ai-roundup": "routine",
  "community-boost": "routine",
  "prediction-verification": "routine",
  "knowledge-gap-scan": "routine",
  "goal-evaluation": "routine",
  "x-search": "routine",
  "hypothesis-decomposition": "routine",
  "trust-scoring": "routine",
  "evidence-triage": "routine",
  "evidence-search-query-gen": "routine",
  "cross-score": "routine",
  "graph-analysis": "routine",
  "conversation-insight": "routine",
  "research-scan": "routine",

  // ── Frontier-factual — lowest-hallucination Grok 4.20 Reasoning ──
  // Tasks whose hallucinations would compound into the hypothesis / evidence
  // base. Routes to xai-direct so api.x.ai actually sees Grok 4.20 Reasoning,
  // not a silent collapse to Claude Opus via OpenRouter.
  "hypothesis-evaluation":   "frontier-factual",
  "fact-verification":       "frontier-factual",
  "red-flag-analysis":       "frontier-factual",
  "evidence-evaluation":     "frontier-factual",

  // ── Frontier-reasoning — Claude Opus 4.6 ──
  // Pure reasoning, identity-shaping tasks; factual freshness less critical.
  "deep-reasoning":           "frontier-reasoning",
  "synthesis-report":         "frontier-reasoning",
  "architecture":             "frontier-reasoning",
  "complex-code-reasoning":   "frontier-reasoning",
  "triad-reasoning":          "frontier-reasoning",
  "aspiration-generation":    "frontier-reasoning",
  "self-evolution-reflection":"frontier-reasoning",

  // ── Premium-voice — Claude Sonnet 4.6 (long-form public) ──
  "manuscript":               "premium-voice",
  "manuscript-generation":    "premium-voice",
  "blog":                     "premium-voice",
  "blog-post":                "premium-voice",
  "long-form":                "premium-voice",
  "podcast":                  "premium-voice",
  "podcast-script":           "premium-voice",
  "podcast-from-thread":      "premium-voice",
  "research-brief":           "premium-voice",
  "research-agenda-generate": "premium-voice",
  "article-draft":            "premium-voice",
  "article_draft":            "premium-voice",
  "daily-briefing":           "premium-voice",
  "improvement-plan":         "premium-voice",
  "skill-extraction":         "premium-voice",
  "academy":                  "premium-voice",
  "hypothesis-resolution":    "premium-voice",
  "analysis-contradictions":  "premium-voice",
  "analysis-citation-chains": "premium-voice",
  "analysis-gap-scan":        "premium-voice",
  "analysis-methodology-audit":"premium-voice",
  "analysis-synthesis":       "premium-voice",
  "analysis-knowledge-map":   "premium-voice",
  "triad-grounding-review":   "premium-voice",
  "parallel-search-reduce":   "premium-voice",

  // ── Standard-voice — Grok 4.20 non-reasoning (public voice, Class 1 grounded) ──
  "article":                 "standard-voice",
  "exploration":             "standard-voice",
  "exploration-synthesis":   "standard-voice",
  "reply":                   "standard-voice",
  "reply-generation":        "standard-voice",
  "boost":                   "standard-voice",
  "public-voice":            "standard-voice",
  "research-phase":          "standard-voice",
  "self-debate":             "standard-voice",
  "news-dispatch":           "standard-voice",
  "episode-generation":      "standard-voice",
  "research-agenda-advance": "standard-voice",
  "adversarial-evaluation":  "standard-voice",
  "triad-fact-synthesis":    "standard-voice",
  "skeptic-debate":          "standard-voice",
  "builder-debate":          "standard-voice",
  "intro-post":              "standard-voice",
  "cyoa":                    "standard-voice",
  "goal-generation":         "standard-voice",
  "hypothesis-consolidation":"standard-voice",

  // ── Multi-agent — Grok 4.20 multi-agent ──
  "triad":          "multi-agent",
  "multi-agent":    "multi-agent",
  // self-debate stays at standard-voice (single-agent debate);
  // a dedicated 4-agent debate task would use "multi-agent" explicitly.

  // ── Live-social — xAI Responses API + x_search ──
  "signal-brief":  "live-social",

  // ── Live-research — Perplexity sonar-pro ──
  "news-research":        "live-research",
  "breakthrough-research":"live-research",
  "evidence-research":    "live-research",
};

/**
 * Normalize a task name to the canonical form used as TASK_COMPLEXITY keys.
 */
export function normalizeTaskName(task: string): string {
  return task.replace(/_/g, "-").toLowerCase();
}

/**
 * Resolve a task to its {tier, provider, model} routing decision.
 * Preferred entry point for new call sites — exposes the tier name so
 * observability / logging emits the specific tier ("frontier-factual") rather
 * than the collapsed alias.
 */
export function resolveTask(task: string): { tier: TaskComplexity; provider: RouteProvider; model: string } {
  const normalized = normalizeTaskName(task);
  const tier = TASK_COMPLEXITY[normalized] ?? "standard-voice";
  const cfg = TIER_MAP[tier];
  return { tier, provider: cfg.provider, model: cfg.model };
}

/**
 * Get the appropriate model string for a task (backwards-compat shim).
 * Returns the configured model string — OpenRouter-format for openrouter/xai
 * tiers, native name for perplexity. Callers that route via resolveChatRoute()
 * continue to work unchanged; xAI native-name translation happens downstream
 * in toXAINativeModel().
 */
export function getModel(task: string): string {
  return resolveTask(task).model;
}

/**
 * Legacy MODEL_MAP surface for callers that inspected it directly.
 * Mirrors the old flat {tierName → modelString} shape. The new tier names
 * appear as first-class keys; the collapsed aliases resolve through
 * resolveTierModel() below.
 */
export function getModelConfig(): { models: Record<string, string>; tasks: Record<string, string> } {
  const models: Record<string, string> = {};
  for (const [tier, cfg] of Object.entries(TIER_MAP)) {
    models[tier] = cfg.model;
  }
  // Backwards-compat alias keys.
  models["frontier"] = TIER_MAP["frontier-reasoning"].model;
  models["premium"]  = TIER_MAP["premium-voice"].model;
  models["standard"] = TIER_MAP["standard-voice"].model;

  const tasks: Record<string, string> = {};
  for (const [task, tier] of Object.entries(TASK_COMPLEXITY)) {
    tasks[task] = TIER_MAP[tier].model;
  }
  return { models, tasks };
}

/**
 * Resolve a tier name (including aliases) to its model string.
 * Used by callers that want to query the active config for a specific tier.
 */
export function resolveTierModel(tier: string): string {
  return TIER_MAP[resolveTier(tier)].model;
}
