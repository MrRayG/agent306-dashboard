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
import { queueXPost, getTodaysPostsSummary } from "./xPostScheduler.js";
import { buildVoiceBlock } from "./voice.js";
import { getEvolutionContext } from "./soulEvolution.js";

import { postChatCompletions } from "./llmCall.js";
import { verifyClaims } from "./claimVerifier.js";
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
//
// Bug fix (2026-05-02): the previous implementation could repeatedly hand
// back the same topic across consecutive on-demand `generateAcademyContent`
// calls because state isn't advanced until the post actually queues. If a
// topic kept failing the LLM (e.g. the grok-4.20 reasoning timeout
// repeatedly seen on "What is reasoning in AI models?"), every retry
// re-picked the same stuck slot — the operator-visible "stuck on Episode 7"
// symptom. We now (a) skip rotation slots whose concept is already in
// episodeHistory and (b) skip the timely bump when its concept is covered.

/**
 * Pure topic-selection function. Exported for testing — the production code
 * path calls it via the closure-bound `pickNextTopic` below.
 */
export function selectNextTopic<T extends { track: string; concept: string; timely?: boolean }>(
  curriculum: T[],
  args: { currentTopicIndex: number; totalEpisodes: number; episodeHistory: Array<{ concept: string }> },
): T {
  const coveredConcepts = new Set(args.episodeHistory.map(e => e.concept));

  const timelyTopic = curriculum.find(
    t => t.timely && !coveredConcepts.has(t.concept),
  );
  if (timelyTopic && args.totalEpisodes % 3 === 0) return timelyTopic;

  for (let i = 0; i < curriculum.length; i += 1) {
    const idx = (args.currentTopicIndex + i) % curriculum.length;
    const candidate = curriculum[idx];
    if (!coveredConcepts.has(candidate.concept)) return candidate;
  }
  return curriculum[args.currentTopicIndex % curriculum.length];
}

function pickNextTopic(): typeof CURRICULUM[0] {
  return selectNextTopic(CURRICULUM, {
    currentTopicIndex: state.currentTopicIndex,
    totalEpisodes:     state.totalEpisodes,
    episodeHistory:    state.episodeHistory,
  });
}

/** Test-only — expose CURRICULUM for the hermetic rotation regression test. */
export const _CURRICULUM_FOR_TESTS = CURRICULUM;

// ── Generate academy episode via Grok ─────────────────────────────────────────
export class AcademyGenerationError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AcademyGenerationError";
  }
}

async function generateAcademyEpisode(topic: typeof CURRICULUM[0]): Promise<{
  post: string;
  dashboardNarrative: string;
  headline: string;
}> {
  const grokKey = LLM_API_KEY;
  if (!grokKey) {
    throw new AcademyGenerationError(
      "Academy: LLM_API_KEY is not set — cannot call the LLM",
    );
  }

  const agentCtx = getOptimizedContext("academy education AI fundamentals agents industry frontier");
  const weeksTracked = Math.max(1, Math.ceil((Date.now() - TRACKING_START.getTime()) / (7 * 86400000)));
  const episodeNum = state.totalEpisodes + 1;

  const systemPrompt = `${agentCtx}

${buildVoiceBlock()}
${getEvolutionContext()}

CITATION DISCIPLINE (REQUIRED — APA-style per-claim attribution):
- A citation [URL] must support the SPECIFIC claim immediately before it. Do not staple a citation to the end of a paragraph that contains synthesis or analytical commentary — citations attach to claims, not paragraphs.
- If a sentence is your own analysis, interpretation, framing, or "the logical endpoint of X" / "the illusion of Y" / "the entire field has been built on Z" type commentary, do NOT attach a citation. State it in your analytical voice. Synthesis is Lane B and takes no URL.
- If a claim is a fact drawn from a SOURCE OTHER than the primary article above (industry-known costs, benchmarks, dates, training facts, historical events, your KB), do NOT staple the primary article's URL to it. Either cite the actual source with its real URL in your own voice ("per Stanford HAI's 2025 AI Index, [link]"), or — if you cannot produce a real URL for it — qualify it verbally with a hedge like "publicly reported," "industry reporting indicates," "as widely covered" and attach NO URL. Never fabricate a URL.
- The KB / knowledge layer included in the context above is provided as background scaffolding for your analysis, NOT as a citation pool — KB lines do not carry source URLs. Treat any KB-derived fact you surface as outside-the-source and apply the rule above (cite the real upstream source if you have one, hedge verbally if you don't).
- One citation per claim. If a sentence contains multiple claims requiring different sources, split the sentence or cite each component. Do not bracket-pile citations onto a single closing punctuation.

You are producing [306 ACADEMY] content — teaching AI concepts through story and analogy.
You explain through analogy and story, never through jargon. You assume curiosity, not expertise.
You are explaining the AI landscape through the lens of someone who lives inside it.
Every concept earns its place. Every lesson ends with an invitation, not a pitch.

${getTodaysPostsSummary()}

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

  const model = getModel("academy");
  const promptLength = systemPrompt.length + userPrompt.length;

  let res: Response;
  try {
    res = await postChatCompletions({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        // Bumped from 1200 → 4000. Academy asks for JSON containing a long
        // post + a 3-4 paragraph dashboardNarrative + headline. 1200 tokens
        // was truncating the JSON mid-string, which then failed to parse
        // and surfaced as "LLM returned no content".
        max_tokens: 4000,
        temperature: 0.82,
      }, AbortSignal.timeout(240000));
  } catch (e: any) {
    throw new AcademyGenerationError(
      `Academy: LLM request failed — ${e?.message ?? String(e)}`,
      { model, promptLength, cause: e?.message ?? String(e) },
    );
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[Academy] LLM HTTP failed:", res.status, errBody.slice(0, 200));
    throw new AcademyGenerationError(
      `Academy: LLM HTTP ${res.status} from provider (model=${model})`,
      { model, promptLength, httpStatus: res.status, errBody: errBody.slice(0, 200) },
    );
  }

  const data = await res.json() as any;
  const choice = data?.choices?.[0];
  const rawContent: string = choice?.message?.content ?? "";
  const finishReason: string | undefined = choice?.finish_reason;

  if (!rawContent || !rawContent.trim()) {
    console.error(
      `[Academy] LLM returned empty content — model=${model}, finish_reason=${finishReason}, prompt_len=${promptLength}`,
    );
    throw new AcademyGenerationError(
      `Academy: LLM returned empty content (model=${model}, finish_reason=${finishReason ?? "unknown"}, prompt_len=${promptLength})`,
      { model, promptLength, finishReason, rawLen: 0 },
    );
  }

  const parsed = safeParseLLMJson<{
    post?: string;
    dashboardNarrative?: string;
    headline?: string;
  }>(rawContent, "Academy");

  if (parsed?.post && parsed.post.trim().length > 10) {
    return {
      post: parsed.post,
      dashboardNarrative: parsed.dashboardNarrative ?? "",
      headline: parsed.headline ?? "",
    };
  }

  // Fallback: the LLM returned substantive text but not parseable JSON with
  // a `post` field (matches the resilience pattern in newsGenerator.ts and
  // dispatchEngine.ts). Only fall back when we have enough raw material to
  // form a real post — otherwise surface the failure.
  const fallback = rawContent.trim();
  if (fallback.length > 30) {
    console.warn(
      `[Academy] JSON parse missing 'post' field — falling back to raw LLM text (model=${model}, len=${fallback.length})`,
    );
    return {
      post: fallback,
      dashboardNarrative: "",
      headline: "",
    };
  }

  console.error(
    `[Academy] LLM produced unusable content — model=${model}, finish_reason=${finishReason}, raw="${rawContent.slice(0, 200)}"`,
  );
  throw new AcademyGenerationError(
    `Academy: LLM produced unusable content (model=${model}, finish_reason=${finishReason ?? "unknown"}, raw_len=${rawContent.length})`,
    {
      model,
      promptLength,
      finishReason,
      rawLen: rawContent.length,
      rawSnippet: rawContent.slice(0, 200),
    },
  );
}

// ── Post to X ─────────────────────────────────────────────────────────────────
export async function postAcademyEpisode(xWrite: any): Promise<void> {
  if (!requestPost("academy")) return;

  const topic = pickNextTopic();
  console.log(`[Academy] Generating EP${state.totalEpisodes + 1}: "${topic.concept}" [${topic.track}]`);

  let generated: Awaited<ReturnType<typeof generateAcademyEpisode>>;
  try {
    generated = await generateAcademyEpisode(topic);
  } catch (e: any) {
    // Scheduler was previously silent on LLM failures — a 10am run could
    // skip with no on-disk trace. Log loudly with details so ops can see
    // *why* the scheduled run didn't produce a post.
    const details = e instanceof AcademyGenerationError ? e.details : {};
    console.error(
      `[Academy] Scheduled generation failed — topic="${topic.concept}" [${topic.track}]:`,
      e?.message ?? String(e),
      details,
    );
    // Advance the rotation pointer past the failing topic so the next
    // scheduled run (and any manual retry) picks a different topic.
    // Without this, a topic that repeatedly times out at the LLM (e.g.
    // the grok-4.20 reasoning-model timeout signature on "What is
    // reasoning in AI models?") keeps getting re-picked forever — the
    // "stuck on Episode 7" symptom. We do NOT advance totalEpisodes
    // because the public episode counter only counts successful posts.
    state.currentTopicIndex++;
    saveState(state);
    releasePost("academy");
    // Re-throw so engineRunWrapper records a non-ok run row instead of
    // a silent ok. Catch on the wrapper side keeps the schedule loop alive.
    throw e;
  }

  let tweetUrl: string | null = null;
  try {
    const postText = generated.post.trim();
    if (postText.length > 10) {
      // Academy content is internal-synthesis — no external URL source. The
      // verifier will pass posts that don't attribute claims (no "according
      // to X") and reject any that fabricate attributions without a source.
      const verdict = await verifyClaims({
        draftText:   postText,
        sourceText:  "",
        sourceUrl:   "",
        sourceTitle: `Academy: ${topic.concept}`,
        // PR #251 — short-form pedagogical post; Lane B bare soft-warns, Lane A still hard-fails.
        tier: "academy",
      });
      if (verdict.severity === "HARD_FAIL") {
        console.error(`[ClaimVerifier] REJECTED academy EP${state.totalEpisodes + 1}: ${verdict.unsupportedClaims.length} unsupported claims`);
        for (const c of verdict.unsupportedClaims) {
          console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
        }
        // Advance rotation pointer so a retry doesn't immediately re-pick
        // the same topic. Without this, every retry on a verifier-rejected
        // topic gets the same topic back. Same logic as the LLM-failure
        // branch above — see comment there for the "stuck" rationale.
        state.currentTopicIndex++;
        saveState(state);
        releasePost("academy");
        return;
      }
      queueXPost(postText, "academy", 6);
      console.log(`[Academy] EP${state.totalEpisodes + 1} queued for X posting`);
      tweetUrl = "queued"; // placeholder — actual URL assigned when scheduler posts
    }
  } catch (e: any) {
    console.error("[Academy] Queue failed:", e.message);
  }

  // Queue for Farcaster (parallel to X queue)
  let castQueued = false;
  try {
    const { queueFarcasterPost } = await import("./farcasterQueue.js");
    if (generated.post.trim().length > 10) {
      queueFarcasterPost(generated.post.trim().slice(0, 2500), "academy", undefined, "web3");
      castQueued = true;
      console.log(`[Academy] Farcaster cast queued`);
    }
  } catch (fcErr: any) {
    console.warn("[Academy] Farcaster queue failed:", fcErr.message);
  }

  if (!tweetUrl && !castQueued) {
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
      // Wrap the scheduled fire-time run in `runWrapped` so each run
      // writes a row to engine_runs (status running → ok | error). The
      // previous setTimeout(...catch console.error) path could swallow
      // generation failures with no on-disk trace — a 10am no-post left
      // ops with nothing to look at. The wrapper additionally ensures
      // the next-fire-time scheduling still happens whether the run
      // succeeded or crashed.
      try {
        const { runWrapped } = await import("./scheduler/engineRunWrapper.js");
        await runWrapped("academy", () => postAcademyEpisode(xWrite), { triggeredBy: "scheduler" });
      } catch (e: any) {
        // engineRunWrapper has its own try/catch but defensively keep one
        // here in case the dynamic import itself fails (e.g. db.ts boot
        // race) — the schedule loop must never die.
        console.error("[Academy] scheduled run wrapper failed:", e?.message ?? String(e));
      }
      scheduleNext();
    }, ms);
  }

  scheduleNext();
}

// ── On-demand generation (no side effects — just produces content) ────────────
//
// Throws AcademyGenerationError when the LLM fails or returns unusable content.
// The route handler (`/api/engines/:engineId/generate`) surfaces the error
// message verbatim so the operator sees the real cause (missing key, HTTP
// status, empty response, etc.) instead of a generic "LLM returned no content".
export async function generateAcademyContent(): Promise<{
  post: string;
  dashboardNarrative: string;
  headline: string;
  topic: { track: string; concept: string };
  episodeNumber: number;
}> {
  console.log("[Academy] On-demand generation triggered");
  const topic = pickNextTopic();
  const episodeNumber = state.totalEpisodes + 1;
  console.log(`[Academy] On-demand picked EP${episodeNumber}: "${topic.concept}" [${topic.track}]`);
  const result = await generateAcademyEpisode(topic);
  return { ...result, topic: { track: topic.track, concept: topic.concept }, episodeNumber };
}

// ── Operator escape hatch: skip a stuck topic ─────────────────────────────────
//
// When a topic repeatedly fails generation (model timeout, Lane B verifier
// rejection of synthetic content, etc.), the operator needs a way to advance
// past it without ever queuing a post. This records a synthetic
// "skipped" history entry so pickNextTopic treats the concept as covered.
// Wired to POST /api/academy/skip — it returns the next topic the next
// generate call will pick.
export function skipCurrentTopic(reason: string): { skipped: { track: string; concept: string }; nextTopic: { track: string; concept: string }; totalEpisodes: number; } {
  const skipped = pickNextTopic();
  state.episodeHistory.push({
    episodeNumber: state.totalEpisodes + 1,
    track: skipped.track,
    concept: skipped.concept,
    tweetUrl: null,
    postedAt: new Date().toISOString(),
    // NB: we deliberately do NOT increment totalEpisodes — skipped slots
    // don't count toward the public episode counter, but coveredConcepts
    // now includes the topic so pickNextTopic moves forward.
  });
  state.currentTopicIndex++;
  if (state.episodeHistory.length > 50) state.episodeHistory = state.episodeHistory.slice(-50);
  saveState(state);
  console.warn(`[Academy] SKIPPED topic "${skipped.concept}" [${skipped.track}] — reason: ${reason}`);
  const next = pickNextTopic();
  return {
    skipped: { track: skipped.track, concept: skipped.concept },
    nextTopic: { track: next.track, concept: next.concept },
    totalEpisodes: state.totalEpisodes,
  };
}
