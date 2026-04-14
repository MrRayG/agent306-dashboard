// DISABLED: Normies-era content engine — not used by Agent 306
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
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
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
- No character limit for tweet (X Premium Plus — up to 25,000 chars). Tell the full story.
- Use #Agent306 at the end

Respond with JSON:
{
  "tweet": "<X post — no char limit. ONE story, not a stat list. Tell it fully.>",
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
        model: "grok-4-1-fast-non-reasoning",
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
// DISABLED: Normies-era content engine — not used by Agent 306
export async function postRace(xWrite: any, grokKey: string): Promise<string | null> {
  console.log("[Race] X/Farcaster posting disabled — Normies-era engine");
  return null;
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
