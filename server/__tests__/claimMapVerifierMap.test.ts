/**
 * Tests for server/claimMapVerifierMap.ts (Roadmap A2). The mapping is a
 * best-effort deterministic match from verifier-flagged sentences to the
 * claim_map_items.itemKey they most likely came from.
 *
 * Isolation note: this test sets `DB_PATH`/`DATA_DIR` to a per-run temp
 * directory and imports `db.js` (and any module that transitively imports
 * it) DYNAMICALLY inside each test. Static `import` statements at the top
 * of an ESM module are hoisted above the env-var assignment, which means
 * the singleton `db` would otherwise open the real `data/agent306.db` and
 * concurrent test files would race on it. Dynamic imports preserve source
 * order and pin db.ts to the temp path. See PR #292 for the original
 * flake (CI aggregate suite).
 *
 * Phase 2n drain #17 — Path B + template hardening:
 *   The file previously created TMP_DIR under `process.cwd()` (the repo
 *   root) as `tmp-claimMapVerify-*`. The dynamic-import pattern already
 *   neutralised the shared-`agent306.db` race, but the repo-root tmp
 *   directory leaked across runs and would trip the canonical drain
 *   `before()` pin ("TMP must NOT live under repo root"). The fix:
 *   route TMP through `os.tmpdir()` instead of `process.cwd()`, then
 *   upgrade the file to the canonical drain template (env-var pin
 *   above node:test import, ORIGINAL_* capture/restore, loud-failure
 *   pin, 7-file snapshots, after() hook diff, 8-assertion contract).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain17-claimMapVerifierMap-test-"));
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
    throw new Error(`claimMapVerifierMap isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`claimMapVerifierMap isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP_DIR) {
    throw new Error(`claimMapVerifierMap isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP_DIR, "test.db")) {
    throw new Error(`claimMapVerifierMap isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
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
      if (!a.exists) throw new Error(`claimMapVerifierMap tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`claimMapVerifierMap tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`claimMapVerifierMap tests created live ${label}!`);
    }
  }

  // Under aggregate parallel runs, sibling test files write to
  // live data/agent306.db, drifting its mtime. Skip the per-file
  // DB-stat check there; scripts/checkCoreStateIntegrity.sh runs
  // the canonical end-of-suite check. See PR #354.
  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`claimMapVerifierMap tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`claimMapVerifierMap tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`claimMapVerifierMap tests created live agent306.db!`);
    }
  }
});

import type { VerifierReport } from "../claimVerifier.js";

function emptyReport(entries: VerifierReport["entries"]): VerifierReport {
  return {
    severity: "HARD_FAIL",
    entries,
    summary: {
      laneAOk: 0,
      laneAFail: entries.filter(e => e.classification === "LANE_A_FAIL").length,
      laneAUnverifiable: 0,
      laneAPassQuotedCommentary: 0,
      laneAPassCritiqueByAbsence: 0,
      laneBOk: 0,
      laneBBare: entries.filter(e => e.classification === "LANE_B_BARE").length,
      retractedHits: 0,
      ncitePatternHits: 0,
    },
  };
}

describe("claimMapVerifierMap (Roadmap A2)", () => {
  beforeEach(async () => {
    const { db } = await import("../db.js");
    const { claimMap, claimMapItems } = await import("@shared/schema");
    try { db.delete(claimMapItems).run(); } catch {}
    try { db.delete(claimMap).run(); } catch {}
  });

  it("annotates failing entries with their best-match claim itemKey", async () => {
    const { createOrReplaceClaimMap } = await import("../repositories/claimMapRepository.js");
    const { mapVerifierFailuresToClaims } = await import("../claimMapVerifierMap.js");
    createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_v1",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5 reasoning at DevDay",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
        {
          itemKey: "blog:2",
          claimText: "Anthropic released Claude Opus 4.5 with extended thinking",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
      ],
    });
    const report = emptyReport([
      {
        sentenceIndex: 3,
        snippet: "On 2025-10-12 OpenAI announced GPT-5 reasoning at DevDay.",
        classification: "LANE_B_BARE",
        reason: "missing inline citation",
      },
      {
        sentenceIndex: 7,
        snippet: "Anthropic released Claude Opus 4.5 with extended thinking last quarter.",
        classification: "LANE_A_FAIL",
        reason: "claim not found in source",
      },
    ]);
    const matches = mapVerifierFailuresToClaims({
      engine: "blog",
      draftId: "blog_v1",
      report,
    });
    assert.equal(matches.length, 2);
    assert.equal(matches[0].claimItemKey, "blog:1");
    assert.equal(matches[1].claimItemKey, "blog:2");
    assert.equal(matches[0].classification, "LANE_B_BARE");
    assert.equal(matches[1].classification, "LANE_A_FAIL");
  });

  it("returns claimItemKey=null when no claim overlaps the sentence", async () => {
    const { createOrReplaceClaimMap } = await import("../repositories/claimMapRepository.js");
    const { mapVerifierFailuresToClaims } = await import("../claimMapVerifierMap.js");
    createOrReplaceClaimMap({
      engine: "blog",
      draftId: "blog_v2",
      items: [
        {
          itemKey: "blog:1",
          claimText: "OpenAI announced GPT-5 at DevDay",
          claimType: "factual_attributed",
          citationRequirement: "required",
        },
      ],
    });
    const report = emptyReport([
      {
        sentenceIndex: 2,
        snippet: "Bitcoin briefly traded above ninety thousand dollars yesterday.",
        classification: "LANE_B_BARE",
        reason: "missing inline citation",
      },
    ]);
    const matches = mapVerifierFailuresToClaims({
      engine: "blog",
      draftId: "blog_v2",
      report,
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].claimItemKey, null);
  });

  it("ignores OK / passing entries — only failures are emitted", async () => {
    const { mapVerifierFailuresWithItems } = await import("../claimMapVerifierMap.js");
    const items = [
      {
        id: 1,
        claimMapId: 1,
        itemKey: "blog:1",
        claimText: "Some approved claim about widgets",
        claimType: "voice",
        citationRequirement: "forbidden" as const,
        sourceSupport: "[]",
        confidence: 0.5,
        risk: "low",
        approved: true,
        note: null,
        createdAt: "",
      },
    ];
    const report = emptyReport([
      {
        sentenceIndex: 0,
        snippet: "Widgets are great approved claim",
        classification: "LANE_A_OK",
        reason: "supported",
      },
      {
        sentenceIndex: 1,
        snippet: "Other unrelated commentary line",
        classification: "LANE_B_OK",
        reason: "no external claim",
      },
    ]);
    const matches = mapVerifierFailuresWithItems(report, items);
    assert.equal(matches.length, 0);
  });

  it("returns [] when no claim map exists for the draft", async () => {
    const { mapVerifierFailuresToClaims } = await import("../claimMapVerifierMap.js");
    const report = emptyReport([
      {
        sentenceIndex: 0,
        snippet: "anything",
        classification: "LANE_B_BARE",
        reason: "missing citation",
      },
    ]);
    const matches = mapVerifierFailuresToClaims({
      engine: "blog",
      draftId: "no-such",
      report,
    });
    assert.equal(matches.length, 0);
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#16. Drain #17 is a Path B
// fix: the file previously created TMP_DIR under `process.cwd()` (repo
// root) as `tmp-claimMapVerify-*`. Dynamic imports already neutralised
// the agent306.db race, but the repo-root tmp directory leaked across
// runs. Fix: route TMP through `os.tmpdir()`. This contract block
// upgrades the file to the canonical drain template.
describe("claimMapVerifierMap — file-level isolation contract", () => {
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
    // Under the aggregate parallel runner sibling test files
    // concurrently write to live data/agent306.db. The per-file
    // contract check is meant to catch *this file* mutating live
    // DB; under aggregate runs the mtime drift comes from siblings,
    // not us. scripts/checkCoreStateIntegrity.sh remains the
    // canonical end-of-run check. See PR #354 for the race.
    if (process.env.AGENT306_AGGREGATE_RUN === "1") return;
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
