/**
 * PR #422 — primitive-registry / action-translator integration test.
 *
 * Safety guarantee under test: with the registry empty (today's state),
 * the action translator's output is byte-identical regardless of
 * PRIMITIVE_REGISTRY_ENABLED. This is the load-bearing invariant for
 * shipping the scaffolding PR ahead of any executor: nothing in the
 * apply path can drift between the flag-OFF and flag-ON case until a
 * primitive is actually registered.
 *
 * Run: npx tsx --test server/__tests__/primitiveRegistryTranslatorIntegration.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { translateAction, type TranslatedAction } from "../actionTranslator.js";
import {
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
} from "../primitives/registry.js";

// Action strings that today fall through to `{ primitive: "none", ... }`.
// These are exactly the shapes the May 24 auto-cycle missing-primitive
// recs surfaced (synthesis / artifact / other). They MUST continue to
// fall through after PR #422 — that is the byte-identical guarantee.
const FALLTHROUGH_FIXTURES: ReadonlyArray<{
  label: string;
  action: string;
  insight: string;
}> = [
  {
    label: "synthesis family — promote dream insight to forming hypothesis",
    action: "Promote a dream insight into a forming hypothesis via synthesis.",
    insight: "dream-loop synthesis cadence stagnating",
  },
  {
    label: "artifact family — post-confirmation synthesis paragraph",
    action: "Generate a post-confirmation synthesis paragraph for the briefing.",
    insight: "confirmation lacks narrative close-out",
  },
  {
    label: "other family — tag every KB entry to investigation thread",
    action: "Tag every KB entry to an investigation thread.",
    insight: "threading layer absent across KB entries",
  },
];

// Action strings that DO translate to a real primitive today. These also
// MUST be byte-identical — the registry lookup happens only on the
// fall-through path, so these should never touch the new code at all.
const TRANSLATABLE_FIXTURES: ReadonlyArray<{
  label: string;
  action: string;
  insight: string;
  expectedPrimitive: string;
}> = [
  {
    label: "canonical ratio rule",
    action: "For every 10 new knowledge entries, force-generate one synthesis",
    insight: "knowledge accumulation unsustainable",
    expectedPrimitive: "ratio_rule",
  },
  {
    label: "ttl rule on hypotheses",
    action: "Implement a strict 14-day TTL on testing hypotheses with no evidence movement",
    insight: "hypotheses piling up in testing",
    expectedPrimitive: "ttl_rule",
  },
];

function callTranslateWithFlag(
  flag: "off" | "on",
  action: string,
  insight: string,
): TranslatedAction {
  if (flag === "on") {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  } else {
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  }
  return translateAction(action, insight);
}

describe("PR #422 — primitive registry / translator integration", () => {
  const ORIGINAL_FLAG = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];

  beforeEach(() => {
    __resetForTests();
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  });

  afterEach(() => {
    __resetForTests();
    if (ORIGINAL_FLAG === undefined) {
      delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    } else {
      process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = ORIGINAL_FLAG;
    }
  });

  for (const fx of FALLTHROUGH_FIXTURES) {
    it(`flag-OFF: ${fx.label} still falls through to { primitive: "none" }`, () => {
      const r = callTranslateWithFlag("off", fx.action, fx.insight);
      assert.equal(r.primitive, "none");
      assert.match(r.reason ?? "", /No primitive matched action/);
    });

    it(`flag-ON empty-registry: ${fx.label} returns the SAME TranslatedAction as flag-OFF`, () => {
      const off = callTranslateWithFlag("off", fx.action, fx.insight);
      const on = callTranslateWithFlag("on", fx.action, fx.insight);
      assert.deepEqual(on, off, "flag-ON output must match flag-OFF byte-for-byte");
      assert.equal(on.primitive, "none");
    });
  }

  for (const fx of TRANSLATABLE_FIXTURES) {
    it(`flag-ON: ${fx.label} still translates to ${fx.expectedPrimitive} (registry is not consulted on the success path)`, () => {
      const off = callTranslateWithFlag("off", fx.action, fx.insight);
      const on = callTranslateWithFlag("on", fx.action, fx.insight);
      assert.equal(off.primitive, fx.expectedPrimitive);
      assert.equal(on.primitive, fx.expectedPrimitive);
      assert.deepEqual(on, off, "translatable actions must be unchanged by the registry flag");
    });
  }

  it("flag-OFF: empty action input — same fast path as before", () => {
    const r = callTranslateWithFlag("off", "", "");
    assert.equal(r.primitive, "none");
    assert.equal(r.reason, "empty action");
  });

  it("flag-ON: empty action input — STILL the empty-action fast path (registry not consulted)", () => {
    const r = callTranslateWithFlag("on", "", "");
    assert.equal(r.primitive, "none");
    assert.equal(r.reason, "empty action");
  });
});
