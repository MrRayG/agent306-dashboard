/**
 * callLLM() — unified wrapper over chat/completions and Responses API.
 *
 * Routes based on resolveMode(task); falls back to chat on Responses errors
 * when RESPONSES_API_FALLBACK is not explicitly disabled.
 *
 * Zero behavior change for existing callers — nothing calls this yet.
 */

import {
  LLMCallOptions,
  LLMResponse,
  LLM_TIMEOUTS,
  resolveChatRoute,
  resolveMode,
  toXAINativeModel,
} from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { callResponsesAPI } from "./responsesAdapter.js";

/**
 * postChatCompletions — PR P low-level helper for migrating raw
 * `fetch(LLM_BASE_URL, ...)` call sites to the same xAI-direct routing
 * the high-level callLLM() uses.
 *
 * Drop-in replacement preserving the caller's payload, error handling, and
 * response parsing. The ONLY thing this helper changes is which URL/headers
 * the request lands on:
 *   - Grok models   → https://api.x.ai/v1/chat/completions (direct)
 *   - Everything else → OpenRouter
 *
 * Routing is decided by resolveChatRoute() based on payload.model. The
 * provider-native model name is substituted into the outgoing payload so
 * api.x.ai sees "grok-4-fast-non-reasoning" instead of "x-ai/grok-4-fast...".
 *
 * The caller's `payload` object is NOT mutated.
 *
 * Returns the raw Response so callers keep ownership of:
 *   - status / .ok checks (and any custom error logging)
 *   - .json() vs .text() body parsing
 *   - usage extraction from the parsed body
 *
 * Pass an existing AbortSignal (typically AbortSignal.timeout(N)) through
 * unchanged so per-engine timeouts are preserved.
 *
 * Hard-fail policy: no auto-retry, no fallback to OpenRouter on xAI errors
 * — matches the user's explicit policy for xAI overrides.
 */
export async function postChatCompletions(
  payload: { model: string; [k: string]: any },
  signal?: AbortSignal,
): Promise<Response> {
  const route = resolveChatRoute(payload.model);
  // Substitute the provider-native model name without mutating the caller's object.
  const outgoing = route.model === payload.model ? payload : { ...payload, model: route.model };
  return fetch(route.url, {
    method: "POST",
    headers: route.headers,
    body: JSON.stringify(outgoing),
    signal,
  });
}

export async function callChatCompletions(opts: LLMCallOptions, model: string): Promise<LLMResponse> {
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUTS.default;
  const messages = opts.messages ?? opts.input ?? [];

  // PR O: Grok models go to api.x.ai direct, everything else to OpenRouter.
  const route = resolveChatRoute(model);

  const payload: Record<string, any> = {
    model: route.model,
    messages,
    stream: false,
  };
  if (typeof opts.maxTokens === "number") payload.max_tokens = opts.maxTokens;
  if (typeof opts.temperature === "number") payload.temperature = opts.temperature;

  const res = await fetch(route.url, {
    method: "POST",
    headers: route.headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    // Hard-fail: no fallback to OpenRouter on xAI errors — matches the user's
    // explicit "no auto-retry" policy for xAI overrides.
    throw new Error(
      `Chat Completions ${res.status} (${route.provider}, model=${route.model}): ${errBody.slice(0, 300)}`,
    );
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";

  return {
    text,
    // Report back the original OpenRouter-format name so callers/logs stay stable.
    model,
    rawResponse: data,
    mode: "chat",
    usage: data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

export async function callLLM(opts: LLMCallOptions): Promise<LLMResponse> {
  const mode = opts.mode ?? resolveMode(opts.task);
  const model = getModel(opts.task);

  if (mode === "chat") {
    return callChatCompletions(opts, model);
  }

  // mode === "responses" — verify the model can actually use xAI Responses API.
  // Non-xAI models (Anthropic, Google, etc.) silently downgrade to chat/completions.
  const xaiModel = toXAINativeModel(model);
  if (xaiModel === null) {
    return callChatCompletions(opts, model);
  }

  try {
    return await callResponsesAPI(opts, xaiModel);
  } catch (err: any) {
    const fallbackEnabled = (process.env.RESPONSES_API_FALLBACK ?? "true") !== "false";
    if (!fallbackEnabled) throw err;
    console.warn(
      `[callLLM] Responses API failed for task="${opts.task}" — falling back to chat completions:`,
      err?.message ?? err,
    );
    return callChatCompletions(opts, model);
  }
}
