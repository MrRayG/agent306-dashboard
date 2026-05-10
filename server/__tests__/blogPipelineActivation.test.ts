/**
 * Tests for Roadmap B2 — blog pipeline activation at call sites.
 *
 * What we verify here that blogPipelineAdapter.test.ts does not:
 *   - Flag ON + non-dry-run: the entry runs the FULL stage sequence and
 *     emits plan/source/claim/draft/publish events. No LLM key is set, so
 *     the draft stage fails inside the adapter — that's still the
 *     contract: a failure event is emitted and a publish row is written
 *     so the dashboard never has a half-finished pipeline run.
 *   - The wiring at known call sites (routes.ts /api/blog/generate,
 *     dailyCycleEngine, chat-action `generate_blog`) goes through the
 *     entry. We assert this structurally: each of those modules imports
 *     `generateBlogPostMaybeViaPipeline` from `pipeline/blogPipelineEntry`
 *     and does NOT call `generateBlogPost` directly anymore.
 *
 * Run: npx tsx --test server/__tests__/blogPipelineActivation.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB isolation. ESM hoists static imports to the top, so any
// `import { db } from "../db.js"` here runs BEFORE the env writes below
// and the `db.ts` singleton opens at the default `data/agent306.db`. With
// `--test-concurrency` > 1 (CI default behavior) multiple test files race
// on that shared DB and `wipeEvents()` in one process clears events that
// another process expects to read. Dynamic imports defer module loading
// until after `process.env.DB_PATH` / `DATA_DIR` are set, so each test
// file gets its own SQLite file. Same pattern as
// hypothesisDecisionEvents.test.ts and academyEngine.test.ts.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "blog-activation-test-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

const { db } = await import("../db.js");
const { engineEvents } = await import("@shared/schema");
const { eq } = await import("drizzle-orm");
const { generateBlogPostMaybeViaPipeline } = await import(
  "../pipeline/blogPipelineEntry.js"
);

function wipeEvents() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("blog pipeline activation — flag ON, non-dry-run, no-LLM", () => {
  beforeEach(() => {
    wipeEvents();
    delete process.env.BLOG_PIPELINE_ENABLED;
  });

  it("emits plan/source/claim/draft(fail)/publish(fail) when generateBlogPost has no LLM key", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "true";
    const out = await generateBlogPostMaybeViaPipeline({
      topic: "Activation smoke test",
      sourceContent: "Per https://example.com/x a result was reported.",
      source: "research",
      blogType: "external",
    });
    // No LLM → adapter's compileDraft throws, pipeline records failure.
    assert.equal(out.post, null);
    assert.ok(out.pipeline, "pipeline should run on flag-ON path even when LLM key missing");
    assert.equal(out.pipeline!.dryRun, false);
    assert.equal(out.pipeline!.publish.published, false);
    assert.equal(out.pipeline!.publish.skippedForDryRun, false);

    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const stages = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage);
    // Plan/source/claim succeed; draft fails; publish gets a failure row.
    assert.ok(stages.includes("plan"), "plan event missing");
    assert.ok(stages.includes("source"), "source event missing");
    assert.ok(stages.includes("claim"), "claim event missing");
    assert.ok(stages.includes("draft"), "draft event missing");
    assert.ok(stages.includes("publish"), "publish event missing");
  });

  it("legacy path (flag OFF) does NOT emit any pipeline.* events on the same call shape", async () => {
    process.env.BLOG_PIPELINE_ENABLED = "false";
    await generateBlogPostMaybeViaPipeline({
      topic: "Activation smoke test (legacy)",
      sourceContent: "Per https://example.com/x a result was reported.",
      source: "research",
      blogType: "external",
    });
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "blog")).all();
    const pipelineEvs = evs.filter(e => e.event.startsWith("pipeline."));
    assert.equal(pipelineEvs.length, 0, "no pipeline events should emit when flag is OFF");
  });
});

describe("blog pipeline activation — call-site wiring (structural)", () => {
  // Structural checks rather than runtime mocking: each known blog call
  // site must route through the feature-flagged entry. If a future PR
  // adds another `generateBlogPost(...)` direct call, this test will
  // fail and force the author to either route it through the entry or
  // intentionally exempt it here. Catches the most common regression
  // mode for B2 (a new blog code path that bypasses the flag).
  function readFile(rel: string): string {
    return fs.readFileSync(
      path.join(process.cwd(), rel),
      "utf-8",
    );
  }

  it("dailyCycleEngine routes through generateBlogPostMaybeViaPipeline", () => {
    const src = readFile("server/dailyCycleEngine.ts");
    assert.ok(
      src.includes("generateBlogPostMaybeViaPipeline"),
      "dailyCycleEngine should import generateBlogPostMaybeViaPipeline",
    );
    // No bare `generateBlogPost(` call (only the import-via-pipeline ref).
    assert.equal(
      /[^a-zA-Z]generateBlogPost\(/.test(src),
      false,
      "dailyCycleEngine should not call generateBlogPost() directly",
    );
  });

  it("routes.ts /api/blog/generate routes through the entry", () => {
    const src = readFile("server/routes.ts");
    assert.ok(
      src.includes("generateBlogPostMaybeViaPipeline"),
      "routes.ts should import generateBlogPostMaybeViaPipeline",
    );
    // chat-action `generate_blog` uses dynamic import so the regex
    // catches both the static-import call site and the dynamic-import
    // call site. We allow `generateBlogPost` only as a substring of
    // `generateBlogPostMaybeViaPipeline`.
    const directCall = src.match(/[^a-zA-Z]generateBlogPost\(/g);
    assert.equal(
      directCall,
      null,
      "routes.ts should not call generateBlogPost() directly",
    );
  });
});
