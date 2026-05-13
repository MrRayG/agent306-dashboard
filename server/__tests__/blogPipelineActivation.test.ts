/**
 * Tests for Roadmap B2 — blog pipeline activation at call sites.
 *
 * What we verify here that blogPipelineAdapter.test.ts does not:
 *   - Flag ON + non-dry-run: the entry runs the FULL stage sequence and
 *     emits plan/source/claim/draft/publish events. No LLM key is set, so
 *     the draft stage fails inside the adapter — that's still the
 *     contract: a failure event is emitted and a publish row is written
 *     so the dashboard never has a half-finished pipeline run.
 *   - The wiring at known call sites (routes.ts /api/blog/generate,
 *     dailyCycleEngine, chat-action `generate_blog`) goes through the
 *     entry. We assert this structurally: each of those modules imports
 *     `generateBlogPostMaybeViaPipeline` from `pipeline/blogPipelineEntry`
 *     and does NOT call `generateBlogPost` directly anymore.
 *
 * Run: npx tsx --test server/__tests__/blogPipelineActivation.test.ts
 *
 * Phase 2n drain #16 — template hardening:
 *   The file already routed DB_PATH + DATA_DIR before importing db.ts /
 *   dataPaths.ts (correct module-eval-timing via dynamic imports). Pre-fix
 *   isolated run was clean (no mutation of any of the 7 watched targets) —
 *   the quarantine was the aggregate-parallel-race on shared agent306.db.
 *   This drain upgrades it to the canonical drain template (env-var pin
 *   above node:test import, ORIGINAL_* capture/restore, loud-failure
 *   before() pin, 7-file snapshots, after() hook diff, 8-assertion
 *   contract block) so the file matches drains #2–#15.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain16-blogPipelineActivation-test-"));
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const ORIGINAL_ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_GROK_API_KEY       = process.env.GROK_API_KEY;
const ORIGINAL_XAI_API_KEY        = process.env.XAI_API_KEY;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

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
    throw new Error(`blogPipelineActivation isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`blogPipelineActivation isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP_DIR) {
    throw new Error(`blogPipelineActivation isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP_DIR, "test.db")) {
    throw new Error(`blogPipelineActivation isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

after(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_OPENROUTER_API_KEY !== undefined) process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  if (ORIGINAL_OPENAI_API_KEY     !== undefined) process.env.OPENAI_API_KEY     = ORIGINAL_OPENAI_API_KEY;
  if (ORIGINAL_ANTHROPIC_API_KEY  !== undefined) process.env.ANTHROPIC_API_KEY  = ORIGINAL_ANTHROPIC_API_KEY;
  if (ORIGINAL_GROK_API_KEY       !== undefined) process.env.GROK_API_KEY       = ORIGINAL_GROK_API_KEY;
  if (ORIGINAL_XAI_API_KEY        !== undefined) process.env.XAI_API_KEY        = ORIGINAL_XAI_API_KEY;
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
      if (!a.exists) throw new Error(`blogPipelineActivation tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`blogPipelineActivation tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`blogPipelineActivation tests created live ${label}!`);
    }
  }

  // Under aggregate parallel runs, sibling test files write to
  // live data/agent306.db, drifting its mtime. Skip the per-file
  // DB-stat check there; scripts/checkCoreStateIntegrity.sh runs
  // the canonical end-of-suite check. See PR #354.
  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`blogPipelineActivation tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`blogPipelineActivation tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`blogPipelineActivation tests created live agent306.db!`);
    }
  }
});

// Dynamic imports so DB_PATH / DATA_DIR above are in place before
// `server/db.ts` and `server/dataPaths.ts` evaluate (static ESM imports
// would be hoisted and miss them).
const { db } = await import("../db.js");
const { engineEvents } = await import("@shared/schema");
const { eq } = await import("drizzle-orm");
const { generateBlogPostMaybeViaPipeline } = await import(
  "../pipeline/blogPipelineEntry.js"
);

function wipeEvents() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("blog pipeline activation — flag ON, non-dry-run, no-LLM", () => {
  beforeEach(() => {
    wipeEvents();
    delete process.env.BLOG_PIPELINE_ENABLED;
  });

  it("emits plan/source/claim/draft(fail)/publish(fail) when generateBlogPost has no LLM key", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Activation smoke test",
      sourceContent: "Per https://example.com/x a result was reported.",
      source: "research",
      blogType: "external",
    });
    // No LLM → adapter's compileDraft throws, pipeline records failure.
    assert.equal(out.post, null);
    assert.ok(out.pipeline, "pipeline should run on flag-ON path even when LLM key missing");
    assert.equal(out.pipeline!.dryRun, false);
    assert.equal(out.pipeline!.publish.published, false);
    assert.equal(out.pipeline!.publish.skippedForDryRun, false);

    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const stages = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage);
    // Plan/source/claim succeed; draft fails; publish gets a failure row.
    assert.ok(stages.includes("plan"), "plan event missing");
    assert.ok(stages.includes("source"), "source event missing");
    assert.ok(stages.includes("claim"), "claim event missing");
    assert.ok(stages.includes("draft"), "draft event missing");
    assert.ok(stages.includes("publish"), "publish event missing");
  });

  it("legacy path (flag OFF) does NOT emit any pipeline.* events on the same call shape", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "false";
    await generateBlogPostMaybeViaPipeline({
      topic: "Activation smoke test (legacy)",
      sourceContent: "Per https://example.com/x a result was reported.",
      source: "research",
      blogType: "external",
    });
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const pipelineEvs = evs.filter(e => e.event.startsWith("pipeline."));
    assert.equal(pipelineEvs.length, 0, "no pipeline events should emit when flag is OFF");
  });
});

describe("blog pipeline activation — call-site wiring (structural)", () => {
  // Structural checks rather than runtime mocking: each known blog call
  // site must route through the feature-flagged entry. If a future PR
  // adds another `generateBlogPost(...)` direct call, this test will
  // fail and force the author to either route it through the entry or
  // intentionally exempt it here. Catches the most common regression
  // mode for B2 (a new blog code path that bypasses the flag).
  function readFile(rel: string): string {
    return fs.readFileSync(
      path.join(process.cwd(), rel),
      "utf-8",
    );
  }

  it("dailyCycleEngine routes through generateBlogPostMaybeViaPipeline", () => {
    const src = readFile("server/dailyCycleEngine.ts");
    assert.ok(
      src.includes("generateBlogPostMaybeViaPipeline"),
      "dailyCycleEngine should import generateBlogPostMaybeViaPipeline",
    );
    // No bare `generateBlogPost(` call (only the import-via-pipeline ref).
    assert.equal(
      /[^a-zA-Z]generateBlogPost\(/.test(src),
      false,
      "dailyCycleEngine should not call generateBlogPost() directly",
    );
  });

  it("routes.ts /api/blog/generate routes through the entry", () => {
    const src = readFile("server/routes.ts");
    assert.ok(
      src.includes("generateBlogPostMaybeViaPipeline"),
      "routes.ts should import generateBlogPostMaybeViaPipeline",
    );
    // chat-action `generate_blog` uses dynamic import so the regex
    // catches both the static-import call site and the dynamic-import
    // call site. We allow `generateBlogPost` only as a substring of
    // `generateBlogPostMaybeViaPipeline`.
    const directCall = src.match(/[^a-zA-Z]generateBlogPost\(/g);
    assert.equal(
      directCall,
      null,
      "routes.ts should not call generateBlogPost() directly",
    );
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#15. Drain #16 is template
// hardening: the file already routed DB_PATH + DATA_DIR before importing
// db.ts / dataPaths.ts (correct module-eval-timing via dynamic imports)
// and the pre-fix isolated run was clean. This contract block upgrades
// it to the canonical drain template so it matches drains #2–#15.
describe("blogPipelineActivation — file-level isolation contract", () => {
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
