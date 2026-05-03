// ─────────────────────────────────────────────────────────────────────────────
// 306 — BLOG REVISE PIPELINE (PR #252)
//
// Drives a verdict-aware revision of a quarantined or draft blog post WITHOUT
// requiring the operator to compose a fix prompt by hand. Reads the persisted
// verifier report off the post, hands it to reviseBlogUntilClean as a single
// targeted attempt, then either:
//   • severity=PASS → publish the post and persist the new body
//   • severity=SOFT_WARN → save updated draft, keep status=draft for human review
//   • severity=HARD_FAIL → save updated draft, keep status=quarantined with
//                          the new verdict so the next attempt has fresher data
//
// Three call surfaces share this pipeline:
//   1. POST /api/blog/revise/:id — manual "Revise" button on the dashboard
//   2. /blog revise <draftId> chat slash command
//   3. Auto-revise hook in the auto-publish gate (bounded retry on quarantine)
//
// Source hydration (PR #266): when a `source_ledger` row exists for the post,
// the pipeline composes the ledger's title/publisher/excerpt blocks into the
// verifier's `sourceText` argument and forwards the http(s) URLs as the
// reviser's citation pool. This closes a gap where manual revise hard-failed
// with `no source text provided to verify attribution` even though the
// original draft was generated against a real ledger. Falls back to the
// legacy empty-source posture when no ledger exists (older posts) — Lane B
// bare claims are still softened or dropped rather than citation-injected
// from a missing source. Verifier strictness and publish gate are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getPostById,
  updatePost,
  publishPost,
  type BlogPost,
} from "./blogEngine.js";
import { reviseBlogUntilClean } from "./blogReviseLoop.js";
import { extractClaimsAndComments } from "./claimExtractor.js";
import {
  getLedgerByDraft,
  buildSourceContextForVerifier,
  listLedgerSourceUrls,
} from "./repositories/sourceLedgerRepository.js";
import type { SourceObject } from "./sourceLocality.js";

/** Pull every http(s) URL out of a block of markdown/text. Used to seed the
 *  rewriter's citation pool from URLs already embedded in the post. */
function extractUrls(text: string): string[] {
  if (!text) return [];
  const re = /https?:\/\/[^\s\)\]\>"]+/gi;
  const out = new Set<string>();
  for (const m of text.matchAll(re)) {
    // Strip trailing punctuation that's almost always not part of the URL.
    out.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return Array.from(out);
}

/**
 * Hydrated source context the manual revise path forwards to
 * `reviseBlogUntilClean`. PR #266 — exported so tests can exercise the
 * ledger-hydration logic without standing up the verifier or rewriter
 * LLM. Pre-#266 callers always saw `sourceText: ""` / `sourceObjects: []`;
 * now this helper reads the persisted ledger and produces a populated
 * bundle when available, falling back to the legacy empty-source posture
 * otherwise.
 */
export interface ReviseSourceContext {
  /** Composed `title — publisher\nexcerpt` bundle for the verifier. Empty
   *  string when no ledger / no items exist. */
  sourceText: string;
  /** Primary source URL (http(s) only). Empty string for synthetic-only
   *  ledgers or no ledger. */
  sourceUrl: string;
  /** Title to surface to the rewriter. Falls back to the post title. */
  sourceTitle: string;
  /** http(s)-only structured source objects from the ledger. Synthetic
   *  internal:// items are filtered so the rewriter never tries to use
   *  them as a citation target. */
  sourceObjects: SourceObject[];
  /** Union of body-embedded URLs and ledger http(s) URLs. Synthetic
   *  internal:// items are excluded by `listLedgerSourceUrls`. */
  extraSourceUrls: string[];
}

/**
 * Build the revise loop's source context from the persisted source ledger
 * row (engine='blog', draftId=postId) plus URLs already embedded in the
 * post body. Pure modulo the ledger DB read. Exported for tests. Falls
 * back to the legacy empty-source posture when no ledger exists.
 */
export function buildReviseSourceContext(opts: {
  postId: string;
  postContent: string;
  postTitle: string;
}): ReviseSourceContext {
  const embeddedUrls = extractUrls(opts.postContent);
  const ledger = getLedgerByDraft("blog", opts.postId);
  const ledgerItems = ledger?.items ?? [];
  const ledgerSourceText = ledgerItems.length > 0
    ? buildSourceContextForVerifier(ledgerItems)
    : "";
  const ledgerSourceUrls = listLedgerSourceUrls(ledgerItems);
  const ledgerSourceObjects: SourceObject[] = ledgerItems
    .filter(i => /^https?:\/\//i.test(i.url ?? ""))
    .map(i => ({
      url: i.url,
      title: i.title ?? undefined,
      publisher: i.publisher ?? undefined,
      evidenceExcerpt: i.excerpt ?? undefined,
    }));
  const ledgerPrimary = ledgerItems.find(i => i.sourceType === "primary") ?? ledgerItems[0];
  const sourceUrl =
    ledgerPrimary && /^https?:\/\//i.test(ledgerPrimary.url ?? "")
      ? ledgerPrimary.url
      : "";
  const sourceTitle = ledgerPrimary?.title ?? opts.postTitle;
  return {
    sourceText: ledgerSourceText,
    sourceUrl,
    sourceTitle,
    sourceObjects: ledgerSourceObjects,
    extraSourceUrls: Array.from(new Set([...embeddedUrls, ...ledgerSourceUrls])),
  };
}

export type ReviseOutcome =
  | "published"      // verifier passed, post is now live
  | "updated_draft"  // verifier soft-warned or still failed; saved as updated draft
  | "no_action"      // post already passes verifier or is already published
  | "error";

export interface ReviseQuarantinedResult {
  found: boolean;
  outcome: ReviseOutcome;
  postId?: string;
  title?: string;
  /** Final verifier severity after the revise loop. */
  severity?: "PASS" | "SOFT_WARN" | "HARD_FAIL";
  /** Number of unsupported claims in the FINAL verdict (after revision). */
  unsupportedCount?: number;
  /** Number of revise attempts the loop ran (0 if the input already passed). */
  attempts?: number;
  /** The new post body (truncated for response). Useful for the dashboard
   *  to show a diff preview without a second fetch. */
  bodyPreview?: string;
  error?: string;
}

/**
 * Revise a single quarantined or draft blog post in place.
 *
 * Idempotency: calling this on an already-published post is a no-op.
 * Calling it on a draft that already passes the verifier is a no-op.
 * Calling it on a quarantined post that is unrecoverable returns
 * outcome="updated_draft" with the new (still-failing) verdict so the
 * operator can see what changed.
 */
export async function reviseQuarantinedBlogPost(postId: string): Promise<ReviseQuarantinedResult> {
  const post = getPostById(postId);
  if (!post) {
    return { found: false, outcome: "error", error: "post-not-found" };
  }

  if (post.status === "published") {
    return {
      found: true,
      outcome: "no_action",
      postId,
      title: post.title,
      error: "already-published",
    };
  }

  if (!post.verifierReport) {
    // Defensive: a draft without a stored verdict can't be revised by this
    // pipeline because we don't know what "fix" means. Return no_action so
    // the caller knows to either publish manually or regenerate.
    return {
      found: true,
      outcome: "no_action",
      postId,
      title: post.title,
      error: "no-verifier-report-on-post",
    };
  }

  // PR #266 — hydrate verifier/reviser source context from the persisted
  // source ledger. Pre-#266 this path passed `sourceText: ""` and
  // `sourceObjects: []`, which produced the
  // `no source text provided to verify attribution` Lane A failure even
  // when the original draft was generated against a real ledger row.
  // `buildReviseSourceContext` reads the ledger and falls back to the
  // legacy empty-source posture when none exists.
  const ctx = buildReviseSourceContext({
    postId,
    postContent: post.content,
    postTitle: post.title,
  });
  const ledgerSourceObjects = ctx.sourceObjects;

  try {
    const result = await reviseBlogUntilClean({
      draftText:    post.content,
      // Hydrate from ledger when available; legacy empty-source posture
      // otherwise. Lane B bare claims are still softened/dropped when no
      // citation target is available — the verifier strictness and
      // publish gate are unchanged.
      sourceText:    ctx.sourceText,
      sourceUrl:     ctx.sourceUrl,
      sourceTitle:   ctx.sourceTitle,
      sourceObjects: ctx.sourceObjects,
      extraSourceUrls: ctx.extraSourceUrls,
      // Single bounded attempt for the revise pipeline so this stays cheap.
      // The original 3-attempt loop already ran during generation; if that
      // loop couldn't fix it then either the verdict has stale info (the
      // common case) or the body has structural issues no rewriter can fix.
      maxAttempts:  1,
      operatorNote:
        "This post was previously quarantined or saved as a draft after the verifier flagged unsupported claims. " +
        "Use the verifier report to fix ONLY the failing sentences. Prefer adding an inline markdown citation drawn " +
        "from URLs already in the post; if no source is available, soften the claim (\"reportedly\", \"some estimates\") " +
        "or drop the unsupported fact. Keep every other sentence verbatim. Do NOT fabricate URLs.",
    });

    const finalSeverity = result.verdict.severity;
    const finalBody = result.body;
    const unsupportedCount = result.verdict.unsupportedClaims.length;

    // Recompute structured claims + editor comments off the post-revision
    // verdict so the dashboard sees the FRESH list of failing sentences,
    // not the stale ones from before the rewrite. PR #266: pass the
    // ledger source objects through so publisher metadata is populated
    // when available. Falls back to URL-only recovery from the body for
    // older posts with no ledger.
    const extraction = extractClaimsAndComments(
      finalBody,
      result.verdict.verifierReport,
      ledgerSourceObjects,
    );

    if (finalSeverity === "PASS") {
      // Persist the revised body, then publish.
      updatePost(postId, {
        content: finalBody,
        verifierReport: result.verdict.verifierReport,
        claims: extraction.claims,
        references: extraction.references,
        citationMap: extraction.citationMap,
        editorComments: extraction.editorComments,
        manualReviewRequired: extraction.manualReviewRequired,
        manualPublishAllowed: extraction.manualPublishAllowed,
        status: "draft",
      } as Partial<BlogPost>);
      const published = publishPost(postId);
      return {
        found: true,
        outcome: published ? "published" : "updated_draft",
        postId,
        title: post.title,
        severity: finalSeverity,
        unsupportedCount,
        attempts: result.revisionHistory.length,
        bodyPreview: finalBody.slice(0, 800),
      };
    }

    // SOFT_WARN or HARD_FAIL: persist the (likely improved) body and the new
    // verdict, leave status appropriate for human review. SOFT_WARN drops to
    // "draft" so MrRayG can publish manually after eyeballing it; HARD_FAIL
    // stays "quarantined".
    const newStatus: BlogPost["status"] =
      finalSeverity === "SOFT_WARN" ? "draft" : "quarantined";

    updatePost(postId, {
      content: finalBody,
      verifierReport: result.verdict.verifierReport,
      claims: extraction.claims,
      references: extraction.references,
      citationMap: extraction.citationMap,
      editorComments: extraction.editorComments,
      manualReviewRequired: extraction.manualReviewRequired,
      manualPublishAllowed: extraction.manualPublishAllowed,
      status: newStatus,
    } as Partial<BlogPost>);

    return {
      found: true,
      outcome: "updated_draft",
      postId,
      title: post.title,
      severity: finalSeverity,
      unsupportedCount,
      attempts: result.revisionHistory.length,
      bodyPreview: finalBody.slice(0, 800),
    };
  } catch (e: any) {
    return {
      found: true,
      outcome: "error",
      postId,
      title: post.title,
      error: e?.message ?? String(e),
    };
  }
}
