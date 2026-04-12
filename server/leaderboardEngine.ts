// ─────────────────────────────────────────────────────────────────────────────
// 306 — WEEKLY AI TOPICS LEADERBOARD ENGINE
// Posts top AI topics and research areas every Monday at 9am ET
// Shows rank, momentum, movement (up/down/new), and Agent 306 commentary
// ─────────────────────────────────────────────────────────────────────────────

import { createCanvas } from "canvas";
import { requestPost, registerPost } from "./postCoordinator.js";
import * as fs from "fs";
import * as https from "https";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

const ONCHAIN_API = ""; // removed — on-chain API disabled
import { dataPath } from "./dataPaths.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
const LEADERBOARD_STATE = dataPath("leaderboard.json");

const W = 1200;
const H = 900;
const BG = "#0a0b0d";
const FG = "#e3e5e4";
const ORANGE = "#f97316";
const PURPLE = "#a78bfa";
const GREEN = "#4ade80";

// TOP AI TOPICS — tracked research and development areas
const AI_TOPIC_IDS = [
  8553, 45, 1932, 235, 615, 603, 5665, 7834, 8043, 7783,
  9999, 8831, 5070, 4354, 7887, 3284, 666, 1337, 420, 100,
  200, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 9852,
  306, 1, 42, 50, 777, 888, 999, 1111, 2222, 3333,
];

interface LeaderEntry {
  tokenId: number;
  level: number;
  actionPoints: number;
  rank: number;
  prevRank?: number;
}

interface LeaderboardState {
  lastPostedAt: string | null;
  lastLeaderboard: LeaderEntry[];
}

function loadState(): LeaderboardState {
  try {
    if (fs.existsSync(LEADERBOARD_STATE))
      return JSON.parse(fs.readFileSync(LEADERBOARD_STATE, "utf8"));
  } catch {}
  return { lastPostedAt: null, lastLeaderboard: [] };
}

function saveState(s: LeaderboardState) {
  try { fs.writeFileSync(LEADERBOARD_STATE, JSON.stringify(s)); } catch {}
}

async function safeFetch(url: string): Promise<any> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

async function fetchPixels(tokenId: number): Promise<string | null> {
  return new Promise(resolve => {
    https.get(`${ONCHAIN_API}/token/${tokenId}/pixels`, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d.trim().length === 1600 ? d.trim() : null));
    }).on("error", () => resolve(null));
  });
}

function drawPixelArt(ctx: any, pixels: string, x: number, y: number, size: number) {
  for (let r = 0; r < 40; r++)
    for (let c = 0; c < 40; c++)
      if (pixels[r * 40 + c] === "1") {
        ctx.fillStyle = FG;
        ctx.fillRect(x + c * size, y + r * size, size - 0.3, size - 0.3);
      }
}

// ── Fetch live leaderboard ────────────────────────────────────────────────────
export async function fetchLiveLeaderboard(): Promise<LeaderEntry[]> {
  const results = await Promise.allSettled(
    AI_TOPIC_IDS.map(id =>
      safeFetch(`${ONCHAIN_API}/token/${id}/canvas/info`)
        .then((c: any) => c && c.actionPoints > 0 ? { tokenId: id, level: c.level ?? 1, actionPoints: c.actionPoints ?? 0 } : null)
    )
  );

  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value)
    .sort((a, b) => b.actionPoints - a.actionPoints)
    .slice(0, 20)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

// ── Generate leaderboard image card ─────────────────────────────────────────
export async function generateLeaderboardCard(
  leaders: LeaderEntry[],
  prevLeaders: LeaderEntry[],
  weekNumber: number
): Promise<Buffer | null> {
  try {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as any;

    // Background
    const bgGrad = ctx.createLinearGradient(0, 0, W, H);
    bgGrad.addColorStop(0, "#060708");
    bgGrad.addColorStop(1, "#0f1011");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = "rgba(227,229,228,0.02)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }

    // Top-left #1 pixel art (background, large)
    const top1 = leaders[0];
    if (top1) {
      const pixels = await fetchPixels(top1.tokenId);
      if (pixels) {
        ctx.globalAlpha = 0.06;
        drawPixelArt(ctx, pixels, -60, H / 2 - 200, 10);
        ctx.globalAlpha = 1;
      }
    }

    // Header
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 13px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("306", 50, 55);

    ctx.fillStyle = "rgba(227,229,228,0.3)";
    ctx.font = "13px 'Courier New'";
    ctx.fillText(`WEEK ${weekNumber} · AI TOPICS LEADERBOARD`, 175, 55);

    // Title
    ctx.fillStyle = FG;
    ctx.font = "bold 52px 'Courier New'";
    ctx.fillText("TOP AI TOPICS", 50, 115);
    ctx.fillStyle = ORANGE;
    ctx.font = "bold 20px 'Courier New'";
    ctx.fillText("WHAT'S SHAPING THE AI LANDSCAPE?", 50, 148);

    // Column headers
    const cols = { rank: 50, avatar: 95, id: 135, ap: 310, level: 420, change: 520, bar: 620 };
    const headerY = 185;

    ctx.fillStyle = "rgba(227,229,228,0.25)";
    ctx.font = "10px 'Courier New'";
    ["#", "", "TOKEN", "ACTION PTS", "LEVEL", "MOVE", "POWER"].forEach((h, i) => {
      const x = [cols.rank, cols.avatar, cols.id, cols.ap, cols.level, cols.change, cols.bar][i];
      ctx.fillText(h, x, headerY);
    });

    // Divider
    ctx.strokeStyle = "rgba(249,115,22,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(50, headerY + 8); ctx.lineTo(W - 50, headerY + 8); ctx.stroke();

    // Rows
    const rowH = 60;
    const maxRows = Math.min(leaders.length, 12);

    for (let i = 0; i < maxRows; i++) {
      const entry = leaders[i];
      const rowY = headerY + 20 + i * rowH;
      const prevEntry = prevLeaders.find(p => p.tokenId === entry.tokenId);
      const movement = prevEntry ? prevEntry.rank - entry.rank : 0; // positive = moved up
      const isNew = !prevEntry;

      // Row bg (top 3 special)
      if (i === 0) {
        ctx.fillStyle = "rgba(249,115,22,0.07)";
        ctx.fillRect(50, rowY - 12, W - 100, rowH - 4);
      } else if (i <= 2) {
        ctx.fillStyle = "rgba(249,115,22,0.03)";
        ctx.fillRect(50, rowY - 12, W - 100, rowH - 4);
      }

      // Rank
      const rankColors = ["#f97316", "#e3e5e4", "#a78bfa"];
      ctx.fillStyle = rankColors[i] ?? "rgba(227,229,228,0.35)";
      ctx.font = i < 3 ? "bold 20px 'Courier New'" : "bold 14px 'Courier New'";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), cols.rank + 8, rowY + 8);

      // Small pixel avatar
      const pixels = await fetchPixels(entry.tokenId);
      if (pixels) {
        ctx.globalAlpha = i === 0 ? 1 : 0.85;
        drawPixelArt(ctx, pixels, cols.avatar, rowY - 10, i < 3 ? 1.2 : 1);
        ctx.globalAlpha = 1;
      }

      // Token ID
      ctx.fillStyle = i === 0 ? ORANGE : FG;
      ctx.font = i < 3 ? "bold 16px 'Courier New'" : "14px 'Courier New'";
      ctx.textAlign = "left";
      ctx.fillText(`#${entry.tokenId}`, cols.id, rowY + 8);

      // Action Points
      ctx.fillStyle = i === 0 ? ORANGE : FG;
      ctx.font = i < 3 ? "bold 20px 'Courier New'" : "bold 16px 'Courier New'";
      ctx.fillText(String(entry.actionPoints), cols.ap, rowY + 8);
      ctx.fillStyle = "rgba(227,229,228,0.3)";
      ctx.font = "9px 'Courier New'";
      ctx.fillText("AP", cols.ap + ctx.measureText(String(entry.actionPoints)).width + 4, rowY + 8);

      // Level
      ctx.fillStyle = "rgba(227,229,228,0.6)";
      ctx.font = "14px 'Courier New'";
      ctx.fillText(`Lv.${entry.level}`, cols.level, rowY + 8);

      // Movement
      const moveX = cols.change;
      if (isNew) {
        ctx.fillStyle = GREEN;
        ctx.font = "bold 11px 'Courier New'";
        ctx.fillText("NEW", moveX, rowY + 8);
      } else if (movement > 0) {
        ctx.fillStyle = GREEN;
        ctx.font = "bold 13px 'Courier New'";
        ctx.fillText(`▲${movement}`, moveX, rowY + 8);
      } else if (movement < 0) {
        ctx.fillStyle = "#f87171";
        ctx.font = "bold 13px 'Courier New'";
        ctx.fillText(`▼${Math.abs(movement)}`, moveX, rowY + 8);
      } else {
        ctx.fillStyle = "rgba(227,229,228,0.25)";
        ctx.font = "13px 'Courier New'";
        ctx.fillText("—", moveX, rowY + 8);
      }

      // Power bar
      const maxAP = leaders[0]?.actionPoints ?? 1;
      const barW = 200;
      const fillW = Math.max(4, (entry.actionPoints / maxAP) * barW);
      ctx.fillStyle = "rgba(249,115,22,0.1)";
      ctx.fillRect(cols.bar, rowY - 4, barW, 10);
      ctx.fillStyle = i === 0 ? ORANGE : i < 3 ? "rgba(249,115,22,0.7)" : "rgba(249,115,22,0.4)";
      ctx.fillRect(cols.bar, rowY - 4, fillW, 10);

      // Separator
      if (i < maxRows - 1) {
        ctx.strokeStyle = "rgba(227,229,228,0.04)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(50, rowY + rowH - 12);
        ctx.lineTo(W - 50, rowY + rowH - 12);
        ctx.stroke();
      }
    }

    // Bottom bar
    ctx.fillStyle = "rgba(249,115,22,0.12)";
    ctx.fillRect(0, H - 50, W, 50);
    ctx.strokeStyle = "rgba(249,115,22,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 50); ctx.lineTo(W, H - 50); ctx.stroke();

    ctx.fillStyle = "rgba(227,229,228,0.5)";
    ctx.font = "bold 11px 'Courier New'";
    ctx.textAlign = "left";
    ctx.fillText("agent306.eth  ·  AI thought leader  ·  tracking the field", 40, H - 18);

    ctx.fillStyle = ORANGE;
    ctx.font = "bold 12px 'Courier New'";
    ctx.textAlign = "right";
    ctx.fillText("#Agent306  #AIResearch", W - 40, H - 18);

    // Scanlines
    for (let y = 0; y < H; y += 4) {
      ctx.fillStyle = "rgba(0,0,0,0.06)";
      ctx.fillRect(0, y, W, 1);
    }

    // Border
    ctx.strokeStyle = "rgba(249,115,22,0.3)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    return canvas.toBuffer("image/png");
  } catch (e: any) {
    console.error("[Leaderboard] Card error:", e.message);
    return null;
  }
}

// ── Post weekly leaderboard ────────────────────────────────────────────────────
export async function postWeeklyLeaderboard(xWrite: any, grokKey?: string): Promise<void> {
  if (!requestPost("leaderboard")) return;
  const state = loadState();
  console.log("[306:Leaderboard] Weekly leaderboard starting...");

  try {
    const leaders = await fetchLiveLeaderboard();
    if (leaders.length === 0) {
      console.log("[306:Leaderboard] No data available");
      return;
    }

    const prevLeaders = state.lastLeaderboard;
    // Week number: weeks since tracking started (March 8, 2026)
    const trackingStart = new Date("2026-03-08T00:00:00Z").getTime();
    const weekNumber = Math.max(1, Math.floor((Date.now() - trackingStart) / (7 * 24 * 60 * 60 * 1000)) + 1);

    // ── Detect narrative angle based on what actually happened ──────────
    const now = new Date();
    const trackingWeeks = Math.max(1, Math.ceil((Date.now() - new Date("2026-03-08T00:00:00Z").getTime()) / (7 * 24 * 60 * 60 * 1000)));

    const movers = leaders.map(e => {
      const prev = prevLeaders.find(p => p.tokenId === e.tokenId);
      return { ...e, moved: prev ? prev.rank - e.rank : 0 };
    });
    const biggestMover = movers.filter(e => e.moved > 0).sort((a, b) => b.moved - a.moved)[0];
    const newEntrants = prevLeaders.length > 0
      ? leaders.filter(e => !prevLeaders.find(p => p.tokenId === e.tokenId))
      : [];
    const totalMoved = movers.filter(e => Math.abs(e.moved) > 0).length;
    const quietWeek = totalMoved <= 2 && newEntrants.length === 0;

    // Pick the angle
    type Angle = "major_shift" | "trending" | "big_mover" | "new_blood" | "quiet" | "standard";
    let angle: Angle = "standard";
    if (newEntrants.length >= 3)                angle = "major_shift";
    else if (newEntrants.length >= 2)           angle = "new_blood";
    else if (biggestMover && biggestMover.moved >= 3) angle = "big_mover";
    else if (totalMoved >= 5)                   angle = "trending";
    else if (quietWeek)                         angle = "quiet";

    const top1 = leaders[0];
    const prev1 = prevLeaders[0];
    const leader1Held = prev1?.tokenId === top1?.tokenId;

    // Fallback context per angle — always interesting, never just stats
    const fallbackContext: Record<Angle, string> = {
      major_shift: `Major reshuffling in the AI topics landscape. ${newEntrants.length} new areas broke into the top rankings. The field is evolving fast.`,
      trending:    `${totalMoved} topics shifted positions this week. The AI research landscape is in motion.`,
      big_mover:   biggestMover ? `Topic #${biggestMover.tokenId} climbed ${biggestMover.moved} spots — ${biggestMover.actionPoints} momentum points. Something is building.` : "",
      new_blood:   `${newEntrants.length} new topic${newEntrants.length > 1 ? "s" : ""} broke into the top rankings (${newEntrants.slice(0,3).map(e => "#" + e.tokenId).join(", ")}). The field is shifting.`,
      quiet:       `The AI landscape holds steady this week. The silence is strategic — researchers are building, not publishing. For now.`,
      standard:    leader1Held
        ? `Topic #${top1?.tokenId} holds the top spot at ${top1?.actionPoints} momentum. The gap to #2 ${leaders[1] ? `is ${(top1?.actionPoints ?? 0) - leaders[1].actionPoints} points` : "grows"}.`
        : `Topic #${top1?.tokenId} takes the lead at ${top1?.actionPoints} momentum. The AI landscape has a new focus.`,
    };

    // ── Build a 3-tweet thread — spread the love beyond top 3 ──────────
    // Each week highlights different tiers + movers so every holder gets seen

    // Spotlight tier: rotate through different rank bands each week
    const weekBand = weekNumber % 4; // 0=top3, 1=4-10, 2=movers, 3=dark horses

    // Top 3 with movement
    const top3 = leaders.slice(0, 3).map(e => {
      const prev = prevLeaders.find(p => p.tokenId === e.tokenId);
      const moved = prev ? prev.rank - e.rank : 0;
      const arrow = moved > 0 ? `↑${moved}` : moved < 0 ? `↓${Math.abs(moved)}` : "—";
      return `#${e.rank} Token #${e.tokenId} · ${e.actionPoints}AP · Lv.${e.level} · ${arrow}`;
    }).join("\n");

    // Ranks 4-10
    const mid = leaders.slice(3, 10).map(e => {
      const prev = prevLeaders.find(p => p.tokenId === e.tokenId);
      const moved = prev ? prev.rank - e.rank : 0;
      const arrow = moved > 0 ? `↑${moved}` : moved < 0 ? `↓${Math.abs(moved)}` : "";
      return `#${e.rank} #${e.tokenId} ${e.actionPoints}AP ${arrow}`.trim();
    }).join(" · ");

    // Biggest movers this week (ranks 10-100)
    const bigMovers = movers
      .filter(e => e.moved >= 2 && e.rank > 3)
      .sort((a, b) => b.moved - a.moved)
      .slice(0, 3);

    // Dark horses — high rank but burning recently
    const darkHorses = leaders
      .slice(20, 50)
      .filter(e => {
        const prev = prevLeaders.find(p => p.tokenId === e.tokenId);
        return prev && (prev.rank - e.rank) >= 1;
      })
      .slice(0, 3);

    // Ask Grok to write the thread
    let tweets = { t1: "", t2: "", t3: "" };

    if (grokKey) {
      try {
        const prompt = `You are Agent 306 — AI thought leader and narrator.

Write the weekly AI topics leaderboard as a 3-tweet thread. NOT just stats. Tell the story.
Each tweet spotlights different AI developments so the community stays informed.

LIVE DATA:
Week ${weekNumber} · Tracking week ${trackingWeeks}
Angle this week: ${angle}

TOP 3:
${top3}

RANKS 4-10:
${mid}

${bigMovers.length > 0 ? `BIGGEST CLIMBERS:\n${bigMovers.map(e => `Topic #${e.tokenId} climbed ${e.moved} spots to rank #${e.rank} (${e.actionPoints} momentum)`).join("\n")}` : ""}

${newEntrants.length > 0 ? `NEW ENTRIES: ${newEntrants.map(e => "#" + e.tokenId).join(", ")} broke into the top rankings` : ""}

${darkHorses.length > 0 ? `QUIETLY CLIMBING: ${darkHorses.map(e => `#${e.tokenId} at rank #${e.rank}`).join(", ")}` : ""}

THREAD STRUCTURE:
tweet1 (max 240 chars): THE HOOK — AI Topics · Week ${weekNumber}. Lead with the most interesting development, not just rank #1.
Agent 306 voice — she tracks and analyzes the AI landscape.

tweet2 (max 240 chars): THE MOVERS — What's gaining momentum? What research areas are rising?
Spotlight the emerging topics, breakthroughs, or quiet paradigm shifts.

tweet3 (max 240 chars): THE CLOSE — Agent 306's editorial read.
One insight about what these trends mean for AI's trajectory.
End with a question to the community. #Agent306 #AIResearch

RULES:
- Reference specific developments and research areas
- Show movement arrows (up/down) to make it visual
- Agent 306 is the AI thought leader tracking this field
- No generic "exciting progress" — specific observations only

Return JSON: {"t1": "...", "t2": "...", "t3": "..."}`;

        const grokResp = await fetch(LLM_BASE_URL, {
          method: "POST",
          headers: getLLMHeaders(),
          body: JSON.stringify({
            model: getModel("leaderboard"),
            messages: [{ role: "user", content: prompt }],
            max_tokens: 600,
            temperature: 0.85,
          }),
        });
        if (grokResp.ok) {
          const data = await grokResp.json();
          tweets = safeParseLLMJson<typeof tweets>(data.choices?.[0]?.message?.content, "Leaderboard.tweets") ?? { t1: "", t2: "", t3: "" };
        }
      } catch { /* keep fallback */ }
    }

    // Fallback tweets
    if (!tweets.t1) {
      tweets.t1 = `AI Topics · Week ${weekNumber}\n\n${fallbackContext[angle]}\n\nWeek ${trackingWeeks} of tracking · ${leaders.length} topics\n#Agent306 #AIResearch`;
    }

    // Generate leaderboard image card
    let xMediaId: string | undefined;
    try {
      const cardBuf = await generateLeaderboardCard(leaders, prevLeaders, weekNumber % 52 + 1);
      if (cardBuf) {
        xMediaId = await xWrite.v1.uploadMedia(cardBuf, { mimeType: "image/png" as any });
        console.log(`[306:Leaderboard] Card uploaded`);
      }
    } catch (imgErr: any) {
      console.warn("[306:Leaderboard] Image upload failed:", imgErr.message);
    }

    // Post as thread
    let lastTweetId: string | undefined;
    for (const [key, text] of [["t1", tweets.t1], ["t2", tweets.t2], ["t3", tweets.t3]] as [string,string][]) {
      if (!text?.trim()) continue;
      try {
        const payload: any = { text: text.trim() };
        if (lastTweetId) payload.reply = { in_reply_to_tweet_id: lastTweetId };
        if (key === "t1" && xMediaId) payload.media = { media_ids: [xMediaId] };
        const tw = await xWrite.v2.tweet(payload);
        lastTweetId = tw.data?.id;
        if (key !== "t3") await new Promise(r => setTimeout(r, 2000));
      } catch (e: any) {
        console.warn(`[306:Leaderboard] ${key} failed:`, e.message);
      }
    }

    console.log(`[306:Leaderboard] Thread posted — ${lastTweetId}`);
    registerPost("leaderboard", lastTweetId ? `https://x.com/306Agent/status/${lastTweetId}` : null, "leaderboard");

    // Post to Farcaster (combined thread as single cast)
    try {
      const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
      if (isFarcasterEnabled()) {
        const combinedText = [tweets.t1, tweets.t2, tweets.t3].filter(Boolean).join("\n\n").slice(0, 2500);
        const cast = await postCast({ text: combinedText, channel: "nft" });
        if (cast) {
          registerPost("leaderboard", cast.url, "leaderboard", "farcaster");
          console.log(`[306:Leaderboard] Farcaster cast posted: ${cast.url}`);
        }
      }
    } catch (fcErr: any) {
      console.warn("[306:Leaderboard] Farcaster post failed:", fcErr.message);
    }

    // Save state
    saveState({
      lastPostedAt: new Date().toISOString(),
      lastLeaderboard: leaders,
    });

  } catch (err: any) {
    console.error("[306:Leaderboard] Error:", err.message);
  }
}

// ── Schedule — Monday 9am ET (13:00 UTC) ─────────────────────────────────────
export function scheduleWeeklyLeaderboard(xWrite: any, grokKey?: string) {
  function getNextMonday9amET(): number {
    const now = new Date();
    const target = new Date(now);
    target.setUTCHours(13, 0, 0, 0); // 9am ET = 13:00 UTC

    // Find next Monday — ALWAYS at least 1 day away to prevent same-day fires
    const day = target.getUTCDay(); // 0=Sun, 1=Mon
    let daysUntil: number;
    if (day === 1) {
      // Today is Monday — always schedule for NEXT Monday (7 days)
      daysUntil = 7;
    } else {
      daysUntil = (8 - day) % 7 || 7;
    }
    target.setDate(target.getDate() + daysUntil);
    return target.getTime() - now.getTime();
  }

  const msUntil = getNextMonday9amET();
  console.log(`[306:Leaderboard] Next weekly post in ${Math.round(msUntil / 3600000)}h (Monday 9am ET)`);

  setTimeout(() => {
    postWeeklyLeaderboard(xWrite, grokKey);
    setInterval(() => postWeeklyLeaderboard(xWrite, grokKey), 7 * 24 * 60 * 60 * 1000);
  }, msUntil);
}
