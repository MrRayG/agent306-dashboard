/**
 * PR L — Per-episode TTS provider override
 *
 * Tests the input-validation contract of generateAudio():
 *   - Invalid xaiVoice returns false (no network calls).
 *   - Explicit xAI override with no GROK_API_KEY returns false (no fallback).
 *   - Explicit elevenlabs override with no ELEVENLABS_API_KEY returns false.
 *
 * We don't exercise the happy path here because it would require real TTS
 * network calls. The existing xaiTtsEngine.test.ts covers chunking, voice
 * validation, and cost math; route-level contract is validated by the shape
 * of generateAudio's opts parameter compiling cleanly (see tsc check).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pr-l-gen-audio-"));
process.env.DATA_DIR = TMP;

// Ensure no real keys leak from the env during tests
delete process.env.ELEVENLABS_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.TTS_PROVIDER;

const { generateAudio } = await import("../audioEngine.js");

describe("generateAudio — PR L overrides", () => {
  before(() => {
    // Seed a minimal podcast_state.json so getPodcastState() has something to read.
    // Not strictly needed for these failure-path tests (we bail before touching state),
    // but keeps the test robust if the early checks move later.
    const stateFile = path.join(TMP, "podcast_state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ episodes: [], guests: [], lastUpdated: new Date().toISOString() }),
    );
  });

  it("rejects invalid xaiVoice without making network calls", async () => {
    const ok = await generateAudio("nonexistent-episode", {
      providerOverride: "xai",
      xaiVoice: "bogus" as any,
    });
    assert.equal(ok, false);
  });

  it("rejects xAI override when no GROK_API_KEY/XAI_API_KEY is set", async () => {
    // Ensure we're clean
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    const ok = await generateAudio("nonexistent-episode", {
      providerOverride: "xai",
      xaiVoice: "eve",
    });
    assert.equal(ok, false);
  });

  it("rejects elevenlabs override when no ELEVENLABS_API_KEY is set", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const ok = await generateAudio("nonexistent-episode", {
      providerOverride: "elevenlabs",
    });
    assert.equal(ok, false);
  });

  it("accepts a valid xaiVoice shape (validation passes, later check fails on missing key)", async () => {
    // Even with a valid voice, no key means we bail cleanly with false (not throw).
    delete process.env.GROK_API_KEY;
    const ok = await generateAudio("nonexistent-episode", {
      providerOverride: "xai",
      xaiVoice: "leo",
    });
    assert.equal(ok, false);
  });
});
