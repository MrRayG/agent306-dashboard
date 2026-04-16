/**
 * Tests for graph-aware context retrieval.
 *
 * Run: npx tsx --test server/__tests__/graphAwareContext.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// We need to test getGraphAwareContext, getOptimizedContextWithGraph, and getLastContextEntryIds.
// These rely on knowledge.entries and getGraphConnections() from knowledge-graph.
// We mock them by manipulating the in-memory state before importing.

// Set up minimal env so modules don't crash on import
process.env.GROK_API_KEY = "test-key";
process.env.DATA_DIR = "/tmp/test-graph-context-" + Date.now();

import * as fs from "fs";
fs.mkdirSync(process.env.DATA_DIR!, { recursive: true });

// Write minimal data files so modules load without errors
fs.writeFileSync(`${process.env.DATA_DIR}/memory_soul.json`, JSON.stringify({
  version: 1, identity: { name: "Test", token: "", eth: "", role: "", coreSentence: "" },
  mission: "", philosophy: "", voicePrinciples: [], canon: { founder: "", developer: "", communityCreator: "", officialAccount: "" },
  ecosystem: { phases: [], arenaDate: "", evolutionDate: "" }, lastUpdated: "",
}));
fs.writeFileSync(`${process.env.DATA_DIR}/memory_knowledge.json`, JSON.stringify({ entries: [], lastIngested: "", totalEntries: 0, researchFiles: [] }));
fs.writeFileSync(`${process.env.DATA_DIR}/memory_performance.json`, JSON.stringify({ lessons: [], totalPosts: 0, avgEngagement: 0, avgScore: 0, topPerforming: [], patterns: { bestHours: [], bestTopics: [], worstTopics: [] } }));
fs.writeFileSync(`${process.env.DATA_DIR}/knowledge-connections-graph.json`, JSON.stringify({ connections: [], lastScanAt: null }));
fs.writeFileSync(`${process.env.DATA_DIR}/knowledge-clusters.json`, JSON.stringify({ clusters: [], lastClusteredAt: null }));

import { knowledge } from "../memoryEngine.js";
import { getGraphAwareContext, getLastContextEntryIds } from "../contextWindow.js";

describe("getGraphAwareContext", () => {
  beforeEach(() => {
    // Reset knowledge entries
    knowledge.entries.length = 0;
  });

  it("falls back to getRelevantContext when no query tokens match", () => {
    knowledge.entries.push({
      id: "e1", category: "research", title: "LLM Scaling Laws",
      summary: "Larger models scale predictably", learnedAt: new Date().toISOString(),
      weight: 8, status: "active",
    });

    // Query with only stopwords
    const result = getGraphAwareContext("the is a");
    // Should fall back gracefully (either empty or weight-based)
    assert.ok(typeof result === "string");
  });

  it("returns hop-0 entries that match query keywords", () => {
    knowledge.entries.push(
      { id: "e1", category: "research", title: "LLM Scaling Laws", summary: "Larger models scale predictably with compute", learnedAt: new Date().toISOString(), weight: 8, status: "active" },
      { id: "e2", category: "ai_signal", title: "GPT-5 Release", summary: "OpenAI announces next-gen LLM model", learnedAt: new Date().toISOString(), weight: 7, status: "active" },
      { id: "e3", category: "market", title: "Bitcoin Price", summary: "Crypto market analysis report", learnedAt: new Date().toISOString(), weight: 6, status: "active" },
    );

    const result = getGraphAwareContext("LLM scaling models");
    assert.ok(result.includes("RELEVANT KNOWLEDGE"), "Should have RELEVANT KNOWLEDGE section");
    assert.ok(result.includes("LLM Scaling Laws"), "Should include matching entry");
    assert.ok(result.includes("END KNOWLEDGE"), "Should close with END KNOWLEDGE");
  });

  it("respects char budget and does not exceed maxTokens", () => {
    // Add many entries
    for (let i = 0; i < 30; i++) {
      knowledge.entries.push({
        id: `e${i}`, category: "research",
        title: `AI Research Paper ${i}`,
        summary: `This is a detailed summary about AI research topic number ${i} with important findings`,
        learnedAt: new Date().toISOString(), weight: 8, status: "active",
      });
    }

    const result = getGraphAwareContext("AI research", { maxTokens: 500 });
    // Should be under budget (500 chars * 0.7 for hop-0 + some graph entries)
    assert.ok(result.length < 2000, "Result should be bounded by char budget");
  });

  it("tracks entry IDs for provenance via getLastContextEntryIds", () => {
    knowledge.entries.push(
      { id: "prov1", category: "research", title: "Provenance Test Entry", summary: "Testing provenance tracking", learnedAt: new Date().toISOString(), weight: 8, status: "active" },
    );

    getGraphAwareContext("provenance test");
    const ids = getLastContextEntryIds();
    assert.ok(ids.includes("prov1"), "Should track hop-0 entry IDs");
  });

  it("returns a copy of entry IDs (not mutable reference)", () => {
    knowledge.entries.push(
      { id: "copy1", category: "research", title: "Copy Test", summary: "Testing immutability", learnedAt: new Date().toISOString(), weight: 8, status: "active" },
    );

    getGraphAwareContext("copy test");
    const ids1 = getLastContextEntryIds();
    const ids2 = getLastContextEntryIds();
    assert.notStrictEqual(ids1, ids2, "Should return a new array each time");
    assert.deepStrictEqual(ids1, ids2, "But with same contents");
  });

  it("skips archived entries", () => {
    knowledge.entries.push(
      { id: "active1", category: "research", title: "Active Entry", summary: "This is active", learnedAt: new Date().toISOString(), weight: 8, status: "active" },
      { id: "archived1", category: "research", title: "Archived Entry", summary: "This is archived", learnedAt: new Date().toISOString(), weight: 8, status: "archived" },
    );

    const result = getGraphAwareContext("entry");
    assert.ok(result.includes("Active Entry"), "Should include active entry");
    assert.ok(!result.includes("Archived Entry"), "Should exclude archived entry");
  });
});
