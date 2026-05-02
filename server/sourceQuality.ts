// ─────────────────────────────────────────────────────────────────────────────
// 306 — SOURCE QUALITY GATE (audit follow-up 2026-05-02)
//
// Shared, deterministic source-quality classifier used by every content
// engine (Blog, Article/Deep Read, Academy, Dispatch, News, Signal) BEFORE
// drafting and BEFORE handoff to the claim verifier. The hypothesis from the
// 2026-05-02 audit: a meaningful portion of verifier rejections are caused
// not by the writer hallucinating, but by drafts being grounded on weak,
// thin, or unverifiable sources in the first place. Improving the input
// reduces verifier failure pressure without weakening verification.
//
// This module is purely deterministic and side-effect-free. It does NOT
// fetch anything, does NOT call the LLM, and has no IO. It classifies a
// SourceObject (server/sourceLocality.ts) into one of four tiers:
//
//   - reputable      — primary or authoritative source with clear provenance.
//                      Examples: NYT, WSJ, OpenAI blog, Stanford HAI, *.gov.
//   - acceptable     — niche but recognizable source. Not on the reputable
//                      allowlist but the URL is well-formed and not on a
//                      hard-block list. Engine policy decides whether to
//                      use as primary or only supplementary.
//   - unverified     — looks like a real source but key signals are missing
//                      (e.g. an X/Twitter post with no follower count, a
//                      bare URL with no publisher / title metadata). Engine
//                      should treat as needs_review unless overridden.
//   - low_quality    — actively de-prioritized: known-low-quality outlets,
//                      X/Twitter posts from sub-10k-follower accounts when
//                      the count IS known, or hard-blocked patterns.
//
// X/Twitter rule (operator request, 2026-05-02):
//   - Above 10k followers when count is available → reputable IF on the
//     X allowlist (KNOWN_HANDLES) OR has verified=true; else acceptable.
//   - Below 10k followers when count is available → low_quality.
//   - Follower count UNAVAILABLE → unverified (do NOT silently treat as
//     high-quality). This is the "soft-fail" path the operator requested:
//     engines may still draft from it but mark manualReviewRequired.
//
// Resource/channel rule:
//   - Domains on REPUTABLE_DOMAINS (extends LONG_FORM_DOMAINS plus a
//     hand-curated additions list) → reputable.
//   - Domains on BLOCKED_DOMAINS (conservative, defaults empty) →
//     low_quality. The repo intentionally does not hardcode a long
//     opinion-driven blocklist; operator extends as needed.
//   - Otherwise → acceptable.
//
// Override path: every engine that already has a manual-review or
// operator-override concept (Blog publish-after-edit, Article extraSources,
// Academy mark-posted) preserves it. This module never throws, never
// blocks; it only tags. The engine decides what to do with the tag.
// ─────────────────────────────────────────────────────────────────────────────

import type { SourceObject } from "./sourceLocality.js";
import { LONG_FORM_DOMAINS } from "./sourceFetcher.js";

export type SourceTier = "reputable" | "acceptable" | "unverified" | "low_quality";

/** X / Twitter follower threshold — operator policy 2026-05-02. */
export const X_FOLLOWER_FLOOR = 10_000;

/**
 * Reputable-by-default domain allowlist. Conservative and explicit — operator
 * extends as new outlets are vetted. Inherits LONG_FORM_DOMAINS from the
 * existing partial-fetch heuristic (those are already vetted as long-form
 * primary sources) and adds primary / authoritative additions used by the
 * research pipeline today.
 *
 * Edit policy: only add a domain here when it is (a) a primary source for
 * its claims (research lab blog, government, academic press) OR (b) an
 * outlet with a public corrections process. Avoid hardcoding personal
 * preferences — when in doubt, leave it as "acceptable" and let the
 * verifier do its job.
 */
export const REPUTABLE_DOMAINS: ReadonlySet<string> = new Set<string>([
  ...Array.from(LONG_FORM_DOMAINS),
  // Primary AI lab sources
  "openai.com",
  "anthropic.com",
  "deepmind.google",
  "ai.meta.com",
  "research.google",
  "microsoft.com",
  "blogs.microsoft.com",
  // Academic / research
  "arxiv.org",
  "nature.com",
  "science.org",
  "stanford.edu",
  "mit.edu",
  "berkeley.edu",
  "hai.stanford.edu",
  "cset.georgetown.edu",
  // Standards / government
  "nist.gov",
  "whitehouse.gov",
  "europa.eu",
  // Established trade / industry
  "ieee.org",
  "acm.org",
]);

/**
 * Hard-block list. Empty by default — the operator extends. We intentionally
 * do NOT ship an opinion-driven blocklist; the verifier already catches
 * fabrication and the source-quality gate above already de-prioritizes
 * unknowns. Only add here for sources known to publish retracted /
 * fabricated content that has caused verifier escapes in the past.
 */
export const BLOCKED_DOMAINS: ReadonlySet<string> = new Set<string>([]);

/** X / Twitter handle allowlist (mirrors knownHandles map but as bare set). */
export const X_REPUTABLE_HANDLES_LOWER: ReadonlySet<string> = new Set<string>([
  // AI labs
  "openai", "anthropicai", "googledeepmind", "metaai", "mistralai", "xai",
  "cohereai", "stabilityai", "huggingface", "perplexity_ai",
  // Companies
  "nvidia", "microsoft", "google", "amazon", "apple", "tesla",
  // Key researchers / leaders (high-signal accounts)
  "sama", "darioamodei", "demishassabis", "ylecun", "karpathy", "ilyasut",
  "satyanadella", "sundarpichai", "elonmusk",
]);

export interface QualityClassification {
  tier: SourceTier;
  reasons: string[];
  /** True iff at least one rule fired that would suppress auto-publish. */
  needsReview: boolean;
  /** When true the engine should NOT use this source as a primary citation. */
  blockedAsPrimary: boolean;
}

function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isXOrTwitter(domain: string): boolean {
  return domain === "x.com" || domain === "twitter.com" || domain === "mobile.twitter.com";
}

function extractXHandle(url: string): string | null {
  try {
    const u = new URL(url);
    if (!isXOrTwitter(u.hostname.replace(/^www\./, "").toLowerCase())) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (!seg.length) return null;
    const handle = seg[0].toLowerCase();
    // Reject reserved paths.
    if (["i", "search", "home", "explore", "notifications", "messages", "compose", "settings"].includes(handle)) {
      return null;
    }
    return handle.replace(/^@/, "");
  } catch {
    return null;
  }
}

/**
 * Classify a single SourceObject. Pure function. Caller decides whether a
 * given tier is acceptable for a given engine — e.g. Academy may accept
 * `unverified` because all Academy posts go through manual review anyway,
 * while Blog hard-blocks `low_quality` for auto-publish.
 *
 * Optional metadata fields on SourceObject (added in this PR, all optional
 * for backwards compat):
 *   - xFollowers: number  — when SourceObject came from an X/Twitter post.
 *                            Undefined = unknown (treated as unverified for X).
 *   - xVerified:  boolean — X/Twitter blue-check or equivalent.
 */
export function classifySource(src: SourceObject): QualityClassification {
  const reasons: string[] = [];
  const url = (src.url ?? "").trim();

  if (!url) {
    return {
      tier: "low_quality",
      reasons: ["empty_url"],
      needsReview: true,
      blockedAsPrimary: true,
    };
  }

  const domain = urlDomain(url);

  if (BLOCKED_DOMAINS.has(domain)) {
    reasons.push(`blocked_domain:${domain}`);
    return { tier: "low_quality", reasons, needsReview: true, blockedAsPrimary: true };
  }

  // ── X / Twitter handling ──────────────────────────────────────────────────
  if (isXOrTwitter(domain)) {
    const handle = extractXHandle(url);
    const followers = (src as any).xFollowers as number | undefined;
    const verified = (src as any).xVerified as boolean | undefined;

    if (handle && X_REPUTABLE_HANDLES_LOWER.has(handle)) {
      reasons.push(`x_allowlist_handle:${handle}`);
      return { tier: "reputable", reasons, needsReview: false, blockedAsPrimary: false };
    }

    if (typeof followers === "number") {
      if (followers >= X_FOLLOWER_FLOOR) {
        reasons.push(`x_followers:${followers}>=${X_FOLLOWER_FLOOR}`);
        return {
          tier: verified ? "reputable" : "acceptable",
          reasons,
          needsReview: false,
          blockedAsPrimary: false,
        };
      }
      reasons.push(`x_followers:${followers}<${X_FOLLOWER_FLOOR}`);
      return { tier: "low_quality", reasons, needsReview: true, blockedAsPrimary: true };
    }

    // Follower count unavailable — operator policy is "do not silently treat
    // as high-quality". Mark as unverified / needs_review.
    reasons.push("x_follower_count_unknown");
    return { tier: "unverified", reasons, needsReview: true, blockedAsPrimary: true };
  }

  // ── Domain allowlist ─────────────────────────────────────────────────────
  if (REPUTABLE_DOMAINS.has(domain)) {
    reasons.push(`reputable_domain:${domain}`);
    return { tier: "reputable", reasons, needsReview: false, blockedAsPrimary: false };
  }

  // .gov / .edu fallback — high default trust.
  if (domain.endsWith(".gov") || domain.endsWith(".edu")) {
    reasons.push(`tld_authority:${domain}`);
    return { tier: "reputable", reasons, needsReview: false, blockedAsPrimary: false };
  }

  // No publisher AND no title AND not a known domain → not enough signal to
  // call it primary. Engines can still use it as a supplementary reference.
  if (!src.publisher && !src.title) {
    reasons.push("no_publisher_or_title");
    return { tier: "unverified", reasons, needsReview: true, blockedAsPrimary: true };
  }

  reasons.push(`acceptable_domain:${domain}`);
  return { tier: "acceptable", reasons, needsReview: false, blockedAsPrimary: false };
}

export interface SourceQualityReport {
  /** Per-source classification, parallel to the input array. */
  classifications: QualityClassification[];
  /** Summary counts by tier. */
  counts: Record<SourceTier, number>;
  /** True iff at least one source landed in `reputable`. */
  hasReputableSource: boolean;
  /** True iff EVERY source is below the `acceptable` bar (i.e. no source
   *  the engine should treat as primary). The engine should soft-fail or
   *  mark manualReviewRequired in this case. */
  allBelowAcceptable: boolean;
}

/**
 * Classify a whole source pool. Used by engines to decide whether to draft
 * (have at least one acceptable+ source) or to short-circuit to manual
 * review (all sources unverified / low_quality).
 */
export function classifySourcePool(sources: SourceObject[]): SourceQualityReport {
  const classifications = sources.map(classifySource);
  const counts: Record<SourceTier, number> = {
    reputable: 0,
    acceptable: 0,
    unverified: 0,
    low_quality: 0,
  };
  for (const c of classifications) counts[c.tier] += 1;

  return {
    classifications,
    counts,
    hasReputableSource: counts.reputable > 0,
    allBelowAcceptable: classifications.length > 0 &&
      counts.reputable === 0 && counts.acceptable === 0,
  };
}
