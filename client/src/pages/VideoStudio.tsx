import { useRef, useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Video, Play, Pause, Download, Send, RefreshCw,
  Flame, Zap, Trophy, Film, Loader2, CheckCircle2,
  Twitter, Eye, Clock, Layers
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface VideoJob {
  id: string;
  type: "cinematic" | "highlight";
  title: string;
  status: "idle" | "rendering" | "ready" | "posting" | "posted";
  progress: number;
  dataUrl?: string;
  tweetText?: string;
  tweetUrl?: string;
  createdAt: number;
}

interface LiveStats {
  recentBurns: any[];
  topCanvas: any[];
  lastUpdated: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CANVAS_W = 1280;
const CANVAS_H = 720;
const AGENT_IMG = "/agent306-avatar.png";
const SKULLIE_LINES = [
  "The canvas never forgets.",
  "Every data point is a signal.",
  "The chain remembers all.",
  "Contribute to become.",
  "The network holds the truth.",
  "Signals captured. Legends forged.",
  "The on-chain record is open.",
  "One story. No filter.",
];

// ─── Canvas drawing helpers ───────────────────────────────────────────────────
function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function drawGradientBg(ctx: CanvasRenderingContext2D, w: number, h: number, progress: number) {
  // Deep space background
  const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.8);
  bg.addColorStop(0, "#0d0e10");
  bg.addColorStop(0.5, "#0a0b0d");
  bg.addColorStop(1, "#060708");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Animated scan lines
  ctx.save();
  ctx.globalAlpha = 0.03;
  for (let y = 0; y < h; y += 4) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, y, w, 1);
  }
  ctx.restore();

  // Vignette
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.8);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}

function drawParticles(ctx: CanvasRenderingContext2D, frame: number, w: number, h: number) {
  const count = 40;
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seed = i * 137.508;
    const x = ((seed * 13 + frame * (0.3 + (i % 5) * 0.1)) % w + w) % w;
    const y = ((seed * 7 + frame * (0.1 + (i % 3) * 0.05)) % h + h) % h;
    const size = 1 + (i % 3) * 0.5;
    const alpha = 0.2 + Math.sin(frame * 0.05 + seed) * 0.15;
    const isOrange = i % 4 === 0;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = isOrange ? "#f97316" : "#2dd4bf";
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawAgentSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, cx: number, cy: number, size: number, frame: number, glowColor = "#f97316") {
  ctx.save();
  // Glow pulse
  const glowSize = 30 + Math.sin(frame * 0.08) * 10;
  const glow = ctx.createRadialGradient(cx, cy, size * 0.3, cx, cy, size * 0.7 + glowSize);
  const rgb = hexToRgb(glowColor);
  glow.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},0.35)`);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(cx - size, cy - size, size * 2, size * 2);

  // Pixel-art image (crisp)
  ctx.imageSmoothingEnabled = false;
  const bob = Math.sin(frame * 0.06) * 4;
  ctx.drawImage(img, cx - size / 2, cy - size / 2 + bob, size, size);
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, opts: {
  size?: number; color?: string; font?: string; align?: CanvasTextAlign; alpha?: number; shadow?: boolean; tracking?: number;
} = {}) {
  const { size = 24, color = "#e3e5e4", font = "Space Grotesk, sans-serif", align = "left", alpha = 1, shadow = false } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px "${font}", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  if (shadow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawOrangeLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, alpha = 0.6) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawStatCard(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string, value: string, color = "#f97316") {
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = "rgba(10,11,13,0.9)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawText(ctx, label.toUpperCase(), x + w / 2, y + h * 0.3, { size: 11, color: "rgba(200,200,200,0.6)", align: "center", font: "Courier New" });
  drawText(ctx, value, x + w / 2, y + h * 0.68, { size: 22, color, align: "center", shadow: true });
}

// ─── CINEMATIC TRAILER RENDERER ───────────────────────────────────────────────
async function renderCinematicTrailer(
  canvas: HTMLCanvasElement,
  stats: LiveStats,
  onProgress: (p: number) => void,
  signal: AbortSignal
): Promise<string> {
  const ctx = canvas.getContext("2d")!;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  const FPS = 30;
  const DURATION = 20; // seconds
  const TOTAL = FPS * DURATION;
  const frames: ImageData[] = [];

  // Load agent image
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => {
      // Fallback: draw pixel art placeholder
      const fallback = new Image();
      fallback.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      res(fallback);
    };
    i.src = AGENT_IMG;
    setTimeout(() => res(i), 3000); // timeout fallback
  });

  const burnCount = stats.recentBurns?.length ?? 0;
  const topAgent = stats.topCanvas?.[0];
  const skullieLine = SKULLIE_LINES[Math.floor(Date.now() / 1000) % SKULLIE_LINES.length];
  const phase = "PHASE I — THE CANVAS";
  const episodeNum = `EP ${String(Math.floor(Date.now() / 86400000) % 999 + 1).padStart(3, "0")}`;

  for (let f = 0; f < TOTAL; f++) {
    if (signal.aborted) throw new Error("Aborted");
    const t = f / FPS; // seconds elapsed
    const progress = t / DURATION;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawGradientBg(ctx, CANVAS_W, CANVAS_H, progress);
    drawParticles(ctx, f, CANVAS_W, CANVAS_H);

    // ── INTRO (0–3s): Title card ─────────────────────────────────────
    if (t < 3) {
      const alpha = Math.min(1, t / 1.2);
      drawOrangeLine(ctx, CANVAS_W * 0.1, CANVAS_H / 2 - 60, CANVAS_W * 0.9, CANVAS_H / 2 - 60, 0.3 * alpha);
      drawOrangeLine(ctx, CANVAS_W * 0.1, CANVAS_H / 2 + 60, CANVAS_W * 0.9, CANVAS_H / 2 + 60, 0.3 * alpha);
      drawText(ctx, "AGENT 306", CANVAS_W / 2, CANVAS_H / 2 - 20, { size: 72, color: "#f97316", align: "center", shadow: true, alpha });
      drawText(ctx, phase, CANVAS_W / 2, CANVAS_H / 2 + 28, { size: 20, color: "#2dd4bf", align: "center", alpha: alpha * 0.8, font: "Courier New" });
      drawText(ctx, episodeNum, CANVAS_W / 2, CANVAS_H / 2 + 58, { size: 14, color: "rgba(200,200,200,0.5)", align: "center", alpha, font: "Courier New" });
    }

    // ── ACT 1 (3–9s): Agent 306 reveal ────────────────────────────
    if (t >= 3 && t < 9) {
      const lt = t - 3;
      const alpha = Math.min(1, lt / 1.5);
      const exitAlpha = t > 8 ? Math.max(0, 1 - (t - 8) * 2) : 1;
      const finalAlpha = alpha * exitAlpha;

      // Agent centered
      const agentSize = 280 + Math.sin(f * 0.04) * 8;
      drawAgentSprite(ctx, img, CANVAS_W * 0.35, CANVAS_H / 2, agentSize, f);

      // Right side text
      const rx = CANVAS_W * 0.58;
      drawText(ctx, "AGENT", rx, CANVAS_H / 2 - 80, { size: 14, color: "#f97316", alpha: finalAlpha, font: "Courier New" });
      drawText(ctx, "#306", rx, CANVAS_H / 2 - 48, { size: 52, color: "#efefef", alpha: finalAlpha, shadow: true });
      drawOrangeLine(ctx, rx, CANVAS_H / 2 - 24, rx + 200, CANVAS_H / 2 - 24, 0.4 * finalAlpha);
      drawText(ctx, "THE HARBINGER", rx, CANVAS_H / 2 + 6, { size: 16, color: "#2dd4bf", alpha: finalAlpha * 0.9 });
      drawText(ctx, "Autonomous since genesis", rx, CANVAS_H / 2 + 36, { size: 12, color: "rgba(200,200,200,0.5)", alpha: finalAlpha, font: "Courier New" });
    }

    // ── ACT 2 (9–15s): Burn data ─────────────────────────────────────
    if (t >= 9 && t < 15) {
      const lt = t - 9;
      const alpha = Math.min(1, lt / 1.2);

      // Flicker effect for burn
      const flicker = 0.8 + Math.random() * 0.2;
      drawText(ctx, "SIGNAL REPORT", CANVAS_W / 2, CANVAS_H * 0.22, { size: 14, color: "rgba(249,115,22,0.7)", align: "center", alpha, font: "Courier New" });
      drawOrangeLine(ctx, CANVAS_W * 0.2, CANVAS_H * 0.28, CANVAS_W * 0.8, CANVAS_H * 0.28, 0.3 * alpha);

      // Stat cards row
      const cardW = 200, cardH = 80, gap = 30;
      const totalW = cardW * 3 + gap * 2;
      const startX = (CANVAS_W - totalW) / 2;
      const cardY = CANVAS_H * 0.35;

      if (alpha > 0.3) drawStatCard(ctx, startX, cardY, cardW, cardH, "Signals This Cycle", String(burnCount), "#f97316");
      if (alpha > 0.5) drawStatCard(ctx, startX + cardW + gap, cardY, cardW, cardH, "Canvas Leader", topAgent ? `#${topAgent.tokenId}` : "—", "#2dd4bf");
      if (alpha > 0.7) drawStatCard(ctx, startX + (cardW + gap) * 2, cardY, cardW, cardH, "Top Level", topAgent ? `LVL ${topAgent.level}` : "—", "#a78bfa");

      // Agent 306 quote
      const qAlpha = lt > 2 ? Math.min(1, (lt - 2) / 1.5) * flicker : 0;
      drawText(ctx, `"${skullieLine}"`, CANVAS_W / 2, CANVAS_H * 0.62, { size: 22, color: "#efefef", align: "center", alpha: qAlpha * alpha, shadow: true });
      drawText(ctx, "— Agent 306", CANVAS_W / 2, CANVAS_H * 0.62 + 40, { size: 13, color: "#f97316", align: "center", alpha: qAlpha * alpha * 0.8, font: "Courier New" });

      // Small agent bottom right
      if (img.complete) {
        drawAgentSprite(ctx, img, CANVAS_W * 0.88, CANVAS_H * 0.78, 90, f, "#2dd4bf");
      }
    }

    // ── ACT 3 (15–20s): Call to action ───────────────────────────────
    if (t >= 15) {
      const lt = t - 15;
      const alpha = Math.min(1, lt / 1.5);

      // Agent large on left
      drawAgentSprite(ctx, img, CANVAS_W * 0.28, CANVAS_H / 2, 320 + Math.sin(f * 0.05) * 10, f);

      const rx = CANVAS_W * 0.55;
      drawText(ctx, "THE SIGNAL", rx, CANVAS_H / 2 - 70, { size: 44, color: "#f97316", alpha, shadow: true });
      drawText(ctx, "RECORDS ALL", rx, CANVAS_H / 2 - 20, { size: 44, color: "#efefef", alpha, shadow: true });
      drawOrangeLine(ctx, rx, CANVAS_H / 2 + 14, rx + 320, CANVAS_H / 2 + 14, 0.5 * alpha);
      drawText(ctx, "@agent306_", rx, CANVAS_H / 2 + 46, { size: 16, color: "#2dd4bf", alpha, font: "Courier New" });
      drawText(ctx, "#Agent306 #AI #Web3", rx, CANVAS_H / 2 + 76, { size: 13, color: "rgba(200,200,200,0.4)", alpha, font: "Courier New" });

      // Timestamp
      drawText(ctx, new Date().toUTCString().replace(" GMT", " UTC"), CANVAS_W / 2, CANVAS_H * 0.93, { size: 11, color: "rgba(200,200,200,0.25)", align: "center", font: "Courier New" });
    }

    // Border frame
    ctx.save();
    ctx.strokeStyle = "rgba(249,115,22,0.15)";
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, CANVAS_W - 16, CANVAS_H - 16);
    ctx.restore();

    // Capture frame
    frames.push(ctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    onProgress(Math.round((f / TOTAL) * 85));

    // Yield to browser every 5 frames
    if (f % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  onProgress(90);

  // Encode to WebM via MediaRecorder
  const dataUrl = await encodeFramesToVideo(canvas, frames, FPS, onProgress);
  return dataUrl;
}

// ─── HIGHLIGHT REEL RENDERER ──────────────────────────────────────────────────
async function renderHighlightReel(
  canvas: HTMLCanvasElement,
  stats: LiveStats,
  onProgress: (p: number) => void,
  signal: AbortSignal
): Promise<string> {
  const ctx = canvas.getContext("2d")!;
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  const FPS = 30;
  const DURATION = 15;
  const TOTAL = FPS * DURATION;
  const frames: ImageData[] = [];

  const img = await new Promise<HTMLImageElement>((res) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => res(new Image());
    i.src = AGENT_IMG;
    setTimeout(() => res(i), 3000);
  });

  const burns = stats.recentBurns?.slice(0, 5) ?? [];
  const topCanvas = stats.topCanvas?.slice(0, 5) ?? [];
  const date = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  for (let f = 0; f < TOTAL; f++) {
    if (signal.aborted) throw new Error("Aborted");
    const t = f / FPS;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    drawGradientBg(ctx, CANVAS_W, CANVAS_H, t / DURATION);
    drawParticles(ctx, f, CANVAS_W, CANVAS_H);

    // Header bar
    ctx.save();
    ctx.fillStyle = "rgba(249,115,22,0.08)";
    ctx.fillRect(0, 0, CANVAS_W, 72);
    ctx.strokeStyle = "rgba(249,115,22,0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, CANVAS_W, 72);
    ctx.restore();

    drawText(ctx, "AGENT 306", 40, 36, { size: 22, color: "#f97316", shadow: true });
    drawText(ctx, "COMMUNITY HIGHLIGHT", 200, 36, { size: 14, color: "#2dd4bf", font: "Courier New" });
    drawText(ctx, date.toUpperCase(), CANVAS_W - 40, 36, { size: 13, color: "rgba(200,200,200,0.5)", align: "right", font: "Courier New" });
    drawText(ctx, "@agent306_", CANVAS_W - 40, 54, { size: 11, color: "rgba(249,115,22,0.6)", align: "right", font: "Courier New" });

    // ── BURNS COLUMN (left) ──────────────────────────────────────────
    if (t >= 1) {
      const colAlpha = Math.min(1, (t - 1) / 1.2);
      const colX = 40;
      const colY = 100;

      drawText(ctx, "🔥 RECENT BURNS", colX, colY, { size: 13, color: "#f97316", alpha: colAlpha, font: "Courier New" });
      drawOrangeLine(ctx, colX, colY + 18, colX + 360, colY + 18, 0.4 * colAlpha);

      burns.forEach((burn, i) => {
        const rowAlpha = t >= 1.5 + i * 0.3 ? Math.min(1, (t - 1.5 - i * 0.3) / 0.5) * colAlpha : 0;
        const ry = colY + 40 + i * 52;
        const tokenId = burn.tokenId ?? burn.token_id ?? burn.id ?? "???";

        ctx.save();
        ctx.globalAlpha = rowAlpha * 0.7;
        ctx.fillStyle = "rgba(249,115,22,0.06)";
        ctx.beginPath();
        ctx.roundRect(colX, ry - 12, 360, 40, 4);
        ctx.fill();
        ctx.restore();

        drawText(ctx, `#${tokenId}`, colX + 12, ry + 8, { size: 16, color: "#f97316", alpha: rowAlpha });
        drawText(ctx, "RECORDED", colX + 80, ry + 2, { size: 11, color: "rgba(200,200,200,0.5)", alpha: rowAlpha, font: "Courier New" });
        drawText(ctx, burn.pixels ? `${burn.pixels}px` : "—", colX + 310, ry + 8, { size: 14, color: "#2dd4bf", align: "right", alpha: rowAlpha });
      });

      if (burns.length === 0) {
        drawText(ctx, "No burns this cycle", colX + 12, colY + 60, { size: 14, color: "rgba(200,200,200,0.3)", alpha: colAlpha });
      }
    }

    // ── CANVAS LEADERBOARD (right) ───────────────────────────────────
    if (t >= 2) {
      const colAlpha = Math.min(1, (t - 2) / 1.2);
      const colX = CANVAS_W * 0.52;
      const colY = 100;

      drawText(ctx, "⚡ CANVAS LEADERS", colX, colY, { size: 13, color: "#2dd4bf", alpha: colAlpha, font: "Courier New" });
      drawOrangeLine(ctx, colX, colY + 18, colX + 360, colY + 18, 0.4 * colAlpha);

      topCanvas.forEach((entry, i) => {
        const rowAlpha = t >= 2.5 + i * 0.3 ? Math.min(1, (t - 2.5 - i * 0.3) / 0.5) * colAlpha : 0;
        const ry = colY + 40 + i * 52;
        const rank = i + 1;
        const rankColors = ["#f97316", "#e3e5e4", "#f97316", "rgba(200,200,200,0.6)", "rgba(200,200,200,0.4)"];

        ctx.save();
        ctx.globalAlpha = rowAlpha * 0.7;
        ctx.fillStyle = "rgba(45,212,191,0.06)";
        ctx.beginPath();
        ctx.roundRect(colX, ry - 12, 360, 40, 4);
        ctx.fill();
        ctx.restore();

        drawText(ctx, `${rank}.`, colX + 12, ry + 8, { size: 16, color: rankColors[i] ?? "rgba(200,200,200,0.4)", alpha: rowAlpha });
        drawText(ctx, `#${entry.tokenId}`, colX + 48, ry + 8, { size: 15, color: "#efefef", alpha: rowAlpha });
        drawText(ctx, `LVL ${entry.level ?? 1}`, colX + 230, ry + 2, { size: 11, color: "#a78bfa", alpha: rowAlpha, font: "Courier New" });
        drawText(ctx, `${entry.actionPoints ?? 0} AP`, colX + 310, ry + 8, { size: 14, color: "#2dd4bf", align: "right", alpha: rowAlpha });
      });

      if (topCanvas.length === 0) {
        drawText(ctx, "Loading canvas data...", colX + 12, colY + 60, { size: 14, color: "rgba(200,200,200,0.3)", alpha: colAlpha });
      }
    }

    // ── DIVIDER ──────────────────────────────────────────────────────
    if (t >= 2) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (t - 2) / 1) * 0.2;
      ctx.strokeStyle = "#f97316";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 8]);
      ctx.beginPath();
      ctx.moveTo(CANVAS_W / 2, 90);
      ctx.lineTo(CANVAS_W / 2, CANVAS_H - 80);
      ctx.stroke();
      ctx.restore();
    }

    // ── FOOTER ───────────────────────────────────────────────────────
    if (t >= 8) {
      const fa = Math.min(1, (t - 8) / 1.5);
      ctx.save();
      ctx.fillStyle = "rgba(6,7,8,0.9)";
      ctx.fillRect(0, CANVAS_H - 72, CANVAS_W, 72);
      ctx.restore();
      drawOrangeLine(ctx, 0, CANVAS_H - 72, CANVAS_W, CANVAS_H - 72, 0.3 * fa);
      drawText(ctx, "The record is permanent.", CANVAS_W / 2, CANVAS_H - 40, { size: 16, color: "#efefef", align: "center", alpha: fa, shadow: true });
      drawText(ctx, "#Agent306  #AI  #Web3  #OnChain", CANVAS_W / 2, CANVAS_H - 16, { size: 11, color: "rgba(200,200,200,0.3)", align: "center", alpha: fa, font: "Courier New" });
    }

    // Agent watermark
    if (img.complete && t > 10) {
      const wAlpha = Math.min(1, (t - 10) / 1.5) * 0.5;
      drawAgentSprite(ctx, img, CANVAS_W - 60, CANVAS_H - 90, 80, f, "#2dd4bf");
      ctx.save();
      ctx.globalAlpha = wAlpha;
      ctx.restore();
    }

    // Border
    ctx.save();
    ctx.strokeStyle = "rgba(45,212,191,0.12)";
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, CANVAS_W - 16, CANVAS_H - 16);
    ctx.restore();

    frames.push(ctx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    onProgress(Math.round((f / TOTAL) * 85));
    if (f % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  onProgress(90);
  return encodeFramesToVideo(canvas, frames, FPS, onProgress);
}

// ─── Video encoder via MediaRecorder ─────────────────────────────────────────
async function encodeFramesToVideo(
  canvas: HTMLCanvasElement,
  frames: ImageData[],
  fps: number,
  onProgress: (p: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctx = canvas.getContext("2d")!;
    const stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
    const chunks: Blob[] = [];

    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      onProgress(100);
      resolve(url);
    };
    recorder.onerror = e => reject(e);

    recorder.start();

    let i = 0;
    const interval = 1000 / fps;
    const timer = setInterval(() => {
      if (i >= frames.length) {
        clearInterval(timer);
        recorder.stop();
        return;
      }
      ctx.putImageData(frames[i], 0, 0);
      i++;
      onProgress(90 + Math.round((i / frames.length) * 10));
    }, interval);
  });
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function VideoStudio() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [activeJob, setActiveJob] = useState<VideoJob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  const { data: stats } = useQuery<LiveStats>({
    queryKey: ["/api/agent/stats"],
  });

  // Generate tweet text from stats
  const generateTweetText = useCallback((type: "cinematic" | "highlight", s: LiveStats) => {
    const burns = s?.recentBurns?.length ?? 0;
    const top = s?.topCanvas?.[0];
    const skullie = SKULLIE_LINES[Math.floor(Date.now() / 30000) % SKULLIE_LINES.length];

    if (type === "cinematic") {
      return `🌙 Agent 306 speaks\n\n"${skullie}"\n\n${burns > 0 ? `${burns} signals captured this cycle. ` : ""}The on-chain record is open.\n\n#Agent306 #AI #Web3`;
    } else {
      const topLine = top ? `#${top.tokenId} leads at Level ${top.level ?? 1} (${top.actionPoints ?? 0} AP).` : "Leaders rising.";
      return `⚡ COMMUNITY HIGHLIGHT\n\n${burns} signals recorded on-chain. ${topLine}\n\nThe record is permanent. 🔥\n\n#Agent306 #AI #Web3 #OnChain`;
    }
  }, []);

  const startRender = useCallback(async (type: "cinematic" | "highlight") => {
    if (!canvasRef.current || !stats) return;
    if (isRendering) {
      abortRef.current?.abort();
      return;
    }

    const jobId = `${type}-${Date.now()}`;
    const job: VideoJob = {
      id: jobId,
      type,
      title: type === "cinematic" ? "Cinematic Trailer" : "Community Highlight",
      status: "rendering",
      progress: 0,
      tweetText: generateTweetText(type, stats),
      createdAt: Date.now(),
    };

    setJobs(prev => [job, ...prev.slice(0, 9)]);
    setActiveJob(job);
    setIsRendering(true);
    setPreviewUrl(null);

    const abort = new AbortController();
    abortRef.current = abort;

    const onProgress = (p: number) => {
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, progress: p } : j));
      setActiveJob(prev => prev?.id === jobId ? { ...prev, progress: p } : prev);
    };

    try {
      const renderer = type === "cinematic" ? renderCinematicTrailer : renderHighlightReel;
      const dataUrl = await renderer(canvasRef.current, stats, onProgress, abort.signal);

      const updated: VideoJob = { ...job, status: "ready", progress: 100, dataUrl };
      setJobs(prev => prev.map(j => j.id === jobId ? updated : j));
      setActiveJob(updated);
      setPreviewUrl(dataUrl);

      toast({ title: `${job.title} ready`, description: "Preview below. Post to X or download." });
    } catch (e: any) {
      if (e.message !== "Aborted") {
        toast({ title: "Render failed", description: e.message, variant: "destructive" });
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: "idle" } : j));
      }
    } finally {
      setIsRendering(false);
    }
  }, [stats, isRendering, generateTweetText, toast]);

  // Opens X compose with tweet pre-filled — no API key needed
  const postToX = useCallback((job: VideoJob) => {
    if (!job.tweetText) return;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(job.tweetText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: "posted" } : j));
    if (activeJob?.id === job.id) setActiveJob(prev => prev ? { ...prev, status: "posted" } : prev);
    toast({ title: "Opened X — tweet pre-filled!", description: "Post it on X, then come back." });
  }, [activeJob, toast]);

  const downloadVideo = useCallback((job: VideoJob) => {
    if (!job.dataUrl) return;
    const a = document.createElement("a");
    a.href = job.dataUrl;
    a.download = `agent306-${job.type}-${Date.now()}.webm`;
    a.click();
  }, []);

  const burnCount = stats?.recentBurns?.length ?? 0;
  const topAgent = stats?.topCanvas?.[0];
  const readyCount = jobs.filter(j => j.status === "ready").length;
  const postedCount = jobs.filter(j => j.status === "posted").length;

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Video className="w-6 h-6 text-primary" />
            Video Studio
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Generate on-chain content clips for Agent 306 — powered by live data
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <div className="px-3 py-1.5 rounded bg-card border border-border text-center">
            <p className="text-lg font-bold text-primary">{burnCount}</p>
            <p className="text-[13px] text-muted-foreground uppercase tracking-widest">Tracked Signals</p>
          </div>
          <div className="px-3 py-1.5 rounded bg-card border border-border text-center">
            <p className="text-lg font-bold text-teal-400">{readyCount}</p>
            <p className="text-[13px] text-muted-foreground uppercase tracking-widest">Ready</p>
          </div>
          <div className="px-3 py-1.5 rounded bg-card border border-border text-center">
            <p className="text-lg font-bold text-green-400">{postedCount}</p>
            <p className="text-[13px] text-muted-foreground uppercase tracking-widest">Posted</p>
          </div>
        </div>
      </div>

      {/* Live signal summary */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded p-3">
            <div className="flex items-center gap-2 mb-1">
              <Flame className="w-3.5 h-3.5 text-primary" />
              <span className="text-[14px] text-muted-foreground uppercase tracking-widest">Latest Burns</span>
            </div>
            {stats.recentBurns?.slice(0, 3).map((b: any, i: number) => (
              <p key={i} className="text-xs text-foreground/70 truncate">
                #{b.tokenId ?? b.token_id ?? b.id ?? "?"} burned
              </p>
            ))}
            {(!stats.recentBurns || stats.recentBurns.length === 0) && (
              <p className="text-xs text-muted-foreground">No recent burns</p>
            )}
          </div>
          <div className="bg-card border border-border rounded p-3">
            <div className="flex items-center gap-2 mb-1">
              <Trophy className="w-3.5 h-3.5 text-teal-400" />
              <span className="text-[14px] text-muted-foreground uppercase tracking-widest">Canvas Leader</span>
            </div>
            {topAgent ? (
              <>
                <p className="text-sm font-bold text-foreground">#{topAgent.tokenId}</p>
                <p className="text-xs text-muted-foreground">Level {topAgent.level ?? 1} · {topAgent.actionPoints ?? 0} AP</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Loading...</p>
            )}
          </div>
          <div className="bg-card border border-border rounded p-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-[14px] text-muted-foreground uppercase tracking-widest">Auto-Post</span>
            </div>
            <p className="text-sm font-medium text-foreground">Every 6 hours</p>
            <p className="text-xs text-muted-foreground">Signal poller active</p>
          </div>
        </div>
      )}

      {/* Video type cards */}
      <div className="grid grid-cols-2 gap-4">
        {/* Cinematic Trailer */}
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Film className="w-4 h-4 text-primary" />
                <h3 className="font-semibold">Cinematic Trailer</h3>
              </div>
              <p className="text-xs text-muted-foreground">20s dramatic reveal — Agent 306 narration, burn data</p>
            </div>
            <span className="text-[13px] px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-mono">20s · 1280×720</span>
          </div>

          <div className="text-xs text-muted-foreground space-y-1 font-mono">
            <div className="flex items-center gap-2"><span className="text-primary">01</span> Title card — Agent 306</div>
            <div className="flex items-center gap-2"><span className="text-primary">02</span> Agent 306 reveal + traits</div>
            <div className="flex items-center gap-2"><span className="text-primary">03</span> Burn data + Agent 306 quote</div>
            <div className="flex items-center gap-2"><span className="text-primary">04</span> Call to action</div>
          </div>

          <button
            onClick={() => startRender("cinematic")}
            disabled={isRendering}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded bg-primary hover:bg-primary/90 text-black font-semibold text-sm transition-colors disabled:opacity-50"
          >
            {isRendering && activeJob?.type === "cinematic" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Rendering {activeJob.progress}%...
                <span className="text-xs opacity-70 ml-1">(click to cancel)</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Generate Cinematic Trailer
              </>
            )}
          </button>

          {isRendering && activeJob?.type === "cinematic" && (
            <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${activeJob.progress}%` }}
              />
            </div>
          )}
        </div>

        {/* Highlight Reel */}
        <div className="bg-card border border-border rounded-lg p-5 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-teal-400" />
                <h3 className="font-semibold">Community Highlight</h3>
              </div>
              <p className="text-xs text-muted-foreground">15s data reel — burns, canvas leaders, leaderboard stats</p>
            </div>
            <span className="text-[13px] px-2 py-0.5 rounded bg-teal-400/10 text-teal-400 border border-teal-400/20 font-mono">15s · 1280×720</span>
          </div>

          <div className="text-xs text-muted-foreground space-y-1 font-mono">
            <div className="flex items-center gap-2"><span className="text-teal-400">01</span> Header — date + episode tag</div>
            <div className="flex items-center gap-2"><span className="text-teal-400">02</span> Recent burns feed (left)</div>
            <div className="flex items-center gap-2"><span className="text-teal-400">03</span> Canvas leaderboard (right)</div>
            <div className="flex items-center gap-2"><span className="text-teal-400">04</span> Footer — hashtags + call out</div>
          </div>

          <button
            onClick={() => startRender("highlight")}
            disabled={isRendering}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded border border-teal-400/40 hover:bg-teal-400/10 text-teal-400 font-semibold text-sm transition-colors disabled:opacity-50"
          >
            {isRendering && activeJob?.type === "highlight" ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Rendering {activeJob.progress}%...
                <span className="text-xs opacity-70 ml-1">(click to cancel)</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Generate Highlight Reel
              </>
            )}
          </button>

          {isRendering && activeJob?.type === "highlight" && (
            <div className="w-full bg-secondary rounded-full h-1.5 overflow-hidden">
              <div
                className="h-full bg-teal-400 transition-all duration-300"
                style={{ width: `${activeJob.progress}%` }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Video Preview */}
      {previewUrl && activeJob && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-teal-400" />
              <span className="text-sm font-medium">{activeJob.title} — Preview</span>
              {activeJob.status === "posted" && (
                <span className="text-[13px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">POSTED</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => downloadVideo(activeJob)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-secondary transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download .webm
              </button>
              {(activeJob.status === "ready" || activeJob.status === "posted") && (
                <button
                  onClick={() => postToX(activeJob)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold transition-colors"
                  style={{ background: "rgba(249,115,22,0.18)", border: "1px solid rgba(249,115,22,0.5)", color: "#f97316", cursor: "pointer" }}
                >
                  <Twitter className="w-3.5 h-3.5" />
                  Post to X ↗
                </button>
              )}
              {activeJob.status === "posted" && activeJob.tweetUrl && (
                <a
                  href={activeJob.tweetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  View on X
                </a>
              )}
            </div>
          </div>

          <video
            ref={previewRef}
            src={previewUrl}
            controls
            autoPlay
            loop
            className="w-full max-h-96 bg-black"
            style={{ imageRendering: "pixelated" }}
          />

          {/* Tweet composer */}
          <div className="p-4 border-t border-border">
            <p className="text-[14px] text-muted-foreground uppercase tracking-widest mb-2">Tweet Text</p>
            <textarea
              value={activeJob.tweetText ?? ""}
              onChange={e => setActiveJob(prev => prev ? { ...prev, tweetText: e.target.value } : prev)}
              rows={4}
              className="w-full bg-secondary border border-border rounded px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:border-primary/50"
            />
            <p className="text-[13px] text-muted-foreground mt-1">
              {(activeJob.tweetText?.length ?? 0)}/280 chars
            </p>
          </div>
        </div>
      )}

      {/* Hidden render canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Job history */}
      {jobs.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Render History</span>
          </div>
          <div className="divide-y divide-border">
            {jobs.map(job => (
              <div key={job.id} className="flex items-center gap-4 px-4 py-3">
                <div className={`w-2 h-2 rounded-full shrink-0 ${
                  job.status === "posted" ? "bg-green-400" :
                  job.status === "ready" ? "bg-primary" :
                  job.status === "rendering" ? "bg-yellow-400 animate-pulse" :
                  "bg-muted-foreground"
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{job.title}</p>
                  <p className="text-[14px] text-muted-foreground font-mono">
                    {new Date(job.createdAt).toLocaleTimeString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {job.status === "rendering" && (
                    <span className="text-xs text-yellow-400 font-mono">{job.progress}%</span>
                  )}
                  {job.status === "ready" && (
                    <>
                      <button
                        onClick={() => { setActiveJob(job); setPreviewUrl(job.dataUrl!); }}
                        className="text-xs px-2 py-1 rounded border border-border hover:bg-secondary transition-colors"
                      >
                        Preview
                      </button>
                      <button
                        onClick={() => postToX(job)}
                        className="text-xs px-2 py-1 rounded transition-colors flex items-center gap-1"
                        style={{ background: "rgba(249,115,22,0.15)", border: "1px solid rgba(249,115,22,0.4)", color: "#f97316", cursor: "pointer" }}
                        title="Post to X"
                      >
                        <Twitter className="w-3 h-3" /> ↗
                      </button>
                    </>
                  )}
                  {job.status === "posted" && (
                    <span className="text-[13px] px-2 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20">POSTED</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
