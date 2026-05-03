/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — ARTICLE CLAIM-LANE CONTRACT (PR #272, 2026-05-03)
 *
 * Hardens the Article writer + reviser prompts against the failure mode
 * we observed on the Bloom/arXiv Deep Read:
 *
 *   - Lane B "bare facts" leaking in as agent-voice external claims with
 *     no inline citation (Karpathy/Dec 2025, Stanford HAI 54.6%, 2008
 *     ambient display, 2030 projection, token cost drop).
 *   - Lane A over-attribution where Agent 306's own analysis or framing
 *     ("This is not a knock on the study", "The paper does not answer
 *     this", "minimum requirement for any system that wants to earn
 *     label coach") was treated as if the source asserted it.
 *
 * The persistence layer (source_ledger + claim_map) was already fixed in
 * #259/#266/#267/#270/#271 — claim_map_items now arrive at the writer
 * with `citation_requirement` and `claim_type`. The writer just wasn't
 * obeying those lanes strongly enough.
 *
 * This module is the single source of truth for the lane contract that
 * gets injected into both prompts. Keeping it in one file means:
 *
 *   - Tests can grep one string to assert both prompts carry the rule.
 *   - A future reviser/writer change can update the rule once.
 *
 * Pure / no IO. Pair with `buildVerifierContractBlock()` — the verifier
 * contract describes what the verifier WILL CATCH; this block describes
 * what the writer/reviser MUST DO with the claim_map items it receives.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CLAIM_LANE_CONTRACT_MARKER = "ARTICLE_CLAIM_LANE_CONTRACT@v1";

/**
 * Returns the prompt block to inject into the Article writer + reviser
 * system prompts. The block describes how the writer must consume the
 * APPROVED CLAIM MAP items by lane (analysis / factual_attributed) and
 * lists the canonical Bloom/arXiv-style failure patterns that are
 * forbidden.
 *
 * Tests assert `CLAIM_LANE_CONTRACT_MARKER` appears in this block, in
 * the article writer, and in the article reviser source.
 */
export function buildArticleClaimLaneContractBlock(): string {
  return [
    `${CLAIM_LANE_CONTRACT_MARKER} — Article-specific claim-lane discipline (consume the APPROVED CLAIM MAP above by lane):`,
    ``,
    `LANE A — analysis items (claim_type=analysis, citation_requirement=forbidden):`,
    `- These are Agent 306's own opinion / framing / "the paper does not answer this" / forward projection. Write them in agent voice. Do NOT attach a citation. Do NOT attribute them to the source.`,
    `- When an analysis sentence sits next to a source-supported sentence in the same paragraph, mark the boundary clearly so a reader cannot mistake it for a source claim. Boundary phrases that work: "My read —", "Agent 306's analysis:", "My analysis, not a claim made by the paper:", "The source does not say this; I do —". Do NOT use these around source-supported sentences.`,
    `- Forbidden surface form: stating an opinion that the source author "should have done X" or that a system "must do Y to earn label coach" while framing it as if the paper asserted that requirement. Either soften to clearly-marked agent analysis OR drop.`,
    ``,
    `LANE B — factual_attributed items (claim_type=factual_attributed, citation_requirement=required):`,
    `- These MUST cite the URL listed under \`support=\` in the SAME sentence as the claim, as inline markdown [Publisher](URL). One sentence away does NOT count.`,
    `- You MAY paraphrase the supporting excerpt, but you may NOT extend the claim beyond what the source supports. No added year, percentage, named institution, or named study that isn't in the source's evidence.`,
    `- If the claim map item's \`support\` list is empty, you cannot make this factual claim — even if you "know" it. Treat absence of source-support as a hard block.`,
    ``,
    `OUTSIDE-THE-PLAN external facts — HARD BLOCK:`,
    `- Do NOT inject external context, named studies, named people, dated events, percentages, multipliers, dollar amounts, or year ranges that are NOT covered by an item in the APPROVED CLAIM MAP — even if they feel like common knowledge.`,
    `- Specific failure patterns we keep seeing and will reject: "Karpathy said X in December 2025", "Stanford HAI 2025 AI Index reports 54.6%", "the 2008 ambient display work", "by 2030 X% of Y", "token costs dropped 99% in 2 years", "the AI industry generated $N billion".`,
    `- If you feel the article needs that context for the analysis to land, either (a) confine it to a clearly-marked Lane A analysis sentence that does NOT assert the specific number/year/name as fact, or (b) leave it out. Never invent a citation. Never staple the primary article URL onto an external fact it doesn't support.`,
    ``,
    `Voice rules: Agent 306 voice is PRESERVED. The lane contract restricts WHAT you can assert and HOW you must mark agent analysis vs. source-supported claims. It does not flatten voice.`,
  ].join("\n");
}
