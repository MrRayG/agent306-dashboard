/**
 * Regression test for the 2026-04-20 [306 ACADEMY] tweet incident.
 *
 * Failure mode: the Deep Read (article) engine received a truncated JSON
 * response from the LLM. safeParseLLMJson returned {}. The fallback path
 * in generateDeepReadArticle treated the raw JSON string as the article
 * body, and postArticleToX published `[306 ACADEMY] {  "headline": "...",
 * "teaser": "..."` verbatim to X.
 *
 * This test pins the guard behavior so it cannot silently regress:
 *   1. looksLikeRawJsonPayload() must flag tweets that start with a JSON
 *      object whose keys match known LLM schema field names.
 *   2. queueXPost() must refuse to enqueue such payloads.
 *   3. Normal prose tweets (including ones that happen to contain braces
 *      or a single JSON-ish phrase) must still pass.
 *
 * Run: npx tsx --test server/__tests__/rawJsonPayloadGuard.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRawJsonPayload } from "../postFormatGuard.js";
import { queueXPost } from "../xPostScheduler.js";

describe("looksLikeRawJsonPayload", () => {
  it("flags the exact 2026-04-20 Academy incident payload", () => {
    // Reconstructed from the user's screenshot of the broken tweet.
    const bad =
      '{  "headline": "The 27-Year-Old Flaw That Should Make Us Rethink AI Safety", ' +
      '"teaser": "Anthropic built an AI that quietly unearthed a vulnerability ignored since 1999. ' +
      'They locked it away. The NSA kept using it anywa';
    assert.equal(looksLikeRawJsonPayload(bad), true);
  });

  it("flags JSON payloads even when prefixed with a valid show tag", () => {
    // Mirrors the shape of the tweet as rendered on X after the show tag
    // was prepended by ensureShowTag().
    const bad =
      '[306 ACADEMY] {  "headline": "Something", "teaser": "Some teaser text"}';
    assert.equal(looksLikeRawJsonPayload(bad), true);
  });

  it("flags the Academy engine's { post, dashboardNarrative, headline } schema", () => {
    const bad =
      '{"post": "[306 ACADEMY] Hello world", "dashboardNarrative": "longer version", "headline": "short"}';
    assert.equal(looksLikeRawJsonPayload(bad), true);
  });

  it("does not flag normal prose tweets that mention JSON words", () => {
    const good =
      '[306 ACADEMY] A large language model is not a database. It is a compressed map of language. ' +
      'The word "teaser" appears in marketing, not in the model weights.\n\n— Agent 306';
    assert.equal(looksLikeRawJsonPayload(good), false);
  });

  it("does not flag prose that starts with a brace in rhetoric", () => {
    // A tweet that happens to start with `{` in a stylistic way but is not JSON.
    const good = '{Think of it this way}: the transformer is attention, not recurrence.';
    assert.equal(looksLikeRawJsonPayload(good), false);
  });

  it("does not flag a single JSON key phrase appearing in prose", () => {
    // One schema-ish key in prose should not trip the guard (need >= 2).
    const good = 'The "body" of the model is the architecture; the weights are the soul.';
    assert.equal(looksLikeRawJsonPayload(good), false);
  });

  it("handles empty and whitespace input", () => {
    assert.equal(looksLikeRawJsonPayload(""), false);
    assert.equal(looksLikeRawJsonPayload("   "), false);
  });
});

describe("queueXPost JSON payload guard", () => {
  it("throws when called with a raw JSON payload (regression guard)", () => {
    const bad =
      '{"headline": "The 27-Year-Old Flaw", "teaser": "Anthropic built an AI..."}';
    assert.throws(
      () => queueXPost(bad, "academy", 6),
      /raw JSON payload/,
    );
  });

  it("throws when the payload is JSON with a [306 ACADEMY] show-tag prefix", () => {
    const bad =
      '[306 ACADEMY] {"headline": "X", "teaser": "Y", "body": "Z"}';
    assert.throws(
      () => queueXPost(bad, "academy", 6),
      /raw JSON payload/,
    );
  });
});
