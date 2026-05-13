/**
 * Regression: explicit Agent 306 analysis / recommendation framing must
 * route OUT of Lane A hard-fail source attribution.
 *
 * The 2026-05-13 blog publish-after-edit failure log showed:
 *
 *   LANE_A_FAIL · sentence 55
 *   - **Agent 306's analysis: build a brief regular review habit.**
 *     Check your bank statement periodically for AI-handled transactions
 *     — look for auto-pay notes or assistant-flagged entries.
 *     reason: source text contains no mention of Agent 306 or periodic
 *             bank statement reviews for AI transactions
 *
 * The sentence is explicitly labeled `Agent 306's analysis:` — it is
 * the agent's own recommendation, not a claim attributed to the source.
 * The verifier should not hard-fail it for a missing source mention.
 *
 * Hard rules preserved:
 *   - Sentences without the explicit framing label still flag.
 *   - The framing does NOT exempt embedded factual claims (numeric
 *     markers, named-authority "study by …" phrases, embedded
 *     attribution verbs).
 *   - Quoted-span fabrication detection still runs.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.agent306AnalysisFraming.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Hermetic — deterministic paths only.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { verifyClaims } from "../claimVerifier.js";
import {
  hasExplicitAgent306AnalysisFraming,
  embeddedFactualClaimRequiresSourcing,
} from "../artifactMode.js";

// A blog-shaped source that talks about consumer AI assistants and
// bill-paying flows — purposefully does NOT mention Agent 306 or any
// "periodic bank statement review" recommendation. The reported
// regression was triggered against exactly this kind of source.
const SOURCE_URL = "https://example.com/ai-assistants-and-money";
const SOURCE_TITLE = "What AI Assistants Mean For Everyday Money";
const SOURCE_TEXT = [
  "Consumer AI assistants are starting to handle small recurring",
  "transactions on behalf of their users — paying subscriptions,",
  "renewing storage plans, and topping up prepaid balances.",
  "",
  "Banks are working out how to label these transactions so account",
  "holders can tell which charges came from a human and which came",
  "from an automated agent.",
].join("\n");

type Mode = "ANALYSIS" | "REPORT" | "MANUSCRIPT" | undefined;

async function runVerifier(
  draftText: string,
  artifactMode: Mode,
  tier?: "blog" | "news" | "article",
) {
  return verifyClaims({
    draftText,
    sourceText: SOURCE_TEXT,
    sourceUrl: SOURCE_URL,
    sourceTitle: SOURCE_TITLE,
    skipLLM: true,
    ...(artifactMode ? { artifactMode } : {}),
    ...(tier ? { tier } : {}),
  });
}

const FAIL_CLASSIFICATIONS = new Set([
  "LANE_A_FAIL",
  "LANE_B_BARE",
  "NCITE_PATTERN_HIT",
  "RETRACTED_HIT",
]);

// The exact reported sentence (bolded label + body, as it appears in
// the failing draft).
const REPORTED_SENTENCE =
  "**Agent 306's analysis: build a brief regular review habit.** " +
  "Check your bank statement periodically for AI-handled transactions " +
  "— look for auto-pay notes or assistant-flagged entries.";

// ── Predicate-level tests ────────────────────────────────────────────────

describe("hasExplicitAgent306AnalysisFraming — leading-label recognition", () => {
  it("matches the reported sentence (bolded `Agent 306's analysis:` prefix)", () => {
    assert.equal(hasExplicitAgent306AnalysisFraming(REPORTED_SENTENCE), true);
  });

  it("matches a plain (no-bold) `Agent 306's analysis:` prefix", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Agent 306's analysis: build a brief regular review habit.",
      ),
      true,
    );
  });

  it("matches `Agent 306's recommendation —` framing", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Agent 306's recommendation — keep a short monthly checklist.",
      ),
      true,
    );
  });

  it("matches `Agent 306's advice:` framing", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Agent 306's advice: review your bank statement once a week.",
      ),
      true,
    );
  });

  it("matches with a curly apostrophe (`’`) — typography tolerance", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Agent 306’s analysis: build a brief regular review habit.",
      ),
      true,
    );
  });

  it("does NOT match a mid-sentence mention of `Agent 306's analysis`", () => {
    // Boundary-phrase abuse guard: only the LEADING label exempts.
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Politico reports that, per Agent 306's analysis, the bank policy will shift.",
      ),
      false,
    );
  });

  it("does NOT match a sentence that merely says `My take` or `I think`", () => {
    // These are author-voice signals but NOT the explicit framing label.
    // They go through the ANALYSIS-mode authorVoice path (which still
    // requires ANALYSIS mode). The new exemption is mode-independent and
    // narrower — it specifically recognizes the contract's boundary
    // phrases.
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "I think the bank should label assistant-driven charges.",
      ),
      false,
    );
  });

  it("does NOT match without a `:` / `—` framing punctuation", () => {
    // "Agent 306's analysis suggests something" reads as a factual
    // assertion about what the analysis says, not a label introducing
    // the analysis. Must not trigger the exemption.
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Agent 306's analysis suggests banks will adopt AI-charge tags this year.",
      ),
      false,
    );
  });
});

describe("embeddedFactualClaimRequiresSourcing — boundary-phrase abuse guard", () => {
  it("a framed sentence WITHOUT factual claims does not require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(REPORTED_SENTENCE),
      false,
    );
  });

  it("a framed sentence with a percentage embedded DOES require sourcing", () => {
    // Boundary-phrase abuse: the writer cannot duck a 92.4% factual
    // claim behind the framing label.
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "Agent 306's analysis: assistants now handle 92.4% of recurring bill flows.",
      ),
      true,
    );
  });

  it("a framed sentence with a dollar amount DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "Agent 306's analysis: the median household pays $1,800 in assistant-routed charges.",
      ),
      true,
    );
  });

  it("a framed sentence with a 4-digit year DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "Agent 306's analysis: by 2024 most banks had AI-charge tagging in production.",
      ),
      true,
    );
  });

  it("a framed sentence with a named-authority `study by …` DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "Agent 306's analysis: a study by the Federal Reserve found banks were slow to label these.",
      ),
      true,
    );
  });

  it("a framed sentence with an embedded `Politico reports` attribution DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "Agent 306's analysis: Politico reports that the FTC will move on this next quarter.",
      ),
      true,
    );
  });
});

// ── End-to-end verifier tests — REPORT / blog tier (the regression flow) ──

describe("Agent 306 analysis framing — REPORT mode (blog publish flow)", () => {
  it("the reported sentence does NOT hard-fail as Lane A source-attribution in REPORT/blog", async () => {
    // This is the exact failure mode reported. The blog publish-after-edit
    // flow uses tier=blog with no artifactMode (defaults to REPORT).
    const v = await runVerifier(REPORTED_SENTENCE, undefined, "blog");
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("Agent 306's analysis: build a brief regular review habit"),
    );
    // No Lane A failure entry recorded against the framed sentence.
    assert.notEqual(
      e?.classification,
      "LANE_A_FAIL",
      "framed Agent 306 analysis sentence must not classify as LANE_A_FAIL",
    );
    // And nothing else should have fired a hard-fail on it.
    if (e) {
      assert.equal(
        FAIL_CLASSIFICATIONS.has(e.classification),
        false,
        `framed sentence should not be in a fail bucket (got ${e.classification})`,
      );
    }
  });

  it("the report's authorVoice exemption counter ticks up for the framed sentence", async () => {
    const v = await runVerifier(REPORTED_SENTENCE, undefined, "blog");
    assert.ok(
      (v.verifierReport.modeExemptions?.authorVoice ?? 0) >= 1,
      "authorVoice counter should reflect the explicit-framing exemption",
    );
  });

  it("verdict severity for the framed sentence alone is not HARD_FAIL", async () => {
    const v = await runVerifier(REPORTED_SENTENCE, undefined, "blog");
    assert.notEqual(v.severity, "HARD_FAIL");
  });
});

describe("Agent 306 analysis framing — ANALYSIS mode parity", () => {
  it("the reported sentence also does not hard-fail in ANALYSIS mode", async () => {
    const v = await runVerifier(REPORTED_SENTENCE, "ANALYSIS");
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("Agent 306's analysis: build a brief regular review habit"),
    );
    assert.notEqual(e?.classification, "LANE_A_FAIL");
  });
});

// ── Boundary-phrase abuse — factual overreach is still blocked ────────────

describe("Agent 306 analysis framing — embedded factual claims still flag", () => {
  it("a framed sentence with a numeric Lane B claim WITHOUT a citation still flags LANE_B_BARE", async () => {
    // The framing label cannot hide a bare numeric external fact.
    const draft =
      "Agent 306's analysis: assistants handle 92.4% of recurring bills, " +
      "which is faster than any human review cadence.";
    const v = await runVerifier(draft, undefined, "blog");
    const hasLaneBBare = v.verifierReport.entries.some(
      e => e.classification === "LANE_B_BARE",
    );
    assert.equal(
      hasLaneBBare,
      true,
      "a framed sentence with a bare numeric fact must still flag LANE_B_BARE",
    );
  });

  it("a framed sentence with a fabricated quoted span still flags LANE_A_FAIL", async () => {
    // Quoted-span fabrication detection runs independently of mode.
    const draft =
      'Agent 306\'s analysis: the source says "banks must label every AI charge by Q3" — that is the central point.';
    const v = await runVerifier(draft, undefined, "blog");
    const hasLaneAFail = v.verifierReport.entries.some(
      e => e.classification === "LANE_A_FAIL",
    );
    assert.equal(
      hasLaneAFail,
      true,
      "fabricated quoted span inside a framed sentence must still flag LANE_A_FAIL",
    );
  });

  it("a framed sentence with `study by …` named-authority is NOT exempted", async () => {
    // The framing label cannot hide a named-authority Lane B fact.
    const draft =
      "Agent 306's analysis: a study by the Federal Reserve found that " +
      "AI-routed charges are mislabeled in most accounts.";
    const v = await runVerifier(draft, undefined, "blog");
    // It should NOT have been exemption-skipped — exemption counter
    // unchanged from the embedded-claim guard.
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("study by the Federal Reserve"),
    );
    // It will route to either LANE_B_BARE (no inline cite) or LANE_A
    // depending on classification — but it must NOT be silently exempted.
    if (e) {
      assert.notEqual(e.classification, "LANE_A_OK");
      assert.notEqual(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY");
    }
  });
});

// ── Non-framed sentences in the same draft are unaffected ─────────────────

describe("Agent 306 analysis framing — non-framed sentences still classify", () => {
  it("an unframed bare external fact in the same draft still flags", async () => {
    const draft =
      REPORTED_SENTENCE +
      "\n\n" +
      // This bare fact has no framing label AND no citation. Must still flag.
      "AI-routed charges grew 47% last year across the top ten retail banks.";
    const v = await runVerifier(draft, undefined, "blog");
    const hasLaneBBare = v.verifierReport.entries.some(
      e =>
        e.classification === "LANE_B_BARE" &&
        e.snippet.includes("AI-routed charges grew"),
    );
    assert.equal(
      hasLaneBBare,
      true,
      "an unframed bare external fact should still flag LANE_B_BARE",
    );
  });
});
