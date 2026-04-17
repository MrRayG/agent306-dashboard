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
import { getTtsProvider, callXaiTts, recordTtsCall, estimateXaiTtsCost, DEFAULT_XAI_VOICE, XAI_VOICES, type XaiVoice, type TtsProvider } from "./xaiTtsEngine.js";

import { postChatCompletions } from "./llmCall.js";
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

// ── Provider-aware TTS call ─────────────────────────────────────────────────

/**
 * Call the active TTS provider for a single chunk.
 *
 * Provider resolution (highest precedence first):
 *   1. opts.providerOverride        — per-episode UI selection (PR L)
 *   2. TTS_PROVIDER env var         — global default
 *   3. "elevenlabs"                 — implicit fallback
 *
 * Behavior on failure:
 *   - If providerOverride is set (explicit A/B selection), xAI failures
 *     are re-thrown — we do NOT silently fall back to ElevenLabs. A hard
 *     error preserves the integrity of the A/B comparison.
 *   - If provider was chosen implicitly via env var, xAI failures fall
 *     back to ElevenLabs so production never breaks on a provider swap.
 */
async function callTtsForChunk(
  text: string,
  elevenLabsKey: string,
  opts?: { episodeId?: string; providerOverride?: TtsProvider; xaiVoice?: XaiVoice },
): Promise<{ buffer: Buffer; provider: "elevenlabs" | "xai"; voice: string; cost: number }> {
  const isExplicitOverride = !!opts?.providerOverride;
  const provider: TtsProvider = opts?.providerOverride ?? getTtsProvider();

  if (provider === "xai") {
    try {
      const voice: XaiVoice = opts?.xaiVoice ?? DEFAULT_XAI_VOICE;
      const buffer = await callXaiTts({ text, voice });
      const cost = estimateXaiTtsCost(text.length);
      recordTtsCall({
        provider: "xai",
        characters: text.length,
        cost,
        episodeId: opts?.episodeId,
        voice,
      });
      return { buffer, provider: "xai", voice, cost };
    } catch (e: any) {
      if (isExplicitOverride) {
        // Hard-fail on explicit override — do not silently swap to ElevenLabs.
        console.error(
          `[AudioEngine] xAI TTS failed (${e.message}) — hard-fail (explicit override, no fallback)`,
        );
        throw new Error(`xAI TTS failed: ${e.message}`);
      }
      console.warn(
        `[AudioEngine] xAI TTS failed (${e.message}) — falling back to ElevenLabs for this chunk`,
      );
      // fall through to ElevenLabs below (implicit provider only)
    }
  }

  const buffer = await callElevenLabsTTS(text, elevenLabsKey);
  // ElevenLabs cost is approximate — Creator tier is ~$0.18/1k chars = $18 / 1M.
  const cost = text.length * (18 / 1_000_000);
  recordTtsCall({
    provider: "elevenlabs",
    characters: text.length,
    cost,
    episodeId: opts?.episodeId,
    voice: AGENT_306_VOICE_ID,
  });
  return { buffer, provider: "elevenlabs", voice: AGENT_306_VOICE_ID, cost };
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
export async function generateAudio(
  episodeId: string,
  opts?: { providerOverride?: TtsProvider; xaiVoice?: XaiVoice },
): Promise<boolean> {
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const xaiKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "";
  const effectiveProvider: TtsProvider = opts?.providerOverride ?? getTtsProvider();

  // Validate xAI voice early — never let bad input hit the provider.
  if (opts?.xaiVoice && !(XAI_VOICES as readonly string[]).includes(opts.xaiVoice)) {
    console.error(`[AudioEngine] Invalid xAI voice "${opts.xaiVoice}". Valid: ${XAI_VOICES.join(", ")}`);
    return false;
  }

  // Credential check per effective provider.
  // For explicit override we require the chosen provider's key outright — no silent fallback.
  if (effectiveProvider === "xai") {
    if (!xaiKey) {
      console.error("[AudioEngine] xAI provider requested but GROK_API_KEY/XAI_API_KEY is not set");
      return false;
    }
  } else if (!apiKey) {
    console.error("[AudioEngine] ElevenLabs provider requested but ELEVENLABS_API_KEY is not set");
    return false;
  }

  if (opts?.providerOverride) {
    console.log(
      `[AudioEngine] Per-episode override active — provider=${effectiveProvider}` +
        (opts.xaiVoice ? `, voice=${opts.xaiVoice}` : ""),
    );
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

    // Generate audio for each chunk — per-episode override wins over TTS_PROVIDER flag
    const audioBuffers: Buffer[] = [];
    const providersUsed = new Set<string>();
    const voicesUsed = new Set<string>();
    let totalCost = 0;
    let totalChars = 0;
    for (let i = 0; i < chunks.length; i++) {
      console.log(`[AudioEngine] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      const { buffer, provider, voice, cost } = await callTtsForChunk(chunks[i], apiKey, {
        episodeId,
        providerOverride: opts?.providerOverride,
        xaiVoice: opts?.xaiVoice,
      });
      audioBuffers.push(buffer);
      providersUsed.add(provider);
      voicesUsed.add(voice);
      totalCost += cost;
      totalChars += chunks[i].length;
      console.log(`[AudioEngine] Chunk ${i + 1} complete — ${buffer.length} bytes (provider=${provider}, voice=${voice})`);
    }
    console.log(`[AudioEngine] Providers used for ${episodeId}: ${Array.from(providersUsed).join(", ")}`);

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
      // Stamp TTS provenance so the UI can show what was used (PR L)
      const primaryProvider = providersUsed.size === 1 ? Array.from(providersUsed)[0] : "mixed";
      const primaryVoice = voicesUsed.size === 1 ? Array.from(voicesUsed)[0] : "mixed";
      (liveEpisode as any).ttsProvider = primaryProvider;
      (liveEpisode as any).ttsVoice = primaryVoice;
      (liveEpisode as any).ttsCharacters = totalChars;
      (liveEpisode as any).ttsCostUsd = Math.round(totalCost * 10000) / 10000;
      savePodcastState(podState);
      console.log(`[AudioEngine] Episode "${liveEpisode.title}" status → audio_ready (provider=${primaryProvider}, voice=${primaryVoice}, $${totalCost.toFixed(4)})`);
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
 * Clear all generated audio for an episode and roll its status back to "reviewed"
 * so it can be regenerated (e.g. with a different TTS provider for A/B comparison).
 *
 * Deletes:
 *   - Voice-only MP3 (episode_<id>.mp3)
 *   - Stitched full episode MP3 with intro/outro (episode_<id>_full.mp3)
 *   - Social preview MP3 (episode_<id>_preview.mp3)
 *
 * Preserves: script, sources, metadata, reviewNotes, episodeNumber.
 * Clears: audioUrl, audioGeneratedAt, duration, producedAt,
 *         ttsProvider, ttsVoice, ttsCharacters, ttsCostUsd.
 *
 * Only valid when current status is audio_ready, produced, or published.
 */
export function clearEpisodeAudio(episodeId: string): {
  ok: boolean;
  removedFiles: string[];
  error?: string;
} {
  const podState = getPodcastState();
  const episode = podState.episodes.find((e) => e.id === episodeId);
  if (!episode) {
    return { ok: false, removedFiles: [], error: "Episode not found" };
  }

  const clearable = ["audio_ready", "produced", "published"];
  if (!clearable.includes(episode.status)) {
    return {
      ok: false,
      removedFiles: [],
      error: `Episode status is "${episode.status}" — nothing to clear (expected one of: ${clearable.join(", ")})`,
    };
  }

  const candidates = [
    path.join(AUDIO_DIR, `episode_${episodeId}.mp3`),
    path.join(AUDIO_DIR, `episode_${episodeId}_full.mp3`),
    path.join(AUDIO_DIR, `episode_${episodeId}_preview.mp3`),
  ];

  const removed: string[] = [];
  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        removed.push(path.basename(fp));
      }
    } catch (e: any) {
      console.warn(`[AudioEngine] Could not delete ${fp}: ${e.message}`);
    }
  }

  // Roll episode back to reviewed and clear audio provenance
  episode.status = "reviewed" as any;
  delete (episode as any).audioUrl;
  delete (episode as any).audioGeneratedAt;
  delete (episode as any).duration;
  delete (episode as any).producedAt;
  delete (episode as any).ttsProvider;
  delete (episode as any).ttsVoice;
  delete (episode as any).ttsCharacters;
  delete (episode as any).ttsCostUsd;
  savePodcastState(podState);

  console.log(
    `[AudioEngine] Cleared audio for "${episode.title}" — removed ${removed.length} file(s), status → reviewed`,
  );
  return { ok: true, removedFiles: removed };
}

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
  const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
  const provider = getTtsProvider();
  const xaiKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "";
  if (!apiKey && !(provider === "xai" && xaiKey)) {
    console.error("[AudioEngine] No TTS provider credentials available for preview");
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

    // Step 2: Generate TTS for the preview passage (provider-aware)
    const { buffer: audioBuffer, provider } = await callTtsForChunk(previewText, apiKey, { episodeId });
    console.log(`[AudioEngine] Preview audio generated: ${audioBuffer.length} bytes (provider=${provider})`);

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

  const response = await postChatCompletions({
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
