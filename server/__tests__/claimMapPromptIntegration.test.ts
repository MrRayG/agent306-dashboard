/**
 * Prompt-inclusion integration test for the pre-draft claim map (Roadmap A2).
 *
 * Verifies the deterministic glue the blog/article engines run before
 * calling the LLM: build a claim map from the source pool, render it as a
 * writer-prompt block, and confirm the block carries the stable [itemKey]
 * markers + voice-rules reminder the verifier-failure mapping depends on.
 *
 * Pure / no DB / no LLM. The engine-side wiring is exercised in the
 * sourceLedger + repo tests; this test ensures the prompt fragment shape
 * is what the writer actually receives.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildClaimMap } from "../claimMapBuilder.js";
import { buildClaimMapPromptBlock } from "../repositories/claimMapRepository.js";
import type { ClaimMapItem } from "@shared/schema";

function toClaimMapItems(
  draft: ReturnType<typeof buildClaimMap>,
): ClaimMapItem[] {
  return draft.items.map((it, i) => ({
    id: i,
    claimMapId: 0,
    itemKey: it.itemKey ?? `blog:${i + 1}`,
    claimText: it.claimText,
    claimType: it.claimType,
    citationRequirement: it.citationRequirement,
    sourceSupport: JSON.stringify(it.sourceSupport ?? []),
    confidence: it.confidence ?? 0.5,
    risk: it.risk ?? "low",
    approved: it.approved !== false,
    note: it.note ?? null,
    createdAt: "",
  }));
}

describe("claim map → writer prompt block (Roadmap A2)", () => {
  it("rendered block carries the contract markers verifier mapping relies on", () => {
    const draft = buildClaimMap({
      engine: "blog",
      draftId: "blog_x",
      topic: "AI safety",
      references: [
        {
          refId: "r1",
          url: "https://example.com/openai-gpt5",
          title: "OpenAI announces GPT-5",
          publisher: "OpenAI",
          qualityTier: "reputable",
          pulledBy: "blog",
          attachedAt: new Date().toISOString(),
          evidenceExcerpt: "GPT-5 launched on 2025-09-12 with reasoning.",
        },
      ],
    });
    const items = toClaimMapItems(draft);
    const block = buildClaimMapPromptBlock(items);

    // The header is what the writer is told to follow.
    assert.match(block, /APPROVED CLAIM MAP/);

    // Every approved item must carry a stable [itemKey] marker — the
    // verifier-failure mapping uses these to refer back to specific claims.
    for (const it of items.filter(i => i.approved)) {
      assert.ok(
        block.includes(`[${it.itemKey}]`),
        `prompt block missing [${it.itemKey}] marker`,
      );
    }

    // The citation-requirement contract must travel with the prompt so
    // the writer doesn't have to re-derive it. factual_attributed →
    // citation=required; analysis → citation=forbidden.
    assert.match(block, /type=factual_attributed citation=required support=https:\/\/example\.com\/openai-gpt5/);
    assert.match(block, /type=analysis citation=forbidden support=none/);

    // The closing reminder is what keeps the writer from inventing
    // out-of-plan factual claims.
    assert.match(block, /Do NOT add external factual claims that are not in this list/);
  });

  it("empty claim map collapses to '' so engines can concat unconditionally", () => {
    assert.equal(buildClaimMapPromptBlock([]), "");
  });
});
