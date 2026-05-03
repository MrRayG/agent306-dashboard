/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — BLOG PIPELINE ENTRY (Roadmap B1)
 *
 * Thin entry point that picks between the legacy `generateBlogPost` path
 * and the shared draft-production pipeline based on the
 * `BLOG_PIPELINE_ENABLED` feature flag (read at call time so per-request
 * toggling works in tests).
 *
 * Behavior:
 *   - Flag OFF (default): exact legacy path. `generateBlogPost(opts)` is
 *     called and its return value is forwarded. Zero behavioral delta.
 *   - Flag ON: the same `generateBlogPost` runs INSIDE the blog adapter,
 *     wrapped by the pipeline orchestrator so `pipeline.*` events land in
 *     engine_events. The returned BlogPost is identical to the legacy
 *     path's output — verifier severity, publish gate, source-ledger /
 *     claim-map writes are unchanged.
 *
 * This is the only call site that should branch on the flag for blog. By
 * keeping the branch in one place, B2 / B3 can flip the default ON / drop
 * the flag entirely without touching every blog caller.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  generateBlogPost,
  getPostById,
  type BlogPost,
  type BlogSource,
  type BlogType,
} from "../blogEngine.js";
import type { SourceObject } from "../sourceLocality.js";
import { readFlag } from "../featureFlags.js";
import { runDraftProductionPipeline } from "./draftProductionPipeline.js";
import { makeBlogPipelineAdapter } from "./blogAdapter.js";
import type { PipelineResult } from "./types.js";

export interface BlogPipelineEntryOpts {
  topic: string;
  sourceContent: string;
  source: BlogSource;
  sourceId?: string;
  autoPublish?: boolean;
  blogType?: BlogType;
  sourceObjects?: SourceObject[];
  /** When true the pipeline runs plan/source/claim only and does NOT
   *  invoke the writer — useful for ops to inspect the pre-draft plan.
   *  Returns `{ post: null, pipeline }` so callers can branch on the
   *  pipeline result. Always emits stage events.
   *
   *  Ignored when the flag is OFF (the legacy path has no dry-run). */
  dryRun?: boolean;
}

export interface BlogPipelineEntryResult {
  /** The final BlogPost on the published / draft / quarantined path.
   *  Null when generation failed (LLM unavailable) OR when dryRun=true. */
  post: BlogPost | null;
  /** Populated only when the pipeline path ran. Null on the legacy path
   *  so callers can detect which path served them. */
  pipeline: PipelineResult | null;
}

/**
 * Single entry point for blog generation that respects the
 * `BLOG_PIPELINE_ENABLED` feature flag. Always returns a stable result
 * shape so call sites do not need to branch on the flag themselves.
 */
export async function generateBlogPostMaybeViaPipeline(
  opts: BlogPipelineEntryOpts,
): Promise<BlogPipelineEntryResult> {
  const flagOn = readFlag("BLOG_PIPELINE_ENABLED");

  if (!flagOn) {
    if (opts.dryRun) {
      // dryRun is a pipeline-only feature — surface a clear no-op when
      // the flag is off so a caller doesn't get a real publish.
      return { post: null, pipeline: null };
    }
    const post = await generateBlogPost({
      topic: opts.topic,
      sourceContent: opts.sourceContent,
      source: opts.source,
      sourceId: opts.sourceId,
      autoPublish: opts.autoPublish,
      blogType: opts.blogType,
      sourceObjects: opts.sourceObjects,
    });
    return { post, pipeline: null };
  }

  const adapter = makeBlogPipelineAdapter();
  const pipeline = await runDraftProductionPipeline(adapter, {
    engine: "blog",
    topic: opts.topic,
    sourceContent: opts.sourceContent,
    dryRun: opts.dryRun ?? false,
    engineOpts: {
      source: opts.source,
      sourceId: opts.sourceId,
      autoPublish: opts.autoPublish,
      blogType: opts.blogType,
      sourceObjects: opts.sourceObjects,
    },
  });
  // Resolve the BlogPost via the publish stage's evidence. Post-Roadmap
  // B2 stage extraction the createBlogPost call happens inside the
  // adapter's publish stage, so the real id is on `publish.evidence.draftId`
  // (the `draft` stage reports a synthetic pre-publish id that does NOT
  // exist in blog_state.json). Falling back to `draft.draftId` keeps
  // older fixtures working when the stage layout changes again.
  const idFromPublish = pipeline.publish?.evidence?.draftId;
  const idFromDraft = pipeline.draft?.draftId;
  const draftId = idFromPublish ?? idFromDraft;
  const post = draftId ? getPostById(draftId) : null;
  return { post, pipeline };
}
