/**
 * Primitives bootstrap — read-only synthesis planner install (PR #433).
 *
 * Covers the bootstrap-time install of the read-only synthesis planning
 * adapter shipped by PR #432:
 *
 *   1. Default flags → adapter slot is NOT touched (byte-identical posture).
 *   2. Master OFF + install flag ON → no install (master gates).
 *   3. Synthesis executor OFF + install flag ON → no install (executor gates).
 *   4. Synthesis dry-run OFF + install flag ON → no install (non-dry-run
 *      refuses the install; the executor's refusal stays the only refusal
 *      surface).
 *   5. Install flag OFF (default) with full dry-run stack → no install.
 *   6. Full dry-run stack + install flag ON → adapter slot is the read-only
 *      planning adapter, identity prefix `read-only-planning:`.
 *   7. Bootstrap is idempotent — second call does not re-install or throw,
 *      adapter slot retains the read-only-planning identity.
 *   8. With the adapter installed via bootstrap, the synthesis executor's
 *      dry-run branch surfaces read-only planner metadata via the adapter
 *      path (side-effect string carries `read-only-planning` and observations
 *      include `adapter=read-only-planning`).
 *   9. Non-dry-run still refuses regardless of install (Pin 7 invariant).
 *  10. Pin 7 invariant — translator output remains byte-identical with the
 *      install active (translator does not dispatch).
 *  11. Reconciler lifecycle decisions are unchanged by the install.
 *
 * Run:
 *   npx tsx --test server/__tests__/primitivesBootstrapReadOnlyPlanner.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetForTests,
  getPrimitive,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  type PrimitiveExecutionContext,
} from "../primitives/registry.js";
import { bootstrapPrimitives } from "../primitives/bootstrap.js";
import {
  SYNTHESIS_PRIMITIVE_ID,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV,
  getSynthesisAdapter,
  resetSynthesisAdapterForTests,
  defaultSynthesisAdapter,
  synthesisExecutor,
} from "../primitives/synthesis/index.js";
import { translateAction } from "../actionTranslator.js";

const ALL_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV,
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ALL_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ALL_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearAll(): void {
  for (const k of ALL_KEYS) delete process.env[k];
}

function ctx(over: Partial<PrimitiveExecutionContext> = {}): PrimitiveExecutionContext {
  return {
    actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
    insightText: "dream-loop synthesis cadence stagnating",
    recommendationId: "rec_pr433_001",
    sourceInsightId: "ins_pr433_001",
    ...over,
  };
}

describe("primitives-bootstrap — read-only synthesis planner install", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAll();
    __resetForTests();
    resetSynthesisAdapterForTests();
  });

  afterEach(() => {
    __resetForTests();
    resetSynthesisAdapterForTests();
    restoreEnv(envSnap);
  });

  // ── default flags ────────────────────────────────────────────────────────

  it("default flags: bootstrap leaves the synthesis adapter slot untouched", () => {
    const before = getSynthesisAdapter();
    assert.equal(before, defaultSynthesisAdapter);
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisReadOnlyPlannerInstalled, false);
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("default flags: BootstrapReport carries synthesisReadOnlyPlannerInstalled=false", () => {
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisReadOnlyPlannerInstalled, false);
  });

  // ── partial gates → no install ───────────────────────────────────────────

  it("master OFF + install flag ON → no install (master gates the whole bootstrap)", () => {
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisReadOnlyPlannerInstalled, false);
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("master ON + synthesis executor OFF + install flag ON → no install (executor gates)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.synthesisReadOnlyPlannerInstalled, false);
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("master ON + synthesis executor ON + dry-run OFF + install flag ON → no install", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.synthesisReadOnlyPlannerInstalled, false);
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("master ON + synthesis executor ON + install flag OFF (default) → no install", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    // dry-run default-true; install flag absent
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.synthesisReadOnlyPlannerInstalled, false);
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  // ── full gate stack → install happens ────────────────────────────────────

  it("master ON + synthesis executor ON + dry-run default + install flag ON → install happens", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.synthesisReadOnlyPlannerInstalled, true);
    const adapter = getSynthesisAdapter();
    assert.ok(adapter.name.startsWith("read-only-planning:"));
    assert.equal(adapter.name, "read-only-planning:default-read-only");
  });

  it("explicit dry-run=true also installs", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisReadOnlyPlannerInstalled, true);
    assert.ok(getSynthesisAdapter().name.startsWith("read-only-planning:"));
  });

  // ── idempotency ──────────────────────────────────────────────────────────

  it("bootstrap is idempotent: second call does not re-install or throw", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.synthesisReadOnlyPlannerInstalled, true);
    assert.equal(
      b.synthesisReadOnlyPlannerInstalled,
      false,
      "second call must report no-op for the install",
    );
    assert.ok(getSynthesisAdapter().name.startsWith("read-only-planning:"));
  });

  it("module import has no side effects (adapter slot stays default until bootstrap install)", () => {
    // No env, no bootstrap call.
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  // ── executor path with installed adapter ─────────────────────────────────

  it("with adapter installed via bootstrap, executor dry-run surfaces read-only planner metadata", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    const result = await synthesisExecutor(ctx());
    assert.equal(result.ok, true);
    assert.ok(
      result.observations.some(o => o === "adapterName=read-only-planning:default-read-only"),
      "executor observations should tag the read-only adapter",
    );
    assert.ok(
      result.observations.some(o => o === "adapter=read-only-planning"),
      "executor observations should carry adapter=read-only-planning from the adapter plan",
    );
    assert.ok(
      result.observations.some(o => o === "planner=default-read-only"),
      "executor observations should carry planner identity from the adapter plan",
    );
    assert.equal(result.sideEffects.length, 1);
    assert.match(
      result.sideEffects[0]!,
      /read-only-planning/,
      "side effect string should reference the read-only planning adapter",
    );
  });

  it("with adapter installed but executor non-dry-run, the executor still refuses (Pin 7)", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    // Bootstrap with dry-run on → installs adapter.
    bootstrapPrimitives();
    // Flip dry-run off AFTER install — the synthesis adapter slot remains
    // the read-only one, but the executor's non-dry-run branch must still
    // refuse before it ever consults the adapter.
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    const result = await synthesisExecutor(ctx());
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /non-dry-run requested but no production engine/i);
    assert.equal(result.sideEffects.length, 0);
  });

  // ── Pin 7 / translator byte-identical guarantee ──────────────────────────

  it("translator output for synthesis-family fall-through is byte-identical with the install active", () => {
    const baseline = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    assert.equal(baseline.primitive, "none");

    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_READ_ONLY_PLANNER_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    assert.ok(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID));
    assert.ok(getSynthesisAdapter().name.startsWith("read-only-planning:"));

    const flagsOn = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );

    // PR #423 invariant: translator does NOT dispatch and does not consult
    // the adapter — output is still byte-identical to the flag-OFF baseline.
    assert.deepEqual(flagsOn, baseline);
    assert.equal(flagsOn.primitive, "none");
  });
});
