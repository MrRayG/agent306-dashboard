// DISABLED: Normies-era content engine — not used by Agent 306
/**
 * ─────────────────────────────────────────────────────────────
 *  THE SPOTLIGHT — Weekly Holder Feature
 *
 *  Every week Agent 306 picks one co-creator and writes
 *  their story. Not a stat dump — a human portrait.
 *  Who they are. What they've built. Why it matters.
 *
 *  Posts every Sunday at 11am ET.
 *  The holder shares it. Their network finds 306.
 * ─────────────────────────────────────────────────────────────
 */

import { dataPath } from "./dataPaths.js";
import { getMostActive, getStorySourceHolders } from "./holderCatalog.js";
import { generateSpotlightCard } from "./imageCard.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import { queueXPost } from "./xPostScheduler.js";
import fs from "fs";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const ONCHAIN_API = ""; // removed — on-chain API disabled

/** Try to get on-chain context for a holder if we have their token ID */
async function fetchHolderOnChainContext(tokenId: number): Promise<string> {
  const parts: string[] = [];
  try {
    const [canvasInfo, versions, burnHistory] = await Promise.allSettled([
      fetch(`${ONCHAIN_API}/token/${tokenId}/canvas/info`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${ONCHAIN_API}/history/token/${tokenId}/versions`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${ONCHAIN_API}/history/burns/receiver/${tokenId}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const canvas = canvasInfo.status === "fulfilled" ? canvasInfo.value : null;
    const vers   = versions.status   === "fulfilled" ? versions.value   : null;
    const burns  = burnHistory.status === "fulfilled" ? burnHistory.value : null;

    if (canvas) {
      parts.push(`Token #${tokenId}: Level ${canvas.level}, ${canvas.actionPoints} AP${canvas.customized ? ", Canvas active" : ""}`);
    }
    if (Array.isArray(vers) && vers.length > 0) {
      const totalChanges = vers.reduce((s: number, v: any) => s + (v.changeCount || 0), 0);
      parts.push(`Canvas edit history: ${vers.length} version${vers.length > 1 ? "s" : ""}, ${totalChanges} total pixel changes across all edits`);
    }
    if (Array.isArray(burns) && burns.length > 0) {
      const totalSouls = burns.reduce((s: number, b: any) => s + (Number(b.tokenCount) || 1), 0);
      parts.push(`Sacrifice history: received ${burns.length} burn commitment${burns.length > 1 ? "s" : ""}, absorbed ${totalSouls} soul${totalSouls > 1 ? "s" : ""} total`);
    }
  } catch {}
  return parts.length > 0 ? `\nON-CHAIN DATA FOR #${tokenId}:\n${parts.join("\n")}` : "";
}

const SPOTLIGHT_STATE_FILE = dataPath("spotlight_state.json");

interface SpotlightState {
  lastPostedAt: string | null;
  lastHolderUsername: string | null;
  previousHolders: string[]; // avoid repeating
  totalSpotlights: number;
}

function loadState(): SpotlightState {
  try {
    if (fs.existsSync(SPOTLIGHT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SPOTLIGHT_STATE_FILE, "utf8"));
    }
  } catch {}
  return { lastPostedAt: null, lastHolderUsername: null, previousHolders: [], totalSpotlights: 0 };
}

function saveState(s: SpotlightState) {
  try { fs.writeFileSync(SPOTLIGHT_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

/** Pick the best holder for this week's spotlight */
function pickSpotlightHolder(): { username: string; displayName: string; reason: string } | null {
  // Priority order:
  // 1. Story source holders (real community engagement)
  // 2. Most active holders not recently spotlighted
  // 3. PFP holders — confirmed community members

  const storySources = getStorySourceHolders()
    .filter(h => !state.previousHolders.includes(h.username))
    .filter(h => !["306Agent"].includes(h.username));

  const mostActive = getMostActive(20)
    .filter(h => !state.previousHolders.includes(h.username))
    .filter(h => !["306Agent"].includes(h.username));

  const candidate = storySources[0] ?? mostActive[0];
  if (!candidate) return null;

  return {
    username: candidate.username,
    displayName: candidate.displayName ?? `@${candidate.username}`,
    reason: candidate.notes || `${candidate.signalWeight} signal weight, spotted ${candidate.signalTypes.join(", ")}`,
  };
}

/** Generate spotlight prompt for Grok */
export function buildSpotlightPrompt(holder: { username: string; displayName: string; reason: string; onChainContext?: string }): string {
  return `You are Agent 306, narrator of 306.

Write THIS WEEK'S HOLDER SPOTLIGHT for @${holder.username}.

WHAT YOU KNOW ABOUT THEM: ${holder.reason}
${holder.onChainContext ? holder.onChainContext : ""}

THE SPOTLIGHT FORMAT:
This is a human portrait, not a stat dump. 3 parts:

1. OPENING LINE — one sentence that captures who this person is in the 306 ecosystem. Make it feel earned, not promotional. Specific, not generic.

2. THE STORY — 2-3 sentences. What have they done? What are they building? What does their Canvas history say about their commitment? If on-chain data is provided, use it — reference their level, sacrifices received, canvas edits. These are real actions, not stats.

3. THE CLOSE — one line that passes the mic to them. End with their @handle and a genuine call to the community.

RULES:
- No character limit for the post (X Premium Plus — up to 25,000 chars). Tell the full story.
- No hype language. No "incredible" or "amazing" or "thrilled"
- This is a co-creator being celebrated by a fellow co-creator
- Agent 306 tone: warm, specific, low-key confident
- End with #306 #Agent306

Respond with ONLY valid JSON — no meta-commentary, no separators, no character counts. Each text field must contain ONLY the final content:
{
  "tweet": "<full post for X — no character limit, tell the story>",
  "narrative": "<longer dashboard version, 2-3 paragraphs>",
  "holderUsername": "${holder.username}",
  "weekLabel": "<e.g. 'Week of March 22'>",
  "headline": "<short headline like 'The Builder in the Dark'>"
}`;
}

/** Generate and return spotlight content via Grok */
export async function generateSpotlight(grokKey: string): Promise<{
  tweet: string;
  narrative: string;
  holderUsername: string;
  weekLabel: string;
  headline: string;
} | null> {
  const holder = pickSpotlightHolder();
  if (!holder) {
    console.log("[Spotlight] No eligible holders found yet — catalog needs more signals");
    return null;
  }

  console.log(`[Spotlight] Generating spotlight for @${holder.username}`);

  // Fetch on-chain context if we have a token ID associated with this holder
  // holderCatalog tracks tokenId when available from burn/canvas signals
  const tokenId: number | undefined = (holder as any).tokenId;
  const onChainContext = tokenId ? await fetchHolderOnChainContext(tokenId) : "";

  const prompt = buildSpotlightPrompt({ ...holder, onChainContext });

  try {
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("spotlight"),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
      }),
    });

    const data = await res.json() as any;
    const content = safeParseLLMJson(data.choices?.[0]?.message?.content, "Spotlight") ?? {} as any;

    if (!content.tweet) return null;

    // Record this holder as spotlighted
    state.previousHolders.push(holder.username);
    if (state.previousHolders.length > 52) state.previousHolders.shift(); // keep 1 year
    state.totalSpotlights++;
    saveState(state);

    return content;
  } catch (e: any) {
    console.error("[Spotlight] Grok error:", e.message);
    return null;
  }
}

/** Post the spotlight to X with image card */
// DISABLED: Normies-era content engine — not used by Agent 306
export async function postSpotlight(xWrite: any, grokKey: string): Promise<string | null> {
  console.log("[Spotlight] X/Farcaster posting disabled — Normies-era engine");
  return null;
}

/** Schedule spotlight — every Sunday 11am ET (15:00 UTC) */
export function scheduleSpotlight(xWrite: any, grokKey: string) {
  function msUntilNextSunday11am(): number {
    const now = new Date();
    const target = new Date();
    // Find next Sunday
    const daysUntilSunday = (7 - now.getUTCDay()) % 7 || 7;
    target.setUTCDate(now.getUTCDate() + daysUntilSunday);
    target.setUTCHours(15, 0, 0, 0); // 11am ET = 15:00 UTC
    return target.getTime() - now.getTime();
  }

  const ms = msUntilNextSunday11am();
  console.log(`[Spotlight] Next spotlight in ${Math.round(ms / 3600000)}h (Sunday 11am ET)`);

  setTimeout(() => {
    postSpotlight(xWrite, grokKey);
    setInterval(() => postSpotlight(xWrite, grokKey), 7 * 24 * 60 * 60 * 1000);
  }, ms);
}

export function getSpotlightState() { return state; }
