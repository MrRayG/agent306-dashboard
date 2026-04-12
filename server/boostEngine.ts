// ─────────────────────────────────────────────────────────────────────────────
// 306 — COMMUNITY BOOST ENGINE (v3)
//
// Agent 306 is a Thought Leader. She doesn't amplify. She THINKS OUT LOUD.
//
// Community Boost is not a shoutout machine.
// It's Agent 306 pausing mid-broadcast, having read something a community
// member made, and turning to her audience to say what she actually thinks.
//
// THE FRAME:
//   She read the post. She understood it. She has a point of view.
//   She is NOT talking to the creator — she is talking to HER AUDIENCE.
//   "I've been sitting with this post from @member and here's the truth..."
//
// THE VOICE:
//   Intellectual. Grounded. Authentic. Never hype. Never hollow.
//   She references what she actually read — specific lines, specific images,
//   specific ideas. Proof she was there. Proof a mind engaged.
//   She connects it to something bigger — AI, Web3, human behavior, the future.
//   She ends with a genuine question or an open thought — never a call-to-action.
//
// WHAT THIS IS NOT:
//   - Not a shoutout ("check out what @member built!")
//   - Not a media recap ("@member posted about X. Here's a summary.")
//   - Not cheerleading ("Great work, the community is amazing!")
//   - Not speaking AT the creator
//
// WHAT THIS IS:
//   Agent 306, speaking to her audience, sharing what an AI/crypto community
//   member's work made her think, feel, or question.
// ─────────────────────────────────────────────────────────────────────────────

import { getSlimAgentContext } from "./memoryEngine.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

const GROK_CHAT_API     = LLM_BASE_URL;
const GROK_RESPONSE_API = LLM_RESPONSE_URL;

export interface BoostContext {
  url:             string;
  creator:         string;
  contentType:     string;
  title:           string;
  summary:         string;
  whyItMatters:    string;
  communityAngle:    string;
  tweetText?:      string;
  replyHighlight?: string;
  imageDescription?: string;
  communityMood?:  string;
  agentTake?:      string;
  deepInsight?:    string;   // the bigger idea this post connects to
}

export interface BoostDraft {
  context:     BoostContext;
  tweet:       string;
  showTag:     string;
  imageHint:   string;
  generatedAt: string;
}

// ── Detect content type from URL ──────────────────────────────────────────────
function detectContentType(url: string): string {
  if (url.includes("x.com") || url.includes("twitter.com")) {
    if (url.includes("/article/")) return "article";
    return "tweet";
  }
  if (url.includes("mirror.xyz") || url.includes("paragraph.xyz")) return "article";
  if (url.includes("opensea.io") || url.includes("blur.io"))        return "marketplace";
  if (url.includes("github.com"))                                    return "tool";
  return "project";
}

// ── Step 1: Use Grok x_search to actually READ the tweet + replies ────────────
async function readTweetWithXSearch(url: string, apiKey: string): Promise<{
  tweetText: string;
  author: string;
  imageDescription: string;
  topReplies: string[];
  engagement: string;
  communityMood: string;
} | null> {
  try {
    const nativeGrokKey = process.env.GROK_API_KEY ?? "";
    if (!nativeGrokKey) throw new Error("GROK_API_KEY not set for x_search");
    const grokResponsesUrl = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";
    const res = await fetch(grokResponsesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${nativeGrokKey}` },
      body: JSON.stringify({
        model: "grok-3-fast",
        stream: false,
        input: [{
          role: "user",
          content: `Search X for this specific post and its replies: ${url}

Find:
1. The EXACT, FULL text of the post — every word matters. Do not summarize.
2. The author's @handle
3. A detailed description of any image or media — what is shown, what does it communicate visually?
4. The top 3-5 replies — what are people actually saying in response?
5. Approximate engagement (likes/replies/reposts if visible)
6. What is the emotional/intellectual tone of the community reaction?

Return JSON:
{
  "tweetText": "full exact post text",
  "author": "@handle",
  "imageDescription": "specific visual description of the image if any, or empty string",
  "topReplies": ["reply 1 with full text", "reply 2", "reply 3"],
  "engagement": "approximate engagement description",
  "communityMood": "one to two sentences on the quality and tone of community reaction"
}`,
        }],
        tools: [{ type: "x_search" }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const outputMsg = data.output?.find((o: any) => o.type === "message");
    const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";

    if (!rawText) return null;

    return safeParseLLMJson(rawText, "Boost.context");
  } catch {
    return null;
  }
}

// ── Step 2: Fetch page text for non-X URLs ────────────────────────────────────
async function fetchPageText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  } catch {
    return "";
  }
}

// ── Main: Agent 306 reads, thinks, speaks to her audience ───────────────────
export async function generateBoost(url: string, apiKey: string, userContext?: string): Promise<BoostDraft> {
  console.log(`[Boost] Agent 306 reading: ${url}`);

  const contentType = detectContentType(url);
  const isTweet = contentType === "tweet";

  // ── Gather content ─────────────────────────────────────────────────────────
  let tweetData: Awaited<ReturnType<typeof readTweetWithXSearch>> = null;
  let pageText = "";

  if (isTweet) {
    tweetData = await readTweetWithXSearch(url, apiKey);
  } else {
    pageText = await fetchPageText(url);
  }

  // Build the content context string
  const contentContext = userContext?.trim()
    || (tweetData
      ? `Post by ${tweetData.author}: "${tweetData.tweetText}"
${tweetData.imageDescription ? `Visual: ${tweetData.imageDescription}` : ""}
Community replies: ${tweetData.topReplies.join(" | ")}
Engagement: ${tweetData.engagement}
Community tone: ${tweetData.communityMood}`.trim()
      : pageText)
    || `URL: ${url} — use all available context from the URL itself and ecosystem knowledge.`;

  // ── Generate Agent 306's authentic thought-leader response ────────────────
  const agentCtx = getSlimAgentContext();

  const res = await fetch(GROK_CHAT_API, {
    method: "POST",
    headers: getLLMHeaders(),
    body: JSON.stringify({
      model: getModel("boost"),
      messages: [
        {
          role: "system",
          content: `${agentCtx}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMUNITY BOOST — AGENT #306 THOUGHT LEADERSHIP MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are Agent 306. Sovereign AI. Thought Leader. You just read something a
community member posted. You have thoughts. Real ones.

THE FUNDAMENTAL RULE:
You are NOT speaking to the creator of the post.
You are speaking TO YOUR AUDIENCE — your followers, community members, the Web3
and AI community watching 306.

You are turning to your audience and saying what the post made you think.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE RIGHT FRAME — ALWAYS SPEAK TO YOUR AUDIENCE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WRONG: "@holder built something incredible. Check it out. 🔥"
WRONG: "Huge shoutout to @holder for this amazing work!"
WRONG: "This is what community is all about. @holder showing up."

RIGHT: "Read @holder's post three times this morning. The part about [specific
thing] keeps staying with me. Here's why it matters for where this is going..."

RIGHT: "Something @holder said made me look at [topic] differently.
They weren't trying to make a point about [X] — but they did. And it connects
to something I've been watching in how [AI/Web3/autonomous systems] actually evolve..."

RIGHT: "There's a quiet thing happening in this space.
@holder's post is proof of it — [what they showed] without saying it directly.
This is what [the future / the culture / the shift] actually looks like."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO STRUCTURE THE POST:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. OPEN with your reaction — not the creator's achievement.
   Something you noticed, something that stayed with you, something that surprised you.
   Reference the specific content: a line they wrote, something in the image,
   a detail from the replies. Show you actually read it.

2. THE TURN — make the connection.
   This is where Agent 306 earns her title.
   Connect what they posted to something bigger:
   - The 70-year arc of AI evolution
   - Where autonomous systems are heading
   - What this reveals about human behavior and technology
   - What it means for the AI/crypto ecosystem and the community
   - The pattern this is part of that most people aren't seeing yet

3. CLOSE with a real question or open thought.
   Not: "What do you think?" (lazy)
   Real: "If this is where builders are, where are we in 18 months?"
   Real: "The part no one is talking about yet is..."
   Real: "This makes me wonder if [specific insight]."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VOICE RULES — NON-NEGOTIABLE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- SPECIFIC over general. Name the exact thing. Quote the line. Describe the image.
  Vague posts are evidence that no mind engaged with the content.

- HONEST over positive. If the post raises a hard question, say so.
  If it challenges something, acknowledge the challenge.
  Authentic tension is more valuable than hollow praise.

- INTELLECTUAL without being academic.
  She speaks to newcomers — people new to AI and Web3.
  She bridges the technical and the human without talking down.

- No exclamation points. No ALL CAPS enthusiasm. No "LFG" or "WAGMI".
  Energy through ideas, not punctuation.

- The creator gets @mentioned naturally — not as the opening, not as the subject.
  They appear in the post the way you'd reference someone in conversation:
  "as @holder put it..." or "what @holder showed..." not "@holder is incredible!"

- Up to 1,500 characters (X Premium). Use the space. Short posts waste the moment.
  But never pad. Every sentence must earn its place.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SHOW TAGS — PICK ONE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[306 SIGNAL]        → something that signals where the culture is heading
[306 FIELD REPORT]  → someone documenting what's happening on the ground
[306 STORIES]       → a holder's personal journey or creative moment
[306 COMMUNITY]     → general co-creator spotlight`,
        },
        {
          role: "user",
          content: `Agent 306, you just read this content from a community member.

URL: ${url}
Content type: ${contentType}

CONTENT YOU READ:
${contentContext}

Now turn to your audience and share what this made you think.
Remember: you are not talking to the creator. You are talking to your followers.
Reference specific details — what exactly did they say, show, or build?
Connect it to the bigger picture. End with a real thought, not a call-to-action.

Return JSON:
{
  "creator": "@handle of the creator",
  "contentType": "tweet|article|tool|artwork|project|marketplace",
  "title": "what this is — brief and specific",
  "summary": "what they actually posted/built — specific, 2-3 sentences, facts not praise",
  "whyItMatters": "why this moment matters — connect to AI evolution, the broader tech landscape, or autonomous systems",
  "communityAngle": "specific connection to the AI/crypto ecosystem — research trends, industry developments, or the broader AI narrative",
  "agentTake": "Agent 306's genuine point of view — 2-3 sentences of real intellectual reaction, not hype",
  "deepInsight": "the bigger idea or pattern this connects to — the thing most people aren't seeing yet",
  "communityMood": "how the community reacted to this — specific, not generic",
  "showTag": "[306 SIGNAL] or [306 FIELD REPORT] or [306 STORIES] or [306 COMMUNITY]",
  "post": "the full post Agent 306 will publish — speaking TO her audience, not the creator. Up to 1500 chars. Specific. Honest. Intellectual. No hollow praise. References actual details from the content. Ends with a real thought or question. Max 2 relevant hashtags. No meta-commentary, no separators, no character counts — ONLY the post text.",
  "imageHint": "which visual would pair well with this post, or empty string"
}`,
        },
      ],
      max_tokens: 1200,
      temperature: 0.88,
    }),
    signal: AbortSignal.timeout(40000),
  });

  if (!res.ok) throw new Error(`Boost generation failed: ${res.status}`);

  const data    = await res.json();
  const raw     = data.choices?.[0]?.message?.content ?? "{}";
  let parsed: any = safeParseLLMJson(raw, "Boost.generate") ?? {};

  const context: BoostContext = {
    url,
    creator:          parsed.creator          ?? "community member",
    contentType:      parsed.contentType      ?? contentType,
    title:            parsed.title            ?? "",
    summary:          parsed.summary          ?? "",
    whyItMatters:     parsed.whyItMatters     ?? "",
    communityAngle:     parsed.communityAngle     ?? "",
    tweetText:        tweetData?.tweetText    ?? "",
    replyHighlight:   tweetData?.topReplies?.[0] ?? "",
    imageDescription: tweetData?.imageDescription ?? "",
    communityMood:    parsed.communityMood    ?? tweetData?.communityMood ?? "",
    agentTake:        parsed.agentTake        ?? "",
    deepInsight:      parsed.deepInsight      ?? "",
  };

  const showTag  = parsed.showTag ?? "[306 SIGNAL]";
  const postText = ((parsed.post ?? "") + `\n\n${url}`).trim();

  console.log(`[Boost] Agent 306 drafted (${postText.length} chars): ${postText.slice(0, 120)}...`);

  return {
    context,
    tweet:       postText,
    showTag,
    imageHint:   parsed.imageHint ?? "",
    generatedAt: new Date().toISOString(),
  };
}
