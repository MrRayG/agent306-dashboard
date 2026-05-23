// Wave 2.3 PR-1 — tests for domain-aware decay (per Agent 306's
// "The Hypothesis Debt Crisis" blog). Covers:
//   - half-life table constants
//   - isPastHalfLife() wall-clock math
//   - each of 4 domains retires at the correct age
//   - backward-compat: hypotheses without a domain still hit legacy 7-cycle
//   - classifier LLM call maps domain → halfLifeHours (mocked fetch)

import { test, describe, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  DOMAIN_HALF_LIFE_HOURS,
  FOUNDATIONAL_CAP_HOURS,
  halfLifeFor,
  isPastHalfLife,
  classifyDomain,
} from "../hypothesisDomainClassifier.js";
import { classifyForStateMachine } from "../hypothesisStateMachine.js";
import type { Hypothesis } from "../researchEngine.js";
import { resolveTask }    from "../modelRouter.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-01T00:00:00.000Z");

function hoursAgo(n: number, anchor: Date = NOW): string {
  return new Date(anchor.getTime() - n * 60 * 60 * 1000).toISOString();
}

function mkHyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id:         "hyp_test",
    claim:      "test claim",
    basis:      "test basis",
    metric:     "",
    prediction: "test prediction",
    timeframe:  "",
    status:     "testing",
    confidence: "medium",
    formedAt:   hoursAgo(1),
    ...overrides,
  };
}

// ── Half-life table ──────────────────────────────────────────────────────────

describe("DOMAIN_HALF_LIFE_HOURS table", () => {
  test("ai-news is 72h (3 days)", () => {
    assert.equal(DOMAIN_HALF_LIFE_HOURS["ai-news"], 72);
  });
  test("regulatory is 720h (30 days)", () => {
    assert.equal(DOMAIN_HALF_LIFE_HOURS["regulatory"], 720);
  });
  test("foundational is 13140h (~18 months)", () => {
    assert.equal(DOMAIN_HALF_LIFE_HOURS["foundational"], 13_140);
  });
  test("unknown is 168h (7 days, matches legacy sentinel)", () => {
    assert.equal(DOMAIN_HALF_LIFE_HOURS["unknown"], 168);
  });
  test("foundational is capped at FOUNDATIONAL_CAP_HOURS (26280h = 36mo)", () => {
    assert.equal(FOUNDATIONAL_CAP_HOURS, 26_280);
    assert.ok(halfLifeFor("foundational") <= FOUNDATIONAL_CAP_HOURS);
  });
});

// ── isPastHalfLife ───────────────────────────────────────────────────────────

describe("isPastHalfLife()", () => {
  test("returns true exactly at the half-life", () => {
    assert.equal(isPastHalfLife(hoursAgo(72), 72, NOW), true);
  });
  test("returns true past the half-life", () => {
    assert.equal(isPastHalfLife(hoursAgo(100), 72, NOW), true);
  });
  test("returns false before the half-life", () => {
    assert.equal(isPastHalfLife(hoursAgo(71), 72, NOW), false);
  });
  test("returns false for missing formedAt", () => {
    assert.equal(isPastHalfLife(undefined, 72, NOW), false);
  });
  test("returns false for missing halfLifeHours", () => {
    assert.equal(isPastHalfLife(hoursAgo(100), undefined, NOW), false);
  });
  test("returns false for malformed formedAt", () => {
    assert.equal(isPastHalfLife("not-a-date", 72, NOW), false);
  });
});

// ── Domain-aware retirement timing ───────────────────────────────────────────

describe("classifyForStateMachine() — domain-aware retirement", () => {
  test("ai-news retires at 72h", () => {
    const hyp = mkHyp({ domain: "ai-news", halfLifeHours: 72, formedAt: hoursAgo(73) });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, "stale-retired");
    assert.ok(result.reason?.includes("72h half-life"));
    assert.ok(result.reason?.includes("ai-news"));
  });

  test("ai-news survives at 71h", () => {
    const hyp = mkHyp({ domain: "ai-news", halfLifeHours: 72, formedAt: hoursAgo(71) });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, undefined);
  });

  test("regulatory retires at 720h (30d)", () => {
    const hyp = mkHyp({ domain: "regulatory", halfLifeHours: 720, formedAt: hoursAgo(721) });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, "stale-retired");
    assert.ok(result.reason?.includes("720h"));
  });

  test("regulatory survives at 72h (would have retired as ai-news)", () => {
    const hyp = mkHyp({ domain: "regulatory", halfLifeHours: 720, formedAt: hoursAgo(100) });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, undefined);
  });

  test("foundational retires at 13140h but not 13139h", () => {
    const old = mkHyp({ domain: "foundational", halfLifeHours: 13_140, formedAt: hoursAgo(13_140) });
    assert.equal(classifyForStateMachine(old, NOW).transitionTo, "stale-retired");

    const young = mkHyp({ domain: "foundational", halfLifeHours: 13_140, formedAt: hoursAgo(13_139) });
    assert.equal(classifyForStateMachine(young, NOW).transitionTo, undefined);
  });

  test("unknown retires at 168h (legacy sentinel)", () => {
    const hyp = mkHyp({ domain: "unknown", halfLifeHours: 168, formedAt: hoursAgo(169) });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, "stale-retired");
  });

  test("half-life does NOT fire for forming-state hypothesis (grace period)", () => {
    const hyp = mkHyp({
      domain:        "ai-news",
      halfLifeHours: 72,
      formedAt:      hoursAgo(100),
      status:        "forming",
    });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, undefined);
  });
});

// ── Backward-compat — legacy 7-cycle still applies when no domain ──────────

describe("backward-compat — hypotheses without a domain", () => {
  test("legacy stale-retired still fires at 7 cycles", () => {
    const hyp = mkHyp({ cycleCount: 7 }); // no domain, no halfLifeHours
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, "stale-retired");
    assert.ok(result.reason?.includes("7 cycles"));
  });

  test("legacy 7-cycle is SUPPRESSED when halfLifeHours is cached", () => {
    // 7 cycles but classified as foundational — the domain clock owns the
    // decision. The hypothesis is only ~1h old, so it survives.
    const hyp = mkHyp({
      cycleCount:    7,
      domain:        "foundational",
      halfLifeHours: 13_140,
      formedAt:      hoursAgo(1),
    });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, undefined);
  });

  test("hypothesis with <7 cycles and no domain is untouched", () => {
    const hyp = mkHyp({ cycleCount: 3 });
    const result = classifyForStateMachine(hyp, NOW);
    assert.equal(result.transitionTo, undefined);
  });
});

// ── Classifier LLM call (fetch-mocked) ───────────────────────────────────────

describe("classifyDomain() — LLM call", () => {
  const origFetch = globalThis.fetch;
  const origGrokKey = process.env.GROK_API_KEY;
  const origXaiKey  = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.GROK_API_KEY = "test-key";
    process.env.XAI_API_KEY  = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env.GROK_API_KEY = origGrokKey ?? "";
    process.env.XAI_API_KEY  = origXaiKey  ?? "";
  });

  test("maps ai-news response to 72h half-life", async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ domain: "ai-news", justification: "Anthropic release" }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as any;

    const result = await classifyDomain({
      claim:      "Anthropic will release Claude Opus 5 by June 2026",
      prediction: "Model released with new benchmark SOTA",
      timeframe:  "June 2026",
    });
    assert.ok(result);
    assert.equal(result!.domain, "ai-news");
    assert.equal(result!.halfLifeHours, 72);
    assert.ok(result!.justification.length > 0);
  });

  test("maps regulatory response to 720h half-life", async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ domain: "regulatory", justification: "EU AI Act" }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as any;

    const result = await classifyDomain({
      claim: "EU AI Act Phase 2 will take effect by Q3 2026",
      prediction: "Regulation enters force",
      timeframe: "Q3 2026",
    });
    assert.equal(result!.domain, "regulatory");
    assert.equal(result!.halfLifeHours, 720);
  });

  test("coerces invalid domain to 'unknown'", async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ domain: "blockchain", justification: "x" }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as any;

    const result = await classifyDomain({ claim: "x", prediction: "x", timeframe: "x" });
    assert.equal(result!.domain, "unknown");
    assert.equal(result!.halfLifeHours, 168);
  });

  test("returns null on HTTP error (non-fatal)", async () => {
    globalThis.fetch = mock.fn(async () => new Response("server error", { status: 500 })) as any;
    const result = await classifyDomain({ claim: "x", prediction: "x", timeframe: "x" });
    assert.equal(result, null);
  });

  test("returns null on unparseable response", async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not json at all, just prose" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as any;
    const result = await classifyDomain({ claim: "x", prediction: "x", timeframe: "x" });
    assert.equal(result, null);
  });
});

// ── Router wiring ────────────────────────────────────────────────────────────

describe("modelRouter — hypothesis-domain-classification wiring", () => {
  test("routes to standard-voice tier (xai-direct non-reasoning, PR #421)", () => {
    // PR #421 — moved off frontier-factual (grok-4.20-reasoning) because the
    // 4-class label decision doesn't benefit from chain-of-thought, and
    // yesterday's cycle showed ~20 reasoning-route timeouts. Stays on
    // xai-direct via standard-voice → x-ai/grok-4.20-non-reasoning.
    const route = resolveTask("hypothesis-domain-classification");
    assert.equal(route.tier, "standard-voice");
    assert.equal(route.provider, "xai-direct");
  });
});
