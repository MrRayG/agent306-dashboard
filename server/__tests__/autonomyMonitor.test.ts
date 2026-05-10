/**
 * Tests for the Phase 2f-a Autonomy Monitor aggregator.
 *
 * Spec invariants this file pins:
 *   1. All 11 full-loop stages are present in canonical order, even when every
 *      source file is missing.
 *   2. Future / not-yet-implemented stages are shown with explicit `planned` or
 *      `not_implemented` statuses (they are NOT hidden).
 *   3. Empty / missing data files (`research_lab.json`, `memory_knowledge.json`,
 *      the two JSONL ledgers) are handled gracefully — 0 counts, no throw.
 *   4. Memory-origin hypotheses always show feedEligible 0 / refused.
 *   5. Disabled low-risk registry kinds are visible but marked disabled.
 *   6. sandboxAutoApplyEligible is surfaced but not actionable.
 *   7. The aggregator is read-only: calling it does NOT create the ledger
 *      files, mutate research_lab.json, memory_knowledge.json, or invalidate
 *      any caches.
 *   8. Safety boundary flags are all `true` (noAutoPost / noAutoPublish /
 *      noAutoPromote / noScheduler / publicApprovalRequired).
 *   9. Real decision events persisted under a tmp DATA_DIR surface in the
 *      decision_outcome stage's counts + latest tail.
 *   10. Real sandbox registration records surface in evidence_package counts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// Redirect DATA_DIR to a temp dir BEFORE importing the module so dataPaths.ts
// sees the override at first import. Matches the pattern in
// hypothesisDecisionEvents.test.ts / sandboxRegistrationRecords.test.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2fa-monitor-test-"));
process.env.DATA_DIR = TMP;

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB    = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REAL_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

function hash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

const PRE_RESEARCH = hash(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hash(REAL_MEMORY_KB);
const PRE_DECISION = hash(REAL_DECISION_LEDGER);
const PRE_RECORDS  = hash(REAL_RECORDS_LEDGER);

const {
  buildAutonomyMonitorSnapshot,
  AUTONOMY_STAGE_ORDER,
} = await import("../autonomyMonitor.ts");

const {
  appendDecisionEvent,
} = await import("../experiments/hypothesisDecisionEvents.ts");

const {
  appendRegistrationRecord,
  appendRefusedRegistrationRecord,
} = await import("../experiments/sandboxRegistrationRecords.ts");

const {
  registerLowRiskSandboxKind,
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

describe("autonomyMonitor — shape + stage completeness", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
  });

  after(() => {
    // Confirm the monitor did NOT write to any real data file.
    assert.equal(hash(REAL_RESEARCH_LAB), PRE_RESEARCH, "research_lab.json must not be touched");
    assert.equal(hash(REAL_MEMORY_KB),    PRE_MEMORY,   "memory_knowledge.json must not be touched");
    assert.equal(hash(REAL_DECISION_LEDGER), PRE_DECISION, "decision ledger must not be touched");
    assert.equal(hash(REAL_RECORDS_LEDGER),  PRE_RECORDS,  "records ledger must not be touched");
  });

  it("returns all 11 stages in canonical order", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-09T00:00:00Z"));
    assert.equal(snap.stages.length, 11);
    for (let i = 0; i < AUTONOMY_STAGE_ORDER.length; i++) {
      assert.equal(snap.stages[i].id, AUTONOMY_STAGE_ORDER[i]);
    }
  });

  it("includes every expected stage id — planned/not_implemented are NOT hidden", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ids = new Set(snap.stages.map(s => s.id));
    for (const expected of [
      "research_topic",
      "risk_impact_score",
      "hygiene_gate",
      "experiment_candidate",
      "metric_binding",
      "decision_rule",
      "sandbox_execution",
      "decision_outcome",
      "evidence_package",
      "meta_reflection",
      "lessons_database",
    ]) {
      assert.ok(ids.has(expected), `missing stage: ${expected}`);
    }
    // And confirm the future stages are explicitly flagged.
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const lessons = snap.stages.find(s => s.id === "lessons_database")!;
    // Phase 2g: risk_impact_score now has an implementation. With no inputs
    // (TMP DATA_DIR has no research_lab.json or memory_knowledge.json), the
    // stage still scores the five low-risk sandbox kinds from the registry,
    // so it is `active`. With a fully empty registry it would be `ready`.
    assert.ok(risk.status === "active" || risk.status === "ready",
      `risk_impact_score must be active/ready post-Phase-2g, got ${risk.status}`);
    assert.equal(meta.status, "not_implemented");
    assert.equal(lessons.status, "not_implemented");
    for (const s of [risk, meta, lessons]) {
      // Planned/future stages still carry next actions so the gap is readable.
      assert.ok(Array.isArray(s.nextActions) && s.nextActions.length > 0);
    }
  });

  it("handles empty / missing data files gracefully", () => {
    // TMP is empty by design — no research_lab.json, no ledgers, no memory file.
    const snap = buildAutonomyMonitorSnapshot();
    const research = snap.stages.find(s => s.id === "research_topic")!;
    assert.equal(research.counts?.formalHypotheses, 0);
    assert.equal(research.counts?.memoryOriginHypotheses, 0);
    const decision = snap.stages.find(s => s.id === "decision_outcome")!;
    assert.equal(decision.counts?.totalEvents, 0);
    assert.equal(decision.counts?.promote, 0);
    assert.equal(decision.counts?.reject, 0);
    assert.equal(decision.counts?.continue_, 0);
    assert.equal(decision.counts?.needs_review, 0);
    const evidence = snap.stages.find(s => s.id === "evidence_package")!;
    assert.equal(evidence.counts?.totalRecords, 0);
    assert.equal(evidence.counts?.activeRegistrations, 0);
  });

  it("safety boundary banner: all flags true", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const b = snap.safetyBoundary;
    assert.equal(b.noAutoPost, true);
    assert.equal(b.noAutoPublish, true);
    assert.equal(b.noAutoPromote, true);
    assert.equal(b.noScheduler, true);
    assert.equal(b.publicApprovalRequired, true);
    assert.ok(b.banner && b.banner.length > 20);
  });

  it("memory-origin hygiene: feedEligible 0 / refused", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const hygiene = snap.stages.find(s => s.id === "hygiene_gate")!;
    assert.equal(hygiene.counts?.memoryFeedEligible, 0);
    assert.equal(hygiene.extra?.memoryRefused, true);
    assert.ok(
      typeof hygiene.extra?.memoryRefusalReason === "string" &&
      (hygiene.extra!.memoryRefusalReason as string).length > 0,
    );
  });

  it("low-risk registry: disabled kinds visible but disabled", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const sandbox = snap.stages.find(s => s.id === "sandbox_execution")!;
    const kinds = (sandbox.extra?.kinds as Array<Record<string, unknown>>) ?? [];
    assert.equal(kinds.length, 5, "all five low-risk kinds must be visible");
    const enabled = kinds.filter(k => k.enabled === true);
    const disabled = kinds.filter(k => k.enabled !== true);
    assert.equal(enabled.length, 1);
    assert.equal(disabled.length, 4);
    assert.equal(enabled[0].kind, "summarizationTemplate");
    for (const d of disabled) {
      assert.ok(typeof d.disabledReason === "string" && (d.disabledReason as string).length > 0);
    }
  });

  it("pipeline summary reflects implemented vs planned count", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const { implementedStageCount, plannedStageCount, totalStageCount, headline } = snap.pipelineSummary;
    assert.equal(totalStageCount, 11);
    assert.equal(implementedStageCount + plannedStageCount, 11);
    // Phase 2g: risk_impact_score is now implemented; only meta_reflection
    // + lessons_database remain not_implemented.
    assert.equal(plannedStageCount, 2);
    assert.equal(implementedStageCount, 9);
    assert.ok(headline.includes("approval-gated"));
  });

  it("risk_impact_score: scores low-risk registry kinds; only summarizationTemplate is eligible/low-risk", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    // Even with empty data files, the five sandbox kinds are scored.
    assert.ok((risk.counts?.scoredInputs ?? 0) >= 5);
    // Exactly one (summarizationTemplate) lands at eligible/low-risk.
    assert.ok((risk.counts?.eligibleLowRisk ?? 0) >= 1);
    // The other four sandbox kinds are needs_review (not blocked, not eligible).
    assert.ok((risk.counts?.needsReview ?? 0) >= 4);
    // The implementation pointer is present.
    assert.ok(
      Array.isArray(risk.implementedBy) &&
      risk.implementedBy!.some(p => p.includes("hypothesisRiskImpactScoring")),
    );
  });

  it("risk_impact_score: read-only / no action controls — invariants surfaced in extra", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    // The stage advertises its propose-only invariant but does NOT expose any
    // actionable next steps that would post / publish / promote / apply.
    const next = (risk.nextActions ?? []).join(" ");
    assert.ok(!/post\s+now|publish\s+now|apply\s+now|promote\s+now/i.test(next),
      "risk_impact_score must not advertise actionable mutation");
    assert.ok(typeof risk.extra?.proposeOnlyInvariant === "string");
    assert.ok(typeof risk.extra?.defaultRefuseInvariant === "string");
  });
});

describe("autonomyMonitor — surfaces real ledger + registration data", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    // Seed one Phase 2d decision event of each verdict.
    const common = {
      hypothesisId: "hyp-monitor-1",
      metricKey:    "summary_quality_score",
      reason:       "seed",
      evidence:     ["seed"],
      decidedAt:    "2026-05-09T00:00:00Z",
      thresholdsUsed: {
        minSamplesPerArm:            30,
        minDeltaForPromote:          0.01,
        maxGuardrailRegressionRatio: 0.05,
        costRegressionTolerance:     0.10,
      } as const,
    };
    for (const verdict of ["promote", "reject", "continue", "needs_review"] as const) {
      const reasonCode: any = verdict === "promote"
        ? "primary_metric_better"
        : verdict === "reject"
          ? "guardrail_failure"
          : verdict === "continue"
            ? "insufficient_sample"
            : "inconclusive";
      const res = appendDecisionEvent({
        decision: { ...common, verdict, reasonCode } as any,
        source: "test:autonomyMonitor",
        ruleVersion: "phase2c.v1",
      });
      assert.equal((res as any).ok, true, `seed failed: ${JSON.stringify(res)}`);
    }

    // Seed one Phase 2e-c registration + one refused record.
    const reg = registerLowRiskSandboxKind("summarizationTemplate", {
      featureFlag:       true,
      operatorApproved:  true,
      dryRun:            true,
      fixtureSource:     "static",
      maxTrials:         3,
      promotionEligible: false,
      useScheduler:      false,
    });
    if (!(reg as any).ok) {
      throw new Error("seed: failed to register low-risk summarizationTemplate kind");
    }
    const regRes = appendRegistrationRecord({
      registration:         reg as any,
      rollbackInstructions: ["no-op: sandbox-only dry run"],
      operator:             { source: "test:autonomyMonitor" },
      featureFlagState:     { name: "phase2eb", enabled: true },
      sandboxAutoApplyEligible: true,
    });
    assert.equal((regRes as any).ok, true);

    const refusedReg = registerLowRiskSandboxKind("reasoningTemplate", {
      featureFlag:       true,
      operatorApproved:  true,
      dryRun:            true,
      fixtureSource:     "static",
      maxTrials:         3,
      promotionEligible: false,
      useScheduler:      false,
    });
    assert.equal((refusedReg as any).ok, false);
    const refRes = appendRefusedRegistrationRecord({
      refusal:   refusedReg as any,
      operator:  { source: "test:autonomyMonitor" },
      featureFlagState: { name: "phase2eb", enabled: true },
    });
    assert.equal((refRes as any).ok, true);
  });

  it("decision_outcome counts reflect seeded verdicts + latest tail populated", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const d = snap.stages.find(s => s.id === "decision_outcome")!;
    assert.equal(d.counts?.totalEvents, 4);
    assert.equal(d.counts?.promote, 1);
    assert.equal(d.counts?.reject, 1);
    assert.equal(d.counts?.continue_, 1);
    assert.equal(d.counts?.needs_review, 1);
    assert.ok(Array.isArray(d.latest) && d.latest!.length >= 1);
    assert.equal(d.status, "active");
  });

  it("evidence_package counts reflect seeded registration + refused + sandboxAutoApplyEligible", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const e = snap.stages.find(s => s.id === "evidence_package")!;
    assert.ok((e.counts?.totalRecords ?? 0) >= 2);
    assert.ok((e.counts?.registrationEvents ?? 0) >= 1);
    assert.ok((e.counts?.refusedEvents ?? 0) >= 1);
    assert.ok((e.counts?.sandboxAutoApplyEligible ?? 0) >= 1);
    assert.ok((e.counts?.activeRegistrations ?? 0) >= 1);
    // Even with sandboxAutoApplyEligible > 0, the stage must NOT expose any
    // actionable surface — there are no nextActions that propose applying.
    assert.ok(
      !(e.nextActions ?? []).some(a => /apply\s+now|run\s+now|promote\s+now/i.test(a)),
      "evidence_package must not advertise actionable auto-apply",
    );
  });
});

describe("autonomyMonitor — read-only invariant", () => {
  it("building the snapshot does not create ledger files under DATA_DIR", () => {
    // Re-run build; then scan what's in DATA_DIR. Ledger files may exist
    // because the seeded ledger test above wrote them — but calling the
    // aggregator on its own must not create additional files.
    const beforeList = new Set(fs.readdirSync(TMP));
    buildAutonomyMonitorSnapshot();
    buildAutonomyMonitorSnapshot();
    const afterList = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...afterList].sort(), [...beforeList].sort());
  });

  it("building the snapshot does not throw when ledger files are absent at module-load time", () => {
    // The TMP DATA_DIR was empty when the module was first imported. Today
    // we have written events, but the module's reads stay defensive: even if
    // any file is suddenly removed, the aggregator returns 0 counts for that
    // stage rather than throwing.
    fs.rmSync(path.join(TMP, "experiment_decision_events.jsonl"), { force: true });
    fs.rmSync(path.join(TMP, "sandbox_registration_records.jsonl"), { force: true });
    const snap = buildAutonomyMonitorSnapshot();
    const d = snap.stages.find(s => s.id === "decision_outcome")!;
    assert.equal(d.counts?.totalEvents, 0);
    const e = snap.stages.find(s => s.id === "evidence_package")!;
    assert.equal(e.counts?.totalRecords, 0);
  });
});
