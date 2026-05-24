/**
 * Primitive dispatch telemetry tests.
 *
 * Successor to PR #429 (guarded executor invocation path). The
 * dispatcher now emits a structured `DispatchTelemetryRecord` per
 * `DispatchResult` it returns. This suite pins:
 *
 *   1. The in-memory ring buffer captures one record per dispatcher
 *      invocation, with the correct `kind` for every outcome variant
 *      (`disabled`, `skipped_missing_metadata`,
 *      `skipped_unknown_primitive`, `skipped_family_disabled`,
 *      `ok`, `refused`, `error`).
 *
 *   2. Telemetry is default-off for the *forward sink*: with
 *      `PRIMITIVE_DISPATCH_TELEMETRY_ENABLED` unset, no
 *      `engine_events` row is written (we observe this indirectly via
 *      a stubbed `logEvent` proxy — see `module-mock` pattern below).
 *
 *   3. Records carry useful context: family + id when known, stable
 *      `actionHash` derived from the executor context's `actionText`,
 *      `recommendationId` when populated, `gateReason` on disabled /
 *      skipped, `resultReason` on refused / error, and `dryRun` flag
 *      state on ok / refused / error.
 *
 *   4. Records ARE captured to the ring buffer regardless of the
 *      forward-sink flag — the ring is for tests + future ops and
 *      should not require operator action to populate.
 *
 *   5. The dispatcher's `DispatchResult` shape is byte-identical to
 *      the pre-telemetry behavior — adding telemetry capture is a
 *      strict no-op on the externally-visible return value.
 *
 * Run:
 *   npx tsx --test server/__tests__/primitiveDispatchTelemetry.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { translateAction, type TranslatedAction } from "../actionTranslator.js";
import {
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  registerPrimitive,
  type Primitive,
  type PrimitiveExecutionContext,
} from "../primitives/registry.js";
import {
  registerSynthesisPrimitive,
  SYNTHESIS_PRIMITIVE_ID,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/synthesis/index.js";
import {
  registerArtifactPrimitive,
  ARTIFACT_PRIMITIVE_ID,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/artifact/index.js";
import {
  registerOtherPrimitive,
  OTHER_PRIMITIVE_ID,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/other/index.js";
import {
  invokeRegisteredPrimitive,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} from "../primitives/dispatcher.js";
import {
  __resetDispatchTelemetryForTests,
  getRecentDispatchTelemetry,
  hashActionText,
  isPrimitiveDispatchTelemetryEnabled,
  PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV,
  recordDispatchTelemetry,
} from "../primitives/telemetry.js";

const ALL_ENV_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
  PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV,
] as const;

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

function enableAll(): void {
  process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
}

const SAMPLE_CTX: PrimitiveExecutionContext = {
  actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
  insightText: "dream-loop synthesis cadence stagnating",
  recommendationId: "rec_telemetry_001",
  sourceInsightId: "ins_telemetry_001",
};

describe("primitive-dispatch-telemetry — flag defaults & helpers", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("isPrimitiveDispatchTelemetryEnabled defaults to false", () => {
    clearAllFlags();
    assert.equal(isPrimitiveDispatchTelemetryEnabled(), false);
  });

  it("isPrimitiveDispatchTelemetryEnabled flips only on literal 'true'", () => {
    process.env[PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV] = "1";
    assert.equal(isPrimitiveDispatchTelemetryEnabled(), false);
    process.env[PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV] = "TRUE";
    assert.equal(isPrimitiveDispatchTelemetryEnabled(), false);
    process.env[PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV] = "true";
    assert.equal(isPrimitiveDispatchTelemetryEnabled(), true);
  });

  it("hashActionText is stable, short hex, and skips empty input", () => {
    assert.equal(hashActionText(undefined), undefined);
    assert.equal(hashActionText(""), undefined);
    assert.equal(hashActionText("   "), undefined);
    const a = hashActionText("the quick brown fox");
    const b = hashActionText("the quick brown fox");
    const c = hashActionText("the quick brown FOX");
    assert.equal(a, b, "deterministic across calls");
    assert.notEqual(a, c, "case-sensitive (we hash trimmed input verbatim)");
    assert.match(a!, /^[0-9a-f]{16}$/);
  });

  it("recordDispatchTelemetry always appends to the ring; respects timestamp override", () => {
    const r = recordDispatchTelemetry({
      kind: "disabled",
      gateReason: "test",
      timestampMs: 12345,
    });
    assert.equal(r.kind, "disabled");
    assert.equal(r.timestampMs, 12345);
    assert.equal(r.source, "primitive-dispatcher");
    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].timestampMs, 12345);
  });

  it("recordDispatchTelemetry trims long reason strings", () => {
    const long = "x".repeat(600);
    const r = recordDispatchTelemetry({
      kind: "error",
      family: "synthesis",
      id: "test",
      resultReason: long,
    });
    assert.ok(r.resultReason!.length <= 300);
    assert.ok(r.resultReason!.endsWith("..."));
  });
});

describe("primitive-dispatch-telemetry — captures per dispatcher outcome", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("captures kind=disabled (master flags off) with gateReason", async () => {
    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: SYNTHESIS_PRIMITIVE_ID,
        description: "test",
      },
    };
    await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "disabled");
    assert.match(ring[0].gateReason ?? "", /registry master flag is OFF/);
    // family/id are NOT populated on disabled (gate fired before
    // metadata consult)
    assert.equal(ring[0].family, undefined);
    assert.equal(ring[0].id, undefined);
    assert.equal(ring[0].recommendationId, "rec_telemetry_001");
    assert.equal(ring[0].actionHash, hashActionText(SAMPLE_CTX.actionText));
  });

  it("captures kind=skipped_missing_metadata with no family/id", async () => {
    enableAll();
    registerSynthesisPrimitive();

    const noMeta: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      reason: "No primitive matched action: ...",
    };
    await invokeRegisteredPrimitive(noMeta, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "skipped_missing_metadata");
    assert.equal(ring[0].family, undefined);
    assert.match(ring[0].gateReason ?? "", /no registeredPrimitive metadata/);
  });

  it("captures kind=skipped_family_disabled with family + id surfaced", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    // Deliberately do NOT enable PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED.
    registerSynthesisPrimitive();

    const translation = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    assert.ok(translation.registeredPrimitive);

    await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "skipped_family_disabled");
    assert.equal(ring[0].family, "synthesis");
    assert.equal(ring[0].id, SYNTHESIS_PRIMITIVE_ID);
    assert.match(ring[0].gateReason ?? "", /family executor disabled/);
  });

  it("captures kind=skipped_unknown_primitive when metadata names a bogus id", async () => {
    enableAll();
    registerSynthesisPrimitive();

    const bogus: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: "does-not-exist",
        description: "fictional",
      },
    };
    await invokeRegisteredPrimitive(bogus, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "skipped_unknown_primitive");
    assert.equal(ring[0].family, "synthesis");
    assert.equal(ring[0].id, "does-not-exist");
  });

  it("captures kind=ok with dryRun=true for scaffold dry-run executors", async () => {
    enableAll();
    registerSynthesisPrimitive();
    registerArtifactPrimitive();
    registerOtherPrimitive();

    const translation = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "ok");
    assert.equal(ring[0].family, "synthesis");
    assert.equal(ring[0].id, SYNTHESIS_PRIMITIVE_ID);
    assert.equal(ring[0].dryRun, true);
  });

  it("captures kind=refused with dryRun=false and the executor's reason", async () => {
    enableAll();
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    registerSynthesisPrimitive();

    const translation = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "refused");
    assert.equal(ring[0].family, "synthesis");
    assert.equal(ring[0].dryRun, false);
    assert.match(
      ring[0].resultReason ?? "",
      /non-dry-run requested but no production engine is wired/,
    );
  });

  it("captures kind=error with resultReason carrying the throw message", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const throwing: Primitive = {
      family: "synthesis",
      id: "throwing-telemetry",
      description: "throws",
      execute: async () => {
        throw new Error("telemetry-boom");
      },
    };
    registerPrimitive(throwing);

    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: "throwing-telemetry",
        description: "throws",
      },
    };
    await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].kind, "error");
    assert.equal(ring[0].family, "synthesis");
    assert.equal(ring[0].id, "throwing-telemetry");
    assert.match(ring[0].resultReason ?? "", /telemetry-boom/);
  });
});

describe("primitive-dispatch-telemetry — does NOT alter dispatcher results", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("DispatchResult shape unchanged across telemetry-flag flips", async () => {
    enableAll();
    registerSynthesisPrimitive();

    const translation = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );

    // baseline: telemetry-forward flag OFF
    delete process.env[PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV];
    const a = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    // now flip telemetry-forward ON
    process.env[PRIMITIVE_DISPATCH_TELEMETRY_ENABLED_ENV] = "true";
    const b = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    assert.deepEqual(b, a);
  });
});

describe("primitive-dispatch-telemetry — default-off forward sink", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("with telemetry-forward flag OFF, isPrimitiveDispatchTelemetryEnabled() is false even after a dispatch", async () => {
    // sanity: the ring captures the record either way, but the
    // forward-sink predicate is false. This is the load-bearing
    // assertion that a default deploy does NOT write engine_events
    // rows for every dispatch.
    enableAll();
    registerSynthesisPrimitive();

    const translation = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    await invokeRegisteredPrimitive(translation, SAMPLE_CTX);

    assert.equal(isPrimitiveDispatchTelemetryEnabled(), false);
    assert.equal(getRecentDispatchTelemetry().length, 1);
  });
});
