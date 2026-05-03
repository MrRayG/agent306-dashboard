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
    `- Specific failure patterns we keep seeing and will reject: "Karpathy said X in December 2025", "Stanford HAI 2025 AI Index reports 54.6%", "the 2008 ambient display work", "by 2030 X% of Y", "token costs dropped 99% in 2 years", "the AI industry generated $N billion".`,
    `- Do NOT inject external context, named studies, named people, dated events, percentages, multipliers, dollar amounts, or year ranges that are NOT covered by an item in the APPROVED CLAIM MAP — even if they feel like common knowledge.`,
    `- If you feel the piece needs that context for the analysis to land, either (a) confine it to a clearly-marked Lane B analysis sentence that does NOT assert the specific number/year/name as fact, or (b) leave it out. Never invent a citation. Never staple the ${framing.primaryUrlLabel} onto an external fact it doesn't support.`,
    ``,
    `SOURCE-ABSENCE COMMENTARY — do NOT assert what the source DID NOT say:`,
    `- Forbidden surface form: "the paper does not answer whether X", "the source does not say Y", "the study fails to prove Z", "the authors never address W". These read as Lane A claims about the source's omissions but the source itself does not say it omitted them — the verifier treats them as unsupported negative attribution.`,
    `- Preferred rewrites stay inside Lane B / Lane C: "The open question is whether X.", "A future study would need to show Y.", "Agent 306's analysis is that Z remains unresolved.", "This points to an unresolved question — does W persist past the study window?"`,
    `- If the source explicitly acknowledges its own limitation (e.g. "future work should examine X"), you MAY assert that — that is a real Lane A claim with a real source-supported quote/paraphrase.`,
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
    `- If the source ITSELF acknowledges the limitation (e.g. quotes "future work should examine X"), keep the source-supported framing AND attach the inline citation. Otherwise, prefer the Lane B rewrite.`,
    `- Do NOT delete commentary that genuinely reflects 306's analysis — convert it to clearly-marked Lane B agent voice instead. Boundary phrases: "My read —", "Agent 306's analysis:", "The open question is —".`,
  ].join("\n");
}
