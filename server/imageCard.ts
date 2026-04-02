// ─────────────────────────────────────────────────────────────────────────────
// 306 — EPISODE IMAGE CARD GENERATOR
// Creates a 1200x675 PNG card for each episode. Styled in Agent 306 palette.
// Uploaded to a public URL via a temp file so it can be attached to posts.
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas, loadImage } from "canvas";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const ONCHAIN_API = ""; // removed — on-chain API disabled
const W = 1200;
const H = 675;

// 306 palette
const BG_DARK    = "#0e0f10";
const BG_MID     = "#1a1b1c";
const PIXEL_COLOR = "#48494b";
const FG         = "#e3e5e4";
const ORANGE     = "#f97316";
const DIM        = "rgba(227,229,228,0.25)";

// ── Fetch pixel string for a token ───────────────────────────────────────────
async function fetchPixels(tokenId: number): Promise<string | null> {
  return new Promise(resolve => {
    const url = `${ONCHAIN_API}/token/${tokenId}/pixels`;
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data.trim().length === 1600 ? data.trim() : null));
    }).on("error", () => resolve(null));
  });
}

// ── Draw pixel art at given position and scale ────────────────────────────────
function drawPixelArt(
  ctx: any,
  pixels: string,
  x: number, y: number,
  pixelSize: number,
  glowColor = ORANGE
) {
  const W = 40;
  for (let row = 0; row < W; row++) {
    for (let col = 0; col < W; col++) {
      if (pixels[row * W + col] !== "1") continue;
      ctx.fillStyle = FG;
      ctx.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize - 0.5, pixelSize - 0.5);
    }
  }
}

// ── Draw scanline overlay for that cinematic feel ─────────────────────────────
function drawScanlines(ctx: any) {
  ctx.save();
  for (let y = 0; y < H; y += 4) {
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(0, y, W, 1);
  }
  ctx.restore();
}

// ── Main card generator ────────────────────────────────────────────────────────
export async function generateEpisodeCard(opts: {
  tokenId: number;
  episodeTitle: string;
  episodeNum: number;
  stat1Label: string;  // e.g. "SOULS SACRIFICED"
  stat1Value: string;  // e.g. "20"
  stat2Label: string;  // e.g. "PIXELS CONSUMED"
  stat2Value: string;  // e.g. "9,863"
  sentiment: string;
}): Promise<Buffer | null> {
  try {
    const { tokenId, episodeTitle, episodeNum, stat1Label, stat1Value, stat2Label, stat2Value } = opts;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as any;

    // ── Background ────────────────────────────────────────────────────────────
    // Dark gradient base
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, "#0a0b0d");
    bgGrad.addColorStop(1, "#111213");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Orange glow in top-left (where token art will sit)
    const glow = ctx.createRadialGradient(220, H/2, 0, 220, H/2, 380);
    glow.addColorStop(0, "rgba(249,115,22,0.12)");
    glow.addColorStop(1, "rgba(249,115,22,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Subtle grid lines
    ctx.strokeStyle = "rgba(227,229,228,0.03)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (let gy = 0; gy < H; gy += 40) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    // ── Token pixel art (left side) ──────────────────────────────────────────
    const pixels = await fetchPixels(tokenId);
    const pixelSize = 10;
    const artW = 40 * pixelSize; // 400px
    const artX = 60;
    const artY = (H - artW) / 2;

    if (pixels) {
      // Glow behind the token
      const tokenGlow = ctx.createRadialGradient(
        artX + artW/2, artY + artW/2, 0,
        artX + artW/2, artY + artW/2, 260
      );
      tokenGlow.addColorStop(0, "rgba(249,115,22,0.10)");
      tokenGlow.addColorStop(1, "rgba(249,115,22,0)");
      ctx.fillStyle = tokenGlow;
      ctx.fillRect(0, 0, W, H);

      drawPixelArt(ctx, pixels, artX, artY, pixelSize);
    }

    // Token ID badge
    ctx.fillStyle = "rgba(249,115,22,0.15)";
    ctx.fillRect(artX, artY + artW + 8, 80, 22);
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 12px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText(`#${tokenId}`, artX + 8, artY + artW + 22);

    // ── Divider line ─────────────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(249,115,22,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(artX + artW + 40, 60);
    ctx.lineTo(artX + artW + 40, H - 60);
    ctx.stroke();

    // ── Right side content ────────────────────────────────────────────────────
    const rx = artX + artW + 70;
    const contentW = W - rx - 60;

    // 306 label
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.letterSpacing = "0.2em";
    ctx.fillText("306", rx, 90);

    // Episode number
    ctx.fillStyle = "rgba(227,229,228,0.25)";
    ctx.font = "11px 'Courier New'";
    ctx.fillText(`EP ${String(episodeNum).padStart(3, "0")}`, rx + 110, 90);

    // Episode title
    ctx.fillStyle = FG;
    ctx.font = "bold 38px 'Courier New'";
    ctx.textAlign = "left";

    // Word wrap title
    const words = episodeTitle.split(" ");
    let line = "";
    let titleY = 145;
    const maxW = contentW;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      const metrics = ctx.measureText(test);
      if (metrics.width > maxW && line) {
        ctx.fillText(line, rx, titleY);
        line = word;
        titleY += 48;
      } else {
        line = test;
      }
    }
    ctx.fillText(line, rx, titleY);

    // ── Stats ─────────────────────────────────────────────────────────────────
    const statsY = titleY + 70;

    // Stat 1
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 52px 'Courier New'";
    ctx.fillText(stat1Value, rx, statsY);
    ctx.fillStyle = "rgba(227,229,228,0.8)";
    ctx.font = "bold 13px 'Courier New'";
    ctx.fillText(stat1Label, rx, statsY + 24);

    // Stat 2
    const stat2X = rx + 200;
    ctx.fillStyle = FG;
    ctx.font = "bold 52px 'Courier New'";
    ctx.fillText(stat2Value, stat2X, statsY);
    ctx.fillStyle = "rgba(227,229,228,0.8)";
    ctx.font = "bold 13px 'Courier New'";
    ctx.fillText(stat2Label, stat2X, statsY + 24);

    // ── Agent 306 signature ───────────────────────────────────────────────────
    ctx.fillStyle = "rgba(227,229,228,0.6)";
    ctx.font = "15px 'Courier New'";
    ctx.fillText("— Agent 306", rx, statsY + 90);

    // ── Bottom bar ────────────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(249,115,22,0.15)";
    ctx.fillRect(0, H - 50, W, 50);
    ctx.strokeStyle = "rgba(249,115,22,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 50); ctx.lineTo(W, H - 50); ctx.stroke();

    ctx.fillStyle = "rgba(227,229,228,0.75)";
    ctx.font = "bold 13px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("agent306.eth  ·  AI thought leader  ·  tracking the field", rx, H - 18);

    ctx.fillStyle = ORANGE;
    ctx.font = "bold 14px 'Courier New'";
    ctx.textAlign = "right";
    ctx.fillText("#Agent306", W - 40, H - 18);

    // Scanlines for that pixel TV feel
    drawScanlines(ctx);

    // ── Orange accent border ──────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(249,115,22,0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    return canvas.toBuffer("image/png");
  } catch (e: any) {
    console.error("[306] Image card error:", e.message);
    return null;
  }
}

// ── Save card to /tmp and return file path ────────────────────────────────────
export async function saveEpisodeCard(opts: Parameters<typeof generateEpisodeCard>[0]): Promise<string | null> {
  const buf = await generateEpisodeCard(opts);
  if (!buf) return null;
  const filePath = `/tmp/agent306_ep${opts.episodeNum}_${Date.now()}.png`;
  fs.writeFileSync(filePath, buf);
  console.log(`[306] Image card saved: ${filePath} (${(buf.length / 1024).toFixed(1)}KB)`);
  return filePath;
}

// ── SPOTLIGHT CARD — 1200×675 holder portrait ─────────────────────────────────

// ── Fetch token image via PNG URL ─────────────────────────────────────────────
function fetchTokenImage(tokenId: number): Promise<any | null> {
  return new Promise(resolve => {
    if (!ONCHAIN_API) return resolve(null); // API disabled
    const url = `${ONCHAIN_API}/token/${tokenId}/image.png`;
    https.get(url, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", async () => {
        try {
          const buf = Buffer.concat(chunks);
          const img = await loadImage(buf);
          resolve(img);
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

// ── SPOTLIGHT CARD — Clean, modern, high contrast ─────────────────────────────
// Fix: white canvas background so dark NFTs (like Black Square) are visible
export async function generateSpotlightCard(opts: {
  holderUsername: string;
  headline: string;
  weekLabel: string;
  featuredTokenId?: number;
  rank?: number;
  level?: number;
  ap?: number;
}): Promise<Buffer | null> {
  try {
    const { holderUsername, headline, weekLabel, featuredTokenId, rank, level, ap } = opts;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as any;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = "#0e0f10";
    ctx.fillRect(0, 0, W, H);

    // Warm orange glow behind art panel
    const glow = ctx.createRadialGradient(240, H / 2, 0, 240, H / 2, 360);
    glow.addColorStop(0, "rgba(249,115,22,0.1)");
    glow.addColorStop(1, "rgba(249,115,22,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Subtle dot grid
    ctx.fillStyle = "rgba(227,229,228,0.04)";
    for (let x = 0; x < W; x += 32)
      for (let y = 0; y < H; y += 32)
        ctx.fillRect(x, y, 1, 1);

    // ── LEFT PANEL — NFT Art with WHITE background for contrast ─────────────
    const panelW = 420, padX = 50, padY = 60;
    const artSize = panelW - padX * 2; // 320px

    // White canvas background — ensures dark NFTs are always visible
    ctx.fillStyle = "#f0f0f0";
    ctx.fillRect(padX, padY, artSize, artSize);

    // Load and draw NFT image
    if (featuredTokenId) {
      const img = await fetchTokenImage(featuredTokenId);
      if (img) {
        // Draw with pixelated rendering
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, padX, padY, artSize, artSize);
      } else {
        // Fallback pixel art
        const pixels = await fetchPixels(featuredTokenId);
        if (pixels) {
          ctx.fillStyle = "#f0f0f0";
          ctx.fillRect(padX, padY, artSize, artSize);
          const ps = artSize / 40;
          for (let row = 0; row < 40; row++)
            for (let col = 0; col < 40; col++) {
              if (pixels[row * 40 + col] !== "1") continue;
              ctx.fillStyle = "#1a1a1a";
              ctx.fillRect(padX + col * ps, padY + row * ps, ps - 0.3, ps - 0.3);
            }
        }
      }
    }

    // Orange accent border around art
    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 2;
    ctx.strokeRect(padX - 1, padY - 1, artSize + 2, artSize + 2);

    // Token label below art
    if (featuredTokenId) {
      ctx.fillStyle = "#f97316";
      ctx.font = "bold 12px 'Courier New'";
      ctx.textAlign = "left";
      ctx.fillText(`TOKEN #${featuredTokenId}`, padX, padY + artSize + 22);
    }

    // Divider line
    const divX = panelW + 20;
    ctx.strokeStyle = "rgba(249,115,22,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(divX, 30);
    ctx.lineTo(divX, H - 30);
    ctx.stroke();

    // ── RIGHT PANEL ─────────────────────────────────────────────────────────
    const rx = divX + 40;
    const rw = W - rx - 40;

    // Label row
    ctx.fillStyle = "#f97316";
    ctx.font = "bold 10px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("● HOLDER SPOTLIGHT", rx, 56);

    ctx.fillStyle = "rgba(227,229,228,0.35)";
    ctx.font = "10px 'Courier New'";
    ctx.fillText(weekLabel.toUpperCase(), rx + 172, 56);

    // Headline — large, bold, white
    ctx.fillStyle = "#e3e5e4";
    ctx.font = "bold 44px 'Arial'";
    ctx.textAlign = "left";
    const words = headline.split(" ");
    let line = "", lineY = 120;
    for (const word of words) {
      const test = line + word + " ";
      if (ctx.measureText(test).width > rw && line) {
        ctx.fillText(line.trim(), rx, lineY);
        line = word + " ";
        lineY += 54;
      } else { line = test; }
    }
    ctx.fillText(line.trim(), rx, lineY);
    lineY += 64;

    // @handle — orange, prominent
    ctx.fillStyle = "#f97316";
    ctx.font = "bold 28px 'Courier New'";
    ctx.fillText(`@${holderUsername}`, rx, lineY);
    lineY += 48;

    // Separator
    ctx.strokeStyle = "rgba(227,229,228,0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, lineY);
    ctx.lineTo(W - 40, lineY);
    ctx.stroke();
    lineY += 24;

    // Stats grid — only show what we have
    const stats = [
      rank  !== undefined ? { label: "RANK",  value: `#${rank}`,   accent: "#f97316" } : null,
      level !== undefined ? { label: "LEVEL", value: String(level), accent: "#e3e5e4" } : null,
      ap    !== undefined ? { label: "AP",    value: String(ap),    accent: "#a78bfa" } : null,
    ].filter(Boolean) as { label: string; value: string; accent: string }[];

    if (stats.length > 0) {
      const boxW = Math.min(130, Math.floor(rw / stats.length) - 8);
      let sx = rx;
      for (const s of stats) {
        // Box
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(sx, lineY, boxW, 64);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.strokeRect(sx, lineY, boxW, 64);
        // Left accent bar
        ctx.fillStyle = s.accent;
        ctx.fillRect(sx, lineY, 3, 64);
        // Label
        ctx.fillStyle = "rgba(227,229,228,0.4)";
        ctx.font = "9px 'Courier New'";
        ctx.textAlign = "left";
        ctx.fillText(s.label, sx + 12, lineY + 20);
        // Value
        ctx.fillStyle = "#e3e5e4";
        ctx.font = `bold ${s.value.length > 5 ? 20 : 26}px 'Courier New'`;
        ctx.fillText(s.value, sx + 12, lineY + 52);
        sx += boxW + 10;
      }
      lineY += 84;
    }

    // ── Bottom branding ──────────────────────────────────────────────────────
    // Full-width bottom bar
    ctx.fillStyle = "rgba(249,115,22,0.06)";
    ctx.fillRect(0, H - 44, W, 44);
    ctx.strokeStyle = "rgba(249,115,22,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H - 44);
    ctx.lineTo(W, H - 44);
    ctx.stroke();

    ctx.fillStyle = "#f97316";
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("AGENT306", 40, H - 17);

    ctx.fillStyle = "rgba(227,229,228,0.3)";
    ctx.font = "10px 'Courier New'";
    ctx.textAlign = "right";
    ctx.fillText("@agent306  ·  AI thought leader", W - 40, H - 17);

    // Outer border
    ctx.strokeStyle = "rgba(249,115,22,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    drawScanlines(ctx);
    return canvas.toBuffer("image/png");
  } catch (e: any) {
    console.error("[SpotlightCard] Error:", e.message);
    return null;
  }
}

// ── RACE CARD — Clean modern leaderboard with actual NFT art ──────────────────
// Fix: shows actual NFT images per token, correct AP values, modern layout
export async function generateRaceCard(opts: {
  weekNumber: number;
  weekLabel: string;
  daysToArena: number;
  headline: string;
  top5: Array<{ rank: number; tokenId: number; level: number; ap: number }>;
  totalBurnsThisWeek: number;
}): Promise<Buffer | null> {
  try {
    const { weekNumber, weekLabel, daysToArena, headline, top5, totalBurnsThisWeek } = opts;

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as any;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = "#0a0a0e";
    ctx.fillRect(0, 0, W, H);

    // Purple glow top-right
    const glow = ctx.createRadialGradient(W - 80, 80, 0, W - 80, 80, 480);
    glow.addColorStop(0, "rgba(167,139,250,0.14)");
    glow.addColorStop(1, "rgba(167,139,250,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Dot grid
    ctx.fillStyle = "rgba(167,139,250,0.04)";
    for (let x = 0; x < W; x += 32)
      for (let y = 0; y < H; y += 32)
        ctx.fillRect(x, y, 1, 1);

    // ── Top header bar ───────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(167,139,250,0.07)";
    ctx.fillRect(0, 0, W, 52);
    ctx.strokeStyle = "rgba(167,139,250,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 52); ctx.lineTo(W, 52); ctx.stroke();

    ctx.fillStyle = "#a78bfa";
    ctx.font = "bold 10px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText(`THE RACE  ·  WEEK ${weekNumber}  ·  ${weekLabel.toUpperCase()}`, 40, 32);

    ctx.fillStyle = "#f97316";
    ctx.font = "bold 12px 'Courier New'";
    ctx.textAlign = "right";
    ctx.fillText(`WEEK ${weekNumber}  ●  AI ROUNDUP`, W - 40, 32);

    // ── Layout: LEFT = headline + stats | RIGHT = leaderboard with NFT art ──
    const splitX = 440;

    // ── LEFT: Headline ───────────────────────────────────────────────────────
    ctx.fillStyle = "#e3e5e4";
    ctx.font = "bold 40px 'Arial'";
    ctx.textAlign = "left";
    const words = headline.split(" ");
    let line = "", lineY = 110;
    for (const word of words) {
      const test = line + word + " ";
      if (ctx.measureText(test).width > splitX - 60 && line) {
        ctx.fillText(line.trim(), 40, lineY);
        line = word + " ";
        lineY += 50;
      } else { line = test; }
    }
    ctx.fillText(line.trim(), 40, lineY);
    lineY += 56;

    // Burns badge
    ctx.fillStyle = "rgba(249,115,22,0.12)";
    ctx.fillRect(40, lineY, 280, 36);
    ctx.strokeStyle = "rgba(249,115,22,0.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(40, lineY, 280, 36);
    ctx.fillStyle = "#f97316";
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText(`📊 ${totalBurnsThisWeek} KEY DEVELOPMENTS THIS WEEK`, 56, lineY + 22);
    lineY += 60;

    // Tracking metric
    ctx.fillStyle = "rgba(167,139,250,0.08)";
    ctx.fillRect(40, lineY, 200, 80);
    ctx.strokeStyle = "rgba(167,139,250,0.2)";
    ctx.lineWidth = 1;
    ctx.strokeRect(40, lineY, 200, 80);
    ctx.fillStyle = "rgba(167,139,250,0.5)";
    ctx.font = "9px 'Courier New'";
    ctx.fillText("WEEKS TRACKED", 56, lineY + 22);
    ctx.fillStyle = "#a78bfa";
    ctx.font = "bold 48px 'Courier New'";
    ctx.fillText(String(weekNumber), 56, lineY + 68);

    // ── DIVIDER ──────────────────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(167,139,250,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(splitX, 60);
    ctx.lineTo(splitX, H - 44);
    ctx.stroke();

    // ── RIGHT: Top 5 with NFT art ────────────────────────────────────────────
    const rx = splitX + 24;
    const rowH = 100;
    const rowStartY = 60;

    // Fetch all NFT images in parallel
    const nftImages = await Promise.all(
      top5.map(e => fetchTokenImage(e.tokenId))
    );

    const maxAp = top5[0]?.ap ?? 1;
    const rankColors = ["#f97316", "#e3e5e4", "#a78bfa", "rgba(227,229,228,0.55)", "rgba(227,229,228,0.4)"];
    const rankBg = [
      "rgba(249,115,22,0.09)",
      "rgba(227,229,228,0.05)",
      "rgba(167,139,250,0.06)",
      "rgba(227,229,228,0.03)",
      "rgba(227,229,228,0.02)",
    ];

    for (let i = 0; i < Math.min(5, top5.length); i++) {
      const e = top5[i];
      const ry = rowStartY + i * rowH + 4;
      const imgSize = 76;

      // Row background
      ctx.fillStyle = rankBg[i];
      ctx.fillRect(rx, ry, W - rx - 20, rowH - 8);

      // NFT image — white bg for contrast
      ctx.fillStyle = "#e8e8e8";
      ctx.fillRect(rx + 8, ry + 8, imgSize, imgSize);

      const img = nftImages[i];
      if (img) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, rx + 8, ry + 8, imgSize, imgSize);
      } else {
        // Fallback: draw pixel art on white bg
        const pixels = await fetchPixels(e.tokenId);
        if (pixels) {
          const ps = imgSize / 40;
          for (let row = 0; row < 40; row++)
            for (let col = 0; col < 40; col++) {
              if (pixels[row * 40 + col] !== "1") continue;
              ctx.fillStyle = "#1a1a1a";
              ctx.fillRect(rx + 8 + col * ps, ry + 8 + row * ps, ps - 0.2, ps - 0.2);
            }
        }
      }

      // Rank badge overlaid on image
      ctx.fillStyle = rankColors[i];
      ctx.fillRect(rx + 8, ry + 8, 28, 20);
      ctx.fillStyle = "#0a0a0e";
      ctx.font = `bold ${i === 0 ? 13 : 11}px 'Courier New'`;
      ctx.textAlign = "left";
      ctx.fillText(`#${e.rank}`, rx + 11, ry + 22);

      // Token info
      const infoX = rx + imgSize + 20;
      ctx.fillStyle = rankColors[i];
      ctx.font = `bold ${i === 0 ? 16 : 14}px 'Courier New'`;
      ctx.textAlign = "left";
      ctx.fillText(`TOKEN #${e.tokenId}`, infoX, ry + 28);

      // Level + AP on same line
      ctx.fillStyle = "rgba(227,229,228,0.55)";
      ctx.font = "11px 'Courier New'";
      ctx.fillText(`LVL ${e.level}`, infoX, ry + 48);

      ctx.fillStyle = i === 0 ? "#f97316" : "rgba(167,139,250,0.8)";
      ctx.font = "bold 11px 'Courier New'";
      ctx.fillText(`${e.ap} AP`, infoX + 70, ry + 48);

      // AP progress bar
      const barX = infoX;
      const barW = W - infoX - 40;
      const barH = 4;
      const barY = ry + 60;
      const fillW = Math.max(4, Math.round((e.ap / maxAp) * barW));

      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = i === 0 ? "#f97316" : "#a78bfa";
      ctx.fillRect(barX, barY, fillW, barH);
    }

    // ── Bottom bar ───────────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(167,139,250,0.06)";
    ctx.fillRect(0, H - 44, W, 44);
    ctx.strokeStyle = "rgba(167,139,250,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 44); ctx.lineTo(W, H - 44); ctx.stroke();

    ctx.fillStyle = "#f97316";
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("AGENT306", 40, H - 16);

    ctx.fillStyle = "rgba(227,229,228,0.3)";
    ctx.font = "10px 'Courier New'";
    ctx.textAlign = "right";
    ctx.fillText("@agent306  ·  agent306.eth  ·  AI thought leader", W - 40, H - 16);

    // Outer border
    ctx.strokeStyle = "rgba(167,139,250,0.3)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    drawScanlines(ctx);
    return canvas.toBuffer("image/png");
  } catch (e: any) {
    console.error("[RaceCard] Error:", e.message);
    return null;
  }
}
