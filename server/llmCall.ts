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
