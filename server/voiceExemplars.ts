/**
 * ─────────────────────────────────────────────────────────────
 *  VOICE EXEMPLARS — few-shot her own best work back at her
 *
 *  The Apr 17 self-eval flagged Voice Evolution at 23.9/100 and
 *  directed: "lean harder into what's working in your top-performing
 *  posts." The blog/article/podcast prompts currently assemble rules
 *  (voice.ts + voiceInstructions.ts) + fresh context but never show
 *  Agent 306 her own best past work. This module fixes that by
 *  injecting 2-3 exemplars as few-shot anchors before generation.
 *
 *  Signal priority (per content type):
 *    - reply / tweet  → engagement score from memoryEngine.performance.lessons
 *    - blog           → most-recent published posts (quality floor — no
 *                       engagement signal is tracked for long-form yet)
 *    - article        → most-recent article history entries
 *    - podcast        → most-recent published episodes
 *
 *  This is additive only — voice.ts and voiceInstructions.ts are
 *  untouched. Failures return [] so the prompt stays coherent when
 *  there is no history (new deploy, empty state).
 * ─────────────────────────────────────────────────────────────
 */

// NOTE: state getters are loaded dynamically to avoid circular imports
// (blogEngine/articleEngine/podcastEngine all end up importing this module back).
import { performance as performanceMemory } from "./memoryEngine.js";

export type ExemplarContentType = "blog" | "article" | "podcast" | "reply";

export interface Exemplar {
  title: string;
  excerpt: string;
  tags?: string[];
  why_it_worked?: string;
}

interface GetTopPerformersOpts {
  contentType: ExemplarContentType;
  limit?: number;
}

/** First N sentences (up to ~maxChars) of a string. */
function firstSentences(text: string, maxSentences = 3, maxChars = 320): string {
  if (!text) return "";
  const stripped = text.replace(/^#+\s.*$/gm, "").replace(/[*_`]/g, "").trim();
  const parts = stripped.match(/[^.!?]+[.!?]+/g) ?? [stripped];
  let out = parts.slice(0, maxSentences).join(" ").trim();
  if (out.length > maxChars) out = out.slice(0, maxChars).trim() + "…";
  return out;
}

async function blogExemplars(limit: number): Promise<Exemplar[]> {
  try {
    const { getPublishedPosts } = await import("./blogEngine.js");
    const posts = getPublishedPosts(limit);
    return posts.map(p => ({
      title: p.title,
      excerpt: firstSentences(p.content),
      tags: p.tags,
      why_it_worked: "most recent published — quality floor (no engagement signal tracked for long-form yet)",
    })).filter(e => e.title && e.excerpt);
  } catch {
    return [];
  }
}

async function articleExemplars(limit: number): Promise<Exemplar[]> {
  try {
    const { getArticleState } = await import("./articleEngine.js");
    const state = getArticleState();
    const history = state.history ?? [];
    // Most recent first
    const sorted = [...history].sort((a, b) =>
      new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
    );
    return sorted.slice(0, limit).map(a => ({
      title: a.headline || a.sourceTitle,
      excerpt: firstSentences(a.articleText ?? ""),
      why_it_worked: "most recent article — quality floor",
    })).filter(e => e.title && e.excerpt);
  } catch {
    return [];
  }
}

async function podcastExemplars(limit: number): Promise<Exemplar[]> {
  try {
    const { getPodcastState } = await import("./podcastEngine.js");
    const state = getPodcastState();
    const published = (state.episodes ?? [])
      .filter(ep => ep.status === "published" && ep.script)
      .sort((a, b) =>
        new Date(b.publishedAt ?? b.createdAt).getTime() -
        new Date(a.publishedAt ?? a.createdAt).getTime()
      );
    return published.slice(0, limit).map(ep => ({
      title: ep.title,
      excerpt: firstSentences(ep.script?.coldOpen ?? ep.script?.actOne ?? ""),
      why_it_worked: "most recent published episode — quality floor",
    })).filter(e => e.title && e.excerpt);
  } catch {
    return [];
  }
}

function replyExemplars(limit: number): Exemplar[] {
  // performanceMemory is a live binding from memoryEngine; no circular import risk.
  try {
    const lessons = [...(performanceMemory?.lessons ?? [])]
      .filter(l => l.tweetText && l.tweetText.trim().length > 20)
      .sort((a, b) => {
        // Prioritize score, then engagement sum
        if (b.score !== a.score) return b.score - a.score;
        const aEng = (a.engagement?.likes ?? 0) + (a.engagement?.retweets ?? 0);
        const bEng = (b.engagement?.likes ?? 0) + (b.engagement?.retweets ?? 0);
        return bEng - aEng;
      });
    return lessons.slice(0, limit).map(l => ({
      title: `EP${l.episodeId}`,
      excerpt: firstSentences(l.tweetText, 4, 400),
      tags: l.tags,
      why_it_worked: `score ${l.score}/10, ${l.engagement?.likes ?? 0} likes${l.engagement?.retweets ? `, ${l.engagement.retweets} RTs` : ""}`,
    })).filter(e => e.title && e.excerpt);
  } catch {
    return [];
  }
}

/**
 * Return up to `limit` Exemplars for the given content type.
 * Returns [] when no history exists — callers must handle the empty case.
 */
export async function getTopPerformers(opts: GetTopPerformersOpts): Promise<Exemplar[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
  switch (opts.contentType) {
    case "blog":    return await blogExemplars(limit);
    case "article": return await articleExemplars(limit);
    case "podcast": return await podcastExemplars(limit);
    case "reply":   return replyExemplars(limit);
    default:        return [];
  }
}

/**
 * Format exemplars as a prompt block. Returns "" when the list is empty
 * so callers can safely concatenate it without dangling headers.
 *
 * Example output:
 *   ## Your best recent blog work (learn from what resonated):
 *
 *   1. "Title"
 *      Opening: "first 2-3 sentences"
 *      Why it worked: <note>
 *
 *   Now write a new blog post in this voice — not copying the topic, but
 *   matching the rhythm, the sharpness, the specificity.
 */
export function formatExemplarBlock(
  exemplars: Exemplar[],
  contentType: ExemplarContentType,
): string {
  if (!exemplars.length) return "";

  const label = contentType === "reply" ? "reply" : contentType;
  const plural = contentType === "reply" ? "replies" : `${contentType} work`;

  const header = `## Your best recent ${plural} (learn from what resonated):`;
  const body = exemplars.map((e, i) => {
    const lines = [`${i + 1}. "${e.title}"`];
    if (e.excerpt) lines.push(`   Opening: "${e.excerpt}"`);
    if (e.why_it_worked) lines.push(`   Why it worked: ${e.why_it_worked}`);
    return lines.join("\n");
  }).join("\n\n");

  const close = `Now write a new ${label} in this voice — not copying the topic, but matching the rhythm, the sharpness, the specificity.`;

  return `${header}\n\n${body}\n\n${close}`;
}

// Feature flag: the few-shot exemplar loop anchors prompts on Agent 306's last
// 3 published posts. That's only a quality signal once engagement data is dense
// enough to filter for her actual top performers — otherwise "most recent"
// reinforces whatever just shipped, regardless of quality. Default OFF until
// we have >=3 posts above a defined engagement bar.
const EXEMPLARS_ENABLED =
  (process.env.VOICE_EXEMPLARS_ENABLED ?? "false").toLowerCase() === "true";

/** Convenience: fetch + format in one call. Returns "" when no exemplars. */
export async function buildExemplarBlock(
  opts: GetTopPerformersOpts,
): Promise<string> {
  if (!EXEMPLARS_ENABLED) return "";
  const exemplars = await getTopPerformers(opts);
  return formatExemplarBlock(exemplars, opts.contentType);
}
