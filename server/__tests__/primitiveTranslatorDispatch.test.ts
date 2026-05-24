/**
 * Translator-dispatch gate tests.
 *
 * Verifies the `PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED` flag, introduced in
 * the dispatch-gate PR (post-#427). Safety invariants under test:
 *
 *   1. With BOTH flags OFF (default deploy), `translateAction` output is
 *      byte-identical to pre-PR main for every fixture (synthesis,
 *      artifact, other fall-throughs + canonical translatable actions).
 *
 *   2. With the registry flag ON, primitives registered, but the
 *      dispatch flag OFF, output is STILL byte-identical to flag-OFF.
 *      This is the load-bearing assertion that gates registry rollout
 *      from dispatch rollout.
 *
 *   3. With BOTH flags ON and the synthesis/artifact/other primitives
 *      registered, the fall-through return additionally carries the
 *      `registeredPrimitive` metadata field — and `primitive` is STILL
 *      `"none"`, so the apply path treats the rec as untranslatable
 *      exactly as before.
 *
 *   4. Translatable actions (ratio / ttl) are unaffected by both flags.
 *
 *   5. Empty-action fast path is unaffected by both flags.
 *
 * Pin 7 / Pin 11 regression posture: the apply path keys off
 * `translation.primitive === "none"` to skip rule registration. As long
 * as the dispatch path preserves `primitive: "none"` on the
 * fall-through, applyRecommendation cannot widen behavior. That
 * invariant is asserted in every dispatch-ON case below.
 *
 * Run:
 *   npx tsx --test server/__tests__/primitiveTranslatorDispatch.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { translateAction, type TranslatedAction } from "../actionTranslator.js";
import {
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  isPrimitiveTranslatorDispatchEnabled,
} from "../primitives/registry.js";
import {
  registerSynthesisPrimitive,
  SYNTHESIS_PRIMITIVE_ID,
} from "../primitives/synthesis/index.js";
import {
  registerArtifactPrimitive,
  ARTIFACT_PRIMITIVE_ID,
} from "../primitives/artifact/index.js";
import {
  registerOtherPrimitive,
  OTHER_PRIMITIVE_ID,
} from "../primitives/other/index.js";

// Fixtures that fall through to `{ primitive: "none", ... }` today.
// Each is classified by the missing-primitive classifier into a known
// family so we can register exactly one matching executor and assert
// the metadata shows up.
const FALLTHROUGH_FIXTURES: ReadonlyArray<{
  label: string;
  action: string;
  insight: string;
  expectedFamily: "synthesis" | "artifact" | "other";
  expectedId: string;
}> = [
  {
    label: "synthesis family fall-through",
    action: "Promote a dream insight into a forming hypothesis via synthesis.",
    insight: "dream-loop synthesis cadence stagnating",
    expectedFamily: "synthesis",
    expectedId: SYNTHESIS_PRIMITIVE_ID,
  },
  {
    label: "artifact family fall-through",
    action: "Generate a post-confirmation synthesis paragraph for the briefing.",
    insight: "confirmation lacks narrative close-out",
    expectedFamily: "artifact",
    expectedId: ARTIFACT_PRIMITIVE_ID,
  },
  {
    label: "other family fall-through",
    action: "Tag every KB entry to an investigation thread.",
    insight: "threading layer absent across KB entries",
    expectedFamily: "other",
    expectedId: OTHER_PRIMITIVE_ID,
  },
];

const TRANSLATABLE_FIXTURES: ReadonlyArray<{
  label: string;
  action: string;
  insight: string;
  expectedPrimitive: string;
}> = [
  {
    label: "ratio_rule (canonical)",
    action: "For every 10 new knowledge entries, force-generate one synthesis",
    insight: "knowledge accumulation unsustainable",
    expectedPrimitive: "ratio_rule",
  },
  {
    label: "ttl_rule (hypothesis 14-day)",
    action:
      "Implement a strict 14-day TTL on testing hypotheses with no evidence movement",
    insight: "hypotheses piling up in testing",
    expectedPrimitive: "ttl_rule",
  },
];

function setFlags(opts: { registry?: boolean; dispatch?: boolean }): void {
  if (opts.registry) process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  else delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  if (opts.dispatch)
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  else delete process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];
}

function registerAllExecutors(): void {
  registerSynthesisPrimitive();
  registerArtifactPrimitive();
  registerOtherPrimitive();
}

describe("translator-dispatch gate — default-off byte-identical contract", () => {
  const ORIG_REGISTRY = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  const ORIG_DISPATCH = process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];

  beforeEach(() => {
    __resetForTests();
    setFlags({});
  });

  afterEach(() => {
    __resetForTests();
    if (ORIG_REGISTRY === undefined)
      delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    else process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = ORIG_REGISTRY;
    if (ORIG_DISPATCH === undefined)
      delete process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];
    else
      process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = ORIG_DISPATCH;
  });

  it("isPrimitiveTranslatorDispatchEnabled — default OFF", () => {
    setFlags({});
    assert.equal(isPrimitiveTranslatorDispatchEnabled(), false);
  });

  it("isPrimitiveTranslatorDispatchEnabled — flips on only with literal 'true'", () => {
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "1";
    assert.equal(isPrimitiveTranslatorDispatchEnabled(), false);
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "TRUE";
    assert.equal(isPrimitiveTranslatorDispatchEnabled(), false);
    process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
    assert.equal(isPrimitiveTranslatorDispatchEnabled(), true);
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`both flags OFF: ${fx.label} — no registeredPrimitive metadata`, () => {
      setFlags({});
      const r = translateAction(fx.action, fx.insight);
      assert.equal(r.primitive, "none");
      assert.equal(r.registeredPrimitive, undefined);
      assert.match(r.reason ?? "", /No primitive matched action/);
    });

    it(`registry ON, dispatch OFF: ${fx.label} — byte-identical to all-OFF`, () => {
      setFlags({});
      const off = translateAction(fx.action, fx.insight);

      // Now: registry on, executors registered, but dispatch OFF.
      __resetForTests();
      setFlags({ registry: true });
      registerAllExecutors();
      const onRegistryOnly = translateAction(fx.action, fx.insight);

      assert.deepEqual(
        onRegistryOnly,
        off,
        "registry-ON + dispatch-OFF must be byte-identical to all-OFF",
      );
      assert.equal(onRegistryOnly.registeredPrimitive, undefined);
    });

    it(`dispatch ON, registry OFF: ${fx.label} — byte-identical to all-OFF (master gates)`, () => {
      setFlags({});
      const off = translateAction(fx.action, fx.insight);

      __resetForTests();
      setFlags({ dispatch: true });
      // Even if a test were to register an executor here (we don't),
      // `lookupPrimitiveForFamily` short-circuits on the master flag.
      registerAllExecutors();
      const dispatchOnly = translateAction(fx.action, fx.insight);

      assert.deepEqual(
        dispatchOnly,
        off,
        "dispatch-ON + registry-OFF must be byte-identical (master flag gates lookup)",
      );
      assert.equal(dispatchOnly.registeredPrimitive, undefined);
    });
  }
});

describe("translator-dispatch gate — dispatch ON attaches metadata only", () => {
  const ORIG_REGISTRY = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  const ORIG_DISPATCH = process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];

  beforeEach(() => {
    __resetForTests();
    setFlags({ registry: true, dispatch: true });
    registerAllExecutors();
  });

  afterEach(() => {
    __resetForTests();
    if (ORIG_REGISTRY === undefined)
      delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    else process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = ORIG_REGISTRY;
    if (ORIG_DISPATCH === undefined)
      delete process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];
    else
      process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = ORIG_DISPATCH;
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`${fx.label}: primitive stays "none" and registeredPrimitive matches family`, () => {
      const r = translateAction(fx.action, fx.insight);

      // Apply-path invariant: primitive MUST remain "none" so
      // maybeRegisterRuleForRecommendation continues to skip with
      // `untranslatable`. This is the load-bearing Pin 7 / Pin 11
      // preservation assertion.
      assert.equal(r.primitive, "none");
      assert.match(r.reason ?? "", /No primitive matched action/);
      assert.deepEqual(r.params, {});
      assert.equal(r.verificationCriterion, "");

      assert.ok(
        r.registeredPrimitive,
        "registeredPrimitive metadata expected when dispatch ON + executor registered",
      );
      assert.equal(r.registeredPrimitive?.family, fx.expectedFamily);
      assert.equal(r.registeredPrimitive?.id, fx.expectedId);
      assert.ok(
        (r.registeredPrimitive?.description ?? "").length > 0,
        "description should be a non-empty operator-readable string",
      );
    });
  }

  it("fall-through with metadata is otherwise byte-identical to all-OFF (only registeredPrimitive added)", () => {
    const fx = FALLTHROUGH_FIXTURES[0];

    setFlags({});
    __resetForTests();
    const off = translateAction(fx.action, fx.insight);

    setFlags({ registry: true, dispatch: true });
    registerAllExecutors();
    const on = translateAction(fx.action, fx.insight);

    const { registeredPrimitive, ...onRest } = on;
    assert.ok(registeredPrimitive, "dispatch-ON should attach metadata");
    assert.deepEqual(
      onRest,
      off,
      "Only difference between dispatch-ON and all-OFF must be the registeredPrimitive metadata key",
    );
  });
});

describe("translator-dispatch gate — translatable actions never see the dispatch path", () => {
  const ORIG_REGISTRY = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  const ORIG_DISPATCH = process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];

  beforeEach(() => {
    __resetForTests();
    setFlags({});
  });

  afterEach(() => {
    __resetForTests();
    if (ORIG_REGISTRY === undefined)
      delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    else process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = ORIG_REGISTRY;
    if (ORIG_DISPATCH === undefined)
      delete process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];
    else
      process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = ORIG_DISPATCH;
  });

  for (const fx of TRANSLATABLE_FIXTURES) {
    it(`${fx.label} — unchanged across all flag combinations`, () => {
      const variants: Array<{ registry?: boolean; dispatch?: boolean }> = [
        {},
        { registry: true },
        { dispatch: true },
        { registry: true, dispatch: true },
      ];

      const results: TranslatedAction[] = variants.map((vf) => {
        __resetForTests();
        setFlags(vf);
        if (vf.registry) registerAllExecutors();
        return translateAction(fx.action, fx.insight);
      });

      for (const r of results) {
        assert.equal(r.primitive, fx.expectedPrimitive);
        assert.equal(
          r.registeredPrimitive,
          undefined,
          "translatable actions never carry registeredPrimitive metadata",
        );
      }
      // Translatable results must be deeply equal across all four
      // flag combinations.
      for (let i = 1; i < results.length; i++) {
        assert.deepEqual(
          results[i],
          results[0],
          `variant ${i} drifted from baseline for translatable action`,
        );
      }
    });
  }

  it("empty action fast path — never carries registeredPrimitive metadata", () => {
    for (const vf of [
      {},
      { registry: true },
      { dispatch: true },
      { registry: true, dispatch: true },
    ] as Array<{ registry?: boolean; dispatch?: boolean }>) {
      __resetForTests();
      setFlags(vf);
      if (vf.registry) registerAllExecutors();
      const r = translateAction("", "");
      assert.equal(r.primitive, "none");
      assert.equal(r.reason, "empty action");
      assert.equal(r.registeredPrimitive, undefined);
    }
  });
});

describe("translator-dispatch gate — registry empty but dispatch ON", () => {
  const ORIG_REGISTRY = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  const ORIG_DISPATCH = process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];

  beforeEach(() => {
    __resetForTests();
    setFlags({ registry: true, dispatch: true });
    // Intentionally NO executors registered.
  });

  afterEach(() => {
    __resetForTests();
    if (ORIG_REGISTRY === undefined)
      delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    else process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = ORIG_REGISTRY;
    if (ORIG_DISPATCH === undefined)
      delete process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV];
    else
      process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = ORIG_DISPATCH;
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`${fx.label} — no metadata when no executor is registered`, () => {
      const r = translateAction(fx.action, fx.insight);
      assert.equal(r.primitive, "none");
      assert.equal(
        r.registeredPrimitive,
        undefined,
        "empty registry must not surface registeredPrimitive even with dispatch ON",
      );
    });
  }
});
