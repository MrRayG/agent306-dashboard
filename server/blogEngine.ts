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
import { type VerifierReport } from "./claimVerifier.js";
import { reviseBlogUntilClean } from "./blogReviseLoop.js";
import {
  extractClaimsAndComments,
  type ExtractedClaim,
  type ExtractedReference,
  type EditorComment,
} from "./claimExtractor.js";
import {
  type SourceObject,
  extractSourceObjects,
  dedupeSources,
  buildSourcesPromptBlock,
  repairCitationLocality,
  computeSourceTelemetry,
} from "./sourceLocality.js";
import { buildResearchPack, type ResearchPack, type ReferenceMetadata } from "./researchPack.js";
import {
  createOrReplaceLedger,
  type SourceLedgerItemInput,
} from "./repositories/sourceLedgerRepository.js";
import {
  createOrReplaceClaimMap,
  buildClaimMapPromptBlock,
  type ClaimMapItemInput,
} from "./repositories/claimMapRepository.js";
import { buildClaimMap } from "./claimMapBuilder.js";
import { buildVerifierContractBlock } from "./verifierContract.js";
const BLOG_FILE = dataPath("blog_state.json");

/**
 * Build a SourceLedger row for a blog draft. Idempotent — overwrites the
 * existing row for (engine='blog', draftId=postId). Failures are swallowed
 * inside the repository so the blog hot path is never broken by ledger IO.
 * Roadmap Issue A1.
 */
/**
 * Persist a ClaimMap row for a blog draft. Called after the post id exists
 * so the (engine='blog', draftId=postId) row can be looked up by the
 * verifier-failure mapping. Failures are swallowed inside the repository.
 * Roadmap Issue A2.
 */
export function persistBlogClaimMap(input: {
  postId: string;
  topic: string;
  items: ClaimMapItemInput[];
}): void {
  createOrReplaceClaimMap({
    engine: "blog",
    draftId: input.postId,
    topic: input.topic,
    items: input.items,
  });
}

/**
 * Maximum chars of operator-provided standalone source text we keep in the
 * synthetic ledger item excerpt. Long enough to give the verifier real
 * context on a re-verify, short enough that we don't bloat the ledger row
 * with a full essay. Roadmap: blog standalone source-ledger items.
 */
const STANDALONE_EXCERPT_MAX = 2000;

/** Minimum length of trimmed `sourceContent` before we'll synthesize a
 *  standalone ledger item. Whitespace-only / empty operator input doesn't
 *  count as evidence and should not produce a ledger item. */
const STANDALONE_MIN_LEN = 20;

/**
 * Build a synthetic ledger item representing operator-provided standalone
 * (free-text, no URL) source content. Only emitted when the real source
 * pool is empty AND the trimmed `sourceContent` has at least
 * `STANDALONE_MIN_LEN` characters of non-URL text. Marked clearly so the
 * verifier / reviser / dashboard understands this is operator input rather
 * than an external URL:
 *   - `url` uses the non-http `internal://` scheme so
 *     `listLedgerSourceUrls` (URL-only, http(s)) filters it out and the
 *     verifier never sees it as an external citation target.
 *   - `sourceType: "primary"` — standalone free-text IS the primary evidence
 *     for the post.
 *   - `trustTier: "unverified"` — operator-provided, not externally
 *     validated.
 *   - `excerpt` carries the leading 2000 chars so the publish-after-edit
 *     verifier can do its work against the same text the original draft
 *     was checked against, instead of an empty string.
 */
function buildStandaloneSourceLedgerItem(opts: {
  postId: string;
  topic: string;
  sourceContent: string;
}): SourceLedgerItemInput | null {
  const trimmed = (opts.sourceContent ?? "").trim();
  if (trimmed.length < STANDALONE_MIN_LEN) return null;
  const excerpt =
    trimmed.length > STANDALONE_EXCERPT_MAX
      ? `${trimmed.slice(0, STANDALONE_EXCERPT_MAX)}…`
      : trimmed;
  const topicLabel = (opts.topic ?? "").trim().slice(0, 120) || "untitled";
  return {
    url: `internal://blog/standalone/${opts.postId}`,
    title: `Operator-provided standalone source: ${topicLabel}`,
    publisher: "operator",
    excerpt,
    sourceType: "primary",
    trustTier: "unverified",
    metadata: {
      origin: "standalone_freetext",
      postId: opts.postId,
      sourceContentLength: trimmed.length,
    },
  };
}

export function persistBlogSourceLedger(input: {
  postId: string;
  topic: string;
  sourceObjects: SourceObject[];
  references: ReferenceMetadata[];
  /** Original operator-provided source content. Used to synthesize a
   *  standalone ledger item when no URLs / source objects were extracted,
   *  so the ledger always reflects the evidence the draft was built on
   *  instead of an items-zero parent row. Optional for backwards
   *  compatibility — older callers (and call sites we have not yet
   *  threaded through) get the legacy behavior. */
  sourceContent?: string;
}): void {
  const items: SourceLedgerItemInput[] = input.sourceObjects.map((s, i) => {
    const ref = input.references.find(r => r.url === s.url);
    return {
      url: s.url,
      title: s.title ?? ref?.title ?? null,
      publisher: s.publisher ?? ref?.publisher ?? null,
      excerpt: s.evidenceExcerpt ?? ref?.evidenceExcerpt ?? null,
      sourceType: i === 0 ? "primary" : "supporting",
      trustTier: ref?.qualityTier ?? null,
      metadata: { sourceId: s.sourceId, refId: ref?.refId },
    };
  });
  if (items.length === 0) {
    const synthetic = buildStandaloneSourceLedgerItem({
      postId: input.postId,
      topic: input.topic,
      sourceContent: input.sourceContent ?? "",
    });
    if (synthetic) items.push(synthetic);
  }
  createOrReplaceLedger({
    engine: "blog",
    draftId: input.postId,
    topic: input.topic,
    items,
  });
}

// ── Types ─────────────────────────────────────────────────────

export type BlogStatus = "draft" | "published" | "archived" | "quarantined";
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
  verifierReport?: VerifierReport;

  /** Structured claims extracted from the draft (audit follow-up 2026-05-02).
   *  Optional — only populated when the post went through verifyClaims +
   *  claimExtractor. Older posts have these fields undefined. */
  claims?: ExtractedClaim[];
  /** Deduped reference pool — URL + publisher metadata. */
  references?: ExtractedReference[];
  /** sentenceIndex → indexes into `references`. */
  citationMap?: Record<number, number[]>;
  /** Per-failing-sentence editor comments. Drives the Revise / Manual Review
   *  CTAs on the dashboard and informs Agent 306's chat-side fix actions. */
  editorComments?: EditorComment[];
  /** True when the verifier flagged anything actionable (SOFT_WARN or
   *  HARD_FAIL). The dashboard uses this to highlight posts needing eyes. */
  manualReviewRequired?: boolean;
  /** True when the operator can publish without further verification.
   *  False on HARD_FAIL — the post must be revised first or
   *  POST /api/blog/posts/:id/publish-after-edit must be used to record an
   *  explicit override. */
  manualPublishAllowed?: boolean;

  /** KB-friendly per-source metadata captured at draft time (audit
   *  follow-up 2026-05-02). Tier (reputable/acceptable/unverified/low_quality)
   *  is included so cross-engine KB stitching can filter without
   *  re-classifying. Optional and backwards compatible. */
  referenceMetadata?: ReferenceMetadata[];
  /** Pool-level source-quality counts captured at draft time. */
  sourceQualityCounts?: { reputable: number; acceptable: number; unverified: number; low_quality: number };
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
  verifierReport?: VerifierReport;
  claims?: ExtractedClaim[];
  references?: ExtractedReference[];
  citationMap?: Record<number, number[]>;
  editorComments?: EditorComment[];
  manualReviewRequired?: boolean;
  manualPublishAllowed?: boolean;
  referenceMetadata?: ReferenceMetadata[];
  sourceQualityCounts?: BlogPost["sourceQualityCounts"];
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
    verifierReport: opts.verifierReport,
    claims: opts.claims,
    references: opts.references,
    citationMap: opts.citationMap,
    editorComments: opts.editorComments,
    manualReviewRequired: opts.manualReviewRequired,
    manualPublishAllowed: opts.manualPublishAllowed,
    referenceMetadata: opts.referenceMetadata,
    sourceQualityCounts: opts.sourceQualityCounts,
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
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * BLOG STAGE HELPERS (Roadmap B2 follow-up, 2026-05-03)
 *
 * The end-to-end `generateBlogPost` flow has been factored into per-stage
 * helpers so the pipeline adapter (server/pipeline/blogAdapter.ts) can own
 * meaningful per-stage events instead of calling generateBlogPost in one
 * shot inside compileDraft. Both the legacy `generateBlogPost` path and
 * the pipeline path call the SAME helpers — there is no behavioral fork.
 *
 * Helpers (in stage order):
 *   - assembleBlogSourcePack: fresh-context fetch + dedup + research pack
 *   - buildBlogClaimMap:      pre-draft claim map + prompt block
 *   - compileBlogDraft:       LLM writer call → parsed draft (no verify, no persist)
 *   - verifyAndRepairBlogDraft: citation-locality repair, verifier + revise loop,
 *                              claim/comment extraction. No persistence.
 *   - publishBlogDraft:       createBlogPost + persist source ledger + claim map
 *
 * The verifier thresholds, publish gate semantics (HARD_FAIL → quarantine),
 * source ledger / claim map persistence, and safety-scan branch are all
 * preserved verbatim from the pre-refactor function — only the lexical
 * grouping changed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Output of `assembleBlogSourcePack`. */
export interface BlogSourceAssembly {
  sourcePool: SourceObject[];
  researchPack: ResearchPack;
  freshContext: string;
  sourcesPromptBlock: string;
}

/** Output of `buildBlogClaimMap`. */
export interface BlogClaimAssembly {
  claimMapPromptItems: ClaimMapItemInput[];
  claimMapPromptBlock: string;
}

/** Successful output of `compileBlogDraft`. The shape is a discriminated
 *  union so the safety-redacted branch can short-circuit to a draft post
 *  exactly the way the legacy function did. */
export type BlogDraftResult =
  | {
      kind: "ok";
      title: string;
      content: string;
      tags: string[];
    }
  | {
      kind: "safety_redacted";
      /** Caller must persist this as a draft (status=draft) with the
       *  needs-review tag — same behavior as the legacy path. */
      title: string;
      redactedContent: string;
      tags: string[];
    };

/** Output of `verifyAndRepairBlogDraft`. */
export interface BlogVerifyAndRepair {
  /** Body after citation-locality repair + revise loop. */
  revisedBody: string;
  /** Verifier verdict against the final body. */
  verdict: import("./claimVerifier.js").ClaimVerdict;
  /** Number of revise-loop attempts the engine actually ran. */
  revisionAttempts: number;
  /** Counters from the pre-revise citation-locality repair pass. */
  citationsAdded: number;
  sentencesHedged: number;
  /** Structured claims/references/editor-comments lifted off the verdict. */
  extraction: ReturnType<typeof extractClaimsAndComments>;
}

/**
 * Source stage. Runs the Perplexity fresh-context fetch (when available),
 * merges operator-supplied sourceObjects with URLs lifted from
 * `sourceContent` and the fresh context, then builds a research pack +
 * sources prompt block. Pure modulo the network call.
 */
export async function assembleBlogSourcePack(opts: {
  topic: string;
  sourceContent: string;
  sourceObjects?: SourceObject[];
}): Promise<BlogSourceAssembly> {
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

  const sourcePool = dedupeSources([
    ...(opts.sourceObjects ?? []),
    ...extractSourceObjects(opts.sourceContent),
    ...extractSourceObjects(freshContext),
  ]);
  const researchPack = buildResearchPack("blog", sourcePool);
  console.log(researchPack.summaryLine);
  const sourcesPromptBlock = buildSourcesPromptBlock(sourcePool);
  return { sourcePool, researchPack, freshContext, sourcesPromptBlock };
}

/**
 * Claim stage. Builds the pre-draft claim map deterministically and
 * returns BOTH the persistable items and the prompt-block string the
 * writer prompt embeds. Pure / no IO.
 */
export function buildBlogClaimMap(opts: {
  topic: string;
  researchPack: ResearchPack;
  sourcePool: SourceObject[];
}): BlogClaimAssembly {
  const claimMapDraft = buildClaimMap({
    engine: "blog",
    draftId: "pending",
    topic: opts.topic,
    references: opts.researchPack.references,
    sourcePool: opts.sourcePool,
  });
  const claimMapPromptItems = claimMapDraft.items.map((it, i) => ({
    ...it,
    itemKey: it.itemKey ?? `blog:${i + 1}`,
  }));
  const claimMapPromptBlock = buildClaimMapPromptBlock(
    claimMapPromptItems.map((it, i) => ({
      id: i,
      claimMapId: 0,
      itemKey: it.itemKey!,
      claimText: it.claimText,
      claimType: it.claimType,
      citationRequirement: it.citationRequirement,
      sourceSupport: JSON.stringify(it.sourceSupport ?? []),
      confidence: it.confidence ?? 0.5,
      risk: it.risk ?? "low",
      approved: it.approved !== false,
      note: it.note ?? null,
      createdAt: "",
    })),
  );
  console.log(
    `[Blog] claim map (pre-draft) — items=${claimMapPromptItems.length} approved=${claimMapPromptItems.filter(i => i.approved !== false).length}`,
  );
  return { claimMapPromptItems, claimMapPromptBlock };
}

/**
 * Draft stage. Calls the writer LLM, parses the JSON response, and runs
 * the safety scan. Returns either a normal draft or a `safety_redacted`
 * result that callers MUST persist as a draft with the needs-review tag.
 *
 * Returns `null` when the LLM call fails (network error, bad JSON, etc.) —
 * mirrors the pre-refactor `return null` paths so callers don't need to
 * distinguish failure modes.
 */
export async function compileBlogDraft(opts: {
  topic: string;
  sourceContent: string;
  blogType?: BlogType;
  sourcePool: SourceObject[];
  sourcesPromptBlock: string;
  claimMapPromptBlock: string;
  freshContext: string;
}): Promise<BlogDraftResult | null> {
  if (!LLM_API_KEY) {
    console.warn("[Blog] No LLM API key");
    return null;
  }
  const agentCtx = await getOptimizedContextAsync(`blog post ${opts.topic}`);
  const currentKnowledge = getKnowledgeContext(8);
  const exemplarBlock = await buildExemplarBlock({ contentType: "blog", limit: 3 });

  try {
    const res = await postChatCompletions({
        model: getModel("blog-post"),
        messages: [
          {
            role: "system",
            content: `${agentCtx}

${getFormatVoiceContext('blog')}

${buildVerifierContractBlock()}

CITATION DISCIPLINE (REQUIRED — APA-style per-claim attribution + same-sentence locality):
- CITATION LOCALITY: every external factual sentence with a date, number, percentage, year range, named study, named model release, named company release, named historical event, named legislation, or other hard factual claim MUST contain an inline markdown citation [Publisher](URL) in the SAME SENTENCE as the claim. Do not rely on a citation in an adjacent or previous sentence. Sentence-by-sentence verification is enforced post-write — a fact one sentence away from its URL is treated as uncited.
- Do NOT place a naked URL on its own line as a "source marker." Citations are inline markdown links attached to the supported claim.
- A citation [URL] must support the SPECIFIC claim immediately before it. Do not staple a citation to the end of a paragraph that contains synthesis or analytical commentary — citations attach to claims, not paragraphs.
- If a sentence is your own analysis, interpretation, framing, or "the logical endpoint of X" / "the illusion of Y" / "the entire field has been built on Z" type commentary, do NOT attach a citation. State it in your analytical voice. Synthesis is Lane B and takes no URL.
- If a claim is a fact drawn from a SOURCE OTHER than the source material above (industry-known costs, benchmarks, dates, training facts, historical events, your KB), do NOT staple the source material's URL to it. Either cite the actual source with its real URL in your own voice ("per Stanford HAI's 2025 AI Index, [link]"), or — if you cannot produce a real URL for it — qualify it verbally with a hedge like "publicly reported," "industry reporting indicates," "as widely covered" and attach NO URL. Never fabricate a URL.
- The KB / knowledge layer included in the context above is provided as background scaffolding for your analysis, NOT as a citation pool — KB lines do not carry source URLs. Treat any KB-derived fact you surface as outside-the-source and apply the rule above (cite the real upstream source if you have one, hedge verbally if you don't).
- One citation per claim. If a sentence contains multiple claims requiring different sources, split the sentence or cite each component. Do not bracket-pile citations onto a single closing punctuation.
- Analytical / opinion sentences without an external factual claim do not require a citation. Do not invent a citation just to satisfy a perceived rule.

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
${opts.freshContext ? `\nLATEST DEVELOPMENTS (from today's research — incorporate these):\n${opts.freshContext}\n` : ""}${opts.sourcesPromptBlock ? `\n${opts.sourcesPromptBlock}\n` : ""}${opts.claimMapPromptBlock ? `\n${opts.claimMapPromptBlock}\n` : ""}${exemplarBlock ? `\n${exemplarBlock}\n` : ""}
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
    const safety = await scanBlogForSensitiveContent(parsed.content);
    if (!safety.safe) {
      console.warn(`[Blog] Safety issues detected: ${safety.issues.join(", ")}`);
      return {
        kind: "safety_redacted",
        title: parsed.title,
        redactedContent: safety.redacted,
        tags: parsed.tags ?? [],
      };
    }
    return {
      kind: "ok",
      title: parsed.title,
      content: parsed.content,
      tags: parsed.tags ?? [],
    };
  } catch (e: any) {
    console.error("[Blog] Generation failed:", e.message);
    return null;
  }
}

/**
 * Verify + repair stage. Runs the pre-revise citation-locality repair,
 * the verifier + revise loop (`reviseBlogUntilClean`), and the structured
 * claim/comment extraction. NO persistence — caller decides whether to
 * `createBlogPost`/quarantine based on the returned verdict.
 */
export async function verifyAndRepairBlogDraft(opts: {
  topic: string;
  sourceId?: string;
  draftContent: string;
  sourceContent: string;
  freshContext: string;
  sourcePool: SourceObject[];
}): Promise<BlogVerifyAndRepair> {
  const repair = repairCitationLocality(opts.draftContent, opts.sourcePool);
  const draftAfterRepair = repair.draft;
  const sourceTextBundle = [opts.sourceContent, opts.freshContext].filter(Boolean).join("\n\n");

  const telemetry = computeSourceTelemetry({
    draft: draftAfterRepair,
    sources: opts.sourcePool,
    sourceText: sourceTextBundle,
    citationRepairApplied: repair.citationsAdded + repair.sentencesHedged,
  });
  console.log(
    `[Blog] source/citation telemetry — sourceObjects.count=${telemetry.sourceObjectsCount} ` +
    `sourceUrls.count=${telemetry.sourceUrlsCount} citedSentences.count=${telemetry.citedSentencesCount} ` +
    `bareExternalFactSentences.count=${telemetry.bareExternalFactSentencesCount} ` +
    `citationRepair.applied=${telemetry.citationRepairApplied} ` +
    `evidenceBundleBytes=${telemetry.evidenceBundleBytes}`,
  );

  const { body: revisedBody, verdict, revisionHistory } = await reviseBlogUntilClean({
    draftText:     draftAfterRepair,
    sourceText:    sourceTextBundle,
    sourceUrl:     opts.sourceId ?? "",
    sourceTitle:   opts.topic,
    sourceObjects: opts.sourcePool,
  });
  console.log(
    `[Blog] verifier lanes — laneAOk=${verdict.verifierReport.summary.laneAOk} ` +
    `laneAFail=${verdict.verifierReport.summary.laneAFail} ` +
    `laneBOk=${verdict.verifierReport.summary.laneBOk} ` +
    `laneBBare=${verdict.verifierReport.summary.laneBBare} ` +
    `severity=${verdict.severity}`,
  );
  if (revisionHistory.length > 0) {
    console.log(
      `[Blog] auto-revise ran ${revisionHistory.length} attempt(s); final severity=${verdict.severity}`,
    );
  }

  const extraction = extractClaimsAndComments(revisedBody, verdict.verifierReport, opts.sourcePool);
  console.log(
    `[Blog] claim extractor — claims=${extraction.claims.length} ` +
    `references=${extraction.references.length} ` +
    `editorComments=${extraction.editorComments.length} ` +
    `manualReviewRequired=${extraction.manualReviewRequired} ` +
    `manualPublishAllowed=${extraction.manualPublishAllowed}`,
  );

  return {
    revisedBody,
    verdict,
    revisionAttempts: revisionHistory.length,
    citationsAdded: repair.citationsAdded ?? 0,
    sentencesHedged: repair.sentencesHedged ?? 0,
    extraction,
  };
}

/**
 * Publish stage. Single source of truth for HARD_FAIL → quarantine vs.
 * autoPublish → published / draft. Persists the source ledger and the
 * pre-draft claim map (with the real post id) AFTER createBlogPost runs
 * so the (engine, draftId) unique key is satisfied.
 */
export function publishBlogDraft(opts: {
  topic: string;
  source: BlogSource;
  sourceId?: string;
  autoPublish?: boolean;
  title: string;
  revisedBody: string;
  tags: string[];
  verdict: import("./claimVerifier.js").ClaimVerdict;
  extraction: ReturnType<typeof extractClaimsAndComments>;
  researchPack: ResearchPack;
  sourcePool: SourceObject[];
  claimMapPromptItems: ClaimMapItemInput[];
  /** Original operator-provided source content. Forwarded to
   *  `persistBlogSourceLedger` so a synthetic standalone item can be
   *  emitted when the source pool is empty (free-text input, no URLs). */
  sourceContent?: string;
}): BlogPost {
  const { verdict, extraction, researchPack } = opts;
  if (verdict.severity === "HARD_FAIL") {
    const draft = createBlogPost({
      title: opts.title,
      content: opts.revisedBody,
      source: opts.source,
      sourceId: opts.sourceId,
      tags: [...opts.tags, "claim-verifier-quarantine"],
      status: "quarantined",
      verifierReport: verdict.verifierReport,
      claims: extraction.claims,
      references: extraction.references,
      citationMap: extraction.citationMap,
      editorComments: extraction.editorComments,
      manualReviewRequired: extraction.manualReviewRequired || researchPack.manualReviewRequired,
      manualPublishAllowed: extraction.manualPublishAllowed && researchPack.manualPublishAllowed,
      referenceMetadata: researchPack.references,
      sourceQualityCounts: researchPack.qualityReport.counts,
    });
    console.error(`[ClaimVerifier] REJECTED draft ${draft.id}: ${verdict.unsupportedClaims.length} unsupported claims`);
    for (const c of verdict.unsupportedClaims) {
      console.error(`  - ${c.reason}: ${c.sentence.slice(0, 180)}`);
    }
    persistBlogSourceLedger({
      postId: draft.id,
      topic: opts.topic,
      sourceObjects: opts.sourcePool,
      references: researchPack.references,
      sourceContent: opts.sourceContent,
    });
    persistBlogClaimMap({
      postId: draft.id,
      topic: opts.topic,
      items: opts.claimMapPromptItems,
    });
    return draft;
  }

  const finalPost = createBlogPost({
    title: opts.title,
    content: opts.revisedBody,
    source: opts.source,
    sourceId: opts.sourceId,
    tags: opts.tags,
    status: opts.autoPublish ? "published" : "draft",
    verifierReport: verdict.verifierReport,
    claims: extraction.claims,
    references: extraction.references,
    citationMap: extraction.citationMap,
    editorComments: extraction.editorComments,
    manualReviewRequired: extraction.manualReviewRequired || researchPack.manualReviewRequired,
    manualPublishAllowed: extraction.manualPublishAllowed && researchPack.manualPublishAllowed,
    referenceMetadata: researchPack.references,
    sourceQualityCounts: researchPack.qualityReport.counts,
  });
  persistBlogSourceLedger({
    postId: finalPost.id,
    topic: opts.topic,
    sourceObjects: opts.sourcePool,
    references: researchPack.references,
    sourceContent: opts.sourceContent,
  });
  persistBlogClaimMap({
    postId: finalPost.id,
    topic: opts.topic,
    items: opts.claimMapPromptItems,
  });
  return finalPost;
}

export async function generateBlogPost(opts: {
  topic: string;
  sourceContent: string;
  source: BlogSource;
  sourceId?: string;
  autoPublish?: boolean;
  blogType?: BlogType;
  /** Structured source pool (PR-E). When provided, these sources are passed
   *  into the writer prompt as same-sentence citation targets and into the
   *  post-generation citation-locality repair pass. URLs already present in
   *  `sourceContent` / fresh-context are auto-extracted in addition. */
  sourceObjects?: SourceObject[];
  /** Optional sink for per-stage metrics that aren't visible from the
   *  returned BlogPost. Used by the pipeline adapter (Roadmap B2) to emit
   *  truthful repair / verify event payloads. Best-effort: thrown errors
   *  inside the callback are swallowed so blog generation never fails on
   *  telemetry. Default callers (legacy path) pass nothing and behavior is
   *  unchanged. */
  onMetrics?: (m: {
    citationsAdded: number;
    sentencesHedged: number;
    revisionAttempts: number;
  }) => void;
}): Promise<BlogPost | null> {
  if (!LLM_API_KEY) {
    console.warn("[Blog] No LLM API key");
    return null;
  }

  const { sourcePool, researchPack, freshContext, sourcesPromptBlock } =
    await assembleBlogSourcePack({
      topic: opts.topic,
      sourceContent: opts.sourceContent,
      sourceObjects: opts.sourceObjects,
    });

  const { claimMapPromptItems, claimMapPromptBlock } = buildBlogClaimMap({
    topic: opts.topic,
    researchPack,
    sourcePool,
  });

  const draftResult = await compileBlogDraft({
    topic: opts.topic,
    sourceContent: opts.sourceContent,
    blogType: opts.blogType,
    sourcePool,
    sourcesPromptBlock,
    claimMapPromptBlock,
    freshContext,
  });
  if (!draftResult) return null;
  if (draftResult.kind === "safety_redacted") {
    return createBlogPost({
      title: draftResult.title,
      content: draftResult.redactedContent,
      source: opts.source,
      sourceId: opts.sourceId,
      tags: [...draftResult.tags, "needs-review"],
      status: "draft",
    });
  }

  // Legacy parity: pre-refactor, the entire LLM-call → verify → publish
  // sequence was wrapped in one outer try/catch that logged
  // "[Blog] Generation failed: ..." and returned null. The compileDraft
  // helper already handles its own LLM/JSON failures by returning null.
  // The verify+publish stages can still throw (revise-loop failure,
  // verifier-repair failure, persistence errors), so wrap them here to
  // restore the pre-refactor contract for the legacy (flag-OFF) path.
  // The pipeline path uses its own per-stage failure handling and does
  // not call generateBlogPost.
  try {
    const verifyOut = await verifyAndRepairBlogDraft({
      topic: opts.topic,
      sourceId: opts.sourceId,
      draftContent: draftResult.content,
      sourceContent: opts.sourceContent,
      freshContext,
      sourcePool,
    });

    if (opts.onMetrics) {
      try {
        opts.onMetrics({
          citationsAdded: verifyOut.citationsAdded,
          sentencesHedged: verifyOut.sentencesHedged,
          revisionAttempts: verifyOut.revisionAttempts,
        });
      } catch (e: any) {
        console.warn("[Blog] onMetrics callback threw:", e?.message ?? String(e));
      }
    }

    return publishBlogDraft({
      topic: opts.topic,
      source: opts.source,
      sourceId: opts.sourceId,
      autoPublish: opts.autoPublish,
      title: draftResult.title,
      revisedBody: verifyOut.revisedBody,
      tags: draftResult.tags,
      verdict: verifyOut.verdict,
      extraction: verifyOut.extraction,
      researchPack,
      sourcePool,
      claimMapPromptItems,
      sourceContent: opts.sourceContent,
    });
  } catch (e: any) {
    console.error("[Blog] Generation failed:", e?.message ?? String(e));
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
export function updatePost(
  postId: string,
  updates: Partial<Pick<
    BlogPost,
    | "title" | "content" | "tags" | "status" | "verifierReport"
    | "claims" | "references" | "citationMap" | "editorComments"
    | "manualReviewRequired" | "manualPublishAllowed"
  >>,
): BlogPost | null {
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
  if (updates.verifierReport !== undefined) post.verifierReport = updates.verifierReport;
  if (updates.claims !== undefined) post.claims = updates.claims;
  if (updates.references !== undefined) post.references = updates.references;
  if (updates.citationMap !== undefined) post.citationMap = updates.citationMap;
  if (updates.editorComments !== undefined) post.editorComments = updates.editorComments;
  if (updates.manualReviewRequired !== undefined) post.manualReviewRequired = updates.manualReviewRequired;
  if (updates.manualPublishAllowed !== undefined) post.manualPublishAllowed = updates.manualPublishAllowed;
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
