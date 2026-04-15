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

import { getResearchLab, saveResearchLab, extractKeyTokens, jaccardSimilarity } from "./researchEngine.js";
import { LLM_BASE_URL, getLLMHeaders } from "./llmConfig.js";
import { getModel } from "./modelRouter.js";
import { safeParseLLMJson } from "./safeParseLLMJson.js";
import type { Hypothesis } from "./researchEngine.js";

export interface HypothesisCluster {
  representative: Hypothesis;
  members: Hypothesis[];
  similarity: number;
}

/**
 * Find clusters of similar hypotheses using keyword overlap.
 * Returns clusters with minClusterSize+ members (worth merging).
 */
export function findHypothesisClusters(minClusterSize = 3, similarityThreshold = 0.45): HypothesisCluster[] {
  const lab = getResearchLab();
  const active = lab.hypotheses.filter(h => h.status === 'forming' || h.status === 'testing');

  const clusters: HypothesisCluster[] = [];
  const assigned = new Set<string>();

  for (const h of active) {
    if (assigned.has(h.id)) continue;

    const hTokens = extractKeyTokens(h.claim);
    const members: Hypothesis[] = [h];

    for (const candidate of active) {
      if (candidate.id === h.id || assigned.has(candidate.id)) continue;
      const cTokens = extractKeyTokens(candidate.claim);
      const sim = jaccardSimilarity(hTokens, cTokens);
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
    const res = await fetch(LLM_BASE_URL, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify({
        model: getModel("hypothesis-consolidation"),
        messages: [
          { role: "system", content: "You merge redundant research hypotheses into canonical versions. Be precise and testable." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30000),
    });

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
 * Run full hypothesis consolidation: find clusters, merge each, update research lab.
 */
export async function consolidateHypotheses(options?: {
  minClusterSize?: number;
  maxClusters?: number;
  similarityThreshold?: number;
  weakestDimension?: string;
  dryRun?: boolean;
}): Promise<{ clustersFound: number; merged: number; removed: number }> {
  const minSize = options?.minClusterSize ?? 3;
  const maxClusters = options?.maxClusters ?? 5;
  const simThreshold = options?.similarityThreshold ?? 0.45;
  const dryRun = options?.dryRun ?? false;

  console.log(`[HypothesisConsolidator] Starting consolidation (minClusterSize=${minSize}, dryRun=${dryRun})...`);

  let clusters = findHypothesisClusters(minSize, simThreshold);
  console.log(`[HypothesisConsolidator] Found ${clusters.length} clusters with ${clusters.reduce((s, c) => s + c.members.length, 0)} total hypotheses`);

  if (clusters.length === 0) {
    return { clustersFound: 0, merged: 0, removed: 0 };
  }

  // Prioritize clusters based on eval weakness
  if (options?.weakestDimension) {
    clusters = prioritizeClusters(clusters, options.weakestDimension);
  }

  let merged = 0;
  let removed = 0;

  const clustersToProcess = clusters.slice(0, maxClusters);

  for (const cluster of clustersToProcess) {
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

    // Reload lab fresh for each cluster mutation
    const lab = getResearchLab();
    const canonicalId = cluster.representative.id;
    const canonicalIdx = lab.hypotheses.findIndex(h => h.id === canonicalId);
    if (canonicalIdx === -1) continue;

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
    merged++;
    removed += cluster.members.length - 1;
    console.log(`[HypothesisConsolidator] Merged ${cluster.members.length} → 1: "${result.canonical.slice(0, 80)}..."`);

    // Small delay between clusters for API rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`[HypothesisConsolidator] Complete: ${merged} clusters merged, ${removed} redundant hypotheses removed`);
  return { clustersFound: clusters.length, merged, removed };
}
