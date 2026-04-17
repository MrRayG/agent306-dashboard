/**
 * Tests for PR D + PR J — P5 task tier demotions.
 *
 * PR D demoted 15 structured-output tasks to routine.
 * PR J extends with 3 more (knowledge-gap-scan, goal-evaluation, x_search).
 *
 * Verifies demoted tasks resolve to routine model and that no reasoning /
 * public-facing tasks were accidentally demoted.
 *
 * Run: npx tsx --test server/__tests__/modelRouterDemotions.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const DEMOTED_TO_ROUTINE = [
  // PR D (15 tasks)
  "social-preview",
  "breakthrough-evaluation",
  "topic-quality-evaluation",
  "aspiration-evaluation",
  "analysis-so-what",
  "analysis-assumptions",
  "analysis-intake",
  "signal-collection",
  // signal_brief promoted from "routine" to the new "live-social" tier
  // (Wave 1 follow-up) — it invokes postXSearchResponses which requires an
  // xAI-hosted model. Verified separately in modelRouter.test.ts.
  "parallel-search-subqueries",
  "perspective-generation",
  "episode-reflection",
  "ai-roundup",
  "community-boost",
  "prediction-verification",
  // PR J — P5 routing audit (Session 4)
  "knowledge-gap-scan",      // Structured gap list
  "goal-evaluation",         // Rubric-style scoring
  "x_search",                // Short search-query crafting
];

// Tasks that still land on the generic "standard" tier (Grok 4.20 via OpenRouter).
// Tier-split PR moved public-voice tasks (news-dispatch/reply-generation/episode-generation/
// intro-post/blog-post/article-draft) to standard-voice (xAI Direct) and the debate
// engines (self-debate/triad-reasoning) to multi-agent — see the *_VOICE / *_MULTI_AGENT
// groups below.
const MUST_STAY_STANDARD = [
  "skeptic-debate",
  "builder-debate",
  "adversarial-evaluation",
  "research-phase",
  "research-agenda-advance",
  "triad-fact-synthesis",
];

const MUST_BE_STANDARD_VOICE = [
  "exploration",
  "news-dispatch",
  "reply-generation",
  "episode-generation",
  "intro-post",
  "article-draft",
  "article",
  "reply",
  "boost",
  "cyoa",
];

const MUST_BE_MULTI_AGENT = [
  "self-debate",
  "triad-reasoning",
  "triad",
];

// Tier-split PR: hypothesis-evaluation / fact-verification / red-flag-analysis
// moved to frontier-factual (Grok 4.20 Reasoning). deep-reasoning /
// synthesis-report / aspiration-generation / self-evolution-reflection remain
// on Opus via the frontier-reasoning tier. Verified in frontierTier.test.ts.
//
// Long-form public-facing voice stays on premium-voice (Sonnet). blog-post
// and article-draft re-routed to standard/premium voice respectively.
const MUST_BE_PREMIUM_VOICE = [
  "hypothesis-resolution",
  "podcast-script",
  "research-brief",
  "triad-grounding-review",
  "analysis-contradictions",
  "analysis-citation-chains",
  "analysis-gap-scan",
  "analysis-methodology-audit",
  "analysis-synthesis",
  "analysis-knowledge-map",
  "parallel-search-reduce",
  "blog-post",
  "manuscript",
];

describe("PR D + PR J — P5 task demotions", () => {
  it("demotes all P5 tasks (PR D + PR J) to the routine model", async () => {
    const { getModel } = await import("../modelRouter.js");
    const routineModel = getModel("reflection"); // known routine anchor
    for (const task of DEMOTED_TO_ROUTINE) {
      const model = getModel(task);
      assert.equal(
        model,
        routineModel,
        `expected "${task}" to resolve to routine model (${routineModel}) but got ${model}`,
      );
    }
  });

  it("keeps the reduced standard-tier list on the standard model (Grok 4.20 via OpenRouter)", async () => {
    const { getModel, getModelConfig } = await import("../modelRouter.js");
    const { models } = getModelConfig();
    const standardModel = models.standard;
    const routineModel  = models.routine;
    for (const task of MUST_STAY_STANDARD) {
      const model = getModel(task);
      assert.equal(
        model,
        standardModel,
        `expected "${task}" to remain on standard (${standardModel}) but got ${model}`,
      );
      assert.notEqual(model, routineModel, `"${task}" must not be routine`);
    }
  });

  it("routes public-voice tasks to standard-voice (xAI Direct Grok 4.20 non-reasoning)", async () => {
    const { getModel, getModelConfig } = await import("../modelRouter.js");
    const standardVoice = (getModelConfig().models as Record<string, string>)["standard-voice"];
    for (const task of MUST_BE_STANDARD_VOICE) {
      const model = getModel(task);
      assert.equal(
        model,
        standardVoice,
        `expected "${task}" to route to standard-voice (${standardVoice}) but got ${model}`,
      );
    }
  });

  it("routes debate-engine tasks to multi-agent", async () => {
    const { getModel, getModelConfig } = await import("../modelRouter.js");
    const multi = (getModelConfig().models as Record<string, string>)["multi-agent"];
    for (const task of MUST_BE_MULTI_AGENT) {
      assert.equal(getModel(task), multi, `expected "${task}" → multi-agent (${multi})`);
    }
  });

  it("keeps long-form public-voice tasks on premium-voice (Claude Sonnet 4.6)", async () => {
    const { getModel, getModelConfig } = await import("../modelRouter.js");
    const premiumVoice = (getModelConfig().models as Record<string, string>)["premium-voice"];
    for (const task of MUST_BE_PREMIUM_VOICE) {
      const model = getModel(task);
      assert.equal(
        model,
        premiumVoice,
        `expected "${task}" on premium-voice (${premiumVoice}) but got ${model}`,
      );
    }
  });

  it("normalizes underscores so task_name and task-name resolve identically", async () => {
    const { getModel } = await import("../modelRouter.js");
    assert.equal(getModel("signal_brief"), getModel("signal-brief"));
    assert.equal(getModel("topic_quality_evaluation"), getModel("topic-quality-evaluation"));
  });

  it("unknown tasks still default to standard (regression guard)", async () => {
    const { getModel, getModelConfig } = await import("../modelRouter.js");
    const standardModel = getModelConfig().models.standard;
    assert.equal(getModel("some-new-never-seen-task"), standardModel);
  });
});
