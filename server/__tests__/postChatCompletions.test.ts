/**
 * postChatCompletions \u2014 PR P low-level helper for migrated raw-fetch sites.
 *
 * Verifies:
 *   - Grok models route to api.x.ai/v1/chat/completions with the xAI-direct key
 *     and the OpenRouter-prefix is stripped from the model name.
 *   - Non-Grok models stay on OpenRouter with OPENROUTER_API_KEY.
 *   - The caller's payload object is NOT mutated.
 *   - A passed AbortSignal is forwarded to fetch.
 *   - When XAI_DIRECT_CHAT_ENABLED=false, even Grok models fall back to OpenRouter.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "XAI_DIRECT_CHAT_ENABLED",
  "GROK_API_KEY",
  "OPENROUTER_API_KEY",
  "LLM_BASE_URL",
  "XAI_DIRECT_BASE_URL",
];

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Use real-looking keys so getXAIDirectHeaders / getLLMHeaders don't bail.
  process.env.GROK_API_KEY = "test-xai-key";
  process.env.OPENROUTER_API_KEY = "test-or-key";
  delete process.env.LLM_BASE_URL;
  delete process.env.XAI_DIRECT_BASE_URL;
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const originalFetch = globalThis.fetch;
function stubFetch(): { calls: { url: string; init: any }[]; restore: () => void } {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
    } as any;
  }) as any;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const { postChatCompletions } = await import("../llmCall.js");

describe("postChatCompletions \u2014 routing", () => {
  it("routes Grok models to api.x.ai/v1/chat/completions with xAI key + native model name", async () => {
    process.env.XAI_DIRECT_CHAT_ENABLED = "true";
    const { calls, restore } = stubFetch();
    try {
      const payload = { model: "x-ai/grok-4-fast-non-reasoning", messages: [{ role: "user", content: "ping" }] };
      await postChatCompletions(payload);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://api.x.ai/v1/chat/completions");
      const sentBody = JSON.parse(calls[0].init.body);
      assert.equal(sentBody.model, "grok-4-fast-non-reasoning", "x-ai/ prefix must be stripped for api.x.ai");
      assert.equal(calls[0].init.headers["Authorization"], "Bearer test-xai-key");
      // Original payload object NOT mutated:
      assert.equal(payload.model, "x-ai/grok-4-fast-non-reasoning");
    } finally {
      restore();
    }
  });

  it("keeps non-Grok models on OpenRouter with the original model name", async () => {
    process.env.XAI_DIRECT_CHAT_ENABLED = "true";
    const { calls, restore } = stubFetch();
    try {
      const payload = { model: "anthropic/claude-sonnet-4.5", messages: [{ role: "user", content: "ping" }] };
      await postChatCompletions(payload);
      assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
      const sentBody = JSON.parse(calls[0].init.body);
      assert.equal(sentBody.model, "anthropic/claude-sonnet-4.5");
      assert.equal(calls[0].init.headers["Authorization"], "Bearer test-or-key");
    } finally {
      restore();
    }
  });

  it("falls back to OpenRouter for Grok when XAI_DIRECT_CHAT_ENABLED=false", async () => {
    process.env.XAI_DIRECT_CHAT_ENABLED = "false";
    const { calls, restore } = stubFetch();
    try {
      const payload = { model: "x-ai/grok-4-fast-non-reasoning", messages: [{ role: "user", content: "ping" }] };
      await postChatCompletions(payload);
      assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
      const sentBody = JSON.parse(calls[0].init.body);
      // OpenRouter path \u2014 keep the OpenRouter-prefixed name.
      assert.equal(sentBody.model, "x-ai/grok-4-fast-non-reasoning");
    } finally {
      restore();
      process.env.XAI_DIRECT_CHAT_ENABLED = "true";
    }
  });

  it("forwards the AbortSignal to fetch", async () => {
    process.env.XAI_DIRECT_CHAT_ENABLED = "true";
    const { calls, restore } = stubFetch();
    try {
      const ctrl = new AbortController();
      await postChatCompletions(
        { model: "x-ai/grok-4-fast-non-reasoning", messages: [] },
        ctrl.signal,
      );
      assert.equal(calls[0].init.signal, ctrl.signal);
    } finally {
      restore();
    }
  });

  it("preserves arbitrary payload fields verbatim (temperature, max_tokens, response_format, etc.)", async () => {
    process.env.XAI_DIRECT_CHAT_ENABLED = "true";
    const { calls, restore } = stubFetch();
    try {
      const payload = {
        model: "x-ai/grok-4-fast-non-reasoning",
        messages: [{ role: "user", content: "ping" }],
        temperature: 0.42,
        max_tokens: 1234,
        response_format: { type: "json_object" },
        custom_field: { nested: ["a", "b"] },
      };
      await postChatCompletions(payload);
      const sentBody = JSON.parse(calls[0].init.body);
      assert.equal(sentBody.temperature, 0.42);
      assert.equal(sentBody.max_tokens, 1234);
      assert.deepEqual(sentBody.response_format, { type: "json_object" });
      assert.deepEqual(sentBody.custom_field, { nested: ["a", "b"] });
    } finally {
      restore();
    }
  });
});
