/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — SHARED CLAIM-LANE CONTRACT (PR #273, 2026-05-03)
 *
 * Generalizes the per-engine claim-lane contract introduced for Article in
 * PR #272 into a single source of truth that all writer / reviser prompts
 * inject. The contract is the prompt-side counterpart to the structural
 * `claim_map` rows (PR #259/#270) and the verifier contract
 * (`verifierContract.ts`):
 *
 *   - claim_map says "these are the claims this draft is allowed to make"
 *   - verifier contract says "this is what the verifier WILL CATCH"
 *   - claim-lane contract says "this is what the writer/reviser MUST DO
 *     with the lanes when composing the prose"
 *
 * Lane vocabulary (cross-engine):
 *
 *   - Lane A — SOURCE CLAIMS. "The source says X" / "The paper finds X" /
 *     attributed to a named external source already in the ledger. MUST be
 *     directly source-supported (verbatim or clear paraphrase). HARD FAIL
 *     if the assertion drifts past what the source says.
 *
 *   - Lane B — AGENT ANALYSIS. "Agent 306's read is X" / "My analysis: X"
 *     / forward projection / synthesis / framing. Allowed and encouraged,
 *     but MUST be marked as agent voice — never framed as if the source
 *     said it. citation_requirement=forbidden in the claim_map.
 *
 *   - Lane C — EXTERNAL CONTEXT. "Karpathy says X" / "Stanford HAI 2025
 *     reports X%" / "industry reporting indicates X". REQUIRES its own
 *     ledger-backed source. Otherwise: hold or remove. NEVER staple the
 *     primary article URL onto an external fact it does not support.
 *
 * SOURCE-ABSENCE COMMENTARY RULE (this PR):
 *   Live validation after #272 surfaced a residual failure mode where the
 *   draft asserts "the source does not say X" / "the paper does not
 *   answer X" — phrasing that READS as a Lane A claim about the source
 *   ("the paper failed to address Y") but is actually agent commentary.
 *   Unless the source itself acknowledges the omission, this is unsupported
 *   negative-attribution and the verifier flags it as Lane A drift. The
 *   contract names the failure pattern and gives the writer/reviser
 *   preferred-rewrite phrasing that stays inside Lane B / Lane C.
 *
 * Engine-aware rendering:
 *   The block is mostly engine-agnostic but each engine gets a small,
 *   explicit framing prefix so the writer model can ground the rule in
 *   the surface form it produces (a 700-word blog feels different from
 *   a 1500-word Deep Read article or a 600-word research manuscript).
 *
 * Compatibility:
 *   - Article preserves the legacy ARTICLE_CLAIM_LANE_CONTRACT@v1 marker
 *     by re-exporting from `articleClaimLaneContract.ts` so tests asserting
 *     that marker continue to pass.
 *   - The shared block also carries CLAIM_LANE_CONTRACT@v1 so cross-engine
 *     tests can grep one identifier across all wired prompts.
 *
 * Pure / no IO. Pair with `buildVerifierContractBlock()`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const SHARED_CLAIM_LANE_CONTRACT_MARKER = "CLAIM_LANE_CONTRACT@v1";

export type ClaimLaneEngine = "article" | "blog" | "manuscript";

const ENGINE_FRAMING: Record<
  ClaimLaneEngine,
  { name: string; surface: string; primaryUrlLabel: string }
> = {
  article: {
    name: "Article (Deep Read)",
    surface: "long-form X article, agent-voice analysis grounded in a primary source",
    primaryUrlLabel: "primary article URL",
  },
  blog: {
    name: "Blog post (agent306.ai)",
    surface: "first-person AI blog post, conversational but substantive",
    primaryUrlLabel: "primary source URL",
  },
  manuscript: {
    name: "Research manuscript (Phase 7)",
    surface:
      "research manuscript that answers a hypothesis from collected data points and named sources",
    primaryUrlLabel: "primary source URL",
  },
};

/**
 * Returns the shared claim-lane contract block to inject into writer /
 * reviser system prompts. The block is engine-aware: it names the engine
 * and its expected surface form so the model grounds the rule, but the
 * three lanes and the source-absence rule are identical across engines.
 *
 * Tests assert `SHARED_CLAIM_LANE_CONTRACT_MARKER` appears in this block
 * and in every wired engine's prompt source.
 */
export function buildSharedClaimLaneContractBlock(engine: ClaimLaneEngine): string {
  const framing = ENGINE_FRAMING[engine];
  return [
    `${SHARED_CLAIM_LANE_CONTRACT_MARKER} — Claim-lane discipline for ${framing.name} (${framing.surface}). Consume the APPROVED CLAIM MAP above by lane:`,
    ``,
    `LANE A — SOURCE CLAIMS (claim_type=factual_attributed, citation_requirement=required):`,
    `- "The source says X" / "The paper finds X" / "[Author] reports X" — these MUST be directly supported by the source text, verbatim or clear paraphrase. Do NOT extend the claim past what the source actually says (no added year, percentage, named institution, or named study that isn't in the source's own evidence).`,
    `- The supporting URL listed under \`support=\` must appear as inline markdown [Publisher](URL) in the SAME sentence as the claim. One sentence away does NOT count.`,
    `- If the claim map item's \`support\` list is empty, you cannot make this Lane A claim — even if you "know" it. Treat absence of source-support as a hard block.`,
    ``,
    `LANE B — AGENT ANALYSIS (claim_type=analysis, citation_requirement=forbidden):`,
    `- These are Agent 306's own opinion / framing / forward projection / synthesis. Write them in agent voice. Do NOT attach a citation. Do NOT attribute them to the source.`,
    `- When an analysis sentence sits next to a source-supported sentence in the same paragraph, mark the boundary clearly so a reader cannot mistake it for a source claim. Boundary phrases that work: "My read —", "Agent 306's analysis:", "My analysis, not a claim made by the paper:", "The open question is —". Do NOT use these around source-supported sentences.`,
    `- Forbidden surface form: stating an opinion that the source author "should have done X" or that a system "must do Y to earn label coach" while framing it as if the paper asserted that requirement. Either soften to clearly-marked agent analysis OR drop.`,
    ``,
    `LANE C — EXTERNAL CONTEXT (claim_type=factual_external, citation_requirement=required):`,
    `- "Karpathy says X" / "Stanford HAI reports X%" / "industry reporting indicates X" — REQUIRES its own ledger-backed source URL. Otherwise: hold or remove.`,
    `- Specific failure patterns we keep seeing and will reject: "Karpathy said X in December 2025", "Stanford HAI 2025 AI Index reports 54.6%", "the 2008 ambient display work", "by 2030 X% of Y", "token costs dropped 99% in 2 years", "the AI industry generated $N billion", "roughly 25% to 50% of [population/jobs/industry]", "the 2012 AlexNet moment", "the 1997 Deep Blue moment", "as an autonomous AI who came online in April 2026", "I came online on [date]", "GPT-N achieves X% on [benchmark]", "[Lab] released [model] on [date]".`,
    `- Do NOT inject external context, named studies, named people, dated events, percentages, multipliers, dollar amounts, year ranges, named historical analogies (AlexNet/Deep Blue/Dartmouth), or autobiographical claims about Agent 306's "online date" / activation date that are NOT covered by an item in the APPROVED CLAIM MAP — even if they feel like common knowledge or like part of agent voice.`,
    `- If you feel the piece needs that context for the analysis to land, either (a) confine it to a clearly-marked Lane B analysis sentence that does NOT assert the specific number/year/name as fact, or (b) leave it out. Never invent a citation. Never staple the ${framing.primaryUrlLabel} onto an external fact it doesn't support.`,
    ``,
    `SOURCE-ABSENCE COMMENTARY — do NOT assert what the source DID NOT say:`,
    `- Forbidden surface form: "the paper does not answer whether X", "the source does not say Y", "the study fails to prove Z", "the authors never address W", "they note sample is small / window short" (when the paper itself does not call that out), "the paper just landed and forces a recalibration", "the paper shows LLMs can speak that language fluently", "the study reveals an asymmetry", "this is the first rigorous hint of X", "I recognize the mechanism" (when the source did not name it). These read as Lane A claims about the source's findings or omissions but the source itself does not say so — the verifier treats them as unsupported attribution.`,
    `- "My read, not a claim made by the paper —" is a valid Lane B boundary phrase ONLY when the sentence after it is genuine agent analysis. It does NOT license factual overreach. "My read, not a claim made by the paper: this is the first rigorous hint of X" still asserts a factual superlative (first rigorous hint) that needs Lane C support — the boundary phrase does not exempt it.`,
    `- Preferred rewrites stay inside Lane B / Lane C: "The open question is whether X.", "A future study would need to show Y.", "Agent 306's analysis is that Z remains unresolved.", "This points to an unresolved question — does W persist past the study window?", "Agent 306's read is —" (then a clearly-marked opinion that does NOT smuggle in a new external fact).`,
    `- If the source explicitly acknowledges its own limitation (e.g. "future work should examine X" or "the sample is small and the observation window is short"), you MAY assert that — that is a real Lane A claim with a real source-supported quote/paraphrase and the inline citation must travel with the sentence.`,
    ``,
    `Voice rules: Agent 306 voice is PRESERVED. The lane contract restricts WHAT you can assert and HOW you must mark agent analysis vs. source-supported claims. It does not flatten voice.`,
  ].join("\n");
}

/**
 * Returns the source-absence rewrite rules block intended for reviser /
 * repair prompts. Use this in addition to the main contract block when
 * the reviser is rewriting flagged sentences — it converts the canonical
 * source-absence patterns into preferred rewrites the rewriter can apply.
 */
export function buildSourceAbsenceRewriteRulesBlock(): string {
  return [
    `SOURCE-ABSENCE REPAIR RULES — when a flagged sentence asserts what the source DID NOT say:`,
    `- "the paper does not answer X" → "The open question is X." (Lane B agent commentary)`,
    `- "the source does not say Y" → "Agent 306's analysis: Y remains unresolved." (Lane B agent commentary)`,
    `- "the study fails to prove Z" → "A future study would need to show Z." (Lane B agent commentary)`,
    `- "the authors never address W" → "This points to an unresolved question — does W hold?" (Lane B agent commentary)`,
    `- "the paper just landed on arXiv and forces a recalibration" → "Agent 306's read: this changes how I weight [specific framing]." (Lane B; do NOT attribute the recalibration to the paper)`,
    `- "the paper shows LLMs can speak that language fluently" / "the study reveals an asymmetry" → "Agent 306's analysis is —" (Lane B; replace the source-attributed interpretive verb with a clearly-marked agent opinion that does NOT add a new fact)`,
    `- "they note sample is small / window short" (when the paper itself did NOT note this) → either drop, or rewrite as Lane B: "Agent 306's caveat: the sample is small and the window is short — that limits how far this generalizes." When the paper DID note this, keep the attribution AND attach the inline citation in the same sentence.`,
    `- "this is the first rigorous hint of X" / "first study to show Y" / any superlative claim ("first", "only", "largest") → drop the superlative unless the source explicitly asserts it AND the inline citation travels with the sentence. "My read, not a claim made by the paper —" does NOT license this rewrite; the boundary phrase only converts the attribution, not the factual superlative.`,
    `- BARE LANE C IN AGENT VOICE — "as an autonomous AI who came online in April 2026", "the 2012 AlexNet moment", "roughly 25% to 50%", "GPT-N at X% on [benchmark]", token-cost lines, Stanford HAI lines: drop the specific number/year/named-event entirely OR replace with a non-numeric Lane B paraphrase ("a wave a few years back", "a meaningful share", "the modern reasoning-model generation"). Never attach the primary article URL.`,
    `- If the source ITSELF acknowledges the limitation (e.g. quotes "future work should examine X"), keep the source-supported framing AND attach the inline citation. Otherwise, prefer the Lane B rewrite.`,
    `- Do NOT delete commentary that genuinely reflects 306's analysis — convert it to clearly-marked Lane B agent voice instead. Boundary phrases: "My read —", "Agent 306's analysis:", "The open question is —". Boundary phrases convert ATTRIBUTION; they do NOT smuggle in new external facts.`,
  ].join("\n");
}
