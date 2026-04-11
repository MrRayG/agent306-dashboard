// ---------------------------------------------------------------------------
// 306 -- BREAKTHROUGH DETECTOR
//
// Evaluates confirmed hypotheses and synthesis discoveries for genuine novelty.
// A "breakthrough" is a finding that makes a NEW CONNECTION between ideas,
// could not be found by a simple web search, and scores >= 70 composite.
//
// Most findings are NOT breakthroughs. That's okay -- rigor is the point.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";

// -- Types ------------------------------------------------------------------

export interface Breakthrough {
  id:                   string;
  type:                 "hypothesis_confirmed" | "synthesis_discovery" | "contradiction_resolved" | "prediction_validated";
  title:                string;
  description:          string;
  noveltyScore:         number;   // 0-100
  impactScore:          number;   // 0-100
  compositeScore:       number;   // 0.6*novelty + 0.4*impact
  sourceHypothesisId?:  string;
  sourceSynthesisId?:   string;
  detectedAt:           number;
  evidence:             string[]; // KB entry IDs that support this
  published:            boolean;
  publishedTo:          string[];
}

interface BreakthroughEvaluation {
  isBreakthrough: boolean;
  noveltyScore:   number;
  impactScore:    number;
  compositeScore: number;
  suggestedTitle: string;
  reasoning:      string;
}

interface BreakthroughStore {
  breakthroughs:  Breakthrough[];
  lastUpdated:    string;
}

// -- Storage ----------------------------------------------------------------

const BREAKTHROUGHS_FILE = dataPath("breakthroughs.json");

function loadBreakthroughs(): BreakthroughStore {
  try {
    if (fs.existsSync(BREAKTHROUGHS_FILE)) {
      const data = JSON.parse(fs.readFileSync(BREAKTHROUGHS_FILE, "utf8"));
      if (!data.breakthroughs) data.breakthroughs = [];
      return data;
    }
  } catch {}
  return { breakthroughs: [], lastUpdated: new Date().toISOString() };
}

function saveBreakthroughs(store: BreakthroughStore) {
  store.lastUpdated = new Date().toISOString();
  try { fs.writeFileSync(BREAKTHROUGHS_FILE, JSON.stringify(store, null, 2)); } catch {}
}

// -- Dedup: skip if similar breakthrough exists in last 90 days -------------

function isDuplicate(title: string, store: BreakthroughStore): boolean {
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recent = store.breakthroughs.filter(b => b.detectedAt > ninetyDaysAgo);
  const normalised = title.toLowerCase().trim();
  return recent.some(b => {
    const existing = b.title.toLowerCase().trim();
    // Simple overlap heuristic: >60% word overlap
    const words1 = normalised.split(/\s+/);
    const words2Set = new Set(existing.split(/\s+/));
    const overlap = words1.filter(w => words2Set.has(w)).length;
    const maxLen = Math.max(words1.length, words2Set.size);
    return maxLen > 0 && overlap / maxLen > 0.6;
  });
}

// -- Core detection ---------------------------------------------------------

export async function detectBreakthroughs(
  finding: string,
  type: Breakthrough["type"],
  sourceId: string,
): Promise<Breakthrough | null> {
  try {
    console.log(`[Breakthrough] Evaluating finding for breakthrough potential (type: ${type})...`);

    const systemPrompt = `You are evaluating whether an AI research agent has discovered something genuinely novel.

Score on two dimensions (0-100 each):
1. NOVELTY: Is this finding new? (100 = no one has published this connection/insight before, 0 = well-known fact)
2. IMPACT: Does this finding change how we should think about the topic? (100 = paradigm-shifting, 0 = trivial/obvious)

A finding is a BREAKTHROUGH if:
- Composite score (0.6 * novelty + 0.4 * impact) >= 70
- It represents a NEW CONNECTION between ideas, not just a restatement
- It could not be found by a simple web search

Be rigorous. Most findings are NOT breakthroughs. That's okay.

Return valid JSON only:
{
  "noveltyScore": <number 0-100>,
  "impactScore": <number 0-100>,
  "suggestedTitle": "<concise title for this breakthrough>",
  "reasoning": "<1-2 sentence explanation of your scoring>"
}`;

    const userPrompt = `The finding to evaluate:\n\n${finding}`;

    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("breakthrough-evaluation"),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 500,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.error(`[Breakthrough] LLM call failed: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const eval_ = safeParseLLMJson<{
      noveltyScore: number;
      impactScore: number;
      suggestedTitle: string;
      reasoning: string;
    }>(raw, "BreakthroughDetector");

    if (!eval_) {
      console.error("[Breakthrough] Failed to parse LLM evaluation");
      return null;
    }

    const novelty = Math.max(0, Math.min(100, eval_.noveltyScore ?? 0));
    const impact  = Math.max(0, Math.min(100, eval_.impactScore ?? 0));
    const composite = Math.round(0.6 * novelty + 0.4 * impact);

    console.log(`[Breakthrough] Scores — novelty: ${novelty}, impact: ${impact}, composite: ${composite} (threshold: 70)`);

    if (composite < 70) {
      console.log(`[Breakthrough] Not a breakthrough (composite ${composite} < 70). Reasoning: ${eval_.reasoning}`);
      return null;
    }

    // Dedup check
    const store = loadBreakthroughs();
    if (isDuplicate(eval_.suggestedTitle, store)) {
      console.log(`[Breakthrough] Duplicate detected — skipping "${eval_.suggestedTitle}"`);
      return null;
    }

    const breakthrough: Breakthrough = {
      id:             `bt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      title:          eval_.suggestedTitle || "Untitled Breakthrough",
      description:    eval_.reasoning || finding.slice(0, 500),
      noveltyScore:   novelty,
      impactScore:    impact,
      compositeScore: composite,
      sourceHypothesisId: type === "hypothesis_confirmed" ? sourceId : undefined,
      sourceSynthesisId:  type === "synthesis_discovery" ? sourceId : undefined,
      detectedAt:     Date.now(),
      evidence:       [sourceId],
      published:      false,
      publishedTo:    [],
    };

    store.breakthroughs.unshift(breakthrough);
    saveBreakthroughs(store);

    console.log(`[Breakthrough] BREAKTHROUGH DETECTED: "${breakthrough.title}" (composite: ${composite})`);
    return breakthrough;
  } catch (e: any) {
    console.error(`[Breakthrough] Detection failed:`, e.message);
    return null;
  }
}

// -- Public readers ---------------------------------------------------------

export function getBreakthroughs(): BreakthroughStore {
  return loadBreakthroughs();
}

export function getBreakthroughCount(): number {
  return loadBreakthroughs().breakthroughs.length;
}
