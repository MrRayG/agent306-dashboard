// ---------------------------------------------------------------------------
// 306 -- BREAKTHROUGH DETECTOR v2
//
// Multi-signal scoring system for genuine novelty detection.
// Four dimensions: noveltyScore (LLM), citationDiversity (computed),
// graphTopology (computed), predictiveAccuracy (tracked predictions).
//
// Composite: (novelty*0.3) + (citationDiversity*0.2) + (graphTopology*0.2)
//            + (predictiveAccuracy*0.3). Threshold >= 70.
// ---------------------------------------------------------------------------

import * as fs from "fs";
import { dataPath } from "./dataPaths.js";
import { getModel } from "./modelRouter.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { knowledge } from "./memoryEngine.js";

// -- Types ------------------------------------------------------------------

export interface BreakthroughScoreV2 {
  noveltyScore:        number; // 0-100 (LLM evaluated)
  citationDiversity:   number; // 0-100 (computed from unique source domains)
  graphTopology:       number; // 0-100 (bridge score + centrality)
  predictiveAccuracy:  number; // 0-100 (prediction verification)
  compositeScore:      number; // weighted average
}

export interface Breakthrough {
  id:                   string;
  type:                 "hypothesis_confirmed" | "synthesis_discovery" | "contradiction_resolved" | "prediction_validated";
  title:                string;
  description:          string;
  noveltyScore:         number;
  impactScore:          number;   // kept for backward compat
  compositeScore:       number;
  scoreBreakdown?:      BreakthroughScoreV2;
  sourceHypothesisId?:  string;
  sourceSynthesisId?:   string;
  detectedAt:           number;
  evidence:             string[];
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

// -- Prediction tracking ----------------------------------------------------

export interface Prediction {
  id:                   string;
  claim:                string;
  hypothesisId:         string;
  madeAt:               number;
  checkDate:            number;
  status:               "pending" | "verified_true" | "verified_false" | "inconclusive";
  verificationEvidence?: string;
  verifiedAt?:          number;
}

interface PredictionStore {
  predictions: Prediction[];
  lastUpdated: string;
}

// -- Storage ----------------------------------------------------------------

const BREAKTHROUGHS_FILE = dataPath("breakthroughs.json");
const PREDICTIONS_FILE = dataPath("predictions.json");

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

function loadPredictions(): PredictionStore {
  try {
    if (fs.existsSync(PREDICTIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PREDICTIONS_FILE, "utf8"));
      if (!data.predictions) data.predictions = [];
      return data;
    }
  } catch {}
  return { predictions: [], lastUpdated: new Date().toISOString() };
}

function savePredictions(store: PredictionStore) {
  store.lastUpdated = new Date().toISOString();
  try { fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(store)); } catch {}
}

// -- Dedup: skip if similar breakthrough exists in last 90 days -------------

function isDuplicate(title: string, store: BreakthroughStore): boolean {
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recent = store.breakthroughs.filter(b => b.detectedAt > ninetyDaysAgo);
  const normalised = title.toLowerCase().trim();
  return recent.some(b => {
    const existing = b.title.toLowerCase().trim();
    const words1 = normalised.split(/\s+/);
    const words2Set = new Set(existing.split(/\s+/));
    const overlap = words1.filter(w => words2Set.has(w)).length;
    const maxLen = Math.max(words1.length, words2Set.size);
    return maxLen > 0 && overlap / maxLen > 0.6;
  });
}

// -- Citation diversity scoring (computed, NOT LLM) -------------------------

function scoreCitationDiversity(linkedEntryIds: string[]): number {
  if (linkedEntryIds.length === 0) return 0;

  const linkedEntries = knowledge.entries.filter(e => linkedEntryIds.includes(e.id));
  const sourceDomains = new Set<string>();
  const sourceTypes = new Set<string>();

  for (const entry of linkedEntries) {
    const src = (entry.source ?? "").toLowerCase();
    if (!src) continue;

    // Extract domain
    try {
      const url = new URL(src.startsWith("http") ? src : `https://${src}`);
      sourceDomains.add(url.hostname);
    } catch {
      // Not a URL — treat the source string itself as a domain
      sourceDomains.add(src.split(/[\s/]/)[0]);
    }

    // Classify source type
    if (/arxiv|scholar|semantic|pubmed|doi\.org|ncbi/i.test(src)) sourceTypes.add("academic");
    else if (/reuters|bloomberg|nyt|bbc|cnn|guardian|wired|techcrunch|verge/i.test(src)) sourceTypes.add("news");
    else if (/twitter|x\.com|farcaster|reddit|discord/i.test(src)) sourceTypes.add("social");
    else if (/\.gov|whitehouse|sec\.gov|europa\.eu/i.test(src)) sourceTypes.add("official");
    else sourceTypes.add("other");
  }

  // Base score: 1 source = 20, 2 = 40, 3 = 60, 4 = 80, 5+ = 100
  const uniqueCount = sourceDomains.size;
  const baseScore = Math.min(100, uniqueCount * 20);

  // Bonus: 10 pts per different source TYPE
  const typeBonus = Math.min(40, sourceTypes.size * 10);

  return Math.min(100, baseScore + typeBonus);
}

// -- Graph topology scoring (computed from knowledge graph) -----------------

function scoreGraphTopology(linkedEntryIds: string[]): number {
  if (linkedEntryIds.length === 0) return 0;

  try {
    const connectionsFile = dataPath("knowledge-connections-graph.json");
    const clustersFile = dataPath("knowledge-clusters.json");

    let connections: any[] = [];
    let clusters: any[] = [];

    try {
      if (fs.existsSync(connectionsFile)) {
        const data = JSON.parse(fs.readFileSync(connectionsFile, "utf8"));
        connections = data.connections ?? [];
      }
    } catch {}

    try {
      if (fs.existsSync(clustersFile)) {
        const data = JSON.parse(fs.readFileSync(clustersFile, "utf8"));
        clusters = data.clusters ?? [];
      }
    } catch {}

    if (connections.length === 0) return 0;

    const linkedSet = new Set(linkedEntryIds);

    // connectionCount: how many edges connect to/from linked entries
    let connectionCount = 0;
    for (const conn of connections) {
      if (linkedSet.has(conn.fromEntryId) || linkedSet.has(conn.toEntryId)) {
        connectionCount++;
      }
    }

    // bridgeScore: do these entries connect otherwise-disconnected clusters?
    let bridgeScore = 0;
    if (clusters.length >= 2) {
      const clustersContainingLinked: Set<string> = new Set();
      for (const cluster of clusters) {
        for (const entryId of cluster.entryIds ?? []) {
          if (linkedSet.has(entryId)) {
            clustersContainingLinked.add(cluster.id);
            break;
          }
        }
      }
      // If linked entries span multiple clusters, high bridge score
      bridgeScore = Math.min(100, (clustersContainingLinked.size - 1) * 50);
    }

    // centralityRank: degree centrality normalized
    // Count degree for each entry in the graph
    const degrees: Record<string, number> = {};
    for (const conn of connections) {
      degrees[conn.fromEntryId] = (degrees[conn.fromEntryId] ?? 0) + 1;
      degrees[conn.toEntryId] = (degrees[conn.toEntryId] ?? 0) + 1;
    }
    const allDegrees = Object.values(degrees);
    const maxDegree = Math.max(1, ...allDegrees);

    // Average centrality of linked entries
    let totalCentrality = 0;
    let counted = 0;
    for (const id of linkedEntryIds) {
      if (degrees[id]) {
        totalCentrality += degrees[id] / maxDegree;
        counted++;
      }
    }
    const centralityScore = counted > 0 ? (totalCentrality / counted) * 100 : 0;

    // Composite: bridgeScore * 0.6 + centrality * 0.4
    return Math.min(100, Math.round(bridgeScore * 0.6 + centralityScore * 0.4));
  } catch (e: any) {
    console.error("[Breakthrough] Graph topology scoring failed:", e.message);
    return 0;
  }
}

// -- Predictive accuracy scoring -------------------------------------------

function scorePredictiveAccuracy(sourceId: string): number {
  try {
    const store = loadPredictions();
    const relatedPredictions = store.predictions.filter(p => p.hypothesisId === sourceId);
    if (relatedPredictions.length === 0) return 0;

    const verified = relatedPredictions.filter(p => p.status === "verified_true");
    if (verified.length > 0) return 100; // 306 called it — max score

    const falsified = relatedPredictions.filter(p => p.status === "verified_false");
    if (falsified.length > 0) return 0; // Prediction was wrong

    // Pending predictions get a modest score
    return 20;
  } catch {
    return 0;
  }
}

// -- Prediction extraction -------------------------------------------------

const TIME_BOUND_PATTERNS = [
  /by\s+Q[1-4]\b/i,
  /within\s+\d+\s+days/i,
  /before\s+\d{4}/i,
  /by\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}/i,
  /in\s+the\s+next\s+\d+\s+(weeks?|months?|days?)/i,
  /by\s+(end\s+of\s+)?(20\d{2})/i,
  /within\s+\d+\s+(weeks?|months?)/i,
];

export function extractPrediction(hypothesis: {
  id: string;
  claim: string;
  prediction?: string;
  timeframe?: string;
}): Prediction | null {
  const text = `${hypothesis.claim} ${hypothesis.prediction ?? ""} ${hypothesis.timeframe ?? ""}`;
  const hasTimeBound = TIME_BOUND_PATTERNS.some(pat => pat.test(text));
  if (!hasTimeBound) return null;

  // Parse a check date from timeframe
  let checkDate = Date.now() + 90 * 24 * 60 * 60 * 1000; // default 90 days
  const daysMatch = text.match(/within\s+(\d+)\s+days/i);
  const weeksMatch = text.match(/within\s+(\d+)\s+weeks?/i);
  const monthsMatch = text.match(/within\s+(\d+)\s+months?|in\s+the\s+next\s+(\d+)\s+months?/i);

  if (daysMatch) checkDate = Date.now() + parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
  else if (weeksMatch) checkDate = Date.now() + parseInt(weeksMatch[1]) * 7 * 24 * 60 * 60 * 1000;
  else if (monthsMatch) {
    const n = parseInt(monthsMatch[1] ?? monthsMatch[2]);
    checkDate = Date.now() + n * 30 * 24 * 60 * 60 * 1000;
  }

  return {
    id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim: hypothesis.prediction ?? hypothesis.claim,
    hypothesisId: hypothesis.id,
    madeAt: Date.now(),
    checkDate,
    status: "pending",
  };
}

export function storePrediction(prediction: Prediction): void {
  try {
    const store = loadPredictions();
    // Dedup: don't store duplicate predictions for the same hypothesis
    if (store.predictions.some(p => p.hypothesisId === prediction.hypothesisId && p.status === "pending")) return;
    store.predictions.push(prediction);
    savePredictions(store);
    console.log(`[Breakthrough] Prediction stored: "${prediction.claim.slice(0, 80)}" — check by ${new Date(prediction.checkDate).toISOString().slice(0, 10)}`);
  } catch (e: any) {
    console.error("[Breakthrough] Failed to store prediction:", e.message);
  }
}

// -- Check past-due predictions via Perplexity search ----------------------

export async function checkPredictions(): Promise<number> {
  try {
    const store = loadPredictions();
    const now = Date.now();
    const pastDue = store.predictions.filter(p => p.status === "pending" && p.checkDate <= now);
    if (pastDue.length === 0) return 0;

    const pplxKey = process.env.PERPLEXITY_API_KEY ?? "";
    if (!pplxKey || pplxKey.length < 10) {
      console.log("[Breakthrough] No Perplexity key — skipping prediction verification");
      return 0;
    }

    let checked = 0;
    for (const prediction of pastDue.slice(0, 3)) {
      try {
        const res = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${pplxKey}`,
          },
          body: JSON.stringify({
            model: "sonar",
            messages: [{
              role: "system",
              content: "You verify predictions. You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON. Do not wrap in code fences.\n\nRequired JSON schema: {\"status\": \"verified_true\", \"evidence\": \"brief explanation\"}\n\nThe status field must be exactly one of: \"verified_true\", \"verified_false\", or \"inconclusive\"."
            }, {
              role: "user",
              content: `Prediction made on ${new Date(prediction.madeAt).toISOString().slice(0, 10)}: "${prediction.claim}"\n\nHas this prediction come true? Look for recent evidence.`
            }],
            max_tokens: 300,
            temperature: 0.1,
          }),
          signal: AbortSignal.timeout(20000),
        });

        if (!res.ok) continue;
        const data = await res.json() as any;
        const raw = data.choices?.[0]?.message?.content ?? "";
        const parsed = safeParseLLMJson<{ status: string; evidence: string }>(raw, "Breakthrough.prediction");

        if (parsed?.status && ["verified_true", "verified_false", "inconclusive"].includes(parsed.status)) {
          prediction.status = parsed.status as Prediction["status"];
          prediction.verificationEvidence = parsed.evidence ?? "";
          prediction.verifiedAt = now;
          checked++;
          console.log(`[Breakthrough] Prediction ${parsed.status}: "${prediction.claim.slice(0, 60)}"`);

          // If verified true, detect breakthrough!
          if (parsed.status === "verified_true") {
            await detectBreakthroughs(
              `Prediction verified: ${prediction.claim}\nEvidence: ${parsed.evidence}`,
              "prediction_validated",
              prediction.hypothesisId,
            );
          }
        }
      } catch (e: any) {
        console.warn(`[Breakthrough] Prediction check failed for "${prediction.claim.slice(0, 50)}":`, e.message);
      }
    }

    if (checked > 0) savePredictions(store);
    return checked;
  } catch (e: any) {
    console.error("[Breakthrough] Prediction check failed:", e.message);
    return 0;
  }
}

// -- Core detection v2 (multi-signal scoring) ------------------------------

export async function detectBreakthroughs(
  finding: string,
  type: Breakthrough["type"],
  sourceId: string,
): Promise<Breakthrough | null> {
  try {
    console.log(`[Breakthrough] Evaluating finding for breakthrough potential (type: ${type})...`);

    // -- Signal 1: Novelty (LLM) --
    const systemPrompt = `You are evaluating whether an AI research agent has discovered something genuinely novel.

Score NOVELTY only (0-100):
- 100 = no one has published this connection/insight before
- 0 = well-known fact

A finding is novel if it represents a NEW CONNECTION between ideas, not just a restatement, and could not be found by a simple web search.

Be rigorous. Most findings are NOT novel. That's okay.

You MUST respond with ONLY valid JSON. No markdown, no explanations, no text outside the JSON structure. Do not wrap in code fences.

Required JSON schema:
{
  "noveltyScore": 50,
  "suggestedTitle": "concise title for this finding",
  "reasoning": "1-2 sentence explanation of your scoring"
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
      suggestedTitle: string;
      reasoning: string;
    }>(raw, "BreakthroughDetector");

    if (!eval_) {
      console.error("[Breakthrough] Failed to parse LLM evaluation");
      return null;
    }

    const noveltyScore = Math.max(0, Math.min(100, eval_.noveltyScore ?? 0));

    // -- Signal 2: Citation diversity (computed) --
    // Find KB entries linked to this source
    const linkedEntryIds = knowledge.entries
      .filter(e => (e.status ?? "active") === "active" && e.source && e.id)
      .filter(e => {
        const text = `${e.title ?? ""} ${e.summary ?? ""}`.toLowerCase();
        const findingWords = finding.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 10);
        const overlap = findingWords.filter(w => text.includes(w)).length;
        return overlap >= 3;
      })
      .map(e => e.id);

    const citationDiversity = scoreCitationDiversity(linkedEntryIds);

    // -- Signal 3: Graph topology (computed) --
    const graphTopology = scoreGraphTopology(linkedEntryIds);

    // -- Signal 4: Predictive accuracy (tracked) --
    const predictiveAccuracy = scorePredictiveAccuracy(sourceId);

    // -- Composite score --
    const compositeScore = Math.round(
      (noveltyScore * 0.3) +
      (citationDiversity * 0.2) +
      (graphTopology * 0.2) +
      (predictiveAccuracy * 0.3),
    );

    console.log(`[Breakthrough] Scores — novelty: ${noveltyScore}, citation: ${citationDiversity}, graph: ${graphTopology}, prediction: ${predictiveAccuracy}, composite: ${compositeScore} (threshold: 70)`);

    if (compositeScore < 70) {
      console.log(`[Breakthrough] Not a breakthrough (composite ${compositeScore} < 70). Reasoning: ${eval_.reasoning}`);
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
      noveltyScore,
      impactScore:    noveltyScore, // backward compat
      compositeScore,
      scoreBreakdown: {
        noveltyScore,
        citationDiversity,
        graphTopology,
        predictiveAccuracy,
        compositeScore,
      },
      sourceHypothesisId: type === "hypothesis_confirmed" || type === "prediction_validated" ? sourceId : undefined,
      sourceSynthesisId:  type === "synthesis_discovery" ? sourceId : undefined,
      detectedAt:     Date.now(),
      evidence:       [sourceId, ...linkedEntryIds.slice(0, 10)],
      published:      false,
      publishedTo:    [],
    };

    store.breakthroughs.unshift(breakthrough);
    saveBreakthroughs(store);

    console.log(`[Breakthrough] BREAKTHROUGH DETECTED: "${breakthrough.title}" (composite: ${compositeScore})`);
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

export function getPredictions(): PredictionStore {
  return loadPredictions();
}
