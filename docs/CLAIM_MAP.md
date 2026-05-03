# CLAIM MAP — Pre-Draft Claim Plan (Roadmap Issue A2)

Status: shipped 2026-05-02. Companion to `docs/VERIFIER_CONTRACT.md` and the
source-ledger introduced in PR #259.

## Why

Drafts produced by the writer used to receive arbitrary hidden prompt state
— voice rules, source pool, fresh context — and the writer was free to
assert any factual claim it could justify mid-paragraph. The verifier could
flag a failing sentence but had no stable identifier to point back to "the
claim the writer was supposed to assert." Every dashboard hint, revise-loop
signal, and operator override had to re-derive structure from the draft text.

The claim map is the structural plan that closes that gap. Before the
writer is called, the engine derives the set of claims the draft is allowed
to assert, persists it next to the source ledger, and feeds those claims
into the writer prompt with stable IDs the verifier can map failures back
to.

## Tables

- `claim_map(id, engine, draft_id, topic, source_ledger_id, created_at,
  updated_at)` — one row per draft. Unique on (engine, draft_id).
- `claim_map_items(id, claim_map_id, item_key, claim_text, claim_type,
  citation_requirement, source_support, confidence, risk, approved, note,
  created_at)` — N rows per claim map. `item_key` is the stable identifier
  the writer prompt + verifier mapping use. itemKeys are draft-local
  (e.g. `blog:1`, `article:1`) and interpreted within the parent
  `claim_map` row's `(engine, draft_id)` scope.

`source_support` is a JSON array of source URLs (or other stable
identifiers). Empty for voice / analysis claims.

`claim_type` ∈ `factual_external | factual_attributed | analysis | synthesis | voice`.
`citation_requirement` ∈ `required | optional | forbidden`.

## Pipelines wired in this PR

- `blogEngine.generateBlogPost` — builds the claim map from the research
  pack + source pool BEFORE the writer LLM call, includes the
  `APPROVED CLAIM MAP` block in the writer's user message, and persists
  the items under the real post id after `createBlogPost`.
- `articleEngine.runWeeklyDeepRead` — same pattern. The Deep Read writer
  prompt now carries the same APPROVED CLAIM MAP block.

Other engines (academy / dispatch / news / signal) are intentionally NOT
wired in this PR — their source patterns are different and the bounded
A2 scope is blog + article + Deep Read.

## Verifier failure mapping

`mapVerifierFailuresToClaims({ engine, draftId, report })` annotates each
failing entry in a `VerifierReport` with the `item_key` it most likely
came from. The mapping is deterministic token-overlap (no embeddings, no
LLM call) and returns `claimItemKey: null` when no claim overlapped the
failing sentence above the minimum threshold.

This is the deterministic baseline. Cluster B can replace the
implementation with a verifier-internal mapping without changing the
persisted shape.

## Writer/reviser claim-lane contract (PR #272, 2026-05-03)

Persistence of the claim map fixed the structural gap. PR #272 closes the
behavioral gap: writers and revisers now ALSO have to obey the lanes the
map emits.

The `server/articleClaimLaneContract.ts` module is the single source of
truth for the article-side rules. It is injected into both the article
writer system prompt (`server/articleEngine.ts → generateDeepReadArticle`)
and the article reviser system prompt
(`server/articleReviseLoop.ts → defaultRewrite`).

Rule summary (full text in the module):

- `claim_type=analysis` / `citation_requirement=forbidden` items: agent
  voice, no citation, must be CLEARLY MARKED as analysis when adjacent
  to source-supported sentences. Boundary phrases like "My analysis,
  not a claim made by the paper —" are required.
- `claim_type=factual_attributed` / `citation_requirement=required` items:
  inline `[Publisher](URL)` in the SAME sentence using the URL listed
  under `support=`. No claim extension beyond what the source supports.
- Out-of-plan external facts (named studies, dated events, percentages,
  multipliers, dollar amounts not covered by any claim_map item) are a
  HARD BLOCK — even if they feel like common knowledge. Specific
  failure templates we keep seeing and reject by name include the
  Karpathy/Dec-2025, Stanford-HAI/54.6%, 2008-ambient-display,
  2030-projection, and token-cost-drop patterns.

The reviser repair contract is now lane-aware: for `LANE_B_BARE`, REMOVE
the bare external fact is the FIRST repair option when no supporting URL
exists — softening with a verbal hedge is a fallback, and stapling the
primary article URL onto an unsupported fact is FORBIDDEN. For
`LANE_A_FAIL`, converting to clearly-marked Agent 306 analysis with a
boundary phrase is acceptable when the assertion is genuinely 306's view
(particularly normative-requirement-shaped failures like "X must do Y to
earn label coach").

Tests: `server/__tests__/articleClaimLaneContract.test.ts` is a
static-source grep that asserts the contract block + reviser repair
language are present in the writer and reviser. The verifier itself is
unchanged — this PR is contract enforcement only, no schema change, no
threshold change, no publish gate change.

## Cross-engine lane contract (PR #273, 2026-05-03)

PR #273 generalizes the per-engine Article contract into a shared module
`server/claimLaneContract.ts` and wires it into Article + Blog +
Manuscript writer/reviser prompts. The Article module
(`server/articleClaimLaneContract.ts`) is preserved as the entry point
for the Article engine and now delegates to the shared block, so the
legacy `ARTICLE_CLAIM_LANE_CONTRACT@v1` marker continues to ship
alongside the cross-engine `CLAIM_LANE_CONTRACT@v1` marker.

Three lanes (cross-engine vocabulary):

- LANE A — SOURCE CLAIMS (`factual_attributed`, citation required). "The
  source says X." MUST be directly source-supported, inline
  `[Publisher](URL)` in the SAME sentence. HARD FAIL if the assertion
  drifts past what the source says.
- LANE B — AGENT ANALYSIS (`analysis`, citation forbidden). "Agent 306's
  read is X" / forward projection / synthesis. Allowed and encouraged,
  but MUST be marked as agent voice (boundary phrases like "My read —",
  "Agent 306's analysis:", "The open question is —").
- LANE C — EXTERNAL CONTEXT (`factual_external`, citation required).
  "Karpathy says X" / "Stanford HAI reports X%". REQUIRES its own
  ledger-backed source URL. Otherwise: hold or remove. Never staple the
  primary source URL onto an external fact it doesn't support.

Source-absence commentary rule: phrasings like "the paper does not
answer X" / "the source does not say Y" / "the study fails to prove Z"
read as Lane A negative-attribution but the source itself does not say
it omitted that — the verifier flags them as Lane A drift. Preferred
rewrites stay inside Lane B / Lane C: "The open question is X.", "A
future study would need to show Y.", "Agent 306's analysis is Z." If
the source ITSELF acknowledges the limitation, it is a legitimate
Lane A claim with a real source-supported quote/paraphrase.

This is the residual failure mode the Bloom/arXiv Deep Read live test
surfaced after #272: the Article reviser produced "Agent 306's analysis:
the paper does not answer whether these mindset shifts persist after the
novelty fades..." — Lane A drift even though it was prefixed with an
agent-voice boundary phrase. The shared contract names the pattern and
gives the rewriter `buildSourceAbsenceRewriteRulesBlock()` to apply.

Wiring matrix:

| Engine | Writer prompt | Reviser prompt |
| --- | --- | --- |
| Article | `articleEngine.ts → generateDeepReadArticle` (via `buildArticleClaimLaneContractBlock`) | `articleReviseLoop.ts → defaultRewrite` (lane block + source-absence repair rules) |
| Blog | `blogEngine.ts → composeBlogPost` (`buildSharedClaimLaneContractBlock("blog")`) | `blogReviseLoop.ts → defaultRewrite` (lane block + source-absence repair rules) |
| Manuscript | `researchEngine.ts → runPhase7_Interpretation` (`buildSharedClaimLaneContractBlock("manuscript")`) | n/a — manuscript currently has no writer-side reviser loop; verifier gating runs in `manuscriptVerifier.ts`. Reviser-side wiring is the documented next follow-up if a manuscript reviser loop ships. |

Tests: `server/__tests__/claimLaneContract.test.ts` static-greps the
shared block content (three lanes, source-absence rules, engine framing)
and asserts the wiring is in place for Article / Blog / Manuscript
prompt sources. The Article-specific
`server/__tests__/articleClaimLaneContract.test.ts` is preserved
unchanged so the @v1 marker test continues to pass.

## Limitations / deferred

- Token-overlap matching is intentionally simple. Two claims that share
  the same nouns will both get the same match; the helper picks the
  highest-scoring one without confidence reporting.
- The writer is not yet required to emit the `[item_key]` markers
  back into the draft. The current verifier-failure mapping reads
  the draft text and matches against claim_text. Cluster B can teach
  the writer to embed and preserve the markers.
- Out-of-plan claims (sentences that survive verification but were
  never in the claim map) are NOT flagged here. The verifier already
  enforces source-locality; "outside the plan" detection is deferred
  to Cluster B.
- Academy / dispatch / news / signal pipelines are not migrated.
- Manuscript reviser-side wiring is deferred — the manuscript writer
  receives the shared contract but there is no manuscript reviser loop
  yet; if one ships it should import `buildSharedClaimLaneContractBlock("manuscript")`
  + `buildSourceAbsenceRewriteRulesBlock()` (PR #273 follow-up).

## Migration notes

- `claim_map` and `claim_map_items` are additive tables with
  `CREATE TABLE IF NOT EXISTS` migration in `server/db.ts`. Pre-existing
  databases pick them up on next boot with no manual step. No schema
  alterations are needed for any other table.
- No environment variables, feature flags, or runtime gates were added.
  The pre-draft claim map runs unconditionally on the migrated engines.
- Failure path: `createOrReplaceClaimMap` swallows DB errors and warns,
  matching `sourceLedgerRepository`. The engine hot path is never broken
  by claim-map persistence.

## Risk / rollback

- Risk: low. The feature is additive. Removing it requires reverting
  the engine wiring; the tables can stay.
- Rollback: revert the PR. If only the prompt fragment regresses voice,
  setting the in-engine `claimMapBlock` to `""` (or returning early
  from `buildClaimMapPromptBlock`) disables the prompt injection while
  keeping persistence.
