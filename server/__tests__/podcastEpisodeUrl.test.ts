/**
 * Tests for the per-episode URL field (server/podcastEngine.ts).
 *
 * Added 2026-04-21. Covers:
 *   - setEpisodeUrl(id, url) attaches the URL and persists
 *   - setEpisodeUrl(id, null) clears it
 *   - setEpisodeUrl(id, "") (empty string) clears it
 *   - Unknown episode id returns null
 *   - generatePodcastContent() uses episodeUrl when set (via resolveSocialLinks)
 *     and falls back to PODCAST_SITE_URL when not set
 *
 * We redirect DATA_DIR to a temp dir BEFORE importing podcastEngine so module
 * state loads from our isolated file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "podcast-episode-url-"));
process.env.DATA_DIR = TMP;

// No API keys — keep generatePodcastContent's LLM paths out of reach.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

// Seed a published episode with a known socialPost so generatePodcastContent
// deterministically returns a resolved string using resolveSocialLinks.
const PUBLISHED_EPISODE = {
  id:          "ep_test_1",
  createdAt:   "2026-04-20T00:00:00.000Z",
  type:        "the_signal" as const,
  status:      "published" as const,
  title:       "A very important episode",
  drivingQuestion: "Why does this matter?",
  episodeNumber: 42,
  publishedAt: "2026-04-20T10:00:00.000Z",
  // socialPost contains a [LINK] placeholder that resolveSocialLinks substitutes.
  metadata: {
    shortDescription: "short",
    longDescription:  "long",
    pollQuestion:     "q?",
    pollOptions:      ["a", "b", "c"],
    socialPost:       "New signal drop — listen: [LINK]",
    socialThread:     "thread",
    keywords:         ["ai"],
  },
};

fs.writeFileSync(
  path.join(TMP, "podcast_state.json"),
  JSON.stringify({
    episodes: [PUBLISHED_EPISODE],
    guests:   [],
    counters: {
      totalSignalEpisodes:       1,
      totalConversationEpisodes: 0,
      totalPublished:            1,
      nextSignalNumber:          43,
      nextConversationNumber:    1,
    },
  }),
);

const {
  setEpisodeUrl,
  generatePodcastContent,
  getEpisode,
  PODCAST_SITE_URL,
} = await import("../podcastEngine.js");

// ── setEpisodeUrl ──────────────────────────────────────────────────────────

test("setEpisodeUrl attaches the URL to the episode and persists it", () => {
  const url = "https://open.spotify.com/episode/abc123";
  const ep = setEpisodeUrl("ep_test_1", url);
  assert.ok(ep, "should return the updated episode");
  assert.equal(ep!.episodeUrl, url);

  // Round-trip via getEpisode (which reads the module's in-memory state).
  assert.equal(getEpisode("ep_test_1")?.episodeUrl, url);

  // And round-trip via the on-disk file.
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "podcast_state.json"), "utf8"));
  const persisted = onDisk.episodes.find((e: any) => e.id === "ep_test_1");
  assert.equal(persisted.episodeUrl, url, "episodeUrl should persist to podcast_state.json");
});

test("setEpisodeUrl(id, null) clears the URL", () => {
  setEpisodeUrl("ep_test_1", "https://example.com/ep");
  const ep = setEpisodeUrl("ep_test_1", null);
  assert.ok(ep);
  assert.equal(ep!.episodeUrl, undefined,
    "passing null should unset episodeUrl");

  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, "podcast_state.json"), "utf8"));
  const persisted = onDisk.episodes.find((e: any) => e.id === "ep_test_1");
  assert.equal(persisted.episodeUrl, undefined,
    "cleared episodeUrl should not appear in the persisted JSON");
});

test("setEpisodeUrl(id, '') also clears the URL", () => {
  setEpisodeUrl("ep_test_1", "https://example.com/ep");
  const ep = setEpisodeUrl("ep_test_1", "");
  assert.ok(ep);
  assert.equal(ep!.episodeUrl, undefined,
    "passing empty string should unset episodeUrl");
});

test("setEpisodeUrl for unknown episode returns null", () => {
  assert.equal(setEpisodeUrl("ep_does_not_exist", "https://x.com"), null);
});

// ── generatePodcastContent uses episodeUrl when set ───────────────────────

test("generatePodcastContent links to episodeUrl when one is set", async () => {
  const url = "https://open.spotify.com/episode/xyz789";
  setEpisodeUrl("ep_test_1", url);

  const content = await generatePodcastContent();
  assert.ok(content, "generatePodcastContent should return text");
  assert.ok(content!.includes(url),
    `generated content should contain the per-episode URL. Got: ${content}`);
  assert.ok(!content!.includes("[LINK]"),
    "resolveSocialLinks should have substituted the [LINK] placeholder");
});

test("generatePodcastContent falls back to PODCAST_SITE_URL when episodeUrl is not set", async () => {
  setEpisodeUrl("ep_test_1", null);

  const content = await generatePodcastContent();
  assert.ok(content, "generatePodcastContent should return text");
  assert.ok(content!.includes(PODCAST_SITE_URL),
    `with no episodeUrl set, content should link to ${PODCAST_SITE_URL}. Got: ${content}`);
});
