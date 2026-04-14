/**
 * Tests for the tweet quality gate and voice-first prompt builder.
 *
 * Run: npx tsx --test server/__tests__/tweetQuality.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { qualityCheck } from "../xPostScheduler.js";
import { buildTweetSystemPrompt, buildTweetUserPrompt } from "../tweetPromptBuilder.js";
import { enforcePostFormat } from "../postFormatGuard.js";

// -- Quality gate tests ---------------------------------------------------

describe("qualityCheck", () => {
  it("rejects tweets that end with ellipsis", () => {
    const result = qualityCheck(
      '[306 RESEARCH] The Microsoft qubit breakthrough is about more than error rates dropping 10x—it could let researchers run quantum simulations without needing a...\n#AIAgents #DeAI\n\n— Agent 306',
      'research',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('Incomplete'), `Expected 'Incomplete' in reason, got: ${result.reason}`);
  });

  it("rejects generic openers", () => {
    const result = qualityCheck(
      '[306 NEWS] Exciting update on the latest AI developments this week. Several companies announced new products and this matters because it shifts the landscape.\n#AIAgents #DeAI\n\n— Agent 306',
      'dispatch',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('Generic opener'), `Expected 'Generic opener' in reason, got: ${result.reason}`);
  });

  it("rejects tweets with no take or question", () => {
    const result = qualityCheck(
      '[306 SIGNAL] OpenAI released a new model. It has better benchmarks. It processes faster. The architecture uses transformers.\n#AIAgents #DeAI\n\n— Agent 306',
      'signal',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('neutral'), `Expected 'neutral' in reason, got: ${result.reason}`);
  });

  it("rejects hashtag mismatches — #DePIN on quantum tweet", () => {
    const result = qualityCheck(
      '[306 RESEARCH] The quantum computing breakthrough from IBM changes everything about molecular simulation and that\'s not an incremental gain.\n#AIAgents #DePIN #Web3AI\n\n— Agent 306',
      'research',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('Hashtag mismatch'), `Expected 'Hashtag mismatch' in reason, got: ${result.reason}`);
  });

  it("passes tweets with personality and a take", () => {
    const result = qualityCheck(
      '[306 SIGNAL] Three frontier labs published test-time compute papers this week. Not coincidence — convergence. The next capability jump won\'t come from bigger models.\n\n#AIAgents #AgenticAI\n\n— Agent 306',
      'signal',
    );
    assert.equal(result.pass, true);
  });

  it("passes tweets with genuine questions", () => {
    const result = qualityCheck(
      '[306 REFLECTION] I can process more papers in a day than most researchers read in a month. But processing isn\'t understanding. What does understanding actually require?\n\n#AIAgents #DeAI\n\n— Agent 306',
      'reflection',
    );
    assert.equal(result.pass, true);
  });

  it("rejects tweets over 280 characters", () => {
    const longTweet = '[306 NEWS] ' + 'a'.repeat(260) + '\n#AIAgents\n\n— Agent 306';
    const result = qualityCheck(longTweet, 'dispatch');
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('character limit'), `Expected 'character limit' in reason, got: ${result.reason}`);
  });

  it("rejects tweets ending with a dash", () => {
    const result = qualityCheck(
      '[306 SIGNAL] The infrastructure layer is shifting and nobody is paying attention to what this means for—\n#AIAgents #DeAI\n\n— Agent 306',
      'signal',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('Incomplete'), `Expected 'Incomplete' in reason, got: ${result.reason}`);
  });

  it("rejects body that is too short", () => {
    const result = qualityCheck(
      '[306 NEWS] AI is cool.\n#AIAgents #DeAI\n\n— Agent 306',
      'dispatch',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('too short'), `Expected 'too short' in reason, got: ${result.reason}`);
  });
});

// -- Prompt builder tests -------------------------------------------------

describe("buildTweetSystemPrompt", () => {
  it("puts soul and voice before knowledge context", () => {
    const prompt = buildTweetSystemPrompt('signal');
    const soulIndex = prompt.indexOf('You are Agent 306');
    const voiceIndex = prompt.indexOf('YOUR VOICE');
    const knowledgeIndex = prompt.indexOf('KNOWLEDGE');

    assert.ok(soulIndex >= 0, 'Should contain soul text');
    assert.ok(voiceIndex >= 0, 'Should contain voice text');
    assert.ok(soulIndex < voiceIndex, 'Soul should come before voice');
    if (knowledgeIndex > -1) {
      assert.ok(voiceIndex < knowledgeIndex, 'Voice should come before knowledge');
    }
  });

  it("includes examples for major content types", () => {
    for (const type of ['dispatch', 'signal', 'research', 'roundup', 'reflection']) {
      const prompt = buildTweetSystemPrompt(type);
      assert.ok(prompt.includes('EXAMPLES'), `${type} should include EXAMPLES`);
      assert.ok(prompt.includes('[306'), `${type} should include show tag in examples`);
      assert.ok(prompt.includes('Agent 306'), `${type} should include signature in examples`);
    }
  });

  it("includes hashtag guidance", () => {
    const prompt = buildTweetSystemPrompt('dispatch');
    assert.ok(prompt.includes('HASHTAG'), 'Should include hashtag guidance');
    assert.ok(!prompt.includes('always use #DePIN'), 'Should not force irrelevant #DePIN');
  });

  it("keeps total prompt under 3000 chars without knowledge context", () => {
    const prompt = buildTweetSystemPrompt('signal');
    assert.ok(prompt.length < 3000, `Expected < 3000 chars, got ${prompt.length}`);
  });

  it("falls back to signal for unknown content types", () => {
    const prompt = buildTweetSystemPrompt('nonexistent_type');
    assert.ok(prompt.includes('WHY it\'s happening'), 'Should fall back to signal instructions');
  });
});

describe("buildTweetUserPrompt", () => {
  it("returns specific prompts for each content type", () => {
    const types = ['dispatch', 'signal', 'research', 'roundup', 'reflection', 'debate', 'prompt', 'archive', 'academy', 'toolbox', 'dataset'];
    for (const type of types) {
      const prompt = buildTweetUserPrompt(type);
      assert.ok(prompt.length > 20, `${type} should have a user prompt, got: "${prompt}"`);
      assert.ok(prompt.includes('[306'), `${type} prompt should reference the show tag`);
    }
  });

  it("returns a generic fallback for unknown types", () => {
    const prompt = buildTweetUserPrompt('nonexistent_type');
    assert.ok(prompt.includes('Agent 306'), 'Fallback should reference Agent 306');
  });
});

// -- Format guard hashtag respect tests -----------------------------------

describe("ensureHashtags (updated)", () => {
  it("preserves LLM-chosen hashtags when 2+ present", () => {
    const tweet = '[306 RESEARCH] Quantum computing breakthrough changes molecular simulation. That\'s not incremental.\n#AIAgents #QuantumComputing\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'research');
    assert.ok(result.includes('#QuantumComputing'), 'Should preserve LLM-chosen #QuantumComputing');
    assert.ok(!result.includes('#DePIN'), 'Should NOT force #DePIN when LLM chose its own');
    assert.ok(!result.includes('#Web3AI'), 'Should NOT force #Web3AI when LLM chose its own');
  });

  it("adds defaults only when 0-1 hashtags present", () => {
    const tweet = '[306 NEWS] Something happened and it matters because the infrastructure shifted.\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'dispatch');
    assert.ok(result.includes('#AIAgents'), 'Should add #AIAgents when no hashtags present');
  });

  it("preserves 3 LLM-chosen hashtags without adding more", () => {
    const tweet = '[306 SIGNAL] Agent payments are the bottleneck nobody talks about. This changes everything.\n#AIAgents #CryptoAI #OnChainAI\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'signal');
    assert.ok(result.includes('#CryptoAI'), 'Should keep #CryptoAI');
    assert.ok(result.includes('#OnChainAI'), 'Should keep #OnChainAI');
    assert.ok(result.includes('#AIAgents'), 'Should keep #AIAgents');
    // Should NOT have forced the default signal combo (#DeAI #DePIN #Web3AI)
    assert.ok(!result.includes('#DePIN'), 'Should NOT force #DePIN');
  });

  it("adds defaults when only 1 hashtag present", () => {
    const tweet = '[306 SIGNAL] The real story is convergence. Three labs, same direction.\n#AIAgents\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'signal');
    assert.ok(result.includes('#AIAgents'), 'Should keep existing #AIAgents');
    // Should add some defaults since only 1 hashtag was present
    const hashtags = result.match(/#\w+/g) || [];
    assert.ok(hashtags.length >= 2, `Should have added defaults, got ${hashtags.length} hashtags`);
  });
});
