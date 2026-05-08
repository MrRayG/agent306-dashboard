/**
 * ─────────────────────────────────────────────────────────────
 *  GOAL DECISION PANEL — operator-facing projections for stalled and
 *  potentially-duplicate goals.
 *
 *  Pure functions, no I/O, no LLM. The AgentHQ Goals tab calls these
 *  to surface read-only decision aids that the existing status panel
 *  has been asking for since 2026-05-08:
 *
 *    1. `selectStalledMilestoneDecisions` — for active goals with
 *       2 of 3 milestones completed and no recent progress, projects
 *       the third milestone text so the operator can see the deciding
 *       step side-by-side without expanding each goal card.
 *
 *    2. `selectDuplicateGoalCandidates` — for active goals that share
 *       a normalized title (or normalized title prefix) with another
 *       active goal, surfaces the pair so the operator can decide
 *       whether to merge / carry-forward. Read-only — this module
 *       does NOT merge or modify anything.
 *
 *  Both are deliberately conservative: false positives are visible to
 *  the operator (a no-op), false negatives mean the decision aid
 *  doesn't surface, which is the safe failure mode.
 * ─────────────────────────────────────────────────────────────
 */

import type { AgentGoal } from "./researchEngine.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Active goals with 2 of 3 milestones completed and no recent activity.
 * Surfaces the third (deciding) milestone text so the operator can see
 * what's blocking each goal at a glance.
 */
export interface StalledMilestoneDecision {
  goalId:                string;
  title:                 string;
  category:              string;
  totalMilestones:       number;
  completedMilestones:   number;
  /** The text of the still-incomplete milestone (typically milestone 3 of 3). */
  decidingMilestoneText: string | null;
  daysSinceProgress:     number;
}

/**
 * Pair of active goals that share a normalized title — strong duplicate signal.
 * The operator decides whether to merge; this module never mutates state.
 */
export interface DuplicateGoalCandidate {
  /** The shared normalized title both goals reduce to. */
  normalizedTitle:  string;
  /** Two or more goals collapsing to that key, sorted by milestone-progress descending. */
  goals: Array<{
    id:                  string;
    title:               string;
    status:              string;
    category:            string;
    completedMilestones: number;
    totalMilestones:     number;
    createdAt:           string;
    updatedAt:           string;
  }>;
  /**
   * Suggested action — non-binding. "carry-forward-higher" when one row
   * has strictly more completed milestones; "review" otherwise.
   */
  suggestion: "carry-forward-higher" | "review";
}

/**
 * Normalize a goal title for duplicate detection. Lowercases, strips
 * punctuation, collapses whitespace. Keeps semantic words intact so
 * "Amplify Distinctive Voice." and "amplify distinctive voice" collapse
 * to the same key but "Amplify Voice" and "Distinctive Voice" do not.
 */
export function normalizeGoalTitle(title: string): string {
  return (title || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the stalled-milestone decision rows. A goal qualifies when:
 *   - status === "active"
 *   - has at least 3 milestones (typical generated shape) AND
 *     exactly one milestone left incomplete, OR has any incomplete
 *     milestones AND it's been >= staleDays since the last progress
 *     update — whichever surfaces the deciding step.
 *
 * Sorted by daysSinceProgress descending so the longest-stalled goals
 * surface first.
 */
export function selectStalledMilestoneDecisions(
  goals: AgentGoal[],
  opts: { now?: Date; staleDays?: number; limit?: number } = {},
): StalledMilestoneDecision[] {
  const now = opts.now ?? new Date();
  const staleDays = Math.max(1, opts.staleDays ?? 7);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  const out: StalledMilestoneDecision[] = [];
  for (const g of goals) {
    if (g.status !== "active") continue;
    const milestones = g.milestones ?? [];
    const completed = g.completedMilestones ?? [];
    if (milestones.length === 0) continue;
    const remaining = milestones.filter(m => !completed.includes(m));
    if (remaining.length === 0) continue;

    // Days since last visible progress.
    const lastActivityIso = g.progressUpdatedAt ?? g.updatedAt ?? g.createdAt;
    const lastT = new Date(lastActivityIso).getTime();
    const daysSinceProgress = Number.isFinite(lastT)
      ? Math.max(0, Math.floor((now.getTime() - lastT) / MS_PER_DAY))
      : 0;

    // The decision panel is for goals near completion (e.g. 2/3 done) OR
    // simply stalled. Prefer the "near-completion + stalled" intersection
    // so the operator sees the most decision-ready rows; fall back to
    // any active goal stalled past the threshold.
    const isNearComplete = milestones.length >= 2 && remaining.length === 1;
    const isStale = daysSinceProgress >= staleDays;
    if (!isNearComplete && !isStale) continue;

    out.push({
      goalId:                g.id,
      title:                 g.title,
      category:              g.category,
      totalMilestones:       milestones.length,
      completedMilestones:   completed.length,
      decidingMilestoneText: remaining[0] ?? null,
      daysSinceProgress,
    });
  }

  out.sort((a, b) => b.daysSinceProgress - a.daysSinceProgress);
  return out.slice(0, limit);
}

/**
 * Cluster active goals by normalized title and surface clusters of 2+.
 * Sorted by cluster size descending, then by total milestone progress
 * descending so the operator sees the most-load-bearing clusters first.
 *
 * Read-only — no merge happens here. The "carry-forward-higher"
 * suggestion is a hint based purely on `completedMilestones.length`;
 * the operator decides whether it's actually right.
 */
export function selectDuplicateGoalCandidates(
  goals: AgentGoal[],
  opts: { limit?: number } = {},
): DuplicateGoalCandidate[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  const buckets = new Map<string, AgentGoal[]>();
  for (const g of goals) {
    if (g.status !== "active") continue;
    const key = normalizeGoalTitle(g.title);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(g);
  }

  const out: DuplicateGoalCandidate[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue;

    const rows = bucket
      .map(g => ({
        id:                  g.id,
        title:                g.title,
        status:               g.status,
        category:             g.category,
        completedMilestones: (g.completedMilestones ?? []).length,
        totalMilestones:     (g.milestones ?? []).length,
        createdAt:           g.createdAt,
        updatedAt:           g.updatedAt,
      }))
      .sort((a, b) => b.completedMilestones - a.completedMilestones);

    const top = rows[0]?.completedMilestones ?? 0;
    const second = rows[1]?.completedMilestones ?? 0;
    const suggestion: DuplicateGoalCandidate["suggestion"] =
      top > second ? "carry-forward-higher" : "review";

    out.push({ normalizedTitle: key, goals: rows, suggestion });
  }

  out.sort((a, b) => {
    if (b.goals.length !== a.goals.length) return b.goals.length - a.goals.length;
    const aProg = a.goals.reduce((s, g) => s + g.completedMilestones, 0);
    const bProg = b.goals.reduce((s, g) => s + g.completedMilestones, 0);
    return bProg - aProg;
  });

  return out.slice(0, limit);
}
