/**
 * Tests for callLLM abstraction layer.
 *
 * Run: npx tsx --test server/__tests__/llmCall.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const CHAIN_FILE = dataPath("response_chains.json");

function cleanChain() {
  try { if (fs.existsSync(CHAIN_FILE)) fs.unlinkSync(CHAIN_FILE); } catch {}
}

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

function makeResponsesResponse(text: string, id = "resp_123") {
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
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
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

describe("resolveMode", () => {
  const savedEnv = process.env.RESPONSES_API_ENABLED_TASKS;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RESPONSES_API_ENABLED_TASKS;
    else process.env.RESPONSES_API_ENABLED_TASKS = savedEnv;
  });

  it("returns 'chat' when env var is unset", async () => {
    delete process.env.RESPONSES_API_ENABLED_TASKS;
    const { resolveMode } = await import(`../llmConfig.js?t=${Date.now()}`);
    assert.equal(resolveMode("hypothesis-evaluation"), "chat");
  });

  it("returns 'chat' when env var is empty string", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "";
    const { resolveMode } = await import(`../llmConfig.js?t=${Date.now()}`);
    assert.equal(resolveMode("hypothesis-evaluation"), "chat");
  });

  it("returns 'responses' when task is in enabled list", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "hypothesis-evaluation,conversation-insights";
    const { resolveMode } = await import(`../llmConfig.js?t=${Date.now()}`);
    assert.equal(resolveMode("hypothesis-evaluation"), "responses");
    assert.equal(resolveMode("conversation-insights"), "responses");
    assert.equal(resolveMode("unrelated-task"), "chat");
  });

  it("normalizes underscores to hyphens", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "hypothesis-evaluation";
    const { resolveMode } = await import(`../llmConfig.js?t=${Date.now()}`);
    assert.equal(resolveMode("hypothesis_evaluation"), "responses");
  });

  it("handles whitespace and underscores in env list", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = " hypothesis_evaluation , conversation-insights ";
    const { resolveMode } = await import(`../llmConfig.js?t=${Date.now()}`);
    assert.equal(resolveMode("hypothesis-evaluation"), "responses");
    assert.equal(resolveMode("conversation-insights"), "responses");
  });
});

describe("isXAIOnlyFeature", () => {
  it("returns true for xAI-only features", async () => {
    const { isXAIOnlyFeature } = await import("../llmConfig.js");
    assert.equal(isXAIOnlyFeature("image"), true);
    assert.equal(isXAIOnlyFeature("tts"), true);
    assert.equal(isXAIOnlyFeature("video"), true);
    assert.equal(isXAIOnlyFeature("x_search"), true);
  });

  it("returns false for text and other features", async () => {
    const { isXAIOnlyFeature } = await import("../llmConfig.js");
    assert.equal(isXAIOnlyFeature("text"), false);
    assert.equal(isXAIOnlyFeature("chat"), false);
    assert.equal(isXAIOnlyFeature(""), false);
  });
});

describe("responseChainStore", () => {
  beforeEach(() => cleanChain());
  afterEach(() => cleanChain());

  it("round-trips get/set/clear", async () => {
    const { getPreviousResponseId, setResponseChain, clearResponseChain } = await import(
      `../responseChainStore.js?t=${Date.now()}`
    );

    assert.equal(getPreviousResponseId("conv1"), null);

    setResponseChain("conv1", "resp_abc", "grok-4.20");
    assert.equal(getPreviousResponseId("conv1"), "resp_abc");

    setResponseChain("conv1", "resp_xyz", "grok-4.20");
    assert.equal(getPreviousResponseId("conv1"), "resp_xyz");

    clearResponseChain("conv1");
    assert.equal(getPreviousResponseId("conv1"), null);
  });

  it("purges entries older than 30 days lazily on read", async () => {
    const { getPreviousResponseId, setResponseChain } = await import(
      `../responseChainStore.js?t=${Date.now()}`
    );

    // Write an entry with an old timestamp directly to the file
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    fs.writeFileSync(
      CHAIN_FILE,
      JSON.stringify({
        stale: { responseId: "resp_old", updatedAt: old, model: "grok" },
        fresh: { responseId: "resp_new", updatedAt: recent, model: "grok" },
      }),
      "utf8",
    );

    assert.equal(getPreviousResponseId("stale"), null);
    assert.equal(getPreviousResponseId("fresh"), "resp_new");

    // Trigger a save that persists the purge
    setResponseChain("fresh", "resp_new", "grok");
    const contents = JSON.parse(fs.readFileSync(CHAIN_FILE, "utf8"));
    assert.equal(contents.stale, undefined);
    assert.ok(contents.fresh);
  });
});

describe("postXSearchResponses — provider guard (bug 2 fix)", () => {
  let originalFetch: typeof globalThis.fetch;
  const savedGrok  = process.env.GROK_API_KEY;
  const savedModel = process.env.MODEL_LIVE_SOCIAL;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.GROK_API_KEY = "test-grok-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrok;
    if (savedModel === undefined) delete process.env.MODEL_LIVE_SOCIAL;
    else process.env.MODEL_LIVE_SOCIAL = savedModel;
  });

  it("throws when the resolved provider is not xai-direct (OpenRouter override)", async () => {
    // Override live-social to an OpenRouter/Anthropic model so the provider
    // guard must fire. Without the guard, we'd silently POST an Anthropic
    // model ID to api.x.ai and get a 400.
    process.env.MODEL_LIVE_SOCIAL = "anthropic/claude-sonnet-4.6";
    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}`);
    await assert.rejects(
      () => postXSearchResponses({ task: "signal-brief", content: "hi" }),
      (err: Error) => /xAI-direct tier/.test(err.message) && /signal-brief/.test(err.message),
    );
  });

  it("throws when the resolved provider is Perplexity", async () => {
    process.env.MODEL_LIVE_SOCIAL = "sonar-pro";
    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}`);
    await assert.rejects(
      () => postXSearchResponses({ task: "signal-brief", content: "hi" }),
      /xAI-direct tier/,
    );
  });

  it("throws when GROK_API_KEY is missing (no silent fallback)", async () => {
    delete process.env.GROK_API_KEY;
    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}`);
    await assert.rejects(
      () => postXSearchResponses({ task: "signal-brief", content: "hi" }),
      /GROK_API_KEY is not set/,
    );
  });

  it("accepts the default live-social route (xai-direct)", async () => {
    delete process.env.MODEL_LIVE_SOCIAL;
    const fetchMock = mock.fn(async (_url: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ output: [] }),
      text: async () => "",
    }) as any);
    globalThis.fetch = fetchMock as any;

    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}`);
    const res = await postXSearchResponses({ task: "signal-brief", content: "hi" });
    assert.equal(res.ok, true);
    assert.equal(fetchMock.mock.callCount(), 1);
    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(url.includes("api.x.ai"), `expected api.x.ai, got ${url}`);
  });
});

describe("callLLM routing", () => {
  let originalFetch: typeof globalThis.fetch;
  const savedEnabled = process.env.RESPONSES_API_ENABLED_TASKS;
  const savedFallback = process.env.RESPONSES_API_FALLBACK;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedEnabled === undefined) delete process.env.RESPONSES_API_ENABLED_TASKS;
    else process.env.RESPONSES_API_ENABLED_TASKS = savedEnabled;
    if (savedFallback === undefined) delete process.env.RESPONSES_API_FALLBACK;
    else process.env.RESPONSES_API_FALLBACK = savedFallback;
  });

  it("routes to chat completions when mode is unset (default)", async () => {
    delete process.env.RESPONSES_API_ENABLED_TASKS;
    const fetchMock = mock.fn(async () => makeChatResponse("chat reply") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "hypothesis-evaluation",
      messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.mode, "chat");
    assert.equal(out.text, "chat reply");
    assert.equal(fetchMock.mock.callCount(), 1);
    const calledUrl = fetchMock.mock.calls[0].arguments[0];
    assert.ok(String(calledUrl).includes("openrouter") || String(calledUrl).includes("chat/completions"));
  });

  it("routes to responses API when task is in enabled list (xAI-routed task)", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "self-debate";
    const fetchMock = mock.fn(async () => makeResponsesResponse("responses reply", "resp_999") as any);
    globalThis.fetch = fetchMock as any;

    const { callLLM } = await import(`../llmCall.js?t=${Date.now()}`);
    const out = await callLLM({
      task: "self-debate",
      input: [{ role: "user", content: "hi" }],
    });

    assert.equal(out.mode, "responses");
    assert.equal(out.text, "responses reply");
    assert.equal(out.responseId, "resp_999");
    assert.equal(fetchMock.mock.callCount(), 1);
    const calledUrl = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(calledUrl.includes("/responses"));
  });

  it("falls back to chat completions when responses API errors", async () => {
    process.env.RESPONSES_API_ENABLED_TASKS = "self-debate";
    process.env.RESPONSES_API_FALLBACK = "true";

    let call = 0;
    const fetchMock = mock.fn(async () => {
      call += 1;
      if (call === 1) return makeErrorResponse(500, "boom") as any;
      return makeChatResponse("fallback reply") as any;
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
  });
});
