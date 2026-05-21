/**
 * Tests for the Reasoning Quality Store + cycle wiring (PR #288).
 *
 * Spec invariants this file pins:
 *   1. The store refuses to persist any scorecard whose autoApply !== false
 *      or provisional !== true — propose-only enforced at the storage
 *      boundary so a tampered caller cannot smuggle a gate.
 *   2. End-of-cycle meta-improvement persists exactly one observational
 *      scorecard per cycle when `scoreReasoning` is enabled, and the result
 *      object exposes the scorecard.
 *   3. The same path persists nothing when `scoreReasoning: false` (tests).
 *   4. Empty / malformed lesson text is safely scored — never throws, never
 *      poisons the JSONL.
 *   5. The summary aggregator returns deterministic counts and a moving
 *      flourishing average.
 *   6. The append→read→tail roundtrip preserves the scorecard shape.
 *   7. No code path off this store calls a publish/gate API. (Static check
 *      via grep: scoreReasoningTrace is never read by any gate file.)
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rq-store-test-"));
process.env.DATA_DIR = TMP;

const {
  appendReasoningQualityEntry,
  readReasoningQualityEntries,
  readReasoningQualityTail,
  summarizeReasoningQuality,
} = await import("../reasoningQualityStore.ts");
const { scoreReasoningTrace } = await import("../reasoningQualityHarness.ts");
const { runResearchCycleMetaImprovement } = await import("../researchCycleMetaImprovement.ts");
const { db } = await import("../db.ts");
const { selfRecommendations } = await import("@shared/schema");

function wipeStoreFile() {
  const f = path.join(TMP, "reasoning_quality_log.jsonl");
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
function wipeRecs() {
  try { db.delete(selfRecommendations).run(); } catch {}
}

const goodRecord = {
  candidateRef: "ok",
  verdict: "pursue" as const,
  overall: 8.2,
  hadProtocol: true,
  isDuplicate: false,
  reason: "passes",
  recordedAt: new Date().toISOString(),
};

function recOverridden(r: Partial<typeof goodRecord>) {
  return { ...goodRecord, ...r, recordedAt: new Date().toISOString() };
}

describe("appendReasoningQualityEntry — storage boundary", () => {
  before(() => { wipeStoreFile(); });
  beforeEach(() => { wipeStoreFile(); });

  it("persists a well-formed observational scorecard", () => {
    const sc = scoreReasoningTrace({
      text: "I'm not sure. Alternatively, X. We can revisit if it fails.",
      reportedConfidence: 0.4,
      alternativesConsidered: ["X", "Y"],
      sources: ["src1"],
    });
    const entry = appendReasoningQualityEntry({
      engineStep: "test/manual",
      cycleId: "c1",
      scorecard: sc,
    });
    assert.ok(entry, "must return entry");
    assert.equal(entry!.scorecard.autoApply, false);
    assert.equal(entry!.scorecard.provisional, true);

    const all = readReasoningQualityEntries();
    assert.equal(all.length, 1);
    assert.equal(all[0].engineStep, "test/manual");
  });

  it("REFUSES to persist a tampered scorecard with autoApply=true", () => {
    const sc = scoreReasoningTrace({ text: "ok" });
    // Forge a tampered copy at the boundary.
    const tampered = { ...sc, autoApply: true } as any;
    const entry = appendReasoningQualityEntry({
      engineStep: "test/tampered",
      scorecard: tampered,
    });
    assert.equal(entry, null, "store must refuse autoApply=true");
    assert.equal(readReasoningQualityEntries().length, 0);
  });

  it("REFUSES to persist a scorecard with provisional=false", () => {
    const sc = scoreReasoningTrace({ text: "ok" });
    const tampered = { ...sc, provisional: false } as any;
    const entry = appendReasoningQualityEntry({
      engineStep: "test/non-provisional",
      scorecard: tampered,
    });
    assert.equal(entry, null);
    assert.equal(readReasoningQualityEntries().length, 0);
  });

  it("read tolerates corrupt lines without losing valid prior records", () => {
    const sc = scoreReasoningTrace({ text: "good entry" });
    appendReasoningQualityEntry({ engineStep: "test/ok", scorecard: sc });
    // Append a torn line manually.
    const f = path.join(TMP, "reasoning_quality_log.jsonl");
    fs.appendFileSync(f, "{this is not json\n", "utf8");
    appendReasoningQualityEntry({ engineStep: "test/ok2", scorecard: sc });
    const all = readReasoningQualityEntries();
    assert.equal(all.length, 2, "corrupt line skipped, valid records intact");
  });

  it("readReasoningQualityTail returns most-recent first", () => {
    const sc = scoreReasoningTrace({ text: "x" });
    appendReasoningQualityEntry({ engineStep: "step1", scorecard: sc });
    appendReasoningQualityEntry({ engineStep: "step2", scorecard: sc });
    appendReasoningQualityEntry({ engineStep: "step3", scorecard: sc });
    const tail = readReasoningQualityTail(2);
    assert.equal(tail.length, 2);
    assert.equal(tail[0].engineStep, "step3");
    assert.equal(tail[1].engineStep, "step2");
  });

  it("summarizeReasoningQuality returns deterministic counts and a flourishing average", () => {
    const a = scoreReasoningTrace({
      text: "I'm not sure. Alternatively, X. Therefore, because of Y, we can revisit if it fails.",
      reportedConfidence: 0.4,
      alternativesConsidered: ["X", "Y", "Z"],
      sources: ["s1", "s2"],
    });
    const b = scoreReasoningTrace({
      text: "Definitely the answer. Obviously must be right. No doubt.",
      reportedConfidence: 0.99,
      irreversibleCommit: true,
      alternativesConsidered: [],
      sources: [],
    });
    appendReasoningQualityEntry({ engineStep: "s/a", scorecard: a });
    appendReasoningQualityEntry({ engineStep: "s/b", scorecard: b });
    const sum = summarizeReasoningQuality(10);
    assert.equal(sum.total, 2);
    assert.ok(sum.recentFlourishingAvg !== null);
    const sumOfBands =
      sum.bandCounts.high + sum.bandCounts.medium +
      sum.bandCounts.review + sum.bandCounts.low;
    assert.equal(sumOfBands, 2);
  });
});

describe("runResearchCycleMetaImprovement — observational scoring", () => {
  before(() => { wipeStoreFile(); wipeRecs(); });
  beforeEach(() => { wipeStoreFile(); wipeRecs(); });

  it("persists exactly one scorecard per cycle when scoring enabled AND proposals exist, and never autoApply=true (PR #412)", () => {
    // PR #412: a scorecard is now only emitted when there is real reasoning
    // to score (i.e. proposals.length > 0). Use an anomalous cycle so that
    // deriveProcedureChangeProposals fires — the scored input is the
    // proposal rationale+proposedChange text, not the cycle-stats line.
    const records = Array.from({ length: 10 }, () =>
      recOverridden({ verdict: "reject", overall: 4, hadProtocol: true, reason: "below threshold" }));
    const before = readReasoningQualityEntries().length;
    const out = runResearchCycleMetaImprovement({
      cycleId: "rq-cycle-1",
      recordsOverride: records,
    })!;
    assert.ok(out, "result returned");
    assert.ok(out.recommendations.length >= 1, "anomalous cycle must produce proposals");
    assert.ok(out.reasoningScorecard, "scorecard exposed on result when proposals exist");
    assert.equal(out.reasoningScorecard!.autoApply, false);
    assert.equal(out.reasoningScorecard!.provisional, true);

    const after = readReasoningQualityEntries();
    assert.equal(after.length, before + 1, "one append per cycle with proposals");
    assert.equal(after[after.length - 1].cycleId, "rq-cycle-1");
    assert.equal(after[after.length - 1].engineStep, "research-cycle/meta-improvement");
  });

  it("scoreReasoning:false suppresses both the scorecard and the JSONL append", () => {
    const before = readReasoningQualityEntries().length;
    const out = runResearchCycleMetaImprovement({
      cycleId: "rq-cycle-noscore",
      recordsOverride: [recOverridden({ verdict: "pursue" })],
      scoreReasoning: false,
    })!;
    assert.equal(out.reasoningScorecard, null);
    assert.equal(readReasoningQualityEntries().length, before, "no append when disabled");
  });

  it("malformed / empty cycle records are safely handled — never throws, no scorecard for empty reasoning (PR #412)", () => {
    // Force-empty records: meta-improvement still appends an archive record,
    // but per PR #412 we do NOT emit a scorecard when proposals.length === 0.
    // Empty input is not real reasoning to measure; scoring it was the very
    // measurement artifact PR #412 fixes.
    let threw = false;
    let out: any;
    try {
      out = runResearchCycleMetaImprovement({
        cycleId: "rq-cycle-empty",
        recordsOverride: [],
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "must not throw on empty cycle");
    assert.ok(out, "result returned");
    assert.equal(out.reasoningScorecard, null,
      "empty cycle must not emit a scorecard (no reasoning to score)");
    // Archive record IS still written — lessonText archive path unchanged.
    assert.ok(out.archiveRecord, "archive record still written for empty cycle");
  });

  it("meta-improvement scorecard never sets recommendations to depend on the band", () => {
    // Sanity: even on an anomalous cycle that triggers procedure-change
    // proposals, the band of the cycle's reasoning scorecard does NOT alter
    // proposal filing — proposals fire from stats, scorecards from the
    // lesson text. Verify these paths are independent.
    const recs = Array.from({ length: 8 }, () =>
      recOverridden({ verdict: "reject", overall: 3, reason: "low" }));
    const out = runResearchCycleMetaImprovement({
      cycleId: "rq-cycle-anomalous",
      recordsOverride: recs,
    })!;
    assert.ok(out.recommendations.length >= 1, "anomalous stats → proposals");
    assert.ok(out.reasoningScorecard, "scorecard always emitted alongside");
    // Whatever the band came out, it must NOT have changed proposal status:
    for (const r of out.recommendations) {
      assert.equal(r.status, "proposed");
    }
  });
});

describe("PR #288 contract — propose-only invariant (no gating off reasoning band)", () => {
  it("static contract: no production engine reads the band as a gate", async () => {
    // This is a static safety check. The harness/store types pin
    // autoApply:false, but the real defense is that no production caller
    // routes the band into a publish/promotion decision. We assert by
    // grepping for forbidden patterns and failing if any is found.
    const fsp = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const root = pathMod.resolve(process.cwd(), "server");
    async function walk(dir: string, acc: string[]): Promise<string[]> {
      let entries: any[] = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
      for (const ent of entries) {
        const p = pathMod.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "__tests__" || ent.name === "node_modules") continue;
          await walk(p, acc);
        } else if (ent.name.endsWith(".ts")) {
          acc.push(p);
        }
      }
      return acc;
    }
    const files = await walk(root, []);
    // Patterns that would indicate the band/score is being used as a gate.
    // We allow occurrences inside the harness, the store, and the
    // researchCycleMetaImprovement (where it is computed and persisted), and
    // inside publicApi where it is projected for the dashboard.
    const allowSubstrings = [
      "reasoningQualityHarness.ts",
      "reasoningQualityStore.ts",
      "researchCycleMetaImprovement.ts",
      "publicApi.ts",
    ];
    const forbiddenPatterns = [
      /reasoningQualityBand\s*===?\s*["']low["']/,
      /reasoningQualityBand\s*===?\s*["']review["']/,
      /scorecard\.invariantHeld\s*===?\s*false/,
    ];
    const offending: string[] = [];
    for (const f of files) {
      if (allowSubstrings.some(a => f.endsWith(a))) continue;
      const text = await fsp.readFile(f, "utf8");
      for (const pat of forbiddenPatterns) {
        if (pat.test(text)) {
          offending.push(`${f} matched ${pat}`);
          break;
        }
      }
    }
    assert.equal(offending.length, 0,
      `Found gating reads of the reasoning band in non-allowed files:\n${offending.join("\n")}`);
  });
});
