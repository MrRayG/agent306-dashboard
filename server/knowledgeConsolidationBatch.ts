/**
 * ─────────────────────────────────────────────────────────────
 *  306 — KNOWLEDGE CONSOLIDATION (Batch mode, PR U)
 *
 *  Batched variant of the group-consolidation loop in
 *  knowledgeConsolidator.ts → consolidateGroup().
 *
 *  Sync path:   serial per-group LLM call with a 1s delay. OK
 *               for small weekly runs; unchanged.
 *  Batch path:  submit every group merge as a single xAI
 *               /v1/batches job — 50% cheaper, no per-call RPM,
 *               24-hour window. Meant for the nightly/weekly
 *               consolidation run when the group count is large
 *               enough that sync serialization is wasteful.
 *
 *  ── Safety model ──────────────────────────────────────────
 *  Additive, feature-flagged. Disabled by default:
 *    KNOWLEDGE_CONSOLIDATION_BATCH=true   (must be explicit)
 *    BATCH_API_ENABLED=true               (hard prerequisite)
 *
 *  With either flag off, runKnowledgeConsolidation() falls back
 *  to the existing synchronous consolidateGroup() path. No
 *  behavior change until an operator turns both on.
 *
 *  ── Pattern (mirrors hypothesisConsolidationBatch.ts) ──────
 *  1. buildKnowledgeConsolidationRequests(groups) → BatchChatRequest[]
 *       (pure; no network)
 *  2. submitKnowledgeConsolidationBatch(groups) → { batch_id, added }
 *       (createBatch + addRequests via xaiBatchEngine)
 *  3. collectKnowledgeConsolidationResults(batch_id)
 *       (parses succeeded[] into ConsolidatedEntry[] records keyed
 *        by group key)
 *
 *  The consumer (runKnowledgeConsolidation) wires these together:
 *  submit → waitForBatchComplete → collect → apply merges to
 *  memory_knowledge.json atomically. This module stays free of
 *  scheduling and file-mutation concerns.
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
 * Is the knowledge-consolidation batch path enabled?
 * Defaults to FALSE — operator must explicitly set
 * KNOWLEDGE_CONSOLIDATION_BATCH=true in Railway.
 *
 * Also requires BATCH_API_ENABLED=true (checked separately).
 */
export function isKnowledgeBatchEnabled(): boolean {
  const raw = (process.env.KNOWLEDGE_CONSOLIDATION_BATCH ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Convenience: both flags must be on for batch mode to actually run.
 * Callers should use this to decide between batch and sync paths.
 */
export function shouldUseKnowledgeBatch(): boolean {
  return isKnowledgeBatchEnabled() && isBatchEnabled();
}

// ── Types ───────────────────────────────────────────────────────────────────

/** A group of knowledge entries that should be consolidated together. */
export interface KnowledgeGroup {
  /** Stable key from findConsolidationGroups — e.g. "category:topic_a_topic_b" */
  key: string;
  /** Raw knowledge entries belonging to this group (3+ required). */
  entries: any[];
}

/** Shape of each consolidated entry returned by the LLM. */
export interface ConsolidatedEntry {
  title: string;
  summary: string;
  category: string;
  weight: number;
  tier: string;
  source: string;
}

export interface KnowledgeConsolidationBatchResult {
  /** Map from group.key → consolidated entries (1-2 per group). Missing keys = failed group. */
  consolidations: Map<string, ConsolidatedEntry[]>;
  failures: { batch_request_id: string; error_message: string }[];
}

// ── Prompt builders (shared with sync consolidateGroup) ─────────────────────

/**
 * System prompt — lifted verbatim from consolidateGroup() in
 * knowledgeConsolidator.ts so sync and batch paths are semantically
 * identical. Any tweak here should be mirrored there (or better:
 * consolidator should import from this module).
 */
export const KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT = `You consolidate multiple related knowledge entries into fewer, more comprehensive entries.

RULES:
- Preserve ALL unique facts, numbers, dates, and insights
- Combine overlapping information, remove redundancy
- Keep the most important/recent data points
- Maintain specificity — don't lose precision by over-generalizing
- Output 1-2 consolidated entries (1 if the topic is narrow, 2 if there are distinct sub-topics)
- Each summary should be up to 300 chars — pack in maximum useful information
- Set weight to the MAX weight from the source entries

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.

Required JSON schema:
{
  "consolidated": [
    {
      "title": "comprehensive title covering the merged topic",
      "summary": "dense, fact-packed summary combining all unique insights (up to 300 chars)",
      "category": "category name",
      "weight": 8
    }
  ]
}`;

/**
 * User prompt builder for a group consolidation. Matches the prompt
 * shape in knowledgeConsolidator.ts exactly.
 */
export function buildKnowledgeUserPrompt(group: KnowledgeGroup): string {
  const entrySummaries = group.entries
    .map((e: any) => `[${e.title}] ${e.summary} (weight: ${e.weight})`)
    .join("\n");
  return `Consolidate these ${group.entries.length} related knowledge entries into 1-2 comprehensive entries:\n\n${entrySummaries}`;
}

// ── Request id conventions ──────────────────────────────────────────────────

const REQUEST_ID_PREFIX = "kbcons_";

/**
 * Build a unique batch_request_id for a group.
 * Pattern: `kbcons_<sanitized-group-key>` (+ numeric suffix on collision).
 *
 * Group keys can contain `:` / `_` / word chars — we keep them mostly intact
 * but strip characters that would break request-id round-tripping.
 */
export function sanitizeGroupKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_:]/g, "_");
}

function buildRequestId(
  group: KnowledgeGroup,
  seenIds: Set<string>,
  index: number,
): string {
  let id = `${REQUEST_ID_PREFIX}${sanitizeGroupKey(group.key)}`;
  if (seenIds.has(id)) id = `${id}_${index}`;
  return id;
}

/**
 * Extract the (sanitized) group key from a batch_request_id.
 * Returns null if the id was not produced by buildRequestId (defensive).
 *
 * Note: we strip a trailing `_<digits>` collision suffix. Group keys
 * naturally end in word-chars (no trailing digits), so this is safe.
 */
export function parseGroupKeyFromRequestId(requestId: string): string | null {
  if (!requestId.startsWith(REQUEST_ID_PREFIX)) return null;
  const rest = requestId.slice(REQUEST_ID_PREFIX.length);
  const stripped = rest.replace(/_\d+$/, "");
  return stripped || null;
}

// ── Request building ────────────────────────────────────────────────────────

/**
 * Build batch requests from a set of groups.
 * Pure function — no network or env side effects. Safe to call
 * regardless of flag state; callers decide whether to submit.
 *
 * Drops groups with missing keys, fewer than 3 entries, or entries
 * missing a title/summary (matches sync skip conditions implicitly).
 */
export function buildKnowledgeConsolidationRequests(
  groups: KnowledgeGroup[],
): BatchChatRequest[] {
  const model = getModel("routine");
  const seenIds = new Set<string>();
  const out: BatchChatRequest[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group?.key || typeof group.key !== "string") continue;
    if (!Array.isArray(group.entries) || group.entries.length < 3) continue;

    const requestId = buildRequestId(group, seenIds, out.length);
    seenIds.add(requestId);

    out.push({
      batch_request_id: requestId,
      model,
      messages: [
        { role: "system", content: KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT },
        { role: "user", content: buildKnowledgeUserPrompt(group) },
      ],
      max_tokens: 600,
      temperature: 0.2,
    });
  }

  return out;
}

// ── Result parsing ──────────────────────────────────────────────────────────

/**
 * Parse a batch results page into a map of group.key → ConsolidatedEntry[].
 * Drops results with unparseable JSON, empty `consolidated` arrays, or
 * stale group keys (group no longer present at apply-time).
 *
 * @param page - a page from xaiBatchEngine.getAllBatchResults
 * @param validGroupKeys - set of (sanitized) group keys still present in
 *   the consolidation plan at apply-time (used to drop stale refs).
 * @param groupsByKey - lookup of original groups, used to fall back to
 *   a sensible default category and to compute maxWeight per group.
 */
export function parseKnowledgeConsolidationResults(
  page: BatchResultsPage,
  validGroupKeys: Set<string>,
  groupsByKey: Map<string, KnowledgeGroup>,
): KnowledgeConsolidationBatchResult {
  const consolidations = new Map<string, ConsolidatedEntry[]>();
  const failures: { batch_request_id: string; error_message: string }[] = [];

  for (const s of page.succeeded) {
    const key = parseGroupKeyFromRequestId(s.batch_request_id);
    if (!key) continue;
    if (!validGroupKeys.has(key)) continue; // stale

    const parsed = safeParseLLMJson<{ consolidated?: any[] }>(
      s.content ?? "{}",
      `knowledgeConsolidationBatch.${s.batch_request_id}`,
    );
    if (!parsed) continue;
    if (!Array.isArray(parsed.consolidated) || parsed.consolidated.length === 0) continue;

    const sourceGroup = groupsByKey.get(key);
    const fallbackCategory = sourceGroup?.entries?.[0]?.category ?? "uncategorized";
    const maxWeight = sourceGroup
      ? Math.max(...sourceGroup.entries.map((e: any) => e.weight ?? 5))
      : 5;

    const entries: ConsolidatedEntry[] = [];
    for (const c of parsed.consolidated) {
      if (!c || typeof c !== "object") continue;
      const title = typeof c.title === "string" ? c.title.trim() : "";
      const summaryRaw = typeof c.summary === "string" ? c.summary : "";
      if (!title || !summaryRaw) continue;

      const weightNum = typeof c.weight === "number" ? c.weight : maxWeight;

      entries.push({
        title,
        summary: summaryRaw.slice(0, 300),
        category: typeof c.category === "string" && c.category ? c.category : fallbackCategory,
        weight: Math.max(weightNum, maxWeight),
        tier: "active",
        source: "consolidation",
      });
    }

    if (entries.length === 0) continue;

    consolidations.set(key, entries);
  }

  for (const f of page.failed) {
    failures.push({
      batch_request_id: f.batch_request_id,
      error_message: f.error_message,
    });
  }

  return { consolidations, failures };
}

// ── Orchestration helpers ───────────────────────────────────────────────────

/**
 * Submit a knowledge-consolidation batch to xAI.
 * Throws if either flag is off — callers must check
 * shouldUseKnowledgeBatch() first and fall back to the sync path.
 *
 * @param groups - groups to consolidate
 * @param batchName - optional name; defaults to a timestamped label
 * @returns { batch_id, added } for later polling / result collection
 */
export async function submitKnowledgeConsolidationBatch(
  groups: KnowledgeGroup[],
  batchName?: string,
): Promise<{ batch_id: string; added: number }> {
  if (!shouldUseKnowledgeBatch()) {
    throw new Error(
      "Knowledge consolidation batch disabled — check KNOWLEDGE_CONSOLIDATION_BATCH and BATCH_API_ENABLED",
    );
  }

  const requests = buildKnowledgeConsolidationRequests(groups);
  if (requests.length === 0) {
    throw new Error("No valid groups to submit");
  }

  const name = batchName ?? `knowledge-consolidation-${new Date().toISOString()}`;
  const { batch_id } = await createBatch({ name });

  try {
    const { added } = await addRequests(batch_id, requests);
    return { batch_id, added };
  } catch (e: any) {
    throw new Error(
      `submitKnowledgeConsolidationBatch: addRequests failed for batch ${batch_id}: ${e?.message ?? e}`,
    );
  }
}

/**
 * Fetch + parse all results for a completed batch.
 * Does NOT poll — call after the batch has reached a terminal state
 * (e.g., via xaiBatchEngine.waitForBatchComplete).
 */
export async function collectKnowledgeConsolidationResults(
  batchId: string,
  validGroupKeys: Set<string>,
  groupsByKey: Map<string, KnowledgeGroup>,
): Promise<KnowledgeConsolidationBatchResult> {
  const page = await getAllBatchResults(batchId);
  return parseKnowledgeConsolidationResults(page, validGroupKeys, groupsByKey);
}
