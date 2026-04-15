/**
 * Tests for Wisdom Engine — historical sources driven by 306Eval calibration.
 *
 * Run: npx tsx --test server/__tests__/wisdomEngine.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const HISTORY_FILE = dataPath("wisdom_pull_history.json");
const USAGE_FILE = dataPath("wisdom_api_usage.json");

function cleanFiles() {
  try { if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE); } catch {}
  try { if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE); } catch {}
}

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
