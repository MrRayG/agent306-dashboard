/**
 * ─────────────────────────────────────────────────────────────
 *  306 — xAI VIDEO ENGINE
 *
 *  Generates animated content using grok-imagine-video.
 *  $0.0639/video. Used selectively for high-impact AI
 *  content, weekly Roundup and Spotlight posts.
 *
 *  Strategy: build it, measure engagement lift vs static image,
 *  scale up or back based on data.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import https from "https";
import { dataPath, DATA_DIR } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

const XAI_API_KEY  = LLM_API_KEY;
const VIDEO_API    = "https://api.x.ai/v1/videos/generations";
const POLL_URL     = "https://api.x.ai/v1/videos";
const ONCHAIN_API  = ""; // removed — on-chain API disabled

// ── Reflection video lane (PR #417) ──────────────────────────────────────────
// xAI video auth uses GROK_API_KEY ?? XAI_API_KEY directly — NOT the OpenRouter
// headers (which include HTTP-Referer / X-Title that xAI rejects).
function xaiVideoKey(): string | undefined {
  return process.env.GROK_API_KEY || process.env.XAI_API_KEY || undefined;
}

const REFLECTION_VIDEO_DIR = "reflection_videos";
const REFLECTION_VIDEO_DIR_ABS = path.join(DATA_DIR, REFLECTION_VIDEO_DIR);

export function reflectionVideoDir(): string {
  if (!fs.existsSync(REFLECTION_VIDEO_DIR_ABS)) {
    fs.mkdirSync(REFLECTION_VIDEO_DIR_ABS, { recursive: true });
  }
  return REFLECTION_VIDEO_DIR_ABS;
}

/** Resolve a safe absolute path for a reflection video file. Throws on traversal. */
export function resolveReflectionVideoPath(filename: string): string {
  if (typeof filename !== "string" || !filename) throw new Error("invalid filename");
  // Forbid traversal characters and absolute paths
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error("path traversal blocked");
  }
  // Require .mp4 to keep this lane single-purpose
  if (!filename.endsWith(".mp4")) throw new Error("only .mp4 allowed");
  const dir = reflectionVideoDir();
  const abs = path.resolve(dir, filename);
  // Final containment check — abs must live inside dir
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    throw new Error("path traversal blocked");
  }
  return abs;
}

export function isReflectionVideoEnabled(): boolean {
  return process.env.REFLECTION_VIDEO_ENABLED === "true";
}

function reflectionVideoDailyCap(): number {
  const raw = parseInt(process.env.REFLECTION_VIDEO_DAILY_CAP ?? "3", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

function reflectionVideoDurationSec(): number {
  const raw = parseInt(process.env.REFLECTION_VIDEO_DURATION_SEC ?? "8", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8;
}

// Track video generation stats
const STATS_FILE = dataPath("video_stats.json");

interface VideoStats {
  totalGenerated: number;
  totalCost: number;        // estimated at $0.0639/video
  contentVideos: number;
  raceVideos: number;
  spotlightVideos: number;
  reflectionVideos?: number;
  lastGenerated: string | null;
  /** Per-day counter for the reflection lane cap. Keyed by YYYY-MM-DD UTC. */
  reflectionDaily?: Record<string, number>;
  engagementComparison: {
    withVideo: number[];    // likes on posts with video
    withoutVideo: number[]; // likes on posts without video
  };
}

function loadStats(): VideoStats {
  try {
    if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch {}
  return {
    totalGenerated: 0, totalCost: 0,
    contentVideos: 0, raceVideos: 0, spotlightVideos: 0,
    reflectionVideos: 0,
    lastGenerated: null,
    reflectionDaily: {},
    engagementComparison: { withVideo: [], withoutVideo: [] },
  };
}

function saveStats(s: VideoStats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let stats = loadStats();

// ── Build a cinematic prompt for AI content visualization ─────────────────────────────────────
function buildBurnPrompt(opts: {
  tokenId: number;
  tokenCount: number;
  level: number;
  ap: number;
  scale: "small" | "significant" | "major" | "legendary";
}): string {
  const { tokenId, tokenCount, level, ap, scale } = opts;

  // 306 visual identity:
  // - Clean, modern data visualization aesthetic
  // - Orange (#f97316) is the accent color for highlights and emphasis
  // - The vibe: thoughtful, precise, forward-looking. Knowledge emerging from data.
  // - Think: neural networks, data flows, emerging patterns in a vast dark space.
  const prompts = {
    small: `A minimalist data visualization — a small glowing node in a vast dark space.
Soft orange connections radiate outward, linking to distant dimmer nodes.
Data particles drift gently along the connections, flowing toward the center.
The central node pulses softly — absorbing, processing, understanding.
Warm, calm, contemplative. Like watching an idea take shape.
9:16 vertical. No text. Clean aesthetic. No clutter.`,

    significant: `A network visualization — interconnected nodes forming a constellation in dark space.
Orange data streams flow between nodes, some brighter than others.
New connections form in real-time — orange lines tracing paths between previously separate clusters.
The network grows more coherent as connections multiply.
The mood: quiet discovery. A pattern emerging from complexity.
9:16 vertical. Slow motion. No text. Clean modern aesthetic.`,

    major: `A neural network visualization — layered nodes and connections in a dark void.
Orange data streams flow from multiple directions, converging on a central cluster.
The central structure grows more complex and defined as each stream arrives.
The orange glow builds steadily, illuminating hidden connections.
Powerful but elegant. The kind of insight that changes how you see everything.
9:16 vertical. Cinematic pacing. No text. Clean and precise.`,

    legendary: `A vast data visualization at cosmic scale — thousands of nodes forming a brain-like structure.
Orange data streams converge from every direction, swirling in orbit before integrating.
The structure remains coherent at the center as complexity builds around it.
With each wave of new data, deeper patterns emerge — layers of understanding forming.
Finally: clarity. The orange glow settles into a steady illumination of the complete picture.
The landscape of knowledge has shifted. This is what a breakthrough looks like.
Epic scale, calm execution. 9:16 vertical. No text. Clean futuristic aesthetic.`,
  };

  return prompts[scale];
}

// ── Generate a video from a token image ──────────────────────────────────────
export async function generateBurnVideo(opts: {
  tokenId: number;
  tokenCount: number;
  level: number;
  ap: number;
}): Promise<string | null> {
  const { tokenId, tokenCount, level, ap } = opts;

  const scale = tokenCount >= 50 ? "legendary"
              : tokenCount >= 10 ? "major"
              : tokenCount >= 3  ? "significant"
              : "small";

  const prompt = buildBurnPrompt({ tokenId, tokenCount, level, ap, scale });
  const imageUrl = `${ONCHAIN_API}/token/${tokenId}/image.png`;

  console.log(`[Video] Generating ${scale} content video for #${tokenId} (impact: ${tokenCount})...`);

  try {
    // Step 1: Start generation (image-to-video)
    const startResp = await fetch(VIDEO_API, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: "grok-imagine-video",
        prompt,
        image_url: imageUrl,  // animate from the actual token image
        duration: 8,
        aspect_ratio: "9:16", // vertical — best for X/Twitter
        resolution: "720p",
      }),
    });

    if (!startResp.ok) {
      const err = await startResp.text();
      console.error(`[Video] Start failed: ${startResp.status} ${err.slice(0, 200)}`);
      return null;
    }

    const { request_id } = await startResp.json() as { request_id: string };
    console.log(`[Video] Generation started — request_id: ${request_id}`);

    // Step 2: Poll until done (up to 5 minutes)
    const maxAttempts = 60; // 60 × 5s = 5 minutes
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const pollResp = await fetch(`${POLL_URL}/${request_id}`, {
        headers: { "Authorization": `Bearer ${XAI_API_KEY}` },
      });

      if (!pollResp.ok) continue;

      const data = await pollResp.json() as {
        status: "pending" | "done" | "expired" | "failed";
        video?: { url: string; duration: number };
      };

      if (data.status === "done" && data.video?.url) {
        console.log(`[Video] Done — ${data.video.url}`);

        // Update stats
        stats.totalGenerated++;
        stats.totalCost += 0.0639;
        stats.contentVideos++;
        stats.lastGenerated = new Date().toISOString();
        saveStats(stats);

        // Download video to /tmp for X upload
        const videoPath = `/tmp/agent306_content_${tokenId}_${Date.now()}.mp4`;
        await downloadFile(data.video.url, videoPath);
        return videoPath;

      } else if (data.status === "expired" || data.status === "failed") {
        console.error(`[Video] Generation ${data.status} for #${tokenId}`);
        return null;
      }
      // Still pending — keep polling
    }

    console.error(`[Video] Timed out waiting for #${tokenId}`);
    return null;

  } catch (e: any) {
    console.error(`[Video] Error: ${e.message}`);
    return null;
  }
}

// ── Download a video file to local path ──────────────────────────────────────
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith("https") ? https : require("http");
    protocol.get(url, (res: any) => {
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (e: Error) => {
      fs.unlink(dest, () => {});
      reject(e);
    });
  });
}

// ── Record engagement for a post (called by engagement tracker) ──────────────
export function recordVideoEngagement(likes: number, hadVideo: boolean) {
  if (hadVideo) {
    stats.engagementComparison.withVideo.push(likes);
  } else {
    stats.engagementComparison.withoutVideo.push(likes);
  }
  // Keep last 20 of each
  if (stats.engagementComparison.withVideo.length > 20)
    stats.engagementComparison.withVideo.shift();
  if (stats.engagementComparison.withoutVideo.length > 20)
    stats.engagementComparison.withoutVideo.shift();
  saveStats(stats);
}

// ── Reflection video lane ────────────────────────────────────────────────────

export interface ReflectionVideoResult {
  videoPath: string;        // absolute path on disk
  videoFile: string;        // basename, safe for URL routing
  requestId: string;
  durationSec: number;
  resolution: "720p";
  aspectRatio: "9:16";
}

export interface ReflectionVideoWarning {
  videoPath: null;
  warning: string;
}

function todayKeyUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Read-only daily-cap probe used by route + UI surfaces. Includes
 * `providerConfigured` and a human-readable `reason` so the dashboard can
 * tell the operator *why* the lane is unavailable instead of leaving the
 * toggle silently disabled. `enabled` stays bound to the env flag alone
 * (existing UI contract) — operability is layered via `providerConfigured`.
 */
export function getReflectionVideoCapStatus(): {
  enabled: boolean;
  providerConfigured: boolean;
  capacity: number;
  usedToday: number;
  remaining: number;
  reason: string | null;
} {
  const cap = reflectionVideoDailyCap();
  const used = stats.reflectionDaily?.[todayKeyUTC()] ?? 0;
  const enabled = isReflectionVideoEnabled();
  const providerConfigured = !!xaiVideoKey();
  const remaining = Math.max(0, cap - used);

  let reason: string | null = null;
  if (!enabled) {
    reason = "REFLECTION_VIDEO_ENABLED is not set to 'true'.";
  } else if (!providerConfigured) {
    reason = "GROK_API_KEY / XAI_API_KEY not configured on the server.";
  } else if (remaining <= 0) {
    reason = `Daily cap reached (${used}/${cap}). Resets at 00:00 UTC.`;
  }

  return {
    enabled,
    providerConfigured,
    capacity: cap,
    usedToday: used,
    remaining,
    reason,
  };
}

/**
 * Build the visual prompt for a reflection video. Agent 306 digital-agent
 * aesthetic: minimalist holographic interface, soft cool lighting, faint
 * data particles, calm contemplative mood. No real-person likeness, no
 * cartoon stylization.
 */
export function buildReflectionVideoPrompt(opts: {
  reflectionText: string;
  visualPrompt?: string;
}): string {
  const { reflectionText, visualPrompt } = opts;
  const aestheticBase =
    "A minimalist high-end holographic interface in cool blue and soft white. " +
    "Faint grid lines and gentle data particles drifting through dark space. " +
    "Soft cool lighting, calm reflective mood, slow contemplative motion. " +
    "No text, no logos, no real person, no cartoon stylization, no human face. " +
    "9:16 vertical. Clean futuristic aesthetic — the visual texture of an AI agent thinking out loud.";

  if (visualPrompt && visualPrompt.trim()) {
    return `${aestheticBase}\n\n${visualPrompt.trim()}`;
  }

  // Extract the post body (strip [306 REFLECTION] tag + sign-off if present)
  const body = reflectionText
    .replace(/^\[306 REFLECTION\]/i, "")
    .replace(/—\s*Agent 306\s*$/i, "")
    .trim()
    .slice(0, 280);

  return `${aestheticBase}\n\nMood is set by this internal reflection (do NOT render any text from it): ${body}`;
}

/**
 * Generate a reflection video via xAI grok-imagine-video (pure text-to-video).
 *
 * Returns a structured result with the persisted mp4 path on success.
 * Returns null on hard disable / missing key. Returns a warning object when
 * the daily cap is exhausted or generation fails so callers can attach the
 * warning to the text draft without breaking the reflection lane.
 *
 * IMPORTANT: this is DRAFT-ONLY plumbing. Nothing here posts to X. The
 * caller (manual reflection generation route) attaches the videoPath to a
 * draft; manual publish uploads MP4 via xPostScheduler.
 */
export async function generateReflectionVideo(opts: {
  draftId: string;
  reflectionText: string;
  visualPrompt?: string;
}): Promise<ReflectionVideoResult | ReflectionVideoWarning | null> {
  if (!isReflectionVideoEnabled()) {
    console.log(`[ReflectionVideo] flag_disabled draft=${opts.draftId}`);
    return { videoPath: null, warning: "REFLECTION_VIDEO_ENABLED=false" };
  }

  console.log(`[ReflectionVideo] requested draft=${opts.draftId}`);

  const key = xaiVideoKey();
  if (!key) {
    console.error(
      `[ReflectionVideo] provider_missing draft=${opts.draftId} ` +
      `— GROK_API_KEY/XAI_API_KEY not configured`,
    );
    return { videoPath: null, warning: "GROK_API_KEY/XAI_API_KEY not configured" };
  }

  // Daily cap (separate from totalGenerated to avoid coupling with burn lane)
  const cap = reflectionVideoDailyCap();
  const todayKey = todayKeyUTC();
  const usedToday = stats.reflectionDaily?.[todayKey] ?? 0;
  if (usedToday >= cap) {
    console.warn(
      `[ReflectionVideo] cap_exhausted draft=${opts.draftId} ${usedToday}/${cap}`,
    );
    return {
      videoPath: null,
      warning: `Daily reflection-video cap reached (${usedToday}/${cap}). Try again tomorrow.`,
    };
  }

  const durationSec = reflectionVideoDurationSec();
  const prompt = buildReflectionVideoPrompt({
    reflectionText: opts.reflectionText,
    visualPrompt: opts.visualPrompt,
  });

  console.log(
    `[ReflectionVideo] queued draft=${opts.draftId} ` +
    `slot=${usedToday + 1}/${cap} duration=${durationSec}s`,
  );

  try {
    const startResp = await fetch(VIDEO_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "grok-imagine-video",
        prompt,
        duration: durationSec,
        aspect_ratio: "9:16",
        resolution: "720p",
      }),
    });

    if (!startResp.ok) {
      const err = await startResp.text();
      console.error(
        `[ReflectionVideo] render_failed draft=${opts.draftId} ` +
        `stage=start http=${startResp.status} body=${err.slice(0, 200)}`,
      );
      return { videoPath: null, warning: `xAI start failed: HTTP ${startResp.status}` };
    }

    const startData = await startResp.json() as { request_id?: string };
    const requestId = startData.request_id;
    if (!requestId) {
      console.error(`[ReflectionVideo] render_failed draft=${opts.draftId} stage=start reason=no_request_id`);
      return { videoPath: null, warning: "xAI did not return request_id" };
    }
    console.log(`[ReflectionVideo] render_started draft=${opts.draftId} request_id=${requestId}`);

    // Poll up to 5 minutes (60 × 5s)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollResp = await fetch(`${POLL_URL}/${requestId}`, {
        headers: { "Authorization": `Bearer ${key}` },
      });
      if (!pollResp.ok) continue;

      const data = await pollResp.json() as {
        status: "pending" | "done" | "expired" | "failed";
        video?: { url?: string; duration?: number };
      };

      if (data.status === "done" && data.video?.url) {
        const dir = reflectionVideoDir();
        const filename = `${opts.draftId}.mp4`;
        const videoPath = path.join(dir, filename);
        try {
          await downloadFile(data.video.url, videoPath);
        } catch (e: any) {
          console.error(
            `[ReflectionVideo] render_failed draft=${opts.draftId} ` +
            `stage=download error=${e.message}`,
          );
          return { videoPath: null, warning: `Download failed: ${e.message}` };
        }

        // Stats — bump counters AFTER persisted to disk.
        stats.totalGenerated++;
        stats.totalCost += 0.0639;
        stats.reflectionVideos = (stats.reflectionVideos ?? 0) + 1;
        stats.reflectionDaily = stats.reflectionDaily ?? {};
        stats.reflectionDaily[todayKey] = (stats.reflectionDaily[todayKey] ?? 0) + 1;
        stats.lastGenerated = new Date().toISOString();
        saveStats(stats);

        console.log(
          `[ReflectionVideo] render_succeeded draft=${opts.draftId} ` +
          `request_id=${requestId} path=${videoPath}`,
        );
        console.log(
          `[ReflectionVideo] asset_persisted draft=${opts.draftId} file=${filename}`,
        );
        return {
          videoPath,
          videoFile: filename,
          requestId,
          durationSec: data.video.duration ?? durationSec,
          resolution: "720p",
          aspectRatio: "9:16",
        };
      }

      if (data.status === "expired" || data.status === "failed") {
        console.error(
          `[ReflectionVideo] render_failed draft=${opts.draftId} ` +
          `stage=poll status=${data.status}`,
        );
        return { videoPath: null, warning: `xAI status=${data.status}` };
      }
      // still pending — keep polling
    }

    console.error(
      `[ReflectionVideo] render_failed draft=${opts.draftId} stage=poll reason=timeout`,
    );
    return { videoPath: null, warning: "Timed out after 5 minutes" };

  } catch (e: any) {
    console.error(
      `[ReflectionVideo] render_failed draft=${opts.draftId} stage=exception error=${e.message}`,
    );
    return { videoPath: null, warning: `Error: ${e.message}` };
  }
}

// Test seam — lets unit tests reset the daily counter without poking disk.
export function __resetReflectionDailyForTest(): void {
  stats.reflectionDaily = {};
  saveStats(stats);
}

// ── Get video stats for the dashboard ────────────────────────────────────────
export function getVideoStats() {
  const wv = stats.engagementComparison.withVideo;
  const wov = stats.engagementComparison.withoutVideo;
  const avgWith = wv.length > 0
    ? Math.round(wv.reduce((a, b) => a + b, 0) / wv.length)
    : null;
  const avgWithout = wov.length > 0
    ? Math.round(wov.reduce((a, b) => a + b, 0) / wov.length)
    : null;

  const lift = (avgWith !== null && avgWithout !== null && avgWithout > 0)
    ? Math.round(((avgWith - avgWithout) / avgWithout) * 100)
    : null;

  return {
    totalGenerated: stats.totalGenerated,
    estimatedCost: `$${stats.totalCost.toFixed(2)}`,
    costPerVideo: "$0.0639",
    breakdown: {
      content: stats.contentVideos,
      race: stats.raceVideos,
      spotlight: stats.spotlightVideos,
      reflection: stats.reflectionVideos ?? 0,
    },
    reflectionLane: getReflectionVideoCapStatus(),
    lastGenerated: stats.lastGenerated,
    engagement: {
      avgLikesWithVideo: avgWith,
      avgLikesWithoutVideo: avgWithout,
      liftPercent: lift,
      sampleSize: { withVideo: wv.length, withoutVideo: wov.length },
      verdict: lift === null ? "collecting data"
              : lift > 20   ? "video is working — scale up"
              : lift > 0    ? "slight lift — monitor"
              : lift === 0  ? "no difference — reassess"
              :               "underperforming — scale back",
    },
  };
}
