/**
 * fix/free-api-swap — free-mode routing (Gemini → Groq, Tavily, xAI media off).
 * The platform fetch is stubbed BEFORE freeLLM.ts is imported, because the
 * module captures it at load time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const calls: Array<{ url: string; body: any }> = [];
let geminiStatus = 500;

process.env.GEMINI_API_KEY = "test-gemini";
process.env.GROQ_API_KEY = "test-groq";
process.env.TAVILY_API_KEY = "test-tavily";
delete process.env.FREE_LLM_ROUTING;

const chatBody = (text: string) =>
  JSON.stringify({ id: "x", model: "m", choices: [{ message: { role: "assistant", content: text } }] });

globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ url, body });
  if (url.includes("generativelanguage.googleapis.com")) {
    return geminiStatus === 200
      ? new Response(chatBody("from gemini"), { status: 200 })
      : new Response("{\"error\":\"quota\"}", { status: geminiStatus });
  }
  if (url.includes("api.groq.com")) return new Response(chatBody("from groq"), { status: 200 });
  if (url.includes("api.tavily.com")) {
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://ex.com/a", content: "c" }] }), { status: 200 });
  }
  return new Response("passthrough", { status: 200 });
}) as typeof fetch;

const free = await import("../freeLLM.js");
free.installFreeLLMRouting();

test("chat completions fall back from Gemini to Groq", async () => {
  geminiStatus = 500;
  calls.length = 0;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "x-ai/grok-4", messages: [{ role: "user", content: "hi" }], tools: [{}] }),
  });
  const data: any = await res.json();
  assert.equal(data.choices[0].message.content, "from groq");
  assert.ok(calls[0].url.includes("generativelanguage.googleapis.com"));
  assert.equal(calls[0].body.model, free.GEMINI_MODEL);
  assert.equal(calls[0].body.tools, undefined, "unsupported fields are stripped");
  assert.ok(calls[1].url.includes("api.groq.com"));
});

test("Gemini is used when healthy", async () => {
  geminiStatus = 200;
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "grok", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(((await res.json()) as any).choices[0].message.content, "from gemini");
});

test("Perplexity requests are served by Tavily + LLM with citations", async () => {
  geminiStatus = 200;
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "sonar-pro", messages: [{ role: "user", content: "latest AI news" }] }),
  });
  const data: any = await res.json();
  assert.deepEqual(data.citations, ["https://ex.com/a"]);
  assert.equal(data.choices[0].message.content, "from gemini");
});

test("Responses API calls get the Responses shape", async () => {
  geminiStatus = 200;
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    body: JSON.stringify({ input: [{ role: "user", content: "hi" }], tools: [{ type: "x_search" }] }),
  });
  const data: any = await res.json();
  const msg = data.output.find((o: any) => o.type === "message");
  assert.equal(msg.content.find((c: any) => c.type === "output_text").text, "from gemini");
});

test("xAI media endpoints are disabled gracefully without an xAI key", async () => {
  delete process.env.GROK_API_KEY;
  delete process.env.XAI_API_KEY;
  calls.length = 0;
  const res = await fetch("https://api.x.ai/v1/tts", { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0, "no network call made");
});

test("non-LLM hosts (X posting, CoinGecko) pass straight through", async () => {
  calls.length = 0;
  const res = await fetch("https://api.coingecko.com/api/v3/ping");
  assert.equal(await res.text(), "passthrough");
  await fetch("https://api.x.com/2/tweets", { method: "POST", body: "{}" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.x.com/2/tweets");
});

test("research key sentinel is set only when Tavily is configured", () => {
  assert.equal(free.getResearchKey(), "tavily-free-mode");
});
