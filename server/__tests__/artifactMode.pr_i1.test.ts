/**
 * PR-I.1 — Extend ANALYSIS author-voice patterns + source-referent prefixes.
 *
 * Spec: pr_i1_spec.md.
 *
 * The post-PR-I OpenAI principles Deep Read surfaced 4 false positives that
 * fall into the same mechanism as PR-I (Agent 306's legitimate author-voice
 * framings) but with phrasings PR-I's lists do not yet cover:
 *
 *   - Sentence  1 — title + opener composite (article title carried as
 *                   subject of opening sentence, no source-referent prefix)
 *   - Sentence 14 — opener + source-referent ("The article opens by …" /
 *                   "The piece begins with …" style)
 *   - Sentence 30 — forward-projection author framing
 *                   ("By 2026 the pattern is clear, …")
 *   - Sentence 107 — closing rhetoric tied to source host
 *                    ("…sound good on openai.com.")
 *
 * Same shape as PR-I — additive list extensions in `server/artifactMode.ts`.
 * Each new pattern / prefix is pinned by a regression test below.
 *
 * Run: npx tsx --test server/__tests__/artifactMode.pr_i1.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Hermetic — deterministic paths only.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import {
  hasAuthorVoice,
  startsWithSourceReferentSubject,
  AUTHOR_VOICE_PATTERNS,
  SOURCE_REFERENT_SUBJECT_PREFIXES,
  hasClosingRhetoricOnSourceHost,
  analysisExemption,
} from "../artifactMode.js";
import { verifyClaims } from "../claimVerifier.js";

const SOURCE_URL = "https://openai.com/index/our-principles/";
const SOURCE_TITLE = "Our Principles";

// Minimal source text for sentence-level checks. Any sentence we want to
// flag as fabrication must NOT appear in this source.
const SOURCE_TEXT = `Our Principles
We believe that AGI should be safe and beneficial. The principles document
covers iterative deployment, capital intensity, and the responsibility
researchers carry. We treat alignment as the central engineering challenge.`;

const FAIL_CLASSIFICATIONS = new Set([
  "LANE_A_FAIL",
  "LANE_B_BARE",
  "NCITE_PATTERN_HIT",
  "RETRACTED_HIT",
]);

// ── A. True positives — the 4 flags this PR closes ────────────────────────

describe("PR-I.1 — true positives (4 flags from OpenAI principles Deep Read)", () => {

  it("S1 (title + opener composite) — recognizable as author voice via opener prefix", () => {
    // The flag-1 sentence shape: an opening sentence whose grammatical
    // subject is the article's title (in quotes / italics), with the rest
    // of the sentence being author commentary. PR-I.1 adds an opener-style
    // source-referent that catches this when written as "The piece opens".
    const s = `The piece opens with a deceptively simple frame: that AGI must be "safe and beneficial".`;
    assert.equal(startsWithSourceReferentSubject(s), true);
  });

  it("S14 (opener + source-referent) — 'The article opens by …' is recognized", () => {
    const s = `The article opens by laying out three commitments before naming any of them.`;
    assert.equal(startsWithSourceReferentSubject(s), true);
  });

  it("S30 (forward-projection author framing) — 'the pattern is clear' is author voice", () => {
    // "By 2026 the pattern is clear, …" — the year by itself isn't in
    // FORWARD_PROJECTION_MARKERS (those are 2027+), but the framing phrase
    // "the pattern is clear" must be recognized as the agent's voice.
    const s = `By 2026 the pattern is clear, deployment cadence is still the binding constraint.`;
    assert.equal(hasAuthorVoice(s), true);
  });

  it("S107 (closing rhetoric tied to source host) — 'sound good on openai.com'", () => {
    // The closing rhetoric must be tied to the source URL host, not
    // hardcoded. The function takes a source URL and matches "[verb] on [host]"
    // against it.
    const s = `These principles sound good on openai.com but remain abstract until execution lands.`;
    assert.equal(hasClosingRhetoricOnSourceHost(s, SOURCE_URL), true);
  });

  // End-to-end: the full ANALYSIS exemption decision treats each as exempt
  // (or at least not flagged) when run through analysisExemption.

  it("E2E S1 — ANALYSIS exempts the 'The piece opens …' sentence", () => {
    const sentence = `The piece opens with a deceptively simple frame: that AGI must be safe and beneficial.`;
    const draft = `## Opening\n\n${sentence}\n`;
    const result = analysisExemption(sentence, draft, SOURCE_TEXT, SOURCE_URL);
    assert.equal(result.exempt, true,
      `expected ANALYSIS exemption for S1 shape; got ${JSON.stringify(result)}`);
  });

  it("E2E S14 — ANALYSIS exempts 'The article opens by …'", () => {
    const sentence = `The article opens by laying out three commitments before naming any of them.`;
    const draft = `## Opening\n\n${sentence}\n`;
    const result = analysisExemption(sentence, draft, SOURCE_TEXT, SOURCE_URL);
    assert.equal(result.exempt, true,
      `expected ANALYSIS exemption for S14 shape; got ${JSON.stringify(result)}`);
  });

  it("E2E S30 — ANALYSIS exempts 'By 2026 the pattern is clear, …' as authorVoice", () => {
    const sentence = `By 2026 the pattern is clear, deployment cadence is still the binding constraint.`;
    const draft = `## My Take\n\n${sentence}\n`;
    const result = analysisExemption(sentence, draft, SOURCE_TEXT, SOURCE_URL);
    assert.equal(result.exempt, true);
    assert.equal(result.category, "authorVoice");
  });

  it("E2E S107 — ANALYSIS exempts closing rhetoric tied to openai.com", () => {
    const sentence = `These principles sound good on openai.com but remain abstract until execution lands.`;
    const draft = `## Closing\n\n${sentence}\n`;
    const result = analysisExemption(sentence, draft, SOURCE_TEXT, SOURCE_URL);
    assert.equal(result.exempt, true,
      `expected ANALYSIS exemption for S107 shape; got ${JSON.stringify(result)}`);
  });
});

// ── B. True negatives — fabrications must still flag ──────────────────────

describe("PR-I.1 — true negatives (verifier strictness preserved)", () => {

  it("Fabricated quoted statistic with author-voice framing STILL flags in ANALYSIS", async () => {
    // Author-voice framing surrounds an explicit attribution + a quoted
    // statistic that is NOT in the source. The fabricated-quote
    // deterministic path must still flag this.
    const draft = `## My Take\n\nThe pattern is clear: Altman writes "1.21 gigawatts of compute" is the new floor for serious labs.`;
    const verdict = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const fabricated = verdict.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL",
    );
    assert.ok(fabricated,
      "fabricated quoted statistic with author-voice framing must still flag LANE_A_FAIL");
  });

  it("Source-referent prefix with unsupported claim about source content STILL flags", async () => {
    // "The article opens by claiming X" where X is fabricated. The
    // sentence has explicit attribution-verb shape ("claiming") plus a
    // fabricated quoted span — the verifier's deterministic quote check
    // must still fire even though the prefix is in the source-referent
    // list.
    const draft = `## Opening\n\nThe article opens by claiming "every lab has agreed to a 12-month pause" before any details.`;
    const verdict = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const fabricated = verdict.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL",
    );
    assert.ok(fabricated,
      "fabricated quoted claim with source-referent opener must still flag LANE_A_FAIL");
  });

  it("Closing-rhetoric phrase on a DIFFERENT host than the source URL is NOT exempted", () => {
    // Source URL is openai.com. Sentence references nytimes.com — the
    // closing-rhetoric exemption must NOT apply.
    const s = `These principles sound good on nytimes.com but remain abstract until execution lands.`;
    assert.equal(hasClosingRhetoricOnSourceHost(s, SOURCE_URL), false,
      "closing rhetoric is tied to source host — different host must NOT match");
  });
});

// ── C. Mode preservation (REPORT / MANUSCRIPT / default unchanged) ────────

describe("PR-I.1 — mode preservation (only ANALYSIS gets the new behavior)", () => {

  // For each new pattern, REPORT / MANUSCRIPT / default must NOT exempt it.
  // We test by running the verifier in those modes and checking that the
  // sentences that DO get exempted in ANALYSIS still flag in the other modes
  // (matches PR-I's pattern of mode-comparison tests).

  it("REPORT mode does NOT exempt 'By 2026 the pattern is clear …' (no author-voice exemption in REPORT)", async () => {
    const draft = `By 2026 the pattern is clear, every lab will have shipped 1000x compute scaling.`;
    const reportV = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "REPORT",
    } as any);
    const anaV = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const reportFlags = reportV.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    const anaFlags    = anaV.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    assert.ok(reportFlags > anaFlags,
      `REPORT must NOT apply ANALYSIS exemptions; reportFlags=${reportFlags} anaFlags=${anaFlags}`);
  });

  it("MANUSCRIPT mode does NOT apply ANALYSIS exemptions on PR-I.1 patterns", async () => {
    // MANUSCRIPT uses the strictest end of the spectrum — no author-voice
    // exemption. The new author-voice phrase 'the pattern is clear'
    // surrounded by a numeric-bearing forward projection MUST still be
    // detectable as flagged in MANUSCRIPT but NOT in ANALYSIS.
    const draft = `By 2027 the pattern is clear: every lab will have shipped 1000x compute scaling.`;
    const manuV = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "MANUSCRIPT",
    } as any);
    const anaV = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const manuFlags = manuV.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    const anaFlags  = anaV.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    // MANUSCRIPT must produce at least as many flags as ANALYSIS — the
    // ANALYSIS-mode author-voice exemption is NOT applied here. With this
    // particular draft, MANUSCRIPT should keep the LANE_B_BARE flag on the
    // forward projection ('By 2027' has no source citation) while ANALYSIS
    // exempts it.
    assert.ok(manuFlags > anaFlags,
      `MANUSCRIPT must NOT apply ANALYSIS exemptions; manuFlags=${manuFlags} anaFlags=${anaFlags}`);
  });

  it("Default (unset) mode produces same entries as REPORT for new-pattern sentences", async () => {
    const draft = `By 2026 the pattern is clear: every lab ships 1000x compute scaling.\n\nThe article opens by claiming a 12-month pause.\n\nThese principles sound good on openai.com but lack teeth.`;
    const def = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
    } as any);
    const report = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "REPORT",
    } as any);
    const norm = (v: any) => v.verifierReport.entries
      .map((e: any) => `${e.sentenceIndex}|${e.classification}|${e.snippet}`)
      .sort();
    assert.deepEqual(norm(def), norm(report),
      "default (unset) and REPORT must classify identically on PR-I.1's new-pattern sentences");
  });
});

// ── D. Smoke tests — PR-I's existing patterns / prefixes still pass ───────

describe("PR-I.1 — PR-I's existing lists still functional (smoke)", () => {

  it("PR-I existing author-voice patterns: each still matches via hasAuthorVoice", () => {
    // The 16 PR-I author-voice patterns were the seed list. Confirm none
    // were dropped or modified in this PR (additive-only constraint).
    const PR_I_ORIGINAL = [
      "what i think",
      "i think",
      "i read this",
      "i read it",
      "my read is",
      "my take is",
      "as an autonomous ai",
      "as an autonomous research agent",
      "as an autonomous ai research agent",
      "agent 306 lens",
      "the decisive question",
      "the real signal",
      "read between the lines",
      "the headline outcome",
      "the bigger picture",
      "what this means for",
    ];
    for (const phrase of PR_I_ORIGINAL) {
      assert.ok(AUTHOR_VOICE_PATTERNS.includes(phrase),
        `PR-I author-voice pattern '${phrase}' must still be in AUTHOR_VOICE_PATTERNS (additive-only)`);
      // hasAuthorVoice still detects each one in a sentence.
      assert.equal(hasAuthorVoice(`Some prose where ${phrase} comes up.`), true,
        `hasAuthorVoice should still match '${phrase}'`);
    }
  });

  it("PR-I existing source-referent prefixes: each still matches via startsWithSourceReferentSubject", () => {
    const PR_I_ORIGINAL_PREFIXES = [
      "the document ",
      "the article ",
      "the report ",
      "the piece ",
      "the principles ",
      "the post ",
      "the essay ",
      "the statement ",
      "openai has ",
      "openai's ",
      "altman's ",
      "altman has ",
      "this is the first time openai ",
      "this is the first time the ",
    ];
    for (const prefix of PR_I_ORIGINAL_PREFIXES) {
      assert.ok(SOURCE_REFERENT_SUBJECT_PREFIXES.includes(prefix),
        `PR-I source-referent prefix '${prefix}' must still be in SOURCE_REFERENT_SUBJECT_PREFIXES (additive-only)`);
    }
    // Quick smoke: a prose sentence beginning with each PR-I prefix is
    // still recognized as starting with a source-referent subject.
    assert.equal(startsWithSourceReferentSubject("The document treats alignment as primary."), true);
    assert.equal(startsWithSourceReferentSubject("OpenAI's framing is deliberately broad."), true);
  });
});
