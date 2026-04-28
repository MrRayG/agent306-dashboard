/**
 * PR-J — Quote-plus-commentary recognition (ANALYSIS mode only).
 *
 * Spec: pr_j_spec.md.
 *
 * In ANALYSIS mode, sentences that combine a verbatim quote from the source
 * with the agent's gloss/commentary should pass when the quote(s) verify
 * — the surrounding gloss is treated as author voice. In REPORT,
 * MANUSCRIPT, and default (unset) modes the behavior is unchanged.
 *
 * Hard rules:
 *   - A fabricated quote MUST still flag (any unverifiable quoted span
 *     fails the sentence — LANE_A_FAIL preserved).
 *   - A no-quote unsupported claim MUST still flag (existing behavior
 *     preserved).
 *   - REPORT / MANUSCRIPT / default behavior MUST NOT change.
 *
 * The new sub-status `LANE_A_PASS_QUOTED_COMMENTARY` surfaces in
 * verifierReport so the dashboard shows "passed via quoted-span
 * verification" — never silently mask failures as passes.
 *
 * Run: npx tsx --test server/__tests__/claimVerifier.quotedCommentary.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Hermetic — the quote check is deterministic, so skipLLM:true is fine.
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

// ── True positives — quote+commentary should now pass in ANALYSIS ──────────

describe("PR-J — true positives (ANALYSIS quote+commentary should pass)", () => {
  it("1. ASCII double-quoted span matching source verbatim — passes via LANE_A_PASS_QUOTED_COMMENTARY", async () => {
    // Sentence shape from spec sentence 7 / 68 / 79: quote + agent gloss
    const draft = [
      `The principles call out "safe and beneficial AGI" — Agent 306 reads this as a deliberate hedge.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "safe and beneficial AGI");
    assert.ok(e, "entry should exist for the quote+commentary sentence");
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY",
      `expected LANE_A_PASS_QUOTED_COMMENTARY, got ${e.classification}: ${e.reason}`);
    assert.equal(v.severity, "PASS", `expected PASS severity, got ${v.severity}`);
  });

  it("2. Curly double-quoted span matching source verbatim — passes", async () => {
    const draft = [
      `The principles call out “safe and beneficial AGI” — Agent 306 reads this as a deliberate hedge.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "safe and beneficial AGI");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY");
  });

  it("3. ASCII single-quoted ≥ 4-word span matching source — passes", async () => {
    const draft = [
      `The piece frames it as 'a misplaced worry' but Agent 306 disagrees with that framing.`,
    ].join("\n\n");
    // 'a misplaced worry' is only 3 words → won't be picked up. Use a 4+ word span.
    const draft4 = [
      `The piece frames it as 'concentrated power is a misplaced worry' but Agent 306 disagrees with that framing.`,
    ].join("\n\n");
    const v = await runVerifier(draft4, "ANALYSIS");
    const e = entryFor(v, "concentrated power is a misplaced worry");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY",
      `expected pass via single-quoted ≥4-word span; got ${e.classification}`);
  });

  it("4. Two quoted spans in one sentence both matching source — passes", async () => {
    const draft = [
      `The post pairs "safe and beneficial AGI" with "new economic models" as twin commitments — Agent 306 reads both as hedges.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "safe and beneficial AGI");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY",
      `both quoted spans match source; expected pass`);
  });

  it("5. Quote with curly typography / NBSP / U+2011 NBH — passes via PR-H normalization path", async () => {
    // Source has ASCII forms; draft uses curly quotes + NBSP between words
    // The PR-H normalizer should fold both sides for the contains check.
    const draft = [
      `The doc is explicit: “safe and beneficial AGI” — that's the agent's read of the deliberate framing.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "safe and");
    assert.ok(e, `entry should exist for quote+commentary sentence`);
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY",
      `expected pass after PR-H normalization; got ${e.classification}: ${e.reason}`);
  });
});

// ── True negatives — fabricated quotes / no-quote unsupported claims ──────

describe("PR-J — true negatives (genuine fabrications must still fail)", () => {
  it("6. ANALYSIS sentence with quoted span NOT in source — FAILS (LANE_A_FAIL preserved)", async () => {
    const draft = [
      `The principles allegedly say "AGI will be deployed by Tuesday" — Agent 306 finds this implausible.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const fabricated = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason)
    );
    assert.ok(fabricated, `expected LANE_A_FAIL for fabricated quote; entries: ${
      JSON.stringify(v.verifierReport.entries.map((e: any) => ({ c: e.classification, r: e.reason })))
    }`);
  });

  it("7. ANALYSIS sentence with one matching quote AND one fabricated quote — FAILS (must require ALL spans to verify)", async () => {
    const draft = [
      `The doc pairs "safe and beneficial AGI" with "an immediate moratorium on training" as the right path forward — Agent 306 reads both as deliberate.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const fabricated = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason)
    );
    assert.ok(fabricated, `expected LANE_A_FAIL when ANY quoted span is fabricated`);
    // Must NOT have been promoted to LANE_A_PASS_QUOTED_COMMENTARY
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY" &&
      e.snippet.includes("immediate moratorium")
    );
    assert.equal(passed, undefined,
      `must not pass when any quoted span fails source check`);
  });

  it("8. ANALYSIS sentence with NO quoted span and unsupported claim — existing behavior preserved", async () => {
    // No quoted spans → the new branch must not apply. The sentence below
    // is an unsupported attribution (mentions "the article" + a stat not in
    // source), so it should still flag through the existing path.
    const draft = [
      `The article reports a 47% drop in compute costs over the past year — that's the headline finding.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const failed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL"
    );
    assert.ok(failed, `expected LANE_A_FAIL for an unsupported attribution sentence with no quoted span`);
    // Must not have been silently promoted
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined, `no quoted spans → new branch must not apply`);
  });
});

// ── Mode preservation — REPORT, MANUSCRIPT, default unchanged ──────────────

describe("PR-J — mode preservation (REPORT / MANUSCRIPT / default unchanged)", () => {
  const QUOTE_DRAFT = [
    `The principles call out "safe and beneficial AGI" — Agent 306 reads this as a deliberate hedge.`,
  ].join("\n\n");

  it("9. REPORT — quote+commentary does NOT use the new branch", async () => {
    const v = await runVerifier(QUOTE_DRAFT, "REPORT");
    // The new sub-status must NOT appear under REPORT.
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined, `REPORT mode must not produce LANE_A_PASS_QUOTED_COMMENTARY`);
  });

  it("10. MANUSCRIPT — quote+commentary does NOT use the new branch", async () => {
    const v = await runVerifier(QUOTE_DRAFT, "MANUSCRIPT");
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined, `MANUSCRIPT mode must not produce LANE_A_PASS_QUOTED_COMMENTARY`);
  });

  it("11. Default (unset) — same behavior as main; new sub-status must not appear", async () => {
    const v = await runVerifier(QUOTE_DRAFT, undefined);
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined,
      `default mode must match main behavior — new sub-status must not appear`);
    // Also confirm artifactMode resolves to REPORT (the documented default).
    assert.equal(v.verifierReport.artifactMode, "REPORT");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("PR-J — edge cases (possessives, contractions, short spans)", () => {
  it("12. Possessive 's — NOT treated as a quoted span", async () => {
    // Sentence has Agent 306's (possessive) and a real fabricated claim.
    // The possessive must not fool the new branch into passing.
    const draft = [
      `Agent 306's read of the article is that compute will shrink 50x by next year.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    // Should NOT be marked LANE_A_PASS_QUOTED_COMMENTARY (no quoted span).
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined, `possessive 's must not trigger the new branch`);
  });

  it("13. Contraction don't / doesn't — NOT treated as quoted span", async () => {
    const draft = [
      `Altman doesn't say compute will shrink 100x by 2027 in the article — that's an Agent 306 projection.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined, `contraction must not trigger the new branch`);
  });

  it("14. 1-3 word single-quoted span — NOT treated (avoid false matches)", async () => {
    const draft = [
      `Altman calls AGI 'safe AGI' in the article and that's the agent's read.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const passed = v.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_PASS_QUOTED_COMMENTARY"
    );
    assert.equal(passed, undefined, `≤3-word single-quoted span must not trigger the new branch`);
  });

  it("15. 1-3 word DOUBLE-quoted span — IS treated (double quotes are unambiguous)", async () => {
    // Source contains "new economic models" verbatim.
    const draft = [
      `Altman calls them "new economic models" and Agent 306 reads that framing as deliberately broad.`,
    ].join("\n\n");
    const v = await runVerifier(draft, "ANALYSIS");
    const e = entryFor(v, "new economic models");
    assert.ok(e);
    assert.equal(e.classification, "LANE_A_PASS_QUOTED_COMMENTARY",
      `short double-quoted span must trigger the new branch`);
  });
});
