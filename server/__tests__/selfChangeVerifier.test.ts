/**
 * Tests for the Self-Change Verifier — spec §2.4.
 *
 * Covers:
 *   - runVerificationPass transitions in_flight → verified when rule fired
 *     enough times AND produced at least one side effect.
 *   - runVerificationPass transitions open → failed when the acceptance
 *     window has elapsed without meeting the bar.
 *   - buildMetaReflectionContext returns non-empty text when there are
 *     recent failed commitments.
 *
 * Run: npx tsx --test server/__tests__/selfChangeVerifier.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import * as path from "path";
import * as os from "os";

// Phase 2n drain #9 — Path B root-cause investigation found that this test
// previously mutated live state via two paths:
//
//   1. server/dataPaths.ts captures DATA_DIR at import time. The original
//      test statically imported `dataPath` from "../dataPaths.js" at the
//      top of the file, so LEDGER_FILE / RULES_FILE resolved to the real
//      `data/` directory. Tests then wrote (and deleted) `insight_ledger.json`
//      and `enforcement_rules.json` directly in the repo's data/ tree.
//   2. server/competencyFramework.ts (transitively imported by
//      selfChangeVerifier via applySelfIntegrityCompetency) captured
//      `dataPath("competencyProfile.json")` at module-eval time. That's the
//      mutation "found via bisect" — runVerificationPass calls
//      applySelfIntegrityCompetency, which writes competencyProfile.json.
//      Confirmed via isolated run on raw main: data/competencyProfile.json
//      changed and data/agent306.db grew by 12288 bytes.
//
// Fix: redirect DATA_DIR and DB_PATH before any repo-module import, and
// resolve dataPath dynamically so it picks up the redirected DATA_DIR. The
// integrity guard only watches 4 files (competencyProfile.json being one);
// this drain also adds an isolation contract over the canonical 7 watched
// live-state files plus an explicit pin that insight_ledger.json and
// enforcement_rules.json never appear in the repo's data/ directory.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-d9-selfchange-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_DATA_DIR = path.join(REPO_ROOT, "data");

// 7 watched live-state files for the file-level isolation contract.
const REAL_RESEARCH_LAB = path.join(REAL_DATA_DIR, "research_lab.json");
const REAL_MEMORY_KB    = path.join(REAL_DATA_DIR, "memory_knowledge.json");
const REAL_AGENT_GOALS  = path.join(REAL_DATA_DIR, "agent_goals.json");
const REAL_COMPETENCY   = path.join(REAL_DATA_DIR, "competencyProfile.json");
const REAL_LEDGER       = path.join(REAL_DATA_DIR, "experiment_decision_events.jsonl");
const REAL_SANDBOX_REG  = path.join(REAL_DATA_DIR, "sandbox_registration_records.jsonl");
const REAL_DB           = path.join(REAL_DATA_DIR, "agent306.db");

// Additional Phase 2n drain #9 pins — the test's own write targets. The
// integrity guard does not watch these, but they should still live in TMP,
// not in data/.
const REPO_INSIGHT_LEDGER = path.join(REAL_DATA_DIR, "insight_ledger.json");
const REPO_RULES_FILE     = path.join(REAL_DATA_DIR, "enforcement_rules.json");

// Dynamic import of dataPath so it captures the redirected DATA_DIR set
// above. Resolves to TMP/insight_ledger.json and TMP/enforcement_rules.json.
const { dataPath } = await import("../dataPaths.js");

const LEDGER_FILE = dataPath("insight_ledger.json");
const RULES_FILE  = dataPath("enforcement_rules.json");

// Loud-failure pin executed at file-eval time: the resolved test paths must
// live under TMP, never under the real data/ directory. If this assertion
// ever fires it means DATA_DIR drifted between the env-var set above and the
// dynamic import of dataPath — fail before any test writes occur.
if (!LEDGER_FILE.startsWith(TMP) || !RULES_FILE.startsWith(TMP)) {
  throw new Error(
    `Phase 2n drain #9: dataPath did not honour redirected DATA_DIR. ` +
    `LEDGER_FILE=${LEDGER_FILE} RULES_FILE=${RULES_FILE} TMP=${TMP}`,
  );
}

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

// Snapshots used by the file-level isolation contract describe block at the
// bottom of this file. Captured in before() so they reflect repo state right
// when this test process starts running.
let researchLabBefore: string | null = null;
let memoryKbBefore:    string | null = null;
let agentGoalsBefore:  string | null = null;
let competencyBefore:  string | null = null;
let ledgerBefore:      string | null = null;
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

  researchLabBefore = readIfExists(REAL_RESEARCH_LAB);
  memoryKbBefore    = readIfExists(REAL_MEMORY_KB);
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
});

function clean() {
  try { if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE); } catch {}
  try { if (fs.existsSync(RULES_FILE)) fs.unlinkSync(RULES_FILE); } catch {}
}

function writeLedger(entries: any[]) {
  fs.writeFileSync(LEDGER_FILE, JSON.stringify({
    entries,
    lastCycleReflected: 0,
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

function writeRules(rules: any[]) {
  fs.writeFileSync(RULES_FILE, JSON.stringify({
    rules,
    lastUpdated: new Date().toISOString(),
  }, null, 2));
}

describe("SelfChangeVerifier", () => {
  beforeEach(clean);
  afterEach(clean);

  it("transitions in_flight → verified when fireCount >= 3 AND sideEffectCount >= 1", async () => {
    const now = Date.now();
    writeLedger([
      {
        id: "il_1",
        cycleNumber: 1,
        createdAt: now - 24 * 60 * 60 * 1000,
        insight: "Force a ratio",
        proposedAction: "per 10 kb entries force 1 synthesis",
        sourceId: "src1",
        status: "in_flight",
        acceptedAt: now - 2 * 24 * 60 * 60 * 1000,
        retryCount: 0,
        ruleId: "rule_a",
      },
    ]);
    writeRules([
      {
        id: "rule_a",
        insightId: "il_1",
        primitive: "ratio_rule",
        params: {},
        criterion: "ratio(synthesis/kb_entry) >= 1/10",
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
        enabled: true,
        fireCount: 5,
        lastFiredAt: now - 60_000,
        sideEffectCount: 2,
      },
    ]);

    const { runVerificationPass } = await import("../selfChangeVerifier.js");
    const result = runVerificationPass();
    assert.equal(result.verified, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.stillOpen, 0);

    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const e = ledger.entries.find((x: any) => x.id === "il_1");
    assert.equal(e.status, "verified");
    assert.ok(e.verifiedAt);
  });

  it("transitions open → failed when window elapsed with zero fires", async () => {
    const now = Date.now();
    const longAgo = now - 20 * 24 * 60 * 60 * 1000; // > 14 day window
    writeLedger([
      {
        id: "il_2",
        cycleNumber: 2,
        createdAt: longAgo,
        insight: "TTL on hypotheses",
        proposedAction: "14-day TTL on testing hypotheses",
        sourceId: "src2",
        status: "accepted",
        acceptedAt: longAgo,
        retryCount: 0,
        ruleId: "rule_b",
      },
    ]);
    writeRules([
      {
        id: "rule_b",
        insightId: "il_2",
        primitive: "ttl_rule",
        params: {},
        criterion: "",
        createdAt: longAgo,
        enabled: true,
        fireCount: 0,
        lastFiredAt: null,
        sideEffectCount: 0,
      },
    ]);

    const { runVerificationPass } = await import("../selfChangeVerifier.js");
    const result = runVerificationPass();
    assert.equal(result.failed, 1);

    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const e = ledger.entries.find((x: any) => x.id === "il_2");
    assert.equal(e.status, "failed");
    assert.match(e.selfChangeFailureReason ?? "", /never fired|rule fired/);
  });

  it("keeps commitments open when rule is firing but hasn't met the bar yet", async () => {
    const now = Date.now();
    writeLedger([
      {
        id: "il_3",
        cycleNumber: 3,
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
        insight: "partial",
        proposedAction: "x",
        sourceId: "src3",
        status: "in_flight",
        acceptedAt: now - 2 * 24 * 60 * 60 * 1000,
        retryCount: 0,
        ruleId: "rule_c",
      },
    ]);
    writeRules([
      {
        id: "rule_c",
        insightId: "il_3",
        primitive: "ratio_rule",
        params: {},
        criterion: "",
        createdAt: now - 2 * 24 * 60 * 60 * 1000,
        enabled: true,
        fireCount: 1,        // below threshold
        lastFiredAt: now - 60_000,
        sideEffectCount: 0,  // below threshold
      },
    ]);

    const { runVerificationPass } = await import("../selfChangeVerifier.js");
    const result = runVerificationPass();
    assert.equal(result.verified, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.stillOpen, 1);

    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const e = ledger.entries.find((x: any) => x.id === "il_3");
    assert.equal(e.status, "in_flight", "entry should remain in_flight");
  });

  it("buildMetaReflectionContext returns non-empty text when failed commitments exist", async () => {
    const now = Date.now();
    writeLedger([
      {
        id: "il_f1",
        cycleNumber: 1,
        createdAt: now - 3 * 24 * 60 * 60 * 1000,
        insight: "I will force one synthesis per 10 KB entries",
        proposedAction: "ratio",
        sourceId: "src_f1",
        status: "failed",
        failedAt: now - 60 * 60 * 1000,
        retryCount: 0,
        selfChangeFailureReason: "rule registered but never fired",
      },
    ]);
    writeRules([]);

    const { buildMetaReflectionContext } = await import("../selfChangeVerifier.js");
    const text = buildMetaReflectionContext();
    assert.ok(text.length > 0);
    assert.match(text, /SELF-CHANGE TRACK RECORD/);
    assert.match(text, /Broken/);
    assert.match(text, /synthesis per 10 KB/);
  });

  it("buildMetaReflectionContext handles empty ledger gracefully", async () => {
    writeLedger([]);
    writeRules([]);
    const { buildMetaReflectionContext } = await import("../selfChangeVerifier.js");
    const text = buildMetaReflectionContext();
    assert.match(text, /SELF-CHANGE TRACK RECORD/);
    // No closed items → no "Broken" section
    assert.doesNotMatch(text, /Broken \(/);
  });
});

// ── File-level isolation contract ────────────────────────────────────────────
//
// Phase 2n drain #9 — mirrors the contract added by drains #1–#8. Asserts
// that after every test in this file runs, none of the 7 watched live-state
// files under repo `data/` have been touched, env-var redirects are still
// pinned, and the test's own write targets (insight_ledger.json,
// enforcement_rules.json) never appear in repo data/. This block also
// strengthens the SAFETY-CRITICAL fix for the bisect finding: the path
// runVerificationPass → applySelfIntegrityCompetency → competencyFramework
// can no longer mutate competencyProfile.json now that DATA_DIR is
// redirected before any repo-module import.

describe("selfChangeVerifier.test.ts — file-level isolation contract", () => {
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

  it("competencyProfile.json is unchanged (SAFETY-CRITICAL — bisect finding)", () => {
    assert.equal(readIfExists(REAL_COMPETENCY), competencyBefore);
  });

  it("experiment_decision_events.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_LEDGER), ledgerBefore);
  });

  it("sandbox_registration_records.jsonl is unchanged", () => {
    assert.equal(readIfExists(REAL_SANDBOX_REG), sandboxRegBefore);
  });

  it("agent306.db is unchanged (size + mtime)", () => {
    if (dbSizeBefore === null) {
      assert.equal(fs.existsSync(REAL_DB), false, "agent306.db should not have been created");
      return;
    }
    assert.ok(fs.existsSync(REAL_DB), "agent306.db must still exist");
    const st = fs.statSync(REAL_DB);
    assert.equal(st.size, dbSizeBefore, "agent306.db size changed");
    assert.equal(st.mtimeMs, dbMtimeBefore, "agent306.db mtime changed (WAL-aware check)");
  });

  it("insight_ledger.json does NOT exist in repo data/ (test's own write target)", () => {
    assert.equal(fs.existsSync(REPO_INSIGHT_LEDGER), false,
      "Phase 2n drain #9: insight_ledger.json leaked into repo data/ — DATA_DIR redirect failed");
  });

  it("enforcement_rules.json does NOT exist in repo data/ (test's own write target)", () => {
    assert.equal(fs.existsSync(REPO_RULES_FILE), false,
      "Phase 2n drain #9: enforcement_rules.json leaked into repo data/ — DATA_DIR redirect failed");
  });
});
