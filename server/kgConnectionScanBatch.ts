/**
 * ─────────────────────────────────────────────────────────────
 *  306 — KNOWLEDGE-GRAPH CONNECTION SCAN (Batch mode, PR K)
 *
 *  Nightly batched variant of the per-entry connection scan
 *  done by knowledge-graph.ts → findConnections().
 *
 *  Per-entry scan:  latency-sensitive, synchronous, stays on
 *                   Chat Completions (unchanged).
 *  Batch scan:      bulk re-scan of many entries at once via
 *                   xAI /v1/batches — 50% cheaper, no RPM cost,
 *                   24-hour window. Intended for nightly/weekly
 *                   backfill over accumulated knowledge entries.
 *
 *  ── Safety model ──────────────────────────────────────────
 *  Additive, feature-flagged. Disabled by default:
 *    KG_CONNECTION_SCAN_BATCH=true  (must be explicit)
 *    BATCH_API_ENABLED=true         (hard prerequisite)
 *
 *  With either flag off, callers fall back to the existing
 *  synchronous findConnections() path. No behavior change until
 *  an operator turns both on.
 *
 *  ── Pattern ───────────────────────────────────────────────
 *  1. buildConnectionScanRequests(entries, context) → BatchChatRequest[]
 *       (pure; no network)
 *  2. submitConnectionScanBatch(requests) → { batch_id }
 *       (creates batch + adds requests via xaiBatchEngine)
 *  3. collectConnectionScanResults(batch_id)
 *       (parses succeeded[] into KnowledgeConnection candidates)
 *
 *  Consumers (cron / manual trigger) wire these three steps
 *  together; this module stays free of scheduling concerns.
 * ─────────────────────────────────────────────────────────────
 */

import {
  createBatch,
  addRequests,
  getAllBatchResults,
  isBatchEnabled,
  type BatchChatRequest,
  type BatchResultsPage,
} from "./xaiBatchEngine.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

// ── Feature flag ────────────────────────────────────────────────────────────

/**
 * Is the KG connection-scan batch path enabled?
 * Defaults to FALSE — operator must explicitly set
 * KG_CONNECTION_SCAN_BATCH=true in Railway.
 *
 * Also requires BATCH_API_ENABLED=true (checked separately).
 */
export function isKgBatchEnabled(): boolean {
  const raw = (process.env.KG_CONNECTION_SCAN_BATCH ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Convenience: both flags must be on for batch mode to actually run.
 * Callers should use this to decide between batch and sync paths.
 */
export function shouldUseKgBatch(): boolean {
  return isKgBatchEnabled() && isBatchEnabled();
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface KgEntrySummary {
  id: string;
  title: string;
  summary: string;
  category: string;
}

export interface ConnectionCandidate {
  fromEntryId: string;
  toEntryId: string;
  relationshipType:
    | "confirms"
    | "contradicts"
    | "extends"
    | "related_to"
    | "depends_on"
    | "supersedes";
  confidence: number;
  reasoning: string;
}

export interface ConnectionScanBatchResult {
  candidates: ConnectionCandidate[];
  failures: { batch_request_id: string; error_message: string }[];
}

// ── Prompt builders (identical shape to findConnections synchronous path) ───

const VALID_REL_TYPES = new Set([
  "confirms",
  "contradicts",
  "extends",
  "related_to",
  "depends_on",
  "supersedes",
]);

const SYSTEM_PROMPT = `You analyze relationships between knowledge entries.
Respond with ONLY valid JSON:
{
  "connections": [
    {
      "toEntryId": "existing_entry_id",
      "relationshipType": "confirms" | "contradicts" | "extends" | "related_to" | "depends_on" | "supersedes",
      "confidence": 0.0-1.0,
      "reasoning": "brief explanation of why this connection exists"
    }
  ]
}

Relationship types:
- "confirms": new entry provides additional evidence for existing knowledge
- "contradicts": new entry conflicts with or challenges existing knowledge
- "extends": new entry builds on or adds nuance to existing knowledge
- "related_to": entries share a common theme but aren't directly linked
- "depends_on": new entry relies on concepts from existing entry
- "supersedes": new entry replaces or updates existing knowledge

Rules:
- Find 1-5 connections (only strong ones, skip weak/speculative)
- Confidence: 0.8+ for clear connections, 0.5-0.8 for probable, below 0.5 skip
- Focus on non-obvious connections that reveal patterns
- Only use entry IDs from the provided list`;

function buildUserPrompt(
  target: KgEntrySummary,
  contextEntries: KgEntrySummary[],
): string {
  const existingEntries = contextEntries
    .map(
      (e) =>
        `[${e.id}] (${e.category}) "${e.title}": ${(e.summary ?? "").slice(0, 150)}`,
    )
    .join("\n");
  return `TARGET ENTRY being scanned:
[${target.id}] (${target.category}) "${target.title}": ${target.summary}

EXISTING KNOWLEDGE (relevant candidates):
${existingEntries}

What connections exist between the target entry and existing knowledge?`;
}

/**
 * Build batch requests from a set of (target, context) pairs.
 * Pure function — no network or env side effects. Safe to call
 * regardless of flag state; callers decide whether to submit.
 *
 * @param pairs - target entries with their candidate context lists
 * @returns BatchChatRequest[] ready to pass to addRequests()
 */
export function buildConnectionScanRequests(
  pairs: { target: KgEntrySummary; context: KgEntrySummary[] }[],
): BatchChatRequest[] {
  const model = getModel("connection-scan");
  const seenIds = new Set<string>();
  const out: BatchChatRequest[] = [];

  for (const { target, context } of pairs) {
    if (!target?.id) continue;
    if (!context || context.length === 0) continue;

    // Batch request IDs must be unique per batch. Use target.id plus a short
    // timestamp-free suffix if somehow the same id appears twice in one call.
    let requestId = `kgconn_${target.id}`;
    if (seenIds.has(requestId)) {
      requestId = `${requestId}_${out.length}`;
    }
    seenIds.add(requestId);

    out.push({
      batch_request_id: requestId,
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(target, context) },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    });
  }

  return out;
}

/**
 * Extract fromEntryId from a batch_request_id.
 * IDs built by buildConnectionScanRequests() follow the pattern
 * `kgconn_<entryId>` or `kgconn_<entryId>_<suffix>`.
 */
export function parseTargetIdFromRequestId(requestId: string): string | null {
  if (!requestId.startsWith("kgconn_")) return null;
  const rest = requestId.slice("kgconn_".length);
  // Strip _<number> suffix if present (from duplicate-target collision handling)
  return rest.replace(/_\d+$/, "") || null;
}

/**
 * Parse one batch result page into ConnectionCandidate[].
 * Filters weak-confidence connections and unknown relationship types.
 *
 * @param page - a page from xaiBatchEngine.getBatchResultsPage / getAllBatchResults
 * @param validEntryIds - the set of entry IDs still active (used to drop stale refs)
 */
export function parseConnectionScanResults(
  page: BatchResultsPage,
  validEntryIds: Set<string>,
): ConnectionScanBatchResult {
  const candidates: ConnectionCandidate[] = [];
  const failures: { batch_request_id: string; error_message: string }[] = [];

  for (const s of page.succeeded) {
    const fromEntryId = parseTargetIdFromRequestId(s.batch_request_id);
    if (!fromEntryId) continue;
    if (!validEntryIds.has(fromEntryId)) continue; // stale — target got archived

    const parsed = safeParseLLMJson(
      s.content ?? "{}",
      `kgConnectionScanBatch.${s.batch_request_id}`,
    );
    const connections = parsed?.connections;
    if (!Array.isArray(connections)) continue;

    for (const c of connections) {
      if (!c?.toEntryId || typeof c.toEntryId !== "string") continue;
      if (!validEntryIds.has(c.toEntryId)) continue;
      if (c.toEntryId === fromEntryId) continue; // self-connection

      const conf = Number(c.confidence);
      if (!Number.isFinite(conf) || conf < 0.5) continue;

      const relType = VALID_REL_TYPES.has(c.relationshipType)
        ? c.relationshipType
        : "related_to";

      candidates.push({
        fromEntryId,
        toEntryId: c.toEntryId,
        relationshipType: relType as ConnectionCandidate["relationshipType"],
        confidence: Math.min(1, Math.max(0, conf)),
        reasoning: typeof c.reasoning === "string" ? c.reasoning.slice(0, 200) : "",
      });
    }
  }

  for (const f of page.failed) {
    failures.push({
      batch_request_id: f.batch_request_id,
      error_message: f.error_message,
    });
  }

  return { candidates, failures };
}

// ── Orchestration helpers ───────────────────────────────────────────────────

/**
 * Submit a connection-scan batch to xAI.
 * Throws if either flag is off — callers must check shouldUseKgBatch() first
 * and fall back to the synchronous findConnections() path.
 *
 * @param pairs - target entries with their candidate context
 * @param batchName - optional name; defaults to a timestamped label
 * @returns { batch_id, added } for later polling / result collection
 */
export async function submitConnectionScanBatch(
  pairs: { target: KgEntrySummary; context: KgEntrySummary[] }[],
  batchName?: string,
): Promise<{ batch_id: string; added: number }> {
  if (!shouldUseKgBatch()) {
    throw new Error(
      "KG connection-scan batch disabled — check KG_CONNECTION_SCAN_BATCH and BATCH_API_ENABLED",
    );
  }

  const requests = buildConnectionScanRequests(pairs);
  if (requests.length === 0) {
    throw new Error("No valid (target, context) pairs to submit");
  }

  const name = batchName ?? `kg-connection-scan-${new Date().toISOString()}`;
  const { batch_id } = await createBatch({ name });

  try {
    const { added } = await addRequests(batch_id, requests);
    return { batch_id, added };
  } catch (e: any) {
    // If addRequests fails, surface a descriptive error. The batch exists
    // but is empty — xAI will garbage-collect it after 24h. We deliberately
    // do NOT attempt a cancel call here to keep this module side-effect minimal.
    throw new Error(
      `submitConnectionScanBatch: addRequests failed for batch ${batch_id}: ${e?.message ?? e}`,
    );
  }
}

/**
 * Fetch + parse all results for a completed batch.
 * Does NOT poll — call after the batch has reached a terminal state
 * (e.g., via xaiBatchEngine.waitForBatchComplete).
 */
export async function collectConnectionScanResults(
  batchId: string,
  validEntryIds: Set<string>,
): Promise<ConnectionScanBatchResult> {
  const page = await getAllBatchResults(batchId);
  return parseConnectionScanResults(page, validEntryIds);
}
