/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — ARTICLE / DEEP READ PIPELINE ADAPTER (Roadmap B3, 2026-05-03)
 *
 * Plugs the Article (Weekly Deep Read) engine into the shared
 * draft-production pipeline. Mirrors the Blog adapter structure (PR #264)
 * — each stage owns its own piece of work via the per-stage helpers
 * exported from `articleEngine.ts`. The legacy cron / preview / manual-
 * save paths continue to call the SAME helpers (or stay on the unchanged
 * legacy code path when ARTICLE_PIPELINE_ENABLED=false), so behavior is
 * preserved end-to-end.
 *
 * Stage mapping:
 *   - plan:           topic = primary article title; draftHint = "deep_read".
 *                     Discovery (or override URL fetch) + content fetch run
 *                     here so claim/source stages have real evidence.
 *   - source:         assembleArticleSourcePack — primary article anchor +
 *                     extracted URLs from body, deduped + research pack.
 *   - claim:          buildArticleClaimMapAssembly — pre-draft claim map
 *                     items (article:1, article:2, …) + prompt block.
 *   - compileDraft:   compileArticleDraft — writer LLM call.
 *   - verifyAndRepair: verifyAndRepairArticleDraft — citation-locality
 *                     repair, verifier + revise loop, claim extraction.
 *   - publish:        publishArticleDraft — saveDeepReadDraft +
 *                     persistArticleSourceLedger + persistArticleClaimMap,
 *                     with HARD_FAIL → status=needs_revision (Article's
 *                     quarantine equivalent — Article never auto-publishes).
 *
 * Behavior preserved (vs legacy `runWeeklyDeepRead`):
 *   - Verifier thresholds, severity/lane summaries, HARD_FAIL semantics.
 *   - Source ledger + claim map persistence happen exactly once per run, on
 *     the same code path as the legacy function.
 *   - Article's "quarantine" is `needs_revision` — operator manually
 *     publishes via X's Article composer.
 *
 * Adapter instance state holds the source pool / research pack / claim
 * map items / fetched article content between stages so a single run
 * threads through one adapter instance. NOT a singleton — the entry
 * point creates a fresh adapter per call.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  assembleArticleSourcePack,
  buildArticleClaimMapAssembly,
  compileArticleDraft,
  verifyAndRepairArticleDraft,
  publishArticleDraft,
  discoverArticle,
  fetchArticleContent,
  type ArticleClaimAssembly,
  type ArticleDraft,
  type ArticleDraftResult,
  type ArticleInfo,
  type ArticleSourceAssembly,
  type ArticleVerifyAndRepair,
} from "../articleEngine.js";
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

/** Engine-specific options the article adapter recognizes on `PipelineInput`. */
export interface ArticlePipelineOpts {
  /** When provided, skip discovery and fetch this URL directly. Mirrors the
   *  preview path's `overrideUrl`. */
  overrideUrl?: string;
  /** API key forwarded to the discovery + writer LLM calls. Always required
   *  on the writer path. Defaults to LLM_API_KEY at the entry layer. */
  apiKey?: string;
  /** Pre-fetched primary article info — lets the cron/preview wrappers feed
   *  already-discovered data into the pipeline instead of running discovery
   *  again inside the adapter. */
  articleInfo?: ArticleInfo;
  /** Pre-fetched article body — same wrapper escape hatch as above. */
  articleContent?: string;
  /** Pre-fetched cover image url. */
  imageUrl?: string;
}

function readArticleOpts(input: PipelineInput): ArticlePipelineOpts {
  const o = (input.engineOpts ?? {}) as Partial<ArticlePipelineOpts>;
  return {
    overrideUrl:    o.overrideUrl,
    apiKey:         o.apiKey,
    articleInfo:    o.articleInfo,
    articleContent: o.articleContent,
    imageUrl:       o.imageUrl,
  };
}

/**
 * Stateful Article adapter. Each stage method captures the artifacts the
 * later stages need (sourceAssembly, claimAssembly, draftResult, verifyOut,
 * fetched articleContent / articleInfo). One adapter instance per pipeline
 * run; the entry point in articlePipelineEntry constructs a fresh one each
 * call.
 */
export class ArticlePipelineAdapter implements EnginePipelineAdapter {
  readonly engine = "article" as const;

  /** Captured during `plan` — used by source/draft/publish. */
  private articleInfo: ArticleInfo | null = null;
  private articleContent: string = "";
  private imageUrl: string | undefined = undefined;
  /** Captured inside `assembleSourcePack` so later stages can reach the
   *  research pack / source pool without rebuilding them. */
  private sourceAssembly: ArticleSourceAssembly | null = null;
  /** Captured inside `buildClaimMap`; consumed by publish for persistence. */
  private claimAssembly: ArticleClaimAssembly | null = null;
  /** Captured inside `compileDraft`; consumed by verify/publish. */
  private draftResult: ArticleDraftResult | null = null;
  /** Captured inside `verifyAndRepair`; consumed by publish. */
  private verifyOut: ArticleVerifyAndRepair | null = null;
  /** Persisted Article draft after publish stage runs. Used so callers can
   *  retrieve the draftId / status without re-reading state. */
  private persistedDraft: ArticleDraft | null = null;

  /**
   * Read access to the persisted Article draft. Returns null when the
   * pipeline did not reach the publish stage (dry-run, earlier failure,
   * safety-redacted etc.). Used by the entry point to surface the saved
   * draft to legacy callers.
   */
  getPersistedDraft(): ArticleDraft | null {
    return this.persistedDraft;
  }

  async plan(input: PipelineInput): Promise<PlanResult> {
    const opts = readArticleOpts(input);

    // Allow the caller to feed in already-discovered + already-fetched data
    // (the cron path will use this — discovery and fetch retries belong in
    // the wrapper, not in the pipeline orchestrator). When no prefetched
    // data is supplied, the adapter runs discovery + fetch itself so an
    // operator-triggered pipeline run still produces a Deep Read.
    if (opts.articleInfo && opts.articleContent && opts.articleContent.length >= 800) {
      this.articleInfo    = opts.articleInfo;
      this.articleContent = opts.articleContent;
      this.imageUrl       = opts.imageUrl;
      return { topic: opts.articleInfo.title, draftHint: "deep_read" };
    }

    // Override URL path: skip discovery, fetch directly.
    if (opts.overrideUrl) {
      const fetched = await fetchArticleContent(opts.overrideUrl);
      if (!fetched.ok || fetched.text.length < 800) {
        throw new Error(
          `Source unavailable for ${opts.overrideUrl}: ${fetched.reason ?? `content too short (${fetched.text.length} chars)`}; refusing to fabricate.`,
        );
      }
      let hostname = opts.overrideUrl;
      try { hostname = new URL(opts.overrideUrl).hostname.replace("www.", ""); } catch {}
      this.articleInfo = {
        title:         fetched.title || hostname,
        url:           opts.overrideUrl,
        summary:       fetched.text.slice(0, 500),
        source:        hostname,
        publishedDate: new Date().toISOString().slice(0, 10),
      };
      this.articleContent = fetched.text;
      this.imageUrl       = fetched.imageUrl;
      return { topic: this.articleInfo.title, draftHint: "deep_read" };
    }

    // Discovery path. Single attempt — multi-attempt fallback stays in the
    // cron wrapper. The pipeline orchestrator gives a clean failure event
    // when discovery fails so the dashboard always has a terminal row.
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("plan: no apiKey supplied and OPENROUTER_API_KEY unset");
    }
    const articleInfo = await discoverArticle(apiKey);
    if (!articleInfo) {
      throw new Error("plan: discoverArticle returned null");
    }
    const fetched = await fetchArticleContent(articleInfo.url);
    if (!fetched.ok || fetched.text.length < 800) {
      throw new Error(
        `plan: source unavailable for ${articleInfo.url}: ${fetched.reason ?? `content too short (${fetched.text.length} chars)`}`,
      );
    }
    this.articleInfo    = articleInfo;
    this.articleContent = fetched.text;
    this.imageUrl       = fetched.imageUrl;
    return { topic: articleInfo.title, draftHint: "deep_read" };
  }

  async assembleSourcePack(_plan: PlanResult, _input: PipelineInput): Promise<SourceResult> {
    if (!this.articleInfo) {
      throw new Error("assembleSourcePack: plan stage state missing");
    }
    const assembly = assembleArticleSourcePack({
      articleInfo:    this.articleInfo,
      articleContent: this.articleContent,
    });
    this.sourceAssembly = assembly;
    return {
      sourcePool: assembly.sourcePool,
      researchPack: assembly.researchPack,
      sourceText: assembly.articleContent,
      references: assembly.researchPack.references,
    };
  }

  buildClaimMap(plan: PlanResult, source: SourceResult, _input: PipelineInput): ClaimResult {
    const claim = buildArticleClaimMapAssembly({
      topic: plan.topic,
      researchPack: source.researchPack,
      sourcePool: source.sourcePool,
    });
    this.claimAssembly = claim;
    return { items: claim.claimMapPromptItems };
  }

  async compileDraft(
    _plan: PlanResult,
    _source: SourceResult,
    _claim: ClaimResult,
    input: PipelineInput,
  ): Promise<DraftResult> {
    if (!this.articleInfo || !this.sourceAssembly || !this.claimAssembly) {
      throw new Error("compileDraft: prior stage state missing");
    }
    const opts = readArticleOpts(input);
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";

    const draft = await compileArticleDraft({
      articleInfo: this.articleInfo,
      articleContent: this.articleContent,
      apiKey,
      sourcePool: this.sourceAssembly.sourcePool,
      claimMapPromptBlock: this.claimAssembly.claimMapPromptBlock,
    });
    if (!draft) {
      throw new Error("compileArticleDraft returned null (LLM unavailable or generation failed)");
    }
    this.draftResult = draft;

    // Article mints its draftId on saveDeepReadDraft (publish stage). We
    // synthesize a deterministic pre-publish id here so verify/repair
    // events can pin against it; the real id is on the publish event's
    // evidence.draftId.
    const prePublishId = `article_pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return {
      draftId: prePublishId,
      title:   draft.headline,
      content: draft.body,
      tags:    [], // Article doesn't carry tags on the draft surface
    };
  }

  async verifyAndRepair(
    draft: DraftResult,
    _source: SourceResult,
    _claim: ClaimResult,
    _input: PipelineInput,
  ): Promise<{ verify: VerifyResult; repair: RepairResult }> {
    if (!this.articleInfo || !this.sourceAssembly) {
      throw new Error("verifyAndRepair: prior stage state missing");
    }
    const out = await verifyAndRepairArticleDraft({
      articleInfo:    this.articleInfo,
      draftBody:      draft.content,
      articleContent: this.articleContent,
      sourcePool:     this.sourceAssembly.sourcePool,
    });
    this.verifyOut = out;
    return {
      verify: {
        verdict: out.verdict,
        report: out.verdict.verifierReport,
        revisionAttempts: out.revisionHistory.length,
      },
      repair: {
        body: out.revisedBody,
        // The Article revise loop owns repair internally — we surface a
        // best-effort 0/0 here. The pre/post telemetry inside
        // verifyAndRepairArticleDraft logs the real numbers; explicit
        // counters can be lifted onto ArticleVerifyAndRepair in a follow-up
        // when the Article revise loop returns them.
        citationsAdded: 0,
        sentencesHedged: 0,
      },
    };
  }

  async publish(
    _draft: DraftResult,
    _repair: RepairResult,
    verify: VerifyResult,
    _plan: PlanResult,
    _source: SourceResult,
    _claim: ClaimResult,
    _input: PipelineInput,
  ): Promise<PublishDecision> {
    if (!this.articleInfo || !this.sourceAssembly || !this.claimAssembly || !this.draftResult || !this.verifyOut) {
      throw new Error("publish: required stage state missing");
    }
    const saved = publishArticleDraft({
      articleInfo:         this.articleInfo,
      articleContent:      this.articleContent,
      imageUrl:            this.imageUrl,
      draft:               this.draftResult,
      verifyOut:           this.verifyOut,
      researchPack:        this.sourceAssembly.researchPack,
      sourcePool:          this.sourceAssembly.sourcePool,
      claimMapPromptItems: this.claimAssembly.claimMapPromptItems,
    });
    this.persistedDraft = saved;

    const isHardFail = verify.report.severity === "HARD_FAIL";
    const reason = isHardFail
      ? `quarantined as needs_revision (severity=HARD_FAIL, ${this.verifyOut.verdict.unsupportedClaims.length} unsupported claims)`
      : `saved as draft (severity=${verify.report.severity}); operator publishes via X Article composer`;
    return {
      // Article never auto-publishes — operator manually posts via X. So
      // `published=false` is the correct shape across the board; the
      // dashboard distinguishes via severity + status on the saved draft.
      published: false,
      skippedForDryRun: false,
      reason,
      severity: verify.report.severity,
      evidence: { draftId: saved.draftId },
    };
  }
}

/** Convenience factory — match the rest of the engine modules' style. */
export function makeArticlePipelineAdapter(): ArticlePipelineAdapter {
  return new ArticlePipelineAdapter();
}
