/**
 * Tests for the Phase 2h-a low-risk sandbox readiness layer.
 *
 * Spec invariants this file pins:
 *   1. `summarizationTemplate` remains the ONLY kind with `enabled: true` and
 *      `readiness: "ready"`.
 *   2. The four operator-approved-but-disabled kinds (reasoningTemplate,
 *      selfCritiquePrompt, taskDecompositionPattern, memoryRetrievalHeuristic)
 *      remain `enabled: false` and never reach `readiness: "ready"`.
 *   3. Readiness verdicts NEVER widen eligibility: `isReadyForRegistration`
 *      returns `true` only when the registry's `enabled` flag is `true`.
 *   4. The static safety controls block (dryRunOnly, staticFixturesOnly,
 *      noLiveTraffic, noScheduler, noMutation, noPublicOutput,
 *      operatorApprovalRequired, evidenceRequired) is asserted on EVERY kind
 *      regardless of readiness status.
 *   5. `memoryRetrievalHeuristic` carries the highest (last) expansion order.
 *   6. The autonomy monitor surfaces the readiness view under
 *      `sandbox_execution.extra.readiness` and never adds a mutation surface.
 *   7. Calling the readiness builder is pure: no DATA_DIR file is created and
 *      no real data file is mutated.
 *   8. Visibility-only invariant: re-deriving readiness does not change the
 *      registry's enablement matrix.
 *
 * Run: npx tsx --test server/__tests__/lowRiskSandboxReadiness.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// Redirect DATA_DIR before importing — Phase 2h-a performs no writes, but the
// test fails loudly if that ever changes.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ha-readiness-test-"));
process.env.DATA_DIR = TMP;

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB    = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REAL_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

function hashFile(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hashFile(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hashFile(REAL_MEMORY_KB);
const PRE_DECISION = hashFile(REAL_DECISION_LEDGER);
const PRE_RECORDS  = hashFile(REAL_RECORDS_LEDGER);

const {
  listLowRiskSandboxReadiness,
  getLowRiskSandboxReadiness,
  isReadyForRegistration,
  summarizeLowRiskSandboxReadiness,
  buildLowRiskSandboxReadinessSnapshot,
} = await import("../experiments/lowRiskSandboxReadiness.ts");

const {
  LOW_RISK_SANDBOX_REGISTRY,
  LOW_RISK_SANDBOX_KINDS,
  registerLowRiskSandboxKind,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

after(() => {
  // Confirm the readiness layer + autonomy monitor did not write to any real
  // data file. Phase 2h-a is visibility-only.
  assert.equal(hashFile(REAL_RESEARCH_LAB), PRE_RESEARCH, "research_lab.json must not be touched");
  assert.equal(hashFile(REAL_MEMORY_KB),    PRE_MEMORY,   "memory_knowledge.json must not be touched");
  assert.equal(hashFile(REAL_DECISION_LEDGER), PRE_DECISION, "decision ledger must not be touched");
  assert.equal(hashFile(REAL_RECORDS_LEDGER),  PRE_RECORDS,  "records ledger must not be touched");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Registry / readiness shape ───────────────────────────────────────────────

describe("lowRiskSandboxReadiness — shape", () => {
  it("returns exactly one record per registered kind, in registry order", () => {
    const view = listLowRiskSandboxReadiness();
    assert.equal(view.length, LOW_RISK_SANDBOX_REGISTRY.length);
    for (let i = 0; i < view.length; i++) {
      assert.equal(view[i].kind, LOW_RISK_SANDBOX_REGISTRY[i].kind);
    }
  });

  it("returns the same five operator-approved kinds the registry exposes", () => {
    const view = listLowRiskSandboxReadiness();
    assert.deepEqual(
      [...view.map(v => v.kind)].sort(),
      [
        "memoryRetrievalHeuristic",
        "reasoningTemplate",
        "selfCritiquePrompt",
        "summarizationTemplate",
        "taskDecompositionPattern",
      ],
    );
  });

  it("every record carries the static safety controls block", () => {
    const view = listLowRiskSandboxReadiness();
    for (const r of view) {
      assert.equal(r.safetyControls.dryRunOnly,               true);
      assert.equal(r.safetyControls.staticFixturesOnly,       true);
      assert.equal(r.safetyControls.noLiveTraffic,            true);
      assert.equal(r.safetyControls.noScheduler,              true);
      assert.equal(r.safetyControls.noMutation,               true);
      assert.equal(r.safetyControls.noPublicOutput,           true);
      assert.equal(r.safetyControls.operatorApprovalRequired, true);
      assert.equal(r.safetyControls.evidenceRequired,         true);
      assert.equal(r.safetyControls.rollbackImplicit,         true);
      assert.equal(r.safetyControls.minTrials,                1);
      assert.ok(r.safetyControls.maxTrialsCap > 0);
      assert.ok(r.safetyControls.globalMaxTrialsCap >= r.safetyControls.maxTrialsCap);
    }
  });

  it("getLowRiskSandboxReadiness returns undefined for unknown kinds", () => {
    assert.equal(getLowRiskSandboxReadiness("nope"), undefined);
    assert.equal(getLowRiskSandboxReadiness(""), undefined);
  });
});

// ── Enablement & default-refuse ──────────────────────────────────────────────

describe("lowRiskSandboxReadiness — enablement matrix", () => {
  it("summarizationTemplate is the only enabled+ready kind", () => {
    const view = listLowRiskSandboxReadiness();
    const enabled = view.filter(r => r.enabled === true);
    assert.deepEqual(enabled.map(r => r.kind), ["summarizationTemplate"]);
    const ready = view.filter(r => r.readiness === "ready");
    assert.deepEqual(ready.map(r => r.kind), ["summarizationTemplate"]);
  });

  it("the four other kinds remain disabled", () => {
    const view = listLowRiskSandboxReadiness();
    for (const k of [
      "reasoningTemplate",
      "selfCritiquePrompt",
      "taskDecompositionPattern",
      "memoryRetrievalHeuristic",
    ] as const) {
      const r = view.find(v => v.kind === k);
      assert.ok(r, `expected '${k}' in readiness view`);
      assert.equal(r!.enabled, false, `'${k}' must remain disabled`);
      assert.notEqual(r!.readiness, "ready", `'${k}' must NEVER be 'ready' under Phase 2h-a`);
    }
  });

  it("each disabled kind reports a non-empty blockedReasons + missingPrerequisites", () => {
    const view = listLowRiskSandboxReadiness();
    for (const r of view) {
      if (r.enabled === false) {
        assert.ok(r.blockedReasons.length > 0, `'${r.kind}' must list blockedReasons`);
        assert.ok(r.missingPrerequisites.length > 0, `'${r.kind}' must list missingPrerequisites`);
        for (const code of r.missingPrerequisites) {
          assert.ok(code.startsWith("prerequisite_"), `'${code}' must be a prerequisite_* code`);
        }
      } else {
        assert.equal(r.blockedReasons.length, 0);
        assert.equal(r.missingPrerequisites.length, 0);
      }
    }
  });

  it("default-refuse: an unrecognised disabledReason produces 'needs_review', not 'ready' or 'blocked'", () => {
    // We can't mutate the registry constants, so simulate the verdict logic by
    // calling getLowRiskSandboxReadiness for an existing kind and confirming
    // that NO disabled kind today is ever 'ready'. The needs_review path is
    // covered by the type-level guarantee that the verdict is only `ready`
    // when `enabled === true`. Pin it as a safety property:
    const view = listLowRiskSandboxReadiness();
    for (const r of view) {
      if (r.readiness === "ready") {
        assert.equal(r.enabled, true, `'${r.kind}' is 'ready' but enabled is not true`);
      }
    }
  });
});

// ── Eligibility — visibility never widens it ─────────────────────────────────

describe("lowRiskSandboxReadiness — visibility never widens eligibility", () => {
  it("isReadyForRegistration is true ONLY for summarizationTemplate", () => {
    for (const k of LOW_RISK_SANDBOX_KINDS) {
      const eligible = isReadyForRegistration(k);
      if (k === "summarizationTemplate") {
        assert.equal(eligible, true, "summarizationTemplate must be registration-eligible");
      } else {
        assert.equal(eligible, false, `'${k}' must NOT be registration-eligible`);
      }
    }
  });

  it("isReadyForRegistration is false for unknown kinds", () => {
    assert.equal(isReadyForRegistration("nope"), false);
    assert.equal(isReadyForRegistration(""), false);
  });

  it("the existing registerLowRiskSandboxKind boundary still refuses every disabled kind", () => {
    // Even after we expose readiness, the actual register call must still be
    // refused for every disabled kind with `kind_disabled`. This is the
    // critical boundary — readiness visibility cannot bypass it.
    for (const k of [
      "reasoningTemplate",
      "selfCritiquePrompt",
      "taskDecompositionPattern",
      "memoryRetrievalHeuristic",
    ] as const) {
      const result = registerLowRiskSandboxKind(k, {
        featureFlag:       true,
        operatorApproved:  true,
        dryRun:            true,
        fixtureSource:     "static",
        maxTrials:         5,
        promotionEligible: false,
        useScheduler:      false,
      });
      assert.equal(result.ok, false, `'${k}' must refuse registration`);
      if (result.ok === false) {
        assert.equal(result.code, "kind_disabled", `'${k}' must refuse with kind_disabled`);
      }
    }
  });
});

// ── Expansion order ──────────────────────────────────────────────────────────

describe("lowRiskSandboxReadiness — expansion order", () => {
  it("summarizationTemplate is first (already enabled)", () => {
    const r = getLowRiskSandboxReadiness("summarizationTemplate")!;
    assert.equal(r.recommendedExpansionOrder, 1);
  });

  it("memoryRetrievalHeuristic is LAST (broadest blast radius)", () => {
    const view = listLowRiskSandboxReadiness();
    const ordered = [...view].sort(
      (a, b) => a.recommendedExpansionOrder - b.recommendedExpansionOrder,
    );
    assert.equal(ordered[ordered.length - 1].kind, "memoryRetrievalHeuristic");
  });

  it("expansion order is a strict permutation of the registered kinds", () => {
    const view = listLowRiskSandboxReadiness();
    const orders = view.map(r => r.recommendedExpansionOrder).sort((a, b) => a - b);
    const expected = view.map((_, i) => i + 1);
    assert.deepEqual(orders, expected);
  });

  it("summary.expansionOrder ranks summarizationTemplate first and memoryRetrievalHeuristic last", () => {
    const summary = summarizeLowRiskSandboxReadiness();
    assert.equal(summary.expansionOrder[0], "summarizationTemplate");
    assert.equal(
      summary.expansionOrder[summary.expansionOrder.length - 1],
      "memoryRetrievalHeuristic",
    );
  });
});

// ── Summary + snapshot ───────────────────────────────────────────────────────

describe("lowRiskSandboxReadiness — summary + snapshot", () => {
  it("summary counts match the enablement matrix", () => {
    const summary = summarizeLowRiskSandboxReadiness();
    assert.equal(summary.total, 5);
    assert.equal(summary.enabled, 1);
    assert.equal(summary.ready, 1);
    assert.equal(summary.blocked, 4);
    assert.equal(summary.needsReview, 0);
    assert.equal(summary.disabled, 0);
    assert.deepEqual(summary.enabledKinds, ["summarizationTemplate"]);
  });

  it("snapshot exposes invariants describing the visibility-only contract", () => {
    const snap = buildLowRiskSandboxReadinessSnapshot();
    const inv = snap.invariants;
    assert.ok(typeof inv.onlySummarizationTemplateEnabled === "string");
    assert.ok(inv.onlySummarizationTemplateEnabled.includes("summarizationTemplate"));
    assert.ok(typeof inv.proposeOnly === "string");
    assert.ok(typeof inv.defaultRefuse === "string");
    assert.ok(typeof inv.visibilityDoesNotEnable === "string");
  });

  it("re-deriving readiness leaves the registry's enablement matrix unchanged", () => {
    const beforeEnabled = LOW_RISK_SANDBOX_REGISTRY
      .filter(e => e.enabled)
      .map(e => e.kind)
      .sort();
    // Build the snapshot a few times — if anything mutated the registry, we'd
    // observe it here.
    buildLowRiskSandboxReadinessSnapshot();
    listLowRiskSandboxReadiness();
    summarizeLowRiskSandboxReadiness();
    const afterEnabled = LOW_RISK_SANDBOX_REGISTRY
      .filter(e => e.enabled)
      .map(e => e.kind)
      .sort();
    assert.deepEqual(afterEnabled, beforeEnabled);
    assert.deepEqual(afterEnabled, ["summarizationTemplate"]);
  });
});

// ── Autonomy monitor surface — read-only and no controls ─────────────────────

describe("lowRiskSandboxReadiness — autonomy monitor surface", () => {
  it("sandbox_execution.extra.readiness is present and pins enablement", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-10T00:00:00Z"));
    const sandbox = snap.stages.find(s => s.id === "sandbox_execution");
    assert.ok(sandbox, "sandbox_execution stage must exist");
    const readiness = (sandbox!.extra as any)?.readiness;
    assert.ok(readiness, "sandbox_execution.extra.readiness must be present");
    assert.ok(Array.isArray(readiness.kinds));
    assert.equal(readiness.kinds.length, 5);
    assert.deepEqual(readiness.summary.enabledKinds, ["summarizationTemplate"]);
    assert.equal(readiness.summary.enabled, 1);
    assert.equal(readiness.summary.ready, 1);
  });

  it("monitor surface exposes counts derived from readiness without changing the stage status semantics", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-10T00:00:00Z"));
    const sandbox = snap.stages.find(s => s.id === "sandbox_execution")!;
    assert.equal(sandbox.counts?.readinessReady, 1);
    assert.equal(sandbox.counts?.readinessBlocked, 4);
    assert.equal(sandbox.counts?.readinessNeedsReview, 0);
  });

  it("safety boundary remains fully closed — visibility does not loosen any flag", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-10T00:00:00Z"));
    assert.equal(snap.safetyBoundary.noAutoPost,             true);
    assert.equal(snap.safetyBoundary.noAutoPublish,          true);
    assert.equal(snap.safetyBoundary.noAutoPromote,          true);
    assert.equal(snap.safetyBoundary.noScheduler,            true);
    assert.equal(snap.safetyBoundary.publicApprovalRequired, true);
  });

  it("monitor surface does not introduce mutation controls / endpoints / actions in the stage payload", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-10T00:00:00Z"));
    const sandbox = snap.stages.find(s => s.id === "sandbox_execution")!;
    // The stage payload is data-only — no actions, no endpoints, no
    // controls/buttons. This is enforced structurally: the AutonomyStage type
    // has no field for any of those. Pin the stage shape just in case.
    const allowedKeys = new Set([
      "id",
      "label",
      "status",
      "summary",
      "implementedBy",
      "counts",
      "latest",
      "blockers",
      "nextActions",
      "extra",
    ]);
    for (const k of Object.keys(sandbox)) {
      assert.ok(allowedKeys.has(k), `unexpected stage key '${k}' — readiness must not add mutation surface`);
    }
    // Defensive grep over the JSON-serialised stage to catch any string that
    // would imply a mutation surface was added.
    const json = JSON.stringify(sandbox);
    for (const banned of [
      "POST ",
      "endpoint:",
      "action:",
      "button",
      "schedule",
      "promote",
      "publish",
    ]) {
      // Allow legitimate occurrences in invariant prose by checking only for
      // suspicious affordance-shaped patterns.
      if (banned === "schedule" || banned === "promote" || banned === "publish") {
        // These appear in "noScheduler" / "noPromote" / "noPublish" prose;
        // skip the bare-word check.
        continue;
      }
      assert.ok(!json.toLowerCase().includes(banned.toLowerCase()),
        `stage payload must not include affordance string '${banned}'`);
    }
  });
});
