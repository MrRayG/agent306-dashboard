/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — ARTICLE PIPELINE ENTRY (Roadmap B3)
 *
 * Thin entry point that picks between the legacy Article path and the
 * shared draft-production pipeline based on the
 * `ARTICLE_PIPELINE_ENABLED` feature flag (read at call time so per-request
 * toggling works in tests).
 *
 * Behavior:
 *   - Flag OFF (default): callers use the legacy `runWeeklyDeepRead` /
 *     `previewDeepRead` / `/api/article/drafts` paths directly. This entry
 *     surfaces a clean no-op so the call site can short-circuit. Zero
 *     behavioral delta.
 *   - Flag ON: the same per-stage helpers run INSIDE the article adapter,
 *     wrapped by the pipeline orchestrator so `pipeline.*` events land in
 *     engine_events. The returned ArticleDraft is identical to the legacy
 *     path's output — verifier severity, status taxonomy, source-ledger /
 *     claim-map writes are unchanged.
 *
 * Call sites should branch on `ARTICLE_PIPELINE_ENABLED` once and route
 * through this entry. By keeping the branch in one place, future PRs can
 * flip the default ON / drop the flag entirely without touching every
 * Article caller.
 *
 * NOTE: Manuscript integration is intentionally NOT part of this PR.
 * Manuscript joins the pipeline AFTER Article has a stable pipeline shape
 * — see follow-up notes on the migration PR for sequencing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  type ArticleDraft,
  type ArticleInfo,
} from "../articleEngine.js";
import { readFlag } from "../featureFlags.js";
import { runDraftProductionPipeline } from "./draftProductionPipeline.js";
import { makeArticlePipelineAdapter, type ArticlePipelineAdapter } from "./articleAdapter.js";
import type { PipelineResult } from "./types.js";

export interface ArticlePipelineEntryOpts {
  apiKey: string;
  /** Optional override URL — skip discovery, fetch this URL directly. */
  overrideUrl?: string;
  /** Pre-fetched primary article info. When provided, the adapter skips
   *  discovery + fetch in plan and uses this verbatim. */
  articleInfo?: ArticleInfo;
  /** Pre-fetched article body. Required alongside articleInfo. */
  articleContent?: string;
  imageUrl?: string;
  /** When true the pipeline runs plan/source/claim only and does NOT
   *  invoke the writer — useful for ops to inspect the pre-draft plan.
   *  Returns `{ draft: null, pipeline }` so callers can branch on the
   *  pipeline result. Always emits stage events.
   *
   *  Ignored when the flag is OFF (the legacy path has no dry-run). */
  dryRun?: boolean;
  /** When true the pipeline runs all stages (plan/source/claim/draft/
   *  verify) and emits pipeline.* events but the publish stage skips
   *  persistence. Used by the Article Studio preview path so the operator
   *  sees full stage telemetry while preview remains non-persistent.
   *  Mutually exclusive with `dryRun` — `dryRun` wins when both are set. */
  previewMode?: boolean;
  /** Stable pipeline run id forwarded onto every stage event. Optional —
   *  the orchestrator generates one when omitted. */
  pipelineRunId?: string;
}

export interface ArticlePipelineEntryResult {
  /** The persisted Deep Read draft on the published / quarantined path.
   *  Null when the pipeline path was not taken (flag OFF) OR when
   *  dryRun=true OR previewMode=true OR an earlier stage failed. */
  draft: ArticleDraft | null;
  /** Populated only when the pipeline path ran. Null on the legacy path
   *  so callers can detect which path served them. */
  pipeline: PipelineResult | null;
  /** True iff the flag was OFF and the entry refused to run. Lets call
   *  sites cleanly fall back to their existing legacy code path. */
  flagDisabled: boolean;
  /** Populated only when `previewMode=true` and the pipeline reached the
   *  verify stage. Carries the unpersisted draft + verify state the
   *  preview wrapper needs to assemble PreviewDeepReadResult without
   *  saving anything. Null on cron / save / dryRun paths. */
  previewSnapshot: ReturnType<ArticlePipelineAdapter["getPreviewSnapshot"]> | null;
}

/**
 * Single entry point for Article generation that respects the
 * `ARTICLE_PIPELINE_ENABLED` feature flag. Always returns a stable result
 * shape so call sites do not need to branch on the flag themselves.
 *
 * When the flag is OFF, callers should fall back to their existing path
 * (`runWeeklyDeepRead` / `previewDeepRead` / etc). The entry surfaces
 * `flagDisabled=true` so that branch is unambiguous.
 */
export async function generateArticleMaybeViaPipeline(
  opts: ArticlePipelineEntryOpts,
): Promise<ArticlePipelineEntryResult> {
  const flagOn = readFlag("ARTICLE_PIPELINE_ENABLED");

  if (!flagOn) {
    return {
      draft: null,
      pipeline: null,
      flagDisabled: true,
      previewSnapshot: null,
    };
  }

  const adapter = makeArticlePipelineAdapter();
  const pipeline = await runDraftProductionPipeline(adapter, {
    engine: "article",
    topic: opts.articleInfo?.title ?? opts.overrideUrl ?? "deep_read",
    dryRun: opts.dryRun ?? false,
    pipelineRunId: opts.pipelineRunId,
    engineOpts: {
      apiKey:         opts.apiKey,
      overrideUrl:    opts.overrideUrl,
      articleInfo:    opts.articleInfo,
      articleContent: opts.articleContent,
      imageUrl:       opts.imageUrl,
      previewMode:    opts.previewMode === true && opts.dryRun !== true,
    },
  });
  return {
    draft: adapter.getPersistedDraft(),
    pipeline,
    flagDisabled: false,
    previewSnapshot:
      opts.previewMode === true && opts.dryRun !== true
        ? adapter.getPreviewSnapshot()
        : null,
  };
}
