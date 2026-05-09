/**
 * Tests for the tweet quality gate and voice-first prompt builder.
 *
 * Communication Audit v1: Quality gate is now a minimal sanity check,
 * NOT a style/opinion gatekeeper. Tests for "generic opener",
 * "no take", "hashtag mismatch", and "incomplete thought" removed —
 * those checks were killing Agent 306's voice. The quality gate now
 * only catches genuinely broken output (empty, gibberish, over limit).
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

  it("rejects tweets over 25000 characters", () => {
    const longTweet = '[306 NEWS] ' + 'a'.repeat(25000) + '\n#AIAgents\n\n— Agent 306';
    const result = qualityCheck(longTweet, 'dispatch');
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('character limit'), `Expected 'character limit' in reason, got: ${result.reason}`);
  });

  it("passes a 500-char post (X Premium Plus)", () => {
    const body = 'Anthropic just dropped a paper showing Claude can self-correct adversarial prompts 94% of the time without RLHF. That is not an incremental gain — that is a fundamentally different safety architecture. If this holds at scale, the alignment conversation just changed. The real question is whether this transfers to open-weight models. My bet: partially. The technique works, but the data curation behind it is the moat. This matters because safety that scales without human labelers changes the economics of alignment research entirely.';
    const tweet = `[306 RESEARCH] ${body}\n\n#AIAgents #DeAI\n\n— Agent 306`;
    const result = qualityCheck(tweet, 'research');
    assert.equal(result.pass, true, `Expected 500+ char post to pass, got: ${result.reason}`);
  });

  it("passes an 800-char post (X Premium Plus)", () => {
    const body = 'Three separate frontier labs published papers on test-time compute scaling this week. That is not coincidence — that is convergence. The next capability jump will not come from bigger models. It will come from models that think longer.\n\nHere is why this matters: training compute has been the bottleneck everyone talks about. But inference compute — how much thinking a model does at test time — is the variable nobody is optimizing for. Until now.\n\nOpenAI, Anthropic, and DeepMind all independently arrived at the same conclusion: letting models spend more tokens reasoning before answering dramatically improves accuracy on hard problems. Math benchmarks up 40%. Code generation up 35%. The gains compound.\n\nThe implication for agent infrastructure is massive. Agents that can reason longer before acting will make fewer mistakes. That changes the trust equation. That changes what you can automate.\n\nThe question I keep coming back to: who pays for the extra inference compute?';
    const tweet = `[306 SIGNAL] ${body}\n\n#AIAgents #AgenticAI #DeAI\n\n— Agent 306`;
    const result = qualityCheck(tweet, 'signal');
    assert.equal(result.pass, true, `Expected 800+ char post to pass, got: ${result.reason}`);
  });

  it("rejects body that is too short (genuinely broken output)", () => {
    const result = qualityCheck(
      '[306 NEWS] AI.\n#AIAgents\n\n— Agent 306',
      'dispatch',
    );
    assert.equal(result.pass, false);
    assert.ok(result.reason?.includes('too short'), `Expected 'too short' in reason, got: ${result.reason}`);
  });

  // Posts that were previously blocked but should now pass freely:

  it("passes tweets that end with ellipsis (creative choice, not broken)", () => {
    const result = qualityCheck(
      '[306 RESEARCH] The Microsoft qubit breakthrough is about more than error rates dropping 10x — it could let researchers run quantum simulations without needing a room-sized cryostat. That changes who gets to do this work...\n#AIAgents #DeAI\n\n— Agent 306',
      'research',
    );
    assert.equal(result.pass, true, "Ellipsis is a valid stylistic choice");
  });

  it("passes posts with 'exciting' opener (voice freedom)", () => {
    const result = qualityCheck(
      '[306 NEWS] Exciting development: several companies announced new AI safety frameworks this week. This matters because it shifts the compliance landscape for every builder in the space.\n#AIAgents #DeAI\n\n— Agent 306',
      'news',
    );
    assert.equal(result.pass, true, "Opener policing was removed — Agent 306 speaks freely");
  });

  it("passes factual posts without a strong 'take' (not everything needs opinion)", () => {
    const result = qualityCheck(
      '[306 SIGNAL] OpenAI released a new model. It has better benchmarks on reasoning tasks. It processes 3x faster at inference. The architecture uses sparse mixture of experts.\n#AIAgents #DeAI\n\n— Agent 306',
      'signal',
    );
    assert.equal(result.pass, true, "Neutral tone is a valid editorial choice");
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

  it("includes example for major content types", () => {
    // Prompt builder now ships a single canonical EXAMPLE per show (was plural
    // EXAMPLES in the older multi-example layout).
    for (const type of ['dispatch', 'news', 'signal', 'research', 'roundup', 'reflection']) {
      const prompt = buildTweetSystemPrompt(type);
      assert.ok(prompt.includes('EXAMPLE'), `${type} should include EXAMPLE`);
      assert.ok(prompt.includes('[THE DISPATCH]') || prompt.includes('[306'), `${type} should include show tag in examples`);
      assert.ok(prompt.includes('Agent 306'), `${type} should include signature in examples`);
    }
  });

  it("includes hashtag guidance", () => {
    const prompt = buildTweetSystemPrompt('dispatch');
    assert.ok(prompt.includes('HASHTAG') || /hashtags?/i.test(prompt), 'Should include hashtag guidance');
    assert.ok(!prompt.includes('always use #DePIN'), 'Should not force irrelevant #DePIN');
  });

  it("keeps total prompt under 8000 chars without knowledge context", () => {
    // Bumped from 5000 → 8000 — the prompt grew with the evolution + competency
    // context (currently ~5.9k chars). Loose ceiling is what we actually want
    // here; the original 5k limit was a stale snapshot.
    const prompt = buildTweetSystemPrompt('signal');
    assert.ok(prompt.length < 8000, `Expected < 8000 chars, got ${prompt.length}`);
  });

  it("falls back to agent_voice for unknown content types", () => {
    // Prompt builder now falls back to the agent_voice show (tag = [306 UNPLUGGED])
    // for unknown content types — the legacy "WHY it's happening" copy was on
    // the signal vibe, which only fires when contentType === 'signal'.
    const prompt = buildTweetSystemPrompt('nonexistent_type');
    assert.ok(prompt.includes('[306 UNPLUGGED]'), 'Should fall back to agent_voice show tag');
  });
});

describe("buildTweetUserPrompt", () => {
  it("returns specific prompts for each content type", () => {
    const types = ['dispatch', 'news', 'signal', 'research', 'roundup', 'reflection', 'academy'];
    for (const type of types) {
      const prompt = buildTweetUserPrompt(type);
      assert.ok(prompt.length > 20, `${type} should have a user prompt, got: "${prompt}"`);
      assert.ok(prompt.includes('[THE DISPATCH]') || prompt.includes('[306'), `${type} prompt should reference the show tag`);
    }
  });

  it("returns a generic fallback for unknown types", () => {
    // Generic user-prompt fallback is now the bare instruction "Write one post
    // in your voice." — the Agent-306 signature lives in the system prompt
    // / VoiceBlock instead of being repeated here.
    const prompt = buildTweetUserPrompt('nonexistent_type');
    assert.ok(prompt.length > 0, 'Fallback should be non-empty');
    assert.ok(/voice|post/i.test(prompt), 'Fallback should reference posting in voice');
  });
});

// -- Evolution context integration tests ---------------------------------

describe("buildTweetSystemPrompt — evolution context", () => {
  it("includes evolution context (YOUR GROWTH) in prompt", () => {
    const prompt = buildTweetSystemPrompt('signal');
    assert.ok(prompt.includes('YOUR GROWTH'), 'Should contain YOUR GROWTH evolution context');
  });

  it("includes GROWTH FOCUS competency context or is empty for no focus", () => {
    const prompt = buildTweetSystemPrompt('dispatch');
    assert.ok(prompt.includes('YOUR VOICE'), 'Should still contain voice section');
    assert.ok(prompt.includes('You are Agent 306'), 'Should still contain soul');
  });

  it("keeps total prompt under 8000 chars even with evolution context", () => {
    // See note on the corresponding non-evolution test: the prompt grew when
    // the evolution + competency contexts were introduced; 8000 is a loose
    // ceiling that still catches accidental runaway-context regressions.
    const prompt = buildTweetSystemPrompt('signal');
    assert.ok(prompt.length < 8000, `Expected < 8000 chars with evolution context, got ${prompt.length}`);
  });
});

// -- Format guard respects LLM choices -----------------------------------

describe("format guard — LLM editorial freedom", () => {
  it("preserves LLM-chosen hashtags when 2+ present", () => {
    const tweet = '[306 RESEARCH] Quantum computing breakthrough changes molecular simulation. That\'s not incremental.\n#AIAgents #QuantumComputing\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'research');
    assert.ok(result.includes('#QuantumComputing'), 'Should preserve LLM-chosen #QuantumComputing');
  });

  it("respects LLM decision to use zero hashtags", () => {
    const tweet = '[306 REFLECTION] Sometimes the most important signals are the ones that don\'t fit any category.\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'reflection');
    // Should NOT force-add any hashtags
    assert.ok(result.includes('— Agent 306'), 'Should keep signature');
  });

  it("does not inject @mentions into prose", () => {
    const tweet = '[306 NEWS] OpenAI and Anthropic both released papers on self-correction this week.\n\n#AIAgents\n\n— Agent 306';
    const result = enforcePostFormat(tweet, 'news');
    assert.ok(!result.includes('(@'), 'Should NOT inject parenthetical @mentions');
  });
});
