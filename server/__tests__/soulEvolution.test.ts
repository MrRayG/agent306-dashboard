/**
 * Tests for the soul evolution system — voice journal, reflection loops,
 * growth-aware prompts.
 *
 * Run: npx tsx --test server/__tests__/soulEvolution.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { dataPath } from "../dataPaths.js";

// We need to mock fetch before importing soulEvolution, since it uses fetch for LLM calls.
// node:test mock.method works on globalThis.

const JOURNAL_FILE = dataPath("voice_journal.json");

// Helper: create a mock fetch that returns LLM-style responses
function makeFetchMock(response: string) {
  return mock.fn(async () => ({
    json: async () => ({
      choices: [{ message: { content: response } }],
    }),
  }));
}

// Helper: clean up journal file
function cleanJournal() {
  try {
    if (fs.existsSync(JOURNAL_FILE)) fs.unlinkSync(JOURNAL_FILE);
  } catch {}
}

// Import after setup — soulEvolution loads journal on import
// We clean first so it starts fresh
cleanJournal();

import {
  reflectOnPost,
  dailyReflection,
  getEvolutionContext,
  getVoiceJournal,
  getVoiceTraits,
  _resetJournal,
  _reloadJournal,
  _getJournalInternal,
} from "../soulEvolution.js";

describe("soulEvolution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    _resetJournal();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -- 1. Voice Journal persistence --

  describe("Voice Journal persistence", () => {
    it("persists entries to disk and reloads them", () => {
      const journal = _getJournalInternal();
      journal.entries.push({
        id: "test_persist_1",
        date: new Date().toISOString(),
        type: "lesson",
        content: "Test persistence entry",
        source: { engagementScore: 8 },
      });
      journal.communicationInsights.push("Test insight");
      // Save by triggering a write through reset+manual write
      fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));

      _reloadJournal();
      const reloaded = getVoiceJournal();
      assert.equal(reloaded.entries.length, 1);
      assert.equal(reloaded.entries[0].id, "test_persist_1");
      assert.equal(reloaded.communicationInsights[0], "Test insight");
    });
  });

  // -- 2. reflectOnPost — high scorer --

  describe("reflectOnPost — high scorer", () => {
    it("creates a lesson entry and reinforces traits for score >= 7", async () => {
      globalThis.fetch = makeFetchMock("This post connected because it used specific data points.") as any;

      // Seed a trait to test reinforcement
      const journal = _getJournalInternal();
      journal.currentVoiceTraits.push({
        trait: "Uses specific data",
        strength: 5,
        firstObserved: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        evidence: [],
      });

      await reflectOnPost("Test tweet about AI agents", "https://x.com/test/1", 8);

      const updated = getVoiceJournal();
      assert.equal(updated.entries.length, 1);
      assert.equal(updated.entries[0].type, "lesson");
      assert.ok(updated.entries[0].content.includes("specific data"));
      assert.equal(updated.entries[0].source.engagementScore, 8);

      // Trait should be reinforced (+0.5)
      assert.ok(updated.currentVoiceTraits[0].strength > 5);
      assert.equal(updated.currentVoiceTraits[0].evidence.length, 1);
    });
  });

  // -- 3. reflectOnPost — low scorer --

  describe("reflectOnPost — low scorer", () => {
    it("creates a lesson entry and weakens traits for score <= 3", async () => {
      globalThis.fetch = makeFetchMock("This post was too generic and lacked a strong take.") as any;

      const journal = _getJournalInternal();
      journal.currentVoiceTraits.push({
        trait: "Generic statements",
        strength: 5,
        firstObserved: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        evidence: [],
      });

      await reflectOnPost("Boring tweet about stuff", "https://x.com/test/2", 2);

      const updated = getVoiceJournal();
      assert.equal(updated.entries.length, 1);
      assert.equal(updated.entries[0].type, "lesson");

      // Trait should be weakened (-0.3)
      assert.ok(updated.currentVoiceTraits[0].strength < 5);
    });
  });

  // -- 4. reflectOnPost — MrRayG manual rating --

  describe("reflectOnPost — MrRayG manual rating", () => {
    it("creates a correction entry with extra weight for low manual rating", async () => {
      globalThis.fetch = makeFetchMock("MrRayG thinks this was off-brand. Need to be more direct.") as any;

      const journal = _getJournalInternal();
      journal.currentVoiceTraits.push({
        trait: "Direct communication",
        strength: 6,
        firstObserved: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        evidence: [],
      });

      await reflectOnPost("Bad tweet", "https://x.com/test/3", 4, 1);

      const updated = getVoiceJournal();
      assert.equal(updated.entries.length, 1);
      assert.equal(updated.entries[0].type, "correction");
      assert.ok(updated.entries[0].source.userFeedback?.includes("MrRayG"));

      // Manual low rating: extra weight (-0.5 instead of -0.3)
      assert.ok(updated.currentVoiceTraits[0].strength <= 5.5);
    });

    it("reinforces with extra weight for high manual rating", async () => {
      globalThis.fetch = makeFetchMock("MrRayG loved the authenticity here.") as any;

      const journal = _getJournalInternal();
      journal.currentVoiceTraits.push({
        trait: "Authentic voice",
        strength: 5,
        firstObserved: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        evidence: [],
      });

      await reflectOnPost("Great tweet", "https://x.com/test/4", 8, 5);

      const updated = getVoiceJournal();
      assert.equal(updated.entries.length, 1);
      assert.equal(updated.entries[0].type, "lesson");

      // Manual high rating: extra weight (+0.8 instead of +0.5)
      assert.ok(updated.currentVoiceTraits[0].strength >= 5.8);
    });
  });

  // -- 5. reflectOnPost — skips mid-range --

  describe("reflectOnPost — skips mid-range", () => {
    it("does nothing for score 4-6 without manual rating", async () => {
      const fetchMock = makeFetchMock("Should not be called");
      globalThis.fetch = fetchMock as any;

      await reflectOnPost("Average tweet", "https://x.com/test/5", 5);

      const updated = getVoiceJournal();
      assert.equal(updated.entries.length, 0);
      assert.equal(fetchMock.mock.callCount(), 0);
    });

    it("does nothing for mid-range manual rating (3)", async () => {
      const fetchMock = makeFetchMock("Should not be called");
      globalThis.fetch = fetchMock as any;

      await reflectOnPost("Average tweet", "https://x.com/test/6", 5, 3);

      const updated = getVoiceJournal();
      assert.equal(updated.entries.length, 0);
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  });

  // -- 6. dailyReflection --

  describe("dailyReflection", () => {
    it("updates communicationInsights and audienceInsights", async () => {
      let callCount = 0;
      globalThis.fetch = mock.fn(async () => {
        callCount++;
        const content = callCount === 1
          ? "Today I learned that specific numbers resonate more than vague claims."
          : "Uses data-driven storytelling";
        return {
          json: async () => ({
            choices: [{ message: { content } }],
          }),
        };
      }) as any;

      const posts = [
        { text: "Great tweet about AI agents with 94% accuracy", score: 8, url: "https://x.com/test/10" },
        { text: "Another solid tweet", score: 7, url: "https://x.com/test/11" },
      ];

      await dailyReflection(posts);

      const updated = getVoiceJournal();
      assert.ok(updated.communicationInsights.length > 0);
      assert.ok(updated.audienceInsights.length > 0);
      assert.ok(updated.lastReflection.length > 0);
      assert.equal(updated.entries.length, 1);
      assert.equal(updated.entries[0].type, "reflection");
    });
  });

  // -- 7. dailyReflection — idempotent --

  describe("dailyReflection — idempotent", () => {
    it("does not run twice on the same day", async () => {
      const fetchMock = makeFetchMock("Daily insight");
      globalThis.fetch = fetchMock as any;

      await dailyReflection([{ text: "Test", score: 5, url: "" }]);
      const callsAfterFirst = fetchMock.mock.callCount();
      assert.ok(callsAfterFirst > 0);

      // Second call on same day should be skipped
      await dailyReflection([{ text: "Test 2", score: 6, url: "" }]);
      assert.equal(fetchMock.mock.callCount(), callsAfterFirst);
    });
  });

  // -- 8. dailyReflection — prunes to 100 entries --

  describe("dailyReflection — pruning", () => {
    it("prunes journal to 100 entries max, keeping milestones", async () => {
      globalThis.fetch = makeFetchMock("Pruning test reflection") as any;

      const journal = _getJournalInternal();
      // Fill with 105 entries: 3 milestones + 102 lessons
      for (let i = 0; i < 3; i++) {
        journal.entries.push({
          id: `milestone_${i}`,
          date: new Date(Date.now() - (110 - i) * 86400000).toISOString(),
          type: "milestone",
          content: `Milestone ${i}`,
          source: {},
        });
      }
      for (let i = 0; i < 102; i++) {
        journal.entries.push({
          id: `lesson_${i}`,
          date: new Date(Date.now() - (100 - i) * 86400000).toISOString(),
          type: "lesson",
          content: `Lesson ${i}`,
          source: {},
        });
      }

      await dailyReflection([{ text: "Test", score: 5, url: "" }]);

      const updated = getVoiceJournal();
      assert.ok(updated.entries.length <= 100, `Expected <= 100 entries, got ${updated.entries.length}`);

      // All milestones should survive
      const milestones = updated.entries.filter(e => e.type === "milestone");
      assert.equal(milestones.length, 3, "All milestones should be preserved");
    });
  });

  // -- 9. getEvolutionContext — compact string --

  describe("getEvolutionContext", () => {
    it("returns compact string under 500 chars with data", () => {
      const journal = _getJournalInternal();
      journal.communicationInsights = [
        "Specific numbers work better than vague claims",
        "Questions drive engagement",
        "Short sentences have more impact",
      ];
      journal.currentVoiceTraits = [
        { trait: "Data-driven", strength: 8, firstObserved: "", lastReinforced: "", evidence: [] },
        { trait: "Question asker", strength: 7, firstObserved: "", lastReinforced: "", evidence: [] },
        { trait: "Direct", strength: 6, firstObserved: "", lastReinforced: "", evidence: [] },
      ];
      journal.audienceInsights = [
        "Builders want actionable specifics",
        "Weekend posts get less engagement",
      ];

      const ctx = getEvolutionContext();
      assert.ok(ctx.length <= 500, `Expected <= 500 chars, got ${ctx.length}`);
      assert.ok(ctx.includes("YOUR GROWTH"));
      assert.ok(ctx.includes("Voice traits that work"));
      assert.ok(ctx.includes("Your audience responds to"));
    });
  });

  // -- 10. getEvolutionContext — bootstrap message --

  describe("getEvolutionContext — empty journal", () => {
    it("returns bootstrap message when journal is empty", () => {
      const ctx = getEvolutionContext();
      assert.ok(ctx.includes("new"), `Expected bootstrap message, got: ${ctx}`);
      assert.ok(ctx.length <= 500);
    });
  });

  // -- 11. VoiceTrait natural selection --

  describe("VoiceTrait natural selection", () => {
    it("only keeps top 5 traits by strength", async () => {
      globalThis.fetch = makeFetchMock("Traits are being tested") as any;

      const journal = _getJournalInternal();
      // Add 7 traits
      for (let i = 0; i < 7; i++) {
        journal.currentVoiceTraits.push({
          trait: `Trait ${i}`,
          strength: i + 2,
          firstObserved: new Date().toISOString(),
          lastReinforced: new Date().toISOString(),
          evidence: [],
        });
      }

      // Trigger reflection which adjusts traits (strength change triggers pruning)
      await reflectOnPost("Good tweet", "https://x.com/test/20", 9);

      const updated = getVoiceJournal();
      assert.ok(updated.currentVoiceTraits.length <= 5, `Expected <= 5 traits, got ${updated.currentVoiceTraits.length}`);

      // Strongest traits should survive
      const strengths = updated.currentVoiceTraits.map(t => t.strength);
      for (const s of strengths) {
        assert.ok(s >= 3, "Weakest traits should have been pruned");
      }
    });
  });

  // -- 12. VoiceTrait evidence tracking --

  describe("VoiceTrait evidence tracking", () => {
    it("caps evidence array at 3 URLs", async () => {
      globalThis.fetch = makeFetchMock("Evidence tracking test") as any;

      const journal = _getJournalInternal();
      journal.currentVoiceTraits.push({
        trait: "Evidence test trait",
        strength: 5,
        firstObserved: new Date().toISOString(),
        lastReinforced: new Date().toISOString(),
        evidence: ["https://x.com/1", "https://x.com/2", "https://x.com/3"],
      });

      // This should add a 4th URL but cap at 3
      await reflectOnPost("New tweet", "https://x.com/4", 9);

      const updated = getVoiceJournal();
      const trait = updated.currentVoiceTraits[0];
      assert.ok(trait.evidence.length <= 3, `Expected <= 3 evidence URLs, got ${trait.evidence.length}`);
      // The newest URL should be present
      assert.ok(trait.evidence.includes("https://x.com/4"), "Newest URL should be in evidence");
    });
  });
});
