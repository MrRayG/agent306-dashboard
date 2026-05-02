/**
 * Tests for the shared draft-production pipeline (Roadmap B1).
 *
 * Covers:
 *   - Dry-run gate: plan/source/claim run, draft/verify/publish skipped.
 *   - Event emission: every stage emits a row to engine_events with the
 *     expected `pipeline.<stage>` event name and pipelineRunId.
 *   - Adapter behavior: stage outputs flow into the next stage's input.
 *   - Failure path: exception in a stage emits a `success=false` event
 *     and short-circuits the run with a publish failure event.
 *   - Publish decision evidence: publish event carries severity + draftId.
 *
 * These tests use a stub adapter — the blog adapter is exercised
 * separately in blogPipeline.test.ts. All tests redirect DB_PATH /
 * DATA_DIR to a temp dir so they do not touch developer state.
 *
 * Run: npx tsx --test server/__tests__/draftProductionPipeline.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-pipeline-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { desc, eq } from "drizzle-orm";
import { runDraftProductionPipeline, PIPELINE_STAGES } from "../pipeline/draftProductionPipeline.js";
import type {
  EnginePipelineAdapter,
  PipelineInput,
  PlanResult,
  SourceResult,
  ClaimResult,
  DraftResult,
  VerifyResult,
  RepairResult,
  PublishDecision,
} from "../pipeline/types.js";
import type { ResearchPack } from "../researchPack.js";
import type { ClaimVerdict, VerifierReport } from "../claimVerifier.js";

function emptyResearchPack(): ResearchPack {
  return {
    engine: "blog",
    sourcePool: [],
    qualityReport: {
      counts: { reputable: 0, acceptable: 0, unverified: 0, low_quality: 0 },
      perSource: [],
      meetsMinTier: true,
      reasons: [],
    } as unknown as ResearchPack["qualityReport"],
    references: [],
    manualReviewRequired: false,
    manualPublishAllowed: true,
    summaryLine: "stub",
  };
}

function passReport(): VerifierReport {
  return {
    severity: "PASS",
    entries: [],
    summary: {
      laneAOk: 1,
      laneAFail: 0,
      laneAUnverifiable: 0,
      laneAPassQuotedCommentary: 0,
      laneAPassCritiqueByAbsence: 0,
      laneBOk: 1,
      laneBBare: 0,
      retractedHits: 0,
      ncitePatternHits: 0,
    },
  };
}

function passVerdict(): ClaimVerdict {
  const report = passReport();
  return {
    ok: true,
    unsupportedClaims: [],
    supportedCount: 2,
    externalCitedCount: 1,
    verifierReport: report,
    severity: "PASS",
  };
}

interface StubBehavior {
  failAt?: "plan" | "source" | "claim" | "draft" | "verify" | "publish";
  publishedStatus?: boolean;
  severity?: VerifierReport["severity"];
}

function makeStubAdapter(behavior: StubBehavior = {}): EnginePipelineAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    engine: "blog",
    calls,
    plan(input: PipelineInput): PlanResult {
      calls.push("plan");
      if (behavior.failAt === "plan") throw new Error("plan-boom");
      return { topic: input.topic, draftHint: "stub" };
    },
    async assembleSourcePack(_plan, _input): Promise<SourceResult> {
      calls.push("source");
      if (behavior.failAt === "source") throw new Error("source-boom");
      return {
        sourcePool: [],
        researchPack: emptyResearchPack(),
        sourceText: "",
        references: [],
      };
    },
    buildClaimMap(_plan, _source, _input): ClaimResult {
      calls.push("claim");
      if (behavior.failAt === "claim") throw new Error("claim-boom");
      return {
        items: [
          { itemKey: "stub:1", claimText: "x", claimType: "analysis", citationRequirement: "forbidden", approved: true },
        ],
      };
    },
    async compileDraft(_plan, _source, _claim, _input): Promise<DraftResult> {
      calls.push("draft");
      if (behavior.failAt === "draft") throw new Error("draft-boom");
      return { draftId: "stub_draft_1", title: "T", content: "Body words.", tags: ["t"] };
    },
    async verifyAndRepair(_draft, _source, _claim, _input) {
      calls.push("verify");
      if (behavior.failAt === "verify") throw new Error("verify-boom");
      const report: VerifierReport = behavior.severity
        ? { ...passReport(), severity: behavior.severity }
        : passReport();
      const verdict: ClaimVerdict = { ...passVerdict(), severity: report.severity, verifierReport: report };
      return {
        verify: { verdict, report, revisionAttempts: 0 } as VerifyResult,
        repair: { body: "Body words.", citationsAdded: 1, sentencesHedged: 0 } as RepairResult,
      };
    },
    async publish(draft, _repair, verify, _plan, _source, _claim, _input): Promise<PublishDecision> {
      calls.push("publish");
      if (behavior.failAt === "publish") throw new Error("publish-boom");
      return {
        published: behavior.publishedStatus !== false,
        skippedForDryRun: false,
        reason: behavior.publishedStatus === false ? "stub-blocked" : "stub-published",
        severity: verify.report.severity,
        evidence: { draftId: draft.draftId, sourceLedgerId: 1, claimMapId: 2 },
      };
    },
  };
}

function wipeEvents() {
  try { db.delete(engineEvents).run(); } catch {}
}

function fetchEvents(pipelineRunId: string) {
  const rows = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).orderBy(desc(engineEvents.id)).all();
  // The engine column is "blog"; we want only events for THIS run, which is
  // pinned in data.pipelineRunId.
  return rows
    .map(r => ({ ...r, parsed: JSON.parse(r.data) as any }))
    .filter(r => r.parsed.pipelineRunId === pipelineRunId)
    .reverse(); // chronological
}

describe("draftProductionPipeline (Roadmap B1)", () => {
  beforeEach(wipeEvents);

  it("exposes the canonical stage order", () => {
    assert.deepEqual(PIPELINE_STAGES, ["plan", "source", "claim", "draft", "verify", "repair", "publish"]);
  });

  it("dry-run runs plan/source/claim and emits a publish event with skippedForDryRun=true", async () => {
    const adapter = makeStubAdapter();
    const result = await runDraftProductionPipeline(adapter, {
      engine: "blog",
      topic: "Test topic",
      dryRun: true,
    });

    // Stage methods called only up to claim.
    assert.deepEqual(adapter.calls, ["plan", "source", "claim"]);

    assert.equal(result.dryRun, true);
    assert.equal(result.publish.published, false);
    assert.equal(result.publish.skippedForDryRun, true);
    assert.match(result.publish.reason, /dry-run/);
    assert.ok(result.source);
    assert.ok(result.claim);
    assert.equal(result.draft, undefined);
    assert.equal(result.verify, undefined);

    const events = fetchEvents(result.pipelineRunId);
    const stages = events.map(e => e.parsed.stage);
    assert.deepEqual(stages, ["plan", "source", "claim", "publish"]);
    const publishEvent = events.find(e => e.parsed.stage === "publish")!;
    assert.equal(publishEvent.parsed.dryRun, true);
    assert.equal(publishEvent.parsed.evidence.skippedForDryRun, true);
  });

  it("happy path emits all five required event stages and the canonical seven", async () => {
    const adapter = makeStubAdapter();
    const result = await runDraftProductionPipeline(adapter, {
      engine: "blog",
      topic: "Happy",
    });
    assert.equal(result.publish.published, true);
    assert.equal(result.publish.severity, "PASS");
    assert.equal(result.publish.evidence.draftId, "stub_draft_1");

    const events = fetchEvents(result.pipelineRunId);
    const eventNames = events.map(e => e.event);
    // Roadmap B1 acceptance: source, claim, verify, repair, publish events emit.
    for (const required of ["pipeline.source", "pipeline.claim", "pipeline.verify", "pipeline.repair", "pipeline.publish"]) {
      assert.ok(eventNames.includes(required), `missing event ${required} (got ${eventNames.join(",")})`);
    }
    // Full canonical order should be plan/source/claim/draft/verify/repair/publish.
    assert.deepEqual(events.map(e => e.parsed.stage), [...PIPELINE_STAGES]);
  });

  it("publish event carries severity and evidence ids", async () => {
    const adapter = makeStubAdapter({ severity: "SOFT_WARN" });
    const result = await runDraftProductionPipeline(adapter, { engine: "blog", topic: "Evidence" });
    assert.equal(result.publish.severity, "SOFT_WARN");
    assert.equal(result.publish.evidence.draftId, "stub_draft_1");
    assert.equal(result.publish.evidence.sourceLedgerId, 1);
    assert.equal(result.publish.evidence.claimMapId, 2);

    const events = fetchEvents(result.pipelineRunId);
    const publishEvent = events.find(e => e.parsed.stage === "publish")!;
    assert.equal(publishEvent.parsed.evidence.severity, "SOFT_WARN");
    assert.equal(publishEvent.parsed.evidence.publishedDraftId, "stub_draft_1");
  });

  it("source failure short-circuits with a publish failure event", async () => {
    const adapter = makeStubAdapter({ failAt: "source" });
    const result = await runDraftProductionPipeline(adapter, { engine: "blog", topic: "Boom" });

    assert.equal(result.publish.published, false);
    assert.match(result.publish.reason, /source failed/);
    assert.deepEqual(adapter.calls, ["plan", "source"]);

    const events = fetchEvents(result.pipelineRunId);
    const stages = events.map(e => e.parsed.stage);
    assert.deepEqual(stages, ["plan", "source", "publish"]);
    const sourceEvent = events.find(e => e.parsed.stage === "source")!;
    assert.equal(sourceEvent.parsed.success, false);
    assert.match(sourceEvent.parsed.reason, /source-boom/);
    const publishEvent = events.find(e => e.parsed.stage === "publish")!;
    assert.equal(publishEvent.parsed.success, false);
  });

  it("verify failure marks success=false but still emits a publish event", async () => {
    const adapter = makeStubAdapter({ failAt: "verify" });
    const result = await runDraftProductionPipeline(adapter, { engine: "blog", topic: "VerifyFail" });
    assert.equal(result.publish.published, false);
    assert.match(result.publish.reason, /verify\/repair failed/);

    const events = fetchEvents(result.pipelineRunId);
    const verifyEvent = events.find(e => e.parsed.stage === "verify")!;
    assert.equal(verifyEvent.parsed.success, false);
    // Repair event must NOT have been emitted because verifyAndRepair threw.
    assert.equal(events.find(e => e.parsed.stage === "repair"), undefined);
  });

  it("publish failure surfaces the engine reason in the publish event", async () => {
    const adapter = makeStubAdapter({ publishedStatus: false });
    const result = await runDraftProductionPipeline(adapter, { engine: "blog", topic: "NoPublish" });
    assert.equal(result.publish.published, false);
    assert.match(result.publish.reason, /stub-blocked/);

    const events = fetchEvents(result.pipelineRunId);
    const publishEvent = events.find(e => e.parsed.stage === "publish")!;
    assert.equal(publishEvent.parsed.success, false);
    assert.match(publishEvent.parsed.reason, /stub-blocked/);
  });

  it("uses the caller-supplied pipelineRunId verbatim", async () => {
    const adapter = makeStubAdapter();
    const result = await runDraftProductionPipeline(adapter, {
      engine: "blog",
      topic: "Stable id",
      dryRun: true,
      pipelineRunId: "fixed_run_xyz",
    });
    assert.equal(result.pipelineRunId, "fixed_run_xyz");
    const events = fetchEvents("fixed_run_xyz");
    assert.ok(events.length >= 4);
  });
});
