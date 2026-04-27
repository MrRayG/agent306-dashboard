/**
 * PR-E0 — server-side serialization regression test.
 *
 * Confirms that a `verifierReport` persisted on a `BlogPost` flows through
 * the API JSON response unmodified — i.e. the field reaches the dashboard
 * client without being stripped by a DTO/serializer layer.
 *
 * The route handler at `/api/blog/posts` returns `{ posts: getAllPosts() }`
 * via `res.json` (server/routes.ts). There is no DTO mapper between the
 * persisted `BlogPost` shape and the wire payload, so this test asserts:
 *
 *   1. A persisted post with a populated `verifierReport` is returned with
 *      every field of the report intact (entries, severity, summary).
 *   2. A persisted post WITHOUT a `verifierReport` round-trips with the
 *      field absent — we don't accidentally inject an empty report.
 *
 * We exercise the persistence path directly (createBlogPost → loadState)
 * rather than spinning up Express, because the wire path is `res.json` of
 * the in-memory state and JSON.stringify is the only transformation.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point dataPath() at a hermetic temp dir BEFORE importing blogEngine — it
// reads the path at module init.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pr-e0-blog-"));
process.env.DATA_DIR = TMP_DIR;

const { createBlogPost, getAllPosts, getPostById } = await import("../blogEngine.js");
import type { VerifierReport } from "../claimVerifier.js";

const REPORT: VerifierReport = {
  severity: "HARD_FAIL",
  entries: [
    {
      sentenceIndex: 3,
      snippet: "Anthropic spent $4 billion training the latest Claude model in 2025.",
      classification: "LANE_B_BARE",
      reason: "external fact (number / named study) without a citation link",
      suggestedFix: "Add an inline markdown citation in this sentence/paragraph or drop the fact.",
    },
    {
      sentenceIndex: 7,
      snippet: "Researchers from NCITE presented findings.",
      classification: "NCITE_PATTERN_HIT",
      reason: "appositive not in source — Lane B fact embedded in Lane A sentence",
      suggestedFix: "Move the external detail into a separately cited Lane B sentence, or drop it.",
    },
  ],
  summary: {
    laneAOk: 5,
    laneAFail: 0,
    laneAUnverifiable: 0,
    laneBOk: 2,
    laneBBare: 1,
    retractedHits: 0,
    ncitePatternHits: 1,
  },
};

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe("PR-E0 — verifierReport API serialization", () => {

  it("round-trips a populated verifierReport through the persistence layer unmodified", () => {
    const created = createBlogPost({
      title: "PR-E0 fixture: quarantined post",
      content: "## Body\n\nIrrelevant.",
      source: "research",
      tags: ["claim-verifier-quarantine"],
      status: "quarantined",
      verifierReport: REPORT,
    });

    // Read it back via the same getter the API route uses.
    const fetched = getPostById(created.id);
    assert.ok(fetched, "post should be persisted");

    // The wire payload is JSON.stringify(getAllPosts()) — exercise that path.
    const payload = JSON.parse(JSON.stringify({ posts: getAllPosts() }));
    const wirePost = payload.posts.find((p: any) => p.id === created.id);
    assert.ok(wirePost, "post should appear in the wire payload");

    // Every field of the persisted verifierReport must be on the wire.
    assert.ok(wirePost.verifierReport, "verifierReport must serialize through res.json");
    assert.equal(wirePost.verifierReport.severity, REPORT.severity);
    assert.equal(wirePost.verifierReport.entries.length, REPORT.entries.length);
    assert.deepEqual(wirePost.verifierReport.summary, REPORT.summary);

    for (let i = 0; i < REPORT.entries.length; i += 1) {
      const expected = REPORT.entries[i];
      const got = wirePost.verifierReport.entries[i];
      assert.equal(got.sentenceIndex, expected.sentenceIndex);
      assert.equal(got.snippet, expected.snippet);
      assert.equal(got.classification, expected.classification);
      assert.equal(got.reason, expected.reason);
      assert.equal(got.suggestedFix, expected.suggestedFix);
    }
  });

  it("does not inject a verifierReport on posts that don't have one", () => {
    const created = createBlogPost({
      title: "PR-E0 fixture: regular draft",
      content: "## Body\n\nIrrelevant.",
      source: "standalone",
      tags: ["AI"],
      status: "draft",
      // verifierReport omitted on purpose
    });

    const payload = JSON.parse(JSON.stringify({ posts: getAllPosts() }));
    const wirePost = payload.posts.find((p: any) => p.id === created.id);
    assert.ok(wirePost, "post should appear in the wire payload");
    // Either undefined (omitted) or absent — both are acceptable. We just
    // need to confirm we're not inventing an empty report client-side.
    assert.equal(wirePost.verifierReport, undefined);
  });
});
