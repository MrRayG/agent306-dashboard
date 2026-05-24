/**
 * Synthesis adapter tests (PR #431).
 *
 * Covers:
 *   - `defaultSynthesisAdapter` is deterministic, pure, and side-effect-
 *     free; `wouldGenerateSynthesisReport` reflects input emptiness.
 *   - The `getSynthesisAdapter` / `setSynthesisAdapter` /
 *     `resetSynthesisAdapterForTests` slot round-trips correctly.
 *   - `setSynthesisAdapter` rejects malformed adapters (missing
 *     `planSynthesis`, empty name).
 *   - The synthesis executor consults the installed adapter in dry-run
 *     mode AND merges the plan's observations into its returned
 *     observations.
 *   - The executor surfaces an adapter throw as a structured refusal
 *     (no exception escapes to the caller).
 *   - The executor's non-dry-run refusal is independent of which
 *     adapter is installed.
 *
 * Run:
 *   npx tsx --test server/__tests__/synthesisAdapter.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  defaultSynthesisAdapter,
  getSynthesisAdapter,
  setSynthesisAdapter,
  resetSynthesisAdapterForTests,
  synthesisExecutor,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  type SynthesisAdapter,
  type SynthesisAdapterInput,
  type SynthesisPlan,
} from "../primitives/synthesis/index.js";

const FAKE_INPUT: SynthesisAdapterInput = {
  actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
  insightText: "dream-loop synthesis cadence stagnating",
  recommendationId: "rec_x",
  sourceInsightId: "ins_y",
};

describe("synthesis-adapter", () => {
  const ORIG_DRY_RUN = process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];

  beforeEach(() => {
    delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
    resetSynthesisAdapterForTests();
  });

  afterEach(() => {
    resetSynthesisAdapterForTests();
    if (ORIG_DRY_RUN === undefined) {
      delete process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV];
    } else {
      process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = ORIG_DRY_RUN;
    }
  });

  // ── default adapter ───────────────────────────────────────────────────────

  it("defaultSynthesisAdapter has stable identity and is the initial slot value", () => {
    assert.equal(defaultSynthesisAdapter.name, "default");
    assert.equal(typeof defaultSynthesisAdapter.planSynthesis, "function");
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("defaultSynthesisAdapter returns wouldGenerate=true for non-empty input", async () => {
    const plan = await defaultSynthesisAdapter.planSynthesis(FAKE_INPUT);
    assert.equal(plan.wouldGenerateSynthesisReport, true);
    assert.match(plan.summary, /^\[dry-run\] default-adapter plan from action=/);
    assert.ok(Array.isArray(plan.observations));
    assert.ok(plan.observations!.includes("adapter=default"));
    assert.ok(plan.observations!.includes("wouldGenerate=true"));
  });

  it("defaultSynthesisAdapter returns wouldGenerate=false for empty input", async () => {
    const plan = await defaultSynthesisAdapter.planSynthesis({
      actionText: "",
      insightText: "",
    });
    assert.equal(plan.wouldGenerateSynthesisReport, false);
    assert.match(plan.summary, /empty input, would not generate/);
    assert.ok(plan.observations!.includes("wouldGenerate=false"));
  });

  it("defaultSynthesisAdapter is deterministic across calls", async () => {
    const a = await defaultSynthesisAdapter.planSynthesis(FAKE_INPUT);
    const b = await defaultSynthesisAdapter.planSynthesis(FAKE_INPUT);
    assert.deepEqual(a, b);
  });

  // ── slot management ───────────────────────────────────────────────────────

  it("setSynthesisAdapter swaps the slot; reset restores default", () => {
    const fake: SynthesisAdapter = {
      name: "fake",
      async planSynthesis(): Promise<SynthesisPlan> {
        return { summary: "fake-plan", wouldGenerateSynthesisReport: true };
      },
    };
    setSynthesisAdapter(fake);
    assert.equal(getSynthesisAdapter(), fake);
    resetSynthesisAdapterForTests();
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("setSynthesisAdapter rejects missing planSynthesis", () => {
    assert.throws(
      () => setSynthesisAdapter({ name: "broken" } as unknown as SynthesisAdapter),
      /planSynthesis function required/,
    );
    // slot must remain default after a rejected install
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  it("setSynthesisAdapter rejects empty name", () => {
    assert.throws(
      () =>
        setSynthesisAdapter({
          name: "",
          async planSynthesis(): Promise<SynthesisPlan> {
            return { summary: "x", wouldGenerateSynthesisReport: false };
          },
        }),
      /non-empty name/,
    );
    assert.equal(getSynthesisAdapter(), defaultSynthesisAdapter);
  });

  // ── executor / adapter integration ────────────────────────────────────────

  it("executor in dry-run mode consults installed adapter and merges observations", async () => {
    const calls: SynthesisAdapterInput[] = [];
    const fake: SynthesisAdapter = {
      name: "test-fake",
      async planSynthesis(input): Promise<SynthesisPlan> {
        calls.push(input);
        return {
          summary: "fake-plan-summary",
          wouldGenerateSynthesisReport: true,
          observations: ["adapter=test-fake", "fakeObs=1"],
        };
      },
    };
    setSynthesisAdapter(fake);
    const r = await synthesisExecutor({
      actionText: FAKE_INPUT.actionText,
      insightText: FAKE_INPUT.insightText,
      recommendationId: FAKE_INPUT.recommendationId,
      sourceInsightId: FAKE_INPUT.sourceInsightId,
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1, "adapter was invoked exactly once");
    assert.equal(calls[0].actionText, FAKE_INPUT.actionText);
    assert.equal(calls[0].recommendationId, FAKE_INPUT.recommendationId);
    assert.ok(r.observations!.includes("adapterName=test-fake"));
    assert.ok(r.observations!.includes("fakeObs=1"));
    assert.equal(r.sideEffects!.length, 1);
    assert.match(r.sideEffects![0], /via adapter=test-fake.*fake-plan-summary/);
  });

  it("executor surfaces adapter throw as structured refusal (no exception escapes)", async () => {
    const exploding: SynthesisAdapter = {
      name: "boom",
      async planSynthesis(): Promise<SynthesisPlan> {
        throw new Error("boom-msg");
      },
    };
    setSynthesisAdapter(exploding);
    const r = await synthesisExecutor({ actionText: "a", insightText: "b" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /adapter "boom" threw: boom-msg/);
    assert.equal((r.sideEffects ?? []).length, 0);
    // The pre-adapter observations are still emitted so telemetry has
    // something to correlate against.
    assert.ok((r.observations ?? []).some(o => o === "dryRun=true"));
    assert.ok((r.observations ?? []).some(o => o === "adapterName=boom"));
  });

  it("executor in non-dry-run mode refuses regardless of installed adapter", async () => {
    let adapterCalled = false;
    setSynthesisAdapter({
      name: "wired-but-should-not-run",
      async planSynthesis(): Promise<SynthesisPlan> {
        adapterCalled = true;
        return { summary: "should-not-be-reached", wouldGenerateSynthesisReport: true };
      },
    });
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await synthesisExecutor({ actionText: "a", insightText: "b" });
    assert.equal(adapterCalled, false, "adapter must not be consulted in non-dry-run mode");
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
    assert.equal((r.sideEffects ?? []).length, 0);
  });

  it("executor with default adapter produces telemetry-shaped observations", async () => {
    // Sanity check: with no setSynthesisAdapter call, the default
    // adapter is exercised and adds its own observations.
    const r = await synthesisExecutor({ actionText: "x", insightText: "y" });
    assert.equal(r.ok, true);
    assert.ok((r.observations ?? []).includes("adapterName=default"));
    assert.ok((r.observations ?? []).includes("adapter=default"));
    assert.ok((r.observations ?? []).some(o => o.startsWith("wouldGenerate=")));
  });
});
