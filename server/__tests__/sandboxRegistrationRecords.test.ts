/**
 * Tests for the Phase 2e-c persistent sandbox registration records ledger.
 *
 * Spec invariants this file pins:
 *   1. A successful Phase 2e-b summarizationTemplate registration round-trips
 *      via the JSONL ledger as a single `registration` event.
 *   2. The persisted record carries the full manifest (kind, metricKey,
 *      guardrails, resourceCaps, controls echo, registeredAt), a non-empty
 *      `sandboxSnapshotHash`, both `preMetrics` and `postMetrics` fields
 *      (postMetrics initially empty), and the operator-supplied
 *      `rollbackInstructions`.
 *   3. The ledger is append-only — earlier records survive subsequent
 *      appends and the reader tolerates a corrupt line.
 *   4. `sandboxAutoApplyEligible` defaults to `false`. Even when the caller
 *      explicitly passes `true`, the value is recorded but no auto-apply
 *      side effect runs.
 *   5. Missing / malformed `rollbackInstructions` is refused (writes nothing).
 *   6. Missing caller-supplied `sandboxSnapshotHash` is filled in
 *      deterministically from the manifest's canonical form (documented in
 *      the module). Identical manifests produce identical hashes; tampered
 *      manifests don't.
 *   7. A Phase 2e-b refusal (e.g. for a disabled kind) cannot be persisted
 *      as an active registration — `appendRegistrationRecord` refuses, and
 *      `appendRefusedRegistrationRecord` writes a non-active record.
 *   8. DATA_DIR isolation works — the ledger is written into the test
 *      tmpdir, NOT into the repo's `data/`. Appending records does NOT
 *      mutate `data/research_lab.json`, `data/memory_knowledge.json`, the
 *      Phase 2d decision-events ledger, or the Phase 2e-b in-memory map.
 *   9. Completion events attach `postMetrics` to a prior registration via
 *      `recordId`; the registration row itself is unchanged.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Phase 2n drain #8 — Redirect both DATA_DIR and DB_PATH so any accidental
// ledger / data / db write lands in the tmpdir rather than the repo's `data/`.
// The original Phase 2e-c test only set DATA_DIR; DB_PATH is added here for
// parity with the canonical drain template (server/dataPaths.ts captures
// DATA_DIR and server/db.ts captures DB_PATH at import-time, so both must
// be set before any transitively-imported repo module evaluates).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2ec-records-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_DATA_DIR = path.join(REPO_ROOT, "data");
const REAL_RESEARCH_LAB = path.join(REAL_DATA_DIR, "research_lab.json");
const REAL_MEMORY_KB    = path.join(REAL_DATA_DIR, "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REAL_DATA_DIR, "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REAL_DATA_DIR, "sandbox_registration_records.jsonl");

// 7 watched live-state files for the file-level isolation contract.
const REAL_AGENT_GOALS = path.join(REAL_DATA_DIR, "agent_goals.json");
const REAL_COMPETENCY  = path.join(REAL_DATA_DIR, "competencyProfile.json");
const REAL_DB          = path.join(REAL_DATA_DIR, "agent306.db");

const {
  appendRegistrationRecord,
  appendCompletionRecord,
  appendRefusedRegistrationRecord,
  readRecords,
  readRecordsTail,
  readRecordsForRecordId,
  readActiveRegistrationRecords,
} = await import("../experiments/sandboxRegistrationRecords.ts");

const {
  registerLowRiskSandboxKind,
  __resetLowRiskSandboxRegistryForTests,
  listLowRiskSandboxRegistrations,
} = await import("../experiments/lowRiskSandboxRegistry.ts");

import type {
  LowRiskSandboxControls,
  LowRiskSandboxRegistration,
  LowRiskSandboxRegistrationRefusal,
} from "../experiments/lowRiskSandboxRegistry.js";
import type {
  SandboxRegistrationRecordEvent,
} from "../experiments/sandboxRegistrationRecords.js";

const LEDGER_FILE = path.join(TMP, "sandbox_registration_records.jsonl");

const NOW = new Date("2026-05-09T12:00:00.000Z");

function controls(overrides: Partial<LowRiskSandboxControls> = {}): LowRiskSandboxControls {
  return {
    featureFlag:       true,
    operatorApproved:  true,
    dryRun:            true,
    fixtureSource:     "static",
    maxTrials:         5,
    promotionEligible: false,
    useScheduler:      false,
    ...overrides,
  };
}

function mkSummariserRegistration(
  ctrl: Partial<LowRiskSandboxControls> = {},
  now: Date = NOW,
): LowRiskSandboxRegistration {
  const r = registerLowRiskSandboxKind("summarizationTemplate", controls(ctrl), now);
  if (!r.ok) throw new Error(`fixture: registerLowRiskSandboxKind refused: ${r.reason}`);
  return r;
}

function mkRollback(): string[] {
  return [
    "Disable the Phase 2e-b sandbox feature flag (set to false).",
    "Drop the in-memory registration via __resetLowRiskSandboxRegistryForTests in dev/test only.",
    "Append a refused record with reason='operator-initiated rollback' for audit.",
  ];
}

function mkOperator(suffix = "ops") {
  return {
    source: `test:fixture-${suffix}`,
    note:   "phase2e-c ledger test",
  };
}

// Snapshot the live data fixtures so we can prove appending changes nothing.
function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}
const RESEARCH_SNAPSHOT     = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT       = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);

// Phase 2n drain #8 — extended baselines for the file-level isolation
// contract. Captured in before() so they reflect repo state right when this
// test process starts running.
let agentGoalsBefore:  string | null = null;
let competencyBefore:  string | null = null;
let sandboxRegBefore:  string | null = null;
let dbSizeBefore:  number | null = null;
let dbMtimeBefore: number | null = null;

before(() => {
  // Loud-failure pin: assert env-var redirects still point at TMP, not at
  // the real repo `data/`. If anything earlier in the test process mutated
  // these, fail before we can write live state.
  assert.ok(
    TMP.startsWith(os.tmpdir()) && !TMP.startsWith(REAL_DATA_DIR),
    `TMP must be under os.tmpdir() and not under real data/: TMP=${TMP}`,
  );
  assert.equal(process.env.DATA_DIR, TMP, "DATA_DIR drifted from TMP");
  assert.equal(
    process.env.DB_PATH,
    path.join(TMP, "test.db"),
    "DB_PATH drifted from TMP/test.db",
  );

  agentGoalsBefore = readIfExists(REAL_AGENT_GOALS);
  competencyBefore = readIfExists(REAL_COMPETENCY);
  sandboxRegBefore = readIfExists(REPO_RECORDS_LEDGER);
  if (fs.existsSync(REAL_DB)) {
    const st = fs.statSync(REAL_DB);
    dbSizeBefore = st.size;
    dbMtimeBefore = st.mtimeMs;
  }

  __resetLowRiskSandboxRegistryForTests();
  try { fs.unlinkSync(LEDGER_FILE); } catch {}
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("appendRegistrationRecord — happy path (summarizationTemplate)", () => {
  it("persists a summarizationTemplate registration and reads it back", () => {
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration:         reg,
      rollbackInstructions: mkRollback(),
      operator:             mkOperator(),
      featureFlagState:     { name: "phase2eb_lowrisk", enabled: true, rollout: 1.0 },
      preMetrics:           { summary_quality_score: 0.71 },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    assert.match(r.event.recordId, /^regrec_\d+_[0-9a-z]{6}$/);
    assert.match(r.event.eventId,  /^evt_\d+_[0-9a-z]{6}$/);
    assert.equal(r.event.event, "registration");
    assert.equal(r.event.kind, "summarizationTemplate");
    assert.equal(r.event.active, true);
    assert.equal(r.event.status, "active");
    assert.equal(r.event.phase2ebRegistrationId, reg.registrationId);
    assert.equal(r.event.metricKey, "summary_quality_score");
    assert.deepEqual([...(r.event.guardrailKeys ?? [])].sort(), [
      "citation_source_retention",
      "format_compliance",
      "hallucination_count",
      "length_compliance",
    ]);
    assert.equal(r.event.sandboxAutoApplyEligible, false);
    assert.equal(r.event.autoApplyPolicy, "manual-only");
    assert.equal(r.event.createdAt, reg.registeredAt);

    const all = readRecords();
    assert.equal(all.length, 1);
    assert.equal(all[0].recordId, r.event.recordId);
  });

  it("captures the full manifest, snapshot hash, pre/post metrics fields, and rollback instructions", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration({ maxTrials: 7, notes: "audit-note-1" });
    const rb = mkRollback();
    const r = appendRegistrationRecord({
      registration:         reg,
      rollbackInstructions: rb,
      operator:             mkOperator("manifest"),
      featureFlagState:     { name: "phase2eb_lowrisk", enabled: true },
      preMetrics:           { summary_quality_score: 0.7, format_compliance: 0.92 },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    // Full manifest is present.
    const m = r.event.manifest!;
    assert.equal(m.kind, "summarizationTemplate");
    assert.equal(m.sandboxMode, "sandbox-dry-run");
    assert.equal(m.metricKey, "summary_quality_score");
    assert.deepEqual([...m.guardrails].sort(), [
      "citation_source_retention",
      "format_compliance",
      "hallucination_count",
      "length_compliance",
    ]);
    assert.deepEqual(m.resourceCaps, { maxTrials: 7 });
    assert.equal(m.registeredAt, reg.registeredAt);
    assert.equal(m.controls.featureFlag, true);
    assert.equal(m.controls.dryRun, true);
    assert.equal(m.controls.fixtureSource, "static");
    assert.equal(m.controls.useScheduler, false);
    assert.equal(m.controls.promotionEligible, false);
    assert.equal(m.controls.maxTrials, 7);
    assert.equal(m.controls.notes, "audit-note-1");

    // Snapshot hash is non-empty and looks like a sha256 prefix.
    assert.ok(typeof r.event.sandboxSnapshotHash === "string");
    assert.match(r.event.sandboxSnapshotHash!, /^sha256:[0-9a-f]{64}$/);

    // preMetrics and postMetrics fields BOTH exist.
    assert.deepEqual(r.event.preMetrics, { summary_quality_score: 0.7, format_compliance: 0.92 });
    assert.deepEqual(r.event.postMetrics, {});

    // Rollback instructions present and non-empty.
    assert.deepEqual([...(r.event.rollbackInstructions ?? [])], rb);

    // Operator metadata captured.
    assert.equal(r.event.operator?.source, "test:fixture-manifest");
    assert.equal(r.event.operator?.note, "phase2e-c ledger test");

    // Feature flag state captured.
    assert.equal(r.event.featureFlagState?.name, "phase2eb_lowrisk");
    assert.equal(r.event.featureFlagState?.enabled, true);
  });

  it("derives the same snapshot hash for two semantically-identical manifests", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg1 = mkSummariserRegistration({ maxTrials: 5, notes: "n1" });
    const reg2 = mkSummariserRegistration({ maxTrials: 5, notes: "n1" });
    // Same manifest content (minus the registrationId, which is excluded
    // from the hash).
    const r1 = appendRegistrationRecord({
      registration: reg1, rollbackInstructions: mkRollback(),
      operator: mkOperator("h1"), featureFlagState: { name: "ff", enabled: true },
    });
    const r2 = appendRegistrationRecord({
      registration: reg2, rollbackInstructions: mkRollback(),
      operator: mkOperator("h2"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r1.ok, true); assert.equal(r2.ok, true);
    if (!r1.ok || !r2.ok) return;
    assert.equal(r1.event.sandboxSnapshotHash, r2.event.sandboxSnapshotHash,
      "identical manifests should hash to the same snapshot hash");
  });

  it("derives different snapshot hashes when the manifest differs", () => {
    __resetLowRiskSandboxRegistryForTests();
    const regA = mkSummariserRegistration({ maxTrials: 5, notes: "A" });
    const regB = mkSummariserRegistration({ maxTrials: 6, notes: "A" });
    const rA = appendRegistrationRecord({
      registration: regA, rollbackInstructions: mkRollback(),
      operator: mkOperator("dA"), featureFlagState: { name: "ff", enabled: true },
    });
    const rB = appendRegistrationRecord({
      registration: regB, rollbackInstructions: mkRollback(),
      operator: mkOperator("dB"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(rA.ok, true); assert.equal(rB.ok, true);
    if (!rA.ok || !rB.ok) return;
    assert.notEqual(rA.event.sandboxSnapshotHash, rB.event.sandboxSnapshotHash);
  });

  it("accepts a caller-supplied snapshot hash verbatim", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("supplied"),
      featureFlagState: { name: "ff", enabled: true },
      sandboxSnapshotHash: "sha256:cafebabe-supplied-by-caller",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.event.sandboxSnapshotHash, "sha256:cafebabe-supplied-by-caller");
  });
});

// ── sandboxAutoApplyEligible default + behaviour ────────────────────────────

describe("sandboxAutoApplyEligible default and behaviour", () => {
  it("defaults to false when not specified", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("default"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.event.sandboxAutoApplyEligible, false,
      "Phase 2e-c MUST default sandboxAutoApplyEligible to false");
  });

  it("accepts but never acts on sandboxAutoApplyEligible=true (no auto-apply side effects)", () => {
    __resetLowRiskSandboxRegistryForTests();
    const beforeRegMap = listLowRiskSandboxRegistrations().length;
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("autoeligible"),
      featureFlagState: { name: "ff", enabled: true },
      sandboxAutoApplyEligible: true,
      autoApplyPolicy: "sandbox-auto-apply-allowed",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.event.sandboxAutoApplyEligible, true,
      "the recorded flag should reflect what the caller asked for");
    assert.equal(r.event.autoApplyPolicy, "sandbox-auto-apply-allowed");

    // No auto-apply side effects: the in-memory Phase 2e-b map gained
    // exactly one entry (the test's own `mkSummariserRegistration` call),
    // not two; nothing in the ledger module tried to register again.
    const afterRegMap = listLowRiskSandboxRegistrations().length;
    assert.equal(afterRegMap, beforeRegMap + 1,
      "Phase 2e-c MUST NOT trigger any auto-apply side effect");
  });
});

// ── Refusals ────────────────────────────────────────────────────────────────

describe("appendRegistrationRecord — refusals", () => {
  it("refuses when rollbackInstructions is missing", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg,
      rollbackInstructions: undefined as any,
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /rollbackInstructions/i);
  });

  it("refuses when rollbackInstructions is empty", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg,
      rollbackInstructions: [],
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /rollbackInstructions/i);
  });

  it("refuses when rollbackInstructions contains a non-string entry", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg,
      rollbackInstructions: ["step 1", "" as any, "step 3"],
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, false);
  });

  it("refuses when supplied sandboxSnapshotHash is empty / blank", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
      sandboxSnapshotHash: "   ",
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /sandboxSnapshotHash/i);
  });

  it("refuses when operator.source is empty", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: { source: "  " },
      featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /operator/i);
  });

  it("refuses when featureFlagState is missing or malformed", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator(),
      featureFlagState: undefined as any,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /featureFlagState/i);
  });

  it("refuses when preMetrics has a non-finite number", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
      preMetrics: { x: NaN } as any,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /preMetrics/i);
  });

  it("refuses a Phase 2e-b refusal — disabled kinds cannot become active registrations", () => {
    __resetLowRiskSandboxRegistryForTests();
    const refusal = registerLowRiskSandboxKind("reasoningTemplate", controls(), NOW);
    assert.equal(refusal.ok, false);
    if (refusal.ok) return;
    const r = appendRegistrationRecord({
      registration: refusal as unknown as LowRiskSandboxRegistration,
      rollbackInstructions: mkRollback(),
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /registration\.ok must be true|recognised low-risk sandbox kind/i);
  });

  it("refuses to write the ledger on validation failure", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const beforeRaw = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
    appendRegistrationRecord({
      registration: reg,
      rollbackInstructions: [],
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    const afterRaw = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE, "utf8") : "";
    assert.equal(afterRaw, beforeRaw, "ledger MUST NOT be written when validation refuses");
  });
});

// ── Append-only behaviour + corrupt-line tolerance ──────────────────────────

describe("append-only behaviour", () => {
  it("earlier records survive subsequent appends, and the reader skips corrupt lines", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const before = readRecords().length;
    const r1 = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("a1"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r1.ok, true);

    fs.appendFileSync(LEDGER_FILE, "this-is-not-json\n", "utf8");

    __resetLowRiskSandboxRegistryForTests();
    const reg2 = mkSummariserRegistration();
    const r2 = appendRegistrationRecord({
      registration: reg2, rollbackInstructions: mkRollback(),
      operator: mkOperator("a2"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r2.ok, true);

    const all = readRecords();
    assert.equal(all.length, before + 2);
    const sources = all.slice(-2).map(e => e.source);
    assert.deepEqual(sources, ["test:fixture-a1", "test:fixture-a2"]);

    const raw = fs.readFileSync(LEDGER_FILE, "utf8");
    assert.ok(raw.includes("this-is-not-json"),
      "corrupt line should still be on disk; reader skipped it");
  });

  it("readRecordsTail returns most-recent first", () => {
    const tail = readRecordsTail(2);
    assert.equal(tail.length, 2);
    assert.equal(tail[0].source, "test:fixture-a2");
    assert.equal(tail[1].source, "test:fixture-a1");
  });

  it("registration row is unchanged after a completion event is appended", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r1 = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("regrow"), featureFlagState: { name: "ff", enabled: true },
      preMetrics: { summary_quality_score: 0.7 },
    });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;

    const beforeRaw = fs.readFileSync(LEDGER_FILE, "utf8");
    const c = appendCompletionRecord({
      recordId: r1.event.recordId,
      postMetrics: { summary_quality_score: 0.84 },
      operator: mkOperator("complete"),
      outcome: "clean",
    });
    assert.equal(c.ok, true);
    if (!c.ok) return;
    const afterRaw = fs.readFileSync(LEDGER_FILE, "utf8");
    // The original registration line is still present, byte-for-byte.
    assert.ok(afterRaw.startsWith(beforeRaw),
      "append-only: the prior registration line must still be present at the start of the file (or earlier in it)");

    const events = readRecordsForRecordId(r1.event.recordId);
    assert.equal(events.length, 2);
    const reg1 = events.find(e => e.event === "registration")!;
    const com1 = events.find(e => e.event === "completion")!;
    assert.deepEqual(reg1.postMetrics, {},
      "the registration row's postMetrics is still {} — completion lives on a separate line");
    assert.deepEqual(com1.postMetrics, { summary_quality_score: 0.84 });
    assert.equal(com1.active, false);
    assert.equal(com1.status, "completed");
    assert.ok(com1.completedAt);
    assert.equal(com1.kind, "summarizationTemplate");
  });

  it("readActiveRegistrationRecords excludes completed registrations and refused rows", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r1 = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("active1"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;

    const activeBefore = readActiveRegistrationRecords();
    assert.ok(activeBefore.some(e => e.recordId === r1.event.recordId));

    const c = appendCompletionRecord({
      recordId: r1.event.recordId,
      postMetrics: { summary_quality_score: 0.91 },
      operator: mkOperator("active1-done"),
    });
    assert.equal(c.ok, true);

    const activeAfter = readActiveRegistrationRecords();
    assert.ok(!activeAfter.some(e => e.recordId === r1.event.recordId),
      "a completed registration MUST NOT appear in readActiveRegistrationRecords");
  });
});

// ── Completion validation ───────────────────────────────────────────────────

describe("appendCompletionRecord — validation", () => {
  it("refuses when recordId names no prior registration", () => {
    const r = appendCompletionRecord({
      recordId: "regrec_does_not_exist",
      postMetrics: { summary_quality_score: 0.9 },
      operator: mkOperator("ghost"),
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /no prior registration/i);
  });

  it("refuses when postMetrics is empty", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r1 = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    const r2 = appendCompletionRecord({
      recordId: r1.event.recordId,
      postMetrics: {},
      operator: mkOperator(),
    });
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.match(r2.reason, /postMetrics/i);
  });

  it("refuses when postMetrics contains a non-finite value", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r1 = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator(), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    const r2 = appendCompletionRecord({
      recordId: r1.event.recordId,
      postMetrics: { x: Infinity } as any,
      operator: mkOperator(),
    });
    assert.equal(r2.ok, false);
  });
});

// ── Refused row ─────────────────────────────────────────────────────────────

describe("appendRefusedRegistrationRecord — disabled-kind audit trail", () => {
  it("persists a refusal for a disabled kind as a non-active record", () => {
    __resetLowRiskSandboxRegistryForTests();
    const refusal = registerLowRiskSandboxKind("selfCritiquePrompt", controls(), NOW);
    assert.equal(refusal.ok, false);
    if (refusal.ok) return;
    const r = appendRefusedRegistrationRecord({
      refusal: refusal as LowRiskSandboxRegistrationRefusal,
      operator: mkOperator("disabled"),
      featureFlagState: { name: "phase2eb_lowrisk", enabled: true },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.event.event, "refused");
    assert.equal(r.event.active, false);
    assert.equal(r.event.status, "refused");
    assert.equal(r.event.kind, "selfCritiquePrompt");
    assert.equal(r.event.refusalCode, "kind_disabled");
    assert.ok(Array.isArray(r.event.refusalEvidence));
    assert.equal(r.event.sandboxAutoApplyEligible, false,
      "refused rows are never auto-apply eligible");
  });

  it("refuses to persist a non-refusal shape", () => {
    const r = appendRefusedRegistrationRecord({
      refusal: { ok: true } as any,
      operator: mkOperator(),
    });
    assert.equal(r.ok, false);
  });
});

// ── DATA_DIR isolation + non-mutation invariants ────────────────────────────

describe("DATA_DIR isolation + non-mutation", () => {
  it("writes the ledger under DATA_DIR, not the repo's data/ directory", () => {
    assert.ok(fs.existsSync(LEDGER_FILE), "expected ledger inside the temp DATA_DIR");
    assert.equal(fs.existsSync(REPO_RECORDS_LEDGER), false,
      "ledger leaked into the repo's data/ directory");
  });

  it("does not mutate research_lab.json, memory_knowledge.json, or the Phase 2d ledger", () => {
    const research = snapshot(REAL_RESEARCH_LAB);
    const memory   = snapshot(REAL_MEMORY_KB);
    const dec      = snapshot(REAL_DECISION_LEDGER);
    assert.equal(research.exists, RESEARCH_SNAPSHOT.exists);
    assert.equal(research.content, RESEARCH_SNAPSHOT.content,
      "research_lab.json must be unchanged by Phase 2e-c");
    assert.equal(memory.exists,   MEMORY_SNAPSHOT.exists);
    assert.equal(memory.content,  MEMORY_SNAPSHOT.content,
      "memory_knowledge.json must be unchanged by Phase 2e-c");
    assert.equal(dec.exists,      DECISION_LEDGER_SNAPSHOT.exists);
    assert.equal(dec.content,     DECISION_LEDGER_SNAPSHOT.content,
      "Phase 2d decision events ledger must be unchanged by Phase 2e-c");
  });
});

// ── Filter helper ───────────────────────────────────────────────────────────

describe("readRecordsForRecordId", () => {
  it("returns events for the requested recordId only", () => {
    __resetLowRiskSandboxRegistryForTests();
    const reg = mkSummariserRegistration();
    const r = appendRegistrationRecord({
      registration: reg, rollbackInstructions: mkRollback(),
      operator: mkOperator("filter"), featureFlagState: { name: "ff", enabled: true },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const onlyOne = readRecordsForRecordId(r.event.recordId);
    for (const ev of onlyOne) assert.equal(ev.recordId, r.event.recordId);
    const none = readRecordsForRecordId("regrec_does_not_exist");
    assert.equal(none.length, 0);
    const blank = readRecordsForRecordId("");
    assert.equal(blank.length, 0);
  });
});

// ── File-level isolation contract ────────────────────────────────────────────
//
// Phase 2n drain #8 — mirrors the contract added by drains #1–#7. Asserts
// that after every test in this file runs, none of the 7 watched live-state
// files under repo `data/` have been touched, and that env-var redirects are
// still pinned. The Phase 2e-c test predates the drain template and already
// snapshotted three files (research_lab.json, memory_knowledge.json, and the
// Phase 2d decision-events ledger); those pins are preserved by the existing
// "DATA_DIR isolation + non-mutation" describe block, and this block extends
// coverage to the canonical 7 watched live-state files.

describe("sandboxRegistrationRecords.test.ts — file-level isolation contract", () => {
  it("env-var redirects are still pointing at TMP", () => {
    assert.equal(process.env.DATA_DIR, TMP);
    assert.equal(process.env.DB_PATH, path.join(TMP, "test.db"));
  });

  it("research_lab.json is unchanged", () => {
    assert.equal(readIfExists(REAL_RESEARCH_LAB), RESEARCH_SNAPSHOT.content ?? null);
  });

  it("memory_knowledge.json is unchanged", () => {
    assert.equal(readIfExists(REAL_MEMORY_KB), MEMORY_SNAPSHOT.content ?? null);
  });

  it("agent_goals.json is unchanged", () => {
    assert.equal(readIfExists(REAL_AGENT_GOALS), agentGoalsBefore);
  });

  it("competencyProfile.json is unchanged", () => {
    assert.equal(readIfExists(REAL_COMPETENCY), competencyBefore);
  });

  it("experiment_decision_events.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_DECISION_LEDGER), DECISION_LEDGER_SNAPSHOT.content ?? null);
  });

  it("sandbox_registration_records.jsonl in repo data/ is unchanged (no ledger leak)", () => {
    // This is the SAFETY-CRITICAL pin for this drain: the ledger MUST live in
    // TMP, never in the repo's data/ directory. The original Phase 2e-c test
    // had a "ledger leaked into the repo's data/ directory" assertion, but
    // this block strengthens it to the byte-equal baseline form used by all
    // other drains.
    assert.equal(readIfExists(REPO_RECORDS_LEDGER), sandboxRegBefore);
  });

  it("agent306.db is unchanged (size + mtime)", () => {
    // Under the aggregate parallel runner sibling test files
    // concurrently write to live data/agent306.db. The per-file
    // contract check is meant to catch *this file* mutating live
    // DB; under aggregate runs the mtime drift comes from siblings,
    // not us. scripts/checkCoreStateIntegrity.sh remains the
    // canonical end-of-run check. See PR #354 for the race.
    if (process.env.AGENT306_AGGREGATE_RUN === "1") return;
    if (dbSizeBefore === null) {
      assert.equal(fs.existsSync(REAL_DB), false, "agent306.db should not have been created");
      return;
    }
    assert.ok(fs.existsSync(REAL_DB), "agent306.db must still exist");
    const st = fs.statSync(REAL_DB);
    assert.equal(st.size, dbSizeBefore, "agent306.db size changed");
    assert.equal(st.mtimeMs, dbMtimeBefore, "agent306.db mtime changed (WAL-aware check)");
  });
});
