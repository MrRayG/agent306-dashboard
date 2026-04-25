/**
 * Tests for server/sourceFetcher.ts
 *
 * Covers partial-fetch detection for the long-form allowlist domains
 * (added 2026-04-25 after a partial-fetch audit finding) and the
 * pre-existing bot-wall detection.
 *
 * The tests monkey-patch global.fetch so no network traffic leaves the
 * process. Perplexity is disabled by clearing PERPLEXITY_API_KEY — any
 * partial/bot-wall response falls through to method='failed'.
 *
 * Run: npx tsx --test server/__tests__/sourceFetcher.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Disable all network providers — we drive global.fetch directly.
delete process.env.PERPLEXITY_API_KEY;
delete process.env.GROK_API_KEY;
delete process.env.XAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

import {
  fetchSourceContent,
  detectPartialFetch,
  LONG_FORM_DOMAINS,
} from "../sourceFetcher.js";

// ── fetch stub helpers ─────────────────────────────────────────────────────

const realFetch = global.fetch;

function stubFetch(response: { status?: number; body: string }): void {
  const status = response.status ?? 200;
  global.fetch = (async (_url: any, _init?: any) => {
    return {
      ok:    status >= 200 && status < 300,
      status,
      text:  async () => response.body,
      json:  async () => JSON.parse(response.body),
    } as any;
  }) as any;
}

before(() => {
  // baseline noop
});

after(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  global.fetch = realFetch;
});

// ── detectPartialFetch unit tests (pure function) ──────────────────────────

describe("detectPartialFetch", () => {
  it("flags too_short_for_domain for a long-form domain with <1500 char body", () => {
    const url  = "https://www.politico.com/news/2026/04/22/something-00887869";
    const html = "<html><head></head><body>short stub</body></html>";
    const clean = "short stub";
    const reason = detectPartialFetch(url, html, clean);
    assert.equal(reason, "too_short_for_domain");
  });

  it("returns null for an unknown domain (not on the long-form allowlist)", () => {
    const url   = "https://www.mypersonalblog.example/post/1";
    const html  = "<html><body>short post</body></html>";
    const clean = "short post";
    const reason = detectPartialFetch(url, html, clean);
    assert.equal(reason, null);
  });

  it("flags missing_byline_markers when content is long enough but has no byline", () => {
    const filler = "lorem ipsum ".repeat(400);
    const url   = "https://www.politico.com/news/2026/04/22/something-00887869";
    const html  = `<html><head></head><body>${filler}© 2026 Politico</body></html>`;
    const clean = `${filler} © 2026 Politico`;
    const reason = detectPartialFetch(url, html, clean);
    assert.equal(reason, "missing_byline_markers");
  });

  it("flags missing_close_markers when body has a byline but no close marker", () => {
    const filler = "some article body ".repeat(120);
    const url   = "https://www.politico.com/news/2026/04/22/something-00887869";
    const html  =
      `<html><head><meta name="author" content="Dana Nickel"/></head><body>By Dana Nickel ${filler}</body></html>`;
    const clean = `By Dana Nickel ${filler}`; // no ©, no "Source Link", etc.
    const reason = detectPartialFetch(url, html, clean);
    assert.equal(reason, "missing_close_markers");
  });

  it("returns null when content is long enough with byline and close markers", () => {
    const filler = "some article body paragraph. ".repeat(120);
    const url   = "https://www.politico.com/news/2026/04/22/something-00887869";
    const html  =
      `<html><head><meta name="author" content="Dana Nickel"/></head><body>By Dana Nickel ${filler} © 2026 Politico All rights reserved</body></html>`;
    const clean = `By Dana Nickel ${filler} © 2026 Politico All rights reserved`;
    const reason = detectPartialFetch(url, html, clean);
    assert.equal(reason, null);
  });

  it("LONG_FORM_DOMAINS includes politico.com", () => {
    assert.ok(LONG_FORM_DOMAINS.has("politico.com"));
    assert.ok(LONG_FORM_DOMAINS.has("nytimes.com"));
  });
});

// ── fetchSourceContent integration tests (stubbed fetch) ───────────────────

describe("fetchSourceContent — partial-fetch fall-through", () => {
  it("marks a too-short long-form domain response as failed and sets partialFetchReason", async () => {
    // Above the generic bot-wall threshold (500) but below the
    // long-form partial threshold (1500). The content passes
    // looksLikeStub() so detectPartialFetch() runs and flags it.
    const filler = "real-looking sentence. ".repeat(35); // ~750 chars
    stubFetch({
      status: 200,
      body:   `<html><head><meta name="author" content="Dana Nickel"/></head><body>By Dana Nickel ${filler} © 2026 Politico All rights reserved</body></html>`,
    });
    const r = await fetchSourceContent("https://www.politico.com/news/2026/04/22/x-00887869");
    assert.equal(r.ok, false, "short-for-long-form-domain content must not be ok");
    assert.equal(r.method, "failed", "no perplexity fallback available → method='failed'");
    assert.equal(
      r.partialFetchReason,
      "too_short_for_domain",
      `expected partialFetchReason='too_short_for_domain', got '${r.partialFetchReason}'`,
    );
  });
});

describe("fetchSourceContent — bot-wall detection (pre-existing behavior)", () => {
  it("treats Cloudflare bot-wall response as failed", async () => {
    stubFetch({
      status: 200,
      // Under MIN_GOOD_LENGTH (500) — triggers the "body too short" stub path.
      body:   "<html><body>Just a moment... Enable JavaScript and cookies to continue.</body></html>",
    });
    const r = await fetchSourceContent("https://www.politico.com/news/1");
    assert.equal(r.ok, false, "bot-wall stub must not be ok");
    assert.equal(r.method, "failed");
  });

  it("direct fetch of a long clean body from a NON-long-form domain returns ok", async () => {
    const filler = "regular content paragraph. ".repeat(200);
    stubFetch({
      status: 200,
      body:   `<html><body>${filler}</body></html>`,
    });
    const r = await fetchSourceContent("https://blog.example.com/post/1");
    assert.equal(r.ok, true, "long content from an unlisted domain should pass through");
    assert.equal(r.method, "direct");
    assert.equal(r.partialFetchReason, undefined);
  });
});
