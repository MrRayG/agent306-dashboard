/**
 * Regression tests for the `[LINK]` placeholder substitution in
 * podcastEngine.ts. Prior to the fix, `[LINK]` tokens returned by the LLM
 * were leaking directly into queued X/Farcaster podcast promos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSocialLinks, PODCAST_SITE_URL } from "../podcastEngine.js";

test("resolveSocialLinks replaces a single [LINK] with the default site url", () => {
  const input = "New episode drops today. Listen here: [LINK]";
  const out = resolveSocialLinks(input);
  assert.equal(out, `New episode drops today. Listen here: ${PODCAST_SITE_URL}`);
  assert.equal(PODCAST_SITE_URL, "agent306.ai");
  assert.ok(!out.includes("[LINK]"));
});

test("resolveSocialLinks replaces every [LINK] occurrence (thread form)", () => {
  const thread = [
    "1/ Thread. Find the episode here: [LINK]",
    "2/ Here's the key idea.",
    "3/ Full breakdown: [LINK]",
    "4/ Share with a friend — [LINK]",
  ].join("\n");
  const out = resolveSocialLinks(thread);
  assert.ok(!out.includes("[LINK]"));
  const matches = out.match(/agent306\.ai/g) ?? [];
  assert.equal(matches.length, 3);
});

test("resolveSocialLinks accepts a custom site url override", () => {
  const out = resolveSocialLinks("Listen: [LINK]", "agent306.ai/ep/42");
  assert.equal(out, "Listen: agent306.ai/ep/42");
});

test("resolveSocialLinks is a no-op when no placeholder is present", () => {
  const input = "Just a normal promo with no link placeholder.";
  assert.equal(resolveSocialLinks(input), input);
});

test("resolveSocialLinks handles empty / falsy text safely", () => {
  assert.equal(resolveSocialLinks(""), "");
  // @ts-expect-error — callers sometimes pass undefined from optional metadata
  assert.equal(resolveSocialLinks(undefined), undefined);
});

test("resolveSocialLinks does not mangle bracketed content other than [LINK]", () => {
  const input = "[306 Podcast] New ep [draft]. Listen: [LINK]. Tag: [signal]";
  const out = resolveSocialLinks(input);
  assert.equal(out, "[306 Podcast] New ep [draft]. Listen: agent306.ai. Tag: [signal]");
});

test("resolveSocialLinks is case-sensitive — lowercase [link] is NOT substituted", () => {
  // The prompt contract is specifically `[LINK]` uppercase. We should not
  // accidentally rewrite user-authored lowercase bracket text.
  const input = "See the [link] in bio vs. our canonical [LINK]";
  const out = resolveSocialLinks(input);
  assert.equal(out, "See the [link] in bio vs. our canonical agent306.ai");
});
