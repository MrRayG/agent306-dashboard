/**
 * Self-Integrity primitive-coverage diagnostic tests.
 *
 * Companion to:
 *   - PR #429 (guarded executor invocation path + dispatcher telemetry)
 *   - PRs #423-#437 (synthesis/artifact/other scaffolds + Grammar v2.6)
 *
 * This suite pins the 5-state Self-Integrity classifier introduced by
 * the `feat(self-integrity): reflect dry-run primitive coverage` PR:
 *
 *   unsupported / registered / lookup_hit / dry_run_invoked /
 *   real_execution_pending
 *
 * Pins (covered below):
 *
 *   1. Classification correctness for each of the 5 states.
 *      - synthesis: gate state + telemetry combinations.
 *      - archive / ttl remain `unsupported` (no scaffold yet).
 *
 *   2. The report's `coveredFamilies` set only includes families at
 *      least `dry_run_invoked` — i.e. dry-run dispatch coverage shrinks
 *      the unsupported/missing diagnostic bucket but does NOT change
 *      lifecycle state of any rec.
 *
 *   3. `summarizeSelfIntegrityCoverage` always seeds the report with
 *      synthesis/artifact/other/archive/ttl so the diagnostic surface
 *      is honest about the May 27 production state (archive and ttl
 *      visible as `unsupported`) even when the registry is empty.
 *
 *   4. Existing self-recommendations are NOT auto-resolved or hidden:
 *      the missing-primitive reconciler's translator-driven lifecycle
 *      is unchanged by the diagnostic running. This is verified by
 *      running the reconciler with the Self-Integrity diagnostic
 *      computed alongside and asserting the rec stays `proposed`.
 *
 *   5. Default-off contract: with the master env flag unset, the
 *      public-API surface omits the `primitiveCoverage` block (no shape
 *      change for existing consumers). Verified by feature-detecting
 *      `isSelfIntegrityPrimitiveCoverageEnabled()`.
 *
 * Run:
 *   npx tsx --test server/__tests__/selfIntegrityPrimitiveCoverage.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "selfIntegrityCoverage-test-"),
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
const {
  __resetDispatchTelemetryForTests,
  recordDispatchTelemetry,
} = await import("../primitives/telemetry.js");
const {
  classifySelfIntegrityCoverageForFamily,
  summarizeSelfIntegrityCoverage,
  isSelfIntegrityPrimitiveCoverageEnabled,
  SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV,
} = await import("../primitives/selfIntegrityCoverage.js");

const ALL_ENV_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV,
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

function enableAllGates(): void {
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

describe("Self-Integrity primitive coverage — 5-state classification", () => {
  const SNAP = snapshotEnv();
  before(() => {
    wipeRecs();
    wipeLedger();
  });
  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    wipeRecs();
    wipeLedger();
    clearAllFlags();
  });
  after(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    wipeRecs();
    wipeLedger();
    restoreEnv(SNAP);
  });

  it("classifies as `unsupported` when no primitive is registered (archive, ttl)", () => {
    const archive = classifySelfIntegrityCoverageForFamily("archive");
    assert.equal(archive.status, "unsupported");
    assert.equal(archive.coarseStatus, "not_registered");
    assert.ok(/coverage gap is real/i.test(archive.explanation));

    const ttl = classifySelfIntegrityCoverageForFamily("ttl");
    assert.equal(ttl.status, "unsupported");
    assert.equal(ttl.coarseStatus, "not_registered");
  });

  it("classifies as `registered` when primitive is registered but gates OFF", () => {
    registerSynthesisPrimitive();
    const res = classifySelfIntegrityCoverageForFamily("synthesis");
    assert.equal(res.status, "registered");
    assert.equal(res.coarseStatus, "registered_only");
    assert.equal(res.gatesAllOn, false);
    assert.ok(res.primitiveId);
  });

  it("classifies as `lookup_hit` when gates ON but no telemetry observed", () => {
    enableAllGates();
    registerSynthesisPrimitive();
    const res = classifySelfIntegrityCoverageForFamily("synthesis", {
      telemetry: [],
    });
    assert.equal(res.status, "lookup_hit");
    assert.equal(res.coarseStatus, "dispatch_capable");
    assert.equal(res.gatesAllOn, true);
    assert.equal(res.observedAnyInvocation, false);
    assert.equal(res.observedDryRunOk, false);
  });

  it("classifies as `dry_run_invoked` when dispatcher telemetry shows ok+dryRun=true", () => {
    enableAllGates();
    registerSynthesisPrimitive();
    // Seed the dispatcher telemetry ring with a successful dry-run
    // outcome for the synthesis family. This is what the May 27 logs
    // actually show: dispatch_ok dryRun=true.
    recordDispatchTelemetry({
      kind: "ok",
      family: "synthesis",
      id: "scaffold",
      dryRun: true,
    });

    const res = classifySelfIntegrityCoverageForFamily("synthesis");
    assert.equal(res.status, "dry_run_invoked");
    assert.equal(res.observedDryRunOk, true);
    assert.ok(/dry-run/i.test(res.explanation));
  });

  it("archive scaffold flows through the same 5-state classification as synthesis (PR-archive-scaffold)", () => {
    // Default: archive has no registered primitive → unsupported.
    let res = classifySelfIntegrityCoverageForFamily("archive", {
      telemetry: [],
    });
    assert.equal(res.status, "unsupported");

    // Register archive but leave gates off → registered.
    registerArchivePrimitive();
    res = classifySelfIntegrityCoverageForFamily("archive", { telemetry: [] });
    assert.equal(res.status, "registered");
    assert.equal(res.gatesAllOn, false);

    // Flip all four gates ON, no telemetry yet → lookup_hit.
    enableAllGates();
    res = classifySelfIntegrityCoverageForFamily("archive", { telemetry: [] });
    assert.equal(res.status, "lookup_hit");
    assert.equal(res.gatesAllOn, true);

    // Record a dry-run ok in dispatcher telemetry → dry_run_invoked.
    recordDispatchTelemetry({
      kind: "ok",
      family: "archive",
      id: "scaffold",
      dryRun: true,
    });
    res = classifySelfIntegrityCoverageForFamily("archive");
    assert.equal(res.status, "dry_run_invoked");
    assert.equal(res.observedDryRunOk, true);
  });

  it("ttl scaffold flows through the same 5-state classification as archive (PR-ttl-scaffold)", () => {
    // Default: ttl has no registered primitive → unsupported. This is
    // the May 27 production state — `primitiveLookupMiss family=ttl`.
    let res = classifySelfIntegrityCoverageForFamily("ttl", {
      telemetry: [],
    });
    assert.equal(res.status, "unsupported");

    // Register ttl but leave gates off → registered.
    registerTtlPrimitive();
    res = classifySelfIntegrityCoverageForFamily("ttl", { telemetry: [] });
    assert.equal(res.status, "registered");
    assert.equal(res.gatesAllOn, false);

    // Flip all gates ON, no telemetry yet → lookup_hit.
    enableAllGates();
    res = classifySelfIntegrityCoverageForFamily("ttl", { telemetry: [] });
    assert.equal(res.status, "lookup_hit");
    assert.equal(res.gatesAllOn, true);

    // Record a dry-run ok in dispatcher telemetry → dry_run_invoked.
    recordDispatchTelemetry({
      kind: "ok",
      family: "ttl",
      id: "scaffold",
      dryRun: true,
    });
    res = classifySelfIntegrityCoverageForFamily("ttl");
    assert.equal(res.status, "dry_run_invoked");
    assert.equal(res.observedDryRunOk, true);
  });

  it("classifies as `real_execution_pending` when executor was reached outside dry-run", () => {
    enableAllGates();
    registerSynthesisPrimitive();
    // Simulate: the dispatcher reached the executor with dryRun=false
    // (the executor refuses, so the outcome is `refused`). The
    // diagnostic surfaces this as `real_execution_pending` — the next
    // step is a successful non-dry-run invocation.
    recordDispatchTelemetry({
      kind: "refused",
      family: "synthesis",
      id: "scaffold",
      dryRun: false,
      resultReason: "executor refuses non-dry-run",
    });

    const res = classifySelfIntegrityCoverageForFamily("synthesis");
    assert.equal(res.status, "real_execution_pending");
  });
});

describe("Self-Integrity primitive coverage — report aggregation", () => {
  const SNAP = snapshotEnv();
  before(() => {
    wipeRecs();
    wipeLedger();
  });
  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    wipeRecs();
    wipeLedger();
    clearAllFlags();
  });
  after(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    wipeRecs();
    wipeLedger();
    restoreEnv(SNAP);
  });

  it("always includes synthesis/artifact/other/archive/ttl in the seed set", () => {
    const report = summarizeSelfIntegrityCoverage({ telemetry: [] });
    const families = report.families.map((f) => f.family).sort();
    for (const seed of ["synthesis", "artifact", "other", "archive", "ttl"]) {
      assert.ok(
        families.includes(seed as any),
        `expected ${seed} in report.families`,
      );
    }
  });

  it("reports archive and ttl as unsupported when no archive/ttl primitive is registered", () => {
    enableAllGates();
    // Only the three pre-existing scaffolds are registered here; archive
    // and ttl remain unregistered → unsupported.
    registerSynthesisPrimitive();
    registerArtifactPrimitive();
    registerOtherPrimitive();

    const report = summarizeSelfIntegrityCoverage({ telemetry: [] });
    assert.ok(report.unsupportedFamilies.includes("archive"));
    assert.ok(report.unsupportedFamilies.includes("ttl"));
    // The three scaffolded families should NOT be in the unsupported set.
    assert.ok(!report.unsupportedFamilies.includes("synthesis"));
    assert.ok(!report.unsupportedFamilies.includes("artifact"));
    assert.ok(!report.unsupportedFamilies.includes("other"));
  });

  it("ttl leaves the unsupported bucket once registered (PR-ttl-scaffold)", () => {
    // Even with gates ON, archive/ttl remain unsupported until their
    // scaffolds register. Registering ttl should pull it out of the
    // unsupported set without affecting other families' classification.
    enableAllGates();
    registerSynthesisPrimitive();
    registerArtifactPrimitive();
    registerOtherPrimitive();

    const before = summarizeSelfIntegrityCoverage({ telemetry: [] });
    assert.ok(before.unsupportedFamilies.includes("ttl"));
    assert.ok(before.unsupportedFamilies.includes("archive"));

    registerTtlPrimitive();
    const after = summarizeSelfIntegrityCoverage({ telemetry: [] });
    assert.ok(!after.unsupportedFamilies.includes("ttl"));
    // archive still unregistered → unsupported.
    assert.ok(after.unsupportedFamilies.includes("archive"));
    // ttl is now in lookup_hit (gates ON but no telemetry observed).
    const ttlEntry = after.families.find((f) => f.family === "ttl");
    assert.ok(ttlEntry);
    assert.equal(ttlEntry!.status, "lookup_hit");
  });

  it("counts dry-run-invoked families in coveredFamilies; unsupported untouched", () => {
    enableAllGates();
    registerSynthesisPrimitive();
    registerArtifactPrimitive();
    registerOtherPrimitive();

    const report = summarizeSelfIntegrityCoverage({
      telemetry: [
        {
          timestampMs: Date.now(),
          kind: "ok",
          family: "synthesis",
          id: "scaffold",
          dryRun: true,
          source: "primitive-dispatcher",
        },
        {
          timestampMs: Date.now(),
          kind: "ok",
          family: "other",
          id: "scaffold",
          dryRun: true,
          source: "primitive-dispatcher",
        },
      ],
    });

    // synthesis + other should be in coveredFamilies (dry-run observed)
    assert.ok(report.coveredFamilies.includes("synthesis"));
    assert.ok(report.coveredFamilies.includes("other"));
    // artifact: gates ON, no telemetry → lookup_hit. NOT covered.
    assert.ok(!report.coveredFamilies.includes("artifact"));
    // archive / ttl unchanged.
    assert.ok(report.unsupportedFamilies.includes("archive"));
    assert.ok(report.unsupportedFamilies.includes("ttl"));

    // Bucket counts add up to families.length
    const sum =
      report.buckets.unsupported +
      report.buckets.registered +
      report.buckets.lookup_hit +
      report.buckets.dry_run_invoked +
      report.buckets.real_execution_pending;
    assert.equal(sum, report.families.length);
    assert.ok(report.buckets.dry_run_invoked >= 2);
    assert.ok(report.buckets.unsupported >= 2); // archive + ttl
  });

  it("dry-run coverage shrinks the unsupported bucket without ever closing recs", () => {
    enableAllGates();
    registerSynthesisPrimitive();

    // Pre-existing missing-primitive rec for synthesis (the May 27
    // pattern: lots of synthesis-family recs in the queue).
    const SYNTHESIS_UNPARSEABLE = {
      id: "il_synthesis_for_diag",
      insight: "synthesis cadence stagnating across the dream loop",
      proposedAction:
        "Investigate and synthesize the inflection signals across dream loops.",
      sourceId: "evo_synth_diag",
    };
    const ledger = loadLedger();
    ledger.entries.unshift({
      id: SYNTHESIS_UNPARSEABLE.id,
      cycleNumber: 1,
      createdAt: Date.now(),
      insight: SYNTHESIS_UNPARSEABLE.insight,
      proposedAction: SYNTHESIS_UNPARSEABLE.proposedAction,
      sourceId: SYNTHESIS_UNPARSEABLE.sourceId,
      status: "proposed",
      retryCount: 0,
    });
    saveLedger(ledger);

    const rec = proposeRecommendation({
      category: "engine",
      title:
        "missing-primitive: synthesis family — action translator could not parse insight",
      rationale: "stale",
      proposedChange: "Add synthesis.",
      sourceInsightId: SYNTHESIS_UNPARSEABLE.id,
    });

    // Dry-run dispatch observed for synthesis.
    recordDispatchTelemetry({
      kind: "ok",
      family: "synthesis",
      id: "scaffold",
      dryRun: true,
    });

    const report = summarizeSelfIntegrityCoverage();
    assert.ok(report.coveredFamilies.includes("synthesis"));

    // Run the reconciler too — it should not mutate the rec, because
    // the translator still can't parse the proposed action wording.
    const reconcilerResult = reconcileMissingPrimitiveRecs();
    assert.equal(reconcilerResult.stillUnparseable, 1);
    assert.equal(reconcilerResult.reconciled, 0);

    // The rec stays exactly where it was. The diagnostic did NOT
    // close, hide, approve, reject, or otherwise alter it.
    const after = getRecommendation(rec.id);
    assert.ok(after);
    assert.equal(
      after!.status,
      "proposed",
      "diagnostic must NEVER mutate a missing-primitive rec's status",
    );
  });
});

describe("Self-Integrity primitive coverage — default-off contract", () => {
  const SNAP = snapshotEnv();
  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
  });
  after(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("flag defaults OFF; turning ON makes it truthy", () => {
    assert.equal(isSelfIntegrityPrimitiveCoverageEnabled(), false);
    process.env[SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV] = "true";
    assert.equal(isSelfIntegrityPrimitiveCoverageEnabled(), true);
    delete process.env[SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV];
    assert.equal(isSelfIntegrityPrimitiveCoverageEnabled(), false);
    // Non-"true" values are OFF.
    process.env[SELF_INTEGRITY_PRIMITIVE_COVERAGE_ENABLED_ENV] = "1";
    assert.equal(isSelfIntegrityPrimitiveCoverageEnabled(), false);
  });
});
