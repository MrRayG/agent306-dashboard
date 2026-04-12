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
 */
async function consolidateGroup(entries: any[]): Promise<any[]> {
  const entrySummaries = entries.map(e => `[${e.title}] ${e.summary} (weight: ${e.weight})`).join("\n");

  try {
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("routine"),
        messages: [{
          role: "system",
          content: `You consolidate multiple related knowledge entries into fewer, more comprehensive entries.

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
}`
        }, {
          role: "user",
          content: `Consolidate these ${entries.length} related knowledge entries into 1-2 comprehensive entries:\n\n${entrySummaries}`
        }],
        temperature: 0.2,
        max_tokens: 600,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return entries; // fail safe — keep originals

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson(raw, "KnowledgeConsolidator") ?? {};

    if (!parsed.consolidated?.length) return entries;

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

  for (const [groupKey, groupEntries] of groupsToProcess) {
    const consolidated = await consolidateGroup(groupEntries);

    if (consolidated.length < groupEntries.length) {
      // Remove old entries
      const oldIds = new Set(groupEntries.map((e: any) => e.id));
      knowledge.entries = knowledge.entries.filter((e: any) => !oldIds.has(e.id));

      // Add consolidated entries
      const now = new Date().toISOString();
      for (const c of consolidated) {
        knowledge.entries.push({
          ...c,
          id: `k_consolidated_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          learnedAt: now,
          updatedAt: now,
          status: "active",
        });
      }

      totalMerged += groupEntries.length - consolidated.length;
      console.log(`[Consolidation] "${groupKey}": ${groupEntries.length} → ${consolidated.length} entries`);
    }

    // Small delay between groups to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 1000));
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
