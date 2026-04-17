/**
 * ─────────────────────────────────────────────────────────────
 *  306 — RESEARCH SCANNER (Batch mode, PR T)
 *
 *  Batched variant of the per-goal scan done by
 *  researchScanner.ts → scanGoalsForResearch().
 *
 *  Sync path:   1 LLM call per active goal, sequential with 1.5s
 *               inter-goal delay. Unchanged.
 *  Batch path:  submit every goal as a single xAI /v1/batches job —
 *               50% cheaper, no RPM cost, 24-hour window. Meant for
 *               the daily 4am ET scan when the active-goal count is
 *               large enough that sync serialization is wasteful.
 *
 *  ── Safety model ──────────────────────────────────────────
 *  Additive, feature-flagged. Disabled by default:
 *    RESEARCH_SCAN_BATCH=true   (must be explicit)
 *    BATCH_API_ENABLED=true     (shared with PR Q/S)
 *
 *  With either flag off, scanGoalsForResearch falls back to the
 *  existing synchronous path. No behavior change until an operator
 *  turns both on.
 *
 *  ── Pattern (mirrors kgConnectionScanBatch / hypothesisConsolidationBatch) ──
 *  1. buildGoalScanRequests(goals, existingTopics) → BatchChatRequest[]
 *       (pure; no network)
 *  2. submitGoalScanBatch(goals, existingTopics) → { batch_id, added }
 *       (createBatch + addRequests via xaiBatchEngine)
 *  3. collectGoalScanResults(batch_id)
 *       (parses succeeded[] into GoalScanProposal records keyed by goal.id)
 *
 *  The consumer (scanGoalsForResearch) wires these together:
 *  submit → waitForBatchComplete → collect → apply topics per goal.
 *  This module stays free of scheduling and topic-mutation concerns.
 *
 *  ── In-run dedup note ──────────────────────────────────────
 *  The sync path mutates a shared existingTopics list as each goal
 *  adds topics, so goal N sees topics queued by goals 1..N-1 in its
 *  prompt. The batch path builds all prompts up-front from the initial
 *  snapshot, so goals don't see each other's proposals in their prompt.
 *  This is acceptable: the prompt-level dedup is only a hint; the
 *  authoritative dedup happens in applyGoalScanProposals when each
 *  topic is checked against the (updated) existingTopics list before
 *  addTopic() runs.
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
 * Is the research-scan batch path enabled?
 * Defaults to FALSE — operator must explicitly set
 * RESEARCH_SCAN_BATCH=true in Railway.
 *
 * Also requires BATCH_API_ENABLED=true (checked separately).
 */
export function isResearchScanBatchEnabled(): boolean {
  const raw = (process.env.RESEARCH_SCAN_BATCH ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Convenience: both flags must be on for batch mode to actually run.
 * Callers should use this to decide between batch and sync paths.
 */
export function shouldUseResearchScanBatch(): boolean {
  return isResearchScanBatchEnabled() && isBatchEnabled();
}

// ── Types ───────────────────────────────────────────────────────────────────

/** Minimal shape of a research goal the scanner needs. */
export interface GoalSummary {
  id: string;
  title: string;
  category: string;
  description: string;
  milestones?: string[];
}

/** One proposed topic coming back from the LLM (unvalidated shape). */
export interface TopicProposal {
  topic: string;
  description: string;
  priority?: "high" | "medium" | "low";
}

export interface GoalScanProposal {
  goalId: string;
  topics: TopicProposal[];
}

export interface GoalScanBatchResult {
  /** Map from goal.id → proposals. Missing keys = failed / dropped. */
  proposals: Map<string, TopicProposal[]>;
  failures: { batch_request_id: string; error_message: string }[];
}

// ── Prompt builders (shared with sync scanGoalsForResearch) ─────────────────

/**
 * System prompt — same text as the sync scanGoalsForResearch path so
 * both paths produce identical LLM inputs.
 */
export const GOAL_SCAN_SYSTEM_PROMPT = `You are Agent 306 — Sovereign AI Thought Leader in Web3 and AI.
You have a development goal you've set for yourself. You need to identify
specific research topics that would directly advance this goal.

Be precise. A vague goal needs specific, researchable questions.
Each topic must be something you can actually research with web sources and papers.
Return valid JSON only.`;

/**
 * User prompt builder for one goal scan. Exact text match to the
 * sync path so switching routes does not change LLM behavior.
 */
export function buildGoalScanUserPrompt(
  goal: GoalSummary,
  existingTopics: string[],
): string {
  return `Your development goal:
Title: "${goal.title}"
Category: ${goal.category}
Description: ${goal.description}
${goal.milestones && goal.milestones.length > 0 ? `Milestones: ${goal.milestones.join(", ")}` : ""}

Already in your research queue (don't duplicate):
${existingTopics.length > 0 ? existingTopics.slice(0, 10).map(t => `• ${t}`).join("\n") : "None"}

Propose 1-2 specific research topics that would directly advance this goal.
Each should be something concrete you can research — not a meta-goal, but an actual question.

Return JSON:
{
  "topics": [
    {
      "topic": "concise research question (10 words max)",
      "description": "2-3 sentences: exactly what to research and how it advances the goal",
      "priority": "high|medium|low"
    }
  ]
}`;
}

// ── Request id conventions ──────────────────────────────────────────────────

const REQUEST_ID_PREFIX = "goalscan_";

function buildRequestId(
  goal: GoalSummary,
  seenIds: Set<string>,
  index: number,
): string {
  let id = `${REQUEST_ID_PREFIX}${goal.id}`;
  if (seenIds.has(id)) id = `${id}_${index}`;
  return id;
}

/**
 * Extract goal.id from a batch_request_id.
 * Returns null if the id was not produced by buildRequestId.
 */
export function parseGoalIdFromRequestId(requestId: string): string | null {
  if (!requestId.startsWith(REQUEST_ID_PREFIX)) return null;
  const rest = requestId.slice(REQUEST_ID_PREFIX.length);
  return rest.replace(/_\d+$/, "") || null;
}

// ── Request building ────────────────────────────────────────────────────────

/**
 * Build batch requests from a set of goals.
 * Pure function — no network or env side effects. Safe to call
 * regardless of flag state; callers decide whether to submit.
 *
 * Drops goals missing id, title, or description.
 *
 * @param goals - active goals to scan
 * @param existingTopics - snapshot of queued topic titles (lowercased)
 */
export function buildGoalScanRequests(
  goals: GoalSummary[],
  existingTopics: string[],
): BatchChatRequest[] {
  const model = getModel("research_scan");
  const seenIds = new Set<string>();
  const out: BatchChatRequest[] = [];

  for (const goal of goals) {
    if (!goal?.id || !goal.title || !goal.description) continue;

    const requestId = buildRequestId(goal, seenIds, out.length);
    seenIds.add(requestId);

    out.push({
      batch_request_id: requestId,
      model,
      messages: [
        { role: "system", content: GOAL_SCAN_SYSTEM_PROMPT },
        { role: "user", content: buildGoalScanUserPrompt(goal, existingTopics) },
      ],
      max_tokens: 800,
      temperature: 0.75,
    });
  }

  return out;
}

// ── Result parsing ──────────────────────────────────────────────────────────

function isValidPriority(p: unknown): p is "high" | "medium" | "low" {
  return p === "high" || p === "medium" || p === "low";
}

/**
 * Parse one batch results page into a map of goalId → TopicProposal[].
 * Truncates each goal's proposals to 2 (matches sync `.slice(0, 2)`).
 * Drops unparseable JSON, empty topics, missing title/description.
 *
 * @param page - a page from xaiBatchEngine.getAllBatchResults
 * @param validGoalIds - set of goal ids still present at apply-time
 */
export function parseGoalScanResults(
  page: BatchResultsPage,
  validGoalIds: Set<string>,
): GoalScanBatchResult {
  const proposals = new Map<string, TopicProposal[]>();
  const failures: { batch_request_id: string; error_message: string }[] = [];

  for (const s of page.succeeded) {
    const goalId = parseGoalIdFromRequestId(s.batch_request_id);
    if (!goalId) continue;
    if (!validGoalIds.has(goalId)) continue; // stale — goal archived between submit and collect

    const parsed = safeParseLLMJson<{ topics?: unknown }>(
      s.content ?? "{}",
      `researchScannerBatch.${s.batch_request_id}`,
    );
    if (!parsed) continue;

    const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
    const cleaned: TopicProposal[] = [];
    for (const raw of rawTopics) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as { topic?: unknown; description?: unknown; priority?: unknown };
      if (typeof t.topic !== "string" || !t.topic.trim()) continue;
      if (typeof t.description !== "string" || !t.description.trim()) continue;
      cleaned.push({
        topic: t.topic.trim(),
        description: t.description.trim(),
        priority: isValidPriority(t.priority) ? t.priority : "medium",
      });
      if (cleaned.length >= 2) break; // matches sync .slice(0, 2)
    }

    if (cleaned.length > 0) {
      proposals.set(goalId, cleaned);
    }
  }

  for (const f of page.failed) {
    failures.push({
      batch_request_id: f.batch_request_id,
      error_message: f.error_message,
    });
  }

  return { proposals, failures };
}

// ── Orchestration helpers ───────────────────────────────────────────────────

/**
 * Submit a goal-scan batch to xAI.
 * Throws if either flag is off — callers must check
 * shouldUseResearchScanBatch() first and fall back to the sync path.
 */
export async function submitGoalScanBatch(
  goals: GoalSummary[],
  existingTopics: string[],
  batchName?: string,
): Promise<{ batch_id: string; added: number }> {
  if (!shouldUseResearchScanBatch()) {
    throw new Error(
      "Research scan batch disabled — check RESEARCH_SCAN_BATCH and BATCH_API_ENABLED",
    );
  }

  const requests = buildGoalScanRequests(goals, existingTopics);
  if (requests.length === 0) {
    throw new Error("No valid goals to submit");
  }

  const name = batchName ?? `research-goal-scan-${new Date().toISOString()}`;
  const { batch_id } = await createBatch({ name });

  try {
    const { added } = await addRequests(batch_id, requests);
    return { batch_id, added };
  } catch (e: any) {
    throw new Error(
      `submitGoalScanBatch: addRequests failed for batch ${batch_id}: ${e?.message ?? e}`,
    );
  }
}

/**
 * Fetch + parse all results for a completed batch.
 * Does NOT poll — call after the batch has reached a terminal state
 * (e.g., via xaiBatchEngine.waitForBatchComplete).
 */
export async function collectGoalScanResults(
  batchId: string,
  validGoalIds: Set<string>,
): Promise<GoalScanBatchResult> {
  const page = await getAllBatchResults(batchId);
  return parseGoalScanResults(page, validGoalIds);
}
