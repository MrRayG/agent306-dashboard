/**
 * Tests for toXAINativeModel — catches silent Grok 4.20 → Fast downgrade regression.
 *
 * Run: npx tsx --test server/__tests__/llmConfigMapping.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toXAINativeModel } from "../llmConfig.js";

describe("toXAINativeModel — Grok 4.20 flagship family", () => {
  it("maps x-ai/grok-4.20 to grok-4.20-0309-non-reasoning (NOT Fast)", () => {
    assert.equal(toXAINativeModel("x-ai/grok-4.20"), "grok-4.20-0309-non-reasoning");
  });

  it("maps x-ai/grok-4.20-non-reasoning to grok-4.20-0309-non-reasoning", () => {
    assert.equal(
      toXAINativeModel("x-ai/grok-4.20-non-reasoning"),
      "grok-4.20-0309-non-reasoning",
    );
  });

  it("maps x-ai/grok-4.20-reasoning to grok-4.20-0309-reasoning (hallucination king)", () => {
    assert.equal(
      toXAINativeModel("x-ai/grok-4.20-reasoning"),
      "grok-4.20-0309-reasoning",
    );
  });

  it("maps x-ai/grok-4.20-multi-agent to grok-4.20-multi-agent-0309", () => {
    assert.equal(
      toXAINativeModel("x-ai/grok-4.20-multi-agent"),
      "grok-4.20-multi-agent-0309",
    );
  });
});

describe("toXAINativeModel — Fast tier preserved for budget tasks", () => {
  it("maps x-ai/grok-4-1-fast-non-reasoning to grok-4-1-fast-non-reasoning", () => {
    assert.equal(
      toXAINativeModel("x-ai/grok-4-1-fast-non-reasoning"),
      "grok-4-1-fast-non-reasoning",
    );
  });

  it("maps x-ai/grok-4-1-fast-reasoning to grok-4-1-fast-reasoning", () => {
    assert.equal(
      toXAINativeModel("x-ai/grok-4-1-fast-reasoning"),
      "grok-4-1-fast-reasoning",
    );
  });
});

describe("toXAINativeModel — Grok 4 family", () => {
  it("maps x-ai/grok-4 to grok-4", () => {
    assert.equal(toXAINativeModel("x-ai/grok-4"), "grok-4");
  });

  it("maps x-ai/grok-4-0709 to grok-4-0709", () => {
    assert.equal(toXAINativeModel("x-ai/grok-4-0709"), "grok-4-0709");
  });
});

describe("toXAINativeModel — non-xAI models return null", () => {
  it("returns null for Anthropic models", () => {
    assert.equal(toXAINativeModel("anthropic/claude-sonnet-4.6"), null);
    assert.equal(toXAINativeModel("anthropic/claude-opus-4.6"), null);
  });

  it("returns null for Google models", () => {
    assert.equal(toXAINativeModel("google/gemini-3-flash-preview"), null);
  });

  it("returns null for unprefixed models", () => {
    assert.equal(toXAINativeModel("grok-4.20"), null);
  });
});

describe("toXAINativeModel — regression guard", () => {
  it("CRITICAL: grok-4.20 must NOT fall back to Fast model (silent downgrade)", () => {
    const result = toXAINativeModel("x-ai/grok-4.20");
    assert.notEqual(result, "grok-4-1-fast-non-reasoning",
      "Regression: x-ai/grok-4.20 is being silently downgraded to Fast model. " +
      "This was the bug that caused 0 api.x.ai hits across 1001 log events.");
    assert.ok(result?.startsWith("grok-4.20-"),
      `Expected grok-4.20-* native ID, got: ${result}`);
  });

  it("unknown xAI models fall through to stripped prefix (future-compat)", () => {
    // If xAI adds a new model and we haven't mapped it, strip the x-ai/ prefix
    // so at least the call has a chance of working.
    assert.equal(
      toXAINativeModel("x-ai/grok-5-hypothetical"),
      "grok-5-hypothetical",
    );
  });
});
