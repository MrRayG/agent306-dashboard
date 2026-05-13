/**
 * Repositories round-trip tests (spec §4).
 *
 * Confirms each of the five repos writes and reads the blob identity. Also
 * asserts the read-through shim falls back to JSON when the DB is empty.
 *
 * Run: npx tsx --test server/__tests__/repositories.test.ts
 *
 * Per-process DB / DATA_DIR isolation. Same pattern as
 * `claimVerifier.golden.test.ts` (PR #299): under the aggregate `npm test`
 * runner, files run as parallel subprocesses against a shared
 * `data/agent306.db`. Sibling test files (`repositoryBakFallback.test.ts`,
 * `migrationOrphanGuard.test.ts`, `goalEngine.test.ts`) wipe / re-insert
 * `agent_goals`, and the cross-process timing window can leave this test's
 * `goalRepository round-trips a blob` reading `null` in the brief instant
 * between its `writeGoalsBlob` and `readGoalsBlob`. Pointing `DB_PATH` and
 * `DATA_DIR` at a per-process tmpdir scopes the lock and the read-through
 * resolution to this test only — production behavior is unchanged.
 *
 * Phase 2n drain #15 — template hardening:
 *   The file already routed DATA_DIR + DB_PATH before importing db.ts /
 *   dataPaths.ts (correct module-eval-timing). Pre-fix isolated run was
 *   clean (no mutation of any of the 7 watched targets) — the quarantine
 *   was the aggregate-parallel-race described above, not a per-file
 *   isolation bug. This drain upgrades it to the canonical drain
 *   template (loud-failure pin, 7-file snapshots, after() hook diff,
 *   8-assertion contract block) so the file matches drains #2–#14.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain15-repositories-test-"));
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
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
  // Loud-failure pin (drain template).
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const tmpReal = fs.realpathSync(TMP_DIR);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`repositories isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`repositories isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP_DIR) {
    throw new Error(`repositories isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP_DIR, "test.db")) {
    throw new Error(`repositories isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
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
      if (!a.exists) throw new Error(`repositories tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`repositories tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`repositories tests created live ${label}!`);
    }
  }

  const dbAfter = dbStat(REAL_DB);
  if (DB_SNAPSHOT.exists) {
    if (!dbAfter.exists) throw new Error(`repositories tests removed live agent306.db!`);
    if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
      throw new Error(`repositories tests mutated live agent306.db (size/mtime changed)!`);
    }
  } else if (dbAfter.exists) {
    throw new Error(`repositories tests created live agent306.db!`);
  }
});

// Dynamic imports so DB_PATH / DATA_DIR above are in place before
// `server/db.ts` and `server/dataPaths.ts` evaluate (static ESM imports
// would be hoisted and miss them).
const { db } = await import("../db.js");
const {
  memoryKnowledge,
  memorySoul,
  memorySoulHistory,
  agentGoals,
  competencyProfileTable,
  researchLab,
} = await import("@shared/schema");
const { readMemoryKnowledgeBlob, writeMemoryKnowledgeBlob } = await import("../repositories/memoryRepository.js");
const { readSoulBlob, writeSoulBlob, getSoulHistory } = await import("../repositories/soulRepository.js");
const { readGoalsBlob, writeGoalsBlob } = await import("../repositories/goalRepository.js");
const { readCompetencyBlob, writeCompetencyBlob } = await import("../repositories/competencyRepository.js");
const { readResearchBlob, writeResearchBlob } = await import("../repositories/researchRepository.js");
const { dataPath } = await import("../dataPaths.js");

function wipe() {
  try { db.delete(memoryKnowledge).run(); } catch {}
  try { db.delete(memorySoul).run(); } catch {}
  try { db.delete(memorySoulHistory).run(); } catch {}
  try { db.delete(agentGoals).run(); } catch {}
  try { db.delete(competencyProfileTable).run(); } catch {}
  try { db.delete(researchLab).run(); } catch {}
}

describe("repositories — round-trip", () => {
  before(wipe);
  beforeEach(wipe);

  it("memoryRepository round-trips a blob", () => {
    const blob = { entries: [{ id: "a" }, { id: "b" }], totalEntries: 2 };
    writeMemoryKnowledgeBlob(blob);
    const read = readMemoryKnowledgeBlob<typeof blob>();
    assert.deepEqual(read, blob);
  });

  it("goalRepository round-trips a blob", () => {
    const blob = { goals: [{ id: "g1", title: "x" }] };
    writeGoalsBlob(blob);
    assert.deepEqual(readGoalsBlob(), blob);
  });

  it("competencyRepository round-trips a blob", () => {
    const blob = { competencies: [{ id: "c1", name: "comm", currentLevel: 5 }] };
    writeCompetencyBlob(blob);
    assert.deepEqual(readCompetencyBlob(), blob);
  });

  it("researchRepository round-trips a blob", () => {
    const blob = { topics: [], hypotheses: [{ id: "h1" }] };
    writeResearchBlob(blob);
    assert.deepEqual(readResearchBlob(), blob);
  });

  it("soulRepository round-trips and grows history on each write", () => {
    const v1 = { version: 1, identity: { name: "Agent 306" } };
    writeSoulBlob(v1, "first");
    const v2 = { version: 2, identity: { name: "Agent 306" } };
    writeSoulBlob(v2, "bump");

    assert.deepEqual(readSoulBlob(), v2);
    const history = getSoulHistory();
    assert.equal(history.length, 2);
    assert.equal(history[0].version, 2);
    assert.equal(history[0].reason, "bump");
    assert.equal(history[1].version, 1);
    assert.equal(history[1].reason, "first");
  });

  it("read-through falls back to JSON when the DB is empty", async () => {
    const testKey = `test_readthrough_${Date.now()}`;
    const jsonPath = dataPath(`${testKey}.json`);
    const payload = { x: 42 };
    fs.writeFileSync(jsonPath, JSON.stringify(payload));
    try {
      const { readThrough } = await import("../repositories/jsonFallback.js");
      const result = readThrough({
        dbRead: () => null,
        jsonPath,
      });
      assert.deepEqual(result, payload);
    } finally {
      try { fs.unlinkSync(jsonPath); } catch {}
    }
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#14. Drain #15 is template
// hardening: the file already routed DATA_DIR + DB_PATH before importing
// db.ts / dataPaths.ts (correct module-eval-timing) and the pre-fix
// isolated run was clean. This contract block upgrades it to the canonical
// drain template so it matches drains #2–#14.
describe("repositories — file-level isolation contract", () => {
  it("DATA_DIR is redirected to this run's tmpdir", () => {
    assert.equal(process.env.DATA_DIR, TMP_DIR, "DATA_DIR must point at this run's TMP");
    const tmpRoot = fs.realpathSync(os.tmpdir());
    assert.ok(fs.realpathSync(TMP_DIR).startsWith(tmpRoot), "TMP must live under os.tmpdir()");
    assert.ok(!fs.realpathSync(TMP_DIR).startsWith(REPO_ROOT), "TMP must NOT live under repo root");
    assert.equal(process.env.DB_PATH, path.join(TMP_DIR, "test.db"), "DB_PATH must point at TMP/test.db");
  });

  const watched: Array<[string, { exists: boolean; content?: string }, string]> = [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ];
  for (const [label, before, p] of watched) {
    it(`live ${label} is unchanged at file-level checkpoint`, () => {
      const cur = snapshot(p);
      if (before.exists) {
        assert.ok(cur.exists, `live ${label} disappeared`);
        assert.equal(cur.content, before.content, `live ${label} mutated`);
      } else {
        assert.equal(cur.exists, false, `live ${label} was created`);
      }
    });
  }

  it("live agent306.db is unchanged at file-level checkpoint (WAL-aware)", () => {
    const cur = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      assert.ok(cur.exists, "live agent306.db disappeared");
      assert.equal(cur.size, DB_SNAPSHOT.size, "agent306.db size changed");
      assert.equal(cur.mtimeMs, DB_SNAPSHOT.mtimeMs, "agent306.db mtime changed");
    } else {
      assert.equal(cur.exists, false, "live agent306.db was created");
    }
  });
});
