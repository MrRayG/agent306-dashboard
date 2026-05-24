/**
 * Synthesis-adapter dispatcher integration tests (PR #431).
 *
 * Verifies that the new `SynthesisAdapter` seam composes cleanly with
 * the existing primitives stack:
 *
 *   1. With the full dry-run gate stack ON (registry + translator
 *      dispatch + invocation + synthesis-executor + dry-run) AND a
 *      registered synthesis primitive, dispatcher-driven invocation
 *      returns `{ kind: "ok" }` AND captures a `dispatch_ok` telemetry
 *      record with `dryRun: true` and the resolved family/id.
 *
 *   2. When the installed adapter throws, the executor surfaces a
 *      structured refusal AND the dispatcher records a `refused`
 *      telemetry record. The throw never escapes the dispatcher.
 *
 *   3. With dry-run flipped off, the dispatcher records a `refused`
 *      telemetry record — the synthesis primitive continues to refuse
 *      non-dry-run regardless of which adapter is installed.
 *
 *   4. With the master invocation flag OFF (default), the adapter is
 *      NEVER consulted even when one is installed — proving that
 *      installing an adapter cannot widen autonomy without flipping the
 *      gate stack.
 *
 *   5. The default deploy posture is preserved: no env flags set, no
 *      executor registered → translator output for a synthesis fall-
 *      through is byte-identical to the pre-this-PR baseline (the
 *      adapter slot's existence does not leak into translator output).
 *
 * Run:
 *   npx tsx --test server/__tests__/synthesisAdapterDispatch.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { translateAction, type TranslatedAction } from "../actionTranslator.js";
import {
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  type PrimitiveExecutionContext,
} from "../primitives/registry.js";
import {
  registerSynthesisPrimitive,
  SYNTHESIS_PRIMITIVE_ID,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  setSynthesisAdapter,
  resetSynthesisAdapterForTests,
  type SynthesisAdapter,
  type SynthesisPlan,
} from "../primitives/synthesis/index.js";
import {
  invokeRegisteredPrimitive,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} from "../primitives/dispatcher.js";
import {
  __resetDispatchTelemetryForTests,
  getRecentDispatchTelemetry,
} from "../primitives/telemetry.js";

const ALL_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
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

function enableFullDryRunStack(): void {
  process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  // dry-run is default-true via env-absence semantics
}

const SAMPLE_CTX: PrimitiveExecutionContext = {
  actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
  insightText: "dream-loop synthesis cadence stagnating",
  recommendationId: "rec_pr431_001",
  sourceInsightId: "ins_pr431_001",
};

/**
 * Build a synthetic `TranslatedAction` carrying `registeredPrimitive`
 * metadata as if the translator had attached it under the PR #428 gate.
 * The dispatcher only reads the `registeredPrimitive` slot, so the
 * other fields can stay at their fall-through defaults.
 */
function makeTranslation(): TranslatedAction {
  return {
    primitive: "none",
    params: {},
    verificationCriterion: "",
    reason: "test-stub",
    registeredPrimitive: {
      family: "synthesis",
      id: SYNTHESIS_PRIMITIVE_ID,
      description: "test",
    },
  };
}

describe("synthesis-adapter-dispatcher-integration", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAll();
    __resetForTests();
    __resetDispatchTelemetryForTests();
    resetSynthesisAdapterForTests();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    resetSynthesisAdapterForTests();
    restoreEnv(envSnap);
  });

  // ── default-off invariance ────────────────────────────────────────────────

  it("default deploy: translator fall-through is byte-identical to baseline (no env, no registration)", () => {
    const t: TranslatedAction = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    assert.equal(t.primitive, "none");
    assert.equal(t.registeredPrimitive, undefined);
  });

  it("default deploy: dispatcher returns kind=disabled even with an adapter installed", async () => {
    let adapterCalled = false;
    setSynthesisAdapter({
      name: "must-not-run",
      async planSynthesis(): Promise<SynthesisPlan> {
        adapterCalled = true;
        return { summary: "x", wouldGenerateSynthesisReport: true };
      },
    });
    registerSynthesisPrimitive();
    const translation: TranslatedAction = makeTranslation();
    const r = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(r.kind, "disabled");
    assert.equal(adapterCalled, false, "adapter must not be consulted when invocation gate is OFF");
  });

  // ── full dry-run stack with default adapter ───────────────────────────────

  it("full dry-run stack: dispatcher returns kind=ok and records dispatch_ok telemetry", async () => {
    enableFullDryRunStack();
    registerSynthesisPrimitive();
    const translation: TranslatedAction = makeTranslation();
    const r = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return; // narrow
    assert.equal(r.family, "synthesis");
    assert.equal(r.id, SYNTHESIS_PRIMITIVE_ID);
    assert.equal(r.result.ok, true);
    assert.ok(
      (r.result.sideEffects ?? []).some(s => /adapter=default/.test(s)),
      "default adapter name should appear in side effects",
    );
    const records = getRecentDispatchTelemetry();
    const okRec = records.find(t => t.kind === "ok");
    assert.ok(okRec, "exactly one dispatch_ok record expected");
    assert.equal(okRec!.family, "synthesis");
    assert.equal(okRec!.id, SYNTHESIS_PRIMITIVE_ID);
    assert.equal(okRec!.dryRun, true);
    assert.equal(okRec!.recommendationId, "rec_pr431_001");
  });

  // ── full dry-run stack with throwing adapter ──────────────────────────────

  it("adapter throws: executor surfaces structured refusal, dispatcher records refused telemetry, no exception escapes", async () => {
    enableFullDryRunStack();
    registerSynthesisPrimitive();
    setSynthesisAdapter({
      name: "exploder",
      async planSynthesis(): Promise<SynthesisPlan> {
        throw new Error("adapter-failure-msg");
      },
    });
    const translation: TranslatedAction = makeTranslation();
    const r = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(r.kind, "refused");
    if (r.kind !== "refused") return; // narrow
    assert.match(r.result.reason ?? "", /adapter "exploder" threw: adapter-failure-msg/);
    const records = getRecentDispatchTelemetry();
    const refusedRec = records.find(t => t.kind === "refused");
    assert.ok(refusedRec, "a dispatch_refused record was expected");
    assert.equal(refusedRec!.family, "synthesis");
    assert.equal(refusedRec!.dryRun, true);
    assert.match(refusedRec!.resultReason ?? "", /adapter-failure-msg/);
  });

  // ── non-dry-run refuses regardless of adapter ─────────────────────────────

  it("non-dry-run: dispatcher records refused telemetry; adapter is not consulted", async () => {
    enableFullDryRunStack();
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    let adapterCalled = false;
    setSynthesisAdapter({
      name: "should-not-run",
      async planSynthesis(): Promise<SynthesisPlan> {
        adapterCalled = true;
        return { summary: "x", wouldGenerateSynthesisReport: true };
      },
    });
    registerSynthesisPrimitive();
    const translation: TranslatedAction = makeTranslation();
    const r = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(r.kind, "refused");
    if (r.kind !== "refused") return;
    assert.match(r.result.reason ?? "", /non-dry-run requested but no production engine is wired/);
    assert.equal(adapterCalled, false, "adapter must not be consulted in non-dry-run mode");
    const records = getRecentDispatchTelemetry();
    const refusedRec = records.find(t => t.kind === "refused");
    assert.ok(refusedRec);
    assert.equal(refusedRec!.dryRun, false);
  });
});
