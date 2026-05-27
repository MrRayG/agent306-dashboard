/**
 * Primitives bootstrap tests.
 *
 * Covers:
 *   - default flags register nothing (master OFF, executors OFF)
 *   - master ON + executors OFF: nothing is registered
 *   - master OFF + executors ON: nothing is registered (master gates)
 *   - master ON + per-executor flag ON: that executor IS registered, idempotently
 *   - combined master ON + synthesis ON + artifact ON + other ON registers all three
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
  lookupPrimitiveForFamily,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
} from "../primitives/registry.js";
import {
  bootstrapPrimitives,
  maybeRegisterSynthesisPrimitive,
  maybeRegisterArtifactPrimitive,
  maybeRegisterOtherPrimitive,
  maybeRegisterArchivePrimitive,
  maybeRegisterTtlPrimitive,
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
import {
  OTHER_PRIMITIVE_ID,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/other/index.js";
import {
  ARCHIVE_PRIMITIVE_ID,
  PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/archive/index.js";
import {
  TTL_PRIMITIVE_ID,
  PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/ttl/index.js";
import { translateAction } from "../actionTranslator.js";

describe("primitives-bootstrap", () => {
  const ORIG_MASTER = process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
  const ORIG_SYN_ENABLED = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
  const ORIG_SYN_DRY = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
  const ORIG_ART_ENABLED = process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
  const ORIG_ART_DRY = process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];
  const ORIG_OTHER_ENABLED = process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV];
  const ORIG_OTHER_DRY = process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];
  const ORIG_ARCH_ENABLED = process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV];
  const ORIG_ARCH_DRY = process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV];
  const ORIG_TTL_ENABLED = process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV];
  const ORIG_TTL_DRY = process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    __resetForTests();
    delete process.env[PRIMITIVE_REGISTRY_ENABLED_ENV];
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
    delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];
    delete process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];
    delete process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV];
    delete process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV];
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
    restore(PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV, ORIG_OTHER_ENABLED);
    restore(PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV, ORIG_OTHER_DRY);
    restore(PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV, ORIG_ARCH_ENABLED);
    restore(PRIMITIVE_ARCHIVE_EXECUTOR_DRY_RUN_ENV, ORIG_ARCH_DRY);
    restore(PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV, ORIG_TTL_ENABLED);
    restore(PRIMITIVE_TTL_EXECUTOR_DRY_RUN_ENV, ORIG_TTL_DRY);
  });

  // ── default flags ────────────────────────────────────────────────────────

  it("default flags: bootstrapPrimitives registers nothing", () => {
    const report = bootstrapPrimitives();
    assert.deepEqual(report, {
      registryEnabled: false,
      synthesisRegistered: false,
      artifactRegistered: false,
      otherRegistered: false,
      archiveRegistered: false,
      ttlRegistered: false,
      synthesisReadOnlyPlannerInstalled: false,
    });
    assert.equal(listPrimitives().length, 0);
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("other", OTHER_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("ttl", TTL_PRIMITIVE_ID), undefined);
  });

  // ── master OFF + executors ON ────────────────────────────────────────────

  it("master OFF + synthesis executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master OFF + artifact executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master OFF + other executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master OFF + archive executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master OFF + all executors ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  // ── master ON + executors OFF ────────────────────────────────────────────

  it("master ON + executors OFF: nothing registered (per-executor flags still OFF)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  // ── master ON + each executor ON ─────────────────────────────────────────

  it("master ON + synthesis ON: synthesis primitive registered, artifact/other/archive/ttl NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, false);
    const p = getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID);
    assert.ok(p, "synthesis primitive should be registered");
    assert.equal(p!.family, "synthesis");
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("other", OTHER_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("ttl", TTL_PRIMITIVE_ID), undefined);
  });

  it("master ON + artifact ON: artifact primitive registered, synthesis/other/archive NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, true);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    const p = getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID);
    assert.ok(p, "artifact primitive should be registered");
    assert.equal(p!.family, "artifact");
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("other", OTHER_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
  });

  it("master ON + other ON: other primitive registered, synthesis/artifact/archive NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, true);
    assert.equal(report.archiveRegistered, false);
    const p = getPrimitive("other", OTHER_PRIMITIVE_ID);
    assert.ok(p, "other primitive should be registered");
    assert.equal(p!.family, "other");
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
  });

  it("master ON + archive ON: archive primitive registered, synthesis/artifact/other/ttl NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, true);
    assert.equal(report.ttlRegistered, false);
    const p = getPrimitive("archive", ARCHIVE_PRIMITIVE_ID);
    assert.ok(p, "archive primitive should be registered");
    assert.equal(p!.family, "archive");
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("other", OTHER_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("ttl", TTL_PRIMITIVE_ID), undefined);
  });

  it("master ON + ttl ON: ttl primitive registered, synthesis/artifact/other/archive NOT", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, true);
    const p = getPrimitive("ttl", TTL_PRIMITIVE_ID);
    assert.ok(p, "ttl primitive should be registered");
    assert.equal(p!.family, "ttl");
    assert.equal(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("other", OTHER_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
  });

  it("master OFF + ttl executor ON: nothing registered (master gates)", () => {
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, false);
    assert.equal(report.synthesisRegistered, false);
    assert.equal(report.artifactRegistered, false);
    assert.equal(report.otherRegistered, false);
    assert.equal(report.archiveRegistered, false);
    assert.equal(report.ttlRegistered, false);
    assert.equal(listPrimitives().length, 0);
  });

  it("master ON + all three pre-existing ON: synthesis/artifact/other registered, archive/ttl still NOT (opt-in)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.artifactRegistered, true);
    assert.equal(report.otherRegistered, true);
    assert.equal(
      report.archiveRegistered,
      false,
      "archive must remain unregistered without its explicit flag — the existing three-scaffold deployment is unaffected by this PR",
    );
    assert.equal(
      report.ttlRegistered,
      false,
      "ttl must remain unregistered without its explicit flag — opt-in to the destructive-family scaffold is separate from the pre-existing three-scaffold deployment",
    );
    assert.ok(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID));
    assert.ok(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID));
    assert.ok(getPrimitive("other", OTHER_PRIMITIVE_ID));
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
    assert.equal(getPrimitive("ttl", TTL_PRIMITIVE_ID), undefined);
    assert.equal(listPrimitives().length, 3);
  });

  it("master ON + all four pre-existing ON (synthesis/artifact/other/archive): ttl still NOT (opt-in)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.artifactRegistered, true);
    assert.equal(report.otherRegistered, true);
    assert.equal(report.archiveRegistered, true);
    assert.equal(report.ttlRegistered, false);
    assert.ok(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID));
    assert.equal(getPrimitive("ttl", TTL_PRIMITIVE_ID), undefined);
    assert.equal(listPrimitives().length, 4);
  });

  it("master ON + all five ON: all primitives registered", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    const report = bootstrapPrimitives();
    assert.equal(report.registryEnabled, true);
    assert.equal(report.synthesisRegistered, true);
    assert.equal(report.artifactRegistered, true);
    assert.equal(report.otherRegistered, true);
    assert.equal(report.archiveRegistered, true);
    assert.equal(report.ttlRegistered, true);
    assert.ok(getPrimitive("synthesis", SYNTHESIS_PRIMITIVE_ID));
    assert.ok(getPrimitive("artifact", ARTIFACT_PRIMITIVE_ID));
    assert.ok(getPrimitive("other", OTHER_PRIMITIVE_ID));
    assert.ok(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID));
    assert.ok(getPrimitive("ttl", TTL_PRIMITIVE_ID));
    assert.equal(listPrimitives().length, 5);
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

  it("bootstrapPrimitives is idempotent — second call does not double-register or throw (other only)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.otherRegistered, true);
    assert.equal(b.otherRegistered, false, "second call must report no-op");
    assert.equal(listPrimitives().length, 1);
  });

  it("bootstrapPrimitives is idempotent — second call does not double-register or throw (archive only)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.archiveRegistered, true);
    assert.equal(b.archiveRegistered, false, "second call must report no-op");
    assert.equal(listPrimitives().length, 1);
  });

  it("bootstrapPrimitives is idempotent — second call does not double-register or throw (ttl only)", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.ttlRegistered, true);
    assert.equal(b.ttlRegistered, false, "second call must report no-op");
    assert.equal(listPrimitives().length, 1);
  });

  it("bootstrapPrimitives is idempotent — combined synthesis+artifact+other+archive+ttl registration", () => {
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    const a = bootstrapPrimitives();
    const b = bootstrapPrimitives();
    assert.equal(a.synthesisRegistered, true);
    assert.equal(a.artifactRegistered, true);
    assert.equal(a.otherRegistered, true);
    assert.equal(a.archiveRegistered, true);
    assert.equal(a.ttlRegistered, true);
    assert.equal(b.synthesisRegistered, false);
    assert.equal(b.artifactRegistered, false);
    assert.equal(b.otherRegistered, false);
    assert.equal(b.archiveRegistered, false);
    assert.equal(b.ttlRegistered, false);
    assert.equal(listPrimitives().length, 5);
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

  it("maybeRegisterOtherPrimitive returns false when executor flag is OFF", () => {
    const out = maybeRegisterOtherPrimitive();
    assert.equal(out, false);
    assert.equal(getPrimitive("other", OTHER_PRIMITIVE_ID), undefined);
  });

  it("maybeRegisterArchivePrimitive returns false when executor flag is OFF", () => {
    const out = maybeRegisterArchivePrimitive();
    assert.equal(out, false);
    assert.equal(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID), undefined);
  });

  it("maybeRegisterTtlPrimitive returns false when executor flag is OFF", () => {
    const out = maybeRegisterTtlPrimitive();
    assert.equal(out, false);
    assert.equal(getPrimitive("ttl", TTL_PRIMITIVE_ID), undefined);
  });

  // ── lookupPrimitiveForFamily for archive (registry-integration smoke) ────

  it("lookupPrimitiveForFamily('archive') misses by default, hits when bootstrap registers archive", () => {
    // Before bootstrap with the master flag ON but archive flag OFF:
    // registry empty → miss.
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    assert.equal(lookupPrimitiveForFamily("archive"), null);

    // After bootstrap with both flags ON: archive is registered, lookup
    // returns the scaffold descriptor.
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    const hit = lookupPrimitiveForFamily("archive");
    assert.ok(hit, "archive lookup must hit once registered");
    assert.equal(hit!.family, "archive");
    assert.equal(hit!.id, ARCHIVE_PRIMITIVE_ID);
  });

  it("lookupPrimitiveForFamily('ttl') misses by default, hits when bootstrap registers ttl", () => {
    // This is the load-bearing assertion for the May 27 production
    // signal: `primitiveLookupMiss family=ttl` was the last unresolved
    // family. After bootstrap with the master + ttl flags ON, the
    // lookup must hit.
    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    assert.equal(lookupPrimitiveForFamily("ttl"), null);

    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    const hit = lookupPrimitiveForFamily("ttl");
    assert.ok(hit, "ttl lookup must hit once registered");
    assert.equal(hit!.family, "ttl");
    assert.equal(hit!.id, TTL_PRIMITIVE_ID);
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

  it("translator output for archive-family fall-through is byte-identical even when bootstrap registered the executor", () => {
    // An action that classifies under the `archive` missing-primitive
    // family (the classifier's `\bdelete\b.*\bstale\b` cue fires) BUT
    // does NOT match any of the structured ARCHIVE_PATTERNS in
    // actionTranslator (no `archive` verb start, no `matching|with|
    // containing` qualifier, no `tag X as Y and review/archive` shape),
    // so the translator falls through to `primitive: "none"`. This is
    // the shape the dispatcher would later be asked to route — the
    // baseline must stay byte-identical regardless of bootstrap state.
    const actionText = "Delete stale entries from the registry.";
    const insightText = "KB many entries added zero archived; cleanup overdue";

    const baseline = translateAction(actionText, insightText);
    assert.equal(
      baseline.primitive,
      "none",
      "expected baseline primitive=none — fix the test input if upstream pattern coverage changed",
    );

    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARCHIVE_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    assert.ok(getPrimitive("archive", ARCHIVE_PRIMITIVE_ID));

    const flagsOn = translateAction(actionText, insightText);
    // PR #423 invariant: translator does NOT dispatch — output is still
    // byte-identical to the flag-OFF baseline.
    assert.deepEqual(flagsOn, baseline);
    assert.equal(flagsOn.primitive, "none");
  });

  it("translator output for ttl-family fall-through is byte-identical even when bootstrap registered the executor", () => {
    // An action that classifies under the `ttl` missing-primitive
    // family (the classifier's `\bttl\b` cue fires) BUT does NOT match
    // the structured `ttl_rule` parser in actionTranslator (no
    // "N-day TTL on X" shape that the structured parser requires), so
    // the translator falls through to `primitive: "none"`. This is the
    // shape the dispatcher would later be asked to route — the
    // baseline must stay byte-identical regardless of bootstrap state.
    const actionText = "Add TTL discipline across the dream loop.";
    const insightText = "stale hypotheses accumulating; ttl framing needed";

    const baseline = translateAction(actionText, insightText);
    assert.equal(
      baseline.primitive,
      "none",
      "expected baseline primitive=none — fix the test input if upstream pattern coverage changed",
    );

    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_TTL_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    assert.ok(getPrimitive("ttl", TTL_PRIMITIVE_ID));

    const flagsOn = translateAction(actionText, insightText);
    // PR #423 invariant: translator does NOT dispatch — output is still
    // byte-identical to the flag-OFF baseline.
    assert.deepEqual(flagsOn, baseline);
    assert.equal(flagsOn.primitive, "none");
  });

  it("translator output for other-family fall-through is byte-identical even when bootstrap registered the executor", () => {
    // An action that does NOT match any of the more specific
    // missing-primitive classifiers, so the classifier returns "other"
    // and the structured-primitive parsers also fall through to
    // `primitive: "none"`.
    const actionText = "Tune cadence to keep dream-loop healthy across cycles.";
    const insightText = "uncategorized cadence drift; needs catch-all handling";

    const baseline = translateAction(actionText, insightText);
    assert.equal(baseline.primitive, "none");

    process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();
    assert.ok(getPrimitive("other", OTHER_PRIMITIVE_ID));

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
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    bootstrapPrimitives();

    const afterBootstrap = translateAction(
      "For every 10 new knowledge entries, force-generate one synthesis",
      "knowledge accumulation unsustainable",
    );
    assert.deepEqual(afterBootstrap, baselineRatio);
  });
});
