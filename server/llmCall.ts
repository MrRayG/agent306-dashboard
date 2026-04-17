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
import { logRoute, inferTier } from "./routeLog.js";

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
  /** Optional task name for [LLM_ROUTE] observability. Pass whenever available. */
  task?: string,
): Promise<Response> {
  const route = resolveChatRoute(payload.model);
  // Substitute the provider-native model name without mutating the caller's object.
  const outgoing = route.model === payload.model ? payload : { ...payload, model: route.model };

  // PR #2: observability at the low-level helper layer so raw-fetch migration
  // sites (PR #3) get instrumented automatically once they switch to this helper.
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(route.url, {
      method: "POST",
      headers: route.headers,
      body: JSON.stringify(outgoing),
      signal,
    });
  } catch (err: any) {
    logRoute({
      task:      task ?? "post-chat-completions",
      tier:      inferTier(route.model),
      provider:  route.provider,
      model:     route.model,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  `network: ${err?.message ?? String(err)}`,
    });
    throw err;
  }

  // Log route outcome based on HTTP status. Caller still owns body parsing
  // and usage extraction, so tokens_in/out are unavailable here — that's fine,
  // they'll be "-" in the log line. Engines that want token counts can use
  // callLLM() instead.
  logRoute({
    task:      task ?? "post-chat-completions",
    tier:      inferTier(route.model),
    provider:  route.provider,
    model:     route.model,
    mode:      "chat",
    latencyMs: Date.now() - startedAt,
    status:    res.ok ? "ok" : "error",
    errorMsg:  res.ok ? undefined : `http ${res.status}`,
  });

  return res;
}

/**
 * postXSearchResponses — PR Q helper for migrating raw Grok x_search
 * `fetch("https://api.x.ai/v1/responses", ...)` call sites off hardcoded
 * model names and onto modelRouter + GROK_API_KEY routing.
 *
 * Centralizes all xAI Responses API calls that use the x_search tool so that:
 *   - The model comes from getModel(task) → toXAINativeModel() (no hardcoding).
 *   - GROK_API_KEY is the single source of auth. Missing key → throw, no silent fallback.
 *   - URL can still be overridden via GROK_RESPONSES_URL for testing.
 *
 * Returns the raw Response so callers keep ownership of status checks, .text()
 * error logging, and custom timeout handling. The caller decides what to do
 * with non-ok responses — this helper does not throw on HTTP errors, only on
 * missing API key or a non-xAI routed model (which would indicate misconfig).
 *
 * Pass an existing AbortSignal (typically AbortSignal.timeout(N)) through
 * unchanged so per-engine timeouts are preserved.
 */
export async function postXSearchResponses(args: {
  task: string;
  content: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const { task, content, signal } = args;
  const nativeGrokKey = process.env.GROK_API_KEY;
  if (!nativeGrokKey) {
    throw new Error(
      `postXSearchResponses(task="${task}"): GROK_API_KEY is not set. x_search requires a native xAI key — no silent fallback.`,
    );
  }
  const routedModel = getModel(task);
  const xaiModel = toXAINativeModel(routedModel);
  if (xaiModel === null) {
    throw new Error(
      `postXSearchResponses(task="${task}"): routed model "${routedModel}" is not xAI-hosted. x_search requires an xAI model.`,
    );
  }
  const url = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${nativeGrokKey}`,
      },
      body: JSON.stringify({
        model: xaiModel,
        stream: false,
        input: [{ role: "user", content }],
        tools: [{ type: "x_search" }],
      }),
      signal,
    });
  } catch (err: any) {
    logRoute({
      task,
      tier:      inferTier(xaiModel),
      provider:  "xai-direct",
      model:     xaiModel,
      mode:      "responses",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  `network: ${err?.message ?? String(err)}`,
    });
    throw err;
  }

  logRoute({
    task,
    tier:      inferTier(xaiModel),
    provider:  "xai-direct",
    model:     xaiModel,
    mode:      "responses",
    latencyMs: Date.now() - startedAt,
    status:    res.ok ? "ok" : "error",
    errorMsg:  res.ok ? undefined : `http ${res.status}`,
  });

  return res;
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

  // PR #2: per-call routing observability.
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(route.url, {
      method: "POST",
      headers: route.headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    // Network / timeout failure — still emit an observability entry.
    logRoute({
      task:      opts.task,
      tier:      inferTier(route.model),
      provider:  route.provider,
      model:     route.model,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  `network: ${err?.message ?? String(err)}`,
    });
    throw err;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    logRoute({
      task:      opts.task,
      tier:      inferTier(route.model),
      provider:  route.provider,
      model:     route.model,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  `http ${res.status}: ${errBody.slice(0, 80)}`,
    });
    // Hard-fail: no fallback to OpenRouter on xAI errors — matches the user's
    // explicit "no auto-retry" policy for xAI overrides.
    throw new Error(
      `Chat Completions ${res.status} (${route.provider}, model=${route.model}): ${errBody.slice(0, 300)}`,
    );
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";

  logRoute({
    task:      opts.task,
    tier:      inferTier(route.model),
    provider:  route.provider,
    model:     route.model,
    mode:      "chat",
    tokensIn:  data.usage?.prompt_tokens,
    tokensOut: data.usage?.completion_tokens,
    latencyMs: Date.now() - startedAt,
    status:    "ok",
  });

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
