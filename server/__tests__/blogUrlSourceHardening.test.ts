/**
 * PR #266 — URL-source hardening tests.
 *
 * Background: live validation on 2026-05-03 produced a quarantined blog
 * post (`blog_1777810350622_lspp`) where the operator-provided arXiv URL
 * `https://arxiv.org/html/2510.05449v2` ended up persisted as the
 * synthetic standalone ledger item
 * (`internal://blog/standalone/<postId>`) instead of as a real URL
 * source_ledger_item. Root cause: the source assembly only extracted
 * URLs from `sourceContent` and the perplexity fresh-context blob — when
 * the operator pasted the URL into the Topic field and put free-text in
 * the optional Source Content, no URL ever reached `sourcePool` and the
 * PR #265 free-text fallback synthesized the standalone item.
 *
 * Fix: `assembleBlogSourcePack` now also extracts URLs from `topic` and
 * enriches URL-only SourceObjects with publisher (host) + an
 * evidenceExcerpt drawn from any operator free-text in `sourceContent`.
 * The publishing path then writes a real URL ledger item instead of
 * falling through to the synthetic item.
 *
 * What we do NOT want to regress:
 *   - True free-text input with no URL anywhere still gets the synthetic
 *     item (PR #265 behavior preserved).
 *   - Real http(s) URL pools never produce a synthetic item.
 *   - The synthetic url scheme stays filtered out of the http(s) URL
 *     list returned by `listLedgerSourceUrls`.
 *
 * Run: npx tsx --test server/__tests__/blogUrlSourceHardening.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-blog-url-source-"));
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
  assembleBlogSourcePack,
  persistBlogSourceLedger,
} from "../blogEngine.js";
import { buildResearchPack } from "../researchPack.js";

function wipe() {
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
}

describe("assembleBlogSourcePack — URL extraction from topic + sourceContent", () => {
  it("extracts the arXiv URL when it sits ONLY in the topic field (the live-validation regression)", async () => {
    const result = await assembleBlogSourcePack({
      topic: "https://arxiv.org/html/2510.05449v2",
      sourceContent: "Operator notes — please ground the post in this paper, focusing on the Bloom analysis.",
    });
    const urls = result.sourcePool.map(s => s.url);
    assert.ok(
      urls.includes("https://arxiv.org/html/2510.05449v2"),
      `expected arXiv url in sourcePool, got ${JSON.stringify(urls)}`,
    );
    const arxiv = result.sourcePool.find(s => s.url === "https://arxiv.org/html/2510.05449v2")!;
    assert.equal(arxiv.publisher, "arxiv.org", "publisher derived from URL host");
    assert.ok(arxiv.evidenceExcerpt && arxiv.evidenceExcerpt.includes("Bloom"),
      "evidenceExcerpt drawn from operator free-text in sourceContent");
  });

  it("extracts URLs from sourceContent (regression — pre-existing behavior preserved)", async () => {
    const result = await assembleBlogSourcePack({
      topic: "Why this paper matters",
      sourceContent: "See https://arxiv.org/html/2510.05449v2 for the full analysis.",
    });
    const urls = result.sourcePool.map(s => s.url);
    assert.ok(urls.includes("https://arxiv.org/html/2510.05449v2"));
  });

  it("extracts URLs from BOTH topic and sourceContent and dedupes them (mixed input)", async () => {
    const result = await assembleBlogSourcePack({
      topic: "https://arxiv.org/html/2510.05449v2",
      sourceContent:
        "Some operator framing. Also see https://arxiv.org/html/2510.05449v2 and https://example.org/related.",
    });
    const urls = result.sourcePool.map(s => s.url);
    assert.ok(urls.includes("https://arxiv.org/html/2510.05449v2"));
    assert.ok(urls.includes("https://example.org/related"));
    // Dedupe: arXiv URL should appear once, not twice.
    const arxivCount = urls.filter(u => u === "https://arxiv.org/html/2510.05449v2").length;
    assert.equal(arxivCount, 1);
  });

  it("emits no URLs when neither topic nor sourceContent contains one (preserves free-text fallback)", async () => {
    const result = await assembleBlogSourcePack({
      topic: "Why agentic systems need an audit trail",
      sourceContent: "Free-text essay-style operator input. No URLs at all here.",
    });
    assert.equal(result.sourcePool.length, 0);
  });

  it("populates publisher + title from URL host when no operator metadata is provided", async () => {
    const result = await assembleBlogSourcePack({
      topic: "https://www.nature.com/articles/d41586-026-00001-x",
      sourceContent: "Quick gloss on this paper.",
    });
    const item = result.sourcePool.find(s => /nature\.com/.test(s.url))!;
    assert.ok(item, "nature.com URL extracted from topic");
    assert.equal(item.publisher, "nature.com", "www. stripped, host used as publisher");
    assert.match(item.title ?? "", /Source at nature\.com/);
  });
});

describe("persistBlogSourceLedger end-to-end with URL-bearing topic", () => {
  beforeEach(wipe);

  it("URL-only sourceContent creates a real http(s) source_ledger_item, NOT the synthetic internal:// item", () => {
    const postId = "blog_test_url_only_content";
    const sourceObjects = [
      { url: "https://arxiv.org/html/2510.05449v2", title: "ArXiv paper", publisher: "arxiv.org" },
    ];
    const researchPack = buildResearchPack("blog", sourceObjects);
    persistBlogSourceLedger({
      postId,
      topic: "Bloom analysis paper",
      sourceObjects,
      references: researchPack.references,
      // The operator's sourceContent here was effectively just the URL —
      // by the time we reach persist, the assembly has already lifted it
      // into sourceObjects. We pass the URL through as sourceContent too
      // to assert the synthetic-fallback path is NOT taken when a real
      // source already exists.
      sourceContent: "https://arxiv.org/html/2510.05449v2",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.ok(ledger);
    assert.equal(ledger!.items.length, 1, "exactly one item, no synthetic appended");
    assert.equal(ledger!.items[0].url, "https://arxiv.org/html/2510.05449v2");
    for (const it of ledger!.items) {
      assert.doesNotMatch(it.url, /^internal:\/\//, "no internal:// item must be appended when a real URL is present");
    }
    const urls = listLedgerSourceUrls(ledger!.items);
    assert.deepEqual(urls, ["https://arxiv.org/html/2510.05449v2"]);
  });

  it("mixed free-text + URL sourceContent preserves the URL item AND does NOT fall back to synthetic-only", () => {
    const postId = "blog_test_mixed_content";
    const sourceObjects = [
      { url: "https://arxiv.org/html/2510.05449v2", title: "ArXiv paper" },
    ];
    const researchPack = buildResearchPack("blog", sourceObjects);
    persistBlogSourceLedger({
      postId,
      topic: "Bloom analysis",
      sourceObjects,
      references: researchPack.references,
      sourceContent:
        "Free-text operator framing — here is what I want grounded in the arXiv paper https://arxiv.org/html/2510.05449v2 with respect to Bloom.",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.equal(ledger!.items.length, 1, "URL item preserved, no synthetic appended");
    assert.equal(ledger!.items[0].url, "https://arxiv.org/html/2510.05449v2");
    assert.doesNotMatch(ledger!.items[0].url, /^internal:\/\//);
  });

  it("true standalone free-text (no URL anywhere) still creates the synthetic standalone item (PR #265 preserved)", () => {
    const postId = "blog_test_freetext_only";
    persistBlogSourceLedger({
      postId,
      topic: "Why agentic systems need an audit trail",
      sourceObjects: [],
      references: [],
      sourceContent:
        "Operator-provided thoughts: provenance is the missing link between automation and accountability. Long enough to clear the threshold.",
    });
    const ledger = getLedgerByDraft("blog", postId);
    assert.equal(ledger!.items.length, 1);
    assert.match(ledger!.items[0].url, /^internal:\/\/blog\/standalone\//);
    assert.equal(ledger!.items[0].publisher, "operator");
  });
});
