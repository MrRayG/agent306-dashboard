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

export interface SourceFetchResult {
  text:     string;
  title:    string;
  imageUrl: string;
  ok:       boolean;
  reason?:  string;
  method:   "direct" | "perplexity" | "failed";
}

const MIN_GOOD_LENGTH = 500;

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
    return { ok: true, text: clean, title, imageUrl };
  } catch (e: any) {
    return { ok: false, text: "", title: "", imageUrl: "", reason: `fetch error: ${e?.message ?? e}` };
  }
}

function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
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
      };
    }

    return {
      text:     ppx.content,
      title:    direct.title,
      imageUrl: direct.imageUrl,
      ok:       true,
      method:   "perplexity",
    };
  } catch (e: any) {
    return {
      text:     direct.text,
      title:    direct.title,
      imageUrl: direct.imageUrl,
      ok:       false,
      reason:   `direct: ${direct.reason}; perplexity: exception ${e?.message ?? e}`,
      method:   "failed",
    };
  }
}
