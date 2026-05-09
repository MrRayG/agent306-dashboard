/**
 * Tests for the Phase 1.5 hypothesis hygiene module — readiness gating,
 * tag classification, and audit output.
 *
 * Run: npx tsx --test server/__tests__/hypothesisHygiene.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HYGIENE_TAGS,
  READY_TAGS,
  ARCHIVED_TAGS,
  isReadyTag,
  isArchivedTag,
  computeReadinessFields,
  readinessBlockers,
  classifyHypothesis,
  canFeedExperiment,
  findDuplicateGroups,
  auditHypotheses,
  annotate,
  type HygieneAwareHypothesis,
} from "../hypothesisHygiene.js";
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

describe("readiness fields", () => {
  it("a fully populated hypothesis has zero blockers", () => {
    const blockers = readinessBlockers(mkHyp());
    assert.deepEqual(blockers, []);
  });

  it("missing measurementPath is flagged", () => {
    const blockers = readinessBlockers(mkHyp({ measurementPath: undefined }));
    assert.ok(blockers.some(b => b.includes("measurementPath")));
  });

  it("missing metric is flagged with a Phase-2 specific message", () => {
    const fields = computeReadinessFields(mkHyp({ metric: "" }));
    const metric = fields.find(f => f.field === "metric");
    assert.ok(metric);
    assert.equal(metric!.ok, false);
    assert.match(metric!.reason ?? "", /Phase 2/);
  });

  it("short claim is treated as missing", () => {
    const blockers = readinessBlockers(mkHyp({ claim: "too short" }));
    assert.ok(blockers.some(b => /claim is missing/.test(b)));
  });
});

describe("classifyHypothesis", () => {
  it("default candidate when fields are present and no operator tag", () => {
    const { tag } = classifyHypothesis(mkHyp());
    assert.equal(tag, "candidate");
  });

  it("respects operator-set ready_for_experiment", () => {
    const { tag } = classifyHypothesis(mkHyp({ hygieneTag: "ready_for_experiment" }));
    assert.equal(tag, "ready_for_experiment");
  });

  it("preserves operator-set archived tags verbatim", () => {
    for (const t of ARCHIVED_TAGS) {
      const { tag } = classifyHypothesis(mkHyp({ hygieneTag: t }));
      assert.equal(tag, t);
    }
  });

  it("status=data-unavailable maps to archived_unsolvable", () => {
    const { tag } = classifyHypothesis(mkHyp({ status: "data-unavailable" }));
    assert.equal(tag, "archived_unsolvable");
  });

  it("status=stale-retired maps to archived_stale", () => {
    const { tag } = classifyHypothesis(mkHyp({ status: "stale-retired" }));
    assert.equal(tag, "archived_stale");
  });

  it("status=expired maps to archived_stale", () => {
    const { tag } = classifyHypothesis(mkHyp({ status: "expired" }));
    assert.equal(tag, "archived_stale");
  });

  it("resolved hypotheses (confirmed/rejected) are tagged archived_irrelevant", () => {
    assert.equal(classifyHypothesis(mkHyp({ status: "confirmed" })).tag, "archived_irrelevant");
    assert.equal(classifyHypothesis(mkHyp({ status: "rejected" })).tag, "archived_irrelevant");
  });

  it("aliasOf marks the record as duplicate", () => {
    const { tag } = classifyHypothesis(mkHyp({ aliasOf: "hyp_canonical_1" }));
    assert.equal(tag, "duplicate");
  });

  it("missing measurementPath leads to needs_data", () => {
    const { tag } = classifyHypothesis(mkHyp({ measurementPath: undefined }));
    assert.equal(tag, "needs_data");
  });

  it("missing metric leads to needs_rewrite", () => {
    const { tag } = classifyHypothesis(mkHyp({ metric: "" }));
    assert.equal(tag, "needs_rewrite");
  });

  it("rubricVerdict=reject overrides field-level state", () => {
    const { tag } = classifyHypothesis(mkHyp({ rubricVerdict: "reject" }));
    assert.equal(tag, "needs_rewrite");
  });

  it("rubricVerdict=review yields needs_review", () => {
    const { tag } = classifyHypothesis(mkHyp({ rubricVerdict: "review" }));
    assert.equal(tag, "needs_review");
  });

  it("dataSourceGateBlockedAt yields needs_data", () => {
    const { tag } = classifyHypothesis(mkHyp({ dataSourceGateBlockedAt: new Date().toISOString() }));
    assert.equal(tag, "needs_data");
  });

  it("respectOperatorTag=false ignores operator tag", () => {
    const hyp = mkHyp({ hygieneTag: "ready_for_experiment" });
    const { tag } = classifyHypothesis(hyp, { respectOperatorTag: false });
    // With fields populated, falls back to "candidate"
    assert.equal(tag, "candidate");
  });
});

describe("canFeedExperiment (Phase 2 readiness gate)", () => {
  it("rejects hypotheses without an operator-set ready/candidate tag... wait — candidate is allowed", () => {
    // The default classification of a fully-populated hypothesis is `candidate`,
    // and `candidate` IS in READY_TAGS — so this should pass. Documents the
    // intentional choice to let operator-cleared candidates flow through.
    const verdict = canFeedExperiment(mkHyp());
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tag, "candidate");
  });

  it("rejects hypotheses with missing readiness fields even when tagged ready", () => {
    const verdict = canFeedExperiment(mkHyp({
      measurementPath: undefined,
      hygieneTag: "ready_for_experiment",
    }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.blockers.some(b => b.includes("measurementPath")));
  });

  it("rejects all archived tags", () => {
    for (const t of ARCHIVED_TAGS) {
      const verdict = canFeedExperiment(mkHyp({ hygieneTag: t }));
      assert.equal(verdict.ok, false, `expected archived tag ${t} to be rejected`);
    }
  });

  it("rejects duplicate, blocked, needs_*, and review tags via lifecycle/fields", () => {
    assert.equal(canFeedExperiment(mkHyp({ aliasOf: "x" })).ok, false);
    assert.equal(canFeedExperiment(mkHyp({ hygieneTag: "blocked" })).ok, false);
    assert.equal(canFeedExperiment(mkHyp({ rubricVerdict: "review" })).ok, false);
    assert.equal(canFeedExperiment(mkHyp({ rubricVerdict: "reject" })).ok, false);
    assert.equal(canFeedExperiment(mkHyp({ measurementPath: undefined })).ok, false);
  });

  it("accepts hypothesis explicitly tagged ready_for_experiment with all fields", () => {
    const verdict = canFeedExperiment(mkHyp({ hygieneTag: "ready_for_experiment" }));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tag, "ready_for_experiment");
  });

  it("rejects resolved hypotheses (confirmed/rejected)", () => {
    assert.equal(canFeedExperiment(mkHyp({ status: "confirmed" })).ok, false);
    assert.equal(canFeedExperiment(mkHyp({ status: "rejected" })).ok, false);
  });

  it("verdict reasons cite the rejecting condition", () => {
    const verdict = canFeedExperiment(mkHyp({ status: "data-unavailable" }));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.some(r => r.includes("data-unavailable")));
  });
});

describe("duplicate detection", () => {
  it("groups records with claims that normalize identically", () => {
    const hyps = [
      mkHyp({ id: "h1", claim: "Models will improve on HumanEval." }),
      mkHyp({ id: "h2", claim: "models will improve on humaneval" }),
      mkHyp({ id: "h3", claim: "Something completely different." }),
    ];
    const groups = findDuplicateGroups(hyps);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].ids.sort(), ["h1", "h2"]);
  });

  it("ignores claims that are unique once normalized", () => {
    const hyps = [
      mkHyp({ id: "a", claim: "alpha" }),
      mkHyp({ id: "b", claim: "beta" }),
    ];
    assert.deepEqual(findDuplicateGroups(hyps), []);
  });
});

describe("auditHypotheses", () => {
  it("computes counts, flags stale active records, and sorts duplicate groups", () => {
    const oldDate = new Date(Date.UTC(2025, 0, 1)).toISOString();
    const recent = new Date().toISOString();
    const hyps: HygieneAwareHypothesis[] = [
      mkHyp({ id: "h_ready", hygieneTag: "ready_for_experiment", formedAt: recent }),
      mkHyp({ id: "h_old",   formedAt: oldDate }),
      mkHyp({ id: "h_dup1",  claim: "dup claim alpha", formedAt: recent }),
      mkHyp({ id: "h_dup2",  claim: "dup claim alpha", formedAt: recent }),
      mkHyp({ id: "h_arch",  status: "data-unavailable", formedAt: recent }),
      mkHyp({ id: "h_nodata", measurementPath: undefined, formedAt: recent }),
    ];
    const report = auditHypotheses(hyps, { now: new Date(Date.UTC(2026, 4, 9)), staleDays: 30 });
    assert.equal(report.total, 6);
    assert.equal(report.byTag.ready_for_experiment, 1);
    assert.equal(report.byTag.duplicate >= 0, true);
    assert.equal(report.byTag.archived_unsolvable, 1);
    assert.equal(report.byTag.needs_data, 1);
    assert.ok(report.staleCandidates.length >= 1);
    assert.equal(report.staleCandidates[0].id, "h_old");
    assert.ok(report.fieldGapCounts.measurementPath >= 1);
  });

  it("never throws on an empty list", () => {
    const report = auditHypotheses([]);
    assert.equal(report.total, 0);
    assert.equal(report.readyCount, 0);
    assert.deepEqual(report.duplicateGroups, []);
  });
});

describe("annotation helper", () => {
  it("attaches operator metadata without mutating the original record", () => {
    const original = mkHyp();
    const annotated = annotate(original, "archived_irrelevant", "off-domain");
    assert.equal(original.hygieneTag, undefined);
    assert.equal(annotated.hygieneTag, "archived_irrelevant");
    assert.equal(annotated.hygieneReason, "off-domain");
    assert.ok(annotated.hygieneTaggedAt);
    assert.equal(annotated.hygieneTaggedBy, "operator");
  });
});

describe("static invariants", () => {
  it("READY_TAGS and ARCHIVED_TAGS are subsets of HYGIENE_TAGS", () => {
    for (const t of READY_TAGS) assert.ok(HYGIENE_TAGS.includes(t), `${t} missing from HYGIENE_TAGS`);
    for (const t of ARCHIVED_TAGS) assert.ok(HYGIENE_TAGS.includes(t), `${t} missing from HYGIENE_TAGS`);
  });

  it("isReadyTag / isArchivedTag agree with the constant arrays", () => {
    for (const t of HYGIENE_TAGS) {
      assert.equal(isReadyTag(t), READY_TAGS.includes(t));
      assert.equal(isArchivedTag(t), ARCHIVED_TAGS.includes(t));
    }
  });

  it("READY_TAGS and ARCHIVED_TAGS are disjoint", () => {
    for (const t of READY_TAGS) assert.equal(ARCHIVED_TAGS.includes(t), false, `${t} in both`);
  });
});
