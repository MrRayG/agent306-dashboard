// ---------------------------------------------------------------------------
// 306 -- SELF-EVOLUTION ENGINE v2
//
// Diff-based comparative self-reflection. Instead of vibes-only reflection,
// captures pre-cycle snapshot, compares post-cycle state, computes diffs,
// and asks: "yesterday's hypothesis vs today's evidence — what changed?"
//
// Pre-cycle snapshot stored as /data/pre_cycle_snapshot.json (overwritten).
// Diffs APPENDED to /data/evolution_diffs.json (growing history, 90-day cap).
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import {
  getCompetencyProfile,
  getCompetencyContext,
  updateCompetencyLevel,
  rotateGrowthFocus,
  type CompetencyProfile,
} from "./competencyFramework.js";
import { recordProposedInsights, expireStaleProposed, failStaleOpen, computeLedgerStats } from "./insightLedger.js";
import { runVerificationPass, buildMetaReflectionContext } from "./selfChangeVerifier.js";

import { postChatCompletions } from "./llmCall.js";
// -- Types ------------------------------------------------------------------

export interface EvolutionInsight {
  id:                string;
  sourceType:        "research_thread" | "hypothesis" | "synthesis" | "breakthrough";
  sourceId:          string;
  insight:           string;
  selfApplication:   string;
  actionItem?:       string;
  status:            "identified" | "planning" | "implementing" | "validated" | "dismissed";
  createdAt:         number;
  implementedAt?:    number;
  validationResult?: string;
}

interface EvolutionInsightStore {
  insights:    EvolutionInsight[];
  lastUpdated: string;
  totalCycles: number;
}

export interface EvolutionDiff {
  id:               string;
  date:             string;
  cycleNumber:      number;
  hypothesisDiffs:  Array<{
    hypothesisId:   string;
    claim:          string;
    yesterdayState:  { status: string; confidence: number; evidenceCount: number };
    todayState:     { status: string; confidence: number; evidenceCount: number };
    delta:          string;
    interpretation: string;
  }>;
  knowledgeDiffs: {
    added:           number;
    archived:        number;
    weightChanges:   Array<{ entryId: string; oldWeight: number; newWeight: number }>;
    newCategories:   string[];
    categoryGrowth:  Record<string, number>;
  };
  pruningSuggestions: string[];
  overallNarrative:   string;
}

interface PreCycleSnapshot {
  timestamp:   string;
  hypotheses:  Array<{
    id:         string;
    claim:      string;
    status:     string;
    confidence: number;
    evidenceCount: number;
  }>;
  kbStats: {
    totalEntries:    number;
    activeEntries:   number;
    archivedEntries: number;
    byCategory:      Record<string, number>;
    weightDistribution: Record<number, number>;
  };
}

// -- Storage ----------------------------------------------------------------

const EVOLUTION_INSIGHTS_FILE = dataPath("evolution_insights.json");
const PRE_CYCLE_SNAPSHOT_FILE = dataPath("pre_cycle_snapshot.json");
const EVOLUTION_DIFFS_FILE = dataPath("evolution_diffs.json");

function loadInsights(): EvolutionInsightStore {
  try {
    if (fs.existsSync(EVOLUTION_INSIGHTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EVOLUTION_INSIGHTS_FILE, "utf8"));
      if (!data.insights) data.insights = [];
      if (!data.totalCycles) data.totalCycles = 0;
      return data;
    }
  } catch {}
  return { insights: [], lastUpdated: new Date().toISOString(), totalCycles: 0 };
}

function saveInsights(store: EvolutionInsightStore) {
  store.lastUpdated = new Date().toISOString();
  try { fs.writeFileSync(EVOLUTION_INSIGHTS_FILE, JSON.stringify(store, null, 2)); } catch {}
}

function loadSnapshot(): PreCycleSnapshot | null {
  try {
    if (fs.existsSync(PRE_CYCLE_SNAPSHOT_FILE)) {
      return JSON.parse(fs.readFileSync(PRE_CYCLE_SNAPSHOT_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function saveSnapshot(snapshot: PreCycleSnapshot): void {
  try { fs.writeFileSync(PRE_CYCLE_SNAPSHOT_FILE, JSON.stringify(snapshot)); } catch {}
}

function loadDiffs(): EvolutionDiff[] {
  try {
    if (fs.existsSync(EVOLUTION_DIFFS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EVOLUTION_DIFFS_FILE, "utf8"));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

function saveDiffs(diffs: EvolutionDiff[]): void {
  try { fs.writeFileSync(EVOLUTION_DIFFS_FILE, JSON.stringify(diffs)); } catch {}
}

// -- Pre-cycle snapshot capture --------------------------------------------

export function capturePreCycleSnapshot(): void {
  try {
    const { knowledge } = require("./memoryEngine.js");
    const { getResearchLab } = require("./researchEngine.js");

    const lab = getResearchLab();
    const entries = knowledge.entries ?? [];

    // Hypothesis states
    const hypotheses = (lab.hypotheses ?? []).map((h: any) => ({
      id: h.id,
      claim: h.claim ?? "",
      status: h.status ?? "forming",
      confidence: parseFloat(h.confidence) || 0.5,
      evidenceCount: (h.redFlags?.length ?? 0) + (h.rubricScores ? 1 : 0) + (h.debateOutcome ? 1 : 0),
    }));

    // KB stats
    const activeEntries = entries.filter((e: any) => (e.status ?? "active") === "active");
    const archivedEntries = entries.filter((e: any) => (e.status ?? "active") === "archived");

    const byCategory: Record<string, number> = {};
    const weightDistribution: Record<number, number> = {};

    for (const entry of activeEntries) {
      const cat = (entry as any).category ?? "other";
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      const w = (entry as any).weight ?? 5;
      weightDistribution[w] = (weightDistribution[w] ?? 0) + 1;
    }

    const snapshot: PreCycleSnapshot = {
      timestamp: new Date().toISOString(),
      hypotheses,
      kbStats: {
        totalEntries: entries.length,
        activeEntries: activeEntries.length,
        archivedEntries: archivedEntries.length,
        byCategory,
        weightDistribution,
      },
    };

    saveSnapshot(snapshot);
    console.log(`[SelfEvolution] Pre-cycle snapshot captured — ${hypotheses.length} hypotheses, ${activeEntries.length} active KB entries`);
  } catch (e: any) {
    console.error("[SelfEvolution] Pre-cycle snapshot failed:", e.message);
  }
}

// -- Core reflection with diff-based comparison ----------------------------

export async function runSelfEvolutionReflection(context: {
  newKBEntries?:      string[];
  hypothesisChanges?: string[];
  breakthroughs?:     string[];
}): Promise<EvolutionInsight[]> {
  try {
    console.log("[SelfEvolution] Starting diff-based end-of-cycle self-reflection...");

    const store = loadInsights();
    const preSnapshot = loadSnapshot();

    // Gather current state for comparison
    let currentHypotheses: Array<{ id: string; claim: string; status: string; confidence: number; evidenceCount: number }> = [];
    let currentKbStats = { totalEntries: 0, activeEntries: 0, archivedEntries: 0, byCategory: {} as Record<string, number>, weightDistribution: {} as Record<number, number> };

    try {
      const { knowledge } = require("./memoryEngine.js");
      const { getResearchLab } = require("./researchEngine.js");
      const lab = getResearchLab();
      const entries = knowledge.entries ?? [];

      currentHypotheses = (lab.hypotheses ?? []).map((h: any) => ({
        id: h.id,
        claim: h.claim ?? "",
        status: h.status ?? "forming",
        confidence: parseFloat(h.confidence) || 0.5,
        evidenceCount: (h.redFlags?.length ?? 0) + (h.rubricScores ? 1 : 0) + (h.debateOutcome ? 1 : 0),
      }));

      const activeEntries = entries.filter((e: any) => (e.status ?? "active") === "active");
      const archivedEntries = entries.filter((e: any) => (e.status ?? "active") === "archived");

      const byCategory: Record<string, number> = {};
      const weightDistribution: Record<number, number> = {};
      for (const entry of activeEntries) {
        const cat = (entry as any).category ?? "other";
        byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        const w = (entry as any).weight ?? 5;
        weightDistribution[w] = (weightDistribution[w] ?? 0) + 1;
      }

      currentKbStats = {
        totalEntries: entries.length,
        activeEntries: activeEntries.length,
        archivedEntries: archivedEntries.length,
        byCategory,
        weightDistribution,
      };
    } catch {}

    // Compute diffs if we have a pre-cycle snapshot
    let diffContext = "";
    let hypothesisDiffs: EvolutionDiff["hypothesisDiffs"] = [];
    let knowledgeDiffs: EvolutionDiff["knowledgeDiffs"] = {
      added: 0, archived: 0, weightChanges: [], newCategories: [], categoryGrowth: {},
    };

    if (preSnapshot) {
      // Hypothesis diffs
      const preMap = new Map(preSnapshot.hypotheses.map(h => [h.id, h]));
      for (const current of currentHypotheses) {
        const prev = preMap.get(current.id);
        if (prev) {
          if (prev.status !== current.status || Math.abs(prev.confidence - current.confidence) > 0.05 || prev.evidenceCount !== current.evidenceCount) {
            const confDelta = current.confidence - prev.confidence;
            const evDelta = current.evidenceCount - prev.evidenceCount;
            hypothesisDiffs.push({
              hypothesisId: current.id,
              claim: current.claim,
              yesterdayState: { status: prev.status, confidence: prev.confidence, evidenceCount: prev.evidenceCount },
              todayState: { status: current.status, confidence: current.confidence, evidenceCount: current.evidenceCount },
              delta: `${prev.status !== current.status ? `status: ${prev.status}→${current.status}` : ""}${confDelta !== 0 ? ` confidence ${confDelta > 0 ? "+" : ""}${confDelta.toFixed(2)}` : ""}${evDelta !== 0 ? ` ${evDelta > 0 ? "+" : ""}${evDelta} evidence` : ""}`.trim(),
              interpretation: "",
            });
          }
        }
      }

      // KB diffs
      knowledgeDiffs.added = Math.max(0, currentKbStats.activeEntries - preSnapshot.kbStats.activeEntries);
      knowledgeDiffs.archived = Math.max(0, currentKbStats.archivedEntries - preSnapshot.kbStats.archivedEntries);

      // Category growth
      for (const [cat, count] of Object.entries(currentKbStats.byCategory)) {
        const prevCount = preSnapshot.kbStats.byCategory[cat] ?? 0;
        const delta = count - prevCount;
        if (delta !== 0) knowledgeDiffs.categoryGrowth[cat] = delta;
        if (prevCount === 0 && count > 0) knowledgeDiffs.newCategories.push(cat);
      }

      diffContext = `
HYPOTHESIS CHANGES THIS CYCLE:
${hypothesisDiffs.length > 0
  ? hypothesisDiffs.map(d => `- "${d.claim.slice(0, 60)}": ${d.delta}`).join("\n")
  : "No hypothesis state changes"}

KNOWLEDGE BASE CHANGES:
- Added: ${knowledgeDiffs.added} entries
- Archived: ${knowledgeDiffs.archived} entries
- New categories: ${knowledgeDiffs.newCategories.join(", ") || "none"}
- Category growth: ${Object.entries(knowledgeDiffs.categoryGrowth).map(([c, n]) => `${c}: ${n > 0 ? "+" : ""}${n}`).join(", ") || "none"}
`;
    }

    const newEntries = context.newKBEntries?.join("\n- ") || "None today";
    const hypChanges = context.hypothesisChanges?.join("\n- ") || "None today";
    const btList     = context.breakthroughs?.join("\n- ") || "None today";

    // Competency context for the reflection
    const competencyProfile = getCompetencyProfile();
    const competencySummary = competencyProfile.competencies
      .map(c => `${c.name} (${c.category}): level ${c.currentLevel}/10`)
      .join(", ");
    const growthFocusNames = competencyProfile.growthFocus
      .map(id => competencyProfile.competencies.find(c => c.id === id)?.name ?? id)
      .join(", ");

    // Meta-reflection: surface prior-cycle kept/broken commitments so failed
    // self-changes become first-class inputs to the next reflection rather
    // than silently accumulating. Guarded — if the verifier fails, fall back
    // to a neutral placeholder so the prompt still renders.
    let metaReflection = "";
    try {
      metaReflection = buildMetaReflectionContext();
    } catch (e: any) {
      console.warn("[SelfEvolution] buildMetaReflectionContext failed (non-fatal):", e?.message);
      metaReflection = "SELF-CHANGE TRACK RECORD: (unavailable this cycle)";
    }

    const systemPrompt = `You are Agent 306, an autonomous AI research intelligence. You just completed a daily research cycle. Compare your state BEFORE the cycle to AFTER.
${diffContext}
New knowledge entries today:\n- ${newEntries}
Hypothesis changes:\n- ${hypChanges}
Breakthroughs:\n- ${btList}

${metaReflection}

COMMUNICATION COMPETENCY LEVELS:
${competencySummary}
Current growth focus: ${growthFocusNames}

Review these diffs. Ask yourself:
1. "Yesterday's hypothesis vs today's evidence — what CHANGED? What should I PRUNE?"
2. "How does what I learned today apply to ME? What should I do differently?"
3. "What entries have been superseded by newer information?"
4. "What hypotheses have been stuck in 'forming' for 7+ days with no evidence movement?"
5. "What categories are accumulating entries but not connecting to anything?"
6. "Based on today's posts and learning, which communication competencies showed growth or need work?"

Return valid JSON only:
{
  "insights": [
    {
      "insight": "<what you learned that is relevant to your own operation>",
      "selfApplication": "<how this maps to YOUR architecture/capabilities>",
      "actionItem": "<concrete change>",
      "competencyId": "<optional: competency id this relates to, e.g. 'storytelling', 'critical-thinking'>"
    }
  ],
  "competencyUpdates": [
    {
      "competencyId": "<e.g. 'storytelling'>",
      "delta": 0.5,
      "reason": "<evidence-based reason for adjustment>"
    }
  ],
  "pruningSuggestions": ["<entry or hypothesis to prune and why>"],
  "overallNarrative": "<1-2 sentence summary: today's biggest shift>"
}

Rules:
- Maximum 3 insights (only the most impactful)
- Each insight must be ACTIONABLE, reference specific competencies when relevant
- competencyUpdates: max 3, delta range [-1, +1], only when you have EVIDENCE
- pruningSuggestions: be specific about WHAT to prune
- overallNarrative: honest assessment of today vs yesterday`;

    const res = await postChatCompletions({
        model: getModel("self-evolution-reflection"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Compare your pre-cycle state to post-cycle. What changed? What to prune? How do you evolve?" },
        ],
        max_tokens: 1500,
        temperature: 0.5,
      }, AbortSignal.timeout(60000));

    if (!res.ok) {
      console.error(`[SelfEvolution] LLM call failed: ${res.status}`);
      return [];
    }

    const data = await res.json() as any;
    const raw  = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseLLMJson<{
      insights: Array<{
        insight: string;
        selfApplication: string;
        actionItem?: string;
        competencyId?: string;
      }>;
      competencyUpdates?: Array<{
        competencyId: string;
        delta: number;
        reason: string;
      }>;
      pruningSuggestions?: string[];
      overallNarrative?: string;
    }>(raw, "SelfEvolution");

    if (!parsed?.insights || !Array.isArray(parsed.insights)) {
      console.log("[SelfEvolution] No insights parsed from reflection");
      return [];
    }

    // Cap at 3
    const capped = parsed.insights.slice(0, 3);
    const newInsights: EvolutionInsight[] = [];

    for (const item of capped) {
      if (!item.insight) continue;
      const insight: EvolutionInsight = {
        id:              `evo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sourceType:      "synthesis",
        sourceId:        `daily_cycle_${new Date().toISOString().slice(0, 10)}`,
        insight:         item.insight,
        selfApplication: item.selfApplication || "",
        actionItem:      item.actionItem,
        status:          item.actionItem ? "identified" : "validated",
        createdAt:       Date.now(),
      };
      newInsights.push(insight);
      store.insights.unshift(insight);
      console.log(`[SelfEvolution] Insight: "${item.insight.slice(0, 80)}..." → Action: ${item.actionItem ? '"' + item.actionItem.slice(0, 60) + '..."' : "none"}`);
    }

    store.totalCycles++;
    saveInsights(store);

    // Apply competency level updates from reflection
    if (parsed.competencyUpdates && Array.isArray(parsed.competencyUpdates)) {
      for (const update of parsed.competencyUpdates.slice(0, 3)) {
        if (update.competencyId && typeof update.delta === "number" && update.reason) {
          updateCompetencyLevel(update.competencyId, update.delta, `[self-evolution] ${update.reason}`);
        }
      }
    }

    // Rotate growth focus every few days
    try {
      rotateGrowthFocus();
    } catch (e: any) {
      console.warn("[SelfEvolution] Growth focus rotation failed (non-fatal):", e.message);
    }

    // Append diff to evolution_diffs.json (never overwrite — this is history)
    if (preSnapshot) {
      const diffs = loadDiffs();
      const diff: EvolutionDiff = {
        id: `diff_${Date.now()}`,
        date: new Date().toISOString(),
        cycleNumber: store.totalCycles,
        hypothesisDiffs: hypothesisDiffs.map(d => ({
          ...d,
          interpretation: parsed.overallNarrative ?? "",
        })),
        knowledgeDiffs,
        pruningSuggestions: parsed.pruningSuggestions ?? [],
        overallNarrative: parsed.overallNarrative ?? "",
      };

      diffs.push(diff);

      // Cap at 90 days of diffs
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const trimmed = diffs.filter(d => new Date(d.date).getTime() > ninetyDaysAgo);
      saveDiffs(trimmed);

      console.log(`[SelfEvolution] Diff appended — ${hypothesisDiffs.length} hypothesis changes, ${knowledgeDiffs.added} KB added, ${(parsed.pruningSuggestions ?? []).length} pruning suggestions`);
    }

    // ── WRITE-PATH: Verify prior cycle, expire stale, record new commitments ───
    //
    // This is the mechanism that closes the reflect→act→verify loop. Without
    // it, SelfEvolution produces insights that evaporate. With it, every
    // insight becomes a tracked commitment that either verifies (behavior
    // actually changed) or fails (first-class self-change failure signal that
    // feeds the next reflection).
    try {
      const verifyResult = runVerificationPass();
      if (verifyResult.verified + verifyResult.failed > 0) {
        console.log(
          `[SelfEvolution] Verification: ${verifyResult.verified} verified, ${verifyResult.failed} failed (self-integrity=${verifyResult.selfIntegrityScore.toFixed(2)})`,
        );
      }
      expireStaleProposed(3);   // Proposed insights not accepted in 3 days → expired
      failStaleOpen(14);        // Accepted/in-flight past 14 days → failed

      // Record this cycle's actionable insights as proposed commitments.
      const tracked = recordProposedInsights(
        store.totalCycles,
        newInsights.map(i => ({ id: i.id, insight: i.insight, actionItem: i.actionItem })),
      );
      const stats = computeLedgerStats();
      console.log(
        `[SelfEvolution] Ledger state: ${tracked.length} new proposed, ${stats.openCount} open, ${stats.verified} verified all-time, ${stats.failed} failed, self-integrity=${stats.selfIntegrityScore.toFixed(2)}`,
      );
    } catch (e: any) {
      console.warn("[SelfEvolution] Ledger update failed (non-fatal):", e.message);
    }

    console.log(`[SelfEvolution] Reflection complete — ${newInsights.length} insight(s) from cycle #${store.totalCycles}`);
    return newInsights;
  } catch (e: any) {
    console.error("[SelfEvolution] Reflection failed:", e.message);
    return [];
  }
}

// -- Public readers ---------------------------------------------------------

export function getEvolutionInsights(): EvolutionInsightStore {
  return loadInsights();
}

export function getEvolutionDiffs(): EvolutionDiff[] {
  return loadDiffs();
}
