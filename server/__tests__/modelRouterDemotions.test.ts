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
  "signal_brief",
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

const MUST_STAY_STANDARD = [
  // Reasoning / debate
  "self-debate",
  "skeptic-debate",
  "builder-debate",
  "adversarial-evaluation",
  // Research pipeline reasoning
  "research-phase",
  "research-agenda-advance",
  "exploration",
  // Public-facing voice
  "news-dispatch",
  "reply-generation",
  "episode-generation",
  "intro-post",
  "blog-post",
  // Quality-sensitive tooling — grounded Class-1 synthesis stays on Grok 4.20
  "triad-fact-synthesis",
];

// PR E (Apr 2026): hypothesis-evaluation, synthesis-report, triad-reasoning,
// self-evolution-reflection, aspiration-generation, deep-reasoning moved from
// premium → frontier (Claude Opus 4.6). They are verified in frontierTier.test.ts.
const MUST_STAY_PREMIUM = [
  "hypothesis-resolution",
  "podcast-script",
  "research-brief",
  "article-draft",
  "triad-grounding-review",
  "analysis-contradictions",
  "analysis-citation-chains",
  "analysis-gap-scan",
  "analysis-methodology-audit",
  "analysis-synthesis",
  "analysis-knowledge-map",
  "parallel-search-reduce",
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
