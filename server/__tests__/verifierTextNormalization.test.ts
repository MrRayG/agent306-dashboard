/**
 * PR-H — Verifier text-normalization regression suite.
 *
 * Pins the bug captured in pr_h_spec.md: the live OpenAI principles Deep Read
 * had four quoted phrases flagged as `LANE_A_FAIL: fabricated quote` even
 * though they appear verbatim in the live source. The matcher used in
 * server/claimVerifier.ts at the deterministic "fabricated quote" gate
 * (lines 494-524) is `normalizedContains(sourceText, span)` whose `normalize`
 * step is just `lowercase + whitespace collapse` — no Unicode NFC, no quote
 * folding, no hyphen/dash folding, no NBSP folding.
 *
 * The fixture file mirrors the live source's typography exactly: curly
 * double quotes (U+201C/U+201D), curly apostrophes (U+2019), a U+2011
 * non-breaking hyphen in `GPT‑2`, an em dash (U+2014), and one NBSP
 * (U+00A0) inside the Adaptability paragraph.
 *
 * The drafts in these tests use the exact ASCII forms the writer would
 * produce — straight quotes, ASCII hyphens, regular spaces — so the only
 * difference between the claim text and the source text is the Unicode /
 * typography. This is the canonical bug shape.
 *
 * Run: npx tsx --test server/__tests__/verifierTextNormalization.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Hermetic — the deterministic fabricated-quote check does not require an
// LLM judge. We pass skipLLM:true so the suite is fully offline.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { verifyClaims } from "../claimVerifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, "fixtures/openai-principles-2026-04-26.txt");
const SOURCE_TEXT = fs.readFileSync(FIXTURE_PATH, "utf8");
const SOURCE_URL = "https://openai.com/index/our-principles/";
const SOURCE_TITLE = "Our Principles";

/** Run the production verifier on a draft and return the entries that the
 *  deterministic fabricated-quote gate flagged as LANE_A_FAIL with the
 *  "fabricated quote:" reason prefix. We assert specifically against this
 *  prefix so we don't accidentally pass when the verifier marks the same
 *  sentence as Lane B BARE or another classification. */
async function fabricatedQuoteEntries(draftText: string) {
  const verdict = await verifyClaims({
    draftText,
    sourceText:  SOURCE_TEXT,
    sourceUrl:   SOURCE_URL,
    sourceTitle: SOURCE_TITLE,
    skipLLM:     true,
  });
  return verdict.verifierReport.entries.filter(
    e => e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason),
  );
}

// ── 1. Four real false positives (lifted verbatim from the spec) ───────────

describe("PR-H — four confirmed false positives flagged on the live OpenAI principles Deep Read", () => {

  // Pure-ASCII short phrases. These exercise the simplest case: claim text
  // is ASCII, fixture has the substring, naive lowercase+whitespace fold is
  // sufficient. Pre-PR-H these MIGHT have passed for some phrasings — but
  // production logs flagged them, which means the actual writer-produced
  // quoted span contained a Unicode variant somewhere in the surrounding
  // text. The longer-span variant of each phrase below mirrors that case.
  for (const phrase of [
    "misplaced worry",
    "new economic models",
    "democratic processes",
    "No AI lab can ensure a good future alone.",
  ]) {
    it(`does NOT flag "${phrase}" (short ASCII span) as fabricated`, async () => {
      const draft = `Altman wrote: "${phrase}"\n\nThe rest of the article unpacks why.`;
      const flagged = await fabricatedQuoteEntries(draft);
      const hits = flagged.filter(e => e.reason.includes(phrase));
      assert.equal(
        hits.length, 0,
        `expected "${phrase}" not to be flagged as fabricated; got: ${JSON.stringify(flagged.map(e => e.reason), null, 2)}`,
      );
    });
  }

  // Longer-span variants — these are what the writer typically produces
  // when transcribing a full sentence from the source. The writer normalizes
  // curly quotes / apostrophes / dashes / hyphens to ASCII while the source
  // (after cleanHtml) preserves the page's original Unicode. This is the
  // exact failure shape captured in production logs.

  it("does NOT flag the longer 'misplaced worry' sentence with ASCII apostrophes vs curly source", async () => {
    // Source has: "It wasn't that long ago that we were nervous about
    // releasing the weights of GPT‑2 because we weren't sure what the
    // impacts on society will be. Obviously in retrospect that was a
    // misplaced worry, ..." — with U+2019 apostrophes and U+2011 hyphen.
    const draft = `Altman wrote: "we weren't sure what the impacts on society will be. Obviously in retrospect that was a misplaced worry"`;
    const flagged = await fabricatedQuoteEntries(draft);
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });

  it("does NOT flag the longer 'No AI lab can ensure a good future alone' sentence", async () => {
    // The writer typically transcribes a longer span. The source's outer
    // quote uses U+201C/U+201D and the inner apostrophe (none here) is
    // straight. The bug manifests when the writer's longer span runs
    // through QUOTE_RX and the substring check fails because of a single
    // typographic mismatch somewhere in the span.
    const draft = `Altman wrote: "No AI lab can ensure a good future alone. For an obvious example, there may be extremely capable models that make it easier to create a new pathogen"`;
    const flagged = await fabricatedQuoteEntries(draft);
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });
});

// ── 2. Real fabrication regression — strictness must NOT relax ─────────────

describe("PR-H — real-fabrication regression (strictness must NOT relax)", () => {
  it("still flags a deliberately fabricated quote on the same source", async () => {
    // This phrase does not appear anywhere in the fixture, normalized or not.
    const draft = `Altman declared: "AGI by 2027 is now inevitable."`;
    const flagged = await fabricatedQuoteEntries(draft);
    const hit = flagged.find(e => /AGI by 2027/.test(e.reason));
    assert.ok(
      hit,
      "deliberately fabricated quote must still produce LANE_A_FAIL: fabricated quote",
    );
  });

  it("still flags a fabricated quote with all the same Unicode tricks (NBH, curly quotes)", async () => {
    // Same shape as a real bug: claim contains content that genuinely is
    // not in the source. Even with normalization, this must fail.
    const draft = `Altman wrote: "ChatGPT-4 is sentient and we have proof."`;
    const flagged = await fabricatedQuoteEntries(draft);
    const hit = flagged.find(e => /ChatGPT-4 is sentient/.test(e.reason));
    assert.ok(hit, "fabricated quote must fail even when the rest of the draft uses ASCII");
  });
});

// ── 3. Typographic-variant matrix — bidirectional ─────────────────────────

describe("PR-H — typographic variant matrix (bidirectional)", () => {

  // Each case is structured: a draft whose ONLY difference vs the verbatim
  // source is one typographic variant. After PR-H the matcher must accept
  // each as supported. Each case is justified by the corresponding
  // normalization step in server/textNormalization.ts.

  it("smart quotes in source vs. straight quotes in claim (curly→ASCII fold)", async () => {
    // The fixture wraps every block-quoted passage in U+201C/U+201D. The
    // claim writes the same phrase between ASCII straight quotes.
    const draft = `Altman wrote: "democratic processes and with egalitarian principles"`;
    const flagged = await fabricatedQuoteEntries(draft);
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });

  it("straight quotes in source vs. smart quotes in claim (curly→ASCII fold)", async () => {
    // Inverse of the case above — the writer pasted curly quotes; the
    // source we constructed for this case uses ASCII straight quotes.
    const localSource = 'The board reportedly said: "guardrails must hold."';
    const localDraft  = "The board reportedly said: “guardrails must hold.”";
    const verdict = await verifyClaims({
      draftText: localDraft,
      sourceText: localSource,
      sourceUrl: "https://example.com/x",
      sourceTitle: "X",
      skipLLM: true,
    });
    const flagged = verdict.verifierReport.entries.filter(
      e => e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason),
    );
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });

  it("U+2011 non-breaking hyphen in source vs. ASCII hyphen in claim (hyphen fold)", async () => {
    // The fixture has `GPT‑2` with U+2011. The writer types `GPT-2` with
    // ASCII U+002D.
    const draft = `Altman wrote: "the weights of GPT-2 because we weren't sure"`;
    const flagged = await fabricatedQuoteEntries(draft);
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });

  it("ASCII hyphen in source vs. U+2011 in claim (hyphen fold, reverse direction)", async () => {
    const localSource = "OpenAI shipped a new GPT-2 release.";
    const localDraft  = `Altman wrote: "shipped a new GPT‑2 release."`;
    const verdict = await verifyClaims({
      draftText: localDraft,
      sourceText: localSource,
      sourceUrl: "https://example.com/x",
      sourceTitle: "X",
      skipLLM: true,
    });
    const flagged = verdict.verifierReport.entries.filter(
      e => e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason),
    );
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });

  it("NBSP in source vs. regular space in claim (whitespace fold)", async () => {
    const localSource = "He said it was a misplaced worry that turned into iterative deployment.";
    const localDraft  = `Altman wrote: "misplaced worry that turned into"`;
    const verdict = await verifyClaims({
      draftText: localDraft,
      sourceText: localSource,
      sourceUrl: "https://example.com/x",
      sourceTitle: "X",
      skipLLM: true,
    });
    const flagged = verdict.verifierReport.entries.filter(
      e => e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason),
    );
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });

  it("em dash vs. en dash vs. ASCII double hyphen all match (dash fold)", async () => {
    const localSource = "We shipped quickly—faster than expected—and learned from it.";
    // En dash on one side
    const draftEn  = `Altman wrote: "shipped quickly–faster than expected–and learned from it"`;
    // ASCII double hyphen on the other
    const draftAscii = `Altman wrote: "shipped quickly--faster than expected--and learned from it"`;

    for (const [label, draft] of [["en-dash", draftEn] as const, ["ascii-double-hyphen", draftAscii] as const]) {
      const verdict = await verifyClaims({
        draftText: draft,
        sourceText: localSource,
        sourceUrl: "https://example.com/x",
        sourceTitle: "X",
        skipLLM: true,
      });
      const flagged = verdict.verifierReport.entries.filter(
        e => e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason),
      );
      assert.equal(flagged.length, 0, `${label} should match: ${JSON.stringify(flagged, null, 2)}`);
    }
  });

  it("curly apostrophe in source vs. straight apostrophe in claim", async () => {
    // Source has `weren’t` with U+2019; claim has ASCII `weren't`.
    const draft = `Altman wrote: "we weren't sure what the impacts on society"`;
    const flagged = await fabricatedQuoteEntries(draft);
    assert.equal(flagged.length, 0, JSON.stringify(flagged, null, 2));
  });
});

// ── 4. LANE_A_OK regression ────────────────────────────────────────────────

describe("PR-H — LANE_A_OK regression (passing cases must still pass)", () => {
  it("passes a Lane A attribution that paraphrases content verbatim in source", async () => {
    const draft = `According to the article, "democratic processes and with egalitarian principles" must be how key AI decisions are made.`;
    const verdict = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
    });
    // No LANE_A_FAIL entries on this draft.
    const failed = verdict.verifierReport.entries.filter(e => e.classification === "LANE_A_FAIL");
    assert.equal(failed.length, 0, `expected no LANE_A_FAIL; got: ${JSON.stringify(failed)}`);
    // At least one LANE_A_OK entry recorded for operator visibility.
    const ok = verdict.verifierReport.entries.filter(e => e.classification === "LANE_A_OK");
    assert.ok(ok.length >= 1, `expected at least one LANE_A_OK entry; got: ${JSON.stringify(verdict.verifierReport.entries)}`);
  });
});

// ── 5. LANE_B_BARE regression ──────────────────────────────────────────────

describe("PR-H — LANE_B_BARE regression (uncited external facts still flagged)", () => {
  it("still flags an uncited external numeric fact as LANE_B_BARE", async () => {
    // Bare external numeric fact — no attribution verb, no quoted span,
    // so it lands in Lane B. No inline markdown citation, so the verifier
    // must still flag this as LANE_B_BARE. PR-H must not change Lane B.
    const draft = `## My Take\n\nAdoption is moving fast — generative AI hit 54.6% US penetration in three years.\n\nClosing thoughts.`;
    const verdict = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
    });
    const bare = verdict.verifierReport.entries.filter(e => e.classification === "LANE_B_BARE");
    assert.ok(bare.length >= 1, `expected at least one LANE_B_BARE entry; got: ${JSON.stringify(verdict.verifierReport.entries)}`);
  });
});
