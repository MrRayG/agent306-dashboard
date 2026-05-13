/**
 * Tests for Wisdom Engine — historical sources driven by 306Eval calibration.
 *
 * Run: npx tsx --test server/__tests__/wisdomEngine.test.ts
 *
 * Phase 2n drain #14 — Path B isolation:
 *   wisdomEngine.pullWisdom() ingests entries via memoryEngine.addKnowledge,
 *   which writes memory_knowledge.json AND agent306.db. Pre-fix isolated
 *   run mutated memory_knowledge.json and advanced agent306.db mtime
 *   (transitive through repositories / db import). The previous static
 *   `import { dataPath } from "../dataPaths.js"` at the top of the file
 *   captured DATA_DIR at module-eval time, so the unlinkSync() calls in
 *   cleanFiles() would also resolve to repo's live data/ if those wisdom
 *   files happened to be present. Fixed by:
 *     1. Set DATA_DIR + DB_PATH BEFORE any import that resolves dataPaths
 *     2. Inline HISTORY_FILE / USAGE_FILE / GOOGLE_BOOKS_CACHE_FILE under
 *        TMP (so even if dataPaths resolves first, the unlink targets are
 *        scoped to TMP)
 */

import fs from "fs";
import path from "path";
import os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain14-wisdom-engine-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
process.env.DATA_DIR = TMP;
process.env.DB_PATH  = path.join(TMP, "test.db");

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

// Inline the wisdom-engine companion file paths under TMP. Inlining (rather
// than calling dataPath()) avoids re-loading dataPaths.ts before env vars
// are set, even though we already set them above. Belt-and-suspenders for
// module-eval timing.
const HISTORY_FILE = path.join(TMP, "wisdom_pull_history.json");
const USAGE_FILE = path.join(TMP, "wisdom_api_usage.json");
// PR introduced a 7-day Google Books cache. Without clearing it, mocked-fetch
// failure tests still hit cached entries from previous suite runs and report
// non-zero `entriesIngested`.
const GOOGLE_BOOKS_CACHE_FILE = path.join(TMP, "google_books_cache.json");

function cleanFiles() {
  try { if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE); } catch {}
  try { if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE); } catch {}
  try { if (fs.existsSync(GOOGLE_BOOKS_CACHE_FILE)) fs.unlinkSync(GOOGLE_BOOKS_CACHE_FILE); } catch {}
}

before(() => {
  // Loud-failure pin (drain template).
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const tmpReal = fs.realpathSync(TMP);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`wisdomEngine isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`wisdomEngine isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP) {
    throw new Error(`wisdomEngine isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP, "test.db")) {
    throw new Error(`wisdomEngine isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

after(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  const afterSnap = (p: string) => snapshot(p);
  for (const [label, beforeSnap, p] of [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const a = afterSnap(p);
    if (beforeSnap.exists) {
      if (!a.exists) throw new Error(`wisdomEngine tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`wisdomEngine tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`wisdomEngine tests created live ${label}!`);
    }
  }

  const dbAfter = dbStat(REAL_DB);
  if (DB_SNAPSHOT.exists) {
    if (!dbAfter.exists) throw new Error(`wisdomEngine tests removed live agent306.db!`);
    if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
      throw new Error(`wisdomEngine tests mutated live agent306.db (size/mtime changed)!`);
    }
  } else if (dbAfter.exists) {
    throw new Error(`wisdomEngine tests created live agent306.db!`);
  }
});

// Build a mock EvalResult matching the real interface
function mockEvalResult(overrides: Partial<any> = {}): any {
  return {
    id: `eval_test_${Date.now()}`,
    timestamp: new Date().toISOString(),
    dimensions: [
      { name: "Signal Acquisition", key: "signalAcquisition", score: 65, components: {} },
      { name: "Source Integrity", key: "sourceIntegrity", score: 70, components: {} },
      { name: "Reasoning Rigor", key: "reasoningRigor", score: 60, components: {} },
      { name: "Intellectual Honesty", key: "intellectualHonesty", score: 75, components: {} },
      { name: "Voice Evolution", key: "voiceEvolution", score: 80, components: {} },
      { name: "Audience Impact", key: "audienceImpact", score: 55, components: {} },
    ],
    composite: 67,
    weakestDimension: overrides.weakestDimension ?? "audienceImpact",
    calibrationDirective: overrides.calibrationDirective ?? "Focus on audience engagement and impact measurement",
    drift: { direction: "stable" as const, avg7d: 67, avg30d: 65, delta7d: 2 },
    ...overrides,
  };
}

describe("WisdomEngine", () => {
  let pullWisdom: typeof import("../wisdomEngine.js").pullWisdom;
  let getWisdomPullHistory: typeof import("../wisdomEngine.js").getWisdomPullHistory;
  let getWisdomApiUsage: typeof import("../wisdomEngine.js").getWisdomApiUsage;
  let getActiveWisdomCount: typeof import("../wisdomEngine.js").getActiveWisdomCount;
  let DIMENSION_DOMAIN_MAP: typeof import("../wisdomEngine.js").DIMENSION_DOMAIN_MAP;
  let MAX_WISDOM_ENTRIES: typeof import("../wisdomEngine.js").MAX_WISDOM_ENTRIES;
  let RATE_LIMITS: typeof import("../wisdomEngine.js").RATE_LIMITS;
  let knowledge: typeof import("../memoryEngine.js").knowledge;
  let archiveKnowledge: typeof import("../memoryEngine.js").archiveKnowledge;

  // Store original fetch for restoration
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    cleanFiles();
    const mod = await import("../wisdomEngine.js");
    pullWisdom = mod.pullWisdom;
    getWisdomPullHistory = mod.getWisdomPullHistory;
    getWisdomApiUsage = mod.getWisdomApiUsage;
    getActiveWisdomCount = mod.getActiveWisdomCount;
    DIMENSION_DOMAIN_MAP = mod.DIMENSION_DOMAIN_MAP;
    MAX_WISDOM_ENTRIES = mod.MAX_WISDOM_ENTRIES;
    RATE_LIMITS = mod.RATE_LIMITS;
    const memMod = await import("../memoryEngine.js");
    knowledge = memMod.knowledge;
    archiveKnowledge = memMod.archiveKnowledge;
  });

  afterEach(() => {
    cleanFiles();
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  describe("DIMENSION_DOMAIN_MAP", () => {
    it("should have mappings for all 6 eval dimensions", () => {
      const expectedDimensions = [
        "signalAcquisition",
        "sourceIntegrity",
        "reasoningRigor",
        "intellectualHonesty",
        "voiceEvolution",
        "audienceImpact",
      ];
      for (const dim of expectedDimensions) {
        assert.ok(DIMENSION_DOMAIN_MAP[dim], `Missing mapping for dimension: ${dim}`);
        assert.ok(DIMENSION_DOMAIN_MAP[dim].domains.length > 0, `${dim} should have domains`);
        assert.ok(DIMENSION_DOMAIN_MAP[dim].searchTerms.length > 0, `${dim} should have searchTerms`);
        assert.ok(DIMENSION_DOMAIN_MAP[dim].bibleTopics.length > 0, `${dim} should have bibleTopics`);
        assert.ok(DIMENSION_DOMAIN_MAP[dim].quranTopics.length > 0, `${dim} should have quranTopics`);
        assert.ok(DIMENSION_DOMAIN_MAP[dim].philosophers.length > 0, `${dim} should have philosophers`);
      }
    });

    it("should map correct domains for each dimension", () => {
      assert.ok(DIMENSION_DOMAIN_MAP.signalAcquisition.domains.includes("research methodology"));
      assert.ok(DIMENSION_DOMAIN_MAP.reasoningRigor.domains.includes("logic"));
      assert.ok(DIMENSION_DOMAIN_MAP.voiceEvolution.domains.includes("rhetoric"));
      assert.ok(DIMENSION_DOMAIN_MAP.audienceImpact.domains.includes("pedagogy"));
    });
  });

  describe("pullWisdom() — API failure handling", () => {
    it("should handle all API failures gracefully", async () => {
      // Mock fetch to always throw
      globalThis.fetch = (async () => {
        throw new Error("Network error — test mock");
      }) as any;

      const evalResult = mockEvalResult({ weakestDimension: "reasoningRigor" });
      const result = await pullWisdom(evalResult);

      assert.equal(result.triggeredBy, "reasoningRigor");
      assert.equal(result.entriesIngested, 0);
      assert.ok(Array.isArray(result.sources));
      // Should not throw — all API errors are caught internally
    });

    it("should handle unknown dimension gracefully", async () => {
      const evalResult = mockEvalResult({ weakestDimension: "unknownDimension" });
      const result = await pullWisdom(evalResult);

      assert.equal(result.triggeredBy, "unknownDimension");
      assert.equal(result.entriesIngested, 0);
      assert.equal(result.sources.length, 0);
    });
  });

  describe("pullWisdom() — dedup logic", () => {
    it("should skip entries that already exist in KB as wisdom", async () => {
      // Pre-seed a wisdom entry
      knowledge.entries.push({
        id: `kb_wisdom_test_${Date.now()}`,
        category: "wisdom",
        title: "[Wisdom] The Art of War",
        summary: "Sun Tzu's classic on strategy and conflict",
        source: "wisdom_engine:gutenberg",
        learnedAt: new Date().toISOString(),
        weight: 5,
        status: "active",
        tier: "active",
      });

      // Mock fetch to return a result that matches the existing entry
      globalThis.fetch = (async (url: string) => {
        if (typeof url === "string" && url.includes("gutendex.com")) {
          return {
            ok: true,
            json: async () => ({
              results: [{ title: "The Art of War", subjects: ["Military art"], authors: [{ name: "Sun Tzu" }] }],
            }),
          };
        }
        if (typeof url === "string" && url.includes("googleapis.com")) {
          return {
            ok: true,
            json: async () => ({
              items: [{ volumeInfo: { title: "Unique Book About Logic", description: "A unique book", authors: ["Test Author"] } }],
            }),
          };
        }
        // Other APIs return empty
        return { ok: true, json: async () => ({ data: { verses: [] }, data2: { matches: [] } }) };
      }) as any;

      const evalResult = mockEvalResult({ weakestDimension: "reasoningRigor" });
      const result = await pullWisdom(evalResult);

      // "The Art of War" should be skipped (dedup), but "Unique Book About Logic" should be ingested
      assert.ok(result.entriesSkipped >= 0, "Should have dedup logic working");
      assert.ok(typeof result.entriesIngested === "number");

      // Clean up
      const idx = knowledge.entries.findIndex(e => e.title === "[Wisdom] The Art of War");
      if (idx !== -1) knowledge.entries.splice(idx, 1);
      // Also clean up any newly added entries
      const wisdomIdx = knowledge.entries.findIndex(e => e.title?.includes("Unique Book About Logic"));
      if (wisdomIdx !== -1) archiveKnowledge(knowledge.entries[wisdomIdx].id);
    });
  });

  describe("wisdom entry cap", () => {
    it("should enforce the MAX_WISDOM_ENTRIES cap", () => {
      assert.equal(MAX_WISDOM_ENTRIES, 50, "Max wisdom entries should be 50");
    });

    it("should archive oldest entries when over cap", async () => {
      // Pre-seed more than MAX_WISDOM_ENTRIES wisdom entries
      const testIds: string[] = [];
      for (let i = 0; i < 52; i++) {
        const id = `kb_wisdom_cap_test_${Date.now()}_${i}`;
        testIds.push(id);
        const date = new Date();
        date.setDate(date.getDate() - (52 - i)); // oldest first
        knowledge.entries.push({
          id,
          category: "wisdom",
          title: `[Wisdom] Cap Test Entry ${i}`,
          summary: `Test entry ${i} for cap enforcement`,
          source: "wisdom_engine:test",
          learnedAt: date.toISOString(),
          weight: 5,
          status: "active",
          tier: "active",
        });
      }

      // Mock fetch to return empty (we're just testing the cap enforcement)
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ items: [], results: [], data: { verses: [], matches: [] } }),
      })) as any;

      const evalResult = mockEvalResult();
      await pullWisdom(evalResult);

      // Count active wisdom entries — should be <= MAX_WISDOM_ENTRIES
      const activeWisdom = knowledge.entries.filter(
        e => e.category === "wisdom" && (e.status ?? "active") === "active",
      );
      assert.ok(
        activeWisdom.length <= MAX_WISDOM_ENTRIES,
        `Active wisdom entries (${activeWisdom.length}) should be <= ${MAX_WISDOM_ENTRIES}`,
      );

      // Clean up all test entries
      for (const id of testIds) {
        const idx = knowledge.entries.findIndex(e => e.id === id);
        if (idx !== -1) knowledge.entries.splice(idx, 1);
      }
    });
  });

  describe("rate limiting", () => {
    it("should have rate limits for all API sources", () => {
      assert.ok(RATE_LIMITS.google_books > 0);
      assert.ok(RATE_LIMITS.bible > 0);
      assert.ok(RATE_LIMITS.quran > 0);
      assert.ok(RATE_LIMITS.gutenberg > 0);
    });

    it("should track API usage", async () => {
      // Mock fetch with working responses
      globalThis.fetch = (async (url: string) => {
        if (typeof url === "string" && url.includes("googleapis.com")) {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        if (typeof url === "string" && url.includes("gutendex.com")) {
          return { ok: true, json: async () => ({ results: [] }) };
        }
        if (typeof url === "string" && url.includes("alquran.cloud")) {
          return { ok: true, json: async () => ({ data: { matches: [] } }) };
        }
        return { ok: true, json: async () => ({ data: { verses: [] } }) };
      }) as any;

      const evalResult = mockEvalResult();
      await pullWisdom(evalResult);

      const usage = getWisdomApiUsage();
      assert.equal(usage.date, new Date().toISOString().slice(0, 10));
      // At least google_books and gutenberg should have been called (quran + bible may be called too)
      assert.ok(usage.google_books >= 1, "Should have tracked Google Books usage");
    });
  });

  describe("correct domains queried for dimension", () => {
    it("should use correct search terms for signalAcquisition", async () => {
      let capturedUrl = "";
      globalThis.fetch = (async (url: string) => {
        if (typeof url === "string") capturedUrl = url;
        if (typeof url === "string" && url.includes("googleapis.com")) {
          return { ok: true, json: async () => ({ items: [] }) };
        }
        return { ok: true, json: async () => ({ results: [], data: { verses: [], matches: [] } }) };
      }) as any;

      const evalResult = mockEvalResult({ weakestDimension: "signalAcquisition" });
      await pullWisdom(evalResult);

      // The search terms for signalAcquisition include "scientific method"
      // Google Books should have been called with these terms
      assert.equal(evalResult.weakestDimension, "signalAcquisition");
      assert.ok(DIMENSION_DOMAIN_MAP.signalAcquisition.searchTerms.includes("scientific method"));
    });

    it("should use correct search terms for intellectualHonesty", async () => {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({ items: [], results: [], data: { verses: [], matches: [] } }),
      })) as any;

      const evalResult = mockEvalResult({ weakestDimension: "intellectualHonesty" });
      const result = await pullWisdom(evalResult);

      assert.equal(result.triggeredBy, "intellectualHonesty");
      assert.ok(DIMENSION_DOMAIN_MAP.intellectualHonesty.searchTerms.includes("intellectual humility"));
      assert.ok(DIMENSION_DOMAIN_MAP.intellectualHonesty.philosophers.includes("Socrates"));
    });
  });

  describe("getWisdomPullHistory()", () => {
    it("should return empty array when no pulls have been made", () => {
      cleanFiles();
      const history = getWisdomPullHistory();
      assert.ok(Array.isArray(history));
    });
  });

  describe("Bible API integration", () => {
    it("should build the auth header as 'api-key: <key>' (not Authorization: Bearer)", async () => {
      const mod = await import("../wisdomEngine.js");
      const headers = mod.buildBibleHeaders("test-key-123");
      assert.equal(headers["api-key"], "test-key-123");
      assert.equal(headers["Authorization"], undefined);
      assert.equal(headers["X-API-Key"], undefined);
    });

    it("should hit api.scripture.api.bible/v1 with api-key header and NOT retry on 401", async () => {
      process.env.BIBLE_API_KEY = "fake-bad-key";
      const mod = await import("../wisdomEngine.js");
      mod.__resetBibleAuthDisabledForTest();

      let bibleCallCount = 0;
      let sawApiKeyHeader = false;
      let sawBearer = false;
      let url = "";
      globalThis.fetch = (async (u: string, opts?: any) => {
        if (typeof u === "string" && u.includes("scripture.api.bible")) {
          bibleCallCount++;
          url = u;
          const h = opts?.headers ?? {};
          if (h["api-key"]) sawApiKeyHeader = true;
          const authVal = h["Authorization"] ?? h["authorization"];
          if (typeof authVal === "string" && authVal.startsWith("Bearer")) sawBearer = true;
          return {
            ok: false,
            status: 401,
            text: async () => '{"statusCode":401,"error":"Unauthorized","message":"bad api-key"}',
          };
        }
        return { ok: true, json: async () => ({ items: [], results: [], data: { verses: [], matches: [] } }) };
      }) as any;

      const evalResult = mockEvalResult({ weakestDimension: "reasoningRigor" });
      await pullWisdom(evalResult);

      assert.ok(url.startsWith("https://api.scripture.api.bible/v1/"), `base URL should be api.scripture.api.bible/v1, got: ${url}`);
      assert.equal(sawApiKeyHeader, true, "Bible call must send 'api-key' header");
      assert.equal(sawBearer, false, "Bible call must NOT send Authorization: Bearer");
      assert.equal(bibleCallCount, 1, "401 must not be retried");

      // Second pull — Bible disabled after 401, should not call again
      await pullWisdom(evalResult);
      assert.equal(bibleCallCount, 1, "after 401, Bible calls must be disabled for the process");

      delete process.env.BIBLE_API_KEY;
      mod.__resetBibleAuthDisabledForTest();
    });

    it("should skip Bible call cleanly when BIBLE_API_KEY is unset", async () => {
      delete process.env.BIBLE_API_KEY;
      const mod = await import("../wisdomEngine.js");
      mod.__resetBibleAuthDisabledForTest();

      let bibleCallCount = 0;
      globalThis.fetch = (async (u: string) => {
        if (typeof u === "string" && u.includes("scripture.api.bible")) {
          bibleCallCount++;
        }
        return { ok: true, json: async () => ({ items: [], results: [], data: { verses: [], matches: [] } }) };
      }) as any;

      const evalResult = mockEvalResult({ weakestDimension: "reasoningRigor" });
      const result = await pullWisdom(evalResult);

      assert.equal(bibleCallCount, 0, "no Bible call should be made when key is unset");
      assert.ok(result.entriesIngested >= 0);
    });
  });

  describe("Bible ID plan guard", () => {
    // Starter Plan grants CSB / NKJV / NIV. KJV, ESV, and others are NOT owned and return 401.
    const PLAN_OWNED_BIBLE_IDS = [
      "a556c5305ee15c3f-01", // CSB
      "63097d2a0a2f7db3-01", // NKJV
      "78a9f6124f344018-01", // NIV
    ];

    it("should use a Bible ID that is in the plan-owned whitelist", async () => {
      const mod = await import("../wisdomEngine.js");
      assert.ok(
        PLAN_OWNED_BIBLE_IDS.includes(mod.BIBLE_ID),
        `BIBLE_ID (${mod.BIBLE_ID}) must be in plan-owned whitelist (CSB/NKJV/NIV). ` +
          `KJV (de4e12af7f28f599-02) and ESV are NOT on the Starter Plan and will 401.`,
      );
    });

    it("should NOT use the KJV Bible ID (unowned on Starter Plan)", async () => {
      const mod = await import("../wisdomEngine.js");
      assert.notEqual(
        mod.BIBLE_ID,
        "de4e12af7f28f599-02",
        "BIBLE_ID must not be KJV — KJV is not on the Starter Plan and returns 401",
      );
    });
  });

  describe("getActiveWisdomCount()", () => {
    it("should count only active wisdom entries", () => {
      const before = getActiveWisdomCount();
      // Add a test wisdom entry
      const id = `kb_wisdom_count_test_${Date.now()}`;
      knowledge.entries.push({
        id,
        category: "wisdom",
        title: "[Wisdom] Count Test",
        summary: "Test",
        source: "test",
        learnedAt: new Date().toISOString(),
        weight: 5,
        status: "active",
        tier: "active",
      });
      assert.equal(getActiveWisdomCount(), before + 1);

      // Clean up
      const idx = knowledge.entries.findIndex(e => e.id === id);
      if (idx !== -1) knowledge.entries.splice(idx, 1);
    });
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#13. Drain #14 is a Path B
// fix: wisdomEngine.pullWisdom() ingests via memoryEngine.addKnowledge,
// which mutates memory_knowledge.json AND agent306.db. The pre-fix static
// `import { dataPath } from "../dataPaths.js"` captured DATA_DIR at
// module-eval time. Env-var redirect BEFORE first import of dataPaths.ts
// resolves the capture-at-import-time bug. HISTORY_FILE / USAGE_FILE /
// GOOGLE_BOOKS_CACHE_FILE are inlined under TMP for defense in depth.
describe("wisdomEngine — file-level isolation contract", () => {
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
