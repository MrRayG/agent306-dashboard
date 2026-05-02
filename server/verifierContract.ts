/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 306 — VERIFIER CONTRACT IDENTIFIER (Roadmap Issue A3, 2026-05-02)
 *
 * Single source of truth for the verifier-contract version writers and
 * revisers must declare adherence to. The full contract lives in
 * docs/VERIFIER_CONTRACT.md; this module exists so prompts can reference
 * a stable identifier and tests can assert it appears in the right
 * places.
 *
 *   VERIFIER_CONTRACT_NAME    — "VERIFIER_CONTRACT"
 *   VERIFIER_CONTRACT_VERSION — "v1.0"
 *   VERIFIER_CONTRACT_ID      — "VERIFIER_CONTRACT@v1.0"
 *
 *   buildVerifierContractBlock(): a short prose block to inject at the
 *   top of writer/reviser system prompts. Engines that need a different
 *   wording (e.g. Deep Read) can add framing around the block but MUST
 *   still include the contract id verbatim.
 *
 * Bumping the version:
 *   - Update VERIFIER_CONTRACT_VERSION here.
 *   - Update docs/VERIFIER_CONTRACT.md with the changelog entry.
 *   - Add or update the matching golden cases in
 *     data/eval/golden/claimVerifier.golden.json.
 *   - File a self-rec marked verifier-touching=true (human approval).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const VERIFIER_CONTRACT_NAME = "VERIFIER_CONTRACT";
export const VERIFIER_CONTRACT_VERSION = "v1.0";
export const VERIFIER_CONTRACT_ID = `${VERIFIER_CONTRACT_NAME}@${VERIFIER_CONTRACT_VERSION}`;

/**
 * Returns the prompt block to be injected verbatim into writer / reviser
 * system prompts. Includes the contract identifier so a regex test
 * (`/VERIFIER_CONTRACT@v\d+\.\d+/`) catches accidental drift.
 */
export function buildVerifierContractBlock(): string {
  return [
    `VERIFIER CONTRACT — you write under ${VERIFIER_CONTRACT_ID}. Full text: docs/VERIFIER_CONTRACT.md.`,
    `- LANE A (source-attributed): if a sentence frames a claim as coming from the source (attribution verb, source title/domain, or a quoted span), the claim MUST appear verbatim or as a clear paraphrase in the source. Lane A failure = HARD FAIL.`,
    `- LANE B (your own voice, external fact): a sentence with a year, number with units, named study/benchmark/institution, or specific dated event MUST contain an inline [Publisher](URL) citation in the SAME sentence. Citation one sentence away does NOT count. Strict tiers (blog, article, research) HARD FAIL on missing citation.`,
    `- NCITE PATTERN: do not embed an external fact (appositive about a cited body, an org's funding/affiliation, etc.) inside a sentence framed as coming from the source. Split the external fact out into its own Lane B sentence, or drop it.`,
    `- RETRACTED claims: any claim from the retracted-claims registry must be deleted, not rewritten.`,
    `- JUDGE OUTAGE: if the verifier judge is unreachable, every unresolved Lane A sentence becomes LANE_A_UNVERIFIABLE = HARD FAIL by default.`,
    `- Never fabricate a URL. When you cannot produce a real one, downgrade the claim with a verbal hedge ("publicly reported", "industry reporting indicates") and attach NO URL.`,
  ].join("\n");
}
