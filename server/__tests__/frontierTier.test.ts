/**
 * Frontier/tier-split routing matrix.
 *
 * Originally introduced as PR E (single "frontier" tier → Claude Opus 4.6).
 * Updated for the tier-split PR so factual reasoning (17%-hallucination
 * Grok 4.20 Reasoning) is routed separately from architecture/complex-code
 * reasoning (Opus). Public-voice tasks (article/reply/episode) are routed to
 * standard-voice (Grok 4.20 non-reasoning via xAI Direct) instead of the
 * generic OpenRouter standard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModelConfig } from "../modelRouter.ts";

const OPUS = "anthropic/claude-opus-4.6";
const GEMINI_FLASH = "google/gemini-3-flash-preview";
const SONNET = "anthropic/claude-sonnet-4.6";

// Tasks expected to resolve to the "frontier-factual" tier (Grok 4.20 Reasoning
// via xAI Direct). These are factual/verification tasks where hallucinated
// output would compound into the hypothesis base.
const FACTUAL_TASKS = [
  "hypothesis-evaluation",
  "fact-verification",
  "red-flag-analysis",
];

// Tasks expected to resolve to the "frontier-reasoning" tier (Claude Opus 4.6
// via OpenRouter). These are architecture/complex-code reasoning and
// identity-shaping synthesis.
const REASONING_TASKS = [
  "deep-reasoning",
  "synthesis-report",
  "aspiration-generation",
  "self-evolution-reflection",
  "architecture",
  "complex-code-reasoning",
];

const ROUTINE_TASKS_SAMPLE = [
  "reflection",
  "confidence-decay",
  "tier-assignment",
  "social-preview",
  "breakthrough-evaluation",
  "hypothesis-decomposition",
  "trust-scoring",
];

// Tasks expected to resolve to the "premium-voice" tier (Claude Sonnet 4.6).
const PREMIUM_VOICE_TASKS = [
  "research-brief",
  "research-agenda-generate",
  "podcast-script",
  "daily-briefing",
  "hypothesis-resolution",
  "analysis-synthesis",
  "triad-grounding-review",
  "manuscript",
];

test("tier-split: factual tasks resolve to frontier-factual (xAI Grok 4.20 Reasoning)", () => {
  const { models } = getModelConfig();
  const factual = (models as Record<string, string>)["frontier-factual"];
  for (const task of FACTUAL_TASKS) {
    assert.equal(getModel(task), factual, `${task} should route to frontier-factual (${factual})`);
    assert.ok(getModel(task).startsWith("x-ai/"), `${task} should be xAI-hosted`);
  }
});

test("tier-split: reasoning tasks resolve to frontier-reasoning (Claude Opus 4.6)", () => {
  for (const task of REASONING_TASKS) {
    assert.equal(getModel(task), OPUS, `${task} should route to Opus via frontier-reasoning`);
  }
});

test("routine tasks resolve to Gemini 3 Flash Preview", () => {
  for (const task of ROUTINE_TASKS_SAMPLE) {
    assert.equal(getModel(task), GEMINI_FLASH, `Expected ${task} → ${GEMINI_FLASH}`);
  }
});

test("premium-voice tasks resolve to Claude Sonnet 4.6", () => {
  for (const task of PREMIUM_VOICE_TASKS) {
    assert.equal(getModel(task), SONNET, `Expected ${task} → ${SONNET}`);
  }
});

test("underscore normalization still resolves reasoning tasks to Opus", () => {
  assert.equal(getModel("deep_reasoning"),             OPUS);
  assert.equal(getModel("synthesis_report"),           OPUS);
  assert.equal(getModel("aspiration_generation"),      OPUS);
  assert.equal(getModel("self_evolution_reflection"),  OPUS);
});

test("unknown task falls back to standard (Grok 4.20 via OpenRouter)", () => {
  const { models } = getModelConfig();
  assert.equal(getModel("totally-unknown-task-xyz"), models.standard);
});

test("getModelConfig exposes all tier-split entries", () => {
  const config = getModelConfig();
  const m = config.models as Record<string, string>;
  assert.equal(m.routine,                GEMINI_FLASH);
  assert.equal(m.premium,                SONNET);
  assert.equal(m["premium-voice"],       SONNET);
  assert.equal(m.frontier,               OPUS);                // backward-compat alias
  assert.equal(m["frontier-reasoning"],  OPUS);
  assert.ok(m["frontier-factual"].startsWith("x-ai/"));
  assert.ok(m["standard-voice"].startsWith("x-ai/"));
  assert.equal(m["multi-agent"],         "x-ai/grok-4.20-multi-agent");
  assert.equal(m["live-research"],       "sonar-pro");
});

test("getModelConfig.tasks reflects reasoning → Opus for all reasoning tasks", () => {
  const { tasks } = getModelConfig();
  for (const task of REASONING_TASKS) {
    assert.equal(tasks[task], OPUS, `config.tasks[${task}] should be ${OPUS}`);
  }
});
