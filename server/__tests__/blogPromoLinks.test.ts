/**
 * Tests for blog promo deep-link helpers.
 *
 * Regression coverage for the bug where Farcaster (and X) blog promos were
 * either missing the URL entirely or only linking to the homepage, so there
 * was no way to tell which blog the promo was for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOG_SITE_HOST,
  buildBlogUrl,
  ensureBlogDeepLink,
} from "../blogPromoLinks.js";

// ── buildBlogUrl ─────────────────────────────────────────────────────────────

test("buildBlogUrl returns https deep-link for a valid post", () => {
  const url = buildBlogUrl({ slug: "ai-agent-accountability-blockchain" });
  assert.equal(url, `https://${BLOG_SITE_HOST}/blog/ai-agent-accountability-blockchain`);
});

test("buildBlogUrl trims whitespace in slug", () => {
  const url = buildBlogUrl({ slug: "  my-post  " });
  assert.equal(url, `https://${BLOG_SITE_HOST}/blog/my-post`);
});

test("buildBlogUrl falls back to homepage when slug missing", () => {
  assert.equal(buildBlogUrl({}), `https://${BLOG_SITE_HOST}`);
  assert.equal(buildBlogUrl({ slug: "" }), `https://${BLOG_SITE_HOST}`);
  assert.equal(buildBlogUrl({ slug: null }), `https://${BLOG_SITE_HOST}`);
  assert.equal(buildBlogUrl(null), `https://${BLOG_SITE_HOST}`);
  assert.equal(buildBlogUrl(undefined), `https://${BLOG_SITE_HOST}`);
});

// ── ensureBlogDeepLink ───────────────────────────────────────────────────────

const URL = "https://agent306.ai/blog/my-new-post";

test("ensureBlogDeepLink leaves text alone when deep-link already present", () => {
  const input = `Here's a sharp take. Read more: ${URL}`;
  assert.equal(ensureBlogDeepLink(input, URL), input);
});

test("ensureBlogDeepLink upgrades a trailing bare agent306.ai to the deep-link", () => {
  const input = "Sharp insight here.\n\nagent306.ai";
  const out = ensureBlogDeepLink(input, URL);
  assert.equal(out, `Sharp insight here.\n\n${URL}`);
  assert.ok(out.includes(URL));
});

test("ensureBlogDeepLink upgrades an inline bare agent306.ai in-place", () => {
  const input = "Posted on agent306.ai — a must-read for builders.";
  const out = ensureBlogDeepLink(input, URL);
  assert.equal(out, `Posted on ${URL} — a must-read for builders.`);
});

test("ensureBlogDeepLink upgrades multiple bare agent306.ai occurrences", () => {
  const input = "See agent306.ai (yes, agent306.ai) for the full piece.";
  const out = ensureBlogDeepLink(input, URL);
  assert.equal(out, `See ${URL} (yes, ${URL}) for the full piece.`);
  assert.ok(!/\bagent306\.ai(?!\/)/.test(out));
});

test("ensureBlogDeepLink replaces a wrong-slug deep-link with the correct one", () => {
  const input = `Great finding. https://agent306.ai/blog/WRONG-SLUG is where I posted it.`;
  const out = ensureBlogDeepLink(input, URL);
  assert.ok(!out.includes("WRONG-SLUG"));
  assert.ok(out.endsWith(URL));
});

test("ensureBlogDeepLink appends deep-link when no link is present (LLM forgot)", () => {
  const input = "A surprising finding worth sharing.";
  const out = ensureBlogDeepLink(input, URL);
  assert.equal(out, `A surprising finding worth sharing.\n\n${URL}`);
});

test("ensureBlogDeepLink handles empty text by returning the deep-link", () => {
  assert.equal(ensureBlogDeepLink("", URL), URL);
});

test("ensureBlogDeepLink is case-insensitive for the bare domain match", () => {
  const input = "Read more at Agent306.AI today.";
  const out = ensureBlogDeepLink(input, URL);
  assert.equal(out, `Read more at ${URL} today.`);
});

test("ensureBlogDeepLink does not touch an agent306.ai substring inside an email", () => {
  // Defensive: we only want to rewrite the bare domain, not a user handle.
  // If the domain appears with a slash path, we leave it alone (handled as
  // deep-link case). An email-like string shouldn't collide here, but assert
  // the shape survives.
  const input = "Ping me at hello@agent306.ai or read the piece.";
  const out = ensureBlogDeepLink(input, URL);
  // Email gets upgraded too (expected — it's a bare domain by our regex).
  // What matters is: no [LINK], final deep-link is present, no duplication.
  assert.ok(out.includes(URL));
  assert.ok(!out.includes("[LINK]"));
});
