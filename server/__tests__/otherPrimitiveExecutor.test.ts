/**
 * Other primitive executor tests (scaffold).
 *
 * Covers:
 *   - flag defaults (executor enabled=false, dry-run=true)
 *   - dry-run executor returns ok:true with telemetry-shaped observations
 *     and a single `[dry-run] would-handle-other ...` side-effect
 *   - non-dry-run is explicitly refused (no production engine wired)
 *   - OTHER_PRIMITIVE descriptor shape (family=other, id matches)
 *
 * Run: npx tsx --test server/__tests__/otherPrimitiveExecutor.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  OTHER_PRIMITIVE,
  OTHER_PRIMITIVE_ID,
  otherExecutor,
  isOtherExecutorEnabled,
  isOtherExecutorDryRun,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
} from "../primitives/other/index.js";

describe("other-primitive-executor", () => {
  const ORIG_ENABLED = process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV];
  const ORIG_DRY_RUN = process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    delete process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV];
    delete process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];
  });

  afterEach(() => {
    if (ORIG_ENABLED === undefined) {
      delete process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV];
    } else {
      process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = ORIG_ENABLED;
    }
    if (ORIG_DRY_RUN === undefined) {
      delete process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];
    } else {
      process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = ORIG_DRY_RUN;
    }
  });

  // ── descriptor ────────────────────────────────────────────────────────────

  it("OTHER_PRIMITIVE descriptor has the documented shape", () => {
    assert.equal(OTHER_PRIMITIVE.family, "other");
    assert.equal(OTHER_PRIMITIVE.id, OTHER_PRIMITIVE_ID);
    assert.equal(typeof OTHER_PRIMITIVE.execute, "function");
    assert.ok(OTHER_PRIMITIVE.description.length > 0);
  });

  // ── flag defaults ─────────────────────────────────────────────────────────

  it("isOtherExecutorEnabled defaults to false", () => {
    assert.equal(isOtherExecutorEnabled(), false);
  });

  it("isOtherExecutorEnabled is true only when env == \"true\"", () => {
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    assert.equal(isOtherExecutorEnabled(), true);
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "TRUE";
    assert.equal(isOtherExecutorEnabled(), false);
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "1";
    assert.equal(isOtherExecutorEnabled(), false);
  });

  it("isOtherExecutorDryRun defaults to true (dry-run posture)", () => {
    assert.equal(isOtherExecutorDryRun(), true);
  });

  it("isOtherExecutorDryRun is false ONLY when env == literal \"false\"", () => {
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "false";
    assert.equal(isOtherExecutorDryRun(), false);
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "FALSE";
    assert.equal(isOtherExecutorDryRun(), true);
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "0";
    assert.equal(isOtherExecutorDryRun(), true);
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "";
    assert.equal(isOtherExecutorDryRun(), true);
  });

  // ── dry-run behaviour ─────────────────────────────────────────────────────

  it("otherExecutor returns ok:true with telemetry observations in default (dry-run) mode", async () => {
    const r = await otherExecutor({
      actionText: "Tune cadence to keep dream-loop healthy across cycles.",
      insightText: "uncategorized cadence drift; needs catch-all handling",
      recommendationId: "rec_abc",
      sourceInsightId: "ins_xyz",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, undefined);
    assert.ok(Array.isArray(r.observations));
    assert.ok(r.observations!.some(o => o.startsWith("family=other")));
    assert.ok(r.observations!.some(o => o === `id=${OTHER_PRIMITIVE_ID}`));
    assert.ok(r.observations!.some(o => o === "dryRun=true"));
    assert.ok(r.observations!.some(o => o === "recId=rec_abc"));
    assert.ok(r.observations!.some(o => o === "sourceInsightId=ins_xyz"));
    assert.ok(Array.isArray(r.sideEffects));
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /^\[dry-run\] would-handle-other /);
  });

  it("otherExecutor omits rec/insight id observations when ctx omits them", async () => {
    const r = await otherExecutor({
      actionText: "x",
      insightText: "y",
    });
    assert.equal(r.ok, true);
    const joined = (r.observations ?? []).join("\n");
    assert.equal(joined.includes("recId="), false);
    assert.equal(joined.includes("sourceInsightId="), false);
  });

  // ── non-dry-run refusal ───────────────────────────────────────────────────

  it("otherExecutor refuses non-dry-run requests (no production engine wired)", async () => {
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await otherExecutor({
      actionText: "Tune cadence to keep dream-loop healthy.",
      insightText: "uncategorized cadence drift",
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
    process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
    process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await otherExecutor({ actionText: "x", insightText: "y" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
  });
});
