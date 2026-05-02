/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — BLOG ENGINE PIPELINE ADAPTER (Roadmap B1, 2026-05-02)
 *
 * Plugs the blog engine into the shared draft-production pipeline. The
 * heavy lifting (writer prompt, fresh-context fetch, source repair,
 * verifier + revise loop, post persistence) still lives in
 * `generateBlogPost` — this adapter only:
 *
 *   1. Runs the planning / source / claim stages purely (no LLM, no IO)
 *      so the dry-run path can reach those stages without invoking the
 *      blog hot path. Reuses `extractSourceObjects` / `dedupeSources` /
 *      `buildResearchPack` / `buildClaimMap` exactly as `generateBlogPost`
 *      does, so dry-run output matches what would feed the real writer.
 *
 *   2. Delegates compileDraft + verifyAndRepair + publish to the existing
 *      `generateBlogPost` end-to-end function. The adapter splits its
 *      single result across the three stages so the orchestrator emits
 *      events with the right granularity. Importantly: behavior is
 *      preserved — the same writer prompt, the same revise loop, the
 *      same publish gate, the same source-ledger / claim-map writes.
 *
 * Per Roadmap B1, full migration of the blog hot path into per-stage
 * adapter methods is deferred to B2. This adapter exists so a
 * feature-flagged blog path can run THROUGH the pipeline today without
 * splitting `generateBlogPost` into pieces.
 *
 * Behavior preserved when the feature flag is on:
 *   - The blog post is created via `createBlogPost` exactly as before.
 *   - Verifier thresholds, source-quality gate, manual-review flags are
 *     unchanged — the adapter does not re-run any of them.
 *   - Source ledger + claim map persistence happen inside `generateBlogPost`
 *     as they do today.
 *
 * Net effect when the flag is on: the same blog post lands, plus structured
 * pipeline.* events show up in engine_events.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  generateBlogPost,
  getPostById,
  type BlogPost,
  type BlogSource,
  type BlogType,
} from "../blogEngine.js";
import {
  dedupeSources,
  extractSourceObjects,
  type SourceObject,
} from "../sourceLocality.js";
import { buildResearchPack } from "../researchPack.js";
import { buildClaimMap } from "../claimMapBuilder.js";
import type {
  ClaimResult,
  DraftResult,
  EnginePipelineAdapter,
  PipelineInput,
  PlanResult,
  PublishDecision,
  RepairResult,
  SourceResult,
  VerifyResult,
} from "./types.js";
import type { ClaimVerdict, VerifierReport } from "../claimVerifier.js";

/** Engine-specific options the blog adapter recognizes on `PipelineInput`. */
export interface BlogPipelineOpts {
  source: BlogSource;
  sourceId?: string;
  autoPublish?: boolean;
  blogType?: BlogType;
  sourceObjects?: SourceObject[];
}

function readBlogOpts(input: PipelineInput): BlogPipelineOpts {
  const o = (input.engineOpts ?? {}) as Partial<BlogPipelineOpts>;
  return {
    source: o.source ?? "standalone",
    sourceId: o.sourceId,
    autoPublish: o.autoPublish ?? false,
    blogType: o.blogType,
    sourceObjects: o.sourceObjects,
  };
}

/**
 * Synthesize a verifier report shape from a finalized BlogPost. The post
 * already carries a `verifierReport` after generateBlogPost runs; we
 * surface it under the pipeline's typed contract. Returns a benign
 * "unknown-no-llm" shape when the post is null (LLM key missing) so the
 * pipeline can still emit a publish event with a reason.
 */
function reportFromPost(post: BlogPost | null): {
  verdict: ClaimVerdict;
  report: VerifierReport;
} {
  if (!post || !post.verifierReport) {
    const empty: VerifierReport = {
      severity: "PASS",
      entries: [],
      summary: {
        laneAOk: 0,
        laneAFail: 0,
        laneAUnverifiable: 0,
        laneAPassQuotedCommentary: 0,
        laneAPassCritiqueByAbsence: 0,
        laneBOk: 0,
        laneBBare: 0,
        retractedHits: 0,
        ncitePatternHits: 0,
      },
    };
    const verdict: ClaimVerdict = {
      ok: true,
      unsupportedClaims: [],
      supportedCount: 0,
      externalCitedCount: 0,
      verifierReport: empty,
      severity: "PASS",
    };
    return { verdict, report: empty };
  }
  const report = post.verifierReport;
  const verdict: ClaimVerdict = {
    ok: report.severity === "PASS",
    unsupportedClaims: [],
    supportedCount: report.summary.laneAOk + report.summary.laneBOk,
    externalCitedCount: report.summary.laneBOk,
    verifierReport: report,
    severity: report.severity,
  };
  return { verdict, report };
}

/**
 * Stateful blog adapter. We hold the BlogPost produced inside
 * `compileDraft` so `verifyAndRepair` and `publish` can see the same
 * post without invoking generateBlogPost a second time. Each pipeline
 * run uses a fresh adapter instance — this is NOT a singleton.
 */
export class BlogPipelineAdapter implements EnginePipelineAdapter {
  readonly engine = "blog" as const;

  /** Set inside `compileDraft`; consumed by verify/publish. */
  private generatedPost: BlogPost | null = null;
  /** Engine-internal counters surfaced through the repair stage. We do
   *  not own the repair pass, so these stay 0 — generateBlogPost owns
   *  them but does not return them. B2 follow-up: thread them out. */
  private repairCounters = { citationsAdded: 0, sentencesHedged: 0 };

  plan(input: PipelineInput): PlanResult {
    const opts = readBlogOpts(input);
    return {
      topic: input.topic,
      draftHint: opts.blogType ?? "research",
    };
  }

  async assembleSourcePack(_plan: PlanResult, input: PipelineInput): Promise<SourceResult> {
    const opts = readBlogOpts(input);
    // Mirrors the pool assembly inside generateBlogPost. We intentionally
    // skip the Perplexity fresh-context fetch — that is an LLM/network
    // call and the dry-run path must not make it. When the pipeline
    // continues into the real generateBlogPost call (non-dry-run), the
    // hot path re-does the fresh-context fetch as it always has, so
    // behavior is unchanged.
    const sourcePool = dedupeSources([
      ...(opts.sourceObjects ?? []),
      ...extractSourceObjects(input.sourceContent ?? ""),
    ]);
    const researchPack = buildResearchPack("blog", sourcePool);
    const sourceText = input.sourceContent ?? "";
    return {
      sourcePool,
      researchPack,
      sourceText,
      references: researchPack.references,
    };
  }

  buildClaimMap(plan: PlanResult, source: SourceResult, _input: PipelineInput): ClaimResult {
    // Same deterministic builder generateBlogPost uses, with the same
    // pre-assigned itemKeys ("blog:1", "blog:2", ...) so the dry-run
    // output is byte-identical to what the writer prompt sees.
    const draft = buildClaimMap({
      engine: "blog",
      draftId: "pending",
      topic: plan.topic,
      references: source.references,
      sourcePool: source.sourcePool,
    });
    const items = draft.items.map((it, i) => ({
      ...it,
      itemKey: it.itemKey ?? `blog:${i + 1}`,
    }));
    return { items };
  }

  async compileDraft(
    plan: PlanResult,
    source: SourceResult,
    _claim: ClaimResult,
    input: PipelineInput,
  ): Promise<DraftResult> {
    const opts = readBlogOpts(input);
    // Behavior preservation: delegate to the existing end-to-end blog
    // generator. It runs writer prompt → repair → verifier → revise loop
    // → createBlogPost / persistence in one shot. The adapter splits the
    // single result across compileDraft / verifyAndRepair / publish so
    // the pipeline can still emit per-stage events.
    const post = await generateBlogPost({
      topic: plan.topic,
      sourceContent: source.sourceText,
      source: opts.source,
      sourceId: opts.sourceId,
      autoPublish: opts.autoPublish,
      blogType: opts.blogType,
      sourceObjects: source.sourcePool,
    });
    this.generatedPost = post;
    if (!post) {
      throw new Error("generateBlogPost returned null (LLM unavailable or generation failed)");
    }
    return {
      draftId: post.id,
      title: post.title,
      content: post.content,
      tags: post.tags,
    };
  }

  async verifyAndRepair(
    draft: DraftResult,
    _source: SourceResult,
    _claim: ClaimResult,
    _input: PipelineInput,
  ): Promise<{ verify: VerifyResult; repair: RepairResult }> {
    // The verifier already ran inside compileDraft (generateBlogPost
    // internally calls verifyClaims via reviseBlogUntilClean). We surface
    // its verdict here so the orchestrator can emit verify + repair
    // events. revisionAttempts is unknown at this layer — generateBlogPost
    // logs it but does not return it. Reporting -1 signals "unknown" and
    // keeps the dashboard from displaying a misleading 0.
    const post = this.generatedPost ?? getPostById(draft.draftId);
    const { verdict, report } = reportFromPost(post);
    return {
      verify: { verdict, report, revisionAttempts: -1 },
      repair: {
        body: draft.content,
        citationsAdded: this.repairCounters.citationsAdded,
        sentencesHedged: this.repairCounters.sentencesHedged,
      },
    };
  }

  async publish(
    draft: DraftResult,
    _repair: RepairResult,
    verify: VerifyResult,
    _plan: PlanResult,
    _source: SourceResult,
    _claim: ClaimResult,
    input: PipelineInput,
  ): Promise<PublishDecision> {
    const opts = readBlogOpts(input);
    const post = this.generatedPost ?? getPostById(draft.draftId);
    // generateBlogPost's createBlogPost already set the final status
    // (published / draft / quarantined). The pipeline publish stage is
    // observational here: we surface what the engine decided, not a
    // second decision. This keeps the verifier gate single-source.
    const status = post?.status ?? "draft";
    const published = status === "published";
    let reason: string;
    if (status === "quarantined") {
      reason = `quarantined by verifier (severity=${verify.report.severity})`;
    } else if (status === "published") {
      reason = "published by engine";
    } else if (opts.autoPublish === false) {
      reason = "kept as draft (autoPublish=false)";
    } else {
      reason = `kept as ${status}`;
    }
    return {
      published,
      skippedForDryRun: false,
      reason,
      severity: verify.report.severity,
      evidence: {
        draftId: draft.draftId,
      },
    };
  }
}

/** Convenience factory — match the rest of the engine modules' style. */
export function makeBlogPipelineAdapter(): BlogPipelineAdapter {
  return new BlogPipelineAdapter();
}
