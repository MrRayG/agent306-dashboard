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
