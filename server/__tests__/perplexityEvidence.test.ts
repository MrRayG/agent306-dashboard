/**
 * Tests for Perplexity evidence grounding — graceful fallback and log format.
 *
 * Run: npx tsx --test server/__tests__/perplexityEvidence.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

describe("gatherPerplexityEvidence", () => {
  const savedPplxKey = process.env.PERPLEXITY_API_KEY;
  let originalFetch: typeof globalThis.fetch;
  let logs: string[];
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLog   = console.log;
    originalWarn  = console.warn;
    logs = [];
    console.log  = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log  = originalLog;
    console.warn = originalWarn;
    if (savedPplxKey === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = savedPplxKey;
  });

  it("falls back to {ok:false} when PERPLEXITY_API_KEY is unset", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const { gatherPerplexityEvidence } = await import(`../perplexityEvidence.js?t=${Date.now()}-a`);
    const res = await gatherPerplexityEvidence("Maine LD 307 moratorium");
    assert.equal(res.ok, false);
    assert.equal(res.content, "");
    assert.equal(res.citations.length, 0);
    assert.match(res.reason ?? "", /no api key/);
    assert.ok(logs.some(l => /PERPLEXITY_API_KEY not set/.test(l)), "expected skip log");
  });

  it("falls back to {ok:false} on HTTP 401/429/5xx", async () => {
    process.env.PERPLEXITY_API_KEY = "test-pplx-key";
    const fetchMock = mock.fn(async () => new Response("unauthorized", { status: 401 }) as any);
    globalThis.fetch = fetchMock as any;

    const { gatherPerplexityEvidence } = await import(`../perplexityEvidence.js?t=${Date.now()}-b`);
    const res = await gatherPerplexityEvidence("Neuralink PRIME NCT06424782 trial");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /http 401/);
    assert.ok(logs.some(l => /Perplexity grounding HTTP 401/.test(l)), "expected HTTP 401 log");
  });

  it("returns ok:true and logs [DataSources] Perplexity grounding on success", async () => {
    process.env.PERPLEXITY_API_KEY = "test-pplx-key";
    const fetchMock = mock.fn(async () => new Response(
      JSON.stringify({
        choices: [{ message: { content: "Maine LD 307 was signed into law April 14, 2026." } }],
        citations: ["https://legislature.maine.gov/ld307", "https://example.com/news"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ) as any);
    globalThis.fetch = fetchMock as any;

    const { gatherPerplexityEvidence } = await import(`../perplexityEvidence.js?t=${Date.now()}-c`);
    const res = await gatherPerplexityEvidence("Maine LD 307 data center moratorium");
    assert.equal(res.ok, true);
    assert.ok(res.content.length > 0);
    assert.equal(res.citations.length, 2);

    const line = logs.find(l => l.includes("[DataSources] Perplexity grounding"));
    assert.ok(line, "expected grounding success log");
    assert.match(line!, /Perplexity grounding for .+: 2 citations, \d+ chars/);
  });

  it("does not throw on fetch exception — returns ok:false", async () => {
    process.env.PERPLEXITY_API_KEY = "test-pplx-key";
    const fetchMock = mock.fn(async () => { throw new Error("network down"); });
    globalThis.fetch = fetchMock as any;

    const { gatherPerplexityEvidence } = await import(`../perplexityEvidence.js?t=${Date.now()}-d`);
    const res = await gatherPerplexityEvidence("anything");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /exception/);
  });

  it("returns ok:false for empty query without calling fetch", async () => {
    process.env.PERPLEXITY_API_KEY = "test-pplx-key";
    const fetchMock = mock.fn(async () => new Response("", { status: 200 }) as any);
    globalThis.fetch = fetchMock as any;

    const { gatherPerplexityEvidence } = await import(`../perplexityEvidence.js?t=${Date.now()}-e`);
    const res = await gatherPerplexityEvidence("");
    assert.equal(res.ok, false);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});
