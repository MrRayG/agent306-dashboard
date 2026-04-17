/**
 * researchScannerBatch — PR T tests.
 *
 * Verifies:
 *  - The dual flag-gate (RESEARCH_SCAN_BATCH + BATCH_API_ENABLED).
 *  - buildGoalScanRequests: pure, skips invalid goals, collision-safe IDs,
 *    embeds shared prompt strings.
 *  - parseGoalIdFromRequestId round-trips the id, including collision case.
 *  - parseGoalScanResults: well-formed map, stale drop, invalid shape drop,
 *    priority defaulting, 2-topic cap.
 *  - submitGoalScanBatch throws when either flag is off (no silent network).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = ["RESEARCH_SCAN_BATCH", "BATCH_API_ENABLED"];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearFlags() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const mod = await import("../researchScannerBatch.js");
const {
  isResearchScanBatchEnabled,
  shouldUseResearchScanBatch,
  buildGoalScanRequests,
  parseGoalIdFromRequestId,
  parseGoalScanResults,
  submitGoalScanBatch,
  GOAL_SCAN_SYSTEM_PROMPT,
  buildGoalScanUserPrompt,
} = mod;

function g(
  id: string,
  title: string = "A goal",
  description: string = "Some description",
  category: string = "ai",
  milestones?: string[],
) {
  return { id, title, description, category, milestones };
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

describe("researchScannerBatch — feature flags", () => {
  it("isResearchScanBatchEnabled is false when unset", () => {
    assert.equal(isResearchScanBatchEnabled(), false);
  });

  it("isResearchScanBatchEnabled accepts true/1/yes case-insensitive", () => {
    for (const v of ["true", "TRUE", "1", "yes", "YES"]) {
      process.env.RESEARCH_SCAN_BATCH = v;
      assert.equal(isResearchScanBatchEnabled(), true, `value ${v} should enable`);
    }
    process.env.RESEARCH_SCAN_BATCH = "false";
    assert.equal(isResearchScanBatchEnabled(), false);
  });

  it("shouldUseResearchScanBatch requires BOTH flags", () => {
    process.env.RESEARCH_SCAN_BATCH = "true";
    assert.equal(shouldUseResearchScanBatch(), false, "missing BATCH_API_ENABLED");

    delete process.env.RESEARCH_SCAN_BATCH;
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseResearchScanBatch(), false, "missing RESEARCH_SCAN_BATCH");

    process.env.RESEARCH_SCAN_BATCH = "true";
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseResearchScanBatch(), true);
  });
});

// ── Prompt builders ─────────────────────────────────────────────────────────

describe("researchScannerBatch — prompt builders", () => {
  it("GOAL_SCAN_SYSTEM_PROMPT has the sovereign-agent framing", () => {
    assert.ok(GOAL_SCAN_SYSTEM_PROMPT.includes("Agent 306"));
    assert.ok(GOAL_SCAN_SYSTEM_PROMPT.includes("Sovereign"));
    assert.ok(GOAL_SCAN_SYSTEM_PROMPT.includes("Return valid JSON only"));
  });

  it("buildGoalScanUserPrompt embeds goal metadata", () => {
    const goal = g("x", "Master Rust async", "Deeply understand tokio and friends", "programming", ["book X", "project Y"]);
    const prompt = buildGoalScanUserPrompt(goal, []);
    assert.ok(prompt.includes("Master Rust async"));
    assert.ok(prompt.includes("programming"));
    assert.ok(prompt.includes("Deeply understand tokio"));
    assert.ok(prompt.includes("book X"));
    assert.ok(prompt.includes("book X, project Y"), "milestones should be comma-joined");
  });

  it("buildGoalScanUserPrompt shows 'None' when no existing topics", () => {
    const p = buildGoalScanUserPrompt(g("a"), []);
    assert.ok(p.includes("None"));
  });

  it("buildGoalScanUserPrompt bullet-lists existing topics (capped at 10)", () => {
    const many = Array.from({ length: 15 }, (_, i) => `topic${i}`);
    const p = buildGoalScanUserPrompt(g("a"), many);
    assert.ok(p.includes("• topic0"));
    assert.ok(p.includes("• topic9"));
    assert.ok(!p.includes("• topic10"), "should cap at 10");
    assert.ok(!p.includes("• topic14"));
  });
});

// ── Request building ────────────────────────────────────────────────────────

describe("researchScannerBatch — buildGoalScanRequests", () => {
  it("produces one request per valid goal", () => {
    const reqs = buildGoalScanRequests([g("id1"), g("id2")], []);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].batch_request_id, "goalscan_id1");
    assert.equal(reqs[1].batch_request_id, "goalscan_id2");
    assert.equal(reqs[0].temperature, 0.75);
    assert.equal(reqs[0].max_tokens, 800);
  });

  it("skips goals missing id/title/description", () => {
    const broken = [
      { id: "", title: "t", description: "d", category: "c" },
      { id: "ok", title: "", description: "d", category: "c" },
      { id: "ok2", title: "t", description: "", category: "c" },
      g("good"),
    ];
    const reqs = buildGoalScanRequests(broken as any, []);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].batch_request_id, "goalscan_good");
  });

  it("handles duplicate goal ids with a numeric suffix", () => {
    const reqs = buildGoalScanRequests([g("dup"), g("dup")], []);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].batch_request_id, "goalscan_dup");
    assert.match(reqs[1].batch_request_id, /^goalscan_dup_\d+$/);
  });

  it("embeds the shared system + user prompts", () => {
    const reqs = buildGoalScanRequests([g("x", "T", "D", "CAT")], []);
    assert.equal(reqs[0].messages[0].role, "system");
    assert.equal(reqs[0].messages[0].content, GOAL_SCAN_SYSTEM_PROMPT);
    assert.equal(reqs[0].messages[1].role, "user");
    assert.ok(reqs[0].messages[1].content.includes("T"));
    assert.ok(reqs[0].messages[1].content.includes("CAT"));
  });

  it("is pure — does not require flags", () => {
    const reqs = buildGoalScanRequests([g("pure")], []);
    assert.equal(reqs.length, 1);
  });
});

// ── Request id round-trip ───────────────────────────────────────────────────

describe("researchScannerBatch — parseGoalIdFromRequestId", () => {
  it("round-trips a simple id", () => {
    assert.equal(parseGoalIdFromRequestId("goalscan_abc123"), "abc123");
  });

  it("strips the collision-suffix", () => {
    assert.equal(parseGoalIdFromRequestId("goalscan_dup_7"), "dup");
  });

  it("returns null for unrelated ids", () => {
    assert.equal(parseGoalIdFromRequestId("kgconn_x"), null);
    assert.equal(parseGoalIdFromRequestId(""), null);
    assert.equal(parseGoalIdFromRequestId("goalscan_"), null);
  });
});

// ── Result parsing ──────────────────────────────────────────────────────────

describe("researchScannerBatch — parseGoalScanResults", () => {
  it("returns proposals keyed by goal.id for well-formed responses", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "goalscan_g1",
          content: JSON.stringify({
            topics: [
              { topic: "topic A", description: "desc A", priority: "high" },
              { topic: "topic B", description: "desc B", priority: "low" },
            ],
          }),
        },
      ],
      failed: [],
    };
    const { proposals } = parseGoalScanResults(page as any, new Set(["g1"]));
    assert.equal(proposals.size, 1);
    const ts = proposals.get("g1")!;
    assert.equal(ts.length, 2);
    assert.equal(ts[0].topic, "topic A");
    assert.equal(ts[1].priority, "low");
  });

  it("caps proposals at 2 per goal (matches sync .slice(0, 2))", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "goalscan_many",
          content: JSON.stringify({
            topics: [
              { topic: "t1", description: "d1" },
              { topic: "t2", description: "d2" },
              { topic: "t3", description: "d3" },
              { topic: "t4", description: "d4" },
            ],
          }),
        },
      ],
      failed: [],
    };
    const { proposals } = parseGoalScanResults(page as any, new Set(["many"]));
    assert.equal(proposals.get("many")!.length, 2);
  });

  it("drops proposals for stale goalIds", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "goalscan_stale",
          content: JSON.stringify({
            topics: [{ topic: "t", description: "d" }],
          }),
        },
      ],
      failed: [],
    };
    const { proposals } = parseGoalScanResults(page as any, new Set());
    assert.equal(proposals.size, 0);
  });

  it("drops invalid topic entries (missing topic/description/wrong type)", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "goalscan_bad",
          content: JSON.stringify({
            topics: [
              { topic: "", description: "d" },
              { topic: "t", description: "" },
              { description: "missing topic" },
              { topic: "missing desc" },
              "not an object",
              null,
            ],
          }),
        },
      ],
      failed: [],
    };
    const { proposals } = parseGoalScanResults(page as any, new Set(["bad"]));
    assert.equal(proposals.size, 0, "all entries invalid → no proposals");
  });

  it("defaults priority to 'medium' when invalid or missing", () => {
    const page = {
      succeeded: [
        {
          batch_request_id: "goalscan_pri",
          content: JSON.stringify({
            topics: [
              { topic: "t1", description: "d1" }, // no priority
              { topic: "t2", description: "d2", priority: "urgent" }, // invalid
            ],
          }),
        },
      ],
      failed: [],
    };
    const { proposals } = parseGoalScanResults(page as any, new Set(["pri"]));
    const ts = proposals.get("pri")!;
    assert.equal(ts[0].priority, "medium");
    assert.equal(ts[1].priority, "medium");
  });

  it("drops results with unparseable JSON", () => {
    const page = {
      succeeded: [
        { batch_request_id: "goalscan_bad", content: "not json at all" },
      ],
      failed: [],
    };
    const { proposals } = parseGoalScanResults(page as any, new Set(["bad"]));
    assert.equal(proposals.size, 0);
  });

  it("surfaces failures verbatim", () => {
    const page = {
      succeeded: [],
      failed: [
        { batch_request_id: "goalscan_x", error_message: "rate limit" },
      ],
    };
    const { failures } = parseGoalScanResults(page as any, new Set());
    assert.equal(failures.length, 1);
    assert.equal(failures[0].error_message, "rate limit");
  });
});

// ── Submit gating ───────────────────────────────────────────────────────────

describe("researchScannerBatch — submitGoalScanBatch flag gating", () => {
  it("throws when RESEARCH_SCAN_BATCH is off", async () => {
    await assert.rejects(
      () => submitGoalScanBatch([g("id")], []),
      /disabled/i,
    );
  });

  it("throws when BATCH_API_ENABLED is off", async () => {
    process.env.RESEARCH_SCAN_BATCH = "true";
    await assert.rejects(
      () => submitGoalScanBatch([g("id")], []),
      /disabled/i,
    );
  });
});
