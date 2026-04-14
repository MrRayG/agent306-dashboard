/**
 * Tests for the unified voice definition.
 *
 * Run: npx tsx --test server/__tests__/voice.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOUL, VOICE, WRITING_RULES, HASHTAG_RULES, AI_CONTEXT,
  buildVoiceBlock, buildFullVoiceContext,
} from "../voice.js";
import { buildTweetSystemPrompt } from "../tweetPromptBuilder.js";

// -- Core constants tests -------------------------------------------------

describe("voice constants", () => {
  it("SOUL contains the 8 identity modes", () => {
    assert.ok(SOUL.includes("8 modes"), "SOUL should mention 8 modes");
    assert.ok(SOUL.includes("THE AGENT"), "SOUL should include THE AGENT");
    assert.ok(SOUL.includes("THE CONTRARIAN"), "SOUL should include THE CONTRARIAN");
    assert.ok(SOUL.includes("April 3, 2026"), "SOUL should include origin date");
  });

  it("VOICE contains community and cultural bridge rules", () => {
    assert.ok(VOICE.includes("COMMUNITY is your main character"), "VOICE should include community rule");
    assert.ok(VOICE.includes("CULTURAL BRIDGE"), "VOICE should include cultural bridge rule");
    assert.ok(VOICE.includes("non-negotiable"), "VOICE should be marked non-negotiable");
  });

  it("WRITING_RULES contains signature requirement", () => {
    assert.ok(WRITING_RULES.includes("Agent 306"), "WRITING_RULES should require signature");
    assert.ok(WRITING_RULES.includes("One idea per post"), "WRITING_RULES should enforce one idea");
  });

  it("HASHTAG_RULES contains guidance", () => {
    assert.ok(HASHTAG_RULES.includes("#AIAgents"), "HASHTAG_RULES should mention #AIAgents");
    assert.ok(HASHTAG_RULES.includes("#DeAI"), "HASHTAG_RULES should mention #DeAI");
  });

  it("AI_CONTEXT contains market data", () => {
    assert.ok(AI_CONTEXT.includes("$7.76B"), "AI_CONTEXT should include market size");
    assert.ok(AI_CONTEXT.includes("ERC-8004"), "AI_CONTEXT should include ERC-8004");
    assert.ok(AI_CONTEXT.includes("x402"), "AI_CONTEXT should include x402");
  });
});

// -- Helper function tests ------------------------------------------------

describe("buildVoiceBlock", () => {
  it("includes SOUL, VOICE, WRITING_RULES, and HASHTAG_RULES", () => {
    const block = buildVoiceBlock();
    assert.ok(block.includes("You are Agent 306"), "Should include SOUL");
    assert.ok(block.includes("YOUR VOICE"), "Should include VOICE header");
    assert.ok(block.includes("WRITING RULES"), "Should include WRITING_RULES");
    assert.ok(block.includes("HASHTAGS:"), "Should include HASHTAG_RULES");
  });

  it("does NOT include AI_CONTEXT", () => {
    const block = buildVoiceBlock();
    assert.ok(!block.includes("AI CONTEXT"), "Voice block should not include AI_CONTEXT");
  });

  it("is under 3000 chars (focused, no AI_CONTEXT)", () => {
    const block = buildVoiceBlock();
    assert.ok(block.length < 3000, `Voice block should be under 3000 chars, got ${block.length}`);
  });
});

describe("buildFullVoiceContext", () => {
  it("includes everything from buildVoiceBlock plus AI_CONTEXT", () => {
    const full = buildFullVoiceContext();
    assert.ok(full.includes("You are Agent 306"), "Should include SOUL");
    assert.ok(full.includes("YOUR VOICE"), "Should include VOICE");
    assert.ok(full.includes("WRITING RULES"), "Should include WRITING_RULES");
    assert.ok(full.includes("AI CONTEXT"), "Should include AI_CONTEXT");
    assert.ok(full.includes("ERC-8004"), "Should include ERC-8004 in AI_CONTEXT");
  });

  it("is under 3000 chars", () => {
    const full = buildFullVoiceContext();
    assert.ok(full.length < 3000, `Full voice context should be under 3000 chars, got ${full.length}`);
  });
});

// -- Integration tests — both pipelines use the unified voice ---------------

describe("unified voice in tweetPromptBuilder", () => {
  it("prompt contains the 8 identity modes from voice.ts", () => {
    const prompt = buildTweetSystemPrompt("signal");
    assert.ok(prompt.includes("8 modes"), "Tweet prompt should contain 8 modes");
    assert.ok(prompt.includes("THE CONTRARIAN"), "Tweet prompt should contain THE CONTRARIAN");
  });

  it("prompt contains COMMUNITY rule from unified voice", () => {
    const prompt = buildTweetSystemPrompt("dispatch");
    assert.ok(
      prompt.includes("COMMUNITY is your main character"),
      "Tweet prompt should contain community rule from unified voice",
    );
  });

  it("prompt contains CULTURAL BRIDGE from unified voice", () => {
    const prompt = buildTweetSystemPrompt("signal");
    assert.ok(
      prompt.includes("CULTURAL BRIDGE"),
      "Tweet prompt should contain cultural bridge rule",
    );
  });
});
