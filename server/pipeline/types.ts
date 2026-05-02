/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — DRAFT PRODUCTION PIPELINE — TYPED CONTRACTS (Roadmap B1)
 *
 * Stage contracts and adapter interface for the shared draft-production
 * pipeline. Engines plug in by implementing `EnginePipelineAdapter`. The
 * pipeline orchestrator owns the stage ordering, stage-event emission,
 * dry-run gating, and the final publish decision; engine adapters supply
 * format/voice/source/draft/verify/publish behavior.
 *
 * Stages are intentionally narrow — each one consumes the previous stage's
 * output and produces a strongly-typed result the next stage needs. This
 * keeps the orchestrator engine-agnostic while still letting each engine
 * keep its own writer prompt, verifier configuration, and publish gate.
 *
 * Stage event payloads are deliberately lean — engine, draftId, stage,
 * mode, success, and a small set of evidence ids only. Heavy artifacts
 * (full draft text, full verifier reports) must NOT be put on the event;
 * they live in their own tables and are linkable via the evidence ids.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { SourceObject } from "../sourceLocality.js";
import type { ResearchPack, ReferenceMetadata } from "../researchPack.js";
import type { ClaimMapItemInput } from "../repositories/claimMapRepository.js";
import type { VerifierReport, ClaimVerdict } from "../claimVerifier.js";

/** Engines currently recognized by the shared pipeline. New engines should
 *  be added here so the adapter map is exhaustive at compile time. */
export type PipelineEngine = "blog" | "article" | "academy";

/** Stage names emitted on engine_events. Do NOT rename — the dashboard and
 *  any downstream telemetry queries pin against these literals. */
export type PipelineStage =
  | "plan"
  | "source"
  | "claim"
  | "draft"
  | "verify"
  | "repair"
  | "publish";

/** Event payload shape persisted to engine_events.data. Kept small — the
 *  source ledger / claim map / verifier report carry the heavy state. */
export interface PipelineStageEvent {
  engine: PipelineEngine;
  stage: PipelineStage;
  /** Pipeline run identifier — same value across every event in one run.
   *  Lets a dashboard reconstruct a run without correlating timestamps. */
  pipelineRunId: string;
  /** Filled in once the underlying engine has minted a draft id. Earlier
   *  stages (plan, source, claim) emit before that and leave it undefined. */
  draftId?: string;
  /** Mirror of `dryRun` so a single SQL filter pulls only real publish runs. */
  dryRun: boolean;
  success: boolean;
  /** When success=false this carries a short reason string. Never stack
   *  traces — they go to the surrounding console.warn. */
  reason?: string;
  /** Stage-specific evidence ids. Stays an open record because engines can
   *  add their own ids — but keep values primitive so the JSON stays small. */
  evidence?: Record<string, string | number | boolean | null | undefined>;
}

/** Output of the planning stage. Engines decide what counts as a plan —
 *  for blog/article it is the topic + content type; for academy it is the
 *  pedagogical objective. The pipeline only requires a topic + draftHint. */
export interface PlanResult {
  topic: string;
  /** Engine-specific hint to the writer (blog "type", article "angle", etc).
   *  Persisted on the stage event so dashboard can show plan→draft drift. */
  draftHint?: string;
}

/** Output of the source stage. Engines that do their own external research
 *  return the deduped pool; engines with empty pools (academy) return []. */
export interface SourceResult {
  sourcePool: SourceObject[];
  researchPack: ResearchPack;
  /** Optional auxiliary text bundle used as the verifier `sourceText`. */
  sourceText: string;
  references: ReferenceMetadata[];
}

/** Output of the claim stage. The claim map items are the writer's
 *  approved set; itemKeys must already be assigned (the orchestrator
 *  uses the same items in the prompt block and on persistence). */
export interface ClaimResult {
  items: ClaimMapItemInput[];
}

/** Output of the draft stage. */
export interface DraftResult {
  /** Engine-minted draft id. Must be stable for the rest of the run so the
   *  source ledger / claim map persist with the correct foreign key. */
  draftId: string;
  title: string;
  content: string;
  tags: string[];
}

/** Output of the verify stage. */
export interface VerifyResult {
  verdict: ClaimVerdict;
  /** Convenience copy of verdict.verifierReport so call sites don't have
   *  to dig — same object reference. */
  report: VerifierReport;
  /** Number of revise loops the engine ran inside its verify stage. */
  revisionAttempts: number;
}

/** Output of the repair stage. The pipeline never repairs by itself — the
 *  engine adapter owns the repair logic (citation locality, hedging,
 *  revise loops). The repair stage exists to give the dashboard a
 *  consistent observability surface for whatever the engine did. */
export interface RepairResult {
  /** Final body after the engine's repair pass. May equal the draft body
   *  when no repair was applied. */
  body: string;
  /** Number of citation-locality citations the repair pass added. */
  citationsAdded?: number;
  /** Number of sentences hedged because no source could be cited. */
  sentencesHedged?: number;
}

/** Final publish decision. The orchestrator emits this as the publish
 *  stage event regardless of whether the engine ultimately published. */
export interface PublishDecision {
  /** True when the pipeline actually published (or would have, in dry-run).
   *  False when the engine quarantined / kept-as-draft. */
  published: boolean;
  /** True when dry-run mode short-circuited the publish. */
  skippedForDryRun: boolean;
  /** Reason string surfaced to the dashboard. Always populated — even on
   *  the happy path so the operator can see the gate that fired. */
  reason: string;
  /** Severity from the verifier. Pinned on the publish event so a single
   *  query can answer "what severity did this draft publish under?". */
  severity: VerifierReport["severity"];
  /** Linkable evidence ids. */
  evidence: {
    draftId?: string;
    sourceLedgerId?: number;
    claimMapId?: number;
  };
}

/** Aggregated result returned by `runDraftProductionPipeline`. */
export interface PipelineResult {
  engine: PipelineEngine;
  pipelineRunId: string;
  dryRun: boolean;
  /** Set when the pipeline reached the source stage. */
  source?: SourceResult;
  /** Set when the pipeline reached the claim stage. */
  claim?: ClaimResult;
  /** Set when the pipeline reached the draft stage (skipped in dry-run). */
  draft?: DraftResult;
  /** Set when the pipeline reached the verify stage (skipped in dry-run). */
  verify?: VerifyResult;
  /** Set when the pipeline reached the repair stage. */
  repair?: RepairResult;
  /** Always populated. In dry-run, `published=false, skippedForDryRun=true`.
   *  When an earlier stage failed, `published=false` with `severity=PASS` (or
   *  the last severity seen) and a reason describing where the run aborted. */
  publish: PublishDecision;
}

/**
 * Engine adapter contract. Each engine implements this once; the pipeline
 * orchestrator drives the stages. Adapter methods are async because most
 * engines hit an LLM; the planning / source / claim stages may be sync,
 * but we keep the signature uniform so swapping in async impls later does
 * not require changing the orchestrator.
 */
export interface EnginePipelineAdapter {
  readonly engine: PipelineEngine;

  /**
   * Plan stage — return the topic / draft-hint the writer will use. Pure;
   * engines may return immediately when the caller already supplied a
   * topic (the typical case). Pipeline emits the `plan` event after.
   */
  plan(input: PipelineInput): Promise<PlanResult> | PlanResult;

  /**
   * Source stage — assemble the source pool, dedupe, classify, and build
   * the research pack. Engines reuse `extractSourceObjects` /
   * `dedupeSources` / `buildResearchPack` from the existing modules.
   */
  assembleSourcePack(plan: PlanResult, input: PipelineInput): Promise<SourceResult>;

  /**
   * Claim stage — derive the approved claim map for the draft. Engines
   * reuse `buildClaimMap` from claimMapBuilder. Pipeline does NOT persist
   * the items here; persistence happens after a real draft id exists.
   */
  buildClaimMap(plan: PlanResult, source: SourceResult, input: PipelineInput): Promise<ClaimResult> | ClaimResult;

  /**
   * Draft stage — compile the writer prompt, call the LLM, and return the
   * draft text + a stable engine-minted draft id. NEVER called in dry-run.
   * Engines own their writer prompt and voice rules in this method.
   */
  compileDraft(
    plan: PlanResult,
    source: SourceResult,
    claim: ClaimResult,
    input: PipelineInput,
  ): Promise<DraftResult>;

  /**
   * Verify + repair stage — engines run their citation-locality repair,
   * verifier, and any revise loops here. The orchestrator emits a
   * `verify` event with the verdict severity and a `repair` event with
   * the engine's repair counters. NEVER called in dry-run.
   */
  verifyAndRepair(
    draft: DraftResult,
    source: SourceResult,
    claim: ClaimResult,
    input: PipelineInput,
  ): Promise<{ verify: VerifyResult; repair: RepairResult }>;

  /**
   * Publish stage — the engine decides whether the draft can be published
   * given the verifier verdict. Returning `published=false` is normal for
   * HARD_FAIL. NEVER called in dry-run — the orchestrator short-circuits
   * before this method runs.
   *
   * Adapters MUST handle their own persistence here (createBlogPost,
   * createArticle, etc) so the pipeline never depends on a particular
   * storage layer.
   */
  publish(
    draft: DraftResult,
    repair: RepairResult,
    verify: VerifyResult,
    plan: PlanResult,
    source: SourceResult,
    claim: ClaimResult,
    input: PipelineInput,
  ): Promise<PublishDecision>;
}

/**
 * Caller input. Engine-specific configuration is stuffed under `engineOpts`
 * so the orchestrator's signature stays stable as adapters grow. The blog
 * adapter, for example, reads `engineOpts.blogType` / `engineOpts.autoPublish`
 * out of this bag.
 */
export interface PipelineInput {
  engine: PipelineEngine;
  topic: string;
  /** Human-supplied draft material (research findings, external article
   *  text, podcast transcript). Engines may further enrich it. */
  sourceContent?: string;
  /** Engine-specific knobs. Adapter is responsible for reading these. */
  engineOpts?: Record<string, unknown>;
  /** When true the pipeline executes plan → source → claim only and
   *  skips draft / verify / publish. The publish event is still emitted
   *  with `dryRun=true, published=false, skippedForDryRun=true`.
   *
   *  Default: false. */
  dryRun?: boolean;
  /** Optional opaque id stitched onto every stage event. When omitted the
   *  orchestrator generates one. */
  pipelineRunId?: string;
}
