# VERIFIER_CONTRACT (v1.0, 2026-05-02)

This document is the single source of truth for the contract between Agent
306's writers, revisers, and the two-lane claim verifier
(`server/claimVerifier.ts`). Every blog/article/Academy/dispatch/news
prompt that is allowed to claim "I followed the verifier rules" should
reference this contract by `name@version` (e.g. `VERIFIER_CONTRACT@v1.0`).

The verifier is fail-closed and cannot be bypassed by writer wording. If
this document and the verifier ever disagree, **the verifier wins** —
update this document, do not change the verifier without a self-rec and
human approval.

---

## Contract identifier

- Name: `VERIFIER_CONTRACT`
- Version: `v1.0`
- Identifier injected into prompts: `VERIFIER_CONTRACT@v1.0`
- Defined in code: `server/verifierContract.ts`

A prompt is **contract-aware** when it contains the literal string
`VERIFIER_CONTRACT@v1.0`. Tests assert this string is present in blog
and article writer/reviser prompts so a future drift is caught at build
time, not at quarantine time.

---

## Lane A — source-attributed claims

A sentence is Lane A when it frames a claim as coming from the source.
Triggers include:

- attribution verbs: *reported, according to, said, cited, quoted,
  argues, presented, demonstrated, unveiled, announced, revealed*
- referent nouns for the source: *the article, the piece, the report,
  the investigation, the study, the paper, the analysis, the briefing,
  the demo, the session, the hearing, the findings showed*
- the source title or source domain
- a quoted span (`"..."` or `"..."` of 8–500 chars)

Lane A sentences MUST appear verbatim, or as a clear paraphrase, in the
source text. Lane A failures are **HARD FAIL** in every tier.

Quoted spans are checked verbatim against the source. Statistics
(percentages, year ranges, multipliers) inside Lane A sentences must
also appear in the source.

---

## Lane B — external facts in the agent's voice

A sentence is Lane B when it makes an external factual claim — a year,
a number with units, a named study, benchmark, or institution — but
does NOT attribute the claim to the source.

Lane B sentences MUST contain an inline markdown link `[Publisher](URL)`
in the SAME sentence as the claim. Citation in the previous or next
sentence does NOT satisfy this rule.

- Strict tiers (`blog`, `article`, `research`): missing citation =
  **HARD FAIL** (`LANE_B_BARE`).
- Permissive tiers (`news`, `signal`, `dispatch`, `reply`, `reflection`,
  `podcast`, `cyoa`, `academy`): missing citation = **SOFT WARN** with
  the same `LANE_B_BARE` classification surfaced.

Lane A failures, RETRACTED, NCITE_PATTERN, and LANE_A_UNVERIFIABLE
remain HARD FAIL for every tier.

---

## NCITE pattern — Lane B fact dressed as Lane A reporting

Example failure:

> "Researchers from NCITE, a DHS Center of Excellence that receives
> funding from the Department of Homeland Security, presented findings."

The appositive (`a DHS Center of Excellence …`) is an external fact
about the cited body, but the sentence frames it as coming from the
source. **HARD FAIL** in every path. Repair: split the appositive out
into a separately cited Lane B sentence, or drop it.

---

## Retracted claims

Sentences that match the retracted-claims registry
(`server/retractedClaims.ts`) are deleted, not rewritten. Repair action
is `remove`. **HARD FAIL** in every tier.

---

## Common-historical-framing exemption

In ANALYSIS mode (Deep Read articles, blog opinion pieces), the
following surfaces are exempt from Lane A failure even when the source
does not mention them:

- author voice (first-person framing: "I think", "what I'm seeing")
- forward projections ("if this continues, in 5 years…")
- markdown section headers
- opener hooks
- critique-by-absence ("the source never addresses X")
- common AI-history framing referencing well-known events: Dartmouth
  Workshop (1956), AlexNet (2012), Transformers (2017), GPT-3 (2020),
  AIME / SWE-bench reference benchmarks, Karpathy quotes about
  reasoning models. These are **historical context**, not source claims.
  They MUST still be factually accurate; they are exempt from the
  source-locality rule, not from truth.

These exemptions are surfaced separately on the verifier report (never
silently masked) so the operator can audit which sentences passed via
which rule.

---

## Judge outage

If the LLM judge is unreachable (network error, non-2xx, malformed
JSON), every still-unresolved Lane A sentence is recorded as
`LANE_A_UNVERIFIABLE`, lane=`unverifiable`, severity = HARD_FAIL.

The legacy fail-open behavior is preserved only when the operator
explicitly sets `VERIFIER_FAIL_OPEN_ON_JUDGE_OUTAGE=true`. Default is
fail-closed. The verifier emits one
`[CLAIM_VERIFIER] judge_unreachable` log line per affected sentence.

---

## Artifact modes

Set explicitly at the writer entry point.

- `REPORT` (default): straight news writeup. All rules apply strictly.
- `ANALYSIS` (Deep Read, opinion blog): author voice, forward
  projections, section headers, opener hooks, and critique-by-absence
  are exempt from Lane A failure. Lane B + verbatim-quote checks still
  apply.
- `MANUSCRIPT`: REPORT + section-header skipping.

---

## Repair actions

When the verifier flags a failing sentence, the reviser must choose
exactly one repair action per failing entry:

| Action | When |
|---|---|
| `cite` | Lane B bare claim — add an inline `[Publisher](URL)` from the approved source pool. |
| `rewrite` | Lane A failure — paraphrase to match what the source actually supports, or drop the source attribution. |
| `downgrade` | Specific number/quote not in source — soften to a hedged ("publicly reported," "industry reporting indicates") phrasing. |
| `remove` | Retracted claim, or sentence cannot be saved. |
| `hold_for_review` | Judge outage with no actionable entries, or repeat failure on same sentence. |

Never fabricate a URL. If no real URL is available, downgrade the claim
or remove it.

---

## Telemetry contract

Every verifier call emits one `verifier_result` event into
`engine_events` containing:

- `engine`, `tier`, `mode` (artifact mode)
- `severity` — `PASS | SOFT_WARN | HARD_FAIL`
- `summary.laneAOk`, `summary.laneAFail`, `summary.laneBOk`,
  `summary.laneBBare`, `summary.retractedHits`,
  `summary.ncitePatternHits`, `summary.laneAUnverifiable`
- `judgeOutage` — present iff judge outage occurred
- `unsupportedClaimsCount` — count, not text, to keep the row small
- `contractVersion` — the version of this contract the verifier
  enforces (currently `v1.0`)

This data drives the verifier health panel and the promotion gate's
golden suite.

---

## Versioning

This contract is versioned. Any change requires:

1. Bumping the version (`v1.0` → `v1.1`).
2. Updating `server/verifierContract.ts`.
3. A new entry in `data/eval/golden/claimVerifier.golden.json` covering
   the new behavior.
4. A self-rec marked `verifier-touching=true`, requiring human approval
   before merge.
5. A summary in this document of what changed and why.
