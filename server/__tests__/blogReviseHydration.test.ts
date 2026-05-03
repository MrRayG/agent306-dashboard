/**
 * PR #266 — manual revise source-context hydration tests.
 *
 * Background: live validation on 2026-05-03 ran a manual revise on the
 * arXiv-URL quarantined post (`blog_1777810350622_lspp`). The revise
 * still hard-failed with `no source text provided to verify
 * attribution` — even though a `source_ledger` row existed for that
 * draft. Root cause: `reviseQuarantinedBlogPost` always passed
 * `sourceText: ""` and `sourceObjects: []` to the revise loop on the
 * theory that the original sources were unavailable at quarantine time.
 * That theory was true before the source ledger landed in PR #259; once
 * the ledger exists, the manual revise path can read it.
 *
 * Fix: `reviseQuarantinedBlogPost` now calls `buildReviseSourceContext`
 * which reads `getLedgerByDraft('blog', postId)`, composes the
 * verifier-friendly source bundle via `buildSourceContextForVerifier`,
 * and forwards both the sourceText and the http(s) source URLs to the
 * revise loop. Verifier strictness is unchanged — Lane B bare claims
 * are still softened/dropped when no citation target is available; the
 * change is purely "stop passing empty source context when we have it".
 *
 * Tests target the pure helper directly to stay hermetic — the wider
 * revise loop has its own coverage in blogReviseLoop.test.ts.
 *
 * Run: npx tsx --test server/__tests__/blogReviseHydration.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pr-266-revise-hydration-"));
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = "test";

import { db } from "../db.js";
import { sourceLedger, sourceLedgerItems } from "@shared/schema";
import { buildReviseSourceContext } from "../blogRevisePipeline.js";
import { persistBlogSourceLedger } from "../blogEngine.js";

function wipeLedger() {
  try { db.delete(sourceLedgerItems).run(); } catch {}
  try { db.delete(sourceLedger).run(); } catch {}
}

describe("buildReviseSourceContext — source ledger hydration (PR #266)", () => {
  beforeEach(wipeLedger);

  it("hydrates sourceText, sourceObjects, and extraSourceUrls from a URL-bearing ledger", () => {
    const postId = "blog_test_url_ledger";
    persistBlogSourceLedger({
      postId,
      topic: "Bloom analysis",
      sourceObjects: [
        {
          url: "https://arxiv.org/html/2510.05449v2",
          title: "ArXiv 2510.05449v2",
          publisher: "arxiv.org",
          evidenceExcerpt: "Operator notes about the Bloom analysis paper.",
        } as any,
      ],
      references: [],
      sourceContent: "Operator notes about the Bloom analysis paper.",
    });

    const ctx = buildReviseSourceContext({
      postId,
      postContent: "# Body\n\nSome content with [arXiv](https://arxiv.org/html/2510.05449v2).",
      postTitle: "Bloom analysis post",
    });

    assert.notEqual(ctx.sourceText, "", "sourceText hydrated from ledger, not empty");
    assert.match(ctx.sourceText, /arxiv\.org/i,
      "ledger publisher reaches the verifier source bundle");
    assert.match(ctx.sourceText, /Bloom analysis paper/,
      "ledger excerpt reaches the verifier source bundle");
    assert.equal(ctx.sourceUrl, "https://arxiv.org/html/2510.05449v2",
      "primary source url forwarded");
    assert.equal(ctx.sourceTitle, "ArXiv 2510.05449v2",
      "primary source title forwarded");
    assert.equal(ctx.sourceObjects.length, 1,
      "ledger source object forwarded");
    assert.equal(ctx.sourceObjects[0].url, "https://arxiv.org/html/2510.05449v2");
    assert.ok(
      ctx.extraSourceUrls.includes("https://arxiv.org/html/2510.05449v2"),
      "ledger url merged into extraSourceUrls citation pool",
    );
  });

  it("filters synthetic internal:// ledger items out of sourceObjects + extraSourceUrls (legacy free-text posts)", () => {
    const postId = "blog_test_freetext_ledger";
    persistBlogSourceLedger({
      postId,
      topic: "Free-text topic",
      sourceObjects: [],
      references: [],
      sourceContent:
        "Operator-provided thoughts. Long enough to clear the threshold for synthesis.",
    });

    const ctx = buildReviseSourceContext({
      postId,
      postContent: "# Body\n\nSome content.",
      postTitle: "Free-text post",
    });

    assert.notEqual(ctx.sourceText, "",
      "sourceText still hydrated from synthetic excerpt — gives verifier real evidence");
    assert.match(ctx.sourceText, /Operator-provided thoughts/);
    assert.equal(ctx.sourceObjects.length, 0,
      "synthetic internal:// items are filtered from sourceObjects");
    assert.equal(ctx.sourceUrl, "",
      "primary source url stays empty when only synthetic exists");
    const hasInternal = ctx.extraSourceUrls.some(u => u.startsWith("internal://"));
    assert.equal(hasInternal, false,
      "internal:// must never appear in extraSourceUrls — the rewriter would otherwise try to cite it");
  });

  it("falls back to the legacy empty-source posture when no ledger exists for the post", () => {
    const ctx = buildReviseSourceContext({
      postId: "blog_no_ledger_present",
      postContent: "# Body\n\nSome content with [arXiv](https://arxiv.org/abs/2510.05449).",
      postTitle: "Legacy post without ledger",
    });

    assert.equal(ctx.sourceText, "",
      "no ledger → empty sourceText (legacy posture preserved)");
    assert.equal(ctx.sourceObjects.length, 0);
    assert.equal(ctx.sourceUrl, "");
    assert.equal(ctx.sourceTitle, "Legacy post without ledger",
      "falls back to post title when no ledger primary");
    assert.ok(
      ctx.extraSourceUrls.includes("https://arxiv.org/abs/2510.05449"),
      "body-embedded URLs still feed the rewriter via extraSourceUrls",
    );
  });

  it("merges body-embedded URLs with ledger URLs and dedupes", () => {
    const postId = "blog_test_merge_urls";
    persistBlogSourceLedger({
      postId,
      topic: "Mixed",
      sourceObjects: [
        { url: "https://arxiv.org/html/2510.05449v2" } as any,
      ],
      references: [],
      sourceContent: "An operator note.",
    });

    const ctx = buildReviseSourceContext({
      postId,
      postContent:
        "# Body\n\nSee [arXiv](https://arxiv.org/html/2510.05449v2) and https://example.org/related.",
      postTitle: "Mixed",
    });

    const arxivCount = ctx.extraSourceUrls.filter(u => u === "https://arxiv.org/html/2510.05449v2").length;
    assert.equal(arxivCount, 1, "ledger + body URL deduped to a single entry");
    assert.ok(ctx.extraSourceUrls.includes("https://example.org/related"));
  });
});
