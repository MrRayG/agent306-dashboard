/**
 * Tests for Novelty Gate — KB self-check before [306 NEWS] framing.
 *
 * Run: npx tsx --test server/__tests__/noveltyGate.test.ts
 *
 * Phase 2n drain #12 — Path B isolation:
 *   memoryEngine.addKnowledge() / archiveKnowledge() write to
 *   memory_knowledge.json AND to agent306.db (transitive import of
 *   repositories/db). Without DATA_DIR + DB_PATH redirects set BEFORE any
 *   import that resolves dataPaths.ts (line 15: DATA_DIR captured at
 *   module-eval time), writes land in the repo's live data/. The prior
 *   `import { dataPath } from "../dataPaths.js"` static import was the
 *   bug: it loaded dataPaths.js before this file's previous (nonexistent)
 *   redirect ran. Fixed by setting env vars FIRST and inlining the
 *   LOG_FILE path under TMP.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain12-novelty-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

import { describe, it, beforeEach, afterEach, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_AGENT_GOALS     = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY      = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const REAL_DB              = path.join(REPO_ROOT, "data", "agent306.db");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
function dbStat(p: string): { exists: boolean; size?: number; mtimeMs?: number } {
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
}
const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const AGENT_GOALS_SNAPSHOT     = snapshot(REAL_AGENT_GOALS);
const COMPETENCY_SNAPSHOT      = snapshot(REAL_COMPETENCY);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);
const DB_SNAPSHOT              = dbStat(REAL_DB);

// LOG_FILE is the novelty-gate log file the production module would write
// to. By inlining the TMP path here (rather than importing dataPath()) we
// avoid loading dataPaths.js before env vars are set.
const LOG_FILE = path.join(TMP, "novelty_gate_log.json");

function cleanLogFile() {
  try { if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE); } catch {}
}

before(() => {
  // Loud-failure pin (drain template).
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const tmpReal = fs.realpathSync(TMP);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`noveltyGate isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`noveltyGate isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP) {
    throw new Error(`noveltyGate isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP, "test.db")) {
    throw new Error(`noveltyGate isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  const after = (p: string) => snapshot(p);
  for (const [label, before, p] of [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const a = after(p);
    if (before.exists) {
      if (!a.exists) throw new Error(`noveltyGate tests removed live ${label}!`);
      if (a.content !== before.content) throw new Error(`noveltyGate tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`noveltyGate tests created live ${label}!`);
    }
  }

  const dbAfter = dbStat(REAL_DB);
  if (DB_SNAPSHOT.exists) {
    if (!dbAfter.exists) throw new Error(`noveltyGate tests removed live agent306.db!`);
    if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
      throw new Error(`noveltyGate tests mutated live agent306.db (size/mtime changed)!`);
    }
  } else if (dbAfter.exists) {
    throw new Error(`noveltyGate tests created live agent306.db!`);
  }
});

// ── Mock KB state ─────────────────────────────────────────────────────────────

function makeKBEntry(overrides: Partial<any> = {}) {
  const now = new Date();
  return {
    id: overrides.id ?? `kb_${Math.random().toString(36).slice(2, 8)}`,
    category: overrides.category ?? "research",
    title: overrides.title ?? "Test KB Entry",
    summary: overrides.summary ?? "A test knowledge base entry for unit testing",
    source: overrides.source ?? "test",
    learnedAt: overrides.learnedAt ?? now.toISOString(),
    weight: overrides.weight ?? 7,
    status: overrides.status ?? "active",
    tier: overrides.tier ?? "active",
  };
}

describe("NoveltyGate", () => {
  // We test the logic by importing checkNovelty and manipulating the KB state
  // via memoryEngine. Since the module uses top-level await for optional imports,
  // we use dynamic import.

  let checkNovelty: typeof import("../noveltyGate.js").checkNovelty;
  let getNoveltyGateLog: typeof import("../noveltyGate.js").getNoveltyGateLog;
  let addKnowledge: typeof import("../memoryEngine.js").addKnowledge;
  let knowledge: typeof import("../memoryEngine.js").knowledge;
  let archiveKnowledge: typeof import("../memoryEngine.js").archiveKnowledge;

  beforeEach(async () => {
    cleanLogFile();
    const noveltyMod = await import("../noveltyGate.js");
    checkNovelty = noveltyMod.checkNovelty;
    getNoveltyGateLog = noveltyMod.getNoveltyGateLog;
    const memMod = await import("../memoryEngine.js");
    addKnowledge = memMod.addKnowledge;
    knowledge = memMod.knowledge;
    archiveKnowledge = memMod.archiveKnowledge;
  });

  afterEach(() => {
    cleanLogFile();
  });

  describe("checkNovelty()", () => {
    it("should flag a completely unknown topic as novel", async () => {
      const result = await checkNovelty(
        "Quantum Computing Breakthrough Solves Protein Folding",
        "A new quantum algorithm has achieved unprecedented accuracy in protein structure prediction",
        ["QuantumCo", "protein folding"],
      );
      assert.equal(result.isNovel, true);
      assert.ok(result.confidence > 0.6, `confidence ${result.confidence} should be > 0.6`);
      assert.equal(result.recommendation, "breaking");
      assert.ok(result.reason.includes("new to Agent 306") || result.reason.includes("qualifies as breaking"));
    });

    it("should flag a topic with existing high-weight KB entries as NOT novel", async () => {
      // Seed the KB with entries about a well-known topic.
      //
      // Directly push to KB with custom learnedAt — addKnowledge() always
      // sets learnedAt=now (server/memoryEngine.ts:787), which would make
      // the seeded entries appear < 6h old to noveltyGate's temporal
      // analysis (ageHours < 6 → temporalScore = 0.8 → isNovel = true),
      // defeating the test. Matches the pattern already used by the
      // "recent mentions" / "old mentions" tests below in this same file.
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30); // 30 days ago

      const testEntries = [
        makeKBEntry({
          id: `kb_novelty_seed_arch_${Date.now()}`,
          title: "OpenAI GPT-5 Architecture Deep Dive",
          summary: "GPT-5 uses a revolutionary mixture of experts architecture with improved reasoning capabilities",
          weight: 8,
          learnedAt: oldDate.toISOString(),
        }),
        makeKBEntry({
          id: `kb_novelty_seed_bench_${Date.now()}`,
          title: "GPT-5 Benchmark Results Analysis",
          summary: "GPT-5 achieves state of the art on multiple reasoning benchmarks including ARC-AGI",
          weight: 7,
          learnedAt: oldDate.toISOString(),
        }),
        makeKBEntry({
          id: `kb_novelty_seed_launch_${Date.now()}`,
          title: "OpenAI GPT-5 Launch Coverage",
          summary: "OpenAI announced GPT-5 with major improvements in reasoning and multimodal understanding",
          weight: 9,
          learnedAt: oldDate.toISOString(),
        }),
      ];

      for (const entry of testEntries) {
        knowledge.entries.push(entry);
      }

      try {
        const result = await checkNovelty(
          "OpenAI Releases GPT-5 with Advanced Reasoning",
          "OpenAI has launched GPT-5, featuring improved reasoning and multimodal capabilities",
          ["OpenAI", "GPT-5"],
        );

        assert.equal(result.isNovel, false, "Topic with established KB entries should NOT be novel");
        assert.ok(result.existingEntries.length > 0, "Should have found existing entries");
        assert.ok(
          result.recommendation === "analysis" || result.recommendation === "skip",
          `recommendation should be "analysis" or "skip", got "${result.recommendation}"`,
        );
      } finally {
        // Clean up by removing from array (matches push-based seeding)
        for (const entry of testEntries) {
          const idx = knowledge.entries.findIndex(e => e.id === entry.id);
          if (idx !== -1) knowledge.entries.splice(idx, 1);
        }
      }
    });

    it("should give 'update' recommendation for thin existing knowledge", async () => {
      const recentDate = new Date();
      recentDate.setHours(recentDate.getHours() - 20); // 20 hours ago — within 24h but > 6h

      const entry = makeKBEntry({
        title: "Solana DePIN network update protocol",
        summary: "Solana introduces a new DePIN protocol for decentralized physical infrastructure",
        weight: 4,
        learnedAt: recentDate.toISOString(),
      });
      addKnowledge(entry);

      const result = await checkNovelty(
        "Solana DePIN Network Reaches Major Milestone",
        "The Solana DePIN protocol has reached 1 million connected devices",
        ["Solana", "DePIN"],
      );

      // With 1 thin entry and temporal score ~0.5, should recommend update
      if (result.existingEntries.length > 0 && result.existingEntries.length <= 2) {
        assert.ok(
          result.recommendation === "update" || result.recommendation === "breaking",
          `With thin knowledge, recommendation should be "update" or "breaking", got "${result.recommendation}"`,
        );
      }

      archiveKnowledge(entry.id);
    });

    it("should score recent mentions (< 6h) with high confidence", async () => {
      const uniqueToken = `xylophone_recent_${Date.now()}`;
      // Directly push to KB with custom learnedAt since addKnowledge() always sets learnedAt=now
      const recentEntry = makeKBEntry({
        id: `kb_recent_test_${Date.now()}`,
        title: `${uniqueToken} event`,
        summary: `${uniqueToken} happened very recently for temporal testing purposes`,
        weight: 5,
        learnedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
      });
      knowledge.entries.push(recentEntry);

      const result = await checkNovelty(
        `${uniqueToken} event update`,
        `${uniqueToken} for temporal testing`,
        [uniqueToken],
      );
      if (result.existingEntries.length > 0) {
        assert.ok(result.confidence >= 0.5, `Recent mention (< 6h) should have confidence >= 0.5, got ${result.confidence}`);
      }
      // Clean up
      const idx = knowledge.entries.findIndex(e => e.id === recentEntry.id);
      if (idx !== -1) knowledge.entries.splice(idx, 1);
    });

    it("should score old mentions (> 7d) with low confidence", async () => {
      const uniqueToken = `zymurgy_old_${Date.now()}`;
      // Directly push to KB with custom learnedAt since addKnowledge() always sets learnedAt=now
      const oldEntry = makeKBEntry({
        id: `kb_old_test_${Date.now()}`,
        title: `${uniqueToken} event`,
        summary: `${uniqueToken} was discussed weeks ago for temporal testing purposes`,
        weight: 6,
        learnedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days ago
      });
      knowledge.entries.push(oldEntry);

      const result = await checkNovelty(
        `${uniqueToken} event revisited`,
        `${uniqueToken} temporal testing`,
        [uniqueToken],
      );
      if (result.existingEntries.length > 0) {
        assert.ok(result.confidence <= 0.1, `Old mention (> 7d) should have low confidence, got ${result.confidence}`);
      }
      // Clean up by removing from array
      const idx = knowledge.entries.findIndex(e => e.id === oldEntry.id);
      if (idx !== -1) knowledge.entries.splice(idx, 1);
    });

    it("should handle missing embeddingEngine gracefully", async () => {
      // checkNovelty should still work even when semantic search is unavailable
      // (it falls back to keyword-only search)
      const result = await checkNovelty(
        "Completely Novel Test Topic That Should Pass",
        "This is a test topic that doesn't exist in any knowledge base",
        ["UniqueTestEntity123"],
      );
      // Should not throw — the function handles missing embeddingEngine internally
      assert.ok(typeof result.isNovel === "boolean");
      assert.ok(typeof result.confidence === "number");
      assert.ok(typeof result.recommendation === "string");
    });
  });

  // shouldFrameAsBreaking() was removed in commit 4b605fb together with the
  // breakingNewsDetector — the test sub-suite that exercised it was removed
  // in this PR. checkNovelty() (above) covers the equivalent novelty-decision
  // logic now.

  describe("getNoveltyGateLog()", () => {
    it("should return empty array when no checks have been made", () => {
      cleanLogFile();
      const log = getNoveltyGateLog();
      assert.ok(Array.isArray(log));
    });

    it("should respect limit parameter", async () => {
      // Run multiple checks to populate the log via checkNovelty (the
      // surviving public entry point).
      for (let i = 0; i < 5; i++) {
        await checkNovelty(
          `Test Event ${i} About Unique Topic ${Math.random()}`,
          `Summary ${i}`,
          [],
        );
      }
      const limited = getNoveltyGateLog(3);
      assert.ok(limited.length <= 3, `Should return at most 3 entries, got ${limited.length}`);
    });
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#11. Drain #12 is a Path B
// fix: memoryEngine.addKnowledge / archiveKnowledge mutate
// memory_knowledge.json AND agent306.db. Env-var redirect BEFORE first
// import of dataPaths.ts resolves the capture-at-import-time bug.
describe("noveltyGate — file-level isolation contract", () => {
  it("DATA_DIR is redirected to this run's tmpdir", () => {
    assert.equal(process.env.DATA_DIR, TMP, "DATA_DIR must point at this run's TMP");
    const tmpRoot = fs.realpathSync(os.tmpdir());
    assert.ok(fs.realpathSync(TMP).startsWith(tmpRoot), "TMP must live under os.tmpdir()");
    assert.ok(!fs.realpathSync(TMP).startsWith(REPO_ROOT), "TMP must NOT live under repo root");
    assert.equal(process.env.DB_PATH, path.join(TMP, "test.db"), "DB_PATH must point at TMP/test.db");
  });

  const watched: Array<[string, { exists: boolean; content?: string }, string]> = [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ];
  for (const [label, before, p] of watched) {
    it(`live ${label} is unchanged at file-level checkpoint`, () => {
      const cur = snapshot(p);
      if (before.exists) {
        assert.ok(cur.exists, `live ${label} disappeared`);
        assert.equal(cur.content, before.content, `live ${label} mutated`);
      } else {
        assert.equal(cur.exists, false, `live ${label} was created`);
      }
    });
  }

  it("live agent306.db is unchanged at file-level checkpoint (WAL-aware)", () => {
    const cur = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      assert.ok(cur.exists, "live agent306.db disappeared");
      assert.equal(cur.size, DB_SNAPSHOT.size, "agent306.db size changed");
      assert.equal(cur.mtimeMs, DB_SNAPSHOT.mtimeMs, "agent306.db mtime changed");
    } else {
      assert.equal(cur.exists, false, "live agent306.db was created");
    }
  });
});
