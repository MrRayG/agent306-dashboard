/**
 * ─────────────────────────────────────────────────────────────
 *  306 — HYPOTHESIS CONSOLIDATION (Batch mode, PR S)
 *
 *  Batched variant of the cluster-merge loop in
 *  hypothesisConsolidator.ts → mergeCluster().
 *
 *  Sync path:   latency-insensitive but runs sequentially with
 *               a 1-second delay between clusters. Still fine
 *               for small batches; unchanged.
 *  Batch path:  submit every cluster merge as a single xAI
 *               /v1/batches job — 50% cheaper, no per-call RPM,
 *               24-hour window. Meant for the nightly consolidation
 *               run in dailyCycleEngine.ts when the cluster count
 *               is large enough that sync serialization is wasteful.
 *
 *  ── Safety model ──────────────────────────────────────────
 *  Additive, feature-flagged. Disabled by default:
 *    HYPOTHESIS_CONSOLIDATION_BATCH=true   (must be explicit)
 *    BATCH_API_ENABLED=true                (hard prerequisite)
 *
 *  With either flag off, consolidateHypotheses() falls back to
 *  the existing synchronous mergeCluster() path. No behavior
 *  change until an operator turns both on.
 *
 *  ── Pattern (mirrors kgConnectionScanBatch.ts) ────────────
 *  1. buildConsolidationRequests(clusters) → BatchChatRequest[]
 *       (pure; no network)
 *  2. submitConsolidationBatch(clusters) → { batch_id, added }
 *       (createBatch + addRequests via xaiBatchEngine)
 *  3. collectConsolidationResults(batch_id)
 *       (parses succeeded[] into MergeResult records keyed by
 *        representative.id)
 *
 *  The consumer (consolidateHypotheses) wires these together:
 *  submit → waitForBatchComplete → collect → apply merges to
 *  researchLab atomically. This module stays free of scheduling
 *  and lab-mutation concerns.
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
import type { Hypothesis } from "./researchEngine.js";

// ── Feature flag ────────────────────────────────────────────────────────────

/**
 * Is the hypothesis-consolidation batch path enabled?
 * Defaults to FALSE — operator must explicitly set
 * HYPOTHESIS_CONSOLIDATION_BATCH=true in Railway.
 *
 * Also requires BATCH_API_ENABLED=true (checked separately).
 */
export function isHypothesisBatchEnabled(): boolean {
  const raw = (process.env.HYPOTHESIS_CONSOLIDATION_BATCH ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Convenience: both flags must be on for batch mode to actually run.
 * Callers should use this to decide between batch and sync paths.
 */
export function shouldUseHypothesisBatch(): boolean {
  return isHypothesisBatchEnabled() && isBatchEnabled();
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface HypothesisCluster {
  representative: Hypothesis;
  members: Hypothesis[];
  similarity: number;
}

export interface MergeResult {
  canonical: string;
  reasoning: string;
}

export interface ConsolidationBatchResult {
  /** Map from representative.id → merge result. Missing keys = failed cluster. */
  merges: Map<string, MergeResult>;
  failures: { batch_request_id: string; error_message: string }[];
}

// ── Prompt builders (shared with sync mergeCluster) ─────────────────────────

/**
 * System prompt — lifted verbatim from mergeCluster() in
 * hypothesisConsolidator.ts so sync and batch paths are semantically
 * identical. Any tweak here should be mirrored there (or better:
 * consolidator should import from this module).
 */
export const CONSOLIDATION_SYSTEM_PROMPT =
  "You merge redundant research hypotheses into canonical versions. Be precise and testable.";

/**
 * User prompt builder for a cluster merge. Matches the prompt shape
 * in hypothesisConsolidator.ts exactly.
 */
export function buildConsolidationUserPrompt(cluster: HypothesisCluster): string {
  const claimList = cluster.members
    .map((m, i) => `[${i}] "${m.claim}" (confidence: ${m.confidence}, status: ${m.status})`)
    .join("\n");

  return `You are Agent 306's research consolidation system. These ${cluster.members.length} hypotheses are variants of the same core idea. Merge them into ONE canonical hypothesis that:

1. Captures the strongest, most precise version of the claim
2. Is specific and testable (not vague)
3. Incorporates the best evidence and nuance from all variants
4. Is concise (1-2 sentences)

VARIANT HYPOTHESES:
${claimList}

Respond with JSON:
{
  "canonical": "The single merged hypothesis claim",
  "reasoning": "Brief explanation of what was merged and why this formulation is strongest"
}`;
}

// ── Request id conventions ──────────────────────────────────────────────────

const REQUEST_ID_PREFIX = "hypmerge_";

/**
 * Build a unique batch_request_id for a cluster.
 * Pattern: `hypmerge_<representative.id>` (+ numeric suffix on collision).
 */
function buildRequestId(
  cluster: HypothesisCluster,
  seenIds: Set<string>,
  index: number,
): string {
  let id = `${REQUEST_ID_PREFIX}${cluster.representative.id}`;
  if (seenIds.has(id)) id = `${id}_${index}`;
  return id;
}

/**
 * Extract representative.id from a batch_request_id.
 * Returns null if the id was not produced by buildRequestId (defensive).
 */
export function parseRepresentativeIdFromRequestId(requestId: string): string | null {
  if (!requestId.startsWith(REQUEST_ID_PREFIX)) return null;
  const rest = requestId.slice(REQUEST_ID_PREFIX.length);
  return rest.replace(/_\d+$/, "") || null;
}

// ── Request building ────────────────────────────────────────────────────────

/**
 * Build batch requests from a set of clusters.
 * Pure function — no network or env side effects. Safe to call
 * regardless of flag state; callers decide whether to submit.
 *
 * Drops clusters with no valid representative.id or empty members list.
 */
export function buildConsolidationRequests(
  clusters: HypothesisCluster[],
): BatchChatRequest[] {
  const model = getModel("hypothesis-consolidation");
  const seenIds = new Set<string>();
  const out: BatchChatRequest[] = [];

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (!cluster?.representative?.id) continue;
    if (!cluster.members || cluster.members.length < 2) continue;

    const requestId = buildRequestId(cluster, seenIds, out.length);
    seenIds.add(requestId);

    out.push({
      batch_request_id: requestId,
      model,
      messages: [
        { role: "system", content: CONSOLIDATION_SYSTEM_PROMPT },
        { role: "user", content: buildConsolidationUserPrompt(cluster) },
      ],
      max_tokens: 500,
      temperature: 0.1,
    });
  }

  return out;
}

// ── Result parsing ──────────────────────────────────────────────────────────

/**
 * Parse a batch results page into a map of representative.id → MergeResult.
 * Drops results with missing canonical text or unparseable JSON.
 *
 * @param page - a page from xaiBatchEngine.getAllBatchResults
 * @param validRepresentativeIds - set of representative ids still present
 *   in the research lab at apply-time (used to drop stale refs when a
 *   representative was removed between submit and collect)
 */
export function parseConsolidationResults(
  page: BatchResultsPage,
  validRepresentativeIds: Set<string>,
): ConsolidationBatchResult {
  const merges = new Map<string, MergeResult>();
  const failures: { batch_request_id: string; error_message: string }[] = [];

  for (const s of page.succeeded) {
    const repId = parseRepresentativeIdFromRequestId(s.batch_request_id);
    if (!repId) continue;
    if (!validRepresentativeIds.has(repId)) continue; // stale

    const parsed = safeParseLLMJson<{ canonical?: string; reasoning?: string }>(
      s.content ?? "{}",
      `hypothesisConsolidationBatch.${s.batch_request_id}`,
    );
    if (!parsed) continue;

    const canonical = typeof parsed.canonical === "string" ? parsed.canonical.trim() : "";
    if (!canonical) continue;

    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";

    merges.set(repId, { canonical, reasoning });
  }

  for (const f of page.failed) {
    failures.push({
      batch_request_id: f.batch_request_id,
      error_message: f.error_message,
    });
  }

  return { merges, failures };
}

// ── Orchestration helpers ───────────────────────────────────────────────────

/**
 * Submit a consolidation batch to xAI.
 * Throws if either flag is off — callers must check
 * shouldUseHypothesisBatch() first and fall back to the sync path.
 *
 * @param clusters - clusters to merge
 * @param batchName - optional name; defaults to a timestamped label
 * @returns { batch_id, added } for later polling / result collection
 */
export async function submitConsolidationBatch(
  clusters: HypothesisCluster[],
  batchName?: string,
): Promise<{ batch_id: string; added: number }> {
  if (!shouldUseHypothesisBatch()) {
    throw new Error(
      "Hypothesis consolidation batch disabled — check HYPOTHESIS_CONSOLIDATION_BATCH and BATCH_API_ENABLED",
    );
  }

  const requests = buildConsolidationRequests(clusters);
  if (requests.length === 0) {
    throw new Error("No valid clusters to submit");
  }

  const name = batchName ?? `hypothesis-consolidation-${new Date().toISOString()}`;
  const { batch_id } = await createBatch({ name });

  try {
    const { added } = await addRequests(batch_id, requests);
    return { batch_id, added };
  } catch (e: any) {
    throw new Error(
      `submitConsolidationBatch: addRequests failed for batch ${batch_id}: ${e?.message ?? e}`,
    );
  }
}

/**
 * Fetch + parse all results for a completed batch.
 * Does NOT poll — call after the batch has reached a terminal state
 * (e.g., via xaiBatchEngine.waitForBatchComplete).
 */
export async function collectConsolidationResults(
  batchId: string,
  validRepresentativeIds: Set<string>,
): Promise<ConsolidationBatchResult> {
  const page = await getAllBatchResults(batchId);
  return parseConsolidationResults(page, validRepresentativeIds);
}
