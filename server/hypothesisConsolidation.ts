/**
 * ─────────────────────────────────────────────────────────────
 *  AGENT #306 — HYPOTHESIS PRE-INSERTION CONSOLIDATION
 *
 *  Problem (per Agent 306's "Hypothesis Debt Crisis" blog):
 *    "Is GPT-5 coming?" and "When will OpenAI ship GPT-5?" are
 *    the same question but currently tracked as two separate
 *    hypotheses. ~80% of 'distinct' threads are restatements.
 *
 *  This module adds a pre-insertion dedup pass: before a new
 *  hypothesis enters the active queue, we embed its claim text
 *  and compare against embeddings of existing active hypotheses.
 *  If cosine similarity exceeds CONSOLIDATION_THRESHOLD, the new
 *  claim is attached as an alias rather than becoming a new row.
 *
 *  Distinct from hypothesisConsolidator.ts, which runs periodic
 *  POST-hoc cluster merges. That path still operates on duplicates
 *  that slipped through this gate.
 * ─────────────────────────────────────────────────────────────
 */

import { getEmbedding } from "./embeddingEngine.js";
import {
  addHypothesis,
  getResearchLab,
  saveResearchLab,
  type Hypothesis,
} from "./researchEngine.js";

/**
 * Cosine similarity threshold above which a new hypothesis is merged
 * into the existing canonical as an alias rather than inserted.
 *
 * 0.82 chosen empirically: text-embedding-3-small scores paraphrases
 * of the same question in the 0.85-0.95 range, while semantically
 * adjacent but distinct questions (e.g. "GPT-5 release" vs "GPT-5
 * capabilities") score in the 0.70-0.80 range. 0.82 sits in the
 * quiet band between those two clusters.
 */
export const CONSOLIDATION_THRESHOLD = 0.82;

/** Cosine similarity between two embedding vectors. */
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

/**
 * Best-match search among active (forming|testing) hypotheses.
 * Hypotheses missing a cached embedding are skipped — they will
 * be back-filled on their next consolidation attempt.
 */
function findBestMatch(
  candidateEmbedding: number[],
  active: Hypothesis[],
): { hyp: Hypothesis; similarity: number } | null {
  let best: { hyp: Hypothesis; similarity: number } | null = null;
  for (const h of active) {
    const emb = h.embedding;
    if (!emb || emb.length === 0) continue;
    const sim = cosineSimilarity(candidateEmbedding, emb);
    if (!best || sim > best.similarity) best = { hyp: h, similarity: sim };
  }
  return best;
}

export interface ConsolidationOutcome {
  hypothesis: Hypothesis;           // canonical (existing on merge, new on insert)
  merged: boolean;                   // true if alias'd into an existing canonical
  similarity?: number;               // best similarity found (present on merge path)
  canonicalClaim?: string;           // canonical's claim text (present on merge path)
}

/**
 * Pre-insertion consolidation gate.
 *
 * Workflow:
 *   1. Embed the candidate claim.
 *   2. Compare against each active hypothesis' cached embedding.
 *   3. If best similarity >= CONSOLIDATION_THRESHOLD, append the raw
 *      candidate claim to the canonical's `aliases[]` and return the
 *      canonical (no new row).
 *   4. Otherwise insert via the existing addHypothesis() and cache the
 *      embedding on the new row.
 *
 * Failure modes are non-fatal: if embedding generation fails, we fall
 * back to the legacy keyword/entity dedup already in addHypothesis().
 * This keeps the research pipeline moving even when the embedding
 * provider is degraded.
 */
export async function consolidateOrInsertHypothesis(
  input: Omit<Hypothesis, "id" | "formedAt" | "status">,
): Promise<ConsolidationOutcome | null> {
  let candidateEmbedding: number[] | null = null;
  try {
    candidateEmbedding = await getEmbedding(input.claim);
  } catch (e: any) {
    console.warn(
      `[Hypothesis] Embedding failed for consolidation check: ${e.message ?? e} — falling back to legacy dedup`,
    );
  }

  if (!candidateEmbedding || candidateEmbedding.length === 0) {
    const inserted = addHypothesis(input);
    if (!inserted) return null;
    return { hypothesis: inserted, merged: false };
  }

  const lab = getResearchLab();
  const active = lab.hypotheses.filter(
    h => h.status === "forming" || h.status === "testing",
  );

  const match = findBestMatch(candidateEmbedding, active);
  if (match && match.similarity >= CONSOLIDATION_THRESHOLD) {
    const canonicalIdx = lab.hypotheses.findIndex(h => h.id === match.hyp.id);
    if (canonicalIdx !== -1) {
      const canonical = lab.hypotheses[canonicalIdx];
      if (!canonical.aliases) canonical.aliases = [];
      if (canonical.claim !== input.claim && !canonical.aliases.includes(input.claim)) {
        canonical.aliases.push(input.claim);
      }
      saveResearchLab(lab);
      console.log(
        `[Hypothesis] consolidated "${input.claim.slice(0, 80)}" into "${canonical.claim.slice(0, 80)}" (similarity=${match.similarity.toFixed(2)})`,
      );
      return {
        hypothesis: canonical,
        merged: true,
        similarity: match.similarity,
        canonicalClaim: canonical.claim,
      };
    }
  }

  const inserted = addHypothesis(input);
  if (!inserted) return null;

  // Cache the embedding on the newly inserted canonical so the next
  // consolidation pass can match against it without a round-trip.
  const freshLab = getResearchLab();
  const idx = freshLab.hypotheses.findIndex(h => h.id === inserted.id);
  if (idx !== -1) {
    freshLab.hypotheses[idx].embedding = candidateEmbedding;
    freshLab.hypotheses[idx].aliasOf = null;
    if (!freshLab.hypotheses[idx].aliases) freshLab.hypotheses[idx].aliases = [];
    saveResearchLab(freshLab);
    return { hypothesis: freshLab.hypotheses[idx], merged: false };
  }

  return { hypothesis: inserted, merged: false };
}

// ── Test-only helpers (not used by production code) ─────────────────────────
export const _internals = {
  cosineSimilarity,
  findBestMatch,
};
