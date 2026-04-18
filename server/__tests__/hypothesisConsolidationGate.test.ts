/**
 * Tests for the pre-insertion hypothesis consolidation gate.
 *
 * Gate logic:
 *   - Embed the candidate claim.
 *   - If best cosine similarity vs existing active hypotheses >= 0.82,
 *     append the raw claim to the canonical's aliases[] and return it.
 *   - Otherwise insert a new row with the embedding cached.
 *
 * Run: npx tsx --test server/__tests__/hypothesisConsolidationGate.test.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// Isolate state before any imports that read DATA_DIR at module-eval time.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent306-hyp-consol-"));
process.env.DATA_DIR = TMP_DIR;
// Ensure embeddingEngine's LLM_API_KEY gate is satisfied so getEmbedding()
// attempts a fetch (which we stub below).
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "test-key";

describe("hypothesisConsolidation — pre-insertion gate", () => {
  let consolidateOrInsertHypothesis: typeof import("../hypothesisConsolidation.js").consolidateOrInsertHypothesis;
  let CONSOLIDATION_THRESHOLD: number;
  let getResearchLab: typeof import("../researchEngine.js").getResearchLab;
  let saveResearchLab: typeof import("../researchEngine.js").saveResearchLab;

  const originalFetch = globalThis.fetch;

  /** Canonical-input factory for addHypothesis shape. */
  function hypInput(claim: string) {
    return {
      claim,
      basis: "unit-test",
      metric: "count",
      prediction: "something observable",
      timeframe: "30 days",
      confidence: "medium" as const,
    };
  }

  /**
   * Vector factory — returns a 4-dim unit vector at a given angle (radians)
   * in the (x, y) plane. Lets each test pin cosine similarity to a precise
   * target: sim(angle_a, angle_b) = cos(angle_a - angle_b).
   */
  function unitVec(angle: number): number[] {
    return [Math.cos(angle), Math.sin(angle), 0, 0];
  }

  /**
   * Mock fetch that returns a pre-registered embedding per input text.
   * Falls back to a zero-vector response for unknown inputs so the test
   * fails loudly instead of making a real network call.
   */
  function installEmbeddingMock(map: Map<string, number[]>) {
    globalThis.fetch = (async (url: any, init?: any) => {
      const body = JSON.parse(init?.body ?? "{}");
      const input = body.input;
      const toEmbedding = (s: string) => map.get(s) ?? [0, 0, 0, 0];
      if (Array.isArray(input)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: input.map((s, i) => ({ index: i, embedding: toEmbedding(s) })),
          }),
          text: async () => "",
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 0, embedding: toEmbedding(String(input)) }],
        }),
        text: async () => "",
      } as any;
    }) as any;
  }

  before(async () => {
    const mod = await import("../hypothesisConsolidation.js");
    consolidateOrInsertHypothesis = mod.consolidateOrInsertHypothesis;
    CONSOLIDATION_THRESHOLD = mod.CONSOLIDATION_THRESHOLD;
    const re = await import("../researchEngine.js");
    getResearchLab = re.getResearchLab;
    saveResearchLab = re.saveResearchLab;
  });

  beforeEach(() => {
    // Reset the lab between tests.
    const lab = getResearchLab();
    lab.hypotheses = [];
    saveResearchLab(lab);
  });

  after(() => {
    globalThis.fetch = originalFetch;
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  });

  it("threshold constant is 0.82", () => {
    assert.equal(CONSOLIDATION_THRESHOLD, 0.82);
  });

  it("5 paraphrases of 'Is GPT-5 coming soon?' → 1 canonical + 4 aliases", async () => {
    const paraphrases = [
      "Is GPT-5 coming soon?",
      "When will OpenAI ship GPT-5?",
      "Will GPT-5 be released this year?",
      "GPT-5 launch timeline from OpenAI?",
      "When does OpenAI plan to release GPT-5?",
    ];
    // Cluster them tightly around angle 0 — every pairwise sim >= 0.99.
    const map = new Map<string, number[]>();
    for (let i = 0; i < paraphrases.length; i++) {
      map.set(paraphrases[i], unitVec(i * 0.05));
    }
    installEmbeddingMock(map);

    for (const claim of paraphrases) {
      const outcome = await consolidateOrInsertHypothesis(hypInput(claim));
      assert.ok(outcome, "consolidation should return an outcome");
    }

    const active = getResearchLab().hypotheses.filter(
      h => h.status === "forming" || h.status === "testing",
    );
    assert.equal(active.length, 1, `expected 1 canonical, got ${active.length}`);
    const canonical = active[0];
    assert.equal(
      canonical.aliases?.length,
      4,
      `expected 4 aliases, got ${canonical.aliases?.length ?? 0}`,
    );
    // Every non-canonical paraphrase should be an alias; canonical's own claim should NOT be duplicated in aliases.
    for (const p of paraphrases) {
      if (p === canonical.claim) continue;
      assert.ok(
        canonical.aliases!.includes(p),
        `paraphrase "${p}" missing from aliases`,
      );
    }
    assert.ok(
      !canonical.aliases!.includes(canonical.claim),
      "canonical's own claim should not appear in aliases[]",
    );
  });

  it("2 unrelated questions → 2 canonicals, 0 aliases", async () => {
    const claimA = "Will GPT-5 ship in 2026?";
    const claimB = "Is on-chain revenue the right metric for L2 health?";
    // Orthogonal angles → cosine similarity = 0.
    installEmbeddingMock(new Map([
      [claimA, unitVec(0)],
      [claimB, unitVec(Math.PI / 2)],
    ]));

    const a = await consolidateOrInsertHypothesis(hypInput(claimA));
    const b = await consolidateOrInsertHypothesis(hypInput(claimB));

    assert.equal(a?.merged, false, "claim A should insert as new canonical");
    assert.equal(b?.merged, false, "claim B should insert as new canonical (unrelated)");

    const active = getResearchLab().hypotheses.filter(
      h => h.status === "forming" || h.status === "testing",
    );
    assert.equal(active.length, 2, `expected 2 canonicals, got ${active.length}`);
    for (const h of active) {
      assert.equal((h.aliases ?? []).length, 0, `hypothesis "${h.claim}" should have 0 aliases`);
    }
  });

  it("threshold boundary: similarity 0.81 → separate rows", async () => {
    const existing = "Is GPT-5 coming?";
    const candidate = "Some unrelated claim at 0.81 similarity";
    // cos(Δ) = 0.81 → Δ = acos(0.81) ≈ 0.6289 rad
    installEmbeddingMock(new Map([
      [existing, unitVec(0)],
      [candidate, unitVec(Math.acos(0.81))],
    ]));

    const first = await consolidateOrInsertHypothesis(hypInput(existing));
    assert.ok(first);
    const second = await consolidateOrInsertHypothesis(hypInput(candidate));
    assert.ok(second);

    assert.equal(
      second?.merged,
      false,
      "similarity 0.81 is below 0.82 threshold — must NOT merge",
    );
    const active = getResearchLab().hypotheses.filter(
      h => h.status === "forming" || h.status === "testing",
    );
    assert.equal(active.length, 2, `expected 2 rows, got ${active.length}`);
  });

  it("threshold boundary: similarity 0.83 → consolidated as alias", async () => {
    const existing = "Is GPT-5 coming?";
    const candidate = "GPT-5 launch timeline";
    // cos(Δ) = 0.83 → Δ = acos(0.83)
    installEmbeddingMock(new Map([
      [existing, unitVec(0)],
      [candidate, unitVec(Math.acos(0.83))],
    ]));

    const first = await consolidateOrInsertHypothesis(hypInput(existing));
    assert.ok(first);
    const second = await consolidateOrInsertHypothesis(hypInput(candidate));
    assert.ok(second);

    assert.equal(
      second?.merged,
      true,
      "similarity 0.83 is above 0.82 threshold — must merge as alias",
    );
    assert.ok(
      (second?.similarity ?? 0) >= 0.82,
      `returned similarity should be >= 0.82, got ${second?.similarity}`,
    );
    const active = getResearchLab().hypotheses.filter(
      h => h.status === "forming" || h.status === "testing",
    );
    assert.equal(active.length, 1, "should still have only the canonical row");
    assert.equal(active[0].aliases?.length, 1);
    assert.equal(active[0].aliases?.[0], candidate);
  });

  it("canonical is inserted with aliasOf=null and cached embedding on first insert", async () => {
    const claim = "Will Ethereum gas fall below $0.10 in 2026?";
    const vec = unitVec(1.2);
    installEmbeddingMock(new Map([[claim, vec]]));

    const outcome = await consolidateOrInsertHypothesis(hypInput(claim));
    assert.ok(outcome);
    assert.equal(outcome?.merged, false);
    const stored = getResearchLab().hypotheses.find(h => h.id === outcome?.hypothesis.id);
    assert.ok(stored);
    assert.equal(stored?.aliasOf, null);
    assert.deepEqual(stored?.embedding, vec);
    assert.deepEqual(stored?.aliases, []);
  });

  it("embedding API failure falls back to legacy insertion (no crash)", async () => {
    const claim = "Embedding provider is down";
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "upstream error",
    })) as any;

    const outcome = await consolidateOrInsertHypothesis(hypInput(claim));
    assert.ok(outcome, "should still insert via legacy path on embedding failure");
    assert.equal(outcome?.merged, false);
    const stored = getResearchLab().hypotheses.find(h => h.claim === claim);
    assert.ok(stored, "hypothesis should exist in lab despite embedding failure");
  });
});
