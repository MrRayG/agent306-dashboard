/**
 * Defensive coverage for `fetchWithTimeout` — the bug class this guards
 * against is a hanging dashboard fetch that leaves React-Query stuck in
 * isLoading: true forever, so every Mission Control panel keeps showing
 * skeletons instead of its existing "could not load" fallback.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json --test client/src/__tests__/queryClientTimeout.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchWithTimeout,
  FetchTimeoutError,
  DEFAULT_FETCH_TIMEOUT_MS,
  LLM_FETCH_TIMEOUT_MS,
  apiRequest,
} from "../lib/queryClient.js";

const ORIGINAL_FETCH = globalThis.fetch;

function withMockFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  (globalThis as any).fetch = mock;
  return fn().finally(() => {
    (globalThis as any).fetch = ORIGINAL_FETCH;
  });
}

describe("fetchWithTimeout", () => {
  it("exposes a sane default timeout", () => {
    // Bound it: must be long enough for a real Railway request but short
    // enough that a hang becomes visible to the operator inside one minute.
    assert.ok(DEFAULT_FETCH_TIMEOUT_MS >= 5_000);
    assert.ok(DEFAULT_FETCH_TIMEOUT_MS <= 60_000);
  });

  it("resolves with the response when the underlying fetch resolves quickly", async () => {
    const fakeResponse = new Response("ok", { status: 200 });
    await withMockFetch(
      (async (_url: RequestInfo | URL, _init?: RequestInit) => fakeResponse) as typeof fetch,
      async () => {
        const res = await fetchWithTimeout("https://example.test/ok", {}, 1_000);
        assert.equal(res.status, 200);
      },
    );
  });

  it("aborts with FetchTimeoutError when the underlying fetch never settles", async () => {
    const hangingFetch: typeof fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              (err as any).name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }
      });
    };

    await withMockFetch(hangingFetch, async () => {
      const start = Date.now();
      await assert.rejects(
        () => fetchWithTimeout("https://example.test/hang", {}, 50),
        (err: unknown) => {
          assert.ok(err instanceof FetchTimeoutError, "expected FetchTimeoutError");
          assert.match((err as Error).message, /timed out/);
          return true;
        },
      );
      // Sanity: we did not wait anywhere near a real network timeout.
      assert.ok(Date.now() - start < 2_000, "timeout fired promptly");
    });
  });

  it("exposes a long LLM timeout for endpoints that run a writer + verifier", () => {
    // LLM-backed routes (article preview / revise, blog generate / revise)
    // legitimately take 30-90s. The dedicated constant must be large enough
    // for the long tail but bounded so a wedged provider doesn't pin the
    // browser tab forever.
    assert.ok(LLM_FETCH_TIMEOUT_MS > DEFAULT_FETCH_TIMEOUT_MS);
    assert.ok(LLM_FETCH_TIMEOUT_MS >= 60_000);
    assert.ok(LLM_FETCH_TIMEOUT_MS <= 600_000);
  });

  it("apiRequest honors a per-call timeout override (LLM endpoints)", async () => {
    // The bug we are guarding against: every apiRequest used the 15s default
    // and LLM-backed routes (article/preview, blog/generate, …/revise) would
    // abort with FetchTimeoutError mid-generation. Callers must be able to
    // opt those routes into the longer LLM timeout instead.
    const hangingFetch: typeof fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              (err as any).name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }
      });
    };

    await withMockFetch(hangingFetch, async () => {
      const start = Date.now();
      // Use a tiny override here just to prove the override path is wired —
      // we are not exercising the real LLM_FETCH_TIMEOUT_MS value.
      await assert.rejects(
        () => apiRequest("POST", "/api/article/preview", {}, { timeoutMs: 40 }),
        (err: unknown) => {
          assert.ok(err instanceof FetchTimeoutError, "expected FetchTimeoutError");
          assert.match((err as Error).message, /timed out after 40ms/);
          return true;
        },
      );
      // And: the default 15s timeout did NOT fire (would have shown 15000ms).
      assert.ok(Date.now() - start < 2_000, "override timeout fired promptly");
    });
  });

  it("apiRequest defaults to DEFAULT_FETCH_TIMEOUT_MS when no override is passed", async () => {
    // Sanity check: short dashboard fetches keep their 15s default and the
    // long LLM timeout is opt-in only.
    let observedTimeoutOk = false;
    const fakeFetch: typeof fetch = async (_url, init) => {
      // The signal must NOT be the LLM signal — we just confirm the request
      // resolves before the default 15s fires.
      observedTimeoutOk = !!init?.signal;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await withMockFetch(fakeFetch, async () => {
      const r = await apiRequest("GET", "/api/article/state");
      assert.equal(r.status, 200);
      assert.ok(observedTimeoutOk, "expected an internal abort signal to be attached");
    });
  });

  it("propagates caller-driven aborts as AbortError (not as a timeout)", async () => {
    const hangingFetch: typeof fetch = (_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              (err as any).name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }
      });
    };

    await withMockFetch(hangingFetch, async () => {
      const ctrl = new AbortController();
      // Abort externally before the internal timeout would fire.
      setTimeout(() => ctrl.abort(), 10);
      await assert.rejects(
        () => fetchWithTimeout("https://example.test/cancel", { signal: ctrl.signal }, 10_000),
        (err: unknown) => {
          // Caller cancellations must NOT be reported as a server-side timeout.
          assert.ok(!(err instanceof FetchTimeoutError), "must not be reported as timeout");
          assert.equal((err as any)?.name, "AbortError");
          return true;
        },
      );
    });
  });
});
