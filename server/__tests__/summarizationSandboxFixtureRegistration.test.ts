/**
 * Tests for Phase 2i-a — first summarization sandbox registration evidence.
 *
 * Spec invariants this file pins:
 *   1. The Phase 2i-a fixture descriptor is deterministic, contains every
 *      required safety control, and binds to the `summarizationTemplate`
 *      kind only.
 *   2. Executing the fixture path appends exactly ONE Phase 2e-c
 *      registration row, carrying the manifest, snapshot hash, pre-metrics,
 *      rollback steps, operator metadata, and feature-flag state.
 *   3. `sandboxAutoApplyEligible` is `false` even when a caller tries to
 *      override it. `autoApplyPolicy` is `manual-only`.
 *   4. The path refuses any kind other than `summarizationTemplate`. It
 *      writes nothing on refusal.
 *   5. The fixture registers with `dryRun: true`, `fixtureSource: "static"`,
 *      `useScheduler: false`, `promotionEligible: false`. Phase 2e-b
 *      refuses any deviation; the descriptor never produces a deviation.
 *   6. Re-running the executor appends a SECOND row — the ledger is
 *      append-only and prior records are preserved.
 *   7. The autonomy monitor's evidence_package stage surfaces the latest
 *      Phase 2i-a fixture registration metadata when present and degrades
 *      gracefully (zero counts, `latestFixtureRegistration: null`,
 *      `hasFixtureEvidence: false`) when the ledger is empty.
 *   8. The monitor remains read-only: rendering the snapshot does NOT
 *      create or mutate the ledger.
 *   9. Real data fixtures (`research_lab.json`, `memory_knowledge.json`,
 *      Phase 2d ledger) are not mutated by any of these paths.
 *  10. The fixture path produces NO public-action surface, NO scheduler
 *      hook, NO mutation, NO promotion metadata anywhere in the descriptor.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ia-fixture-test-"));
process.env.DATA_DIR = TMP;
// Per-process DB isolation. Same pattern as PR #299
// (claimVerifier.golden.test.ts): autonomyMonitor → autonomyRuntimeVisibility
// → server/db.ts opens a SQLite connection at module load. Without a unique
// DB_PATH this test would open `data/agent306.db` and race the aggregate
// suite's other DB-using files, intermittently masking writes that other
// tests' `beforeEach` performs (notably `repositories.test.ts`'s
// `goalRepository round-trips a blob`). Pointing DB_PATH at this run's
// tmpdir scopes the lock to this process. We do NOT redirect DB_PATH for
// any other test — only this one.
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const LEDGER_FILE = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildSummarizationFixtureRegistrationDescriptor,
  previewSummarizationFixtureRegistration,
  executeSummarizationFixtureRegistration,
  readSummarizationFixtureLedgerSummary,
  SUMMARIZATION_FIXTURE_ID,
  SUMMARIZATION_FIXTURE_KIND,
  SUMMARIZATION_FIXTURE_DEFAULT_SOURCE,
  SUMMARIZATION_FIXTURE_FEATURE_FLAG_NAME,
} = await import("../experiments/summarizationSandboxFixtureRegistration.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
  listLowRiskSandboxRegistrations,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const {
  readRecords,
  readActiveRegistrationRecords,
} = await import("../experiments/sandboxRegistrationRecords.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
const RESEARCH_SNAPSHOT       = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT         = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT   = snapshot(REPO_RECORDS_LEDGER);

before(() => {
  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(LEDGER_FILE); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  // Real data fixtures must be byte-identical after the test run.
  const after = (p: string) => snapshot(p);
  for (const [label, before, p] of [
    ["research_lab.json",                RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",            MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl", DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,  REPO_RECORDS_LEDGER],
  ] as const) {
    const a = after(p);
    if (before.exists) {
      if (!a.exists) throw new Error(`Phase 2i-a tests removed live ${label}!`);
      if (a.content !== before.content) throw new Error(`Phase 2i-a tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`Phase 2i-a tests created live ${label}!`);
    }
  }
});

// ── Descriptor ──────────────────────────────────────────────────────────────

describe("Phase 2i-a — fixture descriptor", () => {
  it("descriptor is deterministic and binds to summarizationTemplate only", () => {
    const a = buildSummarizationFixtureRegistrationDescriptor();
    const b = buildSummarizationFixtureRegistrationDescriptor();
    assert.deepEqual(a, b, "deterministic: same input -> same output");
    assert.equal(a.kind, "summarizationTemplate");
    assert.equal(a.kind, SUMMARIZATION_FIXTURE_KIND);
    assert.equal(a.fixtureId, SUMMARIZATION_FIXTURE_ID);
    assert.match(a.fixtureId, /^phase2i-a:summarizationTemplate:v1$/);
  });

  it("descriptor encodes every required safety control", () => {
    const d = buildSummarizationFixtureRegistrationDescriptor();
    assert.equal(d.controls.featureFlag,       true);
    assert.equal(d.controls.operatorApproved,  true);
    assert.equal(d.controls.dryRun,            true);
    assert.equal(d.controls.fixtureSource,     "static");
    assert.equal(d.controls.useScheduler,      false);
    assert.equal(d.controls.promotionEligible, false);
    assert.ok(Number.isInteger(d.controls.maxTrials) && d.controls.maxTrials >= 1 && d.controls.maxTrials <= 25);
    assert.ok(typeof d.controls.notes === "string" && d.controls.notes!.includes(SUMMARIZATION_FIXTURE_ID));

    assert.ok(Array.isArray(d.rollbackInstructions));
    assert.ok(d.rollbackInstructions.length >= 1);
    for (const step of d.rollbackInstructions) {
      assert.ok(typeof step === "string" && step.trim().length > 0);
    }
    assert.equal(d.featureFlagState.name,    SUMMARIZATION_FIXTURE_FEATURE_FLAG_NAME);
    assert.equal(d.featureFlagState.enabled, true);

    assert.equal(d.sandboxAutoApplyEligible, false);
    assert.equal(d.autoApplyPolicy,          "manual-only");
    assert.equal(d.postMetrics,              null,
      "postMetrics must be null in Phase 2i-a — completion is deferred");
  });

  it("descriptor exposes no public-action / scheduler / mutation / promotion control", () => {
    const d = buildSummarizationFixtureRegistrationDescriptor();
    const json = JSON.stringify(d).toLowerCase();
    // Must not advertise any apply / promote / publish / post / schedule trigger.
    assert.equal(/"autopost"|"autopublish"|"autopromote"|"publishnow"|"postnow"|"schedulercron"/.test(json), false);
    // Must not flip the `useScheduler` / `promotionEligible` keys true.
    assert.equal(/"usescheduler":true/.test(json),      false);
    assert.equal(/"promotioneligible":true/.test(json), false);
    assert.equal(/"sandboxautoapplyeligible":true/.test(json), false);
  });

  it("preview helper is identical to the descriptor builder", () => {
    const d = buildSummarizationFixtureRegistrationDescriptor({ source: "preview-test" });
    const p = previewSummarizationFixtureRegistration({ source: "preview-test" });
    assert.deepEqual(d, p);
  });

  it("preview helper does not write to the ledger", () => {
    const before = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
    previewSummarizationFixtureRegistration();
    previewSummarizationFixtureRegistration();
    const after = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
    assert.equal(after, before, "preview must never write to the ledger");
  });
});

// ── Execution ───────────────────────────────────────────────────────────────

describe("Phase 2i-a — execution path", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(LEDGER_FILE); } catch {}
  });

  it("appends exactly one ledger row with the full manifest + safety state", () => {
    const before = listLowRiskSandboxRegistrations().length;
    const ledgerBefore = readRecords().length;

    const result = executeSummarizationFixtureRegistration({
      source: "test:phase2i-a-fixture",
      now:    new Date("2026-05-10T10:00:00.000Z"),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    // In-memory map grew by 1 (Phase 2e-b) and ledger grew by 1 (Phase 2e-c).
    assert.equal(listLowRiskSandboxRegistrations().length, before + 1);
    const all = readRecords();
    assert.equal(all.length, ledgerBefore + 1);

    const evt = result.ledgerEvent;
    assert.equal(evt.event, "registration");
    assert.equal(evt.kind, "summarizationTemplate");
    assert.equal(evt.active, true);
    assert.equal(evt.status, "active");

    // Manifest carries every safety field.
    assert.ok(evt.manifest);
    assert.equal(evt.manifest!.kind, "summarizationTemplate");
    assert.equal(evt.manifest!.sandboxMode, "sandbox-dry-run");
    assert.equal(evt.manifest!.metricKey, "summary_quality_score");
    assert.deepEqual([...evt.manifest!.guardrails].sort(), [
      "citation_source_retention",
      "format_compliance",
      "hallucination_count",
      "length_compliance",
    ]);
    assert.equal(evt.manifest!.controls.dryRun,            true);
    assert.equal(evt.manifest!.controls.fixtureSource,     "static");
    assert.equal(evt.manifest!.controls.useScheduler,      false);
    assert.equal(evt.manifest!.controls.promotionEligible, false);

    // Snapshot hash present and well-formed.
    assert.ok(typeof evt.sandboxSnapshotHash === "string" && /^sha256:[0-9a-f]{64}$/.test(evt.sandboxSnapshotHash!));

    // Pre-metrics and rollback present.
    assert.ok(evt.preMetrics && Object.keys(evt.preMetrics).length >= 1);
    assert.ok(Array.isArray(evt.rollbackInstructions) && evt.rollbackInstructions!.length >= 1);

    // Operator + feature flag echoed.
    assert.equal(evt.operator?.source, "test:phase2i-a-fixture");
    assert.ok(evt.operator?.note?.includes(SUMMARIZATION_FIXTURE_ID));
    assert.equal(evt.featureFlagState?.name, SUMMARIZATION_FIXTURE_FEATURE_FLAG_NAME);

    // Auto-apply hard-locked off.
    assert.equal(evt.sandboxAutoApplyEligible, false);
    assert.equal(evt.autoApplyPolicy, "manual-only");

    // Post-metrics intentionally empty on the registration row.
    assert.deepEqual(evt.postMetrics ?? {}, {});
  });

  it("appending again preserves the prior row (append-only)", () => {
    const before = readRecords();
    const r2 = executeSummarizationFixtureRegistration({
      source: "test:phase2i-a-fixture-2",
      now:    new Date("2026-05-10T10:05:00.000Z"),
    });
    assert.equal(r2.ok, true);
    const after = readRecords();
    assert.equal(after.length, before.length + 1, "append-only: prior rows preserved");
    // The first row's recordId still exists in the after list.
    const firstRecordId = before[0].recordId;
    assert.ok(after.some(r => r.recordId === firstRecordId));
  });

  it("refuses any kind other than summarizationTemplate (writes nothing)", () => {
    const ledgerBefore = readRecords().length;
    const result = executeSummarizationFixtureRegistration({
      kindOverrideForTestsOnly: "reasoningTemplate",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "kind_guard");
    assert.match(result.reason, /summarizationTemplate/);
    assert.equal(readRecords().length, ledgerBefore, "kind guard must not touch the ledger");
  });

  it("refuses an unknown / not-low-risk kind via the kind guard before Phase 2e-b ever runs", () => {
    const ledgerBefore = readRecords().length;
    const result = executeSummarizationFixtureRegistration({
      kindOverrideForTestsOnly: "modelRouter",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "kind_guard");
    assert.equal(readRecords().length, ledgerBefore);
  });

  it("sandboxAutoApplyEligible is false on every persisted row", () => {
    const all = readRecords();
    assert.ok(all.length >= 2);
    for (const r of all) {
      if (r.event === "registration" && r.kind === "summarizationTemplate") {
        assert.equal(r.sandboxAutoApplyEligible, false,
          `row ${r.recordId} unexpectedly auto-apply eligible`);
        assert.equal(r.autoApplyPolicy, "manual-only",
          `row ${r.recordId} unexpectedly not manual-only`);
      }
    }
  });
});

// ── Default-refuse for disabled kinds at the registry level ────────────────

describe("Phase 2i-a — disabled kinds cannot use this path", () => {
  it("kind guard refuses each currently-disabled low-risk kind", () => {
    for (const k of [
      "reasoningTemplate",
      "selfCritiquePrompt",
      "memoryRetrievalHeuristic",
      "taskDecompositionPattern",
    ]) {
      const before = readRecords().length;
      const result = executeSummarizationFixtureRegistration({ kindOverrideForTestsOnly: k });
      assert.equal(result.ok, false, `must refuse ${k}`);
      if (result.ok) continue;
      assert.equal(result.stage, "kind_guard");
      assert.equal(readRecords().length, before);
    }
  });
});

// ── Ledger summary ──────────────────────────────────────────────────────────

describe("Phase 2i-a — ledger summary read", () => {
  it("summarises the persisted fixture rows without writing", () => {
    const before = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
    const summary = readSummarizationFixtureLedgerSummary();
    const after = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
    assert.equal(after, before, "summary read must not write");

    assert.equal(summary.hasFixtureEvidence, true);
    assert.ok(summary.fixtureRegistrationEvents >= 2);
    assert.ok(summary.registrationEvents >= 2);
    assert.ok(summary.latestFixtureRegistration !== null);

    const latest = summary.latestFixtureRegistration!;
    assert.equal(latest.kind, "summarizationTemplate");
    assert.equal(latest.fixtureId, SUMMARIZATION_FIXTURE_ID);
    assert.equal(latest.sandboxAutoApplyEligible, false);
    assert.equal(latest.autoApplyPolicy, "manual-only");
    assert.match(latest.recordId, /^regrec_\d+_[0-9a-z]{6}$/);

    // Invariants are documentation surfaced for the dashboard.
    assert.equal(summary.invariants.fixtureOnly,              true);
    assert.equal(summary.invariants.dryRunOnly,               true);
    assert.equal(summary.invariants.sandboxAutoApplyEligible, false);
    assert.equal(summary.invariants.schedulerDriven,          false);
    assert.equal(summary.invariants.publicAction,             false);
    assert.equal(summary.invariants.mutating,                 false);
  });
});

// ── Autonomy monitor wiring ─────────────────────────────────────────────────

describe("Phase 2i-a — autonomy monitor remains read-only and surfaces fixture evidence", () => {
  it("evidence_package surfaces the latest fixture registration metadata", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    const fixture = ev.extra?.summarizationFixture as Record<string, unknown> | undefined;
    assert.ok(fixture, "evidence_package.extra.summarizationFixture must be present");

    assert.equal(fixture!.fixtureId,         SUMMARIZATION_FIXTURE_ID);
    assert.equal(fixture!.hasFixtureEvidence, true);
    assert.ok(typeof fixture!.fixtureRegistrationEvents === "number" && (fixture!.fixtureRegistrationEvents as number) >= 2);
    assert.ok(fixture!.latestFixtureRegistration !== null && typeof fixture!.latestFixtureRegistration === "object");

    // Counts surface the new field.
    assert.ok(typeof ev.counts?.summarizationFixtureRegistrations === "number");
    assert.ok((ev.counts!.summarizationFixtureRegistrations as number) >= 2);

    // Manual-only entry point is documented in the extra block.
    assert.equal(fixture!.manualEntryPoint, "scripts/registerSummarizationSandboxFixture.ts");

    // Monitor MUST NOT advertise an actionable apply path.
    assert.ok(!(ev.nextActions ?? []).some(a => /apply\s+now|run\s+now|promote\s+now|post\s+now|publish\s+now/i.test(a)),
      "evidence_package nextActions must remain non-actionable");
  });

  it("snapshot rendering does not create or modify the ledger file", () => {
    const before = fs.statSync(LEDGER_FILE).size;
    buildAutonomyMonitorSnapshot();
    buildAutonomyMonitorSnapshot();
    buildAutonomyMonitorSnapshot();
    const after = fs.statSync(LEDGER_FILE).size;
    assert.equal(after, before, "rendering the monitor must be read-only");
  });

  it("no new sandbox kinds are enabled by Phase 2i-a", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const sandbox = snap.stages.find(s => s.id === "sandbox_execution")!;
    const kinds = (sandbox.extra?.kinds as Array<Record<string, unknown>>) ?? [];
    const enabled = kinds.filter(k => k.enabled === true);
    assert.equal(enabled.length, 1, "exactly one kind must remain enabled");
    assert.equal(enabled[0].kind, "summarizationTemplate");
  });
});

// ── Empty-ledger graceful path ──────────────────────────────────────────────
//
// dataPaths.ts captures DATA_DIR at module load, so we cannot redirect the
// ledger by re-setting process.env after imports. Instead we delete the
// already-isolated test ledger and re-read from the same path. This
// exercises the "no fixture evidence yet" branch deterministically.

describe("Phase 2i-a — graceful display when no fixture evidence exists", () => {
  before(() => {
    try { fs.unlinkSync(LEDGER_FILE); } catch {}
  });
  after(() => {
    // Re-seed at least one row so later suites that depend on having
    // evidence (and the after-block check that the LIVE ledger is
    // unchanged) remain happy. The seeded row stays in TMP, not in the
    // repo's data/.
    __resetLowRiskSandboxRegistryForTests();
    const r = executeSummarizationFixtureRegistration({
      source: "test:phase2i-a-fixture-reseed",
      now:    new Date("2026-05-10T11:00:00.000Z"),
    });
    if (!r.ok) throw new Error(`reseed failed: ${r.reason}`);
  });

  it("summary returns zero counts and null latest when ledger is absent", () => {
    const summary = readSummarizationFixtureLedgerSummary();
    assert.equal(summary.totalEvents, 0);
    assert.equal(summary.fixtureRegistrationEvents, 0);
    assert.equal(summary.hasFixtureEvidence, false);
    assert.equal(summary.latestFixtureRegistration, null);
    assert.equal(summary.invariants.sandboxAutoApplyEligible, false);
  });

  it("monitor surfaces empty fixture state without throwing and steers the operator to the manual script", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    const fixture = ev.extra?.summarizationFixture as Record<string, unknown> | undefined;
    assert.ok(fixture);
    assert.equal(fixture!.hasFixtureEvidence, false);
    assert.equal(fixture!.latestFixtureRegistration, null);
    assert.ok((ev.nextActions ?? []).some(a => /scripts\/registerSummarizationSandboxFixture\.ts/.test(a)),
      "operator must be steered to the manual script when no fixture evidence exists");
  });
});

// ── Default source label ────────────────────────────────────────────────────

describe("Phase 2i-a — operator label defaults", () => {
  it("default source is the fixture-builder label when none supplied", () => {
    process.env.DATA_DIR = TMP;
    const d = buildSummarizationFixtureRegistrationDescriptor();
    assert.equal(d.operator.source, SUMMARIZATION_FIXTURE_DEFAULT_SOURCE);
  });
});
