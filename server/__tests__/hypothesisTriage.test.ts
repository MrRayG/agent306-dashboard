/**
 * Wave 2.3 PR-4 — 2x2 Stake-Weighted Triage tests.
 *
 * Agent 306's "Hypothesis Debt Crisis" blog: low-stake hypotheses were
 * flooding the active work queue and starving high-stake learning. These
 * tests assert the three spec-mandated invariants:
 *   1. low-stake hypotheses NEVER appear in the cycle-iterated active set
 *   2. high-stake + low-confidence sorts first within active
 *   3. classification routes to frontier-factual (Grok 4.20 Reasoning) via
 *      xai-direct — not silently collapsed to Claude Opus via OpenRouter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  queueFor,
  triagePriority,
  sortByTriagePriority,
  isActiveQueue,
} from "../hypothesisTriage.ts";
import { resolveTask } from "../modelRouter.ts";
import { toXAINativeModel } from "../llmConfig.ts";
import type { Hypothesis } from "../researchEngine.ts";

// ── 2x2 quadrant fixtures ────────────────────────────────────────────────────
// One hypothesis per cell of the matrix, plus one pre-PR-4 legacy row with
// no queue field (must be treated as active for backward compat).

type TriageFixture = Pick<
  Hypothesis,
  "id" | "stake" | "triageConfidence" | "queue" | "formedAt" | "status"
>;

const HIGH_STAKE_LOW_CONF: TriageFixture = {
  id:               "hyp_hs_lc",
  status:           "forming",
  stake:            "high",
  triageConfidence: "low",
  queue:            "active",
  formedAt:         "2026-04-01T00:00:00Z",
};
const HIGH_STAKE_HIGH_CONF: TriageFixture = {
  id:               "hyp_hs_hc",
  status:           "forming",
  stake:            "high",
  triageConfidence: "high",
  queue:            "active",
  formedAt:         "2026-04-01T00:00:00Z",
};
const LOW_STAKE_LOW_CONF: TriageFixture = {
  id:               "hyp_ls_lc",
  status:           "forming",
  stake:            "low",
  triageConfidence: "low",
  queue:            "backlog",
  formedAt:         "2026-04-01T00:00:00Z",
};
const LOW_STAKE_HIGH_CONF: TriageFixture = {
  id:               "hyp_ls_hc",
  status:           "forming",
  stake:            "low",
  triageConfidence: "high",
  queue:            "backlog",
  formedAt:         "2026-04-01T00:00:00Z",
};
const LEGACY_NO_QUEUE: TriageFixture = {
  id:       "hyp_legacy",
  status:   "forming",
  formedAt: "2026-03-15T00:00:00Z",
};

const ALL_QUADRANTS: TriageFixture[] = [
  HIGH_STAKE_LOW_CONF,
  HIGH_STAKE_HIGH_CONF,
  LOW_STAKE_LOW_CONF,
  LOW_STAKE_HIGH_CONF,
];

// ── queueFor ─────────────────────────────────────────────────────────────────

test("queueFor: high-stake → active, low-stake → backlog", () => {
  assert.equal(queueFor("high"), "active");
  assert.equal(queueFor("low"),  "backlog");
});

// ── isActiveQueue (cycle iteration gate) ─────────────────────────────────────

test("isActiveQueue: excludes low-stake hypotheses (backlog) from cycle iteration", () => {
  const activeSet = ALL_QUADRANTS.filter(isActiveQueue);

  assert.equal(activeSet.length, 2, "exactly the two high-stake rows should be in active");
  const activeIds = activeSet.map(h => h.id).sort();
  assert.deepEqual(activeIds, ["hyp_hs_hc", "hyp_hs_lc"]);

  // The spec-mandated invariant: low-stake NEVER appears in the iterated set.
  for (const h of activeSet) {
    assert.notEqual(h.id, "hyp_ls_lc", "low-stake + low-conf must never be iterated");
    assert.notEqual(h.id, "hyp_ls_hc", "low-stake + high-conf must never be iterated");
  }
});

test("isActiveQueue: backward compat — hypotheses missing queue field count as active", () => {
  assert.equal(isActiveQueue(LEGACY_NO_QUEUE), true,
    "pre-PR-4 hypotheses (no queue field) must be iterated so we don't silently drop work");
});

test("isActiveQueue: explicit queue='active' → true, queue='backlog' → false", () => {
  assert.equal(isActiveQueue({ queue: "active"  }), true);
  assert.equal(isActiveQueue({ queue: "backlog" }), false);
  assert.equal(isActiveQueue({}),                   true);
});

// ── triagePriority + sortByTriagePriority ────────────────────────────────────

test("triagePriority: high-stake + low-conf = 0 (highest priority)", () => {
  assert.equal(triagePriority(HIGH_STAKE_LOW_CONF),  0);
  assert.equal(triagePriority(HIGH_STAKE_HIGH_CONF), 1);
  assert.equal(triagePriority(LOW_STAKE_LOW_CONF),   2);
  assert.equal(triagePriority(LOW_STAKE_HIGH_CONF),  2);
  assert.equal(triagePriority(LEGACY_NO_QUEUE),      2, "legacy rows de-prioritized behind triaged ones");
});

test("sortByTriagePriority: high-stake + low-confidence sorts first within active queue", () => {
  // Intentionally reversed order to confirm the sort actually runs.
  const reversed = [HIGH_STAKE_HIGH_CONF, HIGH_STAKE_LOW_CONF];
  const sorted   = sortByTriagePriority(reversed);

  assert.equal(sorted[0].id, "hyp_hs_lc",
    "high-stake + low-confidence must sort to index 0 (work first)");
  assert.equal(sorted[1].id, "hyp_hs_hc",
    "high-stake + high-confidence comes next");
});

test("sortByTriagePriority: older formedAt breaks ties to prevent starvation", () => {
  const older: TriageFixture = { ...HIGH_STAKE_LOW_CONF, id: "hyp_old",   formedAt: "2026-01-01T00:00:00Z" };
  const newer: TriageFixture = { ...HIGH_STAKE_LOW_CONF, id: "hyp_new",   formedAt: "2026-04-17T00:00:00Z" };
  const sorted = sortByTriagePriority([newer, older]);

  assert.equal(sorted[0].id, "hyp_old", "older hypothesis at same priority sorts first");
  assert.equal(sorted[1].id, "hyp_new");
});

test("end-to-end: seeded 2x2 → cycle iteration sees only high-stake, in correct priority order", () => {
  // Simulate what dailyCycleEngine.autoTestHypotheses does:
  //   1. filter by isActiveQueue → drops backlog rows
  //   2. sortByTriagePriority    → high-stake + low-conf first
  const candidates = sortByTriagePriority(ALL_QUADRANTS.filter(isActiveQueue));

  assert.equal(candidates.length, 2, "low-stake rows dropped from cycle iteration");
  assert.equal(candidates[0].id, "hyp_hs_lc", "high-stake + low-conf at the front");
  assert.equal(candidates[1].id, "hyp_hs_hc", "high-stake + high-conf next");

  // Explicit invariant assertion: low-stake never in cycle set.
  const iteratedIds = new Set(candidates.map(c => c.id));
  assert.equal(iteratedIds.has("hyp_ls_lc"), false, "low-stake + low-conf MUST NOT be iterated");
  assert.equal(iteratedIds.has("hyp_ls_hc"), false, "low-stake + high-conf MUST NOT be iterated");
});

// ── Routing — frontier-factual + xai-direct + grok-4.20-0309-reasoning ───────

test("routing: hypothesis-triage resolves to frontier-factual tier on xai-direct", () => {
  const route = resolveTask("hypothesis-triage");

  assert.equal(route.tier,     "frontier-factual",
    "hypothesis-triage must route to the factual tier (Grok 4.20 Reasoning)");
  assert.equal(route.provider, "xai-direct",
    "must hit api.x.ai directly, not OpenRouter (where it would silently collapse to Opus)");
  assert.equal(route.model,    "x-ai/grok-4.20-reasoning",
    "OpenRouter-format stored string (translated to native at dispatch)");
});

test("routing: hypothesis-triage native xAI model resolves to grok-4.20-0309-reasoning", () => {
  const route  = resolveTask("hypothesis-triage");
  const native = toXAINativeModel(route.model);

  assert.equal(native, "grok-4.20-0309-reasoning",
    "dispatch-time translation must yield the 17%-hallucination flagship, not the Fast budget tier");
});
