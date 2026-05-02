/**
 * Tests for the blog pipeline adapter + feature-flag entry (Roadmap B1).
 *
 * These tests verify:
 *   - The blog adapter's plan/source/claim stages are pure and reusable
 *     by the dry-run path.
 *   - generateBlogPostMaybeViaPipeline routes to the legacy path when the
 *     feature flag is OFF.
 *   - With the flag ON and dryRun=true, the entry runs the pipeline and
 *     emits stage events without invoking the writer.
 *   - With the flag OFF and dryRun=true, the entry surfaces a clear no-op
 *     (no behavioral surprise — dry-run is pipeline-only).
 *
 * No LLM credentials are set, so the writer-path tests would short-circuit
 * to null inside generateBlogPost. We assert on the pre-writer stages
 * (plan/source/claim) and on the publish-event presence.
 *
 * Run: npx tsx --test server/__tests__/blogPipelineAdapter.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-blog-pipeline-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";
// Force the no-LLM branch so the entry never tries to write a real blog
// post on the flag-on / non-dry-run path. The adapter still gets to
// exercise plan/source/claim before generateBlogPost short-circuits.
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { BlogPipelineAdapter } from "../pipeline/blogAdapter.js";
import { generateBlogPostMaybeViaPipeline } from "../pipeline/blogPipelineEntry.js";

function wipeEvents() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("BlogPipelineAdapter (Roadmap B1)", () => {
  beforeEach(wipeEvents);

  it("plan() returns the topic + blogType as draftHint", () => {
    const a = new BlogPipelineAdapter();
    const plan = a.plan({
      engine: "blog",
      topic: "AI safety",
      engineOpts: { source: "research", blogType: "external" },
    });
    assert.equal(plan.topic, "AI safety");
    assert.equal(plan.draftHint, "external");
  });

  it("plan() defaults draftHint to 'research' when blogType missing", () => {
    const a = new BlogPipelineAdapter();
    const plan = a.plan({ engine: "blog", topic: "x", engineOpts: { source: "standalone" } });
    assert.equal(plan.draftHint, "research");
  });

  it("assembleSourcePack() extracts URLs from sourceContent and merges sourceObjects", async () => {
    const a = new BlogPipelineAdapter();
    const plan = a.plan({ engine: "blog", topic: "x" });
    const result = await a.assembleSourcePack(plan, {
      engine: "blog",
      topic: "x",
      sourceContent: "Per https://example.com/a a thing happened.",
      engineOpts: {
        source: "research",
        sourceObjects: [
          { url: "https://example.com/b", title: "B", publisher: "P", evidenceExcerpt: "ex" } as any,
        ],
      },
    });
    const urls = result.sourcePool.map(s => s.url).sort();
    assert.deepEqual(urls, ["https://example.com/a", "https://example.com/b"]);
    assert.equal(result.researchPack.engine, "blog");
  });

  it("buildClaimMap() pre-assigns deterministic itemKeys (blog:1, blog:2, ...)", async () => {
    const a = new BlogPipelineAdapter();
    const plan = a.plan({ engine: "blog", topic: "AI" });
    const source = await a.assembleSourcePack(plan, {
      engine: "blog",
      topic: "AI",
      sourceContent: "Per https://example.com/a a thing happened.",
      engineOpts: { source: "research" },
    });
    const claim = a.buildClaimMap(plan, source, { engine: "blog", topic: "AI" });
    assert.ok(claim.items.length > 0);
    for (let i = 0; i < claim.items.length; i++) {
      assert.equal(claim.items[i].itemKey, `blog:${i + 1}`);
    }
  });
});

describe("generateBlogPostMaybeViaPipeline (Roadmap B1, feature flag)", () => {
  beforeEach(() => {
    wipeEvents();
    delete process.env.BLOG_PIPELINE_ENABLED;
  });

  it("flag OFF: legacy path; pipeline is null and no pipeline.* events emit", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "false";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Anything",
      sourceContent: "",
      source: "standalone",
    });
    // No LLM key set, so generateBlogPost returns null. The contract under
    // test is that pipeline is null on the legacy path.
    assert.equal(out.pipeline, null);
    assert.equal(out.post, null);
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const pipelineEvents = evs.filter(e => e.event.startsWith("pipeline."));
    assert.equal(pipelineEvents.length, 0, "no pipeline events should emit when flag is OFF");
  });

  it("flag OFF + dryRun=true: surfaces a no-op (dry-run is pipeline-only)", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "false";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Anything",
      sourceContent: "",
      source: "standalone",
      dryRun: true,
    });
    assert.equal(out.pipeline, null);
    assert.equal(out.post, null);
  });

  it("flag ON + dryRun=true: pipeline runs plan/source/claim and emits a publish event", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Routed via pipeline",
      sourceContent: "Per https://example.com/x a result was reported.",
      source: "research",
      blogType: "external",
      dryRun: true,
    });
    assert.ok(out.pipeline);
    assert.equal(out.pipeline!.dryRun, true);
    assert.equal(out.pipeline!.publish.skippedForDryRun, true);
    assert.equal(out.pipeline!.engine, "blog");
    assert.ok(out.pipeline!.source);
    assert.ok(out.pipeline!.claim);
    assert.equal(out.pipeline!.draft, undefined);

    // Event emission: source, claim, publish at minimum (no draft/verify
    // because dry-run skips them).
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const stageEvents = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage)
      .sort();
    assert.deepEqual(stageEvents, ["claim", "plan", "publish", "source"]);
  });

  it("flag ON + dryRun=true + the env reading is per-call, not at module load", async () => {
    // Toggle the flag mid-test to confirm the entry reads env at call time.
    process.env.BLOG_PIPELINE_ENABLED = "false";
    const a = await generateBlogPostMaybeViaPipeline({
      topic: "T", sourceContent: "", source: "standalone", dryRun: true,
    });
    assert.equal(a.pipeline, null);
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const b = await generateBlogPostMaybeViaPipeline({
      topic: "T", sourceContent: "", source: "standalone", dryRun: true,
    });
    assert.ok(b.pipeline, "flipping the flag mid-test should activate the pipeline path");
  });
});
