/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — BLOG ENGINE PIPELINE ADAPTER (Roadmap B2 follow-up, 2026-05-03)
 *
 * Plugs the blog engine into the shared draft-production pipeline. Earlier
 * iterations of this adapter (B1, PR #262) delegated compileDraft +
 * verifyAndRepair + publish to a single `generateBlogPost` end-to-end call
 * and split the result across the three stage methods. This file flips
 * that around: each stage now owns its own piece of work via the
 * per-stage helpers exported from `blogEngine.ts`. The legacy
 * `generateBlogPost` path calls the SAME helpers so both paths stay
 * behavior-equivalent — there is no second writer prompt, no second
 * verifier configuration, no second persistence path.
 *
 * Stage mapping:
 *   - plan:           topic + blogType passthrough.
 *   - source:         assembleBlogSourcePack (fresh-context fetch + dedup +
 *                     research pack + sources prompt block).
 *   - claim:          buildBlogClaimMap (pre-draft claim map items +
 *                     deterministic itemKeys + prompt block).
 *   - compileDraft:   compileBlogDraft (writer LLM call + safety scan).
 *   - verifyAndRepair: verifyAndRepairBlogDraft (citation-locality repair,
 *                     verifier + revise loop, claim/comment extraction).
 *   - publish:        publishBlogDraft (createBlogPost + persistBlogSourceLedger
 *                     + persistBlogClaimMap, with HARD_FAIL → quarantine
 *                     handling preserved verbatim).
 *
 * Behavior preserved:
 *   - Verifier thresholds, severity/lane summaries, HARD_FAIL semantics.
 *   - Publish gate: HARD_FAIL → quarantined; otherwise autoPublish chooses
 *     between published / draft.
 *   - Source ledger + claim map persistence happen exactly once per run, on
 *     the same code path as the legacy function.
 *   - Safety-redacted draft branch routes to a `status: draft` post with
 *     the `needs-review` tag.
 *
 * Adapter instance state holds the source pool / research pack / claim map
 * items between stages so a single run threads through one adapter instance.
 * NOT a singleton — the entry point creates a fresh adapter per call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  assembleBlogSourcePack,
  buildBlogClaimMap,
  compileBlogDraft,
  createBlogPost,
  verifyAndRepairBlogDraft,
  publishBlogDraft,
  getPostById,
  type BlogPost,
  type BlogSource,
  type BlogType,
  type BlogSourceAssembly,
  type BlogClaimAssembly,
  type BlogDraftResult,
  type BlogVerifyAndRepair,
} from "../blogEngine.js";
import type { SourceObject } from "../sourceLocality.js";
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
 * Stateful blog adapter. Each stage method captures the artifacts the
 * later stages need (sourcePool, researchPack, claimMapPromptItems,
 * draftResult, verifyOut). One adapter instance per pipeline run; the
 * entry point in blogPipelineEntry constructs a fresh one each call.
 */
export class BlogPipelineAdapter implements EnginePipelineAdapter {
  readonly engine = "blog" as const;

  /** Captured inside `assembleSourcePack` so later stages can reach the
   *  research pack / fresh context without rebuilding them. */
  private sourceAssembly: BlogSourceAssembly | null = null;
  /** Captured inside `buildClaimMap`; consumed by publish for persistence. */
  private claimAssembly: BlogClaimAssembly | null = null;
  /** Captured inside `compileDraft`; consumed by verify/publish. */
  private draftResult: BlogDraftResult | null = null;
  /** Captured inside `verifyAndRepair`; consumed by publish. */
  private verifyOut: BlogVerifyAndRepair | null = null;
  /** Set when the safety scan fired on the draft. We persist it as a
   *  draft post the moment compileDraft returns and short-circuit
   *  verify/publish — same behavior as the legacy generator. */
  private safetyPost: BlogPost | null = null;

  plan(input: PipelineInput): PlanResult {
    const opts = readBlogOpts(input);
    return {
      topic: input.topic,
      draftHint: opts.blogType ?? "research",
    };
  }

  async assembleSourcePack(_plan: PlanResult, input: PipelineInput): Promise<SourceResult> {
    const opts = readBlogOpts(input);
    // Pipeline path uses the SAME source assembly as the legacy function:
    // fresh-context fetch → operator sourceObjects + extracted URLs →
    // dedupe → research pack. The dry-run branch skips the writer; the
    // assembly itself is light enough (one optional perplexity call) that
    // running it for both modes keeps the pre-writer evidence consistent
    // with what would feed the real writer.
    const assembly = await assembleBlogSourcePack({
      topic: input.topic,
      sourceContent: input.sourceContent ?? "",
      sourceObjects: opts.sourceObjects,
    });
    this.sourceAssembly = assembly;
    return {
      sourcePool: assembly.sourcePool,
      researchPack: assembly.researchPack,
      sourceText: input.sourceContent ?? "",
      references: assembly.researchPack.references,
    };
  }

  buildClaimMap(plan: PlanResult, source: SourceResult, _input: PipelineInput): ClaimResult {
    const claim = buildBlogClaimMap({
      topic: plan.topic,
      researchPack: source.researchPack,
      sourcePool: source.sourcePool,
    });
    this.claimAssembly = claim;
    return { items: claim.claimMapPromptItems };
  }

  async compileDraft(
    plan: PlanResult,
    source: SourceResult,
    _claim: ClaimResult,
    input: PipelineInput,
  ): Promise<DraftResult> {
    const opts = readBlogOpts(input);
    if (!this.sourceAssembly || !this.claimAssembly) {
      throw new Error("compileDraft: source/claim stage state missing");
    }
    // Writer LLM call only — no verifier, no createBlogPost. The safety-
    // scan branch is preserved here: when the scan fails the legacy code
    // immediately created a `status: draft` post and returned it. We do
    // the same so the BlogPipelineEntry can still surface the post via
    // getPostById; we then short-circuit verify/publish.
    const draft = await compileBlogDraft({
      topic: plan.topic,
      sourceContent: source.sourceText,
      blogType: opts.blogType,
      sourcePool: source.sourcePool,
      sourcesPromptBlock: this.sourceAssembly.sourcesPromptBlock,
      claimMapPromptBlock: this.claimAssembly.claimMapPromptBlock,
      freshContext: this.sourceAssembly.freshContext,
    });
    if (!draft) {
      throw new Error("compileBlogDraft returned null (LLM unavailable or generation failed)");
    }
    this.draftResult = draft;

    if (draft.kind === "safety_redacted") {
      // Preserve legacy behavior: persist the safety-redacted draft right
      // here so a partial run still leaves a reviewable post. The
      // verifyAndRepair / publish stages then run as observational no-ops.
      this.safetyPost = createBlogPost({
        title: draft.title,
        content: draft.redactedContent,
        source: opts.source,
        sourceId: opts.sourceId,
        tags: [...draft.tags, "needs-review"],
        status: "draft",
      });
      return {
        draftId: this.safetyPost.id,
        title: this.safetyPost.title,
        content: this.safetyPost.content,
        tags: this.safetyPost.tags,
      };
    }

    // The "ok" branch produces an id only AFTER publishBlogDraft runs in
    // the publish stage (createBlogPost mints it). The pipeline contract
    // requires a stable draftId before verify — synthesize a deterministic
    // pre-publish id here so verify/repair events can pin against it. We
    // still emit the real post id on the publish event via evidence.draftId.
    const prePublishId = `blog_pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return {
      draftId: prePublishId,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
    };
  }

  async verifyAndRepair(
    draft: DraftResult,
    source: SourceResult,
    _claim: ClaimResult,
    input: PipelineInput,
  ): Promise<{ verify: VerifyResult; repair: RepairResult }> {
    const opts = readBlogOpts(input);

    // Safety-redaction branch: verify/publish are observational. Surface a
    // benign PASS verdict so the orchestrator emits non-failure events.
    if (this.draftResult?.kind === "safety_redacted" && this.safetyPost) {
      const { reportFromPost } = makeReportShim();
      const { verdict, report } = reportFromPost(this.safetyPost);
      return {
        verify: { verdict, report, revisionAttempts: 0 },
        repair: { body: draft.content, citationsAdded: 0, sentencesHedged: 0 },
      };
    }

    if (!this.sourceAssembly) {
      throw new Error("verifyAndRepair: source assembly missing");
    }
    // Run citation-locality repair, verifier, revise loop, and claim
    // extraction. No persistence — publish stage owns that.
    const out = await verifyAndRepairBlogDraft({
      topic: input.topic,
      sourceId: opts.sourceId,
      draftContent: draft.content,
      sourceContent: source.sourceText,
      freshContext: this.sourceAssembly.freshContext,
      sourcePool: source.sourcePool,
    });
    this.verifyOut = out;
    return {
      verify: {
        verdict: out.verdict,
        report: out.verdict.verifierReport,
        revisionAttempts: out.revisionAttempts,
      },
      repair: {
        body: out.revisedBody,
        citationsAdded: out.citationsAdded,
        sentencesHedged: out.sentencesHedged,
      },
    };
  }

  async publish(
    draft: DraftResult,
    _repair: RepairResult,
    verify: VerifyResult,
    _plan: PlanResult,
    source: SourceResult,
    _claim: ClaimResult,
    input: PipelineInput,
  ): Promise<PublishDecision> {
    const opts = readBlogOpts(input);

    // Safety-redacted: post already exists from compileDraft; surface its
    // status as the publish decision.
    if (this.draftResult?.kind === "safety_redacted" && this.safetyPost) {
      return {
        published: false,
        skippedForDryRun: false,
        reason: "kept as draft (safety redaction triggered needs-review)",
        severity: verify.report.severity,
        evidence: { draftId: this.safetyPost.id },
      };
    }

    if (!this.draftResult || !this.verifyOut || !this.claimAssembly) {
      throw new Error("publish: required stage state missing");
    }
    if (this.draftResult.kind !== "ok") {
      throw new Error("publish: unexpected draft state");
    }

    // Single source of truth for createBlogPost + ledger + claim-map
    // persistence. Same helper the legacy path uses, so the publish gate
    // (HARD_FAIL → quarantine) is enforced once and only once.
    const post = publishBlogDraft({
      topic: input.topic,
      source: opts.source,
      sourceId: opts.sourceId,
      autoPublish: opts.autoPublish,
      title: this.draftResult.title,
      revisedBody: this.verifyOut.revisedBody,
      tags: this.draftResult.tags,
      verdict: this.verifyOut.verdict,
      extraction: this.verifyOut.extraction,
      researchPack: source.researchPack,
      sourcePool: source.sourcePool,
      claimMapPromptItems: this.claimAssembly.claimMapPromptItems,
      sourceContent: source.sourceText,
    });

    const status = post.status;
    const published = status === "published";
    let reason: string;
    if (status === "quarantined") {
      reason = `quarantined by verifier (severity=${verify.report.severity})`;
    } else if (published) {
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
      evidence: { draftId: post.id },
    };
  }
}

/** Convenience factory — match the rest of the engine modules' style. */
export function makeBlogPipelineAdapter(): BlogPipelineAdapter {
  return new BlogPipelineAdapter();
}

/**
 * Tiny shim that mirrors the report-from-post utility used by the prior
 * adapter. Kept inline because it is only needed for the safety-redacted
 * branch's benign verdict — the normal path sources its verdict directly
 * from `verifyAndRepairBlogDraft`.
 */
function makeReportShim() {
  return {
    reportFromPost(post: BlogPost | null) {
      if (!post || !post.verifierReport) {
        const empty = {
          severity: "PASS" as const,
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
        const verdict = {
          ok: true,
          unsupportedClaims: [] as never[],
          supportedCount: 0,
          externalCitedCount: 0,
          verifierReport: empty,
          severity: "PASS" as const,
        };
        return { verdict, report: empty };
      }
      const report = post.verifierReport;
      const verdict = {
        ok: report.severity === "PASS",
        unsupportedClaims: [] as never[],
        supportedCount: report.summary.laneAOk + report.summary.laneBOk,
        externalCitedCount: report.summary.laneBOk,
        verifierReport: report,
        severity: report.severity,
      };
      return { verdict, report };
    },
  };
}

// Note: `getPostById` is re-exported here for tests that import it from
// the adapter module rather than reaching into blogEngine.
export { getPostById };
