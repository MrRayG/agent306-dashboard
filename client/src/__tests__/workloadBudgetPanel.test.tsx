/**
 * Read-only render tests for WorkloadBudgetPanel.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test \
 *      client/src/__tests__/workloadBudgetPanel.test.tsx
 *
 * Coverage:
 *   1. Empty / zero-data snapshot renders without throwing, surfaces the
 *      "low" pressure band and the advisory-only banner copy.
 *   2. A "high" pressure snapshot surfaces the high band, the heaviest cost
 *      driver, and the corresponding soft recommendation text.
 *   3. Data-missing notes render when present, in a clearly tagged section.
 *   4. ZERO action controls: no <button>, <input>, <form>, <textarea>,
 *      <select>; no Approve/Reject/Apply/Promote/Submit/Pause/Throttle
 *      labels; no href= or action=. The panel is visibility-only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "react-dom/server";

import {
  WorkloadBudgetPanel,
  type WorkloadBudgetVisibility,
} from "../components/WorkloadBudgetPanel";

function lowSnap(): WorkloadBudgetVisibility {
  return {
    schemaVersion: "phase-budget-vis-1",
    label:         "workload-budget-visibility",
    generatedAt:   "2026-05-17T00:00:00.000Z",
    pressureBand:  "low",
    pressureReason: "no proxy threshold exceeded",
    counts: {
      latestEngineRunDurationMs: null,
      engineRunsLast24h:         0,
      engineRunsNonOkLast24h:    0,
      engineEventsLast24h:       0,
      engineEventsNonInfoLast24h: 0,
      formalHypotheses:          0,
      kbEntries:                 0,
      memoryOriginHypotheses:    0,
      memoryHypothesesBlocked:   0,
      openCorrectiveObligations: 0,
      mergedCorrectiveObligations: 0,
    },
    thresholds: {
      cycleDurationHighMs:   60 * 60 * 1000,
      cycleDurationMediumMs: 20 * 60 * 1000,
      backlogHigh:           300,
      backlogMedium:         100,
      kbHigh:                900,
      kbMedium:              500,
      obligationsBumpAt:     5,
    },
    topDrivers: [],
    softRecommendations: [
      "Cost pressure within nominal proxy bands — continue normal review cadence",
      "These recommendations are advisory text only — nothing on this panel pauses, throttles, or refuses work",
    ],
    dataMissingNotes: [
      "research_lab.json missing or unreadable",
    ],
    invariants: {
      readOnly:     "no write, no insert, no scheduler, no apply path",
      proxyOnly:    "no token / currency cost is invented; counts are derived from existing logs / ledgers / state only",
      advisoryOnly: "softRecommendations is text only; rendering does not enforce, throttle, or refuse anything",
      nonWidening:  "no new external API call, no new auth, no new primitive",
    },
  };
}

function highSnap(): WorkloadBudgetVisibility {
  const s = lowSnap();
  s.pressureBand   = "high";
  s.pressureReason = "latest cycle 106m ≥ 60m; backlog 450 ≥ 300; kb_entries 1090 ≥ 900";
  s.counts = {
    latestEngineRunDurationMs: 106 * 60 * 1000,
    engineRunsLast24h:         12,
    engineRunsNonOkLast24h:    1,
    engineEventsLast24h:       200,
    engineEventsNonInfoLast24h: 4,
    formalHypotheses:          451,
    kbEntries:                 1090,
    memoryOriginHypotheses:    32,
    memoryHypothesesBlocked:   32,
    openCorrectiveObligations: 7,
    mergedCorrectiveObligations: 2,
  };
  s.topDrivers = [
    {
      key:    "kb_entries",
      label:  "KB entries",
      count:  1090,
      kind:   "kb",
      source: "memory_knowledge.json",
      dataMissing: false,
    },
    {
      key:    "formal_hypotheses",
      label:  "formal hypotheses backlog",
      count:  451,
      kind:   "queue",
      source: "research_lab.json",
      dataMissing: false,
    },
    {
      key:    "latest_cycle_duration_minutes",
      label:  "latest cycle minutes",
      count:  106,
      kind:   "cycle_duration",
      source: "engine_runs",
      dataMissing: false,
    },
  ];
  s.softRecommendations = [
    "High cost pressure: consider pausing new hypothesis expansion until backlog is reviewed",
    "Operator-review recommended before approving the next high-cost cycle plan",
    "Hypothesis backlog 483 (formal 451 + blocked memory-origin 32) — promote or archive before queuing more",
    "KB has 1090 entries — consider running archive / merge passes before semantic expansion",
    "7 open corrective obligation(s) (2 merged) — clearing these is cheaper than starting new work",
    "These recommendations are advisory text only — nothing on this panel pauses, throttles, or refuses work",
  ];
  return s;
}

function assertNoActionAffordances(html: string): void {
  for (const tag of ["<button", "<input", "<form", "<textarea", "<select"]) {
    assert.ok(!html.includes(tag), `panel must not render ${tag}`);
  }
  for (const banned of ["href=", "action=", "Approve", "Reject", "Apply", "Promote", "Submit", "Pause", "Throttle", "Refuse"]) {
    assert.ok(!html.includes(banned), `panel must not include "${banned}"`);
  }
}

describe("WorkloadBudgetPanel — low / empty render", () => {
  it("renders cleanly with no data", () => {
    const html = renderToString(<WorkloadBudgetPanel data={lowSnap()} />);
    assert.ok(html.includes("API / Workload Budget"));
    assert.ok(html.toLowerCase().includes("low"));
    assert.ok(html.includes("Proxy telemetry only"));
    assert.ok(html.includes("advisory text only"));
    assertNoActionAffordances(html);
  });

  it("renders data-missing notes when present", () => {
    const html = renderToString(<WorkloadBudgetPanel data={lowSnap()} />);
    assert.ok(html.includes("research_lab.json missing or unreadable"));
  });

  it("renders all four invariant lines", () => {
    const html = renderToString(<WorkloadBudgetPanel data={lowSnap()} />);
    for (const key of ["readOnly", "proxyOnly", "advisoryOnly", "nonWidening"]) {
      assert.ok(html.includes(key), `invariant key "${key}" must appear`);
    }
  });
});

describe("WorkloadBudgetPanel — high pressure render", () => {
  it("surfaces the high band and top drivers", () => {
    const html = renderToString(<WorkloadBudgetPanel data={highSnap()} />);
    assert.ok(html.toLowerCase().includes("high"));
    assert.ok(html.includes("1090"));  // KB entries
    assert.ok(html.includes("451"));   // formal hypotheses
    assert.ok(html.includes("106"));   // latest cycle minutes
    assert.ok(html.includes("memory_knowledge.json"));
  });

  it("renders the high-pressure soft recommendations", () => {
    const html = renderToString(<WorkloadBudgetPanel data={highSnap()} />);
    assert.ok(html.includes("pausing new hypothesis expansion"));
    assert.ok(html.includes("Operator-review recommended"));
    assert.ok(html.includes("advisory text only"));
  });

  it("has no action affordances even in the high state", () => {
    const html = renderToString(<WorkloadBudgetPanel data={highSnap()} />);
    assertNoActionAffordances(html);
  });
});
