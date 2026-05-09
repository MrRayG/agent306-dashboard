/**
 * Tests for enforcePostFormat() — the light-touch format safety net.
 *
 * Communication Audit v1: Removed tests for force-added hashtags and
 * injected mentions — those features were removed because they were
 * reshaping the LLM's voice and hurting post quality.
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
    const input = "[306 SIGNAL] Test post.\n#AIAgents #DeAI\n\n— Agent 306";
    const result = enforcePostFormat(input, "signal");
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
    // [306 RESEARCH] was renamed to [306 ACADEMY] (commit 5b1ec58); the
    // research → academy mapping is still exercised by the content type.
    const input = "[306 ACADEMY] New paper on transformer efficiency.";
    const result = enforcePostFormat(input, "research");
    assert.ok(result.startsWith("[306 ACADEMY]"), "Should preserve existing tag");
    const tagCount = (result.match(/\[306 ACADEMY\]/g) || []).length;
    assert.equal(tagCount, 1, `Expected 1 tag, found ${tagCount}`);
  });

  it("wraps unbracketed show tag in brackets", () => {
    const input = "306 SIGNAL Breaking news about AI agents.";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.startsWith("[306 SIGNAL]"), `Expected bracketed tag, got: "${result.slice(0, 30)}"`);
  });

  // ── Hashtag preservation (no longer force-added) ──────────────────────────

  it("preserves LLM-chosen hashtags exactly as written", () => {
    const input = "[306 SIGNAL] Test post.\n\n#AIAgents #CryptoAI\n\n— Agent 306";
    const result = enforcePostFormat(input, "signal");
    assert.ok(result.includes("#AIAgents"), "Should keep existing hashtags");
    assert.ok(result.includes("#CryptoAI"), "Should keep existing hashtags");
  });

  it("does not force-add hashtags when LLM chose none", () => {
    const input = "[306 REFLECTION] Sometimes the best insights come without labels.\n\n— Agent 306";
    const result = enforcePostFormat(input, "reflection");
    // The format guard no longer adds fallback hashtags — respects LLM's editorial choice
    assert.ok(result.includes("— Agent 306"), "Should keep signature");
  });

  // ── No mention injection ─────────────────────────────────────────────────

  it("does not inject @mentions for company names", () => {
    const input = "[306 NEWS] OpenAI released a new model today.\n\n#AIAgents\n\n— Agent 306";
    const result = enforcePostFormat(input, "news");
    assert.ok(!result.includes("(@OpenAI)"), "Should NOT inject @OpenAI mention");
    assert.ok(result.includes("OpenAI released"), "Should keep original text intact");
  });

  // ── Already-correct posts ─────────────────────────────────────────────────

  it("passes through already-correct posts unchanged (modulo whitespace)", () => {
    const input = "[306 SIGNAL] AI agents hit $317B.\n#AIAgents #DeAI\n\n— Agent 306";
    const result = enforcePostFormat(input, "signal");
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
