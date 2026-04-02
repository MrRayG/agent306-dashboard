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
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

const XAI_API_KEY  = LLM_API_KEY;
const VIDEO_API    = "https://api.x.ai/v1/videos/generations";
const POLL_URL     = "https://api.x.ai/v1/videos";
const ONCHAIN_API  = ""; // removed — on-chain API disabled

// Track video generation stats
const STATS_FILE = dataPath("video_stats.json");

interface VideoStats {
  totalGenerated: number;
  totalCost: number;        // estimated at $0.0639/video
  contentVideos: number;
  raceVideos: number;
  spotlightVideos: number;
  lastGenerated: string | null;
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
    lastGenerated: null,
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
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${XAI_API_KEY}`,
      },
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
    },
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
