/**
 * PR-K — Critique-by-absence end-to-end verifier tests.
 *
 * Spec: pr_k_spec.md.
 *
 * In ANALYSIS mode, sentences pointing out what the source OMITS or
 * FAILS to address are exempted from Lane A claim verification because
 * they are meta-claims about the source's coverage, not content claims.
 *
 * The new sub-status `LANE_A_PASS_CRITIQUE_BY_ABSENCE` surfaces in
 * verifierReport.summary (counter `laneAPassCritiqueByAbsence`) so the
 * dashboard never silently masks failures as passes.
 *
 * Hard rules:
 *   - REPORT / MANUSCRIPT / default mode behavior is unchanged.
 *   - Quoted-span fabrications still flag (PR-J path wins).
 *   - Sentences with attribution verbs ("Source X reports that …") route
 *     to Lane A as attributed claims (not auto-exempted).
 *   - Content claims with non-discussion negation verbs ("does not work",
 *     "does not improve", "does not exist", "does not function") still
 *     flag as before.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.critiqueByAbsence.test.ts
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

const SOURCE_URL = "https://openai.com/index/our-principles/";
const SOURCE_TITLE = "Our Principles";
const SOURCE_TEXT = [
  "We believe in safe and beneficial AGI.",
  "Concentrated power is a misplaced worry, not the central risk.",
  "We support new economic models for a world transformed by AI.",
  "No AI lab can ensure a good future alone.",
  "GPT-2 was released in stages because of capability concerns.",
  "Costs per token have fallen by an order of magnitude in two years.",
].join("\n\n");

type Mode = "ANALYSIS" | "REPORT" | "MANUSCRIPT" | undefined;

async function runVerifier(draftText: string, artifactMode: Mode) {
  return verifyClaims({
    draftText,
    sourceText: SOURCE_TEXT,
    sourceUrl: SOURCE_URL,
    sourceTitle: SOURCE_TITLE,
    skipLLM: true,
    ...(artifactMode ? { artifactMode } : {}),
  });
}

function entryFor(verdict: any, snippet: string) {
  return verdict.verifierReport.entries.find((e: any) => e.snippet.includes(snippet));
}

const FAIL_CLASSIFICATIONS = new Set([
  "LANE_A_FAIL",
  "LANE_B_BARE",
  "NCITE_PATTERN_HIT",
  "RETRACTED_HIT",
]);

// ── True positives — should now PASS via LANE_A_PASS_CRITIQUE_BY_ABSENCE ──

describe("PR-K — true positives (ANALYSIS critique-by-absence should pass)", () => {
  it("S62 — 'The article does not specify how alignment will be measured.' — passes via LANE_A_PASS_CRITIQUE_BY_ABSENCE", async () => {
    const draft =
      "The article does not specify how alignment will be measured.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "does not specify");
    assert.ok(e, "entry should exist");
    assert.equal(
      e.classification,
      "LANE_A_PASS_CRITIQUE_BY_ABSENCE",
      `expected LANE_A_PASS_CRITIQUE_BY_ABSENCE, got ${e.classification}: ${e.reason}`,
    );
    assert.equal(v.severity, "PASS");
    assert.equal(v.verifierReport.summary.laneAPassCritiqueByAbsence, 1);
  });

  it("S64 — 'It does not address the question of accountability.' — passes", async () => {
    // Conservative "It " opener with discussion verb — exempt.
    const draft =
      "It does not address the question of accountability.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "does not address");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
    assert.equal(v.severity, "PASS");
  });

  it("'The piece never names the labs it considers comparable.' — passes", async () => {
    const draft =
      "The piece never names the labs it considers comparable.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "never names");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
  });

  it("'The source fails to define what \"serious alignment\" means in practice.' — passes", async () => {
    // Use simple non-fabricated quoted span replacement to avoid PR-J carve-out.
    const draft =
      "The source fails to define serious alignment in practice.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "fails to define");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
  });
});

// ── True negatives — content claims with non-discussion verbs MUST still fail ──

describe("PR-K — true negatives (content claims must still flag as before)", () => {
  it("'The medication does not work for chronic pain patients.' — must NOT be exempted", async () => {
    // Critical regression test: "work" is NOT a discussion verb. The
    // sentence is a content claim. Confirm it does NOT receive the new
    // critique-by-absence exemption (whether or not it's classified as
    // Lane A/B is unrelated — the only requirement is no exemption
    // and zero contribution to the new counter).
    const draft =
      "The medication does not work for chronic pain patients.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "medication does not work");
    if (e) {
      assert.notEqual(
        e.classification,
        "LANE_A_PASS_CRITIQUE_BY_ABSENCE",
        "content claim must NOT receive critique-by-absence exemption",
      );
    }
    assert.equal(
      v.verifierReport.summary.laneAPassCritiqueByAbsence ?? 0,
      0,
      "non-discussion verb must not contribute to laneAPassCritiqueByAbsence",
    );
  });

  it("'The model does not improve on prior baselines.' — must NOT be exempted", async () => {
    const draft =
      "The model does not improve on prior baselines.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "does not improve");
    if (e) {
      assert.notEqual(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
    }
  });

  it("'It does not exist in the wild.' — 'exist' not a discussion verb, must NOT be exempted", async () => {
    const draft = "It does not exist in the wild.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "does not exist");
    if (e) {
      assert.notEqual(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
    }
  });

  it("'GPT-4 does not function in low-resource languages.' — subject not source-referent + 'function' not a discussion verb", async () => {
    const draft =
      "GPT-4 does not function in low-resource languages.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "GPT-4 does not function");
    if (e) {
      assert.notEqual(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
    }
  });
});

// ── Carve-outs — defer to PR-J / Lane A ───────────────────────────────────

describe("PR-K — carve-outs (preserve PR-J + Lane A)", () => {
  it("Critique-by-absence pattern AND fabricated quoted span — PR-J path wins (LANE_A_FAIL)", async () => {
    // The fabricated quote must fail via section 1's verbatim-quote check.
    const draft =
      `The article does not specify "the seven specific safety pillars" in any meaningful detail.`;
    const v = await runVerifier(draft, "ANALYSIS");
    // The fabricated-quote sentence should be marked LANE_A_FAIL.
    const allEntries = v.verifierReport.entries;
    const failEntry = allEntries.find(
      (e: any) =>
        e.classification === "LANE_A_FAIL" &&
        e.snippet.includes("seven specific safety pillars"),
    );
    assert.ok(
      failEntry,
      `expected LANE_A_FAIL for fabricated quote; entries: ${JSON.stringify(
        allEntries.map((x: any) => ({ c: x.classification, s: x.snippet })),
      )}`,
    );
  });

  it("Attribution verb + critique-by-absence — defers to Lane A (no auto-exemption)", async () => {
    // "Source X reports that the article does not specify Y" — the
    // attribution verb "reports" makes this an attributed claim, not pure
    // critique-by-absence. Should NOT receive the critique-by-absence pass.
    const draft =
      "Politico reports that the article does not specify how alignment will be measured.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "Politico reports that");
    if (e) {
      assert.notEqual(
        e.classification,
        "LANE_A_PASS_CRITIQUE_BY_ABSENCE",
        "attribution verb should defer to Lane A path",
      );
    }
  });
});

// ── Mode preservation ──────────────────────────────────────────────────────

describe("PR-K — mode preservation (REPORT / MANUSCRIPT / default unchanged)", () => {
  it("REPORT mode — critique-by-absence sentence is NOT exempted", async () => {
    const draft =
      "The article does not specify how alignment will be measured.";
    const v = await runVerifier(draft, "REPORT");
    const e = entryFor(v, "does not specify");
    if (e) {
      assert.notEqual(
        e.classification,
        "LANE_A_PASS_CRITIQUE_BY_ABSENCE",
        "REPORT mode must NOT emit critique-by-absence exemption",
      );
    }
    // The summary counter must be 0 outside ANALYSIS mode.
    assert.equal(
      v.verifierReport.summary.laneAPassCritiqueByAbsence ?? 0,
      0,
      "REPORT mode laneAPassCritiqueByAbsence must be 0",
    );
  });

  it("MANUSCRIPT mode — critique-by-absence sentence is NOT exempted", async () => {
    const draft =
      "The article does not specify how alignment will be measured.";
    const v = await runVerifier(draft, "MANUSCRIPT");
    const e = entryFor(v, "does not specify");
    if (e) {
      assert.notEqual(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
    }
    assert.equal(
      v.verifierReport.summary.laneAPassCritiqueByAbsence ?? 0,
      0,
    );
  });

  it("Default mode (unset) — critique-by-absence sentence is NOT exempted", async () => {
    const draft =
      "The article does not specify how alignment will be measured.";
    const v = await runVerifier(draft, undefined);
    const e = entryFor(v, "does not specify");
    if (e) {
      assert.notEqual(e.classification, "LANE_A_PASS_CRITIQUE_BY_ABSENCE");
    }
    assert.equal(
      v.verifierReport.summary.laneAPassCritiqueByAbsence ?? 0,
      0,
    );
  });
});

// ── Pre-existing pattern preservation (smoke tests) ────────────────────────

describe("PR-K — pre-existing pattern smoke tests", () => {
  it("PR-I author-voice (forward projection 'by 2030') still passes", async () => {
    const draft = "By 2030 the trajectory is clear, even if the article does not say so.";
    const v = await runVerifier(draft, "ANALYSIS");
    // The sentence has both a forward-projection marker AND the critique-
    // by-absence shape ("the article does not say"). Either path may
    // claim the exemption first — both are valid in ANALYSIS. Just
    // confirm severity is PASS (no LANE_A_FAIL).
    const failed = v.verifierReport.entries.some((e: any) =>
      FAIL_CLASSIFICATIONS.has(e.classification) && e.snippet.includes("by 2030"),
    );
    assert.equal(failed, false);
  });

  it("PR-I.1 closing rhetoric ('sound good on openai.com') still passes", async () => {
    const draft = "These principles sound good on openai.com but lack teeth.";
    const v = await runVerifier(draft, "ANALYSIS");
    const e = v.verifierReport.entries.find((x: any) =>
      x.snippet.includes("sound good on openai.com"),
    );
    if (e) {
      assert.ok(!FAIL_CLASSIFICATIONS.has(e.classification));
    }
  });

  it("PR-J quote+commentary still passes", async () => {
    const draft = `The principles call out "safe and beneficial AGI" — Agent 306 reads this as a deliberate hedge.`;
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "safe and beneficial AGI");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY");
  });

  it("PR-I source-referent prefix ('The piece opens with…') still passes", async () => {
    const draft = `The piece opens with a deceptively simple frame about AGI.`;
    const v = await runVerifier(draft, "ANALYSIS");
    const e = v.verifierReport.entries.find((x: any) =>
      x.snippet.includes("piece opens"),
    );
    if (e) {
      assert.ok(!FAIL_CLASSIFICATIONS.has(e.classification));
    }
  });
});
