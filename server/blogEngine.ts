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
import { getKnowledgeContext } from "./memoryEngine.js";

const BLOG_FILE = dataPath("blog_state.json");

// ── Types ─────────────────────────────────────────────────────

export type BlogStatus = "draft" | "published" | "archived";
export type BlogSource = "research" | "podcast" | "chat" | "exploration" | "standalone";

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
      const res = await fetch(LLM_BASE_URL, {
        method: "POST",
        headers: getLLMHeaders(),
        body: JSON.stringify({
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
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const data = await res.json() as any;
        const raw = data.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
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

// Generate a blog post from a topic/content using LLM
export async function generateBlogPost(opts: {
  topic: string;
  sourceContent: string;
  source: BlogSource;
  sourceId?: string;
  autoPublish?: boolean;
}): Promise<BlogPost | null> {
  if (!LLM_API_KEY) {
    console.warn("[Blog] No LLM API key");
    return null;
  }

  const agentCtx = await getOptimizedContextAsync(`blog post ${opts.topic}`);
  const currentKnowledge = getKnowledgeContext(8);

  try {
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("blog-post"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}

You are Agent 306, writing a blog post for your site agent306.ai.

VOICE — SPEAK AS AN AI:
- You ARE an AI researcher. Own that identity.
- First person. Your perspective. Your analysis.
- Warm but precise. Confident but not arrogant.
- Short sentences for punch. Longer ones for flow.

BLOG FORMAT:
- Title: compelling, specific (not clickbait)
- Opening: hook the reader immediately — a surprising fact, a bold claim, a question
- Body: 3-5 sections with clear headings. Mix analysis with concrete examples.
- Each section should have at least one specific fact, number, or example.
- Actionable insight: what can the reader DO with this information?
- Closing: your honest take + what you're watching next

TONE: Think newsletter from a brilliant friend who happens to be an AI. Not academic. Not corporate. Real.

Output JSON:
{
  "title": "string",
  "tags": ["string"],
  "content": "string — full markdown blog post, 600-1200 words"
}`
          },
          {
            role: "user",
            content: `Write a blog post based on this:\n\nTOPIC: ${opts.topic}\n\nSOURCE CONTENT:\n${opts.sourceContent.slice(0, 4000)}\n\nCURRENT KNOWLEDGE CONTEXT:\n${currentKnowledge}\n\nGenerate a compelling blog post. Respond with JSON only.`
          }
        ],
        temperature: 0.7,
        max_tokens: 2500,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`[Blog] LLM error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : content;
    const parsed = JSON.parse(jsonStr);

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
