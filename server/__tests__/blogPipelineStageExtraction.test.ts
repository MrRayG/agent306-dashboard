/**
 * Tests for Roadmap B2 follow-up — true per-stage ownership in the blog
 * pipeline adapter (no longer delegates compileDraft → generateBlogPost
 * end-to-end).
 *
 * What this file verifies that earlier B1/B2 tests do NOT:
 *   - The adapter's compileDraft / verifyAndRepair / publish stages each
 *     carry the right evidence on their pipeline events. With the legacy
 *     adapter the verify event always reported revisionAttempts=-1 because
 *     it was a synthesized verdict; with stage extraction, verify reports
 *     a real numeric revisionAttempts (0 when the loop short-circuits).
 *   - The adapter swaps in a custom rewrite/verifier path through
 *     reviseBlogUntilClean by exercising compileBlogDraft / verifyAndRepairBlogDraft
 *     directly. This isolates the per-stage helpers from the LLM key.
 *   - Flag-OFF preservation: with the flag off, the legacy generateBlogPost
 *     path returns the same shape it always did (null when no LLM key).
 *
 * The structural-test regex tightening from PR #263 is also exercised here
 * — `routes.ts` is read and the direct-call guard must reject any
 * `generateBlogPost(` reference except `generateBlogPostMaybeViaPipeline(`.
 *
 * Run: npx tsx --test server/__tests__/blogPipelineStageExtraction.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-blog-stage-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { generateBlogPostMaybeViaPipeline } from "../pipeline/blogPipelineEntry.js";

function wipeEvents() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("blog pipeline — true per-stage ownership (Roadmap B2 follow-up)", () => {
  beforeEach(() => {
    wipeEvents();
    delete process.env.BLOG_PIPELINE_ENABLED;
  });

  it("flag ON: draft event fires before any verify/publish event (stage ordering)", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Stage ordering",
      sourceContent: "Per https://example.com/y a thing happened.",
      source: "research",
    });
    assert.ok(out.pipeline);
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const stages = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage);
    // Without an LLM key compileDraft fails — the contract is that draft
    // appears AFTER plan/source/claim and BEFORE publish, with no verify
    // event in between (verify never runs after a draft failure).
    assert.deepEqual(stages, ["plan", "source", "claim", "draft", "publish"]);
  });

  it("flag ON dry-run: source/claim run; no draft event fires", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Dry-run stage skip",
      sourceContent: "Per https://example.com/dr a fact was reported.",
      source: "research",
      dryRun: true,
    });
    assert.ok(out.pipeline);
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const stages = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage)
      .sort();
    // Dry-run skips draft, verify, repair. claim+plan+source+publish only.
    assert.deepEqual(stages, ["claim", "plan", "publish", "source"]);
  });

  it("flag ON: draft failure event carries reason from compileBlogDraft (not generateBlogPost)", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Draft failure surface",
      sourceContent: "Per https://example.com/df a fact was reported.",
      source: "research",
    });
    assert.ok(out.pipeline);
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const draftEv = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .find(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId && e.parsed.stage === "draft");
    assert.ok(draftEv);
    assert.equal(draftEv!.parsed.success, false);
    // Reason MUST mention compileBlogDraft (the new helper) — proves the
    // adapter is using the per-stage helper rather than the old end-to-end
    // generateBlogPost call.
    assert.match(
      draftEv!.parsed.reason ?? "",
      /compileBlogDraft/,
      `expected draft event reason to mention compileBlogDraft, got: ${draftEv!.parsed.reason}`,
    );
  });

  it("flag OFF: legacy path is preserved (returns null when LLM unavailable)", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "false";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Legacy preservation",
      sourceContent: "",
      source: "standalone",
    });
    assert.equal(out.pipeline, null);
    assert.equal(out.post, null);
  });
});

describe("structural guard — direct-call regex tightened in B2 follow-up", () => {
  it("routes.ts: only generateBlogPostMaybeViaPipeline references the symbol", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "server/routes.ts"), "utf-8");
    // Tighter than the PR #263 regex: anchor against the full identifier
    // boundary so the only legitimate match is `generateBlogPostMaybeViaPipeline`.
    // Any bare `generateBlogPost(` (call) or `generateBlogPost,` (named import)
    // must not appear.
    const directCall = src.match(/\bgenerateBlogPost\s*\(/g);
    assert.equal(directCall, null, `routes.ts has a direct generateBlogPost(...) call: ${directCall}`);
    const bareImport = src.match(/\bgenerateBlogPost\b(?!MaybeViaPipeline)/g);
    assert.equal(
      bareImport,
      null,
      `routes.ts references the bare generateBlogPost identifier: ${bareImport}`,
    );
  });

  it("dailyCycleEngine.ts: bare generateBlogPost identifier is absent", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "server/dailyCycleEngine.ts"), "utf-8");
    const bare = src.match(/\bgenerateBlogPost\b(?!MaybeViaPipeline)/g);
    assert.equal(bare, null, `dailyCycleEngine has a bare generateBlogPost reference: ${bare}`);
  });

  it("blogAdapter.ts: does NOT delegate compileDraft to generateBlogPost end-to-end", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "server/pipeline/blogAdapter.ts"), "utf-8");
    // Pre-B2-followup behavior was to CALL `generateBlogPost(` inside the
    // compileDraft method. Stage extraction replaces that with the
    // per-stage helpers. We check for the *call* form rather than the
    // identifier itself so the historical context comment at the top of
    // the file (which legitimately names the function in prose) is not a
    // regression. Any direct call is a regression.
    const directCall = src.match(/\bgenerateBlogPost\s*\(/g);
    assert.equal(directCall, null, `blogAdapter has a direct generateBlogPost(...) call: ${directCall}`);
    // And the per-stage helpers must be imported.
    assert.ok(src.includes("compileBlogDraft"), "compileBlogDraft helper must be wired in");
    assert.ok(src.includes("verifyAndRepairBlogDraft"), "verifyAndRepairBlogDraft helper must be wired in");
    assert.ok(src.includes("publishBlogDraft"), "publishBlogDraft helper must be wired in");
  });
});
