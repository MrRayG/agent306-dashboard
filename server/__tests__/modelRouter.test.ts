/**
 * Tests for modelRouter — PR #4 task alias normalization.
 *
 * Verifies:
 *   - normalizeTaskName() replaces underscores with hyphens and lowercases.
 *   - getModel() resolves underscore-, hyphen-, and mixed-case forms identically.
 *   - The new explicit aliases (academy/boost/cyoa/manuscript/conversation-insight/
 *     research-scan) resolve to the expected tier models.
 *   - Unknown tasks still fall back to the "standard" tier default.
 *
 * Run: npx tsx --test server/__tests__/modelRouter.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModelConfig, normalizeTaskName } from "../modelRouter.js";

describe("normalizeTaskName", () => {
  it("replaces underscores with hyphens", () => {
    assert.equal(normalizeTaskName("conversation_insight"), "conversation-insight");
    assert.equal(normalizeTaskName("hypothesis_resolution"), "hypothesis-resolution");
  });

  it("lowercases uppercase characters", () => {
    assert.equal(normalizeTaskName("ACADEMY"), "academy");
    assert.equal(normalizeTaskName("Manuscript"), "manuscript");
  });

  it("combines underscore → hyphen with lowercasing", () => {
    assert.equal(normalizeTaskName("Research_Scan"), "research-scan");
    assert.equal(normalizeTaskName("CONVERSATION_INSIGHT"), "conversation-insight");
  });

  it("leaves already-canonical names unchanged", () => {
    assert.equal(normalizeTaskName("podcast-script"), "podcast-script");
    assert.equal(normalizeTaskName("reflection"), "reflection");
  });
});

describe("getModel — underscore normalization", () => {
  it("resolves underscore form identically to hyphen form", () => {
    assert.equal(getModel("conversation_insight"), getModel("conversation-insight"));
    assert.equal(getModel("research_scan"), getModel("research-scan"));
    assert.equal(getModel("hypothesis_resolution"), getModel("hypothesis-resolution"));
    assert.equal(getModel("self_evolution_reflection"), getModel("self-evolution-reflection"));
    assert.equal(getModel("topic_quality_evaluation"), getModel("topic-quality-evaluation"));
  });

  it("resolves mixed-case form identically to lowercase form", () => {
    assert.equal(getModel("Academy"), getModel("academy"));
    assert.equal(getModel("BOOST"), getModel("boost"));
    assert.equal(getModel("Conversation_Insight"), getModel("conversation-insight"));
  });
});

describe("getModel — new aliases resolve to expected tier", () => {
  const config = getModelConfig();
  const { models } = config;

  it("academy resolves to the premium tier", () => {
    assert.equal(getModel("academy"), models.premium);
  });

  it("boost resolves to the standard tier", () => {
    assert.equal(getModel("boost"), models.standard);
  });

  it("cyoa resolves to the standard tier", () => {
    assert.equal(getModel("cyoa"), models.standard);
  });

  it("manuscript resolves to the premium tier", () => {
    assert.equal(getModel("manuscript"), models.premium);
  });

  it("conversation-insight and its underscore alias resolve to routine", () => {
    assert.equal(getModel("conversation-insight"), models.routine);
    assert.equal(getModel("conversation_insight"), models.routine);
  });

  it("research-scan and its underscore alias resolve to routine", () => {
    assert.equal(getModel("research-scan"), models.routine);
    assert.equal(getModel("research_scan"), models.routine);
  });
});

describe("getModel — live-social tier (Wave 1 follow-up)", () => {
  it("signal-brief resolves to the live-social tier (Grok 4.20, xAI-hosted for x_search)", () => {
    const model = getModel("signal-brief");
    assert.equal(model, "x-ai/grok-4.20");
    // Must be xAI-hosted so toXAINativeModel() returns non-null in postXSearchResponses.
    assert.ok(model.startsWith("x-ai/"), `signal-brief must resolve to an xAI model, got ${model}`);
  });

  it("signal_brief underscore form resolves identically to signal-brief", () => {
    assert.equal(getModel("signal_brief"), getModel("signal-brief"));
  });

  it("does not regress signal-brief to routine (Gemini)", () => {
    const { models } = getModelConfig();
    assert.notEqual(getModel("signal-brief"), models.routine);
  });

  it("live-social tier is exposed in getModelConfig().models", () => {
    const { models } = getModelConfig();
    assert.equal((models as Record<string, string>)["live-social"], "x-ai/grok-4.20");
  });
});

describe("getModel — explicit sweep entries (Wave 1 follow-up)", () => {
  const { models } = getModelConfig();

  it("exploration-synthesis resolves to standard (explicit, previously default)", () => {
    assert.equal(getModel("exploration-synthesis"), models.standard);
    assert.equal(getModel("exploration_synthesis"), models.standard);
  });

  it("goal-generation resolves to standard (explicit, previously default)", () => {
    assert.equal(getModel("goal-generation"), models.standard);
  });

  it("hypothesis-consolidation resolves to standard (explicit, previously default)", () => {
    assert.equal(getModel("hypothesis-consolidation"), models.standard);
  });
});

describe("getModel — default fallback", () => {
  const { models } = getModelConfig();

  it("unknown tasks fall back to the standard tier", () => {
    assert.equal(getModel("some-never-seen-task-xyz"), models.standard);
    assert.equal(getModel("totally_unknown"), models.standard);
    assert.equal(getModel(""), models.standard);
  });

  it("known tasks still resolve to their configured tier (no regression)", () => {
    // Sanity spot-checks across the tier map.
    assert.equal(getModel("reflection"), models.routine);
    assert.equal(getModel("self-debate"), models.standard);
    assert.equal(getModel("research-brief"), models.premium);
    assert.equal(getModel("hypothesis-evaluation"), models.frontier);
  });
});
