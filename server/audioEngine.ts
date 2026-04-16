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
import { execSync } from "child_process";
import { DATA_DIR } from "./dataPaths.js";
import { getEpisode, getPodcastState, saveState as savePodcastState, type Episode } from "./podcastEngine.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

// ── ElevenLabs Configuration ────────────────────────────────────────────────

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const AGENT_306_VOICE_ID = "TdUwCuw4TZty7mF7GBJj";

/** Max characters per TTS request — stay under ElevenLabs limit */
const MAX_CHUNK_CHARS = 4500;

/** Directory for generated audio files */
const AUDIO_DIR = path.join(DATA_DIR, "audio");

/** Directory for static audio assets (intro/outro music) */
const ASSETS_DIR = path.join(AUDIO_DIR, "assets");

// Ensure audio directories exist
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}
if (!fs.existsSync(ASSETS_DIR)) {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

/** Check if ffmpeg is available on this system */
function isFfmpegAvailable(): boolean {
  try {
    execSync("which ffmpeg", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── State access — uses podcastEngine's in-memory state to avoid race conditions ──

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

  // Use podcastEngine's in-memory state to avoid race conditions
  const podState = getPodcastState();
  const episode = podState.episodes.find((e) => e.id === episodeId);
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

    // Update episode state — mutate podcastEngine's in-memory state directly
    // to avoid race conditions where podcastEngine's next saveState() overwrites
    // our file-based changes.
    const podState = getPodcastState();
    const liveEpisode = podState.episodes.find((e) => e.id === episodeId);
    if (liveEpisode) {
      liveEpisode.audioUrl = `data/audio/${filename}`;
      (liveEpisode as any).audioGeneratedAt = new Date().toISOString();
      liveEpisode.status = "audio_ready" as any;
      savePodcastState(podState);
      console.log(`[AudioEngine] Episode "${liveEpisode.title}" status → audio_ready`);
    }

    // Auto-stitch intro/outro music if assets exist
    try {
      await stitchFullEpisode(episodeId);
    } catch (e: any) {
      console.warn(`[AudioEngine] Music stitching skipped: ${e.message}`);
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
  const podState = getPodcastState();
  const episode = podState.episodes.find((e) => e.id === episodeId);
  if (episode?.audioUrl) {
    const altPath = path.resolve(DATA_DIR, "..", episode.audioUrl);
    if (fs.existsSync(altPath)) return altPath;
    const altPath2 = path.join(DATA_DIR, "audio", path.basename(episode.audioUrl));
    if (fs.existsSync(altPath2)) return altPath2;
  }

  return null;
}

// ── Audio asset management ─────────────────────────────────────────────────

/** Get the path to the intro music asset */
function getIntroPath(): string {
  return path.join(ASSETS_DIR, "intro.mp3");
}

/** Get the path to the outro music asset */
function getOutroPath(): string {
  return path.join(ASSETS_DIR, "outro.mp3");
}

/** Check which audio assets are available */
export function getAudioAssets(): { intro: boolean; outro: boolean } {
  return {
    intro: fs.existsSync(getIntroPath()),
    outro: fs.existsSync(getOutroPath()),
  };
}

/** Save an uploaded audio asset (intro or outro) */
export function saveAudioAsset(type: "intro" | "outro", buffer: Buffer): void {
  const filepath = type === "intro" ? getIntroPath() : getOutroPath();
  fs.writeFileSync(filepath, buffer);
  console.log(`[AudioEngine] Saved ${type} music asset — ${buffer.length} bytes`);
}

/** Get file path for an audio asset */
export function getAudioAssetPath(type: "intro" | "outro"): string | null {
  const filepath = type === "intro" ? getIntroPath() : getOutroPath();
  return fs.existsSync(filepath) ? filepath : null;
}

// ── Intro/Outro music stitching ────────────────────────────────────────────

/**
 * Stitch intro music + voice audio + outro music into a full production episode.
 * Uses ffmpeg concat filter. Falls back gracefully if ffmpeg or assets unavailable.
 */
export async function stitchFullEpisode(episodeId: string): Promise<boolean> {
  const assets = getAudioAssets();
  if (!assets.intro && !assets.outro) {
    console.log(`[AudioEngine] No intro/outro assets found — skipping stitching for ${episodeId}`);
    return false;
  }

  if (!isFfmpegAvailable()) {
    console.warn(`[AudioEngine] ffmpeg not available — cannot stitch episode ${episodeId}`);
    return false;
  }

  const voicePath = path.join(AUDIO_DIR, `episode_${episodeId}.mp3`);
  if (!fs.existsSync(voicePath)) {
    console.error(`[AudioEngine] Voice audio not found for episode ${episodeId}`);
    return false;
  }

  console.log(`[AudioEngine] Stitching intro + voice + outro for episode ${episodeId}`);

  // Build ffmpeg inputs and filter based on available assets
  const inputs: string[] = [];
  const filterParts: string[] = [];
  let streamIndex = 0;

  if (assets.intro) {
    inputs.push(`-i "${getIntroPath()}"`);
    filterParts.push(`[${streamIndex}:a]`);
    streamIndex++;
  }

  inputs.push(`-i "${voicePath}"`);
  filterParts.push(`[${streamIndex}:a]`);
  streamIndex++;

  if (assets.outro) {
    inputs.push(`-i "${getOutroPath()}"`);
    filterParts.push(`[${streamIndex}:a]`);
    streamIndex++;
  }

  const outputPath = path.join(AUDIO_DIR, `episode_${episodeId}_full.mp3`);
  const filterComplex = `${filterParts.join("")}concat=n=${streamIndex}:v=0:a=1[out]`;
  const cmd = `ffmpeg ${inputs.join(" ")} -filter_complex "${filterComplex}" -map "[out]" -y "${outputPath}"`;

  try {
    execSync(cmd, { stdio: "pipe", timeout: 120000 });
    console.log(`[AudioEngine] Stitched full episode saved to ${outputPath}`);

    // Update episode state with full audio URL
    const stitchState = getPodcastState();
    const stitchEpisode = stitchState.episodes.find((e) => e.id === episodeId);
    if (stitchEpisode) {
      (stitchEpisode as any).fullAudioUrl = `data/audio/episode_${episodeId}_full.mp3`;
      savePodcastState(stitchState);
      console.log(`[AudioEngine] Episode ${episodeId} updated with fullAudioUrl`);
    }

    return true;
  } catch (err: any) {
    console.error(`[AudioEngine] ffmpeg stitching failed for ${episodeId}:`, err.message);
    return false;
  }
}

/**
 * Get the file path for a full (stitched) episode audio.
 */
export function getFullAudioFilePath(episodeId: string): string | null {
  const filepath = path.join(AUDIO_DIR, `episode_${episodeId}_full.mp3`);
  return fs.existsSync(filepath) ? filepath : null;
}

// ── Social preview clip generation ─────────────────────────────────────────

/**
 * Generate a 30-second social preview clip from an episode.
 * Uses LLM to identify the most compelling passage, then TTS to generate audio.
 */
export async function generateSocialPreview(episodeId: string): Promise<boolean> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[AudioEngine] ELEVENLABS_API_KEY not set — cannot generate preview");
    return false;
  }

  const previewState = getPodcastState();
  const episode = previewState.episodes.find((e) => e.id === episodeId);
  if (!episode) {
    console.error(`[AudioEngine] Episode ${episodeId} not found`);
    return false;
  }

  if (!episode.script) {
    console.error(`[AudioEngine] Episode ${episodeId} has no script`);
    return false;
  }

  console.log(`[AudioEngine] Generating social preview for "${episode.title}"`);

  try {
    // Step 1: Use LLM to pick the most compelling 30-second passage
    const speechText = formatScriptForSpeech(episode);
    if (!speechText) {
      console.error(`[AudioEngine] Empty speech text for episode ${episodeId}`);
      return false;
    }

    const previewText = await selectPreviewPassage(speechText);
    if (!previewText) {
      console.error(`[AudioEngine] Failed to select preview passage for ${episodeId}`);
      return false;
    }

    console.log(`[AudioEngine] Selected preview passage: ${previewText.length} chars`);

    // Step 2: Generate TTS for the preview passage
    const audioBuffer = await callElevenLabsTTS(previewText, apiKey);
    console.log(`[AudioEngine] Preview audio generated: ${audioBuffer.length} bytes`);

    // Step 3: Save the preview audio
    const filename = `episode_${episodeId}_preview.mp3`;
    const filepath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(filepath, audioBuffer);
    console.log(`[AudioEngine] Preview saved to ${filepath}`);

    // Step 4: Update episode state via podcastEngine's in-memory state
    const previewPodState = getPodcastState();
    const freshEpisode = previewPodState.episodes.find((e) => e.id === episodeId);
    if (freshEpisode) {
      (freshEpisode as any).previewAudioUrl = `data/audio/${filename}`;
      (freshEpisode as any).previewText = previewText;
      savePodcastState(previewPodState);
      console.log(`[AudioEngine] Episode ${episodeId} updated with preview data`);
    }

    return true;
  } catch (err: any) {
    console.error(`[AudioEngine] Failed to generate social preview for ${episodeId}:`, err.message);
    return false;
  }
}

/**
 * Use LLM to select the most compelling ~30-second passage from a script.
 */
async function selectPreviewPassage(scriptText: string): Promise<string | null> {
  if (!LLM_API_KEY) {
    console.error("[AudioEngine] No LLM API key configured for preview passage selection");
    return null;
  }

  const model = getModel("social-preview");

  const response = await fetch(LLM_BASE_URL, {
    method: "POST",
    headers: getLLMHeaders(),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a podcast producer selecting the best clip for social media promotion. Return ONLY the exact text passage — no quotes, no commentary, no labels.",
        },
        {
          role: "user",
          content: `Given this podcast script, identify the single most compelling, provocative, or insight-dense passage that would make someone want to listen to the full episode.

The passage should:
- Be 50-80 words (approximately 30 seconds of speech)
- Start with a strong statement, not mid-sentence
- End on a hook or cliffhanger if possible
- Represent the core thesis or most surprising finding

Return ONLY the exact text passage, nothing else.

SCRIPT:
${scriptText}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    console.error(`[AudioEngine] LLM API error for preview selection: ${response.status} — ${errorText}`);
    return null;
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();

  if (!text || text.length < 20) {
    console.error("[AudioEngine] LLM returned empty or too-short preview passage");
    return null;
  }

  // Clean up any accidental quotes or labels
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/^(passage|clip|preview|text):\s*/i, "")
    .trim();
}

/**
 * Get the file path for a preview audio clip.
 */
export function getPreviewAudioFilePath(episodeId: string): string | null {
  const filepath = path.join(AUDIO_DIR, `episode_${episodeId}_preview.mp3`);
  return fs.existsSync(filepath) ? filepath : null;
}
