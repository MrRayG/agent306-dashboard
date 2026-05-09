/**
 * Integration tests for conversationLearningEngine.ts callLLM migration.
 *
 * Run: npx tsx --test server/__tests__/conversationLearningEngineMigration.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

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

describe("conversationLearningEngine callLLM migration", () => {
  let originalFetch: typeof globalThis.fetch;
  let savedOpenRouterKey: string | undefined;
  const savedEnabled = process.env.RESPONSES_API_ENABLED_TASKS;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = savedOpenRouterKey ?? "test-key";
    delete process.env.RESPONSES_API_ENABLED_TASKS;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    if (savedEnabled === undefined) delete process.env.RESPONSES_API_ENABLED_TASKS;
    else process.env.RESPONSES_API_ENABLED_TASKS = savedEnabled;
  });

  it("engine module loads and no direct fetch/getLLMHeaders remain in source", async () => {
    const src = fs.readFileSync("server/conversationLearningEngine.ts", "utf8");
    assert.ok(!/\bGROK_URL\b/.test(src), "GROK_URL should be removed");
    assert.ok(!/fetch\s*\(/.test(src), "no direct fetch() calls should remain");
    assert.ok(!/getLLMHeaders\s*\(/.test(src), "getLLMHeaders() call should be removed");
    assert.ok(/callLLM\s*\(/.test(src), "callLLM() should be used");
    assert.ok(/"conversation-insight"/.test(src), "task name should be canonical hyphenated form");

    const mod: any = await import(`../conversationLearningEngine.js?t=${Date.now()}`);
    assert.ok(mod, "module loads");
  });

  it("callLLM uses conversation-insight task and default mode is chat", async () => {
    const fetchMock = mock.fn(async () => chatOk(JSON.stringify({ insight: "hi" })) as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "conversation-insight",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      maxTokens: 2000,
      temperature: 0.3,
      timeoutMs: 40000,
    });

    assert.equal(out.mode, "chat");
    assert.equal(fetchMock.mock.callCount(), 1);
    const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.max_tokens, 2000);
  });

  it("conversation-insight is opt-in for the Responses API but downgrades to chat for non-xAI models", async () => {
    // conversation-insight is a routine-tier task → google/gemini-3-flash-preview
    // by default. Non-xAI models silently downgrade to chat/completions even
    // when RESPONSES_API_ENABLED_TASKS lists the task — that is the documented
    // safety hatch, not a bug. (The original test asserted mode==='responses'
    // back when the task lived in the xAI standard tier.)
    process.env.RESPONSES_API_ENABLED_TASKS = "conversation-insight";
    const fetchMock = mock.fn(async () => chatOk(JSON.stringify({ insight: "yes" })) as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "conversation-insight",
      messages: [{ role: "user", content: "x" }],
      timeoutMs: 40000,
    });

    assert.equal(out.mode, "chat");
    const calledUrl = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(!calledUrl.includes("/responses"), "non-xAI routine model must NOT hit /responses");
  });
});
