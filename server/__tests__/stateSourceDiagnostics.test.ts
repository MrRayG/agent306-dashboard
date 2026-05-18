/**
 * Read-only state-source diagnostics.
 *
 * Covers `buildStateSourceDiagnostics()` — a read-only block surfaced on the
 * Autonomy Monitor so operators can see, per high-churn store, whether the
 * DB row, live JSON, and `.bak` are present, their updatedAt timestamps,
 * and short content hashes.
 *
 * Pins:
 *   - No mutation: assertions run twice and verify nothing changes between
 *     calls.
 *   - effectiveSource matches the read-through walk: DB → JSON → bak → missing.
 *   - dbAheadOfBak is true exactly when the DB blob's hash differs from .bak.
 *   - Warning is emitted when DB row is absent but .bak is present (volume-
 *     mount inversion sign).
 *
 * Run: npx tsx --test server/__tests__/stateSourceDiagnostics.test.ts
 */

import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "state-source-diagnostics-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const REAL_RESEARCH_LAB = path.join(REPO_ROOT, "data", "research_lab.json");
const REAL_DB           = path.join(REPO_ROOT, "data", "agent306.db");
const preResearchLab = fs.existsSync(REAL_RESEARCH_LAB)
  ? fs.readFileSync(REAL_RESEARCH_LAB)
  : null;
const preDb = fs.existsSync(REAL_DB)
  ? { size: fs.statSync(REAL_DB).size, mtimeMs: fs.statSync(REAL_DB).mtimeMs }
  : null;

const { db } = await import("../db.js");
const {
  researchLab,
  memoryKnowledge,
  memorySoul,
  memorySoulHistory,
  agentGoals,
  competencyProfileTable,
} = await import("@shared/schema");
const { dataPath } = await import("../dataPaths.js");
const { writeResearchBlob } = await import("../repositories/researchRepository.js");
const { buildStateSourceDiagnostics } = await import("../stateSourceDiagnostics.js");

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
const compJson     = dataPath("competencyProfile.json");
const compBak      = `${compJson}.bak`;
const soulJson     = dataPath("memory_soul.json");
const soulBak      = `${soulJson}.bak`;

function cleanFiles() {
  [researchJson, researchBak, memoryJson, memoryBak,
   goalsJson, goalsBak, compJson, compBak, soulJson, soulBak].forEach(tryUnlink);
}

describe("state-source diagnostics", () => {
  before(() => {
    assert.equal(researchJson.startsWith(TMP), true,
      `researchJson must be under TMP, got ${researchJson}`);
  });

  beforeEach(() => { wipe(); cleanFiles(); });
  afterEach(() => { cleanFiles(); });

  it("reports dbRowPresent + effectiveSource='db' when DB row exists", () => {
    writeResearchBlob({ topics: [], hypotheses: [{ id: "h_db" }] });
    const diag = buildStateSourceDiagnostics();
    const research = diag.rows.find(r => r.store === "research_lab")!;
    assert.equal(research.dbRowPresent, true);
    assert.equal(research.effectiveSource, "db");
    assert.notEqual(research.dbBlobHash, null);
    assert.notEqual(research.dbUpdatedAt, null);
    // No file on disk so jsonPresent / bakPresent are false.
    assert.equal(research.jsonPresent, false);
    assert.equal(research.bakPresent, false);
  });

  it("reports effectiveSource='json' when DB row absent but live JSON present", () => {
    fs.writeFileSync(researchJson, JSON.stringify({ topics: [], hypotheses: [{ id: "live" }] }));
    const diag = buildStateSourceDiagnostics();
    const research = diag.rows.find(r => r.store === "research_lab")!;
    assert.equal(research.dbRowPresent, false);
    assert.equal(research.jsonPresent, true);
    assert.equal(research.effectiveSource, "json");
    assert.notEqual(research.jsonHash, null);
  });

  it("reports effectiveSource='bak' when DB row + live JSON absent but .bak present, AND surfaces a warning", () => {
    fs.writeFileSync(researchBak, JSON.stringify({ topics: [], hypotheses: [{ id: "bak" }] }));
    const diag = buildStateSourceDiagnostics();
    const research = diag.rows.find(r => r.store === "research_lab")!;
    assert.equal(research.dbRowPresent, false);
    assert.equal(research.jsonPresent, false);
    assert.equal(research.bakPresent, true);
    assert.equal(research.effectiveSource, "bak");
    assert.notEqual(research.bakHash, null);
    // The warning fires whenever DB is missing AND .bak is present — that
    // is the volume-mount inversion sign we want operators to notice.
    assert.equal(
      diag.warnings.some(w => w.includes("research_lab")),
      true,
      "expected a warning for research_lab when DB absent + .bak present",
    );
  });

  it("dbAheadOfBak is true exactly when DB blob hash differs from .bak hash", () => {
    // Case A: matching content → hashes equal → dbAheadOfBak false.
    const sharedBlob = { topics: [], hypotheses: [{ id: "h_match" }] };
    writeResearchBlob(sharedBlob);
    fs.writeFileSync(researchBak, JSON.stringify(sharedBlob));
    let diag = buildStateSourceDiagnostics();
    let research = diag.rows.find(r => r.store === "research_lab")!;
    assert.equal(research.dbBlobHash, research.bakHash,
      "with identical content, db + bak hashes should match");
    assert.equal(research.dbAheadOfBak, false);

    // Case B: DB mutated (operator applied archive tag), .bak still old →
    // hashes differ → dbAheadOfBak true. This is the steady state after
    // the bug fix: the live DB row is the canonical source, and the .bak
    // on disk is correctly identified as stale.
    writeResearchBlob({ topics: [], hypotheses: [{ id: "h_match", status: "archived" }] });
    diag = buildStateSourceDiagnostics();
    research = diag.rows.find(r => r.store === "research_lab")!;
    assert.notEqual(research.dbBlobHash, research.bakHash,
      "after DB mutation, db + bak hashes should diverge");
    assert.equal(research.dbAheadOfBak, true);
  });

  it("is read-only — repeated calls return equivalent (no-mutation) output", () => {
    writeResearchBlob({ topics: [], hypotheses: [{ id: "h_db" }] });
    const a = buildStateSourceDiagnostics();
    const b = buildStateSourceDiagnostics();
    // generatedAt differs (it's now()); the rest must be byte-equal.
    assert.deepEqual(
      a.rows.map(r => ({ ...r })),
      b.rows.map(r => ({ ...r })),
    );
  });

  it("reports effectiveSource='missing' when no source exists for a store", () => {
    const diag = buildStateSourceDiagnostics();
    const goals = diag.rows.find(r => r.store === "agent_goals")!;
    assert.equal(goals.dbRowPresent, false);
    assert.equal(goals.jsonPresent, false);
    assert.equal(goals.bakPresent, false);
    assert.equal(goals.effectiveSource, "missing");
    assert.equal(goals.dbAheadOfBak, false);
  });

  it("includes a row for each of the five high-churn stores", () => {
    const diag = buildStateSourceDiagnostics();
    const names = diag.rows.map(r => r.store).sort();
    assert.deepEqual(names, [
      "agent_goals",
      "competency_profile",
      "memory_knowledge",
      "memory_soul",
      "research_lab",
    ]);
  });
});

describe("stateSourceDiagnostics isolation contract — live core state untouched", () => {
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

  it("live data/research_lab.json is byte-identical to its pre-test snapshot", () => {
    const post = fs.existsSync(REAL_RESEARCH_LAB) ? fs.readFileSync(REAL_RESEARCH_LAB) : null;
    if (preResearchLab && post) {
      assert.equal(post.equals(preResearchLab), true,
        "research_lab.json mutated during the test run");
    } else {
      assert.equal(!!preResearchLab, !!post);
    }
  });

  it("live data/agent306.db size+mtime unchanged (skipped in aggregate runs)", () => {
    if (process.env.AGENT306_AGGREGATE_RUN === "1") return;
    if (!preDb) {
      assert.equal(fs.existsSync(REAL_DB), false);
      return;
    }
    const post = fs.statSync(REAL_DB);
    assert.equal(post.size,    preDb.size);
    assert.equal(post.mtimeMs, preDb.mtimeMs);
  });
});
