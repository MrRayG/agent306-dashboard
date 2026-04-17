/**
 * ─────────────────────────────────────────────────────────────
 *  306 — REFLECTION (Batch mode, PR V)
 *
 *  Batched variant of the per-post reflect-on-post loop in
 *  reflectionEngine.ts → reflectOnPost() inside runReflection().
 *
 *  Sync path:   per-post LLM call with a 5-second rate-limit
 *               between calls (GROK_RATE_MS). Wasteful at batch
 *               size > 1; unchanged.
 *  Batch path:  submit every unchecked post as a single xAI
 *               /v1/batches job — 50% cheaper, no per-call RPM,
 *               24-hour window. Meant for the nightly reflection
 *               run when the unchecked-post count is large enough
 *               that serial rate-limited sync is wasteful.
 *
 *  ── Safety model ──────────────────────────────────────────
 *  Additive, feature-flagged. Disabled by default:
 *    REFLECTION_BATCH=true          (must be explicit)
 *    BATCH_API_ENABLED=true         (hard prerequisite)
 *
 *  With either flag off, runReflection() falls back to the
 *  existing synchronous reflectOnPost() path. No behavior change
 *  until an operator turns both on.
 *
 *  ── Pattern (mirrors knowledgeConsolidationBatch.ts) ──────
 *  1. buildReflectionRequests(lessons, { systemPrompt, buildUser })
 *       → BatchChatRequest[]  (pure; no network)
 *  2. submitReflectionBatch(lessons, prompts)
 *       → { batch_id, added }  (createBatch + addRequests)
 *  3. collectReflectionResults(batch_id, validTweetUrls)
 *       → ReflectionBatchResult keyed by tweet URL hash
 *
 *  The consumer (runReflection) wires these together: submit →
 *  waitForBatchComplete → collect → apply reflections +
 *  style-rule side-effects in the same loop order the sync path
 *  would have. This module stays free of file I/O and
 *  style-rule mutation concerns.
 * ─────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";
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
 * Is the reflection batch path enabled?
 * Defaults to FALSE — operator must explicitly set
 * REFLECTION_BATCH=true in Railway.
 *
 * Also requires BATCH_API_ENABLED=true (checked separately).
 */
export function isReflectionBatchEnabled(): boolean {
  const raw = (process.env.REFLECTION_BATCH ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Convenience: both flags must be on for batch mode to actually run.
 * Callers should use this to decide between batch and sync paths.
 */
export function shouldUseReflectionBatch(): boolean {
  return isReflectionBatchEnabled() && isBatchEnabled();
}

// ── Types ───────────────────────────────────────────────────────────────────

/** Minimal lesson shape needed for reflection. Matches the fields used
 *  by reflectionEngine.reflectOnPost's caller. */
export interface ReflectionLesson {
  tweetUrl: string;
  tweetText: string;
  engagement: {
    likes: number;
    replies: number;
    retweets: number;
    bookmarks: number;
    impressions: number;
  };
  score: number;
  signals?: { twitter: number };
}

/** Shape of the parsed LLM analysis payload for one post. */
export interface ReflectionAnalysis {
  whyWorked: string;
  patterns: string[];
  styleNote: string;
  ruleCandidate: string | null;
}

export interface ReflectionBatchResult {
  /** Map from tweetUrl → parsed analysis. Missing keys = failed / dropped. */
  analyses: Map<string, ReflectionAnalysis>;
  failures: { batch_request_id: string; error_message: string }[];
}

/** Caller-provided prompt builders. The reflection engine computes the
 *  system prompt once per run (it embeds current agent context + current
 *  style rules), and builds a user prompt per lesson. */
export interface ReflectionPrompts {
  /** One system prompt for every request in the batch. */
  systemPrompt: string;
  /** Build the per-lesson user prompt. */
  buildUserPrompt: (lesson: ReflectionLesson) => string;
}

// ── Request id conventions ──────────────────────────────────────────────────

const REQUEST_ID_PREFIX = "reflect_";

/**
 * Build a stable, batch-safe id from a tweet URL.
 *
 * Tweet URLs contain characters (`:/?.=#`) that don't round-trip cleanly
 * through request-id conventions, so we hash them. The hash is short
 * enough to read in logs but collision-resistant within a single run.
 */
export function hashTweetUrl(tweetUrl: string): string {
  return createHash("sha1").update(tweetUrl).digest("hex").slice(0, 16);
}

/**
 * Build a unique batch_request_id for a lesson.
 * Pattern: `reflect_<tweetUrl-hash>` (+ numeric suffix on collision).
 */
function buildRequestId(
  lesson: ReflectionLesson,
  seenIds: Set<string>,
  index: number,
): string {
  let id = `${REQUEST_ID_PREFIX}${hashTweetUrl(lesson.tweetUrl)}`;
  if (seenIds.has(id)) id = `${id}_${index}`;
  return id;
}

/**
 * Extract the tweet-URL hash from a batch_request_id.
 * Returns null if the id was not produced by buildRequestId (defensive).
 *
 * Note: hashTweetUrl returns a 16-char hex string, so we must not strip
 * "trailing digits" from the hash itself — only strip a `_<N>` collision
 * suffix if present.
 */
export function parseTweetHashFromRequestId(requestId: string): string | null {
  if (!requestId.startsWith(REQUEST_ID_PREFIX)) return null;
  const rest = requestId.slice(REQUEST_ID_PREFIX.length);
  // The hash is exactly 16 hex chars. If the rest is longer, anything
  // after position 16 (and starting with `_`) is the collision suffix.
  if (rest.length < 16) return null;
  const hash = rest.slice(0, 16);
  if (!/^[0-9a-f]{16}$/.test(hash)) return null;
  // Anything after the 16 chars must either be empty or start with "_<digits>"
  const tail = rest.slice(16);
  if (tail.length > 0 && !/^_\d+$/.test(tail)) return null;
  return hash;
}

// ── Request building ────────────────────────────────────────────────────────

/**
 * Build batch requests for a set of lessons using the caller's prompts.
 * Pure function — no network or env side effects. Safe to call regardless
 * of flag state; callers decide whether to submit.
 *
 * Drops lessons with empty tweetUrl or empty tweetText (they'd be useless
 * to reflect on and would break the URL→result join).
 */
export function buildReflectionRequests(
  lessons: ReflectionLesson[],
  prompts: ReflectionPrompts,
): BatchChatRequest[] {
  const model = getModel("reflection");
  const seenIds = new Set<string>();
  const out: BatchChatRequest[] = [];

  for (const lesson of lessons) {
    if (!lesson?.tweetUrl || typeof lesson.tweetUrl !== "string") continue;
    if (!lesson?.tweetText || typeof lesson.tweetText !== "string") continue;

    const requestId = buildRequestId(lesson, seenIds, out.length);
    seenIds.add(requestId);

    out.push({
      batch_request_id: requestId,
      model,
      messages: [
        { role: "system", content: prompts.systemPrompt },
        { role: "user", content: prompts.buildUserPrompt(lesson) },
      ],
      max_tokens: 1500,
      temperature: 0.3,
    });
  }

  return out;
}

// ── Result parsing ──────────────────────────────────────────────────────────

/**
 * Parse a batch results page into a map of tweetUrl → ReflectionAnalysis.
 * Drops results with unparseable JSON, a stale tweetUrl (no longer in
 * the pending set at apply-time), or empty `whyWorked`.
 *
 * @param page - a page from xaiBatchEngine.getAllBatchResults
 * @param lessonsByHash - lookup of pending lessons keyed by tweet-URL hash.
 *   Used to map back from request ids to the full tweetUrl.
 */
export function parseReflectionResults(
  page: BatchResultsPage,
  lessonsByHash: Map<string, ReflectionLesson>,
): ReflectionBatchResult {
  const analyses = new Map<string, ReflectionAnalysis>();
  const failures: { batch_request_id: string; error_message: string }[] = [];

  for (const s of page.succeeded) {
    const hash = parseTweetHashFromRequestId(s.batch_request_id);
    if (!hash) continue;
    const lesson = lessonsByHash.get(hash);
    if (!lesson) continue; // stale — lesson was removed between submit and collect

    const parsed = safeParseLLMJson<{
      whyWorked?: string;
      patterns?: unknown;
      styleNote?: string;
      ruleCandidate?: unknown;
    }>(s.content ?? "{}", `reflectionBatch.${s.batch_request_id}`);
    if (!parsed) continue;

    const whyWorked = typeof parsed.whyWorked === "string" ? parsed.whyWorked.trim() : "";
    if (!whyWorked) continue;

    const patterns = Array.isArray(parsed.patterns)
      ? parsed.patterns.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : [];

    const styleNote = typeof parsed.styleNote === "string" ? parsed.styleNote.trim() : "";

    let ruleCandidate: string | null = null;
    if (typeof parsed.ruleCandidate === "string") {
      const trimmed = parsed.ruleCandidate.trim();
      ruleCandidate = trimmed.length > 0 ? trimmed : null;
    }

    analyses.set(lesson.tweetUrl, {
      whyWorked,
      patterns,
      styleNote,
      ruleCandidate,
    });
  }

  for (const f of page.failed) {
    failures.push({
      batch_request_id: f.batch_request_id,
      error_message: f.error_message,
    });
  }

  return { analyses, failures };
}

// ── Orchestration helpers ───────────────────────────────────────────────────

/**
 * Submit a reflection batch to xAI.
 * Throws if either flag is off — callers must check
 * shouldUseReflectionBatch() first and fall back to the sync path.
 *
 * @param lessons - lessons to reflect on
 * @param prompts - shared system prompt + per-lesson user-prompt builder
 * @param batchName - optional name; defaults to a timestamped label
 * @returns { batch_id, added } for later polling / result collection
 */
export async function submitReflectionBatch(
  lessons: ReflectionLesson[],
  prompts: ReflectionPrompts,
  batchName?: string,
): Promise<{ batch_id: string; added: number }> {
  if (!shouldUseReflectionBatch()) {
    throw new Error(
      "Reflection batch disabled — check REFLECTION_BATCH and BATCH_API_ENABLED",
    );
  }

  const requests = buildReflectionRequests(lessons, prompts);
  if (requests.length === 0) {
    throw new Error("No valid lessons to submit");
  }

  const name = batchName ?? `reflection-${new Date().toISOString()}`;
  const { batch_id } = await createBatch({ name });

  try {
    const { added } = await addRequests(batch_id, requests);
    return { batch_id, added };
  } catch (e: any) {
    throw new Error(
      `submitReflectionBatch: addRequests failed for batch ${batch_id}: ${e?.message ?? e}`,
    );
  }
}

/**
 * Fetch + parse all results for a completed batch.
 * Does NOT poll — call after the batch has reached a terminal state
 * (e.g., via xaiBatchEngine.waitForBatchComplete).
 *
 * @param batchId - batch id returned by submitReflectionBatch
 * @param lessonsByHash - lookup from hash → lesson, built by the caller
 *   from the same lesson list used at submit time.
 */
export async function collectReflectionResults(
  batchId: string,
  lessonsByHash: Map<string, ReflectionLesson>,
): Promise<ReflectionBatchResult> {
  const page = await getAllBatchResults(batchId);
  return parseReflectionResults(page, lessonsByHash);
}
