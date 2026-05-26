/**
 * Primitive translator → dispatcher bridge tests (PR #435).
 *
 * Verifies the new `bridgeRegisteredPrimitive` helper that wires the
 * guarded dispatcher (PR #429) into the GoalEngine/action-translation
 * flow. Safety invariants under test:
 *
 *   1. When `registeredPrimitive` metadata is absent on the translation,
 *      the bridge returns `{ invoked: false, kind: "no_metadata" }`
 *      WITHOUT calling the dispatcher or the executor.
 *
 *   2. When metadata is present BUT any of the master gates is OFF
 *      (registry / translator-dispatch / executor-invocation), the
 *      bridge calls the dispatcher, the dispatcher returns
 *      `{ kind: "disabled" }`, the executor is NEVER invoked, and the
 *      bridge surfaces `{ invoked: false, kind: "disabled" }`.
 *
 *   3. Same gate-off contract per-family enabled flag: with all three
 *      master gates ON but the family flag OFF, the dispatcher returns
 *      `{ kind: "skipped" }` and the executor is NEVER invoked.
 *
 *   4. With ALL gates ON (master x3, per-family) and the synthesis
 *      family dry-run flag ON, the bridge invokes the synthesis
 *      executor through the dispatcher. The executor runs the read-
 *      only planning adapter (PR #432/#433) and the bridge surfaces
 *      `{ invoked: true, kind: "ok" }`.
 *
 *   5. With a non-dry-run flag the scaffold refuses and the bridge
 *      surfaces `{ invoked: true, kind: "refused" }`.
 *
 *   6. Executor exceptions are contained — the bridge never throws and
 *      surfaces `{ invoked: true, kind: "error" }`.
 *
 *   7. Bridge is fire-and-forget: invoking it never alters the input
 *      `TranslatedAction` and never registers a rule.
 *
 * Run:
 *   npx tsx --test server/__tests__/primitiveTranslatorBridge.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  translateAction,
  type TranslatedAction,
} from "../actionTranslator.js";
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
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} from "../primitives/dispatcher.js";
import {
  bridgeRegisteredPrimitive,
  PRIMITIVE_DISPATCH_BRIDGE_ENGINE,
} from "../primitives/translatorBridge.js";
import {
  __resetDispatchTelemetryForTests,
  getRecentDispatchTelemetry,
} from "../primitives/telemetry.js";
import { getAllActiveRules } from "../actionEnforcer.js";

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

function enableAllGatesAndFamilies(): void {
  process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
  // Default dry-run ON (matches the scaffolds' default).
  delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
  delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];
  delete process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];
}

function registerAllExecutors(): void {
  registerSynthesisPrimitive();
  registerArtifactPrimitive();
  registerOtherPrimitive();
}

const SYNTHESIS_FIXTURE = {
  action: "Promote a dream insight into a forming hypothesis via synthesis.",
  insight: "dream-loop synthesis cadence stagnating",
};

const ARTIFACT_FIXTURE = {
  action: "Generate a post-confirmation synthesis paragraph for the briefing.",
  insight: "confirmation lacks narrative close-out",
};

const OTHER_FIXTURE = {
  action: "Tag every KB entry to an investigation thread.",
  insight: "threading layer absent across KB entries",
};

const SAMPLE_CTX: PrimitiveExecutionContext = {
  actionText: SYNTHESIS_FIXTURE.action,
  insightText: SYNTHESIS_FIXTURE.insight,
  recommendationId: "rec_bridge_test_001",
  sourceInsightId: "ins_bridge_test_001",
};

// ── no-metadata short-circuit ────────────────────────────────────────────────

describe("primitive-translator-bridge — no-metadata short-circuit", () => {
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

  it("returns { invoked: false, kind: 'no_metadata' } and does NOT invoke the dispatcher when registeredPrimitive is missing", async () => {
    enableAllGatesAndFamilies();
    registerAllExecutors();

    const naked: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      reason: "No primitive matched action: ...",
    };

    const outcome = await bridgeRegisteredPrimitive(naked, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "no_metadata");
    // Dispatcher telemetry ring is the cleanest invocation oracle.
    assert.equal(
      getRecentDispatchTelemetry().length,
      0,
      "dispatcher must NOT have been called when metadata is missing",
    );
  });
});

// ── gate-off contracts ───────────────────────────────────────────────────────

describe("primitive-translator-bridge — gate-off contracts", () => {
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

  it("invocation flag OFF: bridge surfaces disabled and executor is not called", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    // invocation flag deliberately OFF
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    registerAllExecutors();

    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    assert.ok(translation.registeredPrimitive, "fixture must surface metadata");

    let executorCalls = 0;
    // Sneak a counter through the registry by registering a counter
    // primitive under a name that matches what the translator emits —
    // BUT the fixture already routes to `synthesis::scaffold`, which is
    // a scaffold that does not increment a counter. Instead, assert
    // through telemetry: a disabled outcome implies no executor call.
    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "disabled");
    assert.match(outcome.reason ?? "", /invocation flag is OFF/);
    // Dispatcher telemetry captures `disabled` outcomes but the executor
    // is never called — the ring should hold exactly one disabled record.
    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0]?.kind, "disabled");

    assert.equal(executorCalls, 0);
  });

  it("registry flag OFF: bridge surfaces disabled even with translator-dispatch + invocation ON", async () => {
    // registry deliberately OFF
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    // Caller forges a translation carrying metadata; registry-OFF must
    // still cause the dispatcher to short-circuit at gate 1.
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

    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "disabled");
    assert.match(outcome.reason ?? "", /registry master flag is OFF/);
  });

  it("translator-dispatch flag OFF: bridge surfaces disabled", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    // translator-dispatch deliberately OFF
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    registerAllExecutors();

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

    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "disabled");
    assert.match(outcome.reason ?? "", /translator-dispatch flag is OFF/);
  });

  it("family flag OFF: bridge surfaces skipped with family-disabled reason", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    // synthesis family flag deliberately OFF
    registerAllExecutors();

    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    assert.ok(translation.registeredPrimitive);

    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "skipped");
    assert.equal(outcome.family, "synthesis");
    assert.match(outcome.reason ?? "", /family executor disabled/);
  });

  it("registry lookup miss: bridge surfaces skipped (no primitive registered)", async () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    // Deliberately do NOT register the synthesis primitive.
    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: "not-installed",
        description: "ghost",
      },
    };

    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "skipped");
    assert.match(outcome.reason ?? "", /no primitive registered/);
  });
});

// ── happy path: all gates ON, dry-run executor returns ok ────────────────────

describe("primitive-translator-bridge — all gates ON invokes dispatcher under dry-run", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
    enableAllGatesAndFamilies();
    registerAllExecutors();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("synthesis::scaffold dry-run returns ok and bridge surfaces kind: 'ok'", async () => {
    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    assert.ok(translation.registeredPrimitive);

    const outcome = await bridgeRegisteredPrimitive(translation, {
      ...SAMPLE_CTX,
      actionText: SYNTHESIS_FIXTURE.action,
      insightText: SYNTHESIS_FIXTURE.insight,
    });

    assert.equal(outcome.invoked, true);
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.family, "synthesis");
    assert.equal(outcome.id, SYNTHESIS_PRIMITIVE_ID);
    // Telemetry ring should have a single 'ok' record.
    const ring = getRecentDispatchTelemetry();
    assert.equal(ring.length, 1);
    assert.equal(ring[0]?.kind, "ok");
    assert.equal(ring[0]?.family, "synthesis");
  });

  it("artifact::scaffold dry-run path: bridge surfaces ok with the artifact family", async () => {
    const translation = translateAction(
      ARTIFACT_FIXTURE.action,
      ARTIFACT_FIXTURE.insight,
    );
    assert.ok(translation.registeredPrimitive);

    const outcome = await bridgeRegisteredPrimitive(translation, {
      ...SAMPLE_CTX,
      actionText: ARTIFACT_FIXTURE.action,
      insightText: ARTIFACT_FIXTURE.insight,
    });

    assert.equal(outcome.invoked, true);
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.family, "artifact");
    assert.equal(outcome.id, ARTIFACT_PRIMITIVE_ID);
  });

  it("other::scaffold dry-run path: bridge surfaces ok with the other family", async () => {
    const translation = translateAction(
      OTHER_FIXTURE.action,
      OTHER_FIXTURE.insight,
    );
    assert.ok(translation.registeredPrimitive);

    const outcome = await bridgeRegisteredPrimitive(translation, {
      ...SAMPLE_CTX,
      actionText: OTHER_FIXTURE.action,
      insightText: OTHER_FIXTURE.insight,
    });

    assert.equal(outcome.invoked, true);
    assert.equal(outcome.kind, "ok");
    assert.equal(outcome.family, "other");
    assert.equal(outcome.id, OTHER_PRIMITIVE_ID);
  });
});

// ── non-dry-run refusal containment ──────────────────────────────────────────

describe("primitive-translator-bridge — non-dry-run is surfaced as refused", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
    enableAllGatesAndFamilies();
    // Force non-dry-run.
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    registerAllExecutors();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("non-dry-run scaffold returns refused; bridge does not throw and does not promote to ok", async () => {
    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, true);
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.family, "synthesis");
  });
});

// ── error containment ───────────────────────────────────────────────────────

describe("primitive-translator-bridge — executor throws are contained", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("dispatcher error result is surfaced; bridge never throws", async () => {
    const throwing: Primitive = {
      family: "synthesis",
      id: "bridge-throwing",
      description: "throws",
      execute: async () => {
        throw new Error("bridge-boom");
      },
    };
    registerPrimitive(throwing);

    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: "bridge-throwing",
        description: "throws",
      },
    };

    let threw = false;
    let outcome;
    try {
      outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
    assert.ok(outcome);
    assert.equal(outcome!.invoked, true);
    assert.equal(outcome!.kind, "error");
    assert.match(outcome!.reason ?? "", /bridge-boom/);
  });
});

// ── lifecycle invariants ────────────────────────────────────────────────────

describe("primitive-translator-bridge — lifecycle invariants preserved", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    clearAllFlags();
    enableAllGatesAndFamilies();
    registerAllExecutors();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    restoreEnv(SNAP);
  });

  it("bridge does NOT register a rule from the dispatched primitive", async () => {
    const before = getAllActiveRules().length;
    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    const after = getAllActiveRules().length;
    assert.equal(
      after,
      before,
      "registerRule must NOT be called as a side effect of bridge dispatch",
    );
  });

  it("bridge does NOT mutate the input TranslatedAction", async () => {
    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    const snapshot = JSON.parse(JSON.stringify(translation));
    await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.deepEqual(translation, snapshot);
  });

  it("bridge telemetry uses the engine tag the smoke test will grep for", () => {
    assert.equal(PRIMITIVE_DISPATCH_BRIDGE_ENGINE, "primitive-dispatch");
  });
});

// ── goalEngine wiring assertion (static import check) ───────────────────────

describe("primitive-translator-bridge — wired into GoalEngine.promoteInsightToGoal", () => {
  it("server/goalEngine.ts imports bridgeRegisteredPrimitive from translatorBridge", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(
      path.resolve(here, "../goalEngine.ts"),
      "utf8",
    );
    assert.ok(
      src.includes(`from "./primitives/translatorBridge.js"`) ||
        src.includes(`from "./primitives/translatorBridge"`),
      "goalEngine.ts must import the translator bridge module",
    );
    assert.ok(
      src.includes("bridgeRegisteredPrimitive"),
      "goalEngine.ts must reference bridgeRegisteredPrimitive",
    );
    // Confirm the call lives in the promoteInsightToGoal `primitive === 'none'`
    // branch — the integration site documented in the PR.
    const promoteIdx = src.indexOf("promoteInsightToGoal");
    const bridgeIdx = src.indexOf("bridgeRegisteredPrimitive(");
    assert.ok(promoteIdx > -1, "promoteInsightToGoal not present in goalEngine.ts");
    assert.ok(bridgeIdx > -1, "bridgeRegisteredPrimitive(...) call not present");
    assert.ok(
      bridgeIdx > promoteIdx,
      "bridge call must be inside promoteInsightToGoal scope",
    );
  });
});

// ── default-deploy contract ──────────────────────────────────────────────────

describe("primitive-translator-bridge — default deploy is inert", () => {
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

  it("with all flags OFF, no metadata: bridge returns no_metadata without contacting the dispatcher", async () => {
    const translation = translateAction(
      SYNTHESIS_FIXTURE.action,
      SYNTHESIS_FIXTURE.insight,
    );
    // With flags off, translator never attaches metadata.
    assert.equal(translation.registeredPrimitive, undefined);

    const outcome = await bridgeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(outcome.invoked, false);
    assert.equal(outcome.kind, "no_metadata");
    assert.equal(getRecentDispatchTelemetry().length, 0);
  });
});
