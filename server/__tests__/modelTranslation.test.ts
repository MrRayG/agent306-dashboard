/**
 * Tests for toXAINativeModel — OpenRouter → xAI native model name translation.
 *
 * Run: npx tsx --test server/__tests__/modelTranslation.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("toXAINativeModel", () => {
  it("maps x-ai/grok-4.20 to grok-4-1-fast-non-reasoning", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("x-ai/grok-4.20"), "grok-4-1-fast-non-reasoning");
  });

  it("maps x-ai/grok-4.20-multi-agent to grok-4-1-fast-non-reasoning (degraded)", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("x-ai/grok-4.20-multi-agent"), "grok-4-1-fast-non-reasoning");
  });

  it("returns null for non-xAI models (Anthropic)", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("anthropic/claude-sonnet-4.6"), null);
  });

  it("returns null for non-xAI models (Google)", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("google/gemini-2.5-flash-lite"), null);
  });

  it("maps x-ai/grok-4-fast-reasoning to grok-4-fast-reasoning", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("x-ai/grok-4-fast-reasoning"), "grok-4-fast-reasoning");
  });

  it("falls back to strip-prefix for unmapped xAI models", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("x-ai/some-future-unmapped-model"), "some-future-unmapped-model");
  });

  it("maps x-ai/grok-4 identity", async () => {
    const { toXAINativeModel } = await import("../llmConfig.js");
    assert.equal(toXAINativeModel("x-ai/grok-4"), "grok-4");
  });
});
