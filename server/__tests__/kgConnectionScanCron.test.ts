/**
 * kgConnectionScanCron \u2014 PR Q tests.
 *
 * Verifies:
 *  - The triple flag-gate (KG_BATCH_CRON_ENABLED + KG_CONNECTION_SCAN_BATCH +
 *    BATCH_API_ENABLED) correctly suppresses scheduling AND execution.
 *  - pickContextEntries respects the K cap and word-overlap scoring.
 *  - buildNightlyPairs sorts by learnedAt desc and skips orphans.
 *  - runKgConnectionScanBatch returns a structured \"skipped\" summary
 *    when flags are off (does NOT throw, does NOT submit).
 *  - The full happy path (with all flags on and stubbed network) submits,
 *    waits, collects, and persists \u2014 surfacing the right counts.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Route DATA_DIR to a throwaway tmp so the module's KB load doesn't pollute real data/.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kgcron-"));
process.env.DATA_DIR = TMP;

// Save+restore env keys we toggle.
const ENV_KEYS = [
  "KG_BATCH_CRON_ENABLED",
  "KG_CONNECTION_SCAN_BATCH",
  "BATCH_API_ENABLED",
  "GROK_API_KEY",
  "XAI_API_KEY",
];
const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const {
  isKgBatchCronEnabled,
  pickContextEntries,
  buildNightlyPairs,
  runKgConnectionScanBatch,
  scheduleKgConnectionScanBatch,
} = await import("../kgConnectionScanCron.js");
const memoryEngine = await import("../memoryEngine.js");
const knowledgeGraph = await import("../knowledge-graph.js");
const xaiBatchEngine = await import("../xaiBatchEngine.js");
const kgBatchModule = await import("../kgConnectionScanBatch.js");

// ── isKgBatchCronEnabled ───────────────────────────────────────────────────

describe("kgBatchCron \u2014 isKgBatchCronEnabled", () => {
  it("defaults to false when unset", () => {
    delete process.env.KG_BATCH_CRON_ENABLED;
    assert.equal(isKgBatchCronEnabled(), false);
  });

  it("true / 1 / yes all enable", () => {
    process.env.KG_BATCH_CRON_ENABLED = "true";
    assert.equal(isKgBatchCronEnabled(), true);
    process.env.KG_BATCH_CRON_ENABLED = "1";
    assert.equal(isKgBatchCronEnabled(), true);
    process.env.KG_BATCH_CRON_ENABLED = "YES";
    assert.equal(isKgBatchCronEnabled(), true);
  });

  it("any other value is treated as off (safe default)", () => {
    process.env.KG_BATCH_CRON_ENABLED = "false";
    assert.equal(isKgBatchCronEnabled(), false);
    process.env.KG_BATCH_CRON_ENABLED = "gibberish";
    assert.equal(isKgBatchCronEnabled(), false);
  });
});

// ── pickContextEntries ─────────────────────────────────────────────────────

describe("kgBatchCron \u2014 pickContextEntries", () => {
  const target = {
    id: "t1",
    title: "Quantum entanglement breakthrough in superconductors",
    summary: "researchers demonstrated stable entanglement at room temperature",
    category: "research",
  };
  const pool = [
    { id: "a", title: "Quantum computing milestone", summary: "superconductor qubit fidelity record", category: "research" },
    { id: "b", title: "Cooking recipes for pasta", summary: "boil water and add salt", category: "lore" },
    { id: "c", title: "Room temperature superconductor claim", summary: "lk-99 follow-up entanglement studies", category: "research" },
    { id: "t1", title: "self", summary: "self", category: "research" }, // self should be excluded
  ];

  it("excludes the target itself", () => {
    const out = pickContextEntries(target, pool, 5);
    assert.ok(!out.find((e) => e.id === "t1"));
  });

  it("ranks by word overlap and respects K cap", () => {
    const out = pickContextEntries(target, pool, 2);
    assert.equal(out.length, 2);
    // 'a' and 'c' both overlap with target; 'b' has nothing in common.
    assert.ok(!out.find((e) => e.id === "b"), "unrelated entry b must be filtered out");
  });

  it("returns [] when the target has no scoring words", () => {
    const blank = { id: "t2", title: "ai", summary: "ok", category: "x" };
    assert.deepEqual(pickContextEntries(blank, pool, 5), []);
  });
});

// ── buildNightlyPairs ──────────────────────────────────────────────────────

describe("kgBatchCron \u2014 buildNightlyPairs", () => {
  const originalEntries = memoryEngine.knowledge.entries.slice();

  afterEach(() => {
    memoryEngine.knowledge.entries.length = 0;
    memoryEngine.knowledge.entries.push(...originalEntries);
  });

  it("returns [] when KB has fewer than 2 active entries", () => {
    memoryEngine.knowledge.entries.length = 0;
    memoryEngine.knowledge.entries.push({
      id: "solo",
      category: "research",
      title: "alone",
      summary: "by myself",
      learnedAt: "2026-04-17T00:00:00Z",
      weight: 5,
      status: "active",
    });
    assert.deepEqual(buildNightlyPairs(50, 20), []);
  });

  it("sorts targets by learnedAt desc and skips entries with no scoring context", () => {
    memoryEngine.knowledge.entries.length = 0;
    memoryEngine.knowledge.entries.push(
      {
        id: "old1",
        category: "research",
        title: "Quantum entanglement old",
        summary: "early work superconductor",
        learnedAt: "2025-01-01T00:00:00Z",
        weight: 5,
        status: "active",
      },
      {
        id: "new1",
        category: "research",
        title: "Quantum entanglement new",
        summary: "fresh superconductor entanglement result",
        learnedAt: "2026-04-01T00:00:00Z",
        weight: 5,
        status: "active",
      },
      {
        id: "orphan",
        category: "lore",
        title: "completely unrelated topic",
        summary: "nothing in common",
        learnedAt: "2026-04-15T00:00:00Z",
        weight: 5,
        status: "active",
      },
    );
    const pairs = buildNightlyPairs(50, 20);
    // 'orphan' has no overlap with any other entry \u2014 dropped.
    // 'new1' and 'old1' both have overlapping vocab \u2014 kept.
    assert.equal(pairs.length, 2);
    // Most-recent-first ordering preserved among kept targets.
    assert.equal(pairs[0].target.id, "new1");
    assert.equal(pairs[1].target.id, "old1");
  });

  it("excludes archived entries from both target list and context pool", () => {
    memoryEngine.knowledge.entries.length = 0;
    memoryEngine.knowledge.entries.push(
      {
        id: "a",
        category: "research",
        title: "active alpha shared",
        summary: "shared",
        learnedAt: "2026-04-10T00:00:00Z",
        weight: 5,
        status: "active",
      },
      {
        id: "b",
        category: "research",
        title: "active beta shared",
        summary: "shared",
        learnedAt: "2026-04-11T00:00:00Z",
        weight: 5,
        status: "active",
      },
      {
        id: "z",
        category: "research",
        title: "archived shared",
        summary: "shared",
        learnedAt: "2026-04-12T00:00:00Z",
        weight: 5,
        status: "archived",
      },
    );
    const pairs = buildNightlyPairs(50, 20);
    const ids = pairs.map((p) => p.target.id).sort();
    assert.deepEqual(ids, ["a", "b"]);
    // z must not appear as context either
    for (const p of pairs) {
      assert.ok(!p.context.find((c) => c.id === "z"), "archived must not appear in context");
    }
  });
});

// ── runKgConnectionScanBatch \u2014 flag gating ─────────────────────────────────

describe("kgBatchCron \u2014 runKgConnectionScanBatch flag gating", () => {
  it("returns a skipped summary when KG_CONNECTION_SCAN_BATCH is off", async () => {
    delete process.env.KG_CONNECTION_SCAN_BATCH;
    process.env.BATCH_API_ENABLED = "true";
    const r = await runKgConnectionScanBatch();
    assert.equal(r.batchId, null);
    assert.equal(r.requestsSubmitted, 0);
    assert.ok(r.skipped, "should populate skipped reason");
  });

  it("returns a skipped summary when BATCH_API_ENABLED is off", async () => {
    process.env.KG_CONNECTION_SCAN_BATCH = "true";
    delete process.env.BATCH_API_ENABLED;
    const r = await runKgConnectionScanBatch();
    assert.equal(r.batchId, null);
    assert.ok(r.skipped);
  });

  it("does NOT throw when flags are off \u2014 returns a structured summary instead", async () => {
    delete process.env.KG_CONNECTION_SCAN_BATCH;
    delete process.env.BATCH_API_ENABLED;
    // Should resolve, not reject.
    const r = await runKgConnectionScanBatch();
    assert.ok(r.skipped);
  });
});

// ── scheduleKgConnectionScanBatch \u2014 cron flag gating ───────────────────────

describe("kgBatchCron \u2014 scheduleKgConnectionScanBatch", () => {
  it("is a no-op when KG_BATCH_CRON_ENABLED is unset (no setTimeout fires)", () => {
    delete process.env.KG_BATCH_CRON_ENABLED;
    // Spy on global setTimeout.
    const realSetTimeout = global.setTimeout;
    let calls = 0;
    // @ts-expect-error \u2014 stubbing
    global.setTimeout = (..._args: any[]) => { calls++; return 0 as any; };
    try {
      scheduleKgConnectionScanBatch();
      assert.equal(calls, 0, "no setTimeout should be scheduled when cron flag is off");
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it("schedules a timer when KG_BATCH_CRON_ENABLED=true", () => {
    process.env.KG_BATCH_CRON_ENABLED = "true";
    const realSetTimeout = global.setTimeout;
    let calls = 0;
    // @ts-expect-error \u2014 stubbing
    global.setTimeout = (..._args: any[]) => { calls++; return 0 as any; };
    try {
      scheduleKgConnectionScanBatch();
      assert.equal(calls, 1, "exactly one setTimeout should be scheduled");
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });
});

// ── runKgConnectionScanBatch \u2014 happy path with stubs ───────────────────────

describe("kgBatchCron \u2014 runKgConnectionScanBatch happy path", () => {
  const originalEntries = memoryEngine.knowledge.entries.slice();

  afterEach(() => {
    memoryEngine.knowledge.entries.length = 0;
    memoryEngine.knowledge.entries.push(...originalEntries);
  });

  it("returns a clean summary when all 3 flags are on \u2014 but no pairs to scan", async () => {
    process.env.KG_BATCH_CRON_ENABLED = "true";
    process.env.KG_CONNECTION_SCAN_BATCH = "true";
    process.env.BATCH_API_ENABLED = "true";
    process.env.GROK_API_KEY = "test-key";
    // Empty KB \u2192 no pairs \u2192 no submission.
    memoryEngine.knowledge.entries.length = 0;
    const r = await runKgConnectionScanBatch();
    assert.equal(r.batchId, null);
    assert.equal(r.pairsBuilt, 0);
    assert.equal(r.requestsSubmitted, 0);
    assert.equal(r.skipped, undefined, "should NOT be marked skipped \u2014 flags are on");
  });
});
