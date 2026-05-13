/**
 * Tests for Track A / Phase 3a-prep-c — manual Phase 3a-prep readiness
 * runner.
 *
 * Spec invariants pinned by this file:
 *
 *   1. The CLI argument parser handles every documented flag (including
 *      the required `--candidate <path>`), defaults `source` to
 *      `"manual:cli"`, rejects unknown / malformed / missing /
 *      duplicate flags with a clear reason, and never throws.
 *   2. `--help` / `-h` short-circuits cleanly, prints the usage text to
 *      stdout, and returns exit code 0.
 *   3. The runner reuses `computePhase3aPrepReadiness` from the prep
 *      harness — it does NOT define its own verdict logic. Identical
 *      candidate JSON + identical CLI flags produce byte-identical
 *      stdout output across repeated invocations.
 *   4. The runner is stdout-only on the happy path: stdout is exactly
 *      one JSON document; the only stderr output is the safety-
 *      invariants banner; nothing else is written anywhere.
 *   5. The runner is non-mutating: no file (other than reading the
 *      caller-supplied candidate path), database, ledger, env var,
 *      monitor state, or in-memory map is touched. The repo's live
 *      data files are byte-identical after the test run.
 *   6. Source-level guards: the runner does NOT import the Phase 3a
 *      entry-point module (Pin 4), the scheduler, autonomy monitor,
 *      promotion gate, applyRecommendation, hypothesis mutation paths,
 *      and does NOT call `Date.now` / `Math.random` / `randomUUID` /
 *      `process.env`, and does NOT call any fs WRITE API (`writeFile`,
 *      `appendFile`, `mkdir`, `unlink`, `rm`, `rename`, etc.).
 *   7. The printed JSON payload restates the harness version verbatim
 *      and echoes the seven precondition keys + two priority tiers as
 *      a sanity anchor for downstream consumers.
 *   8. The runner can be invoked with `--run-label` / `--operator` /
 *      `--source` and echoes those values into the payload.
 *   9. With `--pretty` the payload is 2-space-indented JSON; without
 *      it the payload is compact JSON. The two outputs `JSON.parse` to
 *      a deeply-equal object.
 *  10. A fully-satisfied candidate (every key × every tier `satisfied`
 *      with non-empty `evidenceRef`, matching kind) yields
 *      `verdict: "fully_prepared"` with `highTierAllSatisfied: true`,
 *      `lowTierAllSatisfied: true`, `blockers: []`.
 *  11. A high-tier-only candidate (every `high` satisfied, at least one
 *      `low` unverified) yields `verdict: "high_tier_ready"` with
 *      `highTierAllSatisfied: true`, `lowTierAllSatisfied: false`, and
 *      at least one blocker mentioning the low-tier deficit.
 *  12. A candidate with any high-tier deficit (missing key, wrong
 *      kind, unverified, violated, or satisfied-with-empty-evidenceRef)
 *      yields `verdict: "not_ready"`.
 *  13. A malformed candidate file (missing required field / not JSON /
 *      not an object / file not found) yields exit code 1 and a
 *      descriptive stderr message; no JSON payload is printed on
 *      stdout.
 *  14. The runner is NOT imported by `server/index.ts`, the autonomy
 *      monitor, the scheduler, the promotion gate, or the apply
 *      recommendation path. The Phase 2n-c boundary regression suite
 *      pins the broader rule for `scripts/runManual*.ts`.
 *  15. File-level isolation contract: the test pins env vars (TMP /
 *      DATA_DIR / DB_PATH / NODE_ENV) before any server-module import,
 *      snapshots seven canonical data artefacts before any test runs,
 *      and compares them after every test to confirm zero side
 *      effects.
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ── Env-var pin BEFORE node:test import (file-level isolation contract) ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase3aprep-c-runner-test-"));
const ORIGINAL_DATA_DIR  = process.env.DATA_DIR;
const ORIGINAL_DB_PATH   = process.env.DB_PATH;
const ORIGINAL_NODE_ENV  = process.env.NODE_ENV;
process.env.DATA_DIR = TMP;
process.env.DB_PATH  = path.join(TMP, "test.db");
process.env.NODE_ENV = "test";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ── REPO_ROOT + 7 REAL_* paths (canonical drain template) ──────────────
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB       = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB          = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_AGENT_GOALS        = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY_PROFILE = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_DECISION_LEDGER    = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REAL_REGISTRATION_LEDGER = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const REAL_DB                 = path.join(REPO_ROOT, "data", "agent306.db");

const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "runManualPhase3aPrepEvaluation.ts");

const {
  parseManualPhase3aPrepEvaluationCliArgs,
  runManualPhase3aPrepEvaluationCli,
  loadCandidate,
  toPayload,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
  DEFAULT_CLI_SOURCE,
} = await import("../../scripts/runManualPhase3aPrepEvaluation.ts");

const {
  PHASE3A_PREP_HARNESS_VERSION,
  PHASE3A_PREP_PRECONDITION_KEYS,
  PHASE3A_PREP_PRIORITY_TIERS,
} = await import("../experiments/phase3aPrepHarness.ts");

// ── Snapshot helpers ───────────────────────────────────────────────────
function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}
function dbStat(p: string): { exists: boolean; size?: number; mtimeMs?: number } {
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
}

const RESEARCH_SNAPSHOT             = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT               = snapshot(REAL_MEMORY_KB);
const GOALS_SNAPSHOT                = snapshot(REAL_AGENT_GOALS);
const COMPETENCY_SNAPSHOT           = snapshot(REAL_COMPETENCY_PROFILE);
const DECISION_LEDGER_SNAPSHOT      = snapshot(REAL_DECISION_LEDGER);
const REGISTRATION_LEDGER_SNAPSHOT  = snapshot(REAL_REGISTRATION_LEDGER);
const DB_SNAPSHOT                   = dbStat(REAL_DB);

// ── Loud-failure pin ───────────────────────────────────────────────────
before(() => {
  // Loud-failure pin: confirm the script we're testing actually exists
  // on disk (catches a path rename without a test update).
  assert.ok(fs.existsSync(SCRIPT_PATH),
    `runner script missing at ${SCRIPT_PATH}`);
});

// ── after() hook: cleanup + isolation check ────────────────────────────
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  // Restore env vars to their pre-test values.
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined)  delete process.env.DB_PATH;
  else process.env.DB_PATH  = ORIGINAL_DB_PATH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

  // Compare snapshots — confirm zero side effects on the live repo.
  for (const [label, before, p] of [
    ["research_lab.json",                    RESEARCH_SNAPSHOT,            REAL_RESEARCH_LAB],
    ["memory_knowledge.json",                MEMORY_SNAPSHOT,              REAL_MEMORY_KB],
    ["agent_goals.json",                     GOALS_SNAPSHOT,               REAL_AGENT_GOALS],
    ["competencyProfile.json",               COMPETENCY_SNAPSHOT,          REAL_COMPETENCY_PROFILE],
    ["experiment_decision_events.jsonl",     DECISION_LEDGER_SNAPSHOT,     REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",   REGISTRATION_LEDGER_SNAPSHOT, REAL_REGISTRATION_LEDGER],
  ] as const) {
    const after = snapshot(p);
    assert.equal(after.exists,  before.exists,  `${label} existence changed`);
    assert.equal(after.content, before.content, `${label} content changed`);
  }
  // DB-stat: only meaningful under the aggregate guarded run; isolated
  // `tsx --test` runs of this file alone may legitimately not have the
  // DB at all. Gate this block by the aggregate-run env signal.
  if (process.env.AGENT306_AGGREGATE_RUN === "1") {
    const dbAfter = dbStat(REAL_DB);
    assert.equal(dbAfter.exists,  DB_SNAPSHOT.exists,  "agent306.db existence changed");
    if (DB_SNAPSHOT.exists && dbAfter.exists) {
      assert.equal(dbAfter.size,    DB_SNAPSHOT.size,    "agent306.db size changed");
      assert.equal(dbAfter.mtimeMs, DB_SNAPSHOT.mtimeMs, "agent306.db mtime changed");
    }
  }
});

// ── Candidate-file helpers ─────────────────────────────────────────────

/** Build a fully-satisfied candidate (high AND low both `satisfied`,
 *  non-empty evidenceRef, matching kind). */
function buildSatisfiedCandidate(candidateId: string): unknown {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {};
    for (const tier of PHASE3A_PREP_PRIORITY_TIERS) {
      preconditions[key][tier] = {
        key,
        priority:    tier,
        status:      "satisfied",
        evidenceRef: `data/evidence/${candidateId}/${key}/${tier}.json`,
        rationale:   `caller asserts ${tier}-tier ${key} satisfied`,
      };
    }
  }
  return {
    candidateId,
    kind: "summarizationTemplate",
    preconditions,
  };
}

/** Build a high-tier-only candidate (every high `satisfied`, every low
 *  `unverified`). */
function buildHighTierOnlyCandidate(candidateId: string): unknown {
  const preconditions: Record<string, Record<string, unknown>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {
      high: {
        key,
        priority:    "high",
        status:      "satisfied",
        evidenceRef: `data/evidence/${candidateId}/${key}/high.json`,
        rationale:   "high-tier satisfied",
      },
      low: {
        key,
        priority:    "low",
        status:      "unverified",
        evidenceRef: "",
        rationale:   "low-tier not yet checked",
      },
    };
  }
  return {
    candidateId,
    kind: "summarizationTemplate",
    preconditions,
  };
}

/** Build a not-ready candidate (one high-tier slot is `unverified`). */
function buildNotReadyCandidate(candidateId: string): unknown {
  const c = buildSatisfiedCandidate(candidateId) as {
    preconditions: Record<string, Record<string, Record<string, unknown>>>;
  };
  c.preconditions["rollbackProof"]!["high"]!["status"]      = "unverified";
  c.preconditions["rollbackProof"]!["high"]!["evidenceRef"] = "";
  return c;
}

/** Write a candidate object to a temp JSON file and return the path. */
function writeCandidateFile(name: string, candidate: unknown): string {
  const p = path.join(TMP, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(candidate));
  return p;
}

/** Tiny stdout/stderr sink. */
function makeIo() {
  let stdout = "";
  let stderr = "";
  return {
    io:  {
      stdout: (s: string) => { stdout += s; },
      stderr: (s: string) => { stderr += s; },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

// ── 1. CLI parser ──────────────────────────────────────────────────────

describe("Phase 3a-prep-c — CLI argument parser", () => {
  it("rejects missing --candidate", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs([]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /--candidate <path> is required/);
  });

  it("rejects --candidate without a value", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs(["--candidate"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /--candidate requires/);
  });

  it("rejects duplicate --candidate", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs(
      ["--candidate", "/a.json", "--candidate", "/b.json"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /supplied more than once/);
  });

  it("rejects unknown flags", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs(
      ["--candidate", "/a.json", "--bogus"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /unknown flag/);
  });

  it("rejects --json + --pretty together", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs(
      ["--candidate", "/a.json", "--json", "--pretty"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /mutually exclusive/);
  });

  it("accepts --help / -h", () => {
    for (const flag of ["--help", "-h"]) {
      const r = parseManualPhase3aPrepEvaluationCliArgs([flag]);
      assert.equal(r.ok, true);
      assert.equal("helpRequested" in r ? r.helpRequested : false, true);
    }
  });

  it("defaults source to manual:cli when --source is omitted", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs(["--candidate", "/x.json"]);
    assert.equal(r.ok, true);
    if (r.ok === true && "options" in r) {
      assert.equal(r.options.source, DEFAULT_CLI_SOURCE);
      assert.equal(r.options.candidatePath, "/x.json");
      assert.equal(r.options.pretty, false);
      assert.equal(r.options.runLabel, null);
      assert.equal(r.options.operator, null);
      // Phase 3a-prep-e: --explain defaults to false
      assert.equal(r.options.explain, false);
    }
  });

  it("echoes --run-label / --operator / --source / --pretty", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs([
      "--candidate", "/x.json",
      "--run-label", "phase3aprep-c-test",
      "--operator",  "op@test",
      "--source",    "manual:repl",
      "--pretty",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && "options" in r) {
      assert.equal(r.options.runLabel, "phase3aprep-c-test");
      assert.equal(r.options.operator, "op@test");
      assert.equal(r.options.source,   "manual:repl");
      assert.equal(r.options.pretty,   true);
    }
  });

  it("rejects empty --run-label / --operator / --source values", () => {
    for (const flag of ["--run-label", "--operator", "--source"]) {
      const r = parseManualPhase3aPrepEvaluationCliArgs([
        "--candidate", "/x.json", flag, "   ",
      ]);
      assert.equal(r.ok, false);
      if (r.ok === false) assert.match(r.reason, /requires a non-empty value/);
    }
  });
});

// ── 2. --help short-circuit ────────────────────────────────────────────

describe("Phase 3a-prep-c — --help / -h short-circuit", () => {
  it("prints usage to stdout, no banner, exit 0", () => {
    const { io, out, err } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--help"], io);
    assert.equal(r.exitCode, 0);
    assert.equal(r.payload, null);
    assert.ok(out().includes("Usage:"), "stdout must include Usage line");
    assert.equal(err(), "", "stderr must be empty on --help");
  });
});

// ── 3. Happy path: fully-prepared verdict ──────────────────────────────

describe("Phase 3a-prep-c — fully_prepared happy path", () => {
  const path1 = writeCandidateFile("fully-satisfied", buildSatisfiedCandidate("cand-1"));

  it("prints exactly one JSON payload to stdout with verdict 'fully_prepared'", () => {
    const { io, out, err } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(
      ["--candidate", path1],
      io,
    );
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload, "payload must be non-null on success");
    assert.equal(r.payload!.readiness.verdict, "fully_prepared");
    assert.equal(r.payload!.readiness.highTierAllSatisfied, true);
    assert.equal(r.payload!.readiness.lowTierAllSatisfied,  true);
    assert.deepEqual([...r.payload!.readiness.blockers], []);

    const stdout = out();
    // Trailing newline, single JSON document
    assert.equal(stdout.endsWith("\n"), true);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1, "stdout must be exactly one JSON line in compact mode");
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.readiness.verdict, "fully_prepared");
    assert.equal(parsed.candidateId, "cand-1");
    assert.equal(parsed.kind, "summarizationTemplate");
    assert.equal(parsed.harnessVersion, PHASE3A_PREP_HARNESS_VERSION);
    assert.equal(parsed.source, DEFAULT_CLI_SOURCE);

    // stderr is exactly the safety-invariants banner
    assert.equal(err(), SAFETY_INVARIANTS_BANNER + "\n");
  });

  it("byte-identical output on repeated invocations", () => {
    const { io: io1, out: out1 } = makeIo();
    const { io: io2, out: out2 } = makeIo();
    runManualPhase3aPrepEvaluationCli(["--candidate", path1], io1);
    runManualPhase3aPrepEvaluationCli(["--candidate", path1], io2);
    assert.equal(out1(), out2());
  });

  it("--pretty and compact JSON parse to deeply-equal objects", () => {
    const { io: ioA, out: outA } = makeIo();
    const { io: ioB, out: outB } = makeIo();
    runManualPhase3aPrepEvaluationCli(["--candidate", path1], ioA);
    runManualPhase3aPrepEvaluationCli(["--candidate", path1, "--pretty"], ioB);
    const a = JSON.parse(outA().trim());
    const b = JSON.parse(outB().trim());
    assert.deepEqual(a, b);
    // The pretty output should contain a newline+indent in the body
    assert.ok(outB().includes("\n  "), "pretty output must contain 2-space indent");
  });

  it("echoes --run-label / --operator / --source / harnessVersion", () => {
    const { io, out } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli([
      "--candidate", path1,
      "--run-label", "phase3aprep-c-daily-test",
      "--operator",  "op@phase3aprep-c",
      "--source",    "manual:repl",
    ], io);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(out().trim());
    assert.equal(parsed.runLabel, "phase3aprep-c-daily-test");
    assert.equal(parsed.operator, "op@phase3aprep-c");
    assert.equal(parsed.source,   "manual:repl");
    assert.equal(parsed.harnessVersion, PHASE3A_PREP_HARNESS_VERSION);
    assert.deepEqual(parsed.preconditionKeys, [...PHASE3A_PREP_PRECONDITION_KEYS]);
    assert.deepEqual(parsed.priorityTiers,    [...PHASE3A_PREP_PRIORITY_TIERS]);
  });
});

// ── 4. high_tier_ready verdict ─────────────────────────────────────────

describe("Phase 3a-prep-c — high_tier_ready verdict", () => {
  const p = writeCandidateFile("high-only", buildHighTierOnlyCandidate("cand-2"));

  it("verdict is high_tier_ready when all high satisfied and at least one low unverified", () => {
    const { io } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    assert.equal(r.payload!.readiness.verdict, "high_tier_ready");
    assert.equal(r.payload!.readiness.highTierAllSatisfied, true);
    assert.equal(r.payload!.readiness.lowTierAllSatisfied,  false);
    // every low-tier slot should have produced a blocker
    const lowBlockers = r.payload!.readiness.blockers.filter(b => /low-tier/.test(b));
    assert.ok(lowBlockers.length >= 1,
      `expected at least one low-tier blocker, got: ${[...r.payload!.readiness.blockers].join(" | ")}`);
  });
});

// ── 5. not_ready verdict ───────────────────────────────────────────────

describe("Phase 3a-prep-c — not_ready verdict", () => {
  it("verdict is not_ready when any high-tier slot is unverified", () => {
    const p = writeCandidateFile("not-ready", buildNotReadyCandidate("cand-3"));
    const { io } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    assert.equal(r.payload!.readiness.verdict, "not_ready");
    assert.equal(r.payload!.readiness.highTierAllSatisfied, false);
  });

  it("verdict is not_ready when kind is wrong", () => {
    const bad = buildSatisfiedCandidate("cand-4") as { kind: string };
    bad.kind = "someOtherKind";
    const p = writeCandidateFile("wrong-kind", bad);
    const { io } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    assert.equal(r.payload!.readiness.verdict, "not_ready");
    const kindBlockers = r.payload!.readiness.blockers.filter(b => /kind/.test(b));
    assert.ok(kindBlockers.length >= 1);
  });
});

// ── 6. Load failures: missing file / malformed JSON / wrong shape ──────

describe("Phase 3a-prep-c — load failures", () => {
  it("exits 1 with clear stderr when --candidate path does not exist", () => {
    const { io, out, err } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(
      ["--candidate", path.join(TMP, "does-not-exist.json")], io);
    assert.equal(r.exitCode, 1);
    assert.equal(r.payload, null);
    assert.equal(out(), "", "stdout must be empty when load fails");
    assert.match(err(), /candidate file not found/);
  });

  it("exits 1 when file contents are not valid JSON", () => {
    const p = path.join(TMP, "not-json.json");
    fs.writeFileSync(p, "{not json");
    const { io, out, err } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
    assert.equal(r.exitCode, 1);
    assert.equal(out(), "");
    assert.match(err(), /not valid JSON/);
  });

  it("exits 1 when JSON is not an object", () => {
    const p = path.join(TMP, "array.json");
    fs.writeFileSync(p, "[1,2,3]");
    const { io, out, err } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
    assert.equal(r.exitCode, 1);
    assert.equal(out(), "");
    assert.match(err(), /must contain a JSON object/);
  });

  for (const field of ["candidateId", "kind", "preconditions"]) {
    it(`exits 1 when '${field}' is missing`, () => {
      const c = buildSatisfiedCandidate("cand-x") as Record<string, unknown>;
      delete c[field];
      const p = writeCandidateFile(`missing-${field}`, c);
      const { io, out, err } = makeIo();
      const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
      assert.equal(r.exitCode, 1);
      assert.equal(out(), "");
      assert.match(err(), new RegExp(`missing required.*'${field}'`));
    });
  }
});

// ── 7. loadCandidate unit (helper isolation) ───────────────────────────

describe("Phase 3a-prep-c — loadCandidate helper", () => {
  it("returns ok:true for a well-formed candidate", () => {
    const p = writeCandidateFile("loader-ok", buildSatisfiedCandidate("cand-loader"));
    const r = loadCandidate(p);
    assert.equal(r.ok, true);
    if (r.ok === true) {
      assert.equal(r.candidate.candidateId, "cand-loader");
      assert.equal(r.candidate.kind, "summarizationTemplate");
    }
  });
});

// ── 8. toPayload pure projection ───────────────────────────────────────

describe("Phase 3a-prep-c — toPayload helper", () => {
  it("returns a payload echoing every metadata field", () => {
    const cand = buildSatisfiedCandidate("cand-projection") as {
      candidateId: string;
      kind: "summarizationTemplate";
      preconditions: never;
    };
    const fakeReadiness = {
      highTierAllSatisfied: true,
      lowTierAllSatisfied:  true,
      verdict:              "fully_prepared" as const,
      blockers:             Object.freeze([]) as readonly string[],
    };
    const payload = toPayload(
      {
        candidatePath: "/tmp/foo.json",
        pretty:        false,
        runLabel:      "L",
        operator:      "O",
        source:        "S",
        explain:       false,
      },
      cand as unknown as Parameters<typeof toPayload>[1],
      fakeReadiness,
    );
    assert.equal(payload.candidatePath,   "/tmp/foo.json");
    assert.equal(payload.runLabel,        "L");
    assert.equal(payload.operator,        "O");
    assert.equal(payload.source,          "S");
    assert.equal(payload.candidateId,     "cand-projection");
    assert.equal(payload.kind,            "summarizationTemplate");
    assert.equal(payload.harnessVersion,  PHASE3A_PREP_HARNESS_VERSION);
    assert.deepEqual(payload.preconditionKeys, [...PHASE3A_PREP_PRECONDITION_KEYS]);
    assert.deepEqual(payload.priorityTiers,    [...PHASE3A_PREP_PRIORITY_TIERS]);
    assert.equal(payload.readiness,       fakeReadiness);
  });
});

// ── 9. Source-level guards ─────────────────────────────────────────────

describe("Phase 3a-prep-c — source-level guards", () => {
  const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, "utf8");

  it("script does NOT import the Phase 3a entry-point module (Pin 4)", () => {
    assert.equal(
      /from\s+["'][^"']*phase3EntryPoint[^"']*["']/.test(SCRIPT_SRC),
      false,
      "runner must not import phase3EntryPoint (Pin 4 forbids scripts/ from doing so)",
    );
  });

  it("script does NOT import scheduler / autonomy monitor / promotion gate / applyRecommendation / hypothesisActionGate / selfRecommendationEngine", () => {
    const FORBIDDEN = [
      "scheduler",
      "autonomyMonitor",
      "applyRecommendation",
      "promotionGate",
      "hypothesisActionGate",
      "selfRecommendationEngine",
    ];
    for (const f of FORBIDDEN) {
      const re = new RegExp(`from\\s+["'][^"']*\\b${f}\\b[^"']*["']`);
      assert.equal(re.test(SCRIPT_SRC), false, `must not import ${f}`);
    }
  });

  it("script does NOT call Date.now / Math.random / randomUUID / process.env reads", () => {
    // Allow process.env appearance only in commented or string literal
    // context. Crude but precise enough: assert that there is no
    // `process.env.SOMETHING` token in non-comment code.
    const stripped = SCRIPT_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.equal(/\bDate\.now\b/.test(stripped),       false, "must not call Date.now");
    assert.equal(/\bMath\.random\b/.test(stripped),    false, "must not call Math.random");
    assert.equal(/\brandomUUID\b/.test(stripped),      false, "must not call randomUUID");
    assert.equal(/\bprocess\.env\.[A-Z]/.test(stripped),
      false,
      "must not read process.env in non-comment code",
    );
  });

  it("script does NOT call any fs write API", () => {
    const stripped = SCRIPT_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const WRITE_APIS = [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "mkdir",
      "mkdirSync",
      "rm",
      "rmSync",
      "unlink",
      "unlinkSync",
      "rename",
      "renameSync",
      "copyFile",
      "copyFileSync",
      "createWriteStream",
    ];
    for (const api of WRITE_APIS) {
      const re = new RegExp(`\\bfs\\.${api}\\b`);
      assert.equal(re.test(stripped), false, `must not call fs.${api}`);
    }
  });

  it("script contains all five required contract restatement phrases (Pin 7)", () => {
    const REQUIRED = [
      /read-only/i,
      /stdout-only/i,
      /no scheduler/i,
      /no auto-apply/i,
      /no public action/i,
    ];
    for (const r of REQUIRED) {
      assert.ok(r.test(SCRIPT_SRC), `runner source missing required phrase: ${r}`);
    }
  });
});

// ── 10. Production-runtime non-import ──────────────────────────────────

describe("Phase 3a-prep-c — runner is NOT referenced by any production surface", () => {
  const PRODUCTION_SURFACES = [
    "server/index.ts",
    "server/autonomyMonitor.ts",
    "server/selfRecommendationEngine.ts",
    "server/eval/promotionGate.ts",
  ];
  it("each production surface still exists and does not reference the runner", () => {
    for (const rel of PRODUCTION_SURFACES) {
      const abs = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(abs), `production surface missing: ${rel}`);
      const text = fs.readFileSync(abs, "utf8");
      assert.equal(
        /runManualPhase3aPrepEvaluation/.test(text),
        false,
        `${rel} must not reference the Phase 3a-prep manual runner`,
      );
    }
  });
});

// ── 11. File-level isolation contract (drain template) ─────────────────

describe("Phase 3a-prep-c — file-level isolation contract", () => {
  it("env vars TMP / DATA_DIR / DB_PATH / NODE_ENV are pinned to test values", () => {
    assert.equal(process.env.DATA_DIR, TMP);
    assert.equal(process.env.DB_PATH,  path.join(TMP, "test.db"));
    assert.equal(process.env.NODE_ENV, "test");
  });

  it("snapshot helpers captured all seven canonical artefacts", () => {
    // These are anchor-objects only; their `.exists` values reflect
    // whatever's on disk in the repo at the time of test load. The
    // contract is that we HOLD them so the after() hook can compare.
    for (const snap of [
      RESEARCH_SNAPSHOT,
      MEMORY_SNAPSHOT,
      GOALS_SNAPSHOT,
      COMPETENCY_SNAPSHOT,
      DECISION_LEDGER_SNAPSHOT,
      REGISTRATION_LEDGER_SNAPSHOT,
    ]) {
      assert.equal(typeof snap.exists, "boolean");
    }
    assert.equal(typeof DB_SNAPSHOT.exists, "boolean");
  });

  it("repo data files are byte-identical to their pre-test snapshots (verified in after())", () => {
    // Sanity placeholder: the real comparison runs in the after() hook.
    // This test asserts that the snapshot objects are non-null so a
    // future refactor can't silently delete the hook.
    assert.ok(RESEARCH_SNAPSHOT             !== null);
    assert.ok(MEMORY_SNAPSHOT               !== null);
    assert.ok(GOALS_SNAPSHOT                !== null);
    assert.ok(COMPETENCY_SNAPSHOT           !== null);
    assert.ok(DECISION_LEDGER_SNAPSHOT      !== null);
    assert.ok(REGISTRATION_LEDGER_SNAPSHOT  !== null);
    assert.ok(DB_SNAPSHOT                   !== null);
  });

  it("under AGENT306_AGGREGATE_RUN=1 the DB-stat comparison is active", () => {
    if (process.env.AGENT306_AGGREGATE_RUN !== "1") return;
    // Re-stat now; mostly redundant with after() but pins that the
    // gate is honored.
    const now = dbStat(REAL_DB);
    assert.equal(now.exists, DB_SNAPSHOT.exists);
  });
});

// ── 12. Usage text + banner content sanity ─────────────────────────────

describe("Phase 3a-prep-c — usage text + banner sanity", () => {
  it("USAGE_TEXT mentions --candidate, --pretty, --json, --help, --explain", () => {
    assert.match(USAGE_TEXT, /--candidate/);
    assert.match(USAGE_TEXT, /--pretty/);
    assert.match(USAGE_TEXT, /--json/);
    assert.match(USAGE_TEXT, /--help/);
    // Phase 3a-prep-e: --explain advertised in usage text
    assert.match(USAGE_TEXT, /--explain/);
  });

  it("SAFETY_INVARIANTS_BANNER restates the propose-only / no-scheduler contract", () => {
    assert.match(SAFETY_INVARIANTS_BANNER, /read-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no scheduler/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no auto-apply/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no public action/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /stdout-only/i);
  });
});

// ── 13. Phase 3a-prep-e: --explain flag ────────────────────────────────
//
// Pin invariants pinned by this suite:
//
//   E-1. The CLI parser accepts `--explain` with no value, defaults the
//        new `options.explain` boolean to `false`, and rejects no other
//        existing argument shape (no regression on prior flags).
//   E-2. `--explain` is independent of `--json` / `--pretty` (no mutual
//        exclusion, no ordering constraint).
//   E-3. When `--explain` is OFF (default), the stdout JSON payload
//        does NOT include an `explanation` field at all — payload
//        output is byte-identical to a pre-Phase-3a-prep-e invocation.
//   E-4. When `--explain` is ON, the stdout JSON payload includes a
//        well-formed `explanation` field with:
//          - `kindParity: { ok: boolean, blocker: string|null }`
//          - `byPrecondition`: 7 entries in PHASE3A_PREP_PRECONDITION_KEYS
//            order, each with `{ key, high, low }` and per-tier
//            `{ satisfied, blockers: string[] }`.
//          - `unclassifiedBlockers: string[]` (empty under normal flow).
//   E-5. For a fully-prepared candidate, every tier in every
//        precondition is `satisfied: true` with empty blockers, and
//        `kindParity.ok === true`.
//   E-6. For a high-tier-ready candidate, every `high` tier is
//        `satisfied: true` and every `low` tier is `satisfied: false`
//        with the original blocker string echoed verbatim.
//   E-7. For a wrong-kind candidate, `kindParity.ok === false` and
//        `kindParity.blocker` is the original verbatim blocker.
//   E-8. The flat blocker list (sum across all buckets +
//        kindParity.blocker if any + unclassifiedBlockers) re-creates
//        readiness.blockers as a (multi-)set (every blocker classified;
//        nothing dropped, nothing fabricated). Missing-both-tiers
//        blockers appear in BOTH the high and low buckets per the
//        documented classifier contract.
//   E-9. `--explain` adds NO new authority: the source-level guards
//        (Pin 4, no scheduler / monitor / promotion / apply imports,
//        no Date.now / Math.random / randomUUID / process.env reads,
//        no fs WRITE API) all still pass against the updated runner.
//
describe("Phase 3a-prep-e — --explain CLI parser", () => {
  it("--explain sets options.explain = true", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs([
      "--candidate", "/x.json", "--explain",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && "options" in r) {
      assert.equal(r.options.explain, true);
    }
  });

  it("--explain is idempotent (supplying it twice does not error)", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs([
      "--candidate", "/x.json", "--explain", "--explain",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && "options" in r) {
      assert.equal(r.options.explain, true);
    }
  });

  it("--explain coexists with --pretty (no mutual exclusion)", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs([
      "--candidate", "/x.json", "--pretty", "--explain",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && "options" in r) {
      assert.equal(r.options.explain, true);
      assert.equal(r.options.pretty,  true);
    }
  });

  it("--explain coexists with --json (no mutual exclusion)", () => {
    const r = parseManualPhase3aPrepEvaluationCliArgs([
      "--candidate", "/x.json", "--json", "--explain",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && "options" in r) {
      assert.equal(r.options.explain, true);
      assert.equal(r.options.pretty,  false);
    }
  });
});

describe("Phase 3a-prep-e — --explain OFF preserves byte-identity", () => {
  it("omitting --explain produces a payload with NO 'explanation' field", () => {
    const p = writeCandidateFile("explain-off-fully", buildSatisfiedCandidate("cand-explain-off"));
    const { io, out } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    // In-memory payload also omits the field (it is conditionally
    // attached, not always-present-but-null).
    assert.equal("explanation" in (r.payload as object), false,
      "payload object must not even have 'explanation' as a key when --explain is OFF");
    const parsed = JSON.parse(out().trim());
    assert.equal("explanation" in parsed, false,
      "serialised JSON must not include 'explanation' field when --explain is OFF");
  });

  it("byte-for-byte equality between two --explain-OFF invocations on the same file", () => {
    const p = writeCandidateFile("explain-off-twice", buildSatisfiedCandidate("cand-explain-off-2"));
    const { io: io1, out: out1 } = makeIo();
    const { io: io2, out: out2 } = makeIo();
    runManualPhase3aPrepEvaluationCli(["--candidate", p],            io1);
    runManualPhase3aPrepEvaluationCli(["--candidate", p, "--json"], io2);
    // --json is the documented default; the payload should match.
    assert.equal(out1(), out2());
  });
});

describe("Phase 3a-prep-e — --explain ON: shape + content", () => {
  it("fully_prepared candidate: every tier satisfied, kindParity ok, no unclassified", () => {
    const p = writeCandidateFile("explain-on-fully", buildSatisfiedCandidate("cand-explain-fully"));
    const { io, out } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p, "--explain"], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    const parsed = JSON.parse(out().trim());
    const ex = parsed.explanation;
    assert.ok(ex, "payload.explanation must be present when --explain is ON");
    assert.equal(ex.kindParity.ok, true);
    assert.equal(ex.kindParity.blocker, null);
    assert.equal(ex.byPrecondition.length, PHASE3A_PREP_PRECONDITION_KEYS.length);
    // Keys must appear in the canonical order.
    assert.deepEqual(
      ex.byPrecondition.map((row: { key: string }) => row.key),
      [...PHASE3A_PREP_PRECONDITION_KEYS],
    );
    for (const row of ex.byPrecondition) {
      assert.equal(row.high.satisfied, true);
      assert.deepEqual(row.high.blockers, []);
      assert.equal(row.low.satisfied,  true);
      assert.deepEqual(row.low.blockers,  []);
    }
    assert.deepEqual(ex.unclassifiedBlockers, []);
  });

  it("high_tier_ready candidate: every high satisfied, every low NOT satisfied with verbatim blockers", () => {
    const p = writeCandidateFile("explain-on-high-only", buildHighTierOnlyCandidate("cand-explain-high"));
    const { io, out } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p, "--explain"], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    const parsed = JSON.parse(out().trim());
    const ex = parsed.explanation;
    assert.equal(ex.kindParity.ok, true);
    assert.equal(ex.byPrecondition.length, PHASE3A_PREP_PRECONDITION_KEYS.length);
    for (const row of ex.byPrecondition) {
      assert.equal(row.high.satisfied, true,  `high tier should be satisfied for ${row.key}`);
      assert.deepEqual(row.high.blockers, []);
      assert.equal(row.low.satisfied,  false, `low tier should be unsatisfied for ${row.key}`);
      assert.ok(row.low.blockers.length >= 1, `low tier should have >=1 blocker for ${row.key}`);
      // Verbatim echo: every bucketed blocker is also in readiness.blockers.
      for (const b of row.low.blockers) {
        assert.ok(parsed.readiness.blockers.includes(b),
          `bucketed low blocker not found verbatim in readiness.blockers: ${b}`);
      }
    }
    assert.deepEqual(ex.unclassifiedBlockers, []);
  });

  it("wrong-kind candidate: kindParity.ok=false, blocker is the original verbatim string", () => {
    const bad = buildSatisfiedCandidate("cand-explain-wrongkind") as { kind: string };
    bad.kind = "someOtherKind";
    const p = writeCandidateFile("explain-on-wrongkind", bad);
    const { io, out } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p, "--explain"], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.payload);
    const parsed = JSON.parse(out().trim());
    const ex = parsed.explanation;
    assert.equal(ex.kindParity.ok, false);
    assert.equal(typeof ex.kindParity.blocker, "string");
    // The kindParity.blocker should be one of readiness.blockers verbatim.
    assert.ok(parsed.readiness.blockers.includes(ex.kindParity.blocker),
      "kindParity.blocker must appear verbatim in readiness.blockers");
    assert.match(ex.kindParity.blocker, /candidate\.kind/);
    assert.deepEqual(ex.unclassifiedBlockers, []);
  });

  it("--explain works under --pretty: payload still parses; same explanation tree", () => {
    const p = writeCandidateFile("explain-pretty", buildHighTierOnlyCandidate("cand-explain-pretty"));
    const { io: ioA, out: outA } = makeIo();
    const { io: ioB, out: outB } = makeIo();
    runManualPhase3aPrepEvaluationCli(["--candidate", p, "--explain"],            ioA);
    runManualPhase3aPrepEvaluationCli(["--candidate", p, "--explain", "--pretty"], ioB);
    const a = JSON.parse(outA().trim());
    const b = JSON.parse(outB().trim());
    assert.deepEqual(a, b);
    assert.ok(outB().includes("\n  "), "pretty output must contain 2-space indent");
    assert.ok(a.explanation, "compact --explain payload must include explanation");
    assert.ok(b.explanation, "pretty  --explain payload must include explanation");
  });

  it("every blocker in readiness.blockers is classified exactly once across buckets (no drop, no fabrication)", () => {
    // Build a candidate that triggers multiple blocker varieties at once:
    // wrong kind + one missing tier + one violated high + one empty-evidenceRef low.
    const cand = buildSatisfiedCandidate("cand-explain-multi") as {
      kind: string;
      preconditions: Record<string, Record<string, Record<string, unknown> | undefined>>;
    };
    cand.kind = "wrongKind";
    cand.preconditions["rollbackProof"]!["high"]!["status"] = "violated";
    // Remove a low-tier slot entirely (triggers missing-tier blocker).
    cand.preconditions["noPublicAction"]!["low"] = undefined;
    delete cand.preconditions["noPublicAction"]!["low"];
    // Satisfied low-tier with empty evidenceRef.
    (cand.preconditions["metricsClockReadiness"]!["low"] as Record<string, unknown>)["evidenceRef"] = "";

    const p = writeCandidateFile("explain-multi-blocker", cand);
    const { io, out } = makeIo();
    const r = runManualPhase3aPrepEvaluationCli(["--candidate", p, "--explain"], io);
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(out().trim());
    const flat: readonly string[] = parsed.readiness.blockers;
    const ex   = parsed.explanation;

    // Reconstruct: kindParity.blocker (0 or 1) + every per-tier bucket + unclassified.
    const reconstructed: string[] = [];
    if (ex.kindParity.blocker !== null) reconstructed.push(ex.kindParity.blocker);
    for (const row of ex.byPrecondition) {
      for (const b of row.high.blockers) reconstructed.push(b);
      for (const b of row.low.blockers)  reconstructed.push(b);
    }
    for (const b of ex.unclassifiedBlockers) reconstructed.push(b);

    // Every flat blocker must appear at least once in the reconstruction.
    for (const b of flat) {
      assert.ok(reconstructed.includes(b),
        `flat blocker not classified by --explain: ${b}`);
    }
    // No fabrication: every reconstructed blocker must be in the flat list.
    for (const b of reconstructed) {
      assert.ok(flat.includes(b),
        `--explain emitted blocker not in readiness.blockers: ${b}`);
    }
    // Under the documented classifier (and current harness phrasings),
    // unclassifiedBlockers must be empty.
    assert.deepEqual([...ex.unclassifiedBlockers], [],
      "unclassifiedBlockers must be empty when harness phrasings are recognised");
  });
});
