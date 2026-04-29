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
// Why "without sources": at quarantine time the original sources used to draft
// the post are not persisted on the BlogPost. The pipeline operates on what IS
// available — the body, the verdict, any URLs already embedded in the body —
// and instructs the rewriter to either soften bare claims or drop them entirely.
// This is the same posture as the existing repairCitationLocality pass.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getPostById,
  updatePost,
  publishPost,
  type BlogPost,
} from "./blogEngine.js";
import { reviseBlogUntilClean } from "./blogReviseLoop.js";
import { checkHardBlocks } from "./blogHardBlocks.js";

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

  // Pull URLs already embedded in the body — those are the citation pool the
  // rewriter is allowed to reuse. The repair pass inside reviseBlogUntilClean
  // will not fabricate new URLs. PR #253: also fold in any persisted
  // post.sources URLs so the rewriter knows they're approved targets.
  const embeddedUrls = Array.from(new Set([
    ...extractUrls(post.content),
    ...(post.sources ?? []).map(s => s.url),
  ]));

  try {
    const result = await reviseBlogUntilClean({
      draftText:    post.content,
      // We don't have the original source text at quarantine time. Pass the
      // empty string; the verifier still runs, the rewriter still operates
      // on the verdict + the embedded URL pool. Lane B bare claims will be
      // softened or dropped rather than citation-injected from a missing source.
      sourceText:   "",
      sourceUrl:    "",
      sourceTitle:  post.title,
      extraSourceUrls: embeddedUrls,
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

    if (finalSeverity === "PASS") {
      // Persist the revised body, then publish.
      updatePost(postId, {
        content: finalBody,
        verifierReport: result.verdict.verifierReport,
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

    // PR #253: blogs are voice tier — verifier verdicts are advisory only.
    // SOFT_WARN and HARD_FAIL both land the revised body in `draft` status
    // with the verifier report attached for visibility. The ONLY path that
    // keeps a blog quarantined post-revise is the bright-line hard-block
    // list (medical/legal/financial specifics). See server/blogHardBlocks.ts
    // for the philosophy.
    const hardBlock = checkHardBlocks(finalBody);
    const newStatus: BlogPost["status"] = hardBlock.blocked ? "quarantined" : "draft";
    if (hardBlock.blocked) {
      console.error(`[BlogRevise] HARD-BLOCK quarantine ${postId}: ${hardBlock.reasons.length} pattern(s)`);
      for (const r of hardBlock.reasons) console.error(`  - ${r}`);
    }

    updatePost(postId, {
      content: finalBody,
      verifierReport: result.verdict.verifierReport,
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
