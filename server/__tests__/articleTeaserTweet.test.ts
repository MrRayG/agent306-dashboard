/**
 * Tests for articleEngine.buildArticleTeaserTweet — the deterministic
 * teaser tweet for Deep Read drafts. The user bug report was that
 * Article generation saved only the teaser as a queued tweet, dropping
 * the full manuscript. The new flow saves the manuscript as an article
 * draft AND produces a short teaser via this helper that can either be
 * queued or saved as a tweet draft depending on the autoPost toggle.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "article-teaser-"));
process.env.DATA_DIR = TMP;

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

const { buildArticleTeaserTweet } = await import("../articleEngine.js");

const baseDraft = {
  draftId: "draft_1",
  generatedAt: new Date().toISOString(),
  sourceUrl: "https://example.com/some-paper",
  sourceTitle: "A Very Long Source Title",
  headline: "What AI Agents Really Do",
  teaser: "Short hook sentence about the finding.",
  body: "Full manuscript body. Second sentence here. Third.",
};

test("teaser tweet contains the headline with [306 ARTICLE] prefix", () => {
  const tweet = buildArticleTeaserTweet(baseDraft);
  assert.ok(tweet.startsWith("[306 ARTICLE] What AI Agents Really Do"),
    `expected leading [306 ARTICLE] + headline, got: ${tweet}`);
});

test("teaser tweet ends with the source URL so the reader has a link", () => {
  const tweet = buildArticleTeaserTweet(baseDraft);
  assert.ok(tweet.includes(baseDraft.sourceUrl),
    "expected source URL to be present in teaser");
  // URL should be at the end, after "Here's what matters:".
  assert.ok(/Here's what matters:\s*https:\/\/example\.com/.test(tweet),
    `expected URL to appear after "Here's what matters:", got: ${tweet}`);
});

test("teaser tweet prefers the teaser field over body when both are present", () => {
  const tweet = buildArticleTeaserTweet(baseDraft);
  assert.ok(tweet.includes("Short hook sentence about the finding."),
    "expected teaser text to be used");
  assert.ok(!tweet.includes("Full manuscript body"),
    "body should NOT leak into the teaser when teaser exists");
});

test("teaser tweet falls back to body sentences when teaser is missing", () => {
  const tweet = buildArticleTeaserTweet({ ...baseDraft, teaser: "" });
  assert.ok(tweet.includes("Full manuscript body"),
    "expected body excerpt to appear when teaser is empty");
});

test("teaser tweet trims oversized bodies so the tweet stays manageable", () => {
  const longBody = "This is a long sentence. ".repeat(200);
  const tweet = buildArticleTeaserTweet({
    ...baseDraft,
    teaser: "",
    body: longBody,
  });
  // Total length should stay well under the 500-char envelope the
  // generate handler allows (X hard cap is 280, but we give a buffer
  // because the LLM-generated headline can be long).
  assert.ok(tweet.length < 500,
    `teaser tweet should trim long body, got length=${tweet.length}`);
});

test("teaser tweet handles missing fields gracefully", () => {
  const minimal = buildArticleTeaserTweet({
    draftId: "x",
    generatedAt: new Date().toISOString(),
    sourceUrl: "https://example.com/x",
    sourceTitle: "",
    headline: "",
    teaser: "",
    body: "Only body text available.",
  });
  // Should still produce SOMETHING sensible, starting with the tag.
  assert.ok(minimal.startsWith("[306 ARTICLE]"),
    "teaser should always lead with [306 ARTICLE] tag");
  assert.ok(minimal.includes("https://example.com/x"),
    "teaser should still include the source URL");
});
