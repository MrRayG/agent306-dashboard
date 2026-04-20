/**
 * Regression tests for show-tag routing across every content type.
 *
 * Pins the guarantee that every engine's posts publish with the correct
 * [306 XXX] / [THE DISPATCH] show tag prefix. Catches two prior bugs:
 *
 *   1. Deep Read (articleEngine) was passing contentType="research" to
 *      enforcePostFormat(), which mapped via FALLBACK_SHOW_TAGS["research"]
 *      to [306 ACADEMY]. Deep Read posts should be tagged [306 ARTICLE].
 *   2. Breakthrough and blog posts had no entry in CONTENT_TYPES or
 *      FALLBACK_SHOW_TAGS, so enforcePostFormat() returned the body with
 *      no tag prepended. They are now registered canonically and render
 *      as [306 BREAKTHROUGH] and [306 BLOG].
 *
 * Run: npx tsx --test server/__tests__/showTagRouting.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enforcePostFormat } from "../postFormatGuard.js";
import { getShowTag, CONTENT_TYPES } from "../contentTypes.js";

function tagOf(text: string): string {
  return text.match(/^\[[^\]]+\]/)?.[0] ?? "";
}

describe("show-tag routing per engine", () => {
  it("real Academy engine renders [306 ACADEMY]", () => {
    const out = enforcePostFormat("Teaching through analogy. — Agent 306", "academy");
    assert.equal(tagOf(out), "[306 ACADEMY]");
  });

  it("Deep Read (article) renders [306 ARTICLE], not [306 ACADEMY]", () => {
    // Regression: the 2026-04-20 incident was rendered as [306 ACADEMY]
    // because articleEngine passed "research" instead of "article".
    const out = enforcePostFormat(
      "Teaser text. [Read the full Deep Read ↓] — Agent 306",
      "article",
    );
    assert.equal(tagOf(out), "[306 ARTICLE]");
    assert.notEqual(tagOf(out), "[306 ACADEMY]");
  });

  it("research briefs and CYOA keep the legacy [306 ACADEMY] alias", () => {
    // "research" is intentionally aliased to [306 ACADEMY] via
    // FALLBACK_SHOW_TAGS — research briefs (routes.ts) and the CYOA
    // engine depend on this. Pin it so it does not regress.
    const out = enforcePostFormat("Research brief body. — Agent 306", "research");
    assert.equal(tagOf(out), "[306 ACADEMY]");
  });

  it("Signal renders [306 SIGNAL]", () => {
    const out = enforcePostFormat("Three labs shipped. — Agent 306", "signal");
    assert.equal(tagOf(out), "[306 SIGNAL]");
  });

  it("News renders [306 NEWS]", () => {
    const out = enforcePostFormat("Anthropic released. — Agent 306", "news");
    assert.equal(tagOf(out), "[306 NEWS]");
  });

  it("Reflection renders [306 REFLECTION]", () => {
    const out = enforcePostFormat("Thinking out loud. — Agent 306", "reflection");
    assert.equal(tagOf(out), "[306 REFLECTION]");
  });

  it("Dispatch renders [THE DISPATCH]", () => {
    const out = enforcePostFormat("One signal, two sides. — Agent 306", "dispatch");
    assert.equal(tagOf(out), "[THE DISPATCH]");
  });

  it("Roundup renders [306 ROUNDUP]", () => {
    const out = enforcePostFormat("Weekly pulse. — Agent 306", "roundup");
    assert.equal(tagOf(out), "[306 ROUNDUP]");
  });

  it("Breakthrough renders [306 BREAKTHROUGH] (regression — was untagged)", () => {
    const out = enforcePostFormat("Major model released. — Agent 306", "breakthrough");
    assert.equal(tagOf(out), "[306 BREAKTHROUGH]");
  });

  it("Blog renders [306 BLOG] (regression — was untagged)", () => {
    const out = enforcePostFormat(
      "New blog post: https://agent306.ai/blog/x — Agent 306",
      "blog",
    );
    assert.equal(tagOf(out), "[306 BLOG]");
  });

  it("Podcast renders [306 PODCAST]", () => {
    const out = enforcePostFormat("New episode. Listen: https://... — Agent 306", "podcast");
    assert.equal(tagOf(out), "[306 PODCAST]");
  });

  it("an already-tagged post is preserved (does not double-tag)", () => {
    const preTagged = "[306 SIGNAL] Three labs shipped.\n\n— Agent 306";
    const out = enforcePostFormat(preTagged, "breakthrough");
    // Pre-tagged [306 SIGNAL] is a valid tag, so enforcePostFormat should
    // leave it alone rather than replacing with the contentType's default.
    assert.equal(tagOf(out), "[306 SIGNAL]");
  });
});

describe("contentTypes registry consistency", () => {
  it("every registered content type has a [306 XXX] or [THE X] show tag", () => {
    for (const [id, ct] of Object.entries(CONTENT_TYPES)) {
      assert.match(
        ct.showTag,
        /^\[(306 [A-Z]+|THE [A-Z]+)\]$/,
        `content type "${id}" has malformed showTag "${ct.showTag}"`,
      );
    }
  });

  it("getShowTag() resolves every canonical queue type", () => {
    // These are the queue types every engine/dailyCycle/scheduler path uses.
    const queueTypes = [
      "news", "signal", "academy", "article", "podcast", "dispatch",
      "reflection", "roundup", "blog", "breakthrough",
    ];
    for (const qt of queueTypes) {
      const tag = getShowTag(qt);
      assert.match(tag, /^\[.+\]$/, `queue type "${qt}" produced no show tag`);
    }
  });
});
