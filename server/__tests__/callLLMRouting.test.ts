/**
 * Tests for callLLM routing behavior with model translation and non-xAI downgrade.
 *
 * Run: npx tsx --test server/__tests__/callLLMRouting.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

function chatOk(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    text: async () => "",
  };
}

function responsesOk(text: string, id = "resp_1") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
    text: async () => "",
  };
}

function httpError(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  };
}

describe("callLLM — Responses API model translation + non-xAI downgrade", () => {
  let originalFetch: typeof globalThis.fetch;
  const savedEnabled = process.env.RESPONSES_API_ENABLED_TASKS;
  const savedFallback = process.env.RESPONSES_API_FALLBACK;
  const savedModelStd = process.env.MODEL_STANDARD_VOICE;
  const savedModelFrontFactual = process.env.MODEL_FRONTIER_FACTUAL;
  const savedModelFrontReasoning = process.env.MODEL_FRONTIER_REASONING;
  const savedModelRoutine = process.env.MODEL_ROUTINE;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("RESPONSES_API_ENABLED_TASKS", savedEnabled);
    restore("RESPONSES_API_FALLBACK", savedFallback);
    restore("MODEL_STANDARD_VOICE", savedModelStd);
    restore("MODEL_FRONTIER_FACTUAL", savedModelFrontFactual);
    restore("MODEL_FRONTIER_REASONING", savedModelFrontReasoning);
    restore("MODEL_ROUTINE", savedModelRoutine);
  });

  it("translates xAI OpenRouter model to native name when calling Responses API", async () => {
    // self-debate is a standard-voice task → default x-ai/grok-4.20-non-reasoning,
    // which toXAINativeModel() translates to grok-4.20-0309-non-reasoning before
    // dispatch to the Responses API.
    process.env.RESPONSES_API_ENABLED_TASKS = "self-debate";

    const fetchMock = mock.fn(async () => responsesOk("ok") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    await callLLM({
      task: "self-debate",
      input: [{ role: "user", content: "hi" }],
    });

    assert.equal(fetchMock.mock.callCount(), 1);
    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(url.includes("/responses"), "should call Responses endpoint");
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.model, "grok-4.20-0309-non-reasoning", "model should be xAI-native, not OpenRouter-prefixed");
  });

  it("silently auto-downgrades Anthropic model to chat/completions (does not call Responses API)", async () => {
    // `blog` is a premium-voice task which defaults to anthropic/claude-sonnet-4.6 —
    // exercises the non-xAI Responses-downgrade path without env overrides (TIER_MAP
    // is module-init scoped post-PR-#288, so per-test env mutation is unreliable).
    process.env.RESPONSES_API_ENABLED_TASKS = "blog";

    const fetchMock = mock.fn(async () => chatOk("reply") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "blog",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.mode, "chat", "non-xAI models should route through chat/completions");
    assert.equal(fetchMock.mock.callCount(), 1, "exactly one HTTP call — no Responses attempt");
    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(!url.includes("/responses"), "should NOT call Responses endpoint for non-xAI");
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.model, "anthropic/claude-sonnet-4.6", "chat/completions uses OpenRouter-format name");
  });

  it("silently auto-downgrades Google model to chat/completions", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "reflection";
    process.env.MODEL_ROUTINE = "google/gemini-3-flash-preview";

    const fetchMock = mock.fn(async () => chatOk("reply") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "reflection",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.mode, "chat");
    assert.equal(fetchMock.mock.callCount(), 1);
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.model, "google/gemini-3-flash-preview");
  });

  it("falls back to chat/completions with ORIGINAL OpenRouter model name when Responses API errors", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "self-debate";
    process.env.RESPONSES_API_FALLBACK = "true";

    let call = 0;
    const fetchMock = mock.fn(async () => {
      call += 1;
      if (call === 1) return httpError(500, "boom") as any;
      return chatOk("fallback reply") as any;
    });
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "self-debate",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.mode, "chat");
    assert.equal(out.text, "fallback reply");
    assert.equal(fetchMock.mock.callCount(), 2);

    // First call: Responses API with translated model (xAI-native, post PR #287)
    const body1 = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body1.model, "grok-4.20-0309-non-reasoning", "first (Responses) call uses xAI-native name");

    // Second call: chat/completions with ORIGINAL OpenRouter model (the default
    // for the standard-voice tier).
    const body2 = JSON.parse(fetchMock.mock.calls[1].arguments[1].body);
    assert.equal(body2.model, "x-ai/grok-4.20-non-reasoning", "fallback uses original OpenRouter-format name");
  });
});
