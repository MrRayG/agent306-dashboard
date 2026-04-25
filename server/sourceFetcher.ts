// ─────────────────────────────────────────────────────────────────────────────
// 306 — SOURCE FETCHER
//
// Headless/paywall-aware source fetcher. Tries a plain fetch first; on
// detectable bot-wall / paywall / JS-required responses, falls back to
// Perplexity grounding so the downstream writer gets real source text
// instead of a "Enable JavaScript" stub.
//
// Motivation: on 2026-04-22 the Deep Read cron fetched a Politico article
// behind Cloudflare, got back ~58 chars of "Just a moment...", and passed
// empty content into the LLM with a prompt that licensed invention
// ("use the summary and your knowledge of this topic"). The model
// hallucinated stats, quotes, and three nonexistent AI developers.
//
// Contract: always returns a structured result; never throws.
// ─────────────────────────────────────────────────────────────────────────────

import { gatherPerplexityEvidence } from "./perplexityEvidence.js";

export type PartialFetchReason =
  | "too_short_for_domain"
  | "missing_byline_markers"
  | "missing_close_markers";

export interface SourceFetchResult {
  text:     string;
  title:    string;
  imageUrl: string;
  ok:       boolean;
  reason?:  string;
  method:   "direct" | "perplexity" | "failed";
  /**
   * Present when the direct fetch returned HTTP 200 but the extracted
   * body failed a partial-fetch heuristic (see LONG_FORM_DOMAINS and
   * detectPartialFetch below). Downstream callers may surface this to
   * the operator UI; the main fetch flow treats a partial fetch as a
   * failure and falls through to Perplexity.
   */
  partialFetchReason?: PartialFetchReason;
}

const MIN_GOOD_LENGTH = 500;

/** Byte threshold below which a long-form domain is treated as a partial fetch. */
const LONG_FORM_MIN_LENGTH = 1500;

/**
 * Domains where a <1500-char direct fetch is almost certainly a partial
 * fetch rather than an actual short page. Exported so other modules or
 * tests can extend the allowlist as new outlets get picked up. The
 * heuristic compares `new URL(url).hostname` after stripping leading
 * "www.", so list entries here should match the bare hostname.
 *
 * Motivation (2026-04-24 audit): the parent agent was bitten by a
 * partial article fetch from politico.com that looked complete but was
 * missing the byline, several quotes, and the closing paragraphs. The
 * same thing can happen to her sourceFetcher and produce false-
 * confidence drafts — so any content under LONG_FORM_MIN_LENGTH from
 * one of these domains now fails over to Perplexity.
 */
export const LONG_FORM_DOMAINS: ReadonlySet<string> = new Set([
  "politico.com",
  "nytimes.com",
  "washingtonpost.com",
  "wsj.com",
  "bloomberg.com",
  "reuters.com",
  "apnews.com",
  "theverge.com",
  "techcrunch.com",
  "sciencedaily.com",
  "nature.com",
  "science.org",
  "wired.com",
  "theatlantic.com",
  "newyorker.com",
  "economist.com",
  "ft.com",
  "arstechnica.com",
  "axios.com",
  "semafor.com",
  "theinformation.com",
  "technologyreview.com",
  "nist.gov",
  "whitehouse.gov",
]);

const FAILURE_MARKERS = [
  "enable javascript",
  "just a moment",
  "access denied",
  "subscribe to continue",
  "checking your browser",
  "please enable cookies",
  "captcha",
  "are you a human",
];

function looksLikeStub(clean: string): boolean {
  const lc = clean.toLowerCase();
  if (clean.length < MIN_GOOD_LENGTH) return true;
  return FAILURE_MARKERS.some(m => lc.includes(m));
}

function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Detect whether a raw HTTP 200 + cleaned text from a known long-form
 * domain actually looks like a partial article. Returns the failing
 * heuristic name, or null if the content looks complete enough.
 *
 * Heuristics (any one triggers partial):
 *   - too_short_for_domain: clean text < LONG_FORM_MIN_LENGTH chars
 *   - missing_byline_markers: no <meta name="author"> in raw HTML AND no
 *     "By [Capitalized Name]" pattern in the cleaned body
 *   - missing_close_markers: none of the typical closing tokens appear
 *     in the last 600 chars of the cleaned body ("Source Link", "©",
 *     "Copyright", "All rights reserved", journal-style references)
 */
export function detectPartialFetch(
  url: string,
  rawHtml: string,
  cleanText: string,
): PartialFetchReason | null {
  const domain = urlDomain(url);
  if (!LONG_FORM_DOMAINS.has(domain)) return null;

  if (cleanText.length < LONG_FORM_MIN_LENGTH) {
    return "too_short_for_domain";
  }

  const hasMetaByline = /<meta[^>]*name=["']author["']/i.test(rawHtml);
  const hasBodyByline = /\bBy\s+[A-Z][a-zA-Z.'\-]+(?:\s+[A-Z][a-zA-Z.'\-]+)+/.test(cleanText);
  if (!hasMetaByline && !hasBodyByline) {
    return "missing_byline_markers";
  }

  const tail = cleanText.slice(-600).toLowerCase();
  const closeMarkers = [
    "source link",
    "all rights reserved",
    "copyright",
    "©",  // ©
    "read more",
    "originally published",
    "journal reference",
    "this article first appeared",
  ];
  const hasCloseMarker = closeMarkers.some(m => tail.includes(m));
  if (!hasCloseMarker) {
    return "missing_close_markers";
  }

  return null;
}

function extractMeta(html: string): { title: string; imageUrl: string } {
  const titleMatch   = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i);
  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']{3,200})["']/i);
  const title = (ogTitleMatch?.[1] ?? titleMatch?.[1] ?? "").trim();

  const ogImageMatch =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']{5,500})["']/i) ??
    html.match(/<meta[^>]*content=["']([^"']{5,500})["'][^>]*property=["']og:image["']/i);
  const twitterImageMatch =
    html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']{5,500})["']/i) ??
    html.match(/<meta[^>]*content=["']([^"']{5,500})["'][^>]*name=["']twitter:image["']/i);
  const imageUrl = (ogImageMatch?.[1] ?? twitterImageMatch?.[1] ?? "").trim();
  return { title, imageUrl };
}

function cleanHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

async function tryDirectFetch(url: string): Promise<{
  ok: boolean;
  text: string;
  title: string;
  imageUrl: string;
  reason?: string;
  partialFetchReason?: PartialFetchReason;
}> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Agent306Bot/1.0)",
        "Accept":     "text/html,application/xhtml+xml",
      },
      signal:   AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) {
      return { ok: false, text: "", title: "", imageUrl: "", reason: `http ${res.status}` };
    }
    const html = await res.text();
    const { title, imageUrl } = extractMeta(html);
    const clean = cleanHtml(html);
    if (looksLikeStub(clean)) {
      return {
        ok: false,
        text: clean,
        title,
        imageUrl,
        reason: clean.length < MIN_GOOD_LENGTH
          ? `direct fetch body too short (${clean.length} chars)`
          : "direct fetch returned bot-wall / paywall stub",
      };
    }
    const partialReason = detectPartialFetch(url, html, clean);
    if (partialReason) {
      return {
        ok: false,
        text: clean,
        title,
        imageUrl,
        reason: `partial fetch: ${partialReason}`,
        partialFetchReason: partialReason,
      };
    }
    return { ok: true, text: clean, title, imageUrl };
  } catch (e: any) {
    return { ok: false, text: "", title: "", imageUrl: "", reason: `fetch error: ${e?.message ?? e}` };
  }
}

/**
 * Fetch source content from a URL. Tries a plain direct fetch first. On
 * any detectable failure, falls back to Perplexity grounding and returns
 * the grounded text only if the URL (or its domain) appears in citations.
 *
 * Never throws. Always returns a structured result. Callers MUST check
 * the `ok` field before trusting `text`.
 */
export async function fetchSourceContent(url: string): Promise<SourceFetchResult> {
  if (!url || typeof url !== "string") {
    return { text: "", title: "", imageUrl: "", ok: false, reason: "empty url", method: "failed" };
  }

  const direct = await tryDirectFetch(url);
  if (direct.ok) {
    return {
      text:     direct.text,
      title:    direct.title,
      imageUrl: direct.imageUrl,
      ok:       true,
      method:   "direct",
    };
  }

  if (direct.partialFetchReason) {
    console.warn(
      `[SourceFetcher] Direct fetch returned partial content (${direct.partialFetchReason}); falling back to Perplexity for ${url}`,
    );
  }

  // Perplexity fallback — only trust the response if its citations point
  // at the same URL (or at least the same domain). Perplexity summaries of
  // the wrong article are worse than no content, because the writer will
  // attribute claims to the wrong source.
  const domain = urlDomain(url);
  const query = `Summarize the article at this URL with verbatim quotes and key statistics: ${url}`;

  try {
    const ppx = await gatherPerplexityEvidence(query);
    if (!ppx.ok || ppx.content.length < MIN_GOOD_LENGTH) {
      return {
        text:     direct.text,
        title:    direct.title,
        imageUrl: direct.imageUrl,
        ok:       false,
        reason:   `direct: ${direct.reason}; perplexity: ${ppx.reason ?? "no content"}`,
        method:   "failed",
        partialFetchReason: direct.partialFetchReason,
      };
    }

    const citations = ppx.citations ?? [];
    const urlMatches = citations.some(c => typeof c === "string" && c.includes(url));
    const domainMatches = domain
      ? citations.some(c => typeof c === "string" && urlDomain(c) === domain)
      : false;

    if (!urlMatches && !domainMatches) {
      return {
        text:     direct.text,
        title:    direct.title,
        imageUrl: direct.imageUrl,
        ok:       false,
        reason:   `perplexity did not cite ${domain || url} (got ${citations.length} citations for other sources)`,
        method:   "failed",
        partialFetchReason: direct.partialFetchReason,
      };
    }

    return {
      text:     ppx.content,
      title:    direct.title,
      imageUrl: direct.imageUrl,
      ok:       true,
      method:   "perplexity",
      partialFetchReason: direct.partialFetchReason,
    };
  } catch (e: any) {
    return {
      text:     direct.text,
      title:    direct.title,
      imageUrl: direct.imageUrl,
      ok:       false,
      reason:   `direct: ${direct.reason}; perplexity: exception ${e?.message ?? e}`,
      method:   "failed",
      partialFetchReason: direct.partialFetchReason,
    };
  }
}
