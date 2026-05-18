/**
 * First-run-only JSON→DB import guard.
 *
 * Regression coverage for the 2026-05-18 production incident: every Docker
 * boot ran `node dist/migrate.cjs`, which called `importResearchFromJson()`.
 * That function unconditionally wrote `research_lab.json` (or `.json.bak`
 * after the first run) into the SQLite `research_lab[id=main].blob` row,
 * silently reverting any DB-side mutation an operator had applied — e.g.
 * the DB-aware hypothesis archive reset. The dashboard would show the
 * cleanup, the next deploy/restart would erase it, and the audit a week
 * later would surface the regression.
 *
 * The fix makes each `importXFromJson()` first-run-only: if the DB row
 * already exists with a non-empty blob, the function returns
 * `"skipped-existing-db"` and does NOT touch the DB. The on-boot
 * migration becomes a no-op for every subsequent boot.
 *
 * This file pins:
 *   1. The guard short-circuits BEFORE reading JSON/.bak (no overwrite).
 *   2. First-run import still works when the DB row is missing.
 *   3. `.bak` is still acceptable as a first-run source.
 *   4. Subsequent calls with a stale `.bak` present DO NOT revert the DB.
 *
 * Run: npx tsx --test server/__tests__/migrationFirstRunGuard.test.ts
 */

import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── isolation: redirect DATA_DIR + DB_PATH BEFORE any module that captures them ───
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "migration-first-run-guard-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_RESEARCH_BAK = path.join(REPO_ROOT, "data", "research_lab.json.bak");
const REAL_DB           = path.join(REPO_ROOT, "data", "agent306.db");

function snap(p: string): { exists: boolean; size?: number; mtimeMs?: number; content?: Buffer } {
  if (!fs.existsSync(p)) return { exists: false };
  const st = fs.statSync(p);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs, content: fs.readFileSync(p) };
}
const PRE_SNAPSHOTS = {
  researchLab: snap(REAL_RESEARCH_LAB),
  researchBak: snap(REAL_RESEARCH_BAK),
  agentDb:     snap(REAL_DB),
};

const { db } = await import("../db.js");
const {
  agentGoals,
  competencyProfileTable,
  memoryKnowledge,
  memorySoul,
  memorySoulHistory,
  researchLab,
} = await import("@shared/schema");
const { dataPath } = await import("../dataPaths.js");
const {
  importResearchFromJson,
  readResearchBlob,
  writeResearchBlob,
  researchRowExists,
} = await import("../repositories/researchRepository.js");
const {
  importMemoryKnowledgeFromJson,
  writeMemoryKnowledgeBlob,
  memoryKnowledgeRowExists,
} = await import("../repositories/memoryRepository.js");
const {
  importGoalsFromJson,
  writeGoalsBlob,
  goalsRowExists,
} = await import("../repositories/goalRepository.js");
const {
  importCompetencyFromJson,
  writeCompetencyBlob,
  competencyRowExists,
} = await import("../repositories/competencyRepository.js");
const {
  importSoulFromJson,
  writeSoulBlob,
  soulRowExists,
} = await import("../repositories/soulRepository.js");

function wipe() {
  try { db.delete(memoryKnowledge).run(); } catch {}
  try { db.delete(memorySoul).run(); } catch {}
  try { db.delete(memorySoulHistory).run(); } catch {}
  try { db.delete(agentGoals).run(); } catch {}
  try { db.delete(competencyProfileTable).run(); } catch {}
  try { db.delete(researchLab).run(); } catch {}
}
function tryUnlink(p: string) { try { fs.unlinkSync(p); } catch {} }

const researchJson = dataPath("research_lab.json");
const researchBak  = `${researchJson}.bak`;
const memoryJson   = dataPath("memory_knowledge.json");
const memoryBak    = `${memoryJson}.bak`;
const goalsJson    = dataPath("agent_goals.json");
const goalsBak     = `${goalsJson}.bak`;
const competencyJson = dataPath("competencyProfile.json");
const competencyBak  = `${competencyJson}.bak`;
const soulJson     = dataPath("memory_soul.json");
const soulBak      = `${soulJson}.bak`;

function cleanupAllFiles() {
  [researchJson, researchBak,
   memoryJson, memoryBak,
   goalsJson, goalsBak,
   competencyJson, competencyBak,
   soulJson, soulBak].forEach(tryUnlink);
}

describe("first-run-only JSON→DB import — DB row preserved across reboot", () => {
  before(() => {
    // Tripwire: if a future refactor caches DATA_DIR before our redirect
    // takes effect, this assertion fires before the test damages real data.
    assert.equal(researchJson.startsWith(TMP), true,
      `researchJson must be under TMP, got ${researchJson}`);
  });

  beforeEach(() => { wipe(); cleanupAllFiles(); });
  afterEach(() => { cleanupAllFiles(); });

  it("research_lab: with DB row populated, importResearchFromJson is a no-op even with a stale .bak", () => {
    // Operator applied a DB-only mutation (e.g. archive reset) — this is
    // what the dashboard's apply path writes via writeResearchBlob.
    const dbState = { topics: [], hypotheses: [{ id: "h_archived_in_db", status: "archived" }] };
    writeResearchBlob(dbState);

    // The migration's input source: a stale `.bak` that does NOT have the
    // archive tag. Pre-fix, the next boot would silently overwrite the DB
    // with this content.
    const staleBak = { topics: [], hypotheses: [{ id: "h_archived_in_db", status: "confirmed" }] };
    fs.writeFileSync(researchBak, JSON.stringify(staleBak));

    const result = importResearchFromJson();
    assert.equal(result, "skipped-existing-db",
      "import must short-circuit when DB row exists with a non-empty blob");

    // The DB row is unchanged — the archive_stale tag survives.
    const after = readResearchBlob<{ hypotheses: Array<{ status: string }> }>();
    assert.deepEqual(after, dbState,
      "DB blob must be byte-identical after the import was skipped");
    assert.equal((after?.hypotheses?.[0] as any)?.status, "archived");
  });

  it("research_lab: first-run import still works when DB row is missing (no JSON, .bak only)", () => {
    // DB is empty. No live JSON. Only `.bak` present — that's the post-
    // migration steady state on first boot after the `.bak` rename. The
    // guard must allow this case to seed the DB.
    assert.equal(researchRowExists(), false);
    const seed = { topics: [], hypotheses: [{ id: "seed_h" }] };
    fs.writeFileSync(researchBak, JSON.stringify(seed));

    const result = importResearchFromJson();
    assert.equal(result, "imported");
    assert.equal(researchRowExists(), true);

    const after = readResearchBlob<typeof seed>();
    assert.deepEqual(after, seed);
  });

  it("research_lab: first-run import still works when DB row is missing (live JSON only)", () => {
    assert.equal(researchRowExists(), false);
    const seed = { topics: [], hypotheses: [{ id: "live_h" }] };
    fs.writeFileSync(researchJson, JSON.stringify(seed));

    const result = importResearchFromJson();
    assert.equal(result, "imported");
    const after = readResearchBlob<typeof seed>();
    assert.deepEqual(after, seed);
  });

  it("research_lab: returns skipped-no-source when neither JSON nor .bak is present (and DB is empty)", () => {
    assert.equal(researchRowExists(), false);
    const result = importResearchFromJson();
    assert.equal(result, "skipped-no-source");
    assert.equal(researchRowExists(), false);
  });

  it("research_lab: simulated boot loop — repeated import calls with stale .bak do NOT revert DB", () => {
    // The actual production failure mode: deploy A applies a DB mutation,
    // deploy B's boot runs migrate.cjs and overwrites it, dashboard shows
    // reverted state. We simulate three consecutive boots and assert the
    // operator's DB state survives all of them.
    const dbState = {
      topics: [],
      hypotheses: [
        { id: "h1", status: "archived" },
        { id: "h2", status: "archived" },
      ],
    };
    writeResearchBlob(dbState);
    fs.writeFileSync(researchBak, JSON.stringify({
      topics: [],
      hypotheses: [
        { id: "h1", status: "confirmed" },
        { id: "h2", status: "confirmed" },
      ],
    }));

    for (let boot = 0; boot < 3; boot++) {
      const r = importResearchFromJson();
      assert.equal(r, "skipped-existing-db", `boot ${boot} must skip`);
    }
    const after = readResearchBlob<typeof dbState>();
    assert.deepEqual(after, dbState, "DB blob must survive three simulated boots");
  });

  it("all five repositories honor the first-run guard symmetrically", () => {
    // Populate every repo with a marker DB row, then stage stale .bak files
    // that should NEVER win. All five imports must report skipped-existing-db.
    writeMemoryKnowledgeBlob({ marker: "mk_db" });
    writeSoulBlob({ version: 1, marker: "soul_db" }, "test");
    writeGoalsBlob({ marker: "goals_db" });
    writeCompetencyBlob({ marker: "comp_db" });
    writeResearchBlob({ marker: "research_db" });

    fs.writeFileSync(memoryBak,     JSON.stringify({ marker: "mk_bak_stale" }));
    fs.writeFileSync(soulBak,       JSON.stringify({ version: 0, marker: "soul_bak_stale" }));
    fs.writeFileSync(goalsBak,      JSON.stringify({ marker: "goals_bak_stale" }));
    fs.writeFileSync(competencyBak, JSON.stringify({ marker: "comp_bak_stale" }));
    fs.writeFileSync(researchBak,   JSON.stringify({ marker: "research_bak_stale" }));

    assert.equal(importMemoryKnowledgeFromJson(), "skipped-existing-db");
    assert.equal(importSoulFromJson(),             "skipped-existing-db");
    assert.equal(importGoalsFromJson(),            "skipped-existing-db");
    assert.equal(importCompetencyFromJson(),       "skipped-existing-db");
    assert.equal(importResearchFromJson(),         "skipped-existing-db");

    // And the DB markers survive — no overwrite.
    assert.equal(memoryKnowledgeRowExists(), true);
    assert.equal(soulRowExists(),            true);
    assert.equal(goalsRowExists(),           true);
    assert.equal(competencyRowExists(),      true);
    assert.equal(researchRowExists(),        true);
  });
});

describe("migrationFirstRunGuard isolation contract — live core state untouched", () => {
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

  it("live data/research_lab.json is byte-identical to its pre-test snapshot", () => {
    const post = snap(REAL_RESEARCH_LAB);
    assert.equal(post.exists, PRE_SNAPSHOTS.researchLab.exists);
    if (post.exists && PRE_SNAPSHOTS.researchLab.exists) {
      assert.equal(post.content!.equals(PRE_SNAPSHOTS.researchLab.content!), true,
        "research_lab.json mutated during the test run");
    }
  });

  it("live data/research_lab.json.bak is byte-identical to its pre-test snapshot", () => {
    const post = snap(REAL_RESEARCH_BAK);
    assert.equal(post.exists, PRE_SNAPSHOTS.researchBak.exists);
    if (post.exists && PRE_SNAPSHOTS.researchBak.exists) {
      assert.equal(post.content!.equals(PRE_SNAPSHOTS.researchBak.content!), true,
        "research_lab.json.bak mutated during the test run");
    }
  });

  it("live data/agent306.db size+mtime unchanged (aggregate-run check is a no-op under parallel suites)", () => {
    if (process.env.AGENT306_AGGREGATE_RUN === "1") return;
    if (!PRE_SNAPSHOTS.agentDb.exists) {
      assert.equal(fs.existsSync(REAL_DB), false);
      return;
    }
    const post = fs.statSync(REAL_DB);
    assert.equal(post.size,    PRE_SNAPSHOTS.agentDb.size);
    assert.equal(post.mtimeMs, PRE_SNAPSHOTS.agentDb.mtimeMs);
  });
});
