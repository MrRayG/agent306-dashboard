/**
 * Tests for the cycle context accumulator.
 *
 * Run: npx tsx --test server/__tests__/cycleContext.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  startCycle,
  recordEvent,
  getCycleNarrative,
  getEntityContext,
  getRecentFindings,
  endCycle,
  getCycleContext,
  isCycleActive,
} from "../cycleContext.js";

// Reset state before each test by starting a fresh cycle
beforeEach(() => {
  // endCycle clears the state; if no cycle active it returns a default summary
  try { endCycle(); } catch {}
});

describe("cycleContext lifecycle", () => {
  it("isCycleActive returns false when no cycle started", () => {
    assert.equal(isCycleActive(), false);
  });

  it("startCycle activates the cycle", () => {
    startCycle();
    assert.equal(isCycleActive(), true);
  });

  it("endCycle deactivates the cycle and returns summary", () => {
    startCycle();
    assert.equal(isCycleActive(), true);
    const summary = endCycle();
    assert.equal(isCycleActive(), false);
    assert.ok(summary.cycleId.startsWith("cycle_"));
    assert.equal(summary.totalEvents, 0);
  });

  it("endCycle without active cycle returns default summary", () => {
    const summary = endCycle();
    assert.equal(summary.cycleId, "none");
    assert.equal(summary.totalEvents, 0);
  });
});

describe("recordEvent", () => {
  it("never throws even without active cycle", () => {
    // Should silently skip — no active cycle
    assert.doesNotThrow(() => {
      recordEvent({
        phase: "intake",
        type: "kb_added",
        summary: "test",
        entityMentions: [],
        relatedEntryIds: [],
      });
    });
  });

  it("records events and tracks count", () => {
    startCycle();
    recordEvent({
      phase: "intake",
      type: "kb_added",
      summary: "Ingested 5 new items",
      entityMentions: ["OpenAI"],
      relatedEntryIds: ["kb-1", "kb-2"],
    });
    recordEvent({
      phase: "hypothesis",
      type: "hypothesis_tested",
      summary: "Tested H-42: SUPPORTED",
      entityMentions: ["GPT-5", "OpenAI"],
      relatedEntryIds: ["kb-3"],
    });

    const ctx = getCycleContext();
    assert.ok(ctx !== null);
    assert.equal(ctx!.eventCount, 2);
    assert.equal(ctx!.events.length, 2);
    assert.equal(ctx!.kbEntriesUsed, 3); // kb-1, kb-2, kb-3
  });

  it("adds timestamps to events", () => {
    startCycle();
    const before = Date.now();
    recordEvent({
      phase: "intake",
      type: "kb_added",
      summary: "test",
      entityMentions: [],
      relatedEntryIds: [],
    });
    const after = Date.now();

    const ctx = getCycleContext();
    assert.ok(ctx!.events[0].timestamp >= before);
    assert.ok(ctx!.events[0].timestamp <= after);
  });
});

describe("entity registry", () => {
  it("tracks entity mentions across events", () => {
    startCycle();
    recordEvent({
      phase: "intake",
      type: "kb_added",
      summary: "Found OpenAI paper",
      entityMentions: ["OpenAI", "GPT-5"],
      relatedEntryIds: [],
    });
    recordEvent({
      phase: "hypothesis",
      type: "hypothesis_tested",
      summary: "Tested OpenAI claim",
      entityMentions: ["OpenAI", "Scaling Laws"],
      relatedEntryIds: [],
    });

    const openaiEvents = getEntityContext("OpenAI");
    assert.equal(openaiEvents.length, 2);

    const gptEvents = getEntityContext("GPT-5");
    assert.equal(gptEvents.length, 1);

    const scalingEvents = getEntityContext("Scaling Laws");
    assert.equal(scalingEvents.length, 1);
  });

  it("entity lookup is case-insensitive", () => {
    startCycle();
    recordEvent({
      phase: "intake",
      type: "kb_added",
      summary: "test",
      entityMentions: ["OpenAI"],
      relatedEntryIds: [],
    });

    assert.equal(getEntityContext("openai").length, 1);
    assert.equal(getEntityContext("OPENAI").length, 1);
  });

  it("returns empty array for unknown entity", () => {
    startCycle();
    assert.deepEqual(getEntityContext("Unknown"), []);
  });

  it("returns empty array when no cycle active", () => {
    assert.deepEqual(getEntityContext("OpenAI"), []);
  });
});

describe("getRecentFindings", () => {
  it("returns recent events", () => {
    startCycle();
    for (let i = 0; i < 15; i++) {
      recordEvent({
        phase: i < 5 ? "intake" : "hypothesis",
        type: "kb_added",
        summary: `Event ${i}`,
        entityMentions: [],
        relatedEntryIds: [],
      });
    }

    const all = getRecentFindings();
    assert.equal(all.length, 10); // default limit

    const intake = getRecentFindings("intake");
    assert.equal(intake.length, 5);

    const hypo = getRecentFindings("hypothesis", 3);
    assert.equal(hypo.length, 3);
  });

  it("returns empty array when no cycle active", () => {
    assert.deepEqual(getRecentFindings(), []);
  });
});

describe("getCycleNarrative", () => {
  it("returns empty string when no cycle active", () => {
    assert.equal(getCycleNarrative(), "");
  });

  it("returns empty string when no events recorded", () => {
    startCycle();
    assert.equal(getCycleNarrative(), "");
  });

  it("builds narrative with phase sections", () => {
    startCycle();
    recordEvent({
      phase: "intake",
      type: "kb_added",
      summary: "Ingested 5 items",
      entityMentions: ["OpenAI"],
      relatedEntryIds: [],
    });
    recordEvent({
      phase: "hypothesis",
      type: "hypothesis_tested",
      summary: "Tested H-42",
      entityMentions: ["GPT-5"],
      relatedEntryIds: [],
    });

    const narrative = getCycleNarrative();
    assert.ok(narrative.includes("CYCLE CONTEXT"));
    assert.ok(narrative.includes("[INTAKE]"));
    assert.ok(narrative.includes("[HYPOTHESIS]"));
    assert.ok(narrative.includes("Ingested 5 items"));
    assert.ok(narrative.includes("Tested H-42"));
    assert.ok(narrative.includes("[ENTITIES]"));
    assert.ok(narrative.includes("openai"));
  });

  it("truncates when over maxChars", () => {
    startCycle();
    for (let i = 0; i < 100; i++) {
      recordEvent({
        phase: "intake",
        type: "kb_added",
        summary: `Event with a reasonably long description number ${i} that takes up space in the narrative output`,
        entityMentions: [`Entity${i}`],
        relatedEntryIds: [],
      });
    }

    const short = getCycleNarrative(200);
    assert.ok(short.length <= 200);
    assert.ok(short.includes("truncated"));
  });
});

describe("endCycle summary", () => {
  it("produces correct phase breakdown", () => {
    startCycle();
    recordEvent({ phase: "intake", type: "kb_added", summary: "a", entityMentions: [], relatedEntryIds: [] });
    recordEvent({ phase: "intake", type: "kb_added", summary: "b", entityMentions: [], relatedEntryIds: [] });
    recordEvent({ phase: "hypothesis", type: "hypothesis_tested", summary: "c", entityMentions: [], relatedEntryIds: [] });

    const summary = endCycle();
    assert.equal(summary.totalEvents, 3);
    assert.equal(summary.phaseBreakdown["intake"], 2);
    assert.equal(summary.phaseBreakdown["hypothesis"], 1);
  });

  it("includes top entities in summary", () => {
    startCycle();
    recordEvent({ phase: "intake", type: "kb_added", summary: "a", entityMentions: ["OpenAI", "GPT-5"], relatedEntryIds: [] });
    recordEvent({ phase: "intake", type: "kb_added", summary: "b", entityMentions: ["OpenAI"], relatedEntryIds: [] });

    const summary = endCycle();
    assert.equal(summary.topEntities[0].name, "openai");
    assert.equal(summary.topEntities[0].mentions, 2);
  });

  it("tracks KB entries used", () => {
    startCycle();
    recordEvent({ phase: "intake", type: "kb_added", summary: "a", entityMentions: [], relatedEntryIds: ["kb-1", "kb-2"] });
    recordEvent({ phase: "intake", type: "kb_added", summary: "b", entityMentions: [], relatedEntryIds: ["kb-2", "kb-3"] });

    const summary = endCycle();
    assert.equal(summary.kbEntriesUsed, 3); // kb-1, kb-2, kb-3 (deduped)
  });
});
