/**
 * reflectionBatch — PR V tests.
 *
 * Verifies:
 *  - The dual flag-gate (REFLECTION_BATCH + BATCH_API_ENABLED)
 *    correctly gates shouldUseReflectionBatch().
 *  - hashTweetUrl is deterministic and 16-char hex.
 *  - buildReflectionRequests is pure, deterministic, respects required
 *    fields, and generates unique batch_request_ids.
 *  - parseTweetHashFromRequestId round-trips the hash (including with
 *    a collision suffix) and rejects unrelated ids.
 *  - parseReflectionResults drops stale / malformed results, surfaces
 *    failures, and correctly handles edge cases (empty whyWorked,
 *    non-array patterns, empty ruleCandidate).
 *  - submitReflectionBatch throws when flags are off (no silent network).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// Save+restore env keys we toggle.
const ENV_KEYS = [
  "REFLECTION_BATCH",
  "BATCH_API_ENABLED",
];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearFlags() {
  for (const k of ENV_KEYS) delete process.env[k];
}

const mod = await import("../reflectionBatch.js");
const {
  isReflectionBatchEnabled,
  shouldUseReflectionBatch,
  buildReflectionRequests,
  parseTweetHashFromRequestId,
  parseReflectionResults,
  submitReflectionBatch,
  hashTweetUrl,
} = mod;

// ── Fixtures ────────────────────────────────────────────────────────────────

function lesson(url: string, text: string, score = 5) {
  return {
    tweetUrl: url,
    tweetText: text,
    engagement: { likes: 10, replies: 1, retweets: 2, bookmarks: 0, impressions: 1000 },
    score,
    signals: { twitter: 0.5 },
  };
}

const STABLE_PROMPTS = {
  systemPrompt: "SYSTEM_PROMPT",
  buildUserPrompt: (l: any) => `USER:${l.tweetUrl}`,
};

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

describe("reflectionBatch — feature flags", () => {
  it("isReflectionBatchEnabled is false when unset", () => {
    assert.equal(isReflectionBatchEnabled(), false);
  });

  it("isReflectionBatchEnabled accepts true/1/yes case-insensitive", () => {
    for (const v of ["true", "TRUE", "1", "yes", "YES"]) {
      process.env.REFLECTION_BATCH = v;
      assert.equal(isReflectionBatchEnabled(), true, `value ${v} should enable`);
    }
    process.env.REFLECTION_BATCH = "false";
    assert.equal(isReflectionBatchEnabled(), false);
  });

  it("shouldUseReflectionBatch requires BOTH flags", () => {
    process.env.REFLECTION_BATCH = "true";
    assert.equal(shouldUseReflectionBatch(), false, "missing BATCH_API_ENABLED");

    delete process.env.REFLECTION_BATCH;
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseReflectionBatch(), false, "missing REFLECTION_BATCH");

    process.env.REFLECTION_BATCH = "true";
    process.env.BATCH_API_ENABLED = "true";
    assert.equal(shouldUseReflectionBatch(), true);
  });
});

// ── hashTweetUrl ────────────────────────────────────────────────────────────

describe("reflectionBatch — hashTweetUrl", () => {
  it("returns a 16-char lowercase hex string", () => {
    const h = hashTweetUrl("https://twitter.com/Agent306/status/12345");
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    const url = "https://x.com/u/status/abc";
    assert.equal(hashTweetUrl(url), hashTweetUrl(url));
  });

  it("produces different hashes for different inputs", () => {
    const a = hashTweetUrl("https://x.com/u/status/1");
    const b = hashTweetUrl("https://x.com/u/status/2");
    assert.notEqual(a, b);
  });
});

// ── Request building ────────────────────────────────────────────────────────

describe("reflectionBatch — buildReflectionRequests", () => {
  it("produces one request per lesson with the correct id shape and body", () => {
    const reqs = buildReflectionRequests(
      [lesson("https://x.com/u/status/1", "post A"), lesson("https://x.com/u/status/2", "post B")],
      STABLE_PROMPTS,
    );
    assert.equal(reqs.length, 2);

    for (const r of reqs) {
      assert.match(r.batch_request_id, /^reflect_[0-9a-f]{16}$/);
      assert.equal(r.messages.length, 2);
      assert.equal(r.messages[0].role, "system");
      assert.equal(r.messages[0].content, "SYSTEM_PROMPT");
      assert.equal(r.messages[1].role, "user");
      assert.equal(r.temperature, 0.3);
      assert.equal(r.max_tokens, 1500);
    }

    // Different inputs → different ids
    assert.notEqual(reqs[0].batch_request_id, reqs[1].batch_request_id);
  });

  it("user prompt is the caller-provided buildUserPrompt output", () => {
    const reqs = buildReflectionRequests([lesson("https://x.com/u/status/xy", "t")], STABLE_PROMPTS);
    assert.equal(reqs[0].messages[1].content, "USER:https://x.com/u/status/xy");
  });

  it("skips lessons missing tweetUrl or tweetText", () => {
    const broken1 = { ...lesson("", "has text"), tweetUrl: "" };
    const broken2 = { ...lesson("https://x.com/u/status/ok", ""), tweetText: "" };
    const ok = lesson("https://x.com/u/status/good", "ok");
    const reqs = buildReflectionRequests([broken1 as any, broken2 as any, ok], STABLE_PROMPTS);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].batch_request_id, `reflect_${hashTweetUrl(ok.tweetUrl)}`);
  });

  it("handles duplicate tweetUrls by appending a numeric collision suffix", () => {
    const url = "https://x.com/u/status/dup";
    const reqs = buildReflectionRequests(
      [lesson(url, "first"), lesson(url, "second")],
      STABLE_PROMPTS,
    );
    assert.equal(reqs.length, 2);
    assert.notEqual(reqs[0].batch_request_id, reqs[1].batch_request_id, "ids must be unique");
    assert.equal(reqs[0].batch_request_id, `reflect_${hashTweetUrl(url)}`);
    assert.match(reqs[1].batch_request_id, /^reflect_[0-9a-f]{16}_\d+$/);
  });

  it("is pure — does not require flags or network", () => {
    // Flags cleared by beforeEach
    const reqs = buildReflectionRequests([lesson("https://x.com/u/status/p", "t")], STABLE_PROMPTS);
    assert.equal(reqs.length, 1);
  });
});

// ── parseTweetHashFromRequestId ─────────────────────────────────────────────

describe("reflectionBatch — parseTweetHashFromRequestId", () => {
  it("round-trips a simple id", () => {
    const h = hashTweetUrl("https://x.com/u/status/rt");
    assert.equal(parseTweetHashFromRequestId(`reflect_${h}`), h);
  });

  it("strips the collision-suffix when present", () => {
    const h = hashTweetUrl("https://x.com/u/status/rt2");
    assert.equal(parseTweetHashFromRequestId(`reflect_${h}_7`), h);
  });

  it("returns null for unrelated ids", () => {
    assert.equal(parseTweetHashFromRequestId("kgconn_x"), null);
    assert.equal(parseTweetHashFromRequestId("hypmerge_x"), null);
    assert.equal(parseTweetHashFromRequestId("kbcons_x"), null);
    assert.equal(parseTweetHashFromRequestId(""), null);
    assert.equal(parseTweetHashFromRequestId("reflect_"), null);
  });

  it("rejects malformed hashes (wrong length or non-hex)", () => {
    assert.equal(parseTweetHashFromRequestId("reflect_notlongenough"), null);
    assert.equal(parseTweetHashFromRequestId("reflect_ZZZZZZZZZZZZZZZZ"), null); // 16 chars but non-hex
  });

  it("rejects non-numeric collision suffixes", () => {
    const h = hashTweetUrl("https://x.com/u/status/rt3");
    assert.equal(parseTweetHashFromRequestId(`reflect_${h}_abc`), null);
  });
});

// ── Result parsing ──────────────────────────────────────────────────────────

function buildLessonsByHash(lessons: any[]): Map<string, any> {
  const m = new Map<string, any>();
  for (const l of lessons) m.set(hashTweetUrl(l.tweetUrl), l);
  return m;
}

describe("reflectionBatch — parseReflectionResults", () => {
  it("returns analyses keyed by tweetUrl for well-formed responses", () => {
    const l1 = lesson("https://x.com/u/status/a", "post A");
    const l2 = lesson("https://x.com/u/status/b", "post B");
    const byHash = buildLessonsByHash([l1, l2]);
    const page = {
      succeeded: [
        {
          batch_request_id: `reflect_${hashTweetUrl(l1.tweetUrl)}`,
          content: JSON.stringify({
            whyWorked: "hook was strong",
            patterns: ["specific numbers", "short hook"],
            styleNote: "brisk",
            ruleCandidate: "lead with numbers",
          }),
        },
        {
          batch_request_id: `reflect_${hashTweetUrl(l2.tweetUrl)}`,
          content: JSON.stringify({
            whyWorked: "too vague",
            patterns: [],
            styleNote: "",
            ruleCandidate: null,
          }),
        },
      ],
      failed: [],
    };
    const { analyses, failures } = parseReflectionResults(page as any, byHash);
    assert.equal(analyses.size, 2);
    assert.equal(analyses.get(l1.tweetUrl)?.whyWorked, "hook was strong");
    assert.deepEqual(analyses.get(l1.tweetUrl)?.patterns, ["specific numbers", "short hook"]);
    assert.equal(analyses.get(l1.tweetUrl)?.ruleCandidate, "lead with numbers");
    assert.equal(analyses.get(l2.tweetUrl)?.whyWorked, "too vague");
    assert.equal(analyses.get(l2.tweetUrl)?.ruleCandidate, null);
    assert.equal(failures.length, 0);
  });

  it("drops results whose hash is no longer in the lesson lookup (stale)", () => {
    const byHash = new Map(); // empty — everything is stale
    const page = {
      succeeded: [
        {
          batch_request_id: `reflect_${hashTweetUrl("https://x.com/u/status/stale")}`,
          content: JSON.stringify({ whyWorked: "x", patterns: [] }),
        },
      ],
      failed: [],
    };
    const { analyses } = parseReflectionResults(page as any, byHash);
    assert.equal(analyses.size, 0);
  });

  it("drops results with unparseable JSON or empty whyWorked", () => {
    const l1 = lesson("https://x.com/u/status/a", "t");
    const l2 = lesson("https://x.com/u/status/b", "t");
    const l3 = lesson("https://x.com/u/status/c", "t");
    const byHash = buildLessonsByHash([l1, l2, l3]);
    const page = {
      succeeded: [
        { batch_request_id: `reflect_${hashTweetUrl(l1.tweetUrl)}`, content: "not json at all" },
        { batch_request_id: `reflect_${hashTweetUrl(l2.tweetUrl)}`, content: JSON.stringify({ whyWorked: "" }) },
        { batch_request_id: `reflect_${hashTweetUrl(l3.tweetUrl)}`, content: JSON.stringify({ whyWorked: "   " }) },
      ],
      failed: [],
    };
    const { analyses } = parseReflectionResults(page as any, byHash);
    assert.equal(analyses.size, 0, "all three should be rejected");
  });

  it("filters non-string entries out of the patterns array", () => {
    const l1 = lesson("https://x.com/u/status/p", "t");
    const byHash = buildLessonsByHash([l1]);
    const page = {
      succeeded: [{
        batch_request_id: `reflect_${hashTweetUrl(l1.tweetUrl)}`,
        content: JSON.stringify({ whyWorked: "good", patterns: ["a", 42, null, "b", "", "c"] }),
      }],
      failed: [],
    };
    const { analyses } = parseReflectionResults(page as any, byHash);
    assert.deepEqual(analyses.get(l1.tweetUrl)?.patterns, ["a", "b", "c"]);
  });

  it("coerces non-array patterns to an empty array (no throw)", () => {
    const l1 = lesson("https://x.com/u/status/np", "t");
    const byHash = buildLessonsByHash([l1]);
    const page = {
      succeeded: [{
        batch_request_id: `reflect_${hashTweetUrl(l1.tweetUrl)}`,
        content: JSON.stringify({ whyWorked: "good", patterns: "not an array" }),
      }],
      failed: [],
    };
    const { analyses } = parseReflectionResults(page as any, byHash);
    assert.deepEqual(analyses.get(l1.tweetUrl)?.patterns, []);
  });

  it("treats empty-string ruleCandidate as null", () => {
    const l1 = lesson("https://x.com/u/status/rc", "t");
    const byHash = buildLessonsByHash([l1]);
    const page = {
      succeeded: [{
        batch_request_id: `reflect_${hashTweetUrl(l1.tweetUrl)}`,
        content: JSON.stringify({ whyWorked: "good", ruleCandidate: "   " }),
      }],
      failed: [],
    };
    const { analyses } = parseReflectionResults(page as any, byHash);
    assert.equal(analyses.get(l1.tweetUrl)?.ruleCandidate, null);
  });

  it("surfaces failures verbatim", () => {
    const page = {
      succeeded: [],
      failed: [
        { batch_request_id: "reflect_abc0000000000000", error_message: "rate limit" },
        { batch_request_id: "reflect_def0000000000000", error_message: "invalid input" },
      ],
    };
    const { failures } = parseReflectionResults(page as any, new Map());
    assert.equal(failures.length, 2);
    assert.equal(failures[0].error_message, "rate limit");
    assert.equal(failures[1].error_message, "invalid input");
  });
});

// ── Submit gating ───────────────────────────────────────────────────────────

describe("reflectionBatch — submitReflectionBatch flag gating", () => {
  it("throws when REFLECTION_BATCH is off", async () => {
    await assert.rejects(
      () => submitReflectionBatch([lesson("https://x.com/u/status/g", "t")], STABLE_PROMPTS),
      /disabled/i,
    );
  });

  it("throws when BATCH_API_ENABLED is off", async () => {
    process.env.REFLECTION_BATCH = "true";
    // BATCH_API_ENABLED still unset
    await assert.rejects(
      () => submitReflectionBatch([lesson("https://x.com/u/status/g", "t")], STABLE_PROMPTS),
      /disabled/i,
    );
  });
});
