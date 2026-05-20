/**
 * Tests for Phase 2m-b — promotion boundary audit + CLI runner.
 *
 * Pinned invariants:
 *
 *   1. The audit's hypothesisId and metricKey match the formal hypothesis
 *      from data/research_lab.json:
 *        hyp_agent306_safety_gating_single_write_boundary
 *        promotion_boundary_violation_count
 *   2. Running the audit against the current repository returns
 *      `violationCount === 0` and `status === "ok"`. The propose-only
 *      invariant currently holds.
 *   3. The audit is deterministic on fixed inputs: identical inputs and
 *      identical on-disk source produce deeply-equal output. Output is
 *      JSON-serialisable and byte-identical on repeat serialisation.
 *   4. The audit and the CLI runner do NOT mutate the filesystem: no
 *      live data file changes after the test runs.
 *   5. The CLI runner is stdout-only — exactly one JSON document on
 *      stdout, the safety-invariants banner on stderr, no other I/O.
 *   6. A fixture with a simulated extra `status: "applied"` write outside
 *      the engine raises `violationCount > 0` and surfaces the offending
 *      path in the findings (violation-counting smoke test). The fixture
 *      lives in a tmp directory and never touches the real repo source.
 *   7. The audit's source module does NOT import the runtime promotion
 *      path (applyRecommendation / canPromote / the recommendation engine
 *      / the scheduler / the autonomy monitor / the github bridge) and
 *      does NOT call Date.now / Math.random / process.env in core logic.
 *   8. The CLI's source module does NOT import the runtime promotion
 *      path either and is wired solely to the audit helper.
 *   9. The CLI prints the safety disclaimer and the audit payload echoes
 *      it verbatim.
 *  10. Source-level checks: there is exactly one `status: "applied"`
 *      literal write in server/selfRecommendationEngine.ts, the audit
 *      helper does not call any fs.write API, and the formal hypothesis
 *      remains at a non-experiment-ready hygiene tag after the test run.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Phase 2n drain #7 — Redirect DATA_DIR and DB_PATH so any accidental ledger,
// data, or db write lands in the tmpdir rather than the repo's `data/`.
// promotionBoundaryAudit is fs-read-only and the CLI is I/O-injected, so this
// test does no live writes today; we set these env vars eagerly so the test
// fails loudly if that ever changes. These env vars MUST be set before any
// module that captures them at import time (server/dataPaths.ts, server/db.ts)
// is imported transitively.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2mb-promotion-audit-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_DATA_DIR = path.join(REPO_ROOT, "data");

// Source / module files the audit reads (and the test reads them too).
const REAL_RESEARCH_LAB = path.join(REAL_DATA_DIR, "research_lab.json");
const REAL_MEMORY_KB    = path.join(REAL_DATA_DIR, "memory_knowledge.json");
const REAL_ENGINE       = path.join(REPO_ROOT, "server", "selfRecommendationEngine.ts");
const REAL_GATE         = path.join(REPO_ROOT, "server", "eval", "promotionGate.ts");
const AUDIT_MODULE      = path.join(REPO_ROOT, "server", "eval", "promotionBoundaryAudit.ts");
const CLI_MODULE        = path.join(REPO_ROOT, "scripts", "auditPromotionBoundary.ts");

// 7 watched live-state files for the file-level isolation contract.
const REAL_AGENT_GOALS  = path.join(REAL_DATA_DIR, "agent_goals.json");
const REAL_COMPETENCY   = path.join(REAL_DATA_DIR, "competencyProfile.json");
const REAL_LEDGER       = path.join(REAL_DATA_DIR, "experiment_decision_events.jsonl");
const REAL_SANDBOX_REG  = path.join(REAL_DATA_DIR, "sandbox_registration_records.jsonl");
const REAL_DB           = path.join(REAL_DATA_DIR, "agent306.db");

const {
  auditPromotionBoundary,
  serializePromotionBoundaryAudit,
  PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION,
  PROMOTION_BOUNDARY_AUDIT_LABEL,
  PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
  PROMOTION_BOUNDARY_AUDIT_METRIC_KEY,
  PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER,
} = await import("../eval/promotionBoundaryAudit.ts");

const {
  parseAuditPromotionBoundaryCliArgs,
  runAuditPromotionBoundaryCli,
  toAuditInputs,
  resolveDefaultRepoRoot,
  DEFAULT_CLI_SOURCE,
  USAGE_TEXT,
  SAFETY_INVARIANTS_BANNER,
} = await import("../../scripts/auditPromotionBoundary.ts");

const PINNED_NOW = "2026-05-12T17:00:00.000Z";

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

// Snapshots used by the isolation contract describe block at the bottom of
// this file. Captured in before() so they reflect repo state right when this
// test process starts running.
let researchLabBefore: string | null = null;
let memoryKbBefore:    string | null = null;
let engineBefore:      string | null = null;
let gateBefore:        string | null = null;
let agentGoalsBefore:  string | null = null;
let competencyBefore:  string | null = null;
let ledgerBefore:      string | null = null;
let sandboxRegBefore:  string | null = null;
let dbSizeBefore:  number | null = null;
let dbMtimeBefore: number | null = null;

const ENV_SNAPSHOT = JSON.stringify(process.env);

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

  researchLabBefore = readIfExists(REAL_RESEARCH_LAB);
  memoryKbBefore    = readIfExists(REAL_MEMORY_KB);
  engineBefore      = readIfExists(REAL_ENGINE);
  gateBefore        = readIfExists(REAL_GATE);
  agentGoalsBefore  = readIfExists(REAL_AGENT_GOALS);
  competencyBefore  = readIfExists(REAL_COMPETENCY);
  ledgerBefore      = readIfExists(REAL_LEDGER);
  sandboxRegBefore  = readIfExists(REAL_SANDBOX_REG);
  if (fs.existsSync(REAL_DB)) {
    const st = fs.statSync(REAL_DB);
    dbSizeBefore = st.size;
    dbMtimeBefore = st.mtimeMs;
  }
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  // Preserve the original Phase 2m-b env-drift guard.
  const beforeEnv = JSON.parse(ENV_SNAPSHOT);
  for (const key of Object.keys(process.env)) {
    if (beforeEnv[key] !== process.env[key]) {
      // DATA_DIR and DB_PATH were intentionally set at file-eval time before
      // ENV_SNAPSHOT was taken, so they should match beforeEnv. If anything
      // ELSE changed, fail loudly.
      throw new Error(`Phase 2m-b tests mutated env var ${key}`);
    }
  }
});

function makeIo(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (s: string) => void; stderr: (s: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
    },
  };
}

// ── Constants ─────────────────────────────────────────────────────────────

describe("Phase 2m-b — constants and identifiers", () => {
  it("hypothesisId matches the formal hypothesis id in research_lab.json", () => {
    const lab = JSON.parse(fs.readFileSync(REAL_RESEARCH_LAB, "utf8"));
    const ids = (lab.hypotheses ?? []).map((h: any) => h.id);
    assert.ok(
      ids.includes(PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID),
      `expected research_lab.json to contain ${PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID}`,
    );
    assert.equal(
      PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
      "hyp_agent306_safety_gating_single_write_boundary",
    );
  });

  it("metricKey matches the formal hypothesis metric", () => {
    const lab = JSON.parse(fs.readFileSync(REAL_RESEARCH_LAB, "utf8"));
    const hyp = (lab.hypotheses ?? []).find(
      (h: any) => h.id === PROMOTION_BOUNDARY_AUDIT_HYPOTHESIS_ID,
    );
    assert.ok(hyp, "hypothesis must exist");
    assert.equal(hyp.metric, "promotion_boundary_violation_count");
    assert.equal(PROMOTION_BOUNDARY_AUDIT_METRIC_KEY, "promotion_boundary_violation_count");
  });

  it("schema constants are stable", () => {
    assert.equal(PROMOTION_BOUNDARY_AUDIT_SCHEMA_VERSION, "phase2m-c.v2");
    assert.equal(PROMOTION_BOUNDARY_AUDIT_LABEL, "agent306.promotion_boundary_audit");
    assert.ok(PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER.length > 0);
  });
});

// ── Audit helper on the real repo ─────────────────────────────────────────

describe("Phase 2m-b — audit helper on the real repo", () => {
  it("returns violationCount === 0 / status='ok' on the current repository", () => {
    const result = auditPromotionBoundary({ repoRoot: REPO_ROOT, now: PINNED_NOW });
    assert.equal(result.violationCount, 0, JSON.stringify(result.findings, null, 2));
    assert.equal(result.status, "ok");
    assert.equal(result.metricKey, "promotion_boundary_violation_count");
    assert.equal(result.hypothesisId, "hyp_agent306_safety_gating_single_write_boundary");
    assert.equal(result.generatedAt, PINNED_NOW);
    assert.equal(result.findings.every(f => f.ok), true);
  });

  it("is deterministic on identical inputs", () => {
    const r1 = auditPromotionBoundary({ repoRoot: REPO_ROOT, now: PINNED_NOW, source: "test:phase2m-b" });
    const r2 = auditPromotionBoundary({ repoRoot: REPO_ROOT, now: PINNED_NOW, source: "test:phase2m-b" });
    assert.deepEqual(r1, r2);
    assert.equal(
      serializePromotionBoundaryAudit(r1),
      serializePromotionBoundaryAudit(r2),
    );
  });

  it("defaults generatedAt to null when no `now` is provided", () => {
    const r = auditPromotionBoundary({ repoRoot: REPO_ROOT });
    assert.equal(r.generatedAt, null);
    assert.equal(r.runLabel, null);
    assert.equal(r.operator, null);
    assert.equal(r.source, "manual");
  });

  it("echoes injected metadata verbatim", () => {
    const r = auditPromotionBoundary({
      repoRoot: REPO_ROOT,
      now:      PINNED_NOW,
      runLabel: "phase2m-b-daily-2026-05-12",
      operator: "op@phase2m-b",
      source:   "manual:repl",
    });
    assert.equal(r.runLabel, "phase2m-b-daily-2026-05-12");
    assert.equal(r.operator, "op@phase2m-b");
    assert.equal(r.source,   "manual:repl");
  });

  it("embeds the safety disclaimer verbatim", () => {
    const r = auditPromotionBoundary({ repoRoot: REPO_ROOT });
    assert.deepEqual(r.safetyDisclaimer, PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER);
    assert.deepEqual(r.invariants,       PROMOTION_BOUNDARY_AUDIT_SAFETY_DISCLAIMER);
  });

  it("audits at least the engine and the promotion gate", () => {
    const r = auditPromotionBoundary({ repoRoot: REPO_ROOT });
    const paths = r.auditedSurfaces.map(s => s.path);
    assert.ok(paths.includes("server/selfRecommendationEngine.ts"));
    assert.ok(paths.includes("server/eval/promotionGate.ts"));
    for (const s of r.auditedSurfaces) assert.equal(s.exists, true);
  });

  it("includes the documented per-check findings with stable ids", () => {
    const r = auditPromotionBoundary({ repoRoot: REPO_ROOT });
    const ids = r.findings.map(f => f.id).sort();
    assert.deepEqual(ids, [
      "applyRecommendation_calls_canPromote_before_applied_write",
      "applyRecommendation_requires_approved_status",
      "apply_recommendation_function_exists",
      "engine_applied_writes_inside_applyRecommendation",
      // Phase 4-b: confirms the gate declares the operator-gated
      // authoritative-block flag literal for low-risk recs.
      "phase4b_hard_block_flag_wired",
      // Phase 4-c (PR #401): confirms the gate declares the
      // operator-gated attestation-freshness env-var literal that
      // authoritatively hard-blocks low-risk promotions whose
      // phase3aPrep attestation is older than
      // PROMOTION_GATE_PHASE3A_PREP_MAX_AGE_DAYS days.
      "phase4c_freshness_flag_wired",
      // Phase 4-c part 2 (PR #403): confirms the gate declares the
      // operator-gated medium-risk hard-block flag literal AND that
      // its derive helper (deriveMediumRiskPhase3aPrepHardBlockFailures)
      // is wired into the gate code path.
      "phase4c_medium_risk_hard_block_wired",
      // Phase 4-d (PR #408): confirms the gate declares the
      // operator-gated high-risk hard-block flag literal AND that
      // its derive helper (deriveHighRiskPhase3aPrepHardBlockFailures)
      // is wired into the gate code path.
      "phase4d_hard_block_flag_wired",
      "promotion_gate_exports_canPromote",
      "single_write_site_for_status_applied",
    ]);
  });

  // Phase 4-d (PR #408): the audit acknowledges the new authoritative
  // high-risk attestation-block channel by asserting the gate source
  // declares the flag literal AND the derive helper. Source-level
  // handshake only; the audit must continue to satisfy
  // violationCount=0 on the real repo.
  it("Phase 4-d: phase4d_hard_block_flag_wired finding passes on real repo", () => {
    const r = auditPromotionBoundary({ repoRoot: REPO_ROOT });
    const f = r.findings.find(x => x.id === "phase4d_hard_block_flag_wired");
    assert.ok(f, "expected phase4d_hard_block_flag_wired finding");
    assert.equal(f!.ok, true, `detail: ${f!.detail}`);
    assert.match(f!.detail, /PROMOTION_GATE_BLOCK_HIGH_RISK_ON_PHASE3A_PREP_NOT_READY/);
    assert.match(f!.detail, /deriveHighRiskPhase3aPrepHardBlockFailures/);
  });

  it("Phase 4-d: audit fixture without the high-risk flag literal flags the finding", () => {
    // Build a tiny fixture repo with a gate source that lacks the
    // Phase 4-d authoritative high-risk-block flag literal. Other gate
    // checks (canPromote export, etc.) still pass; only the Phase 4-d
    // finding should fail.
    const fakeRoot = path.join(TMP, "fake-repo-no-phase4d-flag");
    fs.mkdirSync(path.join(fakeRoot, "server", "eval"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, "server", "selfRecommendationEngine.ts"),
      fs.readFileSync(REAL_ENGINE, "utf8"),
    );
    // Minimal gate source: still exports canPromote async function,
    // but does NOT declare the Phase 4-d flag literal or derive helper.
    fs.writeFileSync(
      path.join(fakeRoot, "server", "eval", "promotionGate.ts"),
      [
        "export interface PromotionResult { ok: boolean; failures: string[]; ranSets: string[]; }",
        "export async function canPromote(_rec: any): Promise<PromotionResult> {",
        "  return { ok: true, failures: [], ranSets: [] };",
        "}",
        "",
      ].join("\n"),
    );
    const r = auditPromotionBoundary({ repoRoot: fakeRoot });
    const f = r.findings.find(x => x.id === "phase4d_hard_block_flag_wired");
    assert.ok(f);
    assert.equal(f!.ok, false);
    assert.match(f!.detail, /missing from promotion gate source/);
    assert.equal(r.status, "violated");
  });

  // Phase 4-b: the audit acknowledges the new authoritative-block
  // channel by asserting the gate source declares the flag literal.
  // This is a SOURCE-LEVEL handshake (no runtime evaluation) — the
  // audit must continue to satisfy violationCount=0 on the real repo.
  it("Phase 4-b: phase4b_hard_block_flag_wired finding passes on real repo", () => {
    const r = auditPromotionBoundary({ repoRoot: REPO_ROOT });
    const f = r.findings.find(x => x.id === "phase4b_hard_block_flag_wired");
    assert.ok(f, "expected phase4b_hard_block_flag_wired finding");
    assert.equal(f!.ok, true, `detail: ${f!.detail}`);
    assert.match(f!.detail, /PROMOTION_GATE_BLOCK_LOW_RISK_ON_PHASE3A_PREP_NOT_READY/);
  });

  it("Phase 4-b: audit fixture without the flag literal flags the finding", () => {
    // Build a tiny fixture repo with a gate source that lacks the
    // Phase 4-b authoritative-block flag literal. The other gate
    // checks (canPromote export, etc.) still pass; only the Phase 4-b
    // finding should fail. The engine source is the real one so the
    // single-write-site contract still holds.
    const fakeRoot = path.join(TMP, "fake-repo-no-phase4b-flag");
    fs.mkdirSync(path.join(fakeRoot, "server", "eval"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, "server", "selfRecommendationEngine.ts"),
      fs.readFileSync(REAL_ENGINE, "utf8"),
    );
    // Minimal gate source: still exports canPromote async function,
    // but does NOT declare the Phase 4-b flag literal anywhere.
    fs.writeFileSync(
      path.join(fakeRoot, "server", "eval", "promotionGate.ts"),
      [
        "export interface PromotionResult { ok: boolean; failures: string[]; ranSets: string[]; }",
        "export async function canPromote(_rec: any): Promise<PromotionResult> {",
        "  return { ok: true, failures: [], ranSets: [] };",
        "}",
        "",
      ].join("\n"),
    );
    const r = auditPromotionBoundary({ repoRoot: fakeRoot });
    const f = r.findings.find(x => x.id === "phase4b_hard_block_flag_wired");
    assert.ok(f);
    assert.equal(f!.ok, false);
    assert.match(f!.detail, /missing from promotion gate source/);
    assert.equal(r.status, "violated");
  });
});

// ── Fixture audit: simulated violation ────────────────────────────────────

describe("Phase 2m-b — fixture audit with simulated violation", () => {
  it("counts an extra status:'applied' write site outside the engine as a violation", () => {
    // Build a small fake repo tree under TMP that mirrors the directories
    // the audit walks. The audit reads source text only, so we do not
    // need a real TypeScript project — just the file shapes.
    const fakeRoot = path.join(TMP, "fake-repo-violation");
    fs.mkdirSync(path.join(fakeRoot, "server", "eval"), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, "server", "rogue"), { recursive: true });

    // Copy the real engine and gate so the legitimate checks still pass.
    fs.writeFileSync(
      path.join(fakeRoot, "server", "selfRecommendationEngine.ts"),
      fs.readFileSync(REAL_ENGINE, "utf8"),
    );
    fs.writeFileSync(
      path.join(fakeRoot, "server", "eval", "promotionGate.ts"),
      fs.readFileSync(REAL_GATE, "utf8"),
    );

    // Drop a rogue file that writes status: "applied" directly.
    fs.writeFileSync(
      path.join(fakeRoot, "server", "rogue", "bypass.ts"),
      [
        "// Rogue write site for Phase 2m-b fixture test.",
        "export function bypass(db: any) {",
        "  db.update().set({ status: \"applied\" }).run();",
        "}",
        "",
      ].join("\n"),
    );

    const result = auditPromotionBoundary({ repoRoot: fakeRoot, now: PINNED_NOW });
    assert.ok(result.violationCount >= 1, "expected at least one violation");
    assert.equal(result.status, "violated");
    const failing = result.findings.find(
      f => f.id === "single_write_site_for_status_applied",
    );
    assert.ok(failing);
    assert.equal(failing!.ok, false);
    assert.match(failing!.detail, /server\/rogue\/bypass\.ts/);
  });

  it("reports `blocked` when the engine source file is missing", () => {
    const fakeRoot = path.join(TMP, "fake-repo-missing-engine");
    fs.mkdirSync(path.join(fakeRoot, "server", "eval"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, "server", "eval", "promotionGate.ts"),
      fs.readFileSync(REAL_GATE, "utf8"),
    );
    const result = auditPromotionBoundary({ repoRoot: fakeRoot });
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some(b => b.includes("selfRecommendationEngine.ts")));
  });

  it("flags a missing canPromote precedence in a modified engine fixture", () => {
    const fakeRoot = path.join(TMP, "fake-repo-no-can-promote");
    fs.mkdirSync(path.join(fakeRoot, "server", "eval"), { recursive: true });
    // Engine with applyRecommendation but no canPromote call.
    fs.writeFileSync(
      path.join(fakeRoot, "server", "selfRecommendationEngine.ts"),
      [
        "export async function applyRecommendation(id: string, operator: string) {",
        "  const existing: any = {};",
        "  if (existing.status !== 'approved') return { ok: false };",
        "  // NO canPromote() call here — bypass attempt.",
        "  return { ok: true, status: \"applied\" };",
        "}",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fakeRoot, "server", "eval", "promotionGate.ts"),
      fs.readFileSync(REAL_GATE, "utf8"),
    );
    const result = auditPromotionBoundary({ repoRoot: fakeRoot });
    assert.equal(result.status, "violated");
    const failing = result.findings.find(
      f => f.id === "applyRecommendation_calls_canPromote_before_applied_write",
    );
    assert.ok(failing);
    assert.equal(failing!.ok, false);
  });
});

// ── CLI runner ────────────────────────────────────────────────────────────

describe("Phase 2m-b — CLI runner", () => {
  it("parses defaults", () => {
    const r = parseAuditPromotionBoundaryCliArgs([], { repoRoot: REPO_ROOT });
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,   false);
      assert.equal(r.options.now,      null);
      assert.equal(r.options.runLabel, null);
      assert.equal(r.options.operator, null);
      assert.equal(r.options.source,   DEFAULT_CLI_SOURCE);
      assert.equal(r.options.repoRoot, REPO_ROOT);
    } else {
      assert.fail("expected options branch");
    }
  });

  it("parses every documented flag", () => {
    const r = parseAuditPromotionBoundaryCliArgs([
      "--pretty",
      "--repo-root", REPO_ROOT,
      "--now",       PINNED_NOW,
      "--run-label", "phase2m-b-daily-2026-05-12",
      "--operator",  "op@phase2m-b",
      "--source",    "manual:repl",
    ]);
    assert.equal(r.ok, true);
    if (r.ok === true && !("helpRequested" in r)) {
      assert.equal(r.options.pretty,   true);
      assert.equal(r.options.repoRoot, REPO_ROOT);
      assert.equal(r.options.now,      PINNED_NOW);
      assert.equal(r.options.runLabel, "phase2m-b-daily-2026-05-12");
      assert.equal(r.options.operator, "op@phase2m-b");
      assert.equal(r.options.source,   "manual:repl");
    } else {
      assert.fail("expected options branch");
    }
  });

  it("rejects --json and --pretty together", () => {
    const r = parseAuditPromotionBoundaryCliArgs(["--json", "--pretty"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /mutually exclusive/);
  });

  it("rejects unknown flags", () => {
    const r = parseAuditPromotionBoundaryCliArgs(["--bogus"]);
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.reason, /unknown flag/);
  });

  it("rejects malformed --now", () => {
    const r = parseAuditPromotionBoundaryCliArgs(["--now", "tomorrow"]);
    assert.equal(r.ok, false);
  });

  it("--help prints USAGE_TEXT and exits 0", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runAuditPromotionBoundaryCli(["--help"], io);
    assert.equal(result.exitCode, 0);
    assert.equal(result.audit, null);
    assert.ok(stdout.join("").includes(USAGE_TEXT));
    assert.equal(stderr.join(""), "");
  });

  it("usage error exits 1 and writes only to stderr", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runAuditPromotionBoundaryCli(["--bogus"], io);
    assert.equal(result.exitCode, 1);
    assert.equal(result.audit, null);
    assert.equal(stdout.join(""), "");
    assert.match(stderr.join(""), /unknown flag/);
  });

  it("prints exactly one JSON document on stdout and the banner on stderr", () => {
    const { stdout, stderr, io } = makeIo();
    const result = runAuditPromotionBoundaryCli(
      ["--now", PINNED_NOW, "--repo-root", REPO_ROOT],
      io,
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.audit);
    assert.equal(result.audit!.status, "ok");

    const stdoutStr = stdout.join("");
    assert.equal(stdoutStr.endsWith("\n"), true);
    const payload = JSON.parse(stdoutStr);
    assert.equal(payload.metricKey, "promotion_boundary_violation_count");
    assert.equal(payload.hypothesisId, "hyp_agent306_safety_gating_single_write_boundary");
    assert.equal(payload.violationCount, 0);

    const stderrStr = stderr.join("");
    assert.ok(stderrStr.includes(SAFETY_INVARIANTS_BANNER));
  });

  it("repeats byte-identical output across runs with identical inputs", () => {
    const a = makeIo();
    const b = makeIo();
    runAuditPromotionBoundaryCli(["--now", PINNED_NOW, "--repo-root", REPO_ROOT], a.io);
    runAuditPromotionBoundaryCli(["--now", PINNED_NOW, "--repo-root", REPO_ROOT], b.io);
    assert.equal(a.stdout.join(""), b.stdout.join(""));
    assert.equal(a.stderr.join(""), b.stderr.join(""));
  });

  it("exits 2 when a fixture violates the boundary", () => {
    // Reuse the violation fixture from the audit-helper tests.
    const fakeRoot = path.join(TMP, "fake-repo-cli-violation");
    fs.mkdirSync(path.join(fakeRoot, "server", "eval"), { recursive: true });
    fs.mkdirSync(path.join(fakeRoot, "server", "rogue"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeRoot, "server", "selfRecommendationEngine.ts"),
      fs.readFileSync(REAL_ENGINE, "utf8"),
    );
    fs.writeFileSync(
      path.join(fakeRoot, "server", "eval", "promotionGate.ts"),
      fs.readFileSync(REAL_GATE, "utf8"),
    );
    fs.writeFileSync(
      path.join(fakeRoot, "server", "rogue", "bypass.ts"),
      "export function bypass(db: any) { db.set({ status: \"applied\" }); }\n",
    );

    const { stdout, io } = makeIo();
    const result = runAuditPromotionBoundaryCli(
      ["--repo-root", fakeRoot, "--now", PINNED_NOW],
      io,
    );
    assert.equal(result.exitCode, 2);
    const payload = JSON.parse(stdout.join(""));
    assert.equal(payload.status, "violated");
    assert.ok(payload.violationCount > 0);
  });

  it("toAuditInputs forwards every field", () => {
    const inputs = toAuditInputs({
      pretty: false,
      repoRoot: REPO_ROOT,
      now: PINNED_NOW,
      runLabel: "label",
      operator: "op",
      source: "manual:test",
    });
    assert.equal(inputs.repoRoot, REPO_ROOT);
    assert.equal(inputs.now, PINNED_NOW);
    assert.equal(inputs.runLabel, "label");
    assert.equal(inputs.operator, "op");
    assert.equal(inputs.source, "manual:test");
  });

  it("resolveDefaultRepoRoot points at this repository", () => {
    assert.equal(resolveDefaultRepoRoot(), REPO_ROOT);
  });
});

// ── Source-level guards on the audit and CLI modules ──────────────────────

describe("Phase 2m-b — source-level non-import guards", () => {
  const auditSrc = fs.readFileSync(AUDIT_MODULE, "utf8");
  const cliSrc   = fs.readFileSync(CLI_MODULE,   "utf8");

  // Forbidden imports (runtime paths that would let the audit widen state).
  const forbidden = [
    "selfRecommendationEngine",
    "scheduler",
    "autonomyMonitor",
    "githubBridge",
    "selfEvolutionEngine",
    "selfRecommendationRouter",
  ];

  it("audit module does NOT import any runtime promotion path", () => {
    for (const name of forbidden) {
      const re = new RegExp(`import[^"']*["'][^"']*${name}[^"']*["']`);
      assert.equal(re.test(auditSrc), false, `audit imports forbidden module ${name}`);
    }
    // Also forbid importing the promotion gate / regression runner so the
    // audit cannot accidentally run a regression set or call canPromote
    // for side effect.
    assert.equal(
      /from\s+["'][^"']*\bpromotionGate(?:\.js)?["']/.test(auditSrc),
      false,
      "audit must not import promotionGate at runtime",
    );
    assert.equal(
      /from\s+["'][^"']*\bregressionRunner(?:\.js)?["']/.test(auditSrc),
      false,
      "audit must not import regressionRunner",
    );
  });

  it("CLI module does NOT import any runtime promotion path", () => {
    for (const name of forbidden) {
      const re = new RegExp(`import[^"']*["'][^"']*${name}[^"']*["']`);
      assert.equal(re.test(cliSrc), false, `CLI imports forbidden module ${name}`);
    }
    assert.equal(
      /from\s+["'][^"']*\bpromotionGate(?:\.js)?["']/.test(cliSrc),
      false,
      "CLI must not import promotionGate at runtime",
    );
  });

  it("audit module does NOT call fs.write / fs.append / fs.unlink / fs.mkdir / fs.rm APIs", () => {
    const banned = [
      "fs.writeFile",
      "fs.writeFileSync",
      "fs.appendFile",
      "fs.appendFileSync",
      "fs.unlink",
      "fs.unlinkSync",
      "fs.rm",
      "fs.rmSync",
      "fs.mkdir",
      "fs.mkdirSync",
      "fs.rename",
      "fs.renameSync",
      "fs.copyFile",
      "fs.copyFileSync",
      "fs.chmod",
      "fs.createWriteStream",
    ];
    for (const api of banned) {
      assert.equal(auditSrc.includes(api), false, `audit calls forbidden fs API ${api}`);
    }
  });

  it("audit core does NOT call Date.now / Math.random / randomUUID / process.env", () => {
    // Strip block comments and line comments so we only check actual code,
    // not the docstring (which explicitly names what the module forbids).
    const codeOnly = auditSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(/\r?\n/)
      .map(l => l.replace(/\s*\/\/.*$/, ""))
      .join("\n");
    assert.equal(codeOnly.includes("Date.now"),    false);
    assert.equal(codeOnly.includes("new Date("),   false);
    assert.equal(codeOnly.includes("Math.random"), false);
    assert.equal(codeOnly.includes("randomUUID"),  false);
    assert.equal(codeOnly.includes("process.env"), false);
  });

  it("audit module declares only fs and path as Node imports", () => {
    const imports = auditSrc.match(/^import[^;]+;/gm) ?? [];
    for (const im of imports) {
      const m = im.match(/from\s+["']([^"']+)["']/);
      if (!m) continue;
      const target = m[1];
      assert.ok(
        target === "node:fs" || target === "node:path",
        `audit imports unexpected module ${target}`,
      );
    }
  });

  it("CLI module imports only the audit helper and node:path", () => {
    const imports = cliSrc.match(/^import[^;]+;/gm) ?? [];
    const targets = imports
      .map(im => im.match(/from\s+["']([^"']+)["']/)?.[1])
      .filter((t): t is string => typeof t === "string");
    for (const t of targets) {
      assert.ok(
        t === "node:path" || t.endsWith("promotionBoundaryAudit.js") || t.endsWith("promotionBoundaryAudit.ts"),
        `CLI imports unexpected module ${t}`,
      );
    }
  });
});

// ── Boundary-not-widened source-level check on the engine ─────────────────

describe("Phase 2m-b — engine + gate source pin", () => {
  it("engine still contains exactly one status: 'applied' write line", () => {
    const text = fs.readFileSync(REAL_ENGINE, "utf8");
    const lines = text.split(/\r?\n/);
    const re = /status\s*:\s*(['"])applied\1/;
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (re.test(lines[i])) hits.push(i + 1);
    }
    assert.equal(hits.length, 1, `expected exactly one applied write, got lines ${hits.join(",")}`);
  });

  it("promotion gate still exports canPromote(rec) and rejects non-approved status", () => {
    const text = fs.readFileSync(REAL_GATE, "utf8");
    assert.match(text, /export\s+async\s+function\s+canPromote\s*\(/);
    assert.match(text, /rec\.status\s*!==\s*['"]approved['"]/);
  });
});

// ── Formal hypothesis still gated ─────────────────────────────────────────

describe("Phase 2m-b — formal hypothesis remains non-ready", () => {
  it("the safety-gating hypothesis is still operator-gated / not experiment-ready", () => {
    const lab = JSON.parse(fs.readFileSync(REAL_RESEARCH_LAB, "utf8"));
    const hyp = (lab.hypotheses ?? []).find(
      (h: any) => h.id === "hyp_agent306_safety_gating_single_write_boundary",
    );
    assert.ok(hyp, "expected formal hypothesis to exist");
    // The hypothesis must remain in a non-experiment-ready state — Phase
    // 2m-b only validates measurement and explicitly does NOT promote.
    assert.notEqual(hyp.hygieneTag, "ready_for_experiment");
    assert.notEqual(hyp.status, "confirmed");
    assert.notEqual(hyp.status, "running");
  });
});

// ── File-level isolation contract ────────────────────────────────────────────
//
// Phase 2n drain #7 — mirrors the contract added by drains #1–#6. Asserts
// that after every test in this file runs, none of the 7 watched live-state
// files under repo `data/` have been touched, and that env-var redirects are
// still pinned. The promotionBoundaryAudit test predates the drain template
// and already snapshotted four files (research_lab.json, memory_knowledge.json,
// server/selfRecommendationEngine.ts, server/eval/promotionGate.ts); those
// engine + gate checks are preserved at the top of the file via the existing
// hand-rolled assertions, and this block extends coverage to the canonical
// 7 watched live-state files.

describe("promotionBoundaryAudit.test.ts — file-level isolation contract", () => {
  it("env-var redirects are still pointing at TMP", () => {
    assert.equal(process.env.DATA_DIR, TMP);
    assert.equal(process.env.DB_PATH, path.join(TMP, "test.db"));
  });

  it("research_lab.json is unchanged", () => {
    assert.equal(readIfExists(REAL_RESEARCH_LAB), researchLabBefore);
  });

  it("memory_knowledge.json is unchanged", () => {
    assert.equal(readIfExists(REAL_MEMORY_KB), memoryKbBefore);
  });

  it("agent_goals.json is unchanged", () => {
    assert.equal(readIfExists(REAL_AGENT_GOALS), agentGoalsBefore);
  });

  it("competencyProfile.json is unchanged", () => {
    assert.equal(readIfExists(REAL_COMPETENCY), competencyBefore);
  });

  it("experiment_decision_events.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_LEDGER), ledgerBefore);
  });

  it("sandbox_registration_records.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_SANDBOX_REG), sandboxRegBefore);
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

  // Preserve the original Phase 2m-b source-file pins (engine + gate) so the
  // audit-helper test surface remains protected alongside the 7 watched files.
  it("server/selfRecommendationEngine.ts is unchanged", () => {
    assert.equal(readIfExists(REAL_ENGINE), engineBefore);
  });

  it("server/eval/promotionGate.ts is unchanged", () => {
    assert.equal(readIfExists(REAL_GATE), gateBefore);
  });
});
