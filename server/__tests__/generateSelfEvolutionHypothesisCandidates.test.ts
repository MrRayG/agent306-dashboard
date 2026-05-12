/**
 * Tests for Phase 2l-f — manual self-evolution hypothesis candidates CLI.
 *
 * Spec invariants pinned by this file:
 *
 *   1. The CLI argument parser handles every documented flag, defaults
 *      `--limit` to 5, defaults `--generated-by` to `manual:cli`, and
 *      rejects unknown / malformed flags with a clear reason.
 *   2. `--help` / `-h` short-circuits cleanly, prints the usage text to
 *      stdout, returns exit code 0.
 *   3. The runner reuses `buildSelfEvolutionHypothesisCandidates` /
 *      `serializeSelfEvolutionCandidateSet` from the helper — it does
 *      NOT define its own candidate logic.
 *   4. Identical CLI inputs produce byte-identical stdout output
 *      across repeated invocations.
 *   5. The runner is stdout-only on the happy path: stdout is exactly
 *      one JSON document; the only stderr output is the safety-invariants
 *      banner.
 *   6. The runner is non-mutating: no file, database, ledger, env var,
 *      monitor state, or in-memory map is touched. The repo's live data
 *      files are byte-identical after the test run.
 *   7. Source-level guards: the runner does NOT import the scheduler /
 *      autonomy monitor / promotion gate / applyRecommendation /
 *      hypothesis mutation paths, does NOT call `Date.now` /
 *      `Math.random` / `randomUUID` / mutate `process.env`, and does
 *      NOT call any fs read or write API.
 *   8. The printed JSON payload restates the safety invariants and
 *      disclaimer block verbatim (read-only / propose-only /
 *      non-widening / no scheduler / no auto-apply / no public action /
 *      no ready_for_experiment).
 *   9. `--qg-failure`, `--ll-signal`, `--phase3-signal` are repeatable
 *      and route into the helper's signal arrays.
 *  10. Unknown / invalid QG failure codes are rejected with exit code 1.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2lf-cli-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "generateSelfEvolutionHypothesisCandidates.ts");

const {
  parseSelfEvolutionCliArgs,
  runSelfEvolutionCli,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
  DEFAULT_GENERATED_BY,
} = await import("../../scripts/generateSelfEvolutionHypothesisCandidates.ts");

const {
  SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION,
  SELF_EVOLUTION_CANDIDATES_LABEL,
  SELF_EVOLUTION_SAFETY_DISCLAIMER,
  DEFAULT_SELF_EVOLUTION_LIMIT,
} = await import("../experiments/selfEvolutionHypothesisCandidates.ts");

const PINNED_AT = "2026-05-12T17:00:00.000Z";

function snapshot(p: string): { exists: boolean; content?: string } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p, "utf8") };
}

const RESEARCH_SNAPSHOT        = snapshot(REAL_RESEARCH_LAB);
const MEMORY_SNAPSHOT          = snapshot(REAL_MEMORY_KB);
const DECISION_LEDGER_SNAPSHOT = snapshot(REAL_DECISION_LEDGER);
const REPO_RECORDS_SNAPSHOT    = snapshot(REPO_RECORDS_LEDGER);
const ENV_SNAPSHOT             = JSON.stringify(process.env);

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  for (const [label, before, p] of [
    ["research_lab.json",                  RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",              MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["experiment_decision_events.jsonl",   DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl", REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const after = snapshot(p);
    if (before.exists) {
      if (!after.exists) throw new Error(`Phase 2l-f CLI tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-f CLI tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-f CLI tests created live ${label}!`);
    }
  }
  const before = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (key === "DATA_DIR" || key === "DB_PATH") continue;
    if (before[key] !== process.env[key]) {
      throw new Error(`Phase 2l-f CLI tests mutated env var ${key}`);
    }
  }
});

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

// ── Arg parser ──────────────────────────────────────────────────────────────

describe("Phase 2l-f CLI — argument parsing", () => {
  it("defaults --limit to DEFAULT_SELF_EVOLUTION_LIMIT and --generated-by to manual:cli", () => {
    const r = parseSelfEvolutionCliArgs([]);
    assert.equal(r.ok, true);
    if (r.ok && !("helpRequested" in r)) {
      assert.equal(r.options.limit, DEFAULT_SELF_EVOLUTION_LIMIT);
      assert.equal(r.options.generatedBy, DEFAULT_GENERATED_BY);
      assert.equal(r.options.now, null);
      assert.equal(r.options.pretty, false);
      assert.deepEqual(r.options.qgFailures, []);
      assert.deepEqual(r.options.llSignals, []);
      assert.deepEqual(r.options.p3Signals, []);
    }
  });

  it("accepts --pretty / --json (default) / --no-limit / --limit <n>", () => {
    const r1 = parseSelfEvolutionCliArgs(["--pretty"]);
    assert.equal(r1.ok, true);
    if (r1.ok && !("helpRequested" in r1)) assert.equal(r1.options.pretty, true);

    const r2 = parseSelfEvolutionCliArgs(["--no-limit"]);
    assert.equal(r2.ok, true);
    if (r2.ok && !("helpRequested" in r2)) assert.equal(r2.options.limit, null);

    const r3 = parseSelfEvolutionCliArgs(["--limit", "3"]);
    assert.equal(r3.ok, true);
    if (r3.ok && !("helpRequested" in r3)) assert.equal(r3.options.limit, 3);
  });

  it("accepts repeated --qg-failure / --ll-signal / --phase3-signal", () => {
    const r = parseSelfEvolutionCliArgs([
      "--qg-failure", "reversibility_below_threshold",
      "--qg-failure", "sigma_above_max",
      "--ll-signal", "ll.lessons.count",
      "--ll-signal", "ll.promotions.count",
      "--phase3-signal", "phase3.readiness.score",
    ]);
    assert.equal(r.ok, true);
    if (r.ok && !("helpRequested" in r)) {
      assert.deepEqual(r.options.qgFailures, ["reversibility_below_threshold", "sigma_above_max"]);
      assert.deepEqual(r.options.llSignals, ["ll.lessons.count", "ll.promotions.count"]);
      assert.deepEqual(r.options.p3Signals, ["phase3.readiness.score"]);
    }
  });

  it("accepts a valid --now ISO timestamp", () => {
    const r = parseSelfEvolutionCliArgs(["--now", PINNED_AT]);
    assert.equal(r.ok, true);
    if (r.ok && !("helpRequested" in r)) assert.equal(r.options.now, PINNED_AT);
  });

  it("rejects --now junk", () => {
    const r = parseSelfEvolutionCliArgs(["--now", "tomorrow"]);
    assert.equal(r.ok, false);
  });

  it("rejects unknown flag", () => {
    const r = parseSelfEvolutionCliArgs(["--invented"]);
    assert.equal(r.ok, false);
  });

  it("rejects --json + --pretty together", () => {
    const r = parseSelfEvolutionCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
  });

  it("rejects an unknown --qg-failure code", () => {
    const r = parseSelfEvolutionCliArgs(["--qg-failure", "totally_made_up"]);
    assert.equal(r.ok, false);
  });

  it("rejects --limit with a non-integer", () => {
    const r1 = parseSelfEvolutionCliArgs(["--limit", "-1"]);
    assert.equal(r1.ok, false);
    const r2 = parseSelfEvolutionCliArgs(["--limit", "1.5"]);
    assert.equal(r2.ok, false);
    const r3 = parseSelfEvolutionCliArgs(["--limit", "abc"]);
    assert.equal(r3.ok, false);
  });

  it("rejects empty --ll-signal / --phase3-signal / --generated-by", () => {
    assert.equal(parseSelfEvolutionCliArgs(["--ll-signal", "  "]).ok, false);
    assert.equal(parseSelfEvolutionCliArgs(["--phase3-signal", ""]).ok, false);
    assert.equal(parseSelfEvolutionCliArgs(["--generated-by", "   "]).ok, false);
  });

  it("--help short-circuits", () => {
    const r = parseSelfEvolutionCliArgs(["--help"]);
    assert.ok(r.ok && "helpRequested" in r && r.helpRequested === true);
  });
});

// ── runSelfEvolutionCli ─────────────────────────────────────────────────────

describe("Phase 2l-f CLI — runSelfEvolutionCli happy path", () => {
  it("prints the usage on --help and exits 0", () => {
    const { io, stdout, stderr } = makeIo();
    const r = runSelfEvolutionCli(["--help"], io);
    assert.equal(r.exitCode, 0);
    assert.equal(r.set, null);
    assert.ok(stdout().includes("Phase 2l-f manual self-evolution"));
    assert.equal(stderr(), "");
  });

  it("prints the usage and reason to stderr and exits 1 on unknown flag", () => {
    const { io, stdout, stderr } = makeIo();
    const r = runSelfEvolutionCli(["--invented"], io);
    assert.equal(r.exitCode, 1);
    assert.equal(r.set, null);
    assert.equal(stdout(), "");
    assert.ok(stderr().includes("unknown flag"));
    assert.ok(stderr().includes("Phase 2l-f manual self-evolution"));
  });

  it("prints the safety banner to stderr and exactly one JSON payload to stdout on the happy path", () => {
    const { io, stdout, stderr } = makeIo();
    const r = runSelfEvolutionCli(["--now", PINNED_AT, "--generated-by", "op@phase2l-f"], io);
    assert.equal(r.exitCode, 0);
    assert.ok(r.set);
    assert.equal(stderr(), SAFETY_INVARIANTS_BANNER + "\n");
    const out = stdout();
    const lines = out.trimEnd().split("\n");
    assert.equal(lines.length, 1, "expected exactly one JSON document line");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.schemaVersion, SELF_EVOLUTION_CANDIDATES_SCHEMA_VERSION);
    assert.equal(parsed.label, SELF_EVOLUTION_CANDIDATES_LABEL);
    assert.equal(parsed.generatedAt, PINNED_AT);
    assert.equal(parsed.generatedBy, "op@phase2l-f");
    assert.equal(parsed.usedDefaultSample, true);
    assert.ok(Array.isArray(parsed.candidates));
    assert.ok(parsed.candidates.length >= 3);
    for (const c of parsed.candidates) {
      assert.equal(c.readOnly, true);
      assert.equal(c.operatorSynthesized, true);
      assert.equal(c.readyForExperiment, false);
      assert.equal(c.hygieneTag, "candidate");
    }
    assert.deepEqual(parsed.safetyDisclaimer, [...SELF_EVOLUTION_SAFETY_DISCLAIMER]);
  });

  it("--pretty produces 2-space indented JSON that parses to the same object as compact", () => {
    const compact = makeIo();
    runSelfEvolutionCli(["--now", PINNED_AT], compact.io);
    const pretty = makeIo();
    runSelfEvolutionCli(["--pretty", "--now", PINNED_AT], pretty.io);
    assert.notEqual(compact.stdout(), pretty.stdout());
    assert.deepEqual(
      JSON.parse(compact.stdout()),
      JSON.parse(pretty.stdout()),
    );
  });

  it("routes --qg-failure into qualityGrammarFailureRefs", () => {
    const { io, stdout } = makeIo();
    runSelfEvolutionCli([
      "--now", PINNED_AT,
      "--qg-failure", "reversibility_below_threshold",
      "--no-limit",
    ], io);
    const parsed = JSON.parse(stdout());
    const dims = new Set<string>(parsed.candidates.map((c: any) => c.dimension));
    assert.ok(dims.has("reversibility"), "expected reversibility dimension");
    assert.ok(dims.has("rollback_proof"), "expected rollback_proof dimension");
    assert.equal(parsed.usedDefaultSample, false);
  });

  it("byte-identical output across repeated invocations with identical args", () => {
    const args = [
      "--now", PINNED_AT,
      "--generated-by", "op@phase2l-f",
      "--qg-failure", "reversibility_below_threshold",
      "--qg-failure", "sigma_above_max",
      "--ll-signal", "ll.lessons.count",
      "--phase3-signal", "phase3.readiness.score",
    ];
    const a = makeIo();
    runSelfEvolutionCli(args, a.io);
    const b = makeIo();
    runSelfEvolutionCli(args, b.io);
    assert.equal(a.stdout(), b.stdout());
    assert.equal(a.stderr(), b.stderr());
  });

  it("--limit caps the candidate count", () => {
    const { io, stdout } = makeIo();
    runSelfEvolutionCli(["--limit", "3", "--now", PINNED_AT], io);
    const parsed = JSON.parse(stdout());
    assert.equal(parsed.candidates.length, 3);
    assert.equal(parsed.appliedLimit, 3);
  });
});

// ── Source-level guards ────────────────────────────────────────────────────

describe("Phase 2l-f CLI — source-level guards", () => {
  const rawSrc = fs.readFileSync(SCRIPT_PATH, "utf8");
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("does NOT import the scheduler / monitor / promotion / apply / hypothesis mutation paths", () => {
    const FORBIDDEN_IMPORTS = [
      /from\s+["'][^"']*autonomyMonitor[^"']*["']/,
      /from\s+["'][^"']*scheduler[^"']*["']/,
      /from\s+["'][^"']*applyRecommendation[^"']*["']/,
      /from\s+["'][^"']*promotionGate[^"']*["']/,
      /from\s+["'][^"']*selfRecommendationEngine[^"']*["']/,
      /from\s+["'][^"']*hypothesisActionGate[^"']*["']/,
      /from\s+["'][^"']*hypothesisStateMachine[^"']*["']/,
      /from\s+["'][^"']*archiveHypotheses[^"']*["']/,
      /from\s+["'][^"']*server\/index[^"']*["']/,
      /from\s+["'][^"']*reasoningQualityHarness[^"']*["']/,
    ];
    for (const pat of FORBIDDEN_IMPORTS) {
      assert.equal(pat.test(src), false, `runner must not import ${pat}`);
    }
  });

  it("does NOT touch fs / db / env / wall-clock / random APIs", () => {
    const FORBIDDEN = [
      /\bfs\.writeFile/,
      /\bfs\.writeFileSync/,
      /\bfs\.appendFile/,
      /\bfs\.appendFileSync/,
      /\bfs\.mkdir/,
      /\bfs\.unlink/,
      /\bfs\.rm/,
      /\bfs\.rename/,
      /\bfs\.readFile/,
      /\bfs\.readFileSync/,
      /\bbetter-sqlite3\b/,
      /\bdrizzle-orm\b/,
      /process\.env\.[A-Z_]+\s*=/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bnew\s+Date\s*\(\s*\)/,
    ];
    for (const pat of FORBIDDEN) {
      assert.equal(pat.test(src), false, `runner must not use ${pat}`);
    }
  });

  it("does NOT import any fs / db module at all", () => {
    const importsFs =
      /from\s+["'](?:node:)?fs(?:\/[^"']+)?["']/.test(src) ||
      /import\s+\*\s+as\s+fs\s+from/.test(src) ||
      /require\(\s*["'](?:node:)?fs["']\s*\)/.test(src);
    assert.equal(importsFs, false, "runner must not import fs");

    const importsDb =
      /from\s+["'][^"']*\bdb\.(?:ts|js)["']/.test(src) ||
      /from\s+["'][^"']*\/db["']/.test(src);
    assert.equal(importsDb, false, "runner must not import the db module");
  });

  it("references the propose-only safety invariants in source", () => {
    // After comment-stripping, only string-literal references survive.
    // The banner / usage strings name the read-only contract verbatim.
    assert.match(src, /ready_for_experiment/);
    assert.match(src, /summarizationTemplate/);
    assert.match(src, /read-only/);
    assert.match(src, /propose-only/);
  });
});
