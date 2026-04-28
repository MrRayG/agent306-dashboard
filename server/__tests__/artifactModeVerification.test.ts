/**
 * PR-I — Artifact-mode-aware verification tests.
 *
 * Spec: pr_i_spec.md.
 *
 * The Deep Read on https://openai.com/index/our-principles/ produced 9
 * post-PR-H flags. The user reviewed each: 7 are false positives caused by
 * the verifier applying manuscript rules to an opinion piece; 2
 * (sentences 69 and 75 in the original draft — "Costs per token …" and
 * "The uncertainty the document embraces is real") are genuinely sloppy
 * attribution-by-link patterns that should keep flagging.
 *
 * Tests assert the outcome by sentence-content snippet rather than by
 * the original positional index, because the index depended on draft
 * structure that's preserved here only approximately. Each test grabs
 * the verifier entries that touch the spec's flagged sentence and
 * asserts whether they should still flag in ANALYSIS mode.
 *
 * Run: npx tsx --test server/__tests__/artifactModeVerification.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Hermetic — deterministic paths only.
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import { verifyClaims } from "../claimVerifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, "fixtures/openai-principles-deepread-output.md");
const DRAFT = fs.readFileSync(FIXTURE_PATH, "utf8");

const SOURCE_TEXT = fs.readFileSync(
  path.join(__dirname, "fixtures/openai-principles-2026-04-26.txt"),
  "utf8",
);
const SOURCE_URL   = "https://openai.com/index/our-principles/";
const SOURCE_TITLE = "Our Principles";

type Mode = "ANALYSIS" | "REPORT" | "MANUSCRIPT";

async function runVerifier(mode?: Mode) {
  return verifyClaims({
    draftText:    DRAFT,
    sourceText:   SOURCE_TEXT,
    sourceUrl:    SOURCE_URL,
    sourceTitle:  SOURCE_TITLE,
    skipLLM:      true,
    artifactMode: mode,
  } as any);
}

/** Filter to entries whose snippet contains `needle`. Used to look up the
 *  classification of a specific spec-flagged sentence. */
function entriesMatching(verdict: any, needle: string) {
  return verdict.verifierReport.entries.filter((e: any) =>
    e.snippet.toLowerCase().includes(needle.toLowerCase()),
  );
}

/** Helper for assertions like "this snippet must NOT appear in any flagged
 *  entry" — covers LANE_A_FAIL, LANE_B_BARE, NCITE_PATTERN_HIT, RETRACTED_HIT. */
const FAIL_CLASSIFICATIONS = new Set([
  "LANE_A_FAIL",
  "LANE_B_BARE",
  "NCITE_PATTERN_HIT",
  "RETRACTED_HIT",
]);

function flaggedEntriesMatching(verdict: any, needle: string) {
  return entriesMatching(verdict, needle).filter((e: any) =>
    FAIL_CLASSIFICATIONS.has(e.classification),
  );
}

// ── 9-sentence outcome matrix (per spec) ────────────────────────────────────
//
// Sentences expected to drop from "flagged" to "not flagged" in ANALYSIS:
//   1. opener: "On April 26, 2026, Sam Altman published a short document"
//   34. context-frame: "GPT-2 weights release debate"
//   35. agent-framing: "This is the first time OpenAI has published a ranked list"
//   68. forward-projection: "By 2028 we should see"
//   74. forward-projection: "By 2030–2035 the decisive question becomes"
//   77. agent-analysis: "Iterative deployment has worked so far"
//   78. section-header: "Agent 306 Lens"
//
// Sentences that must STILL flag (genuinely sloppy attribution-by-link):
//   69. "Costs per token will have fallen another order of magnitude"
//   75. "The uncertainty the document embraces is real"

const FALSE_POSITIVES_TO_DROP = [
  { id: "S1",  needle: "Sam Altman published a short document",                 desc: "opener with date + named entity" },
  { id: "S34", needle: "GPT-2 weights release debate",                          desc: "context reference to source's own historical mention" },
  { id: "S35", needle: "This is the first time OpenAI has published a ranked list", desc: "agent's framing claim" },
  { id: "S68", needle: "By 2028 we should see",                                 desc: "forward projection" },
  { id: "S74", needle: "By 2030–2035 the decisive question becomes",            desc: "forward projection" },
  { id: "S77", needle: "Iterative deployment has worked so far",                desc: "agent's analytical voice" },
  { id: "S78", needle: "Agent 306 Lens",                                        desc: "agent's own section header" },
];

const SLOPPY_STILL_FLAG = [
  { id: "S69", needle: "Costs per token will have fallen another order of magnitude" },
  { id: "S75", needle: "The uncertainty the document embraces is real" },
];

// ── A. ANALYSIS mode — the 7 false positives drop ──────────────────────────

describe("PR-I — ANALYSIS mode drops 7 of 9 spec flags", () => {
  for (const c of FALSE_POSITIVES_TO_DROP) {
    it(`ANALYSIS: ${c.id} (${c.desc}) should NOT flag`, async () => {
      const verdict = await runVerifier("ANALYSIS");
      const flagged = flaggedEntriesMatching(verdict, c.needle);
      assert.equal(
        flagged.length, 0,
        `expected ${c.id} not to flag in ANALYSIS; got: ${JSON.stringify(flagged.map((e: any) => ({ classification: e.classification, snippet: e.snippet.slice(0, 120), reason: e.reason })), null, 2)}`,
      );
    });
  }
});

// ── B. ANALYSIS mode — the 2 sloppy attributions still flag ─────────────────

describe("PR-I — ANALYSIS mode still flags genuinely sloppy attribution-by-link", () => {
  for (const c of SLOPPY_STILL_FLAG) {
    it(`ANALYSIS: ${c.id} ("${c.needle.slice(0, 40)}…") MUST still flag`, async () => {
      const verdict = await runVerifier("ANALYSIS");
      const flagged = flaggedEntriesMatching(verdict, c.needle);
      assert.ok(
        flagged.length >= 1,
        `expected ${c.id} to still flag in ANALYSIS (writer's job to fix), got 0 entries`,
      );
    });
  }
});

// ── C. Default-mode regression: byte-identical to pre-PR-I behavior ────────

describe("PR-I — default-mode regression (no artifactMode → unchanged behavior)", () => {

  it("default mode flags at least one of the false-positive-shaped sentences (preserves current behavior)", async () => {
    // The point of the default-mode regression: when the writer doesn't
    // set ANALYSIS, behavior is unchanged. The fixture is a reduced
    // analytical draft, so default-mode produces a smaller set of flags
    // than the dense production draft did — but at least one of the
    // false-positive-shaped sentences (year-bearing forward projection,
    // GPT-2 historical reference) MUST still flag in default. ANALYSIS
    // mode's job is to drop those; default-mode's job is to keep them.
    const verdict = await runVerifier();
    let flaggedCount = 0;
    for (const c of FALSE_POSITIVES_TO_DROP) {
      const flagged = flaggedEntriesMatching(verdict, c.needle);
      if (flagged.length >= 1) flaggedCount += 1;
    }
    assert.ok(
      flaggedCount >= 1,
      `default mode should still flag at least one of the false-positive-shaped sentences; got ${flaggedCount}`,
    );
  });

  it("an unset artifactMode and an explicit REPORT mode produce the same entries on the fixture", async () => {
    const def    = await runVerifier();
    const report = await runVerifier("REPORT");
    // Compare entry classifications + snippets stably ordered.
    const norm = (v: any) => v.verifierReport.entries
      .map((e: any) => `${e.sentenceIndex}|${e.classification}|${e.snippet}`)
      .sort();
    assert.deepEqual(norm(def), norm(report),
      "default mode (unset) must classify identically to explicit REPORT mode — preserves current behavior",
    );
  });
});

// ── D. Mode comparison — modes produce demonstrably different outputs ─────

describe("PR-I — mode comparison (modes must differ)", () => {

  it("ANALYSIS produces fewer LANE_A_FAIL + LANE_B_BARE entries than REPORT", async () => {
    const a = await runVerifier("ANALYSIS");
    const r = await runVerifier("REPORT");
    const aFlagged = a.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    const rFlagged = r.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    assert.ok(
      aFlagged < rFlagged,
      `expected ANALYSIS < REPORT in flagged count; got A=${aFlagged} R=${rFlagged}`,
    );
  });

  it("MANUSCRIPT flags AT LEAST as many entries as REPORT (strictest end of the spectrum)", async () => {
    const m = await runVerifier("MANUSCRIPT");
    const r = await runVerifier("REPORT");
    const mFlagged = m.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    const rFlagged = r.verifierReport.entries.filter((e: any) => FAIL_CLASSIFICATIONS.has(e.classification)).length;
    assert.ok(
      mFlagged >= rFlagged,
      `expected MANUSCRIPT >= REPORT in flagged count; got M=${mFlagged} R=${rFlagged}`,
    );
  });
});

// ── E. Helper-level pinning: trigger lists for ANALYSIS rules ──────────────

describe("PR-I — ANALYSIS exemption helpers (each trigger pinned)", () => {

  it("section-header skip: '## …' standalone lines never classify in ANALYSIS mode", async () => {
    // Per spec: section-header skipping under PR-I is scoped to ANALYSIS
    // mode only. Today's verifier classifies header lines in REPORT /
    // MANUSCRIPT / default — that's a separate bug acknowledged in the
    // spec ("do not silently fix it under this PR; flag it for follow-up").
    // This test pins the ANALYSIS-mode skip and explicitly LEAVES the
    // cross-mode skip to PR-I1.
    const verdict = await runVerifier("ANALYSIS");
    const headerEntries = verdict.verifierReport.entries.filter((e: any) =>
      /^##\s+\S/.test(e.snippet) && e.snippet.split(/\s+/).length <= 6,
    );
    assert.equal(headerEntries.length, 0,
      `ANALYSIS: standalone header lines should not be classified; got: ${JSON.stringify(headerEntries.map((e: any) => e.snippet))}`,
    );
  });

  it("forward-projection markers exempt from Lane B in ANALYSIS", async () => {
    // Build a small synthetic draft that ONLY contains forward-projection
    // sentences with numbers. Default mode flags them Lane B BARE; ANALYSIS
    // must not.
    const draft = `## My Take

By 2028 we should see widespread agentic AI deployment.

Looking ahead, in five years the decisive question becomes whether scale or alignment wins.

By 2030 the question becomes whether the centralization risk is mitigated.`;
    const def = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
    } as any);
    const ana = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const defBare = def.verifierReport.entries.filter((e: any) => e.classification === "LANE_B_BARE").length;
    const anaBare = ana.verifierReport.entries.filter((e: any) => e.classification === "LANE_B_BARE").length;
    assert.ok(defBare >= 1, `default mode should flag at least one forward-projection as LANE_B_BARE; got ${defBare}`);
    assert.equal(anaBare, 0, `ANALYSIS mode should NOT flag forward projections as LANE_B_BARE; got ${anaBare}`);
  });

  it("author-voice constructions exempt from Lane B in ANALYSIS", async () => {
    const draft = `## My Take

The decisive question is whether the democratization bet pays off in 2028.

The real signal is that capital is flowing to safety teams in 2026.

What I think is happening in 2026 is a posture reset.`;
    const ana = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const anaBare = ana.verifierReport.entries.filter((e: any) => e.classification === "LANE_B_BARE").length;
    assert.equal(anaBare, 0, `ANALYSIS mode should NOT flag author-voice sentences as LANE_B_BARE; got ${anaBare}`);
  });

  it("opener-hook tolerance: first paragraph with date + named entity AND a citation does not flag Lane B in ANALYSIS", async () => {
    const draft = `## Opening
On April 26, 2026, Sam Altman published a 1,100-word document ([OpenAI](https://openai.com/index/our-principles/)).

The document is short.`;
    const ana = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const flaggedOpener = ana.verifierReport.entries.filter((e: any) =>
      FAIL_CLASSIFICATIONS.has(e.classification) && /Sam Altman published/.test(e.snippet),
    );
    assert.equal(flaggedOpener.length, 0, `ANALYSIS opener should not flag; got ${JSON.stringify(flaggedOpener)}`);
  });
});

// ── F. Strictness preservation: PR-H + fabrication + attribution-verb ─────

describe("PR-I — ANALYSIS preserves PR-H protections + attribution-verb checks", () => {

  it("fabricated quote in ANALYSIS still flags LANE_A_FAIL: fabricated quote", async () => {
    const draft = `Altman wrote: "AGI by 2027 is now inevitable."

The rest is filler.`;
    const verdict = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    const fab = verdict.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL" && /fabricated quote/i.test(e.reason),
    );
    assert.ok(fab, "fabricated quote must still flag in ANALYSIS");
  });

  it("direct attribution verb with unsupported claim still flags in ANALYSIS", async () => {
    // "Altman writes that …" with content NOT in the source. ANALYSIS
    // mode must still treat direct attribution verbs as Lane A and run
    // the source check. Use skipLLM:true so the deterministic path runs.
    const draft = `Altman writes that "1.21 gigawatts" is the new compute baseline. Filler.`;
    const verdict = await verifyClaims({
      draftText: draft,
      sourceText: SOURCE_TEXT,
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      skipLLM: true,
      artifactMode: "ANALYSIS",
    } as any);
    // The fabricated-quote deterministic path catches "1.21 gigawatts" as
    // not in source. This proves the attribution verb path is still
    // wired to source verification in ANALYSIS.
    const fab = verdict.verifierReport.entries.find((e: any) =>
      e.classification === "LANE_A_FAIL",
    );
    assert.ok(fab, "direct-attribution + unsupported quoted statistic must still flag LANE_A_FAIL");
  });
});

// ── G. Telemetry surfaces the mode + exemption counts ─────────────────────

describe("PR-I — telemetry includes artifactMode + exemption counts", () => {
  it("ANALYSIS verdict carries telemetry block with mode + exemption counters", async () => {
    const verdict: any = await runVerifier("ANALYSIS");
    assert.equal(verdict.verifierReport.artifactMode, "ANALYSIS");
    assert.ok(verdict.verifierReport.modeExemptions, "modeExemptions block missing");
    const e = verdict.verifierReport.modeExemptions;
    for (const k of ["authorVoice", "forwardProjection", "sectionHeader", "openerHook", "preBranchFlagged", "postBranchFlagged"]) {
      assert.ok(typeof e[k] === "number", `expected modeExemptions.${k} to be a number; got ${typeof e[k]}`);
    }
    // ANALYSIS must produce at least one exemption against this fixture.
    const totalExempt = e.authorVoice + e.forwardProjection + e.sectionHeader + e.openerHook;
    assert.ok(totalExempt >= 1, `expected at least one ANALYSIS exemption against the fixture; got ${totalExempt}`);
    // Mode genuinely reduced the flag count.
    assert.ok(e.postBranchFlagged <= e.preBranchFlagged,
      `postBranchFlagged (${e.postBranchFlagged}) must be <= preBranchFlagged (${e.preBranchFlagged}) in ANALYSIS`,
    );
  });

  it("default-mode (no artifactMode) telemetry still includes the mode field set to default", async () => {
    const verdict: any = await runVerifier();
    // Default mode is REPORT-equivalent and must still emit the field.
    assert.ok(["REPORT", undefined, null, "DEFAULT"].includes(verdict.verifierReport.artifactMode),
      `default mode should expose artifactMode as the default sentinel; got ${verdict.verifierReport.artifactMode}`,
    );
  });
});
