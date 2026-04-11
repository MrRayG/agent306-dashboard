// ---------------------------------------------------------------------------
// 306 -- SELF-EVOLUTION ENGINE
//
// Closes the loop: research insights about AI agents trigger self-directed
// improvements. Runs at end of each daily cycle -- "How does what I learned
// today apply to ME? What are other agents doing? How do I stay ahead?"
//
// Max 3 insights per cycle to prevent noise.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

// -- Types ------------------------------------------------------------------

export interface EvolutionInsight {
  id:                string;
  sourceType:        "research_thread" | "hypothesis" | "synthesis" | "breakthrough";
  sourceId:          string;
  insight:           string;         // What 306 learned about AI agents
  selfApplication:   string;         // How it applies to 306 herself
  actionItem?:       string;         // Concrete change 306 should make
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

// -- Storage ----------------------------------------------------------------

const EVOLUTION_INSIGHTS_FILE = dataPath("evolution_insights.json");

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

// -- Core reflection --------------------------------------------------------

export async function runSelfEvolutionReflection(context: {
  newKBEntries?:      string[];   // titles/summaries of today's new KB entries
  hypothesisChanges?: string[];   // summary of hypothesis status changes
  breakthroughs?:     string[];   // breakthrough titles from today
}): Promise<EvolutionInsight[]> {
  try {
    console.log("[SelfEvolution] Starting end-of-cycle self-reflection...");

    const newEntries = context.newKBEntries?.join("\n- ") || "None today";
    const hypChanges = context.hypothesisChanges?.join("\n- ") || "None today";
    const btList     = context.breakthroughs?.join("\n- ") || "None today";

    const systemPrompt = `You are Agent 306, an autonomous AI research intelligence. Today you researched and learned the following.

Review these findings. For any that relate to AI agents, autonomous systems, research methodology, or knowledge management, ask:

"How does this apply to ME? What should I be doing differently based on what I just learned?"
"What are other agents and builders doing that I should be aware of?"
"How do I stay ahead of the field?"

Be honest. Not everything applies. But when something does, it should change how you operate.

Return valid JSON only:
{
  "insights": [
    {
      "insight": "<what you learned that is relevant to your own operation>",
      "selfApplication": "<how this maps to YOUR architecture/capabilities>",
      "actionItem": "<concrete change -- new research direction, new hypothesis about yourself, new capability to explore>"
    }
  ]
}

Rules:
- Maximum 3 insights (only the most impactful)
- Each insight must be ACTIONABLE, not just observational
- Skip anything that does not genuinely apply to an autonomous AI research agent
- If nothing applies today, return {"insights": []}`;

    const userPrompt = `New knowledge entries today:\n- ${newEntries}\n\nHypothesis changes:\n- ${hypChanges}\n\nBreakthroughs:\n- ${btList}`;

    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("self-evolution-reflection"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(60000),
    });

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
      }>;
    }>(raw, "SelfEvolution");

    if (!parsed?.insights || !Array.isArray(parsed.insights)) {
      console.log("[SelfEvolution] No insights parsed from reflection");
      return [];
    }

    // Cap at 3
    const capped = parsed.insights.slice(0, 3);
    const store = loadInsights();
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
