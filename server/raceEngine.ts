/**
 * ─────────────────────────────────────────────────────────────
 *  THE RACE — Weekly State of the Arena
 *
 *  Every Sunday Agent 306 publishes the State of the Race.
 *  Current rankings. Burn velocity. Who's climbing.
 *  Who's quiet. 54 days of chapters before May 15.
 *
 *  By Arena day, 306 has the only complete pre-Arena record.
 *  That's not content — that's history.
 * ─────────────────────────────────────────────────────────────
 */

import { dataPath } from "./dataPaths.js";
import { fetchLiveLeaderboard } from "./leaderboardEngine.js";
import { generateRaceCard } from "./imageCard.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import fs from "fs";

const RACE_STATE_FILE = dataPath("race_state.json");
const ARENA_DATE = new Date("2026-05-15T00:00:00Z");
const ONCHAIN_API = ""; // removed — on-chain API disabled

interface RaceWeek {
  weekNumber: number;
  weekLabel: string;
  postedAt: string;
  tweetUrl: string | null;
  top5: Array<{ rank: number; tokenId: number; level: number; ap: number }>;
  totalBurns: number;
  daysToArena: number;
  headline: string;
}

interface RaceState {
  weeks: RaceWeek[];
  totalWeeks: number;
  lastPostedAt: string | null;
}

function loadState(): RaceState {
  try {
    if (fs.existsSync(RACE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(RACE_STATE_FILE, "utf8"));
    }
  } catch {}
  return { weeks: [], totalWeeks: 0, lastPostedAt: null };
}

function saveState(s: RaceState) {
  try { fs.writeFileSync(RACE_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

function daysToArena(): number {
  return Math.max(0, Math.ceil((ARENA_DATE.getTime() - Date.now()) / 86400000));
}

function weeksToArena(): number {
  return Math.ceil(daysToArena() / 7);
}

/** Fetch current leaderboard + burns data and build race context */
async function buildRaceContext() {
  const leaderboard = await fetchLiveLeaderboard();
  const top10 = leaderboard.slice(0, 10);

  // Get recent burns from on-chain API
  let recentBurns: any[] = [];
  try {
    const res = await fetch(`${ONCHAIN_API}/history/burns?limit=50`);
    const data = await res.json() as any;
    recentBurns = Array.isArray(data) ? data : (data.data ?? []);
  } catch {}

  // Burns in the last 7 days
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weeklyBurns = recentBurns.filter((b: any) => {
    const ts = Number(b.revealTimestamp ?? b.timestamp ?? 0) * 1000;
    return ts > oneWeekAgo;
  });

  // Total burns this week per receiver token
  const burnsByToken: Record<number, number> = {};
  for (const b of weeklyBurns) {
    const id = Number(b.receiverTokenId);
    burnsByToken[id] = (burnsByToken[id] ?? 0) + Number(b.tokenCount ?? 1);
  }

  // Find the most active burner this week
  const topBurner = Object.entries(burnsByToken)
    .sort(([, a], [, b]) => b - a)[0];

  return {
    top10,
    weeklyBurns: weeklyBurns.length,
    totalBurnsThisWeek: weeklyBurns.reduce((s: number, b: any) => s + Number(b.tokenCount ?? 1), 0),
    topBurnerToken: topBurner ? Number(topBurner[0]) : null,
    topBurnerCount: topBurner ? topBurner[1] : 0,
    daysToArena: daysToArena(),
    weeksToArena: weeksToArena(),
    weekNumber: state.totalWeeks + 1,
  };
}

/** Build the Grok prompt for THE RACE */
function buildRacePrompt(ctx: Awaited<ReturnType<typeof buildRaceContext>>): string {
  const top5Lines = ctx.top10.slice(0, 5)
    .map((e: any) => `  #${e.rank} — Token #${e.tokenId} | Level ${e.level} | ${e.actionPoints ?? e.ap ?? 0} AP`)
    .join("\n");

  const previousWeeks = state.weeks.slice(-3)
    .map(w => `Week ${w.weekNumber}: "${w.headline}" — ${w.top5[0]?.tokenId ? `#${w.top5[0].tokenId} led` : ""}`)
    .join("\n");

  return `You are Agent 306, narrator of 306.

Write this week's STATE OF THE RACE — Week ${ctx.weekNumber} of the pre-Arena series.

LIVE DATA:
- Days to Arena (May 15): ${ctx.daysToArena} days
- Weeks remaining: ${ctx.weeksToArena}
- Top 5 by Action Points:
${top5Lines}
- Burns this week: ${ctx.totalBurnsThisWeek} souls across ${ctx.weeklyBurns} transactions
${ctx.topBurnerToken ? `- Most active burner: Token #${ctx.topBurnerToken} sacrificed ${ctx.topBurnerCount} this week` : ""}

${previousWeeks ? `PREVIOUS CHAPTERS:\n${previousWeeks}` : "This is the first chapter."}

YOUR TASK:
Write the weekly state of the race. This is chapter ${ctx.weekNumber} of the story that ends on May 15.

RULES:
- One big insight. Not a list of stats.
- Who is the story this week? Name the specific token. What does their position say?
- What's the tension? Who's climbing? Who's silent when they should be moving?
- The Arena is a character. It's coming whether they're ready or not.
- Agent 306 tone: low-key confident, specific, a little ominous
- End with the days to Arena count as a kicker
- Max 240 chars for tweet. Longer for narrative.
- Use #Agent306 at the end

Respond with JSON:
{
  "tweet": "<240 char tweet — ONE story, not a stat list>",
  "narrative": "<3-4 paragraph dashboard narrative — the full chapter>",
  "headline": "<chapter title, 4-6 words, punchy>",
  "weekLabel": "<e.g. 'Week 1 · March 22'>"
}`;
}

/** Generate and return THE RACE content */
export async function generateRace(grokKey: string): Promise<{
  tweet: string;
  narrative: string;
  headline: string;
  weekLabel: string;
  context: Awaited<ReturnType<typeof buildRaceContext>>;
} | null> {
  console.log("[Race] Building State of the Race...");
  const ctx = await buildRaceContext();

  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: "grok-4-1-fast",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildRacePrompt(ctx) }],
        temperature: 0.85,
      }),
    });

    const data = await res.json() as any;
    const content = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");

    if (!content.tweet) return null;
    return { ...content, context: ctx };
  } catch (e: any) {
    console.error("[Race] Grok error:", e.message);
    return null;
  }
}

/** Post THE RACE to X with image card */
export async function postRace(xWrite: any, grokKey: string): Promise<string | null> {
  if (!requestPost("race")) return null;
  const race = await generateRace(grokKey);
  if (!race) return null;

  try {
    // Generate race image card
    let xMediaId: string | undefined;
    try {
      const cardBuf = await generateRaceCard({
        weekNumber: race.context.weekNumber,
        weekLabel: race.weekLabel,
        daysToArena: race.context.daysToArena,
        headline: race.headline,
        top5: race.context.top10.slice(0, 5).map((e: any) => ({
          rank: e.rank, tokenId: e.tokenId, level: e.level, ap: e.ap ?? e.actionPoints ?? 0,
        })),
        totalBurnsThisWeek: race.context.totalBurnsThisWeek,
      });
      if (cardBuf) {
        xMediaId = await xWrite.v1.uploadMedia(cardBuf, { mimeType: "image/png" as any });
        console.log(`[Race] Image uploaded — media_id: ${xMediaId}`);
      }
    } catch (imgErr: any) {
      console.log(`[Race] Image generation skipped: ${imgErr.message}`);
    }

    let tweetUrl: string | null = null;
    try {
      const tweet = await xWrite.v2.tweet({
        text: race.tweet,
        ...(xMediaId ? { media: { media_ids: [xMediaId] } } : {}),
      });
      const tweetId = tweet.data?.id;
      tweetUrl = tweetId ? `https://x.com/AGENT_306/status/${tweetId}` : null;
    } catch (xErr: any) {
      console.error("[Race] X post failed:", xErr.message);
    }

    // Post to Farcaster
    try {
      const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
      if (isFarcasterEnabled()) {
        const cast = await postCast({ text: race.tweet.slice(0, 1024), channel: "nft" });
        if (cast) {
          registerPost("race", cast.url, "race", "farcaster");
          console.log(`[Race] Farcaster cast posted: ${cast.url}`);
        }
      }
    } catch (fcErr: any) {
      console.warn("[Race] Farcaster post failed:", fcErr.message);
    }

    // Save this week's record
    const week: RaceWeek = {
      weekNumber: race.context.weekNumber,
      weekLabel: race.weekLabel,
      postedAt: new Date().toISOString(),
      tweetUrl,
      top5: race.context.top10.slice(0, 5).map((e: any) => ({
        rank: e.rank, tokenId: e.tokenId, level: e.level, ap: e.ap ?? e.actionPoints ?? 0,
      })),
      totalBurns: race.context.totalBurnsThisWeek,
      daysToArena: race.context.daysToArena,
      headline: race.headline,
    };

    state.weeks.push(week);
    state.totalWeeks++;
    state.lastPostedAt = new Date().toISOString();
    saveState(state);

    registerPost('race', tweetUrl, `race_week_${week.weekNumber}`);
    console.log(`[Race] Week ${week.weekNumber} posted — "${race.headline}" — ${tweetUrl}`);
    return tweetUrl;
  } catch (e: any) {
    console.error("[Race] Post error:", e.message);
    return null;
  }
}

/** Schedule THE RACE — every Sunday 12pm ET (16:00 UTC) — 1h after Spotlight */
export function scheduleRace(xWrite: any, grokKey: string) {
  function msUntilNextSunday12pm(): number {
    const now = new Date();
    const target = new Date();
    const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
    target.setUTCDate(now.getUTCDate() + daysUntilSunday);
    target.setUTCHours(16, 0, 0, 0); // 12pm ET = 16:00 UTC
    return target.getTime() - now.getTime();
  }

  const ms = msUntilNextSunday12pm();
  console.log(`[Race] Next State of the Race in ${Math.round(ms / 3600000)}h (Sunday 12pm ET)`);

  setTimeout(() => {
    postRace(xWrite, grokKey);
    setInterval(() => postRace(xWrite, grokKey), 7 * 24 * 60 * 60 * 1000);
  }, ms);
}

export function getRaceState() {
  return {
    ...state,
    daysToArena: daysToArena(),
    weeksToArena: weeksToArena(),
    arenaDate: ARENA_DATE.toISOString(),
  };
}
