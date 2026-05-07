/**
 * Tests for hypothesisTriageQueue — operator-facing stalled-hypothesis selection.
 *
 * Run: npx tsx --test server/__tests__/hypothesisTriageQueue.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  daysSince,
  lastActivityTimestamp,
  isTriageCandidate,
  selectStalledTriageCandidates,
} from "../hypothesisTriageQueue.js";
import type { Hypothesis } from "../researchEngine.js";

const NOW = new Date(Date.UTC(2026, 4, 7));

function mkHyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id:         overrides.id ?? "hyp_test_1",
    claim:      overrides.claim ?? "Example research claim.",
    basis:      overrides.basis ?? "basis",
    metric:     overrides.metric ?? "metric",
    prediction: overrides.prediction ?? "x increases",
    timeframe:  overrides.timeframe ?? "30 days",
    status:     overrides.status ?? "forming",
    confidence: overrides.confidence ?? "low",
    formedAt:   overrides.formedAt ?? new Date(Date.UTC(2026, 3, 1)).toISOString(),
    ...overrides,
  } as Hypothesis;
}

describe("daysSince", () => {
  it("returns 0 for future timestamps", () => {
    const future = new Date(NOW.getTime() + 86400000).toISOString();
    assert.equal(daysSince(future, NOW), 0);
  });
  it("returns 0 for unparseable timestamps", () => {
    assert.equal(daysSince("not-a-date", NOW), 0);
  });
  it("returns floored whole days for older timestamps", () => {
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86400000).toISOString();
    assert.equal(daysSince(tenDaysAgo, NOW), 10);
  });
});

describe("lastActivityTimestamp", () => {
  it("prefers deadlineCheckedAt over formedAt", () => {
    const formedAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const deadlineCheckedAt = new Date(Date.UTC(2026, 4, 1)).toISOString();
    const h = mkHyp({ formedAt, deadlineCheckedAt });
    assert.equal(lastActivityTimestamp(h), deadlineCheckedAt);
  });
  it("prefers dataSourceGateBlockedAt over formedAt", () => {
    const formedAt = new Date(Date.UTC(2026, 0, 1)).toISOString();
    const blockedAt = new Date(Date.UTC(2026, 3, 15)).toISOString();
    const h = mkHyp({ formedAt, dataSourceGateBlockedAt: blockedAt });
    assert.equal(lastActivityTimestamp(h), blockedAt);
  });
  it("falls back to formedAt when no other activity recorded", () => {
    const h = mkHyp({ formedAt: new Date(Date.UTC(2026, 1, 1)).toISOString() });
    assert.equal(lastActivityTimestamp(h), h.formedAt);
  });
});

describe("isTriageCandidate", () => {
  it("includes low-confidence forming hypotheses", () => {
    assert.equal(isTriageCandidate(mkHyp({ status: "forming", confidence: "low" })), true);
  });
  it("includes triageConfidence:'low' even when legacy confidence isn't low", () => {
    assert.equal(
      isTriageCandidate(mkHyp({ status: "testing", confidence: "medium", triageConfidence: "low" } as any)),
      true,
    );
  });
  it("excludes high-confidence rows", () => {
    assert.equal(
      isTriageCandidate(mkHyp({ status: "forming", confidence: "high", triageConfidence: "high" } as any)),
      false,
    );
  });
  it("excludes already-resolved rows", () => {
    for (const status of ["confirmed", "rejected", "expired", "data-unavailable", "stale-retired"] as const) {
      assert.equal(
        isTriageCandidate(mkHyp({ status, confidence: "low" })),
        false,
        `should exclude status=${status}`,
      );
    }
  });
  it("includes awaiting-deadline rows when low-confidence", () => {
    assert.equal(
      isTriageCandidate(mkHyp({ status: "awaiting-deadline", confidence: "low" })),
      true,
    );
  });
});

describe("selectStalledTriageCandidates", () => {
  it("returns empty array when nothing matches", () => {
    const rows = selectStalledTriageCandidates(
      [mkHyp({ status: "confirmed", confidence: "low" })],
      { now: NOW },
    );
    assert.equal(rows.length, 0);
  });

  it("sorts by daysSinceActivity descending (oldest first)", () => {
    const oldest = mkHyp({
      id: "old",
      status: "forming",
      confidence: "low",
      formedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(), // Jan 1
    });
    const newer = mkHyp({
      id: "newer",
      status: "forming",
      confidence: "low",
      formedAt: new Date(Date.UTC(2026, 3, 1)).toISOString(), // Apr 1
    });
    const rows = selectStalledTriageCandidates([newer, oldest], { now: NOW });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, "old");
    assert.equal(rows[1].id, "newer");
    assert.ok(rows[0].daysSinceActivity > rows[1].daysSinceActivity);
  });

  it("annotates dataSourceGateReason when present", () => {
    const h = mkHyp({
      status: "forming",
      confidence: "low",
      dataSourceGateBlockedAt: new Date(Date.UTC(2026, 3, 1)).toISOString(),
      dataSourceGateReason: "no measurement path",
    });
    const rows = selectStalledTriageCandidates([h], { now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dataSourceGateReason, "no measurement path");
    assert.equal(rows[0].staleReason, "blocked by data-source gate");
  });

  it("respects limit option", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      mkHyp({ id: `hyp_${i}`, status: "forming", confidence: "low" }),
    );
    assert.equal(selectStalledTriageCandidates(many, { now: NOW, limit: 5 }).length, 5);
  });

  it("excludes high-confidence rows from a mixed list", () => {
    const list = [
      mkHyp({ id: "a", status: "forming", confidence: "low" }),
      mkHyp({ id: "b", status: "forming", confidence: "high" }),
      mkHyp({ id: "c", status: "testing", confidence: "low" }),
    ];
    const rows = selectStalledTriageCandidates(list, { now: NOW });
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ["a", "c"]);
  });

  it("flags awaiting-deadline rows with the right staleReason", () => {
    const h = mkHyp({ status: "awaiting-deadline", confidence: "low" });
    const rows = selectStalledTriageCandidates([h], { now: NOW });
    assert.equal(rows[0].staleReason, "awaiting external deadline");
  });

  it("flags high consecutiveInsufficientCycles in staleReason", () => {
    const h = mkHyp({ status: "testing", confidence: "low", consecutiveInsufficientCycles: 2 });
    const rows = selectStalledTriageCandidates([h], { now: NOW });
    assert.match(rows[0].staleReason, /consecutive insufficient-evidence cycles/);
  });
});
