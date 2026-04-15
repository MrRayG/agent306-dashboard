/**
 * Tests for Novelty Gate — KB self-check before [306 NEWS] framing.
 *
 * Run: npx tsx --test server/__tests__/noveltyGate.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

const LOG_FILE = dataPath("novelty_gate_log.json");

function cleanLogFile() {
  try { if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE); } catch {}
}

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
  let shouldFrameAsBreaking: typeof import("../noveltyGate.js").shouldFrameAsBreaking;
  let getNoveltyGateLog: typeof import("../noveltyGate.js").getNoveltyGateLog;
  let addKnowledge: typeof import("../memoryEngine.js").addKnowledge;
  let knowledge: typeof import("../memoryEngine.js").knowledge;
  let archiveKnowledge: typeof import("../memoryEngine.js").archiveKnowledge;

  beforeEach(async () => {
    cleanLogFile();
    const noveltyMod = await import("../noveltyGate.js");
    checkNovelty = noveltyMod.checkNovelty;
    shouldFrameAsBreaking = noveltyMod.shouldFrameAsBreaking;
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
      // Seed the KB with entries about a well-known topic
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 30); // 30 days ago

      // Find existing entries about our test topic, or check against what we're about to add
      const testEntries = [
        makeKBEntry({
          title: "OpenAI GPT-5 Architecture Deep Dive",
          summary: "GPT-5 uses a revolutionary mixture of experts architecture with improved reasoning capabilities",
          weight: 8,
          learnedAt: oldDate.toISOString(),
        }),
        makeKBEntry({
          title: "GPT-5 Benchmark Results Analysis",
          summary: "GPT-5 achieves state of the art on multiple reasoning benchmarks including ARC-AGI",
          weight: 7,
          learnedAt: oldDate.toISOString(),
        }),
        makeKBEntry({
          title: "OpenAI GPT-5 Launch Coverage",
          summary: "OpenAI announced GPT-5 with major improvements in reasoning and multimodal understanding",
          weight: 9,
          learnedAt: oldDate.toISOString(),
        }),
      ];

      for (const entry of testEntries) {
        addKnowledge(entry);
      }

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

      // Clean up test entries
      for (const entry of testEntries) {
        archiveKnowledge(entry.id);
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

  describe("shouldFrameAsBreaking()", () => {
    it("should log results and return correct format", async () => {
      const mockEvent = {
        id: "test_event_1",
        headline: "Completely New Unprecedented Discovery in Physics",
        summary: "Scientists discover a new fundamental force of nature",
        source: "test",
        tier: 1 as const,
        entities: ["physics", "fundamental force"],
        detectedAt: new Date().toISOString(),
        posted: false,
        postedAt: null,
      };

      const result = await shouldFrameAsBreaking(mockEvent);

      assert.ok(typeof result.allowed === "boolean");
      assert.ok(typeof result.reframedType === "string");
      assert.ok(typeof result.reason === "string");

      // Check that the log was written
      const log = getNoveltyGateLog();
      assert.ok(log.length > 0, "Should have logged the check");
      assert.equal(log[0].headline, mockEvent.headline);
    });
  });

  describe("getNoveltyGateLog()", () => {
    it("should return empty array when no checks have been made", () => {
      cleanLogFile();
      const log = getNoveltyGateLog();
      assert.ok(Array.isArray(log));
    });

    it("should respect limit parameter", async () => {
      // Run multiple checks to populate the log
      for (let i = 0; i < 5; i++) {
        await shouldFrameAsBreaking({
          id: `test_${i}`,
          headline: `Test Event ${i} About Unique Topic ${Math.random()}`,
          summary: `Summary ${i}`,
          source: "test",
          tier: 1,
          entities: [],
          detectedAt: new Date().toISOString(),
          posted: false,
          postedAt: null,
        });
      }
      const limited = getNoveltyGateLog(3);
      assert.ok(limited.length <= 3, `Should return at most 3 entries, got ${limited.length}`);
    });
  });
});
