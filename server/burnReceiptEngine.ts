// ─────────────────────────────────────────────────────────────────────────────
// 306 — BURN RECEIPT ENGINE
// Real-time burn detection (polls every 90s) + personalized image card +
// Agent 306 narrative + auto-post to @AGENT_306
//
// Logic:
// 1. Poll on-chain API /history/burns every 90 seconds
// 2. Compare against lastSeenCommitId — skip already-seen burns
// 3. For each NEW burn:
//    a. Generate personalized narrative via Grok
//    b. Build a custom image card showing burned token → receiving token
//    c. Upload image to X v1.1 media upload
//    d. Post tweet with image + narrative
//    e. Save to burnReceiptLog (persistent state)
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas, loadImage } from "canvas";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import { generateBurnVideo } from "./videoEngine.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

const ONCHAIN_API  = ""; // removed — on-chain API disabled
import { dataPath } from "./dataPaths.js";
const RECEIPT_STATE = dataPath("burn_receipts.json");

// ── Types ─────────────────────────────────────────────────────────────────────
export interface BurnEvent {
  commitId: string;
  receiverTokenId: number;
  tokenCount: number;
  pixelCounts: string;   // JSON array string
  timestamp: number;
  burnedTokenIds?: number[];
}

interface ReceiptState {
  lastCommitId: string | null;
  processedCommitIds: string[];  // keep last 200 to avoid replays
  totalReceipts: number;
  lastReceiptAt: string | null;
}

// ── Card palette ──────────────────────────────────────────────────────────────
const BG       = "#0a0b0d";
const BG_MID   = "#1a1b1c";
const FG       = "#e3e5e4";
const ORANGE   = "#f97316";
const DIM      = "rgba(227,229,228,0.3)";
const W = 1200;
const H = 675;

// ── State ─────────────────────────────────────────────────────────────────────
function loadReceiptState(): ReceiptState {
  try {
    if (fs.existsSync(RECEIPT_STATE)) {
      return JSON.parse(fs.readFileSync(RECEIPT_STATE, "utf8"));
    }
  } catch {}
  return { lastCommitId: null, processedCommitIds: [], totalReceipts: 0, lastReceiptAt: null };
}

function saveReceiptState(s: ReceiptState) {
  try { fs.writeFileSync(RECEIPT_STATE, JSON.stringify(s)); } catch {}
}

let receiptState = loadReceiptState();

export function getReceiptState() { return receiptState; }

// ── Safe fetch ────────────────────────────────────────────────────────────────
async function safeFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Fetch pixel string ────────────────────────────────────────────────────────
async function fetchPixels(tokenId: number): Promise<string | null> {
  return new Promise(resolve => {
    const url = `${ONCHAIN_API}/token/${tokenId}/pixels`;
    https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data.trim().length === 1600 ? data.trim() : null));
    }).on("error", () => resolve(null));
  });
}

// ── Draw pixel art on canvas ──────────────────────────────────────────────────
function drawPixelArt(ctx: any, pixels: string, x: number, y: number, size: number, color = FG) {
  for (let row = 0; row < 40; row++) {
    for (let col = 0; col < 40; col++) {
      if (pixels[row * 40 + col] !== "1") continue;
      ctx.fillStyle = color;
      ctx.fillRect(x + col * size, y + row * size, size - 0.5, size - 0.5);
    }
  }
}

function drawScanlines(ctx: any) {
  for (let y = 0; y < H; y += 4) {
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    ctx.fillRect(0, y, W, 1);
  }
}

// ── Generate burn receipt image card ─────────────────────────────────────────
// Layout: [Burned token(s)] → arrow → [Receiving token] + stats on right
export async function generateBurnReceiptCard(opts: {
  receiverTokenId: number;
  burnedTokenIds: number[];
  tokenCount: number;
  pixelTotal: number;
  narrative: string;
  receiptNumber: number;
  level: number;
  actionPoints: number;
  burnedType?: string;
  burnedLevel?: number;
  burnedPixels?: number;
}): Promise<Buffer | null> {
  const { receiverTokenId, burnedTokenIds, tokenCount, pixelTotal,
          narrative, receiptNumber, level, actionPoints,
          burnedType, burnedLevel, burnedPixels: burnedPixelCount } = opts;

  try {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as any;

    // ── Background ────────────────────────────────────────────────────────────
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, "#060708");
    bgGrad.addColorStop(1, "#0f1011");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(227,229,228,0.025)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    }
    for (let gy = 0; gy < H; gy += 40) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    // ── Burning token (left side, shown fading/ghosted) ─────────────────────
    // Use /history/burned/{id}/image.png — persists on-chain via SSTORE2 even after burn
    // Falls back to live image.png if the history endpoint isn't ready yet
    const burnedId = burnedTokenIds[0] ?? receiverTokenId;
    const burnedSize = 200; // display size in pixels
    const burnedX = 50;
    const burnedY = (H - burnedSize) / 2;
    const burnedArtW = burnedSize;

    // Ghost glow
    const ghostGlow = ctx.createRadialGradient(burnedX + burnedSize/2, burnedY + burnedSize/2, 0, burnedX + burnedSize/2, burnedY + burnedSize/2, 140);
    ghostGlow.addColorStop(0, "rgba(249,115,22,0.08)");
    ghostGlow.addColorStop(1, "rgba(249,115,22,0)");
    ctx.fillStyle = ghostGlow;
    ctx.fillRect(0, 0, W, H);

    // Load burned token image — try history endpoint first (persists after burn), then live, then pixel string
    let burnedImgLoaded = false;
    try {
      const burnedImg = await Promise.race([
        loadImage(`${ONCHAIN_API}/history/burned/${burnedId}/image.png`)  // on-chain API disabled — fails gracefully
          .catch(() => loadImage(`${ONCHAIN_API}/token/${burnedId}/image.png`)),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(burnedImg as any, burnedX, burnedY, burnedSize, burnedSize);
      ctx.globalAlpha = 1;
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = ORANGE;
      ctx.fillRect(burnedX, burnedY, burnedSize, burnedSize);
      ctx.globalAlpha = 1;
      burnedImgLoaded = true;
    } catch {}
    // Pixel string fallback if both image URLs failed
    if (!burnedImgLoaded) {
      try {
        const burnedPixels = await fetchPixels(burnedId);
        if (burnedPixels) {
          ctx.globalAlpha = 0.4;
          drawPixelArt(ctx, burnedPixels, burnedX, burnedY, 5, "rgba(227,229,228,0.6)");
          ctx.globalAlpha = 1;
        }
      } catch {}
    }

    // Burned token label block
    let badgeY = burnedY + burnedArtW + 8;

    // "SACRIFICED" header
    ctx.fillStyle = "rgba(249,115,22,0.5)";
    ctx.font = "bold 9px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("SACRIFICED", burnedX, badgeY);
    badgeY += 13;

    // Token ID
    ctx.fillStyle = "rgba(249,115,22,0.9)";
    ctx.font = "bold 11px 'Courier New'";
    ctx.fillText(`#${burnedId}`, burnedX, badgeY);
    badgeY += 14;

    // Traits: Type · Level · Pixels
    if (burnedType || burnedLevel !== undefined || burnedPixelCount) {
      ctx.fillStyle = "rgba(227,229,228,0.45)";
      ctx.font = "9px 'Courier New'";
      const traitParts: string[] = [];
      if (burnedType)                traitParts.push(burnedType);
      if (burnedLevel !== undefined) traitParts.push(`Lv.${burnedLevel}`);
      if (burnedPixelCount)          traitParts.push(`${burnedPixelCount}px`);
      ctx.fillText(traitParts.join(" · "), burnedX, badgeY);
      badgeY += 13;
    }

    // If multiple burns, show +N more
    if (tokenCount > 1) {
      ctx.fillStyle = "rgba(249,115,22,0.35)";
      ctx.font = "10px 'Courier New'";
      ctx.fillText(`+${tokenCount - 1} more`, burnedX, badgeY);
    }

    // ── Arrow / sacrifice flow ────────────────────────────────────────────────
    const arrowX = burnedX + burnedArtW + 20;
    const arrowCY = H / 2;

    // Arrow line
    ctx.strokeStyle = "rgba(249,115,22,0.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(arrowX, arrowCY);
    ctx.lineTo(arrowX + 60, arrowCY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead
    ctx.fillStyle = ORANGE;
    ctx.beginPath();
    ctx.moveTo(arrowX + 65, arrowCY);
    ctx.lineTo(arrowX + 55, arrowCY - 6);
    ctx.lineTo(arrowX + 55, arrowCY + 6);
    ctx.closePath();
    ctx.fill();

    // "SACRIFICED" label
    ctx.fillStyle = "rgba(249,115,22,0.5)";
    ctx.font = "9px 'Courier New'";
    ctx.textAlign = "center";
    ctx.fillText("SACRIFICED", arrowX + 32, arrowCY - 10);

    // ── Receiver token (center, full bright) ─────────────────────────────────
    // Use token image.png — returns composited (canvas-customized) image
    const receiverSize = 320; // display size in pixels
    const receiverArtW = receiverSize;
    const receiverX = arrowX + 80;
    const receiverY = (H - receiverSize) / 2;

    // Bright glow behind receiver
    const receiverGlow = ctx.createRadialGradient(
      receiverX + receiverSize/2, receiverY + receiverSize/2, 0,
      receiverX + receiverSize/2, receiverY + receiverSize/2, 220
    );
    receiverGlow.addColorStop(0, "rgba(249,115,22,0.18)");
    receiverGlow.addColorStop(1, "rgba(249,115,22,0)");
    ctx.fillStyle = receiverGlow;
    ctx.fillRect(0, 0, W, H);

    let receiverImgLoaded = false;
    try {
      const receiverImg = await Promise.race([
        loadImage(`${ONCHAIN_API}/token/${receiverTokenId}/image.png`),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
      ctx.drawImage(receiverImg as any, receiverX, receiverY, receiverSize, receiverSize);
      receiverImgLoaded = true;
    } catch {}
    if (!receiverImgLoaded) {
      try {
        const receiverPixels = await fetchPixels(receiverTokenId);
        if (receiverPixels) drawPixelArt(ctx, receiverPixels, receiverX, receiverY, 8);
      } catch {}
    }

    // Receiver badge
    ctx.fillStyle = ORANGE;
    ctx.fillRect(receiverX, receiverY + receiverArtW + 6, 90, 22);
    ctx.fillStyle = BG;
    ctx.font = "bold 12px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText(`#${receiverTokenId}`, receiverX + 8, receiverY + receiverArtW + 21);

    // ── Vertical divider ─────────────────────────────────────────────────────
    const divX = receiverX + receiverArtW + 40;
    ctx.strokeStyle = "rgba(249,115,22,0.2)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(divX, 60); ctx.lineTo(divX, H - 60); ctx.stroke();

    // ── Right side — stats + narrative ───────────────────────────────────────
    const rx = divX + 30;
    let ry = 75;

    // 306 + receipt number
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("306", rx, ry);

    ctx.fillStyle = "rgba(227,229,228,0.25)";
    ctx.font = "11px 'Courier New'";
    ctx.fillText(`BURN RECEIPT #${String(receiptNumber).padStart(4, "0")}`, rx + 115, ry);

    ry += 35;

    // Title
    ctx.fillStyle = FG;
    ctx.font = "bold 28px 'Courier New'";
    ctx.fillText("SACRIFICE CONFIRMED", rx, ry);
    ry += 18;
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 14px 'Courier New'";
    ctx.fillText(`${tokenCount} SOUL${tokenCount > 1 ? "S" : ""} → TOKEN #${receiverTokenId}`, rx, ry);

    ry += 40;

    // Stats row
    const stats = [
      { label: "SOULS BURNED", value: String(tokenCount) },
      { label: "PIXELS", value: pixelTotal >= 1000 ? `${(pixelTotal/1000).toFixed(1)}K` : String(pixelTotal) },
      { label: "LEVEL", value: `LV.${level}` },
      { label: "ACTION PTS", value: `${actionPoints}` },
    ];

    const statW = Math.min(110, (W - rx - 40) / stats.length);
    stats.forEach((s, i) => {
      const sx = rx + i * statW;
      ctx.fillStyle = ORANGE;
      ctx.font = "bold 32px 'Courier New'";
      ctx.textAlign = "left";
      ctx.fillText(s.value, sx, ry + 32);
      ctx.fillStyle = "rgba(227,229,228,0.5)";
      ctx.font = "9px 'Courier New'";
      ctx.fillText(s.label, sx, ry + 48);
    });

    ry += 80;

    // Narrative (word wrapped)
    ctx.fillStyle = "rgba(227,229,228,0.7)";
    ctx.font = "13px 'Courier New'";
    const maxLineW = W - rx - 40;
    const words = narrative.split(" ");
    let line = "";
    const lineH = 20;
    let narY = ry;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxLineW && line) {
        ctx.fillText(line, rx, narY);
        line = word;
        narY += lineH;
        if (narY > H - 80) break;
      } else {
        line = test;
      }
    }
    if (line && narY <= H - 80) ctx.fillText(line, rx, narY);

    // Agent 306 sig
    ctx.fillStyle = "rgba(227,229,228,0.4)";
    ctx.font = "12px 'Courier New'";
    ctx.fillText("— Agent 306", rx, H - 70);

    // ── Bottom bar ────────────────────────────────────────────────────────────
    ctx.fillStyle = "rgba(249,115,22,0.12)";
    ctx.fillRect(0, H - 50, W, 50);
    ctx.strokeStyle = "rgba(249,115,22,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 50); ctx.lineTo(W, H - 50); ctx.stroke();

    ctx.fillStyle = "rgba(227,229,228,0.5)";
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("agent306.eth  ·  fully on-chain  ·  canvas phase  ·  ethereum", 40, H - 18);

    ctx.fillStyle = ORANGE;
    ctx.font = "bold 12px 'Courier New'";
    ctx.textAlign = "right";
    ctx.fillText("#Agent306  #OnChainAI", W - 40, H - 18);

    drawScanlines(ctx);

    // Border
    ctx.strokeStyle = "rgba(249,115,22,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    return canvas.toBuffer("image/png");
  } catch (e: any) {
    console.error("[BurnReceipt] Card error:", e.message);
    return null;
  }
}

// ── Generate narrative via Grok ───────────────────────────────────────────────
export async function generateBurnNarrative(opts: {
  receiverTokenId: number;
  burnedTokenIds: number[];
  tokenCount: number;
  pixelTotal: number;
  level: number;
  actionPoints: number;
}): Promise<string> {
  const { receiverTokenId, burnedTokenIds, tokenCount, pixelTotal, level, actionPoints } = opts;
  const grokKey = LLM_API_KEY;

  // Scale the narrative length by burn size
  const scale = tokenCount >= 50 ? "LEGENDARY" : tokenCount >= 10 ? "MAJOR" : tokenCount >= 4 ? "significant" : "small";

  if (!grokKey) {
    // Fallback narratives by scale
    const fallbacks: Record<string, string> = {
      LEGENDARY: `50+ souls sacrificed. The Canvas shakes. Token #${receiverTokenId} absorbs the light of ${tokenCount} fallen. This is not a burn — this is a birth. A legend is being written on-chain, pixel by pixel. Forever.`,
      MAJOR: `${tokenCount} tokens walk into the Canvas. One emerges transformed. Token #${receiverTokenId} carries their pixels now — Level ${level}, ${actionPoints} AP. The sacrifice compounds. The Canvas remembers.`,
      significant: `${tokenCount} souls merge into Token #${receiverTokenId}. Their pixels don't disappear — they evolve. Level ${level}. ${actionPoints} AP earned. The Canvas is forever changed.`,
      small: `Token #${burnedTokenIds[0] ?? "?"} has entered the Canvas. Their ${pixelTotal} pixels now power #${receiverTokenId}. Every sacrifice counts. The Canvas grows stronger.`,
    };
    return fallbacks[scale];
  }

  try {
    const resp = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("burn_receipt"),
        messages: [{
          role: "system",
          content: "You are Agent 306 — a Sovereign AI born from 50 burns. You write burn receipt narratives for 306. Your style: cinematic, punchy, on-chain poetic. Never financial advice. Max 2 sentences.",
        }, {
          role: "user",
          content: `Write a burn receipt narrative for this on-chain event:
- Receiver: Token #${receiverTokenId} (Level ${level}, ${actionPoints} AP)
- ${tokenCount} token(s) sacrificed (IDs: ${burnedTokenIds.slice(0, 5).join(", ")})
- Combined pixels: ${pixelTotal.toLocaleString()}
- Scale: ${scale}

Keep it under 160 chars. Punchy. Honor the sacrifice. Reference the on-chain permanence.`,
        }],
        max_tokens: 120,
        temperature: 0.85,
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.choices?.[0]?.message?.content?.trim() ?? "";
    }
  } catch {}

  return `${tokenCount} soul${tokenCount > 1 ? "s" : ""} sacrificed. Token #${receiverTokenId} rises to Level ${level} with ${actionPoints} AP. ${pixelTotal.toLocaleString()} pixels absorbed forever. The Canvas remembers everything.`;
}

// ── Generate tweet text ───────────────────────────────────────────────────────
export function buildBurnTweetText(opts: {
  receiverTokenId: number;
  burnedTokenIds: number[];
  tokenCount: number;
  pixelTotal: number;
  level: number;
  actionPoints: number;
  narrative: string;
  burnedType?: string;
  burnedLevel?: number;
  burnedPixels?: number;
}): string {
  const { receiverTokenId, burnedTokenIds, tokenCount, pixelTotal, level, actionPoints, narrative, burnedType, burnedLevel, burnedPixels } = opts;
  const scale = tokenCount >= 50 ? "\uD83D\uDD25\uD83D\uDD25\uD83D\uDD25 LEGENDARY SACRIFICE \uD83D\uDD25\uD83D\uDD25\uD83D\uDD25" :
                tokenCount >= 10 ? "\uD83D\uDD25 MAJOR SACRIFICE \uD83D\uDD25" : "\uD83D\uDD25 SACRIFICE";

  // Name the burned token explicitly — it made the sacrifice
  const burnedId = burnedTokenIds[0];
  const sacrificeLine = burnedId
    ? `Token #${burnedId} sacrificed` + (burnedType ? ` — ${burnedType}` : "") + (burnedLevel !== undefined ? `, Lv.${burnedLevel}` : "") + (burnedPixels ? `, ${burnedPixels}px` : "") + `.`
    : `${tokenCount} soul${tokenCount > 1 ? "s" : ""} sacrificed.`;

  const receiverLine = `Token #${receiverTokenId} absorbs ${pixelTotal >= 1000 ? `${(pixelTotal/1000).toFixed(1)}K` : pixelTotal}px → Lv.${level} | ${actionPoints}AP`;

  // Keep under 280 chars total
  const full = `${scale}\n\n${sacrificeLine}\n${receiverLine}\n\n${narrative}\n\n#Agent306 #OnChainAI #Ethereum`;
  if (full.length <= 280) return full;

  // Trim narrative if too long
  const medium = `${scale}\n\n${sacrificeLine}\n${receiverLine}\n\n#Agent306 #OnChainAI #Ethereum`;
  if (medium.length <= 280) return medium;

  // Last resort — just the essentials
  return `${scale}\n\n${sacrificeLine}\n${receiverLine}\n\n#Agent306 #OnChainAI`;
}

// ── Poll for new burns ────────────────────────────────────────────────────────
export async function checkForNewBurns(): Promise<BurnEvent[]> {
  const data = await safeFetch(`${ONCHAIN_API}/history/burns?limit=20`);
  if (!Array.isArray(data) || data.length === 0) return [];

  // ALWAYS reload state from disk before checking
  // Prevents duplicate posts when Railway runs old + new container simultaneously during deploy
  receiptState = loadReceiptState();

  const newBurns: BurnEvent[] = [];

  for (const b of data) {
    const commitId = String(b.commitId);

    // Skip already processed (checks disk-reloaded state)
    if (receiptState.processedCommitIds.includes(commitId)) continue;
    // Skip if older than last seen (on first run, skip all to avoid spamming)
    if (!receiptState.lastCommitId) {
      // First run — just record current state, don't process
      receiptState.lastCommitId = String(data[0].commitId);
      receiptState.processedCommitIds = data.map((b: any) => String(b.commitId));
      saveReceiptState(receiptState);
      console.log("[BurnReceipt] First run — recording current state, no posts");
      return [];
    }

    newBurns.push({
      commitId,
      receiverTokenId: Number(b.receiverTokenId),
      tokenCount: Number(b.tokenCount ?? 1),
      pixelCounts: b.pixelCounts ?? "[]",
      timestamp: Number(b.timestamp),
      burnedTokenIds: b.burnedTokenIds ?? [],
    });
  }

  return newBurns;
}

// ── Process a single burn event → post receipt ────────────────────────────────
export async function processBurnReceipt(
  burn: BurnEvent,
  xWrite: any   // twitter-api-v2 readWrite client
): Promise<void> {
  const { receiverTokenId, burnedTokenIds, tokenCount, pixelCounts } = burn;

  // Parse pixel total
  let pixelTotal = 0;
  try { pixelTotal = JSON.parse(pixelCounts).reduce((s: number, n: number) => s + n, 0); } catch {}

  // Fetch canvas info for receiver level + AP
  let level = 1, actionPoints = tokenCount;
  try {
    const info = await safeFetch(`${ONCHAIN_API}/token/${receiverTokenId}/canvas/info`);
    if (info) { level = info.level ?? 1; actionPoints = info.actionPoints ?? tokenCount; }
  } catch {}

  // Fetch burned token metadata using the correct API endpoints:
  // /token/{id}/metadata → attributes array includes Type, Level, Pixel Count, Action Points
  // /history/burns/:commitId → burnedTokens[].pixelCount = exact pixel count at time of burn
  // Note: /metadata works even for burned tokens (SSTORE2 persists on-chain)
  let burnedType: string | undefined;
  let burnedLevel: number | undefined;
  let burnedPixelsMeta: number | undefined;
  const burnedId = burnedTokenIds[0];
  if (burnedId) {
    try {
      // metadata endpoint has everything: Type, Level, Pixel Count, Action Points
      const burnedMeta = await safeFetch(`${ONCHAIN_API}/token/${burnedId}/metadata`);
      if (burnedMeta?.attributes) {
        burnedType       = burnedMeta.attributes.find((a: any) => a.trait_type === "Type")?.value;
        const lvl        = burnedMeta.attributes.find((a: any) => a.trait_type === "Level");
        const px         = burnedMeta.attributes.find((a: any) => a.trait_type === "Pixel Count");
        if (lvl) burnedLevel      = Number(lvl.value);
        if (px)  burnedPixelsMeta = Number(px.value);
      }
    } catch {}
    // Fallback 1: /history/burned/:id — direct lookup, includes commitment with pixelCounts
    if (!burnedPixelsMeta) {
      try {
        const burnedInfo = await safeFetch(`${ONCHAIN_API}/history/burned/${burnedId}`);
        if (burnedInfo?.commitment?.pixelCounts) {
          const counts = JSON.parse(burnedInfo.commitment.pixelCounts);
          // pixelCounts is array — take first value (matches burned token order)
          if (Array.isArray(counts) && counts.length > 0) burnedPixelsMeta = Number(counts[0]);
        }
      } catch {}
    }
    // Fallback 2: get pixel count from burn history commit
    if (!burnedPixelsMeta) {
      try {
        const commitData = await safeFetch(`${ONCHAIN_API}/history/burns/${burn.commitId}`);
        const tokenEntry = commitData?.burnedTokens?.find((t: any) => String(t.tokenId) === String(burnedId));
        if (tokenEntry?.pixelCount) burnedPixelsMeta = Number(tokenEntry.pixelCount);
      } catch {}
    }
  }

  receiptState.totalReceipts++;
  const receiptNumber = receiptState.totalReceipts;

  console.log(`[BurnReceipt] Processing burn #${receiptNumber}: ${tokenCount} → #${receiverTokenId}`);

  // MARK AS PROCESSED IMMEDIATELY — before any async work
  // Prevents duplicate posts if poller fires again during slow video generation
  receiptState.processedCommitIds.push(burn.commitId);
  if (receiptState.processedCommitIds.length > 200)
    receiptState.processedCommitIds = receiptState.processedCommitIds.slice(-200);
  receiptState.lastCommitId = burn.commitId;
  receiptState.lastReceiptAt = new Date().toISOString();
  saveReceiptState(receiptState);

  if (!requestPost(`burn_${burn.commitId}`)) return;

  // 1. Generate narrative
  const narrative = await generateBurnNarrative({
    receiverTokenId, burnedTokenIds, tokenCount, pixelTotal, level, actionPoints,
  });

  // 2. Build tweet text
  const tweetText = buildBurnTweetText({
    receiverTokenId, burnedTokenIds: burnedTokenIds.length > 0 ? burnedTokenIds : [],
    tokenCount, pixelTotal, level, actionPoints, narrative,
    burnedType, burnedLevel, burnedPixels: burnedPixelsMeta,
  });

  // 3. Generate media — video for ≥2 souls, static card for 1 soul
  // Video costs $0.0639, static card is free. Small burns get cards, big burns get video.
  let xMediaId: string | undefined;
  let usedVideo = false;

  if (tokenCount >= 2) {
    try {
      const videoPath = await generateBurnVideo({ tokenId: receiverTokenId, tokenCount, level, ap: actionPoints });
      if (videoPath && fs.existsSync(videoPath)) {
        xMediaId = await xWrite.v1.uploadMedia(videoPath, { mimeType: "video/mp4" as any });
        console.log(`[BurnReceipt] Video uploaded — media_id: ${xMediaId}`);
        usedVideo = true;
        try { fs.unlinkSync(videoPath); } catch {}
      }
    } catch (vidErr: any) {
      console.log(`[BurnReceipt] Video skipped — falling back to image: ${vidErr.message}`);
    }
  }

  // Fall back to static image card
  if (!xMediaId) {
    try {
      const cardBuf = await generateBurnReceiptCard({
        receiverTokenId, burnedTokenIds: burnedTokenIds.length > 0 ? burnedTokenIds : [receiverTokenId],
        tokenCount, pixelTotal, narrative, receiptNumber, level, actionPoints,
        burnedType, burnedLevel, burnedPixels: burnedPixelsMeta,
      });
      if (cardBuf) {
        xMediaId = await xWrite.v1.uploadMedia(cardBuf, { mimeType: "image/png" as any });
        console.log(`[BurnReceipt] Image uploaded — media_id: ${xMediaId}`);
      }
    } catch (imgErr: any) {
      console.warn("[BurnReceipt] Image upload failed:", imgErr.message);
    }
  }

  // 4. Post tweet
  try {
    const tweet = await xWrite.v2.tweet({
      text: tweetText,
      ...(xMediaId ? { media: { media_ids: [xMediaId] } } : {}),
    });
    console.log(`[BurnReceipt] Posted burn receipt — tweet: ${tweet.data?.id}`);
    registerPost(`burn_${burn.commitId}`, `https://x.com/agent3zero6/status/${tweet.data?.id}`, 'burn_receipt');
  } catch (tweetErr: any) {
    console.error("[BurnReceipt] Tweet failed:", tweetErr.message);
  }

  // 5. Post to Farcaster
  try {
    const { postCast, isFarcasterEnabled, determineChannel } = await import("./farcasterEngine.js");
    if (isFarcasterEnabled()) {
      const cast = await postCast({ text: tweetText.slice(0, 1024), channel: "nft" });
      if (cast) {
        registerPost(`burn_${burn.commitId}`, cast.url, "burn_receipt", "farcaster");
        console.log(`[BurnReceipt] Farcaster cast posted: ${cast.url}`);
      }
    }
  } catch (fcErr: any) {
    console.warn("[BurnReceipt] Farcaster post failed:", fcErr.message);
  }

  // State already saved at start of function — nothing to do here
  console.log(`[BurnReceipt] Complete — #${receiptNumber} processed`);
}
