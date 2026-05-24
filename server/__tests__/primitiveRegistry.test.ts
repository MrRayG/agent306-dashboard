/**
 * PR #422 — primitive registry scaffolding tests.
 *
 * Covers:
 *   - register / get / list / listFamilies
 *   - conflict throw on duplicate (family, id)
 *   - invalid id rejection
 *   - lookupPrimitiveForFamily flag-OFF behaviour (no lookup, even with
 *     primitives registered)
 *   - lookupPrimitiveForFamily flag-ON empty-registry behaviour
 *   - lookupPrimitiveForFamily flag-ON registered-primitive hit
 *
 * Run: npx tsx --test server/__tests__/primitiveRegistry.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerPrimitive,
  getPrimitive,
  listPrimitives,
  listFamilies,
  lookupPrimitiveForFamily,
  isPrimitiveRegistryEnabled,
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  type Primitive,
  type PrimitiveExecutor,
} from "../primitives/registry.js";

const NOOP_EXECUTOR: PrimitiveExecutor = async () => ({ ok: true });

function makePrimitive(overrides: Partial<Primitive> = {}): Primitive {
  return {
    family: "synthesis",
    id: "test_executor",
    description: "test-only executor",
    execute: NOOP_EXECUTOR,
    ...overrides,
  };
}

describe("primitive-registry", () => {
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

  // ── register + get ────────────────────────────────────────────────────────

  it("registers a primitive and retrieves it by (family, id)", () => {
    const p = makePrimitive({ family: "synthesis", id: "promote_dream_to_forming" });
    registerPrimitive(p);
    const got = getPrimitive("synthesis", "promote_dream_to_forming");
    assert.equal(got, p);
  });

  it("returns undefined when (family, id) is not registered", () => {
    assert.equal(getPrimitive("synthesis", "nope"), undefined);
    registerPrimitive(makePrimitive({ family: "artifact", id: "x" }));
    // Wrong family.
    assert.equal(getPrimitive("synthesis", "x"), undefined);
    // Wrong id.
    assert.equal(getPrimitive("artifact", "y"), undefined);
  });

  // ── list ──────────────────────────────────────────────────────────────────

  it("listPrimitives returns insertion order", () => {
    const a = makePrimitive({ family: "synthesis", id: "a" });
    const b = makePrimitive({ family: "artifact", id: "b" });
    const c = makePrimitive({ family: "other", id: "c" });
    registerPrimitive(a);
    registerPrimitive(b);
    registerPrimitive(c);
    assert.deepEqual(listPrimitives(), [a, b, c]);
  });

  it("listFamilies returns the unique set of families", () => {
    registerPrimitive(makePrimitive({ family: "synthesis", id: "a" }));
    registerPrimitive(makePrimitive({ family: "synthesis", id: "b" }));
    registerPrimitive(makePrimitive({ family: "artifact", id: "c" }));
    const fams = listFamilies();
    // Order-independent comparison — listFamilies is documented as
    // insertion-order but the contract callers care about is set
    // membership.
    assert.deepEqual(new Set(fams), new Set(["synthesis", "artifact"]));
  });

  // ── conflict handling ─────────────────────────────────────────────────────

  it("throws on duplicate (family, id) registration", () => {
    registerPrimitive(makePrimitive({ family: "synthesis", id: "dup" }));
    assert.throws(
      () => registerPrimitive(makePrimitive({ family: "synthesis", id: "dup" })),
      /duplicate primitive registration: synthesis::dup/,
    );
  });

  it("allows the same id under different families", () => {
    registerPrimitive(makePrimitive({ family: "synthesis", id: "shared" }));
    registerPrimitive(makePrimitive({ family: "artifact", id: "shared" }));
    assert.equal(listPrimitives().length, 2);
  });

  // ── id validation ─────────────────────────────────────────────────────────

  it("rejects empty / invalid ids", () => {
    assert.throws(
      () => registerPrimitive(makePrimitive({ id: "" })),
      /invalid primitive id/,
    );
    assert.throws(
      () => registerPrimitive(makePrimitive({ id: "Has Spaces" })),
      /invalid primitive id/,
    );
    assert.throws(
      () => registerPrimitive(makePrimitive({ id: "UPPER" })),
      /invalid primitive id/,
    );
  });

  it("rejects a primitive missing an execute function", () => {
    assert.throws(
      () =>
        registerPrimitive({
          family: "synthesis",
          id: "broken",
          description: "missing executor",
          // @ts-expect-error — deliberately invalid to test the guard
          execute: undefined,
        }),
      /must provide an execute function/,
    );
  });

  // ── env-flag gate ─────────────────────────────────────────────────────────

  it("isPrimitiveRegistryEnabled defaults to false", () => {
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    assert.equal(isPrimitiveRegistryEnabled(), false);
  });

  it("isPrimitiveRegistryEnabled is true only when env == \"true\"", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    assert.equal(isPrimitiveRegistryEnabled(), true);
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "TRUE";
    assert.equal(isPrimitiveRegistryEnabled(), false);
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "1";
    assert.equal(isPrimitiveRegistryEnabled(), false);
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "";
    assert.equal(isPrimitiveRegistryEnabled(), false);
  });

  // ── lookupPrimitiveForFamily ──────────────────────────────────────────────

  it("lookupPrimitiveForFamily returns null when flag is OFF, even with primitives registered", () => {
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    registerPrimitive(makePrimitive({ family: "synthesis", id: "a" }));
    assert.equal(lookupPrimitiveForFamily("synthesis"), null);
  });

  it("lookupPrimitiveForFamily returns null when flag is ON but registry is empty (today's state)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    assert.equal(listPrimitives().length, 0);
    assert.equal(lookupPrimitiveForFamily("synthesis"), null);
    assert.equal(lookupPrimitiveForFamily("artifact"), null);
    assert.equal(lookupPrimitiveForFamily("other"), null);
  });

  it("lookupPrimitiveForFamily returns the registered primitive when flag is ON", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    const p = makePrimitive({ family: "artifact", id: "draft_paragraph" });
    registerPrimitive(p);
    assert.equal(lookupPrimitiveForFamily("artifact"), p);
    // Different family still misses.
    assert.equal(lookupPrimitiveForFamily("synthesis"), null);
  });

  it("PrimitiveExecutor returns the documented shape (type-shape sanity)", async () => {
    const executor: PrimitiveExecutor = async () => ({
      ok: true,
      observations: ["observed nothing"],
      sideEffects: ["dry-run only"],
    });
    const r = await executor({ actionText: "x", insightText: "y" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.observations, ["observed nothing"]);
    assert.deepEqual(r.sideEffects, ["dry-run only"]);
  });
});
