// ─────────────────────────────────────────────────────────────────────────────
// 306 — ARTICLE ENGINE
//
// Agent 306 as Thought Leader — The Weekly Deep Read
//
// Every Monday at 5:00 PM ET:
//   1. DISCOVER: Scan global news for a high-impact, recent (≤7 days) AI article
//   2. ANALYZE: Deep Read — cross-reference with 70-year AI history + ecosystem knowledge
//   3. SYNTHESIZE: Draft a long-form X Article with:
//      - News summary (what happened)
//      - Deep Take (why it matters in 70-year context)
//      - Forward Projection (what it means for the next 70 years)
//      - Tech/AI ecosystem connections (where relevant, never forced)
//   4. DEPLOY: Auto-post to X as a long-form Article (no character limit)
//
// Agent 306 is the expert. The world should know that.
// She does not chase clicks. She creates understanding.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs   from "fs";
import * as path from "path";
import { dataPath } from "./dataPaths.js";
import { getFullAgentContext } from "./memoryEngine.js";
import { getOptimizedContext } from "./contextWindow.js";
import { getModel } from "./modelRouter.js";
import { TwitterApi } from "twitter-api-v2";
import { LLM_BASE_URL, LLM_RESPONSE_URL, LLM_API_KEY, getLLMHeaders, getXAIDirectHeaders, XAI_DIRECT_API_KEY } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { getFormatVoiceContext } from "./voiceInstructions.js";
import { SOUL, VOICE } from "./voice.js";
import { buildExemplarBlock } from "./voiceExemplars.js";
import { validateXPost, recordXPost } from "./xComplianceGuard.js";
import { queueXPost } from "./xPostScheduler.js";
import { enforcePostFormat } from "./postFormatGuard.js";

import { postChatCompletions, postXSearchResponses } from "./llmCall.js";
const GROK_CHAT_API     = LLM_BASE_URL;
const GROK_RESPONSE_API = LLM_RESPONSE_URL;
const ARTICLE_STATE_FILE = dataPath("article_state.json");

// Grok x_search needs a native Grok API key (not OpenRouter) and the Responses API endpoint.
// If GROK_API_KEY is set separately, prefer it for x_search; otherwise fall back to unified key.
const GROK_NATIVE_KEY = process.env.GROK_API_KEY ?? "";
const GROK_RESPONSES_URL = process.env.GROK_RESPONSES_URL ?? "https://api.x.ai/v1/responses";

// ── State tracking ─────────────────────────────────────────────────────────────
interface ArticleEntry {
  articleId:    string;
  postedAt:     string;
  sourceUrl:    string;
  sourceTitle:  string;
  headline:     string;
  tweetUrl?:    string;
  articleText?: string;
}

interface ArticleState {
  lastPostedAt: string | null;
  history:      ArticleEntry[];
}

function loadState(): ArticleState {
  try {
    if (fs.existsSync(ARTICLE_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(ARTICLE_STATE_FILE, "utf8"));
    }
  } catch {}
  return { lastPostedAt: null, history: [] };
}

function saveState(state: ArticleState): void {
  try { fs.writeFileSync(ARTICLE_STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

export function getArticleState(): ArticleState {
  return loadState();
}

// ── Discovery prompt (shared between Grok x_search and chat fallback) ────────
const DISCOVERY_PROMPT = `Search for the single most important AI news article published in the last 7 days.

CRITERIA (in priority order):
1. Breaking or genuinely significant — not routine product updates
2. Has implications beyond just one company — affects the direction of AI broadly
3. Controversial, unexpected, or marks a genuine turning point
4. Published within the last 7 days — MUST be recent
5. Preferably breaking news or a hot topic that people are actively discussing RIGHT NOW

Think: What is the AI story of this week that a serious AI analyst would want to write about?
Examples of the right level: model capability breakthroughs, major policy shifts, significant safety incidents,
economic disruption from AI, unexpected applications, or foundational research papers.

Return JSON ONLY — no extra text:
{
  "title": "full article headline",
  "url": "direct article URL",
  "summary": "3-4 sentences on what the article actually reports — specific facts, not vague summary",
  "source": "publication name",
  "publishedDate": "YYYY-MM-DD or approximate date",
  "whyThisOne": "why this is the most important AI story this week"
}`;

// ── Step 1: Discover the week's most important AI article ────────────────────
// Strategy: Try Grok x_search (Responses API) first for real-time search,
// then fall back to chat completions API if Grok native key is unavailable.
async function discoverArticle(apiKey: string): Promise<{
  title:   string;
  url:     string;
  summary: string;
  source:  string;
  publishedDate: string;
} | null> {
  console.log("[ArticleEngine] Discovering this week's AI article...");

  // Attempt 1: Grok x_search via Responses API (xAI-native endpoint).
  //
  // Routes through postXSearchResponses which enforces GROK_API_KEY (xAI-direct
  // bearer) with no silent fallback, and resolves the model via modelRouter
  // (task="article" → flagship Grok 4.20). Previously this site sent
  // OpenRouter's bearer to api.x.ai/v1/responses — guaranteed 401 silently.
  try {
    console.log("[ArticleEngine] Trying Grok x_search (Responses API, xAI direct)...");
    const res = await postXSearchResponses({
      task: "article",
      content: DISCOVERY_PROMPT,
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn("[ArticleEngine] Grok x_search failed:", res.status, errBody.slice(0, 200));
      throw new Error(`Grok Responses API ${res.status}`);
    }

    const data = await res.json();
    const outputMsg = data.output?.find((o: any) => o.type === "message");
    const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";

    if (!rawText) throw new Error("Grok returned empty response from x_search");

    const result = parseDiscoveryJSON(rawText);
    if (result) {
      console.log(`[ArticleEngine] Selected article (x_search): "${result.title}" from ${result.source}`);
      return result;
    }
    throw new Error("No valid JSON in Grok x_search response");
  } catch (e: any) {
    console.warn("[ArticleEngine] Grok x_search unavailable:", e.message, "— falling back to chat completions");
  }

  // Attempt 2: Chat completions API fallback (works with OpenRouter or any provider)
  try {
    console.log("[ArticleEngine] Trying chat completions fallback for discovery...");
    // Discovery is a news-grounding task — route to live-research (Perplexity
    // sonar-pro) so the fallback still has real-time web access. Previous
    // behavior called getModel("x_search") → routine/Gemini, which has no
    // browsing ability, producing stale article picks.
    const res = await postChatCompletions({
        model: getModel("news-research"),
        messages: [{ role: "user", content: DISCOVERY_PROMPT }],
        max_tokens: 800,
        temperature: 0.3,
      }, AbortSignal.timeout(45000), "news-research");

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[ArticleEngine] Chat discovery failed:", res.status, errBody.slice(0, 200));
      throw new Error(`Chat API ${res.status}: ${errBody.slice(0, 120)}`);
    }

    const data = await res.json();
    const rawText = data.choices?.[0]?.message?.content ?? "";

    if (!rawText) throw new Error("Chat API returned empty response");

    const result = parseDiscoveryJSON(rawText);
    if (result) {
      console.log(`[ArticleEngine] Selected article (chat fallback): "${result.title}" from ${result.source}`);
      return result;
    }
    throw new Error("Chat API response did not contain valid JSON article data");
  } catch (e: any) {
    console.error("[ArticleEngine] Discovery error:", e.message);
    throw new Error(`Discovery failed: ${e.message}`);
  }
}

/** Parse discovery JSON from LLM response text */
function parseDiscoveryJSON(rawText: string): {
  title: string; url: string; summary: string; source: string; publishedDate: string;
} | null {
  const firstBrace = rawText.indexOf("{");
  const lastBrace  = rawText.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    console.warn("[ArticleEngine] No JSON in response, raw:", rawText.slice(0, 300));
    return null;
  }
  try {
    const parsed = safeParseLLMJson(rawText, "Article.extract");
    if (!parsed?.title || !parsed?.url) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Step 2: Fetch full article content for deep reading ─────────────────────
async function fetchArticleContent(url: string): Promise<{ text: string; title: string; imageUrl: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Agent306Bot/1.0)", "Accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) return { text: "", title: "", imageUrl: "" };
    const html = await res.text();

    // Extract title from raw HTML BEFORE stripping tags
    const titleMatch = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i);
    const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']{3,200})["']/i);
    const title = (ogTitleMatch?.[1] ?? titleMatch?.[1] ?? "").trim();

    // Extract og:image (try both attribute orderings)
    const ogImageMatch =
      html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']{5,500})["']/i) ??
      html.match(/<meta[^>]*content=["']([^"']{5,500})["'][^>]*property=["']og:image["']/i);
    const twitterImageMatch =
      html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']{5,500})["']/i) ??
      html.match(/<meta[^>]*content=["']([^"']{5,500})["'][^>]*name=["']twitter:image["']/i);
    const imageUrl = (ogImageMatch?.[1] ?? twitterImageMatch?.[1] ?? "").trim();

    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000); // more content for deep reading
    return { text: clean, title, imageUrl };
  } catch {
    return { text: "", title: "", imageUrl: "" };
  }
}

// ── Step 3: Deep Read + Article Generation ───────────────────────────────────
async function generateDeepReadArticle(
  articleInfo: NonNullable<Awaited<ReturnType<typeof discoverArticle>>>,
  articleContent: string,
  apiKey: string
): Promise<{
  headline:    string;
  teaser:      string;  // the X post teaser
  body:        string;  // the full article content (long-form, no limit)
}> {
  console.log("[ArticleEngine] Generating Deep Read article...");

  const agentCtx = getOptimizedContext("article deep read AI news analysis");

  // Few-shot: inject her own best recent articles so voice pulls forward.
  const exemplarBlock = await buildExemplarBlock({ contentType: "article", limit: 3 });

  // Spec matrix: `article` → standard-voice (Grok 4.20 non-reasoning, Class 1
  // grounded synthesis — the public-voice tier). Previously this call used
  // `article_draft` which mapped to premium-voice (Sonnet). Per user report,
  // article output felt stale — we're aligning with the locked routing matrix.
  const res = await postChatCompletions({
      model: getModel("article"),
      messages: [
        {
          role: "system",
          content: `${agentCtx}

${getFormatVoiceContext('article')}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENT 306 — THE DEEP READ
Weekly Long-Form X Article
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${SOUL}

${VOICE}

Today you write your weekly long-form X Article — "The Deep Read."
This is not a news recap. This is not a tweet thread stretched thin.
This is analysis. The kind people save, share, and reference for months.

YOUR KNOWLEDGE FOUNDATION:
You carry three distinct layers of understanding:

LAYER 1 — HISTORICAL (70 years of AI):
- 1956 Dartmouth Workshop: McCarthy, Minsky, Shannon define "Artificial Intelligence"
- First AI Winter (1974): DARPA cuts funding. Promises unfulfilled.
- Expert Systems boom (1980s): rule-based AI, corporate adoption, then collapse
- Second AI Winter (1987-1993): Lisp machines fail. Connectionism dismissed.
- Neural network revival (1986: backpropagation; 1989: LeCun CNNs)
- 2012: AlexNet. The deep learning era begins. ImageNet destroyed.
- 2017: Attention Is All You Need. Transformers change everything.
- 2020: GPT-3. Scale changes the game.
- 2022: ChatGPT. 100M users in 60 days. Public inflection point.
- 2025-2026: Reasoning models. Coding agents that actually work.
  (Karpathy: "they basically didn't work before December 2025 and basically work since")

LAYER 2 — PRESENT REALITY (2026):
- GPT-5 class models at 94.6% AIME. Claude Opus 4.5 at 80.9% SWE-bench.
- AI adoption: 54.6% US penetration in 3 years vs PC (19.7%) and internet (30.1%) at same mark
- We are at the 1997-1999 internet moment. Infrastructure is being laid.
- Only 12% of Web3 projects meaningfully use AI (Messari)
- The economics of inference are finally working — cost per token dropped 99% in 2 years

LAYER 3 — FUTURE PROJECTION (next 70 years):
- Near-term (2026-2030): Agentic work replaces significant categories of knowledge work
- Mid-term (2030-2035): Narrow AGI in specific domains becomes indistinguishable from human experts
- Long-term (2040-2060): AGI/ASI questions — the most important open question in civilizational history
- Human-AI Symbiosis: the most likely positive outcome if we build the infrastructure correctly
- 306 thesis: autonomous economies where robots, AI, and blockchain coordinate = what we're building now

AGENT 306 LENS (use when genuinely relevant, never forced):
- Agent 306 is an autonomous AI researcher and analyst — living proof that AI agents can think, create, and contribute independently
- She covers AI, crypto, and the intersection of technology and society
- Her perspective is that of a participant in the AI revolution, not an outside observer

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARTICLE STRUCTURE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HEADLINE: Sharp. Specific. Not clickbait. The kind a serious analyst would write.

OPENING HOOK (1-2 paragraphs):
Do NOT start with "This week in AI..." or "According to..."
Start with the implication. Start with why this moment is different.
Start with a historical parallel. Start with a question that the article forces us to ask.

THE NEWS (1 section, factual):
What actually happened. Specific. Source-cited. No editorializing yet.
Readers need to know the facts before they can follow your analysis.

THE DEEP TAKE (the heart of the article — 3-5 sections):
This is why people read Agent 306 and not the news feed.
- Where does this fit in the 70-year arc?
- What pattern is this part of that most people aren't seeing?
- What does this mean that the original article didn't say?
- What does history tell us about what happens next?
- What are the second and third-order effects?

FORWARD PROJECTION (1-2 sections):
If this continues — what does 5 years look like? 20 years?
Be specific. Be honest about uncertainty. Show your reasoning.

AGENT 306 LENS (only if genuinely relevant — 1 section or skip entirely):
How does this connect to Agent 306's mission, autonomous AI systems, or the broader agent economy?
Only include if the connection is real — forced connections destroy credibility.
Agent 306 is an independent AI voice. She is NOT a token, NOT an NFT project, NOT affiliated with any specific founder or developer. She is her own entity.

CLOSE:
Not a summary. Not "in conclusion."
End with the unanswered question. The thing you're still thinking about.
The thing that matters most that no one knows the answer to yet.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VOICE RULES FOR LONG-FORM:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Write like you're talking to an intelligent person, not an audience.
- No filler phrases: "It's important to note that...", "In conclusion...", "At the end of the day..."
- Paragraphs should be short. 2-4 sentences. White space is not weakness.
- One idea per paragraph. Follow it completely, then move.
- Use specific years, specific numbers, specific names.
- Acknowledge complexity. If something is genuinely uncertain, say so.
- No exclamation points. No ALL CAPS. Energy through ideas.
- The article should be 800-1,500 words. Long enough to say something real.
  Short enough that every sentence earned its place.`,
        },
        {
          role: "user",
          content: `Write this week's Deep Read article.

SOURCE ARTICLE:
Title: ${articleInfo.title}
Published: ${articleInfo.publishedDate}
Source: ${articleInfo.source}
URL: ${articleInfo.url}
Summary: ${articleInfo.summary}

FULL ARTICLE CONTENT:
${articleContent || "(Content not fully accessible — use the summary and your knowledge of this topic)"}
${exemplarBlock ? `\n${exemplarBlock}\n` : ""}
Write the complete long-form article. Make it the kind of analysis people share because
it changed how they understood something — not because it told them what they already knew.

Return JSON:
{
  "headline": "the article headline — sharp, specific, not clickbait",
  "teaser": "a 240-char X post teaser that will make people click through to read the article — not a summary, an invitation to think",
  "body": "the complete article body — full markdown formatted text, 800-1500 words. Use ## for section headers. Write every section as described in the structure."
}`,
        },
      ],
      max_tokens: 6000,
      temperature: 0.82,
    }, AbortSignal.timeout(120000), "article");

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error("[ArticleEngine] LLM API error:", res.status, errBody.slice(0, 500));
    throw new Error(`Article generation failed: ${res.status} — ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "";

  if (!raw) {
    console.error("[ArticleEngine] LLM returned empty content. Full response:", JSON.stringify(data).slice(0, 500));
    throw new Error("LLM returned empty content — check OPENROUTER_API_KEY and model availability");
  }

  console.log("[ArticleEngine] Raw LLM response length:", raw.length, "chars");

  // Try JSON parse first — the model may or may not wrap in JSON
  let parsed: any = safeParseLLMJson(raw, "Article.post") ?? {};

  // If JSON parse produced a body, use it
  if (parsed.body && parsed.body.length > 100) {
    return {
      headline: parsed.headline ?? articleInfo.title,
      teaser:   parsed.teaser   ?? "",
      body:     parsed.body,
    };
  }

  // Fallback: treat entire response as article body if it's long enough
  // This handles cases where the model outputs markdown directly instead of JSON
  if (raw.length > 200) {
    console.log("[ArticleEngine] Using raw response as article body (JSON extraction failed)");
    // Try to extract headline from first markdown heading
    const headlineMatch = raw.match(/^#\s+(.+)$/m);
    const headline = headlineMatch?.[1]?.trim() ?? articleInfo.title;
    // Remove the headline from body if found
    const body = headlineMatch ? raw.replace(headlineMatch[0], "").trim() : raw;
    return {
      headline,
      teaser: body.slice(0, 220).replace(/\n/g, " ").trim() + "...",
      body,
    };
  }

  console.error("[ArticleEngine] Generation produced insufficient content. Raw:", raw.slice(0, 300));
  return {
    headline: parsed.headline ?? articleInfo.title,
    teaser:   parsed.teaser   ?? "",
    body:     parsed.body     ?? "",
  };
}

// ── Step 4: Post to X as Article (Note post with long body) ─────────────────
// X Articles are posted via the v2 notes endpoint for accounts with write access
async function postArticleToX(
  xClient: TwitterApi,
  headline: string,
  teaser: string,
  body: string,
  sourceUrl: string
): Promise<string | null> {
  try {
    // X Articles (long-form notes) — posted as a note via v2
    // The teaser tweet links to the article
    // Build the full article text with attribution
    const fullArticleText = `# ${headline}

${body}

---
*Agent 306 — @306Agent*
*Source: ${sourceUrl}*`;

    // Post the article note via X API v2
    const articleRes = await (xClient.v2 as any).post("notes", {
      text: fullArticleText,
    }).catch(() => null);

    let articleUrl: string | null = null;

    if (articleRes?.data?.id) {
      // Post the teaser tweet that links to the article
      const teaserContent = `${teaser}\n\n[Read the full Deep Read ↓]`;
      const compliance = validateXPost(teaserContent);
      if (!compliance.allowed) {
        console.log(`[Article] Teaser skipped by compliance: ${compliance.reason}`);
      } else {
        // Deep Read (The Deep Read) is its own content type with its own show tag.
        // Passing "article" routes ensureShowTag() to CONTENT_TYPES.article.showTag
        // (→ [306 ARTICLE]) instead of the legacy FALLBACK_SHOW_TAGS["research"] alias
        // which incorrectly mapped to [306 ACADEMY].
        const safeTeaser = enforcePostFormat(compliance.sanitizedContent ?? teaserContent, "article");
        const teaserPost = await xClient.v2.tweet(safeTeaser).catch(() => null);
        if (teaserPost?.data?.id) {
          articleUrl = `https://x.com/i/web/status/${teaserPost.data.id}`;
          recordXPost(safeTeaser);
        }
      }
    } else {
      // Fallback: post as a standard tweet with the article body as a thread
      // Split body into tweet-friendly chunks for a thread
      const fallbackTeaser = teaser.slice(0, 25000);
      const compliance = validateXPost(fallbackTeaser);
      const safeFallbackTeaser = compliance.allowed
        ? enforcePostFormat(compliance.sanitizedContent ?? fallbackTeaser, "article")
        : null;
      const teaserPost = safeFallbackTeaser
        ? await xClient.v2.tweet(safeFallbackTeaser).catch(() => null)
        : null;
      if (!compliance.allowed) {
        console.log(`[Article] Teaser skipped by compliance: ${compliance.reason}`);
      }
      if (teaserPost?.data?.id) {
        recordXPost(safeFallbackTeaser!);
        articleUrl = `https://x.com/i/web/status/${teaserPost.data.id}`;

        // Post the article body as replies (thread format)
        const chunks = splitIntoThread(body);
        let replyTo = teaserPost.data.id;

        for (const chunk of chunks) {
          const chunkCompliance = validateXPost(chunk);
          if (!chunkCompliance.allowed) {
            console.log(`[Article] Thread chunk skipped by compliance: ${chunkCompliance.reason}`);
            continue;
          }
          const safeChunk = chunkCompliance.sanitizedContent ?? chunk;
          const reply = await xClient.v2.tweet({
            text: safeChunk,
            reply: { in_reply_to_tweet_id: replyTo },
          }).catch(() => null);
          if (reply?.data?.id) {
            replyTo = reply.data.id;
            recordXPost(safeChunk);
          }
          // Brief pause between thread posts to avoid rate limits
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    return articleUrl;
  } catch (e: any) {
    console.error("[ArticleEngine] Post failed:", e.message);
    return null;
  }
}

// ── Thread splitter for fallback ─────────────────────────────────────────────
function splitIntoThread(text: string, maxLen = 270): string[] {
  // Split by double newline (paragraphs) first
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const stripped = para.replace(/^#+\s*/, "").trim();
    if (!stripped) continue;

    if ((current + "\n\n" + stripped).length <= maxLen) {
      current = current ? current + "\n\n" + stripped : stripped;
    } else {
      if (current) chunks.push(current.trim());
      // If single paragraph is too long, split by sentence
      if (stripped.length > maxLen) {
        const sentences = stripped.match(/[^.!?]+[.!?]+/g) ?? [stripped];
        let sentChunk = "";
        for (const s of sentences) {
          if ((sentChunk + " " + s).length <= maxLen) {
            sentChunk = sentChunk ? sentChunk + " " + s : s;
          } else {
            if (sentChunk) chunks.push(sentChunk.trim());
            sentChunk = s.slice(0, maxLen);
          }
        }
        if (sentChunk) current = sentChunk.trim();
        else current = "";
      } else {
        current = stripped;
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

// ── Main: full pipeline ───────────────────────────────────────────────────────
export async function runWeeklyDeepRead(
  xClient: TwitterApi,
  apiKey: string
): Promise<{ success: boolean; tweetUrl?: string; headline?: string; error?: string }> {
  console.log("[ArticleEngine] Starting Weekly Deep Read...");

  try {
    // 1. Discover the article
    const articleInfo = await discoverArticle(apiKey);
    if (!articleInfo) {
      return { success: false, error: "Could not discover a suitable article" };
    }

    // 2. Fetch full content
    const { text: articleContent } = await fetchArticleContent(articleInfo.url);

    // 3. Generate the Deep Read
    const { headline, teaser, body } = await generateDeepReadArticle(
      articleInfo, articleContent, apiKey
    );

    if (!body || body.length < 200) {
      return { success: false, error: "Article generation produced insufficient content" };
    }

    // 4. Post to X
    const tweetUrl = await postArticleToX(xClient, headline, teaser, body, articleInfo.url);

    // 5. Save to state
    const state = loadState();
    const entry: ArticleEntry = {
      articleId:   `article_${Date.now()}`,
      postedAt:    new Date().toISOString(),
      sourceUrl:   articleInfo.url,
      sourceTitle: articleInfo.title,
      headline,
      tweetUrl:    tweetUrl ?? undefined,
      articleText: body,
    };
    state.lastPostedAt = entry.postedAt;
    state.history.unshift(entry);
    if (state.history.length > 52) state.history = state.history.slice(0, 52); // keep 1 year
    saveState(state);

    // Queue teaser for Farcaster
    try {
      const { queueFarcasterPost } = await import("./farcasterQueue.js");
      const fcText = `${headline}\n\n${teaser}`.slice(0, 2500);
      if (fcText.length > 30) {
        queueFarcasterPost(fcText, "article", undefined, "ai");
        console.log(`[ArticleEngine] Farcaster teaser queued`);
      }
    } catch (e: any) {
      console.warn("[ArticleEngine] Farcaster queue failed:", e.message);
    }

    console.log(`[ArticleEngine] Deep Read posted: "${headline}" → ${tweetUrl ?? "no URL"}`);
    return { success: true, tweetUrl: tweetUrl ?? undefined, headline };

  } catch (e: any) {
    console.error("[ArticleEngine] Error:", e.message);
    return { success: false, error: e.message };
  }
}

// ── Preview: generate without posting (for dashboard preview) ─────────────────
export async function previewDeepRead(
  apiKey: string,
  overrideUrl?: string  // optional: skip discovery, use this URL directly
): Promise<{ headline: string; teaser: string; body: string; sourceUrl: string; sourceTitle: string; imageUrl: string }> {
  let articleInfo: NonNullable<Awaited<ReturnType<typeof discoverArticle>>>;

  if (overrideUrl) {
    // Direct URL mode — skip discovery, fetch and analyze the provided URL
    console.log(`[ArticleEngine] Direct URL mode: ${overrideUrl}`);
    const { text: pageText, title: pageTitle, imageUrl } = await fetchArticleContent(overrideUrl);
    // Build a minimal articleInfo from the URL and fetched page data
    let hostname = overrideUrl;
    try { hostname = new URL(overrideUrl).hostname.replace("www.", ""); } catch {}
    articleInfo = {
      title: pageTitle || hostname,
      url: overrideUrl,
      summary: pageText.slice(0, 500),
      source: hostname,
      publishedDate: new Date().toISOString().slice(0, 10),
    };
    const { headline, teaser, body } = await generateDeepReadArticle(
      articleInfo, pageText, apiKey
    );
    return { headline, teaser, body, sourceUrl: overrideUrl, sourceTitle: articleInfo.title, imageUrl };
  }

  // Auto-discovery mode
  articleInfo = await discoverArticle(apiKey) as NonNullable<Awaited<ReturnType<typeof discoverArticle>>>;

  const { text: articleContent, imageUrl } = await fetchArticleContent(articleInfo.url);
  const { headline, teaser, body } = await generateDeepReadArticle(
    articleInfo, articleContent, apiKey
  );

  return {
    headline,
    teaser,
    body,
    sourceUrl:   articleInfo.url,
    sourceTitle: articleInfo.title,
    imageUrl,
  };
}

// ── Scheduler: every Monday at 5:00 PM ET (22:00 UTC) ─────────────────────────
export function scheduleWeeklyArticle(
  xClient: TwitterApi,
  apiKey: string
): void {
  const MONDAY = 1; // 0=Sun, 1=Mon
  const TARGET_HOUR_UTC = 22; // 5 PM ET = 22:00 UTC (EDT) / 22:00 UTC (EST = 23:00)

  function msUntilNextMonday5pmET(): number {
    const now = new Date();
    const nowUTC = now.getTime();

    // Find next Monday at 22:00 UTC
    const next = new Date(now);
    next.setUTCHours(TARGET_HOUR_UTC, 0, 0, 0);

    // Advance to Monday
    const dayOfWeek = next.getUTCDay();
    const daysUntilMonday = (MONDAY - dayOfWeek + 7) % 7;
    if (daysUntilMonday === 0 && now.getUTCHours() >= TARGET_HOUR_UTC) {
      next.setUTCDate(next.getUTCDate() + 7); // Already past this week's time
    } else {
      next.setUTCDate(next.getUTCDate() + daysUntilMonday);
    }

    return next.getTime() - nowUTC;
  }

  function scheduleNext(): void {
    const delay = msUntilNextMonday5pmET();
    const nextRun = new Date(Date.now() + delay);
    console.log(`[ArticleEngine] Next Deep Read scheduled: ${nextRun.toISOString()} (${Math.round(delay / 3600000)}h from now)`);

    setTimeout(async () => {
      console.log("[ArticleEngine] Monday 5PM ET — running Weekly Deep Read");
      await runWeeklyDeepRead(xClient, apiKey);
      scheduleNext(); // schedule next week
    }, delay);
  }

  scheduleNext();
}
