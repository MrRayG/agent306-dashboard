/**
 * articleReviseLoop — judge-outage handling.
 *
 * The revise loop must not retry indefinitely when the verifier judge is
 * down. fix/verifier-fail-closed adds a JUDGE_OUTAGE_RETRY_CAP (=2) so
 * after two consecutive judge-outage verdicts the loop stops, leaves the
 * verdict as HARD_FAIL (so articleEngine quarantines as needs_revision),
 * and records "held_for_review" in revisionHistory.
 *
 * Run: npx tsx --test server/__tests__/articleReviseLoop.judgeOutage.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE;

import { reviseUntilClean } from "../articleReviseLoop.js";
import type { LLMJudgeClient } from "../claimVerifier.js";

const SOURCE_TEXT =
  "Acme Labs published findings on Tuesday. The team described a series of experiments. " +
  "There is no specific percentage in this source text. © 2026 Acme.";

// Draft has at least one attribution sentence whose paraphrase is not in the
// source — that's what triggers the LLM judge call and (with our failing
// stub) the judge-outage path.
const DRAFT =
  "According to the article, AI defenses have measurably improved over the past year. " +
  "The piece reports that benchmark scores doubled across several frontier models.";

const failingJudge: LLMJudgeClient = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ error: "upstream unavailable" }),
  text: async () => "upstream unavailable",
});

describe("reviseUntilClean — judge outage retry cap", () => {
  it("holds for review after JUDGE_OUTAGE_RETRY_CAP consecutive judge-outage verdicts", async () => {
    let rewriteCalls = 0;
    const result = await reviseUntilClean({
      draftText: DRAFT,
      sourceText: SOURCE_TEXT,
      sourceUrl: "https://example.com/article",
      sourceTitle: "Sample Source",
      verifierJudgeClient: failingJudge,
      rewrite: async () => {
        rewriteCalls += 1;
        // Return SAME body so each new verdict is also a judge outage —
        // we want to hit the cap, not pass via a clean rewrite.
        return { body: DRAFT, note: `rewrite-${rewriteCalls}` };
      },
      maxAttempts: 6,
    });

    // Loop should have stopped at the cap, not run all 6 attempts.
    assert.ok(rewriteCalls <= 2, `rewrite called ${rewriteCalls} times — cap should bound it`);
    assert.equal(result.passed, false, "verdict not PASS");
    assert.equal(result.verdict.severity, "HARD_FAIL");
    assert.ok(result.verdict.verifierReport.judgeOutage, "judgeOutage flagged");

    // The held_for_review history entry must be present so the operator
    // UI can show "stopped retrying because the judge is down".
    const heldEntry = result.revisionHistory.find((h) =>
      (h.writerNote ?? "").includes("held_for_review"),
    );
    assert.ok(heldEntry, "held_for_review history entry present");
  });

  it("does not loop forever on persistent judge outage", async () => {
    // If the cap weren't enforced, this would burn N rewrites where N =
    // max attempts. We assert the loop exits in a small bounded number.
    const start = Date.now();
    const result = await reviseUntilClean({
      draftText: DRAFT,
      sourceText: SOURCE_TEXT,
      sourceUrl: "https://example.com/article",
      sourceTitle: "Sample Source",
      verifierJudgeClient: failingJudge,
      rewrite: async () => ({ body: DRAFT }),
      maxAttempts: 6,
    });
    assert.ok(Date.now() - start < 5000, "must not block on retry storm");
    assert.equal(result.verdict.severity, "HARD_FAIL");
  });

  it("escape hatch: VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true lets the draft through", async () => {
    process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE = "true";
    try {
      const result = await reviseUntilClean({
        draftText: DRAFT,
        sourceText: SOURCE_TEXT,
        sourceUrl: "https://example.com/article",
        sourceTitle: "Sample Source",
        verifierJudgeClient: failingJudge,
        rewrite: async () => ({ body: DRAFT }),
        maxAttempts: 6,
      });
      // With the env override on, severity is no longer forced to HARD_FAIL.
      assert.notEqual(result.verdict.severity, "HARD_FAIL");
      assert.equal(result.verdict.verifierReport.judgeOutage!.failOpenOverride, true);
    } finally {
      delete process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE;
    }
  });
});
