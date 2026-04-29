/**
 * Tests for the optional sources field on BlogPost (PR #253).
 *
 * Per Ray's voice-tier reframe: blogs aren't articles or research papers,
 * so citations are optional and never gate publishing. When a writer (or
 * 306 herself) does want to cite, the persisted `sources` field gets
 * rendered as a "## Sources" markdown section appended to the body —
 * but only at fetch time via renderBlogContent(). Admin reads keep the
 * raw editable body.
 *
 * Run: npx tsx --test server/__tests__/blogEngine.sources.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point dataPath at a temp dir so blog state writes don't leak into the
// repo's data dir. Must happen BEFORE the blogEngine import — it captures
// the filename at module load.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blog-sources-test-"));
process.env.DATA_DIR = tmpRoot;

import {
  createBlogPost,
  updatePost,
  getPostById,
  renderBlogContent,
} from "../blogEngine.js";

describe("renderBlogContent — Sources section appending", () => {
  it("returns content unchanged when sources is undefined", () => {
    const out = renderBlogContent({
      content: "Body text only.",
    });
    assert.equal(out, "Body text only.");
  });

  it("returns content unchanged when sources is an empty array", () => {
    const out = renderBlogContent({
      content: "Body text only.",
      sources: [],
    });
    assert.equal(out, "Body text only.");
  });

  it("appends a '## Sources' section when sources is non-empty", () => {
    const out = renderBlogContent({
      content: "Body text.",
      sources: [
        { url: "https://example.com/a", title: "Source A" },
        { url: "https://example.com/b" },
      ],
    });
    assert.match(out, /## Sources/);
    assert.match(out, /\[Source A\]\(https:\/\/example\.com\/a\)/);
    // Source without title should fall back to the URL as the label.
    assert.match(out, /\[https:\/\/example\.com\/b\]\(https:\/\/example\.com\/b\)/);
  });

  it("preserves the body verbatim before the Sources section", () => {
    const body = "First paragraph.\n\nSecond paragraph with **bold**.";
    const out = renderBlogContent({
      content: body,
      sources: [{ url: "https://example.com" }],
    });
    assert.ok(out.startsWith(body), "body prefix should be preserved");
    assert.ok(out.indexOf("## Sources") > body.length);
  });
});

describe("createBlogPost / updatePost — sources field persistence", () => {
  it("createBlogPost persists a non-empty sources array", () => {
    const post = createBlogPost({
      title: "Voice Post With Citations",
      content: "Some thoughts.",
      source: "standalone",
      sources: [{ url: "https://example.com/cited", title: "Cited Source" }],
    });
    const read = getPostById(post.id);
    assert.ok(read);
    assert.deepEqual(read!.sources, [{ url: "https://example.com/cited", title: "Cited Source" }]);
  });

  it("createBlogPost omits the sources field when none are provided", () => {
    const post = createBlogPost({
      title: "Voice Post No Citations",
      content: "Just my voice.",
      source: "standalone",
    });
    const read = getPostById(post.id);
    assert.ok(read);
    assert.equal(read!.sources, undefined);
  });

  it("updatePost can add sources to a post that had none", () => {
    const post = createBlogPost({
      title: "Add Sources Later",
      content: "Initial body.",
      source: "standalone",
    });
    const updated = updatePost(post.id, {
      sources: [{ url: "https://example.com/added" }],
    });
    assert.ok(updated);
    assert.deepEqual(updated!.sources, [{ url: "https://example.com/added" }]);
  });

  it("updatePost can clear sources by passing an empty array", () => {
    const post = createBlogPost({
      title: "Clear Sources",
      content: "Body.",
      source: "standalone",
      sources: [{ url: "https://example.com/initial" }],
    });
    const updated = updatePost(post.id, { sources: [] });
    assert.ok(updated);
    assert.equal(updated!.sources, undefined);
  });
});

describe("renderBlogContent — integration with createBlogPost", () => {
  it("rendered output includes Sources when the post has them, omits when it does not", () => {
    const cited = createBlogPost({
      title: "Cited",
      content: "Body cited.",
      source: "standalone",
      sources: [{ url: "https://example.com/x", title: "X" }],
    });
    const uncited = createBlogPost({
      title: "Uncited",
      content: "Body uncited.",
      source: "standalone",
    });
    assert.match(renderBlogContent(cited), /## Sources/);
    assert.equal(renderBlogContent(uncited).includes("## Sources"), false);
  });
});
