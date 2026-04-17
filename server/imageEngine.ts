/**
 * ─────────────────────────────────────────────────────────────
 *  306 — IMAGE ENGINE
 *
 *  Generates images for X posts using xAI grok-2-image-1212.
 *  $0.07/image. Opt-in per post via the `includeImage` queue flag.
 *
 *  Default policy:
 *   • Engine slots (dispatch, signal, roundup, news, article, blog,
 *     research, breakthrough, podcast, academy, reflection) → ON
 *   • agent_voice → OFF (short voice posts stay text-only)
 *
 *  Prompt is auto-generated from the tweet text via a routine-tier
 *  LLM call (short, visual, no faces/logos/watermarks).
 *
 *  Images are saved to /tmp/agent306_images/ and returned as buffers
 *  so the caller can upload to X via xClient.v1.uploadMedia().
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { dataPath } from "./dataPaths.js";
import { LLM_API_KEY } from "./llmConfig.js";
import { callLLM } from "./llmCall.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import type { XPostType } from "./xPostScheduler.js";

// ── Config ──────────────────────────────────────────────────────────────────

const IMAGE_API_URL = "https://api.x.ai/v1/images/generations";
const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "grok-2-image-1212";
const IMAGE_COST_PER_CALL = 0.07; // $0.07 per image (xAI pricing)

const IMAGE_DIR = "/tmp/agent306_images";
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

const STATS_FILE = dataPath("image_stats.json");

// ── Types ───────────────────────────────────────────────────────────────────

interface ImageStats {
  totalGenerated: number;
  totalCost: number;
  byType: Record<string, number>;
  lastGenerated: string | null;
  engagementComparison: {
    withImage: number[];     // likes on posts that had an image
    withoutImage: number[];  // likes on text-only posts
  };
}

export interface GeneratedImage {
  buffer: Buffer;
  filePath: string;
  prompt: string;
  model: string;
  cost: number;
}

// ── Stats ───────────────────────────────────────────────────────────────────

function loadStats(): ImageStats {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch {}
  return {
    totalGenerated: 0,
    totalCost: 0,
    byType: {},
    lastGenerated: null,
    engagementComparison: { withImage: [], withoutImage: [] },
  };
}

function saveStats(stats: ImageStats): void {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e: any) {
    console.warn("[ImageEngine] Failed to save stats:", e.message);
  }
}

export function getImageStats(): ImageStats {
  return loadStats();
}

export function recordImageEngagement(likes: number, hadImage: boolean): void {
  const stats = loadStats();
  if (hadImage) stats.engagementComparison.withImage.push(likes);
  else stats.engagementComparison.withoutImage.push(likes);
  // Cap at last 200 samples per bucket to bound memory
  stats.engagementComparison.withImage = stats.engagementComparison.withImage.slice(-200);
  stats.engagementComparison.withoutImage = stats.engagementComparison.withoutImage.slice(-200);
  saveStats(stats);
}

// ── Default-by-type policy ──────────────────────────────────────────────────

/**
 * Should a post of this type include an image by default?
 * agent_voice posts are short/conversational — skip images.
 * Everything else (engine-driven structured posts) gets an image.
 */
export function defaultIncludeImage(type: XPostType): boolean {
  if (type === "agent_voice") return false;
  return true;
}

// ── Auto-prompt generator ───────────────────────────────────────────────────

/**
 * Generate a visual prompt from tweet text.
 * Uses routine-tier LLM. Keeps it short, editorial, no faces/logos/text.
 */
export async function generateImagePrompt(tweetText: string): Promise<string> {
  const system = `You are a visual art director for Agent 306, an AI research agent with a dark editorial aesthetic (think WSJ The Journal meets cyberpunk). Given a tweet, write ONE image prompt for an AI image model.

Rules:
- 40-80 words
- Editorial / conceptual / abstract — NOT literal illustrations
- Dark palette: deep blacks, muted oranges (#f97316), soft greys, occasional cyan
- NEVER include: human faces, specific logos, readable text, watermarks, celebrity likenesses
- Prefer: abstract compositions, geometric patterns, atmospheric scenes, data visualizations, macro shots, cinematic lighting
- End with: "Photographic, cinematic lighting, 3:2 aspect ratio."

Return JSON: {"prompt": "<prompt text>"}`;

  try {
    const resp = await callLLM({
      task: "social-preview", // routine tier — cheap
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Tweet: ${tweetText.slice(0, 600)}` },
      ],
      maxTokens: 300,
      temperature: 0.7,
    });
    const parsed = safeParseLLMJson<{ prompt?: string }>(resp.text);
    const prompt = parsed?.prompt?.trim();
    if (prompt && prompt.length > 10) return prompt;
    // Sometimes the model returns plain text — accept it if it looks like a prompt
    const fallbackText = resp.text?.trim();
    if (fallbackText && fallbackText.length > 20 && fallbackText.length < 600) {
      return fallbackText;
    }
  } catch (e: any) {
    console.warn("[ImageEngine] Auto-prompt failed, using fallback:", e.message);
  }
  // Fallback: a safe generic Agent 306 visual
  return "Dark editorial scene: abstract geometric composition with muted orange accents over deep black background, soft volumetric light, cinematic atmosphere. Photographic, cinematic lighting, 3:2 aspect ratio.";
}

// ── xAI image generation ────────────────────────────────────────────────────

interface XAIImageResponse {
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  error?: { message?: string };
}

async function callXAIImageAPI(prompt: string): Promise<Buffer> {
  const apiKey = process.env.GROK_API_KEY ?? LLM_API_KEY;
  if (!apiKey) throw new Error("GROK_API_KEY not set — cannot generate image");

  const res = await fetch(IMAGE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      response_format: "b64_json",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`xAI image API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as XAIImageResponse;
  const item = json.data?.[0];
  if (!item) throw new Error(`xAI image API returned no data: ${JSON.stringify(json).slice(0, 300)}`);

  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }
  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`Failed to fetch image URL: ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new Error("xAI image response missing b64_json and url");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an image for a post.
 * If prompt is omitted, auto-generates from tweetText via routine LLM.
 * Saves to /tmp/agent306_images/ and returns buffer + path.
 */
export async function generatePostImage(opts: {
  tweetText: string;
  prompt?: string;
  type?: XPostType;
}): Promise<GeneratedImage> {
  const prompt = opts.prompt?.trim() || await generateImagePrompt(opts.tweetText);
  const buffer = await callXAIImageAPI(prompt);

  const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  const filePath = path.join(IMAGE_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  // Update stats
  const stats = loadStats();
  stats.totalGenerated += 1;
  stats.totalCost += IMAGE_COST_PER_CALL;
  if (opts.type) stats.byType[opts.type] = (stats.byType[opts.type] ?? 0) + 1;
  stats.lastGenerated = new Date().toISOString();
  saveStats(stats);

  console.log(`[ImageEngine] Generated image for ${opts.type ?? "post"} — ${filePath} ($${IMAGE_COST_PER_CALL})`);

  return {
    buffer,
    filePath,
    prompt,
    model: IMAGE_MODEL,
    cost: IMAGE_COST_PER_CALL,
  };
}
