/**
 * Tests for Phase 2i-b — read-only sandbox registration history visibility.
 *
 * Spec invariants pinned by this file:
 *   1. The history snapshot reflects existing ledger rows when present.
 *   2. The history snapshot degrades gracefully on an empty / absent ledger
 *      (zero counts, `entries: []`, `isEmpty: true`).
 *   3. Reading the snapshot is read-only: no ledger / DB / fixture / env
 *      mutation occurs.
 *   4. Disabled kinds remain disabled — the history surfaces zero counts +
 *      `registryEnabled: false` + a static `disabledKinds` block. Even if a
 *      refused row exists for a disabled kind, it does not become enabled.
 *   5. Each registration row is projected with kind, recordId, eventId,
 *      snapshot hash, source/operator note, fixture id, manual-fixture
 *      marker, guardrails, rollback steps, feature-flag echo, timestamps,
 *      and `sandboxAutoApplyEligible: false`.
 *   6. The autonomy monitor's evidence_package stage exposes the history
 *      via `extra.registrationHistory` and counts.
 *   7. Phase 2i-a evidence still surfaces in `extra.summarizationFixture`.
 *   8. Repeated monitor reads do not write to the ledger.
 *   9. Real data fixtures (research_lab.json, memory_knowledge.json,
 *      Phase 2d ledger, the live sandbox registration ledger) are
 *      byte-identical after the test run.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ib-history-test-"));
process.env.DATA_DIR = TMP;
// Per-process DB isolation. Same pattern as the Phase 2i-a fixture test —
// autonomyMonitor → autonomyRuntimeVisibility → server/db.ts opens a SQLite
// connection at module load. Without a unique DB_PATH this test would race
// the aggregate suite's other DB-using files. Pointing DB_PATH at this run's
// tmpdir scopes the lock to this process only.
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const LEDGER_FILE = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildSandboxRegistrationHistorySnapshot,
  SANDBOX_REGISTRATION_HISTORY_DEFAULT_LIMIT,
  SANDBOX_REGISTRATION_HISTORY_MAX_LIMIT,
} = await import("../experiments/sandboxRegistrationHistory.ts");

const {
  __resetLowRiskSandboxRegistryForTests,
  registerLowRiskSandboxKind,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

const {
  appendRefusedRegistrationRecord,
} = await import("../experiments/sandboxRegistrationRecords.ts");

const {
  executeSummarizationFixtureRegistration,
  SUMMARIZATION_FIXTURE_ID,
} = await import("../experiments/summarizationSandboxFixtureRegistration.ts");

const {
  buildAutonomyMonitorSnapshot,
} = await import("../autonomyMonitor.ts");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);

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
      if (!a.exists) throw new Error(`Phase 2i-b tests removed live ${label}!`);
      if (a.content !== before.content) throw new Error(`Phase 2i-b tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`Phase 2i-b tests created live ${label}!`);
    }
  }
});

// ── Empty-ledger graceful path ──────────────────────────────────────────────

describe("Phase 2i-b — empty-ledger graceful state", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(LEDGER_FILE); } catch {}
  });

  it("returns isEmpty: true with zero counts and empty entries when no rows exist", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    assert.equal(snap.totalRecords, 0);
    assert.equal(snap.registrationEvents, 0);
    assert.equal(snap.completionEvents, 0);
    assert.equal(snap.refusedEvents, 0);
    assert.equal(snap.activeRegistrations, 0);
    assert.equal(snap.manualFixtureRegistrations, 0);
    assert.equal(snap.isEmpty, true);
    assert.deepEqual([...snap.entries], []);
  });

  it("snapshot read does not create the ledger file", () => {
    const before = fs.existsSync(LEDGER_FILE);
    buildSandboxRegistrationHistorySnapshot();
    buildSandboxRegistrationHistorySnapshot();
    const after = fs.existsSync(LEDGER_FILE);
    assert.equal(before, after, "history read must not materialise the ledger");
  });

  it("invariants block restates the read-only / non-widening contract", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    assert.equal(snap.invariants.readOnly, true);
    assert.equal(snap.invariants.nonWidening, true);
    assert.equal(snap.invariants.sandboxAutoApplyEligible, false);
    assert.equal(snap.invariants.schedulerDriven, false);
    assert.equal(snap.invariants.publicAction, false);
    assert.equal(snap.invariants.mutating, false);
  });

  it("byKind block exposes every registry kind with zero counts even on an empty ledger", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const kinds = snap.byKind.map(k => k.kind);
    for (const expected of [
      "summarizationTemplate",
      "selfCritiquePrompt",
      "memoryRetrievalHeuristic",
      "reasoningTemplate",
      "taskDecompositionPattern",
    ]) {
      assert.ok(kinds.includes(expected), `byKind must seed kind ${expected}`);
    }
    for (const k of snap.byKind) {
      assert.equal(k.totalEvents, 0);
      assert.equal(k.registrationEvents, 0);
      assert.equal(k.completionEvents, 0);
      assert.equal(k.refusedEvents, 0);
    }
  });

  it("disabledKinds block lists the four disabled kinds and excludes summarizationTemplate", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const disabled = snap.disabledKinds.map(k => k.kind).sort();
    assert.deepEqual(disabled, [
      "memoryRetrievalHeuristic",
      "reasoningTemplate",
      "selfCritiquePrompt",
      "taskDecompositionPattern",
    ]);
    assert.ok(!disabled.includes("summarizationTemplate" as never));
  });
});

// ── Populated-ledger projection ─────────────────────────────────────────────

describe("Phase 2i-b — populated history projection", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(LEDGER_FILE); } catch {}
    // Append two Phase 2i-a fixture registration rows so we have real data.
    const r1 = executeSummarizationFixtureRegistration({
      source: "test:phase2i-b-history-1",
      now:    new Date("2026-05-10T12:00:00.000Z"),
    });
    if (!r1.ok) throw new Error(`seed registration failed: ${r1.reason}`);
    const r2 = executeSummarizationFixtureRegistration({
      source: "test:phase2i-b-history-2",
      now:    new Date("2026-05-10T12:05:00.000Z"),
    });
    if (!r2.ok) throw new Error(`seed registration failed: ${r2.reason}`);
  });

  it("counts every persisted row across event types", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    assert.ok(snap.totalRecords >= 2, `expected >=2, got ${snap.totalRecords}`);
    assert.ok(snap.registrationEvents >= 2);
    assert.equal(snap.completionEvents, 0);
    assert.equal(snap.refusedEvents, 0);
    assert.equal(snap.isEmpty, false);
    assert.ok(snap.activeRegistrations >= 2);
    assert.ok(snap.manualFixtureRegistrations >= 2);
  });

  it("entries are most-recent-first and capped at the applied limit", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    assert.ok(snap.entries.length >= 2);
    // recordedAt strictly non-increasing (most-recent-first)
    for (let i = 1; i < snap.entries.length; i++) {
      assert.ok(snap.entries[i - 1].recordedAt >= snap.entries[i].recordedAt,
        `entries must be most-recent-first (idx ${i})`);
    }
    const limited = buildSandboxRegistrationHistorySnapshot({ limit: 1 });
    assert.equal(limited.appliedLimit, 1);
    assert.equal(limited.entries.length, 1);
  });

  it("limit is clamped to the documented bounds", () => {
    const small = buildSandboxRegistrationHistorySnapshot({ limit: 0 });
    assert.equal(small.appliedLimit, 1);
    const huge = buildSandboxRegistrationHistorySnapshot({ limit: 99999 });
    assert.equal(huge.appliedLimit, SANDBOX_REGISTRATION_HISTORY_MAX_LIMIT);
    const def = buildSandboxRegistrationHistorySnapshot();
    assert.equal(def.appliedLimit, SANDBOX_REGISTRATION_HISTORY_DEFAULT_LIMIT);
  });

  it("each projected entry exposes audit metadata for a registration row", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const reg = snap.entries.find(e => e.event === "registration");
    assert.ok(reg, "expected at least one registration entry");
    assert.equal(reg!.kind, "summarizationTemplate");
    assert.match(reg!.recordId, /^regrec_\d+_[0-9a-z]{6}$/);
    assert.match(reg!.eventId,  /^evt_\d+_[0-9a-z]{6}$/);
    assert.equal(reg!.status, "active");
    assert.equal(reg!.active, true);
    assert.ok(typeof reg!.sandboxSnapshotHash === "string"
      && /^sha256:[0-9a-f]{64}$/.test(reg!.sandboxSnapshotHash!));
    assert.equal(reg!.metricKey, "summary_quality_score");
    assert.ok(reg!.guardrailKeys.length >= 1);
    assert.ok(reg!.rollbackInstructions.length >= 1);
    assert.ok(reg!.featureFlagState !== null);
    assert.equal(reg!.featureFlagState!.enabled, true);
    assert.equal(reg!.isManualFixture, true);
    assert.equal(reg!.fixtureId, SUMMARIZATION_FIXTURE_ID);
    assert.equal(reg!.sandboxAutoApplyEligible, false);
    assert.equal(reg!.autoApplyPolicy, "manual-only");
    assert.equal(reg!.refusalCode, null);
    assert.equal(reg!.refusalReason, null);
    assert.ok(typeof reg!.createdAt === "string" && reg!.createdAt!.length > 0);
  });

  it("byKind aggregates count summarizationTemplate registrations and treats other kinds as zero", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const summ = snap.byKind.find(k => k.kind === "summarizationTemplate");
    assert.ok(summ, "summarizationTemplate must appear in byKind");
    assert.ok(summ!.registrationEvents >= 2);
    assert.equal(summ!.registryEnabled, true);
    assert.equal(summ!.disabledReason, null);

    for (const k of snap.byKind) {
      if (k.kind === "summarizationTemplate") continue;
      assert.equal(k.totalEvents, 0,
        `disabled kind ${k.kind} should have no events`);
      assert.equal(k.registryEnabled, false,
        `kind ${k.kind} must remain disabled`);
    }
  });

  it("history read does not append to the ledger", () => {
    const before = fs.statSync(LEDGER_FILE).size;
    buildSandboxRegistrationHistorySnapshot();
    buildSandboxRegistrationHistorySnapshot();
    buildSandboxRegistrationHistorySnapshot();
    const after = fs.statSync(LEDGER_FILE).size;
    assert.equal(after, before, "history read must be pure");
  });

  it("summarizationFixture summary is included verbatim (reuse, not parallel parse)", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    assert.equal(snap.summarizationFixture.hasFixtureEvidence, true);
    assert.ok(snap.summarizationFixture.fixtureRegistrationEvents >= 2);
    assert.ok(snap.summarizationFixture.latestFixtureRegistration !== null);
    assert.equal(snap.summarizationFixture.invariants.fixtureOnly, true);
  });
});

// ── Refused rows for disabled kinds: must NOT widen eligibility ────────────

describe("Phase 2i-b — disabled kinds remain disabled even with refused rows", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    // Append a refused row for a disabled kind via the legitimate refusal
    // path. This proves the history view surfaces refused rows for audit
    // without claiming the kind became enabled or registerable.
    const refusalOrReg = registerLowRiskSandboxKind("reasoningTemplate", {
      featureFlag:       true,
      operatorApproved:  true,
      dryRun:            true,
      fixtureSource:     "static",
      maxTrials:         1,
      promotionEligible: false,
      useScheduler:      false,
    } as any, new Date("2026-05-10T13:00:00.000Z"));
    // The registry will refuse with `kind_disabled`. Persist the refusal.
    if ((refusalOrReg as { ok?: boolean }).ok === false) {
      const append = appendRefusedRegistrationRecord({
        refusal: refusalOrReg as any,
        operator: { source: "test:phase2i-b-disabled-refusal" },
      });
      if (!append.ok) throw new Error(`refusal append failed: ${append.reason}`);
    } else {
      throw new Error("expected reasoningTemplate to be refused as disabled");
    }
  });

  it("refused row appears in history without enabling the disabled kind", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const refused = snap.entries.find(
      e => e.event === "refused" && e.kind === "reasoningTemplate",
    );
    assert.ok(refused, "expected refused row to appear in history entries");
    assert.equal(refused!.status, "refused");
    assert.equal(refused!.active, false);
    assert.equal(refused!.sandboxAutoApplyEligible, false);
    assert.ok(typeof refused!.refusalCode === "string" && refused!.refusalCode!.length > 0);

    // Disabled kind must remain disabled in the by-kind aggregate.
    const reasoning = snap.byKind.find(k => k.kind === "reasoningTemplate");
    assert.ok(reasoning, "reasoningTemplate must appear in byKind");
    assert.equal(reasoning!.registryEnabled, false,
      "refused rows must NOT mark a disabled kind as enabled");
    assert.equal(reasoning!.registrationEvents, 0,
      "refused rows are not registrations");

    // Disabled kinds list still includes reasoningTemplate.
    const disabledKinds = snap.disabledKinds.map(k => k.kind);
    assert.ok(disabledKinds.includes("reasoningTemplate" as any),
      "reasoningTemplate must remain in the disabledKinds block");

    // Only one kind is enabled in the registry.
    const enabledKinds = snap.byKind.filter(k => k.registryEnabled).map(k => k.kind);
    assert.deepEqual(enabledKinds.sort(), ["summarizationTemplate"],
      "only summarizationTemplate may be enabled");
  });
});

// ── Autonomy monitor wiring ────────────────────────────────────────────────

describe("Phase 2i-b — autonomy monitor surfaces registration history", () => {
  it("evidence_package extra.registrationHistory carries the projected snapshot", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    assert.ok(ev, "evidence_package stage must exist");
    const history = ev.extra?.registrationHistory as Record<string, unknown> | undefined;
    assert.ok(history, "evidence_package.extra.registrationHistory must be present");

    assert.equal(typeof history!.totalRecords, "number");
    assert.equal(typeof history!.registrationEvents, "number");
    assert.equal(typeof history!.completionEvents, "number");
    assert.equal(typeof history!.refusedEvents, "number");
    assert.equal(typeof history!.activeRegistrations, "number");
    assert.equal(typeof history!.manualFixtureRegistrations, "number");
    assert.equal(typeof history!.appliedLimit, "number");
    assert.equal(typeof history!.isEmpty, "boolean");
    assert.ok(Array.isArray(history!.entries));
    assert.ok(Array.isArray(history!.byKind));
    assert.ok(Array.isArray(history!.disabledKinds));

    const inv = history!.invariants as Record<string, unknown>;
    assert.equal(inv.readOnly, true);
    assert.equal(inv.nonWidening, true);
    assert.equal(inv.sandboxAutoApplyEligible, false);
    assert.equal(inv.schedulerDriven, false);
    assert.equal(inv.publicAction, false);
    assert.equal(inv.mutating, false);
  });

  it("evidence_package counts surface history fields alongside the existing 2i-a fields", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    assert.equal(typeof ev.counts?.historyEntriesShown, "number");
    assert.equal(typeof ev.counts?.manualFixtureRegistrations, "number");
    // Phase 2i-a counts must still be present.
    assert.equal(typeof ev.counts?.summarizationFixtureRegistrations, "number");
    assert.equal(typeof ev.counts?.totalRecords, "number");
  });

  it("Phase 2i-a fixture summary remains in extra.summarizationFixture (not removed)", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    const fixture = ev.extra?.summarizationFixture as Record<string, unknown> | undefined;
    assert.ok(fixture, "Phase 2i-a fixture block must remain present");
    assert.equal(fixture!.fixtureId, SUMMARIZATION_FIXTURE_ID);
    assert.equal(fixture!.manualEntryPoint, "scripts/registerSummarizationSandboxFixture.ts");
  });

  it("repeated monitor reads do not append to the ledger", () => {
    const before = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
    buildAutonomyMonitorSnapshot();
    buildAutonomyMonitorSnapshot();
    buildAutonomyMonitorSnapshot();
    const after = fs.existsSync(LEDGER_FILE) ? fs.statSync(LEDGER_FILE).size : 0;
    assert.equal(after, before,
      "rendering the autonomy monitor must remain read-only");
  });

  it("monitor never advertises an actionable registration / apply control", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    const json = JSON.stringify(ev).toLowerCase();
    assert.equal(/"autopost"|"autopublish"|"autopromote"|"applynow"|"registernow"|"publishnow"|"postnow"/.test(json), false,
      "evidence_package payload must not advertise an actionable control");
    assert.equal(/"sandboxautoapplyeligible":true/.test(json), false,
      "no row may surface as auto-apply-eligible");
  });

  it("sandbox_execution stage continues to enable only summarizationTemplate", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const sandbox = snap.stages.find(s => s.id === "sandbox_execution")!;
    const kinds = (sandbox.extra?.kinds as Array<Record<string, unknown>>) ?? [];
    const enabled = kinds.filter(k => k.enabled === true);
    assert.equal(enabled.length, 1,
      "Phase 2i-b must not enable additional sandbox kinds");
    assert.equal(enabled[0].kind, "summarizationTemplate");
  });
});
