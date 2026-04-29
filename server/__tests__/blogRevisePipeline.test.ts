// PR #252 — smoke tests for blogRevisePipeline.
//
// Narrow scope: cover the no-LLM branches of reviseQuarantinedBlogPost so we
// know the pipeline returns the right outcome shape without standing up the
// claim verifier. We use a hermetic DATA_DIR so blogEngine's persistence
// stays isolated.
//
// We do NOT mock the rewrite/verifier LLM here — the wider revise loop has
// its own coverage in blogReviseLoop.test.ts. The two cases below exercise
// the pipeline's pre-LLM short-circuits.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pr-252-revise-"));
process.env.DATA_DIR = TMP_DIR;

const { reviseQuarantinedBlogPost } = await import("../blogRevisePipeline.js");
const { createBlogPost, publishPost } = await import("../blogEngine.js");

describe("reviseQuarantinedBlogPost — pre-LLM short-circuits", () => {
  it("returns outcome=error with found=false for a post id that does not exist", async () => {
    const result = await reviseQuarantinedBlogPost("does-not-exist-id");
    assert.equal(result.found, false);
    assert.equal(result.outcome, "error");
    assert.equal(result.error, "post-not-found");
  });

  it("returns outcome=no_action for a post that is already published", async () => {
    const post = createBlogPost({
      title: "Already Published",
      content: "# Already Published\n\nSome body content.",
      source: "standalone",
      status: "draft",
    });
    publishPost(post.id);

    const result = await reviseQuarantinedBlogPost(post.id);
    assert.equal(result.found, true);
    assert.equal(result.outcome, "no_action");
    assert.equal(result.error, "already-published");
    assert.equal(result.postId, post.id);
  });

  it("returns outcome=no_action for a draft with no verifierReport (can't revise without a verdict)", async () => {
    const post = createBlogPost({
      title: "Draft Without Report",
      content: "# Draft\n\nSome body content.",
      source: "standalone",
      status: "draft",
    });

    const result = await reviseQuarantinedBlogPost(post.id);
    assert.equal(result.found, true);
    assert.equal(result.outcome, "no_action");
    assert.equal(result.error, "no-verifier-report-on-post");
  });
});
