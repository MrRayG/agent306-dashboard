/**
 * Tests for Track A / Phase 3a-prep-f — golden-output integration test
 * over the prep-d fixtures using the prep-c + prep-e runner.
 *
 * GOAL
 * ────
 * Bind together the moving parts of Phase 3a-prep into a single byte-
 * equality tripwire:
 *
 *   - the harness                         (prep-a / prep-b)
 *   - the manual CLI runner               (prep-c)
 *   - the candidate JSON fixtures         (prep-d)
 *   - the --explain projection            (prep-e)
 *   - the precondition keys / priority tiers / harness-version anchors
 *
 * Each golden is a verbatim capture of `runManualPhase3aPrepEvaluationCli`'s
 * stdout for one (fixture, --explain on|off) pair. The test asserts
 * byte equality between live runner stdout and the on-disk golden. If
 * any of the above moving parts drifts in any way that changes the
 * payload — even a single character — the test fails loudly with the
 * exact golden filename a reviewer can re-generate.
 *
 * PRESENTATION-ONLY / NO SCHEMA BUMP
 * ──────────────────────────────────
 * This file adds NO production code, NO runtime surface, NO new
 * authority. It is a tripwire over already-shipped behaviour:
 *
 *   - read-only:      the test reads goldens and runs the propose-only
 *                     runner in-process. Nothing on disk is written.
 *   - stdout-only:    payloads are captured into in-memory string
 *                     accumulators (`makeIo()` pattern from prep-c) and
 *                     compared to on-disk goldens. No process spawned.
 *   - no scheduler:   no scheduler hook, no cron, no monitor side
 *                     effect, no app-boot wiring.
 *   - no auto-apply:  cannot widen any contract, cannot register any
 *                     kind, cannot promote any record, cannot mark
 *                     anything auto-apply eligible, cannot authorise
 *                     Phase 3 execution.
 *   - no public action: no outbound call, no publishing, no posting.
 *
 * GOLDEN-FILE ROTATION
 * ────────────────────
 * The `candidatePath` field of the payload is the ONLY field whose
 * value is inherently machine-dependent (it is the verbatim echo of
 * `--candidate`, which the runner does not normalise). To keep the
 * goldens machine-independent, that one field is stored in the
 * golden files as the literal sentinel string
 *
 *   "<<<FIXTURE_ABSPATH>>>"
 *
 * and the test substitutes the real absolute fixture path into the
 * golden text before comparing. Every other byte of the payload
 * — verdict, blockers, explanation tree, harness anchors, echo
 * metadata, key order — is preserved verbatim.
 *
 * If a legitimate change to the harness / runner / fixtures / explain
 * projection alters the payload, regenerate the goldens by running,
 * from the repo root:
 *
 *   for stem in candidate-fully-prepared candidate-high-tier-ready candidate-not-ready; do
 *     npx tsx scripts/runManualPhase3aPrepEvaluation.ts \
 *       --candidate "examples/phase3aPrep/${stem}.json" \
 *       --run-label "phase3aprep-f-golden" \
 *       --operator  "op@phase3aprep-f" \
 *       --source    "manual:test" \
 *       > "server/__tests__/golden/phase3aPrep/${stem}.default.golden.json"
 *     npx tsx scripts/runManualPhase3aPrepEvaluation.ts \
 *       --candidate "examples/phase3aPrep/${stem}.json" \
 *       --run-label "phase3aprep-f-golden" \
 *       --operator  "op@phase3aprep-f" \
 *       --source    "manual:test" \
 *       --explain \
 *       > "server/__tests__/golden/phase3aPrep/${stem}.explain.golden.json"
 *   done
 *
 * Then run a one-line Python (or jq) to replace each golden's
 * `candidatePath` value with the sentinel string:
 *
 *   python3 -c "import json,sys;p=sys.argv[1];o=json.load(open(p));o['candidatePath']='<<<FIXTURE_ABSPATH>>>';open(p,'w').write(json.dumps(o)+'\n')" \
 *     server/__tests__/golden/phase3aPrep/*.golden.json
 *
 * A rotation that changes a SCHEMA anchor (PHASE3_ENTRY_POINT_VERSION,
 * PHASE3A_PREP_HARNESS_VERSION, PHASE3A_PREP_PRECONDITION_KEYS, or
 * PHASE3A_PREP_PRIORITY_TIERS) is a schema bump — it MUST land in its
 * own PR with the schema bump, and the golden rotation MUST be in the
 * same commit so the regression surface stays in lock-step.
 *
 * INVARIANTS PINNED BY THIS FILE
 * ──────────────────────────────
 *   F-1. Each of the 3 prep-d fixtures, when fed to the runner with
 *        the canonical echo flags, produces stdout exactly equal to
 *        the corresponding `*.default.golden.json` file (byte
 *        equality).
 *   F-2. Each of the 3 prep-d fixtures, when fed to the runner with
 *        the canonical echo flags AND `--explain`, produces stdout
 *        exactly equal to the corresponding `*.explain.golden.json`
 *        file (byte equality).
 *   F-3. Every `*.default.golden.json` parses as JSON, is an object
 *        whose `readiness.verdict` is one of the closed
 *        `Phase3aPrepVerdict` vocabulary, and has NO `explanation`
 *        key (presentation-only byte-identity contract for
 *        --explain OFF).
 *   F-4. Every `*.explain.golden.json` parses as JSON, contains an
 *        `explanation` object with `kindParity`, a 7-row
 *        `byPrecondition` array in canonical order, and an
 *        `unclassifiedBlockers` array.
 *   F-5. Schema anchor pin: the `harnessVersion` field of every
 *        golden matches `PHASE3A_PREP_HARNESS_VERSION` exactly, and
 *        the `preconditionKeys` / `priorityTiers` fields match the
 *        harness's canonical arrays exactly. A future schema bump in
 *        the harness without a paired golden rotation surfaces here.
 *   F-6. File-level isolation contract: the test pins env vars,
 *        snapshots the canonical data artefacts, and verifies zero
 *        side effects on the live repo.
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ── Env-var pin BEFORE node:test import (file-level isolation contract) ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase3aprep-f-golden-test-"));
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
const REAL_RESEARCH_LAB        = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB           = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_AGENT_GOALS         = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY_PROFILE  = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_DECISION_LEDGER     = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REAL_REGISTRATION_LEDGER = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");
const REAL_DB                  = path.join(REPO_ROOT, "data", "agent306.db");

const SCRIPT_PATH    = path.join(REPO_ROOT, "scripts", "runManualPhase3aPrepEvaluation.ts");
const FIXTURES_DIR   = path.join(REPO_ROOT, "examples", "phase3aPrep");
const GOLDEN_DIR     = path.join(REPO_ROOT, "server", "__tests__", "golden", "phase3aPrep");

const {
  runManualPhase3aPrepEvaluationCli,
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
  assert.ok(fs.existsSync(SCRIPT_PATH),
    `runner script missing at ${SCRIPT_PATH}`);
  assert.ok(fs.existsSync(FIXTURES_DIR),
    `prep-d fixtures dir missing at ${FIXTURES_DIR}`);
  assert.ok(fs.existsSync(GOLDEN_DIR),
    `prep-f golden dir missing at ${GOLDEN_DIR}`);
});

// ── after() hook: cleanup + isolation check ────────────────────────────
after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* swallow */ }
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined)  delete process.env.DB_PATH;
  else process.env.DB_PATH  = ORIGINAL_DB_PATH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

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
  if (process.env.AGENT306_AGGREGATE_RUN === "1") {
    const dbAfter = dbStat(REAL_DB);
    assert.equal(dbAfter.exists,  DB_SNAPSHOT.exists,  "agent306.db existence changed");
    if (DB_SNAPSHOT.exists && dbAfter.exists) {
      assert.equal(dbAfter.size,    DB_SNAPSHOT.size,    "agent306.db size changed");
      assert.equal(dbAfter.mtimeMs, DB_SNAPSHOT.mtimeMs, "agent306.db mtime changed");
    }
  }
});

// ── Canonical echo flags (kept in lock-step with the rotation block in
//    the file's docstring; if you change one, change the other). ──────
const CANONICAL_RUN_LABEL = "phase3aprep-f-golden";
const CANONICAL_OPERATOR  = "op@phase3aprep-f";
const CANONICAL_SOURCE    = "manual:test";

/** Sentinel placeholder used in the on-disk goldens in place of the
 *  machine-dependent absolute path that the runner echoes into the
 *  `candidatePath` field. The test substitutes the real path into the
 *  golden text before byte-comparing, so every other byte of the
 *  payload remains under the tripwire. */
const FIXTURE_PATH_SENTINEL = "<<<FIXTURE_ABSPATH>>>";

const FIXTURE_STEMS = [
  "candidate-fully-prepared",
  "candidate-high-tier-ready",
  "candidate-not-ready",
] as const;

/** Tiny stdout/stderr sink (same pattern as the prep-c test). */
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

/** Compose the canonical argv for a given fixture + explain flag. */
function argvFor(stem: string, explain: boolean): string[] {
  const argv = [
    "--candidate", path.join(FIXTURES_DIR, `${stem}.json`),
    "--run-label", CANONICAL_RUN_LABEL,
    "--operator",  CANONICAL_OPERATOR,
    "--source",    CANONICAL_SOURCE,
  ];
  if (explain) argv.push("--explain");
  return argv;
}

/** Build the on-disk golden path for a given fixture + explain flag. */
function goldenPath(stem: string, explain: boolean): string {
  const suffix = explain ? "explain" : "default";
  return path.join(GOLDEN_DIR, `${stem}.${suffix}.golden.json`);
}

// ── 1. Byte-equality per fixture, --explain OFF ────────────────────────

/** Read a golden file and substitute the FIXTURE_PATH_SENTINEL with
 *  the real absolute path the test will pass to the runner. Pure
 *  string operation — no JSON re-serialisation, so we still pin
 *  byte-for-byte output (key order, spacing, escaping). */
function goldenExpected(stem: string, explain: boolean): string {
  const goldenFile = goldenPath(stem, explain);
  assert.ok(fs.existsSync(goldenFile),
    `missing golden: ${goldenFile}\n` +
    `regenerate per the rotation block in this test file's doc string`);
  const raw = fs.readFileSync(goldenFile, "utf8");
  const real = path.join(FIXTURES_DIR, `${stem}.json`);
  // The sentinel appears exactly once per golden; using a literal
  // string replace avoids regex escaping concerns with path chars.
  assert.ok(raw.includes(FIXTURE_PATH_SENTINEL),
    `golden missing fixture-path sentinel: ${goldenFile}\n` +
    `expected sentinel '${FIXTURE_PATH_SENTINEL}' in golden text`);
  return raw.replace(FIXTURE_PATH_SENTINEL, real);
}

describe("Phase 3a-prep-f — golden output: --explain OFF", () => {
  for (const stem of FIXTURE_STEMS) {
    it(`${stem}: runner stdout matches *.default.golden.json byte-for-byte`, () => {
      const expected = goldenExpected(stem, false);
      const goldenFile = goldenPath(stem, false);

      const { io, out, err } = makeIo();
      const r = runManualPhase3aPrepEvaluationCli(argvFor(stem, false), io);
      assert.equal(r.exitCode, 0,
        `runner exit code: stderr was:\n${err()}`);
      const actual = out();

      assert.equal(actual.length, expected.length,
        `length mismatch for ${stem} (default): ` +
        `actual=${actual.length}, expected=${expected.length}\n` +
        `regenerate the golden if the change is intentional: ${goldenFile}`);
      assert.equal(actual, expected,
        `byte mismatch for ${stem} (default).\n` +
        `regenerate the golden if the change is intentional: ${goldenFile}`);
    });
  }
});

// ── 2. Byte-equality per fixture, --explain ON ─────────────────────────

describe("Phase 3a-prep-f — golden output: --explain ON", () => {
  for (const stem of FIXTURE_STEMS) {
    it(`${stem}: runner stdout matches *.explain.golden.json byte-for-byte`, () => {
      const expected = goldenExpected(stem, true);
      const goldenFile = goldenPath(stem, true);

      const { io, out, err } = makeIo();
      const r = runManualPhase3aPrepEvaluationCli(argvFor(stem, true), io);
      assert.equal(r.exitCode, 0,
        `runner exit code: stderr was:\n${err()}`);
      const actual = out();

      assert.equal(actual.length, expected.length,
        `length mismatch for ${stem} (explain): ` +
        `actual=${actual.length}, expected=${expected.length}\n` +
        `regenerate the golden if the change is intentional: ${goldenFile}`);
      assert.equal(actual, expected,
        `byte mismatch for ${stem} (explain).\n` +
        `regenerate the golden if the change is intentional: ${goldenFile}`);
    });
  }
});

// ── 3. Structural sanity on the goldens themselves ─────────────────────

describe("Phase 3a-prep-f — golden structural sanity (default)", () => {
  const KNOWN_VERDICTS = new Set(["fully_prepared", "high_tier_ready", "not_ready"]);
  for (const stem of FIXTURE_STEMS) {
    it(`${stem}.default.golden.json: parses, has known verdict, has NO 'explanation' key`, () => {
      const text = fs.readFileSync(goldenPath(stem, false), "utf8");
      // Trailing newline is part of the runner's serialiser; trim then parse.
      const parsed = JSON.parse(text.trim());
      assert.equal(typeof parsed, "object");
      assert.ok(parsed.readiness, "readiness field must be present");
      assert.ok(KNOWN_VERDICTS.has(parsed.readiness.verdict),
        `unknown verdict in golden: ${parsed.readiness.verdict}`);
      assert.equal("explanation" in parsed, false,
        "default golden must NOT contain an 'explanation' field");
      // Pin echo metadata
      assert.equal(parsed.runLabel, CANONICAL_RUN_LABEL);
      assert.equal(parsed.operator, CANONICAL_OPERATOR);
      assert.equal(parsed.source,   CANONICAL_SOURCE);
      // Pin the sentinel: candidatePath in goldens must remain the
      // placeholder, NOT a real path (else regenerate is broken).
      assert.equal(parsed.candidatePath, FIXTURE_PATH_SENTINEL,
        `default golden candidatePath must be the sentinel '${FIXTURE_PATH_SENTINEL}'`);
    });
  }
});

describe("Phase 3a-prep-f — golden structural sanity (explain)", () => {
  for (const stem of FIXTURE_STEMS) {
    it(`${stem}.explain.golden.json: parses, has well-formed explanation tree`, () => {
      const text = fs.readFileSync(goldenPath(stem, true), "utf8");
      const parsed = JSON.parse(text.trim());
      assert.ok(parsed.explanation, "explanation field must be present in *.explain.golden.json");
      const ex = parsed.explanation;
      assert.ok(ex.kindParity, "explanation.kindParity must be present");
      assert.equal(typeof ex.kindParity.ok, "boolean");
      assert.ok(Array.isArray(ex.byPrecondition));
      assert.equal(ex.byPrecondition.length, PHASE3A_PREP_PRECONDITION_KEYS.length);
      // Canonical key order
      assert.deepEqual(
        ex.byPrecondition.map((row: { key: string }) => row.key),
        [...PHASE3A_PREP_PRECONDITION_KEYS],
      );
      assert.ok(Array.isArray(ex.unclassifiedBlockers),
        "explanation.unclassifiedBlockers must be an array");
      // Pin the sentinel here too.
      assert.equal(parsed.candidatePath, FIXTURE_PATH_SENTINEL,
        `explain golden candidatePath must be the sentinel '${FIXTURE_PATH_SENTINEL}'`);
    });
  }
});

// ── 4. Schema-anchor pin: harnessVersion / preconditionKeys / priorityTiers ──

describe("Phase 3a-prep-f — schema-anchor pin across all goldens", () => {
  for (const stem of FIXTURE_STEMS) {
    for (const flag of ["default", "explain"] as const) {
      it(`${stem}.${flag}.golden.json: harnessVersion / preconditionKeys / priorityTiers match the harness`, () => {
        const text = fs.readFileSync(goldenPath(stem, flag === "explain"), "utf8");
        const parsed = JSON.parse(text.trim());
        assert.equal(parsed.harnessVersion, PHASE3A_PREP_HARNESS_VERSION,
          `harnessVersion drift in ${stem}.${flag}.golden.json — schema bump without golden rotation?`);
        assert.deepEqual(parsed.preconditionKeys, [...PHASE3A_PREP_PRECONDITION_KEYS],
          `preconditionKeys drift in ${stem}.${flag}.golden.json`);
        assert.deepEqual(parsed.priorityTiers, [...PHASE3A_PREP_PRIORITY_TIERS],
          `priorityTiers drift in ${stem}.${flag}.golden.json`);
      });
    }
  }
});

// ── 5. Source-level guard: this test does NOT mutate the goldens ───────

describe("Phase 3a-prep-f — test file does NOT write to the golden directory", () => {
  it("test source contains no fs WRITE calls targeting the golden dir", () => {
    const TEST_SRC = fs.readFileSync(
      path.join(REPO_ROOT, "server", "__tests__", "runManualPhase3aPrepEvaluationGoldens.test.ts"),
      "utf8",
    );
    // Strip comments before searching for write APIs against goldens
    const stripped = TEST_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const WRITE_APIS = [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
    ];
    for (const api of WRITE_APIS) {
      const re = new RegExp(`\\bfs\\.${api}\\b`);
      assert.equal(re.test(stripped), false,
        `golden test must not call fs.${api} (would mutate goldens)`);
    }
  });
});

// ── 6. File-level isolation contract (drain template) ──────────────────

describe("Phase 3a-prep-f — file-level isolation contract", () => {
  it("env vars TMP / DATA_DIR / DB_PATH / NODE_ENV are pinned to test values", () => {
    assert.equal(process.env.DATA_DIR, TMP);
    assert.equal(process.env.DB_PATH,  path.join(TMP, "test.db"));
    assert.equal(process.env.NODE_ENV, "test");
  });

  it("snapshot helpers captured all seven canonical artefacts", () => {
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

  it("under AGENT306_AGGREGATE_RUN=1 the DB-stat comparison is active", () => {
    if (process.env.AGENT306_AGGREGATE_RUN !== "1") return;
    const now = dbStat(REAL_DB);
    assert.equal(now.exists, DB_SNAPSHOT.exists);
  });
});
