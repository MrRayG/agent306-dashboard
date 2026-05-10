/**
 * Tests for Phase 2i-c — read-only sandbox registration audit export.
 *
 * Spec invariants pinned by this file:
 *   1. Populated export carries audit metadata (schema version, label,
 *      counts, entries, byKind, disabledKinds, summarizationFixture,
 *      kindEnablement, restated invariants).
 *   2. Empty export degrades gracefully — zero counts, `entries: []`,
 *      `isEmpty: true`, restated invariants still present.
 *   3. Determinism — repeated calls with the same inputs return equal
 *      payloads, and `serializeSandboxRegistrationAuditExport` returns the
 *      byte-identical string across repeated calls.
 *   4. Deterministic timestamp policy — `generatedAt` is `null` when no
 *      `now` is passed, and a stable ISO string when one is.
 *   5. Read-only — building or serializing the export does NOT write to
 *      ledger / DB / fixture / env.
 *   6. Disabled kinds remain disabled — even with refused rows, the export
 *      reports `registryEnabled: false`, surfaces the kind in
 *      `disabledKinds`, and `sandboxAutoApplyEligible: false` everywhere.
 *   7. Real data fixtures are byte-identical after the test run.
 *   8. Autonomy monitor surfaces a small audit-export block in the
 *      evidence_package stage without disturbing Phase 2i-a/2i-b fields.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ic-audit-export-test-"));
process.env.DATA_DIR = TMP;
// Per-process DB isolation — same pattern as Phase 2i-b's history test.
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const LEDGER_FILE = path.join(TMP, "sandbox_registration_records.jsonl");

const {
  buildSandboxRegistrationAuditExport,
  serializeSandboxRegistrationAuditExport,
  SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION,
  SANDBOX_REGISTRATION_AUDIT_EXPORT_LABEL,
} = await import("../experiments/sandboxRegistrationAuditExport.ts");

const {
  buildSandboxRegistrationHistorySnapshot,
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
  const a = (p: string) => snapshot(p);
  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = a(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2i-c tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2i-c tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2i-c tests created live ${label}!`);
    }
  }
});

// ── Empty-ledger graceful path ──────────────────────────────────────────────

describe("Phase 2i-c — empty-ledger graceful audit export", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(LEDGER_FILE); } catch {}
  });

  it("returns an empty audit export with stable schema metadata", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.equal(exp.schemaVersion, SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION);
    assert.equal(exp.label, SANDBOX_REGISTRATION_AUDIT_EXPORT_LABEL);
    assert.equal(exp.totalRecords, 0);
    assert.equal(exp.registrationEvents, 0);
    assert.equal(exp.completionEvents, 0);
    assert.equal(exp.refusedEvents, 0);
    assert.equal(exp.activeRegistrations, 0);
    assert.equal(exp.manualFixtureRegistrations, 0);
    assert.equal(exp.isEmpty, true);
    assert.deepEqual([...exp.entries], []);
    assert.equal(exp.generatedAt, null, "generatedAt must default to null");
    assert.equal(exp.generatedBy, "unspecified");
  });

  it("invariants block restates the read-only / non-widening contract on empty ledger", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.equal(exp.invariants.readOnly, true);
    assert.equal(exp.invariants.nonWidening, true);
    assert.equal(exp.invariants.sandboxAutoApplyEligible, false);
    assert.equal(exp.invariants.schedulerDriven, false);
    assert.equal(exp.invariants.publicAction, false);
    assert.equal(exp.invariants.mutating, false);
    assert.equal(exp.invariants.auditExport, true);
  });

  it("kindEnablement reflects only summarizationTemplate enabled", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.deepEqual([...exp.kindEnablement.enabled], ["summarizationTemplate"]);
    assert.deepEqual([...exp.kindEnablement.disabled].sort(), [
      "memoryRetrievalHeuristic",
      "reasoningTemplate",
      "selfCritiquePrompt",
      "taskDecompositionPattern",
    ]);
  });

  it("disabledKinds block lists the four disabled kinds", () => {
    const exp = buildSandboxRegistrationAuditExport();
    const disabled = exp.disabledKinds.map(d => d.kind).sort();
    assert.deepEqual(disabled, [
      "memoryRetrievalHeuristic",
      "reasoningTemplate",
      "selfCritiquePrompt",
      "taskDecompositionPattern",
    ]);
  });

  it("export generation does not materialise the ledger file", () => {
    const before = fs.existsSync(LEDGER_FILE);
    buildSandboxRegistrationAuditExport();
    buildSandboxRegistrationAuditExport();
    serializeSandboxRegistrationAuditExport(buildSandboxRegistrationAuditExport());
    const after = fs.existsSync(LEDGER_FILE);
    assert.equal(before, after, "audit export must not create the ledger");
  });

  it("serialization is deterministic across repeated calls (empty)", () => {
    const exp = buildSandboxRegistrationAuditExport();
    const a = serializeSandboxRegistrationAuditExport(exp);
    const b = serializeSandboxRegistrationAuditExport(exp);
    assert.equal(a, b, "serialized empty export must be byte-identical");
    // Roundtrip must produce a valid object.
    const parsed = JSON.parse(a);
    assert.equal(parsed.schemaVersion, SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION);
  });
});

// ── Populated-ledger audit export ───────────────────────────────────────────

describe("Phase 2i-c — populated audit export", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    try { fs.unlinkSync(LEDGER_FILE); } catch {}
    const r1 = executeSummarizationFixtureRegistration({
      source: "test:phase2i-c-export-1",
      now:    new Date("2026-05-10T14:00:00.000Z"),
    });
    if (!r1.ok) throw new Error(`seed registration failed: ${r1.reason}`);
    const r2 = executeSummarizationFixtureRegistration({
      source: "test:phase2i-c-export-2",
      now:    new Date("2026-05-10T14:05:00.000Z"),
    });
    if (!r2.ok) throw new Error(`seed registration failed: ${r2.reason}`);
  });

  it("reflects ledger counts in the export", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.ok(exp.totalRecords >= 2, `expected >=2, got ${exp.totalRecords}`);
    assert.ok(exp.registrationEvents >= 2);
    assert.equal(exp.completionEvents, 0);
    assert.equal(exp.refusedEvents, 0);
    assert.equal(exp.isEmpty, false);
    assert.ok(exp.activeRegistrations >= 2);
    assert.ok(exp.manualFixtureRegistrations >= 2);
  });

  it("each entry carries the audit metadata for a registration row", () => {
    const exp = buildSandboxRegistrationAuditExport();
    const reg = exp.entries.find(e => e.event === "registration");
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
  });

  it("byKind aggregate counts summarizationTemplate registrations and zeroes other kinds", () => {
    const exp = buildSandboxRegistrationAuditExport();
    const summ = exp.byKind.find(k => k.kind === "summarizationTemplate");
    assert.ok(summ, "summarizationTemplate must appear in byKind");
    assert.ok(summ!.registrationEvents >= 2);
    assert.equal(summ!.registryEnabled, true);
    for (const k of exp.byKind) {
      if (k.kind === "summarizationTemplate") continue;
      assert.equal(k.totalEvents, 0, `disabled kind ${k.kind} should have no events`);
      assert.equal(k.registryEnabled, false, `kind ${k.kind} must remain disabled`);
    }
  });

  it("summarizationFixture summary is embedded for audit completeness", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.equal(exp.summarizationFixture.hasFixtureEvidence, true);
    assert.ok(exp.summarizationFixture.fixtureRegistrationEvents >= 2);
    assert.ok(exp.summarizationFixture.latestFixtureRegistration !== null);
    assert.equal(exp.summarizationFixture.invariants.fixtureOnly, true);
  });

  it("kindEnablement after population still has only summarizationTemplate enabled", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.deepEqual([...exp.kindEnablement.enabled], ["summarizationTemplate"]);
  });

  it("export generation does not append to the ledger", () => {
    const before = fs.statSync(LEDGER_FILE).size;
    buildSandboxRegistrationAuditExport();
    buildSandboxRegistrationAuditExport();
    serializeSandboxRegistrationAuditExport(buildSandboxRegistrationAuditExport());
    serializeSandboxRegistrationAuditExport(buildSandboxRegistrationAuditExport(), { indent: 2 });
    const after = fs.statSync(LEDGER_FILE).size;
    assert.equal(after, before, "audit export must be pure");
  });

  it("repeated builds with the same injected snapshot are deeply equal", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const e1 = buildSandboxRegistrationAuditExport({ snapshot: snap });
    const e2 = buildSandboxRegistrationAuditExport({ snapshot: snap });
    assert.deepEqual(e1, e2);
  });

  it("serialized strings are byte-identical for the same injected snapshot", () => {
    const snap = buildSandboxRegistrationHistorySnapshot();
    const e1 = buildSandboxRegistrationAuditExport({ snapshot: snap });
    const e2 = buildSandboxRegistrationAuditExport({ snapshot: snap });
    const s1 = serializeSandboxRegistrationAuditExport(e1);
    const s2 = serializeSandboxRegistrationAuditExport(e2);
    assert.equal(s1, s2, "serialized export must be byte-identical");
    const s1Pretty = serializeSandboxRegistrationAuditExport(e1, { indent: 2 });
    const s2Pretty = serializeSandboxRegistrationAuditExport(e2, { indent: 2 });
    assert.equal(s1Pretty, s2Pretty, "pretty-serialized export must be byte-identical");
  });

  it("generatedAt is null by default and a normalised ISO string when now is passed", () => {
    const expDefault = buildSandboxRegistrationAuditExport();
    assert.equal(expDefault.generatedAt, null);

    const fixed = new Date("2026-05-10T15:00:00.000Z");
    const expFixed = buildSandboxRegistrationAuditExport({ now: fixed });
    assert.equal(expFixed.generatedAt, "2026-05-10T15:00:00.000Z");

    const expString = buildSandboxRegistrationAuditExport({ now: "2026-05-10T15:00:00.000Z" });
    assert.equal(expString.generatedAt, "2026-05-10T15:00:00.000Z");
  });

  it("generatedBy defaults to 'unspecified' and echoes a caller-supplied label", () => {
    const expDefault = buildSandboxRegistrationAuditExport();
    assert.equal(expDefault.generatedBy, "unspecified");
    const expLabeled = buildSandboxRegistrationAuditExport({ generatedBy: "operator:test" });
    assert.equal(expLabeled.generatedBy, "operator:test");
  });

  it("invariants include auditExport: true in addition to the Phase 2i-b set", () => {
    const exp = buildSandboxRegistrationAuditExport();
    assert.equal(exp.invariants.readOnly, true);
    assert.equal(exp.invariants.nonWidening, true);
    assert.equal(exp.invariants.sandboxAutoApplyEligible, false);
    assert.equal(exp.invariants.schedulerDriven, false);
    assert.equal(exp.invariants.publicAction, false);
    assert.equal(exp.invariants.mutating, false);
    assert.equal(exp.invariants.auditExport, true);
  });
});

// ── Refused rows for disabled kinds: must NOT widen via the export ─────────

describe("Phase 2i-c — disabled kinds remain disabled in the export", () => {
  before(() => {
    __resetLowRiskSandboxRegistryForTests();
    const refusalOrReg = registerLowRiskSandboxKind("reasoningTemplate", {
      featureFlag:       true,
      operatorApproved:  true,
      dryRun:            true,
      fixtureSource:     "static",
      maxTrials:         1,
      promotionEligible: false,
      useScheduler:      false,
    } as any, new Date("2026-05-10T16:00:00.000Z"));
    if ((refusalOrReg as { ok?: boolean }).ok === false) {
      const append = appendRefusedRegistrationRecord({
        refusal: refusalOrReg as any,
        operator: { source: "test:phase2i-c-disabled-refusal" },
      });
      if (!append.ok) throw new Error(`refusal append failed: ${append.reason}`);
    } else {
      throw new Error("expected reasoningTemplate to be refused as disabled");
    }
  });

  it("refused rows surface in the export but do NOT mark the kind enabled", () => {
    const exp = buildSandboxRegistrationAuditExport();
    const refused = exp.entries.find(e => e.event === "refused" && e.kind === "reasoningTemplate");
    assert.ok(refused, "expected refused row in audit export");
    assert.equal(refused!.status, "refused");
    assert.equal(refused!.active, false);
    assert.equal(refused!.sandboxAutoApplyEligible, false);

    const reasoning = exp.byKind.find(k => k.kind === "reasoningTemplate");
    assert.ok(reasoning, "reasoningTemplate must appear in byKind");
    assert.equal(reasoning!.registryEnabled, false,
      "refused rows must NOT widen registration");
    assert.equal(reasoning!.registrationEvents, 0,
      "refused rows are not registrations");

    // Disabled kinds list still includes reasoningTemplate.
    assert.ok(
      exp.disabledKinds.map(d => d.kind).includes("reasoningTemplate"),
      "reasoningTemplate must remain in disabledKinds",
    );

    // Only summarizationTemplate is enabled.
    assert.deepEqual([...exp.kindEnablement.enabled], ["summarizationTemplate"]);
  });
});

// ── Autonomy monitor wiring ────────────────────────────────────────────────

describe("Phase 2i-c — autonomy monitor surfaces audit-export metadata", () => {
  it("evidence_package extra.registrationAuditExport carries schema + counts", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    assert.ok(ev, "evidence_package stage must exist");
    const auditExport = ev.extra?.registrationAuditExport as Record<string, unknown> | undefined;
    assert.ok(auditExport, "extra.registrationAuditExport must be present");
    assert.equal(auditExport!.schemaVersion, SANDBOX_REGISTRATION_AUDIT_EXPORT_SCHEMA_VERSION);
    assert.equal(auditExport!.label, SANDBOX_REGISTRATION_AUDIT_EXPORT_LABEL);
    assert.equal(typeof auditExport!.totalRecords, "number");
    assert.equal(typeof auditExport!.registrationEvents, "number");
    assert.equal(typeof auditExport!.completionEvents, "number");
    assert.equal(typeof auditExport!.refusedEvents, "number");
    assert.equal(typeof auditExport!.isEmpty, "boolean");
    assert.equal((auditExport!.invariants as any).auditExport, true);
    assert.equal((auditExport!.invariants as any).sandboxAutoApplyEligible, false);
  });

  it("Phase 2i-a fixture summary and Phase 2i-b history block remain present", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    const fixture = ev.extra?.summarizationFixture as Record<string, unknown> | undefined;
    assert.ok(fixture, "Phase 2i-a fixture block must remain present");
    assert.equal(fixture!.fixtureId, SUMMARIZATION_FIXTURE_ID);
    const history = ev.extra?.registrationHistory as Record<string, unknown> | undefined;
    assert.ok(history, "Phase 2i-b history block must remain present");
    assert.equal(typeof history!.totalRecords, "number");
  });

  it("evidence_package counts include audit-export schema version field", () => {
    const snap = buildAutonomyMonitorSnapshot();
    const ev = snap.stages.find(s => s.id === "evidence_package")!;
    assert.equal(typeof ev.counts?.auditExportEntries, "number");
    // Phase 2i-a/b counts must still be present.
    assert.equal(typeof ev.counts?.summarizationFixtureRegistrations, "number");
    assert.equal(typeof ev.counts?.historyEntriesShown, "number");
    assert.equal(typeof ev.counts?.totalRecords, "number");
  });
});
