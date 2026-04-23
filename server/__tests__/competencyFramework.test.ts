/**
 * Tests for competencyFramework — getCompetencyLevel and default-seeding
 * on an existing competencyProfile.json that predates a new DEFAULT_COMPETENCIES
 * entry.
 *
 * Run: npx tsx --test server/__tests__/competencyFramework.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

// Point DATA_DIR at a temp dir BEFORE importing anything that touches dataPaths.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "comp-fw-test-"));
process.env.DATA_DIR = TMP_DATA_DIR;

const PROFILE_FILE = path.join(TMP_DATA_DIR, "competencyProfile.json");

// Pre-seed a competencies file that is MISSING self-integrity and has a
// custom level for an existing competency. This simulates the production
// scenario described in the bug: an older profile file was loaded from the
// Railway volume, and self-integrity (added in a later PR) was never inserted.
fs.writeFileSync(
  PROFILE_FILE,
  JSON.stringify(
    {
      competencies: [
        {
          id: "storytelling",
          name: "Storytelling & Content Creation",
          category: "core",
          description: "old",
          indicators: [],
          currentLevel: 7, // custom level that must survive the merge
          growthPath: [],
        },
      ],
      growthFocus: ["storytelling"],
      lastFocusRotation: new Date().toISOString(),
      levelHistory: [],
      lastUpdated: new Date().toISOString(),
    },
    null,
    2,
  ),
);

describe("competencyFramework", () => {
  let getCompetencyLevel: typeof import("../competencyFramework.js").getCompetencyLevel;
  let getCompetencyProfile: typeof import("../competencyFramework.js").getCompetencyProfile;

  before(async () => {
    const mod = await import("../competencyFramework.js");
    getCompetencyLevel = mod.getCompetencyLevel;
    getCompetencyProfile = mod.getCompetencyProfile;
  });

  after(() => {
    try { fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch {}
  });

  it("loads self-integrity from DEFAULT_COMPETENCIES at level 5 when missing from stored profile", () => {
    const level = getCompetencyLevel("self-integrity");
    assert.equal(level, 5, "self-integrity should be seeded at default level 5 when absent from file");
  });

  it("preserves existing competency levels from the stored profile (does not overwrite)", () => {
    const level = getCompetencyLevel("storytelling");
    assert.equal(level, 7, "storytelling level from the stored file must survive the merge-with-defaults");
  });

  it("getCompetencyLevel returns null for unknown competency ids", () => {
    assert.equal(getCompetencyLevel("nonexistent-competency"), null);
  });

  it("getCompetencyLevel distinguishes missing (null) from a zero/low numeric level", () => {
    // Confirms the API contract the ledger-state log relies on:
    // a missing key is null, not 0 — callers can render "<missing>" vs "0.00".
    const known = getCompetencyLevel("self-integrity");
    const unknown = getCompetencyLevel("not-a-real-key");
    assert.equal(typeof known, "number");
    assert.equal(unknown, null);
  });

  it("profile exposes all DEFAULT_COMPETENCIES after load-merge", () => {
    const profile = getCompetencyProfile();
    const ids = new Set(profile.competencies.map(c => c.id));
    assert.ok(ids.has("self-integrity"), "self-integrity must be present after merge");
    assert.ok(ids.has("storytelling"), "storytelling must be present after merge");
  });
});
