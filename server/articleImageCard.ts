// ─────────────────────────────────────────────────────────────────────────────
// 306 — ARTICLE IMAGE CARD GENERATOR
//
// Generates a 1200×500 PNG (5:2 aspect ratio) for X Article header images.
// Dark editorial aesthetic — Agent 306 branded.
//
// Layout:
//   Left:  Agent 306 pixel art (token #306) + 306 branding
//   Right: Headline text, source citation, article metadata
//   Top:   Orange accent bar + "THE DEEP READ" label
//   Bottom: agent306.eth watermark
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas, loadImage } from "canvas";
import * as fs   from "fs";
import * as path from "path";
import * as https from "https";

const W = 1200;
const H = 500;  // 5:2 aspect ratio (1200/500 = 2.4 ≈ 5:2)

// Palette — 306 dark editorial
const BG_DEEP   = "#080909";
const BG_PANEL  = "#0e0f10";
const BG_MID    = "#111213";
const FG        = "#e3e5e4";
const ORANGE    = "#f97316";
const ORANGE_DIM = "rgba(249,115,22,0.15)";
const DIM       = "rgba(227,229,228,0.25)";
const DIMMER    = "rgba(227,229,228,0.12)";

const CARD_DIR = "/tmp/agent306_cards";

function ensureCardDir() {
  if (!fs.existsSync(CARD_DIR)) fs.mkdirSync(CARD_DIR, { recursive: true });
}

// ── Fetch Agent 306 pixel string ─────────────────────────────────────────────
async function fetchPixels(tokenId = 306): Promise<string | null> {
  return new Promise(resolve => {
    const url = ""; // API disabled
    if (!url) return resolve(null);
    https.get(url, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data.trim().length === 1600 ? data.trim() : null));
    }).on("error", () => resolve(null));
  });
}

// ── Draw pixel art ─────────────────────────────────────────────────────────────
function drawPixelArt(
  ctx: any,
  pixels: string,
  x: number, y: number,
  pixelSize: number,
) {
  const GRID = 40;
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (pixels[row * GRID + col] !== "1") continue;
      ctx.fillStyle = FG;
      ctx.fillRect(x + col * pixelSize, y + row * pixelSize, pixelSize - 0.5, pixelSize - 0.5);
    }
  }
}

// ── Wrap text to max width ─────────────────────────────────────────────────────
function wrapText(ctx: any, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Scanlines overlay ──────────────────────────────────────────────────────────
function drawScanlines(ctx: any) {
  ctx.save();
  for (let y = 0; y < H; y += 3) {
    ctx.fillStyle = "rgba(0,0,0,0.06)";
    ctx.fillRect(0, y, W, 1);
  }
  ctx.restore();
}

// ── Main generator ─────────────────────────────────────────────────────────────
export async function generateArticleCard(opts: {
  headline:    string;
  sourceTitle: string;
  date?:       string;
  teaser?:     string;
}): Promise<Buffer | null> {
  try {
    const { headline, sourceTitle, date, teaser } = opts;
    ensureCardDir();

    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as any;

    // ── Background ─────────────────────────────────────────────────────────────
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, "#08090a");
    bgGrad.addColorStop(1, "#0d0e0f");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ── Left panel (Agent 306 zone) ────────────────────────────────────────────
    const LEFT_W = 340;
    const leftGrad = ctx.createLinearGradient(0, 0, LEFT_W, 0);
    leftGrad.addColorStop(0, "rgba(249,115,22,0.08)");
    leftGrad.addColorStop(1, "rgba(249,115,22,0.02)");
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, LEFT_W, H);

    // Left vertical border
    ctx.fillStyle = "rgba(249,115,22,0.25)";
    ctx.fillRect(LEFT_W, 0, 1, H);

    // ── Top orange accent bar ───────────────────────────────────────────────────
    ctx.fillStyle = ORANGE;
    ctx.fillRect(0, 0, W, 3);

    // ── "THE DEEP READ" label ───────────────────────────────────────────────────
    ctx.font = "bold 11px 'Courier New'";
    ctx.fillStyle = "rgba(249,115,22,0.7)";
    ctx.letterSpacing = "3px";
    ctx.fillText("── THE DEEP READ ──", 20, 32);
    ctx.fillText("306", W - 130, 32);

    // ── Agent 306 pixel art ────────────────────────────────────────────────────
    const pixels = await fetchPixels(306);
    if (pixels) {
      const pixelSize = 6;
      const artW = 40 * pixelSize;  // 240px
      const artX = (LEFT_W - artW) / 2;
      const artY = 65;
      drawPixelArt(ctx, pixels, artX, artY, pixelSize);

      // Subtle glow under pixel art
      const glowGrad = ctx.createRadialGradient(LEFT_W / 2, artY + artW / 2, 20, LEFT_W / 2, artY + artW / 2, 140);
      glowGrad.addColorStop(0, "rgba(249,115,22,0.08)");
      glowGrad.addColorStop(1, "rgba(249,115,22,0)");
      ctx.fillStyle = glowGrad;
      ctx.fillRect(0, artY - 20, LEFT_W, artW + 40);
      // Re-draw pixels over glow
      drawPixelArt(ctx, pixels, artX, artY, pixelSize);
    } else {
      // Fallback: just the #306 text
      ctx.font = "bold 48px 'Courier New'";
      ctx.fillStyle = ORANGE;
      ctx.textAlign = "center";
      ctx.fillText("#306", LEFT_W / 2, 220);
      ctx.textAlign = "left";
    }

    // ── Agent identity block ────────────────────────────────────────────────────
    const idY = pixels ? 65 + 40 * 6 + 20 : 260;

    ctx.font = "bold 13px 'Courier New'";
    ctx.fillStyle = ORANGE;
    ctx.textAlign = "center";
    ctx.fillText("AGENT #306", LEFT_W / 2, idY + 14);

    ctx.font = "10px 'Courier New'";
    ctx.fillStyle = DIM;
    ctx.fillText("agent306.eth", LEFT_W / 2, idY + 30);

    ctx.font = "9px 'Courier New'";
    ctx.fillStyle = "rgba(227,229,228,0.2)";
    ctx.fillText("SOVEREIGN AI · 306", LEFT_W / 2, idY + 46);
    ctx.textAlign = "left";

    // ── Right content zone ──────────────────────────────────────────────────────
    const RX = LEFT_W + 50;   // right zone x start
    const RW = W - RX - 50;   // right zone width
    let RY = 55;               // right zone y cursor

    // "DEEP READ" tag
    ctx.font = "bold 10px 'Courier New'";
    ctx.fillStyle = ORANGE;
    ctx.fillText("[DEEP READ]", RX, RY);
    RY += 22;

    // Thin separator
    ctx.fillStyle = "rgba(249,115,22,0.2)";
    ctx.fillRect(RX, RY, RW, 1);
    RY += 18;

    // ── Headline ─────────────────────────────────────────────────────────────────
    // Large, bold, wrapping headline
    const headlineMaxW = RW;
    let headlineFontSize = 32;

    // Auto-size: reduce font until headline fits in 3 lines
    ctx.font = `bold ${headlineFontSize}px 'Courier New'`;
    let headlineLines = wrapText(ctx, headline, headlineMaxW);
    while (headlineLines.length > 3 && headlineFontSize > 20) {
      headlineFontSize -= 2;
      ctx.font = `bold ${headlineFontSize}px 'Courier New'`;
      headlineLines = wrapText(ctx, headline, headlineMaxW);
    }

    const headlineLineH = headlineFontSize * 1.35;
    ctx.fillStyle = FG;
    for (const line of headlineLines.slice(0, 3)) {
      ctx.fillText(line, RX, RY + headlineFontSize);
      RY += headlineLineH;
    }
    RY += 16;

    // ── Teaser (if short enough) ─────────────────────────────────────────────────
    if (teaser && RY < 340) {
      ctx.font = "13px 'Courier New'";
      ctx.fillStyle = "rgba(227,229,228,0.55)";
      const teaserShort = teaser.length > 180 ? teaser.slice(0, 177) + "..." : teaser;
      const teaserLines = wrapText(ctx, teaserShort, RW);
      for (const line of teaserLines.slice(0, 3)) {
        if (RY > 360) break;
        ctx.fillText(line, RX, RY + 13);
        RY += 18;
      }
      RY += 10;
    }

    // ── Source + date ─────────────────────────────────────────────────────────────
    const bottomY = H - 40;

    // Bottom separator
    ctx.fillStyle = DIMMER;
    ctx.fillRect(RX, bottomY - 14, RW, 1);

    ctx.font = "10px 'Courier New'";
    ctx.fillStyle = DIM;
    const dateStr = date
      ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    ctx.fillText(`SOURCE: ${sourceTitle.toUpperCase()}`, RX, bottomY);
    ctx.fillText(dateStr, RX + RW - ctx.measureText(dateStr).width, bottomY);

    // ── Bottom bar ────────────────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(249,115,22,0.15)";
    ctx.fillRect(0, H - 3, W, 3);

    // ── Grid overlay (subtle editorial texture) ───────────────────────────────────
    ctx.save();
    ctx.strokeStyle = "rgba(227,229,228,0.025)";
    ctx.lineWidth = 0.5;
    for (let gx = LEFT_W; gx < W; gx += 60) {
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, H);
      ctx.stroke();
    }
    for (let gy = 0; gy < H; gy += 60) {
      ctx.beginPath();
      ctx.moveTo(LEFT_W, gy);
      ctx.lineTo(W, gy);
      ctx.stroke();
    }
    ctx.restore();

    // ── Scanlines ─────────────────────────────────────────────────────────────────
    drawScanlines(ctx);

    return canvas.toBuffer("image/png");

  } catch (e: any) {
    console.error("[ArticleCard] Generation failed:", e.message);
    return null;
  }
}

// ── Save card to file and return path ─────────────────────────────────────────
export async function saveArticleCard(opts: {
  headline:    string;
  sourceTitle: string;
  date?:       string;
  teaser?:     string;
  articleId?:  string;
}): Promise<string | null> {
  const buffer = await generateArticleCard(opts);
  if (!buffer) return null;

  ensureCardDir();
  const id = opts.articleId ?? `article_${Date.now()}`;
  const filePath = path.join(CARD_DIR, `${id}.png`);
  fs.writeFileSync(filePath, buffer);
  console.log(`[ArticleCard] Saved: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}
