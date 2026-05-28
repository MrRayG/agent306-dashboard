/**
 * Tests for the GoalEngine.promoteInsightToGoal fallback-reconciliation
 * follow-up to PR #435/#438. After every primitive family scaffold landed
 * (synthesis/artifact/other/archive/ttl), production dry-run logs showed
 * `primitiveLookupHit` + `dryRunExecuted` for the catch-all `other`
 * family, immediately followed by `missing-primitive-rec`. That is
 * misleading: the primitive layer covered the action via a fallback
 * dry-run, so it should NOT also be counted/logged as a missing primitive.
 *
 * Invariants pinned by this file:
 *
 *   1. When the translator does NOT attach `registeredPrimitive` metadata
 *      (no fallback covers the action), GoalEngine still emits
 *      `missing-primitive-rec` AND proposes the missing-primitive
 *      SelfRecommendation — preserving the legacy gap-tracking signal.
 *
 *   2. When the translator attaches metadata AND every gate is ON so the
 *      dispatcher invokes the `other::scaffold` executor successfully in
 *      dry-run, GoalEngine does NOT emit `missing-primitive-rec` and does
 *      NOT propose a missing-primitive SelfRecommendation. Instead it
 *      emits a single clearer `primitive-fallback-rec` event carrying
 *      insightId, family, primitiveId, dryRun=true, and a classification
 *      status — keeping the row unresolved/proposed (TTL handles
 *      expiration).
 *
 *   3. The fallback dry-run path causes no non-dry-run side effects:
 *      the insight ledger entry stays `proposed` (no `transitionEntry`
 *      call), no goal is created, and no enforcement rule is registered.
 *      Pin 7 / Pin 11 invariants remain intact.
 *
 * Run: npx tsx --test server/__tests__/goalEnginePrimitiveFallbackReconcile.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB / DATA_DIR isolation. Same pattern as selfRecommendationDedupe.
const TMP_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "goalEngineFallback-test-"),
);
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const { db } = await import("../db.js");
const { engineEvents, selfRecommendations } = await import("@shared/schema");

const {
  __resetForTests: __resetRegistryForTests,
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
} = await import("../primitives/registry.js");
const {
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
} = await import("../primitives/dispatcher.js");
const {
  __resetDispatchTelemetryForTests,
} = await import("../primitives/telemetry.js");
const {
  registerOtherPrimitive,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
} = await import("../primitives/other/index.js");
const { promoteInsightToGoal } = await import("../goalEngine.js");
const { getAllActiveRules } = await import("../actionEnforcer.js");
const { getGoals } = await import("../researchEngine.js");
import type { InsightLedgerEntry } from "../insightLedger.js";

const ALL_ENV_KEYS = [
  PRIMITIVE_REGISTRY_ENABLED_ENV,
  PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV,
  PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV,
  PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV,
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ALL_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ALL_ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function clearAllFlags(): void {
  for (const k of ALL_ENV_KEYS) delete process.env[k];
}

function enableFullOtherFallback(): void {
  process.env[PRIMITIVE_REGISTRY_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_TRANSLATOR_DISPATCH_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_EXECUTOR_INVOCATION_ENABLED_ENV] = "true";
  process.env[PRIMITIVE_OTHER_EXECUTOR_ENABLED_ENV] = "true";
  // Dry-run default ON. Setting the env to literally "false" would flip
  // the scaffold into refuse mode; we explicitly delete to be sure.
  delete process.env[PRIMITIVE_OTHER_EXECUTOR_DRY_RUN_ENV];
}

function wipeEvents(): void {
  try { db.delete(engineEvents).run(); } catch {}
}

function wipeRecs(): void {
  try { db.delete(selfRecommendations).run(); } catch {}
}

interface EventRow { engine: string; event: string; data: any }

function fetchGoalEngineEvents(event?: string): EventRow[] {
  const rows = db.select().from(engineEvents).all() as Array<{
    engine: string;
    event: string;
    data: string;
  }>;
  return rows
    .filter((r) => r.engine === "goalEngine" && (!event || r.event === event))
    .map((r) => ({ engine: r.engine, event: r.event, data: safeJson(r.data) }));
}

function safeJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return {}; }
}

function makeUntranslatableEntry(
  overrides: Partial<InsightLedgerEntry> = {},
): InsightLedgerEntry {
  // An action that the translator cannot parse into any concrete primitive
  // (no ratio/ttl/gate/archive/artifact/verification/rewrite pattern), so
  // `translateAction` returns `primitive: "none"`. The action text is
  // generic on purpose — the classifier should bucket it as the `other`
  // family, which is exactly the catch-all path the production logs hit.
  return {
    id: `il_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    cycleNumber: 1,
    createdAt: Date.now(),
    insight: "threading layer absent across KB entries",
    proposedAction: "Tag every KB entry to an investigation thread.",
    sourceId: `evo_test_${Math.random().toString(36).slice(2, 8)}`,
    status: "proposed",
    retryCount: 0,
    ...overrides,
  };
}

describe("GoalEngine.promoteInsightToGoal — primitive fallback reconciliation", () => {
  const SNAP = snapshotEnv();

  before(() => {
    wipeEvents();
    wipeRecs();
  });

  beforeEach(() => {
    __resetRegistryForTests();
    __resetDispatchTelemetryForTests();
    wipeEvents();
    wipeRecs();
    clearAllFlags();
  });

  after(() => {
    __resetRegistryForTests();
    __resetDispatchTelemetryForTests();
    wipeEvents();
    wipeRecs();
    restoreEnv(SNAP);
  });

  // ── (1) legacy behavior preserved when NO fallback covers the action ──────

  it("emits missing-primitive-rec when no registered primitive fallback covers the action (all gates OFF)", async () => {
    // Gates left fully off. The translator may still attach metadata when
    // the translator-dispatch flag is OFF? — no: PR #428 gates metadata
    // attachment behind the dispatch flag. So with gates off, the
    // translation has no `registeredPrimitive` metadata, the bridge
    // short-circuits with `no_metadata`, and the legacy missing-primitive
    // path runs.
    const entry = makeUntranslatableEntry();
    const result = await promoteInsightToGoal(entry);
    assert.equal(result, null, "untranslatable entry should not promote");

    const missing = fetchGoalEngineEvents("missing-primitive-rec");
    assert.equal(
      missing.length,
      1,
      "missing-primitive-rec must still fire when no fallback covers the action",
    );
    assert.equal(missing[0]?.data?.insightId, entry.id);

    const fallback = fetchGoalEngineEvents("primitive-fallback-rec");
    assert.equal(
      fallback.length,
      0,
      "primitive-fallback-rec must NOT fire when no fallback actually ran",
    );
  });

  // ── (2) suppress missing-primitive-rec when fallback dry-run succeeded ────

  it("does NOT emit missing-primitive-rec when the `other` scaffold dry-run covers the action; emits primitive-fallback-rec instead", async () => {
    enableFullOtherFallback();
    registerOtherPrimitive();

    const entry = makeUntranslatableEntry();
    const result = await promoteInsightToGoal(entry);
    assert.equal(result, null, "fallback-covered entry still does not promote");

    const missing = fetchGoalEngineEvents("missing-primitive-rec");
    assert.equal(
      missing.length,
      0,
      "missing-primitive-rec must NOT fire when the fallback dry-run covered the action",
    );

    const fallback = fetchGoalEngineEvents("primitive-fallback-rec");
    assert.equal(
      fallback.length,
      1,
      "exactly one primitive-fallback-rec event must fire on a successful fallback dry-run",
    );
    const payload = fallback[0]!.data ?? {};
    assert.equal(payload.insightId, entry.id);
    assert.equal(payload.family, "other");
    assert.ok(
      typeof payload.primitiveId === "string" && payload.primitiveId.length > 0,
      "primitive-fallback-rec must surface the resolved primitive id",
    );
    assert.equal(payload.dryRun, true);
    assert.equal(payload.classificationStatus, "unclassified-pending");
    assert.ok(
      typeof payload.reason === "string" && payload.reason.length > 0,
      "primitive-fallback-rec must surface a reason string",
    );
  });

  // ── (3) no non-dry-run side effects on the fallback path ──────────────────

  it("fallback dry-run does NOT mutate the ledger entry, register a rule, or create a goal", async () => {
    enableFullOtherFallback();
    registerOtherPrimitive();

    const goalsBefore = getGoals().goals.length;
    const rulesBefore = getAllActiveRules().length;
    const entry = makeUntranslatableEntry();

    await promoteInsightToGoal(entry);

    assert.equal(entry.status, "proposed", "ledger entry status must remain proposed");
    assert.equal(entry.primitive, undefined, "no primitive should be stamped");
    assert.equal(entry.ruleId, undefined, "no ruleId should be stamped");
    assert.equal(entry.goalId, undefined, "no goalId should be stamped");
    assert.equal(
      getAllActiveRules().length,
      rulesBefore,
      "no enforcement rule must be registered on the fallback path",
    );
    assert.equal(
      getGoals().goals.length,
      goalsBefore,
      "no goal must be created on the fallback path",
    );
    // The missing-primitive SelfRec proposal is also suppressed (so it
    // does not double-count as a gap signal).
    const recRows = db.select().from(selfRecommendations).all();
    assert.equal(
      recRows.length,
      0,
      "no missing-primitive SelfRecommendation must be proposed on the fallback path",
    );
  });
});
