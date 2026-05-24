/**
 * Primitives bootstrap tests.
 *
 * Covers:
 *   - default flags register nothing (master OFF, executors OFF)
 *   - master ON + executors OFF: nothing is registered
 *   - master OFF + executors ON: nothing is registered (master gates)
 *   - master ON + per-executor flag ON: that executor IS registered, idempotently
 *   - combined master ON + synthesis ON + artifact ON registers both
 *   - registry compatibility with PR #423 invariants (translator path
 *     remains byte-identical when bootstrap runs)
 *
 * Run: npx tsx --test server/__tests__/primitivesBootstrap.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetForTests,
  getPrimitive,
  listPrimitives,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
} from "../primitives/registry.js";
import {
  bootstrapPrimitives,
  maybeRegisterSynthesisPrimitive,
  maybeRegisterArtifactPrimitive,
} from "../primitives/bootstrap.js";
import {
  SYNTHESIS_PRIMITIVE_ID,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/synthesis/index.js";
import {
  ARTIFACT_PRIMITIVE_ID,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/artifact/index.js";
import { translateAction } from "../actionTranslator.js";

describe("primitives-bootstrap", () => {
  const ORIG_MASTER = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  const ORIG_SYN_ENABLED = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
  const ORIG_SYN_DRY = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
  const ORIG_ART_ENABLED = process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
  const ORIG_ART_DRY = process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    __resetForTests();
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
    delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];
  });

  afterEach(() => {
    __resetForTests();
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore(PRIMITIVE_REGISTRY_ENABLED_ENV, ORIG_MASTER);
    restore(PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV, ORIG_SYN_ENABLED);
    restore(PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV, ORIG_SYN_DRY);
    restore(PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV, ORIG_ART_ENABLED);
    restore(PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV, ORIG_ART_DRY);
  });

  // ── default flags ────────────────────────────────────────────────────────

  it("default flags: bootstrapPrimitives registers nothing", () => {
    const report = bootstrapPrimitives();
    assert.deepEqual(report, {
      registryEnabled: false,
      synthesisRegistered: false,
      artifactRegistered: false,
    });
    assert.equal(listPrimitives().length, 0);
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
  });

  // ── master OFF + executors ON ────────────────────────────────────────────

  it("master OFF + synthesis executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master OFF + artifact executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master OFF + both executors ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  // ── master ON + executors OFF ────────────────────────────────────────────

  it("master ON + executors OFF: nothing registered (per-executor flags still OFF)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  // ── master ON + each executor ON ─────────────────────────────────────────

  it("master ON + synthesis ON: synthesis primitive registered, artifact NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.artifactRegistered, false);
    const p = getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID);
    assert.ok(p, "synthesis primitive should be registered");
    assert.equal(p!.family, "synthesis");
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
  });

  it("master ON + artifact ON: artifact primitive registered, synthesis NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, true);
    const p = getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID);
    assert.ok(p, "artifact primitive should be registered");
    assert.equal(p!.family, "artifact");
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
  });

  it("master ON + both ON: both primitives registered", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.artifactRegistered, true);
    assert.ok(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID));
    assert.ok(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID));
    assert.equal(listPrimitives().length, 2);
  });

  it("bootstrapPrimitives is idempotent — second call does not double-register or throw (synthesis only)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.synthesisRegistered, true);
    assert.equal(b.synthesisRegistered, false, "second call must report no-op");
    assert.equal(listPrimitives().length, 1);
  });

  it("bootstrapPrimitives is idempotent — second call does not double-register or throw (artifact only)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.artifactRegistered, true);
    assert.equal(b.artifactRegistered, false, "second call must report no-op");
    assert.equal(listPrimitives().length, 1);
  });

  it("bootstrapPrimitives is idempotent — combined synthesis+artifact registration", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.synthesisRegistered, true);
    assert.equal(a.artifactRegistered, true);
    assert.equal(b.synthesisRegistered, false);
    assert.equal(b.artifactRegistered, false);
    assert.equal(listPrimitives().length, 2);
  });

  it("maybeRegisterSynthesisPrimitive returns false when executor flag is OFF", () => {
    const out = maybeRegisterSynthesisPrimitive();
    assert.equal(out, false);
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
  });

  it("maybeRegisterArtifactPrimitive returns false when executor flag is OFF", () => {
    const out = maybeRegisterArtifactPrimitive();
    assert.equal(out, false);
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
  });

  // ── PR #423 byte-identical guarantee preserved ───────────────────────────

  it("translator output for synthesis-family fall-through is byte-identical even when bootstrap registered the executor", () => {
    // Capture baseline: master OFF, registry empty.
    const baseline = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    assert.equal(baseline.primitive, "none");

    // Flip both flags ON and bootstrap.
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    assert.ok(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID));

    const flagsOn = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );

    // PR #423 invariant: translator does NOT dispatch — output is still
    // byte-identical to the flag-OFF baseline.
    assert.deepEqual(flagsOn, baseline);
    assert.equal(flagsOn.primitive, "none");
  });

  it("translator output for artifact-family fall-through is byte-identical even when bootstrap registered the executor", () => {
    // An action that classifies under the `artifact` missing-primitive
    // family BUT falls through the structured-primitive parsers (no
    // window/count detected), so `primitive: "none"` is the baseline.
    const actionText = "produce one concrete artifact";
    const insightText = "artifact backlog accumulating; ship one concrete output";

    const baseline = translateAction(actionText, insightText);
    assert.equal(baseline.primitive, "none");

    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    assert.ok(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID));

    const flagsOn = translateAction(actionText, insightText);
    // PR #423 invariant: translator does NOT dispatch — output is still
    // byte-identical to the flag-OFF baseline.
    assert.deepEqual(flagsOn, baseline);
    assert.equal(flagsOn.primitive, "none");
  });

  it("translator output for translatable actions is byte-identical regardless of bootstrap state", () => {
    const baselineRatio = translateAction(
      "For every 10 new knowledge entries, force-generate one synthesis",
      "knowledge accumulation unsustainable",
    );
    assert.equal(baselineRatio.primitive, "ratio_rule");

    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();

    const afterBootstrap = translateAction(
      "For every 10 new knowledge entries, force-generate one synthesis",
      "knowledge accumulation unsustainable",
    );
    assert.deepEqual(afterBootstrap, baselineRatio);
  });
});
