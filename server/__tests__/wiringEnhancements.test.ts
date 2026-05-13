/**
 * Tests for cross-system wiring enhancements.
 *
 * Run: npx tsx --test server/__tests__/wiringEnhancements.test.ts
 *
 * Phase 2n drain #11 — Path B isolation:
 *   The entity-dedup tests call `addHypothesis()` / `saveResearchLab()` from
 *   `server/researchEngine.ts`, which captures `dataPath("research_lab.json")`
 *   at module-eval time (line 42). Without redirecting DATA_DIR _before_ the
 *   first import of researchEngine.js, writes land in the repo's live
 *   data/research_lab.json. The dynamic `await import()` calls inside each
 *   `it()` would normally make this safe, BUT they only help if DATA_DIR is
 *   already set when that first dynamic import resolves. Bisect-found cause.
 *
 *   Fix: env vars set in a top-of-file IIFE BEFORE any other import or any
 *   test body executes. Watched-file snapshots + after()-hook contract +
 *   file-level isolation contract describe block (drain template).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain11-wiring-test-"));
process.env.DATA_DIR = TMP;
process.env.DB_PATH = path.join(TMP, "test.db");

import { describe, it, before, after } from "node:test";
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
  const tmpReal = fs.realpathSync(TMP);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`wiringEnhancements isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`wiringEnhancements isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP) {
    throw new Error(`wiringEnhancements isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP, "test.db")) {
    throw new Error(`wiringEnhancements isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  const after = (p: string) => snapshot(p);
  for (const [label, before, p] of [
    ["research_lab.json",                   RESEARCH_SNAPSHOT,        REAL_RESEARCH_LAB],
    ["memory_knowledge.json",               MEMORY_SNAPSHOT,          REAL_MEMORY_KB],
    ["agent_goals.json",                    AGENT_GOALS_SNAPSHOT,     REAL_AGENT_GOALS],
    ["competencyProfile.json",              COMPETENCY_SNAPSHOT,      REAL_COMPETENCY],
    ["experiment_decision_events.jsonl",    DECISION_LEDGER_SNAPSHOT, REAL_DECISION_LEDGER],
    ["sandbox_registration_records.jsonl",  REPO_RECORDS_SNAPSHOT,    REPO_RECORDS_LEDGER],
  ] as const) {
    const a = after(p);
    if (before.exists) {
      if (!a.exists) throw new Error(`wiringEnhancements tests removed live ${label}!`);
      if (a.content !== before.content) throw new Error(`wiringEnhancements tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`wiringEnhancements tests created live ${label}!`);
    }
  }

  const dbAfter = dbStat(REAL_DB);
  if (DB_SNAPSHOT.exists) {
    if (!dbAfter.exists) throw new Error(`wiringEnhancements tests removed live agent306.db!`);
    if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
      throw new Error(`wiringEnhancements tests mutated live agent306.db (size/mtime changed)!`);
    }
  } else if (dbAfter.exists) {
    throw new Error(`wiringEnhancements tests created live agent306.db!`);
  }
});

// ── Enhancement 1: Entity-Level Hypothesis Dedup ─────────────────────────────

describe("extractEntitiesFromClaim", () => {
  it("extracts capitalized entity names from text", async () => {
    const { extractEntitiesFromClaim } = await import("../researchEngine.js");
    const entities = extractEntitiesFromClaim("OpenAI released GPT-5 as a rival to Google DeepMind");
    assert.ok(entities.includes("OpenAI"));
    assert.ok(entities.includes("Google DeepMind"));
  });

  it("skips common stop words", async () => {
    const { extractEntitiesFromClaim } = await import("../researchEngine.js");
    const entities = extractEntitiesFromClaim("The company And Also This But Not that");
    assert.ok(!entities.includes("The"));
    assert.ok(!entities.includes("And"));
    assert.ok(!entities.includes("Also"));
    assert.ok(!entities.includes("This"));
    assert.ok(!entities.includes("But"));
    assert.ok(!entities.includes("Not"));
  });
});

describe("Entity dedup in addHypothesis", () => {
  it("deduplicates hypothesis with >60% entity overlap and >0.3 keyword similarity", async () => {
    const {
      addHypothesis,
      getResearchLab,
      saveResearchLab,
    } = await import("../researchEngine.js");

    // Seed a hypothesis with known entities
    const lab = getResearchLab();
    const existingHyp = {
      id: "hyp_test_entity_dedup",
      claim: "OpenAI GPT-5 scaling research shows diminishing returns for reasoning tasks",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      status: "forming" as const,
      confidence: "medium" as const,
      formedAt: new Date().toISOString(),
      trustScore: 5,
    };

    // Inject existing hypothesis directly
    const existingIdx = lab.hypotheses.findIndex(h => h.id === "hyp_test_entity_dedup");
    if (existingIdx >= 0) {
      lab.hypotheses[existingIdx] = existingHyp;
    } else {
      lab.hypotheses.unshift(existingHyp);
    }
    saveResearchLab(lab);

    // Add a hypothesis with overlapping entities (OpenAI, GPT-5) and similar keywords
    const result = addHypothesis({
      claim: "OpenAI GPT-5 scaling laws suggest reasoning performance plateaus",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      confidence: "medium",
    });

    // Should return the existing hypothesis (deduped), not create a new one
    assert.equal(result.id, "hyp_test_entity_dedup");
    // Trust score should have been bumped
    assert.ok((result.trustScore ?? 0) >= 5.5, `trustScore should be >= 5.5, got ${result.trustScore}`);

    // Cleanup
    const labAfter = getResearchLab();
    labAfter.hypotheses = labAfter.hypotheses.filter(h => h.id !== "hyp_test_entity_dedup");
    saveResearchLab(labAfter);
  });

  it("creates hypothesis normally when entity overlap is low", async () => {
    const {
      addHypothesis,
      getResearchLab,
      saveResearchLab,
    } = await import("../researchEngine.js");

    // Seed an existing hypothesis
    const lab = getResearchLab();
    const existingHyp = {
      id: "hyp_test_no_dedup",
      claim: "Tesla autonomous driving safety metrics improve quarterly",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      status: "forming" as const,
      confidence: "medium" as const,
      formedAt: new Date().toISOString(),
      trustScore: 5,
    };

    const existingIdx = lab.hypotheses.findIndex(h => h.id === "hyp_test_no_dedup");
    if (existingIdx >= 0) {
      lab.hypotheses[existingIdx] = existingHyp;
    } else {
      lab.hypotheses.unshift(existingHyp);
    }
    saveResearchLab(lab);

    // Add a hypothesis with completely different entities
    const result = addHypothesis({
      claim: "Google DeepMind AlphaFold protein structure predictions accelerate drug discovery",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      confidence: "medium",
    });

    // Should create a new hypothesis (different entities)
    assert.notEqual(result.id, "hyp_test_no_dedup");
    assert.ok(result.id.startsWith("hyp_"));

    // Cleanup
    const labAfter = getResearchLab();
    labAfter.hypotheses = labAfter.hypotheses.filter(
      h => h.id !== "hyp_test_no_dedup" && h.id !== result.id,
    );
    saveResearchLab(labAfter);
  });

  it("falls through gracefully when entity extraction fails", async () => {
    const {
      addHypothesis,
      getResearchLab,
      saveResearchLab,
    } = await import("../researchEngine.js");

    // A claim with no capitalized entities should just fall through entity dedup
    const result = addHypothesis({
      claim: "lower case claim with no entities whatsoever about nothing in particular here",
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      confidence: "low",
    });

    // Should still create the hypothesis (no entities to dedup against)
    assert.ok(result.id.startsWith("hyp_"));
    assert.equal(result.status, "forming");

    // Cleanup
    const labAfter = getResearchLab();
    labAfter.hypotheses = labAfter.hypotheses.filter(h => h.id !== result.id);
    saveResearchLab(labAfter);
  });
});

// ── Enhancement 3: Eval-Aware Consolidation Prioritization ───────────────────

describe("prioritizeClusters", () => {
  // Helper to create a mock cluster
  function makeCluster(claims: string[]): import("../hypothesisConsolidator.js").HypothesisCluster {
    const members = claims.map((claim, i) => ({
      id: `hyp_test_${i}_${Date.now()}`,
      claim,
      basis: "test",
      metric: "test",
      prediction: "test",
      timeframe: "30 days",
      status: "forming" as const,
      confidence: "medium" as const,
      formedAt: new Date().toISOString(),
    }));
    return {
      representative: members[0],
      members,
      similarity: 0.5,
    };
  }

  it("sorts clusters matching weak dimension keywords first", async () => {
    const { prioritizeClusters } = await import("../hypothesisConsolidator.js");

    const reasoningCluster = makeCluster([
      "Logic and analysis of reasoning patterns in debate outcomes",
      "Contradiction detection via logical argument chains",
      "Hypothesis testing through structured reasoning",
    ]);
    const audienceCluster = makeCluster([
      "Audience engagement metrics for social media posts",
      "Community growth through content distribution",
      "Follower retention impact analysis",
    ]);
    const neutralCluster = makeCluster([
      "Market price movement correlations",
      "Economic indicator trends quarterly",
      "Supply chain disruption patterns",
    ]);

    // Weakest dimension: reasoningRigor — reasoning cluster should sort first
    const result = prioritizeClusters(
      [audienceCluster, neutralCluster, reasoningCluster],
      "reasoningRigor",
    );

    assert.equal(result[0], reasoningCluster, "Reasoning cluster should be first for reasoningRigor");
  });

  it("sorts larger clusters before smaller at same relevance", async () => {
    const { prioritizeClusters } = await import("../hypothesisConsolidator.js");

    const smallCluster = makeCluster([
      "Data source scanning for signals",
      "Signal detection via monitoring",
    ]);
    const largeCluster = makeCluster([
      "Research data from multiple sources",
      "Data feed scanning improvements",
      "Source monitoring signal detection",
      "Research signal analysis pipeline",
      "Data quality monitoring tools",
      "Signal verification from sources",
    ]);

    // Both match signalAcquisition keywords similarly per-member,
    // but the larger one should sort first due to size tiebreak
    const result = prioritizeClusters(
      [smallCluster, largeCluster],
      "signalAcquisition",
    );

    assert.equal(
      result[0],
      largeCluster,
      "Larger cluster should sort first when relevance scores tie per-member",
    );
  });

  it("returns clusters unchanged when dimension is missing or unknown", async () => {
    const { prioritizeClusters } = await import("../hypothesisConsolidator.js");

    const clusters = [
      makeCluster(["Cluster A topic one", "Cluster A topic two"]),
      makeCluster(["Cluster B topic one", "Cluster B topic two"]),
    ];

    // No dimension
    const result1 = prioritizeClusters(clusters, undefined);
    assert.deepEqual(result1, clusters);

    // Unknown dimension
    const result2 = prioritizeClusters(clusters, "nonexistentDimension");
    assert.deepEqual(result2, clusters);
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Standalone, in-file assertions that this test never crosses into real
// repo state. Companion to the `after()` hook above; these run during file
// evaluation and assert the env+TMP setup itself, plus that the 7 watched
// files are still untouched at the moment this describe block executes.
//
// Mirrors the drain-template contract from drains #2–#10. Drain #11 is a
// Path B fix: research_lab.json was being mutated because
// `server/researchEngine.ts` captures `dataPath("research_lab.json")` at
// module-eval time. Env-var redirect BEFORE first import resolves it.
describe("wiringEnhancements — file-level isolation contract", () => {
  it("DATA_DIR is redirected to this run's tmpdir", () => {
    assert.equal(process.env.DATA_DIR, TMP, "DATA_DIR must point at this run's TMP");
    const tmpRoot = fs.realpathSync(os.tmpdir());
    assert.ok(fs.realpathSync(TMP).startsWith(tmpRoot), "TMP must live under os.tmpdir()");
    assert.ok(!fs.realpathSync(TMP).startsWith(REPO_ROOT), "TMP must NOT live under repo root");
    assert.equal(process.env.DB_PATH, path.join(TMP, "test.db"), "DB_PATH must point at TMP/test.db");
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
