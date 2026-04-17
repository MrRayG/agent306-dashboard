/**
 * ─────────────────────────────────────────────────────────────
 *  306 — KG CONNECTION SCAN CRON CONSUMER (PR Q)
 *
 *  Wires the dormant kgConnectionScanBatch module (PR K, #164)
 *  to a nightly schedule so the batch path actually runs.
 *
 *  Behaviour:
 *    1. Pick the N most-recently-learned active KG entries (the
 *       ones most likely to have unscanned connections — the
 *       sync findConnections() path only fires on ingest, so
 *       any backfill of historical entries needs this cron).
 *    2. For each, build a (target, top-K-related-context) pair
 *       using the same word-overlap scoring as findConnections().
 *    3. Submit one batch via submitConnectionScanBatch().
 *    4. Poll waitForBatchComplete() (24h max — well under xAI's
 *       hard window).
 *    5. Parse with parseConnectionScanResults() against the live
 *       KB, then persist via knowledge-graph.appendConnections()
 *       (which de-dupes against existing pairs in both directions).
 *
 *  ── Safety model ──────────────────────────────────────────
 *  Three independent off-switches, all default OFF:
 *    KG_CONNECTION_SCAN_BATCH=true   (gates the module itself)
 *    BATCH_API_ENABLED=true          (gates xAI batches)
 *    KG_BATCH_CRON_ENABLED=true      (gates THIS scheduler)
 *
 *  With any flag off, scheduleKgConnectionScanBatch() is a no-op
 *  and runKgConnectionScanBatch() refuses to submit.
 *
 *  Hard-fail policy: no auto-retry on xAI errors — matches the
 *  user's explicit policy. Failures are logged and the next run
 *  picks up fresh.
 * ─────────────────────────────────────────────────────────────
 */

import { knowledge } from "./memoryEngine.js";
import { appendConnections } from "./knowledge-graph.js";
import {
  shouldUseKgBatch,
  submitConnectionScanBatch,
  collectConnectionScanResults,
  type KgEntrySummary,
} from "./kgConnectionScanBatch.js";
import { waitForBatchComplete } from "./xaiBatchEngine.js";

// ── Tunables (env-overridable) ──────────────────────────────────────────────

/** Max number of TARGET entries to scan per nightly run (one batch request each). */
const DEFAULT_MAX_TARGETS = 50;
/** Max number of context candidates per target (matches findConnections cap). */
const DEFAULT_CONTEXT_K = 20;
/** Polling interval while the batch runs. */
const DEFAULT_POLL_MS = 60_000; // 1 min
/** Hard ceiling on how long the cron will wait for a batch. xAI gives 24h max. */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h — well under xAI's window

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Cron flag ───────────────────────────────────────────────────────────────

/**
 * Is the nightly cron consumer enabled?
 * Defaults to FALSE — operator must explicitly set
 * KG_BATCH_CRON_ENABLED=true in Railway. Even when on, the run still
 * requires the two underlying flags (KG_CONNECTION_SCAN_BATCH +
 * BATCH_API_ENABLED) per shouldUseKgBatch().
 */
export function isKgBatchCronEnabled(): boolean {
  const raw = (process.env.KG_BATCH_CRON_ENABLED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

// ── Pair building (deterministic, pure-ish: only reads `knowledge`) ─────────

/**
 * Pick the top-K context entries for a target by word-overlap score —
 * the same heuristic findConnections() uses, kept deterministic so
 * tests can assert pair shape without a live KB.
 */
export function pickContextEntries(
  target: KgEntrySummary,
  pool: KgEntrySummary[],
  k: number,
): KgEntrySummary[] {
  const queryText = `${target.title} ${target.summary}`.toLowerCase();
  const queryWords = queryText.split(/\s+/).filter((w) => w.length > 3);
  if (queryWords.length === 0) return [];

  const scored = pool
    .filter((e) => e.id !== target.id)
    .map((e) => {
      const text = `${e.title ?? ""} ${e.summary ?? ""}`.toLowerCase();
      let score = 0;
      for (const w of queryWords) if (text.includes(w)) score++;
      return { entry: e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored.map((s) => s.entry);
}

/**
 * Pick the most-recent N active entries from the KB and pair each with its
 * top-K candidates. Pure read of memoryEngine.knowledge.
 */
export function buildNightlyPairs(
  maxTargets: number,
  contextK: number,
): { target: KgEntrySummary; context: KgEntrySummary[] }[] {
  const active = knowledge.entries.filter((e) => (e.status ?? "active") === "active");
  if (active.length < 2) return [];

  // Sort by learnedAt desc (most recent first) — these are the highest-value
  // backfill candidates because the sync path may not have re-scanned them
  // since the KB has grown.
  const recent = [...active]
    .sort((a, b) => (b.learnedAt ?? "").localeCompare(a.learnedAt ?? ""))
    .slice(0, maxTargets)
    .map(
      (e): KgEntrySummary => ({
        id: e.id,
        title: e.title,
        summary: e.summary,
        category: String(e.category),
      }),
    );

  const pool: KgEntrySummary[] = active.map((e) => ({
    id: e.id,
    title: e.title,
    summary: e.summary,
    category: String(e.category),
  }));

  const pairs: { target: KgEntrySummary; context: KgEntrySummary[] }[] = [];
  for (const target of recent) {
    const context = pickContextEntries(target, pool, contextK);
    if (context.length === 0) continue;
    pairs.push({ target, context });
  }
  return pairs;
}

// ── Main run ────────────────────────────────────────────────────────────────

export interface KgBatchRunSummary {
  batchId: string | null;
  pairsBuilt: number;
  requestsSubmitted: number;
  candidatesFound: number;
  connectionsAppended: number;
  failures: number;
  durationMs: number;
  skipped?: string;
}

/**
 * One full execution of the nightly cycle. Safe to call manually
 * (admin endpoint) — the orchestration is the same.
 *
 * Returns a structured summary suitable for logging or surfacing in the
 * Diagnostics tab.
 */
export async function runKgConnectionScanBatch(
  opts?: { maxTargets?: number; contextK?: number; timeoutMs?: number; pollIntervalMs?: number },
): Promise<KgBatchRunSummary> {
  const start = Date.now();

  if (!shouldUseKgBatch()) {
    const why =
      "KG batch path disabled — set KG_CONNECTION_SCAN_BATCH=true and BATCH_API_ENABLED=true";
    console.log(`[kgBatchCron] Skipped: ${why}`);
    return {
      batchId: null,
      pairsBuilt: 0,
      requestsSubmitted: 0,
      candidatesFound: 0,
      connectionsAppended: 0,
      failures: 0,
      durationMs: Date.now() - start,
      skipped: why,
    };
  }

  const maxTargets = opts?.maxTargets ?? envInt("KG_BATCH_MAX_TARGETS", DEFAULT_MAX_TARGETS);
  const contextK = opts?.contextK ?? envInt("KG_BATCH_CONTEXT_K", DEFAULT_CONTEXT_K);
  const pollMs = opts?.pollIntervalMs ?? envInt("KG_BATCH_POLL_MS", DEFAULT_POLL_MS);
  const timeoutMs = opts?.timeoutMs ?? envInt("KG_BATCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  console.log(
    `[kgBatchCron] Starting run — maxTargets=${maxTargets}, contextK=${contextK}`,
  );

  const pairs = buildNightlyPairs(maxTargets, contextK);
  if (pairs.length === 0) {
    console.log("[kgBatchCron] No pairs to scan — skipping batch submission");
    return {
      batchId: null,
      pairsBuilt: 0,
      requestsSubmitted: 0,
      candidatesFound: 0,
      connectionsAppended: 0,
      failures: 0,
      durationMs: Date.now() - start,
    };
  }

  let batchId: string | null = null;
  let requestsSubmitted = 0;
  try {
    const sub = await submitConnectionScanBatch(pairs);
    batchId = sub.batch_id;
    requestsSubmitted = sub.added;
    console.log(
      `[kgBatchCron] Submitted batch ${batchId} with ${requestsSubmitted} requests`,
    );
  } catch (e: any) {
    console.error(`[kgBatchCron] submit failed: ${e?.message ?? e}`);
    return {
      batchId,
      pairsBuilt: pairs.length,
      requestsSubmitted: 0,
      candidatesFound: 0,
      connectionsAppended: 0,
      failures: 0,
      durationMs: Date.now() - start,
    };
  }

  // Poll to completion. waitForBatchComplete handles its own pacing + cost
  // accounting. If it times out we surface the error and bail — the next
  // nightly run will pick up fresh (no auto-retry, per policy).
  try {
    await waitForBatchComplete(batchId, {
      pollIntervalMs: pollMs,
      timeoutMs,
      onProgress: (s) => {
        const total = s.state?.num_requests ?? 0;
        const pending = s.state?.num_pending ?? 0;
        if (total > 0) {
          console.log(
            `[kgBatchCron] batch ${batchId} progress: ${total - pending}/${total}`,
          );
        }
      },
    });
  } catch (e: any) {
    console.error(`[kgBatchCron] wait failed for batch ${batchId}: ${e?.message ?? e}`);
    return {
      batchId,
      pairsBuilt: pairs.length,
      requestsSubmitted,
      candidatesFound: 0,
      connectionsAppended: 0,
      failures: 0,
      durationMs: Date.now() - start,
    };
  }

  // Build the live valid-id set AFTER the batch completes — entries archived
  // mid-flight will be silently dropped, matching the safety check baked
  // into parseConnectionScanResults().
  const validEntryIds = new Set(
    knowledge.entries
      .filter((e) => (e.status ?? "active") === "active")
      .map((e) => e.id),
  );

  let result;
  try {
    result = await collectConnectionScanResults(batchId, validEntryIds);
  } catch (e: any) {
    console.error(`[kgBatchCron] collect failed for batch ${batchId}: ${e?.message ?? e}`);
    return {
      batchId,
      pairsBuilt: pairs.length,
      requestsSubmitted,
      candidatesFound: 0,
      connectionsAppended: 0,
      failures: 0,
      durationMs: Date.now() - start,
    };
  }

  const appended = appendConnections(result.candidates, "research");

  console.log(
    `[kgBatchCron] Done — batch=${batchId} candidates=${result.candidates.length} appended=${appended} failures=${result.failures.length}`,
  );

  return {
    batchId,
    pairsBuilt: pairs.length,
    requestsSubmitted,
    candidatesFound: result.candidates.length,
    connectionsAppended: appended,
    failures: result.failures.length,
    durationMs: Date.now() - start,
  };
}

// ── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Schedule the nightly KG-connection-scan batch.
 *
 * Default cadence: 5am ET (09:00 UTC) — one hour after the daily research
 * scanner so it operates against the freshest KB. setTimeout fires the first
 * run at the next 09:00 UTC; setInterval keeps it on a 24h cadence after that.
 *
 * No-op when KG_BATCH_CRON_ENABLED is unset or false. The underlying flags
 * (KG_CONNECTION_SCAN_BATCH + BATCH_API_ENABLED) are checked per-run by
 * runKgConnectionScanBatch(), so toggling them at runtime takes effect on
 * the next tick without restarting the process.
 *
 * Returns a handle the caller can ignore (the schedulers in routes.ts don't
 * track theirs either).
 */
export function scheduleKgConnectionScanBatch(): void {
  if (!isKgBatchCronEnabled()) {
    console.log(
      "[kgBatchCron] Scheduler disabled — set KG_BATCH_CRON_ENABLED=true to enable",
    );
    return;
  }

  function msUntilNext(): number {
    const now = new Date();
    const t = new Date();
    t.setUTCHours(9, 0, 0, 0); // 5am ET = 09:00 UTC (DST-naive, matches sibling schedulers)
    if (t <= now) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime() - now.getTime();
  }

  const delay = msUntilNext();
  console.log(
    `[kgBatchCron] Scheduled nightly at 5am ET — first run in ${Math.round(delay / 3600000)}h`,
  );

  setTimeout(async () => {
    try {
      await runKgConnectionScanBatch();
    } catch (e: any) {
      console.error("[kgBatchCron]", e?.message ?? e);
    }
    setInterval(() => {
      runKgConnectionScanBatch().catch((e) => console.error("[kgBatchCron]", e?.message ?? e));
    }, 24 * 60 * 60 * 1000);
  }, delay);
}
