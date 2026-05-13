/**
 * Regression test for the PR #264 review finding: the per-stage helper
 * extraction in `server/blogEngine.ts` removed the outer try/catch that
 * pre-PR wrapped the entire LLM-call → verify → publish sequence in
 * `generateBlogPost`. Pre-PR, if `reviseBlogUntilClean` (or the
 * verify-repair path, or the persistence calls) threw, `generateBlogPost`
 * caught the error, logged "[Blog] Generation failed: ...", and returned
 * null. After the refactor, those throws could propagate to callers
 * (routes.ts /api/blog/generate, dailyCycleEngine, chat-action
 * `generate_blog`).
 *
 * The fix in this PR re-wraps the verify/publish portion of
 * `generateBlogPost` so legacy parity is restored. This file pins that
 * contract so a future refactor can't drop the wrapper again.
 *
 * Two assertions:
 *   1. STRUCTURAL: `generateBlogPost` body wraps the
 *      `verifyAndRepairBlogDraft(...)` and `publishBlogDraft(...)` calls
 *      in a try/catch that returns `null`. We assert against the source
 *      so the test fails loudly if the wrapper is removed.
 *   2. BEHAVIORAL: when the writer LLM succeeds but every subsequent
 *      fetch throws (covering the verifier judge call inside
 *      reviseBlogUntilClean), `generateBlogPost` resolves to `null`
 *      rather than rejecting. The test forces compileBlogDraft to take
 *      the success branch (writer OK, safety scan returns safe content),
 *      then drives the verify+publish helpers under a fetch that has
 *      been swapped to reject — proving the function does not surface
 *      throws to its caller. The pipeline path is not exercised here;
 *      its stage-level failure handling lives in the adapter and is
 *      covered separately.
 *
 * Run: npx tsx --test server/__tests__/blogEngineLegacyErrorParity.test.ts
 *
 * Phase 2n drain #19 — Path B fix + template hardening:
 *   Pre-fix: TMP_DIR was created via fs.mkdtempSync(path.join(process.cwd(),
 *   "tmp-blog-legacy-")), leaking a `tmp-blog-legacy-*` directory at the
 *   repo root on every run. The integrity guard
 *   (scripts/checkCoreStateIntegrity.sh) flags this exact pattern as
 *   ROOT LEAK, which is why this file was the original tmp_blog_legacy_root_leak
 *   quarantine entry (Issue #332).
 *
 *   Path B fix: route TMP_DIR through os.tmpdir() with a unique prefix,
 *   so the directory is created outside the repo root by construction.
 *   The directory is also actively removed in after() to avoid /tmp
 *   pressure. The drain template (env-var pin above node:test import,
 *   ORIGINAL_* capture/restore, loud-failure before() pin, 7-file
 *   snapshots, after() diff, 8-assertion contract block) matches
 *   drains #2–#18.
 *
 *   This is the 19th and final drain off Issue #332. After this lands,
 *   the quarantine manifest is empty and the mechanism itself can be
 *   removed.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain19-blogEngineLegacyErrorParity-test-"));
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.DB_PATH  = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { describe, it, before, beforeEach, afterEach, after, mock } from "node:test";
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
    throw new Error(`blogEngineLegacyErrorParity isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`blogEngineLegacyErrorParity isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP_DIR) {
    throw new Error(`blogEngineLegacyErrorParity isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP_DIR, "test.db")) {
    throw new Error(`blogEngineLegacyErrorParity isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
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
      if (!a.exists) throw new Error(`blogEngineLegacyErrorParity tests removed live ${label}!`);
      if (a.content !== beforeSnap.content) throw new Error(`blogEngineLegacyErrorParity tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`blogEngineLegacyErrorParity tests created live ${label}!`);
    }
  }

  // Under aggregate parallel runs, sibling test files write to
  // live data/agent306.db, drifting its mtime. Skip the per-file
  // DB-stat check there; scripts/checkCoreStateIntegrity.sh runs
  // the canonical end-of-suite check. See PR #354.
  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
    const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`blogEngineLegacyErrorParity tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`blogEngineLegacyErrorParity tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`blogEngineLegacyErrorParity tests created live agent306.db!`);
    }
  }
});

function chatResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => content,
  };
}

describe("generateBlogPost — legacy try/catch parity (PR #264 follow-up)", () => {
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedGrok = process.env.GROK_API_KEY;
  const savedXai  = process.env.XAI_API_KEY;
  const savedFlag = process.env.BLOG_PIPELINE_ENABLED;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.GROK_API_KEY;
    delete process.env.XAI_API_KEY;
    // The legacy path is the OFF path. The wrapper under test only
    // protects callers of generateBlogPost; the pipeline path has its
    // own per-stage failure handling and does not call this function.
    process.env.BLOG_PIPELINE_ENABLED = "false";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrok;
    if (savedXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = savedXai;
    if (savedFlag === undefined) delete process.env.BLOG_PIPELINE_ENABLED;
    else process.env.BLOG_PIPELINE_ENABLED = savedFlag;
  });

  it("returns null (does not throw) when the writer succeeds but every downstream fetch rejects", async () => {
    // Writer call (1st fetch): valid blog JSON. Every subsequent fetch
    // rejects with a hard error — covers the safety-scan LLM call and
    // the verifier judge call inside reviseBlogUntilClean. The
    // verify-repair stage's internal catches absorb the verifier
    // rejection, but if any helper threw uncaught (e.g. a future
    // refactor moves persistence outside the repository try/catch), the
    // outer wrapper restored in this PR is the safety net. Either way,
    // generateBlogPost must NOT propagate the throw.
    const blogJson = JSON.stringify({
      title: "Acme Labs ships a new model",
      tags: ["AI", "labs"],
      content:
        "Acme Labs published their findings on Tuesday and called the work \"rigorous and reproducible\".\n\n" +
        "## Section\n\n" +
        "This is a calm Lane A paragraph that says only what the source supports. " +
        "I think the framing here is interesting because it foregrounds reproducibility.",
    });

    let calls = 0;
    const fetchMock = mock.fn(async () => {
      calls += 1;
      if (calls === 1) return chatResponse(blogJson) as any;
      throw new Error(`mocked downstream fetch failure (call #${calls})`);
    });
    globalThis.fetch = fetchMock as any;

    const { generateBlogPost } = await import(
      `../blogEngine.js?t=${Date.now()}`
    );

    let threw = false;
    let result: unknown = "(unset)";
    try {
      result = await generateBlogPost({
        topic: "Acme Labs post",
        sourceContent:
          "Acme Labs published a long technical post on Tuesday describing their new model. " +
          "Acme Labs said the work was \"rigorous and reproducible\".",
        source: "research",
        autoPublish: false,
      });
    } catch (e) {
      threw = true;
      result = e;
    }

    assert.equal(
      threw,
      false,
      `generateBlogPost must not propagate throws under legacy parity; threw with: ${result instanceof Error ? result.message : String(result)}`,
    );
    // The verify+publish stage is best-effort under fetch failure:
    // - If the verifier judge outage path completes cleanly, a real
    //   BlogPost may still be persisted (LANE_A_UNVERIFIABLE entries).
    // - If anything in verify/publish actually throws, the wrapper
    //   returns null.
    // Either outcome is acceptable; the regression we are guarding
    // against is the function rejecting its returned promise.
    assert.ok(
      result === null || (typeof result === "object" && result !== null),
      "generateBlogPost should return either null or a BlogPost-shaped object",
    );
    assert.ok(calls >= 1, "writer fetch must run at least once");
  });
});

describe("generateBlogPost — structural guard for the legacy try/catch", () => {
  it("source wraps verifyAndRepairBlogDraft + publishBlogDraft in try/catch returning null", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "server/blogEngine.ts"),
      "utf-8",
    );

    // Locate the generateBlogPost function body and assert the try
    // wrapper sits between the safety-redacted early return and the
    // closing brace. The wrapper MUST surround both helper calls so
    // either one throwing falls into the same "[Blog] Generation
    // failed:" log + return null behavior the pre-refactor code had.
    const fnMatch = src.match(
      /export\s+async\s+function\s+generateBlogPost\s*\([\s\S]*?\n\}\n/,
    );
    assert.ok(fnMatch, "generateBlogPost function body not found");
    const body = fnMatch![0];

    assert.match(
      body,
      /try\s*\{[\s\S]*verifyAndRepairBlogDraft\s*\(/,
      "verifyAndRepairBlogDraft must sit inside a try block",
    );
    assert.match(
      body,
      /try\s*\{[\s\S]*publishBlogDraft\s*\([\s\S]*?\}\s*catch\s*\(/,
      "publishBlogDraft must sit inside a try block followed by a catch",
    );
    assert.match(
      body,
      /catch\s*\([^)]*\)\s*\{[\s\S]*\[Blog\]\s+Generation failed[\s\S]*return\s+null/,
      "catch block must log '[Blog] Generation failed' and return null (legacy parity)",
    );
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#18. Drain #19 is the final
// drain off Issue #332. Path B fix: TMP_DIR routed through os.tmpdir()
// instead of process.cwd() so the file no longer leaks `tmp-blog-legacy-*`
// directories at the repo root. The contract block below upgrades the file
// to the canonical drain template.
describe("blogEngineLegacyErrorParity — file-level isolation contract", () => {
  it("DATA_DIR is redirected to this run's tmpdir (under os.tmpdir(), NOT under repo root)", () => {
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
