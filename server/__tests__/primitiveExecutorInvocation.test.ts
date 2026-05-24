/**
 * Primitive executor invocation dispatcher tests.
 *
 * Verifies the new `PRIMITIVE_EXECUTOR_INVOCATION_ENABLED` flag and the
 * `invokeRegisteredPrimitive` dispatcher introduced in the follow-up to
 * PR #428 (controlled translator metadata dispatch). Safety invariants
 * under test:
 *
 *   1. With the invocation flag OFF (default), the dispatcher returns
 *      `{ kind: "disabled" }` and NEVER calls the executor — even when
 *      every other flag is ON and every primitive is registered.
 *
 *   2. With the registry + translator-dispatch flags ON but the
 *      invocation flag OFF, the dispatcher remains inert. This is the
 *      load-bearing assertion that gates dispatch-metadata rollout
 *      from invocation rollout.
 *
 *   3. With all three master flags ON, plus the family executor's
 *      own enabled flag ON, dispatch invokes the (dry-run) executor
 *      and returns `{ kind: "ok", ..., result: { ok: true, ... } }`.
 *
 *   4. Non-dry-run requests against the scaffold executors are
 *      surfaced as `{ kind: "refused" }`. The dispatcher does NOT
 *      re-write a refusal into an ok.
 *
 *   5. Translations without `registeredPrimitive` metadata, or with
 *      metadata pointing at an unknown (family, id) pair, are
 *      `{ kind: "skipped" }` — no throw, no executor call.
 *
 *   6. Executor exceptions are caught and surfaced as
 *      `{ kind: "error" }`. The dispatcher never throws.
 *
 *   7. With master flags ON but a family-level executor flag OFF, the
 *      dispatcher returns `{ kind: "skipped" }` for that family even
 *      though a primitive is registered.
 *
 * Regression posture: `translateAction` is invoked end-to-end across
 * the dispatcher-flag matrix and asserted byte-identical to the
 * pre-this-PR baseline — proving the dispatcher's existence does not
 * leak into translator output under any combination of new flags.
 *
 * Run:
 *   npx tsx --test server/__tests__/primitiveExecutorInvocation.test.ts
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
  isPrimitiveExecutorInvocationEnabled,
  isFamilyExecutorEnabled,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  FAMILY_ENABLED_ENV,
} from "../primitives/dispatcher.js";

// Fixtures match the translator-dispatch suite so we can re-use the
// same family classification logic from PR #428.
const FALLTHROUGH_FIXTURES: ReadonlyArray<{
  label: string;
  action: string;
  insight: string;
  family: "synthesis" | "artifact" | "other";
  id: string;
}> = [
  {
    label: "synthesis fall-through",
    action: "Promote a dream insight into a forming hypothesis via synthesis.",
    insight: "dream-loop synthesis cadence stagnating",
    family: "synthesis",
    id: SYNTHESIS_PRIMITIVE_ID,
  },
  {
    label: "artifact fall-through",
    action: "Generate a post-confirmation synthesis paragraph for the briefing.",
    insight: "confirmation lacks narrative close-out",
    family: "artifact",
    id: ARTIFACT_PRIMITIVE_ID,
  },
  {
    label: "other fall-through",
    action: "Tag every KB entry to an investigation thread.",
    insight: "threading layer absent across KB entries",
    family: "other",
    id: OTHER_PRIMITIVE_ID,
  },
];

const ALL_INVOCATION_ENV_KEYS = [
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
  for (const k of ALL_INVOCATION_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ALL_INVOCATION_ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearAllFlags(): void {
  for (const k of ALL_INVOCATION_ENV_KEYS) delete process.env[k];
}

function setMasterGates(opts: {
  registry?: boolean;
  dispatch?: boolean;
  invocation?: boolean;
}): void {
  if (opts.registry) process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  else delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  if (opts.dispatch)
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  else delete process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];
  if (opts.invocation)
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  else delete process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV];
}

function enableAllFamilies(): void {
  process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
}

function registerAllExecutors(): void {
  registerSynthesisPrimitive();
  registerArtifactPrimitive();
  registerOtherPrimitive();
}

const SAMPLE_CTX: PrimitiveExecutionContext = {
  actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
  insightText: "dream-loop synthesis cadence stagnating",
  recommendationId: "rec_test_001",
  sourceInsightId: "ins_test_001",
};

// ── flag-only contracts ──────────────────────────────────────────────────────

describe("primitive-executor-invocation — flag defaults & gating", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    restoreEnv(SNAP);
  });

  it("isPrimitiveExecutorInvocationEnabled defaults to false", () => {
    clearAllFlags();
    assert.equal(isPrimitiveExecutorInvocationEnabled(), false);
  });

  it("isPrimitiveExecutorInvocationEnabled flips only on literal 'true'", () => {
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "1";
    assert.equal(isPrimitiveExecutorInvocationEnabled(), false);
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "TRUE";
    assert.equal(isPrimitiveExecutorInvocationEnabled(), false);
    process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
    assert.equal(isPrimitiveExecutorInvocationEnabled(), true);
  });

  it("FAMILY_ENABLED_ENV is exhaustive over PrimitiveFamily and matches per-family modules", () => {
    assert.equal(
      FAMILY_ENABLED_ENV.synthesis,
      PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
    );
    assert.equal(
      FAMILY_ENABLED_ENV.artifact,
      PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
    );
    assert.equal(FAMILY_ENABLED_ENV.other, PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV);
  });

  it("isFamilyExecutorEnabled honours each family's env flag", () => {
    clearAllFlags();
    assert.equal(isFamilyExecutorEnabled("synthesis"), false);
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    assert.equal(isFamilyExecutorEnabled("synthesis"), true);
    assert.equal(isFamilyExecutorEnabled("artifact"), false);
  });
});

// ── dispatcher behavior with various gate states ─────────────────────────────

describe("primitive-executor-invocation — dispatcher gating", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    restoreEnv(SNAP);
  });

  it("ALL flags OFF, no executor registered: returns disabled (registry-flag reason)", async () => {
    let executorCalls = 0;
    const fakePrim: Primitive = {
      family: "synthesis",
      id: "fake",
      description: "test",
      execute: async () => {
        executorCalls += 1;
        return { ok: true };
      },
    };
    // Even with a primitive registered, the gates should prevent any call.
    setMasterGates({ registry: true });
    registerPrimitive(fakePrim);
    setMasterGates({}); // turn everything off again

    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: { family: "synthesis", id: "fake", description: "test" },
    };

    const result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(result.kind, "disabled");
    if (result.kind === "disabled") {
      assert.match(result.reason, /registry master flag is OFF/);
    }
    assert.equal(executorCalls, 0);
  });

  it("registry ON, dispatch ON, invocation OFF: returns disabled (invocation-flag reason) — INERT contract", async () => {
    setMasterGates({ registry: true, dispatch: true });
    enableAllFamilies();
    registerAllExecutors();

    // Construct a translation as the dispatcher-aware translator would
    // emit (carrying registeredPrimitive metadata).
    const translation = translateAction(
      FALLTHROUGH_FIXTURES[0].action,
      FALLTHROUGH_FIXTURES[0].insight,
    );
    assert.ok(translation.registeredPrimitive, "fixture must carry metadata");

    const result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(result.kind, "disabled");
    if (result.kind === "disabled") {
      assert.match(result.reason, /invocation flag is OFF/);
    }
  });

  it("registry ON, dispatch OFF, invocation ON: still disabled (dispatch-flag reason)", async () => {
    setMasterGates({ registry: true, invocation: true });
    enableAllFamilies();
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

    const result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(result.kind, "disabled");
    if (result.kind === "disabled") {
      assert.match(result.reason, /translator-dispatch flag is OFF/);
    }
  });

  it("all master flags ON but no registeredPrimitive metadata: returns skipped", async () => {
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    enableAllFamilies();
    registerAllExecutors();

    const noMeta: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      reason: "No primitive matched action: ...",
    };

    const result = await invokeRegisteredPrimitive(noMeta, SAMPLE_CTX);
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.match(result.reason, /no registeredPrimitive metadata/);
    }
  });

  it("all master flags ON, metadata names unknown id: returns skipped with family/id surfaced", async () => {
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    enableAllFamilies();
    registerAllExecutors();

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

    const result = await invokeRegisteredPrimitive(bogus, SAMPLE_CTX);
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.equal(result.family, "synthesis");
      assert.equal(result.id, "does-not-exist");
      assert.match(result.reason, /no primitive registered/);
    }
  });

  it("all master flags ON, family flag OFF: returns skipped with family-disabled reason", async () => {
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    // Deliberately do NOT enable family flags.
    registerAllExecutors();

    const translation = translateAction(
      FALLTHROUGH_FIXTURES[0].action,
      FALLTHROUGH_FIXTURES[0].insight,
    );
    assert.ok(translation.registeredPrimitive);

    const result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") {
      assert.equal(result.family, "synthesis");
      assert.match(result.reason, /family executor disabled/);
    }
  });
});

// ── ok / refused paths ───────────────────────────────────────────────────────

describe("primitive-executor-invocation — invokes registered scaffolds in dry-run", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    clearAllFlags();
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    enableAllFamilies();
    registerAllExecutors();
  });

  afterEach(() => {
    __resetForTests();
    restoreEnv(SNAP);
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`${fx.label}: dry-run executor returns ok with telemetry shape`, async () => {
      const translation = translateAction(fx.action, fx.insight);
      assert.ok(
        translation.registeredPrimitive,
        "translator must surface metadata under both flags ON",
      );

      const result = await invokeRegisteredPrimitive(translation, {
        ...SAMPLE_CTX,
        actionText: fx.action,
        insightText: fx.insight,
      });

      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        assert.equal(result.family, fx.family);
        assert.equal(result.id, fx.id);
        assert.equal(result.result.ok, true);
        assert.ok(result.result.observations);
        assert.ok(
          (result.result.observations ?? []).some((o) =>
            o.startsWith("family="),
          ),
          "executor should surface family= observation",
        );
        assert.ok(
          (result.result.observations ?? []).some((o) =>
            o.startsWith("dryRun="),
          ),
          "executor should surface dryRun= observation",
        );
        assert.ok(
          (result.result.sideEffects ?? []).some((s) =>
            s.includes("[dry-run]"),
          ),
          "dry-run executor should emit a [dry-run] sideEffect",
        );
      }
    });
  }
});

// ── non-dry-run refusal ──────────────────────────────────────────────────────

describe("primitive-executor-invocation — non-dry-run scaffold refusal is contained", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    clearAllFlags();
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    enableAllFamilies();
    // Force non-dry-run for every family. Scaffolds MUST refuse — they
    // have no production engine wired.
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "false";
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "false";
    registerAllExecutors();
  });

  afterEach(() => {
    __resetForTests();
    restoreEnv(SNAP);
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`${fx.label}: non-dry-run is surfaced as { kind: "refused" }`, async () => {
      const translation = translateAction(fx.action, fx.insight);
      assert.ok(translation.registeredPrimitive);

      const result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
      assert.equal(result.kind, "refused");
      if (result.kind === "refused") {
        assert.equal(result.family, fx.family);
        assert.equal(result.id, fx.id);
        assert.equal(result.result.ok, false);
        assert.match(
          result.result.reason ?? "",
          /non-dry-run requested but no production engine is wired/,
        );
      }
    });
  }
});

// ── error containment ───────────────────────────────────────────────────────

describe("primitive-executor-invocation — executor throws are contained", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    clearAllFlags();
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  });

  afterEach(() => {
    __resetForTests();
    restoreEnv(SNAP);
  });

  it("executor throw is caught and surfaced as { kind: 'error', ... }", async () => {
    const throwing: Primitive = {
      family: "synthesis",
      id: "throwing-test",
      description: "throws on execute",
      execute: async () => {
        throw new Error("boom-from-executor");
      },
    };
    registerPrimitive(throwing);

    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: "throwing-test",
        description: "throws on execute",
      },
    };

    let threw = false;
    let result;
    try {
      result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "dispatcher must not propagate executor throws");
    assert.ok(result);
    assert.equal(result!.kind, "error");
    if (result!.kind === "error") {
      assert.equal(result!.family, "synthesis");
      assert.equal(result!.id, "throwing-test");
      assert.match(result!.error, /boom-from-executor/);
    }
  });

  it("non-Error throw is stringified safely", async () => {
    const throwing: Primitive = {
      family: "synthesis",
      id: "throwing-test-2",
      description: "throws non-Error",
      execute: async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string-shaped-failure";
      },
    };
    registerPrimitive(throwing);

    const translation: TranslatedAction = {
      primitive: "none",
      params: {},
      verificationCriterion: "",
      registeredPrimitive: {
        family: "synthesis",
        id: "throwing-test-2",
        description: "throws non-Error",
      },
    };

    const result = await invokeRegisteredPrimitive(translation, SAMPLE_CTX);
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.match(result.error, /string-shaped-failure/);
    }
  });
});

// ── regression: translator output unaffected by the new flag ─────────────────

describe("primitive-executor-invocation — translator output unaffected by invocation flag", () => {
  const SNAP = snapshotEnv();

  beforeEach(() => {
    __resetForTests();
    clearAllFlags();
  });

  afterEach(() => {
    __resetForTests();
    restoreEnv(SNAP);
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`${fx.label}: translateAction byte-identical across invocation flag flips`, () => {
      // baseline: registry + dispatch ON, invocation OFF (the PR #428 default)
      setMasterGates({ registry: true, dispatch: true });
      enableAllFamilies();
      registerAllExecutors();
      const baseline = translateAction(fx.action, fx.insight);

      // now flip invocation ON
      __resetForTests();
      setMasterGates({ registry: true, dispatch: true, invocation: true });
      enableAllFamilies();
      registerAllExecutors();
      const withInvocationOn = translateAction(fx.action, fx.insight);

      assert.deepEqual(
        withInvocationOn,
        baseline,
        "invocation flag must NOT alter translator output",
      );
    });
  }

  it("fully-off baseline translator output is byte-identical to all-master-flags-ON-but-invocation-OFF for translatable actions", () => {
    // Translatable actions should never carry the metadata field, but
    // we still want to assert no other field drifts.
    const TRANSLATABLE = {
      action: "For every 10 new knowledge entries, force-generate one synthesis",
      insight: "knowledge accumulation unsustainable",
    };

    setMasterGates({});
    const off = translateAction(TRANSLATABLE.action, TRANSLATABLE.insight);

    __resetForTests();
    setMasterGates({ registry: true, dispatch: true, invocation: true });
    enableAllFamilies();
    registerAllExecutors();
    const on = translateAction(TRANSLATABLE.action, TRANSLATABLE.insight);

    assert.deepEqual(on, off, "translatable actions must be unaffected");
  });
});
