import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModelConfig } from "../modelRouter.ts";

const OPUS = "anthropic/claude-opus-4.6";
const GEMINI_FLASH = "google/gemini-3-flash-preview";
const GROK_STANDARD = "x-ai/grok-4.20-non-reasoning";
const GROK_FACTUAL  = "x-ai/grok-4.20-reasoning";
const SONNET = "anthropic/claude-sonnet-4.6";

// Router-tier-split PR (Apr 2026): hypothesis-evaluation moved off
// frontier-reasoning (Opus) to frontier-factual (Grok 4.20 Reasoning), the
// lowest-hallucination model for fact-heavy verdicts. The rest of the list
// stays on frontier-reasoning / Opus — they are identity/reasoning tasks where
// factual freshness is less load-bearing.
const FRONTIER_REASONING_TASKS = [
  "deep-reasoning",
  "synthesis-report",
  "triad-reasoning",
  "aspiration-generation",
  "self-evolution-reflection",
];

const FRONTIER_FACTUAL_TASKS = [
  "hypothesis-evaluation",
  "fact-verification",
  "red-flag-analysis",
  "evidence-evaluation",
];

const ROUTINE_TASKS_SAMPLE = [
  "reflection",
  "confidence-decay",
  "tier-assignment",
  "social-preview",          // demoted in PR D
  "breakthrough-evaluation", // demoted in PR D
  // signal-brief promoted to "live-social" tier (Wave 1 follow-up) — verified in modelRouter.test.ts
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

test("router-tier-split: frontier-reasoning tasks resolve to Claude Opus 4.6", () => {
  for (const task of FRONTIER_REASONING_TASKS) {
    assert.equal(
      getModel(task),
      OPUS,
      `Expected ${task} to resolve to ${OPUS}, got ${getModel(task)}`
    );
  }
});

test("router-tier-split: frontier-factual tasks resolve to Grok 4.20 Reasoning", () => {
  for (const task of FRONTIER_FACTUAL_TASKS) {
    assert.equal(
      getModel(task),
      GROK_FACTUAL,
      `Expected ${task} to resolve to ${GROK_FACTUAL}, got ${getModel(task)}`
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

test("router-tier-split: standard-voice tasks resolve to Grok 4.20 non-reasoning", () => {
  for (const task of STANDARD_TASKS_SAMPLE) {
    assert.equal(
      getModel(task),
      GROK_STANDARD,
      `Expected ${task} to resolve to ${GROK_STANDARD}, got ${getModel(task)}`
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

test("router-tier-split: frontier tasks never resolve to Sonnet", () => {
  for (const task of [...FRONTIER_REASONING_TASKS, ...FRONTIER_FACTUAL_TASKS]) {
    assert.notEqual(
      getModel(task),
      SONNET,
      `${task} should never resolve to Sonnet (premium-voice tier)`,
    );
  }
});

test("router-tier-split: underscore normalization still works post-split", () => {
  assert.equal(getModel("hypothesis_evaluation"), GROK_FACTUAL);
  assert.equal(getModel("fact_verification"), GROK_FACTUAL);
  assert.equal(getModel("deep_reasoning"), OPUS);
  assert.equal(getModel("synthesis_report"), OPUS);
  assert.equal(getModel("triad_reasoning"), OPUS);
  assert.equal(getModel("aspiration_generation"), OPUS);
  assert.equal(getModel("self_evolution_reflection"), OPUS);
});

test("router-tier-split: unknown task falls back to standard-voice", () => {
  assert.equal(getModel("totally-unknown-task-xyz"), GROK_STANDARD);
});

test("router-tier-split: getModelConfig exposes all tiers + backwards-compat aliases", () => {
  const config = getModelConfig();
  assert.equal(config.models.routine, GEMINI_FLASH);
  assert.equal(config.models["standard-voice"], GROK_STANDARD);
  assert.equal(config.models["premium-voice"], SONNET);
  assert.equal(config.models["frontier-reasoning"], OPUS);
  assert.equal(config.models["frontier-factual"], GROK_FACTUAL);
  assert.equal(config.models["multi-agent"], "x-ai/grok-4.20-multi-agent");
  assert.equal(config.models["live-social"], "x-ai/grok-4.20-non-reasoning");
  assert.equal(config.models["live-research"], "sonar-pro");
  // Backwards-compat alias keys.
  assert.equal(config.models.frontier, OPUS);
  assert.equal(config.models.premium, SONNET);
  assert.equal(config.models.standard, GROK_STANDARD);
});

test("router-tier-split: getModelConfig.tasks reflects split routing", () => {
  const { tasks } = getModelConfig();
  for (const task of FRONTIER_REASONING_TASKS) {
    assert.equal(tasks[task], OPUS, `config.tasks[${task}] should be ${OPUS}`);
  }
  for (const task of FRONTIER_FACTUAL_TASKS) {
    assert.equal(tasks[task], GROK_FACTUAL, `config.tasks[${task}] should be ${GROK_FACTUAL}`);
  }
});
