/**
 * Tests for entity extraction module.
 *
 * Run: npx tsx --test server/__tests__/entityExtractor.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// Set up isolated test data directory
const TEST_DATA_DIR = "/tmp/test-entity-extractor-" + Date.now();
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.GROK_API_KEY = "test-key";

fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

// Write minimal data files so modules load without errors
fs.writeFileSync(`${TEST_DATA_DIR}/memory_soul.json`, JSON.stringify({
  version: 1, identity: { name: "Test", token: "", eth: "", role: "", coreSentence: "" },
  mission: "", philosophy: "", voicePrinciples: [], canon: { founder: "", developer: "", communityCreator: "", officialAccount: "" },
  ecosystem: { phases: [], arenaDate: "", evolutionDate: "" }, lastUpdated: "",
}));
fs.writeFileSync(`${TEST_DATA_DIR}/memory_knowledge.json`, JSON.stringify({ entries: [], lastIngested: "", totalEntries: 0, researchFiles: [] }));
fs.writeFileSync(`${TEST_DATA_DIR}/memory_performance.json`, JSON.stringify({ lessons: [], totalPosts: 0, avgEngagement: 0, avgScore: 0, topPerforming: [], patterns: { bestHours: [], bestTopics: [], worstTopics: [] } }));
fs.writeFileSync(`${TEST_DATA_DIR}/knowledge-connections-graph.json`, JSON.stringify({ connections: [], lastScanAt: null }));
fs.writeFileSync(`${TEST_DATA_DIR}/knowledge-clusters.json`, JSON.stringify({ clusters: [], lastClusteredAt: null }));

import { knowledge } from "../memoryEngine.js";
import { dataPath } from "../dataPaths.js";

// We import functions individually using dynamic import inside each test
// to avoid module-level side effects from prior test file writes.

const ENTITY_FILE = dataPath("entity-index.json");

function writeEntityIndex(data: any): void {
  fs.writeFileSync(ENTITY_FILE, JSON.stringify(data));
}

function clearEntityIndex(): void {
  try { fs.unlinkSync(ENTITY_FILE); } catch {}
}

describe("getEntityIndex", () => {
  beforeEach(() => { clearEntityIndex(); });

  it("returns empty index when no entities exist", async () => {
    const { getEntityIndex } = await import("../entityExtractor.js");
    const index = getEntityIndex();
    assert.ok(Array.isArray(index.entities), "entities should be an array");
    assert.ok(typeof index.lastUpdated === "string", "lastUpdated should be a string");
  });

  it("returns entities from file when they exist", async () => {
    writeEntityIndex({
      entities: [
        {
          name: "OpenAI",
          normalizedName: "openai",
          type: "company",
          entryIds: ["e1", "e2"],
          firstSeen: "2024-01-01T00:00:00Z",
          lastSeen: "2024-01-15T00:00:00Z",
          mentionCount: 5,
        },
      ],
      lastUpdated: "2024-01-15T00:00:00Z",
    });

    const { getEntityIndex } = await import("../entityExtractor.js");
    const index = getEntityIndex();
    assert.equal(index.entities.length, 1);
    assert.equal(index.entities[0].name, "OpenAI");
    assert.equal(index.entities[0].type, "company");
    assert.equal(index.entities[0].entryIds.length, 2);
  });
});

describe("findEntriesByEntity", () => {
  beforeEach(() => {
    knowledge.entries.length = 0;
    clearEntityIndex();
  });

  it("returns matching KB entries for an entity name", async () => {
    writeEntityIndex({
      entities: [
        {
          name: "OpenAI",
          normalizedName: "openai",
          type: "company",
          entryIds: ["e1", "e3"],
          firstSeen: "2024-01-01T00:00:00Z",
          lastSeen: "2024-01-15T00:00:00Z",
          mentionCount: 3,
        },
      ],
      lastUpdated: "2024-01-15T00:00:00Z",
    });

    knowledge.entries.push(
      { id: "e1", category: "research", title: "GPT-5 Paper", summary: "OpenAI's new model", learnedAt: "2024-01-01", weight: 8, status: "active" },
      { id: "e2", category: "market", title: "Crypto Update", summary: "Market trends", learnedAt: "2024-01-02", weight: 6, status: "active" },
      { id: "e3", category: "ai_signal", title: "API Changes", summary: "OpenAI API updates", learnedAt: "2024-01-03", weight: 7, status: "active" },
    );

    const { findEntriesByEntity } = await import("../entityExtractor.js");
    const entries = findEntriesByEntity("OpenAI");
    assert.equal(entries.length, 2);
    assert.ok(entries.some(e => e.id === "e1"), "Should include e1");
    assert.ok(entries.some(e => e.id === "e3"), "Should include e3");
  });

  it("supports fuzzy matching (substring)", async () => {
    writeEntityIndex({
      entities: [
        { name: "GPT-4", normalizedName: "gpt-4", type: "technology", entryIds: ["e1"], firstSeen: "2024-01-01T00:00:00Z", lastSeen: "2024-01-01T00:00:00Z", mentionCount: 1 },
        { name: "GPT-4o", normalizedName: "gpt-4o", type: "technology", entryIds: ["e2"], firstSeen: "2024-01-01T00:00:00Z", lastSeen: "2024-01-01T00:00:00Z", mentionCount: 1 },
      ],
      lastUpdated: "2024-01-01T00:00:00Z",
    });

    knowledge.entries.push(
      { id: "e1", category: "research", title: "GPT-4 Paper", summary: "GPT-4 findings", learnedAt: "2024-01-01", weight: 8, status: "active" },
      { id: "e2", category: "research", title: "GPT-4o Paper", summary: "GPT-4o findings", learnedAt: "2024-01-01", weight: 8, status: "active" },
    );

    const { findEntriesByEntity } = await import("../entityExtractor.js");
    const entries = findEntriesByEntity("gpt-4");
    assert.equal(entries.length, 2, "Should match both GPT-4 and GPT-4o via substring");
  });

  it("returns empty array for unknown entities", async () => {
    writeEntityIndex({ entities: [], lastUpdated: "2024-01-01T00:00:00Z" });

    const { findEntriesByEntity } = await import("../entityExtractor.js");
    const entries = findEntriesByEntity("NonExistentEntity");
    assert.equal(entries.length, 0);
  });
});

describe("mergeEntities", () => {
  beforeEach(() => { clearEntityIndex(); });

  it("deduplicates similar entity names", async () => {
    writeEntityIndex({
      entities: [
        { name: "GPT-4", normalizedName: "gpt-4", type: "technology", entryIds: ["e1"], firstSeen: "2024-01-01T00:00:00Z", lastSeen: "2024-01-01T00:00:00Z", mentionCount: 3 },
        { name: "GPT4", normalizedName: "gpt4", type: "technology", entryIds: ["e2"], firstSeen: "2024-01-02T00:00:00Z", lastSeen: "2024-01-02T00:00:00Z", mentionCount: 1 },
      ],
      lastUpdated: "2024-01-01T00:00:00Z",
    });

    const { mergeEntities, getEntityIndex } = await import("../entityExtractor.js");
    mergeEntities();

    const index = getEntityIndex();
    assert.equal(index.entities.length, 1, "Should merge GPT-4 and GPT4 into one");
    assert.ok(index.entities[0].entryIds.includes("e1"), "Should include e1");
    assert.ok(index.entities[0].entryIds.includes("e2"), "Should include e2");
    assert.equal(index.entities[0].mentionCount, 4, "Should sum mention counts");
  });
});

describe("pruneStaleEntities", () => {
  beforeEach(() => {
    knowledge.entries.length = 0;
    clearEntityIndex();
  });

  it("removes entities whose entries are all archived", async () => {
    writeEntityIndex({
      entities: [
        { name: "ActiveEntity", normalizedName: "activeentity", type: "concept", entryIds: ["e1"], firstSeen: "2024-01-01T00:00:00Z", lastSeen: "2024-01-01T00:00:00Z", mentionCount: 1 },
        { name: "StaleEntity", normalizedName: "staleentity", type: "concept", entryIds: ["e2"], firstSeen: "2024-01-01T00:00:00Z", lastSeen: "2024-01-01T00:00:00Z", mentionCount: 1 },
      ],
      lastUpdated: "2024-01-01T00:00:00Z",
    });

    knowledge.entries.push(
      { id: "e1", category: "research", title: "Active", summary: "Active entry", learnedAt: "2024-01-01", weight: 8, status: "active" },
      { id: "e2", category: "research", title: "Archived", summary: "Archived entry", learnedAt: "2024-01-01", weight: 8, status: "archived" },
    );

    const { pruneStaleEntities, getEntityIndex } = await import("../entityExtractor.js");
    pruneStaleEntities();

    const index = getEntityIndex();
    assert.equal(index.entities.length, 1, "Should remove stale entity");
    assert.equal(index.entities[0].name, "ActiveEntity", "Should keep active entity");
  });

  it("cleans up stale entryIds within surviving entities", async () => {
    writeEntityIndex({
      entities: [
        { name: "MixedEntity", normalizedName: "mixedentity", type: "concept", entryIds: ["e1", "e2"], firstSeen: "2024-01-01T00:00:00Z", lastSeen: "2024-01-01T00:00:00Z", mentionCount: 2 },
      ],
      lastUpdated: "2024-01-01T00:00:00Z",
    });

    knowledge.entries.push(
      { id: "e1", category: "research", title: "Active", summary: "Active entry", learnedAt: "2024-01-01", weight: 8, status: "active" },
      { id: "e2", category: "research", title: "Archived", summary: "Archived entry", learnedAt: "2024-01-01", weight: 8, status: "archived" },
    );

    const { pruneStaleEntities, getEntityIndex } = await import("../entityExtractor.js");
    pruneStaleEntities();

    const index = getEntityIndex();
    assert.equal(index.entities.length, 1, "Entity should survive (has active entry)");
    assert.deepStrictEqual(index.entities[0].entryIds, ["e1"], "Should remove archived entryId");
  });
});
