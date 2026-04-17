/**
 * hypothesisConsolidationBatch — PR S tests.
 *
 * Verifies:
 *  - The dual flag-gate (HYPOTHESIS_CONSOLIDATION_BATCH + BATCH_API_ENABLED)
 *    correctly gates shouldUseHypothesisBatch().
 *  - buildConsolidationRequests is pure, deterministic, respects minimum
 *    member count, and generates unique batch_request_ids.
 *  - parseRepresentativeIdFromRequestId round-trips the id, including
 *    the collision-suffix case.
 *  - parseConsolidationResults correctly drops stale / unparseable results
 *    and surfaces failures.
 *  - submitConsolidationBatch throws when flags are off (no silent network).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Save+restore env keys we toggle.
const ENV_KEYS = [
  "HYPOTHESIS_CONSOLIDATION_BATCH",
  "BATCH_API_ENABLED",
];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearFlags() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const mod = await import("../hypothesisConsolidationBatch.js");
const {
  isHypothesisBatchEnabled,
  shouldUseHypothesisBatch,
  buildConsolidationRequests,
  parseRepresentativeIdFromRequestId,
  parseConsolidationResults,
  submitConsolidationBatch,
  CONSOLIDATION_SYSTEM_PROMPT,
  buildConsolidationUserPrompt,
} = mod;

// Minimal Hypothesis-shaped fixture (matches researchEngine.Hypothesis).
function h(id: string, claim: string, confidence: "high" | "medium" | "low" = "medium") {
  return {
    id,
    claim,
    confidence,
    status: "forming" as const,
    formedAt: "2026-04-01T00:00:00Z",
    basis: "",
    metric: "",
    prediction: "",
    timeframe: "1 month",
    source: "test",
  } as any;
}

function cluster(repClaim: string, memberClaims: string[], id = "rep1") {
  const members = memberClaims.map((c, i) => h(`${id}_m${i}`, c));
  return {
    representative: { ...h(id, repClaim), ...members[0], id }, // representative has its own id
    members: [h(id, repClaim), ...members],
    similarity: 0.8,
  };
}

beforeEach(() => {
  clearFlags();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

// ── Feature flags ───────────────────────────────────────────────────────────

describe("hypothesisConsolidationBatch — feature flags", () => {
  it("isHypothesisBatchEnabled is false when unset", () => {
    assert.equal(isHypothesisBatchEnabled(), false);
  });

  it("isHypothesisBatchEnabled accepts true/1/yes case-insensitive", () => {
    for (const v of ["true", "TRUE", "1", "yes", "YES"]) {
      process.env.HYPOTHESIS_CONSOLIDATION_BATCH = v;
      assert.equal(isHypothesisBatchEnabled(), true, `value ${v} should enable`);
    }
    process.env.HYPOTHESIS_CONSOLIDATION_BATCH = "false";
    assert.equal(isHypothesisBatchEnabled(), false);
  });

  it("shouldUseHypothesisBatch requires BOTH flags", () => {
    process.env.HYPOTHESIS_CONSOLIDATION_BATCH = "true";
    assert.equal(shouldUseHypothesisBatch(), false, "missing BATCH_API_ENABLED");

    delete process.env.HYPOTHESIS_CONSOLIDATION_BATCH;
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseHypothesisBatch(), false, "missing HYPOTHESIS_CONSOLIDATION_BATCH");

    process.env.HYPOTHESIS_CONSOLIDATION_BATCH = "true";
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseHypothesisBatch(), true);
  });
});

// ── Prompt builders ─────────────────────────────────────────────────────────

describe("hypothesisConsolidationBatch — prompt builders", () => {
  it("CONSOLIDATION_SYSTEM_PROMPT is the same string used by sync mergeCluster", () => {
    assert.equal(
      CONSOLIDATION_SYSTEM_PROMPT,
      "You merge redundant research hypotheses into canonical versions. Be precise and testable.",
    );
  });

  it("buildConsolidationUserPrompt includes all member claims and the variant count", () => {
    const c = cluster("rep claim", ["claim A", "claim B"], "rep1");
    const prompt = buildConsolidationUserPrompt(c);
    assert.ok(prompt.includes("claim A"));
    assert.ok(prompt.includes("claim B"));
    assert.ok(prompt.includes(`${c.members.length} hypotheses`), "should mention member count");
    assert.ok(prompt.includes(`"canonical"`));
  });
});

// ── Request building ────────────────────────────────────────────────────────

describe("hypothesisConsolidationBatch — buildConsolidationRequests", () => {
  it("produces one request per eligible cluster", () => {
    const reqs = buildConsolidationRequests([
      cluster("r1", ["a", "b"], "id1"),
      cluster("r2", ["c", "d"], "id2"),
    ]);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].batch_request_id, "hypmerge_id1");
    assert.equal(reqs[1].batch_request_id, "hypmerge_id2");
  });

  it("skips clusters with fewer than 2 members", () => {
    const lonely = {
      representative: h("only", "solo"),
      members: [h("only", "solo")],
      similarity: 1,
    };
    const reqs = buildConsolidationRequests([lonely as any, cluster("r", ["a", "b"], "ok")]);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].batch_request_id, "hypmerge_ok");
  });

  it("skips clusters missing representative.id", () => {
    const broken = {
      representative: { ...h("", "x"), id: "" },
      members: [h("m1", "a"), h("m2", "b")],
      similarity: 1,
    };
    const reqs = buildConsolidationRequests([broken as any]);
    assert.equal(reqs.length, 0);
  });

  it("handles duplicate representative ids by appending a numeric suffix", () => {
    const reqs = buildConsolidationRequests([
      cluster("r1", ["a", "b"], "dup"),
      cluster("r2", ["c", "d"], "dup"),
    ]);
    assert.equal(reqs.length, 2);
    assert.notEqual(reqs[0].batch_request_id, reqs[1].batch_request_id, "ids must be unique");
    assert.equal(reqs[0].batch_request_id, "hypmerge_dup");
    assert.match(reqs[1].batch_request_id, /^hypmerge_dup_\d+$/);
  });

  it("is pure — does not require flags or network", () => {
    // Flags are cleared by beforeEach. Must still produce requests.
    const reqs = buildConsolidationRequests([cluster("r", ["a", "b"], "pure")]);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].temperature, 0.1);
    assert.equal(reqs[0].max_tokens, 500);
  });
});

// ── Request id round-trip ───────────────────────────────────────────────────

describe("hypothesisConsolidationBatch — parseRepresentativeIdFromRequestId", () => {
  it("round-trips a simple id", () => {
    assert.equal(parseRepresentativeIdFromRequestId("hypmerge_abc123"), "abc123");
  });

  it("strips the collision-suffix", () => {
    assert.equal(parseRepresentativeIdFromRequestId("hypmerge_dup_7"), "dup");
  });

  it("returns null for unrelated ids", () => {
    assert.equal(parseRepresentativeIdFromRequestId("kgconn_x"), null);
    assert.equal(parseRepresentativeIdFromRequestId(""), null);
    assert.equal(parseRepresentativeIdFromRequestId("hypmerge_"), null);
  });
});

// ── Result parsing ──────────────────────────────────────────────────────────

describe("hypothesisConsolidationBatch — parseConsolidationResults", () => {
  it("returns merges keyed by representative.id for well-formed responses", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "hypmerge_rep1",
          content: JSON.stringify({ canonical: "merged A", reasoning: "because" }),
        },
        {
          batch_request_id: "hypmerge_rep2",
          content: JSON.stringify({ canonical: "merged B", reasoning: "also because" }),
        },
      ],
      failed: [],
    };
    const valid = new Set(["rep1", "rep2"]);
    const { merges, failures } = parseConsolidationResults(page as any, valid);
    assert.equal(merges.size, 2);
    assert.equal(merges.get("rep1")?.canonical, "merged A");
    assert.equal(merges.get("rep2")?.canonical, "merged B");
    assert.equal(failures.length, 0);
  });

  it("drops merges whose representative is no longer in the valid set (stale)", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "hypmerge_staleRep",
          content: JSON.stringify({ canonical: "c", reasoning: "r" }),
        },
      ],
      failed: [],
    };
    const valid = new Set<string>(); // empty — everything is stale
    const { merges } = parseConsolidationResults(page as any, valid);
    assert.equal(merges.size, 0);
  });

  it("drops results with unparseable JSON or empty canonical", () => {
    const page = {
      succeeded: [
        { batch_request_id: "hypmerge_a", content: "not json at all" },
        { batch_request_id: "hypmerge_b", content: JSON.stringify({ reasoning: "only" }) },
        { batch_request_id: "hypmerge_c", content: JSON.stringify({ canonical: "" }) },
        { batch_request_id: "hypmerge_d", content: JSON.stringify({ canonical: "  " }) },
      ],
      failed: [],
    };
    const { merges } = parseConsolidationResults(page as any, new Set(["a", "b", "c", "d"]));
    assert.equal(merges.size, 0, "all four should be rejected");
  });

  it("surfaces failures verbatim", () => {
    const page = {
      succeeded: [],
      failed: [
        { batch_request_id: "hypmerge_x", error_message: "rate limit" },
        { batch_request_id: "hypmerge_y", error_message: "invalid input" },
      ],
    };
    const { failures } = parseConsolidationResults(page as any, new Set());
    assert.equal(failures.length, 2);
    assert.equal(failures[0].error_message, "rate limit");
    assert.equal(failures[1].error_message, "invalid input");
  });
});

// ── Submit gating ───────────────────────────────────────────────────────────

describe("hypothesisConsolidationBatch — submitConsolidationBatch flag gating", () => {
  it("throws when HYPOTHESIS_CONSOLIDATION_BATCH is off", async () => {
    await assert.rejects(
      () => submitConsolidationBatch([cluster("r", ["a", "b"], "id")]),
      /disabled/i,
    );
  });

  it("throws when BATCH_API_ENABLED is off", async () => {
    process.env.HYPOTHESIS_CONSOLIDATION_BATCH = "true";
    // BATCH_API_ENABLED still unset
    await assert.rejects(
      () => submitConsolidationBatch([cluster("r", ["a", "b"], "id")]),
      /disabled/i,
    );
  });
});
