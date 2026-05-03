/**
 * Tests for the Article pipeline adapter + feature-flag entry (Roadmap B3).
 *
 * What this verifies:
 *   - The Article adapter's plan/source/claim stages are pure and reusable
 *     by the dry-run path (no LLM key required).
 *   - generateArticleMaybeViaPipeline returns flagDisabled=true when the
 *     flag is OFF — so legacy callers can cleanly fall back without
 *     branching on env directly.
 *   - With the flag ON and dryRun=true (and prefetched articleInfo +
 *     articleContent), the entry runs the pipeline and emits stage events
 *     without invoking the writer.
 *   - The pipeline.* events written to engine_events use engine='article'
 *     and carry a stable pipelineRunId across stages.
 *
 * No LLM credentials are set, so the writer-path tests would short-circuit
 * inside compileDraft. We assert on the pre-writer stages (plan/source/
 * claim) and on the publish-event presence.
 *
 * Run: npx tsx --test server/__tests__/articlePipelineAdapter.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(process.cwd(), "tmp-article-pipeline-"));
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.DATA_DIR = TMP_DIR;
process.env.NODE_ENV = "test";
// Force the no-LLM branch so the entry never tries to write a real
// article. The adapter still exercises plan/source/claim before the
// writer would short-circuit.
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;

import { db } from "../db.js";
import { engineEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { ArticlePipelineAdapter } from "../pipeline/articleAdapter.js";
import { generateArticleMaybeViaPipeline } from "../pipeline/articlePipelineEntry.js";

const PRIMARY = {
  title: "Sample AI breakthrough",
  url: "https://example.com/article-x",
  summary: "A sample summary of the article. Specific facts.",
  source: "example.com",
  publishedDate: "2026-05-01",
};
const PRIMARY_CONTENT = `
This is a long article body about the AI breakthrough. ${"More text. ".repeat(80)}
A reference URL appears here: https://acme.org/research
A second reference URL: https://other.example.org/study
`;

function wipeEvents() {
  try { db.delete(engineEvents).run(); } catch {}
}

describe("ArticlePipelineAdapter (Roadmap B3)", () => {
  beforeEach(wipeEvents);

  it("plan() echoes the prefetched articleInfo and sets draftHint='deep_read'", async () => {
    const a = new ArticlePipelineAdapter();
    const plan = await a.plan({
      engine: "article",
      topic: PRIMARY.title,
      engineOpts: {
        articleInfo: PRIMARY,
        articleContent: PRIMARY_CONTENT,
      },
    });
    assert.equal(plan.topic, PRIMARY.title);
    assert.equal(plan.draftHint, "deep_read");
  });

  it("assembleSourcePack() anchors on the primary article and harvests body URLs", async () => {
    const a = new ArticlePipelineAdapter();
    const plan = await a.plan({
      engine: "article",
      topic: PRIMARY.title,
      engineOpts: { articleInfo: PRIMARY, articleContent: PRIMARY_CONTENT },
    });
    const result = await a.assembleSourcePack(plan, { engine: "article", topic: PRIMARY.title });
    const urls = result.sourcePool.map(s => s.url).sort();
    assert.ok(urls.includes(PRIMARY.url), "primary article url must appear in pool");
    assert.ok(urls.includes("https://acme.org/research"), "body url must be harvested");
    assert.ok(urls.includes("https://other.example.org/study"), "second body url must be harvested");
    assert.equal(result.researchPack.engine, "deep_read");
  });

  it("buildClaimMap() pre-assigns deterministic itemKeys (article:1, article:2, ...)", async () => {
    const a = new ArticlePipelineAdapter();
    const plan = await a.plan({
      engine: "article",
      topic: PRIMARY.title,
      engineOpts: { articleInfo: PRIMARY, articleContent: PRIMARY_CONTENT },
    });
    const source = await a.assembleSourcePack(plan, { engine: "article", topic: PRIMARY.title });
    const claim = a.buildClaimMap(plan, source, { engine: "article", topic: PRIMARY.title });
    assert.ok(claim.items.length > 0, "claim map should have at least one item");
    for (let i = 0; i < claim.items.length; i++) {
      assert.equal(claim.items[i].itemKey, `article:${i + 1}`);
    }
  });
});

describe("generateArticleMaybeViaPipeline (Roadmap B3, feature flag)", () => {
  beforeEach(() => {
    wipeEvents();
    delete process.env.ARTICLE_PIPELINE_ENABLED;
  });

  it("flag OFF: returns flagDisabled=true and emits no pipeline events", async () => {
    process.env.ARTICLE_PIPELINE_ENABLED = "false";
    const out = await generateArticleMaybeViaPipeline({
      apiKey: "",
      articleInfo: PRIMARY,
      articleContent: PRIMARY_CONTENT,
    });
    assert.equal(out.flagDisabled, true);
    assert.equal(out.pipeline, null);
    assert.equal(out.draft, null);
    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "article")).all();
    const pipelineEvents = evs.filter(e => e.event.startsWith("pipeline."));
    assert.equal(pipelineEvents.length, 0, "no pipeline events should emit when flag is OFF");
  });

  it("flag OFF + dryRun=true: still returns flagDisabled=true (dry-run is pipeline-only)", async () => {
    process.env.ARTICLE_PIPELINE_ENABLED = "false";
    const out = await generateArticleMaybeViaPipeline({
      apiKey: "",
      articleInfo: PRIMARY,
      articleContent: PRIMARY_CONTENT,
      dryRun: true,
    });
    assert.equal(out.flagDisabled, true);
    assert.equal(out.pipeline, null);
  });

  it("flag ON + dryRun=true: pipeline runs plan/source/claim and emits a publish event", async () => {
    process.env.ARTICLE_PIPELINE_ENABLED = "true";
    const out = await generateArticleMaybeViaPipeline({
      apiKey: "",
      articleInfo: PRIMARY,
      articleContent: PRIMARY_CONTENT,
      dryRun: true,
    });
    assert.equal(out.flagDisabled, false);
    assert.ok(out.pipeline);
    assert.equal(out.pipeline!.dryRun, true);
    assert.equal(out.pipeline!.engine, "article");
    assert.equal(out.pipeline!.publish.skippedForDryRun, true);
    assert.ok(out.pipeline!.source);
    assert.ok(out.pipeline!.claim);
    assert.equal(out.pipeline!.draft, undefined);
    assert.equal(out.draft, null, "dry-run does not persist a draft");

    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "article")).all();
    const stageEvents = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage)
      .sort();
    assert.deepEqual(stageEvents, ["claim", "plan", "publish", "source"]);
  });

  it("flag ON: env reading is per-call, not at module load", async () => {
    process.env.ARTICLE_PIPELINE_ENABLED = "false";
    const a = await generateArticleMaybeViaPipeline({
      apiKey: "",
      articleInfo: PRIMARY,
      articleContent: PRIMARY_CONTENT,
      dryRun: true,
    });
    assert.equal(a.flagDisabled, true);
    process.env.ARTICLE_PIPELINE_ENABLED = "true";
    const b = await generateArticleMaybeViaPipeline({
      apiKey: "",
      articleInfo: PRIMARY,
      articleContent: PRIMARY_CONTENT,
      dryRun: true,
    });
    assert.equal(b.flagDisabled, false, "flipping the flag mid-test should activate the pipeline path");
    assert.ok(b.pipeline);
  });

  it("flag ON, no LLM, non-dry-run: emits plan/source/claim/draft(fail)/publish(fail)", async () => {
    process.env.ARTICLE_PIPELINE_ENABLED = "true";
    const out = await generateArticleMaybeViaPipeline({
      apiKey: "", // no key → compileArticleDraft returns null
      articleInfo: PRIMARY,
      articleContent: PRIMARY_CONTENT,
    });
    assert.equal(out.flagDisabled, false);
    assert.ok(out.pipeline);
    assert.equal(out.pipeline!.dryRun, false);
    assert.equal(out.pipeline!.publish.published, false);
    assert.equal(out.pipeline!.publish.skippedForDryRun, false);
    // No persisted draft because draft stage failed.
    assert.equal(out.draft, null);

    const evs = db.select().from(engineEvents).where(eq(engineEvents.engine, "article")).all();
    const stages = evs
      .map(e => ({ ...e, parsed: JSON.parse(e.data) as any }))
      .filter(e => e.parsed.pipelineRunId === out.pipeline!.pipelineRunId)
      .map(e => e.parsed.stage);
    // plan/source/claim succeed; draft fails; publish gets a failure row.
    assert.ok(stages.includes("plan"), "plan event missing");
    assert.ok(stages.includes("source"), "source event missing");
    assert.ok(stages.includes("claim"), "claim event missing");
    assert.ok(stages.includes("draft"), "draft event missing");
    assert.ok(stages.includes("publish"), "publish event missing");
  });
});

describe("Article pipeline structural guards", () => {
  function readFile(rel: string): string {
    return fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
  }

  it("featureFlags.ts declares articlePipelineEnabled", () => {
    const src = readFile("server/featureFlags.ts");
    assert.ok(
      src.includes("articlePipelineEnabled"),
      "featureFlags.ts must declare articlePipelineEnabled",
    );
    assert.ok(
      src.includes('flagOn("ARTICLE_PIPELINE_ENABLED")'),
      "featureFlags.ts must read ARTICLE_PIPELINE_ENABLED via flagOn()",
    );
  });

  it("articleEngine.ts gates pipeline routing on readArticlePipelineFlag", () => {
    const src = readFile("server/articleEngine.ts");
    assert.ok(
      src.includes("readArticlePipelineFlag"),
      "articleEngine.ts must gate pipeline routing on readArticlePipelineFlag",
    );
    assert.ok(
      src.includes("generateArticleMaybeViaPipeline"),
      "articleEngine.ts must route through generateArticleMaybeViaPipeline when the flag is on",
    );
  });

  it("article adapter wires the per-stage helpers, not a god-mode end-to-end function", () => {
    const src = readFile("server/pipeline/articleAdapter.ts");
    assert.ok(src.includes("assembleArticleSourcePack"), "assembleArticleSourcePack helper must be wired in");
    assert.ok(src.includes("buildArticleClaimMapAssembly"), "buildArticleClaimMapAssembly helper must be wired in");
    assert.ok(src.includes("compileArticleDraft"), "compileArticleDraft helper must be wired in");
    assert.ok(src.includes("verifyAndRepairArticleDraft"), "verifyAndRepairArticleDraft helper must be wired in");
    assert.ok(src.includes("publishArticleDraft"), "publishArticleDraft helper must be wired in");
  });

  it("article adapter delegates to per-stage helpers (no direct call to runWeeklyDeepRead/previewDeepRead)", () => {
    const src = readFile("server/pipeline/articleAdapter.ts");
    const directRunCall = src.match(/\brunWeeklyDeepRead\s*\(/g);
    assert.equal(directRunCall, null, "articleAdapter must not call runWeeklyDeepRead directly");
    const directPreviewCall = src.match(/\bpreviewDeepRead\s*\(/g);
    assert.equal(directPreviewCall, null, "articleAdapter must not call previewDeepRead directly");
  });
});
