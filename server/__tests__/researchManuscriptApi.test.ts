/**
 * Tests for the public Research Manuscripts JSON API.
 *
 *   GET /api/public/research/manuscripts       → list (sorted newest first)
 *   GET /api/public/research/manuscripts/:id   → detail (404 on miss)
 *
 * Run: npx tsx --test server/__tests__/researchManuscriptApi.test.ts
 *
 * Route DATA_DIR to a throwaway tmp before any server-side import so the
 * research_lab.json loaded by the module under test is the fixture we seed
 * here — not the dev data/.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "research-manuscript-api-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TMP;

// Import AFTER setting DATA_DIR so dataPaths.ts picks it up.
const {
  saveResearchLab,
  getResearchLab,
} = await import("../researchEngine.js");
const {
  getPublishedManuscripts,
  getPublicManuscriptById,
  buildManuscriptExcerpt,
} = await import("../publicResearchManuscripts.js");

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
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
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
