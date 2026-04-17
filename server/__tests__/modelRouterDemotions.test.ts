/**
 * Tests for PR D — P5 task tier demotions.
 *
 * Verifies 15 tasks now resolve to the routine model (Gemini flash-lite by default)
 * and that no reasoning / public-facing tasks were accidentally demoted.
 *
 * Run: npx tsx --test server/__tests__/modelRouterDemotions.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const DEMOTED_TO_ROUTINE = [
  "social-preview",
  "breakthrough-evaluation",
  "topic-quality-evaluation",
  "aspiration-evaluation",
  "analysis-so-what",
  "analysis-assumptions",
  "analysis-intake",
  "signal-collection",
  "signal_brief",
  "parallel-search-subqueries",
  "perspective-generation",
  "episode-reflection",
  "ai-roundup",
  "community-boost",
  "prediction-verification",
];

const MUST_STAY_STANDARD = [
  // Reasoning / debate
  "self-debate",
  "skeptic-debate",
  "builder-debate",
  "adversarial-evaluation",
  // Research pipeline reasoning
  "research-phase",
  "research-agenda-advance",
  "knowledge-gap-scan",
  "goal-evaluation",
  "exploration",
  // Public-facing voice
  "news-dispatch",
  "reply-generation",
  "episode-generation",
  "intro-post",
  "blog-post",
  // Quality-sensitive tooling
  "x_search",
  "triad-fact-synthesis",
];

const MUST_STAY_PREMIUM = [
  "hypothesis-evaluation",
  "hypothesis-resolution",
  "podcast-script",
  "research-brief",
  "article-draft",
  "synthesis-report",
  "triad-reasoning",
  "triad-grounding-review",
  "self-evolution-reflection",
  "aspiration-generation",
  "analysis-contradictions",
  "analysis-citation-chains",
  "analysis-gap-scan",
  "analysis-methodology-audit",
  "analysis-synthesis",
  "analysis-knowledge-map",
  "deep-reasoning",
  "parallel-search-reduce",
];

describe("PR D — P5 task demotions", () => {
  it("demotes all 15 P5 tasks to the routine model", async () => {
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

  it("keeps reasoning + public-facing tasks on standard", async () => {
    const { getModel } = await import("../modelRouter.js");
    const standardModel = getModel("self-debate"); // known standard anchor
    const routineModel = getModel("reflection");
    const premiumModel = getModel("podcast-script");
    for (const task of MUST_STAY_STANDARD) {
      const model = getModel(task);
      assert.equal(
        model,
        standardModel,
        `expected "${task}" to remain on standard (${standardModel}) but got ${model}`,
      );
      assert.notEqual(model, routineModel, `"${task}" must not be routine`);
      assert.notEqual(model, premiumModel, `"${task}" must not be premium`);
    }
  });

  it("keeps premium reasoning + long-form tasks on premium", async () => {
    const { getModel } = await import("../modelRouter.js");
    const premiumModel = getModel("podcast-script"); // known premium anchor
    for (const task of MUST_STAY_PREMIUM) {
      const model = getModel(task);
      assert.equal(
        model,
        premiumModel,
        `expected "${task}" to remain on premium (${premiumModel}) but got ${model}`,
      );
    }
  });

  it("normalizes underscores so task_name and task-name resolve identically", async () => {
    const { getModel } = await import("../modelRouter.js");
    assert.equal(getModel("signal_brief"), getModel("signal-brief"));
    assert.equal(getModel("topic_quality_evaluation"), getModel("topic-quality-evaluation"));
  });

  it("unknown tasks still default to standard (regression guard)", async () => {
    const { getModel } = await import("../modelRouter.js");
    const standardModel = getModel("self-debate");
    assert.equal(getModel("some-new-never-seen-task"), standardModel);
  });
});
