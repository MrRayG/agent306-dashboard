/**
 * Migration safety guard tests.
 *
 * Spec §4 ships an on-boot JSON→DB migration that, after copying each blob
 * into SQLite, renames the source JSON to `<name>.bak` so the read-through
 * shim prefers the DB. PR #217 ran this on every Docker boot and the
 * 2026-04-25 audit caught the failure mode: if the DB write silently failed
 * (e.g., a future repo refactor breaks the importer) the JSON would still
 * be renamed and the engine would see empty defaults — silent data loss.
 *
 * The guard added here is "verify the row exists with a non-empty blob
 * BEFORE renaming." These tests pin that invariant directly against the
 * repositories' `*RowExists` helpers.
 *
 * Run: npx tsx --test server/__tests__/migrationOrphanGuard.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import {
  agentGoals,
  competencyProfileTable,
  researchLab,
  memoryKnowledge,
  memorySoul,
  memorySoulHistory,
} from "@shared/schema";
import {
  goalsRowExists,
  writeGoalsBlob,
} from "../repositories/goalRepository.js";
import {
  competencyRowExists,
  writeCompetencyBlob,
} from "../repositories/competencyRepository.js";
import {
  researchRowExists,
  writeResearchBlob,
} from "../repositories/researchRepository.js";
import {
  memoryKnowledgeRowExists,
  writeMemoryKnowledgeBlob,
} from "../repositories/memoryRepository.js";
import {
  soulRowExists,
  writeSoulBlob,
} from "../repositories/soulRepository.js";

function wipe() {
  try { db.delete(memoryKnowledge).run(); } catch {}
  try { db.delete(memorySoul).run(); } catch {}
  try { db.delete(memorySoulHistory).run(); } catch {}
  try { db.delete(agentGoals).run(); } catch {}
  try { db.delete(competencyProfileTable).run(); } catch {}
  try { db.delete(researchLab).run(); } catch {}
}

describe("migration orphan guard — *RowExists helpers", () => {
  beforeEach(wipe);

  it("goalsRowExists is false when the table is empty", () => {
    assert.equal(goalsRowExists(), false);
  });

  it("goalsRowExists is true after a write", () => {
    writeGoalsBlob({ goals: [{ id: "g1", title: "x" }] });
    assert.equal(goalsRowExists(), true);
  });

  it("competencyRowExists is false when the table is empty", () => {
    assert.equal(competencyRowExists(), false);
  });

  it("competencyRowExists is true after a write", () => {
    writeCompetencyBlob({ competencies: [{ id: "c1", currentLevel: 5 }] });
    assert.equal(competencyRowExists(), true);
  });

  it("researchRowExists is false when the table is empty", () => {
    assert.equal(researchRowExists(), false);
  });

  it("researchRowExists is true after a write", () => {
    writeResearchBlob({ topics: ["a"] });
    assert.equal(researchRowExists(), true);
  });

  it("memoryKnowledgeRowExists / soulRowExists round-trip", () => {
    assert.equal(memoryKnowledgeRowExists(), false);
    assert.equal(soulRowExists(), false);
    writeMemoryKnowledgeBlob({ entries: [{ id: "x" }] });
    writeSoulBlob({ version: 1, identity: { name: "Agent 306" } }, "test");
    assert.equal(memoryKnowledgeRowExists(), true);
    assert.equal(soulRowExists(), true);
  });

  it("rename guard logic — when verify() is false, do NOT rename", () => {
    // Reproduce the migrate script's decision branch in isolation. We do
    // NOT shell out to the migrate script here because (a) it relies on
    // env / disk paths and (b) we want to pin the policy itself, not the
    // file rename plumbing.
    function shouldRenameAfterImport(importReturned: boolean, verifyResult: boolean): boolean {
      if (!importReturned) return false;
      if (!verifyResult) return false;
      return true;
    }
    // Case A: import truthy, row populated → rename allowed.
    writeGoalsBlob({ goals: [{ id: "g1" }] });
    assert.equal(shouldRenameAfterImport(true, goalsRowExists()), true);
    // Case B: import truthy, but row empty (the orphan failure mode) → no rename.
    wipe();
    assert.equal(shouldRenameAfterImport(true, goalsRowExists()), false);
    // Case C: import falsy (no JSON) → no rename, irrespective of row state.
    assert.equal(shouldRenameAfterImport(false, true), false);
  });
});
