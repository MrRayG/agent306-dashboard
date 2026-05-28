/**
 * Temporal grounding guard — unit tests.
 *
 * Failure mode (May 2026): Agent 306 news dispatches were drifting on
 * date/year context — old events ("TerraUSD collapse") framed as current,
 * future projections ("IREN/Dell projecting revenue by 2027") without an
 * anchoring source, and current-tense phrasing attached to wrong-year
 * specifics. The claim verifier didn't catch these because it scores
 * attribution lanes, not temporal framing.
 *
 * checkTemporal() is observational only — these tests pin the four
 * detection kinds (YEAR_DRIFT, STALE_AS_CURRENT, FUTURE_NO_SOURCE,
 * WRONG_YEAR_CURRENT) and confirm that historical framing / inline source
 * URLs / verbal hedges are honored as escapes.
 *
 * Tests pass a fixed `now` so the suite is deterministic across years.
 * Run: npx tsx --test server/__tests__/temporalGuard.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkTemporal, buildTemporalGroundingBlock } from "../temporalGuard.js";

const NOW = new Date("2026-05-27T12:00:00Z");

describe("checkTemporal — PASS cases", () => {
  it("PASS on a clean current-cycle post", () => {
    const r = checkTemporal(
      `[306 NEWS] Today, ETH is trading at $2,000. AI adoption continues.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS");
    assert.equal(r.findings.length, 0);
  });

  it("PASS when a historical event is explicitly dated", () => {
    const r = checkTemporal(
      `Today, regulators are still circling DeFi, three years after the 2022 TerraUSD collapse wiped out $40B.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("PASS when a historical event uses historical framer", () => {
    const r = checkTemporal(
      `Back in the wake of the TerraUSD collapse, stablecoin regulation accelerated.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("PASS on near-future projection (current year + 1)", () => {
    const r = checkTemporal(
      `Analysts expect agentic AI adoption to surge by 2027.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("PASS on far-future projection with inline URL", () => {
    const r = checkTemporal(
      `IREN/Dell deal projects $5B revenue by 2030 [https://example.com/iren-dell].`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("PASS on far-future projection with verbal hedge", () => {
    const r = checkTemporal(
      `As widely covered, agentic AI is projected to hit $317B by 2035.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });
});

describe("checkTemporal — STALE_AS_CURRENT", () => {
  it("HARD_FAIL when TerraUSD is referenced with current-cycle adverb and no year", () => {
    const r = checkTemporal(
      `Today, the TerraUSD collapse is sending shockwaves through stablecoin markets.`,
      { now: NOW },
    );
    assert.equal(r.severity, "HARD_FAIL");
    assert.ok(r.findings.some((f) => f.kind === "STALE_AS_CURRENT"));
  });

  it("HARD_FAIL when Hodlnaut/Zhu Juntao is framed as current-week news without year", () => {
    const r = checkTemporal(
      `This week, Singapore is charging former Hodlnaut CEO Zhu Juntao in a major crypto enforcement action.`,
      { now: NOW },
    );
    assert.equal(r.severity, "HARD_FAIL", JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.kind === "STALE_AS_CURRENT"));
  });

  it("SOFT_WARN when FTX collapse is mentioned with no year and no historical framer", () => {
    const r = checkTemporal(
      `The FTX collapse reshaped the industry.`,
      { now: NOW },
    );
    assert.equal(r.severity, "SOFT_WARN", JSON.stringify(r.findings));
  });
});

describe("checkTemporal — YEAR_DRIFT", () => {
  it("HARD_FAIL when an old year is paired with present-tense verbs and no past framing", () => {
    const r = checkTemporal(
      `In 2024, OpenAI is launching new products and announces a partnership.`,
      { now: NOW },
    );
    assert.equal(r.severity, "HARD_FAIL", JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.kind === "YEAR_DRIFT"));
  });

  it("PASS when an old year is paired with past-tense markers", () => {
    const r = checkTemporal(
      `In 2024, OpenAI launched new products and announced a partnership.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });
});

describe("checkTemporal — WRONG_YEAR_CURRENT", () => {
  it("HARD_FAIL when 'currently' is attached to a wrong year", () => {
    const r = checkTemporal(
      `In 2024, the market is currently rallying on AI optimism.`,
      { now: NOW },
    );
    assert.equal(r.severity, "HARD_FAIL", JSON.stringify(r.findings));
    assert.ok(
      r.findings.some((f) => f.kind === "WRONG_YEAR_CURRENT" || f.kind === "YEAR_DRIFT"),
    );
  });
});

describe("checkTemporal — FUTURE_NO_SOURCE", () => {
  it("SOFT_WARN on a far-future projection with no URL and no hedge", () => {
    const r = checkTemporal(
      `IREN/Dell deal projects revenue by 2030.`,
      { now: NOW },
    );
    assert.equal(r.severity, "SOFT_WARN", JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.kind === "FUTURE_NO_SOURCE"));
  });

  it("PASS when same projection carries an inline URL", () => {
    const r = checkTemporal(
      `IREN/Dell deal projects revenue by 2030 [https://example.com/iren].`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });
});

describe("checkTemporal — DATED_CLAIM_DRIFT", () => {
  it("HARD_FAIL on the user-reported reflection bug (May 20, 2025 for a 2026 event)", () => {
    const r = checkTemporal(
      `On May 20, 2025, an OpenAI model disproved a math conjecture that stood for 80 years.`,
      { now: NOW },
    );
    assert.equal(r.severity, "HARD_FAIL", JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.kind === "DATED_CLAIM_DRIFT"));
  });

  it("PASS when the dated event is correctly anchored to the current year", () => {
    const r = checkTemporal(
      `On May 20, 2026, an OpenAI model disproved a math conjecture that stood for 80 years.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("PASS when a non-current dated claim is framed as historical", () => {
    const r = checkTemporal(
      `Back in November 14, 2022, FTX filed for bankruptcy, reshaping the industry.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("PASS when the day-month-year ordering matches the current year", () => {
    const r = checkTemporal(
      `On 20 May 2026, the Erdős unit-distance conjecture was disproved.`,
      { now: NOW },
    );
    assert.equal(r.severity, "PASS", JSON.stringify(r.findings));
  });

  it("HARD_FAIL on day-month-year ordering with a wrong past year", () => {
    const r = checkTemporal(
      `On 20 May 2025, OpenAI's model disproved a long-standing math conjecture.`,
      { now: NOW },
    );
    assert.equal(r.severity, "HARD_FAIL", JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.kind === "DATED_CLAIM_DRIFT"));
  });
});

describe("buildTemporalGroundingBlock", () => {
  it("includes the current ISO date and year", () => {
    const block = buildTemporalGroundingBlock(NOW);
    assert.match(block, /2026-05-27/);
    assert.match(block, /current year is 2026/);
  });

  it("names the four enforcement rules in operational terms", () => {
    const block = buildTemporalGroundingBlock(NOW);
    assert.match(block, /historical|TerraUSD|FTX|Hodlnaut/i);
    assert.match(block, /Forward projections/i);
    assert.match(block, /publicly reported|industry reporting/i);
    assert.match(block, /today.*this week.*currently.*now/i);
  });
});

describe("checkTemporal — currentYear is derived from `now`", () => {
  it("uses opts.now to determine the current year", () => {
    const future = new Date("2030-01-01T00:00:00Z");
    const r = checkTemporal(
      `In 2028, OpenAI is launching new products.`,
      { now: future },
    );
    assert.equal(r.currentYear, 2030);
    assert.equal(r.severity, "HARD_FAIL");
  });
});
