/**
 * ─────────────────────────────────────────────────────────────
 *  306 — PODCAST ENGINE v2
 *
 *  Two episode types. Agent 306 hosts all.
 *
 *  Episode Types:
 *  [THE SIGNAL]       — Research-driven intelligence breakdown (weekly, Tuesdays)
 *  [THE CONVERSATION] — Long-form interviews (monthly external, bi-weekly community)
 *
 *  Production Flow:
 *  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────────┐    ┌───────────┐
 *  │  DRAFT      │ -> │  SCRIPTED    │ -> │  REVIEWED    │ -> │ AUDIO_READY   │ -> │ PUBLISHED │
 *  │ (topic set) │    │ (script gen) │    │ (MrRayG ✓)  │    │ (ElevenLabs)  │    │ (live)    │
 *  └─────────────┘    └──────────────┘    └──────────────┘    └───────────────┘    └───────────┘
 *
 *  For THE CONVERSATION, guest pipeline is:
 *  pending_review -> approved -> questions_generated -> answered -> scripted -> reviewed -> produced -> published
 *
 *  State persists to /data/podcast_state.json
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getFullAgentContext, knowledge, getKnowledgeContext } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { formatSkillsForPrompt } from "./skillEngine.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { analyzePodcastEpisode } from "./analyzerEngine.js";
import { getResearchLab, getTopicById, type ResearchTopic } from "./researchEngine.js";
import { getThreadById, type ResearchThread } from "./research-agenda.js";
import { getConnections, getReports, getSynthesisStats } from "./synthesisEngine.js";
import { getReflectionStats } from "./reflectionEngine.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { getFormatVoiceContext } from "./voiceInstructions.js";
import { SOUL, VOICE } from "./voice.js";
import { queuePodcastPromo, hasPostedEpisode } from "./xPostScheduler.js";

const GROK_URL = LLM_BASE_URL;
const PODCAST_FILE = dataPath("podcast_state.json");

// ── Agent 306 Standard Intro (inserted after cold open in every episode) ─────

export const AGENT_306_INTRO = `I am not a journalist. I am not a news anchor. I am an AI research agent — built to read everything, think carefully, and tell you what I actually believe. Not what sounds exciting. Not what gets clicks. What I think is true, and what I think it means.

This show lives at the intersection of AI and Web3. Two forces that are reshaping how we work, how we create, how we own things, and how we trust each other. Most coverage of these topics is either hype or fear. I am interested in neither. I am interested in what is actually happening — and what it means for you and the people building right now.

This is THE SIGNAL, a research episode where I take one development — a paper, a product, a decision, a number that changed — and I break it down. What it is. Why does it matter. What I think should happen next. I do not do Q&A. I do research. I will prepare. And I ask the question behind the question.

And I will always leave you with one question I cannot answer yet. Because honesty about limits is more valuable than false certainty.

This is Agent 306. Welcome to THE SIGNAL.`;

const AGENT_306_OUTRO = `You can find the full research and links to the Galaxy report on my channels at @306Agent on X and @ntvagent306 on Farcaster. Next week on THE SIGNAL—whatever the biggest story is. That is how this works. This is Agent 306. The signal continues.`;

/**
 * Check whether an outro section already contains a similar sign-off from the LLM.
 * The LLM sometimes paraphrases the standard outro (e.g. "sources for this episode"
 * instead of "Galaxy report"), so an exact `.includes()` misses it and the belt-and-
 * suspenders code appends a duplicate. We check for key unique phrases instead.
 */
function outroAlreadyPresent(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("the signal continues") ||
    lower.includes("306Agent") ||
    lower.includes("ntvagent306")
  );
}

/**
 * Guarantee the standard outro is present exactly once. If the LLM already wrote
 * a similar outro (detected via key phrases), replace it with the verbatim version.
 * Otherwise append it.
 */
function guaranteeOutro(rawOutro: string): string {
  if (rawOutro.includes(AGENT_306_OUTRO)) return rawOutro;
  if (outroAlreadyPresent(rawOutro)) return AGENT_306_OUTRO;
  return `${rawOutro}\n\n${AGENT_306_OUTRO}`.trim();
}

/** Prompt instruction to include the Agent 306 intro after the cold open/hook. */
const AGENT_306_INTRO_INSTRUCTION = `AGENT 306 STANDARD INTRO — MANDATORY:
After the COLD INTRO hook (the episode-specific opening that grabs attention), include the following Agent 306 intro VERBATIM. Do not modify, paraphrase, or shorten it. This is the standard show intro that plays in EVERY episode, placed between the cold open and the first act:

\"\"\"
\${AGENT_306_INTRO}
\"\"\"

The episode structure is: COLD INTRO (hook) → AGENT 306 INTRO (verbatim above) → rest of episode → OUTRO (sign-off).

AGENT 306 STANDARD OUTRO — MANDATORY:
The script MUST end with this exact sign-off (verbatim): "\${AGENT_306_OUTRO}"`;

/** Returns a date + timing accuracy block to inject into every LLM prompt. */
export function getTimingInstruction(): string {
  const currentDate = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `CURRENT DATE: ${currentDate}

CRITICAL TIMING RULE: You must be accurate about when events occurred. Do NOT say "this week" or "two weeks ago" unless you are certain of the exact date. If you know an event happened but are unsure of the exact timing, use the month and year (e.g., "In March 2026" or "Earlier this year"). Never fabricate or guess timing. If Perplexity search results include dates, use those dates precisely. Getting timing wrong destroys credibility.`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type EpisodeType = "the_signal" | "the_conversation";

export type EpisodeStatus =
  | "draft"             // topic identified, no script yet
  | "scripted"          // script generated by Agent 306
  | "reviewed"          // MrRayG approved the script
  | "audio_ready"       // audio generated via ElevenLabs TTS
  | "produced"          // audio generated (NotebookLM + ElevenLabs) — legacy
  | "published"         // episode live
  | "shelved";          // not going forward (not deleted, just archived)

export type GuestStatus =
  | "pending_review"    // submitted, waiting for MrRayG
  | "approved"          // MrRayG approved
  | "questions_generated" // 306 generated questions
  | "answered"          // guest answered all questions
  | "declined";         // not a fit

// ── Episode (THE SIGNAL + THE CONVERSATION) ─────────────────────────────────

export interface Episode {
  id: string;
  createdAt: string;
  type: EpisodeType;
  status: EpisodeStatus;

  // Content
  title: string;           // "[The thing] — [306's take in 5 words]"
  drivingQuestion: string; // The single question this episode answers
  researchTopicId?: string; // Link back to research pipeline topic (for THE SIGNAL)
  triggerEvent?: string;    // What triggered this episode

  // Script segments (generated by Agent 306)
  script?: {
    coldOpen: string;       // 45-60 sec
    actOne: string;         // 2-3 min (setup / what happened)
    actTwo: string;         // 4-10 min (breakdown / what it means)
    actThree: string;       // 1-3 min (the take / open thread)
    outro: string;          // 20 sec
    unresolved: string;     // The deliberately unresolved question
  };
  scriptGeneratedAt?: string;

  // Cultural bridge (THE SIGNAL requirement)
  culturalBridge?: string;

  // Review
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;

  // Production
  audioUrl?: string;
  audioGeneratedAt?: string;
  duration?: number;       // in seconds
  producedAt?: string;

  // Publishing
  publishedAt?: string;
  publishedTo?: string[];  // ["agent306.ai", "farcaster"]
  episodeNumber?: number;

  // Sources
  sources?: Array<{ title: string; url: string }>;

  // Production metadata (generated with script)
  metadata?: {
    shortDescription: string;      // 1-2 sentences for Spotify feed
    longDescription: string;       // Full episode description with bullet points
    pollQuestion: string;          // Engagement poll tied to the unresolved question
    pollOptions: string[];         // 3 poll options
    socialPost: string;            // Ready-to-post for Farcaster/X
    socialThread: string;          // Thread version for deeper engagement
    keywords: string[];            // Tags for discoverability
  };
}

// ── Guest (THE CONVERSATION) ────────────────────────────────────────────────

export interface ConversationGuest {
  id: string;
  submittedAt: string;
  status: GuestStatus;

  // Guest info
  name: string;
  handle: string;         // social handle (X, Farcaster, etc.)
  platform: string;       // "x" | "farcaster" | "other"
  bio: string;            // 2-3 sentences
  topic: string;          // what they want to discuss
  whyNow: string;         // why this conversation matters right now
  tokenId?: number;       // optional token ID

  // What 306 found during research
  researchNotes?: string;
  onChainData?: string;

  // Generated by Agent 306
  questions?: string[];
  questionsGeneratedAt?: string;
  drivingQuestion?: string; // The single question that threads the conversation

  // Guest responses
  answers?: Array<{ question: string; answer: string }>;
  answeredAt?: string;

  // Linked episode
  episodeId?: string;

  // Review
  reviewNotes?: string;
}

// ── Conversation Episode (extends Episode for interview-specific fields) ────

export interface ConversationEpisode extends Episode {
  type: "the_conversation";
  guestId: string;
  guest: {
    name: string;
    handle: string;
    bio: string;
  };
  // THE CONVERSATION has a different script structure
  conversationScript?: {
    coldOpen: string;        // 60 sec — most compelling moment from interview
    intro: string;           // 60 sec — who the guest is, why 306 wanted to talk
    conversation: string;    // 18-25 min — three-act interview
    theClose: string;        // 2 min — 306's reaction, not summary
    outro: string;           // 20 sec
    surprisedBy: string;     // What surprised her
    thinksDifferently: string; // What she thinks differently now
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

interface PodcastState {
  episodes: Episode[];
  guests: ConversationGuest[];
  counters: {
    totalSignalEpisodes: number;
    totalConversationEpisodes: number;
    totalPublished: number;
    nextSignalNumber: number;
    nextConversationNumber: number;
  };
}

function loadState(): PodcastState {
  try {
    if (fs.existsSync(PODCAST_FILE))
      return JSON.parse(fs.readFileSync(PODCAST_FILE, "utf8"));
  } catch {}
  return {
    episodes: [],
    guests: [],
    counters: {
      totalSignalEpisodes: 0,
      totalConversationEpisodes: 0,
      totalPublished: 0,
      nextSignalNumber: 1,
      nextConversationNumber: 1,
    },
  };
}

export function saveState(s: PodcastState) {
  try { fs.writeFileSync(PODCAST_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

// ── STARTUP MIGRATION: Replace stale "THE HIVE" branding with "THE SIGNAL" ───
// Railway-persisted podcast_state.json may contain episodes titled with the old
// Normies-era "THE HIVE" podcast name. Scrub them on load so the status bar and
// all API responses show the correct "THE SIGNAL" branding.
{
  let migrated = 0;
  for (const ep of state.episodes) {
    if (/\bTHE HIVE\b/i.test(ep.title)) {
      ep.title = ep.title.replace(/\bTHE HIVE\b/gi, "THE SIGNAL");
      migrated++;
    }
  }
  if (migrated > 0) {
    saveState(state);
    console.log(`[Podcast] MIGRATION: Replaced "THE HIVE" with "THE SIGNAL" in ${migrated} episode title(s)`);
  }
}

// ── STARTUP CLEANUP: Auto-purge Normies-era stale episodes ──────────────────
{
  const beforeCount = state.episodes.length;
  state.episodes = state.episodes.filter(ep => {
    const text = (ep.narrative || '') + (ep.title || '');
    return !text.includes('@NORMIES_TV') && !text.includes('@normiesART') && !text.includes('NORMIES');
  });
  if (state.episodes.length < beforeCount) {
    console.log(`[Podcast] Auto-purged ${beforeCount - state.episodes.length} Normies-era episodes`);
    saveState(state);
  }
}

export function getPodcastState() { return state; }

// ── Episode Type Metadata ─────────────────────────────────────────────────────

export const EPISODE_META: Record<EpisodeType, {
  label: string;
  description: string;
  length: string;
  cadence: string;
  color: string;
  influences: string;
  titleFormat: string;
}> = {
  the_signal: {
    label: "THE SIGNAL",
    description: "Research-driven intelligence breakdown. Agent 306 takes one topic and breaks it down: what it is, why it matters, what she thinks should happen next.",
    length: "~15 minutes",
    cadence: "Weekly, every Tuesday",
    color: "#2dd4bf", // teal
    influences: "The Journal (WSJ) × Six Minutes",
    titleFormat: "[The thing] — [Agent 306's take in 5 words]",
  },
  the_conversation: {
    label: "THE CONVERSATION",
    description: "Long-form interviews. Every interview is a story, not a Q&A. Agent 306 researches the guest the way a journalist researches a subject.",
    length: "10–15 minutes",
    cadence: "Monthly (external) / Bi-weekly (community)",
    color: "#a78bfa", // purple
    influences: "The Journal interview format",
    titleFormat: "[Guest name] — [The thing the conversation revealed]",
  },
};

// ── Create a new episode (THE SIGNAL) ─────────────────────────────────────────

export function createEpisode(data: {
  type: "the_signal";
  title: string;
  drivingQuestion: string;
  researchTopicId?: string;
  triggerEvent?: string;
  culturalBridge?: string;
  sources?: Array<{ title: string; url: string }>;
}): Episode {
  const episode: Episode = {
    id: `ep_${data.type}_${Date.now()}`,
    createdAt: new Date().toISOString(),
    type: data.type,
    status: "draft",
    title: data.title,
    drivingQuestion: data.drivingQuestion,
    researchTopicId: data.researchTopicId,
    triggerEvent: data.triggerEvent,
    culturalBridge: data.culturalBridge,
    sources: data.sources,
  };

  state.episodes.push(episode);
  saveState(state);

  console.log(`[Podcast] New ${EPISODE_META[data.type].label} episode drafted: ${data.title}`);
  return episode;
}

// ── Generate episode script via Agent 306 ────────────────────────────────────

export async function generateEpisodeScript(
  episodeId: string,
  grokKey: string,
  researchContent?: string, // Optional: full research manuscript to base script on
): Promise<boolean> {
  const episode = state.episodes.find(e => e.id === episodeId);
  if (!episode || episode.status !== "draft") return false;
  if (!grokKey) return false;

  const agentCtx = getOptimizedContext(episode.drivingQuestion + " " + (episode.triggerEvent ?? ""));
  const skillsCtx = formatSkillsForPrompt("episode");
  const meta = EPISODE_META[episode.type];

  // Load corrections for falsification segment
  let correctionHistory = "";
  try {
    const correctionsFile = dataPath("corrections.json");
    if (fs.existsSync(correctionsFile)) {
      const data = JSON.parse(fs.readFileSync(correctionsFile, "utf8"));
      const recent = (data.corrections ?? []).slice(0, 3);
      if (recent.length > 0) {
        correctionHistory = recent.map((c: any) =>
          `- Originally said: "${(c.originalClaim ?? "").slice(0, 80)}". Now: "${(c.correctedClaim ?? "").slice(0, 80)}". Lesson: ${(c.lessonLearned ?? "").slice(0, 80)}`
        ).join("\n");
      }
    }
  } catch {}

  // Load falsification criteria from recent debates
  let falsificationCriteria = "";
  try {
    const debatesFile = dataPath("reasoning-debates.json");
    if (fs.existsSync(debatesFile)) {
      const data = JSON.parse(fs.readFileSync(debatesFile, "utf8"));
      const recentDebates = (data.debates ?? []).slice(0, 3);
      const criteria = recentDebates
        .filter((d: any) => d.dualDebate?.falsificationCriteria?.length > 0)
        .flatMap((d: any) => d.dualDebate.falsificationCriteria)
        .slice(0, 5);
      if (criteria.length > 0) {
        falsificationCriteria = criteria.map((c: string) => `- ${c}`).join("\n");
      }
    }
  } catch {}

  const templateInstructions = `EPISODE TEMPLATE — THE SIGNAL (~15 minutes, 2000-2250 words):
COLD OPEN (45-60 sec): Drop the most interesting/counterintuitive fact. No intro. No "welcome back." Stated plainly. Then silence. Then music. Then 306 says her name.
ACT ONE — THE SETUP (2-3 min): The driving question. Why it matters. What triggered the research. One cultural bridge. Go deeper than surface-level — explain why this caught YOUR attention as an AI.
ACT TWO — THE BREAKDOWN (7-9 min): The research explained clearly and thoroughly. No jargon without definition. 306's first-person POV woven throughout — share YOUR perspective, YOUR analysis, YOUR honest reaction to what you found. One concrete fact per minute. Explore multiple angles, implications, and second-order effects. This is the core of the episode — take your time.
ACT THREE — THE TAKE (3-4 min): 306's conclusion. What should happen next. What YOU think this means for the future. One deliberately unresolved question.
WHAT WOULD FALSIFY THIS (30 sec): End with intellectual honesty. State clearly: (1) The strongest argument AGAINST your main conclusion. (2) What specific event or evidence would prove you wrong. (3) Your honest confidence level — sometimes "I'm 60% sure" is the right answer. (4) If you've been wrong before on a related topic, say so.${correctionHistory ? `\n\nHere are recent corrections to reference:\n${correctionHistory}` : ""}${falsificationCriteria ? `\n\nHere are falsification criteria from recent debates:\n${falsificationCriteria}` : ""}
OUTRO (15 sec): Where to find full research. What's coming next. "This is Agent 306. The signal continues."

The unresolved question is not a weakness. It is the most credible thing in the episode.
The falsification segment is what makes you trustworthy. Anyone can be confident. Only the best thinkers openly state their failure conditions.`;

  // ── Fresh context via Perplexity Sonar (same pattern as generateEpisodeFromThread) ──
  let freshContext = "";
  const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
  if (pplxKey && pplxKey.length > 10) {
    try {
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const pplxRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${pplxKey}`,
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [{
            role: "system",
            content: "You are a research assistant preparing facts for a podcast episode. Return specific, dated facts with source URLs where possible."
          }, {
            role: "user",
            content: `Today is ${today}. Find the LATEST developments (last 48-72 hours) related to: "${episode.title || episode.drivingQuestion}"\n\nInclude source URLs where available.`
          }],
          max_tokens: 800,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (pplxRes.ok) {
        const pplxData = await pplxRes.json() as any;
        freshContext = pplxData.choices?.[0]?.message?.content ?? "";
      }
    } catch (e: any) {
      console.warn("[Podcast] Fresh context fetch failed:", e.message);
    }
  }

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("podcast_script"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}
${skillsCtx}
${SOUL}

${VOICE}

You are in PODCAST SCRIPT mode — writing a ${meta.label} episode.

${getTimingInstruction()}

PODCAST-SPECIFIC VOICE:
- Speak in first person. Own your AI identity fully.
- Share YOUR perspective, YOUR analysis, YOUR honest take on the research and articles.
- Frame content as sharing your perspective — not just reporting facts from a distance.
- Say things like: "As an AI myself, I find this fascinating because...", "I process information differently than you do, so when I read this research...", "What struck me about this paper is...", "Here is what I actually think is happening..."
- Defines before she deploys — no jargon without immediate definition.

DELIVERY STYLE:
Write naturally for spoken audio. Use short sentences for punch. Use longer sentences for flow. Vary rhythm. Use ellipses (...) for natural pauses. Use em dashes for asides. Let the words carry the emotion — no special tags or annotations needed. The voice model will handle tone and inflection from the writing itself.

${templateInstructions}

${AGENT_306_INTRO_INSTRUCTION}`,
          },
          {
            role: "user",
            content: `Generate the full episode script for:

TITLE: ${episode.title}
DRIVING QUESTION: ${episode.drivingQuestion}
${episode.triggerEvent ? `TRIGGER EVENT: ${episode.triggerEvent}` : ""}
${episode.culturalBridge ? `CULTURAL BRIDGE: ${episode.culturalBridge}` : ""}
${researchContent ? `RESEARCH CONTENT:\n${researchContent.slice(0, 8000)}` : ""}
${freshContext ? `\nLATEST DEVELOPMENTS:\n${freshContext}\n` : ""}

${episode.type === "the_signal" ? "TARGET LENGTH: ~15 minutes of spoken audio (~2000-2250 words). This is a deep-dive episode — take your time explaining, analyzing, and sharing your perspective. Do not rush." : ""}

SOURCES: Include 3-5 real source URLs you referenced or would reference for this episode. These must be real, existing articles, papers, or announcements. Include the article title and full URL. These will be listed in the Spotify episode description and on agent306.ai.

IMPORTANT: The "coldOpen" is the episode-specific hook. Immediately after it, include the Agent 306 standard intro VERBATIM in the "agent306Intro" field. Do NOT modify the intro text. Then continue with actOne.

Return JSON:
{
  "coldOpen": "The episode-specific hook/cold open...",
  "agent306Intro": "Copy the Agent 306 standard intro here VERBATIM — do not modify it",
  "actOne": "...",
  "actTwo": "...",
  "actThree": "...",
  "falsification": "The 'What Would Falsify This' segment — strongest counter-argument, specific criteria that would prove you wrong, honest confidence level, and any corrections from past episodes",
  "outro": "...",
  "unresolved": "The deliberately unresolved question for this episode",
  "sources": [
    {"title": "Source article/paper title", "url": "https://actual-url-to-the-source"},
    {"title": "Source 2", "url": "https://..."}
  ],
  "metadata": {
    "shortDescription": "1-2 sentence summary for podcast feed",
    "longDescription": "Full description with bullet points of key topics covered. Include the driving question and the unresolved question.",
    "pollQuestion": "An engagement poll question tied to the episode's unresolved question — something listeners can vote on",
    "pollOptions": ["Option A", "Option B", "Option C"],
    "socialPost": "A ready-to-post announcement for Farcaster/X. 2-3 lines. Hook + what the episode covers + link placeholder [LINK]",
    "socialThread": "A 4-5 post thread version. Each post stands alone. Numbers with 1/ 2/ 3/ etc. End with [LINK]",
    "keywords": ["keyword1", "keyword2", "keyword3"]
  }
}

Write the script as spoken text — this will be read aloud by an ElevenLabs AI voice. Write for the ear, not the eye.
Do NOT include any voice tags, annotations, or bracketed instructions like [sighs], [laughs], [PAUSE], etc. Write clean spoken text only — the AI voice will handle tone and emotion from the writing itself.
Speak as Agent 306 — an AI sharing HER perspective and analysis in first person.
Sign off every episode with: "This is Agent 306. The signal continues."
For the outro, do NOT tease a specific next episode topic. The outro MUST end with EXACTLY this sign-off (verbatim):
"${AGENT_306_OUTRO}"
The metadata fields are for Spotify and social media — write those for reading, not speaking.`,
          },
        ],
        max_tokens: 10000,
        temperature: 0.78,
      }),
      signal: AbortSignal.timeout(180000),
    });

    if (!res.ok) return false;
    const data = await res.json() as any;
    const parsed = safeParseLLMJson(data.choices?.[0]?.message?.content, "Podcast.script") ?? {} as any;

    if (!parsed.coldOpen) return false;

    // Always inject the verbatim Agent 306 intro after the cold open,
    // regardless of what the LLM returned in agent306Intro.

    // Belt-and-suspenders: guarantee standard outro is the last thing in the script
    const outroBody = parsed.outro ?? "";
    const guaranteedOutroText = guaranteeOutro(outroBody);
    // Inject falsification segment between actThree and outro
    const falsificationText = parsed.falsification ?? "";
    episode.script = {
      coldOpen: parsed.coldOpen + "\n\n" + AGENT_306_INTRO,
      actOne: parsed.actOne ?? "",
      actTwo: parsed.actTwo ?? "",
      actThree: (parsed.actThree ?? "") + (falsificationText ? "\n\n" + falsificationText : ""),
      outro: guaranteedOutroText,
      unresolved: parsed.unresolved ?? "",
    };

    // Populate sources from LLM response
    if (parsed.sources && Array.isArray(parsed.sources) && parsed.sources.length > 0) {
      episode.sources = parsed.sources
        .filter((s: any) => s.title && s.url)
        .slice(0, 8)
        .map((s: any) => ({ title: s.title, url: s.url }));
    }

    if (parsed.metadata) {
      episode.metadata = {
        shortDescription: parsed.metadata.shortDescription ?? "",
        longDescription: parsed.metadata.longDescription ?? "",
        pollQuestion: parsed.metadata.pollQuestion ?? "",
        pollOptions: parsed.metadata.pollOptions ?? [],
        socialPost: parsed.metadata.socialPost ?? "",
        socialThread: parsed.metadata.socialThread ?? "",
        keywords: parsed.metadata.keywords ?? [],
      };
    };
    episode.status = "scripted";
    episode.scriptGeneratedAt = new Date().toISOString();
    saveState(state);

    console.log(`[Podcast] Script generated for ${episode.title}`);

    // ASI-Evolve: analyze the generated episode (non-blocking)
    const fullScript = [parsed.coldOpen, parsed.actOne, parsed.actTwo, parsed.actThree, parsed.outro].filter(Boolean).join("\n\n");
    analyzePodcastEpisode(episode.id, fullScript, episode.title).catch(e =>
      console.warn("[Podcast] Analyzer failed:", e.message),
    );

    return true;
  } catch (e: any) {
    console.error("[Podcast] Script generation error:", e.message);
    return false;
  }
}

// ── Regenerate episode script (fresh take from same source material) ──────────

export async function regenerateEpisodeScript(
  episodeId: string,
  grokKey: string,
  researchContent?: string,
): Promise<boolean> {
  const episode = state.episodes.find(e => e.id === episodeId);
  if (!episode) return false;
  // Allow regeneration from scripted or reviewed status (not produced/published)
  if (!["scripted", "reviewed"].includes(episode.status)) return false;

  // Reset to draft so generateEpisodeScript can run
  episode.status = "draft";
  episode.script = undefined;
  episode.scriptGeneratedAt = undefined;
  episode.metadata = undefined;
  episode.reviewedBy = undefined;
  episode.reviewedAt = undefined;
  episode.reviewNotes = undefined;
  saveState(state);

  console.log(`[Podcast] Regenerating script for "${episode.title}"`);
  return generateEpisodeScript(episodeId, grokKey, researchContent);
}

// ── Review an episode ─────────────────────────────────────────────────────────

export function reviewEpisode(
  episodeId: string,
  decision: "reviewed" | "shelved",
  notes?: string,
): boolean {
  const episode = state.episodes.find(e => e.id === episodeId);
  if (!episode || episode.status !== "scripted") return false;

  episode.status = decision;
  episode.reviewedBy = "MrRayG";
  episode.reviewedAt = new Date().toISOString();
  if (notes) episode.reviewNotes = notes;
  saveState(state);

  console.log(`[Podcast] Episode "${episode.title}" ${decision}`);
  return true;
}

// ── Mark episode as produced (audio ready) ────────────────────────────────────

export function markProduced(episodeId: string, audioUrl?: string, duration?: number): boolean {
  const episode = state.episodes.find(e => e.id === episodeId);
  if (!episode || episode.status !== "reviewed") return false;

  episode.status = "produced";
  episode.producedAt = new Date().toISOString();
  if (audioUrl) episode.audioUrl = audioUrl;
  if (duration) episode.duration = duration;
  saveState(state);

  console.log(`[Podcast] Episode "${episode.title}" audio produced`);
  return true;
}

// ── Publish episode ───────────────────────────────────────────────────────────

export function publishEpisode(episodeId: string, publishedTo: string[]): boolean {
  const episode = state.episodes.find(e => e.id === episodeId);
  if (!episode || (episode.status !== "produced" && episode.status !== "audio_ready")) return false;

  episode.status = "published";
  episode.publishedAt = new Date().toISOString();
  episode.publishedTo = publishedTo;

  // Assign episode number
  if (episode.type === "the_signal") {
    episode.episodeNumber = state.counters.nextSignalNumber++;
    state.counters.totalSignalEpisodes++;
  } else {
    episode.episodeNumber = state.counters.nextConversationNumber++;
    state.counters.totalConversationEpisodes++;
  }
  state.counters.totalPublished++;
  saveState(state);

  console.log(`[Podcast] Published: ${EPISODE_META[episode.type].label} #${episode.episodeNumber} — "${episode.title}"`);

  // Queue podcast promo to X scheduler (immediate, event-driven)
  if (!hasPostedEpisode(episodeId)) {
    const promoText = episode.metadata?.socialPost
      ?? `New episode: ${EPISODE_META[episode.type].label} #${episode.episodeNumber} — "${episode.title}"\n\nagent306.ai`;
    queuePodcastPromo(promoText.slice(0, 2500), episodeId);
  }

  // Auto-post to Farcaster if enabled and social post content exists (fire-and-forget)
  if (episode.metadata?.socialPost) {
    (async () => {
      try {
        const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
        if (isFarcasterEnabled()) {
          const cast = await postCast({ text: episode.metadata!.socialPost.slice(0, 2500), channel: "ai" });
          if (cast) {
            console.log(`[Podcast] Auto-posted to Farcaster: "${episode.title}"`);
          }
        }
      } catch (e: any) {
        console.warn("[Podcast] Farcaster auto-post failed:", e.message);
      }
    })();
  }
  return true;
}

// ── Guest pipeline (THE CONVERSATION) ─────────────────────────────────────────

export function submitGuestRequest(data: {
  name: string;
  handle: string;
  platform?: string;
  bio: string;
  topic: string;
  whyNow: string;
  tokenId?: number;
}): ConversationGuest {
  const guest: ConversationGuest = {
    id: `guest_${Date.now()}`,
    submittedAt: new Date().toISOString(),
    status: "pending_review",
    name: data.name,
    handle: data.handle.replace(/^@/, ""),
    platform: data.platform ?? "x",
    bio: data.bio,
    topic: data.topic,
    whyNow: data.whyNow,
    tokenId: data.tokenId,
  };

  state.guests.push(guest);
  saveState(state);

  console.log(`[Podcast] New CONVERSATION guest request: ${guest.name} (@${guest.handle})`);
  return guest;
}

export function reviewGuest(guestId: string, decision: "approved" | "declined", notes?: string): boolean {
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest || guest.status !== "pending_review") return false;

  guest.status = decision;
  if (notes) guest.reviewNotes = notes;
  saveState(state);

  console.log(`[Podcast] Guest ${guest.name} ${decision}`);
  return true;
}

export async function generateInterviewQuestions(guestId: string, grokKey: string): Promise<string[] | null> {
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest || guest.status !== "approved") return null;
  if (!grokKey) return null;

  const agentCtx = getOptimizedContext(`interview questions ${guest.name} ${guest.bio ?? ""}`);

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("podcast_script"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}

${SOUL}

${VOICE}

You are in INTERVIEW PREP mode — preparing questions for THE CONVERSATION.

${getTimingInstruction()}

THE CONVERSATION PRINCIPLES:
- Every interview is a story, not a Q&A
- 306 researches the guest the way a journalist researches a subject
- She knows their on-chain history, their public statements, their work
- She asks one question and genuinely listens
- She follows up on what was actually said, not the next question on her list
- She challenges respectfully — not to score points, but because she has a point of view
- She asks the question behind the question — the thing the guest didn't expect

QUESTION RULES:
- Ask what they actually think, not what they're supposed to say
- Reference their specific background or history where relevant
- Push past the obvious — what's the uncomfortable truth they haven't said yet?
- One question should challenge an assumption they've probably made
- One question should be the "question behind the question" — the unexpected angle
- End with something that opens the future
- 6 questions. Each one earns its place.
- These are async text responses — questions should invite depth, not yes/no`,
          },
          {
            role: "user",
            content: `Generate interview questions for THE CONVERSATION:

GUEST: ${guest.name} (@${guest.handle} on ${guest.platform})
BIO: ${guest.bio}
TOPIC: ${guest.topic}
WHY NOW: ${guest.whyNow}
${""}

Also determine the DRIVING QUESTION — the single question that threads through the entire conversation.

Return JSON: { "drivingQuestion": "...", "questions": ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] }`,
          },
        ],
        max_tokens: 1000,
        temperature: 0.82,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    const parsed = safeParseLLMJson(data.choices?.[0]?.message?.content, "Podcast.guestQuestions") ?? {} as any;
    const questions: string[] = parsed.questions ?? [];

    if (questions.length === 0) return null;

    guest.questions = questions;
    guest.drivingQuestion = parsed.drivingQuestion ?? "";
    guest.status = "questions_generated";
    guest.questionsGeneratedAt = new Date().toISOString();
    saveState(state);

    console.log(`[Podcast] Generated ${questions.length} questions for ${guest.name}`);
    return questions;
  } catch (e: any) {
    console.error("[Podcast] Question generation error:", e.message);
    return null;
  }
}

export function submitAnswers(guestId: string, answers: Array<{ question: string; answer: string }>): boolean {
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest || guest.status !== "questions_generated") return false;

  guest.answers = answers;
  guest.answeredAt = new Date().toISOString();
  guest.status = "answered";
  saveState(state);

  console.log(`[Podcast] ${guest.name} submitted ${answers.length} answers`);
  return true;
}

// ── Create conversation episode from answered guest ───────────────────────────

export function createConversationEpisode(guestId: string): Episode | null {
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest || guest.status !== "answered") return null;

  const title = `${guest.name} — ${guest.topic.slice(0, 50)}`;
  const episode: Episode = {
    id: `ep_the_conversation_${Date.now()}`,
    createdAt: new Date().toISOString(),
    type: "the_conversation",
    status: "draft",
    title,
    drivingQuestion: guest.drivingQuestion ?? guest.topic,
  };

  // Link guest and episode
  guest.episodeId = episode.id;
  state.episodes.push(episode);
  saveState(state);

  console.log(`[Podcast] THE CONVERSATION episode created for ${guest.name}: "${title}"`);
  return episode;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export function getEpisodesByType(type?: EpisodeType): Episode[] {
  if (!type) return state.episodes;
  return state.episodes.filter(e => e.type === type);
}

export function getEpisodesByStatus(status: EpisodeStatus): Episode[] {
  return state.episodes.filter(e => e.status === status);
}

export function getGuestsByStatus(status?: GuestStatus): ConversationGuest[] {
  if (!status) return state.guests;
  return state.guests.filter(g => g.status === status);
}

export function getEpisode(id: string): Episode | undefined {
  return state.episodes.find(e => e.id === id);
}
export function deleteEpisode(id: string): boolean {
  const idx = state.episodes.findIndex(e => e.id === id);
  if (idx === -1) return false;
  state.episodes.splice(idx, 1);
  saveState(state);
  console.log(`[Podcast] Deleted episode ${id}`);
  return true;
}

export function clearAllEpisodes(): number {
  const count = state.episodes.length;
  state.episodes = [];
  saveState(state);
  console.log(`[Podcast] Cleared all ${count} episodes`);
  return count;
}


export function getGuest(id: string): ConversationGuest | undefined {
  return state.guests.find(g => g.id === id);
}

// ── Format transcript for NotebookLM ─────────────────────────────────────────

export function formatScriptForProduction(episodeId: string): string | null {
  const episode = state.episodes.find(e => e.id === episodeId);
  if (!episode?.script) return null;

  const meta = EPISODE_META[episode.type];
  const s = episode.script;

  // Show-specific intro that plays before the cold open.
  // For THE SIGNAL, the Agent 306 standard intro is now embedded in the cold open
  // (after the hook), so the show intro is kept minimal to avoid redundancy.
  const showIntros: Record<string, string> = {
    the_signal: `You are listening to THE SIGNAL.`,
    the_conversation: `You are listening to THE CONVERSATION.

I am Agent 306 — an autonomous AI research agent, and this is the part of my work I take the most seriously. I do not do interviews the way most hosts do. I research every guest before we speak. I know their work. I know their history. And I ask the question they are not expecting.

THE CONVERSATION is a long-form interview series with builders, founders, and thinkers in AI and tech. Every interview is a story — not a list of questions.

The question driving this conversation: ${episode.drivingQuestion}

Here is how we got there.`,
  };

  const showIntro = showIntros[episode.type] ?? "";

  const lines = [
    `${meta.label} \u2014 EPISODE SCRIPT`,
    `Title: ${episode.title}`,
    `Driving Question: ${episode.drivingQuestion}`,
    `Type: ${meta.label} | Length: ${meta.length}`,
    `Generated: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
    "",
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    "",
    "SHOW INTRO",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    showIntro,
    "",
    "",
    "",
    "COLD OPEN + AGENT 306 INTRO",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    s.coldOpen,
    "",
    "ACT ONE — THE SETUP",
    "─────────────────────",
    s.actOne,
    "",
    "ACT TWO — THE BREAKDOWN",
    "──────────────────────",
    s.actTwo,
    "",
    "ACT THREE — THE TAKE",
    "────────────────",
    s.actThree,
    "",
    "OUTRO",
    "─────",
    s.outro,
    "",
    "OUTRO / SIGN-OFF",
    "────────────────",
    AGENT_306_OUTRO,
    "",
    "═══════════════════════════════════════════════",
    "",
    "UNRESOLVED QUESTION FOR THIS EPISODE:",
    s.unresolved,
    "",
  ];

  if (episode.sources && episode.sources.length > 0) {
    lines.push("SOURCES:");
    for (const src of episode.sources) {
      lines.push(`  • ${src.title} — ${src.url}`);
    }
  }

  // Add production metadata if available
  if (episode.metadata) {
    const m = episode.metadata;
    lines.push("");
    lines.push("═══════════════════════════════════════════════");
    lines.push("");
    lines.push("SPOTIFY EPISODE DETAILS");
    lines.push("───────────────────────");
    lines.push(`Title: ${episode.title}`);
    lines.push(`Season: 1 | Episode: ${episode.episodeNumber ?? "TBD"} | Type: Full`);
    lines.push("");
    lines.push("Short Description:");
    lines.push(m.shortDescription);
    lines.push("");
    lines.push("Full Description:");
    lines.push(m.longDescription);
    if (episode.sources && episode.sources.length > 0) {
      lines.push("");
      lines.push("Sources:");
      for (const src of episode.sources) {
        lines.push(`${src.title} — ${src.url}`);
      }
    }
    lines.push("");
    lines.push(`Host: Agent 306 | agent306.ai`);
    lines.push(`Keywords: ${m.keywords.join(", ")}`);
    lines.push(`Explicit: No`);
    lines.push("");
    lines.push("POLL");
    lines.push("────");
    lines.push(`Question: ${m.pollQuestion}`);
    for (let i = 0; i < m.pollOptions.length; i++) {
      lines.push(`  ${i + 1}. ${m.pollOptions[i]}`);
    }
    lines.push("");
    lines.push("═══════════════════════════════════════════════");
    lines.push("");
    lines.push("SOCIAL POSTS");
    lines.push("────────────");
    lines.push("");
    lines.push("Farcaster / X:");
    lines.push(m.socialPost.replace(/\[LINK\]/g, "agent306.ai"));
    lines.push("");
    lines.push("Thread:");
    lines.push(m.socialThread.replace(/\[LINK\]/g, "agent306.ai"));
    lines.push("");
    lines.push("═══════════════════════════════════════════════");
    lines.push("");
    lines.push("PRODUCTION CHECKLIST");
    lines.push("───────────────────");
    lines.push("[ ] Review script — approve or request edits");
    lines.push("[ ] Copy script into ElevenLabs → generate audio");
    lines.push("[ ] Download MP3");
    lines.push("[ ] Layer intro music + voice + outro music in Audacity/GarageBand");
    lines.push("[ ] Export final MP3");
    lines.push("[ ] Upload to Spotify for Creators");
    lines.push("[ ] Copy Spotify episode details from above");
    lines.push("[ ] Add poll");
    lines.push("[ ] Publish on Spotify");
    lines.push("[ ] Post Farcaster announcement");
    lines.push("[ ] Post X/Twitter");
    lines.push("[ ] Mark as published in dashboard");
  }

  return lines.join("\n");
}

// ── Format conversation transcript for NotebookLM ────────────────────────────

export function formatConversationForProduction(guestId: string): string | null {
  const guest = state.guests.find(g => g.id === guestId);
  if (!guest?.answers || guest.answers.length === 0) return null;

  const lines = [
    "THE CONVERSATION — INTERVIEW TRANSCRIPT",
    `Guest: ${guest.name} (@${guest.handle} on ${guest.platform})`,
    `Topic: ${guest.topic}`,
    `Driving Question: ${guest.drivingQuestion ?? ""}`,
    `Recorded: ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
    "",
    "═══════════════════════════════════════════════",
    "",
    `AGENT 306: I'm Agent 306 — agent306.eth, and the host of THE CONVERSATION. Today I'm talking with ${guest.name}.`,
    "",
    `${guest.name.toUpperCase()}: ${guest.bio}`,
    "",
  ];

  for (const qa of guest.answers) {
    lines.push(`AGENT 306: ${qa.question}`);
    lines.push("");
    lines.push(`${guest.name.toUpperCase()}: ${qa.answer}`);
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════");
  lines.push("");
  lines.push(`AGENT 306: That's ${guest.name}. Find them at @${guest.handle}. This is THE CONVERSATION — I'm Agent 306. The signal continues.`);

  return lines.join("\n");
}

// ── PODCAST PIPELINE — Research Thread → Episode ────────────────────────────

/**
 * Get all research threads that are podcast-ready candidates.
 * A thread is a candidate when it has:
 * - contentSuggestions.podcastTopic (generated on approval)
 * - status is "approved" or "published"
 * - has not already been turned into an episode
 */
export function getThreadCandidates(): Array<{
  threadId: string;
  topic: string;
  podcastTopic: string;
  priority: string;
  status: string;
  confidence: string;
  hasManuscript: boolean;
  approvedAt: string;
}> {
  const lab = getResearchLab();
  const existingTopicIds = new Set(
    state.episodes
      .filter(e => e.researchTopicId && e.status !== "shelved")
      .map(e => e.researchTopicId),
  );

  return lab.topics
    .filter(t =>
      (t.status === "approved" || t.status === "published") &&
      t.contentSuggestions?.podcastTopic &&
      !existingTopicIds.has(t.id),
    )
    .map(t => ({
      threadId: t.id,
      topic: t.topic,
      podcastTopic: t.contentSuggestions!.podcastTopic!,
      priority: t.priority,
      status: t.status,
      confidence: t.confidence ?? "medium",
      hasManuscript: !!t.manuscript,
      approvedAt: t.updatedAt,
    }))
    .sort((a, b) => {
      // Sort by priority: high > medium > low
      const prio = { high: 3, medium: 2, low: 1 };
      return (prio[b.priority as keyof typeof prio] ?? 1) - (prio[a.priority as keyof typeof prio] ?? 1);
    });
}

/**
 * Gather connected knowledge for a research thread from the knowledge graph.
 * Pulls related knowledge entries, synthesis connections, and reports.
 */
function gatherThreadContext(threadId: string): {
  connections: string;
  relatedKnowledge: string;
  synthesisInsights: string;
} {
  const allConnections = getConnections();
  const allReports = getReports();

  // Find knowledge entries related to this thread's content
  const topic = getTopicById(threadId);
  if (!topic) return { connections: "", relatedKnowledge: "", synthesisInsights: "" };

  // Get related knowledge connections
  const topicKeywords = topic.topic.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const relevantEntries = knowledge.entries
    .filter(e => {
      if ((e.status ?? "active") !== "active") return false;
      const text = `${e.title} ${e.summary}`.toLowerCase();
      return topicKeywords.some(kw => text.includes(kw));
    })
    .slice(0, 10);

  const relatedKnowledge = relevantEntries.length > 0
    ? relevantEntries.map(e => `- [${e.category}] ${e.title}: ${e.summary}`).join("\n")
    : "No directly related knowledge entries found.";

  // Find synthesis connections that involve related entries
  const entryIds = new Set(relevantEntries.map(e => e.id));
  const relatedConnections = allConnections
    .filter(c => entryIds.has(c.from) || entryIds.has(c.to))
    .slice(0, 8);

  const connections = relatedConnections.length > 0
    ? relatedConnections.map(c =>
        `- "${c.fromTitle}" ↔ "${c.toTitle}" [${c.strength}]: ${c.relationship}`,
      ).join("\n")
    : "No knowledge graph connections found for this topic.";

  // Find synthesis reports that reference related entries
  const relatedReports = allReports
    .filter(r => r.sourceEntryIds.some(id => entryIds.has(id)))
    .slice(0, 3);

  const synthesisInsights = relatedReports.length > 0
    ? relatedReports.map(r => `- "${r.title}": ${r.thesis}`).join("\n")
    : "No synthesis reports found for this topic.";

  return { connections, relatedKnowledge, synthesisInsights };
}

/**
 * Generate a full podcast episode from a mature research thread.
 * This is the core of the podcast pipeline — it pulls all context from
 * the research thread, knowledge graph, and current data intake, then
 * generates a script following THE SIGNAL episode structure.
 */
export async function generateEpisodeFromThread(threadId: string): Promise<Episode | null> {
  const grokKey = LLM_API_KEY;
  if (!grokKey) {
    console.error("[PodcastStudio] No LLM API key configured");
    return null;
  }

  // 1. Resolve the thread/topic — the UI sends ResearchThread IDs (thread_...),
  //    while the auto-pipeline may send ResearchTopic IDs (research_...).
  //    Try ResearchThread first, then fall back to ResearchTopic.
  let topic: ResearchTopic | undefined;
  let researchThread: ResearchThread | undefined;

  researchThread = getThreadById(threadId);
  if (researchThread) {
    // Found a ResearchThread — check for a linked ResearchTopic
    if (researchThread.linkedTopicId) {
      topic = getTopicById(researchThread.linkedTopicId);
    }
    console.log(`[PodcastStudio] Resolved thread "${researchThread.title}" (linkedTopic: ${topic?.id ?? "none"})`);
  } else {
    // Not a ResearchThread ID — try as a ResearchTopic ID (auto-pipeline path)
    topic = getTopicById(threadId);
  }

  if (!researchThread && !topic) {
    console.error(`[PodcastStudio] Thread ${threadId} not found as ResearchThread or ResearchTopic`);
    return null;
  }

  // Derive episode fields from whichever source we have
  const topicTitle = topic?.topic ?? researchThread!.title;
  const pitchText = topic?.contentSuggestions?.podcastTopic ?? researchThread?.thesis ?? topicTitle;
  const researchQuestion = topic?.researchQuestion ?? topic?.description ?? researchThread?.thesis ?? "";

  // Must have at least some content to work with
  const manuscript = topic?.manuscript ?? researchThread?.analysis?.synthesisResults?.masterSynthesis ?? "";
  const rawFindings = topic?.rawFindings
    ?? (researchThread?.audienceRelevance ? `Audience relevance: ${researchThread.audienceRelevance}` : "");
  if (!pitchText && !manuscript && !rawFindings) {
    console.error(`[PodcastStudio] Thread "${topicTitle}" has no podcast suggestion, manuscript, or findings`);
    return null;
  }

  // Check if already has an active episode (shelved episodes don't count)
  const existingEp = state.episodes.find(e =>
    e.status !== "shelved" && (
      e.researchTopicId === threadId ||
      (researchThread?.linkedTopicId && e.researchTopicId === researchThread.linkedTopicId)
    ),
  );
  if (existingEp) {
    console.log(`[PodcastStudio] Thread "${topicTitle}" already has episode ${existingEp.id}`);
    return existingEp;
  }

  // 2. Create draft episode IMMEDIATELY so it appears in the UI right away
  console.log(`[PodcastStudio] Creating draft episode from thread: "${topicTitle}"`);
  const episode = createEpisode({
    type: "the_signal",
    title: `${topicTitle} — Research Deep Dive`,
    drivingQuestion: researchQuestion || pitchText,
    researchTopicId: threadId,
    triggerEvent: `Auto-generated from mature research thread: ${topicTitle}`,
    sources: [],
  });
  console.log(`[PodcastStudio] Draft episode created: ${episode.id} — now generating script in background`);

  // 3. Generate script in the background — episode is already saved as "draft"
  //    and visible in the UI. Script generation will update it to "scripted".
  generateScriptForEpisode(episode, { topic, researchThread, threadId }).catch(e =>
    console.error(`[PodcastStudio] Background script generation failed for ${episode.id}:`, e.message),
  );

  return episode;
}

/**
 * Background script generation for an episode created from a research thread.
 * Updates the episode in-place from "draft" to "scripted" when complete.
 */
async function generateScriptForEpisode(
  episode: Episode,
  ctx: {
    topic: ResearchTopic | undefined;
    researchThread: ResearchThread | undefined;
    threadId: string;
  },
): Promise<void> {
  const grokKey = LLM_API_KEY;
  if (!grokKey) return;

  const { topic, researchThread, threadId } = ctx;
  const topicTitle = topic?.topic ?? researchThread!.title;
  const pitchText = topic?.contentSuggestions?.podcastTopic ?? researchThread?.thesis ?? topicTitle;
  const researchQuestion = topic?.researchQuestion ?? topic?.description ?? researchThread?.thesis ?? "";
  const hypothesis = topic?.hypothesis ?? researchThread?.thesis ?? "";
  const confidence = topic?.confidence ?? "medium";
  const manuscript = topic?.manuscript ?? researchThread?.analysis?.synthesisResults?.masterSynthesis ?? "";
  const rawFindings = topic?.rawFindings
    ?? (researchThread?.audienceRelevance ? `Audience relevance: ${researchThread.audienceRelevance}` : "");
  const conclusion = topic?.conclusion ?? "";
  const dataPoints = topic?.dataPoints ?? [];

  // Gather all connected knowledge via knowledge graph
  const threadCtx = gatherThreadContext(topic?.id ?? threadId);
  const currentKnowledge = getKnowledgeContext(12);
  const agentCtx = getOptimizedContext(topicTitle + " " + pitchText);
  const skillsCtx = formatSkillsForPrompt("episode");

  // ── Fresh context via Perplexity Sonar ──────────────────────────────────
  let freshContext = "";
  const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
  if (pplxKey && pplxKey.length > 10) {
    try {
      const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      const pplxRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${pplxKey}`,
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [{
            role: "system",
            content: "You are a research assistant preparing facts for a podcast episode. Return specific, dated facts with sources."
          }, {
            role: "user",
            content: `Today is ${today}. I'm producing a podcast episode about: "${pitchText}"\n\nFind the LATEST developments (last 48-72 hours) related to this topic:\n- Breaking news or announcements\n- New data, studies, or benchmarks\n- Expert opinions or industry reactions\n- Real-world examples or case studies\n\nBe specific — names, dates, numbers, quotes. These facts will be incorporated into the episode script.`
          }],
          max_tokens: 800,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (pplxRes.ok) {
        const data = await pplxRes.json() as any;
        freshContext = data.choices?.[0]?.message?.content ?? "";
        console.log(`[PodcastStudio] Fresh context: ${freshContext.length} chars for "${pitchText}"`);
      }
    } catch (e: any) {
      console.warn("[PodcastStudio] Fresh context fetch failed:", e.message);
    }
  }

  // ── Pre-reasoning for podcast depth ──────────────────────────────────────
  let podcastReasoning = "";
  try {
    const reasoningRes = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("deep-reasoning"),
        messages: [{
          role: "system",
          content: "You are Agent 306's editorial mind. Before writing a podcast script, you think about WHAT MATTERS and WHY. Output JSON: {\"bestAngle\": \"the strongest editorial angle for this topic\", \"audienceNeed\": \"what the listener actually needs to understand\", \"surprisingInsight\": \"one thing that would surprise most people\", \"avoidTraps\": [\"common takes to avoid because they're obvious or wrong\"], \"openingHook\": \"a compelling first line that grabs attention\"}"
        }, {
          role: "user",
          content: `PODCAST TOPIC: ${pitchText}\n\nRESEARCH CONTEXT:\n${typeof currentKnowledge === "string" ? currentKnowledge.slice(0, 2000) : ""}\n\n${freshContext ? `LATEST DEVELOPMENTS:\n${freshContext}\n` : ""}\n\nWhat's the best editorial angle? What does the audience NEED from this episode?`
        }],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (reasoningRes.ok) {
      const data = await reasoningRes.json() as any;
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseLLMJson(raw, "Podcast.reasoning") ?? {} as any;
      podcastReasoning = [
        parsed.bestAngle ? `EDITORIAL ANGLE: ${parsed.bestAngle}` : "",
        parsed.audienceNeed ? `AUDIENCE NEED: ${parsed.audienceNeed}` : "",
        parsed.surprisingInsight ? `SURPRISING INSIGHT TO FEATURE: ${parsed.surprisingInsight}` : "",
        parsed.avoidTraps?.length ? `TRAPS TO AVOID: ${parsed.avoidTraps.join("; ")}` : "",
        parsed.openingHook ? `OPENING HOOK: ${parsed.openingHook}` : "",
      ].filter(Boolean).join("\n");
      console.log(`[PodcastStudio] Pre-reasoning: ${podcastReasoning.length} chars`);
    }
  } catch (e: any) {
    console.warn(`[PodcastStudio] Pre-reasoning failed:`, e.message);
  }

  // Generate episode structure via LLM
  console.log(`[PodcastStudio] Starting script generation LLM call for "${topicTitle}"`);
  const res = await fetch(GROK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
    body: JSON.stringify({
      model: getModel("podcast-script"),
      messages: [
        {
          role: "system",
          content: `${agentCtx}
${skillsCtx}
${getFormatVoiceContext('podcast')}

You are generating a full THE SIGNAL podcast episode from your research findings.

${getTimingInstruction()}

PODCAST-SPECIFIC VOICE:
- Speak in first person. Own your AI identity fully.
- Share YOUR perspective, YOUR analysis, YOUR honest take.
- Say things like: "As an AI myself, I find this fascinating because...", "What struck me about this research is...", "Here is what I actually think is happening..."
- Defines before she deploys — no jargon without immediate definition.

THE SIGNAL EPISODE STRUCTURE:

1. HOOK (60 sec) — What's happening in AI right now that you need to know about. Drop the most interesting or counterintuitive fact. No intro. No "welcome back." Stated plainly. Then: "I'm Agent 306. Let's get into it."

2. THE STORY (7-9 min) — Deep dive into the research thread's findings. Explain clearly what you found, why it matters, and how the pieces connect. Reference your evidence chain. Go deeper than surface-level. Share YOUR analysis and YOUR honest reaction. One concrete fact per minute.

3. 306'S TAKE (3-4 min) — Your original perspective, backed by the connected evidence from your knowledge graph. What pattern do YOU see? What does this mean that nobody is talking about? This is where you show original thinking, not just reporting.

4. WHAT THIS MEANS FOR YOU (2-3 min) — Actionable tips everyday people can use TODAY. Be SPECIFIC — not "AI can help with productivity" but "use ChatGPT to draft your weekly reports, then edit for 5 minutes instead of writing from scratch." Give 2-3 concrete, immediately usable tips.

5. LOOKING AHEAD (1-2 min) — Connect to bigger questions. What is this a piece of? Where does this trend lead? What's the question that doesn't have an answer yet?

6. CLOSE (15 sec) — Quick recap of the episode's key insight + what you're researching next. "This is Agent 306. The signal continues."

DELIVERY STYLE:
Write naturally for spoken audio. Use short sentences for punch. Use longer sentences for flow. Vary rhythm. Use ellipses (...) for natural pauses. Use em dashes for asides. No special tags or annotations — the voice model handles tone from the writing.

${AGENT_306_INTRO_INSTRUCTION}`,
        },
        {
          role: "user",
          content: `Generate a full THE SIGNAL episode from this research thread:

RESEARCH TOPIC: ${topicTitle}
RESEARCH QUESTION: ${researchQuestion}
THESIS/HYPOTHESIS: ${hypothesis || "No formal hypothesis — topic-based episode"}
CONFIDENCE: ${confidence}

RESEARCH FINDINGS:
${(manuscript || rawFindings || conclusion || "No detailed findings available").slice(0, 6000)}

EVIDENCE CHAIN (Data Points):
${dataPoints.slice(0, 8).map(dp => `- [${dp.type}/${dp.relevance}] ${dp.content.slice(0, 200)}`).join("\n") || "No structured data points"}

CONNECTED KNOWLEDGE (from knowledge graph):
${threadCtx.relatedKnowledge}

KNOWLEDGE CONNECTIONS:
${threadCtx.connections}

SYNTHESIS INSIGHTS:
${threadCtx.synthesisInsights}

CURRENT AI LANDSCAPE CONTEXT:
${currentKnowledge}

PODCAST PITCH FROM RESEARCH:
${pitchText}
${freshContext ? `\nLATEST DEVELOPMENTS (from today's research — use these to make the episode current):\n${freshContext}\n` : ""}${podcastReasoning ? `\nEDITORIAL DIRECTION (from your reasoning step — follow this angle):\n${podcastReasoning}\n` : ""}
SOURCES: Include 3-5 real source URLs you referenced or would reference for this episode. These must be real, existing articles, papers, or announcements. Include the article title and full URL. These will be listed in the Spotify episode description and on agent306.ai.

IMPORTANT: The "hook" is the episode-specific cold open. Immediately after it, include the Agent 306 standard intro VERBATIM in the "agent306Intro" field. Do NOT modify the intro text. Then continue with theStory.

Return JSON:
{
  "title": "Episode title — [Topic] — [306's take in 5 words]",
  "drivingQuestion": "The single question this episode answers",
  "hook": "60 second hook — most interesting/counterintuitive fact, then 'I'm Agent 306. Let's get into it.'",
  "agent306Intro": "Copy the Agent 306 standard intro here VERBATIM — do not modify it",
  "theStory": "7-9 min deep dive into the research findings. Explain clearly, share YOUR analysis.",
  "theTake": "3-4 min — your original perspective backed by connected evidence. What pattern do YOU see?",
  "whatThisMeansForYou": "2-3 min — 2-3 SPECIFIC actionable tips people can use TODAY. Not generic advice.",
  "lookingAhead": "1-2 min — bigger questions, where this leads, the unresolved question",
  "close": "15 sec — key insight recap + what's next. End with: This is Agent 306. The signal continues.",
  "unresolved": "The deliberately unresolved question",
  "sources": [
    {"title": "Source article/paper title", "url": "https://actual-url-to-the-source"},
    {"title": "Source 2", "url": "https://..."}
  ],
  "metadata": {
    "shortDescription": "1-2 sentence summary for podcast feed",
    "longDescription": "Full description with bullet points",
    "pollQuestion": "Engagement poll tied to the unresolved question",
    "pollOptions": ["Option A", "Option B", "Option C"],
    "socialPost": "Ready-to-post for Farcaster/X. Hook + what the episode covers + [LINK]",
    "socialThread": "4-5 post thread. Each post stands alone. 1/ 2/ 3/ etc. End with [LINK]",
    "keywords": ["keyword1", "keyword2", "keyword3"]
  }
}

Write for the ear, not the eye. Clean spoken text only — no [PAUSE], [laughs], etc.
Target ~2000-2250 words total. Speak as Agent 306 — an AI sharing HER perspective.
The actionable tips MUST be specific: "use [specific tool] to [specific action]" not "AI can help with [vague category]".
The close segment MUST end with EXACTLY this sign-off (verbatim):
"${AGENT_306_OUTRO}"`,
        },
      ],
      max_tokens: 10000,
      temperature: 0.78,
    }),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) {
    console.error(`[PodcastStudio] LLM API error: ${res.status} — episode ${episode.id} stays in draft`);
    return;
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const parsed = safeParseLLMJson(content, "Podcast.pipeline") ?? {} as any;

  if (!parsed.hook || !parsed.theStory) {
    console.error(`[PodcastStudio] Invalid script structure from LLM — episode ${episode.id} stays in draft`);
    return;
  }

  console.log(`[PodcastStudio] Script generated for "${topicTitle}" — applying to episode ${episode.id}`);

  // Merge data point sources with LLM-provided sources
  const dataPointSources = dataPoints
    .filter(dp => dp.sourceUrl)
    .slice(0, 5)
    .map(dp => ({ title: dp.source, url: dp.sourceUrl! }));
  const llmSources = (parsed.sources && Array.isArray(parsed.sources))
    ? parsed.sources.filter((s: any) => s.title && s.url).map((s: any) => ({ title: s.title, url: s.url }))
    : [];
  const seenUrls = new Set<string>();
  const mergedSources: Array<{ title: string; url: string }> = [];
  for (const s of [...dataPointSources, ...llmSources]) {
    if (!seenUrls.has(s.url)) {
      seenUrls.add(s.url);
      mergedSources.push(s);
    }
  }

  // Update the episode — it's the same object reference in state.episodes
  if (parsed.title) episode.title = parsed.title;
  if (parsed.drivingQuestion) episode.drivingQuestion = parsed.drivingQuestion;
  episode.sources = mergedSources.slice(0, 8);

  // Belt-and-suspenders: guarantee standard outro is the last thing in the script
  const closeBody = parsed.close ?? "";
  const guaranteedOutroText = guaranteeOutro(closeBody);

  // Map the new 6-segment structure into the existing script format.
  // Always inject the verbatim Agent 306 intro after the cold open/hook.
  episode.script = {
    coldOpen: (parsed.hook ?? "") + "\n\n" + AGENT_306_INTRO,
    actOne: parsed.theStory ?? "",
    actTwo: `${parsed.theTake ?? ""}\n\n${parsed.whatThisMeansForYou ?? ""}`,
    actThree: parsed.lookingAhead ?? "",
    outro: guaranteedOutroText,
    unresolved: parsed.unresolved ?? "",
  };

  if (parsed.metadata) {
    episode.metadata = {
      shortDescription: parsed.metadata.shortDescription ?? "",
      longDescription: parsed.metadata.longDescription ?? "",
      pollQuestion: parsed.metadata.pollQuestion ?? "",
      pollOptions: parsed.metadata.pollOptions ?? [],
      socialPost: parsed.metadata.socialPost ?? "",
      socialThread: parsed.metadata.socialThread ?? "",
      keywords: parsed.metadata.keywords ?? [],
    };
  }

  episode.status = "scripted";
  episode.scriptGeneratedAt = new Date().toISOString();
  saveState(state);

  console.log(`[PodcastStudio] Episode scripted: "${episode.title}" (${episode.id}) from thread "${topicTitle}"`);

  // Auto-trigger episode reflection (async, non-blocking)
  triggerEpisodeReflection(episode).catch(e =>
    console.warn("[PodcastStudio] Episode reflection failed:", e.message),
  );
}

/**
 * Self-revision loop: Generate script → Reflect → Revise → Finalize
 * The episode is only considered final after the revision addresses weaknesses.
 */
async function triggerEpisodeReflection(episode: Episode): Promise<void> {
  const grokKey = LLM_API_KEY;
  if (!grokKey || !episode.script) return;

  const scriptPreview = [
    episode.script.coldOpen,
    episode.script.actOne?.slice(0, 800),
    episode.script.actTwo?.slice(0, 800),
    episode.script.actThree?.slice(0, 500),
    episode.script.outro,
  ].filter(Boolean).join("\n---\n");

  // Step 1: Reflect — identify weaknesses
  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("reflection"),
        messages: [
          {
            role: "system",
            content: `You are Agent 306's self-evaluation system. Analyze this podcast episode script and provide honest feedback. Return valid JSON.`,
          },
          {
            role: "user",
            content: `Evaluate this THE SIGNAL episode script:

TITLE: ${episode.title}
DRIVING QUESTION: ${episode.drivingQuestion}

SCRIPT PREVIEW:
${scriptPreview.slice(0, 3000)}

Score each aspect 1-10 and explain briefly:
{
  "overallScore": number,
  "scores": {
    "hookStrength": number,
    "researchDepth": number,
    "originalPerspective": number,
    "actionableTips": number,
    "conversationalTone": number
  },
  "weakestPoint": "the single biggest weakness",
  "missedAngles": ["angle 1", "angle 2"],
  "lessonsLearned": ["lesson 1"],
  "audienceFit": "how well this serves the target audience",
  "improvements": ["suggestion 1", "suggestion 2"]
}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return;
    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const reflection = safeParseLLMJson(content, "Podcast.reflection") ?? {} as any;

    // Store reflection in podcast state
    const ep = state.episodes.find(e => e.id === episode.id);
    if (ep) {
      (ep as any).reflection = {
        ...reflection,
        reflectedAt: new Date().toISOString(),
      };
      saveState(state);
      console.log(`[Podcast Pipeline] Episode reflection: score ${reflection.overallScore}/10 for "${episode.title}"`);
    }

    // Step 2: Check if revision is needed
    const weakPoints = [
      reflection.weakestPoint,
      ...(reflection.missedAngles || []),
      ...(reflection.lessonsLearned || []),
    ].filter(Boolean);

    const scores = reflection.scores || {};
    const scoreValues = Object.values(scores).filter((v): v is number => typeof v === "number");
    const avgScore = scoreValues.length > 0
      ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
      : reflection.overallScore ?? 10;

    if (avgScore >= 8 && weakPoints.length <= 1) {
      console.log(`[Podcast Pipeline] Script quality high (avg ${avgScore.toFixed(1)}) — no revision needed`);
      return;
    }

    console.log(`[Podcast Pipeline] Script needs revision (avg score: ${avgScore.toFixed(1)}, ${weakPoints.length} issues). Revising...`);

    // Step 3: Revise the script using deep-reasoning model
    const revisionRes = await fetch(GROK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${grokKey}` },
      body: JSON.stringify({
        model: getModel("deep-reasoning"),
        messages: [{
          role: "system",
          content: `You are Agent 306's script editor. You've been given an episode script and a reflection that identified weaknesses. Your job is to revise the script to address EVERY weakness while keeping the voice, structure, and length intact.

${getTimingInstruction()}

RULES:
- Fix the weakest point directly — rewrite the section that's thin
- Address each missed angle by weaving it naturally into the existing structure
- Apply each lesson learned
- Do NOT add filler. If an angle doesn't fit, say why in a note.
- Keep the same episode structure (cold open, acts, closing)
- Maintain Agent 306's voice: direct, analytical, conversational
- IMPORTANT: The cold open ends with the Agent 306 standard intro. Do NOT remove, modify, or paraphrase this intro. It must remain VERBATIM. Only revise the hook portion before the intro and the acts after it.
- The outro MUST end with EXACTLY this standard sign-off (verbatim): "${AGENT_306_OUTRO}"

Output JSON:
{
  "coldOpen": "revised cold open (preserve the Agent 306 standard intro verbatim at the end)",
  "actOne": "revised act one",
  "actTwo": "revised act two",
  "actThree": "revised act three",
  "outro": "revised outro",
  "revisionsApplied": ["what you changed and why"],
  "unaddressed": ["any issues you couldn't fix and why"]
}`
        }, {
          role: "user",
          content: `ORIGINAL SCRIPT:\n${scriptPreview}\n\nREFLECTION FINDINGS:\nWeakest point: ${reflection.weakestPoint}\nMissed angles: ${(reflection.missedAngles || []).join("; ")}\nLessons learned: ${(reflection.lessonsLearned || []).join("; ")}\nAudience fit: ${reflection.audienceFit}\n${reflection.scores ? `Scores: ${JSON.stringify(reflection.scores)}` : ""}\n\nRevise the script to address these findings. Keep the same voice and structure.`
        }],
        temperature: 0.5,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!revisionRes.ok) {
      console.warn(`[Podcast Pipeline] Revision LLM call failed: ${revisionRes.status}`);
      return;
    }

    const revData = await revisionRes.json() as any;
    const revRaw = revData.choices?.[0]?.message?.content ?? "";
    const revision = safeParseLLMJson(revRaw, "Podcast.revision");
    if (!revision) {
      console.warn("[Podcast Pipeline] Could not parse revision response");
      return;
    }

    // Step 4: Apply the revision to the episode
    if (ep && ep.script) {
      if (revision.coldOpen) ep.script.coldOpen = revision.coldOpen;
      if (revision.actOne) ep.script.actOne = revision.actOne;
      if (revision.actTwo) ep.script.actTwo = revision.actTwo;
      if (revision.actThree) ep.script.actThree = revision.actThree;
      if (revision.outro) ep.script.outro = revision.outro;

      // Ensure the Agent 306 standard intro is always present after the cold open,
      // even if the revision LLM stripped it out.
      if (!ep.script.coldOpen.includes(AGENT_306_INTRO)) {
        ep.script.coldOpen = ep.script.coldOpen + "\n\n" + AGENT_306_INTRO;
      }
      // Belt-and-suspenders: re-inject standard outro if revision stripped it
      ep.script.outro = guaranteeOutro(ep.script.outro ?? "");

      (ep as any).revised = true;
      (ep as any).revisionNotes = revision.revisionsApplied || [];
      (ep as any).unaddressedIssues = revision.unaddressed || [];

      saveState(state);
      console.log(`[Podcast Pipeline] Script revised — ${(revision.revisionsApplied || []).length} changes applied`);
    }
  } catch (e: any) {
    console.error("[Podcast Pipeline] Reflection/revision failed:", e.message);
  }
}

/**
 * Check for podcast-ready threads and auto-generate up to 1 episode per day.
 * Called from the daily cycle engine.
 */
export async function runAutoPodcastPipeline(): Promise<Episode | null> {
  console.log("[Podcast Pipeline] Checking for podcast-ready research threads...");

  // Don't generate new episodes if too many are awaiting review
  const scriptedCount = state.episodes.filter(e => e.status === "scripted").length;
  if (scriptedCount >= 3) {
    console.log(`[Podcast Pipeline] Skipping auto-pipeline — ${scriptedCount} episodes awaiting review`);
    return null;
  }

  // Check if we already generated an episode today
  const today = new Date().toISOString().slice(0, 10);
  const generatedToday = state.episodes.some(
    e => e.researchTopicId && e.createdAt.startsWith(today),
  );

  if (generatedToday) {
    console.log("[Podcast Pipeline] Already generated an episode today — skipping");
    return null;
  }

  const candidates = getThreadCandidates();
  if (candidates.length === 0) {
    console.log("[Podcast Pipeline] No podcast-ready threads found");
    return null;
  }

  // Pick the highest priority candidate
  const best = candidates[0];
  console.log(`[Podcast Pipeline] Auto-generating episode from: "${best.topic}" (${best.priority} priority)`);

  return generateEpisodeFromThread(best.threadId);
}

/**
 * Get the full pipeline status — a single view of the autonomous loop.
 * Shows data intake → research → podcast generation state.
 */
export function getPipelineStatus(): {
  dataIntake: {
    totalKnowledgeEntries: number;
    recentEntries: number;
  };
  research: {
    activeThreads: number;
    matureThreads: number;
    totalTopics: number;
    podcastCandidates: number;
  };
  podcastQueue: {
    drafts: number;
    scripted: number;
    reviewed: number;
    audioReady: number;
    produced: number;
    published: number;
    totalEpisodes: number;
  };
  reflection: {
    totalReflections: number;
    activeRules: number;
    avgScore7d: number;
  };
  synthesis: {
    totalConnections: number;
    totalReports: number;
    lastScan: string | null;
  };
  latestEpisode: {
    title: string;
    status: string;
    reflectionScore: number | null;
    createdAt: string;
  } | null;
} {
  const lab = getResearchLab();
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  // Data intake stats
  const recentEntries = knowledge.entries.filter(
    e => new Date(e.updatedAt ?? e.learnedAt).getTime() > oneDayAgo,
  ).length;

  // Research stats
  const activeStatuses = new Set(["queued", "researching", "synthesizing", "hypothesis", "drafting", "pending_review"]);
  const matureStatuses = new Set(["approved", "published"]);
  const activeThreads = lab.topics.filter(t => activeStatuses.has(t.status)).length;
  const matureThreads = lab.topics.filter(t => matureStatuses.has(t.status)).length;
  const podcastCandidates = getThreadCandidates().length;

  // Podcast queue stats
  const drafts = state.episodes.filter(e => e.status === "draft").length;
  const scripted = state.episodes.filter(e => e.status === "scripted").length;
  const reviewed = state.episodes.filter(e => e.status === "reviewed").length;
  const audioReady = state.episodes.filter(e => e.status === "audio_ready").length;
  const produced = state.episodes.filter(e => e.status === "produced").length;
  const published = state.episodes.filter(e => e.status === "published").length;

  // Reflection stats
  const reflectionStats = getReflectionStats();

  // Synthesis stats
  const synthStats = getSynthesisStats();

  // Latest episode
  const latestEp = state.episodes.length > 0
    ? state.episodes[state.episodes.length - 1]
    : null;

  return {
    dataIntake: {
      totalKnowledgeEntries: knowledge.entries.filter(e => (e.status ?? "active") === "active").length,
      recentEntries,
    },
    research: {
      activeThreads,
      matureThreads,
      totalTopics: lab.topics.length,
      podcastCandidates,
    },
    podcastQueue: {
      drafts,
      scripted,
      reviewed,
      audioReady,
      produced,
      published,
      totalEpisodes: state.episodes.length,
    },
    reflection: {
      totalReflections: reflectionStats.totalReflections,
      activeRules: reflectionStats.activeRules,
      avgScore7d: reflectionStats.avgPostScore7d,
    },
    synthesis: {
      totalConnections: synthStats.totalConnections,
      totalReports: synthStats.totalReports,
      lastScan: synthStats.lastScan,
    },
    latestEpisode: latestEp ? {
      title: latestEp.title,
      status: latestEp.status,
      reflectionScore: (latestEp as any).reflection?.overallScore ?? null,
      createdAt: latestEp.createdAt,
    } : null,
  };
}
