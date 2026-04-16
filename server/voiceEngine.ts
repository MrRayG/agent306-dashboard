// ─────────────────────────────────────────────────────────────────────────────
// 306 — VOICE ENGINE
// Agent 306 speaks. Every post, every dispatch, every reflection
// gets a voice. ElevenLabs TTS — Matilda voice (American, measured, narrator).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const ELEVENLABS_API  = "https://api.elevenlabs.io/v1";
const VOICE_ID        = "XrExE9yKIg1WjnnlVkGX"; // Matilda — American, friendly, middle-aged, narration
const AUDIO_DIR       = "/tmp/agent306_audio";
const MAX_CHARS       = 2500; // safety cap per request

export interface VoiceClip {
  id:          string;
  text:        string;
  audioPath:   string;
  audioUrl:    string;   // served via /api/voice/clip/:id
  createdAt:   string;
  characters:  number;
  source:      "episode" | "burn" | "dispatch" | "spotlight" | "manual";
}

// ── Ensure audio dir exists ───────────────────────────────────────────────────
function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// ── Clip registry (in-memory, survives session) ───────────────────────────────
const clipRegistry: Map<string, VoiceClip> = new Map();

export function getClip(id: string): VoiceClip | undefined {
  return clipRegistry.get(id);
}

export function getRecentClips(limit = 10): VoiceClip[] {
  return [...clipRegistry.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

// ── Strip markdown/hashtags for cleaner TTS ───────────────────────────────────
function cleanForSpeech(text: string): string {
  return text
    .replace(/#\w+/g, "")            // remove hashtags
    .replace(/\[306 \w+\]/g, "") // remove show tags
    .replace(/→|🖤|🔥|⚡|📺/g, "")  // remove emojis that read weird
    .replace(/\n\n+/g, ". ")         // double newlines → pause
    .replace(/\n/g, " ")             // single newlines → space
    .replace(/\.{2,}/g, ".")         // multiple dots → single
    .replace(/\s{2,}/g, " ")         // multiple spaces → single
    .trim();
}

// ── Core: text → audio file ───────────────────────────────────────────────────
export async function generateVoiceClip(
  text: string,
  source: VoiceClip["source"] = "manual",
  apiKey: string
): Promise<VoiceClip> {
  ensureAudioDir();

  const cleaned   = cleanForSpeech(text).slice(0, MAX_CHARS);
  const id        = crypto.randomBytes(8).toString("hex");
  const audioPath = path.join(AUDIO_DIR, `${id}.mp3`);

  console.log(`[Voice] Generating clip (${cleaned.length} chars) — source: ${source}`);

  const res = await fetch(`${ELEVENLABS_API}/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "xi-api-key":    apiKey,
      "Content-Type":  "application/json",
      "Accept":        "audio/mpeg",
    },
    body: JSON.stringify({
      text:           cleaned,
      model_id:       "eleven_turbo_v2_5", // fastest + cheapest, great quality
      voice_settings: {
        stability:         0.55,  // measured, consistent
        similarity_boost:  0.75,  // stays true to voice character
        style:             0.20,  // slight expressiveness — not flat
        use_speaker_boost: true,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${err}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(audioPath, audioBuffer);

  const clip: VoiceClip = {
    id,
    text:       cleaned,
    audioPath,
    audioUrl:   `/api/voice/clip/${id}`,
    createdAt:  new Date().toISOString(),
    characters: cleaned.length,
    source,
  };

  clipRegistry.set(id, clip);
  console.log(`[Voice] Clip ready: ${id} (${clip.characters} chars, ${audioBuffer.length} bytes)`);

  return clip;
}

// ── Check remaining quota ─────────────────────────────────────────────────────
export async function getVoiceQuota(apiKey: string): Promise<{
  used: number; limit: number; remaining: number; tier: string;
}> {
  try {
    const res = await fetch(`${ELEVENLABS_API}/user/subscription`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return {
      used:      data.character_count ?? 0,
      limit:     data.character_limit ?? 10000,
      remaining: (data.character_limit ?? 10000) - (data.character_count ?? 0),
      tier:      data.tier ?? "free",
    };
  } catch (e: any) {
    return { used: 0, limit: 10000, remaining: 10000, tier: "unknown" };
  }
}
