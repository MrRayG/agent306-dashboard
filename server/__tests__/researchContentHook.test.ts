/**
 * Tests for researchEngine.generateResearchContent — the short
 * 306-voice research promo. Replaces the pre-PR-C behaviour of
 * dumping `topic.conclusion` or the first 1000 characters of the
 * manuscript, which caused mid-sentence truncation in X posts.
 *
 * We exercise the deterministic fallback path (no LLM key configured)
 * so these tests stay hermetic. The LLM-driven branch is covered by
 * manual smoke tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "research-hook-"));
process.env.DATA_DIR = TMP;

// Force the deterministic fallback branch by removing all LLM keys.
// generateResearchContent checks LLM_API_KEY to decide whether to call
// out to the model; without one it falls through to the deterministic
// builder which we can assert on reliably.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.XAI_DIRECT_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const {
  generateResearchContent,
  addTopic,
  updateTopicStatus,
  resetResearchLab,
} = await import("../researchEngine.js");

function seedManuscriptTopic() {
  resetResearchLab();
  const topic = addTopic({
    topic: "AI Agent Coordination",
    description: "How multi-agent systems share state",
    priority: "high",
    addedBy: "agent",
  });
  updateTopicStatus(topic.id, "approved", {
    manuscript: "# Heading\n\nFirst paragraph of the manuscript. It has several sentences. The second one reveals the key finding.",
    conclusion:
      "Agents coordinate best when they share an append-only event log. This was the surprise — shared mutable state collapsed under contention.",
  });
  return topic;
}

test("returns null when there are no publishable manuscripts", async () => {
  resetResearchLab();
  const content = await generateResearchContent();
  assert.equal(content, null,
    "with no manuscripts, generateResearchContent should return null");
});

test("promotes the latest manuscript with the [306 RESEARCH] show tag", async () => {
  seedManuscriptTopic();
  const content = await generateResearchContent();
  assert.ok(content, "expected a research promo string");
  assert.ok(content!.startsWith("[306 RESEARCH]"),
    `expected leading [306 RESEARCH] tag, got: ${content}`);
});

test("promo is short — not a raw conclusion dump", async () => {
  seedManuscriptTopic();
  const content = await generateResearchContent();
  assert.ok(content, "expected content");
  // Pre-PR-C the output frequently exceeded 500 chars because the entire
  // conclusion was pasted in. The new shape targets ≤450 chars.
  assert.ok(content!.length < 500,
    `research promo should be tight; got length=${content!.length}\n${content}`);
});

test("promo ends in real punctuation before the link — no mid-sentence truncation", async () => {
  seedManuscriptTopic();
  const content = await generateResearchContent();
  assert.ok(content, "expected content");
  // Strip the trailing "Full manuscript: <url>" line and check the last
  // non-URL character of the hook body is a real terminator.
  const bodyBeforeLink = content!.replace(/\n\nFull manuscript:\s*https?:\/\/\S+\s*$/, "");
  const lastChar = bodyBeforeLink.slice(-1);
  assert.ok(/[.!?…)"']/.test(lastChar),
    `hook body should end in sentence-terminating punctuation; got last char="${lastChar}"\nfull: ${content}`);
});

test("promo includes the full-manuscript link", async () => {
  const topic = seedManuscriptTopic();
  const content = await generateResearchContent();
  assert.ok(content, "expected content");
  assert.ok(content!.includes(`agent306.ai/research/${topic.id}`),
    "promo must link to the manuscript URL so readers can open the piece");
});
