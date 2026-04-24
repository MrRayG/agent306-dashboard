/**
 * Repositories round-trip tests (spec §4).
 *
 * Confirms each of the five repos writes and reads the blob identity. Also
 * asserts the read-through shim falls back to JSON when the DB is empty.
 *
 * Run: npx tsx --test server/__tests__/repositories.test.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { db } from "../db.js";
import {
  memoryKnowledge,
  memorySoul,
  memorySoulHistory,
  agentGoals,
  competencyProfileTable,
  researchLab,
} from "@shared/schema";
import { readMemoryKnowledgeBlob, writeMemoryKnowledgeBlob } from "../repositories/memoryRepository.js";
import { readSoulBlob, writeSoulBlob, getSoulHistory } from "../repositories/soulRepository.js";
import { readGoalsBlob, writeGoalsBlob } from "../repositories/goalRepository.js";
import { readCompetencyBlob, writeCompetencyBlob } from "../repositories/competencyRepository.js";
import { readResearchBlob, writeResearchBlob } from "../repositories/researchRepository.js";
import { dataPath } from "../dataPaths.js";

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
