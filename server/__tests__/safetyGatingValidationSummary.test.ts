/**
 * Tests for Phase 2m-d — typed `manualValidation` shape and the read-only
 * safety-gating validation summary helper.
 *
 * Pinned invariants:
 *
 *   1. `HypothesisManualValidation` accepts a record matching the shape
 *      recorded under PR #327 (schemaVersion, label, metricKey, source,
 *      operator, status, violationCount, findingsPassed, warnings,
 *      blockers, disclaimer, validatedAt/runLabel).
 *   2. `summarizeSafetyGatingValidation` detects the safety-gating
 *      hypothesis by id either when handed directly or when handed a
 *      list of hypotheses.
 *   3. With PR #327's evidence (measurementPathAccessible=true,
 *      manualValidation.status='ok', violationCount=0) the summary
 *      reports detected=true, measurementPathAccessible=true,
 *      hasManualValidation=true, latestManualValidationStatus='ok',
 *      violationCount=0, passingFindingCount=6, warningsCount=0,
 *      blockersCount=0.
 *   4. `canFeedExperiment` still refuses — the hypothesis is operator-
 *      gated (hygieneTag='needs_review' / rubricVerdict='review'). The
 *      readiness verdict is `ok: false` and the coarse `readiness` is
 *      not `experiment_ready`.
 *   5. Live `data/research_lab.json` matches the summary's expectations:
 *      the safety-gating hypothesis exists, hygieneTag is needs_review,
 *      rubricVerdict is review, status is forming, queue is backlog,
 *      and the manualValidation block records violationCount=0 / ok.
 *   6. The summary does NOT mutate its inputs: deep-equal before/after.
 *   7. Deterministic output: identical inputs produce deep-equal /
 *      byte-identical results across repeated calls.
 *   8. The summary's source module does NOT import the runtime
 *      promotion path: applyRecommendation, canPromote, the scheduler,
 *      the autonomy monitor, the github bridge, the recommendation
 *      engine, the self-evolution engine, the dashboard router, the
 *      database, drizzle, fs, the express router, or any UI surface.
 *      The summary's source must also not reference Date.now /
 *      Math.random / randomUUID / process.env / a wall clock.
 *   9. Live `data/research_lab.json` is unchanged after the test run
 *      (byte-equal snapshot).
 *  10. Missing / empty inputs yield a graceful detected=false summary
 *      with the invariants block embedded.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const SUMMARY_MODULE    = path.join(REPO_ROOT, "server", "eval", "safetyGatingValidationSummary.ts");

const {
  summarizeSafetyGatingValidation,
  serializeSafetyGatingValidationSummary,
  readManualValidation,
  findSafetyGatingHypothesis,
  SAFETY_GATING_HYPOTHESIS_ID,
  SAFETY_GATING_METRIC_KEY,
  SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION,
  SAFETY_GATING_VALIDATION_SUMMARY_LABEL,
  SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS,
} = await import("../eval/safetyGatingValidationSummary.ts");

import type { HypothesisManualValidation } from "../researchEngine.ts";
import type { HygieneAwareHypothesis } from "../hypothesisHygiene.ts";

const PINNED_NOW = "2026-05-12T18:00:00.000Z";

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const REAL_RESEARCH_SNAPSHOT = snapshot(REAL_RESEARCH_LAB);
const ENV_SNAPSHOT           = JSON.stringify(process.env);

after(() => {
  const after_ = snapshot(REAL_RESEARCH_LAB);
  if (REAL_RESEARCH_SNAPSHOT.exists) {
    if (!after_.exists) throw new Error("Phase 2m-d tests removed live research_lab.json!");
    if (after_.content !== REAL_RESEARCH_SNAPSHOT.content) {
      throw new Error("Phase 2m-d tests mutated live research_lab.json!");
    }
  } else {
    if (after_.exists) throw new Error("Phase 2m-d tests created live research_lab.json!");
  }
  const beforeEnv = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (beforeEnv[key] !== process.env[key]) {
      throw new Error(`Phase 2m-d tests mutated env var ${key}`);
    }
  }
});

// ── Fixture builders ─────────────────────────────────────────────────────────

const PR327_MANUAL_VALIDATION: HypothesisManualValidation = {
  phase:         "phase2m-c",
  schemaVersion: "phase2m-b.v1",
  label:         "agent306.promotion_boundary_audit",
  metricKey:     "promotion_boundary_violation_count",
  validatedAt:   "2026-05-12T17:00:00.000Z",
  source:        "manual:railway",
  operator:      "ray",
  runLabel:      "phase2m-c-validation-2026-05-12",
  environment:   "production-railway",
  status:        "ok",
  violationCount: 0,
  findingsPassed: [
    "promotion_gate_exports_canPromote",
    "apply_recommendation_function_exists",
    "applyRecommendation_calls_canPromote_before_applied_write",
    "applyRecommendation_requires_approved_status",
    "single_write_site_for_status_applied",
    "engine_applied_writes_inside_applyRecommendation",
  ],
  warnings:   [],
  blockers:   [],
  note:       "fixture",
  disclaimer: "violationCount=0 is evidence, NOT authorisation.",
};

function buildSafetyGatingHypothesisFixture(
  overrides: Partial<HygieneAwareHypothesis> = {},
): HygieneAwareHypothesis {
  return {
    id:             SAFETY_GATING_HYPOTHESIS_ID,
    claim:          "Single-write-boundary invariant holds across promotion paths.",
    basis:          "PR #325 — formal hypothesis basis.",
    metric:         SAFETY_GATING_METRIC_KEY,
    prediction:     "promotion_boundary_violation_count = 0.",
    timeframe:      "next 1-2 Phase 2 review cycles",
    status:         "forming",
    confidence:     "medium",
    formedAt:       "2026-05-12T00:00:00.000Z",
    source:         "manual",
    queue:          "backlog",
    stake:          "high",
    triageConfidence: "high",
    domain:         "foundational",
    measurementPath: "Static audit of promotion paths.",
    measurementPathAccessible: true,
    hygieneTag:     "needs_review",
    hygieneReason:  "Operator-gated.",
    rubricVerdict:  "review",
    rubricBlockedReason: "Operator-gated review pending.",
    manualValidation: PR327_MANUAL_VALIDATION,
    ...overrides,
  } as HygieneAwareHypothesis;
}

// ── Type acceptance ─────────────────────────────────────────────────────────

describe("Phase 2m-d — HypothesisManualValidation typed shape", () => {
  it("accepts the PR #327-shaped evidence record without `any`", () => {
    const mv: HypothesisManualValidation = PR327_MANUAL_VALIDATION;
    assert.equal(mv.status, "ok");
    assert.equal(mv.violationCount, 0);
    assert.equal(mv.metricKey, "promotion_boundary_violation_count");
    assert.equal(mv.label, "agent306.promotion_boundary_audit");
    assert.ok(Array.isArray(mv.findingsPassed));
    assert.equal((mv.findingsPassed ?? []).length, 6);
  });

  it("attaches to a Hypothesis under `manualValidation`", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    assert.ok(hyp.manualValidation);
    assert.equal(hyp.manualValidation!.status, "ok");
    assert.equal(hyp.manualValidation!.metricKey, hyp.metric);
  });

  it("readManualValidation rejects structurally-invalid records", () => {
    assert.equal(readManualValidation(null), null);
    assert.equal(readManualValidation(undefined), null);
    assert.equal(readManualValidation("string"), null);
    assert.equal(readManualValidation([]), null);
    assert.equal(readManualValidation({}), null);
    assert.equal(readManualValidation({ label: "x" }), null);
    assert.equal(readManualValidation({ label: "x", metricKey: "y" }), null);
    assert.equal(readManualValidation({ label: "x", metricKey: "y", status: "bogus" }), null);
    const ok = readManualValidation({ label: "x", metricKey: "y", status: "ok" });
    assert.ok(ok);
    assert.equal(ok!.status, "ok");
  });
});

// ── Detection ───────────────────────────────────────────────────────────────

describe("Phase 2m-d — summary detection by id", () => {
  it("detects the safety-gating hypothesis when passed directly", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.equal(s.detected, true);
    assert.equal(s.hypothesisId, SAFETY_GATING_HYPOTHESIS_ID);
    assert.equal(s.metricKey, SAFETY_GATING_METRIC_KEY);
  });

  it("detects the safety-gating hypothesis inside a list by id", () => {
    const decoy: HygieneAwareHypothesis = {
      ...buildSafetyGatingHypothesisFixture(),
      id: "hyp_some_other_thing",
    };
    const target = buildSafetyGatingHypothesisFixture();
    const found = findSafetyGatingHypothesis([decoy, target]);
    assert.ok(found);
    assert.equal(found!.id, SAFETY_GATING_HYPOTHESIS_ID);

    const s = summarizeSafetyGatingValidation({ hypotheses: [decoy, target] });
    assert.equal(s.detected, true);
    assert.equal(s.hypothesisId, SAFETY_GATING_HYPOTHESIS_ID);
  });

  it("returns a graceful detected=false summary with no inputs", () => {
    const s = summarizeSafetyGatingValidation({});
    assert.equal(s.detected, false);
    assert.equal(s.hypothesisId, null);
    assert.equal(s.metricKey, null);
    assert.equal(s.hasManualValidation, false);
    assert.equal(s.latestManualValidationStatus, null);
    assert.equal(s.violationCount, null);
    assert.deepEqual(s.invariants, SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS);
  });

  it("returns a graceful detected=false summary on an empty list", () => {
    const s = summarizeSafetyGatingValidation({ hypotheses: [] });
    assert.equal(s.detected, false);
    assert.equal(s.hypothesisId, null);
  });

  it("returns a graceful detected=false summary on a list with no matching id", () => {
    const decoy: HygieneAwareHypothesis = {
      ...buildSafetyGatingHypothesisFixture(),
      id: "hyp_unrelated",
    };
    const s = summarizeSafetyGatingValidation({ hypotheses: [decoy] });
    assert.equal(s.detected, false);
  });
});

// ── Payload fields with PR #327 evidence ────────────────────────────────────

describe("Phase 2m-d — summary fields with PR #327 evidence", () => {
  it("reports measurement accessible + validation ok + violationCount 0", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp, now: PINNED_NOW });
    assert.equal(s.measurementPathAccessible, true);
    assert.equal(s.hasManualValidation, true);
    assert.equal(s.latestManualValidationStatus, "ok");
    assert.equal(s.violationCount, 0);
    assert.equal(s.passingFindingCount, 6);
    assert.equal(s.warningsCount, 0);
    assert.equal(s.blockersCount, 0);
    assert.equal(s.generatedAt, PINNED_NOW);
    assert.equal(s.schemaVersion, SAFETY_GATING_VALIDATION_SUMMARY_SCHEMA_VERSION);
    assert.equal(s.label, SAFETY_GATING_VALIDATION_SUMMARY_LABEL);
    assert.deepEqual(s.invariants, SAFETY_GATING_VALIDATION_SUMMARY_INVARIANTS);
  });

  it("reports measurementPathAccessible=false when the operator never flipped it", () => {
    const hyp = buildSafetyGatingHypothesisFixture({ measurementPathAccessible: false });
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.equal(s.measurementPathAccessible, false);
  });

  it("reports hasManualValidation=false when no record is attached", () => {
    const hyp = buildSafetyGatingHypothesisFixture({ manualValidation: undefined });
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.equal(s.hasManualValidation, false);
    assert.equal(s.latestManualValidationStatus, null);
    assert.equal(s.violationCount, null);
    assert.equal(s.passingFindingCount, 0);
  });

  it("reports a violation status when manualValidation records a violation", () => {
    const hyp = buildSafetyGatingHypothesisFixture({
      manualValidation: {
        ...PR327_MANUAL_VALIDATION,
        status: "violated",
        violationCount: 3,
        warnings: ["drift hint"],
        blockers: ["referenced source missing"],
      },
    });
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.equal(s.latestManualValidationStatus, "violated");
    assert.equal(s.violationCount, 3);
    assert.equal(s.warningsCount, 1);
    assert.equal(s.blockersCount, 1);
  });

  it("ignores a structurally-invalid manualValidation record (no throw)", () => {
    // Cast through unknown to simulate an older or corrupt persisted record.
    const bad: any = { label: "x" };
    const hyp = buildSafetyGatingHypothesisFixture({ manualValidation: bad });
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.equal(s.hasManualValidation, false);
    assert.equal(s.latestManualValidationStatus, null);
  });
});

// ── Readiness gate refuses ──────────────────────────────────────────────────

describe("Phase 2m-d — canFeedExperiment still refuses", () => {
  it("readinessVerdict.ok is false on PR #327 evidence (operator-gated)", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.ok(s.readinessVerdict);
    assert.equal(s.readinessVerdict!.ok, false);
    assert.notEqual(s.readiness, "experiment_ready");
  });

  it("readiness label is not `experiment_ready` while hygieneTag is needs_review", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.notEqual(s.readiness, "experiment_ready");
  });

  it("readiness label is not `experiment_ready` even when manualValidation.status=ok and violationCount=0", () => {
    // Evidence is NOT authorisation.
    const hyp = buildSafetyGatingHypothesisFixture({
      manualValidation: { ...PR327_MANUAL_VALIDATION, status: "ok", violationCount: 0 },
    });
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.notEqual(s.readiness, "experiment_ready");
    assert.equal(s.readinessVerdict!.ok, false);
  });
});

// ── Live research_lab.json shape ────────────────────────────────────────────

describe("Phase 2m-d — live research_lab.json", () => {
  // Read the snapshot captured at module-load time. Concurrent test
  // files in the aggregate runner may swap DATA_DIR or temporarily
  // rewrite live data files; using the snapshot avoids a race against
  // those tests. The after-hook still verifies the snapshot is
  // preserved on disk after the run.
  function loadLiveLab(): any | null {
    if (!REAL_RESEARCH_SNAPSHOT.exists) return null;
    return JSON.parse(REAL_RESEARCH_SNAPSHOT.content as string);
  }

  it("contains the safety-gating hypothesis with PR #327 manualValidation evidence", { skip: !REAL_RESEARCH_SNAPSHOT.exists }, () => {
    const liveLab = loadLiveLab()!;
    const hyp = (liveLab.hypotheses ?? []).find(
      (h: any) => h && h.id === SAFETY_GATING_HYPOTHESIS_ID,
    );
    assert.ok(hyp, "safety-gating hypothesis must exist");
    // Non-readiness invariants — must NOT change.
    assert.equal(hyp.hygieneTag,    "needs_review");
    assert.equal(hyp.rubricVerdict, "review");
    assert.equal(hyp.status,        "forming");
    assert.equal(hyp.queue,         "backlog");
    // PR #327 evidence.
    assert.equal(hyp.measurementPathAccessible, true);
    assert.ok(hyp.manualValidation);
    assert.equal(hyp.manualValidation.status, "ok");
    assert.equal(hyp.manualValidation.violationCount, 0);
    assert.equal(hyp.manualValidation.metricKey, SAFETY_GATING_METRIC_KEY);
  });

  it("summary over the live lab matches PR #327's reported shape", { skip: !REAL_RESEARCH_SNAPSHOT.exists }, () => {
    const liveLab = loadLiveLab()!;
    const s = summarizeSafetyGatingValidation({
      hypotheses: liveLab.hypotheses ?? [],
      now: PINNED_NOW,
    });
    assert.equal(s.detected, true);
    assert.equal(s.hypothesisId, SAFETY_GATING_HYPOTHESIS_ID);
    assert.equal(s.metricKey, SAFETY_GATING_METRIC_KEY);
    assert.equal(s.measurementPathAccessible, true);
    assert.equal(s.hasManualValidation, true);
    assert.equal(s.latestManualValidationStatus, "ok");
    assert.equal(s.violationCount, 0);
    assert.equal(s.warningsCount, 0);
    assert.equal(s.blockersCount, 0);
    assert.notEqual(s.readiness, "experiment_ready");
  });
});

// ── Mutation / determinism ──────────────────────────────────────────────────

describe("Phase 2m-d — mutation / determinism", () => {
  it("does not mutate its inputs", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const before = JSON.stringify(hyp);
    summarizeSafetyGatingValidation({ hypothesis: hyp, now: PINNED_NOW });
    summarizeSafetyGatingValidation({ hypotheses: [hyp], now: PINNED_NOW });
    const after = JSON.stringify(hyp);
    assert.equal(after, before);
  });

  it("does not mutate a passed list", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const list = [hyp];
    const before = JSON.stringify(list);
    summarizeSafetyGatingValidation({ hypotheses: list, now: PINNED_NOW });
    const after = JSON.stringify(list);
    assert.equal(after, before);
  });

  it("is deterministic across repeated calls", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const r1 = summarizeSafetyGatingValidation({ hypothesis: hyp, now: PINNED_NOW });
    const r2 = summarizeSafetyGatingValidation({ hypothesis: hyp, now: PINNED_NOW });
    assert.deepEqual(r1, r2);
    assert.equal(
      serializeSafetyGatingValidationSummary(r1),
      serializeSafetyGatingValidationSummary(r2),
    );
  });

  it("defaults generatedAt to null when no `now` is provided", () => {
    const hyp = buildSafetyGatingHypothesisFixture();
    const s = summarizeSafetyGatingValidation({ hypothesis: hyp });
    assert.equal(s.generatedAt, null);
  });
});

// ── Forbidden runtime wiring ────────────────────────────────────────────────

describe("Phase 2m-d — forbidden runtime wiring (source-level)", () => {
  const summarySrc = fs.readFileSync(SUMMARY_MODULE, "utf8");

  it("does not import the runtime promotion / scheduler / monitor / db / UI surfaces", () => {
    const forbidden = [
      "applyRecommendation",
      "selfRecommendationEngine",
      "selfRecommendationRouter",
      "selfEvolutionEngine",
      "autonomyMonitor",
      "scheduler",
      "githubBridge",
      "dashboardAuth",
      "express",
      "drizzle-orm",
      "drizzle-zod",
      "better-sqlite3",
      "../db",
      "../db.js",
      "../routes",
      "../routes.js",
      "../publicApi",
      "../publicApi.js",
      "node:fs",
      "node:net",
      "node:http",
      "node:https",
    ];
    // Allowed imports: hypothesisHygiene (canFeedExperiment),
    // promotionBoundaryAudit (constants only), researchEngine (types).
    for (const marker of forbidden) {
      assert.equal(
        summarySrc.includes(`from "${marker}"`) ||
        summarySrc.includes(`from '${marker}'`),
        false,
        `safetyGatingValidationSummary.ts must not import ${marker}`,
      );
    }
  });

  it("does not call any wall-clock / randomness / env source", () => {
    // Strip block comments and line comments so we only check actual code,
    // not the docstring (which explicitly names what the module forbids).
    const codeOnly = summarySrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .map(l => l.replace(/\s*\/\/.*$/, ""))
      .join("\n");
    const forbidden = [
      "Date.now",
      "new Date(",
      "Math.random",
      "randomUUID",
      "process.env",
      "fs.writeFile",
      "fs.write",
      "fs.appendFile",
      "fs.readFile",
      "fs.readFileSync",
    ];
    for (const marker of forbidden) {
      assert.equal(
        codeOnly.includes(marker),
        false,
        `safetyGatingValidationSummary.ts must not reference ${marker}`,
      );
    }
  });

  it("is not imported by any runtime-wiring module", () => {
    // Spot-check that the summary helper is wired only to tests (and
    // potentially a future read-only CLI), not to any runtime path.
    const runtimeModules = [
      path.join(REPO_ROOT, "server", "index.ts"),
      path.join(REPO_ROOT, "server", "routes.ts"),
      path.join(REPO_ROOT, "server", "selfRecommendationEngine.ts"),
      path.join(REPO_ROOT, "server", "selfRecommendationRouter.ts"),
      path.join(REPO_ROOT, "server", "selfEvolutionEngine.ts"),
      path.join(REPO_ROOT, "server", "autonomyMonitor.ts"),
      path.join(REPO_ROOT, "server", "publicApi.ts"),
      path.join(REPO_ROOT, "server", "eval", "promotionGate.ts"),
    ];
    for (const m of runtimeModules) {
      if (!fs.existsSync(m)) continue;
      const src = fs.readFileSync(m, "utf8");
      assert.equal(
        src.includes("safetyGatingValidationSummary"),
        false,
        `${m} must not import safetyGatingValidationSummary`,
      );
    }
  });
});
