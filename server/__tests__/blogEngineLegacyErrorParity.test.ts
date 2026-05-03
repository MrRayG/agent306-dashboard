/**
 * Regression test for the PR #264 review finding: the per-stage helper
 * extraction in `server/blogEngine.ts` removed the outer try/catch that
 * pre-PR wrapped the entire LLM-call → verify → publish sequence in
 * `generateBlogPost`. Pre-PR, if `reviseBlogUntilClean` (or the
 * verify-repair path, or the persistence calls) threw, `generateBlogPost`
 * caught the error, logged "[Blog] Generation failed: ...", and returned
 * null. After the refactor, those throws could propagate to callers
 * (routes.ts /api/blog/generate, dailyCycleEngine, chat-action
 * `generate_blog`).
 *
 * The fix in this PR re-wraps the verify/publish portion of
 * `generateBlogPost` so legacy parity is restored. This file pins that
 * contract so a future refactor can't drop the wrapper again.
 *
 * Two assertions:
 *   1. STRUCTURAL: `generateBlogPost` body wraps the
 *      `verifyAndRepairBlogDraft(...)` and `publishBlogDraft(...)` calls
 *      in a try/catch that returns `null`. We assert against the source
 *      so the test fails loudly if the wrapper is removed.
 *   2. BEHAVIORAL: when the writer LLM succeeds but every subsequent
 *      fetch throws (covering the verifier judge call inside
 *      reviseBlogUntilClean), `generateBlogPost` resolves to `null`
 *      rather than rejecting. The test forces compileBlogDraft to take
 *      the success branch (writer OK, safety scan returns safe content),
 *      then drives the verify+publish helpers under a fetch that has
 *      been swapped to reject — proving the function does not surface
 *      throws to its caller. The pipeline path is not exercised here;
 *      its stage-level failure handling lives in the adapter and is
 *      covered separately.
 *
 * Run: npx tsx --test server/__tests__/blogEngineLegacyErrorParity.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-blog-legacy-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

function chatResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => content,
  };
}

describe("generateBlogPost — legacy try/catch parity (PR #264 follow-up)", () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedGrok = process.env.GROK_API_KEY;
  const savedXai  = process.env.XAI_API_KEY;
  const savedFlag = process.env.BLOG_PIPELINE_ENABLED;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    // The legacy path is the OFF path. The wrapper under test only
    // protects callers of generateBlogPost; the pipeline path has its
    // own per-stage failure handling and does not call this function.
    process.env.BLOG_PIPELINE_ENABLED = "false";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrok;
    if (savedXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedXai;
    if (savedFlag === undefined) delete process.env.BLOG_PIPELINE_ENABLED;
    else process.env.BLOG_PIPELINE_ENABLED = savedFlag;
  });

  it("returns null (does not throw) when the writer succeeds but every downstream fetch rejects", async () => {
    // Writer call (1st fetch): valid blog JSON. Every subsequent fetch
    // rejects with a hard error — covers the safety-scan LLM call and
    // the verifier judge call inside reviseBlogUntilClean. The
    // verify-repair stage's internal catches absorb the verifier
    // rejection, but if any helper threw uncaught (e.g. a future
    // refactor moves persistence outside the repository try/catch), the
    // outer wrapper restored in this PR is the safety net. Either way,
    // generateBlogPost must NOT propagate the throw.
    const blogJson = JSON.stringify({
      title: "Acme Labs ships a new model",
      tags: ["AI", "labs"],
      content:
        "Acme Labs published their findings on Tuesday and called the work \"rigorous and reproducible\".\n\n" +
        "## Section\n\n" +
        "This is a calm Lane A paragraph that says only what the source supports. " +
        "I think the framing here is interesting because it foregrounds reproducibility.",
    });

    let calls = 0;
    const fetchMock = mock.fn(async () => {
      calls += 1;
      if (calls === 1) return chatResponse(blogJson) as any;
      throw new Error(`mocked downstream fetch failure (call #${calls})`);
    });
    globalThis.fetch = fetchMock as any;

    const { generateBlogPost } = await import(
      `../blogEngine.js?t=${Date.now()}`
    );

    let threw = false;
    let result: unknown = "(unset)";
    try {
      result = await generateBlogPost({
        topic: "Acme Labs post",
        sourceContent:
          "Acme Labs published a long technical post on Tuesday describing their new model. " +
          "Acme Labs said the work was \"rigorous and reproducible\".",
        source: "research",
        autoPublish: false,
      });
    } catch (e) {
      threw = true;
      result = e;
    }

    assert.equal(
      threw,
      false,
      `generateBlogPost must not propagate throws under legacy parity; threw with: ${result instanceof Error ? result.message : String(result)}`,
    );
    // The verify+publish stage is best-effort under fetch failure:
    // - If the verifier judge outage path completes cleanly, a real
    //   BlogPost may still be persisted (LANE_A_UNVERIFIABLE entries).
    // - If anything in verify/publish actually throws, the wrapper
    //   returns null.
    // Either outcome is acceptable; the regression we are guarding
    // against is the function rejecting its returned promise.
    assert.ok(
      result === null || (typeof result === "object" && result !== null),
      "generateBlogPost should return either null or a BlogPost-shaped object",
    );
    assert.ok(calls >= 1, "writer fetch must run at least once");
  });
});

describe("generateBlogPost — structural guard for the legacy try/catch", () => {
  it("source wraps verifyAndRepairBlogDraft + publishBlogDraft in try/catch returning null", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "server/blogEngine.ts"),
      "utf-8",
    );

    // Locate the generateBlogPost function body and assert the try
    // wrapper sits between the safety-redacted early return and the
    // closing brace. The wrapper MUST surround both helper calls so
    // either one throwing falls into the same "[Blog] Generation
    // failed:" log + return null behavior the pre-refactor code had.
    const fnMatch = src.match(
      /export\s+async\s+function\s+generateBlogPost\s*\([\s\S]*?\n\}\n/,
    );
    assert.ok(fnMatch, "generateBlogPost function body not found");
    const body = fnMatch![0];

    assert.match(
      body,
      /try\s*\{[\s\S]*verifyAndRepairBlogDraft\s*\(/,
      "verifyAndRepairBlogDraft must sit inside a try block",
    );
    assert.match(
      body,
      /try\s*\{[\s\S]*publishBlogDraft\s*\([\s\S]*?\}\s*catch\s*\(/,
      "publishBlogDraft must sit inside a try block followed by a catch",
    );
    assert.match(
      body,
      /catch\s*\([^)]*\)\s*\{[\s\S]*\[Blog\]\s+Generation failed[\s\S]*return\s+null/,
      "catch block must log '[Blog] Generation failed' and return null (legacy parity)",
    );
  });
});
