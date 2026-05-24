/**
 * Read-only synthesis planner tests (PR #432).
 *
 * Verifies that the new read-only planning seam connects to the synthesis
 * adapter contract without widening autonomy:
 *
 *   1. The default read-only planner is pure, deterministic, and emits the
 *      structured metadata shape future real-engine planners are expected
 *      to fill in (candidate summary, source, confidence, reasoning,
 *      required-inputs, diagnostics).
 *   2. `createReadOnlyPlanningAdapter` accepts an injected planner and
 *      returns a `SynthesisAdapter` whose name and observations reflect
 *      the injected planner identity.
 *   3. `createReadOnlyPlanningAdapter` rejects malformed planners.
 *   4. The adapter does NOT consult or mutate any external state — a
 *      tracking fake confirms it is the only thing called and that only
 *      input fields are read.
 *   5. The executor surfaces a planner throw via the read-only adapter as
 *      a structured refusal (no exception escapes), AND the dispatcher
 *      records a `refused` telemetry record.
 *   6. With the full dry-run gate stack ON and the read-only adapter
 *      installed, the dispatcher returns `kind: "ok"` and the result's
 *      side effects carry the read-only planner's identity.
 *   7. Non-dry-run still refuses regardless of the installed adapter.
 *   8. With the master invocation gate OFF (default deploy), the
 *      read-only adapter is NEVER consulted even when it is installed.
 *
 * Run:
 *   npx tsx --test server/__tests__/synthesisReadOnlyPlanner.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { translateAction, type TranslatedAction } from "../actionTranslator.js";
import {
  __resetForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  type PrimitiveExecutionContext,
} from "../primitives/registry.js";
import {
  registerSynthesisPrimitive,
  SYNTHESIS_PRIMITIVE_ID,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
  setSynthesisAdapter,
  resetSynthesisAdapterForTests,
  synthesisExecutor,
  createReadOnlyPlanningAdapter,
  defaultReadOnlySynthesisPlanner,
  type ReadOnlySynthesisPlanner,
  type ReadOnlyPlanningCandidate,
  type SynthesisAdapterInput,
} from "../primitives/synthesis/index.js";
import {
  invokeRegisteredPrimitive,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} from "../primitives/dispatcher.js";
import {
  __resetDispatchTelemetryForTests,
  getRecentDispatchTelemetry,
} from "../primitives/telemetry.js";

const ALL_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV,
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ALL_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ALL_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearAll(): void {
  for (const k of ALL_KEYS) delete process.env[k];
}

function enableFullDryRunStack(): void {
  process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_ENABLED_ENV] = "true";
  // dry-run default-true via env-absence
}

const FAKE_INPUT: SynthesisAdapterInput = {
  actionText: "Promote a dream insight into a forming hypothesis via synthesis.",
  insightText: "dream-loop synthesis cadence stagnating",
  recommendationId: "rec_pr432_001",
  sourceInsightId: "ins_pr432_001",
};

function makeTranslation(): TranslatedAction {
  return {
    primitive: "none",
    params: {},
    verificationCriterion: "",
    reason: "test-stub",
    registeredPrimitive: {
      family: "synthesis",
      id: SYNTHESIS_PRIMITIVE_ID,
      description: "test",
    },
  };
}

describe("read-only synthesis planner", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    clearAll();
    __resetForTests();
    __resetDispatchTelemetryForTests();
    resetSynthesisAdapterForTests();
  });

  afterEach(() => {
    __resetForTests();
    __resetDispatchTelemetryForTests();
    resetSynthesisAdapterForTests();
    restoreEnv(envSnap);
  });

  // ── default planner shape & purity ────────────────────────────────────────

  it("defaultReadOnlySynthesisPlanner has stable identity", () => {
    assert.equal(defaultReadOnlySynthesisPlanner.name, "default-read-only");
    assert.equal(typeof defaultReadOnlySynthesisPlanner.plan, "function");
  });

  it("defaultReadOnlySynthesisPlanner returns wouldGenerate=true and rich metadata for non-empty input", async () => {
    const c = await defaultReadOnlySynthesisPlanner.plan(FAKE_INPUT);
    assert.equal(c.source, "default-read-only");
    assert.equal(c.wouldGenerateSynthesisReport, true);
    assert.equal(typeof c.confidence, "number");
    assert.ok((c.confidence ?? 0) >= 0 && (c.confidence ?? 0) <= 1);
    assert.ok(typeof c.reasoning === "string" && c.reasoning!.length > 0);
    assert.deepEqual(
      [...c.requiredInputs].sort(),
      ["actionText", "insightText", "recommendationId", "sourceInsightId"].sort(),
    );
    assert.ok(c.diagnostics.some(d => d.startsWith("planner=default-read-only")));
    assert.ok(c.diagnostics.some(d => d === "wouldGenerate=true"));
    assert.equal(c.refusalReason, undefined);
  });

  it("defaultReadOnlySynthesisPlanner declines on empty input with refusalReason", async () => {
    const c = await defaultReadOnlySynthesisPlanner.plan({
      actionText: "",
      insightText: "",
    });
    assert.equal(c.wouldGenerateSynthesisReport, false);
    assert.equal(c.refusalReason, "empty-input");
    assert.equal(c.confidence, 0);
    assert.deepEqual(c.requiredInputs, []);
    assert.match(c.summary, /empty input/);
  });

  it("defaultReadOnlySynthesisPlanner is deterministic across calls", async () => {
    const a = await defaultReadOnlySynthesisPlanner.plan(FAKE_INPUT);
    const b = await defaultReadOnlySynthesisPlanner.plan(FAKE_INPUT);
    assert.deepEqual(a, b);
  });

  it("defaultReadOnlySynthesisPlanner confidence scales with input richness", async () => {
    const empty = await defaultReadOnlySynthesisPlanner.plan({
      actionText: "",
      insightText: "",
    });
    const onlyAction = await defaultReadOnlySynthesisPlanner.plan({
      actionText: "synthesize",
      insightText: "",
    });
    const both = await defaultReadOnlySynthesisPlanner.plan({
      actionText: "synthesize",
      insightText: "context",
    });
    const fullyTagged = await defaultReadOnlySynthesisPlanner.plan(FAKE_INPUT);

    assert.equal(empty.confidence, 0);
    assert.ok((onlyAction.confidence ?? 0) > 0);
    assert.ok((both.confidence ?? 0) >= (onlyAction.confidence ?? 0));
    assert.ok((fullyTagged.confidence ?? 0) >= (both.confidence ?? 0));
    assert.ok((fullyTagged.confidence ?? 0) <= 1);
  });

  // ── factory validation ────────────────────────────────────────────────────

  it("createReadOnlyPlanningAdapter() with no args defaults to the default planner", async () => {
    const adapter = createReadOnlyPlanningAdapter();
    assert.equal(adapter.name, "read-only-planning:default-read-only");
    const plan = await adapter.planSynthesis(FAKE_INPUT);
    assert.equal(plan.wouldGenerateSynthesisReport, true);
    assert.ok(plan.observations!.includes("adapter=read-only-planning"));
    assert.ok(plan.observations!.includes("planner=default-read-only"));
  });

  it("createReadOnlyPlanningAdapter rejects null planner", () => {
    assert.throws(
      () => createReadOnlyPlanningAdapter(null as unknown as ReadOnlySynthesisPlanner),
      /plan function required/,
    );
  });

  it("createReadOnlyPlanningAdapter rejects planner missing plan()", () => {
    assert.throws(
      () =>
        createReadOnlyPlanningAdapter({
          name: "broken",
        } as unknown as ReadOnlySynthesisPlanner),
      /plan function required/,
    );
  });

  it("createReadOnlyPlanningAdapter rejects planner with empty name", () => {
    assert.throws(
      () =>
        createReadOnlyPlanningAdapter({
          name: "",
          async plan(): Promise<ReadOnlyPlanningCandidate> {
            return {
              source: "x",
              summary: "x",
              wouldGenerateSynthesisReport: false,
              requiredInputs: [],
              diagnostics: [],
            };
          },
        }),
      /non-empty name/,
    );
  });

  // ── DI surface: fake planner is the only thing called ─────────────────────

  it("adapter delegates only to the injected planner and surfaces its metadata", async () => {
    const calls: SynthesisAdapterInput[] = [];
    const fakePlanner: ReadOnlySynthesisPlanner = {
      name: "fake-planner",
      async plan(input): Promise<ReadOnlyPlanningCandidate> {
        calls.push(input);
        return {
          source: "fake-source",
          summary: "fake-summary-here",
          wouldGenerateSynthesisReport: true,
          confidence: 0.42,
          reasoning: "fake-reasoning",
          requiredInputs: ["actionText"],
          diagnostics: ["fakeDiag=1", "fakeDiag=2"],
        };
      },
    };
    const adapter = createReadOnlyPlanningAdapter(fakePlanner);
    const plan = await adapter.planSynthesis(FAKE_INPUT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actionText, FAKE_INPUT.actionText);
    assert.equal(calls[0].recommendationId, FAKE_INPUT.recommendationId);
    assert.equal(plan.wouldGenerateSynthesisReport, true);
    assert.ok(plan.observations!.includes("adapter=read-only-planning"));
    assert.ok(plan.observations!.includes("planner=fake-planner"));
    assert.ok(plan.observations!.includes("confidence=0.42"));
    assert.ok(plan.observations!.includes("requiredInputs=actionText"));
    assert.ok(plan.observations!.includes("fakeDiag=1"));
    assert.ok(plan.observations!.includes("fakeDiag=2"));
    assert.match(plan.summary, /source=fake-source/);
  });

  it("adapter surfaces refusalReason in summary and observations", async () => {
    const decliningPlanner: ReadOnlySynthesisPlanner = {
      name: "decliner",
      async plan(): Promise<ReadOnlyPlanningCandidate> {
        return {
          source: "decliner",
          summary: "nothing-to-do",
          wouldGenerateSynthesisReport: false,
          requiredInputs: [],
          refusalReason: "insufficient-context",
          diagnostics: ["planner=decliner", "wouldGenerate=false"],
        };
      },
    };
    const adapter = createReadOnlyPlanningAdapter(decliningPlanner);
    const plan = await adapter.planSynthesis(FAKE_INPUT);
    assert.equal(plan.wouldGenerateSynthesisReport, false);
    assert.match(plan.summary, /declined: insufficient-context/);
    assert.ok(plan.observations!.includes("refusalReason=insufficient-context"));
  });

  // ── executor + adapter integration ────────────────────────────────────────

  it("executor in dry-run mode with read-only adapter installed surfaces planner metadata", async () => {
    setSynthesisAdapter(createReadOnlyPlanningAdapter());
    const r = await synthesisExecutor({
      actionText: FAKE_INPUT.actionText,
      insightText: FAKE_INPUT.insightText,
      recommendationId: FAKE_INPUT.recommendationId,
      sourceInsightId: FAKE_INPUT.sourceInsightId,
    });
    assert.equal(r.ok, true);
    assert.ok(
      (r.observations ?? []).includes("adapterName=read-only-planning:default-read-only"),
    );
    assert.ok((r.observations ?? []).includes("adapter=read-only-planning"));
    assert.ok((r.observations ?? []).includes("planner=default-read-only"));
    assert.equal((r.sideEffects ?? []).length, 1);
    assert.match(r.sideEffects![0], /read-only-planning:default-read-only/);
    assert.match(r.sideEffects![0], /source=default-read-only/);
  });

  it("planner exception is contained: executor surfaces a structured refusal", async () => {
    const explodingPlanner: ReadOnlySynthesisPlanner = {
      name: "boom-planner",
      async plan(): Promise<ReadOnlyPlanningCandidate> {
        throw new Error("planner-failure-msg");
      },
    };
    setSynthesisAdapter(createReadOnlyPlanningAdapter(explodingPlanner));
    const r = await synthesisExecutor({ actionText: "a", insightText: "b" });
    assert.equal(r.ok, false);
    assert.match(
      r.reason ?? "",
      /adapter "read-only-planning:boom-planner" threw: planner-failure-msg/,
    );
    assert.equal((r.sideEffects ?? []).length, 0);
    assert.ok((r.observations ?? []).includes("dryRun=true"));
    assert.ok(
      (r.observations ?? []).includes("adapterName=read-only-planning:boom-planner"),
    );
  });

  it("non-dry-run mode refuses even when read-only adapter is installed; planner not consulted", async () => {
    let plannerCalled = false;
    const trackingPlanner: ReadOnlySynthesisPlanner = {
      name: "should-not-run",
      async plan(): Promise<ReadOnlyPlanningCandidate> {
        plannerCalled = true;
        return {
          source: "x",
          summary: "x",
          wouldGenerateSynthesisReport: true,
          requiredInputs: [],
          diagnostics: [],
        };
      },
    };
    setSynthesisAdapter(createReadOnlyPlanningAdapter(trackingPlanner));
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    const r = await synthesisExecutor({ actionText: "a", insightText: "b" });
    assert.equal(plannerCalled, false);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /non-dry-run requested but no production engine is wired/);
    assert.equal((r.sideEffects ?? []).length, 0);
  });

  // ── dispatcher integration ────────────────────────────────────────────────

  it("full dry-run stack: dispatcher returns kind=ok and side effects identify the read-only planner", async () => {
    enableFullDryRunStack();
    registerSynthesisPrimitive();
    setSynthesisAdapter(createReadOnlyPlanningAdapter());
    const r = await invokeRegisteredPrimitive(
      makeTranslation(),
      {
        actionText: FAKE_INPUT.actionText,
        insightText: FAKE_INPUT.insightText,
        recommendationId: FAKE_INPUT.recommendationId,
        sourceInsightId: FAKE_INPUT.sourceInsightId,
      } satisfies PrimitiveExecutionContext,
    );
    assert.equal(r.kind, "ok");
    if (r.kind !== "ok") return;
    assert.equal(r.family, "synthesis");
    assert.equal(r.id, SYNTHESIS_PRIMITIVE_ID);
    assert.equal(r.result.ok, true);
    assert.ok(
      (r.result.sideEffects ?? []).some(s =>
        /read-only-planning:default-read-only/.test(s),
      ),
    );
    const records = getRecentDispatchTelemetry();
    const okRec = records.find(t => t.kind === "ok");
    assert.ok(okRec);
    assert.equal(okRec!.dryRun, true);
    assert.equal(okRec!.family, "synthesis");
    assert.equal(okRec!.recommendationId, "rec_pr432_001");
  });

  it("dispatcher records refused telemetry when read-only planner throws", async () => {
    enableFullDryRunStack();
    registerSynthesisPrimitive();
    const explodingPlanner: ReadOnlySynthesisPlanner = {
      name: "dispatcher-boom",
      async plan(): Promise<ReadOnlyPlanningCandidate> {
        throw new Error("dispatcher-planner-error");
      },
    };
    setSynthesisAdapter(createReadOnlyPlanningAdapter(explodingPlanner));
    const r = await invokeRegisteredPrimitive(
      makeTranslation(),
      {
        actionText: FAKE_INPUT.actionText,
        insightText: FAKE_INPUT.insightText,
        recommendationId: FAKE_INPUT.recommendationId,
      } satisfies PrimitiveExecutionContext,
    );
    assert.equal(r.kind, "refused");
    if (r.kind !== "refused") return;
    assert.match(r.result.reason ?? "", /dispatcher-planner-error/);
    const records = getRecentDispatchTelemetry();
    const refusedRec = records.find(t => t.kind === "refused");
    assert.ok(refusedRec);
    assert.equal(refusedRec!.dryRun, true);
    assert.match(refusedRec!.resultReason ?? "", /dispatcher-planner-error/);
  });

  it("dispatcher records refused telemetry under non-dry-run with the read-only adapter installed; planner not consulted", async () => {
    enableFullDryRunStack();
    process.env[PRIMITIVE_SYNTHESIS_EXECUTOR_DRY_RUN_ENV] = "false";
    let plannerCalled = false;
    const trackingPlanner: ReadOnlySynthesisPlanner = {
      name: "should-not-run-non-dry",
      async plan(): Promise<ReadOnlyPlanningCandidate> {
        plannerCalled = true;
        return {
          source: "x",
          summary: "x",
          wouldGenerateSynthesisReport: true,
          requiredInputs: [],
          diagnostics: [],
        };
      },
    };
    setSynthesisAdapter(createReadOnlyPlanningAdapter(trackingPlanner));
    registerSynthesisPrimitive();
    const r = await invokeRegisteredPrimitive(makeTranslation(), {
      actionText: "a",
      insightText: "b",
    });
    assert.equal(r.kind, "refused");
    assert.equal(plannerCalled, false, "planner must NOT be consulted in non-dry-run mode");
    const records = getRecentDispatchTelemetry();
    const refusedRec = records.find(t => t.kind === "refused");
    assert.ok(refusedRec);
    assert.equal(refusedRec!.dryRun, false);
  });

  // ── default-off invariance ────────────────────────────────────────────────

  it("default deploy: read-only adapter installed but invocation gate OFF → planner not consulted", async () => {
    let plannerCalled = false;
    setSynthesisAdapter(
      createReadOnlyPlanningAdapter({
        name: "should-not-run-default-off",
        async plan(): Promise<ReadOnlyPlanningCandidate> {
          plannerCalled = true;
          return {
            source: "x",
            summary: "x",
            wouldGenerateSynthesisReport: true,
            requiredInputs: [],
            diagnostics: [],
          };
        },
      }),
    );
    registerSynthesisPrimitive();
    const r = await invokeRegisteredPrimitive(makeTranslation(), {
      actionText: "a",
      insightText: "b",
    });
    assert.equal(r.kind, "disabled");
    assert.equal(plannerCalled, false);
  });

  it("default deploy: translator output is unchanged when read-only adapter exists in module scope", () => {
    // Importing readOnlyPlanner.ts is side-effect-free and creates no
    // adapter installation. Translator fall-through must remain
    // byte-identical to the pre-this-PR baseline.
    const t: TranslatedAction = translateAction(
      "Promote a dream insight into a forming hypothesis via synthesis.",
      "dream-loop synthesis cadence stagnating",
    );
    assert.equal(t.primitive, "none");
    assert.equal(t.registeredPrimitive, undefined);
  });
});
