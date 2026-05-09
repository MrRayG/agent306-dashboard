/**
 * Tests for the Phase 2 hypothesis → experiment selector.
 *
 * Run: npx tsx --test server/__tests__/hypothesisExperimentSelector.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  selectFormalHypothesisCandidates,
  selectMemoryOriginRefusals,
  buildHypothesisExperimentReadinessReport,
  evaluateHypothesisForExperiment,
  type HypothesisExperimentCandidate,
  type HypothesisExperimentRefusal,
  type MemoryOriginRefusal,
} from "../experiments/hypothesisExperimentSelector.js";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.js";
import type { MemoryKnowledgeEntry } from "../memoryHypothesisHygiene.js";
import type { Hypothesis } from "../researchEngine.js";

function mkHyp(overrides: Partial<HygieneAwareHypothesis> = {}): HygieneAwareHypothesis {
  const base: Hypothesis = {
    id:         "hyp_test",
    claim:      "GPT-class models will improve on HumanEval by 5pp in 2026",
    basis:      "trend extrapolation from 2024-2025 leaderboard",
    metric:     "humaneval pass@1",
    prediction: "≥5 percentage point gain by Dec 2026",
    timeframe:  "Dec 2026",
    status:     "testing",
    confidence: "medium",
    formedAt:   new Date().toISOString(),
    measurementPath: "openalex + papers with code humaneval leaderboard",
  };
  return { ...base, ...overrides };
}

function mkMemoryEntry(overrides: Partial<MemoryKnowledgeEntry> = {}): MemoryKnowledgeEntry {
  return {
    id:    "mem_1",
    title: "Hypothesis: enterprises will adopt agentic search by Q4 2026",
    summary: "based on the early customer signal in Hub Spot AI announcements",
    tier:  "B",
    category: "ai-news",
    weight:   0.4,
    learnedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("selectFormalHypothesisCandidates — accept path", () => {
  it("accepts a fully populated, operator-cleared hypothesis", () => {
    const hyp = mkHyp({ hygieneTag: "ready_for_experiment" });
    const { candidates, refusals } = selectFormalHypothesisCandidates([hyp]);
    assert.equal(candidates.length, 1);
    assert.equal(refusals.length, 0);
    assert.equal(candidates[0].hypothesisId, "hyp_test");
    assert.equal(candidates[0].tag, "ready_for_experiment");
    assert.equal(candidates[0].origin, "research_lab.hypotheses");
    assert.equal(candidates[0].verdict.ok, true);
  });

  it("accepts a candidate-tagged hypothesis when readiness fields are complete (per canFeedExperiment intent)", () => {
    // No operator tag → classifyHypothesis defaults to `candidate` because
    // all readiness fields are set. canFeedExperiment must accept this.
    const hyp = mkHyp();
    const { candidates, refusals } = selectFormalHypothesisCandidates([hyp]);
    assert.equal(candidates.length, 1);
    assert.equal(refusals.length, 0);
    assert.equal(candidates[0].tag, "candidate");
    assert.equal(candidates[0].verdict.ok, true);
  });
});

describe("selectFormalHypothesisCandidates — refusal path", () => {
  it("refuses a hypothesis missing measurementPath with structured evidence", () => {
    const hyp = mkHyp({ measurementPath: undefined });
    const { candidates, refusals } = selectFormalHypothesisCandidates([hyp]);
    assert.equal(candidates.length, 0);
    assert.equal(refusals.length, 1);
    const r = refusals[0];
    assert.equal(r.hypothesisId, "hyp_test");
    assert.equal(r.tag, "needs_data");
    assert.ok(r.blockers.some(b => b.includes("measurementPath")));
    assert.equal(r.origin, "research_lab.hypotheses");
  });

  it("refuses a hypothesis missing metric, basis, claim, or prediction with the relevant blocker", () => {
    const cases: Array<[Partial<HygieneAwareHypothesis>, RegExp]> = [
      [{ metric: "" },     /metric/],
      [{ basis: "" },      /basis/],
      [{ claim: "x" },     /claim/],
      [{ prediction: "" }, /prediction/],
    ];
    for (const [over, blockerPattern] of cases) {
      const hyp = mkHyp({ id: `bad_${Math.random()}`, ...over });
      const { candidates, refusals } = selectFormalHypothesisCandidates([hyp]);
      assert.equal(candidates.length, 0);
      assert.equal(refusals.length, 1);
      assert.ok(
        refusals[0].blockers.some(b => blockerPattern.test(b)),
        `expected blocker matching ${blockerPattern}, got ${JSON.stringify(refusals[0].blockers)}`,
      );
    }
  });

  it("refuses archived/duplicate/needs_review records", () => {
    const archived = mkHyp({ id: "h_arch", hygieneTag: "archived_irrelevant" });
    const dup      = mkHyp({ id: "h_dup",  aliasOf: "h_canonical" });
    const review   = mkHyp({ id: "h_rev",  rubricVerdict: "review" });
    const stale    = mkHyp({ id: "h_st",   status: "stale-retired" });
    const blocked  = mkHyp({ id: "h_blk",  hygieneTag: "blocked" });

    const { candidates, refusals } = selectFormalHypothesisCandidates(
      [archived, dup, review, stale, blocked],
    );
    assert.equal(candidates.length, 0);
    assert.equal(refusals.length, 5);
    const tagsById = Object.fromEntries(refusals.map(r => [r.hypothesisId, r.tag]));
    assert.equal(tagsById["h_arch"], "archived_irrelevant");
    assert.equal(tagsById["h_dup"],  "duplicate");
    assert.equal(tagsById["h_rev"],  "needs_review");
    assert.equal(tagsById["h_st"],   "archived_stale");
    assert.equal(tagsById["h_blk"],  "blocked");
    for (const r of refusals) {
      assert.ok(r.reasons.length > 0, "refusal should have at least one reason");
    }
  });

  it("refuses a confirmed/rejected hypothesis as already resolved", () => {
    const confirmed = mkHyp({ id: "h_done", status: "confirmed" });
    const rejected  = mkHyp({ id: "h_no",   status: "rejected" });
    const { candidates, refusals } = selectFormalHypothesisCandidates([confirmed, rejected]);
    assert.equal(candidates.length, 0);
    assert.equal(refusals.length, 2);
    for (const r of refusals) assert.equal(r.tag, "archived_irrelevant");
  });
});

describe("selectMemoryOriginRefusals — hard-no for memory entries", () => {
  it("refuses an unpromoted memory hypothesis entry with explicit reasons", () => {
    const entry = mkMemoryEntry();
    const refusals = selectMemoryOriginRefusals([entry]);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].refId, "memory:mem_1");
    assert.equal(refusals[0].memoryEntryId, "mem_1");
    assert.equal(refusals[0].origin, "memory_knowledge");
    assert.ok(refusals[0].reasons.some(r => /memory/i.test(r)));
    assert.equal(refusals[0].promotedToHypothesisId, undefined);
  });

  it("still refuses promoted memory entries — formal record must go through canFeedExperiment", () => {
    const entry = mkMemoryEntry({ promotedToHypothesisId: "hyp_promoted_1" });
    const refusals = selectMemoryOriginRefusals([entry]);
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].promotedToHypothesisId, "hyp_promoted_1");
    assert.ok(
      refusals[0].reasons.some(r => /promoted/i.test(r)),
      "promoted entries should reference the promotion in reasons",
    );
  });

  it("filters out non-hypothesis memory entries (no Hypothesis: prefix)", () => {
    const ordinary = mkMemoryEntry({ id: "mem_x", title: "Random fact about HumanEval" });
    const refusals = selectMemoryOriginRefusals([ordinary]);
    assert.equal(refusals.length, 0);
  });
});

describe("buildHypothesisExperimentReadinessReport", () => {
  it("empty backlog produces an empty report (not a failure)", () => {
    const report = buildHypothesisExperimentReadinessReport();
    assert.equal(report.candidates.length, 0);
    assert.equal(report.refusals.length, 0);
    assert.equal(report.memoryRefusals.length, 0);
    assert.equal(report.summary.formalInputCount, 0);
    assert.equal(report.summary.memoryInputCount, 0);
    assert.ok(report.generatedAt);
  });

  it("partitions a mixed backlog and counts everything", () => {
    const ready    = mkHyp({ id: "h_ok", hygieneTag: "ready_for_experiment" });
    const broken   = mkHyp({ id: "h_no", measurementPath: undefined });
    const memEntry = mkMemoryEntry();
    const report = buildHypothesisExperimentReadinessReport({
      formal:        [ready, broken],
      memoryEntries: [memEntry],
      now:           new Date("2026-05-09T00:00:00Z"),
    });
    assert.equal(report.summary.candidateCount, 1);
    assert.equal(report.summary.refusalCount, 1);
    assert.equal(report.summary.memoryRefusalCount, 1);
    assert.equal(report.summary.formalInputCount, 2);
    assert.equal(report.summary.memoryInputCount, 1);
    assert.equal(report.candidates[0].hypothesisId, "h_ok");
    assert.equal(report.refusals[0].hypothesisId, "h_no");
    assert.equal(report.memoryRefusals[0].refId, "memory:mem_1");
    assert.equal(report.generatedAt, "2026-05-09T00:00:00.000Z");
  });

  it("memory entries are NEVER classified as candidates regardless of summary content", () => {
    // Even if a memory entry's free-text summary fakes the readiness fields,
    // the selector path for memory-origin entries has no `ok: true` branch.
    const tempting = mkMemoryEntry({
      summary: "metric=humaneval pass@1; prediction=+5pp; basis=trend extrapolation; measurementPath=openalex",
    });
    const report = buildHypothesisExperimentReadinessReport({
      formal:        [],
      memoryEntries: [tempting],
    });
    assert.equal(report.candidates.length, 0);
    assert.equal(report.memoryRefusals.length, 1);
  });
});

describe("evaluateHypothesisForExperiment — single-record sugar", () => {
  it("returns { ok: true, candidate } for a ready record", () => {
    const r = evaluateHypothesisForExperiment(mkHyp({ hygieneTag: "ready_for_experiment" }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.candidate.tag, "ready_for_experiment");
  });

  it("returns { ok: false, refusal } for a non-ready record", () => {
    const r = evaluateHypothesisForExperiment(mkHyp({ measurementPath: undefined }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.refusal.blockers.some(b => b.includes("measurementPath")));
      assert.equal(r.refusal.origin, "research_lab.hypotheses");
    }
  });
});
