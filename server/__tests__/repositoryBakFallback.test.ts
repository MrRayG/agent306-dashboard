/**
 * Repository .bak fallback tests.
 *
 * After the on-boot JSON→DB migration, the source JSON files are renamed to
 * `<name>.bak`. Engines that read through the repositories must transparently
 * resolve to the .bak when both the DB row and the live JSON are missing.
 *
 * This test pins the read-through walk DB → live JSON → JSON.bak so the
 * goals / competency / research repositories cannot silently regress to
 * empty defaults if a future refactor breaks the DB writer.
 *
 * Run: npx tsx --test server/__tests__/repositoryBakFallback.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { db } from "../db.js";
import {
  agentGoals,
  competencyProfileTable,
  researchLab,
} from "@shared/schema";
import { dataPath } from "../dataPaths.js";
import { readGoalsBlob } from "../repositories/goalRepository.js";
import { readCompetencyBlob } from "../repositories/competencyRepository.js";
import { readResearchBlob } from "../repositories/researchRepository.js";
import { readThrough } from "../repositories/jsonFallback.js";

function wipeAll() {
  try { db.delete(agentGoals).run(); } catch {}
  try { db.delete(competencyProfileTable).run(); } catch {}
  try { db.delete(researchLab).run(); } catch {}
}

function tryUnlink(p: string) { try { fs.unlinkSync(p); } catch {} }

describe("repository .bak fallback — DB empty + JSON renamed → recover from .bak", () => {
  const goalsJson = dataPath("agent_goals.json");
  const goalsBak  = `${goalsJson}.bak`;
  const competencyJson = dataPath("competencyProfile.json");
  const competencyBak  = `${competencyJson}.bak`;
  const researchJson = dataPath("research_lab.json");
  const researchBak  = `${researchJson}.bak`;

  beforeEach(() => {
    wipeAll();
    [goalsJson, goalsBak, competencyJson, competencyBak, researchJson, researchBak].forEach(tryUnlink);
  });
  afterEach(() => {
    [goalsJson, goalsBak, competencyJson, competencyBak, researchJson, researchBak].forEach(tryUnlink);
  });

  it("goalRepository falls back to agent_goals.json.bak when DB and live JSON are absent", () => {
    const payload = { goals: [{ id: "g_bak_1", title: "from-bak" }], stats: { total: 1, active: 1, achieved: 0 } };
    fs.writeFileSync(goalsBak, JSON.stringify(payload));
    const result = readGoalsBlob<typeof payload>();
    assert.deepEqual(result, payload);
  });

  it("competencyRepository falls back to competencyProfile.json.bak", () => {
    const payload = { competencies: [{ id: "self-integrity", currentLevel: 7 }], growthFocus: ["a", "b"] };
    fs.writeFileSync(competencyBak, JSON.stringify(payload));
    const result = readCompetencyBlob<typeof payload>();
    assert.deepEqual(result, payload);
  });

  it("researchRepository falls back to research_lab.json.bak", () => {
    const payload = { topics: ["t1"], hypotheses: [{ id: "h_bak_1" }], stats: { totalResearched: 3 } };
    fs.writeFileSync(researchBak, JSON.stringify(payload));
    const result = readResearchBlob<typeof payload>();
    assert.deepEqual(result, payload);
  });

  it("read order: live JSON beats .bak when both exist", () => {
    fs.writeFileSync(goalsJson, JSON.stringify({ goals: [{ id: "live" }] }));
    fs.writeFileSync(goalsBak,  JSON.stringify({ goals: [{ id: "stale" }] }));
    const result = readGoalsBlob<any>();
    assert.equal(result?.goals?.[0]?.id, "live");
  });

  it("readThrough shim itself resolves DB → live JSON → .bak", () => {
    const livePath = dataPath(`__readthrough_test_${Date.now()}.json`);
    const bakPath  = `${livePath}.bak`;
    try {
      // Only .bak present — read should return its contents.
      fs.writeFileSync(bakPath, JSON.stringify({ from: "bak" }));
      const result = readThrough<{ from: string }>({
        dbRead: () => null,
        jsonPath: livePath,
      });
      assert.deepEqual(result, { from: "bak" });
    } finally {
      tryUnlink(livePath);
      tryUnlink(bakPath);
    }
  });

  it("returns null when DB, live JSON, and .bak are all missing", () => {
    // No setup — every path absent.
    assert.equal(readGoalsBlob(), null);
    assert.equal(readCompetencyBlob(), null);
    assert.equal(readResearchBlob(), null);
  });
});
