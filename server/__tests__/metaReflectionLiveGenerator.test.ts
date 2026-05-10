/**
 * Tests for Phase 2j-b — live meta-reflection generator + autonomy monitor
 * surface.
 *
 * Spec invariants this file pins:
 *   1. The live generator returns a deterministic, well-typed report on a
 *      cold (empty) data dir — no throw, no missing fields.
 *   2. End-to-end: latest evidence (history → audit export → readiness) flows
 *      through the live generator into the autonomy monitor's
 *      `meta_reflection` stage `extra.liveReport`.
 *   3. After seeding a Phase 2i-a fixture registration the live report
 *      surfaces the new evidence verbatim AND the autonomy monitor's
 *      meta_reflection stage status flips from `ready` to `active`.
 *   4. Repeated calls with the same evidence are deeply equal AND
 *      byte-identical when serialized.
 *   5. Every emitted candidate is `humanReviewRequired: true` and
 *      `autoApplyEligible: false`. Disabled kinds remain disabled — no
 *      candidate proposes enabling.
 *   6. The live generator does not write/mutate ledger / DB / fs / env state
 *      — real data fixtures are byte-identical after the test run, the
 *      seeded TMP ledger size only grows via the explicit seed call.
 *   7. `metrics.qualityScore` is intentionally `null` (Phase 2j-c
 *      placeholder).
 *   8. Missing/error sources surface as `missingSourceWarnings` rather than
 *      throwing.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// real ledger files were touched. Match the Phase 2j-a guard pattern.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2jb-meta-reflection-live-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildMetaReflectionLiveReport,
  serializeMetaReflectionLiveReport,
  META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION,
  META_REFLECTION_LIVE_REPORT_LABEL,
} = await import("../experiments/metaReflectionLiveGenerator.ts");

const {
  META_REFLECTION_CANDIDATE_SCHEMA_VERSION,
  META_REFLECTION_CANDIDATE_LABEL,
} = await import("../experiments/metaReflectionCandidateSchema.ts");

const {
  buildSandboxRegistrationHistorySnapshot,
} = await import("../experiments/sandboxRegistrationHistory.ts");

const {
  buildSandboxRegistrationAuditExport,
} = await import("../experiments/sandboxRegistrationAuditExport.ts");

const {
  buildLowRiskSandboxReadinessSnapshot,
} = await import("../experiments/lowRiskSandboxReadiness.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const {
  executeSummarizationFixtureRegistration,
} = await import("../experiments/summarizationSandboxFixtureRegistration.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);

before(() => {
  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(TMP_LEDGER); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  // Real data fixtures must be byte-identical after the test run.
  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2j-b tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2j-b tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2j-b tests created live ${label}!`);
    }
  }
});

// ── Live generator on cold (empty) state ────────────────────────────────────

describe("Phase 2j-b — live generator on cold/empty evidence", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
  });

  it("returns a well-typed report with stable schema metadata", () => {
    const r = buildMetaReflectionLiveReport();
    assert.equal(r.schemaVersion, META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION);
    assert.equal(r.label, META_REFLECTION_LIVE_REPORT_LABEL);
    assert.equal(r.candidateSetSchemaVersion, META_REFLECTION_CANDIDATE_SCHEMA_VERSION);
    assert.equal(r.candidateSetLabel, META_REFLECTION_CANDIDATE_LABEL);
    assert.equal(r.generatedBy, "autonomy_monitor");
    assert.equal(r.generatedAt, null, "no `now` injected → null");
    assert.equal(typeof r.isEmpty, "boolean");
  });

  it("invariants restate the propose-only / read-only contract", () => {
    const r = buildMetaReflectionLiveReport();
    assert.equal(r.invariants.readOnly, true);
    assert.equal(r.invariants.proposeOnly, true);
    assert.equal(r.invariants.nonWidening, true);
    assert.equal(r.invariants.autoApplyEligible, false);
    assert.equal(r.invariants.publicAction, false);
    assert.equal(r.invariants.schedulerDriven, false);
    assert.equal(r.invariants.mutating, false);
    assert.equal(r.invariants.humanReviewRequired, true);
  });

  it("`metrics.qualityScore` is null (Phase 2j-c placeholder)", () => {
    const r = buildMetaReflectionLiveReport();
    assert.equal(r.metrics.qualityScore, null);
  });

  it("emits empty-history + absent-fixture + 4 disabled-kind candidates from cold registry", () => {
    const r = buildMetaReflectionLiveReport();
    // History reads cleanly even on cold ledger (Phase 2i-b helper is
    // defensive). Audit export derives from history. Readiness derives
    // from the registry. Risk-impact is opt-in → reported as missing.
    const codes = [...r.candidateSet.candidates].map(c => c.reasonCode).sort();
    // Disabled-kind (4) + history-empty (1) + audit-empty (1) +
    // fixture-absent (1) + readiness candidates for the four non-ready
    // kinds. Total should be at least 7. We don't pin the exact readiness
    // count because it depends on whether the four disabled kinds report
    // `blocked` or `needs_review` — both yield candidates.
    assert.ok(codes.includes("registration_history_empty"));
    assert.ok(codes.includes("audit_export_empty"));
    assert.ok(codes.includes("evidence_absent_summarization_fixture"));
    const disabledCount = codes.filter(c => c === "disabled_kind_remains_disabled").length;
    assert.equal(disabledCount, 4, `expected 4 disabled-kind candidates, got ${disabledCount}`);
  });

  it("source reports include all four sources with stable order", () => {
    const r = buildMetaReflectionLiveReport();
    const sourceIds = r.latestEvidenceMarker.sources.map(s => s.source);
    assert.deepEqual(sourceIds, [
      "lowRiskSandboxReadiness",
      "registrationAuditExport",
      "registrationHistory",
      "riskImpact",
    ]);
  });

  it("riskImpact source is reported as missing when not injected", () => {
    const r = buildMetaReflectionLiveReport();
    const ri = r.latestEvidenceMarker.sources.find(s => s.source === "riskImpact")!;
    assert.equal(ri.status, "missing");
    assert.ok(r.missingSourceWarnings.some(w => w.includes("riskImpact")),
      `expected a missingSourceWarnings entry mentioning riskImpact, got ${JSON.stringify(r.missingSourceWarnings)}`);
  });

  it("history + audit export + readiness all load cleanly on cold registry", () => {
    const r = buildMetaReflectionLiveReport();
    const history   = r.latestEvidenceMarker.sources.find(s => s.source === "registrationHistory")!;
    const audit     = r.latestEvidenceMarker.sources.find(s => s.source === "registrationAuditExport")!;
    const readiness = r.latestEvidenceMarker.sources.find(s => s.source === "lowRiskSandboxReadiness")!;
    assert.ok(["available_empty", "available_populated"].includes(history.status));
    assert.ok(["available_empty", "available_populated"].includes(audit.status));
    assert.equal(readiness.status, "available_populated");
    assert.ok(r.latestEvidenceMarker.generatedFromLatestEvidence);
  });

  it("repeated calls with identical inputs are deeply equal AND byte-identical when serialized", () => {
    // Inject pre-built history/readiness snapshots so neither call re-reads
    // process state — pins the determinism we care about.
    const history = buildSandboxRegistrationHistorySnapshot();
    const auditExport = buildSandboxRegistrationAuditExport({ snapshot: history });
    const readiness = buildLowRiskSandboxReadinessSnapshot();
    const a = buildMetaReflectionLiveReport({ history, auditExport, readiness });
    const b = buildMetaReflectionLiveReport({ history, auditExport, readiness });
    assert.deepEqual(a, b);
    assert.equal(
      serializeMetaReflectionLiveReport(a),
      serializeMetaReflectionLiveReport(b),
    );
    assert.equal(
      serializeMetaReflectionLiveReport(a, { indent: 2 }),
      serializeMetaReflectionLiveReport(b, { indent: 2 }),
    );
  });
});

// ── End-to-end: evidence/history/audit → live generator → autonomy monitor ──

describe("Phase 2j-b — end-to-end evidence → reflection → monitor surface", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
  });

  it("on a cold deployment, autonomy monitor surfaces a meta_reflection liveReport", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    assert.ok(meta);
    assert.notEqual(meta.status, "not_implemented",
      "Phase 2j-b: meta_reflection must no longer be not_implemented");
    const live = (meta.extra as any)?.liveReport;
    assert.ok(live, "extra.liveReport must be present on the meta_reflection stage");
    assert.equal(live.schemaVersion, META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION);
    assert.equal(live.label, META_REFLECTION_LIVE_REPORT_LABEL);
    assert.equal(live.candidateSetSchemaVersion, META_REFLECTION_CANDIDATE_SCHEMA_VERSION);
    assert.equal(live.candidateSetLabel, META_REFLECTION_CANDIDATE_LABEL);
    assert.ok(Array.isArray(live.candidateSet.candidates));
    assert.equal(typeof live.metrics.candidateCount, "number");
    assert.equal(live.metrics.qualityScore, null);
    // Counts mirror the live report.
    assert.equal(meta.counts?.candidateCount, live.candidateSet.candidates.length);
    assert.equal(meta.counts?.humanReviewRequiredCount, live.metrics.humanReviewRequiredCount);
    assert.equal(meta.counts?.autoApplyEligibleCount, 0);
  });

  it("status is `active` when the live report has at least one candidate; `ready` otherwise", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const live = (meta.extra as any).liveReport;
    if (live.candidateSet.candidates.length > 0) {
      assert.equal(meta.status, "active");
    } else {
      assert.equal(meta.status, "ready");
    }
  });

  it("monitor surface restates propose-only / non-widening invariants in extra", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const extra = meta.extra as any;
    assert.equal(typeof extra.proposeOnlyInvariant, "string");
    assert.equal(typeof extra.nonWideningInvariant, "string");
    assert.equal(typeof extra.qualityScorePlaceholder, "string");
    assert.equal(typeof extra.latestEvidenceProvenance, "string");
    assert.ok(extra.latestEvidenceProvenance.includes(META_REFLECTION_LIVE_REPORT_SCHEMA_VERSION));
  });

  it("seeding a Phase 2i-a fixture registration flows through into monitor exposure", () => {
    // Drive evidence into the ledger via the public registration helper.
    const r1 = executeSummarizationFixtureRegistration({
      source: "test:phase2j-b-e2e",
      now:    new Date("2026-05-10T15:00:00.000Z"),
    });
    assert.equal((r1 as any).ok, true, `seed registration failed: ${(r1 as any).reason}`);

    // Build the autonomy monitor snapshot AFTER seeding evidence — the
    // live generator should pick it up via the same defensive helpers.
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const live = (meta.extra as any).liveReport;
    const codes = live.candidateSet.candidates.map((c: any) => c.reasonCode);

    // The seeded fixture must surface as the present-evidence + populated-
    // history + audit-present codes. Disabled kinds remain disabled.
    assert.ok(codes.includes("evidence_present_summarization_fixture"),
      `expected evidence_present_summarization_fixture in ${JSON.stringify(codes)}`);
    assert.ok(codes.includes("registration_history_populated"),
      `expected registration_history_populated in ${JSON.stringify(codes)}`);
    assert.ok(codes.includes("audit_export_present"),
      `expected audit_export_present in ${JSON.stringify(codes)}`);

    // Status must escalate to `active` once candidates exist.
    assert.equal(meta.status, "active");

    // Disabled kinds remain disabled — every disabled-kind candidate is
    // present and none proposes enabling.
    const disabled = live.candidateSet.candidates.filter(
      (c: any) => c.reasonCode === "disabled_kind_remains_disabled",
    );
    assert.equal(disabled.length, 4);
    for (const c of disabled) {
      assert.doesNotMatch(String(c.body), /\benable\b/i);
      assert.doesNotMatch(String(c.body), /\bunblock\b/i);
    }
  });

  it("every candidate on the monitor exposure is human-review-required and not auto-apply eligible", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const live = (meta.extra as any).liveReport;
    for (const c of live.candidateSet.candidates) {
      assert.equal(c.humanReviewRequired, true);
      assert.equal(c.autoApplyEligible,   false);
      assert.equal(c.riskLevel, "low");
      assert.equal(c.invariants.proposeOnly, true);
      assert.equal(c.invariants.autoApplyEligible, false);
      assert.equal(c.invariants.publicAction, false);
      assert.equal(c.invariants.schedulerDriven, false);
      assert.equal(c.invariants.mutating, false);
    }
    // Also pinned at the report level.
    assert.equal(live.metrics.autoApplyEligibleCount, 0);
    assert.equal(live.metrics.humanReviewRequiredCount, live.candidateSet.candidates.length);
  });

  it("monitor exposure is read-only — repeated calls don't grow the ledger", () => {
    // After the seed test above the ledger has rows; calling the autonomy
    // monitor + live generator repeatedly must NOT append to it.
    const sizeBefore = fs.statSync(TMP_LEDGER).size;
    for (let i = 0; i < 3; i++) {
      buildAutonomyMonitorSnapshot();
      buildMetaReflectionLiveReport();
    }
    const sizeAfter = fs.statSync(TMP_LEDGER).size;
    assert.equal(sizeAfter, sizeBefore, "live generator + monitor exposure must not mutate the ledger");
  });
});

// ── Injected risk-impact summary ────────────────────────────────────────────

describe("Phase 2j-b — injected risk-impact summary", () => {
  it("emits risk-impact candidates when blocked / needs_review > 0", () => {
    const ri = {
      total: 3,
      byDecision:   { eligible: 0, needs_review: 1, blocked: 2 },
      byRisk:       { low: 1, moderate: 1, high: 1, unclassifiable: 0 },
      byImpact:     { low: 1, moderate: 1, high: 1, unknown: 0 },
      byReadiness:  { ready: 1, planned: 0, blocked: 2 },
      byReasonCode: {} as Record<string, number>,
      eligibleLowRisk: 0,
    } as any;
    const r = buildMetaReflectionLiveReport({ riskImpact: ri });
    const codes = r.candidateSet.candidates.map(c => c.reasonCode);
    assert.ok(codes.includes("risk_impact_blocked_present"));
    assert.ok(codes.includes("risk_impact_needs_review_present"));
    const riReport = r.latestEvidenceMarker.sources.find(s => s.source === "riskImpact")!;
    assert.equal(riReport.status, "available_populated");
    assert.equal(riReport.recordCount, 3);
  });

  it("source report distinguishes available_empty from missing for risk-impact", () => {
    const empty = {
      total: 0,
      byDecision:   { eligible: 0, needs_review: 0, blocked: 0 },
      byRisk:       { low: 0, moderate: 0, high: 0, unclassifiable: 0 },
      byImpact:     { low: 0, moderate: 0, high: 0, unknown: 0 },
      byReadiness:  { ready: 0, planned: 0, blocked: 0 },
      byReasonCode: {} as Record<string, number>,
      eligibleLowRisk: 0,
    } as any;
    const r = buildMetaReflectionLiveReport({ riskImpact: empty });
    const riReport = r.latestEvidenceMarker.sources.find(s => s.source === "riskImpact")!;
    assert.equal(riReport.status, "available_empty");
    // No candidates expected — empty risk impact emits nothing.
    const codes = r.candidateSet.candidates.map(c => c.reasonCode);
    assert.ok(!codes.includes("risk_impact_blocked_present"));
    assert.ok(!codes.includes("risk_impact_needs_review_present"));
  });
});

// ── Determinism + env hygiene ────────────────────────────────────────────────

describe("Phase 2j-b — determinism + env hygiene", () => {
  it("env snapshot is unchanged by repeated live generator + monitor calls", () => {
    const before = JSON.stringify({
      DATA_DIR: process.env.DATA_DIR,
      DB_PATH:  process.env.DB_PATH,
    });
    for (let i = 0; i < 5; i++) {
      buildMetaReflectionLiveReport();
      buildAutonomyMonitorSnapshot();
    }
    const after = JSON.stringify({
      DATA_DIR: process.env.DATA_DIR,
      DB_PATH:  process.env.DB_PATH,
    });
    assert.equal(before, after, "env vars must not change across calls");
  });

  it("`generatedAt` is null by default and an ISO string when injected", () => {
    const def = buildMetaReflectionLiveReport();
    assert.equal(def.generatedAt, null);
    const fixed = buildMetaReflectionLiveReport({ now: new Date("2026-05-10T15:00:00.000Z") });
    assert.equal(fixed.generatedAt, "2026-05-10T15:00:00.000Z");
    const fixedStr = buildMetaReflectionLiveReport({ now: "2026-05-10T15:00:00.000Z" });
    assert.equal(fixedStr.generatedAt, "2026-05-10T15:00:00.000Z");
  });

  it("reasonCodeCounts include every reason code, with non-emitted codes at 0", () => {
    const r = buildMetaReflectionLiveReport();
    const codes = r.metrics.reasonCodeCounts.map(rc => rc.reasonCode);
    // Closed set must include every documented reason code.
    for (const expected of [
      "evidence_present_summarization_fixture",
      "evidence_absent_summarization_fixture",
      "registration_history_empty",
      "registration_history_populated",
      "registration_history_refused_present",
      "audit_export_present",
      "audit_export_empty",
      "disabled_kind_remains_disabled",
      "readiness_blocked_kind",
      "readiness_needs_review_kind",
      "risk_impact_blocked_present",
      "risk_impact_needs_review_present",
    ]) {
      assert.ok(codes.includes(expected as any), `missing reason code in counts: ${expected}`);
    }
    // Sum of counts equals candidateCount.
    const sum = r.metrics.reasonCodeCounts.reduce((acc, rc) => acc + rc.count, 0);
    assert.equal(sum, r.metrics.candidateCount);
  });
});
