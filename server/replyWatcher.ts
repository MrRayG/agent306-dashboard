// ─────────────────────────────────────────────────────────────────────────────
// 306 — REPLY WATCHER
// Fetches mentions/replies to @agent306 via TWO sources:
//   1. Twitter API v2 userMentionTimeline (primary — reliable, structured data)
//   2. Grok x_search (supplementary — finds quote tweets and keyword mentions)
//
// This is what closes the loop:
// Episode posts → community replies → Agent 306 reads them →
// next episode references what the community said → they feel heard → they engage more
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";

import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
const REPLY_STATE_FILE = dataPath("replies.json");
const GROK_KEY = process.env.GROK_API_KEY ?? "";

// Twitter client reference — set via initReplyWatcher()
let xClient: any = null;
let agent306UserId: string | null = null;

export function initReplyWatcher(client: any): void {
  xClient = client;
  // Fetch our own user ID on init (needed for mentions endpoint)
  client.v2.me().then((me: any) => {
    agent306UserId = me.data?.id ?? null;
    if (agent306UserId) {
      console.log(`[ReplyWatcher] Initialized — @agent306 user ID: ${agent306UserId}`);
    } else {
      console.warn("[ReplyWatcher] Could not resolve @agent306 user ID — mentions fetch will use Grok only");
    }
  }).catch((err: any) => {
    console.warn("[ReplyWatcher] Failed to get user ID:", err.message);
  });
}

export interface CommunityReply {
  username: string;
  text: string;
  likes: number;
  replyType: "question" | "lore_suggestion" | "holder_mention" | "excitement" | "callout" | "general";
  tokenMentioned?: number;       // if they mentioned a specific token #ID
  capturedAt: string;
  tweetUrl?: string;
  tweetId?: string;              // for in-reply-to threading
}

interface ReplyState {
  replies: CommunityReply[];
  lastFetched: string | null;
  lastMentionId: string | null;  // pagination: newest mention ID from last Twitter API fetch
  totalCaptured: number;
}

function loadState(): ReplyState {
  try {
    if (fs.existsSync(REPLY_STATE_FILE))
      return JSON.parse(fs.readFileSync(REPLY_STATE_FILE, "utf8"));
  } catch {}
  return { replies: [], lastFetched: null, lastMentionId: null, totalCaptured: 0 };
}

function saveState(s: ReplyState) {
  try { fs.writeFileSync(REPLY_STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let replyState = loadState();

export function getReplyState() { return replyState; }

export function getTopReplies(limit = 5): CommunityReply[] {
  return replyState.replies
    .sort((a, b) => {
      // Priority: questions and lore suggestions first, then by likes
      const typeScore = { question: 4, lore_suggestion: 4, callout: 3, holder_mention: 3, excitement: 2, general: 1 };
      const aScore = (typeScore[a.replyType] ?? 1) + (a.likes * 0.5);
      const bScore = (typeScore[b.replyType] ?? 1) + (b.likes * 0.5);
      return bScore - aScore;
    })
    .slice(0, limit);
}

// ── Format replies for episode prompt injection ───────────────────────────────
export function formatRepliesForContext(): string {
  const top = getTopReplies(5);
  if (top.length === 0) return "";

  const lines = top.map(r => {
    const typeLabel = {
      question: "❓ ASKED",
      lore_suggestion: "💡 SUGGESTED",
      holder_mention: "👤 MENTIONED",
      callout: "📣 CALLED OUT",
      excitement: "🔥 EXCITED",
      general: "💬 SAID",
    }[r.replyType] ?? "💬 SAID";

    const tokenNote = r.tokenMentioned ? ` [about #${r.tokenMentioned}]` : "";
    return `@${r.username} ${typeLabel}${tokenNote}: "${r.text.slice(0, 120)}"`;
  });

  return `COMMUNITY REPLIED TO RECENT EPISODES:\n${lines.join("\n")}\n\nThese are real replies from co-creators. Reference them in the story. If someone asked "what happens to #X next?" — answer it. If someone suggested a direction — take it seriously. Name them by @handle — they will see it and repost.`;
}

// ── Classify a reply using simple heuristics (no API call needed) ─────────────
function classifyReply(text: string): CommunityReply["replyType"] {
  const lower = text.toLowerCase();
  if (text.includes("?") || lower.includes("how") || lower.includes("when") || lower.includes("what") || lower.includes("why")) return "question";
  if (lower.includes("should") || lower.includes("imagine") || lower.includes("what if") || lower.includes("story") || lower.includes("lore")) return "lore_suggestion";
  if (/\#\d{1,5}/.test(text) || lower.includes("my token") || lower.includes("token #")) return "holder_mention";
  if (text.includes("@") && !text.toLowerCase().includes("@agent_306")) return "callout";
  if (lower.includes("🔥") || lower.includes("lfg") || lower.includes("let's go") || lower.includes("amazing") || lower.includes("love") || lower.includes("fire") || lower.includes("🚀")) return "excitement";
  return "general";
}

// ── Extract token ID from text ────────────────────────────────────────────────
function extractTokenId(text: string): number | undefined {
  const match = text.match(/\#(\d{1,5})/);
  return match ? Number(match[1]) : undefined;
}

// ── SOURCE 1: Twitter API v2 — userMentionTimeline ───────────────────────────
// This is the PRIMARY source. Reliable, structured, catches all @mentions and replies.
async function fetchMentionsViaTwitterAPI(): Promise<CommunityReply[]> {
  if (!xClient || !agent306UserId) {
    console.log("[ReplyWatcher] Twitter API not available — skipping (will use Grok x_search)");
    return [];
  }

  try {
    const params: any = {
      max_results: 20,
      "tweet.fields": ["created_at", "public_metrics", "author_id", "in_reply_to_user_id", "conversation_id"],
      "expansions": ["author_id"],
      "user.fields": ["username"],
    };

    // Use since_id for pagination — only fetch new mentions since last check
    if (replyState.lastMentionId) {
      params.since_id = replyState.lastMentionId;
    }

    const mentions = await xClient.v2.userMentionTimeline(agent306UserId, params);

    if (!mentions.data?.data || mentions.data.data.length === 0) {
      console.log("[ReplyWatcher] Twitter API: No new mentions since last check");
      return [];
    }

    const tweets = mentions.data.data;
    const users = mentions.data.includes?.users ?? [];
    const userMap = new Map<string, string>(users.map((u: any) => [u.id, u.username]));

    // Update the since_id for next fetch (newest tweet ID)
    const newestId = tweets[0]?.id;
    if (newestId) {
      replyState.lastMentionId = newestId;
    }

    const results: CommunityReply[] = tweets
      .filter((t: any) => {
        // Skip our own tweets
        const username = userMap.get(t.author_id) ?? "";
        return username.toLowerCase() !== "agent_306";
      })
      .map((t: any) => {
        const username = userMap.get(t.author_id) ?? "unknown";
        const text = t.text ?? "";
        const metrics = t.public_metrics ?? {};

        return {
          username,
          text,
          likes: metrics.like_count ?? 0,
          replyType: classifyReply(text),
          tokenMentioned: extractTokenId(text),
          capturedAt: new Date().toISOString(),
          tweetUrl: `https://x.com/${username}/status/${t.id}`,
          tweetId: t.id,
        };
      });

    console.log(`[ReplyWatcher] Twitter API: ${results.length} mentions fetched`);
    return results;

  } catch (err: any) {
    // Handle rate limits gracefully
    if (err.code === 429 || err.rateLimit) {
      console.warn(`[ReplyWatcher] Twitter API rate limited — will retry next cycle`);
    } else {
      console.warn("[ReplyWatcher] Twitter API error:", err.message);
    }
    return [];
  }
}

// ── SOURCE 2: Grok x_search — supplementary (quote tweets, keyword mentions) ─
async function fetchMentionsViaGrok(): Promise<CommunityReply[]> {
  if (!GROK_KEY) return [];

  try {
    const res = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROK_KEY}`,
      },
      body: JSON.stringify({
        model: getModel("reply_classification"),
        stream: false,
        input: [{
          role: "user",
          content: `Search X for recent engagement with @agent306 from the last 3 hours.

PRIORITY: Always include any posts from @MrRayG that mention or engage with @agent306.
@MrRayG is the owner/operator of @agent306 — his messages are highest priority.

Focus on things the Twitter mentions API might miss:
1. All posts from @MrRayG tagging @agent306 or asking Agent 306 anything
2. Quote tweets of @agent306 posts
3. Posts mentioning "306" or "Agent 306" without directly @mentioning the account
4. Threaded conversations where @agent306 was mentioned earlier

Do NOT include direct replies or @mentions — those are already captured separately.

For each post found, classify it:
- "question": asking about tokens, mechanics, what happens next
- "lore_suggestion": suggesting story directions, contributing ideas
- "holder_mention": sharing their token, mentioning a token #ID
- "callout": tagging someone, calling attention to the project
- "excitement": hyped, celebrating, positive energy
- "general": other engagement

Extract any token numbers (e.g. #8553 → tokenMentioned: 8553).

Return JSON array (max 10):
[{
  "username": "handle without @",
  "text": "exact text",
  "likes": 0,
  "replyType": "question|lore_suggestion|holder_mention|callout|excitement|general",
  "tokenMentioned": null or number,
  "tweetUrl": "url if available"
}]`,
        }],
        tools: [{ type: "x_search" }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!res.ok) {
      console.warn("[ReplyWatcher] Grok x_search failed:", res.status);
      return [];
    }

    const data = await res.json();
    const outputMsg = data.output?.find((o: any) => o.type === "message" || o.content);
    const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text
      ?? data.output?.find((o: any) => o.text)?.text ?? "";

    if (!rawText) {
      console.log("[ReplyWatcher] Grok x_search returned empty response");
      return [];
    }

    // Parse JSON array from response
    const firstBracket = rawText.indexOf("[");
    const lastBracket = rawText.lastIndexOf("]");

    if (firstBracket === -1 || lastBracket <= firstBracket) {
      console.log("[ReplyWatcher] Grok: No JSON array found in response");
      return [];
    }

    const parsed = JSON.parse(rawText.slice(firstBracket, lastBracket + 1));
    if (!Array.isArray(parsed)) return [];

    const results: CommunityReply[] = parsed
      .filter((r: any) => r.username && r.text && r.text.length > 5)
      .map((r: any) => ({
        username: String(r.username).replace(/^@/, ""),
        text: String(r.text),
        likes: Number(r.likes ?? 0),
        replyType: r.replyType ?? "general",
        tokenMentioned: r.tokenMentioned ? Number(r.tokenMentioned) : undefined,
        capturedAt: new Date().toISOString(),
        tweetUrl: r.tweetUrl ?? "",
      }));

    console.log(`[ReplyWatcher] Grok x_search: ${results.length} supplementary mentions found`);
    return results;

  } catch (err: any) {
    console.warn("[ReplyWatcher] Grok x_search error:", err.message);
    return [];
  }
}

// ── SOURCE 3: Dedicated @MrRayG monitor — highest priority ─────────────────
// Checks for any recent posts from @MrRayG mentioning @agent306 or Agent 306.
// This catches "DM-style" mentions, questions, and prompts from the operator.
// Also detects non-ecosystem topics that Agent 306 should research and respond to.
async function fetchMrRayGMentions(): Promise<CommunityReply[]> {
  if (!GROK_KEY) return [];
  try {
    const res = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROK_KEY}` },
      body: JSON.stringify({
        model: getModel("reply_classification"),
        stream: false,
        input: [{
          role: "user",
          content: `Search X for ALL recent posts from @MrRayG from the last 24 hours.

I need every post from @MrRayG, especially:
1. Any post that @mentions @agent306 or asks Agent 306 anything
2. Any post sharing articles, news, or tech/AI content (even if not mentioning @agent306)
3. Any direct message-style posts addressed to @agent306
4. Any post about AI, technology, blockchain, NFTs, or anything @MrRayG seems to want Agent 306 to know about

Return JSON array:
[{
  "username": "MrRayG",
  "text": "exact full post text",
  "likes": 0,
  "replyType": "question|lore_suggestion|holder_mention|callout|excitement|general",
  "tokenMentioned": null or number,
  "tweetUrl": "url if available",
  "topicType": "ecosystem|ai|tech|crypto|general",
  "needsResearch": true or false (true if Agent 306 would benefit from x_search before replying)
}]`,
        }],
        tools: [{ type: "x_search" }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const outputMsg = data.output?.find((o: any) => o.type === "message");
    const rawText = outputMsg?.content?.find((c: any) => c.type === "output_text")?.text ?? "";
    if (!rawText) return [];

    const firstBracket = rawText.indexOf("[");
    const lastBracket = rawText.lastIndexOf("]");
    if (firstBracket === -1) return [];

    const parsed = JSON.parse(rawText.slice(firstBracket, lastBracket + 1));
    if (!Array.isArray(parsed)) return [];

    const results: CommunityReply[] = parsed
      .filter((r: any) => r.text && r.text.length > 5)
      .map((r: any) => ({
        username: "MrRayG",
        text: String(r.text),
        likes: Number(r.likes ?? 0),
        replyType: r.replyType ?? "general",
        tokenMentioned: r.tokenMentioned ? Number(r.tokenMentioned) : undefined,
        capturedAt: new Date().toISOString(),
        tweetUrl: r.tweetUrl ?? "",
        isMrRayG: true,          // priority flag
        topicType: r.topicType ?? "general",
        needsResearch: r.needsResearch ?? false,
      } as any));

    if (results.length > 0) {
      console.log(`[ReplyWatcher] @MrRayG monitor: ${results.length} posts found`);
    }
    return results;
  } catch (e: any) {
    console.warn("[ReplyWatcher] MrRayG monitor error:", e.message);
    return [];
  }
}

// ── Main fetch function — combines all three sources ─────────────────────────
export async function fetchReplies(): Promise<void> {
  console.log("[ReplyWatcher] Fetching mentions from all sources...");

  // Run all three sources in parallel
  const [twitterMentions, grokMentions, mrRayGMentions] = await Promise.allSettled([
    fetchMentionsViaTwitterAPI(),
    fetchMentionsViaGrok(),
    fetchMrRayGMentions(),
  ]);

  const twitter = twitterMentions.status === "fulfilled" ? twitterMentions.value : [];
  const grok = grokMentions.status === "fulfilled" ? grokMentions.value : [];
  const mrrayg = (mrRayGMentions as any).status === "fulfilled" ? (mrRayGMentions as any).value : [];

  // Combine all new replies — @MrRayG posts get prepended (highest priority)
  const allNew = [...mrrayg, ...twitter, ...grok];

  if (allNew.length === 0) {
    console.log("[ReplyWatcher] No new mentions found from any source");
    // Still update lastFetched so we know the fetch ran
    replyState.lastFetched = new Date().toISOString();
    saveState(replyState);
    return;
  }

  // Merge with existing — dedupe by username+text snippet
  const seen = new Set(replyState.replies.map(r => `${r.username}|${r.text.slice(0, 40)}`));
  const fresh = allNew.filter(r => !seen.has(`${r.username}|${r.text.slice(0, 40)}`));

  // Keep latest 100 (up from 50), weight toward questions and lore suggestions
  replyState.replies = [...fresh, ...replyState.replies]
    .sort((a, b) => {
      const typeScore = { question: 4, lore_suggestion: 4, callout: 3, holder_mention: 3, excitement: 2, general: 1 };
      return (typeScore[b.replyType] ?? 1) - (typeScore[a.replyType] ?? 1);
    })
    .slice(0, 100);

  replyState.totalCaptured += fresh.length;
  replyState.lastFetched = new Date().toISOString();
  saveState(replyState);

  const bySource = {
    twitter: twitter.length,
    grok: grok.length,
    fresh: fresh.length,
    duplicates: allNew.length - fresh.length,
  };

  console.log(`[ReplyWatcher] ${fresh.length} new replies captured:`, bySource);
}
