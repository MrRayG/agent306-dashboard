/**
 * Central LLM API configuration for Agent 306.
 *
 * Uses OpenRouter as the unified gateway — access to Grok, Claude, Gemini,
 * GPT, Llama, and 300+ other models through one API.
 *
 * OpenRouter uses the OpenAI-compatible chat completions format.
 * To switch models, just change the model string — no code changes needed.
 */

// OpenRouter base URL (OpenAI-compatible)
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1/chat/completions";

// API key: prefer OpenRouter, fall back to Grok for backward compatibility
export const LLM_API_KEY = process.env.OPENROUTER_API_KEY ?? process.env.GROK_API_KEY ?? "";

// Response API (for models that support it — not all do via OpenRouter)
export const LLM_RESPONSE_URL = process.env.LLM_RESPONSE_URL ?? "https://openrouter.ai/api/v1/chat/completions";

// xAI direct key — used for xAI-only features (image, TTS, video, x_search, Responses API)
export const XAI_DIRECT_API_KEY = process.env.GROK_API_KEY ?? "";

// xAI direct base URL (overridable for testing)
export const XAI_DIRECT_BASE_URL = process.env.XAI_DIRECT_BASE_URL ?? "https://api.x.ai/v1";

/**
 * Helper to get auth headers for LLM API calls.
 */
export function getLLMHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${LLM_API_KEY}`,
    "HTTP-Referer": "https://agent306.ai",
    "X-Title": "Agent 306",
  };
}

/**
 * Helper to get auth headers for xAI direct API calls (Responses API, image, TTS, video, x_search).
 */
export function getXAIDirectHeaders(): Record<string, string> {
  const key = process.env.GROK_API_KEY ?? XAI_DIRECT_API_KEY;
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${key}`,
  };
}

/**
 * Centralized LLM timeout configuration.
 * All values in milliseconds. Overridable via environment variables.
 */
export const LLM_TIMEOUTS = {
  hypothesis_evaluation: parseInt(process.env.LLM_TIMEOUT_HYPOTHESIS ?? "60000", 10),
  adversarial_evaluation: parseInt(process.env.LLM_TIMEOUT_ADVERSARIAL ?? "60000", 10),
  triad_fact_sheet: parseInt(process.env.LLM_TIMEOUT_TRIAD_FACT ?? "90000", 10),
  triad_logic_map: parseInt(process.env.LLM_TIMEOUT_TRIAD_LOGIC ?? "120000", 10),
  triad_generate: parseInt(process.env.LLM_TIMEOUT_TRIAD_GENERATE ?? "150000", 10),
  triad_revision: parseInt(process.env.LLM_TIMEOUT_TRIAD_REVISION ?? "150000", 10),
  triad_grounding: parseInt(process.env.LLM_TIMEOUT_TRIAD_GROUNDING ?? "90000", 10),
  consolidation: parseInt(process.env.LLM_TIMEOUT_CONSOLIDATION ?? "45000", 10),
  goal_generation: parseInt(process.env.LLM_TIMEOUT_GOAL ?? "45000", 10),
  default: parseInt(process.env.LLM_TIMEOUT_DEFAULT ?? "60000", 10),
};

// ─── callLLM abstraction types ───────────────────────────────────────────────

export type LLMMode = "chat" | "responses";
export type LLMFeature = "text" | "image" | "tts" | "video" | "x_search";

export interface LLMCallOptions {
  task: string;
  mode?: LLMMode;
  messages?: Array<{ role: string; content: string }>;
  input?: Array<{ role: string; content: string }>;
  tools?: any[];
  previousResponseId?: string;
  conversationId?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LLMResponse {
  text: string;
  model: string;
  responseId?: string;
  rawResponse: any;
  mode: LLMMode;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Returns true if a feature can ONLY be served by xAI direct (not via OpenRouter).
 */
export function isXAIOnlyFeature(feature: string): boolean {
  return feature === "image" || feature === "tts" || feature === "video" || feature === "x_search";
}

/**
 * Maps OpenRouter-format xAI model names to xAI-native names
 * for use with the Responses API at api.x.ai/v1/responses.
 *
 * Returns null if the model is not xAI-hosted (Anthropic, Google, etc.)
 * — caller should downgrade to chat/completions for those.
 */
export function toXAINativeModel(openrouterModel: string): string | null {
  if (!openrouterModel.startsWith("x-ai/")) return null;

  // Per https://docs.x.ai/docs/models — grok-4.20 and grok-4-1-fast are
  // DIFFERENT models with different pricing ($2/$6 vs $0.20/$0.50 per 1M).
  // The old mapping silently downgraded every flagship grok-4.20 call to
  // the budget Fast model. This caused Agent 306 to never actually invoke
  // Grok 4.20 (confirmed empirically: 0 api.x.ai hits across 1001 log events).
  //
  // AA-Omniscience leaderboard (April 2026):
  //   grok-4.20-0309-reasoning     → 17% hallucination (lowest recorded)
  //   grok-4.20-0309-non-reasoning → 22% hallucination
  //   grok-4-1-fast                → 72% hallucination (budget tier)
  const mapping: Record<string, string> = {
    // Flagship Grok 4.20 family — actual native IDs per docs.x.ai
    "x-ai/grok-4.20": "grok-4.20-0309-non-reasoning",
    "x-ai/grok-4.20-non-reasoning": "grok-4.20-0309-non-reasoning",
    "x-ai/grok-4.20-reasoning": "grok-4.20-0309-reasoning",
    "x-ai/grok-4.20-multi-agent": "grok-4.20-multi-agent-0309",
    // Grok 4 (original)
    "x-ai/grok-4": "grok-4",
    "x-ai/grok-4-0709": "grok-4-0709",
    // Budget Fast tier — kept as-is for cost-sensitive routine tasks
    "x-ai/grok-4-fast-reasoning": "grok-4-fast-reasoning",
    "x-ai/grok-4-fast-non-reasoning": "grok-4-fast-non-reasoning",
    "x-ai/grok-4-1-fast-reasoning": "grok-4-1-fast-reasoning",
    "x-ai/grok-4-1-fast-non-reasoning": "grok-4-1-fast-non-reasoning",
  };

  if (mapping[openrouterModel]) return mapping[openrouterModel];

  return openrouterModel.replace(/^x-ai\//, "");
}

/**
 * xAI-direct chat/completions routing (PR O).
 *
 * Grok LLM calls land on api.x.ai/v1/chat/completions directly with
 * XAI_DIRECT_API_KEY — bypassing OpenRouter — so engines exercise the same
 * entitlement surface our diagnostic probe confirmed works (chat=200).
 * Non-Grok models (Anthropic, Google, etc.) continue to use OpenRouter.
 *
 * Controlled by XAI_DIRECT_CHAT_ENABLED (default "true"). Set to "false" for
 * emergency rollback without a code revert.
 *
 * Hard-fail: no automatic fallback to OpenRouter on xAI errors — matches the
 * user's explicit policy for xAI overrides.
 */
export function isXAIDirectChatEnabled(): boolean {
  return (process.env.XAI_DIRECT_CHAT_ENABLED ?? "true") !== "false";
}

export interface ChatRoute {
  url: string;
  headers: Record<string, string>;
  model: string;            // model string actually sent to the provider
  provider: "xai-direct" | "openrouter" | "perplexity";
}

// Perplexity base URL (OpenAI-compatible chat/completions).
export const PERPLEXITY_BASE_URL = process.env.PERPLEXITY_BASE_URL ?? "https://api.perplexity.ai";
export const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY ?? "";

/**
 * Returns true if the model string looks like a Perplexity Sonar model.
 * Sonar IDs do not carry a `provider/` prefix (e.g. "sonar-pro", "sonar").
 */
export function isPerplexityModel(model: string): boolean {
  return /^sonar(-|$)/.test(model);
}

export function getPerplexityHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${PERPLEXITY_API_KEY}`,
  };
}

/**
 * Decides whether a given model should be routed to xAI direct, Perplexity,
 * or OpenRouter. Returns the concrete URL, headers and provider-native model
 * name the caller should use.
 */
export function resolveChatRoute(openrouterModel: string): ChatRoute {
  const xaiNative = toXAINativeModel(openrouterModel);
  // Read GROK_API_KEY live so tests / ops env hot-swaps take effect without
  // a module reload.
  const hasGrokKey = !!(process.env.GROK_API_KEY ?? XAI_DIRECT_API_KEY);
  if (xaiNative !== null && isXAIDirectChatEnabled() && hasGrokKey) {
    return {
      url: `${XAI_DIRECT_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      headers: getXAIDirectHeaders(),
      model: xaiNative,
      provider: "xai-direct",
    };
  }
  if (isPerplexityModel(openrouterModel)) {
    return {
      url: `${PERPLEXITY_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      headers: getPerplexityHeaders(),
      model: openrouterModel,
      provider: "perplexity",
    };
  }
  return {
    url: LLM_BASE_URL,
    headers: getLLMHeaders(),
    model: openrouterModel,
    provider: "openrouter",
  };
}

/**
 * Resolves which API mode a task should use, based on the RESPONSES_API_ENABLED_TASKS env var.
 *
 * Empty/unset env means all tasks default to "chat" — zero behavior change.
 * Underscores in the input task are normalized to hyphens before matching.
 */
export function resolveMode(task: string): LLMMode {
  const list = process.env.RESPONSES_API_ENABLED_TASKS ?? "";
  if (!list.trim()) return "chat";
  const normalizedTask = task.replace(/_/g, "-");
  const enabled = list
    .split(",")
    .map(s => s.trim().replace(/_/g, "-"))
    .filter(Boolean);
  return enabled.includes(normalizedTask) ? "responses" : "chat";
}
