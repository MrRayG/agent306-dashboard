/**
 * Tests for Track A / Phase 3a-prep-d sample candidate JSON fixtures
 * (`examples/phase3aPrep/`).
 *
 * Phase 3a-prep-d adds three caller-supplied candidate bundles under
 * `examples/phase3aPrep/` as smoke fixtures for the manual readiness
 * runner (`scripts/runManualPhase3aPrepEvaluation.ts`). The fixtures
 * are declarative-only — they exist so an operator can run the manual
 * CLI end-to-end without first hand-rolling a 7 × 2 attestation
 * matrix. They are NOT a schema bump, NOT a registration record, NOT
 * imported by any production-runtime surface, and NOT a substitute
 * for the runner's own test suite (which already exercises the same
 * three verdict states with inline-built candidates).
 *
 * Spec invariants pinned by this file:
 *
 *   1. Every fixture file exists on disk under `examples/phase3aPrep/`.
 *   2. Every fixture file parses as a JSON object with the three
 *      caller-required outer fields (`candidateId`, `kind`,
 *      `preconditions`) — the same minimal surface the runner's
 *      `loadCandidate` helper validates.
 *   3. Each fixture, when fed through `computePhase3aPrepReadiness`,
 *      yields the verdict its filename advertises:
 *        - `candidate-fully-prepared.json`  → `verdict: "fully_prepared"`
 *        - `candidate-high-tier-ready.json` → `verdict: "high_tier_ready"`
 *        - `candidate-not-ready.json`       → `verdict: "not_ready"`
 *   4. Each fixture, when fed through `runManualPhase3aPrepEvaluationCli`,
 *      exits with code 0, writes exactly one JSON payload to stdout,
 *      writes exactly one safety-invariants banner to stderr, and the
 *      payload's `readiness.verdict` matches the expected verdict.
 *   5. None of the fixture files lives under `server/`, `client/`, or
 *      `scripts/`. They live under `examples/phase3aPrep/` and are
 *      therefore invisible to every Phase 3 boundary-regression pin.
 *   6. The fixtures' declared `kind` is `"summarizationTemplate"`
 *      verbatim — the only Phase 3a-eligible sandbox kind.
 *   7. The fixture directory contains a `README.md` declaring the
 *      "NOT a schema bump / NOT a registration record / NOT imported
 *      by production-runtime" invariants.
 *
 * Drain template (full file-level isolation contract per the Phase 2n
 * drain standard): env-var pin BEFORE node:test import, ORIGINAL_*
 * capture/restore, loud-failure before() pin, 7-file snapshots,
 * after() diff, DB-stat gate under AGENT306_AGGREGATE_RUN.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trackA-phase3aPrepFixtures-test-"));
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.DB_PATH  = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");

const {
  computePhase3aPrepReadiness,
  PHASE3A_PREP_PRECONDITION_KEYS,
} = await import("../experiments/phase3aPrepHarness.ts");
const {
  runManualPhase3aPrepEvaluationCli,
} = await import("../../scripts/runManualPhase3aPrepEvaluation.ts");

type Phase3aPrepCandidate = Parameters<typeof computePhase3aPrepReadiness>[0];
type Phase3aPrepVerdict = ReturnType<typeof computePhase3aPrepReadiness>["verdict"];

const FIXTURE_DIR = path.join(REPO_ROOT, "examples", "phase3aPrep");
const FIXTURE_README = path.join(FIXTURE_DIR, "README.md");

const FIXTURE_FULLY_PREPARED  = path.join(FIXTURE_DIR, "candidate-fully-prepared.json");
const FIXTURE_HIGH_TIER_READY = path.join(FIXTURE_DIR, "candidate-high-tier-ready.json");
const FIXTURE_NOT_READY       = path.join(FIXTURE_DIR, "candidate-not-ready.json");

const FIXTURES: ReadonlyArray<{
  readonly label:    string;
  readonly file:     string;
  readonly verdict:  Phase3aPrepVerdict;
}> = [
  { label: "candidate-fully-prepared.json",  file: FIXTURE_FULLY_PREPARED,  verdict: "fully_prepared"  },
  { label: "candidate-high-tier-ready.json", file: FIXTURE_HIGH_TIER_READY, verdict: "high_tier_ready" },
  { label: "candidate-not-ready.json",       file: FIXTURE_NOT_READY,       verdict: "not_ready"       },
] as const;

const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_AGENT_GOALS     = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY      = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const REAL_DB              = path.join(REPO_ROOT, "data", "agent306.db");

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
function dbStat(p: string): { exists: boolean; size?: number; mtimeMs?: number } {
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
}
const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const AGENT_GOALS_SNAPSHOT     = snapshot(REAL_AGENT_GOALS);
const COMPETENCY_SNAPSHOT      = snapshot(REAL_COMPETENCY);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);
const DB_SNAPSHOT              = dbStat(REAL_DB);

before(() => {
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const tmpReal = fs.realpathSync(TMP_DIR);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`phase3aPrepFixtures isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`phase3aPrepFixtures isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP_DIR) {
    throw new Error(`phase3aPrepFixtures isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP_DIR, "test.db")) {
    throw new Error(`phase3aPrepFixtures isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

after(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

  const afterSnap = (p: string) => snapshot(p);
  for (const [label, beforeSnap, p] of [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const a = afterSnap(p);
    if (beforeSnap.exists) {
      if (!a.exists) throw new Error(`phase3aPrepFixtures tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`phase3aPrepFixtures tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`phase3aPrepFixtures tests created live ${label}!`);
    }
  }

  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
    const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`phase3aPrepFixtures tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`phase3aPrepFixtures tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`phase3aPrepFixtures tests created live agent306.db!`);
    }
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

function readFixtureJson(p: string): unknown {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function makeIo() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  return {
    io: {
      stdout: (s: string) => { stdoutChunks.push(s); },
      stderr: (s: string) => { stderrChunks.push(s); },
    },
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}

// ── 1. Directory + README ──────────────────────────────────────────────

describe("Phase 3a-prep-d — fixture directory layout", () => {
  it("examples/phase3aPrep/ directory exists", () => {
    assert.ok(fs.existsSync(FIXTURE_DIR), `${FIXTURE_DIR} must exist`);
    assert.ok(fs.statSync(FIXTURE_DIR).isDirectory(), `${FIXTURE_DIR} must be a directory`);
  });

  it("README.md exists and declares the NOT-a-schema-bump invariant", () => {
    assert.ok(fs.existsSync(FIXTURE_README), `${FIXTURE_README} must exist`);
    const src = fs.readFileSync(FIXTURE_README, "utf8");
    assert.match(src, /NOT a schema bump/i, "README must declare the NOT-a-schema-bump invariant");
    assert.match(src, /NOT a registration record/i, "README must declare the NOT-a-registration-record invariant");
    assert.match(src, /NOT imported by any production-runtime/i, "README must declare the NOT-imported-by-production-runtime invariant");
  });

  it("fixture directory contains exactly the three expected fixture JSON files", () => {
    const entries = fs.readdirSync(FIXTURE_DIR)
      .filter(name => name.endsWith(".json"))
      .sort();
    assert.deepEqual(entries, [
      "candidate-fully-prepared.json",
      "candidate-high-tier-ready.json",
      "candidate-not-ready.json",
    ], "examples/phase3aPrep/ must contain exactly the three documented fixtures");
  });
});

// ── 2. Outer-shape parse ───────────────────────────────────────────────

describe("Phase 3a-prep-d — every fixture parses with the runner's outer shape", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label} parses as a JSON object with candidateId / kind / preconditions`, () => {
      assert.ok(fs.existsSync(fx.file), `${fx.file} must exist`);
      const parsed = readFixtureJson(fx.file);
      assert.equal(typeof parsed, "object", `${fx.label} must parse as an object`);
      assert.notEqual(parsed, null, `${fx.label} must not parse as null`);
      assert.equal(Array.isArray(parsed), false, `${fx.label} must not parse as an array`);
      const obj = parsed as Record<string, unknown>;
      assert.equal(typeof obj.candidateId, "string", `${fx.label} .candidateId must be a string`);
      assert.notEqual((obj.candidateId as string).length, 0, `${fx.label} .candidateId must be non-empty`);
      assert.equal(obj.kind, "summarizationTemplate", `${fx.label} .kind must equal the Phase 3a-eligible literal`);
      assert.equal(typeof obj.preconditions, "object", `${fx.label} .preconditions must be an object`);
      assert.notEqual(obj.preconditions, null, `${fx.label} .preconditions must not be null`);
    });

    it(`${fx.label} preconditions covers all seven keys with both tiers`, () => {
      const parsed = readFixtureJson(fx.file) as { preconditions: Record<string, Record<string, unknown>> };
      for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
        const entry = parsed.preconditions[key];
        assert.ok(entry, `${fx.label} missing precondition '${key}'`);
        assert.ok(entry.high, `${fx.label} precondition '${key}' missing 'high' tier`);
        assert.ok(entry.low,  `${fx.label} precondition '${key}' missing 'low' tier`);
      }
    });
  }
});

// ── 3. Harness verdict per fixture ─────────────────────────────────────

describe("Phase 3a-prep-d — computePhase3aPrepReadiness yields the advertised verdict", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label} yields verdict '${fx.verdict}'`, () => {
      const candidate = readFixtureJson(fx.file) as Phase3aPrepCandidate;
      const readiness = computePhase3aPrepReadiness(candidate);
      assert.equal(
        readiness.verdict,
        fx.verdict,
        `${fx.label} expected verdict '${fx.verdict}' but got '${readiness.verdict}' (blockers: ${readiness.blockers.join("; ")})`,
      );
    });
  }

  it("fully-prepared fixture has highTierAllSatisfied AND lowTierAllSatisfied AND no blockers", () => {
    const candidate = readFixtureJson(FIXTURE_FULLY_PREPARED) as Phase3aPrepCandidate;
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.highTierAllSatisfied, true);
    assert.equal(r.lowTierAllSatisfied,  true);
    assert.equal(r.blockers.length, 0, `expected zero blockers but got: ${r.blockers.join("; ")}`);
  });

  it("high-tier-ready fixture has highTierAllSatisfied but not lowTierAllSatisfied", () => {
    const candidate = readFixtureJson(FIXTURE_HIGH_TIER_READY) as Phase3aPrepCandidate;
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.highTierAllSatisfied, true);
    assert.equal(r.lowTierAllSatisfied,  false);
    assert.ok(r.blockers.length > 0, "high-tier-ready fixture must surface at least one low-tier blocker");
  });

  it("not-ready fixture has highTierAllSatisfied=false", () => {
    const candidate = readFixtureJson(FIXTURE_NOT_READY) as Phase3aPrepCandidate;
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.highTierAllSatisfied, false);
    assert.ok(r.blockers.length > 0, "not-ready fixture must surface at least one high-tier blocker");
    const hasRollbackProofBlocker = r.blockers.some(b => b.includes("rollbackProof"));
    assert.ok(hasRollbackProofBlocker, `not-ready fixture must surface a rollbackProof blocker (got: ${r.blockers.join("; ")})`);
  });
});

// ── 4. Runner CLI round-trip per fixture ───────────────────────────────

describe("Phase 3a-prep-d — runManualPhase3aPrepEvaluationCli round-trips each fixture", () => {
  for (const fx of FIXTURES) {
    it(`${fx.label} round-trips through the runner CLI (exit 0, one JSON payload, verdict matches)`, () => {
      const { io, stdout, stderr } = makeIo();
      const result = runManualPhase3aPrepEvaluationCli(
        ["--candidate", fx.file, "--json"],
        io,
      );
      assert.equal(result.exitCode, 0, `${fx.label} runner must exit 0 (stderr: ${stderr()})`);
      assert.notEqual(result.payload, null, `${fx.label} runner must produce a payload`);
      assert.equal(result.payload!.readiness.verdict, fx.verdict, `${fx.label} payload verdict mismatch`);

      const out = stdout();
      assert.notEqual(out.length, 0, `${fx.label} runner must write to stdout`);
      // Exactly one JSON payload (the runner trims to one stdout chunk).
      const parsedStdout = JSON.parse(out);
      assert.equal(parsedStdout.readiness.verdict, fx.verdict);
      assert.equal(parsedStdout.candidateId, (readFixtureJson(fx.file) as { candidateId: string }).candidateId);
      assert.equal(parsedStdout.kind, "summarizationTemplate");

      const err = stderr();
      assert.notEqual(err.length, 0, `${fx.label} runner must write the safety banner to stderr`);
    });
  }

  it("fully-prepared fixture round-trips with --pretty as multi-line indented JSON", () => {
    const { io, stdout } = makeIo();
    const result = runManualPhase3aPrepEvaluationCli(
      ["--candidate", FIXTURE_FULLY_PREPARED, "--pretty"],
      io,
    );
    assert.equal(result.exitCode, 0);
    const out = stdout();
    assert.ok(out.includes("\n"), "--pretty must emit multi-line JSON");
    const parsed = JSON.parse(out);
    assert.equal(parsed.readiness.verdict, "fully_prepared");
  });
});

// ── 5. Location invariants (fixtures live outside policed trees) ───────

describe("Phase 3a-prep-d — fixtures live outside every policed tree", () => {
  it("no fixture file lives under server/, client/, or scripts/", () => {
    for (const fx of FIXTURES) {
      const rel = path.relative(REPO_ROOT, fx.file).replace(/\\/g, "/");
      assert.equal(rel.startsWith("examples/phase3aPrep/"), true, `${fx.label} must live under examples/phase3aPrep/`);
      assert.equal(rel.startsWith("server/"),  false, `${fx.label} must not live under server/`);
      assert.equal(rel.startsWith("client/"),  false, `${fx.label} must not live under client/`);
      assert.equal(rel.startsWith("scripts/"), false, `${fx.label} must not live under scripts/`);
    }
  });

  it("fixture directory contains no .ts files (declarative-only)", () => {
    const tsFiles = fs.readdirSync(FIXTURE_DIR).filter(name => name.endsWith(".ts"));
    assert.deepEqual(tsFiles, [], `examples/phase3aPrep/ must not contain .ts files; found: ${tsFiles.join(", ")}`);
  });
});

// ── File-level isolation contract ──────────────────────────────────────

describe("Phase 3a-prep-d — file-level isolation contract", () => {
  it("TMP_DIR is under os.tmpdir() and NOT under repo root", () => {
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const tmpReal = fs.realpathSync(TMP_DIR);
    assert.ok(tmpReal.startsWith(tmpRoot), `TMP must be under os.tmpdir(): ${tmpReal}`);
    assert.ok(!tmpReal.startsWith(REPO_ROOT), `TMP must NOT be under repo root: ${tmpReal}`);
  });
  it("DATA_DIR and DB_PATH point into TMP_DIR for the duration of the suite", () => {
    assert.equal(process.env.DATA_DIR, TMP_DIR);
    assert.equal(process.env.DB_PATH, path.join(TMP_DIR, "test.db"));
  });
  it("ORIGINAL_* env vars were captured BEFORE node:test import", () => {
    // Sentinel — if these are not the captured originals, the after()
    // hook will restore the wrong values. The act of importing this
    // suite pins that the captures executed at module top level.
    assert.notEqual(ORIGINAL_DATA_DIR, TMP_DIR, "ORIGINAL_DATA_DIR was captured before we overwrote it");
    assert.notEqual(ORIGINAL_DB_PATH,  path.join(TMP_DIR, "test.db"), "ORIGINAL_DB_PATH was captured before we overwrote it");
  });
});
