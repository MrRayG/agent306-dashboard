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

  it("boost resolves to the standard-voice tier", () => {
    // Re-routed in the tier-split PR: public-voice content goes to xAI Direct
    // standard-voice (Grok 4.20 non-reasoning) rather than the generic
    // OpenRouter standard Grok.
    assert.equal(getModel("boost"), (models as Record<string, string>)["standard-voice"]);
  });

  it("cyoa resolves to the standard-voice tier", () => {
    assert.equal(getModel("cyoa"), (models as Record<string, string>)["standard-voice"]);
  });

  it("manuscript resolves to the premium-voice tier", () => {
    assert.equal(getModel("manuscript"), (models as Record<string, string>)["premium-voice"]);
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

  it("live-social tier is exposed in getModelConfig().models (xAI-hosted)", () => {
    const { models } = getModelConfig();
    const liveSocial = (models as Record<string, string>)["live-social"];
    assert.ok(liveSocial.startsWith("x-ai/"), `live-social must be xAI-hosted, got ${liveSocial}`);
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
    assert.equal(getModel("research-brief"), (models as Record<string, string>)["premium-voice"]);
    // hypothesis-evaluation now routes to frontier-factual (Grok 4.20 Reasoning)
    // — the 17%-hallucination flagship — not the collapsed "frontier" bucket.
    assert.equal(getModel("hypothesis-evaluation"), (models as Record<string, string>)["frontier-factual"]);
  });
});

describe("getModel — router tier split (bug 1 fix)", () => {
  const { models } = getModelConfig();

  it("frontier-factual resolves to an xAI Grok 4.20 Reasoning model", () => {
    const m = getModel("fact-verification");
    assert.ok(m.startsWith("x-ai/"), `frontier-factual must be xAI-hosted, got ${m}`);
    assert.ok(/reasoning/i.test(m), `frontier-factual should be a reasoning variant, got ${m}`);
    assert.equal(m, (models as Record<string, string>)["frontier-factual"]);
  });

  it("frontier-reasoning resolves to anthropic/claude-opus-4.6", () => {
    const m = getModel("architecture");
    assert.equal(m, "anthropic/claude-opus-4.6");
    assert.equal(m, (models as Record<string, string>)["frontier-reasoning"]);
  });

  it("premium-voice resolves to anthropic/claude-sonnet-4.6", () => {
    const m = getModel("manuscript");
    assert.equal(m, "anthropic/claude-sonnet-4.6");
    assert.equal(m, (models as Record<string, string>)["premium-voice"]);
  });

  it("standard-voice resolves to an xAI Grok 4.20 non-reasoning model", () => {
    const m = getModel("article");
    assert.ok(m.startsWith("x-ai/"), `standard-voice must be xAI-hosted, got ${m}`);
    assert.ok(/non-reasoning/i.test(m) || /grok-4\.20$/.test(m), `unexpected standard-voice model: ${m}`);
  });

  it("multi-agent resolves to an xAI multi-agent Grok model", () => {
    const m = getModel("self-debate");
    assert.ok(m.startsWith("x-ai/"));
    assert.ok(/multi-agent/.test(m));
  });

  it("live-research resolves to Perplexity sonar-pro", () => {
    assert.equal(getModel("news-research"), "sonar-pro");
    assert.equal(getModel("breakthrough-research"), "sonar-pro");
    assert.equal(getModel("evidence-research"), "sonar-pro");
  });

  it("backward-compat: `frontier` alias still resolves (→ frontier-reasoning)", () => {
    assert.equal((models as Record<string, string>).frontier, (models as Record<string, string>)["frontier-reasoning"]);
  });

  it("backward-compat: `premium` alias still resolves (→ premium-voice)", () => {
    assert.equal((models as Record<string, string>).premium, (models as Record<string, string>)["premium-voice"]);
  });

  it("task families route to the expected tier", () => {
    assert.equal(getModel("hypothesis-evaluation"), (models as Record<string, string>)["frontier-factual"]);
    assert.equal(getModel("fact-verification"),     (models as Record<string, string>)["frontier-factual"]);
    assert.equal(getModel("red-flag-analysis"),     (models as Record<string, string>)["frontier-factual"]);
    assert.equal(getModel("architecture"),          (models as Record<string, string>)["frontier-reasoning"]);
    assert.equal(getModel("complex-code-reasoning"),(models as Record<string, string>)["frontier-reasoning"]);
    assert.equal(getModel("manuscript"),            (models as Record<string, string>)["premium-voice"]);
    assert.equal(getModel("blog"),                  (models as Record<string, string>)["premium-voice"]);
    assert.equal(getModel("article"),               (models as Record<string, string>)["standard-voice"]);
    assert.equal(getModel("reply"),                 (models as Record<string, string>)["standard-voice"]);
    assert.equal(getModel("boost"),                 (models as Record<string, string>)["standard-voice"]);
    assert.equal(getModel("triad"),                 (models as Record<string, string>)["multi-agent"]);
    assert.equal(getModel("signal-brief"),          (models as Record<string, string>)["live-social"]);
    assert.equal(getModel("news-research"),         (models as Record<string, string>)["live-research"]);
    assert.equal(getModel("scoring"),               models.routine);
    assert.equal(getModel("classification"),        models.routine);
  });
});

describe("getModel — env overrides for new tiers", () => {
  const keys = [
    "MODEL_FRONTIER_FACTUAL",
    "MODEL_FRONTIER_REASONING",
    "MODEL_PREMIUM_VOICE",
    "MODEL_STANDARD_VOICE",
    "MODEL_MULTI_AGENT",
    "MODEL_LIVE_SOCIAL",
    "MODEL_LIVE_RESEARCH",
  ];

  it("each env override takes effect when set", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    try {
      process.env.MODEL_FRONTIER_FACTUAL   = "x-ai/custom-factual";
      process.env.MODEL_FRONTIER_REASONING = "anthropic/custom-reasoning";
      process.env.MODEL_PREMIUM_VOICE      = "anthropic/custom-voice";
      process.env.MODEL_STANDARD_VOICE     = "x-ai/custom-standard-voice";
      process.env.MODEL_MULTI_AGENT        = "x-ai/custom-multi-agent";
      process.env.MODEL_LIVE_SOCIAL        = "x-ai/custom-live-social";
      process.env.MODEL_LIVE_RESEARCH      = "custom-sonar";

      // Re-import with a cache-busting query string so the module re-reads env.
      const mod = await import(`../modelRouter.js?t=${Date.now()}`);
      const { models } = mod.getModelConfig();
      assert.equal(models["frontier-factual"],   "x-ai/custom-factual");
      assert.equal(models["frontier-reasoning"], "anthropic/custom-reasoning");
      assert.equal(models["premium-voice"],      "anthropic/custom-voice");
      assert.equal(models["standard-voice"],     "x-ai/custom-standard-voice");
      assert.equal(models["multi-agent"],        "x-ai/custom-multi-agent");
      assert.equal(models["live-social"],        "x-ai/custom-live-social");
      assert.equal(models["live-research"],      "custom-sonar");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
