/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — ARTICLE CLAIM-LANE CONTRACT (PR #272, refactored in PR #273)
 *
 * Hardens the Article writer + reviser prompts against the failure modes
 * surfaced on the Bloom/arXiv Deep Read live test:
 *
 *   - Lane B "bare facts" leaking in as agent-voice external claims with
 *     no inline citation (Karpathy/Dec 2025, Stanford HAI 54.6%, 2008
 *     ambient display, 2030 projection, token cost drop).
 *   - Lane A over-attribution where Agent 306's own analysis or framing
 *     ("This is not a knock on the study", "The paper does not answer
 *     this", "minimum requirement for any system that wants to earn
 *     label coach") was treated as if the source asserted it.
 *
 * As of PR #273 the lane contract is shared across Article / Blog /
 * Manuscript via `claimLaneContract.ts`. This module is kept as the
 * Article-specific entry point so:
 *
 *   - The legacy ARTICLE_CLAIM_LANE_CONTRACT@v1 marker continues to ship
 *     (existing tests + downstream telemetry grep on it).
 *   - Article callers don't need to know about engine selection — they
 *     call `buildArticleClaimLaneContractBlock()` and get the right
 *     engine framing for free.
 *   - The Article block also now carries the source-absence commentary
 *     rule (rewrite "the paper does not answer X" → "The open question
 *     is X.").
 *
 * Pure / no IO. Pair with `buildVerifierContractBlock()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { buildSharedClaimLaneContractBlock } from "./claimLaneContract.js";

export const CLAIM_LANE_CONTRACT_MARKER = "ARTICLE_CLAIM_LANE_CONTRACT@v1";

/**
 * Returns the Article writer + reviser prompt block. Carries BOTH the
 * legacy ARTICLE_CLAIM_LANE_CONTRACT@v1 marker and the cross-engine
 * CLAIM_LANE_CONTRACT@v1 marker so a single grep across writer/reviser
 * sources can validate either contract id.
 *
 * Tests assert `CLAIM_LANE_CONTRACT_MARKER` appears in this block, in
 * the article writer, and in the article reviser source.
 */
export function buildArticleClaimLaneContractBlock(): string {
  return [
    `${CLAIM_LANE_CONTRACT_MARKER} — Article-specific framing for the cross-engine claim-lane contract below.`,
    ``,
    buildSharedClaimLaneContractBlock("article"),
  ].join("\n");
}
