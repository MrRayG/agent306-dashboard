/**
 * ─────────────────────────────────────────────────────────────
 *  AUDIO ENGINE — ElevenLabs TTS Integration
 *
 *  Converts reviewed podcast scripts to audio using Agent 306's
 *  custom ElevenLabs voice. Handles chunking for long scripts
 *  and saves MP3 files to data/audio/.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { dataPath, DATA_DIR } from "./dataPaths.js";
import { getEpisode, type Episode } from "./podcastEngine.js";

// ── ElevenLabs Configuration ────────────────────────────────────────────────

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const AGENT_306_VOICE_ID = "TdUwCuw4TZty7mF7GBJj";

/** Max characters per TTS request — stay under ElevenLabs limit */
const MAX_CHUNK_CHARS = 4500;

/** Directory for generated audio files */
const AUDIO_DIR = path.join(DATA_DIR, "audio");

// Ensure audio directory exists
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// ── State file (same pattern as podcastEngine) ──────────────────────────────

const PODCAST_FILE = dataPath("podcast_state.json");

interface PodcastState {
  episodes: Episode[];
  guests: any[];
  counters: any;
}

function loadState(): PodcastState {
  try {
    return JSON.parse(fs.readFileSync(PODCAST_FILE, "utf-8"));
  } catch {
    return { episodes: [], guests: [], counters: {} };
  }
}

function saveState(s: PodcastState) {
  try {
    fs.writeFileSync(PODCAST_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

// ── Script formatting ───────────────────────────────────────────────────────

/**
 * Strip section headers and formatting, keeping only spoken content.
 * Adds natural pauses (paragraph breaks) between sections.
 */
function formatScriptForSpeech(episode: Episode): string {
  if (!episode.script) return "";

  const sections = [
    episode.script.coldOpen,
    episode.script.actOne,
    episode.script.actTwo,
    episode.script.actThree,
    episode.script.outro,
  ].filter(Boolean);

  // Clean each section: remove section headers like "COLD OPEN", "ACT 1", etc.
  const cleaned = sections.map((section) => {
    return section
      .replace(/^(COLD\s*(OPEN|INTRO)|ACT\s*(ONE|TWO|THREE|[1-3])|OUTRO|SIGN[- ]?OFF|INTRO)[:\s—\-]*/gim, "")
      .replace(/^─+$/gm, "")
      .replace(/^═+$/gm, "")
      .replace(/^\s*\n/gm, "\n")
      .trim();
  });

  // Join with paragraph breaks for natural pauses
  return cleaned.join("\n\n\n").trim();
}

// ── Chunking ────────────────────────────────────────────────────────────────

/**
 * Split text into chunks at natural paragraph breaks, respecting the
 * character limit per request.
 */
function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // If adding this paragraph would exceed the limit, push the current chunk
    if (current.length > 0 && current.length + para.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

// ── ElevenLabs API call ─────────────────────────────────────────────────────

async function callElevenLabsTTS(text: string, apiKey: string): Promise<Buffer> {
  const url = `${ELEVENLABS_API_URL}/${AGENT_306_VOICE_ID}`;

  console.log(`[AudioEngine] Calling ElevenLabs TTS — ${text.length} characters`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.5,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`ElevenLabs API error ${res.status}: ${errorText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Main generation function ────────────────────────────────────────────────

/**
 * Generate audio for a reviewed episode using ElevenLabs TTS.
 *
 * 1. Loads the episode and formats the script for speech
 * 2. Chunks the text if it exceeds the character limit
 * 3. Calls ElevenLabs TTS for each chunk
 * 4. Concatenates MP3 buffers into a single file
 * 5. Updates episode with audio URL and status
 */
export async function generateAudio(episodeId: string): Promise<boolean> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[AudioEngine] ELEVENLABS_API_KEY not set — cannot generate audio");
    return false;
  }

  // Re-read state fresh to avoid stale references
  const state = loadState();
  const episode = state.episodes.find((e) => e.id === episodeId);
  if (!episode) {
    console.error(`[AudioEngine] Episode ${episodeId} not found`);
    return false;
  }

  if (episode.status !== "reviewed") {
    console.error(`[AudioEngine] Episode ${episodeId} is not in "reviewed" status (current: ${episode.status})`);
    return false;
  }

  if (!episode.script) {
    console.error(`[AudioEngine] Episode ${episodeId} has no script`);
    return false;
  }

  console.log(`[AudioEngine] Generating audio for "${episode.title}"...`);

  try {
    // Format script for speech
    const speechText = formatScriptForSpeech(episode);
    if (!speechText) {
      console.error(`[AudioEngine] Empty speech text for episode ${episodeId}`);
      return false;
    }

    console.log(`[AudioEngine] Script formatted: ${speechText.length} characters`);

    // Chunk if needed
    const chunks = chunkText(speechText, MAX_CHUNK_CHARS);
    console.log(`[AudioEngine] Split into ${chunks.length} chunk(s)`);

    // Generate audio for each chunk
    const audioBuffers: Buffer[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[AudioEngine] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      const buffer = await callElevenLabsTTS(chunks[i], apiKey);
      audioBuffers.push(buffer);
      console.log(`[AudioEngine] Chunk ${i + 1} complete — ${buffer.length} bytes`);
    }

    // Concatenate MP3 buffers
    const fullAudio = Buffer.concat(audioBuffers);
    console.log(`[AudioEngine] Total audio: ${fullAudio.length} bytes`);

    // Save to file
    const filename = `episode_${episodeId}.mp3`;
    const filepath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(filepath, fullAudio);
    console.log(`[AudioEngine] Saved to ${filepath}`);

    // Update episode state — re-read state to avoid race conditions
    const freshState = loadState();
    const freshEpisode = freshState.episodes.find((e) => e.id === episodeId);
    if (freshEpisode) {
      freshEpisode.audioUrl = `data/audio/${filename}`;
      (freshEpisode as any).audioGeneratedAt = new Date().toISOString();
      freshEpisode.status = "audio_ready" as any;
      saveState(freshState);
      console.log(`[AudioEngine] Episode "${freshEpisode.title}" status → audio_ready`);
    }

    return true;
  } catch (err: any) {
    console.error(`[AudioEngine] Failed to generate audio for ${episodeId}:`, err.message);
    return false;
  }
}

// ── Audio file serving ──────────────────────────────────────────────────────

/**
 * Get the file path for an episode's audio file.
 * Returns null if the file doesn't exist.
 */
export function getAudioFilePath(episodeId: string): string | null {
  // Check directly by episode ID
  const filename = `episode_${episodeId}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);
  if (fs.existsSync(filepath)) return filepath;

  // Fall back to checking the episode's audioUrl field
  const state = loadState();
  const episode = state.episodes.find((e) => e.id === episodeId);
  if (episode?.audioUrl) {
    const altPath = path.resolve(DATA_DIR, "..", episode.audioUrl);
    if (fs.existsSync(altPath)) return altPath;
    const altPath2 = path.join(DATA_DIR, "audio", path.basename(episode.audioUrl));
    if (fs.existsSync(altPath2)) return altPath2;
  }

  return null;
}
