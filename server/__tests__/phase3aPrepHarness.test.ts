/**
 * Tests for Track A / Phase 3a-prep harness.
 *
 * Spec invariants pinned by this file:
 *
 *   1. Every exported constant is structurally frozen — `Object.isFrozen`
 *      returns true at the top level, and mutation attempts in strict
 *      mode throw.
 *   2. `PHASE3A_PREP_HARNESS_VERSION` is the literal string
 *      `"phase3aPrep.v1"`. Any change is a contract break and MUST be
 *      paired with an updated test expectation. This literal is allowed
 *      to occur only in the harness module itself and its own test
 *      (the boundary regression suite enforces the corresponding rule
 *      for the entry-point version literal — we mirror it here for
 *      the harness).
 *   3. `PHASE3A_PREP_PRECONDITION_KEYS` is an ordered array whose
 *      contents and order match `PHASE3_ENTRY_PRECONDITIONS` 1:1.
 *      This is also pinned cross-module in
 *      `phase3BoundaryRegression.test.ts` Pin 11.
 *   4. `PHASE3A_PREP_PRIORITY_TIERS` is exactly `["high", "low"]`. Both
 *      tiers ship from the start; adding or reordering tiers is a
 *      contract break.
 *   5. `computePhase3aPrepReadiness` is a pure function: same input →
 *      same output, no observable side effects, no clock / random / env
 *      reads.
 *   6. Verdict semantics:
 *        - all high-tier `satisfied` (with non-empty evidenceRef) AND
 *          all low-tier `satisfied` (with non-empty evidenceRef) AND
 *          `kind === "summarizationTemplate"` → `fully_prepared`,
 *          `blockers: []`.
 *        - all high-tier satisfied but any low-tier non-satisfied →
 *          `high_tier_ready`, `blockers` lists every low-tier failure.
 *        - any high-tier non-satisfied → `not_ready`, `blockers` lists
 *          every high-tier failure (and any low-tier failures it sees).
 *        - `kind !== "summarizationTemplate"` → `not_ready` with a
 *          kind-parity blocker.
 *        - missing precondition slot or mismatched key/priority echo →
 *          `not_ready` with a structural blocker.
 *        - empty evidenceRef on a `"satisfied"` claim → demotes that
 *          tier's verdict; blocker mentions the empty evidenceRef.
 *   7. Source-level guards: the module does NOT import the scheduler /
 *      autonomy monitor / applyRecommendation / promotion gate /
 *      hypothesis action gate / selfRecommendationEngine /
 *      phase3EntryPoint. It does NOT call `Date.now` / `Math.random` /
 *      `randomUUID`, does NOT touch `process.env`, and does NOT call
 *      any fs / db API.
 *   8. The module is NOT imported by `server/index.ts`, the autonomy
 *      monitor, the scheduler, the promotion gate, the apply
 *      recommendation path, or any other currently-running production
 *      module. Importing this file confers no authority — it is a
 *      declarative anchor only.
 *
 * Drain template (full file-level isolation contract per the Phase 2n
 * drain standard, drain #19 reference): env-var pin BEFORE node:test
 * import, ORIGINAL_* capture/restore, loud-failure before() pin, 7-file
 * snapshots, after() diff, 8-assertion contract block, DB-stat gate
 * under AGENT306_AGGREGATE_RUN.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trackA-phase3aPrepHarness-test-"));
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.DB_PATH  = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const HARNESS_SOURCE      = path.join(REPO_ROOT, "server", "experiments", "phase3aPrepHarness.ts");

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
    throw new Error(`phase3aPrepHarness isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`phase3aPrepHarness isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP_DIR) {
    throw new Error(`phase3aPrepHarness isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP_DIR, "test.db")) {
    throw new Error(`phase3aPrepHarness isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
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
      if (!a.exists) throw new Error(`phase3aPrepHarness tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`phase3aPrepHarness tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`phase3aPrepHarness tests created live ${label}!`);
    }
  }

  // Under aggregate parallel runs, sibling test files write to
  // live data/agent306.db, drifting its mtime. Skip the per-file
  // DB-stat check there; scripts/checkCoreStateIntegrity.sh runs
  // the canonical end-of-suite check. See PR #354.
  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
    const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`phase3aPrepHarness tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`phase3aPrepHarness tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`phase3aPrepHarness tests created live agent306.db!`);
    }
  }
});

// Dynamic import of the harness module. The harness itself reads no
// env vars and touches no fs / db, but we still dynamic-import to match
// the drain template's "env set before any server-module import" rule.
const {
  PHASE3A_PREP_HARNESS_VERSION,
  PHASE3A_PREP_HARNESS_LABEL,
  PHASE3A_PREP_PRECONDITION_KEYS,
  PHASE3A_PREP_PRIORITY_TIERS,
  PHASE3A_PREP_HARNESS,
  computePhase3aPrepReadiness,
} = await import("../experiments/phase3aPrepHarness.ts");

import type {
  Phase3aPrepCandidate,
  Phase3aPrepPreconditionKey,
  PreconditionPriority,
  PreconditionAttestationStatus,
} from "../experiments/phase3aPrepHarness.ts";

// ── Test fixture builders ─────────────────────────────────────────────────

function makeAttestation(
  key: Phase3aPrepPreconditionKey,
  priority: PreconditionPriority,
  status: PreconditionAttestationStatus,
  evidenceRef: string = `evidence://${key}/${priority}`,
  rationale: string = `test rationale for ${key}/${priority}`,
) {
  return { key, priority, status, evidenceRef, rationale };
}

function makeCandidate(
  overrides: Partial<{
    kind: string;
    statusFor: (key: Phase3aPrepPreconditionKey, priority: PreconditionPriority) => PreconditionAttestationStatus;
    evidenceFor: (key: Phase3aPrepPreconditionKey, priority: PreconditionPriority) => string;
    candidateId: string;
  }> = {},
): Phase3aPrepCandidate {
  const statusFor = overrides.statusFor ?? (() => "satisfied" as const);
  const evidenceFor = overrides.evidenceFor ?? ((k, p) => `evidence://${k}/${p}`);
  const preconditions: Record<string, Record<string, ReturnType<typeof makeAttestation>>> = {};
  for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
    preconditions[key] = {};
    for (const tier of PHASE3A_PREP_PRIORITY_TIERS) {
      preconditions[key][tier] = makeAttestation(
        key,
        tier,
        statusFor(key, tier),
        evidenceFor(key, tier),
      );
    }
  }
  return {
    candidateId: overrides.candidateId ?? "test-candidate-1",
    kind: (overrides.kind ?? "summarizationTemplate") as "summarizationTemplate",
    preconditions: preconditions as Phase3aPrepCandidate["preconditions"],
  };
}

// ── Schema version + label ────────────────────────────────────────────────

describe("Track A — schema version + label", () => {
  it("pins PHASE3A_PREP_HARNESS_VERSION to 'phase3aPrep.v1'", () => {
    assert.equal(PHASE3A_PREP_HARNESS_VERSION, "phase3aPrep.v1");
  });

  it("PHASE3A_PREP_HARNESS_LABEL mentions Phase 3a and attestation", () => {
    assert.match(PHASE3A_PREP_HARNESS_LABEL, /Phase 3a/);
    assert.match(PHASE3A_PREP_HARNESS_LABEL, /attestation/i);
  });
});

// ── Precondition + priority vocabulary ────────────────────────────────────

describe("Track A — precondition key vocabulary", () => {
  it("contains exactly the seven canonical precondition keys in stable order", () => {
    const expected = [
      "reversibleLowRiskActionOnly",
      "explicitKillSwitchAndResourceLimits",
      "anomalyAndDriftDetectionPlaceholder",
      "rollbackProof",
      "humanApprovalBoundary",
      "metricsClockReadiness",
      "noPublicAction",
    ];
    assert.deepEqual([...PHASE3A_PREP_PRECONDITION_KEYS], expected);
  });

  it("matches the order of PHASE3_ENTRY_PRECONDITIONS exactly", async () => {
    const { PHASE3_ENTRY_PRECONDITIONS } = await import(
      "../experiments/phase3EntryPoint.ts"
    );
    assert.deepEqual(
      [...PHASE3A_PREP_PRECONDITION_KEYS],
      [...PHASE3_ENTRY_PRECONDITIONS],
    );
  });
});

describe("Track A — priority tier vocabulary", () => {
  it("is exactly ['high', 'low']", () => {
    assert.deepEqual([...PHASE3A_PREP_PRIORITY_TIERS], ["high", "low"]);
  });

  it("is length 2", () => {
    assert.equal(PHASE3A_PREP_PRIORITY_TIERS.length, 2);
  });
});

// ── Structural freeze ──────────────────────────────────────────────────────

describe("Track A — structural freeze", () => {
  it("PHASE3A_PREP_PRECONDITION_KEYS is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3A_PREP_PRECONDITION_KEYS), true);
  });

  it("PHASE3A_PREP_PRIORITY_TIERS is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3A_PREP_PRIORITY_TIERS), true);
  });

  it("PHASE3A_PREP_HARNESS is frozen", () => {
    assert.equal(Object.isFrozen(PHASE3A_PREP_HARNESS), true);
  });

  it("mutating PHASE3A_PREP_HARNESS throws in strict mode", () => {
    "use strict";
    assert.throws(() => {
      (PHASE3A_PREP_HARNESS as unknown as { version: string }).version = "phase3aPrep.v999";
    });
  });
});

// ── Aggregated harness spot-check ─────────────────────────────────────────

describe("Track A — aggregated PHASE3A_PREP_HARNESS", () => {
  it("aggregates exactly the documented top-level keys", () => {
    const expected = new Set([
      "version",
      "label",
      "preconditionKeys",
      "priorityTiers",
      "computeReadiness",
    ]);
    const actual = new Set(Object.keys(PHASE3A_PREP_HARNESS));
    assert.deepEqual(actual, expected);
  });

  it("aggregated identity equalities hold", () => {
    assert.equal(PHASE3A_PREP_HARNESS.version,          PHASE3A_PREP_HARNESS_VERSION);
    assert.equal(PHASE3A_PREP_HARNESS.label,            PHASE3A_PREP_HARNESS_LABEL);
    assert.equal(PHASE3A_PREP_HARNESS.preconditionKeys, PHASE3A_PREP_PRECONDITION_KEYS);
    assert.equal(PHASE3A_PREP_HARNESS.priorityTiers,    PHASE3A_PREP_PRIORITY_TIERS);
    assert.equal(PHASE3A_PREP_HARNESS.computeReadiness, computePhase3aPrepReadiness);
  });
});

// ── Verdict: happy path (fully_prepared) ──────────────────────────────────

describe("Track A — computePhase3aPrepReadiness: fully_prepared happy path", () => {
  it("returns fully_prepared with no blockers when all 14 attestations are satisfied", () => {
    const candidate = makeCandidate();
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict,              "fully_prepared");
    assert.equal(r.highTierAllSatisfied, true);
    assert.equal(r.lowTierAllSatisfied,  true);
    assert.deepEqual([...r.blockers], []);
  });

  it("is a pure function — same input yields a deeply-equal output across calls", () => {
    const a = computePhase3aPrepReadiness(makeCandidate());
    const b = computePhase3aPrepReadiness(makeCandidate());
    assert.deepEqual(a, b);
  });

  it("output object is frozen", () => {
    const r = computePhase3aPrepReadiness(makeCandidate());
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(r.blockers), true);
  });
});

// ── Verdict: high_tier_ready ──────────────────────────────────────────────

describe("Track A — computePhase3aPrepReadiness: high_tier_ready", () => {
  it("returns high_tier_ready when every high tier is satisfied but a low tier is unverified", () => {
    const candidate = makeCandidate({
      statusFor: (_k, p) => (p === "low" ? "unverified" : "satisfied"),
    });
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict,              "high_tier_ready");
    assert.equal(r.highTierAllSatisfied, true);
    assert.equal(r.lowTierAllSatisfied,  false);
    assert.equal(r.blockers.length,      PHASE3A_PREP_PRECONDITION_KEYS.length);
    for (const key of PHASE3A_PREP_PRECONDITION_KEYS) {
      assert.ok(
        r.blockers.some(b => b.includes(`low-tier precondition '${key}' is 'unverified'`)),
        `expected low-tier unverified blocker for ${key}`,
      );
    }
  });

  it("returns high_tier_ready when only one low-tier slot is violated", () => {
    const candidate = makeCandidate({
      statusFor: (k, p) => (p === "low" && k === "rollbackProof" ? "violated" : "satisfied"),
    });
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict,              "high_tier_ready");
    assert.equal(r.highTierAllSatisfied, true);
    assert.equal(r.lowTierAllSatisfied,  false);
    assert.equal(r.blockers.length,      1);
    assert.match(r.blockers[0], /low-tier precondition 'rollbackProof' is 'violated'/);
  });
});

// ── Verdict: not_ready (high-tier failures) ───────────────────────────────

describe("Track A — computePhase3aPrepReadiness: not_ready (high-tier failures)", () => {
  it("returns not_ready when any high-tier attestation is unverified", () => {
    const candidate = makeCandidate({
      statusFor: (k, p) => (p === "high" && k === "humanApprovalBoundary" ? "unverified" : "satisfied"),
    });
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict,              "not_ready");
    assert.equal(r.highTierAllSatisfied, false);
    assert.ok(r.blockers.some(b => b.includes("high-tier precondition 'humanApprovalBoundary' is 'unverified'")));
  });

  it("returns not_ready when any high-tier attestation is violated", () => {
    const candidate = makeCandidate({
      statusFor: (k, p) => (p === "high" && k === "noPublicAction" ? "violated" : "satisfied"),
    });
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict, "not_ready");
    assert.ok(r.blockers.some(b => b.includes("high-tier precondition 'noPublicAction' is 'violated'")));
  });

  it("returns not_ready when high-tier satisfied has empty evidenceRef", () => {
    const candidate = makeCandidate({
      evidenceFor: (k, p) => (p === "high" && k === "metricsClockReadiness" ? "" : `evidence://${k}/${p}`),
    });
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict, "not_ready");
    assert.equal(r.highTierAllSatisfied, false);
    assert.ok(r.blockers.some(b => b.includes("high-tier precondition 'metricsClockReadiness' is 'satisfied' but has empty evidenceRef")));
  });
});

// ── Verdict: not_ready (kind / structural failures) ───────────────────────

describe("Track A — computePhase3aPrepReadiness: kind + structural failures", () => {
  it("returns not_ready when kind does not match the Phase 3a entry kind", () => {
    const candidate = makeCandidate({ kind: "researchTemplate" });
    const r = computePhase3aPrepReadiness(candidate);
    assert.equal(r.verdict, "not_ready");
    assert.ok(r.blockers.some(b => b.includes("candidate.kind 'researchTemplate' does not match")));
  });

  it("returns not_ready when a precondition slot is missing", () => {
    const candidate = makeCandidate();
    const broken: any = { ...candidate, preconditions: { ...candidate.preconditions } };
    delete broken.preconditions.rollbackProof;
    const r = computePhase3aPrepReadiness(broken);
    assert.equal(r.verdict, "not_ready");
    assert.ok(r.blockers.some(b => b.includes("precondition 'rollbackProof' is missing both tiers")));
  });

  it("returns not_ready when an attestation's echoed key mismatches", () => {
    const candidate = makeCandidate();
    const broken: any = JSON.parse(JSON.stringify(candidate));
    broken.preconditions.rollbackProof.high.key = "noPublicAction";
    const r = computePhase3aPrepReadiness(broken);
    assert.equal(r.verdict, "not_ready");
    assert.ok(r.blockers.some(b => b.includes("mismatched key 'noPublicAction'")));
  });

  it("returns not_ready when an attestation's echoed priority mismatches", () => {
    const candidate = makeCandidate();
    const broken: any = JSON.parse(JSON.stringify(candidate));
    broken.preconditions.rollbackProof.high.priority = "low";
    const r = computePhase3aPrepReadiness(broken);
    assert.equal(r.verdict, "not_ready");
    assert.ok(r.blockers.some(b => b.includes("mismatched priority 'low'")));
  });
});

// ── Source-level guards ───────────────────────────────────────────────────

describe("Track A — source-level guards", () => {
  const rawSrc = fs.readFileSync(HARNESS_SOURCE, "utf8");
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("does NOT import scheduler / monitor / promotion / apply / hypothesis-mutation / selfRecommendation / phase3EntryPoint", () => {
    const FORBIDDEN_IMPORTS = [
      /from\s+["'][^"']*scheduler[^"']*["']/,
      /from\s+["'][^"']*autonomyMonitor[^"']*["']/,
      /from\s+["'][^"']*applyRecommendation[^"']*["']/,
      /from\s+["'][^"']*promotionGate[^"']*["']/,
      /from\s+["'][^"']*hypothesisActionGate[^"']*["']/,
      /from\s+["'][^"']*selfRecommendationEngine[^"']*["']/,
      /from\s+["'][^"']*phase3EntryPoint[^"']*["']/,
      /from\s+["'][^"']*server\/index[^"']*["']/,
    ];
    for (const pat of FORBIDDEN_IMPORTS) {
      assert.equal(pat.test(src), false, `module must not import ${pat}`);
    }
  });

  it("does NOT touch fs / db / env / wall-clock / random APIs", () => {
    const FORBIDDEN = [
      /\bfs\b/,
      /\bbetter-sqlite3\b/,
      /\bdrizzle-orm\b/,
      /process\.env\b/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\brandomUUID\b/,
      /\bnew\s+Date\s*\(/,
    ];
    for (const pat of FORBIDDEN) {
      assert.equal(pat.test(src), false, `module must not use ${pat}`);
    }
  });

  it("only imports types from phase2CloseOutReport (declarative anchor only)", () => {
    const importLines = src
      .split("\n")
      .filter(line => /^\s*import\s/.test(line));
    assert.equal(importLines.length, 1,
      `expected exactly one import line, got ${importLines.length}:\n${importLines.join("\n")}`);
    assert.match(importLines[0], /import\s+type\s+\{/,
      "the sole import must be a type-only import");
    assert.match(importLines[0], /phase2CloseOutReport/);
  });
});

// ── Production runtime isolation ──────────────────────────────────────────

describe("Track A — production runtime isolation", () => {
  it("is NOT imported by any module under server/ except the advisory attestation adapter (and its tests)", () => {
    const SERVER_DIR = path.join(REPO_ROOT, "server");
    const MODULE_BASENAME = "phase3aPrepHarness";
    const SELF_BASENAME   = path.basename(new URL(import.meta.url).pathname);

    // Track A / Phase 3a-proper introduced the FIRST authorized in-process
    // consumer of the harness: the advisory promotion-gate attestation
    // adapter. The adapter is read-only, returns telemetry that NEVER
    // flips `canPromote(rec).ok` (Pin 11 boundary), and is itself
    // exercised by two test files. No other server-side module is
    // permitted to import the harness — extending this set is a
    // deliberate boundary change that requires updating this allow-list
    // (which is the visible signal that a new authorized consumer was
    // added).
    const ALLOWED_SERVER_IMPORTERS = new Set([
      "phase3aPrepAttestation.ts",            // server/eval/phase3aPrepAttestation.ts — the adapter
      "phase3aPrepAttestation.test.ts",       // server/__tests__/phase3aPrepAttestation.test.ts — adapter unit tests
      "promotionGateAttestation.test.ts",     // server/__tests__/promotionGateAttestation.test.ts — gate integration tests
    ]);

    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
        if (path.basename(full) === `${MODULE_BASENAME}.ts`) continue;
        if (path.basename(full) === SELF_BASENAME) continue;
        if (ALLOWED_SERVER_IMPORTERS.has(path.basename(full))) continue;
        const text = fs.readFileSync(full, "utf8");
        const importRe = new RegExp(`from\\s+["'][^"']*${MODULE_BASENAME}[^"']*["']`);
        if (importRe.test(text)) {
          offenders.push(full);
        }
      }
    }

    walk(SERVER_DIR);
    assert.deepEqual(offenders, [],
      `Phase 3a-prep harness must not be imported by any module under server/ except the authorized advisory-attestation adapter and its tests. Offenders: ${offenders.join(", ")}`);
  });

  it("is NOT imported by any script under scripts/ other than the Phase 3a-prep-c manual CLI runner", () => {
    const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts");
    if (!fs.existsSync(SCRIPTS_DIR)) return;
    // Track A / Phase 3a-prep-c added the only allowed importer: the
    // manual CLI runner. It is propose-only / read-only / stdout-only
    // and itself listed in `PHASE3_NEVER_AUTHORIZED_BY`. No other
    // script may import the harness.
    const ALLOWED_SCRIPT_IMPORTERS = new Set([
      "runManualPhase3aPrepEvaluation.ts",
    ]);
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue;
      if (ALLOWED_SCRIPT_IMPORTERS.has(entry.name)) continue;
      const text = fs.readFileSync(path.join(SCRIPTS_DIR, entry.name), "utf8");
      if (/from\s+["'][^"']*phase3aPrepHarness[^"']*["']/.test(text)) {
        offenders.push(entry.name);
      }
    }
    assert.deepEqual(offenders, [],
      `Phase 3a-prep harness must not be imported by any script except the propose-only manual CLI runner. Offenders: ${offenders.join(", ")}`);
  });
});

// ── File-level isolation contract (drain template) ────────────────────────

describe("Track A — file-level isolation contract", () => {
  it("TMP_DIR is under os.tmpdir() and not under REPO_ROOT", () => {
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const tmpReal = fs.realpathSync(TMP_DIR);
    assert.ok(tmpReal.startsWith(tmpRoot));
    assert.equal(tmpReal.startsWith(REPO_ROOT), false);
  });

  it("env-var pin (DATA_DIR, DB_PATH) holds at file-level checkpoint", () => {
    assert.equal(process.env.DATA_DIR, TMP_DIR);
    assert.equal(process.env.DB_PATH, path.join(TMP_DIR, "test.db"));
  });

  it("live research_lab.json is unchanged at file-level checkpoint", () => {
    const a = snapshot(REAL_RESEARCH_LAB);
    assert.equal(a.exists, RESEARCH_SNAPSHOT.exists);
    if (RESEARCH_SNAPSHOT.exists) assert.equal(a.content, RESEARCH_SNAPSHOT.content);
  });

  it("live memory_knowledge.json is unchanged at file-level checkpoint", () => {
    const a = snapshot(REAL_MEMORY_KB);
    assert.equal(a.exists, MEMORY_SNAPSHOT.exists);
    if (MEMORY_SNAPSHOT.exists) assert.equal(a.content, MEMORY_SNAPSHOT.content);
  });

  it("live agent_goals.json is unchanged at file-level checkpoint", () => {
    const a = snapshot(REAL_AGENT_GOALS);
    assert.equal(a.exists, AGENT_GOALS_SNAPSHOT.exists);
    if (AGENT_GOALS_SNAPSHOT.exists) assert.equal(a.content, AGENT_GOALS_SNAPSHOT.content);
  });

  it("live competencyProfile.json is unchanged at file-level checkpoint", () => {
    const a = snapshot(REAL_COMPETENCY);
    assert.equal(a.exists, COMPETENCY_SNAPSHOT.exists);
    if (COMPETENCY_SNAPSHOT.exists) assert.equal(a.content, COMPETENCY_SNAPSHOT.content);
  });

  it("live experiment_decision_events.jsonl is unchanged at file-level checkpoint", () => {
    const a = snapshot(REAL_DECISION_LEDGER);
    assert.equal(a.exists, DECISION_LEDGER_SNAPSHOT.exists);
    if (DECISION_LEDGER_SNAPSHOT.exists) assert.equal(a.content, DECISION_LEDGER_SNAPSHOT.content);
  });

  it("live sandbox_registration_records.jsonl is unchanged at file-level checkpoint", () => {
    const a = snapshot(REPO_RECORDS_LEDGER);
    assert.equal(a.exists, REPO_RECORDS_SNAPSHOT.exists);
    if (REPO_RECORDS_SNAPSHOT.exists) assert.equal(a.content, REPO_RECORDS_SNAPSHOT.content);
  });

  it("live agent306.db is unchanged at file-level checkpoint (WAL-aware)", () => {
    // Under aggregate parallel runs sibling files write to live DB,
    // drifting mtime. Skip the per-file DB-stat check there; the
    // canonical end-of-suite check lives in
    // scripts/checkCoreStateIntegrity.sh. See PR #354.
    if (process.env.AGENT306_AGGREGATE_RUN === "1") return;
    const a = dbStat(REAL_DB);
    assert.equal(a.exists, DB_SNAPSHOT.exists);
    if (DB_SNAPSHOT.exists) {
      assert.equal(a.size,     DB_SNAPSHOT.size);
      assert.equal(a.mtimeMs,  DB_SNAPSHOT.mtimeMs);
    }
  });
});
