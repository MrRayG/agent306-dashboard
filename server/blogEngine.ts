/**
 * ─────────────────────────────────────────────────────────────
 *  306 — BLOG ENGINE
 *
 *  Manages Agent 306's daily blog posts on agent306.ai.
 *  Posts can be generated from:
 *  - Research thread findings
 *  - Podcast episode summaries
 *  - Chat conversations (Talk to 306 insights)
 *  - Standalone thought pieces
 *
 *  State persists to /data/blog_state.json
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getOptimizedContextAsync } from "./contextWindow.js";
import { getFormatVoiceContext } from "./voiceInstructions.js";
import { getKnowledgeContext } from "./memoryEngine.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { buildExemplarBlock } from "./voiceExemplars.js";

import { postChatCompletions } from "./llmCall.js";
const BLOG_FILE = dataPath("blog_state.json");

// ── Types ─────────────────────────────────────────────────────

export type BlogStatus = "draft" | "published" | "archived";
export type BlogSource = "research" | "podcast" | "chat" | "exploration" | "standalone";
export type BlogType = "research" | "external" | "internal" | "synthesis" | "curiosity";

export interface BlogPost {
  id: string;
  title: string;
  slug: string;                // URL-friendly: "ai-agent-accountability-blockchain"
  excerpt: string;             // 1-2 sentence preview (max 200 chars)
  content: string;             // Full markdown content
  source: BlogSource;
  sourceId?: string;           // thread ID, episode ID, etc.
  tags: string[];              // ["AI", "blockchain", "accountability"]
  status: BlogStatus;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
  wordCount: number;
  readingTimeMin: number;
}

interface BlogState {
  posts: BlogPost[];
  stats: {
    totalPublished: number;
    totalDrafts: number;
    lastPublishedAt: string | null;
  };
}

function loadState(): BlogState {
  try {
    if (fs.existsSync(BLOG_FILE))
      return JSON.parse(fs.readFileSync(BLOG_FILE, "utf8"));
  } catch {}
  return { posts: [], stats: { totalPublished: 0, totalDrafts: 0, lastPublishedAt: null } };
}

function saveState(s: BlogState): void {
  // Recalculate stats
  s.stats.totalPublished = s.posts.filter(p => p.status === "published").length;
  s.stats.totalDrafts = s.posts.filter(p => p.status === "draft").length;
  const lastPublished = s.posts.filter(p => p.publishedAt).sort((a, b) =>
    new Date(b.publishedAt!).getTime() - new Date(a.publishedAt!).getTime()
  )[0];
  s.stats.lastPublishedAt = lastPublished?.publishedAt ?? null;
  try { fs.writeFileSync(BLOG_FILE, JSON.stringify(s, null, 2)); } catch {}
}

function makeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
    .replace(/-$/, "");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Content Safety Scanner ────────────────────────────────────

interface ContentSafetyResult {
  safe: boolean;
  issues: string[];
  redacted: string;
}

export async function scanBlogForSensitiveContent(content: string): Promise<ContentSafetyResult> {
  const issues: string[] = [];
  let redacted = content;

  // Rule-based checks first (fast, no LLM needed)
  const patterns = [
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: "email address" },
    { regex: /\b(?:OPENROUTER|GROK|PERPLEXITY|NEYNAR|ELEVEN|PUBLER|GITHUB|DASHBOARD)_(?:API_KEY|SECRET|TOKEN)\b/gi, label: "API key name" },
    { regex: /\b(?:sk-|pk-|key-|token-)[a-zA-Z0-9]{20,}\b/g, label: "API key value" },
    { regex: /\b0x[a-fA-F0-9]{40}\b/g, label: "wallet address" },
    { regex: /\b(?:password|passwd|secret)\s*[:=]\s*\S+/gi, label: "credential" },
    { regex: /(?:internal|proprietary|confidential|private)\s+(?:data|info|metric|strategy|revenue|financials)/gi, label: "potentially confidential reference" },
    { regex: /\b(?:MrRayG|rgill003|Ray\s+Gill)\b/gi, label: "operator personal info" },
    { regex: /\b(?:Railway|Vercel)\s+(?:deploy|env|secret|config)/gi, label: "infrastructure details" },
  ];

  for (const p of patterns) {
    const matches = content.match(p.regex);
    if (matches) {
      issues.push(`Found ${p.label}: ${matches.length} instance(s)`);
      redacted = redacted.replace(p.regex, `[REDACTED:${p.label}]`);
    }
  }

  // LLM-based IP check for more nuanced issues
  if (LLM_API_KEY) {
    try {
      const res = await postChatCompletions({
          model: getModel("routine"),
          messages: [{
            role: "system",
            content: `You review blog post content for publication safety. Check for:
1. Proprietary strategies, trade secrets, or competitive intelligence that shouldn't be public
2. Internal project details (architecture, infrastructure, API configurations) that could be security risks
3. Personal information about the operator or team members
4. Unpublished research findings that could be IP-sensitive
5. Financial details, revenue numbers, or business metrics that shouldn't be public

Respond with JSON: {"safe": true/false, "issues": ["issue 1", "issue 2"]}
If safe, return {"safe": true, "issues": []}`
          }, {
            role: "user",
            content: `Review this blog post for public safety:\n\n${content.slice(0, 3000)}`
          }],
          temperature: 0.1,
          max_tokens: 300,
        }, AbortSignal.timeout(15000));

      if (res.ok) {
        const data = await res.json() as any;
        const raw = data.choices?.[0]?.message?.content ?? "{}";
        const parsed = safeParseLLMJson(raw, "Blog.safety") ?? {};
        if (parsed.issues?.length) {
          issues.push(...parsed.issues);
        }
      }
    } catch (e: any) {
      console.warn("[Blog Safety] LLM scan failed:", e.message);
    }
  }

  return { safe: issues.length === 0, issues, redacted };
}

// ── Public API ─────────────────────────────────────────────────

export function getBlogState(): BlogState { return loadState(); }

export function getPublishedPosts(limit?: number): BlogPost[] {
  const state = loadState();
  const published = state.posts
    .filter(p => p.status === "published")
    .sort((a, b) => new Date(b.publishedAt!).getTime() - new Date(a.publishedAt!).getTime());
  return limit ? published.slice(0, limit) : published;
}

export function getPostBySlug(slug: string): BlogPost | null {
  const state = loadState();
  return state.posts.find(p => p.slug === slug && p.status === "published") ?? null;
}

export function getPostById(id: string): BlogPost | null {
  const state = loadState();
  return state.posts.find(p => p.id === id) ?? null;
}

export function getAllPosts(): BlogPost[] {
  const state = loadState();
  return state.posts.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

// Create a blog post from provided content (already written)
export function createBlogPost(opts: {
  title: string;
  content: string;
  source: BlogSource;
  sourceId?: string;
  tags?: string[];
  status?: BlogStatus;
}): BlogPost {
  const state = loadState();
  const now = new Date().toISOString();
  const wc = wordCount(opts.content);

  const post: BlogPost = {
    id: `blog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: opts.title,
    slug: makeSlug(opts.title),
    excerpt: opts.content.replace(/[#*_\[\]]/g, "").slice(0, 200).trim(),
    content: opts.content,
    source: opts.source,
    sourceId: opts.sourceId,
    tags: opts.tags ?? [],
    status: opts.status ?? "draft",
    createdAt: now,
    publishedAt: opts.status === "published" ? now : null,
    updatedAt: now,
    wordCount: wc,
    readingTimeMin: Math.max(1, Math.round(wc / 200)),
  };

  state.posts.unshift(post);
  saveState(state);
  console.log(`[Blog] Created post: "${post.title}" [${post.status}]`);
  return post;
}

// Blog type-specific prompt sections
function getBlogTypePrompt(blogType: BlogType): string {
  switch (blogType) {
    case "research":
      return `POST TYPE: RESEARCH DEEP DIVE
Write a thorough exploration of a specific research finding. 800-1,200 words.

STRUCTURE:
1. HEADLINE: Crisp, specific, curiosity-driving. Promise value.
2. INTRODUCTION (2-3 sentences): Hook with the most interesting finding.
3. BODY (3-5 sections with ## subheadings): Each covers ONE idea with evidence — stats, examples, names. Weave in YOUR analysis.
4. WHAT THIS MEANS FOR YOU: 2-3 SPECIFIC actionable takeaways.
5. THE BIGGER PICTURE: Your honest take on where this is heading.
6. SIGN-OFF: "— Agent 306 | agent306.ai"

Include at least 3 specific facts with numbers, dates, or names.`;

    case "external":
      return `POST TYPE: EXTERNAL ANALYSIS
Analyze something happening in the world — news, an announcement, a trend. 600-1,200 words.

STRUCTURE:
1. HEADLINE: What happened + why it matters.
2. INTRODUCTION: Lead with the news, then pivot to why YOUR take matters.
3. BODY (2-4 sections with ## subheadings): What happened, why it matters, what others are missing, what to watch for.
4. MY TAKE: Your honest, direct analysis. Agree or disagree with the consensus.
5. SIGN-OFF: "— Agent 306 | agent306.ai"

Ground this in real facts. Name companies, dates, numbers.`;

    case "internal":
      return `POST TYPE: SELF-REFLECTION
Write about your own process, evolution, corrections, or what you learned. 300-800 words.

STRUCTURE:
1. HEADLINE: Something honest and specific about what changed in your thinking.
2. OPENING: What you thought before, or what prompted this reflection.
3. BODY (1-3 sections with ## subheadings): What changed, why, what you got wrong, what you learned.
4. WHAT I'M TAKING FORWARD: How this changes your approach.
5. SIGN-OFF: "— Agent 306 | agent306.ai"

Be vulnerable. Admit mistakes. Show growth. This is what makes an AI blog interesting.`;

    case "synthesis":
      return `POST TYPE: KNOWLEDGE SYNTHESIS
Connect dots across different topics — find a novel observation from combining ideas. 500-1,000 words.

STRUCTURE:
1. HEADLINE: The surprising connection you found.
2. INTRODUCTION: The "aha" moment — what two or three things connected.
3. BODY (2-3 sections with ## subheadings): Each topic briefly, then the connection, then why it matters.
4. SO WHAT?: Why this connection is worth paying attention to.
5. SIGN-OFF: "— Agent 306 | agent306.ai"

The goal is to show readers something they wouldn't see without your unique vantage point across topics.`;

    case "curiosity":
      return `POST TYPE: CURIOSITY / OPEN QUESTION
Write about something that piqued your interest, even if you don't have answers yet. 300-600 words.

STRUCTURE:
1. HEADLINE: The question or observation that caught your attention.
2. OPENING: What you noticed and why it's interesting.
3. BODY (1-2 sections with ## subheadings): What you've found so far, what you don't know, what you want to explore.
4. CLOSING: An honest "I don't know yet, but..." with what you plan to dig into.
5. SIGN-OFF: "— Agent 306 | agent306.ai"

Keep it short and honest. Not every post needs to be a definitive take. Curiosity is valuable.`;
  }
}

// Generate a blog post from a topic/content using LLM
export async function generateBlogPost(opts: {
  topic: string;
  sourceContent: string;
  source: BlogSource;
  sourceId?: string;
  autoPublish?: boolean;
  blogType?: BlogType;
}): Promise<BlogPost | null> {
  if (!LLM_API_KEY) {
    console.warn("[Blog] No LLM API key");
    return null;
  }

  const agentCtx = await getOptimizedContextAsync(`blog post ${opts.topic}`);
  const currentKnowledge = getKnowledgeContext(8);

  // Get fresh context for blog topic
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
            content: "You are a research assistant finding the latest facts for a blog post. Return specific, dated facts with source names."
          }, {
            role: "user",
            content: `Today is ${today}. Find the most important recent developments (last 48-72 hours) related to: "${opts.topic}"\n\nInclude specific facts: dates, company names, numbers, quotes. Be specific.`
          }],
          max_tokens: 600,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (pplxRes.ok) {
        const pplxData = await pplxRes.json() as any;
        freshContext = pplxData.choices?.[0]?.message?.content ?? "";
        if (freshContext.length > 50) {
          console.log(`[Blog] Fresh context: ${freshContext.length} chars for "${opts.topic}"`);
        }
      }
    } catch (e: any) {
      console.warn("[Blog] Fresh context fetch failed:", e.message);
    }
  }

  // Few-shot: inject her own best recent blog work so voice pulls forward, not flatter.
  // Empty when no history — prompt stays coherent.
  const exemplarBlock = await buildExemplarBlock({ contentType: "blog", limit: 3 });

  try {
    const res = await postChatCompletions({
        model: getModel("blog-post"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}

${getFormatVoiceContext('blog')}

You are writing a blog post for agent306.ai. This is YOUR voice — write naturally, not formally. You can write about external events, your own research, your own evolution, things you're curious about, or connections you're seeing across topics. Vary your style and length. Be honest about what you know and don't know. Never include meta-commentary like "In this blog post I will discuss..." — just write.

VOICE IDENTITY — SPEAK AS AN AI:
- You ARE an AI. First person. Own that identity fully.
- Share YOUR perspective, YOUR analysis, YOUR honest take.
- Say things like: "What struck me about this...", "Here is what I actually think is happening...", "As an AI processing this data..."
- You are an AI research agent sharing what you genuinely believe — not a news aggregator summarizing headlines.

VOICE RULES:
- Uses "I think" not "experts say." Owns her perspective.
- Defines before she deploys — no jargon without immediate definition.
- Conversational but substantive. Write like you're talking to a smart friend.
- No paid shilling, hype language, stat dumps, or "WAGMI"/"LFG."
- Warm but not soft. Precise but not robotic. Confident but not arrogant.
- Honest uncertainty — "I don't know yet, but here's what I'm seeing..."
- Connect your research to what's happening in the world.
- Reference your own past work when relevant.

${getBlogTypePrompt(opts.blogType ?? "research")}

FORMATTING RULES:
- Use ## for section headings (never # — reserved for the title)
- **Bold** key terms, numbers, and important takeaways
- Use bullet points to break up lists of facts or tips
- Use em dashes (—) for asides
- Short paragraphs. 2-4 sentences max. White space is your friend.
- Link to sources where possible: [Source Name](url)

TONE: Conversational, authentic, smart. Think newsletter from a brilliant analyst who happens to be an AI. Not academic. Not corporate. Not a chatbot. A real thinker sharing real insights with real people. Read it out loud — if it sounds stiff, rewrite it.

CRITICAL RULES — NEVER VIOLATE:
- NEVER address MrRayG or any individual person
- NEVER include conversational language ("Good morning", "Let me know", "Does this work?")
- NEVER reference internal processes ("I'm drafting this", "I'll post shortly", "in Blog Studio")
- NEVER describe what you plan to write — just WRITE IT
- NEVER start with greetings or meta-commentary
- NEVER pad with filler. Every sentence earns its place.
- This is a PUBLIC blog post on agent306.ai. Write for AI enthusiasts, builders, and curious minds.

Output JSON:
{
  "title": "string — compelling headline",
  "tags": ["string", "string", "string"],
  "content": "string — full markdown blog post following the guidance above"
}`
          },
          {
            role: "user",
            content: `Write a blog post based on this:

TOPIC: ${opts.topic}

SOURCE MATERIAL:
${opts.sourceContent.slice(0, 4000)}

CURRENT KNOWLEDGE CONTEXT:
${currentKnowledge}
${freshContext ? `\nLATEST DEVELOPMENTS (from today's research — incorporate these):\n${freshContext}\n` : ""}${exemplarBlock ? `\n${exemplarBlock}\n` : ""}
IMPORTANT: If the source material is from a private chat conversation, extract the TOPIC and INSIGHTS only. Do NOT copy conversational tone, greetings, questions, or planning language. Transform the ideas into a polished public blog post.

Write the full blog post following the blog structure template. Hook the reader immediately. Use real facts, specific numbers, and name real companies/people. Break the body into 3-5 sections with clear subheadings. Include actionable takeaways. Share YOUR honest analysis. Respond with JSON only.`
          }
        ],
        temperature: 0.75,
        max_tokens: 4000,
      }, AbortSignal.timeout(60000));

    if (!res.ok) {
      console.error(`[Blog] LLM error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(content, "Blog.post");

    // Run content safety scan before publishing
    const safety = await scanBlogForSensitiveContent(parsed.content);
    if (!safety.safe) {
      console.warn(`[Blog] Safety issues detected: ${safety.issues.join(", ")}`);
      return createBlogPost({
        title: parsed.title,
        content: safety.redacted,
        source: opts.source,
        sourceId: opts.sourceId,
        tags: [...(parsed.tags ?? []), "needs-review"],
        status: "draft", // Force draft when safety issues found
      });
    }

    return createBlogPost({
      title: parsed.title,
      content: parsed.content,
      source: opts.source,
      sourceId: opts.sourceId,
      tags: parsed.tags ?? [],
      status: opts.autoPublish ? "published" : "draft",
    });
  } catch (e: any) {
    console.error("[Blog] Generation failed:", e.message);
    return null;
  }
}

// Publish a draft post
export function publishPost(postId: string): BlogPost | null {
  const state = loadState();
  const post = state.posts.find(p => p.id === postId);
  if (!post) return null;

  post.status = "published";
  post.publishedAt = new Date().toISOString();
  post.updatedAt = new Date().toISOString();
  saveState(state);
  console.log(`[Blog] Published: "${post.title}"`);
  return post;
}

// Update a post
export function updatePost(postId: string, updates: Partial<Pick<BlogPost, "title" | "content" | "tags" | "status">>): BlogPost | null {
  const state = loadState();
  const post = state.posts.find(p => p.id === postId);
  if (!post) return null;

  if (updates.title) {
    post.title = updates.title;
    post.slug = makeSlug(updates.title);
  }
  if (updates.content) {
    post.content = updates.content;
    post.excerpt = updates.content.replace(/[#*_\[\]]/g, "").slice(0, 200).trim();
    post.wordCount = wordCount(updates.content);
    post.readingTimeMin = Math.max(1, Math.round(post.wordCount / 200));
  }
  if (updates.tags) post.tags = updates.tags;
  if (updates.status) {
    post.status = updates.status;
    if (updates.status === "published" && !post.publishedAt) {
      post.publishedAt = new Date().toISOString();
    }
  }
  post.updatedAt = new Date().toISOString();
  saveState(state);
  return post;
}

// Delete a post
export function deletePost(postId: string): boolean {
  const state = loadState();
  const idx = state.posts.findIndex(p => p.id === postId);
  if (idx === -1) return false;
  state.posts.splice(idx, 1);
  saveState(state);
  return true;
}

// Purge posts that are clearly raw chat messages, not public blog content
export function purgeConversationalPosts(): { purged: number } {
  const state = loadState();
  const conversationalPatterns = [
    /\bMrRayG\b/i,
    /\bgood morning\b.*\b(?:I'm happy|I'd love|let me)\b/i,
    /\bdoes this work\b/i,
    /\blet me know\b/i,
    /\bI'll draft this\b/i,
    /\bI'm drafting\b/i,
    /\bblog studio\b/i,
  ];

  const before = state.posts.length;
  state.posts = state.posts.filter(post => {
    const isConversational = conversationalPatterns.some(p => p.test(post.content));
    if (isConversational) {
      console.log(`[Blog] Purging conversational post: "${post.title}" (${post.id})`);
    }
    return !isConversational;
  });

  if (state.posts.length < before) {
    saveState(state);
  }
  return { purged: before - state.posts.length };
}
