/**
 * Tests for the public Research Manuscripts JSON API.
 *
 *   GET /api/public/research/manuscripts       → list (sorted newest first)
 *   GET /api/public/research/manuscripts/:id   → detail (404 on miss)
 *
 * Run: npx tsx --test server/__tests__/researchManuscriptApi.test.ts
 *
 * Phase 2n drain #13 — isolation hardening:
 *   The file already routed DATA_DIR to a tmp dir before importing
 *   researchEngine.js (which captures dataPath("research_lab.json") at
 *   module-eval time — server/researchEngine.ts:42). That partial
 *   isolation kept research_lab.json safe in isolated runs, but the
 *   file was quarantined out of an abundance of caution while the
 *   integrity guard was being established. This drain upgrades it to
 *   the full drain template: DB_PATH redirect, 7 watched-file
 *   snapshots, loud-failure pin in before(), after() hook diffs all 7,
 *   plus the 8-assertion file-level contract describe block at the end
 *   — matching drains #2–#12.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "phase2n-drain13-research-manuscript-api-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_DB_PATH  = process.env.DB_PATH;
process.env.DATA_DIR = TMP;
process.env.DB_PATH  = path.join(TMP, "test.db");

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

// Import AFTER setting DATA_DIR/DB_PATH so dataPaths.ts and db.ts pick them up.
const {
  saveResearchLab,
  getResearchLab,
} = await import("../researchEngine.js");
const {
  getPublishedManuscripts,
  getPublicManuscriptById,
  buildManuscriptExcerpt,
} = await import("../publicResearchManuscripts.js");

before(() => {
  // Loud-failure pin (drain template).
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const tmpReal = fs.realpathSync(TMP);
  if (!tmpReal.startsWith(tmpRoot)) {
    throw new Error(`researchManuscriptApi isolation broke: TMP not under os.tmpdir(): ${tmpReal}`);
  }
  if (tmpReal.startsWith(REPO_ROOT)) {
    throw new Error(`researchManuscriptApi isolation broke: TMP under repo root: ${tmpReal}`);
  }
  if (process.env.DATA_DIR !== TMP) {
    throw new Error(`researchManuscriptApi isolation broke: DATA_DIR drifted to ${process.env.DATA_DIR}`);
  }
  if (process.env.DB_PATH !== path.join(TMP, "test.db")) {
    throw new Error(`researchManuscriptApi isolation broke: DB_PATH drifted to ${process.env.DB_PATH}`);
  }
});

type Topic = ReturnType<typeof getResearchLab>["topics"][number];

function topic(partial: Partial<Topic> & { id: string; topic: string }): Topic {
  const now = new Date().toISOString();
  return {
    id:          partial.id,
    topic:       partial.topic,
    description: partial.description ?? "seeded for test",
    priority:    partial.priority ?? "medium",
    status:      partial.status ?? "published",
    addedBy:     partial.addedBy ?? "agent",
    addedAt:     partial.addedAt ?? now,
    updatedAt:   partial.updatedAt ?? now,
    ...partial,
  } as Topic;
}

function seedLab(topics: Topic[]) {
  saveResearchLab({
    topics,
    hypotheses: [],
    lastUpdated: new Date().toISOString(),
    stats: { totalResearched: 0, totalPublished: 0, totalDeclined: 0, hypothesesFormed: 0, hypothesesConfirmed: 0 },
  } as any);
}

after(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_DB_PATH === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = ORIGINAL_DB_PATH;
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
      if (!a.exists) throw new Error(`researchManuscriptApi tests removed live ${label}!`);
      if (a.content !== before.content) throw new Error(`researchManuscriptApi tests mutated live ${label}!`);
    } else {
      if (a.exists) throw new Error(`researchManuscriptApi tests created live ${label}!`);
    }
  }

  // Under aggregate parallel runs, sibling test files write to
  // live data/agent306.db, drifting its mtime. Skip the per-file
  // DB-stat check there; scripts/checkCoreStateIntegrity.sh runs
  // the canonical end-of-suite check. See PR #354.
  if (process.env.AGENT306_AGGREGATE_RUN !== "1") {
const dbAfter = dbStat(REAL_DB);
    if (DB_SNAPSHOT.exists) {
      if (!dbAfter.exists) throw new Error(`researchManuscriptApi tests removed live agent306.db!`);
      if (dbAfter.size !== DB_SNAPSHOT.size || dbAfter.mtimeMs !== DB_SNAPSHOT.mtimeMs) {
        throw new Error(`researchManuscriptApi tests mutated live agent306.db (size/mtime changed)!`);
      }
    } else if (dbAfter.exists) {
      throw new Error(`researchManuscriptApi tests created live agent306.db!`);
    }
  }
});

// ── 1. List endpoint: sorted newest first ───────────────────────────────────

describe("getPublishedManuscripts — sort order", () => {
  before(() => {
    seedLab([
      topic({
        id: "research_1000",
        topic: "Oldest manuscript",
        manuscript: "# Oldest\n\nThis is the oldest published manuscript.",
        publishedAt: "2024-01-01T00:00:00.000Z",
        status: "published",
      }),
      topic({
        id: "research_3000",
        topic: "Newest manuscript",
        manuscript: "# Newest\n\nThis is the newest published manuscript.",
        publishedAt: "2026-03-15T00:00:00.000Z",
        status: "published",
      }),
      topic({
        id: "research_2000",
        topic: "Middle manuscript",
        manuscript: "# Middle\n\nThis is the middle published manuscript.",
        publishedAt: "2025-06-01T00:00:00.000Z",
        status: "published",
      }),
    ]);
  });

  it("returns manuscripts sorted by publishedAt DESC (newest first)", () => {
    const list = getPublishedManuscripts();
    assert.deepEqual(
      list.map(m => m.id),
      ["research_3000", "research_2000", "research_1000"],
    );
  });

  it("honours limit parameter", () => {
    const list = getPublishedManuscripts(2);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "research_3000");
  });
});

// ── 2. Back-catalog filter: exclude topics without a manuscript ─────────────

describe("getPublishedManuscripts — filter", () => {
  it("excludes topics without a manuscript", () => {
    seedLab([
      topic({
        id: "research_has_ms",
        topic: "Has manuscript",
        manuscript: "# Real\n\nFull content.",
        status: "published",
        publishedAt: "2026-01-01T00:00:00.000Z",
      }),
      topic({
        id: "research_no_ms",
        topic: "No manuscript",
        status: "researching",
      }),
      topic({
        id: "research_empty_ms",
        topic: "Empty manuscript",
        manuscript: "   ",
        status: "pending_review",
      }),
    ]);

    const list = getPublishedManuscripts();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "research_has_ms");
  });

  it("excludes declined and archived topics even if they carry a manuscript", () => {
    seedLab([
      topic({
        id: "research_declined",
        topic: "Declined topic",
        manuscript: "# Declined\n\nShould not surface.",
        status: "declined",
        publishedAt: "2026-02-01T00:00:00.000Z",
      }),
      topic({
        id: "research_archived",
        topic: "Archived topic",
        manuscript: "# Archived\n\nShould not surface.",
        status: "archived",
        publishedAt: "2026-02-02T00:00:00.000Z",
      }),
      topic({
        id: "research_live",
        topic: "Live topic",
        manuscript: "# Live\n\nShould surface.",
        status: "published",
        publishedAt: "2026-02-03T00:00:00.000Z",
      }),
    ]);

    const list = getPublishedManuscripts();
    assert.deepEqual(list.map(m => m.id), ["research_live"]);
  });
});

// ── 3. List response shape: required fields, no leaked internals ────────────

describe("getPublishedManuscripts — response shape", () => {
  it("includes required public fields and no internal leakage", () => {
    seedLab([
      topic({
        id: "research_shape",
        topic: "Shape test",
        description: "internal description — should not leak",
        manuscript: "# Shape Test\n\nHeading-prefixed first paragraph content that is long enough to actually require truncation well past the two-hundred-character boundary, so we can confirm the excerpt is trimmed and ellipsised cleanly.",
        manuscriptType: "deep_read",
        publishedAt: "2026-01-15T00:00:00.000Z",
        publishedTo: ["mirror.xyz", "agent306.ai"],
        // Internal fields that MUST NOT leak:
        rawFindings: "SECRET internal raw findings",
        hypothesis: "SECRET internal hypothesis",
        analysisFindings: "SECRET internal analysis",
        agentRecommendation: "SECRET recommendation",
        reviewNote: "SECRET review note",
        dataPoints: [{ content: "SECRET", source: "x", credibility: 0 }] as any,
        phaseHistory: [{ phase: "analysis", note: "SECRET" }] as any,
        autoSearchLog: [{ query: "SECRET" }] as any,
        status: "published",
      }),
    ]);

    const [item] = getPublishedManuscripts();
    assert.equal(item.id, "research_shape");
    assert.equal(item.title, "Shape test");
    assert.equal(item.publishedAt, "2026-01-15T00:00:00.000Z");
    assert.equal(item.manuscriptType, "deep_read");
    assert.deepEqual(item.publishedTo, ["mirror.xyz", "agent306.ai"]);
    assert.ok(typeof item.excerpt === "string" && item.excerpt.length > 0);
    assert.ok(item.excerpt.length <= 205, `excerpt too long: ${item.excerpt.length}`);

    // No internal fields leaked
    const serialized = JSON.stringify(item);
    for (const secret of [
      "SECRET internal raw findings",
      "SECRET internal hypothesis",
      "SECRET internal analysis",
      "SECRET recommendation",
      "SECRET review note",
      "SECRET",
      "internal description",
    ]) {
      assert.ok(!serialized.includes(secret), `leaked internal field matching: ${secret}`);
    }

    // List items must NOT include the full manuscript body — that's detail-only.
    assert.ok(!Object.prototype.hasOwnProperty.call(item, "manuscript"),
      "list items must not include the full manuscript body");
  });
});

// ── 4. Detail endpoint: returns full manuscript for a valid id ──────────────

describe("getPublicManuscriptById — success path", () => {
  it("returns full manuscript body + metadata for a valid id", () => {
    seedLab([
      topic({
        id: "research_detail_ok",
        topic: "Detail lookup",
        manuscript: "# Full Manuscript\n\nThis is the entire body of the research manuscript, meant to be returned verbatim from the detail endpoint.",
        manuscriptType: "thesis",
        publishedAt: "2026-04-01T00:00:00.000Z",
        status: "published",
      }),
    ]);

    const detail = getPublicManuscriptById("research_detail_ok");
    assert.ok(detail, "expected manuscript detail");
    assert.equal(detail!.id, "research_detail_ok");
    assert.equal(detail!.title, "Detail lookup");
    assert.equal(detail!.manuscriptType, "thesis");
    assert.ok(detail!.manuscript.includes("entire body of the research manuscript"));
  });
});

// ── 5. Detail endpoint: 404 on unknown id ───────────────────────────────────

describe("getPublicManuscriptById — unknown id", () => {
  it("returns null for an unknown id (route handler → 404)", () => {
    seedLab([
      topic({
        id: "research_exists",
        topic: "Exists",
        manuscript: "# Exists",
        status: "published",
      }),
    ]);

    assert.equal(getPublicManuscriptById("research_does_not_exist"), null);
  });
});

// ── 6. Detail endpoint: 404 on topic without a manuscript ───────────────────

describe("getPublicManuscriptById — topic without manuscript", () => {
  it("returns null when topic exists but has no manuscript", () => {
    seedLab([
      topic({
        id: "research_no_ms",
        topic: "Researching — no manuscript yet",
        status: "researching",
      }),
    ]);

    assert.equal(getPublicManuscriptById("research_no_ms"), null);
  });

  it("returns null when topic is declined even with a manuscript", () => {
    seedLab([
      topic({
        id: "research_declined_with_ms",
        topic: "Declined but has manuscript",
        manuscript: "# Declined draft",
        status: "declined",
      }),
    ]);

    assert.equal(getPublicManuscriptById("research_declined_with_ms"), null);
  });
});

// ── 7. Contract test: advertised id resolves ────────────────────────────────
//
// `generateResearchContent` advertises `https://agent306.ai/research/<topic.id>`
// in every 306 Research X post. The public JSON API must resolve that same id
// — if it doesn't, every advertised link is dead on arrival (same invariant
// PR #197 tested for the HTML route, now pinned for the JSON API).

describe("contract: advertised research id resolves on the JSON API", () => {
  it("the id embedded in an X post resolves via GET /api/public/research/manuscripts/:id", () => {
    const advertisedId = `research_${Date.now()}`;
    seedLab([
      topic({
        id: advertisedId,
        topic: "Contract-advertised manuscript",
        manuscript: "# Advertised\n\nThis manuscript's id is the one embedded in the X post.",
        status: "published",
        publishedAt: new Date().toISOString(),
      }),
    ]);

    const detail = getPublicManuscriptById(advertisedId);
    assert.ok(detail, "id advertised by generateResearchContent must resolve on the JSON API");
    assert.equal(detail!.id, advertisedId);
    assert.ok(detail!.manuscript.length > 0, "detail response must include the full manuscript body");
  });
});

// ── 8. Excerpt helper: sanity checks ────────────────────────────────────────

describe("buildManuscriptExcerpt", () => {
  it("strips heading markers", () => {
    const out = buildManuscriptExcerpt("# Title\n\nBody text.");
    assert.ok(!out.startsWith("#"));
    assert.ok(out.includes("Title"));
    assert.ok(out.includes("Body text"));
  });

  it("flattens markdown links to their text", () => {
    const out = buildManuscriptExcerpt("See [this paper](https://example.com/paper) for details.");
    assert.ok(out.includes("this paper"));
    assert.ok(!out.includes("https://example.com"));
  });

  it("trims to a word boundary with an ellipsis when over the cap", () => {
    const long = "word ".repeat(100).trim();
    const out = buildManuscriptExcerpt(long, 50);
    assert.ok(out.length <= 52, `expected <=52 chars, got ${out.length}`);
    assert.ok(out.endsWith("…"));
    // No mid-word cut — final segment before ellipsis ends at a whole word.
    const body = out.slice(0, -1).trim();
    assert.ok(body.endsWith("word"));
  });

  it("returns the full string untouched when under the cap", () => {
    const out = buildManuscriptExcerpt("short body", 200);
    assert.equal(out, "short body");
  });
});

// ── File-level isolation contract ───────────────────────────────────────────
//
// Drain template contract — matches drains #2–#12. Drain #13 hardens an
// already-isolated test (the file already redirected DATA_DIR before the
// researchEngine import) to the full template: DB_PATH redirect, 7
// watched-file snapshots, loud-failure pin, after() hook diff, and the
// 8-assertion contract below. researchEngine.ts:42 captures
// dataPath("research_lab.json") at module-eval time, so env vars must be
// set before any import that resolves dataPaths.ts.
describe("researchManuscriptApi — file-level isolation contract", () => {
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
