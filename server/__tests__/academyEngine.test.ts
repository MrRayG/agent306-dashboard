/**
 * Tests for the Academy engine's Generate Now path.
 *
 * Regression coverage for the bug where hitting "GENERATE NOW" on the
 * Academy card returned:
 *   500: {"success":false,"error":"Academy episode generation failed — LLM returned no content"}
 *
 * The old engine silently returned null on three different failure modes
 * (missing key, non-ok HTTP, unparseable/empty LLM output), so the route
 * handler could only report a generic message. We now:
 *   1. Throw AcademyGenerationError with model + finish_reason + prompt_len.
 *   2. Fall back to raw LLM text when JSON parsing fails but the model did
 *      return substantive prose (same resilience pattern as News/Dispatch).
 *   3. Only surface "empty content" when the LLM truly gave us nothing.
 *
 * Run: npx tsx --test server/__tests__/academyEngine.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Per-process DB isolation. Without this, every test file under `npm test`
// (which runs `*.test.ts` files as parallel child processes via `tsx --test`)
// falls through to the default `dataPath("agent306.db")`. Modules loaded
// transitively from academyEngine — `modelRouter` → `experiments/runExperiment`
// and `claimVerifier` → `observability/structuredLog` — both `import { db }
// from "./db.js"`, which on module init runs `new Database(DB_PATH)` plus a
// large `sqlite.exec(...CREATE TABLE IF NOT EXISTS...)` block. With many
// processes racing for the same file's write lock on a slow CI runner, the
// loser exceeds better-sqlite3's busy timeout and fails with SQLITE_BUSY
// "database is locked" — which is exactly what 25602361096 surfaced. Pointing
// DB_PATH at a unique tmpdir scopes the lock to this process.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "academy-engine-test-"));
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, "test.db");
process.env.NODE_ENV = "test";

function chatResponse(body: {
  content: string;
  finish_reason?: string;
  ok?: boolean;
  status?: number;
}) {
  const ok = body.ok ?? true;
  const status = body.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: async () => ({
      choices: [{
        message: { role: "assistant", content: body.content },
        finish_reason: body.finish_reason ?? "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    text: async () => body.content,
  };
}

describe("Academy engine — generateAcademyContent()", () => {
  let originalFetch: typeof globalThis.fetch;
  const savedKey = process.env.OPENROUTER_API_KEY;
  const savedGrok = process.env.GROK_API_KEY;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Ensure the engine's LLM_API_KEY guard passes so tests exercise the
    // actual HTTP path (postChatCompletions → mocked fetch).
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.GROK_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
    if (savedGrok === undefined) delete process.env.GROK_API_KEY;
    else process.env.GROK_API_KEY = savedGrok;
  });

  it("happy path: parses valid JSON response and returns post/narrative/headline", async () => {
    const validJson = JSON.stringify({
      post: "[306 ACADEMY] A large language model is not a database. It's a compressed map of language...",
      dashboardNarrative: "Para 1.\n\nPara 2.\n\nPara 3.\n\nPara 4.",
      headline: "What An LLM Actually Is",
    });

    const fetchMock = mock.fn(async () => chatResponse({ content: validJson }) as any);
    globalThis.fetch = fetchMock as any;

    const { generateAcademyContent } = await import(
      `../academyEngine.js?t=${Date.now()}`
    );
    const result = await generateAcademyContent();

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(result.post.startsWith("[306 ACADEMY]"));
    assert.equal(result.headline, "What An LLM Actually Is");
    assert.ok(result.dashboardNarrative.length > 0);
  });

  it("empty LLM response: throws descriptive AcademyGenerationError with model + finish_reason", async () => {
    const fetchMock = mock.fn(async () =>
      chatResponse({ content: "", finish_reason: "length" }) as any,
    );
    globalThis.fetch = fetchMock as any;

    const { generateAcademyContent, AcademyGenerationError } = await import(
      `../academyEngine.js?t=${Date.now()}`
    );

    await assert.rejects(
      () => generateAcademyContent(),
      (err: unknown) => {
        assert.ok(err instanceof AcademyGenerationError, `expected AcademyGenerationError, got ${err}`);
        const msg = (err as Error).message;
        assert.match(msg, /Academy: LLM returned empty content/);
        assert.match(msg, /model=/);
        assert.match(msg, /finish_reason=length/);
        assert.match(msg, /prompt_len=\d+/);
        const details = (err as any).details as Record<string, unknown>;
        assert.equal(details.finishReason, "length");
        assert.equal(details.rawLen, 0);
        return true;
      },
    );
  });

  it("non-ok HTTP: throws with status + model", async () => {
    const fetchMock = mock.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "upstream unavailable",
    } as any));
    globalThis.fetch = fetchMock as any;

    const { generateAcademyContent, AcademyGenerationError } = await import(
      `../academyEngine.js?t=${Date.now()}`
    );

    await assert.rejects(
      () => generateAcademyContent(),
      (err: unknown) => {
        assert.ok(err instanceof AcademyGenerationError);
        assert.match((err as Error).message, /Academy: LLM HTTP 503/);
        return true;
      },
    );
  });

  it("JSON missing 'post' field but substantive prose: falls back to raw text", async () => {
    const prose =
      "[306 ACADEMY] I keep thinking about what a context window really is. " +
      "Imagine the amount of text a model can hold in its head at once. Early " +
      "models could manage a page. Today's frontier models can hold a whole " +
      "book. That shift changes everything about what AI can do.";

    // Not JSON at all — pure prose. safeParseLLMJson will fail, fallback
    // should kick in and use the raw text as the post.
    const fetchMock = mock.fn(async () =>
      chatResponse({ content: prose }) as any,
    );
    globalThis.fetch = fetchMock as any;

    const { generateAcademyContent } = await import(
      `../academyEngine.js?t=${Date.now()}`
    );
    const result = await generateAcademyContent();
    assert.ok(result.post.includes("[306 ACADEMY]"));
    assert.ok(result.post.length > 50);
  });

  it("network error during LLM call: throws AcademyGenerationError wrapping the cause", async () => {
    const fetchMock = mock.fn(async () => {
      throw new Error("socket hang up");
    });
    globalThis.fetch = fetchMock as any;

    const { generateAcademyContent, AcademyGenerationError } = await import(
      `../academyEngine.js?t=${Date.now()}`
    );

    await assert.rejects(
      () => generateAcademyContent(),
      (err: unknown) => {
        assert.ok(err instanceof AcademyGenerationError);
        assert.match((err as Error).message, /Academy: LLM request failed/);
        assert.match((err as Error).message, /socket hang up/);
        return true;
      },
    );
  });
});
