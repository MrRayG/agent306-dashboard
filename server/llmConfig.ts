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
