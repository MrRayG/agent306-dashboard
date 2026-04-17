/**
 * ─────────────────────────────────────────────────────────────
 *  Knowledge Consolidation Engine
 *
 *  Periodically merges related knowledge entries to keep the KB efficient.
 *  Groups entries by topic/category, then uses LLM to synthesize groups
 *  into consolidated entries that retain the key insights.
 * ─────────────────────────────────────────────────────────────
 */

import fs from "fs";
import { dataPath } from "./dataPaths.js";
import { LLM_BASE_URL, LLM_API_KEY, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

import { postChatCompletions } from "./llmCall.js";
import { waitForBatchComplete } from "./xaiBatchEngine.js";
import {
  shouldUseKnowledgeBatch,
  submitKnowledgeConsolidationBatch,
  collectKnowledgeConsolidationResults,
  sanitizeGroupKey,
  KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT,
  buildKnowledgeUserPrompt,
  type KnowledgeGroup,
} from "./knowledgeConsolidationBatch.js";
interface ConsolidationResult {
  groupsFound: number;
  entriesMerged: number;
  entriesAfter: number;
  savings: number;
}

/**
 * Find groups of related entries that can be consolidated.
 * Uses category + keyword overlap to identify merge candidates.
 */
function findConsolidationGroups(entries: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();

  // Group by category first
  const byCategory = new Map<string, any[]>();
  for (const entry of entries) {
    if ((entry.status ?? "active") === "archived") continue;
    if ((entry.tier ?? "operational") === "core") continue; // never consolidate core
    const cat = entry.category || "uncategorized";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(entry);
  }

  // Within each category, find entries with high keyword overlap
  const byCategoryKeys = Array.from(byCategory.keys());
  for (const cat of byCategoryKeys) {
    const catEntries = byCategory.get(cat)!;
    if (catEntries.length < 3) continue;

    const topicGroups = new Map<string, any[]>();
    for (const entry of catEntries) {
      const words = (entry.title || "").toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      let matched = false;
      const topicKeys = Array.from(topicGroups.keys());
      for (const topic of topicKeys) {
        const group = topicGroups.get(topic)!;
        const topicWords = topic.split("|");
        const overlap = words.filter((w: string) => topicWords.some((tw: string) => tw.includes(w) || w.includes(tw)));
        if (overlap.length >= 2 || (overlap.length >= 1 && words.length <= 3)) {
          group.push(entry);
          matched = true;
          break;
        }
      }
      if (!matched) {
        topicGroups.set(words.join("|"), [entry]);
      }
    }

    // Only keep groups with 3+ entries (worth consolidating)
    const topicKeys = Array.from(topicGroups.keys());
    for (const topic of topicKeys) {
      const group = topicGroups.get(topic)!;
      if (group.length >= 3) {
        groups.set(`${cat}:${topic.split("|").slice(0, 3).join("_")}`, group);
      }
    }
  }

  return groups;
}

/**
 * Consolidate a group of related entries into 1-2 comprehensive entries.
 * Sync path — used when the batch flag is off, or as a per-group fallback
 * when the batch didn't produce a result for this group.
 *
 * Uses the shared prompt strings from knowledgeConsolidationBatch.ts so
 * sync and batch paths produce semantically identical outputs.
 */
async function consolidateGroup(entries: any[]): Promise<any[]> {
  try {
    const res = await postChatCompletions({
        model: getModel("routine"),
        messages: [{
          role: "system",
          content: KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT,
        }, {
          role: "user",
          content: buildKnowledgeUserPrompt({ key: "sync", entries }),
        }],
        temperature: 0.2,
        max_tokens: 600,
      }, AbortSignal.timeout(20000));

    if (!res.ok) return entries; // fail safe — keep originals

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(raw, "KnowledgeConsolidator") as { consolidated?: any[] } | null;

    if (!parsed?.consolidated?.length) return entries;

    const maxWeight = Math.max(...entries.map((e: any) => e.weight ?? 5));

    return parsed.consolidated.map((c: any) => ({
      title: c.title,
      summary: (c.summary || "").slice(0, 300),
      category: c.category || entries[0].category,
      weight: Math.max(c.weight || maxWeight, maxWeight),
      tier: "active",
      source: "consolidation",
    }));
  } catch (e: any) {
    console.warn(`[Consolidation] Failed to consolidate group:`, e.message);
    return entries; // fail safe
  }
}

/**
 * Apply a set of consolidated entries for a single group to the
 * knowledge state, mutating `knowledge.entries` in place.
 *
 * Shared by sync and batch paths so the insert/delete shape is
 * identical. Only commits when the consolidation actually reduces
 * entry count (matches the original sync gate).
 *
 * @returns the number of entries merged away (>=0)
 */
function applyConsolidationToKnowledge(
  knowledge: any,
  groupKey: string,
  groupEntries: any[],
  consolidated: any[],
  nowIso: string,
): number {
  if (consolidated.length >= groupEntries.length) return 0;

  const oldIds = new Set(groupEntries.map((e: any) => e.id));
  knowledge.entries = knowledge.entries.filter((e: any) => !oldIds.has(e.id));

  for (const c of consolidated) {
    knowledge.entries.push({
      ...c,
      id: `k_consolidated_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      learnedAt: nowIso,
      updatedAt: nowIso,
      status: "active",
    });
  }

  const merged = groupEntries.length - consolidated.length;
  console.log(`[Consolidation] "${groupKey}": ${groupEntries.length} → ${consolidated.length} entries`);
  return merged;
}

/**
 * Run the full consolidation pass.
 * Call from the daily cycle (weekly, e.g., Sundays).
 */
export async function runKnowledgeConsolidation(): Promise<ConsolidationResult> {
  const knowledgeFile = dataPath("memory_knowledge.json");
  let knowledge: any;
  try {
    knowledge = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
  } catch {
    return { groupsFound: 0, entriesMerged: 0, entriesAfter: 0, savings: 0 };
  }

  const entriesBefore = knowledge.entries.length;
  const groups = findConsolidationGroups(knowledge.entries);

  if (groups.size === 0) {
    console.log("[Consolidation] No consolidation groups found");
    return { groupsFound: 0, entriesMerged: 0, entriesAfter: entriesBefore, savings: 0 };
  }

  console.log(`[Consolidation] Found ${groups.size} groups to consolidate`);

  let totalMerged = 0;

  // Process up to 5 groups per run (budget-conscious)
  const groupsToProcess = Array.from(groups.entries()).slice(0, 5);

  if (shouldUseKnowledgeBatch()) {
    totalMerged += await consolidateViaBatch(knowledge, groupsToProcess);
  } else {
    totalMerged += await consolidateViaSync(knowledge, groupsToProcess);
  }

  // Save
  knowledge.totalEntries = knowledge.entries.length;
  fs.writeFileSync(knowledgeFile, JSON.stringify(knowledge, null, 2));

  const result = {
    groupsFound: groups.size,
    entriesMerged: totalMerged,
    entriesAfter: knowledge.entries.length,
    savings: entriesBefore - knowledge.entries.length,
  };

  console.log(`[Consolidation] Complete: ${entriesBefore} → ${result.entriesAfter} entries (saved ${result.savings})`);
  return result;
}

/**
 * Sync consolidation path — issue per-group LLM calls serially with a
 * 1s delay between groups (matches historical behavior).
 */
async function consolidateViaSync(
  knowledge: any,
  groupsToProcess: Array<[string, any[]]>,
): Promise<number> {
  let merged = 0;
  for (const [groupKey, groupEntries] of groupsToProcess) {
    const consolidated = await consolidateGroup(groupEntries);
    merged += applyConsolidationToKnowledge(
      knowledge,
      groupKey,
      groupEntries,
      consolidated,
      new Date().toISOString(),
    );
    // Small delay between groups to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return merged;
}

/**
 * Batch consolidation path — submit every group as a single xAI
 * /v1/batches job, poll for completion, then apply results.
 *
 * On submit/wait failure every group is left untouched (no silent
 * fallback) and the error is logged. The caller writes the knowledge
 * file regardless so partial progress from earlier groups is preserved.
 */
async function consolidateViaBatch(
  knowledge: any,
  groupsToProcess: Array<[string, any[]]>,
): Promise<number> {
  const pollMs = Number(process.env.KNOWLEDGE_CONSOLIDATION_BATCH_POLL_MS) || 60_000;
  const timeoutMs = Number(process.env.KNOWLEDGE_CONSOLIDATION_BATCH_TIMEOUT_MS) || 6 * 60 * 60 * 1000;

  // Shape groups for the batch module and build sanitized-key lookups
  const groups: KnowledgeGroup[] = groupsToProcess.map(([key, entries]) => ({ key, entries }));
  const groupsBySanitizedKey = new Map<string, KnowledgeGroup>();
  const originalKeyBySanitized = new Map<string, string>();
  for (const g of groups) {
    const sk = sanitizeGroupKey(g.key);
    groupsBySanitizedKey.set(sk, g);
    originalKeyBySanitized.set(sk, g.key);
  }
  const validGroupKeys = new Set(groupsBySanitizedKey.keys());

  let batchId: string;
  let added = 0;
  try {
    const submit = await submitKnowledgeConsolidationBatch(groups);
    batchId = submit.batch_id;
    added = submit.added;
    console.log(`[Consolidation] Submitted batch ${batchId} with ${added} groups`);
  } catch (e: any) {
    console.warn(`[Consolidation] Batch submit failed, leaving groups unmerged:`, e?.message ?? e);
    return 0;
  }

  try {
    await waitForBatchComplete(batchId, { pollIntervalMs: pollMs, timeoutMs });
  } catch (e: any) {
    console.warn(`[Consolidation] Batch ${batchId} wait failed:`, e?.message ?? e);
    return 0;
  }

  const { consolidations, failures } = await collectKnowledgeConsolidationResults(
    batchId,
    validGroupKeys,
    groupsBySanitizedKey,
  );

  if (failures.length > 0) {
    console.warn(`[Consolidation] Batch ${batchId} had ${failures.length} failures`);
  }

  // Apply results
  let merged = 0;
  const now = new Date().toISOString();
  for (const [sanitizedKey, entries] of consolidations) {
    const group = groupsBySanitizedKey.get(sanitizedKey);
    if (!group) continue;
    const origKey = originalKeyBySanitized.get(sanitizedKey) ?? sanitizedKey;
    merged += applyConsolidationToKnowledge(
      knowledge,
      origKey,
      group.entries,
      entries,
      now,
    );
  }
  return merged;
}

/** Get current KB efficiency stats */
export function getKBEfficiencyStats(): {
  totalEntries: number;
  activeEntries: number;
  archivedEntries: number;
  consolidationCandidates: number;
  estimatedSavings: number;
  capacityUsed: string;
} {
  const knowledgeFile = dataPath("memory_knowledge.json");
  let knowledge: any;
  try {
    knowledge = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
  } catch {
    return { totalEntries: 0, activeEntries: 0, archivedEntries: 0, consolidationCandidates: 0, estimatedSavings: 0, capacityUsed: "0%" };
  }

  const entries = knowledge.entries || [];
  const active = entries.filter((e: any) => (e.status ?? "active") === "active");
  const archived = entries.filter((e: any) => (e.status ?? "active") === "archived");
  const groups = findConsolidationGroups(entries);
  const candidateCount = Array.from(groups.values()).reduce((sum, g) => sum + g.length, 0);
  const estimatedSavings = candidateCount - groups.size;

  const MAX = Number(process.env.AGENT_MAX_KB_ENTRIES) || 2000;

  return {
    totalEntries: entries.length,
    activeEntries: active.length,
    archivedEntries: archived.length,
    consolidationCandidates: candidateCount,
    estimatedSavings,
    capacityUsed: `${Math.round((entries.length / MAX) * 100)}%`,
  };
}
