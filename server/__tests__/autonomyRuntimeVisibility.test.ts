/**
 * Tests for the Phase 2f-b Autonomy Runtime Visibility block.
 *
 * Spec invariants this file pins:
 *   1. The runtime block is present on every snapshot returned by
 *      `buildAutonomyMonitorSnapshot()` and exposes the fields the UI relies
 *      on (freshness, build, newAutonomyPath, legacyRuntime,
 *      changesSinceLastRefresh).
 *   2. The block is read-only — calling `buildAutonomyRuntimeVisibility()`
 *      and `buildAutonomyMonitorSnapshot()` repeatedly does NOT create new
 *      ledger files under DATA_DIR or mutate real repo data files.
 *   3. The five safety flags on the new-autonomy-path block remain `true`
 *      regardless of runtime activity. There is no way for a value of
 *      `false` to appear here.
 *   4. The legacy-runtime block describes itself as read-only and records
 *      best-effort engine_runs metadata. When no rows exist, fields are
 *      null / 0 — never throws.
 *   5. Best-effort build metadata reads commonly-present env vars
 *      (RAILWAY_GIT_COMMIT_SHA, RAILWAY_DEPLOYMENT_ID, NODE_ENV, etc.).
 *      Missing env values surface as null, not as fabricated strings.
 *   6. Freshness inference: with at least one decision event in the last
 *      24h, freshness is "running"; with everything stale and uptime > 10m,
 *      freshness is "stale".
 *   7. The `changesSinceLastRefresh` field is not available — it is an
 *      explicit read-only placeholder rather than client-mutated state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2fb-runtime-test-"));
process.env.DATA_DIR = TMP;

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB     = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB        = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER  = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REAL_RECORDS_LEDGER   = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

function hash(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const PRE_RESEARCH = hash(REAL_RESEARCH_LAB);
const PRE_MEMORY   = hash(REAL_MEMORY_KB);
const PRE_DECISION = hash(REAL_DECISION_LEDGER);
const PRE_RECORDS  = hash(REAL_RECORDS_LEDGER);

const {
  buildAutonomyRuntimeVisibility,
} = await import("../autonomyRuntimeVisibility.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

const {
  appendDecisionEvent,
} = await import("../experiments/hypothesisDecisionEvents.ts");

describe("autonomyRuntimeVisibility — shape + read-only", () => {
  after(() => {
    assert.equal(hash(REAL_RESEARCH_LAB), PRE_RESEARCH, "research_lab.json must not be touched");
    assert.equal(hash(REAL_MEMORY_KB),    PRE_MEMORY,   "memory_knowledge.json must not be touched");
    assert.equal(hash(REAL_DECISION_LEDGER), PRE_DECISION, "decision ledger must not be touched");
    assert.equal(hash(REAL_RECORDS_LEDGER),  PRE_RECORDS,  "records ledger must not be touched");
  });

  it("returns a fully-shaped runtime block", () => {
    const rt = buildAutonomyRuntimeVisibility(new Date("2026-05-10T12:00:00Z"));
    assert.equal(typeof rt.freshness, "string");
    assert.ok(["running", "stale", "blocked", "unknown"].includes(rt.freshness));
    assert.equal(typeof rt.freshnessReason, "string");
    assert.ok(rt.freshnessReason.length > 0);
    assert.equal(rt.generatedAt, "2026-05-10T12:00:00.000Z");
    assert.equal(typeof rt.serverStartedAt, "string");
    assert.ok(rt.serverStartedAt.length > 0);
    assert.ok(rt.uptimeSeconds >= 0);
    assert.equal(typeof rt.build.nodeVersion, "string");
    assert.ok(rt.build.nodeVersion.startsWith("v"));
    // package.json sits at repo root; it should be readable in tests.
    assert.equal(typeof rt.build.packageVersion, "string");
  });

  it("safety flags on newAutonomyPath are all true", () => {
    const rt = buildAutonomyRuntimeVisibility();
    const sf = rt.newAutonomyPath.safetyFlags;
    assert.equal(sf.noAutoPost, true);
    assert.equal(sf.noAutoPublish, true);
    assert.equal(sf.noAutoPromote, true);
    assert.equal(sf.noScheduler, true);
    assert.equal(sf.publicApprovalRequired, true);
  });

  it("legacy block declares itself read-only and tolerates empty engine_runs", () => {
    const rt = buildAutonomyRuntimeVisibility();
    assert.match(rt.legacyRuntime.label.toLowerCase(), /legacy/);
    // Description must clearly say no controls / read-only on this panel
    // — the description is what makes the legacy/new separation legible.
    assert.match(rt.legacyRuntime.description.toLowerCase(), /read-only|no controls/);
    // With a fresh DATA_DIR, no engine_runs rows exist and the fields fall
    // back to null / 0 without throwing.
    assert.ok(rt.legacyRuntime.runsLast24h >= 0);
    assert.ok(rt.legacyRuntime.errorsLast24h >= 0);
  });

  it("changesSinceLastRefresh is unavailable (read-only placeholder)", () => {
    const rt = buildAutonomyRuntimeVisibility();
    assert.equal(rt.changesSinceLastRefresh.available, false);
    assert.ok(rt.changesSinceLastRefresh.note.length > 20);
  });

  it("snapshot includes runtime block alongside stages", () => {
    const snap = buildAutonomyMonitorSnapshot(new Date("2026-05-10T12:00:00Z"));
    assert.ok(snap.runtime);
    assert.equal(snap.runtime.generatedAt, "2026-05-10T12:00:00.000Z");
    // Stages survive — Phase 2f-a invariant must not regress.
    assert.equal(snap.stages.length, 11);
    // Safety boundary still all true.
    assert.equal(snap.safetyBoundary.noAutoPost, true);
    assert.equal(snap.safetyBoundary.publicApprovalRequired, true);
  });

  it("calling the runtime builder is read-only — no new files in DATA_DIR", () => {
    const beforeList = new Set(fs.readdirSync(TMP));
    buildAutonomyRuntimeVisibility();
    buildAutonomyRuntimeVisibility();
    buildAutonomyMonitorSnapshot();
    const afterList = new Set(fs.readdirSync(TMP));
    // db.ts may have created agent306.db on first import; that already
    // appeared in beforeList. The subsequent calls must add nothing new.
    assert.deepEqual([...afterList].sort(), [...beforeList].sort());
  });
});

describe("autonomyRuntimeVisibility — env-driven build metadata", () => {
  const ENV_BACKUP: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "RAILWAY_GIT_COMMIT_SHA",
    "RAILWAY_DEPLOYMENT_ID",
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_REGION",
    "GIT_COMMIT_SHA",
    "GIT_COMMIT",
    "COMMIT_SHA",
    "SOURCE_COMMIT",
    "DEPLOY_ID",
    "ENVIRONMENT",
  ];

  before(() => {
    for (const k of ENV_KEYS) {
      ENV_BACKUP[k] = process.env[k];
      delete process.env[k];
    }
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (ENV_BACKUP[k] === undefined) delete process.env[k];
      else process.env[k] = ENV_BACKUP[k];
    }
  });

  it("missing env vars surface as null, not as fabricated strings", () => {
    const rt = buildAutonomyRuntimeVisibility();
    assert.equal(rt.build.commitSha, null);
    assert.equal(rt.build.commitShortSha, null);
    assert.equal(rt.build.deployId, null);
    assert.equal(rt.build.environment, null);
    assert.equal(rt.build.railwayProjectId, null);
    assert.equal(rt.build.railwayServiceId, null);
    assert.equal(rt.build.railwayRegion, null);
  });

  it("RAILWAY_GIT_COMMIT_SHA and RAILWAY_DEPLOYMENT_ID flow through to build info", () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
    process.env.RAILWAY_DEPLOYMENT_ID  = "dep_test_123";
    process.env.RAILWAY_ENVIRONMENT_NAME = "production";
    process.env.RAILWAY_PROJECT_ID = "proj_test";
    process.env.RAILWAY_SERVICE_ID = "svc_test";
    try {
      const rt = buildAutonomyRuntimeVisibility();
      assert.equal(rt.build.commitSha, "0123456789abcdef0123456789abcdef01234567");
      assert.equal(rt.build.commitShortSha, "0123456");
      assert.equal(rt.build.deployId, "dep_test_123");
      assert.equal(rt.build.environment, "production");
      assert.equal(rt.build.railwayProjectId, "proj_test");
      assert.equal(rt.build.railwayServiceId, "svc_test");
    } finally {
      delete process.env.RAILWAY_GIT_COMMIT_SHA;
      delete process.env.RAILWAY_DEPLOYMENT_ID;
      delete process.env.RAILWAY_ENVIRONMENT_NAME;
      delete process.env.RAILWAY_PROJECT_ID;
      delete process.env.RAILWAY_SERVICE_ID;
    }
  });

  it("falls back to non-Railway env names (GIT_COMMIT_SHA, DEPLOY_ID, ENVIRONMENT)", () => {
    process.env.GIT_COMMIT_SHA = "abcdef0abcdef0abcdef0abcdef0abcdef0abcd0";
    process.env.DEPLOY_ID      = "deploy_local_77";
    process.env.ENVIRONMENT    = "preview";
    try {
      const rt = buildAutonomyRuntimeVisibility();
      assert.equal(rt.build.commitSha, "abcdef0abcdef0abcdef0abcdef0abcdef0abcd0");
      assert.equal(rt.build.commitShortSha, "abcdef0");
      assert.equal(rt.build.deployId, "deploy_local_77");
      assert.equal(rt.build.environment, "preview");
    } finally {
      delete process.env.GIT_COMMIT_SHA;
      delete process.env.DEPLOY_ID;
      delete process.env.ENVIRONMENT;
    }
  });
});

describe("autonomyRuntimeVisibility — freshness inference", () => {
  it("recent decision event => freshness running", () => {
    // Seed one recent decision event.
    const res = appendDecisionEvent({
      decision: {
        hypothesisId: "hyp-runtime-1",
        metricKey:    "summary_quality_score",
        verdict:      "promote",
        reasonCode:   "primary_metric_better",
        reason:       "seed for runtime test",
        evidence:     ["seed"],
        decidedAt:    new Date().toISOString(),
        thresholdsUsed: {
          minSamplesPerArm:            30,
          minDeltaForPromote:          0.01,
          maxGuardrailRegressionRatio: 0.05,
          costRegressionTolerance:     0.10,
        },
      } as any,
      source: "test:autonomyRuntimeVisibility",
      ruleVersion: "phase2c.v1",
    });
    assert.equal((res as any).ok, true);
    const rt = buildAutonomyRuntimeVisibility();
    assert.equal(rt.freshness, "running");
    assert.match(rt.freshnessReason, /decision_events/);
    assert.ok(rt.newAutonomyPath.activity.decisionEventsLast24h >= 1);
    assert.notEqual(rt.newAutonomyPath.latestDecisionAt, null);
  });
});
