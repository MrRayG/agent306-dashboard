/**
 * Synthesis primitive executor tests (scaffold).
 *
 * Covers:
 *   - flag defaults (executor enabled=false, dry-run=true)
 *   - dry-run executor returns ok:true with telemetry-shaped observations
 *     and a single `[dry-run] would-synthesize ...` side-effect
 *   - non-dry-run is explicitly refused (no production engine wired)
 *   - SYNTHESIS_PRIMITIVE descriptor shape (family=synthesis, id matches)
 *
 * Run: npx tsx --test server/__tests__/synthesisPrimitiveExecutor.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  SYNTHESIS_PRIMITIVE,
  SYNTHESIS_PRIMITIVE_ID,
  synthesisExecutor,
  isSynthesisExecutorEnabled,
  isSynthesisExecutorDryRun,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/synthesis/index.js";

describe("synthesis-primitive-executor", () => {
  const ORIG_ENABLED = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
  const ORIG_DRY_RUN = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
  });

  afterEach(() => {
    if (ORIG_ENABLED === undefined) {
      delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV];
    } else {
      process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = ORIG_ENABLED;
    }
    if (ORIG_DRY_RUN === undefined) {
      delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
    } else {
      process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = ORIG_DRY_RUN;
    }
  });

  // ── descriptor ────────────────────────────────────────────────────────────

  it("SYNTHESIS_PRIMITIVE descriptor has the documented shape", () => {
    assert.equal(SYNTHESIS_PRIMITIVE.family, "synthesis");
    assert.equal(SYNTHESIS_PRIMITIVE.id, SYNTHESIS_PRIMITIVE_ID);
    assert.equal(typeof SYNTHESIS_PRIMITIVE.execute, "function");
    assert.ok(SYNTHESIS_PRIMITIVE.description.length > 0);
  });

  // ── flag defaults ─────────────────────────────────────────────────────────

  it("isSynthesisExecutorEnabled defaults to false", () => {
    assert.equal(isSynthesisExecutorEnabled(), false);
  });

  it("isSynthesisExecutorEnabled is true only when env == \"true\"", () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    assert.equal(isSynthesisExecutorEnabled(), true);
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "TRUE";
    assert.equal(isSynthesisExecutorEnabled(), false);
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "1";
    assert.equal(isSynthesisExecutorEnabled(), false);
  });

  it("isSynthesisExecutorDryRun defaults to true (dry-run posture)", () => {
    assert.equal(isSynthesisExecutorDryRun(), true);
  });

  it("isSynthesisExecutorDryRun is false ONLY when env == literal \"false\"", () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    assert.equal(isSynthesisExecutorDryRun(), false);
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "FALSE";
    assert.equal(isSynthesisExecutorDryRun(), true);
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "0";
    assert.equal(isSynthesisExecutorDryRun(), true);
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "";
    assert.equal(isSynthesisExecutorDryRun(), true);
  });

  // ── dry-run behaviour ─────────────────────────────────────────────────────

  it("synthesisExecutor returns ok:true with telemetry observations in default (dry-run) mode", async () => {
    const r = await synthesisExecutor({
      actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
      insightText: "dream-loop synthesis cadence stagnating",
      recommendationId: "rec_abc",
      sourceInsightId: "ins_xyz",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.ok(Array.isArray(r.observations));
    assert.ok(r.observations!.some(o => o.startsWith("family=synthesis")));
    assert.ok(r.observations!.some(o => o === `id=${SYNTHESIS_PRIMITIVE_ID}`));
    assert.ok(r.observations!.some(o => o === "dryRun=true"));
    assert.ok(r.observations!.some(o => o === "recId=rec_abc"));
    assert.ok(r.observations!.some(o => o === "sourceInsightId=ins_xyz"));
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-synthesize /);
  });

  it("synthesisExecutor omits rec/insight id observations when ctx omits them", async () => {
    const r = await synthesisExecutor({
      actionText: "x",
      insightText: "y",
    });
    assert.equal(r.ok, true);
    const joined = (r.observations ?? []).join("\n");
    assert.equal(joined.includes("recId="), false);
    assert.equal(joined.includes("sourceInsightId="), false);
  });

  // ── non-dry-run refusal ───────────────────────────────────────────────────

  it("synthesisExecutor refuses non-dry-run requests (no production engine wired)", async () => {
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await synthesisExecutor({
      actionText: "Promote a dream insight via synthesis.",
      insightText: "synthesis cadence stagnating",
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
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await synthesisExecutor({ actionText: "x", insightText: "y" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
  });
});
