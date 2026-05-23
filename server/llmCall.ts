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
  LLM_BASE_URL,
  resolveChatRoute,
  resolveMode,
  toXAINativeModel,
  getLLMHeaders,
} from "./llmConfig.js";
import { getModel, resolveTask } from "./modelRouter.js";
import { callResponsesAPI } from "./responsesAdapter.js";
import { logRoute, inferTier } from "./routeLog.js";

const PERPLEXITY_CHAT_URL = process.env.PERPLEXITY_CHAT_URL ?? "https://api.perplexity.ai/chat/completions";

// PR #421 — Grok-direct reasoning timeout floor. See needsReasoningTimeoutFloor()
// + the call-site in postChatCompletions() for the rationale.
const REASONING_TIMEOUT_FLOOR_MS = 60_000;

/**
 * Returns true when the dispatched route is xAI-direct AND the model name
 * contains "reasoning" (case-insensitive). Used to bump the per-call timeout
 * floor for slow reasoning-tier calls without widening the timeout for
 * non-reasoning xai-direct or any OpenRouter route.
 *
 * Exported for unit tests; callers in production should not need to inspect
 * this directly.
 */
export function needsReasoningTimeoutFloor(route: { provider: string; model: string }): boolean {
  if (route.provider !== "xai-direct") return false;
  // Match "reasoning" but NOT "non-reasoning". xAI's model names use both —
  // e.g. grok-4.20-0309-reasoning vs grok-4.20-0309-non-reasoning. Only the
  // reasoning variants need the 60s floor; the non-reasoning ones complete
  // well within the caller's 20s budget.
  if (/non[- _]?reasoning/i.test(route.model)) return false;
  return /reasoning/i.test(route.model);
}

// PR #251 — xAI empty-body recovery (gated; default ON).
// Background: api.x.ai has been observed returning HTTP 200 OK with an
// empty assistant message (choices[0].message.content === "") on Grok 4.20
// non-reasoning. The route logs status=ok but the caller gets back a blank
// string and downstream content engines silently fail to publish.
//
// Recovery: when xai-direct returns an empty body on a 200, retry the same
// payload once. If still empty, fall back to the same model on OpenRouter
// (which has its own internal retry on the upstream xAI quirks). This
// trades a small latency hit on degraded windows for actually shipping
// content. Disable with XAI_EMPTY_BODY_FALLBACK=false to revert to the
// previous "hard-fail, no fallback" policy.
export function isXaiEmptyBodyFallbackEnabled(): boolean {
  return (process.env.XAI_EMPTY_BODY_FALLBACK ?? "true") !== "false";
}

function extractChatText(data: any): string {
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Make a chat/completions POST and parse the body. Returns the parsed JSON
 *  and the extracted assistant text. Throws on network errors and non-2xx
 *  responses. Used by both the primary call and the empty-body retry. */
async function postChatAndParse(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, any>,
  signal: AbortSignal,
): Promise<{ data: any; text: string; status: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    const err: any = new Error(`http ${res.status}: ${errBody.slice(0, 300)}`);
    err.status = res.status;
    err.body = errBody;
    throw err;
  }
  const data = await res.json();
  return { data, text: extractChatText(data), status: res.status };
}

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
  /** Optional task name for [LLM_ROUTE] observability + provider dispatch. */
  task?: string,
): Promise<Response> {
  // Task-driven dispatch: when a task is passed and the router resolves it to
  // Perplexity, route to api.perplexity.ai directly so live-research calls
  // don't try to use OpenRouter's key against Perplexity's endpoint (or, worse,
  // silently degrade to a Grok model that doesn't exist on OpenRouter).
  const taskTier = task ? resolveTask(task).tier : undefined;
  const taskProvider = task ? resolveTask(task).provider : undefined;

  if (taskProvider === "perplexity") {
    return postPerplexityChat(payload, signal, task!, taskTier);
  }

  const route = resolveChatRoute(payload.model);
  // Substitute the provider-native model name without mutating the caller's object.
  const outgoing = route.model === payload.model ? payload : { ...payload, model: route.model };

  // PR #421 — Grok-direct reasoning timeout floor. xAI's reasoning models
  // routinely take 30–50s for non-trivial prompts; many call sites still
  // pass AbortSignal.timeout(20_000) inherited from non-reasoning defaults,
  // which produced ~20 spurious aborts in yesterday's cycle (non-fatal —
  // empty-body fallback recovers them — but pollutes logs and degrades
  // quality). When the resolved route is xai-direct AND the dispatched
  // model name contains "reasoning" (case-insensitive), use a 60s floor
  // signal instead of the caller's. Narrow scope: non-reasoning xai-direct
  // calls keep their existing tighter timeout.
  const effectiveSignal = needsReasoningTimeoutFloor(route)
    ? AbortSignal.timeout(REASONING_TIMEOUT_FLOOR_MS)
    : signal;

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(route.url, {
      method: "POST",
      headers: route.headers,
      body: JSON.stringify(outgoing),
      signal: effectiveSignal,
    });
  } catch (err: any) {
    logRoute({
      task:      task ?? "post-chat-completions",
      tier:      taskTier ?? inferTier(route.model),
      provider:  route.provider,
      model:     route.model,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  `network: ${err?.message ?? String(err)}`,
    });
    throw err;
  }

  // ── PR #251: xAI empty-body recovery for the low-level helper. ───────────
  // The high-level callChatCompletions() has its own recovery; callers that
  // use postChatCompletions() directly (e.g. server/routes.ts news dispatch,
  // signalBriefEngine, dispatchEngine, articleEngine) need the same protection.
  // Strategy: when xai-direct returns 200 but choices[0].message.content is
  // empty, retry once same provider, then fall back to OpenRouter for the
  // OpenRouter-format model. We have to consume the response body to detect
  // the empty case, so on success we rebuild a fresh Response object that the
  // caller can .json()/.text() exactly as before. On non-2xx we leave the
  // Response untouched (the existing hard-fail policy still applies).
  if (
    res.ok &&
    route.provider === "xai-direct" &&
    isXaiEmptyBodyFallbackEnabled()
  ) {
    let bodyText = "";
    let parsed: any = null;
    try {
      bodyText = await res.text();
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // Body is not JSON — surface the raw response to the caller. Recovery
      // can't help here because we don't know if content was empty.
      logRoute({
        task:      task ?? "post-chat-completions",
        tier:      taskTier ?? inferTier(route.model),
        provider:  route.provider,
        model:     route.model,
        mode:      "chat",
        latencyMs: Date.now() - startedAt,
        status:    "ok",
      });
      return new Response(bodyText, { status: res.status, headers: res.headers });
    }

    const content = parsed?.choices?.[0]?.message?.content ?? "";
    if (content) {
      // Happy path — wrap the body back up and return. No recovery needed.
      logRoute({
        task:      task ?? "post-chat-completions",
        tier:      taskTier ?? inferTier(route.model),
        provider:  route.provider,
        model:     route.model,
        mode:      "chat",
        latencyMs: Date.now() - startedAt,
        status:    "ok",
      });
      return new Response(bodyText, { status: res.status, headers: res.headers });
    }

    // Empty content. Retry once same provider.
    console.warn(
      `[postChatCompletions] xAI empty body on task="${task ?? "?"}" model=${route.model} — retrying once same provider`,
    );
    let recovered: { body: string; provider: "xai-direct" | "openrouter"; model: string } | null = null;
    try {
      const retryRes = await fetch(route.url, {
        method: "POST",
        headers: route.headers,
        body: JSON.stringify(outgoing),
        signal: effectiveSignal,
      });
      if (retryRes.ok) {
        const retryText = await retryRes.text();
        const retryJson = retryText ? JSON.parse(retryText) : null;
        if (retryJson?.choices?.[0]?.message?.content) {
          recovered = { body: retryText, provider: "xai-direct", model: route.model };
        }
      }
    } catch (retryErr: any) {
      console.warn(
        `[postChatCompletions] xAI retry threw — falling through to OpenRouter:`,
        retryErr?.message ?? String(retryErr),
      );
    }

    if (!recovered) {
      // Fall back to OpenRouter for the original OpenRouter-format model.
      const orPayload = { ...outgoing, model: payload.model };
      const orHeaders = getLLMHeaders();
      console.warn(
        `[postChatCompletions] xAI empty persisted on task="${task ?? "?"}" — falling back to OpenRouter (model=${payload.model})`,
      );
      try {
        const fbRes = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: orHeaders,
          body: JSON.stringify(orPayload),
          signal,
        });
        if (fbRes.ok) {
          const fbText = await fbRes.text();
          const fbJson = fbText ? JSON.parse(fbText) : null;
          if (fbJson?.choices?.[0]?.message?.content) {
            recovered = { body: fbText, provider: "openrouter", model: payload.model };
          }
        }
      } catch (fbErr: any) {
        console.error(
          `[postChatCompletions] OpenRouter fallback also failed on task="${task ?? "?"}":`,
          fbErr?.message ?? String(fbErr),
        );
      }
    }

    if (recovered) {
      logRoute({
        task:      task ?? "post-chat-completions",
        tier:      taskTier ?? inferTier(recovered.model),
        provider:  recovered.provider,
        model:     recovered.model,
        mode:      "chat",
        latencyMs: Date.now() - startedAt,
        status:    "ok",
        errorMsg:  recovered.provider === "openrouter"
          ? "xai-empty-body recovered via OpenRouter fallback"
          : "xai-empty-body recovered after 1 retry",
      });
      return new Response(recovered.body, { status: 200, headers: { "content-type": "application/json" } });
    }

    // All recovery paths failed. Log and return the original empty-body response
    // so the caller's existing empty-content handling (e.g. the news dispatch's
    // market-data fallback line) still kicks in.
    logRoute({
      task:      task ?? "post-chat-completions",
      tier:      taskTier ?? inferTier(route.model),
      provider:  route.provider,
      model:     route.model,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  "xai-empty-body unrecoverable (retry + OpenRouter fallback both failed)",
    });
    return new Response(bodyText, { status: res.status, headers: res.headers });
  }

  logRoute({
    task:      task ?? "post-chat-completions",
    tier:      taskTier ?? inferTier(route.model),
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
 * Internal — dispatch a chat/completions payload to Perplexity.
 *
 * Used transparently by postChatCompletions() when the task resolves to the
 * live-research tier. Substitutes the payload's model with the configured
 * Perplexity model (default sonar-pro) and sends to api.perplexity.ai with
 * PERPLEXITY_API_KEY. No silent fallback on missing key — throws.
 */
async function postPerplexityChat(
  payload: { model: string; [k: string]: any },
  signal: AbortSignal | undefined,
  task: string,
  tier?: string,
): Promise<Response> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) {
    throw new Error(
      `postChatCompletions(task="${task}"): resolved to provider=perplexity but PERPLEXITY_API_KEY is not set.`,
    );
  }
  const pplxModel = resolveTask(task).model;
  const outgoing = { ...payload, model: pplxModel };

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(PERPLEXITY_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(outgoing),
      signal,
    });
  } catch (err: any) {
    logRoute({
      task,
      tier:      tier ?? "live-research",
      provider:  "perplexity",
      model:     pplxModel,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  `network: ${err?.message ?? String(err)}`,
    });
    throw err;
  }

  logRoute({
    task,
    tier:      tier ?? "live-research",
    provider:  "perplexity",
    model:     pplxModel,
    mode:      "chat",
    latencyMs: Date.now() - startedAt,
    status:    res.ok ? "ok" : "error",
    errorMsg:  res.ok ? undefined : `http ${res.status}`,
  });
  return res;
}

/**
 * postPerplexity — high-level helper for tasks that should hit Perplexity
 * (live-research tier). Thin wrapper around postPerplexityChat() with the
 * OpenAI-compatible {messages, max_tokens, temperature} shape callers expect.
 *
 * Hard-fails if the resolved provider for `task` is not "perplexity" — keeps
 * routing invariants visible at the call site.
 */
export async function postPerplexity(args: {
  task: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<Response> {
  const { task, messages, maxTokens, temperature, signal } = args;
  const resolved = resolveTask(task);
  if (resolved.provider !== "perplexity") {
    throw new Error(
      `postPerplexity(task="${task}"): routed to provider=${resolved.provider} (model=${resolved.model}); expected perplexity.`,
    );
  }
  const payload: Record<string, any> = {
    model: resolved.model,
    messages,
    stream: false,
  };
  if (typeof maxTokens === "number") payload.max_tokens = maxTokens;
  if (typeof temperature === "number") payload.temperature = temperature;
  return postPerplexityChat(payload as any, signal, task, resolved.tier);
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
  // Hard provider guard: x_search is an xAI-only tool. If this task resolved
  // to anything other than xai-direct (live-social / standard-voice /
  // frontier-factual / multi-agent), the caller has a routing bug — fail loud
  // rather than sending OpenRouter/Perplexity traffic to api.x.ai.
  const resolved = resolveTask(task);
  if (resolved.provider !== "xai-direct") {
    throw new Error(
      `postXSearchResponses requires xai-direct tier; task=${task} resolved to provider=${resolved.provider}`,
    );
  }
  const routedModel = resolved.model;
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
      tier:      resolved.tier,
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
    tier:      resolved.tier,
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

  // Router-tier-split PR: perplexity (live-research) must dispatch to
  // api.perplexity.ai, not OpenRouter / xAI. resolveChatRoute()'s decision is
  // about xai-vs-openrouter only; it has no notion of Perplexity. So if the
  // task routes to perplexity, hand off to postPerplexityChat() for the URL,
  // headers, and usage extraction.
  const taskResolved = resolveTask(opts.task);
  if (taskResolved.provider === "perplexity") {
    const payload: Record<string, any> = {
      model: taskResolved.model,
      messages,
      stream: false,
    };
    if (typeof opts.maxTokens === "number") payload.max_tokens = opts.maxTokens;
    if (typeof opts.temperature === "number") payload.temperature = opts.temperature;

    const res = await postPerplexityChat(payload as any, AbortSignal.timeout(timeoutMs), opts.task, taskResolved.tier);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `Chat Completions ${res.status} (perplexity, model=${taskResolved.model}): ${errBody.slice(0, 300)}`,
      );
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: taskResolved.model,
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

  let primaryResult: { data: any; text: string; status: number };
  try {
    primaryResult = await postChatAndParse(
      route.url,
      route.headers,
      payload,
      AbortSignal.timeout(timeoutMs),
    );
  } catch (err: any) {
    // Network / timeout / non-2xx failure — emit observability and re-throw.
    logRoute({
      task:      opts.task,
      tier:      resolveTask(opts.task).tier,
      provider:  route.provider,
      model:     route.model,
      mode:      "chat",
      latencyMs: Date.now() - startedAt,
      status:    "error",
      errorMsg:  err?.status ? `http ${err.status}: ${(err.body ?? "").slice(0, 80)}` : `network: ${err?.message ?? String(err)}`,
    });
    // Hard-fail on non-2xx: no fallback to OpenRouter on xAI errors — matches
    // the user's explicit "no auto-retry" policy for xAI HTTP errors. Empty-body
    // recovery (PR #251) is handled separately below for the 200-OK-but-blank case.
    if (err?.status) {
      throw new Error(
        `Chat Completions ${err.status} (${route.provider}, model=${route.model}): ${(err.body ?? "").slice(0, 300)}`,
      );
    }
    throw err;
  }

  // ── PR #251: xAI empty-body recovery ────────────────────────────────────
  // api.x.ai has been observed returning 200 OK with no assistant content.
  // routeLog shows status=ok but downstream engines silently fail to publish
  // (see Apr 29 morning incident: manual 12:37 PM Signal/News failures).
  // Strategy: retry once same provider, then fall back to OpenRouter for the
  // same model. Only kicks in for xai-direct routes; OpenRouter is left alone.
  let finalRoute = route;
  let data = primaryResult.data;
  let text = primaryResult.text;
  let recoveryNote: string | undefined;

  if (
    !text &&
    route.provider === "xai-direct" &&
    isXaiEmptyBodyFallbackEnabled()
  ) {
    console.warn(
      `[callLLM] xAI empty body on task="${opts.task}" model=${route.model} — retrying once same provider`,
    );
    try {
      const retry = await postChatAndParse(
        route.url,
        route.headers,
        payload,
        AbortSignal.timeout(timeoutMs),
      );
      if (retry.text) {
        data = retry.data;
        text = retry.text;
        recoveryNote = "xai-empty-body recovered after 1 retry";
      }
    } catch (retryErr: any) {
      console.warn(
        `[callLLM] xAI empty-body retry threw — falling through to OpenRouter:`,
        retryErr?.message ?? String(retryErr),
      );
    }

    if (!text) {
      // Second retry failed (or also empty). Fall back to OpenRouter for the
      // same OpenRouter-format model. OpenRouter applies its own upstream
      // retry/route logic for xAI quirks, so this is the highest-uptime path.
      const orPayload: Record<string, any> = { ...payload, model };
      const orHeaders = getLLMHeaders();
      console.warn(
        `[callLLM] xAI empty body persisted on task="${opts.task}" — falling back to OpenRouter (model=${model})`,
      );
      try {
        const fb = await postChatAndParse(
          LLM_BASE_URL,
          orHeaders,
          orPayload,
          AbortSignal.timeout(timeoutMs),
        );
        if (fb.text) {
          finalRoute = { url: LLM_BASE_URL, headers: orHeaders, model, provider: "openrouter" };
          data = fb.data;
          text = fb.text;
          recoveryNote = "xai-empty-body recovered via OpenRouter fallback";
        }
      } catch (fbErr: any) {
        // Fallback also failed. Surface the original empty-body condition so
        // the caller decides what to do (the prior behavior was to return "").
        console.error(
          `[callLLM] OpenRouter fallback also failed on task="${opts.task}":`,
          fbErr?.message ?? String(fbErr),
        );
      }
    }
  }

  logRoute({
    task:      opts.task,
    tier:      inferTier(finalRoute.model),
    provider:  finalRoute.provider,
    model:     finalRoute.model,
    mode:      "chat",
    tokensIn:  data?.usage?.prompt_tokens,
    tokensOut: data?.usage?.completion_tokens,
    latencyMs: Date.now() - startedAt,
    status:    "ok",
    errorMsg:  recoveryNote,
  });

  return {
    text,
    // Report back the original OpenRouter-format name so callers/logs stay stable.
    model,
    rawResponse: data,
    mode: "chat",
    usage: data?.usage
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
