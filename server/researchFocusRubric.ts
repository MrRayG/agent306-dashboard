/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  RESEARCH FOCUS RUBRIC (PR #285)
 *
 *  Agent 306 has been generating unbounded open-ended research hypotheses.
 *  This module forces a strict, deterministic triage *before* deep work
 *  starts. It does NOT mutate the existing hypothesis store and does NOT
 *  auto-publish anything — it is a pure-function scorer + validator that
 *  callers (research analysis / cycle / proposal layer) opt into. Operators
 *  remain the only path that promotes anything to action.
 *
 *  Scoring axes (operator-defined; weights sum to 1.0):
 *    Self-Improvement Leverage     40%  — does this measurably improve A306
 *                                         reasoning, hypothesis quality,
 *                                         completion rate, research process,
 *                                         or codebase?
 *    Self-Experiment Feasibility   30%  — can a clean, low-cost experiment
 *                                         run on A306 herself with a clear
 *                                         metric and rollback?
 *    AI Breakthrough / Novelty     15%  — realistic contribution to AI
 *                                         reasoning / agent architectures /
 *                                         recursive self-improvement.
 *    Efficiency / Low Waste        15%  — low duplication risk + reasonable
 *                                         resource estimate.
 *
 *  Pursue rule: overall score >= 7.5 (out of 10).
 *  Generation cap: max 8 hypotheses per cycle; force-rank, select top 2-3
 *  passing.
 *  Hard filters before pursue:
 *    • selfExperimentProtocol present and complete (metric, design,
 *      successThreshold, rollbackCondition).
 *    • novelty/duplication check against archive — exact dup blocks; near
 *      dup is uncertain and routed to operator review.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Public types ────────────────────────────────────────────────────────────

export interface ResearchFocusScores {
  /** 0-10. Direct uplift to A306 reasoning, hypothesis quality, completion rate, research process, or codebase. */
  selfImprovementLeverage: number;
  /** 0-10. Can run a clean, low-cost self-experiment with a measurable metric. */
  selfExperimentFeasibility: number;
  /** 0-10. Realistic contribution to AI reasoning / agent architectures / recursive improvement. */
  aiBreakthroughNovelty: number;
  /** 0-10. Low duplication risk + reasonable resource estimate. */
  efficiencyLowWaste: number;
}

export interface SelfExperimentProtocol {
  /** What metric the experiment will move (e.g. "hypothesis pursue rate >= 7.5 score"). */
  metric: string;
  /** How the experiment will be set up. One paragraph. */
  design: string;
  /** Concrete numeric / boolean threshold that decides success vs failure. */
  successThreshold: string;
  /** What is reverted, and how, if the experiment fails or causes regression. */
  rollbackCondition: string;
}

export interface ResearchFocusInput {
  /** Plain claim/hypothesis text. */
  claim: string;
  /** Operator-supplied or LLM-supplied scores on each axis (0-10). */
  scores: ResearchFocusScores;
  /** Required for pursue. Caller must provide a complete protocol. */
  selfExperimentProtocol?: SelfExperimentProtocol;
  /** Optional notes that show up in the rubric reason string. */
  notes?: string;
}

export type RubricVerdict =
  | "pursue"        // passes threshold + has complete protocol + not a duplicate
  | "review"        // borderline: passes threshold but uncertain duplicate, or missing protocol — operator must review
  | "reject";       // below threshold OR exact duplicate of archive entry

export interface ResearchFocusResult {
  /** Weighted overall score on the 0-10 scale. */
  overall: number;
  /** Same scores echoed back so consumers can persist alongside the verdict. */
  scores: ResearchFocusScores;
  /** Pass/fail of the threshold rule. Independent of duplication / protocol checks. */
  passesThreshold: boolean;
  /** Final verdict — never auto-pursue without protocol + dup check. */
  verdict: RubricVerdict;
  /** Human-readable reason; safe to render in dashboards / logs. */
  reason: string;
  /** Rank within the candidate set after force-ranking. 1 = top. -1 if not part of a ranked batch. */
  selectionRank: number;
  /** Echoed protocol when present; helps callers store one structured record. */
  selfExperimentProtocol?: SelfExperimentProtocol;
  /** Optional duplication outcome attached by selectTopHypotheses(). */
  duplication?: DuplicationCheckResult;
}

// ── Constants (operator-defined; pinned) ────────────────────────────────────

export const RESEARCH_FOCUS_WEIGHTS: Readonly<{
  selfImprovementLeverage: number;
  selfExperimentFeasibility: number;
  aiBreakthroughNovelty: number;
  efficiencyLowWaste: number;
}> = Object.freeze({
  selfImprovementLeverage:   0.40,
  selfExperimentFeasibility: 0.30,
  aiBreakthroughNovelty:     0.15,
  efficiencyLowWaste:        0.15,
});

/** Pursue threshold (0-10 scale). Hypotheses below this never enter deep work. */
export const PURSUE_THRESHOLD = 7.5;

/** Maximum hypotheses generated/considered per cycle before force-ranking. */
export const MAX_GENERATED_PER_CYCLE = 8;

/** Top-N passing hypotheses selected from the generated pool. */
export const TOP_SELECTION_MIN = 2;
export const TOP_SELECTION_MAX = 3;

// ── Pure helpers ────────────────────────────────────────────────────────────

function clamp10(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 10) return 10;
  return n;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute the weighted overall score (0-10) from the four-axis rubric.
 * Pure: no I/O, no LLM calls, deterministic for a given input.
 */
export function computeOverall(scores: ResearchFocusScores): number {
  const w = RESEARCH_FOCUS_WEIGHTS;
  const total =
    clamp10(scores.selfImprovementLeverage)   * w.selfImprovementLeverage +
    clamp10(scores.selfExperimentFeasibility) * w.selfExperimentFeasibility +
    clamp10(scores.aiBreakthroughNovelty)     * w.aiBreakthroughNovelty +
    clamp10(scores.efficiencyLowWaste)        * w.efficiencyLowWaste;
  return round1(total);
}

/**
 * Validate that a self-experiment protocol is structurally complete. The
 * fields are required *before* a hypothesis transitions from rubric-pursue
 * to actual testing/deep work. Each field must be a non-empty string of at
 * least MIN_FIELD_CHARS characters so callers can't slip empty placeholders
 * through.
 */
const MIN_FIELD_CHARS = 12;
export function validateSelfExperimentProtocol(
  protocol: unknown,
): { ok: true; protocol: SelfExperimentProtocol } | { ok: false; reason: string } {
  if (!protocol || typeof protocol !== "object") {
    return { ok: false, reason: "selfExperimentProtocol missing or not an object" };
  }
  const p = protocol as Record<string, unknown>;
  for (const field of ["metric", "design", "successThreshold", "rollbackCondition"] as const) {
    const v = p[field];
    if (typeof v !== "string" || v.trim().length < MIN_FIELD_CHARS) {
      return {
        ok: false,
        reason: `selfExperimentProtocol.${field} must be a non-empty string (>=${MIN_FIELD_CHARS} chars)`,
      };
    }
  }
  return {
    ok: true,
    protocol: {
      metric:            (p.metric            as string).trim(),
      design:            (p.design            as string).trim(),
      successThreshold:  (p.successThreshold  as string).trim(),
      rollbackCondition: (p.rollbackCondition as string).trim(),
    },
  };
}

/**
 * Score a single hypothesis against the rubric and produce a verdict.
 * Does NOT consult duplication archive — pair with checkDuplication() or
 * selectTopHypotheses() for the full pipeline.
 */
export function scoreResearchFocus(input: ResearchFocusInput): ResearchFocusResult {
  const overall = computeOverall(input.scores);
  const passesThreshold = overall >= PURSUE_THRESHOLD;

  const protocolCheck = validateSelfExperimentProtocol(input.selfExperimentProtocol);
  const protocolOk = protocolCheck.ok;

  let verdict: RubricVerdict;
  let reason: string;

  if (!passesThreshold) {
    verdict = "reject";
    reason = `overall=${overall} < threshold=${PURSUE_THRESHOLD}`;
  } else if (!protocolOk) {
    verdict = "review";
    reason = `passes threshold (overall=${overall}) but ${protocolCheck.reason}`;
  } else {
    verdict = "pursue";
    reason = `overall=${overall} >= ${PURSUE_THRESHOLD} with complete self-experiment protocol`;
  }
  if (input.notes) reason += ` — ${input.notes.trim().slice(0, 200)}`;

  return {
    overall,
    scores: {
      selfImprovementLeverage:   clamp10(input.scores.selfImprovementLeverage),
      selfExperimentFeasibility: clamp10(input.scores.selfExperimentFeasibility),
      aiBreakthroughNovelty:     clamp10(input.scores.aiBreakthroughNovelty),
      efficiencyLowWaste:        clamp10(input.scores.efficiencyLowWaste),
    },
    passesThreshold,
    verdict,
    reason,
    selectionRank: -1,
    selfExperimentProtocol: protocolOk ? protocolCheck.protocol : undefined,
  };
}

// ── Deterministic novelty / duplication check ───────────────────────────────

export interface DuplicationCheckResult {
  /** "exact" → block; "near" → operator review; "none" → pass. */
  kind: "exact" | "near" | "none";
  /** 0..1 Jaccard similarity to closest archive entry. */
  similarity: number;
  /** Identifier of closest matching archive entry, or null if none. */
  matchedId: string | null;
  /** First 80 chars of matched entry's claim, or null. */
  matchedClaimPreview: string | null;
  /** Why this verdict was chosen. */
  reason: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "being", "this", "that",
  "these", "those", "it", "its", "as", "if", "than", "then", "so", "such",
  "will", "would", "could", "should", "may", "might", "can", "do", "does", "did",
  "have", "has", "had", "not", "no", "yes", "any", "all", "more", "less",
]);

/**
 * Canonicalize claim text to a sorted set of meaningful tokens. Used for
 * Jaccard similarity. Deterministic; no LLM call.
 */
export function canonicalizeClaim(claim: string): string[] {
  return Array.from(
    new Set(
      claim
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ).sort();
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export interface ArchiveEntry { id: string; claim: string }

/** Threshold tuning: exact-dup at very high similarity, near-dup zone routes to operator review. */
export const EXACT_DUP_THRESHOLD = 0.85;
export const NEAR_DUP_THRESHOLD = 0.55;

/**
 * Compare a candidate claim against an archive of previously-considered
 * claims. Pure / deterministic — no embeddings, no LLM. Use this as a cheap
 * pre-gate before any expensive semantic check.
 */
export function checkDuplication(claim: string, archive: ArchiveEntry[]): DuplicationCheckResult {
  const candidate = canonicalizeClaim(claim);
  if (candidate.length === 0) {
    return {
      kind: "none",
      similarity: 0,
      matchedId: null,
      matchedClaimPreview: null,
      reason: "candidate has no canonical tokens — duplication check skipped",
    };
  }
  let best: { id: string; claim: string; sim: number } | null = null;
  for (const entry of archive) {
    const sim = jaccard(candidate, canonicalizeClaim(entry.claim));
    if (!best || sim > best.sim) best = { id: entry.id, claim: entry.claim, sim };
  }
  if (!best || best.sim === 0) {
    return {
      kind: "none",
      similarity: 0,
      matchedId: null,
      matchedClaimPreview: null,
      reason: "no overlap with archive",
    };
  }
  const preview = best.claim.length > 80 ? best.claim.slice(0, 77) + "..." : best.claim;
  if (best.sim >= EXACT_DUP_THRESHOLD) {
    return {
      kind: "exact",
      similarity: round1(best.sim * 10) / 10,
      matchedId: best.id,
      matchedClaimPreview: preview,
      reason: `exact-dup of archive entry ${best.id} (sim=${best.sim.toFixed(2)} >= ${EXACT_DUP_THRESHOLD})`,
    };
  }
  if (best.sim >= NEAR_DUP_THRESHOLD) {
    return {
      kind: "near",
      similarity: round1(best.sim * 10) / 10,
      matchedId: best.id,
      matchedClaimPreview: preview,
      reason: `near-dup of archive entry ${best.id} (sim=${best.sim.toFixed(2)} in [${NEAR_DUP_THRESHOLD}, ${EXACT_DUP_THRESHOLD})) — operator review`,
    };
  }
  return {
    kind: "none",
    similarity: round1(best.sim * 10) / 10,
    matchedId: best.id,
    matchedClaimPreview: preview,
    reason: `closest archive entry sim=${best.sim.toFixed(2)} below ${NEAR_DUP_THRESHOLD}`,
  };
}

// ── Generation cap + top-N selection ────────────────────────────────────────

export interface GenerationCapStats {
  /** Number of candidates the caller produced this cycle (pre-cap). */
  generated: number;
  /** Number remaining after enforcing MAX_GENERATED_PER_CYCLE. */
  considered: number;
  /** Number that passed the rubric threshold. */
  passingThreshold: number;
  /** Number selected for pursue (after dup check + protocol gate). */
  selected: number;
  /** Number routed to operator review (near-dup or missing protocol). */
  routedToReview: number;
  /** Number rejected outright (below threshold or exact dup). */
  rejected: number;
}

export interface SelectTopOptions {
  /** Optional archive of prior claims for duplication check. Defaults to []. */
  archive?: ArchiveEntry[];
  /** Override TOP_SELECTION_MAX for tests / specialized callers. */
  topN?: number;
  /** Override MAX_GENERATED_PER_CYCLE — only for tests / one-off cycles. */
  cap?: number;
}

export interface SelectTopResult {
  selected: ResearchFocusResult[];
  review:   ResearchFocusResult[];
  rejected: ResearchFocusResult[];
  stats:    GenerationCapStats;
}

/**
 * Apply the full triage to a batch of candidates from one generation cycle.
 *
 *   1. Cap the input at MAX_GENERATED_PER_CYCLE (deterministic — keeps the
 *      first N as supplied; callers that want a different ordering should
 *      pre-sort by their own priority signal).
 *   2. Score each candidate via scoreResearchFocus.
 *   3. Run the dup check against `options.archive`.
 *      • exact → reject + reason logged on result.
 *      • near  → review.
 *      • none  → keep.
 *   4. Force-rank by overall score and pick top 2-3 verdict='pursue'
 *      candidates as `selected`. The remainder above-threshold but missing
 *      protocol or near-dup go into `review`.
 *
 * Pure; only side effect is what the caller does with the returned buckets.
 */
export function selectTopHypotheses(
  candidates: ResearchFocusInput[],
  options: SelectTopOptions = {},
): SelectTopResult {
  const cap = options.cap ?? MAX_GENERATED_PER_CYCLE;
  const archive = options.archive ?? [];
  const rawTopN = options.topN ?? TOP_SELECTION_MAX;
  const topN = Math.max(TOP_SELECTION_MIN, Math.min(TOP_SELECTION_MAX, rawTopN));

  const considered = candidates.slice(0, cap);
  const generated = candidates.length;

  const scored = considered.map(c => {
    const r = scoreResearchFocus(c);
    const dup = checkDuplication(c.claim, archive);
    r.duplication = dup;

    if (dup.kind === "exact") {
      r.verdict = "reject";
      r.reason = `${r.reason} | ${dup.reason}`;
    } else if (dup.kind === "near" && r.verdict === "pursue") {
      r.verdict = "review";
      r.reason = `${r.reason} | ${dup.reason}`;
    } else if (dup.kind === "near" && r.verdict === "review") {
      r.reason = `${r.reason} | ${dup.reason}`;
    }
    return r;
  });

  const passingThreshold = scored.filter(r => r.passesThreshold).length;

  // Rank pursue candidates by overall (desc), break ties by selfImprovementLeverage.
  const pursueable = scored
    .filter(r => r.verdict === "pursue")
    .sort((a, b) => {
      if (b.overall !== a.overall) return b.overall - a.overall;
      return b.scores.selfImprovementLeverage - a.scores.selfImprovementLeverage;
    });

  const selected = pursueable.slice(0, topN).map((r, i) => ({ ...r, selectionRank: i + 1 }));
  const selectedIds = new Set(selected.map(r => r.reason)); // sentinel — we mutate copies, not originals

  const review = scored.filter(r => r.verdict === "review");
  const rejected = scored.filter(r => r.verdict === "reject");
  // Pursue-but-overflow (didn't make top N) get demoted to review so the
  // operator can decide whether to bump cap or pick differently.
  const overflow = pursueable.slice(topN).map(r => ({
    ...r,
    verdict: "review" as RubricVerdict,
    reason: `${r.reason} | dropped from top ${topN} pursue selection`,
  }));

  return {
    selected,
    review: [...review, ...overflow],
    rejected,
    stats: {
      generated,
      considered: considered.length,
      passingThreshold,
      selected: selected.length,
      routedToReview: review.length + overflow.length,
      rejected: rejected.length,
    },
  };
  void selectedIds; // keep for future debugging; not used downstream
}
