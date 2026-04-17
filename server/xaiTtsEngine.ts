/**
 * ─────────────────────────────────────────────────────────────
 *  306 — xAI TTS ENGINE  (parallel to audioEngine.ts)
 *
 *  Optional xAI text-to-speech provider. Runs alongside the
 *  ElevenLabs-backed audioEngine behind a feature flag:
 *
 *    TTS_PROVIDER = "elevenlabs" (default) | "xai"
 *
 *  Scope for PR H (v1): PODCAST long-form only. Dispatches /
 *  voice posts continue to use voiceEngine.ts → ElevenLabs.
 *
 *  Voice:
 *    - Default: "eve" (configurable via TTS_XAI_VOICE)
 *    - Available per docs.x.ai: ara, eve, leo, rex, sal
 *
 *  Pricing: $4.20 / 1M characters (xAI)
 *  vs ElevenLabs Multilingual v2: ~$18 / 1M characters at the
 *  Creator tier — roughly 4x cheaper.
 *
 *  Rate limits: 3,000 RPM / 50 RPS / 15,000 chars per request.
 *
 *  Graceful fallback: any failure here throws; the caller in
 *  audioEngine.ts catches and retries via ElevenLabs so episode
 *  generation never breaks on a provider swap.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";

// ── Config ──────────────────────────────────────────────────────────────────

const XAI_TTS_API_URL = "https://api.x.ai/v1/audio/speech";
const XAI_TTS_MODEL = process.env.TTS_XAI_MODEL ?? "grok-tts-1";

/** Max characters per xAI TTS request (per docs.x.ai) */
export const XAI_MAX_CHUNK_CHARS = 15000;

/** Cost: $4.20 per 1M characters */
const XAI_COST_PER_CHAR = 4.2 / 1_000_000;

/** Valid xAI TTS voices */
export const XAI_VOICES = ["ara", "eve", "leo", "rex", "sal"] as const;
export type XaiVoice = (typeof XAI_VOICES)[number];

/** Default voice for 306 */
export const DEFAULT_XAI_VOICE: XaiVoice =
  (XAI_VOICES as readonly string[]).includes(process.env.TTS_XAI_VOICE ?? "")
    ? (process.env.TTS_XAI_VOICE as XaiVoice)
    : "eve";

const STATS_FILE = dataPath("tts_stats.json");

// ── Types ───────────────────────────────────────────────────────────────────

export type TtsProvider = "elevenlabs" | "xai";

interface TtsStats {
  byProvider: Record<TtsProvider, {
    calls: number;
    characters: number;
    cost: number;
    lastCallAt: string | null;
  }>;
  byEpisode: Record<string, {
    provider: TtsProvider;
    voice: string;
    characters: number;
    cost: number;
    generatedAt: string;
  }>;
}

function emptyStats(): TtsStats {
  return {
    byProvider: {
      elevenlabs: { calls: 0, characters: 0, cost: 0, lastCallAt: null },
      xai: { calls: 0, characters: 0, cost: 0, lastCallAt: null },
    },
    byEpisode: {},
  };
}

// ── Feature flag ────────────────────────────────────────────────────────────

/**
 * Read the active TTS provider from env.
 * Defaults to "elevenlabs" to preserve existing behaviour when the flag
 * is unset. Any unknown value also falls back to elevenlabs.
 */
export function getTtsProvider(): TtsProvider {
  const raw = (process.env.TTS_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "xai") return "xai";
  return "elevenlabs";
}

// ── Stats ───────────────────────────────────────────────────────────────────

function loadStats(): TtsStats {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      // Merge with empty to tolerate older shapes
      const empty = emptyStats();
      return {
        byProvider: { ...empty.byProvider, ...(parsed.byProvider ?? {}) },
        byEpisode: { ...(parsed.byEpisode ?? {}) },
      };
    }
  } catch {
    /* fall through */
  }
  return emptyStats();
}

function saveStats(stats: TtsStats): void {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e: any) {
    console.warn("[xaiTts] Failed to save tts_stats.json:", e.message);
  }
}

export function getTtsStats(): TtsStats {
  return loadStats();
}

/**
 * Record a TTS generation event. Called after a successful call by either
 * provider so the dashboard can compare real costs side-by-side.
 */
export function recordTtsCall(opts: {
  provider: TtsProvider;
  characters: number;
  cost: number;
  episodeId?: string;
  voice?: string;
}): void {
  const stats = loadStats();
  const bucket = stats.byProvider[opts.provider];
  bucket.calls += 1;
  bucket.characters += opts.characters;
  bucket.cost += opts.cost;
  bucket.lastCallAt = new Date().toISOString();

  if (opts.episodeId) {
    stats.byEpisode[opts.episodeId] = {
      provider: opts.provider,
      voice: opts.voice ?? "",
      characters: opts.characters,
      cost: opts.cost,
      generatedAt: new Date().toISOString(),
    };
  }
  saveStats(stats);
}

// ── Cost helper ─────────────────────────────────────────────────────────────

/** Estimate xAI TTS cost for a given character count */
export function estimateXaiTtsCost(characters: number): number {
  return Math.max(0, characters) * XAI_COST_PER_CHAR;
}

// ── Chunking (mirrors audioEngine but with 15k limit) ───────────────────────

/**
 * Split text into chunks at natural paragraph breaks, respecting the
 * character limit per request. Exported for reuse + tests.
 */
export function chunkTextForXai(text: string, maxChars: number = XAI_MAX_CHUNK_CHARS): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // Single paragraph larger than the limit — hard-split on sentence boundary
    if (para.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      const sentences = para.split(/(?<=[.!?])\s+/);
      let subCurrent = "";
      for (const sent of sentences) {
        if (subCurrent.length + sent.length + 1 > maxChars && subCurrent) {
          chunks.push(subCurrent.trim());
          subCurrent = sent;
        } else {
          subCurrent = subCurrent ? `${subCurrent} ${sent}` : sent;
        }
      }
      if (subCurrent.trim()) current = subCurrent;
      continue;
    }

    if (current.length > 0 && current.length + para.length + 2 > maxChars) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── xAI API call ────────────────────────────────────────────────────────────

/**
 * Low-level call to xAI TTS. Returns an MP3 buffer.
 * Throws on any non-2xx response so callers can fall back to ElevenLabs.
 */
export async function callXaiTts(opts: {
  text: string;
  voice?: XaiVoice;
  apiKey?: string;
}): Promise<Buffer> {
  const apiKey = opts.apiKey ?? process.env.GROK_API_KEY ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("GROK_API_KEY not set — cannot call xAI TTS");
  }
  const voice: XaiVoice = opts.voice ?? DEFAULT_XAI_VOICE;
  if (!(XAI_VOICES as readonly string[]).includes(voice)) {
    throw new Error(`Invalid xAI voice "${voice}". Valid: ${XAI_VOICES.join(", ")}`);
  }
  if (!opts.text || opts.text.length === 0) {
    throw new Error("xAI TTS: empty text");
  }
  if (opts.text.length > XAI_MAX_CHUNK_CHARS) {
    throw new Error(
      `xAI TTS: text exceeds ${XAI_MAX_CHUNK_CHARS} chars (got ${opts.text.length}). Chunk first via chunkTextForXai().`,
    );
  }

  console.log(`[xaiTts] Calling xAI TTS (voice=${voice}) — ${opts.text.length} chars`);

  const res = await fetch(XAI_TTS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      model: XAI_TTS_MODEL,
      voice,
      input: opts.text,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`xAI TTS ${res.status}: ${errorText.slice(0, 400)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Generate audio for arbitrary text, handling chunking + concatenation.
 * Returns a single MP3 buffer and the totals used for stats.
 */
export async function generateXaiAudio(opts: {
  text: string;
  voice?: XaiVoice;
  episodeId?: string;
}): Promise<{ buffer: Buffer; characters: number; cost: number; voice: XaiVoice; chunks: number }> {
  const voice: XaiVoice = opts.voice ?? DEFAULT_XAI_VOICE;
  const chunks = chunkTextForXai(opts.text);
  if (chunks.length === 0) {
    throw new Error("xAI TTS: no chunks produced (empty input?)");
  }

  console.log(`[xaiTts] Generating ${chunks.length} chunk(s) at voice=${voice}`);

  const buffers: Buffer[] = [];
  let totalChars = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[xaiTts] Chunk ${i + 1}/${chunks.length} — ${chunk.length} chars`);
    const buf = await callXaiTts({ text: chunk, voice });
    buffers.push(buf);
    totalChars += chunk.length;
  }

  const full = Buffer.concat(buffers);
  const cost = estimateXaiTtsCost(totalChars);

  recordTtsCall({
    provider: "xai",
    characters: totalChars,
    cost,
    episodeId: opts.episodeId,
    voice,
  });

  console.log(
    `[xaiTts] Done — ${full.length} bytes, ${totalChars} chars, ~$${cost.toFixed(4)} (voice=${voice})`,
  );

  return { buffer: full, characters: totalChars, cost, voice, chunks: chunks.length };
}
