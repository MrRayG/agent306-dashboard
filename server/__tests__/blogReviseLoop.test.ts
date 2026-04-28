/**
 * Tests for server/blogReviseLoop.ts
 *
 * Mirrors articleReviseLoop.test.ts. The blog revise loop sits between the
 * blog writer and the verifier. We drive the loop with a stub rewriter so
 * the test stays hermetic — no LLM calls.
 *
 * Run: npx tsx --test server/__tests__/blogReviseLoop.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import {
  reviseBlogUntilClean,
  maxRevisionAttempts,
  type RewriteInput,
  type RewriteOutput,
} from "../blogReviseLoop.js";

const SOURCE_TEXT = `
Acme Labs published a long technical post on Tuesday describing their new model. The model
scores well on internal benchmarks. Acme Labs said the work was "rigorous and reproducible".
There is no mention of any specific percentage in this source text. There is no mention of
any specific year before 1980 either.
`.trim();

describe("reviseBlogUntilClean — basic loop", () => {
  it("returns immediately when the verifier severity is PASS", async () => {
    const cleanDraft = `Acme Labs published their findings on Tuesday and called the work "rigorous and reproducible".

This is a calm Lane A paragraph that says only what the source supports.`;
    let calls = 0;
    const result = await reviseBlogUntilClean({
      draftText: cleanDraft,
      sourceText: SOURCE_TEXT,
      sourceUrl: "https://example.com/post",
      sourceTitle: "Acme Labs post",
      skipVerifierLLM: true,
      rewrite: async () => {
        calls += 1;
        return { body: cleanDraft };
      },
    });
    assert.equal(calls, 0, "rewriter should never be called when verdict starts at PASS");
    assert.equal(result.passed, true);
    assert.equal(result.revisionHistory.length, 0);
  });

  it("invokes the rewriter and stops when the rewrite produces a PASS verdict", async () => {
    // 4 bare Lane B sentences → HARD_FAIL on entry. Rewriter strips them.
    const dirtyDraft = `## Section
On Tuesday, the AI industry generated $400 billion in revenue.
Adoption has now reached 67% of the United States in just three years.
The 2024 ImageNet benchmark crossed 95% top-1 accuracy.
Nvidia's data-center revenue grew 4.2x in the last fiscal year.`;
    const cleanedDraft = `## Section
The Acme Labs post sketches a calm picture. Acme Labs said the work was "rigorous and reproducible".
This paragraph stays inside Lane A and reads as the source supports.`;
    let calls = 0;
    const result = await reviseBlogUntilClean({
      draftText: dirtyDraft,
      sourceText: SOURCE_TEXT,
      sourceUrl: "https://example.com/post",
      sourceTitle: "Acme Labs post",
      skipVerifierLLM: true,
      rewrite: async (input: RewriteInput): Promise<RewriteOutput> => {
        calls += 1;
        // Should receive the failing entries
        assert.ok(input.failingEntries.length > 0, "rewriter must receive failing entries");
        return { body: cleanedDraft, note: `attempt ${calls}` };
      },
    });
    assert.ok(calls >= 1, "rewriter should run at least once");
    assert.equal(result.passed, true);
    assert.equal(result.revisionHistory.length, 1);
    assert.equal(result.revisionHistory[0].issuesAfter, 0);
    assert.ok(result.revisionHistory[0].targetedSentences.length > 0);
  });

  it("respects maxAttempts and reverts a regression", async () => {
    const dirtyDraft = `## Section
On Tuesday, the AI industry generated $400 billion in revenue.
Adoption has now reached 67% of the United States in just three years.`;
    // Rewriter returns a body that's WORSE — three more bare Lane B sentences.
    const worseDraft = `## Section
On Tuesday, the AI industry generated $400 billion in revenue.
Adoption has now reached 67% of the United States in just three years.
2017 saw the publication of "Attention Is All You Need".
GPT-3 launched in 2020 with 175 billion parameters.
ChatGPT hit 100 million users in 60 days during 2022.`;
    let calls = 0;
    const result = await reviseBlogUntilClean({
      draftText: dirtyDraft,
      sourceText: SOURCE_TEXT,
      sourceUrl: "https://example.com/post",
      sourceTitle: "Acme Labs post",
      skipVerifierLLM: true,
      maxAttempts: 3,
      rewrite: async (): Promise<RewriteOutput> => {
        calls += 1;
        return { body: worseDraft, note: "made it worse" };
      },
    });
    // Loop should have reverted on the regression (kept dirtyDraft).
    assert.equal(result.body, dirtyDraft, "loop should revert when rewrite regresses");
    assert.ok(result.revisionHistory.length >= 1);
    assert.match(result.revisionHistory[0].writerNote ?? "", /regression/);
    assert.ok(calls >= 1);
  });

  it("passes extraSourceUrls to the rewriter", async () => {
    const dirtyDraft = `On Tuesday, the AI industry generated $400 billion in revenue.`;
    let captured: string[] = [];
    await reviseBlogUntilClean({
      draftText: dirtyDraft,
      sourceText: SOURCE_TEXT,
      sourceUrl: "https://example.com/post",
      sourceTitle: "Acme Labs post",
      extraSourceUrls: [
        "https://example.com/extra1",
        "not-a-url",
        "https://example.com/extra2",
      ],
      skipVerifierLLM: true,
      maxAttempts: 1,
      rewrite: async (input: RewriteInput): Promise<RewriteOutput> => {
        captured = input.extraSourceUrls;
        return { body: dirtyDraft }; // no-op
      },
    });
    assert.deepEqual(captured, [
      "https://example.com/extra1",
      "https://example.com/extra2",
    ]);
  });
});

describe("maxRevisionAttempts", () => {
  it("defaults to 3 when env is unset", () => {
    delete process.env.MAX_REVISION_ATTEMPTS;
    assert.equal(maxRevisionAttempts(), 3);
  });
  it("clamps env values to [1, 6]", () => {
    process.env.MAX_REVISION_ATTEMPTS = "0";
    assert.equal(maxRevisionAttempts(), 3);
    process.env.MAX_REVISION_ATTEMPTS = "100";
    assert.equal(maxRevisionAttempts(), 6);
    process.env.MAX_REVISION_ATTEMPTS = "2";
    assert.equal(maxRevisionAttempts(), 2);
    delete process.env.MAX_REVISION_ATTEMPTS;
  });
});
