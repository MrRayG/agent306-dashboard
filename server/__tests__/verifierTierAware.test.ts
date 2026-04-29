/**
 * PR #251 — tier-aware verifier severity smoke test.
 *
 * Verifies that the verifier honors the new ContentTier knob:
 *   - News/signal/academy/dispatch/reply/reflection/podcast/cyoa
 *     SOFT_WARN on Lane B bare instead of HARD_FAIL.
 *   - Blog/article/research keep the legacy HARD_FAIL behavior.
 *   - Lane A failures still HARD_FAIL on every tier (regression guard).
 *   - Untagged callers (no tier) keep the legacy strict behavior.
 *
 * Run via: npx tsx server/__tests__/verifierTierAware.test.ts
 */

import { verifyClaims, STRICT_TIERS, type ContentTier } from "../claimVerifier.js";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else      { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// A draft with 5 Lane B bare numeric/percent claims — would HARD_FAIL legacy
// behavior (>= 3 bare or any sentence with >= 2 numeric markers).
const BARE_HEAVY_DRAFT = [
  "AI capex hit $200 billion in 2025.",
  "OpenAI reportedly burned 15% of its compute on training runs.",
  "Anthropic's revenue grew 4x year-over-year.",
  "Google's TPU fleet expanded 3x in 2024.",
  "Inference costs fell 80% over 18 months.",
].join(" ");

const SOURCE_TEXT = "Generic source about AI infrastructure trends — no overlapping numbers.";

(async () => {
  console.log("\n[Verifier tier-aware tests]\n");

  // Skip the LLM judge so the tests are deterministic offline.
  const baseOpts = {
    draftText:   BARE_HEAVY_DRAFT,
    sourceText:  SOURCE_TEXT,
    sourceUrl:   "",
    sourceTitle: "Test",
    skipLLM:     true,
  };

  // 1. Untagged → legacy strict → HARD_FAIL.
  const untagged = await verifyClaims({ ...baseOpts });
  check(
    "untagged caller keeps legacy strict behavior (HARD_FAIL)",
    untagged.severity === "HARD_FAIL",
    `got severity=${untagged.severity}`,
  );

  // 2. blog/article/research → strict → HARD_FAIL.
  for (const tier of ["blog", "article", "research"] as ContentTier[]) {
    const v = await verifyClaims({ ...baseOpts, tier });
    check(
      `tier="${tier}" stays strict (HARD_FAIL)`,
      v.severity === "HARD_FAIL",
      `got severity=${v.severity}`,
    );
    check(
      `tier="${tier}" is in STRICT_TIERS`,
      STRICT_TIERS.has(tier),
    );
  }

  // 3. news/signal/academy/dispatch/reply/reflection/podcast/cyoa → soft.
  const softTiers: ContentTier[] = [
    "news", "signal", "academy", "dispatch",
    "reply", "reflection", "podcast", "cyoa",
  ];
  for (const tier of softTiers) {
    const v = await verifyClaims({ ...baseOpts, tier });
    check(
      `tier="${tier}" soft-warns instead of hard-fail`,
      v.severity === "SOFT_WARN",
      `got severity=${v.severity}`,
    );
    check(
      `tier="${tier}" is NOT in STRICT_TIERS`,
      !STRICT_TIERS.has(tier),
    );
    // Sanity: the underlying bare-claim count should still be >= 1, otherwise
    // the test isn't actually exercising the soft-warn path.
    check(
      `tier="${tier}" still records bare-claim entries (Lane B detection unchanged)`,
      v.verifierReport.summary.laneBBare >= 1,
      `laneBBare=${v.verifierReport.summary.laneBBare}`,
    );
  }

  // 4. Lane A regression guard: a draft with attribution + invented quote
  // should HARD_FAIL even on a soft tier (only Lane B bare downgrades).
  // We construct a sentence that triggers LANE_A_FAIL: an attributed quote
  // not present in the source.
  const laneAFailDraft = `According to the report, the CEO said "we project 47% YoY growth in compute spend through 2027".`;
  const laneAFailSource = "The report discusses AI infrastructure but contains no quotes from the CEO.";

  const newsLaneA = await verifyClaims({
    draftText:   laneAFailDraft,
    sourceText:  laneAFailSource,
    sourceUrl:   "https://example.com/report",
    sourceTitle: "Test report",
    skipLLM:     true,
    tier:        "news",
  });
  check(
    "tier=\"news\" still HARD_FAILs on Lane A (attributed quote not in source)",
    newsLaneA.severity === "HARD_FAIL",
    `got severity=${newsLaneA.severity}, laneAFail=${newsLaneA.verifierReport.summary.laneAFail}`,
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
