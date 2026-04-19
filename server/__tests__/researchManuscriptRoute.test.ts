/**
 * Regression test for the dead 306 Research link bug (2026-04-19).
 *
 * The X post composer (`generateResearchContent`) advertised
 * `https://agent306.ai/research/<topic.id>` in every post, but no route ever
 * served that path, so every posted link 404'd. This test pins the contract:
 *
 *   1. The id the promo post advertises is the same id the engine stored.
 *   2. `renderResearchManuscriptPage(id)` resolves that stored topic and
 *      returns a 200 HTML page containing the manuscript.
 *   3. An unknown id returns 404 (not a stale 200 with someone else's text).
 *
 * Run: npx tsx --test server/__tests__/researchManuscriptRoute.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-research-route-"));
process.env.DATA_DIR = tmpDir;

const labPath = path.join(tmpDir, "research_lab.json");

const MANUSCRIPT = `# Canonical-Agent Benchmarks

A canonical-agent must achieve at least 82% F1-score on detecting and
collapsing near-identical research framings within 70-80% synthetic streams.

This threshold is supported by converging statistical observations yet depends
heavily on currently unverified arXiv and workshop claims.`;

function seedLab(topic: any): void {
  const lab = {
    topics:      [topic],
    hypotheses:  [],
    lastUpdated: new Date().toISOString(),
    stats: {
      totalResearched:     1,
      totalPublished:      0,
      totalDeclined:       0,
      hypothesesFormed:    0,
      hypothesesConfirmed: 0,
    },
  };
  fs.writeFileSync(labPath, JSON.stringify(lab, null, 2));
}

// Lazy import so DATA_DIR env is in place first.
const engine = await import("../researchEngine.js");
const {
  buildResearchUrl,
  renderResearchManuscriptPage,
  generateResearchContent,
  RESEARCH_SITE_HOST,
} = engine;

function mkTopic(overrides: Record<string, unknown> = {}): any {
  const now = new Date().toISOString();
  return {
    id:          "research_1776334073172",
    topic:       "What benchmarked performance would an AI canonical-agent need",
    description: "Seeded for regression test",
    priority:    "high",
    status:      "approved",
    addedBy:     "agent",
    addedAt:     now,
    updatedAt:   now,
    manuscript:  MANUSCRIPT,
    conclusion:  "Publication as a preliminary report is warranted to catalyze verification experiments.",
    ...overrides,
  };
}

describe("buildResearchUrl", () => {
  it("uses the canonical public host and the stored topic id", () => {
    const url = buildResearchUrl("research_1776334073172");
    assert.equal(url, `https://${RESEARCH_SITE_HOST}/research/research_1776334073172`);
  });
});

describe("renderResearchManuscriptPage", () => {
  it("returns 200 + manuscript HTML for a stored topic", () => {
    const topic = mkTopic();
    seedLab(topic);
    const res = renderResearchManuscriptPage(topic.id);
    assert.equal(res.status, 200);
    assert.ok(res.html.includes("Canonical-Agent Benchmarks"), "body should contain manuscript heading");
    assert.ok(res.html.includes("82% F1-score"), "body should contain manuscript content");
    assert.ok(res.html.includes(topic.topic), "page title should include topic");
    assert.ok(
      res.html.includes(`href="${buildResearchUrl(topic.id)}"`),
      "canonical link should point back to the advertised URL",
    );
  });

  it("returns 404 for an unknown id (no stale fallback)", () => {
    seedLab(mkTopic());
    const res = renderResearchManuscriptPage("research_does_not_exist");
    assert.equal(res.status, 404);
    assert.ok(!res.html.includes("82% F1-score"), "404 body must not leak unrelated manuscript content");
  });

  it("returns 404 when the topic exists but has no manuscript yet", () => {
    const bare = mkTopic({ id: "research_draft_only", manuscript: undefined, status: "queued" });
    seedLab(bare);
    const res = renderResearchManuscriptPage(bare.id);
    assert.equal(res.status, 404);
  });
});

describe("generateResearchContent ↔ renderResearchManuscriptPage contract", () => {
  it("the id advertised in the X post resolves to a 200 manuscript page", async () => {
    const topic = mkTopic({ id: "research_contract_12345" });
    seedLab(topic);

    const post = await generateResearchContent();
    assert.ok(post, "post should be generated");
    // The post includes the advertised URL. Extract the id from that URL and
    // confirm the same id resolves to a 200 in the route renderer. This is
    // the exact contract the original bug violated.
    const match = post!.match(/https:\/\/[^/]+\/research\/([a-z0-9_]+)/i);
    assert.ok(match, `post should advertise a research URL; got: ${post}`);
    const advertisedId = match![1];
    assert.equal(advertisedId, topic.id, "advertised id must equal stored id");

    const res = renderResearchManuscriptPage(advertisedId);
    assert.equal(res.status, 200, "advertised URL must resolve to 200 (not 404)");
    assert.ok(res.html.includes(topic.topic));
  });
});
