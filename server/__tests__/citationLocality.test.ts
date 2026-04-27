/**
 * PR-E regression tests — citation locality + source object plumbing.
 *
 * Failure cases captured here:
 *
 *  1. Adjacent-citation: hard factual claim in sentence A, URL only in
 *     sentence B (different paragraph). Pre-repair, the verifier flags
 *     LANE_B_BARE on sentence A. Post-repair, the citation lands in
 *     sentence A's paragraph (or A directly), and the verifier passes.
 *
 *  2. Date / number claim in a paragraph with NO citation triggers
 *     LANE_B_BARE. After repair (with a relevant source supplied), the
 *     paragraph carries an inline citation and the verifier passes.
 *
 *  3. Analytical / opinion sentence without an external factual claim
 *     does NOT require a citation — the repair pass leaves it alone and
 *     the verifier reports PASS.
 *
 *  4. Repair never introduces a fabricated URL. When no relevant source
 *     exists, the bare fact is hedged (verbal generalization) instead of
 *     receiving a made-up citation. Every URL in the repaired draft must
 *     have been present in the input source pool.
 *
 *  5. Source objects survive end-to-end: the structured pool passed into
 *     the writer context is preserved into the verifier's evidence
 *     bundle (telemetry counts and prompt block reflect the same set).
 *
 * Run: npx tsx --test server/__tests__/citationLocality.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Hermetic — the verifier's LLM paraphrase step is bypassed via skipLLM.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { verifyClaims } from "../claimVerifier.js";
import {
  type SourceObject,
  buildSourcesPromptBlock,
  computeSourceTelemetry,
  countBareExternalFactSentences,
  extractSourceObjects,
  isLaneBFactSentence,
  pickSourceForSentence,
  repairCitationLocality,
} from "../sourceLocality.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function urlsIn(text: string): Set<string> {
  const out = new Set<string>();
  const rx = /https?:\/\/[^\s)]+/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    out.add(m[0].replace(/[.,;:!?]+$/, ""));
  }
  return out;
}

const OPENAI_PRINCIPLES_URL = "https://openai.com/index/our-principles/";

const ALTMAN_DRAFT_BARE = `## OpenAI Just Retired Safety as Its North Star

On April 26, 2026, Sam Altman published a 1,100-word statement.

In it he discussed OpenAI's approach to its work. ${OPENAI_PRINCIPLES_URL}

The shift is striking — what used to be the public commitment is now framed as one principle among many.`;

// ─────────────────────────────────────────────────────────────────────────────

describe("PR-E — citation locality repair pass", () => {

  // 1. Adjacent-citation regression.
  it("repairs the adjacent-citation case (URL is one paragraph away)", async () => {
    // Pre-repair sanity: the verifier flags LANE_B_BARE on the dated sentence.
    const preVerdict = await verifyClaims({
      draftText:   ALTMAN_DRAFT_BARE,
      sourceText:  "OpenAI published a statement on its principles.",
      sourceUrl:   OPENAI_PRINCIPLES_URL,
      sourceTitle: "Our Principles",
      skipLLM:     true,
    });
    const bareBefore = preVerdict.verifierReport.entries.filter(e => e.classification === "LANE_B_BARE");
    assert.ok(
      bareBefore.length >= 1,
      `expected at least one LANE_B_BARE pre-repair, got: ${JSON.stringify(preVerdict.verifierReport.summary)}`,
    );
    assert.ok(
      bareBefore.some(e => /April 26, 2026|1,?100-word/.test(e.snippet)),
      "expected the dated/numbered sentence to be flagged as LANE_B_BARE",
    );

    // Repair using a structured source pool that maps to the OpenAI URL.
    const sources: SourceObject[] = [{
      url:       OPENAI_PRINCIPLES_URL,
      title:     "Our Principles",
      publisher: "OpenAI",
      evidenceExcerpt: "Statement from Sam Altman on April 26, 2026, on OpenAI principles, 1,100 words.",
    }];
    const repair = repairCitationLocality(ALTMAN_DRAFT_BARE, sources);
    assert.ok(repair.citationsAdded >= 1, `expected at least one citation added, got ${repair.citationsAdded}`);
    assert.equal(repair.fabricatedUrls, 0, "repair must not fabricate URLs");

    const postVerdict = await verifyClaims({
      draftText:   repair.draft,
      sourceText:  "OpenAI published a statement on its principles.",
      sourceUrl:   OPENAI_PRINCIPLES_URL,
      sourceTitle: "Our Principles",
      skipLLM:     true,
    });
    const bareAfter = postVerdict.verifierReport.entries.filter(e =>
      e.classification === "LANE_B_BARE" && /April 26, 2026|1,?100-word/.test(e.snippet),
    );
    assert.equal(bareAfter.length, 0, `expected the dated sentence to no longer be LANE_B_BARE — entries: ${JSON.stringify(bareAfter)}`);
  });

  // 2. Date / number claim requires a same-sentence (or same-paragraph) citation.
  it("flags a bare date/number sentence as Lane B and clears it after repair", async () => {
    const draft = `Adoption of generative AI hit 54.6% in three years.

This is faster than the PC's 19.7% trajectory at the same mark, which industry observers find notable.`;

    assert.ok(isLaneBFactSentence("Adoption of generative AI hit 54.6% in three years."));

    const before = countBareExternalFactSentences(draft);
    assert.ok(before >= 1, `expected bare fact sentence, got ${before}`);

    const sources: SourceObject[] = [{
      url:       "https://hai.stanford.edu/ai-index-2026",
      title:     "AI Index 2026",
      publisher: "Stanford HAI",
      evidenceExcerpt: "Generative AI US adoption reached 54.6% within three years; PC adoption was 19.7% at the same mark.",
    }];
    const repair = repairCitationLocality(draft, sources);
    assert.ok(repair.citationsAdded >= 1);
    assert.equal(repair.fabricatedUrls, 0);

    const after = countBareExternalFactSentences(repair.draft);
    assert.ok(after < before, `expected bare-count to drop from ${before}, got ${after}`);
  });

  // 3. Pure analytical / opinion sentence does not require a citation.
  it("leaves analytical/opinion sentences without an external factual claim alone", () => {
    const draft = `What I think is happening is simpler than the framing suggests.

The illusion of control was always going to crack first.`;

    // Neither sentence carries a hard factual signal.
    for (const para of draft.split(/\n\s*\n/)) {
      assert.equal(isLaneBFactSentence(para), false, `analytical sentence should not classify as Lane B fact: "${para}"`);
    }

    const repair = repairCitationLocality(draft, [{
      url:   "https://example.com/unrelated",
      title: "Unrelated Source",
    }]);
    assert.equal(repair.citationsAdded, 0, "no citations should be added to analytical sentences");
    assert.equal(repair.sentencesHedged, 0, "no hedging should occur for analytical sentences");
    assert.equal(repair.draft, draft, "draft should be unchanged");
  });

  // 4. Repair never invents a URL.
  it("never introduces a fabricated URL — falls back to verbal hedge", () => {
    const draft = `On June 14, 2026, the FDA approved a new therapy.

This is a major moment.`;

    // Source pool intentionally has nothing relevant to the FDA claim.
    const sources: SourceObject[] = [{
      url:       "https://example.com/totally-unrelated-cooking-blog",
      title:     "Sourdough Tips",
      publisher: "Bread Weekly",
      evidenceExcerpt: "How to keep your starter alive over the winter.",
    }];

    const repair = repairCitationLocality(draft, sources);
    assert.equal(repair.fabricatedUrls, 0);

    const inputUrls = urlsIn(JSON.stringify(sources));
    const outputUrls = urlsIn(repair.draft);
    for (const u of outputUrls) {
      assert.ok(inputUrls.has(u), `repair output contains URL "${u}" that was not in the source pool`);
    }

    // Without a relevant source, the FDA sentence must be hedged, not cited.
    assert.ok(
      repair.sentencesHedged >= 1,
      `expected the bare FDA sentence to be hedged when no relevant source exists, got hedged=${repair.sentencesHedged}`,
    );
    assert.match(repair.draft, /broadly,|as widely reported|publicly reported|industry reporting/i);
  });

  // 5. Source objects survive end-to-end.
  it("source objects survive into the writer prompt block and verifier evidence telemetry", () => {
    const sources: SourceObject[] = [
      {
        url:       "https://openai.com/index/our-principles/",
        title:     "Our Principles",
        publisher: "OpenAI",
        retrievedAt: "2026-04-26T15:00:00Z",
        sourceId:  "kb_principles_2026",
        evidenceExcerpt: "OpenAI's stated principles, including safety as one priority among several.",
      },
      {
        url:       "https://hai.stanford.edu/ai-index-2026",
        title:     "AI Index 2026",
        publisher: "Stanford HAI",
        evidenceExcerpt: "AI adoption metrics, 2026 edition.",
      },
    ];

    // Writer prompt block carries every URL.
    const promptBlock = buildSourcesPromptBlock(sources);
    for (const s of sources) {
      assert.ok(promptBlock.includes(s.url), `prompt block missing URL ${s.url}`);
    }
    assert.match(promptBlock, /SAME sentence/i, "prompt block should instruct same-sentence locality");

    // Telemetry against an arbitrary draft + sourceText reflects the pool size.
    const draft = "OpenAI published guidance. [OpenAI](https://openai.com/index/our-principles/)";
    const sourceText = "OpenAI's principles statement, April 2026.";
    const telemetry = computeSourceTelemetry({
      draft,
      sources,
      sourceText,
      citationRepairApplied: 0,
    });
    assert.equal(telemetry.sourceObjectsCount, 2);
    assert.equal(telemetry.sourceUrlsCount, 2);
    assert.ok(telemetry.evidenceBundleBytes > 0, "evidence bundle bytes should be > 0");
    assert.ok(telemetry.citedSentencesCount >= 1, "cited-sentence count should reflect inline link");

    // pickSourceForSentence wires title/excerpt into the relevance score.
    const picked = pickSourceForSentence(
      "Generative AI adoption hit 54.6% in three years.",
      sources,
    );
    assert.ok(picked, "pickSourceForSentence should pick the AI Index source for an adoption-rate claim");
    assert.equal(picked!.publisher, "Stanford HAI");

    // Sources extracted from raw text feed back into the same pool.
    const harvested = extractSourceObjects(
      "See the [report](https://hai.stanford.edu/ai-index-2026) and https://openai.com/index/our-principles/.",
    );
    const urls = new Set(harvested.map(s => s.url));
    assert.ok(urls.has("https://hai.stanford.edu/ai-index-2026"));
    assert.ok(urls.has("https://openai.com/index/our-principles/"));
  });
});
