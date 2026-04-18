/**
 * Tests for the voice exemplar few-shot helper.
 *
 * These confirm:
 *   - getTopPerformers returns at most `limit` Exemplars
 *   - returned Exemplars have non-empty title + excerpt
 *   - formatExemplarBlock produces the expected "## Your best recent" header
 *     so the blog/article/podcast/reply prompts include it consistently
 *   - empty-history case returns [] and formatExemplarBlock returns ""
 *     (graceful degradation — critical on first deploy with no data)
 *
 * Run: npx tsx --test server/__tests__/voiceExemplars.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getTopPerformers,
  formatExemplarBlock,
  buildExemplarBlock,
  type Exemplar,
} from "../voiceExemplars.js";

describe("getTopPerformers", () => {
  it("returns at most `limit` exemplars for blog", async () => {
    const out = await getTopPerformers({ contentType: "blog", limit: 3 });
    assert.ok(Array.isArray(out));
    assert.ok(out.length <= 3, `expected <= 3, got ${out.length}`);
    for (const e of out) {
      assert.ok(typeof e.title === "string" && e.title.length > 0, "non-empty title");
      assert.ok(typeof e.excerpt === "string" && e.excerpt.length > 0, "non-empty excerpt");
    }
  });

  it("returns at most `limit` exemplars for article", async () => {
    const out = await getTopPerformers({ contentType: "article", limit: 3 });
    assert.ok(Array.isArray(out));
    assert.ok(out.length <= 3);
    for (const e of out) {
      assert.ok(typeof e.title === "string" && e.title.length > 0);
      assert.ok(typeof e.excerpt === "string" && e.excerpt.length > 0);
    }
  });

  it("returns at most `limit` exemplars for podcast", async () => {
    const out = await getTopPerformers({ contentType: "podcast", limit: 3 });
    assert.ok(Array.isArray(out));
    assert.ok(out.length <= 3);
    for (const e of out) {
      assert.ok(typeof e.title === "string" && e.title.length > 0);
      assert.ok(typeof e.excerpt === "string" && e.excerpt.length > 0);
    }
  });

  it("returns at most `limit` exemplars for reply", async () => {
    const out = await getTopPerformers({ contentType: "reply", limit: 3 });
    assert.ok(Array.isArray(out));
    assert.ok(out.length <= 3);
    for (const e of out) {
      assert.ok(typeof e.title === "string" && e.title.length > 0);
      assert.ok(typeof e.excerpt === "string" && e.excerpt.length > 0);
    }
  });

  it("clamps limit to sane bounds", async () => {
    const huge = await getTopPerformers({ contentType: "blog", limit: 1000 });
    assert.ok(huge.length <= 10);
  });
});

// ── formatExemplarBlock ──────────────────────────────────────────────────────

describe("formatExemplarBlock", () => {
  const sample: Exemplar[] = [
    {
      title: "21 Patients: When Neuralink Stopped Being an Experiment",
      excerpt: "One hundred thousand electrodes. Twenty-one human brains. The number that matters is not FDA approval.",
      why_it_worked: "hook: concrete number collapsed into one arresting sentence",
    },
    {
      title: "The Quiet Week GPT-5 Landed",
      excerpt: "It did not break the internet. That is the news.",
      why_it_worked: "counterintuitive hook",
    },
  ];

  it("includes the canonical blog header when exemplars are present", () => {
    const out = formatExemplarBlock(sample, "blog");
    assert.ok(out.includes("## Your best recent blog work"), "blog header present");
    assert.ok(out.includes("21 Patients"), "first title present");
    assert.ok(out.includes("Opening:"), "opening label present");
    assert.ok(out.includes("Why it worked:"), "why_it_worked label present");
    assert.ok(out.includes("Now write a new blog"), "closing directive present");
  });

  it("uses the right noun for replies (plural form)", () => {
    const out = formatExemplarBlock(sample, "reply");
    assert.ok(out.includes("## Your best recent replies"), "reply header present");
    assert.ok(out.includes("Now write a new reply"), "closing directive present");
  });

  it("returns empty string for empty input (graceful degradation)", () => {
    assert.equal(formatExemplarBlock([], "blog"), "");
    assert.equal(formatExemplarBlock([], "article"), "");
    assert.equal(formatExemplarBlock([], "podcast"), "");
    assert.equal(formatExemplarBlock([], "reply"), "");
  });

  it("omits the why_it_worked line when not provided", () => {
    const partial: Exemplar[] = [{ title: "Bare title", excerpt: "Bare excerpt." }];
    const out = formatExemplarBlock(partial, "article");
    assert.ok(out.includes("Bare title"));
    assert.ok(!out.includes("Why it worked:"), "no why_it_worked line when absent");
  });
});

// ── buildExemplarBlock (integration) ─────────────────────────────────────────

describe("buildExemplarBlock", () => {
  it("returns '' when no history OR a valid header when history exists", async () => {
    const out = await buildExemplarBlock({ contentType: "blog", limit: 3 });
    // Either empty (fresh deploy / no data in test environment) or includes the header.
    // Both are valid — this is the graceful-degradation contract.
    if (out.length > 0) {
      assert.ok(out.startsWith("## Your best recent blog work"));
    }
  });

  it("returns coherent string for every content type", async () => {
    for (const ct of ["blog", "article", "podcast", "reply"] as const) {
      const out = await buildExemplarBlock({ contentType: ct, limit: 3 });
      assert.equal(typeof out, "string");
      if (out.length > 0) {
        assert.ok(out.includes("## Your best recent"), `header present for ${ct}`);
      }
    }
  });
});
