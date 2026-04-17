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

describe("postXSearchResponses — provider guard (router-tier-split PR)", () => {
  const savedGrokKey = process.env.GROK_API_KEY;
  const savedMultiAgent = process.env.MODEL_MULTI_AGENT;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.GROK_API_KEY = "test-xai-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedGrokKey === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrokKey;
    if (savedMultiAgent === undefined) delete process.env.MODEL_MULTI_AGENT;
    else process.env.MODEL_MULTI_AGENT = savedMultiAgent;
  });

  it("throws when resolved provider is not xai-direct (routine → openrouter)", async () => {
    // `tier-assignment` resolves to routine → openrouter. The guard must fire
    // BEFORE any fetch is issued.
    const fetchMock = mock.fn(async () => makeChatResponse("should not be called") as any);
    globalThis.fetch = fetchMock as any;

    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}-guard1`);
    await assert.rejects(
      () => postXSearchResponses({ task: "tier-assignment", content: "hello" }),
      /postXSearchResponses requires xai-direct tier.*task=tier-assignment.*provider=openrouter/,
    );
    assert.equal(fetchMock.mock.callCount(), 0, "no fetch should be issued when guard trips");
  });

  it("throws when resolved provider is perplexity (news-research)", async () => {
    const fetchMock = mock.fn(async () => makeChatResponse("should not be called") as any);
    globalThis.fetch = fetchMock as any;

    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}-guard2`);
    await assert.rejects(
      () => postXSearchResponses({ task: "news-research", content: "hello" }),
      /postXSearchResponses requires xai-direct tier.*provider=perplexity/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("allows xai-direct-tier tasks (live-social / signal-brief) through", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] }),
      text: async () => "",
    }) as any);
    globalThis.fetch = fetchMock as any;

    const { postXSearchResponses } = await import(`../llmCall.js?t=${Date.now()}-guard3`);
    const res = await postXSearchResponses({ task: "signal-brief", content: "q" });
    assert.equal(res.ok, true);
    assert.equal(fetchMock.mock.callCount(), 1);
    const calledUrl = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(calledUrl.includes("api.x.ai"), `expected api.x.ai, got ${calledUrl}`);
  });
});

describe("postChatCompletions — provider dispatch for perplexity tier", () => {
  const savedPplxKey = process.env.PERPLEXITY_API_KEY;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.PERPLEXITY_API_KEY = "test-pplx-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedPplxKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = savedPplxKey;
  });

  it("routes perplexity-tier tasks to api.perplexity.ai/chat/completions", async () => {
    const fetchMock = mock.fn(async () => makeChatResponse("pplx reply") as any);
    globalThis.fetch = fetchMock as any;

    const { postChatCompletions } = await import(`../llmCall.js?t=${Date.now()}-pplx1`);
    await postChatCompletions(
      { model: "sonar-pro", messages: [{ role: "user", content: "hi" }] },
      undefined,
      "news-research",
    );
    assert.equal(fetchMock.mock.callCount(), 1);
    const url = String(fetchMock.mock.calls[0].arguments[0]);
    assert.ok(url.includes("perplexity.ai"), `expected perplexity URL, got ${url}`);
    const headers = fetchMock.mock.calls[0].arguments[1].headers;
    assert.equal(headers["Authorization"], "Bearer test-pplx-key");
  });

  it("postPerplexity throws when task routes to non-perplexity provider", async () => {
    const { postPerplexity } = await import(`../llmCall.js?t=${Date.now()}-pplx2`);
    await assert.rejects(
      () => postPerplexity({ task: "article", messages: [] }),
      /postPerplexity.*routed to provider=xai-direct/,
    );
  });

  it("postChatCompletions for perplexity throws without PERPLEXITY_API_KEY", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const { postChatCompletions } = await import(`../llmCall.js?t=${Date.now()}-pplx3`);
    await assert.rejects(
      () => postChatCompletions(
        { model: "sonar-pro", messages: [] },
        undefined,
        "news-research",
      ),
      /PERPLEXITY_API_KEY is not set/,
    );
  });
});
