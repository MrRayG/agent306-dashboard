import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Per-request timeout for dashboard fetches. Without this, a single hung
// connection (slow ISP, intercepting proxy, dropped keep-alive) leaves
// React-Query stuck in isLoading: true forever, so every panel that does
// `if (isLoading) return <Skeleton/>` spins indefinitely instead of falling
// back to its "could not load" state. The matching error handlers already
// exist on every Mission Control panel; the bug was that they were never
// reached because the fetch never settled.
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

// LLM-backed endpoints (article preview / revise, blog generate / revise)
// can legitimately take 30-90s: discovery + source fetch + writer + verifier
// + revise loop. The 15s default aborts them mid-flight and surfaces as
// "request timed out after 15000ms" in the UI. Long timeout matches the
// upper bound of a normal preview run with margin.
export const LLM_FETCH_TIMEOUT_MS = 180_000;

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "FetchTimeoutError";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// Dashboard auth secret — injected at build time from VITE_DASHBOARD_SECRET env var
const DASH_SECRET = (import.meta as any).env?.VITE_DASHBOARD_SECRET ?? "";

// Wrap fetch with an AbortController-backed timeout. Caller-supplied signals
// (e.g. React-Query's internal abort) compose with the timeout: whichever
// fires first wins. Returns a FetchTimeoutError on timeout so callers can
// distinguish it from a network/HTTP error.
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Compose with any caller-provided signal so we don't drop their cancel.
  const externalSignal = init.signal;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      // Distinguish timeout-driven aborts from caller-driven ones.
      if (externalSignal?.aborted) throw err;
      throw new FetchTimeoutError(String(input), timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiRequestOptions {
  /** Override the per-request timeout in milliseconds. Defaults to
   *  DEFAULT_FETCH_TIMEOUT_MS. Use LLM_FETCH_TIMEOUT_MS for LLM-backed
   *  endpoints that legitimately take 30-90s. */
  timeoutMs?: number;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (data) headers["Content-Type"] = "application/json";
  if (DASH_SECRET) headers["x-dashboard-secret"] = DASH_SECRET;

  const res = await fetchWithTimeout(
    `${API_BASE}${url}`,
    {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    },
    options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
  );

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    const headers: Record<string, string> = {};
    if (DASH_SECRET) headers["x-dashboard-secret"] = DASH_SECRET;

    const res = await fetchWithTimeout(`${API_BASE}${queryKey.join("/")}`, { headers, signal });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
