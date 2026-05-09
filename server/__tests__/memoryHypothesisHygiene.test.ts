/**
 * Tests for Phase 1.5b memory-origin hypothesis hygiene — detection, classification,
 * and the hard-no Phase-2 readiness gate.
 *
 * Run: npx tsx --test server/__tests__/memoryHypothesisHygiene.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HYPOTHESIS_TITLE_PREFIX,
  isMemoryHypothesisEntry,
  findMemoryHypothesisEntries,
  classifyMemoryHypothesisEntry,
  canMemoryEntryFeedExperiment,
  auditMemoryHypotheses,
  type MemoryKnowledgeEntry,
  type MemoryKnowledgeFile,
} from "../memoryHypothesisHygiene.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function memEntry(overrides: Partial<MemoryKnowledgeEntry> = {}): MemoryKnowledgeEntry {
  return {
    id: "k_test_1",
    title: "Hypothesis: AI agents will outpace web search for niche queries by 2027",
    summary: "medium confidence. Drawing on usage data from late 2025.",
    category: "research",
    tier: "operational",
    weight: 7,
    learnedAt: "2026-03-29T13:03:21.701Z",
    ...overrides,
  };
}

function memoryKnowledgeFixture(): MemoryKnowledgeFile {
  // Mirrors live `data/memory_knowledge.json` shape.
  return {
    lastIngested: "2026-03-31T13:18:32.048Z",
    totalEntries: 6,
    researchFiles: ["research_lab.json"],
    entries: [
      // Non-hypothesis: podcast template entry (weight=10, category=research)
      {
        id: "k_pod_1",
        title: "Podcast: Two Episode Types",
        summary: "THE SIGNAL ... THE CONVERSATION ...",
        category: "research",
        tier: "active",
        weight: 10,
        learnedAt: "2026-03-28T12:48:09.553Z",
      },
      // Non-hypothesis: research observation (no Hypothesis: prefix)
      {
        id: "k_obs_1",
        title: "Q&A: What does on-chain provenance signal in NFT communities",
        summary: "Walter Benjamin's aura concept extended to digital art.",
        category: "research",
        tier: "active",
        weight: 8,
      },
      // Hypothesis-shaped, operational tier — primary case to flag
      memEntry({
        id: "k_hyp_1",
        title: "Hypothesis: Curiosity-driven headlines will increase CTR by 20%",
        learnedAt: "2026-03-29T13:03:53.922Z",
      }),
      memEntry({
        id: "k_hyp_2",
        title: "Hypothesis: Senior users of AI companions show distinct engagement curves",
        learnedAt: "2026-03-29T13:04:06.398Z",
      }),
      // Already-promoted hypothesis: should still be canFeedExperiment=false here
      // (Phase-2 path goes through the formal hypothesis record, not this one).
      memEntry({
        id: "k_hyp_3",
        title: "Hypothesis: Long-form podcasts retain >70% completion rate",
        promotedToHypothesisId: "hyp_lab_001",
      }),
      // Edge: archived memory-origin entry (operator-set status)
      memEntry({
        id: "k_hyp_4",
        title: "Hypothesis: Anomalous dispute resolution times signal a backlog",
        status: "archived",
      }),
    ],
  };
}

// ── Detection ────────────────────────────────────────────────────────────────

describe("isMemoryHypothesisEntry", () => {
  it("matches titles starting with 'Hypothesis:'", () => {
    assert.equal(isMemoryHypothesisEntry(memEntry()), true);
  });

  it("is case-insensitive on the prefix", () => {
    assert.equal(isMemoryHypothesisEntry(memEntry({ title: "hypothesis: lowercase variant" })), true);
    assert.equal(isMemoryHypothesisEntry(memEntry({ title: "HYPOTHESIS: shouting variant" })), true);
  });

  it("rejects unrelated titles", () => {
    assert.equal(isMemoryHypothesisEntry(memEntry({ title: "Podcast: episode types" })), false);
    assert.equal(isMemoryHypothesisEntry(memEntry({ title: "Q&A: What was the result" })), false);
    assert.equal(isMemoryHypothesisEntry(memEntry({ title: "Data: 42% retention" })), false);
  });

  it("rejects entries with missing or non-string titles", () => {
    assert.equal(isMemoryHypothesisEntry({ id: "x" } as any), false);
    assert.equal(isMemoryHypothesisEntry({ id: "x", title: 42 as any }), false);
  });

  it("ignores prefix appearances mid-string", () => {
    assert.equal(isMemoryHypothesisEntry(memEntry({ title: "On the Hypothesis: a meta-essay" })), false);
  });

  it("HYPOTHESIS_TITLE_PREFIX is the documented sentinel", () => {
    assert.equal(HYPOTHESIS_TITLE_PREFIX, "Hypothesis:");
  });
});

describe("findMemoryHypothesisEntries", () => {
  it("returns only hypothesis-titled entries from the fixture", () => {
    const found = findMemoryHypothesisEntries(memoryKnowledgeFixture());
    assert.equal(found.length, 4);
    assert.deepEqual(found.map(e => e.id).sort(), ["k_hyp_1", "k_hyp_2", "k_hyp_3", "k_hyp_4"]);
  });

  it("returns [] for files without an entries array (memory_soul shape)", () => {
    const soulShape: MemoryKnowledgeFile = {
      // mirrors memory_soul.json — no entries[]
      // @ts-expect-error — additional fields exist on the live file
      version: "1.0",
      // @ts-expect-error
      identity: "agent306",
    };
    assert.deepEqual(findMemoryHypothesisEntries(soulShape), []);
  });

  it("tolerates missing/empty input", () => {
    assert.deepEqual(findMemoryHypothesisEntries({}), []);
    assert.deepEqual(findMemoryHypothesisEntries({ entries: [] }), []);
  });
});

// ── Classification ───────────────────────────────────────────────────────────

describe("classifyMemoryHypothesisEntry", () => {
  it("defaults to needs_review for an unpromoted hypothesis-titled entry", () => {
    const v = classifyMemoryHypothesisEntry(memEntry(), 0);
    assert.equal(v.tag, "needs_review");
    assert.equal(v.canFeedExperiment, false);
    assert.ok(v.reasons.some(r => /memory-origin/.test(r)));
    assert.ok(v.reasons.some(r => /promotedToHypothesisId/.test(r)));
  });

  it("notes promotion in reasons when the entry has been promoted", () => {
    const v = classifyMemoryHypothesisEntry(memEntry({ promotedToHypothesisId: "hyp_42" }), 0);
    // Even when promoted, the raw memory entry is still not a Phase-2 input —
    // the formal hypothesis record is.
    assert.equal(v.canFeedExperiment, false);
    assert.equal(v.promotedToHypothesisId, "hyp_42");
    assert.ok(v.reasons.some(r => /already promoted/.test(r)));
  });

  it("classifies status=archived as archived_irrelevant", () => {
    const v = classifyMemoryHypothesisEntry(memEntry({ status: "archived" }), 0);
    assert.equal(v.tag, "archived_irrelevant");
    assert.equal(v.canFeedExperiment, false);
  });

  it("never returns a ready or candidate tag for raw memory entries", () => {
    for (const overrides of [
      {},
      { weight: 10 },
      { tier: "core" },
      { summary: "a long summary that almost looks like a basis statement here" },
    ]) {
      const v = classifyMemoryHypothesisEntry(memEntry(overrides), 0);
      assert.notEqual(v.tag, "ready_for_experiment");
      assert.notEqual(v.tag, "candidate");
      assert.equal(v.canFeedExperiment, false);
    }
  });

  it("preserves index and key reporting fields on the verdict", () => {
    const v = classifyMemoryHypothesisEntry(memEntry({ id: "k_x", tier: "operational", weight: 7 }), 17);
    assert.equal(v.index, 17);
    assert.equal(v.id, "k_x");
    assert.equal(v.tier, "operational");
    assert.equal(v.weight, 7);
  });
});

// ── Phase-2 gate ─────────────────────────────────────────────────────────────

describe("canMemoryEntryFeedExperiment", () => {
  it("always returns ok=false — no bypass branch", () => {
    const v = canMemoryEntryFeedExperiment(memEntry());
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some(r => /cannot feed Phase 2/.test(r)));
    // synthesized hypothesis is missing measurementPath/metric/prediction
    assert.ok(v.blockers.length > 0);
  });

  it("returns ok=false even when the memory entry is already promoted", () => {
    const v = canMemoryEntryFeedExperiment(memEntry({ promotedToHypothesisId: "hyp_lab_001" }));
    assert.equal(v.ok, false);
    assert.ok(v.reasons.some(r => /promoted to hyp_lab_001/.test(r)));
    assert.ok(v.reasons.some(r => /canFeedExperiment\(\)/.test(r)));
  });

  it("returns ok=false even when the entry has unusually long summary content", () => {
    const longSummary = "x".repeat(2000);
    const v = canMemoryEntryFeedExperiment(memEntry({ summary: longSummary }));
    assert.equal(v.ok, false);
  });
});

// ── Audit ────────────────────────────────────────────────────────────────────

describe("auditMemoryHypotheses", () => {
  it("counts hypothesis entries and skips non-hypothesis entries", () => {
    const r = auditMemoryHypotheses(memoryKnowledgeFixture(), { source: "fixture://memory_knowledge.json" });
    assert.equal(r.totalEntries, 6);
    assert.equal(r.hypothesisCount, 4);
    assert.equal(r.source, "fixture://memory_knowledge.json");
  });

  it("groups by tier/category/weight", () => {
    const r = auditMemoryHypotheses(memoryKnowledgeFixture());
    assert.equal(r.byTier.operational, 4);
    assert.equal(r.byCategory.research, 4);
    assert.equal(r.byWeight["7"], 4);
  });

  it("counts promoted vs unpromoted entries", () => {
    const r = auditMemoryHypotheses(memoryKnowledgeFixture());
    assert.equal(r.promotedCount, 1);
    assert.equal(r.unpromotedCount, 3);
  });

  it("groups by hygiene tag (no ready/candidate tags ever appear)", () => {
    const r = auditMemoryHypotheses(memoryKnowledgeFixture());
    assert.equal(r.byTag["ready_for_experiment"] ?? 0, 0);
    assert.equal(r.byTag["candidate"] ?? 0, 0);
    assert.ok((r.byTag["needs_review"] ?? 0) >= 1);
    assert.ok((r.byTag["archived_irrelevant"] ?? 0) >= 1);
  });

  it("includes per-entry verdicts with original index preserved", () => {
    const r = auditMemoryHypotheses(memoryKnowledgeFixture());
    assert.equal(r.verdicts.length, 4);
    // The first hypothesis entry in the fixture is at index 2 (after 2 non-hyps).
    assert.equal(r.verdicts[0].index, 2);
    assert.equal(r.verdicts[0].id, "k_hyp_1");
    // None of the verdicts may be feedable.
    for (const v of r.verdicts) assert.equal(v.canFeedExperiment, false);
  });

  it("readiness summary makes the not-feedable verdict explicit", () => {
    const r = auditMemoryHypotheses(memoryKnowledgeFixture());
    assert.match(r.readinessSummary, /memory-origin/);
    assert.match(r.readinessSummary, /(cannot feed Phase 2|None of these can feed Phase 2)/i);
    assert.match(r.readinessSummary, /research_lab\.hypotheses/);
  });

  it("handles memory_soul-shaped files (no entries) cleanly", () => {
    const soul: MemoryKnowledgeFile = {
      // mirrors `data/memory_soul.json` top-level keys per the live audit
      // @ts-expect-error
      version: "1.0",
      // @ts-expect-error
      identity: "agent306",
    };
    const r = auditMemoryHypotheses(soul, { source: "fixture://memory_soul.json" });
    assert.equal(r.totalEntries, 0);
    assert.equal(r.hypothesisCount, 0);
    assert.equal(r.promotedCount, 0);
    assert.equal(r.unpromotedCount, 0);
    assert.deepEqual(r.verdicts, []);
    assert.match(r.readinessSummary, /No memory-origin/);
  });

  it("handles an empty entries array", () => {
    const r = auditMemoryHypotheses({ entries: [] });
    assert.equal(r.totalEntries, 0);
    assert.equal(r.hypothesisCount, 0);
    assert.match(r.readinessSummary, /No memory-origin/);
  });

  it("handles a file with only non-hypothesis entries", () => {
    const file: MemoryKnowledgeFile = {
      entries: [
        { id: "k1", title: "Podcast: episode 1" },
        { id: "k2", title: "Q&A: did it work" },
      ],
    };
    const r = auditMemoryHypotheses(file);
    assert.equal(r.totalEntries, 2);
    assert.equal(r.hypothesisCount, 0);
    assert.match(r.readinessSummary, /No memory-origin/);
  });
});
