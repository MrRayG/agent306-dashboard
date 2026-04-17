import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Route DATA_DIR to a throwaway tmp so tests don't pollute real data/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xaitts-"));
process.env.DATA_DIR = TMP;

// Import under test AFTER setting DATA_DIR so dataPaths.ts picks it up
const {
  chunkTextForXai,
  XAI_MAX_CHUNK_CHARS,
  XAI_VOICES,
  DEFAULT_XAI_VOICE,
  estimateXaiTtsCost,
  getTtsProvider,
  recordTtsCall,
  getTtsStats,
  callXaiTts,
} = await import("../xaiTtsEngine.js");

describe("xaiTtsEngine — chunkTextForXai", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(chunkTextForXai(""), []);
  });

  it("returns single chunk when under the limit", () => {
    const text = "short paragraph";
    assert.deepEqual(chunkTextForXai(text), [text]);
  });

  it("splits at paragraph boundaries", () => {
    const para = "a".repeat(9000);
    const text = `${para}\n\n${para}`;
    const chunks = chunkTextForXai(text);
    assert.equal(chunks.length, 2);
    chunks.forEach((c) => assert.ok(c.length <= XAI_MAX_CHUNK_CHARS, `chunk ${c.length} over limit`));
  });

  it("hard-splits a single paragraph larger than the limit", () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} ${"x".repeat(1000)}.`);
    const para = sentences.join(" ");
    assert.ok(para.length > XAI_MAX_CHUNK_CHARS, "test fixture should exceed limit");
    const chunks = chunkTextForXai(para);
    assert.ok(chunks.length >= 2, "should split into 2+ chunks");
    chunks.forEach((c) => assert.ok(c.length <= XAI_MAX_CHUNK_CHARS, `chunk ${c.length} over limit`));
  });

  it("preserves full content across chunks (no data loss)", () => {
    const para = "b".repeat(9000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkTextForXai(text);
    const recombinedChars = chunks.join("").replace(/\s+/g, "").length;
    const originalChars = text.replace(/\s+/g, "").length;
    assert.equal(recombinedChars, originalChars);
  });
});

describe("xaiTtsEngine — voice constants", () => {
  it("exposes the 5 documented voices", () => {
    assert.deepEqual([...XAI_VOICES], ["ara", "eve", "leo", "rex", "sal"]);
  });

  it("defaults to eve when TTS_XAI_VOICE unset", () => {
    // Can't re-import cleanly, but DEFAULT_XAI_VOICE was frozen at import time
    // with TTS_XAI_VOICE unset (test env), so it should be "eve".
    assert.equal(DEFAULT_XAI_VOICE, "eve");
  });
});

describe("xaiTtsEngine — cost estimate", () => {
  it("returns 0 for 0 characters", () => {
    assert.equal(estimateXaiTtsCost(0), 0);
  });

  it("returns non-negative for negative input", () => {
    assert.equal(estimateXaiTtsCost(-5), 0);
  });

  it("matches $4.20 / 1M chars pricing", () => {
    const cost = estimateXaiTtsCost(1_000_000);
    assert.ok(Math.abs(cost - 4.2) < 1e-9, `expected ~4.2, got ${cost}`);
  });

  it("scales linearly", () => {
    const a = estimateXaiTtsCost(500_000);
    const b = estimateXaiTtsCost(1_000_000);
    assert.ok(Math.abs(b - 2 * a) < 1e-9);
  });
});

describe("xaiTtsEngine — getTtsProvider feature flag", () => {
  const originalProvider = process.env.TTS_PROVIDER;
  after(() => {
    if (originalProvider === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = originalProvider;
  });

  it("defaults to elevenlabs when unset", () => {
    delete process.env.TTS_PROVIDER;
    assert.equal(getTtsProvider(), "elevenlabs");
  });

  it("returns xai when TTS_PROVIDER=xai", () => {
    process.env.TTS_PROVIDER = "xai";
    assert.equal(getTtsProvider(), "xai");
  });

  it("treats unknown values as elevenlabs (safe default)", () => {
    process.env.TTS_PROVIDER = "gibberish";
    assert.equal(getTtsProvider(), "elevenlabs");
  });

  it("is case-insensitive / whitespace-tolerant", () => {
    process.env.TTS_PROVIDER = "  XAI  ";
    assert.equal(getTtsProvider(), "xai");
  });
});

describe("xaiTtsEngine — stats tracker", () => {
  it("records per-provider calls and accumulates cost", () => {
    recordTtsCall({ provider: "xai", characters: 1000, cost: 0.0042, voice: "eve" });
    recordTtsCall({ provider: "xai", characters: 2000, cost: 0.0084, voice: "eve" });
    recordTtsCall({ provider: "elevenlabs", characters: 500, cost: 0.09 });
    const stats = getTtsStats();
    assert.equal(stats.byProvider.xai.calls, 2);
    assert.equal(stats.byProvider.xai.characters, 3000);
    assert.ok(Math.abs(stats.byProvider.xai.cost - 0.0126) < 1e-9);
    assert.equal(stats.byProvider.elevenlabs.calls, 1);
    assert.equal(stats.byProvider.elevenlabs.characters, 500);
  });

  it("records per-episode detail when episodeId provided", () => {
    recordTtsCall({
      provider: "xai",
      characters: 5000,
      cost: 0.021,
      episodeId: "ep-test-001",
      voice: "eve",
    });
    const stats = getTtsStats();
    const ep = stats.byEpisode["ep-test-001"];
    assert.ok(ep, "episode entry should exist");
    assert.equal(ep.provider, "xai");
    assert.equal(ep.voice, "eve");
    assert.equal(ep.characters, 5000);
    assert.ok(ep.generatedAt);
  });
});

describe("xaiTtsEngine — callXaiTts input validation", () => {
  it("rejects empty text", async () => {
    await assert.rejects(
      () => callXaiTts({ text: "", voice: "eve", apiKey: "test-key" }),
      /empty text/,
    );
  });

  it("rejects text exceeding 15k chars", async () => {
    await assert.rejects(
      () => callXaiTts({ text: "x".repeat(XAI_MAX_CHUNK_CHARS + 1), voice: "eve", apiKey: "test-key" }),
      /exceeds/,
    );
  });

  it("rejects invalid voice", async () => {
    await assert.rejects(
      () => callXaiTts({ text: "hello", voice: "bogus" as any, apiKey: "test-key" }),
      /Invalid xAI voice/,
    );
  });

  it("rejects when no API key available", async () => {
    const originalGrok = process.env.GROK_API_KEY;
    const originalXai = process.env.XAI_API_KEY;
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      await assert.rejects(
        () => callXaiTts({ text: "hello", voice: "eve" }),
        /GROK_API_KEY not set/,
      );
    } finally {
      if (originalGrok !== undefined) process.env.GROK_API_KEY = originalGrok;
      if (originalXai !== undefined) process.env.XAI_API_KEY = originalXai;
    }
  });
});

describe("xaiTtsEngine — wire format (per docs.x.ai)", () => {
  const originalFetch = globalThis.fetch;

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to /v1/tts with {text, voice_id, language} body — NOT /v1/audio/speech", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;
    let capturedAuth = "";
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = init?.body ? JSON.parse(init.body) : null;
      capturedAuth = init?.headers?.["Authorization"] ?? "";
      return {
        ok: true,
        status: 200,
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(8),
      } as any;
    }) as any;

    const buf = await callXaiTts({ text: "hello world", voice: "eve", apiKey: "test-key" });
    assert.ok(Buffer.isBuffer(buf), "returns a Buffer");

    // Endpoint correctness — the entire bug from the prior session
    assert.equal(capturedUrl, "https://api.x.ai/v1/tts");
    assert.ok(!capturedUrl.includes("/audio/speech"), "must NOT use OpenAI-style /audio/speech");

    // Body shape per docs.x.ai/developers/model-capabilities/audio/voice
    assert.equal(capturedBody.text, "hello world");
    assert.equal(capturedBody.voice_id, "eve");
    assert.equal(capturedBody.language, "en");
    assert.equal(capturedBody.model, undefined, "xAI TTS body must NOT include `model`");
    assert.equal(capturedBody.voice, undefined, "xAI TTS body must NOT include `voice` (it is `voice_id`)");
    assert.equal(capturedBody.input, undefined, "xAI TTS body must NOT include `input` (it is `text`)");
    assert.equal(capturedBody.response_format, undefined, "xAI TTS body must NOT include `response_format`");

    // Auth header preserved
    assert.equal(capturedAuth, "Bearer test-key");
  });
});
