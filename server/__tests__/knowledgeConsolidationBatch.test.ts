/**
 * knowledgeConsolidationBatch — PR U tests.
 *
 * Verifies:
 *  - The dual flag-gate (KNOWLEDGE_CONSOLIDATION_BATCH + BATCH_API_ENABLED)
 *    correctly gates shouldUseKnowledgeBatch().
 *  - buildKnowledgeConsolidationRequests is pure, deterministic, respects
 *    the minimum-entry threshold, and generates unique batch_request_ids.
 *  - parseGroupKeyFromRequestId round-trips sanitized keys (including the
 *    collision-suffix case) and returns null for unrelated ids.
 *  - parseKnowledgeConsolidationResults correctly drops stale / malformed
 *    responses, clamps summaries, defaults category/weight, and surfaces
 *    failures.
 *  - submitKnowledgeConsolidationBatch throws when flags are off (no silent
 *    network).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Save+restore env keys we toggle.
const ENV_KEYS = [
  "KNOWLEDGE_CONSOLIDATION_BATCH",
  "BATCH_API_ENABLED",
];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearFlags() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const mod = await import("../knowledgeConsolidationBatch.js");
const {
  isKnowledgeBatchEnabled,
  shouldUseKnowledgeBatch,
  buildKnowledgeConsolidationRequests,
  parseGroupKeyFromRequestId,
  parseKnowledgeConsolidationResults,
  submitKnowledgeConsolidationBatch,
  sanitizeGroupKey,
  KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT,
  buildKnowledgeUserPrompt,
} = mod;

// ── Fixtures ────────────────────────────────────────────────────────────────

function entry(id: string, title: string, summary: string, weight = 5, category = "finance") {
  return { id, title, summary, weight, category, status: "active" };
}

function group(key: string, entries: any[]) {
  return { key, entries };
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

describe("knowledgeConsolidationBatch — feature flags", () => {
  it("isKnowledgeBatchEnabled is false when unset", () => {
    assert.equal(isKnowledgeBatchEnabled(), false);
  });

  it("isKnowledgeBatchEnabled accepts true/1/yes case-insensitive", () => {
    for (const v of ["true", "TRUE", "1", "yes", "YES"]) {
      process.env.KNOWLEDGE_CONSOLIDATION_BATCH = v;
      assert.equal(isKnowledgeBatchEnabled(), true, `value ${v} should enable`);
    }
    process.env.KNOWLEDGE_CONSOLIDATION_BATCH = "false";
    assert.equal(isKnowledgeBatchEnabled(), false);
  });

  it("shouldUseKnowledgeBatch requires BOTH flags", () => {
    process.env.KNOWLEDGE_CONSOLIDATION_BATCH = "true";
    assert.equal(shouldUseKnowledgeBatch(), false, "missing BATCH_API_ENABLED");

    delete process.env.KNOWLEDGE_CONSOLIDATION_BATCH;
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseKnowledgeBatch(), false, "missing KNOWLEDGE_CONSOLIDATION_BATCH");

    process.env.KNOWLEDGE_CONSOLIDATION_BATCH = "true";
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseKnowledgeBatch(), true);
  });
});

// ── Prompt builders ─────────────────────────────────────────────────────────

describe("knowledgeConsolidationBatch — prompt builders", () => {
  it("KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT has the required JSON schema hint", () => {
    assert.ok(KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT.includes("consolidated"));
    assert.ok(KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT.includes("ONLY valid JSON"));
    assert.ok(KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT.includes("Preserve ALL unique facts"));
  });

  it("buildKnowledgeUserPrompt includes every entry title/summary and the entry count", () => {
    const g = group("finance:rates_yields", [
      entry("k1", "Fed rate cut", "Fed cut 25bps", 7),
      entry("k2", "Treasury yields", "10y dropped 15bps", 6),
      entry("k3", "Mortgage rates", "30y fixed 6.5%", 5),
    ]);
    const prompt = buildKnowledgeUserPrompt(g);
    assert.ok(prompt.includes("[Fed rate cut]"));
    assert.ok(prompt.includes("[Treasury yields]"));
    assert.ok(prompt.includes("[Mortgage rates]"));
    assert.ok(prompt.includes("weight: 7"));
    assert.ok(prompt.includes("3 related knowledge entries"));
  });

  it("buildKnowledgeUserPrompt is deterministic for the same group", () => {
    const g = group("test:abc", [
      entry("k1", "t1", "s1", 5),
      entry("k2", "t2", "s2", 5),
      entry("k3", "t3", "s3", 5),
    ]);
    assert.equal(buildKnowledgeUserPrompt(g), buildKnowledgeUserPrompt(g));
  });
});

// ── sanitizeGroupKey ────────────────────────────────────────────────────────

describe("knowledgeConsolidationBatch — sanitizeGroupKey", () => {
  it("preserves allowed characters (letters, digits, underscore, colon)", () => {
    assert.equal(sanitizeGroupKey("finance:rates_yields"), "finance:rates_yields");
    assert.equal(sanitizeGroupKey("cat42:topic_abc"), "cat42:topic_abc");
  });

  it("replaces disallowed characters with underscore", () => {
    assert.equal(sanitizeGroupKey("a b"), "a_b");
    assert.equal(sanitizeGroupKey("a/b"), "a_b");
    assert.equal(sanitizeGroupKey("a.b"), "a_b");
  });
});

// ── Request building ────────────────────────────────────────────────────────

describe("knowledgeConsolidationBatch — buildKnowledgeConsolidationRequests", () => {
  it("produces one request per eligible group with the correct id shape", () => {
    const reqs = buildKnowledgeConsolidationRequests([
      group("finance:rates", [entry("k1", "t1", "s1"), entry("k2", "t2", "s2"), entry("k3", "t3", "s3")]),
      group("tech:ai", [entry("k4", "t4", "s4"), entry("k5", "t5", "s5"), entry("k6", "t6", "s6")]),
    ]);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].batch_request_id, "kbcons_finance:rates");
    assert.equal(reqs[1].batch_request_id, "kbcons_tech:ai");
    assert.equal(reqs[0].temperature, 0.2);
    assert.equal(reqs[0].max_tokens, 600);
    assert.equal(reqs[0].messages.length, 2);
    assert.equal(reqs[0].messages[0].role, "system");
    assert.equal(reqs[0].messages[1].role, "user");
  });

  it("skips groups with fewer than 3 entries", () => {
    const reqs = buildKnowledgeConsolidationRequests([
      group("tiny", [entry("k1", "t", "s"), entry("k2", "t", "s")]),
      group("ok", [entry("k3", "t", "s"), entry("k4", "t", "s"), entry("k5", "t", "s")]),
    ]);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].batch_request_id, "kbcons_ok");
  });

  it("skips groups missing a key or an entries array", () => {
    const broken1 = { key: "", entries: [entry("k1", "t", "s"), entry("k2", "t", "s"), entry("k3", "t", "s")] };
    const broken2 = { key: "noentries" } as any;
    const reqs = buildKnowledgeConsolidationRequests([broken1 as any, broken2]);
    assert.equal(reqs.length, 0);
  });

  it("sanitizes keys that would otherwise break request-id round-tripping", () => {
    const reqs = buildKnowledgeConsolidationRequests([
      group("weird space/slash", [entry("k1", "t", "s"), entry("k2", "t", "s"), entry("k3", "t", "s")]),
    ]);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].batch_request_id, "kbcons_weird_space_slash");
  });

  it("handles duplicate group keys by appending a numeric suffix", () => {
    const reqs = buildKnowledgeConsolidationRequests([
      group("dup", [entry("k1", "t", "s"), entry("k2", "t", "s"), entry("k3", "t", "s")]),
      group("dup", [entry("k4", "t", "s"), entry("k5", "t", "s"), entry("k6", "t", "s")]),
    ]);
    assert.equal(reqs.length, 2);
    assert.notEqual(reqs[0].batch_request_id, reqs[1].batch_request_id, "ids must be unique");
    assert.equal(reqs[0].batch_request_id, "kbcons_dup");
    assert.match(reqs[1].batch_request_id, /^kbcons_dup_\d+$/);
  });

  it("is pure — does not require flags or network", () => {
    // Flags are cleared by beforeEach. Must still produce requests.
    const reqs = buildKnowledgeConsolidationRequests([
      group("pure", [entry("k1", "t", "s"), entry("k2", "t", "s"), entry("k3", "t", "s")]),
    ]);
    assert.equal(reqs.length, 1);
  });
});

// ── Request id round-trip ───────────────────────────────────────────────────

describe("knowledgeConsolidationBatch — parseGroupKeyFromRequestId", () => {
  it("round-trips a sanitized key", () => {
    assert.equal(parseGroupKeyFromRequestId("kbcons_finance:rates_yields"), "finance:rates_yields");
  });

  it("strips the collision-suffix only when present", () => {
    assert.equal(parseGroupKeyFromRequestId("kbcons_dup_7"), "dup");
    assert.equal(parseGroupKeyFromRequestId("kbcons_simple"), "simple");
  });

  it("returns null for unrelated ids", () => {
    assert.equal(parseGroupKeyFromRequestId("hypmerge_x"), null);
    assert.equal(parseGroupKeyFromRequestId("kgconn_x"), null);
    assert.equal(parseGroupKeyFromRequestId(""), null);
    assert.equal(parseGroupKeyFromRequestId("kbcons_"), null);
  });
});

// ── Result parsing ──────────────────────────────────────────────────────────

function makeGroupsByKey(specs: Array<[string, any[]]>): Map<string, any> {
  const m = new Map<string, any>();
  for (const [key, entries] of specs) {
    m.set(key, { key, entries });
  }
  return m;
}

describe("knowledgeConsolidationBatch — parseKnowledgeConsolidationResults", () => {
  it("returns consolidated entries keyed by group key for well-formed responses", () => {
    const groupsByKey = makeGroupsByKey([
      ["finance:rates", [entry("k1", "t1", "s1", 8), entry("k2", "t2", "s2", 5), entry("k3", "t3", "s3", 6)]],
      ["tech:ai", [entry("k4", "t4", "s4", 4)]],
    ]);
    const page = {
      succeeded: [
        {
          batch_request_id: "kbcons_finance:rates",
          content: JSON.stringify({
            consolidated: [
              { title: "Rates overview", summary: "Combined rate insights", category: "finance", weight: 7 },
            ],
          }),
        },
        {
          batch_request_id: "kbcons_tech:ai",
          content: JSON.stringify({
            consolidated: [
              { title: "AI roundup", summary: "ai", category: "tech", weight: 9 },
            ],
          }),
        },
      ],
      failed: [],
    };
    const valid = new Set(["finance:rates", "tech:ai"]);
    const { consolidations, failures } = parseKnowledgeConsolidationResults(page as any, valid, groupsByKey);
    assert.equal(consolidations.size, 2);
    assert.equal(consolidations.get("finance:rates")?.[0].title, "Rates overview");
    // maxWeight of source group is 8 → stored weight = max(7, 8) = 8
    assert.equal(consolidations.get("finance:rates")?.[0].weight, 8);
    assert.equal(consolidations.get("tech:ai")?.[0].weight, 9);
    // tier + source stamped by the parser, not the LLM
    assert.equal(consolidations.get("finance:rates")?.[0].tier, "active");
    assert.equal(consolidations.get("finance:rates")?.[0].source, "consolidation");
    assert.equal(failures.length, 0);
  });

  it("clamps summary to 300 chars (matches sync behavior)", () => {
    const long = "x".repeat(400);
    const groupsByKey = makeGroupsByKey([["a", [entry("k1", "t1", "s1"), entry("k2", "t2", "s2"), entry("k3", "t3", "s3")]]]);
    const page = {
      succeeded: [
        {
          batch_request_id: "kbcons_a",
          content: JSON.stringify({ consolidated: [{ title: "t", summary: long, category: "c", weight: 6 }] }),
        },
      ],
      failed: [],
    };
    const { consolidations } = parseKnowledgeConsolidationResults(page as any, new Set(["a"]), groupsByKey);
    assert.equal(consolidations.get("a")?.[0].summary.length, 300);
  });

  it("drops results whose group key is no longer in the valid set (stale)", () => {
    const groupsByKey = makeGroupsByKey([["stale", [entry("k1", "t1", "s1"), entry("k2", "t2", "s2"), entry("k3", "t3", "s3")]]]);
    const page = {
      succeeded: [
        {
          batch_request_id: "kbcons_stale",
          content: JSON.stringify({ consolidated: [{ title: "t", summary: "s", category: "c", weight: 5 }] }),
        },
      ],
      failed: [],
    };
    const valid = new Set<string>(); // empty — everything is stale
    const { consolidations } = parseKnowledgeConsolidationResults(page as any, valid, groupsByKey);
    assert.equal(consolidations.size, 0);
  });

  it("drops results with unparseable JSON or empty consolidated arrays", () => {
    const groupsByKey = makeGroupsByKey([
      ["a", [entry("k1", "t1", "s1"), entry("k2", "t2", "s2"), entry("k3", "t3", "s3")]],
      ["b", [entry("k4", "t4", "s4"), entry("k5", "t5", "s5"), entry("k6", "t6", "s6")]],
      ["c", [entry("k7", "t7", "s7"), entry("k8", "t8", "s8"), entry("k9", "t9", "s9")]],
    ]);
    const page = {
      succeeded: [
        { batch_request_id: "kbcons_a", content: "not json at all" },
        { batch_request_id: "kbcons_b", content: JSON.stringify({ consolidated: [] }) },
        { batch_request_id: "kbcons_c", content: JSON.stringify({}) },
      ],
      failed: [],
    };
    const { consolidations } = parseKnowledgeConsolidationResults(
      page as any,
      new Set(["a", "b", "c"]),
      groupsByKey,
    );
    assert.equal(consolidations.size, 0, "all three should be rejected");
  });

  it("drops individual consolidated entries that are missing title or summary", () => {
    const groupsByKey = makeGroupsByKey([["a", [entry("k1", "t1", "s1"), entry("k2", "t2", "s2"), entry("k3", "t3", "s3")]]]);
    const page = {
      succeeded: [
        {
          batch_request_id: "kbcons_a",
          content: JSON.stringify({
            consolidated: [
              { title: "", summary: "s", category: "c", weight: 5 },
              { title: "ok", summary: "", category: "c", weight: 5 },
              { title: "good", summary: "good summary", category: "c", weight: 5 },
            ],
          }),
        },
      ],
      failed: [],
    };
    const { consolidations } = parseKnowledgeConsolidationResults(page as any, new Set(["a"]), groupsByKey);
    assert.equal(consolidations.get("a")?.length, 1);
    assert.equal(consolidations.get("a")?.[0].title, "good");
  });

  it("falls back to the source group's first-entry category when LLM omits it", () => {
    const groupsByKey = makeGroupsByKey([[
      "a",
      [entry("k1", "t1", "s1", 5, "finance"), entry("k2", "t2", "s2", 5, "finance"), entry("k3", "t3", "s3", 5, "finance")],
    ]]);
    const page = {
      succeeded: [
        {
          batch_request_id: "kbcons_a",
          content: JSON.stringify({ consolidated: [{ title: "t", summary: "s", weight: 5 }] }),
        },
      ],
      failed: [],
    };
    const { consolidations } = parseKnowledgeConsolidationResults(page as any, new Set(["a"]), groupsByKey);
    assert.equal(consolidations.get("a")?.[0].category, "finance");
  });

  it("floors weight at the source group's max weight (no downgrades)", () => {
    const groupsByKey = makeGroupsByKey([[
      "a",
      [entry("k1", "t1", "s1", 3), entry("k2", "t2", "s2", 9), entry("k3", "t3", "s3", 5)],
    ]]);
    const page = {
      succeeded: [
        {
          batch_request_id: "kbcons_a",
          content: JSON.stringify({ consolidated: [{ title: "t", summary: "s", category: "c", weight: 4 }] }),
        },
      ],
      failed: [],
    };
    const { consolidations } = parseKnowledgeConsolidationResults(page as any, new Set(["a"]), groupsByKey);
    // LLM said weight=4, but max source weight is 9 — parser must take the max
    assert.equal(consolidations.get("a")?.[0].weight, 9);
  });

  it("surfaces failures verbatim", () => {
    const page = {
      succeeded: [],
      failed: [
        { batch_request_id: "kbcons_x", error_message: "rate limit" },
        { batch_request_id: "kbcons_y", error_message: "invalid input" },
      ],
    };
    const { failures } = parseKnowledgeConsolidationResults(page as any, new Set(), new Map());
    assert.equal(failures.length, 2);
    assert.equal(failures[0].error_message, "rate limit");
    assert.equal(failures[1].error_message, "invalid input");
  });
});

// ── Submit gating ───────────────────────────────────────────────────────────

describe("knowledgeConsolidationBatch — submitKnowledgeConsolidationBatch flag gating", () => {
  it("throws when KNOWLEDGE_CONSOLIDATION_BATCH is off", async () => {
    await assert.rejects(
      () => submitKnowledgeConsolidationBatch([group("a", [entry("k1", "t", "s"), entry("k2", "t", "s"), entry("k3", "t", "s")])]),
      /disabled/i,
    );
  });

  it("throws when BATCH_API_ENABLED is off", async () => {
    process.env.KNOWLEDGE_CONSOLIDATION_BATCH = "true";
    // BATCH_API_ENABLED still unset
    await assert.rejects(
      () => submitKnowledgeConsolidationBatch([group("a", [entry("k1", "t", "s"), entry("k2", "t", "s"), entry("k3", "t", "s")])]),
      /disabled/i,
    );
  });
});
