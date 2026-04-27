/**
 * PR-G — client render tests for ValidityBaselinePanel.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test client/src/__tests__/validityBaselinePanel.test.tsx
 *
 * Coverage (per spec):
 *   1. Panel renders stratified breakdowns from a fixture trial set.
 *   2. Cells with validity=1.000 AND count>=5 are flagged ceiling-effect candidate.
 *   3. Cells with count<5 are de-emphasized as low-confidence.
 *   4. Probe button — caught path renders inline outcome.
 *   5. Probe button — missed path renders prominent warning treatment.
 *   6. Empty state (no trials yet) renders without crashing.
 *   7. Aggregate hint — N<30 surfaces below-readout-threshold hint.
 *   8. Aggregate hint — N>=30 AND aggregate=1.000 surfaces ceiling candidate hint.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  ValidityBaselinePanel,
  isCeilingFlagCell,
  isLowConfidenceCell,
  type ValidityBaselineFetchers,
  type ValiditySummary,
  type ProbeResult,
  CEILING_FLAG_MIN_COUNT,
  CEILING_FLAG_VALIDITY,
  READOUT_THRESHOLD_N,
} from "../components/ValidityBaselinePanel.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
function emptySummary(): ValiditySummary {
  return {
    totalGraded: 0,
    baselineCount: 0,
    treatmentCount: 0,
    aggregateValidity: 0,
    lastTrialAt: null,
    byTaskShape: [],
    byEngine: [],
    byModel: [],
    probes: [],
  };
}

function ceilingPinnedSummary(): ValiditySummary {
  // Mirrors the Phase 1 readout this PR was scoped against: 8 baseline,
  // 0 treatment, validity=1.000, with stratified breakdowns that exercise
  // every visual state.
  return {
    totalGraded: 8,
    baselineCount: 8,
    treatmentCount: 0,
    aggregateValidity: 1.0,
    lastTrialAt: "2026-04-26T18:00:00.000Z",
    byTaskShape: [
      { key: "analysis", count: 8, validity: 1.0 },
    ],
    byEngine: [
      { key: "google", count: 6, validity: 1.0 },
      { key: "openai", count: 2, validity: 1.0 },
    ],
    byModel: [
      { key: "google/gemini-3-flash-preview", count: 6, validity: 1.0 },
      { key: "openai/gpt-5",                  count: 2, validity: 1.0 },
    ],
    probes: [
      {
        trialRecordId: 999,
        outcome: "caught",
        outcomeMetric: 0.0,
        recordedAt: "2026-04-26T18:01:00.000Z",
        outcomeRecordedAt: "2026-04-26T18:01:00.500Z",
      },
    ],
  };
}

function postExpansionSummary(): ValiditySummary {
  // N>=30, aggregate exactly 1.0 — should surface the ceiling-aggregate hint.
  return {
    totalGraded: 32,
    baselineCount: 16,
    treatmentCount: 16,
    aggregateValidity: 1.0,
    lastTrialAt: "2026-04-26T18:00:00.000Z",
    byTaskShape: [{ key: "analysis", count: 32, validity: 1.0 }],
    byEngine:   [{ key: "google", count: 32, validity: 1.0 }],
    byModel:    [{ key: "google/gemini-3-flash-preview", count: 32, validity: 1.0 }],
    probes: [],
  };
}

function makeFetchers(opts: {
  summary: ValiditySummary;
  probeOutcome?: "caught" | "missed";
}): ValidityBaselineFetchers {
  return {
    fetchSummary: async () => opts.summary,
    triggerProbe: async () => ({
      probeId: "probe_test_aaaa",
      trialRecordId: 1234,
      outcome: opts.probeOutcome ?? "caught",
      triggeredAt: "2026-04-26T18:05:00.000Z",
      malformedInput: "This is not JSON at all.",
      outcomeMetric: opts.probeOutcome === "missed" ? 1.0 : 0.0,
    }),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
// useEffect / setState don't run under react-dom/server's renderToString,
// so we drive the loaded-state render by preseeding `initialSummary` (and
// optionally `initialProbeResult`) on the panel. This matches the panel's
// production behavior — these props default to null, so the prod code path
// (autoFetch on mount) is unchanged.
function renderLoaded(
  summary: ValiditySummary,
  fetchers: ValidityBaselineFetchers,
  probeResult?: ProbeResult,
): string {
  return renderToString(
    <ValidityBaselinePanel
      fetchers={fetchers}
      autoFetch={false}
      initialSummary={summary}
      initialProbeResult={probeResult ?? null}
    />,
  );
}

// ── Pure-function helpers (no rendering needed) ─────────────────────────────

describe("PR-G — cell classifiers", () => {
  it("flags ceiling-effect cells (validity=1.000 AND count>=5)", () => {
    assert.equal(isCeilingFlagCell({ count: 5, validity: 1 }), true);
    assert.equal(isCeilingFlagCell({ count: 8, validity: 1 }), true);
    assert.equal(isCeilingFlagCell({ count: 100, validity: 1 }), true);
  });
  it("does not flag cells where count<5 even if validity=1.000", () => {
    assert.equal(isCeilingFlagCell({ count: 4, validity: 1 }), false);
    assert.equal(isCeilingFlagCell({ count: 1, validity: 1 }), false);
  });
  it("does not flag cells where validity!=1.000", () => {
    assert.equal(isCeilingFlagCell({ count: 50, validity: 0.999 }), false);
    assert.equal(isCeilingFlagCell({ count: 50, validity: 0.5 }), false);
    assert.equal(isCeilingFlagCell({ count: 50, validity: 0 }), false);
  });
  it("treats count<5 as low-confidence", () => {
    assert.equal(isLowConfidenceCell({ count: 0 }), true);
    assert.equal(isLowConfidenceCell({ count: 4 }), true);
    assert.equal(isLowConfidenceCell({ count: 5 }), false);
    assert.equal(isLowConfidenceCell({ count: 100 }), false);
  });
  it("threshold constants match the spec", () => {
    assert.equal(CEILING_FLAG_MIN_COUNT, 5);
    assert.equal(CEILING_FLAG_VALIDITY, 1);
    assert.equal(READOUT_THRESHOLD_N, 30);
  });
});

// ── Render tests ────────────────────────────────────────────────────────────

describe("PR-G — ValidityBaselinePanel render", () => {

  it("renders without crashing on the empty (no-trials) state", () => {
    const fetchers = makeFetchers({ summary: emptySummary() });
    let html = "";
    assert.doesNotThrow(() => {
      html = renderToString(
        <ValidityBaselinePanel fetchers={fetchers} autoFetch={false} />,
      );
    });
    // Panel shell is present; no summary-dependent sections rendered.
    assert.match(html, /data-testid="validity-baseline-panel"/);
    assert.doesNotMatch(html, /data-testid="validity-aggregate"/);
    assert.match(html, /RUN KNOWN-BAD PROBE/i, "probe button is always present");
  });

  it("renders stratified breakdowns from a populated fixture", () => {
    const summary = ceilingPinnedSummary();
    const fetchers = makeFetchers({ summary });
    const html = renderLoaded(summary, fetchers);

    assert.match(html, /data-testid="stratum-by-task-shape"/);
    assert.match(html, /data-testid="stratum-by-engine"/);
    assert.match(html, /data-testid="stratum-by-model"/);

    // Stratum row keys are present.
    assert.match(html, /data-testid="stratum-row-analysis"/);
    assert.match(html, /data-testid="stratum-row-google"/);
    assert.match(html, /data-testid="stratum-row-openai"/);
    assert.match(html, /data-testid="stratum-row-google\/gemini-3-flash-preview"/);

    // Aggregate header values.
    assert.match(html, /data-testid="validity-aggregate"/);
    assert.match(html, /1\.000/);
  });

  it("flags ceiling-effect candidate cells (validity=1.000, count>=5)", () => {
    const summary = ceilingPinnedSummary();
    const html = renderLoaded(summary, makeFetchers({ summary }));

    // The "google" engine row has count=6, validity=1.000 → must be flagged.
    assert.match(
      html,
      /data-testid="stratum-row-google"[^>]*data-ceiling-flag="true"/,
    );
    // The chip itself appears at least once.
    assert.match(html, /CEILING-EFFECT CANDIDATE/);
  });

  it("de-emphasizes low-confidence cells (count<5)", () => {
    const summary = ceilingPinnedSummary();
    const html = renderLoaded(summary, makeFetchers({ summary }));

    // "openai" engine row has count=2 → low-confidence (de-emphasized) and
    // NOT ceiling-flagged (the spec puts ceiling above low-confidence as a
    // gating signal).
    assert.match(
      html,
      /data-testid="stratum-row-openai"[^>]*data-low-confidence="true"/,
    );
    assert.match(
      html,
      /data-testid="stratum-row-openai"[^>]*data-ceiling-flag="false"/,
    );
    assert.match(html, /LOW CONFIDENCE/);
  });

  it("surfaces a below-readout-threshold hint when N<30", () => {
    const summary = ceilingPinnedSummary(); // N=8
    const html = renderLoaded(summary, makeFetchers({ summary }));
    assert.match(html, /data-testid="below-threshold-hint"/);
    assert.doesNotMatch(html, /data-testid="ceiling-aggregate-hint"/);
  });

  it("surfaces a ceiling-effect aggregate hint when N>=30 AND aggregate=1.000", () => {
    const summary = postExpansionSummary();
    const html = renderLoaded(summary, makeFetchers({ summary }));
    assert.match(html, /data-testid="ceiling-aggregate-hint"/);
    assert.doesNotMatch(html, /data-testid="below-threshold-hint"/);
  });

  it("renders the probe history table when prior probes exist", () => {
    const summary = ceilingPinnedSummary();
    const html = renderLoaded(summary, makeFetchers({ summary }));
    assert.match(html, /data-testid="probe-history"/);
    assert.match(html, /data-testid="probe-history-row-999"/);
  });
});

// ── Probe button — caught and missed paths ──────────────────────────────────

describe("PR-G — probe button outcomes", () => {

  function caughtProbe(): ProbeResult {
    return {
      probeId: "probe_test_caught",
      trialRecordId: 1234,
      outcome: "caught",
      triggeredAt: "2026-04-26T18:05:00.000Z",
      malformedInput: "This is not JSON at all.",
      outcomeMetric: 0.0,
    };
  }
  function missedProbe(): ProbeResult {
    return {
      probeId: "probe_test_missed",
      trialRecordId: 5678,
      outcome: "missed",
      triggeredAt: "2026-04-26T18:06:00.000Z",
      malformedInput: "This is not JSON at all.",
      outcomeMetric: 1.0,
    };
  }

  it("caught path: triggerProbe fetcher returns outcome=caught", async () => {
    const fetchers = makeFetchers({ summary: ceilingPinnedSummary(), probeOutcome: "caught" });
    const probe = await fetchers.triggerProbe();
    assert.equal(probe.outcome, "caught");
    assert.equal(probe.outcomeMetric, 0.0);
  });

  it("missed path: triggerProbe fetcher returns outcome=missed", async () => {
    const fetchers = makeFetchers({ summary: ceilingPinnedSummary(), probeOutcome: "missed" });
    const probe = await fetchers.triggerProbe();
    assert.equal(probe.outcome, "missed");
    assert.equal(probe.outcomeMetric, 1.0);
  });

  it("renders caught outcome inline with green/positive treatment", () => {
    const summary = ceilingPinnedSummary();
    const html = renderLoaded(summary, makeFetchers({ summary }), caughtProbe());
    assert.match(html, /data-testid="probe-result"[^>]*data-outcome="caught"/);
    assert.match(html, /PROBE CAUGHT/);
    assert.match(html, /probe_test_caught/);
    assert.match(html, /trial record/i);
    assert.match(html, /1234/);
  });

  it("renders missed outcome with prominent warning treatment", () => {
    const summary = ceilingPinnedSummary();
    const html = renderLoaded(summary, makeFetchers({ summary }), missedProbe());
    assert.match(html, /data-testid="probe-result"[^>]*data-outcome="missed"/);
    assert.match(html, /PROBE MISSED/);
    assert.match(html, /metric pipeline failed/i);
    assert.match(html, /probe_test_missed/);
    assert.match(html, /5678/);
  });

  it("history table renders both caught and missed outcomes", () => {
    const summary = ceilingPinnedSummary();
    summary.probes = [
      { trialRecordId: 100, outcome: "caught", outcomeMetric: 0.0, recordedAt: "2026-04-26T18:00:00.000Z", outcomeRecordedAt: "2026-04-26T18:00:01.000Z" },
      { trialRecordId: 101, outcome: "missed", outcomeMetric: 1.0, recordedAt: "2026-04-26T18:01:00.000Z", outcomeRecordedAt: "2026-04-26T18:01:01.000Z" },
    ];
    const html = renderLoaded(summary, makeFetchers({ summary }));
    assert.match(html, /data-testid="probe-history-row-100"/);
    assert.match(html, /data-testid="probe-history-row-101"/);
    assert.match(html, /CAUGHT/);
    assert.match(html, /MISSED/);
  });
});
