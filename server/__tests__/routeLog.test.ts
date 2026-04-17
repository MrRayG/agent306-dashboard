/**
 * Tests for routeLog observability helper.
 *
 * Run: npx tsx --test server/__tests__/routeLog.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { logRoute, inferTier, inferProvider } from "../routeLog.js";

describe("logRoute — structured log format", () => {
  let captured: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    captured = [];
    originalLog = console.log;
    console.log = (msg: string) => { captured.push(String(msg)); };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("emits a single [LLM_ROUTE] line with all fields", () => {
    logRoute({
      task: "reply_generation",
      tier: "standard",
      provider: "xai-direct",
      model: "grok-4.20-0309-non-reasoning",
      mode: "chat",
      tokensIn: 120,
      tokensOut: 35,
      latencyMs: 842,
      status: "ok",
    });

    assert.equal(captured.length, 1);
    const line = captured[0];
    assert.ok(line.startsWith("[LLM_ROUTE]"), "must start with [LLM_ROUTE] tag");
    assert.ok(line.includes("task=reply_generation"));
    assert.ok(line.includes("tier=standard"));
    assert.ok(line.includes("provider=xai-direct"));
    assert.ok(line.includes("model=grok-4.20-0309-non-reasoning"));
    assert.ok(line.includes("mode=chat"));
    assert.ok(line.includes("tokens_in=120"));
    assert.ok(line.includes("tokens_out=35"));
    assert.ok(line.includes("latency_ms=842"));
    assert.ok(line.includes("status=ok"));
    assert.ok(line.includes("error=-"));
  });

  it("replaces missing values with dash for grep/awk friendliness", () => {
    logRoute({
      task: "reflection",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      mode: "chat",
      latencyMs: 1500,
      status: "ok",
    });

    const line = captured[0];
    assert.ok(line.includes("tier=-"));
    assert.ok(line.includes("tokens_in=-"));
    assert.ok(line.includes("tokens_out=-"));
    assert.ok(line.includes("error=-"));
  });

  it("truncates long error messages to 120 chars", () => {
    const longErr = "x".repeat(500);
    logRoute({
      task: "test",
      provider: "xai-direct",
      model: "grok-4.20",
      mode: "chat",
      latencyMs: 100,
      status: "error",
      errorMsg: longErr,
    });

    const line = captured[0];
    const errMatch = line.match(/error=(\S+)/);
    assert.ok(errMatch, "should have error= field");
    assert.ok(errMatch[1].length <= 120, `error truncated, got ${errMatch[1].length}`);
  });

  it("collapses whitespace in error messages", () => {
    logRoute({
      task: "test",
      provider: "xai-direct",
      model: "grok-4.20",
      mode: "chat",
      latencyMs: 100,
      status: "error",
      errorMsg: "line1\n\nline2\t\ttabbed",
    });

    const line = captured[0];
    // Should be one physical log line (no embedded newlines)
    assert.equal(line.split("\n").length, 1, "no embedded newlines");
    assert.ok(line.includes("line1 line2 tabbed"), "whitespace collapsed");
  });
});

describe("inferTier — best-effort from model ID", () => {
  it("detects Claude Opus as frontier", () => {
    assert.equal(inferTier("anthropic/claude-opus-4.6"), "frontier");
  });

  it("detects Claude Sonnet as premium", () => {
    assert.equal(inferTier("anthropic/claude-sonnet-4.6"), "premium");
  });

  it("detects Grok 4.20 multi-agent", () => {
    assert.equal(inferTier("grok-4.20-multi-agent-0309"), "multi-agent");
  });

  it("detects Grok 4.20 reasoning as frontier-factual (hallucination king)", () => {
    assert.equal(inferTier("grok-4.20-0309-reasoning"), "frontier-factual");
  });

  it("detects Grok 4.20 non-reasoning as standard", () => {
    assert.equal(inferTier("grok-4.20-0309-non-reasoning"), "standard");
  });

  it("detects Grok Fast as routine (budget tier)", () => {
    assert.equal(inferTier("grok-4-1-fast-non-reasoning"), "routine");
  });

  it("detects Gemini Flash as routine", () => {
    assert.equal(inferTier("google/gemini-3-flash-preview"), "routine");
  });

  it("detects Sonar as live-research", () => {
    assert.equal(inferTier("sonar-pro"), "live-research");
    assert.equal(inferTier("sonar"), "live-research");
  });

  it("returns dash for unknown models", () => {
    assert.equal(inferTier("random-model"), "-");
  });
});

describe("inferProvider — from URL", () => {
  it("detects xAI direct from api.x.ai", () => {
    assert.equal(inferProvider("https://api.x.ai/v1/chat/completions"), "xai-direct");
    assert.equal(inferProvider("https://api.x.ai/v1/responses"), "xai-direct");
  });

  it("detects OpenRouter", () => {
    assert.equal(inferProvider("https://openrouter.ai/api/v1/chat/completions"), "openrouter");
  });

  it("detects Perplexity", () => {
    assert.equal(inferProvider("https://api.perplexity.ai/chat/completions"), "perplexity");
  });

  it("returns unknown for unrecognized URLs", () => {
    assert.equal(inferProvider("https://some-other-api.com/v1"), "unknown");
  });
});
