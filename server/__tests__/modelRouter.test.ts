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
import { getModel, getModelConfig, normalizeTaskName, resolveTask } from "../modelRouter.js";

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
  it("signal-brief resolves to the live-social tier (Grok 4.20 non-reasoning, xAI-hosted for x_search)", () => {
    const model = getModel("signal-brief");
    assert.equal(model, "x-ai/grok-4.20-non-reasoning");
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
    assert.equal((models as Record<string, string>)["live-social"], "x-ai/grok-4.20-non-reasoning");
  });
});

describe("getModel — explicit sweep entries (Wave 1 follow-up)", () => {
  const { models } = getModelConfig();

  it("exploration-synthesis resolves to standard-voice (explicit)", () => {
    assert.equal(getModel("exploration-synthesis"), models["standard-voice"]);
    assert.equal(getModel("exploration_synthesis"), models["standard-voice"]);
  });

  it("goal-generation resolves to standard-voice (explicit)", () => {
    assert.equal(getModel("goal-generation"), models["standard-voice"]);
  });

  it("hypothesis-consolidation resolves to standard-voice (explicit)", () => {
    assert.equal(getModel("hypothesis-consolidation"), models["standard-voice"]);
  });
});

describe("getModel — default fallback", () => {
  const { models } = getModelConfig();

  it("unknown tasks fall back to the standard-voice tier", () => {
    assert.equal(getModel("some-never-seen-task-xyz"), models["standard-voice"]);
    assert.equal(getModel("totally_unknown"), models["standard-voice"]);
    assert.equal(getModel(""), models["standard-voice"]);
  });

  it("known tasks still resolve to their configured tier (no regression)", () => {
    assert.equal(getModel("reflection"), models.routine);
    assert.equal(getModel("self-debate"), models["standard-voice"]);
    assert.equal(getModel("research-brief"), models["premium-voice"]);
    // hypothesis-evaluation moved to frontier-factual (Grok 4.20 Reasoning)
    // in the router-tier-split PR.
    assert.equal(getModel("hypothesis-evaluation"), models["frontier-factual"]);
  });
});

describe("resolveTask — new router-tier-split matrix", () => {
  it("frontier-factual tier resolves to {xai-direct, grok-4.20-reasoning}", () => {
    const r = resolveTask("hypothesis-evaluation");
    assert.equal(r.tier, "frontier-factual");
    assert.equal(r.provider, "xai-direct");
    assert.equal(r.model, "x-ai/grok-4.20-reasoning");
  });

  it("frontier-reasoning tier resolves to {openrouter, claude-opus-4.6}", () => {
    const r = resolveTask("deep-reasoning");
    assert.equal(r.tier, "frontier-reasoning");
    assert.equal(r.provider, "openrouter");
    assert.equal(r.model, "anthropic/claude-opus-4.6");
  });

  it("premium-voice tier resolves to {openrouter, claude-sonnet-4.6}", () => {
    for (const task of ["podcast", "podcast-script", "manuscript", "blog", "long-form"]) {
      const r = resolveTask(task);
      assert.equal(r.tier, "premium-voice", `${task} expected premium-voice`);
      assert.equal(r.provider, "openrouter");
      assert.equal(r.model, "anthropic/claude-sonnet-4.6");
    }
  });

  it("standard-voice tier resolves to {xai-direct, grok-4.20-non-reasoning}", () => {
    for (const task of ["article", "exploration", "reply", "boost", "public-voice"]) {
      const r = resolveTask(task);
      assert.equal(r.tier, "standard-voice", `${task} expected standard-voice`);
      assert.equal(r.provider, "xai-direct");
      assert.equal(r.model, "x-ai/grok-4.20-non-reasoning");
    }
  });

  it("multi-agent tier resolves to {xai-direct, grok-4.20-multi-agent}", () => {
    for (const task of ["triad", "self-debate", "multi-agent"]) {
      const r = resolveTask(task);
      // self-debate stays standard-voice; only triad / multi-agent are multi-agent.
      if (task === "self-debate") {
        assert.equal(r.tier, "standard-voice");
      } else {
        assert.equal(r.tier, "multi-agent");
        assert.equal(r.provider, "xai-direct");
        assert.equal(r.model, "x-ai/grok-4.20-multi-agent");
      }
    }
  });

  it("live-social tier resolves to {xai-direct, grok-4.20-non-reasoning}", () => {
    const r = resolveTask("signal-brief");
    assert.equal(r.tier, "live-social");
    assert.equal(r.provider, "xai-direct");
    assert.equal(r.model, "x-ai/grok-4.20-non-reasoning");
  });

  it("live-research tier resolves to {perplexity, sonar-pro}", () => {
    for (const task of ["news-research", "breakthrough-research", "evidence-research"]) {
      const r = resolveTask(task);
      assert.equal(r.tier, "live-research", `${task} expected live-research`);
      assert.equal(r.provider, "perplexity");
      assert.equal(r.model, "sonar-pro");
    }
  });

  it("routine tier resolves to {openrouter, gemini-3-flash-preview}", () => {
    const r = resolveTask("tier-assignment");
    assert.equal(r.tier, "routine");
    assert.equal(r.provider, "openrouter");
    assert.equal(r.model, "google/gemini-3-flash-preview");
  });

  it("article task specifically resolves to standard-voice grok-4.20-non-reasoning", () => {
    const r = resolveTask("article");
    assert.equal(r.tier, "standard-voice");
    assert.equal(r.provider, "xai-direct");
    assert.equal(r.model, "x-ai/grok-4.20-non-reasoning");
  });

  it("podcast task specifically resolves to premium-voice claude-sonnet-4.6", () => {
    const r = resolveTask("podcast");
    assert.equal(r.tier, "premium-voice");
    assert.equal(r.provider, "openrouter");
    assert.equal(r.model, "anthropic/claude-sonnet-4.6");
  });
});

describe("getModelConfig — backwards-compat aliases", () => {
  const { models } = getModelConfig();

  it("collapsed `frontier` alias still resolves to Claude Opus", () => {
    assert.equal(models.frontier, "anthropic/claude-opus-4.6");
    assert.equal(models.frontier, models["frontier-reasoning"]);
  });

  it("collapsed `premium` alias still resolves to Claude Sonnet", () => {
    assert.equal(models.premium, "anthropic/claude-sonnet-4.6");
    assert.equal(models.premium, models["premium-voice"]);
  });

  it("collapsed `standard` alias still resolves to Grok 4.20 non-reasoning", () => {
    assert.equal(models.standard, "x-ai/grok-4.20-non-reasoning");
    assert.equal(models.standard, models["standard-voice"]);
  });
});

describe("env var overrides (MODEL_* per tier)", () => {
  it("MODEL_FRONTIER_FACTUAL overrides the frontier-factual default", async () => {
    const saved = process.env.MODEL_FRONTIER_FACTUAL;
    process.env.MODEL_FRONTIER_FACTUAL = "x-ai/test-override-frontier-factual";
    try {
      const mod = await import(`../modelRouter.js?t=${Date.now()}-a`);
      assert.equal(mod.getModel("hypothesis-evaluation"), "x-ai/test-override-frontier-factual");
    } finally {
      if (saved === undefined) delete process.env.MODEL_FRONTIER_FACTUAL;
      else process.env.MODEL_FRONTIER_FACTUAL = saved;
    }
  });

  it("MODEL_PREMIUM_VOICE overrides the premium-voice default", async () => {
    const saved = process.env.MODEL_PREMIUM_VOICE;
    process.env.MODEL_PREMIUM_VOICE = "anthropic/test-override-sonnet";
    try {
      const mod = await import(`../modelRouter.js?t=${Date.now()}-b`);
      assert.equal(mod.getModel("podcast"), "anthropic/test-override-sonnet");
    } finally {
      if (saved === undefined) delete process.env.MODEL_PREMIUM_VOICE;
      else process.env.MODEL_PREMIUM_VOICE = saved;
    }
  });

  it("MODEL_LIVE_RESEARCH overrides the live-research default", async () => {
    const saved = process.env.MODEL_LIVE_RESEARCH;
    process.env.MODEL_LIVE_RESEARCH = "sonar-test-override";
    try {
      const mod = await import(`../modelRouter.js?t=${Date.now()}-c`);
      assert.equal(mod.getModel("news-research"), "sonar-test-override");
    } finally {
      if (saved === undefined) delete process.env.MODEL_LIVE_RESEARCH;
      else process.env.MODEL_LIVE_RESEARCH = saved;
    }
  });
});
