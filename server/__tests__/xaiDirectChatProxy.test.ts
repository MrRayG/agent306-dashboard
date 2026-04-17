/**
 * Tests for the PR O transparent Grok → xAI-direct chat completions proxy.
 *
 * Verifies that:
 *   1. Grok (x-ai/*) models route to api.x.ai with XAI_DIRECT_API_KEY and the
 *      native (prefix-stripped) model name.
 *   2. Non-Grok models (Anthropic, Google, etc.) stay on OpenRouter unchanged.
 *   3. XAI_DIRECT_CHAT_ENABLED=false disables the proxy globally.
 *   4. Missing XAI_DIRECT_API_KEY falls back to OpenRouter (prevents
 *      bearer-less requests from 401ing at xAI).
 *   5. xAI errors are hard-failed with no OpenRouter fallback, matching the
 *      user's "no auto-retry" policy for xAI overrides.
 *
 * Run: node --test --import tsx server/__tests__/xaiDirectChatProxy.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

function makeChatResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => "",
  };
}

function makeErrorResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

// Snapshot env vars we mutate so tests don't bleed into each other.
const ENV_KEYS = [
  "XAI_DIRECT_CHAT_ENABLED",
  "GROK_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_DIRECT_BASE_URL",
  "LLM_BASE_URL",
  "MODEL_ROUTINE",
  "MODEL_STANDARD",
  "MODEL_PREMIUM",
  "MODEL_FRONTIER",
  "MODEL_MULTI_AGENT",
  "RESPONSES_API_ENABLED_TASKS",
  "RESPONSES_API_FALLBACK",
] as const;

function snapshotEnv() {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("resolveChatRoute (PR O)", () => {
  let snap: Record<string, string | undefined>;
  beforeEach(() => {
    snap = snapshotEnv();
    // Clean slate — tests set what they need.
    delete process.env.XAI_DIRECT_CHAT_ENABLED;
    delete process.env.GROK_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XAI_DIRECT_BASE_URL;
    delete process.env.LLM_BASE_URL;
  });
  afterEach(() => restoreEnv(snap));

  it("routes Grok (x-ai/*) models to api.x.ai with native model name", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("x-ai/grok-4.20");
    assert.equal(route.provider, "xai-direct");
    assert.equal(route.url, "https://api.x.ai/v1/chat/completions");
    assert.equal(route.model, "grok-4-1-fast-non-reasoning"); // translated via toXAINativeModel mapping
    assert.equal(route.headers.Authorization, "Bearer xai-testkey-123");
  });

  it("strips x-ai/ prefix for unmapped Grok models", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("x-ai/grok-4-fast-non-reasoning");
    assert.equal(route.provider, "xai-direct");
    assert.equal(route.model, "grok-4-fast-non-reasoning");
  });

  it("leaves non-Grok models (Anthropic) on OpenRouter", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    process.env.OPENROUTER_API_KEY = "or-testkey-456";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("anthropic/claude-opus-4.6");
    assert.equal(route.provider, "openrouter");
    assert.equal(route.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(route.model, "anthropic/claude-opus-4.6");
    assert.equal(route.headers.Authorization, "Bearer or-testkey-456");
  });

  it("leaves non-Grok models (Google) on OpenRouter", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    process.env.OPENROUTER_API_KEY = "or-testkey-456";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("google/gemini-3-flash-preview");
    assert.equal(route.provider, "openrouter");
    assert.equal(route.model, "google/gemini-3-flash-preview");
  });

  it("XAI_DIRECT_CHAT_ENABLED=false forces OpenRouter even for Grok models", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    process.env.XAI_DIRECT_CHAT_ENABLED = "false";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("x-ai/grok-4.20");
    assert.equal(route.provider, "openrouter");
    assert.equal(route.model, "x-ai/grok-4.20"); // untranslated
  });

  it("defaults XAI_DIRECT_CHAT_ENABLED to true (unset env)", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    delete process.env.XAI_DIRECT_CHAT_ENABLED;
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("x-ai/grok-4.20");
    assert.equal(route.provider, "xai-direct");
  });

  it("falls back to OpenRouter when XAI_DIRECT_API_KEY is empty", async () => {
    delete process.env.GROK_API_KEY;
    process.env.OPENROUTER_API_KEY = "or-testkey-456";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("x-ai/grok-4.20");
    // No xAI key → must not silently issue a Bearer-less xAI request.
    assert.equal(route.provider, "openrouter");
  });

  it("honors XAI_DIRECT_BASE_URL override", async () => {
    process.env.GROK_API_KEY = "xai-testkey-123";
    process.env.XAI_DIRECT_BASE_URL = "https://mock.xai.local/v1/";
    const { resolveChatRoute } = await import(`../llmConfig.js?t=${Date.now()}`);
    const route = resolveChatRoute("x-ai/grok-4.20");
    assert.equal(route.url, "https://mock.xai.local/v1/chat/completions");
  });
});

describe("callChatCompletions wire-level behavior (PR O)", () => {
  let originalFetch: typeof globalThis.fetch;
  let snap: Record<string, string | undefined>;

  beforeEach(() => {
    snap = snapshotEnv();
    originalFetch = globalThis.fetch;
    // Use a fixed, well-known model name so we don't depend on modelRouter.
    delete process.env.XAI_DIRECT_CHAT_ENABLED;
    delete process.env.RESPONSES_API_ENABLED_TASKS;
    process.env.GROK_API_KEY = "xai-testkey-123";
    process.env.OPENROUTER_API_KEY = "or-testkey-456";
    // Pin all tiers to known models so getModel() is deterministic.
    process.env.MODEL_STANDARD = "x-ai/grok-4.20";
    process.env.MODEL_ROUTINE = "google/gemini-3-flash-preview";
    process.env.MODEL_FRONTIER = "anthropic/claude-opus-4.6";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv(snap);
  });

  it("posts Grok tasks to api.x.ai with the native model name and xAI key", async () => {
    const fetchMock = mock.fn(async () => makeChatResponse("grok reply") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "self-debate", // standard → x-ai/grok-4.20
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.text, "grok reply");
    assert.equal(fetchMock.mock.callCount(), 1);

    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, "https://api.x.ai/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer xai-testkey-123");
    const body = JSON.parse(init.body as string);
    // Native name (prefix stripped + mapped) — NOT "x-ai/grok-4.20".
    assert.equal(body.model, "grok-4-1-fast-non-reasoning");
    // Caller-facing model stays in OpenRouter format for log stability.
    assert.equal(out.model, "x-ai/grok-4.20");
  });

  it("posts non-Grok tasks to OpenRouter with the OpenRouter key", async () => {
    const fetchMock = mock.fn(async () => makeChatResponse("claude reply") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "hypothesis-evaluation", // frontier → anthropic/claude-opus-4.6
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.text, "claude reply");
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer or-testkey-456");
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, "anthropic/claude-opus-4.6");
  });

  it("hard-fails when xAI returns 403 — no fallback to OpenRouter", async () => {
    let call = 0;
    const fetchMock = mock.fn(async () => {
      call += 1;
      return makeErrorResponse(
        403,
        '{"code":"The caller does not have permission","error":"Team is not authorized"}',
      ) as any;
    });
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    await assert.rejects(
      () =>
        callLLM({
          task: "self-debate", // standard → x-ai/grok-4.20 → xAI direct
          messages: [{ role: "user", content: "hi" }],
        }),
      /403.*xai-direct/,
    );
    // Exactly one call — proves no silent OpenRouter fallback happened.
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(call, 1);
  });

  it("XAI_DIRECT_CHAT_ENABLED=false reverts Grok calls to OpenRouter", async () => {
    process.env.XAI_DIRECT_CHAT_ENABLED = "false";

    const fetchMock = mock.fn(async () => makeChatResponse("fallback reply") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    await callLLM({
      task: "self-debate",
      messages: [{ role: "user", content: "hi" }],
    });

    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    // Kill-switch preserves OpenRouter-format model name.
    assert.equal(body.model, "x-ai/grok-4.20");
  });
});
