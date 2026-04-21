/**
 * Tests for generatePodcastContent(episodeId?).
 *
 * User bug: podcast promos went to drafts with no episode link —
 * because the generate handler had no way to pick which episode to
 * promote, callers ended up with a generic teaser. The fix accepts
 * an optional `episodeId` param: when set, promote that specific
 * published episode; when omitted, fall back to the most recent
 * (legacy behaviour).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "podcast-picker-"));
process.env.DATA_DIR = TMP;

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Seed podcast_state.json BEFORE import — podcastEngine loads state
// into a module-level singleton on first import.
const epOld = {
  id: "ep_old",
  type: "signal",
  title: "Old Episode",
  episodeNumber: 1,
  status: "published",
  publishedAt: "2026-03-15T00:00:00Z",
  episodeUrl: "https://agent306.ai/podcast/old",
  metadata: { socialPost: "Listen to the old drop [LINK]" },
};

const epNew = {
  id: "ep_new",
  type: "signal",
  title: "New Episode",
  episodeNumber: 2,
  status: "published",
  publishedAt: "2026-04-20T00:00:00Z",
  episodeUrl: "https://agent306.ai/podcast/new",
  metadata: { socialPost: "Listen to the new drop [LINK]" },
};

fs.writeFileSync(path.join(TMP, "podcast_state.json"), JSON.stringify({
  episodes: [epOld, epNew],
  guests: [],
  counters: {
    totalSignalEpisodes: 2,
    totalConversationEpisodes: 0,
    totalPublished: 2,
    nextSignalNumber: 3,
    nextConversationNumber: 1,
  },
}));

const { generatePodcastContent } = await import("../podcastEngine.js");

test("no episodeId → promotes the most recent published episode (legacy behaviour)", async () => {
  const content = await generatePodcastContent();
  assert.ok(content, "expected content");
  assert.ok(content!.includes("new"),
    "default pick should promote the newer episode (ep_new)");
  assert.ok(!content!.includes("old drop"),
    "old episode body should not leak when no episodeId is given");
});

test("explicit episodeId → promotes that specific episode", async () => {
  const content = await generatePodcastContent("ep_old");
  assert.ok(content, "expected content");
  assert.ok(content!.includes("old"),
    "when episodeId=ep_old is passed, we should get the old episode's promo");
  assert.ok(content!.includes("agent306.ai/podcast/old"),
    "promo should link to the chosen episode's URL");
});

test("unknown episodeId → returns null (not silent fallback)", async () => {
  const content = await generatePodcastContent("ep_does_not_exist");
  assert.equal(content, null,
    "unknown episodeId should return null so the caller can surface the error");
});
