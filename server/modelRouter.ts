/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — SMART MODEL ROUTER
 *
 *  Routes tasks to the appropriate Grok model based on complexity.
 *
 *  Tiers:
 *    routine  → grok-3-mini-fast  (cheapest — scans, decay, reflections)
 *    standard → grok-3-fast       (current default — research, debates)
 *    premium  → grok-3            (highest quality — scripts, synthesis, manuscripts)
 *
 *  Episode generation uses grok-4-1-fast (unchanged — separate from router).
 * ─────────────────────────────────────────────────────────────
 */

export type TaskComplexity = "routine" | "standard" | "premium";

const MODEL_MAP: Record<TaskComplexity, string> = {
  routine:  "grok-3-mini-fast",
  standard: "grok-3-fast",
  premium:  "grok-3",
};

// ── Task → Complexity mapping ────────────────────────────────────────────────

const TASK_COMPLEXITY: Record<string, TaskComplexity> = {
  // Routine — cheap, fast, simple analysis
  "reflection":             "routine",
  "confidence_decay":       "routine",
  "contradiction_scan":     "routine",
  "connection_scan":        "routine",
  "conversation_insight":   "routine",
  "hypothesis_resolution":  "routine",
  "knowledge_gap_scan":     "routine",
  "boost":                  "routine",
  "reply_classification":   "routine",

  // Standard — research, debate, moderate reasoning
  "research_phase":         "standard",
  "self_debate":            "standard",
  "goal_evaluation":        "standard",
  "exploration_synthesis":  "standard",
  "exploration_research":   "standard",
  "reply_generation":       "standard",
  "burn_receipt":           "standard",
  "signal_brief":           "standard",
  "academy":                "standard",
  "spotlight":              "standard",
  "leaderboard":            "standard",
  "cyoa":                   "standard",
  "relationship_analysis":  "standard",
  "x_search":               "standard",
  "daily_briefing":         "standard",

  // Premium — high-quality generation, publication-grade
  "episode_script":         "premium",
  "podcast_script":         "premium",
  "synthesis_report":       "premium",
  "article_draft":          "premium",
  "manuscript":             "premium",
  "research_scan":          "premium",
  "race_narrative":         "premium",
  "skill_extraction":       "premium",
};

/**
 * Get the appropriate Grok model for a task.
 * Falls back to "grok-3-fast" for unknown tasks.
 */
export function getModel(task: string): string {
  const complexity = TASK_COMPLEXITY[task];
  if (!complexity) {
    console.warn(`[ModelRouter] Unknown task "${task}" — defaulting to standard`);
    return MODEL_MAP.standard;
  }
  return MODEL_MAP[complexity];
}

/**
 * Get the complexity tier for a task.
 */
export function getTaskComplexity(task: string): TaskComplexity {
  return TASK_COMPLEXITY[task] ?? "standard";
}

/**
 * Get stats about model routing for dashboard.
 */
export function getModelRouterStats(): {
  models: Record<string, string>;
  taskCount: Record<TaskComplexity, number>;
  tasks: Record<string, TaskComplexity>;
} {
  const taskCount: Record<TaskComplexity, number> = { routine: 0, standard: 0, premium: 0 };
  for (const complexity of Object.values(TASK_COMPLEXITY)) {
    taskCount[complexity]++;
  }
  return {
    models: { ...MODEL_MAP },
    taskCount,
    tasks: { ...TASK_COMPLEXITY },
  };
}
