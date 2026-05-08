/**
 * Tests for goalDecisionPanel — operator-facing read-only projections for
 * stalled-milestone goals and duplicate goal candidates.
 *
 * Surfaced 2026-05-08 from the AgentHQ status loop: panel kept asking for
 *   - milestone-3 text side-by-side for stalled 2/3 goals
 *   - duplicate-goal detection for "Amplify Distinctive Voice" + sibling
 * No auto-merge, no auto-archive — operator decides via existing controls.
 *
 * Run: npx tsx --test server/__tests__/goalDecisionPanel.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  selectStalledMilestoneDecisions,
  selectDuplicateGoalCandidates,
  normalizeGoalTitle,
} from "../goalDecisionPanel.js";
import type { AgentGoal } from "../researchEngine.js";

const NOW = new Date(Date.UTC(2026, 4, 8));

function mkGoal(overrides: Partial<AgentGoal> = {}): AgentGoal {
  return {
    id:                  overrides.id ?? "goal_1",
    title:               overrides.title ?? "Example Goal",
    description:         overrides.description ?? "desc",
    category:            overrides.category ?? "voice",
    status:              overrides.status ?? "active",
    priority:            overrides.priority ?? "medium",
    setBy:               overrides.setBy ?? "agent",
    createdAt:           overrides.createdAt ?? new Date(Date.UTC(2026, 3, 1)).toISOString(),
    updatedAt:           overrides.updatedAt ?? new Date(Date.UTC(2026, 3, 1)).toISOString(),
    milestones:          overrides.milestones ?? ["m1", "m2", "m3"],
    completedMilestones: overrides.completedMilestones ?? [],
    progressUpdatedAt:   overrides.progressUpdatedAt,
    ...overrides,
  } as AgentGoal;
}

describe("normalizeGoalTitle", () => {
  it("collapses casing, punctuation, and whitespace", () => {
    assert.equal(normalizeGoalTitle("Amplify Distinctive Voice."), "amplify distinctive voice");
    assert.equal(normalizeGoalTitle("amplify  distinctive   voice"), "amplify distinctive voice");
  });
  it("returns empty for empty input", () => {
    assert.equal(normalizeGoalTitle(""), "");
    assert.equal(normalizeGoalTitle("   "), "");
  });
});

describe("selectStalledMilestoneDecisions", () => {
  it("surfaces 2/3 near-completion goals with the milestone-3 deciding text", () => {
    const g = mkGoal({
      id: "near",
      title: "Empathy in Instructional Voice",
      milestones: ["m1", "m2", "m3-deciding"],
      completedMilestones: ["m1", "m2"],
      progressUpdatedAt: new Date(NOW.getTime() - 3 * 86400000).toISOString(),
    });
    const rows = selectStalledMilestoneDecisions([g], { now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decidingMilestoneText, "m3-deciding");
    assert.equal(rows[0].completedMilestones, 2);
    assert.equal(rows[0].totalMilestones, 3);
  });

  it("excludes already-achieved goals", () => {
    const g = mkGoal({
      status: "achieved",
      milestones: ["m1", "m2", "m3"],
      completedMilestones: ["m1", "m2", "m3"],
    });
    assert.equal(selectStalledMilestoneDecisions([g], { now: NOW }).length, 0);
  });

  it("excludes 0/3 fresh goals (active < staleDays, not near completion)", () => {
    const g = mkGoal({
      milestones: ["m1", "m2", "m3"],
      completedMilestones: [],
      progressUpdatedAt: new Date(NOW.getTime() - 1 * 86400000).toISOString(),
    });
    assert.equal(selectStalledMilestoneDecisions([g], { now: NOW, staleDays: 7 }).length, 0);
  });

  it("includes a 1/3 goal once stale past the threshold", () => {
    const g = mkGoal({
      id: "stalled-13",
      milestones: ["m1", "m2", "m3"],
      completedMilestones: ["m1"],
      progressUpdatedAt: new Date(NOW.getTime() - 14 * 86400000).toISOString(),
    });
    const rows = selectStalledMilestoneDecisions([g], { now: NOW, staleDays: 7 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].daysSinceProgress >= 14, true);
    assert.equal(rows[0].decidingMilestoneText, "m2");
  });

  it("sorts longest-stalled first", () => {
    const a = mkGoal({
      id: "old",
      title: "Old",
      milestones: ["m1", "m2", "m3"],
      completedMilestones: ["m1", "m2"],
      progressUpdatedAt: new Date(NOW.getTime() - 30 * 86400000).toISOString(),
    });
    const b = mkGoal({
      id: "newer",
      title: "Newer",
      milestones: ["m1", "m2", "m3"],
      completedMilestones: ["m1", "m2"],
      progressUpdatedAt: new Date(NOW.getTime() - 5 * 86400000).toISOString(),
    });
    const rows = selectStalledMilestoneDecisions([b, a], { now: NOW });
    assert.equal(rows[0].goalId, "old");
    assert.equal(rows[1].goalId, "newer");
  });

  it("returns null decidingMilestoneText only when remaining is zero (handled upstream)", () => {
    // Implementation detail: if remaining is empty we skip, so this can't
    // legitimately occur in output. Guard against accidental inclusion.
    const g = mkGoal({
      milestones: ["m1"],
      completedMilestones: ["m1"],
    });
    const rows = selectStalledMilestoneDecisions([g], { now: NOW });
    assert.equal(rows.length, 0);
  });
});

describe("selectDuplicateGoalCandidates", () => {
  it("surfaces same-name active duplicates as a single cluster", () => {
    const goals = [
      mkGoal({ id: "g1", title: "Amplify Distinctive Voice", completedMilestones: ["m1"], milestones: ["m1", "m2", "m3"] }),
      mkGoal({ id: "g2", title: "amplify distinctive voice.", completedMilestones: ["m1", "m2"], milestones: ["m1", "m2", "m3"] }),
      mkGoal({ id: "g3", title: "Different Goal" }),
    ];
    const dupes = selectDuplicateGoalCandidates(goals);
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].normalizedTitle, "amplify distinctive voice");
    assert.equal(dupes[0].goals.length, 2);
    // g2 has more completed → carry-forward-higher suggestion + sorted first.
    assert.equal(dupes[0].goals[0].id, "g2");
    assert.equal(dupes[0].suggestion, "carry-forward-higher");
  });

  it("flags 'review' when both rows have equal milestone progress", () => {
    const goals = [
      mkGoal({ id: "a", title: "Amplify Voice", completedMilestones: ["m1"], milestones: ["m1", "m2"] }),
      mkGoal({ id: "b", title: "amplify voice", completedMilestones: ["m1"], milestones: ["m1", "m2"] }),
    ];
    const dupes = selectDuplicateGoalCandidates(goals);
    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].suggestion, "review");
  });

  it("ignores non-active goals when clustering", () => {
    const goals = [
      mkGoal({ id: "active", title: "Same Title" }),
      mkGoal({ id: "abandoned", title: "Same Title", status: "abandoned" }),
      mkGoal({ id: "achieved", title: "Same Title", status: "achieved" }),
    ];
    assert.equal(selectDuplicateGoalCandidates(goals).length, 0);
  });

  it("returns no clusters when titles are all distinct", () => {
    const goals = [
      mkGoal({ id: "1", title: "One" }),
      mkGoal({ id: "2", title: "Two" }),
      mkGoal({ id: "3", title: "Three" }),
    ];
    assert.equal(selectDuplicateGoalCandidates(goals).length, 0);
  });

  it("never mutates the input goals (read-only projection)", () => {
    const goals = [
      mkGoal({ id: "g1", title: "Same" }),
      mkGoal({ id: "g2", title: "same" }),
    ];
    // Structured clone preserves undefined-valued keys, unlike JSON round-trip,
    // so we can detect any mutation (reorder, field rewrite) by the selector.
    const before = goals.map(g => ({ ...g }));
    const beforeIds = goals.map(g => g.id);
    selectDuplicateGoalCandidates(goals);
    assert.equal(goals.length, before.length, "selector must not change array length");
    assert.deepEqual(goals.map(g => g.id), beforeIds, "selector must not reorder goals");
    for (let i = 0; i < goals.length; i++) {
      assert.deepEqual(goals[i], before[i], `goal ${i} must not be modified`);
    }
  });
});
