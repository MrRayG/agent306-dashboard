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
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "repositories-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

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
