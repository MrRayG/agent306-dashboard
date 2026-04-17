import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModelConfig } from "../modelRouter.ts";

const OPUS = "anthropic/claude-opus-4.6";
const GEMINI_FLASH = "google/gemini-3-flash-preview";
const GROK = "x-ai/grok-4.20";
const SONNET = "anthropic/claude-sonnet-4.6";

const FRONTIER_TASKS = [
  "hypothesis-evaluation",
  "deep-reasoning",
  "synthesis-report",
  "triad-reasoning",
  "aspiration-generation",
  "self-evolution-reflection",
];

const ROUTINE_TASKS_SAMPLE = [
  "reflection",
  "confidence-decay",
  "tier-assignment",
  "social-preview",          // demoted in PR D
  "breakthrough-evaluation", // demoted in PR D
  "signal-brief",            // demoted in PR D
  "hypothesis-decomposition",
  "trust-scoring",
];

const STANDARD_TASKS_SAMPLE = [
  "research-phase",
  "self-debate",
  "adversarial-evaluation",
  "triad-fact-synthesis",
  "skeptic-debate",
  "builder-debate",
  "reply-generation",
  "episode-generation",
  "news-dispatch",
];

const PREMIUM_TASKS_SAMPLE = [
  "research-brief",
  "research-agenda-generate",
  "podcast-script",
  "article-draft",
  "daily-briefing",
  "hypothesis-resolution",
  "analysis-synthesis",
  "triad-grounding-review",
];

test("PR E: all 6 frontier tasks resolve to Claude Opus 4.6", () => {
  for (const task of FRONTIER_TASKS) {
    assert.equal(
      getModel(task),
      OPUS,
      `Expected ${task} to resolve to ${OPUS}, got ${getModel(task)}`
    );
  }
});

test("PR E: routine tasks resolve to Gemini 3 Flash Preview (upgraded from 2.5-flash-lite)", () => {
  for (const task of ROUTINE_TASKS_SAMPLE) {
    assert.equal(
      getModel(task),
      GEMINI_FLASH,
      `Expected ${task} to resolve to ${GEMINI_FLASH}, got ${getModel(task)}`
    );
  }
});

test("PR E: standard tasks continue to resolve to Grok 4.20 (unchanged)", () => {
  for (const task of STANDARD_TASKS_SAMPLE) {
    assert.equal(
      getModel(task),
      GROK,
      `Expected ${task} to resolve to ${GROK}, got ${getModel(task)}`
    );
  }
});

test("PR E: premium tasks continue to resolve to Claude Sonnet 4.6 (unchanged)", () => {
  for (const task of PREMIUM_TASKS_SAMPLE) {
    assert.equal(
      getModel(task),
      SONNET,
      `Expected ${task} to resolve to ${SONNET}, got ${getModel(task)}`
    );
  }
});

test("PR E: previously-premium reasoning tasks no longer resolve to Sonnet", () => {
  // Explicit regression check — these 6 tasks used to be premium/Sonnet
  for (const task of FRONTIER_TASKS) {
    assert.notEqual(
      getModel(task),
      SONNET,
      `${task} should have moved OFF Sonnet to Opus`
    );
  }
});

test("PR E: underscore normalization still works post-frontier", () => {
  // Ensure underscore variants of frontier tasks also resolve to Opus
  assert.equal(getModel("hypothesis_evaluation"), OPUS);
  assert.equal(getModel("deep_reasoning"), OPUS);
  assert.equal(getModel("synthesis_report"), OPUS);
  assert.equal(getModel("triad_reasoning"), OPUS);
  assert.equal(getModel("aspiration_generation"), OPUS);
  assert.equal(getModel("self_evolution_reflection"), OPUS);
});

test("PR E: unknown task falls back to standard (Grok 4.20)", () => {
  assert.equal(getModel("totally-unknown-task-xyz"), GROK);
});

test("PR E: getModelConfig exposes all 5 tiers including frontier", () => {
  const config = getModelConfig();
  assert.equal(config.models.routine, GEMINI_FLASH);
  assert.equal(config.models.standard, GROK);
  assert.equal(config.models.premium, SONNET);
  assert.equal(config.models.frontier, OPUS);
  assert.equal(config.models["multi-agent"], "x-ai/grok-4.20-multi-agent");
});

test("PR E: getModelConfig.tasks reflects frontier routing for all 6 tasks", () => {
  const { tasks } = getModelConfig();
  for (const task of FRONTIER_TASKS) {
    assert.equal(
      tasks[task],
      OPUS,
      `config.tasks[${task}] should be ${OPUS}`
    );
  }
});
