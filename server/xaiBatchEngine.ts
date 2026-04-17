/**
 * ─────────────────────────────────────────────────────────────
 *  306 — xAI BATCH API ENGINE  (P4)
 *
 *  Adapter for xAI's native Batch API (https://api.x.ai/v1/batches).
 *  Async processing for non-latency-sensitive workloads — returns
 *  within 24h at reduced per-token pricing and higher rate limits.
 *
 *  Use cases for 306:
 *   - Nightly knowledge-graph connection scans (hundreds of entity pairs)
 *   - Dream-cycle reflection summaries (runs overnight anyway)
 *   - Bulk entity extraction across research corpus
 *   - Evaluation re-runs / competency grading
 *
 *  ── Safety model (PR I) ────────────────────────────────────
 *  This module is ADDITIVE ONLY. Nothing currently in production
 *  calls it. Consumers wire in via follow-up PRs. Feature-flagged
 *  via BATCH_API_ENABLED (defaults false). When disabled, submit()
 *  throws immediately so no accidental batches get created.
 *
 *  ── Pattern ────────────────────────────────────────────────
 *  1. createBatch({ name })         → { batch_id }
 *  2. addRequests(batch_id, [...])  → appends chat-completion requests
 *  3. getBatchStatus(batch_id)      → { state: {num_pending, num_success, ...} }
 *  4. getBatchResults(batch_id)     → paginated succeeded[] + failed[]
 *
 *  Graceful fallback: any 4xx/5xx surfaces a descriptive Error so
 *  callers can fall back to synchronous callLLM().
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";

// ── Config ──────────────────────────────────────────────────────────────────

const XAI_BATCH_BASE = process.env.XAI_BATCH_BASE_URL ?? "https://api.x.ai/v1/batches";

/** Max requests per add-requests call (conservative — xAI allows larger) */
export const BATCH_ADD_CHUNK = 1000;

const STATS_FILE = dataPath("batch_stats.json");

// ── Types ───────────────────────────────────────────────────────────────────

export type BatchState =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled"
  | "cancelling";

export interface BatchStatusResponse {
  batch_id: string;
  name?: string;
  state: {
    num_pending: number;
    num_success: number;
    num_error: number;
    num_requests: number;
    status?: BatchState | string;
  };
  cost_breakdown?: {
    total_cost_usd_ticks?: number;
  };
  created_at?: string | number;
  completed_at?: string | number | null;
  [k: string]: any;
}

/**
 * Minimal batch request shape — mirrors xAI docs for chat/completions.
 * Image/video batch requests go through a different path and are out
 * of scope for this PR.
 */
export interface BatchChatRequest {
  batch_request_id: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  max_tokens?: number;
  temperature?: number;
}

export interface BatchResultSucceeded {
  batch_request_id: string;
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface BatchResultFailed {
  batch_request_id: string;
  error_message: string;
}

export interface BatchResultsPage {
  succeeded: BatchResultSucceeded[];
  failed: BatchResultFailed[];
  pagination_token?: string | null;
}

// ── Stats ───────────────────────────────────────────────────────────────────

interface BatchStats {
  batches: {
    total: number;
    completed: number;
    failed: number;
    expired: number;
  };
  totalRequests: number;
  totalSucceeded: number;
  totalFailed: number;
  totalCostUsd: number;
  lastBatchId: string | null;
  lastBatchAt: string | null;
}

function emptyStats(): BatchStats {
  return {
    batches: { total: 0, completed: 0, failed: 0, expired: 0 },
    totalRequests: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalCostUsd: 0,
    lastBatchId: null,
    lastBatchAt: null,
  };
}

function loadStats(): BatchStats {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      return { ...emptyStats(), ...parsed };
    }
  } catch {
    /* fall through */
  }
  return emptyStats();
}

function saveStats(stats: BatchStats): void {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e: any) {
    console.warn("[xaiBatch] Failed to save batch_stats.json:", e.message);
  }
}

export function getBatchStats(): BatchStats {
  return loadStats();
}

// ── Feature flag ────────────────────────────────────────────────────────────

/**
 * Is the Batch API enabled for this deploy?
 * Defaults to FALSE — operator must explicitly set BATCH_API_ENABLED=true
 * in Railway before any batch submission can happen.
 */
export function isBatchEnabled(): boolean {
  const raw = (process.env.BATCH_API_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

// ── Auth ────────────────────────────────────────────────────────────────────

function getAuth(): string {
  const key = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? "";
  if (!key) throw new Error("GROK_API_KEY (or XAI_API_KEY) not set — cannot use Batch API");
  return key;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${getAuth()}`,
  };
}

// ── Core API calls ──────────────────────────────────────────────────────────

/**
 * Create a new empty batch. Call addRequests() next.
 */
export async function createBatch(opts: { name: string }): Promise<{ batch_id: string; name: string }> {
  if (!isBatchEnabled()) {
    throw new Error("Batch API disabled — set BATCH_API_ENABLED=true to enable");
  }
  if (!opts.name || opts.name.length < 1) {
    throw new Error("Batch name is required");
  }

  const res = await fetch(XAI_BATCH_BASE, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name: opts.name }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`xAI createBatch ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as any;
  const batchId = json.batch_id ?? json.id;
  if (!batchId) {
    throw new Error(`xAI createBatch response missing batch_id: ${JSON.stringify(json).slice(0, 200)}`);
  }

  // Update stats
  const stats = loadStats();
  stats.batches.total += 1;
  stats.lastBatchId = batchId;
  stats.lastBatchAt = new Date().toISOString();
  saveStats(stats);

  console.log(`[xaiBatch] Created batch "${opts.name}" → ${batchId}`);
  return { batch_id: batchId, name: opts.name };
}

/**
 * Add chat-completion requests to an existing batch.
 * Large inputs are auto-chunked to BATCH_ADD_CHUNK per call.
 */
export async function addRequests(batchId: string, requests: BatchChatRequest[]): Promise<{ added: number }> {
  if (!isBatchEnabled()) {
    throw new Error("Batch API disabled — set BATCH_API_ENABLED=true to enable");
  }
  if (!batchId) throw new Error("batchId is required");
  if (!requests || requests.length === 0) {
    return { added: 0 };
  }

  // Validate request shape + uniqueness
  const seenIds = new Set<string>();
  for (const r of requests) {
    if (!r.batch_request_id) throw new Error("Each request needs a batch_request_id");
    if (seenIds.has(r.batch_request_id)) {
      throw new Error(`Duplicate batch_request_id: ${r.batch_request_id}`);
    }
    seenIds.add(r.batch_request_id);
    if (!r.model) throw new Error(`Request ${r.batch_request_id} missing model`);
    if (!r.messages || r.messages.length === 0) {
      throw new Error(`Request ${r.batch_request_id} has no messages`);
    }
  }

  let totalAdded = 0;
  for (let i = 0; i < requests.length; i += BATCH_ADD_CHUNK) {
    const slice = requests.slice(i, i + BATCH_ADD_CHUNK);
    const body = {
      batch_requests: slice.map((r) => ({
        batch_request_id: r.batch_request_id,
        batch_request: {
          chat_get_completion: {
            model: r.model,
            messages: r.messages,
            ...(typeof r.max_tokens === "number" ? { max_tokens: r.max_tokens } : {}),
            ...(typeof r.temperature === "number" ? { temperature: r.temperature } : {}),
          },
        },
      })),
    };

    const res = await fetch(`${XAI_BATCH_BASE}/${encodeURIComponent(batchId)}/requests`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`xAI addRequests ${res.status}: ${text.slice(0, 300)}`);
    }
    totalAdded += slice.length;
    console.log(`[xaiBatch] Added ${slice.length} requests to ${batchId} (running total ${totalAdded})`);
  }

  // Stats
  const stats = loadStats();
  stats.totalRequests += totalAdded;
  saveStats(stats);

  return { added: totalAdded };
}

/**
 * Get current batch status.
 */
export async function getBatchStatus(batchId: string): Promise<BatchStatusResponse> {
  if (!batchId) throw new Error("batchId is required");
  const res = await fetch(`${XAI_BATCH_BASE}/${encodeURIComponent(batchId)}`, {
    method: "GET",
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`xAI getBatchStatus ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as BatchStatusResponse;
}

/**
 * Retrieve one page of results.
 * Use `pagination_token` from a previous page to fetch the next.
 */
export async function getBatchResultsPage(
  batchId: string,
  opts?: { limit?: number; paginationToken?: string },
): Promise<BatchResultsPage> {
  if (!batchId) throw new Error("batchId is required");
  const url = new URL(`${XAI_BATCH_BASE}/${encodeURIComponent(batchId)}/results`);
  url.searchParams.set("limit", String(opts?.limit ?? 100));
  if (opts?.paginationToken) url.searchParams.set("pagination_token", opts.paginationToken);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`xAI getBatchResults ${res.status}: ${text.slice(0, 300)}`);
  }

  const raw = (await res.json()) as any;
  const succeeded: BatchResultSucceeded[] = [];
  const failed: BatchResultFailed[] = [];

  const results: any[] = raw.results ?? [];
  for (const r of results) {
    const chatResp = r.batch_result?.response?.chat_get_completion;
    if (chatResp?.choices?.[0]?.message?.content !== undefined) {
      succeeded.push({
        batch_request_id: r.batch_request_id,
        content: chatResp.choices[0].message.content ?? "",
        usage: chatResp.usage
          ? {
              prompt_tokens: chatResp.usage.prompt_tokens,
              completion_tokens: chatResp.usage.completion_tokens,
              total_tokens: chatResp.usage.total_tokens,
            }
          : undefined,
      });
    } else if (r.error_message || r.batch_result?.error) {
      failed.push({
        batch_request_id: r.batch_request_id,
        error_message: r.error_message ?? r.batch_result?.error?.message ?? "Unknown error",
      });
    }
  }

  return {
    succeeded,
    failed,
    pagination_token: raw.pagination_token ?? null,
  };
}

/**
 * Retrieve ALL results across pagination. Use sparingly — batches can be large.
 */
export async function getAllBatchResults(batchId: string): Promise<BatchResultsPage> {
  const succeeded: BatchResultSucceeded[] = [];
  const failed: BatchResultFailed[] = [];
  let token: string | undefined = undefined;
  // Hard cap on page count to avoid accidental infinite loops
  for (let i = 0; i < 1000; i++) {
    const page = await getBatchResultsPage(batchId, { limit: 100, paginationToken: token });
    succeeded.push(...page.succeeded);
    failed.push(...page.failed);
    if (!page.pagination_token) break;
    token = page.pagination_token;
  }

  // Stats update on terminal fetch
  const stats = loadStats();
  stats.totalSucceeded += succeeded.length;
  stats.totalFailed += failed.length;
  saveStats(stats);

  return { succeeded, failed, pagination_token: null };
}

/**
 * Poll until batch reaches terminal state (num_pending === 0) or timeout.
 * Returns final status. NOTE: this is a blocking helper — only use from
 * background workers / cron runs, never from an HTTP request handler.
 */
export async function waitForBatchComplete(
  batchId: string,
  opts?: { pollIntervalMs?: number; timeoutMs?: number; onProgress?: (s: BatchStatusResponse) => void },
): Promise<BatchStatusResponse> {
  const pollInterval = opts?.pollIntervalMs ?? 30_000; // 30s
  const timeoutMs = opts?.timeoutMs ?? 24 * 60 * 60 * 1000; // 24h
  const deadline = Date.now() + timeoutMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await getBatchStatus(batchId);
    opts?.onProgress?.(status);
    if (status.state && status.state.num_requests > 0 && status.state.num_pending === 0) {
      // Final cost attribution
      const ticks = status.cost_breakdown?.total_cost_usd_ticks ?? 0;
      if (ticks > 0) {
        const stats = loadStats();
        stats.totalCostUsd += ticks / 1e10;
        stats.batches.completed += 1;
        saveStats(stats);
      }
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForBatchComplete: timed out after ${timeoutMs}ms for batch ${batchId}`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}
