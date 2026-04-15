/**
 * Tests for session memory and anaphora resolution.
 *
 * Run: npx tsx --test server/__tests__/sessionMemory.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getOrCreateSession,
  addTurn,
  getSessionContext,
  resolveReferences,
  closeExpiredSessions,
  extractEntitiesFromText,
  getActiveSessionCount,
  getAllSessions,
} from "../sessionMemory.js";

// Close all sessions before each test to get clean state
beforeEach(() => {
  closeExpiredSessions(0); // TTL 0 = close everything
});

describe("extractEntitiesFromText", () => {
  it("extracts capitalized noun phrases", () => {
    const entities = extractEntitiesFromText("OpenAI released GPT yesterday");
    assert.ok(entities.includes("OpenAI"));
    assert.ok(entities.includes("GPT"));
  });

  it("skips common words like I, The, This", () => {
    const entities = extractEntitiesFromText("I think This is The best model");
    assert.ok(!entities.includes("I"));
    assert.ok(!entities.includes("This"));
    assert.ok(!entities.includes("The"));
  });

  it("skips very short matches", () => {
    const entities = extractEntitiesFromText("today OpenAI announced results");
    assert.ok(entities.includes("OpenAI"));
    // Single character words in isolation should be filtered
    const entities2 = extractEntitiesFromText("X is interesting");
    // "X" is 1 char → filtered by length check
    assert.ok(!entities2.includes("X"));
  });

  it("returns empty array for no entities", () => {
    const entities = extractEntitiesFromText("this is all lowercase text");
    assert.equal(entities.length, 0);
  });

  it("returns unique entities", () => {
    const entities = extractEntitiesFromText("OpenAI and OpenAI again");
    const openaiCount = entities.filter(e => e === "OpenAI").length;
    assert.equal(openaiCount, 1);
  });
});

describe("session lifecycle", () => {
  it("creates a new session for unknown user", () => {
    const session = getOrCreateSession("alice");
    assert.equal(session.username, "alice");
    assert.equal(session.turns.length, 0);
    assert.deepEqual(session.entityTable, {});
  });

  it("normalizes username (lowercase, strip @)", () => {
    const session = getOrCreateSession("@Alice");
    assert.equal(session.username, "alice");
  });

  it("returns same session for same user within TTL", () => {
    const s1 = getOrCreateSession("bob");
    addTurn("bob", { direction: "them", text: "hello", kbEntryIds: [], timestamp: Date.now() });
    const s2 = getOrCreateSession("bob");
    assert.equal(s2.turns.length, 1); // same session, has the turn
  });

  it("creates fresh session if expired", () => {
    const session = getOrCreateSession("charlie");
    addTurn("charlie", { direction: "them", text: "hello", kbEntryIds: [], timestamp: Date.now() });
    // Manually expire by setting lastTurnAt far in the past
    session.lastTurnAt = Date.now() - 31 * 60 * 1000; // 31 minutes ago

    const fresh = getOrCreateSession("charlie"); // default 30 min TTL
    assert.equal(fresh.turns.length, 0); // fresh session
  });
});

describe("addTurn", () => {
  it("adds turns to the session", () => {
    getOrCreateSession("dave");
    addTurn("dave", { direction: "them", text: "What about OpenAI?", kbEntryIds: [], timestamp: Date.now() });
    addTurn("dave", { direction: "us", text: "OpenAI is interesting", kbEntryIds: ["kb-1"], timestamp: Date.now() });

    const session = getOrCreateSession("dave");
    assert.equal(session.turns.length, 2);
    assert.equal(session.turns[0].direction, "them");
    assert.equal(session.turns[1].direction, "us");
  });

  it("updates entity table from turn text", () => {
    getOrCreateSession("eve");
    addTurn("eve", { direction: "them", text: "What do you think about GPT-5?", kbEntryIds: [], timestamp: Date.now() });

    const session = getOrCreateSession("eve");
    // "GPT" should be resolved to "it"/"that"/"this" since it was the last entity
    assert.ok(session.entityTable["it"] !== undefined);
  });

  it("tracks model entities specifically", () => {
    getOrCreateSession("frank");
    addTurn("frank", { direction: "them", text: "Claude is better than GPT", kbEntryIds: [], timestamp: Date.now() });

    const session = getOrCreateSession("frank");
    // "the model" should resolve to the last model-like entity
    assert.ok(session.entityTable["the model"] !== undefined);
  });

  it("caps turns at 10", () => {
    getOrCreateSession("grace");
    for (let i = 0; i < 15; i++) {
      addTurn("grace", { direction: "them", text: `Message ${i}`, kbEntryIds: [], timestamp: Date.now() });
    }

    const session = getOrCreateSession("grace");
    assert.equal(session.turns.length, 10);
    // Should keep the most recent 10
    assert.ok(session.turns[0].text.includes("Message 5"));
  });

  it("silently skips if session does not exist", () => {
    // Don't create session, just add turn — should not throw
    assert.doesNotThrow(() => {
      addTurn("nobody", { direction: "them", text: "hello", kbEntryIds: [], timestamp: Date.now() });
    });
  });
});

describe("getSessionContext", () => {
  it("returns empty string for unknown user", () => {
    assert.equal(getSessionContext("unknown"), "");
  });

  it("returns empty string for session with no turns", () => {
    getOrCreateSession("henry");
    assert.equal(getSessionContext("henry"), "");
  });

  it("returns formatted context with turns", () => {
    getOrCreateSession("ivy");
    addTurn("ivy", { direction: "them", text: "What about scaling laws?", kbEntryIds: [], timestamp: Date.now() });
    addTurn("ivy", { direction: "us", text: "Scaling laws show diminishing returns", kbEntryIds: [], timestamp: Date.now() });

    const ctx = getSessionContext("ivy");
    assert.ok(ctx.includes("ACTIVE SESSION"));
    assert.ok(ctx.includes("They said"));
    assert.ok(ctx.includes("You replied"));
    assert.ok(ctx.includes("scaling laws"));
    assert.ok(ctx.includes("coherence"));
  });

  it("includes entity table in context", () => {
    getOrCreateSession("jack");
    addTurn("jack", { direction: "them", text: "OpenAI just released something", kbEntryIds: [], timestamp: Date.now() });

    const ctx = getSessionContext("jack");
    assert.ok(ctx.includes("Context:"));
    assert.ok(ctx.includes("OpenAI") || ctx.includes("openai"));
  });
});

describe("resolveReferences", () => {
  it("returns text unchanged when no entity table", () => {
    const session = getOrCreateSession("kate");
    const result = resolveReferences("What about it?", session);
    assert.equal(result, "What about it?");
  });

  it("annotates pronouns with resolved entities", () => {
    const session = getOrCreateSession("leo");
    session.entityTable["it"] = "GPT-5";
    session.entityTable["that"] = "GPT-5";

    const result = resolveReferences("What about it?", session);
    assert.ok(result.includes("[ref: GPT-5]"));
  });

  it("annotates 'the model' reference", () => {
    const session = getOrCreateSession("mia");
    session.entityTable["the model"] = "Claude";

    const result = resolveReferences("Is the model open source?", session);
    assert.ok(result.includes("[ref: Claude]"));
  });

  it("preserves original text alongside annotations", () => {
    const session = getOrCreateSession("nina");
    session.entityTable["it"] = "Llama-3";

    const result = resolveReferences("Tell me more about it", session);
    // Should contain both the pronoun and the resolution
    assert.ok(result.includes("it"));
    assert.ok(result.includes("Llama-3"));
  });
});

describe("closeExpiredSessions", () => {
  it("closes sessions older than TTL", () => {
    const session = getOrCreateSession("oscar");
    addTurn("oscar", { direction: "them", text: "hello", kbEntryIds: [], timestamp: Date.now() });
    session.lastTurnAt = Date.now() - 31 * 60 * 1000; // 31 min ago

    const closed = closeExpiredSessions(30);
    assert.equal(closed, 1);
    assert.equal(getActiveSessionCount(), 0);
  });

  it("keeps sessions within TTL", () => {
    getOrCreateSession("peter");
    addTurn("peter", { direction: "them", text: "hello", kbEntryIds: [], timestamp: Date.now() });

    const closed = closeExpiredSessions(30);
    assert.equal(closed, 0);
    assert.equal(getActiveSessionCount(), 1);
  });
});

describe("getAllSessions", () => {
  it("returns all active sessions", () => {
    getOrCreateSession("quinn");
    addTurn("quinn", { direction: "them", text: "hi", kbEntryIds: [], timestamp: Date.now() });
    getOrCreateSession("rachel");
    addTurn("rachel", { direction: "them", text: "hey", kbEntryIds: [], timestamp: Date.now() });

    const sessions = getAllSessions();
    assert.equal(sessions.length, 2);
    assert.ok(sessions.some(s => s.username === "quinn"));
    assert.ok(sessions.some(s => s.username === "rachel"));
  });
});

describe("getActiveSessionCount", () => {
  it("returns 0 with no sessions", () => {
    assert.equal(getActiveSessionCount(), 0);
  });

  it("counts active sessions", () => {
    getOrCreateSession("sam");
    getOrCreateSession("tara");
    assert.equal(getActiveSessionCount(), 2);
  });
});
