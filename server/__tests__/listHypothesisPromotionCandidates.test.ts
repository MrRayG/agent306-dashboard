/**
 * Tests for Phase 2l-e — manual hypothesis promotion candidates CLI.
 *
 * Spec invariants pinned by this file:
 *
 *   1. The CLI argument parser handles every documented flag, defaults
 *      `--memory-file` to `data/memory_knowledge.json`, defaults
 *      `--generated-by` to `manual:cli`, defaults `--limit` to 3,
 *      and rejects unknown / malformed flags with a clear reason.
 *   2. `--help` / `-h` short-circuits cleanly, prints the usage text to
 *      stdout, returns exit code 0, and does NOT read any file.
 *   3. The runner reuses `buildHypothesisPromotionCandidates` /
 *      `serializePromotionCandidatesSet` from the helper — it does NOT
 *      define its own candidate logic.
 *   4. Identical CLI inputs + identical memory-file content produce
 *      byte-identical stdout output across repeated invocations.
 *   5. The runner is stdout-only on the happy path: stdout is exactly
 *      one JSON document; the only stderr output is the safety-invariants
 *      banner; nothing else is written anywhere.
 *   6. The runner is non-mutating: no file, database, ledger, env var,
 *      monitor state, or in-memory map is touched. The repo's live data
 *      files are byte-identical after the test run.
 *   7. Source-level guards: the runner does NOT import the scheduler /
 *      autonomy monitor / promotion gate / applyRecommendation /
 *      hypothesis mutation paths, does NOT call `Date.now` /
 *      `Math.random` / `randomUUID` / mutate `process.env`, and does
 *      NOT call any fs write API.
 *   8. The printed JSON payload restates the safety invariants and
 *      disclaimer block verbatim (read-only / propose-only /
 *      non-widening / no scheduler / no auto-apply / no public action).
 *   9. `--limit` works and excluded rows surface as `limit_excluded`
 *      ineligibles in stable order.
 *  10. Ineligible/malformed/public-action/scheduler/mutation/promotion-like
 *      memory entries are blocked or excluded with reason codes — never
 *      suggested.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2le-cli-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB    = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_MEMORY_KB       = path.join(REPO_ROOT, "data", "memory_knowledge.json");
const REAL_DECISION_LEDGER = path.join(REPO_ROOT, "data", "experiment_decision_events.jsonl");
const REPO_RECORDS_LEDGER  = path.join(REPO_ROOT, "data", "sandbox_registration_records.jsonl");

const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "listHypothesisPromotionCandidates.ts");

const {
  parsePromotionCandidatesCliArgs,
  runPromotionCandidatesCli,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
  DEFAULT_GENERATED_BY,
  DEFAULT_MEMORY_FILE_RELATIVE,
} = await import("../../scripts/listHypothesisPromotionCandidates.ts");

const {
  PROMOTION_CANDIDATES_SCHEMA_VERSION,
  PROMOTION_CANDIDATES_LABEL,
  PROMOTION_CANDIDATES_SAFETY_DISCLAIMER,
  DEFAULT_CANDIDATE_LIMIT,
} = await import("../experiments/hypothesisPromotionCandidates.ts");

const PINNED_AT = "2026-05-11T17:00:00.000Z";

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
      if (!after.exists) throw new Error(`Phase 2l-e CLI tests removed live ${label}!`);
      if (after.content !== before.content) throw new Error(`Phase 2l-e CLI tests mutated live ${label}!`);
    } else {
      if (after.exists) throw new Error(`Phase 2l-e CLI tests created live ${label}!`);
    }
  }
  const before = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (key === "DATA_DIR" || key === "DB_PATH") continue;
    if (before[key] !== process.env[key]) {
      throw new Error(`Phase 2l-e CLI tests mutated env var ${key}`);
    }
  }
});

function makeIo(memoryContent: string | null = null): {
  stdout: string[];
  stderr: string[];
  reads: string[];
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    readMemoryFile: (p: string) => string;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reads: string[] = [];
  return {
    stdout,
    stderr,
    reads,
    io: {
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      readMemoryFile: (p: string) => {
        reads.push(p);
        if (memoryContent === null) throw new Error(`unexpected read of ${p}`);
        return memoryContent;
      },
    },
  };
}

function goodEntry(overrides: Record<string, unknown> = {}): any {
  return {
    id: "k_good_001",
    title: "Hypothesis: Curiosity-driven headlines increase long-term reader retention",
    summary: "medium confidence. Data from late 2025 shows curiosity-driven headlines correlate with retention over a 30 day window.",
    category: "research",
    tier: "operational",
    weight: 7,
    learnedAt: "2026-03-29T13:03:53.922Z",
    ...overrides,
  };
}

function memoryFile(entries: any[]): string {
  return JSON.stringify({
    lastIngested: "2026-04-01T00:00:00.000Z",
    totalEntries: entries.length,
    researchFiles: ["research_lab.json"],
    entries,
  });
}

// ── Argument parser ────────────────────────────────────────────────────────

describe("Phase 2l-e CLI — argument parser", () => {
  it("returns defaults when given no flags", () => {
    const r = parsePromotionCandidatesCliArgs([]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,      false);
      assert.equal(r.options.limit,       DEFAULT_CANDIDATE_LIMIT);
      assert.equal(r.options.memoryFile,  DEFAULT_MEMORY_FILE_RELATIVE);
      assert.equal(r.options.now,         null);
      assert.equal(r.options.generatedBy, DEFAULT_GENERATED_BY);
    } else {
      assert.fail("expected options branch");
    }
  });

  it("parses every documented flag", () => {
    const r = parsePromotionCandidatesCliArgs([
      "--pretty",
      "--limit", "5",
      "--memory-file", "/tmp/foo.json",
      "--now", PINNED_AT,
      "--generated-by", "op@phase2l-e",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty, true);
      assert.equal(r.options.limit, 5);
      assert.equal(r.options.memoryFile, "/tmp/foo.json");
      assert.equal(r.options.now, PINNED_AT);
      assert.equal(r.options.generatedBy, "op@phase2l-e");
    }
  });

  it("--no-limit disables the cap", () => {
    const r = parsePromotionCandidatesCliArgs(["--no-limit"]);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.limit, null);
    } else {
      assert.fail();
    }
  });

  it("rejects --json combined with --pretty", () => {
    const r = parsePromotionCandidatesCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /mutually exclusive/);
  });

  it("rejects unknown / malformed flags", () => {
    for (const argv of [["--nope"], ["--limit", "-1"], ["--limit", "abc"], ["--now", "yesterday"]]) {
      const r = parsePromotionCandidatesCliArgs(argv);
      assert.equal(r.ok, false, `expected ${argv.join(" ")} to fail`);
    }
  });

  it("signals --help / -h via the helpRequested branch", () => {
    for (const flag of ["--help", "-h"]) {
      const r = parsePromotionCandidatesCliArgs([flag]);
      if (r.ok === true && "helpRequested" in r) {
        assert.equal(r.helpRequested, true);
      } else {
        assert.fail();
      }
    }
  });
});

// ── CLI happy path ──────────────────────────────────────────────────────────

describe("Phase 2l-e CLI — happy path", () => {
  it("prints help to stdout and exits 0 without reading any file", () => {
    const { stdout, stderr, reads, io } = makeIo();
    const result = runPromotionCandidatesCli(["--help"], io);
    assert.equal(result.exitCode, 0);
    assert.equal(result.set, null);
    assert.equal(stdout.join(""), USAGE_TEXT + "\n");
    assert.equal(stderr.join(""), "");
    assert.equal(reads.length, 0);
  });

  it("prints a deterministic JSON payload with pinned --now and metadata", () => {
    const content = memoryFile([goodEntry()]);
    const { stdout, stderr, io } = makeIo(content);
    const result = runPromotionCandidatesCli([
      "--memory-file", "/fake/memory.json",
      "--now", PINNED_AT,
      "--generated-by", "op@phase2l-e",
    ], io);

    assert.equal(result.exitCode, 0);
    assert.ok(result.set, "expected a candidate set");

    assert.equal(stderr.join(""), SAFETY_INVARIANTS_BANNER + "\n");

    const stdoutStr = stdout.join("");
    assert.ok(stdoutStr.endsWith("\n"));
    const payload = JSON.parse(stdoutStr.trim());

    assert.equal(payload.schemaVersion, PROMOTION_CANDIDATES_SCHEMA_VERSION);
    assert.equal(payload.label,         PROMOTION_CANDIDATES_LABEL);
    assert.equal(payload.generatedAt,   PINNED_AT);
    assert.equal(payload.generatedBy,   "op@phase2l-e");
    assert.equal(payload.aggregate.totalCandidates, 1);
    assert.deepEqual(payload.safetyDisclaimer, [...PROMOTION_CANDIDATES_SAFETY_DISCLAIMER]);

    assert.equal(payload.invariants.readOnly,                  true);
    assert.equal(payload.invariants.promotionEligible,         false);
    assert.equal(payload.invariants.autoPromote,               false);
    assert.equal(payload.invariants.requiresOperatorPromotion, true);
    assert.equal(payload.invariants.publicAction,              false);
    assert.equal(payload.invariants.schedulerDriven,           false);

    for (const c of payload.candidates) {
      assert.equal(c.readOnly,                  true);
      assert.equal(c.promotionEligible,         false);
      assert.equal(c.autoPromote,               false);
      assert.equal(c.requiresOperatorPromotion, true);
      assert.equal(c.publicAction,              false);
      assert.equal(c.schedulerDriven,           false);
      assert.ok(c.suggestedPromotionFields.length >= 5);
      assert.ok(c.operatorChecklist.length >= 4);
      assert.ok(c.readinessGaps.length >= 1);
    }
  });

  it("produces byte-identical stdout for repeat invocations with identical inputs", () => {
    const content = memoryFile([goodEntry({ id: "k_a" }), goodEntry({ id: "k_b" })]);
    const argv = [
      "--memory-file", "/fake/m.json",
      "--now", PINNED_AT,
      "--generated-by", "op@x",
    ];
    const a = makeIo(content); runPromotionCandidatesCli(argv, a.io);
    const b = makeIo(content); runPromotionCandidatesCli(argv, b.io);
    assert.equal(a.stdout.join(""), b.stdout.join(""));
    assert.equal(a.stderr.join(""), b.stderr.join(""));
  });

  it("--limit caps candidates and pushes excluded rows to ineligible records", () => {
    const entries = [
      goodEntry({ id: "k_a" }),
      goodEntry({ id: "k_b" }),
      goodEntry({ id: "k_c" }),
      goodEntry({ id: "k_d" }),
    ];
    const { stdout, io } = makeIo(memoryFile(entries));
    runPromotionCandidatesCli([
      "--memory-file", "/fake/m.json",
      "--limit", "2",
      "--now", PINNED_AT,
    ], io);
    const payload = JSON.parse(stdout.join("").trim());
    assert.equal(payload.candidates.length, 2);
    assert.equal(payload.aggregate.byReason.limit_excluded, 2);
  });

  it("excludes ineligible memory entries with reason codes", () => {
    const entries = [
      goodEntry({ id: "k_ok" }),
      goodEntry({ id: "k_promoted", promotedToHypothesisId: "h_target" }),
      goodEntry({ id: "k_archived", status: "archived" }),
      goodEntry({ id: "k_pub", title: "Hypothesis: post more tweets to grow engagement" }),
      goodEntry({ id: "k_sched", title: "Hypothesis: nightly cron schedule for refresh" }),
      goodEntry({ id: "k_mut", title: "Hypothesis: mutate registry live to apply changes" }),
      goodEntry({ id: "k_prom", title: "Hypothesis: auto-promote winning candidates" }),
      { title: "Hypothesis: missing id" },
      { id: "Hypothesis: x" },
    ];
    const { stdout, io } = makeIo(memoryFile(entries));
    runPromotionCandidatesCli([
      "--memory-file", "/fake/m.json",
      "--limit", "10",
      "--now", PINNED_AT,
    ], io);
    const payload = JSON.parse(stdout.join("").trim());
    assert.equal(payload.candidates.length, 1);
    assert.equal(payload.candidates[0].memoryId, "k_ok");
    assert.equal(payload.aggregate.byReason.already_promoted, 1);
    assert.equal(payload.aggregate.byReason.archived_entry, 1);
    assert.equal(payload.aggregate.byReason.public_action_like_title, 1);
    assert.equal(payload.aggregate.byReason.scheduler_like_title, 1);
    assert.equal(payload.aggregate.byReason.mutation_like_title, 1);
    assert.equal(payload.aggregate.byReason.promotion_like_title, 1);
    assert.ok(payload.aggregate.byReason.malformed_entry >= 1);
  });

  it("--pretty produces indented JSON that parses to the same object", () => {
    const content = memoryFile([goodEntry()]);
    const compact = makeIo(content);
    runPromotionCandidatesCli(["--memory-file", "/m", "--now", PINNED_AT], compact.io);
    const pretty = makeIo(content);
    runPromotionCandidatesCli(["--pretty", "--memory-file", "/m", "--now", PINNED_AT], pretty.io);

    const c = compact.stdout.join("").trim();
    const p = pretty.stdout.join("").trim();
    assert.notEqual(c, p);
    assert.ok(p.includes("\n  "));
    assert.deepEqual(JSON.parse(c), JSON.parse(p));
  });
});

// ── CLI error path ──────────────────────────────────────────────────────────

describe("Phase 2l-e CLI — error path", () => {
  it("returns exitCode=1 with stderr usage on unknown flag, no stdout", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runPromotionCandidatesCli(["--bogus"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /unknown flag: --bogus/);
    assert.ok(stderr.join("").includes(USAGE_TEXT));
  });

  it("returns exitCode=1 on malformed --now", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runPromotionCandidatesCli(["--now", "tomorrow"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /not a valid ISO timestamp/);
  });

  it("returns exitCode=1 when memory file read fails", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = runPromotionCandidatesCli(
      ["--memory-file", "/does/not/exist.json"],
      {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        readMemoryFile: () => {
          throw new Error("ENOENT");
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.match(stderr.join(""), /failed to read --memory-file/);
  });

  it("returns exitCode=1 when memory file is invalid JSON", () => {
    const { stdout, stderr, io } = makeIo("not json");
    const result = runPromotionCandidatesCli(["--memory-file", "/m"], io);
    assert.equal(result.exitCode, 1);
    assert.match(stderr.join(""), /failed to parse --memory-file/);
  });
});

// ── Safety invariants banner ────────────────────────────────────────────────

describe("Phase 2l-e CLI — safety banner", () => {
  it("restates read-only / manual-only / stdout-only / no-scheduler / no-auto-apply / no-promotion / no-public-action", () => {
    assert.match(SAFETY_INVARIANTS_BANNER, /read-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /manual-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /stdout-only/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no scheduler/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no auto-apply/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no promotion/i);
    assert.match(SAFETY_INVARIANTS_BANNER, /no public action/i);
  });

  it("usage text documents every flag", () => {
    for (const flag of ["--json", "--pretty", "--limit", "--no-limit", "--memory-file", "--now", "--generated-by"]) {
      assert.ok(USAGE_TEXT.includes(flag), `usage text missing ${flag}`);
    }
  });
});

// ── Source-level non-widening / no-side-effect guards ─────────────────────

describe("Phase 2l-e CLI — source-level guards (script file)", () => {
  const rawSrc = fs.readFileSync(SCRIPT_PATH, "utf8");
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("delegates to buildHypothesisPromotionCandidates / serializePromotionCandidatesSet (no duplicate logic)", () => {
    assert.ok(src.includes("buildHypothesisPromotionCandidates"));
    assert.ok(src.includes("serializePromotionCandidatesSet"));
    assert.equal(
      (src.match(/function\s+buildHypothesisPromotionCandidates\b/g) ?? []).length,
      0,
      "script must not redefine the helper",
    );
  });

  it("does NOT import the scheduler / monitor / promotion / apply / hypothesis-mutation paths", () => {
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
    ];
    for (const pat of FORBIDDEN_IMPORTS) {
      assert.equal(pat.test(src), false, `script must not import ${pat}`);
    }
  });

  it("does NOT use fs write / db / env-mutation / wall-clock / random APIs", () => {
    const FORBIDDEN = [
      /\bfs\.writeFile/,
      /\bfs\.writeFileSync/,
      /\bfs\.appendFile/,
      /\bfs\.appendFileSync/,
      /\bfs\.mkdir/,
      /\bfs\.unlink/,
      /\bfs\.rm/,
      /\bfs\.rename/,
      /\bbetter-sqlite3\b/,
      /\bdrizzle-orm\b/,
      /process\.env\.[A-Z_]+\s*=/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bnew\s+Date\s*\(\s*\)/,
    ];
    for (const pat of FORBIDDEN) {
      assert.equal(pat.test(src), false, `script must not use ${pat}`);
    }
  });

  it("the safety banner explicitly says no scheduler / no auto-apply / no promotion / no public action", () => {
    assert.match(src, /no scheduler/);
    assert.match(src, /no auto-apply/);
    assert.match(src, /no promotion/);
    assert.match(src, /no public action/);
  });
});
