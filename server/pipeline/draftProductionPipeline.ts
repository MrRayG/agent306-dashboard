/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — DRAFT PRODUCTION PIPELINE (Roadmap B1, 2026-05-02)
 *
 * Engine-agnostic orchestrator that turns a topic + source material into a
 * verified, optionally-published draft. Each engine plugs in via
 * `EnginePipelineAdapter` (server/pipeline/types.ts) and supplies the
 * format/voice/draft/verify/publish behavior; the pipeline owns stage
 * ordering, structured stage-event emission, dry-run gating, and the
 * final publish decision.
 *
 * Stages (in order): plan → source → claim → draft → verify → repair → publish.
 *
 * Stage events are written to engine_events via the existing
 * observability/structuredLog#logEvent. Failures inside the event writer
 * are swallowed (logEvent already does this) so the pipeline hot path
 * never breaks because of telemetry.
 *
 * Dry-run mode runs plan/source/claim, then short-circuits with a publish
 * event tagged `dryRun=true, skippedForDryRun=true`. No LLM calls are made
 * in dry-run, no drafts are persisted, no publish state is mutated.
 *
 * Roadmap deferrals (B2 / B3):
 *   - Migrating Article / Academy onto the pipeline (B3).
 *   - Teaching writer prompts to preserve `[itemKey]` markers end-to-end.
 *   - Pulling `repair` out as a first-class stage instead of emitting it
 *     immediately after verify with the same draft body. The current
 *     contract treats verify/repair as a single LLM round-trip the engine
 *     adapter owns; B2 may split them once articleReviseLoop is unified.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logEvent } from "../observability/structuredLog.js";
import type {
  EnginePipelineAdapter,
  PipelineInput,
  PipelineResult,
  PipelineStage,
  PipelineStageEvent,
  PublishDecision,
} from "./types.js";

function makeRunId(engine: string): string {
  return `pipe_${engine}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emit(event: PipelineStageEvent): void {
  // Single source of truth for the event shape — keeps payloads small and
  // prevents accidental drift between adapters. logEvent itself swallows
  // DB errors, but we belt-and-suspender it so a thrown serializer error
  // also can't break the pipeline.
  try {
    logEvent({
      engine: event.engine,
      event: `pipeline.${event.stage}`,
      level: event.success ? "info" : "warn",
      data: {
        pipelineRunId: event.pipelineRunId,
        stage: event.stage,
        draftId: event.draftId,
        dryRun: event.dryRun,
        success: event.success,
        reason: event.reason,
        evidence: event.evidence ?? {},
      },
    });
  } catch (e: any) {
    console.warn(`[Pipeline] event emit failed (${event.stage}):`, e?.message);
  }
}

function failurePublish(
  reason: string,
  severity: PublishDecision["severity"] = "PASS",
): PublishDecision {
  return {
    published: false,
    skippedForDryRun: false,
    reason,
    severity,
    evidence: {},
  };
}

/**
 * Run the shared draft-production pipeline against a single engine adapter.
 *
 * The orchestrator is intentionally strict about stage ordering — each
 * stage's output feeds the next, and any thrown error inside an adapter
 * method short-circuits the run after emitting a failure event for that
 * stage. The publish event is ALWAYS emitted (success or failure) so the
 * dashboard always has a terminal row per pipeline run.
 */
export async function runDraftProductionPipeline(
  adapter: EnginePipelineAdapter,
  input: PipelineInput,
): Promise<PipelineResult> {
  const engine = adapter.engine;
  const dryRun = input.dryRun === true;
  const pipelineRunId = input.pipelineRunId ?? makeRunId(engine);

  const result: PipelineResult = {
    engine,
    pipelineRunId,
    dryRun,
    publish: failurePublish("pipeline did not reach publish stage"),
  };

  // ── PLAN ──────────────────────────────────────────────────────────
  let plan;
  try {
    plan = await adapter.plan(input);
    emit({
      engine,
      stage: "plan",
      pipelineRunId,
      dryRun,
      success: true,
      evidence: { topic: plan.topic, draftHint: plan.draftHint ?? null },
    });
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    emit({ engine, stage: "plan", pipelineRunId, dryRun, success: false, reason });
    result.publish = failurePublish(`plan failed: ${reason}`);
    emit({ engine, stage: "publish", pipelineRunId, dryRun, success: false, reason: result.publish.reason });
    return result;
  }

  // ── SOURCE ────────────────────────────────────────────────────────
  let source;
  try {
    source = await adapter.assembleSourcePack(plan, input);
    result.source = source;
    emit({
      engine,
      stage: "source",
      pipelineRunId,
      dryRun,
      success: true,
      evidence: {
        sourceCount: source.sourcePool.length,
        referenceCount: source.references.length,
        manualReviewRequired: source.researchPack.manualReviewRequired,
        manualPublishAllowed: source.researchPack.manualPublishAllowed,
      },
    });
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    emit({ engine, stage: "source", pipelineRunId, dryRun, success: false, reason });
    result.publish = failurePublish(`source failed: ${reason}`);
    emit({ engine, stage: "publish", pipelineRunId, dryRun, success: false, reason: result.publish.reason });
    return result;
  }

  // ── CLAIM ─────────────────────────────────────────────────────────
  let claim;
  try {
    claim = await adapter.buildClaimMap(plan, source, input);
    result.claim = claim;
    emit({
      engine,
      stage: "claim",
      pipelineRunId,
      dryRun,
      success: true,
      evidence: {
        itemCount: claim.items.length,
        approvedCount: claim.items.filter(i => i.approved !== false).length,
      },
    });
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    emit({ engine, stage: "claim", pipelineRunId, dryRun, success: false, reason });
    result.publish = failurePublish(`claim failed: ${reason}`);
    emit({ engine, stage: "publish", pipelineRunId, dryRun, success: false, reason: result.publish.reason });
    return result;
  }

  // ── DRY-RUN GATE ──────────────────────────────────────────────────
  // Stop before any LLM call / persistence / publish state mutation.
  if (dryRun) {
    result.publish = {
      published: false,
      skippedForDryRun: true,
      reason: "dry-run: skipped draft/verify/publish",
      severity: "PASS",
      evidence: {},
    };
    emit({
      engine,
      stage: "publish",
      pipelineRunId,
      dryRun,
      success: true,
      reason: result.publish.reason,
      evidence: { skippedForDryRun: true },
    });
    return result;
  }

  // ── DRAFT ─────────────────────────────────────────────────────────
  let draft;
  try {
    draft = await adapter.compileDraft(plan, source, claim, input);
    result.draft = draft;
    emit({
      engine,
      stage: "draft",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: true,
      evidence: {
        wordCount: draft.content.split(/\s+/).filter(Boolean).length,
        tagCount: draft.tags.length,
      },
    });
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    emit({ engine, stage: "draft", pipelineRunId, dryRun, success: false, reason });
    result.publish = failurePublish(`draft failed: ${reason}`);
    emit({ engine, stage: "publish", pipelineRunId, dryRun, success: false, reason: result.publish.reason });
    return result;
  }

  // ── VERIFY + REPAIR ───────────────────────────────────────────────
  let verify;
  let repair;
  try {
    const out = await adapter.verifyAndRepair(draft, source, claim, input);
    verify = out.verify;
    repair = out.repair;
    result.verify = verify;
    result.repair = repair;
    emit({
      engine,
      stage: "verify",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: verify.verdict.severity !== "HARD_FAIL",
      reason: verify.verdict.severity === "HARD_FAIL" ? "verifier hard-fail" : undefined,
      evidence: {
        severity: verify.verdict.severity,
        revisionAttempts: verify.revisionAttempts,
        unsupportedClaims: verify.verdict.unsupportedClaims.length,
      },
    });
    emit({
      engine,
      stage: "repair",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: true,
      evidence: {
        citationsAdded: repair.citationsAdded ?? 0,
        sentencesHedged: repair.sentencesHedged ?? 0,
      },
    });
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    emit({
      engine,
      stage: "verify",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: false,
      reason,
    });
    result.publish = failurePublish(`verify/repair failed: ${reason}`);
    emit({
      engine,
      stage: "publish",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: false,
      reason: result.publish.reason,
    });
    return result;
  }

  // ── PUBLISH ───────────────────────────────────────────────────────
  let publishDecision;
  try {
    publishDecision = await adapter.publish(draft, repair, verify, plan, source, claim, input);
    result.publish = publishDecision;
    emit({
      engine,
      stage: "publish",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: publishDecision.published,
      reason: publishDecision.reason,
      evidence: {
        severity: publishDecision.severity,
        sourceLedgerId: publishDecision.evidence.sourceLedgerId ?? null,
        claimMapId: publishDecision.evidence.claimMapId ?? null,
        publishedDraftId: publishDecision.evidence.draftId ?? null,
      },
    });
  } catch (e: any) {
    const reason = e?.message ?? String(e);
    result.publish = {
      published: false,
      skippedForDryRun: false,
      reason: `publish failed: ${reason}`,
      severity: verify.verdict.severity,
      evidence: { draftId: draft.draftId },
    };
    emit({
      engine,
      stage: "publish",
      pipelineRunId,
      draftId: draft.draftId,
      dryRun,
      success: false,
      reason: result.publish.reason,
    });
  }

  return result;
}

/** Re-export the stage list so test fixtures and dashboard queries can pin
 *  against the canonical ordering without importing the type module. */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  "plan",
  "source",
  "claim",
  "draft",
  "verify",
  "repair",
  "publish",
] as const;
