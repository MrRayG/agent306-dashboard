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
    // Phase 2g: risk_impact_score now has an implementation. With no real
    // research inputs (TMP DATA_DIR has no research_lab.json or
    // memory_knowledge.json), the stage scores the static low-risk sandbox
    // registry as a self-test only — status MUST stay `ready` rather than
    // claim `active` and mislead the operator about live activity.
    assert.equal(risk.status, "ready",
      `risk_impact_score must be ready (not active) when there are no real research inputs, got ${risk.status}`);
    // Phase 2j-b: meta_reflection now has a live, read-only generator.
    // With registration history visible the generator emits at least the
    // disabled-kind + history-empty/populated candidates, so the stage
    // typically lands at `active`. Either `active` or `ready` is valid —
    // the stage must NOT remain `not_implemented`.
    assert.ok(meta.status === "active" || meta.status === "ready",
      `meta_reflection must be active or ready in phase 2j-b, got ${meta.status}`);
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
    // Phase 2j-b: meta_reflection is now implemented (live, read-only
    // generator). Only lessons_database remains not_implemented.
    assert.equal(plannedStageCount, 1);
    assert.equal(implementedStageCount, 10);
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

  it("risk_impact_score: extra.byReasonCode shape is the dashboard contract", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    const byReasonCode = risk.extra?.byReasonCode as Record<string, number> | undefined;
    assert.ok(byReasonCode && typeof byReasonCode === "object",
      "extra.byReasonCode must be an object — the dashboard reads it");
    // Every reason code is a number, including the 0s. The dashboard filters
    // by > 0 itself; the contract here is that the keys are stable.
    for (const v of Object.values(byReasonCode!)) {
      assert.equal(typeof v, "number");
    }
    // The neutral allow-list must be exposed so the dashboard does not
    // hard-code which codes are eligible vs alarming. It must include at
    // least the affirmative codes plus hygiene_resolved_archived.
    const neutral = risk.extra?.neutralReasonCodes;
    assert.ok(Array.isArray(neutral), "extra.neutralReasonCodes must be an array");
    const neutralSet = new Set(neutral as string[]);
    for (const code of [
      "low_risk_sandbox_fixture_shape",
      "summarization_template_kind",
      "readiness_complete_metric_present",
      "hygiene_resolved_archived",
    ]) {
      assert.ok(neutralSet.has(code), `neutralReasonCodes must include ${code}`);
    }
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

describe("autonomyMonitor — phase 2g status / dedupe / resolved-archived behavior", () => {
  const RESEARCH = path.join(TMP, "research_lab.json");
  const MEMORY   = path.join(TMP, "memory_knowledge.json");

  after(() => {
    fs.rmSync(RESEARCH, { force: true });
    fs.rmSync(MEMORY,   { force: true });
  });

  it("status flips to active when at least one real formal hypothesis is present", () => {
    fs.writeFileSync(RESEARCH, JSON.stringify({
      hypotheses: [
        {
          id: "hyp_real_1",
          claim: "real claim that is at least ten chars long",
          basis: "evidence basis",
          metric: "primary_metric",
          prediction: "specific predicted outcome",
          timeframe: "Q3 2026",
          status: "testing",
          confidence: "medium",
          formedAt: "2026-04-01T00:00:00Z",
          measurementPath: "data/source_x.jsonl",
          hygieneTag: "ready_for_experiment",
        },
      ],
    }));
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    assert.equal(risk.status, "active", "real research input must escalate stage to active");
    assert.ok((risk.counts?.realResearchInputs ?? 0) >= 1);
    assert.ok((risk.counts?.eligible ?? 0) >= 1);
    fs.rmSync(RESEARCH, { force: true });
  });

  it("resolved (status=confirmed/rejected) records emit hygiene_resolved_archived, not hygiene_archived_or_blocked", () => {
    fs.writeFileSync(RESEARCH, JSON.stringify({
      hypotheses: [
        {
          id: "hyp_confirmed",
          claim: "this hypothesis has been confirmed by data",
          basis: "long-form basis text",
          metric: "primary_metric",
          prediction: "specific predicted outcome",
          timeframe: "Q3 2026",
          status: "confirmed",
          confidence: "high",
          formedAt: "2026-01-01T00:00:00Z",
          measurementPath: "data/source_x.jsonl",
        },
      ],
    }));
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    const byCode = risk.extra?.byReasonCode as Record<string, number>;
    assert.ok((byCode.hygiene_resolved_archived ?? 0) >= 1);
    assert.equal(byCode.hygiene_archived_or_blocked, 0);
    // It must NOT show up in the alarming blockers list.
    const blockerJoined = (risk.blockers ?? []).join(" ");
    assert.ok(!/hygiene-archived|hygiene-blocked/.test(blockerJoined),
      "resolved records must not appear in blockers");
    // notes mentions the resolved count.
    const notes = (risk.extra?.notes as string[] | undefined) ?? [];
    assert.ok(notes.some(n => /resolved/i.test(n)));
    fs.rmSync(RESEARCH, { force: true });
  });

  it("memory entries with promotedToHypothesisId are deduped from scoring", () => {
    fs.writeFileSync(MEMORY, JSON.stringify({
      entries: [
        { id: "mem_unp_1", title: "Hypothesis: unpromoted A" },
        { id: "mem_promoted_1", title: "Hypothesis: already promoted B", promotedToHypothesisId: "hyp_x" },
      ],
    }));
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    // Only the unpromoted memory entry must be scored.
    const byCode = risk.extra?.byReasonCode as Record<string, number>;
    assert.equal(byCode.memory_origin_blocked, 1);
    assert.equal(risk.counts?.memoryAlreadyPromoted, 1);
    fs.rmSync(MEMORY, { force: true });
  });

  it("memory entry id is preserved in the latest tail (never collapses to memory:(missing))", () => {
    fs.writeFileSync(MEMORY, JSON.stringify({
      entries: [
        { id: "mem_tailtest_42", title: "Hypothesis: tail test" },
      ],
    }));
    const snap = buildAutonomyMonitorSnapshot();
    const risk = snap.stages.find(s => s.id === "risk_impact_score")!;
    const tail = (risk.latest ?? []) as Array<Record<string, unknown>>;
    const memRow = tail.find(r => String(r.refId).startsWith("memory:"));
    assert.ok(memRow, "memory entry must appear in tail");
    assert.equal(memRow!.refId, "memory:mem_tailtest_42");
    fs.rmSync(MEMORY, { force: true });
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
