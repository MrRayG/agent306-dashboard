/**
 * intake-enforcement: deterministic regression coverage for the env-gated
 * intake controls wired through `researchEngine.addHypothesis`.
 *
 * Pins the behavior described in the 2026-05-18 verification report
 * finding (d) — that every hypothesis-creation path routes through
 * `addHypothesis`, that the soft-gate envs route to `needs_review`
 * rather than silent drops, and that the hard cap remains the only
 * refusal point. Sibling files (researchEngineSoftIntakeGate.test.ts,
 * hypothesisIntakePolicyControls.test.ts) cover overlapping ground;
 * this file is the explicit pin for the env-pair contract:
 *
 *   - INTAKE_GATE_SOFT=0 + HYPOTHESIS_BLOCK_ON_BACKLOG=0 → legacy path,
 *     candidate accepted as active.
 *   - INTAKE_GATE_SOFT=1, manual backlog under threshold → weak
 *     candidate routed to hygieneTag='needs_review', NOT dropped.
 *   - INTAKE_GATE_SOFT=1 + HYPOTHESIS_BLOCK_ON_BACKLOG=1, backlog over
 *     threshold → new candidate is routed to needs_review (soft refusal,
 *     candidate still stored).
 *   - INTAKE_GATE_SOFT=1, soft active cap reached → candidate tagged
 *     needs_review.
 *   - MAX_HYPOTHESIS_QUEUE at capacity → addHypothesis returns null
 *     regardless of soft flags. Hard cap is the only refusal point.
 *   - Memory-origin entries in memory_knowledge.json are NOT auto-
 *     promoted as a side effect of addHypothesis. Promotion is
 *     operator-only.
 *
 * Style matches server/__tests__/migrationFirstRunGuard.test.ts and
 * server/__tests__/researchEngineSoftIntakeGate.test.ts: node:test +
 * node:assert/strict, top-level await import after DATA_DIR/DB_PATH
 * redirect.
 *
 * Run: npx tsx --test server/__tests__/intakeGateEnforcement.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "intake-gate-enforcement-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const LAB    = path.join(TMP, "research_lab.json");
const MEMORY = path.join(TMP, "memory_knowledge.json");

function writeMemory(blob: unknown): void { fs.writeFileSync(MEMORY, JSON.stringify(blob)); }
function clearLab(): void { if (fs.existsSync(LAB)) fs.unlinkSync(LAB); }
function clearMemory(): void { if (fs.existsSync(MEMORY)) fs.unlinkSync(MEMORY); }

function clearAllIntakeEnv(): void {
  delete process.env.INTAKE_GATE_SOFT;
  delete process.env.INTAKE_SOFT_MAX_ACTIVE;
  delete process.env.HYPOTHESIS_BLOCK_ON_BACKLOG;
  delete process.env.HYPOTHESIS_MAX_ACTIVE;
  delete process.env.HYPOTHESIS_MAX_NEW_PER_CYCLE;
  delete process.env.HYPOTHESIS_STALE_DAYS;
  delete process.env.HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD;
  delete process.env.MAX_HYPOTHESIS_QUEUE;
}

const { addHypothesis, getResearchLab, resetResearchLab, saveResearchLab } = await import("../researchEngine.ts");

/** Seed the research lab via saveResearchLab so the seeded state lands in
 *  BOTH the DB blob and the JSON file. readResearchBlob prefers the DB
 *  row, so seeding only the JSON file would be silently ignored once the
 *  test runtime has touched the DB at all. */
function seedLab(hypotheses: any[]): void {
  saveResearchLab({
    topics: [],
    hypotheses,
    lastUpdated: new Date().toISOString(),
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
  } as any);
}

/** A well-formed candidate that PASSES gateIntake's strong-shape check by
 *  default. Overrides can flip individual fields to exercise a refusal
 *  verdict. The shape mirrors researchEngineSoftIntakeGate.test.ts's
 *  freshInput so both files exercise the same canonical fixture. */
function freshInput(over: Record<string, unknown> = {}): any {
  return {
    claim:           "OpenAlex citation count for paper X will pass 1000 by Q4 2026.",
    basis:           "https://example.com/source",
    metric:          "OpenAlex citation count",
    prediction:      "Citation count will pass 1000 by Q4 2026.",
    timeframe:       "Q4 2026",
    confidence:      "medium",
    source:          "test",
    measurementPath: "OpenAlex citation count for paper X",
    ...over,
  };
}

/** A backlog-pressure fixture: positional-debate rows that classify into
 *  the rewrite_positional_debate bucket the manual-backlog gate counts. */
function makeBacklogRow(id: string, claim: string): any {
  return {
    id,
    claim,
    basis:           "https://example.com/source",
    metric:          "OpenAlex citation count",
    prediction:      "Position wins.",
    timeframe:       "Q4 2026",
    status:          "forming",
    confidence:      "medium",
    formedAt:        new Date("2026-05-10T00:00:00Z").toISOString(),
    measurementPath: "OpenAlex citation count",
  };
}

describe("intake gate enforcement — env-pair contract", () => {
  before(() => { try { resetResearchLab(); } catch { /* fine */ } clearLab(); clearMemory(); });
  beforeEach(() => {
    try { resetResearchLab(); } catch { /* fine */ }
    clearLab();
    clearMemory();
    clearAllIntakeEnv();
  });
  after(() => { clearAllIntakeEnv(); clearLab(); clearMemory(); });

  // ── (1) baseline ─────────────────────────────────────────────────────
  it("INTAKE_GATE_SOFT=0 + HYPOTHESIS_BLOCK_ON_BACKLOG=0: weak candidate accepted as active (legacy path)", () => {
    process.env.INTAKE_GATE_SOFT = "0";
    process.env.HYPOTHESIS_BLOCK_ON_BACKLOG = "0";
    // No evidenceRef / useCase — gateIntake() would refuse under SOFT=1,
    // but with both flags off the legacy path stores the record with
    // status='forming' and NO hygiene tag.
    const stored = addHypothesis(freshInput()) as any;
    assert.ok(stored, "legacy path must store the candidate");
    assert.equal(stored.status, "forming",
      "legacy path stores as active (status='forming')");
    assert.equal(stored.hygieneTag, undefined,
      "legacy path attaches no hygiene tag");
    assert.equal(getResearchLab().hypotheses.length, 1);
  });

  // ── (2) soft gate alone, backlog under threshold ─────────────────────
  it("INTAKE_GATE_SOFT=1, backlog under threshold: weak candidate routed to hygieneTag=needs_review, not dropped, not active", () => {
    process.env.INTAKE_GATE_SOFT = "1";
    // HYPOTHESIS_BLOCK_ON_BACKLOG unset — backlog gate is off, so only
    // the quality gate fires. The candidate lacks evidenceRef + useCase
    // (addHypothesis never threads them through today), so gateIntake
    // returns missing_evidence_ref → soft-route.
    const stored = addHypothesis(freshInput()) as any;
    assert.ok(stored, "soft refusal must still store (not silent drop)");
    assert.equal(stored.hygieneTag, "needs_review",
      "weak candidate must be tagged for operator review");
    assert.ok(
      typeof stored.hygieneReason === "string" && stored.hygieneReason.includes("soft intake gate"),
      "hygieneReason must explain the gate that fired",
    );
    assert.equal(stored.hygieneTaggedBy, "intake_gate",
      "tagger identity must be 'intake_gate' for audit visibility");
    // The record is in the lab. It is NOT excluded from formal storage.
    assert.equal(getResearchLab().hypotheses.length, 1);
    // status is still 'forming' — the tag is the routing signal, not the
    // status. (The reset/audit visibility surface routes on hygieneTag.)
    assert.equal(stored.status, "forming");
  });

  // ── (3) soft gate + backlog gate, backlog OVER threshold ─────────────
  it("INTAKE_GATE_SOFT=1 + HYPOTHESIS_BLOCK_ON_BACKLOG=1, backlog OVER threshold: candidate routed to needs_review (stored, not dropped)", () => {
    process.env.INTAKE_GATE_SOFT = "1";
    process.env.HYPOTHESIS_BLOCK_ON_BACKLOG = "1";
    process.env.HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD = "1";
    // Seed two positional-debate rows so manualBacklog=2 > threshold=1
    // (pressure='over'). The backlog gate then routes new candidates.
    seedLab([
      makeBacklogRow("p1", "Position A is more accurate than Position B on x."),
      makeBacklogRow("p2", "Position C is more accurate than Position D on y."),
    ]);
    // Seed BOTH DB blob and JSON file (readResearchBlob prefers the DB
    // row). Do NOT call resetResearchLab() afterwards — that would wipe
    // the seeded state.

    // Even using a well-formed candidate (passing the quality gate), the
    // backlog gate should annotate hygieneTag='needs_review' OR the
    // quality gate fires first; either way the record must be STORED and
    // tagged, never deleted.
    const stored = addHypothesis(freshInput({
      claim:           "Distinctly new citation claim for paper Q will pass 750 by Q3 2027.",
      metric:          "OpenAlex citation count paper Q",
      measurementPath: "OpenAlex citation count for paper Q",
    })) as any;
    assert.ok(stored, "backlog-blocked candidate must still be stored (soft refusal)");
    assert.equal(stored.hygieneTag, "needs_review",
      "candidate must be tagged needs_review when backlog gate fires");
    assert.ok(
      typeof stored.hygieneReason === "string" && stored.hygieneReason.length > 0,
      "hygieneReason must be populated",
    );
    // The reason string surfaces at least one of the active soft gates.
    // Either path (intake-quality or manual-backlog) is acceptable; both
    // are evidence the env-pair is wired.
    assert.match(stored.hygieneReason, /(manual backlog|soft intake gate|soft active cap)/);
    // No record was deleted — the seeded backlog + new candidate persist.
    assert.ok(getResearchLab().hypotheses.length >= 3,
      "no auto-delete: seeded backlog rows + new candidate must all persist");
  });

  // ── (4) soft active cap reached ──────────────────────────────────────
  it("INTAKE_GATE_SOFT=1 + HYPOTHESIS_MAX_ACTIVE=1: second candidate is tagged needs_review (soft cap routing)", () => {
    process.env.INTAKE_GATE_SOFT = "1";
    process.env.HYPOTHESIS_MAX_ACTIVE = "1";
    // First candidate fills the active slot. Use distinct claims so
    // similarity / entity-dedup inside addHypothesis can't collapse them.
    const first = addHypothesis(freshInput({
      claim:  "OpenAlex citation count for paper P will pass 500 by Q4 2026.",
      metric: "OpenAlex citation count paper P",
    })) as any;
    assert.ok(first, "first candidate must be stored");
    const second = addHypothesis(freshInput({
      claim:           "GitHub star count for repo monodepth-net will pass 2500 by H1 2027.",
      metric:          "GitHub star count monodepth-net",
      measurementPath: "GitHub stars API for monodepth-net",
    })) as any;
    assert.ok(second, "second candidate must still be stored (soft cap routes, not drops)");
    assert.equal(second.hygieneTag, "needs_review");
    assert.match(
      second.hygieneReason,
      /soft active cap|one-in-one-out/,
      "hygieneReason must describe the soft-cap routing",
    );
  });

  // ── (5) hard cap ─────────────────────────────────────────────────────
  it("MAX_HYPOTHESIS_QUEUE at capacity: addHypothesis returns null regardless of soft flags", () => {
    // Hard cap counts forming+testing. Seed the lab over the limit and
    // verify both flag-off and flag-on cases refuse the new candidate.
    seedLab([
      makeBacklogRow("hc1", "Distinct claim alpha will exceed metric one by Q4 2026."),
      makeBacklogRow("hc2", "Distinct claim bravo will exceed metric two by Q4 2026."),
      makeBacklogRow("hc3", "Distinct claim charlie will exceed metric three by Q4 2026."),
    ]);
    process.env.MAX_HYPOTHESIS_QUEUE = "2";
    // Seed BOTH DB blob and JSON file. Do NOT call resetResearchLab()
    // afterwards — that would wipe the seeded state and the hard-cap
    // check (forming+testing >= MAX_HYPOTHESIS_QUEUE) would see 0 rows.

    // Case A: legacy path, no soft flags.
    delete process.env.INTAKE_GATE_SOFT;
    delete process.env.HYPOTHESIS_BLOCK_ON_BACKLOG;
    const legacyResult = addHypothesis(freshInput({
      claim:           "Brand-new hard-cap probe claim delta will pass metric four by Q4 2026.",
      metric:          "OpenAlex citation count paper delta",
      measurementPath: "OpenAlex citation count for paper delta",
    })) as any;
    assert.equal(legacyResult, null,
      "hard cap must refuse via null return when active count >= MAX_HYPOTHESIS_QUEUE");

    // Case B: every soft flag on. Hard cap still refuses.
    process.env.INTAKE_GATE_SOFT = "1";
    process.env.HYPOTHESIS_BLOCK_ON_BACKLOG = "1";
    process.env.HYPOTHESIS_MANUAL_BACKLOG_THRESHOLD = "1";
    const softResult = addHypothesis(freshInput({
      claim:           "Brand-new hard-cap probe claim epsilon will pass metric five by Q4 2026.",
      metric:          "OpenAlex citation count paper epsilon",
      measurementPath: "OpenAlex citation count for paper epsilon",
    })) as any;
    assert.equal(softResult, null,
      "soft flags must NOT bypass the hard cap — hard cap is the only refusal point");
  });

  // ── (6) memory-origin entries are operator-promote-only ──────────────
  it("memory-origin: addHypothesis does NOT auto-promote memory_knowledge.json entries", () => {
    process.env.INTAKE_GATE_SOFT = "1";
    // Stage two memory-origin hypothesis-titled entries. The intake CLI /
    // visibility builder lists these in `promote_later_memory_origin`,
    // and the hypothesisReset CLI HARD-REFUSES promotion of this bucket.
    // addHypothesis must NEVER mutate these entries as a side effect.
    writeMemory({
      entries: [
        { id: "mem1", title: "Hypothesis: foo" },
        { id: "mem2", title: "Hypothesis: bar" },
      ],
    });
    const memorySnapshotBefore = fs.readFileSync(MEMORY, "utf8");

    // Adding a formal candidate must not touch the memory file.
    const stored = addHypothesis(freshInput({
      claim:           "Distinct memory-origin separation probe claim zeta passes 900 by Q4 2026.",
      metric:          "OpenAlex citation count paper zeta",
      measurementPath: "OpenAlex citation count for paper zeta",
    })) as any;
    assert.ok(stored);

    const memorySnapshotAfter = fs.readFileSync(MEMORY, "utf8");
    assert.equal(memorySnapshotAfter, memorySnapshotBefore,
      "memory_knowledge.json must be byte-identical after addHypothesis — promotion is operator-only");

    // The memory entries also retain no auto-promotion marker.
    const mem = JSON.parse(memorySnapshotAfter);
    for (const e of mem.entries) {
      assert.equal(e.promotedToHypothesisId, undefined,
        "no memory entry may carry a promotedToHypothesisId after addHypothesis runs");
    }
  });
});
