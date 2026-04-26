/**
 * Claim verifier — fail-closed on LLM judge outage.
 *
 * Pre-fix (PR #220 / #221 / #222) the verifier silently fell back to
 * "deterministic-only" when the LLM judge call failed. Unresolved Lane A
 * sentences disappeared from the report and severity collapsed to PASS,
 * which let drafts publish ungrounded during any judge-model outage.
 *
 * After fix/verifier-fail-closed:
 *   - Each unresolved Lane A sentence becomes LANE_A_UNVERIFIABLE.
 *   - Severity is forced to HARD_FAIL.
 *   - VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true is the only escape hatch
 *     (per-deploy operator override).
 *   - Each affected sentence emits a `[CLAIM_VERIFIER] judge_unreachable`
 *     log line with reason + model.
 *
 * Tests inject a fake `judgeClient` so the LLM transport is exercised
 * without a real network call.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.judgeOutage.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  verifyClaims,
  failOpenOnJudgeOutageEnabled,
  type LLMJudgeClient,
} from "../claimVerifier.js";

const SOURCE_TITLE = "Sample Source";
const SOURCE_URL = "https://example.com/article";

const SOURCE_TEXT =
  "Researchers presented findings on AI safety. The team described a series of experiments " +
  "that probed model defenses. The full transcript and slides are available on the project page. " +
  "By Sample Author. © 2026 Example.com.";

// Draft has TWO attribution sentences whose paraphrases are not in the source
// (so they will need LLM judging — the deterministic checks won't resolve).
const DRAFT_WITH_ATTRIBUTION =
  "According to the article, AI defenses have measurably improved over the past year. " +
  "The piece reports that benchmark scores doubled across several frontier models. " +
  "My read: this is encouraging, but caution is warranted.";

function makeFailingJudge(failure: "http500" | "throw" | "timeout" | "garbage"): LLMJudgeClient {
  return async (_body, _signal, _endpoint) => {
    if (failure === "throw") {
      throw new Error("transport blew up");
    }
    if (failure === "timeout") {
      const e: any = new Error("aborted: operation was timed out");
      throw e;
    }
    if (failure === "garbage") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "<<<not json>>>" } }] }),
        text: async () => "<<<not json>>>",
      };
    }
    // http500
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: "upstream unavailable" }),
      text: async () => "upstream unavailable",
    };
  };
}

function makeOkJudge(): LLMJudgeClient {
  // Returns "UNSUPPORTED" for both sentences so we have a known-good baseline
  // — the draft should HARD_FAIL via LANE_A_FAIL, not LANE_A_UNVERIFIABLE.
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdicts: [
                { index: 1, status: "UNSUPPORTED", reason: "not in source" },
                { index: 2, status: "UNSUPPORTED", reason: "not in source" },
              ],
            }),
          },
        },
      ],
    }),
  });
}

describe("claimVerifier — fail-closed on LLM judge outage", () => {
  beforeEach(() => {
    delete process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE;
  });
  afterEach(() => {
    delete process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE;
  });

  it("non-2xx judge response → LANE_A_UNVERIFIABLE + HARD_FAIL by default", async () => {
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeFailingJudge("http500"),
    });
    assert.equal(v.severity, "HARD_FAIL", "severity must be HARD_FAIL on judge outage");
    assert.ok(v.verifierReport.summary.laneAUnverifiable >= 1, "at least one unverifiable entry");
    assert.equal(v.ok, false);
    assert.ok(v.verifierReport.judgeOutage, "judgeOutage block present");
    assert.equal(v.verifierReport.judgeOutage!.reason, "judge_unreachable");
    assert.equal(v.verifierReport.judgeOutage!.failOpenOverride, false);
    // Every unverifiable sentence appears in unsupportedClaims with lane='unverifiable'.
    const unverifiable = v.unsupportedClaims.filter((c) => c.lane === "unverifiable");
    assert.ok(unverifiable.length >= 1);
  });

  it("judge throws transport error → LANE_A_UNVERIFIABLE + HARD_FAIL", async () => {
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeFailingJudge("throw"),
    });
    assert.equal(v.severity, "HARD_FAIL");
    assert.equal(v.verifierReport.judgeOutage!.reason, "judge_unreachable");
  });

  it("judge timeout → reason='judge_timeout'", async () => {
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeFailingJudge("timeout"),
    });
    assert.equal(v.severity, "HARD_FAIL");
    assert.equal(v.verifierReport.judgeOutage!.reason, "judge_timeout");
  });

  it("judge returns unparseable JSON → reason='judge_parse_error' + HARD_FAIL", async () => {
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeFailingJudge("garbage"),
    });
    assert.equal(v.severity, "HARD_FAIL");
    assert.equal(v.verifierReport.judgeOutage!.reason, "judge_parse_error");
  });

  it("escape hatch: VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true restores legacy behavior", async () => {
    process.env.VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE = "true";
    assert.equal(failOpenOnJudgeOutageEnabled(), true);
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeFailingJudge("http500"),
    });
    // Severity is NOT forced to HARD_FAIL; entries are still recorded but
    // they're informational. The judgeOutage block now flags
    // failOpenOverride=true so the operator UI can highlight it.
    assert.notEqual(v.severity, "HARD_FAIL");
    assert.equal(v.verifierReport.judgeOutage!.failOpenOverride, true);
    // But the entries still exist so the report is honest about why.
    assert.ok(v.verifierReport.summary.laneAUnverifiable >= 1);
  });

  it("LANE_A_FAIL still wins over LANE_A_UNVERIFIABLE when judge succeeds", async () => {
    // Sanity baseline — when the judge IS reachable and returns
    // UNSUPPORTED, we want LANE_A_FAIL (not LANE_A_UNVERIFIABLE).
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeOkJudge(),
    });
    assert.equal(v.severity, "HARD_FAIL");
    assert.equal(v.verifierReport.judgeOutage, undefined, "no outage flagged");
    assert.equal(v.verifierReport.summary.laneAUnverifiable, 0);
    assert.ok(v.verifierReport.summary.laneAFail >= 1, "LANE_A_FAIL recorded");
  });
});

describe("claimVerifier — partial judge outage (mixed success + failure)", () => {
  it("when judge transport errors, ALL unresolved Lane A become unverifiable, not silent PASS", async () => {
    // The previous (buggy) behavior accepted *any* missing verdict as
    // "fall back to LANE_A_OK." That collapse made severity = PASS even
    // when half the sentences were unjudged. Pin the new contract:
    // any judge failure marks every unresolved Lane A sentence
    // unverifiable.
    const v = await verifyClaims({
      draftText: DRAFT_WITH_ATTRIBUTION,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      judgeClient: makeFailingJudge("http500"),
    });
    assert.equal(v.severity, "HARD_FAIL");
    assert.notEqual(v.severity, "PASS", "the old fail-open path is gone");
    // No LANE_A_OK should have been stamped on the unresolved sentences.
    assert.equal(v.verifierReport.summary.laneAOk, 0);
  });
});
