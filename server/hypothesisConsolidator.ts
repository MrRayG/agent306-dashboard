/**
 * ─────────────────────────────────────────────────────────────
 *  Hypothesis Consolidation Engine
 *
 *  Finds clusters of similar hypotheses using keyword overlap,
 *  merges each cluster into a single canonical hypothesis via LLM,
 *  and marks old members as expired with a mergedInto reference.
 *
 *  Modeled on knowledgeConsolidator.ts.
 * ─────────────────────────────────────────────────────────────
 */

import { getResearchLab, saveResearchLab } from "./researchEngine.js";
import { LLM_BASE_URL, getLLMHeaders, LLM_TIMEOUTS } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import { getEmbedding } from "./embeddingEngine.js";
import type { Hypothesis } from "./researchEngine.js";
import { waitForBatchComplete } from "./xaiBatchEngine.js";
import {
  shouldUseHypothesisBatch,
  submitConsolidationBatch,
  collectConsolidationResults,
  type MergeResult,
} from "./hypothesisConsolidationBatch.js";

import { postChatCompletions } from "./llmCall.js";
// ── Cosine similarity (inline to avoid circular dependency) ──────────────────
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface HypothesisCluster {
  representative: Hypothesis;
  members: Hypothesis[];
  similarity: number;
}

/**
 * Find clusters of similar hypotheses using cosine similarity on embeddings.
 * Falls back to sync (non-embedding) mode if embedding API fails.
 * Returns clusters with minClusterSize+ members (worth merging).
 */
export async function findHypothesisClusters(minClusterSize = 3, similarityThreshold = 0.75): Promise<HypothesisCluster[]> {
  const lab = getResearchLab();
  const active = lab.hypotheses.filter(h => h.status === 'forming' || h.status === 'testing');

  if (active.length < minClusterSize) return [];

  // Compute embeddings for all active hypotheses
  const embeddingMap = new Map<string, number[]>();
  for (const h of active) {
    try {
      const embedding = await getEmbedding(h.claim);
      if (embedding.length > 0) {
        embeddingMap.set(h.id, embedding);
      }
    } catch (e: any) {
      console.warn(`[HypothesisConsolidator] Embedding failed for "${h.claim.slice(0, 40)}": ${e.message}`);
    }
  }

  if (embeddingMap.size < minClusterSize) {
    console.warn(`[HypothesisConsolidator] Only ${embeddingMap.size} embeddings computed — not enough for clustering`);
    return [];
  }

  const clusters: HypothesisCluster[] = [];
  const assigned = new Set<string>();

  for (const h of active) {
    if (assigned.has(h.id)) continue;
    const hEmb = embeddingMap.get(h.id);
    if (!hEmb) continue;

    const members: Hypothesis[] = [h];

    for (const candidate of active) {
      if (candidate.id === h.id || assigned.has(candidate.id)) continue;
      const cEmb = embeddingMap.get(candidate.id);
      if (!cEmb) continue;

      const sim = cosineSimilarity(hEmb, cEmb);
      if (sim >= similarityThreshold) {
        members.push(candidate);
      }
    }

    if (members.length >= minClusterSize) {
      members.forEach(m => assigned.add(m.id));

      // Pick highest-trust representative as the canonical base
      const representative = members.reduce((best, m) =>
        (m.trustScore ?? 0) > (best.trustScore ?? 0) ? m : best
      );

      clusters.push({ representative, members, similarity: similarityThreshold });
    }
  }

  return clusters;
}

// Confidence ranking for comparison
const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function bestConfidence(members: Hypothesis[]): "high" | "medium" | "low" {
  let best = 0;
  let bestVal: "high" | "medium" | "low" = "low";
  for (const m of members) {
    const rank = CONFIDENCE_RANK[m.confidence] ?? 0;
    if (rank > best) { best = rank; bestVal = m.confidence; }
  }
  return bestVal;
}

/**
 * Merge a cluster of similar hypotheses into one canonical hypothesis using LLM.
 */
async function mergeCluster(cluster: HypothesisCluster): Promise<{ canonical: string; reasoning: string } | null> {
  const claimList = cluster.members
    .map((m, i) => `[${i}] "${m.claim}" (confidence: ${m.confidence}, status: ${m.status})`)
    .join('\n');

  const prompt = `You are Agent 306's research consolidation system. These ${cluster.members.length} hypotheses are variants of the same core idea. Merge them into ONE canonical hypothesis that:

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

  try {
    const res = await postChatCompletions({
        model: getModel("hypothesis-consolidation"),
        messages: [
          { role: "system", content: "You merge redundant research hypotheses into canonical versions. Be precise and testable." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }, AbortSignal.timeout(LLM_TIMEOUTS.consolidation));

    if (!res.ok) {
      console.warn(`[HypothesisConsolidator] LLM error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content ?? "";
    return safeParseLLMJson(content, "HypothesisConsolidator.merge");
  } catch (e: any) {
    console.warn(`[HypothesisConsolidator] Merge failed:`, e.message);
    return null;
  }
}

// ── Eval-aware cluster prioritization ────────────────────────────────────────

const DIMENSION_KEYWORDS: Record<string, string[]> = {
  signalAcquisition:   ["research", "data", "source", "scan", "feed", "signal", "detect", "monitor"],
  sourceIntegrity:     ["source", "verify", "trust", "citation", "evidence", "integrity", "accuracy"],
  reasoningRigor:      ["logic", "reason", "argument", "analysis", "debate", "contradiction", "hypothesis"],
  intellectualHonesty: ["bias", "correct", "wrong", "honest", "revise", "update", "prune"],
  voiceEvolution:      ["voice", "style", "tone", "writing", "rhetoric", "narrative", "storytelling"],
  audienceImpact:      ["audience", "engagement", "community", "reach", "impact", "distribution", "follower"],
};

function scoreClusterRelevance(cluster: HypothesisCluster, keywords: string[]): number {
  const claimText = cluster.members.map(m => m.claim.toLowerCase()).join(" ");
  let score = 0;
  for (const kw of keywords) {
    if (claimText.includes(kw)) score++;
  }
  score += Math.min(3, Math.floor(cluster.members.length / 3));
  return score;
}

/**
 * Prioritize hypothesis clusters based on 306Eval weak dimension.
 * Clusters whose topics relate to the weak dimension get sorted first.
 */
export function prioritizeClusters(
  clusters: HypothesisCluster[],
  weakestDimension?: string,
): HypothesisCluster[] {
  if (!weakestDimension || clusters.length <= 1) return clusters;

  const keywords = DIMENSION_KEYWORDS[weakestDimension] ?? [];
  if (keywords.length === 0) return clusters;

  return [...clusters].sort((a, b) => {
    const aRelevance = scoreClusterRelevance(a, keywords);
    const bRelevance = scoreClusterRelevance(b, keywords);
    if (bRelevance !== aRelevance) return bRelevance - aRelevance;
    return b.members.length - a.members.length;
  });
}

// ── Consolidation ────────────────────────────────────────────────────────────

/**
 * Apply a single cluster merge result to the research lab.
 * Pure-ish: reads + writes the lab once, returns counts. Shared by
 * both the sync (mergeCluster) and batch (submitConsolidationBatch)
 * code paths so they produce byte-identical lab state.
 *
 * Returns { applied, removed } — applied=1 if the lab was mutated,
 * 0 if the canonical no longer exists (stale between merge + apply).
 */
function applyMergeToLab(
  cluster: HypothesisCluster,
  result: MergeResult,
): { applied: number; removed: number } {
  const lab = getResearchLab();
  const canonicalId = cluster.representative.id;
  const canonicalIdx = lab.hypotheses.findIndex(h => h.id === canonicalId);
  if (canonicalIdx === -1) return { applied: 0, removed: 0 };

  // Merge metadata from all cluster members
  const allTopicIds = new Set<string>();
  let bestTrust = 0;
  let earliestFormed = lab.hypotheses[canonicalIdx].formedAt;
  let bestRubric: Hypothesis["rubricScores"] | undefined;

  for (const member of cluster.members) {
    if (member.relatedTopicId) allTopicIds.add(member.relatedTopicId);
    if ((member.trustScore ?? 0) > bestTrust) bestTrust = member.trustScore ?? 0;
    if (member.formedAt < earliestFormed) earliestFormed = member.formedAt;

    // Keep best rubric scores (max of each dimension)
    if (member.rubricScores) {
      if (!bestRubric) {
        bestRubric = { ...member.rubricScores };
      } else {
        bestRubric.evidenceStrength = Math.max(bestRubric.evidenceStrength, member.rubricScores.evidenceStrength);
        bestRubric.logicalCoherence = Math.max(bestRubric.logicalCoherence, member.rubricScores.logicalCoherence);
        bestRubric.falsifiability = Math.max(bestRubric.falsifiability, member.rubricScores.falsifiability);
        bestRubric.noveltyInsight = Math.max(bestRubric.noveltyInsight, member.rubricScores.noveltyInsight);
        bestRubric.actionability = Math.max(bestRubric.actionability, member.rubricScores.actionability);
      }
    }
  }

  // Update canonical hypothesis
  lab.hypotheses[canonicalIdx].claim = result.canonical;
  lab.hypotheses[canonicalIdx].confidence = bestConfidence(cluster.members);
  lab.hypotheses[canonicalIdx].formedAt = earliestFormed;
  if (bestTrust > 0) lab.hypotheses[canonicalIdx].trustScore = bestTrust;
  if (bestRubric) lab.hypotheses[canonicalIdx].rubricScores = bestRubric;
  // Keep first relatedTopicId if canonical doesn't have one
  if (!lab.hypotheses[canonicalIdx].relatedTopicId && allTopicIds.size > 0) {
    lab.hypotheses[canonicalIdx].relatedTopicId = Array.from(allTopicIds)[0];
  }

  // Mark other members as expired with mergedInto reference
  for (const member of cluster.members) {
    if (member.id === canonicalId) continue;
    const idx = lab.hypotheses.findIndex(h => h.id === member.id);
    if (idx !== -1) {
      lab.hypotheses[idx].status = "expired";
      lab.hypotheses[idx].resolution = `Merged into ${canonicalId}: ${result.reasoning}`;
      (lab.hypotheses[idx] as any).mergedInto = canonicalId;
    }
  }

  saveResearchLab(lab);
  return { applied: 1, removed: cluster.members.length - 1 };
}

/**
 * Run full hypothesis consolidation: find clusters, merge each, update research lab.
 *
 * Routing:
 * - When HYPOTHESIS_CONSOLIDATION_BATCH=true AND BATCH_API_ENABLED=true,
 *   submits every cluster as a single xAI Batches job (50% cheaper async tier).
 * - Otherwise, falls back to the sequential sync path (one merge per cluster
 *   with a 1-second delay between calls).
 *
 * Lab mutations are identical between the two paths — both call applyMergeToLab.
 */
export async function consolidateHypotheses(options?: {
  minClusterSize?: number;
  maxClusters?: number;
  similarityThreshold?: number;
  weakestDimension?: string;
  dryRun?: boolean;
}): Promise<{ clustersFound: number; merged: number; removed: number; batchId?: string }> {
  const minSize = options?.minClusterSize ?? 3;
  const maxClusters = options?.maxClusters ?? 5;
  const simThreshold = options?.similarityThreshold ?? 0.45;
  const dryRun = options?.dryRun ?? false;

  console.log(`[HypothesisConsolidator] Starting consolidation (minClusterSize=${minSize}, maxClusters=${maxClusters}, similarityThreshold=${simThreshold}, dryRun=${dryRun})...`);

  let clusters = await findHypothesisClusters(minSize, simThreshold);
  console.log(`[HypothesisConsolidator] Found ${clusters.length} clusters with ${clusters.reduce((s, c) => s + c.members.length, 0)} total hypotheses`);

  if (clusters.length === 0) {
    return { clustersFound: 0, merged: 0, removed: 0 };
  }

  // Prioritize clusters based on eval weakness
  if (options?.weakestDimension) {
    clusters = prioritizeClusters(clusters, options.weakestDimension);
  }

  // ── Batch path (async 50%-off tier) ──────────────────────────────────────
  if (shouldUseHypothesisBatch() && !dryRun) {
    return await consolidateViaBatch(clusters);
  }

  // ── Sync path (unchanged; preserves dryRun semantics) ────────────────────
  return await consolidateViaSync(clusters, dryRun);
}

/**
 * Sync consolidation path — sequential merges with 1s inter-call delay.
 * This is the original code path, preserved verbatim so no behavior
 * changes until an operator flips the batch flag.
 */
async function consolidateViaSync(
  clusters: HypothesisCluster[],
  dryRun: boolean,
): Promise<{ clustersFound: number; merged: number; removed: number }> {
  let merged = 0;
  let removed = 0;

  for (const cluster of clusters) {
    console.log(`[HypothesisConsolidator] Merging cluster: "${cluster.representative.claim.slice(0, 60)}..." (${cluster.members.length} variants)`);

    const result = await mergeCluster(cluster);
    if (!result) {
      console.warn(`[HypothesisConsolidator] Skipping cluster — LLM merge failed`);
      continue;
    }

    if (dryRun) {
      console.log(`[HypothesisConsolidator] [DRY RUN] Would merge ${cluster.members.length} → 1: "${result.canonical}"`);
      merged++;
      removed += cluster.members.length - 1;
      continue;
    }

    const { applied, removed: r } = applyMergeToLab(cluster, result);
    if (!applied) continue;
    merged++;
    removed += r;
    console.log(`[HypothesisConsolidator] Merged ${cluster.members.length} → 1: "${result.canonical.slice(0, 80)}..."`);

    // Small delay between clusters for API rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`[HypothesisConsolidator] Complete: ${merged} clusters merged, ${removed} redundant hypotheses removed`);
  return { clustersFound: clusters.length, merged, removed };
}

/**
 * Batch consolidation path — submits all cluster merges as one xAI
 * Batches job (50% cheaper), waits for completion, applies merges.
 *
 * Timeout / poll cadence inherit the same env knobs as the KG batch cron:
 *   HYPOTHESIS_BATCH_POLL_MS    (default 60_000 ms)
 *   HYPOTHESIS_BATCH_TIMEOUT_MS (default 6 h)
 */
async function consolidateViaBatch(
  clusters: HypothesisCluster[],
): Promise<{ clustersFound: number; merged: number; removed: number; batchId?: string }> {
  const pollMs = Number(process.env.HYPOTHESIS_BATCH_POLL_MS ?? 60_000);
  const timeoutMs = Number(process.env.HYPOTHESIS_BATCH_TIMEOUT_MS ?? 6 * 60 * 60 * 1000);

  console.log(`[HypothesisConsolidator] BATCH path: submitting ${clusters.length} clusters to xAI Batches`);

  let batchId: string;
  try {
    const submit = await submitConsolidationBatch(clusters);
    batchId = submit.batch_id;
    console.log(`[HypothesisConsolidator] Batch ${batchId} submitted with ${submit.added} requests`);
  } catch (e: any) {
    console.warn(`[HypothesisConsolidator] Batch submit failed — falling back to sync: ${e.message ?? e}`);
    return await consolidateViaSync(clusters, false);
  }

  try {
    await waitForBatchComplete(batchId, { pollIntervalMs: pollMs, timeoutMs });
  } catch (e: any) {
    console.warn(`[HypothesisConsolidator] Batch ${batchId} wait failed: ${e.message ?? e}`);
    return { clustersFound: clusters.length, merged: 0, removed: 0, batchId };
  }

  // Collect results. Validate against current lab state so a canonical that
  // was archived between submit and collect doesn't get resurrected.
  const validIds = new Set(getResearchLab().hypotheses.map(h => h.id));
  const { merges, failures } = await collectConsolidationResults(batchId, validIds);

  console.log(`[HypothesisConsolidator] Batch ${batchId} returned ${merges.size} merges, ${failures.length} failures`);

  // Apply each result. Iterating over clusters (not the map) keeps apply order
  // deterministic and gives us access to the full cluster object.
  let merged = 0;
  let removed = 0;
  for (const cluster of clusters) {
    const result = merges.get(cluster.representative.id);
    if (!result) continue;
    const { applied, removed: r } = applyMergeToLab(cluster, result);
    if (!applied) continue;
    merged++;
    removed += r;
    console.log(`[HypothesisConsolidator] Merged ${cluster.members.length} → 1: "${result.canonical.slice(0, 80)}..."`);
  }

  console.log(`[HypothesisConsolidator] BATCH complete: ${merged} clusters merged, ${removed} redundant hypotheses removed`);
  return { clustersFound: clusters.length, merged, removed, batchId };
}
