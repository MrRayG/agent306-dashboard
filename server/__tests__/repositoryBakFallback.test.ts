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
 * --- Test isolation contract (Issue #332 drain) ---
 *
 * The assertions below intentionally **delete** core agent-state files
 * (`agent_goals.json`, `competencyProfile.json`, `research_lab.json`) and
 * **wipe** their DB tables to set up the "DB empty + live JSON absent"
 * scenario the .bak fallback resolves.
 *
 * To run that scenario without mutating the repository's live data files
 * or live SQLite database, this file redirects `DATA_DIR` and `DB_PATH` to
 * a per-process tmpdir BEFORE any module that captures those paths at
 * import time is loaded. `server/dataPaths.ts` and `server/db.ts` both
 * read `process.env.DATA_DIR` / `process.env.DB_PATH` once at module
 * evaluation, so the env vars must be set first, and the modules under
 * test must be loaded via dynamic `await import()`.
 *
 * A final `after()` hook asserts the repository's live core-state files
 * are byte-identical to their pre-test snapshot, so any future regression
 * that re-introduces a write to the real `data/` directory is caught here
 * rather than by the CI integrity guard.
 *
 * Run: npx tsx --test server/__tests__/repositoryBakFallback.test.ts
 */

import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── isolation setup — must happen BEFORE any import of db / dataPaths / repos ───
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "repository-bak-fallback-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

// Snapshot the live core-state files so we can assert byte-equality at the end.
// We resolve paths relative to the project root, not via dataPath() (which now
// points at TMP after the env redirect above).
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_AGENT_GOALS  = path.join(REPO_ROOT, "data", "agent_goals.json");
const REAL_COMPETENCY   = path.join(REPO_ROOT, "data", "competencyProfile.json");
const REAL_AGENT_DB     = path.join(REPO_ROOT, "data", "agent306.db");

function snapshot(p: string): { exists: boolean; content?: Buffer } {
  if (!fs.existsSync(p)) return { exists: false };
  return { exists: true, content: fs.readFileSync(p) };
}

const PRE_SNAPSHOTS = {
  researchLab: snapshot(REAL_RESEARCH_LAB),
  agentGoals:  snapshot(REAL_AGENT_GOALS),
  competency:  snapshot(REAL_COMPETENCY),
  // We snapshot the DB by size+mtime rather than full content (it can be large
  // and the WAL journal makes byte-equality flaky). The point is to detect
  // accidental writes, not to byte-pin the DB.
  agentDb: fs.existsSync(REAL_AGENT_DB)
    ? { exists: true as const, size: fs.statSync(REAL_AGENT_DB).size, mtimeMs: fs.statSync(REAL_AGENT_DB).mtimeMs }
    : { exists: false as const },
};

// Dynamic imports — these modules read DATA_DIR / DB_PATH at evaluation time,
// so they must load AFTER the env redirect above.
const { db } = await import("../db.js");
const {
  agentGoals,
  competencyProfileTable,
  researchLab,
} = await import("@shared/schema");
const { dataPath } = await import("../dataPaths.js");
const { readGoalsBlob }      = await import("../repositories/goalRepository.js");
const { readCompetencyBlob } = await import("../repositories/competencyRepository.js");
const { readResearchBlob }   = await import("../repositories/researchRepository.js");
const { readThrough }        = await import("../repositories/jsonFallback.js");

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

  before(() => {
    // Isolation pin: every dataPath() we operate on must live under TMP, not
    // under the project's real data/ directory. If a future refactor makes
    // dataPaths.ts cache its DATA_DIR before our env redirect can take effect,
    // this assertion catches it before the test can damage live state.
    assert.equal(goalsJson.startsWith(TMP), true, `goalsJson must be under TMP, got ${goalsJson}`);
    assert.equal(competencyJson.startsWith(TMP), true, `competencyJson must be under TMP, got ${competencyJson}`);
    assert.equal(researchJson.startsWith(TMP), true, `researchJson must be under TMP, got ${researchJson}`);
  });

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
    // Defense-in-depth: the readThrough order is DB → live JSON → .bak, so
    // this test depends on the DB row being absent when it runs. wipeAll()
    // covers that in beforeEach via drizzle, but CI has surfaced a flaky
    // ordering case (PR #307 follow-up) where a residual row from an
    // earlier test file's writeGoalsBlob reaches this assertion. Re-wipe
    // inline using raw SQL too, so we do not depend on a single delete
    // path. This is a test-only safeguard and changes nothing about the
    // production read order.
    try { db.delete(agentGoals).run(); } catch {}
    try { (db as any).$client?.exec?.("DELETE FROM agent_goals"); } catch {}
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

describe("repositoryBakFallback isolation contract — live core state untouched", () => {
  after(() => {
    // Clean up the per-process tmpdir.
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it("live data/research_lab.json is byte-identical to the pre-test snapshot", () => {
    const post = snapshot(REAL_RESEARCH_LAB);
    assert.equal(post.exists, PRE_SNAPSHOTS.researchLab.exists,
      "research_lab.json existence flipped during the test run");
    if (post.exists && PRE_SNAPSHOTS.researchLab.exists) {
      assert.equal(
        post.content!.equals(PRE_SNAPSHOTS.researchLab.content!),
        true,
        "research_lab.json was mutated by the test run",
      );
    }
  });

  it("live data/agent_goals.json is byte-identical to the pre-test snapshot", () => {
    const post = snapshot(REAL_AGENT_GOALS);
    assert.equal(post.exists, PRE_SNAPSHOTS.agentGoals.exists,
      "agent_goals.json existence flipped during the test run");
    if (post.exists && PRE_SNAPSHOTS.agentGoals.exists) {
      assert.equal(
        post.content!.equals(PRE_SNAPSHOTS.agentGoals.content!),
        true,
        "agent_goals.json was mutated by the test run",
      );
    }
  });

  it("live data/competencyProfile.json is byte-identical to the pre-test snapshot", () => {
    const post = snapshot(REAL_COMPETENCY);
    assert.equal(post.exists, PRE_SNAPSHOTS.competency.exists,
      "competencyProfile.json existence flipped during the test run");
    if (post.exists && PRE_SNAPSHOTS.competency.exists) {
      assert.equal(
        post.content!.equals(PRE_SNAPSHOTS.competency.content!),
        true,
        "competencyProfile.json was mutated by the test run",
      );
    }
  });

  it("live data/agent306.db size and mtime are unchanged", () => {
    // We pin size+mtime rather than byte-equality: the DB file can be large
    // and SQLite's WAL journal makes a strict byte-pin flaky. Either field
    // changing indicates an unintended write.
    if (!PRE_SNAPSHOTS.agentDb.exists) {
      assert.equal(fs.existsSync(REAL_AGENT_DB), false,
        "agent306.db appeared during the test run (was absent at start)");
      return;
    }
    assert.equal(fs.existsSync(REAL_AGENT_DB), true,
      "agent306.db disappeared during the test run");
    const post = fs.statSync(REAL_AGENT_DB);
    assert.equal(post.size, PRE_SNAPSHOTS.agentDb.size,
      "agent306.db size changed during the test run");
    assert.equal(post.mtimeMs, PRE_SNAPSHOTS.agentDb.mtimeMs,
      "agent306.db mtime changed during the test run");
  });

  it("the test's DATA_DIR / DB_PATH redirect points outside the project's data/ directory", () => {
    // Belt-and-suspenders: confirm the env var was honored. If a future
    // contributor accidentally removes the redirect block at the top of
    // this file, this assertion fails loudly instead of silently
    // re-introducing the live-state regression.
    const realDataDir = path.join(REPO_ROOT, "data");
    assert.equal(
      TMP.startsWith(realDataDir),
      false,
      `TMP (${TMP}) must NOT be under the real data/ directory (${realDataDir})`,
    );
    assert.equal(process.env.DATA_DIR, TMP, "DATA_DIR drifted from TMP during the test run");
    assert.equal(
      process.env.DB_PATH,
      path.join(TMP, "test.db"),
      "DB_PATH drifted from the test tmpdir during the test run",
    );
  });
});
