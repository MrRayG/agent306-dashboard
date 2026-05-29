/**
 * PR #445 — missingPrimitiveReconciler supersession-on-coverage tests.
 *
 * Companion to PR #443 (`primitive-fallback-rec` runtime emission) and
 * PR #444 (reflection temporal grounding guard). Pins the contract for
 * the second supersession path added in this PR:
 *
 *   1. With `supersedeOnDispatchCoverage: true`, proposed missing-primitive
 *      recs whose family is now `dispatch_capable` in the primitive registry
 *      are rejected with status='rejected', operator='reconciler', and a
 *      structured supersession note. Audit history (id, createdAt, title,
 *      rationale, proposedChange, sourceInsightId, evidence) is preserved.
 *
 *   2. With the gate ON, recs for `registered_only` (registered primitive
 *      but gates OFF) and `not_registered` families remain proposed.
 *      Coverage being merely "registered" is not enough to supersede —
 *      the operator's gap is still real until dispatcher gates flip ON.
 *
 *   3. With the gate ON, recs whose ledger entry has been rotated out
 *      ARE still superseded when the family parsed from the rec title is
 *      dispatch_capable. This is the headline case — the longest-stale
 *      recs that the translator-driven path can never clear.
 *
 *   4. Non-missing-primitive recs are never touched (Pin 4 preserved).
 *
 *   5. Unrelated proposed recs (any title not starting with
 *      `missing-primitive:`) remain visible.
 *
 *   6. With the gate OFF (default), the new path is a no-op even when
 *      every family is dispatch_capable. Old behavior preserved
 *      byte-identically.
 *
 *   7. supersededByPrimitiveCoverage and supersededRecIds populate
 *      correctly; the count is a strict subset of rejectedRecIds.
 *
 * Run:
 *   npx tsx --test server/__tests__/missingPrimitiveReconcilerSupersession.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "missingPrimReconcilerSupersession-test-"),
);
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const { db } = await import("../db.js");
const { selfRecommendations } = await import("@shared/schema");
const {
  proposeRecommendation,
  getRecommendation,
} = await import("../selfRecommendationEngine.js");
const { loadLedger, saveLedger } = await import("../insightLedger.js");
const {
  reconcileMissingPrimitiveRecs,
  MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENV,
} = await import("../missingPrimitiveReconciler.js");
const {
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
} = await import("../primitives/registry.js");
const {
  registerSynthesisPrimitive,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
} = await import("../primitives/synthesis/index.js");
const {
  registerArtifactPrimitive,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
} = await import("../primitives/artifact/index.js");
const {
  registerOtherPrimitive,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
} = await import("../primitives/other/index.js");
const {
  registerArchivePrimitive,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
} = await import("../primitives/archive/index.js");
const {
  registerTtlPrimitive,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
} = await import("../primitives/ttl/index.js");
const {
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} = await import("../primitives/dispatcher.js");

const ALL_ENV_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENV,
];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ALL_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ALL_ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function clearAllFlags(): void {
  for (const k of ALL_ENV_KEYS) delete process.env[k];
}
function turnAllGatesOn(): void {
  process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
}

function wipeRecs() {
  try {
    db.delete(selfRecommendations).run();
  } catch {}
}
function wipeLedger() {
  saveLedger({
    entries: [],
    lastCycleReflected: 0,
    lastUpdated: new Date().toISOString(),
  });
}
function seedLedgerEntry(opts: {
  id: string;
  insight: string;
  action: string;
}) {
  const ledger = loadLedger();
  ledger.entries.unshift({
    id: opts.id,
    cycleNumber: 1,
    createdAt: Date.now(),
    insight: opts.insight,
    proposedAction: opts.action,
    sourceId: `evo_${opts.id}`,
    status: "proposed",
    retryCount: 0,
  });
  saveLedger(ledger);
}

// Unparseable-by-translator wordings keyed by family. The translator
// returns `none` on all of these — so the only way they get rejected is
// via the new supersession path.
const UNPARSEABLE_BY_FAMILY = {
  synthesis: {
    id: "il_super_synthesis",
    insight: "synthesis cadence stagnating across the dream loop",
    action: "Investigate and synthesize the inflection signals across dream loops.",
  },
  artifact: {
    id: "il_super_artifact",
    insight: "artifact production cadence drifting",
    action: "Examine the artifact pipeline and produce something coherent.",
  },
  other: {
    id: "il_super_other",
    insight: "The agent should be wiser about its own knowledge.",
    action: "Be more thoughtful and intentional when adding knowledge.",
  },
};

describe("missingPrimitiveReconciler — supersession-on-coverage (PR #445)", () => {
  const SNAP = snapshotEnv();
  before(() => {
    wipeRecs();
    wipeLedger();
  });
  beforeEach(() => {
    __resetForTests();
    wipeRecs();
    wipeLedger();
    clearAllFlags();
  });
  after(() => {
    __resetForTests();
    wipeRecs();
    wipeLedger();
    restoreEnv(SNAP);
  });

  it("supersedes proposed rec when family is dispatch_capable (synthesis)", () => {
    turnAllGatesOn();
    registerSynthesisPrimitive();

    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    const before = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale rec from cycle 100",
      proposedChange: "Add a synthesis primitive.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
      evidence: ["evidence-a", "evidence-b"],
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(result.scanned, 1);
    assert.equal(result.reconciled, 1, "should be rejected");
    assert.equal(result.supersededByPrimitiveCoverage, 1);
    assert.deepEqual(result.supersededRecIds, [before.id]);
    assert.deepEqual(result.rejectedRecIds, [before.id]);
    assert.equal(result.stillUnparseable, 0);

    const after = getRecommendation(before.id)!;
    assert.equal(after.status, "rejected");
    assert.equal(after.approvedBy, "reconciler");
    assert.match(
      after.reviewNote ?? "",
      /Primitive family registered and lookup-hit.*primitive-fallback-rec.*synthesis/,
      "supersession note should record family + fallback semantics",
    );
    assert.match(after.reviewNote ?? "", /PR #445/, "note should reference PR");

    // Audit history preserved: original fields unchanged.
    assert.equal(after.id, before.id, "id preserved");
    assert.equal(after.createdAt, before.createdAt, "createdAt preserved");
    assert.equal(after.title, before.title, "title preserved");
    assert.equal(after.rationale, before.rationale, "rationale preserved");
    assert.equal(
      after.proposedChange,
      before.proposedChange,
      "proposedChange preserved",
    );
    assert.equal(
      after.sourceInsightId,
      before.sourceInsightId,
      "sourceInsightId preserved",
    );
    assert.equal(after.evidence, before.evidence, "evidence preserved");
  });

  it("supersedes all five registered families in a single pass", () => {
    turnAllGatesOn();
    registerSynthesisPrimitive();
    registerArtifactPrimitive();
    registerOtherPrimitive();
    registerArchivePrimitive();
    registerTtlPrimitive();

    const families: Array<{
      family: string;
      sourceInsightId: string;
    }> = [
      { family: "synthesis", sourceInsightId: "il_super_synthesis" },
      { family: "artifact", sourceInsightId: "il_super_artifact" },
      { family: "other", sourceInsightId: "il_super_other" },
      // archive / ttl: no ledger entry, supersede via title parsing.
      { family: "archive", sourceInsightId: "il_rotated_archive" },
      { family: "ttl", sourceInsightId: "il_rotated_ttl" },
    ];

    // Seed ledger entries only for the first three (the unparseable
    // fixtures); the last two simulate ledger-rotation.
    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.artifact);
    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.other);

    const recIds: string[] = [];
    for (const f of families) {
      const r = proposeRecommendation({
        category: "engine",
        title: `missing-primitive: ${f.family} family — action translator could not parse insight`,
        rationale: `stale rec for ${f.family}`,
        proposedChange: `Add a ${f.family} primitive.`,
        sourceInsightId: f.sourceInsightId,
        dedupeKey: `supersession-${f.family}`,
      });
      recIds.push(r.id);
    }

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(result.scanned, 5);
    assert.equal(result.reconciled, 5);
    assert.equal(result.supersededByPrimitiveCoverage, 5);
    assert.equal(result.stillUnparseable, 0);
    assert.equal(result.missingLedgerEntry, 0);
    for (const id of recIds) {
      assert.equal(
        getRecommendation(id)!.status,
        "rejected",
        `rec ${id} should be superseded`,
      );
    }
  });

  it("supersedes a rec whose ledger entry was rotated out (title-parsing path)", () => {
    turnAllGatesOn();
    registerArchivePrimitive();

    // NO seedLedgerEntry — simulates LEDGER_CAP rotation. Family is
    // parsed from the title.
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: archive family — action translator could not parse insight",
      rationale: "long-stale rec, ledger rotated out",
      proposedChange: "Add an archive primitive.",
      sourceInsightId: "il_rotated_out_archive",
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(result.supersededByPrimitiveCoverage, 1);
    assert.equal(result.missingLedgerEntry, 0, "supersession took precedence");
    assert.equal(getRecommendation(rec.id)!.status, "rejected");
    assert.match(getRecommendation(rec.id)!.reviewNote ?? "", /archive/);
  });

  it("leaves rec proposed when family is registered_only (gates OFF)", () => {
    // Synthesis primitive registered but master gates OFF: status is
    // `registered_only`, not `dispatch_capable`. The rec must remain
    // visible — the operator's gap is still real.
    registerSynthesisPrimitive();
    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(
      getRecommendation(rec.id)!.status,
      "proposed",
      "registered_only must NOT trigger supersession",
    );
    assert.equal(result.reconciled, 0);
    assert.equal(result.supersededByPrimitiveCoverage ?? 0, 0);
    assert.equal(result.stillUnparseable, 1);
  });

  it("leaves rec proposed when family is not_registered (Verification family)", () => {
    turnAllGatesOn();
    // NO register* call: no executor for `verification` family.
    seedLedgerEntry({
      id: "il_verif",
      insight: "verification scaffolding gap",
      action: "Be careful about verification edge cases somehow.",
    });
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: verification family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add verification primitive.",
      sourceInsightId: "il_verif",
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(
      getRecommendation(rec.id)!.status,
      "proposed",
      "not_registered family must remain active",
    );
    assert.equal(result.reconciled, 0);
    assert.equal(result.supersededByPrimitiveCoverage ?? 0, 0);
    assert.equal(result.stillUnparseable, 1);
  });

  it("default-off: gate flag OFF preserves pre-PR behavior (no supersession)", () => {
    // ALL gates ON, primitive registered → family is dispatch_capable —
    // but `supersedeOnDispatchCoverage` is unset/false, so the rec stays.
    turnAllGatesOn();
    registerSynthesisPrimitive();

    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
    });

    // Note: no `supersedeOnDispatchCoverage: true` here.
    const result = reconcileMissingPrimitiveRecs();

    assert.equal(
      getRecommendation(rec.id)!.status,
      "proposed",
      "default-off contract: dispatch_capable does NOT auto-reject",
    );
    assert.equal(result.reconciled, 0);
    assert.equal(result.supersededByPrimitiveCoverage ?? 0, 0);
    assert.equal(result.stillUnparseable, 1);
  });

  it("env flag enables supersession without the explicit option", () => {
    turnAllGatesOn();
    registerSynthesisPrimitive();
    process.env[MISSING_PRIMITIVE_SUPERSEDE_ON_COVERAGE_ENV] = "true";

    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
    });

    const result = reconcileMissingPrimitiveRecs();

    assert.equal(getRecommendation(rec.id)!.status, "rejected");
    assert.equal(result.supersededByPrimitiveCoverage, 1);
  });

  it("does NOT touch non-missing-primitive recs even when gates are ON", () => {
    turnAllGatesOn();
    registerSynthesisPrimitive();

    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    const operatorRec = proposeRecommendation({
      category: "engine",
      title: "Operator-drafted improvement plan",
      rationale: "Operator filed this.",
      proposedChange: "Tighten close-gate wiring.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(result.scanned, 0, "operator rec must not be scanned");
    assert.equal(result.reconciled, 0);
    assert.equal(result.supersededByPrimitiveCoverage ?? 0, 0);
    assert.equal(getRecommendation(operatorRec.id)!.status, "proposed");
  });

  it("unrelated proposed recs remain visible alongside superseded ones", () => {
    turnAllGatesOn();
    registerSynthesisPrimitive();

    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    const supersedable = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
    });
    const unrelated = proposeRecommendation({
      category: "config",
      title: "Unrelated proposal: tweak X",
      rationale: "operator opinion",
      proposedChange: "Tweak X",
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(getRecommendation(supersedable.id)!.status, "rejected");
    assert.equal(
      getRecommendation(unrelated.id)!.status,
      "proposed",
      "unrelated rec must remain visible",
    );
  });

  it("idempotent: second pass after supersession is a no-op", () => {
    turnAllGatesOn();
    registerSynthesisPrimitive();
    seedLedgerEntry(UNPARSEABLE_BY_FAMILY.synthesis);
    proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: UNPARSEABLE_BY_FAMILY.synthesis.id,
    });

    const first = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });
    assert.equal(first.reconciled, 1);
    assert.equal(first.supersededByPrimitiveCoverage, 1);

    const second = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });
    assert.equal(second.scanned, 0);
    assert.equal(second.reconciled, 0);
    assert.equal(second.supersededByPrimitiveCoverage ?? 0, 0);
  });

  it("translator-driven rejection (Pin 1) still works under supersession gate", () => {
    // Translator-translatable insight: existing path rejects, supersession
    // counter stays 0.
    seedLedgerEntry({
      id: "il_ttl_translatable",
      insight:
        "Two awaiting-deadline hypotheses are drifting without interim checkpoints.",
      action:
        "For both awaiting-deadline hypotheses, define 2 specific interim evidence checkpoints with dates and exact search queries. If no new evidence surfaces at the first checkpoint, downgrade to speculative",
    });
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: ttl family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add ttl primitive.",
      sourceInsightId: "il_ttl_translatable",
    });

    const result = reconcileMissingPrimitiveRecs({
      supersedeOnDispatchCoverage: true,
    });

    assert.equal(result.reconciled, 1);
    assert.equal(
      result.supersededByPrimitiveCoverage ?? 0,
      0,
      "translator path took precedence; supersession counter unchanged",
    );
    assert.equal(getRecommendation(rec.id)!.status, "rejected");
    assert.match(
      getRecommendation(rec.id)!.reviewNote ?? "",
      /translator now resolves/,
      "translator path note, not supersession note",
    );
  });
});
