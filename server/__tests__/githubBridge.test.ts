/**
 * Tests for server/githubBridge.ts (issue 6b)
 *
 * Drives the real-PR flow with a mock fetch that captures the requests so
 * we don't hit api.github.com. Verifies:
 *   - parseUnifiedDiff handles modify, new file, and delete cases.
 *   - applyHunks reconstructs the expected content for a modify.
 *   - openDraftPr (with AGENT306_GH_TOKEN) walks branch → contents → pull.
 *   - openDraftPr without AGENT306_GH_TOKEN falls back to writePatchFile.
 *
 * Run: npx tsx --test server/__tests__/githubBridge.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

// Tests use a temp DB (selfRecommendationEngine.attachArtifact reads/writes
// rows). Setting DB_PATH before any import isolates state from the real DB.
const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-bridgedb-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";

import { parseUnifiedDiff, applyHunks, openDraftPr, writePatchFile, type FetchLike } from "../githubBridge.js";
import { proposeRecommendation, approveRecommendation, getRecommendation } from "../selfRecommendationEngine.js";

const SAMPLE_MODIFY_DIFF = `diff --git a/src/sample.ts b/src/sample.ts
index 1111111..2222222 100644
--- a/src/sample.ts
+++ b/src/sample.ts
@@ -1,4 +1,5 @@
 line one
 line two
-line three
+line three (modified)
+line three.5
 line four
`;

const SAMPLE_NEWFILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const NEW = true;
+export const VERSION = 2;
+
`;

const SAMPLE_DELETE_DIFF = `diff --git a/src/dead.ts b/src/dead.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/dead.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const GONE = true;
-
`;

describe("parseUnifiedDiff", () => {
  it("parses a modify diff", () => {
    const files = parseUnifiedDiff(SAMPLE_MODIFY_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/sample.ts");
    assert.equal(files[0].isNew, false);
    assert.equal(files[0].isDeleted, false);
    assert.equal(files[0].hunks.length, 1);
    assert.ok(files[0].hunks[0].lines.length >= 4);
  });
  it("flags new files", () => {
    const files = parseUnifiedDiff(SAMPLE_NEWFILE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/new.ts");
    assert.equal(files[0].isNew, true);
  });
  it("flags deleted files", () => {
    const files = parseUnifiedDiff(SAMPLE_DELETE_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/dead.ts");
    assert.equal(files[0].isDeleted, true);
  });
  it("parses multiple files in one diff", () => {
    const files = parseUnifiedDiff(SAMPLE_MODIFY_DIFF + "\n" + SAMPLE_NEWFILE_DIFF);
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "src/sample.ts");
    assert.equal(files[1].path, "src/new.ts");
  });
});

describe("applyHunks", () => {
  it("applies a modify hunk", () => {
    const original = "line one\nline two\nline three\nline four\n";
    const files = parseUnifiedDiff(SAMPLE_MODIFY_DIFF);
    const out = applyHunks(original, files[0]);
    assert.equal(out, "line one\nline two\nline three (modified)\nline three.5\nline four\n");
  });
  it("creates a new file from /dev/null", () => {
    const files = parseUnifiedDiff(SAMPLE_NEWFILE_DIFF);
    const out = applyHunks("", files[0]);
    // The diff has three +-prefixed lines including a trailing blank, and
    // parseUnifiedDiff normalizes blank lines to context-space; both produce
    // a final "" entry, leaving us with one trailing blank line on output.
    assert.equal(
      out.replace(/\n+$/, "\n"),
      "export const NEW = true;\nexport const VERSION = 2;\n",
    );
  });
  it("returns empty for a deleted file", () => {
    const files = parseUnifiedDiff(SAMPLE_DELETE_DIFF);
    const out = applyHunks("export const GONE = true;\n", files[0]);
    assert.equal(out, "");
  });
});

describe("openDraftPr — fallback path", () => {
  beforeEach(() => { delete process.env.AGENT306_GH_TOKEN; });
  afterEach(() => { delete process.env.AGENT306_GH_TOKEN; });

  it("returns kind=patch when AGENT306_GH_TOKEN is unset", async () => {
    const rec = proposeRecommendation({
      category: "engine",
      title: "test fallback",
      rationale: "no token configured",
      proposedChange: "noop",
      proposedDiff: SAMPLE_MODIFY_DIFF,
    });
    approveRecommendation(rec.id, "tester");
    const fresh = getRecommendation(rec.id)!;
    const result = await openDraftPr(fresh);
    assert.equal(result.kind, "patch");
    assert.ok(result.patchPath, "patch file should be written");
    assert.ok(fs.existsSync(result.patchPath!), "patch file should exist on disk");
  });
});

describe("openDraftPr — real-PR flow", () => {
  beforeEach(() => {
    process.env.AGENT306_GH_TOKEN = "ghs_fake_token";
    process.env.AGENT306_GH_REPO = "TestOwner/test-repo";
    process.env.AGENT306_GH_BASE = "main";
  });
  afterEach(() => {
    delete process.env.AGENT306_GH_TOKEN;
    delete process.env.AGENT306_GH_REPO;
    delete process.env.AGENT306_GH_BASE;
  });

  it("creates a branch, commits each file, opens a draft PR", async () => {
    const calls: Array<{ method: string; url: string; body?: any }> = [];

    const fetchMock: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      let parsedBody: any;
      try { parsedBody = init?.body ? JSON.parse(init.body) : undefined; } catch { parsedBody = undefined; }
      calls.push({ method, url, body: parsedBody });

      // Authorization header sanity-check.
      if (init?.headers) {
        const auth = (init.headers as any)["Authorization"] ?? (init.headers as any)["authorization"];
        assert.match(auth ?? "", /^Bearer ghs_fake_token$/);
      }

      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return mockJson(200, { object: { sha: "deadbeef" } });
      }
      if (method === "POST" && url.endsWith("/git/refs")) {
        assert.equal(parsedBody.sha, "deadbeef");
        assert.match(parsedBody.ref, /^refs\/heads\/agent306\/self-rec-/);
        return mockJson(201, { ref: parsedBody.ref });
      }
      if (method === "GET" && url.includes("/contents/src/sample.ts")) {
        const content = Buffer.from("line one\nline two\nline three\nline four\n", "utf8").toString("base64");
        return mockJson(200, { content, sha: "filesha1" });
      }
      if (method === "PUT" && url.includes("/contents/src/sample.ts")) {
        assert.equal(parsedBody.sha, "filesha1");
        assert.equal(parsedBody.branch.startsWith("agent306/self-rec-"), true);
        const newContent = Buffer.from(parsedBody.content, "base64").toString("utf8");
        assert.equal(newContent, "line one\nline two\nline three (modified)\nline three.5\nline four\n");
        return mockJson(200, { content: { sha: "newsha" } });
      }
      if (method === "POST" && url.endsWith("/pulls")) {
        assert.equal(parsedBody.draft, true);
        assert.equal(parsedBody.base, "main");
        assert.match(parsedBody.head, /^agent306\/self-rec-/);
        return mockJson(201, { html_url: "https://github.com/TestOwner/test-repo/pull/42", number: 42 });
      }
      return mockJson(404, { message: `unmocked ${method} ${url}` });
    };

    const rec = proposeRecommendation({
      category: "engine",
      title: "real PR flow test",
      rationale: "test creates branch + PR via REST",
      proposedChange: "modify sample.ts",
      proposedDiff: SAMPLE_MODIFY_DIFF,
    });
    approveRecommendation(rec.id, "tester");
    const fresh = getRecommendation(rec.id)!;

    const result = await openDraftPr(fresh, { fetchImpl: fetchMock });
    assert.equal(result.kind, "pr");
    assert.equal(result.prUrl, "https://github.com/TestOwner/test-repo/pull/42");
    assert.match(result.branch ?? "", /^agent306\/self-rec-/);

    // Should still write the audit patch file.
    assert.ok(result.patchPath && fs.existsSync(result.patchPath));

    // Sequence: ref read → branch create → contents read → contents put → pull create.
    const sequence = calls.map(c => `${c.method} ${c.url.replace(/^https:\/\/api\.github\.com/, "")}`);
    assert.match(sequence[0], /GET \/repos\/TestOwner\/test-repo\/git\/ref\/heads\/main/);
    assert.match(sequence[1], /POST \/repos\/TestOwner\/test-repo\/git\/refs/);
    assert.ok(sequence.some(s => s.startsWith("GET /repos/TestOwner/test-repo/contents/src/sample.ts")));
    assert.ok(sequence.some(s => s.startsWith("PUT /repos/TestOwner/test-repo/contents/src/sample.ts")));
    assert.ok(sequence.some(s => s === "POST /repos/TestOwner/test-repo/pulls"));

    // Verify the rec now carries the PR URL.
    const after = getRecommendation(rec.id)!;
    assert.equal(after.prUrl, "https://github.com/TestOwner/test-repo/pull/42");
  });

  it("falls back gracefully when GitHub returns an error mid-flow", async () => {
    const fetchMock: FetchLike = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return mockJson(404, { message: "Branch not found" });
      }
      return mockJson(500, { message: "unexpected" });
    };

    const rec = proposeRecommendation({
      category: "engine",
      title: "fallback when github errors",
      rationale: "stub",
      proposedChange: "noop",
      proposedDiff: SAMPLE_MODIFY_DIFF,
    });
    approveRecommendation(rec.id, "tester");
    const fresh = getRecommendation(rec.id)!;
    const result = await openDraftPr(fresh, { fetchImpl: fetchMock });
    assert.equal(result.kind, "patch");
    assert.ok(result.reason && result.reason.startsWith("github flow failed"));
    // Compare URL stub should still be attached.
    assert.match(result.prUrl ?? "", /\/compare\//);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function mockJson(status: number, body: any): any {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 201 ? "Created" : status === 404 ? "Not Found" : "Error",
    text: async () => text,
    json: async () => body,
  };
}
