/**
 * Tests for enforcePostFormat() — the last-mile safety net for all X posts.
 *
 * Run: npx tsx --test server/__tests__/postFormatGuard.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enforcePostFormat, stripMarkdown } from "../postFormatGuard.js";

describe("enforcePostFormat", () => {
  // ── Signature ─────────────────────────────────────────────────────────────

  it("adds missing signature", () => {
    const input = "[306 SIGNAL] AI agents are transforming infrastructure.";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.endsWith("— Agent 306"), `Expected signature at end, got: "${result.slice(-30)}"`);
  });

  it("normalizes dash-style signature variations", () => {
    const input = "[306 SIGNAL] Test post.\n\n- Agent 306";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.includes("— Agent 306"), "Should normalize to em-dash signature");
    assert.ok(!result.includes("- Agent 306"), "Should not keep hyphen-style signature");
  });

  it("preserves correct existing signature", () => {
    const input = "[306 SIGNAL] Test post.\n#AIAgents #DeAI #DePIN #Web3AI\n\n— Agent 306";
    const result = enforcePostFormat(input, "signal");
    // Should have exactly one signature
    const sigCount = (result.match(/— Agent 306/g) || []).length;
    assert.equal(sigCount, 1, `Expected 1 signature, found ${sigCount}`);
  });

  // ── Show tag ──────────────────────────────────────────────────────────────

  it("adds missing show tag for signal content type", () => {
    const input = "Breaking: AI agents hit $317B market.";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.startsWith("[306 SIGNAL]"), `Expected [306 SIGNAL] tag, got: "${result.slice(0, 30)}"`);
  });

  it("adds missing show tag for dispatch content type", () => {
    const input = "Market update: major shift in AI infrastructure.";
    const result = enforcePostFormat(input, "dispatch");
    assert.ok(result.startsWith("[THE DISPATCH]"), `Expected [THE DISPATCH] tag, got: "${result.slice(0, 30)}"`);
  });

  it("adds missing show tag for news content type", () => {
    const input = "Breaking: AI regulatory shift announced today.";
    const result = enforcePostFormat(input, "news");
    assert.ok(result.startsWith("[306 NEWS]"), `Expected [306 NEWS] tag, got: "${result.slice(0, 30)}"`);
  });

  it("preserves existing valid show tag", () => {
    const input = "[306 RESEARCH] New paper on transformer efficiency.";
    const result = enforcePostFormat(input, "research");
    assert.ok(result.startsWith("[306 RESEARCH]"), "Should preserve existing tag");
    // Should not duplicate the tag
    const tagCount = (result.match(/\[306 RESEARCH\]/g) || []).length;
    assert.equal(tagCount, 1, `Expected 1 tag, found ${tagCount}`);
  });

  it("wraps unbracketed show tag in brackets", () => {
    const input = "306 SIGNAL Breaking news about AI agents.";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.startsWith("[306 SIGNAL]"), `Expected bracketed tag, got: "${result.slice(0, 30)}"`);
  });

  // ── Hashtags ──────────────────────────────────────────────────────────────

  it("adds missing hashtags for signal type", () => {
    const input = "[306 SIGNAL] AI agents are evolving rapidly.";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.includes("#AIAgents"), "Should include #AIAgents");
    assert.ok(result.includes("#DeAI"), "Should include #DeAI");
    assert.ok(result.includes("#DePIN"), "Should include #DePIN");
    assert.ok(result.includes("#Web3AI"), "Should include #Web3AI");
  });

  it("does not duplicate existing hashtags", () => {
    const input = "[306 SIGNAL] AI agents update. #AIAgents #DeAI #DePIN #Web3AI\n\n— Agent 306";
    const result = enforcePostFormat(input, "signal");
    const aiAgentsCount = (result.match(/#AIAgents/g) || []).length;
    assert.equal(aiAgentsCount, 1, `Expected 1 #AIAgents, found ${aiAgentsCount}`);
  });

  it("adds type-specific hashtags for reflection", () => {
    const input = "[306 REFLECTION] Thoughts on agency and consciousness.";
    const result = enforcePostFormat(input, "reflection");
    assert.ok(result.includes("#AIAgents"), "Should include #AIAgents for reflection");
    assert.ok(result.includes("#AgenticAI"), "Should include #AgenticAI for reflection");
  });

  // ── Already-correct posts ─────────────────────────────────────────────────

  it("passes through already-correct posts unchanged (modulo whitespace)", () => {
    const input = "[306 SIGNAL] AI agents hit $317B.\n#AIAgents #DeAI #DePIN #Web3AI\n\n— Agent 306";
    const result = enforcePostFormat(input, "signal");
    // Should have the same key components
    assert.ok(result.startsWith("[306 SIGNAL]"), "Should keep show tag");
    assert.ok(result.includes("#AIAgents"), "Should keep hashtags");
    assert.ok(result.endsWith("— Agent 306"), "Should keep signature");
    assert.ok(result.length <= 25000, `Should be within char limit, got ${result.length}`);
  });

  // ── Character limit ───────────────────────────────────────────────────────

  it("does not trim posts under 25000 chars", () => {
    const longBody = "This is a very long signal about AI developments in the market. ".repeat(8);
    const input = `[306 SIGNAL] ${longBody}`;
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.length <= 25000, `Expected <= 25000 chars, got ${result.length}`);
    assert.ok(result.includes(longBody.trim()), "Should preserve full body content");
  });

  it("preserves signature and tag on longer posts", () => {
    const longBody = "This is a very important AI signal. ".repeat(15);
    const input = `[306 SIGNAL] ${longBody}`;
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.length <= 25000, `Expected <= 25000 chars, got ${result.length}`);
    assert.ok(result.startsWith("[306 SIGNAL]"), "Should preserve show tag");
    assert.ok(result.endsWith("— Agent 306"), "Should preserve signature");
  });

  // ── No content type ───────────────────────────────────────────────────────

  it("works without content type (uses primary hashtags)", () => {
    const input = "Something interesting happened in AI today.";
    const result = enforcePostFormat(input);
    assert.ok(result.includes("#AIAgents"), "Should add primary hashtag");
    assert.ok(result.includes("— Agent 306"), "Should add signature");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("handles empty-ish input gracefully", () => {
    const result = enforcePostFormat("  ", "signal");
    assert.ok(typeof result === "string", "Should return a string");
  });

  it("handles input that is just a show tag", () => {
    const result = enforcePostFormat("[306 SIGNAL]", "signal");
    assert.ok(result.includes("[306 SIGNAL]"), "Should keep the tag");
    assert.ok(result.includes("— Agent 306"), "Should add signature");
  });
});

describe("stripMarkdown", () => {
  it("removes **bold** formatting", () => {
    assert.equal(stripMarkdown("This is **bold** text"), "This is bold text");
  });

  it("removes *italic* formatting", () => {
    assert.equal(stripMarkdown("This is *italic* text"), "This is italic text");
  });

  it("converts [text](url) links to plain text", () => {
    assert.equal(
      stripMarkdown("Check [Agent 306](https://agent306.ai) for details"),
      "Check Agent 306 for details",
    );
  });

  it("removes ## headers", () => {
    assert.equal(stripMarkdown("## Breaking News\nSomething happened"), "Breaking News\nSomething happened");
    assert.equal(stripMarkdown("### Sub Header"), "Sub Header");
  });

  it("leaves clean text unchanged", () => {
    const clean = "This is plain text with no markdown at all.";
    assert.equal(stripMarkdown(clean), clean);
  });

  it("removes `inline code` backticks", () => {
    assert.equal(stripMarkdown("Use `fetch()` to call the API"), "Use fetch() to call the API");
  });

  it("removes ~~strikethrough~~ formatting", () => {
    assert.equal(stripMarkdown("This is ~~wrong~~ correct"), "This is wrong correct");
  });

  it("removes __underscore bold__ formatting", () => {
    assert.equal(stripMarkdown("This is __bold__ text"), "This is bold text");
  });

  it("removes _underscore italic_ formatting", () => {
    assert.equal(stripMarkdown("This is _italic_ text"), "This is italic text");
  });
});
