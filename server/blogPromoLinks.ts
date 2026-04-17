/**
 * Blog promo link helpers.
 *
 * Used by dailyCycleEngine.ts when it queues the X + Farcaster promos for a
 * freshly-published blog post. Prior to this module, promos either had no
 * URL at all (when the LLM forgot) or only had a bare `agent306.ai`, which
 * made it impossible for readers to tell which blog the promo was for. The
 * helpers here guarantee every promo ends with a per-post deep link like
 *   https://agent306.ai/blog/<slug>
 * so the promo is always correctly attributable and one click away from
 * the actual piece.
 */
export const BLOG_SITE_HOST = "agent306.ai";

/** Matches bare `agent306.ai` only when it is NOT already part of a blog deep-link. */
const BARE_SITE_RE = /(?<!\/)\bagent306\.ai(?!\/\S)/gi;

/**
 * Build the canonical public URL for a blog post.
 *
 * Always returns a usable string — if the post object is missing fields, we
 * fall back to the homepage. Callers should treat the return value as the
 * single source of truth for the promo link.
 */
export function buildBlogUrl(post: { slug?: string | null } | null | undefined): string {
  const slug = typeof post?.slug === "string" ? post!.slug.trim() : "";
  if (!slug) return `https://${BLOG_SITE_HOST}`;
  return `https://${BLOG_SITE_HOST}/blog/${slug}`;
}

/**
 * Ensure the promo text ends with the blog deep-link.
 *
 * Behavior matrix:
 * - Text already contains the exact `blogUrl` → returned unchanged.
 * - Text contains a bare `agent306.ai` (no path) → that token is upgraded to
 *   the deep-link in place, preserving the LLM's chosen placement.
 * - Text contains a different blog deep-link (wrong slug) → strip that
 *   deep-link and append the correct one at the end so we never ship the
 *   wrong URL.
 * - Text has no link at all → append the deep-link on a fresh line.
 *
 * Also trims any trailing whitespace before appending.
 */
export function ensureBlogDeepLink(text: string, blogUrl: string): string {
  if (!text) return blogUrl;

  // Case 1: already has the exact URL we want — done.
  if (text.includes(blogUrl)) return text;

  // Case 2: upgrade a bare `agent306.ai` to the deep-link. This preserves the
  // LLM's chosen placement (e.g. at end of sentence, after a newline).
  if (BARE_SITE_RE.test(text)) {
    // Reset lastIndex since the regex is global.
    BARE_SITE_RE.lastIndex = 0;
    return text.replace(BARE_SITE_RE, blogUrl);
  }

  // Case 3: strip any other `agent306.ai/...` deep-link the LLM may have
  // invented, so we don't ship a broken or wrong-slug URL alongside the
  // correct one.
  const stripped = text.replace(/https?:\/\/agent306\.ai\/\S+/gi, "")
                       .replace(/\bagent306\.ai\/\S+/gi, "")
                       .trimEnd();

  // Case 4: append the correct deep-link.
  return `${stripped}\n\n${blogUrl}`;
}
