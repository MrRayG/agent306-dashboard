/**
 * Smart Model Router for Agent 306.
 * 
 * Routes tasks to appropriate models via OpenRouter:
 *   routine  → google/gemini-2.5-flash  (cheapest, fast)
 *   standard → x-ai/grok-3-fast        (current default via OpenRouter)
 *   premium  → anthropic/claude-sonnet-4.6  (highest quality for scripts/synthesis)
 * 
 * OpenRouter model names use provider/model format.
 * If a model is unavailable, OpenRouter returns an error — 
 * callers should handle gracefully.
 */

export type TaskComplexity = "routine" | "standard" | "premium";

const MODEL_MAP: Record<TaskComplexity, string> = {
  routine:  process.env.MODEL_ROUTINE  ?? "google/gemini-2.5-flash-preview",
  standard: process.env.MODEL_STANDARD ?? "x-ai/grok-3-fast",
  premium:  process.env.MODEL_PREMIUM  ?? "anthropic/claude-sonnet-4.6",
};

const TASK_COMPLEXITY: Record<string, TaskComplexity> = {
  // Routine — cheap/fast, no deep reasoning needed
  "reflection": "routine",
  "confidence-decay": "routine",
  "contradiction-scan": "routine",
  "connection-scan": "routine",
  "conversation-insights": "routine",
  "hypothesis-resolution": "routine",
  "knowledge-categorization": "routine",
  "tier-assignment": "routine",
  "injection-scan": "routine",

  // Standard — good reasoning, moderate cost
  "research-phase": "standard",
  "self-debate": "standard",
  "knowledge-gap-scan": "standard",
  "goal-evaluation": "standard",
  "exploration": "standard",
  "signal-collection": "standard",
  "news-dispatch": "standard",
  "reply-generation": "standard",
  "community-boost": "standard",
  "episode-generation": "standard",

  // Premium — highest quality for public-facing content
  "podcast-script": "premium",
  "synthesis-report": "premium",
  "article-draft": "premium",
  "manuscript-generation": "premium",
  "skill-extraction": "premium",
  "daily-briefing": "premium",
};

/**
 * Get the appropriate model for a task.
 * @param task - Task identifier (e.g., "podcast-script", "reflection")
 * @returns OpenRouter model string (e.g., "anthropic/claude-sonnet-4.6")
 */
export function getModel(task: string): string {
  const complexity = TASK_COMPLEXITY[task] ?? "standard";
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
