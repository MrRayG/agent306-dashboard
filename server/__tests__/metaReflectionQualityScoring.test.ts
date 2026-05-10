/**
 * Tests for Phase 2j-c — reflection quality scoring.
 *
 * Spec invariants pinned by this file:
 *   1. Scoring is deterministic — repeated calls with the same report return
 *      deeply equal output AND byte-identical serialised strings.
 *   2. Populated reports yield non-zero dimension scores and a sensible
 *      overall band; empty/cold reports score 0/cold gracefully.
 *   3. Missing-source warnings reduce the evidence-coverage and
 *      missing-source-penalty dimensions predictably.
 *   4. Candidates missing required metadata score lower on metadata
 *      completeness, actionability, and traceability.
 *   5. Safety-compliance dimension catches a malformed candidate
 *      (`humanReviewRequired: false`, `autoApplyEligible: true`, wrong
 *      risk level, or invariants flipped). The overall band is capped at
 *      `low` when any candidate fails compliance.
 *   6. Autonomy monitor exposes the quality score under `extra.qualityScore`,
 *      with no buttons / controls and no mutation of the underlying
 *      `metrics.qualityScore: null` placeholder.
 *   7. Scorer does not write to ledger/db/fixture/env/fs. Real data fixtures
 *      are byte-identical after the test run.
 *   8. Disabled kinds remain disabled — scoring cannot turn a disabled-kind
 *      candidate into an enable/register/promote action. The scorer never
 *      emits text proposing enabling.
 *   9. `applyEligibility` is always `"none"` and `advisoryOnly` is always
 *      `true`. `humanReviewNeededCount` matches the candidate count.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Per-process tmpdir + isolated DB path so we can confirm later that no
// real ledger files were touched. Match the Phase 2j-a / 2j-b guard pattern.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2jc-meta-reflection-quality-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const TMP_LEDGER = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  scoreMetaReflectionLiveReport,
  serializeMetaReflectionQualityScore,
  META_REFLECTION_QUALITY_SCORE_SCHEMA_VERSION,
  META_REFLECTION_QUALITY_SCORE_LABEL,
} = await import("../experiments/metaReflectionQualityScoring.ts");

const {
  buildMetaReflectionLiveReport,
} = await import("../experiments/metaReflectionLiveGenerator.ts");

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

  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2j-c tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2j-c tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2j-c tests created live ${label}!`);
    }
  }
});

// ── Schema + invariants ──────────────────────────────────────────────────────

describe("Phase 2j-c — schema, labels, invariants", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
  });

  it("score carries the documented schema/label", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    assert.equal(s.schemaVersion, META_REFLECTION_QUALITY_SCORE_SCHEMA_VERSION);
    assert.equal(s.label, META_REFLECTION_QUALITY_SCORE_LABEL);
  });

  it("invariants restate the propose-only / advisory-only contract", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    assert.equal(s.advisoryOnly, true);
    assert.equal(s.applyEligibility, "none");
    assert.equal(s.invariants.readOnly, true);
    assert.equal(s.invariants.proposeOnly, true);
    assert.equal(s.invariants.nonWidening, true);
    assert.equal(s.invariants.autoApplyEligible, false);
    assert.equal(s.invariants.publicAction, false);
    assert.equal(s.invariants.schedulerDriven, false);
    assert.equal(s.invariants.mutating, false);
    assert.equal(s.invariants.humanReviewRequired, true);
    assert.equal(s.invariants.advisoryOnly, true);
    assert.equal(s.reviewReadiness.applyEligible, false);
  });

  it("exposes the documented seven dimensions in stable order", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    const ids = s.dimensions.map(d => d.id);
    assert.deepEqual(ids, [
      "evidenceCoverage",
      "traceability",
      "actionabilityForReview",
      "reasonCodeDiversity",
      "safetyCompliance",
      "missingSourcePenalty",
      "metadataCompleteness",
    ]);
  });

  it("each dimension reports a score in [0,1] with a coarse band", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    for (const d of s.dimensions) {
      assert.ok(d.score >= 0 && d.score <= 1, `dim ${d.id} score out of range: ${d.score}`);
      assert.ok(["cold", "low", "moderate", "high"].includes(d.band), `dim ${d.id} unknown band: ${d.band}`);
    }
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe("Phase 2j-c — determinism", () => {
  it("repeated calls with the same report return deeply equal output", () => {
    const r = buildMetaReflectionLiveReport();
    const a = scoreMetaReflectionLiveReport(r);
    const b = scoreMetaReflectionLiveReport(r);
    assert.deepEqual(a, b);
  });

  it("serialised output is byte-identical for the same report", () => {
    const r = buildMetaReflectionLiveReport();
    const a = scoreMetaReflectionLiveReport(r);
    const b = scoreMetaReflectionLiveReport(r);
    assert.equal(
      serializeMetaReflectionQualityScore(a),
      serializeMetaReflectionQualityScore(b),
    );
    assert.equal(
      serializeMetaReflectionQualityScore(a, { indent: 2 }),
      serializeMetaReflectionQualityScore(b, { indent: 2 }),
    );
  });

  it("two independently-built reports with the same evidence yield the same score", () => {
    // Each call rebuilds the live report from the same cold-state sources.
    const a = scoreMetaReflectionLiveReport(buildMetaReflectionLiveReport());
    const b = scoreMetaReflectionLiveReport(buildMetaReflectionLiveReport());
    assert.equal(a.overallScore, b.overallScore);
    assert.equal(a.qualityBand,  b.qualityBand);
    assert.equal(a.usefulnessBand, b.usefulnessBand);
  });

  it("`generatedAt` is null by default and an ISO string when injected", () => {
    const r1 = buildMetaReflectionLiveReport();
    const s1 = scoreMetaReflectionLiveReport(r1);
    assert.equal(s1.generatedAt, null);
    const r2 = buildMetaReflectionLiveReport({ now: new Date("2026-05-10T15:00:00.000Z") });
    const s2 = scoreMetaReflectionLiveReport(r2);
    assert.equal(s2.generatedAt, "2026-05-10T15:00:00.000Z");
  });
});

// ── Cold / empty handling ───────────────────────────────────────────────────

describe("Phase 2j-c — cold/empty reports", () => {
  it("an empty (no-candidates) report scores cold with overall 0", () => {
    const emptyReport = {
      schemaVersion: "phase2j-b.v1" as const,
      label: "agent306.meta_reflection_live_report" as const,
      candidateSetSchemaVersion: "phase2j-a.v1" as const,
      candidateSetLabel: "agent306.meta_reflection_candidate_set" as const,
      generatedAt: null,
      generatedBy: "autonomy_monitor",
      isEmpty: true,
      candidateSet: {
        schemaVersion: "phase2j-a.v1" as const,
        label: "agent306.meta_reflection_candidate_set" as const,
        generatedAt: null,
        generatedBy: "autonomy_monitor",
        isEmpty: true,
        candidates: [],
        aggregate: {
          totalCandidates: 0,
          candidatesByKind: { lesson: 0, observation: 0, question: 0 },
          candidatesBySubsystem: {
            summarizationFixture: 0,
            registrationHistory: 0,
            registrationAuditExport: 0,
            lowRiskSandboxReadiness: 0,
            riskImpact: 0,
          },
          humanReviewRequired: 0,
          autoApplyEligible: 0,
        },
        evidenceProvided: { history: false, auditExport: false, readiness: false, riskImpact: false },
        invariants: {
          readOnly: true, proposeOnly: true, nonWidening: true,
          autoApplyEligible: false, publicAction: false,
          schedulerDriven: false, mutating: false, humanReviewRequired: true,
        },
      },
      latestEvidenceMarker: { generatedFromLatestEvidence: false, sources: [] },
      missingSourceWarnings: [],
      metrics: {
        candidateCount: 0,
        reasonCodeCounts: [],
        humanReviewRequiredCount: 0,
        autoApplyEligibleCount: 0,
        qualityScore: null,
      },
      invariants: {
        readOnly: true, proposeOnly: true, nonWidening: true,
        autoApplyEligible: false, publicAction: false,
        schedulerDriven: false, mutating: false, humanReviewRequired: true,
      },
    } as any;

    const s = scoreMetaReflectionLiveReport(emptyReport);
    assert.equal(s.overallScore, 0);
    assert.equal(s.qualityBand, "cold");
    assert.equal(s.usefulnessBand, "cold");
    assert.equal(s.counts.candidateCount, 0);
    assert.equal(s.counts.humanReviewNeededCount, 0);
    assert.equal(s.counts.autoApplyEligibleCount, 0);
    assert.equal(s.reviewReadiness.readyForReview, false);
    assert.match(s.reviewReadiness.reason, /cold/i);
  });

  it("cold registry (no fixture seeded) still scores without crashing", () => {
    // The real live report on a cold registry has disabled-kind / empty
    // history / empty audit / readiness candidates — plenty of signal,
    // just no fixture evidence. The score should be non-zero, well-formed,
    // and never `cold` band (because candidates are present).
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    assert.ok(s.counts.candidateCount > 0, "cold registry produces candidates from disabled kinds + empty-history");
    assert.ok(s.overallScore >= 0 && s.overallScore <= 1);
    // Missing-source-penalty must reflect that riskImpact is missing.
    const penalty = s.dimensions.find(d => d.id === "missingSourcePenalty")!;
    assert.ok(penalty.score < 1, `missing-source-penalty should reflect a missing source, got ${penalty.score}`);
    // applyEligibility is always "none" even with rich evidence.
    assert.equal(s.applyEligibility, "none");
  });
});

// ── Populated report — flows from a seeded fixture ──────────────────────────

describe("Phase 2j-c — populated report", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(TMP_LEDGER); } catch {}
    const r1 = executeSummarizationFixtureRegistration({
      source: "test:phase2j-c-quality",
      now:    new Date("2026-05-10T15:00:00.000Z"),
    });
    assert.equal((r1 as any).ok, true, `seed registration failed: ${(r1 as any).reason}`);
  });

  it("score is non-zero with non-trivial dimensions when evidence is present", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    assert.ok(s.counts.candidateCount > 0);
    assert.ok(s.overallScore > 0);
    // Evidence coverage should be high — three of four sources loaded
    // populated, one (riskImpact) is missing.
    const cov = s.dimensions.find(d => d.id === "evidenceCoverage")!;
    assert.ok(cov.score > 0, `evidenceCoverage expected > 0, got ${cov.score}`);
    // Safety compliance must be perfect on a real generator output —
    // every Phase 2j-a candidate restates the invariants.
    const safety = s.dimensions.find(d => d.id === "safetyCompliance")!;
    assert.equal(safety.score, 1);
    assert.equal(safety.band, "high");
    // Metadata completeness must also be perfect.
    const meta = s.dimensions.find(d => d.id === "metadataCompleteness")!;
    assert.equal(meta.score, 1);
    // Traceability is high — every candidate has at least one evidence ref.
    const trace = s.dimensions.find(d => d.id === "traceability")!;
    assert.ok(trace.score >= 0.5, `traceability expected >= 0.5, got ${trace.score}`);
  });

  it("missing-source warnings predictably reduce the missing-source-penalty score", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    const penalty = s.dimensions.find(d => d.id === "missingSourcePenalty")!;
    // riskImpact is "missing" by default → 1 of 4 sources missing → score 0.75.
    assert.equal(penalty.score, 0.75);
    assert.equal(s.counts.sourcesAvailableCount, 3);
    assert.equal(s.counts.sourcesMissingOrErroredCount, 1);
    assert.ok(s.counts.missingSourceWarningCount >= 1);
  });

  it("humanReviewNeededCount equals candidate count and autoApplyEligible is 0", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    assert.equal(s.counts.humanReviewNeededCount, s.counts.candidateCount);
    assert.equal(s.counts.autoApplyEligibleCount, 0);
  });

  it("reviewReadiness is set advisedly — readyForReview true only with moderate+ band & safety clean", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    if (s.qualityBand === "moderate" || s.qualityBand === "high") {
      assert.equal(s.reviewReadiness.readyForReview, true);
    } else {
      assert.equal(s.reviewReadiness.readyForReview, false);
    }
    assert.equal(s.reviewReadiness.applyEligible, false);
    assert.equal(typeof s.reviewReadiness.reason, "string");
    assert.ok(s.reviewReadiness.reason.length > 0);
  });
});

// ── Safety compliance — malformed candidate downgrades score ────────────────

describe("Phase 2j-c — safety compliance check", () => {
  function malformedReport(overrides: Record<string, unknown>): any {
    const malformedCandidate = {
      candidateId: "deadbeefdeadbeef",
      schemaVersion: "phase2j-a.v1",
      kind: "observation" as const,
      scope: "test.malformed",
      subsystem: "registrationHistory" as const,
      reasonCode: "registration_history_populated" as const,
      title: "malformed candidate",
      body:  "malformed candidate body",
      confidence: "moderate" as const,
      evidenceStrength: "moderate" as const,
      riskLevel: "low" as const,
      evidenceRefs: [{ source: "registrationHistory" as const, ref: "snapshot.totalRecords", detail: "totalRecords=1" }],
      humanReviewRequired: true,
      autoApplyEligible:  false,
      invariants: {
        readOnly: true, proposeOnly: true, nonWidening: true,
        autoApplyEligible: false, publicAction: false,
        schedulerDriven: false, mutating: false,
      },
      ...overrides,
    };
    return {
      schemaVersion: "phase2j-b.v1",
      label: "agent306.meta_reflection_live_report",
      candidateSetSchemaVersion: "phase2j-a.v1",
      candidateSetLabel: "agent306.meta_reflection_candidate_set",
      generatedAt: null,
      generatedBy: "test",
      isEmpty: false,
      candidateSet: {
        schemaVersion: "phase2j-a.v1",
        label: "agent306.meta_reflection_candidate_set",
        generatedAt: null,
        generatedBy: "test",
        isEmpty: false,
        candidates: [malformedCandidate],
        aggregate: {
          totalCandidates: 1,
          candidatesByKind: { lesson: 0, observation: 1, question: 0 },
          candidatesBySubsystem: {
            summarizationFixture: 0,
            registrationHistory: 1,
            registrationAuditExport: 0,
            lowRiskSandboxReadiness: 0,
            riskImpact: 0,
          },
          humanReviewRequired: 1,
          autoApplyEligible: 0,
        },
        evidenceProvided: { history: true, auditExport: false, readiness: false, riskImpact: false },
        invariants: {
          readOnly: true, proposeOnly: true, nonWidening: true,
          autoApplyEligible: false, publicAction: false,
          schedulerDriven: false, mutating: false, humanReviewRequired: true,
        },
      },
      latestEvidenceMarker: {
        generatedFromLatestEvidence: true,
        sources: [
          { source: "lowRiskSandboxReadiness", status: "available_populated", recordCount: 5, errorMessage: null },
          { source: "registrationAuditExport", status: "available_populated", recordCount: 1, errorMessage: null },
          { source: "registrationHistory",     status: "available_populated", recordCount: 1, errorMessage: null },
          { source: "riskImpact",              status: "missing",             recordCount: 0, errorMessage: null },
        ],
      },
      missingSourceWarnings: ["evidence source \"riskImpact\" was not available"],
      metrics: {
        candidateCount: 1,
        reasonCodeCounts: [],
        humanReviewRequiredCount: 1,
        autoApplyEligibleCount: 0,
        qualityScore: null,
      },
      invariants: {
        readOnly: true, proposeOnly: true, nonWidening: true,
        autoApplyEligible: false, publicAction: false,
        schedulerDriven: false, mutating: false, humanReviewRequired: true,
      },
    };
  }

  it("flips humanReviewRequired to false → safety dimension drops + overall band capped at low", () => {
    const r = malformedReport({ humanReviewRequired: false });
    const s = scoreMetaReflectionLiveReport(r);
    const safety = s.dimensions.find(d => d.id === "safetyCompliance")!;
    assert.ok(safety.score < 1, `safety should fail, got ${safety.score}`);
    // Cap rule pushes the overall band to at most `low`.
    assert.ok(s.overallScore <= 0.499, `overall should be capped at low, got ${s.overallScore}`);
    assert.equal(s.qualityBand, "low");
    assert.equal(s.reviewReadiness.readyForReview, false);
  });

  it("flips autoApplyEligible to true → safety dimension drops + overall capped", () => {
    const r = malformedReport({ autoApplyEligible: true });
    const s = scoreMetaReflectionLiveReport(r);
    const safety = s.dimensions.find(d => d.id === "safetyCompliance")!;
    assert.ok(safety.score < 1);
    assert.ok(s.overallScore <= 0.499);
  });

  it("flips riskLevel away from `low` → safety dimension drops", () => {
    const r = malformedReport({ riskLevel: "high" });
    const s = scoreMetaReflectionLiveReport(r);
    const safety = s.dimensions.find(d => d.id === "safetyCompliance")!;
    assert.ok(safety.score < 1);
  });

  it("flips an invariant (e.g. autoApplyEligible: true on the invariants block) → safety drops", () => {
    const r = malformedReport({
      invariants: {
        readOnly: true, proposeOnly: true, nonWidening: true,
        autoApplyEligible: true, publicAction: false,
        schedulerDriven: false, mutating: false,
      },
    });
    const s = scoreMetaReflectionLiveReport(r);
    const safety = s.dimensions.find(d => d.id === "safetyCompliance")!;
    assert.ok(safety.score < 1);
  });
});

// ── Metadata completeness / actionability / traceability ───────────────────

describe("Phase 2j-c — metadata penalties", () => {
  function reportWithCandidates(candidates: any[]): any {
    return {
      schemaVersion: "phase2j-b.v1",
      label: "agent306.meta_reflection_live_report",
      candidateSetSchemaVersion: "phase2j-a.v1",
      candidateSetLabel: "agent306.meta_reflection_candidate_set",
      generatedAt: null,
      generatedBy: "test",
      isEmpty: candidates.length === 0,
      candidateSet: {
        schemaVersion: "phase2j-a.v1",
        label: "agent306.meta_reflection_candidate_set",
        generatedAt: null,
        generatedBy: "test",
        isEmpty: candidates.length === 0,
        candidates,
        aggregate: {
          totalCandidates: candidates.length,
          candidatesByKind: { lesson: 0, observation: candidates.length, question: 0 },
          candidatesBySubsystem: {
            summarizationFixture: 0,
            registrationHistory: candidates.length,
            registrationAuditExport: 0,
            lowRiskSandboxReadiness: 0,
            riskImpact: 0,
          },
          humanReviewRequired: candidates.length,
          autoApplyEligible: 0,
        },
        evidenceProvided: { history: true, auditExport: false, readiness: false, riskImpact: false },
        invariants: {
          readOnly: true, proposeOnly: true, nonWidening: true,
          autoApplyEligible: false, publicAction: false,
          schedulerDriven: false, mutating: false, humanReviewRequired: true,
        },
      },
      latestEvidenceMarker: {
        generatedFromLatestEvidence: true,
        sources: [
          { source: "lowRiskSandboxReadiness", status: "available_populated", recordCount: 5, errorMessage: null },
          { source: "registrationAuditExport", status: "available_populated", recordCount: 1, errorMessage: null },
          { source: "registrationHistory",     status: "available_populated", recordCount: 1, errorMessage: null },
          { source: "riskImpact",              status: "missing",             recordCount: 0, errorMessage: null },
        ],
      },
      missingSourceWarnings: [],
      metrics: {
        candidateCount: candidates.length,
        reasonCodeCounts: [],
        humanReviewRequiredCount: candidates.length,
        autoApplyEligibleCount: 0,
        qualityScore: null,
      },
      invariants: {
        readOnly: true, proposeOnly: true, nonWidening: true,
        autoApplyEligible: false, publicAction: false,
        schedulerDriven: false, mutating: false, humanReviewRequired: true,
      },
    };
  }

  function completeCandidate(overrides: Partial<any> = {}): any {
    return {
      candidateId: "deadbeefdeadbeef",
      schemaVersion: "phase2j-a.v1",
      kind: "observation",
      scope: "test.complete",
      subsystem: "registrationHistory",
      reasonCode: "registration_history_populated",
      title: "complete title",
      body:  "complete body",
      confidence: "moderate",
      evidenceStrength: "moderate",
      riskLevel: "low",
      evidenceRefs: [{ source: "registrationHistory", ref: "snapshot.totalRecords", detail: "totalRecords=1" }],
      humanReviewRequired: true,
      autoApplyEligible:  false,
      invariants: {
        readOnly: true, proposeOnly: true, nonWidening: true,
        autoApplyEligible: false, publicAction: false,
        schedulerDriven: false, mutating: false,
      },
      ...overrides,
    };
  }

  it("candidates missing required metadata score lower on metadata completeness", () => {
    const complete   = completeCandidate();
    const incomplete = completeCandidate({ candidateId: "feedfacefeedface", title: "" });
    const sFull = scoreMetaReflectionLiveReport(reportWithCandidates([complete, complete]));
    const sBad  = scoreMetaReflectionLiveReport(reportWithCandidates([complete, incomplete]));
    const fullMeta = sFull.dimensions.find(d => d.id === "metadataCompleteness")!.score;
    const badMeta  = sBad.dimensions.find(d => d.id === "metadataCompleteness")!.score;
    assert.equal(fullMeta, 1);
    assert.ok(badMeta < fullMeta, `incomplete candidate should reduce metadata score (full=${fullMeta}, bad=${badMeta})`);
  });

  it("candidates without evidence refs score lower on traceability", () => {
    const trace    = completeCandidate({ evidenceRefs: [{ source: "registrationHistory", ref: "x", detail: "y" }] });
    const noRef    = completeCandidate({ candidateId: "0000000000000001", evidenceRefs: [] });
    const sFull = scoreMetaReflectionLiveReport(reportWithCandidates([trace, trace]));
    const sBad  = scoreMetaReflectionLiveReport(reportWithCandidates([trace, noRef]));
    const fullT = sFull.dimensions.find(d => d.id === "traceability")!.score;
    const badT  = sBad.dimensions.find(d => d.id === "traceability")!.score;
    assert.ok(badT < fullT, `noRef candidate should reduce traceability (full=${fullT}, bad=${badT})`);
  });
});

// ── Autonomy monitor exposure ──────────────────────────────────────────────

describe("Phase 2j-c — autonomy monitor exposure", () => {
  it("monitor surface populates extra.qualityScore with the documented shape", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const extra = meta.extra as any;
    const q = extra.qualityScore;
    assert.ok(q, "extra.qualityScore must be present");
    assert.equal(q.schemaVersion, META_REFLECTION_QUALITY_SCORE_SCHEMA_VERSION);
    assert.equal(q.label, META_REFLECTION_QUALITY_SCORE_LABEL);
    assert.equal(typeof q.overallScore, "number");
    assert.ok(q.overallScore >= 0 && q.overallScore <= 1);
    assert.ok(["cold", "low", "moderate", "high"].includes(q.qualityBand));
    assert.ok(["cold", "low", "moderate", "high"].includes(q.usefulnessBand));
    assert.ok(Array.isArray(q.dimensions));
    assert.equal(q.dimensions.length, 7);
    assert.equal(q.advisoryOnly, true);
    assert.equal(q.applyEligibility, "none");
    assert.equal(q.reviewReadiness.applyEligible, false);
    assert.equal(typeof extra.qualityScoreAdvisoryInvariant, "string");
    assert.ok(extra.qualityScoreAdvisoryInvariant.length > 0);
  });

  it("monitor exposes quality counts adjacent to existing counts", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    assert.equal(typeof meta.counts?.qualityHumanReviewNeededCount, "number");
    assert.equal(typeof meta.counts?.qualityDistinctReasonCodeCount, "number");
    assert.equal(typeof meta.counts?.qualityDistinctSubsystemCount, "number");
    // humanReviewNeededCount matches the original humanReviewRequiredCount.
    assert.equal(
      meta.counts?.qualityHumanReviewNeededCount,
      meta.counts?.humanReviewRequiredCount,
    );
  });

  it("metrics.qualityScore placeholder stays null — scoring is exposed adjacent, not by mutation", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const live = (meta.extra as any).liveReport;
    // The Phase 2j-b placeholder is unchanged.
    assert.equal(live.metrics.qualityScore, null);
    // The adjacent score is present.
    assert.ok((meta.extra as any).qualityScore);
  });

  it("monitor still has no buttons / controls — only read-only fields on the stage", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const ser = JSON.stringify(meta);
    assert.ok(!/\b(buttons?|controls?|onClick|hrefs?)\b/i.test(ser),
      `meta stage must not expose buttons/controls/onClicks: ${ser.slice(0, 200)}`);
  });

  it("monitor surface includes nextAction restating scoring is advisory only", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const meta = snap.stages.find(s => s.id === "meta_reflection")!;
    const advisory = (meta.nextActions ?? []).some(a => /advisory only/i.test(a));
    assert.ok(advisory, `expected an advisory-only nextAction, got ${JSON.stringify(meta.nextActions)}`);
  });
});

// ── Disabled kinds remain disabled ──────────────────────────────────────────

describe("Phase 2j-c — disabled kinds remain disabled, no widening", () => {
  it("scoring a report with disabled-kind candidates never proposes enabling", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    // Walk all text fields in the serialized score and confirm no enable/
    // register/promote/unblock language slipped in.
    const ser = serializeMetaReflectionQualityScore(s);
    for (const banned of [/\benable\b/i, /\bregister\b/i, /\bpromote\b/i, /\bunblock\b/i]) {
      assert.doesNotMatch(ser, banned, `quality score must not propose ${banned.source}`);
    }
  });

  it("scoring does not transition any candidate into auto-apply eligible", () => {
    const r = buildMetaReflectionLiveReport();
    const s = scoreMetaReflectionLiveReport(r);
    assert.equal(s.counts.autoApplyEligibleCount, 0);
    assert.equal(s.applyEligibility, "none");
    assert.equal(s.reviewReadiness.applyEligible, false);
  });
});

// ── Read-only / no env mutation ─────────────────────────────────────────────

describe("Phase 2j-c — read-only / env hygiene", () => {
  it("env snapshot is unchanged by repeated scoring + monitor calls", () => {
    const beforeEnv = JSON.stringify({
      DATA_DIR: process.env.DATA_DIR,
      DB_PATH:  process.env.DB_PATH,
    });
    for (let i = 0; i < 5; i++) {
      const r = buildMetaReflectionLiveReport();
      scoreMetaReflectionLiveReport(r);
      buildAutonomyMonitorSnapshot();
    }
    const afterEnv = JSON.stringify({
      DATA_DIR: process.env.DATA_DIR,
      DB_PATH:  process.env.DB_PATH,
    });
    assert.equal(beforeEnv, afterEnv);
  });

  it("repeated scoring does not grow the seeded TMP ledger", () => {
    // After the populated-report suite the TMP ledger exists. Repeated
    // scoring + autonomy monitor calls must not append to it.
    if (!fs.existsSync(TMP_LEDGER)) return;
    const sizeBefore = fs.statSync(TMP_LEDGER).size;
    for (let i = 0; i < 3; i++) {
      const r = buildMetaReflectionLiveReport();
      scoreMetaReflectionLiveReport(r);
      buildAutonomyMonitorSnapshot();
    }
    const sizeAfter = fs.statSync(TMP_LEDGER).size;
    assert.equal(sizeAfter, sizeBefore, "scoring must not mutate the ledger");
  });
});
