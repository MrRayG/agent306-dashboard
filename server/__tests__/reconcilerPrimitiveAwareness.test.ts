/**
 * Missing-primitive reconciler — additive coverage diagnostic tests.
 *
 * Companion to PR #429 (guarded executor invocation path). The
 * reconciler grew an optional `primitiveCoverage` block: when
 * `PRIMITIVE_RECONCILER_AWARENESS_ENABLED === "true"` (or the
 * `opts.emitCoverageDiagnostic` override is set), the result describes
 * which families are now registered/dispatch-capable in the primitive
 * registry. The block is DESCRIPTIVE ONLY — it never causes a rec to
 * be rejected, approved, or otherwise transitioned.
 *
 * This suite pins:
 *
 *   1. Default-off: with the awareness flag unset, the reconciler's
 *      result is shape-compatible with the pre-PR contract — no
 *      `primitiveCoverage` field. (Pin 7 / Pin 11 paths untouched.)
 *
 *   2. With awareness ON and the synthesis primitive registered but
 *      gates OFF, the rec for the synthesis family is classified
 *      `registered_only`. The rec lifecycle is UNCHANGED — still
 *      `proposed`.
 *
 *   3. With awareness ON and synthesis registered + ALL gates ON, the
 *      rec for the synthesis family is classified `dispatch_capable`.
 *      The rec lifecycle is STILL `proposed` — translator drives
 *      lifecycle, not the coverage diagnostic.
 *
 *   4. Translator-driven lifecycle invariants (covered already by
 *      `missingPrimitiveReconciler.test.ts`) hold under awareness ON:
 *      translatable recs are rejected, untranslatable recs stay
 *      `proposed`, and the coverage block is additive.
 *
 *   5. Recs with no ledger entry still receive a coverage entry when
 *      the family can be parsed from the rec title.
 *
 *   6. The dispatcher's `applyRecommendation` / promotion-gate /
 *      obligation paths are not touched (verified by running the
 *      existing safety-gate test files unchanged — see
 *      `npm run test:safety`).
 *
 * Run:
 *   npx tsx --test server/__tests__/reconcilerPrimitiveAwareness.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "reconcilerAwareness-test-"),
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
const { reconcileMissingPrimitiveRecs } = await import(
  "../missingPrimitiveReconciler.js"
);
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
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} = await import("../primitives/dispatcher.js");
const {
  PRIMITIVE_RECONCILER_AWARENESS_ENABLED_ENV,
} = await import("../primitives/coverageDiagnostic.js");

const ALL_ENV_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_RECONCILER_AWARENESS_ENABLED_ENV,
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
  /** May be passed as `action` (test fixtures) or `proposedAction`. */
  action?: string;
  proposedAction?: string;
}) {
  const proposedAction = opts.proposedAction ?? opts.action;
  if (!proposedAction) {
    throw new Error("seedLedgerEntry: action/proposedAction required");
  }
  const ledger = loadLedger();
  ledger.entries.unshift({
    id: opts.id,
    cycleNumber: 1,
    createdAt: Date.now(),
    insight: opts.insight,
    proposedAction,
    sourceId: `evo_${opts.id}`,
    status: "proposed",
    retryCount: 0,
  });
  saveLedger(ledger);
}

// A wording that today's translator routes to the synthesis family but
// that is NOT actually translatable to a non-"none" primitive. We use
// it to force the reconciler to classify the family without rejecting
// the rec.
const SYNTHESIS_UNPARSEABLE = {
  id: "il_awareness_synthesis",
  // Synthesis-family wording (keyword "synthesize" classifies as
  // synthesis family) but it doesn't match any concrete translator
  // pattern — translator returns { primitive: "none" }.
  insight: "synthesis cadence stagnating across the dream loop",
  action: "Investigate and synthesize the inflection signals across dream loops.",
};

const OTHER_UNPARSEABLE = {
  id: "il_awareness_other",
  insight: "The agent should be wiser about its own knowledge.",
  action: "Be more thoughtful and intentional when adding knowledge.",
};

describe("reconciler-primitive-awareness — default-off shape", () => {
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

  it("default deploy: no primitiveCoverage field on the result", () => {
    seedLedgerEntry(OTHER_UNPARSEABLE);
    proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: other family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add other.",
      sourceInsightId: OTHER_UNPARSEABLE.id,
    });

    const result = reconcileMissingPrimitiveRecs();
    assert.equal(result.scanned, 1);
    assert.equal(result.stillUnparseable, 1);
    assert.equal(
      result.primitiveCoverage,
      undefined,
      "default-off contract: no coverage block",
    );
  });
});

describe("reconciler-primitive-awareness — classifies registered_only vs dispatch_capable", () => {
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

  it("registered_only: synthesis primitive registered but gates OFF", () => {
    // Register the synthesis primitive but leave the master gates OFF.
    registerSynthesisPrimitive();
    seedLedgerEntry(SYNTHESIS_UNPARSEABLE);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: SYNTHESIS_UNPARSEABLE.id,
    });

    const result = reconcileMissingPrimitiveRecs({
      emitCoverageDiagnostic: true,
    });

    // Lifecycle unchanged — still proposed.
    assert.equal(getRecommendation(rec.id)!.status, "proposed");
    assert.equal(result.reconciled, 0);
    assert.equal(result.stillUnparseable, 1);

    // Coverage block describes the world.
    assert.ok(result.primitiveCoverage, "coverage block present");
    assert.equal(result.primitiveCoverage!.familiesRegistered, 1);
    assert.equal(result.primitiveCoverage!.familiesDispatchCapable, 0);
    assert.equal(result.primitiveCoverage!.recPredicates.length, 1);
    assert.equal(result.primitiveCoverage!.recPredicates[0].recId, rec.id);
    assert.equal(
      result.primitiveCoverage!.recPredicates[0].status,
      "registered_only",
    );
    assert.equal(
      result.primitiveCoverage!.recPredicates[0].family,
      "synthesis",
    );
  });

  it("dispatch_capable: synthesis registered + ALL gates ON", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    registerSynthesisPrimitive();

    seedLedgerEntry(SYNTHESIS_UNPARSEABLE);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: SYNTHESIS_UNPARSEABLE.id,
    });

    const result = reconcileMissingPrimitiveRecs({
      emitCoverageDiagnostic: true,
    });

    // CRITICAL: the rec stays proposed. Coverage being dispatch_capable
    // does NOT cause the reconciler to act on the rec.
    assert.equal(
      getRecommendation(rec.id)!.status,
      "proposed",
      "dispatch_capable status MUST NOT auto-reject; translator drives lifecycle",
    );
    assert.equal(result.reconciled, 0);

    assert.ok(result.primitiveCoverage);
    assert.equal(result.primitiveCoverage!.familiesDispatchCapable, 1);
    assert.equal(
      result.primitiveCoverage!.recPredicates[0].status,
      "dispatch_capable",
    );
  });

  it("not_registered: family observed but no primitive registered", () => {
    seedLedgerEntry(OTHER_UNPARSEABLE);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: other family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add other.",
      sourceInsightId: OTHER_UNPARSEABLE.id,
    });

    const result = reconcileMissingPrimitiveRecs({
      emitCoverageDiagnostic: true,
    });

    assert.equal(getRecommendation(rec.id)!.status, "proposed");
    assert.ok(result.primitiveCoverage);
    assert.equal(result.primitiveCoverage!.familiesRegistered, 0);
    assert.equal(result.primitiveCoverage!.recPredicates[0].status, "not_registered");
    assert.equal(result.primitiveCoverage!.recPredicates[0].family, "other");
  });

  it("falls back to title parsing when the ledger entry is missing", () => {
    // No ledger entry seeded — simulates LEDGER_CAP rotation.
    registerArtifactPrimitive();
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: artifact family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add artifact.",
      sourceInsightId: "il_rotated_out_for_awareness",
    });

    const result = reconcileMissingPrimitiveRecs({
      emitCoverageDiagnostic: true,
    });

    // Lifecycle still says "missingLedgerEntry" — same as pre-PR.
    assert.equal(getRecommendation(rec.id)!.status, "proposed");
    assert.equal(result.missingLedgerEntry, 1);

    // Coverage block still classifies the rec via title parsing.
    assert.ok(result.primitiveCoverage);
    const pred = result.primitiveCoverage!.recPredicates.find(
      (r) => r.recId === rec.id,
    );
    assert.ok(pred, "rec predicate captured via title fallback");
    assert.equal(pred!.family, "artifact");
    // status is `registered_only` because gates are off but the
    // primitive is registered.
    assert.equal(pred!.status, "registered_only");
  });
});

describe("reconciler-primitive-awareness — lifecycle invariants hold under awareness ON", () => {
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

  it("translatable rec is still rejected by the reconciler (Pin 7/11 path unchanged)", () => {
    const TRANSLATABLE_TTL = {
      id: "il_awareness_ttl",
      insight:
        "Two awaiting-deadline hypotheses are drifting without interim checkpoints.",
      action:
        "For both awaiting-deadline hypotheses, define 2 specific interim evidence checkpoints with dates and exact search queries. If no new evidence surfaces at the first checkpoint, downgrade to speculative",
    };
    seedLedgerEntry(TRANSLATABLE_TTL);
    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: ttl family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add ttl.",
      sourceInsightId: TRANSLATABLE_TTL.id,
    });

    const result = reconcileMissingPrimitiveRecs({
      emitCoverageDiagnostic: true,
    });

    // Translator says "this is now resolvable" → rec is rejected by
    // the existing path. Coverage block is additive — it shows up
    // alongside but does NOT cause the rejection.
    assert.equal(result.reconciled, 1);
    assert.deepEqual(result.rejectedRecIds, [rec.id]);
    assert.equal(getRecommendation(rec.id)!.status, "rejected");
    assert.ok(result.primitiveCoverage, "coverage block still emitted");
  });

  it("awareness flag via env variable also enables the coverage block", () => {
    process.env[PRIMITIVE_RECONCILER_AWARENESS_ENABLED_ENV] = "true";
    seedLedgerEntry(OTHER_UNPARSEABLE);
    proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: other family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add other.",
      sourceInsightId: OTHER_UNPARSEABLE.id,
    });

    // No emitCoverageDiagnostic override; rely on the env flag.
    const result = reconcileMissingPrimitiveRecs();
    assert.ok(
      result.primitiveCoverage,
      "env flag must enable coverage emission",
    );
  });
});
