/**
 * Second-pass dedupe regression tests for selfRecommendation buildup
 * (post PR #274 / issue: rows still piled up after one cycle).
 *
 * Covers four emit paths whose previous content fingerprints were too
 * narrow to collapse semantically-equivalent proposals:
 *
 *   1. Weekly improvement plan (dreamEngine) — `weekOf` shifted daily, and
 *      LLM-generated `proposedChange` shifted every run, so the default
 *      fingerprint always differed. Fix: lock the dedupe axis to ISO week.
 *   2. Style-rule from improvement_plan (reflectionEngine) — multi-paragraph
 *      blobs and per-call rec emission flooded the queue. Fix: per-day
 *      batch key + length cap.
 *   3. Missing-primitive (goalEngine) — hashed verbatim insight text, but
 *      LLM rephrasing across cycles diverged the hash. Fix: classify into
 *      a coarse primitive family and key on family.
 *   4. Governance-debt (selfEvolutionEngine) — same drift problem with
 *      verbatim insight text. Fix: classify into a coarse cluster topic
 *      and key on cluster.
 *
 * Run: npx tsx --test server/__tests__/selfRecBuildupSecondPass.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.js";
import { selfRecommendations } from "@shared/schema";
import {
  proposeRecommendation,
  listRecommendations,
  computeDedupeKey,
} from "../selfRecommendationEngine.js";
import {
  classifyMissingPrimitiveFamily,
  describeMissingPrimitiveFamily,
} from "../actionTranslator.js";
import { classifyGovernanceCluster } from "../selfEvolutionEngine.js";
import { isoWeekKey } from "../dreamEngine.js";

function wipe() {
  try {
    db.delete(selfRecommendations).run();
  } catch {}
}

// ── Improvement plan: ISO-week canonical dedupe ──────────────────────────────

describe("improvement-plan rec — weekly canonical dedupe", () => {
  before(wipe);
  beforeEach(wipe);
  after(wipe);

  it("isoWeekKey returns YYYY-Www and is stable across days within the same ISO week", () => {
    // Mon 2026-04-27 and Sun 2026-05-03 both fall in ISO week 2026-W18.
    const monday = new Date(Date.UTC(2026, 3, 27)); // April 27 2026 (Mon)
    const sunday = new Date(Date.UTC(2026, 4, 3)); // May 3 2026 (Sun)
    const k1 = isoWeekKey(monday);
    const k2 = isoWeekKey(sunday);
    assert.match(k1, /^\d{4}-W\d{2}$/);
    assert.equal(k1, k2, "all days in the same ISO week must share a key");
  });

  it("rolls over to the next week-key on the next Monday", () => {
    const sunW18 = new Date(Date.UTC(2026, 4, 3)); // 2026-05-03 Sun
    const monW19 = new Date(Date.UTC(2026, 4, 4)); // 2026-05-04 Mon
    assert.notEqual(isoWeekKey(sunW18), isoWeekKey(monW19));
  });

  it("two daily plan emissions in the same week collapse to one row when keyed by ISO week", () => {
    // Simulate the two consecutive daily plan generations the user observed.
    const weekKey = "2026-W18";
    const dedupeKey = computeDedupeKey("engine", "improvement-plan-weekly", weekKey);

    const day1 = proposeRecommendation({
      category: "engine",
      title: `Improvement plan for week of ${weekKey}`,
      rationale: "Patterns: A; B; C",
      proposedChange: "1. [content] Action A\n2. [reasoning] Action B",
      evidence: ["plan:plan_aaa", `week:${weekKey}`],
      dedupeKey,
    });
    const day2 = proposeRecommendation({
      category: "engine",
      title: `Improvement plan for week of ${weekKey}`,
      // Different proposedChange (LLM rephrased) — should still collapse.
      rationale: "Patterns: A; D; E",
      proposedChange: "1. [content] Different action A'\n2. [research] Different action D",
      evidence: ["plan:plan_bbb", `week:${weekKey}`],
      dedupeKey,
    });

    assert.equal(day1.id, day2.id, "second plan in same ISO week must collapse into the first row");
    assert.equal(listRecommendations({}).length, 1);
  });

  it("a fresh proposal is allowed once the ISO week rolls over", () => {
    const w18 = computeDedupeKey("engine", "improvement-plan-weekly", "2026-W18");
    const w19 = computeDedupeKey("engine", "improvement-plan-weekly", "2026-W19");
    assert.notEqual(w18, w19);

    const a = proposeRecommendation({
      category: "engine",
      title: "Improvement plan for week of 2026-W18",
      rationale: "x",
      proposedChange: "x",
      dedupeKey: w18,
    });
    const b = proposeRecommendation({
      category: "engine",
      title: "Improvement plan for week of 2026-W19",
      rationale: "x",
      proposedChange: "x",
      dedupeKey: w19,
    });
    assert.notEqual(a.id, b.id, "different ISO weeks must produce separate rows");
  });
});

// ── Missing-primitive: family classifier ─────────────────────────────────────

describe("classifyMissingPrimitiveFamily", () => {
  it("classifies artifact-style 'produce one X' actions as artifact", () => {
    assert.equal(
      classifyMissingPrimitiveFamily(
        "produce one concrete output artifact this cycle that synthesizes confirmed hypotheses",
      ),
      "artifact",
    );
    assert.equal(
      classifyMissingPrimitiveFamily(
        "ship one synthesized briefing next cycle to exercise Storytelling",
      ),
      "artifact",
    );
  });

  it("classifies 'for every N input, generate output' as ratio", () => {
    assert.equal(
      classifyMissingPrimitiveFamily(
        "for every 10 new knowledge entries, force-generate one synthesis post",
      ),
      "ratio",
    );
  });

  it("classifies pre-X gates as gate", () => {
    assert.equal(
      classifyMissingPrimitiveFamily("pre-formation data-source gate before any hypothesis"),
      "gate",
    );
    assert.equal(
      classifyMissingPrimitiveFamily("require data availability before testing a hypothesis"),
      "gate",
    );
  });

  it("classifies framing/spectrum actions as spectrum", () => {
    assert.equal(
      classifyMissingPrimitiveFamily(
        "rewrite hypothesis template to require spectrum framing instead of binary",
      ),
      "spectrum",
    );
  });

  it("returns 'other' for unrecognized actions (so they collapse to one catch-all rec)", () => {
    assert.equal(classifyMissingPrimitiveFamily("nonsense"), "other");
    assert.equal(classifyMissingPrimitiveFamily(""), "other");
  });

  it("describeMissingPrimitiveFamily returns short, family-focused text (no embedded insight)", () => {
    const txt = describeMissingPrimitiveFamily("artifact");
    assert.match(txt, /artifact/i);
    assert.ok(txt.length < 200, "description should be short — not a verbatim insight dump");
  });
});

describe("missing-primitive recs — collapse by family across rephrasings", () => {
  before(wipe);
  beforeEach(wipe);
  after(wipe);

  it("two cycles failing on different rephrasings of the same family emit ONE rec", () => {
    // These two unparseable actions are both 'artifact' family but differ
    // verbatim — under the previous (action+insight) hash they produced
    // separate rows. Under the family classifier they must collapse.
    const familyA = classifyMissingPrimitiveFamily(
      "produce one concrete output artifact this cycle to exercise Storytelling",
    );
    const familyB = classifyMissingPrimitiveFamily(
      "ship one synthesized narrative next cycle that closes a confirmed hypothesis",
    );
    assert.equal(familyA, "artifact");
    assert.equal(familyB, "artifact");

    const dedupeKey = computeDedupeKey(
      "engine",
      `missing-primitive: ${familyA}`,
      `family:${familyA}`,
    );

    const first = proposeRecommendation({
      category: "engine",
      title: `missing-primitive: ${familyA} family — action translator could not parse insight`,
      rationale: "GoalEngine could not translate insight il_111",
      proposedChange: describeMissingPrimitiveFamily(familyA),
      sourceInsightId: "il_111_aaa",
      dedupeKey,
    });
    const second = proposeRecommendation({
      category: "engine",
      title: `missing-primitive: ${familyB} family — action translator could not parse insight`,
      rationale: "GoalEngine could not translate insight il_222",
      proposedChange: describeMissingPrimitiveFamily(familyB),
      sourceInsightId: "il_222_bbb",
      dedupeKey: computeDedupeKey(
        "engine",
        `missing-primitive: ${familyB}`,
        `family:${familyB}`,
      ),
    });

    assert.equal(first.id, second.id, "same family → one rec");
    assert.equal(listRecommendations({}).length, 1);
  });

  it("different families do NOT collapse", () => {
    const fam1 = classifyMissingPrimitiveFamily(
      "produce one concrete output artifact this cycle",
    );
    const fam2 = classifyMissingPrimitiveFamily(
      "pre-formation data-source gate before any hypothesis",
    );
    assert.notEqual(fam1, fam2);

    const a = proposeRecommendation({
      category: "engine",
      title: `missing-primitive: ${fam1} family`,
      rationale: "x",
      proposedChange: describeMissingPrimitiveFamily(fam1),
      dedupeKey: computeDedupeKey("engine", `missing-primitive: ${fam1}`, `family:${fam1}`),
    });
    const b = proposeRecommendation({
      category: "engine",
      title: `missing-primitive: ${fam2} family`,
      rationale: "x",
      proposedChange: describeMissingPrimitiveFamily(fam2),
      dedupeKey: computeDedupeKey("engine", `missing-primitive: ${fam2}`, `family:${fam2}`),
    });
    assert.notEqual(a.id, b.id);
  });

  it("proposedChange is short and family-focused — no embedded long insight text", () => {
    const fam = classifyMissingPrimitiveFamily(
      "produce one concrete output artifact this cycle that synthesizes the recently confirmed hypotheses about X with Y context Z",
    );
    const change = describeMissingPrimitiveFamily(fam);
    assert.ok(change.length < 200, "change must not embed long insight content");
    assert.doesNotMatch(change, /confirmed hypotheses/i, "must not echo the insight verbatim");
  });
});

// ── Governance-debt clustering ───────────────────────────────────────────────

describe("classifyGovernanceCluster", () => {
  it("classifies hypothesis-cap variants together", () => {
    assert.equal(
      classifyGovernanceCluster("hard cap active hypotheses at 12"),
      "hypothesis-cap",
    );
    assert.equal(
      classifyGovernanceCluster("limit active hypotheses to 12; archive the rest"),
      "hypothesis-cap",
    );
    assert.equal(
      classifyGovernanceCluster("1-in-1-out for hypotheses: archive one stale per new"),
      "hypothesis-cap",
    );
  });

  it("classifies data-source-gate concerns together", () => {
    assert.equal(
      classifyGovernanceCluster("pre-formation data-source gate before any hypothesis"),
      "data-source-gate",
    );
    assert.equal(
      classifyGovernanceCluster("introduce a pre-testing data-access gate"),
      "data-source-gate",
    );
  });

  it("classifies KB accumulation cap concerns", () => {
    assert.equal(
      classifyGovernanceCluster("cap kb accumulation at 200 entries"),
      "kb-accumulation",
    );
    assert.equal(
      classifyGovernanceCluster("limit knowledge growth — kb size keeps drifting up"),
      "kb-accumulation",
    );
  });

  it("classifies behavioral-rule promotions", () => {
    assert.equal(
      classifyGovernanceCluster("promote additional behavioral rule from observed patterns"),
      "behavioral-rule",
    );
    assert.equal(
      classifyGovernanceCluster("codify a behavioral rule that survived 3 cycles"),
      "behavioral-rule",
    );
  });

  it("classifies output-conversion concerns", () => {
    assert.equal(
      classifyGovernanceCluster("convert validated hypotheses into a synthesis post"),
      "output-conversion",
    );
  });

  it("returns 'other' for unrecognized text", () => {
    assert.equal(classifyGovernanceCluster("totally unrelated muttering"), "other");
    assert.equal(classifyGovernanceCluster(""), "other");
  });
});

describe("governance-debt recs — collapse by cluster across rephrasings", () => {
  before(wipe);
  beforeEach(wipe);
  after(wipe);

  it("two LLM rephrasings of the same cluster collapse to ONE rec", () => {
    const cluster = classifyGovernanceCluster("hard cap active hypotheses at 12");
    assert.equal(cluster, "hypothesis-cap");

    const dedupeKey = computeDedupeKey(
      "engine",
      `governance-cluster:${cluster}`,
      cluster,
    );

    const first = proposeRecommendation({
      category: "engine",
      title: `Self-evolution: ${cluster} concern`,
      rationale: "Active hypothesis count drifting; introduce a cap.",
      proposedChange: "Implement a hard cap of 12 active hypotheses; archive the rest.",
      sourceInsightId: "evo_1700000000000_aaaaaa",
      dedupeKey,
    });
    const second = proposeRecommendation({
      category: "engine",
      title: `Self-evolution: ${cluster} concern`,
      // Different surface, same cluster.
      rationale: "Hypothesis backlog growing — limit to a fixed budget.",
      proposedChange: "Limit active hypotheses to 12 and 1-in-1-out the rest.",
      sourceInsightId: "evo_1700000086400_bbbbbb",
      dedupeKey,
    });

    assert.equal(first.id, second.id, "same cluster → one rec");
    assert.equal(listRecommendations({}).length, 1);
  });

  it("different clusters produce separate rows (no over-collapse)", () => {
    const c1 = classifyGovernanceCluster("hard cap active hypotheses");
    const c2 = classifyGovernanceCluster("pre-formation data-source gate before any hypothesis");
    const c3 = classifyGovernanceCluster("cap kb accumulation at 200 entries");
    const c4 = classifyGovernanceCluster("promote additional behavioral rule from patterns");
    assert.notEqual(c1, c2);
    assert.notEqual(c2, c3);
    assert.notEqual(c3, c4);

    const recs = [c1, c2, c3, c4].map((cluster, i) =>
      proposeRecommendation({
        category: "engine",
        title: `Self-evolution: ${cluster} concern`,
        rationale: `r${i}`,
        proposedChange: `c${i}`,
        dedupeKey: computeDedupeKey("engine", `governance-cluster:${cluster}`, cluster),
      }),
    );
    const ids = new Set(recs.map(r => r.id));
    assert.equal(ids.size, 4, "four distinct clusters → four distinct rows");
  });

  it("'other' cluster collapses unrelated unrecognized insights to ONE catch-all row", () => {
    const cluster = classifyGovernanceCluster("totally unrelated muttering");
    assert.equal(cluster, "other");
    const key = computeDedupeKey("engine", `governance-cluster:${cluster}`, cluster);

    const a = proposeRecommendation({
      category: "engine",
      title: `Self-evolution: ${cluster} concern`,
      rationale: "muttering A",
      proposedChange: "vague action A",
      dedupeKey: key,
    });
    const b = proposeRecommendation({
      category: "engine",
      title: `Self-evolution: ${cluster} concern`,
      rationale: "muttering B",
      proposedChange: "vague action B",
      dedupeKey: key,
    });
    assert.equal(a.id, b.id, "the catch-all cluster prevents unbounded queue growth");
  });
});
