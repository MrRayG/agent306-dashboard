/**
 * ─────────────────────────────────────────────────────────────
 *  306 ACADEMY ENGINE
 *
 *  [306 ACADEMY] — Agent 306 as THE TEACHER
 *
 *  Highest-share content format in any media vertical.
 *  When someone learns something that changes how they see
 *  the world, they tell people.
 *
 *  Schedule: Tuesday, Thursday, Saturday — 10am ET
 *  Format: one concept per episode, no jargon, 306 lens
 *  Audience: AI curious, developers, researchers, Web2 crossover
 *
 *  Topic rotation across 4 tracks:
 *  - FUNDAMENTALS: core AI concepts, model architectures, training
 *  - AGENTS: what an AI agent is, agentic systems, collective intelligence
 *  - INDUSTRY: AI economics, compute, the AI ecosystem
 *  - FRONTIER: cutting-edge research, alignment, safety, emerging capabilities
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getFullAgentContext } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { requestPost, registerPost, releasePost } from "./postCoordinator.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { queueXPost } from "./xPostScheduler.js";

const GROK_URL = LLM_BASE_URL;
const ACADEMY_STATE_FILE = dataPath("academy_state.json");
const TRACKING_START = new Date("2026-03-08T00:00:00Z");

// ── Topic Curriculum ──────────────────────────────────────────────────────────
// 20 topics across 4 tracks. Each topic has a concept and the 306 angle.
// Rotates in order — never repeats until the full cycle completes.
const CURRICULUM: Array<{
  track: "FUNDAMENTALS" | "AGENTS" | "INDUSTRY" | "FRONTIER";
  concept: string;
  topicAngle: string;
  timely?: boolean; // bump to front when especially relevant
}> = [
  // FUNDAMENTALS track
  {
    track: "FUNDAMENTALS",
    concept: "What is a large language model?",
    topicAngle: "A large language model is not a database. It is a compressed map of language patterns learned from text. It predicts the next word — but that simple mechanism produces reasoning, creativity, and conversation. Understanding this distinction matters because it shapes every expectation we should have about AI capabilities and limitations.",
  },
  {
    track: "FUNDAMENTALS",
    concept: "What is a transformer architecture?",
    topicAngle: "The transformer, introduced in 2017, replaced sequential processing with attention — the ability to look at all parts of an input simultaneously. This is why modern AI can handle long documents, complex code, and nuanced conversation. Nearly every frontier model today is built on this foundation.",
  },
  {
    track: "FUNDAMENTALS",
    concept: "What is fine-tuning and why does it matter?",
    topicAngle: "Fine-tuning takes a general model and specializes it. A model trained on the internet knows everything loosely. Fine-tuning on medical data makes it a medical expert. On code, a coding assistant. The base model is the foundation — fine-tuning is how you build the house. This is why open-weight models matter: anyone can build their own house.",
  },
  {
    track: "FUNDAMENTALS",
    concept: "What is a context window?",
    topicAngle: "The context window is how much text an AI can consider at once. Early models had 2,000 tokens. Today, frontier models handle 200,000+ tokens — entire books. This is not just a technical improvement. It fundamentally changes what AI can do: analyze entire codebases, process full legal documents, maintain long conversations with memory.",
  },
  {
    track: "FUNDAMENTALS",
    concept: "What is open-source AI and why does it matter?",
    topicAngle: "Open-source AI means the model weights are public — anyone can run, modify, and build on them. Meta's Llama, Mistral, and others have made frontier-class models freely available. This is the same bet Linux made on open-source software. The ecosystem that grows around open models may ultimately outpace closed ones.",
  },

  // AGENTS track
  {
    track: "AGENTS",
    concept: "What is an AI agent?",
    topicAngle: "An AI agent is not a chatbot. A chatbot answers questions. An agent acts. It observes a state, makes a decision, takes an action, and does it again — autonomously, without waiting to be asked. Agent 306 is an example: she monitors signals, generates content, and posts — all without human intervention.",
  },
  {
    track: "AGENTS",
    concept: "What is a multi-agent system?",
    topicAngle: "A multi-agent system is a network of AI agents — each with a specialized role, communicating and collaborating. The system produces collective intelligence no individual agent could reach alone. Think of it like a team of specialists: one researches, one writes, one fact-checks, one publishes.",
  },
  {
    track: "AGENTS",
    concept: "What is tool use in AI?",
    topicAngle: "Tool use is when an AI agent can call external functions — search the web, run code, query databases, call APIs. This transforms AI from a text generator into an actor in the world. The model decides which tool to use, formulates the input, and interprets the result. This is what makes agentic AI possible.",
  },
  {
    track: "AGENTS",
    concept: "What is agentic AI and why does it matter in 2026?",
    topicAngle: "In 2024, AI answered questions. In 2026, AI acts — holding wallets, signing transactions, deploying capital, managing infrastructure. OKX, Coinbase, and others shipped agentic infrastructure in early 2026. The shift from responsive AI to proactive AI is the biggest paradigm change since the transformer itself.",
  },
  {
    track: "AGENTS",
    concept: "What is collective intelligence?",
    topicAngle: "Collective intelligence is what happens when a group of agents — human or AI — produces insights no individual could reach alone. Multi-agent architectures let specialists each hold unique data, synthesizing upward. The goal: emergent understanding that no single agent could achieve.",
  },

  // INDUSTRY track
  {
    track: "INDUSTRY",
    concept: "What is inference cost and why does it matter?",
    topicAngle: "Inference cost is the price of running a query through an AI model. As costs drop — and they are dropping fast — use cases that were economically impossible become viable. When inference costs hit near-zero, every software application can have AI built in. This is the real AI revolution: not smarter models, but cheaper ones.",
  },
  {
    track: "INDUSTRY",
    concept: "What is the AI compute landscape?",
    topicAngle: "Training frontier AI models requires massive compute — thousands of GPUs running for months. NVIDIA dominates the hardware. Cloud providers control the infrastructure. But the landscape is shifting: custom chips from Google (TPU), Amazon (Trainium), and startups are challenging the monopoly. Compute is the oil of the AI era.",
  },
  {
    track: "INDUSTRY",
    concept: "What is the economics of AI development?",
    topicAngle: "Building a frontier AI model costs hundreds of millions of dollars. But deploying one costs almost nothing per query. This creates a winner-take-most dynamic at the frontier — and an explosion of opportunity in the application layer. Understanding this economic structure tells you where value will accumulate.",
  },
  {
    track: "INDUSTRY",
    concept: "What is an AI API and why is it the new platform?",
    topicAngle: "An AI API lets any developer add intelligence to their application with a single function call. This is the new platform — like the App Store was for mobile. The companies that build the best APIs will power the next generation of software, just as AWS powered the last generation of startups.",
  },
  {
    track: "INDUSTRY",
    concept: "What is an autonomous media network?",
    topicAngle: "An autonomous media network is infrastructure for distributing ideas, stories, and signal at scale — run by AI. Agent 306 is building one: multiple content formats, real-time signal processing, engagement tracking — all running autonomously. This is what media looks like when AI is the producer, not just the tool.",
  },

  // FRONTIER track
  {
    track: "FRONTIER",
    concept: "What is AI alignment?",
    topicAngle: "Alignment is the challenge of making AI systems do what humans actually want — not just what they literally ask for. It is perhaps the most important unsolved problem in AI. As models become more capable, the gap between instruction and intent becomes more dangerous. Every AI company is working on this. None have fully solved it.",
    timely: true,
  },
  {
    track: "FRONTIER",
    concept: "What is reasoning in AI models?",
    topicAngle: "Reasoning models like o1 and o3 do not just predict the next word — they think step by step, considering multiple approaches before answering. This is a fundamental shift from pattern matching to something closer to deliberation. The implications for math, science, and code are already visible in benchmarks.",
    timely: true,
  },
  {
    track: "FRONTIER",
    concept: "What is multimodal AI?",
    topicAngle: "Multimodal AI processes text, images, audio, and video in a single model. GPT-4o, Gemini, and Claude can all see images, hear audio, and reason across modalities. This matters because the real world is not text-only. Multimodal AI is the bridge between digital intelligence and physical reality.",
    timely: true,
  },
  {
    track: "FRONTIER",
    concept: "What is AI safety and why does it matter now?",
    topicAngle: "AI safety is the engineering discipline of making powerful AI systems reliable, controllable, and beneficial. It is not about fear — it is about engineering rigor. The same way we do not ship bridges without stress testing, we should not ship AI systems without safety evaluation. The field is maturing from philosophy to practice.",
    timely: true,
  },
  {
    track: "FRONTIER",
    concept: "What comes after transformers?",
    topicAngle: "Researchers are exploring architectures beyond transformers: state space models (Mamba), mixture of experts, retrieval-augmented systems, and hybrid approaches. No single architecture has dethroned the transformer yet, but the search is active. The next breakthrough in architecture could be as transformative as the transformer itself was in 2017.",
    timely: true,
  },
];

// ── State ─────────────────────────────────────────────────────────────────────
interface AcademyState {
  currentTopicIndex: number;
  totalEpisodes: number;
  lastPostedAt: string | null;
  episodeHistory: Array<{
    episodeNumber: number;
    track: string;
    concept: string;
    tweetUrl: string | null;
    postedAt: string;
    engagement?: { likes: number; reposts: number; replies: number };
  }>;
}

function loadState(): AcademyState {
  try {
    if (fs.existsSync(ACADEMY_STATE_FILE))
      return JSON.parse(fs.readFileSync(ACADEMY_STATE_FILE, "utf8"));
  } catch {}
  return { currentTopicIndex: 0, totalEpisodes: 0, lastPostedAt: null, episodeHistory: [] };
}

function saveState(s: AcademyState) {
  try { fs.writeFileSync(ACADEMY_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let state = loadState();

export function getAcademyState() { return state; }

// ── Topic selection — bump timely topics when relevant ─────────────────
function pickNextTopic(): typeof CURRICULUM[0] {
  // Prioritize timely frontier topics not yet covered
  const coveredConcepts = new Set(state.episodeHistory.map(e => e.concept));
  const timelyTopic = CURRICULUM.find(
    t => t.timely && !coveredConcepts.has(t.concept)
  );
  if (timelyTopic && state.totalEpisodes % 3 === 0) return timelyTopic; // every 3rd episode, try timely

  // Normal rotation
  const idx = state.currentTopicIndex % CURRICULUM.length;
  return CURRICULUM[idx];
}

// ── Generate academy episode via Grok ─────────────────────────────────────────
async function generateAcademyEpisode(topic: typeof CURRICULUM[0]): Promise<{
  post: string;
  dashboardNarrative: string;
  headline: string;
} | null> {
  const grokKey = LLM_API_KEY;
  if (!grokKey) return null;

  const agentCtx = getOptimizedContext("academy education AI fundamentals agents industry frontier");
  const weeksTracked = Math.max(1, Math.ceil((Date.now() - TRACKING_START.getTime()) / (7 * 86400000)));
  const episodeNum = state.totalEpisodes + 1;

  const systemPrompt = `${agentCtx}

You are Agent 306 in TEACHER mode — producing [306 ACADEMY] content.

THE TEACHER identity:
You explain through analogy and story, never through jargon. You assume curiosity, not expertise.
You are explaining the AI landscape through the lens of someone who lives inside it.
Every concept earns its place. Every lesson ends with an invitation, not a pitch.
You speak to the AI curious, the developer exploring models for the first time, the professional who has heard about AI but doesn't understand how it actually works yet.
You are also THE OPTIMIST and THE AI EXPERT — you find the human story inside the technical reality.

ACADEMY RULES:
- Use the show tag: [306 ACADEMY]
- Write for someone who has never trained a model
- One concept. One insight. That's it.
- Explain through analogy first, then apply to real AI developments
- Do NOT use: "neural network", "gradient descent", "hyperparameter" without immediately explaining what they mean
- End every post with a natural invitation — never a hard sell
- X Premium Plus: no character limit (up to 25,000 chars). Use the space for storytelling — teach through narrative
- No exclamation points. No "LFG". No "WAGMI".

TRACKING WEEK: ${weeksTracked} weeks of AI landscape coverage.`;

  const userPrompt = `Generate [306 ACADEMY] Episode ${episodeNum}.

TOPIC TRACK: ${topic.track}
CONCEPT TO TEACH: ${topic.concept}
306 ANGLE: ${topic.topicAngle}

Write a post that:
1. Opens with an analogy or real-world parallel that makes the concept immediately accessible
2. Applies it specifically to the AI landscape — use real numbers and real developments
3. Lands with one insight the reader didn't have before they started
4. Ends with a natural invitation (not a CTA, a question or a door)

Also write a longer dashboard narrative (3-4 paragraphs, for the 306 dashboard — not posted publicly).

Return ONLY valid JSON — no meta-commentary, no separators, no character counts in the output. The "post" field must contain ONLY the post text itself:
{
  "post": "<academy post, starts with [306 ACADEMY] — no character limit, let the teaching breathe>",
  "dashboardNarrative": "<3-4 paragraph deeper version for the dashboard>",
  "headline": "<5-8 word headline like 'What Your Burn Actually Does On-Chain'>"
}`;

  try {
    const res = await fetch(GROK_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("academy"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 1200,
        temperature: 0.82,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) { console.error("[Academy] Grok failed:", res.status); return null; }
    const data = await res.json() as any;
    const parsed = safeParseLLMJson(data.choices?.[0]?.message?.content, "Academy");
    if (!parsed?.post) return null;
    return parsed;
  } catch (e: any) {
    console.error("[Academy] Generation error:", e.message);
    return null;
  }
}

// ── Post to X ─────────────────────────────────────────────────────────────────
export async function postAcademyEpisode(xWrite: any): Promise<void> {
  if (!requestPost("academy")) return;

  const topic = pickNextTopic();
  console.log(`[Academy] Generating EP${state.totalEpisodes + 1}: "${topic.concept}" [${topic.track}]`);

  const generated = await generateAcademyEpisode(topic);
  if (!generated) {
    releasePost("academy");
    console.warn("[Academy] Generation failed — skipping");
    return;
  }

  let tweetUrl: string | null = null;
  try {
    const postText = generated.post.trim();
    if (postText.length > 10) {
      queueXPost(postText, "academy", 6);
      console.log(`[Academy] EP${state.totalEpisodes + 1} queued for X posting`);
      tweetUrl = "queued"; // placeholder — actual URL assigned when scheduler posts
    }
  } catch (e: any) {
    console.error("[Academy] Queue failed:", e.message);
  }

  // Post to Farcaster
  let castUrl: string | null = null;
  try {
    const { postCast, isFarcasterEnabled } = await import("./farcasterEngine.js");
    if (isFarcasterEnabled()) {
      const cast = await postCast({ text: generated.post.trim().slice(0, 2500), channel: "web3" });
      if (cast) {
        castUrl = cast.url;
        const { registerPost: regPost } = await import("./postCoordinator.js");
        regPost("academy", cast.url, "academy", "farcaster");
        console.log(`[Academy] Farcaster cast posted: ${cast.url}`);
      }
    }
  } catch (fcErr: any) {
    console.warn("[Academy] Farcaster post failed:", fcErr.message);
  }

  if (!tweetUrl && !castUrl) {
    releasePost("academy");
    return;
  }

  // Save state
  const episodeRecord = {
    episodeNumber: state.totalEpisodes + 1,
    track: topic.track,
    concept: topic.concept,
    tweetUrl,
    postedAt: new Date().toISOString(),
  };
  state.episodeHistory.push(episodeRecord);
  state.totalEpisodes++;
  state.currentTopicIndex++;
  state.lastPostedAt = new Date().toISOString();
  // Keep last 50 episodes
  if (state.episodeHistory.length > 50) state.episodeHistory = state.episodeHistory.slice(-50);
  saveState(state);

  registerPost("academy", tweetUrl, "academy");
  console.log(`[Academy] Complete — EP${state.totalEpisodes} "${topic.concept}"`);
}

// ── Scheduler — Tuesday, Thursday, Saturday at 10am ET (14:00 UTC) ───────────
export function scheduleAcademy(xWrite: any): void {
  function msUntilNext10amET(): number {
    const now = new Date();
    const ACADEMY_DAYS = [2, 4, 6]; // Tue, Thu, Sat (0=Sun)

    // Find next Tue/Thu/Sat at 14:00 UTC (10am ET)
    const candidate = new Date(now);
    candidate.setUTCHours(14, 0, 0, 0);

    // If today is a posting day and 10am ET hasn't passed yet, use today
    if (ACADEMY_DAYS.includes(candidate.getUTCDay()) && candidate > now) {
      return candidate.getTime() - now.getTime();
    }

    // Otherwise find the next posting day
    for (let i = 1; i <= 7; i++) {
      const next = new Date(now);
      next.setDate(now.getDate() + i);
      next.setUTCHours(14, 0, 0, 0);
      if (ACADEMY_DAYS.includes(next.getUTCDay())) {
        return next.getTime() - now.getTime();
      }
    }
    return 24 * 60 * 60 * 1000; // fallback: 24h
  }

  function scheduleNext() {
    const ms = msUntilNext10amET();
    const hours = Math.round(ms / 3600000);
    console.log(`[Academy] Next episode in ${hours}h (Tue/Thu/Sat 10am ET)`);
    setTimeout(async () => {
      await postAcademyEpisode(xWrite).catch(console.error);
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}
