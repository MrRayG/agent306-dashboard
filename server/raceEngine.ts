/**
 * ─────────────────────────────────────────────────────────────
 *  THE RACE — Weekly AI Roundup
 *
 *  Every Sunday Agent 306 publishes the Weekly AI Roundup.
 *  Key developments. Research breakthroughs. Who's shipping.
 *  Who's pivoting. Tracking the AI landscape week by week.
 *
 *  Over time, 306 builds the most complete weekly AI record.
 *  That's not content — that's history.
 * ─────────────────────────────────────────────────────────────
 */

import { dataPath } from "./dataPaths.js";
import { fetchLiveLeaderboard } from "./leaderboardEngine.js";
import { generateRaceCard } from "./imageCard.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import fs from "fs";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";

const RACE_STATE_FILE = dataPath("race_state.json");
const TRACKING_START_DATE = new Date("2026-03-08T00:00:00Z");
const ONCHAIN_API = ""; // removed — on-chain API disabled

interface RaceWeek {
  weekNumber: number;
  weekLabel: string;
  postedAt: string;
  tweetUrl: string | null;
  top5: Array<{ rank: number; topic: string; momentum: number; mentions: number }>;
  totalDevelopments: number;
  weeksTracked: number;
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

function weeksTracked(): number {
  return Math.max(1, Math.ceil((Date.now() - TRACKING_START_DATE.getTime()) / (7 * 86400000)));
}

function currentWeekNumber(): number {
  return weeksTracked();
}

/** Fetch current AI landscape data and build roundup context */
async function buildRaceContext() {
  const leaderboard = await fetchLiveLeaderboard();
  const top10 = leaderboard.slice(0, 10);

  // Collect AI development metrics for the week
  let recentDevelopments: any[] = [];
  // Placeholder for AI signal collection — populated by signalCollector
  const weeklyDevelopments = recentDevelopments.length;

  return {
    top10,
    weeklyDevelopments,
    totalDevelopmentsThisWeek: weeklyDevelopments,
    topResearchArea: null as string | null,
    topResearchMentions: 0,
    weeksTracked: weeksTracked(),
    currentWeek: currentWeekNumber(),
    weekNumber: state.totalWeeks + 1,
  };
}

/** Build the Grok prompt for the WEEKLY AI ROUNDUP */
function buildRacePrompt(ctx: Awaited<ReturnType<typeof buildRaceContext>>): string {
  const top5Lines = ctx.top10.slice(0, 5)
    .map((e: any) => `  #${e.rank} — ${e.topic ?? `Research area #${e.rank}`} | Momentum: ${e.momentum ?? 0} | Mentions: ${e.mentions ?? e.actionPoints ?? 0}`)
    .join("\n");

  const previousWeeks = state.weeks.slice(-3)
    .map(w => `Week ${w.weekNumber}: "${w.headline}"`)
    .join("\n");

  return `You are Agent 306, AI thought leader and narrator.

Write this week's WEEKLY AI ROUNDUP — Week ${ctx.weekNumber} of tracking the AI landscape.

LIVE DATA:
- Weeks tracked so far: ${ctx.weeksTracked}
- Top 5 AI topics by momentum:
${top5Lines}
- Key developments this week: ${ctx.totalDevelopmentsThisWeek} notable signals
${ctx.topResearchArea ? `- Hottest research area: ${ctx.topResearchArea} with ${ctx.topResearchMentions} mentions this week` : ""}

${previousWeeks ? `PREVIOUS CHAPTERS:\n${previousWeeks}` : "This is the first chapter."}

YOUR TASK:
Write the weekly AI roundup. This is chapter ${ctx.weekNumber} of the ongoing record of AI development.

RULES:
- One big insight. Not a list of stats.
- What is the story this week? Name the specific development or research breakthrough.
- What's the tension? Which companies are shipping? What paradigm is shifting?
- The AI landscape is always moving — capture what matters this week.
- Agent 306 tone: low-key confident, specific, forward-looking
- End with a thought-provoking observation about where the field is heading
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

/** Generate and return the WEEKLY AI ROUNDUP content */
export async function generateRace(grokKey: string): Promise<{
  tweet: string;
  narrative: string;
  headline: string;
  weekLabel: string;
  context: Awaited<ReturnType<typeof buildRaceContext>>;
} | null> {
  console.log("[Race] Building Weekly AI Roundup...");
  const ctx = await buildRaceContext();

  try {
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: "grok-4-1-fast",
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

/** Post the WEEKLY AI ROUNDUP to X with image card */
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
        daysToArena: 0, // field tracking metric
        headline: race.headline,
        top5: race.context.top10.slice(0, 5).map((e: any) => ({
          rank: e.rank, tokenId: e.tokenId ?? 0, level: e.level ?? 0, ap: e.ap ?? e.actionPoints ?? 0,
        })),
        totalBurnsThisWeek: race.context.totalDevelopmentsThisWeek,
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
      tweetUrl = tweetId ? `https://x.com/306Agent/status/${tweetId}` : null;
    } catch (xErr: any) {
      console.error("[Race] X post failed:", xErr.message);
    }

    // Post to Farcaster
    try {
      const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
      if (isFarcasterEnabled()) {
        const cast = await postCast({ text: race.tweet.slice(0, 2500), channel: "nft" });
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
        rank: e.rank, topic: e.topic ?? "", momentum: e.momentum ?? 0, mentions: e.mentions ?? e.actionPoints ?? 0,
      })),
      totalDevelopments: race.context.totalDevelopmentsThisWeek,
      weeksTracked: race.context.weeksTracked,
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

/** Schedule the WEEKLY AI ROUNDUP — every Sunday 12pm ET (16:00 UTC) — 1h after Spotlight */
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
  console.log(`[Race] Next Weekly AI Roundup in ${Math.round(ms / 3600000)}h (Sunday 12pm ET)`);

  setTimeout(() => {
    postRace(xWrite, grokKey);
    setInterval(() => postRace(xWrite, grokKey), 7 * 24 * 60 * 60 * 1000);
  }, ms);
}

export function getRaceState() {
  return {
    ...state,
    weeksTracked: weeksTracked(),
    currentWeek: currentWeekNumber(),
    trackingStartDate: TRACKING_START_DATE.toISOString(),
  };
}
