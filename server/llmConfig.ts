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
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${XAI_DIRECT_API_KEY}`,
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
