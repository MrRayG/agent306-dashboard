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
  the writer prompt + verifier mapping use (e.g. `blog_blog_1729000000:1`).

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
