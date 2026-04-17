/**
 * PR M — Clear Episode Audio
 *
 * Tests clearEpisodeAudio():
 *   - Returns not-found error when episode ID is unknown.
 *   - Status guard: rejects draft / scripted / reviewed / shelved.
 *   - Happy path from "audio_ready": deletes candidate files, rolls status back
 *     to "reviewed", clears TTS provenance fields.
 *   - Idempotent-ish: missing audio files on disk don't block field clearing.
 *   - Accepts "produced" and "published" statuses.
 *
 * The podcast state is loaded once at module import time, so we manipulate the
 * in-memory state via getPodcastState() rather than rewriting the state file
 * between tests.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pr-m-clear-audio-"));
process.env.DATA_DIR = TMP;

// Ensure no API keys are needed for these tests
delete process.env.ELEVENLABS_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

const AUDIO_DIR = path.join(TMP, "audio");

// Seed an empty state file BEFORE importing the engines (loadState runs on
// module init), then interact with the in-memory state afterwards.
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(
  path.join(TMP, "podcast_state.json"),
  JSON.stringify({
    episodes: [],
    guests: [],
    counters: {
      totalSignalEpisodes: 0,
      totalConversationEpisodes: 0,
      totalPublished: 0,
      nextSignalNumber: 1,
      nextConversationNumber: 1,
    },
  }),
);

const { clearEpisodeAudio } = await import("../audioEngine.js");
const { getPodcastState, saveState: savePodcastState } = await import(
  "../podcastEngine.js"
);

type TestEp = {
  id: string;
  title: string;
  status: string;
  audioUrl?: string;
  audioGeneratedAt?: string;
  duration?: number;
  producedAt?: string;
  ttsProvider?: string;
  ttsVoice?: string;
  ttsCharacters?: number;
  ttsCostUsd?: number;
  script?: string;
  sources?: any[];
  reviewNotes?: string;
  episodeNumber?: number;
};

function resetState(episodes: TestEp[] = []) {
  const s = getPodcastState();
  s.episodes.splice(0, s.episodes.length, ...(episodes as any));
  savePodcastState(s);
}

function writeAudioFile(episodeId: string, suffix: "" | "_full" | "_preview" = "") {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const p = path.join(AUDIO_DIR, `episode_${episodeId}${suffix}.mp3`);
  fs.writeFileSync(p, Buffer.from("ID3\x03\x00\x00\x00fake-mp3", "binary"));
  return p;
}

function currentEp(id: string) {
  return getPodcastState().episodes.find((e: any) => e.id === id) as any;
}

describe("clearEpisodeAudio — PR M", () => {
  beforeEach(() => {
    resetState([]);
  });

  it("returns not-found error for unknown episode", () => {
    const result = clearEpisodeAudio("does-not-exist");
    assert.equal(result.ok, false);
    assert.equal(result.error, "Episode not found");
    assert.deepEqual(result.removedFiles, []);
  });

  it("status guard rejects draft", () => {
    resetState([{ id: "ep-draft", title: "Draft", status: "draft" }]);
    const result = clearEpisodeAudio("ep-draft");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /draft/);
    assert.equal(currentEp("ep-draft").status, "draft");
  });

  it("status guard rejects scripted", () => {
    resetState([{ id: "ep-scripted", title: "S", status: "scripted" }]);
    const result = clearEpisodeAudio("ep-scripted");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /scripted/);
  });

  it("status guard rejects reviewed (nothing to clear yet)", () => {
    resetState([{ id: "ep-reviewed", title: "R", status: "reviewed" }]);
    const result = clearEpisodeAudio("ep-reviewed");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /reviewed/);
  });

  it("status guard rejects shelved", () => {
    resetState([{ id: "ep-shelved", title: "Sh", status: "shelved" }]);
    const result = clearEpisodeAudio("ep-shelved");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /shelved/);
  });

  it("happy path from audio_ready — deletes files, rolls status to reviewed, clears TTS provenance", () => {
    const id = "ep-audio-ready";
    resetState([
      {
        id,
        title: "Claude Mythos 5",
        status: "audio_ready",
        audioUrl: "/data/audio/episode_ep-audio-ready.mp3",
        audioGeneratedAt: new Date().toISOString(),
        duration: 1234,
        ttsProvider: "xai",
        ttsVoice: "eve",
        ttsCharacters: 9999,
        ttsCostUsd: 0.042,
        script: "preserve me",
        sources: [{ url: "https://example.com" }],
        reviewNotes: "keep these",
        episodeNumber: 5,
      },
    ]);
    const mainFile = writeAudioFile(id);
    const fullFile = writeAudioFile(id, "_full");
    const previewFile = writeAudioFile(id, "_preview");

    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(
      [...result.removedFiles].sort(),
      [
        `episode_${id}.mp3`,
        `episode_${id}_full.mp3`,
        `episode_${id}_preview.mp3`,
      ].sort(),
    );
    assert.equal(fs.existsSync(mainFile), false);
    assert.equal(fs.existsSync(fullFile), false);
    assert.equal(fs.existsSync(previewFile), false);

    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    // Cleared fields
    assert.equal(ep.audioUrl, undefined);
    assert.equal(ep.audioGeneratedAt, undefined);
    assert.equal(ep.duration, undefined);
    assert.equal(ep.producedAt, undefined);
    assert.equal(ep.ttsProvider, undefined);
    assert.equal(ep.ttsVoice, undefined);
    assert.equal(ep.ttsCharacters, undefined);
    assert.equal(ep.ttsCostUsd, undefined);
    // Preserved fields
    assert.equal(ep.script, "preserve me");
    assert.equal(ep.reviewNotes, "keep these");
    assert.equal(ep.episodeNumber, 5);
    assert.equal(ep.title, "Claude Mythos 5");
    assert.ok(Array.isArray(ep.sources) && ep.sources.length === 1);
  });

  it("accepts produced status and clears provenance", () => {
    const id = "ep-produced";
    resetState([
      {
        id,
        title: "Produced Ep",
        status: "produced",
        producedAt: new Date().toISOString(),
        ttsProvider: "elevenlabs",
        ttsVoice: "matilda",
      },
    ]);
    writeAudioFile(id);

    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    assert.equal(ep.producedAt, undefined);
    assert.equal(ep.ttsProvider, undefined);
  });

  it("accepts published status", () => {
    const id = "ep-published";
    resetState([
      {
        id,
        title: "Published Ep",
        status: "published",
        audioUrl: "/x",
        ttsProvider: "xai",
      },
    ]);
    // No file on disk — field clearing should still succeed
    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.removedFiles, []);
    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    assert.equal(ep.audioUrl, undefined);
    assert.equal(ep.ttsProvider, undefined);
  });

  it("missing audio files on disk do not block status rollback", () => {
    const id = "ep-no-files";
    resetState([
      {
        id,
        title: "Ghost",
        status: "audio_ready",
        audioUrl: "/stale",
        ttsProvider: "xai",
      },
    ]);
    // Intentionally do NOT create any files
    const result = clearEpisodeAudio(id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.removedFiles, []);
    const ep = currentEp(id);
    assert.equal(ep.status, "reviewed");
    assert.equal(ep.audioUrl, undefined);
  });
});
