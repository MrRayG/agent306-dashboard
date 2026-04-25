/**
 * Tests for server/claimVerifier.ts
 *
 * Motivation: on 2026-04-22 Agent 306 shipped a "Deep Read" that
 * fabricated statistics, three unnamed AI developers, and a quote
 * ("We're not losing the arms race. We're discovering the race itself
 * may be unwinnable in the limit") none of which appeared in the
 * actual Politico source. These tests lock in the regression.
 *
 * We skip the LLM paraphrase step (skipLLM: true) so the suite is
 * hermetic — the deterministic checks (quote verbatim, statistic
 * verbatim when attributed) are sufficient to catch the specific
 * fabrications from the Politico incident.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Keep hermetic — the LLM fallback should not fire with skipLLM.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { verifyClaims } from "../claimVerifier.js";

describe("verifyClaims — deterministic checks", () => {
  it("SUPPORTED: quote present verbatim in source", async () => {
    const sourceText =
      "The researchers said the model was 'remarkably robust' to prompt injection attacks. " +
      "Full findings will be published later this month.";
    const draftText =
      'According to the article, the team called the model "remarkably robust" to prompt injection.';

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://example.com/article",
      sourceTitle: "Prompt-injection robustness study",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, true, "verdict should pass");
    assert.equal(verdict.unsupportedClaims.length, 0);
    assert.ok(verdict.supportedCount >= 1, "at least one supported claim");
  });

  it("UNSUPPORTED: quote absent from source → fabricated quote", async () => {
    const sourceText =
      "The researchers said the model was remarkably robust to prompt injection attacks.";
    const draftText =
      'The report quotes a lead researcher saying "we have solved alignment entirely" — a sweeping claim.';

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://example.com/article",
      sourceTitle: "Prompt-injection robustness study",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, false, "verdict should fail");
    const fab = verdict.unsupportedClaims.find(c => c.reason === "fabricated quote");
    assert.ok(fab, "should flag a fabricated quote");
    assert.ok(
      fab!.sentence.includes("solved alignment"),
      "flagged quote should be the fabricated one",
    );
  });

  it("SUPPORTED: statistic present in source when attributed", async () => {
    const sourceText =
      "The DHS demo showed that over 40% of requests successfully produced unsafe outputs when " +
      "the model was prompted with nested jailbreaks. Lawmakers watched in silence.";
    const draftText =
      "According to the article, over 40% of requests produced unsafe outputs under nested jailbreaks.";

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://example.com/article",
      sourceTitle: "DHS jailbreak demo",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, true, "verdict should pass");
    assert.equal(verdict.unsupportedClaims.length, 0);
  });

  it("UNSUPPORTED: attributed statistic not in source", async () => {
    // Source has no percentage at all — draft claims "60%" attributed to the article.
    const sourceText =
      "The DHS demonstration showed House lawmakers how a jailbroken model could respond " +
      "to requests for dangerous information. Members were visibly uneasy.";
    const draftText =
      "The article reports that jailbreak success rates have climbed to 60% on certain 2026 releases.";

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://example.com/article",
      sourceTitle: "DHS jailbreak demo",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, false, "verdict should fail");
    const statFail = verdict.unsupportedClaims.find(c =>
      c.reason.includes("60%") || c.reason.includes('statistic'),
    );
    assert.ok(statFail, `should flag the 60% statistic as unsupported. Got: ${JSON.stringify(verdict.unsupportedClaims)}`);
  });

  it("REGRESSION: Politico jailbreak post fabrications must all reject", async () => {
    // Paraphrase of the actual Politico article (Dana Nickel, 2026-04-22,
    // "House lawmakers get a chilling demo of 'jailbroken' AI"). No stats,
    // no 10%/60% figures, no "three major developers" naming, no
    // "arms race" quote — those were all invented by Agent 306.
    const sourceText = [
      "House lawmakers received a live demonstration from the Department of Homeland ",
      "Security on Wednesday showing how commercial AI chatbots can be 'jailbroken' to ",
      "produce detailed instructions for making weapons and planning attacks. DHS officials ",
      "walked members of the counterterrorism subcommittee through a series of prompts that ",
      "bypassed built-in safety guardrails on popular chatbots. One staffer described the ",
      "demonstration as 'genuinely chilling.' Lawmakers from both parties asked DHS officials ",
      "what legislative action could meaningfully constrain how large models handle ",
      "extremist content. No specific bill was introduced during the hearing.",
    ].join("");

    // The offending paragraphs as shipped by Agent 306 on 2026-04-22.
    const draftText = [
      'According to Politico, jailbreak success rates have climbed from under 10% in 2023 ',
      'models to over 60% on certain 2026 releases.',
      ' ',
      'The report quotes an unnamed researcher: "We\'re not losing the arms race. We\'re ',
      'discovering the race itself may be unwinnable in the limit."',
      ' ',
      'The article cites three major AI developers who, speaking on background, acknowledged ',
      'that constitutional-AI refusal rates have fallen from 95% in 2024 to roughly 40% under ',
      'current DAN-style attacks.',
    ].join("");

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://www.politico.com/news/2026/04/22/ai-chatbots-jailbreak-safety-00887869",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, false, "Politico post fabrications MUST be rejected");

    const flagged = verdict.unsupportedClaims;
    const flaggedText = JSON.stringify(flagged);

    // Every one of the four specific fabrications listed in the incident
    // writeup must be flagged by name. These assertions are the regression.
    assert.ok(
      flagged.some(c => c.sentence.includes("10%")) || flaggedText.includes('"10%"'),
      `must flag the "10%" statistic. Flagged: ${flaggedText}`,
    );
    assert.ok(
      flagged.some(c => c.sentence.includes("60%")) || flaggedText.includes('"60%"'),
      `must flag the "60%" statistic. Flagged: ${flaggedText}`,
    );
    assert.ok(
      flagged.some(c => c.sentence.includes('arms race') || c.reason === "fabricated quote"),
      `must flag the "arms race" quote. Flagged: ${flaggedText}`,
    );
    // "95%" and "40%" attributed stats
    assert.ok(
      flagged.some(c => c.sentence.includes("95%")) || flaggedText.includes('"95%"'),
      `must flag the "95%" statistic. Flagged: ${flaggedText}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TWO-LANE STANDARD TESTS (added 2026-04-25, v2 incident)
// ─────────────────────────────────────────────────────────────────────────

describe("verifyClaims — Lane A (source-attributed)", () => {
  it("UNSUPPORTED: attributed sentence with claim not in source → lane='source-attributed'", async () => {
    const sourceText =
      "DHS officials walked House lawmakers through a demonstration of AI chatbot jailbreaks. " +
      "No specific legislative proposal was introduced at the hearing.";
    // Same 60% attributed-statistic pattern, explicit lane assertion this time.
    const draftText =
      "According to Politico, jailbreak success rates have climbed from under 10% in 2023 " +
      "models to over 60% on certain 2026 releases.";

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://www.politico.com/news/",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, false);
    const laneA = verdict.unsupportedClaims.find(c => c.lane === "source-attributed");
    assert.ok(laneA, `expected a source-attributed flag. Got: ${JSON.stringify(verdict.unsupportedClaims)}`);
  });
});

describe("verifyClaims — Lane B (external facts)", () => {
  it("UNSUPPORTED: external stat without a citation link → lane='external-uncited'", async () => {
    const sourceText =
      "DHS officials walked House lawmakers through a demonstration of AI chatbot jailbreaks.";
    const draftText =
      "This fits the broader arc of AI adoption. AI has reached 54.6% adoption in the US in " +
      "just three years.";

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://www.politico.com/news/",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
      skipLLM:     true,
    });

    const laneB = verdict.unsupportedClaims.find(c => c.lane === "external-uncited");
    assert.ok(laneB, `expected an external-uncited flag. Got: ${JSON.stringify(verdict.unsupportedClaims)}`);
    // Lane B alone does not flip ok=false — only Lane A / embedded do.
    assert.equal(verdict.ok, true, "Lane B uncited alone is a warning, not a hard fail");
  });

  it("SUPPORTED: external stat with a markdown citation link → counted in externalCitedCount", async () => {
    const sourceText =
      "DHS officials walked House lawmakers through a demonstration of AI chatbot jailbreaks.";
    const draftText =
      "This fits the broader arc of AI adoption. AI has reached 54.6% adoption in the US " +
      "in just three years, per [Stanford HAI's 2025 AI Index](https://hai.stanford.edu/ai-index/2025-ai-index-report).";

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://www.politico.com/news/",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, true);
    assert.ok(
      verdict.externalCitedCount >= 1,
      `expected an externalCitedCount >= 1, got ${verdict.externalCitedCount}`,
    );
    const laneB = verdict.unsupportedClaims.find(c => c.lane === "external-uncited");
    assert.equal(laneB, undefined, "cited Lane B fact should not be flagged");
  });
});

describe("verifyClaims — NCITE pattern (embedded-external-in-attribution)", () => {
  it("HARD FAIL: Lane B fact dressed as Lane A reporting → lane='embedded-external-in-attribution'", async () => {
    // Actual Politico article extract — the source says "research from NCITE"
    // and does NOT describe it as a DHS Center of Excellence or mention funding.
    const sourceText = [
      "Researchers from NCITE presented findings on how bad actors can override ",
      "safeguards in popular AI tools. The demonstration, run for members of the ",
      "House counterterrorism subcommittee, showed how jailbreaks could coax a ",
      "commercial chatbot into returning step-by-step instructions for dangerous ",
      "activities. Lawmakers from both parties asked follow-up questions. No ",
      "specific legislative proposal was introduced at the hearing.",
    ].join("");

    // The literal failing sentence from 2026-04-24. The "Center of Excellence"
    // + funding detail is factually true about NCITE but is NOT in the article
    // — so presenting it inside "presented findings" is an embedded external
    // fact dressed as reporting.
    const draftText =
      "researchers from NCITE, a DHS Center of Excellence that receives funding from the " +
      "Department of Homeland Security, presented findings on how bad actors can override " +
      "safeguards in popular AI tools.";

    const verdict = await verifyClaims({
      draftText,
      sourceText,
      sourceUrl:   "https://www.politico.com/news/",
      sourceTitle: "House lawmakers get a chilling demo of jailbroken AI",
      skipLLM:     true,
    });

    assert.equal(verdict.ok, false, "NCITE pattern must hard-fail");
    const embedded = verdict.unsupportedClaims.find(
      c => c.lane === "embedded-external-in-attribution",
    );
    assert.ok(
      embedded,
      `expected embedded-external-in-attribution flag. Got: ${JSON.stringify(verdict.unsupportedClaims)}`,
    );
    assert.ok(
      embedded!.sentence.toLowerCase().includes("ncite"),
      "flagged sentence should be the NCITE appositive sentence",
    );
  });
});
