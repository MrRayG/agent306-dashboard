/**
 * Tests for the read-only Hypothesis Intake Audit Visibility builder.
 *
 * Invariants pinned by this file:
 *   1. With no data sources at all the builder returns a well-shaped snapshot
 *      whose counts are zero and whose dataMissingNotes lists the missing
 *      sources rather than throwing.
 *   2. The reset classifier is deterministic: each well-defined input maps
 *      to exactly one bucket. Tested across keep_active, archive_stale,
 *      archive_data_unavailable, archive_duplicate,
 *      rewrite_positional_debate, rewrite_missing_evidence_path, and
 *      needs_operator_review.
 *   3. The intake gate flags positional-debate claims that have no evidence
 *      on either side, accepts research-gap claims that name a metric and
 *      deadline, and refuses stubs / unfalsifiable claims.
 *   4. The active cap policy reports `under` / `at` / `over` correctly,
 *      surfaces a one-in-one-out recommendation only when at-or-over, and
 *      points the operator at the existing enforcement site rather than
 *      introducing a new throttle.
 *   5. Memory-origin hypothesis entries are counted, unpromoted entries are
 *      surfaced separately, and the Phase 2 verdict makes clear they cannot
 *      feed experiment registration directly.
 *   6. The builder is read-only: calling it does NOT create any new file
 *      under DATA_DIR and does NOT mutate the real repo data files.
 *   7. The block is wired into the autonomy monitor snapshot under
 *      `hypothesisIntakeAudit` and the rest of the snapshot is untouched.
 *
 * Run: npx tsx --test server/__tests__/hypothesisIntakeAuditVisibility.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase-intake-audit-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB    = path.join(REPO_ROOT, "data", "memory_knowledge.json");

function hash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hash(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hash(REAL_MEMORY_KB);

const {
  buildHypothesisIntakeAuditVisibility,
  classifyReset,
  gateIntake,
  looksLikePositionalDebate,
  RESET_BUCKETS,
  DEFAULT_ACTIVE_CAP,
} = await import("../hypothesisIntakeAuditVisibility.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

function writeLab(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "research_lab.json"), JSON.stringify(blob));
}
function clearLab(): void {
  const p = path.join(TMP, "research_lab.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
function writeMemory(blob: unknown): void {
  fs.writeFileSync(path.join(TMP, "memory_knowledge.json"), JSON.stringify(blob));
}
function clearMemory(): void {
  const p = path.join(TMP, "memory_knowledge.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function makeHyp(overrides: Record<string, unknown>): any {
  return {
    id:              "hyp_default",
    claim:           "Default research-gap claim with metric: citation count will pass 1000 by Q4 2026.",
    basis:           "https://example.com/source",
    metric:          "OpenAlex citation count",
    prediction:      "Citation count will pass 1000 by Q4 2026.",
    timeframe:       "Q4 2026",
    status:          "forming",
    confidence:      "medium",
    formedAt:        new Date("2026-05-10T00:00:00Z").toISOString(),
    measurementPath: "OpenAlex citation count for paper X",
    ...overrides,
  };
}

// ── Empty / missing-data behaviour ──────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — empty / missing-data behaviour", () => {
  before(() => {
    clearLab();
    clearMemory();
  });

  after(() => {
    assert.equal(hash(REAL_RESEARCH_LAB), PRE_RESEARCH, "real research_lab.json must not be touched");
    assert.equal(hash(REAL_MEMORY_KB),    PRE_MEMORY,   "real memory_knowledge.json must not be touched");
  });

  it("returns a well-shaped snapshot when no data sources exist", () => {
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.schemaVersion, "phase-intake-audit-1");
    assert.equal(v.label, "hypothesis-intake-audit-visibility");
    assert.equal(v.generatedAt, "2026-05-17T00:00:00.000Z");
    assert.equal(v.capPolicy.active, 0);
    assert.equal(v.capPolicy.pressure, "under");
    assert.equal(v.memoryOrigin.totalMemoryHypothesisEntries, 0);
    assert.equal(v.memoryOrigin.unpromoted, 0);
    assert.equal(v.intakeQuality.totalExamined, 0);
    assert.equal(v.intakeQuality.wouldFailCount, 0);
    assert.ok(v.dataMissingNotes.some(n => n.includes("research_lab.json missing")));
    assert.ok(v.dataMissingNotes.some(n => n.includes("memory_knowledge.json missing")));
    // Reset buckets all present, all 0.
    assert.equal(v.resetBuckets.length, RESET_BUCKETS.length);
    for (const b of v.resetBuckets) assert.equal(b.count, 0, `bucket=${b.bucket}`);
  });

  it("invariants block declares read-only / dry-run-only / propose-only / non-widening / advisory-only", () => {
    const v = buildHypothesisIntakeAuditVisibility();
    assert.match(v.invariants.readOnly, /no write|no insert|no scheduler|no apply/i);
    assert.match(v.invariants.dryRunOnly, /dry-run|proposal|no archive/i);
    assert.match(v.invariants.proposeOnly, /pressure|recommendation|enforcement/i);
    assert.match(v.invariants.nonWidening, /no new external|no new auth|no new primitive/i);
    assert.match(v.invariants.advisoryOnly, /advisory|text only/i);
  });

  it("nextSafeActions always includes the advisory-only banner", () => {
    const v = buildHypothesisIntakeAuditVisibility();
    const banner = v.nextSafeActions.find(r => r.toLowerCase().includes("advisory text only"));
    assert.ok(banner, "nextSafeActions must include the advisory banner");
  });

  it("calling the builder is read-only — DATA_DIR contents unchanged", () => {
    const before = new Set(fs.readdirSync(TMP));
    buildHypothesisIntakeAuditVisibility();
    buildHypothesisIntakeAuditVisibility();
    const after = new Set(fs.readdirSync(TMP));
    assert.deepEqual([...after].sort(), [...before].sort());
  });
});

// ── Reset classifier buckets ────────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — reset classifier buckets", () => {
  const NOW = new Date("2026-05-17T00:00:00Z");

  it("keep_active when active and well-formed", () => {
    const h = makeHyp({ id: "h_keep" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "keep_active", r.reasons.join(" / "));
  });

  it("archive_data_unavailable when status=data-unavailable", () => {
    const h = makeHyp({ id: "h_du", status: "data-unavailable" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_data_unavailable");
  });

  it("archive_stale when status=stale-retired", () => {
    const h = makeHyp({ id: "h_sr", status: "stale-retired" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_stale");
  });

  it("archive_stale when status=expired", () => {
    const h = makeHyp({ id: "h_e", status: "expired" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_stale");
  });

  it("archive_stale when resolved (confirmed / rejected)", () => {
    const conf = classifyReset(makeHyp({ id: "h_c", status: "confirmed" }), { now: NOW });
    assert.equal(conf.bucket, "archive_stale");
    const rej = classifyReset(makeHyp({ id: "h_r", status: "rejected" }), { now: NOW });
    assert.equal(rej.bucket, "archive_stale");
  });

  it("archive_duplicate when aliasOf is set", () => {
    const h = makeHyp({ id: "h_dup", aliasOf: "hyp_canonical_1" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_duplicate");
  });

  it("rewrite_positional_debate when claim is positional", () => {
    const h = makeHyp({
      id:    "h_pos",
      claim: "Position A is more accurate than Position B on AI regulation.",
    });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "rewrite_positional_debate", r.reasons.join(" / "));
  });

  it("rewrite_missing_evidence_path when measurementPath is missing", () => {
    const h = makeHyp({
      id:              "h_miss",
      measurementPath: undefined,
    });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "rewrite_missing_evidence_path", r.reasons.join(" / "));
  });

  it("archive_stale when forming for longer than staleDays", () => {
    const h = makeHyp({
      id:       "h_old",
      formedAt: new Date("2025-01-01T00:00:00Z").toISOString(),
      status:   "forming",
    });
    const r = classifyReset(h, { now: NOW, staleDays: 30 });
    assert.equal(r.bucket, "archive_stale", r.reasons.join(" / "));
  });

  it("needs_operator_review when hygiene tag flags review/data/rewrite without lifecycle archive", () => {
    // Missing prediction → classifyHypothesis returns needs_rewrite. We bypass
    // the dedicated rewrite_missing_evidence_path bucket by keeping the
    // measurementPath/metric/basis fields populated but blanking prediction.
    const h = makeHyp({
      id:         "h_review",
      prediction: "",
    });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "needs_operator_review", r.reasons.join(" / "));
  });

  it("operator-set hygieneTag=archived_stale routes to archive_stale", () => {
    const h = makeHyp({ id: "h_op_stale", hygieneTag: "archived_stale" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_stale");
  });

  it("operator-set hygieneTag=archived_unsolvable routes to archive_data_unavailable", () => {
    const h = makeHyp({ id: "h_op_du", hygieneTag: "archived_unsolvable" });
    const r = classifyReset(h, { now: NOW });
    assert.equal(r.bucket, "archive_data_unavailable");
  });
});

// ── Positional-debate detection ─────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — positional-debate detection", () => {
  it("flags 'Position A is more accurate than Position B'", () => {
    assert.equal(looksLikePositionalDebate("Position A is more accurate than Position B."), true);
  });

  it("flags 'Side A wins the debate'", () => {
    assert.equal(looksLikePositionalDebate("Side A wins the debate."), true);
  });

  it("does NOT flag a research-gap claim with a metric and deadline", () => {
    assert.equal(
      looksLikePositionalDebate("Citation count for paper X will exceed 1000 by Q4 2026."),
      false,
    );
  });

  it("does NOT flag a comparator claim that quantifies its prediction", () => {
    assert.equal(
      looksLikePositionalDebate("Model M is 20% more accurate than baseline on benchmark B by 2026-12."),
      false,
    );
  });

  it("does NOT flag empty / non-string input", () => {
    assert.equal(looksLikePositionalDebate(""), false);
    assert.equal(looksLikePositionalDebate(undefined as unknown as string), false);
  });
});

// ── Intake quality gate ─────────────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — intake quality gate", () => {
  it("passes a research-gap claim with all required fields", () => {
    const r = gateIntake({
      claim:           "Citation count for paper X will exceed 1000 by Q4 2026.",
      prediction:      "Citation count will exceed 1000 by 2026-12-31.",
      measurementPath: "OpenAlex citation count for paper X",
      evidenceRef:     "https://openalex.org/W12345",
      useCase:         "calibration of citation-velocity prediction",
    });
    assert.equal(r.verdict, "pass");
    assert.equal(r.ok, true);
  });

  it("rejects a stub claim", () => {
    const r = gateIntake({ claim: "TBD" });
    assert.equal(r.verdict, "stub_claim");
    assert.equal(r.ok, false);
  });

  it("rejects an unfalsifiable aspirational claim", () => {
    const r = gateIntake({
      claim:      "AI safety might possibly improve over time, generally.",
      prediction: "It may improve.",
    });
    assert.equal(r.verdict, "unfalsifiable");
    assert.equal(r.ok, false);
  });

  it("rejects a positional debate claim", () => {
    const r = gateIntake({
      claim:           "Position A is more accurate than Position B on alignment.",
      prediction:      "Position A wins.",
      measurementPath: "discussion forums",
      evidenceRef:     "https://example.com",
      useCase:         "content angle",
    });
    assert.equal(r.verdict, "rewrite_positional_debate");
    assert.equal(r.ok, false);
  });

  it("rejects missing measurement path", () => {
    const r = gateIntake({
      claim:      "Citation count will exceed 1000 by Q4 2026.",
      prediction: "exceed 1000 by Q4 2026",
      evidenceRef: "https://example.com",
      useCase:    "x",
    });
    assert.equal(r.verdict, "missing_evidence_path");
    assert.equal(r.ok, false);
  });

  it("rejects missing evidence ref", () => {
    const r = gateIntake({
      claim:           "Citation count will exceed 1000 by Q4 2026.",
      prediction:      "exceed 1000 by Q4 2026",
      measurementPath: "OpenAlex",
      useCase:         "x",
    });
    assert.equal(r.verdict, "missing_evidence_ref");
    assert.equal(r.ok, false);
  });

  it("rejects missing use case", () => {
    const r = gateIntake({
      claim:           "Citation count will exceed 1000 by Q4 2026.",
      prediction:      "exceed 1000 by Q4 2026",
      measurementPath: "OpenAlex",
      evidenceRef:     "https://openalex.org/x",
    });
    assert.equal(r.verdict, "missing_use_case");
    assert.equal(r.ok, false);
  });
});

// ── Active cap pressure ─────────────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — active cap pressure", () => {
  before(() => { clearLab(); clearMemory(); });

  it("under when active < maxActive", () => {
    writeLab({
      hypotheses: Array.from({ length: 5 }, (_, i) => ({
        id: `h${i}`, claim: "c", status: "forming", formedAt: new Date().toISOString(),
        basis: "b", metric: "m", prediction: "p", timeframe: "t",
        measurementPath: "mp",
      })),
    });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z"), maxActive: 25 });
    assert.equal(v.capPolicy.active, 5);
    assert.equal(v.capPolicy.pressure, "under");
    assert.equal(v.capPolicy.overBy, 0);
    assert.equal(v.capPolicy.recommendedAction, "");
  });

  it("at when active == maxActive", () => {
    writeLab({
      hypotheses: Array.from({ length: 3 }, (_, i) => ({
        id: `h${i}`, claim: "c", status: "forming", formedAt: new Date().toISOString(),
      })),
    });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z"), maxActive: 3 });
    assert.equal(v.capPolicy.active, 3);
    assert.equal(v.capPolicy.pressure, "at");
    assert.match(v.capPolicy.recommendedAction, /one-in-one-out/i);
  });

  it("over when active > maxActive, with overBy and recommendation", () => {
    writeLab({
      hypotheses: Array.from({ length: 30 }, (_, i) => ({
        id: `h${i}`, claim: "c", status: "forming", formedAt: new Date().toISOString(),
      })),
    });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z"), maxActive: 25 });
    assert.equal(v.capPolicy.pressure, "over");
    assert.equal(v.capPolicy.overBy, 5);
    assert.match(v.capPolicy.recommendedAction, /one-in-one-out/i);
    assert.match(v.capPolicy.recommendedAction, /6\s+record/);
  });

  it("references existing enforcement site rather than introducing a new throttle", () => {
    const v = buildHypothesisIntakeAuditVisibility();
    assert.match(v.capPolicy.enforcementSite.file, /researchEngine\.ts/);
    assert.equal(v.capPolicy.enforcementSite.envVar, "MAX_HYPOTHESIS_QUEUE");
    assert.ok(v.capPolicy.enforcementSite.fallback > 0);
  });

  it("uses defaults when no override is passed", () => {
    clearLab();
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.capPolicy.maxActive, DEFAULT_ACTIVE_CAP.maxActive);
    assert.equal(v.capPolicy.maxNewPerDailyCycle, DEFAULT_ACTIVE_CAP.maxNewPerDailyCycle);
  });
});

// ── Memory-origin blocked handling ──────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — memory-origin blocked handling", () => {
  before(() => { clearLab(); clearMemory(); });

  it("counts memory-origin entries by title and promotion state", () => {
    writeMemory({
      entries: [
        { id: "m1", title: "Hypothesis: example 1" },
        { id: "m2", title: "Hypothesis: example 2", promotedToHypothesisId: "hyp_99" },
        { id: "m3", title: "Hypothesis: example 3" },
        { id: "m4", title: "Some unrelated KB note" },
      ],
    });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    assert.equal(v.memoryOrigin.totalMemoryHypothesisEntries, 3);
    assert.equal(v.memoryOrigin.promoted, 1);
    assert.equal(v.memoryOrigin.unpromoted, 2);
    assert.match(v.memoryOrigin.phase2Verdict, /NEVER feed Phase 2/);
  });

  it("formationSources surfaces memory-origin as its own row with a hard-block hint", () => {
    writeMemory({ entries: [{ id: "m1", title: "Hypothesis: x" }] });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const memorySrc = v.formationSources.find(s => s.key === "memory_origin");
    assert.ok(memorySrc);
    assert.equal(memorySrc!.count, 1);
    assert.equal(memorySrc!.store, "memory_knowledge.json");
    assert.match(memorySrc!.codePathHint ?? "", /Phase 2 blocked/);
  });

  it("nextSafeActions mentions unpromoted memory-origin entries", () => {
    writeMemory({ entries: [{ id: "m1", title: "Hypothesis: x" }, { id: "m2", title: "Hypothesis: y" }] });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const hit = v.nextSafeActions.find(a => /memory-origin/.test(a));
    assert.ok(hit, "expected nextSafeActions to mention memory-origin entries");
    assert.match(hit!, /2 memory-origin/);
  });
});

// ── Formation source audit ──────────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — formation source audit", () => {
  before(() => { clearLab(); clearMemory(); });

  it("breaks down formal records by source field", () => {
    writeLab({
      hypotheses: [
        { id: "h1", claim: "c", status: "forming", formedAt: "2026-05-10T00:00:00Z", source: "daily_cycle" },
        { id: "h2", claim: "c", status: "forming", formedAt: "2026-05-10T00:00:00Z", source: "daily_cycle" },
        { id: "h3", claim: "c", status: "forming", formedAt: "2026-05-10T00:00:00Z", source: "research_analysis" },
        { id: "h4", claim: "c", status: "forming", formedAt: "2026-05-10T00:00:00Z", source: "manual" },
        { id: "h5", claim: "c", status: "forming", formedAt: "2026-05-10T00:00:00Z" },
      ],
    });
    const v = buildHypothesisIntakeAuditVisibility({ now: new Date("2026-05-17T00:00:00Z") });
    const sources = v.formationSources;
    const formal = sources.find(s => s.key === "formal");
    assert.equal(formal?.count, 5);
    const dc = sources.find(s => s.key === "formal_source:daily_cycle");
    assert.equal(dc?.count, 2);
    assert.equal(dc?.kind, "daily_cycle_seed");
    const ra = sources.find(s => s.key === "formal_source:research_analysis");
    assert.equal(ra?.count, 1);
    const manual = sources.find(s => s.key === "formal_source:manual");
    assert.equal(manual?.count, 1);
    const unset = sources.find(s => s.key === "formal_source:(unset)");
    assert.equal(unset?.count, 1);
  });
});

// ── No-write behaviour ──────────────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — no-write behaviour", () => {
  it("does not modify research_lab.json or memory_knowledge.json across multiple calls", () => {
    writeLab({ hypotheses: [{ id: "h1", claim: "x", status: "forming" }] });
    writeMemory({ entries: [{ id: "m1", title: "Hypothesis: x" }] });
    const labP = path.join(TMP, "research_lab.json");
    const memP = path.join(TMP, "memory_knowledge.json");
    const labH = crypto.createHash("sha256").update(fs.readFileSync(labP)).digest("hex");
    const memH = crypto.createHash("sha256").update(fs.readFileSync(memP)).digest("hex");
    for (let i = 0; i < 5; i++) buildHypothesisIntakeAuditVisibility();
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(labP)).digest("hex"), labH);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(memP)).digest("hex"), memH);
  });
});

// ── Autonomy monitor wiring ─────────────────────────────────────────────────

describe("hypothesisIntakeAuditVisibility — autonomy monitor wiring", () => {
  before(() => { clearLab(); clearMemory(); });

  it("appears on the autonomy monitor snapshot under `hypothesisIntakeAudit`", () => {
    const snapshot = buildAutonomyMonitorSnapshot(new Date("2026-05-17T00:00:00Z"));
    const block = (snapshot as any).hypothesisIntakeAudit;
    assert.ok(block, "snapshot must expose hypothesisIntakeAudit");
    assert.equal(block.schemaVersion, "phase-intake-audit-1");
    assert.equal(block.label, "hypothesis-intake-audit-visibility");
    // Sibling blocks still present.
    assert.ok((snapshot as any).workloadBudget);
    assert.ok((snapshot as any).runtime);
    assert.ok((snapshot as any).selfRuleEnforcement);
    assert.ok((snapshot as any).promotionGateAuthority);
    assert.ok(Array.isArray((snapshot as any).stages));
  });
});
