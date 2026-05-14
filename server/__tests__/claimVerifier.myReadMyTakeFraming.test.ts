/**
 * Regression: `My read` / `My take` first-person analysis framing must route
 * OUT of Lane A hard-fail source-attribution.
 *
 * 2026-05-14 ClaimVerifier rejection (live log):
 *
 *   LANE_A_FAIL
 *   - My read — this is agent analysis, not a source claim — is that the
 *     WhatsApp integration may be genuinely useful for businesses with
 *     multilingual customer bases, and that it becomes …
 *     reason: source text does not contain Agent 306 framing / not in source
 *
 * The sentence is explicitly framed as the agent's first-person reading
 * with a boundary phrase (`—`) — it is the agent's voice, not a claim
 * attributed to the source. The verifier should not hard-fail it for a
 * missing source mention.
 *
 * PR-B extends `AGENT_306_FRAMING_PREFIXES` to include `my read` /
 * `my take`. The same boundary-phrase abuse guard
 * (`embeddedFactualClaimRequiresSourcing`) applies, so numeric markers,
 * named-authority phrases, embedded attribution verbs, and quoted-span
 * fabrication detection continue to flag.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.myReadMyTakeFraming.test.ts
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

// A blog-shaped source about WhatsApp / multilingual customer support —
// purposefully does NOT contain the agent's reading or projection.
const SOURCE_URL = "https://example.com/whatsapp-business-multilingual";
const SOURCE_TITLE = "WhatsApp Adds A Translation Toggle For Business Inboxes";
const SOURCE_TEXT = [
  "WhatsApp this week added an in-thread translation toggle for business",
  "inboxes, letting merchants reply in their own language while customers",
  "see translated replies in theirs.",
  "",
  "The rollout starts in Latin America and Southeast Asia. Meta did not",
  "publish accuracy numbers for the translation layer.",
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

// Exact live-log sentence shape (em-dash parenthetical inside the framing).
const LIVE_LOG_SENTENCE =
  "My read — this is agent analysis, not a source claim — is that the " +
  "WhatsApp integration may be genuinely useful for businesses with " +
  "multilingual customer bases, and that it becomes more so as the model " +
  "tier improves.";

// ── Predicate-level tests ────────────────────────────────────────────────

describe("hasExplicitAgent306AnalysisFraming — `My read` / `My take` recognition", () => {
  it("matches the live-log `My read —` framed sentence", () => {
    assert.equal(hasExplicitAgent306AnalysisFraming(LIVE_LOG_SENTENCE), true);
  });

  it("matches a plain `My read:` colon-framed sentence", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "My read: the integration is more useful for multilingual businesses.",
      ),
      true,
    );
  });

  it("matches a plain `My take:` colon-framed sentence", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "My take: the integration is more useful for multilingual businesses.",
      ),
      true,
    );
  });

  it("matches `My take —` em-dash-framed sentence", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "My take — this is not a source claim — is that the rollout will slip.",
      ),
      true,
    );
  });

  it("matches with bolded `**My read:**` markdown emphasis", () => {
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "**My read:** the integration is useful for multilingual flows.",
      ),
      true,
    );
  });

  it("does NOT match `My read is that …` — no boundary punctuation", () => {
    // Without an explicit framing punct (`:` / `—` / `–` / `-`), the
    // sentence reads as a regular declarative. The writer must commit
    // to the framing form to get the exemption.
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "My read is that the integration is more useful for multilingual flows.",
      ),
      false,
    );
  });

  it("does NOT match a mid-sentence `my read` mention", () => {
    // Boundary-phrase abuse guard: only the LEADING label exempts.
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "Politico reports that, in my read of the FTC docket, the rollout will slip.",
      ),
      false,
    );
  });

  it("does NOT match `My reading of the …` — `read` substring without exact prefix", () => {
    // "my reading" does not start with "my read" followed by boundary
    // punctuation; the predicate must be exact.
    assert.equal(
      hasExplicitAgent306AnalysisFraming(
        "My reading of the rollout: it favors multilingual merchants.",
      ),
      false,
    );
  });
});

// ── Boundary-phrase abuse — embedded factual claims still require sourcing ──

describe("embeddedFactualClaimRequiresSourcing — abuse guard under `My read` / `My take`", () => {
  it("a `My read` framed sentence with no factual claim does not require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(LIVE_LOG_SENTENCE),
      false,
    );
  });

  it("`My read:` with a percentage DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "My read: the integration ships in 47% of regions this quarter.",
      ),
      true,
    );
  });

  it("`My take:` with a 4-digit year DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "My take: by 2024 every Meta surface had inbox translation.",
      ),
      true,
    );
  });

  it("`My read:` with a named-authority `study by …` DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "My read: a study by the Pew Research Center found Spanish was the top non-English inbox language.",
      ),
      true,
    );
  });

  it("`My take:` with an embedded `Politico reports` attribution DOES require sourcing", () => {
    assert.equal(
      embeddedFactualClaimRequiresSourcing(
        "My take: Politico reports that the FTC will move on multilingual ad disclosure next quarter.",
      ),
      true,
    );
  });
});

// ── End-to-end verifier tests — REPORT / blog tier (the regression flow) ──

describe("`My read` / `My take` framing — REPORT mode (blog publish flow)", () => {
  it("the live-log sentence does NOT hard-fail as Lane A source-attribution", async () => {
    const v = await runVerifier(LIVE_LOG_SENTENCE, undefined, "blog");
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("My read"),
    );
    assert.notEqual(
      e?.classification,
      "LANE_A_FAIL",
      "framed `My read` sentence must not classify as LANE_A_FAIL",
    );
    if (e) {
      assert.equal(
        FAIL_CLASSIFICATIONS.has(e.classification),
        false,
        `framed sentence should not be in a fail bucket (got ${e.classification})`,
      );
    }
  });

  it("a plain `My take:` sentence does NOT hard-fail as Lane A source-attribution", async () => {
    const draft =
      "My take: the WhatsApp translation toggle is more useful for businesses with multilingual customer bases.";
    const v = await runVerifier(draft, undefined, "blog");
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("My take"),
    );
    assert.notEqual(
      e?.classification,
      "LANE_A_FAIL",
      "framed `My take` sentence must not classify as LANE_A_FAIL",
    );
  });

  it("the verdict severity for the framed sentence alone is not HARD_FAIL", async () => {
    const v = await runVerifier(LIVE_LOG_SENTENCE, undefined, "blog");
    assert.notEqual(v.severity, "HARD_FAIL");
  });

  it("the authorVoice exemption counter ticks up for the framed sentence", async () => {
    const v = await runVerifier(LIVE_LOG_SENTENCE, undefined, "blog");
    assert.ok(
      (v.verifierReport.modeExemptions?.authorVoice ?? 0) >= 1,
      "authorVoice counter should reflect the explicit-framing exemption",
    );
  });
});

describe("`My read` / `My take` framing — ANALYSIS mode parity", () => {
  it("the live-log sentence also does not hard-fail in ANALYSIS mode", async () => {
    const v = await runVerifier(LIVE_LOG_SENTENCE, "ANALYSIS");
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("My read"),
    );
    assert.notEqual(e?.classification, "LANE_A_FAIL");
  });
});

// ── Boundary-phrase abuse — factual overreach is still blocked end-to-end ──

describe("`My read` / `My take` framing — embedded factual claims still flag", () => {
  it("a `My read:` sentence with a bare numeric fact still flags LANE_B_BARE", async () => {
    const draft =
      "My read: WhatsApp's translation toggle is now live in 47% of regions, " +
      "which is faster than any prior Meta language rollout.";
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

  it("a `My take:` sentence with a fabricated quoted span still flags LANE_A_FAIL", async () => {
    // Quote-fabrication detection runs in all modes — the framing
    // exemption must not silence it.
    const draft =
      'My take: the source says "the rollout will reach 90% of Latin America by July" — that is the central point.';
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

  it("a `My read:` sentence with `study by …` named-authority is not silently exempted", async () => {
    const draft =
      "My read: a study by Pew found Spanish was the top non-English inbox language across the region.";
    const v = await runVerifier(draft, undefined, "blog");
    const e = v.verifierReport.entries.find(en =>
      en.snippet.includes("study by Pew"),
    );
    if (e) {
      assert.notEqual(e.classification, "LANE_A_OK");
      assert.notEqual(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY");
    }
  });

  it("an unframed bare external fact in the same draft as a `My read` sentence still flags", async () => {
    const draft =
      LIVE_LOG_SENTENCE +
      "\n\n" +
      "WhatsApp business inboxes grew 47% last year across Latin America.";
    const v = await runVerifier(draft, undefined, "blog");
    const hasLaneBBare = v.verifierReport.entries.some(
      e =>
        e.classification === "LANE_B_BARE" &&
        e.snippet.includes("WhatsApp business inboxes grew"),
    );
    assert.equal(
      hasLaneBBare,
      true,
      "an unframed bare external fact should still flag LANE_B_BARE",
    );
  });
});
