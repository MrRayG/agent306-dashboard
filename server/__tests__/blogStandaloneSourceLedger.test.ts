/**
 * Tests for the standalone source-ledger-item fallback in
 * `persistBlogSourceLedger` (server/blogEngine.ts).
 *
 * Background: prior to this PR, when an operator generated a blog post
 * via "Generate from Topic" with Source Type = standalone and free-text
 * Source Content (no URLs), the dashboard wrote a parent `source_ledger`
 * row but ZERO `source_ledger_items` rows because `extractSourceObjects`
 * yielded an empty pool. Live validation after PR #264 confirmed this on
 * post `blog_1777773765780_rfes`.
 *
 * Fix: `persistBlogSourceLedger` now synthesizes a single "operator-
 * provided standalone" item when the source pool is empty AND the
 * trimmed `sourceContent` is non-trivial. The synthetic item is marked
 * clearly so downstream verifier/reviser/dashboard understands it is
 * operator-provided text rather than an external URL:
 *   - non-http `internal://` URL (filtered out of `listLedgerSourceUrls`)
 *   - sourceType: "primary"
 *   - trustTier: "unverified"
 *   - publisher: "operator"
 *   - title prefixed "Operator-provided standalone source: "
 *   - excerpt truncated to 2000 chars
 *   - metadata.origin === "standalone_freetext"
 *
 * What we do NOT want to regress:
 *   - URL / sourceObjects pools still produce real http(s) items, no
 *     synthetic item appended.
 *   - listLedgerSourceUrls keeps filtering out the synthetic url so the
 *     publish-after-edit verifier never sees `internal://...` as a
 *     source URL.
 *
 * Run: npx tsx --test server/__tests__/blogStandaloneSourceLedger.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-blog-standalone-ledger-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import { db } from "../db.js";
import { sourceLedger, sourceLedgerItems } from "@shared/schema";
import {
  getLedgerByDraft,
  listLedgerSourceUrls,
} from "../repositories/sourceLedgerRepository.js";
import {
  persistBlogSourceLedger,
  publishBlogDraft,
} from "../blogEngine.js";
import { buildResearchPack } from "../researchPack.js";
import type { ClaimVerdict } from "../claimVerifier.js";

function wipe() {
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
}

describe("persistBlogSourceLedger — standalone free-text fallback", () => {
  beforeEach(wipe);

  it("synthesizes a single 'operator-provided standalone' item when sourcePool is empty and sourceContent is non-trivial", () => {
    const postId = "blog_test_standalone_1";
    persistBlogSourceLedger({
      postId,
      topic: "Why agentic systems need an audit trail",
      sourceObjects: [],
      references: [],
      sourceContent:
        "Agent 306 is exploring why agentic systems need an audit trail. " +
        "Operator-provided thoughts: provenance is the missing link between " +
        "automation and accountability.",
    });

    const ledger = getLedgerByDraft("blog", postId);
    assert.ok(ledger, "ledger should exist");
    assert.equal(ledger!.items.length, 1, "should synthesize exactly one item");
    const item = ledger!.items[0];
    assert.match(item.url, /^internal:\/\/blog\/standalone\//, "synthetic url uses internal:// scheme");
    assert.equal(item.sourceType, "primary");
    assert.equal(item.trustTier, "unverified");
    assert.equal(item.publisher, "operator");
    assert.match(item.title ?? "", /Operator-provided standalone source/);
    assert.ok((item.excerpt ?? "").includes("provenance is the missing link"));
    const meta = JSON.parse(item.metadata ?? "{}");
    assert.equal(meta.origin, "standalone_freetext");
    assert.equal(meta.postId, postId);
    assert.equal(typeof meta.sourceContentLength, "number");
  });

  it("does NOT synthesize an item when sourceContent is empty / whitespace-only", () => {
    const postId = "blog_test_standalone_empty";
    persistBlogSourceLedger({
      postId,
      topic: "T",
      sourceObjects: [],
      references: [],
      sourceContent: "   \n\t  ",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.ok(ledger, "parent ledger row still created (idempotent upsert)");
    assert.equal(ledger!.items.length, 0, "no synthetic item for empty content");
  });

  it("does NOT synthesize an item when sourceContent is below the minimum length threshold", () => {
    const postId = "blog_test_standalone_tooshort";
    persistBlogSourceLedger({
      postId,
      topic: "T",
      sourceObjects: [],
      references: [],
      sourceContent: "tiny",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.ok(ledger);
    assert.equal(ledger!.items.length, 0);
  });

  it("does NOT synthesize an item when sourceContent is undefined (legacy callers preserved)", () => {
    const postId = "blog_test_standalone_undef";
    persistBlogSourceLedger({
      postId,
      topic: "T",
      sourceObjects: [],
      references: [],
      // sourceContent omitted — older call sites pre-PR threading
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.ok(ledger);
    assert.equal(ledger!.items.length, 0);
  });

  it("truncates very long sourceContent to a 2000-char excerpt with ellipsis", () => {
    const postId = "blog_test_standalone_long";
    const long = "x".repeat(5000);
    persistBlogSourceLedger({
      postId,
      topic: "T",
      sourceObjects: [],
      references: [],
      sourceContent: long,
    });
    const ledger = getLedgerByDraft("blog", postId);
    const item = ledger!.items[0];
    assert.ok(item, "synthetic item exists");
    assert.equal((item.excerpt ?? "").length, 2001, "2000 chars + 1-char ellipsis");
    assert.ok((item.excerpt ?? "").endsWith("…"));
  });

  it("synthetic url is filtered out by listLedgerSourceUrls so verifier never sees internal:// as a source URL", () => {
    const postId = "blog_test_standalone_urlfilter";
    persistBlogSourceLedger({
      postId,
      topic: "T",
      sourceObjects: [],
      references: [],
      sourceContent: "operator-provided standalone source content for the post.",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.equal(ledger!.items.length, 1);
    const urls = listLedgerSourceUrls(ledger!.items);
    assert.deepEqual(urls, [], "internal:// urls must not leak into the http(s)-only url list");
  });

  it("regression — sourceObjects with real URLs still produce normal items and NO synthetic item is appended", () => {
    const postId = "blog_test_url_path";
    const sourceObjects = [
      { url: "https://example.com/a", title: "A" } as any,
      { url: "https://example.com/b", title: "B" } as any,
    ];
    const researchPack = buildResearchPack("blog", sourceObjects);
    persistBlogSourceLedger({
      postId,
      topic: "T",
      sourceObjects,
      references: researchPack.references,
      sourceContent: "https://example.com/a covers it. Some operator commentary follows.",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.ok(ledger);
    assert.equal(ledger!.items.length, 2, "URL pool yields 2 items, no synthetic added");
    assert.equal(ledger!.items[0].sourceType, "primary");
    assert.equal(ledger!.items[1].sourceType, "supporting");
    for (const it of ledger!.items) {
      assert.match(it.url, /^https?:\/\//, "no synthetic internal:// item should be appended when real sources exist");
    }
  });

  it("publishBlogDraft (shared by legacy + pipeline) creates a ledger item for standalone free-text input on the HARD_FAIL/quarantine branch", () => {
    // Shared persistence: publishBlogDraft is called by BOTH the legacy
    // generateBlogPost path AND the BlogPipelineAdapter.publish() stage.
    // Driving it directly with a synthetic HARD_FAIL verdict exercises the
    // path that the live smoke test exercised on blog_1777773765780_rfes.
    const sourceContent =
      "Standalone operator-provided source content. No URLs, just an essay-style " +
      "thesis the operator wants the blog post grounded in.";
    const researchPack = buildResearchPack("blog", []);
    const verdict: ClaimVerdict = {
      ok: false,
      unsupportedClaims: [],
      supportedCount: 0,
      externalCitedCount: 0,
      severity: "HARD_FAIL",
      verifierReport: {
        severity: "HARD_FAIL",
        entries: [],
        summary: {
          laneAOk: 0,
          laneAFail: 0,
          laneAUnverifiable: 0,
          laneAPassQuotedCommentary: 0,
          laneAPassCritiqueByAbsence: 0,
          laneBOk: 0,
          laneBBare: 0,
          retractedHits: 0,
          ncitePatternHits: 0,
        },
      },
    } as any;
    const extraction = {
      claims: [],
      references: [],
      citationMap: {},
      editorComments: [],
      manualReviewRequired: false,
      manualPublishAllowed: true,
    } as any;
    const post = publishBlogDraft({
      topic: "Operator standalone topic",
      source: "standalone",
      sourceId: undefined,
      autoPublish: false,
      title: "Operator standalone post",
      revisedBody: "Body of the post.",
      tags: ["test"],
      verdict,
      extraction,
      researchPack,
      sourcePool: [],
      claimMapPromptItems: [],
      sourceContent,
    });
    assert.equal(post.status, "quarantined", "HARD_FAIL → quarantined preserved");

    const ledger = getLedgerByDraft("blog", post.id);
    assert.ok(ledger, "ledger row created for the quarantined post");
    assert.equal(ledger!.items.length, 1, "exactly one synthetic standalone item");
    const item = ledger!.items[0];
    assert.match(item.url, /^internal:\/\/blog\/standalone\//);
    assert.equal(item.publisher, "operator");
    assert.equal(item.trustTier, "unverified");
    assert.equal(item.sourceType, "primary");
    assert.ok((item.excerpt ?? "").includes("Standalone operator-provided"));
  });

  it("upsert behavior — re-running with the same draftId replaces the synthetic item", () => {
    const postId = "blog_test_standalone_upsert";
    persistBlogSourceLedger({
      postId,
      topic: "T1",
      sourceObjects: [],
      references: [],
      sourceContent: "first operator-provided pass with non-trivial length here.",
    });
    persistBlogSourceLedger({
      postId,
      topic: "T2",
      sourceObjects: [],
      references: [],
      sourceContent: "second operator-provided pass with different non-trivial text.",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.equal(ledger!.items.length, 1);
    assert.equal(ledger!.ledger.topic, "T2");
    assert.ok((ledger!.items[0].excerpt ?? "").includes("second"));
  });
});
