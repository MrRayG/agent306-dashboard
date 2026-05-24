/**
 * Artifact primitive executor tests (scaffold).
 *
 * Covers:
 *   - flag defaults (executor enabled=false, dry-run=true)
 *   - dry-run executor returns ok:true with telemetry-shaped observations
 *     and a single `[dry-run] would-produce-artifact ...` side-effect
 *   - non-dry-run is explicitly refused (no production engine wired)
 *   - ARTIFACT_PRIMITIVE descriptor shape (family=artifact, id matches)
 *
 * Run: npx tsx --test server/__tests__/artifactPrimitiveExecutor.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_PRIMITIVE,
  ARTIFACT_PRIMITIVE_ID,
  artifactExecutor,
  isArtifactExecutorEnabled,
  isArtifactExecutorDryRun,
  PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/artifact/index.js";

describe("artifact-primitive-executor", () => {
  const ORIG_ENABLED = process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
  const ORIG_DRY_RUN = process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];
  });

  afterEach(() => {
    if (ORIG_ENABLED === undefined) {
      delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV];
    } else {
      process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = ORIG_ENABLED;
    }
    if (ORIG_DRY_RUN === undefined) {
      delete process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV];
    } else {
      process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = ORIG_DRY_RUN;
    }
  });

  // ── descriptor ────────────────────────────────────────────────────────────

  it("ARTIFACT_PRIMITIVE descriptor has the documented shape", () => {
    assert.equal(ARTIFACT_PRIMITIVE.family, "artifact");
    assert.equal(ARTIFACT_PRIMITIVE.id, ARTIFACT_PRIMITIVE_ID);
    assert.equal(typeof ARTIFACT_PRIMITIVE.execute, "function");
    assert.ok(ARTIFACT_PRIMITIVE.description.length > 0);
  });

  // ── flag defaults ─────────────────────────────────────────────────────────

  it("isArtifactExecutorEnabled defaults to false", () => {
    assert.equal(isArtifactExecutorEnabled(), false);
  });

  it("isArtifactExecutorEnabled is true only when env == \"true\"", () => {
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    assert.equal(isArtifactExecutorEnabled(), true);
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "TRUE";
    assert.equal(isArtifactExecutorEnabled(), false);
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "1";
    assert.equal(isArtifactExecutorEnabled(), false);
  });

  it("isArtifactExecutorDryRun defaults to true (dry-run posture)", () => {
    assert.equal(isArtifactExecutorDryRun(), true);
  });

  it("isArtifactExecutorDryRun is false ONLY when env == literal \"false\"", () => {
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "false";
    assert.equal(isArtifactExecutorDryRun(), false);
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "FALSE";
    assert.equal(isArtifactExecutorDryRun(), true);
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "0";
    assert.equal(isArtifactExecutorDryRun(), true);
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "";
    assert.equal(isArtifactExecutorDryRun(), true);
  });

  // ── dry-run behaviour ─────────────────────────────────────────────────────

  it("artifactExecutor returns ok:true with telemetry observations in default (dry-run) mode", async () => {
    const r = await artifactExecutor({
      actionText: "Ship one synthesized briefing artifact this cycle.",
      insightText: "artifact backlog accumulating; ship one concrete output",
      recommendationId: "rec_abc",
      sourceInsightId: "ins_xyz",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.ok(Array.isArray(r.observations));
    assert.ok(r.observations!.some(o => o.startsWith("family=artifact")));
    assert.ok(r.observations!.some(o => o === `id=${ARTIFACT_PRIMITIVE_ID}`));
    assert.ok(r.observations!.some(o => o === "dryRun=true"));
    assert.ok(r.observations!.some(o => o === "recId=rec_abc"));
    assert.ok(r.observations!.some(o => o === "sourceInsightId=ins_xyz"));
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-produce-artifact /);
  });

  it("artifactExecutor omits rec/insight id observations when ctx omits them", async () => {
    const r = await artifactExecutor({
      actionText: "x",
      insightText: "y",
    });
    assert.equal(r.ok, true);
    const joined = (r.observations ?? []).join("\n");
    assert.equal(joined.includes("recId="), false);
    assert.equal(joined.includes("sourceInsightId="), false);
  });

  // ── non-dry-run refusal ───────────────────────────────────────────────────

  it("artifactExecutor refuses non-dry-run requests (no production engine wired)", async () => {
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await artifactExecutor({
      actionText: "Ship one briefing artifact this cycle.",
      insightText: "artifact backlog accumulating",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(r.sideEffects!.length, 0, "no side effects must be claimed in the refusal branch");
    assert.ok((r.observations ?? []).some(o => o === "dryRun=false"));
  });

  it("non-dry-run refusal is independent of executor-enabled flag", async () => {
    // The executor body never reads the executor-enabled flag — that is
    // the bootstrap's job. Flipping it shouldn't change the refusal.
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_ARTIFACT_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await artifactExecutor({ actionText: "x", insightText: "y" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
  });
});
