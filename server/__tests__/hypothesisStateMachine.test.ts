/**
 * Tests for the hypothesis state machine — awaiting-deadline, data-unavailable,
 * stale-retired transitions plus the [Hypothesis] log format.
 *
 * Run: npx tsx --test server/__tests__/hypothesisStateMachine.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  extractFutureDeadline,
  needsLiveGrounding,
  classifyForStateMachine,
  shouldRecheckDeadline,
  logStateTransition,
  tallyStates,
  logCycleSummary,
  INSUFFICIENT_CYCLES_THRESHOLD,
  STALE_CYCLES_THRESHOLD,
} from "../hypothesisStateMachine.js";
import type { Hypothesis } from "../researchEngine.js";

function mkHyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id:         overrides.id ?? "hyp_test_1",
    claim:      overrides.claim ?? "Example claim.",
    basis:      overrides.basis ?? "basis",
    metric:     overrides.metric ?? "metric",
    prediction: overrides.prediction ?? "something will happen",
    timeframe:  overrides.timeframe ?? "",
    status:     overrides.status ?? "testing",
    confidence: overrides.confidence ?? "medium",
    formedAt:   overrides.formedAt ?? new Date().toISOString(),
    ...overrides,
  } as Hypothesis;
}

describe("extractFutureDeadline", () => {
  const now = new Date(Date.UTC(2026, 3, 18));

  it("parses ISO dates in the future", () => {
    const d = extractFutureDeadline("Will resolve by 2026-06-15.", now);
    assert.ok(d);
    assert.ok(d!.startsWith("2026-06-15"));
  });

  it("parses natural dates like 'June 15, 2026'", () => {
    const d = extractFutureDeadline("Prediction window to June 15, 2026.", now);
    assert.ok(d);
    assert.ok(d!.startsWith("2026-06-15"));
  });

  it("parses 'by June 2026' (month + year) → end of month", () => {
    const d = extractFutureDeadline("Forrester's April 2026 report concludes by June 2026.", now);
    assert.ok(d);
    assert.ok(d!.startsWith("2026-06-30"), `got ${d}`);
  });

  it("returns null when no future date is present", () => {
    const d = extractFutureDeadline("No date mentioned here.", now);
    assert.equal(d, null);
  });

  it("returns null when all dates are in the past", () => {
    const d = extractFutureDeadline("Closed on 2024-01-01 and 2025-12-31.", now);
    assert.equal(d, null);
  });

  it("picks the earliest future date when multiple are present", () => {
    const d = extractFutureDeadline("Window spans 2026-09-01 and 2026-06-15.", now);
    assert.ok(d);
    assert.ok(d!.startsWith("2026-06-15"));
  });
});

describe("needsLiveGrounding", () => {
  const now = new Date(Date.UTC(2026, 3, 18));

  it("flags hypotheses mentioning 2025 or 2026", () => {
    assert.equal(needsLiveGrounding("Maine LD 307 signed in 2026.", now), true);
  });

  it("flags hypotheses mentioning a month name", () => {
    assert.equal(needsLiveGrounding("Expected by April of next year.", now), true);
  });

  it("flags legislation (e.g. LD 307, SB 22, bill)", () => {
    assert.equal(needsLiveGrounding("LD 307 data center moratorium will not…", now), true);
    assert.equal(needsLiveGrounding("A new bill is under review", now), true);
  });

  it("flags trials / NCT / IDE / launches", () => {
    assert.equal(needsLiveGrounding("Neuralink PRIME NCT06424782 trial", now), true);
    assert.equal(needsLiveGrounding("Product launch imminent.", now), true);
  });

  it("does not flag pure theoretical math claims", () => {
    assert.equal(needsLiveGrounding("riemann zeta function distribution", now), false);
  });
});

describe("classifyForStateMachine", () => {
  const now = new Date(Date.UTC(2026, 3, 18));

  it("transitions to awaiting-deadline when claim has a future date", () => {
    const hyp = mkHyp({ claim: "Forrester humanoid robotics efficiency by June 15, 2026." });
    const c = classifyForStateMachine(hyp, now);
    assert.equal(c.transitionTo, "awaiting-deadline");
    assert.ok(c.deadlineAt);
    assert.ok(c.deadlineAt!.startsWith("2026-06-15"));
  });

  it(`transitions to data-unavailable after ${INSUFFICIENT_CYCLES_THRESHOLD} consecutive insufficient-evidence cycles`, () => {
    const hyp = mkHyp({ consecutiveInsufficientCycles: INSUFFICIENT_CYCLES_THRESHOLD });
    const c = classifyForStateMachine(hyp, now);
    assert.equal(c.transitionTo, "data-unavailable");
  });

  it("does not transition below the insufficient-evidence threshold", () => {
    const hyp = mkHyp({ consecutiveInsufficientCycles: INSUFFICIENT_CYCLES_THRESHOLD - 1 });
    const c = classifyForStateMachine(hyp, now);
    assert.equal(c.transitionTo, undefined);
  });

  it(`transitions to stale-retired after ${STALE_CYCLES_THRESHOLD}+ cycles with no resolution`, () => {
    const hyp = mkHyp({ cycleCount: STALE_CYCLES_THRESHOLD });
    const c = classifyForStateMachine(hyp, now);
    assert.equal(c.transitionTo, "stale-retired");
  });

  it("awaiting-deadline takes priority over stale-retired when both apply", () => {
    const hyp = mkHyp({
      cycleCount: STALE_CYCLES_THRESHOLD + 2,
      claim: "Windows closes by 2026-12-01.",
    });
    const c = classifyForStateMachine(hyp, now);
    assert.equal(c.transitionTo, "awaiting-deadline");
  });

  it("does not re-transition a hypothesis with a deadline already in the past", () => {
    const hyp = mkHyp({
      claim: "done by 2020-01-01",
      deadlineAt: "2020-01-01T00:00:00.000Z",
    });
    const c = classifyForStateMachine(hyp, now);
    assert.notEqual(c.transitionTo, "awaiting-deadline");
  });
});

describe("shouldRecheckDeadline", () => {
  const now = new Date(Date.UTC(2026, 3, 18));

  it("true when deadline is past", () => {
    const hyp = mkHyp({ status: "awaiting-deadline", deadlineAt: "2020-01-01T00:00:00.000Z" });
    assert.equal(shouldRecheckDeadline(hyp, now), true);
  });

  it("false when deadline is future and we checked today", () => {
    const hyp = mkHyp({
      status: "awaiting-deadline",
      deadlineAt: "2026-12-31T00:00:00.000Z",
      deadlineCheckedAt: now.toISOString(),
    });
    assert.equal(shouldRecheckDeadline(hyp, now), false);
  });

  it("true when deadline is future but last check was > 1 day ago", () => {
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const hyp = mkHyp({
      status: "awaiting-deadline",
      deadlineAt: "2026-12-31T00:00:00.000Z",
      deadlineCheckedAt: twoDaysAgo.toISOString(),
    });
    assert.equal(shouldRecheckDeadline(hyp, now), true);
  });

  it("false for non-awaiting-deadline states", () => {
    const hyp = mkHyp({ status: "testing" });
    assert.equal(shouldRecheckDeadline(hyp, now), false);
  });
});

describe("logStateTransition + logCycleSummary — log format", () => {
  let originalLog: typeof console.log;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("emits `[Hypothesis] <id> <old> → <new> — <reason>`", () => {
    logStateTransition("hyp_x", "testing", "awaiting-deadline", "future date 2026-06-15");
    assert.equal(logs.length, 1);
    assert.match(
      logs[0],
      /^\[Hypothesis\] hyp_x testing → awaiting-deadline — future date 2026-06-15/,
    );
  });

  it("emits a `[DailyCycle] Hypothesis state:` summary line", () => {
    const hyps: Hypothesis[] = [
      mkHyp({ id: "a", status: "testing" }),
      mkHyp({ id: "b", status: "forming" }),
      mkHyp({ id: "c", status: "awaiting-deadline" }),
      mkHyp({ id: "d", status: "data-unavailable" }),
    ];
    const transitions = [
      { to: "confirmed" as const },
      { to: "rejected" as const },
      { to: "stale-retired" as const },
      { to: "data-unavailable" as const },
    ];
    logCycleSummary(tallyStates(hyps, transitions));
    assert.equal(logs.length, 1);
    assert.match(
      logs[0],
      /^\[DailyCycle\] Hypothesis state: 2 active, 1 awaiting-deadline, 1 data-unavailable, 1 confirmed this cycle, 1 rejected this cycle, 2 retired this cycle$/,
    );
  });
});
